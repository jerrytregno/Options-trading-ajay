import { normalizeKiteOrderBody, resolveMarketProtection } from "../src/lib/kite-orders.js";
import { kiteHttpFetch } from "./kite-http.js";
import { enrichKiteIpOrderError } from "./trading-ip.js";

const KITE_BASE = "https://api.kite.trade";
const KITE_HTTP_MAX_ATTEMPTS = 4;
const KITE_HTTP_RETRY_BASE_MS = 400;

interface KiteApiResponse<T = unknown> {
  status: string;
  message?: string;
  data?: T;
}

function getApiKey(): string {
  const apiKey = process.env.KITE_API_KEY?.trim();
  if (!apiKey || apiKey === "your_api_key") {
    throw new Error("KITE_API_KEY not configured");
  }
  return apiKey;
}

export function parseKiteResponse<T>(json: unknown): T {
  const payload = json as KiteApiResponse<T>;
  if (payload.status === "error") {
    throw new Error(payload.message ?? "Kite API error");
  }
  return payload.data as T;
}

async function enrichKiteApiError(error: unknown): Promise<Error> {
  const message = error instanceof Error ? error.message : "Kite API error";
  return new Error(await enrichKiteIpOrderError(message));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeHtml(body: string): boolean {
  const trimmed = body.trimStart().slice(0, 64).toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<head") ||
    trimmed.startsWith("<body") ||
    trimmed.startsWith("<?xml")
  );
}

function formatNonJsonKiteError(status: number, body: string, contentType: string | null): Error {
  const kind = looksLikeHtml(body) ? "HTML" : "non-JSON";
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 80);
  return new Error(
    `Kite returned ${kind} instead of JSON (HTTP ${status}${contentType ? `, ${contentType}` : ""})${snippet ? `: ${snippet}` : ""}`,
  );
}

function isTransientKiteTransportError(message: string): boolean {
  return /HTML instead of JSON|non-JSON|empty body|Unexpected token|is not valid JSON|ECONNRESET|ETIMEDOUT|fetch failed|network|502|503|504|429/i.test(
    message,
  );
}

/**
 * Read Kite response as JSON. Detects nginx/HTML bodies so callers can retry
 * instead of failing with "Unexpected token '<'".
 */
async function readKiteJsonBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type");
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Kite returned empty body (HTTP ${res.status})`);
  }
  if (looksLikeHtml(text) || (contentType && /text\/html/i.test(contentType) && !text.trim().startsWith("{"))) {
    throw formatNonJsonKiteError(res.status, text, contentType);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    if (looksLikeHtml(text) || /Unexpected token/i.test(err instanceof Error ? err.message : "")) {
      throw formatNonJsonKiteError(res.status, text, contentType);
    }
    throw err;
  }
}

export async function kiteGet<T>(path: string, accessToken: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= KITE_HTTP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${getApiKey()}:${accessToken}`,
        },
      });
      const json = await readKiteJsonBody(res);
      try {
        return parseKiteResponse<T>(json);
      } catch (error) {
        // Business errors from Kite (status:error) are not retryable HTTP glitches
        throw await enrichKiteApiError(error);
      }
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransientKiteTransportError(msg)) {
        throw err instanceof Error ? err : new Error(msg);
      }
      if (attempt >= KITE_HTTP_MAX_ATTEMPTS) break;
      await sleep(KITE_HTTP_RETRY_BASE_MS * attempt);
    }
  }

  throw await enrichKiteApiError(lastError);
}

export async function kitePost<T>(
  path: string,
  accessToken: string,
  body: Record<string, string>,
): Promise<T> {
  let lastError: unknown;
  // Orders: only retry pure transport failures (no response). Never retry after an HTML
  // body — the order may already be live and a second POST would double-fill.
  const maxAttempts = path.includes("/orders/") ? 2 : KITE_HTTP_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${getApiKey()}:${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body),
      });
      const json = await readKiteJsonBody(res);
      try {
        return parseKiteResponse<T>(json);
      } catch (error) {
        throw await enrichKiteApiError(error);
      }
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isOrderPath = path.includes("/orders/");
      const canRetry =
        !isOrderPath
          ? isTransientKiteTransportError(msg)
          : /ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg);
      if (!canRetry || attempt >= maxAttempts) {
        throw err instanceof Error ? err : await enrichKiteApiError(err);
      }
      await sleep(KITE_HTTP_RETRY_BASE_MS * attempt);
    }
  }

  throw await enrichKiteApiError(lastError);
}

