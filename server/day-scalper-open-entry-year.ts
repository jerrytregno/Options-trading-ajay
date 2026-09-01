/**
 * Momentum scalper backtest — body-only signal, next-bar open entry, trailing ladder after ±5.
 *
 * Before +5 prints the initial −12 index stop applies. Touching +5 arms the ladder: TP steps to
 * +7 with SL at +5, then +9/+7, +11/+9, and so on in +2-point pairs. Only the stop exits once
 * armed — reaching the TP rung only ratchets the ladder higher.
 */
import fs from "fs";
import path from "path";
import type { DayScalperCandle } from "../src/types/day-scalper.js";
import type {
  DayScalperOpenEntryDayRow,
  DayScalperOpenEntryOutcome,
  DayScalperOpenEntryTimeBucket,
  DayScalperOpenEntryTotals,
  DayScalperOpenEntryTrade,
  DayScalperOpenEntryYearResult,
} from "../src/types/day-scalper-open-entry-year.js";
import {
  DAY_SCALPER_OPEN_ENTRY_ARM_PTS,
  DAY_SCALPER_OPEN_ENTRY_BUCKET_MINS,
  DAY_SCALPER_OPEN_ENTRY_LONG_TRADE_MINS,
  DAY_SCALPER_OPEN_ENTRY_MIN_BODY_PTS,
  DAY_SCALPER_OPEN_ENTRY_SL_PTS,
  DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS,
  DAY_SCALPER_OPEN_ENTRY_WINDOW_CLOSE,
  DAY_SCALPER_OPEN_ENTRY_WINDOW_OPEN,
} from "../src/types/day-scalper-open-entry-year.js";
import type { MinuteBar } from "./session-bars.js";
import {
  chunk,
  groupSessionBars,
  isCompleteSession,
  listWeekdayDates,
} from "./session-bars.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";

const LOOKBACK_CALENDAR_DAYS = 365;
const CHUNK_TRADING_DAYS = 25;
const FETCH_SPACING_MS = 450;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_VERSION = "v2:open-entry-trail-arm5-step2-sl12-time-buckets";
const MAX_TRADES_IN_PAYLOAD = 3000;

const WINDOW_OPEN_MINS = 9 * 60 + 20;
const WINDOW_CLOSE_MINS = 14 * 60;

const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);
const pad2 = (v: number) => String(v).padStart(2, "0");
const hhmm = (mins: number) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;

function barsToCandles(bars: MinuteBar[]): DayScalperCandle[] {
  return bars as DayScalperCandle[];
}

interface TrailExit {
  outcome: DayScalperOpenEntryOutcome;
  exitIndex: number;
  exitPrice: number;
  peakLockedPts: number;
  tpPts: number;
  slPts: number;
}

/**
 * Initial −12 stop until +5 arms the ladder. Each +2 rung raises TP by 2 and locks SL at the
 * previous TP level. SL is checked before ratcheting within a bar; after a ratchet the new SL
 * is checked again on the same bar.
 */
