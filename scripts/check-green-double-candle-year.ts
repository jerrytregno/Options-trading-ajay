/**
 * Green-only momentum scalper probe:
 * · Candle 1: green body > 5 pts
 * · Candle 2: also green (close > open)
 * · CE entry at candle 2 low
 * · TP +5 pts · SL −12 pts from entry
 *
 * Compares this against the current pullback backtest on the same year of bars.
 *
 * Run: npx tsx scripts/check-green-double-candle-year.ts
 */
import fs from "fs";
import path from "path";
import { simulateDayScalperTrades, DAY_SCALPER_RULES } from "../server/day-scalper.js";
import { buildDayScalperYear } from "../server/day-scalper-year.js";
import { loadKiteSession } from "../server/kite-session-store.js";
import type { DayScalperCandle } from "../src/types/day-scalper.js";
import type { DayScalperYearSession } from "../src/types/day-scalper-year.js";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";

const MIN_BODY_PTS = 5;
const TARGET_PTS = 5;
const STOP_PTS = 12;
const WINDOW_OPEN = 9 * 60 + 30;
const WINDOW_CLOSE = 15 * 60;
const TUESDAY_CLOSE = 13 * 60;

const round2 = (v: number) => Math.round(v * 100) / 100;
const pct = (n: number, d: number) => (d > 0 ? round2((n / d) * 100) : 0);

