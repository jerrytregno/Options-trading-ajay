import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  Minus,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import {
  BacktestIndexProvider,
  useBacktestIndex,
} from "@/contexts/backtest-index-context";
import {
  backtestDaysForSessions,
  NSE_SESSIONS_ONE_YEAR,
  NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
  NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
  type NineFifteenCePeFailureTrade,
  type NineFifteenAltTargetAfterTime,
  type NineFifteenCePeStrategyStats,
  type NineFifteenCandlesResult,
  type NineFifteenFollowFilterStats,
} from "@/types/nine-fifteen";
import { cn, formatNumber } from "@/lib/utils";
import { formatWeekdayFromDateKey } from "@/lib/market-time";
import { trade915EntrySize } from "@/lib/nine-sixteen-body-buckets";
import { LossTradesAccordion, LateWinTradesAccordion } from "@/components/nine-fifteen/LossTradesAccordion";
import "@/styles/nine-fifteen-page.css";

const BACKTEST_WINDOWS = [
  { id: "1m", label: "1 month", sessions: 22, historyLabel: "last 1 month" },
  { id: "3m", label: "3 months", sessions: 63, historyLabel: "last 3 months" },
  { id: "6m", label: "6 months", sessions: 126, historyLabel: "last 6 months" },
  { id: "1y", label: "1 year", sessions: NSE_SESSIONS_ONE_YEAR, historyLabel: "last 1 year" },
  { id: "2y", label: "2 years", sessions: NSE_SESSIONS_ONE_YEAR * 2, historyLabel: "last 2 years" },
] as const;

type BacktestWindowId = (typeof BACKTEST_WINDOWS)[number]["id"];

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
  const skipped916Label =
    stats.display?.skipped916Label ?? "Skipped (9:16 not red confirm)";
  const redConfirmLabel =
    stats.display?.redConfirmLabel ?? "9:16 open ≤ 9:15 close (flat −12 from 9:16)";
  const greenGapLabel =
    stats.display?.greenGapLabel ?? "9:16 green gap (flat −8 from 9:16)";

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
        {stats.redConfirmFlat15Trades != null && (
          <div>
            <span className="nf-filter-stat-label">{redConfirmLabel}</span>
            <span className="nf-filter-stat-value">{stats.redConfirmFlat15Trades}</span>
          </div>
        )}
        {stats.greenGapFlat10Trades != null && stats.greenGapFlat10Trades > 0 && (
          <div>
            <span className="nf-filter-stat-label">{greenGapLabel}</span>
            <span className="nf-filter-stat-value">{stats.greenGapFlat10Trades}</span>
          </div>
        )}
        {stats.redConfirmMainBandTrades != null && stats.redConfirmFlat15Trades == null && (
          <div>
            <span className="nf-filter-stat-label">{redConfirmLabel}</span>
            <span className="nf-filter-stat-value">{stats.redConfirmMainBandTrades}</span>
          </div>
        )}
        {stats.greenGapFlat15Trades != null &&
          stats.greenGapFlat15Trades > 0 &&
          stats.greenGapFlat10Trades == null && (
          <div>
            <span className="nf-filter-stat-label">{greenGapLabel}</span>
            <span className="nf-filter-stat-value">{stats.greenGapFlat15Trades}</span>
          </div>
        )}
        {stats.skipped916Confirm != null && stats.skipped916Confirm > 0 && (
          <div>
            <span className="nf-filter-stat-label">{skipped916Label}</span>
            <span className="nf-filter-stat-value">{stats.skipped916Confirm}</span>
          </div>
        )}
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
  const nrmlWins = failures.filter((t) => t.nrmlCarry?.wouldWin).length;
  const nrmlWithData = failures.filter((t) => t.nrmlCarry != null).length;

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
          {nrmlWithData > 0
            ? ` · NRML to next ${nrmlWins > 0 ? `${nrmlWins}/${nrmlWithData} won` : `${nrmlWithData} still loss`} (Tue 15:00)`
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
        <WinHourlyBreakdown
          wins={wins}
          targetPoints={targetPoints}
          hitRuleLabel={
            hourlyHitRuleLabel ??
            "when ±25 / ±20@10:01 / ±15@11:01 was first hit"
          }
        />
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
      <LateWinTradesAccordion trades={wins} targetPoints={targetPoints} />
    </div>
  );
}


