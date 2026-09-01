/**
 * Manual sanity check for the momentum scalper exit engine:
 * · −4% P&L stop, taken on the first breaching reading, until the first profit rung locks
 * · ladder rungs +0.50%, +0.70%, +1%, then +0.5% steps (1.5, 2, 2.5, …)
 * · reaching a rung only moves the ladder on — the exit fires when P&L returns to the locked floor
 *
 * Run: npx tsx scripts/check-momentum-pnl-ladder.ts
 */
import {
  createExitState,
  evaluateMomentumExit,
  momentumPnlPctOfEntryCost,
  momentumPnlStopPct,
  momentumPnlTargetPct,
  momentumProfitExitPnlPct,
  MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT,
  MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT,
  MOMENTUM_SCALPER_PNL_ARM_PCT,
  MOMENTUM_SCALPER_PNL_RUNGS,
  MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT,
  MOMENTUM_OPENING_INITIAL_STOP_HOLD_MS,
  MOMENTUM_OPENING_INITIAL_STOP_LOSS_PCT,
  MOMENTUM_OPENING_PNL_ARM_PCT,
  momentumExitProfileForEntryMins,
  type MomentumScalperExitState,
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
console.log(
  `initial SL ${MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT}% P&L ` +
    `(${MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS > 0 ? `${MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS / 1000}s hold` : "instant"}) · ` +
    `rungs ${MOMENTUM_SCALPER_PNL_RUNGS.slice(0, 7).join("% / ")}% …\n`,
);

console.log("--- rung sequence ---");
check("first seven rungs", MOMENTUM_SCALPER_PNL_RUNGS.slice(0, 7), [0.5, 0.7, 1, 1.5, 2, 2.5, 3]);
check("0.5 floor sells at 0.4", momentumProfitExitPnlPct(0.5), 0.4);
check("0.7 floor sells at 0.6", momentumProfitExitPnlPct(0.7), 0.6);
check("1 floor sells at 0.9", momentumProfitExitPnlPct(1), 0.9);
check("1.5 floor sells at 1.4", momentumProfitExitPnlPct(1.5), 1.4);
check("2 floor sells at 1.9", momentumProfitExitPnlPct(2), 1.9);


// --- P&L percentage helper: 1 lot (75) of a 200-premium option ---
console.log("--- P&L percent of premium paid ---");
check("flat", momentumPnlPctOfEntryCost(0, 200, 75), 0);
check("+1% (=150 rupees on 15000 cost)", momentumPnlPctOfEntryCost(150, 200, 75), 1);
check("+3%", momentumPnlPctOfEntryCost(450, 200, 75), 3);
check("unknown mark", momentumPnlPctOfEntryCost(null, 200, 75), null);

console.log("\n--- CE: −4% P&L stop before first rung locks ---");
{
  let s = createExitState("CE", ENTRY);
  check("pre-ladder stop display", momentumPnlStopPct(s.lockedPnlPct), -4);

  const t = 10_000;
  let r = evaluateMomentumExit(s, { spot: ENTRY + 4, pnlPct: -2, nowMs: t });
  s = r.state;
  check("no rung locked", s.lockedPnlPct, 0);
  check("no exit above −4%", r.exit?.outcome ?? null, null);

  // The old rule sat on a breach for three seconds. There is no grace now.
  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -3.9, nowMs: t });
  check("−3.9% is not a breach", r.exit?.outcome ?? null, null);
  check("and nothing is recorded to wait on", r.state.initialStopBreachSinceMs, null);

  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -4, nowMs: t });
  check("exactly −4% exits on that same reading", r.exit?.outcome ?? null, "stop");
  check("no timer is started", r.state.initialStopBreachSinceMs, null);

  r = evaluateMomentumExit(createExitState("CE", ENTRY), { spot: ENTRY, pnlPct: -4.2, nowMs: t });
  check("−4.2% exits immediately too", r.exit?.outcome ?? null, "stop");

  // A dip that recovers used to be the whole point of the hold; it now stops the trade out.
  r = evaluateMomentumExit(createExitState("CE", ENTRY), { spot: ENTRY, pnlPct: -4.1, nowMs: t });
  check("a single spike through −4% is enough", r.exit?.outcome ?? null, "stop");

  s = createExitState("CE", ENTRY);
  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -3.99, nowMs: t });
  check("−3.99% holds", r.exit?.outcome ?? null, null);

  // P&L ladder runs from entry — no index arming required.
  s = createExitState("CE", ENTRY);
  r = evaluateMomentumExit(s, { spot: ENTRY + 4, pnlPct: 8, nowMs: 30_000 });
  check("locks rungs without +5 index", r.state.lockedPnlPct, 8);
}

