import type { GeminiTradeSuggestion } from "@/types/streaming";
import type { ProductType, TradeLeg } from "@/lib/trade-calculations";
import { parseTradeLeg } from "@/lib/trade-calculations";
import { buildProtectedMarketOrder, normalizeKiteOrderBody } from "@/lib/kite-orders";

export const AUTO_TRADE_PLAN_KEY = "optionflow_auto_trade_plan";

export type AutoTradePhase =
  | "idle"
  | "waiting"
  | "entering"
  | "in_position"
  | "exiting"
  | "completed"
  | "cancelled"
  | "error";

export interface AutoTradePlan extends GeminiTradeSuggestion {
  targetPremium?: number;
  stopPremium?: number;
}

export interface AutoTradeLogEntry {
  time: string;
  message: string;
  type?: "info" | "success" | "warning" | "error";
}

export interface EntryTimingResponse {
  signal: "ENTER" | "WAIT" | "ABORT";
  reason: string;
  limitPrice?: number | null;
}

export function saveAutoTradePlan(plan: AutoTradePlan) {
  sessionStorage.setItem(AUTO_TRADE_PLAN_KEY, JSON.stringify(plan));
}

export function loadAutoTradePlan(): AutoTradePlan | null {
  try {
    const raw = sessionStorage.getItem(AUTO_TRADE_PLAN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AutoTradePlan;
  } catch {
    return null;
  }
}

export function clearAutoTradePlan() {
  sessionStorage.removeItem(AUTO_TRADE_PLAN_KEY);
}

export function buildAutoTradePlan(
  suggestion: GeminiTradeSuggestion,
  optionLtp: number
): AutoTradePlan {
  const isBuy = suggestion.action.includes("BUY");
  const base = optionLtp > 0 ? optionLtp : 1;
  return {
    ...suggestion,
    targetPremium: isBuy ? Number((base * 1.2).toFixed(2)) : Number((base * 0.8).toFixed(2)),
    stopPremium: isBuy ? Number((base * 0.85).toFixed(2)) : Number((base * 1.15).toFixed(2)),
  };
}

export function calcPremiumPnl(
  leg: TradeLeg,
  entryPremium: number,
  currentPremium: number,
  quantity: number
) {
  const { transactionType } = parseTradeLeg(leg);
  const perUnit =
    transactionType === "BUY"
      ? currentPremium - entryPremium
      : entryPremium - currentPremium;
  return perUnit * quantity;
}

export function shouldExitPosition(
  leg: TradeLeg,
  _entryPremium: number,
  currentPremium: number,
  targetPremium?: number,
  stopPremium?: number
) {
  const isBuy = leg.includes("BUY");
  if (targetPremium != null) {
    if (isBuy && currentPremium >= targetPremium) return { exit: true, reason: "Target premium hit" };
    if (!isBuy && currentPremium <= targetPremium) return { exit: true, reason: "Target premium hit" };
  }
  if (stopPremium != null) {
    if (isBuy && currentPremium <= stopPremium) return { exit: true, reason: "Stop loss hit" };
    if (!isBuy && currentPremium >= stopPremium) return { exit: true, reason: "Stop loss hit" };
  }
  return { exit: false, reason: "" };
}

export function exitTransactionType(leg: TradeLeg): "BUY" | "SELL" {
  const { transactionType } = parseTradeLeg(leg);
  return transactionType === "BUY" ? "SELL" : "BUY";
}

export async function placeKiteOrder(payload: Record<string, string | number>) {
  const orderType = String(payload.order_type ?? "MARKET").toUpperCase();
  const body =
    orderType === "MARKET" || orderType === "SL-M"
      ? buildProtectedMarketOrder(payload)
      : normalizeKiteOrderBody(payload);

  const res = await fetch("/api/kite/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Order failed");
  const orderId = json.data?.order_id;
  if (!orderId) throw new Error("Order placed but Zerodha returned no order id");
  return { order_id: String(orderId) };
}

export interface KiteOrderRecord {
  order_id: string;
  status: string;
  status_message?: string;
  tradingsymbol?: string;
  filled_quantity?: number;
  quantity?: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function fetchKiteOrder(orderId: string): Promise<KiteOrderRecord | null> {
  const res = await fetch(`/api/kite/orders/${encodeURIComponent(orderId)}`, {
    credentials: "include",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to fetch order status");
  return (json.data as KiteOrderRecord | null) ?? null;
}

/** Poll until Kite marks the order COMPLETE or terminal failure. */
export async function waitForKiteOrderComplete(
  orderId: string,
  maxMs = 20_000,
  intervalMs = 750
): Promise<KiteOrderRecord> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const order = await fetchKiteOrder(orderId);
    if (!order) throw new Error(`Order ${orderId} not found on Zerodha`);
    const status = order.status?.toUpperCase() ?? "";
    if (status === "COMPLETE") return order;
    if (status === "REJECTED" || status === "CANCELLED") {
      throw new Error(order.status_message ?? `Exit order ${status.toLowerCase()}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Order ${orderId} not filled within ${Math.round(maxMs / 1000)}s`);
}

export async function fetchNetPositionQty(tradingsymbol: string, product = "MIS"): Promise<number> {
  const res = await fetch("/api/kite/positions", { credentials: "include" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to fetch positions");
  const net = (json.data?.net ?? []) as Array<{ tradingsymbol: string; product: string; quantity: number }>;
  const pos = net.find((p) => p.tradingsymbol === tradingsymbol && p.product === product);
  return pos?.quantity ?? 0;
}

export function defaultProduct(plan: AutoTradePlan): ProductType {
  return plan.product === "NRML" ? "NRML" : "MIS";
}
