/**
 * Traps live entry: any tick in candle 2's first second vs last tick of candle 1 (+0.1 gate),
 * then 2-pt pullback from the first tick of candle 2 before market buy.
 *
 * Run: npx tsx scripts/check-momentum-market-entry.ts
 */
import {
  momentumGateFirstTickPasses,
  momentumGateFirstSecondPasses,
  momentumGateInScanWindow,
  momentumGateFirstTickBarPasses,
  trapsPullbackEntryTriggered,
  trapsPullbackEntryIndexFromBar,
  MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS,
  MOMENTUM_SCALPER_LIVE_RULES,
  MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
  MOMENTUM_SCALPER_GATE_SCAN_SEC,
} from "../server/momentum-scalper-logic.js";
import type { DayScalperSide } from "../src/types/day-scalper.js";

let failures = 0;

function report(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  console.log(`       ${detail}`);
}

console.log(
  `range ≥ ${MOMENTUM_SCALPER_LIVE_RULES.minMovePts} pts · first-second gate ±` +
    `${MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS} · ${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS} pt pullback entry\n`,
);

report(
  "gate scan window is first second",
  MOMENTUM_SCALPER_GATE_SCAN_SEC === 1,
  `got ${MOMENTUM_SCALPER_GATE_SCAN_SEC}s`,
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
  ticks: number[];
  expectPass: boolean;
}

const gateCases: GateCase[] = [
  {
    name: "CE · first second includes a tick ≥ last + 0.1",
    side: "CE",
    signalLastTick: 24015,
    ticks: [24015.05, 24015.08, 24015.15],
    expectPass: true,
  },
  {
    name: "CE · first second never reaches gate",
    side: "CE",
    signalLastTick: 24015,
    ticks: [24015.05, 24015.08, 24015.09],
    expectPass: false,
  },
  {
    name: "PE · first second includes a tick ≤ last − 0.1",
    side: "PE",
    signalLastTick: 23985,
    ticks: [23984.95, 23984.92, 23984.9],
    expectPass: true,
  },
  {
    name: "PE · first second never reaches gate",
    side: "PE",
    signalLastTick: 23985,
    ticks: [23984.95, 23984.93, 23984.91],
    expectPass: false,
  },
];

for (const c of gateCases) {
  const pass = momentumGateFirstSecondPasses(c.side, c.ticks, c.signalLastTick);
  report(c.name, pass === c.expectPass, `pass=${pass}`);
}

report(
  "single tick helper still works",
  momentumGateFirstTickPasses("CE", 24015.15, 24015),
  "24015.15 clears +0.1",
);
report(
  "scan window covers second 0 only",
  momentumGateInScanWindow(Date.parse("2026-09-03T09:16:00.500+05:30")) &&
    !momentumGateInScanWindow(Date.parse("2026-09-03T09:16:01.000+05:30")),
  "00.500 in · 01.000 out",
);

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
  "backtest bar gate (open-only helper)",
  momentumGateFirstTickBarPasses("CE", 24015.3, 24015),
  "open vs last tick",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log("\nAll checks passed.");