console.log("\n--- CE: first rung at 0.5% ---");
{
  let s: MomentumScalperExitState = createExitState("CE", ENTRY);
  const step = (spot: number, pnlPct: number, label: string, nowMs = 40_000) => {
    const r = evaluateMomentumExit(s, { spot, pnlPct, nowMs });
    s = r.state;
    console.log(
      `  ${label.padEnd(30)} locked ${String(s.lockedPnlPct).padStart(2)}% · ` +
        `SL ${String(momentumPnlStopPct(s.lockedPnlPct) ?? "—").padStart(5)} · ` +
        `TP ${momentumPnlTargetPct(s.lockedPnlPct)}%` +
        `${r.exit ? `  => EXIT (${r.exit.outcome})` : ""}`,
    );
    return r;
  };

  step(ENTRY, 0.4, "P&L 0.4%");
  check(`nothing locked under ${MOMENTUM_SCALPER_PNL_ARM_PCT}%`, s.lockedPnlPct, 0);
  check(`TP is the ${MOMENTUM_SCALPER_PNL_ARM_PCT}% arm rung`, momentumPnlTargetPct(s.lockedPnlPct), MOMENTUM_SCALPER_PNL_ARM_PCT);
  check("stop still −4%", momentumPnlStopPct(s.lockedPnlPct), -4);

  const half = step(ENTRY + 1, 0.5, `P&L exactly ${MOMENTUM_SCALPER_PNL_ARM_PCT}%`);
  check(`locks ${MOMENTUM_SCALPER_PNL_ARM_PCT}%`, s.lockedPnlPct, MOMENTUM_SCALPER_PNL_ARM_PCT);
  check("reaching the rung does not sell", half.exit?.outcome ?? null, null);
  check("TP moves to 0.7%", momentumPnlTargetPct(s.lockedPnlPct), MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT);
  check(`SL moves to ${MOMENTUM_SCALPER_PNL_ARM_PCT}%`, momentumPnlStopPct(s.lockedPnlPct), MOMENTUM_SCALPER_PNL_ARM_PCT);

  step(ENTRY + 1, 0.55, "P&L 0.55% (above the 0.5% floor)");
  const backToHalf = step(ENTRY + 1, 0.5, "P&L back to 0.5% before 0.7%");
  check("returning to 0.5% sells without reaching 0.7%", backToHalf.exit?.outcome ?? null, "trail-stop");
  check("exit reports the 0.5% floor", backToHalf.exit?.lockedPnlPct ?? null, 0.5);
}

