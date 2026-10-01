export type RsiSpeedDirection = "up" | "down";

export type RsiSpeedCeBandId =
  | "10_to_20"
  | "20_to_30"
  | "30_to_40"
  | "40_to_50"
  | "10_to_40"
  | "20_to_40";

export type RsiSpeedPeBandId =
  | "90_to_80"
  | "80_to_70"
  | "70_to_60"
  | "60_to_50"
  | "90_to_60"
  | "80_to_60";

export type RsiSpeedBandId = RsiSpeedCeBandId | RsiSpeedPeBandId;

export interface RsiSpeedBandRules {
  id: RsiSpeedBandId;
  label: string;
  direction: RsiSpeedDirection;
  tradeLeg: "CE_BUY" | "PE_BUY";
  /** CE: prev RSI floor. PE: prev RSI ceiling. */
  fromLevel: number;
  /** CE: RSI must reach this or above. PE: RSI must reach this or below. */
  toLevel: number;
}

export interface NiftyRsiSpeedOccurrence {
  date: string;
  weekday: string;
  bandId: RsiSpeedBandId;
  bandLabel: string;
  tradeLeg: "CE_BUY" | "PE_BUY";
  direction: RsiSpeedDirection;
  timeIst: string;
  triggerPrice: number;
  prevRsi: number;
  triggerRsi: number;
  /** Signed RSI change (positive = up, negative = down). */
  rsiDelta: number;
  /** CE: max Nifty rise from entry. PE: max Nifty drop from entry. */
  maxFavorablePts: number;
  win: boolean;
  minutesToWin: number | null;
  winExitTimeIst: string | null;
  sessionClosePrice: number;
  closeMovePts: number;
}

export interface NiftyRsiSpeedBandSummary {
  bandId: RsiSpeedBandId;
  bandLabel: string;
  tradeLeg: "CE_BUY" | "PE_BUY";
  direction: RsiSpeedDirection;
  totalEntries: number;
  winCount: number;
  lossCount: number;
  winPct: number;
  avgMinutesToWin: number | null;
  avgMaxFavorablePts: number;
  avgRsiDelta: number;
}

export interface NiftyRsiSpeedBacktestRules {
  rsiPeriod: number;
  ceBands: RsiSpeedBandRules[];
  peBands: RsiSpeedBandRules[];
  minRsiJumpPts: number;
  triggerWindowIst: string;
  exitDeadlineIst: string;
  winTargetPts: number;
  lookbackTradingDays: number;
}

export interface NiftyRsiSpeedBacktestResult {
  from: string;
  to: string;
  daysRequested: number;
  builtAt: string;
  rules: NiftyRsiSpeedBacktestRules;
  ceSummaries: NiftyRsiSpeedBandSummary[];
  peSummaries: NiftyRsiSpeedBandSummary[];
  occurrences: NiftyRsiSpeedOccurrence[];
  warnings: string[];
}
