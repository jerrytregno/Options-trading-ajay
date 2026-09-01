import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, RefreshCw, Trash2 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useAuth } from "@/contexts/auth-context";
import { deleteTradeLog, subscribeTradeLogs, syncServerTradesToFirestore } from "@/lib/trade-log-firestore";
import {
  tradeCharges,
  tradeGrossPnl,
  tradeNetPnl,
} from "@/lib/zerodha-intraday-charges";
import { legLabel } from "@/lib/trade-calculations";
import { getIndianMarketContext } from "@/lib/market-time";
import type { BotTradeLog, BotTradeLogSource, BotTradeLogStatus } from "@/types/trade-log";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import "@/styles/trade-page.css";

const SOURCE_LABELS: Record<BotTradeLogSource, string> = {
  "nine-sixteen": "9:16 bot",
  "momentum-scalper": "Traps",
};

const SOURCE_SHORT: Record<BotTradeLogSource, string> = {
  "nine-sixteen": "9:16",
  "momentum-scalper": "Traps",
};

type SourceFilter = BotTradeLogSource | "all";

type DateFilter = "today" | "all";

function sourceLabel(source: BotTradeLogSource) {
  return SOURCE_LABELS[source] ?? source;
}

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

/** Premium actually paid at entry: option entry price × filled quantity. */
function capitalDeployed(trade: BotTradeLog): number | null {
  if (trade.entryPrice == null || trade.quantity == null) return null;
  const capital = trade.entryPrice * trade.quantity;
  return capital > 0 ? capital : null;
}

function pnlPctOfCapital(trade: BotTradeLog, pnl: number | null): number | null {
  const capital = capitalDeployed(trade);
  if (capital == null || pnl == null) return null;
  return (pnl / capital) * 100;
}

function displayPnl(trade: BotTradeLog, afterCharges: boolean): number | null {
  if (trade.status !== "closed") return trade.pnl;
  if (!afterCharges) return tradeGrossPnl(trade);
  return tradeNetPnl(trade) ?? tradeGrossPnl(trade);
}

function formatSignedPct(value: number) {
  return `${value >= 0 ? "+" : ""}${formatNumber(value, 2)}%`;
}

