export interface KiteDepthLevel {
  price?: number;
  quantity?: number;
  orders?: number;
}

export interface KiteDepthSnapshot {
  buy?: KiteDepthLevel[];
  sell?: KiteDepthLevel[];
}

export interface OrderBookSummary {
  buyOrders: number;
  sellOrders: number;
  totalOrders: number;
  buyQuantity: number;
  sellQuantity: number;
  buyLevels: number;
  sellLevels: number;
}

export interface RawKiteQuote {
  last_price?: number;
  change?: number;
  change_percent?: number;
  volume?: number;
  buy_quantity?: number;
  sell_quantity?: number;
  ohlc?: {
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  };
  depth?: KiteDepthSnapshot;
}

/** Cumulative session volume delta since the previous quote poll. */
export function calcVolumeDelta(quoteVolume: number, previousQuoteVolume: number): number {
  if (quoteVolume <= 0 || previousQuoteVolume <= 0) return 0;
  if (quoteVolume <= previousQuoteVolume) return 0;
  return quoteVolume - previousQuoteVolume;
}

function sumDepthOrders(levels: KiteDepthLevel[] | undefined): number {
  if (!levels?.length) return 0;
  return levels.reduce((sum, level) => sum + Math.max(0, level.orders ?? 1), 0);
}

function sumDepthQuantity(levels: KiteDepthLevel[] | undefined): number {
  if (!levels?.length) return 0;
  return levels.reduce((sum, level) => sum + Math.max(0, level.quantity ?? 0), 0);
}

/** Sum open order counts and quantities from Kite market depth (top 5 levels). */
export function summarizeOrderBook(
  depth?: KiteDepthSnapshot,
  buyQuantity?: number,
  sellQuantity?: number
): OrderBookSummary {
  const buyOrders = sumDepthOrders(depth?.buy);
  const sellOrders = sumDepthOrders(depth?.sell);
  const depthBuyQty = sumDepthQuantity(depth?.buy);
  const depthSellQty = sumDepthQuantity(depth?.sell);

  return {
    buyOrders,
    sellOrders,
    totalOrders: buyOrders + sellOrders,
    buyQuantity: buyQuantity && buyQuantity > 0 ? buyQuantity : depthBuyQty,
    sellQuantity: sellQuantity && sellQuantity > 0 ? sellQuantity : depthSellQty,
    buyLevels: depth?.buy?.length ?? 0,
    sellLevels: depth?.sell?.length ?? 0,
  };
}

export function enrichQuoteMetrics(
  quote: RawKiteQuote,
  previousCumulativeVolume: number
): {
  volumePerSecond: number;
  cumulativeVolume: number;
  orderBook: OrderBookSummary;
} {
  const cumulativeVolume = quote.volume ?? 0;
  const orderBook = summarizeOrderBook(quote.depth, quote.buy_quantity, quote.sell_quantity);
  return {
    cumulativeVolume,
    volumePerSecond: calcVolumeDelta(cumulativeVolume, previousCumulativeVolume),
    orderBook,
  };
}
