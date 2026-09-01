/**
 * Regression checks for the 2026-08-25 contamination, where the 9:16 bot folded the momentum
 * scalper's lots in the same strike into its own book and booked a loss against an entry price
 * neither bot ever paid.
 */
import { ownPositionSync, pnlPctOfEntryCost, ownLegUnrealisedPnl } from "../server/nine-sixteen-logic.js";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label} → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

console.log("\nThe 2026-08-25 case: another bot buys the same strike mid-trade");
{
  // Ours: 6305 @ 39.17. The scalper then buys 8385 @ 22.37 in the same contract, so Kite reports
  // 14690 net at the blended 29.58.
  const own = { quantity: 6305, entryPrice: 39.17 };
  const broker = { quantity: 14690, average_price: 29.58 };
  const next = ownPositionSync(own, broker);
  check("quantity stays our own 6305", next.quantity, 6305);
  check("entry price stays our own 39.17", next.entryPrice, 39.17);
}

console.log("\nThe ladder reads sanely once the book is clean");
{
  const clean = ownPositionSync({ quantity: 6305, entryPrice: 39.17 }, { quantity: 14690, average_price: 29.58 });
  const pnl = ownLegUnrealisedPnl(clean.entryPrice, clean.quantity, 44.72);
  const pct = pnlPctOfEntryCost(pnl, clean.entryPrice, clean.quantity);
  check("P&L is our leg only", Math.round(pnl ?? 0), Math.round((44.72 - 39.17) * 6305));
  check("percentage is plausible", pct != null && pct > 13 && pct < 15, true);
}

console.log("\nA genuine partial reduction still shrinks our leg");
{
  const next = ownPositionSync({ quantity: 6305, entryPrice: 39.17 }, { quantity: 2000, average_price: 39.17 });
  check("quantity follows the broker down", next.quantity, 2000);
  check("entry price is untouched", next.entryPrice, 39.17);
}

console.log("\nA flat broker position closes our leg out");
{
  const next = ownPositionSync({ quantity: 6305, entryPrice: 39.17 }, { quantity: 0, average_price: 29.58 });
  check("quantity goes to zero", next.quantity, 0);
}

console.log("\nRecovery with no own fills still adopts the broker's figures");
{
  const next = ownPositionSync({ quantity: 0, entryPrice: 0 }, { quantity: 975, average_price: 31.5 });
  check("quantity adopted", next.quantity, 975);
  check("entry price adopted", next.entryPrice, 31.5);
}

console.log("\nA known entry price is never replaced by the broker's daily blend");
{
  // Same bot re-entering a strike it already traded and closed today: the blend carries the old
  // round trip, so it must not overwrite the price we actually paid on this entry.
  const next = ownPositionSync({ quantity: 325, entryPrice: 21.9 }, { quantity: 325, average_price: 29.41 });
  check("entry price stays 21.90", next.entryPrice, 21.9);
  check("quantity unchanged", next.quantity, 325);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
