import { useEffect, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import type { KiteHolding, KitePosition } from "@/types/kite";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";

export default function PortfolioPage() {
  const { connected, loginUrl } = useKite();
  const [positions, setPositions] = useState<KitePosition[]>([]);
  const [holdings, setHoldings] = useState<KiteHolding[]>([]);
  const [orders, setOrders] = useState<{ order_id: string; tradingsymbol: string; status: string; transaction_type: string; quantity: number; price: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"positions" | "holdings" | "orders">("positions");

  useEffect(() => {
    if (!connected) { setLoading(false); return; }
    async function load() {
      try {
        const [posRes, holdRes, ordRes] = await Promise.all([
          fetch("/api/kite/positions", { credentials: "include" }),
          fetch("/api/kite/holdings", { credentials: "include" }),
          fetch("/api/kite/orders", { credentials: "include" }),
        ]);
        if (posRes.ok) {
          const { data } = await posRes.json();
          setPositions((data?.net ?? []).filter((p: KitePosition) => p.quantity !== 0));
        }
        if (holdRes.ok) { const { data } = await holdRes.json(); setHoldings(data ?? []); }
        if (ordRes.ok) { const { data } = await ordRes.json(); setOrders((data ?? []).slice(0, 20)); }
      } finally { setLoading(false); }
    }
    load();
  }, [connected]);

  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-8">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Portfolio</h1>
          <p>Positions, holdings, and recent orders</p>
        </div>
        {connected && (
          <div className="text-right">
            <p className="text-muted" style={{ fontSize: "0.875rem" }}>Total P&L</p>
            <p className={cn("font-bold", getChangeClass(totalPnl))} style={{ fontSize: "1.5rem" }}>{formatCurrency(totalPnl)}</p>
          </div>
        )}
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect Zerodha to view your portfolio.</p>
          {loginUrl && <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}><button className="btn btn-primary">Connect Kite</button></a>}
        </div>
      ) : (
        <>
          <div className="flex gap-2 mb-6">
            {(["positions", "holdings", "orders"] as const).map((t) => (
              <button key={t} className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-outline"}`} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          <div className="card card-flush">
            {loading ? (
              <div className="spinner-center"><div className="spinner" /></div>
            ) : tab === "positions" ? (
              positions.length === 0 ? <p className="text-muted" style={{ padding: "1.5rem" }}>No open positions.</p> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Symbol</th><th>Product</th><th className="text-right">Qty</th>
                      <th className="text-right">Avg</th><th className="text-right">LTP</th><th className="text-right">P&L</th>
                    </tr></thead>
                    <tbody>
                      {positions.map((p) => (
                        <tr key={`${p.tradingsymbol}-${p.product}`}>
                          <td className="font-medium">{p.tradingsymbol}</td>
                          <td><span className="badge badge-default">{p.product}</span></td>
                          <td className="text-right">{p.quantity}</td>
                          <td className="text-right">{formatNumber(p.average_price)}</td>
                          <td className="text-right">{formatNumber(p.last_price)}</td>
                          <td className={cn("text-right font-medium", getChangeClass(p.pnl))}>{formatCurrency(p.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : tab === "holdings" ? (
              holdings.length === 0 ? <p className="text-muted" style={{ padding: "1.5rem" }}>No holdings found.</p> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Symbol</th><th className="text-right">Qty</th>
                      <th className="text-right">Avg</th><th className="text-right">LTP</th><th className="text-right">P&L</th>
                    </tr></thead>
                    <tbody>
                      {holdings.map((h) => (
                        <tr key={h.tradingsymbol}>
                          <td className="font-medium">{h.tradingsymbol}</td>
                          <td className="text-right">{h.quantity}</td>
                          <td className="text-right">{formatNumber(h.average_price)}</td>
                          <td className="text-right">{formatNumber(h.last_price)}</td>
                          <td className={cn("text-right font-medium", getChangeClass(h.pnl))}>{formatCurrency(h.pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : orders.length === 0 ? (
              <p className="text-muted" style={{ padding: "1.5rem" }}>No recent orders.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>Order ID</th><th>Symbol</th><th>Type</th>
                    <th className="text-right">Qty</th><th className="text-right">Price</th><th>Status</th>
                  </tr></thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.order_id}>
                        <td className="text-muted">{o.order_id}</td>
                        <td className="font-medium">{o.tradingsymbol}</td>
                        <td><span className={`badge ${o.transaction_type === "BUY" ? "badge-success" : "badge-danger"}`}>{o.transaction_type}</span></td>
                        <td className="text-right">{o.quantity}</td>
                        <td className="text-right">{formatNumber(o.price)}</td>
                        <td>{o.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </DashboardShell>
  );
}
