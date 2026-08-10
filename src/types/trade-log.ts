import type { TradeLeg } from "../lib/trade-calculations.js";

export type BotTradeLogStatus = "closed" | "skipped" | "error" | "no_entry";

export interface BotTradeLogEntry {
  time: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
}

export interface BotTradeLog {
  id: string;
  source: "nine-sixteen";
  dateIST: string;
  status: BotTradeLogStatus;
  leg: TradeLeg | null;
  tradingsymbol: string | null;
  quantity: number | null;
  open915: number | null;
  /** 9:15 close used for entry filter (WS last tick / sealed candle). */
  close915?: number | null;
  /** close − open when both known. */
  change915?: number | null;
  entrySpot: number | null;
  targetSpot: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitSpot: number | null;
  pnl: number | null;
  exitReason: string | null;
  message: string;
  logs: BotTradeLogEntry[];
  createdAt: string;
  closedAt: string | null;
}
