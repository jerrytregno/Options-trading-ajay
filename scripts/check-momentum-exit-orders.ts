/**
 * Exit rules for Traps:
 *
 *   1. Hard stop — a loss past the floor exits at once at market.
 *   2. Profit exit — when P&L falls back to a locked floor, a resting limit sell is placed at
 *      floor −0.1% with instant retries; market backup at the same giveback if the limit is stuck.
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
  shouldMomentumProfitExitMarketBackup,
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

console.log("\n— Profit exit is priced under the locked floor —");
eq("the giveback is a tenth of a percent", MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT, 0.1);
eq(`a ${MOMENTUM_SCALPER_PNL_ARM_PCT}% floor aims at 0.4%`, momentumProfitExitPnlPct(0.5), 0.4);
eq("a 0.7% floor aims at 0.6%", momentumProfitExitPnlPct(0.7), 0.6);
eq("market backup at 0.4% when P&L prints there", shouldMomentumProfitExitMarketBackup(0.4, 0.5), true);
eq("no market backup above giveback", shouldMomentumProfitExitMarketBackup(0.5, 0.5), false);
eq("a 1% floor on ₹100 sells at ₹100.90", momentumProfitExitLimitPrice(100, 1), 100.9);

console.log("\n— Trail-stop arms the resting limit path —");
{
  let state = createExitState("CE", ENTRY, "standard");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: 0.5, nowMs: 0 }).state;
  const hit = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: 0.5, nowMs: 200 });
  eq("falling back to the 0.5% floor signals trail-stop", hit.exit?.outcome ?? null, "trail-stop");
  eq("exit reports the 0.5% floor", hit.exit?.lockedPnlPct ?? null, 0.5);
}

console.log("\n— Loss exits always cross at market —");
const botSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "server", "momentum-scalper-bot.ts"),
  "utf-8",
);
const handleExitHit = botSource.slice(
  botSource.indexOf("async function handleExitHit("),
  botSource.indexOf("function parseKiteMinuteRows("),
);
const armProfitExit = botSource.slice(
  botSource.indexOf("async function armProfitExit("),
  botSource.indexOf("async function maintainProfitExitOrders("),
);
check(
  "trail-stop no longer calls squareOff directly",
  handleExitHit.includes('if (outcome === "trail-stop")') &&
    handleExitHit.includes("return;") &&
    !handleExitHit.includes("momentumProfitExitLimitPrice(entryPrice, lockedPnlPct)"),
);
check(
  "armProfitExit places resting limits with retries",
  armProfitExit.includes("placeProfitExitLimitOrders") &&
    botSource.includes("MOMENTUM_PROFIT_EXIT_PLACE_MAX_ATTEMPTS"),
);
check(
  "market backup helper is wired",
  botSource.includes("shouldMomentumProfitExitMarketBackup") &&
    botSource.includes("profitExitMarketBackup"),
);

console.log(failures === 0 ? "\nAll exit order checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