function raceTrailingTpSl(
  candles: DayScalperCandle[],
  entryIndex: number,
  entryPrice: number,
  side: "CE" | "PE",
): TrailExit {
  const signed = side === "CE" ? 1 : -1;
  const initialStopPrice = round2(entryPrice - signed * DAY_SCALPER_OPEN_ENTRY_SL_PTS);

  let armed = false;
  let lockedPts = 0;
  let nextTpPts = DAY_SCALPER_OPEN_ENTRY_ARM_PTS + DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS;
  let stopPrice = initialStopPrice;
  let targetPrice = round2(entryPrice + signed * DAY_SCALPER_OPEN_ENTRY_ARM_PTS);
  let peakLockedPts = 0;

  let lastIndex = entryIndex;
  let lastClose = candles[entryIndex]?.close ?? entryPrice;

  const slPtsFromEntry = () => round2(Math.abs((stopPrice - entryPrice) / signed));
  const tpPtsFromEntry = () => round2(Math.abs((targetPrice - entryPrice) / signed));

  const checkTrailStop = (bar: DayScalperCandle): TrailExit | null => {
    const hit = side === "CE" ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (!hit) return null;
    return {
      outcome: armed ? "trail-stop" : "initial-stop",
      exitIndex: lastIndex,
      exitPrice: stopPrice,
      peakLockedPts,
      tpPts: tpPtsFromEntry(),
      slPts: slPtsFromEntry(),
    };
  };

  const ratchetOnFavourable = (favPts: number): void => {
    while (favPts >= nextTpPts) {
      lockedPts = nextTpPts;
      peakLockedPts = Math.max(peakLockedPts, lockedPts);
      stopPrice = round2(entryPrice + signed * lockedPts);
      nextTpPts = lockedPts + DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS;
      targetPrice = round2(entryPrice + signed * nextTpPts);
    }
  };

  for (let j = entryIndex; j < candles.length; j += 1) {
    const bar = candles[j];
    if (bar.mins > WINDOW_CLOSE_MINS) break;
    lastIndex = j;
    lastClose = bar.close;

    const favPts = round2(
      side === "CE" ? bar.high - entryPrice : entryPrice - bar.low,
    );

    if (!armed) {
      const initialHit = side === "CE" ? bar.low <= initialStopPrice : bar.high >= initialStopPrice;
      if (initialHit) {
        return {
          outcome: "initial-stop",
          exitIndex: j,
          exitPrice: initialStopPrice,
          peakLockedPts: 0,
          tpPts: DAY_SCALPER_OPEN_ENTRY_ARM_PTS + DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS,
          slPts: DAY_SCALPER_OPEN_ENTRY_SL_PTS,
        };
      }

      if (favPts >= DAY_SCALPER_OPEN_ENTRY_ARM_PTS) {
        armed = true;
        lockedPts = DAY_SCALPER_OPEN_ENTRY_ARM_PTS;
        peakLockedPts = lockedPts;
        stopPrice = round2(entryPrice + signed * lockedPts);
        nextTpPts = lockedPts + DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS;
        targetPrice = round2(entryPrice + signed * nextTpPts);
      } else {
        continue;
      }
    }

    const stopOut = checkTrailStop(bar);
    if (stopOut) {
      stopOut.exitIndex = j;
      return stopOut;
    }

    ratchetOnFavourable(favPts);

    const stopAfterRatchet = checkTrailStop(bar);
    if (stopAfterRatchet) {
      stopAfterRatchet.exitIndex = j;
      return stopAfterRatchet;
    }
  }

  return {
    outcome: "eod",
    exitIndex: lastIndex,
    exitPrice: round2(lastClose),
    peakLockedPts,
    tpPts: tpPtsFromEntry(),
    slPts: slPtsFromEntry(),
  };
}

/** Ten-minute bucket start aligned from 09:20 (560, 570, …). */
export function bucketStartForMins(mins: number): number {
  const offset = mins - WINDOW_OPEN_MINS;
  const slot =
    Math.floor(offset / DAY_SCALPER_OPEN_ENTRY_BUCKET_MINS) * DAY_SCALPER_OPEN_ENTRY_BUCKET_MINS +
    WINDOW_OPEN_MINS;
  return Math.min(
    Math.max(slot, WINDOW_OPEN_MINS),
    WINDOW_CLOSE_MINS - DAY_SCALPER_OPEN_ENTRY_BUCKET_MINS,
  );
}

/** Ten-minute slot label aligned from 09:20 (09:20, 09:30, …). */
export function bucketLabelForMins(mins: number): string {
  return hhmm(bucketStartForMins(mins));
}

/** If the trade was still open 10 minutes after entry, bucket at entry + 10 min; else at entry. */
export function bucketMinsForTrade(entryMins: number, exitMins: number): number {
  return exitMins >= entryMins + DAY_SCALPER_OPEN_ENTRY_LONG_TRADE_MINS
    ? entryMins + DAY_SCALPER_OPEN_ENTRY_LONG_TRADE_MINS
    : entryMins;
}

function allBucketStarts(): number[] {
  const starts: number[] = [];
  for (let m = WINDOW_OPEN_MINS; m < WINDOW_CLOSE_MINS; m += DAY_SCALPER_OPEN_ENTRY_BUCKET_MINS) {
    starts.push(m);
  }
  return starts;
}

