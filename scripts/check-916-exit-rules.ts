/**
 * Manual sanity check for legacy 9:16 index / hard-stop helpers (no longer used live).
 * Live 9:16 exits are trailing option P&L only (+ check-916-trailing if added).
 *
 * Run: npx tsx scripts/check-916-exit-rules.ts
 */
import {
  activePnlTargetPct,
  activeIndexTargetPoints,
  shouldExitNineSixteen,
  shouldExitOnPnlTarget,
  shouldHardStopNineSixteen,
  isTuesdayIst,
  getIndexExitScheduleLabel,
  getPnlExitScheduleLabel,
} from "../server/nine-sixteen-logic.js";

// 2026-08-18 is a Tuesday, 2026-08-19 a Wednesday.
const tue = (t: string) => new Date(`2026-08-18T${t}+05:30`).getTime();
const wed = (t: string) => new Date(`2026-08-19T${t}+05:30`).getTime();

console.log("isTuesdayIst tue/wed:", isTuesdayIst(tue("09:16:00")), isTuesdayIst(wed("09:16:00")));
for (const t of ["09:15:59", "09:16:00", "10:30:00", "11:30:00", "13:00:00", "15:20:00"]) {
  console.log(`pnl pct ${t} — tue:`, activePnlTargetPct(tue(t)), "wed:", activePnlTargetPct(wed(t)));
}
console.log("label tue:", getPnlExitScheduleLabel(tue("10:00:00")));
console.log("label wed:", getPnlExitScheduleLabel(wed("10:00:00")));
// Tuesday P&L target must be exactly +5% through 10:00 and +1% from 10:01.
const tuePnlCases: [string, number | null][] = [
  ["09:15:59", null],
  ["09:16:00", 5],
  ["10:00:59", 5],
  ["10:01:00", 1],
  ["15:20:00", 1],
];
for (const [t, want] of tuePnlCases) {
  const got = activePnlTargetPct(tue(t));
  console.log("tue pnl target", t, "=>", got, got === want ? "ok" : `MISMATCH (want ${want})`);
}

for (const t of ["09:16:00", "10:30:00", "11:30:00", "14:00:00"]) {
  console.log(
    `index pts ${t} — tue main/near:`,
    activeIndexTargetPoints("main", tue(t)),
    activeIndexTargetPoints("near_miss", tue(t)),
    "| wed main/near:",
    activeIndexTargetPoints("main", wed(t)),
    activeIndexTargetPoints("near_miss", wed(t)),
  );
}
console.log("index label:", getIndexExitScheduleLabel("main"));

// Tuesday index bands are now identical to every other weekday.
const entrySpot = 24000;
const tueTargets: [string, number, "CE_BUY" | "PE_BUY", boolean][] = [
  ["CE +24 tue @09:20", 24024, "CE_BUY", false],
  ["CE +25 tue @09:20", 24025, "CE_BUY", true],
  ["CE +10 tue @09:20", 24010, "CE_BUY", false],
  ["PE -25 tue @09:20", 23975, "PE_BUY", true],
];
for (const [name, spot, leg, want] of tueTargets) {
  const at = tue("09:20:00");
  const got = shouldExitNineSixteen(spot, entrySpot, leg, activeIndexTargetPoints("main", at));
  console.log("tue index exit", name, "=>", got, got === want ? "ok" : "MISMATCH");
}

// Tuesday P&L exit: +5% before 10:01, +1% after — the trade closes the moment it prints.
const entryPrem = 100;
const qty = 500;
const pnlCases: [string, string, number, boolean][] = [
  ["+4% @09:30", "09:30:00", 2000, false],
  ["+5% @09:30", "09:30:00", 2500, true],
  ["+1% @09:30", "09:30:00", 500, false],
  ["+1% @10:01", "10:01:00", 500, true],
  ["+0.9% @10:01", "10:01:00", 450, false],
  ["+1% @14:00", "14:00:00", 500, true],
];
for (const [name, t, pnl, want] of pnlCases) {
  const pct = activePnlTargetPct(tue(t));
  const got = pct != null && shouldExitOnPnlTarget(pnl, entryPrem, qty, pct);
  console.log(
    "tue pnl exit",
    name,
    `target=+${pct}%`,
    "=>",
    got ? "EXIT" : "hold",
    got === want ? "ok" : "MISMATCH",
  );
}

// Hard stop: ±30 from the fill spot, scanning only from 9:55 IST.
const cases: [string, number, "CE_BUY" | "PE_BUY", string, boolean][] = [
  ["CE -29 @09:55", 23971, "CE_BUY", "09:55:00", false],
  ["CE -30 @09:54", 23970, "CE_BUY", "09:54:59", false],
  ["CE -30 @09:55", 23970, "CE_BUY", "09:55:00", true],
  ["CE -45 @10:30", 23955, "CE_BUY", "10:30:00", true],
  ["CE +30 @10:30", 24030, "CE_BUY", "10:30:00", false],
  ["PE +30 @09:55", 24030, "PE_BUY", "09:55:00", true],
  ["PE +29 @09:55", 24029, "PE_BUY", "09:55:00", false],
  ["PE -30 @09:55", 23970, "PE_BUY", "09:55:00", false],
  ["CE -70 @14:00", 23930, "CE_BUY", "14:00:00", true],
];
for (const [name, spot, leg, t, want] of cases) {
  const got = shouldHardStopNineSixteen(spot, entrySpot, leg, undefined, wed(t));
  console.log("hard stop", name, "=>", got ? "EXIT" : "hold", got === want ? "ok" : `MISMATCH (want ${want})`);
}
