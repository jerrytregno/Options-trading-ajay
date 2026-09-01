/**
 * Shared ingestion helpers for Zerodha 1-minute historical candles: date enumeration, request
 * chunking, grouping raw rows into IST sessions, and rejecting partial days.
 *
 * Strategy-neutral on purpose — the day scalper year builds depend on these, so they must not
 * live inside any one strategy's module.
 */

const IST = "Asia/Kolkata";
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const MIN_SESSION_MINUTE_BARS = 330;

export type MinuteBar = {
  mins: number;
  timeIst: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Mirrors the injectable fetcher the 9:15 backtest uses, so builds can be driven from fixtures. */
export type CandleFetcher = (
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) => Promise<{ instrument: string; candles: unknown[] }>;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function istParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") % 24,
    minute: pick("minute"),
  };
}

/** Weekdays over the lookback window, oldest first. Holidays fall out when Kite returns no bars. */
export function listWeekdayDates(calendarDaysBack: number): string[] {
  const dates: string[] = [];
  const now = Date.now();
  for (let offset = calendarDaysBack; offset >= 0; offset -= 1) {
    const ist = istParts(new Date(now - offset * 86_400_000));
    if (ist.weekday === "Sat" || ist.weekday === "Sun") continue;
    dates.push(`${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`);
  }
  return dates;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function groupSessionBars(raw: unknown[]): Map<string, MinuteBar[]> {
  const byDate = new Map<string, MinuteBar[]>();

  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close] = row;
    if (typeof time !== "string") continue;
    if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) {
      continue;
    }
    const parsed = new Date(time);
    if (!Number.isFinite(parsed.getTime())) continue;

    const ist = istParts(parsed);
    const mins = ist.hour * 60 + ist.minute;
    if (mins < SESSION_OPEN_MINUTES || mins > SESSION_CLOSE_MINUTES) continue;

    const date = `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`;
    const list = byDate.get(date);
    const bar: MinuteBar = {
      mins,
      timeIst: `${pad2(ist.hour)}:${pad2(ist.minute)}`,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
    };
    if (list) list.push(bar);
    else byDate.set(date, [bar]);
  }

  for (const bars of byDate.values()) bars.sort((a, b) => a.mins - b.mins);
  return byDate;
}

/** Drops partial sessions so a half-finished live day cannot skew the year. */
export function isCompleteSession(bars: MinuteBar[]): boolean {
  if (bars.length < MIN_SESSION_MINUTE_BARS) return false;
  return (bars[bars.length - 1]?.mins ?? 0) >= SESSION_CLOSE_MINUTES - 1;
}