function ConsolidatedBacktestResults({
  consolidated,
  consolidatedFilter,
  guideTargetPoints,
  historyLabel,
  sessions,
  liveFloor,
  showHourlyWinBreakdown,
  showAlt20After1010OnLoss,
  winIntro,
  lossIntro,
  footnote,
  winHeading = "Winning trades",
  lossTitle = "Loss trades",
  minAbsDiffExclusive = false,
  hourlyHitRuleLabel,
}: {
  consolidated: NineFifteenCePeStrategyStats;
  consolidatedFilter: NineFifteenFollowFilterStats;
  guideTargetPoints: number;
  historyLabel: string;
  sessions: number;
  liveFloor: number;
  showHourlyWinBreakdown?: boolean;
  showAlt20After1010OnLoss?: boolean;
  winIntro: ReactNode;
  lossIntro: ReactNode;
  footnote?: ReactNode;
  winHeading?: string;
  lossTitle?: string;
  minAbsDiffExclusive?: boolean;
  hourlyHitRuleLabel?: string;
}) {
  return (
    <>
      <p className="nf-cepe-footnote text-muted">
        {footnote ?? (
          <>
            {consolidated.targetHits}/{consolidated.tradeDays} won (
            {formatNumber(consolidated.targetHitPct, 1)}%). {consolidatedFilter.skippedSmallBar}{" "}
            days skipped (|Δ| &lt; {liveFloor})
            {consolidatedFilter.skipped916Confirm != null && consolidatedFilter.skipped916Confirm > 0 ? (
              <>
                {" "}
                · {consolidatedFilter.skipped916Confirm} skipped — 9:16 open did not confirm 9:15 color
              </>
            ) : null}
            .
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
        hourlyHitRuleLabel={hourlyHitRuleLabel ?? "when the band’s index exit was first hit"}
        minAbsDiffExclusive={minAbsDiffExclusive}
      />

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


export type NineSixteenBacktestVariant = "red" | "green";

/** Copy for the red PE study and its green CE mirror — same rules, opposite colour and sign. */
const NINE_SIXTEEN_VARIANT_COPY = {
  red: {
    title: NINE_FIFTEEN_RED_916_BACKTEST_TITLE,
    colour: "red",
    Colour: "Red",
    opposite: "green",
    Opposite: "Green",
    side: "PE",
    sign: "−",
    confirmCmp: "≤",
    gapCmp: ">",
    bodyDiff: "9:15 open − close",
    gapVerb: "gaps up",
    gapWhere: "above",
  },
  green: {
    title: NINE_FIFTEEN_GREEN_916_BACKTEST_TITLE,
    colour: "green",
    Colour: "Green",
    opposite: "red",
    Opposite: "Red",
    side: "CE",
    sign: "+",
    confirmCmp: "≥",
    gapCmp: "<",
    bodyDiff: "9:15 close − open",
    gapVerb: "gaps down",
    gapWhere: "below",
  },
} as const;

function Hybrid916BacktestSection({
  variant,
  follow,
  filterStats,
  guideTargetPoints,
  historyLabel = "last 1 year",
  sessions,
  showHourlyWinBreakdown,
  showAlt20After1010OnLoss,
  secondCandleFlatExits,
  bothSameOnly = false,
}: {
  variant: NineSixteenBacktestVariant;
  follow: NineFifteenCePeStrategyStats;
  filterStats: NineFifteenFollowFilterStats;
  guideTargetPoints: number;
  historyLabel?: string;
  sessions: number;
  showHourlyWinBreakdown?: boolean;
  showAlt20After1010OnLoss?: boolean;
  /** When set, 9:16 second-candle split: flat `confirm` when both candles match, flat `gap` when 9:16 flips. */
  secondCandleFlatExits?: { confirm: number; gap: number };
  /** Only days where the 9:16 open keeps the 9:15 colour — excludes the gap second candle. */
  bothSameOnly?: boolean;
}) {
  const index = useBacktestIndex();
  const v = NINE_SIXTEEN_VARIANT_COPY[variant];
  const sc = (points: number) => points * index.pointScale;
  const mainBand = filterStats.minAbsDiff;
  const exclusive = filterStats.minAbsDiffExclusive === true;
  const sizeCompare = exclusive ? ">" : "≥";
  const skippedLabel = exclusive ? `|Δ| ≤ ${mainBand}` : `|Δ| < ${mainBand}`;
  const expiryDay = index.expiryWeekday;
  const flatConfirm = secondCandleFlatExits?.confirm ?? 12;
  const flatGap = secondCandleFlatExits?.gap ?? 8;
  const cardTitle = `${v.title} (${historyLabel})`;

  return (
    <div className="card nf-cepe-guide nf-red-pe-main-first">
      <h2 className="card-title">{cardTitle}</h2>
      <p className="nf-cepe-steps text-muted">
        Filtered to <strong>{v.colour} 9:15 candles only</strong> with{" "}
        <strong>|Δ| {sizeCompare} {sc(mainBand)}</strong> ({v.bodyDiff}).
        {bothSameOnly ? (
          <>
            {" "}
            <strong>Both {v.colour} only</strong> — includes only days where{" "}
            <strong>9:16 open {v.confirmCmp} 9:15 close</strong> (second candle also {v.colour}). {v.Opposite}-gap
            days at 9:16 are excluded. Take profit is a flat{" "}
            <strong>{v.sign}{sc(flatConfirm)} Nifty points</strong> from the 9:16 entry.
          </>
        ) : secondCandleFlatExits ? (
          <>
            {" "}
            When <strong>9:16 open {v.confirmCmp} 9:15 close</strong> (both candles {v.colour}), take profit is a
            flat <strong>{v.sign}{sc(flatConfirm)} Nifty points</strong> from the 9:16 entry. When{" "}
            <strong>9:16 {v.gapVerb}</strong> {v.gapWhere} the 9:15 close ({v.opposite} second candle), take
            profit is a flat <strong>{v.sign}{sc(flatGap)} Nifty points</strong> from entry. No tiered main-band
            exits.
          </>
        ) : (
          <>
            Entry = <strong>{v.side} BUY @ 9:16:00 Kite open</strong>. Main-band index exits: ±{sc(25)} / ±
            {sc(20)}@10:01 / ±{sc(15)}@11:01 · <strong>{expiryDay}</strong> flat ±{sc(10)} from 9:16.
          </>
        )}{" "}
        Backtest only — live bot unchanged.
      </p>
      <ConsolidatedBacktestResults
        consolidated={follow}
        consolidatedFilter={filterStats}
        guideTargetPoints={guideTargetPoints}
        historyLabel={historyLabel}
        sessions={sessions}
        liveFloor={filterStats.minAbsDiff}
        minAbsDiffExclusive={exclusive}
        showHourlyWinBreakdown={showHourlyWinBreakdown}
        showAlt20After1010OnLoss={showAlt20After1010OnLoss}
        footnote={
          <>
            {v.Colour} · |Δ| {sizeCompare} {mainBand}
            {bothSameOnly ? ` · both ${v.colour} only` : secondCandleFlatExits ? " · hybrid 916 exits" : ""}:{" "}
            {follow.targetHits}/{follow.tradeDays} won ({formatNumber(follow.targetHitPct, 1)}%).{" "}
            {filterStats.skippedSmallBar} {v.colour} days skipped ({skippedLabel}).
            {bothSameOnly && filterStats.skipped916Confirm != null && filterStats.skipped916Confirm > 0 && (
              <>
                {" "}
                {filterStats.skipped916Confirm} excluded (9:16 open {v.gapCmp} 9:15 close · {v.opposite} second
                candle).
              </>
            )}
            {!bothSameOnly &&
              secondCandleFlatExits &&
              filterStats.redConfirmFlat15Trades != null &&
              filterStats.greenGapFlat10Trades != null && (
              <>
                {" "}
                {filterStats.redConfirmFlat15Trades} both {v.colour} (flat {v.sign}{flatConfirm}) ·{" "}
                {filterStats.greenGapFlat10Trades} {v.opposite} gap (flat {v.sign}{flatGap}).
              </>
            )}
            {filterStats.redConfirmMainBandTrades != null &&
              filterStats.greenGapFlat15Trades != null &&
              filterStats.redConfirmFlat15Trades == null && (
              <>
                {" "}
                {filterStats.redConfirmMainBandTrades} main-band (9:16 open {v.confirmCmp} 9:15 close) ·{" "}
                {filterStats.greenGapFlat15Trades} {v.opposite} gap (flat {v.sign}{flatGap}).
              </>
            )}
            {filterStats.skipped916Confirm != null &&
              filterStats.skipped916Confirm > 0 &&
              filterStats.redConfirmMainBandTrades == null && (
              <>
                {" "}
                {filterStats.skipped916Confirm} skipped — 9:16 open {v.gapWhere} 9:15 close ({v.opposite} gap at
                open).
              </>
            )}{" "}
            {v.Opposite} and flat 9:15 days are not traded.
          </>
        }
        winIntro={
          <>
            {v.Colour} 9:15 only · <strong>{v.side} @ 9:16:00 Kite open</strong>
            {bothSameOnly
              ? ` · both ${v.colour} only · flat ${v.sign}${flatConfirm} from 9:16 when 9:16 open ${v.confirmCmp} 9:15 close`
              : secondCandleFlatExits
                ? ` · flat ${v.sign}${flatConfirm} when both ${v.colour} · flat ${v.sign}${flatGap} when 9:16 ${v.gapVerb}`
                : ""}
            . Win when Nifty hits the exit:{" "}
            {bothSameOnly || secondCandleFlatExits ? (
              bothSameOnly ? (
                <>
                  flat {v.sign}
                  {sc(flatConfirm)} from 9:16 entry (both candles {v.colour}).
                </>
              ) : (
                <>
                  flat {v.sign}
                  {sc(flatConfirm)} from 9:16 when 9:16 open {v.confirmCmp} 9:15 close, or flat {v.sign}
                  {sc(flatGap)} when 9:16 {v.gapVerb} {v.gapWhere} the 9:15 close.
                </>
              )
            ) : (
              <>
                ±{sc(25)} before 10:01 / ±{sc(20)} from 10:01 / ±{sc(15)} from 11:01 ·{" "}
                <strong>{expiryDay}</strong> flat ±{sc(10)} from 9:16.
              </>
            )}
          </>
        }
        lossIntro={
          <>
            {v.Colour} 9:15 with |Δ| {sizeCompare} {mainBand}
            {bothSameOnly
              ? ` · both ${v.colour} only · flat ${v.sign}${flatConfirm} exit`
              : secondCandleFlatExits
                ? ` · flat ${v.sign}${flatConfirm} or ${v.sign}${flatGap} exit`
                : ""}
            ; {v.side} entered at 9:16 but the index exit never hit same day. Each row shows{" "}
            <strong>Nifty @10:00 IST</strong> vs the exit target, plus{" "}
            <strong>NRML carry</strong> until the next {expiryDay} 15:00 IST. Expand a day for the
            full-session <strong>1-min candle chart</strong> (9:15–15:30).
          </>
        }
        winHeading={`Winning trades — ${v.colour} 9:15 · ${v.side} @ 9:16`}
        lossTitle={`Loss trades — ${v.colour} 9:15 · ${v.side} @ 9:16`}
        hourlyHitRuleLabel={
          bothSameOnly
            ? `when the flat ${v.sign}${flatConfirm} exit was first hit`
            : secondCandleFlatExits
              ? `when the flat ${v.sign}${flatConfirm} or ${v.sign}${flatGap} exit was first hit`
              : "when the band’s index exit was first hit"
        }
      />
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
  return <NineSixteenBacktestView variant="red" />;
}

export function NineSixteenBacktestView({ variant }: { variant: NineSixteenBacktestVariant }) {
  const v = NINE_SIXTEEN_VARIANT_COPY[variant];
  const { connected, loginUrl } = useKite();
  const [data, setData] = useState<NineFifteenCandlesResult | null>(null);
  const [windowId, setWindowId] = useState<BacktestWindowId>("1y");
  const [bothSameOnly, setBothSameOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWindow = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[3];

  const load = useCallback(async (win: (typeof BACKTEST_WINDOWS)[number], refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const days = backtestDaysForSessions(win.sessions);
      const qs = new URLSearchParams({
        days: String(days),
        windowSessions: String(win.sessions),
      });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nine-fifteen-candles?${qs}`, { credentials: "include" });
      const body = await res.text();
      let json: { data?: NineFifteenCandlesResult; error?: string } | null = null;
      try {
        json = JSON.parse(body) as { data?: NineFifteenCandlesResult; error?: string };
      } catch {
        json = null;
      }
      if (!res.ok || !json?.data) {
        throw new Error(json?.error ?? gatewayErrorMessage(res.status));
      }
      if (json.data.nseSessionsOneYear < win.sessions) {
        throw new Error(
          `Only ${json.data.nseSessionsOneYear} sessions loaded (need ${win.sessions}) — hit Refresh to rebuild ${win.label}`,
        );
      }
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    const win = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[3];
    setData(null);
    void load(win, false);
  }, [connected, windowId, load]);

  const historyLabel = `${activeWindow.historyLabel}${bothSameOnly ? ` · both ${v.colour} only` : ""} · dual-band live exits`;
  const busy = loading;

  const hybridFollow =
    variant === "green"
      ? bothSameOnly
        ? data?.liveGreenCeMain916BothGreenFollow
        : data?.liveGreenCeMain916ConfirmFollow
      : bothSameOnly
        ? data?.liveRedPeMain916BothRedFollow
        : data?.liveRedPeMain916ConfirmFollow;
  const hybridFilterStats =
    variant === "green"
      ? bothSameOnly
        ? data?.liveGreenCeMain916BothGreenFilterStats
        : data?.liveGreenCeMain916ConfirmFilterStats
      : bothSameOnly
        ? data?.liveRedPeMain916BothRedFilterStats
        : data?.liveRedPeMain916ConfirmFilterStats;

  return (
    <DashboardShell>
      <BacktestIndexProvider>
      <div className="nine-fifteen-page">
        <header className="page-header nf-header">
          <div>
            <h1 className="page-title">
              <TrendingUp size={22} />
              {v.title}
            </h1>
            <p className="page-subtitle">
              Nifty 50 · {v.title} · Zerodha Kite minute data · {activeWindow.label}
              {data ? ` · ${data.fromDate} → ${data.toDate}` : ""}
            </p>
          </div>
          <div className="nf-header-actions">
            <div className="nf-window-filter" role="group" aria-label="Backtest date range">
              {BACKTEST_WINDOWS.map((win) => (
                <button
                  key={win.id}
                  type="button"
                  className={cn("btn btn-sm", windowId === win.id ? "btn-primary" : "btn-secondary")}
                  disabled={!connected || busy}
                  onClick={() => setWindowId(win.id)}
                >
                  {win.label}
                </button>
              ))}
            </div>
            <label className="nf-both-red-toggle">
              <input
                type="checkbox"
                checked={bothSameOnly}
                disabled={!connected || busy || !data}
                onChange={(e) => setBothSameOnly(e.target.checked)}
              />
              <span>Both {v.colour} only</span>
              <span className="nf-both-red-toggle-hint text-muted">
                9:16 open {v.confirmCmp} 9:15 close — exclude {v.opposite} second candle
              </span>
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!connected || busy}
              onClick={() => void load(activeWindow, true)}
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
              Refresh
            </button>
          </div>
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
            Loading {activeWindow.label} of Zerodha Kite sessions
            {activeWindow.sessions >= NSE_SESSIONS_ONE_YEAR
              ? " (first load can take a few minutes)…"
              : "…"}
          </div>
        )}

        {loading && data && (
          <div className="card nf-loading nf-loading--inline">
            <RefreshCw size={16} className="spin" />
            Updating {activeWindow.label} window…
          </div>
        )}

        {data && (
          <>
            <div className="nf-summary-grid">
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Trading days</span>
                <span className="nf-summary-value">{data.summary.total}</span>
                <span className="nf-summary-hint">
                  {data.fromDate} → {data.toDate} · {data.nseSessionsOneYear} sessions · {activeWindow.label}
                </span>
              </div>
              <div className="card nf-summary-card nf-summary-card--up">
                <span className="nf-summary-label">
                  <TrendingUp size={14} /> Close up — 9:15 green, |Δ| ≥ 15
                </span>
                <span className="nf-summary-value">{data.summary.up}</span>
                <span className="nf-summary-hint">{formatNumber(data.summary.upPct, 1)}% of sessions</span>
              </div>
              <div className="card nf-summary-card nf-summary-card--down">
                <span className="nf-summary-label">
                  <ArrowDownRight size={14} /> Close down — 9:15 red, |Δ| ≥ 15
                </span>
                <span className="nf-summary-value">{data.summary.down}</span>
                <span className="nf-summary-hint">{formatNumber(data.summary.downPct, 1)}% of sessions</span>
              </div>
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Flat close — |Δ| &lt; 15 or doji</span>
                <span className="nf-summary-value">{data.summary.flat}</span>
                <span className="nf-summary-hint">
                  {data.instrument} · {data.summary.total > 0 ? formatNumber((data.summary.flat / data.summary.total) * 100, 1) : "0"}% of sessions
                </span>
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

                {hybridFollow && hybridFilterStats && (
                  <Hybrid916BacktestSection
                    variant={variant}
                    follow={hybridFollow}
                    filterStats={hybridFilterStats}
                    guideTargetPoints={data.cePeGuide.targetPoints}
                    historyLabel={historyLabel}
                    sessions={data.nseSessionsOneYear}
                    showHourlyWinBreakdown
                    showAlt20After1010OnLoss
                    bothSameOnly={bothSameOnly}
                    secondCandleFlatExits={{ confirm: 12, gap: 8 }}
                  />
                )}

              </div>
            )}
          </>
        )}
      </div>
      </BacktestIndexProvider>
    </DashboardShell>
  );
}
