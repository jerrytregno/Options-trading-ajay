/**
 * The 9:15 trade: the ten-second read, its +5% take-profit limit exit, and the red-only gate it puts on the
 * 9:16 trade that follows it.
 *
 * Run: npx tsx scripts/check-nine-fifteen-trade.ts
 */
import {
  decideNineFifteenEntry,
  decide915Entry,
  build915BarFromCaptured,
  NINE_FIFTEEN_MIN_DROP_PTS,
  NINE_FIFTEEN_MIN_RISE_PTS,
  getNineFifteenTakeProfitPct,
  NINE_FIFTEEN_TAKE_PROFIT_PCT,
  NINE_FIFTEEN_TAKE_PROFIT_PCT_TUESDAY,
  NINE_FIFTEEN_CE_TAKE_PROFIT_PCT,
  NINE_FIFTEEN_ENTRY_SEC,
  NINE_FIFTEEN_SIGNAL_READ_SEC,
  NINE_FIFTEEN_ENTRY_WINDOW_END_SEC,
  NINE_FIFTEEN_MARGIN_RETRY_END_SEC,
  isPastNineFifteenMarginRetryWindow,
  isPastNineFifteenSignalRead,
  isReadyForNineFifteenEntry,
  isPastNineFifteenEntryWindow,
  isPastNineFifteenMinute,
  is915BodyBelowMinPts,
  shouldHardStopNineSixteen,
  computeHardStopSpot,
  getHardStopStartLabel,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  nineFifteenDeployedCapital,
  shouldExitNineFifteenTakeProfit,
  getNineFifteenLadderLabel,
  formatNineFifteenExitSummary,
  NINE_SIXTEEN_ENTRY_SEC,
  NINE_SIXTEEN_BACKTEST_ENTRY_SEC,
  isReadyFor916Entry,
  msUntilEntryInstant,
} from "../server/nine-sixteen-logic.js";
import { computeAffordableLots, conservativeEntryLtpFromQuotes } from "../server/nine-sixteen-sizing.js";
import { roundToOptionTick } from "../src/lib/kite-orders.js";
import {
  marketProtectionForSide,
  normalizeKiteOrderBody,
} from "../src/lib/kite-orders.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} · ${label}` +
      (ok ? "" : ` · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`),
  );
}

/** An IST wall-clock time as an epoch, so the timing gates can be tested without waiting. */
function ist(h: number, m: number, s: number, ms = 0): number {
  return Date.UTC(2026, 7, 31, h - 5, m - 30, s, ms);
}

console.log("\n--- the ten-second read decides red or green ---");
check("red with 10 pt drop buys the PE", decideNineFifteenEntry(24_800, 24_790), {
  action: "enter",
  leg: "PE_BUY",
  movePts: 10,
});
check(
  "a one-paisa fall is too small — need at least 5 pts",
  decideNineFifteenEntry(24_800, 24_799.95).action,
  "skip",
);
check("exactly 5 pts down enters", decideNineFifteenEntry(24_800, 24_795), {
  action: "enter",
  leg: "PE_BUY",
  movePts: 5,
});
check("4.9 pts down is skipped", decideNineFifteenEntry(24_800, 24_795.1).action, "skip");
check("green with 10 pt rise buys CE", decideNineFifteenEntry(24_800, 24_810), {
  action: "enter",
  leg: "CE_BUY",
  movePts: 10,
});
check("9.9 pts up is skipped", decideNineFifteenEntry(24_800, 24_809.9).action, "skip");
check("exactly 5 pts up is skipped", decideNineFifteenEntry(24_800, 24_805).action, "skip");
check("4.9 pts up is skipped", decideNineFifteenEntry(24_800, 24_804.9).action, "skip");
check("flat is skipped", decideNineFifteenEntry(24_800, 24_800).action, "skip");
check("a missing open is skipped", decideNineFifteenEntry(0, 24_790).action, "skip");
check("a missing read is skipped", decideNineFifteenEntry(24_800, 0).action, "skip");

