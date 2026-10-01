import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { rsiAtBarIndex } from "../src/lib/rsi.js";
import { NSE_SESSIONS_ONE_YEAR } from "../src/types/nine-fifteen.js";
import type {
  NiftyRsiBacktestResult,
  NiftyRsiOccurrence,
  NiftyRsiThreshold,
  NiftyRsiThresholdSummary,
} from "../src/types/nifty-rsi-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { NIFTY_INDEX_PROFILE, type IndexProfile } from "./nine-fifteen-candles.js";

const IST = "Asia/Kolkata";
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const MIN_SESSION_MINUTE_BARS = 330;
const CHUNK_TRADING_DAYS = 40;
const CACHE_VERSION = 6;
/** Only count RSI crosses between 9:20 and 15:00 IST (inclusive). */
export const NIFTY_RSI_TRIGGER_START_MINS = 9 * 60 + 20;
export const NIFTY_RSI_TRIGGER_END_MINS = 15 * 60;
export const NIFTY_RSI_TRIGGER_WINDOW_LABEL = "9:20–15:00";
/** Short must complete strictly before this minute (15:00 bar does not count). */
export const NIFTY_RSI_EXIT_DEADLINE_MINS = 15 * 60;
export const NIFTY_RSI_EXIT_DEADLINE_LABEL = "15:00";
export const NIFTY_RSI_WIN_TARGET_PTS = 10;
const CACHE_MS = 12 * 60 * 60 * 1000;

export const NIFTY_RSI_PERIOD = 14;
/** Entry when RSI(14) first reaches 95 from below (PE buy on Nifty −10 pt target). */
export const NIFTY_RSI_ENTRY_LEVEL = 95;
export const NIFTY_RSI_THRESHOLDS: NiftyRsiThreshold[] = [95];
export const NIFTY_RSI_DRAWDOWN_LEVELS_PTS = [10, 20, 30] as const;
/** ~1 year of NSE sessions. */
export const NIFTY_RSI_DEFAULT_DAYS = NSE_SESSIONS_ONE_YEAR;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "nifty-rsi-backtest.json.gz");
const META_FILE = path.join(DATA_DIR, "nifty-rsi-backtest.meta.json");

export type NiftyRsiMinuteBar = {
  mins: number;
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
};

type MinuteMap = Map<string, NiftyRsiMinuteBar[]>;

export type NiftyRsiDrawdownMeasure = {
  maxDrawdownPts: number;
  hit10Pts: boolean;
  hit20Pts: boolean;
  hit30Pts: boolean;
  minutesTo10Pts: number | null;
  minutesTo20Pts: number | null;
  minutesTo30Pts: number | null;
  /** −10 pts touched before {@link NIFTY_RSI_EXIT_DEADLINE_MINS} IST. */
  win: boolean;
  minutesToWin: number | null;
  winExitTimeIst: string | null;
  sessionClosePrice: number;
  closeMovePts: number;
};

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

function istTimeLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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

function isValidSessionDay(candles: NiftyRsiMinuteBar[]): boolean {
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
    const bar: NiftyRsiMinuteBar = { mins, time: parsed, open, high, low, close };
    const list = byDate.get(dateKey);
    if (list) list.push(bar);
    else byDate.set(dateKey, [bar]);
  }
}

