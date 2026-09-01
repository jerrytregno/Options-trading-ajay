import type { NineFifteenCePeFailureTrade } from "@/types/nine-fifteen";

export const NINE_SIXTEEN_BODY_BUCKET_WIDTH = 10;

export interface NineSixteenBodyBucket {
  /** e.g. "0–10", "10–20", "100+" */
  label: string;
  min: number;
  max: number | null;
  count: number;
  wins: number;
  losses: number;
}

type TradeLike = Pick<NineFifteenCePeFailureTrade, "change"> & { won?: boolean };

/**
 * Bucket index for |9:15 close − 9:15 open| in fixed-width bands.
 * 9.9 → 0 (0–10), 10 → 1 (10–20), 42.5 → 4 (40–50).
 */
export function nineSixteenBodyBucketIndex(absChange: number, width = NINE_SIXTEEN_BODY_BUCKET_WIDTH): number {
  if (!Number.isFinite(absChange) || absChange < 0) return 0;
  return Math.floor(absChange / width);
}

export function formatNineSixteenBodyBucketLabel(
  index: number,
  width = NINE_SIXTEEN_BODY_BUCKET_WIDTH,
): string {
  const min = index * width;
  const max = (index + 1) * width;
  return `${min}–${max}`;
}

/**
 * Count every 9:16 entry in the strategy sample by the size of that day's 9:15 candle body.
 * Wins and losses are tallied separately so the chart can show outcome mix later if needed.
 */
export function buildNineSixteenBodyBuckets(
  trades: TradeLike[],
  options?: {
    width?: number;
    /** When set, always show at least through the bucket that contains this floor (e.g. 11 → 10–20). */
    signalFloor?: number;
    /** Cap how many empty high buckets render after the last trade (keeps the x-axis readable). */
    maxTrailingEmpty?: number;
  },
): NineSixteenBodyBucket[] {
  const width = options?.width ?? NINE_SIXTEEN_BODY_BUCKET_WIDTH;
  const maxTrailingEmpty = options?.maxTrailingEmpty ?? 1;
  const tallies = new Map<number, { count: number; wins: number; losses: number }>();
  let maxIndex = 0;

  for (const trade of trades) {
    if (!Number.isFinite(trade.change)) continue;
    const idx = nineSixteenBodyBucketIndex(Math.abs(trade.change), width);
    maxIndex = Math.max(maxIndex, idx);
    const row = tallies.get(idx) ?? { count: 0, wins: 0, losses: 0 };
    row.count += 1;
    if (trade.won === true) row.wins += 1;
    else if (trade.won === false) row.losses += 1;
    tallies.set(idx, row);
  }

  const floor = options?.signalFloor;
  if (floor != null && Number.isFinite(floor) && floor > 0) {
    maxIndex = Math.max(maxIndex, nineSixteenBodyBucketIndex(floor, width));
  }

  // Always show the first three bands so 0–10 / 10–20 / 20–30 exist even when every trade is larger.
  maxIndex = Math.max(maxIndex, 2);

  const lastWithTrades = [...tallies.keys()].reduce((m, k) => Math.max(m, k), -1);
  const renderThrough =
    lastWithTrades < 0
      ? maxIndex
      : Math.max(maxIndex, lastWithTrades + maxTrailingEmpty);

  const buckets: NineSixteenBodyBucket[] = [];
  for (let i = 0; i <= renderThrough; i += 1) {
    const row = tallies.get(i) ?? { count: 0, wins: 0, losses: 0 };
    buckets.push({
      label: formatNineSixteenBodyBucketLabel(i, width),
      min: i * width,
      max: (i + 1) * width,
      count: row.count,
      wins: row.wins,
      losses: row.losses,
    });
  }

  return buckets;
}

/** Merge wins and losses from a strategy block into one list with a `won` flag. */
export function strategyTradesForBodyBuckets(
  successes: NineFifteenCePeFailureTrade[] | undefined,
  failures: NineFifteenCePeFailureTrade[] | undefined,
  minAbsDiff: number,
  maxAbsDiffExclusive?: number,
): TradeLike[] {
  const wins = (successes ?? []).map((t) => ({ ...t, won: true as const }));
  const losses = (failures ?? []).map((t) => ({ ...t, won: false as const }));
  return [...wins, ...losses].filter((t) => {
    const abs = Math.abs(t.change);
    if (abs < minAbsDiff) return false;
    if (maxAbsDiffExclusive != null && abs >= maxAbsDiffExclusive) return false;
    return true;
  });
}
