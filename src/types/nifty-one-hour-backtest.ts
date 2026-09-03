export type NiftyOneHourTriggerDirection = "up" | "down";

export interface NiftyOneHourOccurrence {
  date: string;
  weekday: string;
  triggerHourLabel: string;
  triggerDirection: NiftyOneHourTriggerDirection;
  /** Net Nifty move during the trigger hour (close − open). */
  triggerMovePts: number;
  triggerMovePct: number;
  triggerStartPrice: number;
  triggerEndPrice: number;
  nextHourLabel: string;
  /** Net Nifty move during the hour after the trigger. */
  nextMovePts: number;
  nextMovePct: number;
  nextStartPrice: number;
  nextEndPrice: number;
}

export interface NiftyOneHourSummary {
  totalOccurrences: number;
  upTriggers: number;
  downTriggers: number;
  /** Average next-hour move after an up trigger. */
  avgNextMoveAfterUp: number;
  /** Average next-hour move after a down trigger. */
  avgNextMoveAfterDown: number;
  /** Share of next hours that moved in the same direction as the trigger. */
  continuationPct: number;
}

export interface NiftyOneHourBacktestRules {
  moveThresholdPts: number;
  triggerWindows: string[];
  lookbackTradingDays: number;
}

export interface NiftyOneHourBacktestResult {
  from: string;
  to: string;
  daysRequested: number;
  builtAt: string;
  rules: NiftyOneHourBacktestRules;
  summary: NiftyOneHourSummary;
  occurrences: NiftyOneHourOccurrence[];
  warnings: string[];
}
