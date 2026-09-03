import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import type {
  NiftyOneHourBacktestResult,
  NiftyOneHourOccurrence,
  NiftyOneHourSummary,
  NiftyOneHourTriggerDirection,
} from "../src/types/nifty-one-hour-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { NIFTY_INDEX_PROFILE, type IndexProfile } from "./nine-fifteen-candles.js";

const IST = "Asia/Kolkata";
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const MIN_SESSION_MINUTE_BARS = 330;
const CHUNK_TRADING_DAYS = 40;
const CACHE_VERSION = 1;
const CACHE_MS = 12 * 60 * 60 * 1000;
export const NIFTY_ONE_HOUR_MOVE_THRESHOLD = 50;
/** ~3 months of NSE sessions. */
export const NIFTY_ONE_HOUR_DEFAULT_DAYS = 63;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "nifty-one-hour-backtest.json.gz");
const META_FILE = path.join(DATA_DIR, "nifty-one-hour-backtest.meta.json");

type MinuteBar = {
  mins: number;
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
};

type MinuteMap = Map<string, MinuteBar[]>;

type HourWindow = {
  triggerStart: number;
  triggerEnd: number;
  nextStart: number;
  nextEnd: number;
  triggerLabel: string;
  nextLabel: string;
};

const HOUR_WINDOWS: HourWindow[] = [
  {
    triggerStart: 10 * 60,
    triggerEnd: 10 * 60 + 59,
    nextStart: 11 * 60,
    nextEnd: 11 * 60 + 59,
    triggerLabel: "10:00–11:00",
    nextLabel: "11:00–12:00",
  },
  {
    triggerStart: 11 * 60,
    triggerEnd: 11 * 60 + 59,
    nextStart: 12 * 60,
    nextEnd: 12 * 60 + 59,
    triggerLabel: "11:00–12:00",
    nextLabel: "12:00–13:00",
  },
  {
    triggerStart: 12 * 60,
    triggerEnd: 12 * 60 + 59,
    nextStart: 13 * 60,
    nextEnd: 13 * 60 + 59,
    triggerLabel: "12:00–13:00",
    nextLabel: "13:00–14:00",
  },
];

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function istMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function weekdayFromDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "short",
  }).format(new Date(`${dateKey}T06:00:00.000Z`));
}

function isKiteMinuteCandleTuple(item: unknown): item is [string, number, number, number, number] {
  return Array.isArray(item) && item.length >= 5;
}

function isValidSessionDay(candles: MinuteBar[]): boolean {
  if (candles.length < MIN_SESSION_MINUTE_BARS) return false;
  return candles.some((c) => c.mins === SESSION_OPEN_MINUTES);
}

function listWeekdayDates(calendarDaysBack: number): string[] {
  const dates: string[] = [];
  const now = Date.now();
  for (let offset = calendarDaysBack; offset >= 0; offset -= 1) {
    const d = new Date(now - offset * 86_400_000);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short" }).format(d);
    if (weekday === "Sat" || weekday === "Sun") continue;
    dates.push(istDateKey(d));
  }
  return dates;
}

function chunkTradingDates(dates: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < dates.length; i += size) out.push(dates.slice(i, i + size));
  return out;
}

function ingestRawCandles(raw: unknown[], byDate: MinuteMap): void {
  for (const item of raw) {
    if (!isKiteMinuteCandleTuple(item)) continue;
    const [time, open, high, low, close] = item;
    const parsed = new Date(String(time));
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinutes(parsed);
    if (mins < SESSION_OPEN_MINUTES || mins > SESSION_CLOSE_MINUTES) continue;

    const dateKey = istDateKey(parsed);
    const bar: MinuteBar = { mins, time: parsed, open, high, low, close };
    const list = byDate.get(dateKey);
    if (list) list.push(bar);
    else byDate.set(dateKey, [bar]);
  }
}

function sliceWindowBars(candles: MinuteBar[], startMins: number, endMins: number): MinuteBar[] {
  return candles.filter((c) => c.mins >= startMins && c.mins <= endMins);
}

function hourMove(bars: MinuteBar[]): { open: number; close: number; movePts: number; movePct: number } | null {
  if (bars.length < 50) return null;
  bars.sort((a, b) => a.mins - b.mins);
  const open = bars[0].open;
  const close = bars[bars.length - 1].close;
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) return null;
  const movePts = close - open;
  const movePct = (movePts / open) * 100;
  return { open, close, movePts, movePct };
}

function buildSummary(occurrences: NiftyOneHourOccurrence[]): NiftyOneHourSummary {
  const up = occurrences.filter((o) => o.triggerDirection === "up");
  const down = occurrences.filter((o) => o.triggerDirection === "down");
  const avg = (rows: NiftyOneHourOccurrence[]) =>
    rows.length === 0 ? 0 : round2(rows.reduce((sum, row) => sum + row.nextMovePts, 0) / rows.length);

  const continuation = occurrences.filter((o) => {
    if (o.triggerDirection === "up") return o.nextMovePts > 0;
    return o.nextMovePts < 0;
  }).length;

  return {
    totalOccurrences: occurrences.length,
    upTriggers: up.length,
    downTriggers: down.length,
    avgNextMoveAfterUp: avg(up),
    avgNextMoveAfterDown: avg(down),
    continuationPct:
      occurrences.length === 0 ? 0 : round2((continuation / occurrences.length) * 100),
  };
}

