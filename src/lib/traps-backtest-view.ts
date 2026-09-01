import type {
  DayScalperOutcome,
  DayScalperSide,
} from "@/types/day-scalper";
import type {
  TrapsBacktestBucket,
  TrapsBacktestDay,
  TrapsBacktestOutcomeCount,
  TrapsBacktestResult,
  TrapsBacktestStats,
  TrapsBacktestTrade,
  TrapsExitProfile,
} from "@/types/traps-backtest";

const SESSION_OPEN_MINS = 9 * 60 + 15;
const SESSION_CLOSE_MINS = 15 * 60 + 30;
const BUCKET_SIZE_MINS = 15;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function minsToHm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function emptyStats(): TrapsBacktestStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    winRatePct: 0,
    grossPnl: 0,
    charges: 0,
    netPnl: 0,
    avgWin: 0,
    avgLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    profitFactor: null,
    avgPnlPct: 0,
    avgHoldMinutes: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    maxDrawdown: 0,
  };
}

function summarise(trades: TrapsBacktestTrade[]): TrapsBacktestStats {
  const stats = emptyStats();
  if (trades.length === 0) return stats;

  const ordered = [...trades].sort((a, b) =>
    a.date === b.date ? a.entryMins - b.entryMins : a.date.localeCompare(b.date),
  );

  let winSum = 0;
  let lossSum = 0;
  let pnlPctSum = 0;
  let holdSum = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let equity = 0;
  let peak = 0;

  for (const trade of ordered) {
    stats.trades += 1;
    stats.grossPnl += trade.grossPnl;
    stats.charges += trade.charges;
    stats.netPnl += trade.netPnl;
    pnlPctSum += trade.pnlPct;
    holdSum += trade.holdMinutes;

    if (trade.netPnl > 0) {
      stats.wins += 1;
      winSum += trade.netPnl;
      winStreak += 1;
      lossStreak = 0;
      stats.maxWinStreak = Math.max(stats.maxWinStreak, winStreak);
      stats.largestWin = Math.max(stats.largestWin, trade.netPnl);
    } else if (trade.netPnl < 0) {
      stats.losses += 1;
      lossSum += Math.abs(trade.netPnl);
      lossStreak += 1;
      winStreak = 0;
      stats.maxLossStreak = Math.max(stats.maxLossStreak, lossStreak);
      stats.largestLoss = Math.min(stats.largestLoss, trade.netPnl);
    } else {
      stats.flat += 1;
      winStreak = 0;
      lossStreak = 0;
    }

    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    stats.maxDrawdown = Math.max(stats.maxDrawdown, peak - equity);
  }

  const decided = stats.wins + stats.losses;
  stats.winRatePct = decided > 0 ? round2((stats.wins / decided) * 100) : 0;
  stats.avgWin = stats.wins > 0 ? round2(winSum / stats.wins) : 0;
  stats.avgLoss = stats.losses > 0 ? round2(-lossSum / stats.losses) : 0;
  stats.profitFactor = lossSum > 0 ? round2(winSum / lossSum) : null;
  stats.avgPnlPct = round2(pnlPctSum / stats.trades);
  stats.avgHoldMinutes = round2(holdSum / stats.trades);
  stats.grossPnl = round2(stats.grossPnl);
  stats.charges = round2(stats.charges);
  stats.netPnl = round2(stats.netPnl);
  stats.largestWin = round2(stats.largestWin);
  stats.largestLoss = round2(stats.largestLoss);
  stats.maxDrawdown = round2(stats.maxDrawdown);
  return stats;
}

function buildBuckets(trades: TrapsBacktestTrade[]): TrapsBacktestBucket[] {
  const buckets: TrapsBacktestBucket[] = [];
  for (let start = SESSION_OPEN_MINS; start < SESSION_CLOSE_MINS; start += BUCKET_SIZE_MINS) {
    const end = start + BUCKET_SIZE_MINS;
    const inBucket = trades.filter((trade) => trade.entryMins >= start && trade.entryMins < end);
    if (inBucket.length === 0) continue;
    buckets.push({
      label: minsToHm(start),
      startMins: start,
      endMins: end,
      stats: summarise(inBucket),
    });
  }
  return buckets;
}

export interface TrapsBacktestView {
  overall: TrapsBacktestStats;
  days: TrapsBacktestDay[];
  buckets: TrapsBacktestBucket[];
  bestBucket: TrapsBacktestBucket | null;
  outcomes: TrapsBacktestOutcomeCount[];
  bySide: { side: DayScalperSide; stats: TrapsBacktestStats }[];
  byProfile: { profile: TrapsExitProfile; stats: TrapsBacktestStats }[];
  trades: TrapsBacktestTrade[];
}

export function buildTrapsBacktestView(data: TrapsBacktestResult): TrapsBacktestView {
  const trades = data.days.flatMap((day) => day.trades);
  const buckets = buildBuckets(trades);
  const ranked = [...buckets].sort((a, b) => b.stats.netPnl - a.stats.netPnl);

  const outcomeOrder: DayScalperOutcome[] = ["trail-stop", "stop", "target", "eod"];
  const outcomes = outcomeOrder
    .map((outcome) => {
      const rows = trades.filter((trade) => trade.outcome === outcome);
      return {
        outcome,
        count: rows.length,
        netPnl: round2(rows.reduce((sum, trade) => sum + trade.netPnl, 0)),
      };
    })
    .filter((row) => row.count > 0);

  const sides: DayScalperSide[] = ["CE", "PE"];
  const profiles: TrapsExitProfile[] = ["opening", "standard"];

  return {
    overall: data.overall,
    days: data.days,
    buckets,
    bestBucket: ranked[0] ?? null,
    outcomes,
    bySide: sides
      .map((side) => ({
        side,
        stats: summarise(trades.filter((trade) => trade.side === side)),
      }))
      .filter((row) => row.stats.trades > 0),
    byProfile: profiles
      .map((profile) => ({
        profile,
        stats: summarise(trades.filter((trade) => trade.exitProfile === profile)),
      }))
      .filter((row) => row.stats.trades > 0),
    trades,
  };
}
