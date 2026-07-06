export interface NiftyStreamQuote {
  last_price: number;
  change: number;
  change_percent: number;
  volume?: number;
  ohlc?: {
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  };
}

export interface NiftyStreamResponse {
  instrument: string;
  interval: "second";
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
  thinking?: string;
  model: string;
  updatedAt: string;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
  refreshInMs?: number;
}

import type { ParsedCandle } from "@/lib/candles";
import type { TechnicalSnapshot } from "@/lib/technical-indicators";

export type { SessionContextCompact } from "@/lib/session-context";

export interface NiftySessionResponse {
  session: import("@/lib/session-context").SessionContextCompact | null;
  instrument?: string;
  candles?: ParsedCandle[];
  technicals?: TechnicalSnapshot | null;
  note?: string;
  updatedAt: string;
  cached?: boolean;
  stale?: boolean;
}
