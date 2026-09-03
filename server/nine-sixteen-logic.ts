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
 * Live entry by |9:15 close − open| on a red bar:
 * · ≥ 15 → PE @ 9:16 with main exits (±25 → ±20@10:01 → ±15@11:01)
 * · < 15 → skip
 */
export const NINE_SIXTEEN_MIN_915_ABS_DIFF = 15;
/** Backtest / legacy exit ladder only — live 9:16 bot no longer enters this band. */
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
 * From 10:00 AM IST on every day: hard exit when Nifty runs this far against the trade
 * direction, measured from the entry spot. Applies to both the 9:15 and 9:16 legs.
 */
export const NINE_SIXTEEN_HARD_STOP_INDEX_POINTS = 30;
export const NINE_SIXTEEN_HARD_STOP_START_MINUTE = 10 * 60;
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
 * The 9:15 minute is read five seconds in: if price is at least 5 pts below the 9:15 open at that
 * point, an ATM PE goes out at 9:15:06. Smaller red reads, green, and flat are skipped.
 */
export const NINE_FIFTEEN_PRE_RESOLVE_SEC = 9 * 3600 + 15 * 60 + 4;
/** Minimum drop (open − mark at 9:15:05) required to arm the 9:15:06 PE entry. */
export const NINE_FIFTEEN_MIN_DROP_PTS = 5;
/** The read: last tick strictly before 9:15:05 decides red or green. */
export const NINE_FIFTEEN_SIGNAL_READ_SEC = 9 * 3600 + 15 * 60 + 5;
/** The order goes out here. */
export const NINE_FIFTEEN_ENTRY_SEC = 9 * 3600 + 15 * 60 + 6;
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

/** Ms until the 9:15:06 order instant — negative once it has passed. */
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

/** 9:15:04–9:15:05 — resolve the ATM PE so the 9:15:06 order makes no REST call. */
export function isReadyForNineFifteenPreResolve(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= NINE_FIFTEEN_PRE_RESOLVE_SEC && nowSec < NINE_FIFTEEN_ENTRY_SEC;
}

/** True once the five-second read is due, i.e. from 9:15:05 onwards. */
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

/** |Δ| ≥ 15 → main; else null (skip). */
export function exitModeFrom915Change(change: number): NineSixteenExitMode | null {
  const abs = Math.abs(change);
  if (abs >= NINE_SIXTEEN_MIN_915_ABS_DIFF) return "main";
  return null;
}

/**
 * The 9:16 entry decision, taken on the sealed 9:15 bar.
 *
 * Short side only: a green 9:15 minute is left alone rather than bought as a CE. A red minute
 * enters only when |Δ| ≥ {@link NINE_SIXTEEN_MIN_915_ABS_DIFF} (main band).
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
      reason: `9:15 move too small — |Δ| ${Math.abs(diff).toFixed(2)} pts (main band requires ≥ ${NINE_SIXTEEN_MIN_915_ABS_DIFF})`,
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
 * Red at the 9:15:05 read, measured against the 9:15 open.
 *
 * Requires open − mark ≥ {@link NINE_FIFTEEN_MIN_DROP_PTS} index points. Green or flat is skipped.
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
  const dropPts = Math.abs(change);
  if (dropPts + 1e-9 < NINE_FIFTEEN_MIN_DROP_PTS) {
    return {
      action: "skip",
      reason:
        `Red but drop too small at the 5s mark (−${dropPts.toFixed(2)} pts · need at least −${NINE_FIFTEEN_MIN_DROP_PTS})`,
    };
  }
  return { action: "enter", leg: "PE_BUY", dropPts };
}

/* The 9:15 exit ladder lives further down, next to the 9:16 one it mirrors. */

/** Default = live main-band floor (|Δ| ≥ 15). */
export function passes915EntryFilter(
  change: number,
  minAbsDiff = NINE_SIXTEEN_MIN_915_ABS_DIFF,
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

/** True from 10:00 AM IST — the ±30 adverse-move hard stop is scanning. */
export function isHardStopWindowActive(nowMs = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= NINE_SIXTEEN_HARD_STOP_START_MINUTE;
}

/**
 * Hard exit from 10:00 AM IST when Nifty has run `stopPoints` against the planned direction,
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
 * 9:16 trailing P&L ladder — each target tier locks a stop floor; slipping below the floor exits.
 * Reaching +50% exits at market instantly (no trail-back).
 *
 * Mon/Wed: first tier +4→lock+3% · Thu: +5→lock+3% · Tue/Fri: +8→lock+3%.
 */
export type PnlTrailRung = { readonly targetPct: number; readonly lockPct: number };

export const NINE_SIXTEEN_PNL_TRAIL_RUNGS_TAIL = [
  { targetPct: 12, lockPct: 6 },
  { targetPct: 16, lockPct: 9 },
  { targetPct: 20, lockPct: 12 },
  { targetPct: 25, lockPct: 16 },
  { targetPct: 30, lockPct: 20 },
  { targetPct: 40, lockPct: 28 },
] as const;

export const NINE_SIXTEEN_PNL_TRAIL_RUNGS = [
  { targetPct: 8, lockPct: 3 },
  ...NINE_SIXTEEN_PNL_TRAIL_RUNGS_TAIL,
] as const;

/** Instant market exit when profit touches this level. */
export const NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT = 50;

function istWeekdayShortFromDateKey(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(`${dateKey}T06:00:00.000Z`));
}

