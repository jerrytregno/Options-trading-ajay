import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  BarChart3,
  Check,
  Clock,
  X,
  Minus,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import {
  BacktestIndexProvider,
  useBacktestIndex,
  shortWeekday,
} from "@/contexts/backtest-index-context";
import {
  BacktestSessionsProvider,
  useBacktestSessions,
} from "@/contexts/backtest-sessions-context";
import {
  NINE_FIFTEEN_TIME_CHECKPOINTS,
  NSE_SESSIONS_ONE_YEAR,
  type NineFifteenBreakoutStats,
  type NineFifteenCePeGuide,
  type NineFifteenCePeFailureTrade,
  type NineFifteenAltTargetAfterTime,
  type NineFifteenCePeStrategyStats,
  type NineFifteenCandlesResult,
  type NineFifteenFollowFilterStats,
  type NineFifteenMidBacktestStats,
  type NineFifteenMidSideTotals,
  type NineFifteenMidGrid,
  type NineFifteenMidGridCell,
  type NineFifteenMidSignalThreshold,
  type NineFifteenMidStopLevel,
  type NineFifteenMidTradeRow,
  type NineFifteenTuesdayTargetStats,
  type NineFifteenSmallBodySplitBuckets,
  SMALL_BODY_CE_MIN_INCLUSIVE,
  SMALL_BODY_PUT_MAX_INCLUSIVE,
} from "@/types/nine-fifteen";
import { cn, formatNumber } from "@/lib/utils";
import { formatWeekdayFromDateKey } from "@/lib/market-time";
import { buildWeekdayNineFifteenAverages, type WeekdayNineFifteenMetric } from "@/lib/weekday-nine-fifteen";
import {
  buildNineSixteenBodyBuckets,
  strategyTradesForBodyBuckets,
  trade915EntrySize,
} from "@/lib/nine-sixteen-body-buckets";
import {
  buildSmallBodyDirectionWinPointGrid,
  buildSmallBodyPointGrid,
  type SmallBodyPointGridCell,
} from "@/lib/small-body-point-grid";
import { LossTradesAccordion } from "@/components/nine-fifteen/LossTradesAccordion";
import { BreakoutTradesAccordion } from "@/components/nine-fifteen/BreakoutTradesAccordion";
import "@/styles/nine-fifteen-page.css";

const BACKTEST_HISTORY_DAYS = 365;

/** IST hour buckets for win hit times (9:16 through 15:30 session). */
const WIN_HIT_HOUR_BUCKETS: { hour: number; label: string }[] = [
  { hour: 9, label: "9 AM" },
  { hour: 10, label: "10 AM" },
  { hour: 11, label: "11 AM" },
  { hour: 12, label: "12 PM" },
  { hour: 13, label: "1 PM" },
  { hour: 14, label: "2 PM" },
  { hour: 15, label: "3 PM" },
];

function winTargetHitHourIst(trade: NineFifteenCePeFailureTrade): number | null {
  const raw = trade.targetHit?.timeIst ?? trade.targetHitAt;
  if (!raw) return null;
  const match = /^(\d{1,2}):/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) ? hour : null;
}

function buildWinCountsByHour(wins: NineFifteenCePeFailureTrade[]) {
  const counts = new Map<number, number>();
  let unmapped = 0;
  for (const w of wins) {
    const hour = winTargetHitHourIst(w);
    if (hour == null || hour < 9 || hour > 15) {
      unmapped += 1;
      continue;
    }
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return { buckets: WIN_HIT_HOUR_BUCKETS.map((b) => ({ ...b, count: counts.get(b.hour) ?? 0 })), unmapped };
}

function WinHourlyBreakdown({
  wins,
  targetPoints,
  hitRuleLabel,
}: {
  wins: NineFifteenCePeFailureTrade[];
  targetPoints: number;
  /** Override the “when entry ±N was first hit” phrase. */
  hitRuleLabel?: string;
}) {
  const { buckets, unmapped } = buildWinCountsByHour(wins);
  const total = wins.length;
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="nf-wins-hourly card">
      <h4 className="nf-wins-hourly-title">
        <Clock size={15} aria-hidden />
        Wins by hour (IST) — {hitRuleLabel ?? `when entry ±${targetPoints} was first hit`}
      </h4>
      <p className="text-muted nf-wins-hourly-hint">
        Minute-level Kite data: hit time is the <strong>start</strong> of the 1-min bar that touched the target (from
        9:16 through 3:30 PM, including the entry minute).
      </p>
      <div className="nf-wins-hourly-grid">
        {buckets.map((b) => (
          <div key={b.hour} className="nf-wins-hourly-cell">
            <span className="nf-wins-hourly-label">{b.label}</span>
            <div className="nf-wins-hourly-bar-wrap" title={`${b.count} win${b.count === 1 ? "" : "s"}`}>
              <div
                className="nf-wins-hourly-bar"
                style={{ width: `${(b.count / max) * 100}%` }}
              />
            </div>
            <span className="nf-wins-hourly-count font-mono">{b.count}</span>
          </div>
        ))}
      </div>
      <p className="text-muted nf-wins-hourly-foot">
        {total} profitable trade{total === 1 ? "" : "s"} total
        {unmapped > 0 ? ` · ${unmapped} without a mapped hit hour` : ""}.
      </p>
    </div>
  );
}

function WeekdayNineFifteenAverages({
  signalFloor,
  metric = "body",
  redOnlySignal = false,
  signalExclusive = false,
}: {
  signalFloor: number;
  metric?: WeekdayNineFifteenMetric;
  redOnlySignal?: boolean;
  signalExclusive?: boolean;
}) {
  const index = useBacktestIndex();
  const rows = useBacktestSessions();
  const buckets = useMemo(
    () =>
      buildWeekdayNineFifteenAverages(rows, signalFloor, {
        metric,
        redOnlySignal,
        signalExclusive,
      }),
    [rows, signalFloor, metric, redOnlySignal, signalExclusive],
  );

  const totalSessions = buckets.reduce((sum, b) => sum + b.sessions, 0);
  if (totalSessions === 0) return null;

  const max = Math.max(0.01, ...buckets.map((b) => b.avgAbsChange));
  const widest = buckets.reduce((a, b) => (b.avgAbsChange > a.avgAbsChange ? b : a));

  return (
    <div className="nf-weekday-avg card">
      <h4 className="nf-weekday-avg-title">
        <CalendarDays size={15} aria-hidden />
        Average 9:15 candle by weekday
      </h4>
      <p className="text-muted nf-weekday-avg-hint">
        Mean{" "}
        <strong>
          {metric === "range" ? "9:15 high − 9:15 low" : "|9:15 close − 9:15 open|"}
        </strong>{" "}
        in {index.shortLabel} points across <strong>all {totalSessions} sessions</strong> in the sample
        — every trading day, not only the days a trade was taken. <em>Signal</em> counts the days
        {redOnlySignal ? " with a red 9:15 candle whose " : " whose "}
        {metric === "range" ? "range" : "body"} cleared{" "}
        {signalExclusive ? ">" : "≥"} {signalFloor}.
      </p>
      <div className="nf-weekday-avg-grid">
        {buckets.map((b) => (
          <div key={b.weekday} className="nf-weekday-avg-cell">
            <span className="nf-weekday-avg-label">{b.weekday}</span>
            <div
              className="nf-weekday-avg-bar-wrap"
              title={`${b.weekday}: average body ${formatNumber(b.avgAbsChange, 2)} pts over ${b.sessions} sessions`}
            >
              <div
                className="nf-weekday-avg-bar"
                style={{ width: `${(b.avgAbsChange / max) * 100}%` }}
              />
            </div>
            <span className="nf-weekday-avg-value font-mono">
              {b.sessions > 0 ? formatNumber(b.avgAbsChange, 2) : "—"}
            </span>
            <span className="nf-weekday-avg-meta text-muted">
              {b.sessions} day{b.sessions === 1 ? "" : "s"} · {b.signalDays} signal (
              {formatNumber(b.signalPct, 0)}%) · bias{" "}
              <span
                className={cn(
                  "font-mono",
                  b.avgSignedChange > 0 ? "text-up" : b.avgSignedChange < 0 ? "text-down" : "",
                )}
              >
                {b.avgSignedChange >= 0 ? "+" : ""}
                {formatNumber(b.avgSignedChange, 2)}
              </span>
            </span>
          </div>
        ))}
      </div>
      <p className="text-muted nf-weekday-avg-foot">
        {widest.weekday} has the biggest 9:15 {metric === "range" ? "range" : "body"} on average at{" "}
        {formatNumber(widest.avgAbsChange, 2)} pts. A larger average{" "}
        {metric === "range" ? "range" : "body"} means more days clear the entry filter, not that those
        days win more often.
      </p>
    </div>
  );
}

