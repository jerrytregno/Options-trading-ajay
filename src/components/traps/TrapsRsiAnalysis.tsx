import { useMemo } from "react";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildTrapsRsiAnalysis,
  type TrapsRsiAnalysis,
  type TrapsRsiMatrixCell,
} from "@/lib/traps-backtest-rsi";
import type { TrapsBacktestTrade } from "@/types/traps-backtest";

const inr = (value: number) =>
  `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const signClass = (value: number) => (value > 0 ? "tbt-pos" : value < 0 ? "tbt-neg" : "");

function cellClass(cell: TrapsRsiMatrixCell): string {
  if (cell.trades === 0) return "tbt-rsi-matrix-cell--empty";
  if (cell.losses === 0) return "tbt-rsi-matrix-cell--clean";
  if (cell.wins === 0) return "tbt-rsi-matrix-cell--lossy";
  return "";
}

function formatCell(cell: TrapsRsiMatrixCell): string {
  if (cell.trades === 0) return "—";
  if (cell.losses === 0) return `${cell.wins}W`;
  if (cell.wins === 0) return `${cell.losses}L`;
  return `${cell.wins}W / ${cell.losses}L`;
}

function BestRangeCallout({ analysis }: { analysis: TrapsRsiAnalysis }) {
  const range = analysis.bestNoLossRange ?? analysis.bestLowLossRange;
  if (!range) {
    return (
      <p className="tbt-muted">
        Not enough trades with RSI readings to suggest a band (need at least 3 in a 10-point window).
      </p>
    );
  }

  const perfect = analysis.bestNoLossRange != null;

  return (
    <div className={cn("tbt-rsi-best", perfect && "tbt-rsi-best--perfect")}>
      <p className="tbt-strong">
        {perfect ? "Best no-loss RSI band" : "Lowest-loss RSI band"}:{" "}
        <span className="tbt-mono">{range.label}</span>
      </p>
      <p className="tbt-muted">
        {range.trades} trades · {range.wins}W / {range.losses}L · {range.winRatePct}% win rate ·{" "}
        <span className={signClass(range.netPnl)}>{inr(range.netPnl)}</span> net
        {perfect
          ? " — every trade in this band was profitable or flat."
          : ` — fewest losses among bands with ≥3 trades.`}
      </p>
    </div>
  );
}

function RsiTimeMatrix({ analysis }: { analysis: TrapsRsiAnalysis }) {
  const { matrix } = analysis;
  const { rsiRows, timeCols, cells } = matrix;

  if (rsiRows.length === 0 || timeCols.length === 0) {
    return <p className="tbt-muted">No trades to cross-tabulate.</p>;
  }

  return (
    <div className="tbt-rsi-matrix-scroll">
      <table className="tbt-table tbt-rsi-matrix">
        <thead>
          <tr>
            <th className="tbt-rsi-matrix-corner">
              RSI ↓ · Time →
            </th>
            {timeCols.map((col) => (
              <th key={col.startMins} className="tbt-rsi-matrix-col-head">
                {col.label}
              </th>
            ))}
            <th className="tbt-rsi-matrix-total-head">RSI total</th>
          </tr>
        </thead>
        <tbody>
          {rsiRows.map((row, rowIndex) => (
            <tr key={row.min}>
              <th className="tbt-rsi-matrix-row-head">{row.label}</th>
              {cells[rowIndex].map((cell, colIndex) => (
                <td
                  key={`${row.min}-${timeCols[colIndex].startMins}`}
                  className={cn("tbt-rsi-matrix-cell", cellClass(cell))}
                  title={
                    cell.trades > 0
                      ? `${row.label} RSI · ${timeCols[colIndex].label} entry · ${formatCell(cell)} · ${inr(cell.netPnl)} net`
                      : undefined
                  }
                >
                  {formatCell(cell)}
                </td>
              ))}
              <td className="tbt-rsi-matrix-total">
                <span className="tbt-pos">{row.wins}W</span>
                {" / "}
                <span className="tbt-neg">{row.losses}L</span>
              </td>
            </tr>
          ))}
          <tr className="tbt-rsi-matrix-foot">
            <th className="tbt-rsi-matrix-row-head">Time total</th>
            {timeCols.map((col, colIndex) => {
              let wins = 0;
              let losses = 0;
              for (const row of cells) {
                wins += row[colIndex].wins;
                losses += row[colIndex].losses;
              }
              return (
                <td key={col.startMins} className="tbt-rsi-matrix-total">
                  <span className="tbt-pos">{wins}W</span>
                  {" / "}
                  <span className="tbt-neg">{losses}L</span>
                </td>
              );
            })}
            <td className="tbt-rsi-matrix-total tbt-rsi-matrix-grand">
              {analysis.points.filter((p) => p.win).length}W /{" "}
              {analysis.points.filter((p) => !p.win && p.netPnl !== 0).length}L
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function TrapsRsiAnalysisSection({ trades }: { trades: TrapsBacktestTrade[] }) {
  const analysis = useMemo(() => buildTrapsRsiAnalysis(trades), [trades]);

  if (trades.length === 0) {
    return null;
  }

  return (
    <section className="card tbt-section">
      <h2 className="tbt-section-title">
        <Activity size={16} /> RSI × entry time — wins &amp; losses
      </h2>
      <p className="tbt-rsi-lead text-muted">
        Each cell is trades that landed in that <strong>5-pt RSI band</strong> (rows) and{" "}
        <strong>15-min entry window</strong> (columns, IST). Format: <strong>3W / 1L</strong> = 3 wins,
        1 loss. Green cells are win-only; red cells are loss-only.
      </p>

      {analysis.points.length === 0 ? (
        <p className="tbt-muted">No RSI readings in this range — sessions may be too short at the open.</p>
      ) : (
        <>
          <BestRangeCallout analysis={analysis} />
          <RsiTimeMatrix analysis={analysis} />
          {analysis.missingRsi > 0 && (
            <p className="tbt-muted tbt-rsi-missing">
              {analysis.missingRsi} trade{analysis.missingRsi === 1 ? "" : "s"} omitted — RSI not
              available yet at the signal bar.
            </p>
          )}
        </>
      )}
    </section>
  );
}
