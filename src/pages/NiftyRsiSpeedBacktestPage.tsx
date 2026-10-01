import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Gauge, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import { NSE_SESSIONS_ONE_YEAR } from "@/types/nine-fifteen";
import type {
  NiftyRsiSpeedBacktestResult,
  NiftyRsiSpeedBandSummary,
  NiftyRsiSpeedOccurrence,
  RsiSpeedBandId,
} from "@/types/nifty-rsi-speed-backtest";
import "@/styles/nifty-rsi-speed-backtest-page.css";

const DEFAULT_DAYS = NSE_SESSIONS_ONE_YEAR;

type OutcomeFilter = "all" | "win" | "loss";
type LegFilter = "all" | "CE_BUY" | "PE_BUY";
type BandFilter = "all" | RsiSpeedBandId;

export default function NiftyRsiSpeedBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<NiftyRsiSpeedBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const [legFilter, setLegFilter] = useState<LegFilter>("all");
  const [bandFilter, setBandFilter] = useState<BandFilter>("all");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(DEFAULT_DAYS) });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nifty-rsi-speed-backtest?${qs}`, { credentials: "include" });
      const json = (await res.json()) as { data?: NiftyRsiSpeedBacktestResult; error?: string };
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

  const allBands = useMemo(
    () => (data ? [...data.rules.ceBands, ...data.rules.peBands] : []),
    [data],
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    return data.occurrences.filter((row) => {
      if (legFilter !== "all" && row.tradeLeg !== legFilter) return false;
      if (bandFilter !== "all" && row.bandId !== bandFilter) return false;
      if (outcomeFilter === "win" && !row.win) return false;
      if (outcomeFilter === "loss" && row.win) return false;
      return true;
    });
  }, [data, outcomeFilter, legFilter, bandFilter]);

  const rangeLabel = data ? `${data.from} → ${data.to}` : "";

  return (
    <DashboardShell>
      <div className="rsispeed-page">
        <header className="rsispeed-header">
          <div>
            <h1 className="rsispeed-title">
              <Gauge size={22} style={{ verticalAlign: "middle", marginRight: "0.35rem" }} />
              RSI Speed-O-Meter
            </h1>
            <p className="rsispeed-subtitle">
              Last ~{DEFAULT_DAYS} NSE sessions · 9:20 AM–3:00 PM (1-min OHLC).{" "}
              <strong>CE</strong> when RSI jumps up a full band in one minute — win = Nifty +10.{" "}
              <strong>PE</strong> when RSI drops down a full band in one minute — win = Nifty −10. Both
              before 3:00 PM.
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void load(true)} disabled={loading || !connected}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            {loading ? "Running…" : "Run analysis"}
          </button>
        </header>

        {!connected && (
          <div className="card rsispeed-error">
            <AlertTriangle size={16} />
            <p>Connect Zerodha to pull Nifty 1-minute history from Kite.</p>
          </div>
        )}

        {error && (
          <div className="card rsispeed-error">
            <AlertTriangle size={16} />
            <p>{error}</p>
          </div>
        )}

        {loading && !data && (
          <div className="card rsispeed-loading">
            <div className="spinner" />
            <p>Pulling ~1 year of Nifty session minutes… this can take a few minutes.</p>
          </div>
        )}

        {data && (
          <>
            <section className="card rsispeed-rules">
              <h2>
                <TrendingUp size={16} /> Rules
              </h2>
              <ul>
                <li>RSI(14) on Nifty 1-minute closes (Wilder smoothing).</li>
                <li>
                  <strong>CE</strong> — prior bar RSI inside the band, then a full upward span in one minute
                  (e.g. 10→40 = +30 to 40+). Win when high touches entry + {data.rules.winTargetPts}.
                </li>
                <li>
                  <strong>PE</strong> — prior bar RSI inside the band, then a full downward span in one minute
                  (e.g. 90→60 = −30 to 60−). Win when low touches entry − {data.rules.winTargetPts}.
                </li>
                <li>
                  Window {data.rules.triggerWindowIst} IST · up to one entry per band per session · target before{" "}
                  {data.rules.exitDeadlineIst}.
                </li>
              </ul>
              <p className="rsispeed-muted">
                Range: {rangeLabel} · {data.daysRequested} trading sessions
              </p>
            </section>

            <h2 className="rsispeed-section-title">
              <TrendingUp size={16} /> CE buy · RSI speed up
            </h2>
            <div className="rsispeed-summary-grid">
              {data.ceSummaries.map((summary) => (
                <SummaryCard key={summary.bandId} summary={summary} winTarget={data.rules.winTargetPts} />
              ))}
            </div>

            <h2 className="rsispeed-section-title">
              <TrendingDown size={16} /> PE buy · RSI speed down
            </h2>
            <div className="rsispeed-summary-grid">
              {data.peSummaries.map((summary) => (
                <SummaryCard key={summary.bandId} summary={summary} winTarget={data.rules.winTargetPts} />
              ))}
            </div>

            <section className="card rsispeed-table-section">
              <div className="rsispeed-table-toolbar">
                <h2>All entries ({filteredRows.length})</h2>
                <div className="rsispeed-filters">
                  {(["all", "CE_BUY", "PE_BUY"] as const).map((leg) => (
                    <button
                      key={leg}
                      type="button"
                      className={`btn btn-sm ${legFilter === leg ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => setLegFilter(leg)}
                    >
                      {leg === "all" ? "All legs" : leg === "CE_BUY" ? "CE" : "PE"}
                    </button>
                  ))}
                </div>
                <div className="rsispeed-filters">
                  <button
                    type="button"
                    className={`btn btn-sm ${bandFilter === "all" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setBandFilter("all")}
                  >
                    All bands
                  </button>
                  {allBands.map((band) => (
                    <button
                      key={band.id}
                      type="button"
                      className={`btn btn-sm ${bandFilter === band.id ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => setBandFilter(band.id)}
                    >
                      {band.tradeLeg === "PE_BUY" ? "PE " : "CE "}
                      {band.label}
                    </button>
                  ))}
                </div>
                <div className="rsispeed-filters">
                  {(["all", "win", "loss"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`btn btn-sm ${outcomeFilter === f ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => setOutcomeFilter(f)}
                    >
                      {f === "all" ? "All" : f === "win" ? "Wins" : "Losses"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rsispeed-table-wrap">
                <table className="rsispeed-table">
                  <thead>
                    <tr>
                      <th>Leg</th>
                      <th>Date</th>
                      <th>Day</th>
                      <th>Band</th>
                      <th>Entry</th>
                      <th>Outcome</th>
                      <th>RSI Δ</th>
                      <th>Prev → RSI</th>
                      <th>Nifty entry</th>
                      <th>Target</th>
                      <th>Win exit</th>
                      <th>Min to target</th>
                      <th>Max move</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="rsispeed-empty">
                          No entries for this filter.
                        </td>
                      </tr>
                    ) : (
                      filteredRows.map((row) => (
                        <OccurrenceRow key={rowKey(row)} row={row} winTarget={data.rules.winTargetPts} />
                      ))
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

function SummaryCard({
  summary,
  winTarget,
}: {
  summary: NiftyRsiSpeedBandSummary;
  winTarget: number;
}) {
  const isPe = summary.tradeLeg === "PE_BUY";
  const targetLabel = isPe ? `−${winTarget}` : `+${winTarget}`;

  return (
    <section className="card rsispeed-summary">
      <h3>
        RSI {summary.bandLabel} in 1 min · {isPe ? "PE" : "CE"} {targetLabel} pt target
      </h3>
      <div className="rsispeed-stat-grid">
        <div>
          <p className="rsispeed-stat-label">Wins</p>
          <p className="rsispeed-stat-value rsispeed-up">
            {summary.winCount}{" "}
            <span className="rsispeed-stat-pct">({summary.winPct.toFixed(1)}%)</span>
          </p>
          {summary.avgMinutesToWin != null && (
            <p className="rsispeed-stat-hint">
              Avg {summary.avgMinutesToWin.toFixed(0)} min to {targetLabel}
            </p>
          )}
        </div>
        <div>
          <p className="rsispeed-stat-label">Losses</p>
          <p className="rsispeed-stat-value rsispeed-down">{summary.lossCount}</p>
          <p className="rsispeed-stat-hint">
            No {targetLabel} pt {isPe ? "drop" : "run"} before 15:00
          </p>
        </div>
        <div>
          <p className="rsispeed-stat-label">Entries</p>
          <p className="rsispeed-stat-value">{summary.totalEntries}</p>
          <p className="rsispeed-stat-hint">Avg RSI move {summary.avgRsiDelta.toFixed(1)}</p>
        </div>
        <div>
          <p className="rsispeed-stat-label">Avg max {isPe ? "drop" : "run-up"}</p>
          <p className={`rsispeed-stat-value ${isPe ? "rsispeed-down" : "rsispeed-up"}`}>
            {summary.avgMaxFavorablePts.toFixed(2)} pts
          </p>
        </div>
      </div>
    </section>
  );
}

function rowKey(row: NiftyRsiSpeedOccurrence): string {
  return `${row.tradeLeg}-${row.date}-${row.bandId}-${row.timeIst}`;
}

function OccurrenceRow({ row, winTarget }: { row: NiftyRsiSpeedOccurrence; winTarget: number }) {
  const isPe = row.tradeLeg === "PE_BUY";
  const targetPrice = isPe ? row.triggerPrice - winTarget : row.triggerPrice + winTarget;

  return (
    <tr>
      <td>{isPe ? "PE" : "CE"}</td>
      <td>{row.date}</td>
      <td>{row.weekday}</td>
      <td>{row.bandLabel}</td>
      <td>{row.timeIst}</td>
      <td>
        <span className={`rsispeed-outcome-pill ${row.win ? "rsispeed-outcome-win" : "rsispeed-outcome-loss"}`}>
          {row.win ? "Win" : "Loss"}
        </span>
      </td>
      <td className={isPe ? "rsispeed-down" : "rsispeed-up"}>
        {row.rsiDelta >= 0 ? "+" : ""}
        {row.rsiDelta.toFixed(1)}
      </td>
      <td>
        {row.prevRsi.toFixed(1)} → {row.triggerRsi.toFixed(1)}
      </td>
      <td>{row.triggerPrice.toFixed(2)}</td>
      <td>{targetPrice.toFixed(2)}</td>
      <td>{row.winExitTimeIst ?? "—"}</td>
      <td>{row.minutesToWin ?? "—"}</td>
      <td className={isPe ? "rsispeed-down" : "rsispeed-up"}>
        {isPe ? (
          <ArrowDownRight size={12} style={{ verticalAlign: "middle", marginRight: "0.15rem" }} />
        ) : (
          <ArrowUpRight size={12} style={{ verticalAlign: "middle", marginRight: "0.15rem" }} />
        )}
        {row.maxFavorablePts.toFixed(2)} pts
      </td>
    </tr>
  );
}
