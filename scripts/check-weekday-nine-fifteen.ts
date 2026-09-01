/**
 * Weekday averages of the 9:15 candle body must group by the real IST weekday, average over every
 * session (not just signal days), and count the |Δ| ≥ floor days exactly at the boundary.
 *
 * Run: npx tsx scripts/check-weekday-nine-fifteen.ts
 */
import {
  buildWeekdayNineFifteenAverages,
  WEEKDAY_ORDER,
} from "../src/lib/weekday-nine-fifteen.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

const by = (rows: ReturnType<typeof buildWeekdayNineFifteenAverages>, weekday: string) =>
  rows.find((r) => r.weekday === weekday)!;

console.log("\n--- weekday mapping uses the IST calendar date ---");
// 2026-08-24 is a Monday, 25th Tuesday, 26th Wednesday, 27th Thursday, 28th Friday.
const oneEach = buildWeekdayNineFifteenAverages(
  [
    { date: "2026-08-24", change: 10 },
    { date: "2026-08-25", change: 20 },
    { date: "2026-08-26", change: 30 },
    { date: "2026-08-27", change: 40 },
    { date: "2026-08-28", change: 50 },
  ],
  11,
);
check("column order is Mon→Fri", oneEach.map((r) => r.weekday), [...WEEKDAY_ORDER]);
check("each weekday got its row", oneEach.map((r) => r.sessions), [1, 1, 1, 1, 1]);
check("Monday avg", by(oneEach, "Monday").avgAbsChange, 10);
check("Friday avg", by(oneEach, "Friday").avgAbsChange, 50);

console.log("\n--- magnitude ignores direction, bias keeps it ---");
// Two Mondays: +30 and −10. Mean size is 20, mean bias is +10.
const signed = buildWeekdayNineFifteenAverages(
  [
    { date: "2026-08-24", change: 30 },
    { date: "2026-08-17", change: -10 },
  ],
  11,
);
check("avg |Δ| is 20", by(signed, "Monday").avgAbsChange, 20);
check("avg signed bias is +10", by(signed, "Monday").avgSignedChange, 10);
check("both days counted", by(signed, "Monday").sessions, 2);

console.log("\n--- the average spans every session, not only signal days ---");
// Three Tuesdays: 2, 4, 30. A signal-only average would be 30; the true average is 12.
const withQuiet = buildWeekdayNineFifteenAverages(
  [
    { date: "2026-08-25", change: 2 },
    { date: "2026-08-18", change: 4 },
    { date: "2026-08-11", change: 30 },
  ],
  11,
);
check("avg over all three days", by(withQuiet, "Tuesday").avgAbsChange, 12);
check("not the signal-only average", by(withQuiet, "Tuesday").avgAbsChange === 30, false);
check("signal days", by(withQuiet, "Tuesday").signalDays, 1);
check("signal pct", Math.round(by(withQuiet, "Tuesday").signalPct), 33);

console.log("\n--- the floor is inclusive, and negatives count by magnitude ---");
const boundary = buildWeekdayNineFifteenAverages(
  [
    { date: "2026-08-26", change: 11 },
    { date: "2026-08-19", change: -11 },
    { date: "2026-08-12", change: 10.99 },
    { date: "2026-08-05", change: -10.99 },
  ],
  11,
);
check("|Δ| == floor counts, both signs", by(boundary, "Wednesday").signalDays, 2);
check("just under the floor does not", by(boundary, "Wednesday").sessions, 4);

console.log("\n--- empty and dirty input stay safe ---");
const empty = buildWeekdayNineFifteenAverages([], 11);
check("still five columns", empty.length, 5);
check("no divide-by-zero", empty.map((r) => r.avgAbsChange), [0, 0, 0, 0, 0]);
check("no signal pct", empty.map((r) => r.signalPct), [0, 0, 0, 0, 0]);

const dirty = buildWeekdayNineFifteenAverages(
  [
    { date: "2026-08-24", change: 10 },
    { date: "2026-08-17", change: Number.NaN },
    { date: "2026-08-29", change: 99 }, // Saturday — no weekday column
  ],
  11,
);
check("NaN change skipped", by(dirty, "Monday").sessions, 1);
check("weekend row excluded", dirty.reduce((sum, r) => sum + r.sessions, 0), 1);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
