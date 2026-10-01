import { useMemo, useState } from "react";
import { Target } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import type {
  NineFifteenHighMinus5Outcome,
  NineFifteenSmallRedPre10SelloffSlice,
  NineFifteenSmallRedPre10SelloffTrade,
} from "@/types/nine-fifteen-high-minus5-backtest";

type OutcomeFilter = "all" | NineFifteenHighMinus5Outcome;

function outcomeLabel(outcome: NineFifteenHighMinus5Outcome, tpEarliestIst: string): string {
  switch (outcome) {
    case "win":
    case "late_win":
      return `Win (from ${tpEarliestIst})`;
    case "loss":
      return "Loss";
    case "no_entry":
      return "No entry";
  }
}

function outcomeClass(outcome: NineFifteenHighMinus5Outcome): string {
  switch (outcome) {
    case "win":
    case "late_win":
      return "nf915bt-outcome-win";
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

function TradeRow({
  trade,
  tpEarliestIst,
}: {
  trade: NineFifteenSmallRedPre10SelloffTrade;
  tpEarliestIst: string;
}) {
  return (
    <tr>
      <td>{trade.date}</td>
      <td>{trade.weekday}</td>
      <td>{formatNumber(trade.open915, 2)}</td>
      <td>{formatNumber(trade.close915, 2)}</td>
      <td className="text-down">{formatNumber(trade.change915, 2)}</td>
      <td className="text-down">−{formatNumber(trade.pre10MaxSelloffPts, 2)}</td>
      <td>{trade.pre10MaxSelloffTimeIst ?? "—"}</td>
      <td>{formatNumber(trade.entryLevel, 2)}</td>
      <td>{formatNumber(trade.tpLevel, 2)}</td>
      <td>{trade.entryTimeIst ?? "—"}</td>
      <td>{trade.tpTimeIst ?? "—"}</td>
      <td>
        <span className={cn("nf915bt-outcome-pill", outcomeClass(trade.outcome))}>
          {outcomeLabel(trade.outcome, tpEarliestIst)}
        </span>
      </td>
    </tr>
  );
}

function accordionMeta(slice: NineFifteenSmallRedPre10SelloffSlice): string {
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  const wins = slice.stats.wins + slice.stats.lateWins;
  return [
    `${slice.matchingDays} matching days`,
    `${wins} win from ${slice.rules.tpEarliestIst}`,
    `${slice.stats.losses} loss`,
    `${slice.stats.winRatePct}% TP (${entered} entered)`,
  ].join(" · ");
}

export interface SmallRedPre10SelloffSectionProps {
  slice: NineFifteenSmallRedPre10SelloffSlice;
  builtAt: string;
  rangeLabel: string;
  defaultOpen?: boolean;
}

export function SmallRedPre10SelloffSection({
  slice,
  builtAt,
  rangeLabel,
  defaultOpen = false,
}: SmallRedPre10SelloffSectionProps) {
  const signalMinute = slice.rules.signalMinuteLabel;
  const tpEarliestIst = slice.rules.tpEarliestIst;
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  const wins = slice.stats.wins + slice.stats.lateWins;

  const filterOptions = useMemo((): OutcomeFilter[] => ["all", "late_win", "loss", "no_entry"], []);

  const filtered = useMemo(() => {
    if (filter === "all") return slice.trades;
    if (filter === "late_win") {
      return slice.trades.filter((t) => t.outcome === "win" || t.outcome === "late_win");
    }
    return slice.trades.filter((t) => t.outcome === filter);
  }, [filter, slice.trades]);

  return (
    <details className="nf915bt-accordion" open={defaultOpen}>
      <summary className="nf915bt-accordion-summary">
        <span className="nf915bt-accordion-title">{slice.label}</span>
        <span className="nf915bt-accordion-meta">{accordionMeta(slice)}</span>
      </summary>
      <div className="nf915bt-accordion-body">
        <section className="nf915bt-rules card">
          <h3>Filter + trade rules</h3>
          <p className="nf915bt-section-subtitle">
            Days where the {signalMinute} candle closed red with a small body (≤{" "}
            {slice.rules.maxRedBodyPts} pts), and Nifty sold off at least −{slice.rules.pre10SelloffMinPts}{" "}
            from the {signalMinute} open on any 1-minute bar strictly before{" "}
            {slice.rules.pre10WindowEndIst}. Outcomes use the same{" "}
            <strong>Open − {slice.rules.entryOffsetFromOpen}</strong> entry (from {signalMinute}) and{" "}
            <strong>entry − {slice.rules.tpOffsetFromEntry}</strong> take-profit checked only from{" "}
            <strong>{tpEarliestIst}</strong> onward ({slice.rules.instrumentLabel} index points).
          </p>
          <ul>
            <li>
              <strong>Entry</strong> — limit fill when session low touches {signalMinute} open −{" "}
              {slice.rules.entryOffsetFromOpen} (including the {signalMinute} minute).
            </li>
            <li>
              <strong>Take profit</strong> — −{slice.rules.tpOffsetFromEntry} from entry, but only from the{" "}
              {tpEarliestIst} candle onward (even if entry filled at {signalMinute}).
            </li>
            <li>
              <strong>Red small body</strong> — −{slice.rules.maxRedBodyPts} ≤ close − open &lt; 0 on the{" "}
              {signalMinute} minute.
            </li>
            <li>
              <strong>Pre-10 selloff</strong> — {signalMinute} open minus min session low ≥{" "}
              {slice.rules.pre10SelloffMinPts} on minutes {signalMinute} through 9:59.
            </li>
            <li>
              <strong>Win</strong> — entered and TP touched from {tpEarliestIst} through{" "}
              {slice.rules.scanEndIst}. <strong>Loss</strong> — entered, TP never hit.
            </li>
          </ul>
          <p className="nf915bt-muted">
            {rangeLabel} · {slice.redSmallBodyDays} small-red days · {slice.matchingDays} also hit −{" "}
            {slice.rules.pre10SelloffMinPts} before 10:00 · built{" "}
            {new Date(builtAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
          </p>
        </section>

        <section className="nf915bt-stat-grid">
          <StatCard
            label="Matching days"
            value={String(slice.matchingDays)}
            hint={`${slice.redSmallBodyDays} small-red ${signalMinute} days in range`}
          />
          <StatCard
            label={`Win (from ${tpEarliestIst})`}
            value={String(wins)}
            hint={`${entered > 0 ? Math.round((wins / entered) * 100) : 0}% of ${entered} entered`}
            tone="text-up"
          />
          <StatCard
            label="Loss"
            value={String(slice.stats.losses)}
            hint="Entered, TP never hit from 9:16"
            tone="text-down"
          />
          <StatCard
            label="No entry"
            value={String(slice.stats.noEntry)}
            hint={`Open − ${slice.rules.entryOffsetFromOpen} never touched`}
          />
          <StatCard
            label="TP hit rate"
            value={`${slice.stats.winRatePct}%`}
            hint={`${wins} / ${entered} entered`}
          />
        </section>

        <section className="card nf915bt-table-section">
          <div className="nf915bt-table-toolbar">
            <h3>
              <Target size={16} /> Matching sessions
            </h3>
            <div className="nf915bt-filters">
              {filterOptions.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={cn("btn btn-sm", filter === key ? "btn-primary" : "btn-ghost")}
                  onClick={() => setFilter(key)}
                >
                  {key === "all"
                    ? "All"
                    : key === "late_win"
                      ? `Win (from ${tpEarliestIst})`
                      : outcomeLabel(key as NineFifteenHighMinus5Outcome, tpEarliestIst)}
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
                  <th>Open</th>
                  <th>Close</th>
                  <th>Δ {signalMinute}</th>
                  <th>Max − before 10</th>
                  <th>Max time</th>
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
                    <td colSpan={12} className="nf915bt-empty">
                      No sessions match this filter in the selected range.
                    </td>
                  </tr>
                ) : (
                  filtered.map((trade) => (
                    <TradeRow key={trade.date} trade={trade} tpEarliestIst={tpEarliestIst} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </details>
  );
}
