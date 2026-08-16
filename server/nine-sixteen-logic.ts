import type { ParsedCandle } from "../src/lib/candles.js";
import { getIndianMarketContext } from "../src/lib/market-time.js";
import type { TradeLeg } from "../src/lib/trade-calculations.js";
import type { NineFifteenDirection } from "../src/types/nine-fifteen.js";

export const NINE_SIXTEEN_INDEX_TARGET = 25;
/** From 10:01 IST — tighten index exit to ±20 from entry spot. */
export const NINE_SIXTEEN_INDEX_TARGET_20 = 20;
export const NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE = 10 * 60 + 1;
/** From 11:01 IST — tighten index exit to ±15 from entry spot. */
export const NINE_SIXTEEN_INDEX_TARGET_15 = 15;
export const NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE = 11 * 60 + 1;
/**
 * Live entry bands by |9:15 close − open|:
 * · ≥ 15 → main exits (±25 → ±20@10:01 → ±15@11:01)
 * · 11 ≤ |Δ| < 15 → near-miss exits (±20 → ±10@10:01)
 * · < 11 → skip
 */
export const NINE_SIXTEEN_MIN_915_ABS_DIFF = 15;
export const NINE_SIXTEEN_NEAR_MISS_MIN_915_ABS_DIFF = 11;
/** Near-miss index exit: ±20 until 10:01, then ±10. */
export const NINE_SIXTEEN_NEAR_MISS_INDEX_TARGET = 20;
export const NINE_SIXTEEN_NEAR_MISS_INDEX_TARGET_AFTER = 10;
export const NINE_SIXTEEN_NEAR_MISS_SWITCH_MINUTE = 10 * 60 + 1;

export type NineSixteenExitMode = "main" | "near_miss";
export const NINE_SIXTEEN_PNL_TARGET_PCT = 3;
/** +10% P&L exit: 9:16 AM through 10:00 AM IST (inclusive). */
export const NINE_SIXTEEN_PNL_MORNING_TARGET_PCT = 10;
export const NINE_SIXTEEN_PNL_MORNING_EXIT_START_MINUTE = 9 * 60 + 16;
export const NINE_SIXTEEN_PNL_MORNING_EXIT_END_MINUTE = 10 * 60;
/** +5% P&L exit: 10:01 AM through 11:00 AM IST (inclusive). */
export const NINE_SIXTEEN_PNL_EARLY_TARGET_PCT = 5;
export const NINE_SIXTEEN_PNL_EARLY_EXIT_START_MINUTE = 10 * 60 + 1;
export const NINE_SIXTEEN_PNL_EARLY_EXIT_END_MINUTE = 11 * 60;
/** +3% P&L exit from 11:01 AM IST onward. */
export const NINE_SIXTEEN_PNL_EXIT_START_MINUTE = 11 * 60 + 1;
/** From 3:00 PM IST — exit if Nifty is within this many index points of the ±target level (unused in live bot). */
export const NINE_SIXTEEN_NEAR_TARGET_EXIT_START_MINUTE = 15 * 60;
export const NINE_SIXTEEN_NEAR_TARGET_MAX_DISTANCE = 50;

/**
 * Live entry timing (IST):
 * 9:00:00–16:00:00 keep Kite WS up · first Nifty tick in 9:15:00–9:15:15 = open
 * last tick before 9:16:00 = close (9:15:59) · enter immediately at 9:16:00.
 */
