import type {
  NineFifteenFullDayBacktestResult,
  NineFifteenFullDayBacktestSlice,
  NineFifteenFullDayTrade,
  NineFifteenHighMinus5Stats,
  NineFifteenHighMinus5Trade,
} from "../src/types/nine-fifteen-high-minus5-backtest.js";
import {
  NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
} from "./nine-fifteen-high-minus5-backtest.js";

export const NINE_FIFTEEN_FULL_DAY_TP_OFFSET = 5;

export const NINE_FIFTEEN_FULL_DAY_SIGNAL_START_MINS = 9 * 60 + 20;
export const NINE_FIFTEEN_FULL_DAY_SCAN_END_MINS = 15 * 60;
export const NINE_FIFTEEN_FULL_DAY_SIGNAL_START_IST = "9:20";
export const NINE_FIFTEEN_FULL_DAY_SCAN_END_IST = "15:00";

type SignalBar = Pick<
  { mins: number; open: number; high: number; low: number; close: number },
  "mins" | "open" | "high" | "low" | "close"
>;

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

function weekdayFromDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(`${dateKey}T06:00:00.000Z`));
}

function isRedBar(bar: Pick<SignalBar, "open" | "close">): boolean {
  return bar.close < bar.open - 1e-9;
}

function isGreenBar(bar: Pick<SignalBar, "open" | "close">): boolean {
  return bar.close > bar.open + 1e-9;
}

function baseTradeFields(
  date: string,
  signal: SignalBar,
): Pick<
  NineFifteenFullDayTrade,
  | "date"
  | "weekday"
  | "signalMins"
  | "signalTimeIst"
  | "signalOpen"
  | "signalHigh"
  | "signalLow"
  | "signalClose"
  | "signalChange"
> {
  return {
    date,
    weekday: weekdayFromDateKey(date),
    signalMins: signal.mins,
    signalTimeIst: formatIstHms(signal.mins * 60),
    signalOpen: round2(signal.open),
    signalHigh: round2(signal.high),
    signalLow: round2(signal.low),
    signalClose: round2(signal.close),
    signalChange: round2(signal.close - signal.open),
  };
}

