import { roundToOptionTick } from "../src/lib/kite-orders.js";
import { rsiWilderFromCloses } from "../src/lib/rsi.js";
import type {
  DayScalperCandle,
  DayScalperOutcome,
  DayScalperRules,
  DayScalperSide,
} from "../src/types/day-scalper.js";
import {
  DAY_SCALPER_INITIAL_TARGET_PTS,
  DAY_SCALPER_TRAIL_STEP_PTS,
  DAY_SCALPER_TRIGGER_PTS,
  DAY_SCALPER_TRADE_WINDOW_OPEN,
} from "../src/types/day-scalper.js";

/** Live bot defaults — min body 2 pts, close→mark gap 1.5 pt, initial stop −4% P&L, no hold. */
export const MOMENTUM_SCALPER_LIVE_RULES: DayScalperRules = {
  minMovePts: 2,
  signalMeasure: "range",
  triggerPts: DAY_SCALPER_TRIGGER_PTS,
  initialTargetPts: DAY_SCALPER_INITIAL_TARGET_PTS,
  trailStepPts: DAY_SCALPER_TRAIL_STEP_PTS,
  initialStopPts: 10,
  minCloseMarkPts: 1.5,
  sessionOpenIst: "09:15",
  sessionCloseIst: "15:30",
  tradeWindowOpenIst: DAY_SCALPER_TRADE_WINDOW_OPEN,
  tradeWindowCloseIst: "15:10",
  tuesdayTradeWindowCloseIst: "15:10",
};

const IST = "Asia/Kolkata";

export function istHmToMins(hm: string): number {
  const [hour, minute] = hm.split(":").map(Number);
  return hour * 60 + minute;
}

export function tradeWindowOpenMins(rules: DayScalperRules): number {
  return istHmToMins(rules.tradeWindowOpenIst);
}

/**
 * Last minute a *new* entry may be taken (15:10 every day). A trade already open keeps running
 * its own exit rules until {@link MOMENTUM_SCALPER_FORCE_EXIT_IST}.
 */
export function sessionCloseMinsForWeekday(_weekday: string, rules: DayScalperRules): number {
  return istHmToMins(rules.tradeWindowCloseIst);
}

/**
 * Final safety square-off for an open MIS leg. Zerodha auto-squares intraday positions shortly
 * after this, so the bot must close and book the trade itself first — otherwise the broker closes
 * it and the bot keeps believing it is still in a position. Matches the 9:16 bot's 15:25 exit.
 */
export const MOMENTUM_SCALPER_FORCE_EXIT_IST = "15:25";

/** True from 15:25 IST — an open leg must be squared off even if no target or stop has printed. */
export function isPastMomentumForceExit(now = new Date()): boolean {
  return istMinsFromDate(now) >= istHmToMins(MOMENTUM_SCALPER_FORCE_EXIT_IST);
}

export function entryInsideTradeWindow(mins: number, weekday: string, rules: DayScalperRules): boolean {
  return mins >= tradeWindowOpenMins(rules) && mins <= sessionCloseMinsForWeekday(weekday, rules);
}

/**
 * One shared formatter, built once.
 *
 * These two run on every websocket tick (the bot rebuilds its candle from each one), and
 * constructing an `Intl.DateTimeFormat` is orders of magnitude dearer than formatting with an
 * existing one. The instance is stateless, so hoisting it is free.
 */
const IST_HM_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function istHourMinute(date: Date): { hour: number; minute: number } {
  const parts = IST_HM_FORMAT.formatToParts(date);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { hour: hour % 24, minute };
}

export function istMinsFromDate(date: Date): number {
  const { hour, minute } = istHourMinute(date);
  return hour * 60 + minute;
}

export function istTimeLabel(date: Date): string {
  return formatIstMins(istMinsFromDate(date));
}