export const NINE_SIXTEEN_WS_CONNECT_SEC = 9 * 3600;
/** Drop Kite websocket after 16:00 IST (market already closed). */
export const NINE_SIXTEEN_WS_DISCONNECT_SEC = 16 * 3600;
export const NINE_SIXTEEN_OPEN_TICK_START_SEC = 9 * 3600 + 15 * 60;
export const NINE_SIXTEEN_OPEN_TICK_END_SEC = 9 * 3600 + 15 * 60 + 15;
export const NINE_SIXTEEN_CLOSE_SEAL_SEC = 9 * 3600 + 16 * 60;
/** @deprecated first WS tick in 9:15:00–9:15:15 is open */
export const NINE_SIXTEEN_OPEN_CAPTURE_SEC = NINE_SIXTEEN_OPEN_TICK_START_SEC;
/** @deprecated close seals at 9:16:00 from last WS tick */
export const NINE_SIXTEEN_OHLC_CAPTURE_SEC = NINE_SIXTEEN_CLOSE_SEAL_SEC;
/** @deprecated use NINE_SIXTEEN_CLOSE_SEAL_SEC */
export const NINE_SIXTEEN_CLOSE_CAPTURE_SEC = NINE_SIXTEEN_CLOSE_SEAL_SEC;
/** Place CE/PE as soon as 9:16:00 starts (close already sealed). */
export const NINE_SIXTEEN_ENTRY_SEC = 9 * 3600 + 16 * 60;
/** @deprecated no buffer after 9:16:00 */
export const NINE_SIXTEEN_ENTRY_BUFFER_SEC = 0;
/** Entry order window ends at 9:16:30 IST (seconds of day). */
export const NINE_SIXTEEN_ENTRY_WINDOW_END_SEC = 9 * 3600 + 16 * 60 + 30;
/** From 9:00 — warm instruments, egress route and balance so 9:16:00 makes no cold calls. */
export const NINE_SIXTEEN_PREWARM_SEC = NINE_SIXTEEN_WS_CONNECT_SEC;
/** At 9:15:58 — resolve ATM CE + PE from the live websocket spot, before the close is sealed. */
export const NINE_SIXTEEN_PRE_RESOLVE_SEC = 9 * 3600 + 15 * 60 + 58;
/** @deprecated use NINE_SIXTEEN_ENTRY_WINDOW_END_SEC */
export const NINE_SIXTEEN_ENTRY_WINDOW_END_MINUTE = Math.floor(NINE_SIXTEEN_ENTRY_WINDOW_END_SEC / 60);
/** Kite allows 1 /quote request per second — never poll faster than that. */
export const NINE_SIXTEEN_SPOT_POLL_MS = 1000;
const SPOT_POLL_MIN_MS = 1000;
const SPOT_POLL_MAX_MS = 5000;

/** How often the bot polls Kite /quote for Nifty + option LTP while in a trade (env override). */
export function getNineSixteenSpotPollMs(): number {
  const raw = process.env.NINE_SIXTEEN_SPOT_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : NINE_SIXTEEN_SPOT_POLL_MS;
  if (!Number.isFinite(parsed)) return NINE_SIXTEEN_SPOT_POLL_MS;
  return Math.min(SPOT_POLL_MAX_MS, Math.max(SPOT_POLL_MIN_MS, Math.round(parsed)));
}

export interface NineSixteen915Bar {
  open: number;
  close: number;
  high: number;
  low: number;
  change: number;
  direction: NineFifteenDirection;
}

function istTimeParts(date: Date) {
  const ctx = getIndianMarketContext(date);
  const [hour, minute, second] = ctx.timeIST.split(":").map(Number);
  return { hour, minute, second };
}

export function istSecondsOfDay(date = new Date()): number {
  const { hour, minute, second } = istTimeParts(date);
  return hour * 3600 + minute * 60 + second;
}

/**
 * Milliseconds elapsed in the IST day. IST is offset by whole minutes, so the sub-second part
 * of the epoch is identical to the sub-second part in IST.
 */
export function istMsOfDay(nowMs = Date.now()): number {
  return istSecondsOfDay(new Date(nowMs)) * 1000 + (nowMs % 1000);
}

/** Signed ms until 9:16:00.000 IST — negative once the entry instant has passed. */
export function msUntilEntryInstant(nowMs = Date.now()): number {
  return NINE_SIXTEEN_ENTRY_SEC * 1000 - istMsOfDay(nowMs);
}

function nineSixteenEntryWindowEndSec(): number {
  return NINE_SIXTEEN_ENTRY_WINDOW_END_SEC;
}

function msUntilSecOfDay(targetSec: number, nowMs = Date.now()): number {
  const ctx = getIndianMarketContext(new Date(nowMs));
  if (ctx.sessionStatus === "closed_weekend") return 60_000;
  if (ctx.sessionStatus === "post_market") return 60_000;
  const nowSec = istSecondsOfDay(new Date(nowMs));
  if (nowSec >= targetSec) return 0;
  return Math.max(250, (targetSec - nowSec) * 1000);
}