console.log("\n--- CE: P&L ladder from 0.7% ---");
{
  let s: MomentumScalperExitState = createExitState("CE", ENTRY);
  const step = (spot: number, pnlPct: number, label: string, nowMs = 50_000) => {
    const r = evaluateMomentumExit(s, { spot, pnlPct, nowMs });
    s = r.state;
    console.log(
      `  ${label.padEnd(30)} locked ${String(s.lockedPnlPct).padStart(2)}% · ` +
        `SL ${String(momentumPnlStopPct(s.lockedPnlPct) ?? "—").padStart(5)} · ` +
        `TP ${momentumPnlTargetPct(s.lockedPnlPct)}%` +
        `${r.exit ? `  => EXIT (${r.exit.outcome})` : ""}`,
    );
    return r;
  };

  const armTouch = step(ENTRY + 2, 0.7, `P&L exactly ${MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT}%`);
  check(`locks ${MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT}%`, s.lockedPnlPct, MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT);
  check("reaching the rung does not sell", armTouch.exit?.outcome ?? null, null);
  check("TP moves to 1%", momentumPnlTargetPct(s.lockedPnlPct), 1);
  check(`SL moves to ${MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT}%`, momentumPnlStopPct(s.lockedPnlPct), MOMENTUM_SCALPER_PNL_SECOND_RUNG_PCT);

  const climb = step(ENTRY + 3, 0.9, "P&L 0.9% (above the floor)");
  check("above the floor holds", climb.exit?.outcome ?? null, null);

  const one = step(ENTRY + 3, 1.0, "P&L 1.0%");
  check("locks 1%", s.lockedPnlPct, 1);
  check("no sell on the way up", one.exit?.outcome ?? null, null);
  check("TP moves to 1.5%", momentumPnlTargetPct(s.lockedPnlPct), 1.5);
  check("SL moves to 1%", momentumPnlStopPct(s.lockedPnlPct), 1);

  step(ENTRY + 5, 1.6, "P&L 1.6%");
  check("locks 1.5%", s.lockedPnlPct, 1.5);
  check("TP 2%", momentumPnlTargetPct(s.lockedPnlPct), 2);

  step(ENTRY + 7, 2.4, "P&L 2.4%");
  check("locks 2%", s.lockedPnlPct, 2);
  check("TP 2.5%", momentumPnlTargetPct(s.lockedPnlPct), 2.5);

  const backToFloor = step(ENTRY + 6, 2.0, "P&L back to exactly the 2% floor");
  check("returning to the floor sells", backToFloor.exit?.outcome ?? null, "trail-stop");
  check("exit reports the floor", backToFloor.exit?.lockedPnlPct ?? null, 2);
}

console.log("\n--- a single spike locks a rung but never sells on that tick ---");
{
  let s = createExitState("CE", ENTRY);
  const spike = evaluateMomentumExit(s, { spot: ENTRY + 9, pnlPct: 3, nowMs: 40_000 });
  s = spike.state;
  check("locks 3%", s.lockedPnlPct, 3);
  check("and holds", spike.exit?.outcome ?? null, null);
  const fall = evaluateMomentumExit(s, { spot: ENTRY + 5, pnlPct: 2.95, nowMs: 40_200 });
  check("the very next reading below the floor sells", fall.exit?.outcome ?? null, "trail-stop");
  check("at the 3% floor", fall.exit?.lockedPnlPct ?? null, 3);
}

console.log("\n--- PE: mirrored ---");
{
  let s = createExitState("PE", ENTRY);

  const t = 50_000;
  let r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -3.2, nowMs: t });
  s = r.state;
  check("PE −3.2% is above the stop and holds", r.exit?.outcome ?? null, null);
  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -4.2, nowMs: t + 200 });
  check("PE −4.2% stops out at once", r.exit?.outcome ?? null, "stop");

  s = createExitState("PE", ENTRY);
  r = evaluateMomentumExit(s, { spot: ENTRY - 2, pnlPct: 0.5, nowMs: 60_000 });
  s = r.state;
  check(`PE locks ${MOMENTUM_SCALPER_PNL_ARM_PCT}% from P&L alone`, s.lockedPnlPct, MOMENTUM_SCALPER_PNL_ARM_PCT);

  r = evaluateMomentumExit(s, { spot: ENTRY - 1, pnlPct: 0.4, nowMs: 61_000 });
  check(`PE exits below locked ${MOMENTUM_SCALPER_PNL_ARM_PCT}%`, r.exit?.outcome ?? null, "trail-stop");
}