/** First target tier for the session date (+8 Tue/Fri; +4 Mon/Wed · +5 Thu). */
export function getNineSixteenPnlTrailFirstTargetPct(dateIst?: string): number {
  if (!dateIst) return NINE_SIXTEEN_PNL_TRAIL_RUNGS[0].targetPct;
  const weekday = istWeekdayShortFromDateKey(dateIst);
  if (weekday === "Mon" || weekday === "Wed") return 4;
  if (weekday === "Thu") return 5;
  return NINE_SIXTEEN_PNL_TRAIL_RUNGS[0].targetPct;
}

/** Full ladder for the session date (weekday-specific first rung). */
export function getNineSixteenPnlTrailRungs(dateIst?: string): readonly PnlTrailRung[] {
  const firstTarget = getNineSixteenPnlTrailFirstTargetPct(dateIst);
  return [{ targetPct: firstTarget, lockPct: 3 }, ...NINE_SIXTEEN_PNL_TRAIL_RUNGS_TAIL];
}

/** First target tier (+8% default) — nothing locks before this prints. */
export const NINE_SIXTEEN_PNL_TRAIL_ARM_PCT = NINE_SIXTEEN_PNL_TRAIL_RUNGS[0].targetPct;

/** First target for a session date (+4 Mon/Wed · +5 Thu · +8 Tue/Fri). */
export function getNineSixteenPnlTrailArmPct(dateIst?: string): number {
  return getNineSixteenPnlTrailFirstTargetPct(dateIst);
}

/** First stop floor once the first target prints (always +3%). */
export const NINE_SIXTEEN_PNL_TRAIL_FIRST_LOCK_PCT = NINE_SIXTEEN_PNL_TRAIL_RUNGS[0].lockPct;
/** @deprecated Uniform +5% steps removed — kept for older panels. */
export const NINE_SIXTEEN_PNL_TRAIL_STEP_PCT = 4;
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

/** Highest stop floor locked so far (0 until first target prints, then 3, 6, 9 …). */
export function nextLockedPnlPct(
  lockedStopPct: number,
  pnlPct: number | null,
  dateIst?: string,
): number {
  const current = Number.isFinite(lockedStopPct) && lockedStopPct > 0 ? lockedStopPct : 0;
  if (pnlPct == null || !isPlausiblePnlPct(pnlPct)) return current;
  let next = current;
  for (const rung of getNineSixteenPnlTrailRungs(dateIst)) {
    if (pnlPct + 1e-9 >= rung.targetPct) {
      next = Math.max(next, rung.lockPct);
    }
  }
  return next;
}

/** Next profit target — not an exit until +50% instant rule fires. */
export function trailingPnlTargetPct(lockedStopPct: number, dateIst?: string): number {
  const rungs = getNineSixteenPnlTrailRungs(dateIst);
  if (lockedStopPct <= 0) return rungs[0]!.targetPct;
  for (let i = 0; i < rungs.length; i += 1) {
    const rung = rungs[i]!;
    if (rung.lockPct === lockedStopPct) {
      return i + 1 < rungs.length ? rungs[i + 1]!.targetPct : NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT;
    }
  }
  const last = rungs[rungs.length - 1]!;
  if (lockedStopPct >= last.lockPct) return NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT;
  return rungs[0]!.targetPct;
}

/** Locked stop floor — null until the first target (+8%) has printed. */
export function trailingPnlStopPct(lockedStopPct: number): number | null {
  return lockedStopPct > 0 ? lockedStopPct : null;
}

export function shouldInstantExitTrailingPnl(pnlPct: number | null): boolean {
  return pnlPct != null && isPlausiblePnlPct(pnlPct) && pnlPct + 1e-9 >= NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT;
}

/** Trail stop-out or +50% instant market exit. */
export function shouldExitOnTrailingPnl(lockedStopPct: number, pnlPct: number | null): boolean {
  if (shouldInstantExitTrailingPnl(pnlPct)) return true;
  if (lockedStopPct <= 0 || pnlPct == null || !Number.isFinite(pnlPct)) return false;
  return pnlPct < lockedStopPct;
}

