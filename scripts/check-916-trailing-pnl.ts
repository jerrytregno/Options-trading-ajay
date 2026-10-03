/**
 * Sanity checks for the 9:16 take-profit limit exit (replaces the old trailing ladder).
 */
import {
  getNineSixteenTakeProfitPct,
  getNineSixteenLadderLabel,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  shouldExitNineFifteenTakeProfit,
  shouldExitNineSixteenTakeProfit,
  formatNineFifteenExitSummary,
  ownLegUnrealisedPnl,
} from "../server/nine-sixteen-logic.js";

const entryPrice = 40;
const quantity = 130;

function checkWeekday(label: string, dateIst: string, expectedPct: number, leg?: "CE_BUY" | "PE_BUY") {
  const pct = getNineSixteenTakeProfitPct(dateIst, leg);
  const limit = nineFifteenTakeProfitLimitPrice(entryPrice, pct);
  const aim = nineFifteenTakeProfitAmount(entryPrice, quantity, pct);
  console.log(`\n${label} (${dateIst})`);
  console.log(`  take-profit: +${pct}% (expected ${expectedPct}%)`);
  console.log(`  ladder: ${getNineSixteenLadderLabel(dateIst, leg)}`);
  console.log(`  limit price: ₹${limit.toFixed(2)} per unit`);
  console.log(`  profit aim: ₹${Math.round(aim)} on ₹${Math.round(entryPrice * quantity)} deployed`);
  if (pct !== expectedPct) {
    throw new Error(`${label}: expected ${expectedPct}% got ${pct}%`);
  }
}

checkWeekday("Monday", "2026-08-31", 5);
checkWeekday("Tuesday", "2026-09-01", 7);
checkWeekday("Wednesday", "2026-09-02", 5);
checkWeekday("Thursday", "2026-09-03", 5);
checkWeekday("Friday", "2026-09-04", 7);
checkWeekday("Monday PE", "2026-08-31", 5, "PE_BUY");
checkWeekday("Tuesday PE", "2026-09-01", 7, "PE_BUY");
checkWeekday("Monday CE", "2026-08-31", 3, "CE_BUY");
checkWeekday("Tuesday CE", "2026-09-01", 3, "CE_BUY");
checkWeekday("Wednesday CE", "2026-09-02", 3, "CE_BUY");
checkWeekday("Thursday CE", "2026-09-03", 3, "CE_BUY");
checkWeekday("Friday CE", "2026-09-04", 3, "CE_BUY");

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
  if (!shouldExitNineSixteenTakeProfit(atTarget, entryPrice, quantity, pct)) {
    throw new Error("9:16 market backup helper should fire at target P&L");
  }
  const summary = formatNineFifteenExitSummary({
    exitPrice: nineFifteenTakeProfitLimitPrice(entryPrice, pct),
    quantity,
    entryPrice,
    pnl: atTarget,
    via: "market",
    takeProfitPct: pct,
    legTag: "9:16",
  });
  if (!summary.includes("9:16") || !summary.includes("backup")) {
    throw new Error(`9:16 exit summary missing leg tag: ${summary}`);
  }
  console.log(`  exit summary: ${summary}`);
}

console.log("\nAll 9:16 take-profit checks passed.");
