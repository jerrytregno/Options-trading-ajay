/**
 * Live Traps RSI filter — entries only when RSI(14) is 40–60.
 *
 * Run: npx tsx scripts/check-momentum-live-rsi.ts
 */
import {
  formatMomentumLiveRsiBucketsLabel,
  momentumLiveRsiAllowsEntry,
  momentumLiveRsiBlocksEntry,
  momentumLiveRsiFromBarCloses,
  MOMENTUM_SCALPER_RSI_PERIOD,
} from "../server/momentum-scalper-logic.js";
import { mergeNiftyMinuteBarsForRsi } from "../server/nifty-rsi-from-kite.js";
import type { DayScalperCandle } from "../src/types/day-scalper.js";

function bar(mins: number, close: number): DayScalperCandle {
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return { time: "", timeIst: `${hh}:${mm}`, mins, open: close, high: close, low: close, close };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const closes = Array.from({ length: 20 }, (_, i) => 24_000 + i * 2);

console.log(`allowed band: ${formatMomentumLiveRsiBucketsLabel()}\n`);

check("RSI needs 15 closes", momentumLiveRsiFromBarCloses(closes.slice(0, 14)), null);
const rsi = momentumLiveRsiFromBarCloses(closes);
check("RSI computes from 20 closes", rsi != null && rsi > 0, true);

check("40 allowed", momentumLiveRsiAllowsEntry(40), true);
check("50 allowed", momentumLiveRsiAllowsEntry(50), true);
check("60 allowed", momentumLiveRsiAllowsEntry(60), true);
check("45 allowed", momentumLiveRsiAllowsEntry(45), true);

check("39 blocked", momentumLiveRsiAllowsEntry(39), false);
check("61 blocked", momentumLiveRsiAllowsEntry(61), false);
check("25 blocked", momentumLiveRsiAllowsEntry(25), false);
check("70 blocked", momentumLiveRsiAllowsEntry(70), false);

check("null blocked", momentumLiveRsiBlocksEntry(null).blocked, true);
check(
  "null reason mentions Zerodha",
  momentumLiveRsiBlocksEntry(null).reason?.includes("Zerodha"),
  true,
);
check("45 passes block check", momentumLiveRsiBlocksEntry(45).blocked, false);
check("30 blocked with reason", momentumLiveRsiBlocksEntry(30).blocked, true);

const prefill = Array.from({ length: 20 }, (_, i) => bar(9 * 60 + 15 + i, 24_000 + i));
const live = [bar(9 * 60 + 35, 24_050)];
const merged = mergeNiftyMinuteBarsForRsi(prefill, live, bar(9 * 60 + 36, 24_052));
check("merge prefers live over prefill", merged.find((b) => b.mins === live[0].mins)?.close, 24_050);
const mergedRsi = momentumLiveRsiFromBarCloses(merged.map((b) => b.close), MOMENTUM_SCALPER_RSI_PERIOD);
check("merged history yields RSI", mergedRsi != null && mergedRsi > 0, true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
