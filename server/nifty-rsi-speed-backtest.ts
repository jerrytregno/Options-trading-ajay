import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { rsiAtBarIndex } from "../src/lib/rsi.js";
import type {
  NiftyRsiSpeedBandSummary,
  NiftyRsiSpeedOccurrence,
  NiftyRsiSpeedBacktestResult,
  RsiSpeedBandId,
  RsiSpeedBandRules,
} from "../src/types/nifty-rsi-speed-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { NIFTY_INDEX_PROFILE, type IndexProfile } from "./nine-fifteen-candles.js";
import {
  NIFTY_RSI_DEFAULT_DAYS,
  NIFTY_RSI_EXIT_DEADLINE_LABEL,
  NIFTY_RSI_EXIT_DEADLINE_MINS,
  NIFTY_RSI_PERIOD,
  NIFTY_RSI_TRIGGER_WINDOW_LABEL,
  NIFTY_RSI_WIN_TARGET_PTS,
  isInNiftyRsiTriggerWindow,
  type NiftyRsiMinuteBar,
} from "./nifty-rsi-backtest.js";

const IST = "Asia/Kolkata";
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const MIN_SESSION_MINUTE_BARS = 330;
const CHUNK_TRADING_DAYS = 40;
const CACHE_VERSION = 3;
const CACHE_MS = 12 * 60 * 60 * 1000;
export const NIFTY_RSI_SPEED_MIN_JUMP_PTS = 10;
export const NIFTY_RSI_SPEED_DEFAULT_DAYS = NIFTY_RSI_DEFAULT_DAYS;

export const RSI_SPEED_CE_BANDS: readonly RsiSpeedBandRules[] = [
  { id: "10_to_20", label: "10 → 20", direction: "up", tradeLeg: "CE_BUY", fromLevel: 10, toLevel: 20 },
  { id: "20_to_30", label: "20 → 30", direction: "up", tradeLeg: "CE_BUY", fromLevel: 20, toLevel: 30 },
  { id: "30_to_40", label: "30 → 40", direction: "up", tradeLeg: "CE_BUY", fromLevel: 30, toLevel: 40 },
  { id: "40_to_50", label: "40 → 50", direction: "up", tradeLeg: "CE_BUY", fromLevel: 40, toLevel: 50 },
  { id: "10_to_40", label: "10 → 40", direction: "up", tradeLeg: "CE_BUY", fromLevel: 10, toLevel: 40 },
  { id: "20_to_40", label: "20 → 40", direction: "up", tradeLeg: "CE_BUY", fromLevel: 20, toLevel: 40 },
] as const;

export const RSI_SPEED_PE_BANDS: readonly RsiSpeedBandRules[] = [
  { id: "90_to_80", label: "90 → 80", direction: "down", tradeLeg: "PE_BUY", fromLevel: 90, toLevel: 80 },
  { id: "80_to_70", label: "80 → 70", direction: "down", tradeLeg: "PE_BUY", fromLevel: 80, toLevel: 70 },
  { id: "70_to_60", label: "70 → 60", direction: "down", tradeLeg: "PE_BUY", fromLevel: 70, toLevel: 60 },
  { id: "60_to_50", label: "60 → 50", direction: "down", tradeLeg: "PE_BUY", fromLevel: 60, toLevel: 50 },
  { id: "90_to_60", label: "90 → 60", direction: "down", tradeLeg: "PE_BUY", fromLevel: 90, toLevel: 60 },
  { id: "80_to_60", label: "80 → 60", direction: "down", tradeLeg: "PE_BUY", fromLevel: 80, toLevel: 60 },
] as const;

export const RSI_SPEED_BANDS: readonly RsiSpeedBandRules[] = [...RSI_SPEED_CE_BANDS, ...RSI_SPEED_PE_BANDS];

/** Minimum one-minute RSI move for a band (full span). */
export function requiredRsiJumpForBand(band: RsiSpeedBandRules): number {
  return Math.abs(band.toLevel - band.fromLevel);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "nifty-rsi-speed-backtest.json.gz");
const META_FILE = path.join(DATA_DIR, "nifty-rsi-speed-backtest.meta.json");

type MinuteMap = Map<string, NiftyRsiMinuteBar[]>;

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

export type NiftyRsiSpeedMeasure = {
  maxFavorablePts: number;
  win: boolean;
  minutesToWin: number | null;
  winExitTimeIst: string | null;
  sessionClosePrice: number;
  closeMovePts: number;
};

