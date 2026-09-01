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
type SessionLike = Pick<NineFifteenCandleRow, "date" | "change">;

/**
 * Averages every session in the sample, not only the days the strategy traded. Restricting this to
 * taken trades would describe the entry filter rather than the weekday.
 *
 * Weekdays with no sessions still come back as zero rows so the chart keeps a stable Mon–Fri shape.
 */
export function buildWeekdayNineFifteenAverages(
  rows: SessionLike[],
  signalFloor: number,
): WeekdayNineFifteenBucket[] {
  const totals = new Map<string, { sessions: number; abs: number; signed: number; signals: number }>();

  for (const row of rows) {
    if (!Number.isFinite(row.change)) continue;
    const weekday = formatWeekdayFromDateKey(row.date);
    const abs = Math.abs(row.change);
    const bucket = totals.get(weekday);
    if (bucket) {
      bucket.sessions += 1;
      bucket.abs += abs;
      bucket.signed += row.change;
      if (abs >= signalFloor) bucket.signals += 1;
    } else {
      totals.set(weekday, {
        sessions: 1,
        abs,
        signed: row.change,
        signals: abs >= signalFloor ? 1 : 0,
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