/** Minutes past midnight IST rendered as `HH:MM`. */
export function formatIstMins(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export type SignalBar = Pick<DayScalperCandle, "open" | "high" | "low" | "close">;

/**
 * Size of the signal candle on the scale its rules measure: the body, or the full high-to-low
 * range. Always positive.
 */
export function signalMagnitudePts(bar: SignalBar, rules: DayScalperRules): number {
  return (rules.signalMeasure ?? "body") === "range"
    ? bar.high - bar.low
    : Math.abs(bar.close - bar.open);
}

/**
 * The candle's size signed by its colour — positive for green, negative for red. This is the
 * number logged against a setup and stamped on a backtest row.
 */
export function signedSignalMovePts(bar: SignalBar, rules: DayScalperRules): number {
  const direction = Math.sign(bar.close - bar.open);
  return round2(signalMagnitudePts(bar, rules) * direction);
}

export function detectSignalSide(bar: SignalBar, rules: DayScalperRules): DayScalperSide | null {
  // A candle with no body has no colour, so it is neither a CE nor a PE idea however wide it ran.
  if (bar.close === bar.open) return null;
  if (signalMagnitudePts(bar, rules) <= rules.minMovePts) return null;
  return bar.close > bar.open ? "CE" : "PE";
}

/** Same 14-period Wilder RSI stamped on every Traps backtest trade row. */
export const MOMENTUM_SCALPER_RSI_PERIOD = 14;
/** Optional Traps entry filter — no CE buys when Nifty RSI is above this at the signal close. */
export const MOMENTUM_SCALPER_RSI_CE_MAX = 70;
/** Optional Traps entry filter — no PE buys when Nifty RSI is below this at the signal close. */
export const MOMENTUM_SCALPER_RSI_PE_MIN = 30;

/**
 * Live Traps only — entries are allowed only when Wilder RSI(14) on Nifty 1-min closes is inside
 * one of these bands (inclusive). Traps backtests use the same bands when the RSI filter toggle is on.
 */
export const MOMENTUM_LIVE_RSI_ALLOWED_BUCKETS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 10 },
  { min: 40, max: 50 },
  { min: 70, max: 100 },
];

export function formatMomentumLiveRsiBucketsLabel(): string {
  return MOMENTUM_LIVE_RSI_ALLOWED_BUCKETS.map((b) => `${b.min}–${b.max}`).join(", ");
}

export interface MomentumRsiEntryBlock {
  blocked: boolean;
  reason?: string;
}

/** Wilder RSI from a 1-min Nifty close series; the last close may be the live bar updating on ticks. */
export function momentumLiveRsiFromBarCloses(
  barCloses: number[],
  period = MOMENTUM_SCALPER_RSI_PERIOD,
): number | null {
  if (barCloses.length < period + 1) return null;
  const rsi = rsiWilderFromCloses(barCloses, period);
  return rsi != null && Number.isFinite(rsi) ? Math.round(rsi * 10) / 10 : null;
}

/** True when RSI sits in a live-allowed band (0–10, 40–50, or 70–100). */
export function momentumLiveRsiAllowsEntry(rsi: number | null): boolean {
  if (rsi == null || !Number.isFinite(rsi)) return false;
  return MOMENTUM_LIVE_RSI_ALLOWED_BUCKETS.some((b) => rsi >= b.min && rsi <= b.max);
}

export function momentumLiveRsiBlocksEntry(rsi: number | null): MomentumRsiEntryBlock {
  if (rsi == null || !Number.isFinite(rsi)) {
    return { blocked: true, reason: "RSI not ready — need 14 prior 1-min Nifty closes from ticks" };
  }
  if (momentumLiveRsiAllowsEntry(rsi)) return { blocked: false };
  return {
    blocked: true,
    reason: `RSI ${rsi.toFixed(1)} outside allowed bands (${formatMomentumLiveRsiBucketsLabel()})`,
  };
}

/** When enabled, blocks CE above {@link MOMENTUM_SCALPER_RSI_CE_MAX} and PE below {@link MOMENTUM_SCALPER_RSI_PE_MIN}. */
export function momentumRsiBlocksEntry(
  side: DayScalperSide,
  rsi: number | null,
  enabled: boolean,
): MomentumRsiEntryBlock {
  if (!enabled || rsi == null || !Number.isFinite(rsi)) return { blocked: false };
  if (side === "CE" && rsi > MOMENTUM_SCALPER_RSI_CE_MAX) {
    return {
      blocked: true,
      reason: `RSI ${rsi.toFixed(1)} > ${MOMENTUM_SCALPER_RSI_CE_MAX} — CE skipped`,
    };
  }
  if (side === "PE" && rsi < MOMENTUM_SCALPER_RSI_PE_MIN) {
    return {
      blocked: true,
      reason: `RSI ${rsi.toFixed(1)} < ${MOMENTUM_SCALPER_RSI_PE_MIN} — PE skipped`,
    };
  }
  return { blocked: false };
}

/** Nifty must continue the signal colour by at least this many points during the gate window. */
export const MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS = 0.2;

/** Websocket ticks in the first N seconds of candle 2 decide whether the gate passed. */
export const MOMENTUM_GATE_READ_SEC = 10;

/** Market entry fires at this second of candle 2 when the gate passed. */
export const MOMENTUM_ENTRY_SEC = 11;

export type MomentumEntrySkipReason = "no-pullback" | "outside-window" | "momentum-open";

export interface MomentumEntryDecision {
  side: DayScalperSide;
  signalMovePts: number;
  entryIndexPrice: number;
}

