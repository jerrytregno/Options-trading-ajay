import { useMemo, useState } from "react";
import { Target } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import type {
  NineFifteenFullDayBacktestSlice,
  NineFifteenFullDayTrade,
  NineFifteenHighMinus5Outcome,
} from "@/types/nine-fifteen-high-minus5-backtest";

type OutcomeFilter = "all" | NineFifteenHighMinus5Outcome;

function outcomeLabel(outcome: NineFifteenHighMinus5Outcome): string {
  switch (outcome) {
    case "win":
      return "Win (signal min)";
    case "late_win":
      return "Late win";
    case "loss":
      return "Loss";
    case "no_entry":
      return "No entry";
  }
}

function outcomeClass(outcome: NineFifteenHighMinus5Outcome): string {
  switch (outcome) {
    case "win":
      return "nf915bt-outcome-win";
    case "late_win":
      return "nf915bt-outcome-late";
    case "loss":
      return "nf915bt-outcome-loss";
    case "no_entry":
      return "nf915bt-outcome-skip";
  }
}

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
    <div className="card nf915bt-stat">
      <p className="nf915bt-stat-label">{label}</p>
      <p className={cn("nf915bt-stat-value", tone)}>{value}</p>
      {hint && <p className="nf915bt-stat-hint">{hint}</p>}
    </div>
  );
}

function TradeRow({ trade }: { trade: NineFifteenFullDayTrade }) {
  return (
    <tr>
      <td>{trade.date}</td>
      <td>{trade.weekday}</td>
      <td>{trade.signalTimeIst}</td>
      <td>{formatNumber(trade.signalOpen, 2)}</td>
      <td>{formatNumber(trade.signalClose, 2)}</td>
      <td>{formatNumber(trade.entryLevel, 2)}</td>
      <td>{formatNumber(trade.tpLevel, 2)}</td>
      <td>{trade.entryTimeIst ?? "—"}</td>
      <td>{trade.tpTimeIst ?? "—"}</td>
      <td>
        <span className={cn("nf915bt-outcome-pill", outcomeClass(trade.outcome))}>
          {outcomeLabel(trade.outcome)}
        </span>
      </td>
    </tr>
  );
}

function accordionMeta(slice: NineFifteenFullDayBacktestSlice): string {
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  const parts = [
    `${slice.stats.wins} in signal min`,
    `${slice.stats.lateWins} late`,
    `${slice.stats.losses} loss`,
  ];
  if (slice.stats.noEntry > 0) parts.push(`${slice.stats.noEntry} no entry`);
  parts.push(`${slice.stats.winRatePct}% TP (${entered} entered)`);
  parts.push(`${slice.stats.sessions} signals`);
  return parts.join(" · ");
}