/** CE: win when high touches entry + target. PE: win when low touches entry − target. */
export function measureNiftyRsiSpeedOutcomeAfterTrigger(
  candles: NiftyRsiMinuteBar[],
  triggerIndex: number,
  triggerPrice: number,
  band: RsiSpeedBandRules,
  winTargetPts = NIFTY_RSI_WIN_TARGET_PTS,
): NiftyRsiSpeedMeasure {
  const sessionClosePrice = candles[candles.length - 1]?.close ?? triggerPrice;
  let maxFavorablePts = 0;
  let win = false;
  let minutesToWin: number | null = null;
  let winExitTimeIst: string | null = null;
  const triggerMins = candles[triggerIndex]?.mins ?? 0;
  const isCe = band.direction === "up";

  for (let j = triggerIndex + 1; j < candles.length; j += 1) {
    const bar = candles[j]!;
    const favorable = isCe ? bar.high - triggerPrice : triggerPrice - bar.low;
    if (favorable > maxFavorablePts) maxFavorablePts = favorable;

    const elapsed = bar.mins - triggerMins;
    const beforeExitDeadline = bar.mins < NIFTY_RSI_EXIT_DEADLINE_MINS;
    const targetHit = isCe
      ? bar.high >= triggerPrice + winTargetPts - 1e-9
      : bar.low <= triggerPrice - winTargetPts + 1e-9;
    if (!win && beforeExitDeadline && targetHit) {
      win = true;
      minutesToWin = elapsed;
      winExitTimeIst = istTimeLabel(bar.time);
    }
  }

  return {
    maxFavorablePts: round2(maxFavorablePts),
    win,
    minutesToWin,
    winExitTimeIst,
    sessionClosePrice: round2(sessionClosePrice),
    closeMovePts: round2(sessionClosePrice - triggerPrice),
  };
}

/** @deprecated use measureNiftyRsiSpeedOutcomeAfterTrigger */
export function measureNiftyRsiSpeedRunupAfterTrigger(
  candles: NiftyRsiMinuteBar[],
  triggerIndex: number,
  triggerPrice: number,
  winTargetPts = NIFTY_RSI_WIN_TARGET_PTS,
): NiftyRsiSpeedMeasure {
  return measureNiftyRsiSpeedOutcomeAfterTrigger(
    candles,
    triggerIndex,
    triggerPrice,
    RSI_SPEED_CE_BANDS[0]!,
    winTargetPts,
  );
}

/** RSI moved the full band span in one minute (up for CE, down for PE). */
export function rsiSpeedBandTriggered(
  prevRsi: number | null,
  rsi: number | null,
  band: RsiSpeedBandRules,
): boolean {
  if (prevRsi == null || rsi == null) return false;
  const span = requiredRsiJumpForBand(band);

  if (band.direction === "up") {
    if (rsi + 1e-9 < band.toLevel) return false;
    if (prevRsi + 1e-9 >= band.toLevel) return false;
    if (prevRsi + 1e-9 < band.fromLevel) return false;
    return rsi - prevRsi + 1e-9 >= span;
  }

  if (rsi - 1e-9 > band.toLevel) return false;
  if (prevRsi - 1e-9 <= band.toLevel) return false;
  if (prevRsi - 1e-9 > band.fromLevel) return false;
  return prevRsi - rsi + 1e-9 >= span;
}

