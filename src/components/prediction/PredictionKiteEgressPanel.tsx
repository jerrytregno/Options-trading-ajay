import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Globe, RefreshCw, Shield, ShieldAlert } from "lucide-react";
import { KITE_IP_WHITELIST_HELP, type TradingIpInfo } from "@/lib/kite-trading-ip";
import { cn } from "@/lib/utils";

const POLL_OK_MS = 45_000;
const POLL_MISMATCH_MS = 5_000;

const MODE_LABELS: Record<NonNullable<TradingIpInfo["egressMode"]>, string> = {
  direct: "Direct",
  proxy: "HTTP proxy",
  relay: "Kite relay",
  "vercel-app": "Production app",
  blocked: "Blocked",
};

type Props = {
  connected: boolean;
};

export function PredictionKiteEgressPanel({ connected }: Props) {
  const [info, setInfo] = useState<TradingIpInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [ipCopied, setIpCopied] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const qs = refresh ? "?refresh=1" : "";
      const res = await fetch(`/api/kite/trading-ip${qs}`, { credentials: "include" });
      const json = (await res.json()) as { data?: TradingIpInfo };
      if (res.ok && json.data) setInfo(json.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  const ready = Boolean(info?.egressReady && !info?.ipMismatch);
  const pollMs = ready ? POLL_OK_MS : POLL_MISMATCH_MS;

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!ready) setAutoRefreshing(true);

    const id = window.setInterval(() => {
      if (!ready) setAutoRefreshing(true);
      void load(true).finally(() => setAutoRefreshing(false));
    }, pollMs);

    return () => window.clearInterval(id);
  }, [load, pollMs, ready]);

  const copyIp = useCallback(async (ip: string | null | undefined) => {
    if (!ip) return;
    try {
      await navigator.clipboard.writeText(ip);
      setIpCopied(true);
      window.setTimeout(() => setIpCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, []);

  if (!connected && !info) return null;

  const mode = info?.egressMode ?? "blocked";
  const copyTarget = info?.networkIp && !info.networkMatchesWhitelist ? info.networkIp : info?.outboundIp;

  return (
    <section
      className={cn(
        "card prediction-egress-panel",
        info && !ready && "prediction-egress-panel--warn",
      )}
      aria-live="polite"
    >
      <div className="prediction-egress-header">
        <div className="prediction-egress-title">
          {ready ? <Shield size={18} /> : <ShieldAlert size={18} />}
          <div>
            <h3 className="card-title">Kite outbound IP</h3>
            <p className="card-desc">{KITE_IP_WHITELIST_HELP}</p>
          </div>
        </div>
        <div className="prediction-egress-actions">
          {info?.autoRouted && (
            <span className="badge badge-warning">Auto-routed</span>
          )}
          {!ready && (autoRefreshing || loading) && (
            <span className="badge badge-warning">Auto-refreshing…</span>
          )}
          <span className={cn("badge", ready ? "badge-success" : "badge-danger")}>
            {ready ? "Whitelisted egress" : "Action required"}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load(true)}
            disabled={loading}
            title="Re-check network and egress path"
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            Check IP
          </button>
        </div>
      </div>

      {info && (
        <>
          {!ready && (
            <div className="alert alert-error prediction-egress-alert">
              {info.note}
              <p className="mb-0 mt-2 text-muted" style={{ fontSize: "0.8125rem" }}>
                Off-whitelist IPs (e.g. 119.226.255.113) cannot be added in Kite — refreshing Wi-Fi and
                auto-routing Kite API via production ({info.allowedIps[0]}) every {POLL_MISMATCH_MS / 1000}s.
              </p>
            </div>
          )}

          <div className="prediction-egress-grid">
            <div className="prediction-egress-stat">
              <span className="prediction-egress-stat-label">
                <Globe size={14} />
                Your network
              </span>
              <code className="prediction-egress-ip">{info.networkIp ?? "—"}</code>
              {info.networkIpUnstable && info.networkIps && info.networkIps.length > 1 && (
                <span className="prediction-egress-tag prediction-egress-tag--bad">
                  ISP rotates: {info.networkIps.join(" · ")} → auto-routes via production
                </span>
              )}
              {info.networkRefreshAttempted && (
                <span className="prediction-egress-tag text-muted">Wi-Fi refreshed</span>
              )}
              <span
                className={cn(
                  "prediction-egress-tag",
                  info.networkMatchesWhitelist ? "prediction-egress-tag--ok" : "prediction-egress-tag--bad",
                )}
              >
                {info.networkMatchesWhitelist ? "On whitelist" : "Not whitelisted"}
              </span>
            </div>

            <div className="prediction-egress-stat">
              <span className="prediction-egress-stat-label">Active Kite egress</span>
              <code className="prediction-egress-ip">{info.outboundIp ?? "—"}</code>
              <span className="prediction-egress-tag">
                {MODE_LABELS[mode]}
                {info.egressLabel ? ` · ${info.egressLabel}` : ""}
              </span>
            </div>

            <div className="prediction-egress-stat">
              <span className="prediction-egress-stat-label">Kite whitelist</span>
              <code className="prediction-egress-ip prediction-egress-ip--list">
                {info.allowedIps.join(" · ")}
              </code>
              {info.checkedAt && (
                <span className="prediction-egress-tag text-muted">
                  Checked {new Date(info.checkedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>

          <div className="prediction-egress-footer">
            {copyTarget && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void copyIp(copyTarget)}
              >
                {ipCopied ? <Check size={14} /> : <Copy size={14} />}
                {ipCopied ? "Copied" : "Copy IP to whitelist"}
              </button>
            )}
            <a
              href={info.kiteConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-outline btn-sm"
            >
              Kite Connect IP settings <ExternalLink size={14} />
            </a>
          </div>

          {ready && info.autoRouted && (
            <p className="prediction-egress-note text-muted">
              Network IP differs from whitelist — Kite API calls are automatically routed via{" "}
              {MODE_LABELS[mode].toLowerCase()} ({info.outboundIp}).
            </p>
          )}
        </>
      )}
    </section>
  );
}
