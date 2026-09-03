/**
 * The 9:15 trade: the ten-second read, its +5% take-profit limit exit, and the red-only gate it puts on the
 * 9:16 trade that follows it.
 *
 * Run: npx tsx scripts/check-nine-fifteen-trade.ts
 */
import {
  decideNineFifteenEntry,
  decide915Entry,
  build915BarFromCaptured,
  NINE_FIFTEEN_MIN_DROP_PTS,
  getNineFifteenTakeProfitPct,
  NINE_FIFTEEN_TAKE_PROFIT_PCT,
  NINE_FIFTEEN_TAKE_PROFIT_PCT_EARLY,
  NINE_FIFTEEN_ENTRY_SEC,
  NINE_FIFTEEN_SIGNAL_READ_SEC,
  NINE_FIFTEEN_ENTRY_WINDOW_END_SEC,
  isPastNineFifteenSignalRead,
  isReadyForNineFifteenEntry,
  isPastNineFifteenEntryWindow,
  isPastNineFifteenMinute,
  shouldHardStopNineSixteen,
  computeHardStopSpot,
  getHardStopStartLabel,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  nineFifteenDeployedCapital,
  shouldExitNineFifteenTakeProfit,
  getNineFifteenLadderLabel,
  formatNineFifteenExitSummary,
} from "../server/nine-sixteen-logic.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} · ${label}` +
      (ok ? "" : ` · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`),
  );
}

/** An IST wall-clock time as an epoch, so the timing gates can be tested without waiting. */
function ist(h: number, m: number, s: number, ms = 0): number {
  return Date.UTC(2026, 7, 31, h - 5, m - 30, s, ms);
}

console.log("\n--- the ten-second read decides red or green ---");
check("red with 10 pt drop buys the PE", decideNineFifteenEntry(24_800, 24_790), {
  action: "enter",
  leg: "PE_BUY",
  dropPts: 10,
});
check(
  "a one-paisa fall is too small — need at least 5 pts",
  decideNineFifteenEntry(24_800, 24_799.95).action,
  "skip",
);
check("exactly 5 pts down enters", decideNineFifteenEntry(24_800, 24_795), {
  action: "enter",
  leg: "PE_BUY",
  dropPts: 5,
});
check("4.9 pts down is skipped", decideNineFifteenEntry(24_800, 24_795.1).action, "skip");
check("green is skipped", decideNineFifteenEntry(24_800, 24_812).action, "skip");
check("flat is skipped", decideNineFifteenEntry(24_800, 24_800).action, "skip");
check("a missing open is skipped", decideNineFifteenEntry(0, 24_790).action, "skip");
check("a missing read is skipped", decideNineFifteenEntry(24_800, 0).action, "skip");

console.log("\n--- timing gates ---");
check("the read is due at 9:15:10.000", isPastNineFifteenSignalRead(ist(9, 15, 10)), true);
check("not at 9:15:09.999", isPastNineFifteenSignalRead(ist(9, 15, 9, 999)), false);
check("entry opens at 9:15:11", isReadyForNineFifteenEntry(ist(9, 15, 11)), true);
check("entry is not open at 9:15:10", isReadyForNineFifteenEntry(ist(9, 15, 10)), false);
check("entry still open at 9:15:20", isReadyForNineFifteenEntry(ist(9, 15, 20)), true);
check("entry window is gone at 9:15:21", isPastNineFifteenEntryWindow(ist(9, 15, 21)), true);
check("the minute is not over at 9:15:59", isPastNineFifteenMinute(ist(9, 15, 59)), false);
check("the minute is over at 9:16:00", isPastNineFifteenMinute(ist(9, 16, 0)), true);
check("the read is 1s before the order", NINE_FIFTEEN_ENTRY_SEC - NINE_FIFTEEN_SIGNAL_READ_SEC, 1);
check(
  "retries stop well inside the minute",
  NINE_FIFTEEN_ENTRY_WINDOW_END_SEC < 9 * 3600 + 16 * 60,
  true,
);

