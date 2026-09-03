import { useMemo, useState } from "react";
import { Target } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import type {
  NineFifteenHighMinus5BacktestSlice,
  NineFifteenHighMinus5Outcome,
  NineFifteenHighMinus5Trade,
} from "@/types/nine-fifteen-high-minus5-backtest";

type OutcomeFilter = "all" | NineFifteenHighMinus5Outcome;

function outcomeLabel(outcome: NineFifteenHighMinus5Outcome): string {
  switch (outcome) {
    case "win":
      return "Win (in 9:15)";
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

function TradeRow({ trade }: { trade: NineFifteenHighMinus5Trade }) {
  return (
    <tr>
      <td>{trade.date}</td>
      <td>{trade.weekday}</td>
      <td>{formatNumber(trade.open915, 2)}</td>
      <td>{formatNumber(trade.close915, 2)}</td>
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

function accordionMeta(slice: NineFifteenHighMinus5BacktestSlice): string {
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  const parts = [
    `${slice.stats.wins} in 9:15`,
    `${slice.stats.lateWins} late`,
    `${slice.stats.losses} loss`,
  ];
  if (slice.rules.variant === "limit_open_minus_5" && slice.stats.noEntry > 0) {
    parts.push(`${slice.stats.noEntry} no entry`);
  }
  parts.push(`${slice.stats.winRatePct}% TP (${entered} entered)`);
  return parts.join(" · ");
}

function RulesList({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
}: {
  slice: NineFifteenHighMinus5BacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
}) {
  const isMarketAtOpen = slice.rules.variant === "market_at_open";

  return (
    <section className="nf915bt-rules card">
      <h3>Rules</h3>
      {subtitle && <p className="nf915bt-section-subtitle">{subtitle}</p>}
      <ul>
        {slice.rules.red915Only && (
          <li>
            <strong>Red 9:15 only</strong> — trade only when the opening minute closes below its
            open (green/flat days skipped).
          </li>
        )}
        {isMarketAtOpen ? (
          <>
            <li>
              <strong>Entry</strong> — market fill at the 9:15 candle open (every session).
            </li>
            <li>
              <strong>Take profit</strong> — {slice.rules.tpOffsetFromEntry} pts below the 9:15
              open (Nifty index points).
            </li>
          </>
        ) : (
          <>
            <li>
              <strong>Entry</strong> — limit fill when session low touches 9:15 candle open −{" "}
              {slice.rules.entryOffsetFromOpen} pts.
            </li>
            <li>
              <strong>Take profit</strong> — {slice.rules.tpOffsetFromEntry} pts below the entry
              fill (Nifty index points).
            </li>
            <li>
              <strong>No entry</strong> — price never reached open − {slice.rules.entryOffsetFromOpen}{" "}
              that day.
            </li>
          </>
        )}
        <li>
          <strong>Win</strong> — TP touched before {slice.rules.winWindowEndIst} (still inside the
          9:15 minute).
        </li>
        <li>
          <strong>Late win</strong> — entry filled but TP first touched after 9:16:00 (exact time in
          the table).
        </li>
        <li>
          <strong>Loss</strong> — entry filled, TP never touched through {slice.rules.scanEndIst}.
        </li>
      </ul>
      <p className="nf915bt-muted">
        {rangeLabel} · {slice.stats.sessions} sessions
        {slice.stats.excludedSessions != null && slice.stats.excludedSessions > 0
          ? ` · ${slice.stats.excludedSessions} green/flat skipped`
          : ""}
        {" · built "}
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
  slice: NineFifteenHighMinus5BacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
}) {
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  const showNoEntry = slice.rules.variant === "limit_open_minus_5";

  const filterOptions = useMemo(() => {
    const keys: OutcomeFilter[] = ["all", "win", "late_win", "loss"];
    if (showNoEntry) keys.push("no_entry");
    return keys;
  }, [showNoEntry]);

  const filtered = useMemo(() => {
    if (filter === "all") return slice.trades;
    return slice.trades.filter((t) => t.outcome === filter);
  }, [filter, slice.trades]);

  return (
    <>
      <RulesList slice={slice} builtAt={builtAt} rangeLabel={rangeLabel} subtitle={subtitle} />

      <section className="nf915bt-stat-grid">
        <StatCard
          label="Win (in 9:15)"
          value={String(slice.stats.wins)}
          hint={`${slice.stats.inMinuteWinPct}% of ${entered} entered`}
          tone="text-up"
        />
        <StatCard
          label="Late win"
          value={String(slice.stats.lateWins)}
          hint="TP after 9:16 — time in table"
          tone="nf915bt-tone-late"
        />
        <StatCard
          label="Loss"
          value={String(slice.stats.losses)}
          hint="Entered, TP never hit"
          tone="text-down"
        />
        {showNoEntry && (
          <StatCard
            label="No entry"
            value={String(slice.stats.noEntry)}
            hint={`Open − ${slice.rules.entryOffsetFromOpen} never touched`}
          />
        )}
        <StatCard
          label="TP hit rate"
          value={`${slice.stats.winRatePct}%`}
          hint={`${slice.stats.wins + slice.stats.lateWins} / ${entered} entered`}
        />
      </section>

      <section className="card nf915bt-table-section">
        <div className="nf915bt-table-toolbar">
          <h3>
            <Target size={16} /> Session log
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
                <th>9:15 open</th>
                <th>9:15 close</th>
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
                  <td colSpan={9} className="nf915bt-empty">
                    No trades in this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((trade) => <TradeRow key={trade.date} trade={trade} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export interface BacktestSectionProps {
  slice: NineFifteenHighMinus5BacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
  defaultOpen?: boolean;
}

export function BacktestSection({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
  defaultOpen = false,
}: BacktestSectionProps) {
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
