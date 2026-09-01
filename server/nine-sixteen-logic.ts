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
/** +3% P&L exit: 11:01 AM through 12:00 PM IST (inclusive). */
export const NINE_SIXTEEN_PNL_EXIT_START_MINUTE = 11 * 60 + 1;
export const NINE_SIXTEEN_PNL_EXIT_END_MINUTE = 12 * 60;
/** +1% P&L exit from 12:01 PM IST onward. */
export const NINE_SIXTEEN_PNL_FINAL_TARGET_PCT = 1;
export const NINE_SIXTEEN_PNL_FINAL_EXIT_START_MINUTE = 12 * 60 + 1;
/**
 * Tuesday only: two-step P&L exit that replaces the tiered schedule — +5% from the 9:16 fill
 * through 10:00, then +1% from 10:01 onward (exit as soon as it prints).
 */
export const NINE_SIXTEEN_TUESDAY_PNL_MORNING_TARGET_PCT = 5;
export const NINE_SIXTEEN_TUESDAY_PNL_LATER_TARGET_PCT = 1;
export const NINE_SIXTEEN_TUESDAY_PNL_SWITCH_MINUTE = 10 * 60 + 1;
/**
 * From 9:55 AM IST on every day: hard exit when Nifty runs this far against the trade
 * direction, measured from the entry spot. Overrides the ±target wait.
 */
export const NINE_SIXTEEN_HARD_STOP_INDEX_POINTS = 30;
export const NINE_SIXTEEN_HARD_STOP_START_MINUTE = 9 * 60 + 55;
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

/**
 * The 9:15 trade — a separate, earlier leg that runs before the 9:16 one.
 *
 * The 9:15 minute is read ten seconds in: if price is below the 9:15 open at that point the
 * minute is opening red, and an ATM PE goes out at 9:15:11. There is no green side — a minute
 * opening up is left alone and the day waits for the 9:16 decision.
 */
export const NINE_FIFTEEN_PRE_RESOLVE_SEC = 9 * 3600 + 15 * 60 + 5;
/** The read: last tick strictly before 9:15:10 decides red or green. */
export const NINE_FIFTEEN_SIGNAL_READ_SEC = 9 * 3600 + 15 * 60 + 10;
/** The order goes out here. */
export const NINE_FIFTEEN_ENTRY_SEC = 9 * 3600 + 15 * 60 + 11;
/**
 * Retries stop here rather than at the end of the minute. A fill at 9:15:50 could not realise a
 * 3% rung before 9:16:00, so it would only stand in the way of the 9:16 trade.
 */
export const NINE_FIFTEEN_ENTRY_WINDOW_END_SEC = 9 * 3600 + 15 * 60 + 20;
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

const IST_WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
});

