import type {
  DayScalperCandle,
  DayScalperOutcome,
  DayScalperResult,
  DayScalperRules,
  DayScalperSide,
  DayScalperSignalToMarkStats,
  DayScalperSkippedSignal,
  DayScalperSummary,
  DayScalperTrade,
} from "../src/types/day-scalper.js";
import {
  clampCloseMarkPts,
  clampInitialStopPts,
  clampMinMovePts,
  DAY_SCALPER_CLOSE_MARK_DEFAULT,
  DAY_SCALPER_DEFAULT_INITIAL_STOP_PTS,
  DAY_SCALPER_TAKE_PROFIT_FROM_SIGNAL_CLOSE_PTS,
  DAY_SCALPER_MIN_MOVE_PTS,
  DAY_SCALPER_TUESDAY_TRADE_WINDOW_CLOSE,
  DAY_SCALPER_TRADE_WINDOW_CLOSE,
  DAY_SCALPER_TRADE_WINDOW_OPEN,
  DAY_SCALPER_TRIGGER_PTS,
} from "../src/types/day-scalper.js";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";
import { evaluateMomentumEntry } from "./momentum-scalper-logic.js";

const IST = "Asia/Kolkata";
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

export const DAY_SCALPER_RULES: DayScalperRules = {
  minMovePts: DAY_SCALPER_MIN_MOVE_PTS,
  triggerPts: DAY_SCALPER_TRIGGER_PTS,
  initialTargetPts: 5,
  trailStepPts: 2,
  initialStopPts: DAY_SCALPER_DEFAULT_INITIAL_STOP_PTS,
  minCloseMarkPts: DAY_SCALPER_CLOSE_MARK_DEFAULT,
  sessionOpenIst: "09:15",
  sessionCloseIst: "15:30",
  tradeWindowOpenIst: DAY_SCALPER_TRADE_WINDOW_OPEN,
  tradeWindowCloseIst: DAY_SCALPER_TRADE_WINDOW_CLOSE,
  tuesdayTradeWindowCloseIst: DAY_SCALPER_TUESDAY_TRADE_WINDOW_CLOSE,
};

function istHmToMins(hm: string): number {
  const [hour, minute] = hm.split(":").map(Number);
  return hour * 60 + minute;
}

export function tradeWindowCloseMins(weekday: string, rules: DayScalperRules): number {
  if (weekday === "Tuesday") return istHmToMins(rules.tuesdayTradeWindowCloseIst);
  return istHmToMins(rules.tradeWindowCloseIst);
}

function tradeWindowOpenMins(rules: DayScalperRules): number {
  return istHmToMins(rules.tradeWindowOpenIst);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function istHourMinute(date: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hour: pick("hour") % 24, minute: pick("minute") };
}

export function parseDayScalperCandles(raw: unknown): DayScalperCandle[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: DayScalperCandle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close] = row;
    if (typeof time !== "string") continue;
    if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) {
      continue;
    }

    const parsed = new Date(time);
    if (!Number.isFinite(parsed.getTime())) continue;

    const { hour, minute } = istHourMinute(parsed);
    const mins = hour * 60 + minute;
    if (mins < SESSION_OPEN_MINUTES || mins > SESSION_CLOSE_MINUTES) continue;

    out.push({
      time,
      timeIst: `${pad2(hour)}:${pad2(minute)}`,
      mins,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
    });
  }

  out.sort((a, b) => a.mins - b.mins);
  return out;
}

function emptySummary(): DayScalperSummary {
  return {
    qualifyingBars: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winPct: 0,
    netPts: 0,
    grossWinPts: 0,
    grossLossPts: 0,
    avgPts: 0,
    bestPts: null,
    worstPts: null,
    ceTrades: 0,
    peTrades: 0,
    maxDrawdownPts: 0,
    maxLosingStreak: 0,
    signalToMark: emptySignalToMarkStats(),
    skipped: [],
  };
}

export function emptySignalToMarkStats(): DayScalperSignalToMarkStats {
  return {
    maxCeLowPts: null,
    maxPeHighPts: null,
    avgPts: null,
    avgCeLowPts: null,
    avgPeHighPts: null,
    ceSamples: 0,
    peSamples: 0,
  };
}

