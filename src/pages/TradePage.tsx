import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, RefreshCw } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useAuth } from "@/contexts/auth-context";
import { subscribeTradeLogs, syncServerTradesToFirestore } from "@/lib/trade-log-firestore";
import { legLabel } from "@/lib/trade-calculations";
import type { BotTradeLog, BotTradeLogStatus } from "@/types/trade-log";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import "@/styles/trade-page.css";

function statusLabel(status: BotTradeLogStatus) {
  switch (status) {
    case "closed":
      return "Closed";
    case "skipped":
      return "Skipped";
    case "error":
      return "Error";
    case "no_entry":
      return "No entry";
    default:
      return status;
  }
}

function statusClass(status: BotTradeLogStatus) {
  switch (status) {
    case "closed":
      return "trade-status--closed";
    case "skipped":
      return "trade-status--skipped";
    case "error":
      return "trade-status--error";
    default:
      return "trade-status--muted";
  }
}

function formatClosedAt(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TradeDetailPanel({ trade }: { trade: BotTradeLog }) {
  return (
    <div className="trade-detail-panel">
      <div className="trade-detail-grid">
        <div>
          <span className="trade-detail-label">9:15 open</span>
          <span className="trade-detail-value">
            {trade.open915 != null ? formatNumber(trade.open915, 2) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">9:15 close</span>
          <span className="trade-detail-value">
            {trade.close915 != null ? formatNumber(trade.close915, 2) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">9:15 Δ</span>
          <span className={cn("trade-detail-value", trade.change915 != null && getChangeClass(trade.change915))}>
            {trade.change915 != null
              ? `${trade.change915 >= 0 ? "+" : ""}${formatNumber(trade.change915, 2)}`
              : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Target Nifty spot</span>
          <span className="trade-detail-value">
            {trade.targetSpot != null ? formatNumber(trade.targetSpot, 2) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Nifty spot at entry</span>
          <span className="trade-detail-value">
            {trade.entrySpot != null ? formatNumber(trade.entrySpot, 2) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Nifty at exit</span>
          <span className="trade-detail-value">
            {trade.exitSpot != null ? formatNumber(trade.exitSpot, 2) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Option entry</span>
          <span className="trade-detail-value">
            {trade.entryPrice != null ? `₹${formatNumber(trade.entryPrice, 2)}` : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Option exit</span>
          <span className="trade-detail-value">
            {trade.exitPrice != null ? `₹${formatNumber(trade.exitPrice, 2)}` : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">
            {trade.status === "skipped" || trade.status === "no_entry" ? "Skip / no-entry reason" : "Exit reason"}
          </span>
          <span className="trade-detail-value">{trade.exitReason ?? trade.message}</span>
        </div>
        <div>
          <span className="trade-detail-label">Strategy</span>
          <span className="trade-detail-value">9:16 bot · {trade.leg ? legLabel(trade.leg) : "—"}</span>
        </div>
      </div>

      {(trade.status === "skipped" || trade.status === "no_entry") && (
        <p className="trade-skip-banner">{trade.message}</p>
      )}

      {trade.logs.length > 0 && (
        <div className="trade-log-block">
          <span className="trade-detail-label">Session log</span>
          <div className="trade-log-list">
            {trade.logs.map((entry, idx) => (
              <div
                key={`${entry.time}-${idx}`}
                className={cn(
                  "trade-log-line",
                  entry.type === "success" && "is-success",
                  entry.type === "warning" && "is-warning",
                  entry.type === "error" && "is-error",
                )}
              >
                <span className="trade-log-time">{entry.time}</span>
                {entry.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TradeLogsTable({
  rows,
  expandedId,
  onToggle,
}: {
  rows: BotTradeLog[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th aria-label="Expand" />
            <th>Date</th>
            <th>Status</th>
            <th>Symbol</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Entry Nifty spot</th>
            <th className="text-right">9:15 Δ</th>
            <th className="text-right">Target Nifty</th>
            <th className="text-right">P&L</th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => {
            const expanded = expandedId === trade.id;
            return (
              <Fragment key={trade.id}>
                <tr
                  className={cn("trade-row", expanded && "trade-row--expanded")}
                  onClick={() => onToggle(trade.id)}
                >
                  <td className="trade-expand-cell">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </td>
                  <td>{trade.dateIST}</td>
                  <td>
                    <span className={cn("trade-status", statusClass(trade.status))}>
                      {statusLabel(trade.status)}
                    </span>
                  </td>
                  <td className="trade-symbol">{trade.tradingsymbol ?? "—"}</td>
                  <td className="text-right">{trade.quantity ?? "—"}</td>
                  <td className="text-right">
                    {trade.entrySpot != null
                      ? formatNumber(trade.entrySpot, 2)
                      : trade.open915 != null
                        ? formatNumber(trade.open915, 2)
                        : "—"}
                  </td>
                  <td
                    className={cn(
                      "text-right",
                      trade.change915 != null && getChangeClass(trade.change915),
                    )}
                  >
                    {trade.change915 != null
                      ? `${trade.change915 >= 0 ? "+" : ""}${formatNumber(trade.change915, 2)}`
                      : "—"}
                  </td>
                  <td className="text-right">
                    {trade.targetSpot != null ? formatNumber(trade.targetSpot, 2) : "—"}
                  </td>
                  <td
                    className={cn(
                      "text-right font-semibold",
                      trade.pnl != null && getChangeClass(trade.pnl),
                    )}
                  >
                    {trade.pnl != null ? formatCurrency(trade.pnl) : "—"}
                  </td>
                  <td>{formatClosedAt(trade.closedAt)}</td>
                </tr>
                {expanded && (
                  <tr className="trade-detail-row">
                    <td colSpan={10}>
                      <TradeDetailPanel trade={trade} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TradePage() {
  const { user } = useAuth();
  const [trades, setTrades] = useState<BotTradeLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sync = useCallback(async () => {
    if (!user?.uid) return;
    setSyncing(true);
    setError(null);
    try {
      await syncServerTradesToFirestore(user.uid);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    void sync().finally(() => {
      if (!cancelled) setLoading(false);
    });

    const unsubscribe = subscribeTradeLogs(
      user.uid,
      (rows) => {
        if (!cancelled) setTrades(rows);
      },
      (err) => {
        if (!cancelled) setError(err.message);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user?.uid, sync]);

  const { mainTrades, errorTrades } = useMemo(() => {
    const main: BotTradeLog[] = [];
    const errors: BotTradeLog[] = [];
    for (const trade of trades) {
      if (trade.status === "error") errors.push(trade);
      else main.push(trade);
    }
    return { mainTrades: main, errorTrades: errors };
  }, [trades]);

  const closedPnl = useMemo(
    () =>
      mainTrades
        .filter((trade) => trade.status === "closed" && trade.pnl != null)
        .reduce((sum, trade) => sum + (trade.pnl ?? 0), 0),
    [mainTrades],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <DashboardShell>
      <div className="trade-page">
        <header className="trade-page-head">
          <div>
            <h1 className="page-title">Trades</h1>
            <p className="page-subtitle text-muted">
              9:16 bot trade logs · synced to Firebase on each visit
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={syncing || !user}
            onClick={() => void sync()}
          >
            <RefreshCw size={14} className={syncing ? "spin" : undefined} />
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </header>

        {error && <p className="trade-page-error text-down">{error}</p>}

        <div className="trade-summary-row">
          <div className="card trade-summary-card">
            <span className="trade-summary-label">Session logs</span>
            <span className="trade-summary-value">{mainTrades.length}</span>
          </div>
          <div className="card trade-summary-card">
            <span className="trade-summary-label">Closed trades P&L</span>
            <span className={cn("trade-summary-value", getChangeClass(closedPnl))}>
              {formatCurrency(closedPnl)}
            </span>
          </div>
        </div>

        <div className="card card-flush">
          {loading ? (
            <div className="spinner-center">
              <div className="spinner" />
            </div>
          ) : mainTrades.length === 0 ? (
            <div className="trade-empty">
              <History size={28} />
              <p>No trade logs yet.</p>
              <p className="text-muted text-sm">
                Completed 9:16 bot sessions appear here after sync. Enable Firestore in Firebase Console
                if sync fails.
              </p>
            </div>
          ) : (
            <TradeLogsTable rows={mainTrades} expandedId={expandedId} onToggle={toggleExpanded} />
          )}
        </div>

        {!loading && errorTrades.length > 0 && (
          <section className="trade-error-section">
            <header className="trade-error-head">
              <h2 className="trade-error-title">Error logs</h2>
              <p className="text-muted text-sm">
                Failed bot attempts kept out of the main table ({errorTrades.length})
              </p>
            </header>
            <div className="card card-flush trade-error-card">
              <TradeLogsTable rows={errorTrades} expandedId={expandedId} onToggle={toggleExpanded} />
            </div>
          </section>
        )}
      </div>
    </DashboardShell>
  );
}
