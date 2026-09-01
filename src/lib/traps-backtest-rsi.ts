import type { TrapsBacktestTrade } from "@/types/traps-backtest";

const RSI_MIN = 0;
const RSI_MAX = 100;
const BUCKET_SIZE = 5;
const TIME_BUCKET_MINS = 15;
const SESSION_OPEN_MINS = 9 * 60 + 15;
const SESSION_CLOSE_MINS = 15 * 60 + 30;
const RANGE_STEP = 5;
const MIN_RANGE_WIDTH = 10;
const MIN_TRADES_FOR_BEST = 3;

export interface TrapsRsiPoint {
  rsi: number;
  win: boolean;
  netPnl: number;
  side: TrapsBacktestTrade["side"];
  date: string;
  entryTimeIst: string;
  entryMins: number;
  timeBucketMins: number;
  rsiBucketMin: number;
}

export interface TrapsRsiMatrixCell {
  wins: number;
  losses: number;
  trades: number;
  netPnl: number;
}

export interface TrapsRsiMatrix {
  /** RSI rows (5-pt bands) that had at least one trade. */
  rsiRows: TrapsRsiBucket[];
  /** 15-min entry columns that had at least one trade. */
  timeCols: TrapsRsiTimeBucket[];
  /** cells[rsiRowIndex][timeColIndex] */
  cells: TrapsRsiMatrixCell[][];
}

export interface TrapsRsiTimeBucket {
  label: string;
  startMins: number;
  endMins: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnl: number;
}

export interface TrapsRsiBucket {
  label: string;
  min: number;
  max: number;
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  winRatePct: number;
  netPnl: number;
}

export interface TrapsRsiRange {
  min: number;
  max: number;
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnl: number;
}

export interface TrapsRsiAnalysis {
  points: TrapsRsiPoint[];
  buckets: TrapsRsiBucket[];
  timeBuckets: TrapsRsiTimeBucket[];
  matrix: TrapsRsiMatrix;
  bestNoLossRange: TrapsRsiRange | null;
  bestLowLossRange: TrapsRsiRange | null;
  missingRsi: number;
}

function minsToHm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function floorRsiToBucket(rsi: number): number {
  const clamped = Math.max(RSI_MIN, Math.min(RSI_MAX - 1, rsi));
  return Math.floor(clamped / BUCKET_SIZE) * BUCKET_SIZE;
}

function cellFromPoints(points: TrapsRsiPoint[]): TrapsRsiMatrixCell {
  let wins = 0;
  let losses = 0;
  let netPnl = 0;
  for (const point of points) {
    netPnl += point.netPnl;
    if (point.win) wins += 1;
    else if (point.netPnl < 0) losses += 1;
  }
  return {
    wins,
    losses,
    trades: points.length,
    netPnl: round2(netPnl),
  };
}

function buildMatrix(
  points: TrapsRsiPoint[],
  rsiRows: TrapsRsiBucket[],
  timeCols: TrapsRsiTimeBucket[],
): TrapsRsiMatrix {
  const cells = rsiRows.map((row) =>
    timeCols.map((col) => {
      const inCell = points.filter(
        (p) =>
          p.rsiBucketMin === row.min &&
          p.timeBucketMins === col.startMins,
      );
      return cellFromPoints(inCell);
    }),
  );
  return { rsiRows, timeCols, cells };
}

export function floorEntryToTimeBucket(mins: number): number {
  return Math.floor(mins / TIME_BUCKET_MINS) * TIME_BUCKET_MINS;
}

