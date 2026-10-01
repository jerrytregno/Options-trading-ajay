import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import type {
  NineFifteenHighMinus5BacktestResult,
  NineFifteenHighMinus5BacktestSlice,
  NineFifteenHighMinus5Stats,
  NineFifteenHighMinus5Trade,
  NineFifteenSmallGreenPre10RallySlice,
  NineFifteenSmallGreenPre10RallyTrade,
  NineFifteenSmallRedPre10SelloffSlice,
  NineFifteenSmallRedPre10SelloffTrade,
} from "../src/types/nine-fifteen-high-minus5-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { buildFullDayFromSessions } from "./nine-fifteen-full-day-backtest.js";
import {
  NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
  NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
} from "./nine-fifteen-high-minus5-backtest.js";

const IST = "Asia/Kolkata";
const CHUNK_TRADING_DAYS = 40;
const CACHE_MS = 12 * 60 * 60 * 1000;

export interface OpenOffsetSessionConfig {
  sessionOpenMinutes: number;
  sessionCloseMinutes: number;
  minSessionMinuteBars: number;
  winWindowEndIst: string;
  scanEndIst: string;
  /** UI label for the signal minute, e.g. "9:15" or "9:00". */
  signalMinuteLabel: string;
  /** Minute after signal minute — late wins start here, e.g. "9:16:00". */
  lateWinAfterIst: string;
  instrumentLabel: string;
  fetchFromTime: string;
  fetchToTime: string;
}

/** Max small 9:15 body (|close − open|) for the pre-10 move studies. */
export const SMALL_GREEN_MAX_BODY_PTS = 5;
export const SMALL_RED_MAX_BODY_PTS = 5;
/** Min move from 9:15 open before 10:00 IST (+ for green rally, − for red selloff). */
export const PRE10_RALLY_FROM_OPEN_PTS = 20;
export const PRE10_SELLOFF_FROM_OPEN_PTS = 20;
const PRE10_WINDOW_END_MINS = 10 * 60;

export const NIFTY_OPEN_OFFSET_SESSION: OpenOffsetSessionConfig = {
  sessionOpenMinutes: 9 * 60 + 15,
  sessionCloseMinutes: 15 * 60 + 30,
  minSessionMinuteBars: 330,
  winWindowEndIst: "9:15:59",
  scanEndIst: "15:30",
  signalMinuteLabel: "9:15",
  lateWinAfterIst: "9:16:00",
  instrumentLabel: "Nifty",
  fetchFromTime: "09:15:00",
  fetchToTime: "15:30:00",
};

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

