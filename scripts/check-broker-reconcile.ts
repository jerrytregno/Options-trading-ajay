/**
 * Sanity checks for matching Zerodha fills onto bot trade logs. The risky case is two trades on the
 * same strike on the same day — they must not be credited with each other's fills.
 */
import { assignFillsToLogs, segmentRoundTrips, summarise } from "../server/broker-trades.js";
import type { BotTradeLog, BrokerFill } from "../src/types/trade-log.js";

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

const SYMBOL = "NIFTY26AUG24500CE";

function fill(
  tradeId: string,
  side: "BUY" | "SELL",
  time: string,
  quantity: number,
  price: number,
): BrokerFill {
  return {
    tradeId,
    orderId: `O${tradeId}`,
    tradingsymbol: SYMBOL,
    transactionType: side,
    quantity,
    price,
    filledAtIst: time,
  };
}

function log(id: string, entry: string | null, exit: string | null): BotTradeLog {
  return {
    id,
    source: "momentum-scalper",
    dateIST: "2026-08-25",
    status: "closed",
    leg: "CE_BUY",
    tradingsymbol: SYMBOL,
    quantity: 75,
    open915: null,
    entrySpot: null,
    targetSpot: null,
    entryPrice: 150,
    exitPrice: null,
    exitSpot: null,
    pnl: null,
    exitReason: null,
    message: "",
    logs: [],
    createdAt: "2026-08-25T04:00:00.000Z",
    closedAt: "2026-08-25T05:00:00.000Z",
    entryTimeIst: entry,
    exitTimeIst: exit,
  };
}

console.log("\nOne trade on a strike takes every fill");
{
  const only = log("a", "10:15", "10:25");
  const fills = [fill("1", "BUY", "10:15:02", 75, 150), fill("2", "SELL", "10:24:58", 75, 158)];
  const assigned = assignFillsToLogs([only], fills);
  check("all fills land on the single log", assigned.get("a")?.length, 2);
}

console.log("\nTwo trades on the same strike are split by their own clocks");
{
  const first = log("a", "10:15", "10:25");
  const second = log("b", "13:40", "13:50");
  const fills = [
    fill("1", "BUY", "10:15:02", 75, 150),
    fill("2", "SELL", "10:24:58", 75, 158),
    fill("3", "BUY", "13:40:01", 75, 120),
    fill("4", "SELL", "13:49:30", 75, 118),
  ];
  const assigned = assignFillsToLogs([first, second], fills);
  check("morning trade keeps its two fills", assigned.get("a")?.map((f) => f.tradeId), ["1", "2"]);
  check("afternoon trade keeps its two fills", assigned.get("b")?.map((f) => f.tradeId), ["3", "4"]);
}

console.log("\nA fill outside every window goes to the nearest entry, never dropped");
{
  const first = log("a", "10:15", "10:25");
  const second = log("b", "13:40", "13:50");
  const fills = [fill("9", "SELL", "13:58:00", 75, 118)];
  const assigned = assignFillsToLogs([first, second], fills);
  check("late fill attaches to the afternoon trade", assigned.get("b")?.map((f) => f.tradeId), ["9"]);
  check("morning trade is untouched", assigned.get("a")?.length, 0);
}

console.log("\nExchange seconds do not fall outside a HH:MM window");
{
  const only = log("a", "10:15", "10:25");
  const other = log("b", "14:05", "14:15");
  // Entry stamped 10:15 by the bot, filled at 10:15:44 — and exit at 10:25:31, past the HH:MM end.
  const fills = [fill("1", "BUY", "10:15:44", 75, 150), fill("2", "SELL", "10:25:31", 75, 156)];
  const assigned = assignFillsToLogs([only, other], fills);
  check("both fills stay with the trade that made them", assigned.get("a")?.map((f) => f.tradeId), ["1", "2"]);
}

console.log("\nSummary arithmetic");
{
  const fills = [
    fill("1", "BUY", "10:15:02", 50, 150),
    fill("2", "BUY", "10:15:03", 25, 154),
    fill("3", "SELL", "10:24:58", 75, 160),
  ];
  const summary = summarise(SYMBOL, fills, "2026-08-25T10:30:00.000Z");
  check("buy qty", summary.buyQuantity, 75);
  check("sell qty", summary.sellQuantity, 75);
  // (50×150 + 25×154) / 75 = 151.33
  check("weighted avg buy", summary.avgBuyPrice, 151.33);
  check("avg sell", summary.avgSellPrice, 160);
  // Computed from the unrounded average (151.3333…), not the displayed 151.33.
  check("realised P&L", summary.realisedPnl, 650);
  check("first fill", summary.firstFillIst, "10:15:02");
  check("last fill", summary.lastFillIst, "10:24:58");
  check("order ids deduped", summary.orderIds.length, 3);
}

