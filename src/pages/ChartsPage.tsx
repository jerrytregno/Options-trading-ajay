import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BarChart3 } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { TradingViewChart } from "@/components/TradingViewChart";
import { TradingViewMiniChart } from "@/components/TradingViewMiniChart";
import {
  WATCHLIST_ITEMS,
  WATCHLIST_SEGMENT_LABELS,
  type WatchlistSegment,
} from "@/lib/watchlist";
import { cn } from "@/lib/utils";

const SEGMENTS: WatchlistSegment[] = ["index", "equity", "commodity"];

export default function ChartsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialId = searchParams.get("symbol") ?? WATCHLIST_ITEMS[0].id;
  const [selectedId, setSelectedId] = useState(
    WATCHLIST_ITEMS.some((item) => item.id === initialId) ? initialId : WATCHLIST_ITEMS[0].id
  );

  const selected = useMemo(
    () => WATCHLIST_ITEMS.find((item) => item.id === selectedId) ?? WATCHLIST_ITEMS[0],
    [selectedId]
  );

  function selectSymbol(id: string) {
    setSelectedId(id);
    setSearchParams({ symbol: id });
  }

  return (
    <DashboardShell>
      <div className="page-header">
        <h1>Market Charts</h1>
        <p>Historical pricing for your full watchlist — indices, equities, and commodities</p>
      </div>

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
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={cn("charts-symbol-btn", selectedId === item.id && "active")}
                      onClick={() => selectSymbol(item.id)}
                    >
                      <span className="font-medium">{item.label}</span>
                      <span className="text-muted" style={{ fontSize: "0.75rem" }}>
                        {item.tradingViewSymbol}
                      </span>
                    </button>
                  ))}
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
                <p className="card-desc">{selected.tradingViewSymbol} · Daily history</p>
              </div>
              <span className="badge badge-success">TradingView</span>
            </div>
            <TradingViewChart symbol={selected.tradingViewSymbol} />
          </div>

          <div className="card mt-6">
            <div className="card-header">
              <h3 className="card-title">All Watchlist History</h3>
              <p className="card-desc">12-month price history for every watchlist symbol</p>
            </div>
            <div className="tv-mini-grid">
              {WATCHLIST_ITEMS.map((item) => (
                <TradingViewMiniChart
                  key={item.id}
                  symbol={item.tradingViewSymbol}
                  label={item.label}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