function NineSixteenBodyHistogram({
  stats,
  minAbsDiff,
  maxAbsDiffExclusive,
  smallBodyPutStats,
  smallBodySplitBuckets,
  metric = "body",
  minAbsDiffExclusive = false,
}: {
  stats: NineFifteenCePeStrategyStats;
  minAbsDiff: number;
  maxAbsDiffExclusive?: number;
  /** 0–10.9 |Δ| split backtest merged into the histogram. */
  smallBodyPutStats?: NineFifteenCePeStrategyStats;
  smallBodySplitBuckets?: NineFifteenSmallBodySplitBuckets;
  metric?: WeekdayNineFifteenMetric;
  minAbsDiffExclusive?: boolean;
}) {
  const index = useBacktestIndex();
  const trades = useMemo(() => {
    const main = strategyTradesForBodyBuckets(
      stats.successes,
      stats.failures,
      minAbsDiff,
      maxAbsDiffExclusive,
      minAbsDiffExclusive,
    );
    const small = smallBodyPutStats
      ? strategyTradesForBodyBuckets(
          smallBodyPutStats.successes,
          smallBodyPutStats.failures,
          0,
          minAbsDiff,
        )
      : [];
    return [...main, ...small];
  }, [
    stats.successes,
    stats.failures,
    smallBodyPutStats,
    minAbsDiff,
    maxAbsDiffExclusive,
    minAbsDiffExclusive,
  ]);

  const buckets = useMemo(
    () => buildNineSixteenBodyBuckets(trades, { signalFloor: minAbsDiff }),
    [trades, minAbsDiff],
  );

  const smallPutCount = smallBodyPutStats?.tradeDays ?? 0;
  const smallPutWins = smallBodyPutStats?.targetHits ?? 0;
  const bucket0to10 = buckets.find((b) => b.min === 0)?.count ?? 0;
  const bucket10to20 = buckets.find((b) => b.min === 10)?.count ?? 0;

  const total = trades.length;
  if (total === 0) return null;

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const yTicks = [maxCount, Math.ceil(maxCount / 2), 0];

  return (
    <div className="nf-body-hist card">
      <h4 className="nf-body-hist-title">
        <BarChart3 size={15} aria-hidden />
        9:16 trades by 9:15 candle size
      </h4>
      <p className="text-muted nf-body-hist-hint">
        Each bar counts a <strong>9:16:00 entry</strong>, bucketed by{" "}
        <strong>
          {metric === "range" ? "9:15 high − 9:15 low" : "|9:15 close − 9:15 open|"}
        </strong>{" "}
        in {index.shortLabel} points ({total} trade
        {total === 1 ? "" : "s"} total). Green = win, red = loss.
        {metric === "body" ? (
          <>
            {" "}
            Consolidated rule (|Δ| ≥ {minAbsDiff}): UP→CE / DOWN→PE.
          </>
        ) : (
          <> Red 9:15 only · range ≥ {minAbsDiff} · PE @ 9:16.</>
        )}{" "}
        {smallPutCount > 0 && (
          <>
            <strong>0–10.9 |Δ|</strong> (live skip):{" "}
            <strong>0–{SMALL_BODY_PUT_MAX_INCLUSIVE} PE</strong> ·{" "}
            <strong>
              {SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 CE
            </strong>{" "}
            @ 9:16 — {smallPutWins}/{smallPutCount} won (
            {formatNumber(smallBodyPutStats?.targetHitPct ?? 0, 1)}%
            {smallBodySplitBuckets ? (
              <>
                {" "}
                · PE {smallBodySplitBuckets.put.wins}/{smallBodySplitBuckets.put.trades} · CE{" "}
                {smallBodySplitBuckets.call.wins}/{smallBodySplitBuckets.call.trades}
              </>
            ) : null}
            ).
          </>
        )}
      </p>
      <div className="nf-body-hist-plot" role="img" aria-label="Histogram of 9:16 trades by 9:15 body size">
        <div className="nf-body-hist-y" aria-hidden>
          {yTicks.map((tick) => (
            <span key={tick} className="nf-body-hist-y-tick font-mono">
              {tick}
            </span>
          ))}
        </div>
        <div className="nf-body-hist-cols">
          {buckets.map((bucket) => {
            const heightPct = (bucket.count / maxCount) * 100;
            const winPct = bucket.count > 0 ? (bucket.wins / bucket.count) * 100 : 0;
            return (
              <div key={bucket.label} className="nf-body-hist-col">
                <div
                  className="nf-body-hist-bar-stack"
                  title={`${bucket.label} pts: ${bucket.count} trade${bucket.count === 1 ? "" : "s"} (${bucket.wins}W / ${bucket.losses}L)`}
                >
                  {bucket.count > 0 ? (
                    <div className="nf-body-hist-bar-pair" style={{ height: `${heightPct}%` }}>
                      {bucket.wins > 0 && (
                        <div
                          className="nf-body-hist-bar nf-body-hist-bar--win"
                          style={{ flexGrow: bucket.wins }}
                        />
                      )}
                      {bucket.losses > 0 && (
                        <div
                          className="nf-body-hist-bar nf-body-hist-bar--loss"
                          style={{ flexGrow: bucket.losses }}
                        />
                      )}
                      {bucket.wins === 0 && bucket.losses === 0 && (
                        <div className="nf-body-hist-bar nf-body-hist-bar--win" style={{ flexGrow: 1 }} />
                      )}
                    </div>
                  ) : null}
                </div>
                <span className="nf-body-hist-count font-mono">{bucket.count}</span>
                <span className="nf-body-hist-x text-muted">{bucket.label}</span>
                {bucket.count > 0 && (
                  <span className="nf-body-hist-winrate text-muted">
                    {formatNumber(winPct, 0)}% win
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="text-muted nf-body-hist-foot">
        X-axis = |9:15 body| in 10-point bands.
        {smallPutCount > 0 ? (
          <>
            {" "}
            The <strong>0–10</strong> band is mostly{" "}
            <strong>0–{SMALL_BODY_PUT_MAX_INCLUSIVE} PE</strong> entries;{" "}
            <strong>{SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 CE</strong> fills the rest of the small-body
            range and any 10–20 overlap ({bucket0to10} in 0–10 · {bucket10to20} in 10–20).
          </>
        ) : (
          <>
            {" "}
            With the live |Δ| ≥ {minAbsDiff} floor, the 0–10 band stays empty unless the small-body
            split backtest is loaded.
          </>
        )}
      </p>
    </div>
  );
}

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

function formatRsi(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatNumber(value, 2);
}

function rsiClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  if (value >= 70) return "text-up";
  if (value <= 30) return "text-down";
  return "";
}

function HitRateCell({ hits, pct }: { hits: number; pct: number }) {
  return (
    <td className="text-right text-sm font-mono">
      {hits} · {formatNumber(pct, 1)}%
    </td>
  );
}

function StrategyRow({
  stats,
  targetPoints = 30,
}: {
  stats: NineFifteenCePeStrategyStats;
  targetPoints?: number;
}) {
  const targetLabel =
    stats.side === "CE"
      ? `+₹${targetPoints} from open`
      : stats.side === "PE"
        ? `−₹${targetPoints} from open`
        : `±₹${targetPoints} from open`;
  const sideClass =
    stats.side === "CE"
      ? "nf-side-tag--ce"
      : stats.side === "PE"
        ? "nf-side-tag--pe"
        : "nf-side-tag--mixed";
  return (
    <tr>
      <td>
        {stats.side !== "MIXED" && (
          <span className={cn("nf-side-tag", sideClass)}>{stats.side}</span>
        )}{" "}
        {stats.label}
      </td>
      <td className="text-right">{stats.sampleDays}</td>
      <td className="text-right">{stats.tradeDays}</td>
      {NINE_FIFTEEN_TIME_CHECKPOINTS.map((cp) => (
        <HitRateCell
          key={cp}
          hits={stats.checkpointHits?.[cp]?.targetHits ?? 0}
          pct={stats.checkpointHits?.[cp]?.targetHitPct ?? 0}
        />
      ))}
      <td className="text-right">
        {stats.targetHits} · {formatNumber(stats.targetHitPct, 1)}%
      </td>
      <td className="text-muted text-sm">{targetLabel}</td>
    </tr>
  );
}

function FollowFilterStatsCard({
  stats,
  sessionsLabel,
}: {
  stats: NineFifteenFollowFilterStats;
  sessionsLabel: string;
}) {
  const bandMax = stats.maxAbsDiffExclusive;
  const filterTitle =
    stats.display?.filterTitle ??
    (bandMax != null
      ? `Filter: ${stats.minAbsDiff} ≤ |9:15 difference| < ${bandMax} · Follow UP→CE, DOWN→PE · ±₹${stats.targetPoints}`
      : `Filter: |9:15 difference| ≥ ${stats.minAbsDiff} · Follow UP→CE, DOWN→PE · ±₹${stats.targetPoints}`);
  const takenLabel =
    stats.display?.takenLabel ??
    (bandMax != null
      ? `Trades in band (${stats.minAbsDiff}–${bandMax - 0.1})`
      : `Trades taken (|diff| ≥ ${stats.minAbsDiff})`);
  const skippedLabel =
    stats.display?.skippedLabel ??
    (bandMax != null ? "Outside this band" : "Skipped (small 9:15 bar)");

  return (
    <div className="card nf-filter-stats">
      <h3 className="nf-filter-stats-title">{filterTitle}</h3>
      <p className="nf-filter-stats-source text-muted">
        NSE session days from Zerodha Kite only ({sessionsLabel}) — holidays/weekends omitted when no candles.
      </p>
      <div className="nf-filter-stats-grid">
        <div>
          <span className="nf-filter-stat-label">Directional 9:15 days</span>
          <span className="nf-filter-stat-value">{stats.totalFollowTrades}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">{takenLabel}</span>
          <span className="nf-filter-stat-value">{stats.filteredTrades}</span>
          <span className="nf-filter-stat-hint text-muted">
            {stats.totalFollowTrades > 0
              ? `${formatNumber((stats.filteredTrades / stats.totalFollowTrades) * 100, 1)}% of follow days`
              : "—"}
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Profit (target hit)</span>
          <span className="nf-filter-stat-value text-up">{stats.wins}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Loss (target missed)</span>
          <span className="nf-filter-stat-value text-down">{stats.losses}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Win rate (filtered)</span>
          <span className="nf-filter-stat-value">{formatNumber(stats.winPct, 2)}%</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">{skippedLabel}</span>
          <span className="nf-filter-stat-value">{stats.skippedSmallBar}</span>
        </div>
      </div>
    </div>
  );
}

function AltTargetAfter1010Cells({ alt }: { alt: NineFifteenAltTargetAfterTime | null | undefined }) {
  return (
    <>
      <td className="font-mono text-sm">
        {alt?.wouldWin && alt.hit ? (
          <>
            {alt.hit.timeIst}
            <span className="text-muted">
              {" "}
              · {alt.hit.levelLabel} @ {formatNumber(alt.hit.indexPrice, 2)}
            </span>
          </>
        ) : (
          <span className="text-muted">Not reached</span>
        )}
      </td>
      <td className={cn("font-medium text-sm", alt?.wouldWin ? "text-up" : "text-down")}>
        {alt?.wouldWin ? "Would win" : "Still loss"}
      </td>
    </>
  );
}

function StrategyTradeDetailTable({
  trades,
  kind,
  statsLabel,
  targetPoints,
  showAlt20After1010,
}: {
  trades: NonNullable<NineFifteenCePeStrategyStats["failures"]>;
  kind: "win" | "loss";
  targetPoints: number;
  statsLabel: string;
  showAlt20After1010?: boolean;
}) {
  const index = useBacktestIndex();

  if (trades.length === 0) return null;

  return (
    <div className="nf-failures-table-wrap">
      <table className="nf-failures-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Day</th>
            <th className="text-right">Prev day close</th>
            <th className="text-right">Traded day open (9:15)</th>
            <th className="text-right">Gap (open − prev)</th>
            <th>Gap</th>
            <th>Side</th>
            <th className="text-right">9:15 close</th>
            <th className="text-right">Difference</th>
            <th>9:15 bar</th>
            <th
              className="text-right"
              title={`Wilder RSI(14) on 1-min ${index.shortLabel} closes at 9:15 bar`}
            >
              RSI(14) @9:15
            </th>
            <th
              className="text-right"
              title={`Wilder RSI(14) on 1-min ${index.shortLabel} closes at 9:16 bar`}
            >
              RSI(14) @9:16
            </th>
            <th>Entry 9:16:00 (Kite open)</th>
            {kind === "win" && <th>±{targetPoints} from entry (Kite ≥9:16)</th>}
            {kind === "loss" && (
              <>
                <th className="text-right">Exit target (entry ±{targetPoints})</th>
                <th>±{targetPoints} from entry (≥9:16)</th>
                <th className="text-right">Best move / shortfall</th>
                {showAlt20After1010 && (
                  <>
                    <th>Alt ±20 from 10:01</th>
                    <th>±20 result</th>
                    <th>Alt ±15 from 11:01</th>
                    <th>±15 result</th>
                  </>
                )}
              </>
            )}
            <th>Won / Loss</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((f) => (
            <tr key={`${statsLabel}-${kind}-${f.date}`}>
              <td>{f.date}</td>
              <td className="text-muted text-sm">{formatWeekdayFromDateKey(f.date)}</td>
              <td className="text-right font-mono text-sm">
                {f.prevDayClose != null ? formatNumber(f.prevDayClose, 2) : "—"}
              </td>
              <td className="text-right font-mono text-sm">{formatNumber(f.open915, 2)}</td>
              <td
                className={cn(
                  "text-right font-mono text-sm",
                  f.gapFromPrevClose != null && f.gapFromPrevClose > 0
                    ? "text-up"
                    : f.gapFromPrevClose != null && f.gapFromPrevClose < 0
                      ? "text-down"
                      : "",
                )}
              >
                {f.gapFromPrevClose != null ? (
                  <>
                    {f.gapFromPrevClose >= 0 ? "+" : ""}
                    {formatNumber(f.gapFromPrevClose, 2)}
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td>
                {f.gapFromPrevCloseDirection ? (
                  <DirectionBadge direction={f.gapFromPrevCloseDirection} />
                ) : (
                  "—"
                )}
              </td>
              <td>
                <span className={cn("nf-side-tag", f.side === "CE" ? "nf-side-tag--ce" : "nf-side-tag--pe")}>
                  {f.side}
                </span>
              </td>
              <td className="text-right font-mono">{formatNumber(f.close915, 2)}</td>
              <td
                className={cn(
                  "text-right font-mono",
                  f.change > 0 ? "text-up" : f.change < 0 ? "text-down" : "",
                )}
              >
                {f.change >= 0 ? "+" : ""}
                {formatNumber(f.change, 2)}
              </td>
              <td>
                <DirectionBadge direction={f.direction} />
              </td>
              <td className={cn("text-right font-mono text-sm", rsiClass(f.rsi915))}>
                {formatRsi(f.rsi915)}
              </td>
              <td className={cn("text-right font-mono text-sm", rsiClass(f.rsi916))}>
                {formatRsi(f.rsi916)}
              </td>
              <td className="font-mono text-sm">
                {f.entryAt ? (
                  <>
                    {f.entryAt.timeIst}
                    <span className="text-muted"> @ {formatNumber(f.entryAt.indexPrice, 2)}</span>
                  </>
                ) : (
                  "—"
                )}
              </td>
              {kind === "win" && (
                <td className="font-mono text-sm">
                  {(() => {
                    const hit =
                      f.targetHit ??
                      (f.targetHitAt && f.entryAt
                        ? {
                            timeIst: f.targetHitAt,
                            levelLabel: f.side === "CE" ? `+${targetPoints}` : `−${targetPoints}`,
                            indexPrice:
                              f.entryAt.indexPrice +
                              (f.side === "CE" ? targetPoints : -targetPoints),
                          }
                        : null);
                    if (!hit) return "—";
                    return (
                      <>
                        {hit.timeIst}
                        <span className="text-muted">
                          {" "}
                          · {hit.levelLabel} @ {formatNumber(hit.indexPrice, 2)}
                        </span>
                      </>
                    );
                  })()}
                </td>
              )}
              {kind === "loss" && (
                <>
                  <td className="text-right font-mono text-sm">
                    {f.exitTargetIndexPrice != null ? (
                      <>
                        {f.side === "CE" ? `+${targetPoints}` : `−${targetPoints}`}
                        <span className="text-muted"> @ {formatNumber(f.exitTargetIndexPrice, 2)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="font-mono text-sm text-muted">Not reached</td>
                  <td className="text-right font-mono text-sm">
                    <div>
                      {formatNumber(f.maxMoveInDirection, 2)} pts
                      {f.maxMoveInDirection < targetPoints && (
                        <span className="text-muted">
                          {" "}
                          (need {formatNumber(targetPoints - f.maxMoveInDirection, 2)} more)
                        </span>
                      )}
                    </div>
                    {f.maxMovePeakAt && f.maxMoveInDirection > 0 && (
                      <div className="text-muted text-xs nf-mfe-time">
                        @ {f.maxMovePeakAt}
                        {f.maxMovePeakIndex != null && (
                          <> · {index.shortLabel} {formatNumber(f.maxMovePeakIndex, 2)}</>
                        )}
                      </div>
                    )}
                  </td>
                  {showAlt20After1010 && (
                    <>
                      <AltTargetAfter1010Cells alt={f.altTargetAfter1010} />
                      <AltTargetAfter1010Cells alt={f.altTarget10After1010} />
                    </>
                  )}
                </>
              )}
              <td className={cn(kind === "win" ? "text-up" : "text-down", "font-medium")}>
                {kind === "win" ? "Won" : "Loss"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrategyFailuresPanel({
  stats,
  targetPoints,
  minAbsDiff,
  maxAbsDiffExclusive,
  showAlt20After1010,
  switchTarget,
}: {
  stats: NineFifteenCePeStrategyStats;
  targetPoints: number;
  minAbsDiff?: number;
  maxAbsDiffExclusive?: number;
  showAlt20After1010?: boolean;
  /** Near-miss two-phase exit overlay on day charts. */
  switchTarget?: { afterIst: string; points: number };
}) {
  const failures = (stats.failures ?? []).filter((t) => {
    const abs = Math.abs(t.change);
    if (maxAbsDiffExclusive != null && minAbsDiff != null) {
      return abs >= minAbsDiff && abs < maxAbsDiffExclusive;
    }
    if (minAbsDiff != null) return abs >= minAbsDiff;
    return true;
  });
  if (failures.length === 0) return null;

  const altRescued20 = showAlt20After1010
    ? failures.filter((t) => t.altTargetAfter1010?.wouldWin).length
    : 0;
  const altRescued10 = showAlt20After1010
    ? failures.filter((t) => t.altTarget10After1010?.wouldWin).length
    : 0;

  return (
    <details className="nf-failures-details" open>
      <summary className="nf-failures-summary">
        <span className="nf-failures-rule">{stats.label}</span>
        <span className="nf-failures-count text-muted">
          {failures.length}{" "}
          {maxAbsDiffExclusive != null ? "near-miss loss" : "taken loss"}
          {failures.length === 1 ? "" : "es"}
          {maxAbsDiffExclusive != null
            ? ` (entry ±${targetPoints} / band exit not reached)`
            : minAbsDiff != null && minAbsDiff < 15
              ? " (band exit not reached)"
              : ` (entry ±${targetPoints} not reached)`}
          {showAlt20After1010 && (altRescued20 > 0 || altRescued10 > 0)
            ? ` · alt: ${altRescued20} at ±20@10:01, ${altRescued10} at ±15@11:01`
            : ""}
          {" · expand a day for 1-min chart"}
        </span>
      </summary>
      <LossTradesAccordion
        trades={failures}
        targetPoints={targetPoints}
        showAlt20After1010={showAlt20After1010}
        switchTarget={switchTarget}
      />
    </details>
  );
}

function FollowStrategyWinsPanel({
  stats,
  targetPoints,
  minAbsDiff,
  maxAbsDiffExclusive,
  showHourlyBreakdown,
  heading,
  winIntro,
  hourlyHitRuleLabel,
  smallBodyPutStats,
  smallBodySplitBuckets,
  candleMetric = "body",
  redOnlyWeekdaySignal = false,
  minAbsDiffExclusive = false,
}: {
  stats: NineFifteenCePeStrategyStats;
  targetPoints: number;
  minAbsDiff: number;
  maxAbsDiffExclusive?: number;
  showHourlyBreakdown?: boolean;
  heading?: string;
  winIntro?: ReactNode;
  hourlyHitRuleLabel?: string;
  smallBodyPutStats?: NineFifteenCePeStrategyStats;
  smallBodySplitBuckets?: NineFifteenSmallBodySplitBuckets;
  candleMetric?: WeekdayNineFifteenMetric;
  redOnlyWeekdaySignal?: boolean;
  minAbsDiffExclusive?: boolean;
}) {
  const index = useBacktestIndex();
  const sc = (points: number) => points * index.pointScale;
  const passesMin = (t: { change: number; candleRange915?: number }) =>
    minAbsDiffExclusive
      ? trade915EntrySize(t) > minAbsDiff
      : trade915EntrySize(t) >= minAbsDiff;
  const wins =
    maxAbsDiffExclusive != null
      ? (stats.successes ?? []).filter(
          (t) => passesMin(t) && trade915EntrySize(t) < maxAbsDiffExclusive,
        )
      : (stats.successes ?? []).filter((t) => passesMin(t));
  if (wins.length === 0) return null;

  const bandTitle =
    maxAbsDiffExclusive != null
      ? `Winning trades — near-miss band (${minAbsDiff} ≤ |9:15 Δ| < ${maxAbsDiffExclusive}, ±₹${targetPoints})`
      : `Winning trades — taken only (|9:15 Δ| ≥ ${minAbsDiff}, ±${sc(25)} → ±${sc(20)}@10:01 → ±${sc(15)}@11:01)`;

  return (
    <div className="nf-wins-block">
      <h3 className="nf-wins-title">{heading ?? bandTitle}</h3>
      <p className="nf-failures-intro text-muted">
        {winIntro ?? (
          <>
            UP → CE, DOWN → PE. Backtest entry = <strong>9:16:00 Kite open</strong>. Win if a Kite bar from{" "}
            <strong>9:16</strong> onward touches <strong>entry ±25</strong> before <strong>10:01</strong>,{" "}
            <strong>±20</strong> from 10:01, or <strong>±15</strong> from <strong>11:01</strong> (hit time = that
            minute’s open).
            {maxAbsDiffExclusive != null && (
              <>
                {" "}
                These days are <strong>skipped live</strong> (|Δ| &lt; {maxAbsDiffExclusive}); shown as if entered
                anyway.
              </>
            )}
          </>
        )}
      </p>
      {showHourlyBreakdown && (
        <>
          <WinHourlyBreakdown
            wins={wins}
            targetPoints={targetPoints}
            hitRuleLabel={
              hourlyHitRuleLabel ??
              "when ±25 / ±20@10:01 / ±15@11:01 was first hit"
            }
          />
          <WeekdayNineFifteenAverages
            signalFloor={minAbsDiff}
            metric={candleMetric}
            redOnlySignal={redOnlyWeekdaySignal}
            signalExclusive={minAbsDiffExclusive}
          />
          <NineSixteenBodyHistogram
            stats={stats}
            minAbsDiff={minAbsDiff}
            maxAbsDiffExclusive={maxAbsDiffExclusive}
            smallBodyPutStats={smallBodyPutStats}
            smallBodySplitBuckets={smallBodySplitBuckets}
            metric={candleMetric}
            minAbsDiffExclusive={minAbsDiffExclusive}
          />
        </>
      )}
      <details className="nf-failures-details nf-wins-details" open>
        <summary className="nf-failures-summary">
          <span className="nf-failures-rule">{stats.label}</span>
          <span className="nf-failures-count text-muted">
            {wins.length} win{wins.length === 1 ? "" : "s"} · expand/collapse list
          </span>
        </summary>
        <StrategyTradeDetailTable
          trades={wins}
          kind="win"
          targetPoints={targetPoints}
          statsLabel={stats.label}
        />
      </details>
    </div>
  );
}

function TuesdayTenPointSection({
  stats,
  historyLabel,
}: {
  stats: NineFifteenTuesdayTargetStats;
  historyLabel: string;
}) {
  const index = useBacktestIndex();
  const pts = stats.targetPoints;
  const day = index.expiryWeekday;
  const minDiff = 11 * index.pointScale;

  return (
    <div className="card nf-cepe-guide">
      <h2 className="card-title">
        {day} ±{pts} log — every {day} ({historyLabel})
      </h2>
      <p className="nf-cepe-rule">
        This is the live {day} exit rule: side comes from the 9:15 bar exactly as on any other day,
        but the index target is a flat <strong>±{pts}</strong> from the 9:16:00 entry, active from the
        fill and never tiered. Every {day} in the window is listed below with the exact minute the
        ±{pts} level was touched, or <strong className="text-down">Not hit</strong> plus how close the
        session came.
      </p>
      <p className="nf-cepe-steps text-muted">
        Hit time is the <strong>start of the 1-min Kite bar</strong> whose high (CE) or low (PE) first
        reached entry ±{pts}, scanning 9:16 through 15:30 and including the entry minute.{" "}
        <strong>Closest</strong> is the smallest gap to that level across the same window — on a miss it
        is how many index points short the day finished at its best moment. {day}s with{" "}
        <strong>|Δ| &lt; {minDiff}</strong> are shown as no-trade days and are excluded from the hit
        rate.
      </p>

      <div className="card nf-filter-stats">
        <h3 className="nf-filter-stats-title">
          {stats.hits} of {stats.tradeDays} {day} trades reached ±{pts}
        </h3>
        <p className="nf-filter-stats-source text-muted">
          {stats.totalTuesdays} {day}s in the sample · Zerodha Kite minute data.
        </p>
        <div className="nf-filter-stats-grid">
          <div>
            <span className="nf-filter-stat-label">{day}s in sample</span>
            <span className="nf-filter-stat-value">{stats.totalTuesdays}</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Trades taken</span>
            <span className="nf-filter-stat-value">{stats.tradeDays}</span>
            <span className="nf-filter-stat-hint text-muted">|Δ| ≥ {minDiff}</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">±{pts} hit</span>
            <span className="nf-filter-stat-value text-up">{stats.hits}</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Not hit</span>
            <span className="nf-filter-stat-value text-down">{stats.misses}</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Hit rate</span>
            <span className="nf-filter-stat-value">{formatNumber(stats.hitPct, 2)}%</span>
            <span className="nf-filter-stat-hint text-muted">of trade days</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Skipped</span>
            <span className="nf-filter-stat-value">{stats.skippedDays}</span>
            <span className="nf-filter-stat-hint text-muted">|Δ| &lt; 11 — no trade</span>
          </div>
        </div>
      </div>

      <div className="nf-failures-table-wrap">
        <table className="nf-failures-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="text-right">9:15 Δ</th>
              <th>Side</th>
              <th>Band</th>
              <th className="text-right">Entry 9:16:00 (Kite open)</th>
              <th className="text-right">Target (entry ±{pts})</th>
              <th>±{pts} hit at</th>
              <th className="text-right">Closest to target</th>
            </tr>
          </thead>
          <tbody>
            {stats.rows.map((row) => {
              const noTrade = row.side == null;
              const hit = row.hit;
              return (
                <tr key={`tue10-${row.date}`}>
                  <td>{row.date}</td>
                  <td
                    className={cn(
                      "text-right font-mono text-sm",
                      row.change915 > 0 ? "text-up" : row.change915 < 0 ? "text-down" : "text-muted",
                    )}
                  >
                    {row.change915 >= 0 ? "+" : ""}
                    {formatNumber(row.change915, 2)}
                  </td>
                  <td>
                    {noTrade ? (
                      <span className="text-muted">No trade</span>
                    ) : (
                      <span className={row.side === "CE" ? "text-up" : "text-down"}>{row.side}</span>
                    )}
                  </td>
                  <td className="text-muted text-sm">
                    {row.band === "near_miss" ? "near-miss" : row.band === "main" ? "main" : "—"}
                  </td>
                  <td className="text-right font-mono text-sm">
                    {row.entryIndexPrice != null ? formatNumber(row.entryIndexPrice, 2) : "—"}
                  </td>
                  <td className="text-right font-mono text-sm">
                    {row.targetIndexPrice != null ? formatNumber(row.targetIndexPrice, 2) : "—"}
                  </td>
                  <td>
                    {noTrade ? (
                      <span className="text-muted">|Δ| &lt; 11 — skipped</span>
                    ) : hit ? (
                      <span className="text-up font-mono text-sm">{hit.timeIst}</span>
                    ) : (
                      <strong className="text-down">Not hit</strong>
                    )}
                  </td>
                  <td className="text-right font-mono text-sm">
                    {noTrade || !row.closest ? (
                      <span className="text-muted">—</span>
                    ) : hit ? (
                      <span className="text-muted">reached</span>
                    ) : (
                      <span className="text-down">
                        {formatNumber(row.closest.gapToTargetPts, 2)} pts short ·{" "}
                        {row.closest.timeIst.slice(0, 5)} · {formatNumber(row.closest.indexPrice, 2)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MidBacktestSummaryStats({
  stats,
  heading,
}: {
  stats: NineFifteenMidBacktestStats;
  /** Optional line under the headline, e.g. "3-minute candle · +20 target". */
  heading?: string;
}) {
  const pts = stats.targetPoints;
  const stop = stats.stopPoints;

  return (
    <div className="card nf-filter-stats nf-mid-summary-stats">
      {heading && <p className="nf-mid-summary-heading text-muted">{heading}</p>}
      <h3 className="nf-filter-stats-title">
        {stats.wins} profit · {stats.losses} loss from {stats.totalSignals} signals ·{" "}
        <span className={stats.netPoints >= 0 ? "text-up" : "text-down"}>
          net {stats.netPoints >= 0 ? "+" : "−"}
          {formatNumber(Math.abs(stats.netPoints), 2)} pts
        </span>
      </h3>
      <p className="nf-filter-stats-source text-muted">
        {stats.sessionsScanned} NSE sessions scanned · Zerodha Kite minute data. Wins book +{pts},
        stops book −{stop}, and timeouts mark to the cut-off price — points, not rupees, and every
        signal is sized the same.
      </p>
      <div className="nf-filter-stats-grid">
        <div>
          <span className="nf-filter-stat-label">Signals found</span>
          <span className="nf-filter-stat-value">{stats.totalSignals}</span>
          <span className="nf-filter-stat-hint text-muted">
            {stats.ceSignals} CE · {stats.peSignals} PE
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Profit (+{pts} first)</span>
          <span className="nf-filter-stat-value text-up">{stats.wins}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Loss (never hit +{pts})</span>
          <span className="nf-filter-stat-value text-down">{stats.losses}</span>
          <span className="nf-filter-stat-hint text-muted">
            {stats.losses - stats.timedOut} stopped at −{stop} · {stats.timedOut} timed out
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Total profit</span>
          <span className="nf-filter-stat-value text-up">
            +{formatNumber(stats.totalProfitPoints, 2)}
          </span>
          <span className="nf-filter-stat-hint text-muted">points from {stats.wins} wins</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Total loss</span>
          <span className="nf-filter-stat-value text-down">
            −{formatNumber(stats.totalLossPoints, 2)}
          </span>
          <span className="nf-filter-stat-hint text-muted">points from {stats.losses} losses</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Net points</span>
          <span
            className={cn(
              "nf-filter-stat-value",
              stats.netPoints >= 0 ? "text-up" : "text-down",
            )}
          >
            {stats.netPoints >= 0 ? "+" : "−"}
            {formatNumber(Math.abs(stats.netPoints), 2)}
          </span>
          <span className="nf-filter-stat-hint text-muted">profit − loss</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Win rate</span>
          <span className="nf-filter-stat-value">{formatNumber(stats.winPct, 2)}%</span>
          <span className="nf-filter-stat-hint text-muted">of all {stats.totalSignals} trades</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Timed out</span>
          <span className="nf-filter-stat-value text-down">{stats.timedOut}</span>
          <span className="nf-filter-stat-hint text-muted">
            squared off at cut-off · counted as loss
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Avg time to target</span>
          <span className="nf-filter-stat-value">
            {formatAvgMinutes(stats.avgMinutesToTarget)}
          </span>
          <span className="nf-filter-stat-hint text-muted">winners only</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Avg time to stop</span>
          <span className="nf-filter-stat-value text-down">
            {formatAvgMinutes(stats.avgMinutesToStop)}
          </span>
          <span className="nf-filter-stat-hint text-muted">
            {stats.losses - stats.timedOut} stopped trades only
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Avg past target</span>
          <span className="nf-filter-stat-value text-up">
            {stats.avgBeyondTargetPts != null
              ? `+${formatNumber(stats.avgBeyondTargetPts, 2)}`
              : "—"}
          </span>
          <span className="nf-filter-stat-hint text-muted">
            winners · best{" "}
            {stats.maxBeyondTargetPts != null
              ? `+${formatNumber(stats.maxBeyondTargetPts, 2)}`
              : "—"}
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Avg trades per day</span>
          <span className="nf-filter-stat-value">{formatNumber(stats.avgTradesPerSession, 2)}</span>
          <span className="nf-filter-stat-hint text-muted">
            {stats.totalSignals} signals ÷ {stats.sessionsScanned} sessions
          </span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Avg short of target</span>
          <span className="nf-filter-stat-value text-down">
            {stats.avgShortOfTargetPts != null
              ? formatNumber(stats.avgShortOfTargetPts, 2)
              : "—"}
          </span>
          <span className="nf-filter-stat-hint text-muted">losers · out of {pts}</span>
        </div>
      </div>
    </div>
  );
}

const MID_SIGNAL_STOP_BLOCKS: NineFifteenMidSignalThreshold[] = [25, 20, 15, 10];

function MidBacktestSection({
  stats,
  statsTp15,
  statsBySignalAndStop,
  statsMove10Tp5ByStop,
  statsTwoCandleByStop,
  statsExhaustion10ByStop,
  statsExhaustion5ByStop,
  historyLabel,
}: {
  /** Baseline run and anchor for the headline card: 1-min bar, +20 target, −70 stop. */
  stats: NineFifteenMidBacktestStats;
  statsTp15?: NineFifteenMidBacktestStats;
  statsBySignalAndStop?: Record<
    NineFifteenMidSignalThreshold,
    Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>
  >;
  statsMove10Tp5ByStop?: Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>;
  statsTwoCandleByStop?: Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>;
  statsExhaustion10ByStop?: Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>;
  statsExhaustion5ByStop?: Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>;
  historyLabel: string;
}) {
  const index = useBacktestIndex();
  const sc = (points: number) => points * index.pointScale;
  const move = stats.signalMovePoints;
  const pts = stats.targetPoints;
  const stop = stats.stopPoints;
  const barLabel = `${stats.barMinutes}-min`;
  const fromLabel = stats.windowFromIst.slice(0, 5);
  const toLabel = stats.windowToIst.slice(0, 5);
  const deadlineLabel = stats.deadlineIst.slice(0, 5);
  const expiryDeadlineLabel = stats.deadlineIstTuesday.slice(0, 5);

  return (
    <div className="card nf-cepe-guide">
      <h2 className="card-title">
        Mid backtesting — {move}-pt {barLabel} bar → next-bar entry → +{pts} / −{stop} ({historyLabel})
      </h2>
      <p className="nf-cepe-rule">
        Study only — nothing here is wired into the live bot. Scans raw <strong>{barLabel}</strong>{" "}
        Kite candles between <strong>{fromLabel}</strong> and <strong>{toLabel}</strong> IST for a
        single minute that travels <strong>{move}+ points</strong> from its own open. Entry is the{" "}
        <strong>open of the next {barLabel} bar</strong> — CE when the signal bar went up, PE when
        it went down — and the trade then races to its take-profit against a{" "}
        <strong className="text-down">−{stop}</strong> stop, squared off at{" "}
        <strong>{deadlineLabel}</strong> (<strong>{expiryDeadlineLabel}</strong> on{" "}
        {index.expiryWeekday}s). Below that, six blocks sweep the stop from −{sc(70)} down to −
        {sc(10)} — one per signal threshold (±{sc(25)}, ±{sc(20)}, ±{sc(15)}, ±{sc(10)} pt candle)
        at +{sc(10)} take-profit, a momentum-confirmation block that needs two consecutive ±{sc(10)}{" "}
        candles and enters on the third, and two exhaustion blocks that fade a run of same-colour
        candles (10 or 5 in a row) at +{sc(10)} take-profit.
      </p>

      <MidBacktestSummaryStats
        stats={stats}
        heading={`${barLabel} candle · +${pts} take-profit · −${stop} stop`}
      />

      <h3 className="nf-mid-tables-heading">Weekday × time grids</h3>
      <p className="nf-cepe-steps text-muted nf-mid-accordion-hint">
        Each run is collapsed below — click a row to expand the heatmap and drill-down.
      </p>

      {stats.totalSignals > 0 && (
        <MidGridAccordion
          title={`${barLabel} · take profit +${pts} / −${pts} — same −${stop} stop`}
          stats={stats}
          defaultOpen
        >
          <MidWeekdayGrid
            compact
            grid={stats.grid}
            targetPoints={stats.targetPoints}
            stopPoints={stats.stopPoints}
            runKey={stats.runKey}
            sessionDates={stats.sessionDates}
          />
        </MidGridAccordion>
      )}

      {statsTp15 && statsTp15.totalSignals > 0 && (
        <MidTargetVariantGrid
          stats={statsTp15}
          title={`${barLabel} · take profit +15 / −15 — same −${stop} stop`}
        />
      )}

      {statsBySignalAndStop &&
        MID_SIGNAL_STOP_BLOCKS.flatMap((threshold) => {
          const blocks = [
            <MidStopVariantBlock
              key={threshold}
              signalMovePoints={threshold}
              statsByStop={statsBySignalAndStop[threshold]}
            />,
          ];
          if (threshold === 10 && statsMove10Tp5ByStop) {
            blocks.push(
              <MidStopVariantBlock
                key="10-tp5"
                signalMovePoints={10}
                statsByStop={statsMove10Tp5ByStop}
                sameEntriesAsTarget={10}
              />,
            );
          }
          return blocks;
        })}

      {statsTwoCandleByStop && (
        <MidStopVariantBlock signalMovePoints={10} statsByStop={statsTwoCandleByStop} confirmBars={2} />
      )}

      {statsExhaustion10ByStop && (
        <MidStopVariantBlock
          signalMovePoints={0}
          statsByStop={statsExhaustion10ByStop}
          confirmBars={10}
          fade
        />
      )}

      {statsExhaustion5ByStop && (
        <MidStopVariantBlock
          signalMovePoints={0}
          statsByStop={statsExhaustion5ByStop}
          confirmBars={5}
          fade
        />
      )}
    </div>
  );
}

function formatAvgMinutes(minutes: number | null): string {
  return minutes != null ? `${formatNumber(minutes, 1)} min` : "—";
}

/** "12W · 5L · 71% · net +40" for one side. */
function MidSideTally({
  label,
  totals,
}: {
  label: "CE" | "PE";
  totals: NineFifteenMidSideTotals;
}) {
  const traded = totals.wins + totals.losses;
  const winPct = traded > 0 ? (totals.wins / traded) * 100 : 0;

  return (
    <span className="nf-mid-side-tally">
      <strong className={label === "CE" ? "text-up" : "text-down"}>
        {label === "CE" ? "Call buy" : "Put buy"}
      </strong>{" "}
      <span className="text-up">{totals.wins}W</span>
      <span className="text-muted"> · </span>
      <span className="text-down">{totals.losses}L</span>
      <span className="text-muted"> · {formatNumber(winPct, 0)}% · </span>
      <span className={totals.netPoints >= 0 ? "text-up" : "text-down"}>
        net {totals.netPoints >= 0 ? "+" : "−"}
        {formatNumber(Math.abs(totals.netPoints), 0)}
      </span>
    </span>
  );
}

/**
 * One-line headline numbers for a mid-grid accordion summary row.
 */
function MidGridSummaryLine({ stats }: { stats: NineFifteenMidBacktestStats }) {
  const bySide = stats.sideTotals;
  const avgWinMin = stats.avgMinutesToTarget;
  const avgStopMin = stats.avgMinutesToStop;
  const stopped = stats.losses - stats.timedOut;

  return (
    <>
      <span className="nf-mid-accordion-headline">
        <strong>
          {stats.wins} profit · {stats.losses} loss
        </strong>
        {" · "}
        <span className={stats.netPoints >= 0 ? "text-up" : "text-down"}>
          net {stats.netPoints >= 0 ? "+" : "−"}
          {formatNumber(Math.abs(stats.netPoints), 0)} pts
        </span>
        {" · "}
        {formatNumber(stats.winPct, 1)}% win rate
        {" · "}
        <span className="text-muted">
          avg {formatNumber(stats.avgTradesPerSession, 2)} trades/day
        </span>
      </span>
      <span className="nf-mid-accordion-timing">
        <span className="text-up">avg to profit {formatAvgMinutes(avgWinMin)}</span>
        <span className="text-muted"> · </span>
        <span className="text-down">avg to stop {formatAvgMinutes(avgStopMin)}</span>
        {stopped > 0 && avgStopMin != null && (
          <span className="text-muted"> ({stopped} stopped)</span>
        )}
      </span>
      <span className="nf-mid-accordion-sides">
        <MidSideTally label="CE" totals={bySide.CE} />
        <MidSideTally label="PE" totals={bySide.PE} />
      </span>
    </>
  );
}

/** Collapsible wrapper for one weekday × time heatmap. */
function MidGridAccordion({
  title,
  stats,
  defaultOpen = false,
  children,
}: {
  title: string;
  stats: NineFifteenMidBacktestStats;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="nf-mid-accordion" open={defaultOpen || undefined}>
      <summary className="nf-mid-accordion-summary">
        <span className="nf-mid-accordion-title">{title}</span>
        <span className="nf-mid-accordion-meta text-muted">
          <MidGridSummaryLine stats={stats} />
        </span>
      </summary>
      <div className="nf-mid-accordion-body">{children}</div>
    </details>
  );
}

/**
 * One signal threshold at +10 take-profit, swept across every stop level (−70 down to −10).
 * Entries are identical within the block — only the exit risk changes.
 */
function MidStopVariantBlock({
  signalMovePoints,
  statsByStop,
  confirmBars = 1,
  fade = false,
  sameEntriesAsTarget,
}: {
  /** Minimum move each trigger candle must make. 0 = colour alone qualifies, any size. */
  signalMovePoints: NineFifteenMidSignalThreshold | 0;
  statsByStop: Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>;
  /** 2 = two consecutive same-direction candles must clear the threshold before entering. */
  confirmBars?: number;
  /** Trade against the run instead of with it: green run buys PE, red run buys CE. */
  fade?: boolean;
  /** When set, entries match the block above that used this take-profit — only the target changed. */
  sameEntriesAsTarget?: number;
}) {
  const index = useBacktestIndex();
  const runs = useMemo(
    () =>
      Object.values(statsByStop)
        .filter((run): run is NineFifteenMidBacktestStats => !!run && run.totalSignals > 0)
        .sort((a, b) => b.stopPoints - a.stopPoints),
    [statsByStop],
  );

  if (runs.length === 0) return null;

  const baseline = statsByStop[70] ?? runs[0];
  const barLabel = `${baseline.barMinutes}-min`;
  const expiryDay = index.expiryWeekday;
  const target = baseline.targetPoints;
  const twoCandle = confirmBars > 1 && !fade;

  return (
    <div className="nf-mid-bar-size-block">
      <h3 className="nf-mid-grid-title">
        {fade
          ? `${confirmBars} same-colour candles → reverse on candle ${confirmBars + 1} — take profit +${target}, stop sweep`
          : twoCandle
            ? `${confirmBars} consecutive ±${signalMovePoints} pt candles → enter on candle ${confirmBars + 1} — take profit +${target}, stop sweep`
            : `±${signalMovePoints} pt ${barLabel} candle entry — take profit +${target}, stop sweep`}
      </h3>
      <p className="nf-cepe-steps text-muted">
        {fade ? (
          <>
            Exhaustion play — this is the only block that trades <strong>against</strong> the move.
            When <strong>{confirmBars} {barLabel} candles in a row close the same colour</strong>{" "}
            (size does not matter, only the colour), the trade opens on candle {confirmBars + 1} in
            the opposite direction: a green run <strong>buys PE</strong> and aims for{" "}
            <strong>−{target}</strong>, a red run <strong>buys CE</strong> and aims for{" "}
            <strong>+{target}</strong>. Any candle that closes flat or breaks the colour resets the
            count{confirmBars >= 10 ? ", so a streak this long is rare" : ""}. Same 15:30 /{" "}
            {expiryDay} 14:00 cut-off as every block above.{" "}
          </>
        ) : twoCandle ? (
          <>
            Momentum confirmation instead of a single trigger candle:{" "}
            <strong>{confirmBars} consecutive {barLabel} candles</strong> must each move{" "}
            <strong>{signalMovePoints}+ points</strong> in the <strong>same direction</strong>, and
            the trade only opens on the <strong>next candle</strong> — so candle 1 and candle 2 both
            have to run before entry on candle 3. A run broken by a flat or opposite candle is not a
            signal, which is why this takes far fewer trades than the single ±{signalMovePoints}{" "}
            block above. Everything after entry is unchanged: aim for{" "}
            <strong className="text-up">+{target}</strong> (CE up · PE down) with the stop on each
            row, same 15:30 / {expiryDay} 14:00 cut-off.{" "}
          </>
        ) : sameEntriesAsTarget != null ? (
          <>
            Same <strong>{baseline.totalSignals}</strong> ±{signalMovePoints} entries as the{" "}
            <strong>+{sameEntriesAsTarget}</strong> take-profit block above — only the exit target
            is tighter at <strong className="text-up">+{target}</strong> (CE up · PE down). The stop
            on each row below is unchanged; a smaller target should close winners faster but leave
            less room on trades that would have run further.{" "}
          </>
        ) : (
          <>
            Enter when a single {barLabel} candle moves at least{" "}
            <strong>±{signalMovePoints} points</strong> from its open (CE up · PE down), then aim
            for <strong className="text-up">+{target}</strong> with the stop on each row below. A
            looser ±{signalMovePoints} trigger means more trades than the block above; tightening
            the stop cuts shallow dips that a wide stop would have survived.{" "}
          </>
        )}
        All <strong>{baseline.totalSignals}</strong> entries are the same across the seven stops —
        only the loss size changes.
      </p>
      {runs.map((run) => (
        <MidTargetVariantGrid
          key={run.stopPoints}
          stats={run}
          baseStopPoints={
            run.stopPoints === baseline.stopPoints ? undefined : baseline.stopPoints
          }
          title={`${barLabel} · take profit +${run.targetPoints} / −${run.targetPoints} — −${run.stopPoints} stop`}
        />
      ))}
    </div>
  );
}

/**
 * Weekday × signal-time grid for an alternate mid-session run. By default only the take-profit
 * differs from the run above; pass `baseMovePoints` when the signal threshold changed too, so the
 * blurb does not claim these are the same trades.
 */
function MidTargetVariantGrid({
  stats,
  title,
  baseMovePoints,
  baseStopPoints,
}: {
  stats: NineFifteenMidBacktestStats;
  title: string;
  /** Signal threshold of the run above. When it differs, this grid has its own set of signals. */
  baseMovePoints?: number;
  /** Stop of the baseline run. When it differs, only the exit risk changed, not the trades. */
  baseStopPoints?: number;
}) {
  const index = useBacktestIndex();
  const pts = stats.targetPoints;
  const stop = stats.stopPoints;
  const move = stats.signalMovePoints;
  const ownSignals = baseMovePoints != null && baseMovePoints !== move;
  const tighterStop = baseStopPoints != null && baseStopPoints !== stop;

  return (
    <MidGridAccordion title={title} stats={stats}>
      <p className="nf-cepe-steps text-muted">
        {ownSignals ? (
          <>
            A different, looser trigger: <strong>{stats.totalSignals}</strong> signals from 1-min
            bars that travelled <strong>{move}+ points</strong> from their own open, against{" "}
            <strong>{baseMovePoints}+</strong> above — so many more trades, each on a weaker push.{" "}
          </>
        ) : tighterStop ? (
          <>
            The same <strong>{stats.totalSignals}</strong> entries as the −{baseStopPoints} run,
            exited differently: a dip the −{baseStopPoints} stop rode out can now cut the trade at{" "}
            <strong className="text-down">−{stop}</strong>.{" "}
          </>
        ) : (
          <>
            Same <strong>{stats.totalSignals}</strong> signals as above —{" "}
          </>
        )}
        CE aims for <strong className="text-up">+{pts}</strong>, PE for{" "}
        <strong className="text-down">−{pts}</strong>, stop{" "}
        {tighterStop ? "tightened to" : "still"}{" "}
        <strong className="text-down">−{stop}</strong>, same 15:30 / {index.expiryWeekday} 14:00
        cut-off.
      </p>
      <MidWeekdayGrid
        compact
        grid={stats.grid}
        targetPoints={pts}
        stopPoints={stop}
        runKey={stats.runKey}
        sessionDates={stats.sessionDates}
      />
    </MidGridAccordion>
  );
}

/**
 * Weekday × signal-time grid of the same mid-session trades: columns are the day of the week,
 * rows are the half-hour the signal bar started in. Cells are tinted by win rate so a bucket
 * that leans one way stands out.
 */
function MidWeekdayGrid({
  grid,
  targetPoints,
  stopPoints,
  runKey,
  sessionDates,
  compact = false,
}: {
  grid: NineFifteenMidGrid;
  targetPoints: number;
  stopPoints: number;
  runKey: string;
  sessionDates: string[];
  /** When true, skip the standalone heading — the parent accordion already labels this run. */
  compact?: boolean;
}) {
  const index = useBacktestIndex();
  const [selected, setSelected] = useState<{ slot: number; weekday: number } | null>(null);

  const tint = (cell: NineFifteenMidGridCell): CSSProperties | undefined => {
    if (cell.winPct == null) return undefined;
    const edge = cell.winPct - 50;
    const alpha = Math.min(0.28, Math.abs(edge) / 130);
    return {
      backgroundColor: edge >= 0 ? `rgba(74, 222, 128, ${alpha})` : `rgba(248, 113, 113, ${alpha})`,
    };
  };

  const cellBody = (cell: NineFifteenMidGridCell) => {
    const total = cell.wins + cell.losses;
    if (total === 0) return <span className="text-muted">—</span>;

    const winPct = (cell.wins / total) * 100;
    const lossPct = (cell.losses / total) * 100;
    const stopped = cell.losses - cell.timedOut;
    const riskBase = cell.wins * targetPoints + stopped * stopPoints;
    const netEdgePct =
      riskBase > 0 ? (cell.netPoints / riskBase) * 100 : (cell.netPoints / (total * targetPoints)) * 100;

    return (
      <>
        <span className="font-mono">
          <span className="text-up">{formatNumber(winPct, 0)}%</span>
          <span className="text-muted"> / </span>
          <span className="text-down">{formatNumber(lossPct, 0)}%</span>
        </span>
        <span className="nf-mid-grid-sub">
          <span className="text-up">{cell.wins}W</span>
          <span className="text-muted"> · </span>
          <span className="text-down">{cell.losses}L</span>
        </span>
        <span
          className={cn(
            "nf-mid-grid-sub",
            netEdgePct >= 0 ? "text-up" : "text-down",
          )}
        >
          {netEdgePct >= 0 ? "+" : "−"}
          {formatNumber(Math.abs(netEdgePct), 0)}% net
        </span>
      </>
    );
  };

  return (
    <div className="nf-mid-grid-block">
      {!compact && (
        <>
          <h3 className="nf-mid-grid-title">Win rate by weekday and signal time</h3>
          <p className="nf-cepe-steps text-muted">
            The same trades as above, bucketed by the <strong>day of the week</strong> across and the{" "}
            <strong>{grid.slotMinutes}-minute slot the signal bar started in</strong> down. Each cell
            shows <span className="text-up">win %</span> / <span className="text-down">loss %</span>,
            then <span className="text-up">W</span> / <span className="text-down">L</span> trade counts,
            then <strong>net edge %</strong> — points booked as a share of the +{targetPoints} wins and
            −{stopPoints} stops actually taken. Green cells sit above 50% wins, red below, and the tint
            deepens the further from an even split — though small buckets swing on noise, so read the
            counts before the colour. The <strong>14:30–15:00</strong> row is blank on{" "}
            <strong>{index.expiryWeekday}s</strong> (14:00 cut-off).{" "}
            <strong>Click any cell</strong> to list every
            session behind it, including the days that never fired a signal.
          </p>
        </>
      )}
      {compact && (
        <p className="nf-cepe-steps text-muted">
          Win % / loss %, then trade counts, then net edge % (green above 50% wins, red below).{" "}
          <strong>Click any cell</strong> to list every session in that bucket.
        </p>
      )}
      <div className="nf-failures-table-wrap">
        <table className="nf-failures-table nf-mid-grid">
          <thead>
            <tr>
              <th>Signal time</th>
              {grid.weekdays.map((day) => (
                <th key={day} className="text-center">
                  {day}
                </th>
              ))}
              <th className="text-center">All days</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, slotIndex) => (
              <tr key={row.fromIst}>
                <td className="font-mono text-sm">
                  {row.fromIst}–{row.toIst}
                </td>
                {row.cells.map((cell, i) => {
                  const weekday = grid.weekdays[i];
                  const inactive = row.inactiveWeekdays?.includes(weekday);
                  const isSelected = selected?.slot === slotIndex && selected?.weekday === i;
                  return (
                    <td
                      key={weekday}
                      className={cn(
                        "text-center",
                        isSelected && "nf-mid-grid-selected",
                        inactive && "nf-mid-grid-inactive",
                      )}
                      style={inactive ? undefined : tint(cell)}
                    >
                      {inactive ? (
                        <span
                          className="text-muted"
                          title={`${index.expiryWeekday} cut-off at 14:00 — no slot`}
                        >
                          —
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="nf-mid-grid-cell-btn"
                          aria-pressed={isSelected}
                          title={`${weekday} ${row.fromIst}–${row.toIst} — show every session`}
                          onClick={() =>
                            setSelected(isSelected ? null : { slot: slotIndex, weekday: i })
                          }
                        >
                          {cellBody(cell)}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td className="text-center nf-mid-grid-total">{cellBody(row.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="font-mono text-sm nf-mid-grid-total">All slots</td>
              {grid.columnTotals.map((cell, i) => (
                <td key={grid.weekdays[i]} className="text-center nf-mid-grid-total">
                  {cellBody(cell)}
                </td>
              ))}
              <td className="text-center nf-mid-grid-total">{cellBody(grid.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {selected && (
        <MidBucketSessions
          grid={grid}
          runKey={runKey}
          sessionDates={sessionDates}
          slotIndex={selected.slot}
          weekdayIndex={selected.weekday}
          targetPoints={targetPoints}
          stopPoints={stopPoints}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * Trade rows for one mid-backtest run, fetched the first time a grid cell is expanded. Shipping
 * all ~50 runs' rows with the page cost ~50 MB for detail almost nobody opens, so they now load
 * on demand and stay cached for the rest of the session.
 */
const midTradeRowCache = new Map<string, NineFifteenMidTradeRow[]>();

function useMidTradeRows(runKey: string): {
  rows: NineFifteenMidTradeRow[];
  status: "loading" | "ready" | "error";
} {
  const index = useBacktestIndex();
  const cacheKey = `${index.key}:${runKey}`;
  const cached = midTradeRowCache.get(cacheKey);
  const [rows, setRows] = useState<NineFifteenMidTradeRow[]>(cached ?? []);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(cached ? "ready" : "loading");

  useEffect(() => {
    const hit = midTradeRowCache.get(cacheKey);
    if (hit) {
      setRows(hit);
      setStatus("ready");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    fetch(
      `/api/kite/mid-trade-rows?index=${encodeURIComponent(index.key)}&run=${encodeURIComponent(runKey)}`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: NineFifteenMidTradeRow[] };
        return body.data ?? [];
      })
      .then((loaded) => {
        midTradeRowCache.set(cacheKey, loaded);
        if (cancelled) return;
        setRows(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, index.key, runKey]);

  return { rows, status };
}

/** "HH:MM" or "HH:MM:SS" → minutes past midnight. */
function minutesFromIstTime(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Every session behind one weekday × time-slot cell, including the days that never produced a
 * signal — the honest denominator behind a bucket's win rate.
 */
function MidBucketSessions({
  grid,
  runKey,
  sessionDates,
  slotIndex,
  weekdayIndex,
  targetPoints,
  stopPoints,
  onClose,
}: {
  grid: NineFifteenMidGrid;
  runKey: string;
  sessionDates: string[];
  slotIndex: number;
  weekdayIndex: number;
  targetPoints: number;
  stopPoints: number;
  onClose: () => void;
}) {
  const { rows, status } = useMidTradeRows(runKey);
  const slot = grid.rows[slotIndex];
  const weekday = grid.weekdays[weekdayIndex];
  const windowStart = minutesFromIstTime(grid.rows[0].fromIst);

  const dates = sessionDates.filter((date) => formatWeekdayFromDateKey(date) === weekday);
  const byDate = new Map<string, NineFifteenMidTradeRow[]>();
  for (const row of rows) {
    const inSlot =
      Math.floor((minutesFromIstTime(row.signalTimeIst) - windowStart) / grid.slotMinutes) ===
      slotIndex;
    if (!inSlot || formatWeekdayFromDateKey(row.date) !== weekday) continue;
    const list = byDate.get(row.date);
    if (list) list.push(row);
    else byDate.set(row.date, [row]);
  }

  const signals = [...byDate.values()].flat();
  const wins = signals.filter((row) => row.outcome === "target").length;
  const losses = signals.length - wins;
  const quietDays = dates.length - byDate.size;

  return (
    <div className="nf-mid-drill">
      <div className="nf-mid-drill-head">
        <h4 className="nf-mid-drill-title">
          {weekday} · {slot.fromIst}–{slot.toIst} — every session
        </h4>
        <button type="button" className="nf-mid-drill-close" onClick={onClose}>
          Close
        </button>
      </div>
      {status === "loading" && (
        <p className="nf-cepe-steps text-muted">Loading trades for this bucket…</p>
      )}
      {status === "error" && (
        <p className="nf-cepe-steps text-down">
          Could not load the trades for this bucket. Reload the page and try again.
        </p>
      )}
      {status === "ready" && (
      <>
      <p className="nf-cepe-steps text-muted">
        {dates.length} {weekday}s in the sample fired{" "}
        <strong>
          {signals.length} signal{signals.length === 1 ? "" : "s"}
        </strong>{" "}
        in this window — <span className="text-up">{wins} profit</span> ·{" "}
        <span className="text-down">{losses} loss</span> — and{" "}
        <strong>{quietDays}</strong> of them never produced one, so the win rate on this cell rests
        on {signals.length} trade{signals.length === 1 ? "" : "s"}, not {dates.length} days.
      </p>
      <div className="nf-failures-table-wrap">
        <table className="nf-failures-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Signal</th>
              <th className="text-right">Bar move</th>
              <th>Side</th>
              <th className="text-right">Entry price</th>
              <th>Result</th>
              <th className="text-right">Detail</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((date) => {
              const dayRows = byDate.get(date);
              if (!dayRows) {
                return (
                  <tr key={date} className="nf-mid-drill-quiet">
                    <td className="font-mono text-sm">{date}</td>
                    <td className="text-muted" colSpan={6}>
                      No {grid.slotMinutes}-min-window signal — no bar moved far enough
                    </td>
                  </tr>
                );
              }
              return dayRows.map((row) => (
                <tr key={`${date}-${row.signalTimeIst}`}>
                  <td className="font-mono text-sm">{date}</td>
                  <td className="font-mono text-sm">{row.signalTimeIst}</td>
                  <td
                    className={cn(
                      "text-right font-mono text-sm",
                      row.signalMovePts > 0 ? "text-up" : "text-down",
                    )}
                  >
                    {row.signalMovePts >= 0 ? "+" : ""}
                    {formatNumber(row.signalMovePts, 2)}
                  </td>
                  <td>
                    <span className={row.side === "CE" ? "text-up" : "text-down"}>{row.side}</span>
                  </td>
                  <td className="text-right font-mono text-sm">
                    {formatNumber(row.entryIndexPrice, 2)}
                  </td>
                  <td>
                    {row.outcome === "target" ? (
                      <span className="text-up">
                        <strong>Profit</strong>{" "}
                        <span className="font-mono text-sm">
                          hit +{targetPoints} at {row.exitTimeIst} · {row.minutesToExit}m after
                          entry
                        </span>
                      </span>
                    ) : row.outcome === "stop" ? (
                      <span className="text-down">
                        <strong>Loss</strong>{" "}
                        <span className="font-mono text-sm">
                          stopped at −{stopPoints} · {row.exitTimeIst} · {row.minutesToExit}m
                        </span>
                      </span>
                    ) : (
                      <span className="text-down">
                        <strong>Loss</strong>{" "}
                        <span className="font-mono text-sm">
                          never hit target · squared off {row.deadlineIst.slice(0, 5)}
                          {row.timeoutMovePts != null &&
                            ` at ${row.timeoutMovePts >= 0 ? "+" : ""}${formatNumber(row.timeoutMovePts, 2)}`}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="text-right text-sm">
                    {row.outcome === "target" ? (
                      <span className="text-up">
                        ran{" "}
                        <span className="font-mono">+{formatNumber(row.beyondTargetPts ?? 0, 2)}</span>{" "}
                        further before square-off
                      </span>
                    ) : (
                      <span className="text-down">
                        best was{" "}
                        <span className="font-mono">+{formatNumber(row.maxFavourablePts, 2)}</span> —
                        left{" "}
                        <span className="font-mono">
                          {formatNumber(row.shortOfTargetPts ?? 0, 2)}
                        </span>{" "}
                        short of target
                      </span>
                    )}
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

function BreakoutBacktestSection({
  breakout,
  historyLabel,
}: {
  breakout: NineFifteenBreakoutStats;
  historyLabel: string;
}) {
  const index = useBacktestIndex();
  const sc = (points: number) => points * index.pointScale;
  const expiryDay = index.expiryWeekday;
  const winPctDelta = breakout.winPct - breakout.baseWinPct;
  const stopFromLabel = breakout.stopActiveFromIst?.slice(0, 5) ?? "12:01";
  const stopExpiryLabel = breakout.stopActiveFromIstTuesday?.slice(0, 5) ?? "11:01";
  const title = `Breakout backtest — stop ±${breakout.stopMainPoints} main / ±${breakout.stopNearMissPoints} near-miss from ${stopFromLabel} IST (${stopExpiryLabel} ${shortWeekday(expiryDay)}) (${historyLabel})`;

  return (
    <div className="card nf-cepe-guide">
      <h2 className="card-title">{title}</h2>
      <p className="nf-cepe-rule">
        Backtest study only. The live 9:16 bot has no stop-loss and is not affected by anything in this
        section.
      </p>
      <p className="nf-cepe-steps text-muted">
        <strong>Identical to the live backtest above:</strong> the 9:15 bar picks the direction, entry is
        the <strong>9:16:00 Kite open</strong>, UP → CE and DOWN → PE. On other weekdays the index
        targets are tiered (main{" "}
        <strong>
          ±{sc(25)} → ±{sc(20)}@10:01 → ±{sc(15)}@11:01
        </strong>
        , near-miss{" "}
        <strong>
          ±{sc(20)} → ±{sc(10)}@10:01
        </strong>
        ). On <strong>{expiryDay}</strong> both bands use a flat <strong>±{sc(10)}</strong> from the
        9:16 entry with no tiering. <strong>The one addition</strong> is a stop
        measured from the 9:16 entry price that stays fixed all day: <strong>±{breakout.stopMainPoints}</strong> on the main
        band and <strong>±{breakout.stopNearMissPoints}</strong> on the near-miss band. The stop is only
        checked from <strong>{stopFromLabel} IST</strong> onward (
        <strong>
          {stopExpiryLabel} IST on {expiryDay}
        </strong>
        ) — adverse moves before that time do not
        trigger an exit. A CE buy is stopped when the index trades{" "}
        <strong>{breakout.stopMainPoints} points below</strong> entry; a PE buy when it trades{" "}
        <strong>{breakout.stopMainPoints} points above</strong>. Whichever active level the index touches
        first ends the trade. When a single 1-min candle covers both levels the stop is counted first,
        because minute OHLC cannot show which side was touched earlier.
      </p>

      <div className="card nf-filter-stats">
        <h3 className="nf-filter-stats-title">
          {breakout.tradeDays} trades over {breakout.sampleDays} NSE sessions (Kite)
        </h3>
        <p className="nf-filter-stats-source text-muted">
          Same trade days as the consolidated live backtest — only the exit differs.
        </p>
        <div className="nf-filter-stats-grid">
          <div>
            <span className="nf-filter-stat-label">Trades taken</span>
            <span className="nf-filter-stat-value">{breakout.tradeDays}</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Target hit first</span>
            <span className="nf-filter-stat-value text-up">{breakout.wins}</span>
            <span className="nf-filter-stat-hint text-muted">
              {formatNumber(breakout.winPct, 2)}% of trades
            </span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Stopped out</span>
            <span className="nf-filter-stat-value text-down">{breakout.stopped}</span>
            <span className="nf-filter-stat-hint text-muted">
              {breakout.missedWins.length} were wins · {breakout.stoppedLosses.length} were losses anyway
            </span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Still open at 15:30</span>
            <span className="nf-filter-stat-value">{breakout.openAtClose}</span>
            <span className="nf-filter-stat-hint text-muted">Neither level touched</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Win rate with stop</span>
            <span className="nf-filter-stat-value">{formatNumber(breakout.winPct, 2)}%</span>
          </div>
          <div>
            <span className="nf-filter-stat-label">Win rate without stop</span>
            <span className="nf-filter-stat-value">{formatNumber(breakout.baseWinPct, 2)}%</span>
            <span
              className={cn(
                "nf-filter-stat-hint",
                winPctDelta >= 0 ? "text-up" : "text-down",
              )}
            >
              {winPctDelta >= 0 ? "+" : "−"}
              {formatNumber(Math.abs(winPctDelta), 2)} pts from the stop
            </span>
          </div>
        </div>
      </div>

      <div className="nf-failures-block">
        <h3 className="nf-failures-title">Winning trades missed because of the stop</h3>
        <p className="nf-failures-intro text-muted">
          These days did eventually reach their index target, so the backtest above counts them as wins.
          But the index first moved {breakout.stopMainPoints} points (main) or{" "}
          {breakout.stopNearMissPoints} points (near-miss) against the trade{" "}
          <strong>
            from {stopFromLabel} IST onward ({stopExpiryLabel} IST on {expiryDay})
          </strong>
          , so the breakout rule would have exited at a loss before the target arrived.{" "}
          <strong>Exit index</strong> is the actual {index.shortLabel} price on the stop minute (bar
          low for CE · bar high for PE). <strong>Exit − stop</strong> is the gap from the stop level
          (entry ±{breakout.stopMainPoints} or ±{breakout.stopNearMissPoints}) in index points. Each
          row also shows when {index.shortLabel} came nearest to the tiered profit target during the
          session, with the exact price and points remaining to the target level. Expand for the
          full-day 1-min chart.
        </p>
        {breakout.missedWins.length === 0 ? (
          <p className="text-muted text-sm">No winning trade was stopped out.</p>
        ) : (
          <BreakoutTradesAccordion
            trades={breakout.missedWins}
            kind="missed-win"
            stopActiveFromIst={breakout.stopActiveFromIst}
            stopActiveFromIstTuesday={breakout.stopActiveFromIstTuesday}
          />
        )}
      </div>

      <div className="nf-failures-block">
        <h3 className="nf-failures-title">Losing trades that hit the stop</h3>
        <p className="nf-failures-intro text-muted">
          These days never reached their target, so they are losses either way. The breakout rule would have
          cut them at the minute shown. <strong>Exit index</strong> is the actual{" "}
          {index.shortLabel} price on that minute;
          <strong> Exit − stop</strong> shows how far beyond the stop level (entry ±{breakout.stopMainPoints}{" "}
          or ±{breakout.stopNearMissPoints}) the index moved. Rows show when {index.shortLabel} came
          nearest to the profit target during the session (time · price · pts from target). Expand
          for the full-day 1-min chart.
        </p>
        {breakout.stoppedLosses.length === 0 ? (
          <p className="text-muted text-sm">No losing trade hit the stop.</p>
        ) : (
          <BreakoutTradesAccordion
            trades={breakout.stoppedLosses}
            kind="stopped-loss"
            stopActiveFromIst={breakout.stopActiveFromIst}
            stopActiveFromIstTuesday={breakout.stopActiveFromIstTuesday}
          />
        )}
      </div>
    </div>
  );
}

function scaledTarget(niftyBaseline: number, pointScale: number): number {
  return Math.round(niftyBaseline * pointScale);
}

/** Tighter consolidated exits — same entries, lower take-profit tiers. */
function tighterConsolidatedTargets(pointScale: number) {
  return {
    main1: scaledTarget(20, pointScale),
    main2: scaledTarget(50 / 3, pointScale),
    main3: scaledTarget(35 / 3, pointScale),
    near1: scaledTarget(50 / 3, pointScale),
    near2: scaledTarget(20 / 3, pointScale),
    expiry: scaledTarget(10, pointScale),
  };
}

function SmallBodyPointGridCellView({ cell }: { cell: SmallBodyPointGridCell }) {
  if (cell.trades === 0) {
    return <span className="nf-point-grid-empty">—</span>;
  }

  const parts: string[] = [];
  if (cell.wins > 0) parts.push(`${cell.wins} win${cell.wins === 1 ? "" : "s"} (${cell.winDates.join(", ")})`);
  if (cell.losses > 0) parts.push(`${cell.losses} loss${cell.losses === 1 ? "" : "es"} (${cell.lossDates.join(", ")})`);

  return (
    <span className="nf-point-grid-ticks" title={parts.join(" · ")}>
      {Array.from({ length: cell.wins }, (_, i) => (
        <Check key={`w-${i}`} size={15} className="nf-point-grid-check" aria-label="Win" />
      ))}
      {Array.from({ length: cell.losses }, (_, i) => (
        <X key={`l-${i}`} size={15} className="nf-point-grid-loss" aria-label="Loss" />
      ))}
    </span>
  );
}

function SmallBodyPointWinOnlyCellView({ cell }: { cell: SmallBodyPointGridCell }) {
  if (cell.wins === 0) {
    return <span className="nf-point-grid-empty">—</span>;
  }

  return (
    <span
      className="nf-point-grid-ticks"
      title={`${cell.wins} win${cell.wins === 1 ? "" : "s"}: ${cell.winDates.join(", ")}`}
    >
      {Array.from({ length: cell.wins }, (_, i) => (
        <Check key={`w-${i}`} size={15} className="nf-point-grid-check" aria-label="Win" />
      ))}
    </span>
  );
}

function SmallBodySplitTradeMapGrid({ stats }: { stats: NineFifteenCePeStrategyStats }) {
  const rows = useMemo(
    () => buildSmallBodyPointGrid(stats.successes, stats.failures),
    [stats.successes, stats.failures],
  );

  const putTotals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          wins: acc.wins + row.put.wins,
          losses: acc.losses + row.put.losses,
        }),
        { wins: 0, losses: 0 },
      ),
    [rows],
  );
  const callTotals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          wins: acc.wins + row.call.wins,
          losses: acc.losses + row.call.losses,
        }),
        { wins: 0, losses: 0 },
      ),
    [rows],
  );

  return (
    <div className="nf-small-put-point-grid-wrap">
      <h4 className="nf-small-put-point-grid-title">Split rule — all trades</h4>
      <p className="nf-filter-stats-source text-muted nf-small-put-point-grid-hint">
        Side by |Δ| size: <strong>0–{SMALL_BODY_PUT_MAX_INCLUSIVE} PUT</strong> ·{" "}
        <strong>{SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 CALL</strong>.{" "}
        <span className="nf-point-grid-legend">
          <Check size={13} className="nf-point-grid-check" aria-hidden /> win
        </span>{" "}
        <span className="nf-point-grid-legend">
          <X size={13} className="nf-point-grid-loss" aria-hidden /> loss
        </span>
      </p>
      <table className="nf-small-put-point-grid">
        <thead>
          <tr>
            <th scope="col" className="nf-point-grid-yhead">
              |Δ|
            </th>
            <th scope="col">PUT</th>
            <th scope="col">CALL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.point}>
              <th scope="row" className="nf-point-grid-y font-mono">
                {row.point}
              </th>
              <td className="nf-point-grid-cell">
                <SmallBodyPointGridCellView cell={row.put} />
              </td>
              <td className="nf-point-grid-cell">
                <SmallBodyPointGridCellView cell={row.call} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="nf-point-grid-total-row">
            <th scope="row">Total</th>
            <td className="nf-point-grid-cell font-mono">
              <span className="text-up">{putTotals.wins}W</span>
              {" · "}
              <span className="text-down">{putTotals.losses}L</span>
            </td>
            <td className="nf-point-grid-cell font-mono">
              <span className="text-up">{callTotals.wins}W</span>
              {" · "}
              <span className="text-down">{callTotals.losses}L</span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SmallBodyDirectionWinsOnlyGrid({ stats }: { stats: NineFifteenCePeStrategyStats }) {
  const rows = useMemo(
    () => buildSmallBodyDirectionWinPointGrid(stats.successes),
    [stats.successes],
  );

  const putWins = useMemo(
    () => rows.reduce((sum, row) => sum + row.put.wins, 0),
    [rows],
  );
  const callWins = useMemo(
    () => rows.reduce((sum, row) => sum + row.call.wins, 0),
    [rows],
  );

  return (
    <div className="nf-small-put-point-grid-wrap">
      <h4 className="nf-small-put-point-grid-title">Follow candle — wins only</h4>
      <p className="nf-filter-stats-source text-muted nf-small-put-point-grid-hint">
        <strong>UP → CALL</strong> · <strong>DOWN → PUT</strong> @ 9:16 (0–10.9 |Δ|). Only winning
        days shown.{" "}
        <span className="nf-point-grid-legend">
          <Check size={13} className="nf-point-grid-check" aria-hidden /> win
        </span>
      </p>
      <table className="nf-small-put-point-grid">
        <thead>
          <tr>
            <th scope="col" className="nf-point-grid-yhead">
              |Δ|
            </th>
            <th scope="col">PUT</th>
            <th scope="col">CALL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.point}>
              <th scope="row" className="nf-point-grid-y font-mono">
                {row.point}
              </th>
              <td className="nf-point-grid-cell">
                <SmallBodyPointWinOnlyCellView cell={row.put} />
              </td>
              <td className="nf-point-grid-cell">
                <SmallBodyPointWinOnlyCellView cell={row.call} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="nf-point-grid-total-row">
            <th scope="row">Total</th>
            <td className="nf-point-grid-cell font-mono text-up">{putWins}W</td>
            <td className="nf-point-grid-cell font-mono text-up">{callWins}W</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function SmallBodyPointGridsRow({
  splitStats,
  directionStats,
}: {
  splitStats: NineFifteenCePeStrategyStats;
  directionStats?: NineFifteenCePeStrategyStats;
}) {
  return (
    <div className="nf-small-put-point-grids">
      <SmallBodySplitTradeMapGrid stats={splitStats} />
      {directionStats ? <SmallBodyDirectionWinsOnlyGrid stats={directionStats} /> : null}
    </div>
  );
}

function SmallBodySplitBucketGrid({
  bucket,
}: {
  bucket: NineFifteenSmallBodySplitBuckets["put"];
}) {
  const sideLabel = bucket.side === "PE" ? "PUT" : "CALL";
  return (
    <div className="nf-small-put-bucket">
      <h4 className="nf-small-put-bucket-title">
        {sideLabel} — |Δ| {bucket.rangeLabel}
      </h4>
      <div className="nf-filter-stats-grid nf-small-put-bucket-grid">
        <div>
          <span className="nf-filter-stat-label">Entries</span>
          <span className="nf-filter-stat-value">{bucket.trades}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Wins</span>
          <span className="nf-filter-stat-value text-up">{bucket.wins}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Losses</span>
          <span className="nf-filter-stat-value text-down">{bucket.losses}</span>
        </div>
        <div>
          <span className="nf-filter-stat-label">Win rate</span>
          <span className="nf-filter-stat-value">{formatNumber(bucket.winPct, 1)}%</span>
        </div>
      </div>
    </div>
  );
}

function ConsolidatedBacktestResults({
  consolidated,
  consolidatedFilter,
  followFilterStats,
  nearMissFollowFilterStats,
  guideTargetPoints,
  historyLabel,
  sessions,
  liveFloor,
  showHourlyWinBreakdown,
  showAlt20After1010OnLoss,
  winIntro,
  lossIntro,
  footnote,
  winHeading = "Winning trades — live consolidated (both bands)",
  lossTitle = "Loss trades — live consolidated",
  smallBodyPutStats,
  smallBodySplitBuckets,
  smallBodyPutFilterStats,
  smallBodyDirectionFollow,
  candleMetric = "body",
  redOnlyWeekdaySignal = false,
  minAbsDiffExclusive = false,
}: {
  consolidated: NineFifteenCePeStrategyStats;
  consolidatedFilter: NineFifteenFollowFilterStats;
  followFilterStats: NineFifteenFollowFilterStats;
  nearMissFollowFilterStats?: NineFifteenFollowFilterStats;
  guideTargetPoints: number;
  historyLabel: string;
  sessions: number;
  liveFloor: number;
  showHourlyWinBreakdown?: boolean;
  showAlt20After1010OnLoss?: boolean;
  winIntro: ReactNode;
  lossIntro: ReactNode;
  /** Replaces the default band summary line above the stats card. */
  footnote?: ReactNode;
  winHeading?: string;
  lossTitle?: string;
  smallBodyPutStats?: NineFifteenCePeStrategyStats;
  smallBodyPutFilterStats?: NineFifteenFollowFilterStats;
  smallBodySplitBuckets?: NineFifteenSmallBodySplitBuckets;
  smallBodyDirectionFollow?: NineFifteenCePeStrategyStats;
  candleMetric?: WeekdayNineFifteenMetric;
  redOnlyWeekdaySignal?: boolean;
  minAbsDiffExclusive?: boolean;
}) {
  return (
    <>
      <p className="nf-cepe-footnote text-muted">
        {footnote ?? (
          <>
            Consolidated taken trades: {consolidated.targetHits}/{consolidated.tradeDays} won (
            {formatNumber(consolidated.targetHitPct, 1)}%). {consolidatedFilter.skippedSmallBar}{" "}
            directional days skipped live (|Δ| &lt; {liveFloor})
            {smallBodyPutStats && smallBodyPutFilterStats ? (
              <>
                {" "}
                — small-body split @ 9:16 (
                <strong>0–{SMALL_BODY_PUT_MAX_INCLUSIVE} PE</strong> ·{" "}
                <strong>{SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 CE</strong>): {smallBodyPutStats.targetHits}/
                {smallBodyPutStats.tradeDays} won (
                {formatNumber(smallBodyPutStats.targetHitPct, 1)}%, main-band exits
                {smallBodySplitBuckets ? (
                  <>
                    {" "}
                    · PE {smallBodySplitBuckets.put.wins}/{smallBodySplitBuckets.put.trades} · CE{" "}
                    {smallBodySplitBuckets.call.wins}/{smallBodySplitBuckets.call.trades}
                  </>
                ) : null}
                )
              </>
            ) : null}
            . Main band ≥{followFilterStats.minAbsDiff} trades: {followFilterStats.filteredTrades}{" "}
            · near-miss band: {nearMissFollowFilterStats?.filteredTrades ?? "—"} trades.
          </>
        )}
      </p>

      <FollowFilterStatsCard
        stats={consolidatedFilter}
        sessionsLabel={`${sessions} sessions · ${historyLabel}`}
      />

      <FollowStrategyWinsPanel
        stats={consolidated}
        targetPoints={guideTargetPoints}
        minAbsDiff={liveFloor}
        showHourlyBreakdown={showHourlyWinBreakdown}
        heading={winHeading}
        winIntro={winIntro}
        hourlyHitRuleLabel="when the band’s index exit was first hit"
        smallBodyPutStats={smallBodyPutStats}
        smallBodySplitBuckets={smallBodySplitBuckets}
        candleMetric={candleMetric}
        redOnlyWeekdaySignal={redOnlyWeekdaySignal}
        minAbsDiffExclusive={minAbsDiffExclusive}
      />

      {smallBodyPutStats && smallBodyPutFilterStats && (
        <div className="card nf-filter-stats nf-small-put-stats">
          <h3 className="nf-filter-stats-title">
            Small-body split backtest — 0–10.9 |9:15 Δ|
          </h3>
          <p className="nf-filter-stats-source text-muted">
            Live bot skips these days. Backtest @ <strong>9:16:00</strong>:{" "}
            <strong>0–{SMALL_BODY_PUT_MAX_INCLUSIVE} → PE</strong>,{" "}
            <strong>{SMALL_BODY_CE_MIN_INCLUSIVE}–10.9 → CE</strong>, with the same main-band exits
            as |Δ| ≥ 15 (±25 → ±20@10:01 → ±15@11:01).
          </p>
          {smallBodySplitBuckets ? (
            <div className="nf-small-put-buckets">
              <SmallBodySplitBucketGrid bucket={smallBodySplitBuckets.put} />
              <SmallBodySplitBucketGrid bucket={smallBodySplitBuckets.call} />
            </div>
          ) : null}
          <div className="nf-filter-stats-grid nf-small-put-combined">
            <div>
              <span className="nf-filter-stat-label">Combined entries</span>
              <span className="nf-filter-stat-value">{smallBodyPutStats.tradeDays}</span>
              <span className="nf-filter-stat-hint text-muted">0–10.9 |Δ|</span>
            </div>
            <div>
              <span className="nf-filter-stat-label">Wins</span>
              <span className="nf-filter-stat-value text-up">{smallBodyPutStats.targetHits}</span>
            </div>
            <div>
              <span className="nf-filter-stat-label">Losses</span>
              <span className="nf-filter-stat-value text-down">
                {smallBodyPutStats.tradeDays - smallBodyPutStats.targetHits}
              </span>
            </div>
            <div>
              <span className="nf-filter-stat-label">Win rate</span>
              <span className="nf-filter-stat-value">
                {formatNumber(smallBodyPutStats.targetHitPct, 1)}%
              </span>
            </div>
          </div>
          <SmallBodyPointGridsRow
            splitStats={smallBodyPutStats}
            directionStats={smallBodyDirectionFollow}
          />
        </div>
      )}

      {(consolidated.failures ?? []).length > 0 && (
        <div className="nf-failures-block">
          <h3 className="nf-failures-title">{lossTitle}</h3>
          <p className="nf-failures-intro text-muted">{lossIntro}</p>
          <StrategyFailuresPanel
            stats={consolidated}
            targetPoints={guideTargetPoints}
            minAbsDiff={liveFloor}
            showAlt20After1010={showAlt20After1010OnLoss}
          />
        </div>
      )}
    </>
  );
}

function NiftyConfirm917StrategyBlock({
  niftyConfirm917Follow,
  niftyConfirm917FilterStats,
  followFilterStats,
  guideTargetPoints,
  historyLabel,
  sessions,
  liveFloor,
  showHourlyWinBreakdown,
  main915,
  main916,
  titleSuffix,
}: {
  niftyConfirm917Follow: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats: NineFifteenFollowFilterStats;
  followFilterStats: NineFifteenFollowFilterStats;
  guideTargetPoints: number;
  historyLabel: string;
  sessions: number;
  liveFloor: number;
  showHourlyWinBreakdown?: boolean;
  main915: number;
  main916: number;
  titleSuffix?: string;
}) {
  return (
    <div className="nf-consolidated-alt-block">
      <h3 className="nf-consolidated-alt-title">
        Two-candle confirmation — entry at 9:17{titleSuffix ? ` · ${titleSuffix}` : ""} ({historyLabel})
      </h3>
      <p className="nf-cepe-steps text-muted">
        Both the 9:15 and 9:16 candles must point the same way before anything is bought, and the
        entry is the <strong>9:17:00 open</strong>. Main rule:{" "}
        <strong>9:15 Δ &gt; +{main915}</strong> and <strong>9:16 Δ &gt; +{main916}</strong> → buy CE ·{" "}
        <strong>9:15 Δ &lt; −{main915}</strong> and <strong>9:16 Δ &lt; −{main916}</strong> → buy PE. A day where
        the 9:16 candle flips colour is skipped entirely. Exits run from the 9:17 entry price: ±15
        until 10:01 · ±10 from 10:02–11:01 · ±5 from 11:02 onwards.
      </p>
      <ConsolidatedBacktestResults
        consolidated={niftyConfirm917Follow}
        consolidatedFilter={niftyConfirm917FilterStats}
        followFilterStats={followFilterStats}
        guideTargetPoints={guideTargetPoints}
        historyLabel={historyLabel}
        sessions={sessions}
        liveFloor={liveFloor}
        showHourlyWinBreakdown={showHourlyWinBreakdown}
        showAlt20After1010OnLoss={false}
        footnote={
          <>
            Confirmed trades: {niftyConfirm917Follow.targetHits}/{niftyConfirm917Follow.tradeDays}{" "}
            won ({formatNumber(niftyConfirm917Follow.targetHitPct, 1)}%).{" "}
            {niftyConfirm917FilterStats.skippedSmallBar} directional days skipped — either the 9:15
            bar was too small or the 9:16 bar failed to confirm.
          </>
        }
        winIntro={
          <>
            UP → CE, DOWN → PE, both candles confirming. Entry ={" "}
            <strong>9:17:00 Kite open</strong>. Win on ±15 before 10:02 / ±10 from 10:02–11:01 /
            ±5 from 11:02 onwards.
          </>
        }
        lossIntro={
          <>
            Both candles confirmed and the trade was entered at 9:17, but the tiered exit never
            printed (±15 → ±10@10:02 → ±5@11:02). Expand a day for the full-session{" "}
            <strong>1-min candle chart</strong> (9:15–15:30).
          </>
        }
      />
    </div>
  );
}

function RedPeMainBacktestSection({
  follow,
  filterStats,
  guideTargetPoints,
  historyLabel = "last 1 year",
  sessions,
  showHourlyWinBreakdown,
  showAlt20After1010OnLoss,
}: {
  follow: NineFifteenCePeStrategyStats;
  filterStats: NineFifteenFollowFilterStats;
  guideTargetPoints: number;
  historyLabel?: string;
  sessions: number;
  showHourlyWinBreakdown?: boolean;
  showAlt20After1010OnLoss?: boolean;
}) {
  const index = useBacktestIndex();
  const sc = (points: number) => points * index.pointScale;
  const mainBand = filterStats.minAbsDiff;
  const exclusive = filterStats.minAbsDiffExclusive === true;
  const sizeCompare = exclusive ? ">" : "≥";
  const skippedLabel = exclusive ? `|Δ| ≤ ${mainBand}` : `|Δ| < ${mainBand}`;
  const expiryDay = index.expiryWeekday;

  return (
    <div className="card nf-cepe-guide nf-red-pe-main-first">
      <h2 className="card-title">
        Red 9:15 · |Δ| {sizeCompare} {mainBand} — PE @ 9:16 ({historyLabel})
      </h2>
      <p className="nf-cepe-steps text-muted">
        Filtered to <strong>red 9:15 candles only</strong> with{" "}
        <strong>|Δ| {sizeCompare} {sc(mainBand)}</strong> (9:15 open − close). Entry ={" "}
        <strong>PE BUY @ 9:16:00 Kite open</strong>. Main-band index exits: ±{sc(25)} / ±
        {sc(20)}@10:01 / ±{sc(15)}@11:01 · <strong>{expiryDay}</strong> flat ±{sc(10)} from 9:16.
        Backtest only — live bot unchanged.
      </p>
      <ConsolidatedBacktestResults
        consolidated={follow}
        consolidatedFilter={filterStats}
        followFilterStats={filterStats}
        guideTargetPoints={guideTargetPoints}
        historyLabel={historyLabel}
        sessions={sessions}
        liveFloor={filterStats.minAbsDiff}
        minAbsDiffExclusive={exclusive}
        showHourlyWinBreakdown={showHourlyWinBreakdown}
        showAlt20After1010OnLoss={showAlt20After1010OnLoss}
        redOnlyWeekdaySignal
        footnote={
          <>
            Red · |Δ| {sizeCompare} {mainBand} only: {follow.targetHits}/{follow.tradeDays} won (
            {formatNumber(follow.targetHitPct, 1)}%). {filterStats.skippedSmallBar} red days skipped (
            {skippedLabel}). Green and flat 9:15 days are not traded.
          </>
        }
        winIntro={
          <>
            Red 9:15 only · <strong>PE @ 9:16:00 Kite open</strong>. Win when Nifty hits the main-band
            exit: ±{sc(25)} before 10:01 / ±{sc(20)} from 10:01 / ±{sc(15)} from 11:01 ·{" "}
            <strong>{expiryDay}</strong> flat ±{sc(10)} from 9:16.
          </>
        }
        lossIntro={
          <>
            Red 9:15 with |Δ| {sizeCompare} {mainBand}; PE entered at 9:16 but the main-band index
            exit never hit. Expand a day for the full-session{" "}
            <strong>1-min candle chart</strong> (9:15–15:30).
          </>
        }
        winHeading="Winning trades — red 9:15 · PE @ 9:16"
        lossTitle="Loss trades — red 9:15 · PE @ 9:16"
      />
    </div>
  );
}

function CePeStrategyTable({
  guide,
  totalDays,
  followFilterStats,
  nearMissFollow,
  nearMissFollowFilterStats,
  liveConsolidatedFollow,
  liveConsolidatedFilterStats,
  liveSmallBodyPutFollow,
  liveSmallBodyPutFilterStats,
  liveSmallBodySplitBuckets,
  liveSmallBodyDirectionFollow,
  liveConsolidatedFollowAlt,
  liveConsolidatedFilterStatsAlt,
  niftyConfirm917Follow,
  niftyConfirm917FilterStats,
  niftyConfirm917Follow11,
  niftyConfirm917FilterStats11,
  headingSuffix,
  historyLabel = "last 1 year",
  sessionsCount,
  showHourlyWinBreakdown,
  showAlt20After1010OnLoss,
}: {
  guide: NineFifteenCePeGuide;
  totalDays: number;
  followFilterStats: NineFifteenFollowFilterStats;
  nearMissFollow?: NineFifteenCePeStrategyStats;
  nearMissFollowFilterStats?: NineFifteenFollowFilterStats;
  liveConsolidatedFollow?: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStats?: NineFifteenFollowFilterStats;
  liveSmallBodyPutFollow?: NineFifteenCePeStrategyStats;
  liveSmallBodyPutFilterStats?: NineFifteenFollowFilterStats;
  liveSmallBodySplitBuckets?: NineFifteenSmallBodySplitBuckets;
  liveSmallBodyDirectionFollow?: NineFifteenCePeStrategyStats;
  liveConsolidatedFollowAlt?: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStatsAlt?: NineFifteenFollowFilterStats;
  niftyConfirm917Follow?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats?: NineFifteenFollowFilterStats;
  niftyConfirm917Follow11?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats11?: NineFifteenFollowFilterStats;
  /** e.g. " · |9:15 Δ| ≥ 15" — shown in card title */
  headingSuffix?: string;
  historyLabel?: string;
  /** NSE session rows from Kite in this block's sample */
  sessionsCount?: number;
  showHourlyWinBreakdown?: boolean;
  showAlt20After1010OnLoss?: boolean;
}) {
  const index = useBacktestIndex();
  const sc = (points: number) => points * index.pointScale;
  const expiryDay = index.expiryWeekday;
  const tp = guide.targetPoints;
  const follow = guide.followDirection;
  const sessions = sessionsCount ?? totalDays;
  const titleExtra = headingSuffix ?? " · live dual-band";
  const nearMin = nearMissFollowFilterStats?.minAbsDiff ?? 11;
  const nearMax = nearMissFollowFilterStats?.maxAbsDiffExclusive ?? 15;
  const mainBand = followFilterStats.minAbsDiff;
  const nearFloor = nearMissFollowFilterStats?.minAbsDiff ?? nearMin;
  const nearCeiling = nearMissFollowFilterStats?.maxAbsDiffExclusive ?? nearMax;
  const liveFloor = liveConsolidatedFilterStats?.minAbsDiff ?? 11;
  const consolidated = liveConsolidatedFollow;
  const consolidatedFilter = liveConsolidatedFilterStats;
  const consolidatedAlt = liveConsolidatedFollowAlt;
  const consolidatedFilterAlt = liveConsolidatedFilterStatsAlt;
  const tighter = tighterConsolidatedTargets(index.pointScale);

  return (
    <div className="card nf-cepe-guide">
      <h2 className="card-title">
        Live bot backtest — consolidated ({historyLabel}){titleExtra}
      </h2>
      <p className="nf-cepe-rule">{guide.entryRule}</p>
      <p className="nf-cepe-steps text-muted">
        <strong>Steps:</strong> (1) Live bot: first WS tick in <strong>9:15:00–9:15:15</strong> = open, last tick before{" "}
        <strong>9:16:00</strong> = close; enter at <strong>9:16:00</strong> if |Δ| ≥ {liveFloor}. (2) Green → CE; red →
        PE. (3) Exits by band:{" "}
        <>
          <strong>|Δ| ≥ {sc(15)}</strong> → ±{sc(25)} / ±{sc(20)}@10:01 / ±{sc(15)}@11:01 ·{" "}
          <strong>{sc(11)} ≤ |Δ| &lt; {sc(15)}</strong> → ±{sc(20)} / ±{sc(10)}@10:01 ·{" "}
          <strong>{expiryDay}</strong> → flat ±{sc(10)} from 9:16 (both bands).
        </>{" "}
        Sample: <strong>{sessions}</strong> sessions (Kite).
      </p>

      {consolidated && consolidatedFilter && (
        <ConsolidatedBacktestResults
          consolidated={consolidated}
          consolidatedFilter={consolidatedFilter}
          followFilterStats={followFilterStats}
          nearMissFollowFilterStats={nearMissFollowFilterStats}
          guideTargetPoints={tp}
          historyLabel={historyLabel}
          sessions={sessions}
          liveFloor={liveFloor}
          showHourlyWinBreakdown={showHourlyWinBreakdown}
          showAlt20After1010OnLoss={showAlt20After1010OnLoss}
          smallBodyPutStats={liveSmallBodyPutFollow}
          smallBodyPutFilterStats={liveSmallBodyPutFilterStats}
          smallBodySplitBuckets={liveSmallBodySplitBuckets}
          smallBodyDirectionFollow={liveSmallBodyDirectionFollow}
          winIntro={
            <>
              UP → CE, DOWN → PE. Entry = <strong>9:16:00 Kite open</strong>.{" "}
              <strong>|Δ| ≥ {sc(15)}:</strong> win on ±{sc(25)} before 10:01 / ±{sc(20)} from
              10:01 / ±{sc(15)} from 11:01.{" "}
              <strong>
                {sc(11)} ≤ |Δ| &lt; {sc(15)}:
              </strong>{" "}
              win on ±{sc(20)} before 10:01 / ±{sc(10)} from 10:01.{" "}
              <strong>{expiryDay}:</strong> flat ±{sc(10)} from 9:16 (both bands).
            </>
          }
          lossIntro={
            <>
              Entered at 9:16; never hit that day’s band exit (main tiered, near-miss ±{sc(20)}→±
              {sc(10)}, or {expiryDay} ±{sc(10)}).
              Expand a day for the full-session <strong>1-min candle chart</strong> (9:15–15:30).
            </>
          }
        />
      )}

      {consolidatedAlt && consolidatedFilterAlt && (
        <div className="nf-consolidated-alt-block">
          <h3 className="nf-consolidated-alt-title">
            Consolidated — tighter take-profit ({historyLabel})
          </h3>
          <p className="nf-cepe-steps text-muted">
            Same entries as above. Only the index take-profit tiers change: main band{" "}
            <strong>|Δ| ≥ {mainBand}</strong> → ±{tighter.main1} / ±{tighter.main2}@10:01 / ±
            {tighter.main3}@11:01 · near-miss{" "}
            <strong>
              {nearFloor} ≤ |Δ| &lt; {nearCeiling}
            </strong>{" "}
            → ±{tighter.near1} / ±{tighter.near2}@10:01 · <strong>{expiryDay}</strong> → flat ±
            {tighter.expiry} from 9:16 (both bands).
          </p>
          <ConsolidatedBacktestResults
            consolidated={consolidatedAlt}
            consolidatedFilter={consolidatedFilterAlt}
            followFilterStats={followFilterStats}
            nearMissFollowFilterStats={nearMissFollowFilterStats}
            guideTargetPoints={tp}
            historyLabel={historyLabel}
            sessions={sessions}
            liveFloor={liveFloor}
            showHourlyWinBreakdown={showHourlyWinBreakdown}
            showAlt20After1010OnLoss={false}
            winIntro={
              <>
                UP → CE, DOWN → PE. Entry = <strong>9:16:00 Kite open</strong>.{" "}
                <strong>|Δ| ≥ {mainBand}:</strong> win on ±{tighter.main1} before 10:01 / ±
                {tighter.main2} from 10:01 / ±{tighter.main3} from 11:01.{" "}
                <strong>
                  {nearFloor} ≤ |Δ| &lt; {nearCeiling}:
                </strong>{" "}
                win on ±{tighter.near1} before 10:01 / ±{tighter.near2} from 10:01.{" "}
                <strong>{expiryDay}:</strong> flat ±{tighter.expiry} from 9:16 (both bands).
              </>
            }
            lossIntro={
              <>
                Entered at 9:16; never hit the tighter band exit (main ±{tighter.main1}→±
                {tighter.main2}→±{tighter.main3}, near-miss ±{tighter.near1}→±{tighter.near2}, or{" "}
                {expiryDay} ±{tighter.expiry}).
                Expand a day for the full-session <strong>1-min candle chart</strong> (9:15–15:30).
              </>
            }
          />
        </div>
      )}

      {niftyConfirm917Follow && niftyConfirm917FilterStats && (
        <NiftyConfirm917StrategyBlock
          niftyConfirm917Follow={niftyConfirm917Follow}
          niftyConfirm917FilterStats={niftyConfirm917FilterStats}
          followFilterStats={followFilterStats}
          guideTargetPoints={tp}
          historyLabel={historyLabel}
          sessions={sessions}
          liveFloor={liveFloor}
          showHourlyWinBreakdown={showHourlyWinBreakdown}
          main915={30}
          main916={10}
        />
      )}

      {niftyConfirm917Follow11 && niftyConfirm917FilterStats11 && (
        <NiftyConfirm917StrategyBlock
          niftyConfirm917Follow={niftyConfirm917Follow11}
          niftyConfirm917FilterStats={niftyConfirm917FilterStats11}
          followFilterStats={followFilterStats}
          guideTargetPoints={tp}
          historyLabel={historyLabel}
          sessions={sessions}
          liveFloor={liveFloor}
          showHourlyWinBreakdown={showHourlyWinBreakdown}
          main915={11}
          main916={10}
          titleSuffix="9:15 |Δ| > 11"
        />
      )}

      <details className="nf-band-breakdown">
        <summary className="nf-band-breakdown-summary">
          Band breakdown — main (|Δ| ≥ {followFilterStats.minAbsDiff}) and near-miss ({nearMin} ≤ |Δ| &lt; {nearMax})
        </summary>

        <div className="nf-strategy-table-wrap">
          <table className="nf-strategy-table">
            <thead>
              <tr>
                <th>Rule (backtested)</th>
                <th className="text-right">Trading days</th>
                <th className="text-right">Trades</th>
                {NINE_FIFTEEN_TIME_CHECKPOINTS.map((cp) => (
                  <th key={cp} className="text-right">
                    By {cp}
                  </th>
                ))}
                <th className="text-right">Full day</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              <StrategyRow stats={follow} targetPoints={tp} />
              {nearMissFollow && (
                <StrategyRow stats={nearMissFollow} targetPoints={nearMissFollowFilterStats?.targetPoints ?? 20} />
              )}
            </tbody>
          </table>
        </div>

        <h3 className="nf-nearmiss-title">
          Main band — |9:15 Δ| ≥ {followFilterStats.minAbsDiff} (±{sc(25)} → ±{sc(20)}@10:01 → ±
          {sc(15)}@11:01)
        </h3>
        <FollowFilterStatsCard stats={followFilterStats} sessionsLabel={`${sessions} sessions · ${historyLabel}`} />

        <FollowStrategyWinsPanel
          stats={follow}
          targetPoints={tp}
          minAbsDiff={followFilterStats.minAbsDiff}
          showHourlyBreakdown={showHourlyWinBreakdown}
        />

        {(follow.failures ?? []).some((t) => Math.abs(t.change) >= followFilterStats.minAbsDiff) && (
          <div className="nf-failures-block">
            <h3 className="nf-failures-title">
              Loss trades — main band (|9:15 Δ| ≥ {followFilterStats.minAbsDiff})
            </h3>
            <p className="nf-failures-intro text-muted">
              Entered at 9:16 open; never hit tiered index exit (±{sc(25)} → ±{sc(20)} @10:01 → ±
              {sc(15)} @11:01).
            </p>
            <StrategyFailuresPanel
              stats={follow}
              targetPoints={tp}
              minAbsDiff={followFilterStats.minAbsDiff}
              showAlt20After1010={showAlt20After1010OnLoss}
            />
          </div>
        )}

        {nearMissFollow && nearMissFollowFilterStats && (
          <div className="nf-nearmiss-block">
            <h3 className="nf-nearmiss-title">
              Near-miss band — {nearMin} ≤ |9:15 Δ| &lt; {nearMax} (±{sc(20)} → ±{sc(10)}@10:01)
            </h3>
            <FollowFilterStatsCard
              stats={nearMissFollowFilterStats}
              sessionsLabel={`${sessions} sessions · ${historyLabel}`}
            />

            <FollowStrategyWinsPanel
              stats={nearMissFollow}
              targetPoints={nearMissFollowFilterStats.targetPoints}
              minAbsDiff={nearMin}
              maxAbsDiffExclusive={nearMax}
              showHourlyBreakdown={showHourlyWinBreakdown}
              heading={`Winning trades — near-miss (${nearMin} ≤ |9:15 Δ| < ${nearMax})`}
              winIntro={
                <>
                  UP → CE, DOWN → PE. Win if ±{sc(20)} before 10:01 or ±{sc(10)} from 10:01 (Kite
                  bars from 9:16).
                </>
              }
              hourlyHitRuleLabel={`when ±${sc(20)} (before 10:01) or ±${sc(10)} (from 10:01) was first hit`}
            />

            {(nearMissFollow.failures ?? []).length > 0 && (
              <div className="nf-failures-block">
                <h3 className="nf-failures-title">
                  Loss trades — near-miss ({nearMin} ≤ |9:15 Δ| &lt; {nearMax})
                </h3>
                <StrategyFailuresPanel
                  stats={nearMissFollow}
                  targetPoints={nearMissFollowFilterStats.targetPoints}
                  minAbsDiff={nearMin}
                  maxAbsDiffExclusive={nearMax}
                  switchTarget={{ afterIst: "10:01:00", points: sc(10) }}
                />
              </div>
            )}
          </div>
        )}
      </details>
    </div>
  );
}

function gatewayErrorMessage(status: number): string {
  if (status === 502 || status === 504) {
    return "Backtest is still building a year of minute data on the server (this can take a few minutes on a cold cache). Wait a moment and hit Refresh — the result is cached once it finishes.";
  }
  return `Failed to load 9:15 candles (HTTP ${status})`;
}

export default function BacktestingPage() {
  const { connected, loginUrl } = useKite();
  const [data, setData] = useState<NineFifteenCandlesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = refresh
        ? `?days=${BACKTEST_HISTORY_DAYS}&refresh=1`
        : `?days=${BACKTEST_HISTORY_DAYS}`;
      const res = await fetch(`/api/kite/nine-fifteen-candles${qs}`, { credentials: "include" });
      const body = await res.text();
      let json: { data?: NineFifteenCandlesResult; error?: string } | null = null;
      try {
        json = JSON.parse(body) as { data?: NineFifteenCandlesResult; error?: string };
      } catch {
        // Gateway errors (502/504) return an HTML page, not JSON.
        json = null;
      }
      if (!res.ok || !json) {
        throw new Error(json?.error ?? gatewayErrorMessage(res.status));
      }
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
    },
    [],
  );

  useEffect(() => {
    if (connected) void load(false);
  }, [connected, load]);

  return (
    <DashboardShell>
      <BacktestIndexProvider>
      <BacktestSessionsProvider rows={data?.rows ?? []}>
      <div className="nine-fifteen-page">
        <header className="page-header nf-header">
          <div>
            <h1 className="page-title">
              <TrendingUp size={22} />
              Backtesting
            </h1>
            <p className="page-subtitle">
              Nifty 50 · 9:15 follow strategy · Zerodha Kite minute data · ~{NSE_SESSIONS_ONE_YEAR} sessions ≈ 1y
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

        {loading && !data && (
          <div className="card nf-loading">
            <RefreshCw size={18} className="spin" />
            Loading ~1 year of Zerodha Kite sessions (first load can take a minute)…
          </div>
        )}

        {data && (
          <>
            <div className="nf-summary-grid">
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Trading days</span>
                <span className="nf-summary-value">{data.summary.total}</span>
                <span className="nf-summary-hint">
                  {data.fromDate} → {data.toDate} · {data.nseSessionsOneYear} Kite sessions
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

                {data.liveRedPeMainFollow && data.liveRedPeMainFilterStats && (
                  <RedPeMainBacktestSection
                    follow={data.liveRedPeMainFollow}
                    filterStats={data.liveRedPeMainFilterStats}
                    guideTargetPoints={data.cePeGuide.targetPoints}
                    historyLabel="last 1 year · dual-band live exits"
                    sessions={data.nseSessionsOneYear}
                    showHourlyWinBreakdown
                    showAlt20After1010OnLoss
                  />
                )}

                {data.liveRedPeBody10Follow && data.liveRedPeBody10FilterStats && (
                  <RedPeMainBacktestSection
                    follow={data.liveRedPeBody10Follow}
                    filterStats={data.liveRedPeBody10FilterStats}
                    guideTargetPoints={data.cePeGuide.targetPoints}
                    historyLabel="last 1 year · dual-band live exits"
                    sessions={data.nseSessionsOneYear}
                    showHourlyWinBreakdown
                    showAlt20After1010OnLoss
                  />
                )}

                <CePeStrategyTable
                  guide={data.cePeGuide}
                  totalDays={data.summary.total}
                  followFilterStats={data.followFilterStats}
                  nearMissFollow={data.nearMissFollow}
                  nearMissFollowFilterStats={data.nearMissFollowFilterStats}
                  liveConsolidatedFollow={data.liveConsolidatedFollow}
                  liveConsolidatedFilterStats={data.liveConsolidatedFilterStats}
                  liveSmallBodyPutFollow={data.liveSmallBodyPutFollow}
                  liveSmallBodyPutFilterStats={data.liveSmallBodyPutFilterStats}
                  liveSmallBodySplitBuckets={data.liveSmallBodySplitBuckets}
                  liveSmallBodyDirectionFollow={data.liveSmallBodyDirectionFollow}
                  liveConsolidatedFollowAlt={data.liveConsolidatedFollowAlt}
                  liveConsolidatedFilterStatsAlt={data.liveConsolidatedFilterStatsAlt}
                  niftyConfirm917Follow={data.niftyConfirm917Follow}
                  niftyConfirm917FilterStats={data.niftyConfirm917FilterStats}
                  niftyConfirm917Follow11={data.niftyConfirm917Follow11}
                  niftyConfirm917FilterStats11={data.niftyConfirm917FilterStats11}
                  historyLabel="last 1 year · dual-band live exits"
                  sessionsCount={data.nseSessionsOneYear}
                  showHourlyWinBreakdown
                  showAlt20After1010OnLoss
                />

                {data.tuesdayTenPoint && (
                  <TuesdayTenPointSection
                    stats={data.tuesdayTenPoint}
                    historyLabel="last 1 year"
                  />
                )}

                {data.breakout && (
                  <BreakoutBacktestSection
                    breakout={data.breakout}
                    historyLabel="last 1 year"
                  />
                )}

                {data.midBacktest1m && (
                  <MidBacktestSection
                    stats={data.midBacktest1m}
                    statsTp15={data.midBacktest1mTp15}
                    statsBySignalAndStop={data.midBacktest1mTp10BySignalAndStop}
                    statsMove10Tp5ByStop={data.midBacktest1mMove10Tp5ByStop}
                    statsTwoCandleByStop={data.midBacktest1mTwoCandleTp10ByStop}
                    statsExhaustion10ByStop={data.midBacktest1mExhaustion10Tp10ByStop}
                    statsExhaustion5ByStop={data.midBacktest1mExhaustion5Tp10ByStop}
                    historyLabel="last 1 year"
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
      </BacktestSessionsProvider>
      </BacktestIndexProvider>
    </DashboardShell>
  );
}
