import { normalizeKiteOrderBody, resolveMarketProtection } from "../src/lib/kite-orders.js";
import { kiteHttpFetch } from "./kite-http.js";
import { enrichKiteIpOrderError } from "./trading-ip.js";

const KITE_BASE = "https://api.kite.trade";

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

export async function kiteGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${getApiKey()}:${accessToken}`,
    },
  });
  const json: unknown = await res.json();
  try {
    return parseKiteResponse<T>(json);
  } catch (error) {
    throw await enrichKiteApiError(error);
  }
}

export async function kitePost<T>(
  path: string,
  accessToken: string,
  body: Record<string, string>,
): Promise<T> {
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${getApiKey()}:${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const json: unknown = await res.json();
  try {
    return parseKiteResponse<T>(json);
  } catch (error) {
    throw await enrichKiteApiError(error);
  }
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
): Promise<{ average_price: number; filled_quantity: number; status: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const orders = await kiteGet<
      { order_id: string; status: string; average_price: number; filled_quantity: number }[]
    >("/orders", accessToken);
    const order = orders.find((row) => row.order_id === orderId);
    if (order && (order.status === "COMPLETE" || order.status === "REJECTED" || order.status === "CANCELLED")) {
      if (order.status !== "COMPLETE") {
        throw new Error(`Order ${orderId} ${order.status}`);
      }
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Order ${orderId} fill timeout`);
}

export async function fetchHistoricalCandles(
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
): Promise<unknown[]> {
  const [exchange, tradingsymbol] = resolvedKey.split(":");
  const { getKiteInstruments } = await import("./kite-instruments.js");
  const instruments = await getKiteInstruments(exchange);
  const match = instruments.find((item) => item.tradingsymbol === tradingsymbol);
  if (!match) throw new Error(`Instrument not found: ${resolvedKey}`);

  const data = await kiteGet<{ candles: unknown[] }>(
    `/instruments/historical/${match.instrument_token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken,
  );
  return data.candles ?? [];
}
