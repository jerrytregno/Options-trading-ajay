/**
 * Releasing a position back to the broker is the bot's most dangerous decision: it stops running
 * the stop and the ladder, books an invented exit, and frees itself to open a second leg. So it
 * must only happen when Zerodha genuinely says the leg is gone.
 *
 * The 2026-08-28 failure: the bot bought 25 lots at 11:08:03 and declared the position "closed on
 * Zerodha" in the same second. The positions book had not published the brand-new leg yet, and
 * `fetchNetQty` reported a missing row as quantity 0 — indistinguishable from flat. The live leg
 * was abandoned with no stop.
 *
 * Run: npx tsx scripts/check-momentum-reconcile-guard.ts
 */
import { evaluateBrokerLegClosed } from "../server/momentum-scalper-bot.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

const OWN_QTY = 1625; // 25 lots × 65
const GRACE = 20_000;

const base = {
  positionAgeMs: 60_000,
  brokerFound: true,
  brokerQty: OWN_QTY,
  ownQty: OWN_QTY,
  sellQtyAfterEntry: 0,
  graceMs: GRACE,
};

console.log("\n--- the 2026-08-28 regression: book has not published the fill yet ---");
check(
  "1s after entry, row missing — never release",
  evaluateBrokerLegClosed({ ...base, positionAgeMs: 1_000, brokerFound: false, brokerQty: 0 }),
  false,
);
check(
  "1s after entry, row present but still 0 — never release",
  evaluateBrokerLegClosed({ ...base, positionAgeMs: 1_000, brokerQty: 0 }),
  false,
);
check(
  "even past the grace, a missing row is lag and not a flat book",
  evaluateBrokerLegClosed({ ...base, brokerFound: false, brokerQty: 0 }),
  false,
);

console.log("\n--- grace window boundary ---");
check(
  "just inside the grace holds the position",
  evaluateBrokerLegClosed({ ...base, positionAgeMs: GRACE - 1, brokerQty: 0 }),
  false,
);
check(
  "at the grace, a published zero releases it",
  evaluateBrokerLegClosed({ ...base, positionAgeMs: GRACE, brokerQty: 0 }),
  true,
);
check(
  "unknown age still requires a published zero",
  evaluateBrokerLegClosed({ ...base, positionAgeMs: null, brokerQty: 0 }),
  true,
);
check(
  "unknown age does not release on a missing row",
  evaluateBrokerLegClosed({ ...base, positionAgeMs: null, brokerFound: false, brokerQty: 0 }),
  false,
);

console.log("\n--- a genuine manual close on Zerodha still gets picked up ---");
check(
  "book shows the contract at 0 — release",
  evaluateBrokerLegClosed({ ...base, brokerQty: 0 }),
  true,
);
check(
  "book shows a negative net (sold through) — release",
  evaluateBrokerLegClosed({ ...base, brokerQty: -100 }),
  true,
);
check(
  "book below our size and enough sold after entry — release",
  evaluateBrokerLegClosed({ ...base, brokerQty: 65, sellQtyAfterEntry: OWN_QTY }),
  true,
);

console.log("\n--- selling in a shared strike is not evidence about our leg ---");
// The 2026-08-28 shape: a manual 3445-qty exit lands after our entry, but the book still holds
// our full 1625. Counting that sell against us would abandon a position that is entirely open.
check(
  "manual 3445 exit elsewhere, our 1625 still in the book — hold",
  evaluateBrokerLegClosed({ ...base, brokerQty: OWN_QTY, sellQtyAfterEntry: 3445 }),
  false,
);
check(
  "strike holds more than ours and nothing sold — hold",
  evaluateBrokerLegClosed({ ...base, brokerQty: 5000 }),
  false,
);
check(
  "strike still holds more than ours despite a big sell — hold",
  evaluateBrokerLegClosed({ ...base, brokerQty: 5000, sellQtyAfterEntry: OWN_QTY * 2 }),
  false,
);
check(
  "a partial sell short of our size — hold",
  evaluateBrokerLegClosed({ ...base, brokerQty: 65, sellQtyAfterEntry: OWN_QTY - 65 }),
  false,
);

console.log("\n--- nothing tracked means nothing to release ---");
check("no own quantity", evaluateBrokerLegClosed({ ...base, ownQty: 0, brokerQty: 0 }), false);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
