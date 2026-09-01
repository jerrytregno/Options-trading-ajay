/**
 * Walks a few synthetic P&L paths through the 9:16 trailing ladder so the rung
 * promotion and stop-out points can be eyeballed without a live market.
 */
import {
  nextLockedPnlPct,
  trailingPnlTargetPct,
  trailingPnlStopPct,
  shouldExitOnTrailingPnl,
  getPnlTrailScheduleLabel,
  ownLegUnrealisedPnl,
  pnlPctOfEntryCost,
  isPlausiblePnlPct,
} from "../server/nine-sixteen-logic.js";

function run(name: string, path: number[]) {
  let locked = 0;
  const events: string[] = [];
  for (const pct of path) {
    const before = locked;
    locked = nextLockedPnlPct(locked, pct);
    if (locked > before) {
      events.push(`+${pct}% → lock SL +${locked}%, TP +${trailingPnlTargetPct(locked)}%`);
    }
    if (shouldExitOnTrailingPnl(locked, pct)) {
      events.push(`+${pct}% → EXIT (below locked +${locked}%)`);
      break;
    }
  }
  const stop = trailingPnlStopPct(locked);
  console.log(`\n${name}`);
  console.log(`  path: ${path.map((p) => `${p}%`).join(" → ")}`);
  for (const e of events) console.log(`  ${e}`);
  if (!events.some((e) => e.includes("EXIT"))) {
    console.log(`  still open · locked SL ${stop == null ? "not armed" : `+${stop}%`} · TP +${trailingPnlTargetPct(locked)}%`);
  }
}

console.log(getPnlTrailScheduleLabel());

// Regression: 2026-08-25. A 325-qty leg (cost basis ₹9,559) read the broker's aggregate
// unrealised of ~+₹35,800, which belonged to a 6,305-qty position in the same contract.
// That is +375%, and the old ladder locked a rung there — guaranteeing an instant stop-out.
{
  const entryPrice = 29.41;
  const quantity = 325;
  const aggregateBrokerPnl = 35_800;
  const badPct = pnlPctOfEntryCost(aggregateBrokerPnl, entryPrice, quantity);
  const ownPnl = ownLegUnrealisedPnl(entryPrice, quantity, 31.5);
  const goodPct = pnlPctOfEntryCost(ownPnl, entryPrice, quantity);
  console.log("\nRegression · aggregate-P&L contamination");
  console.log(`  broker aggregate → ${badPct?.toFixed(1)}% · plausible? ${isPlausiblePnlPct(badPct)}`);
  console.log(`  locked rung from bad reading: +${nextLockedPnlPct(0, badPct)}% (was +405% before the fix)`);
  console.log(`  own leg only     → ${goodPct?.toFixed(2)}% · locked rung +${nextLockedPnlPct(0, goodPct)}%`);
}
run("Never reaches +5% — ladder never arms, other exits handle it", [1, 3, 4.9, 2, -6, -20]);
run("Touches +5% then fades", [2, 5, 6.4, 4.9]);
run("Climbs to +12% then fades", [3, 5, 8, 10, 12, 9.9]);
run("Runs to +21% then fades", [5, 11, 15, 18, 21, 19.9]);
run("Exactly on a rung does not exit", [5, 5, 5, 10, 10]);