/** Ms until 9:00:00 websocket connect (or 0 if due). */
export function msUntilWsConnect(nowMs = Date.now()): number {
  return msUntilSecOfDay(NINE_SIXTEEN_WS_CONNECT_SEC, nowMs);
}

/**
 * Ms until 16:00:00 websocket disconnect (or 0 if due). Unlike the entry helpers this
 * ignores session status — the socket must drop at 16:00 sharp, well after market close.
 */
export function msUntilWsDisconnect(nowMs = Date.now()): number {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  if (nowSec >= NINE_SIXTEEN_WS_DISCONNECT_SEC) return 0;
  return (NINE_SIXTEEN_WS_DISCONNECT_SEC - nowSec) * 1000;
}

/** @deprecated use msUntilWsConnect / msUntilCloseSeal */
export function msUntilOhlcCapture(nowMs = Date.now()): number {
  return msUntilSecOfDay(NINE_SIXTEEN_CLOSE_SEAL_SEC, nowMs);
}

/** @deprecated */
export function msUntilOpenCapture(nowMs = Date.now()): number {
  return msUntilSecOfDay(NINE_SIXTEEN_OPEN_TICK_START_SEC, nowMs);
}

/** @deprecated */
export function msUntilCloseCapture(nowMs = Date.now()): number {
  return msUntilSecOfDay(NINE_SIXTEEN_CLOSE_SEAL_SEC, nowMs);
}

/** Ms until 9:16:00 order entry (or 0 if due). */
export function msUntil916Entry(nowMs = Date.now()): number {
  return msUntilSecOfDay(NINE_SIXTEEN_ENTRY_SEC, nowMs);
}

/**
 * Next wake delay before entry completes.
 * `has915Ohlc` = sealed open+close already captured for today.
 */
export function msUntilNextEntryPhase(
  has915Ohlc: boolean,
  _hasCloseIgnored?: boolean,
  nowMs = Date.now(),
): number {
  const ready =
    typeof _hasCloseIgnored === "boolean" ? has915Ohlc && _hasCloseIgnored : has915Ohlc;
  if (ready) return msUntil916Entry(nowMs);
  const nowSec = istSecondsOfDay(new Date(nowMs));
  if (nowSec < NINE_SIXTEEN_WS_CONNECT_SEC) return msUntilWsConnect(nowMs);
  if (nowSec < NINE_SIXTEEN_OPEN_TICK_START_SEC) {
    // Websocket is already up — idle until 9:15, but stay awake enough to notice a drop.
    return Math.min(5_000, Math.max(250, (NINE_SIXTEEN_OPEN_TICK_START_SEC - nowSec) * 1000));
  }
  if (nowSec < NINE_SIXTEEN_CLOSE_SEAL_SEC) {
    // Last second before 9:16:00 — wake often so entry fires immediately.
    if (nowSec >= NINE_SIXTEEN_CLOSE_SEAL_SEC - 1) return 50;
    return 250;
  }
  return msUntil916Entry(nowMs);
}

export function isPast916EntryWindow(nowMs = Date.now()): boolean {
  return istSecondsOfDay(new Date(nowMs)) > nineSixteenEntryWindowEndSec();
}

/** True 9:00–16:00 IST — keep Kite websocket up for capture + exits. */
export function isInBotWsHours(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_WS_CONNECT_SEC && nowSec < NINE_SIXTEEN_WS_DISCONNECT_SEC;
}

export function isPastBotWsHours(nowMs = Date.now()): boolean {
  return istSecondsOfDay(new Date(nowMs)) >= NINE_SIXTEEN_WS_DISCONNECT_SEC;
}

/** @deprecated use isInBotWsHours — same window now (9:00–16:00). */
export function isReadyForWsConnect(nowMs = Date.now()): boolean {
  return isInBotWsHours(nowMs);
}

export function isReadyToSeal915Close(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_CLOSE_SEAL_SEC && nowSec <= nineSixteenEntryWindowEndSec();
}

/** @deprecated close seals from websocket at 9:16:00 */
export function isReadyForOhlcCapture(nowMs = Date.now()): boolean {
  return isReadyToSeal915Close(nowMs);
}

/** @deprecated */
export function isReadyForOpenCapture(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_OPEN_TICK_START_SEC && nowSec <= NINE_SIXTEEN_OPEN_TICK_END_SEC;
}

