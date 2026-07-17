import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  Calendar,
  Minus,
  RefreshCw,
  Search,
} from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import type {
  MlTradingHourPrediction,
  MlTradingHourSlot,
  MlTradingMatch,
  MlTradingMatchResult,
  MlTradingOptionTrade,
  MlTradingStatus,
  MlTradingWeekMatch,
} from "@/types/ml-trading";
import { cn, formatNumber } from "@/lib/utils";
import "@/styles/ml-trading-page.css";

function outcomeIcon(outcome: string) {
  if (outcome === "bullish") return <ArrowUpRight size={16} className="text-up" />;
  if (outcome === "bearish") return <ArrowDownRight size={16} className="text-down" />;
  return <Minus size={16} className="text-muted" />;
}

function formatPct(value: number, signed = true) {
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${formatNumber(value, 2)}%`;
}

function formatDateLabel(date: string) {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

function resolveFullDaySlots(
  fullDaySlots: MlTradingHourSlot[] | undefined,
  fallback: MlTradingHourSlot[] | undefined,
): MlTradingHourSlot[] {
  if (fullDaySlots?.length) return fullDaySlots;
  return fallback ?? [];
}

function HourTable({
  slots,
  matchedBars,
  showPct = false,
}: {
  slots: MlTradingHourSlot[];
  matchedBars: number;
  showPct?: boolean;
}) {
  return (
    <div className="ml-trading-hour-table-wrap">
      <table className="ml-trading-hour-table">
        <thead>
          <tr>
            <th>Hour (IST)</th>
            <th>Open</th>
            <th>High</th>
            <th>Low</th>
            <th>Close</th>
            {showPct && (
              <>
                <th>High vs open</th>
                <th>Low vs open</th>
              </>
            )}
            <th>Used in match</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((slot, index) => {
            const matched = index < matchedBars;
            return (
              <tr
                key={`${slot.time}-${slot.hour_label}`}
                className={cn(matched && "ml-trading-hour-row--matched")}
              >
                <td>{slot.hour_label}</td>
                <td>{formatNumber(slot.open, 2)}</td>
                <td>{formatNumber(slot.high, 2)}</td>
                <td>{formatNumber(slot.low, 2)}</td>
                <td>{formatNumber(slot.close, 2)}</td>
                {showPct && (
                  <>
                    <td className="text-up">{formatPct(slot.high_pct)}</td>
                    <td className={slot.low_pct >= 0 ? "text-up" : "text-down"}>{formatPct(slot.low_pct)}</td>
                  </>
                )}
                <td>{matched ? "Yes" : slots.length > matchedBars ? "No" : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HourPredictionTable({ rows }: { rows: MlTradingHourPrediction[] }) {
  return (
    <div className="ml-trading-hour-table-wrap">
      <table className="ml-trading-hour-table">
        <thead>
          <tr>
            <th>Hour (IST)</th>
            <th>Status</th>
            <th>Actual O/H/L/C</th>
            <th>Predicted O/H/L/C</th>
            <th>Hour bias</th>
            <th>Conf.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.hourLabel}
              className={cn(
                row.status === "actual" && "ml-trading-hour-row--matched",
                row.status === "predicted" && "ml-trading-hour-row--predicted",
              )}
            >
              <td>{row.hourLabel}</td>
              <td className="capitalize">{row.status}</td>
              <td>
                {row.status === "actual"
                  ? `${formatNumber(row.open ?? 0, 2)} / ${formatNumber(row.high ?? 0, 2)} / ${formatNumber(row.low ?? 0, 2)} / ${formatNumber(row.close ?? 0, 2)}`
                  : "—"}
              </td>
              <td>
                {row.predOpen != null
                  ? `${formatNumber(row.predOpen, 2)} / ${formatNumber(row.predHigh ?? 0, 2)} / ${formatNumber(row.predLow ?? 0, 2)} / ${formatNumber(row.predClose ?? 0, 2)}`
                  : "—"}
              </td>
              <td className={cn("capitalize", row.hourBias === "bullish" ? "text-up" : row.hourBias === "bearish" ? "text-down" : "")}>
                {row.hourBias}
              </td>
              <td>{row.status === "predicted" ? `${formatNumber(row.confidence * 100, 0)}%` : row.status === "actual" ? "100%" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatInr(value: number, signed = false) {
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}₹${formatNumber(Math.abs(value), 0)}`;
}