/** Signal close → momentum mark in index points (CE: close − low · PE: high − close). */
export function signalCloseToMarkPts(
  side: DayScalperSide,
  signalClose: number,
  momentumLow: number,
  momentumHigh: number,
): number {
  return side === "CE"
    ? round2(signalClose - momentumLow)
    : round2(momentumHigh - signalClose);
}

export function buildSignalToMarkStats(trades: DayScalperTrade[]): DayScalperSignalToMarkStats {
  if (trades.length === 0) return emptySignalToMarkStats();

  let maxCeLowPts: number | null = null;
  let maxPeHighPts: number | null = null;
  let sumCe = 0;
  let sumPe = 0;
  let ceSamples = 0;
  let peSamples = 0;

  for (const trade of trades) {
    if (trade.side === "CE") {
      ceSamples += 1;
      sumCe += trade.signalToMarkPts;
      maxCeLowPts =
        maxCeLowPts == null ? trade.signalToMarkPts : Math.max(maxCeLowPts, trade.signalToMarkPts);
    } else {
      peSamples += 1;
      sumPe += trade.signalToMarkPts;
      maxPeHighPts =
        maxPeHighPts == null ? trade.signalToMarkPts : Math.max(maxPeHighPts, trade.signalToMarkPts);
    }
  }

  const total = ceSamples + peSamples;
  return {
    maxCeLowPts,
    maxPeHighPts,
    avgPts: total > 0 ? round2((sumCe + sumPe) / total) : null,
    avgCeLowPts: ceSamples > 0 ? round2(sumCe / ceSamples) : null,
    avgPeHighPts: peSamples > 0 ? round2(sumPe / peSamples) : null,
    ceSamples,
    peSamples,
  };
}