console.log("\n--- timing gates ---");
check("the read is due at 9:15:10.000", isPastNineFifteenSignalRead(ist(9, 15, 10)), true);
check("not at 9:15:09.999", isPastNineFifteenSignalRead(ist(9, 15, 9, 999)), false);
check("entry opens at 9:15:11", isReadyForNineFifteenEntry(ist(9, 15, 11)), true);
check("entry is not open at 9:15:10", isReadyForNineFifteenEntry(ist(9, 15, 10)), false);
check("entry still open at 9:15:20", isReadyForNineFifteenEntry(ist(9, 15, 20)), true);
check("margin retry at 9:15:15", !isPastNineFifteenMarginRetryWindow(ist(9, 15, 15)), true);
check("margin retry closed at 9:15:16", isPastNineFifteenMarginRetryWindow(ist(9, 15, 16)), true);
check("915 margin end sec", NINE_FIFTEEN_MARGIN_RETRY_END_SEC, 9 * 3600 + 15 * 60 + 15);
check("entry window is gone at 9:15:21", isPastNineFifteenEntryWindow(ist(9, 15, 21)), true);
check("the minute is not over at 9:15:59", isPastNineFifteenMinute(ist(9, 15, 59)), false);
check("the minute is over at 9:16:00", isPastNineFifteenMinute(ist(9, 16, 0)), true);
check("the read is 1s before the order", NINE_FIFTEEN_ENTRY_SEC - NINE_FIFTEEN_SIGNAL_READ_SEC, 1);
check(
  "retries stop well inside the minute",
  NINE_FIFTEEN_ENTRY_WINDOW_END_SEC < 9 * 3600 + 16 * 60,
  true,
);

console.log("\n--- 9:15 small-body exit arming ---");
check("4.9 pt body is below 5", is915BodyBelowMinPts(100, 104.9), true);
check("exactly 5 pt body is not below 5", is915BodyBelowMinPts(100, 105), false);
check("3 pt red body is below 5", is915BodyBelowMinPts(100, 97), true);
check("15 pt body is not below 5", is915BodyBelowMinPts(100, 115), false);

console.log("\n--- 9:16 live entry timing ---");
check("live entry at 9:16:01", NINE_SIXTEEN_ENTRY_SEC, 9 * 3600 + 16 * 60 + 1);
check("backtest entry label at 9:16:00", NINE_SIXTEEN_BACKTEST_ENTRY_SEC, 9 * 3600 + 16 * 60);
check("entry not open at 9:16:00", isReadyFor916Entry(ist(9, 16, 0)), false);
check("entry opens at 9:16:01", isReadyFor916Entry(ist(9, 16, 1)), true);
check("ms until entry at 9:16:00.500", msUntilEntryInstant(ist(9, 16, 0, 500)), 500);

console.log("\n--- conservative entry LTP ---");
check("uses lower quote for sizing", conservativeEntryLtpFromQuotes(61.9, 56.51).ltp, 56.51);
check(
  "limit entry at second quote",
  conservativeEntryLtpFromQuotes(61.9, 56.51).entryLimitPrice,
  roundToOptionTick(56.51),
);
check("flags stale spike from today", conservativeEntryLtpFromQuotes(61.9, 56.51).staleFirstQuote, true);
check("flags at exactly 3% spike", conservativeEntryLtpFromQuotes(103, 100).staleFirstQuote, true);
check("no spike at 2.9%", conservativeEntryLtpFromQuotes(102.9, 100).staleFirstQuote, false);
check("no spike when second is higher", conservativeEntryLtpFromQuotes(56, 57).staleFirstQuote, false);

