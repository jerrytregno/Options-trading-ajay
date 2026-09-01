/**
 * Entry sizing has to survive a broker that says "you cannot afford this".
 *
 * Two halves to that. Sizing runs off the last traded price while a market buy lifts the ask and
 * pays charges, so the plan carries head-room to keep the shortfall from happening at all. When it
 * happens anyway the entry steps down a size and re-sends rather than losing the trade — but only
 * after a refusal that filled nothing, which is what the guards below pin down.
 */
import {
  isInsufficientFundsError,
  KiteOrderRejectedError,
  parseMarginShortfall,
} from "../server/kite-client.js";
import { nextEntryLotsAfterMarginReject } from "../server/momentum-scalper-bot.js";
import { computeAffordableLots } from "../server/nine-sixteen-sizing.js";

/** How the entry plan sizes itself: affordable lots at the quoted premium plus head-room, capped. */
function lotsForPremium(input: {
  availableBalance: number;
  lotSize: number;
  premium: number;
  maxLots: number;
  safetyPct: number;
}): number {
  if (!(input.premium > 0) || !(input.lotSize > 0)) return 0;
  const { lots } = computeAffordableLots({
    availableBalance: input.availableBalance,
    lotSize: input.lotSize,
    optionLtp: input.premium * (1 + Math.max(0, input.safetyPct) / 100),
  });
  return Math.max(0, Math.min(lots, Math.floor(input.maxLots)));
}

let failures = 0;

function report(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  console.log(`       ${detail}`);
}

console.log("— sizing against the premium the market buy will pay —\n");

// The worked example: the ATM leg quotes ₹130.00 with a 65-unit lot, so 25 lots is ₹211,250. That
// quote is taken in the same breath as the order, which is the whole reason it can be trusted.
const lotSize = 65;
const premium = 130;
const fullSize = premium * lotSize * 25;

const exact = lotsForPremium({
  availableBalance: fullSize,
  lotSize,
  premium,
  maxLots: 25,
  safetyPct: 0,
});
report(
  "a balance that exactly covers the quote buys the full size",
  exact === 25,
  `₹${fullSize} at ₹${premium} × ${lotSize} → ${exact} lots`,
);

// Short of the full size, the lot count comes down on its own rather than being refused.
for (const [balance, want] of [
  [fullSize, 25],
  [fullSize - premium * lotSize, 24],
  [fullSize - premium * lotSize * 3, 22],
  [premium * lotSize * 1.5, 1],
] as const) {
  const lots = lotsForPremium({
    availableBalance: balance,
    lotSize,
    premium,
    maxLots: 25,
    safetyPct: 0,
  });
  report(
    `${Math.round(balance).toLocaleString("en-IN")} available → ${want} lots`,
    lots === want,
    `got ${lots} lots · costs ₹${(lots * premium * lotSize).toLocaleString("en-IN")}`,
  );
}

report(
  "a balance below one lot sizes to zero rather than sending an order",
  lotsForPremium({
    availableBalance: premium * lotSize * 0.9,
    lotSize,
    premium,
    maxLots: 25,
    safetyPct: 0,
  }) === 0,
  "→ the setup is dropped with a warning instead of an order the money cannot cover",
);

report(
  "headroom is applied on top of the quote",
  lotsForPremium({
    availableBalance: fullSize,
    lotSize,
    premium,
    maxLots: 25,
    safetyPct: 2,
  }) === 24,
  `2% headroom on ₹${premium} → 24 lots, holding back the lot the ask would have refused`,
);

report(
  "the per-trade cap still wins over a large balance",
  lotsForPremium({
    availableBalance: fullSize * 10,
    lotSize,
    premium,
    maxLots: 25,
    safetyPct: 0,
  }) === 25,
  "→ never more than 25 lots in the single order the bot tracks",
);

console.log("\n— what counts as an insufficient-funds refusal —\n");

// Real shapes Zerodha returns, from its own RMS and from the exchange.
const fundsMessages = [
  "Order 250828000123 REJECTED: RMS:Margin Exceeds,Required:154703.62, Available:139831.75 for NIFTY26AUG24100CE",
  "Insufficient funds. Required margin is 154703.62 but available margin is 139831.75",
  "Insufficient margin for this order",
  "margin shortfall of 12000",
];
for (const msg of fundsMessages) {
  report(
    `treated as a funds problem: "${msg.slice(0, 52)}…"`,
    isInsufficientFundsError(new Error(msg)),
    "→ retryable at a smaller size",
  );
}

