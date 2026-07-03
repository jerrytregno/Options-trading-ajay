export interface KiteOrderRow {
  order_id: string;
  tradingsymbol: string;
  exchange?: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  filled_quantity: number;
  average_price: number;
  price: number;
  status: string;
  product: string;
  order_timestamp: string;
}

export interface ClosedTradeRow {
  id: string;
  tradingsymbol: string;
  product: string;
  quantity: number;
  entryType: "BUY" | "SELL";
  exitType: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryOrderId: string;
  exitOrderId: string;
  closedAt: string;
}

interface OpenLot {
  qty: number;
  price: number;
  orderId: string;
  time: string;
  side: "BUY" | "SELL";
}

function orderKey(order: KiteOrderRow) {
  return `${order.tradingsymbol}:${order.product}`;
}

function filledQty(order: KiteOrderRow) {
  return order.filled_quantity > 0 ? order.filled_quantity : order.quantity;
}

function fillPrice(order: KiteOrderRow) {
  return order.average_price > 0 ? order.average_price : order.price;
}

/** Pair completed BUY/SELL orders into round-trip trades with realised P&L. */
export function buildClosedTrades(orders: KiteOrderRow[]): ClosedTradeRow[] {
  const complete = orders.filter(
    (o) => o.status === "COMPLETE" && filledQty(o) > 0 && fillPrice(o) > 0
  );

  const grouped = new Map<string, KiteOrderRow[]>();
  for (const order of complete) {
    const key = orderKey(order);
    const list = grouped.get(key) ?? [];
    list.push(order);
    grouped.set(key, list);
  }

  const trades: ClosedTradeRow[] = [];

  for (const [key, group] of grouped) {
    const [tradingsymbol, product] = key.split(":");
    const sorted = [...group].sort(
      (a, b) => new Date(a.order_timestamp).getTime() - new Date(b.order_timestamp).getTime()
    );
    const openLots: OpenLot[] = [];

    for (const order of sorted) {
      let remaining = filledQty(order);
      const exitPrice = fillPrice(order);
      const exitSide = order.transaction_type;

      while (remaining > 0 && openLots.length > 0 && openLots[0].side !== exitSide) {
        const lot = openLots[0];
        const matched = Math.min(remaining, lot.qty);
        const pnl =
          lot.side === "BUY"
            ? (exitPrice - lot.price) * matched
            : (lot.price - exitPrice) * matched;

        trades.push({
          id: `${lot.orderId}-${order.order_id}-${matched}`,
          tradingsymbol,
          product,
          quantity: matched,
          entryType: lot.side,
          exitType: exitSide,
          entryPrice: lot.price,
          exitPrice,
          pnl,
          entryOrderId: lot.orderId,
          exitOrderId: order.order_id,
          closedAt: order.order_timestamp,
        });

        lot.qty -= matched;
        remaining -= matched;
        if (lot.qty <= 0) openLots.shift();
      }

      if (remaining > 0) {
        openLots.push({
          qty: remaining,
          price: exitPrice,
          orderId: order.order_id,
          time: order.order_timestamp,
          side: exitSide,
        });
      }
    }
  }

  return trades.sort(
    (a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime()
  );
}

export function summarizePortfolioPnl(
  openPositions: { pnl: number }[],
  closedTrades: ClosedTradeRow[]
) {
  const openPnl = openPositions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const closedPnl = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
  return { openPnl, closedPnl, totalPnl: openPnl + closedPnl };
}

export function normalizeKiteOrder(raw: Record<string, unknown>): KiteOrderRow | null {
  const orderId = String(raw.order_id ?? "");
  const tradingsymbol = String(raw.tradingsymbol ?? "");
  if (!orderId || !tradingsymbol) return null;

  const tx = String(raw.transaction_type ?? "").toUpperCase();
  if (tx !== "BUY" && tx !== "SELL") return null;

  return {
    order_id: orderId,
    tradingsymbol,
    exchange: raw.exchange ? String(raw.exchange) : undefined,
    transaction_type: tx,
    quantity: Number(raw.quantity ?? 0),
    filled_quantity: Number(raw.filled_quantity ?? raw.quantity ?? 0),
    average_price: Number(raw.average_price ?? 0),
    price: Number(raw.price ?? 0),
    status: String(raw.status ?? ""),
    product: String(raw.product ?? "MIS"),
    order_timestamp: String(raw.order_timestamp ?? raw.exchange_timestamp ?? ""),
  };
}

/** Map exit order id -> realised P&L for that order leg. */
export function pnlByExitOrderId(trades: ClosedTradeRow[]) {
  const map = new Map<string, number>();
  for (const trade of trades) {
    map.set(trade.exitOrderId, (map.get(trade.exitOrderId) ?? 0) + trade.pnl);
  }
  return map;
}
