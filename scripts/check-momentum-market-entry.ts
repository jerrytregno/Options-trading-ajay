/**
 * Traps live entry: first tick of candle 2 vs last tick of candle 1 (+0.2 gate),
 * then 2-pt pullback from start before market buy.
 *
 * Run: npx tsx scripts/check-momentum-market-entry.ts
 */
import {
  momentumGateFirstTickPasses,
  momentumGateFirstTickBarPasses,
  trapsPullbackEntryTriggered,
  trapsPullbackEntryIndexFromBar,
  MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS,
  MOMENTUM_SCALPER_LIVE_RULES,
  MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
} from "../server/momentum-scalper-logic.js";
import type { DayScalperSide } from "../src/types/day-scalper.js";

let failures = 0;

function report(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  console.log(`       ${detail}`);
}

console.log(
  `range ≥ ${MOMENTUM_SCALPER_LIVE_RULES.minMovePts} pts · first-tick gate ±` +
    `${MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS} · ${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS} pt pullback entry\n`,
);

report(
  "min range is 5 pts",
  MOMENTUM_SCALPER_LIVE_RULES.minMovePts === 5,
  `got ${MOMENTUM_SCALPER_LIVE_RULES.minMovePts}`,
);
report(
  "pullback is 2 pts",
  MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS === 2,
  `got ${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS}`,
);

interface GateCase {
  name: string;
  side: DayScalperSide;
  signalLastTick: number;
  firstTick: number;
  expectPass: boolean;
}

const gateCases: GateCase[] = [
  { name: "CE · first tick clears last + 0.2", side: "CE", signalLastTick: 24015, firstTick: 24015.25, expectPass: true },
  { name: "CE · first tick fails gate", side: "CE", signalLastTick: 24015, firstTick: 24015.1, expectPass: false },
  { name: "PE · first tick clears last − 0.2", side: "PE", signalLastTick: 23985, firstTick: 23984.75, expectPass: true },
  { name: "PE · first tick fails gate", side: "PE", signalLastTick: 23985, firstTick: 23984.9, expectPass: false },
];

for (const c of gateCases) {
  const pass = momentumGateFirstTickPasses(c.side, c.firstTick, c.signalLastTick);
  report(c.name, pass === c.expectPass, `pass=${pass}`);
}

report(
  "CE pullback after gate",
  trapsPullbackEntryTriggered("CE", 24013, 24015),
  "start 24015 → enter at 24013",
);
report(
  "PE pullback after gate",
  trapsPullbackEntryTriggered("PE", 23987, 23985),
  "start 23985 → enter at 23987",
);
report(
  "backtest bar CE pullback",
  trapsPullbackEntryIndexFromBar("CE", { high: 24016, low: 24012 }, 24015) === 24013,
  "low touches 24013",
);
report(
  "backtest bar gate",
  momentumGateFirstTickBarPasses("CE", 24015.3, 24015),
  "open vs last tick",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log("\nAll checks passed.");