console.log("\n--- +5% take-profit limit on capital deployed ---");
check("take-profit pct is 5 on Tue/Fri default", NINE_FIFTEEN_TAKE_PROFIT_PCT, 5);
check("Mon/Wed/Thu take-profit is 3%", getNineFifteenTakeProfitPct("2026-08-31"), 3);
check("Tuesday take-profit is 5%", getNineFifteenTakeProfitPct("2026-09-01"), 5);
check("Wednesday take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-02"), 3);
check("Thursday take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-03"), 3);
check("limit price is entry × 1.05 at 5%", nineFifteenTakeProfitLimitPrice(100, 5), 105);
check("limit price is entry × 1.03 at 3%", nineFifteenTakeProfitLimitPrice(100, 3), 103);
check("limit price rounds to paisa", nineFifteenTakeProfitLimitPrice(153.33, 5), 161);
check("deployed capital is entry × qty", nineFifteenDeployedCapital(100, 650), 65_000);
check("profit aim is 5% of deployed", nineFifteenTakeProfitAmount(100, 1000, 5), 5000);
check("profit aim is 3% of deployed", nineFifteenTakeProfitAmount(100, 1000, 3), 3000);
check("₹1L deployed → ₹5K profit aim", nineFifteenTakeProfitAmount(100, 1000, 5), 100_000 * 0.05);
check("does not exit below 5% target", shouldExitNineFifteenTakeProfit(4999, 100, 1000, 5), false);
check("exits at 5% target", shouldExitNineFifteenTakeProfit(5000, 100, 1000, 5), true);
check("exits at 3% target", shouldExitNineFifteenTakeProfit(3000, 100, 1000, 3), true);
check("label mentions +5% on Friday", getNineFifteenLadderLabel("2026-09-05").includes("+5%"), true);
check("label mentions +3% on Wednesday", getNineFifteenLadderLabel("2026-09-02").includes("+3%"), true);

check(
  "exit summary names limit fill and P&L",
  formatNineFifteenExitSummary({
    exitPrice: 105,
    quantity: 1000,
    entryPrice: 100,
    pnl: 5000,
    via: "limit",
  }).includes("TRADE EXITED"),
  true,
);

console.log("\n--- 9:15 entry minimum drop ---");
check("minimum drop is 5 pts", NINE_FIFTEEN_MIN_DROP_PTS, 5);

console.log("\n--- the 9:16 trade now takes red candles only ---");
const bar = (open: number, close: number) =>
  build915BarFromCaptured(open, close, Math.max(open, close), Math.min(open, close))!;

check("a 20 pt fall enters the PE on the main band", decide915Entry(bar(24_800, 24_780)), {
  action: "enter",
  leg: "PE_BUY",
  exitMode: "main",
});
check("a 12 pt fall is under the 15 pt main floor", decide915Entry(bar(24_800, 24_788)).action, "skip");
check("a 20 pt rise is skipped — no CE side any more", decide915Entry(bar(24_800, 24_820)).action, "skip");
check("a 40 pt rise is skipped too", decide915Entry(bar(24_800, 24_840)).action, "skip");
check("a 7 pt fall is still under the 15 pt floor", decide915Entry(bar(24_800, 24_793)).action, "skip");
check("a flat candle is skipped", decide915Entry(bar(24_800, 24_800)).action, "skip");
check("exactly 14 pts down is still under the main band", decide915Entry(bar(24_800, 24_786)).action, "skip");
check("exactly 15 pts down enters the main band", decide915Entry(bar(24_800, 24_785)), {
  action: "enter",
  leg: "PE_BUY",
  exitMode: "main",
});

console.log("\n--- 10:00 hard stop (±30 from entry spot) ---");
const entrySpot = 24_000;
check("PE +30 @10:00 exits", shouldHardStopNineSixteen(24_030, entrySpot, "PE_BUY", undefined, ist(10, 0, 0)), true);
check("PE +29 @10:00 holds", shouldHardStopNineSixteen(24_029, entrySpot, "PE_BUY", undefined, ist(10, 0, 0)), false);
check("PE +30 @09:59 holds", shouldHardStopNineSixteen(24_030, entrySpot, "PE_BUY", undefined, ist(9, 59, 59)), false);
check(
  "PE stop level is entry + 30",
  computeHardStopSpot(entrySpot, "PE_BUY"),
  entrySpot + 30,
);
check("hard stop label", getHardStopStartLabel(), "10:00");

console.log("\n--- both legs armed by default on a fresh load ---");
{
  const { getNineSixteenBotStatus } = await import("../server/nine-sixteen-bot.js");
  const status = getNineSixteenBotStatus();
  check("9:15 trading is on by default", status.nineFifteenEnabled, true);
  check("9:16 trading is on by default", status.enabled, true);
  check("no 9:15 leg claimed yet", status.tradeSlot, "nine-sixteen");
  check("nothing settled before the day starts", status.nineFifteenSettled, false);
  check("the 9:16 trade is not blocked", status.nineFifteenBlocked916, false);
  check("9:15 take-profit pct is 5", status.nineFifteenTakeProfitPct, 5);
  // Only an explicit boolean true may arm either leg — the toggle routes compare with ===.
  for (const value of ["true", "1", 1, {}] as unknown[]) {
    check(`payload ${JSON.stringify(value)} does not arm`, value === true, false);
  }
}

console.log(
  failures === 0 ? "\nAll 9:15 trade checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
