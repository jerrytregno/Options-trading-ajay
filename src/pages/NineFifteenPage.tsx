import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Clock,
  Minus,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { NineSixteenAutoTrader } from "@/components/trade/NineSixteenAutoTrader";
import { useKite } from "@/contexts/kite-context";
import {
  NINE_FIFTEEN_RUPEE_LEVELS,
  type NineFifteenCePeStrategyStats,
  type NineFifteenCandlesResult,
  type NineFifteenRupeLevel,
} from "@/types/nine-fifteen";
import { cn, formatNumber } from "@/lib/utils";
import "@/styles/nine-fifteen-page.css";

function DirectionBadge({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") {
    return (
      <span className="nf-direction nf-direction--up">
        <ArrowUpRight size={14} />
        Up
      </span>
    );
  }
  if (direction === "down") {
    return (
      <span className="nf-direction nf-direction--down">
        <ArrowDownRight size={14} />
        Down
      </span>
    );
  }
  return (
    <span className="nf-direction nf-direction--flat">
      <Minus size={14} />
      Flat
    </span>
  );
}

function ThresholdCell({ hit, kind }: { hit: boolean; kind: "gain" | "loss" }) {
  return (
    <td
      className={cn(
        "nf-threshold-cell text-center",
        hit && kind === "gain" && "nf-threshold-cell--gain",
        hit && kind === "loss" && "nf-threshold-cell--loss",
      )}
    >
      {hit ? <Check size={14} aria-label="Hit" /> : <span className="nf-threshold-miss">—</span>}
    </td>
  );
}

function StrategyRow({
  stats,
  highlight,
}: {
  stats: NineFifteenCePeStrategyStats;
  highlight?: boolean;
}) {
  const targetLabel =
    stats.side === "CE" ? "+₹50 from open" : stats.side === "PE" ? "−₹50 from open" : "±₹50 from open";
  const sideClass =
    stats.side === "CE"
      ? "nf-side-tag--ce"
      : stats.side === "PE"
        ? "nf-side-tag--pe"
        : "nf-side-tag--mixed";
  return (
    <tr className={cn(highlight && "nf-strategy-row--best")}>
      <td>
        {stats.side !== "MIXED" && (
          <span className={cn("nf-side-tag", sideClass)}>{stats.side}</span>
        )}{" "}
        {stats.label}
      </td>
      <td className="text-right">{stats.sampleDays}</td>
      <td className="text-right">{stats.tradeDays}</td>
      <td className="text-right">
        {stats.targetHits} · {formatNumber(stats.targetHitPct, 1)}%
      </td>
      <td className="text-muted text-sm">{targetLabel}</td>
    </tr>
  );
}