export function mergeSignalToMarkStats(
  acc: DayScalperSignalToMarkStats,
  next: DayScalperSignalToMarkStats,
): DayScalperSignalToMarkStats {
  if (next.ceSamples === 0 && next.peSamples === 0) return acc;

  const ceSamples = acc.ceSamples + next.ceSamples;
  const peSamples = acc.peSamples + next.peSamples;
  const sumCe =
    (acc.avgCeLowPts ?? 0) * acc.ceSamples + (next.avgCeLowPts ?? 0) * next.ceSamples;
  const sumPe =
    (acc.avgPeHighPts ?? 0) * acc.peSamples + (next.avgPeHighPts ?? 0) * next.peSamples;

  return {
    maxCeLowPts:
      acc.maxCeLowPts == null
        ? next.maxCeLowPts
        : next.maxCeLowPts == null
          ? acc.maxCeLowPts
          : Math.max(acc.maxCeLowPts, next.maxCeLowPts),
    maxPeHighPts:
      acc.maxPeHighPts == null
        ? next.maxPeHighPts
        : next.maxPeHighPts == null
          ? acc.maxPeHighPts
          : Math.max(acc.maxPeHighPts, next.maxPeHighPts),
    avgPts:
      ceSamples + peSamples > 0 ? round2((sumCe + sumPe) / (ceSamples + peSamples)) : null,
    avgCeLowPts: ceSamples > 0 ? round2(sumCe / ceSamples) : null,
    avgPeHighPts: peSamples > 0 ? round2(sumPe / peSamples) : null,
    ceSamples,
    peSamples,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface OpenTradeExit {
  outcome: DayScalperOutcome;
  exitIndex: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  peakLockedPts: number;
}

/**
 * Runs the open position from entry through session close with an initial stop and a fixed
 * take-profit at signal close ±`DAY_SCALPER_TAKE_PROFIT_FROM_SIGNAL_CLOSE_PTS`.
 *
 * The entry bar is scored on the stop only — minute OHLC does not say whether high or low came
 * first after the fill. The target is checked from the next bar onward.
 */
function raceFixedTargetTrade(
  candles: DayScalperCandle[],
  entryIndex: number,
  entryPrice: number,
  signalClose: number,
  side: DayScalperSide,
  rules: DayScalperRules,
  sessionCloseMins: number,
): OpenTradeExit {
  const signed = side === "CE" ? 1 : -1;
  const initialStopPrice = round2(entryPrice - signed * rules.initialStopPts);
  const targetPrice = round2(
    signalClose + signed * DAY_SCALPER_TAKE_PROFIT_FROM_SIGNAL_CLOSE_PTS,
  );
  const targetPtsFromEntry = round2(Math.abs(targetPrice - entryPrice));

  let exitIndex = entryIndex;
  let exitPrice = candles[entryIndex].close;

  for (let j = entryIndex; j < candles.length; j += 1) {
    const bar = candles[j];
    if (bar.mins > sessionCloseMins) break;

    exitIndex = j;
    exitPrice = bar.close;

    const stopHit = side === "CE" ? bar.low <= initialStopPrice : bar.high >= initialStopPrice;
    if (stopHit) {
      return {
        outcome: "stop",
        exitIndex: j,
        exitPrice: initialStopPrice,
        stopPrice: initialStopPrice,
        targetPrice,
        peakLockedPts: 0,
      };
    }

    if (j === entryIndex) continue;

    const targetHit = side === "CE" ? bar.high >= targetPrice : bar.low <= targetPrice;
    if (targetHit) {
      return {
        outcome: "target",
        exitIndex: j,
        exitPrice: targetPrice,
        stopPrice: initialStopPrice,
        targetPrice,
        peakLockedPts: targetPtsFromEntry,
      };
    }
  }

  return {
    outcome: "eod",
    exitIndex,
    exitPrice: round2(exitPrice),
    stopPrice: initialStopPrice,
    targetPrice,
    peakLockedPts: 0,
  };
}

/**
 * Walks the session from 9:30 onward. A qualifying green/red body sets up CE/PE; candle 2 must
 * open ≥ close+0.1 (CE) or ≤ close−0.1 (PE), then pull back to close∓2 for a limit fill. Target is
 * signal close ±3 index pts. Tuesday sessions end at 13:00.
 */
export function simulateDayScalperTrades(
  candles: DayScalperCandle[],
  rules: DayScalperRules = DAY_SCALPER_RULES,
  weekday = "Monday",
): { trades: DayScalperTrade[]; summary: DayScalperSummary } {
  const trades: DayScalperTrade[] = [];
  const skipped: DayScalperSkippedSignal[] = [];
  let qualifyingBars = 0;
  let nextId = 1;
  let i = 0;
  const scanOpenMins = tradeWindowOpenMins(rules);
  const sessionCloseMins = tradeWindowCloseMins(weekday, rules);

  while (i < candles.length) {
    const signal = candles[i];

    if (signal.mins < scanOpenMins) {
      i += 1;
      continue;
    }

    if (signal.mins > sessionCloseMins) break;

    const movePts = signal.close - signal.open;
    if (Math.abs(movePts) <= rules.minMovePts) {
      i += 1;
      continue;
    }

    qualifyingBars += 1;

    const momentumBar = candles[i + 1];
    if (!momentumBar || momentumBar.mins > sessionCloseMins) {
      skipped.push({
        index: i,
        timeIst: signal.timeIst,
        side: movePts > 0 ? "CE" : "PE",
        movePts: round2(movePts),
        reason: "no-entry-bar",
      });
      break;
    }

    const entryVerdict = evaluateMomentumEntry(signal, momentumBar, weekday, rules);
    if (entryVerdict.action === "skip") {
      const side: DayScalperSide = movePts > 0 ? "CE" : "PE";
      skipped.push({
        index: i,
        timeIst: signal.timeIst,
        side,
        movePts: round2(movePts),
        reason: entryVerdict.reason,
      });
      i += 1;
      continue;
    }

    const { side, signalMovePts, triggerPrice, entryIndexPrice: entryPrice } = entryVerdict;
    const signed = side === "CE" ? 1 : -1;
    const momentumOpen = momentumBar.open;
    const momentumLow = round2(momentumBar.low);
    const momentumHigh = round2(momentumBar.high);
    const signalToMarkPts = signalCloseToMarkPts(side, signal.close, momentumLow, momentumHigh);

    const entryIndex = i + 1;
    const initialStopPrice = entryPrice - signed * rules.initialStopPts;
    const exited = raceFixedTargetTrade(
      candles,
      entryIndex,
      entryPrice,
      signal.close,
      side,
      rules,
      sessionCloseMins,
    );

    trades.push({
      id: nextId++,
      side,
      signalIndex: i,
      signalTimeIst: signal.timeIst,
      signalOpen: signal.open,
      signalClose: signal.close,
      signalMovePts,
      momentumIndex: i + 1,
      momentumTimeIst: momentumBar.timeIst,
      momentumOpen: round2(momentumOpen),
      momentumLow,
      momentumHigh,
      triggerPrice: round2(triggerPrice),
      signalToMarkPts,
      entryIndex,
      entryTimeIst: momentumBar.timeIst,
      entryPrice: round2(entryPrice),
      initialStopPrice: round2(initialStopPrice),
      stopPrice: round2(exited.stopPrice),
      targetPrice: round2(exited.targetPrice),
      peakLockedPts: exited.peakLockedPts,
      outcome: exited.outcome,
      exitIndex: exited.exitIndex,
      exitTimeIst: candles[exited.exitIndex].timeIst,
      exitPrice: round2(exited.exitPrice),
      pnlPts: round2(signed * (exited.exitPrice - entryPrice)),
      barsHeld: exited.exitIndex - entryIndex + 1,
      liveMinutes: candles[exited.exitIndex].mins - momentumBar.mins,
    });

    for (let k = i + 1; k <= exited.exitIndex; k += 1) {
      const bar = candles[k];
      if (bar.mins < scanOpenMins || bar.mins > sessionCloseMins) continue;
      const barMove = bar.close - bar.open;
      if (Math.abs(barMove) <= rules.minMovePts) continue;
      qualifyingBars += 1;
      skipped.push({
        index: k,
        timeIst: bar.timeIst,
        side: barMove > 0 ? "CE" : "PE",
        movePts: round2(barMove),
        reason: "in-trade",
      });
    }

    i = exited.exitIndex + 1;
  }

  return { trades, summary: summarise(trades, qualifyingBars, skipped) };
}

function summarise(
  trades: DayScalperTrade[],
  qualifyingBars: number,
  skipped: DayScalperSkippedSignal[],
): DayScalperSummary {
  const summary = emptySummary();
  summary.qualifyingBars = qualifyingBars;
  summary.trades = trades.length;
  summary.skipped = skipped;
  if (trades.length === 0) return summary;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let losingStreak = 0;

  for (const trade of trades) {
    if (trade.pnlPts > 0) summary.wins += 1;
    else summary.losses += 1;

    if (trade.side === "CE") summary.ceTrades += 1;
    else summary.peTrades += 1;

    if (trade.pnlPts >= 0) {
      summary.grossWinPts += trade.pnlPts;
      losingStreak = 0;
    } else {
      summary.grossLossPts += Math.abs(trade.pnlPts);
      losingStreak += 1;
      summary.maxLosingStreak = Math.max(summary.maxLosingStreak, losingStreak);
    }

    summary.bestPts = summary.bestPts == null ? trade.pnlPts : Math.max(summary.bestPts, trade.pnlPts);
    summary.worstPts =
      summary.worstPts == null ? trade.pnlPts : Math.min(summary.worstPts, trade.pnlPts);

    cumulative += trade.pnlPts;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  summary.netPts = round2(cumulative);
  summary.grossWinPts = round2(summary.grossWinPts);
  summary.grossLossPts = round2(summary.grossLossPts);
  summary.avgPts = round2(cumulative / trades.length);
  summary.winPct = (summary.wins / trades.length) * 100;
  summary.maxDrawdownPts = round2(maxDrawdown);
  summary.signalToMark = buildSignalToMarkStats(trades);
  return summary;
}

export function resolveMinMovePts(value: unknown): number {
  return clampMinMovePts(value);
}

export function resolveInitialStopPts(value: unknown): number {
  return clampInitialStopPts(value);
}

export function resolveCloseMarkPts(value: unknown): number {
  return clampCloseMarkPts(value);
}

export function buildDayScalperResult({
  date,
  instrument,
  indexLabel,
  raw,
  rules = DAY_SCALPER_RULES,
}: {
  date: string;
  instrument: string;
  indexLabel: string;
  raw: unknown;
  rules?: DayScalperRules;
}): DayScalperResult {
  const weekday = formatWeekdayFromDateKey(date);
  const candles = parseDayScalperCandles(raw);
  const { trades, summary } =
    candles.length > 0
      ? simulateDayScalperTrades(candles, rules, weekday)
      : { trades: [] as DayScalperTrade[], summary: emptySummary() };

  const lastBar = candles[candles.length - 1];
  const sessionCloseMins = tradeWindowCloseMins(weekday, rules);

  return {
    date,
    weekday,
    instrument,
    indexId: "nifty",
    indexLabel,
    sessionComplete: lastBar != null && lastBar.mins >= sessionCloseMins,
    rules,
    candles,
    trades,
    summary,
    closeMarkComparison: [],
  };
}
