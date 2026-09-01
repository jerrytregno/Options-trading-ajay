import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Crosshair, RefreshCw, Trophy } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { cn } from "@/lib/utils";
import type {
  TrapsBacktestBucket,
  TrapsBacktestResult,
  TrapsBacktestStats,
  TrapsBacktestTrade,
} from "@/types/traps-backtest";
import { buildTrapsBacktestView } from "@/lib/traps-backtest-view";
import { TrapsRsiAnalysisSection } from "@/components/traps/TrapsRsiAnalysis";
import "@/styles/traps-backtest-page.css";

const IST = "Asia/Kolkata";
const DEFAULT_CAPITAL = 200_000;
const DEFAULT_MAX_LOTS = 25;
const DEFAULT_STANDARD_STOP_PCT = 4;
const MIN_STANDARD_STOP_PCT = 1;
const MAX_STANDARD_STOP_PCT = 6;

export interface TrapsBacktestRunnerProps {
  apiPath: string;
  title: string;
  subtitle: string;
  /** Shown in the notes when this variant differs from live Traps (backtest-only). */
  backtestOnlyNote?: string;
}

function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function lastWednesdayToFriday(now = new Date()): { from: string; to: string } {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "long" }).format(now);
  const order = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayIndex = order.indexOf(name);
  let backToFriday = (todayIndex - 5 + 7) % 7;
  if (backToFriday === 0 && todayIndex === 5) backToFriday = 7;
  const friday = new Date(now.getTime() - backToFriday * 86_400_000);
  const wednesday = new Date(friday.getTime() - 2 * 86_400_000);
  return { from: istDateKey(wednesday), to: istDateKey(friday) };
}

