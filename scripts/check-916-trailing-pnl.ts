/**
 * Walks a few synthetic P&L paths through the 9:16 trailing ladder so the rung
 * promotion and stop-out points can be eyeballed without a live market.
 */
import {
  nextLockedPnlPct,
  trailingPnlTargetPct,
  trailingPnlStopPct,
  shouldExitOnTrailingPnl,
  shouldInstantExitTrailingPnl,
  getPnlTrailScheduleLabel,
  getNineSixteenPnlTrailRungs,
  ownLegUnrealisedPnl,
  pnlPctOfEntryCost,
  isPlausiblePnlPct,
  NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT,
} from "../server/nine-sixteen-logic.js";

function run(name: string, path: number[], dateIst?: string) {
  let locked = 0;
  const events: string[] = [];
  for (const pct of path) {
    const before = locked;
    locked = nextLockedPnlPct(locked, pct, dateIst);
    if (locked > before) {
      events.push(`+${pct}% → lock SL +${locked}%, next target +${trailingPnlTargetPct(locked, dateIst)}%`);
    }
    if (shouldExitOnTrailingPnl(locked, pct)) {
      events.push(
        shouldInstantExitTrailingPnl(pct)
          ? `+${pct}% → INSTANT EXIT (+${NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT}%)`
          : `+${pct}% → EXIT (below locked +${locked}%)`,
      );
      break;
    }
  }
  const stop = trailingPnlStopPct(locked);
  console.log(`\n${name}`);
  console.log(`  path: ${path.map((p) => `${p}%`).join(" → ")}`);
  for (const e of events) console.log(`  ${e}`);
  if (!events.some((e) => e.includes("EXIT"))) {
    console.log(
      `  still open · locked SL ${stop == null ? "not armed" : `+${stop}%`} · next target +${trailingPnlTargetPct(locked, dateIst)}%`,
    );
  }
}

console.log("Tuesday (+8% first tier):");
console.log(`  ${getPnlTrailScheduleLabel("2026-09-01")}`);
console.log(`  rungs: ${getNineSixteenPnlTrailRungs("2026-09-01").length} tiers · instant @ +${NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT}%`);

console.log("\nMonday (+4% first tier, same as Wed):");
console.log(`  ${getPnlTrailScheduleLabel("2026-08-31")}`);

console.log("\nWednesday:");
console.log(`  ${getPnlTrailScheduleLabel("2026-09-02")}`);

console.log("\nThursday:");
console.log(`  ${getPnlTrailScheduleLabel("2026-09-03")}`);

// Regression: aggregate broker P&L must not lock a rung.
{
  const entryPrice = 29.41;
  const quantity = 325;
  const aggregateBrokerPnl = 35_800;
  const badPct = pnlPctOfEntryCost(aggregateBrokerPnl, entryPrice, quantity);
  const ownPnl = ownLegUnrealisedPnl(entryPrice, quantity, 31.5);
  const goodPct = pnlPctOfEntryCost(ownPnl, entryPrice, quantity);
  console.log("\nRegression · aggregate-P&L contamination");
  console.log(`  broker aggregate → ${badPct?.toFixed(1)}% · plausible? ${isPlausiblePnlPct(badPct)}`);
  console.log(`  locked floor from bad reading: +${nextLockedPnlPct(0, badPct)}%`);
  console.log(`  own leg only → ${goodPct?.toFixed(2)}% · locked floor +${nextLockedPnlPct(0, goodPct)}%`);
}

run("Never reaches +8% — ladder never arms", [1, 3, 4, 7.9, 2, -6, -20]);
run("Touches +8% then fades below +3%", [2, 8, 9, 2.9]);
run("Climbs to +12% then fades below +6%", [3, 8, 10, 12, 5.9]);
run("Runs to +25% then fades below +16%", [8, 12, 16, 20, 25, 15.9]);
run("Exactly on a lock floor does not exit", [8, 8, 3, 3]);
run("+50% instant market exit", [8, 20, 40, 50]);

run("Mon · touches +4% then fades below +3%", [2, 4, 4.5, 2.9], "2026-08-31");
run("Mon · never reaches +4% — ladder never arms", [1, 3, 3.9, 2], "2026-08-31");
run("Wed · touches +4% then fades below +3%", [2, 4, 4.5, 2.9], "2026-09-02");
run("Wed · never reaches +4% — ladder never arms", [1, 3, 3.9, 2], "2026-09-02");
run("Thu · touches +5% then fades below +3%", [2, 5, 5.5, 2.9], "2026-09-03");
run("Thu · climbs to +12% after +5% lock", [3, 5, 8, 12, 5.9], "2026-09-03");
