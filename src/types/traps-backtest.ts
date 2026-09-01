import type { DayScalperOutcome, DayScalperSide } from "./day-scalper";

export type TrapsExitProfile = "standard" | "opening";

/**
 * Why a gate-passing signal never became a trade.
 *
 * Being already in a position or past the cutoff is not recorded: both are decided before the
 * signal is scored, so those bars never reach the point where a skip could be raised.
 */
export type TrapsSkipReason =
  | "premium-too-expensive"
  | "no-option-data"
  | "no-option-contract"
  | "rsi-filter";

export interface TrapsBacktestTrade {
  date: string;
  weekday: string;
  /** Minute whose body produced the setup. */
  signalTimeIst: string;
  /** Minute the market buy went out — the one after the signal candle. */
  entryTimeIst: string;
  entryMins: number;
  exitTimeIst: string;
  exitMins: number;
  side: DayScalperSide;
  tradingsymbol: string;
  strike: number;
  expiry: string;
  lotSize: number;
  lots: number;
  quantity: number;
  /** Nifty spot at the signal close and at the exit minute. */
  spotAtEntry: number;
  spotAtExit: number;
  /** High − low of the signal candle. This is what the >minMovePts filter is run against. */
  signalRangePts: number;
  /** Close − open of the signal candle. Sets the side; green takes the CE, red the PE. */
  signalBodyPts: number;
  /** Option LTP when the momentum open gate passed — what the market buy pays. */
  entryPremium: number;
  exitPremium: number;
  pnlPct: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  outcome: DayScalperOutcome;
  exitProfile: TrapsExitProfile;
  /** Ladder rung the stop was resting on when the exit fired (0 = pre-ladder). */
  lockedPnlPct: number;
  holdMinutes: number;
  /** Best and worst premium P&L seen while the trade was open. */
  maxFavourablePct: number;
  maxAdversePct: number;
  /**
   * Wilder RSI(14) on Nifty 1-min closes at the **signal candle's close** — for reference in the
   * trade table only. Measured there rather than at the entry minute because the entry minute's
   * close only exists after the trade is already open.
   *
   * Null when the session is too young for a reading.
   */
  signalRsi: number | null;
}

export interface TrapsBacktestSkip {
  date: string;
  timeIst: string;
  side: DayScalperSide;
  reason: TrapsSkipReason;
  detail: string;
}

export interface TrapsBacktestStats {
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  winRatePct: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  /** Gross profit / gross loss. Null when there were no losers. */
  profitFactor: number | null;
  avgPnlPct: number;
  avgHoldMinutes: number;
  maxWinStreak: number;
  maxLossStreak: number;
  /** Worst peak-to-trough on the running net-P&L curve. */
  maxDrawdown: number;
}

export interface TrapsBacktestBucket {
  /** e.g. "09:15" — bucket start. */
  label: string;
  startMins: number;
  endMins: number;
  stats: TrapsBacktestStats;
}

export interface TrapsBacktestDay {
  date: string;
  weekday: string;
  expiry: string;
  niftyOpen: number;
  niftyClose: number;
  signals: number;
  gatePasses: number;
  stats: TrapsBacktestStats;
  trades: TrapsBacktestTrade[];
  skips: TrapsBacktestSkip[];
  error?: string;
}

export interface TrapsBacktestOutcomeCount {
  outcome: DayScalperOutcome;
  count: number;
  netPnl: number;
}

export interface TrapsBacktestRules {
  minBodyPts: number;
  openGapPts: number;
  standardArmPct: number;
  standardStepPct: number;
  standardStopPct: number;
  standardStopHoldMs: number;
  openingArmPct: number;
  openingStepPct: number;
  openingStopPct: number;
  openingStopHoldMs: number;
  scanStartIst: string;
  entryCutoffIst: string;
  forceExitIst: string;
  rsiPeriod: number;
  /** When true, only entries with signal-candle RSI in rsiAllowedBucketsIst are taken. */
  rsiFilter: boolean;
  rsiAllowedBucketsIst: string;
}

export interface TrapsBacktestResult {
  from: string;
  to: string;
  capital: number;
  maxLots: number;
  builtAt: string;
  rules: TrapsBacktestRules;
  overall: TrapsBacktestStats;
  days: TrapsBacktestDay[];
  /** 15-minute entry buckets across the whole range. */
  buckets: TrapsBacktestBucket[];
  /** Bucket with the highest net P&L, when at least one trade exists. */
  bestBucket: TrapsBacktestBucket | null;
  worstBucket: TrapsBacktestBucket | null;
  outcomes: TrapsBacktestOutcomeCount[];
  bySide: { side: DayScalperSide; stats: TrapsBacktestStats }[];
  byProfile: { profile: TrapsExitProfile; stats: TrapsBacktestStats }[];
  warnings: string[];
}