export async function placeRegularMarketOrder(
  accessToken: string,
  order: {
    tradingsymbol: string;
    exchange: string;
    transaction_type: "BUY" | "SELL";
    product: string;
    quantity: number;
  },
): Promise<string> {
  const marketProtection = resolveMarketProtection(process.env.KITE_MARKET_PROTECTION);
  const body = normalizeKiteOrderBody(
    {
      ...order,
      order_type: "MARKET",
      variety: "regular",
    },
    marketProtection,
  );
  const data = await kitePost<{ order_id: string }>(
    "/orders/regular",
    accessToken,
    body as Record<string, string>,
  );
  return data.order_id;
}

export async function fetchNiftySpot(accessToken: string): Promise<number> {
  const quotes = await kiteGet<Record<string, { last_price?: number }>>(
    `/quote?i=${encodeURIComponent("NSE:NIFTY 50")}`,
    accessToken,
  );
  return quotes["NSE:NIFTY 50"]?.last_price ?? 0;
}

/** Cash available for new MIS option buys (live_balance from equity margins). */
export async function fetchEquityAvailableBalance(accessToken: string): Promise<number> {
  const data = await kiteGet<{
    equity?: {
      net?: number;
      available?: { live_balance?: number; cash?: number };
    };
  }>("/user/margins", accessToken);
  const equity = data.equity ?? {};
  return equity.available?.live_balance ?? equity.net ?? equity.available?.cash ?? 0;
}

export async function fetchMisPosition(
  accessToken: string,
  tradingsymbol: string,
  product = "MIS",
): Promise<{
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
  unrealised: number;
} | null> {
  const data = await kiteGet<{
    net?: {
      tradingsymbol: string;
      product: string;
      quantity: number;
      average_price: number;
      last_price: number;
      pnl: number;
      unrealised: number;
    }[];
  }>("/portfolio/positions", accessToken);
  const row = data.net?.find((p) => p.tradingsymbol === tradingsymbol && p.product === product);
  if (!row || row.quantity === 0) return null;
  return {
    quantity: row.quantity,
    average_price: row.average_price,
    last_price: row.last_price,
    pnl: row.pnl,
    unrealised: row.unrealised,
  };
}

export async function findOpenNiftyMisOption(accessToken: string) {
  const data = await kiteGet<{
    net?: {
      tradingsymbol: string;
      product: string;
      quantity: number;
      average_price: number;
      last_price: number;
      pnl: number;
      unrealised: number;
    }[];
  }>("/portfolio/positions", accessToken);
  return (
    data.net?.find(
      (p) =>
        p.product === "MIS" &&
        p.quantity > 0 &&
        p.tradingsymbol.startsWith("NIFTY") &&
        (p.tradingsymbol.endsWith("CE") || p.tradingsymbol.endsWith("PE")),
    ) ?? null
  );
}

export async function fetchNiftyAndOptionQuotes(
  accessToken: string,
  tradingsymbol: string,
): Promise<{ niftySpot: number; optionLtp: number }> {
  const niftyKey = "NSE:NIFTY 50";
  const optionKey = `NFO:${tradingsymbol}`;
  const quotes = await kiteGet<Record<string, { last_price?: number }>>(
    `/quote?i=${encodeURIComponent(niftyKey)}&i=${encodeURIComponent(optionKey)}`,
    accessToken,
  );
  return {
    niftySpot: quotes[niftyKey]?.last_price ?? 0,
    optionLtp: quotes[optionKey]?.last_price ?? 0,
  };
}

