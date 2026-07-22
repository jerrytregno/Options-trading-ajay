import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Radio, Upload } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import { getIndianMarketContext } from "@/lib/market-time";
import {
  normalizeKiteOrder,
  pnlByExitOrderId,
  summarizePortfolioPnl,
  type ClosedTradeRow,
  type KiteOrderRow,
} from "@/lib/portfolio-pnl";
import {
  loadStoredClosedTrades,
  mergeStoredClosedTrades,
  saveStoredClosedTrades,
} from "@/lib/trade-history-storage";
import type { KiteHolding, KitePosition } from "@/types/kite";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";

type PortfolioTab = "positions" | "trades" | "holdings" | "orders";

interface PortfolioMargins {
  available: number;
  cash: number;
  used: number;
  net: number;
}

const LIVE_POLL_MS_MARKET = 3000;
const LIVE_POLL_MS_OFF = 15000;
const HISTORY_POLL_MS = 30000;

function formatOrderTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PortfolioPage() {
  const { connected, loginUrl } = useKite();
  const [positions, setPositions] = useState<KitePosition[]>([]);
  const [holdings, setHoldings] = useState<KiteHolding[]>([]);
  const [orders, setOrders] = useState<KiteOrderRow[]>([]);
  const [closedTrades, setClosedTrades] = useState<ClosedTradeRow[]>([]);
  const [margins, setMargins] = useState<PortfolioMargins | null>(null);
  const [tradeHistoryNote, setTradeHistoryNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [tab, setTab] = useState<PortfolioTab>("positions");
  const importInputRef = useRef<HTMLInputElement>(null);

  const loadLive = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await fetch("/api/kite/portfolio/live", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to fetch live portfolio");
      const data = json.data as {
        positions?: { net?: KitePosition[] };
        holdings?: KiteHolding[];
        margins?: PortfolioMargins;
        updatedAt?: string;
      };
      setPositions((data.positions?.net ?? []).filter((p) => p.quantity !== 0));
      setHoldings(data.holdings ?? []);
      setMargins(data.margins ?? null);
      setLastUpdated(data.updatedAt ?? new Date().toISOString());
      setLiveError(null);
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : "Live update failed");
    }
  }, [connected]);

  const loadHistory = useCallback(async () => {
    if (!connected) return;
    try {
      const [ordRes, tradesRes] = await Promise.all([
        fetch("/api/kite/orders", { credentials: "include" }),
        fetch("/api/kite/portfolio/trades", { credentials: "include" }),
      ]);
      if (ordRes.ok) {
        const { data } = await ordRes.json();
        const parsed = (Array.isArray(data) ? data : [])
          .map((row) => normalizeKiteOrder(row as Record<string, unknown>))
          .filter((row): row is KiteOrderRow => row != null);
        setOrders(parsed);
      }
      if (tradesRes.ok) {
        const json = await tradesRes.json();
        const fromApi = Array.isArray(json.data) ? (json.data as ClosedTradeRow[]) : [];
        const merged = mergeStoredClosedTrades(loadStoredClosedTrades(), fromApi);
        saveStoredClosedTrades(merged);
        setClosedTrades(merged);
        setTradeHistoryNote(typeof json.meta?.note === "string" ? json.meta.note : null);
      } else {
        const local = loadStoredClosedTrades();
        if (local.length) setClosedTrades(local);
      }
    } catch {
      /* history is secondary */
    }
  }, [connected]);

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    async function bootstrap() {
      setLoading(true);
      await Promise.all([loadLive(), loadHistory()]);
      if (!cancelled) setLoading(false);
    }
    void bootstrap();

    const livePollMs = getIndianMarketContext().isMarketOpen
      ? LIVE_POLL_MS_MARKET
      : LIVE_POLL_MS_OFF;
    const liveId = window.setInterval(() => void loadLive(), livePollMs);
    const historyId = window.setInterval(() => void loadHistory(), HISTORY_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(liveId);
      window.clearInterval(historyId);
    };
  }, [connected, loadLive, loadHistory]);

  const pnlSummary = useMemo(
    () => summarizePortfolioPnl(positions, closedTrades),
    [positions, closedTrades],
  );
  const holdingsPnl = useMemo(
    () => holdings.reduce((sum, h) => sum + (h.pnl ?? 0), 0),
    [holdings],
  );
  const totalPnl = pnlSummary.openPnl + pnlSummary.closedPnl + holdingsPnl;
  const exitOrderPnl = useMemo(() => pnlByExitOrderId(closedTrades), [closedTrades]);

  async function handleTradebookImport(file: File) {
    setImporting(true);
    setImportError(null);
    try {
      const csv = await file.text();
      const res = await fetch("/api/kite/portfolio/trades/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      const fromApi = Array.isArray(json.data) ? (json.data as ClosedTradeRow[]) : [];
      const merged = mergeStoredClosedTrades(loadStoredClosedTrades(), fromApi);
      saveStoredClosedTrades(merged);
      setClosedTrades(merged);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

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
          <p>Live P&L from Zerodha · positions refresh every 3s in market hours</p>
        </div>
        {connected && (
          <div className="text-right">
            <div className="flex gap-2 items-center justify-end mb-1">
              <span className="badge badge-success">
                <Radio size={12} />
                Live
              </span>
              {lastUpdated && (
                <span className="text-muted text-sm">
                  Updated {formatOrderTime(lastUpdated)}
                </span>
              )}
            </div>
            <p className="text-muted text-sm">Total P&L</p>
            <p className={cn("font-bold", getChangeClass(totalPnl))} style={{ fontSize: "1.5rem" }}>
              {formatCurrency(totalPnl)}
            </p>
            <p className="text-muted text-sm mt-3">
              Open {formatCurrency(pnlSummary.openPnl)}
              {holdingsPnl !== 0 && <> · Holdings {formatCurrency(holdingsPnl)}</>}
              {" · "}Closed {formatCurrency(pnlSummary.closedPnl)}
            </p>
            {margins && (
              <p className="text-muted text-sm mt-2">
                Available {formatCurrency(margins.available)}
              </p>
            )}
            {liveError && <p className="text-down text-sm mt-2">{liveError}</p>}
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
          <div className="flex-between flex-wrap gap-3 mb-6">
            <div className="flex gap-2 flex-wrap">
            {(
              [
                ["positions", `Positions (${positions.length})`],
                ["trades", `Trades (${closedTrades.length})`],
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
            {tab === "trades" && (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleTradebookImport(file);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={importing}
                  onClick={() => importInputRef.current?.click()}
                >
                  <Upload size={14} />
                  {importing ? "Importing…" : "Import tradebook CSV"}
                </button>
              </>
            )}
          </div>
          {tab === "trades" && tradeHistoryNote && (
            <p className="text-muted text-sm mb-4" style={{ marginTop: "-0.5rem" }}>
              {tradeHistoryNote} Import past trades from{" "}
              <a
                href="https://console.zerodha.com/reports/tradebook"
                target="_blank"
                rel="noreferrer"
              >
                Zerodha Console → Tradebook
              </a>
              .
            </p>
          )}
          {importError && (
            <p className="text-down text-sm mb-4">{importError}</p>
          )}

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
