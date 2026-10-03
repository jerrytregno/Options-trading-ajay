import fs from "fs";
import path from "path";
import zlib from "zlib";
import { spawnBacktestBuild } from "./backtest-build-runner.js";
import type {
  NineFifteenBreakoutStats,
  NineFifteenBreakoutTargetApproach,
  NineFifteenBreakoutTrade,
  NineFifteenCandleRow,
  NineFifteenCandlesResult,
  NineFifteenCePeFailureTrade,
  NineFifteenCePeGuide,
  NineFifteenCePeStrategyStats,
  NineFifteenCePeTarget,
  NineFifteenCheckpointLevels,
  NineFifteenDirection,
  NineFifteenFollowFilterStats,
  NineFifteenFollowBacktestBlock,
  NineFifteenLevelSummary,
  NineFifteenMfePeak,
  NineFifteenNrmlCarryOutcome,
  NineFifteenOptionSide,
  NineFifteenRupeLevel,
  NineFifteenTimeCheckpoint,
  NineFifteenTargetHit,
  NineFifteenTargetGapAtCheckpoint,
  NineFifteenTradeEntry,
  NineFifteenTuesdayTargetRow,
  NineFifteenTuesdayTargetStats,
  NineFifteenSmallBodySplitBuckets,
  NineFifteenSmallBodySplitBucketStats,
} from "../src/types/nine-fifteen.js";
import {
  NINE_FIFTEEN_CEPE_TARGETS,
  NINE_FIFTEEN_RUPEE_LEVELS,
  NINE_FIFTEEN_TIME_CHECKPOINTS,
  NSE_SESSIONS_ONE_YEAR,
  NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
  NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
  SMALL_BODY_CE_MIN_INCLUSIVE,
  SMALL_BODY_MAX_EXCLUSIVE,
  SMALL_BODY_PUT_MAX_INCLUSIVE,
} from "../src/types/nine-fifteen.js";
import { rsiAtBarIndex } from "../src/lib/rsi.js";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";
import {
  NINE_SIXTEEN_INDEX_TARGET_15,
  NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE,
  NINE_SIXTEEN_INDEX_TARGET_20,
  NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE,
  NINE_SIXTEEN_BACKTEST_ENTRY_SEC,
  NINE_SIXTEEN_MIN_915_ABS_DIFF,
  NINE_SIXTEEN_HYBRID_INDEX_TARGET_RED_CONFIRM,
  NINE_SIXTEEN_HYBRID_INDEX_TARGET_GREEN_GAP,
} from "./nine-sixteen-logic.js";

/** Backtest entry: Kite 9:16 candle open (real 1-min data). */
const BACKTEST_ENTRY_SEC_OF_DAY = NINE_SIXTEEN_BACKTEST_ENTRY_SEC;

export interface IndexProfile {
  id: "nifty";
  /** Human label for UI/payload, e.g. "Nifty 50". */
  label: string;
  /** Kite `EXCHANGE:TRADINGSYMBOL`. */
  spotKey: string;
  pointScale: number;
  /** Weekly options expiry weekday — early square-off and flat expiry target land here. */
  expiryWeekday: string;
  /** Cache filename under `data/`. */
  cacheFileName: string;
}

export const NIFTY_INDEX_PROFILE: IndexProfile = {
  id: "nifty",
  label: "Nifty 50",
  spotKey: "NSE:NIFTY 50",
  pointScale: 1,
  expiryWeekday: "Tuesday",
  cacheFileName: "nine-fifteen-cache.json",
};

interface Confirm918Bands {
  mainMinAbsDiff: number;
  nearMissMinAbsDiff: number;
  nearMissMaxAbsDiff: number;
}

const IST = "Asia/Kolkata";
/** Smaller chunks — full-session minute data is much larger per request. */
const CHUNK_TRADING_DAYS = 25;
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
/** First session minute after 9:15 bar (entry candle for backtest). */
const SESSION_ENTRY_MINUTES = 9 * 60 + 16;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
/**
 * First minute included in ±target exit scan (9:16 → 15:30).
 * Includes the entry bar's OHLC so a touch during 9:16 counts (aligns with live ~9:16:00 fill).
 */
const BACKTEST_EXIT_START_MINUTES = SESSION_ENTRY_MINUTES;
/** NRML carry-forward exit scan ends at this IST minute on expiry Tuesday (3:00 PM). */
const NRML_CARRY_DEADLINE_MINUTES = 15 * 60;
export const NINE_FIFTEEN_BACKTEST_TARGET = 30;
export const NINE_FIFTEEN_BACKTEST_TARGET_20 = 20;
export const NINE_FIFTEEN_BACKTEST_TARGET_25 = 25;
export const NINE_FIFTEEN_BACKTEST_TARGET_10 = 10;
export const NINE_FIFTEEN_BACKTEST_TARGET_8 = 8;
export const NINE_FIFTEEN_BACKTEST_TARGET_5 = 5;
export const NINE_FIFTEEN_BACKTEST_TARGET_15 = 15;
export const NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF = 15;
/** Near-miss band: 11 ≤ |Δ| < 15 (live near-miss exits). */
export const NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF = 11;
export const NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF = 15;
/** Near-miss study: ±20 until 10:01 IST, then ±10. */
export const NINE_FIFTEEN_NEAR_MISS_TARGET = NINE_FIFTEEN_BACKTEST_TARGET_20;
export const NINE_FIFTEEN_NEAR_MISS_TARGET_AFTER = NINE_FIFTEEN_BACKTEST_TARGET_10;
/**
 * Tighter consolidated exits (main ±20→±50/3@10:01→±35/3@11:01, near-miss ±50/3→±20/3@10:01 at Nifty
 * scale — ×3 gives Sensex ±60/±50/±35 and ±50/±20).
 */
export const NINE_FIFTEEN_CONSOL_ALT_MAIN_T1 = NINE_FIFTEEN_BACKTEST_TARGET_20;
export const NINE_FIFTEEN_CONSOL_ALT_MAIN_T2 = 50 / 3;
export const NINE_FIFTEEN_CONSOL_ALT_MAIN_T3 = 35 / 3;
export const NINE_FIFTEEN_CONSOL_ALT_NEAR_T1 = 50 / 3;
export const NINE_FIFTEEN_CONSOL_ALT_NEAR_T2 = 20 / 3;
/** Flat consolidated exits — main / near-miss targets (Nifty baseline; ×3 → Sensex 50/40, 40/30, 30/20). */
export const NINE_FIFTEEN_CONSOL_FLAT_50 = 50 / 3;
export const NINE_FIFTEEN_CONSOL_FLAT_40 = 40 / 3;
export const NINE_FIFTEEN_CONSOL_FLAT_30 = 30 / 3;
export const NINE_FIFTEEN_CONSOL_FLAT_20 = 20 / 3;
/**
 * Two-candle confirmation study: the 9:15 bar must clear its band floor and the 9:16 bar must
 * travel at least this far the *same* way, with entry deferred to the 9:18 open. Nifty baseline;
 * ×3 gives the Sensex figures of ±22.5 (main) and ±11.5 (near-miss).
 */
export const NINE_FIFTEEN_CONFIRM918_MAIN_MOVE = 22.5 / 3;
export const NINE_FIFTEEN_CONFIRM918_NEAR_MOVE = 11.5 / 3;
/**
 * Sensex study — same 9:16 entry/bands as tighter consolidated, but main exits are
 * ±60 until 10:01 · ±40 from 10:02 until 12:01 · ±30 from 12:02, near-miss ±40→±20@10:02,
 * plus a ±100 adverse hard stop from 12:01. Nifty baselines below; ×3 on Sensex.
 */
export const NINE_FIFTEEN_CONSOL_CUSTOM_MAIN_T1 = 20;
export const NINE_FIFTEEN_CONSOL_CUSTOM_MAIN_T2 = 40 / 3;
export const NINE_FIFTEEN_CONSOL_CUSTOM_MAIN_T3 = 10;
export const NINE_FIFTEEN_CONSOL_CUSTOM_NEAR_T1 = 40 / 3;
export const NINE_FIFTEEN_CONSOL_CUSTOM_NEAR_T2 = 20 / 3;
export const NINE_FIFTEEN_CONSOL_CUSTOM_HARD_STOP = 100 / 3;
/** Tier switches at 10:02 and 12:02 IST (minute-of-day). */
export const NINE_FIFTEEN_CONSOL_CUSTOM_SWITCH_1002 = 10 * 60 + 2;
export const NINE_FIFTEEN_CONSOL_CUSTOM_SWITCH_1202 = 12 * 60 + 2;
export const NINE_FIFTEEN_CONSOL_CUSTOM_HARD_STOP_START = 12 * 60 + 1;
/** Entry minute for the two-candle confirmation study — 9:17:00 open. */
const CONFIRM918_ENTRY_MINUTES = 9 * 60 + 17;
/**
 * Nifty-only two-candle confirmation at 9:17: 9:15 |Δ| > 30 · 9:16 |Δ| > 10 · exits
 * ±15 until 10:01 · ±10 from 10:02–11:01 · ±5 from 11:02 (absolute Nifty points).
 */
export const NIFTY_CONFIRM917_MAIN915 = 30;
export const NIFTY_CONFIRM917_MAIN915_ALT = 11;
export const NIFTY_CONFIRM917_MAIN916 = 10;
export const NIFTY_CONFIRM917_EXIT_T1 = 15;
export const NIFTY_CONFIRM917_EXIT_T2 = 10;
export const NIFTY_CONFIRM917_EXIT_T3 = 5;
export const NIFTY_CONFIRM917_SWITCH_1002 = 10 * 60 + 2;
export const NIFTY_CONFIRM917_SWITCH_1102 = 11 * 60 + 2;
/** Switch minute-of-day IST (10:01) — bars from this minute use the tighter target. */
export const NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE = 10 * 60 + 1;
/** Primary backtest follow exit (entry ± N from 9:16 Kite bars incl. entry minute). */
export const NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET = NINE_FIFTEEN_BACKTEST_TARGET_25;
/** Live floor: enter when |Δ| ≥ 11 (main ≥15 + near-miss band). */
export const NINE_FIFTEEN_LIVE_MIN_ABS_DIFF = NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF;
/**
 * Breakout backtest stop-loss — fixed from the 9:16 price, never tightened.
 * Backtest study only; the live 9:16 bot has no stop-loss.
 */
export const NINE_FIFTEEN_BREAKOUT_STOP_MAIN = 70;
export const NINE_FIFTEEN_BREAKOUT_STOP_NEAR_MISS = 70;
/** Breakout stops are checked from this IST minute onward on Mon/Wed–Fri. */
export const NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE = 12 * 60 + 1;
/** Tuesday only — stop checked from 11:01 IST. */
export const NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_TUESDAY_MINUTE = 11 * 60 + 1;
/** Tuesday breakout backtest: flat ±10 from 9:16 entry (both main and near-miss). */
export const NINE_FIFTEEN_BREAKOUT_TUESDAY_TARGET = NINE_FIFTEEN_BACKTEST_TARGET_10;


/**
 * Every scalable threshold in the engine, resolved once per index. Threaded explicitly rather
 * than parked in module state so two indices rebuilding around the same `await` can never read
 * each other's numbers.
 */
interface IndexPoints {
  /** `profile.pointScale` — multiplies any raw Nifty-baseline level. */
  scale: number;
  backtestTarget25: number;
  backtestTarget20: number;
  backtestTarget15: number;
  backtestTarget10: number;
  backtestTarget8: number;
  backtestTarget5: number;
  followMinAbsDiff: number;
  nearMissMinAbsDiff: number;
  nearMissMaxAbsDiff: number;
  nearMissTarget: number;
  nearMissTargetAfter: number;
  followBacktestTarget: number;
  liveMinAbsDiff: number;
  breakoutStopMain: number;
  breakoutStopNearMiss: number;
  /** Flat target on the index's own weekly expiry day. */
  breakoutExpiryDayTarget: number;
  indexTarget20: number;
  indexTarget15: number;
  consolidatedAltMain1: number;
  consolidatedAltMain2: number;
  consolidatedAltMain3: number;
  consolidatedAltNear1: number;
  consolidatedAltNear2: number;
  consolidatedFlat50: number;
  consolidatedFlat40: number;
  consolidatedFlat30: number;
  consolidatedFlat20: number;
  /** 9:16 confirmation-bar minimums for the 9:18-entry study. */
  confirm918MainMove: number;
  confirm918NearMove: number;
  consolCustomMain1: number;
  consolCustomMain2: number;
  consolCustomMain3: number;
  consolCustomNear1: number;
  consolCustomNear2: number;
  consolCustomHardStop: number;
}

function buildIndexPoints(profile: IndexProfile): IndexPoints {
  const scale = profile.pointScale;
  const at = (points: number) => points * scale;
  return {
    scale,
    backtestTarget25: at(NINE_FIFTEEN_BACKTEST_TARGET_25),
    backtestTarget20: at(NINE_FIFTEEN_BACKTEST_TARGET_20),
    backtestTarget15: at(NINE_SIXTEEN_HYBRID_INDEX_TARGET_RED_CONFIRM),
    backtestTarget10: at(NINE_SIXTEEN_HYBRID_INDEX_TARGET_GREEN_GAP),
    backtestTarget8: at(NINE_FIFTEEN_BACKTEST_TARGET_8),
    backtestTarget5: at(NINE_FIFTEEN_BACKTEST_TARGET_5),
    followMinAbsDiff: at(NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF),
    nearMissMinAbsDiff: at(NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF),
    nearMissMaxAbsDiff: at(NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF),
    nearMissTarget: at(NINE_FIFTEEN_NEAR_MISS_TARGET),
    nearMissTargetAfter: at(NINE_FIFTEEN_NEAR_MISS_TARGET_AFTER),
    followBacktestTarget: at(NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET),
    liveMinAbsDiff: at(NINE_FIFTEEN_LIVE_MIN_ABS_DIFF),
    breakoutStopMain: at(NINE_FIFTEEN_BREAKOUT_STOP_MAIN),
    breakoutStopNearMiss: at(NINE_FIFTEEN_BREAKOUT_STOP_NEAR_MISS),
    breakoutExpiryDayTarget: at(NINE_FIFTEEN_BREAKOUT_TUESDAY_TARGET),
    indexTarget20: at(NINE_SIXTEEN_INDEX_TARGET_20),
    indexTarget15: at(NINE_SIXTEEN_INDEX_TARGET_15),
    consolidatedAltMain1: at(NINE_FIFTEEN_CONSOL_ALT_MAIN_T1),
    consolidatedAltMain2: at(NINE_FIFTEEN_CONSOL_ALT_MAIN_T2),
    consolidatedAltMain3: at(NINE_FIFTEEN_CONSOL_ALT_MAIN_T3),
    consolidatedAltNear1: at(NINE_FIFTEEN_CONSOL_ALT_NEAR_T1),
    consolidatedAltNear2: at(NINE_FIFTEEN_CONSOL_ALT_NEAR_T2),
    consolidatedFlat50: at(NINE_FIFTEEN_CONSOL_FLAT_50),
    consolidatedFlat40: at(NINE_FIFTEEN_CONSOL_FLAT_40),
    consolidatedFlat30: at(NINE_FIFTEEN_CONSOL_FLAT_30),
    consolidatedFlat20: at(NINE_FIFTEEN_CONSOL_FLAT_20),
    confirm918MainMove: at(NINE_FIFTEEN_CONFIRM918_MAIN_MOVE),
    confirm918NearMove: at(NINE_FIFTEEN_CONFIRM918_NEAR_MOVE),
    consolCustomMain1: at(NINE_FIFTEEN_CONSOL_CUSTOM_MAIN_T1),
    consolCustomMain2: at(NINE_FIFTEEN_CONSOL_CUSTOM_MAIN_T2),
    consolCustomMain3: at(NINE_FIFTEEN_CONSOL_CUSTOM_MAIN_T3),
    consolCustomNear1: at(NINE_FIFTEEN_CONSOL_CUSTOM_NEAR_T1),
    consolCustomNear2: at(NINE_FIFTEEN_CONSOL_CUSTOM_NEAR_T2),
    consolCustomHardStop: at(NINE_FIFTEEN_CONSOL_CUSTOM_HARD_STOP),
  };
}


function isExpiryWeekday(dateKey: string, profile: IndexProfile): boolean {
  return formatWeekdayFromDateKey(dateKey) === profile.expiryWeekday;
}

/** "Tuesday" → "Tue", the short form the description strings render. */
function expiryWeekdayShort(profile: IndexProfile): string {
  return profile.expiryWeekday.slice(0, 3);
}

function breakoutStopActiveFromMinsForDate(dateKey: string, profile: IndexProfile): number {
  return isExpiryWeekday(dateKey, profile)
    ? NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_TUESDAY_MINUTE
    : NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE;
}

type BreakoutStopConfig = {
  stopMainPoints: number;
  stopNearMissPoints: number;
  /** First IST minute-of-day when the adverse stop can trigger. */
  stopActiveFromMins: number;
};

function breakoutStopTight(points: IndexPoints): BreakoutStopConfig {
  return {
    stopMainPoints: points.breakoutStopMain,
    stopNearMissPoints: points.breakoutStopNearMiss,
    stopActiveFromMins: NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE,
  };
}

/** Follow backtest exits: entry ± N from Kite bars ≥9:16 (not 9:15-open rules). */
function isEntryBasedFollowTarget(targetPoints: number, points: IndexPoints): boolean {
  return (
    targetPoints === points.followBacktestTarget || targetPoints === points.nearMissTarget
  );
}
/** RSI lookback on consecutive 1-min closes ending at 9:15. */
const NINE_FIFTEEN_RSI_PERIOD = 14;
/** Default calendar days requested (~1y NSE sessions). */
export const NINE_FIFTEEN_DEFAULT_HISTORY_DAYS = 365;
/** Max NSE sessions the backtest page can slice (2 years). */
export const NINE_FIFTEEN_BACKTEST_MAX_SESSIONS = NSE_SESSIONS_ONE_YEAR * 2;
/** Calendar lookback ceiling — wide enough for 2y of weekday sessions + holiday buffer. */
export const NINE_FIFTEEN_MAX_HISTORY_DAYS =
  Math.ceil(NINE_FIFTEEN_BACKTEST_MAX_SESSIONS * (365 / NSE_SESSIONS_ONE_YEAR)) + 120;

const MIN_SESSION_MINUTE_BARS = 330;
const TIME_CHECKPOINTS: { label: NineFifteenTimeCheckpoint; minutes: number }[] = [
  { label: "9:30", minutes: 9 * 60 + 30 },
  { label: "9:45", minutes: 9 * 60 + 45 },
  { label: "10:00", minutes: 10 * 60 },
];

type MinuteCandle = {
  mins: number;
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type CandleFetcher = (
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) => Promise<{ instrument: string; candles: unknown[] }>;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function getIstParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  // en-IN + hour12:false can yield hour "24" at midnight; treat as 0.
  const hour = pick("hour") % 24;
  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour,
    minute: pick("minute"),
    second: pick("second"),
  };
}

function istDateKey(date: Date): string {
  const ist = getIstParts(date);
  return `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`;
}

function istMinutes(date: Date): number {
  const ist = getIstParts(date);
  return ist.hour * 60 + ist.minute;
}

function listWeekdayDatesIst(calendarDaysBack: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let offset = calendarDaysBack; offset >= 0; offset -= 1) {
    const d = new Date(today.getTime() - offset * 86_400_000);
    const ist = getIstParts(d);
    if (ist.weekday === "Sat" || ist.weekday === "Sun") continue;
    dates.push(`${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`);
  }
  return dates;
}