/** @deprecated */
export function isReadyForCloseCapture(nowMs = Date.now()): boolean {
  return isReadyToSeal915Close(nowMs);
}

export function isIn915OpenTickWindow(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_OPEN_TICK_START_SEC && nowSec <= NINE_SIXTEEN_OPEN_TICK_END_SEC;
}

export function isIn915CloseTickWindow(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_OPEN_TICK_START_SEC && nowSec < NINE_SIXTEEN_CLOSE_SEAL_SEC;
}

/** Ready to place CE/PE after open+close are captured. */
export function isReadyFor916Entry(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_ENTRY_SEC && nowSec <= nineSixteenEntryWindowEndSec();
}

/** 9:00 until entry — safe to warm caches without competing with the order path. */
export function isReadyForEntryPrewarm(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_PREWARM_SEC && nowSec < NINE_SIXTEEN_ENTRY_SEC;
}

/** 9:15:58–9:15:59 — resolve ATM strikes from the websocket spot, just before entry. */
export function isReadyForAtmPreResolve(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_PRE_RESOLVE_SEC && nowSec < NINE_SIXTEEN_ENTRY_SEC;
}

/**
 * 9:15:58–9:16:30 — the entry burst. Non-critical Kite calls (reconcile, UI live sync) stay
 * off the wire here so they cannot delay the order or burn rate limit.
 */
export function isInNineSixteenBurst(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_SIXTEEN_PRE_RESOLVE_SEC && nowSec <= nineSixteenEntryWindowEndSec();
}

export function build915BarFromCaptured(
  open: number,
  close: number,
  high = Math.max(open, close),
  low = Math.min(open, close),
): NineSixteen915Bar | null {
  if (open <= 0 || close <= 0) return null;
  return {
    open,
    close,
    high,
    low,
    change: close - open,
    direction: directionFrom915Bar(open, close),
  };
}

function directionFrom915Bar(open: number, close: number): NineFifteenDirection {
  if (close > open) return "up";
  if (close < open) return "down";
  return "flat";
}

export function legFrom915Direction(direction: NineFifteenDirection): TradeLeg | null {
  if (direction === "up") return "CE_BUY";
  if (direction === "down") return "PE_BUY";
  return null;
}

export type NineSixteenEntryDecision =
  | { action: "skip"; reason: string }
  | { action: "enter"; leg: TradeLeg; exitMode: NineSixteenExitMode };

/** |Δ| ≥ 15 → main; 11 ≤ |Δ| < 15 → near_miss; else null (skip). */
export function exitModeFrom915Change(change: number): NineSixteenExitMode | null {
  const abs = Math.abs(change);
  if (abs >= NINE_SIXTEEN_MIN_915_ABS_DIFF) return "main";
  if (abs >= NINE_SIXTEEN_NEAR_MISS_MIN_915_ABS_DIFF) return "near_miss";
  return null;
}

/** Live rules: flat or |Δ| < 11 → skip; green → CE; red → PE; exit mode from |Δ|. */
export function decide915Entry(bar: NineSixteen915Bar): NineSixteenEntryDecision {
  const diff = bar.change;
  if (bar.direction === "flat" || diff === 0) {
    return { action: "skip", reason: "9:15 bar flat (close equals open) — no trade" };
  }
  const exitMode = exitModeFrom915Change(diff);
  if (!exitMode) {
    return {
      action: "skip",
      reason: `9:15 move too small — |Δ| ${Math.abs(diff).toFixed(2)} pts (need at least ${NINE_SIXTEEN_NEAR_MISS_MIN_915_ABS_DIFF}; main band ≥ ${NINE_SIXTEEN_MIN_915_ABS_DIFF})`,
    };
  }
  if (bar.direction === "up") {
    return { action: "enter", leg: "CE_BUY", exitMode };
  }
  return { action: "enter", leg: "PE_BUY", exitMode };
}

/** Default = live floor (near-miss min). Pass 15 to test main-band-only. */
export function passes915EntryFilter(
  change: number,
  minAbsDiff = NINE_SIXTEEN_NEAR_MISS_MIN_915_ABS_DIFF,
): boolean {
  return Math.abs(change) >= minAbsDiff;
}

