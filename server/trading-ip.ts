import "./load-env.js";
import {
  formatKiteWhitelistIps,
  getKiteWhitelistIps,
  isIpWhitelistedForKite,
  type TradingIpInfo,
} from "../src/lib/kite-trading-ip.js";
import {
  getRelaySecret,
  isKiteProxyEnabled,
  kiteHttpFetch,
  probeDirectIpv4,
  probeRelayEgressIpv4,
  shouldRouteKiteViaRelay,
} from "./kite-http.js";
import { shouldProxyKiteViaVercelApp } from "./kite-vercel-proxy.js";

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
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return;
  lastKiteRejectedIp = ip;
  lastKiteRejectedAt = Date.now();
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

  if (await shouldRouteKiteViaRelay(force)) {
    const relayIp = await probeRelayEgressIpv4();
    if (relayIp && isIpWhitelistedForKite(relayIp)) {
      cachedOutboundIp = { ip: relayIp, fetchedAt: Date.now() };
      return relayIp;
    }
  }

  const direct = await probeDirectIpv4(force);
  if (direct && isIpWhitelistedForKite(direct)) {
    cachedOutboundIp = { ip: direct, fetchedAt: Date.now() };
    return direct;
  }

  return null;
}

export { probeDirectIpv4 };

/** Egress IP for display. */
export async function detectOutboundPublicIp(force = false): Promise<string | null> {
  return probeRawOutboundIpv4(force);
}

export function extractIpFromKiteError(message: string): string | null {
  const match = message.match(/IP \(([\d.]+)\) is not allowed/i);
  return match?.[1] ?? null;
}

function getKiteConsoleUrl(): string {
  const apiKey = process.env.KITE_API_KEY?.trim();
  return apiKey
    ? `https://developers.kite.trade/apps/${encodeURIComponent(apiKey)}`
    : "https://developers.kite.trade/apps";
}

export async function buildTradingIpInfo(clientIp: string | null, force = false): Promise<TradingIpInfo> {
  const allowedIps = getKiteWhitelistIps();
  const pinnedIp = getConfiguredTradingIp();
  const proxyEnabled = isKiteProxyEnabled();
  const relaySecretSet = Boolean(getRelaySecret());
  const networkIp = await probeDirectIpv4(force);
  const directWhitelisted = isIpWhitelistedForKite(networkIp);
  const relayIp = relaySecretSet ? await probeRelayEgressIpv4() : null;
  const vercelProxy = !process.env.VERCEL && (await shouldProxyKiteViaVercelApp(force));
  const proxyIp = proxyEnabled ? await probeRawOutboundIpv4(force) : null;
  const rejectedOrderIp =
    lastKiteRejectedIp && Date.now() - lastKiteRejectedAt < 24 * 60 * 60 * 1000
      ? lastKiteRejectedIp
      : null;

  const useRelay = relaySecretSet && !directWhitelisted && Boolean(relayIp && isIpWhitelistedForKite(relayIp));
  const onVercel = Boolean(process.env.VERCEL);
  const vercelEgress = onVercel ? networkIp ?? (await probeDirectIpv4(force)) : null;
  const vercelEgressOk = Boolean(vercelEgress && isIpWhitelistedForKite(vercelEgress));

  // What Zerodha actually sees for API calls.
  const outboundIp = proxyEnabled
    ? proxyIp
    : onVercel
      ? vercelEgressOk
        ? vercelEgress
        : vercelEgress
      : useRelay
        ? relayIp
        : vercelProxy
          ? relayIp ?? allowedIps[0] ?? null
          : directWhitelisted
            ? networkIp
            : null;

  const whitelistIp = rejectedOrderIp ?? outboundIp ?? allowedIps[0] ?? pinnedIp;

  let egressReady: boolean;
  let note: string;

  if (proxyEnabled) {
    egressReady = Boolean(proxyIp && isIpWhitelistedForKite(proxyIp));
    note = egressReady
      ? `Kite orders egress via proxy ${proxyIp} (whitelisted).`
      : `Proxy egress ${proxyIp ?? "unknown"} is not whitelisted. Use ${formatKiteWhitelistIps()}.`;
  } else if (useRelay) {
    egressReady = true;
    note = `Off-whitelist network → relaying Kite API via ${relayIp} (${formatKiteWhitelistIps()}).`;
  } else if (vercelProxy) {
    egressReady = true;
    note = `Off-whitelist network (${networkIp}) → routing Kite API via Vercel (${formatKiteWhitelistIps()}).`;
  } else if (onVercel) {
    egressReady = vercelEgressOk;
    note = vercelEgressOk
      ? `Kite orders egress from Vercel (${vercelEgress}). Whitelist this IP in Kite Connect if it changes after redeploy.`
      : `Vercel egress ${vercelEgress ?? "unknown"} is not whitelisted. Add it in Kite Connect (allowed: ${formatKiteWhitelistIps()}).`;
  } else if (directWhitelisted) {
    egressReady = true;
    note = `Kite orders trade direct from ${networkIp} (whitelisted).`;
  } else {
    // localhost direct on a rotating-IP ISP: Zerodha enforces the whitelist per request.
    egressReady = true;
    note = `Localhost direct trading. Kite whitelist: ${formatKiteWhitelistIps()}. Zerodha allows the request only when your connection egresses from one of these.`;
  }

  if (rejectedOrderIp && !isIpWhitelistedForKite(rejectedOrderIp)) {
    egressReady = false;
    note = `Zerodha rejected ${rejectedOrderIp} — not whitelisted. Reconnect so your IP is one of ${formatKiteWhitelistIps()} (Kite Connect → IP whitelist).`;
  }

  const ipMismatch = !egressReady;
  const pinDiffersFromEgress = Boolean(
    pinnedIp && outboundIp && pinnedIp !== outboundIp && egressReady,
  );

  const source: TradingIpInfo["source"] = rejectedOrderIp
    ? "rejected"
    : proxyEnabled || useRelay
      ? "env"
      : outboundIp
        ? "detected"
        : "none";

  return {
    whitelistIp,
    allowedIps,
    networkIp: directWhitelisted ? networkIp : null,
    outboundIp,
    configuredIp: pinnedIp,
    rejectedOrderIp,
    rejectedOrderAt: rejectedOrderIp ? new Date(lastKiteRejectedAt).toISOString() : null,
    clientIp,
    ipMismatch,
    pinDiffersFromEgress,
    proxyEnabled,
    egressReady,
    deployment: process.env.VERCEL ? "vercel" : "local",
    source,
    kiteConsoleUrl: getKiteConsoleUrl(),
    note,
  };
}

