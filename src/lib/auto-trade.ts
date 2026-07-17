import type { GeminiTradeSuggestion } from "@/types/streaming";
import type { ProductType, TradeLeg } from "@/lib/trade-calculations";
import { parseTradeLeg } from "@/lib/trade-calculations";
import { buildProtectedMarketOrder, normalizeKiteOrderBody } from "@/lib/kite-orders";

export const AUTO_TRADE_PLAN_KEY = "optionflow_auto_trade_plan";

/** Poll interval for Options AI scan + entry timing in the auto loop. */
export const AI_LOOP_POLL_MS = 10000;

/** Exit each AI auto-trade as soon as net premium P&L reaches this (INR). */
export const AI_AUTO_TARGET_PROFIT_INR = 150;

/** Gemini AI loop may only open long options — no naked CE_SELL / PE_SELL. */
export type AiLoopEntryAction = "CE_BUY" | "PE_BUY";

export function isAiLoopEntryAction(action: string): action is AiLoopEntryAction {
  return action === "CE_BUY" || action === "PE_BUY";
}

export function isNakedSellAction(action: string): boolean {
  return action === "CE_SELL" || action === "PE_SELL";
}

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

export function shouldExitForProfitInr(pnl: number, targetInr = AI_AUTO_TARGET_PROFIT_INR) {
  return pnl >= targetInr;
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
  const variety = String(payload.variety ?? "regular").toLowerCase();
  const orderType = String(payload.order_type ?? "MARKET").toUpperCase();
  const body =
    variety === "bo"
      ? normalizeKiteOrderBody(payload)
      : orderType === "MARKET" || orderType === "SL-M"
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
  average_price?: number;
  price?: number;
}

export type EntryFillOptions = {
  /** Position qty in this symbol before the entry order — fill confirmed only when qty rises by expectedQty. */
  baselineQty?: number;
};

export type ExitFillOptions = {
  /** Net qty expected after exit (e.g. pre-existing lots left open). Default 0 = fully flat. */
  targetQtyAfterExit?: number;
};

export function readOrderFill(
  order: KiteOrderRecord,
  fallbackQty: number,
): { fillPrice: number; filledQty: number } {
  const filledQty =
    (order.filled_quantity ?? 0) > 0 ? order.filled_quantity! : fallbackQty;
  const fillPrice =
    (order.average_price ?? 0) > 0
      ? order.average_price!
      : (order.price ?? 0) > 0
        ? order.price!
        : 0;
  return { fillPrice, filledQty };
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

export type EntryOrderResolution = {
  outcome: "filled" | "failed" | "pending";
  message: string;
  order?: KiteOrderRecord;
};

/** After a buy attempt, confirm on Zerodha whether we have a position or a terminal order failure. */
export async function resolveEntryAfterOrderAttempt(
  orderId: string | null,
  tradingsymbol: string,
  product: string,
  expectedQty: number
): Promise<EntryOrderResolution> {
  const openQty = Math.abs(await fetchNetPositionQty(tradingsymbol, product));
  if (openQty > 0) {
    return {
      outcome: "filled",
      message: `Position open on Zerodha (${openQty} qty)`,
    };
  }

  if (orderId) {
    const order = await fetchKiteOrder(orderId);
    if (order) {
      const status = order.status?.toUpperCase() ?? "";
      const filled = order.filled_quantity ?? 0;
      if (status === "COMPLETE" || filled >= expectedQty) {
        return { outcome: "filled", message: `Order ${orderId} complete`, order };
      }
      if (status === "REJECTED" || status === "CANCELLED") {
        const detail = order.status_message?.trim();
        return {
          outcome: "failed",
          message: detail ? `${status}: ${detail}` : `Order ${status.toLowerCase()}`,
          order,
        };
      }
      return {
        outcome: "pending",
        message: detailMessage(order, orderId, status),
        order,
      };
    }
  }

  return { outcome: "failed", message: "No position opened on Zerodha" };
}

function detailMessage(order: KiteOrderRecord, orderId: string, status: string): string {
  const detail = order.status_message?.trim();
  return detail ? `Order ${orderId} ${status}: ${detail}` : `Order ${orderId} still ${status}`;
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
      throw new Error(order.status_message ?? `Order ${status.toLowerCase()}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Order ${orderId} not filled within ${Math.round(maxMs / 1000)}s`);
}

function entryFillReached(
  currentQty: number,
  expectedQty: number,
  options: EntryFillOptions,
): boolean {
  if (options.baselineQty !== undefined) {
    return currentQty >= options.baselineQty + expectedQty;
  }
  return currentQty > 0;
}

/** Wait for entry fill — longer timeout + falls back to net position if order status lags. */
export async function waitForKiteEntryFill(
  orderId: string,
  tradingsymbol: string,
  product: string,
  expectedQty: number,
  maxMs = 45_000,
  intervalMs = 750,
  options: EntryFillOptions = {},
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const order = await fetchKiteOrder(orderId);
    if (order) {
      const status = order.status?.toUpperCase() ?? "";
      const filled = order.filled_quantity ?? 0;
      if (status === "COMPLETE" || filled >= expectedQty) return;
      if (status === "REJECTED" || status === "CANCELLED") {
        throw new Error(order.status_message ?? `Order ${status.toLowerCase()}`);
      }
    }
    const openQty = Math.abs(await fetchNetPositionQty(tradingsymbol, product));
    if (entryFillReached(openQty, expectedQty, options)) return;
    await sleep(intervalMs);
  }
  const openQty = Math.abs(await fetchNetPositionQty(tradingsymbol, product));
  if (entryFillReached(openQty, expectedQty, options)) return;
  throw new Error(`Order ${orderId} not filled within ${Math.round(maxMs / 1000)}s (check Kite orders)`);
}

