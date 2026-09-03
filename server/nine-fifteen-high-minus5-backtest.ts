import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import type {
  NineFifteenHighMinus5BacktestResult,
  NineFifteenHighMinus5BacktestSlice,
  NineFifteenHighMinus5Stats,
  NineFifteenHighMinus5Trade,
} from "../src/types/nine-fifteen-high-minus5-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { NIFTY_INDEX_PROFILE, type IndexProfile } from "./nine-fifteen-candles.js";

const IST = "Asia/Kolkata";
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const MIN_SESSION_MINUTE_BARS = 330;
const CHUNK_TRADING_DAYS = 40;
const CACHE_VERSION = 4;
const CACHE_MS = 12 * 60 * 60 * 1000;
export const NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET = 5;
export const NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET = 10;
export const NINE_FIFTEEN_HIGH_MINUS5_DEFAULT_DAYS = 365;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "nine-fifteen-high-minus5-backtest.json.gz");
const META_FILE = path.join(DATA_DIR, "nine-fifteen-high-minus5-backtest.meta.json");

type MinuteBar = {
  mins: number;
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
};

type MinuteMap = Map<string, MinuteBar[]>;

function pad2(v: number): string {
  return String(v).padStart(2, "0");
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function formatIstHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function istDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function istMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function weekdayFromDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: IST,
    weekday: "short",
  }).format(new Date(`${dateKey}T06:00:00.000Z`));
}

function isKiteMinuteCandleTuple(item: unknown): item is [string, number, number, number, number] {
  return Array.isArray(item) && item.length >= 5;
}

function isValidSessionDay(candles: MinuteBar[]): boolean {
  if (candles.length < MIN_SESSION_MINUTE_BARS) return false;
  return candles.some((c) => c.mins === SESSION_OPEN_MINUTES);
}

function listWeekdayDates(calendarDaysBack: number): string[] {
  const dates: string[] = [];
  const now = Date.now();
  for (let offset = calendarDaysBack; offset >= 0; offset -= 1) {
    const d = new Date(now - offset * 86_400_000);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short" }).format(d);
    if (weekday === "Sat" || weekday === "Sun") continue;
    dates.push(istDateKey(d));
  }
  return dates;
}

function chunkTradingDates(dates: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < dates.length; i += size) out.push(dates.slice(i, i + size));
  return out;
}

function ingestRawCandles(raw: unknown[], byDate: MinuteMap): void {
  for (const item of raw) {
    if (!isKiteMinuteCandleTuple(item)) continue;
    const [time, open, high, low, close] = item;
    const parsed = new Date(String(time));
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinutes(parsed);
    if (mins < SESSION_OPEN_MINUTES || mins > SESSION_CLOSE_MINUTES) continue;

    const openPx = Number(open);
    const highPx = Number(high);
    const lowPx = Number(low);
    const closePx = Number(close);
    if (![openPx, highPx, lowPx, closePx].every(Number.isFinite)) continue;

    const date = istDateKey(parsed);
    const list = byDate.get(date) ?? [];
    list.push({ mins, time: parsed, open: openPx, high: highPx, low: lowPx, close: closePx });
    byDate.set(date, list);
  }
}

