import { roundToOptionTick } from "../src/lib/kite-orders.js";
import { fetchEquityAvailableBalance, fetchOptionLtp } from "./kite-client.js";

/** Gap between the two /quote reads — Kite allows one request per second. */
export const NINE_SIXTEEN_ENTRY_LTP_CONFIRM_DELAY_MS = 1000;
/** Log when the first quote is this much above the second (stale open tick). */
export const NINE_SIXTEEN_ENTRY_LTP_SPIKE_WARN_PCT = 3;

export function conservativeEntryLtpFromQuotes(
  firstLtp: number,
  secondLtp: number,
): { ltp: number; entryLimitPrice: number; spikePct: number; staleFirstQuote: boolean } {
  const ltp = Math.min(firstLtp, secondLtp);
  const entryLimitPrice = roundToOptionTick(secondLtp);
  const spikePct =
    secondLtp > 0 && firstLtp > secondLtp ? ((firstLtp - secondLtp) / secondLtp) * 100 : 0;
  return {
    ltp,
    entryLimitPrice,
    spikePct,
    staleFirstQuote: spikePct >= NINE_SIXTEEN_ENTRY_LTP_SPIKE_WARN_PCT,
  };
}

/** REST fallback when websocket ticks are unavailable (two /quote reads 1s apart). */
export async function fetchConservativeOptionLtpForEntry(
  accessToken: string,
  tradingsymbol: string,
): Promise<{
  ltp: number;
  entryLimitPrice: number;
  firstLtp: number;
  secondLtp: number;
  spikePct: number;
  staleFirstQuote: boolean;
}> {
  const firstLtp = await fetchOptionLtp(accessToken, tradingsymbol);
  if (firstLtp <= 0) throw new Error("Option LTP unavailable for sizing");

  await new Promise((resolve) => setTimeout(resolve, NINE_SIXTEEN_ENTRY_LTP_CONFIRM_DELAY_MS));

  const secondLtp = await fetchOptionLtp(accessToken, tradingsymbol);
  if (secondLtp <= 0) throw new Error("Option LTP confirm fetch unavailable");

  const { ltp, entryLimitPrice, spikePct, staleFirstQuote } = conservativeEntryLtpFromQuotes(
    firstLtp,
    secondLtp,
  );
  return { ltp, entryLimitPrice, firstLtp, secondLtp, spikePct, staleFirstQuote };
}

/** Optional reserve fraction of balance (default 0 = use full available). */
function balanceBufferPct(): number {
  const raw = process.env.NINE_SIXTEEN_BALANCE_BUFFER_PCT?.trim();
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 50) / 100;
}

/** Optional hard cap on total lots per day (0 = no cap). */
function maxLotsCap(): number | null {
  const raw = process.env.NINE_SIXTEEN_MAX_LOTS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/** Exchange-safe max lots per single Kite order (Nifty MIS ~1800 qty ≈ 28 lots). */
export function getMaxLotsPerOrder(): number {
  const raw = process.env.NINE_SIXTEEN_MAX_LOTS_PER_ORDER?.trim();
  const parsed = raw ? Number(raw) : 25;
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.floor(parsed);
}

/** Split total lots into order chunks of at most `maxLotsPerOrder` (default 25). */
export function splitLotsIntoOrderChunks(
  totalLots: number,
  maxLotsPerOrder = getMaxLotsPerOrder(),
): number[] {
  if (totalLots <= 0) return [];
  const cap = Math.max(1, maxLotsPerOrder);
  const chunks: number[] = [];
  let remaining = Math.floor(totalLots);
  while (remaining > 0) {
    const chunk = Math.min(cap, remaining);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

/**
 * Split total quantity into MIS order sizes (each chunk ≤ max lots × lot size).
 * Any non-lot-aligned remainder becomes its own trailing chunk so nothing is left behind.
 */
export function splitQuantityIntoOrderChunks(
  totalQuantity: number,
  lotSize: number,
  maxLotsPerOrder = getMaxLotsPerOrder(),
): number[] {
  if (totalQuantity <= 0) return [];
  if (lotSize <= 0) return [totalQuantity];

  const totalLots = Math.floor(totalQuantity / lotSize);
  const remainder = totalQuantity - totalLots * lotSize;
  if (totalLots <= 0) return [totalQuantity];

  const chunks = splitLotsIntoOrderChunks(totalLots, maxLotsPerOrder).map((lots) => lots * lotSize);
  if (remainder > 0) chunks.push(remainder);
  return chunks;
}

export function formatLotSplitLabel(lotChunks: number[]): string {
  if (lotChunks.length <= 1) return `${lotChunks[0] ?? 0} lot(s)`;
  return `${lotChunks.reduce((a, b) => a + b, 0)} lot(s) in ${lotChunks.length} orders (${lotChunks.join("+")})`;
}

/** Optional premium buffer for market BUY (default 0 = use raw LTP). */
function ltpEstimateMultiplier(): number {
  const raw = process.env.NINE_SIXTEEN_LTP_ESTIMATE_BUFFER_PCT?.trim();
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return 1 + Math.min(parsed, 20) / 100;
}

export function computeAffordableLots(input: {
  availableBalance: number;
  lotSize: number;
  optionLtp: number;
}): { lots: number; costPerLot: number; usableBalance: number } {
  const buffer = balanceBufferPct();
  const usableBalance = input.availableBalance * (1 - buffer);
  const costPerLot = input.optionLtp * input.lotSize * ltpEstimateMultiplier();

  if (costPerLot <= 0 || usableBalance <= 0) {
    return { lots: 0, costPerLot, usableBalance };
  }

  let lots = Math.floor(usableBalance / costPerLot);
  const cap = maxLotsCap();
  if (cap != null) lots = Math.min(lots, cap);

  return { lots: Math.max(0, lots), costPerLot, usableBalance };
}

/**
 * Pick the next size to try after the broker refused the current one for funds.
 *
 * Zerodha usually quotes the required and available margin back, and scaling the lot count by that
 * ratio lands on an affordable size in one step. Without those figures there is nothing to compute
 * from, so it steps down a single lot. Either way the result is always at least one lot smaller,
 * so the retry loop cannot spin on the same quantity.
 */
export function nextEntryLotsAfterMarginReject(
  currentLots: number,
  shortfall: { required: number; available: number } | null,
): number {
  if (currentLots <= 1) return 0;
  let next = currentLots - 1;
  if (shortfall && shortfall.required > 0) {
    const scaled = Math.floor((currentLots * shortfall.available) / shortfall.required);
    if (scaled < next) next = scaled;
  }
  return Math.max(0, next);
}

export async function resolveEntryQuantity(
  accessToken: string,
  lotSize: number,
  optionLtp: number,
  options?: { maxLots?: number },
): Promise<{
  quantity: number;
  lots: number;
  availableBalance: number;
  costPerLot: number;
  usableBalance: number;
}> {
  const availableBalance = await fetchEquityAvailableBalance(accessToken);
  const { lots, costPerLot, usableBalance } = computeAffordableLots({
    availableBalance,
    lotSize,
    optionLtp,
  });

  const cappedLots =
    options?.maxLots != null && options.maxLots >= 0 ? Math.min(lots, Math.floor(options.maxLots)) : lots;

  return {
    quantity: cappedLots * lotSize,
    lots: cappedLots,
    availableBalance,
    costPerLot,
    usableBalance,
  };
}
