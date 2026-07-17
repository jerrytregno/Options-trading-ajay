import { calcPremiumPnl } from "@/lib/auto-trade";
import {
  getConfidentDirection,
  DISPLAY_CONFIDENCE_THRESHOLD,
  type BarProbabilities,
} from "@/lib/prediction-confidence";
import {
  formatLivePredictionWindow,
  PREDICTION_INTERVAL_MINUTES,
  type PredictionInterval,
} from "@/lib/prediction-intervals";
import type { TradeLeg } from "@/lib/trade-calculations";
import type { PredictionLiveResult } from "@/types/prediction";

/** Net profit target per trade (after ₹50 round-trip charges). */
export const PREDICTION_AUTO_TARGET_NET_INR = 200;
/** Net loss limit per trade (after ₹50 round-trip charges). */
export const PREDICTION_AUTO_STOP_LOSS_NET_INR = 1000;
export const PREDICTION_AUTO_BROKERAGE_INR = 50;
/** Poll shortly after each 1m candle closes (IST). */
export const PREDICTION_AUTO_MINUTE_POLL_BUFFER_MS = 3500;
/** Live option quote + P&L refresh while in a trade (ms). */
export const PREDICTION_AUTO_QUOTE_MS = 250;
/** @deprecated use PREDICTION_AUTO_QUOTE_MS */
export const PREDICTION_AUTO_LTP_MS = PREDICTION_AUTO_QUOTE_MS;
export function strikeFromOptionSymbol(tradingsymbol: string): number {
  const match = tradingsymbol.match(/(\d{4,6})(CE|PE)$/);
  return match ? Number(match[1]) : 0;
}

export function legFromOptionSymbol(tradingsymbol: string): TradeLeg | null {
  if (tradingsymbol.endsWith("CE")) return "CE_BUY";
  if (tradingsymbol.endsWith("PE")) return "PE_BUY";
  return null;
}

/** Minimum P(up)/P(down) to enter a trade from automated trading. */
export const PREDICTION_AUTO_CONFIDENCE_THRESHOLD = DISPLAY_CONFIDENCE_THRESHOLD;

export const PREDICTION_POSITION_SYNC_MS = 2000;
/** Zerodha position qty verification while in a trade (less frequent than quotes). */
export const PREDICTION_AUTO_POSITION_VERIFY_MS = 3000;
export const PREDICTION_AUTO_EXIT_CHECK_MS = PREDICTION_AUTO_QUOTE_MS;
export const NIFTY_SPOT_QUOTE_KEY = "NSE:NIFTY 50";

export type PredictionAutoPhase =
  | "idle"
  | "scanning"
  | "entering"
  | "in_position"
  | "exiting";

export type PredictionTradeStatus = "Open" | "Closed";

export function grossPnlForNetTarget(netInr = PREDICTION_AUTO_TARGET_NET_INR): number {
  return netInr + PREDICTION_AUTO_BROKERAGE_INR;
}

export function netPremiumPnl(grossPnl: number): number {
  return grossPnl - PREDICTION_AUTO_BROKERAGE_INR;
}

export type PredictionAutoExitTrigger = "target" | "stop_loss";

export function getPredictionAutoExitTrigger(grossPnl: number): PredictionAutoExitTrigger | null {
  const net = netPremiumPnl(grossPnl);
  if (net >= PREDICTION_AUTO_TARGET_NET_INR) return "target";
  if (net <= -PREDICTION_AUTO_STOP_LOSS_NET_INR) return "stop_loss";
  return null;
}

export function shouldExitPredictionTrade(grossPnl: number): boolean {
  return getPredictionAutoExitTrigger(grossPnl) !== null;
}

/** True when portfolio open P/L has risen by the net target since entry snapshot. */
export function shouldExitPortfolioIncremental(
  currentPortfolioOpenPnl: number,
  portfolioOpenPnlAtEntry: number,
  targetNet = PREDICTION_AUTO_TARGET_NET_INR,
): boolean {
  return currentPortfolioOpenPnl - portfolioOpenPnlAtEntry >= targetNet;
}

export function canEnterPredictionTrade(
  symbolBaselineQty: number,
  otherOpenPositions = 0,
): { ok: true } | { ok: false; reason: string } {
  if (otherOpenPositions > 0) {
    return {
      ok: false,
      reason: `${otherOpenPositions} open Zerodha position(s) — managing until +₹${PREDICTION_AUTO_TARGET_NET_INR} net before new entries`,
    };
  }
  if (symbolBaselineQty > 0) {
    return {
      ok: false,
      reason: `Existing ${symbolBaselineQty} qty in this symbol — managing until +₹${PREDICTION_AUTO_TARGET_NET_INR} net`,
    };
  }
  return { ok: true };
}

