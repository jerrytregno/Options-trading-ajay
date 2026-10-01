/**
 * Traps exit model: +1% limit TP at entry · −2% stop held 3s · no ladder.
 *
 * Run: npx tsx scripts/check-momentum-pnl-ladder.ts
 */
import {
  createExitState,
  evaluateMomentumExit,
  momentumPnlPctOfEntryCost,
  momentumTakeProfitLimitPrice,
  MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT,
  MOMENTUM_SCALPER_TAKE_PROFIT_PCT,
  shouldMomentumTakeProfitMarketBackup,
} from "../server/momentum-scalper-logic.js";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

const ENTRY = 24000;
const OPTION_ENTRY = 100;

console.log(
  `TP +${MOMENTUM_SCALPER_TAKE_PROFIT_PCT}% · SL −${MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT}% (${MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS / 1000}s hold)\n`,
);

check("take-profit is 1%", MOMENTUM_SCALPER_TAKE_PROFIT_PCT, 1);
check("limit at +1% on ₹100", momentumTakeProfitLimitPrice(100, 1), 101);
check("market backup at +1%", shouldMomentumTakeProfitMarketBackup(1), true);
check("no backup below target", shouldMomentumTakeProfitMarketBackup(0.9), false);

console.log("\n--- stop only (no ladder exits) ---");
{
  let s = createExitState("CE", ENTRY);
  let r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: 1, nowMs: 0 });
  check("+1% does not exit via engine (limit handles TP)", r.exit?.outcome ?? null, null);
  check("locked stays 0", r.state.lockedPnlPct, 0);

  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: 2, nowMs: 1000 });
  check("+2% still no engine exit", r.exit?.outcome ?? null, null);

  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -2, nowMs: 2000 });
  s = r.state;
  check("−2% starts timer", s.initialStopBreachSinceMs, 2000);
  check("no instant exit at 2s", r.exit?.outcome ?? null, null);

  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -2.2, nowMs: 5000 });
  check("−2% for 3s exits", r.exit?.outcome ?? null, "stop");
}

console.log("\n--- P&L percent helper ---");
check("+1% on ₹100 entry × 65 qty", momentumPnlPctOfEntryCost(65, 100, 65), 1);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