export type MomentumTriggerVerdict =
  | { action: "waiting" }
  | { action: "enter"; triggerPrice: number };

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The resting entry level: `minCloseMarkPts` back from the signal close, against the signal. */
export function momentumTriggerPrice(
  side: DayScalperSide,
  signalClose: number,
  minCloseMarkPts: number,
): number {
  return round2(signalClose + (side === "CE" ? -minCloseMarkPts : minCloseMarkPts));
}

/**
 * Live entry on the momentum candle. The level is fixed the instant candle 1 closes, so this is
 * just "has a tick reached it yet" — the same question the backtest asks of candle 2's low/high,
 * which is why the two agree on both the trigger and the fill price.
 */
export function evaluateMomentumPullbackTrigger(
  side: DayScalperSide,
  spot: number,
  signalClose: number,
  minCloseMarkPts: number,
): MomentumTriggerVerdict {
  if (!(spot > 0)) return { action: "waiting" };

  const triggerPrice = momentumTriggerPrice(side, signalClose, minCloseMarkPts);
  const hit = side === "CE" ? spot <= triggerPrice : spot >= triggerPrice;
  return hit ? { action: "enter", triggerPrice } : { action: "waiting" };
}

/** Level Nifty must reach in the signal direction during the gate window. */
export function momentumGateLevel(
  side: DayScalperSide,
  signalClose: number,
  gapPts = MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
): number {
  return round2(signalClose + (side === "CE" ? gapPts : -gapPts));
}

/**
 * True when a single Nifty print has continued candle 1 in the signal colour by at least `gapPts`.
 * Live Traps asks this of every websocket tick in the first {@link MOMENTUM_GATE_READ_SEC} seconds.
 */
export function momentumGateTickPasses(
  side: DayScalperSide,
  spot: number,
  signalClose: number,
  gapPts = MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
): boolean {
  if (!(spot > 0) || !(signalClose > 0)) return false;
  const level = momentumGateLevel(side, signalClose, gapPts);
  if (side === "CE") return spot + 1e-9 >= level;
  return spot <= level + 1e-9;
}

/** @deprecated Name kept for Day Scalper — same tick test as {@link momentumGateTickPasses}. */
export function momentumMinuteOpenPasses(
  side: DayScalperSide,
  momentumOpen: number,
  signalClose: number,
  gapPts = MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
): boolean {
  return momentumGateTickPasses(side, momentumOpen, signalClose, gapPts);
}

/** Required Nifty level during the gate window (CE: signal close + gap, PE: close − gap). */
export function momentumMinuteOpenMin(
  side: DayScalperSide,
  signalClose: number,
  gapPts = MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
): number {
  return momentumGateLevel(side, signalClose, gapPts);
}

/**
 * Minute-bar stand-in for the live 10-second gate.
 *
 * Backtests only have OHLC, so the open is the :00 tick and a same-minute high/low touch is
 * credited when the open alone did not clear the gate — the closest honest approximation of
 * "seen in the opening seconds" without tick replay.
 */
export function momentumGateSeenInMinuteBar(
  side: DayScalperSide,
  bar: { open: number; high: number; low: number },
  signalClose: number,
  gapPts = MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
): boolean {
  if (momentumGateTickPasses(side, bar.open, signalClose, gapPts)) return true;
  const level = momentumGateLevel(side, signalClose, gapPts);
  if (side === "CE") return bar.high + 1e-9 >= level;
  return bar.low <= level + 1e-9;
}

const IST_HMS_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Whole seconds elapsed within the current IST minute (0–59). */
export function istSecondsIntoMinute(atMs: number): number {
  const parts = IST_HMS_FORMAT.formatToParts(new Date(atMs));
  for (const part of parts) {
    if (part.type === "second") return Number(part.value);
  }
  return 0;
}

/** Milliseconds until `targetSec` within the current IST minute; 0 when already there or past. */
export function msUntilSecondOfCurrentIstMinute(targetSec: number, nowMs = Date.now()): number {
  const sec = istSecondsIntoMinute(nowMs);
  if (sec >= targetSec) return 0;
  return (targetSec - sec) * 1000;
}

/**
 * The Traps entry is a market buy at second :11 when the 10-second momentum gate was seen.
 *
 * It used to rest a MIS limit ₹0.5 under the marked premium for 50 seconds, waiting for the option
 * to retrace onto it. That bought a better fill on the trades it caught and nothing at all on the
 * rest: a setup whose premium ran straight up was simply dropped, which is the half of the
 * distribution the signal is trying to be in. Crossing the spread costs less than missing those.
 *
 * The pullback helpers above are still the Day Scalper backtest's entry model, which is why they
 * remain here; nothing on the Traps path reads them.
 */

/**
 * Backtest entry on the momentum bar. The trigger level comes from candle 1's close alone, so the
 * bar's low/high only answer whether price reached it — the fill price never depends on where the
 * extreme happened to land.
 */
