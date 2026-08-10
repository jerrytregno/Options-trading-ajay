/**
 * Exploratory stats on 9:15 follow-filter days (|Δ|≥15) from a saved API payload:
 *   node scripts/analyze-follow-gap-patterns.mjs path/to/nine-fifteen-response.json
 *
 * Expects `{ data: NineFifteenCandlesResult }` or raw result with rows + cePeGuide.followDirection successes/failures.
 */
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/analyze-follow-gap-patterns.mjs <json-file>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(path, "utf8"));
const data = raw.data ?? raw;
const rows = data.rows ?? [];
const follow = data.cePeGuide?.followDirection;
if (!follow?.failures && !follow?.successes) {
  console.error("Missing cePeGuide.followDirection successes/failures — re-export from live backtest API.");
  process.exit(1);
}

const trades = [
  ...(follow.successes ?? []).map((t) => ({ ...t, outcome: "win" })),
  ...(follow.failures ?? []).map((t) => ({ ...t, outcome: "loss" })),
];

function gapAligns(t) {
  if (t.gapFromPrevCloseDirection == null || t.gapFromPrevCloseDirection === "flat") return "flat";
  const bar = t.direction;
  if (bar === "flat") return "flat";
  return t.gapFromPrevCloseDirection === bar ? "aligned" : "opposed";
}

function weekday(date) {
  const d = new Date(`${date}T12:00:00+05:30`);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" }).format(d);
}

function bucketAbsGap(g) {
  if (g == null) return "unknown";
  const a = Math.abs(g);
  if (a < 30) return "<30";
  if (a < 80) return "30–79";
  if (a < 150) return "80–149";
  return "150+";
}

function summarize(label, subset) {
  const n = subset.length;
  if (n === 0) return { label, n, winPct: null };
  const wins = subset.filter((t) => t.outcome === "win").length;
  return { label, n, wins, losses: n - wins, winPct: ((wins / n) * 100).toFixed(1) + "%" };
}

function countBy(keyFn, list) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

console.log("Follow ±30 trades:", trades.length, "wins:", trades.filter((t) => t.outcome === "win").length);

for (const [label, fn] of [
  ["Gap vs 9:15 bar — aligned", (t) => gapAligns(t) === "aligned"],
  ["Gap vs 9:15 bar — opposed", (t) => gapAligns(t) === "opposed"],
  ["Gap vs 9:15 bar — flat/unknown", (t) => gapAligns(t) === "flat" || gapAligns(t) === "unknown"],
  ["|overnight gap| < 30 pts", (t) => t.gapFromPrevClose != null && Math.abs(t.gapFromPrevClose) < 30],
  ["|overnight gap| 30–79", (t) => Math.abs(t.gapFromPrevClose ?? 0) >= 30 && Math.abs(t.gapFromPrevClose ?? 0) < 80],
  ["|overnight gap| 80–149", (t) => Math.abs(t.gapFromPrevClose ?? 0) >= 80 && Math.abs(t.gapFromPrevClose ?? 0) < 150],
  ["|overnight gap| ≥ 150", (t) => Math.abs(t.gapFromPrevClose ?? 0) >= 150],
  ["|9:15 bar Δ| ≥ 40", (t) => Math.abs(t.change) >= 40],
  ["|9:15 bar Δ| ≥ 70", (t) => Math.abs(t.change) >= 70],
]) {
  console.log(summarize(label, trades.filter(fn)));
}

console.log("\nWin rate by gap alignment:");
for (const align of ["aligned", "opposed", "flat"]) {
  console.log(summarize(align, trades.filter((t) => gapAligns(t) === align)));
}

console.log("\nWin rate by weekday (all trades):");
const byDay = new Map();
for (const t of trades) {
  const w = weekday(t.date);
  if (!byDay.has(w)) byDay.set(w, []);
  byDay.get(w).push(t);
}
for (const [day, list] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(summarize(day, list));
}

console.log("\nLoss count by weekday:");
console.log(countBy((t) => weekday(t.date), trades.filter((t) => t.outcome === "loss")));

console.log("\nLoss count by gap bucket:");
console.log(countBy((t) => bucketAbsGap(t.gapFromPrevClose), trades.filter((t) => t.outcome === "loss")));