console.log("\nRound trips are cut where the position goes flat, not per fill");
{
  const fills = [
    fill("1", "BUY", "09:16:01", 900, 100),
    fill("2", "BUY", "09:16:02", 900, 101),
    fill("3", "SELL", "09:38:00", 1800, 108),
    fill("4", "BUY", "09:40:00", 900, 95),
    fill("5", "SELL", "10:52:00", 900, 92),
  ];
  const trips = segmentRoundTrips(fills);
  check("two round trips", trips.length, 2);
  check("first trip is the split entry and its exit", trips[0].map((f) => f.tradeId), ["1", "2", "3"]);
  check("second trip is the re-entry", trips[1].map((f) => f.tradeId), ["4", "5"]);
}

console.log("\nA leg still open ends the last trip without flattening");
{
  const trips = segmentRoundTrips([
    fill("1", "BUY", "09:16:01", 900, 100),
    fill("2", "SELL", "09:38:00", 900, 108),
    fill("3", "BUY", "09:40:00", 900, 95),
  ]);
  check("open leg becomes its own trip", trips.length, 2);
  check("open trip holds only the buy", trips[1].map((f) => f.tradeId), ["3"]);
}

console.log("\nUntimed logs (9:16 bot) match on quantity, not on order");
{
  // createdAt 04:10Z = 09:40 IST, 05:22Z = 10:52 IST.
  const first = { ...log("a", null, null), quantity: 900, createdAt: "2026-08-25T04:10:00.000Z" };
  const second = { ...log("b", null, null), quantity: 325, createdAt: "2026-08-25T05:22:00.000Z" };
  const fills = [
    fill("1", "BUY", "09:16:01", 900, 100),
    fill("2", "SELL", "09:38:00", 900, 108),
    fill("3", "BUY", "09:40:00", 325, 95),
    fill("4", "SELL", "10:52:00", 325, 92),
  ];
  const assigned = assignFillsToLogs([second, first], fills);
  check("900-qty log takes the 900-qty trip", assigned.get("a")?.map((f) => f.tradeId), ["1", "2"]);
  check("325-qty log takes the 325-qty trip", assigned.get("b")?.map((f) => f.tradeId), ["3", "4"]);
}

console.log("\nA small scalper trade never absorbs a large 9:16 round trip");
{
  const scalp = {
    ...log("scalp", null, null),
    source: "momentum-scalper" as const,
    quantity: 75,
    createdAt: "2026-08-25T05:20:00.000Z",
  };
  const big = { ...log("big", null, null), quantity: 8385, createdAt: "2026-08-25T04:09:00.000Z" };
  const fills = [
    fill("1", "BUY", "09:16:01", 8385, 100),
    fill("2", "SELL", "09:39:00", 8385, 92),
    fill("3", "BUY", "10:45:00", 75, 60),
    fill("4", "SELL", "10:50:00", 75, 63),
  ];
  const assigned = assignFillsToLogs([scalp, big], fills);
  check("scalper keeps only its 75-qty trip", assigned.get("scalp")?.map((f) => f.tradeId), ["3", "4"]);
  check("9:16 keeps the 8385-qty trip", assigned.get("big")?.map((f) => f.tradeId), ["1", "2"]);
  check("scalper quantity stays 75", assigned.get("scalp")?.[0]?.quantity, 75);
}

console.log("\nNo credible candidate leaves the log empty rather than mis-attributed");
{
  const morning = { ...log("a", "09:20", "09:30"), quantity: 900 };
  const stray = { ...log("b", "14:30", "14:40"), quantity: 4242, createdAt: "2026-08-25T09:10:00.000Z" };
  const fills = [fill("1", "BUY", "09:20:05", 900, 100), fill("2", "SELL", "09:29:00", 900, 108)];
  const assigned = assignFillsToLogs([morning, stray], fills);
  check("matching log is filled", assigned.get("a")?.map((f) => f.tradeId), ["1", "2"]);
  check("unrelated log stays empty", assigned.get("b")?.length, 0);
}

console.log("\nOne trip is never shared between two logs");
{
  const a = { ...log("a", "10:15", "10:25"), quantity: 75 };
  const b = { ...log("b", "10:16", "10:26"), quantity: 75 };
  const fills = [fill("1", "BUY", "10:15:02", 75, 150), fill("2", "SELL", "10:24:58", 75, 158)];
  const assigned = assignFillsToLogs([a, b], fills);
  const total = (assigned.get("a")?.length ?? 0) + (assigned.get("b")?.length ?? 0);
  check("the two fills land on exactly one log", total, 2);
}

console.log("\nStill-open leg has no realised P&L");
{
  const summary = summarise(SYMBOL, [fill("1", "BUY", "10:15:02", 75, 150)], "x");
  check("realised is null while unsold", summary.realisedPnl, null);
  check("avg sell is null", summary.avgSellPrice, null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