/** Zerodha's own record of the fills behind this trade, once the reconcile pass has matched them. */
function BrokerFillsBlock({ trade }: { trade: BotTradeLog }) {
  const broker = trade.broker;
  if (!broker) {
    return (
      <p className="trade-broker-empty text-muted text-sm">
        No Zerodha fills matched yet. The server pulls the tradebook every 5 minutes during the
        session, and Sync now pulls it on demand.
      </p>
    );
  }

  const drift =
    broker.avgBuyPrice != null && trade.entryPrice != null
      ? broker.avgBuyPrice - trade.entryPrice
      : null;

  return (
    <div className="trade-broker-block">
      <span className="trade-detail-label">Zerodha fills — executed record</span>
      <div className="trade-detail-grid">
        <div>
          <span className="trade-detail-label">Avg buy</span>
          <span className="trade-detail-value">
            {broker.avgBuyPrice != null ? `₹${formatNumber(broker.avgBuyPrice, 2)}` : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Avg sell</span>
          <span className="trade-detail-value">
            {broker.avgSellPrice != null ? `₹${formatNumber(broker.avgSellPrice, 2)}` : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Qty bought / sold</span>
          <span className="trade-detail-value">
            {broker.buyQuantity} / {broker.sellQuantity}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Realised P&L (broker)</span>
          <span className={cn("trade-detail-value", broker.realisedPnl != null && getChangeClass(broker.realisedPnl))}>
            {broker.realisedPnl != null ? formatCurrency(broker.realisedPnl) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Slippage vs bot entry</span>
          <span className={cn("trade-detail-value", drift != null && getChangeClass(-drift))}>
            {drift != null ? `${drift >= 0 ? "+" : ""}${formatNumber(drift, 2)}` : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">First / last fill</span>
          <span className="trade-detail-value">
            {broker.firstFillIst ?? "—"} → {broker.lastFillIst ?? "—"}
          </span>
        </div>
      </div>

      <div className="trade-fill-list">
        {broker.fills.map((fill) => (
          <div key={fill.tradeId || `${fill.orderId}-${fill.price}`} className="trade-fill-line">
            <span className={cn("trade-fill-side", fill.transactionType === "BUY" ? "is-buy" : "is-sell")}>
              {fill.transactionType}
            </span>
            <span className="trade-fill-time">{fill.filledAtIst ?? "—"}</span>
            <span>
              {fill.quantity} @ ₹{formatNumber(fill.price, 2)}
            </span>
            <span className="trade-fill-order">#{fill.orderId}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradeDetailPanel({
  trade,
  onDelete,
  deleting,
  afterCharges,
}: {
  trade: BotTradeLog;
  onDelete: (trade: BotTradeLog) => void;
  deleting: boolean;
  afterCharges: boolean;
}) {
  const charges = afterCharges ? tradeCharges(trade) : null;
  const gross = tradeGrossPnl(trade);
  const net = tradeNetPnl(trade);
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
          <span className="trade-detail-label">Capital deployed</span>
          <span className="trade-detail-value">
            {capitalDeployed(trade) != null ? formatCurrency(capitalDeployed(trade)!) : "—"}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">P&L % of capital</span>
          <span className={cn("trade-detail-value", trade.pnl != null && getChangeClass(trade.pnl))}>
            {(() => {
              const pnl = afterCharges ? net : gross;
              const pct = pnlPctOfCapital(trade, pnl);
              return pct != null ? formatSignedPct(pct) : "—";
            })()}
          </span>
        </div>
        {charges && gross != null && net != null && (
          <div className="trade-charges-block">
            <span className="trade-detail-label">Charges (Zerodha estimate)</span>
            <div className="trade-charges-grid">
              <span>Brokerage</span>
              <span>{formatCurrency(charges.brokerage)}</span>
              <span>STT</span>
              <span>{formatCurrency(charges.stt)}</span>
              <span>Exchange</span>
              <span>{formatCurrency(charges.exchange)}</span>
              <span>SEBI</span>
              <span>{formatCurrency(charges.sebi)}</span>
              <span>Stamp duty</span>
              <span>{formatCurrency(charges.stamp)}</span>
              <span>GST</span>
              <span>{formatCurrency(charges.gst)}</span>
              <span className="trade-charges-total">Total</span>
              <span className="trade-charges-total">{formatCurrency(charges.total)}</span>
              <span className="trade-charges-total">Net P&L</span>
              <span className={cn("trade-charges-total", getChangeClass(net))}>{formatCurrency(net)}</span>
            </div>
          </div>
        )}
        <div>
          <span className="trade-detail-label">
            {trade.status === "skipped" || trade.status === "no_entry" ? "Skip / no-entry reason" : "Exit reason"}
          </span>
          <span className="trade-detail-value">{trade.exitReason ?? trade.message}</span>
        </div>
        <div>
          <span className="trade-detail-label">Strategy</span>
          <span className="trade-detail-value">
            {`${sourceLabel(trade.source)} · ${trade.leg ? legLabel(trade.leg) : "—"}`}
          </span>
        </div>
        <div>
          <span className="trade-detail-label">Entry / exit time (IST)</span>
          <span className="trade-detail-value">
            {trade.entryTimeIst || trade.exitTimeIst
              ? `${trade.entryTimeIst ?? "—"} → ${trade.exitTimeIst ?? "—"}`
              : "—"}
          </span>
        </div>
      </div>

      <BrokerFillsBlock trade={trade} />

      {(trade.status === "skipped" || trade.status === "no_entry") && (
        <p className="trade-skip-banner">{trade.message}</p>
      )}

      <div className="trade-delete-row">
        <button
          type="button"
          className="btn btn-ghost btn-sm trade-delete-btn"
          disabled={deleting}
          onClick={() => onDelete(trade)}
        >
          <Trash2 size={14} />
          {deleting ? "Deleting…" : "Delete this log"}
        </button>
        <span className="text-muted text-sm">
          Removes it from Firebase and the server. Use it for a record that never matched a real
          trade, such as a leg one bot booked from another bot&apos;s position.
        </span>
      </div>

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
  onDelete,
  deletingId,
  afterCharges,
}: {
  rows: BotTradeLog[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onDelete: (trade: BotTradeLog) => void;
  deletingId: string | null;
  afterCharges: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th aria-label="Expand" />
            <th>Date</th>
            <th>Strategy</th>
            <th>Status</th>
            <th>Symbol</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Entry Nifty spot</th>
            <th className="text-right">9:15 Δ</th>
            <th className="text-right">Target Nifty</th>
            <th className="text-right">{afterCharges ? "P&L (after charges)" : "P&L"}</th>
            <th className="text-right">
              {afterCharges ? "Net % of capital" : "P&L % of capital"}
            </th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => {
            const expanded = expandedId === trade.id;
            const pnl = displayPnl(trade, afterCharges);
            const pct = pnlPctOfCapital(trade, pnl);
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
                    <span className={cn("trade-source", `trade-source--${trade.source}`)}>
                      {SOURCE_SHORT[trade.source] ?? trade.source}
                    </span>
                  </td>
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
                      pnl != null && getChangeClass(pnl),
                    )}
                  >
                    {pnl != null ? formatCurrency(pnl) : "—"}
                  </td>
                  <td
                    className={cn(
                      "text-right font-semibold",
                      pnl != null && getChangeClass(pnl),
                    )}
                  >
                    {pct != null ? formatSignedPct(pct) : "—"}
                  </td>
                  <td>{formatClosedAt(trade.closedAt)}</td>
                </tr>
                {expanded && (
                  <tr className="trade-detail-row">
                    <td colSpan={12}>
                      <TradeDetailPanel
                        trade={trade}
                        onDelete={onDelete}
                        deleting={deletingId === trade.id}
                        afterCharges={afterCharges}
                      />
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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [afterCharges, setAfterCharges] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  // Recomputed on every render rather than held in state, so a tab left open overnight rolls onto
  // the new session's date instead of pinning yesterday's.
  const todayIST = getIndianMarketContext().dateIST;

  // Each chip row counts what picking it would actually show, so the two filters read as a pair
  // rather than each advertising a total the other one is about to cut down.
  const counts = useMemo(() => {
    const base: Record<SourceFilter, number> = {
      all: 0,
      "nine-sixteen": 0,
      "momentum-scalper": 0,
    };
    for (const trade of trades) {
      if (dateFilter === "today" && trade.dateIST !== todayIST) continue;
      base.all += 1;
      base[trade.source] = (base[trade.source] ?? 0) + 1;
    }
    return base;
  }, [trades, dateFilter, todayIST]);

  const dateCounts = useMemo(() => {
    let all = 0;
    let today = 0;
    for (const trade of trades) {
      if (sourceFilter !== "all" && trade.source !== sourceFilter) continue;
      all += 1;
      if (trade.dateIST === todayIST) today += 1;
    }
    return { all, today };
  }, [trades, sourceFilter, todayIST]);

  const { mainTrades, errorTrades } = useMemo(() => {
    const main: BotTradeLog[] = [];
    const errors: BotTradeLog[] = [];
    for (const trade of trades) {
      if (sourceFilter !== "all" && trade.source !== sourceFilter) continue;
      if (dateFilter === "today" && trade.dateIST !== todayIST) continue;
      if (trade.status === "error") errors.push(trade);
      else main.push(trade);
    }
    return { mainTrades: main, errorTrades: errors };
  }, [trades, sourceFilter, dateFilter, todayIST]);

  const { closedPnl, closedCount } = useMemo(() => {
    let sum = 0;
    let count = 0;
    for (const trade of mainTrades) {
      if (trade.status !== "closed") continue;
      count += 1;
      const pnl = displayPnl(trade, afterCharges);
      if (pnl != null) sum += pnl;
    }
    return { closedPnl: sum, closedCount: count };
  }, [mainTrades, afterCharges]);

  const brokerVerified = useMemo(
    () => mainTrades.filter((trade) => trade.broker != null).length,
    [mainTrades],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleDelete = useCallback(
    async (trade: BotTradeLog) => {
      if (!user?.uid) return;
      const label = `${trade.dateIST} · ${sourceLabel(trade.source)} · ${trade.tradingsymbol ?? "session"}`;
      if (!window.confirm(`Delete this trade log?\n\n${label}\n\nThis cannot be undone.`)) return;

      setDeletingId(trade.id);
      setError(null);
      try {
        await deleteTradeLog(user.uid, trade.id);
        setExpandedId((prev) => (prev === trade.id ? null : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      } finally {
        setDeletingId(null);
      }
    },
    [user?.uid],
  );

  return (
    <DashboardShell>
      <div className="trade-page">
        <header className="trade-page-head">
          <div>
            <h1 className="page-title">Trades</h1>
            <p className="page-subtitle text-muted">
              All three bots · Zerodha fills reconciled, then saved to Firebase on each visit
            </p>
          </div>
          <div className="trade-page-actions">
            <label className="trade-net-toggle">
              <input
                type="checkbox"
                checked={afterCharges}
                onChange={(e) => setAfterCharges(e.target.checked)}
              />
              <span>After charges</span>
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={syncing || !user}
              onClick={() => void sync()}
            >
              <RefreshCw size={14} className={syncing ? "spin" : undefined} />
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </header>

        {error && <p className="trade-page-error text-down">{error}</p>}

        <div className="trade-filter-row">
          {(["all", "nine-sixteen", "momentum-scalper"] as SourceFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              className={cn("trade-filter-chip", sourceFilter === key && "is-active")}
              onClick={() => setSourceFilter(key)}
            >
              {key === "all" ? "All strategies" : sourceLabel(key)}
              <span className="trade-filter-count">{counts[key] ?? 0}</span>
            </button>
          ))}

          <span className="trade-filter-divider" aria-hidden="true" />

          <button
            type="button"
            className={cn("trade-filter-chip", dateFilter === "all" && "is-active")}
            onClick={() => setDateFilter("all")}
          >
            All dates
            <span className="trade-filter-count">{dateCounts.all}</span>
          </button>
          <button
            type="button"
            className={cn("trade-filter-chip", dateFilter === "today" && "is-active")}
            onClick={() => setDateFilter("today")}
          >
            Today
            <span className="trade-filter-count">{dateCounts.today}</span>
          </button>
        </div>

        <div className="trade-summary-row">
          <div className="card trade-summary-card">
            <span className="trade-summary-label">
              {dateFilter === "today" ? "Today's session logs" : "Session logs"}
            </span>
            <span className="trade-summary-value">{mainTrades.length}</span>
          </div>
          <div className="card trade-summary-card">
            <span className="trade-summary-label">
              {dateFilter === "today" ? "Today's P&L" : "Closed trades P&L"}
              {afterCharges ? " (after charges)" : ""}
            </span>
            <span className={cn("trade-summary-value", getChangeClass(closedPnl))}>
              {formatCurrency(closedPnl)}
            </span>
            <span className="trade-summary-sub">
              {closedCount} closed
              {dateFilter === "today" ? ` · ${todayIST}` : ""}
              {sourceFilter !== "all" ? ` · ${sourceLabel(sourceFilter)}` : ""}
            </span>
          </div>
          <div className="card trade-summary-card">
            <span className="trade-summary-label">Matched to Zerodha fills</span>
            <span className="trade-summary-value">
              {brokerVerified}
              <span className="trade-summary-sub"> / {mainTrades.length}</span>
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
              {dateFilter === "today" && trades.length > 0 ? (
                <>
                  <p>Nothing logged today ({todayIST}).</p>
                  <p className="text-muted text-sm">
                    Switch to <strong>All dates</strong> to see earlier sessions.
                  </p>
                </>
              ) : (
                <>
                  <p>No trade logs yet.</p>
                  <p className="text-muted text-sm">
                    Completed 9:16 and Traps trades appear here after sync, each stamped
                    with the fills Zerodha actually executed. Enable Firestore in Firebase Console if
                    sync fails.
                  </p>
                </>
              )}
            </div>
          ) : (
            <TradeLogsTable
              rows={mainTrades}
              expandedId={expandedId}
              onToggle={toggleExpanded}
              onDelete={(trade) => void handleDelete(trade)}
              deletingId={deletingId}
              afterCharges={afterCharges}
            />
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
              <TradeLogsTable
                rows={errorTrades}
                expandedId={expandedId}
                onToggle={toggleExpanded}
                onDelete={(trade) => void handleDelete(trade)}
                deletingId={deletingId}
                afterCharges={afterCharges}
              />
            </div>
          </section>
        )}
      </div>
    </DashboardShell>
  );
}