/** Calendar lookback wide enough to capture `sessionDays` NSE sessions (holidays excluded later via Kite rows). */
function calendarDaysForSessionLookback(sessionDays: number): number {
  return Math.min(NINE_FIFTEEN_MAX_HISTORY_DAYS, Math.ceil(sessionDays * (365 / NSE_SESSIONS_ONE_YEAR)) + 45);
}

function isKiteMinuteCandleTuple(item: unknown): item is [string, number, number, number, number, number] {
  if (!Array.isArray(item) || item.length < 5) return false;
  const [, o, h, l, c] = item;
  return [o, h, l, c].every((v) => typeof v === "number" && Number.isFinite(v));
}

function isValidKiteSessionDay(candles: MinuteCandle[]): boolean {
  if (candles.length < MIN_SESSION_MINUTE_BARS) return false;
  if (!candles.some((c) => c.mins === SESSION_OPEN_MINUTES)) return false;
  if (!candles.some((c) => c.mins === SESSION_ENTRY_MINUTES)) return false;
  const lastMins = candles[candles.length - 1]?.mins ?? 0;
  return lastMins >= SESSION_CLOSE_MINUTES - 1;
}

function chunkTradingDates(dates: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < dates.length; i += size) {
    chunks.push(dates.slice(i, i + size));
  }
  return chunks;
}

function directionFromOhlc(open: number, close: number): NineFifteenDirection {
  if (close > open) return "up";
  if (close < open) return "down";
  return "flat";
}

function buildLevelFlags(
  openPx: number,
  highPx: number,
  lowPx: number,
  points: IndexPoints,
): {
  maxGainFromOpen: number;
  maxLossFromOpen: number;
  gainLevels: Record<NineFifteenRupeLevel, boolean>;
  lossLevels: Record<NineFifteenRupeLevel, boolean>;
} {
  const maxGainFromOpen = Math.max(0, highPx - openPx);
  const maxLossFromOpen = Math.max(0, openPx - lowPx);

  const gainLevels = {} as Record<NineFifteenRupeLevel, boolean>;
  const lossLevels = {} as Record<NineFifteenRupeLevel, boolean>;

  // The literal stays the record key on every index; only the price it stands for scales.
  for (const level of NINE_FIFTEEN_RUPEE_LEVELS) {
    gainLevels[level] = highPx >= openPx + level * points.scale;
    lossLevels[level] = lowPx <= openPx - level * points.scale;
  }

  return { maxGainFromOpen, maxLossFromOpen, gainLevels, lossLevels };
}

function buildCePeLevelFlags(
  openPx: number,
  highPx: number,
  lowPx: number,
  points: IndexPoints,
): {
  upLevels: Record<NineFifteenCePeTarget, boolean>;
  downLevels: Record<NineFifteenCePeTarget, boolean>;
} {
  const upLevels = {} as Record<NineFifteenCePeTarget, boolean>;
  const downLevels = {} as Record<NineFifteenCePeTarget, boolean>;

  for (const level of NINE_FIFTEEN_CEPE_TARGETS) {
    upLevels[level] = highPx >= openPx + level * points.scale;
    downLevels[level] = lowPx <= openPx - level * points.scale;
  }

  return { upLevels, downLevels };
}

function buildCheckpointSnapshots(
  openPx: number,
  sessionCandles: MinuteCandle[],
  points: IndexPoints,
): Record<NineFifteenTimeCheckpoint, NineFifteenCheckpointLevels> {
  const checkpoints = {} as Record<NineFifteenTimeCheckpoint, NineFifteenCheckpointLevels>;
  const bar917 = sessionCandles.find((c) => c.mins === BACKTEST_EXIT_START_MINUTES);
  const seedHigh = bar917?.high ?? openPx;
  const seedLow = bar917?.low ?? openPx;

  if (!sessionCandles.some((c) => c.mins >= BACKTEST_EXIT_START_MINUTES)) {
    for (const cp of TIME_CHECKPOINTS) {
      const flags = buildCePeLevelFlags(openPx, openPx, openPx, points);
      checkpoints[cp.label] = { high: openPx, low: openPx, ...flags };
    }
    return checkpoints;
  }

  let windowHigh = seedHigh;
  let windowLow = seedLow;
  const captured = new Set<NineFifteenTimeCheckpoint>();

  for (const c of sessionCandles) {
    if (!kiteCandleInExitWindow(c)) continue;
    windowHigh = Math.max(windowHigh, c.high);
    windowLow = Math.min(windowLow, c.low);

    for (const cp of TIME_CHECKPOINTS) {
      if (c.mins === cp.minutes && !captured.has(cp.label)) {
        const flags = buildCePeLevelFlags(openPx, windowHigh, windowLow, points);
        checkpoints[cp.label] = { high: windowHigh, low: windowLow, ...flags };
        captured.add(cp.label);
      }
    }
  }

  for (const cp of TIME_CHECKPOINTS) {
    if (checkpoints[cp.label]) continue;
    let h = seedHigh;
    let l = seedLow;
    for (const c of sessionCandles) {
      if (!kiteCandleInExitWindow(c) || c.mins > cp.minutes) continue;
      h = Math.max(h, c.high);
      l = Math.min(l, c.low);
    }
    const flags = buildCePeLevelFlags(openPx, h, l, points);
    checkpoints[cp.label] = { high: h, low: l, ...flags };
  }

  return checkpoints;
}

/** Kite 1-min bars from 9:16 through 15:30 — OHLC including entry minute. */
function kiteCandleInExitWindow(c: MinuteCandle): boolean {
  return c.mins >= BACKTEST_EXIT_START_MINUTES && c.mins <= SESSION_CLOSE_MINUTES;
}

function makeTargetHitFromKiteBar(
  c: MinuteCandle,
  entryPrice: number,
  targetPoints: number,
  direction: "up" | "down",
): NineFifteenTargetHit {
  const indexPrice =
    direction === "up" ? entryPrice + targetPoints : entryPrice - targetPoints;
  const levelLabel = direction === "up" ? `+${targetPoints}` : `−${targetPoints}`;
  return {
    /** Kite candle start time (HH:MM:00) — first minute whose high/low touched the level. */
    timeIst: formatIstHms(c.mins * 60),
    levelLabel,
    indexPrice,
  };
}

/** At 10:00 IST open: how many index points still needed to reach entry ± target. */
function computeTargetGapAt1000(
  entryPx: number,
  indexAt1000: number | null | undefined,
  tradeSide: "CE" | "PE",
  targetPoints: number,
): NineFifteenTargetGapAtCheckpoint | null {
  if (indexAt1000 == null || !Number.isFinite(indexAt1000)) return null;
  const targetIndexPrice =
    tradeSide === "CE" ? entryPx + targetPoints : entryPx - targetPoints;
  const pointsFromTarget =
    tradeSide === "PE"
      ? Math.max(0, indexAt1000 - targetIndexPrice)
      : Math.max(0, targetIndexPrice - indexAt1000);
  return {
    checkpointIst: "10:00:00",
    indexPrice: indexAt1000,
    targetIndexPrice,
    pointsFromTarget,
  };
}

/** Backtest entry: real Kite 9:16 bar open at 09:16:00. */
function kiteEntryAt916Open(bar916: MinuteCandle): NineFifteenTradeEntry {
  return {
    timeIst: formatIstHms(BACKTEST_ENTRY_SEC_OF_DAY),
    indexPrice: bar916.open,
  };
}

