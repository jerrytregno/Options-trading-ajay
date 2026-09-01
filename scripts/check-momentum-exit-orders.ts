/**
 * Exit rules for Traps:
 *
 *   1. Hard stop — a loss past the floor exits at once at market.
 *   2. Profit exit price — when P&L comes back to a locked floor, the sell is a marketable limit
 *      priced a tenth of a percent under that floor, and never at or below the entry price.
 *   3. Loss exits — initial stop and force square-off cross at market immediately.
 *
 * Run: npx tsx scripts/check-momentum-exit-orders.ts
 */
import {
  createExitState,
  evaluateMomentumExit,
  isMomentumHardStopBreached,
  momentumExitProfileConfig,
  momentumOptionPriceForPnlPct,
  momentumProfitExitLimitPrice,
  momentumProfitExitPnlPct,
  MOMENTUM_OPENING_HARD_STOP_LOSS_PCT,
  MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT,
  MOMENTUM_SCALPER_HARD_STOP_LOSS_PCT,
  MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_PNL_ARM_PCT,
  MOMENTUM_SCALPER_PNL_MIN_PLAUSIBLE_PCT,
  type MomentumExitProfile,
} from "../server/momentum-scalper-logic.js";

import fs from "node:fs";
import path from "node:path";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? "" : `got ${a}, want ${b}`);
}

const ENTRY = 24000;
const OPTION_ENTRY = 93;

/** First exit produced by feeding a constant P&L at 200ms ticks. */
function firstExit(profile: MomentumExitProfile, pnlPct: number, durationMs = 20_000) {
  let state = createExitState("CE", ENTRY, profile);
  for (let t = 0; t <= durationMs; t += 200) {
    const result = evaluateMomentumExit(state, { spot: ENTRY, pnlPct, nowMs: t });
    state = result.state;
    if (result.exit) return { ...result.exit, atMs: t };
  }
  return null;
}

console.log("— Hard stop levels —");
eq("standard hard stop is −6%", MOMENTUM_SCALPER_HARD_STOP_LOSS_PCT, 6);
eq("opening hard stop is −20%", MOMENTUM_OPENING_HARD_STOP_LOSS_PCT, 20);
check(
  "each profile's hard stop is deeper than its held stop",
  (["standard", "opening"] as const).every((p) => {
    const config = momentumExitProfileConfig(p);
    return config.hardStopLossPct > config.initialStopLossPct;
  }),
);

console.log("\n— The hard stop does not wait —");
{
  const hit = firstExit("standard", -6);
  eq("exactly −6% exits", hit?.outcome ?? null, "stop");
  eq("on the very first reading, with no hold", hit?.atMs ?? null, 0);
  eq("and is flagged as a hard stop", hit?.hardStop ?? false, true);
}
{
  const hit = firstExit("standard", -25);
  eq("a collapse exits immediately too", hit?.atMs ?? null, 0);
  eq("flagged hard", hit?.hardStop ?? false, true);
}

console.log("\n— Between −4% and −6%, the initial stop takes it, also instantly —");
eq("the standard profile has no hold left", MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS, 0);
{
  const hit = firstExit("standard", -5.9);
  eq("−5.9% is not a hard stop", hit?.hardStop ?? false, false);
  eq("but it still exits on the first reading", hit?.atMs ?? null, 0);
}
{
  const hit = firstExit("standard", -4);
  eq("exactly −4% exits at once", hit?.atMs ?? null, 0);
  eq("and is not marked hard", hit?.hardStop ?? false, false);
}
eq("−3.9% never exits", firstExit("standard", -3.9, 30_000), null);

console.log("\n— A locked profit rung is no reason to sit through a collapse —");
{
  let state = createExitState("CE", ENTRY, "standard");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: 3, nowMs: 0 }).state;
  check("a rung is locked", state.lockedPnlPct > 0, `locked ${state.lockedPnlPct}%`);
  const hit = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -8, nowMs: 200 });
  eq("a gap straight through to −8% hard stops", hit.exit?.hardStop ?? false, true);
}

