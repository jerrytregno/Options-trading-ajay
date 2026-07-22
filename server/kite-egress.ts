import {
  formatKiteWhitelistIps,
  getKiteWhitelistIps,
  isIpWhitelistedForKite,
} from "../src/lib/kite-trading-ip.js";
import {
  getEgressRelayUrl,
  getRelaySecret,
  invalidateKiteHttpCaches,
  isKiteProxyEnabled,
  probeDirectIpv4Samples,
  probeProductionAppEgressIpv4,
  probeProxyEgressIpv4,
  probeRelayEgressIpv4,
  type DirectIpProbeResult,
} from "./kite-http.js";
import { tryAutoNetworkRefresh } from "./network-refresh.js";

function getConfiguredTradingIp(): string | null {
  const envIp = process.env.KITE_TRADING_IP?.trim();
  return envIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(envIp) ? envIp : null;
}

export type KiteEgressMode = "direct" | "proxy" | "relay" | "vercel-app" | "blocked";

export interface KiteEgressRoute {
  mode: KiteEgressMode;
  networkIp: string | null;
  networkIps: string[];
  networkIpUnstable: boolean;
  networkRefreshAttempted: boolean;
  egressIp: string | null;
  allowedIps: string[];
  networkMatchesWhitelist: boolean;
  egressMatchesWhitelist: boolean;
  autoRouted: boolean;
  ready: boolean;
  label: string;
  note: string;
  kiteConsoleUrl: string;
  checkedAt: string;
}

const ROUTE_CACHE_MS = 45_000;
let routeCache: { route: KiteEgressRoute; at: number } | null = null;

function getKiteConsoleUrl(): string {
  const apiKey = process.env.KITE_API_KEY?.trim();
  return apiKey
    ? `https://developers.kite.trade/apps/${encodeURIComponent(apiKey)}`
    : "https://developers.kite.trade/apps";
}

function unwhitelistedSamples(samples: string[]): string[] {
  return samples.filter((ip) => !isIpWhitelistedForKite(ip));
}

/** Direct OK only when every probe agrees on whitelisted IP(s) — never when ISP rotates. */
function canUseDirectEgress(probe: DirectIpProbeResult): boolean {
  if (probe.unstable) return false;
  if (!probe.ip || !isIpWhitelistedForKite(probe.ip)) return false;
  return unwhitelistedSamples(probe.samples).length === 0;
}