function buildTimeBuckets(trades: DayScalperOpenEntryTrade[]): DayScalperOpenEntryTimeBucket[] {
  const map = new Map<number, DayScalperOpenEntryTimeBucket>();
  for (const start of allBucketStarts()) {
    map.set(start, {
      label: hhmm(start),
      startMins: start,
      trades: 0,
      wins: 0,
      losses: 0,
      winPct: 0,
      ceWins: 0,
      ceLosses: 0,
      peWins: 0,
      peLosses: 0,
      netPts: 0,
    });
  }

  for (const trade of trades) {
    const startMins = bucketStartForMins(trade.bucketMins);
    const bucket = map.get(startMins);
    if (!bucket) continue;

    bucket.trades += 1;
    bucket.netPts = round2(bucket.netPts + trade.pnlPts);
    if (trade.won) {
      bucket.wins += 1;
      if (trade.side === "CE") bucket.ceWins += 1;
      else bucket.peWins += 1;
    } else {
      bucket.losses += 1;
      if (trade.side === "CE") bucket.ceLosses += 1;
      else bucket.peLosses += 1;
    }
    bucket.winPct = pct(bucket.wins, bucket.trades);
  }

  return [...map.values()];
}

export function simulateOpenEntryDayScalper(
  candles: DayScalperCandle[],
  date: string,
  weekday: string,
): DayScalperOpenEntryTrade[] {
  const trades: DayScalperOpenEntryTrade[] = [];
  let i = 0;

  while (i < candles.length - 1) {
    const signal = candles[i];
    if (signal.mins < WINDOW_OPEN_MINS) {
      i += 1;
      continue;
    }
    if (signal.mins >= WINDOW_CLOSE_MINS) break;

    const body = round2(signal.close - signal.open);
    const side: "CE" | "PE" | null =
      body > DAY_SCALPER_OPEN_ENTRY_MIN_BODY_PTS
        ? "CE"
        : body < -DAY_SCALPER_OPEN_ENTRY_MIN_BODY_PTS
          ? "PE"
          : null;
    if (!side) {
      i += 1;
      continue;
    }

    const entryBar = candles[i + 1];
    if (!entryBar || entryBar.mins < WINDOW_OPEN_MINS || entryBar.mins > WINDOW_CLOSE_MINS) {
      i += 1;
      continue;
    }

    const entryPrice = entryBar.open;
    const entryMins = entryBar.mins;
    const signed = side === "CE" ? 1 : -1;
    const exited = raceTrailingTpSl(candles, i + 1, entryPrice, side);
    const exitMins = candles[exited.exitIndex].mins;
    const pnlPts = round2(signed * (exited.exitPrice - entryPrice));
    const won = pnlPts >= DAY_SCALPER_OPEN_ENTRY_ARM_PTS;

    trades.push({
      date,
      weekday,
      side,
      signalTimeIst: signal.timeIst,
      signalBodyPts: body,
      entryTimeIst: entryBar.timeIst,
      entryMins,
      entryPrice: round2(entryPrice),
      tpPts: exited.tpPts,
      slPts: exited.slPts,
      peakLockedPts: exited.peakLockedPts,
      exitTimeIst: candles[exited.exitIndex].timeIst,
      exitMins,
      exitPrice: exited.exitPrice,
      outcome: exited.outcome,
      pnlPts,
      won,
      barsHeld: exited.exitIndex - (i + 1) + 1,
      bucketMins: bucketMinsForTrade(entryMins, exitMins),
    });

    i = exited.exitIndex + 1;
  }

  return trades;
}

function dayRow(date: string, trades: DayScalperOpenEntryTrade[]): DayScalperOpenEntryDayRow {
  let wins = 0;
  let losses = 0;
  let ceTrades = 0;
  let peTrades = 0;
  let ceWins = 0;
  let ceLosses = 0;
  let peWins = 0;
  let peLosses = 0;
  let netPts = 0;

  for (const t of trades) {
    netPts += t.pnlPts;
    if (t.side === "CE") {
      ceTrades += 1;
      if (t.won) ceWins += 1;
      else ceLosses += 1;
    } else {
      peTrades += 1;
      if (t.won) peWins += 1;
      else peLosses += 1;
    }
    if (t.won) wins += 1;
    else losses += 1;
  }

  return {
    date,
    weekday: formatWeekdayFromDateKey(date),
    trades: trades.length,
    wins,
    losses,
    ceTrades,
    peTrades,
    ceWins,
    ceLosses,
    peWins,
    peLosses,
    netPts: round2(netPts),
  };
}

