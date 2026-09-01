// Relative rather than the "@/" alias so the server-side backtest can import this too — the
// server tsconfig has no path mapping.
import type { BotTradeLog } from "../types/trade-log.js";

const BROKERAGE_CAP_INR = 20;
const BROKERAGE_RATE = 0.0003;
const STT_RATE = 0.001;
const EXCHANGE_RATE = 0.00035;
/** ₹10 per crore of turnover. */
const SEBI_RATE = 10 / 10_000_000;
const STAMP_RATE = 0.00003;
const GST_RATE = 0.18;

export interface ZerodhaOptionsCharges {
  buyTurnover: number;
  sellTurnover: number;
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

function orderBrokerage(turnover: number): number {
  return Math.min(BROKERAGE_CAP_INR, turnover * BROKERAGE_RATE);
}

/** Zerodha intraday NIFTY options charges for one round trip (1 buy + 1 sell). */
export function computeZerodhaIntradayOptionsCharges(
  buyPrice: number,
  sellPrice: number,
  qty: number,
): ZerodhaOptionsCharges {
  const buyTurnover = buyPrice * qty;
  const sellTurnover = sellPrice * qty;
  const totalTurnover = buyTurnover + sellTurnover;

  const brokerage = orderBrokerage(buyTurnover) + orderBrokerage(sellTurnover);
  const stt = STT_RATE * sellTurnover;
  const exchange = EXCHANGE_RATE * totalTurnover;
  const sebi = SEBI_RATE * totalTurnover;
  const stamp = STAMP_RATE * buyTurnover;
  const gst = GST_RATE * (brokerage + exchange + sebi);

  return {
    buyTurnover,
    sellTurnover,
    brokerage,
    stt,
    exchange,
    sebi,
    stamp,
    gst,
    total: brokerage + stt + exchange + sebi + stamp + gst,
  };
}

/** Best available buy/sell prices and qty for charge math. */
export function tradeExecutionPrices(
  trade: BotTradeLog,
): { buyPrice: number; sellPrice: number; qty: number } | null {
  const qty = trade.broker?.buyQuantity ?? trade.quantity;
  if (qty == null || qty <= 0) return null;

  const buyPrice = trade.broker?.avgBuyPrice ?? trade.entryPrice;
  let sellPrice = trade.broker?.avgSellPrice ?? trade.exitPrice;

  if (sellPrice == null && buyPrice != null && trade.pnl != null) {
    sellPrice = buyPrice + trade.pnl / qty;
  }

  if (buyPrice == null || sellPrice == null || !(buyPrice > 0) || !(sellPrice > 0)) return null;
  return { buyPrice, sellPrice, qty };
}

export function tradeGrossPnl(trade: BotTradeLog): number | null {
  if (trade.status !== "closed") return null;
  const pnl = trade.broker?.realisedPnl ?? trade.pnl;
  return pnl != null && Number.isFinite(pnl) ? pnl : null;
}

export function tradeCharges(trade: BotTradeLog): ZerodhaOptionsCharges | null {
  const prices = tradeExecutionPrices(trade);
  if (!prices) return null;
  return computeZerodhaIntradayOptionsCharges(prices.buyPrice, prices.sellPrice, prices.qty);
}

export function tradeNetPnl(trade: BotTradeLog): number | null {
  const gross = tradeGrossPnl(trade);
  const charges = tradeCharges(trade);
  if (gross == null || charges == null) return null;
  return gross - charges.total;
}