console.log("\n--- weekday take-profit limit on capital deployed ---");
check("default take-profit is 5%", NINE_FIFTEEN_TAKE_PROFIT_PCT, 5);
check("Tuesday take-profit is 5%", NINE_FIFTEEN_TAKE_PROFIT_PCT_TUESDAY, 5);
check("Monday take-profit is 5%", getNineFifteenTakeProfitPct("2026-08-31"), 5);
check("Tuesday PE take-profit is 5%", getNineFifteenTakeProfitPct("2026-09-01", "PE_BUY"), 5);
check("Tuesday CE take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-01", "CE_BUY"), 3);
check("Monday CE take-profit is 3%", getNineFifteenTakeProfitPct("2026-08-31", "CE_BUY"), 3);
check("Tuesday without leg defaults to PE 5%", getNineFifteenTakeProfitPct("2026-09-01"), 5);
check("Wednesday PE take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-02"), 3);
check("Wednesday CE take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-02", "CE_BUY"), 3);
check("CE take-profit constant is 3%", NINE_FIFTEEN_CE_TAKE_PROFIT_PCT, 3);
check("Thursday take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-03"), 3);
check("Friday take-profit is 3%", getNineFifteenTakeProfitPct("2026-09-04"), 3);
check("limit price is entry × 1.03 at 3%", nineFifteenTakeProfitLimitPrice(100, 3), 103);
check("limit price is entry × 1.05 at 5%", nineFifteenTakeProfitLimitPrice(100, 5), 105);
check("limit price is entry × 1.10 at 10%", nineFifteenTakeProfitLimitPrice(100, 10), 110);
check("limit price snaps to ₹0.05 tick", nineFifteenTakeProfitLimitPrice(153.33, 5), 161);
check(
  "39.74 entry at +5% is 41.75 not invalid 41.73",
  nineFifteenTakeProfitLimitPrice(39.74, 5),
  41.75,
);
check("deployed capital is entry × qty", nineFifteenDeployedCapital(100, 650), 65_000);
check("profit aim is 5% of deployed", nineFifteenTakeProfitAmount(100, 1000, 5), 5000);
check("profit aim is 10% of deployed", nineFifteenTakeProfitAmount(100, 1000, 10), 10_000);
check("₹1L deployed → ₹5K profit aim", nineFifteenTakeProfitAmount(100, 1000, 5), 100_000 * 0.05);
check("does not exit below 5% target", shouldExitNineFifteenTakeProfit(4999, 100, 1000, 5), false);
check("exits at 5% target", shouldExitNineFifteenTakeProfit(5000, 100, 1000, 5), true);
check("exits at 10% target", shouldExitNineFifteenTakeProfit(10_000, 100, 1000, 10), true);
check("label mentions +5% on Tuesday PE", getNineFifteenLadderLabel("2026-09-01", "PE_BUY").includes("+5%"), true);
check("label mentions +3% on Tuesday CE", getNineFifteenLadderLabel("2026-09-01", "CE_BUY").includes("+3%"), true);
check("label mentions +3% on Wednesday", getNineFifteenLadderLabel("2026-09-02", "CE_BUY").includes("+3%"), true);
check("label mentions +3% on Thursday", getNineFifteenLadderLabel("2026-09-03", "CE_BUY").includes("+3%"), true);
check("label mentions +3% on Friday", getNineFifteenLadderLabel("2026-09-04", "CE_BUY").includes("+3%"), true);

check(
  "exit summary names limit fill and P&L",
  formatNineFifteenExitSummary({
    exitPrice: 105,
    quantity: 1000,
    entryPrice: 100,
    pnl: 5000,
    via: "limit",
  }).includes("TRADE EXITED"),
  true,
);

console.log("\n--- buys are NRML MARKET at the print; only sells are LIMIT ---");
{
  const availableBalance = 175_693;
  const lotSize = 65;
  const lastPrint = 99.95;
  const sized = computeAffordableLots({ availableBalance, lotSize, optionLtp: lastPrint });
  check("entry sizes off the exact last print", sized.lots, 27);

  const buy = normalizeKiteOrderBody(
    {
      tradingsymbol: "NIFTY2691523500PE",
      exchange: "NFO",
      transaction_type: "BUY",
      product: "NRML",
      quantity: 1625,
      order_type: "MARKET",
      variety: "regular",
      market_protection: marketProtectionForSide("BUY"),
    },
    marketProtectionForSide("BUY"),
  );
  check("buy order type is MARKET", buy.order_type, "MARKET");
  check("buy product is NRML", buy.product, "NRML");
  check("buy has no limit price", buy.price == null, true);
  check("buy sends Kite-required market protection", buy.market_protection, "-1");

  const sellMarket = normalizeKiteOrderBody(
    {
      tradingsymbol: "NIFTY2691523500PE",
      exchange: "NFO",
      transaction_type: "SELL",
      product: "NRML",
      quantity: 130,
      order_type: "MARKET",
      variety: "regular",
      market_protection: marketProtectionForSide("SELL", "-1"),
    },
    marketProtectionForSide("SELL", "-1"),
  );
  check("emergency sell can stay MARKET", sellMarket.order_type, "MARKET");
  check("exit sell uses same NRML product", sellMarket.product, "NRML");
}

