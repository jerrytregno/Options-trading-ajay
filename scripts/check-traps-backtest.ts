/**
 * Exercises the Traps backtest session simulator against hand-built candles, so the entry gate,
 * the market fill, the two exit ladders and the one-position-at-a-time rule are all verified
 * without touching Zerodha.
 */
import type { DayScalperCandle } from "../src/types/day-scalper.js";
import {
  TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
  TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
  TRAPS_BACKTEST_RELAXED_MIN_BODY_PTS,
  simulateTrapsSession,
  type OptionRow,
} from "../server/traps-backtest.js";

const LOT_SIZE = 75;
const STRIKE = 24000;

function pad2(v: number) {
  return String(v).padStart(2, "0");
}

function bar(mins: number, open: number, high: number, low: number, close: number): DayScalperCandle {
  return {
    time: `2026-08-26T${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}:00+0530`,
    timeIst: `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`,
    mins,
    open,
    high,
    low,
    close,
  };
}

/** Flat filler so the scanner sees no signal on these minutes. */
function quiet(mins: number, price: number): DayScalperCandle {
  return bar(mins, price, price, price, price);
}

/** Steady climb so Wilder RSI at the last bar reads overbought. */
function risingBars(fromMins: number, count: number, start: number, step = 4): DayScalperCandle[] {
  const out: DayScalperCandle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    out.push(bar(fromMins + i, open, close + 2, open - 1, close));
    price = close;
  }
  return out;
}

/** Choppy warmup so Wilder RSI at the signal bar sits outside the live bands (~55). */
function chopWarmup(fromMins: number, count = 16, start = 24000): { bars: DayScalperCandle[]; price: number } {
  let price = start;
  const bars: DayScalperCandle[] = [];
  for (let i = 0; i < count; i++) {
    price += i % 3 === 0 ? -3 : 2;
    bars.push(bar(fromMins + i, price, price + 1, price - 1, price));
  }
  return { bars, price };
}

/** Steady drop so Wilder RSI at the last bar reads oversold. */
function fallingBars(fromMins: number, count: number, start: number, step = 4): DayScalperCandle[] {
  const out: DayScalperCandle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price - step;
    out.push(bar(fromMins + i, open, open + 1, close - 2, close));
    price = close;
  }
  return out;
}

const CE: OptionRow = {
  instrumentToken: 1,
  tradingsymbol: "NIFTY26SEP124000CE",
  expiry: "2026-09-01",
  strike: STRIKE,
  lotSize: LOT_SIZE,
  optionType: "CE",
};
const PE: OptionRow = { ...CE, instrumentToken: 2, tradingsymbol: "NIFTY26SEP124000PE", optionType: "PE" };

interface Case {
  name: string;
  spot: DayScalperCandle[];
  option: DayScalperCandle[];
  contract?: OptionRow;
  minBodyPts?: number;
  rsiFilter?: boolean;
  expect: {
    trades: number;
    gatePasses?: number;
    entryPremium?: number;
    exitPremium?: number;
    outcome?: string;
    profile?: string;
    entryTimeIst?: string;
    exitTimeIst?: string;
    skipReason?: string;
  };
}

const M915 = 9 * 60 + 15;
const M930 = 9 * 60 + 30;

