export type NineFifteenHighMinus5Outcome = "win" | "late_win" | "loss" | "no_entry";

export type NineFifteenHighMinus5Variant = "limit_open_minus_5" | "market_at_open";

export interface NineFifteenHighMinus5Trade {
  date: string;
  weekday: string;
  /** 9:15 bar OHLC */
  open915: number;
  high915: number;
  low915: number;
  close915: number;
  change915: number;
  /** Entry when Nifty touches 9:15 open − 5 pts. */
  entryLevel: number;
  /** Take-profit at entry − 10 pts (9:15 open − 15). */
  tpLevel: number;
  entryTimeIst: string | null;
  entryMins: number | null;
  tpTimeIst: string | null;
  tpMins: number | null;
  outcome: NineFifteenHighMinus5Outcome;
}

export interface NineFifteenHighMinus5Stats {
  sessions: number;
  noEntry: number;
  wins: number;
  lateWins: number;
  losses: number;
  /** wins / (wins + lateWins + losses) */
  winRatePct: number;
  /** in-minute wins / entered */
  inMinuteWinPct: number;
  /** Red-only slice: green/flat 9:15 days not evaluated. */
  excludedSessions?: number;
}

export interface NineFifteenHighMinus5Rules {
  variant: NineFifteenHighMinus5Variant;
  /** Points below the 9:15 open for the entry trigger. */
  entryOffsetFromOpen: number;
  tpOffsetFromEntry: number;
  /** Win = TP touched during the 9:15 minute (before 9:16:00). */
  winWindowEndIst: string;
  scanEndIst: string;
  /** When true, only sessions with a red 9:15 candle (close < open) are traded. */
  red915Only?: boolean;
}

export interface NineFifteenHighMinus5BacktestSlice {
  label: string;
  rules: NineFifteenHighMinus5Rules;
  stats: NineFifteenHighMinus5Stats;
  trades: NineFifteenHighMinus5Trade[];
}

export interface NineFifteenHighMinus5BacktestResult {
  from: string;
  to: string;
  daysRequested: number;
  builtAt: string;
  /** Every session in range — any 9:15 candle colour. */
  all: NineFifteenHighMinus5BacktestSlice;
  /** Same rules, but only red 9:15 candles (close < open). */
  red915Only: NineFifteenHighMinus5BacktestSlice;
  /** Enter at 9:15 open; TP when Nifty touches open − 10 pts. */
  openAtOpen: NineFifteenHighMinus5BacktestSlice;
  warnings: string[];
}