/** Pick the next open position to manage (stable order). */
export function pickPositionToManage<T extends { tradingsymbol: string; quantity: number }>(
  positions: T[],
): T | null {
  const open = positions.filter((p) => p.quantity > 0);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol))[0];
}

export function calcLiveNetPnl(
  leg: TradeLeg,
  entryPremium: number,
  currentPremium: number,
  quantity: number,
): number {
  const gross = calcPremiumPnl(leg, entryPremium, currentPremium, quantity);
  return netPremiumPnl(gross);
}

type ZerodhaPositionPnlRow = {
  pnl: number;
  unrealised?: number;
  quantity: number;
};

/** Gross open P/L from Zerodha positions API (prefer unrealised for open legs). */
export function zerodhaPositionGrossPnl(pos: ZerodhaPositionPnlRow): number {
  const raw = pos.unrealised ?? pos.pnl;
  return Number.isFinite(raw) ? raw : pos.pnl;
}

/** Absolute gross P/L shown in Kite — prorated when bot qty < position qty. */
export function calcBotDisplayGrossPnlFromZerodha(
  pos: ZerodhaPositionPnlRow,
  botQty: number,
): number {
  const gross = zerodhaPositionGrossPnl(pos);
  if (botQty <= 0 || pos.quantity <= 0) return 0;
  if (botQty >= pos.quantity) return gross;
  return (gross / pos.quantity) * botQty;
}

/** Gross P/L gained since bot cycle entry (for exit targets). */
export function calcBotCycleGrossPnl(
  currentPositionPnl: number,
  positionPnlAtEntry: number,
  botQty: number,
  positionQty: number,
): number {
  const delta = currentPositionPnl - positionPnlAtEntry;
  if (botQty <= 0 || positionQty <= 0) return delta;
  if (botQty >= positionQty) return delta;
  return (delta / positionQty) * botQty;
}

/** @deprecated use calcBotCycleGrossPnl */
export function calcBotGrossPnlFromPosition(
  currentPositionPnl: number,
  positionPnlAtEntry: number,
): number {
  return currentPositionPnl - positionPnlAtEntry;
}

/** Premium-based gross P/L fallback when Zerodha position P/L is unavailable. */
export function calcBotGrossPnlFromPremium(
  leg: TradeLeg,
  entryPremium: number,
  currentPremium: number,
  quantity: number,
): number {
  return calcPremiumPnl(leg, entryPremium, currentPremium, quantity);
}

export function parseLiveAsOfMs(asOf: string): number | null {
  const ms = new Date(asOf).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Start of the candle being predicted (next bar after asOf). */
export function targetCandleStartMs(
  asOf: string,
  interval: PredictionInterval = "minute",
): number | null {
  const base = parseLiveAsOfMs(asOf);
  if (base == null) return null;
  return base + PREDICTION_INTERVAL_MINUTES[interval] * 60_000;
}

/** True during the predicted 1m candle — entry aligned to next-minute chart. */
export function isWithinNextMinuteEntryWindow(
  asOf: string,
  interval: PredictionInterval = "minute",
  nowMs = Date.now(),
): boolean {
  const targetStart = targetCandleStartMs(asOf, interval);
  if (targetStart == null) return false;
  const windowMs = PREDICTION_INTERVAL_MINUTES[interval] * 60_000;
  return nowMs >= targetStart && nowMs < targetStart + windowMs;
}

export function msUntilNextMinutePoll(bufferMs = PREDICTION_AUTO_MINUTE_POLL_BUFFER_MS): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const sec = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  const msIntoMinute = sec * 1000 + (Date.now() % 1000);
  const wait = 60_000 - msIntoMinute + bufferMs;
  return Math.max(500, wait);
}

export function predictionLegFromLive(live: PredictionLiveResult): TradeLeg | null {
  const direction = getConfidentDirection(
    live.probabilities as BarProbabilities,
    PREDICTION_AUTO_CONFIDENCE_THRESHOLD,
    0,
  );
  if (direction === "up") return "CE_BUY";
  if (direction === "down") return "PE_BUY";
  return null;
}