/** Measure how far Nifty falls from a trigger price through session close. */
export function measureNiftyRsiDrawdownAfterTrigger(
  candles: NiftyRsiMinuteBar[],
  triggerIndex: number,
  triggerPrice: number,
): NiftyRsiDrawdownMeasure {
  const sessionClosePrice = candles[candles.length - 1]?.close ?? triggerPrice;
  let maxDrawdownPts = 0;
  let hit10Pts = false;
  let hit20Pts = false;
  let hit30Pts = false;
  let minutesTo10Pts: number | null = null;
  let minutesTo20Pts: number | null = null;
  let minutesTo30Pts: number | null = null;
  let win = false;
  let minutesToWin: number | null = null;
  let winExitTimeIst: string | null = null;
  const triggerMins = candles[triggerIndex]?.mins ?? 0;

  for (let j = triggerIndex + 1; j < candles.length; j += 1) {
    const bar = candles[j]!;
    const drawdown = triggerPrice - bar.low;
    if (drawdown > maxDrawdownPts) maxDrawdownPts = drawdown;

    const elapsed = bar.mins - triggerMins;
    const beforeExitDeadline = bar.mins < NIFTY_RSI_EXIT_DEADLINE_MINS;

    if (!hit10Pts && beforeExitDeadline && bar.low <= triggerPrice - NIFTY_RSI_WIN_TARGET_PTS) {
      hit10Pts = true;
      minutesTo10Pts = elapsed;
      win = true;
      minutesToWin = elapsed;
      winExitTimeIst = istTimeLabel(bar.time);
    }
    if (!hit20Pts && bar.low <= triggerPrice - 20) {
      hit20Pts = true;
      minutesTo20Pts = elapsed;
    }
    if (!hit30Pts && bar.low <= triggerPrice - 30) {
      hit30Pts = true;
      minutesTo30Pts = elapsed;
    }
  }

  return {
    maxDrawdownPts: round2(maxDrawdownPts),
    hit10Pts,
    hit20Pts,
    hit30Pts,
    minutesTo10Pts,
    minutesTo20Pts,
    minutesTo30Pts,
    win,
    minutesToWin,
    winExitTimeIst,
    sessionClosePrice: round2(sessionClosePrice),
    closeMovePts: round2(sessionClosePrice - triggerPrice),
  };
}

export function isInNiftyRsiTriggerWindow(mins: number): boolean {
  return mins >= NIFTY_RSI_TRIGGER_START_MINS && mins <= NIFTY_RSI_TRIGGER_END_MINS;
}

/** True on the first bar where Wilder RSI crosses from below the entry level into it or above. */
export function rsiCrossesIntoEntryLevel(prevRsi: number | null, rsi: number | null): boolean {
  if (rsi == null || rsi + 1e-9 < NIFTY_RSI_ENTRY_LEVEL) return false;
  if (prevRsi == null) return true;
  return prevRsi + 1e-9 < NIFTY_RSI_ENTRY_LEVEL;
}

/** @deprecated use rsiCrossesIntoEntryLevel */
export function rsiCrossesIntoNinety(prevRsi: number | null, rsi: number | null): boolean {
  return rsiCrossesIntoEntryLevel(prevRsi, rsi);
}

/**
 * First RSI reach of 95 in the 9:20–15:00 window → model a PE buy at that minute's Nifty close.
 * Win = session low touches Nifty −10 pts before 15:00 IST (1-min OHLC).
 */