// Anything that leaves the fill unknown, or is simply a different failure, must never be re-sent.
const notFundsMessages = [
  "Order 250828000123 fill timeout",
  "Order 250828000123 CANCELLED",
  "Entry order reported no filled quantity",
  "ATM option not found",
  "Too many requests",
];
for (const msg of notFundsMessages) {
  report(
    `not a funds problem: "${msg}"`,
    !isInsufficientFundsError(new Error(msg)),
    "→ propagates, never re-sent",
  );
}

console.log("\n— reading the shortfall the broker quotes back —\n");

const parsed = parseMarginShortfall(
  new Error("RMS:Margin Exceeds,Required:154703.62, Available:139831.75 for NIFTY26AUG24100CE"),
);
report(
  "required and available are recovered",
  parsed?.required === 154703.62 && parsed?.available === 139831.75,
  `parsed ${JSON.stringify(parsed)}`,
);
report(
  "a message without figures parses to null",
  parseMarginShortfall(new Error("Insufficient margin for this order")) === null,
  "→ caller falls back to stepping down one lot",
);

console.log("\n— choosing the next size —\n");

// 25 lots needed 154703 against 139831 available: 90.4% of the ask, so 22 lots fit.
const scaled = nextEntryLotsAfterMarginReject(25, { required: 154703.62, available: 139831.75 });
report(
  "scales straight to an affordable size when the figures are there",
  scaled === 22,
  `25 lots → ${scaled} lots (one round trip, not three)`,
);
report(
  "steps down one lot when there are no figures",
  nextEntryLotsAfterMarginReject(25, null) === 24,
  `25 lots → ${nextEntryLotsAfterMarginReject(25, null)} lots`,
);
report(
  "never returns the same size, even if the ratio rounds up to it",
  nextEntryLotsAfterMarginReject(10, { required: 100, available: 99.9 }) === 9,
  `10 lots → ${nextEntryLotsAfterMarginReject(10, { required: 100, available: 99.9 })} lots`,
);
report(
  "one lot cannot be reduced further",
  nextEntryLotsAfterMarginReject(1, null) === 0,
  "→ 0 means give up rather than loop",
);
report(
  "a hopeless shortfall gives up instead of going negative",
  nextEntryLotsAfterMarginReject(3, { required: 900000, available: 10 }) === 0,
  `3 lots → ${nextEntryLotsAfterMarginReject(3, { required: 900000, available: 10 })} lots`,
);

// The loop must terminate: from any starting size, repeated reductions reach 0.
let walk = 25;
let steps = 0;
while (walk > 0 && steps < 100) {
  walk = nextEntryLotsAfterMarginReject(walk, null);
  steps += 1;
}
report(
  "repeated reductions always terminate",
  walk === 0 && steps <= 25,
  `25 lots reached 0 in ${steps} steps`,
);

console.log("\n— head-room keeps the shortfall from happening —\n");

// A balance that exactly covers 25 lots at the last print cannot also cover the ask plus charges.
const lastPrint = 120;
const balance = lastPrint * 75 * 25;
const noBuffer = computeAffordableLots({
  availableBalance: balance,
  lotSize: 75,
  optionLtp: lastPrint,
});
const withBuffer = computeAffordableLots({
  availableBalance: balance,
  lotSize: 75,
  optionLtp: lastPrint * 1.02,
});
report(
  "2% head-room holds back the lots that would have been rejected",
  noBuffer.lots === 25 && withBuffer.lots === 24,
  `₹${balance} balance · ₹${lastPrint} premium → ${noBuffer.lots} lots raw, ${withBuffer.lots} lots with head-room`,
);

console.log("\n— a rejection carries enough detail to judge it —\n");

const rejected = new KiteOrderRejectedError({
  orderId: "250828000123",
  status: "REJECTED",
  statusMessage: "RMS:Margin Exceeds,Required:154703.62, Available:139831.75",
  filledQuantity: 0,
});
report(
  "a zero-fill margin rejection is identifiable and retryable",
  rejected instanceof Error &&
    rejected.filledQuantity === 0 &&
    isInsufficientFundsError(rejected) &&
    parseMarginShortfall(rejected) !== null,
  `${rejected.message.slice(0, 70)}…`,
);

const partial = new KiteOrderRejectedError({
  orderId: "250828000124",
  status: "CANCELLED",
  statusMessage: "Insufficient funds",
  filledQuantity: 750,
});
report(
  "a partly filled order is excluded by its fill count, not its message",
  isInsufficientFundsError(partial) && partial.filledQuantity > 0,
  `filled ${partial.filledQuantity} → the retry guard requires filledQuantity === 0`,
);

console.log(
  failures === 0 ? "\nFunds handling behaves correctly on every case." : `\n${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