function isValidSessionDay(candles: MinuteBar[], session: OpenOffsetSessionConfig): boolean {
  if (candles.length < session.minSessionMinuteBars) return false;
  return candles.some((c) => c.mins === session.sessionOpenMinutes);
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

function ingestRawCandles(raw: unknown[], byDate: MinuteMap, session: OpenOffsetSessionConfig): void {
  for (const item of raw) {
    if (!isKiteMinuteCandleTuple(item)) continue;
    const [time, open, high, low, close] = item;
    const parsed = new Date(String(time));
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinutes(parsed);
    if (mins < session.sessionOpenMinutes || mins > session.sessionCloseMinutes) continue;

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

function tradeFields(
  signalBar: Pick<MinuteBar, "open" | "high" | "low" | "close">,
): Pick<
  NineFifteenHighMinus5Trade,
  "open915" | "high915" | "low915" | "close915" | "change915"
> {
  return {
    open915: round2(signalBar.open),
    high915: round2(signalBar.high),
    low915: round2(signalBar.low),
    close915: round2(signalBar.close),
    change915: round2(signalBar.close - signalBar.open),
  };
}

export function simulateHighMinus5Day(
  date: string,
  signalBar: Pick<MinuteBar, "open" | "high" | "low" | "close">,
  sessionCandles: Pick<MinuteBar, "mins" | "low">[],
  session: OpenOffsetSessionConfig = NIFTY_OPEN_OFFSET_SESSION,
  options?: { tpEarliestMins?: number },
): NineFifteenHighMinus5Trade {
  const entryLevel = round2(signalBar.open - NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET);
  const tpLevel = round2(entryLevel - NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET);
  const tpEarliestMins = options?.tpEarliestMins ?? session.sessionOpenMinutes;

  const ordered = [...sessionCandles]
    .filter(
      (c) => c.mins >= session.sessionOpenMinutes && c.mins <= session.sessionCloseMinutes,
    )
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
    if (entered && bar.mins >= tpEarliestMins && bar.low <= tpLevel + 1e-9) {
      const tpMins = bar.mins;
      const tpTimeIst = formatIstHms(tpMins * 60);
      const outcome = tpMins === session.sessionOpenMinutes ? "win" : "late_win";
      return {
        date,
        weekday: weekdayFromDateKey(date),
        ...tradeFields(signalBar),
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
      ...tradeFields(signalBar),
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
    ...tradeFields(signalBar),
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

export function tpEarliestMinsAfterSignalMinute(session: OpenOffsetSessionConfig): number {
  return session.sessionOpenMinutes + 1;
}

export function simulateHighPlus5Day(
  date: string,
  signalBar: Pick<MinuteBar, "open" | "high" | "low" | "close">,
  sessionCandles: Pick<MinuteBar, "mins" | "high">[],
  session: OpenOffsetSessionConfig = NIFTY_OPEN_OFFSET_SESSION,
  options?: { tpEarliestMins?: number },
): NineFifteenHighMinus5Trade {
  const entryLevel = round2(signalBar.open + NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET);
  const tpLevel = round2(entryLevel + NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET);
  const tpEarliestMins = options?.tpEarliestMins ?? session.sessionOpenMinutes;

  const ordered = [...sessionCandles]
    .filter(
      (c) => c.mins >= session.sessionOpenMinutes && c.mins <= session.sessionCloseMinutes,
    )
    .sort((a, b) => a.mins - b.mins);

  let entered = false;
  let entryTimeIst: string | null = null;
  let entryMins: number | null = null;

  for (const bar of ordered) {
    if (!entered && bar.high >= entryLevel - 1e-9) {
      entered = true;
      entryMins = bar.mins;
      entryTimeIst = formatIstHms(bar.mins * 60);
    }
    if (entered && bar.mins >= tpEarliestMins && bar.high >= tpLevel - 1e-9) {
      const tpMins = bar.mins;
      const tpTimeIst = formatIstHms(tpMins * 60);
      const outcome = tpMins === session.sessionOpenMinutes ? "win" : "late_win";
      return {
        date,
        weekday: weekdayFromDateKey(date),
        ...tradeFields(signalBar),
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
      ...tradeFields(signalBar),
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
    ...tradeFields(signalBar),
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

export function simulateOpenAtOpenMinus10Day(
  date: string,
  signalBar: Pick<MinuteBar, "open" | "high" | "low" | "close">,
  sessionCandles: Pick<MinuteBar, "mins" | "low">[],
  session: OpenOffsetSessionConfig = NIFTY_OPEN_OFFSET_SESSION,
): NineFifteenHighMinus5Trade {
  const entryLevel = round2(signalBar.open);
  const tpLevel = round2(entryLevel - NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET);
  const entryTimeIst = formatIstHms(session.sessionOpenMinutes * 60);
  const entryMins = session.sessionOpenMinutes;

  const ordered = [...sessionCandles]
    .filter(
      (c) => c.mins >= session.sessionOpenMinutes && c.mins <= session.sessionCloseMinutes,
    )
    .sort((a, b) => a.mins - b.mins);

  for (const bar of ordered) {
    if (bar.low <= tpLevel + 1e-9) {
      const tpMins = bar.mins;
      const tpTimeIst = formatIstHms(tpMins * 60);
      const outcome = tpMins === session.sessionOpenMinutes ? "win" : "late_win";
      return {
        date,
        weekday: weekdayFromDateKey(date),
        ...tradeFields(signalBar),
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
    ...tradeFields(signalBar),
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

function isRedSignalBar(bar: Pick<MinuteBar, "open" | "close">): boolean {
  return bar.close < bar.open - 1e-9;
}

function isGreenSignalBar(bar: Pick<MinuteBar, "open" | "close">): boolean {
  return bar.close > bar.open + 1e-9;
}

export function isSmallGreen915Body(bar: Pick<MinuteBar, "open" | "close">): boolean {
  const change = bar.close - bar.open;
  return change > 1e-9 && change <= SMALL_GREEN_MAX_BODY_PTS + 1e-9;
}

export function isSmallRed915Body(bar: Pick<MinuteBar, "open" | "close">): boolean {
  const change = bar.close - bar.open;
  return change < -1e-9 && -change <= SMALL_RED_MAX_BODY_PTS + 1e-9;
}

export function maxRallyBefore10FromOpen(
  open915: number,
  sessionCandles: Pick<MinuteBar, "mins" | "high">[],
  session: OpenOffsetSessionConfig = NIFTY_OPEN_OFFSET_SESSION,
): { maxRallyPts: number; maxRallyMins: number | null } {
  let maxHigh = open915;
  let maxRallyMins: number | null = null;
  for (const bar of sessionCandles) {
    if (bar.mins < session.sessionOpenMinutes || bar.mins >= PRE10_WINDOW_END_MINS) continue;
    if (bar.high > maxHigh + 1e-9) {
      maxHigh = bar.high;
      maxRallyMins = bar.mins;
    }
  }
  return { maxRallyPts: round2(maxHigh - open915), maxRallyMins };
}

export function maxSelloffBefore10FromOpen(
  open915: number,
  sessionCandles: Pick<MinuteBar, "mins" | "low">[],
  session: OpenOffsetSessionConfig = NIFTY_OPEN_OFFSET_SESSION,
): { maxSelloffPts: number; maxSelloffMins: number | null } {
  let minLow = open915;
  let maxSelloffMins: number | null = null;
  for (const bar of sessionCandles) {
    if (bar.mins < session.sessionOpenMinutes || bar.mins >= PRE10_WINDOW_END_MINS) continue;
    if (bar.low < minLow - 1e-9) {
      minLow = bar.low;
      maxSelloffMins = bar.mins;
    }
  }
  return { maxSelloffPts: round2(open915 - minLow), maxSelloffMins };
}

function baseRules(session: OpenOffsetSessionConfig, redOnly = false) {
  return {
    variant: "limit_open_minus_5" as const,
    entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
    tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
    winWindowEndIst: session.winWindowEndIst,
    scanEndIst: session.scanEndIst,
    red915Only: redOnly || undefined,
    entryDirection: "below" as const,
    tpDirection: "below" as const,
    signalMinuteLabel: session.signalMinuteLabel,
    instrumentLabel: session.instrumentLabel,
    lateWinAfterIst: session.lateWinAfterIst,
  };
}

function greenRules(session: OpenOffsetSessionConfig) {
  return {
    variant: "limit_open_plus_5" as const,
    entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
    tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
    winWindowEndIst: session.winWindowEndIst,
    scanEndIst: session.scanEndIst,
    green915Only: true,
    entryDirection: "above" as const,
    tpDirection: "above" as const,
    signalMinuteLabel: session.signalMinuteLabel,
    instrumentLabel: session.instrumentLabel,
    lateWinAfterIst: session.lateWinAfterIst,
  };
}

function openAtOpenRules(session: OpenOffsetSessionConfig) {
  return {
    variant: "market_at_open" as const,
    entryOffsetFromOpen: 0,
    tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
    winWindowEndIst: session.winWindowEndIst,
    scanEndIst: session.scanEndIst,
    signalMinuteLabel: session.signalMinuteLabel,
    instrumentLabel: session.instrumentLabel,
    lateWinAfterIst: session.lateWinAfterIst,
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
  session: OpenOffsetSessionConfig,
  redOnly: boolean,
  excludedSessions = 0,
): NineFifteenHighMinus5BacktestSlice {
  return {
    label,
    rules: baseRules(session, redOnly),
    stats: summarise(trades, excludedSessions),
    trades,
  };
}

function buildGreenSlice(
  label: string,
  trades: NineFifteenHighMinus5Trade[],
  session: OpenOffsetSessionConfig,
  excludedSessions = 0,
): NineFifteenHighMinus5BacktestSlice {
  return {
    label,
    rules: greenRules(session),
    stats: summarise(trades, excludedSessions),
    trades,
  };
}

function buildOpenAtOpenSlice(
  label: string,
  trades: NineFifteenHighMinus5Trade[],
  session: OpenOffsetSessionConfig,
): NineFifteenHighMinus5BacktestSlice {
  return {
    label,
    rules: openAtOpenRules(session),
    stats: summarise(trades),
    trades,
  };
}

function buildSmallGreenPre10Slice(
  trades: NineFifteenSmallGreenPre10RallyTrade[],
  greenSmallBodyDays: number,
  session: OpenOffsetSessionConfig,
): NineFifteenSmallGreenPre10RallySlice {
  return {
    label: `Small green ${session.signalMinuteLabel} · +${PRE10_RALLY_FROM_OPEN_PTS} before 10:00`,
    rules: {
      maxGreenBodyPts: SMALL_GREEN_MAX_BODY_PTS,
      pre10RallyMinPts: PRE10_RALLY_FROM_OPEN_PTS,
      pre10WindowEndIst: "10:00:00",
      entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
      tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
      tpEarliestIst: session.lateWinAfterIst,
      scanEndIst: session.scanEndIst,
      winWindowEndIst: session.winWindowEndIst,
      lateWinAfterIst: session.lateWinAfterIst,
      signalMinuteLabel: session.signalMinuteLabel,
      instrumentLabel: session.instrumentLabel,
    },
    greenSmallBodyDays,
    matchingDays: trades.length,
    stats: summarise(trades),
    trades,
  };
}

function buildSmallRedPre10Slice(
  trades: NineFifteenSmallRedPre10SelloffTrade[],
  redSmallBodyDays: number,
  session: OpenOffsetSessionConfig,
): NineFifteenSmallRedPre10SelloffSlice {
  return {
    label: `Small red ${session.signalMinuteLabel} · −${PRE10_SELLOFF_FROM_OPEN_PTS} before 10:00`,
    rules: {
      maxRedBodyPts: SMALL_RED_MAX_BODY_PTS,
      pre10SelloffMinPts: PRE10_SELLOFF_FROM_OPEN_PTS,
      pre10WindowEndIst: "10:00:00",
      entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
      tpOffsetFromEntry: NINE_FIFTEEN_HIGH_MINUS5_TP_OFFSET,
      tpEarliestIst: session.lateWinAfterIst,
      scanEndIst: session.scanEndIst,
      winWindowEndIst: session.winWindowEndIst,
      lateWinAfterIst: session.lateWinAfterIst,
      signalMinuteLabel: session.signalMinuteLabel,
      instrumentLabel: session.instrumentLabel,
    },
    redSmallBodyDays,
    matchingDays: trades.length,
    stats: summarise(trades),
    trades,
  };
}

export type OpenOffsetSliceMode = "full" | "red_green_only";

export function buildOpenOffsetFromMinuteMap(
  byDate: MinuteMap,
  days: number,
  session: OpenOffsetSessionConfig,
  sliceMode: OpenOffsetSliceMode = "full",
): NineFifteenHighMinus5BacktestResult {
  const sortedDates = [...byDate.keys()].sort().slice(-days);
  const allTrades: NineFifteenHighMinus5Trade[] = [];
  const redTrades: NineFifteenHighMinus5Trade[] = [];
  const greenTrades: NineFifteenHighMinus5Trade[] = [];
  const openAtOpenTrades: NineFifteenHighMinus5Trade[] = [];
  const smallGreenPre10Trades: NineFifteenSmallGreenPre10RallyTrade[] = [];
  const smallRedPre10Trades: NineFifteenSmallRedPre10SelloffTrade[] = [];
  let greenSmallBodyDays = 0;
  let redSmallBodyDays = 0;
  const warnings: string[] = [];

  for (const date of sortedDates) {
    const candles = byDate.get(date);
    if (!candles) continue;
    candles.sort((a, b) => a.mins - b.mins);
    const signalBar = candles.find((c) => c.mins === session.sessionOpenMinutes);
    if (!signalBar) continue;
    const sessionCandles = candles.filter(
      (c) => c.mins >= session.sessionOpenMinutes && c.mins <= session.sessionCloseMinutes,
    );
    if (!isValidSessionDay(sessionCandles, session)) continue;
    const trade = simulateHighMinus5Day(date, signalBar, sessionCandles, session);
    allTrades.push(trade);
    if (isRedSignalBar(signalBar)) {
      redTrades.push(trade);
      if (isSmallRed915Body(signalBar)) {
        redSmallBodyDays += 1;
        const { maxSelloffPts, maxSelloffMins } = maxSelloffBefore10FromOpen(
          signalBar.open,
          sessionCandles,
          session,
        );
        if (maxSelloffPts + 1e-9 >= PRE10_SELLOFF_FROM_OPEN_PTS) {
          const base = simulateHighMinus5Day(
            date,
            signalBar,
            sessionCandles.map((c) => ({ mins: c.mins, low: c.low })),
            session,
            { tpEarliestMins: tpEarliestMinsAfterSignalMinute(session) },
          );
          smallRedPre10Trades.push({
            ...base,
            pre10MaxSelloffPts: maxSelloffPts,
            pre10MaxSelloffTimeIst: maxSelloffMins != null ? formatIstHms(maxSelloffMins * 60) : null,
          });
        }
      }
    }
    if (isGreenSignalBar(signalBar)) {
      greenTrades.push(
        simulateHighPlus5Day(
          date,
          signalBar,
          sessionCandles.map((c) => ({ mins: c.mins, high: c.high })),
          session,
        ),
      );
      if (isSmallGreen915Body(signalBar)) {
        greenSmallBodyDays += 1;
        const { maxRallyPts, maxRallyMins } = maxRallyBefore10FromOpen(
          signalBar.open,
          sessionCandles,
          session,
        );
        if (maxRallyPts + 1e-9 >= PRE10_RALLY_FROM_OPEN_PTS) {
          const base = simulateHighPlus5Day(
            date,
            signalBar,
            sessionCandles.map((c) => ({ mins: c.mins, high: c.high })),
            session,
            { tpEarliestMins: tpEarliestMinsAfterSignalMinute(session) },
          );
          smallGreenPre10Trades.push({
            ...base,
            pre10MaxRallyPts: maxRallyPts,
            pre10MaxRallyTimeIst: maxRallyMins != null ? formatIstHms(maxRallyMins * 60) : null,
          });
        }
      }
    }
    openAtOpenTrades.push(simulateOpenAtOpenMinus10Day(date, signalBar, sessionCandles, session));
  }

  allTrades.sort((a, b) => b.date.localeCompare(a.date));
  redTrades.sort((a, b) => b.date.localeCompare(a.date));
  greenTrades.sort((a, b) => b.date.localeCompare(a.date));
  openAtOpenTrades.sort((a, b) => b.date.localeCompare(a.date));
  smallGreenPre10Trades.sort((a, b) => b.date.localeCompare(a.date));
  smallRedPre10Trades.sort((a, b) => b.date.localeCompare(a.date));

  const signalLabel = session.signalMinuteLabel;
  const redLabel = `Open − 5 entry · red ${signalLabel} only`;
  const greenLabel = `Open + 5 entry · green ${signalLabel} only`;

  const fullDay =
    sliceMode === "full"
      ? (() => {
          const fd = buildFullDayFromSessions(byDate, sortedDates);
          fd.from = allTrades[allTrades.length - 1]?.date ?? "";
          fd.to = allTrades[0]?.date ?? "";
          fd.daysRequested = days;
          fd.warnings = warnings;
          return fd;
        })()
      : {
          from: redTrades[redTrades.length - 1]?.date ?? "",
          to: redTrades[0]?.date ?? "",
          daysRequested: days,
          builtAt: new Date().toISOString(),
          redOpenMinus5: {
            label: "",
            rules: {
              ...baseRules(session, true),
              signalScanStartIst: session.scanEndIst,
              signalScanEndIst: session.scanEndIst,
            },
            stats: summarise([]),
            tradingDays: 0,
            trades: [],
          },
          greenOpenPlus5: {
            label: "",
            rules: {
              ...greenRules(session),
              signalScanStartIst: session.scanEndIst,
              signalScanEndIst: session.scanEndIst,
            },
            stats: summarise([]),
            tradingDays: 0,
            trades: [],
          },
          warnings: [],
        };

  const emptySlice = (label: string): NineFifteenHighMinus5BacktestSlice => ({
    label,
    rules: baseRules(session, false),
    stats: summarise([]),
    trades: [],
  });

  return {
    from: allTrades[allTrades.length - 1]?.date ?? redTrades[redTrades.length - 1]?.date ?? "",
    to: allTrades[0]?.date ?? redTrades[0]?.date ?? "",
    daysRequested: days,
    builtAt: new Date().toISOString(),
    all:
      sliceMode === "full"
        ? buildSlice(`Open − 5 entry · TP entry − 10`, allTrades, session, false)
        : emptySlice(`Open − 5 entry · TP entry − 10`),
    red915Only: buildSlice(redLabel, redTrades, session, true, allTrades.length - redTrades.length),
    green915Only: buildGreenSlice(
      greenLabel,
      greenTrades,
      session,
      allTrades.length - greenTrades.length,
    ),
    smallGreenPre10Rally: buildSmallGreenPre10Slice(smallGreenPre10Trades, greenSmallBodyDays, session),
    smallRedPre10Selloff: buildSmallRedPre10Slice(smallRedPre10Trades, redSmallBodyDays, session),
    openAtOpen:
      sliceMode === "full"
        ? buildOpenAtOpenSlice(`Enter at ${signalLabel} open · TP open − 10`, openAtOpenTrades, session)
        : emptySlice(`Enter at ${signalLabel} open · TP open − 10`),
    fullDay,
    warnings,
  };
}

export interface OpenOffsetBacktestStore {
  cacheFile: string;
  metaFile: string;
  cacheVersion: number;
  defaultDays: number;
  /** Max trading sessions the store can build (e.g. 3 × 252). */
  maxDays: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

export async function fetchAndBuildOpenOffsetBacktest(
  accessToken: string,
  days: number,
  session: OpenOffsetSessionConfig,
  resolveSpotKey: (accessToken: string, asOfDate: string) => Promise<string>,
  sliceMode: OpenOffsetSliceMode = "full",
): Promise<NineFifteenHighMinus5BacktestResult> {
  const calendarLookback = Math.ceil(days * 7 / 5) + 14;
  const tradingDates = listWeekdayDates(calendarLookback);
  const chunks = chunkTradingDates(tradingDates, CHUNK_TRADING_DAYS);
  const byDate: MinuteMap = new Map();
  let rawCount = 0;

  for (const chunk of chunks) {
    const spotKey = await resolveSpotKey(accessToken, chunk[0]);
    const from = `${chunk[0]} ${session.fetchFromTime}`;
    const to = `${chunk[chunk.length - 1]} ${session.fetchToTime}`;
    const { candles } = await fetchHistoricalCandles(accessToken, spotKey, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error("Invalid candle response from Kite");
    rawCount += candles.length;
    ingestRawCandles(candles, byDate, session);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  if (rawCount === 0) throw new Error("No historical candles returned from Kite");

  const result = buildOpenOffsetFromMinuteMap(byDate, days, session, sliceMode);
  if (result.red915Only.trades.length === 0 && result.green915Only.trades.length === 0) {
    throw new Error(`No complete ${session.instrumentLabel} session days in Kite data`);
  }
  return result;
}

function readMeta(metaFile: string, cacheVersion: number): OpenOffsetCacheMeta | null {
  try {
    if (!fs.existsSync(metaFile)) return null;
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as OpenOffsetCacheMeta;
    if (meta.version !== cacheVersion) return null;
    if (!Number.isFinite(meta.sessionsBuilt) || meta.sessionsBuilt <= 0) return null;
    return meta;
  } catch {
    return null;
  }
}

interface OpenOffsetCacheMeta {
  at: number;
  version: number;
  sessionsBuilt: number;
}

function writeCache(result: NineFifteenHighMinus5BacktestResult, store: OpenOffsetBacktestStore): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${store.cacheFile}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, store.cacheFile);
  const at = Date.now();
  fs.writeFileSync(
    store.metaFile,
    JSON.stringify({ at, version: store.cacheVersion, sessionsBuilt: result.daysRequested }),
  );
  return at;
}

function readCache(cacheFile: string): NineFifteenHighMinus5BacktestResult | null {
  try {
    if (!fs.existsSync(cacheFile)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(cacheFile));
    const parsed = JSON.parse(raw.toString("utf8")) as { data?: NineFifteenHighMinus5BacktestResult };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

const inflightByKey = new Map<
  string,
  { promise: Promise<NineFifteenHighMinus5BacktestResult>; sessions: number }
>();

export async function ensureOpenOffsetBacktest(
  accessToken: string,
  store: OpenOffsetBacktestStore,
  session: OpenOffsetSessionConfig,
  resolveSpotKey: (accessToken: string, asOfDate: string) => Promise<string>,
  daysRequested = store.defaultDays,
  force = false,
  sliceMode: OpenOffsetSliceMode = "full",
): Promise<{ data: NineFifteenHighMinus5BacktestResult; cached: boolean; builtAt: number }> {
  const maxDays = store.maxDays > 0 ? store.maxDays : store.defaultDays;
  const days = Math.min(Math.max(Math.round(daysRequested), 30), maxDays);
  const meta = force ? null : readMeta(store.metaFile, store.cacheVersion);
  const cacheCovers = (m: OpenOffsetCacheMeta) => m.sessionsBuilt >= days;

  if (meta && cacheCovers(meta) && Date.now() - meta.at < CACHE_MS && !force) {
    const cached = readCache(store.cacheFile);
    if (cached && cached.daysRequested >= days) {
      return { data: cached, cached: true, builtAt: meta.at };
    }
  }

  const inflightKey = store.cacheFile;
  let inflight = inflightByKey.get(inflightKey);
  if (!inflight || inflight.sessions < days) {
    const promise = fetchAndBuildOpenOffsetBacktest(accessToken, days, session, resolveSpotKey, sliceMode)
      .then((result) => {
        writeCache(result, store);
        return result;
      })
      .finally(() => {
        const current = inflightByKey.get(inflightKey);
        if (current?.promise === promise) inflightByKey.delete(inflightKey);
      });
    inflightByKey.set(inflightKey, { promise, sessions: days });
    inflight = inflightByKey.get(inflightKey)!;
  }

  const stale = readCache(store.cacheFile);
  if (stale && stale.daysRequested >= days && meta && cacheCovers(meta) && !force) {
    inflight.promise.catch(() => undefined);
    return { data: stale, cached: true, builtAt: meta.at };
  }

  const data = await inflight.promise;
  if (data.daysRequested < days) {
    throw new Error(
      `Backtest has ${data.daysRequested} sessions but ${days} are needed for this range — hit Run backtest again`,
    );
  }
  return { data, cached: false, builtAt: Date.now() };
}
