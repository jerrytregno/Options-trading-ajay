import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  Calendar,
  History,
  Minus,
  RefreshCw,
  Search,
} from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import type {
  MlTradingBacktestComparisonRow,
  MlTradingBacktestResult,
  MlTradingBatchBacktestResult,
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

const ML_PROFIT_TARGET_STORAGE_KEY = "ml-trading-profit-target-inr";
const DEFAULT_PROFIT_TARGET_INR = 500;

function readStoredProfitTarget(): number {
  try {
    const raw = localStorage.getItem(ML_PROFIT_TARGET_STORAGE_KEY);
    const n = raw ? Number(raw) : DEFAULT_PROFIT_TARGET_INR;
    return Number.isFinite(n) && n >= 1 ? Math.round(n) : DEFAULT_PROFIT_TARGET_INR;
  } catch {
    return DEFAULT_PROFIT_TARGET_INR;
  }
}

function parseProfitTargetDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!trimmed) return null;
  const n = Math.round(Number(trimmed));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function ProfitTargetField({
  id,
  draft,
  onDraftChange,
  onApply,
  hint,
}: {
  id: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onApply: () => void;
  hint?: string;
}) {
  return (
    <label className="ml-trading-backtest-date ml-trading-trade-settings-target" htmlFor={id}>
      <span className="text-muted text-sm">Profit target — ₹ net (after ₹50 brokerage)</span>
      <div className="ml-trading-profit-target-row">
        <span className="ml-trading-profit-target-prefix" aria-hidden>
          ₹
        </span>
        <input
          id={id}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="500"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onApply();
          }}
        />
      </div>
      {hint && <span className="text-muted text-xs">{hint}</span>}
    </label>
  );
}

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
        <p className="text-muted text-sm">9:15 entry option data not available for this day.</p>
      </div>
    );
  }

  const profitClass = trade.netPnlRupees >= 0 ? "text-up" : "text-down";
  const exitLabel =
    trade.exitReason === "target"
      ? `Exit ${trade.exitTime} · ₹${trade.targetProfitInr} target hit`
      : `Exit ${trade.exitTime} (EOD)${trade.isProjection ? " · proj." : ""}`;

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
          <dt>{exitLabel}</dt>
          <dd>NIFTY {formatNumber(trade.exitSpot, 2)} · premium {formatNumber(trade.exitPremium, 2)}</dd>
        </div>
        <div>
          <dt>Profit target</dt>
          <dd className={trade.targetHit ? "text-up" : "text-muted"}>
            {formatInr(trade.targetProfitRupees)} net · {trade.targetHit ? "hit" : "not hit"}
          </dd>
        </div>
        <div>
          <dt>Spot move</dt>
          <dd className={trade.spotMovePct >= 0 ? "text-up" : "text-down"}>{formatPct(trade.spotMovePct)}</dd>
        </div>
        <div>
          <dt>Cost ({trade.lots} lot × {trade.lotSize} qty)</dt>
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

