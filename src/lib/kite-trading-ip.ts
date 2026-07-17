export type TradingIpSource = "rejected" | "env" | "detected" | "none";

/** Default IPs registered in Kite Connect (override with KITE_WHITELIST_IPS). */
export const KITE_WHITELIST_IPS_DEFAULT = [
  "175.184.252.162",
  "119.226.255.113",
] as const;

export interface TradingIpInfo {
  /** Preferred IP(s) registered in Kite Connect. */
  whitelistIp: string | null;
  /** Allowed Kite whitelist IPs from env or defaults. */
  allowedIps: string[];
  /** Live public IP of this machine (informational — may not be used for Kite). */
  networkIp?: string | null;
  /** IP Zerodha sees for Kite API (one of allowedIps only). */
  outboundIp: string | null;
  /** Set only when KITE_TRADING_IP is pinned (proxy / fixed egress). */
  configuredIp: string | null;
  /** IP from last Zerodha order rejection (most accurate). */
  rejectedOrderIp: string | null;
  rejectedOrderAt: string | null;
  clientIp: string | null;
  ipMismatch: boolean;
  /** True when egress uses a whitelisted IP but differs from KITE_TRADING_IP (informational only). */
  pinDiffersFromEgress?: boolean;
  /** True when KITE_PROXY_URL routes Kite API calls through a fixed egress IP. */
  proxyEnabled: boolean;
  /** True when Kite orders will egress from an allowed whitelist IP. */
  egressReady: boolean;
  deployment: "local" | "vercel";
  source: TradingIpSource;
  kiteConsoleUrl: string;
  note: string;
}

export const KITE_IP_WHITELIST_HELP =
  "Kite Connect → your app → IP whitelist. Trades use 175.184.252.162 (Vercel) or 119.226.255.113 (this network) only.";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function getKiteWhitelistIps(): string[] {
  const raw = process.env.KITE_WHITELIST_IPS?.trim();
  if (raw) {
    const parsed = raw
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((ip) => IPV4.test(ip));
    if (parsed.length > 0) return parsed;
  }
  return [...KITE_WHITELIST_IPS_DEFAULT];
}

export function isIpWhitelistedForKite(ip: string | null | undefined): boolean {
  if (!ip || !IPV4.test(ip)) return false;
  return getKiteWhitelistIps().includes(ip);
}

export function formatKiteWhitelistIps(): string {
  return getKiteWhitelistIps().join(" or ");
}

/** True when this IP may be used for Kite API (must be on the app whitelist). */
export function isAcceptableKiteEgressIp(ip: string | null | undefined): boolean {
  return isIpWhitelistedForKite(ip);
}
