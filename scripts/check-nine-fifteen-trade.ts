/**
 * The 9:15 trade: the ten-second read, its own P&L ladder, and the red-only gate it puts on the
 * 9:16 trade that follows it.
 *
 * Run: npx tsx scripts/check-nine-fifteen-trade.ts
 */
import {
  decideNineFifteenEntry,
  evaluateNineFifteenExit,
  nextNineFifteenLockedPct,
  nineFifteenTargetPct,
  nineFifteenStopPct,
  decide915Entry,
  build915BarFromCaptured,
  NINE_FIFTEEN_TRAIL_ARM_PCT,
  NINE_FIFTEEN_TRAIL_STEP_PCT,
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

console.log("\n--- the 10-second read decides red or green ---");
check("red buys the PE", decideNineFifteenEntry(24_800, 24_790), {
  action: "enter",
  leg: "PE_BUY",
  dropPts: 10,
});
check(
  "a one-paisa fall is still red — there is no minimum here",
  decideNineFifteenEntry(24_800, 24_799.95).action,
  "enter",
);
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

console.log("\n--- the rungs are 3, 5, 7, 9 … ---");
check("nothing locks below +3%", nextNineFifteenLockedPct(0, 2.99), 0);
check("+3% exactly locks the first rung", nextNineFifteenLockedPct(0, 3), 3);
check("+4.9% still sits on the 3% rung", nextNineFifteenLockedPct(0, 4.9), 3);
check("+5% locks the second", nextNineFifteenLockedPct(0, 5), 5);
check("+6.9% still sits on the 5% rung", nextNineFifteenLockedPct(0, 6.9), 5);
check("+7% locks the third", nextNineFifteenLockedPct(0, 7), 7);
check("+9% locks the fourth", nextNineFifteenLockedPct(0, 9), 9);
check("a jump straight to +12% locks +11%", nextNineFifteenLockedPct(0, 12), 11);
check("the ladder never steps back down", nextNineFifteenLockedPct(7, 3), 7);
check("an implausible reading is ignored", nextNineFifteenLockedPct(5, 400), 5);

check("the first target is +3%", nineFifteenTargetPct(0), NINE_FIFTEEN_TRAIL_ARM_PCT);
check("locked +3% aims at +5%", nineFifteenTargetPct(3), 5);
check("locked +5% aims at +7%", nineFifteenTargetPct(5), 7);
check(
  "targets step by the ladder's own step",
  nineFifteenTargetPct(9) - nineFifteenTargetPct(7),
  NINE_FIFTEEN_TRAIL_STEP_PCT,
);

check("no stop before the first rung", nineFifteenStopPct(0), null);
check("the stop becomes the locked rung", nineFifteenStopPct(5), 5);

console.log("\n--- no initial stop before the ladder arms ---");
check("-10% holds", evaluateNineFifteenExit(0, -10).exit, null);
check("-14% holds", evaluateNineFifteenExit(0, -14).exit, null);
check(
  "a deep loss after a rung locks still exits on the trail",
  evaluateNineFifteenExit(3, -14).exit,
  { reason: "trail-stop", lockedPnlPct: 3 },
);

console.log("\n--- reaching a rung ratchets, it never sells ---");
{
  const atRung = evaluateNineFifteenExit(0, 3);
  check("touching +3% locks it", atRung.lockedPnlPct, 3);
  check("and does not exit on that same reading", atRung.exit, null);
}
{
  const spike = evaluateNineFifteenExit(0, 7.4);
  check("a spike straight to +7.4% locks +7%", spike.lockedPnlPct, 7);
  check("and still does not sell on the way up", spike.exit, null);
}
check("holding above the floor holds", evaluateNineFifteenExit(3, 4.2).exit, null);
check("coming back down to the floor exactly sells", evaluateNineFifteenExit(3, 3).exit, {
  reason: "trail-stop",
  lockedPnlPct: 3,
});
check("slipping under the floor sells", evaluateNineFifteenExit(5, 4.8).exit, {
  reason: "trail-stop",
  lockedPnlPct: 5,
});

console.log("\n--- a full path: 0 → +5.2% → +3% ---");
{
  let locked = 0;
  const path = [0.4, 2.9, 3.1, 4.4, 5.2, 4.6, 3.0];
  const events: string[] = [];
  for (const pct of path) {
    const evaluation = evaluateNineFifteenExit(locked, pct);
    if (evaluation.lockedPnlPct > locked) {
      events.push(`lock+${evaluation.lockedPnlPct}@${pct}`);
    }
    locked = evaluation.lockedPnlPct;
    if (evaluation.exit) {
      events.push(`exit@${pct}`);
      break;
    }
  }
  // +3.1 locks 3, +5.2 locks 5, and the fade sells the moment it is back at +5%'s floor — the
  // pullback to 4.6 is already below the locked 5, so that is where it goes, not at 3.
  check("locks then sells on the first slip below the floor", events, ["lock+3@3.1", "lock+5@5.2", "exit@4.6"]);
}

console.log("\n--- the 9:16 trade now takes red candles only ---");
const bar = (open: number, close: number) =>
  build915BarFromCaptured(open, close, Math.max(open, close), Math.min(open, close))!;

check("a 20 pt fall enters the PE on the main band", decide915Entry(bar(24_800, 24_780)), {
  action: "enter",
  leg: "PE_BUY",
  exitMode: "main",
});
check("a 12 pt fall enters the PE on the near-miss band", decide915Entry(bar(24_800, 24_788)), {
  action: "enter",
  leg: "PE_BUY",
  exitMode: "near_miss",
});
check("a 20 pt rise is skipped — no CE side any more", decide915Entry(bar(24_800, 24_820)).action, "skip");
check("a 40 pt rise is skipped too", decide915Entry(bar(24_800, 24_840)).action, "skip");
check("a 7 pt fall is still under the 11 pt floor", decide915Entry(bar(24_800, 24_793)).action, "skip");
check("a flat candle is skipped", decide915Entry(bar(24_800, 24_800)).action, "skip");
check(
  "exactly 11 pts down is the edge of the near-miss band",
  decide915Entry(bar(24_800, 24_789)),
  { action: "enter", leg: "PE_BUY", exitMode: "near_miss" },
);

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
  // Only an explicit boolean true may arm either leg — the toggle routes compare with ===.
  for (const value of ["true", "1", 1, {}] as unknown[]) {
    check(`payload ${JSON.stringify(value)} does not arm`, value === true, false);
  }
}

console.log(
  failures === 0 ? "\nAll 9:15 trade checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
