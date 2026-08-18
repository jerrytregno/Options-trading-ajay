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
  NineFifteenOptionSide,
  NineFifteenRupeLevel,
  NineFifteenTimeCheckpoint,
  NineFifteenTargetHit,
  NineFifteenTradeEntry,
} from "../src/types/nine-fifteen.js";
import {
  NINE_FIFTEEN_CEPE_TARGETS,
  NINE_FIFTEEN_RUPEE_LEVELS,
  NINE_FIFTEEN_TIME_CHECKPOINTS,
  NSE_SESSIONS_ONE_YEAR,
} from "../src/types/nine-fifteen.js";
import { rsiAtBarIndex } from "../src/lib/rsi.js";
import {
  NINE_SIXTEEN_INDEX_TARGET_15,
  NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE,
  NINE_SIXTEEN_INDEX_TARGET_20,
  NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE,
  NINE_SIXTEEN_ENTRY_SEC,
} from "./nine-sixteen-logic.js";

/** Backtest entry: Kite 9:16 candle open (real 1-min data). */
const BACKTEST_ENTRY_SEC_OF_DAY = NINE_SIXTEEN_ENTRY_SEC;

const NIFTY_SPOT_KEY = "NSE:NIFTY 50";
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
export const NINE_FIFTEEN_BACKTEST_TARGET = 30;
export const NINE_FIFTEEN_BACKTEST_TARGET_20 = 20;
export const NINE_FIFTEEN_BACKTEST_TARGET_25 = 25;
export const NINE_FIFTEEN_BACKTEST_TARGET_10 = 10;
export const NINE_FIFTEEN_BACKTEST_TARGET_15 = 15;
export const NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF = 15;
/** Near-miss band: 11 ≤ |Δ| < 15 (live near-miss exits). */
export const NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF = 11;
export const NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF = 15;
/** Near-miss study: ±20 until 10:01 IST, then ±10. */
export const NINE_FIFTEEN_NEAR_MISS_TARGET = NINE_FIFTEEN_BACKTEST_TARGET_20;
export const NINE_FIFTEEN_NEAR_MISS_TARGET_AFTER = NINE_FIFTEEN_BACKTEST_TARGET_10;
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
/** Breakout stops are only checked from this IST minute onward (11:00). */
export const NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE = 11 * 60;

type BreakoutStopConfig = {
  stopMainPoints: number;
  stopNearMissPoints: number;
  /** First IST minute-of-day when the adverse stop can trigger. */
  stopActiveFromMins: number;
};

const BREAKOUT_STOP_TIGHT: BreakoutStopConfig = {
  stopMainPoints: NINE_FIFTEEN_BREAKOUT_STOP_MAIN,
  stopNearMissPoints: NINE_FIFTEEN_BREAKOUT_STOP_NEAR_MISS,
  stopActiveFromMins: NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE,
};

/** Follow backtest exits: entry ± N from Kite bars ≥9:16 (not 9:15-open rules). */
function isEntryBasedFollowTarget(targetPoints: number): boolean {
  return (
    targetPoints === NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET ||
    targetPoints === NINE_FIFTEEN_NEAR_MISS_TARGET
  );
}
/** RSI lookback on consecutive 1-min closes ending at 9:15. */
const NINE_FIFTEEN_RSI_PERIOD = 14;
/** Default calendar days requested (~1y NSE sessions). */
export const NINE_FIFTEEN_DEFAULT_HISTORY_DAYS = 365;
/** Calendar lookback ceiling — wide enough for ~1y of weekday sessions + holiday buffer. */
export const NINE_FIFTEEN_MAX_HISTORY_DAYS =
  Math.ceil(NSE_SESSIONS_ONE_YEAR * (365 / NSE_SESSIONS_ONE_YEAR)) + 120;
const ONE_YEAR_SESSION_ROWS = NSE_SESSIONS_ONE_YEAR;
/** Minimum 1-min bars in session (9:15–15:30) to count as a full Kite trading day. */
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

  for (const level of NINE_FIFTEEN_RUPEE_LEVELS) {
    gainLevels[level] = highPx >= openPx + level;
    lossLevels[level] = lowPx <= openPx - level;
  }

  return { maxGainFromOpen, maxLossFromOpen, gainLevels, lossLevels };
}

