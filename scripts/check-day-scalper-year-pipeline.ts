/**
 * End-to-end check of the rebuilt year pipeline: packs synthetic sessions into the cache shape,
 * runs `pickDayScalperYearView`, and asserts the invariants that the old engine violated.
 */
import { pickDayScalperYearView } from "../server/day-scalper-year.js";
import { DAY_SCALPER_RULES, simulateDayScalperTrades } from "../server/day-scalper.js";
import {
  DAY_SCALPER_YEAR_CLOSE_MARKS,
  DAY_SCALPER_YEAR_INITIAL_STOPS,
  DAY_SCALPER_YEAR_MIN_MOVES,
} from "../src/types/day-scalper-year.js";
import type {
  DayScalperYearPackedBar,
  DayScalperYearResult,
  DayScalperYearSession,
} from "../src/types/day-scalper-year.js";

function session(date: string, weekday: string, seed: number): DayScalperYearSession {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const bars: DayScalperYearPackedBar[] = [];
  let price = 24000;
  for (let mins = 9 * 60 + 15; mins <= 15 * 60 + 30; mins += 1) {
    const open = price;
    const close = open + (rand() - 0.5) * 24;
    bars.push([
      mins,
      open,
      Math.max(open, close) + rand() * 8,
      Math.min(open, close) - rand() * 8,
      close,
    ]);
    price = close;
  }
  return { date, weekday, bars };
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const sessions = Array.from({ length: 246 }, (_, i) => {
  const day = String((i % 28) + 1).padStart(2, "0");
  const month = String((Math.floor(i / 28) % 12) + 1).padStart(2, "0");
  return session(`2026-${month}-${day}`, WEEKDAYS[i % 5], i + 7);
});

const result: DayScalperYearResult = {
  fromDate: sessions[0].date,
  toDate: sessions[sessions.length - 1].date,
  sessions: sessions.length,
  builtAt: Date.now(),
  rules: DAY_SCALPER_RULES,
  availableMinMoves: [...DAY_SCALPER_YEAR_MIN_MOVES],
  availableInitialStops: [...DAY_SCALPER_YEAR_INITIAL_STOPS],
  availableCloseMarks: [...DAY_SCALPER_YEAR_CLOSE_MARKS],
  sessionBars: sessions,
};

const cacheBytes = JSON.stringify({ version: "v11", builtAt: 0, data: result }).length;
console.log(`cache payload: ${(cacheBytes / 1e6).toFixed(1)} MB for ${sessions.length} sessions`);

const started = performance.now();
const view = pickDayScalperYearView(result, 10, 10, 2);
const elapsed = performance.now() - started;

console.log(`pickDayScalperYearView: ${elapsed.toFixed(0)} ms`);
console.log(
  `selected slice → ${view.totals.totalTrades} trades · ${view.totals.winPct.toFixed(1)}% win · ` +
    `${view.totals.netPts.toFixed(0)} pts · ${view.days.length} day rows`,
);

const problems: string[] = [];

/* Entry is at the pullback limit (close ∓ minCloseMarkPts), and no trade may book a profit on its own entry bar. */
let sameBarWins = 0;
let wrongFill = 0;
let tradesChecked = 0;
for (const s of sessions) {
  const sliceRules = { ...DAY_SCALPER_RULES, minMovePts: 10, initialStopPts: 10, minCloseMarkPts: 2 };
  const { trades } = simulateDayScalperTrades(
    s.bars.map(([mins, open, high, low, close]) => ({
      time: "",
      timeIst: "",
      mins,
      open,
      high,
      low,
      close,
    })),
    sliceRules,
    s.weekday,
  );
  for (const t of trades) {
    tradesChecked += 1;
    if (t.exitIndex === t.entryIndex && t.pnlPts > 0 && t.outcome !== "eod") sameBarWins += 1;
    if (Math.abs(t.entryPrice - t.triggerPrice) > 0.011) wrongFill += 1;
  }
}
console.log(
  `entry-bar profits: ${sameBarWins} of ${tradesChecked} · fills not at pullback level: ${wrongFill}`,
);
if (sameBarWins > 0) problems.push(`${sameBarWins} trades book a profit on their own entry bar`);
if (wrongFill > 0) problems.push(`${wrongFill} fills are not at the pullback trigger price`);

const selectedStopRow = view.stopComparison.find((row) => row.initialStopPts === 10);
if (!selectedStopRow || selectedStopRow.netPts !== view.totals.netPts) {
  problems.push("stop comparison row for the selected stop disagrees with the headline totals");
}

const selectedMoveRow = view.minMoveComparison.find((row) => row.minMovePts === 10);
if (!selectedMoveRow || selectedMoveRow.netPts !== view.totals.netPts) {
  problems.push("min-move comparison row for the selected body disagrees with the headline totals");
}

/* Random-walk sessions are not expected to net near zero — we guard fill integrity and no entry-bar target wins. */
const perTrade = view.totals.totalTrades > 0 ? view.totals.netPts / view.totals.totalTrades : 0;
console.log(
  `pullback-fill note: ${perTrade.toFixed(3)} pts/trade on random data (not a sanity target)`,
);

const spread = Math.max(...view.stopComparison.map((r) => r.netPts)) -
  Math.min(...view.stopComparison.map((r) => r.netPts));
console.log(`stop-size net-point spread across 5–20 pt stops: ${spread.toFixed(0)} pts`);
if (view.totals.totalTrades > 0 && spread < 1) {
  problems.push("stop size has no effect on net points — stops are still unreachable");
}

console.log(problems.length === 0 ? "\nAll invariants hold." : `\nFAILED:\n- ${problems.join("\n- ")}`);
process.exit(problems.length === 0 ? 0 : 1);