function formatIstHms(secondsOfDay: number): string {
  const clamped = Math.max(0, Math.min(24 * 3600 - 1, Math.round(secondsOfDay)));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function sessionExtremesFromKiteExitWindow(
  sessionCandles: MinuteCandle[],
): { high: number; low: number } | null {
  let high = -Infinity;
  let low = Infinity;
  let any = false;
  for (const c of sessionCandles) {
    if (!kiteCandleInExitWindow(c)) continue;
    high = Math.max(high, c.high);
    low = Math.min(low, c.low);
    any = true;
  }
  if (!any) return null;
  return { high, low };
}

/**
 * First Kite 1-min bar from 9:16 whose high/low touches entry ± target.
 * Hit time = that candle's open (real Zerodha minute stamp).
 */
function firstTargetHitsFromKite(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  targetPoints: number,
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  const targetUp = entryPrice + targetPoints;
  const targetDown = entryPrice - targetPoints;
  let up: NineFifteenTargetHit | null = null;
  let down: NineFifteenTargetHit | null = null;

  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    if (!up && c.high >= targetUp) {
      up = makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (!down && c.low <= targetDown) {
      down = makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
    if (up && down) break;
  }

  return { up, down };
}

/** Before switch minute: `targetBefore`; from switch minute onward: `targetAfter`. */
function firstDirectionalHitSwitchingTarget(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  direction: "up" | "down",
  targetBefore: number,
  targetAfter: number,
  switchAfterMins: number,
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    const targetPoints = c.mins >= switchAfterMins ? targetAfter : targetBefore;
    if (direction === "up" && c.high >= entryPrice + targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (direction === "down" && c.low <= entryPrice - targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
  }
  return null;
}

function switchingTargetTwoPhase(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  targetBefore: number,
  targetAfter: number,
  switchAfterMins: number,
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  return {
    up: firstDirectionalHitSwitchingTarget(
      entryPrice,
      sessionCandles,
      "up",
      targetBefore,
      targetAfter,
      switchAfterMins,
    ),
    down: firstDirectionalHitSwitchingTarget(
      entryPrice,
      sessionCandles,
      "down",
      targetBefore,
      targetAfter,
      switchAfterMins,
    ),
  };
}

function firstDirectionalHitFixedTarget(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  direction: "up" | "down",
  targetPoints: number,
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    if (direction === "up" && c.high >= entryPrice + targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (direction === "down" && c.low <= entryPrice - targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
  }
  return null;
}

/** ±25 until 10:01 · ±20 from 10:01 · ±15 from 11:01 (main live-aligned backtest exit). */
function indexTargetPointsForMinute(mins: number, points: IndexPoints): number {
  return indexTargetPointsForMinuteWithTiers(
    mins,
    points.backtestTarget25,
    points.indexTarget20,
    points.indexTarget15,
  );
}

function indexTargetPointsForMinuteWithTiers(
  mins: number,
  targetBefore101: number,
  targetFrom101: number,
  targetFrom1101: number,
): number {
  if (mins >= NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE) return targetFrom1101;
  if (mins >= NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE) return targetFrom101;
  return targetBefore101;
}

function firstDirectionalHitTieredIndexTargetWithTiers(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  direction: "up" | "down",
  targetBefore101: number,
  targetFrom101: number,
  targetFrom1101: number,
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    const targetPoints = indexTargetPointsForMinuteWithTiers(
      c.mins,
      targetBefore101,
      targetFrom101,
      targetFrom1101,
    );
    if (direction === "up" && c.high >= entryPrice + targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (direction === "down" && c.low <= entryPrice - targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
  }
  return null;
}

function tieredIndexTargetHitsFromKite(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  points: IndexPoints,
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  return tieredIndexTargetHitsFromKiteWithTiers(
    entryPrice,
    sessionCandles,
    points.backtestTarget25,
    points.indexTarget20,
    points.indexTarget15,
  );
}

function tieredIndexTargetHitsFromKiteWithTiers(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  targetBefore101: number,
  targetFrom101: number,
  targetFrom1101: number,
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  return {
    up: firstDirectionalHitTieredIndexTargetWithTiers(
      entryPrice,
      sessionCandles,
      "up",
      targetBefore101,
      targetFrom101,
      targetFrom1101,
    ),
    down: firstDirectionalHitTieredIndexTargetWithTiers(
      entryPrice,
      sessionCandles,
      "down",
      targetBefore101,
      targetFrom101,
      targetFrom1101,
    ),
  };
}

function custom60MainTargetAtMinute(mins: number, points: IndexPoints): number {
  if (mins >= NINE_FIFTEEN_CONSOL_CUSTOM_SWITCH_1202) return points.consolCustomMain3;
  if (mins >= NINE_FIFTEEN_CONSOL_CUSTOM_SWITCH_1002) return points.consolCustomMain2;
  return points.consolCustomMain1;
}

function custom60NearTargetAtMinute(mins: number, points: IndexPoints): number {
  if (mins >= NINE_FIFTEEN_CONSOL_CUSTOM_SWITCH_1002) return points.consolCustomNear2;
  return points.consolCustomNear1;
}

function niftyConfirm917TargetAtMinute(mins: number): number {
  if (mins >= NIFTY_CONFIRM917_SWITCH_1102) return NIFTY_CONFIRM917_EXIT_T3;
  if (mins >= NIFTY_CONFIRM917_SWITCH_1002) return NIFTY_CONFIRM917_EXIT_T2;
  return NIFTY_CONFIRM917_EXIT_T1;
}

function firstNiftyConfirm917DirectionalHit(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  direction: "up" | "down",
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (c.mins < CONFIRM918_ENTRY_MINUTES || c.mins > SESSION_CLOSE_MINUTES) continue;
    const targetPoints = niftyConfirm917TargetAtMinute(c.mins);
    if (direction === "up" && c.high >= entryPrice + targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (direction === "down" && c.low <= entryPrice - targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
  }
  return null;
}

function niftyConfirm917TargetHitsFromKite(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  return {
    up: firstNiftyConfirm917DirectionalHit(entryPrice, sessionCandles, "up"),
    down: firstNiftyConfirm917DirectionalHit(entryPrice, sessionCandles, "down"),
  };
}

function firstCustom60TargetHit(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  direction: "up" | "down",
  band: "main" | "near_miss",
  points: IndexPoints,
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    const targetPoints =
      band === "main"
        ? custom60MainTargetAtMinute(c.mins, points)
        : custom60NearTargetAtMinute(c.mins, points);
    if (direction === "up" && c.high >= entryPrice + targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (direction === "down" && c.low <= entryPrice - targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
  }
  return null;
}

function custom60TargetHitsFromKite(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  band: "main" | "near_miss",
  points: IndexPoints,
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  return {
    up: firstCustom60TargetHit(entryPrice, sessionCandles, "up", band, points),
    down: firstCustom60TargetHit(entryPrice, sessionCandles, "down", band, points),
  };
}

function makeAdverseStopHitFromKiteBar(
  c: MinuteCandle,
  entryPrice: number,
  stopPoints: number,
  tradeSide: "CE" | "PE",
): NineFifteenTargetHit {
  const stopLevel =
    tradeSide === "CE" ? entryPrice - stopPoints : entryPrice + stopPoints;
  const exitIndexPrice = tradeSide === "CE" ? c.low : c.high;
  const exitVsStopPts = exitIndexPrice - stopLevel;
  const direction = tradeSide === "CE" ? "down" : "up";
  return {
    ...makeTargetHitFromKiteBar(c, entryPrice, stopPoints, direction),
    exitIndexPrice,
    exitVsStopPts: Number(exitVsStopPts.toFixed(2)),
  };
}

/**
 * Breakout backtest: first bar that moves `stopPoints` against the trade from the 9:16 entry.
 * A CE buy stops out below entry, a PE buy above it.
 */
function firstAdverseStopHitFromKite(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  tradeSide: "CE" | "PE",
  stopPoints: number,
  activeFromMins: number = BACKTEST_EXIT_START_MINUTES,
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    if (c.mins < activeFromMins) continue;
    if (tradeSide === "CE" && c.low <= entryPrice - stopPoints) {
      return makeAdverseStopHitFromKiteBar(c, entryPrice, stopPoints, "CE");
    }
    if (tradeSide === "PE" && c.high >= entryPrice + stopPoints) {
      return makeAdverseStopHitFromKiteBar(c, entryPrice, stopPoints, "PE");
    }
  }
  return null;
}

/** Tiered profit target for breakout study (matches live backtest exits). */
function breakoutProfitTargetPointsAtMinute(
  band: "main" | "near_miss",
  mins: number,
  points: IndexPoints,
  profile: IndexProfile,
  dateKey?: string,
): number {
  if (dateKey && isExpiryWeekday(dateKey, profile)) return points.breakoutExpiryDayTarget;
  if (band === "near_miss") {
    return mins >= NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE
      ? points.nearMissTargetAfter
      : points.nearMissTarget;
  }
  return indexTargetPointsForMinute(mins, points);
}

/**
 * Full session (9:16–15:30): minute whose high/low came closest to the tiered profit target.
 */
function closestApproachToTieredProfitTarget(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  tradeSide: "CE" | "PE",
  band: "main" | "near_miss",
  dateKey: string,
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenBreakoutTargetApproach | null {
  let best: NineFifteenBreakoutTargetApproach | null = null;

  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;

    const targetPoints = breakoutProfitTargetPointsAtMinute(band, c.mins, points, profile, dateKey);
    const targetIndexPrice =
      tradeSide === "CE" ? entryPrice + targetPoints : entryPrice - targetPoints;
    const extreme = tradeSide === "CE" ? c.high : c.low;
    const gapToTargetPts =
      tradeSide === "CE"
        ? Math.max(0, targetIndexPrice - extreme)
        : Math.max(0, extreme - targetIndexPrice);
    const roundedGap = Number(gapToTargetPts.toFixed(2));

    if (
      best == null ||
      roundedGap < best.gapToTargetPts ||
      (roundedGap === best.gapToTargetPts && c.mins < minutesFromIstTime(best.timeIst))
    ) {
      best = {
        timeIst: formatIstHms(c.mins * 60),
        indexPrice: extreme,
        targetPoints,
        targetIndexPrice,
        gapToTargetPts: roundedGap,
      };
    }
  }

  return best;
}

/** Nearest the session came to a flat ± target (gap 0 once touched). */
function closestApproachToFixedTarget(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  tradeSide: "CE" | "PE",
  targetPoints: number,
): NineFifteenBreakoutTargetApproach | null {
  const targetIndexPrice =
    tradeSide === "CE" ? entryPrice + targetPoints : entryPrice - targetPoints;
  let best: NineFifteenBreakoutTargetApproach | null = null;

  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    const extreme = tradeSide === "CE" ? c.high : c.low;
    const gap =
      tradeSide === "CE"
        ? Math.max(0, targetIndexPrice - extreme)
        : Math.max(0, extreme - targetIndexPrice);
    const roundedGap = Number(gap.toFixed(2));
    if (best == null || roundedGap < best.gapToTargetPts) {
      best = {
        timeIst: formatIstHms(c.mins * 60),
        indexPrice: extreme,
        targetPoints,
        targetIndexPrice,
        gapToTargetPts: roundedGap,
      };
    }
  }

  return best;
}

function minutesFromIstTime(timeIst: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(timeIst.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Band from the 9:15 bar — mirrors liveExitModeForRow but runs before the row exists. */
function breakoutBandForChange(
  direction: NineFifteenDirection,
  change: number,
  points: IndexPoints,
): "main" | "near_miss" | null {
  if (direction !== "up" && direction !== "down") return null;
  const abs = Math.abs(change);
  if (abs >= points.followMinAbsDiff) return "main";
  if (abs >= points.nearMissMinAbsDiff) return "near_miss";
  return null;
}

function breakoutStopPointsForBand(
  band: "main" | "near_miss",
  config: BreakoutStopConfig,
): number {
  return band === "near_miss" ? config.stopNearMissPoints : config.stopMainPoints;
}

/** Best move in trade direction after entry — time = Kite bar open when that bar's high/low set a new MFE. */
function maxFavorableMoveFromKiteExitWindow(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  tradeSide: "CE" | "PE",
): NineFifteenMfePeak {
  let bestMove = 0;
  let bestBar: MinuteCandle | null = null;
  let bestPrice = entryPrice;

  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    const move =
      tradeSide === "CE" ? c.high - entryPrice : entryPrice - c.low;
    if (move > bestMove) {
      bestMove = move;
      bestBar = c;
      bestPrice = tradeSide === "CE" ? c.high : c.low;
    }
  }

  if (!bestBar || bestMove <= 0) {
    return { timeIst: formatIstHms(BACKTEST_EXIT_START_MINUTES * 60), indexPrice: entryPrice, movePts: 0 };
  }

  return {
    timeIst: formatIstHms(bestBar.mins * 60),
    indexPrice: bestPrice,
    movePts: bestMove,
  };
}

function buildDayLevelFlags(
  openPx: number,
  sessionHigh: number,
  sessionLow: number,
  points: IndexPoints,
): {
  maxDayUpFrom915: number;
  maxDayDownFrom915: number;
  dayUpLevels: Record<NineFifteenRupeLevel, boolean>;
  dayDownLevels: Record<NineFifteenRupeLevel, boolean>;
} {
  const maxDayUpFrom915 = Math.max(0, sessionHigh - openPx);
  const maxDayDownFrom915 = Math.max(0, openPx - sessionLow);

  const dayUpLevels = {} as Record<NineFifteenRupeLevel, boolean>;
  const dayDownLevels = {} as Record<NineFifteenRupeLevel, boolean>;

  for (const level of NINE_FIFTEEN_RUPEE_LEVELS) {
    dayUpLevels[level] = sessionHigh >= openPx + level * points.scale;
    dayDownLevels[level] = sessionLow <= openPx - level * points.scale;
  }

  return { maxDayUpFrom915, maxDayDownFrom915, dayUpLevels, dayDownLevels };
}

function sessionDayClosePx(sessionCandles: MinuteCandle[]): number | null {
  if (sessionCandles.length === 0) return null;
  const sorted = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  const barClose = sorted.find((c) => c.mins === SESSION_CLOSE_MINUTES);
  if (barClose) return barClose.close;
  return sorted[sorted.length - 1]?.close ?? null;
}

function buildPrevDayCloseMap(byDate: Map<string, MinuteCandle[]>): Map<string, number> {
  const sortedDates = [...byDate.keys()].sort();
  const closeByDate = new Map<string, number>();
  for (const date of sortedDates) {
    const candles = byDate.get(date);
    if (!candles) continue;
    candles.sort((a, b) => a.mins - b.mins);
    const sessionCandles = candles.filter(
      (c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES,
    );
    if (!isValidKiteSessionDay(sessionCandles)) continue;
    const closePx = sessionDayClosePx(sessionCandles);
    if (closePx !== null && Number.isFinite(closePx)) closeByDate.set(date, closePx);
  }

  const prevCloseForDate = new Map<string, number>();
  let lastClose: number | null = null;
  for (const date of sortedDates) {
    const closePx = closeByDate.get(date);
    if (lastClose !== null) prevCloseForDate.set(date, lastClose);
    if (closePx !== undefined) lastClose = closePx;
  }
  return prevCloseForDate;
}

type MinuteCandlesByDate = Map<string, MinuteCandle[]>;

/**
 * Fold one Kite response chunk into the date→minutes map. Called per chunk so the raw tuples
 * can be garbage collected as we go — holding a full year of them alongside the parsed map was
 * enough to OOM a 2 GB host.
 */
function ingestRawCandles(raw: unknown[], byDate: MinuteCandlesByDate): void {
  for (const item of raw) {
    if (!isKiteMinuteCandleTuple(item)) continue;
    const [time, open, high, low, close] = item;
    const parsed = new Date(String(time));
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinutes(parsed);
    if (mins < SESSION_OPEN_MINUTES || mins > SESSION_CLOSE_MINUTES) continue;

    const openPx = Number(open);
    const highPx = Number(high);
    const lowPx = Number(low);
    const closePx = Number(close);
    if (![openPx, highPx, lowPx, closePx].every(Number.isFinite)) continue;

    const date = istDateKey(parsed);
    const list = byDate.get(date) ?? [];
    list.push({ mins, time: parsed, open: openPx, high: highPx, low: lowPx, close: closePx });
    byDate.set(date, list);
  }
}

function buildRowsFromMinuteMap(
  byDate: MinuteCandlesByDate,
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenCandleRow[] {
  const prevDayCloseByDate = buildPrevDayCloseMap(byDate);

  const timeline: { date: string; mins: number; close: number; ms: number }[] = [];
  for (const [date, candles] of byDate) {
    for (const c of candles) {
      timeline.push({ date, mins: c.mins, close: c.close, ms: c.time.getTime() });
    }
  }
  timeline.sort((a, b) => a.ms - b.ms);
  const closeSeries = timeline.map((c) => c.close);
  const barIndexByKey = new Map<string, number>();
  timeline.forEach((c, i) => barIndexByKey.set(`${c.date}@${c.mins}`, i));

  const rows: NineFifteenCandleRow[] = [];

  for (const [date, candles] of byDate) {
    candles.sort((a, b) => a.mins - b.mins);
    const bar915 = candles.find((c) => c.mins === SESSION_OPEN_MINUTES);
    if (!bar915) continue;

    const sessionCandles = candles.filter(
      (c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES,
    );
    if (!isValidKiteSessionDay(sessionCandles)) continue;

    const sessionHigh = Math.max(...sessionCandles.map((c) => c.high));
    const sessionLow = Math.min(...sessionCandles.map((c) => c.low));
    const afterEntryExtremes = sessionExtremesFromKiteExitWindow(sessionCandles);
    const sessionHighAfter916 = afterEntryExtremes?.high ?? bar915.open;
    const sessionLowAfter916 = afterEntryExtremes?.low ?? bar915.open;

    const change = bar915.close - bar915.open;
    const changePct = bar915.open !== 0 ? (change / bar915.open) * 100 : 0;
    const minuteLevels = buildLevelFlags(bar915.open, bar915.high, bar915.low, points);
    const dayLevels = buildDayLevelFlags(bar915.open, sessionHigh, sessionLow, points);
    const checkpoints = buildCheckpointSnapshots(bar915.open, sessionCandles, points);
    const bar916 = sessionCandles.find((c) => c.mins === SESSION_ENTRY_MINUTES);
    const bar1000 = sessionCandles.find((c) => c.mins === 10 * 60);
    const entryAtLive916 = bar916 ? kiteEntryAt916Open(bar916) : null;
    const entryPx = entryAtLive916?.indexPrice ?? bar915.open;
    const hit25 = firstTargetHitsFromKite(entryPx, sessionCandles, points.backtestTarget25);
    const hit15 = firstTargetHitsFromKite(entryPx, sessionCandles, points.backtestTarget15);
    const hit10 = firstTargetHitsFromKite(entryPx, sessionCandles, points.backtestTarget10);
    const hit8 = firstTargetHitsFromKite(entryPx, sessionCandles, points.backtestTarget8);
    const tieredMain = tieredIndexTargetHitsFromKite(entryPx, sessionCandles, points);
    const tieredConsolidatedAltMain = tieredIndexTargetHitsFromKiteWithTiers(
      entryPx,
      sessionCandles,
      points.consolidatedAltMain1,
      points.consolidatedAltMain2,
      points.consolidatedAltMain3,
    );
    const switch20_10 = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      points.nearMissTarget,
      points.nearMissTargetAfter,
      NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE,
    );
    const switchConsolidatedAltNear = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      points.consolidatedAltNear1,
      points.consolidatedAltNear2,
      NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE,
    );
    const hitFlat50 = firstTargetHitsFromKite(entryPx, sessionCandles, points.consolidatedFlat50);
    const hitFlat40 = firstTargetHitsFromKite(entryPx, sessionCandles, points.consolidatedFlat40);
    const hitFlat30 = firstTargetHitsFromKite(entryPx, sessionCandles, points.consolidatedFlat30);
    const hitFlat20 = firstTargetHitsFromKite(entryPx, sessionCandles, points.consolidatedFlat20);
    const maxFavorableCeAfterEntry = maxFavorableMoveFromKiteExitWindow(entryPx, sessionCandles, "CE");
    const maxFavorablePeAfterEntry = maxFavorableMoveFromKiteExitWindow(entryPx, sessionCandles, "PE");

    /**
     * Two-candle confirmation study: entry is the 9:17 open, so its exits are measured from that
     * price over bars from 9:17 only — a target touched during the 9:16 bar happens before entry.
     */
    const bar918 = sessionCandles.find((c) => c.mins === CONFIRM918_ENTRY_MINUTES);
    const candles918 = sessionCandles.filter((c) => c.mins >= CONFIRM918_ENTRY_MINUTES);
    const entryAt918: NineFifteenTradeEntry | null = bar918
      ? { timeIst: formatIstHms(CONFIRM918_ENTRY_MINUTES * 60), indexPrice: bar918.open }
      : null;
    const px918 = entryAt918?.indexPrice ?? null;
    const confirm918Main = px918
      ? tieredIndexTargetHitsFromKiteWithTiers(
          px918,
          candles918,
          points.consolidatedAltMain1,
          points.consolidatedAltMain2,
          points.consolidatedAltMain3,
        )
      : { up: null, down: null };
    const confirm918Near = px918
      ? switchingTargetTwoPhase(
          px918,
          candles918,
          points.consolidatedAltNear1,
          points.consolidatedAltNear2,
          NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE,
        )
      : { up: null, down: null };
    const confirm918Expiry =
      px918 && isExpiryWeekday(date, profile)
        ? {
            up: firstDirectionalHitFixedTarget(
              px918,
              candles918,
              "up",
              points.breakoutExpiryDayTarget,
            ),
            down: firstDirectionalHitFixedTarget(
              px918,
              candles918,
              "down",
              points.breakoutExpiryDayTarget,
            ),
          }
        : { up: null, down: null };
    const niftyConfirm917 = px918 ? niftyConfirm917TargetHitsFromKite(px918, candles918) : { up: null, down: null };
    const maxFavorableCeAfter918 = px918
      ? maxFavorableMoveFromKiteExitWindow(px918, candles918, "CE")
      : null;
    const maxFavorablePeAfter918 = px918
      ? maxFavorableMoveFromKiteExitWindow(px918, candles918, "PE")
      : null;

    const custom60Main = custom60TargetHitsFromKite(entryPx, sessionCandles, "main", points);
    const custom60Near = custom60TargetHitsFromKite(entryPx, sessionCandles, "near_miss", points);
    const custom60StopCe = firstAdverseStopHitFromKite(
      entryPx,
      sessionCandles,
      "CE",
      points.consolCustomHardStop,
      NINE_FIFTEEN_CONSOL_CUSTOM_HARD_STOP_START,
    );
    const custom60StopPe = firstAdverseStopHitFromKite(
      entryPx,
      sessionCandles,
      "PE",
      points.consolCustomHardStop,
      NINE_FIFTEEN_CONSOL_CUSTOM_HARD_STOP_START,
    );
    const switch25_20 = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      points.backtestTarget25,
      points.indexTarget20,
      NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE,
    );
    const switch25_15 = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      points.backtestTarget25,
      points.indexTarget15,
      NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE,
    );

    const direction = directionFromOhlc(bar915.open, bar915.close);
    const breakoutBand = breakoutBandForChange(direction, change, points);
    const breakoutSide: "CE" | "PE" | null =
      breakoutBand == null ? null : direction === "down" ? "PE" : "CE";
    const breakoutStopPoints = breakoutBand
      ? breakoutStopPointsForBand(breakoutBand, breakoutStopTight(points))
      : null;
    const breakoutStopHit =
      breakoutSide && breakoutStopPoints
        ? firstAdverseStopHitFromKite(
            entryPx,
            sessionCandles,
            breakoutSide,
            breakoutStopPoints,
            breakoutStopActiveFromMinsForDate(date, profile),
          )
        : null;
    const breakoutTuesdayTargetHit =
      isExpiryWeekday(date, profile) && breakoutSide
        ? firstDirectionalHitFixedTarget(
            entryPx,
            sessionCandles,
            breakoutSide === "CE" ? "up" : "down",
            points.breakoutExpiryDayTarget,
          )
        : null;
    const tuesdayTenClosest =
      isExpiryWeekday(date, profile) && breakoutSide
        ? closestApproachToFixedTarget(
            entryPx,
            sessionCandles,
            breakoutSide,
            points.breakoutExpiryDayTarget,
          )
        : null;
    const breakoutClosestToTarget =
      breakoutSide && breakoutBand
        ? closestApproachToTieredProfitTarget(
            entryPx,
            sessionCandles,
            breakoutSide,
            breakoutBand,
            date,
            points,
            profile,
          )
        : null;

    const prevDayClose = prevDayCloseByDate.get(date) ?? null;
    const gapFromPrevClose =
      prevDayClose !== null ? bar915.open - prevDayClose : null;
    const gapFromPrevCloseDirection =
      gapFromPrevClose !== null && prevDayClose !== null
        ? directionFromOhlc(prevDayClose, bar915.open)
        : null;

    const bar915Idx = barIndexByKey.get(`${date}@${SESSION_OPEN_MINUTES}`);
    const bar916Idx = barIndexByKey.get(`${date}@${SESSION_ENTRY_MINUTES}`);
    const rsi915 =
      bar915Idx != null
        ? rsiAtBarIndex(closeSeries, bar915Idx, NINE_FIFTEEN_RSI_PERIOD)
        : null;
    const rsi916 =
      bar916Idx != null
        ? rsiAtBarIndex(closeSeries, bar916Idx, NINE_FIFTEEN_RSI_PERIOD)
        : null;

    rows.push({
      date,
      open: bar915.open,
      close: bar915.close,
      high: bar915.high,
      low: bar915.low,
      change,
      changePct,
      direction,
      ...minuteLevels,
      sessionHigh,
      sessionLow,
      sessionHighAfter916,
      sessionLowAfter916,
      ...dayLevels,
      checkpoints,
      firstHitUp25: hit25.up,
      firstHitDown25: hit25.down,
      firstHitUp15: hit15.up,
      firstHitDown15: hit15.down,
      firstHitUp10: hit10.up,
      firstHitDown10: hit10.down,
      firstHitUp8: hit8.up,
      firstHitDown8: hit8.down,
      tiered25Then20Then15Up: tieredMain.up,
      tiered25Then20Then15Down: tieredMain.down,
      tieredConsolidatedAltMainUp: tieredConsolidatedAltMain.up,
      tieredConsolidatedAltMainDown: tieredConsolidatedAltMain.down,
      switch20Then10After1001Up: switch20_10.up,
      switch20Then10After1001Down: switch20_10.down,
      switchConsolidatedAltNearUp: switchConsolidatedAltNear.up,
      switchConsolidatedAltNearDown: switchConsolidatedAltNear.down,
      consolidatedFlat50Up: hitFlat50.up,
      consolidatedFlat50Down: hitFlat50.down,
      consolidatedFlat40Up: hitFlat40.up,
      consolidatedFlat40Down: hitFlat40.down,
      consolidatedFlat30Up: hitFlat30.up,
      consolidatedFlat30Down: hitFlat30.down,
      consolidatedFlat20Up: hitFlat20.up,
      consolidatedFlat20Down: hitFlat20.down,
      entryAtLive916,
      change916: bar916 ? bar916.close - bar916.open : null,
      entryAt918,
      confirm918MainUp: confirm918Main.up,
      confirm918MainDown: confirm918Main.down,
      confirm918NearUp: confirm918Near.up,
      confirm918NearDown: confirm918Near.down,
      confirm918ExpiryUp: confirm918Expiry.up,
      confirm918ExpiryDown: confirm918Expiry.down,
      niftyConfirm917Up: niftyConfirm917.up,
      niftyConfirm917Down: niftyConfirm917.down,
      maxFavorableCeAfter918,
      maxFavorablePeAfter918,
      custom60MainUp: custom60Main.up,
      custom60MainDown: custom60Main.down,
      custom60NearUp: custom60Near.up,
      custom60NearDown: custom60Near.down,
      custom60StopCe,
      custom60StopPe,
      maxFavorableCeAfterEntry,
      maxFavorablePeAfterEntry,
      prevDayClose,
      gapFromPrevClose,
      gapFromPrevCloseDirection,
      switch25Then20After1010Up: switch25_20.up,
      switch25Then20After1010Down: switch25_20.down,
      switch25Then15After1101Up: switch25_15.up,
      switch25Then15After1101Down: switch25_15.down,
      rsi915: rsi915 != null ? Number(rsi915.toFixed(2)) : null,
      rsi916: rsi916 != null ? Number(rsi916.toFixed(2)) : null,
      indexOpenAt1000: bar1000?.open ?? null,
      breakoutStopHit,
      breakoutTuesdayTargetHit,
      breakoutStopPoints,
      breakoutClosestToTarget,
      tuesdayTenClosest,
    });
  }

  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

function buildLevelSummary(
  rows: NineFifteenCandleRow[],
  pick: (row: NineFifteenCandleRow) => Record<NineFifteenRupeLevel, boolean>,
): NineFifteenLevelSummary[] {
  const total = rows.length;
  return NINE_FIFTEEN_RUPEE_LEVELS.map((level) => {
    const hitCount = rows.filter((row) => pick(row)[level]).length;
    return {
      level,
      hitCount,
      hitPct: total > 0 ? (hitCount / total) * 100 : 0,
    };
  });
}

/** Session summary bucket for the 9:15 Kite bar — small bodies count as flat. */
function summary915CloseBucket(row: NineFifteenCandleRow): NineFifteenDirection {
  if (Math.abs(row.change) + 1e-9 < NINE_SIXTEEN_MIN_915_ABS_DIFF) return "flat";
  return row.direction;
}

function buildSummary(rows: NineFifteenCandleRow[]) {
  const up = rows.filter((row) => summary915CloseBucket(row) === "up").length;
  const down = rows.filter((row) => summary915CloseBucket(row) === "down").length;
  const flat = rows.filter((row) => summary915CloseBucket(row) === "flat").length;
  const total = rows.length;
  return {
    total,
    up,
    down,
    flat,
    upPct: total > 0 ? (up / total) * 100 : 0,
    downPct: total > 0 ? (down / total) * 100 : 0,
    gainLevels: buildLevelSummary(rows, (row) => row.gainLevels),
    lossLevels: buildLevelSummary(rows, (row) => row.lossLevels),
    dayUpLevels: buildLevelSummary(rows, (row) => row.dayUpLevels),
    dayDownLevels: buildLevelSummary(rows, (row) => row.dayDownLevels),
  };
}

type HitMode = "up" | "down" | "follow";

function checkpointHit(
  row: NineFifteenCandleRow,
  checkpoint: NineFifteenTimeCheckpoint,
  targetPoints: number,
  mode: HitMode,
  points: IndexPoints,
): boolean {
  const snap = row.checkpoints?.[checkpoint];
  if (!snap) return false;
  // Snapshot flags are keyed by the Nifty-baseline level, so scale the target back to find it.
  const level = (targetPoints / points.scale) as NineFifteenCePeTarget;
  if (mode === "up") return snap.upLevels[level] ?? false;
  if (mode === "down") return snap.downLevels[level] ?? false;
  if (row.direction === "up") return snap.upLevels[level] ?? false;
  if (row.direction === "down") return snap.downLevels[level] ?? false;
  return false;
}

function failureSideForRow(row: NineFifteenCandleRow, side: "CE" | "PE" | "MIXED"): "CE" | "PE" {
  if (side === "CE") return "CE";
  if (side === "PE") return "PE";
  return row.direction === "down" ? "PE" : "CE";
}

function entryIndexPrice(row: NineFifteenCandleRow): number | null {
  const px = row.entryAtLive916?.indexPrice;
  return px !== undefined && Number.isFinite(px) ? px : null;
}

function maxMoveInDirectionFromSession(row: NineFifteenCandleRow, tradeSide: "CE" | "PE"): number {
  const high = row.sessionHighAfter916 ?? row.sessionHigh;
  const low = row.sessionLowAfter916 ?? row.sessionLow;
  const entry = entryIndexPrice(row) ?? row.open;
  return tradeSide === "CE" ? Math.max(0, high - entry) : Math.max(0, entry - low);
}

function targetHitForRow(
  row: NineFifteenCandleRow,
  targetPoints: number,
  tradeSide: "CE" | "PE",
  points: IndexPoints,
): NineFifteenTargetHit | null {
  if (!isEntryBasedFollowTarget(targetPoints, points)) return null;
  if (targetPoints === points.nearMissTarget) {
    const up = row.switch20Then10After1001Up;
    const down = row.switch20Then10After1001Down;
    return tradeSide === "CE" ? (up ?? null) : (down ?? null);
  }
  const up = row.tiered25Then20Then15Up ?? row.firstHitUp25;
  const down = row.tiered25Then20Then15Down ?? row.firstHitDown25;
  return tradeSide === "CE" ? (up ?? null) : (down ?? null);
}

function nearMissSwitchHit(row: NineFifteenCandleRow, tradeSide: "CE" | "PE"): boolean {
  const hit =
    tradeSide === "CE" ? row.switch20Then10After1001Up : row.switch20Then10After1001Down;
  return hit != null;
}

function mainTieredIndexHit(row: NineFifteenCandleRow, tradeSide: "CE" | "PE"): boolean {
  const hit =
    tradeSide === "CE" ? row.tiered25Then20Then15Up : row.tiered25Then20Then15Down;
  return hit != null;
}

function followTargetHitConfirmed(
  row: NineFifteenCandleRow,
  targetPoints: number,
  tradeSide: "CE" | "PE",
  points: IndexPoints,
): boolean {
  if (row.direction === "up" && tradeSide !== "CE") return false;
  if (row.direction === "down" && tradeSide !== "PE") return false;
  if (targetPoints === points.nearMissTarget) {
    return nearMissSwitchHit(row, tradeSide);
  }
  if (targetPoints === points.followBacktestTarget) {
    return mainTieredIndexHit(row, tradeSide);
  }
  return followDirectionHit(row, targetPoints, points);
}

function altTargetAfterTimeForSide(
  tradeSide: "CE" | "PE",
  targetAfterPoints: number,
  switchAfterIst: string,
  upHit: NineFifteenTargetHit | null | undefined,
  downHit: NineFifteenTargetHit | null | undefined,
  points: IndexPoints,
): NineFifteenCePeFailureTrade["altTargetAfter1010"] {
  const switchHit = tradeSide === "CE" ? (upHit ?? null) : (downHit ?? null);
  return {
    targetBeforePoints: points.backtestTarget25,
    targetAfterPoints,
    switchAfterIst,
    wouldWin: switchHit != null,
    hit: switchHit,
  };
}

function buildTradeDayDetail(
  row: NineFifteenCandleRow,
  targetPoints: number,
  side: "CE" | "PE" | "MIXED",
  points: IndexPoints,
): NineFifteenCePeFailureTrade {
  const tradeSide = failureSideForRow(row, side);
  const targetHit = targetHitForRow(row, targetPoints, tradeSide, points);
  const entryPx = entryIndexPrice(row);
  const exitTargetIndexPrice =
    entryPx !== null && isEntryBasedFollowTarget(targetPoints, points)
      ? tradeSide === "CE"
        ? entryPx + targetPoints
        : entryPx - targetPoints
      : null;
  const win = isEntryBasedFollowTarget(targetPoints, points)
    ? followTargetHitConfirmed(row, targetPoints, tradeSide, points)
    : followDirectionHit(row, targetPoints, points);

  const mfe =
    tradeSide === "CE" ? row.maxFavorableCeAfterEntry : row.maxFavorablePeAfterEntry;
  const maxMoveInDirection =
    mfe?.movePts ?? maxMoveInDirectionFromSession(row, tradeSide);

  let altTargetAfter1010: NineFifteenCePeFailureTrade["altTargetAfter1010"] = null;
  let altTarget10After1010: NineFifteenCePeFailureTrade["altTarget10After1010"] = null;
  if (targetPoints === points.backtestTarget25 && !win) {
    // Diagnostic only: two-phase alts vs full tiered primary (±25→±20@10:01→±15@11:01).
    altTargetAfter1010 = altTargetAfterTimeForSide(
      tradeSide,
      points.indexTarget20,
      "10:01:00",
      row.switch25Then20After1010Up,
      row.switch25Then20After1010Down,
      points,
    );
    altTarget10After1010 = altTargetAfterTimeForSide(
      tradeSide,
      points.indexTarget15,
      "11:01:00",
      row.switch25Then15After1101Up,
      row.switch25Then15After1101Down,
      points,
    );
  }

  const targetGapAt1000 =
    entryPx != null
      ? computeTargetGapAt1000(entryPx, row.indexOpenAt1000, tradeSide, targetPoints)
      : null;

  return {
    date: row.date,
    side: tradeSide,
    direction: row.direction,
    open915: row.open,
    close915: row.close,
    change: row.change,
    prevDayClose: row.prevDayClose ?? null,
    gapFromPrevClose: row.gapFromPrevClose ?? null,
    gapFromPrevCloseDirection: row.gapFromPrevCloseDirection ?? null,
    maxMoveInDirection,
    maxMovePeakAt: mfe?.timeIst ?? null,
    maxMovePeakIndex: mfe?.indexPrice ?? null,
    targetPoints,
    entryAt: row.entryAtLive916 ?? null,
    targetHit,
    targetHitAt: targetHit?.timeIst ?? null,
    exitTargetIndexPrice,
    winConfirmed: win,
    altTargetAfter1010,
    altTarget10After1010,
    rsi915: row.rsi915 ?? null,
    rsi916: row.rsi916 ?? null,
    targetGapAt1000,
  };
}

function strategyStats(
  label: string,
  allRows: NineFifteenCandleRow[],
  tradeRows: NineFifteenCandleRow[],
  side: "CE" | "PE" | "MIXED",
  hitMode: HitMode,
  targetPoints: number,
  points: IndexPoints,
  collectSuccesses = false,
): NineFifteenCePeStrategyStats {
  const sampleDays = allRows.length;
  const tradeDays = tradeRows.length;
  const hitRow = (row: NineFifteenCandleRow) => {
    if (hitMode === "follow" && isEntryBasedFollowTarget(targetPoints, points)) {
      return followTargetHitConfirmed(row, targetPoints, failureSideForRow(row, side), points);
    }
    if (hitMode === "up") return dayUpHit(row, targetPoints);
    if (hitMode === "down") return dayDownHit(row, targetPoints);
    if (row.direction === "up") return dayUpHit(row, targetPoints);
    if (row.direction === "down") return dayDownHit(row, targetPoints);
    return false;
  };
  const targetHits = tradeRows.filter(hitRow).length;
  const failures = tradeRows
    .filter((row) => !hitRow(row))
    .map((row) => buildTradeDayDetail(row, targetPoints, side, points))
    .sort((a, b) => b.date.localeCompare(a.date));

  const successes = collectSuccesses
    ? tradeRows
        .filter((row) => hitRow(row))
        .map((row) => buildTradeDayDetail(row, targetPoints, side, points))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = tradeRows.filter((row) => checkpointHit(row, cp, targetPoints, hitMode, points))
      .length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label,
    side,
    sampleDays,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    failures,
    successes,
  };
}

function todayIstDateKey(): string {
  return istDateKey(new Date());
}

function dayUpHit(row: NineFifteenCandleRow, level: number): boolean {
  const high = row.sessionHighAfter916 ?? row.sessionHigh;
  return high >= row.open + level;
}

function dayDownHit(row: NineFifteenCandleRow, level: number): boolean {
  const low = row.sessionLowAfter916 ?? row.sessionLow;
  return low <= row.open - level;
}

function dayUpHitFromEntry(row: NineFifteenCandleRow, level: number): boolean {
  const entry = entryIndexPrice(row);
  if (entry === null) return false;
  const high = row.sessionHighAfter916 ?? row.sessionHigh;
  return high >= entry + level;
}

function dayDownHitFromEntry(row: NineFifteenCandleRow, level: number): boolean {
  const entry = entryIndexPrice(row);
  if (entry === null) return false;
  const low = row.sessionLowAfter916 ?? row.sessionLow;
  return low <= entry - level;
}

function followDirectionHit(
  row: NineFifteenCandleRow,
  targetPoints: number,
  points: IndexPoints,
): boolean {
  if (isEntryBasedFollowTarget(targetPoints, points)) {
    if (row.direction === "up") return dayUpHitFromEntry(row, targetPoints);
    if (row.direction === "down") return dayDownHitFromEntry(row, targetPoints);
    return false;
  }
  if (row.direction === "up") return dayUpHit(row, targetPoints);
  if (row.direction === "down") return dayDownHit(row, targetPoints);
  return false;
}

export function computeFollowFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  targetPoints = points.followBacktestTarget,
  minAbsDiff = points.followMinAbsDiff,
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const filtered = followRows.filter((row) => Math.abs(row.change) >= minAbsDiff);
  const wins = filtered.filter((row) => {
    const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
    return followTargetHitConfirmed(row, targetPoints, tradeSide, points);
  }).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff,
    targetPoints,
    totalFollowTrades: followRows.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: followRows.length - filtered.length,
  };
}

function followTakenRows(rows: NineFifteenCandleRow[], minAbsDiff: number): NineFifteenCandleRow[] {
  return rows.filter(
    (row) =>
      (row.direction === "up" || row.direction === "down") && Math.abs(row.change) >= minAbsDiff,
  );
}

/** Directional days with minAbs ≤ |9:15 Δ| < maxAbs (exclusive). */
function followBandTakenRows(
  rows: NineFifteenCandleRow[],
  minAbsDiff: number,
  maxAbsDiffExclusive: number,
): NineFifteenCandleRow[] {
  return rows.filter((row) => {
    if (row.direction !== "up" && row.direction !== "down") return false;
    const abs = Math.abs(row.change);
    return abs >= minAbsDiff && abs < maxAbsDiffExclusive;
  });
}

export function computeFollowBandFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  targetPoints = points.nearMissTarget,
  minAbsDiff = points.nearMissMinAbsDiff,
  maxAbsDiffExclusive = points.nearMissMaxAbsDiff,
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const filtered = followBandTakenRows(rows, minAbsDiff, maxAbsDiffExclusive);
  const wins = filtered.filter((row) => {
    const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
    return followTargetHitConfirmed(row, targetPoints, tradeSide, points);
  }).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff,
    maxAbsDiffExclusive,
    targetPoints,
    totalFollowTrades: followRows.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: followRows.length - filtered.length,
  };
}

/** Live dual-band: |Δ| ≥ 15 → main exits; 11 ≤ |Δ| < 15 → near-miss exits. */
function liveExitModeForRow(
  row: NineFifteenCandleRow,
  points: IndexPoints,
): "main" | "near_miss" | null {
  if (row.direction !== "up" && row.direction !== "down") return null;
  const abs = Math.abs(row.change);
  if (abs >= points.followMinAbsDiff) return "main";
  if (abs >= points.nearMissMinAbsDiff) return "near_miss";
  return null;
}

type ConsolidatedExitVariant =
  | "default"
  | "tighter"
  | "flat50_40"
  | "flat40_30"
  | "flat30_20";

function consolidatedFlatHitForRow(
  row: NineFifteenCandleRow,
  tradeSide: "CE" | "PE",
  level: 50 | 40 | 30 | 20,
): NineFifteenTargetHit | null {
  const up =
    level === 50
      ? row.consolidatedFlat50Up
      : level === 40
        ? row.consolidatedFlat40Up
        : level === 30
          ? row.consolidatedFlat30Up
          : row.consolidatedFlat20Up;
  const down =
    level === 50
      ? row.consolidatedFlat50Down
      : level === 40
        ? row.consolidatedFlat40Down
        : level === 30
          ? row.consolidatedFlat30Down
          : row.consolidatedFlat20Down;
  return tradeSide === "CE" ? (up ?? null) : (down ?? null);
}

function flatTargetsForVariant(
  variant: "flat50_40" | "flat40_30" | "flat30_20",
  points: IndexPoints,
): { main: number; near: number; mainLevel: 50 | 40 | 30; nearLevel: 40 | 30 | 20 } {
  if (variant === "flat50_40") {
    return {
      main: points.consolidatedFlat50,
      near: points.consolidatedFlat40,
      mainLevel: 50,
      nearLevel: 40,
    };
  }
  if (variant === "flat40_30") {
    return {
      main: points.consolidatedFlat40,
      near: points.consolidatedFlat30,
      mainLevel: 40,
      nearLevel: 30,
    };
  }
  return {
    main: points.consolidatedFlat30,
    near: points.consolidatedFlat20,
    mainLevel: 30,
    nearLevel: 20,
  };
}

function formatPtsLabel(pts: number): string {
  const rounded = Math.round(pts * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function consolidatedMainHitForRow(
  row: NineFifteenCandleRow,
  tradeSide: "CE" | "PE",
  variant: ConsolidatedExitVariant,
): NineFifteenTargetHit | null {
  if (variant === "flat50_40") return consolidatedFlatHitForRow(row, tradeSide, 50);
  if (variant === "flat40_30") return consolidatedFlatHitForRow(row, tradeSide, 40);
  if (variant === "flat30_20") return consolidatedFlatHitForRow(row, tradeSide, 30);
  if (variant === "tighter") {
    return tradeSide === "CE"
      ? (row.tieredConsolidatedAltMainUp ?? null)
      : (row.tieredConsolidatedAltMainDown ?? null);
  }
  return tradeSide === "CE"
    ? (row.tiered25Then20Then15Up ?? null)
    : (row.tiered25Then20Then15Down ?? null);
}

function consolidatedNearHitForRow(
  row: NineFifteenCandleRow,
  tradeSide: "CE" | "PE",
  variant: ConsolidatedExitVariant,
): NineFifteenTargetHit | null {
  if (variant === "flat50_40") return consolidatedFlatHitForRow(row, tradeSide, 40);
  if (variant === "flat40_30") return consolidatedFlatHitForRow(row, tradeSide, 30);
  if (variant === "flat30_20") return consolidatedFlatHitForRow(row, tradeSide, 20);
  if (variant === "tighter") {
    return tradeSide === "CE"
      ? (row.switchConsolidatedAltNearUp ?? null)
      : (row.switchConsolidatedAltNearDown ?? null);
  }
  return tradeSide === "CE"
    ? (row.switch20Then10After1001Up ?? null)
    : (row.switch20Then10After1001Down ?? null);
}

function consolidatedTargetHitForRow(
  row: NineFifteenCandleRow,
  band: "main" | "near_miss",
  tradeSide: "CE" | "PE",
  variant: ConsolidatedExitVariant,
  profile: IndexProfile,
): NineFifteenTargetHit | null {
  if (isExpiryWeekday(row.date, profile)) return row.breakoutTuesdayTargetHit ?? null;
  return band === "main"
    ? consolidatedMainHitForRow(row, tradeSide, variant)
    : consolidatedNearHitForRow(row, tradeSide, variant);
}

function consolidatedDisplayTargetForBand(
  dateKey: string,
  band: "main" | "near_miss",
  variant: ConsolidatedExitVariant,
  points: IndexPoints,
  profile: IndexProfile,
): number {
  if (isExpiryWeekday(dateKey, profile)) return points.breakoutExpiryDayTarget;
  if (variant === "flat50_40" || variant === "flat40_30" || variant === "flat30_20") {
    const flat = flatTargetsForVariant(variant, points);
    return band === "main" ? flat.main : flat.near;
  }
  if (band === "near_miss") {
    return variant === "tighter" ? points.consolidatedAltNear1 : points.nearMissTarget;
  }
  return variant === "tighter" ? points.consolidatedAltMain1 : points.followBacktestTarget;
}

function liveConsolidatedBandRows(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
): NineFifteenCandleRow[] {
  return rows.filter((row) => liveExitModeForRow(row, points) != null);
}

function liveConsolidatedTakenRows(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
): NineFifteenCandleRow[] {
  return liveConsolidatedBandRows(rows, points).filter(is916SameColorConfirmOpen);
}

function targetPointsForLiveMode(mode: "main" | "near_miss", points: IndexPoints): number {
  return mode === "near_miss" ? points.nearMissTarget : points.followBacktestTarget;
}

function breakoutTargetPointsForDate(
  dateKey: string,
  band: "main" | "near_miss",
  points: IndexPoints,
  profile: IndexProfile,
): number {
  if (isExpiryWeekday(dateKey, profile)) return points.breakoutExpiryDayTarget;
  return targetPointsForLiveMode(band, points);
}

function breakoutTargetHitForRow(
  row: NineFifteenCandleRow,
  band: "main" | "near_miss",
  side: "CE" | "PE",
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenTargetHit | null {
  if (isExpiryWeekday(row.date, profile)) return row.breakoutTuesdayTargetHit ?? null;
  return targetHitForRow(row, targetPointsForLiveMode(band, points), side, points);
}

/**
 * Breakout backtest: race the profit target against the fixed adverse stop on the same day.
 * When both levels fall inside one 1-min bar the stop wins — minute OHLC cannot tell us which
 * side was touched first, so the pessimistic read keeps the study honest.
 */
function buildBreakoutTrade(
  row: NineFifteenCandleRow,
  config: BreakoutStopConfig,
  stopHitForRow: (row: NineFifteenCandleRow) => NineFifteenTargetHit | null,
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenBreakoutTrade | null {
  const band = liveExitModeForRow(row, points);
  if (!band) return null;

  const side: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  const targetPoints = breakoutTargetPointsForDate(row.date, band, points, profile);
  const targetHit = breakoutTargetHitForRow(row, band, side, points, profile);
  const stopHit = stopHitForRow(row);
  const stopFirst =
    stopHit != null && (targetHit == null || stopHit.timeIst <= targetHit.timeIst);

  return {
    date: row.date,
    side,
    band,
    change: row.change,
    entry: row.entryAtLive916 ?? null,
    targetPoints,
    stopPoints: breakoutStopPointsForBand(band, config),
    targetHit,
    stopHit,
    closestToTarget: row.breakoutClosestToTarget ?? null,
    outcome: stopFirst ? "stop" : targetHit ? "target" : "open",
    stopActiveFromIst: formatIstHms(breakoutStopActiveFromMinsForDate(row.date, profile) * 60),
  };
}

export function buildBreakoutStats(
  rows: NineFifteenCandleRow[],
  config: BreakoutStopConfig,
  stopHitForRow: (row: NineFifteenCandleRow) => NineFifteenTargetHit | null,
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenBreakoutStats {
  const trades = rows
    .map((row) => buildBreakoutTrade(row, config, stopHitForRow, points, profile))
    .filter((trade): trade is NineFifteenBreakoutTrade => trade !== null);

  const tradeDays = trades.length;
  const wins = trades.filter((t) => t.outcome === "target").length;
  const stopped = trades.filter((t) => t.outcome === "stop").length;
  const openAtClose = trades.filter((t) => t.outcome === "open").length;
  // Baseline = the existing backtest, where a day counts as a win whenever the target was
  // ever touched, no matter how far the index went against the trade first.
  const baseWins = trades.filter((t) => t.targetHit != null).length;
  const baseLosses = tradeDays - baseWins;

  const byDateDesc = (a: NineFifteenBreakoutTrade, b: NineFifteenBreakoutTrade) =>
    b.date.localeCompare(a.date);

  return {
    label:
      `Breakout: same 9:16 entry, tiered targets (${expiryWeekdayShort(profile)} ±${points.breakoutExpiryDayTarget} flat), plus fixed stop — ` +
      `main ±${config.stopMainPoints} · near-miss ±${config.stopNearMissPoints}` +
      ` · stop active from ${formatIstHms(NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE * 60)} IST` +
      ` (${expiryWeekdayShort(profile)} ${formatIstHms(NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_TUESDAY_MINUTE * 60)} IST)`,
    stopMainPoints: config.stopMainPoints,
    stopNearMissPoints: config.stopNearMissPoints,
    stopActiveFromIst: formatIstHms(NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE * 60),
    stopActiveFromIstTuesday: formatIstHms(NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_TUESDAY_MINUTE * 60),
    sampleDays: rows.length,
    tradeDays,
    baseWins,
    baseLosses,
    baseWinPct: tradeDays > 0 ? (baseWins / tradeDays) * 100 : 0,
    wins,
    stopped,
    openAtClose,
    winPct: tradeDays > 0 ? (wins / tradeDays) * 100 : 0,
    missedWins: trades
      .filter((t) => t.outcome === "stop" && t.targetHit != null)
      .sort(byDateDesc),
    stoppedLosses: trades
      .filter((t) => t.outcome === "stop" && t.targetHit == null)
      .sort(byDateDesc),
  };
}

/**
 * Two-candle confirmation band: the 9:15 bar clears its usual band floor *and* the 9:16 bar
 * extends the move the same way past its own floor. Entry is the 9:17 open, so a day where the
 * second candle reversed — the shape behind most of the losses in the plain consolidated run —
 * never becomes a trade.
 */
function defaultConfirm918Bands(points: IndexPoints): Confirm918Bands {
  return {
    mainMinAbsDiff: points.followMinAbsDiff,
    nearMissMinAbsDiff: points.nearMissMinAbsDiff,
    nearMissMaxAbsDiff: points.nearMissMaxAbsDiff,
  };
}

function confirm918BandForRow(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  bands: Confirm918Bands,
): "main" | "near_miss" | null {
  if (row.direction !== "up" && row.direction !== "down") return null;
  if (row.entryAt918 == null) return null;
  const change916 = row.change916;
  if (change916 == null || change916 === 0) return null;
  // Both candles must point the same way.
  if (row.change > 0 !== change916 > 0) return null;

  const abs915 = Math.abs(row.change);
  const abs916 = Math.abs(change916);
  if (abs915 >= bands.mainMinAbsDiff && abs916 >= points.confirm918MainMove) return "main";
  if (
    abs915 >= bands.nearMissMinAbsDiff &&
    abs915 < bands.nearMissMaxAbsDiff &&
    abs916 >= points.confirm918NearMove
  ) {
    return "near_miss";
  }
  return null;
}

function confirm918TakenRows(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  bands: Confirm918Bands,
): NineFifteenCandleRow[] {
  return rows.filter((row) => confirm918BandForRow(row, points, bands) != null);
}

function confirm918TargetPoints(
  dateKey: string,
  band: "main" | "near_miss",
  points: IndexPoints,
  profile: IndexProfile,
): number {
  if (isExpiryWeekday(dateKey, profile)) return points.breakoutExpiryDayTarget;
  return band === "main" ? points.consolidatedAltMain1 : points.consolidatedAltNear1;
}

function confirm918HitForRow(
  row: NineFifteenCandleRow,
  band: "main" | "near_miss",
  tradeSide: "CE" | "PE",
  profile: IndexProfile,
): NineFifteenTargetHit | null {
  if (isExpiryWeekday(row.date, profile)) {
    return (tradeSide === "CE" ? row.confirm918ExpiryUp : row.confirm918ExpiryDown) ?? null;
  }
  if (band === "main") {
    return (tradeSide === "CE" ? row.confirm918MainUp : row.confirm918MainDown) ?? null;
  }
  return (tradeSide === "CE" ? row.confirm918NearUp : row.confirm918NearDown) ?? null;
}

function confirm918Hit(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
  bands: Confirm918Bands,
): boolean {
  const band = confirm918BandForRow(row, points, bands);
  if (!band) return false;
  const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  return confirm918HitForRow(row, band, tradeSide, profile) != null;
}

function buildConfirm918TradeDayDetail(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
  bands: Confirm918Bands,
): NineFifteenCePeFailureTrade {
  const band = confirm918BandForRow(row, points, bands)!;
  const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  const targetPoints = confirm918TargetPoints(row.date, band, points, profile);
  const targetHit = confirm918HitForRow(row, band, tradeSide, profile);
  const entryPx = row.entryAt918?.indexPrice ?? null;
  const mfe = tradeSide === "CE" ? row.maxFavorableCeAfter918 : row.maxFavorablePeAfter918;

  return {
    date: row.date,
    side: tradeSide,
    direction: row.direction,
    open915: row.open,
    close915: row.close,
    change: row.change,
    prevDayClose: row.prevDayClose ?? null,
    gapFromPrevClose: row.gapFromPrevClose ?? null,
    gapFromPrevCloseDirection: row.gapFromPrevCloseDirection ?? null,
    maxMoveInDirection: mfe?.movePts ?? 0,
    maxMovePeakAt: mfe?.timeIst ?? null,
    maxMovePeakIndex: mfe?.indexPrice ?? null,
    targetPoints,
    entryAt: row.entryAt918 ?? null,
    targetHitAt: targetHit?.timeIst ?? null,
    targetHit,
    exitTargetIndexPrice:
      entryPx != null
        ? tradeSide === "CE"
          ? entryPx + targetPoints
          : entryPx - targetPoints
        : null,
    winConfirmed: targetHit != null,
    rsi915: row.rsi915 ?? null,
    rsi916: row.rsi916 ?? null,
  };
}

function confirm918Label(points: IndexPoints, profile: IndexProfile, bands: Confirm918Bands): string {
  const m1 = formatPtsLabel(points.consolidatedAltMain1);
  const m2 = formatPtsLabel(points.consolidatedAltMain2);
  const m3 = formatPtsLabel(points.consolidatedAltMain3);
  const n1 = formatPtsLabel(points.consolidatedAltNear1);
  const n2 = formatPtsLabel(points.consolidatedAltNear2);
  return (
    `9:17 entry (two-candle confirm): 9:15 |Δ| ≥ ${formatPtsLabel(bands.mainMinAbsDiff)} + 9:16 |Δ| ≥ ${formatPtsLabel(points.confirm918MainMove)} → main ±${m1}→±${m2}@10:01→±${m3}@11:01 · ` +
    `9:15 ${formatPtsLabel(bands.nearMissMinAbsDiff)}–${formatPtsLabel(bands.nearMissMaxAbsDiff)} + 9:16 |Δ| ≥ ${formatPtsLabel(points.confirm918NearMove)} → near-miss ±${n1}→±${n2}@10:01 · ` +
    `${expiryWeekdayShort(profile)} ±${formatPtsLabel(points.breakoutExpiryDayTarget)} flat · UP→CE, DOWN→PE`
  );
}

export function buildConfirm918FollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  bands: Confirm918Bands = defaultConfirm918Bands(points),
): NineFifteenCePeStrategyStats {
  const taken = confirm918TakenRows(rows, points, bands);
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => confirm918Hit(row, points, profile, bands))
    .map((row) => buildConfirm918TradeDayDetail(row, points, profile, bands))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !confirm918Hit(row, points, profile, bands))
    .map((row) => buildConfirm918TradeDayDetail(row, points, profile, bands))
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) => {
      const band = confirm918BandForRow(row, points, bands);
      if (!band) return false;
      return checkpointHit(
        row,
        cp,
        confirm918TargetPoints(row.date, band, points, profile),
        "follow",
        points,
      );
    }).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label: confirm918Label(points, profile, bands),
    side: "MIXED",
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    successes,
    failures,
  };
}

