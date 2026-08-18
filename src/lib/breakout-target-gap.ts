/** Tiered index targets for breakout gap chart — mirrors server/nine-fifteen-candles.ts. */
const INDEX_TARGET_25 = 25;
const INDEX_TARGET_20 = 20;
const INDEX_TARGET_15 = 15;
const INDEX_TARGET_20_START = 10 * 60 + 1;
const INDEX_TARGET_15_START = 11 * 60 + 1;
const NEAR_MISS_TARGET = 20;
const NEAR_MISS_TARGET_AFTER = 10;
const NEAR_MISS_SWITCH_MINUTE = 10 * 60 + 1;
const EXIT_START_MINUTES = 9 * 60 + 16;
const EXIT_END_MINUTES = 15 * 60 + 30;

function indexTargetPointsAtMinute(mins: number): number {
  if (mins >= INDEX_TARGET_15_START) return INDEX_TARGET_15;
  if (mins >= INDEX_TARGET_20_START) return INDEX_TARGET_20;
  return INDEX_TARGET_25;
}

export function breakoutProfitTargetPointsAtMinute(
  band: "main" | "near_miss",
  mins: number,
): number {
  if (band === "near_miss") {
    return mins >= NEAR_MISS_SWITCH_MINUTE ? NEAR_MISS_TARGET_AFTER : NEAR_MISS_TARGET;
  }
  return indexTargetPointsAtMinute(mins);
}

export type GapToTargetPoint = {
  mins: number;
  time: string;
  gapPts: number;
  targetPoints: number;
};

function minutesFromCandleTime(time: string): number | null {
  const m = /(\d{2}):(\d{2})/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Per-minute distance from the tiered profit target (0 = target touched on that bar). */
export function computeGapToTargetSeries(
  candles: { time: string; high: number; low: number }[],
  entryPrice: number,
  side: "CE" | "PE",
  band: "main" | "near_miss",
): GapToTargetPoint[] {
  const points: GapToTargetPoint[] = [];
  for (const c of candles) {
    const mins = minutesFromCandleTime(c.time);
    if (mins == null || mins < EXIT_START_MINUTES || mins > EXIT_END_MINUTES) continue;
    const targetPoints = breakoutProfitTargetPointsAtMinute(band, mins);
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
      targetPoints,
    });
  }
  return points;
}
