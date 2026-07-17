import type { PredictionBacktestBar } from "@/types/prediction";
import { formatNumber } from "@/lib/utils";

export const DISPLAY_CONFIDENCE_THRESHOLD = 0.75;

/** Check model stats, table signals, and option P/L simulation. */
export const BACKTEST_CONFIDENCE_THRESHOLD = 0.85;

export const DEFAULT_CONFIDENCE_THRESHOLD = DISPLAY_CONFIDENCE_THRESHOLD;

export const CONFIDENCE_THRESHOLD_STEPS = [
  0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9,
] as const;

export type ConfidentDirection = "up" | "down";

export interface BarProbabilities {
  down: number;
  flat: number;
  up: number;
}

export function getDisplayPrediction(probs: BarProbabilities): "up" | "down" | "flat" {
  return getConfidentDirection(probs, DISPLAY_CONFIDENCE_THRESHOLD, 0) ?? "flat";
}

export function getBacktestDisplayPrediction(probs: BarProbabilities): "up" | "down" | "flat" {
  return getConfidentDirection(probs, BACKTEST_CONFIDENCE_THRESHOLD, 0) ?? "flat";
}

export function displaySignalForPrediction(prediction: "up" | "down" | "flat"): string {
  if (prediction === "up") return "Buy Call";
  if (prediction === "down") return "Buy Put";
  return "No trade";
}

/** Nifty points P/L: enter at bar close, exit at next candle close. */
export function tradePointsPnl(
  prediction: "up" | "down" | "flat",
  entryClose: number,
  exitClose: number | null | undefined,
): number | null {
  if (prediction === "flat" || exitClose == null) return null;
  if (prediction === "up") return exitClose - entryClose;
  return entryClose - exitClose;
}

export function formatPointsPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}${formatNumber(pnl, 2)}`;
}

/** Directional call only when P(direction) ≥ threshold and beats the other side + flat margin. */
export function getConfidentDirection(
  probs: BarProbabilities,
  threshold: number,
  flatMargin = 0,
): ConfidentDirection | null {
  const { down, flat, up } = probs;
  if (up >= threshold && up > down && up - flat >= flatMargin) return "up";
  if (down >= threshold && down > up && down - flat >= flatMargin) return "down";
  return null;
}

export function barHasConfidentDirection(
  bar: PredictionBacktestBar,
  threshold: number,
  flatMargin = 0,
): boolean {
  return getConfidentDirection(bar.probabilities, threshold, flatMargin) != null;
}

export interface ConfidenceStats {
  count: number;
  hit: number;
  miss: number;
  hitPct: number | null;
  predUpCount: number;
  predUpHit: number;
  predUpMiss: number;
  predUpHitPct: number | null;
  predDownCount: number;
  predDownHit: number;
  predDownMiss: number;
  predDownHitPct: number | null;
}

export interface ThresholdSweepRow {
  threshold: number;
  count: number;
  hit: number;
  miss: number;
  hitPct: number | null;
}

function roundPct(hit: number, total: number): number | null {
  return total ? Math.round((hit / total) * 1000) / 10 : null;
}

export function computeConfidenceStats(
  bars: PredictionBacktestBar[],
  threshold: number,
  flatMargin = 0,
  options?: { onlyRevealed?: boolean },
): ConfidenceStats {
  const onlyRevealed = options?.onlyRevealed ?? true;
  let hit = 0;
  let miss = 0;
  let predUpCount = 0;
  let predUpHit = 0;
  let predDownCount = 0;
  let predDownHit = 0;

  for (const bar of bars) {
    if (onlyRevealed && bar.revealed === false) continue;
    if (!bar.actual || bar.actual === "unknown") continue;

    const direction = getConfidentDirection(bar.probabilities, threshold, flatMargin);
    if (!direction) continue;

    const matched = bar.actual === direction;
    if (direction === "up") {
      predUpCount += 1;
      if (matched) {
        predUpHit += 1;
        hit += 1;
      } else {
        miss += 1;
      }
    } else {
      predDownCount += 1;
      if (matched) {
        predDownHit += 1;
        hit += 1;
      } else {
        miss += 1;
      }
    }
  }

  const count = hit + miss;
  return {
    count,
    hit,
    miss,
    hitPct: roundPct(hit, count),
    predUpCount,
    predUpHit,
    predUpMiss: predUpCount - predUpHit,
    predUpHitPct: roundPct(predUpHit, predUpCount),
    predDownCount,
    predDownHit,
    predDownMiss: predDownCount - predDownHit,
    predDownHitPct: roundPct(predDownHit, predDownCount),
  };
}

export function sweepConfidenceThresholds(
  bars: PredictionBacktestBar[],
  flatMargin = 0,
  steps: readonly number[] = CONFIDENCE_THRESHOLD_STEPS,
  options?: { onlyRevealed?: boolean },
): ThresholdSweepRow[] {
  return steps.map((threshold) => {
    const stats = computeConfidenceStats(bars, threshold, flatMargin, options);
    return {
      threshold,
      count: stats.count,
      hit: stats.hit,
      miss: stats.miss,
      hitPct: stats.hitPct,
    };
  });
}

/** Lowest threshold in sweep where hit rate ≥ target (default 70%) with at least minCalls. */
export function findThresholdForTargetHitRate(
  sweep: ThresholdSweepRow[],
  targetHitPct = 70,
  minCalls = 3,
): ThresholdSweepRow | null {
  return (
    sweep.find(
      (row) =>
        row.count >= minCalls && row.hitPct != null && row.hitPct >= targetHitPct,
    ) ?? null
  );
}