export function parse915Bar(candle: ParsedCandle | null | undefined): NineSixteen915Bar | null {
  if (!candle || candle.open <= 0) return null;
  const change = candle.close - candle.open;
  return {
    open: candle.open,
    close: candle.close,
    high: candle.high,
    low: candle.low,
    change,
    direction: directionFrom915Bar(candle.open, candle.close),
  };
}

export function istMinuteLabel(timestampMs: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));
}

export function findCandleAtMinute(candles: ParsedCandle[], minuteLabel: string): ParsedCandle | null {
  return candles.find((candle) => istMinuteLabel(candle.timestamp) === minuteLabel) ?? null;
}

/** Prefer exact 09:15 IST candle; never fall back to a different minute. */
export function pick915Candle(candles: ParsedCandle[]): ParsedCandle | null {
  if (candles.length === 0) return null;
  return findCandleAtMinute(candles, "09:15");
}

/** True when |change| is close enough to the 15-pt filter that a provisional open can flip the decision. */
export function isNear915EntryThreshold(change: number, minAbsDiff = NINE_SIXTEEN_MIN_915_ABS_DIFF): boolean {
  const abs = Math.abs(change);
  return abs >= minAbsDiff - 5 && abs < minAbsDiff + 5;
}

/**
 * Live index exit target by IST clock + entry mode:
 * · main: ±25 until 10:01 · ±20 from 10:01 · ±15 from 11:01
 * · near_miss: ±20 until 10:01 · ±10 from 10:01
 * (from Nifty spot at fill)
 */
export function activeIndexTargetPoints(
  mode: NineSixteenExitMode = "main",
  nowMs = Date.now(),
): number {
  const mod = istMinuteOfDay(nowMs);
  if (mode === "near_miss") {
    if (mod >= NINE_SIXTEEN_NEAR_MISS_SWITCH_MINUTE) return NINE_SIXTEEN_NEAR_MISS_INDEX_TARGET_AFTER;
    return NINE_SIXTEEN_NEAR_MISS_INDEX_TARGET;
  }
  if (mod >= NINE_SIXTEEN_INDEX_TARGET_15_START_MINUTE) return NINE_SIXTEEN_INDEX_TARGET_15;
  if (mod >= NINE_SIXTEEN_INDEX_TARGET_20_START_MINUTE) return NINE_SIXTEEN_INDEX_TARGET_20;
  return NINE_SIXTEEN_INDEX_TARGET;
}

export function getIndexExitScheduleLabel(mode: NineSixteenExitMode = "main"): string {
  if (mode === "near_miss") {
    return `±${NINE_SIXTEEN_NEAR_MISS_INDEX_TARGET} · 10:01+ ±${NINE_SIXTEEN_NEAR_MISS_INDEX_TARGET_AFTER}`;
  }
  return `±${NINE_SIXTEEN_INDEX_TARGET} · 10:01+ ±${NINE_SIXTEEN_INDEX_TARGET_20} · 11:01+ ±${NINE_SIXTEEN_INDEX_TARGET_15}`;
}

/**
 * Live index exit: tiered ± from Nifty 50 spot at 9:16:00 fill (not 9:15 open, not option premium).
 * 9:15 open/close chooses CE vs PE and which exit schedule.
 */
export function shouldExitNineSixteen(
  spot: number,
  entrySpot: number,
  leg: TradeLeg,
  target = activeIndexTargetPoints("main"),
): boolean {
  if (spot <= 0 || entrySpot <= 0) return false;
  if (leg === "CE_BUY") return spot >= entrySpot + target;
  if (leg === "PE_BUY") return spot <= entrySpot - target;
  return false;
}

export function getNineSixteenPnlTargetPct(): number {
  return NINE_SIXTEEN_PNL_TARGET_PCT;
}

function istMinuteOfDay(nowMs = Date.now()): number {
  const { hour, minute } = istTimeParts(new Date(nowMs));
  return hour * 60 + minute;
}

/** 9:16–10:00 IST — +10% of entry cost. */
export function isPnlMorningExitWindowActive(nowMs = Date.now()): boolean {
  const mod = istMinuteOfDay(nowMs);
  return (
    mod >= NINE_SIXTEEN_PNL_MORNING_EXIT_START_MINUTE &&
    mod <= NINE_SIXTEEN_PNL_MORNING_EXIT_END_MINUTE
  );
}

