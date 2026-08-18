const EXIT_START_MINUTES = 9 * 60 + 16;
const EXIT_END_MINUTES = 15 * 60 + 30;

export type GapToTargetPoint = {
  mins: number;
  time: string;
  gapPts: number;
};

function minutesFromCandleTime(time: string): number | null {
  const m = /(\d{2}):(\d{2})/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Per-minute distance from the fixed entry target (main ±25 · near-miss ±20).
 * Does not tier targets after 10:01 or 11:01 — matches the initial band from the 9:15 bar.
 */
export function computeGapToTargetSeries(
  candles: { time: string; high: number; low: number }[],
  entryPrice: number,
  side: "CE" | "PE",
  targetPoints: number,
): GapToTargetPoint[] {
  const points: GapToTargetPoint[] = [];
  for (const c of candles) {
    const mins = minutesFromCandleTime(c.time);
    if (mins == null || mins < EXIT_START_MINUTES || mins > EXIT_END_MINUTES) continue;
    const targetIndexPrice =
      side === "CE" ? entryPrice + targetPoints : entryPrice - targetPoints;
    const extreme = side === "CE" ? c.high : c.low;
    const gapPts =
      side === "CE"
        ? Math.max(0, targetIndexPrice - extreme)
        : Math.max(0, extreme - targetIndexPrice);
    points.push({
      mins,
      time: c.time,
      gapPts: Number(gapPts.toFixed(2)),
    });
  }
  return points;
}