/** Validate Kite orders will egress from a whitelisted IP (proxy/relay when configured). */
export async function assertKiteEgressReady(): Promise<void> {
  const consoleUrl = getKiteConsoleUrl();
  const allowed = formatKiteWhitelistIps();

  // Proxy mode: verify the fixed egress is whitelisted.
  if (isKiteProxyEnabled()) {
    const outboundIp = await probeRawOutboundIpv4(true);
    if (outboundIp && isIpWhitelistedForKite(outboundIp)) return;
    throw new Error(
      `Proxy egress ${outboundIp ?? "unknown"} is not whitelisted (${allowed}). Fix KITE_PROXY_URL. Kite app → ${consoleUrl}`,
    );
  }

  // Production on Vercel — Kite API egress is this deployment's public IP.
  if (process.env.VERCEL) {
    const egress = await probeDirectIpv4(true);
    if (egress && isIpWhitelistedForKite(egress)) return;
    throw new Error(
      `Vercel egress ${egress ?? "unknown"} is not whitelisted (${allowed}). Add it in Kite Connect → ${consoleUrl}, then redeploy if needed.`,
    );
  }

  // Local dev: route via production Vercel when off-whitelist.
  if (await shouldProxyKiteViaVercelApp(true)) {
    return;
  }

  if (getRelaySecret() && (await shouldRouteKiteViaRelay(true))) {
    const relayEgress = await probeRelayEgressIpv4();
    if (relayEgress && isIpWhitelistedForKite(relayEgress)) return;
    throw new Error(
      `Kite relay egress is not whitelisted (${allowed}). Check KITE_RELAY_SECRET and redeploy Vercel. Kite app → ${consoleUrl}`,
    );
  }

  // localhost direct: our IP probe is unreliable on rotating-IP ISPs, so we don't
  // pre-block here. Zerodha enforces the whitelist and enrichKiteIpOrderError surfaces it.
}

export async function enrichKiteIpOrderError(message: string): Promise<string> {
  if (!/IP \([\d.]+\) is not allowed/i.test(message)) return message;

  const rejectedIp = extractIpFromKiteError(message);
  if (rejectedIp) recordKiteRejectedIp(rejectedIp);

  const consoleUrl = getKiteConsoleUrl();
  const allowed = formatKiteWhitelistIps();

  if (rejectedIp && !isIpWhitelistedForKite(rejectedIp)) {
    return `Zerodha blocked ${rejectedIp} — your connection egressed from a non-whitelisted IP. Kite whitelist allows ${allowed}. Reconnect (or restart your router) until your IP is one of these, or keep localhost dev running — off-whitelist requests auto-route via Vercel. Kite Connect → ${consoleUrl}`;
  }

  if (rejectedIp) {
    return `Kite blocked IP ${rejectedIp} — confirm it is listed in Kite Connect → ${consoleUrl}.`;
  }

  return `Kite blocked this server's IP — whitelist ${allowed} in Kite Connect → ${consoleUrl}. Check Settings → Trading IP.`;
}
