export type NineFifteenHighMinus5Outcome = "win" | "late_win" | "loss" | "no_entry";

export type NineFifteenHighMinus5Variant =
  | "limit_open_minus_5"
  | "limit_open_plus_5"
  | "market_at_open";

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
  /** When true, only sessions with a green 9:15 candle (close > open) are traded. */
  green915Only?: boolean;
  /** Whether entry/TP triggers on moves below (PE) or above (CE) the level. */
  entryDirection?: "below" | "above";
  tpDirection?: "below" | "above";
  /** UI — signal minute label, e.g. "9:15" or "9:00". */
  signalMinuteLabel?: string;
  instrumentLabel?: string;
  lateWinAfterIst?: string;
}

export interface NineFifteenHighMinus5BacktestSlice {
  label: string;
  rules: NineFifteenHighMinus5Rules;
  stats: NineFifteenHighMinus5Stats;
  trades: NineFifteenHighMinus5Trade[];
}

/** One signal minute in the full-day scan (9:20–15:00). */
export interface NineFifteenFullDayTrade {
  date: string;
  weekday: string;
  signalMins: number;
  signalTimeIst: string;
  signalOpen: number;
  signalHigh: number;
  signalLow: number;
  signalClose: number;
  signalChange: number;
  entryLevel: number;
  tpLevel: number;
  entryTimeIst: string | null;
  entryMins: number | null;
  tpTimeIst: string | null;
  tpMins: number | null;
  outcome: NineFifteenHighMinus5Outcome;
}

export interface NineFifteenFullDayBacktestSlice {
  label: string;
  rules: NineFifteenHighMinus5Rules & {
    signalScanStartIst: string;
    signalScanEndIst: string;
  };
  stats: NineFifteenHighMinus5Stats;
  /** Calendar sessions that contributed at least one signal. */
  tradingDays: number;
  trades: NineFifteenFullDayTrade[];
}

export interface NineFifteenFullDayBacktestResult {
  from: string;
  to: string;
  daysRequested: number;
  builtAt: string;
  /** Open − 5 / entry − 10 on every red 1-min candle 9:20–15:00. */
  redOpenMinus5: NineFifteenFullDayBacktestSlice;
  /** Open + 5 / entry + 10 on every green 1-min candle 9:20–15:00. */
  greenOpenPlus5: NineFifteenFullDayBacktestSlice;
  warnings: string[];
}

/** Green 9:15 body ≤ 5 pts and Nifty +20 from open before 10:00 — then score Open + 5 / entry + 10 CE. */
export interface NineFifteenSmallGreenPre10RallyTrade extends NineFifteenHighMinus5Trade {
  /** Max session high minus 9:15 open on minutes strictly before 10:00 IST. */
  pre10MaxRallyPts: number;
  pre10MaxRallyTimeIst: string | null;
}

export interface NineFifteenSmallGreenPre10RallySlice {
  label: string;
  rules: {
    maxGreenBodyPts: number;
    pre10RallyMinPts: number;
    pre10WindowEndIst: string;
    entryOffsetFromOpen: number;
    tpOffsetFromEntry: number;
    /** Take-profit is only checked from this time onward (entry may still fill on 9:15). */
    tpEarliestIst: string;
    scanEndIst: string;
    winWindowEndIst: string;
    lateWinAfterIst: string;
    signalMinuteLabel: string;
    instrumentLabel: string;
  };
  /** Days with green 9:15 and body ≤ maxGreenBodyPts (before the +20 filter). */
  greenSmallBodyDays: number;
  /** Days that also rallied ≥ pre10RallyMinPts from 9:15 open before 10:00. */
  matchingDays: number;
  stats: NineFifteenHighMinus5Stats;
  trades: NineFifteenSmallGreenPre10RallyTrade[];
}

/** Red 9:15 body ≤ 5 pts and Nifty −20 from open before 10:00 — then score Open − 5 / entry − 10 PE. */
export interface NineFifteenSmallRedPre10SelloffTrade extends NineFifteenHighMinus5Trade {
  /** 9:15 open minus min session low on minutes strictly before 10:00 IST. */
  pre10MaxSelloffPts: number;
  pre10MaxSelloffTimeIst: string | null;
}

export interface NineFifteenSmallRedPre10SelloffSlice {
  label: string;
  rules: {
    maxRedBodyPts: number;
    pre10SelloffMinPts: number;
    pre10WindowEndIst: string;
    entryOffsetFromOpen: number;
    tpOffsetFromEntry: number;
    tpEarliestIst: string;
    scanEndIst: string;
    winWindowEndIst: string;
    lateWinAfterIst: string;
    signalMinuteLabel: string;
    instrumentLabel: string;
  };
  /** Days with red 9:15 and body ≤ maxRedBodyPts (before the −20 filter). */
  redSmallBodyDays: number;
  /** Days that also sold off ≥ pre10SelloffMinPts from 9:15 open before 10:00. */
  matchingDays: number;
  stats: NineFifteenHighMinus5Stats;
  trades: NineFifteenSmallRedPre10SelloffTrade[];
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
  /** Open + 5 entry, entry + 10 TP — green 9:15 candles only (close > open). */
  green915Only: NineFifteenHighMinus5BacktestSlice;
  /** Green 9:15 body ≤ 5 pts · Nifty +20 from open before 10:00 · Open + 5 / entry + 10 outcomes. */
  smallGreenPre10Rally?: NineFifteenSmallGreenPre10RallySlice;
  /** Red 9:15 body ≤ 5 pts · Nifty −20 from open before 10:00 · Open − 5 / entry − 10 outcomes. */
  smallRedPre10Selloff?: NineFifteenSmallRedPre10SelloffSlice;
  /** Enter at 9:15 open; TP when Nifty touches open − 10 pts. */
  openAtOpen: NineFifteenHighMinus5BacktestSlice;
  /** Same red/green open±5 strategies on every 1-min signal 9:20–15:00. */
  fullDay: NineFifteenFullDayBacktestResult;
  warnings: string[];
}
