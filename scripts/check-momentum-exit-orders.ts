/**
 * Traps exit orders: +1% limit at entry · −2% stop (3s) · market backup.
 *
 * Run: npx tsx scripts/check-momentum-exit-orders.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  createExitState,
  evaluateMomentumExit,
  momentumTakeProfitLimitPrice,
  MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_TAKE_PROFIT_PCT,
  shouldMomentumTakeProfitMarketBackup,
} from "../server/momentum-scalper-logic.js";

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

console.log("— Take profit at entry —");
eq("target is 1%", MOMENTUM_SCALPER_TAKE_PROFIT_PCT, 1);
eq("limit price on ₹93 entry", momentumTakeProfitLimitPrice(93, 1), 93.95);
eq("market backup at target", shouldMomentumTakeProfitMarketBackup(1), true);

console.log("\n— Stop held 3s —");
{
  let state = createExitState("CE", ENTRY);
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -2, nowMs: 0 }).state;
  const hit = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -2.1, nowMs: MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS });
  eq("−2% exits after hold", hit.exit?.outcome ?? null, "stop");
  eq("no hardStop flag", hit.exit?.hardStop ?? false, false);
}

console.log("\n— Live bot wiring —");
const botSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "server", "momentum-scalper-bot.ts"),
  "utf-8",
);
check(
  "places TP limit on entry fill",
  botSource.includes("await placeTakeProfitLimitOrders(accessToken, dateIst)"),
);
check(
  "market backup uses +1% helper",
  botSource.includes("shouldMomentumTakeProfitMarketBackup"),
);
check("no armProfitExit on trail-stop", !botSource.includes("void armProfitExit("));
check("no hard stop handler", !botSource.includes("hard stop, option P&L broke"));

console.log(failures === 0 ? "\nAll exit order checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