const cases: Case[] = [
  {
    // A textbook setup at 09:16 — range and gate both present. Scanning does not open until 09:30,
    // so it must be ignored outright rather than counted as a gate pass.
    name: "the 09:15–09:30 open is sat out · a clean 09:16 setup is never scanned",
    spot: [
      bar(M915, 24000, 24005, 23999, 24004),
      bar(M915 + 1, 24004.5, 24010, 24003, 24009),
      quiet(M915 + 2, 24009),
    ],
    option: [
      bar(M915 + 1, 100, 100.5, 99.4, 100.2),
      bar(M915 + 2, 100.2, 105.5, 100, 105.4),
    ],
    expect: { trades: 0, gatePasses: 0 },
  },
  {
    // Range 6 pts, next minute opens 0.5 above the close → gate passes and the market buy pays that
    // minute's open, ₹100. It then runs to +5.5% and slips back under the rung.
    name: "gate passes → market buy at the minute's open, ladder locks the 5.5% rung",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24005, 23999, 24004),
      bar(M930 + 1, 24004.5, 24010, 24003, 24009),
      quiet(M930 + 2, 24009),
    ],
    option: [
      bar(M930 + 1, 100, 100, 99.4, 99.6),
      bar(M930 + 2, 99.6, 105.5, 99.5, 105.4),
    ],
    expect: {
      trades: 1,
      gatePasses: 1,
      entryPremium: 100,
      // 5.5% locked off the 105.5 high, the close falls back to it → sells 0.1% under, 100 × 1.054.
      exitPremium: 105.4,
      outcome: "trail-stop",
      profile: "standard",
      entryTimeIst: "09:31",
      exitTimeIst: "09:32",
    },
  },
  {
    // The old rule rested a limit at ₹99.50 and dropped this setup because the premium never traded
    // back down to it. A market buy takes it at ₹100 and the trade goes on to lock 2.5%.
    name: "a premium that only runs up is traded now, not skipped",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24005, 23999, 24004),
      bar(M930 + 1, 24004.5, 24010, 24004, 24009),
      quiet(M930 + 2, 24009),
    ],
    option: [
      bar(M930 + 1, 100, 103, 99.6, 102.5),
      bar(M930 + 2, 102.5, 104, 102, 103),
    ],
    expect: {
      trades: 1,
      gatePasses: 1,
      entryPremium: 100,
      exitPremium: 102.4,
      outcome: "trail-stop",
      profile: "standard",
      entryTimeIst: "09:31",
      exitTimeIst: "09:32",
    },
  },
  {
    name: "momentum minute never reaches +0.2 in the signal direction → gate fails, no trade",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24005, 23999, 24004),
      // CE needs ≥ 24004.2; open 24004.0 and high 24004.1 both miss.
      bar(M930 + 1, 24004.0, 24004.1, 24000, 24009),
      quiet(M930 + 2, 24009),
    ],
    option: [bar(M930 + 1, 100, 100.5, 95, 96)],
    expect: { trades: 0, gatePasses: 0 },
  },
  {
    // The filter reads high − low, so this is the boundary: exactly 2 pts of range does not pass.
    name: "range of exactly 2 pts is not a signal",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24002, 24000, 24002),
      bar(M930 + 1, 24003, 24010, 24002, 24009),
      quiet(M930 + 2, 24009),
    ],
    option: [bar(M930 + 1, 100, 100.5, 95, 96)],
    expect: { trades: 0, gatePasses: 0 },
  },
  {
    // Body of only 0.5 pts, but the minute ran 5 pts high to low. Under the old close−open filter
    // this was invisible; the range filter takes it, and the green body still points it at the CE.
    name: "a narrow body over a wide range is a signal · direction still comes from the body",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24004, 23999, 24000.5),
      bar(M930 + 1, 24001, 24010, 24000.5, 24009),
      quiet(M930 + 2, 24009),
    ],
    // Only one option bar, so the trade runs to the end of the data and closes there.
    option: [bar(M930 + 1, 100, 100.5, 99.6, 100.2)],
    expect: { trades: 1, gatePasses: 1, entryPremium: 100, outcome: "eod" },
  },
  {
    name: "a doji has no colour, so a wide range alone is not a signal",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24005, 23995, 24000),
      bar(M930 + 1, 24001, 24010, 24000, 24009),
      quiet(M930 + 2, 24009),
    ],
    option: [bar(M930 + 1, 100, 100.5, 99.4, 100.2)],
    expect: { trades: 0, gatePasses: 0 },
  },
  {
    name: "1 pt variant · body of 1.5 pts counts as a signal (live 2 pt would skip it)",
    minBodyPts: TRAPS_BACKTEST_RELAXED_MIN_BODY_PTS,
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24002.5, 23999, 24001.5),
      bar(M930 + 1, 24002.0, 24010, 24001, 24009),
      quiet(M930 + 2, 24009),
    ],
    option: [
      bar(M930 + 1, 100, 100, 99.4, 99.6),
      bar(M930 + 2, 99.6, 99.7, 99.5, 99.6),
    ],
    expect: { trades: 1, gatePasses: 1 },
  },
  {
    // Standard profile after 09:20. Bar 09:32 opens already below the stop.
    name: "standard ladder · initial −4% stop fires when a full bar stays below it",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24005, 23999, 24004),
      bar(M930 + 1, 24004.5, 24010, 24003, 24009),
      quiet(M930 + 2, 24009),
      quiet(M930 + 3, 24009),
    ],
    option: [
      bar(M930 + 1, 100, 100, 99.4, 99.6),
      bar(M930 + 2, 95, 95.5, 94, 94.2),
      bar(M930 + 3, 94.2, 94.5, 93, 93.2),
    ],
    // Whole bar below 100 × 0.96 = 96 → gapped through, fills at that bar's open.
    expect: {
      trades: 1,
      entryPremium: 100,
      exitPremium: 95,
      outcome: "stop",
      profile: "standard",
      exitTimeIst: "09:32",
    },
  },
  {
    // There is no recovery window any more: the dip alone is the exit, even though this same bar
    // trades back to 100 and the one after it would have reached +2.5%.
    name: "standard ladder · a dip through −4% stops out even if it recovers inside the minute",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24000, 24005, 23999, 24004),
      bar(M930 + 1, 24004.5, 24010, 24003, 24009),
      quiet(M930 + 2, 24009),
      quiet(M930 + 3, 24009),
    ],
    option: [
      bar(M930 + 1, 100, 100, 99.4, 99.6),
      // Dips to 95 (−4.52%) then trades back to 100 — the low is read first and takes the trade out.
      bar(M930 + 2, 99.6, 100, 95, 99.8),
      bar(M930 + 3, 99.8, 102, 99.5, 99.8),
    ],
    // −4% of 100 is 96, which the bar crosses rather than gaps, so that is the fill.
    expect: {
      trades: 1,
      entryPremium: 100,
      exitPremium: 96,
      outcome: "stop",
      profile: "standard",
      exitTimeIst: "09:32",
    },
  },
  {
    // PE side: red 4-pt body, momentum minute opens below the close.
    name: "PE side · red body and a lower open take the put",
    spot: [
      quiet(M930 - 1, 24000),
      bar(M930, 24004, 24005, 23999, 24000),
      bar(M930 + 1, 23999.5, 24000, 23990, 23992),
      quiet(M930 + 2, 23992),
    ],
    option: [
      bar(M930 + 1, 80, 80, 79.4, 79.8),
      // +12.5% locks the 12.5% rung, the close slips under it → ladder stop off the ₹80 entry.
      bar(M930 + 2, 79.8, 90, 79.5, 89),
    ],
    contract: PE,
    expect: {
      trades: 1,
      entryPremium: 80,
      // 12.5% locked, price falls back to it → sells 0.1% under, at 80 × 1.124.
      exitPremium: 89.92,
      outcome: "trail-stop",
      profile: "standard",
      exitTimeIst: "09:32",
    },
  },
  {
    name: "RSI filter · high RSI CE in 70–100 band trades",
    rsiFilter: true,
    spot: [
      ...risingBars(M915, 16, 23800),
      bar(M930, 24044, 24050, 24043, 24048),
      bar(M930 + 1, 24048.5, 24055, 24047, 24052),
      quiet(M930 + 2, 24052),
    ],
    option: [
      bar(M930 + 1, 100, 100.5, 99.4, 100.2),
      bar(M930 + 2, 100.2, 105.5, 100, 105.4),
    ],
    expect: { trades: 1, gatePasses: 1, entryPremium: 100, outcome: "trail-stop" },
  },
  {
    name: "RSI filter · low RSI PE in 0–10 band trades",
    rsiFilter: true,
    contract: PE,
    spot: [
      ...fallingBars(M915, 16, 24200),
      bar(M930, 23956, 23960, 23950, 23952),
      bar(M930 + 1, 23951.5, 23952, 23940, 23941),
      quiet(M930 + 2, 23941),
    ],
    option: [bar(M930 + 1, 80, 80.5, 79.4, 79.8)],
    expect: { trades: 1, gatePasses: 1, entryPremium: 80 },
  },
  {
    name: "RSI filter · CE skipped when RSI is outside live bands",
    rsiFilter: true,
    spot: (() => {
      const { bars, price } = chopWarmup(M915);
      return [
        ...bars,
        bar(M930, price, price + 8, price - 1, price + 6),
        bar(M930 + 1, price + 6.5, price + 12, price + 5, price + 11),
        quiet(M930 + 2, price + 11),
      ];
    })(),
    option: [bar(M930 + 1, 100, 100.5, 99.4, 100.2)],
    expect: { trades: 0, gatePasses: 0, skipReason: "rsi-filter" },
  },
  {
    name: "RSI filter · same CE setup trades when the filter is off",
    rsiFilter: false,
    spot: [
      ...risingBars(M915, 16, 23800),
      bar(M930, 24044, 24050, 24043, 24048),
      bar(M930 + 1, 24048.5, 24055, 24047, 24052),
      quiet(M930 + 2, 24052),
    ],
    option: [
      bar(M930 + 1, 100, 100.5, 99.4, 100.2),
      bar(M930 + 2, 100.2, 105.5, 100, 105.4),
    ],
    expect: { trades: 1, gatePasses: 1, entryPremium: 100, outcome: "trail-stop" },
  },
];

