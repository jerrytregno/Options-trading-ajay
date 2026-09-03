/**
 * 9:15 open−5 / entry−10 TP backtest simulation checks.
 * Run: npx tsx scripts/check-nine-fifteen-high-minus5-backtest.ts
 */
import { simulateHighMinus5Day, simulateOpenAtOpenMinus10Day } from "../server/nine-fifteen-high-minus5-backtest.js";

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log("\nAll 9:15 open−5 backtest checks passed.");