export function isTuesdayIst(nowMs = Date.now()): boolean {
  return IST_WEEKDAY_FORMATTER.format(new Date(nowMs)).startsWith("Tue");
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

/** Ms until the 9:15:11 order instant — negative once it has passed. */
export function msUntilNineFifteenEntry(nowMs = Date.now()): number {
  return NINE_FIFTEEN_ENTRY_SEC * 1000 - istMsOfDay(nowMs);
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

/** 9:15:05–9:15:10 — resolve the ATM PE so the 9:15:11 order makes no REST call. */
export function isReadyForNineFifteenPreResolve(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_FIFTEEN_PRE_RESOLVE_SEC && nowSec < NINE_FIFTEEN_ENTRY_SEC;
}

/** True once the ten-second read is due, i.e. from 9:15:10 onwards. */
export function isPastNineFifteenSignalRead(nowMs = Date.now()): boolean {
  return istSecondsOfDay(new Date(nowMs)) >= NINE_FIFTEEN_SIGNAL_READ_SEC;
}

export function isReadyForNineFifteenEntry(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_FIFTEEN_ENTRY_SEC && nowSec <= NINE_FIFTEEN_ENTRY_WINDOW_END_SEC;
}

export function isPastNineFifteenEntryWindow(nowMs = Date.now()): boolean {
  return istSecondsOfDay(new Date(nowMs)) > NINE_FIFTEEN_ENTRY_WINDOW_END_SEC;
}

/** True once the 9:15 minute is over, so a 9:15 leg still open has missed its own window. */
export function isPastNineFifteenMinute(nowMs = Date.now()): boolean {
  return istSecondsOfDay(new Date(nowMs)) >= NINE_SIXTEEN_CLOSE_SEAL_SEC;
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
/**
 * The 9:16 entry decision, taken on the sealed 9:15 bar.
 *
 * Short side only: a green 9:15 minute is left alone rather than bought as a CE. What remains is
 * a red minute that fell at least {@link NINE_SIXTEEN_NEAR_MISS_MIN_915_ABS_DIFF} points, which
 * buys the ATM PE on the same near-miss / main exit bands as before.
 */
export function decide915Entry(bar: NineSixteen915Bar): NineSixteenEntryDecision {
  const diff = bar.change;
  if (bar.direction === "flat" || diff === 0) {
    return { action: "skip", reason: "9:15 bar flat (close equals open) — no trade" };
  }
  if (diff > 0) {
    return {
      action: "skip",
      reason: `9:15 closed green (+${diff.toFixed(2)} pts) — the 9:16 trade only takes red candles`,
    };
  }
  const exitMode = exitModeFrom915Change(diff);
  if (!exitMode) {
    return {
      action: "skip",
      reason: `9:15 move too small — |Δ| ${Math.abs(diff).toFixed(2)} pts (need at least ${NINE_SIXTEEN_NEAR_MISS_MIN_915_ABS_DIFF}; main band ≥ ${NINE_SIXTEEN_MIN_915_ABS_DIFF})`,
    };
  }
  return { action: "enter", leg: "PE_BUY", exitMode };
}

/* ---------------------------------------------------------------------------------------------
 * 9:15 trade — signal and exit ladder
 * ------------------------------------------------------------------------------------------- */

export type NineFifteenEntryDecision =
  | { action: "enter"; leg: "PE_BUY"; dropPts: number }
  | { action: "skip"; reason: string };

/**
 * Red or green ten seconds into the 9:15 minute, measured against the 9:15 open.
 *
 * Any fall at all counts — there is no minimum here, unlike the 9:16 decision. A flat or rising
 * read is skipped outright; this trade has no long side.
 */
export function decideNineFifteenEntry(
  open: number,
  markPrice: number,
): NineFifteenEntryDecision {
  if (!(open > 0) || !(markPrice > 0)) {
    return { action: "skip", reason: "No 9:15 open or 10-second tick to read" };
  }
  const change = markPrice - open;
  if (change === 0) {
    return { action: "skip", reason: `Flat at the 10s mark (${markPrice.toFixed(2)}) — no trade` };
  }
  if (change > 0) {
    return {
      action: "skip",
      reason: `Green at the 10s mark (+${change.toFixed(2)} pts) — the 9:15 trade only takes red`,
    };
  }
  return { action: "enter", leg: "PE_BUY", dropPts: Math.abs(change) };
}

/* The 9:15 exit ladder lives further down, next to the 9:16 one it mirrors. */

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

/**
 * @deprecated The live 9:16 bot now exits on the trailing P&L ladder
 * (`shouldExitOnTrailingPnl`), not on this time-tiered schedule. Kept for the
 * historical exit-rule scripts only.
 */
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

/** 11:01–12:00 IST — +3% of entry cost. */
export function isPnlLateExitWindowActive(nowMs = Date.now()): boolean {
  const mod = istMinuteOfDay(nowMs);
  return mod >= NINE_SIXTEEN_PNL_EXIT_START_MINUTE && mod <= NINE_SIXTEEN_PNL_EXIT_END_MINUTE;
}

/** From 12:01 IST — +1% of entry cost. */
export function isPnlFinalExitWindowActive(nowMs = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= NINE_SIXTEEN_PNL_FINAL_EXIT_START_MINUTE;
}

/** Any P&L % exit window (morning, early, late, or final). */
export function isPnlExitWindowActive(nowMs = Date.now()): boolean {
  return (
    isPnlMorningExitWindowActive(nowMs) ||
    isPnlEarlyExitWindowActive(nowMs) ||
    isPnlLateExitWindowActive(nowMs) ||
    isPnlFinalExitWindowActive(nowMs)
  );
}

/** @deprecated Superseded by the trailing P&L ladder — see `nextLockedPnlPct`. */
export function activePnlTargetPct(nowMs = Date.now()): number | null {
  if (isTuesdayIst(nowMs)) {
    if (!isPnlExitWindowActive(nowMs)) return null;
    return istMinuteOfDay(nowMs) >= NINE_SIXTEEN_TUESDAY_PNL_SWITCH_MINUTE
      ? NINE_SIXTEEN_TUESDAY_PNL_LATER_TARGET_PCT
      : NINE_SIXTEEN_TUESDAY_PNL_MORNING_TARGET_PCT;
  }
  if (isPnlMorningExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_MORNING_TARGET_PCT;
  if (isPnlEarlyExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_EARLY_TARGET_PCT;
  if (isPnlLateExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_TARGET_PCT;
  if (isPnlFinalExitWindowActive(nowMs)) return NINE_SIXTEEN_PNL_FINAL_TARGET_PCT;
  return null;
}

export function getPnlExitScheduleLabel(nowMs = Date.now()): string {
  if (isTuesdayIst(nowMs)) {
    return (
      `Tue · 9:16–10:00 +${NINE_SIXTEEN_TUESDAY_PNL_MORNING_TARGET_PCT}% · ` +
      `10:01+ +${NINE_SIXTEEN_TUESDAY_PNL_LATER_TARGET_PCT}%`
    );
  }
  return (
    `9:16–10:00 +${NINE_SIXTEEN_PNL_MORNING_TARGET_PCT}% · ` +
    `10:01–11:00 +${NINE_SIXTEEN_PNL_EARLY_TARGET_PCT}% · ` +
    `11:01–12:00 +${NINE_SIXTEEN_PNL_TARGET_PCT}% · ` +
    `12:01+ +${NINE_SIXTEEN_PNL_FINAL_TARGET_PCT}%`
  );
}

/** True from 9:55 AM IST — the ±30 adverse-move hard stop is scanning. */
export function isHardStopWindowActive(nowMs = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= NINE_SIXTEEN_HARD_STOP_START_MINUTE;
}

/**
 * Hard exit from 9:55 AM IST when Nifty has run `stopPoints` against the planned direction,
 * measured from the entry spot: CE_BUY stops at entry − 30, PE_BUY at entry + 30.
 */
export function shouldHardStopNineSixteen(
  spot: number,
  entrySpot: number,
  leg: TradeLeg,
  stopPoints = NINE_SIXTEEN_HARD_STOP_INDEX_POINTS,
  nowMs = Date.now(),
): boolean {
  if (spot <= 0 || entrySpot <= 0) return false;
  if (!isHardStopWindowActive(nowMs)) return false;
  if (leg === "CE_BUY") return spot <= entrySpot - stopPoints;
  if (leg === "PE_BUY") return spot >= entrySpot + stopPoints;
  return false;
}

/** Nifty level that triggers the hard stop for this leg. */
export function computeHardStopSpot(
  entrySpot: number,
  leg: TradeLeg,
  stopPoints = NINE_SIXTEEN_HARD_STOP_INDEX_POINTS,
): number {
  return leg === "CE_BUY" ? entrySpot - stopPoints : entrySpot + stopPoints;
}

/** IST clock time the hard stop starts scanning, e.g. "09:55". */
export function getHardStopStartLabel(): string {
  const hour = Math.floor(NINE_SIXTEEN_HARD_STOP_START_MINUTE / 60);
  const minute = NINE_SIXTEEN_HARD_STOP_START_MINUTE % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function getHardStopScheduleLabel(): string {
  return `${getHardStopStartLabel()}+ hard stop ${NINE_SIXTEEN_HARD_STOP_INDEX_POINTS} pts adverse`;
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

/** @deprecated Superseded by the trailing P&L ladder — see `shouldExitOnTrailingPnl`. */
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

/** Unrealised P&L as a percentage of the premium paid at entry. Null when unknown. */
export function pnlPctOfEntryCost(
  unrealisedPnl: number | null,
  entryPrice: number,
  quantity: number,
): number | null {
  if (unrealisedPnl == null || entryPrice <= 0 || quantity <= 0) return null;
  return (unrealisedPnl / (entryPrice * quantity)) * 100;
}

/**
 * Trailing P&L ladder (all days, replaces the old time-tiered +10/+5/+3/+1 schedule).
 * Nothing is locked until +5% of the premium paid prints. From there each +5% rung locks the
 * stop at that rung and moves the take-profit one rung higher — reaching the take-profit only
 * expands the ladder, it never exits. The trade closes when profit slips back below the
 * locked rung (or on the index target, 9:55+ hard stop, or 3:25 PM square-off).
 */
export const NINE_SIXTEEN_PNL_TRAIL_ARM_PCT = 5;
export const NINE_SIXTEEN_PNL_TRAIL_STEP_PCT = 5;
/**
 * The ladder ratchets and never steps back down, so one bad P&L reading would lock a rung the
 * trade can never meet and force an instant stop-out. Readings above this are treated as bad
 * data (e.g. an aggregate broker P&L covering lots this leg does not own) and ignored.
 */
export const NINE_SIXTEEN_PNL_TRAIL_MAX_LOCK_PCT = 100;

/** True when a P&L percentage is usable for the ladder. */
export function isPlausiblePnlPct(pnlPct: number | null): boolean {
  if (pnlPct == null || !Number.isFinite(pnlPct)) return false;
  return pnlPct <= NINE_SIXTEEN_PNL_TRAIL_MAX_LOCK_PCT;
}

/** Highest rung locked so far: 0 before +5% prints, then 5, 10, 15 … in +5% steps. */
export function nextLockedPnlPct(lockedPct: number, pnlPct: number | null): number {
  const current = Number.isFinite(lockedPct) && lockedPct > 0 ? lockedPct : 0;
  if (pnlPct == null || !isPlausiblePnlPct(pnlPct)) return current;
  if (pnlPct < NINE_SIXTEEN_PNL_TRAIL_ARM_PCT) return current;
  const rung =
    Math.floor(pnlPct / NINE_SIXTEEN_PNL_TRAIL_STEP_PCT) * NINE_SIXTEEN_PNL_TRAIL_STEP_PCT;
  return Math.max(current, Math.min(rung, NINE_SIXTEEN_PNL_TRAIL_MAX_LOCK_PCT));
}

/** Take-profit rung — where the ladder expands next, not an exit level. */
export function trailingPnlTargetPct(lockedPct: number): number {
  const current = Number.isFinite(lockedPct) && lockedPct > 0 ? lockedPct : 0;
  return current === 0
    ? NINE_SIXTEEN_PNL_TRAIL_ARM_PCT + NINE_SIXTEEN_PNL_TRAIL_STEP_PCT
    : current + NINE_SIXTEEN_PNL_TRAIL_STEP_PCT;
}

/** Stop rung once armed — null while profit has never touched +5%. */
export function trailingPnlStopPct(lockedPct: number): number | null {
  return lockedPct >= NINE_SIXTEEN_PNL_TRAIL_ARM_PCT ? lockedPct : null;
}

/** Exit only after the ladder is armed and profit slips back below the locked rung. */
export function shouldExitOnTrailingPnl(lockedPct: number, pnlPct: number | null): boolean {
  if (lockedPct < NINE_SIXTEEN_PNL_TRAIL_ARM_PCT) return false;
  if (pnlPct == null || !Number.isFinite(pnlPct)) return false;
  return pnlPct < lockedPct;
}

/* ---------------------------------------------------------------------------------------------
 * 9:15 exit ladder
 *
 * Tighter and faster than the 9:16 one, because the trade is meant to be over inside the minute:
 * it arms at +3% instead of +5% and steps +2% instead of +5%, and it runs on option P&L alone —
 * no index target, no hard stop, and no pre-ladder loss stop.
 * ------------------------------------------------------------------------------------------- */

/** First rung. Nothing is locked until profit reaches this. */
export const NINE_FIFTEEN_TRAIL_ARM_PCT = 3;
/** Every rung after the first: 3 → 5 → 7 → 9 → … */
export const NINE_FIFTEEN_TRAIL_STEP_PCT = 2;
/** Same bad-data ceiling as the 9:16 ladder. */
export const NINE_FIFTEEN_TRAIL_MAX_LOCK_PCT = NINE_SIXTEEN_PNL_TRAIL_MAX_LOCK_PCT;

/** Highest rung reached so far: 0 below +3%, then 3, 5, 7, 9 … */
export function nextNineFifteenLockedPct(lockedPct: number, pnlPct: number | null): number {
  const current = Number.isFinite(lockedPct) && lockedPct > 0 ? lockedPct : 0;
  if (pnlPct == null || !isPlausiblePnlPct(pnlPct)) return current;
  if (pnlPct < NINE_FIFTEEN_TRAIL_ARM_PCT) return current;
  const steps = Math.floor((pnlPct - NINE_FIFTEEN_TRAIL_ARM_PCT) / NINE_FIFTEEN_TRAIL_STEP_PCT);
  const rung = NINE_FIFTEEN_TRAIL_ARM_PCT + steps * NINE_FIFTEEN_TRAIL_STEP_PCT;
  return Math.max(current, Math.min(rung, NINE_FIFTEEN_TRAIL_MAX_LOCK_PCT));
}

/** Where the ladder expands next. Reaching it never exits. */
export function nineFifteenTargetPct(lockedPct: number): number {
  const current = Number.isFinite(lockedPct) && lockedPct > 0 ? lockedPct : 0;
  return current === 0 ? NINE_FIFTEEN_TRAIL_ARM_PCT : current + NINE_FIFTEEN_TRAIL_STEP_PCT;
}

/** The live stop once the ladder has armed; null while no rung is locked yet. */
export function nineFifteenStopPct(lockedPct: number): number | null {
  return lockedPct >= NINE_FIFTEEN_TRAIL_ARM_PCT ? lockedPct : null;
}

export interface NineFifteenExitEvaluation {
  lockedPnlPct: number;
  exit: { reason: "trail-stop"; lockedPnlPct: number } | null;
}

/**
 * One evaluation of the 9:15 ladder against a live P&L reading.
 *
 * Reaching a rung only ratchets the floor — the exit fires when P&L later comes back down to it.
 * The check is skipped on the evaluation that advances the ladder, because the floor and the
 * reading are the same number there and every rung would sell itself the moment it locked.
 */
export function evaluateNineFifteenExit(
  lockedPct: number,
  pnlPct: number | null,
): NineFifteenExitEvaluation {
  const current = Number.isFinite(lockedPct) && lockedPct > 0 ? lockedPct : 0;
  if (pnlPct == null || !isPlausiblePnlPct(pnlPct)) {
    return { lockedPnlPct: current, exit: null };
  }

  const locked = nextNineFifteenLockedPct(current, pnlPct);
  if (locked > current) return { lockedPnlPct: locked, exit: null };

  if (locked >= NINE_FIFTEEN_TRAIL_ARM_PCT) {
    return pnlPct <= locked
      ? { lockedPnlPct: locked, exit: { reason: "trail-stop", lockedPnlPct: locked } }
      : { lockedPnlPct: locked, exit: null };
  }

  // No P&L stop before the ladder arms — EOD square-off is the only other exit.
  return { lockedPnlPct: locked, exit: null };
}

/**
 * Fold a broker position read into a leg we already own, without inheriting anyone else's lots.
 *
 * Kite reports one row per contract: `quantity` is the net across every bot holding it, and
 * `average_price` is blended over all of the day's buys in that symbol, including round trips
 * already closed. Booking either as ours records an entry the bot never paid and feeds the
 * trailing ladder a percentage measured against lots it does not own.
 */
export function ownPositionSync(
  own: { quantity: number; entryPrice: number },
  broker: { quantity: number; average_price: number },
): { quantity: number; entryPrice: number } {
  return {
    // Only ever shrink. The broker holding less than us is our leg being reduced, which is real;
    // holding more is another bot's position and none of our business.
    quantity: own.quantity > 0 ? Math.min(own.quantity, broker.quantity) : broker.quantity,
    // Entry price belongs to our own fills. The broker's blend is a last resort during recovery.
    entryPrice: own.entryPrice > 0 ? own.entryPrice : broker.average_price > 0 ? broker.average_price : 0,
  };
}

/**
 * P&L of one leg computed only from that leg's own fill price and quantity. The broker's
 * position-level `unrealised` covers every lot open in the symbol, which is wrong whenever
 * another bot (or a manual trade) holds lots in the same contract.
 */
export function ownLegUnrealisedPnl(
  entryPrice: number,
  quantity: number,
  lastOptionPrice: number | null,
): number | null {
  if (entryPrice <= 0 || quantity <= 0) return null;
  if (lastOptionPrice == null || !(lastOptionPrice > 0)) return null;
  return (lastOptionPrice - entryPrice) * quantity;
}

export function getPnlTrailScheduleLabel(): string {
  const arm = NINE_SIXTEEN_PNL_TRAIL_ARM_PCT;
  const step = NINE_SIXTEEN_PNL_TRAIL_STEP_PCT;
  return (
    `Trail from +${arm}% · every +${step}% locks SL at that rung, TP moves to rung+${step}% ` +
    `(+${arm}→TP+${arm + step}/SL+${arm} · +${arm + step}→TP+${arm + 2 * step}/SL+${arm + step} …)`
  );
}

export function getNineFifteenLadderLabel(): string {
  const arm = NINE_FIFTEEN_TRAIL_ARM_PCT;
  const step = NINE_FIFTEEN_TRAIL_STEP_PCT;
  return (
    `Trail from +${arm}% · every +${step}% locks SL at that rung ` +
    `(+${arm}→TP+${arm + step}/SL+${arm} · +${arm + step}→TP+${arm + 2 * step}/SL+${arm + step} …) · market exits`
  );
}

export function isPastNineSixteenForceExit(nowMs = Date.now()): boolean {
  const ctx = getIndianMarketContext(new Date(nowMs));
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const { hour, minute } = istTimeParts(new Date(nowMs));
  return hour * 60 + minute >= 15 * 60 + 25;
}
