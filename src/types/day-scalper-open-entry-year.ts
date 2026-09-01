/** Body-only signal → next-bar open entry → trailing ladder after ±5 (index points). */

export const DAY_SCALPER_OPEN_ENTRY_MIN_BODY_PTS = 10;
/** First rung that arms the trailing ladder (index points from entry). */
export const DAY_SCALPER_OPEN_ENTRY_ARM_PTS = 5;
/** Initial adverse stop before the ladder arms. */
export const DAY_SCALPER_OPEN_ENTRY_SL_PTS = 12;
/** TP and SL both step by this once armed. */
export const DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS = 2;
export const DAY_SCALPER_OPEN_ENTRY_WINDOW_OPEN = "09:20";
export const DAY_SCALPER_OPEN_ENTRY_WINDOW_CLOSE = "14:00";
/** Ten-minute bucket width for the time-of-day breakdown. */
export const DAY_SCALPER_OPEN_ENTRY_BUCKET_MINS = 10;
/** Trades still open this many minutes after entry are bucketed at entry + this. */
export const DAY_SCALPER_OPEN_ENTRY_LONG_TRADE_MINS = 10;

/** @deprecated use ARM_PTS — kept so older UI strings still resolve. */
export const DAY_SCALPER_OPEN_ENTRY_TP_PTS = DAY_SCALPER_OPEN_ENTRY_ARM_PTS;

export type DayScalperOpenEntryOutcome = "initial-stop" | "trail-stop" | "eod";

export interface DayScalperOpenEntryTrade {
  date: string;
  weekday: string;
  side: "CE" | "PE";
  signalTimeIst: string;
  /** Signed body of the signal bar (close − open). */
  signalBodyPts: number;
  entryTimeIst: string;
  /** Minute-of-day of the entry bar (for bucketing). */
  entryMins: number;
  entryPrice: number;
  /** Active TP level in index points from entry when the trade closed. */
  tpPts: number;
  /** Active SL level in index points from entry when the trade closed. */
  slPts: number;
  /** Highest locked rung reached on the ladder (0 before +5 prints). */
  peakLockedPts: number;
  exitTimeIst: string;
  exitMins: number;
  exitPrice: number;
  outcome: DayScalperOpenEntryOutcome;
  pnlPts: number;
  won: boolean;
  barsHeld: number;
  /** Minute-of-day used for the 10-minute win/loss bucket. */
  bucketMins: number;
}

export interface DayScalperOpenEntryDayRow {
  date: string;
  weekday: string;
  trades: number;
  wins: number;
  losses: number;
  ceTrades: number;
  peTrades: number;
  ceWins: number;
  ceLosses: number;
  peWins: number;
  peLosses: number;
  netPts: number;
}

export interface DayScalperOpenEntryTotals {
  sessions: number;
  daysWithTrades: number;
  trades: number;
  wins: number;
  losses: number;
  winPct: number;
  ceTrades: number;
  peTrades: number;
  ceWins: number;
  ceLosses: number;
  peWins: number;
  peLosses: number;
  netPts: number;
  avgPtsPerTrade: number;
}

/** Win/loss counts for one 10-minute window of the session. */
export interface DayScalperOpenEntryTimeBucket {
  /** Start of the window, e.g. "09:20". */
  label: string;
  startMins: number;
  trades: number;
  wins: number;
  losses: number;
  winPct: number;
  ceWins: number;
  ceLosses: number;
  peWins: number;
  peLosses: number;
  netPts: number;
}

export interface DayScalperOpenEntryYearResult {
  indexLabel: string;
  fromDate: string;
  toDate: string;
  sessions: number;
  windowOpenIst: string;
  windowCloseIst: string;
  minBodyPts: number;
  armPts: number;
  initialSlPts: number;
  trailStepPts: number;
  builtAt: string;
  totals: DayScalperOpenEntryTotals;
  timeBuckets: DayScalperOpenEntryTimeBucket[];
  days: DayScalperOpenEntryDayRow[];
  /** Newest first, capped for payload size. */
  trades: DayScalperOpenEntryTrade[];
  totalTrades: number;
}
