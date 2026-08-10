import { fetchEquityAvailableBalance } from "./kite-client.js";

/** Optional reserve fraction of balance (default 0 = use full available). */
function balanceBufferPct(): number {
  const raw = process.env.NINE_SIXTEEN_BALANCE_BUFFER_PCT?.trim();
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 50) / 100;
}

/** Optional hard cap on lots (0 = no cap). */
function maxLotsCap(): number | null {
  const raw = process.env.NINE_SIXTEEN_MAX_LOTS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
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

  return {
    quantity: lots * lotSize,
    lots,
    availableBalance,
    costPerLot,
    usableBalance,
  };
}
