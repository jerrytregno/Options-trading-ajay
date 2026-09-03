/**
 * Momentum scalper: manual-only arm, entry-window schedule, default sizing (25 lots).
 *
 * Run: npx tsx scripts/check-bots-start-disabled.ts
 */
import fs from "fs";
import path from "path";
import { getIndianMarketContext, formatWeekdayFromDateKey } from "../src/lib/market-time.js";
import {
  applyMomentumDailySchedule,
  getMomentumScalperBotStatus,
  momentumInScheduledWindow,
  setMomentumScalperBotEnabled,
  startMomentumScalperBot,
} from "../server/momentum-scalper-bot.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** Wednesday 2026-08-26 at the given IST hh:mm. */
function istMs(hour: number, minute: number): number {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`2026-08-26T${hh}:${mm}:00+05:30`).getTime();
}

const DATE_IST = "2026-08-26";
const WEEKDAY = "Wednesday";
const TODAY_IST = getIndianMarketContext().dateIST;

console.log("\n--- schedule window boundaries (after 9:16:30 – 15:30) ---");
check("09:15 outside window", momentumInScheduledWindow(9 * 60 + 15), false);
check("09:16 inside minute window", momentumInScheduledWindow(9 * 60 + 16), true);
check("10:30 inside window", momentumInScheduledWindow(10 * 60 + 30), true);
check("12:00 inside window (no lunch gap)", momentumInScheduledWindow(12 * 60), true);
check("13:45 inside window", momentumInScheduledWindow(13 * 60 + 45), true);
check("15:29 inside window", momentumInScheduledWindow(15 * 60 + 29), true);
check("15:30 outside window", momentumInScheduledWindow(15 * 60 + 30), false);

console.log("\n--- fresh module load ---");
check("momentum disabled by default", getMomentumScalperBotStatus().enabled, false);
check("default max lots", getMomentumScalperBotStatus().maxLots, 25);

console.log("\n--- startup does not auto-arm ---");
setMomentumScalperBotEnabled(false);
startMomentumScalperBot();
applyMomentumDailySchedule(DATE_IST, WEEKDAY, istMs(8, 30));
check("still disabled pre-09:16", getMomentumScalperBotStatus().enabled, false);

console.log("\n--- schedule ticks never toggle enabled ---");
applyMomentumDailySchedule(DATE_IST, WEEKDAY, istMs(9, 16));
check("09:16 schedule does not enable", getMomentumScalperBotStatus().enabled, false);
setMomentumScalperBotEnabled(true);
check("manual enable at 09:16", getMomentumScalperBotStatus().enabled, true);
applyMomentumDailySchedule(DATE_IST, WEEKDAY, istMs(12, 0));
check("12:00 schedule does not disable", getMomentumScalperBotStatus().enabled, true);
applyMomentumDailySchedule(DATE_IST, WEEKDAY, istMs(13, 45));
check("13:45 schedule does not change enabled", getMomentumScalperBotStatus().enabled, true);
applyMomentumDailySchedule(DATE_IST, WEEKDAY, istMs(15, 30));
check("15:30 schedule does not disable", getMomentumScalperBotStatus().enabled, true);
setMomentumScalperBotEnabled(false);

console.log("\n--- no persisted flag can re-arm the bot ---");
const stateDir = path.join(process.cwd(), "data");
for (const [name, file] of [["momentum", "momentum-scalper-state.json"]] as const) {
  const full = path.join(stateDir, file);
  const raw = fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : null;
  check(`${name} state file carries no enabled flag`, raw == null || !/"enabled"\s*:/.test(raw), true);
}

console.log("\n--- loss day — manual enable blocked ---");
const ranFile = path.join(stateDir, `momentum-scalper-ran-${TODAY_IST}.json`);
fs.writeFileSync(
  ranFile,
  JSON.stringify({ dateIST: TODAY_IST, at: new Date().toISOString(), reason: "loss" }),
);
setMomentumScalperBotEnabled(false);
applyMomentumDailySchedule(TODAY_IST, formatWeekdayFromDateKey(TODAY_IST), istMs(13, 45));
check("loss day — schedule does not enable", getMomentumScalperBotStatus().enabled, false);
setMomentumScalperBotEnabled(true);
check("loss day — manual enable blocked", getMomentumScalperBotStatus().enabled, false);
try {
  fs.unlinkSync(ranFile);
} catch {
  /* ignore */
}

console.log("\n--- only an explicit boolean true arms a bot (toggle route semantics) ---");
for (const value of ["false", "0", 1, {}, [], "true"]) {
  check(`payload ${JSON.stringify(value)} arms`, (value as unknown) === true, false);
}
check("payload true arms", (true as unknown) === true, true);

console.log("\n--- manual enable / disable ---");
setMomentumScalperBotEnabled(false);
check("manual disable", getMomentumScalperBotStatus().enabled, false);
setMomentumScalperBotEnabled(true);
check("manual enable", getMomentumScalperBotStatus().enabled, true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
