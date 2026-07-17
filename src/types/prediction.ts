export interface PredictionProbabilities {
  down: number;
  flat: number;
  up: number;
  /** @deprecated use down */
  bearish?: number;
  /** @deprecated use flat */
  neutral?: number;
  /** @deprecated use up */
  bullish?: number;
}

export interface PredictionBacktestOptionTrade {
  tradeEntered?: boolean;
  skipped?: boolean;
  skipReason?: string;
  strike: number;
  symbol: string;
  side: "CE" | "PE";
  entryPremium: number | null;
  targetExitPremium?: number | null;
  exitPremium: number | null;
  exitTimeLabel?: string | null;
  holdMinutes?: number | null;
  exitReason?: "target" | "stop" | "eod" | "open" | null;
  lots: number;
  quantity: number;
  costRupees: number | null;
  grossPnlRupees?: number | null;
  brokerageRupees?: number | null;
  pnlRupees: number | null;
}

export interface PredictionOptionTradePlan {
  availableBalance: number;
  lotSize: number;
  expiry: string;
  atmStrike: number;
  spotPrice?: number;
  atmCallSymbol?: string;
  atmPutSymbol?: string;
  atmCallPremium?: number;
  atmPutPremium?: number;
  suggestedLotsCall?: number;
  suggestedLotsPut?: number;
  costPerLotCall?: number;
  costPerLotPut?: number;
  riskPerTradePct: number;
  targetProfitInr?: number;
  stopLossPct?: number;
}

export interface PredictionBacktestBar {
  time: string;
  timeLabel: string;
  close: number;
  nextClose: number | null;
  futureReturnPct: number | null;
  prediction: "down" | "flat" | "up";
  probabilities: { down: number; flat: number; up: number };
  signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE";
  actual: string | null;
  actualClass: number | null;
  match: boolean;
  acceptable?: boolean;
  result?: "correct" | "acceptable" | "wrong" | "unknown" | "pending";
  revealed?: boolean;
  /** True when Up/Down prediction matched next-candle move; null for flat predictions. */
  directionalHit?: boolean | null;
  option?: PredictionBacktestOptionTrade | null;
}

export interface PredictionBacktestResult {
  summary: {
    date: string;
    contextDate?: string;
    historyBars?: number;
    targetBars?: number;
    liveToday?: boolean;
    waitingForSession?: boolean;
    tradePlan?: PredictionOptionTradePlan | null;
    /** Set when today-only Zerodha option enrichment fails. */
    optionEnrichmentError?: string;
    asOf?: string;
    revealedBars?: number;
    pendingBars?: number;
    bars: number;
    correctCount: number;
    wrongCount: number;
    acceptableCount?: number;
    scoredCount?: number;
    correctPct: number;
    wrongPct: number;
    acceptablePct?: number;
    directionAccuracy: number;
    predFlatCount: number;
    predUpCount: number;
    predUpHit: number;
    predUpMiss: number;
    predUpHitPct: number | null;
    predDownCount: number;
    predDownHit: number;
    predDownMiss: number;
    predDownHitPct: number | null;
    directionalCount: number;
    directionalHit: number;
    directionalMiss: number;
    directionalHitPct: number | null;
    signalCount: number;
    signalCorrect: number;
    signalWrong: number;
    signalCorrectPct: number | null;
    signalWrongPct: number | null;
    signalAccuracy: number | null;
  };
  bars: PredictionBacktestBar[];
}

export interface LiveAtmSideScenario {
  direction: "up" | "down";
  side: "CE" | "PE";
  probability: number;
  signalAtThreshold: boolean;
  symbol: string;
  strike: number;
  entryPremium: number;
  entrySource?: "target_open" | "prior_close" | "live";
  costPerLot: number;
  exitPremiumAtClose: number | null;
  exitLabel: string | null;
  candleClosed: boolean;
  exitPremiumLive?: number | null;
  grossPnlLive1Lot?: number | null;
  netPnlLive1Lot?: number | null;
  grossPnl1Lot: number | null;
  netPnl1Lot: number | null;
  targetExitPremium: number | null;
  profitAtMinute: string | null;
  profitAtExitPremium: number | null;
  profitAtNetPnl: number | null;
  profitAtHoldMinutes: number | null;
  profitScanReason: "target" | "stop" | "eod" | "open" | null;
}

export interface LiveAtmScenarios {
  spotPrice: number;
  atmStrike: number;
  expiry: string;
  lotSize: number;
  targetCandleLabel: string;
  callPremium: number;
  putPremium: number;
  callSymbol: string;
  putSymbol: string;
  callCostPerLot: number;
  putCostPerLot: number;
  up: LiveAtmSideScenario;
  down: LiveAtmSideScenario;
  error?: string;
}

export interface PredictionLiveResult {
  interval?: string;
  prediction: "down" | "flat" | "up";
  class: number;
  probabilities: PredictionProbabilities;
  probGreen: number;
  signal: "BUY_CALL" | "BUY_PUT" | "NO_TRADE";
  threshold: number;
  horizon: string;
  features: Record<string, number>;
  liveSnapshot?: Record<string, number>;
  asOf: string;
}

export interface PredictionMetrics {
  schemaVersion?: number;
  modelType?: string;
  interval?: string;
  horizon?: string;
  labelThreshold?: number;
  signalThreshold?: number;
  rows?: number;
  directionalRows?: number;
  holdoutAccuracy?: number;
  directionalHoldoutAccuracy?: number;
  metaValAccuracy?: number;
  walkForwardAccuracy?: number;
  directionalWalkForwardAccuracy?: number;
  walkForwardFolds?: number[];
  featureImportance?: Record<string, number>;
  features?: string[];
}

export interface PredictionStatus {
  interval?: string;
  pythonAvailable: boolean;
  pythonVersion: string | null;
  xgboostAvailable: boolean;
  schemaCurrent: boolean;
  modelTrained: boolean;
  metrics: PredictionMetrics | null;
  instruments: Array<{ id: string; label: string; kiteKey?: string }>;
  primaryId: string;
  note: string;
  trainingDateRange?: { min: string; max: string } | null;
}
