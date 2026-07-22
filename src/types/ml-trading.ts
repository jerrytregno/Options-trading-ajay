export interface MlTradingOptionTrade {
  date: string;
  entryTime: "09:15";
  exitTime: string;
  exitReason: "target" | "eod";
  targetProfitInr: number;
  targetProfitRupees: number;
  targetHit: boolean;
  side: "CE" | "PE";
  action: "Buy Call" | "Buy Put";
  atmStrike: number;
  expiry: string;
  lotSize: number;
  lots: number;
  symbol: string | null;
  entrySpot: number;
  exitSpot: number;
  spotMovePct: number;
  entryPremium: number;
  exitPremium: number;
  quantity: number;
  costRupees: number;
  grossPnlRupees: number;
  brokerageRupees: number;
  netPnlRupees: number;
  dataSource: "kite" | "model";
  isProjection: boolean;
  note?: string;
}

export interface MlTradingOptionTradeMeta {
  entryTime: string;
  exitRule: string;
  sessionEnd: string;
  lots: number;
  lotSize: number;
  expiry: string;
  targetProfitInr: number;
  note: string;
}

export interface MlTradingHourSlot {
  time: string;
  hour_label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  high_pct: number;
  low_pct: number;
  close_pct: number;
}

export interface MlTradingHourPrediction {
  hourLabel: string;
  hourIndex: number;
  status: "actual" | "predicted" | "pending";
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  predOpen: number | null;
  predHigh: number | null;
  predLow: number | null;
  predClose: number | null;
  hourBias: "bullish" | "bearish" | "neutral";
  confidence: number;
  closestFallback?: boolean;
}

export interface MlTradingWeekMatch {
  weekId: string;
  similarity: number;
  weekStart: string;
  weekDaysMatched: string[];
  todayAnalogDate: string;
  todayAnalogOutcome: "bullish" | "bearish" | "neutral";
  todayAnalogDayReturnPct: number;
  todayAnalogFullDaySlots: MlTradingHourSlot[];
  closestFallback?: boolean;
}

export interface MlTradingMatch {
  date: string;
  similarity: number;
  outcome: "bullish" | "bearish" | "neutral";
  dayReturnPct: number;
  restOfDayReturnPct: number;
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
  matchedBars: number;
  matchedThrough: string;
  fullDayBarCount: number;
  matchedSlots: MlTradingHourSlot[];
  fullDaySlots: MlTradingHourSlot[];
  closestFallback?: boolean;
  slots?: MlTradingHourSlot[];
}

export interface MlTradingCurrentPattern {
  dayOpen: number;
  dayClose: number;
  dayHigh: number;
  dayLow: number;
  dayReturnPct: number;
  dayCloseSoFar: number;
  dayHighSoFar: number;
  dayLowSoFar: number;
  matchedBars: number;
  fullDayBarCount: number;
  matchedSlots: MlTradingHourSlot[];
  fullDaySlots: MlTradingHourSlot[];
  vectorLength: number;
  slots?: MlTradingHourSlot[];
}

export interface MlTradingMatchResult {
  matchMode?: "week" | "day";
  currentWeekId?: string;
  weekOpen?: number;
  weekDaysIncluded?: string[];
  weekPatternBars?: number;
  weekMatches?: MlTradingWeekMatch[];
  hourPredictions?: MlTradingHourPrediction[];
  usedClosestMatch?: boolean;
  bestSimilarity?: number;
  dayMatches?: MlTradingMatch[];
  currentDate: string;
  compareBars: number;
  compareThrough: string;
  sessionBars?: number;
  actualBarsToday?: number;
  currentPattern: MlTradingCurrentPattern;
  prediction: "bullish" | "bearish" | "neutral";
  confidence: number;
  probabilities: {
    bullish: number;
    bearish: number;
    neutral: number;
  };
  expectedDayReturnPct: number;
  expectedRestOfDayReturnPct: number;
  matches: MlTradingMatch[];
  libraryDays: number;
  todayOptionTrade?: MlTradingOptionTrade | null;
  weekOptionTrades?: Record<string, MlTradingOptionTrade | null>;
  dayOptionTrades?: Record<string, MlTradingOptionTrade | null>;
  avgHistoricalNetPnl?: number | null;
  optionTradeMeta?: MlTradingOptionTradeMeta;
  optionTradesError?: string;
}