console.log("\n— Bad ticks cannot fire the emergency exit —");
eq("null P&L is not a hard stop", isMomentumHardStopBreached(null, "standard"), false);
eq("NaN is not a hard stop", isMomentumHardStopBreached(Number.NaN, "standard"), false);
eq(
  "an impossible reading is rejected, not acted on",
  isMomentumHardStopBreached(-100_000, "standard"),
  false,
);
eq(
  "−100% is the worst a long option can do, and is still real",
  isMomentumHardStopBreached(MOMENTUM_SCALPER_PNL_MIN_PLAUSIBLE_PCT, "standard"),
  true,
);
eq("just past it is bad data", isMomentumHardStopBreached(-100.01, "standard"), false);
eq("a real −6% is accepted", isMomentumHardStopBreached(-6, "standard"), true);
{
  let state = createExitState("CE", ENTRY, "standard");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -100_000, nowMs: 0 }).state;
  eq("an impossible reading does not start the hold timer", state.initialStopBreachSinceMs, null);
  const later = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -100_000, nowMs: 10_000 });
  eq("and never exits, however long it repeats", later.exit ?? null, null);
}
{
  // The opening profile is the only one left with a hold, so it is where this still matters.
  let state = createExitState("CE", ENTRY, "opening");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -11, nowMs: 0 }).state;
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -100_000, nowMs: 1_000 }).state;
  eq("garbage mid-breach leaves the running timer alone", state.initialStopBreachSinceMs, 0);
  const hit = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -11, nowMs: 15_000 });
  eq("so the real hold still completes on time", hit.exit?.outcome ?? null, "stop");
}

console.log("\n— Opening profile keeps its own floor —");
eq("−20% hard stops", firstExit("opening", -20)?.atMs ?? null, 0);
eq("−19% does not", firstExit("opening", -19)?.hardStop ?? false, false);
eq(
  "and −19% still exits on the 15s hold instead",
  firstExit("opening", -19, 30_000)?.atMs ?? null,
  15_000,
);

console.log("\n— Profit exit is priced under the locked floor —");
eq("the giveback is a tenth of a percent", MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT, 0.1);
eq(`a ${MOMENTUM_SCALPER_PNL_ARM_PCT}% floor aims at 0.4%`, momentumProfitExitPnlPct(0.5), 0.4);
eq("a 0.7% floor aims at 0.6%", momentumProfitExitPnlPct(0.7), 0.6);
eq("a 1% floor aims at 0.9%", momentumProfitExitPnlPct(1), 0.9);
eq("a 1.5% floor aims at 1.4%", momentumProfitExitPnlPct(1.5), 1.4);
eq("a 2% floor aims at 1.9%", momentumProfitExitPnlPct(2), 1.9);
eq("+1% on ₹100 is ₹101", momentumOptionPriceForPnlPct(100, 1), 101);
eq("a 1% floor on ₹100 sells at ₹100.90", momentumProfitExitLimitPrice(100, 1), 100.9);
check(
  "the limit always sits under the floor it came from",
  [0.5, 0.7, 1, 1.5, 2, 5].every(
    (floor) =>
      momentumProfitExitLimitPrice(200, floor) < momentumOptionPriceForPnlPct(200, floor),
  ),
);
check(
  "and always above the entry price, so a profit exit can never book a loss",
  [0.5, 0.7, 1, 1.5, 2, 5].every((floor) =>
    [40, 93, 200, 480].every((entry) => momentumProfitExitLimitPrice(entry, floor) > entry),
  ),
);
check("a higher floor sells higher", momentumProfitExitLimitPrice(OPTION_ENTRY, 1.5) > momentumProfitExitLimitPrice(OPTION_ENTRY, 1));

console.log("\n— Loss exits always cross at market —");

// `squareOff` works a limit only when it is handed one, so the invariant is which exits hand it
// a price. Read from the bot itself: a stub asserting "market" told us nothing about the wiring.
const botSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "server", "momentum-scalper-bot.ts"),
  "utf-8",
);
const handleExitHit = botSource.slice(
  botSource.indexOf("async function handleExitHit("),
  botSource.indexOf("function onNiftyTick("),
);
const hardStopCall = handleExitHit.slice(
  handleExitHit.indexOf("if (hardStop) {"),
  handleExitHit.indexOf("// Profit exit:"),
);
const profitCall = handleExitHit.slice(handleExitHit.indexOf("// Profit exit:"));

check(
  "the hard stop sends no limit price",
  hardStopCall.includes("squareOff(") && !hardStopCall.includes("limitPrice"),
  "market sell only",
);
check(
  "the initial stop sends no limit price either",
  handleExitHit.includes("await squareOff(session.accessToken, label, exitIndexPrice);"),
  "the trailing squareOff call takes three arguments",
);
check(
  "only the profit exit prices a limit",
  profitCall.includes("momentumProfitExitLimitPrice(entryPrice, lockedPnlPct)") &&
    profitCall.includes("limitPrice > 0 ? limitPrice : undefined"),
  "trail-stop passes a marketable limit",
);

console.log(failures === 0 ? "\nAll exit order checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