function OptionTradePanel({ trade, title }: { trade: MlTradingOptionTrade | null | undefined; title?: string }) {
  if (!trade) {
    return (
      <div className="ml-trading-option-trade ml-trading-option-trade--empty">
        <p className="text-muted text-sm">9:15 → 3:15 option data not available for this day.</p>
      </div>
    );
  }

  const profitClass = trade.netPnlRupees >= 0 ? "text-up" : "text-down";

  return (
    <div className="ml-trading-option-trade">
      {title && <h4 className="ml-trading-option-trade-title">{title}</h4>}
      <div className="ml-trading-option-trade-rec">
        <strong className={trade.side === "CE" ? "text-up" : "text-down"}>{trade.action}</strong>
        <span className="text-muted"> · ATM strike {formatNumber(trade.atmStrike, 0)}</span>
        {trade.symbol && <span className="text-muted text-sm"> · {trade.symbol}</span>}
      </div>
      <dl className="ml-trading-option-trade-grid">
        <div>
          <dt>Entry 9:15</dt>
          <dd>NIFTY {formatNumber(trade.entrySpot, 2)} · premium {formatNumber(trade.entryPremium, 2)}</dd>
        </div>
        <div>
          <dt>Exit 3:15{trade.isProjection ? " (proj.)" : ""}</dt>
          <dd>NIFTY {formatNumber(trade.exitSpot, 2)} · premium {formatNumber(trade.exitPremium, 2)}</dd>
        </div>
        <div>
          <dt>Spot move</dt>
          <dd className={trade.spotMovePct >= 0 ? "text-up" : "text-down"}>{formatPct(trade.spotMovePct)}</dd>
        </div>
        <div>
          <dt>Cost (1 lot × {trade.lotSize})</dt>
          <dd>{formatInr(trade.costRupees)}</dd>
        </div>
        <div>
          <dt>Gross P/L</dt>
          <dd className={profitClass}>{formatInr(trade.grossPnlRupees, true)}</dd>
        </div>
        <div>
          <dt>Net P/L (after ₹{trade.brokerageRupees})</dt>
          <dd className={cn("font-semibold", profitClass)}>{formatInr(trade.netPnlRupees, true)}</dd>
        </div>
      </dl>
      <p className="text-muted text-xs mt-2">
        Expiry {trade.expiry} · {trade.dataSource === "kite" ? "Zerodha 1m option prices" : "Black-Scholes estimate"}
        {trade.note ? ` · ${trade.note}` : ""}
      </p>
    </div>
  );
}

function WeekMatchCard({
  match,
  rank,
  optionTrade,
}: {
  match: MlTradingWeekMatch;
  rank: number;
  optionTrade?: MlTradingOptionTrade | null;
}) {
  return (
    <article className="ml-trading-match-card">
      <div className="ml-trading-match-head">
        <span className="ml-trading-match-rank">#{rank}</span>
        <div>
          <strong>{match.weekId}</strong>
          <p className="text-muted text-sm">Same weekday: {formatDateLabel(match.todayAnalogDate)}</p>
        </div>
        <span className="ml-trading-similarity">
          {formatNumber(match.similarity * 100, 1)}% week match
          {match.closestFallback && " · closest"}
        </span>
      </div>
      <div className="ml-trading-match-grid">
        <div>
          <span className="text-muted">Week start</span>
          <p className="font-medium">{match.weekStart}</p>
        </div>
        <div>
          <span className="text-muted">Analog day outcome</span>
          <p className={cn("font-semibold capitalize", match.todayAnalogOutcome === "bullish" ? "text-up" : match.todayAnalogOutcome === "bearish" ? "text-down" : "")}>
            {match.todayAnalogOutcome}
          </p>
        </div>
        <div>
          <span className="text-muted">Analog day return</span>
          <p className={cn("font-semibold", match.todayAnalogDayReturnPct >= 0 ? "text-up" : "text-down")}>
            {formatPct(match.todayAnalogDayReturnPct)}
          </p>
        </div>
        <div>
          <span className="text-muted">Days in week match</span>
          <p className="font-medium text-sm">{match.weekDaysMatched.join(", ")}</p>
        </div>
      </div>
      <OptionTradePanel trade={optionTrade} title={`9:15 → 3:15 on ${formatDateLabel(match.todayAnalogDate)}`} />
    </article>
  );
}