function unpackSession(session: DayScalperYearSession): DayScalperCandle[] {
  return session.bars.map(([mins, open, high, low, close]) => ({
    time: "",
    timeIst: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`,
    mins,
    open,
    high,
    low,
    close,
  }));
}

function sessionCloseMins(weekday: string): number {
  return weekday === "Tuesday" ? TUESDAY_CLOSE : WINDOW_CLOSE;
}

interface SimpleTrade {
  date: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  exitPrice: number;
  outcome: "target" | "stop" | "eod";
  pnlPts: number;
}

function simulateGreenDoubleLow(
  candles: DayScalperCandle[],
  date: string,
  weekday: string,
  mode: "lookahead-green-c2" | "no-c2-filter" | "c2-open-above-c1-close",
  targetFromNextBar = false,
): SimpleTrade[] {
  const trades: SimpleTrade[] = [];
  const closeMins = sessionCloseMins(weekday);
  let i = 0;

  while (i < candles.length - 1) {
    const c1 = candles[i];
    if (c1.mins < WINDOW_OPEN) {
      i += 1;
      continue;
    }
    if (c1.mins > closeMins) break;

    const body1 = round2(c1.close - c1.open);
    if (body1 <= MIN_BODY_PTS) {
      i += 1;
      continue;
    }

    const c2 = candles[i + 1];
    if (!c2 || c2.mins > closeMins) {
      i += 1;
      continue;
    }

    const body2 = round2(c2.close - c2.open);
    if (mode === "lookahead-green-c2" && body2 <= 0) {
      i += 1;
      continue;
    }
    if (mode === "c2-open-above-c1-close" && !(c2.open + 1e-9 >= round2(c1.close))) {
      i += 1;
      continue;
    }

    const entryPrice = round2(c2.low);
    const stopPrice = round2(entryPrice - STOP_PTS);
    const targetPrice = round2(entryPrice + TARGET_PTS);
    const entryIndex = i + 1;

    let outcome: SimpleTrade["outcome"] = "eod";
    let exitPrice = c2.close;
    let exitIndex = entryIndex;

    for (let j = entryIndex; j < candles.length; j += 1) {
      const bar = candles[j];
      if (bar.mins > closeMins) break;
      exitIndex = j;
      exitPrice = bar.close;

      const stopHit = bar.low <= stopPrice;
      if (stopHit) {
        outcome = "stop";
        exitPrice = stopPrice;
        break;
      }

      if (targetFromNextBar && j === entryIndex) continue;

      const targetHit = bar.high >= targetPrice;
      if (targetHit) {
        outcome = "target";
        exitPrice = targetPrice;
        break;
      }
    }

    trades.push({
      date,
      signalTime: c1.timeIst,
      entryTime: c2.timeIst,
      entryPrice,
      exitPrice: round2(exitPrice),
      outcome,
      pnlPts: round2(exitPrice - entryPrice),
    });

    i = exitIndex + 1;
  }

  return trades;
}

function summarise(label: string, trades: SimpleTrade[]) {
  const wins = trades.filter((t) => t.pnlPts > 0).length;
  const losses = trades.filter((t) => t.pnlPts < 0).length;
  const net = round2(trades.reduce((s, t) => s + t.pnlPts, 0));
  const targets = trades.filter((t) => t.outcome === "target").length;
  const stops = trades.filter((t) => t.outcome === "stop").length;
  const eod = trades.filter((t) => t.outcome === "eod").length;

  console.log(`\n=== ${label} ===`);
  console.log(`trades: ${trades.length}`);
  console.log(`wins: ${wins} · losses: ${losses} · win%: ${pct(wins, trades.length)}%`);
  console.log(`net pts: ${net > 0 ? "+" : ""}${net}`);
  console.log(
    `avg pts/trade: ${trades.length ? round2(net / trades.length) : 0} · ` +
      `exit mix: target ${targets} · stop ${stops} · eod ${eod}`,
  );
}

function cacheFile(): string {
  return path.join(process.cwd(), "data", "day-scalper-year-cache.json");
}

async function loadSessions(): Promise<DayScalperYearSession[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as {
      data?: { sessionBars?: DayScalperYearSession[] };
    };
    if (raw.data?.sessionBars?.length) return raw.data.sessionBars;
  } catch {
    /* fetch below */
  }

  const session = loadKiteSession();
  if (!session?.accessToken) {
    throw new Error("No year cache and no kite session — connect Zerodha or rebuild year in the app first.");
  }

  console.log("Fetching 365-day minute bars from Kite (first run ~1 min)…");
  const year = await buildDayScalperYear(session.accessToken, "NSE:NIFTY 50");
  return year.sessionBars ?? [];
}

async function main() {
  const sessions = await loadSessions();
  console.log(`sessions: ${sessions.length}`);

  const modes = [
    "lookahead-green-c2",
    "c2-open-above-c1-close",
    "no-c2-filter",
  ] as const;

  for (const mode of modes) {
    const trades: SimpleTrade[] = [];
    for (const session of sessions) {
      const weekday = session.weekday || formatWeekdayFromDateKey(session.date);
      trades.push(
        ...simulateGreenDoubleLow(unpackSession(session), session.date, weekday, mode, true),
      );
    }
    const label =
      mode === "lookahead-green-c2"
        ? "c2 closes green (lookahead)"
        : mode === "c2-open-above-c1-close"
          ? "c2 open ≥ c1 close"
          : "no c2 filter";
    summarise(`CONSERVATIVE (TP from next bar) · ${label}`, trades);
  }

  for (const mode of modes) {
    const trades: SimpleTrade[] = [];
    for (const session of sessions) {
      const weekday = session.weekday || formatWeekdayFromDateKey(session.date);
      trades.push(...simulateGreenDoubleLow(unpackSession(session), session.date, weekday, mode));
    }
    const label =
      mode === "lookahead-green-c2"
        ? "LOOKAHEAD: candle 2 must CLOSE green (biased)"
        : mode === "c2-open-above-c1-close"
          ? "HONEST: candle 2 opens ≥ candle 1 close"
          : "HONEST: no candle-2 colour filter";
    summarise(`${label} · entry @ c2 low · TP +5 · SL −12`, trades);
  }

  const greenTrades: SimpleTrade[] = [];
  for (const session of sessions) {
    const weekday = session.weekday || formatWeekdayFromDateKey(session.date);
    greenTrades.push(
      ...simulateGreenDoubleLow(unpackSession(session), session.date, weekday, "lookahead-green-c2"),
    );
  }

  let currentTrades = 0;
  let currentWins = 0;
  let currentNet = 0;
  let skippedPullback = 0;
  let skippedOpenGate = 0;

  const rules = {
    ...DAY_SCALPER_RULES,
    minMovePts: MIN_BODY_PTS,
    initialStopPts: STOP_PTS,
    minCloseMarkPts: 2,
  };

  for (const session of sessions) {
    const weekday = session.weekday || formatWeekdayFromDateKey(session.date);
    const candles = unpackSession(session);
    const { trades, summary } = simulateDayScalperTrades(candles, rules, weekday);
    currentTrades += trades.length;
    currentWins += trades.filter((t) => t.pnlPts > 0).length;
    currentNet += trades.reduce((s, t) => s + t.pnlPts, 0);
    for (const skip of summary.skipped) {
      if (skip.side === "CE" && skip.reason === "no-pullback") skippedPullback += 1;
      if (skip.side === "CE" && skip.reason === "momentum-open") skippedOpenGate += 1;
    }
  }
  console.log(
    `\n=== CURRENT BACKTEST (open gate + pullback + TP @ signal close+3) ===\n` +
      `trades: ${currentTrades} · wins: ${currentWins} · win%: ${pct(currentWins, currentTrades)}% · ` +
      `net: ${round2(currentNet)} pts\n` +
      `CE signals skipped — open gate: ${skippedOpenGate} · no pullback: ${skippedPullback}`,
  );

  const sample = greenTrades.slice(0, 5);
  if (sample.length) {
    console.log("\nSample green-double trades:");
    for (const t of sample) {
      console.log(
        `  ${t.date} ${t.signalTime}→${t.entryTime} entry ${t.entryPrice} exit ${t.exitPrice} ` +
          `${t.outcome} ${t.pnlPts > 0 ? "+" : ""}${t.pnlPts}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
