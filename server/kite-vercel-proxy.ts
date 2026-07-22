import { isIpWhitelistedForKite } from "../src/lib/kite-trading-ip.js";
import { getEgressRelayUrl, probeDirectIpv4, probeProductionAppEgressIpv4 } from "./kite-http.js";

const TOKEN_COOKIE = "kite_access_token";
const KITE_API_ORIGIN = "https://api.kite.trade";

function headersToRecord(headers?: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function extractKiteAccessToken(init?: RequestInit): string | null {
  const auth =
    headersToRecord(init?.headers).Authorization ??
    headersToRecord(init?.headers).authorization;
  const match = auth?.match(/^token [^:]+:(.+)$/);
  return match?.[1]?.trim() || null;
}

function kiteProxyResponse(data: unknown, ok: boolean, message?: string, status = ok ? 200 : 400): Response {
  const body = ok
    ? { status: "success", data }
    : { status: "error", message: message ?? "Kite proxy failed" };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchProductionApi(
  relayBase: string,
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const res = await fetch(`${relayBase}${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Cookie: `${TOKEN_COOKIE}=${accessToken}`,
    },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown; error?: string };
  return {
    ok: res.ok,
    status: res.status,
    data: json.data,
    error: json.error,
  };
}

/** Local dev: route via production only when explicitly configured AND egress is whitelisted. */
export async function shouldProxyKiteViaVercelApp(force = false): Promise<boolean> {
  if (process.env.VERCEL) return false;
  const relayBase = getEgressRelayUrl();
  if (!relayBase) return false;

  const direct = await probeDirectIpv4(force);
  if (direct && isIpWhitelistedForKite(direct)) return false;

  const productionEgress = await probeProductionAppEgressIpv4(force);
  return Boolean(productionEgress && isIpWhitelistedForKite(productionEgress));
}

/**
 * Forward a Kite API call through the deployed app's /api/kite/* routes (Vercel egress).
 * Used when the home IP rotated off the Kite whitelist and egress-relay is not deployed.
 */
export async function proxyKiteApiViaVercelApp(
  url: string,
  init: RequestInit | undefined,
  accessToken: string,
): Promise<Response | null> {
  const relayBase = getEgressRelayUrl();
  if (!relayBase) return null;

  const path = url.startsWith(KITE_API_ORIGIN) ? url.slice(KITE_API_ORIGIN.length) : url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "GET" && path.startsWith("/quote")) {
    const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    const instruments = params.getAll("i").join(",");
    if (!instruments) return null;
    const result = await fetchProductionApi(
      relayBase,
      `/api/kite/quotes?instruments=${encodeURIComponent(instruments)}`,
      accessToken,
    );
    if (!result.ok) return kiteProxyResponse(null, false, result.error, result.status);
    return kiteProxyResponse(result.data, true);
  }

  if (method === "GET" && path === "/portfolio/positions") {
    const result = await fetchProductionApi(relayBase, "/api/kite/positions", accessToken);
    if (!result.ok) return kiteProxyResponse(null, false, result.error, result.status);
    return kiteProxyResponse(result.data, true);
  }

  if (method === "GET" && path.startsWith("/orders/")) {
    const orderId = path.split("/")[2]?.split("?")[0];
    if (!orderId) return null;
    const result = await fetchProductionApi(
      relayBase,
      `/api/kite/orders/${encodeURIComponent(orderId)}`,
      accessToken,
    );
    if (!result.ok) return kiteProxyResponse(null, false, result.error, result.status);
    const order = result.data;
    return kiteProxyResponse(order != null ? [order] : [], true);
  }

  if (method === "GET" && (path === "/orders" || path.startsWith("/orders?"))) {
    const result = await fetchProductionApi(relayBase, "/api/kite/orders", accessToken);
    if (!result.ok) return kiteProxyResponse(null, false, result.error, result.status);
    return kiteProxyResponse(result.data, true);
  }

  if (method === "POST" && path.startsWith("/orders")) {
    const rawBody = init?.body;
    let orderBody: Record<string, string> = {};
    if (typeof rawBody === "string") {
      orderBody = Object.fromEntries(new URLSearchParams(rawBody));
    }
    const result = await fetchProductionApi(relayBase, "/api/kite/orders", accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderBody),
    });
    if (!result.ok) return kiteProxyResponse(null, false, result.error, result.status);
    return kiteProxyResponse(result.data, true);
  }

  if (method === "GET" && path.startsWith("/user/margins")) {
    const result = await fetchProductionApi(relayBase, "/api/kite/margins", accessToken);
    if (!result.ok) return kiteProxyResponse(null, false, result.error, result.status);
    return kiteProxyResponse({ equity: result.data }, true);
  }

  return null;
}
