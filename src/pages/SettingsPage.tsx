import { useSearchParams } from "react-router-dom";
import { ExternalLink, Unplug, CheckCircle2, AlertCircle } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useAuth } from "@/contexts/auth-context";
import { useKite } from "@/contexts/kite-context";

export default function SettingsPage() {
  const { user } = useAuth();
  const { connected, configured, profile, loginUrl, disconnect } = useKite();
  const [searchParams] = useSearchParams();
  const kiteStatus = searchParams.get("kite");
  const errorMessage = searchParams.get("message");

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
