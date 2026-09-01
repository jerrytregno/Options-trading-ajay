/**
 * Manual sanity check for keeping the 9:16 bot and the momentum scalper fully separate:
 * · own-leg P&L never inherits another bot's lots in the same contract
 * · a square-off only ever sells the bot's own quantity
 * · the momentum scalper hands off on the 9:16 trade ending, not on a clock time
 *
 * Run: npx tsx scripts/check-bot-separation.ts
 */
import {
  isPast916EntryWindow,
  ownLegUnrealisedPnl,
  pnlPctOfEntryCost,
} from "../server/nine-sixteen-logic.js";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} · ${label} · got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log("\n--- own-leg P&L ignores the other bot's lots ---");
// 9:16 holds 65 @ 100, momentum scalper holds 65 @ 120 in the same strike, LTP 110.
// Broker's aggregate unrealised would be (110-110)*130 = 0, which is not our leg's truth.
check("9:16 leg P&L at LTP 110", ownLegUnrealisedPnl(100, 65, 110), 650);
check("scalper leg P&L at LTP 110", ownLegUnrealisedPnl(120, 65, 110), -650);
check("9:16 leg pct at LTP 110", pnlPctOfEntryCost(650, 100, 65), 10);
check("no mark yet", ownLegUnrealisedPnl(100, 65, null), null);

console.log("\n--- square-off sells only our own quantity ---");
// Mirrors the Math.min(brokerQty, ownRemainingQty) guard in both bots' exit loops.
const sellQty = (brokerQty: number, ownQty: number) =>
  brokerQty <= 0 || ownQty <= 0 ? 0 : Math.min(brokerQty, ownQty);
check("both bots hold 65 each, we own 65", sellQty(130, 65), 65);
check("only our leg is open", sellQty(65, 65), 65);
check("broker already flat", sellQty(0, 65), 0);
check("we own nothing", sellQty(130, 0), 0);

console.log("\n--- momentum scalper handoff ---");
const at = (t: string) => new Date(`2026-08-19T${t}+05:30`).getTime();
// settled = past the 9:16 entry window AND the 9:16 bot is not holding a trade.
const settled = (t: string, occupied: boolean) => isPast916EntryWindow(at(t)) && !occupied;

check("09:16:20 · 9:16 still entering", settled("09:16:20", true), false);
check("09:16:20 · 9:16 idle but window open", settled("09:16:20", false), false);
check("09:16:31 · 9:16 took no trade", settled("09:16:31", false), true);
check("09:22:00 · 9:16 trade just closed", settled("09:22:00", false), true);
check("09:30:00 · 9:16 still in a trade", settled("09:30:00", true), false);
check("11:40:00 · 9:16 still in a trade", settled("11:40:00", true), false);
check("11:40:00 · 9:16 trade closed", settled("11:40:00", false), true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
