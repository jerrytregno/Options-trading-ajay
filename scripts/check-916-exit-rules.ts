/**
 * Sanity check for 9:16 index helpers (hard stop removed from live 9:15/9:16 bots).
 *
 * Run: npx tsx scripts/check-916-exit-rules.ts
 */
import {
  activePnlTargetPct,
  activeIndexTargetPoints,
  shouldExitNineSixteen,
  shouldExitOnPnlTarget,
  shouldHardStopNineSixteen,
  hybrid916IndexTargetPoints,
  computeHybrid916IndexExitSpot,
  is916RedConfirmFromCaptures,
  isIn91559WsCloseSecond,
  isIn91600WsOpenSecond,
  isIn91659WsCloseSecond,
  isPast916GreenMinuteRetarget,
  is916MinuteGreenClose,
  NINE_FIFTEEN_WS_CLOSE_59_SEC,
  NINE_SIXTEEN_WS_OPEN_00_SEC,
  NINE_SIXTEEN_HYBRID_INDEX_TARGET_GREEN_MINUTE,
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

// Hard stop: from 10:00 IST, ±30 adverse Nifty from entry spot (both 9:15 and 9:16 legs).
console.log("\n--- 10:00 hard stop (±30 from entry spot) ---");
const cases: [string, number, "CE_BUY" | "PE_BUY", string, boolean][] = [
  ["CE -29 @09:59", 23971, "CE_BUY", "09:59:59", false],
  ["CE -30 @09:59", 23970, "CE_BUY", "09:59:59", false],
  ["CE -30 @10:00", 23970, "CE_BUY", "10:00:00", true],
  ["CE -45 @10:30", 23955, "CE_BUY", "10:30:00", true],
  ["CE +30 @10:30", 24030, "CE_BUY", "10:30:00", false],
  ["PE +30 @10:00", 24030, "PE_BUY", "10:00:00", true],
  ["PE +29 @10:00", 24029, "PE_BUY", "10:00:00", false],
  ["PE -30 @10:00", 23970, "PE_BUY", "10:00:00", false],
  ["CE -70 @14:00", 23930, "CE_BUY", "14:00:00", true],
];
for (const [name, spot, leg, t, want] of cases) {
  const got = shouldHardStopNineSixteen(spot, entrySpot, leg, undefined, wed(t));
  console.log("hard stop", name, "=>", got ? "EXIT" : "hold", got === want ? "ok" : `MISMATCH (want ${want})`);
}

console.log("\n--- hybrid 916 parallel index exit ---");
console.log(
  "91559 sec",
  isIn91559WsCloseSecond(wed("09:15:59.500")),
  !isIn91559WsCloseSecond(wed("09:15:58.500")) ? "ok" : "MISMATCH",
);
console.log(
  "91600 sec",
  isIn91600WsOpenSecond(wed("09:16:00.100")),
  !isIn91600WsOpenSecond(wed("09:16:01.100")) ? "ok" : "MISMATCH",
);
console.log("sec constants", NINE_FIFTEEN_WS_CLOSE_59_SEC, NINE_SIXTEEN_WS_OPEN_00_SEC);
const close91559 = 24_000;
const open916Red = 23_995;
const open916Gap = 24_001;
console.log(
  "red confirm",
  is916RedConfirmFromCaptures(open916Red, close91559),
  hybrid916IndexTargetPoints(open916Red, close91559) === 12 ? "ok" : "MISMATCH",
);
console.log(
  "green gap",
  !is916RedConfirmFromCaptures(open916Gap, close91559),
  hybrid916IndexTargetPoints(open916Gap, close91559) === 8 ? "ok" : "MISMATCH",
);
const entrySpotHybrid = 24_010;
const target12 = computeHybrid916IndexExitSpot(entrySpotHybrid, 12, "PE_BUY");
console.log(
  "PE −12 hit",
  shouldExitNineSixteen(target12, entrySpotHybrid, "PE_BUY", 12) ? "ok" : "MISMATCH",
);
console.log(
  "PE −12 hold",
  !shouldExitNineSixteen(target12 + 0.05, entrySpotHybrid, "PE_BUY", 12) ? "ok" : "MISMATCH",
);
console.log(
  "91659 green minute",
  is916MinuteGreenClose(24_005, 24_000),
  !is916MinuteGreenClose(24_000, 24_000.05) ? "ok" : "MISMATCH",
);
console.log(
  "917 retarget window",
  isPast916GreenMinuteRetarget(wed("09:17:00")),
  !isPast916GreenMinuteRetarget(wed("09:16:59.999")) ? "ok" : "MISMATCH",
);
console.log("green minute target pts", NINE_SIXTEEN_HYBRID_INDEX_TARGET_GREEN_MINUTE);
