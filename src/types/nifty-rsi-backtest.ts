export type NiftyRsiThreshold = 95;

export interface NiftyRsiOccurrence {
  date: string;
  weekday: string;
  threshold: NiftyRsiThreshold;
  /** IST time of the trigger bar (HH:MM). */
  timeIst: string;
  triggerPrice: number;
  triggerRsi: number;
  /** Largest Nifty drop from the trigger price before session close (uses bar lows). */
  maxDrawdownPts: number;
  /** −10 pts touched before 15:00 IST (same as win). */
  hit10Pts: boolean;
  hit20Pts: boolean;
  hit30Pts: boolean;
  /** Minutes from trigger bar to first touch of each level; null if never hit. */
  minutesTo10Pts: number | null;
  minutesTo20Pts: number | null;
  minutesTo30Pts: number | null;
  sessionClosePrice: number;
  /** Nifty close at 15:30 minus trigger price. */
  closeMovePts: number;
  /** Win = −10 pts from entry before 15:00 IST. */
  win: boolean;
  minutesToWin: number | null;
  /** IST time when −10 pts printed (win only). */
  winExitTimeIst: string | null;
}

export interface NiftyRsiThresholdSummary {
  threshold: NiftyRsiThreshold;
  totalTriggers: number;
  hit10Count: number;
  hit10Pct: number;
  hit20Count: number;
  hit20Pct: number;
  hit30Count: number;
  hit30Pct: number;
  avgMaxDrawdownPts: number;
  /** Average minutes to −10 pts among triggers that hit (null if none). */
  avgMinutesTo10Pts: number | null;
  avgMinutesTo20Pts: number | null;
  avgMinutesTo30Pts: number | null;
  avgCloseMovePts: number;
  /** Wins: −10 pts before 15:00 IST. */
  winCount: number;
  lossCount: number;
  winPct: number;
  avgMinutesToWin: number | null;
}

export interface NiftyRsiBacktestRules {
  rsiPeriod: number;
  thresholds: NiftyRsiThreshold[];
  drawdownLevelsPts: number[];
  lookbackTradingDays: number;
  triggerMode: "rsi_reaches_95";
  /** IST window for PE entry when RSI hits 95 (e.g. 9:20–15:00). */
  triggerWindowIst: string;
  /** Short must exit before this time (e.g. 15:00). */
  exitDeadlineIst: string;
  winTargetPts: number;
  entryRsiLevel: number;
  tradeLeg: "PE_BUY";
}

export interface NiftyRsiBacktestResult {
  from: string;
  to: string;
  daysRequested: number;
  builtAt: string;
  rules: NiftyRsiBacktestRules;
  summaries: NiftyRsiThresholdSummary[];
  occurrences: NiftyRsiOccurrence[];
  warnings: string[];
}
