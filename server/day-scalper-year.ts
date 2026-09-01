import fs from "fs";
import path from "path";
import type {
  DayScalperYearCloseMarkRow,
  DayScalperYearDayRow,
  DayScalperYearPackedBar,
  DayScalperYearResult,
  DayScalperYearSession,
  DayScalperYearTotals,
  DayScalperYearView,
} from "../src/types/day-scalper-year.js";
import {
  DAY_SCALPER_YEAR_CLOSE_MARKS,
  DAY_SCALPER_YEAR_INITIAL_STOPS,
  DAY_SCALPER_YEAR_MIN_MOVES,
} from "../src/types/day-scalper-year.js";
import { clampCloseMarkPts, DAY_SCALPER_CLOSE_MARK_DEFAULT } from "../src/types/day-scalper.js";
import type {
  DayScalperCandle,
  DayScalperRules,
  DayScalperSignalToMarkStats,
  DayScalperTrade,
} from "../src/types/day-scalper.js";
import {
  chunk,
  groupSessionBars,
  isCompleteSession,
  listWeekdayDates,
} from "./session-bars.js";
import {
  DAY_SCALPER_RULES,
  emptySignalToMarkStats,
  mergeSignalToMarkStats,
  simulateDayScalperTrades,
} from "./day-scalper.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";

const LOOKBACK_CALENDAR_DAYS = 365;
const CHUNK_TRADING_DAYS = 25;
const FETCH_SPACING_MS = 450;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_VERSION = "v13:open-gate-pullback-tp3";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? round2((part / whole) * 100) : 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Rehydrates packed cache rows into the candle shape the simulator expects. */
function unpackSession(session: DayScalperYearSession): DayScalperCandle[] {
  return session.bars.map(([mins, open, high, low, close]) => ({
    time: "",
    timeIst: `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`,
    mins,
    open,
    high,
    low,
    close,
  }));
}

function dayRow(
  date: string,
  trades: DayScalperTrade[],
): DayScalperYearDayRow {
  let ceTrades = 0;
  let peTrades = 0;
  let wins = 0;
  let losses = 0;
  let netPts = 0;
  let liveMinutes = 0;

  for (const trade of trades) {
    if (trade.side === "CE") ceTrades += 1;
    else peTrades += 1;
    if (trade.pnlPts > 0) wins += 1;
    else losses += 1;
    netPts += trade.pnlPts;
    liveMinutes += trade.liveMinutes;
  }

  const count = trades.length;
  return {
    date,
    weekday: formatWeekdayFromDateKey(date),
    trades: count,
    ceTrades,
    peTrades,
    wins,
    losses,
    winPct: pct(wins, count),
    lossPct: pct(losses, count),
    netPts: round2(netPts),
    avgPtsPerTrade: count > 0 ? round2(netPts / count) : 0,
    avgLiveMinutes: count > 0 ? round2(liveMinutes / count) : 0,
  };
}

function totalsFor(
  days: DayScalperYearDayRow[],
  sessions: number,
  signalToMark: DayScalperSignalToMarkStats,
): DayScalperYearTotals {
  let totalTrades = 0;
  let ceTrades = 0;
  let peTrades = 0;
  let wins = 0;
  let losses = 0;
  let netPts = 0;
  let daysWithTrades = 0;

  for (const day of days) {
    totalTrades += day.trades;
    ceTrades += day.ceTrades;
    peTrades += day.peTrades;
    wins += day.wins;
    losses += day.losses;
    netPts += day.netPts;
    if (day.trades > 0) daysWithTrades += 1;
  }

  return {
    sessions,
    daysWithTrades,
    totalTrades,
    ceTrades,
    peTrades,
    wins,
    losses,
    winPct: pct(wins, totalTrades),
    lossPct: pct(losses, totalTrades),
    netPts: round2(netPts),
    avgTradesPerDay: sessions > 0 ? round2(totalTrades / sessions) : 0,
    avgPtsPerDay: sessions > 0 ? round2(netPts / sessions) : 0,
    signalToMark,
  };
}