export function computeConfirm918FilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  bands: Confirm918Bands = defaultConfirm918Bands(points),
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const taken = confirm918TakenRows(rows, points, bands);
  const wins = taken.filter((row) => confirm918Hit(row, points, profile, bands)).length;
  const filteredTrades = taken.length;
  return {
    minAbsDiff: bands.nearMissMinAbsDiff,
    maxAbsDiffExclusive: bands.nearMissMaxAbsDiff,
    targetPoints: points.consolidatedAltMain1,
    totalFollowTrades: followRows.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: followRows.length - filteredTrades,
    display: {
      filterTitle: confirm918Label(points, profile, bands),
      takenLabel: "Trades taken (both candles confirmed)",
      skippedLabel: "Skipped (9:15 too small or 9:16 did not confirm)",
    },
  };
}

interface NiftyConfirm917Bands {
  main915: number;
  main916: number;
}

const NIFTY_CONFIRM917_BANDS_30: NiftyConfirm917Bands = {
  main915: NIFTY_CONFIRM917_MAIN915,
  main916: NIFTY_CONFIRM917_MAIN916,
};

function niftyConfirm917Qualifies(row: NineFifteenCandleRow, bands: NiftyConfirm917Bands): boolean {
  if (row.direction !== "up" && row.direction !== "down") return false;
  if (row.entryAt918 == null) return false;
  const change916 = row.change916;
  if (change916 == null || change916 === 0) return false;
  if (row.change > 0 !== change916 > 0) return false;
  return Math.abs(row.change) > bands.main915 && Math.abs(change916) > bands.main916;
}