function totalsFor(days: DayScalperOpenEntryDayRow[], sessions: number): DayScalperOpenEntryTotals {
  const acc = {
    sessions,
    daysWithTrades: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    ceTrades: 0,
    peTrades: 0,
    ceWins: 0,
    ceLosses: 0,
    peWins: 0,
    peLosses: 0,
    netPts: 0,
  };

  for (const day of days) {
    if (day.trades > 0) acc.daysWithTrades += 1;
    acc.trades += day.trades;
    acc.wins += day.wins;
    acc.losses += day.losses;
    acc.ceTrades += day.ceTrades;
    acc.peTrades += day.peTrades;
    acc.ceWins += day.ceWins;
    acc.ceLosses += day.ceLosses;
    acc.peWins += day.peWins;
    acc.peLosses += day.peLosses;
    acc.netPts += day.netPts;
  }

  return {
    ...acc,
    winPct: pct(acc.wins, acc.trades),
    netPts: round2(acc.netPts),
    avgPtsPerTrade: acc.trades > 0 ? round2(acc.netPts / acc.trades) : 0,
  };
}

export async function buildDayScalperOpenEntryYear(
  accessToken: string,
  spotKey: string,
  indexLabel: string,
): Promise<DayScalperOpenEntryYearResult> {
  const dates = listWeekdayDates(LOOKBACK_CALENDAR_DAYS);
  const days: DayScalperOpenEntryDayRow[] = [];
  const allTrades: DayScalperOpenEntryTrade[] = [];
  let sessions = 0;

  for (const group of chunk(dates, CHUNK_TRADING_DAYS)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    const { candles: raw } = await fetchHistoricalCandles(accessToken, spotKey, "minute", from, to);
    const byDate = groupSessionBars(raw);

    for (const [date, bars] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!isCompleteSession(bars)) continue;
      sessions += 1;
      const candles = barsToCandles(bars);
      const weekday = formatWeekdayFromDateKey(date);
      const trades = simulateOpenEntryDayScalper(candles, date, weekday);
      days.push(dayRow(date, trades));
      allTrades.push(...trades);
    }

    await new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS));
  }

  const sortedDays = days.sort((a, b) => b.date.localeCompare(a.date));
  const sortedTrades = allTrades.sort((a, b) =>
    a.date === b.date ? a.entryTimeIst.localeCompare(b.entryTimeIst) : b.date.localeCompare(a.date),
  );

  return {
    indexLabel,
    fromDate: sortedDays[sortedDays.length - 1]?.date ?? dates[0] ?? "",
    toDate: sortedDays[0]?.date ?? dates[dates.length - 1] ?? "",
    sessions,
    windowOpenIst: DAY_SCALPER_OPEN_ENTRY_WINDOW_OPEN,
    windowCloseIst: DAY_SCALPER_OPEN_ENTRY_WINDOW_CLOSE,
    minBodyPts: DAY_SCALPER_OPEN_ENTRY_MIN_BODY_PTS,
    armPts: DAY_SCALPER_OPEN_ENTRY_ARM_PTS,
    initialSlPts: DAY_SCALPER_OPEN_ENTRY_SL_PTS,
    trailStepPts: DAY_SCALPER_OPEN_ENTRY_TRAIL_STEP_PTS,
    builtAt: new Date().toISOString(),
    totals: totalsFor(days, sessions),
    timeBuckets: buildTimeBuckets(sortedTrades),
    days: sortedDays,
    trades: sortedTrades.slice(0, MAX_TRADES_IN_PAYLOAD),
    totalTrades: sortedTrades.length,
  };
}

function cacheFile(): string {
  return path.join(process.cwd(), "data", "day-scalper-open-entry-year-cache.json");
}

interface CacheEnvelope {
  version: string;
  builtAt: number;
  data: DayScalperOpenEntryYearResult;
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

function writeCache(data: DayScalperOpenEntryYearResult): void {
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const envelope: CacheEnvelope = { version: CACHE_VERSION, builtAt: Date.now(), data };
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  fs.renameSync(tmp, file);
}

let inFlight: Promise<DayScalperOpenEntryYearResult> | null = null;

export async function ensureDayScalperOpenEntryYear(
  accessToken: string,
  spotKey: string,
  indexLabel: string,
  force = false,
): Promise<DayScalperOpenEntryYearResult> {
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached.data;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await buildDayScalperOpenEntryYear(accessToken, spotKey, indexLabel);
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