interface YearRun {
  days: DayScalperYearDayRow[];
  totals: DayScalperYearTotals;
}

/**
 * Replays every cached session under one exact rule set. The close→mark minimum is part of the
 * rules rather than a filter applied to finished trades: a rejected signal must leave the book
 * flat so the *next* signal stays eligible, which post-hoc filtering cannot reproduce.
 */
/**
 * One view fans out to ~52 year replays (every stop, plus body and gap on the axes the user is
 * dragging), and consecutive slider positions re-request most of the same ones. Insertion order
 * gives a cheap LRU.
 */
const RUN_CACHE_LIMIT = 200;
const runCache = new Map<string, YearRun>();

function runYearCached(result: DayScalperYearResult, rules: DayScalperRules): YearRun {
  const key = `${result.builtAt}|${rules.minMovePts}|${rules.initialStopPts}|${rules.minCloseMarkPts}`;
  const hit = runCache.get(key);
  if (hit) {
    runCache.delete(key);
    runCache.set(key, hit);
    return hit;
  }

  const run = runYear(result, rules);
  runCache.set(key, run);
  if (runCache.size > RUN_CACHE_LIMIT) {
    const oldest = runCache.keys().next().value;
    if (oldest !== undefined) runCache.delete(oldest);
  }
  return run;
}

function runYear(result: DayScalperYearResult, rules: DayScalperRules): YearRun {
  const days: DayScalperYearDayRow[] = [];
  let signalToMark = emptySignalToMarkStats();

  for (const session of result.sessionBars) {
    const { trades, summary } = simulateDayScalperTrades(
      unpackSession(session),
      rules,
      session.weekday,
    );
    days.push(dayRow(session.date, trades));
    signalToMark = mergeSignalToMarkStats(signalToMark, summary.signalToMark);
  }

  days.sort((a, b) => b.date.localeCompare(a.date));
  return { days, totals: totalsFor(days, result.sessions, signalToMark) };
}

export async function buildDayScalperYear(
  accessToken: string,
  spotKey: string,
): Promise<DayScalperYearResult> {
  const dates = listWeekdayDates(LOOKBACK_CALENDAR_DAYS);
  if (dates.length === 0) throw new Error("No dates in range");

  const sessionBars: DayScalperYearSession[] = [];
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  for (const group of chunk(dates, CHUNK_TRADING_DAYS)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    const { candles: raw } = await fetchHistoricalCandles(accessToken, spotKey, "minute", from, to);
    if (!Array.isArray(raw)) throw new Error("Invalid candle response from Kite");

    const byDate = groupSessionBars(raw);
    for (const [date, bars] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!isCompleteSession(bars)) continue;
      if (firstDate == null || date < firstDate) firstDate = date;
      if (lastDate == null || date > lastDate) lastDate = date;

      sessionBars.push({
        date,
        weekday: formatWeekdayFromDateKey(date),
        bars: bars.map(
          (bar) =>
            [bar.mins, bar.open, bar.high, bar.low, bar.close] as DayScalperYearPackedBar,
        ),
      });
    }
    byDate.clear();
    await new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS));
  }

  if (sessionBars.length === 0) throw new Error("No complete NSE sessions in the Kite response");

  return {
    fromDate: firstDate ?? "",
    toDate: lastDate ?? "",
    sessions: sessionBars.length,
    builtAt: Date.now(),
    rules: DAY_SCALPER_RULES,
    availableMinMoves: [...DAY_SCALPER_YEAR_MIN_MOVES],
    availableInitialStops: [...DAY_SCALPER_YEAR_INITIAL_STOPS],
    availableCloseMarks: [...DAY_SCALPER_YEAR_CLOSE_MARKS],
    sessionBars,
  };
}