function niftyConfirm917TakenRows(
  rows: NineFifteenCandleRow[],
  bands: NiftyConfirm917Bands,
): NineFifteenCandleRow[] {
  return rows.filter((row) => niftyConfirm917Qualifies(row, bands));
}

function niftyConfirm917HitForRow(
  row: NineFifteenCandleRow,
  tradeSide: "CE" | "PE",
): NineFifteenTargetHit | null {
  return tradeSide === "CE" ? (row.niftyConfirm917Up ?? null) : (row.niftyConfirm917Down ?? null);
}

function niftyConfirm917Hit(row: NineFifteenCandleRow, bands: NiftyConfirm917Bands): boolean {
  if (!niftyConfirm917Qualifies(row, bands)) return false;
  const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  return niftyConfirm917HitForRow(row, tradeSide) != null;
}

function niftyConfirm917Label(bands: NiftyConfirm917Bands): string {
  return (
    `9:17 entry (two-candle confirm): 9:15 |Δ| > ${bands.main915} + 9:16 |Δ| > ${bands.main916} → ` +
    `±${NIFTY_CONFIRM917_EXIT_T1} until 10:01 → ±${NIFTY_CONFIRM917_EXIT_T2}@10:02–11:01 → ±${NIFTY_CONFIRM917_EXIT_T3}@11:02+ · UP→CE, DOWN→PE`
  );
}

function buildNiftyConfirm917TradeDayDetail(row: NineFifteenCandleRow): NineFifteenCePeFailureTrade {
  const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  const targetHit = niftyConfirm917HitForRow(row, tradeSide);
  const entryPx = row.entryAt918?.indexPrice ?? null;
  const mfe = tradeSide === "CE" ? row.maxFavorableCeAfter918 : row.maxFavorablePeAfter918;

  return {
    date: row.date,
    side: tradeSide,
    direction: row.direction,
    open915: row.open,
    close915: row.close,
    change: row.change,
    prevDayClose: row.prevDayClose ?? null,
    gapFromPrevClose: row.gapFromPrevClose ?? null,
    gapFromPrevCloseDirection: row.gapFromPrevCloseDirection ?? null,
    maxMoveInDirection: mfe?.movePts ?? 0,
    maxMovePeakAt: mfe?.timeIst ?? null,
    maxMovePeakIndex: mfe?.indexPrice ?? null,
    targetPoints: NIFTY_CONFIRM917_EXIT_T1,
    entryAt: row.entryAt918 ?? null,
    targetHitAt: targetHit?.timeIst ?? null,
    targetHit,
    exitTargetIndexPrice:
      entryPx != null
        ? tradeSide === "CE"
          ? entryPx + NIFTY_CONFIRM917_EXIT_T1
          : entryPx - NIFTY_CONFIRM917_EXIT_T1
        : null,
    winConfirmed: targetHit != null,
    rsi915: row.rsi915 ?? null,
    rsi916: row.rsi916 ?? null,
  };
}

export function buildNiftyConfirm917FollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  bands: NiftyConfirm917Bands = NIFTY_CONFIRM917_BANDS_30,
): NineFifteenCePeStrategyStats {
  const taken = niftyConfirm917TakenRows(rows, bands);
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => niftyConfirm917Hit(row, bands))
    .map((row) => buildNiftyConfirm917TradeDayDetail(row))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !niftyConfirm917Hit(row, bands))
    .map((row) => buildNiftyConfirm917TradeDayDetail(row))
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) =>
      checkpointHit(row, cp, NIFTY_CONFIRM917_EXIT_T1, "follow", points),
    ).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label: niftyConfirm917Label(bands),
    side: "MIXED",
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    successes,
    failures,
  };
}

export function computeNiftyConfirm917FilterStats(
  rows: NineFifteenCandleRow[],
  bands: NiftyConfirm917Bands = NIFTY_CONFIRM917_BANDS_30,
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const taken = niftyConfirm917TakenRows(rows, bands);
  const wins = taken.filter((row) => niftyConfirm917Hit(row, bands)).length;
  const filteredTrades = taken.length;
  return {
    minAbsDiff: bands.main915,
    targetPoints: NIFTY_CONFIRM917_EXIT_T1,
    totalFollowTrades: followRows.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: followRows.length - filteredTrades,
    display: {
      filterTitle: niftyConfirm917Label(bands),
      takenLabel: "Trades taken (both candles confirmed)",
      skippedLabel: "Skipped (9:15 too small or 9:16 did not confirm)",
    },
  };
}

function custom60TargetHitForRow(
  row: NineFifteenCandleRow,
  band: "main" | "near_miss",
  tradeSide: "CE" | "PE",
  profile: IndexProfile,
): NineFifteenTargetHit | null {
  if (isExpiryWeekday(row.date, profile)) return row.breakoutTuesdayTargetHit ?? null;
  if (band === "main") {
    return tradeSide === "CE" ? (row.custom60MainUp ?? null) : (row.custom60MainDown ?? null);
  }
  return tradeSide === "CE" ? (row.custom60NearUp ?? null) : (row.custom60NearDown ?? null);
}

function custom60StopHitForRow(row: NineFifteenCandleRow, tradeSide: "CE" | "PE"): NineFifteenTargetHit | null {
  return tradeSide === "CE" ? (row.custom60StopCe ?? null) : (row.custom60StopPe ?? null);
}

/** Target must print before the 12:01+ hard stop — on the same bar the stop wins. */
function custom60ConsolidatedHit(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
): boolean {
  const mode = liveExitModeForRow(row, points);
  if (!mode) return false;
  const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  const targetHit = custom60TargetHitForRow(row, mode, tradeSide, profile);
  const stopHit = custom60StopHitForRow(row, tradeSide);
  if (targetHit == null) return false;
  if (stopHit == null) return true;
  return stopHit.timeIst > targetHit.timeIst;
}

function custom60DisplayTargetForBand(
  dateKey: string,
  band: "main" | "near_miss",
  points: IndexPoints,
  profile: IndexProfile,
): number {
  if (isExpiryWeekday(dateKey, profile)) return points.breakoutExpiryDayTarget;
  return band === "main" ? points.consolCustomMain1 : points.consolCustomNear1;
}

function custom60FilterTitle(points: IndexPoints, profile: IndexProfile): string {
  const expiry = expiryWeekdayShort(profile);
  const expiryFlat = formatPtsLabel(points.breakoutExpiryDayTarget);
  const m1 = formatPtsLabel(points.consolCustomMain1);
  const m2 = formatPtsLabel(points.consolCustomMain2);
  const m3 = formatPtsLabel(points.consolCustomMain3);
  const n1 = formatPtsLabel(points.consolCustomNear1);
  const n2 = formatPtsLabel(points.consolCustomNear2);
  const stop = formatPtsLabel(points.consolCustomHardStop);
  return (
    `Live bot (consolidated · ±60/40/30 + ${stop} stop): |Δ| ≥ ${points.followMinAbsDiff} · main ±${m1}→±${m2}@10:02→±${m3}@12:02 · ` +
    `${points.nearMissMinAbsDiff} ≤ |Δ| < ${points.nearMissMaxAbsDiff} · near-miss ±${n1}→±${n2}@10:02 · ` +
    `${expiry} ±${expiryFlat} flat · hard stop −${stop} from 12:01 · UP→CE, DOWN→PE`
  );
}

function buildCustom60ConsolidatedTradeDayDetail(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenCePeFailureTrade {
  const mode = liveExitModeForRow(row, points)!;
  const targetPoints = custom60DisplayTargetForBand(row.date, mode, points, profile);
  const tradeSide = failureSideForRow(row, "MIXED");
  const targetHit = custom60TargetHitForRow(row, mode, tradeSide, profile);
  const entryPx = entryIndexPrice(row);
  const base = buildTradeDayDetail(row, targetPoints, "MIXED", points);
  const win = custom60ConsolidatedHit(row, points, profile);
  return {
    ...base,
    targetPoints,
    targetHit,
    targetHitAt: targetHit?.timeIst ?? null,
    exitTargetIndexPrice:
      entryPx != null
        ? tradeSide === "CE"
          ? entryPx + targetPoints
          : entryPx - targetPoints
        : null,
    winConfirmed: win,
  };
}

export function buildCustom60ConsolidatedFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenCePeStrategyStats {
  const taken = liveConsolidatedTakenRows(rows, points);
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => custom60ConsolidatedHit(row, points, profile))
    .map((row) => buildCustom60ConsolidatedTradeDayDetail(row, points, profile))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !custom60ConsolidatedHit(row, points, profile))
    .map((row) => buildCustom60ConsolidatedTradeDayDetail(row, points, profile))
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) => {
      const mode = liveExitModeForRow(row, points);
      if (!mode) return false;
      return checkpointHit(
        row,
        cp,
        custom60DisplayTargetForBand(row.date, mode, points, profile),
        "follow",
        points,
      );
    }).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label: custom60FilterTitle(points, profile),
    side: "MIXED",
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    successes,
    failures,
  };
}

export function computeCustom60ConsolidatedFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const filtered = liveConsolidatedTakenRows(rows, points);
  const wins = filtered.filter((row) => custom60ConsolidatedHit(row, points, profile)).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: points.liveMinAbsDiff,
    targetPoints: points.consolCustomMain1,
    totalFollowTrades: followRows.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: followRows.length - filteredTrades,
    display: {
      filterTitle: custom60FilterTitle(points, profile),
      takenLabel: `Trades taken (|Δ| ≥ ${points.liveMinAbsDiff})`,
      skippedLabel: `Skipped (|Δ| < ${points.liveMinAbsDiff})`,
    },
  };
}