const inr = (value: number, digits = 0) =>
  `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;

const signClass = (value: number) => (value > 0 ? "tbt-pos" : value < 0 ? "tbt-neg" : "");

function rsiClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value >= 70) return "tbt-pos";
  if (value <= 30) return "tbt-neg";
  return "";
}

function formatRsi(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? value.toFixed(1) : "—";
}

const OUTCOME_LABEL: Record<string, string> = {
  "trail-stop": "Ladder stop",
  stop: "Initial stop",
  target: "Target",
  eod: "Time exit",
};

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="tbt-stat">
      <p className="tbt-stat-label">{label}</p>
      <p className={cn("tbt-stat-value", tone)}>{value}</p>
      {hint && <p className="tbt-stat-hint">{hint}</p>}
    </div>
  );
}

function StatsRow({ name, stats }: { name: string; stats: TrapsBacktestStats }) {
  return (
    <tr>
      <td className="tbt-strong">{name}</td>
      <td>{stats.trades}</td>
      <td className="tbt-pos">{stats.wins}</td>
      <td className="tbt-neg">{stats.losses}</td>
      <td>{stats.winRatePct}%</td>
      <td className={signClass(stats.netPnl)}>{inr(stats.netPnl)}</td>
    </tr>
  );
}

function BucketBars({
  buckets,
  bestLabel,
}: {
  buckets: TrapsBacktestBucket[];
  bestLabel: string | null;
}) {
  const peak = Math.max(1, ...buckets.map((b) => Math.abs(b.stats.netPnl)));

  return (
    <div className="tbt-buckets">
      {buckets.map((bucket) => {
        const net = bucket.stats.netPnl;
        const width = (Math.abs(net) / peak) * 100;
        return (
          <div
            key={bucket.label}
            className={cn("tbt-bucket", bucket.label === bestLabel && "tbt-bucket--best")}
          >
            <span className="tbt-bucket-time">{bucket.label}</span>
            <div className="tbt-bucket-track">
              <div className="tbt-bucket-half tbt-bucket-half--neg">
                {net < 0 && <div className="tbt-bucket-fill tbt-bucket-fill--neg" style={{ width: `${width}%` }} />}
              </div>
              <div className="tbt-bucket-half tbt-bucket-half--pos">
                {net > 0 && <div className="tbt-bucket-fill tbt-bucket-fill--pos" style={{ width: `${width}%` }} />}
              </div>
            </div>
            <span className={cn("tbt-bucket-net", signClass(net))}>{inr(net)}</span>
            <span className="tbt-bucket-meta">
              {bucket.stats.trades}T · {bucket.stats.wins}W/{bucket.stats.losses}L
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TradeRow({ trade }: { trade: TrapsBacktestTrade }) {
  return (
    <tr>
      <td>{trade.date.slice(5)}</td>
      <td>
        {trade.entryTimeIst}
        <span className="tbt-muted"> → {trade.exitTimeIst}</span>
      </td>
      <td>
        <span className={cn("tbt-side", trade.side === "CE" ? "tbt-side--ce" : "tbt-side--pe")}>
          {trade.side}
        </span>
      </td>
      <td className="tbt-mono">{trade.tradingsymbol}</td>
      <td className="tbt-mono">{trade.entryPremium.toFixed(2)}</td>
      <td className="tbt-mono">{trade.exitPremium.toFixed(2)}</td>
      <td className={cn("tbt-mono", signClass(trade.pnlPct))}>{trade.pnlPct.toFixed(2)}%</td>
      <td className={cn("tbt-mono", rsiClass(trade.signalRsi))}>{formatRsi(trade.signalRsi)}</td>
      <td className="tbt-mono">{trade.lots}</td>
      <td className={cn("tbt-mono tbt-strong", signClass(trade.netPnl))}>{inr(trade.netPnl)}</td>
      <td>
        <span className="tbt-tag">{OUTCOME_LABEL[trade.outcome] ?? trade.outcome}</span>
      </td>
      <td>
        <span className={cn("tbt-tag", trade.exitProfile === "opening" && "tbt-tag--opening")}>
          {trade.exitProfile === "opening" ? "Opening" : "Standard"}
        </span>
      </td>
    </tr>
  );
}

export function TrapsBacktestRunner({ apiPath, title, subtitle, backtestOnlyNote }: TrapsBacktestRunnerProps) {
  const defaults = useMemo(() => lastWednesdayToFriday(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [capital, setCapital] = useState(DEFAULT_CAPITAL);
  const [maxLots, setMaxLots] = useState(DEFAULT_MAX_LOTS);
  const [standardStopPct, setStandardStopPct] = useState(DEFAULT_STANDARD_STOP_PCT);
  const [rsiFilter, setRsiFilter] = useState(false);
  const [data, setData] = useState<TrapsBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          from,
          to,
          capital: String(capital),
          lots: String(maxLots),
          stop: String(standardStopPct),
        });
        if (rsiFilter) params.set("rsiFilter", "1");
        if (refresh) params.set("refresh", "1");
        const res = await fetch(`${apiPath}?${params}`, { credentials: "include" });
        const json = (await res.json().catch(() => null)) as
          | { data?: TrapsBacktestResult; error?: string }
          | null;
        if (!res.ok || !json?.data) {
          throw new Error(json?.error ?? `Request failed (${res.status})`);
        }
        setData(json.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to run the backtest");
      } finally {
        setLoading(false);
      }
    },
    [apiPath, from, to, capital, maxLots, standardStopPct, rsiFilter],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = useMemo(
    () => (data ? buildTrapsBacktestView(data) : null),
    [data],
  );
  const overall = view?.overall;
  const rsiSkipCount = useMemo(
    () =>
      data?.days.reduce(
        (sum, day) => sum + day.skips.filter((skip) => skip.reason === "rsi-filter").length,
        0,
      ) ?? 0,
    [data],
  );

  return (
    <DashboardShell>
      <div className="tbt-page">
        <header className="tbt-header">
          <div>
            <h1 className="tbt-title">{title}</h1>
            <p className="tbt-subtitle">{subtitle}</p>
          </div>
          <button className="btn btn-sm" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={15} className={loading ? "tbt-spin" : undefined} />
            {loading ? "Running…" : "Re-run"}
          </button>
        </header>

        <div className="tbt-controls card">
          <label className="tbt-field">
            <span>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="tbt-field">
            <span>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="tbt-field">
            <span>Capital</span>
            <input
              type="number"
              min={10000}
              step={10000}
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value) || DEFAULT_CAPITAL)}
            />
          </label>
          <label className="tbt-field">
            <span>Max lots</span>
            <input
              type="number"
              min={1}
              max={25}
              value={maxLots}
              onChange={(e) => setMaxLots(Number(e.target.value) || DEFAULT_MAX_LOTS)}
            />
          </label>
          <label className="tbt-field tbt-field--slider">
            <span>
              Standard stop <strong className="tbt-stop-value">−{standardStopPct}%</strong>
            </span>
            <input
              type="range"
              min={MIN_STANDARD_STOP_PCT}
              max={MAX_STANDARD_STOP_PCT}
              step={1}
              value={standardStopPct}
              onChange={(e) => setStandardStopPct(Number(e.target.value) || DEFAULT_STANDARD_STOP_PCT)}
              aria-label="Standard profile initial stop loss percent"
            />
            <span className="tbt-slider-hint">
              {MIN_STANDARD_STOP_PCT}% to {MAX_STANDARD_STOP_PCT}% · opening window keeps −
              {data?.rules.openingStopPct ?? 10}%
            </span>
          </label>
          <label className="tbt-filter-toggle">
            <input
              type="checkbox"
              checked={rsiFilter}
              onChange={(e) => setRsiFilter(e.target.checked)}
            />
            RSI filter (live bands)
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => void load(true)} disabled={loading}>
            Run backtest
          </button>
        </div>

        {error && (
          <div className="tbt-error card">
            <AlertTriangle size={16} />
            <div>
              <p className="tbt-strong">{error}</p>
              <p className="tbt-muted">
                Option history comes straight from Kite, so this page needs a connected Zerodha
                session on a whitelisted IP.
              </p>
            </div>
          </div>
        )}

        {loading && !data && (
          <div className="tbt-loading card">
            <div className="spinner" />
            <p>Pulling Nifty and ATM option candles from Zerodha…</p>
          </div>
        )}

        {data && overall && view && (
          <>
            {data.rules.rsiFilter && (
              <div className="tbt-filter-banner card">
                <strong>RSI filter on</strong> — only trades whose signal-candle Wilder RSI(
                {data.rules.rsiPeriod}) is in <strong>{data.rules.rsiAllowedBucketsIst}</strong> are
                included. Setups outside those bands are skipped.
                {rsiSkipCount > 0 ? (
                  <>
                    {" "}
                    <span className="tbt-filter-tag">{rsiSkipCount} skipped</span>
                  </>
                ) : (
                  " No setups were blocked in this range."
                )}
              </div>
            )}

            <section className="tbt-stat-grid">
              <StatCard
                label="Net P&L"
                value={inr(overall.netPnl)}
                hint={`after ${inr(overall.charges)} charges`}
                tone={signClass(overall.netPnl)}
              />
              <StatCard
                label="Trades"
                value={String(overall.trades)}
                hint={`${data.days.filter((d) => !d.error).length} sessions · range > ${data.rules.minBodyPts} pt · SL −${data.rules.standardStopPct}%${data.rules.rsiFilter ? " · RSI filter" : ""}`}
              />
              <StatCard
                label="Wins / Losses"
                value={`${overall.wins} / ${overall.losses}`}
                hint={`${overall.winRatePct}% win rate`}
              />
              <StatCard
                label="Avg win / loss"
                value={`${inr(overall.avgWin)} / ${inr(overall.avgLoss)}`}
                hint={overall.profitFactor != null ? `profit factor ${overall.profitFactor}` : "no losers"}
              />
              <StatCard
                label="Best / worst trade"
                value={`${inr(overall.largestWin)} / ${inr(overall.largestLoss)}`}
                hint={`max drawdown ${inr(overall.maxDrawdown)}`}
              />
              <StatCard
                label="Avg hold"
                value={`${overall.avgHoldMinutes} min`}
                hint={`streaks +${overall.maxWinStreak} / −${overall.maxLossStreak}`}
              />
            </section>

            {view.bestBucket && (
              <section className="tbt-highlight card">
                <Trophy size={18} />
                <div>
                  <p className="tbt-strong">
                    Best window: {view.bestBucket.label}–
                    {`${String(Math.floor(view.bestBucket.endMins / 60)).padStart(2, "0")}:${String(
                      view.bestBucket.endMins % 60,
                    ).padStart(2, "0")}`}
                  </p>
                  <p className="tbt-muted">
                    {view.bestBucket.stats.trades} trades, {view.bestBucket.stats.wins}W/
                    {view.bestBucket.stats.losses}L, {view.bestBucket.stats.winRatePct}% win rate,{" "}
                    <strong className={signClass(view.bestBucket.stats.netPnl)}>
                      {inr(view.bestBucket.stats.netPnl)}
                    </strong>{" "}
                    net.
                  </p>
                </div>
              </section>
            )}

            <section className="card tbt-section">
              <h2 className="tbt-section-title">
                <Crosshair size={16} /> Net P&L by entry time (15-min buckets)
              </h2>
              {view.buckets.length > 0 ? (
                <BucketBars buckets={view.buckets} bestLabel={view.bestBucket?.label ?? null} />
              ) : (
                <p className="tbt-muted">No trades in the range.</p>
              )}
            </section>

            <TrapsRsiAnalysisSection trades={view.trades} />

            <section className="tbt-split">
              <div className="card tbt-section">
                <h2 className="tbt-section-title">
                  Per session
                </h2>
                <table className="tbt-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Signals</th>
                      <th>Gates</th>
                      <th>Trades</th>
                      <th>W/L</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.days.map((day) => (
                      <tr key={day.date}>
                        <td className="tbt-strong">
                          {day.date.slice(5)}
                          <span className="tbt-muted"> {day.weekday.slice(0, 3)}</span>
                        </td>
                        {day.error ? (
                          <td colSpan={5} className="tbt-neg">
                            {day.error}
                          </td>
                        ) : (
                          <>
                            <td>{day.signals}</td>
                            <td>{day.gatePasses}</td>
                            <td>{day.stats.trades}</td>
                            <td>
                              {day.stats.wins}/{day.stats.losses}
                            </td>
                            <td className={signClass(day.stats.netPnl)}>{inr(day.stats.netPnl)}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card tbt-section">
                <h2 className="tbt-section-title">
                  Breakdown
                </h2>
                <table className="tbt-table">
                  <thead>
                    <tr>
                      <th>Cut</th>
                      <th>Trades</th>
                      <th>W</th>
                      <th>L</th>
                      <th>Win%</th>
                      <th>Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.bySide.map((row) => (
                      <StatsRow key={row.side} name={row.side} stats={row.stats} />
                    ))}
                    {view.byProfile.map((row) => (
                      <StatsRow
                        key={row.profile}
                        name={row.profile === "opening" ? "09:15–09:20 ladder" : "Standard ladder"}
                        stats={row.stats}
                      />
                    ))}
                  </tbody>
                </table>

                <h3 className="tbt-subheading">How trades ended</h3>
                <ul className="tbt-outcomes">
                  {view.outcomes.map((row) => (
                    <li key={row.outcome}>
                      <span>{OUTCOME_LABEL[row.outcome] ?? row.outcome}</span>
                      <span className="tbt-muted">{row.count}</span>
                      <span className={signClass(row.netPnl)}>{inr(row.netPnl)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="card tbt-section">
              <h2 className="tbt-section-title">Every trade ({view.trades.length})</h2>
              <div className="tbt-table-scroll">
                <table className="tbt-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>In → Out</th>
                      <th>Side</th>
                      <th>Contract</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>P&L%</th>
                      <th>RSI</th>
                      <th>Lots</th>
                      <th>Net</th>
                      <th>Exit by</th>
                      <th>Ladder</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.trades.map((trade) => (
                      <TradeRow key={`${trade.date}-${trade.entryMins}-${trade.tradingsymbol}`} trade={trade} />
                    ))}
                  </tbody>
                </table>
              </div>
              {view.trades.length === 0 && (
                <p className="tbt-muted">No entries triggered in this range.</p>
              )}
            </section>

            <section className="card tbt-section tbt-notes">
              <h2 className="tbt-section-title">How close this is to real trading</h2>
              <ul>
                {backtestOnlyNote && (
                  <li>
                    <strong>Backtest-only change.</strong> {backtestOnlyNote}
                  </li>
                )}
                <li>
                  <strong>RSI at the signal close.</strong> Wilder RSI({data.rules.rsiPeriod}) on
                  Nifty 1-min closes from Zerodha, stamped on the signal candle for reference — not
                  the momentum candle the fill happens in. Blank when the session has not printed
                  enough bars yet.
                  {data.rules.rsiFilter ? (
                    <>
                      {" "}
                      <strong>Filter on:</strong> only RSI in {data.rules.rsiAllowedBucketsIst} at the
                      signal close.
                    </>
                  ) : (
                    <> Toggle RSI filter to replay live bands only (0–10, 40–50, 70–100).</>
                  )}
                </li>
                <li>
                  <strong>10-second gate on candle 2.</strong> Live Traps watches websocket ticks for
                  the first <strong>10 seconds</strong> of the minute after the signal. Nifty must reach{" "}
                  <strong>signal close ± {data.rules.openGapPts} pt</strong> in the signal direction;
                  if it does, the bot buys at market at second <strong>:11</strong>. This backtest only
                  has minute OHLC, so it credits the gate when the open clears the level or the bar&apos;s
                  high/low touched it — a stand-in for a tick in the opening seconds.
                </li>
                <li>
                  <strong>Real option prices.</strong> Every entry and exit uses the actual price bars
                  of the same ATM option the bot would have bought that day, on the expiry that was
                  live at the time. Nothing here is estimated from Nifty.
                </li>
                <li>
                  <strong>Minute prices, not live ticks.</strong> When the gate passes, the entry is
                  booked at the option&apos;s price at the start of that minute. The live bot waits until
                  :11 and crosses the spread, so real fills can differ slightly.
                </li>
                <li>
                  <strong>When the order is unclear, the worse price wins.</strong> A minute only
                  tells us its high and low, not which came first. This assumes the low came first, so
                  if a minute could have hit the stop, it does — even if it also hit a profit level.
                  That makes the results look worse than reality, on purpose.
                </li>
                <li>
                  <strong>The entry minute gets no credit for its high.</strong> The trade opens
                  halfway through that minute, and its high may have happened before we were in. The
                  first profit step is only {data.rules.standardArmPct}%, under a rupee on a ₹130
                  option, so counting that high would book a profit almost every single trade may
                  never have had. Only the low and the closing price of that minute count.
                </li>
                <li>
                  {data.rules.standardStopHoldMs > 0 ? (
                    <>
                      <strong>
                        The {data.rules.standardStopHoldMs / 1000}-second stop wait is an estimate.
                      </strong>{" "}
                      If a minute drops past the stop and comes back above it, the timer resets. If
                      it drops and never comes back, the trade exits. Anything that happens and
                      reverses inside one minute cannot be seen here.
                    </>
                  ) : (
                    <>
                      <strong>The stop does not wait.</strong> A minute that trades through −
                      {data.rules.standardStopPct}% at any point exits there, even if it closes back
                      above. Where the level sits inside the minute the fill is booked at the level
                      itself; where the whole minute gapped below it, at that minute&apos;s open.
                    </>
                  )}
                </li>
                <li>
                  <strong>All costs are already deducted.</strong> Net P&L is after brokerage, STT,
                  exchange fees, SEBI, stamp duty and GST. Extra slippage is not included.
                </li>
              </ul>
              {data.warnings.length > 0 && (
                <div className="tbt-warnings">
                  {data.warnings.map((warning) => (
                    <p key={warning}>
                      <AlertTriangle size={13} /> {warning}
                    </p>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </DashboardShell>
  );
}