function MatchCard({
  match,
  rank,
  compareBars,
  optionTrade,
}: {
  match: MlTradingMatch;
  rank: number;
  compareBars: number;
  optionTrade?: MlTradingOptionTrade | null;
}) {
  const fullSlots = resolveFullDaySlots(match.fullDaySlots, match.slots);
  const matchedCount = match.matchedBars ?? compareBars;

  return (
    <article className="ml-trading-match-card">
      <div className="ml-trading-match-head">
        <span className="ml-trading-match-rank">#{rank}</span>
        <div>
          <strong>{formatDateLabel(match.date)}</strong>
          <p className="text-muted text-sm">{match.date}</p>
        </div>
        <span className="ml-trading-similarity">
          {formatNumber(match.similarity * 100, 1)}% match
          {match.closestFallback && " · closest"}
        </span>
      </div>
      <div className="ml-trading-match-grid">
        <div>
          <span className="text-muted">Day outcome</span>
          <p className={cn("font-semibold capitalize", match.outcome === "bullish" ? "text-up" : match.outcome === "bearish" ? "text-down" : "")}>
            {outcomeIcon(match.outcome)} {match.outcome}
          </p>
        </div>
        <div>
          <span className="text-muted">Full day</span>
          <p className={cn("font-semibold", match.dayReturnPct >= 0 ? "text-up" : "text-down")}>
            {formatPct(match.dayReturnPct)}
          </p>
        </div>
        <div>
          <span className="text-muted">After {match.matchedThrough}</span>
          <p className={cn("font-semibold", match.restOfDayReturnPct >= 0 ? "text-up" : "text-down")}>
            {formatPct(match.restOfDayReturnPct)}
          </p>
        </div>
        <div>
          <span className="text-muted">Day OHLC</span>
          <p className="font-medium text-sm">
            O {formatNumber(match.dayOpen, 2)} · H {formatNumber(match.dayHigh, 2)} · L {formatNumber(match.dayLow, 2)} · C {formatNumber(match.dayClose, 2)}
          </p>
        </div>
      </div>
      <p className="text-muted text-sm mb-2">
        Full day — {fullSlots.length} hourly bars · all {matchedCount} session bars used for pattern match
      </p>
      <HourTable slots={fullSlots} matchedBars={matchedCount} />
      <OptionTradePanel trade={optionTrade} title={`9:15 → 3:15 on ${formatDateLabel(match.date)}`} />
    </article>
  );
}

