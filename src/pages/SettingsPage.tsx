import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, ExternalLink, Unplug, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useAuth } from "@/contexts/auth-context";
import { useKite } from "@/contexts/kite-context";
import { cn } from "@/lib/utils";
import { KITE_IP_WHITELIST_HELP, type TradingIpInfo } from "@/lib/kite-trading-ip";

export default function SettingsPage() {
  const { user } = useAuth();
  const { connected, configured, profile, loginUrl, autoLogin, disconnect, autoLoginNow } = useKite();
  const [searchParams] = useSearchParams();
  const kiteStatus = searchParams.get("kite");
  const errorMessage = searchParams.get("message");
  const [tradingIpInfo, setTradingIpInfo] = useState<TradingIpInfo | null>(null);
  const [ipCopied, setIpCopied] = useState(false);
  const [autoLoginBusy, setAutoLoginBusy] = useState(false);
  const [autoLoginError, setAutoLoginError] = useState<string | null>(null);

  const runAutoLogin = useCallback(async () => {
    setAutoLoginBusy(true);
    setAutoLoginError(null);
    try {
      setAutoLoginError(await autoLoginNow());
    } finally {
      setAutoLoginBusy(false);
    }
  }, [autoLoginNow]);

  const loadTradingIp = useCallback(async () => {
    try {
      const res = await fetch("/api/kite/trading-ip?refresh=1", { credentials: "include" });
      const json = await res.json();
      if (res.ok) setTradingIpInfo(json.data as TradingIpInfo);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadTradingIp();
  }, [loadTradingIp]);

  useEffect(() => {
    const ready = Boolean(tradingIpInfo?.egressReady && !tradingIpInfo?.ipMismatch);
    const pollMs = ready ? 45_000 : 5_000;
    const id = window.setInterval(() => void loadTradingIp(), pollMs);
    return () => window.clearInterval(id);
  }, [loadTradingIp, tradingIpInfo?.egressReady, tradingIpInfo?.ipMismatch]);

  const copyWhitelistIp = useCallback(async () => {
    const ip = tradingIpInfo?.outboundIp ?? tradingIpInfo?.whitelistIp;
    if (!ip) return;
    try {
      await navigator.clipboard.writeText(ip);
      setIpCopied(true);
      window.setTimeout(() => setIpCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [tradingIpInfo?.outboundIp, tradingIpInfo?.whitelistIp]);

  return (
    <DashboardShell>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Manage your account and Zerodha connection</p>
      </div>

      {kiteStatus === "connected" && (
        <div className="alert alert-success flex gap-2"><CheckCircle2 size={16} /> Successfully connected to Zerodha Kite!</div>
      )}
      {kiteStatus === "error" && errorMessage && (
        <div className="alert alert-error flex gap-2"><AlertCircle size={16} /> {decodeURIComponent(errorMessage)}</div>
      )}

      {autoLogin?.enabled && (
        <div className={cn("card mb-4 trading-ip-card", !autoLogin.configured && "trading-ip-card-warn")}>
          <div className="flex-between flex-wrap gap-3 mb-3">
            <div>
              <h3 className="card-title">Daily Kite login</h3>
              <p className="card-desc">
                Zerodha clears every access token by 07:30 IST. The server logs in again at{" "}
                {autoLogin.refreshAtIst} IST so the 9:16 bot and this app are connected before the open.
              </p>
            </div>
            <span
              className={`badge ${
                !autoLogin.configured
                  ? "badge-danger"
                  : autoLogin.running
                    ? "badge-warning"
                    : autoLogin.lastRun && !autoLogin.lastRun.ok
                      ? "badge-danger"
                      : "badge-success"
              }`}
            >
              {!autoLogin.configured
                ? "Credentials missing"
                : autoLogin.running
                  ? "Logging in…"
                  : autoLogin.lastRun?.ok
                    ? "Armed"
                    : autoLogin.lastRun
                      ? "Last run failed"
                      : "Armed"}
            </span>
          </div>

          {!autoLogin.configured && (
            <div className="alert alert-error mb-3" style={{ fontSize: "0.8125rem" }}>
              Set <code>KITE_USER_ID</code>, <code>KITE_PASSWORD</code> and <code>KITE_TOTP_SECRET</code>{" "}
              in <code>.env</code> on the server, then restart it.{" "}
              <strong>Zerodha app 2FA alone is not enough</strong> — enable{" "}
              <strong>External TOTP</strong> in the Kite app (Profile → Manage → Enable external TOTP)
              and copy the setup key into <code>KITE_TOTP_SECRET</code>.
            </div>
          )}
          {autoLoginError && (
            <div className="alert alert-error mb-3" style={{ fontSize: "0.8125rem" }}>
              {autoLoginError}
            </div>
          )}

          <div className="trading-ip-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={autoLoginBusy || !autoLogin.configured}
              onClick={() => void runAutoLogin()}
            >
              <RefreshCw size={14} className={autoLoginBusy ? "spin" : undefined} />
              {autoLoginBusy ? "Refreshing…" : "Refresh token now"}
            </button>
          </div>

          <p className="text-muted mt-3" style={{ fontSize: "0.8125rem" }}>
            {autoLogin.lastRun ? (
              autoLogin.lastRun.ok ? (
                <>
                  Last refresh succeeded at{" "}
                  {new Date(autoLogin.lastRun.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                  {autoLogin.lastRun.userId ? ` as ${autoLogin.lastRun.userId}` : ""}.
                </>
              ) : (
                <>
                  Last refresh failed at{" "}
                  {new Date(autoLogin.lastRun.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} after{" "}
                  {autoLogin.lastRun.attempts} attempts — {autoLogin.lastRun.error}
                </>
              )
            ) : (
              <>No refresh has run since the server started.</>
            )}
          </p>
        </div>
      )}

      {tradingIpInfo && (
        <div className={cn("card mb-4 trading-ip-card", (!tradingIpInfo.egressReady || tradingIpInfo.ipMismatch) && "trading-ip-card-warn")}>
          <div className="flex-between flex-wrap gap-3 mb-3">
            <div>
              <h3 className="card-title">Trading IP (Kite whitelist)</h3>
              <p className="card-desc">{KITE_IP_WHITELIST_HELP}</p>
            </div>
            <span
              className={`badge ${
                tradingIpInfo.egressReady && !tradingIpInfo.ipMismatch
                  ? "badge-success"
                  : tradingIpInfo.proxyEnabled
                    ? "badge-warning"
                    : "badge-danger"
              }`}
            >
              {tradingIpInfo.egressReady && !tradingIpInfo.ipMismatch
                ? tradingIpInfo.proxyEnabled
                  ? "Proxy · ready"
                  : "Egress OK"
                : tradingIpInfo.ipMismatch
                  ? "IP mismatch"
                  : "Check egress"}
            </span>
          </div>
          {(!tradingIpInfo.egressReady || tradingIpInfo.ipMismatch) && (
            <div className="alert alert-error mb-3" style={{ fontSize: "0.8125rem" }}>
              {tradingIpInfo.note}
              {tradingIpInfo.ipMismatch && tradingIpInfo.deployment === "local" && (
                <ol className="mt-2 mb-0" style={{ paddingLeft: "1.25rem" }}>
                  <li>
                    Generate a secret: <code>openssl rand -hex 24</code>
                  </li>
                  <li>
                    Set <code>KITE_RELAY_SECRET</code> in <code>.env.local</code> and the same value in Vercel →
                    Project → Settings → Environment Variables
                  </li>
                  <li>Redeploy Vercel (push latest code — relay API must be live)</li>
                  <li>Restart <code>npm run dev</code></li>
                </ol>
              )}
            </div>
          )}
          <div className="trading-ip-row">
            {tradingIpInfo.outboundIp ? (
              <code className="trading-ip-value">{tradingIpInfo.outboundIp}</code>
            ) : tradingIpInfo.whitelistIp ? (
              <code className="trading-ip-value">{tradingIpInfo.whitelistIp}</code>
            ) : null}
            {(tradingIpInfo.outboundIp ?? tradingIpInfo.whitelistIp) && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyWhitelistIp()}>
              {ipCopied ? <Check size={14} /> : <Copy size={14} />}
              {ipCopied ? "Copied" : "Copy IP"}
            </button>
            )}
            <a
              href={tradingIpInfo.kiteConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-outline btn-sm"
            >
              Kite app settings <ExternalLink size={14} />
            </a>
          </div>
          <p className="text-muted mt-3" style={{ fontSize: "0.8125rem" }}>
            {tradingIpInfo.allowedIps?.length > 0 && (
              <>
                Kite whitelist (only these used): <code>{tradingIpInfo.allowedIps.join(" · ")}</code>
                <br />
              </>
            )}
            {tradingIpInfo.networkIp && tradingIpInfo.allowedIps.includes(tradingIpInfo.networkIp) && (
              <>
                Your network: <code>{tradingIpInfo.networkIp}</code> (whitelisted — direct)
                <br />
              </>
            )}
            {tradingIpInfo.outboundIp ? (
              <>
                Kite API egress: <code>{tradingIpInfo.outboundIp}</code>
                <br />
              </>
            ) : (
              <>
                Kite API egress: <span className="text-down">none — relay or switch network</span>
                <br />
              </>
            )}
            {tradingIpInfo.rejectedOrderIp && (
              <>Last Kite rejection: <code>{tradingIpInfo.rejectedOrderIp}</code><br /></>
            )}
            {tradingIpInfo.note}
            {tradingIpInfo.configuredIp && tradingIpInfo.pinDiffersFromEgress && (
              <>
                {" "}
                · Optional pin: <code>KITE_TRADING_IP={tradingIpInfo.configuredIp}</code>
              </>
            )}
            {tradingIpInfo.configuredIp &&
              tradingIpInfo.egressReady &&
              !tradingIpInfo.pinDiffersFromEgress &&
              tradingIpInfo.outboundIp === tradingIpInfo.configuredIp && (
              <>
                {" "}
                · <code>KITE_TRADING_IP={tradingIpInfo.configuredIp}</code>
              </>
            )}
          </p>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Account</h3>
            <p className="card-desc">Firebase authentication details</p>
          </div>
          <dl style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.875rem" }}>
            <div><dt className="text-muted">Email</dt><dd className="font-medium">{user?.email ?? "—"}</dd></div>
            <div><dt className="text-muted">User ID</dt><dd className="mono truncate">{user?.uid ?? "—"}</dd></div>
            <div>
              <dt className="text-muted">Provider</dt>
              <dd><span className="badge badge-default">{user?.providerData[0]?.providerId?.replace(".com", "") ?? "email"}</span></dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <div className="flex-between mb-4">
            <div>
              <h3 className="card-title">Zerodha Kite</h3>
              <p className="card-desc">Connect your trading account</p>
            </div>
            <span className={`badge ${connected ? "badge-success" : configured ? "badge-warning" : "badge-danger"}`}>
              {connected ? "Connected" : configured ? "Disconnected" : "Unavailable"}
            </span>
          </div>

          {!configured ? (
            <p className="text-muted" style={{ fontSize: "0.875rem" }}>
              Zerodha integration is not available right now. Please try again later.
            </p>
          ) : connected && profile ? (
            <div>
              <dl style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.875rem", marginBottom: "1rem" }}>
                <div><dt className="text-muted">Kite User</dt><dd className="font-medium">{profile.user_name}</dd></div>
                <div><dt className="text-muted">Client ID</dt><dd className="font-medium">{profile.user_id}</dd></div>
                <div><dt className="text-muted">Broker</dt><dd>{profile.broker}</dd></div>
                <div>
                  <dt className="text-muted">Exchanges</dt>
                  <dd className="flex flex-wrap gap-2 mt-3">
                    {profile.exchanges.map((ex) => <span key={ex} className="badge badge-default">{ex}</span>)}
                  </dd>
                </div>
              </dl>
              <button className="btn btn-danger btn-sm" onClick={() => disconnect()}>
                <Unplug size={16} /> Disconnect Kite
              </button>
            </div>
          ) : (
            <div>
              <p className="text-muted" style={{ fontSize: "0.875rem", marginBottom: "1rem" }}>
                Sign in with your Zerodha account to enable live quotes, options chains, and order placement.
              </p>
              {loginUrl && (
                <a href={loginUrl}><button className="btn btn-primary">Connect Zerodha <ExternalLink size={16} /></button></a>
              )}
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
