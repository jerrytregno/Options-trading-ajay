export type { AutoTradePlan, AutoTradePhase, AutoTradeLogEntry, EntryTimingResponse } from "@/lib/auto-trade";

export interface EntryTimingApiResponse {
  signal: "ENTER" | "WAIT" | "ABORT";
  reason: string;
  limitPrice: number | null;
  model: string;
  updatedAt: string;
  cached?: boolean;
}