function BacktestComparisonTable({ rows }: { rows: MlTradingBacktestComparisonRow[] }) {
  return (
    <div className="ml-trading-hour-table-wrap">
      <table className="ml-trading-hour-table ml-trading-backtest-table">
        <thead>
          <tr>
            <th>Hour</th>
            <th>Type</th>
            <th>Pred close</th>
            <th>Actual close</th>
            <th>Close err</th>
            <th>Pred O/H/L</th>
            <th>Actual O/H/L</th>
            <th>Hour bias</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isPredicted = row.status === "predicted";
            return (
              <tr
                key={row.hourLabel}
                className={cn(
                  !isPredicted && "ml-trading-hour-row--matched",
                  isPredicted && "ml-trading-hour-row--predicted",
                )}
              >
                <td>{row.hourLabel}</td>
                <td className="capitalize">{isPredicted ? "predicted" : "known at open"}</td>
                <td>{row.predClose != null ? formatNumber(row.predClose, 2) : "—"}</td>
                <td>{formatNumber(row.actualClose, 2)}</td>
                <td className={cn(
                  row.closeErrorPct != null && row.closeErrorPct >= 0 ? "text-up" : "text-down",
                )}
                >
                  {row.closeErrorPct != null ? formatPct(row.closeErrorPct) : "—"}
                </td>
                <td className="text-sm">
                  {row.predOpen != null
                    ? `${formatNumber(row.predOpen, 2)} / ${formatNumber(row.predHigh ?? 0, 2)} / ${formatNumber(row.predLow ?? 0, 2)}`
                    : "—"}
                </td>
                <td className="text-sm">
                  {formatNumber(row.actualOpen, 2)} / {formatNumber(row.actualHigh, 2)} / {formatNumber(row.actualLow, 2)}
                </td>
                <td>
                  {isPredicted ? (
                    <>
                      <span className={cn("capitalize", row.predBias === "bullish" ? "text-up" : row.predBias === "bearish" ? "text-down" : "")}>
                        {row.predBias}
                      </span>
                      {" → "}
                      <span className={cn("capitalize", row.actualBias === "bullish" ? "text-up" : row.actualBias === "bearish" ? "text-down" : "")}>
                        {row.actualBias}
                      </span>
                      {row.biasCorrect != null && (
                        <span className={row.biasCorrect ? " text-up" : " text-down"}>
                          {row.biasCorrect ? " ✓" : " ✗"}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BatchBacktestSummary({ batch }: { batch: MlTradingBatchBacktestResult }) {
  const useProfitTarget = batch.successMetric === "profit_target" || batch.profitTargetAccuracyPct != null;
  const accuracyPct = useProfitTarget
    ? (batch.profitTargetAccuracyPct ?? 0)
    : batch.directionAccuracyPct;
  const accClass = accuracyPct >= 50 ? "text-up" : "text-down";
  const targetInr = batch.targetProfitInr ?? 500;

  return (
    <div className="ml-trading-batch-summary">
      <div className="ml-trading-batch-score">
        <strong className={accClass}>
          {batch.daysCorrect} / {batch.daysTested}{" "}
          {useProfitTarget ? `hit ₹${targetInr} profit target` : "correct"}
        </strong>
        <span className="text-muted text-sm">
          ({formatNumber(accuracyPct, 1)}% success rate
          {useProfitTarget ? ` · direction was ${formatNumber(batch.directionAccuracyPct, 1)}%` : ""})
        </span>
      </div>
      {batch.optionTradesError && (
        <p className="text-muted text-sm mb-3">{batch.optionTradesError}</p>
      )}
      <dl className="ml-trading-stats mb-4">
        <div>
          <dt>Period</dt>
          <dd>
            {batch.dateRange.first && batch.dateRange.last
              ? `${formatDateLabel(batch.dateRange.first)} → ${formatDateLabel(batch.dateRange.last)}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Missed target</dt>
          <dd>{batch.daysWrong}</dd>
        </div>
        <div>
          <dt>Avg return error</dt>
          <dd>{batch.avgDayReturnErrorPct != null ? formatPct(batch.avgDayReturnErrorPct, false) : "—"}</dd>
        </div>
        <div>
          <dt>Direction (bullish pred.)</dt>
          <dd>
            {batch.byPredictedOutcome.bullish.correct}/{batch.byPredictedOutcome.bullish.count} correct
          </dd>
        </div>
        <div>
          <dt>Direction (bearish pred.)</dt>
          <dd>
            {batch.byPredictedOutcome.bearish.correct}/{batch.byPredictedOutcome.bearish.count} correct
          </dd>
        </div>
      </dl>
      <div className="ml-trading-hour-table-wrap">
        <table className="ml-trading-hour-table ml-trading-backtest-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Result</th>
              <th>Option</th>
              <th>Net P/L</th>
              <th>Exit</th>
              <th>Predicted</th>
              <th>Actual</th>
            </tr>
          </thead>
          <tbody>
            {[...batch.days].reverse().map((row) => {
              const success = row.success ?? row.profitTargetHit ?? row.directionCorrect;
              return (
              <tr
                key={row.date}
                className={success ? "ml-trading-batch-row--ok" : "ml-trading-batch-row--miss"}
              >
                <td>{formatDateLabel(row.date)}</td>
                <td className={success ? "text-up" : "text-down"}>
                  {useProfitTarget
                    ? (row.profitTargetHit ? "Target hit" : "Missed")
                    : (row.directionCorrect ? "Correct" : "Wrong")}
                </td>
                <td>{row.optionSide ?? "—"}</td>
                <td className={
                  row.optionNetPnlRupees != null
                    ? (row.optionNetPnlRupees >= 0 ? "text-up" : "text-down")
                    : undefined
                }
                >
                  {row.optionNetPnlRupees != null ? formatInr(row.optionNetPnlRupees, true) : "—"}
                </td>
                <td className="text-sm">
                  {row.optionExitTime
                    ? `${row.optionExitTime}${row.optionExitReason === "target" ? " ✓" : ""}`
                    : "—"}
                </td>
                <td className="capitalize">{row.predictedOutcome}</td>
                <td className="capitalize">{row.actualOutcome}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
      <OptionTradePanel trade={optionTrade} title={`9:15 entry · exit at ₹${optionTrade?.targetProfitInr ?? 500} profit on ${formatDateLabel(match.todayAnalogDate)}`} />
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
      <OptionTradePanel trade={optionTrade} title={`9:15 entry · exit at ₹${optionTrade?.targetProfitInr ?? 500} profit on ${formatDateLabel(match.date)}`} />
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
  const [backtestDate, setBacktestDate] = useState("");
  const [backtest, setBacktest] = useState<MlTradingBacktestResult | null>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [batchBacktest, setBatchBacktest] = useState<MlTradingBatchBacktestResult | null>(null);
  const [batchBacktesting, setBatchBacktesting] = useState(false);
  const [profitTargetInr, setProfitTargetInr] = useState(readStoredProfitTarget);
  const [profitTargetDraft, setProfitTargetDraft] = useState(() => String(readStoredProfitTarget()));
  const [error, setError] = useState<string | null>(null);

  const commitProfitTarget = useCallback((): number | null => {
    const parsed = parseProfitTargetDraft(profitTargetDraft);
    if (parsed == null) {
      setProfitTargetDraft(String(profitTargetInr));
      setError("Profit target must be at least ₹1");
      return null;
    }
    setProfitTargetInr(parsed);
    setProfitTargetDraft(String(parsed));
    try {
      localStorage.setItem(ML_PROFIT_TARGET_STORAGE_KEY, String(parsed));
    } catch {
      // ignore storage errors
    }
    return parsed;
  }, [profitTargetDraft, profitTargetInr]);

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

  const runMatch = useCallback(async (targetInr = profitTargetInr) => {
    if (!connected) return;
    setMatching(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/ml-trading/match?targetInr=${encodeURIComponent(String(targetInr))}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Pattern match failed");
      setMatch(json.data as MlTradingMatchResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pattern match failed");
    } finally {
      setMatching(false);
    }
  }, [connected, profitTargetInr]);

  const runBacktest = useCallback(async () => {
    if (!connected || !backtestDate) return;
    setBacktesting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/ml-trading/backtest?date=${encodeURIComponent(backtestDate)}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Backtest failed");
      setBacktest(json.data as MlTradingBacktestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setBacktesting(false);
    }
  }, [connected, backtestDate]);

  const runBatchBacktest = useCallback(async (targetInr = profitTargetInr) => {
    if (!connected) return;
    setBatchBacktesting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/ml-trading/backtest/batch?days=30&targetInr=${encodeURIComponent(String(targetInr))}`,
        { credentials: "include" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "30-day backtest failed");
      setBatchBacktest(json.data as MlTradingBatchBacktestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "30-day backtest failed");
    } finally {
      setBatchBacktesting(false);
    }
  }, [connected, profitTargetInr]);

  const applyProfitTarget = useCallback(async () => {
    const target = commitProfitTarget();
    if (target == null || !connected || !status?.libraryBuilt) return;
    setError(null);
    await Promise.all([runMatch(target), runBatchBacktest(target)]);
  }, [commitProfitTarget, connected, status?.libraryBuilt, runMatch, runBatchBacktest]);

  const refreshBatchWithTarget = useCallback(async () => {
    const target = commitProfitTarget();
    if (target == null || !connected) return;
    setError(null);
    await runBatchBacktest(target);
  }, [commitProfitTarget, connected, runBatchBacktest]);

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
      void runBatchBacktest();
    }
  }, [connected, status?.libraryBuilt, runMatch, runBatchBacktest]);

  useEffect(() => {
    if (backtestDate || !status?.lastDate) return;
    setBacktestDate(status.lastDate);
  }, [status?.lastDate, backtestDate]);

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

          <section className="card mb-6 ml-trading-panel ml-trading-trade-settings">
            <h2 className="ml-trading-panel-title">Option trade setup</h2>
            <p className="text-muted text-sm mb-4">
              Enter at <strong>9:15</strong> on the recommended <strong>ATM strike</strong>, always{" "}
              <strong>1 lot</strong> (NIFTY lot size from Kite, e.g. 75 qty). Exit when{" "}
              <strong>net profit</strong> hits your target (after ₹50 round-trip brokerage), else at session end.
            </p>
            <div className="ml-trading-backtest-controls">
              <ProfitTargetField
                id="ml-trade-setup-profit-target"
                draft={profitTargetDraft}
                onDraftChange={setProfitTargetDraft}
                onApply={() => void applyProfitTarget()}
                hint="1 lot · ATM strike · Call or Put from model"
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!status?.libraryBuilt || matching || batchBacktesting}
                onClick={() => void applyProfitTarget()}
              >
                <RefreshCw size={16} className={matching || batchBacktesting ? "spin" : undefined} />
                Apply &amp; refresh all
              </button>
            </div>
            {match?.optionTradeMeta && (
              <p className="text-muted text-xs mt-3">
                Active: ₹{match.optionTradeMeta.targetProfitInr} target · {match.optionTradeMeta.lots} lot ×{" "}
                {match.optionTradeMeta.lotSize} qty · expiry {match.optionTradeMeta.expiry}
              </p>
            )}
          </section>

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
                        title={`Today's trade · 9:15 · 1 lot ATM · exit at ₹${match.todayOptionTrade.targetProfitInr} net${match.todayOptionTrade.isProjection ? " (projected)" : ""}`}
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

          <section className="card mb-6 ml-trading-panel">
            <h2 className="ml-trading-panel-title">
              <History size={18} />
              30-day backtest summary
            </h2>
            <p className="text-muted text-sm mb-4">
              Last <strong>30 trading sessions</strong>, <strong>1 lot ATM</strong> each day. A day counts as{" "}
              <strong>success</strong> when net profit hits your target before session end.
            </p>
            <div className="ml-trading-backtest-controls mb-4 ml-trading-batch-target-bar">
              <ProfitTargetField
                id="ml-batch-profit-target"
                draft={profitTargetDraft}
                onDraftChange={setProfitTargetDraft}
                onApply={() => void refreshBatchWithTarget()}
                hint="Change amount, then refresh — same target applies to today’s trade above"
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={batchBacktesting || !status?.pythonAvailable}
                onClick={() => void refreshBatchWithTarget()}
              >
                <RefreshCw size={16} className={batchBacktesting ? "spin" : undefined} />
                {batchBacktesting ? "Running 30-day backtest…" : "Refresh 30-day backtest"}
              </button>
            </div>
            {batchBacktesting && !batchBacktest && (
              <p className="text-muted text-sm mb-4">This may take 10–30 seconds…</p>
            )}
            {batchBacktest && <BatchBacktestSummary batch={batchBacktest} />}
          </section>

          <section className="card mb-6 ml-trading-panel">
            <h2 className="ml-trading-panel-title">
              <History size={18} />
              Single-day backtest
            </h2>
            <p className="text-muted text-sm mb-4">
              Pick a past session date. We load exactly <strong>1 year of hourly data before that date</strong>,
              run the week-pattern model using only the first hour (9:15), then compare predicted vs actual for every hour.
            </p>
            <div className="ml-trading-backtest-controls">
              <label className="ml-trading-backtest-date">
                <span className="text-muted text-sm">Session date</span>
                <input
                  type="date"
                  value={backtestDate}
                  max={status?.lastDate ?? undefined}
                  min={status?.firstDate ?? undefined}
                  onChange={(event) => setBacktestDate(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={backtesting || !backtestDate || !status?.pythonAvailable}
                onClick={() => void runBacktest()}
              >
                <RefreshCw size={16} className={backtesting ? "spin" : undefined} />
                {backtesting ? "Running backtest…" : "Run backtest"}
              </button>
            </div>

            {backtest?.backtest && (
              <div className="mt-6">
                <dl className="ml-trading-stats mb-4">
                  <div>
                    <dt>Library window</dt>
                    <dd>
                      {backtest.backtest.libraryStart} → {backtest.backtest.libraryEnd} ({backtest.backtest.libraryDays} days)
                    </dd>
                  </div>
                  <div>
                    <dt>Simulated at</dt>
                    <dd>{backtest.backtest.simulationThrough} ({backtest.backtest.simulationBars} bar known)</dd>
                  </div>
                  <div>
                    <dt>Direction</dt>
                    <dd>
                      Pred <span className="capitalize">{backtest.backtest.accuracy.predictedOutcome}</span>
                      {" · "}
                      Actual <span className="capitalize">{backtest.backtest.accuracy.actualOutcome}</span>
                      {" · "}
                      <span className={backtest.backtest.accuracy.directionCorrect ? "text-up" : "text-down"}>
                        {backtest.backtest.accuracy.directionCorrect ? "Correct" : "Wrong"}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Day return</dt>
                    <dd>
                      Pred {formatPct(backtest.backtest.accuracy.predictedDayReturnPct)} · Actual{" "}
                      <span className={backtest.backtest.accuracy.actualDayReturnPct >= 0 ? "text-up" : "text-down"}>
                        {formatPct(backtest.backtest.accuracy.actualDayReturnPct)}
                      </span>
                      {" · err "}
                      {formatPct(backtest.backtest.accuracy.dayReturnErrorPct, false)}
                    </dd>
                  </div>
                  <div>
                    <dt>Close @ 3:15</dt>
                    <dd>
                      Pred {backtest.backtest.accuracy.predictedClose != null ? formatNumber(backtest.backtest.accuracy.predictedClose, 2) : "—"}
                      {" · Actual "}
                      {formatNumber(backtest.backtest.accuracy.actualClose, 2)}
                      {backtest.backtest.accuracy.closeErrorPct != null && (
                        <> · err {formatPct(backtest.backtest.accuracy.closeErrorPct)}</>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Hour accuracy</dt>
                    <dd>
                      {backtest.backtest.accuracy.hourBiasAccuracyPct != null
                        ? `${formatNumber(backtest.backtest.accuracy.hourBiasAccuracyPct, 1)}% hour bias`
                        : "—"}
                      {backtest.backtest.accuracy.hourCloseMaePct != null && (
                        <> · MAE {formatPct(backtest.backtest.accuracy.hourCloseMaePct, false)} close</>
                      )}
                    </dd>
                  </div>
                </dl>
                <BacktestComparisonTable rows={backtest.backtest.comparison} />
              </div>
            )}
          </section>

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