async function isProductionRelayLive(relayBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${relayBase}/api/kite/status`, { signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Production egress IP — probe endpoint, else infer from whitelist when app is reachable. */
async function resolveProductionEgressIp(force: boolean, relayBase: string): Promise<string | null> {
  const probed = await probeProductionAppEgressIpv4(force);
  if (probed && isIpWhitelistedForKite(probed)) return probed;

  if (!(await isProductionRelayLive(relayBase))) return null;

  const pinned = getConfiguredTradingIp();
  if (pinned && isIpWhitelistedForKite(pinned)) return pinned;

  const allowed = getKiteWhitelistIps();
  return (
    allowed.find((ip) => ip !== "122.186.158.142" && isIpWhitelistedForKite(ip)) ??
    allowed[0] ??
    null
  );
}

export function invalidateKiteEgressRoute() {
  routeCache = null;
}

/** Force fresh IP probes and re-pick direct / proxy / relay / production egress. */
export async function refreshKiteEgressRoute(): Promise<KiteEgressRoute> {
  invalidateKiteEgressRoute();
  invalidateKiteHttpCaches();
  return resolveKiteEgressRoute(true);
}

async function tryFallbackRoutes(
  base: Omit<
    KiteEgressRoute,
    | "mode"
    | "egressIp"
    | "egressMatchesWhitelist"
    | "autoRouted"
    | "ready"
    | "label"
    | "note"
  >,
  force: boolean,
  badIpNote: string,
): Promise<KiteEgressRoute | null> {
  if (isKiteProxyEnabled()) {
    const proxyIp = await probeProxyEgressIpv4();
    if (proxyIp && isIpWhitelistedForKite(proxyIp)) {
      return {
        ...base,
        mode: "proxy",
        egressIp: proxyIp,
        egressMatchesWhitelist: true,
        autoRouted: true,
        ready: true,
        label: "Auto-routed via HTTP proxy",
        note: `${badIpNote} Using proxy egress ${proxyIp}.`,
      };
    }
  }

  if (getRelaySecret()) {
    const relayIp = await probeRelayEgressIpv4();
    if (relayIp && isIpWhitelistedForKite(relayIp)) {
      return {
        ...base,
        mode: "relay",
        egressIp: relayIp,
        egressMatchesWhitelist: true,
        autoRouted: true,
        ready: true,
        label: "Auto-routed via Kite relay",
        note: `${badIpNote} Relay egress ${relayIp} (whitelisted).`,
      };
    }
  }

  const relayBase = getEgressRelayUrl();
  if (relayBase && !process.env.VERCEL) {
    const productionIp = await resolveProductionEgressIp(force, relayBase);
    if (productionIp && isIpWhitelistedForKite(productionIp)) {
      return {
        ...base,
        mode: "vercel-app",
        egressIp: productionIp,
        egressMatchesWhitelist: true,
        autoRouted: true,
        ready: true,
        label: "Auto-routed via production app",
        note: `${badIpNote} Kite API routed via production (${productionIp}).`,
      };
    }
  }

  return null;
}

/** Pick whitelisted Kite egress — direct only when stable; else proxy / relay / production. */
export async function resolveKiteEgressRoute(force = false): Promise<KiteEgressRoute> {
  if (!force && routeCache && Date.now() - routeCache.at < ROUTE_CACHE_MS) {
    return routeCache.route;
  }

  if (force) {
    routeCache = null;
    invalidateKiteHttpCaches();
  }

  const allowedIps = getKiteWhitelistIps();
  const consoleUrl = getKiteConsoleUrl();
  let probe = await probeDirectIpv4Samples(force);
  let networkRefreshAttempted = false;

  let needsFallback = !canUseDirectEgress(probe);

  if (needsFallback && !process.env.VERCEL) {
    networkRefreshAttempted = await tryAutoNetworkRefresh(force);
    if (networkRefreshAttempted) {
      invalidateKiteHttpCaches();
      probe = await probeDirectIpv4Samples(true);
      needsFallback = !canUseDirectEgress(probe);
    }
  }

  const networkIp = probe.ip;
  const networkIps = probe.samples;
  const networkIpUnstable = probe.unstable;
  const networkMatchesWhitelist = canUseDirectEgress(probe);
  const checkedAt = new Date().toISOString();

  const base = {
    networkIp,
    networkIps,
    networkIpUnstable,
    networkRefreshAttempted,
    allowedIps,
    networkMatchesWhitelist,
    kiteConsoleUrl: consoleUrl,
    checkedAt,
  };

  if (networkMatchesWhitelist && networkIp) {
    const route: KiteEgressRoute = {
      ...base,
      mode: "direct",
      egressIp: networkIp,
      egressMatchesWhitelist: true,
      autoRouted: false,
      ready: true,
      label: "Direct (stable whitelisted IP)",
      note: `Kite API egresses from ${networkIp} — stable match with Kite Connect.`,
    };
    routeCache = { route, at: Date.now() };
    return route;
  }

  const badIps = unwhitelistedSamples(networkIps);
  const badIpNote = badIps.length
    ? `Off-whitelist IP detected (${badIps.join(", ")}) — cannot add to Kite (2 IP limit).`
    : networkIpUnstable
      ? `ISP rotates (${networkIps.join(" · ")}) — direct blocked for safety.`
      : `Network ${networkIp ?? "unknown"} is not whitelisted.`;

  const fallback = await tryFallbackRoutes(base, force, badIpNote);
  if (fallback) {
    routeCache = { route: fallback, at: Date.now() };
    return fallback;
  }

  const pinned = getConfiguredTradingIp();
  const route: KiteEgressRoute = {
    ...base,
    mode: "blocked",
    egressIp: null,
    egressMatchesWhitelist: false,
    autoRouted: false,
    ready: false,
    label: "No whitelisted egress path",
    note:
      `${badIpNote} Set KITE_EGRESS_RELAY_URL to your production app (${formatKiteWhitelistIps()}). ` +
      `Kite Connect → ${consoleUrl}.` +
      (networkRefreshAttempted ? " Wi-Fi was refreshed — still off-whitelist." : "") +
      (pinned ? ` Or set KITE_PROXY_URL via ${pinned}.` : ""),
  };
  routeCache = { route, at: Date.now() };
  return route;
}

export async function assertKiteEgressRouteReady(force = false): Promise<KiteEgressRoute> {
  const route = await resolveKiteEgressRoute(force);
  if (!route.ready) {
    throw new Error(route.note);
  }
  return route;
}