let failures = 0;

for (const testCase of cases) {
  const contract = testCase.contract ?? CE;
  const day = await simulateTrapsSession({
    date: "2026-08-26",
    weekday: "Wednesday",
    expiry: "2026-09-01",
    spotBars: testCase.spot,
    contracts: [contract],
    loadOptionBars: async () => testCase.option,
    options: {
      from: "2026-08-26",
      to: "2026-08-26",
      capital: 5_000_000,
      maxLots: TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
      premiumSafetyPct: TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
      minBodyPts: testCase.minBodyPts,
      rsiFilter: testCase.rsiFilter === true,
    },
    warnings: [],
  });

  const problems: string[] = [];
  const expect = testCase.expect;
  const trade = day.trades[0];

  const check = (label: string, actual: unknown, wanted: unknown) => {
    if (wanted !== undefined && actual !== wanted) {
      problems.push(`${label} ${String(actual)} (expected ${String(wanted)})`);
    }
  };

  check("trades", day.trades.length, expect.trades);
  check("gatePasses", day.gatePasses, expect.gatePasses);

  if (expect.trades > 0 && trade) {
    check("entryPremium", trade.entryPremium, expect.entryPremium);
    check("exitPremium", trade.exitPremium, expect.exitPremium);
    check("outcome", trade.outcome, expect.outcome);
    check("profile", trade.exitProfile, expect.profile);
    check("entryTimeIst", trade.entryTimeIst, expect.entryTimeIst);
    check("exitTimeIst", trade.exitTimeIst, expect.exitTimeIst);
  }

  if (expect.skipReason) {
    check("skipReason", day.skips[0]?.reason, expect.skipReason);
  }
  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL  ${testCase.name}`);
    for (const problem of problems) console.log(`        ${problem}`);
    if (trade) {
      console.log(
        `        actual: in ${trade.entryPremium} @${trade.entryTimeIst} → out ${trade.exitPremium} @${trade.exitTimeIst} ${trade.outcome} (${trade.exitProfile}) locked ${trade.lockedPnlPct}%`,
      );
    }
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

// The bot holds one position at a time: a second setup while a trade is live must be ignored.
{
  const spot: DayScalperCandle[] = [
    bar(M930, 24000, 24005, 23999, 24004),
    bar(M930 + 1, 24004.5, 24010, 24003, 24009),
    bar(M930 + 2, 24009, 24016, 24008, 24015),
    bar(M930 + 3, 24015.5, 24020, 24014, 24019),
    quiet(M930 + 4, 24019),
    quiet(M930 + 5, 24019),
  ];
  const option: DayScalperCandle[] = [
    bar(M930 + 1, 100, 100.2, 99.4, 99.8),
    bar(M930 + 2, 99.8, 100.1, 99.2, 99.4),
    bar(M930 + 3, 99.4, 100, 98.5, 99),
    bar(M930 + 4, 99, 108, 99, 100),
    bar(M930 + 5, 100, 100, 100, 100),
  ];

  const day = await simulateTrapsSession({
    date: "2026-08-26",
    weekday: "Wednesday",
    expiry: "2026-09-01",
    spotBars: spot,
    contracts: [CE],
    loadOptionBars: async () => option,
    options: {
      from: "2026-08-26",
      to: "2026-08-26",
      capital: 5_000_000,
      maxLots: TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
      premiumSafetyPct: TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
    },
    warnings: [],
  });

  // 09:30–09:33 are four consecutive setups, but the 09:31 entry runs to 09:34, so the three
  // that gate while it is live must never be taken.
  const overlapping = day.trades.some(
    (trade, i) => i > 0 && trade.entryMins < day.trades[i - 1].exitMins,
  );
  const only = day.trades[0];
  if (day.trades.length !== 1 || overlapping) {
    failures += 1;
    console.log(
      `FAIL  one position at a time — expected 1 trade, got ${day.trades.length}${overlapping ? " (overlapping)" : ""}`,
    );
  } else if (only.entryTimeIst !== "09:31" || only.exitTimeIst !== "09:34") {
    failures += 1;
    console.log(
      `FAIL  one position at a time — expected 09:31→09:34, got ${only.entryTimeIst}→${only.exitTimeIst}`,
    );
  } else {
    console.log("ok    one position at a time (3 setups suppressed while the 09:31 trade ran)");
  }
}

// Sizing must respect the capital, the 25-lot cap and the premium head-room.
{
  const spot: DayScalperCandle[] = [
    bar(M930, 24000, 24005, 23999, 24004),
    bar(M930 + 1, 24004.5, 24010, 24003, 24009),
    quiet(M930 + 2, 24009),
  ];
  const option: DayScalperCandle[] = [
    bar(M930 + 1, 100, 100.2, 99.4, 99.6),
    bar(M930 + 2, 99.6, 99.7, 99.5, 99.6),
  ];

  const day = await simulateTrapsSession({
    date: "2026-08-26",
    weekday: "Wednesday",
    expiry: "2026-09-01",
    spotBars: spot,
    contracts: [CE],
    loadOptionBars: async () => option,
    options: {
      from: "2026-08-26",
      to: "2026-08-26",
      capital: 100_000,
      maxLots: TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
      premiumSafetyPct: TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
    },
    warnings: [],
  });

  // 99.50 × 1.02 × 75 = ₹7,611.75 per lot → 13 lots inside ₹1,00,000.
  const lots = day.trades[0]?.lots;
  if (lots !== 13) {
    failures += 1;
    console.log(`FAIL  sizing — expected 13 lots on ₹1,00,000, got ${lots}`);
  } else {
    console.log("ok    sizing respects capital and the 2% premium head-room");
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Traps backtest checks passed");
