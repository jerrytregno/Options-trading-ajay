import type { TradeLeg } from "../lib/trade-calculations.js";

export type BotTradeLogStatus = "closed" | "skipped" | "error" | "no_entry";

export interface BotTradeLogEntry {
  time: string;
  message: string;
  type: "info" | "success" | "warning" | "error";
}

export type BotTradeLogSource = "nine-sixteen" | "momentum-scalper";

/** One executed fill exactly as Zerodha reported it. */
export interface BrokerFill {
  tradeId: string;
  orderId: string;
  tradingsymbol: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  price: number;
  /** Exchange fill time, IST, "HH:MM:SS". */
  filledAtIst: string | null;
}

/**
 * Broker-verified view of a trade, reconciled from Zerodha's tradebook. The bot's own numbers are
 * what it acted on; these are what actually executed, so they are stored side by side rather than
 * overwriting each other.
 */
export interface BrokerTradeSummary {
  tradingsymbol: string;
  buyQuantity: number;
  sellQuantity: number;
  avgBuyPrice: number | null;
  avgSellPrice: number | null;
  /** (avg sell − avg buy) × matched qty, as executed. Null while the leg is still open. */
  realisedPnl: number | null;
  firstFillIst: string | null;
  lastFillIst: string | null;
  orderIds: string[];
  fills: BrokerFill[];
  fetchedAt: string;
}

export interface BotTradeLog {
  id: string;
  source: BotTradeLogSource;
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
  /** IST "HH:MM" the bot entered / exited. */
  entryTimeIst?: string | null;
  exitTimeIst?: string | null;
  /** Filled in by the Zerodha tradebook reconcile pass; absent until it runs. */
  broker?: BrokerTradeSummary | null;
}