function buildCePeLevelFlags(
  openPx: number,
  highPx: number,
  lowPx: number,
): {
  upLevels: Record<NineFifteenCePeTarget, boolean>;
  downLevels: Record<NineFifteenCePeTarget, boolean>;
} {
  const upLevels = {} as Record<NineFifteenCePeTarget, boolean>;
  const downLevels = {} as Record<NineFifteenCePeTarget, boolean>;

  for (const level of NINE_FIFTEEN_CEPE_TARGETS) {
    upLevels[level] = highPx >= openPx + level;
    downLevels[level] = lowPx <= openPx - level;
  }

  return { upLevels, downLevels };
}

function buildCheckpointSnapshots(
  openPx: number,
  sessionCandles: MinuteCandle[],
): Record<NineFifteenTimeCheckpoint, NineFifteenCheckpointLevels> {
  const checkpoints = {} as Record<NineFifteenTimeCheckpoint, NineFifteenCheckpointLevels>;
  const bar917 = sessionCandles.find((c) => c.mins === BACKTEST_EXIT_START_MINUTES);
  const seedHigh = bar917?.high ?? openPx;
  const seedLow = bar917?.low ?? openPx;

  if (!sessionCandles.some((c) => c.mins >= BACKTEST_EXIT_START_MINUTES)) {
    for (const cp of TIME_CHECKPOINTS) {
      const flags = buildCePeLevelFlags(openPx, openPx, openPx);
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
        const flags = buildCePeLevelFlags(openPx, windowHigh, windowLow);
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
    const flags = buildCePeLevelFlags(openPx, h, l);
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

/** ±25 until 10:01 · ±20 from 10:01 · ±15 from 11:01 (main live-aligned backtest exit). */
function indexTargetPointsForMinute(mins: number): number {
  if (mins >= NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE) return NINE_SIXTEEN_INDEX_TARGET_15;
  if (mins >= NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE) return NINE_SIXTEEN_INDEX_TARGET_20;
  return NINE_FIFTEEN_BACKTEST_TARGET_25;
}

function firstDirectionalHitTieredIndexTarget(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  direction: "up" | "down",
): NineFifteenTargetHit | null {
  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;
    const targetPoints = indexTargetPointsForMinute(c.mins);
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
): { up: NineFifteenTargetHit | null; down: NineFifteenTargetHit | null } {
  return {
    up: firstDirectionalHitTieredIndexTarget(entryPrice, sessionCandles, "up"),
    down: firstDirectionalHitTieredIndexTarget(entryPrice, sessionCandles, "down"),
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
function breakoutProfitTargetPointsAtMinute(band: "main" | "near_miss", mins: number): number {
  if (band === "near_miss") {
    return mins >= NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE
      ? NINE_FIFTEEN_NEAR_MISS_TARGET_AFTER
      : NINE_FIFTEEN_NEAR_MISS_TARGET;
  }
  return indexTargetPointsForMinute(mins);
}

/**
 * Full session (9:16–15:30): minute whose high/low came closest to the tiered profit target.
 */
function closestApproachToTieredProfitTarget(
  entryPrice: number,
  sessionCandles: MinuteCandle[],
  tradeSide: "CE" | "PE",
  band: "main" | "near_miss",
): NineFifteenBreakoutTargetApproach | null {
  let best: NineFifteenBreakoutTargetApproach | null = null;

  const ordered = [...sessionCandles].sort((a, b) => a.mins - b.mins);
  for (const c of ordered) {
    if (!kiteCandleInExitWindow(c)) continue;

    const targetPoints = breakoutProfitTargetPointsAtMinute(band, c.mins);
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

function minutesFromIstTime(timeIst: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(timeIst.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Band from the 9:15 bar — mirrors liveExitModeForRow but runs before the row exists. */
function breakoutBandForChange(
  direction: NineFifteenDirection,
  change: number,
): "main" | "near_miss" | null {
  if (direction !== "up" && direction !== "down") return null;
  const abs = Math.abs(change);
  if (abs >= NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF) return "main";
  if (abs >= NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF) return "near_miss";
  return null;
}

function breakoutStopPointsForBand(
  band: "main" | "near_miss",
  config: BreakoutStopConfig = BREAKOUT_STOP_TIGHT,
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
    dayUpLevels[level] = sessionHigh >= openPx + level;
    dayDownLevels[level] = sessionLow <= openPx - level;
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

function parseSessionRows(raw: unknown[]): NineFifteenCandleRow[] {
  const byDate = new Map<string, MinuteCandle[]>();

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
    const minuteLevels = buildLevelFlags(bar915.open, bar915.high, bar915.low);
    const dayLevels = buildDayLevelFlags(bar915.open, sessionHigh, sessionLow);
    const checkpoints = buildCheckpointSnapshots(bar915.open, sessionCandles);
    const bar916 = sessionCandles.find((c) => c.mins === SESSION_ENTRY_MINUTES);
    const entryAtLive916 = bar916 ? kiteEntryAt916Open(bar916) : null;
    const entryPx = entryAtLive916?.indexPrice ?? bar915.open;
    const hit25 = firstTargetHitsFromKite(entryPx, sessionCandles, NINE_FIFTEEN_BACKTEST_TARGET_25);
    const hit15 = firstTargetHitsFromKite(entryPx, sessionCandles, NINE_FIFTEEN_BACKTEST_TARGET_15);
    const tieredMain = tieredIndexTargetHitsFromKite(entryPx, sessionCandles);
    const switch20_10 = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      NINE_FIFTEEN_NEAR_MISS_TARGET,
      NINE_FIFTEEN_NEAR_MISS_TARGET_AFTER,
      NINE_FIFTEEN_NEAR_MISS_SWITCH_MINUTE,
    );
    const maxFavorableCeAfterEntry = maxFavorableMoveFromKiteExitWindow(entryPx, sessionCandles, "CE");
    const maxFavorablePeAfterEntry = maxFavorableMoveFromKiteExitWindow(entryPx, sessionCandles, "PE");
    const switch25_20 = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      NINE_FIFTEEN_BACKTEST_TARGET_25,
      NINE_SIXTEEN_INDEX_TARGET_20,
      NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE,
    );
    const switch25_15 = switchingTargetTwoPhase(
      entryPx,
      sessionCandles,
      NINE_FIFTEEN_BACKTEST_TARGET_25,
      NINE_SIXTEEN_INDEX_TARGET_15,
      NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE,
    );

    const direction = directionFromOhlc(bar915.open, bar915.close);
    const breakoutBand = breakoutBandForChange(direction, change);
    const breakoutSide: "CE" | "PE" | null =
      breakoutBand == null ? null : direction === "down" ? "PE" : "CE";
    const breakoutStopPoints = breakoutBand
      ? breakoutStopPointsForBand(breakoutBand, BREAKOUT_STOP_TIGHT)
      : null;
    const breakoutStopHit =
      breakoutSide && breakoutStopPoints
        ? firstAdverseStopHitFromKite(
            entryPx,
            sessionCandles,
            breakoutSide,
            breakoutStopPoints,
            NINE_FIFTEEN_BREAKOUT_STOP_ACTIVE_MINUTE,
          )
        : null;
    const breakoutClosestToTarget =
      breakoutSide && breakoutBand
        ? closestApproachToTieredProfitTarget(entryPx, sessionCandles, breakoutSide, breakoutBand)
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
      tiered25Then20Then15Up: tieredMain.up,
      tiered25Then20Then15Down: tieredMain.down,
      switch20Then10After1001Up: switch20_10.up,
      switch20Then10After1001Down: switch20_10.down,
      entryAtLive916,
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
      breakoutStopHit,
      breakoutStopPoints,
      breakoutClosestToTarget,
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

function buildSummary(rows: NineFifteenCandleRow[]) {
  const up = rows.filter((row) => row.direction === "up").length;
  const down = rows.filter((row) => row.direction === "down").length;
  const flat = rows.filter((row) => row.direction === "flat").length;
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
): boolean {
  const snap = row.checkpoints?.[checkpoint];
  if (!snap) return false;
  const level = targetPoints as NineFifteenCePeTarget;
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
): NineFifteenTargetHit | null {
  if (!isEntryBasedFollowTarget(targetPoints)) return null;
  if (targetPoints === NINE_FIFTEEN_NEAR_MISS_TARGET) {
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
): boolean {
  if (row.direction === "up" && tradeSide !== "CE") return false;
  if (row.direction === "down" && tradeSide !== "PE") return false;
  if (targetPoints === NINE_FIFTEEN_NEAR_MISS_TARGET) {
    return nearMissSwitchHit(row, tradeSide);
  }
  if (targetPoints === NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET) {
    return mainTieredIndexHit(row, tradeSide);
  }
  return followDirectionHit(row, targetPoints);
}

function altTargetAfterTimeForSide(
  tradeSide: "CE" | "PE",
  targetAfterPoints: number,
  switchAfterIst: string,
  upHit: NineFifteenTargetHit | null | undefined,
  downHit: NineFifteenTargetHit | null | undefined,
): NineFifteenCePeFailureTrade["altTargetAfter1010"] {
  const switchHit = tradeSide === "CE" ? (upHit ?? null) : (downHit ?? null);
  return {
    targetBeforePoints: NINE_FIFTEEN_BACKTEST_TARGET_25,
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
): NineFifteenCePeFailureTrade {
  const tradeSide = failureSideForRow(row, side);
  const targetHit = targetHitForRow(row, targetPoints, tradeSide);
  const entryPx = entryIndexPrice(row);
  const exitTargetIndexPrice =
    entryPx !== null && isEntryBasedFollowTarget(targetPoints)
      ? tradeSide === "CE"
        ? entryPx + targetPoints
        : entryPx - targetPoints
      : null;
  const win = isEntryBasedFollowTarget(targetPoints)
    ? followTargetHitConfirmed(row, targetPoints, tradeSide)
    : followDirectionHit(row, targetPoints);

  const mfe =
    tradeSide === "CE" ? row.maxFavorableCeAfterEntry : row.maxFavorablePeAfterEntry;
  const maxMoveInDirection =
    mfe?.movePts ?? maxMoveInDirectionFromSession(row, tradeSide);

  let altTargetAfter1010: NineFifteenCePeFailureTrade["altTargetAfter1010"] = null;
  let altTarget10After1010: NineFifteenCePeFailureTrade["altTarget10After1010"] = null;
  if (targetPoints === NINE_FIFTEEN_BACKTEST_TARGET_25 && !win) {
    // Diagnostic only: two-phase alts vs full tiered primary (±25→±20@10:01→±15@11:01).
    altTargetAfter1010 = altTargetAfterTimeForSide(
      tradeSide,
      NINE_SIXTEEN_INDEX_TARGET_20,
      "10:01:00",
      row.switch25Then20After1010Up,
      row.switch25Then20After1010Down,
    );
    altTarget10After1010 = altTargetAfterTimeForSide(
      tradeSide,
      NINE_SIXTEEN_INDEX_TARGET_15,
      "11:01:00",
      row.switch25Then15After1101Up,
      row.switch25Then15After1101Down,
    );
  }

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
  };
}

function strategyStats(
  label: string,
  allRows: NineFifteenCandleRow[],
  tradeRows: NineFifteenCandleRow[],
  side: "CE" | "PE" | "MIXED",
  hitMode: HitMode,
  targetPoints: number,
  collectSuccesses = false,
): NineFifteenCePeStrategyStats {
  const sampleDays = allRows.length;
  const tradeDays = tradeRows.length;
  const hitRow = (row: NineFifteenCandleRow) => {
    if (hitMode === "follow" && isEntryBasedFollowTarget(targetPoints)) {
      return followTargetHitConfirmed(row, targetPoints, failureSideForRow(row, side));
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
    .map((row) => buildTradeDayDetail(row, targetPoints, side))
    .sort((a, b) => b.date.localeCompare(a.date));

  const successes = collectSuccesses
    ? tradeRows
        .filter((row) => hitRow(row))
        .map((row) => buildTradeDayDetail(row, targetPoints, side))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = tradeRows.filter((row) => checkpointHit(row, cp, targetPoints, hitMode)).length;
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

function followDirectionHit(row: NineFifteenCandleRow, targetPoints: number): boolean {
  if (isEntryBasedFollowTarget(targetPoints)) {
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
  targetPoints = NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET,
  minAbsDiff = NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF,
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const filtered = followRows.filter((row) => Math.abs(row.change) >= minAbsDiff);
  const wins = filtered.filter((row) => {
    const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
    return followTargetHitConfirmed(row, targetPoints, tradeSide);
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
  targetPoints = NINE_FIFTEEN_NEAR_MISS_TARGET,
  minAbsDiff = NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF,
  maxAbsDiffExclusive = NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF,
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const filtered = followBandTakenRows(rows, minAbsDiff, maxAbsDiffExclusive);
  const wins = filtered.filter((row) => {
    const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
    return followTargetHitConfirmed(row, targetPoints, tradeSide);
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

function buildNearMissFollowStats(
  rows: NineFifteenCandleRow[],
  targetPoints = NINE_FIFTEEN_NEAR_MISS_TARGET,
): NineFifteenCePeStrategyStats {
  const bandRows = followBandTakenRows(
    rows,
    NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF,
    NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF,
  );
  return strategyStats(
    `Near-miss band: UP→CE, DOWN→PE (${NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF} ≤ |9:15 Δ| < ${NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF}, ±${NINE_FIFTEEN_NEAR_MISS_TARGET} until 10:01 then ±${NINE_FIFTEEN_NEAR_MISS_TARGET_AFTER} from 9:16 open)`,
    rows,
    bandRows,
    "MIXED",
    "follow",
    targetPoints,
    isEntryBasedFollowTarget(targetPoints),
  );
}

/** Live dual-band: |Δ| ≥ 15 → main exits; 11 ≤ |Δ| < 15 → near-miss exits. */
function liveExitModeForRow(row: NineFifteenCandleRow): "main" | "near_miss" | null {
  if (row.direction !== "up" && row.direction !== "down") return null;
  const abs = Math.abs(row.change);
  if (abs >= NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF) return "main";
  if (abs >= NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF) return "near_miss";
  return null;
}

function liveConsolidatedTakenRows(rows: NineFifteenCandleRow[]): NineFifteenCandleRow[] {
  return rows.filter((row) => liveExitModeForRow(row) != null);
}

function liveConsolidatedHit(row: NineFifteenCandleRow): boolean {
  const mode = liveExitModeForRow(row);
  if (!mode) return false;
  const tradeSide: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  return mode === "near_miss" ? nearMissSwitchHit(row, tradeSide) : mainTieredIndexHit(row, tradeSide);
}

function targetPointsForLiveMode(mode: "main" | "near_miss"): number {
  return mode === "near_miss" ? NINE_FIFTEEN_NEAR_MISS_TARGET : NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET;
}

/**
 * Breakout backtest: race the tiered target against the fixed adverse stop on the same day.
 * When both levels fall inside one 1-min bar the stop wins — minute OHLC cannot tell us which
 * side was touched first, so the pessimistic read keeps the study honest.
 */
function buildBreakoutTrade(
  row: NineFifteenCandleRow,
  config: BreakoutStopConfig,
  stopHitForRow: (row: NineFifteenCandleRow) => NineFifteenTargetHit | null,
): NineFifteenBreakoutTrade | null {
  const band = liveExitModeForRow(row);
  if (!band) return null;

  const side: "CE" | "PE" = row.direction === "down" ? "PE" : "CE";
  const targetPoints = targetPointsForLiveMode(band);
  const targetHit = targetHitForRow(row, targetPoints, side);
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
  };
}

function buildBreakoutStats(
  rows: NineFifteenCandleRow[],
  config: BreakoutStopConfig,
  stopHitForRow: (row: NineFifteenCandleRow) => NineFifteenTargetHit | null,
): NineFifteenBreakoutStats {
  const trades = rows
    .map((row) => buildBreakoutTrade(row, config, stopHitForRow))
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
      `Breakout: same 9:16 entry and tiered targets, plus a fixed stop from entry — ` +
      `main ±${config.stopMainPoints} · near-miss ±${config.stopNearMissPoints}` +
      (config.stopActiveFromMins > BACKTEST_EXIT_START_MINUTES
        ? ` · stop active from ${formatIstHms(config.stopActiveFromMins * 60)} IST`
        : ""),
    stopMainPoints: config.stopMainPoints,
    stopNearMissPoints: config.stopNearMissPoints,
    stopActiveFromIst: formatIstHms(config.stopActiveFromMins * 60),
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

export function computeLiveConsolidatedFilterStats(
  rows: NineFifteenCandleRow[],
): NineFifteenFollowFilterStats {
  const followRows = rows.filter((row) => row.direction === "up" || row.direction === "down");
  const filtered = liveConsolidatedTakenRows(rows);
  const wins = filtered.filter(liveConsolidatedHit).length;
  const filteredTrades = filtered.length;
  return {
    minAbsDiff: NINE_FIFTEEN_LIVE_MIN_ABS_DIFF,
    targetPoints: NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET,
    totalFollowTrades: followRows.length,
    filteredTrades,
    wins,
    losses: filteredTrades - wins,
    winPct: filteredTrades > 0 ? (wins / filteredTrades) * 100 : 0,
    skippedSmallBar: followRows.length - filteredTrades,
    display: {
      filterTitle: `Live bot (consolidated): |Δ| ≥ ${NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF} · main ±25→±20@10:01→±15@11:01 · ${NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF} ≤ |Δ| < ${NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF} · near-miss ±20→±10@10:01 · UP→CE, DOWN→PE`,
      takenLabel: `Trades taken (|Δ| ≥ ${NINE_FIFTEEN_LIVE_MIN_ABS_DIFF})`,
      skippedLabel: `Skipped (|Δ| < ${NINE_FIFTEEN_LIVE_MIN_ABS_DIFF})`,
    },
  };
}

function buildLiveConsolidatedFollowStats(rows: NineFifteenCandleRow[]): NineFifteenCePeStrategyStats {
  const taken = liveConsolidatedTakenRows(rows);
  const tradeDays = taken.length;
  const sampleDays = rows.length;
  const successes = taken
    .filter(liveConsolidatedHit)
    .map((row) => {
      const mode = liveExitModeForRow(row)!;
      return buildTradeDayDetail(row, targetPointsForLiveMode(mode), "MIXED");
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const failures = taken
    .filter((row) => !liveConsolidatedHit(row))
    .map((row) => {
      const mode = liveExitModeForRow(row)!;
      return buildTradeDayDetail(row, targetPointsForLiveMode(mode), "MIXED");
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  const targetHits = successes.length;

  const checkpointHits = {} as NineFifteenCePeStrategyStats["checkpointHits"];
  for (const cp of NINE_FIFTEEN_TIME_CHECKPOINTS) {
    const hits = taken.filter((row) => {
      const mode = liveExitModeForRow(row);
      if (!mode) return false;
      return checkpointHit(row, cp, targetPointsForLiveMode(mode), "follow");
    }).length;
    checkpointHits[cp] = {
      targetHits: hits,
      targetHitPct: tradeDays > 0 ? (hits / tradeDays) * 100 : 0,
    };
  }

  return {
    label:
      `Live consolidated: UP→CE, DOWN→PE · |Δ|≥${NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF} ±25→±20@10:01→±15@11:01 · ` +
      `${NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF}≤|Δ|<${NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF} ±20→±10@10:01 (from 9:16 open)`,
    side: "MIXED",
    sampleDays,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
    checkpointHits,
    failures,
    successes,
  };
}

function buildCePeGuideForTarget(
  rows: NineFifteenCandleRow[],
  targetPoints: number,
  followMinAbsDiff = NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF,
  includeTodaySignal = false,
): NineFifteenCePeGuide {
  const minuteUp = rows.filter((row) => row.direction === "up");
  const minuteDown = rows.filter((row) => row.direction === "down");
  const followTradeRows = followTakenRows(rows, followMinAbsDiff);

  const followDirection = strategyStats(
    `Follow 9:15 bar: UP→CE, DOWN→PE (|9:15 Δ| ≥ ${followMinAbsDiff}, ±25 → ±20 @10:01 → ±15 @11:01 from 9:16 open)`,
    rows,
    followTradeRows,
    "MIXED",
    "follow",
    targetPoints,
    isEntryBasedFollowTarget(targetPoints),
  );
  const alwaysCall = strategyStats(
    "Buy CE every day at 9:15",
    rows,
    rows,
    "CE",
    "up",
    targetPoints,
  );
  const alwaysPut = strategyStats(
    "Buy PE every day at 9:15",
    rows,
    rows,
    "PE",
    "down",
    targetPoints,
  );
  const minuteUpBuyCall = strategyStats(
    "9:15 bar closes UP → buy CE",
    rows,
    minuteUp,
    "CE",
    "up",
    targetPoints,
  );
  const minuteDownBuyPut = strategyStats(
    "9:15 bar closes DOWN → buy PE",
    rows,
    minuteDown,
    "PE",
    "down",
    targetPoints,
  );
  const minuteUpBuyPut = strategyStats(
    "9:15 bar UP → buy PE (fade)",
    rows,
    minuteUp,
    "PE",
    "down",
    targetPoints,
  );
  const minuteDownBuyCall = strategyStats(
    "9:15 bar DOWN → buy CE (fade)",
    rows,
    minuteDown,
    "CE",
    "up",
    targetPoints,
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

  const liveExitNote =
    `Live bot: |Δ|≥15 → index ±25 until 10:01, ±20 from 10:01, ±15 from 11:01 · ` +
    `11≤|Δ|<15 → ±20 until 10:01 then ±10 · ` +
    `P&L +10% 9:16–10:00 / +5% 10:01–11:00 / +3% 11:01–12:00 / +1% from 12:01.`;
  const entryRule =
    `Backtest mirrors live: enter at 9:16:00 Kite open when |9:15 Δ| ≥ ${NINE_FIFTEEN_LIVE_MIN_ABS_DIFF}. ` +
    `|Δ|≥${NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF}: win on entry ±25 before 10:01 / ±20 from 10:01 / ±15 from 11:01. ` +
    `${NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF}≤|Δ|<${NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF}: win on ±20 before 10:01 / ±10 from 10:01. ` +
    `Hit time = that minute's candle open. ${liveExitNote}`;

  const todayRow =
    includeTodaySignal && targetPoints === NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET
      ? (rows.find((row) => row.date === todayIstDateKey()) ?? null)
      : null;
  let todaySignal: NineFifteenCePeGuide["todaySignal"] = null;
  if (todayRow) {
    let side: NineFifteenOptionSide = "WAIT";
    let note = "";
    const abs = Math.abs(todayRow.change);
    if (todayRow.direction === "flat") {
      note = "9:15 bar flat — no directional signal; skip.";
    } else if (abs < NINE_FIFTEEN_LIVE_MIN_ABS_DIFF) {
      side = "WAIT";
      note = `9:15 bar ${todayRow.direction === "up" ? "UP" : "DOWN"} but |Δ|=${abs.toFixed(2)} < ${NINE_FIFTEEN_LIVE_MIN_ABS_DIFF} — no entry.`;
    } else if (todayRow.direction === "up") {
      side = "CE";
      const band =
        abs >= NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF
          ? "main exits (±25→±20@10:01→±15@11:01)"
          : "near-miss exits (±20→±10@10:01)";
      note = `9:15 bar closed UP (+${todayRow.change.toFixed(2)} pts) — buy CE at 9:16 · ${band}`;
    } else {
      side = "PE";
      const band =
        abs >= NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF
          ? "main exits (±25→±20@10:01→±15@11:01)"
          : "near-miss exits (±20→±10@10:01)";
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
): NineFifteenFollowBacktestBlock {
  const target = NINE_FIFTEEN_FOLLOW_BACKTEST_TARGET;
  return {
    fromDate: rows[rows.length - 1]?.date ?? "",
    toDate: rows[0]?.date ?? "",
    nseSessions: rows.length,
    cePeGuide: buildCePeGuideForTarget(
      rows,
      target,
      NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF,
      includeTodaySignal,
    ),
    followFilterStats: computeFollowFilterStats(rows, target, NINE_FIFTEEN_FOLLOW_MIN_ABS_DIFF),
    nearMissFollow: buildNearMissFollowStats(rows, NINE_FIFTEEN_NEAR_MISS_TARGET),
    nearMissFollowFilterStats: computeFollowBandFilterStats(
      rows,
      NINE_FIFTEEN_NEAR_MISS_TARGET,
      NINE_FIFTEEN_NEAR_MISS_MIN_ABS_DIFF,
      NINE_FIFTEEN_NEAR_MISS_MAX_ABS_DIFF,
    ),
    liveConsolidatedFollow: buildLiveConsolidatedFollowStats(rows),
    liveConsolidatedFilterStats: computeLiveConsolidatedFilterStats(rows),
    breakout: buildBreakoutStats(rows, BREAKOUT_STOP_TIGHT, (row) => row.breakoutStopHit ?? null),
  };
}

const cache = new Map<string, { at: number; data: NineFifteenCandlesResult }>();
const CACHE_MS = 30 * 60_000;

export function invalidateNineFifteenCache() {
  cache.clear();
}

/** 9:15 bar + full session move from 9:15 open (for CE/PE +50 day targets). */
export async function fetchNineFifteenCandleHistory(
  accessToken: string,
  fetchCandles: CandleFetcher,
  daysRequested = NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  force = false,
): Promise<NineFifteenCandlesResult> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NINE_FIFTEEN_MAX_HISTORY_DAYS);
  const calendarLookback = calendarDaysForSessionLookback(ONE_YEAR_SESSION_ROWS);

  const cacheKey = `nine-fifteen:session:v63:1y-live-consolidated-rsi915-916-breakout-closest`;
  if (force) invalidateNineFifteenCache();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.data;
  }

  const tradingDates = listWeekdayDatesIst(calendarLookback);
  if (tradingDates.length === 0) {
    throw new Error("No dates in range");
  }

  const chunks = chunkTradingDates(tradingDates, CHUNK_TRADING_DAYS);
  const allRaw: unknown[] = [];

  for (const chunk of chunks) {
    const from = `${chunk[0]} 09:15:00`;
    const to = `${chunk[chunk.length - 1]} 15:30:00`;
    const { candles } = await fetchCandles(accessToken, NIFTY_SPOT_KEY, "minute", from, to);
    if (!Array.isArray(candles)) {
      throw new Error("Invalid candle response from Kite");
    }
    allRaw.push(...candles);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  if (allRaw.length === 0) {
    throw new Error("No historical candles returned from Kite for Nifty 50");
  }

  const rowsAll = parseSessionRows(allRaw);
  if (rowsAll.length === 0) {
    throw new Error("No complete NSE session days in Kite data (check 9:15–15:30 minute candles)");
  }

  const rows1y = rowsAll.slice(0, Math.min(ONE_YEAR_SESSION_ROWS, rowsAll.length));

  const block1y = buildFollowBacktestBlock(rows1y, true);

  const result: NineFifteenCandlesResult = {
    instrument: NIFTY_SPOT_KEY,
    daysRequested: days,
    dataSource: "zerodha_kite",
    fromDate: rows1y[rows1y.length - 1]?.date ?? tradingDates[0] ?? "",
    toDate: rows1y[0]?.date ?? tradingDates[tradingDates.length - 1] ?? "",
    rows: rows1y,
    summary: buildSummary(rows1y),
    nseSessionsOneYear: rows1y.length,
    cePeGuide: block1y.cePeGuide,
    followFilterStats: block1y.followFilterStats,
    nearMissFollow: block1y.nearMissFollow,
    nearMissFollowFilterStats: block1y.nearMissFollowFilterStats,
    liveConsolidatedFollow: block1y.liveConsolidatedFollow,
    liveConsolidatedFilterStats: block1y.liveConsolidatedFilterStats,
    breakout: block1y.breakout,
  };

  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}