/** Red mirror — signal bar open − 5 entry, entry − 5 TP, scan through scanEndMins. */
export function simulateFullDayOpenMinus5(
  date: string,
  signal: SignalBar,
  sessionCandles: Pick<{ mins: number; low: number }, "mins" | "low">[],
  scanEndMins = NINE_FIFTEEN_FULL_DAY_SCAN_END_MINS,
): NineFifteenFullDayTrade {
  const entryLevel = round2(signal.open - NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET);
  const tpLevel = round2(entryLevel - NINE_FIFTEEN_FULL_DAY_TP_OFFSET);
  const base = baseTradeFields(date, signal);

  const ordered = [...sessionCandles]
    .filter((c) => c.mins >= signal.mins && c.mins <= scanEndMins)
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
      return {
        ...base,
        entryLevel,
        tpLevel,
        entryTimeIst,
        entryMins,
        tpTimeIst: formatIstHms(tpMins * 60),
        tpMins,
        outcome: tpMins === signal.mins ? "win" : "late_win",
      };
    }
  }

  if (!entered) {
    return {
      ...base,
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
    ...base,
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

/** Green mirror — signal bar open + 5 entry, entry + 5 TP. */
export function simulateFullDayOpenPlus5(
  date: string,
  signal: SignalBar,
  sessionCandles: Pick<{ mins: number; high: number }, "mins" | "high">[],
  scanEndMins = NINE_FIFTEEN_FULL_DAY_SCAN_END_MINS,
): NineFifteenFullDayTrade {
  const entryLevel = round2(signal.open + NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET);
  const tpLevel = round2(entryLevel + NINE_FIFTEEN_FULL_DAY_TP_OFFSET);
  const base = baseTradeFields(date, signal);

  const ordered = [...sessionCandles]
    .filter((c) => c.mins >= signal.mins && c.mins <= scanEndMins)
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
    if (entered && bar.high >= tpLevel - 1e-9) {
      const tpMins = bar.mins;
      return {
        ...base,
        entryLevel,
        tpLevel,
        entryTimeIst,
        entryMins,
        tpTimeIst: formatIstHms(tpMins * 60),
        tpMins,
        outcome: tpMins === signal.mins ? "win" : "late_win",
      };
    }
  }

  if (!entered) {
    return {
      ...base,
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
    ...base,
    entryLevel,
    tpLevel,
    entryTimeIst,
    entryMins,
    tpTimeIst: null,
    tpMins: null,
    outcome: "loss",
  };
}

function summarise(trades: NineFifteenFullDayTrade[]): NineFifteenHighMinus5Stats {
  const sessions = trades.length;
  const noEntry = trades.filter((t) => t.outcome === "no_entry").length;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const lateWins = trades.filter((t) => t.outcome === "late_win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const entered = wins + lateWins + losses;
  const winRatePct = entered > 0 ? round2(((wins + lateWins) / entered) * 100) : 0;
  const inMinuteWinPct = entered > 0 ? round2((wins / entered) * 100) : 0;
  return { sessions, noEntry, wins, lateWins, losses, winRatePct, inMinuteWinPct };
}

function redFullDayRules() {
  return {
    variant: "limit_open_minus_5" as const,
    entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
    tpOffsetFromEntry: NINE_FIFTEEN_FULL_DAY_TP_OFFSET,
    winWindowEndIst: "signal minute",
    scanEndIst: NINE_FIFTEEN_FULL_DAY_SCAN_END_IST,
    red915Only: true,
    entryDirection: "below" as const,
    tpDirection: "below" as const,
    signalScanStartIst: NINE_FIFTEEN_FULL_DAY_SIGNAL_START_IST,
    signalScanEndIst: NINE_FIFTEEN_FULL_DAY_SCAN_END_IST,
  };
}

function greenFullDayRules() {
  return {
    variant: "limit_open_plus_5" as const,
    entryOffsetFromOpen: NINE_FIFTEEN_HIGH_MINUS5_ENTRY_OFFSET,
    tpOffsetFromEntry: NINE_FIFTEEN_FULL_DAY_TP_OFFSET,
    winWindowEndIst: "signal minute",
    scanEndIst: NINE_FIFTEEN_FULL_DAY_SCAN_END_IST,
    green915Only: true,
    entryDirection: "above" as const,
    tpDirection: "above" as const,
    signalScanStartIst: NINE_FIFTEEN_FULL_DAY_SIGNAL_START_IST,
    signalScanEndIst: NINE_FIFTEEN_FULL_DAY_SCAN_END_IST,
  };
}

function buildSlice(
  label: string,
  trades: NineFifteenFullDayTrade[],
  rules: NineFifteenFullDayBacktestSlice["rules"],
): NineFifteenFullDayBacktestSlice {
  const tradingDays = new Set(trades.map((t) => t.date)).size;
  return {
    label,
    rules,
    stats: summarise(trades),
    tradingDays,
    trades,
  };
}

type SessionBar = {
  mins: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Build full-day slices from already-ingested session minute bars. */
export function buildFullDayFromSessions(
  sessions: Map<string, SessionBar[]>,
  sortedDates: string[],
): NineFifteenFullDayBacktestResult {
  const redTrades: NineFifteenFullDayTrade[] = [];
  const greenTrades: NineFifteenFullDayTrade[] = [];

  for (const date of sortedDates) {
    const candles = sessions.get(date);
    if (!candles?.length) continue;
    candles.sort((a, b) => a.mins - b.mins);

    for (const bar of candles) {
      if (bar.mins < NINE_FIFTEEN_FULL_DAY_SIGNAL_START_MINS) continue;
      if (bar.mins > NINE_FIFTEEN_FULL_DAY_SCAN_END_MINS) continue;

      if (isRedBar(bar)) {
        redTrades.push(
          simulateFullDayOpenMinus5(
            date,
            bar,
            candles.map((c) => ({ mins: c.mins, low: c.low })),
          ),
        );
      }
      if (isGreenBar(bar)) {
        greenTrades.push(
          simulateFullDayOpenPlus5(
            date,
            bar,
            candles.map((c) => ({ mins: c.mins, high: c.high })),
          ),
        );
      }
    }
  }

  redTrades.sort((a, b) => b.date.localeCompare(a.date) || b.signalMins - a.signalMins);
  greenTrades.sort((a, b) => b.date.localeCompare(a.date) || b.signalMins - a.signalMins);

  return {
    from: sortedDates[0] ?? "",
    to: sortedDates[sortedDates.length - 1] ?? "",
    daysRequested: sortedDates.length,
    builtAt: new Date().toISOString(),
    redOpenMinus5: buildSlice(
      "Full day · Open − 5 · red candles only",
      redTrades,
      redFullDayRules(),
    ),
    greenOpenPlus5: buildSlice(
      "Full day · Open + 5 · green candles only",
      greenTrades,
      greenFullDayRules(),
    ),
    warnings: [],
  };
}

/** Map a 9:15 session trade onto the full-day trade shape (for shared UI helpers). */
export function map915TradeToFullDayShape(trade: NineFifteenHighMinus5Trade): NineFifteenFullDayTrade {
  return {
    date: trade.date,
    weekday: trade.weekday,
    signalMins: 9 * 60 + 15,
    signalTimeIst: "09:15:00",
    signalOpen: trade.open915,
    signalHigh: trade.high915,
    signalLow: trade.low915,
    signalClose: trade.close915,
    signalChange: trade.change915,
    entryLevel: trade.entryLevel,
    tpLevel: trade.tpLevel,
    entryTimeIst: trade.entryTimeIst,
    entryMins: trade.entryMins,
    tpTimeIst: trade.tpTimeIst,
    tpMins: trade.tpMins,
    outcome: trade.outcome,
  };
}
