/**
 * Traps stop: −2% P&L held for 3 continuous seconds.
 *
 * Run: npx tsx scripts/check-momentum-initial-stop-timer.ts
 */
import fs from "fs";
import path from "path";
import {
  createExitState,
  evaluateMomentumExit,
  MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS,
  MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT,
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

console.log("\n--- standard profile: −2% held 3s ---");
check("hold is 3s", MOMENTUM_SCALPER_INITIAL_STOP_HOLD_MS, 3000);
check("the stop level is −2%", MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT, -2);
check("−1.9% never exits", runHold({ profile: "standard", pnlPct: -1.9, durationMs: 10_000 }).outcome, null);
check(
  "−2% held through exits at 3s",
  runHold({ profile: "standard", pnlPct: -2, durationMs: 10_000 }).atMs,
  3000,
);
check(
  "−2.5% held through exits at 3s",
  runHold({ profile: "standard", pnlPct: -2.5, durationMs: 10_000 }).atMs,
  3000,
);
check(
  "wiping the timer each second suppresses the stop",
  runHold({ profile: "standard", pnlPct: -2.5, durationMs: 10_000, wipeTimerEveryMs: 1000 }).outcome,
  null,
);

console.log("\n--- recovery cancels the timer ---");
{
  let state = createExitState("CE", ENTRY, "standard");
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -2.2, nowMs: 0 }).state;
  check("timer running at −2.2%", state.initialStopBreachSinceMs, 0);
  state = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -1.5, nowMs: 1_000 }).state;
  check("recovering above −2% cancels it", state.initialStopBreachSinceMs, null);
  const late = evaluateMomentumExit(state, { spot: ENTRY, pnlPct: -2.1, nowMs: 2_000 });
  check("hold restarts on a new breach", late.exit?.outcome ?? null, null);
  check("timer restarted", late.state.initialStopBreachSinceMs, 2000);
}

console.log("\n--- no hard stop in exit engine ---");
{
  const hit = runHold({ profile: "standard", pnlPct: -6, durationMs: 10_000 });
  check("−6% still waits 3s (no instant hard stop)", hit.atMs, 3000);
  check("outcome is stop", hit.outcome, "stop");
}

console.log("\n--- the poll loop hydrates persisted state once per date ---");
{
  const source = fs.readFileSync(path.join(process.cwd(), "server", "momentum-scalper-bot.ts"), "utf-8");
  const start = source.indexOf("async function mainLoop()");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  check("mainLoop calls loadStateOnce", body.includes("loadStateOnce("), true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