export interface MlTradingStatus {
  pythonAvailable: boolean;
  pythonVersion: string | null;
  libraryBuilt: boolean;
  patternCount: number;
  firstDate: string | null;
  lastDate: string | null;
  lastSyncedAt: string | null;
  candleCount: number;
  instrument: string;
  interval: string;
  days: number;
  note: string;
}

export interface MlTradingBacktestComparisonRow {
  hourLabel: string;
  hourIndex: number;
  status: "actual" | "predicted" | "pending";
  predOpen: number | null;
  predHigh: number | null;
  predLow: number | null;
  predClose: number | null;
  actualOpen: number;
  actualHigh: number;
  actualLow: number;
  actualClose: number;
  closeErrorPct: number | null;
  predBias: "bullish" | "bearish" | "neutral";
  actualBias: "bullish" | "bearish" | "neutral";
  biasCorrect: boolean | null;
  confidence: number;
}

export interface MlTradingBacktestAccuracy {
  directionCorrect: boolean;
  predictedOutcome: "bullish" | "bearish" | "neutral";
  actualOutcome: "bullish" | "bearish" | "neutral";
  predictedDayReturnPct: number;
  actualDayReturnPct: number;
  dayReturnErrorPct: number;
  predictedClose: number | null;
  actualClose: number;
  closeErrorPct: number | null;
  hourCloseMaePct: number | null;
  predictedHourCount: number;
  hourBiasAccuracyPct: number | null;
}

export interface MlTradingBacktestMeta {
  targetDate: string;
  libraryStart: string;
  libraryEnd: string;
  libraryDays: number;
  candleWindowDays: number;
  simulationBars: number;
  simulationThrough: string;
  actual: {
    dayOpen: number;
    dayClose: number;
    dayHigh: number;
    dayLow: number;
    dayReturnPct: number;
    outcome: "bullish" | "bearish" | "neutral";
    barCount: number;
    slots: MlTradingHourSlot[];
  };
  comparison: MlTradingBacktestComparisonRow[];
  accuracy: MlTradingBacktestAccuracy;
}

export type MlTradingBacktestResult = MlTradingMatchResult & {
  backtest: MlTradingBacktestMeta;
};

export interface MlTradingBatchDayRow {
  date: string;
  directionCorrect: boolean;
  predictedOutcome: "bullish" | "bearish" | "neutral";
  actualOutcome: "bullish" | "bearish" | "neutral";
  predictedDayReturnPct: number;
  actualDayReturnPct: number;
  dayReturnErrorPct: number;
  profitTargetHit?: boolean;
  success?: boolean;
  optionSide?: "CE" | "PE" | null;
  optionNetPnlRupees?: number | null;
  optionExitTime?: string | null;
  optionExitReason?: "target" | "eod" | null;
  targetProfitInr?: number;
}

export interface MlTradingBatchOutcomeStats {
  count: number;
  correct: number;
}

export interface MlTradingBatchBacktestResult {
  daysRequested: number;
  daysTested: number;
  daysSkipped: number;
  daysCorrect: number;
  daysWrong: number;
  directionAccuracyPct: number;
  profitTargetAccuracyPct?: number;
  targetProfitInr?: number;
  successMetric?: "profit_target" | "direction";
  avgDayReturnErrorPct: number | null;
  dateRange: { first: string | null; last: string | null };
  byPredictedOutcome: {
    bullish: MlTradingBatchOutcomeStats;
    bearish: MlTradingBatchOutcomeStats;
    neutral: MlTradingBatchOutcomeStats;
  };
  byActualOutcome?: {
    bullish: MlTradingBatchOutcomeStats;
    bearish: MlTradingBatchOutcomeStats;
    neutral: MlTradingBatchOutcomeStats;
  };
  days: MlTradingBatchDayRow[];
  optionTradesError?: string;
}
