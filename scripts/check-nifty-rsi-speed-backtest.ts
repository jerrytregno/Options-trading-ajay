/**
 * RSI Speed-O-Meter backtest checks (no live Kite).
 *
 * Run: npx tsx scripts/check-nifty-rsi-speed-backtest.ts
 */
import {
  analyzeNiftyRsiSpeedDay,
  buildNiftyRsiSpeedBandSummary,
  measureNiftyRsiSpeedOutcomeAfterTrigger,
  requiredRsiJumpForBand,
  rsiSpeedBandTriggered,
  RSI_SPEED_BANDS,
  RSI_SPEED_CE_BANDS,
  RSI_SPEED_PE_BANDS,
} from "../server/nifty-rsi-speed-backtest.js";
import type { NiftyRsiMinuteBar } from "../server/nifty-rsi-backtest.js";

let failures = 0;

function check(label: string, ok: boolean) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected));
}

function bar(mins: number, close: number, high = close, low = close): NiftyRsiMinuteBar {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const time = new Date(`2026-01-02T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000+05:30`);
  return { mins, time, open: close, high, low, close };
}

function band(id: (typeof RSI_SPEED_BANDS)[number]["id"]) {
  return RSI_SPEED_BANDS.find((b) => b.id === id)!;
}

eq("twelve bands total", RSI_SPEED_BANDS.length, 12);
eq("six CE bands", RSI_SPEED_CE_BANDS.length, 6);
eq("six PE bands", RSI_SPEED_PE_BANDS.length, 6);
eq("10→40 span is 30", requiredRsiJumpForBand(band("10_to_40")), 30);
eq("90→60 span is 30", requiredRsiJumpForBand(band("90_to_60")), 30);

check("CE 10→20 triggers", rsiSpeedBandTriggered(12, 24, band("10_to_20")));
check("CE 10→20 rejects +8", !rsiSpeedBandTriggered(12, 20, band("10_to_20")));
check("PE 90→80 triggers", rsiSpeedBandTriggered(88, 78, band("90_to_80")));
check("PE 90→80 rejects −8", !rsiSpeedBandTriggered(88, 80, band("90_to_80")));
check("PE 90→60 triggers on −30", rsiSpeedBandTriggered(88, 58, band("90_to_60")));
check("PE 90→60 rejects −20", !rsiSpeedBandTriggered(88, 68, band("90_to_60")));

{
  const ceWin = measureNiftyRsiSpeedOutcomeAfterTrigger(
    [bar(10 * 60, 24000), bar(10 * 60 + 5, 24020, 24015), bar(15 * 60 + 30, 24025)],
    0,
    24000,
    band("10_to_20"),
  );
  eq("CE +10 before 15:00 is win", ceWin.win, true);

  const peWin = measureNiftyRsiSpeedOutcomeAfterTrigger(
    [bar(10 * 60, 24000), bar(10 * 60 + 5, 23980, 23989), bar(15 * 60 + 30, 23975)],
    0,
    24000,
    band("90_to_80"),
  );
  eq("PE −10 before 15:00 is win", peWin.win, true);
}

{
  const flat: NiftyRsiMinuteBar[] = [];
  for (let mins = 9 * 60 + 15; mins <= 15 * 60 + 30; mins += 1) {
    flat.push(bar(mins, 24000));
  }
  check("flat session has no entries", analyzeNiftyRsiSpeedDay("2026-01-02", flat).length === 0);
}

{
  const rows = [
    {
      date: "2026-01-02",
      weekday: "Fri",
      bandId: "90_to_80" as const,
      bandLabel: "90 → 80",
      tradeLeg: "PE_BUY" as const,
      direction: "down" as const,
      timeIst: "10:15",
      triggerPrice: 24000,
      prevRsi: 88,
      triggerRsi: 78,
      rsiDelta: -10,
      maxFavorablePts: 15,
      win: true,
      minutesToWin: 8,
      winExitTimeIst: "10:23",
      sessionClosePrice: 23980,
      closeMovePts: -20,
    },
  ];
  const summary = buildNiftyRsiSpeedBandSummary(band("90_to_80"), rows);
  eq("PE summary win count", summary.winCount, 1);
}

console.log(failures === 0 ? "\nAll RSI Speed-O-Meter checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
