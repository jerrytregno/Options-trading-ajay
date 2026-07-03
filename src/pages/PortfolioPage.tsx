import { useEffect, useMemo, useState } from "react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import {
  buildClosedTrades,
  normalizeKiteOrder,
  pnlByExitOrderId,
  summarizePortfolioPnl,
  type ClosedTradeRow,
  type KiteOrderRow,
} from "@/lib/portfolio-pnl";
import type { KiteHolding, KitePosition } from "@/types/kite";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";

type PortfolioTab = "positions" | "trades" | "holdings" | "orders";

function formatOrderTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PortfolioPage() {
  const { connected, loginUrl } = useKite();
  const [positions, setPositions] = useState<KitePosition[]>([]);
  const [holdings, setHoldings] = useState<KiteHolding[]>([]);
  const [orders, setOrders] = useState<KiteOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<PortfolioTab>("trades");

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
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
        if (holdRes.ok) {
          const { data } = await holdRes.json();
          setHoldings(data ?? []);
        }
        if (ordRes.ok) {
          const { data } = await ordRes.json();
          const parsed = (Array.isArray(data) ? data : [])
            .map((row) => normalizeKiteOrder(row as Record<string, unknown>))
            .filter((row): row is KiteOrderRow => row != null);
          setOrders(parsed);
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [connected]);

  const closedTrades = useMemo(() => buildClosedTrades(orders), [orders]);
  const pnlSummary = useMemo(
    () => summarizePortfolioPnl(positions, closedTrades),
    [positions, closedTrades]
  );
  const exitOrderPnl = useMemo(() => pnlByExitOrderId(closedTrades), [closedTrades]);

  const renderTradeRow = (trade: ClosedTradeRow) => (
    <tr key={trade.id}>
      <td className="font-medium">{trade.tradingsymbol}</td>
      <td><span className="badge badge-default">{trade.product}</span></td>
      <td className="text-right">{trade.quantity}</td>
      <td className="text-right">
        {trade.entryType} @ {formatNumber(trade.entryPrice)}
      </td>
      <td className="text-right">
        {trade.exitType} @ {formatNumber(trade.exitPrice)}
      </td>
      <td className={cn("text-right font-semibold", getChangeClass(trade.pnl))}>
        {formatCurrency(trade.pnl)}
      </td>
      <td className="text-muted text-sm">{formatOrderTime(trade.closedAt)}</td>
    </tr>
  );

  return (
    <DashboardShell>
      <div className="flex-between flex-wrap gap-4 mb-8">
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h1>Portfolio</h1>
          <p>Positions, closed trades, holdings, and orders</p>
        </div>
        {connected && (
          <div className="text-right">
            <p className="text-muted text-sm">Total P&L</p>
            <p className={cn("font-bold", getChangeClass(pnlSummary.totalPnl))} style={{ fontSize: "1.5rem" }}>
              {formatCurrency(pnlSummary.totalPnl)}
            </p>
            <p className="text-muted text-sm mt-3">
              Open {formatCurrency(pnlSummary.openPnl)} · Closed {formatCurrency(pnlSummary.closedPnl)}
            </p>
          </div>
        )}
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect Zerodha to view your portfolio.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4" style={{ display: "inline-block" }}>
              <button className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="flex gap-2 mb-6 flex-wrap">
            {(
              [
                ["trades", `Trades (${closedTrades.length})`],
                ["positions", `Positions (${positions.length})`],
                ["holdings", "Holdings"],
                ["orders", "Orders"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-outline"}`}
                onClick={() => setTab(t)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="card card-flush">
            {loading ? (
              <div className="spinner-center">
                <div className="spinner" />
              </div>
            ) : tab === "trades" ? (
              closedTrades.length === 0 ? (
                <p className="text-muted p-4">
                  No closed trades yet. Completed buy/sell pairs will show realised P&L here.
                </p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Product</th>
                        <th className="text-right">Qty</th>
                        <th className="text-right">Entry</th>
                        <th className="text-right">Exit</th>
                        <th className="text-right">P&L</th>
                        <th>Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closedTrades.map(renderTradeRow)}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={5} className="text-right font-semibold">
                          Closed trades total
                        </td>
                        <td className={cn("text-right font-bold", getChangeClass(pnlSummary.closedPnl))}>
                          {formatCurrency(pnlSummary.closedPnl)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            ) : tab === "positions" ? (
              positions.length === 0 ? (
                <p className="text-muted p-4">No open positions.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Product</th>
                        <th className="text-right">Qty</th>
                        <th className="text-right">Avg</th>
                        <th className="text-right">LTP</th>
                        <th className="text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p) => (
                        <tr key={`${p.tradingsymbol}-${p.product}`}>
                          <td className="font-medium">{p.tradingsymbol}</td>
                          <td><span className="badge badge-default">{p.product}</span></td>
                          <td className="text-right">{p.quantity}</td>
                          <td className="text-right">{formatNumber(p.average_price)}</td>
                          <td className="text-right">{formatNumber(p.last_price)}</td>
                          <td className={cn("text-right font-medium", getChangeClass(p.pnl))}>
                            {formatCurrency(p.pnl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={5} className="text-right font-semibold">
                          Open positions total
                        </td>
                        <td className={cn("text-right font-bold", getChangeClass(pnlSummary.openPnl))}>
                          {formatCurrency(pnlSummary.openPnl)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            ) : tab === "holdings" ? (
              holdings.length === 0 ? (
                <p className="text-muted p-4">No holdings found.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th className="text-right">Qty</th>
                        <th className="text-right">Avg</th>
                        <th className="text-right">LTP</th>
                        <th className="text-right">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holdings.map((h) => (
                        <tr key={h.tradingsymbol}>
                          <td className="font-medium">{h.tradingsymbol}</td>
                          <td className="text-right">{h.quantity}</td>
                          <td className="text-right">{formatNumber(h.average_price)}</td>
                          <td className="text-right">{formatNumber(h.last_price)}</td>
                          <td className={cn("text-right font-medium", getChangeClass(h.pnl))}>
                            {formatCurrency(h.pnl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : orders.length === 0 ? (
              <p className="text-muted p-4">No recent orders.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order ID</th>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Avg price</th>
                      <th className="text-right">P&L</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.slice(0, 50).map((o) => {
                      const legPnl = exitOrderPnl.get(o.order_id);
                      const displayPrice =
                        o.average_price > 0 ? o.average_price : o.price > 0 ? o.price : 0;
                      return (
                        <tr key={o.order_id}>
                          <td className="text-muted">{o.order_id}</td>
                          <td className="font-medium">{o.tradingsymbol}</td>
                          <td>
                            <span
                              className={`badge ${o.transaction_type === "BUY" ? "badge-success" : "badge-danger"}`}
                            >
                              {o.transaction_type}
                            </span>
                          </td>
                          <td className="text-right">{o.filled_quantity || o.quantity}</td>
                          <td className="text-right">{displayPrice > 0 ? formatNumber(displayPrice) : "—"}</td>
                          <td className={cn("text-right font-medium", legPnl != null ? getChangeClass(legPnl) : undefined)}>
                            {legPnl != null ? formatCurrency(legPnl) : "—"}
                          </td>
                          <td>{o.status}</td>
                        </tr>
                      );
                    })}
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
