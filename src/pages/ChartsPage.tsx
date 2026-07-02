import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowUpRight, BarChart3 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { KiteMiniChart } from "@/components/KiteMiniChart";
import { KitePriceChart } from "@/components/KitePriceChart";
import { useKite } from "@/contexts/kite-context";
import type { WatchlistHistoryItem } from "@/lib/kite-candles";
import {
  WATCHLIST_ITEMS,
  WATCHLIST_SEGMENT_LABELS,
  type WatchlistSegment,
} from "@/lib/watchlist";
import { cn } from "@/lib/utils";

const SEGMENTS: WatchlistSegment[] = ["index", "equity", "commodity"];

export default function ChartsPage() {
  const { connected, configured, loginUrl } = useKite();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialId = searchParams.get("symbol") ?? WATCHLIST_ITEMS[0].id;
  const [selectedId, setSelectedId] = useState(
    WATCHLIST_ITEMS.some((item) => item.id === initialId) ? initialId : WATCHLIST_ITEMS[0].id
  );
  const [history, setHistory] = useState<WatchlistHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => WATCHLIST_ITEMS.find((item) => item.id === selectedId) ?? WATCHLIST_ITEMS[0],
    [selectedId]
  );

  const selectedHistory = useMemo(
    () => history.find((item) => item.id === selectedId),
    [history, selectedId]
  );

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      setHistory([]);
      return;
    }

    async function loadHistory() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/kite/watchlist-history?interval=day&days=365", {
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load Zerodha history");
        setHistory(Array.isArray(json.data) ? json.data : []);
      } catch (err) {
        setHistory([]);
        setError(err instanceof Error ? err.message : "Failed to load Zerodha history");
      } finally {
        setLoading(false);
      }
    }

    loadHistory();
  }, [connected]);

  function selectSymbol(id: string) {
    setSelectedId(id);
    setSearchParams({ symbol: id });
  }

  return (
    <DashboardShell>
      <div className="page-header">
        <h1>Market Charts</h1>
        <p>Daily price history from Zerodha Kite for your full watchlist</p>
      </div>

      {configured && !connected && (
        <div className="card connect-banner mb-6">
          <div className="flex-between flex-wrap gap-4">
            <div>
              <p className="font-semibold">Connect Zerodha</p>
              <p className="text-muted mt-3" style={{ fontSize: "0.875rem" }}>
                Historical charts are loaded from Zerodha Kite. Connect your account to view watchlist pricing history.
              </p>
            </div>
            {loginUrl && (
              <a href={loginUrl}>
                <button className="btn btn-primary">
                  Connect Kite <ArrowUpRight size={16} />
                </button>
              </a>
            )}
          </div>
        </div>
      )}

      <div className="charts-layout">
        <aside className="card charts-sidebar">
          <div className="flex-between mb-4">
            <h3 className="card-title">Watchlist</h3>
            <BarChart3 size={18} className="text-muted" />
          </div>

          {SEGMENTS.map((segment) => {
            const items = WATCHLIST_ITEMS.filter((item) => item.segment === segment);
            if (items.length === 0) return null;

            return (
              <div key={segment} className="charts-segment">
                <p className="charts-segment-label">{WATCHLIST_SEGMENT_LABELS[segment]}</p>
                <div className="charts-symbol-list">
                  {items.map((item) => {
                    const itemHistory = history.find((entry) => entry.id === item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn("charts-symbol-btn", selectedId === item.id && "active")}
                        onClick={() => selectSymbol(item.id)}
                      >
                        <span className="font-medium">{item.label}</span>
                        <span className="text-muted" style={{ fontSize: "0.75rem" }}>
                          {itemHistory?.kiteKey ?? item.kiteKey}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </aside>

        <div className="charts-main">
          <div className="card">
            <div className="flex-between mb-4">
              <div>
                <h3 className="card-title">{selected.label}</h3>
                <p className="card-desc">
                  {(selectedHistory?.kiteKey ?? selected.kiteKey)} · 1 year daily candles from Zerodha
                </p>
              </div>
              <span className={`badge ${connected ? "badge-success" : "badge-warning"}`}>
                {connected ? "Zerodha Kite" : "Offline"}
              </span>
            </div>

            {error && connected && (
              <p className="text-down mb-4" style={{ fontSize: "0.875rem" }}>{error}</p>
            )}

            <KitePriceChart
              candles={selectedHistory?.candles ?? []}
              loading={connected && loading}
              emptyMessage={
                connected
                  ? selectedHistory?.error ?? "No historical data returned by Zerodha for this symbol"
                  : "Connect Zerodha Kite to load chart history"
              }
            />
          </div>

          <div className="card mt-6">
            <div className="card-header">
              <h3 className="card-title">All Watchlist History</h3>
              <p className="card-desc">365-day Zerodha pricing history for every watchlist symbol</p>
            </div>

            {!connected ? (
              <div className="empty-state">
                <p className="empty-state-title">Charts require Kite connection</p>
                <p style={{ fontSize: "0.875rem" }}>
                  Connect Zerodha to fetch historical candles for indices, equities, and commodities.
                </p>
                {loginUrl && (
                  <a href={loginUrl} className="btn btn-primary btn-sm mt-4">
                    Connect Kite
                  </a>
                )}
              </div>
            ) : (
              <div className="kite-mini-grid">
                {WATCHLIST_ITEMS.map((item) => {
                  const itemHistory = history.find((entry) => entry.id === item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="kite-mini-card-btn"
                      onClick={() => selectSymbol(item.id)}
                    >
                      <KiteMiniChart
                        label={item.label}
                        kiteKey={itemHistory?.kiteKey ?? item.kiteKey}
                        candles={itemHistory?.candles ?? []}
                        loading={loading}
                        error={itemHistory?.error}
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {!connected && configured && (
            <p className="text-muted mt-4" style={{ fontSize: "0.875rem" }}>
              Need help? Open <Link to="/dashboard/settings">Settings</Link> to manage your Kite connection.
            </p>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
