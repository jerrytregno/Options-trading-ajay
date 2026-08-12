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
  const data = await kiteGet<{
    net?: { tradingsymbol: string; product: string; quantity: number }[];
  }>("/portfolio/positions", accessToken);
  const row = data.net?.find((p) => p.tradingsymbol === tradingsymbol && p.product === product);
  return row?.quantity ?? 0;
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
        const detail = order.status_message?.trim();
        throw new Error(
          detail ? `Order ${orderId} ${order.status}: ${detail}` : `Order ${orderId} ${order.status}`,
        );
      }
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Order ${orderId} fill timeout`);
}
