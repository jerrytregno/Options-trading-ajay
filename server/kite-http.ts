import {
  formatKiteWhitelistIps,
  isIpWhitelistedForKite,
} from "../src/lib/kite-trading-ip.js";
import {
  refreshKiteEgressRoute,
  resolveKiteEgressRoute,
  type KiteEgressRoute,
} from "./kite-egress.js";
import {
  extractKiteAccessToken,
  proxyKiteApiViaVercelApp,
} from "./kite-vercel-proxy.js";

let proxyAgent: unknown = null;
let directIpv4Agent: unknown = null;
let routeViaRelayCache: { at: number; value: boolean } | null = null;
let directIpCache: { ip: string; at: number } | null = null;

const KITE_API_ORIGIN = "https://api.kite.trade";
const IP_CACHE_MS = 60_000;
let productionEgressCache: { ip: string; at: number; relayBase: string } | null = null;

/** Clear cached IP probes so the next resolve re-checks network and fallback paths. */
export function invalidateKiteHttpCaches() {
  directIpCache = null;
  productionEgressCache = null;
  routeViaRelayCache = null;
}

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
  const url = process.env.KITE_EGRESS_RELAY_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  if (!process.env.VERCEL && process.env.KITE_AUTO_PRODUCTION_EGRESS !== "0") {
    return "https://options-trading-yhys.vercel.app";
  }
  return null;
}

/** Production app egress (when KITE_EGRESS_RELAY_URL is set). Cached 60s. */
export async function probeProductionAppEgressIpv4(force = false): Promise<string | null> {
  const relayBase = getEgressRelayUrl();
  if (!relayBase) return null;

  if (
    !force &&
    productionEgressCache &&
    productionEgressCache.relayBase === relayBase &&
    Date.now() - productionEgressCache.at < IP_CACHE_MS
  ) {
    return productionEgressCache.ip;
  }

  try {
    const res = await fetch(`${relayBase}/api/kite/public-egress-ip`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return productionEgressCache?.ip ?? null;
    const json = (await res.json()) as { data?: { ip?: string } };
    const ip = json.data?.ip?.trim();
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      productionEgressCache = { ip, at: Date.now(), relayBase };
      return ip;
    }
  } catch {
    // ignore
  }

  return productionEgressCache?.ip ?? null;
}

function getRelaySecret(): string | null {
  return process.env.KITE_RELAY_SECRET?.trim() || null;
}

export { getRelaySecret };

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

function isIpv4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

const DIRECT_IP_PROBE_URLS = [
  "https://ipv4.icanhazip.com",
  "https://v4.ident.me",
  "https://checkip.amazonaws.com",
  // ipify is last — it often disagrees with other probes on some ISPs.
  "https://api4.ipify.org",
] as const;

export interface DirectIpProbeResult {
  /** Best-effort primary IP (majority across probe services). */
  ip: string | null;
  /** Unique IPs returned by any probe service. */
  samples: string[];
  /** Probe services returned more than one distinct IP. */
  unstable: boolean;
}

async function fetchProbeIpv4(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return isIpv4(ip) ? ip : null;
  } catch {
    return null;
  }
}

function pickConsensusIpv4(samples: string[]): string | null {
  if (samples.length === 0) return null;

  const counts = new Map<string, number>();
  for (const ip of samples) {
    counts.set(ip, (counts.get(ip) ?? 0) + 1);
  }

  let bestIp: string | null = null;
  let bestCount = 0;
  for (const [ip, count] of counts) {
    const whitelisted = isIpWhitelistedForKite(ip);
    const bestWhitelisted = bestIp ? isIpWhitelistedForKite(bestIp) : false;
    if (
      count > bestCount ||
      (count === bestCount && whitelisted && !bestWhitelisted)
    ) {
      bestIp = ip;
      bestCount = count;
    }
  }

  return bestIp;
}

/** Query several echo services in parallel; pick majority IP (not first-responder). */
export async function probeDirectIpv4Samples(force = false): Promise<DirectIpProbeResult> {
  if (!force && directIpCache && Date.now() - directIpCache.at < IP_CACHE_MS) {
    return {
      ip: directIpCache.ip,
      samples: [directIpCache.ip],
      unstable: false,
    };
  }

  const probeResults = await Promise.all(DIRECT_IP_PROBE_URLS.map((url) => fetchProbeIpv4(url)));
  const samples = [...new Set(probeResults.filter((ip): ip is string => Boolean(ip)))];
  const ip = pickConsensusIpv4(probeResults.filter((value): value is string => Boolean(value)));
  const unstable = samples.length > 1;

  if (ip) {
    directIpCache = { ip, at: Date.now() };
  }

  return { ip, samples, unstable };
}

/** Plain IPv4 from this machine — never via relay/proxy. */
export async function probeDirectIpv4(force = false): Promise<string | null> {
  const result = await probeDirectIpv4Samples(force);
  return result.ip;
}

/** IPv4 seen when routing through KITE_PROXY_URL. */
export async function probeProxyEgressIpv4(): Promise<string | null> {
  if (!isKiteProxyEnabled()) return null;
  try {
    const proxyFetch = await getProxyFetch();
    const res = await proxyFetch("https://api4.ipify.org", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
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

/** Direct fetch pinned to IPv4 — Lightsail/AWS often has IPv6; Kite only whitelists your static IPv4. */
async function getDirectIpv4Fetch(): Promise<typeof fetch> {
  const undici = await import("undici");
  if (!directIpv4Agent) {
    directIpv4Agent = new undici.Agent({
      connect: {
        family: 4,
      },
    });
  }
  return ((input: string | URL, init?: RequestInit) =>
    undici.fetch(input, {
      ...init,
      dispatcher: directIpv4Agent as InstanceType<typeof undici.Agent>,
    })) as typeof fetch;
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

async function isKiteIpRejection(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const text = await response.clone().text();
    return /IP \([^)]+\) is not allowed/i.test(text);
  } catch {
    return false;
  }
}

async function fetchKiteViaRoute(url: string, init: RequestInit | undefined, route: KiteEgressRoute): Promise<Response> {
  if (isKiteProxyEnabled()) {
    if (!route.ready) throw new Error(route.note);
    const proxyFetch = await getProxyFetch();
    return proxyFetch(url, init);
  }

  const accessToken = extractKiteAccessToken(init);

  if (route.mode === "relay" && getRelaySecret()) {
    return relayKiteHttpFetch(url, init);
  }

  if (route.mode === "vercel-app" && accessToken) {
    const proxied = await proxyKiteApiViaVercelApp(url, init, accessToken);
    if (proxied) return proxied;
  }

  if (route.mode === "direct") {
    const ipv4Fetch = await getDirectIpv4Fetch();
    return ipv4Fetch(url, init);
  }

  if (route.mode === "blocked" || !route.ready) {
    throw new Error(route.note);
  }

  return fetch(url, init);
}

/** Kite Connect API — auto-picks whitelisted egress; refreshes route on mismatch. */
async function kiteApiFetch(url: string, init?: RequestInit): Promise<Response> {
  let route = await resolveKiteEgressRoute();
  if (!route.ready) {
    route = await refreshKiteEgressRoute();
  }
  if (!route.ready) {
    throw new Error(route.note);
  }

  let response = await fetchKiteViaRoute(url, init, route);
  if (await isKiteIpRejection(response)) {
    route = await refreshKiteEgressRoute();
    if (route.ready) {
      response = await fetchKiteViaRoute(url, init, route);
    }
  }

  return response;
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
