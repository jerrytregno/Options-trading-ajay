/**
 * Pins the momentum scalper backtest entry and fixed target:
 * · open gate ±0.5 from signal close
 * · limit fill at close ∓ 2 pts pullback
 * · target at signal close ± 3 (5 pts from entry with a 2-pt pullback)
 *
 * Run: npx tsx scripts/check-trail-ladder.ts
 */
import { simulateDayScalperTrades, DAY_SCALPER_RULES } from "../server/day-scalper.js";
import type { DayScalperCandle } from "../src/types/day-scalper.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const bar = (mins: number, o: number, h: number, l: number, c: number): DayScalperCandle => ({
  mins,
  timeIst: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`,
  open: o,
  high: h,
  low: l,
  close: c,
});

const RULES = { ...DAY_SCALPER_RULES, minMovePts: 5, initialStopPts: 10, minCloseMarkPts: 2 };

function ladder(runBar: DayScalperCandle) {
  const candles: DayScalperCandle[] = [
    bar(569, 1000, 1000, 1000, 1000),
    bar(570, 1000, 1012, 1000, 1012), // signal: body +12
    bar(571, 1013, 1015, 1009, 1014), // open ≥ 1012.5, low ≤ 1010
    runBar,
    bar(573, 1015, 1015, 1015, 1015),
  ];
  return simulateDayScalperTrades(candles, RULES, "Monday");
}

console.log("\n--- CE open gate + pullback entry at close − 2 ---");
const base = ladder(bar(572, 1014, 1014, 1014, 1014));
check("one trade taken", base.trades.length, 1);
check("side", base.trades[0]?.side, "CE");
check("entry at close − 2", base.trades[0]?.entryPrice, 1010);
check("trigger matches entry", base.trades[0]?.triggerPrice, 1010);
check("target at close + 3", base.trades[0]?.targetPrice, 1015);

console.log("\n--- target hit on next bar (+5 pts) ---");
const targetHit = ladder(bar(572, 1014, 1016, 1013, 1015));
check("outcome", targetHit.trades[0]?.outcome, "target");
check("locked pts", targetHit.trades[0]?.peakLockedPts, 5);
check("pnl pts", targetHit.trades[0]?.pnlPts, 5);

console.log("\n--- initial stop −10 ---");
const stopped = ladder(bar(572, 1014, 1012, 999, 1000));
check("outcome", stopped.trades[0]?.outcome, "stop");
check("pnl pts", stopped.trades[0]?.pnlPts, -10);

console.log("\n--- open gate fails → no trade ---");
const noOpen = simulateDayScalperTrades(
  [
    bar(569, 1000, 1000, 1000, 1000),
    bar(570, 1000, 1012, 1000, 1012),
    bar(571, 1012, 1015, 1009, 1014), // open 1012 < 1012.5
    bar(572, 1014, 1016, 1013, 1015),
  ],
  RULES,
  "Monday",
);
check("no trade when open gate fails", noOpen.trades.length, 0);
check("skipped momentum-open", noOpen.summary.skipped[0]?.reason, "momentum-open");

console.log("\n--- PE mirrored ---");
const pe = simulateDayScalperTrades(
  [
    bar(569, 1000, 1000, 1000, 1000),
    bar(570, 1012, 1012, 1000, 1000), // signal: body -12, close 1000
    bar(571, 998, 1002, 997, 999), // open ≤ 999.5, high ≥ 1002
    bar(572, 999, 999, 997, 998), // target 997 on low
  ],
  RULES,
  "Monday",
);
check("PE side", pe.trades[0]?.side, "PE");
check("entry at close + 2", pe.trades[0]?.entryPrice, 1002);
check("target at close − 3", pe.trades[0]?.targetPrice, 997);
check("PE target hit", pe.trades[0]?.outcome, "target");
check("PE pnl", pe.trades[0]?.pnlPts, 5);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
