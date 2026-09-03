/**
 * Sanity checks for the 9:16 take-profit limit exit (replaces the old trailing ladder).
 */
import {
  getNineSixteenTakeProfitPct,
  getNineSixteenLadderLabel,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  shouldExitNineFifteenTakeProfit,
  ownLegUnrealisedPnl,
} from "../server/nine-sixteen-logic.js";

const entryPrice = 40;
const quantity = 130;

function checkWeekday(label: string, dateIst: string, expectedPct: number) {
  const pct = getNineSixteenTakeProfitPct(dateIst);
  const limit = nineFifteenTakeProfitLimitPrice(entryPrice, pct);
  const aim = nineFifteenTakeProfitAmount(entryPrice, quantity, pct);
  console.log(`\n${label} (${dateIst})`);
  console.log(`  take-profit: +${pct}% (expected ${expectedPct}%)`);
  console.log(`  ladder: ${getNineSixteenLadderLabel(dateIst)}`);
  console.log(`  limit price: ₹${limit.toFixed(2)} per unit`);
  console.log(`  profit aim: ₹${Math.round(aim)} on ₹${Math.round(entryPrice * quantity)} deployed`);
  if (pct !== expectedPct) {
    throw new Error(`${label}: expected ${expectedPct}% got ${pct}%`);
  }
}

checkWeekday("Monday", "2026-08-31", 5);
checkWeekday("Tuesday", "2026-09-01", 10);
checkWeekday("Wednesday", "2026-09-02", 5);
checkWeekday("Thursday", "2026-09-03", 5);
checkWeekday("Friday", "2026-09-04", 10);

{
  const pct = getNineSixteenTakeProfitPct("2026-09-01");
  const aim = nineFifteenTakeProfitAmount(entryPrice, quantity, pct);
  const atTarget = ownLegUnrealisedPnl(entryPrice, quantity, nineFifteenTakeProfitLimitPrice(entryPrice, pct));
  const below = atTarget != null ? atTarget - 1 : null;
  console.log("\nMarket backup trigger");
  console.log(`  at limit P&L ₹${Math.round(atTarget ?? 0)} → exit? ${shouldExitNineFifteenTakeProfit(atTarget, entryPrice, quantity, pct)}`);
  console.log(`  ₹1 below → exit? ${shouldExitNineFifteenTakeProfit(below, entryPrice, quantity, pct)}`);
  if (!shouldExitNineFifteenTakeProfit(atTarget, entryPrice, quantity, pct)) {
    throw new Error("market backup should fire at target P&L");
  }
  if (shouldExitNineFifteenTakeProfit(below, entryPrice, quantity, pct)) {
    throw new Error("market backup should not fire below target");
  }
}

console.log("\nAll 9:16 take-profit checks passed.");