export function analyzeNiftyRsiDay(date: string, candles: NiftyRsiMinuteBar[]): NiftyRsiOccurrence[] {
  const sorted = [...candles].sort((a, b) => a.mins - b.mins);
  if (sorted.length <= NIFTY_RSI_PERIOD) return [];

  const closes = sorted.map((c) => c.close);
  const weekday = weekdayFromDateKey(date);

  for (let i = NIFTY_RSI_PERIOD; i < sorted.length; i += 1) {
    const bar = sorted[i]!;
    if (!isInNiftyRsiTriggerWindow(bar.mins)) continue;

    const rsi = rsiAtBarIndex(closes, i, NIFTY_RSI_PERIOD);
    if (rsi == null) continue;
    const prevRsi = rsiAtBarIndex(closes, i - 1, NIFTY_RSI_PERIOD);
    if (!rsiCrossesIntoEntryLevel(prevRsi, rsi)) continue;

    const triggerPrice = bar.close;
    const drawdown = measureNiftyRsiDrawdownAfterTrigger(sorted, i, triggerPrice);

    return [
      {
        date,
        weekday,
        threshold: NIFTY_RSI_ENTRY_LEVEL,
        timeIst: istTimeLabel(bar.time),
        triggerPrice: round2(triggerPrice),
        triggerRsi: round2(rsi),
        ...drawdown,
      },
    ];
  }

  return [];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return round2(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function avgNullable(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return null;
  return avg(nums);
}

function pct(hit: number, total: number): number {
  if (total === 0) return 0;
  return round2((hit / total) * 100);
}

export function buildNiftyRsiThresholdSummary(
  threshold: NiftyRsiThreshold,
  rows: NiftyRsiOccurrence[],
): NiftyRsiThresholdSummary {
  const filtered = rows.filter((r) => r.threshold === threshold);
  return {
    threshold,
    totalTriggers: filtered.length,
    hit10Count: filtered.filter((r) => r.hit10Pts).length,
    hit10Pct: pct(filtered.filter((r) => r.hit10Pts).length, filtered.length),
    hit20Count: filtered.filter((r) => r.hit20Pts).length,
    hit20Pct: pct(filtered.filter((r) => r.hit20Pts).length, filtered.length),
    hit30Count: filtered.filter((r) => r.hit30Pts).length,
    hit30Pct: pct(filtered.filter((r) => r.hit30Pts).length, filtered.length),
    avgMaxDrawdownPts: avg(filtered.map((r) => r.maxDrawdownPts)),
    avgMinutesTo10Pts: avgNullable(filtered.map((r) => r.minutesTo10Pts)),
    avgMinutesTo20Pts: avgNullable(filtered.map((r) => r.minutesTo20Pts)),
    avgMinutesTo30Pts: avgNullable(filtered.map((r) => r.minutesTo30Pts)),
    avgCloseMovePts: avg(filtered.map((r) => r.closeMovePts)),
    winCount: filtered.filter((r) => r.win).length,
    lossCount: filtered.filter((r) => !r.win).length,
    winPct: pct(filtered.filter((r) => r.win).length, filtered.length),
    avgMinutesToWin: avgNullable(filtered.filter((r) => r.win).map((r) => r.minutesToWin)),
  };
}

function buildFromMinuteMap(byDate: MinuteMap, days: number): NiftyRsiBacktestResult {
  const sortedDates = [...byDate.keys()].sort().slice(-days);
  const occurrences: NiftyRsiOccurrence[] = [];
  const warnings: string[] = [];

  for (const date of sortedDates) {
    const candles = byDate.get(date);
    if (!candles) continue;
    candles.sort((a, b) => a.mins - b.mins);
    const sessionCandles = candles.filter(
      (c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES,
    );
    if (!isValidSessionDay(sessionCandles)) continue;
    occurrences.push(...analyzeNiftyRsiDay(date, sessionCandles));
  }

  occurrences.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    if (a.threshold !== b.threshold) return b.threshold - a.threshold;
    return a.timeIst.localeCompare(b.timeIst);
  });

  return {
    from: sortedDates[0] ?? "",
    to: sortedDates[sortedDates.length - 1] ?? "",
    daysRequested: days,
    builtAt: new Date().toISOString(),
    rules: {
      rsiPeriod: NIFTY_RSI_PERIOD,
      thresholds: [...NIFTY_RSI_THRESHOLDS],
      drawdownLevelsPts: [...NIFTY_RSI_DRAWDOWN_LEVELS_PTS],
      lookbackTradingDays: days,
      triggerMode: "rsi_reaches_95",
      triggerWindowIst: NIFTY_RSI_TRIGGER_WINDOW_LABEL,
      exitDeadlineIst: NIFTY_RSI_EXIT_DEADLINE_LABEL,
      winTargetPts: NIFTY_RSI_WIN_TARGET_PTS,
      entryRsiLevel: NIFTY_RSI_ENTRY_LEVEL,
      tradeLeg: "PE_BUY",
    },
    summaries: NIFTY_RSI_THRESHOLDS.map((threshold) =>
      buildNiftyRsiThresholdSummary(threshold, occurrences),
    ),
    occurrences,
    warnings,
  };
}

async function fetchAndBuild(
  accessToken: string,
  days: number,
  profile: IndexProfile,
): Promise<NiftyRsiBacktestResult> {
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

function writeCache(result: NiftyRsiBacktestResult): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, CACHE_FILE);
  const at = Date.now();
  fs.writeFileSync(META_FILE, JSON.stringify({ at, version: CACHE_VERSION }));
  return at;
}

function readCache(): NiftyRsiBacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE));
    const parsed = JSON.parse(raw.toString("utf8")) as { data?: NiftyRsiBacktestResult };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

let inflight: Promise<NiftyRsiBacktestResult> | null = null;

export async function ensureNiftyRsiBacktest(
  accessToken: string,
  daysRequested = NIFTY_RSI_DEFAULT_DAYS,
  force = false,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
): Promise<{ data: NiftyRsiBacktestResult; cached: boolean; builtAt: number }> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NIFTY_RSI_DEFAULT_DAYS);
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