export function evaluateMomentumEntry(
  signalBar: SignalBar,
  momentumBar: Pick<DayScalperCandle, "mins" | "open" | "low" | "high">,
  weekday: string,
  rules: DayScalperRules = MOMENTUM_SCALPER_LIVE_RULES,
):
  | {
      action: "enter";
      side: DayScalperSide;
      signalMovePts: number;
      triggerPrice: number;
      entryIndexPrice: number;
    }
  | { action: "skip"; reason: MomentumEntrySkipReason } {
  const side = detectSignalSide(signalBar, rules);
  if (!side) return { action: "skip", reason: "no-pullback" };

  if (!entryInsideTradeWindow(momentumBar.mins, weekday, rules)) {
    return { action: "skip", reason: "outside-window" };
  }

  if (!momentumMinuteOpenPasses(side, momentumBar.open, signalBar.close)) {
    return { action: "skip", reason: "momentum-open" };
  }

  const triggerPrice = momentumTriggerPrice(side, signalBar.close, rules.minCloseMarkPts);
  const reached =
    side === "CE" ? momentumBar.low <= triggerPrice : momentumBar.high >= triggerPrice;
  if (!reached) return { action: "skip", reason: "no-pullback" };

  return {
    action: "enter",
    side,
    signalMovePts: signedSignalMovePts(signalBar, rules),
    triggerPrice,
    entryIndexPrice: triggerPrice,
  };
}

/** Live scan begins at the 9:15 candle — no 9:16 bot handoff. */
/**
 * Scanning opens at 09:30 IST. The first fifteen minutes were the worst window by a distance in
 * the Aug 26–28 option-candle backtest — the 09:15–09:30 entries lost ₹39.9k while the rest of the
 * session made ₹136.7k — so the open is sat out rather than traded.
 */
export const MOMENTUM_SCALPER_SCAN_START_MINS = 9 * 60 + 30;

/**
 * Live Traps entry windows only — backtests keep scanning {@link MOMENTUM_SCALPER_SCAN_START_MINS}–15:10.
 * Open legs are never cut at a window end; only new entries pause until the next window or 15:10.
 */
export const MOMENTUM_SCALPER_LIVE_MORNING_START_MINS = 10 * 60 + 30;
export const MOMENTUM_SCALPER_LIVE_MORNING_END_MINS = 12 * 60;
export const MOMENTUM_SCALPER_LIVE_AFTERNOON_START_MINS = 13 * 60 + 45;
export const MOMENTUM_SCALPER_LIVE_AFTERNOON_END_MINS = 15 * 60 + 10;

/** True when the clock is inside a live Traps entry window (not used by the backtest). */
export function momentumLiveEntryAllowed(mins: number): boolean {
  return (
    (mins >= MOMENTUM_SCALPER_LIVE_MORNING_START_MINS && mins < MOMENTUM_SCALPER_LIVE_MORNING_END_MINS) ||
    (mins >= MOMENTUM_SCALPER_LIVE_AFTERNOON_START_MINS &&
      mins < MOMENTUM_SCALPER_LIVE_AFTERNOON_END_MINS)
  );
}

/** After the afternoon window — no more entries today; open legs still run their exits. */
export function momentumLiveDayEntryCutoffReached(mins: number): boolean {
  return mins >= MOMENTUM_SCALPER_LIVE_AFTERNOON_END_MINS;
}

export function formatMomentumLiveScheduleLabel(): string {
  return (
    `${formatIstMins(MOMENTUM_SCALPER_LIVE_MORNING_START_MINS)}–` +
    `${formatIstMins(MOMENTUM_SCALPER_LIVE_MORNING_END_MINS)} & ` +
    `${formatIstMins(MOMENTUM_SCALPER_LIVE_AFTERNOON_START_MINS)}–` +
    `${formatIstMins(MOMENTUM_SCALPER_LIVE_AFTERNOON_END_MINS)}`
  );
}

/** Next live entry window start, or null if the day is done or a window is already open. */
export function momentumNextLiveEntryOpenMins(nowMins: number): number | null {
  if (momentumLiveEntryAllowed(nowMins)) return null;
  if (nowMins < MOMENTUM_SCALPER_LIVE_MORNING_START_MINS) {
    return MOMENTUM_SCALPER_LIVE_MORNING_START_MINS;
  }
  if (nowMins < MOMENTUM_SCALPER_LIVE_AFTERNOON_START_MINS) {
    return MOMENTUM_SCALPER_LIVE_AFTERNOON_START_MINS;
  }
  return null;
}

/**
 * Entries between 09:15 and 09:20 IST (inclusive) use the wider opening-window ladder; the profile
 * is frozen at entry and kept even if the trade runs past 09:20.
 *
 * Nothing reaches this profile while scanning starts at 09:30. The window is deliberately left
 * intact so bringing the early open back is a one-constant change, not a rewrite.
 */