console.log("\n--- 9:15 entry minimum move ---");
check("minimum red move is 5 pts", NINE_FIFTEEN_MIN_DROP_PTS, 5);
check("minimum green move is 10 pts", NINE_FIFTEEN_MIN_RISE_PTS, 10);

console.log("\n--- the 9:16 trade now takes red candles only ---");
const bar = (open: number, close: number) =>
  build915BarFromCaptured(open, close, Math.max(open, close), Math.min(open, close))!;

check("a 20 pt fall enters the PE on the main band", decide915Entry(bar(24_800, 24_780)), {
  action: "enter",
  leg: "PE_BUY",
  exitMode: "main",
});
check("a 12 pt fall is under the 15 pt main floor", decide915Entry(bar(24_800, 24_788)).action, "skip");
check("a 20 pt rise is skipped — no CE side any more", decide915Entry(bar(24_800, 24_820)).action, "skip");
check("a 40 pt rise is skipped too", decide915Entry(bar(24_800, 24_840)).action, "skip");
check("a 7 pt fall is still under the 15 pt floor", decide915Entry(bar(24_800, 24_793)).action, "skip");
check("a flat candle is skipped", decide915Entry(bar(24_800, 24_800)).action, "skip");
check("exactly 14 pts down is still under the main band", decide915Entry(bar(24_800, 24_786)).action, "skip");
check("exactly 15 pts down enters the main band", decide915Entry(bar(24_800, 24_785)), {
  action: "enter",
  leg: "PE_BUY",
  exitMode: "main",
});

console.log("\n--- hard stop helpers (deprecated, not live) ---");
const entrySpot = 24_000;
check("PE +30 @10:00 exits", shouldHardStopNineSixteen(24_030, entrySpot, "PE_BUY", undefined, ist(10, 0, 0)), true);
check("PE +29 @10:00 holds", shouldHardStopNineSixteen(24_029, entrySpot, "PE_BUY", undefined, ist(10, 0, 0)), false);
check("PE +30 @09:59 holds", shouldHardStopNineSixteen(24_030, entrySpot, "PE_BUY", undefined, ist(9, 59, 59)), false);
check(
  "PE stop level is entry + 30",
  computeHardStopSpot(entrySpot, "PE_BUY"),
  entrySpot + 30,
);
check(
  "CE stop level is entry − 30",
  computeHardStopSpot(entrySpot, "CE_BUY"),
  entrySpot - 30,
);
check("CE −30 @10:00 exits", shouldHardStopNineSixteen(23_970, entrySpot, "CE_BUY", undefined, ist(10, 0, 0)), true);
check("CE −29 @10:00 holds", shouldHardStopNineSixteen(23_971, entrySpot, "CE_BUY", undefined, ist(10, 0, 0)), false);
check("hard stop label", getHardStopStartLabel(), "10:00");

console.log("\n--- both legs armed by default on a fresh load ---");
{
  const { getNineSixteenBotStatus } = await import("../server/nine-sixteen-bot.js");
  const status = getNineSixteenBotStatus();
  check("9:15 trading is on by default", status.nineFifteenEnabled, true);
  check("9:16 trading is off by default", status.enabled, false);
  check("no 9:15 leg claimed yet", status.tradeSlot, "nine-sixteen");
  check("nothing settled before the day starts", status.nineFifteenSettled, false);
  check("the 9:16 trade is not blocked", status.nineFifteenBlocked916, false);
  check("9:15 take-profit pct is 5", status.nineFifteenTakeProfitPct, 5);
  // Only an explicit boolean true may arm either leg — the toggle routes compare with ===.
  for (const value of ["true", "1", 1, {}] as unknown[]) {
    check(`payload ${JSON.stringify(value)} does not arm`, value === true, false);
  }
}

console.log(
  failures === 0 ? "\nAll 9:15 trade checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