export default function NineFifteenPage() {
  const { connected, loginUrl } = useKite();
  const [data, setData] = useState<NineFifteenCandlesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = refresh ? "?days=365&refresh=1" : "?days=365";
      const res = await fetch(`/api/kite/nine-fifteen-candles${qs}`, { credentials: "include" });
      const json = (await res.json()) as { data?: NineFifteenCandlesResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to load 9:15 candles");
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void load(false);
  }, [connected, load]);

  return (
    <DashboardShell>
      <div className="nine-fifteen-page">
        <header className="page-header nf-header">
          <div>
            <h1 className="page-title">
              <Clock size={22} />
              9:15 Candle
            </h1>
            <p className="page-subtitle">
              Nifty 50 · last 1 year · 9:15 open reference · 1-min bar + full session (9:15 → 3:30)
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!connected || loading}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            Refresh
          </button>
        </header>

        {!connected && (
          <div className="card nf-banner">
            <AlertTriangle size={18} />
            <div>
              <p className="font-medium">Connect Zerodha Kite to load historical candles</p>
              {loginUrl && (
                <a href={loginUrl} className="btn btn-primary btn-sm" style={{ marginTop: "0.5rem" }}>
                  Connect Kite
                </a>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="card nf-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        {connected && <NineSixteenAutoTrader connected={connected} />}

        {loading && !data && (
          <div className="card nf-loading">
            <RefreshCw size={18} className="spin" />
            Loading full session history from Zerodha (about 1–2 min)…
          </div>
        )}

        {data && (
          <>
            <div className="nf-summary-grid">
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Trading days</span>
                <span className="nf-summary-value">{data.summary.total}</span>
                <span className="nf-summary-hint">
                  {data.fromDate} → {data.toDate}
                </span>
              </div>
              <div className="card nf-summary-card nf-summary-card--up">
                <span className="nf-summary-label">
                  <TrendingUp size={14} /> Close up
                </span>
                <span className="nf-summary-value">{data.summary.up}</span>
                <span className="nf-summary-hint">{formatNumber(data.summary.upPct, 1)}%</span>
              </div>
              <div className="card nf-summary-card nf-summary-card--down">
                <span className="nf-summary-label">
                  <ArrowDownRight size={14} /> Close down
                </span>
                <span className="nf-summary-value">{data.summary.down}</span>
                <span className="nf-summary-hint">{formatNumber(data.summary.downPct, 1)}%</span>
              </div>
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Flat close</span>
                <span className="nf-summary-value">{data.summary.flat}</span>
                <span className="nf-summary-hint">{data.instrument}</span>
              </div>
            </div>

            {(() => {
              const day50 = data.summary.dayUpLevels.find((x) => x.level === 50);
              const day50Down = data.summary.dayDownLevels.find((x) => x.level === 50);
              return (
                <div className="nf-day-hero-grid">
                  <div className="card nf-day-hero nf-day-hero--up">
                    <span className="nf-day-hero-label">Buy CE · exit when Nifty +₹50 from 9:15 open</span>
                    <span className="nf-day-hero-value">
                      {day50?.hitCount ?? 0}
                      <span className="nf-day-hero-of"> / {data.summary.total} days</span>
                    </span>
                    <span className="nf-day-hero-hint">
                      {formatNumber(day50?.hitPct ?? 0, 1)}% of sessions touched 9:15 open + ₹50
                    </span>
                  </div>
                  <div className="card nf-day-hero nf-day-hero--down">
                    <span className="nf-day-hero-label">Buy PE · exit when Nifty −₹50 from 9:15 open</span>
                    <span className="nf-day-hero-value">
                      {day50Down?.hitCount ?? 0}
                      <span className="nf-day-hero-of"> / {data.summary.total} days</span>
                    </span>
                    <span className="nf-day-hero-hint">
                      {formatNumber(day50Down?.hitPct ?? 0, 1)}% touched 9:15 open − ₹50
                    </span>
                  </div>
                </div>
              );
            })()}

            {data.cePeGuide && (
              <div className="nf-cepe-section">
                {data.cePeGuide.todaySignal && (
                  <div
                    className={cn(
                      "card nf-today-signal",
                      data.cePeGuide.todaySignal.side === "CE" && "nf-today-signal--ce",
                      data.cePeGuide.todaySignal.side === "PE" && "nf-today-signal--pe",
                    )}
                  >
                    <span className="nf-today-signal-label">Today ({data.cePeGuide.todaySignal.date})</span>
                    <span className="nf-today-signal-side">
                      {data.cePeGuide.todaySignal.side === "WAIT" ? (
                        "Wait — flat 9:15 bar"
                      ) : (
                        <>
                          Buy <strong>{data.cePeGuide.todaySignal.side}</strong> at 9:16
                        </>
                      )}
                    </span>
                    <span className="nf-today-signal-note">
                      <DirectionBadge direction={data.cePeGuide.todaySignal.minuteDirection} />{" "}
                      {data.cePeGuide.todaySignal.note}
                    </span>
                  </div>
                )}

                <div className="card nf-cepe-guide">
                  <h2 className="card-title">CE or PE at 9:15?</h2>
                  <p className="nf-cepe-rule">{data.cePeGuide.entryRule}</p>
                  <p className="nf-cepe-steps text-muted">
                    <strong>Steps:</strong> (1) Wait until 9:15:59 for the 1-min bar to close. (2) Read open vs
                    close — green bar → momentum up, red bar → momentum down. (3) Match option side: UP → CE,
                    DOWN → PE. (4) Target is Nifty ±50 index points from 9:15 open, not +₹50 option premium.
                    All rows use the same <strong>{data.summary.total} trading days</strong> sample;{" "}
                    <strong>Trades</strong> is how many days that rule actually fires (flat days skipped for
                    directional rules).
                  </p>

                  <div className="nf-strategy-table-wrap">
                    <table className="nf-strategy-table">
                      <thead>
                        <tr>
                          <th>Rule (backtested)</th>
                          <th className="text-right">Trading days</th>
                          <th className="text-right">Trades</th>
                          <th className="text-right">Hit ±₹50 target</th>
                          <th>Target</th>
                        </tr>
                      </thead>
                      <tbody>
                        <StrategyRow stats={data.cePeGuide.followDirection} />
                        <StrategyRow stats={data.cePeGuide.minuteUpBuyCall} />
                        <StrategyRow stats={data.cePeGuide.minuteDownBuyPut} />
                        <StrategyRow stats={data.cePeGuide.alwaysCall} />
                        <StrategyRow stats={data.cePeGuide.alwaysPut} />
                        <StrategyRow stats={data.cePeGuide.minuteUpBuyPut} />
                        <StrategyRow stats={data.cePeGuide.minuteDownBuyCall} />
                        <StrategyRow stats={data.cePeGuide.bestStrategy} highlight />
                      </tbody>
                    </table>
                  </div>
                  <p className="nf-cepe-footnote text-muted">
                    Best rule in sample: <strong>{data.cePeGuide.bestStrategy.label}</strong> —{" "}
                    {formatNumber(data.cePeGuide.bestStrategy.targetHitPct, 1)}% win rate when traded (
                    {data.cePeGuide.bestStrategy.targetHits}/{data.cePeGuide.bestStrategy.tradeDays} trades over{" "}
                    {data.cePeGuide.bestStrategy.sampleDays} trading days).
                  </p>
                </div>
              </div>
            )}

            <div className="nf-level-summary-grid">
              <div className="card nf-level-summary">
                <h3 className="nf-level-summary-title text-up">1-min bar (9:15:00–9:15:59)</h3>
                <p className="nf-level-summary-note text-muted">High / low vs 9:15 open in first minute only</p>
                <div className="nf-level-summary-row">
                  {data.summary.gainLevels.map(({ level, hitCount, hitPct }) => (
                    <div key={`gain-${level}`} className="nf-level-pill nf-level-pill--up">
                      <span>+₹{level}</span>
                      <strong>
                        {hitCount} · {formatNumber(hitPct, 1)}%
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card nf-level-summary">
                <h3 className="nf-level-summary-title text-down">&nbsp;</h3>
                <p className="nf-level-summary-note text-muted">&nbsp;</p>
                <div className="nf-level-summary-row">
                  {data.summary.lossLevels.map(({ level, hitCount, hitPct }) => (
                    <div key={`loss-${level}`} className="nf-level-pill nf-level-pill--down">
                      <span>−₹{level}</span>
                      <strong>
                        {hitCount} · {formatNumber(hitPct, 1)}%
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="nf-level-summary-grid">
              <div className="card nf-level-summary">
                <h3 className="nf-level-summary-title text-up">Full day from 9:15 open → 3:30 PM</h3>
                <p className="nf-level-summary-note text-muted">
                  Session high vs 9:15 open — e.g. buy ATM CE at 9:15, hold until Nifty +₹50
                </p>
                <div className="nf-level-summary-row">
                  {data.summary.dayUpLevels.map(({ level, hitCount, hitPct }) => (
                    <div
                      key={`day-up-${level}`}
                      className={cn("nf-level-pill nf-level-pill--up", level === 50 && "nf-level-pill--highlight")}
                    >
                      <span>+₹{level}</span>
                      <strong>
                        {hitCount} · {formatNumber(hitPct, 1)}%
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card nf-level-summary">
                <h3 className="nf-level-summary-title text-down">Full day from 9:15 open → 3:30 PM</h3>
                <p className="nf-level-summary-note text-muted">
                  Session low vs 9:15 open — buy ATM PE, hold until Nifty −₹50
                </p>
                <div className="nf-level-summary-row">
                  {data.summary.dayDownLevels.map(({ level, hitCount, hitPct }) => (
                    <div
                      key={`day-down-${level}`}
                      className={cn("nf-level-pill nf-level-pill--down", level === 50 && "nf-level-pill--highlight")}
                    >
                      <span>−₹{level}</span>
                      <strong>
                        {hitCount} · {formatNumber(hitPct, 1)}%
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="card nf-table-card">
              <div className="nf-table-head">
                <h2 className="card-title">Daily breakdown</h2>
                <span className="text-muted text-sm">{data.rows.length} rows · ✓ = Nifty touched level</span>
              </div>
              <div className="nf-table-wrap">
                <table className="nf-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Date</th>
                      <th rowSpan={2} className="text-right">
                        9:15 open
                      </th>
                      <th rowSpan={2} className="text-right">
                        Day high
                      </th>
                      <th rowSpan={2} className="text-right">
                        Day low
                      </th>
                      <th rowSpan={2} className="text-right">
                        Day ↑ max
                      </th>
                      <th rowSpan={2} className="text-right">
                        Day ↓ max
                      </th>
                      <th rowSpan={2} className="text-right">
                        1m close Δ
                      </th>
                      <th rowSpan={2}>1m close</th>
                      <th colSpan={NINE_FIFTEEN_RUPEE_LEVELS.length} className="nf-th-group nf-th-group--up">
                        1-min bar (+)
                      </th>
                      <th colSpan={NINE_FIFTEEN_RUPEE_LEVELS.length} className="nf-th-group nf-th-group--down">
                        1-min bar (−)
                      </th>
                      <th colSpan={NINE_FIFTEEN_RUPEE_LEVELS.length} className="nf-th-group nf-th-group--up nf-th-group--day">
                        Full day CE (+)
                      </th>
                      <th colSpan={NINE_FIFTEEN_RUPEE_LEVELS.length} className="nf-th-group nf-th-group--down nf-th-group--day">
                        Full day PE (−)
                      </th>
                    </tr>
                    <tr>
                      {NINE_FIFTEEN_RUPEE_LEVELS.map((level) => (
                        <th key={`gh-${level}`} className="nf-th-level nf-th-level--up">
                          +{level}
                        </th>
                      ))}
                      {NINE_FIFTEEN_RUPEE_LEVELS.map((level) => (
                        <th key={`lh-${level}`} className="nf-th-level nf-th-level--down">
                          −{level}
                        </th>
                      ))}
                      {NINE_FIFTEEN_RUPEE_LEVELS.map((level) => (
                        <th
                          key={`du-${level}`}
                          className={cn("nf-th-level nf-th-level--up", level === 50 && "nf-th-level--highlight")}
                        >
                          +{level}
                        </th>
                      ))}
                      {NINE_FIFTEEN_RUPEE_LEVELS.map((level) => (
                        <th
                          key={`dd-${level}`}
                          className={cn("nf-th-level nf-th-level--down", level === 50 && "nf-th-level--highlight")}
                        >
                          −{level}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td className="text-right font-mono">₹{formatNumber(row.open, 2)}</td>
                        <td className="text-right font-mono">₹{formatNumber(row.sessionHigh, 2)}</td>
                        <td className="text-right font-mono">₹{formatNumber(row.sessionLow, 2)}</td>
                        <td className="text-right font-mono text-up">
                          +{formatNumber(row.maxDayUpFrom915, 2)}
                        </td>
                        <td className="text-right font-mono text-down">
                          −{formatNumber(row.maxDayDownFrom915, 2)}
                        </td>
                        <td
                          className={cn(
                            "text-right font-mono",
                            row.change > 0 ? "text-up" : row.change < 0 ? "text-down" : "",
                          )}
                        >
                          {row.change >= 0 ? "+" : ""}
                          {formatNumber(row.change, 2)}
                        </td>
                        <td>
                          <DirectionBadge direction={row.direction} />
                        </td>
                        {NINE_FIFTEEN_RUPEE_LEVELS.map((level: NineFifteenRupeLevel) => (
                          <ThresholdCell
                            key={`${row.date}-g-${level}`}
                            hit={row.gainLevels[level]}
                            kind="gain"
                          />
                        ))}
                        {NINE_FIFTEEN_RUPEE_LEVELS.map((level: NineFifteenRupeLevel) => (
                          <ThresholdCell
                            key={`${row.date}-l-${level}`}
                            hit={row.lossLevels[level]}
                            kind="loss"
                          />
                        ))}
                        {NINE_FIFTEEN_RUPEE_LEVELS.map((level: NineFifteenRupeLevel) => (
                          <ThresholdCell
                            key={`${row.date}-du-${level}`}
                            hit={row.dayUpLevels[level]}
                            kind="gain"
                          />
                        ))}
                        {NINE_FIFTEEN_RUPEE_LEVELS.map((level: NineFifteenRupeLevel) => (
                          <ThresholdCell
                            key={`${row.date}-dd-${level}`}
                            hit={row.dayDownLevels[level]}
                            kind="loss"
                          />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </DashboardShell>
  );
}
