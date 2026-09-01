/**
 * Covers the index-pullback entry model, which is now the Day Scalper backtest only — the live
 * momentum bot buys at market on the open gate instead (see check-momentum-market-entry).
 *
 * The invariant that remains worth holding is internal to the backtest: its tick-level helper and
 * its OHLC path must agree on the trigger and the fill, and the fill must be the resting level
 * rather than wherever the candle happened to reach.
 */
import {
  evaluateMomentumEntry,
  evaluateMomentumPullbackTrigger,
  momentumMinuteOpenPasses,
  momentumTriggerPrice,
  MOMENTUM_SCALPER_LIVE_RULES,
} from "../server/momentum-scalper-logic.js";
import type { DayScalperSide } from "../src/types/day-scalper.js";

const rules = MOMENTUM_SCALPER_LIVE_RULES;
const pullback = rules.minCloseMarkPts;
console.log(
  `body >${rules.minMovePts} pts · momentum open ±0.1 from signal close · entry ${pullback} pts pullback\n`,
);

interface Case {
  name: string;
  side: DayScalperSide;
  signalOpen: number;
  signalClose: number;
  /** Tick path over the momentum candle, in arrival order. */
  ticks: number[];
}

const cases: Case[] = [
  {
    name: "CE · open gate + pullback",
    side: "CE",
    signalOpen: 24000,
    signalClose: 24015,
    ticks: [24015.6, 24014, 24013, 24014, 24020],
  },
  {
    name: "CE · open gate fails (flat open)",
    side: "CE",
    signalOpen: 24000,
    signalClose: 24015,
    ticks: [24015, 24014, 24013, 24018],
  },
  {
    // Derived from the rule so the case keeps testing "stops short" whatever the pullback is.
    name: `CE · only pulls back ${pullback / 2} — never triggers`,
    side: "CE",
    signalOpen: 24000,
    signalClose: 24015,
    ticks: [24015.6, 24015 - pullback / 2, 24015 - pullback / 2, 24018],
  },
  {
    name: "CE · gaps straight through the level",
    side: "CE",
    signalOpen: 24000,
    signalClose: 24015,
    ticks: [24016, 24002, 23998],
  },
  {
    name: "PE · open gate + pullback",
    side: "PE",
    signalOpen: 24000,
    signalClose: 23985,
    ticks: [23984.4, 23986, 23987, 23986, 23975],
  },
  {
    name: "PE · open gate fails",
    side: "PE",
    signalOpen: 24000,
    signalClose: 23985,
    ticks: [23985, 23986, 23987, 23980],
  },
  {
    name: `PE · only pulls back ${pullback / 2} — never triggers`,
    side: "PE",
    signalOpen: 24000,
    signalClose: 23985,
    ticks: [23984.4, 23985 + pullback / 2, 23985, 23980],
  },
];

let failures = 0;

for (const c of cases) {
  const level = momentumTriggerPrice(c.side, c.signalClose, pullback);
  const momentumOpen = c.ticks[0];

  let tickFill: number | null = null;
  let tickIndex = -1;
  let openOk: boolean | null = null;
  for (const [i, spot] of c.ticks.entries()) {
    if (openOk == null) {
      openOk = momentumMinuteOpenPasses(c.side, spot, c.signalClose);
      if (!openOk) break;
    }
    const verdict = evaluateMomentumPullbackTrigger(c.side, spot, c.signalClose, pullback);
    if (verdict.action === "enter") {
      tickFill = verdict.triggerPrice;
      tickIndex = i;
      break;
    }
  }

  const bar = {
    mins: 10 * 60,
    open: momentumOpen,
    low: Math.min(...c.ticks),
    high: Math.max(...c.ticks),
  };
  const decision = evaluateMomentumEntry(
    { open: c.signalOpen, close: c.signalClose },
    bar,
    "Monday",
    rules,
  );
  const backtestFill = decision.action === "enter" ? decision.entryIndexPrice : null;

  const agree = tickFill === backtestFill;
  if (!agree) failures += 1;

  console.log(`${agree ? "ok  " : "FAIL"} ${c.name}`);
  console.log(`       level ${level.toFixed(2)} · open ${momentumOpen} · bar low ${bar.low} high ${bar.high}`);
  console.log(
    `       ticks ${tickFill == null ? "no entry" : `fill ${tickFill.toFixed(2)} on tick ${tickIndex}`}` +
      ` · ohlc ${backtestFill == null ? `skip (${decision.action === "skip" ? decision.reason : ""})` : `fill ${backtestFill.toFixed(2)}`}`,
  );
}

const deep = evaluateMomentumEntry(
  { open: 24000, close: 24015 },
  { mins: 600, open: 24015.6, low: 23950, high: 24020 },
  "Monday",
  rules,
);
const shallow = evaluateMomentumEntry(
  { open: 24000, close: 24015 },
  { mins: 600, open: 24015.6, low: 24013, high: 24020 },
  "Monday",
  rules,
);
const deepFill = deep.action === "enter" ? deep.entryIndexPrice : null;
const shallowFill = shallow.action === "enter" ? shallow.entryIndexPrice : null;
const expectedFill = momentumTriggerPrice("CE", 24015, pullback);
const fillIsFixed = deepFill === shallowFill && deepFill === expectedFill;
if (!fillIsFixed) failures += 1;
console.log(
  `\n${fillIsFixed ? "ok  " : "FAIL"} fill is independent of candle depth: ` +
    `low 23950 → ${deepFill} · low 24013 → ${shallowFill}`,
);

console.log(
  failures === 0
    ? "\nBacktest tick path and OHLC path agree on every case."
    : `\n${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
