/**
 * Traps live entry: watch websocket ticks in the first 10 seconds of candle 2 for a +0.2 pt
 * continuation of the signal; if seen, market buy at :11. No limit order, no premium drop.
 *
 * Run: npx tsx scripts/check-momentum-market-entry.ts
 */
import fs from "fs";
import path from "node:path";
import * as logic from "../server/momentum-scalper-logic.js";
import {
  momentumGateLevel,
  momentumGateSeenInMinuteBar,
  momentumGateTickPasses,
  MOMENTUM_ENTRY_SEC,
  MOMENTUM_GATE_READ_SEC,
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
  `range >${MOMENTUM_SCALPER_LIVE_RULES.minMovePts} pts · ${MOMENTUM_GATE_READ_SEC}s gate at ±` +
    `${MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS} from signal close · market buy at :${MOMENTUM_ENTRY_SEC}\n`,
);

report("gate gap is 0.2 pt", MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS === 0.2, `got ${MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS}`);
report("gate window is 10s", MOMENTUM_GATE_READ_SEC === 10, `got ${MOMENTUM_GATE_READ_SEC}`);
report("entry fires at :11", MOMENTUM_ENTRY_SEC === 11, `got ${MOMENTUM_ENTRY_SEC}`);

interface TickCase {
  name: string;
  side: DayScalperSide;
  signalClose: number;
  ticks: number[];
  expectSeen: boolean;
}

const tickCases: TickCase[] = [
  {
    name: "CE · open already clears +0.2",
    side: "CE",
    signalClose: 24015,
    ticks: [24015.3],
    expectSeen: true,
  },
  {
    name: "CE · flat open, a later tick in the window clears +0.2",
    side: "CE",
    signalClose: 24015,
    ticks: [24015.0, 24015.1, 24015.25],
    expectSeen: true,
  },
  {
    name: "CE · never reaches +0.2",
    side: "CE",
    signalClose: 24015,
    ticks: [24015.0, 24015.05, 24015.19],
    expectSeen: false,
  },
  {
    name: "PE · open already clears −0.2",
    side: "PE",
    signalClose: 23985,
    ticks: [23984.7],
    expectSeen: true,
  },
  {
    name: "PE · open fails but a later tick clears −0.2",
    side: "PE",
    signalClose: 23985,
    ticks: [23985.0, 23984.9, 23984.75],
    expectSeen: true,
  },
  {
    name: "PE · never reaches −0.2",
    side: "PE",
    signalClose: 23985,
    ticks: [23985.0, 23984.95, 23984.85],
    expectSeen: false,
  },
];

for (const c of tickCases) {
  const level = momentumGateLevel(c.side, c.signalClose);
  let seen = false;
  for (const tick of c.ticks) {
    if (momentumGateTickPasses(c.side, tick, c.signalClose)) seen = true;
  }
  report(
    c.name,
    seen === c.expectSeen,
    `level ${level.toFixed(2)} · ticks ${c.ticks.join(", ")} → ${seen ? "seen" : "not seen"}`,
  );
}

console.log("\n— Minute-bar backtest stand-in —");
report(
  "CE · open misses but high touches the gate",
  momentumGateSeenInMinuteBar("CE", { open: 24004, high: 24004.3, low: 24000 }, 24004),
  "open 24004, high 24004.3 vs level 24004.2",
);
report(
  "CE · open and high both miss",
  !momentumGateSeenInMinuteBar("CE", { open: 24004, high: 24004.1, low: 24000 }, 24004),
  "open 24004, high 24004.1 vs level 24004.2",
);

console.log("\n— The drop and the resting limit are gone from the rules module —");
for (const name of [
  "MOMENTUM_SCALPER_OPTION_DROP_RUPEES",
  "MOMENTUM_ENTRY_LIMIT_TTL_MS",
  "momentumOptionEntryLevel",
  "evaluateMomentumOptionDropTrigger",
  "shouldCancelPendingEntryLimit",
]) {
  report(`${name} is no longer exported`, !(name in logic), `logic.${name} === undefined`);
}

console.log("\n— Bot entry path —");
{
  const source = fs.readFileSync(path.join(process.cwd(), "server", "momentum-scalper-bot.ts"), "utf-8");
  report(
    "watches the first 10s on websocket ticks",
    source.includes("sec < MOMENTUM_GATE_READ_SEC") && source.includes("momentumGateTickPasses"),
    "gate ticks are checked only inside the read window",
  );
  report(
    "fires the market buy at :11",
    source.includes("runMomentumEntryBurst") && source.includes("MOMENTUM_ENTRY_SEC"),
    "one-shot burst at second 11",
  );
  report(
    "does not buy the instant the gate is seen",
    !source.includes("momentumOpenOk"),
    "no immediate entry on the first passing tick",
  );

  const start = source.indexOf("async function enterAtMarket(");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  report("enterAtMarket sends a market order", body.includes("placeRegularMarketOrder("), "");
  report("enterAtMarket never sends a limit buy", !body.includes("placeRegularLimitOrder("), "");
}

console.log(failures === 0 ? "\nMomentum gate + :11 entry checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
