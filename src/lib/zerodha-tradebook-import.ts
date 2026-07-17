import type { KiteOrderRow } from "./portfolio-pnl";

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseSide(raw: string): "BUY" | "SELL" | null {
  const side = raw.trim().toLowerCase();
  if (side === "buy" || side === "b") return "BUY";
  if (side === "sell" || side === "s") return "SELL";
  return null;
}

function productFromSegment(segment: string): string {
  const seg = segment.trim().toUpperCase();
  if (seg.includes("FNO") || seg.includes("F&O") || seg === "OPT" || seg === "FUT") return "MIS";
  if (seg.includes("EQ")) return "CNC";
  return "MIS";
}

function buildTimestamp(tradeDate: string, executionTime: string): string {
  const date = tradeDate.trim();
  const timeRaw = executionTime.trim();
  if (timeRaw.includes("T")) return timeRaw;
  if (date && timeRaw) return `${date}T${timeRaw}`;
  if (date) return `${date}T00:00:00`;
  return new Date().toISOString();
}

/** Parse Zerodha Console tradebook CSV into Kite-like completed orders. */
export function parseZerodhaTradebookCsv(csv: string): KiteOrderRow[] {
  const normalized = csv.replace(/^\uFEFF/, "").trim();
  if (!normalized) return [];

  const lines = normalized.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const idx = (name: string) => headers.indexOf(name);

  const symbolIdx = idx("symbol");
  const tradeDateIdx = idx("trade_date");
  const tradeTypeIdx = idx("trade_type");
  const qtyIdx = idx("quantity");
  const priceIdx = idx("price");
  const orderIdIdx = idx("order_id");
  const tradeIdIdx = idx("trade_id");
  const execIdx = idx("order_execution_time");
  const segmentIdx = idx("segment");

  if (symbolIdx < 0 || tradeTypeIdx < 0 || qtyIdx < 0 || priceIdx < 0) {
    throw new Error(
      "Unrecognized tradebook CSV — need symbol, trade_type, quantity, and price columns",
    );
  }

  const orders: KiteOrderRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const symbol = cols[symbolIdx]?.trim();
    const side = parseSide(cols[tradeTypeIdx] ?? "");
    const quantity = Number(cols[qtyIdx]);
    const price = Number(cols[priceIdx]);
    if (!symbol || !side || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;

    const tradeDate = tradeDateIdx >= 0 ? cols[tradeDateIdx] ?? "" : "";
    const execTime = execIdx >= 0 ? cols[execIdx] ?? "" : "";
    const orderId = orderIdIdx >= 0 ? cols[orderIdIdx]?.trim() : "";
    const tradeId = tradeIdIdx >= 0 ? cols[tradeIdIdx]?.trim() : "";
    const segment = segmentIdx >= 0 ? cols[segmentIdx] ?? "" : "";

    const stableId =
      orderId ||
      tradeId ||
      `${symbol}-${side}-${buildTimestamp(tradeDate, execTime)}-${quantity}-${price}`;

    orders.push({
      order_id: stableId,
      tradingsymbol: symbol,
      transaction_type: side,
      quantity,
      filled_quantity: quantity,
      average_price: price,
      price,
      status: "COMPLETE",
      product: productFromSegment(segment),
      order_timestamp: buildTimestamp(tradeDate, execTime),
    });
  }

  return orders.sort(
    (a, b) => new Date(a.order_timestamp).getTime() - new Date(b.order_timestamp).getTime(),
  );
}