function buildTimeBuckets(trades: TrapsBacktestTrade[]): TrapsRsiTimeBucket[] {
  const buckets: TrapsRsiTimeBucket[] = [];
  for (let start = SESSION_OPEN_MINS; start < SESSION_CLOSE_MINS; start += TIME_BUCKET_MINS) {
    const end = start + TIME_BUCKET_MINS;
    const inBucket = trades.filter((t) => t.entryMins >= start && t.entryMins < end);
    if (inBucket.length === 0) continue;
    const stats = rangeStats(inBucket);
    buckets.push({
      label: minsToHm(start),
      startMins: start,
      endMins: end,
      ...stats,
    });
  }
  return buckets;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function bucketLabel(min: number, max: number): string {
  return `${min}–${max}`;
}

function rangeStats(
  trades: TrapsBacktestTrade[],
): Pick<TrapsRsiRange, "trades" | "wins" | "losses" | "winRatePct" | "netPnl"> {
  let wins = 0;
  let losses = 0;
  let netPnl = 0;
  for (const trade of trades) {
    netPnl += trade.netPnl;
    if (trade.netPnl > 0) wins += 1;
    else if (trade.netPnl < 0) losses += 1;
  }
  const decided = wins + losses;
  return {
    trades: trades.length,
    wins,
    losses,
    winRatePct: decided > 0 ? round2((wins / decided) * 100) : 0,
    netPnl: round2(netPnl),
  };
}

function pickBestRange(
  trades: TrapsBacktestTrade[],
  preferZeroLoss: boolean,
): TrapsRsiRange | null {
  const withRsi = trades.filter(
    (t): t is TrapsBacktestTrade & { signalRsi: number } =>
      t.signalRsi != null && Number.isFinite(t.signalRsi),
  );
  if (withRsi.length < MIN_TRADES_FOR_BEST) return null;

  let best: TrapsRsiRange | null = null;

  for (let low = RSI_MIN; low <= RSI_MAX - MIN_RANGE_WIDTH; low += RANGE_STEP) {
    for (let high = low + MIN_RANGE_WIDTH; high <= RSI_MAX; high += RANGE_STEP) {
      const inRange = withRsi.filter((t) => t.signalRsi >= low && t.signalRsi < high);
      if (inRange.length < MIN_TRADES_FOR_BEST) continue;

      const stats = rangeStats(inRange);
      if (preferZeroLoss && stats.losses > 0) continue;

      const candidate: TrapsRsiRange = {
        min: low,
        max: high,
        label: bucketLabel(low, high),
        ...stats,
      };

      if (!best) {
        best = candidate;
        continue;
      }

      const better =
        preferZeroLoss
          ? candidate.trades > best.trades ||
            (candidate.trades === best.trades && candidate.netPnl > best.netPnl)
          : candidate.losses < best.losses ||
            (candidate.losses === best.losses && candidate.trades > best.trades) ||
            (candidate.losses === best.losses &&
              candidate.trades === best.trades &&
              candidate.netPnl > best.netPnl);

      if (better) best = candidate;
    }
  }

  return best;
}

export function buildTrapsRsiAnalysis(trades: TrapsBacktestTrade[]): TrapsRsiAnalysis {
  const withRsi: TrapsBacktestTrade[] = [];
  let missingRsi = 0;

  for (const trade of trades) {
    if (trade.signalRsi == null || !Number.isFinite(trade.signalRsi)) {
      missingRsi += 1;
      continue;
    }
    withRsi.push(trade);
  }

  const points: TrapsRsiPoint[] = withRsi.map((trade) => ({
    rsi: trade.signalRsi as number,
    win: trade.netPnl > 0,
    netPnl: trade.netPnl,
    side: trade.side,
    date: trade.date,
    entryTimeIst: trade.entryTimeIst,
    entryMins: trade.entryMins,
    timeBucketMins: floorEntryToTimeBucket(trade.entryMins),
    rsiBucketMin: floorRsiToBucket(trade.signalRsi as number),
  }));

  const timeBuckets = buildTimeBuckets(withRsi);

  const buckets: TrapsRsiBucket[] = [];
  for (let min = RSI_MIN; min < RSI_MAX; min += BUCKET_SIZE) {
    const max = min + BUCKET_SIZE;
    const inBucket = withRsi.filter((t) => (t.signalRsi as number) >= min && (t.signalRsi as number) < max);
    if (inBucket.length === 0) continue;

    const stats = rangeStats(inBucket);
    buckets.push({
      label: bucketLabel(min, max),
      min,
      max,
      flat: inBucket.length - stats.wins - stats.losses,
      ...stats,
    });
  }

  const bestNoLossRange = pickBestRange(withRsi, true);
  const bestLowLossRange = bestNoLossRange ? null : pickBestRange(withRsi, false);

  const matrix = buildMatrix(points, buckets, timeBuckets);

  return {
    points,
    buckets,
    timeBuckets,
    matrix,
    bestNoLossRange,
    bestLowLossRange,
    missingRsi,
  };
}
