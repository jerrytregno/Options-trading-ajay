import { formatWeekdayFromDateKey } from "./market-time";
import type { NineFifteenCandleRow } from "@/types/nine-fifteen";

export const WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;

export interface WeekdayNineFifteenBucket {
  weekday: string;
  sessions: number;
  /** Mean |9:15 close − 9:15 open| — the candle's size regardless of direction. */
  avgAbsChange: number;
  /** Mean signed change, so a weekday that leans up or down shows it. */
  avgSignedChange: number;
  /** Sessions whose body cleared the live signal floor. */
  signalDays: number;
  signalPct: number;
}

/** Only the fields the weekday average needs, so callers can pass a full row or a test fixture. */
type SessionLike = Pick<NineFifteenCandleRow, "date" | "change" | "high" | "low" | "direction">;

export type WeekdayNineFifteenMetric = "body" | "range";

function session915Measure(row: SessionLike, metric: WeekdayNineFifteenMetric): number {
  if (metric === "range") return row.high - row.low;
  return Math.abs(row.change);
}

function session915Signal(
  row: SessionLike,
  signalFloor: number,
  metric: WeekdayNineFifteenMetric,
  redOnly: boolean,
  exclusive: boolean,
): boolean {
  if (redOnly && row.direction !== "down") return false;
  const measure = session915Measure(row, metric);
  return exclusive ? measure > signalFloor : measure >= signalFloor;
}

/**
 * Averages every session in the sample, not only the days the strategy traded. Restricting this to
 * taken trades would describe the entry filter rather than the weekday.
 *
 * Weekdays with no sessions still come back as zero rows so the chart keeps a stable Mon–Fri shape.
 */
export function buildWeekdayNineFifteenAverages(
  rows: SessionLike[],
  signalFloor: number,
  options?: { metric?: WeekdayNineFifteenMetric; redOnlySignal?: boolean; signalExclusive?: boolean },
): WeekdayNineFifteenBucket[] {
  const metric = options?.metric ?? "body";
  const redOnlySignal = options?.redOnlySignal ?? false;
  const signalExclusive = options?.signalExclusive ?? false;
  const totals = new Map<string, { sessions: number; abs: number; signed: number; signals: number }>();

  for (const row of rows) {
    if (!Number.isFinite(row.change) || !Number.isFinite(row.high) || !Number.isFinite(row.low)) continue;
    const weekday = formatWeekdayFromDateKey(row.date);
    const abs = session915Measure(row, metric);
    const bucket = totals.get(weekday);
    if (bucket) {
      bucket.sessions += 1;
      bucket.abs += abs;
      bucket.signed += row.change;
      if (session915Signal(row, signalFloor, metric, redOnlySignal, signalExclusive)) bucket.signals += 1;
    } else {
      totals.set(weekday, {
        sessions: 1,
        abs,
        signed: row.change,
        signals: session915Signal(row, signalFloor, metric, redOnlySignal, signalExclusive) ? 1 : 0,
      });
    }
  }

  return WEEKDAY_ORDER.map((weekday) => {
    const total = totals.get(weekday);
    const sessions = total?.sessions ?? 0;
    return {
      weekday,
      sessions,
      avgAbsChange: sessions > 0 ? (total?.abs ?? 0) / sessions : 0,
      avgSignedChange: sessions > 0 ? (total?.signed ?? 0) / sessions : 0,
      signalDays: total?.signals ?? 0,
      signalPct: sessions > 0 ? ((total?.signals ?? 0) / sessions) * 100 : 0,
    };
  });
}
