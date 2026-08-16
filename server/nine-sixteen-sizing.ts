import { fetchEquityAvailableBalance } from "./kite-client.js";

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
