export interface MlTradingOptionTrade {
  date: string;
  entryTime: "09:15";
  exitTime: "15:15";
  side: "CE" | "PE";
  action: "Buy Call" | "Buy Put";
  atmStrike: number;
  expiry: string;
  lotSize: number;
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
  exitTime: string;
  lotSize: number;
  expiry: string;
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
