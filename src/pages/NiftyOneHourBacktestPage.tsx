import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, RefreshCw, TrendingUp } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import type {
  NiftyOneHourOccurrence,
  NiftyOneHourBacktestResult,
  NiftyOneHourTriggerDirection,
} from "@/types/nifty-one-hour-backtest";
import "@/styles/nifty-one-hour-backtest-page.css";

const DEFAULT_DAYS = 63;

type DirectionFilter = "all" | NiftyOneHourTriggerDirection;

function formatSigned(value: number, suffix = ""): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}${suffix}`;
}

function moveClass(value: number): string {
  if (value > 0) return "nifty1h-up";
  if (value < 0) return "nifty1h-down";
  return "";
}

export default function NiftyOneHourBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<NiftyOneHourBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [hourFilter, setHourFilter] = useState<string>("all");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(DEFAULT_DAYS) });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nifty-one-hour-backtest?${qs}`, { credentials: "include" });
      const json = (await res.json()) as { data?: NiftyOneHourBacktestResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Backtest request failed");
      if (!json.data) throw new Error("Empty backtest response");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backtest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void load(false);
  }, [connected, load]);

  const hourOptions = useMemo(() => {
    if (!data) return [];
    return data.rules.triggerWindows;
  }, [data]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.occurrences.filter((row) => {
      if (directionFilter !== "all" && row.triggerDirection !== directionFilter) return false;
      if (hourFilter !== "all" && row.triggerHourLabel !== hourFilter) return false;
      return true;
    });
  }, [data, directionFilter, hourFilter]);

  const rangeLabel = data ? `${data.from} → ${data.to}` : "";

  return (
    <DashboardShell>
      <div className="nifty1h-page">
        <header className="nifty1h-header">
          <div>
            <h1 className="nifty1h-title">NIFTY 50 – 1 Hour</h1>
            <p className="nifty1h-subtitle">
              Scans the last 3 months of Nifty 1-minute candles. Flags hours between 10:00 and 1:00 PM
              when Nifty moves more than ±50 points in 60 minutes, then shows how the following hour
              behaved.
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void load(true)} disabled={loading || !connected}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            {loading ? "Running…" : "Run analysis"}
          </button>
        </header>

        {!connected && (
          <div className="card nifty1h-error">
            <AlertTriangle size={16} />
            <p>Connect Zerodha to pull Nifty 1-minute history from Kite.</p>
          </div>
        )}

        {error && (
          <div className="card nifty1h-error">
            <AlertTriangle size={16} />
            <p>{error}</p>
          </div>
        )}

        {loading && !data && (
          <div className="card nifty1h-loading">
            <div className="spinner" />
            <p>Pulling ~3 months of Nifty session minutes…</p>
          </div>
        )}

        {data && (
          <>
            <section className="card nifty1h-rules">
              <h2>
                <TrendingUp size={16} /> Rules
              </h2>
              <ul>
                <li>
                  Trigger windows: {data.rules.triggerWindows.join(", ")} IST (net move from hour open to
                  close).
                </li>
                <li>
                  Trigger when Nifty moves more than +{data.rules.moveThresholdPts} or −
                  {data.rules.moveThresholdPts} points within the hour.
                </li>
                <li>Next hour: the 60-minute window immediately after each trigger.</li>
              </ul>
              <p className="nifty1h-muted">Range: {rangeLabel} · {data.daysRequested} trading sessions</p>
            </section>

            <section className="card nifty1h-summary">
              <h2>Summary</h2>
              <div className="nifty1h-stat-grid">
                <div>
                  <p className="nifty1h-stat-label">Total triggers</p>
                  <p className="nifty1h-stat-value">{data.summary.totalOccurrences}</p>
                </div>
                <div>
                  <p className="nifty1h-stat-label">Up triggers</p>
                  <p className="nifty1h-stat-value nifty1h-up">{data.summary.upTriggers}</p>
                  <p className="nifty1h-stat-hint">
                    Avg next hour: {formatSigned(data.summary.avgNextMoveAfterUp)} pts
                  </p>
                </div>
                <div>
                  <p className="nifty1h-stat-label">Down triggers</p>
                  <p className="nifty1h-stat-value nifty1h-down">{data.summary.downTriggers}</p>
                  <p className="nifty1h-stat-hint">
                    Avg next hour: {formatSigned(data.summary.avgNextMoveAfterDown)} pts
                  </p>
                </div>
                <div>
                  <p className="nifty1h-stat-label">Continuation rate</p>
                  <p className="nifty1h-stat-value">{data.summary.continuationPct.toFixed(1)}%</p>
                  <p className="nifty1h-stat-hint">Next hour moved same direction as trigger</p>
                </div>
              </div>
            </section>

            <section className="card nifty1h-table-section">
              <div className="nifty1h-table-toolbar">
                <h2>All occurrences ({filteredRows.length})</h2>
                <div className="nifty1h-filters">
                  <button
                    type="button"
                    className={`btn btn-sm ${directionFilter === "all" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setDirectionFilter("all")}
                  >
                    All directions
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${directionFilter === "up" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setDirectionFilter("up")}
                  >
                    Up triggers
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${directionFilter === "down" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setDirectionFilter("down")}
                  >
                    Down triggers
                  </button>
                  <select
                    className="input input-sm"
                    value={hourFilter}
                    onChange={(e) => setHourFilter(e.target.value)}
                    aria-label="Filter by trigger hour"
                  >
                    <option value="all">All hours</option>
                    {hourOptions.map((hour) => (
                      <option key={hour} value={hour}>
                        {hour}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="nifty1h-table-wrap">
                <table className="nifty1h-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Day</th>
                      <th>Trigger hour</th>
                      <th>Trigger</th>
                      <th>Trigger move</th>
                      <th>Trigger start</th>
                      <th>Trigger end</th>
                      <th>Next hour</th>
                      <th>Next move (pts)</th>
                      <th>Next move (%)</th>
                      <th>Next start</th>
                      <th>Next end</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="nifty1h-empty">
                          No rows match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredRows.map((row) => <OccurrenceRow key={rowKey(row)} row={row} />)
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </DashboardShell>
  );
}

function rowKey(row: NiftyOneHourOccurrence): string {
  return `${row.date}-${row.triggerHourLabel}-${row.triggerDirection}`;
}

function OccurrenceRow({ row }: { row: NiftyOneHourOccurrence }) {
  const directionLabel = row.triggerDirection === "up" ? "Up" : "Down";
  const DirectionIcon = row.triggerDirection === "up" ? ArrowUpRight : ArrowDownRight;

  return (
    <tr>
      <td>{row.date}</td>
      <td>{row.weekday}</td>
      <td>{row.triggerHourLabel}</td>
      <td>
        <span className={`nifty1h-direction-pill nifty1h-direction-${row.triggerDirection}`}>
          <DirectionIcon size={12} style={{ verticalAlign: "middle", marginRight: "0.2rem" }} />
          {directionLabel}
        </span>
      </td>
      <td className={moveClass(row.triggerMovePts)}>{formatSigned(row.triggerMovePts)} pts</td>
      <td>{row.triggerStartPrice.toFixed(2)}</td>
      <td>{row.triggerEndPrice.toFixed(2)}</td>
      <td>{row.nextHourLabel}</td>
      <td className={moveClass(row.nextMovePts)}>{formatSigned(row.nextMovePts)} pts</td>
      <td className={moveClass(row.nextMovePct)}>{formatSigned(row.nextMovePct, "%")}</td>
      <td>{row.nextStartPrice.toFixed(2)}</td>
      <td>{row.nextEndPrice.toFixed(2)}</td>
    </tr>
  );
}
