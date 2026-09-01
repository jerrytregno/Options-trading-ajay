/**
 * Verifies server/kite-totp.ts against the RFC 6238 SHA-1 test vectors, and checks that the
 * auto-login scheduler aims at 07:40 IST with a 07:30 IST staleness boundary.
 * Run: npx tsx scripts/check-kite-totp.ts
 */
import { lastFlushBoundaryMs, msUntilRefresh } from "../server/kite-auto-login.js";
import { generateTotp } from "../server/kite-totp.js";

function toBase32(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const secret = toBase32(Buffer.from("12345678901234567890"));
console.log(`base32 secret: ${secret}`);
console.log(`expected     : GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n`);

/** [unix seconds, expected 6-digit code] — last 6 digits of the RFC's 8-digit vectors. */
const vectors: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

let passed = 0;
for (const [seconds, expected] of vectors) {
  const got = generateTotp(secret, seconds * 1000);
  const ok = got === expected;
  if (ok) passed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  T=${seconds}  expected=${expected}  got=${got}`);
}

const tolerant =
  generateTotp("jbswy3dp ehpk3pxp", 59_000) === generateTotp("JBSWY3DPEHPK3PXP", 59_000);
console.log(`${tolerant ? "PASS" : "FAIL"}  tolerates lowercase and spaces in the secret`);

console.log(`\n${passed}/${vectors.length} RFC 6238 vectors passed`);

console.log("\n--- scheduler ---");

const istLabel = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(ms));

/** Epoch ms for a given IST wall-clock time on 2026-08-19 (IST = UTC+5:30). */
const ist = (hour: number, minute: number) =>
  Date.UTC(2026, 7, 19, hour - 5, minute - 30, 0);

let schedOk = true;
const schedCases: { at: number; wantFire: string; wantBoundaryDay: string }[] = [
  { at: ist(3, 0), wantFire: "19/08/2026, 07:40:00", wantBoundaryDay: "18/08/2026, 07:30:00" },
  { at: ist(7, 29), wantFire: "19/08/2026, 07:40:00", wantBoundaryDay: "18/08/2026, 07:30:00" },
  { at: ist(7, 31), wantFire: "19/08/2026, 07:40:00", wantBoundaryDay: "19/08/2026, 07:30:00" },
  { at: ist(7, 45), wantFire: "20/08/2026, 07:40:00", wantBoundaryDay: "19/08/2026, 07:30:00" },
  { at: ist(15, 30), wantFire: "20/08/2026, 07:40:00", wantBoundaryDay: "19/08/2026, 07:30:00" },
  { at: ist(23, 59), wantFire: "20/08/2026, 07:40:00", wantBoundaryDay: "19/08/2026, 07:30:00" },
];

for (const { at, wantFire, wantBoundaryDay } of schedCases) {
  const fire = istLabel(at + msUntilRefresh(at));
  const boundary = istLabel(lastFlushBoundaryMs(at));
  const ok = fire === wantFire && boundary === wantBoundaryDay;
  if (!ok) schedOk = false;
  console.log(
    `${ok ? "PASS" : "FAIL"}  at ${istLabel(at)} IST → fires ${fire} · last flush ${boundary}`,
  );
}

if (passed !== vectors.length || !tolerant || !schedOk) process.exit(1);
console.log("\nAll checks passed");
