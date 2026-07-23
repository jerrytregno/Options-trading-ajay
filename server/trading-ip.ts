import "./load-env.js";
import {
  formatKiteWhitelistIps,
  isIpWhitelistedForKite,
  type TradingIpInfo,
} from "../src/lib/kite-trading-ip.js";
import {
  invalidateKiteEgressRoute,
  refreshKiteEgressRoute,
  resolveKiteEgressRoute,
} from "./kite-egress.js";
import {
  invalidateKiteHttpCaches,
  isKiteProxyEnabled,
  kiteHttpFetch,
  probeDirectIpv4,
} from "./kite-http.js";

let cachedOutboundIp: { ip: string; fetchedAt: number } | null = null;
const OUTBOUND_CACHE_MS = 60 * 1000;

/** IP Zerodha rejected on the last order attempt. */
let lastKiteRejectedIp: string | null = null;
let lastKiteRejectedAt = 0;

/** Pinned egress IP from KITE_TRADING_IP (optional — for proxy / fixed production egress). */
export function getConfiguredTradingIp(): string | null {
  const envIp = process.env.KITE_TRADING_IP?.trim();
  return envIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(envIp) ? envIp : null;
}

export function isTradingIpPinned(): boolean {
  return Boolean(getConfiguredTradingIp());
}

export function recordKiteRejectedIp(ip: string) {
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  const isIpv6 = ip.includes(":");
  if (!isIpv4 && !isIpv6) return;
  lastKiteRejectedIp = isIpv4 ? ip : null;
  lastKiteRejectedAt = Date.now();
  invalidateKiteEgressRoute();
  invalidateKiteHttpCaches();
}

async function fetchTextIp(url: string): Promise<string | null> {
  try {
    const res = await kiteHttpFetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** IPv4 Zerodha will see for Kite API — whitelisted IPs only (never a random network IP). */
export async function probeRawOutboundIpv4(force = false): Promise<string | null> {
  if (!force && cachedOutboundIp && Date.now() - cachedOutboundIp.fetchedAt < OUTBOUND_CACHE_MS) {
    if (isIpWhitelistedForKite(cachedOutboundIp.ip)) {
      return cachedOutboundIp.ip;
    }
    cachedOutboundIp = null;
  }

  const route = await resolveKiteEgressRoute(force);
  if (route.egressIp && isIpWhitelistedForKite(route.egressIp)) {
    cachedOutboundIp = { ip: route.egressIp, fetchedAt: Date.now() };
    return route.egressIp;
  }

  if (isKiteProxyEnabled()) {
    const ip =
      (await fetchTextIp("https://api4.ipify.org")) ??
      (await fetchTextIp("https://ipv4.icanhazip.com")) ??
      (await fetchTextIp("https://v4.ident.me"));
    if (ip && isIpWhitelistedForKite(ip)) {
      cachedOutboundIp = { ip, fetchedAt: Date.now() };
      return ip;
    }
    return null;
  }

  return null;
}

export { probeDirectIpv4 };

/** Egress IP for display. */
export async function detectOutboundPublicIp(force = false): Promise<string | null> {
  return probeRawOutboundIpv4(force);
}

export function extractIpFromKiteError(message: string): string | null {
  const match = message.match(/IP \(([^)]+)\) is not allowed/i);
  return match?.[1] ?? null;
}

export async function buildTradingIpInfo(clientIp: string | null, force = false): Promise<TradingIpInfo> {
  const route = force ? await refreshKiteEgressRoute() : await resolveKiteEgressRoute(force);
  const pinnedIp = getConfiguredTradingIp();
  const rejectedOrderIp =
    lastKiteRejectedIp && Date.now() - lastKiteRejectedAt < 24 * 60 * 60 * 1000
      ? lastKiteRejectedIp
      : null;

  let egressReady = route.ready;
  let note = route.note;

  if (rejectedOrderIp && !isIpWhitelistedForKite(rejectedOrderIp)) {
    egressReady = false;
    note = `Zerodha rejected ${rejectedOrderIp} — not whitelisted. Reconnect so your IP is one of ${formatKiteWhitelistIps()} (Kite Connect → IP whitelist).`;
  }

  const outboundIp = route.egressIp;
  const whitelistIp = rejectedOrderIp ?? outboundIp ?? route.allowedIps[0] ?? pinnedIp;
  const ipMismatch = !egressReady;
  const pinDiffersFromEgress = Boolean(
    pinnedIp && outboundIp && pinnedIp !== outboundIp && egressReady,
  );

  const source: TradingIpInfo["source"] = rejectedOrderIp
    ? "rejected"
    : route.mode === "proxy" || route.autoRouted
      ? "env"
      : outboundIp
        ? "detected"
        : "none";

  return {
    whitelistIp,
    allowedIps: route.allowedIps,
    networkIp: route.networkIp,
    networkIps: route.networkIps,
    networkIpUnstable: route.networkIpUnstable,
    networkRefreshAttempted: route.networkRefreshAttempted,
    outboundIp,
    configuredIp: pinnedIp,
    rejectedOrderIp,
    rejectedOrderAt: rejectedOrderIp ? new Date(lastKiteRejectedAt).toISOString() : null,
    clientIp,
    ipMismatch,
    pinDiffersFromEgress,
    proxyEnabled: route.mode === "proxy" || isKiteProxyEnabled(),
    egressReady,
    deployment: process.env.VERCEL ? "vercel" : "local",
    source,
    kiteConsoleUrl: route.kiteConsoleUrl,
    note,
    egressMode: route.mode,
    egressLabel: route.label,
    autoRouted: route.autoRouted,
    networkMatchesWhitelist: route.networkMatchesWhitelist,
    egressMatchesWhitelist: route.egressMatchesWhitelist,
    checkedAt: route.checkedAt,
  };
}

/** Validate Kite orders will egress from a whitelisted IP (auto-routes when configured). */
export async function assertKiteEgressReady(): Promise<void> {
  const route = await refreshKiteEgressRoute();
  if (!route.ready) {
    throw new Error(route.note);
  }
}

export { refreshKiteEgressRoute };

export async function enrichKiteIpOrderError(message: string): Promise<string> {
  if (!/IP \([^)]+\) is not allowed/i.test(message)) return message;

  const rejectedIp = extractIpFromKiteError(message);
  if (rejectedIp) recordKiteRejectedIp(rejectedIp);

  const consoleUrl = (await resolveKiteEgressRoute(true)).kiteConsoleUrl;
  const allowed = formatKiteWhitelistIps();

  if (rejectedIp && !isIpWhitelistedForKite(rejectedIp)) {
    if (rejectedIp.includes(":")) {
      return `Zerodha blocked IPv6 (${rejectedIp}) — Kite only accepts your whitelisted IPv4 (${allowed}). Redeploy the latest server build (forces IPv4 for orders). Whitelist ${allowed} in Kite Connect → ${consoleUrl}`;
    }
    return `Zerodha blocked ${rejectedIp} — not whitelisted. Kite only allows ${allowed}. On localhost set KITE_PROXY_URL to a proxy on a whitelisted IP, or add your network IP in Kite Connect → ${consoleUrl}`;
  }

  if (rejectedIp) {
    return `Kite blocked IP ${rejectedIp} — confirm it is listed in Kite Connect → ${consoleUrl}.`;
  }

  return `Kite blocked this server's IP — whitelist ${allowed} in Kite Connect → ${consoleUrl}. Check Settings → Trading IP.`;
}
