/**
 * 9:16 second-candle color confirm for backtests.
 * Run: npx tsx scripts/check-red-pe-916-confirm.ts
 */
import {
  is916GreenConfirmOpen,
  is916RedConfirmOpen,
  is916SameColorConfirmOpen,
} from "../server/nine-fifteen-candles.js";
import type { NineFifteenCandleRow } from "../src/types/nine-fifteen.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} · ${label}${ok ? "" : ` · got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

function row(overrides: Partial<NineFifteenCandleRow>): NineFifteenCandleRow {
  return {
    date: "2026-01-02",
    open: 100,
    close: 85,
    high: 101,
    low: 84,
    change: -15,
    changePct: -15,
    direction: "down",
    maxGainFromOpen: 1,
    maxLossFromOpen: 16,
    gainLevels: {} as NineFifteenCandleRow["gainLevels"],
    lossLevels: {} as NineFifteenCandleRow["lossLevels"],
    sessionHigh: 101,
    sessionLow: 80,
    maxDayUpFrom915: 1,
    maxDayDownFrom915: 20,
    dayUpLevels: {} as NineFifteenCandleRow["dayUpLevels"],
    dayDownLevels: {} as NineFifteenCandleRow["dayDownLevels"],
    checkpoints: {} as NineFifteenCandleRow["checkpoints"],
    entryAtLive916: { indexPrice: 84.8, timeIst: "09:16:00" },
    ...overrides,
  };
}

check(
  "PE confirm when 9:16 open equals 9:15 close",
  is916RedConfirmOpen(row({ close: 23960, entryAtLive916: { indexPrice: 23960, timeIst: "09:16:00" } })),
  true,
);
check(
  "PE reject when 9:16 gaps above 9:15 close",
  is916RedConfirmOpen(row({ close: 23960, entryAtLive916: { indexPrice: 23960.05, timeIst: "09:16:00" } })),
  false,
);
check(
  "CE confirm when 9:16 open equals 9:15 close",
  is916GreenConfirmOpen(row({ close: 24020, direction: "up", entryAtLive916: { indexPrice: 24020, timeIst: "09:16:00" } })),
  true,
);
check(
  "CE reject when 9:16 gaps below 9:15 close",
  is916GreenConfirmOpen(row({ close: 24020, direction: "up", entryAtLive916: { indexPrice: 24019.95, timeIst: "09:16:00" } })),
  false,
);
check(
  "mixed confirm uses direction — down PE",
  is916SameColorConfirmOpen(row({ direction: "down", close: 23960, entryAtLive916: { indexPrice: 23960, timeIst: "09:16:00" } })),
  true,
);
check(
  "mixed confirm uses direction — up CE",
  is916SameColorConfirmOpen(row({ direction: "up", close: 24020, entryAtLive916: { indexPrice: 24020, timeIst: "09:16:00" } })),
  true,
);
check(
  "reject when 9:16 entry missing",
  is916SameColorConfirmOpen(row({ entryAtLive916: null })),
  false,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
