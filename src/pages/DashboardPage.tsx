import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, TrendingDown, TrendingUp } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import { WATCHLIST_DEFAULT } from "@/types/kite";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";

interface QuoteData {
  last_price: number;
  change: number;
  change_percent: number;
}

interface BalanceData {
  available: number;
  cash: number;
  used: number;
  net: number;
}

export default function DashboardPage() {
  const { connected, configured, loginUrl } = useKite();
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({});
  const [positions, setPositions] = useState<{ pnl: number; quantity: number }[]>([]);
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!connected) { setLoading(false); return; }

    async function load() {
      try {
        const [quotesRes, positionsRes, marginsRes] = await Promise.all([
          fetch(`/api/kite/quotes?instruments=${WATCHLIST_DEFAULT.join(",")}`, { credentials: "include" }),
          fetch("/api/kite/positions", { credentials: "include" }),
          fetch("/api/kite/margins", { credentials: "include" }),
        ]);
        if (quotesRes.ok) { const { data } = await quotesRes.json(); setQuotes(data ?? {}); }
        if (positionsRes.ok) {
          const { data } = await positionsRes.json();
          setPositions((data?.net ?? []).filter((p: { quantity: number }) => p.quantity !== 0));
        }
        if (marginsRes.ok) {
          const { data } = await marginsRes.json();
          setBalance(data ?? null);
        }
      } finally { setLoading(false); }
    }

    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [connected]);

  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);

  return (
    <DashboardShell>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Your trading overview at a glance</p>
      </div>

      {configured && !connected && (
        <div className="card connect-banner mb-6">
          <div className="flex-between flex-wrap gap-4">
            <div>
              <p className="font-semibold">Connect Zerodha</p>
              <p className="text-muted mt-3" style={{ fontSize: "0.875rem" }}>Link your Kite account to unlock live market data and order placement.</p>
            </div>
            {loginUrl && (
              <a href={loginUrl}><button className="btn btn-primary">Connect Kite <ArrowUpRight size={16} /></button></a>
            )}
          </div>
        </div>
      )}

      <div className="grid-4 mb-8">
        {[
          { label: "Available Balance", value: connected && balance ? formatCurrency(balance.available) : "—", sub: connected && balance ? `Net ${formatCurrency(balance.net)}` : "Connect Kite", up: true },
          { label: "Day P&L", value: connected ? formatCurrency(totalPnl) : "—", sub: connected ? `${positions.length} open positions` : "Connect Kite", up: totalPnl >= 0 },
          { label: "Margin Used", value: connected && balance ? formatCurrency(balance.used) : "—", sub: connected && balance ? `Cash ${formatCurrency(balance.cash)}` : "Active trades", up: true },
          { label: "Market Status", value: connected ? "Live" : "Offline", sub: connected ? "Kite connected" : "Awaiting connection", up: connected },
        ].map((s) => (
          <div key={s.label} className="card stat-card">
            <p className="stat-label">{s.label}</p>
            <p className="stat-value">{s.value}</p>
            <p className={cn("stat-sub", s.up ? "text-up" : "text-muted")}>{s.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="flex-between mb-4">
            <h3 className="card-title">Watchlist</h3>
            <span className={`badge ${connected ? "badge-success" : "badge-warning"}`}>{connected ? "Live" : "Demo"}</span>
          </div>
          {loading ? (
            <div className="spinner-center"><div className="spinner spinner-sm" /></div>
          ) : !connected ? (
            <div className="empty-state">
              <p className="empty-state-title">No live quotes yet</p>
              <p style={{ fontSize: "0.875rem" }}>Connect your Zerodha Kite account to stream NIFTY, BANK NIFTY, and watchlist prices.</p>
            </div>
          ) : (
            <div className="flex" style={{ flexDirection: "column", gap: "0.5rem" }}>
              {WATCHLIST_DEFAULT.map((key) => {
                const quote = quotes[key];
                const symbol = key.split(":")[1];
                const change = quote?.change_percent ?? 0;
                return (
                  <div key={key} className="watchlist-item">
                    <div>
                      <p className="font-medium">{symbol}</p>
                      <p className="text-muted" style={{ fontSize: "0.75rem" }}>{key.split(":")[0]}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{quote ? formatNumber(quote.last_price) : "—"}</p>
                      {quote && (
                        <p className={cn("flex gap-2", getChangeClass(change))} style={{ fontSize: "0.75rem", justifyContent: "flex-end" }}>
                          {change >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Quick Actions</h3>
            <p className="card-desc">Jump into trading workflows</p>
          </div>
          <div className="grid-2">
            {[
              { href: "/dashboard/options", label: "Options Chain", desc: "Analyze CE/PE strikes" },
              { href: "/dashboard/trade", label: "Place Order", desc: "Buy or sell options" },
              { href: "/dashboard/portfolio", label: "Portfolio", desc: "View positions & P&L" },
              { href: "/dashboard/settings", label: "Settings", desc: "Manage Kite connection" },
            ].map((a) => (
              <Link key={a.href} to={a.href} className="action-link">
                <p className="font-medium">{a.label}</p>
                <p className="text-muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>{a.desc}</p>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
