/**
 * 9:16 trade histogram buckets must partition |9:15 body| into non-overlapping 10-pt bands.
 *
 * Run: npx tsx scripts/check-nine-sixteen-body-buckets.ts
 */
import {
  buildNineSixteenBodyBuckets,
  formatNineSixteenBodyBucketLabel,
  nineSixteenBodyBucketIndex,
  strategyTradesForBodyBuckets,
} from "../src/lib/nine-sixteen-body-buckets.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

console.log("\n--- bucket boundaries ---");
check("9.9 → 0–10", nineSixteenBodyBucketIndex(9.9), 0);
check("10 → 10–20", nineSixteenBodyBucketIndex(10), 1);
check("10.01 → 10–20", nineSixteenBodyBucketIndex(10.01), 1);
check("42.5 → 40–50", nineSixteenBodyBucketIndex(42.5), 4);
check("label for index 3", formatNineSixteenBodyBucketLabel(3), "30–40");

console.log("\n--- trade counts per bucket ---");
const buckets = buildNineSixteenBodyBuckets(
  [
    { change: 5, won: true },
    { change: 12, won: true },
    { change: -15, won: false },
    { change: 28, won: true },
    { change: 31, won: false },
  ],
  { signalFloor: 11 },
);
check(
  "counts",
  buckets.map((b) => b.count),
  [1, 2, 1, 1, 0],
);
check(
  "wins per bucket",
  buckets.map((b) => b.wins),
  [1, 1, 1, 0, 0],
);

console.log("\n--- strategy merge respects the |Δ| floor ---");
const merged = strategyTradesForBodyBuckets(
  [{ change: 30 } as never, { change: 8 } as never],
  [{ change: -12 } as never],
  11,
);
check("only bodies ≥ 11", merged.map((t) => Math.abs(t.change)), [30, 12]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
