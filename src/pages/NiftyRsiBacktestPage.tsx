import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import { NSE_SESSIONS_ONE_YEAR } from "@/types/nine-fifteen";
import type { NiftyRsiBacktestResult, NiftyRsiOccurrence, NiftyRsiThresholdSummary } from "@/types/nifty-rsi-backtest";
import "@/styles/nifty-rsi-backtest-page.css";

const DEFAULT_DAYS = NSE_SESSIONS_ONE_YEAR;

type OutcomeFilter = "all" | "win" | "loss";

export default function NiftyRsiBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<NiftyRsiBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(DEFAULT_DAYS) });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nifty-rsi-backtest?${qs}`, { credentials: "include" });
      const json = (await res.json()) as { data?: NiftyRsiBacktestResult; error?: string };
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

  const summary = data?.summaries[0] ?? null;

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.occurrences.filter((row) => {
      if (outcomeFilter === "win" && !row.win) return false;
      if (outcomeFilter === "loss" && row.win) return false;
      return true;
    });
  }, [data, outcomeFilter]);

  const rangeLabel = data ? `${data.from} → ${data.to}` : "";

  return (
    <DashboardShell>
      <div className="niftyrsi-page">
        <header className="niftyrsi-header">
          <div>
            <h1 className="niftyrsi-title">RSI 95 · PE</h1>
            <p className="niftyrsi-subtitle">
              Last ~{DEFAULT_DAYS} NSE sessions. Buy PE when RSI(14) first reaches 95 between 9:20 AM and
              3:00 PM IST (1-min OHLC). Win = Nifty falls 10 points from that entry before 3:00 PM.
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void load(true)} disabled={loading || !connected}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            {loading ? "Running…" : "Run analysis"}
          </button>
        </header>

        {!connected && (
          <div className="card niftyrsi-error">
            <AlertTriangle size={16} />
            <p>Connect Zerodha to pull Nifty 1-minute history from Kite.</p>
          </div>
        )}

        {error && (
          <div className="card niftyrsi-error">
            <AlertTriangle size={16} />
            <p>{error}</p>
          </div>
        )}

        {loading && !data && (
          <div className="card niftyrsi-loading">
            <div className="spinner" />
            <p>Pulling ~1 year of Nifty session minutes… this can take a few minutes.</p>
          </div>
        )}

        {data && summary && (
          <>
            <section className="card niftyrsi-rules">
              <h2>
                <TrendingUp size={16} /> Rules
              </h2>
              <ul>
                <li>RSI(14) on Nifty 1-minute closes (Wilder smoothing).</li>
                <li>
                  Entry: {data.rules.tradeLeg.replace("_", " ")} when RSI first crosses from below{" "}
                  {data.rules.entryRsiLevel} to {data.rules.entryRsiLevel}+ between{" "}
                  {data.rules.triggerWindowIst} IST (one entry per session).
                </li>
                <li>
                  Entry price: Nifty close on the RSI-95 bar. Target: Nifty −{data.rules.winTargetPts} pts
                  from there (checked on subsequent 1-min lows).
                </li>
                <li>
                  Win: target hit before {data.rules.exitDeadlineIst} IST. Loss: not hit before{" "}
                  {data.rules.exitDeadlineIst}.
                </li>
              </ul>
              <p className="niftyrsi-muted">
                Range: {rangeLabel} · {data.daysRequested} trading sessions
              </p>
            </section>

            <SummaryCard summary={summary} />

            <section className="card niftyrsi-table-section">
              <div className="niftyrsi-table-toolbar">
                <h2>
                  <TrendingDown size={16} /> PE entries at RSI 95 ({filteredRows.length})
                </h2>
                <div className="niftyrsi-filters">
                  <button
                    type="button"
                    className={`btn btn-sm ${outcomeFilter === "all" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setOutcomeFilter("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${outcomeFilter === "win" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setOutcomeFilter("win")}
                  >
                    Wins
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${outcomeFilter === "loss" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setOutcomeFilter("loss")}
                  >
                    Losses
                  </button>
                </div>
              </div>

              <div className="niftyrsi-table-wrap">
                <table className="niftyrsi-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Day</th>
                      <th>Entry</th>
                      <th>Outcome</th>
                      <th>RSI</th>
                      <th>Nifty entry</th>
                      <th>Target</th>
                      <th>Win exit</th>
                      <th>Min to −10</th>
                      <th>Max drop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="niftyrsi-empty">
                          No RSI-95 PE entries in this range for the selected filter.
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

function SummaryCard({ summary }: { summary: NiftyRsiThresholdSummary }) {
  return (
    <section className="card niftyrsi-summary">
      <h2>RSI reaches 95 · PE −10 pt target before 3 PM</h2>
      <div className="niftyrsi-stat-grid">
        <div>
          <p className="niftyrsi-stat-label">Wins</p>
          <p className="niftyrsi-stat-value niftyrsi-up">
            {summary.winCount}{" "}
            <span className="niftyrsi-stat-pct">({summary.winPct.toFixed(1)}%)</span>
          </p>
          {summary.avgMinutesToWin != null && (
            <p className="niftyrsi-stat-hint">Avg {summary.avgMinutesToWin.toFixed(0)} min to −10</p>
          )}
        </div>
        <div>
          <p className="niftyrsi-stat-label">Losses</p>
          <p className="niftyrsi-stat-value niftyrsi-down">{summary.lossCount}</p>
          <p className="niftyrsi-stat-hint">Nifty did not drop 10 pts before 15:00</p>
        </div>
        <div>
          <p className="niftyrsi-stat-label">Total PE entries</p>
          <p className="niftyrsi-stat-value">{summary.totalTriggers}</p>
          <p className="niftyrsi-stat-hint">Sessions where RSI hit 95 between 9:20–15:00</p>
        </div>
        <div>
          <p className="niftyrsi-stat-label">Avg max Nifty drop</p>
          <p className="niftyrsi-stat-value niftyrsi-down">{summary.avgMaxDrawdownPts.toFixed(2)} pts</p>
        </div>
      </div>
    </section>
  );
}

function rowKey(row: NiftyRsiOccurrence): string {
  return `${row.date}-${row.timeIst}`;
}

function OccurrenceRow({ row }: { row: NiftyRsiOccurrence }) {
  const targetPrice = row.triggerPrice - 10;

  return (
    <tr>
      <td>{row.date}</td>
      <td>{row.weekday}</td>
      <td>{row.timeIst}</td>
      <td>
        <span className={`niftyrsi-outcome-pill ${row.win ? "niftyrsi-outcome-win" : "niftyrsi-outcome-loss"}`}>
          {row.win ? "Win" : "Loss"}
        </span>
      </td>
      <td>
        <span className="niftyrsi-rsi-pill niftyrsi-rsi-95">{row.triggerRsi.toFixed(1)}</span>
      </td>
      <td>{row.triggerPrice.toFixed(2)}</td>
      <td>{targetPrice.toFixed(2)}</td>
      <td>{row.winExitTimeIst ?? "—"}</td>
      <td>{row.minutesToWin ?? "—"}</td>
      <td className="niftyrsi-down">
        <ArrowDownRight size={12} style={{ verticalAlign: "middle", marginRight: "0.15rem" }} />
        {row.maxDrawdownPts.toFixed(2)} pts
      </td>
    </tr>
  );
}