/* ---------------------------------------------------------------------------------------------
 * 9:15 exit — fixed +5% take-profit limit on capital deployed at entry, plus the shared 10:00 IST
 * ±30 Nifty hard stop and 3:25 PM square-off.
 * ------------------------------------------------------------------------------------------- */

/** Take-profit on premium / capital deployed — limit sell placed the moment the 9:15:06 fill lands. */
export const NINE_FIFTEEN_TAKE_PROFIT_PCT = 5;

/** Limit price for a +5% profit on the entry premium (per-unit). */
export function nineFifteenTakeProfitLimitPrice(entryPrice: number): number {
  if (!(entryPrice > 0)) return 0;
  return Math.round(entryPrice * (1 + NINE_FIFTEEN_TAKE_PROFIT_PCT / 100) * 100) / 100;
}

export function nineFifteenDeployedCapital(entryPrice: number, quantity: number): number {
  if (entryPrice <= 0 || quantity <= 0) return 0;
  return entryPrice * quantity;
}

/** Rupee profit aim — e.g. ₹5,000 on ₹1,00,000 deployed. */
export function nineFifteenTakeProfitAmount(entryPrice: number, quantity: number): number {
  return nineFifteenDeployedCapital(entryPrice, quantity) * (NINE_FIFTEEN_TAKE_PROFIT_PCT / 100);
}

/** True when live P&L has reached the fixed take-profit (market backup if the limit is stuck). */
export function shouldExitNineFifteenTakeProfit(
  unrealisedPnl: number | null,
  entryPrice: number,
  quantity: number,
): boolean {
  if (unrealisedPnl == null || entryPrice <= 0 || quantity <= 0) return false;
  const target = nineFifteenTakeProfitAmount(entryPrice, quantity);
  return target > 0 && unrealisedPnl + 1e-9 >= target;
}

/** Rupees still needed to reach the +5% profit aim (0 once at/above target). */
export function nineFifteenPnlRemainingToTarget(
  unrealisedPnl: number | null,
  entryPrice: number,
  quantity: number,
): number | null {
  if (unrealisedPnl == null || entryPrice <= 0 || quantity <= 0) return null;
  const target = nineFifteenTakeProfitAmount(entryPrice, quantity);
  return Math.max(0, target - unrealisedPnl);
}

export type NineFifteenExitVia = "limit" | "market" | "hard-stop" | "eod";

/** Human-readable close line for logs and the panel after a 9:15 leg exits. */
export function formatNineFifteenExitSummary(input: {
  exitPrice: number | null;
  quantity: number;
  entryPrice: number;
  pnl: number | null;
  via: NineFifteenExitVia;
}): string {
  const capital = nineFifteenDeployedCapital(input.entryPrice, input.quantity);
  const pnlPct =
    capital > 0 && input.pnl != null ? (input.pnl / capital) * 100 : null;
  const viaLabel =
    input.via === "limit"
      ? "limit sell executed on Kite"
      : input.via === "market"
        ? "market exit (+5% backup)"
        : input.via === "hard-stop"
          ? "hard stop (market)"
          : "end-of-day square-off (market)";
  const parts = [
    `TRADE EXITED · 9:15 ${viaLabel}`,
    `${input.quantity} qty`,
  ];
  if (input.exitPrice != null && input.exitPrice > 0) {
    parts.push(`@ ₹${input.exitPrice.toFixed(2)} avg`);
  }
  if (input.pnl != null) {
    parts.push(`P&L ${input.pnl >= 0 ? "+" : ""}₹${Math.round(input.pnl)}`);
  }
  if (pnlPct != null) {
    parts.push(`(${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`);
  }
  if (capital > 0) {
    parts.push(`on ₹${Math.round(capital)} deployed`);
  }
  return parts.join(" · ");
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

export function getPnlTrailScheduleLabel(dateIst?: string): string {
  const tiers = getNineSixteenPnlTrailRungs(dateIst).map(
    (rung) => `+${rung.targetPct}→lock+${rung.lockPct}%`,
  ).join(" · ");
  return `${tiers} · +${NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT}% instant market exit`;
}

export function getNineFifteenLadderLabel(): string {
  return (
    `+${NINE_FIFTEEN_TAKE_PROFIT_PCT}% take-profit limit on capital deployed at entry · ` +
    `${getHardStopStartLabel()} hard stop ±${NINE_SIXTEEN_HARD_STOP_INDEX_POINTS} pts · 3:25 PM square-off`
  );
}

export function isPastNineSixteenForceExit(nowMs = Date.now()): boolean {
  const ctx = getIndianMarketContext(new Date(nowMs));
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const { hour, minute } = istTimeParts(new Date(nowMs));
  return hour * 60 + minute >= 15 * 60 + 25;
}