export const MOMENTUM_OPENING_ENTRY_START_MINS = 9 * 60 + 15;
export const MOMENTUM_OPENING_ENTRY_END_MINS = 9 * 60 + 20;

export type MomentumExitProfile = "standard" | "opening";

export interface MomentumExitProfileConfig {
  armPct: number;
  stepPct: number;
  initialStopLossPct: number;
  initialStopHoldMs: number;
  /**
   * Loss that exits at once regardless of the ladder, so a locked rung is no reason to sit
   * through a collapse. Only reachable for profiles that still hold a breach of the initial stop.
   */
  hardStopLossPct: number;
  maxLockPct: number;
  rungs: number[];
}

/**
 * Standard P&L ladder from entry: +0.50%, +0.70%, +1%, then +0.5% steps (1.5, 2, 2.5, …).
 *
 * Reaching a rung only moves the ladder on — it locks that rung as the floor and points the next
 * target one rung higher. Nothing is sold until price comes back down and touches the locked
 * floor. Exits use option premium % only, never the Nifty index.
 */
export const MOMENTUM_SCALPER_PNL_ARM_PCT = 0.5;
/** Second rung after the initial +0.5% floor — kept separate from the +0.5% steps that follow +1%. */
export const MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT = 0.7;
export const MOMENTUM_SCALPER_PNL_STEP_PCT = 0.5;
/**
 * How far below the locked floor the exit limit is priced.
 *
 * The exit is a *marketable* limit: at the moment it goes out the market is sitting on the locked
 * floor, so pricing the sell a tenth of a percent under it puts the order through the touch and it
 * trades on arrival. Pricing it at the floor itself would rest at the offer and wait.
 */
export const MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT = 0.1;
/** Loss at or below this % of premium (P&L ≤ −4%) triggers the initial stop. */
export const MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT = 4;
/** Display / API alias for the initial stop level on the P&L scale. */
export const MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT = -MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT;
/**
 * No grace period: the first reading at −4% or worse exits.
 *
 * The stop used to sit at −3% and wait three unbroken seconds, so a trade could ride a spike back
 * out of trouble. The wider level pays for that on its own — by −4% the move has already had its
 * room, and holding past it only means selling further down.
 */
export const MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS = 0;
/**
 * Backstop for a collapse that arrives after a rung is already locked, where the initial stop no
 * longer applies. Below the ladder's floor this is unreachable — the instant −4% exit fires first.
 */
export const MOMENTUM_SCALPER_HARD_STOP_LOSS_PCT = 6;

/** Opening-window ladder: first rung +5%, then +5% steps; initial stop below −10% held 15s. */
export const MOMENTUM_OPENING_PNL_ARM_PCT = 5;
export const MOMENTUM_OPENING_PNL_STEP_PCT = 5;
export const MOMENTUM_OPENING_INITIAL_STOP_LOSS_PCT = 10;
export const MOMENTUM_OPENING_INITIAL_STOP_PNL_PCT = -MOMENTUM_OPENING_INITIAL_STOP_LOSS_PCT;
/** Exit only after P&L stays below −10% (−11%, −12%, …) for a full 15 seconds. */
export const MOMENTUM_OPENING_INITIAL_STOP_HOLD_MS = 15_000;
/** Double its own initial stop, the same shape the standard profile's −4% / −6% keeps. */
export const MOMENTUM_OPENING_HARD_STOP_LOSS_PCT = 20;


function buildMomentumPnlRungs(armPct: number, stepPct: number, maxPct = 200): number[] {
  const rungs = [armPct];
  for (let p = armPct + stepPct; p <= maxPct; p += stepPct) {
    rungs.push(p);
  }
  return rungs;
}

export const MOMENTUM_SCALPER_PNL_RUNGS: number[] = (() => {
  const rungs = [MOMENTUM_SCALPER_PNL_ARM_PCT, MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT];
  // Counted in tenths of a percent. Adding 0.5 repeatedly drifts in binary floating point, and a
  // rung of 2.4999999999 never matches the `indexOf` that finds the next target.
  for (let tenths = 10; tenths <= 2000; tenths += MOMENTUM_SCALPER_PNL_STEP_PCT * 10) {
    rungs.push(tenths / 10);
  }
  return rungs;
})();
export const MOMENTUM_OPENING_PNL_RUNGS: number[] = buildMomentumPnlRungs(
  MOMENTUM_OPENING_PNL_ARM_PCT,
  MOMENTUM_OPENING_PNL_STEP_PCT,
  200,
);

/**
 * The ladder ratchets and never steps back down, so one bad P&L reading would lock a rung the
 * trade can never meet and force an instant stop-out. Readings above this are treated as bad data.
 */
