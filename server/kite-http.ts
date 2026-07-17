import {
  formatKiteWhitelistIps,
  isIpWhitelistedForKite,
} from "../src/lib/kite-trading-ip.js";
import {
  extractKiteAccessToken,
  proxyKiteApiViaVercelApp,
  shouldProxyKiteViaVercelApp,
} from "./kite-vercel-proxy.js";

let proxyAgent: unknown = null;
let routeViaRelayCache: { at: number; value: boolean } | null = null;
let directIpCache: { ip: string; at: number } | null = null;

const KITE_API_ORIGIN = "https://api.kite.trade";
const IP_CACHE_MS = 60_000;
/** Production app — egress is on the Kite whitelist when relay env is not set locally. */
const DEFAULT_EGRESS_RELAY_URL = "https://options-trading-yhys.vercel.app";

function buildProxyUrlFromParts(): string | null {
  const host =
    process.env.KITE_PROXY_HOST?.trim() ||
    process.env.KITE_TRADING_IP?.trim() ||
    null;
  const port = process.env.KITE_PROXY_PORT?.trim();
  if (!host || !port) return null;

  const user = process.env.KITE_PROXY_USER?.trim();
  const pass = process.env.KITE_PROXY_PASS?.trim();
  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

function getProxyUrl(): string | null {
  const direct = process.env.KITE_PROXY_URL?.trim();
  if (direct) return direct;
  return buildProxyUrlFromParts();
}

function getConfiguredTradingIp(): string | null {
  const envIp = process.env.KITE_TRADING_IP?.trim();
  return envIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(envIp) ? envIp : null;
}

export function getEgressRelayUrl(): string | null {
  const url =
    process.env.KITE_EGRESS_RELAY_URL?.trim() ||
    (process.env.VERCEL ? null : DEFAULT_EGRESS_RELAY_URL);
  return url ? url.replace(/\/$/, "") : null;
}

export function getRelaySecret(): string | null {
  return process.env.KITE_RELAY_SECRET?.trim() || null;
}

export function isKiteProxyEnabled(): boolean {
  return Boolean(getProxyUrl());
}

/** Relay URL is set (local dev may use the production default). */
export function hasKiteRelayEndpoint(): boolean {
  if (process.env.VERCEL) return false;
  return Boolean(getEgressRelayUrl());
}

/** Relay is ready when KITE_RELAY_SECRET is set (URL defaults to production on local dev). */
export function isKiteEgressRelayConfigured(): boolean {
  return Boolean(hasKiteRelayEndpoint() && getRelaySecret());
}

export function getResolvedProxyUrl(): string | null {
  return getProxyUrl();
}

function isKiteApiUrl(url: string): boolean {
  return url.startsWith(KITE_API_ORIGIN);
}

/** Plain IPv4 from this machine — never via relay/proxy. */
export async function probeDirectIpv4(force = false): Promise<string | null> {
  if (!force && directIpCache && Date.now() - directIpCache.at < IP_CACHE_MS) {
    return directIpCache.ip;
  }

  const urls = ["https://api4.ipify.org", "https://ipv4.icanhazip.com", "https://v4.ident.me"];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        directIpCache = { ip, at: Date.now() };
        return ip;
      }
    } catch {
      // try next
    }
  }

  return directIpCache?.ip ?? null;
}

async function getProxyFetch(): Promise<typeof fetch> {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return fetch;

  try {
    const undici = await import("undici");
    if (!proxyAgent) {
      proxyAgent = new undici.ProxyAgent(proxyUrl);
    }
    return ((input: string | URL, init?: RequestInit) =>
      undici.fetch(input, {
        ...init,
        dispatcher: proxyAgent as InstanceType<typeof undici.ProxyAgent>,
      })) as typeof fetch;
  } catch {
    throw new Error(
      "KITE_PROXY_URL is set but undici is not installed. Run: npm install undici",
    );
  }
}

function headersToRecord(headers?: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function bodyToString(body: RequestInit["body"]): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  if (body instanceof Blob) return body.text();
  return undefined;
}

async function relayKiteHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const relayBase = getEgressRelayUrl();
  const secret = getRelaySecret();
  if (!relayBase) {
    throw new Error("KITE_EGRESS_RELAY_URL is not set");
  }
  if (!secret) {
    throw new Error(
      `Kite only trades via ${formatKiteWhitelistIps()} (KITE_WHITELIST_IPS). Add KITE_RELAY_SECRET to .env.local — same value as on Vercel.`,
    );
  }

  return fetch(`${relayBase}/api/kite/egress-relay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kite-Relay-Secret": secret,
    },
    body: JSON.stringify({
      url,
      method: init?.method ?? "GET",
      headers: headersToRecord(init?.headers),
      body: await bodyToString(init?.body),
    }),
    signal: init?.signal,
  });
}

/** Probe egress IPv4 via Vercel relay. */
export async function probeRelayEgressIpv4(): Promise<string | null> {
  const relayBase = getEgressRelayUrl();
  const secret = getRelaySecret();
  if (!relayBase || !secret) return null;

  try {
    const res = await fetch(`${relayBase}/api/kite/relay-egress-ip`, {
      headers: { "X-Kite-Relay-Secret": secret },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { ip?: string } };
    const ip = json.data?.ip?.trim();
    return ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/** Route Kite API via Vercel when this machine is not on a whitelisted IP. */
export async function shouldRouteKiteViaRelay(force = false): Promise<boolean> {
  if (!hasKiteRelayEndpoint()) return false;
  if (!getRelaySecret()) return false;

  if (!force && routeViaRelayCache && Date.now() - routeViaRelayCache.at < IP_CACHE_MS) {
    return routeViaRelayCache.value;
  }

  const pinnedIp = getConfiguredTradingIp();
  const direct = await probeDirectIpv4(force);
  const relay = await probeRelayEgressIpv4();

  let useRelay: boolean;
  if (direct && isIpWhitelistedForKite(direct)) {
    useRelay = Boolean(pinnedIp && relay === pinnedIp && direct !== pinnedIp);
  } else {
    useRelay = true;
  }

  routeViaRelayCache = { at: Date.now(), value: useRelay };
  return useRelay;
}

/** Kite Connect API — direct, relay, or production Vercel proxy when off-whitelist. */
async function kiteApiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isKiteProxyEnabled()) {
    const proxyFetch = await getProxyFetch();
    return proxyFetch(url, init);
  }

  const accessToken = extractKiteAccessToken(init);

  // Secret relay (egress-relay endpoint) when deployed.
  if (getRelaySecret() && (await shouldRouteKiteViaRelay(true))) {
    return relayKiteHttpFetch(url, init);
  }

  // Off-whitelist home IP → route via production Vercel /api/kite/* (no secret needed).
  if (accessToken && (await shouldProxyKiteViaVercelApp(true))) {
    const proxied = await proxyKiteApiViaVercelApp(url, init, accessToken);
    if (proxied) return proxied;
  }

  return fetch(url, init);
}

/** HTTP fetch — Kite API calls are restricted to whitelisted egress (relay/proxy when needed). */
export async function kiteHttpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const urlStr = url.toString();

  if (isKiteApiUrl(urlStr)) {
    return kiteApiFetch(urlStr, init);
  }

  const proxyFetch = await getProxyFetch();
  return proxyFetch(url, init);
}