/** Directional days with 0 ≤ |9:15 Δ| < 11 (shown as 0–10.9 in the UI). */
function liveSmallBodySplitRows(
  rows: NineFifteenCandleRow[],
  _points: IndexPoints,
): NineFifteenCandleRow[] {
  return rows.filter((row) => {
    if (row.direction !== "up" && row.direction !== "down") return false;
    return smallBodySplitSide(Math.abs(row.change)) != null;
  });
}

/** 0–5.5 → PE; 5.6–10.9 → CE. */
function smallBodySplitSide(abs: number): "PE" | "CE" | null {
  if (abs < 0 || abs >= SMALL_BODY_MAX_EXCLUSIVE) return null;
  if (abs <= SMALL_BODY_PUT_MAX_INCLUSIVE) return "PE";
  if (abs >= SMALL_BODY_CE_MIN_INCLUSIVE) return "CE";
  return null;
}

function smallBodySplitHit(
  row: NineFifteenCandleRow,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): boolean {
  const side = smallBodySplitSide(Math.abs(row.change));
  if (!side) return false;
  return consolidatedTargetHitForRow(row, "main", side, variant, profile) != null;
}

function smallBodySplitCheckpointHit(
  row: NineFifteenCandleRow,
  checkpoint: NineFifteenTimeCheckpoint,
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): boolean {
  const side = smallBodySplitSide(Math.abs(row.change));
  if (!side) return false;
  const targetPoints = consolidatedDisplayTargetForBand(row.date, "main", variant, points, profile);
  const snap = row.checkpoints?.[checkpoint];
  if (!snap) return false;
  const level = (targetPoints / points.scale) as NineFifteenCePeTarget;
  return side === "CE" ? (snap.upLevels[level] ?? false) : (snap.downLevels[level] ?? false);
}

function buildSmallBodySplitTradeDayDetail(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeFailureTrade {
  const side = smallBodySplitSide(Math.abs(row.change)) ?? "PE";
  const targetPoints = consolidatedDisplayTargetForBand(row.date, "main", variant, points, profile);
  const targetHit = consolidatedTargetHitForRow(row, "main", side, variant, profile);
  const entryPx = entryIndexPrice(row);
  const base = buildTradeDayDetail(row, targetPoints, side, points);
  return {
    ...base,
    side,
    targetPoints,
    targetHit,
    targetHitAt: targetHit?.timeIst ?? null,
    exitTargetIndexPrice:
      entryPx != null ? (side === "CE" ? entryPx + targetPoints : entryPx - targetPoints) : null,
    winConfirmed: targetHit != null,
  };
}

function bucketStatsForSide(
  taken: NineFifteenCandleRow[],
  side: "PE" | "CE",
  rangeLabel: string,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant,
): NineFifteenSmallBodySplitBucketStats {
  const rows = taken.filter((row) => smallBodySplitSide(Math.abs(row.change)) === side);
  const wins = rows.filter((row) => smallBodySplitHit(row, profile, variant)).length;
  const trades = rows.length;
  return {
    rangeLabel,
    side,
    trades,
    wins,
    losses: trades - wins,
    winPct: trades > 0 ? (wins / trades) * 100 : 0,
  };
}

export function buildLiveSmallBodySplitBuckets(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenSmallBodySplitBuckets {
  const taken = liveSmallBodySplitRows(rows, points);
  return {
    put: bucketStatsForSide(
      taken,
      "PE",
      `0–${SMALL_BODY_PUT_MAX_INCLUSIVE}`,
      profile,
      variant,
    ),
    call: bucketStatsForSide(
      taken,
      "CE",
      `${SMALL_BODY_CE_MIN_INCLUSIVE}–10.9`,
      profile,
      variant,
    ),
  };
}

export function buildLiveSmallBodyPutFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeStrategyStats {
  const taken = liveSmallBodySplitRows(rows, points);
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => smallBodySplitHit(row, profile, variant))
    .map((row) => buildSmallBodySplitTradeDayDetail(row, points, profile, variant))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !smallBodySplitHit(row, profile, variant))
    .map((row) => buildSmallBodySplitTradeDayDetail(row, points, profile, variant))
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) =>
      smallBodySplitCheckpointHit(row, cp, points, profile, variant),
    ).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  const expiry = expiryWeekdayShort(profile);
  const label =
    `Small 9:15 body (0–10.9): |Δ|≤${SMALL_BODY_PUT_MAX_INCLUSIVE} → PE · ` +
    `${SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 → CE @ 9:16 · main-band exits ` +
    `(±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01 · ${expiry} ±${points.breakoutExpiryDayTarget} flat)`;

  return {
    label,
    side: "MIXED",
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    failures,
    successes,
  };
}

export function computeLiveSmallBodyPutFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenFollowFilterStats {
  const eligible = liveSmallBodySplitRows(rows, points);
  const filteredTrades = eligible.length;
  const wins = eligible.filter((row) => smallBodySplitHit(row, profile, variant)).length;
  return {
    minAbsDiff: 0,
    maxAbsDiffExclusive: points.nearMissMinAbsDiff,
    targetPoints: points.followBacktestTarget,
    totalFollowTrades: filteredTrades,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: 0,
    display: {
      filterTitle:
        `Small-body split: 0–${SMALL_BODY_PUT_MAX_INCLUSIVE} PE · ${SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 CE @ 9:16`,
      takenLabel: `Entries (0–10.9 |Δ|)`,
      skippedLabel: "—",
    },
  };
}

function smallBodyDirectionSide(row: NineFifteenCandleRow): "PE" | "CE" | null {
  const abs = Math.abs(row.change);
  if (abs < 0 || abs >= SMALL_BODY_MAX_EXCLUSIVE) return null;
  if (row.direction === "up") return "CE";
  if (row.direction === "down") return "PE";
  return null;
}

function liveSmallBodyDirectionRows(
  rows: NineFifteenCandleRow[],
  _points: IndexPoints,
): NineFifteenCandleRow[] {
  return rows.filter((row) => smallBodyDirectionSide(row) != null);
}

function smallBodyDirectionHit(
  row: NineFifteenCandleRow,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): boolean {
  const side = smallBodyDirectionSide(row);
  if (!side) return false;
  return consolidatedTargetHitForRow(row, "main", side, variant, profile) != null;
}

function buildSmallBodyDirectionTradeDayDetail(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeFailureTrade {
  const side = smallBodyDirectionSide(row) ?? "PE";
  const targetPoints = consolidatedDisplayTargetForBand(row.date, "main", variant, points, profile);
  const targetHit = consolidatedTargetHitForRow(row, "main", side, variant, profile);
  const entryPx = entryIndexPrice(row);
  const base = buildTradeDayDetail(row, targetPoints, side, points);
  return {
    ...base,
    side,
    targetPoints,
    targetHit,
    targetHitAt: targetHit?.timeIst ?? null,
    exitTargetIndexPrice:
      entryPx != null ? (side === "CE" ? entryPx + targetPoints : entryPx - targetPoints) : null,
    winConfirmed: targetHit != null,
  };
}

export function buildLiveSmallBodyDirectionFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeStrategyStats {
  const taken = liveSmallBodyDirectionRows(rows, points);
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => smallBodyDirectionHit(row, profile, variant))
    .map((row) => buildSmallBodyDirectionTradeDayDetail(row, points, profile, variant))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !smallBodyDirectionHit(row, profile, variant))
    .map((row) => buildSmallBodyDirectionTradeDayDetail(row, points, profile, variant))
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) => {
      const side = smallBodyDirectionSide(row);
      if (!side) return false;
      const targetPoints = consolidatedDisplayTargetForBand(row.date, "main", variant, points, profile);
      const snap = row.checkpoints?.[cp];
      if (!snap) return false;
      const level = (targetPoints / points.scale) as NineFifteenCePeTarget;
      return side === "CE" ? (snap.upLevels[level] ?? false) : (snap.downLevels[level] ?? false);
    }).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  const expiry = expiryWeekdayShort(profile);
  const label =
    `Small 9:15 body (0–10.9): UP→CE · DOWN→PE @ 9:16 · main-band exits ` +
    `(±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01 · ${expiry} ±${points.breakoutExpiryDayTarget} flat)`;

  return {
    label,
    side: "MIXED",
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    failures,
    successes,
  };
}

/** Red 9:15 candle with |Δ| ≥ main threshold — PE entry @ 9:16 (main-band exits only). */
function liveRedPeMainRows(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
): NineFifteenCandleRow[] {
  return rows.filter(
    (row) => row.direction === "down" && Math.abs(row.change) >= points.followMinAbsDiff,
  );
}

function liveRedPeMainHit(
  row: NineFifteenCandleRow,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): boolean {
  return consolidatedTargetHitForRow(row, "main", "PE", variant, profile) != null;
}

function buildRedPeMainTradeDayDetail(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeFailureTrade {
  const side = "PE" as const;
  const targetPoints = consolidatedDisplayTargetForBand(row.date, "main", variant, points, profile);
  const targetHit = consolidatedTargetHitForRow(row, "main", side, variant, profile);
  const entryPx = entryIndexPrice(row);
  const base = buildTradeDayDetail(row, targetPoints, side, points);
  return {
    ...base,
    side,
    targetPoints,
    targetHit,
    targetHitAt: targetHit?.timeIst ?? null,
    exitTargetIndexPrice: entryPx != null ? entryPx - targetPoints : null,
    winConfirmed: targetHit != null,
  };
}

function buildLiveRedPeFollowStats(
  rows: NineFifteenCandleRow[],
  taken: NineFifteenCandleRow[],
  label: string,
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeStrategyStats {
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => liveRedPeMainHit(row, profile, variant))
    .map((row) => buildRedPeMainTradeDayDetail(row, points, profile, variant))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !liveRedPeMainHit(row, profile, variant))
    .map((row) => buildRedPeMainTradeDayDetail(row, points, profile, variant))
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) => {
      const targetPoints = consolidatedDisplayTargetForBand(row.date, "main", variant, points, profile);
      const snap = row.checkpoints?.[cp];
      if (!snap) return false;
      const level = (targetPoints / points.scale) as NineFifteenCePeTarget;
      return snap.downLevels[level] ?? false;
    }).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label,
    side: "PE",
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    failures,
    successes,
  };
}

export function buildLiveRedPeMainFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeStrategyStats {
  const expiry = expiryWeekdayShort(profile);
  const label =
    `Red 9:15 · |Δ|≥${points.followMinAbsDiff} → PE @ 9:16 · main-band exits ` +
    `(±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01 · ${expiry} ±${points.breakoutExpiryDayTarget} flat)`;
  return buildLiveRedPeFollowStats(
    rows,
    liveRedPeMainRows(rows, points),
    label,
    points,
    profile,
    variant,
  );
}

export function buildLiveRedPeMain916ConfirmFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
  byDate?: MinuteCandlesByDate,
): NineFifteenCePeStrategyStats {
  const taken = liveRedPe916HybridRows(rows, points);
  return buildHybrid916FollowStats(
    rows,
    taken,
    NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
    points,
    points.backtestTarget10,
    profile,
    variant,
    byDate,
  );
}

export function computeLiveRedPeMainFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenFollowFilterStats {
  const redDays = rows.filter((row) => row.direction === "down");
  const filtered = liveRedPeMainRows(rows, points);
  const wins = filtered.filter((row) => liveRedPeMainHit(row, profile, variant)).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: points.followMinAbsDiff,
    targetPoints: points.followBacktestTarget,
    totalFollowTrades: redDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: redDays.length - filteredTrades,
    display: {
      filterTitle:
        `Red 9:15 · |Δ| ≥ ${points.followMinAbsDiff} · PE @ 9:16 · main-band exits ` +
        `(±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01)`,
      takenLabel: `Trades taken (red · |Δ| ≥ ${points.followMinAbsDiff})`,
      skippedLabel: `Skipped red days (|Δ| < ${points.followMinAbsDiff})`,
    },
  };
}

export function computeLiveRedPeMain916ConfirmFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  _profile: IndexProfile,
  _variant: ConsolidatedExitVariant = "default",
): NineFifteenFollowFilterStats {
  const redDays = rows.filter((row) => row.direction === "down");
  const sizeFiltered = liveRedPeMainRows(rows, points);
  const filtered = liveRedPe916HybridRows(rows, points);
  const wins = filtered.filter((row) => hybrid916Hit(row, points.backtestTarget10, points)).length;
  const filteredTrades = filtered.length;
  const redConfirmFlat15Trades = filtered.filter(is916RedConfirmOpen).length;
  const greenGapFlat10Trades = filtered.filter(is916GreenGapAtOpen).length;
  return {
    minAbsDiff: points.followMinAbsDiff,
    targetPoints: points.followBacktestTarget,
    totalFollowTrades: redDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: redDays.length - sizeFiltered.length,
    redConfirmFlat15Trades,
    greenGapFlat10Trades,
    display: {
      filterTitle: NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
      takenLabel: `Trades taken (red · |Δ| ≥ ${points.followMinAbsDiff})`,
      skippedLabel: `Skipped red days (|Δ| < ${points.followMinAbsDiff})`,
      redConfirmLabel: `9:16 open ≤ 9:15 close (flat −${points.backtestTarget15} from 9:16)`,
      greenGapLabel: `9:16 green gap (flat −${points.backtestTarget10} from 9:16)`,
    },
  };
}

function liveRedPe916BothRedRows(rows: NineFifteenCandleRow[], points: IndexPoints): NineFifteenCandleRow[] {
  return liveRedPe916HybridRows(rows, points).filter(is916RedConfirmOpen);
}

export function buildLiveRedPeMain916BothRedFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
  byDate?: MinuteCandlesByDate,
): NineFifteenCePeStrategyStats {
  const taken = liveRedPe916BothRedRows(rows, points);
  return buildHybrid916FollowStats(
    rows,
    taken,
    NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
    points,
    points.backtestTarget10,
    profile,
    variant,
    byDate,
  );
}

export function computeLiveRedPeMain916BothRedFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  _profile: IndexProfile,
  _variant: ConsolidatedExitVariant = "default",
): NineFifteenFollowFilterStats {
  const redDays = rows.filter((row) => row.direction === "down");
  const sizeFiltered = liveRedPeMainRows(rows, points);
  const hybridAll = liveRedPe916HybridRows(rows, points);
  const filtered = liveRedPe916BothRedRows(rows, points);
  const wins = filtered.filter((row) => row.firstHitDown15 != null).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: points.followMinAbsDiff,
    targetPoints: points.backtestTarget15,
    totalFollowTrades: redDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: redDays.length - sizeFiltered.length,
    skipped916Confirm: hybridAll.length - filteredTrades,
    redConfirmFlat15Trades: filteredTrades,
    display: {
      filterTitle: NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
      takenLabel: `Trades taken (both red · |Δ| ≥ ${points.followMinAbsDiff})`,
      skippedLabel: `Skipped red days (|Δ| < ${points.followMinAbsDiff})`,
      skipped916Label: `Excluded (9:16 open > 9:15 close · green second candle)`,
      redConfirmLabel: `Both red confirm (flat −${points.backtestTarget15} from 9:16)`,
    },
  };
}

/** Green 9:15 candle with |Δ| ≥ main threshold — CE entry @ 9:16 (mirror of the red PE study). */
function liveGreenCeMainRows(rows: NineFifteenCandleRow[], points: IndexPoints): NineFifteenCandleRow[] {
  return rows.filter(
    (row) => row.direction === "up" && Math.abs(row.change) >= points.followMinAbsDiff,
  );
}

function liveGreenCe916HybridRows(rows: NineFifteenCandleRow[], points: IndexPoints): NineFifteenCandleRow[] {
  return liveGreenCeMainRows(rows, points).filter(
    (row) => is916GreenConfirmOpen(row) || is916RedGapAtOpen(row),
  );
}

function liveGreenCe916BothGreenRows(rows: NineFifteenCandleRow[], points: IndexPoints): NineFifteenCandleRow[] {
  return liveGreenCe916HybridRows(rows, points).filter(is916GreenConfirmOpen);
}

export function buildLiveGreenCeMain916ConfirmFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
  byDate?: MinuteCandlesByDate,
): NineFifteenCePeStrategyStats {
  return buildHybrid916FollowStats(
    rows,
    liveGreenCe916HybridRows(rows, points),
    NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
    points,
    points.backtestTarget10,
    profile,
    variant,
    byDate,
    "CE",
  );
}

export function computeLiveGreenCeMain916ConfirmFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
): NineFifteenFollowFilterStats {
  const greenDays = rows.filter((row) => row.direction === "up");
  const sizeFiltered = liveGreenCeMainRows(rows, points);
  const filtered = liveGreenCe916HybridRows(rows, points);
  const wins = filtered.filter((row) => hybrid916Hit(row, points.backtestTarget10, points, "CE")).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: points.followMinAbsDiff,
    targetPoints: points.followBacktestTarget,
    totalFollowTrades: greenDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: greenDays.length - sizeFiltered.length,
    redConfirmFlat15Trades: filtered.filter(is916GreenConfirmOpen).length,
    greenGapFlat10Trades: filtered.filter(is916RedGapAtOpen).length,
    display: {
      filterTitle: NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
      takenLabel: `Trades taken (green · |Δ| ≥ ${points.followMinAbsDiff})`,
      skippedLabel: `Skipped green days (|Δ| < ${points.followMinAbsDiff})`,
      redConfirmLabel: `9:16 open ≥ 9:15 close (flat +${points.backtestTarget15} from 9:16)`,
      greenGapLabel: `9:16 red gap (flat +${points.backtestTarget10} from 9:16)`,
    },
  };
}

export function buildLiveGreenCeMain916BothGreenFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
  byDate?: MinuteCandlesByDate,
): NineFifteenCePeStrategyStats {
  return buildHybrid916FollowStats(
    rows,
    liveGreenCe916BothGreenRows(rows, points),
    NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
    points,
    points.backtestTarget10,
    profile,
    variant,
    byDate,
    "CE",
  );
}

export function computeLiveGreenCeMain916BothGreenFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
): NineFifteenFollowFilterStats {
  const greenDays = rows.filter((row) => row.direction === "up");
  const sizeFiltered = liveGreenCeMainRows(rows, points);
  const hybridAll = liveGreenCe916HybridRows(rows, points);
  const filtered = liveGreenCe916BothGreenRows(rows, points);
  const wins = filtered.filter((row) => row.firstHitUp15 != null).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: points.followMinAbsDiff,
    targetPoints: points.backtestTarget15,
    totalFollowTrades: greenDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: greenDays.length - sizeFiltered.length,
    skipped916Confirm: hybridAll.length - filteredTrades,
    redConfirmFlat15Trades: filteredTrades,
    display: {
      filterTitle: NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
      takenLabel: `Trades taken (both green · |Δ| ≥ ${points.followMinAbsDiff})`,
      skippedLabel: `Skipped green days (|Δ| < ${points.followMinAbsDiff})`,
      skipped916Label: `Excluded (9:16 open < 9:15 close · red second candle)`,
      redConfirmLabel: `Both green confirm (flat +${points.backtestTarget15} from 9:16)`,
    },
  };
}

/** Red 9:15 body strictly above this many index points (open→close). */
export const LIVE_RED_PE_BODY10_MIN = 10;

/**
 * Red second-candle confirm: skip only when 9:16 gaps up above the 9:15 close (green at open).
 * Example — 9:15 close 23,960 → enter when 9:16 open ≤ 23,960; skip when open > 23,960.
 * (Requiring a fixed 0.1-pt gap filtered every day because Kite 9:16 open ≈ 9:15 close.)
 */
export function is916RedConfirmOpen(row: NineFifteenCandleRow): boolean {
  const open916 = row.entryAtLive916?.indexPrice;
  if (open916 == null || !Number.isFinite(open916)) return false;
  return open916 <= row.close + 1e-9;
}