export const MOMENTUM_SCALPER_PNL_MAX_LOCK_PCT = 200;

export const MOMENTUM_STANDARD_EXIT_CONFIG: MomentumExitProfileConfig = {
  armPct: MOMENTUM_SCALPER_PNL_ARM_PCT,
  stepPct: MOMENTUM_SCALPER_PNL_STEP_PCT,
  initialStopLossPct: MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT,
  initialStopHoldMs: MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  hardStopLossPct: MOMENTUM_SCALPER_HARD_STOP_LOSS_PCT,
  maxLockPct: MOMENTUM_SCALPER_PNL_MAX_LOCK_PCT,
  rungs: MOMENTUM_SCALPER_PNL_RUNGS,
};

export const MOMENTUM_OPENING_EXIT_CONFIG: MomentumExitProfileConfig = {
  armPct: MOMENTUM_OPENING_PNL_ARM_PCT,
  stepPct: MOMENTUM_OPENING_PNL_STEP_PCT,
  initialStopLossPct: MOMENTUM_OPENING_INITIAL_STOP_LOSS_PCT,
  initialStopHoldMs: MOMENTUM_OPENING_INITIAL_STOP_HOLD_MS,
  hardStopLossPct: MOMENTUM_OPENING_HARD_STOP_LOSS_PCT,
  maxLockPct: MOMENTUM_SCALPER_PNL_MAX_LOCK_PCT,
  rungs: MOMENTUM_OPENING_PNL_RUNGS,
};

export function momentumExitProfileConfig(
  profile: MomentumExitProfile = "standard",
): MomentumExitProfileConfig {
  return profile === "opening" ? MOMENTUM_OPENING_EXIT_CONFIG : MOMENTUM_STANDARD_EXIT_CONFIG;
}

export function momentumExitProfileForEntryMins(entryMins: number): MomentumExitProfile {
  return entryMins >= MOMENTUM_OPENING_ENTRY_START_MINS && entryMins <= MOMENTUM_OPENING_ENTRY_END_MINS
    ? "opening"
    : "standard";
}

/** Unrealised P&L as a percentage of the premium paid at entry. Null when unknown. */
export function momentumPnlPctOfEntryCost(
  unrealisedPnl: number | null,
  entryPrice: number,
  quantity: number,
): number | null {
  if (unrealisedPnl == null || !Number.isFinite(unrealisedPnl)) return null;
  if (entryPrice <= 0 || quantity <= 0) return null;
  return (unrealisedPnl / (entryPrice * quantity)) * 100;
}

/** Option premium at which a long leg prints exactly `pnlPct` profit on the entry price. */
export function momentumOptionPriceForPnlPct(entryPrice: number, pnlPct: number): number {
  if (!(entryPrice > 0) || !Number.isFinite(pnlPct)) return 0;
  const raw = entryPrice * (1 + pnlPct / 100);
  return Math.round(roundToOptionTick(raw) * 100) / 100;
}

/** Profit the exit aims for when the locked floor is touched: the floor less the giveback. */
export function momentumProfitExitPnlPct(
  lockedPnlPct: number,
  givebackPct = MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT,
): number {
  return Math.round((lockedPnlPct - givebackPct) * 100) / 100;
}

/**
 * Marketable limit price for a profit exit off the locked floor.
 *
 * Never allowed to land at or below the entry price: a floor that is smaller than the giveback
 * would otherwise price the sell at a loss, which is the one thing this exit exists to avoid.
 */
export function momentumProfitExitLimitPrice(
  entryPrice: number,
  lockedPnlPct: number,
  givebackPct = MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT,
): number {
  if (!(entryPrice > 0) || !(lockedPnlPct > 0)) return 0;
  const targetPct = Math.max(momentumProfitExitPnlPct(lockedPnlPct, givebackPct), 0);
  const price = momentumOptionPriceForPnlPct(entryPrice, targetPct);
  return price > entryPrice ? price : momentumOptionPriceForPnlPct(entryPrice, lockedPnlPct);
}

/**
 * Worst P&L a long option can actually print: the premium goes to zero and nothing more is at
 * risk. A reading below this is arithmetically impossible, so it is bad data — a stale or
 * mispriced tick, or an entry price that never got booked properly.
 */
export const MOMENTUM_SCALPER_PNL_MIN_PLAUSIBLE_PCT = -100;

/** True when a P&L percentage is usable for the ladder. */
export function isPlausibleMomentumPnlPct(
  pnlPct: number | null,
  maxLockPct = MOMENTUM_SCALPER_PNL_MAX_LOCK_PCT,
): boolean {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return false;
  // Bounded on both sides. The upper bound stops a bad tick locking a rung the trade can never
  // meet; the lower one stops that same bad tick slamming a healthy position out at market.
  return pnlPct <= maxLockPct && pnlPct >= MOMENTUM_SCALPER_PNL_MIN_PLAUSIBLE_PCT;
}

