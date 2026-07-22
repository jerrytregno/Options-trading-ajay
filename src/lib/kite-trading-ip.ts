export type TradingIpSource = "rejected" | "env" | "detected" | "none";

export type KiteEgressMode = "direct" | "proxy" | "relay" | "vercel-app" | "blocked";

/** Default IPs registered in Kite Connect (override with KITE_WHITELIST_IPS). */
export const KITE_WHITELIST_IPS_DEFAULT = [
  "175.184.252.162",
  "122.186.158.142",
] as const;

export interface TradingIpInfo {
  /** Preferred IP(s) registered in Kite Connect. */
  whitelistIp: string | null;
  /** Allowed Kite whitelist IPs from env or defaults. */
  allowedIps: string[];
  /** Live public IP of this machine (informational — may not be used for Kite). */
  networkIp?: string | null;
  /** All IPs seen across probe services (ISP may rotate between them). */
  networkIps?: string[];
  /** True when probe services disagree on public IP. */
  networkIpUnstable?: boolean;
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
  /** Active Kite API egress path chosen by the server. */
  egressMode?: KiteEgressMode;
  egressLabel?: string;
  /** True when server auto-switched off direct network to a whitelisted path. */
  autoRouted?: boolean;
  networkMatchesWhitelist?: boolean;
  egressMatchesWhitelist?: boolean;
  checkedAt?: string;
  /** True when Wi-Fi was cycled to try to drop a bad public IP. */
  networkRefreshAttempted?: boolean;
}

export const KITE_IP_WHITELIST_HELP =
  "Kite Connect allows 2 IPs only: 122.186.158.142 (localhost) · 175.184.252.162 (production). Off-whitelist IPs auto-route via production.";

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