export function isActionableNextMinuteSignal(
  live: PredictionLiveResult,
  consumedAsOf: Set<string>,
  interval: PredictionInterval = "minute",
  nowMs = Date.now(),
): { ok: true; leg: TradeLeg } | { ok: false; reason: string } {
  if (!live.asOf) return { ok: false, reason: "No candle timestamp" };
  if (consumedAsOf.has(live.asOf)) {
    return { ok: false, reason: "Already traded this candle signal" };
  }
  if (!isWithinNextMinuteEntryWindow(live.asOf, interval, nowMs)) {
    const window = formatLivePredictionWindow(live.asOf, interval, nowMs);
    return {
      ok: false,
      reason: `${window.toLabel || "Next"} · waiting for entry window`,
    };
  }
  const leg = predictionLegFromLive(live);
  if (!leg) {
    const { down, up } = live.probabilities;
    const best = Math.max(down, up);
    const window = formatLivePredictionWindow(live.asOf, interval, nowMs);
    return {
      ok: false,
      reason: `${window.toLabel || "Next"} · below ${(PREDICTION_AUTO_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% (best ${(best * 100).toFixed(1)}%)`,
    };
  }
  return { ok: true, leg };
}

export function predictionConfidenceLabel(live: PredictionLiveResult): string {
  const { down, up } = live.probabilities;
  const direction = getConfidentDirection(live.probabilities, PREDICTION_AUTO_CONFIDENCE_THRESHOLD, 0);
  if (direction === "up") return `Up ${(up * 100).toFixed(1)}%`;
  if (direction === "down") return `Down ${(down * 100).toFixed(1)}%`;
  const best = Math.max(down, up);
  return `Below ${(PREDICTION_AUTO_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% (best ${(best * 100).toFixed(1)}%)`;
}

export function nextMinuteWatchLabel(
  live: PredictionLiveResult | null,
  interval: PredictionInterval = "minute",
  nowMs = Date.now(),
): string {
  if (!live?.asOf) return "Waiting for next 1m prediction…";
  const window = formatLivePredictionWindow(live.asOf, interval, nowMs);
  return `${window.summary} · ${predictionConfidenceLabel(live)}`;
}

/** Faster polling near / inside the predicted candle entry window. */
export function msUntilNextAutoTradePoll(
  live: PredictionLiveResult | null,
  interval: PredictionInterval = "minute",
  nowMs = Date.now(),
): number {
  if (!live?.asOf || interval !== "minute") {
    return msUntilNextMinutePoll();
  }
  const targetStart = targetCandleStartMs(live.asOf, interval);
  if (targetStart == null) return msUntilNextMinutePoll();
  const windowMs = PREDICTION_INTERVAL_MINUTES[interval] * 60_000;
  const windowEnd = targetStart + windowMs;
  if (nowMs >= targetStart - 10_000 && nowMs < windowEnd + 3000) {
    return 2000;
  }
  return msUntilNextMinutePoll();
}

export async function fetchNiftySpotPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      `/api/kite/quotes?instruments=${encodeURIComponent(NIFTY_SPOT_QUOTE_KEY)}`,
      { credentials: "include" },
    );
    const json = await res.json();
    if (!res.ok) return null;
    const quote = json.data?.[NIFTY_SPOT_QUOTE_KEY] as { last_price?: number } | undefined;
    const price = quote?.last_price;
    return price != null && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function fetchPredictionLive(): Promise<PredictionLiveResult | null> {
  try {
    const res = await fetch("/api/prediction/live?interval=minute", { credentials: "include" });
    const json = await res.json();
    if (!res.ok) return null;
    return json.data as PredictionLiveResult;
  } catch {
    return null;
  }
}

export async function fetchOptionQuote(tradingsymbol: string): Promise<{
  last: number;
  bid: number;
  /** Best estimate for marking long option P&L (last tick, else top bid). */
  mark: number;
}> {
  const empty = { last: 0, bid: 0, mark: 0 };
  try {
    const res = await fetch(
      `/api/kite/quotes?instruments=${encodeURIComponent(`NFO:${tradingsymbol}`)}`,
      { credentials: "include" },
    );
    const json = await res.json();
    if (!res.ok) return empty;
    const quote = json.data?.[`NFO:${tradingsymbol}`] as
      | {
          last_price?: number;
          depth?: { buy?: { price?: number }[]; sell?: { price?: number }[] };
        }
      | undefined;
    const last = quote?.last_price ?? 0;
    const bid = quote?.depth?.buy?.[0]?.price ?? 0;
    const mark = last > 0 ? last : bid;
    return { last, bid, mark };
  } catch {
    return empty;
  }
}

export async function fetchOptionLtp(tradingsymbol: string): Promise<number> {
  const quote = await fetchOptionQuote(tradingsymbol);
  return quote.mark;
}