/** Highest rung locked so far: 0 before the first arm rung prints, then arm, arm+step, … */
export function nextMomentumLockedPnlPct(
  lockedPct: number,
  pnlPct: number | null,
  profile: MomentumExitProfile = "standard",
): number {
  const config = momentumExitProfileConfig(profile);
  const current = Number.isFinite(lockedPct) && lockedPct > 0 ? lockedPct : 0;
  if (!isPlausibleMomentumPnlPct(pnlPct, config.maxLockPct) || pnlPct == null) return current;
  if (pnlPct < config.armPct) return current;
  let next = current;
  for (const rung of config.rungs) {
    if (pnlPct + 1e-9 >= rung) next = Math.max(next, rung);
    else break;
  }
  return Math.min(next, config.maxLockPct);
}

/** Take-profit rung — where the ladder expands next, not an exit level. */
export function momentumPnlTargetPct(
  lockedPct: number,
  profile: MomentumExitProfile = "standard",
): number {
  const config = momentumExitProfileConfig(profile);
  if (!(lockedPct > 0)) return config.armPct;
  const idx = config.rungs.indexOf(lockedPct);
  if (idx >= 0 && idx + 1 < config.rungs.length) {
    return config.rungs[idx + 1];
  }
  return lockedPct + config.stepPct;
}

/** Stop rung — before the first arm rung locks, the initial P&L stop applies. */
export function momentumPnlStopPct(
  lockedPct: number,
  profile: MomentumExitProfile = "standard",
): number | null {
  const config = momentumExitProfileConfig(profile);
  if (lockedPct >= config.armPct) return lockedPct;
  return -config.initialStopLossPct;
}

export function isMomentumInitialStopPnlBreached(
  pnlPct: number | null,
  profile: MomentumExitProfile = "standard",
): boolean {
  const config = momentumExitProfileConfig(profile);
  if (!isPlausibleMomentumPnlPct(pnlPct, config.maxLockPct) || pnlPct == null) return false;
  if (profile === "opening") return pnlPct < -config.initialStopLossPct;
  return pnlPct <= -config.initialStopLossPct;
}

/**
 * Loss deep enough to exit on the spot, whatever the hold timer is doing.
 *
 * Screened by the same plausibility guard as every other reading, so a single garbage tick cannot
 * fire it — the ladder already refuses to lock on implausible P&L and the emergency exit has to be
 * at least as careful.
 */
export function isMomentumHardStopBreached(
  pnlPct: number | null,
  profile: MomentumExitProfile = "standard",
): boolean {
  const config = momentumExitProfileConfig(profile);
  if (!isPlausibleMomentumPnlPct(pnlPct, config.maxLockPct) || pnlPct == null) return false;
  return pnlPct <= -config.hardStopLossPct;
}

/**
 * Exit once a rung is locked and profit comes back down to it.
 *
 * Inclusive of the floor itself: the rule is "falls back to the locked level", not "falls through
 * it". The caller must not run this on the same evaluation that advanced the ladder, or every rung
 * would sell itself the instant it locked.
 */
export function shouldExitOnMomentumPnl(
  lockedPct: number,
  pnlPct: number | null,
  profile: MomentumExitProfile = "standard",
): boolean {
  const config = momentumExitProfileConfig(profile);
  if (lockedPct < config.armPct) return false;
  if (pnlPct == null || !Number.isFinite(pnlPct)) return false;
  return pnlPct <= lockedPct;
}

export interface MomentumScalperExitState {
  side: DayScalperSide;
  entryIndexPrice: number;
  /** Frozen at entry — opening-window trades keep the 5% ladder even after 09:20. */
  exitProfile: MomentumExitProfile;
  /** Highest P&L rung locked (0 = not locked yet). */
  lockedPnlPct: number;
  /** When P&L first touched the initial stop; used only when the profile has a hold timer. */
  initialStopBreachSinceMs: number | null;
}

export function createExitState(
  side: DayScalperSide,
  entryIndexPrice: number,
  profile: MomentumExitProfile = "standard",
): MomentumScalperExitState {
  return {
    side,
    entryIndexPrice,
    exitProfile: profile,
    lockedPnlPct: 0,
    initialStopBreachSinceMs: null,
  };
}

export interface MomentumScalperExitHit {
  outcome: DayScalperOutcome;
  exitIndexPrice: number;
  /** P&L rung the stop was sitting on, when the exit came from the ladder. */
  lockedPnlPct: number;
  /**
   * True when the loss blew through the hard floor. The caller sends this one straight to market
   * instead of working a limit — the whole point of the level is that there is no time to shop.
   */
  hardStop?: boolean;
}