console.log("\n--- −4% stop switches off once a rung is locked ---");
{
  let s = createExitState("CE", ENTRY);
  s = evaluateMomentumExit(s, { spot: ENTRY + 2, pnlPct: 2.5, nowMs: 70_000 }).state;
  check("locked 2.5%", s.lockedPnlPct, 2.5);
  const hold = evaluateMomentumExit(s, { spot: ENTRY - 20, pnlPct: 2.6, nowMs: 71_000 });
  check("holds while P&L stays above locked rung", hold.exit?.outcome ?? null, null);

  s = createExitState("CE", ENTRY);
  s = evaluateMomentumExit(s, { spot: ENTRY + 2, pnlPct: 2.5, nowMs: 72_000 }).state;
  const trail = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -4.5, nowMs: 73_000 });
  check("below locked rung exits via trail-stop, not the −4% initial stop", trail.exit?.outcome ?? null, "trail-stop");
}

console.log("\n--- bad P&L reading cannot lock a rung ---");
{
  let s = createExitState("CE", ENTRY);
  s = evaluateMomentumExit(s, { spot: ENTRY + 2, pnlPct: 3, nowMs: 80_000 }).state;
  const locked = s.lockedPnlPct;
  const r = evaluateMomentumExit(s, { spot: ENTRY + 3, pnlPct: 5000, nowMs: 81_000 });
  check("implausible reading ignored", r.state.lockedPnlPct, locked);
  const unknown = evaluateMomentumExit(s, { spot: ENTRY + 3, pnlPct: null, nowMs: 82_000 });
  check("null P&L never exits", unknown.exit?.outcome ?? null, null);
}

console.log("\n--- opening window (09:15–09:20 entries): 5% ladder, −10% initial stop ---");
{
  check("09:15 entry uses opening profile", momentumExitProfileForEntryMins(9 * 60 + 15), "opening");
  check("09:20 entry uses opening profile", momentumExitProfileForEntryMins(9 * 60 + 20), "opening");
  check("09:21 entry uses standard profile", momentumExitProfileForEntryMins(9 * 60 + 21), "standard");

  let s = createExitState("CE", ENTRY, "opening");
  check("opening pre-ladder stop", momentumPnlStopPct(s.lockedPnlPct, "opening"), -MOMENTUM_OPENING_INITIAL_STOP_LOSS_PCT);

  let t = 90_000;
  let r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -11, nowMs: t });
  s = r.state;
  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -12, nowMs: t + 14_999 });
  check("opening −10% no exit before 15s", r.exit?.outcome ?? null, null);
  r = evaluateMomentumExit(s, { spot: ENTRY, pnlPct: -13, nowMs: t + MOMENTUM_OPENING_INITIAL_STOP_HOLD_MS + 1 });
  check("opening −10% stop after >15s below −10%", r.exit?.outcome ?? null, "stop");

  s = createExitState("CE", ENTRY, "opening");
  r = evaluateMomentumExit(s, { spot: ENTRY + 10, pnlPct: 5.2, nowMs: 100_000 });
  s = r.state;
  check("opening locks 5%", s.lockedPnlPct, MOMENTUM_OPENING_PNL_ARM_PCT);
  check("opening TP 10%", momentumPnlTargetPct(s.lockedPnlPct, "opening"), 10);
  check("opening SL 5%", momentumPnlStopPct(s.lockedPnlPct, "opening"), 5);

  r = evaluateMomentumExit(s, { spot: ENTRY + 8, pnlPct: 4.9, nowMs: 101_000 });
  check("opening instant exit below 5%", r.exit?.outcome ?? null, "trail-stop");

  s = createExitState("CE", ENTRY, "opening");
  s = evaluateMomentumExit(s, { spot: ENTRY + 15, pnlPct: 10.1, nowMs: 102_000 }).state;
  check("opening locks 10%", s.lockedPnlPct, 10);
  check("opening TP 15%", momentumPnlTargetPct(s.lockedPnlPct, "opening"), 15);
  r = evaluateMomentumExit(s, { spot: ENTRY + 12, pnlPct: 9.8, nowMs: 103_000 });
  check("opening instant exit below 10%", r.exit?.outcome ?? null, "trail-stop");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