export default function MlTradingPage() {
  const { connected, loginUrl } = useKite();
  const [status, setStatus] = useState<MlTradingStatus | null>(null);
  const [match, setMatch] = useState<MlTradingMatchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ml-trading/status", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load status");
      setStatus(json.data as MlTradingStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }, []);

  const runMatch = useCallback(async () => {
    if (!connected) return;
    setMatching(true);
    setError(null);
    try {
      const res = await fetch("/api/ml-trading/match", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Pattern match failed");
      setMatch(json.data as MlTradingMatchResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pattern match failed");
    } finally {
      setMatching(false);
    }
  }, [connected]);

  const syncData = useCallback(async () => {
    if (!connected) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/ml-trading/sync", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 365 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      await loadStatus();
      await runMatch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [connected, loadStatus, runMatch]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (connected && status?.libraryBuilt) {
      void runMatch();
    }
  }, [connected, status?.libraryBuilt, runMatch]);

  const predictionClass =
    match?.prediction === "bullish" ? "ml-trading-prediction--bull" : match?.prediction === "bearish" ? "ml-trading-prediction--bear" : "ml-trading-prediction--neutral";

  return (
    <DashboardShell>
      <div className="page-header mb-6">
        <h1>ML Trading</h1>
        <p>Match the current week&apos;s hourly shape to history — predict every hour of today.</p>
      </div>

      {!connected ? (
        <div className="card">
          <p className="text-muted">Connect Zerodha to fetch hourly NIFTY 50 history.</p>
          {loginUrl && (
            <a href={loginUrl} className="mt-4 inline-block">
              <button type="button" className="btn btn-primary">Connect Kite</button>
            </a>
          )}
        </div>
      ) : (
        <>
          {error && (
            <div className="card prediction-error mb-4">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}
          {match?.usedClosestMatch && !error && (
            <div className="card mb-4 ml-trading-closest-note">
              <AlertTriangle size={16} />
              No exact week match — showing closest historical pattern (
              {formatNumber((match.bestSimilarity ?? 0) * 100, 1)}% similarity).
            </div>
          )}

          <div className="ml-trading-grid mb-6">
            <section className="card ml-trading-panel">
              <h2 className="ml-trading-panel-title">
                <BrainCircuit size={18} />
                Pattern library
              </h2>
              {loading ? (
                <p className="text-muted">Loading…</p>
              ) : (
                <>
                  <p className="text-muted text-sm mb-4">{status?.note}</p>
                  <dl className="ml-trading-stats">
                    <div><dt>Instrument</dt><dd>{status?.instrument ?? "NSE:NIFTY 50"}</dd></div>
                    <div><dt>Interval</dt><dd>1 hour</dd></div>
                    <div><dt>History</dt><dd>{status?.days ?? 365} days</dd></div>
                    <div><dt>Candles</dt><dd>{status?.candleCount ?? 0}</dd></div>
                    <div><dt>Day patterns</dt><dd>{status?.patternCount ?? 0}</dd></div>
                    <div><dt>Range</dt><dd>{status?.firstDate && status?.lastDate ? `${status.firstDate} → ${status.lastDate}` : "—"}</dd></div>
                    <div><dt>Python</dt><dd>{status?.pythonAvailable ? status.pythonVersion : "Not available"}</dd></div>
                  </dl>
                  <button
                    type="button"
                    className="btn btn-primary btn-full mt-4"
                    disabled={syncing || !status?.pythonAvailable}
                    onClick={() => void syncData()}
                  >
                    <RefreshCw size={16} className={syncing ? "spin" : undefined} />
                    {syncing ? "Syncing 1 year…" : "Sync hourly data (1 year)"}
                  </button>
                </>
              )}
            </section>

            <section className="card ml-trading-panel">
              <h2 className="ml-trading-panel-title">
                <Search size={18} />
                Today&apos;s match (week pattern)
              </h2>
              {!status?.libraryBuilt ? (
                <p className="text-muted">Sync hourly data first to build daily patterns.</p>
              ) : matching && !match ? (
                <p className="text-muted">Matching pattern…</p>
              ) : match ? (
                <>
                  <div className={cn("ml-trading-prediction", predictionClass)}>
                    {outcomeIcon(match.prediction)}
                    <div>
                      <strong className="capitalize">{match.prediction} day</strong>
                      <p className="text-sm text-muted">
                        {formatNumber(match.confidence * 100, 1)}% confidence · week {match.currentWeekId ?? "—"} · {match.sessionBars ?? match.compareBars} session bars
                      </p>
                    </div>
                  </div>
                  <div className="ml-trading-prob-bars">
                    <div className="ml-trading-prob-row">
                      <span>Bullish</span>
                      <div className="ml-trading-prob-track"><div className="ml-trading-prob-fill ml-trading-prob-fill--up" style={{ width: `${match.probabilities.bullish * 100}%` }} /></div>
                      <span>{formatNumber(match.probabilities.bullish * 100, 1)}%</span>
                    </div>
                    <div className="ml-trading-prob-row">
                      <span>Bearish</span>
                      <div className="ml-trading-prob-track"><div className="ml-trading-prob-fill ml-trading-prob-fill--down" style={{ width: `${match.probabilities.bearish * 100}%` }} /></div>
                      <span>{formatNumber(match.probabilities.bearish * 100, 1)}%</span>
                    </div>
                    <div className="ml-trading-prob-row">
                      <span>Neutral</span>
                      <div className="ml-trading-prob-track"><div className="ml-trading-prob-fill ml-trading-prob-fill--flat" style={{ width: `${match.probabilities.neutral * 100}%` }} /></div>
                      <span>{formatNumber(match.probabilities.neutral * 100, 1)}%</span>
                    </div>
                  </div>
                  <dl className="ml-trading-stats mt-4">
                    <div><dt>Today</dt><dd>{formatDateLabel(match.currentDate)}</dd></div>
                    <div><dt>Expected day move</dt><dd className={match.expectedDayReturnPct >= 0 ? "text-up" : "text-down"}>{formatPct(match.expectedDayReturnPct)}</dd></div>
                    <div><dt>Expected rest of day</dt><dd className={match.expectedRestOfDayReturnPct >= 0 ? "text-up" : "text-down"}>{formatPct(match.expectedRestOfDayReturnPct)}</dd></div>
                    <div><dt>Week days</dt><dd>{match.weekDaysIncluded?.join(", ") ?? "—"}</dd></div>
                    <div><dt>Week open</dt><dd>{match.weekOpen ? formatNumber(match.weekOpen, 2) : "—"}</dd></div>
                  </dl>
                  {match.todayOptionTrade && (
                    <div className="mt-4">
                      <OptionTradePanel
                        trade={match.todayOptionTrade}
                        title={`Today's trade · enter 9:15 · exit 3:15${match.todayOptionTrade.isProjection ? " (projected)" : ""}`}
                      />
                      {match.avgHistoricalNetPnl != null && (
                        <p className="text-muted text-sm mt-2">
                          Avg net P/L on similar historical days:{" "}
                          <span className={match.avgHistoricalNetPnl >= 0 ? "text-up" : "text-down"}>
                            {formatInr(match.avgHistoricalNetPnl, true)}
                          </span>{" "}
                          per lot
                        </p>
                      )}
                    </div>
                  )}
                  {match.optionTradesError && (
                    <p className="text-muted text-sm mt-2">{match.optionTradesError}</p>
                  )}
                  <button type="button" className="btn btn-outline btn-full mt-4" disabled={matching} onClick={() => void runMatch()}>
                    <RefreshCw size={16} className={matching ? "spin" : undefined} />
                    Refresh match
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => void runMatch()}>Run pattern match</button>
              )}
            </section>
          </div>

          {match && (
            <>
              {match.hourPredictions && match.hourPredictions.length > 0 && (
                <section className="card mb-6">
                  <h2 className="ml-trading-panel-title">
                    <Calendar size={18} />
                    Today — all hours (actual + predicted)
                  </h2>
                  <p className="text-muted text-sm mb-3">
                    {formatDateLabel(match.currentDate)} · Week pattern match drives predicted hours after {match.compareThrough}.
                    Expected full day {formatPct(match.expectedDayReturnPct)} · rest of day {formatPct(match.expectedRestOfDayReturnPct)}.
                  </p>
                  <HourPredictionTable rows={match.hourPredictions} />
                </section>
              )}

              {match.weekMatches && match.weekMatches.length > 0 && (
                <section className="mb-6">
                  <h2 className="ml-trading-section-title">Closest historical weeks</h2>
                  <p className="text-muted text-sm mb-4">
                    Weeks with a similar Mon→today hourly shape. Each analog date is the same weekday as today.
                  </p>
                  <div className="ml-trading-match-list">
                    {match.weekMatches.map((item, index) => (
                      <WeekMatchCard
                        key={item.weekId}
                        match={item}
                        rank={index + 1}
                        optionTrade={match.weekOptionTrades?.[item.todayAnalogDate]}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="card mb-6">
                <h2 className="ml-trading-panel-title">
                  <Calendar size={18} />
                  Current day — full hourly pattern
                </h2>
                <p className="text-muted text-sm mb-3">
                  {formatDateLabel(match.currentDate)} · O {formatNumber(match.currentPattern.dayOpen, 2)} · H {formatNumber(match.currentPattern.dayHigh, 2)} · L {formatNumber(match.currentPattern.dayLow, 2)} · C {formatNumber(match.currentPattern.dayClose, 2)} ·{" "}
                  <span className={match.currentPattern.dayReturnPct >= 0 ? "text-up" : "text-down"}>
                    {formatPct(match.currentPattern.dayReturnPct)}
                  </span>
                </p>
                <p className="text-muted text-sm mb-3">
                  {match.actualBarsToday ?? match.currentPattern.fullDayBarCount} actual bars · full-session match uses {match.sessionBars ?? match.compareBars} bars (actual + predicted where needed)
                </p>
                <HourTable
                  slots={resolveFullDaySlots(match.currentPattern.fullDaySlots, match.currentPattern.slots)}
                  matchedBars={match.sessionBars ?? match.compareBars}
                  showPct
                />
              </section>

              <section className="mb-6">
                <h2 className="ml-trading-section-title">Same-day historical matches (reference)</h2>
                <p className="text-muted text-sm mb-4">
                  Single-day shape matches for comparison — primary prediction uses the week pattern above.
                </p>
                <div className="ml-trading-match-list">
                  {match.matches.map((item, index) => (
                    <MatchCard
                      key={item.date}
                      match={item}
                      rank={index + 1}
                      compareBars={match.sessionBars ?? match.compareBars}
                      optionTrade={match.dayOptionTrades?.[item.date]}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </DashboardShell>
  );
}
