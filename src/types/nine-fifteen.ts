export type NineFifteenDirection = "up" | "down" | "flat";

export const NINE_FIFTEEN_RUPEE_LEVELS = [10, 20, 30, 40, 50] as const;
export type NineFifteenRupeLevel = (typeof NINE_FIFTEEN_RUPEE_LEVELS)[number];

export interface NineFifteenCandleRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  direction: NineFifteenDirection;
  /** Max rise from 9:15:00 open during the 1-min bar (high − open). */
  maxGainFromOpen: number;
  /** Max fall from 9:15:00 open during the 1-min bar (open − low). */
  maxLossFromOpen: number;
  gainLevels: Record<NineFifteenRupeLevel, boolean>;
  lossLevels: Record<NineFifteenRupeLevel, boolean>;
  /** Session high after 9:15 (through 3:30 PM). */
  sessionHigh: number;
  /** Session low after 9:15 (through 3:30 PM). */
  sessionLow: number;
  /** Max Nifty rise from 9:15 open anytime during the session. */
  maxDayUpFrom915: number;
  /** Max Nifty fall from 9:15 open anytime during the session. */
  maxDayDownFrom915: number;
  /** Session high touched open + ₹10 … +₹50 (buy CE target zone). */
  dayUpLevels: Record<NineFifteenRupeLevel, boolean>;
  /** Session low touched open − ₹10 … −₹50 (buy PE target zone). */
  dayDownLevels: Record<NineFifteenRupeLevel, boolean>;
}

export interface NineFifteenLevelSummary {
  level: NineFifteenRupeLevel;
  hitCount: number;
  hitPct: number;
}

export interface NineFifteenCandlesResult {
  instrument: string;
  daysRequested: number;
  fromDate: string;
  toDate: string;
  rows: NineFifteenCandleRow[];
  summary: {
    total: number;
    up: number;
    down: number;
    flat: number;
    upPct: number;
    downPct: number;
    gainLevels: NineFifteenLevelSummary[];
    lossLevels: NineFifteenLevelSummary[];
    dayUpLevels: NineFifteenLevelSummary[];
    dayDownLevels: NineFifteenLevelSummary[];
  };
  cePeGuide: NineFifteenCePeGuide;
}

export type NineFifteenOptionSide = "CE" | "PE" | "WAIT";

export interface NineFifteenCePeStrategyStats {
  label: string;
  side: "CE" | "PE" | "MIXED";
  /** Full working-day sample (same for every row). */
  sampleDays: number;
  /** Days this rule would actually place a trade. */
  tradeDays: number;
  targetHits: number;
  /** Wins ÷ tradeDays (when the rule fires). */
  targetHitPct: number;
}

export interface NineFifteenCePeGuide {
  followDirection: NineFifteenCePeStrategyStats;
  alwaysCall: NineFifteenCePeStrategyStats;
  alwaysPut: NineFifteenCePeStrategyStats;
  minuteUpBuyCall: NineFifteenCePeStrategyStats;
  minuteDownBuyPut: NineFifteenCePeStrategyStats;
  minuteUpBuyPut: NineFifteenCePeStrategyStats;
  minuteDownBuyCall: NineFifteenCePeStrategyStats;
  bestStrategy: NineFifteenCePeStrategyStats;
  entryRule: string;
  todaySignal: {
    date: string;
    minuteDirection: NineFifteenDirection;
    side: NineFifteenOptionSide;
    note: string;
  } | null;
}
