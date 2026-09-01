/**
 * The two initial stops behave differently on purpose: the standard profile exits the instant P&L
 * touches −4%, while the opening-window profile still holds a breach below −10% for 15s.
 *
 * The hold is counted with `initialStopBreachSinceMs`, which lives in memory on the exit state and
 * is only written to disk when a profit rung locks. That made it fragile in one specific way: the
 * poll loop used to re-read the persisted state every iteration (once a second) and overwrite the
 * live exit state with it. The breach timer was never in that snapshot, so it was reset to null
 * about once a second and the elapsed hold could never complete — the stop simply never fired.
 *
 * This script pins down all three:
 *
 *   1. the standard stop fires on the first breaching reading, with no timer at all,
 *   2. a held stop really does need an uninterrupted timer to fire, and
 *   3. `mainLoop` hydrates persisted state once per date, not once per poll.
 *
 * Run: npx tsx scripts/check-momentum-initial-stop-timer.ts
 */
import fs from "fs";
import path from "path";
import {
  createExitState,
  evaluateMomentumExit,
  MOMENTUM_OPENING_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT,
  type MomentumExitProfile,
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

/**
 * Feed a constant P&L for `durationMs` at 200ms ticks and report the first exit outcome.
 * `wipeTimerEveryMs` reproduces the old per-poll state reload by clearing the breach timer, which
 * is exactly what the persisted snapshot did when it was reloaded mid-breach.
 */
function runHold(opts: {
  profile: MomentumExitProfile;
  pnlPct: number;
  durationMs: number;
  wipeTimerEveryMs?: number;
}): { outcome: string | null; atMs: number | null } {
  let state: MomentumScalperExitState = createExitState("CE", ENTRY, opts.profile);
  let lastWipeMs = 0;
  for (let t = 0; t <= opts.durationMs; t += 200) {
    if (opts.wipeTimerEveryMs && t - lastWipeMs >= opts.wipeTimerEveryMs) {
      lastWipeMs = t;
      state = { ...state, initialStopBreachSinceMs: null };
    }
    const result = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: opts.pnlPct, nowMs: t });
    state = result.state;
    if (result.exit) return { outcome: result.exit.outcome, atMs: t };
  }
  return { outcome: null, atMs: null };
}

console.log("\n--- standard profile: −4% exits instantly, no hold ---");
check("there is no hold", MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS, 0);
check("the stop level is −4%", MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT, -4);
check(
  "−4% exactly exits on the very first reading",
  runHold({ profile: "standard", pnlPct: -4, durationMs: 10_000 }).atMs,
  0,
);
check(
  "−4.5% exits on the first reading too",
  runHold({ profile: "standard", pnlPct: -4.5, durationMs: 10_000 }),
  { outcome: "stop", atMs: 0 },
);
check(
  "−3.9% never exits, however long it sits there",
  runHold({ profile: "standard", pnlPct: -3.9, durationMs: 30_000 }).outcome,
  null,
);
check(
  "the old −3% level no longer stops anything out",
  runHold({ profile: "standard", pnlPct: -3, durationMs: 30_000 }).outcome,
  null,
);
check(
  "with no timer to reset, a per-poll state wipe cannot suppress the stop",
  runHold({ profile: "standard", pnlPct: -4.5, durationMs: 30_000, wipeTimerEveryMs: 200 }),
  { outcome: "stop", atMs: 0 },
);
check(
  "and no breach timer is ever written",
  (() => {
    const state = createExitState("CE", ENTRY, "standard");
    return evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -4.5, nowMs: 0 }).state
      .initialStopBreachSinceMs;
  })(),
  null,
);

console.log("\n--- the hold regression still guards the opening profile ---");
check(
  "wiping the timer each second suppresses the opening stop entirely",
  runHold({ profile: "opening", pnlPct: -11, durationMs: 60_000, wipeTimerEveryMs: 1000 }).outcome,
  null,
);
check(
  "wiping it every 20s is slower than the hold, so the stop survives",
  runHold({ profile: "opening", pnlPct: -11, durationMs: 60_000, wipeTimerEveryMs: 20_000 }).outcome,
  "stop",
);

console.log("\n--- opening profile: strictly below −10%, held 15s ---");
check("hold is 15s", MOMENTUM_OPENING_INITIAL_STOP_HOLD_MS, 15_000);
check(
  "−11% held through exits at 15s",
  runHold({ profile: "opening", pnlPct: -11, durationMs: 30_000 }).atMs,
  15_000,
);
check(
  "exactly −10% is not a breach and never exits",
  runHold({ profile: "opening", pnlPct: -10, durationMs: 60_000 }).outcome,
  null,
);

console.log("\n--- exactly −10% cancels a running opening timer (no dead zone) ---");
{
  let state = createExitState("CE", ENTRY, "opening");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -11, nowMs: 0 }).state;
  check("timer running at −11%", state.initialStopBreachSinceMs, 0);
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -10, nowMs: 5_000 }).state;
  check("recovering to exactly −10% cancels it", state.initialStopBreachSinceMs, null);
  const late = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -11, nowMs: 20_000 });
  check("so the 15s hold restarts rather than firing", late.exit?.outcome ?? null, null);
  check("timer restarted at the new breach", late.state.initialStopBreachSinceMs, 20_000);
}

console.log("\n--- a null P&L reading leaves a running timer alone ---");
{
  let state = createExitState("CE", ENTRY, "opening");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -11, nowMs: 0 }).state;
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: null, nowMs: 1_000 }).state;
  check("unknown P&L neither starts nor clears the timer", state.initialStopBreachSinceMs, 0);
  const hit = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -11, nowMs: 15_000 });
  check("the hold still completes at 15s", hit.exit?.outcome ?? null, "stop");
}

console.log("\n--- the poll loop hydrates persisted state once per date, not once per poll ---");
{
  const source = fs.readFileSync(
    path.join(process.cwd(), "server", "momentum-scalper-bot.ts"),
    "utf-8",
  );
  const start = source.indexOf("async function mainLoop()");
  const end = source.indexOf("\n}", start);
  check("mainLoop found", start >= 0 && end > start, true);
  const body = source.slice(start, end);
  check("mainLoop calls loadStateOnce", body.includes("loadStateOnce("), true);
  check(
    "mainLoop never calls loadState directly",
    /(?<!Once)\bloadState\(/.test(body.replace(/loadStateOnce\(/g, "")),
    false,
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