export interface MomentumExitInput {
  /**
   * Current Nifty spot. Only stamped onto the exit for the record — every level the engine tests
   * is measured in option P&L, so the index cannot trigger anything on its own. It still has to be
   * a real price: a zero means the feed has not primed and the tick is skipped rather than acted on.
   */
  spot: number;
  /** Own-leg unrealised P&L as a percentage of premium paid. Null while unknown. */
  pnlPct: number | null;
  /** Wall-clock ms for profiles that use a timed initial stop (e.g. opening window). */
  nowMs: number;
}

/**
 * Exit engine:
 *
 * 1. Pre-ladder — while no profit rung is locked, a breach of the initial P&L stop exits. The
 *    standard profile exits on the first breaching reading; the opening profile holds one out
 *    first, and recovering above the stop cancels that hold.
 * 2. P&L ladder — reaching a rung locks it as the floor and points the target one rung higher;
 *    the exit fires only when P&L later comes back down to that floor.
 */
export function evaluateMomentumExit(
  state: MomentumScalperExitState,
  input: MomentumExitInput,
  /** When set (e.g. Traps backtest stop sweep), overrides the profile's default config. */
  exitConfig?: MomentumExitProfileConfig,
): { state: MomentumScalperExitState; exit?: MomentumScalperExitHit } {
  const profile = state.exitProfile ?? "standard";
  const config = exitConfig ?? momentumExitProfileConfig(profile);
  const next = { ...state, exitProfile: profile };
  const spot = input.spot;
  if (!(spot > 0)) return { state: next };

  // Stage 0 — hard floor. Checked before anything else and regardless of the ladder, because a
  // locked rung is no reason to sit through a collapse either.
  if (
    isPlausibleMomentumPnlPct(input.pnlPct, config.maxLockPct) &&
    input.pnlPct != null &&
    input.pnlPct <= -config.hardStopLossPct
  ) {
    return {
      state: next,
      exit: {
        outcome: "stop",
        exitIndexPrice: spot,
        lockedPnlPct: next.lockedPnlPct,
        hardStop: true,
      },
    };
  }

  // Stage 1 — initial P&L stop, only while no profit rung is locked.
  if (next.lockedPnlPct < config.armPct) {
    const initialStopBreached =
      isPlausibleMomentumPnlPct(input.pnlPct, config.maxLockPct) &&
      input.pnlPct != null &&
      (profile === "opening"
        ? input.pnlPct < -config.initialStopLossPct
        : input.pnlPct <= -config.initialStopLossPct);
    if (initialStopBreached) {
      if (config.initialStopHoldMs <= 0) {
        return {
          state: next,
          exit: { outcome: "stop", exitIndexPrice: spot, lockedPnlPct: 0 },
        };
      }
      if (next.initialStopBreachSinceMs == null) {
        next.initialStopBreachSinceMs = input.nowMs;
      } else if (input.nowMs - next.initialStopBreachSinceMs >= config.initialStopHoldMs) {
        return {
          state: next,
          exit: { outcome: "stop", exitIndexPrice: spot, lockedPnlPct: 0 },
        };
      }
    } else if (isPlausibleMomentumPnlPct(input.pnlPct, config.maxLockPct)) {
      // Any usable reading that is not a breach cancels the timer. Comparing against the stop
      // level again would leave a dead zone for the opening profile, whose breach is strictly
      // below −10%: a P&L sitting at exactly −10% would neither breach nor reset, so the elapsed
      // hold would keep accruing across a stretch the rule does not count.
      next.initialStopBreachSinceMs = null;
    }
  }

  // Stage 2 — P&L ladder (premium % only).
  const lockedBefore = next.lockedPnlPct;
  next.lockedPnlPct = nextMomentumLockedPnlPct(next.lockedPnlPct, input.pnlPct, profile);

  // Reaching a rung only moves the ladder on. Selling here would exit every trade the moment it
  // first touched the arm rung, since the floor and the price are the same number on that evaluation.
  if (next.lockedPnlPct > lockedBefore) return { state: next };

  if (
    next.lockedPnlPct >= config.armPct &&
    input.pnlPct != null &&
    Number.isFinite(input.pnlPct) &&
    input.pnlPct <= next.lockedPnlPct
  ) {
    return {
      state: next,
      exit: { outcome: "trail-stop", exitIndexPrice: spot, lockedPnlPct: next.lockedPnlPct },
    };
  }

  return { state: next };
}

export function indexPnlPts(
  side: DayScalperSide,
  entryIndexPrice: number,
  exitIndexPrice: number,
): number {
  const signed = side === "CE" ? 1 : -1;
  return Math.round(signed * (exitIndexPrice - entryIndexPrice) * 100) / 100;
}