function resolveFromAvailable(requested: number, available: number[], fallback: number): number {
  return available.includes(requested)
    ? requested
    : available.reduce(
        (best, value) =>
          Math.abs(value - requested) < Math.abs(best - requested) ? value : best,
        available[0] ?? fallback,
      );
}

export function pickDayScalperYearView(
  result: DayScalperYearResult,
  minMovePts: number,
  initialStopPts: number,
  closeMarkPts = DAY_SCALPER_CLOSE_MARK_DEFAULT,
): DayScalperYearView {
  const resolvedMin = resolveFromAvailable(
    minMovePts,
    result.availableMinMoves,
    DAY_SCALPER_RULES.minMovePts,
  );
  const resolvedStop = resolveFromAvailable(
    initialStopPts,
    result.availableInitialStops,
    DAY_SCALPER_RULES.initialStopPts,
  );
  const resolvedCloseMark = clampCloseMarkPts(closeMarkPts);

  const rulesFor = (
    overrides: Partial<DayScalperRules>,
  ): DayScalperRules => ({
    ...DAY_SCALPER_RULES,
    minMovePts: resolvedMin,
    initialStopPts: resolvedStop,
    minCloseMarkPts: resolvedCloseMark,
    ...overrides,
  });

  const selected = runYearCached(result, rulesFor({}));

  // Each comparison row is its own full replay, so the numbers stay consistent with the headline
  // slice instead of being re-derived from a differently-sequenced trade list.
  const stopComparison = result.availableInitialStops
    .map((value) => {
      const totals =
        value === resolvedStop
          ? selected.totals
          : runYearCached(result, rulesFor({ initialStopPts: value })).totals;
      return {
        initialStopPts: value,
        totalTrades: totals.totalTrades,
        winPct: totals.winPct,
        netPts: totals.netPts,
      };
    })
    .sort((a, b) => b.netPts - a.netPts);

  const minMoveComparison = result.availableMinMoves
    .map((value) => {
      const totals =
        value === resolvedMin
          ? selected.totals
          : runYearCached(result, rulesFor({ minMovePts: value })).totals;
      return {
        minMovePts: value,
        totalTrades: totals.totalTrades,
        winPct: totals.winPct,
        netPts: totals.netPts,
      };
    })
    .sort((a, b) => b.netPts - a.netPts);

  const closeMarkComparison: DayScalperYearCloseMarkRow[] = [];

  return {
    fromDate: result.fromDate,
    toDate: result.toDate,
    sessions: result.sessions,
    builtAt: result.builtAt,
    minMovePts: resolvedMin,
    initialStopPts: resolvedStop,
    closeMarkPts: resolvedCloseMark,
    availableMinMoves: result.availableMinMoves,
    availableInitialStops: result.availableInitialStops,
    availableCloseMarks: result.availableCloseMarks,
    rules: rulesFor({}),
    days: selected.days,
    totals: selected.totals,
    stopComparison,
    minMoveComparison,
    closeMarkComparison,
  };
}

function cacheFile(): string {
  return path.join(process.cwd(), "data", "day-scalper-year-cache.json");
}

interface CacheEnvelope {
  version: string;
  builtAt: number;
  data: DayScalperYearResult;
}

function readCache(): CacheEnvelope | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as CacheEnvelope;
    if (parsed?.version !== CACHE_VERSION || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(data: DayScalperYearResult): void {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const envelope: CacheEnvelope = { version: CACHE_VERSION, builtAt: data.builtAt, data };
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  fs.renameSync(tmp, file);
}

let inFlight: Promise<DayScalperYearResult> | null = null;

export async function ensureDayScalperYear(
  accessToken: string,
  spotKey: string,
  force = false,
): Promise<DayScalperYearResult> {
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached.data;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await buildDayScalperYear(accessToken, spotKey);
      writeCache(result);
      return result;
    } catch (error) {
      const cached = readCache();
      if (cached) return cached.data;
      throw error;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