function analyzeDay(date: string, candles: MinuteBar[]): NiftyOneHourOccurrence[] {
  const out: NiftyOneHourOccurrence[] = [];
  const weekday = weekdayFromDateKey(date);

  for (const window of HOUR_WINDOWS) {
    const triggerBars = sliceWindowBars(candles, window.triggerStart, window.triggerEnd);
    const trigger = hourMove(triggerBars);
    if (!trigger) continue;

    let direction: NiftyOneHourTriggerDirection | null = null;
    if (trigger.movePts > NIFTY_ONE_HOUR_MOVE_THRESHOLD) direction = "up";
    else if (trigger.movePts < -NIFTY_ONE_HOUR_MOVE_THRESHOLD) direction = "down";
    if (!direction) continue;

    const nextBars = sliceWindowBars(candles, window.nextStart, window.nextEnd);
    const next = hourMove(nextBars);
    if (!next) continue;

    out.push({
      date,
      weekday,
      triggerHourLabel: window.triggerLabel,
      triggerDirection: direction,
      triggerMovePts: round2(trigger.movePts),
      triggerMovePct: round2(trigger.movePct),
      triggerStartPrice: round2(trigger.open),
      triggerEndPrice: round2(trigger.close),
      nextHourLabel: window.nextLabel,
      nextMovePts: round2(next.movePts),
      nextMovePct: round2(next.movePct),
      nextStartPrice: round2(next.open),
      nextEndPrice: round2(next.close),
    });
  }

  return out;
}

function buildFromMinuteMap(byDate: MinuteMap, days: number): NiftyOneHourBacktestResult {
  const sortedDates = [...byDate.keys()].sort().slice(-days);
  const occurrences: NiftyOneHourOccurrence[] = [];
  const warnings: string[] = [];

  for (const date of sortedDates) {
    const candles = byDate.get(date);
    if (!candles) continue;
    candles.sort((a, b) => a.mins - b.mins);
    const sessionCandles = candles.filter(
      (c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES,
    );
    if (!isValidSessionDay(sessionCandles)) continue;
    occurrences.push(...analyzeDay(date, sessionCandles));
  }

  occurrences.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    return a.triggerHourLabel.localeCompare(b.triggerHourLabel);
  });

  return {
    from: sortedDates[0] ?? "",
    to: sortedDates[sortedDates.length - 1] ?? "",
    daysRequested: days,
    builtAt: new Date().toISOString(),
    rules: {
      moveThresholdPts: NIFTY_ONE_HOUR_MOVE_THRESHOLD,
      triggerWindows: HOUR_WINDOWS.map((w) => w.triggerLabel),
      lookbackTradingDays: days,
    },
    summary: buildSummary(occurrences),
    occurrences,
    warnings,
  };
}

async function fetchAndBuild(
  accessToken: string,
  days: number,
  profile: IndexProfile,
): Promise<NiftyOneHourBacktestResult> {
  const calendarLookback = Math.ceil(days * 7 / 5) + 14;
  const tradingDates = listWeekdayDates(calendarLookback);
  const chunks = chunkTradingDates(tradingDates, CHUNK_TRADING_DAYS);
  const byDate: MinuteMap = new Map();
  let rawCount = 0;

  for (const chunk of chunks) {
    const from = `${chunk[0]} 09:15:00`;
    const to = `${chunk[chunk.length - 1]} 15:30:00`;
    const { candles } = await fetchHistoricalCandles(accessToken, profile.spotKey, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error("Invalid candle response from Kite");
    rawCount += candles.length;
    ingestRawCandles(candles, byDate);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  if (rawCount === 0) throw new Error("No historical candles returned from Kite");

  const result = buildFromMinuteMap(byDate, days);
  if (result.from === "" || result.to === "") {
    throw new Error("No complete NSE session days in Kite data");
  }
  return result;
}

function readMeta(): { at: number; version?: number } | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    return JSON.parse(fs.readFileSync(META_FILE, "utf8")) as { at: number; version?: number };
  } catch {
    return null;
  }
}

function writeCache(result: NiftyOneHourBacktestResult): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, CACHE_FILE);
  const at = Date.now();
  fs.writeFileSync(META_FILE, JSON.stringify({ at, version: CACHE_VERSION }));
  return at;
}

function readCache(): NiftyOneHourBacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE));
    const parsed = JSON.parse(raw.toString("utf8")) as { data?: NiftyOneHourBacktestResult };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

let inflight: Promise<NiftyOneHourBacktestResult> | null = null;

export async function ensureNiftyOneHourBacktest(
  accessToken: string,
  daysRequested = NIFTY_ONE_HOUR_DEFAULT_DAYS,
  force = false,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
): Promise<{ data: NiftyOneHourBacktestResult; cached: boolean; builtAt: number }> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NIFTY_ONE_HOUR_DEFAULT_DAYS);
  const meta = force ? null : readMeta();

  if (meta && meta.version === CACHE_VERSION && Date.now() - meta.at < CACHE_MS && !force) {
    const cached = readCache();
    if (cached && cached.daysRequested === days) {
      return { data: cached, cached: true, builtAt: meta.at };
    }
  }

  if (!inflight) {
    inflight = fetchAndBuild(accessToken, days, profile)
      .then((result) => {
        writeCache(result);
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const stale = readCache();
  if (stale && stale.daysRequested === days && meta && !force) {
    inflight.catch(() => undefined);
    return { data: stale, cached: true, builtAt: meta.at };
  }

  const data = await inflight;
  return { data, cached: false, builtAt: Date.now() };
}