/** Exported for unit checks — simulates one session from minute bars. */
export function simulateHighMinus5Day(
  date: string,
  bar915: Pick<MinuteBar, "open" | "high" | "low" | "close">,
  sessionCandles: Pick<MinuteBar, "mins" | "low">[],
): NineFifteenHighMinus5Trade {
  const entryLevel = round2(bar915.open - NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET);
  const tpLevel = round2(entryLevel - NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET);
  const change915 = round2(bar915.close - bar915.open);

  const ordered = [...sessionCandles]
    .filter((c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES)
    .sort((a, b) => a.mins - b.mins);

  let entered = false;
  let entryTimeIst: string | null = null;
  let entryMins: number | null = null;

  for (const bar of ordered) {
    if (!entered && bar.low <= entryLevel + 1e-9) {
      entered = true;
      entryMins = bar.mins;
      entryTimeIst = formatIstHms(bar.mins * 60);
    }
    if (entered && bar.low <= tpLevel + 1e-9) {
      const tpMins = bar.mins;
      const tpTimeIst = formatIstHms(tpMins * 60);
      const outcome = tpMins === SESSION_OPEN_MINUTES ? "win" : "late_win";
      return {
        date,
        weekday: weekdayFromDateKey(date),
        open915: round2(bar915.open),
        high915: round2(bar915.high),
        low915: round2(bar915.low),
        close915: round2(bar915.close),
        change915,
        entryLevel,
        tpLevel,
        entryTimeIst,
        entryMins,
        tpTimeIst,
        tpMins,
        outcome,
      };
    }
  }

  if (!entered) {
    return {
      date,
      weekday: weekdayFromDateKey(date),
      open915: round2(bar915.open),
      high915: round2(bar915.high),
      low915: round2(bar915.low),
      close915: round2(bar915.close),
      change915,
      entryLevel,
      tpLevel,
      entryTimeIst: null,
      entryMins: null,
      tpTimeIst: null,
      tpMins: null,
      outcome: "no_entry",
    };
  }

  return {
    date,
    weekday: weekdayFromDateKey(date),
    open915: round2(bar915.open),
    high915: round2(bar915.high),
    low915: round2(bar915.low),
    close915: round2(bar915.close),
    change915,
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

/** Exported for unit checks — enter at 9:15 open, TP at open − 10. */
export function simulateOpenAtOpenMinus10Day(
  date: string,
  bar915: Pick<MinuteBar, "open" | "high" | "low" | "close">,
  sessionCandles: Pick<MinuteBar, "mins" | "low">[],
): NineFifteenHighMinus5Trade {
  const entryLevel = round2(bar915.open);
  const tpLevel = round2(entryLevel - NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET);
  const change915 = round2(bar915.close - bar915.open);
  const entryTimeIst = formatIstHms(SESSION_OPEN_MINUTES * 60);
  const entryMins = SESSION_OPEN_MINUTES;

  const ordered = [...sessionCandles]
    .filter((c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES)
    .sort((a, b) => a.mins - b.mins);

  for (const bar of ordered) {
    if (bar.low <= tpLevel + 1e-9) {
      const tpMins = bar.mins;
      const tpTimeIst = formatIstHms(tpMins * 60);
      const outcome = tpMins === SESSION_OPEN_MINUTES ? "win" : "late_win";
      return {
        date,
        weekday: weekdayFromDateKey(date),
        open915: round2(bar915.open),
        high915: round2(bar915.high),
        low915: round2(bar915.low),
        close915: round2(bar915.close),
        change915,
        entryLevel,
        tpLevel,
        entryTimeIst,
        entryMins,
        tpTimeIst,
        tpMins,
        outcome,
      };
    }
  }

  return {
    date,
    weekday: weekdayFromDateKey(date),
    open915: round2(bar915.open),
    high915: round2(bar915.high),
    low915: round2(bar915.low),
    close915: round2(bar915.close),
    change915,
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

function isRed915Bar(bar915: Pick<MinuteBar, "open" | "close">): boolean {
  return bar915.close < bar915.open - 1e-9;
}

function baseRules(red915Only = false) {
  return {
    variant: "limit_open_minus_5" as const,
    entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
    tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
    winWindowEndIst: "9:15:59",
    scanEndIst: "15:30",
    red915Only: red915Only || undefined,
  };
}

function openAtOpenRules() {
  return {
    variant: "market_at_open" as const,
    entryOffsetFromOpen: 0,
    tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
    winWindowEndIst: "9:15:59",
    scanEndIst: "15:30",
  };
}

function summarise(
  trades: NineFifteenHighMinus5Trade[],
  excludedSessions = 0,
): NineFifteenHighMinus5Stats {
  const sessions = trades.length;
  const noEntry = trades.filter((t) => t.outcome === "no_entry").length;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const lateWins = trades.filter((t) => t.outcome === "late_win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const entered = wins + lateWins + losses;
  const winRatePct = entered > 0 ? round2(((wins + lateWins) / entered) * 100) : 0;
  const inMinuteWinPct = entered > 0 ? round2((wins / entered) * 100) : 0;
  return {
    sessions,
    noEntry,
    wins,
    lateWins,
    losses,
    winRatePct,
    inMinuteWinPct,
    excludedSessions: excludedSessions > 0 ? excludedSessions : undefined,
  };
}

function buildSlice(
  label: string,
  trades: NineFifteenHighMinus5Trade[],
  red915Only: boolean,
  excludedSessions = 0,
): NineFifteenHighMinus5BacktestSlice {
  return {
    label,
    rules: baseRules(red915Only),
    stats: summarise(trades, excludedSessions),
    trades,
  };
}

function buildOpenAtOpenSlice(
  label: string,
  trades: NineFifteenHighMinus5Trade[],
): NineFifteenHighMinus5BacktestSlice {
  return {
    label,
    rules: openAtOpenRules(),
    stats: summarise(trades),
    trades,
  };
}

function buildFromMinuteMap(byDate: MinuteMap, days: number): NineFifteenHighMinus5BacktestResult {
  const sortedDates = [...byDate.keys()].sort().slice(-days);
  const allTrades: NineFifteenHighMinus5Trade[] = [];
  const redTrades: NineFifteenHighMinus5Trade[] = [];
  const openAtOpenTrades: NineFifteenHighMinus5Trade[] = [];
  const warnings: string[] = [];

  for (const date of sortedDates) {
    const candles = byDate.get(date);
    if (!candles) continue;
    candles.sort((a, b) => a.mins - b.mins);
    const bar915 = candles.find((c) => c.mins === SESSION_OPEN_MINUTES);
    if (!bar915) continue;
    const sessionCandles = candles.filter(
      (c) => c.mins >= SESSION_OPEN_MINUTES && c.mins <= SESSION_CLOSE_MINUTES,
    );
    if (!isValidSessionDay(sessionCandles)) continue;
    const trade = simulateHighMinus5Day(date, bar915, sessionCandles);
    allTrades.push(trade);
    if (isRed915Bar(bar915)) redTrades.push(trade);
    openAtOpenTrades.push(simulateOpenAtOpenMinus10Day(date, bar915, sessionCandles));
  }

  allTrades.sort((a, b) => b.date.localeCompare(a.date));
  redTrades.sort((a, b) => b.date.localeCompare(a.date));
  openAtOpenTrades.sort((a, b) => b.date.localeCompare(a.date));

  return {
    from: allTrades[allTrades.length - 1]?.date ?? "",
    to: allTrades[0]?.date ?? "",
    daysRequested: days,
    builtAt: new Date().toISOString(),
    all: buildSlice("Open − 5 entry · TP entry − 10", allTrades, false),
    red915Only: buildSlice(
      "Open − 5 entry · red 9:15 only",
      redTrades,
      true,
      allTrades.length - redTrades.length,
    ),
    openAtOpen: buildOpenAtOpenSlice(
      "Enter at 9:15 open · TP open − 10",
      openAtOpenTrades,
    ),
    warnings,
  };
}

async function fetchAndBuild(
  accessToken: string,
  days: number,
  profile: IndexProfile,
): Promise<NineFifteenHighMinus5BacktestResult> {
  const calendarLookback = Math.ceil(days * 7 / 5) + 14;
  const tradingDates = listWeekdayDates(calendarLookback);
  const chunks = chunkTradingDates(tradingDates, CHUNK_TRADING_DAYS);
  const byDate: MinuteMap = new Map();
  let rawCount = 0;

  for (const chunk of chunks) {
    const from = `${chunk[0]} 09:15:00`;
    const to = `${chunk[chunk.length - 1]} 15:30:00`;
    const { candles } = await fetchHistoricalCandles(accessToken, profile.spotKey, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error("Invalid candle response from Kite");
    rawCount += candles.length;
    ingestRawCandles(candles, byDate);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  if (rawCount === 0) throw new Error("No historical candles returned from Kite");

  const result = buildFromMinuteMap(byDate, days);
  if (result.all.trades.length === 0) {
    throw new Error("No complete NSE session days in Kite data");
  }
  return result;
}

function readMeta(): { at: number; version?: number } | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    return JSON.parse(fs.readFileSync(META_FILE, "utf8")) as { at: number; version?: number };
  } catch {
    return null;
  }
}

function writeCache(result: NineFifteenHighMinus5BacktestResult): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, CACHE_FILE);
  const at = Date.now();
  fs.writeFileSync(META_FILE, JSON.stringify({ at, version: CACHE_VERSION }));
  return at;
}

function readCache(): NineFifteenHighMinus5BacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE));
    const parsed = JSON.parse(raw.toString("utf8")) as { data?: NineFifteenHighMinus5BacktestResult };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

let inflight: Promise<NineFifteenHighMinus5BacktestResult> | null = null;

export async function ensureHighMinus5Backtest(
  accessToken: string,
  daysRequested = NINE_FIFTEEN_HIGH_MINUS5_DEFAULT_DAYS,
  force = false,
  profile: IndexProfile = NIFTY_INDEX_PROFILE,
): Promise<{ data: NineFifteenHighMinus5BacktestResult; cached: boolean; builtAt: number }> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), NINE_FIFTEEN_HIGH_MINUS5_DEFAULT_DAYS);
  const meta = force ? null : readMeta();

  if (meta && meta.version === CACHE_VERSION && Date.now() - meta.at < CACHE_MS && !force) {
    const cached = readCache();
    if (cached && cached.daysRequested === days) {
      return { data: cached, cached: true, builtAt: meta.at };
    }
  }

  if (!inflight) {
    inflight = fetchAndBuild(accessToken, days, profile)
      .then((result) => {
        writeCache(result);
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const stale = readCache();
  if (stale && stale.daysRequested === days && meta && !force) {
    inflight.catch(() => undefined);
    return { data: stale, cached: true, builtAt: meta.at };
  }

  const data = await inflight;
  return { data, cached: false, builtAt: Date.now() };
}