/** Red day where 9:16 gaps up above the 9:15 close (opposite of red confirm). */
export function is916GreenGapAtOpen(row: NineFifteenCandleRow): boolean {
  const open916 = row.entryAtLive916?.indexPrice;
  if (open916 == null || !Number.isFinite(open916)) return false;
  return open916 > row.close + 1e-9;
}

/** Green day where 9:16 gaps down below the 9:15 close (opposite of green confirm). */
export function is916RedGapAtOpen(row: NineFifteenCandleRow): boolean {
  const open916 = row.entryAtLive916?.indexPrice;
  if (open916 == null || !Number.isFinite(open916)) return false;
  return open916 < row.close - 1e-9;
}

/** PE = red 9:15 hybrid (flat − exits) · CE = green 9:15 mirror (flat + exits). */
type Hybrid916Side = "PE" | "CE";

/** 9:16 open keeps the 9:15 colour — the flat backtestTarget15 tier. */
function hybrid916ConfirmOpen(row: NineFifteenCandleRow, side: Hybrid916Side): boolean {
  return side === "CE" ? is916GreenConfirmOpen(row) : is916RedConfirmOpen(row);
}

/** 9:16 open flips against the 9:15 colour — the smaller gap tier. */
function hybrid916GapAtOpen(row: NineFifteenCandleRow, side: Hybrid916Side): boolean {
  return side === "CE" ? is916RedGapAtOpen(row) : is916GreenGapAtOpen(row);
}

function liveRedPeFlatHybridRows(rows: NineFifteenCandleRow[]): NineFifteenCandleRow[] {
  return rows.filter((row) => is916RedConfirmOpen(row) || is916GreenGapAtOpen(row));
}

function firstFlatDownHitFromEntry(
  row: NineFifteenCandleRow,
  targetPoints: number,
  points: IndexPoints,
): NineFifteenTargetHit | null {
  if (targetPoints === points.backtestTarget15) return row.firstHitDown15 ?? null;
  if (targetPoints === points.backtestTarget10) return row.firstHitDown10 ?? null;
  if (targetPoints === points.backtestTarget8) return row.firstHitDown8 ?? null;
  return null;
}

function firstFlatUpHitFromEntry(
  row: NineFifteenCandleRow,
  targetPoints: number,
  points: IndexPoints,
): NineFifteenTargetHit | null {
  if (targetPoints === points.backtestTarget15) return row.firstHitUp15 ?? null;
  if (targetPoints === points.backtestTarget10) return row.firstHitUp10 ?? null;
  if (targetPoints === points.backtestTarget8) return row.firstHitUp8 ?? null;
  return null;
}

function firstFlatHitFromEntry(
  row: NineFifteenCandleRow,
  targetPoints: number,
  points: IndexPoints,
  side: Hybrid916Side,
): NineFifteenTargetHit | null {
  return side === "CE"
    ? firstFlatUpHitFromEntry(row, targetPoints, points)
    : firstFlatDownHitFromEntry(row, targetPoints, points);
}

/** Flat exit for a hybrid day: backtestTarget15 on a colour confirm, `gapTargetPoints` on a gap. */
function hybrid916TargetHit(
  row: NineFifteenCandleRow,
  gapTargetPoints: number,
  points: IndexPoints,
  side: Hybrid916Side,
): NineFifteenTargetHit | null {
  if (hybrid916ConfirmOpen(row, side)) return firstFlatHitFromEntry(row, points.backtestTarget15, points, side);
  if (hybrid916GapAtOpen(row, side)) return firstFlatHitFromEntry(row, gapTargetPoints, points, side);
  return null;
}

function liveRedPe916HybridRows(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
): NineFifteenCandleRow[] {
  return liveRedPeFlatHybridRows(liveRedPeMainRows(rows, points));
}

function hybrid916Hit(
  row: NineFifteenCandleRow,
  gapTargetPoints: number,
  points: IndexPoints,
  side: Hybrid916Side = "PE",
): boolean {
  return hybrid916TargetHit(row, gapTargetPoints, points, side) != null;
}

function addCalendarDaysIst(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00+05:30`);
  d.setDate(d.getDate() + days);
  const ist = getIstParts(d);
  return `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`;
}

/** First expiry weekday strictly after the entry session (Tue entry → next Tue). */
function nextExpiryTuesdayAfterEntry(entryDateKey: string, profile: IndexProfile): string {
  let cursor = addCalendarDaysIst(entryDateKey, 1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (formatWeekdayFromDateKey(cursor) === profile.expiryWeekday) return cursor;
    cursor = addCalendarDaysIst(cursor, 1);
  }
  return cursor;
}

function listWeekdayDatesBetween(fromDateKey: string, toDateKey: string): string[] {
  const out: string[] = [];
  let cursor = fromDateKey;
  while (cursor <= toDateKey) {
    const wd = formatWeekdayFromDateKey(cursor);
    if (wd !== "Saturday" && wd !== "Sunday") out.push(cursor);
    cursor = addCalendarDaysIst(cursor, 1);
  }
  return out;
}

function nrmlCarryScanWindow(c: MinuteCandle, isDeadlineDay: boolean): boolean {
  if (c.mins < SESSION_OPEN_MINUTES) return false;
  const end = isDeadlineDay ? NRML_CARRY_DEADLINE_MINUTES : SESSION_CLOSE_MINUTES;
  return c.mins <= end;
}

function firstHitInNrmlCarrySession(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  targetPoints: number,
  isDeadlineDay: boolean,
  side: Hybrid916Side,
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!nrmlCarryScanWindow(c, isDeadlineDay)) continue;
    if (side === "CE" && c.high >= entryPrice + targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "up");
    }
    if (side === "PE" && c.low <= entryPrice - targetPoints) {
      return makeTargetHitFromKiteBar(c, entryPrice, targetPoints, "down");
    }
  }
  return null;
}

function computeNrmlCarryOutcome(
  row: NineFifteenCandleRow,
  targetPoints: number,
  byDate: MinuteCandlesByDate,
  profile: IndexProfile,
  side: Hybrid916Side = "PE",
): NineFifteenNrmlCarryOutcome | null {
  const entryPx = entryIndexPrice(row);
  if (entryPx == null) return null;

  const deadlineDate = nextExpiryTuesdayAfterEntry(row.date, profile);
  const carryStart = addCalendarDaysIst(row.date, 1);
  if (carryStart > deadlineDate) return null;

  const dates = listWeekdayDatesBetween(carryStart, deadlineDate);
  let bestHit: (NineFifteenTargetHit & { date: string }) | null = null;
  let carryMaxMove = 0;
  let dataComplete = true;

  for (const date of dates) {
    const session = byDate.get(date);
    if (!session || session.length === 0) {
      dataComplete = false;
      continue;
    }
    const isDeadline = date === deadlineDate;
    if (!bestHit) {
      const hit = firstHitInNrmlCarrySession(entryPx, session, targetPoints, isDeadline, side);
      if (hit) bestHit = { ...hit, date };
    }
    for (const c of session) {
      if (!nrmlCarryScanWindow(c, isDeadline)) continue;
      const move = side === "CE" ? c.high - entryPx : entryPx - c.low;
      if (move > carryMaxMove) carryMaxMove = move;
    }
  }

  const deadlineLabel = `${expiryWeekdayShort(profile)} ${deadlineDate} 15:00 IST`;
  return {
    deadlineDate,
    deadlineLabel,
    wouldWin: bestHit != null,
    hit: bestHit
      ? {
          timeIst: bestHit.timeIst,
          levelLabel: bestHit.levelLabel,
          indexPrice: bestHit.indexPrice,
        }
      : null,
    hitDate: bestHit?.date ?? null,
    maxMoveInDirection: carryMaxMove,
    dataComplete,
  };
}

function flatDownTargetHitByCheckpoint(
  hit: NineFifteenTargetHit | null | undefined,
  cp: NineFifteenTimeCheckpoint,
): boolean {
  if (!hit) return false;
  const cpMinutes = TIME_CHECKPOINTS.find((t) => t.label === cp)?.minutes;
  if (cpMinutes == null) return false;
  return minutesFromIstTime(hit.timeIst) <= cpMinutes;
}

function hybrid916CheckpointHit(
  row: NineFifteenCandleRow,
  cp: NineFifteenTimeCheckpoint,
  gapTargetPoints: number,
  points: IndexPoints,
  side: Hybrid916Side,
): boolean {
  return flatDownTargetHitByCheckpoint(hybrid916TargetHit(row, gapTargetPoints, points, side), cp);
}

function buildHybrid916TradeDayDetail(
  row: NineFifteenCandleRow,
  points: IndexPoints,
  gapTargetPoints: number,
  side: Hybrid916Side,
): NineFifteenCePeFailureTrade {
  const targetPoints = hybrid916ConfirmOpen(row, side) ? points.backtestTarget15 : gapTargetPoints;
  const targetHit = hybrid916TargetHit(row, gapTargetPoints, points, side);
  const entryPx = entryIndexPrice(row);
  const base = buildTradeDayDetail(row, targetPoints, side, points);
  return {
    ...base,
    side,
    targetPoints,
    targetHit,
    targetHitAt: targetHit?.timeIst ?? null,
    exitTargetIndexPrice:
      entryPx != null ? (side === "CE" ? entryPx + targetPoints : entryPx - targetPoints) : null,
    winConfirmed: targetHit != null,
  };
}

function buildHybrid916FollowStats(
  rows: NineFifteenCandleRow[],
  taken: NineFifteenCandleRow[],
  label: string,
  points: IndexPoints,
  gapTargetPoints: number,
  profile: IndexProfile,
  _variant: ConsolidatedExitVariant = "default",
  byDate?: MinuteCandlesByDate,
  side: Hybrid916Side = "PE",
): NineFifteenCePeStrategyStats {
  const tradeDays = taken.length;
  const successes = taken
    .filter((row) => hybrid916Hit(row, gapTargetPoints, points, side))
    .map((row) => buildHybrid916TradeDayDetail(row, points, gapTargetPoints, side))
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !hybrid916Hit(row, gapTargetPoints, points, side))
    .map((row) => {
      const detail = buildHybrid916TradeDayDetail(row, points, gapTargetPoints, side);
      if (!byDate || detail.winConfirmed) return detail;
      const targetPoints = detail.targetPoints ?? points.backtestTarget15;
      const nrmlCarry = computeNrmlCarryOutcome(row, targetPoints, byDate, profile, side);
      return nrmlCarry ? { ...detail, nrmlCarry } : detail;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) => hybrid916CheckpointHit(row, cp, gapTargetPoints, points, side)).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label,
    side,
    sampleDays: rows.length,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    failures,
    successes,
  };
}

/** Green second-candle confirm: skip only when 9:16 gaps down below the 9:15 close. */
export function is916GreenConfirmOpen(row: NineFifteenCandleRow): boolean {
  const open916 = row.entryAtLive916?.indexPrice;
  if (open916 == null || !Number.isFinite(open916)) return false;
  return open916 >= row.close - 1e-9;
}

/** PE when 9:16 open ≤ 9:15 close; CE when 9:16 open ≥ 9:15 close. */
export function is916SameColorConfirmOpen(row: NineFifteenCandleRow): boolean {
  if (row.direction === "down") return is916RedConfirmOpen(row);
  if (row.direction === "up") return is916GreenConfirmOpen(row);
  return false;
}

/** Red 9:15 candle with |Δ| > 10 — PE entry @ 9:16. */
function liveRedPeBody10Rows(rows: NineFifteenCandleRow[]): NineFifteenCandleRow[] {
  return rows.filter(
    (row) => row.direction === "down" && Math.abs(row.change) > LIVE_RED_PE_BODY10_MIN,
  );
}

export function buildLiveRedPeBody10FollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeStrategyStats {
  const label =
    `Red 9:15 · |Δ|>${LIVE_RED_PE_BODY10_MIN} → PE @ 9:16 · flat −${points.backtestTarget15} (both red) · flat −${points.backtestTarget8} (green gap @ 9:16)`;
  const taken = liveRedPeFlatHybridRows(liveRedPeBody10Rows(rows));
  return buildHybrid916FollowStats(
    rows,
    taken,
    label,
    points,
    points.backtestTarget8,
    profile,
    variant,
  );
}

export function buildLiveRedPeBody10_916ConfirmFollowStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenCePeStrategyStats {
  const expiry = expiryWeekdayShort(profile);
  const label =
    `Red 9:15 · |Δ|>${LIVE_RED_PE_BODY10_MIN} · 9:16 open ≤ 9:15 close → PE @ 9:16 · main-band exits ` +
    `(±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01 · ${expiry} ±${points.breakoutExpiryDayTarget} flat)`;
  const taken = liveRedPeBody10Rows(rows).filter(is916RedConfirmOpen);
  return buildLiveRedPeFollowStats(rows, taken, label, points, profile, variant);
}

export function computeLiveRedPeBody10FilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  _profile: IndexProfile,
  _variant: ConsolidatedExitVariant = "default",
): NineFifteenFollowFilterStats {
  const redDays = rows.filter((row) => row.direction === "down");
  const sizeFiltered = liveRedPeBody10Rows(rows);
  const filtered = liveRedPeFlatHybridRows(sizeFiltered);
  const wins = filtered.filter((row) => hybrid916Hit(row, points.backtestTarget8, points)).length;
  const filteredTrades = filtered.length;
  const redConfirmFlat15Trades = filtered.filter(is916RedConfirmOpen).length;
  const greenGapFlat10Trades = filtered.filter(is916GreenGapAtOpen).length;
  return {
    minAbsDiff: LIVE_RED_PE_BODY10_MIN,
    minAbsDiffExclusive: true,
    targetPoints: points.followBacktestTarget,
    totalFollowTrades: redDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: redDays.length - sizeFiltered.length,
    redConfirmFlat15Trades,
    greenGapFlat10Trades,
    display: {
      filterTitle:
        `Red 9:15 · |Δ| > ${LIVE_RED_PE_BODY10_MIN} · PE @ 9:16 · flat −${points.backtestTarget15} (both red) · flat −${points.backtestTarget8} (green gap @ 9:16)`,
      takenLabel: `Trades taken (red · |Δ| > ${LIVE_RED_PE_BODY10_MIN})`,
      skippedLabel: `Skipped red days (|Δ| ≤ ${LIVE_RED_PE_BODY10_MIN})`,
      redConfirmLabel: `9:16 open ≤ 9:15 close (flat −${points.backtestTarget15} from 9:16)`,
      greenGapLabel: `9:16 green gap (flat −${points.backtestTarget8} from 9:16)`,
    },
  };
}

export function computeLiveRedPeBody10_916ConfirmFilterStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
  variant: ConsolidatedExitVariant = "default",
): NineFifteenFollowFilterStats {
  const redDays = rows.filter((row) => row.direction === "down");
  const sizeFiltered = liveRedPeBody10Rows(rows);
  const filtered = sizeFiltered.filter(is916RedConfirmOpen);
  const wins = filtered.filter((row) => liveRedPeMainHit(row, profile, variant)).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: LIVE_RED_PE_BODY10_MIN,
    minAbsDiffExclusive: true,
    targetPoints: points.followBacktestTarget,
    totalFollowTrades: redDays.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: redDays.length - sizeFiltered.length,
    skipped916Confirm: sizeFiltered.length - filteredTrades,
    display: {
      filterTitle:
        `Red 9:15 · |Δ| > ${LIVE_RED_PE_BODY10_MIN} · 9:16 open ≤ 9:15 close · PE @ 9:16 · main-band exits ` +
        `(±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01)`,
      takenLabel: `Trades taken (red · |Δ| > ${LIVE_RED_PE_BODY10_MIN} · 9:16 red confirm)`,
      skippedLabel: `Skipped red days (|Δ| ≤ ${LIVE_RED_PE_BODY10_MIN})`,
      skipped916Label: `Skipped (9:16 open above 9:15 close — green gap at open)`,
    },
  };
}

function buildCePeGuideForTarget(
  rows: NineFifteenCandleRow[],
  targetPoints: number,
  points: IndexPoints,
  followMinAbsDiff = points.followMinAbsDiff,
  includeTodaySignal = false,
): NineFifteenCePeGuide {
  const minuteUp = rows.filter((row) => row.direction === "up");
  const minuteDown = rows.filter((row) => row.direction === "down");
  const followTradeRows = followTakenRows(rows, followMinAbsDiff);

  const followDirection = strategyStats(
    `Follow 9:15 bar: UP→CE, DOWN→PE (|9:15 Δ| ≥ ${followMinAbsDiff}, ±${points.backtestTarget25} → ±${points.indexTarget20} @10:01 → ±${points.indexTarget15} @11:01 from 9:16 open)`,
    rows,
    followTradeRows,
    "MIXED",
    "follow",
    targetPoints,
    points,
    isEntryBasedFollowTarget(targetPoints, points),
  );
  const alwaysCall = strategyStats(
    "Buy CE every day at 9:15",
    rows,
    rows,
    "CE",
    "up",
    targetPoints,
    points,
  );
  const alwaysPut = strategyStats(
    "Buy PE every day at 9:15",
    rows,
    rows,
    "PE",
    "down",
    targetPoints,
    points,
  );
  const minuteUpBuyCall = strategyStats(
    "9:15 bar closes UP → buy CE",
    rows,
    minuteUp,
    "CE",
    "up",
    targetPoints,
    points,
  );
  const minuteDownBuyPut = strategyStats(
    "9:15 bar closes DOWN → buy PE",
    rows,
    minuteDown,
    "PE",
    "down",
    targetPoints,
    points,
  );
  const minuteUpBuyPut = strategyStats(
    "9:15 bar UP → buy PE (fade)",
    rows,
    minuteUp,
    "PE",
    "down",
    targetPoints,
    points,
  );
  const minuteDownBuyCall = strategyStats(
    "9:15 bar DOWN → buy CE (fade)",
    rows,
    minuteDown,
    "CE",
    "up",
    targetPoints,
    points,
  );

  const strategies = [
    followDirection,
    alwaysCall,
    alwaysPut,
    minuteUpBuyCall,
    minuteDownBuyPut,
    minuteUpBuyPut,
    minuteDownBuyCall,
  ];
  const bestStrategy = [...strategies].sort((a, b) => b.targetHitPct - a.targetHitPct)[0];

  const mainExitsNote = `±${points.backtestTarget25}→±${points.indexTarget20}@10:01→±${points.indexTarget15}@11:01`;
  const nearMissExitsNote = `±${points.nearMissTarget}→±${points.nearMissTargetAfter}@10:01`;
  const liveExitNote =
    `Live bot: |Δ|≥${points.followMinAbsDiff} → index ±${points.backtestTarget25} until 10:01, ±${points.indexTarget20} from 10:01, ±${points.indexTarget15} from 11:01 · ` +
    `${points.nearMissMinAbsDiff}≤|Δ|<${points.nearMissMaxAbsDiff} → ±${points.nearMissTarget} until 10:01 then ±${points.nearMissTargetAfter} · ` +
    `P&L +10% 9:16–10:00 / +5% 10:01–11:00 / +3% 11:01–12:00 / +1% from 12:01.`;
  const entryRule =
    `Backtest mirrors live: enter at 9:16:00 Kite open when |9:15 Δ| ≥ ${points.liveMinAbsDiff}. ` +
    `|Δ|≥${points.followMinAbsDiff}: win on entry ±${points.backtestTarget25} before 10:01 / ±${points.indexTarget20} from 10:01 / ±${points.indexTarget15} from 11:01. ` +
    `${points.nearMissMinAbsDiff}≤|Δ|<${points.nearMissMaxAbsDiff}: win on ±${points.nearMissTarget} before 10:01 / ±${points.nearMissTargetAfter} from 10:01. ` +
    `Hit time = that minute's candle open. ${liveExitNote}`;

  const todayRow =
    includeTodaySignal && targetPoints === points.followBacktestTarget
      ? (rows.find((row) => row.date === todayIstDateKey()) ?? null)
      : null;
  let todaySignal: NineFifteenCePeGuide["todaySignal"] = null;
  if (todayRow) {
    let side: NineFifteenOptionSide = "WAIT";
    let note = "";
    const abs = Math.abs(todayRow.change);
    if (todayRow.direction === "flat") {
      note = "9:15 bar flat — no directional signal; skip.";
    } else if (abs < points.liveMinAbsDiff) {
      side = "WAIT";
      note = `9:15 bar ${todayRow.direction === "up" ? "UP" : "DOWN"} but |Δ|=${abs.toFixed(2)} < ${points.liveMinAbsDiff} — no entry.`;
    } else if (todayRow.direction === "up") {
      side = "CE";
      const band =
        abs >= points.followMinAbsDiff
          ? `main exits (${mainExitsNote})`
          : `near-miss exits (${nearMissExitsNote})`;
      note = `9:15 bar closed UP (+${todayRow.change.toFixed(2)} pts) — buy CE at 9:16 · ${band}`;
    } else {
      side = "PE";
      const band =
        abs >= points.followMinAbsDiff
          ? `main exits (${mainExitsNote})`
          : `near-miss exits (${nearMissExitsNote})`;
      note = `9:15 bar closed DOWN (${todayRow.change.toFixed(2)} pts) — buy PE at 9:16 · ${band}`;
    }
    todaySignal = {
      date: todayRow.date,
      minuteDirection: todayRow.direction,
      side,
      note,
    };
  }

  return {
    targetPoints,
    followDirection,
    alwaysCall,
    alwaysPut,
    minuteUpBuyCall,
    minuteDownBuyPut,
    minuteUpBuyPut,
    minuteDownBuyCall,
    bestStrategy,
    entryRule,
    todaySignal,
  };
}

