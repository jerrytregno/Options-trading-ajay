/**
 * Unit checks for the Nifty RSI-95 PE backtest (no live Kite).
 *
 * Run: npx tsx scripts/check-nifty-rsi-backtest.ts
 */
import {
  analyzeNiftyRsiDay,
  buildNiftyRsiThresholdSummary,
  isInNiftyRsiTriggerWindow,
  measureNiftyRsiDrawdownAfterTrigger,
  NIFTY_RSI_ENTRY_LEVEL,
  NIFTY_RSI_EXIT_DEADLINE_MINS,
  NIFTY_RSI_THRESHOLDS,
  NIFTY_RSI_TRIGGER_END_MINS,
  NIFTY_RSI_TRIGGER_START_MINS,
  rsiCrossesIntoEntryLevel,
  type NiftyRsiMinuteBar,
} from "../server/nifty-rsi-backtest.js";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? "" : `got ${a}, want ${b}`);
}

function bar(mins: number, close: number, low = close): NiftyRsiMinuteBar {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const time = new Date(`2026-01-02T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000+05:30`);
  return { mins, time, open: close, high: close, low, close };
}

console.log("— RSI 95 entry only —");
eq("entry level is 95", NIFTY_RSI_ENTRY_LEVEL, 95);
eq("only RSI 95 threshold", NIFTY_RSI_THRESHOLDS, [95]);
eq("cross from 94.9 to 95", rsiCrossesIntoEntryLevel(94.9, 95), true);
eq("first valid RSI already at 95 counts", rsiCrossesIntoEntryLevel(null, 95.1), true);
eq("first valid RSI below 95 does not count", rsiCrossesIntoEntryLevel(null, 80), false);
eq("no cross when already above 95", rsiCrossesIntoEntryLevel(96, 97), false);
eq("no cross when still below 95", rsiCrossesIntoEntryLevel(92, 94), false);

console.log("\n— Drawdown / win before 15:00 —");
{
  const candles = [
    bar(10 * 60, 24000),
    bar(10 * 60 + 8, 23985, 23989),
    bar(15 * 60 + 30, 23980),
  ];
  const result = measureNiftyRsiDrawdownAfterTrigger(candles, 0, 24000);
  eq("−10 before 15:00 is a win", result.win, true);
  eq("win exit at 10:08", result.winExitTimeIst, "10:08");

  const lossBars = [
    bar(14 * 60 + 55, 24000),
    bar(15 * 60, 23995, 23999),
    bar(15 * 60 + 2, 23985, 23989),
    bar(15 * 60 + 30, 23980),
  ];
  const loss = measureNiftyRsiDrawdownAfterTrigger(lossBars, 0, 24000);
  eq("−10 only at/after 15:00 is a loss", loss.win, false);
  eq("15:00 bar excluded from win", NIFTY_RSI_EXIT_DEADLINE_MINS, 15 * 60);
}

console.log("\n— Threshold summary —");
{
  const rows = [
    {
      date: "2026-01-02",
      weekday: "Fri",
      threshold: 95 as const,
      timeIst: "10:00",
      triggerPrice: 100,
      triggerRsi: 95.2,
      maxDrawdownPts: 15,
      hit10Pts: true,
      hit20Pts: false,
      hit30Pts: false,
      minutesTo10Pts: 5,
      minutesTo20Pts: null,
      minutesTo30Pts: null,
      sessionClosePrice: 98,
      closeMovePts: -2,
      win: true,
      minutesToWin: 5,
      winExitTimeIst: "10:05",
    },
    {
      date: "2026-01-03",
      weekday: "Mon",
      threshold: 95 as const,
      timeIst: "11:00",
      triggerPrice: 100,
      triggerRsi: 95.5,
      maxDrawdownPts: 5,
      hit10Pts: false,
      hit20Pts: false,
      hit30Pts: false,
      minutesTo10Pts: null,
      minutesTo20Pts: null,
      minutesTo30Pts: null,
      sessionClosePrice: 101,
      closeMovePts: 1,
      win: false,
      minutesToWin: null,
      winExitTimeIst: null,
    },
  ];
  const summary = buildNiftyRsiThresholdSummary(95, rows);
  eq("total entries", summary.totalTriggers, 2);
  eq("win count", summary.winCount, 1);
  eq("loss count", summary.lossCount, 1);
  eq("win pct", summary.winPct, 50);
}

console.log("\n— Entry window 9:20–15:00 —");
eq("9:20 is in window", isInNiftyRsiTriggerWindow(NIFTY_RSI_TRIGGER_START_MINS), true);
eq("15:00 is in window", isInNiftyRsiTriggerWindow(NIFTY_RSI_TRIGGER_END_MINS), true);
eq("9:19 is outside window", isInNiftyRsiTriggerWindow(9 * 60 + 19), false);
eq("15:01 is outside window", isInNiftyRsiTriggerWindow(15 * 60 + 1), false);

console.log("\n— One PE entry when RSI first reaches 95 —");
{
  const candles: NiftyRsiMinuteBar[] = [];
  for (let mins = 9 * 60 + 15; mins <= 9 * 60 + 28; mins += 1) {
    candles.push(bar(mins, 24000));
  }
  candles.push(bar(9 * 60 + 29, 24100));
  for (let mins = 9 * 60 + 30; mins < 15 * 60 + 30; mins += 1) {
    candles.push(bar(mins, 24100, 24085));
  }
  candles.push(bar(15 * 60 + 30, 24090));

  const rows = analyzeNiftyRsiDay("2026-01-02", candles);
  check("finds RSI-95 entry", rows.length === 1);
  check("entry is threshold 95", rows[0]?.threshold === 95);
  check("entry RSI is at or above 95", (rows[0]?.triggerRsi ?? 0) >= 95);
  check("entry at 9:29 spike bar", rows[0]?.timeIst === "09:29");
  check(
    "entry time inside 9:20–15:00",
    rows.every((r) => {
      const [h, m] = r.timeIst.split(":").map(Number);
      const mins = (h ?? 0) * 60 + (m ?? 0);
      return isInNiftyRsiTriggerWindow(mins);
    }),
  );
}

console.log(failures === 0 ? "\nAll Nifty RSI backtest checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
