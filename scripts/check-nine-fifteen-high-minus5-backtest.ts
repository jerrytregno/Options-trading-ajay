/**
 * 9:15 open−5 / entry−10 TP backtest simulation checks.
 * Run: npx tsx scripts/check-nine-fifteen-high-minus5-backtest.ts
 */
import {
  simulateHighMinus5Day,
  simulateHighPlus5Day,
  simulateOpenAtOpenMinus10Day,
  buildOpenOffsetFromMinuteMap,
  isSmallGreen915Body,
  isSmallRed915Body,
  maxRallyBefore10FromOpen,
  maxSelloffBefore10FromOpen,
  PRE10_RALLY_FROM_OPEN_PTS,
  PRE10_SELLOFF_FROM_OPEN_PTS,
  NIFTY_OPEN_OFFSET_SESSION,
} from "../server/nine-fifteen-high-minus5-backtest.js";
import {
  simulateFullDayOpenMinus5,
  simulateFullDayOpenPlus5,
} from "../server/nine-fifteen-full-day-backtest.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok" : "FAIL"} · ${label}${ok ? "" : ` · got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

check(
  "win when TP prints inside the 9:15 minute",
  simulateHighMinus5Day(
    "2026-01-02",
    { open: 100, high: 110, low: 84, close: 90 },
    [{ mins: 9 * 60 + 15, low: 84 }],
  ).outcome,
  "win",
);

check(
  "late win when TP prints after 9:16",
  simulateHighMinus5Day(
    "2026-01-03",
    { open: 100, high: 110, low: 94, close: 98 },
    [
      { mins: 9 * 60 + 15, low: 94 },
      { mins: 9 * 60 + 16, low: 93 },
      { mins: 9 * 60 + 17, low: 84 },
    ],
  ).outcome,
  "late_win",
);

check(
  "loss when entry fills but TP never hits",
  simulateHighMinus5Day(
    "2026-01-04",
    { open: 100, high: 110, low: 94, close: 97 },
    [
      { mins: 9 * 60 + 15, low: 94 },
      { mins: 9 * 60 + 16, low: 90 },
    ],
  ).outcome,
  "loss",
);

check(
  "no entry when open − 5 is never touched",
  simulateHighMinus5Day(
    "2026-01-05",
    { open: 100, high: 110, low: 96, close: 99 },
    [{ mins: 9 * 60 + 15, low: 96 }],
  ).outcome,
  "no_entry",
);

check(
  "entry level is open − 5",
  simulateHighMinus5Day("2026-01-06", { open: 24000, high: 24050, low: 24000, close: 24010 }, []).entryLevel,
  23995,
);

check(
  "TP level is entry − 10",
  simulateHighMinus5Day("2026-01-06", { open: 24000, high: 24050, low: 24000, close: 24010 }, []).tpLevel,
  23985,
);

check("red candle is close below open", 24010 < 24000, false);
check("red candle is close below open (down day)", 23990 < 24000, true);

check(
  "green win when TP prints inside the 9:15 minute",
  simulateHighPlus5Day(
    "2026-01-02",
    { open: 100, high: 116, low: 98, close: 105 },
    [{ mins: 9 * 60 + 15, high: 116 }],
  ).outcome,
  "win",
);

check(
  "green late win when TP prints after 9:16",
  simulateHighPlus5Day(
    "2026-01-03",
    { open: 100, high: 106, low: 98, close: 105 },
    [
      { mins: 9 * 60 + 15, high: 106 },
      { mins: 9 * 60 + 16, high: 110 },
      { mins: 9 * 60 + 17, high: 116 },
    ],
  ).outcome,
  "late_win",
);

check(
  "green loss when entry fills but TP never hits",
  simulateHighPlus5Day(
    "2026-01-04",
    { open: 100, high: 106, low: 98, close: 105 },
    [
      { mins: 9 * 60 + 15, high: 106 },
      { mins: 9 * 60 + 16, high: 112 },
    ],
  ).outcome,
  "loss",
);

check(
  "green no entry when open + 5 is never touched",
  simulateHighPlus5Day(
    "2026-01-05",
    { open: 100, high: 104, low: 98, close: 105 },
    [{ mins: 9 * 60 + 15, high: 104 }],
  ).outcome,
  "no_entry",
);

check(
  "green entry level is open + 5",
  simulateHighPlus5Day("2026-01-06", { open: 24000, high: 24050, low: 24000, close: 24010 }, []).entryLevel,
  24005,
);

check(
  "green TP level is entry + 10",
  simulateHighPlus5Day("2026-01-06", { open: 24000, high: 24050, low: 24000, close: 24010 }, []).tpLevel,
  24015,
);

check(
  "open-at-open win when TP prints inside the 9:15 minute",
  simulateOpenAtOpenMinus10Day(
    "2026-02-01",
    { open: 100, high: 105, low: 89, close: 92 },
    [{ mins: 9 * 60 + 15, low: 89 }],
  ).outcome,
  "win",
);

check(
  "open-at-open late win when TP prints after 9:16",
  simulateOpenAtOpenMinus10Day(
    "2026-02-02",
    { open: 100, high: 105, low: 99, close: 101 },
    [
      { mins: 9 * 60 + 15, low: 99 },
      { mins: 9 * 60 + 17, low: 89 },
    ],
  ).outcome,
  "late_win",
);

check(
  "open-at-open loss when TP never hits",
  simulateOpenAtOpenMinus10Day(
    "2026-02-03",
    { open: 100, high: 105, low: 95, close: 98 },
    [
      { mins: 9 * 60 + 15, low: 95 },
      { mins: 9 * 60 + 16, low: 92 },
    ],
  ).outcome,
  "loss",
);

check(
  "open-at-open entry is the 9:15 open",
  simulateOpenAtOpenMinus10Day("2026-02-04", { open: 24000, high: 24050, low: 23990, close: 24010 }, [])
    .entryLevel,
  24000,
);

check(
  "open-at-open TP is open − 10",
  simulateOpenAtOpenMinus10Day("2026-02-04", { open: 24000, high: 24050, low: 23990, close: 24010 }, [])
    .tpLevel,
  23990,
);

check(
  "open-at-open always enters at 9:15",
  simulateOpenAtOpenMinus10Day("2026-02-05", { open: 100, high: 110, low: 100, close: 105 }, []).entryTimeIst,
  "09:15:00",
);

const signal920 = 9 * 60 + 20;

check(
  "full-day red win when TP in signal minute",
  simulateFullDayOpenMinus5(
    "2026-03-01",
    { mins: signal920, open: 100, high: 110, low: 84, close: 98 },
    [{ mins: signal920, low: 84 }],
  ).outcome,
  "win",
);

check(
  "full-day red late win after signal minute",
  simulateFullDayOpenMinus5(
    "2026-03-02",
    { mins: signal920, open: 100, high: 110, low: 94, close: 98 },
    [
      { mins: signal920, low: 94 },
      { mins: signal920 + 5, low: 84 },
    ],
  ).outcome,
  "late_win",
);

check(
  "full-day green win when TP in signal minute",
  simulateFullDayOpenPlus5(
    "2026-03-03",
    { mins: 10 * 60, open: 100, high: 116, low: 98, close: 105 },
    [{ mins: 10 * 60, high: 116 }],
  ).outcome,
  "win",
);

check(
  "full-day signal time on trade row",
  simulateFullDayOpenMinus5(
    "2026-03-04",
    { mins: signal920, open: 100, high: 110, low: 96, close: 98 },
    [],
  ).signalTimeIst,
  "09:20:00",
);

check(
  "full-day red TP is entry − 5",
  simulateFullDayOpenMinus5("2026-03-05", { mins: signal920, open: 100, high: 110, low: 96, close: 98 }, [])
    .tpLevel,
  90,
);

check(
  "full-day green TP is entry + 5",
  simulateFullDayOpenPlus5("2026-03-05", { mins: 10 * 60, open: 100, high: 110, low: 98, close: 105 }, [])
    .tpLevel,
  110,
);

console.log("\n--- small green + pre-10 rally study ---");
check("small green body at +5", isSmallGreen915Body({ open: 100, close: 105 }), true);
check("small green body at +3", isSmallGreen915Body({ open: 100, close: 103 }), true);
check("not small green when +6", isSmallGreen915Body({ open: 100, close: 106 }), false);
check("not small green when red", isSmallGreen915Body({ open: 100, close: 99 }), false);

{
  const rally = maxRallyBefore10FromOpen(100, [
    { mins: 9 * 60 + 15, high: 105 },
    { mins: 9 * 60 + 20, high: 121 },
    { mins: 10 * 60, high: 130 },
  ]);
  check("pre-10 rally ignores 10:00 bar", rally.maxRallyPts, 21);
  check("pre-10 rally qualifies at +20", rally.maxRallyPts >= PRE10_RALLY_FROM_OPEN_PTS, true);
}

{
  const byDate = new Map([
    [
      "2026-03-10",
      [
        { mins: 9 * 60 + 15, time: new Date(), open: 100, high: 105, low: 99, close: 105 },
        { mins: 9 * 60 + 16, time: new Date(), open: 105, high: 106, low: 104, close: 105 },
        { mins: 9 * 60 + 20, time: new Date(), open: 105, high: 121, low: 105, close: 120 },
        { mins: 9 * 60 + 21, time: new Date(), open: 120, high: 121, low: 119, close: 121 },
        { mins: 9 * 60 + 22, time: new Date(), open: 121, high: 122, low: 120, close: 121 },
      ],
    ],
  ]);
  for (let m = 9 * 60 + 23; m <= 15 * 60 + 30; m += 1) {
    byDate.get("2026-03-10")!.push({
      mins: m,
      time: new Date(),
      open: 121,
      high: 121,
      low: 121,
      close: 121,
    });
  }
  const built = buildOpenOffsetFromMinuteMap(byDate, 1, NIFTY_OPEN_OFFSET_SESSION, "red_green_only");
  check("study slice present", built.smallGreenPre10Rally != null, true);
  check("one matching day", built.smallGreenPre10Rally?.matchingDays, 1);
  check("matching trade late win", built.smallGreenPre10Rally?.trades[0]?.outcome, "late_win");
  check("pre-10 rally stored", built.smallGreenPre10Rally?.trades[0]?.pre10MaxRallyPts, 22);
}

console.log("\n--- small red + pre-10 selloff study ---");
check("small red body at -5", isSmallRed915Body({ open: 100, close: 95 }), true);
check("small red body at -3", isSmallRed915Body({ open: 100, close: 97 }), true);
check("not small red when -6", isSmallRed915Body({ open: 100, close: 94 }), false);
check("not small red when green", isSmallRed915Body({ open: 100, close: 101 }), false);

{
  const selloff = maxSelloffBefore10FromOpen(100, [
    { mins: 9 * 60 + 15, low: 95 },
    { mins: 9 * 60 + 20, low: 79 },
    { mins: 10 * 60, low: 70 },
  ]);
  check("pre-10 selloff ignores 10:00 bar", selloff.maxSelloffPts, 21);
  check("pre-10 selloff qualifies at -20", selloff.maxSelloffPts >= PRE10_SELLOFF_FROM_OPEN_PTS, true);
}

{
  const byDate = new Map([
    [
      "2026-03-11",
      [
        { mins: 9 * 60 + 15, time: new Date(), open: 100, high: 101, low: 95, close: 95 },
        { mins: 9 * 60 + 16, time: new Date(), open: 95, high: 96, low: 94, close: 95 },
        { mins: 9 * 60 + 20, time: new Date(), open: 95, high: 96, low: 79, close: 80 },
        { mins: 9 * 60 + 21, time: new Date(), open: 80, high: 81, low: 79, close: 80 },
        { mins: 9 * 60 + 22, time: new Date(), open: 80, high: 81, low: 79, close: 80 },
      ],
    ],
  ]);
  for (let m = 9 * 60 + 23; m <= 15 * 60 + 30; m += 1) {
    byDate.get("2026-03-11")!.push({
      mins: m,
      time: new Date(),
      open: 80,
      high: 81,
      low: 79,
      close: 80,
    });
  }
  const built = buildOpenOffsetFromMinuteMap(byDate, 1, NIFTY_OPEN_OFFSET_SESSION, "red_green_only");
  check("red study slice present", built.smallRedPre10Selloff != null, true);
  check("one matching red day", built.smallRedPre10Selloff?.matchingDays, 1);
  check("matching red trade late win", built.smallRedPre10Selloff?.trades[0]?.outcome, "late_win");
  check("pre-10 selloff stored", built.smallRedPre10Selloff?.trades[0]?.pre10MaxSelloffPts, 21);
}

console.log("\n--- TP only from 9:16 (entry still on 9:15) ---");
check(
  "TP in 9:15 ignored when earliest TP is 9:16",
  simulateHighPlus5Day(
    "2026-03-11",
    { open: 100, high: 120, low: 99, close: 105 },
    [{ mins: 9 * 60 + 15, high: 120 }],
    NIFTY_OPEN_OFFSET_SESSION,
    { tpEarliestMins: 9 * 60 + 16 },
  ).outcome,
  "loss",
);
check(
  "TP from 9:16 counts as late win",
  simulateHighPlus5Day(
    "2026-03-12",
    { open: 100, high: 105, low: 99, close: 105 },
    [
      { mins: 9 * 60 + 15, high: 105 },
      { mins: 9 * 60 + 16, high: 116 },
    ],
    NIFTY_OPEN_OFFSET_SESSION,
    { tpEarliestMins: 9 * 60 + 16 },
  ).outcome,
  "late_win",
);
check(
  "entry still fills on 9:15",
  simulateHighPlus5Day(
    "2026-03-12",
    { open: 100, high: 105, low: 99, close: 105 },
    [
      { mins: 9 * 60 + 15, high: 105 },
      { mins: 9 * 60 + 16, high: 116 },
    ],
    NIFTY_OPEN_OFFSET_SESSION,
    { tpEarliestMins: 9 * 60 + 16 },
  ).entryTimeIst,
  "09:15:00",
);
check(
  "red TP in 9:15 ignored when earliest TP is 9:16",
  simulateHighMinus5Day(
    "2026-03-13",
    { open: 100, high: 101, low: 80, close: 95 },
    [{ mins: 9 * 60 + 15, low: 80 }],
    NIFTY_OPEN_OFFSET_SESSION,
    { tpEarliestMins: 9 * 60 + 16 },
  ).outcome,
  "loss",
);
check(
  "red TP from 9:16 counts as late win",
  simulateHighMinus5Day(
    "2026-03-14",
    { open: 100, high: 101, low: 94, close: 95 },
    [
      { mins: 9 * 60 + 15, low: 94 },
      { mins: 9 * 60 + 16, low: 84 },
    ],
    NIFTY_OPEN_OFFSET_SESSION,
    { tpEarliestMins: 9 * 60 + 16 },
  ).outcome,
  "late_win",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log("\nAll 9:15 open±5 backtest checks passed.");