/** First trigger per band between 9:20 and 15:00 → CE or PE at that minute's Nifty close. */
export function analyzeNiftyRsiSpeedDay(
  date: string,
  candles: NiftyRsiMinuteBar[],
): NiftyRsiSpeedOccurrence[] {
  const sorted = [...candles].sort((a, b) => a.mins - b.mins);
  if (sorted.length <= NIFTY_RSI_PERIOD) return [];

  const closes = sorted.map((c) => c.close);
  const weekday = weekdayFromDateKey(date);
  const seen = new Set<RsiSpeedBandId>();
  const rows: NiftyRsiSpeedOccurrence[] = [];

  for (let i = NIFTY_RSI_PERIOD; i < sorted.length; i += 1) {
    const bar = sorted[i]!;
    if (!isInNiftyRsiTriggerWindow(bar.mins)) continue;

    const rsi = rsiAtBarIndex(closes, i, NIFTY_RSI_PERIOD);
    if (rsi == null) continue;
    const prevRsi = rsiAtBarIndex(closes, i - 1, NIFTY_RSI_PERIOD);

    for (const band of RSI_SPEED_BANDS) {
      if (seen.has(band.id)) continue;
      if (!rsiSpeedBandTriggered(prevRsi, rsi, band)) continue;

      const triggerPrice = bar.close;
      const outcome = measureNiftyRsiSpeedOutcomeAfterTrigger(sorted, i, triggerPrice, band);
      const rsiDelta = rsi - (prevRsi ?? rsi);
      seen.add(band.id);
      rows.push({
        date,
        weekday,
        bandId: band.id,
        bandLabel: band.label,
        tradeLeg: band.tradeLeg,
        direction: band.direction,
        timeIst: istTimeLabel(bar.time),
        triggerPrice: round2(triggerPrice),
        prevRsi: round2(prevRsi ?? 0),
        triggerRsi: round2(rsi),
        rsiDelta: round2(rsiDelta),
        ...outcome,
      });
    }
  }

  return rows;
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

export function buildNiftyRsiSpeedBandSummary(
  band: RsiSpeedBandRules,
  rows: NiftyRsiSpeedOccurrence[],
): NiftyRsiSpeedBandSummary {
  const filtered = rows.filter((r) => r.bandId === band.id);
  const wins = filtered.filter((r) => r.win).length;
  return {
    bandId: band.id,
    bandLabel: band.label,
    tradeLeg: band.tradeLeg,
    direction: band.direction,
    totalEntries: filtered.length,
    winCount: wins,
    lossCount: filtered.length - wins,
    winPct: filtered.length === 0 ? 0 : round2((wins / filtered.length) * 100),
    avgMinutesToWin: avgNullable(filtered.filter((r) => r.win).map((r) => r.minutesToWin)),
    avgMaxFavorablePts: avg(filtered.map((r) => r.maxFavorablePts)),
    avgRsiDelta: avg(filtered.map((r) => Math.abs(r.rsiDelta))),
  };
}

function buildFromMinuteMap(byDate: MinuteMap, days: number): NiftyRsiSpeedBacktestResult {
  const sortedDates = [...byDate.keys()].sort().slice(-days);
  const occurrences: NiftyRsiSpeedOccurrence[] = [];

  for (const date of sortedDates) {
    const candles = byDate.get(date);
    if (!candles) continue;
    candles.sort((a, b) => a.mins - b.mins);
    const sessionCandles = candles.filter(
      (c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES,
    );
    if (!isValidSessionDay(sessionCandles)) continue;
    occurrences.push(...analyzeNiftyRsiSpeedDay(date, sessionCandles));
  }

  occurrences.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    if (a.bandId !== b.bandId) return a.bandId.localeCompare(b.bandId);
    return a.timeIst.localeCompare(b.timeIst);
  });

  return {
    from: sortedDates[0] ?? "",
    to: sortedDates[sortedDates.length - 1] ?? "",
    daysRequested: days,
    builtAt: new Date().toISOString(),
    rules: {
      rsiPeriod: NIFTY_RSI_PERIOD,
      ceBands: [...RSI_SPEED_CE_BANDS],
      peBands: [...RSI_SPEED_PE_BANDS],
      minRsiJumpPts: NIFTY_RSI_SPEED_MIN_JUMP_PTS,
      triggerWindowIst: NIFTY_RSI_TRIGGER_WINDOW_LABEL,
      exitDeadlineIst: NIFTY_RSI_EXIT_DEADLINE_LABEL,
      winTargetPts: NIFTY_RSI_WIN_TARGET_PTS,
      lookbackTradingDays: days,
    },
    ceSummaries: RSI_SPEED_CE_BANDS.map((band) => buildNiftyRsiSpeedBandSummary(band, occurrences)),
    peSummaries: RSI_SPEED_PE_BANDS.map((band) => buildNiftyRsiSpeedBandSummary(band, occurrences)),
    occurrences,
    warnings: [],
  };
}

async function fetchAndBuild(
  accessToken: string,
  days: number,
  profile: IndexProfile,
): Promise<NiftyRsiSpeedBacktestResult> {
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

function writeCache(result: NiftyRsiSpeedBacktestResult): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, CACHE_FILE);
  const at = Date.now();
  fs.writeFileSync(META_FILE, JSON.stringify({ at, version: CACHE_VERSION }));
  return at;
}

function readCache(): NiftyRsiSpeedBacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE));
    const parsed = JSON.parse(raw.toString("utf8")) as { data?: NiftyRsiSpeedBacktestResult };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

let inflight: Promise<NiftyRsiSpeedBacktestResult> | null = null;

export async function ensureNiftyRsiSpeedBacktest(
  accessToken: string,
  daysRequested = NIFTY_RSI_SPEED_DEFAULT_DAYS,
  force = false,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
): Promise<{ data: NiftyRsiSpeedBacktestResult; cached: boolean; builtAt: number }> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NIFTY_RSI_SPEED_DEFAULT_DAYS);
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
