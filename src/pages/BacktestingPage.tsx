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
  NINE_FIFTEEN_TIME_CHECKPOINTS,
  NSE_SESSIONS_ONE_YEAR,
  type NineFifteenBreakoutStats,
  type NineFifteenCePeGuide,
  type NineFifteenCePeFailureTrade,
  type NineFifteenAltTargetAfterTime,
  type NineFifteenCePeStrategyStats,
  type NineFifteenCandlesResult,
  type NineFifteenFollowFilterStats,
} from "@/types/nine-fifteen";
import { cn, formatNumber } from "@/lib/utils";
import { formatWeekdayFromDateKey } from "@/lib/market-time";
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
            <th className="text-right" title="Wilder RSI(14) on 1-min Nifty closes at 9:15 bar">
              RSI(14) @9:15
            </th>
            <th className="text-right" title="Wilder RSI(14) on 1-min Nifty closes at 9:16 bar">
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
                          <> · Nifty {formatNumber(f.maxMovePeakIndex, 2)}</>
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
}: {
  stats: NineFifteenCePeStrategyStats;
  targetPoints: number;
  minAbsDiff: number;
  maxAbsDiffExclusive?: number;
  showHourlyBreakdown?: boolean;
  heading?: string;
  winIntro?: ReactNode;
  hourlyHitRuleLabel?: string;
}) {
  const wins =
    maxAbsDiffExclusive != null
      ? (stats.successes ?? []).filter(
          (t) => Math.abs(t.change) >= minAbsDiff && Math.abs(t.change) < maxAbsDiffExclusive,
        )
      : (stats.successes ?? []).filter((t) => Math.abs(t.change) >= minAbsDiff);
  if (wins.length === 0) return null;

  const bandTitle =
    maxAbsDiffExclusive != null
      ? `Winning trades — near-miss band (${minAbsDiff} ≤ |9:15 Δ| < ${maxAbsDiffExclusive}, ±₹${targetPoints})`
      : `Winning trades — taken only (|9:15 Δ| ≥ ${minAbsDiff}, ±25 → ±20@10:01 → ±15@11:01)`;

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
  const winPctDelta = breakout.winPct - breakout.baseWinPct;
  const stopFromLabel = breakout.stopActiveFromIst?.slice(0, 5) ?? "12:00";
  const title = `Breakout backtest — stop ±${breakout.stopMainPoints} main / ±${breakout.stopNearMissPoints} near-miss from ${stopFromLabel} IST (${historyLabel})`;

  return (
    <div className="card nf-cepe-guide">
      <h2 className="card-title">{title}</h2>
      <p className="nf-cepe-rule">
        Backtest study only. The live 9:16 bot has no stop-loss and is not affected by anything in this
        section.
      </p>
      <p className="nf-cepe-steps text-muted">
        <strong>Identical to the live backtest above:</strong> the 9:15 bar picks the direction, entry is
        the <strong>9:16:00 Kite open</strong>, UP → CE and DOWN → PE, and the index targets are the same
        tiered ones (main <strong>±25 → ±20@10:01 → ±15@11:01</strong>, near-miss{" "}
        <strong>±20 → ±10@10:01</strong>). <strong>The one addition</strong> is a stop measured from the
        9:16 entry price that stays fixed all day: <strong>±{breakout.stopMainPoints}</strong> on the main
        band and <strong>±{breakout.stopNearMissPoints}</strong> on the near-miss band. The stop is only
        checked from <strong>{stopFromLabel} IST</strong> onward — adverse moves before that time do not
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
          <strong>from {stopFromLabel} IST onward</strong>, so the breakout rule would have exited at a
          loss before the target arrived. <strong>Exit index</strong> is the actual Nifty price on the stop
          minute (bar low for CE · bar high for PE). <strong>Exit − stop</strong> is the gap from the stop
          level (entry ±{breakout.stopMainPoints} or ±{breakout.stopNearMissPoints}) in index points.
          Each row also shows when Nifty came nearest to the tiered profit target during the session,
          with the exact Nifty price and points remaining to the target level. Expand for the full-day
          1-min chart.
        </p>
        {breakout.missedWins.length === 0 ? (
          <p className="text-muted text-sm">No winning trade was stopped out.</p>
        ) : (
          <BreakoutTradesAccordion
            trades={breakout.missedWins}
            kind="missed-win"
            stopActiveFromIst={breakout.stopActiveFromIst}
          />
        )}
      </div>

      <div className="nf-failures-block">
        <h3 className="nf-failures-title">Losing trades that hit the stop</h3>
        <p className="nf-failures-intro text-muted">
          These days never reached their target, so they are losses either way. The breakout rule would have
          cut them at the minute shown. <strong>Exit index</strong> is the actual Nifty price on that minute;
          <strong> Exit − stop</strong> shows how far beyond the stop level (entry ±{breakout.stopMainPoints}{" "}
          or ±{breakout.stopNearMissPoints}) the index moved. Rows show when Nifty came nearest to the
          profit target during the session (time · Nifty price · pts from target). Expand for the full-day
          1-min chart.
        </p>
        {breakout.stoppedLosses.length === 0 ? (
          <p className="text-muted text-sm">No losing trade hit the stop.</p>
        ) : (
          <BreakoutTradesAccordion
            trades={breakout.stoppedLosses}
            kind="stopped-loss"
            stopActiveFromIst={breakout.stopActiveFromIst}
          />
        )}
      </div>
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
  /** e.g. " · |9:15 Δ| ≥ 15" — shown in card title */
  headingSuffix?: string;
  historyLabel?: string;
  /** NSE session rows from Kite in this block's sample */
  sessionsCount?: number;
  showHourlyWinBreakdown?: boolean;
  showAlt20After1010OnLoss?: boolean;
}) {
  const tp = guide.targetPoints;
  const follow = guide.followDirection;
  const sessions = sessionsCount ?? totalDays;
  const titleExtra = headingSuffix ?? " · live dual-band";
  const nearMin = nearMissFollowFilterStats?.minAbsDiff ?? 11;
  const nearMax = nearMissFollowFilterStats?.maxAbsDiffExclusive ?? 15;
  const liveFloor = liveConsolidatedFilterStats?.minAbsDiff ?? 11;
  const consolidated = liveConsolidatedFollow;
  const consolidatedFilter = liveConsolidatedFilterStats;

  return (
    <div className="card nf-cepe-guide">
      <h2 className="card-title">
        Live bot backtest — consolidated ({historyLabel}){titleExtra}
      </h2>
      <p className="nf-cepe-rule">{guide.entryRule}</p>
      <p className="nf-cepe-steps text-muted">
        <strong>Steps:</strong> (1) Live bot: first WS tick in <strong>9:15:00–9:15:15</strong> = open, last tick before{" "}
        <strong>9:16:00</strong> = close; enter at <strong>9:16:00</strong> if |Δ| ≥ {liveFloor}. (2) Green → CE; red →
        PE. (3) Exits by band: <strong>|Δ| ≥ 15</strong> → ±25 / ±20@10:01 / ±15@11:01 ·{" "}
        <strong>11 ≤ |Δ| &lt; 15</strong> → ±20 / ±10@10:01. Sample: <strong>{sessions}</strong> NSE sessions (Kite).
      </p>

      {consolidated && consolidatedFilter && (
        <>
          <p className="nf-cepe-footnote text-muted">
            Consolidated taken trades: {consolidated.targetHits}/{consolidated.tradeDays} won (
            {formatNumber(consolidated.targetHitPct, 1)}%). {consolidatedFilter.skippedSmallBar} directional days
            skipped (|Δ| &lt; {liveFloor}). Main band ≥15: {followFilterStats.filteredTrades} trades · near-miss
            band: {nearMissFollowFilterStats?.filteredTrades ?? "—"} trades.
          </p>

          <FollowFilterStatsCard
            stats={consolidatedFilter}
            sessionsLabel={`${sessions} sessions · ${historyLabel}`}
          />

          <FollowStrategyWinsPanel
            stats={consolidated}
            targetPoints={tp}
            minAbsDiff={liveFloor}
            showHourlyBreakdown={showHourlyWinBreakdown}
            heading="Winning trades — live consolidated (both bands)"
            winIntro={
              <>
                UP → CE, DOWN → PE. Entry = <strong>9:16:00 Kite open</strong>.{" "}
                <strong>|Δ| ≥ 15:</strong> win on ±25 before 10:01 / ±20 from 10:01 / ±15 from 11:01.{" "}
                <strong>11 ≤ |Δ| &lt; 15:</strong> win on ±20 before 10:01 / ±10 from 10:01.
              </>
            }
            hourlyHitRuleLabel="when the band’s index exit was first hit"
          />

          {(consolidated.failures ?? []).length > 0 && (
            <div className="nf-failures-block">
              <h3 className="nf-failures-title">Loss trades — live consolidated</h3>
              <p className="nf-failures-intro text-muted">
                Entered at 9:16; never hit that day’s band exit (main tiered or near-miss ±20→±10). Expand a day for
                the full-session <strong>1-min candle chart</strong> (9:15–15:30).
              </p>
              <StrategyFailuresPanel
                stats={consolidated}
                targetPoints={tp}
                minAbsDiff={liveFloor}
                showAlt20After1010={showAlt20After1010OnLoss}
              />
            </div>
          )}
        </>
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
          Main band — |9:15 Δ| ≥ {followFilterStats.minAbsDiff} (±25 → ±20@10:01 → ±15@11:01)
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
              Entered at 9:16 open; never hit tiered index exit (±25 → ±20 @10:01 → ±15 @11:01).
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
              Near-miss band — {nearMin} ≤ |9:15 Δ| &lt; {nearMax} (±20 → ±10@10:01)
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
                  UP → CE, DOWN → PE. Win if ±20 before 10:01 or ±10 from 10:01 (Kite bars from 9:16).
                </>
              }
              hourlyHitRuleLabel="when ±20 (before 10:01) or ±10 (from 10:01) was first hit"
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
                  switchTarget={{ afterIst: "10:01:00", points: 10 }}
                />
              </div>
            )}
          </div>
        )}
      </details>
    </div>
  );
}

export default function BacktestingPage() {
  const { connected, loginUrl } = useKite();
  const [data, setData] = useState<NineFifteenCandlesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = refresh
        ? `?days=${BACKTEST_HISTORY_DAYS}&refresh=1`
        : `?days=${BACKTEST_HISTORY_DAYS}`;
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

                <CePeStrategyTable
                  guide={data.cePeGuide}
                  totalDays={data.summary.total}
                  followFilterStats={data.followFilterStats}
                  nearMissFollow={data.nearMissFollow}
                  nearMissFollowFilterStats={data.nearMissFollowFilterStats}
                  liveConsolidatedFollow={data.liveConsolidatedFollow}
                  liveConsolidatedFilterStats={data.liveConsolidatedFilterStats}
                  historyLabel="last 1 year · dual-band live exits"
                  sessionsCount={data.nseSessionsOneYear}
                  showHourlyWinBreakdown
                  showAlt20After1010OnLoss
                />

                {data.breakout && (
                  <BreakoutBacktestSection
                    breakout={data.breakout}
                    historyLabel="last 1 year"
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardShell>
  );
}
