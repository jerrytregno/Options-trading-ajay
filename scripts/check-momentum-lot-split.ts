import { formatLotSplitLabel, splitLotsIntoOrderChunks } from "../server/nine-sixteen-sizing.js";

const MAX_PER_ORDER = 25;

const cases = [1, 24, 25, 26, 50, 63, 100, 213];
let failures = 0;

for (const lots of cases) {
  const chunks = splitLotsIntoOrderChunks(lots, MAX_PER_ORDER);
  const total = chunks.reduce((a, b) => a + b, 0);
  const oversized = chunks.filter((c) => c > MAX_PER_ORDER);
  const ok = total === lots && oversized.length === 0;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${String(lots).padStart(3)} lots -> ${chunks.join("+")} (${formatLotSplitLabel(chunks)})`,
  );
}

console.log(failures === 0 ? "\nAll lot-split cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
