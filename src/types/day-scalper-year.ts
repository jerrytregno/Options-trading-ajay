import type { DayScalperRules, DayScalperSignalToMarkStats } from "./day-scalper";
import {
  DAY_SCALPER_CLOSE_MARK_MAX,
  DAY_SCALPER_CLOSE_MARK_MIN,
  DAY_SCALPER_INITIAL_STOP_MAX,
  DAY_SCALPER_INITIAL_STOP_MIN,
  DAY_SCALPER_MIN_MOVE_MAX,
  DAY_SCALPER_MIN_MOVE_MIN,
} from "./day-scalper";

/** Every integer close→mark minimum the year view can be sliced at. */
export const DAY_SCALPER_YEAR_CLOSE_MARKS = Array.from(
  { length: DAY_SCALPER_CLOSE_MARK_MAX - DAY_SCALPER_CLOSE_MARK_MIN + 1 },
  (_, i) => DAY_SCALPER_CLOSE_MARK_MIN + i,
);

export interface DayScalperYearCloseMarkRow {
  closeMarkPts: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winPct: number;
  netPts: number;
}

/** Every integer stop the year view can be sliced at. */
export const DAY_SCALPER_YEAR_INITIAL_STOPS = Array.from(
  { length: DAY_SCALPER_INITIAL_STOP_MAX - DAY_SCALPER_INITIAL_STOP_MIN + 1 },
  (_, i) => DAY_SCALPER_INITIAL_STOP_MIN + i,
);

/** Every integer signal-body threshold the year view can be sliced at. */
export const DAY_SCALPER_YEAR_MIN_MOVES = Array.from(
  { length: DAY_SCALPER_MIN_MOVE_MAX - DAY_SCALPER_MIN_MOVE_MIN + 1 },
  (_, i) => DAY_SCALPER_MIN_MOVE_MIN + i,
);

export interface DayScalperYearDayRow {
  date: string;
  weekday: string;
  trades: number;
  ceTrades: number;
  peTrades: number;
  wins: number;
  losses: number;
  winPct: number;
  lossPct: number;
  netPts: number;
  avgPtsPerTrade: number;
  /** Mean trade duration (entry → exit) in minutes for the session. */
  avgLiveMinutes: number;
}

export interface DayScalperYearTotals {
  sessions: number;
  daysWithTrades: number;
  totalTrades: number;
  ceTrades: number;
  peTrades: number;
  wins: number;
  losses: number;
  winPct: number;
  lossPct: number;
  netPts: number;
  avgTradesPerDay: number;
  avgPtsPerDay: number;
  /** Signal close → momentum mark across every trade in the year slice. */
  signalToMark: DayScalperSignalToMarkStats;
}

/** One Zerodha minute bar as `[minsIntoDay, open, high, low, close]`. */
export type DayScalperYearPackedBar = [number, number, number, number, number];

export interface DayScalperYearSession {
  date: string;
  weekday: string;
  bars: DayScalperYearPackedBar[];
}

/**
 * The year cache stores the Zerodha bars themselves rather than a precomputed config grid.
 * Signal body × initial stop × close→mark is 5,120 combinations; materialising per-day rows for
 * all of them runs to ~100 MB, while replaying one config over the year costs a few milliseconds.
 * Keeping the bars also means a rule change only needs a redeploy, not a refetch from Kite.
 */
export interface DayScalperYearResult {
  fromDate: string;
  toDate: string;
  sessions: number;
  builtAt: number;
  rules: DayScalperRules;
  availableMinMoves: number[];
  availableInitialStops: number[];
  availableCloseMarks: number[];
  sessionBars: DayScalperYearSession[];
}

export interface DayScalperYearView {
  fromDate: string;
  toDate: string;
  sessions: number;
  builtAt: number;
  minMovePts: number;
  initialStopPts: number;
  closeMarkPts: number;
  availableMinMoves: number[];
  availableInitialStops: number[];
  availableCloseMarks: number[];
  rules: DayScalperRules;
  days: DayScalperYearDayRow[];
  totals: DayScalperYearTotals;
  stopComparison: Array<{
    initialStopPts: number;
    totalTrades: number;
    winPct: number;
    netPts: number;
  }>;
  minMoveComparison: Array<{
    minMovePts: number;
    totalTrades: number;
    winPct: number;
    netPts: number;
  }>;
  closeMarkComparison: DayScalperYearCloseMarkRow[];
}