function buildFollowBacktestBlock(
  rows: NineFifteenCandleRow[],
  includeTodaySignal: boolean,
  points: IndexPoints,
  profile: IndexProfile,
  byDate?: MinuteCandlesByDate,
): NineFifteenFollowBacktestBlock {
  const target = points.followBacktestTarget;
  return {
    fromDate: rows[rows.length - 1]?.date ?? "",
    toDate: rows[0]?.date ?? "",
    nseSessions: rows.length,
    cePeGuide: buildCePeGuideForTarget(
      rows,
      target,
      points,
      points.followMinAbsDiff,
      includeTodaySignal,
    ),
    liveRedPeMain916ConfirmFollow: buildLiveRedPeMain916ConfirmFollowStats(
      rows,
      points,
      profile,
      "default",
      byDate,
    ),
    liveRedPeMain916ConfirmFilterStats: computeLiveRedPeMain916ConfirmFilterStats(rows, points, profile),
    liveRedPeMain916BothRedFollow: buildLiveRedPeMain916BothRedFollowStats(
      rows,
      points,
      profile,
      "default",
      byDate,
    ),
    liveRedPeMain916BothRedFilterStats: computeLiveRedPeMain916BothRedFilterStats(rows, points, profile),
    liveGreenCeMain916ConfirmFollow: buildLiveGreenCeMain916ConfirmFollowStats(
      rows,
      points,
      profile,
      "default",
      byDate,
    ),
    liveGreenCeMain916ConfirmFilterStats: computeLiveGreenCeMain916ConfirmFilterStats(rows, points),
    liveGreenCeMain916BothGreenFollow: buildLiveGreenCeMain916BothGreenFollowStats(
      rows,
      points,
      profile,
      "default",
      byDate,
    ),
    liveGreenCeMain916BothGreenFilterStats: computeLiveGreenCeMain916BothGreenFilterStats(rows, points),
  };
}

/** Recompute backtest stats for the most recent `maxSessions` rows (newest-first order). */
export function sliceNineFifteenCandlesResult(
  full: NineFifteenCandlesResult,
  maxSessions: number,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
): NineFifteenCandlesResult {
  const cap = Math.max(1, Math.min(Math.round(maxSessions), full.rows.length));
  const rows = full.rows.slice(0, cap);
  const points = buildIndexPoints(profile);
  const block = buildFollowBacktestBlock(rows, false, points, profile);
  return {
    ...full,
    fromDate: rows[rows.length - 1]?.date ?? full.fromDate,
    toDate: rows[0]?.date ?? full.toDate,
    rows,
    summary: buildSummary(rows),
    nseSessionsOneYear: rows.length,
    cePeGuide: block.cePeGuide,
    liveRedPeMain916ConfirmFollow: block.liveRedPeMain916ConfirmFollow,
    liveRedPeMain916ConfirmFilterStats: block.liveRedPeMain916ConfirmFilterStats,
    liveRedPeMain916BothRedFollow: block.liveRedPeMain916BothRedFollow,
    liveRedPeMain916BothRedFilterStats: block.liveRedPeMain916BothRedFilterStats,
    liveGreenCeMain916ConfirmFollow: block.liveGreenCeMain916ConfirmFollow,
    liveGreenCeMain916ConfirmFilterStats: block.liveGreenCeMain916ConfirmFilterStats,
    liveGreenCeMain916BothGreenFollow: block.liveGreenCeMain916BothGreenFollow,
    liveGreenCeMain916BothGreenFilterStats: block.liveGreenCeMain916BothGreenFilterStats,
  };
}

/**
 * Every expiry-weekday session in the window measured against the live expiry-day rule (flat ±10
 * from the 9:16 entry). Skipped days (|Δ| < 11) are kept in the list so the log covers the
 * whole year, but they are excluded from the hit rate.
 */
export function buildTuesdayTenPointStats(
  rows: NineFifteenCandleRow[],
  points: IndexPoints,
  profile: IndexProfile,
): NineFifteenTuesdayTargetStats {
  const tuesdays = rows
    .filter((row) => isExpiryWeekday(row.date, profile))
    .sort((a, b) => b.date.localeCompare(a.date));

  const logRows: NineFifteenTuesdayTargetRow[] = tuesdays.map((row) => {
    const band = breakoutBandForChange(row.direction, row.change, points);
    const side: "CE" | "PE" | null =
      band == null ? null : row.direction === "down" ? "PE" : "CE";
    const entryIndexPrice = side ? (row.entryAtLive916?.indexPrice ?? row.open) : null;
    const targetIndexPrice =
      side && entryIndexPrice != null
        ? side === "CE"
          ? entryIndexPrice + points.breakoutExpiryDayTarget
          : entryIndexPrice - points.breakoutExpiryDayTarget
        : null;

    return {
      date: row.date,
      change915: row.change,
      side,
      band,
      entryIndexPrice,
      targetIndexPrice,
      hit: side ? (row.breakoutTuesdayTargetHit ?? null) : null,
      closest: side ? (row.tuesdayTenClosest ?? null) : null,
    };
  });

  const tradeRows = logRows.filter((row) => row.side != null);
  const hits = tradeRows.filter((row) => row.hit != null).length;

  return {
    targetPoints: points.breakoutExpiryDayTarget,
    totalTuesdays: logRows.length,
    tradeDays: tradeRows.length,
    skippedDays: logRows.length - tradeRows.length,
    hits,
    misses: tradeRows.length - hits,
    hitPct: tradeRows.length > 0 ? (hits / tradeRows.length) * 100 : 0,
    rows: logRows,
  };
}


/** Bump when the shape or maths of the result changes — invalidates the on-disk payload. */
const CACHE_VERSION =
  "v140:summary-flat-under-15";
/**
 * Completed sessions never change, so the only thing a rebuild adds is today's session. A short
 * TTL just meant a 4–6 minute rebuild every half hour, which pegs this 2 GB host and slows down
 * the very page that triggered it.
 */
const CACHE_MS = 6 * 60 * 60_000;
/** Minutes past midnight IST, plus the weekday, for the market-hours guards. */
export function istNowParts(): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
    weekday: weekdays.indexOf(get("weekday")),
  };
}

/** True between 9:00 and 15:35 IST on a weekday — when the live bot owns the event loop. */
export function isMarketHoursIst(): boolean {
  const { minutes, weekday } = istNowParts();
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 35;
}

/**
 * A built result is ~85 MB of JSON per index. Parsing it and holding it in a memory cache put
 * this 2 GB host at 76% RAM once two indices existed — close enough to an OOM kill to take the
 * live 9:16 bot down with it. So the cache is the gzipped HTTP response body on disk, and the
 * request path streams those bytes out verbatim. Nothing large stays resident between requests.
 */
function payloadBase(profile: IndexProfile): string {
  return path.join(process.cwd(), "data", profile.cacheFileName.replace(/\.json$/, ""));
}

function payloadFile(profile: IndexProfile): string {
  return `${payloadBase(profile)}.json.gz`;
}

function metaFile(profile: IndexProfile): string {
  return `${payloadBase(profile)}.meta.json`;
}

interface CacheMeta {
  version: string;
  at: number;
  /** Calendar days the on-disk payload was built with (may exceed a single UI window). */
  daysBuilt: number;
  /** Complete NSE session rows stored in the payload (newest-first). */
  sessionsBuilt: number;
}

export interface BacktestPayloadRef {
  /** Gzipped `{"data":…}` response body, streamed to the client as-is. */
  gzipPath: string;
  builtAt: number;
}

export function invalidateNineFifteenCache(_profile?: IndexProfile) {
  for (const target of [NIFTY_INDEX_PROFILE]) {
    try {
      fs.rmSync(metaFile(target), { force: true });
    } catch {
      /* invalidation is best effort — a stale payload is better than a failed request */
    }
  }
}

function readMeta(profile: IndexProfile): CacheMeta | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile(profile), "utf8")) as CacheMeta;
    if (meta?.version !== CACHE_VERSION) return null;
    if (!Number.isFinite(meta.daysBuilt) || meta.daysBuilt <= 0) return null;
    if (!Number.isFinite(meta.sessionsBuilt) || meta.sessionsBuilt <= 0) return null;
    if (!fs.existsSync(payloadFile(profile))) return null;
    return meta;
  } catch {
    return null;
  }
}

/** Serialises straight to gzip so the only long-lived artefact is the compressed file. */
function writePayload(result: NineFifteenCandlesResult, profile: IndexProfile): number {
  const at = Date.now();
  const file = payloadFile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, file);
  fs.writeFileSync(
    metaFile(profile),
    JSON.stringify({
      version: CACHE_VERSION,
      at,
      daysBuilt: result.daysRequested,
      sessionsBuilt: result.nseSessionsOneYear,
    }),
  );
  return at;
}

/**
 * One rebuild at a time across every index. Two concurrent builds each hold a full result in
 * memory, which is the exact shape of an OOM on this host.
 */
let buildQueue: Promise<unknown> = Promise.resolve();

function runSerial<T>(task: () => Promise<T>): Promise<T> {
  const next = buildQueue.then(task, task);
  buildQueue = next.catch(() => undefined);
  return next;
}

const inflightRebuild = new Map<IndexProfile["id"], { promise: Promise<number>; days: number }>();

/** Build + persist in one call, so the worker process has a single entry point. */
export async function buildAndWriteNineFifteenPayload(
  accessToken: string,
  fetchCandles: CandleFetcher,
  days: number,
  profile: IndexProfile,
): Promise<number> {
  return writePayload(
    await buildNineFifteenCandleHistory(accessToken, fetchCandles, days, profile),
    profile,
  );
}

/**
 * Hands the build to a throwaway child process and picks the result up off disk. Keeping the
 * ~1.5 GB peak out of the API process is the whole point: V8 never returns those pages, so an
 * in-process build left this host swapping for the rest of the server's life.
 *
 * There is deliberately no in-process fallback. This process is capped well below what a build
 * needs so it can never crowd out the live 9:16 bot, so building here would OOM-kill the bot —
 * strictly worse than a backtest page that reports it could not refresh.
 */
async function buildOutOfProcess(
  accessToken: string,
  days: number,
  profile: IndexProfile,
): Promise<number> {
  await spawnBacktestBuild(profile.id, accessToken, days);
  const built = readMeta(profile);
  if (!built) throw new Error(`Backtest build for ${profile.id} produced no cache`);
  return built.at;
}

/**
 * Ensures a fresh gzipped payload exists on disk and hands back a reference to it. Deliberately
 * never returns the parsed result: that object is what used to stay resident.
 */
export async function ensureNineFifteenPayload(
  accessToken: string,
  daysRequested = NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  force = false,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
  minSessions = 0,
): Promise<BacktestPayloadRef> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NINE_FIFTEEN_MAX_HISTORY_DAYS);
  const sessionsNeeded = Math.max(
    minSessions > 0 ? Math.round(minSessions) : 0,
    sessionsForCalendarDays(days),
  );
  const meta = force ? null : readMeta(profile);
  const cacheCoversRequest = (m: CacheMeta) =>
    m.daysBuilt >= days && m.sessionsBuilt >= sessionsNeeded;
  if (meta && cacheCoversRequest(meta) && Date.now() - meta.at < CACHE_MS) {
    return { gzipPath: payloadFile(profile), builtAt: meta.at };
  }

  /**
   * A rebuild is minutes of CPU and a few hundred Kite history calls. It runs in a niced child
   * now so it cannot stall the live 9:16 bot, but it would still compete for a small host's CPU
   * and rate limit, so expired-but-valid bytes are served as-is until the close — they only lack
   * today's session, which a 1-year study barely moves. An explicit refresh still rebuilds.
   */
  if (meta && !force && cacheCoversRequest(meta) && isMarketHoursIst()) {
    return { gzipPath: payloadFile(profile), builtAt: meta.at };
  }

  let inflight = inflightRebuild.get(profile.id);
  if (!inflight || inflight.days < days) {
    const promise = runSerial(() => buildOutOfProcess(accessToken, days, profile))
      .catch((error: unknown) => {
        // Prefer stale bytes over an error page — a rebuild can fail on a Kite hiccup.
        const stale = readMeta(profile);
        if (stale) return stale.at;
        throw error;
      })
      .finally(() => {
        const current = inflightRebuild.get(profile.id);
        if (current?.promise === promise) inflightRebuild.delete(profile.id);
      });
    inflightRebuild.set(profile.id, { promise, days });
    inflight = inflightRebuild.get(profile.id)!;
  }

  /**
   * Stale-while-revalidate: completed sessions never change, so expired bytes still render
   * correctly. Serve them now and let the rebuild land in the background.
   */
  if (meta && cacheCoversRequest(meta)) {
    inflight.promise.catch(() => {
      /* the catch above already falls back to the stale payload */
    });
    return { gzipPath: payloadFile(profile), builtAt: meta.at };
  }

  await inflight.promise;
  const built = readMeta(profile);
  if (!built || !cacheCoversRequest(built)) {
    throw new Error(
      `Backtest cache has ${built?.sessionsBuilt ?? 0} sessions but ${sessionsNeeded} are needed for this range — try Refresh`,
    );
  }
  return { gzipPath: payloadFile(profile), builtAt: built.at };
}

/**
 * Parsed result, for the synthetic checks and snapshot tooling. The server's request path uses
 * `ensureNineFifteenPayload` instead, so it never materialises this object.
 */
export async function fetchNineFifteenCandleHistory(
  accessToken: string,
  fetchCandles: CandleFetcher,
  daysRequested = NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  _force = false,
  /** Set by the synthetic checks so their fake candles never land in the real cache file. */
  persist = true,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
): Promise<NineFifteenCandlesResult> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NINE_FIFTEEN_MAX_HISTORY_DAYS);
  const result = await runSerial(() =>
    buildNineFifteenCandleHistory(accessToken, fetchCandles, days, profile),
  );
  if (persist) writePayload(result, profile);
  return result;
}

function sessionsForCalendarDays(days: number): number {
  return Math.min(
    NINE_FIFTEEN_BACKTEST_MAX_SESSIONS,
    Math.max(1, Math.round((days / 365) * NSE_SESSIONS_ONE_YEAR)),
  );
}

async function buildNineFifteenCandleHistory(
  accessToken: string,
  fetchCandles: CandleFetcher,
  days: number,
  profile: IndexProfile,
): Promise<NineFifteenCandlesResult> {
  const points = buildIndexPoints(profile);
  const sessionTarget = sessionsForCalendarDays(days);
  const calendarLookback = calendarDaysForSessionLookback(sessionTarget);
  const tradingDates = listWeekdayDatesIst(calendarLookback);
  if (tradingDates.length === 0) {
    throw new Error("No dates in range");
  }

  const chunks = chunkTradingDates(tradingDates, CHUNK_TRADING_DAYS);
  const byDate: MinuteCandlesByDate = new Map();
  let rawCandleCount = 0;

  for (const chunk of chunks) {
    const from = `${chunk[0]} 09:15:00`;
    const to = `${chunk[chunk.length - 1]} 15:30:00`;
    const { candles } = await fetchCandles(accessToken, profile.spotKey, "minute", from, to);
    if (!Array.isArray(candles)) {
      throw new Error("Invalid candle response from Kite");
    }
    rawCandleCount += candles.length;
    ingestRawCandles(candles, byDate);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  if (rawCandleCount === 0) {
    throw new Error(`No historical candles returned from Kite for ${profile.label}`);
  }

  const rowsAll = buildRowsFromMinuteMap(byDate, points, profile);
  if (rowsAll.length === 0) {
    byDate.clear();
    throw new Error("No complete NSE session days in Kite data (check 9:15–15:30 minute candles)");
  }

  const rowsSlice = rowsAll.slice(0, Math.min(sessionTarget, rowsAll.length));
  const block = buildFollowBacktestBlock(rowsSlice, true, points, profile, byDate);
  byDate.clear();

  return {
    instrument: profile.spotKey,
    indexId: profile.id,
    indexLabel: profile.label,
    pointScale: profile.pointScale,
    expiryWeekday: profile.expiryWeekday,
    daysRequested: days,
    dataSource: "zerodha_kite",
    fromDate: rowsSlice[rowsSlice.length - 1]?.date ?? tradingDates[0] ?? "",
    toDate: rowsSlice[0]?.date ?? tradingDates[tradingDates.length - 1] ?? "",
    rows: rowsSlice,
    summary: buildSummary(rowsSlice),
    nseSessionsOneYear: rowsSlice.length,
    cePeGuide: block.cePeGuide,
    liveRedPeMain916ConfirmFollow: block.liveRedPeMain916ConfirmFollow,
    liveRedPeMain916ConfirmFilterStats: block.liveRedPeMain916ConfirmFilterStats,
    liveRedPeMain916BothRedFollow: block.liveRedPeMain916BothRedFollow,
    liveRedPeMain916BothRedFilterStats: block.liveRedPeMain916BothRedFilterStats,
    liveGreenCeMain916ConfirmFollow: block.liveGreenCeMain916ConfirmFollow,
    liveGreenCeMain916ConfirmFilterStats: block.liveGreenCeMain916ConfirmFilterStats,
    liveGreenCeMain916BothGreenFollow: block.liveGreenCeMain916BothGreenFollow,
    liveGreenCeMain916BothGreenFilterStats: block.liveGreenCeMain916BothGreenFilterStats,
  };
}