function exitFillReached(currentQty: number, targetQtyAfterExit: number): boolean {
  return Math.abs(currentQty) === Math.abs(targetQtyAfterExit);
}

/** Wait for exit fill — flat net position means success even if order status lags. */
export async function waitForKiteExitFill(
  orderId: string,
  tradingsymbol: string,
  product: string,
  maxMs = 45_000,
  intervalMs = 750,
  options: ExitFillOptions = {},
): Promise<void> {
  const targetQtyAfterExit = options.targetQtyAfterExit ?? 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const openQty = await fetchNetPositionQty(tradingsymbol, product);
    if (exitFillReached(openQty, targetQtyAfterExit)) return;

    const order = await fetchKiteOrder(orderId);
    if (order) {
      const status = order.status?.toUpperCase() ?? "";
      if (status === "COMPLETE") {
        if (exitFillReached(await fetchNetPositionQty(tradingsymbol, product), targetQtyAfterExit)) {
          return;
        }
      }
      if (status === "REJECTED" || status === "CANCELLED") {
        if (exitFillReached(await fetchNetPositionQty(tradingsymbol, product), targetQtyAfterExit)) {
          return;
        }
        throw new Error(order.status_message ?? `Order ${status.toLowerCase()}`);
      }
    }
    await sleep(intervalMs);
  }
  if (exitFillReached(await fetchNetPositionQty(tradingsymbol, product), targetQtyAfterExit)) return;
  throw new Error(`Order ${orderId} not filled within ${Math.round(maxMs / 1000)}s (check Kite orders)`);
}

export interface KiteNetPositionSnapshot {
  tradingsymbol: string;
  product: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
  unrealised: number;
}

type KitePositionRow = {
  tradingsymbol: string;
  product: string;
  quantity: number;
  average_price?: number;
  last_price?: number;
  pnl?: number;
  unrealised?: number;
};

function mapKitePositionRow(pos: KitePositionRow): KiteNetPositionSnapshot {
  return {
    tradingsymbol: pos.tradingsymbol,
    product: pos.product,
    quantity: Math.abs(pos.quantity),
    average_price: Number(pos.average_price ?? 0),
    last_price: Number(pos.last_price ?? 0),
    pnl: Number(pos.pnl ?? 0),
    unrealised: Number(pos.unrealised ?? pos.pnl ?? 0),
  };
}

async function fetchKitePositionRows(): Promise<KitePositionRow[]> {
  const res = await fetch("/api/kite/positions", { credentials: "include" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to fetch positions");
  return (json.data?.net ?? []) as KitePositionRow[];
}

/** All open net positions for a product (default MIS). */
export async function fetchKiteOpenPositions(product = "MIS"): Promise<KiteNetPositionSnapshot[]> {
  const normalizedProduct = product.toUpperCase();
  const net = await fetchKitePositionRows();
  return net
    .filter(
      (p) =>
        p.quantity !== 0 && String(p.product).toUpperCase() === normalizedProduct,
    )
    .map(mapKitePositionRow);
}

export async function fetchKiteNetPosition(
  tradingsymbol: string,
  product = "MIS",
): Promise<KiteNetPositionSnapshot | null> {
  const normalizedProduct = product.toUpperCase();
  const net = await fetchKitePositionRows();
  const pos = net.find(
    (p) =>
      p.tradingsymbol === tradingsymbol &&
      String(p.product).toUpperCase() === normalizedProduct &&
      p.quantity !== 0,
  );
  return pos ? mapKitePositionRow(pos) : null;
}

export async function fetchNetPositionQty(tradingsymbol: string, product = "MIS"): Promise<number> {
  const pos = await fetchKiteNetPosition(tradingsymbol, product);
  return pos?.quantity ?? 0;
}

/** Sum unrealised P/L across all open net positions (excludes closed day trades). */
export async function fetchPortfolioOpenPnl(): Promise<number> {
  const net = await fetchKitePositionRows();
  return net
    .filter((p) => (p.quantity ?? 0) !== 0)
    .reduce((sum, p) => sum + (Number(p.pnl) || 0), 0);
}

export function defaultProduct(plan: AutoTradePlan): ProductType {
  return plan.product === "NRML" ? "NRML" : "MIS";
}
