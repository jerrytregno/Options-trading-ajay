export interface NiftyStreamQuote {
  last_price: number;
  change: number;
  change_percent: number;
  volume?: number;
  oi?: number;
}

export interface NiftyStreamResponse {
  instrument: string;
  interval: string;
  candles: unknown[];
  quote: NiftyStreamQuote;
  updatedAt: string;
}

export interface GeminiTradeSuggestion {
  bias: "bullish" | "bearish" | "neutral";
  action: "CE_BUY" | "CE_SELL" | "PE_BUY" | "PE_SELL" | "WAIT";
  strike: number | null;
  product: "MIS" | "NRML";
  orderType: "MARKET" | "LIMIT";
  confidence: "high" | "medium" | "low";
  summary: string;
  entryPlan: string;
  riskPlan: string;
  invalidation: string;
}

export interface GeminiSuggestionResponse {
  suggestion: GeminiTradeSuggestion;
  model: string;
  updatedAt: string;
}