function RulesList({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
}: {
  slice: NineFifteenFullDayBacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
}) {
  const isPlusEntry = slice.rules.variant === "limit_open_plus_5";
  const entrySign = isPlusEntry ? "+" : "−";
  const tpSign = isPlusEntry ? "+" : "−";
  const touchSide = isPlusEntry ? "high" : "low";
  const colour = isPlusEntry ? "green" : "red";

  return (
    <section className="nf915bt-rules card">
      <h3>Rules</h3>
      {subtitle && <p className="nf915bt-section-subtitle">{subtitle}</p>}
      <ul>
        <li>
          <strong>Signal scan</strong> — every 1-minute candle from{" "}
          <strong>{slice.rules.signalScanStartIst}</strong> through{" "}
          <strong>{slice.rules.signalScanEndIst}</strong> IST ({slice.tradingDays} trading days in
          range).
        </li>
        <li>
          <strong>{colour.charAt(0).toUpperCase() + colour.slice(1)} candles only</strong> — only
          minutes that close {isPlusEntry ? "above" : "below"} their open become signals; flat minutes
          are skipped.
        </li>
        <li>
          <strong>Entry</strong> — limit fill when session {touchSide} touches that signal
          candle&apos;s open {entrySign} {slice.rules.entryOffsetFromOpen} pts (full-day study uses entry{" "}
          {tpSign} {slice.rules.tpOffsetFromEntry} for TP — tighter than the 9:15 ± 10 studies).
        </li>
        <li>
          <strong>Take profit</strong> — {slice.rules.tpOffsetFromEntry} pts {tpSign === "+" ? "above" : "below"}{" "}
          the entry fill, scanned through {slice.rules.scanEndIst}.
        </li>
        <li>
          <strong>Win</strong> — TP touched during the signal minute itself.
        </li>
        <li>
          <strong>Late win</strong> — entry filled, TP first touched after the signal minute (time in
          table).
        </li>
        <li>
          <strong>Loss</strong> — entry filled, TP never touched through {slice.rules.scanEndIst}.
        </li>
        <li>
          <strong>Independent signals</strong> — each qualifying minute is its own trade; overlapping
          setups on the same day all count separately.
        </li>
      </ul>
      <p className="nf915bt-muted">
        {rangeLabel} · {slice.stats.sessions} signal minutes · built{" "}
        {new Date(builtAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
      </p>
    </section>
  );
}

function BacktestSectionBody({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
}: {
  slice: NineFifteenFullDayBacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
}) {
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;

  const filterOptions = useMemo(() => {
    const keys: OutcomeFilter[] = ["all", "win", "late_win", "loss", "no_entry"];
    return keys;
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return slice.trades;
    return slice.trades.filter((t) => t.outcome === filter);
  }, [filter, slice.trades]);

  return (
    <>
      <RulesList slice={slice} builtAt={builtAt} rangeLabel={rangeLabel} subtitle={subtitle} />

      <section className="nf915bt-stat-grid">
        <StatCard
          label="Win (signal min)"
          value={String(slice.stats.wins)}
          hint={`${slice.stats.inMinuteWinPct}% of ${entered} entered`}
          tone="text-up"
        />
        <StatCard
          label="Late win"
          value={String(slice.stats.lateWins)}
          hint={`TP after signal minute · through ${slice.rules.scanEndIst}`}
          tone="nf915bt-tone-late"
        />
        <StatCard
          label="Loss"
          value={String(slice.stats.losses)}
          hint="Entered, TP never hit"
          tone="text-down"
        />
        <StatCard
          label="No entry"
          value={String(slice.stats.noEntry)}
          hint={`Open ${slice.rules.variant === "limit_open_plus_5" ? "+" : "−"} ${slice.rules.entryOffsetFromOpen} never touched`}
        />
        <StatCard
          label="TP hit rate"
          value={`${slice.stats.winRatePct}%`}
          hint={`${slice.stats.wins + slice.stats.lateWins} / ${entered} entered`}
        />
        <StatCard
          label="Signal minutes"
          value={String(slice.stats.sessions)}
          hint={`${slice.tradingDays} trading days`}
        />
      </section>

      <section className="card nf915bt-table-section">
        <div className="nf915bt-table-toolbar">
          <h3>
            <Target size={16} /> Signal log
          </h3>
          <div className="nf915bt-filters">
            {filterOptions.map((key) => (
              <button
                key={key}
                type="button"
                className={cn("btn btn-sm", filter === key ? "btn-primary" : "btn-ghost")}
                onClick={() => setFilter(key)}
              >
                {key === "all" ? "All" : outcomeLabel(key as NineFifteenHighMinus5Outcome)}
              </button>
            ))}
          </div>
        </div>
        <div className="nf915bt-table-wrap">
          <table className="nf915bt-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>Signal</th>
                <th>Signal open</th>
                <th>Signal close</th>
                <th>Entry</th>
                <th>TP</th>
                <th>Entry time</th>
                <th>TP time</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="nf915bt-empty">
                    No trades in this filter.
                  </td>
                </tr>
              ) : (
                filtered.slice(0, 500).map((trade) => (
                  <TradeRow key={`${trade.date}-${trade.signalMins}-${trade.entryLevel}`} trade={trade} />
                ))
              )}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <p className="nf915bt-muted nf915bt-table-cap">
              Showing first 500 of {filtered.length} rows — narrow the filter to inspect more.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

export interface FullDayBacktestSectionProps {
  slice: NineFifteenFullDayBacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
  defaultOpen?: boolean;
}

export function FullDayBacktestSection({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
  defaultOpen = false,
}: FullDayBacktestSectionProps) {
  return (
    <details className="nf915bt-accordion" open={defaultOpen}>
      <summary className="nf915bt-accordion-summary">
        <span className="nf915bt-accordion-title">{slice.label}</span>
        <span className="nf915bt-accordion-meta">{accordionMeta(slice)}</span>
      </summary>
      <div className="nf915bt-accordion-body">
        <BacktestSectionBody
          slice={slice}
          builtAt={builtAt}
          rangeLabel={rangeLabel}
          subtitle={subtitle}
        />
      </div>
    </details>
  );
}
