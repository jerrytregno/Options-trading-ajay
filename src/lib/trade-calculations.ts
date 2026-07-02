export type TradeLeg = "CE_BUY" | "CE_SELL" | "PE_BUY" | "PE_SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type ProductType = "MIS" | "NRML" | "CNC";

export function parseTradeLeg(leg: TradeLeg) {
  const [optionType, transactionType] = leg.split("_") as ["CE" | "PE", "BUY" | "SELL"];
  return { optionType, transactionType };
}

export function legLabel(leg: TradeLeg) {
  const map: Record<TradeLeg, string> = {
    CE_BUY: "Call Buy",
    CE_SELL: "Call Sell",
    PE_BUY: "Put Buy",
    PE_SELL: "Put Sell",
  };
  return map[leg];
}

export function getExecutionPrice(
  orderType: OrderType,
  ltp: number,
  limitPrice: number
) {
  if (orderType === "MARKET" || orderType === "SL-M") return ltp;
  return limitPrice > 0 ? limitPrice : ltp;
}

export function calculateTradeMetrics(input: {
  leg: TradeLeg;
  orderType: OrderType;
  ltp: number;
  limitPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  lots: number;
  lotSize: number;
  strike: number;
}) {
  const { transactionType, optionType } = parseTradeLeg(input.leg);
  const quantity = Math.max(input.lots, 0) * input.lotSize;
  const price = getExecutionPrice(input.orderType, input.ltp, input.limitPrice);
  const total = price * quantity;
  const netPremium = transactionType === "BUY" ? -total : total;

  let maxLoss = 0;
  let maxLossNote = "";

  if (transactionType === "BUY") {
    maxLoss = total;
    if (input.stopLossPrice > 0 && input.stopLossPrice < price) {
      maxLoss = Math.max((price - input.stopLossPrice) * quantity, 0);
      maxLossNote = "Limited by stop loss";
    } else {
      maxLossNote = "Premium paid (long option)";
    }
  } else if (optionType === "PE") {
    maxLoss = Math.max(input.strike * quantity - total, 0);
    maxLossNote = "Strike minus premium received";
    if (input.stopLossPrice > 0 && input.stopLossPrice > price) {
      maxLoss = Math.max((input.stopLossPrice - price) * quantity, 0);
      maxLossNote = "Limited by stop loss";
    }
  } else {
    maxLoss = Number.POSITIVE_INFINITY;
    maxLossNote = "Short call risk is theoretically unlimited";
    if (input.stopLossPrice > 0 && input.stopLossPrice > price) {
      maxLoss = Math.max((input.stopLossPrice - price) * quantity, 0);
      maxLossNote = "Limited by stop loss";
    }
  }

  let targetProfit = 0;
  if (input.targetPrice > 0) {
    targetProfit =
      transactionType === "BUY"
        ? (input.targetPrice - price) * quantity
        : (price - input.targetPrice) * quantity;
  }

  let rewardRisk: number | null = null;
  if (Number.isFinite(maxLoss) && maxLoss > 0 && targetProfit > 0) {
    rewardRisk = targetProfit / maxLoss;
  }

  return {
    quantity,
    price,
    total,
    netPremium,
    maxLoss,
    maxLossNote,
    targetProfit,
    rewardRisk,
  };
}

export function productForExchange(product: ProductType, exchange: string): ProductType {
  if (exchange === "NFO" && product === "CNC") return "NRML";
  return product;
}