export async function fetchOptionLtp(accessToken: string, tradingsymbol: string): Promise<number> {
  const key = `NFO:${tradingsymbol}`;
  const quotes = await kiteGet<Record<string, { last_price?: number }>>(
    `/quote?i=${encodeURIComponent(key)}`,
    accessToken,
  );
  return quotes[key]?.last_price ?? 0;
}

export async function fetchNetQty(
  accessToken: string,
  tradingsymbol: string,
  product = "MIS",
): Promise<number> {
  return (await fetchMisNetPosition(accessToken, tradingsymbol, product)).quantity;
}

/**
 * Net quantity *and* whether the broker published a row for the contract at all.
 *
 * The distinction matters: Zerodha keeps a closed intraday leg in the positions book with
 * `quantity: 0`, so an absent row does not mean flat — it means the book has not caught up yet,
 * which is exactly what happens for the few seconds after an entry fills. Collapsing both cases to
 * 0 (as {@link fetchNetQty} must, to keep its number return) lets a caller conclude a
 * just-opened position was already closed.
 */
export async function fetchMisNetPosition(
  accessToken: string,
  tradingsymbol: string,
  product = "MIS",
): Promise<{ found: boolean; quantity: number }> {
  const data = await kiteGet<{
    net?: { tradingsymbol: string; product: string; quantity: number }[];
  }>("/portfolio/positions", accessToken);
  const row = data.net?.find((p) => p.tradingsymbol === tradingsymbol && p.product === product);
  return row ? { found: true, quantity: row.quantity } : { found: false, quantity: 0 };
}

export interface KiteTrade {
  trade_id: string;
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  product: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  average_price: number;
  fill_timestamp?: string | null;
  exchange_timestamp?: string | null;
  order_timestamp?: string | null;
}

/**
 * Every fill Zerodha executed today. This is the broker's own record, so it is the authority on
 * what actually traded. Note it is a *same-day* book — Kite drops it overnight, which is why the
 * reconcile pass snapshots it to disk rather than re-reading it on demand for past dates.
 */
export async function fetchTradeBook(accessToken: string): Promise<KiteTrade[]> {
  const trades = await kiteGet<KiteTrade[]>("/trades", accessToken);
  return Array.isArray(trades) ? trades : [];
}

/**
 * An order the exchange definitively refused. Distinct from a plain Error because a caller may
 * safely retry after this — `filledQuantity` says exactly how much got through (0 for a margin
 * rejection) — whereas a timeout or a cancel leaves the fill unknown and must never be retried.
 */
export class KiteOrderRejectedError extends Error {
  readonly orderId: string;
  readonly status: string;
  readonly statusMessage: string;
  readonly filledQuantity: number;
  /**
   * Fill price for {@link filledQuantity}. A CANCELLED order can still have traded part of its
   * quantity, and those lots are held exactly like any other fill — a caller that ignores them
   * loses track of real inventory.
   */
  readonly averagePrice: number;

  constructor(input: {
    orderId: string;
    status: string;
    statusMessage: string;
    filledQuantity: number;
    averagePrice?: number;
  }) {
    super(
      input.statusMessage
        ? `Order ${input.orderId} ${input.status}: ${input.statusMessage}`
        : `Order ${input.orderId} ${input.status}`,
    );
    this.name = "KiteOrderRejectedError";
    this.orderId = input.orderId;
    this.status = input.status;
    this.statusMessage = input.statusMessage;
    this.filledQuantity = input.filledQuantity;
    this.averagePrice = input.averagePrice ?? 0;
  }
}

/**
 * Does this failure mean "you cannot afford this size"? Zerodha words it several ways depending on
 * whether the block came from its own RMS or from the exchange, so match the family rather than
 * one string.
 */
export function isInsufficientFundsError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!text) return false;
  return /insufficient\s+(funds|margin|balance)|margin\s+(shortfall|exceeds|required)|rms:.*margin|available\s+margin/i.test(
    text,
  );
}

/**
 * Pull the required-vs-available figures Zerodha usually quotes back in a margin rejection, e.g.
 * "RMS:Margin Exceeds,Required:154703.62, Available:139831.75". Having both lets a caller resize
 * in one step instead of walking the order size down one lot per round trip, which matters when
 * the retry is happening inside a scalp entry.
 */