/** 10:01–11:00 IST — +5% of entry cost. */
export function isPnlEarlyExitWindowActive(nowMs = Date.now()): boolean {
  const mod = istMinuteOfDay(nowMs);
  return mod >= NINE_SIXTEEN_PNL_EARLY_EXIT_START_MINUTE && mod <= NINE_SIXTEEN_PNL_EARLY_EXIT_END_MINUTE;
}

/** From 11:01 IST — +3% of entry cost. */
export function isPnlLateExitWindowActive(nowMs = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= NINE_SIXTEEN_PNL_EXIT_START_MINUTE;
}

/** Any P&L % exit window (morning, early, or late). */
export function isPnlExitWindowActive(nowMs = Date.now()): boolean {
  return (
    isPnlMorningExitWindowActive(nowMs) ||
    isPnlEarlyExitWindowActive(nowMs) ||
    isPnlLateExitWindowActive(nowMs)
  );
}

export function activePnlTargetPct(nowMs = Date.now()): number | null {
  if (isPnlMorningExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_MORNING_TARGET_PCT;
  if (isPnlEarlyExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_EARLY_TARGET_PCT;
  if (isPnlLateExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_TARGET_PCT;
  return null;
}

export function getPnlExitScheduleLabel(): string {
  return `9:16–10:00 +${NINE_SIXTEEN_PNL_MORNING_TARGET_PCT}% · 10:01–11:00 +${NINE_SIXTEEN_PNL_EARLY_TARGET_PCT}% · 11:01+ +${NINE_SIXTEEN_PNL_TARGET_PCT}%`;
}

function pnlExitStartMinuteOfDay(): number {
  return NINE_SIXTEEN_PNL_MORNING_EXIT_START_MINUTE;
}

/** True from 3:00 PM IST (before 3:25 square-off). */
export function isNearTargetExitWindowActive(nowMs = Date.now()): boolean {
  const { hour, minute } = istTimeParts(new Date(nowMs));
  return hour * 60 + minute >= NINE_SIXTEEN_NEAR_TARGET_EXIT_START_MINUTE;
}

/** Target Nifty level: entry spot ±25 (CE up / PE down). */
export function computeTargetSpot(entrySpot: number, leg: TradeLeg, target = NINE_SIXTEEN_INDEX_TARGET): number {
  return leg === "CE_BUY" ? entrySpot + target : entrySpot - target;
}

/** After 3 PM: exit when |spot − target| is under `maxDistance` index points (target from entry spot). */
export function shouldExitNearTargetAfter3Pm(
  spot: number,
  entrySpot: number,
  leg: TradeLeg,
  target = NINE_SIXTEEN_INDEX_TARGET,
  maxDistance = NINE_SIXTEEN_NEAR_TARGET_MAX_DISTANCE,
): boolean {
  if (!isNearTargetExitWindowActive()) return false;
  if (spot <= 0 || entrySpot <= 0) return false;
  const targetSpot = computeTargetSpot(entrySpot, leg, target);
  return Math.abs(spot - targetSpot) < maxDistance;
}

export function getPnlExitStartLabel(): string {
  const total = pnlExitStartMinuteOfDay();
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function computePnlTargetAmount(
  entryPrice: number,
  quantity: number,
  targetPct?: number,
): number | null {
  if (entryPrice <= 0 || quantity <= 0) return null;
  const pct = targetPct ?? NINE_SIXTEEN_PNL_TARGET_PCT;
  return entryPrice * quantity * (pct / 100);
}

export function shouldExitOnPnlTarget(
  unrealisedPnl: number,
  entryPrice: number,
  quantity: number,
  targetPct?: number,
): boolean {
  if (unrealisedPnl <= 0 || entryPrice <= 0 || quantity <= 0) return false;
  const pct = targetPct ?? activePnlTargetPct();
  if (pct == null) return false;
  const target = computePnlTargetAmount(entryPrice, quantity, pct);
  if (target == null) return false;
  return unrealisedPnl >= target;
}

export function isPastNineSixteenForceExit(nowMs = Date.now()): boolean {
  const ctx = getIndianMarketContext(new Date(nowMs));
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const { hour, minute } = istTimeParts(new Date(nowMs));
  return hour * 60 + minute >= 15 * 60 + 25;
}