export function parseMarginShortfall(err: unknown): { required: number; available: number } | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!text) return null;
  const required = text.match(/required[^0-9-]{0,20}([0-9]+(?:\.[0-9]+)?)/i);
  const available = text.match(/available[^0-9-]{0,20}([0-9]+(?:\.[0-9]+)?)/i);
  if (!required || !available) return null;
  const req = Number(required[1]);
  const avail = Number(available[1]);
  if (!Number.isFinite(req) || !Number.isFinite(avail) || req <= 0 || avail < 0) return null;
  return { required: req, available: avail };
}

export async function waitForOrderComplete(
  accessToken: string,
  orderId: string,
  timeoutMs = 45_000,
): Promise<{ average_price: number; filled_quantity: number; status: string; status_message?: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const orders = await kiteGet<
      {
        order_id: string;
        status: string;
        average_price: number;
        filled_quantity: number;
        status_message?: string;
      }[]
    >("/orders", accessToken);
    const order = orders.find((row) => row.order_id === orderId);
    if (order && (order.status === "COMPLETE" || order.status === "REJECTED" || order.status === "CANCELLED")) {
      if (order.status !== "COMPLETE") {
        throw new KiteOrderRejectedError({
          orderId,
          status: order.status,
          statusMessage: order.status_message?.trim() ?? "",
          filledQuantity: Number(order.filled_quantity) || 0,
          averagePrice: Number(order.average_price) || 0,
        });
      }
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Order ${orderId} fill timeout`);
}

export async function kiteDelete<T>(
  path: string,
  accessToken: string,
  query?: Record<string, string>,
): Promise<T> {
  const qs =
    query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await kiteHttpFetch(`${KITE_BASE}${path}${qs}`, {
    method: "DELETE",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${getApiKey()}:${accessToken}`,
    },
  });
  const json = await readKiteJsonBody(res);
  try {
    return parseKiteResponse<T>(json);
  } catch (error) {
    throw await enrichKiteApiError(error);
  }
}

export interface KiteOrderRow {
  order_id: string;
  status: string;
  average_price: number;
  filled_quantity: number;
  pending_quantity: number;
  quantity: number;
  status_message?: string;
  tradingsymbol?: string;
  transaction_type?: string;
}

export async function fetchOrderById(accessToken: string, orderId: string): Promise<KiteOrderRow | null> {
  const orders = await kiteGet<KiteOrderRow[]>("/orders", accessToken);
  return orders.find((row) => row.order_id === orderId) ?? null;
}

/**
 * Today's order book in one request. Checking several orders at once has to go through this
 * rather than a `fetchOrderById` per id — Kite rate-limits by request, and the order book is the
 * same payload every time.
 */
export async function fetchOrdersByIds(
  accessToken: string,
  orderIds: string[],
): Promise<Map<string, KiteOrderRow>> {
  const wanted = new Set(orderIds);
  const orders = await kiteGet<KiteOrderRow[]>("/orders", accessToken);
  const found = new Map<string, KiteOrderRow>();
  for (const row of orders) {
    if (wanted.has(row.order_id)) found.set(row.order_id, row);
  }
  return found;
}

export async function placeRegularLimitOrder(
  accessToken: string,
  order: {
    tradingsymbol: string;
    exchange: string;
    transaction_type: "BUY" | "SELL";
    product: string;
    quantity: number;
    price: number;
  },
): Promise<string> {
  const body = normalizeKiteOrderBody({
    ...order,
    order_type: "LIMIT",
    price: Number(order.price.toFixed(2)),
    variety: "regular",
    validity: "DAY",
  });
  const data = await kitePost<{ order_id: string }>(
    "/orders/regular",
    accessToken,
    body as Record<string, string>,
  );
  return data.order_id;
}

export async function cancelRegularOrder(accessToken: string, orderId: string): Promise<void> {
  await kiteDelete<{ order_id: string }>(`/orders/regular/${orderId}`, accessToken, {
    order_id: orderId,
  });
}
