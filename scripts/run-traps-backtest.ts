/**
 * Runs the Traps backtest from the terminal against the stored Kite session.
 *
 *   npx tsx scripts/run-traps-backtest.ts 2026-08-26 2026-08-28 [capital] [maxLots]
 */
import "dotenv/config";
import { loadKiteSession } from "../server/kite-session-store.js";
import {
  TRAPS_BACKTEST_DEFAULT_CAPITAL,
  TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
  TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
  buildTrapsBacktest,
} from "../server/traps-backtest.js";

const [from, to, capitalArg, lotsArg] = process.argv.slice(2);
if (!from || !to) {
  console.error("Usage: npx tsx scripts/run-traps-backtest.ts <from YYYY-MM-DD> <to YYYY-MM-DD> [capital] [maxLots]");
  process.exit(1);
}

const accessToken = process.env.KITE_ACCESS_TOKEN ?? loadKiteSession()?.accessToken;
if (!accessToken) {
  console.error("No Kite access token — connect Zerodha in the app or set KITE_ACCESS_TOKEN.");
  process.exit(1);
}

const inr = (value: number) =>
  `${value < 0 ? "-" : ""}₹${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;

const result = await buildTrapsBacktest(accessToken, {
  from,
  to,
  capital: Number(capitalArg) || TRAPS_BACKTEST_DEFAULT_CAPITAL,
  maxLots: Number(lotsArg) || TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
  premiumSafetyPct: TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
});

const o = result.overall;
console.log(`\nTraps backtest ${result.from} → ${result.to}  ·  capital ${inr(result.capital)}  ·  max ${result.maxLots} lots`);
console.log(`Trades ${o.trades}   Wins ${o.wins}   Losses ${o.losses}   Win rate ${o.winRatePct}%`);
console.log(`Gross ${inr(o.grossPnl)}   Charges ${inr(o.charges)}   Net ${inr(o.netPnl)}`);
console.log(`Avg win ${inr(o.avgWin)}   Avg loss ${inr(o.avgLoss)}   PF ${o.profitFactor ?? "—"}   Max DD ${inr(o.maxDrawdown)}`);
console.log(`Avg hold ${o.avgHoldMinutes} min   Streaks +${o.maxWinStreak} / -${o.maxLossStreak}`);

console.log("\nPer day");
for (const day of result.days) {
  if (day.error) {
    console.log(`  ${day.date} ${day.weekday.padEnd(9)} ERROR ${day.error}`);
    continue;
  }
  console.log(
    `  ${day.date} ${day.weekday.padEnd(9)} signals ${String(day.signals).padStart(3)}  gates ${String(day.gatePasses).padStart(3)}` +
      `  trades ${String(day.stats.trades).padStart(2)}  W/L ${day.stats.wins}/${day.stats.losses}  net ${inr(day.stats.netPnl)}`,
  );
}

console.log("\nBy 15-min entry bucket");
for (const bucket of result.buckets) {
  console.log(
    `  ${bucket.label}  trades ${String(bucket.stats.trades).padStart(2)}  W/L ${bucket.stats.wins}/${bucket.stats.losses}` +
      `  win% ${String(bucket.stats.winRatePct).padStart(5)}  net ${inr(bucket.stats.netPnl)}`,
  );
}
if (result.bestBucket) console.log(`  best: ${result.bestBucket.label} (${inr(result.bestBucket.stats.netPnl)})`);

console.log("\nBy side / ladder");
for (const row of [
  ...result.bySide.map((r) => ({ name: r.side, stats: r.stats })),
  ...result.byProfile.map((r) => ({
    name: r.profile === "opening" ? "09:15-09:20 ladder" : "standard ladder",
    stats: r.stats,
  })),
]) {
  console.log(
    `  ${row.name.padEnd(20)} trades ${String(row.stats.trades).padStart(3)}  W/L ${row.stats.wins}/${row.stats.losses}` +
      `  win% ${String(row.stats.winRatePct).padStart(6)}  avgW ${inr(row.stats.avgWin).padStart(9)}  avgL ${inr(row.stats.avgLoss).padStart(9)}  net ${inr(row.stats.netPnl)}`,
  );
}

console.log("\nOutcomes");
for (const row of result.outcomes) {
  console.log(`  ${row.outcome.padEnd(11)} ${String(row.count).padStart(3)}  net ${inr(row.netPnl)}`);
}

console.log("\nTrades");
for (const t of result.days.flatMap((d) => d.trades)) {
  console.log(
    `  ${t.date} ${t.entryTimeIst}→${t.exitTimeIst} ${t.side} ${t.tradingsymbol.padEnd(20)}` +
      ` in ${String(t.entryPremium).padStart(7)} out ${String(t.exitPremium).padStart(7)}` +
      ` ${String(t.pnlPct).padStart(7)}%  RSI ${t.signalRsi != null ? t.signalRsi.toFixed(1) : "—".padStart(5)}  ${t.lots}L  net ${inr(t.netPnl).padStart(10)}  ${t.outcome} (${t.exitProfile})`,
  );
}

if (result.warnings.length > 0) {
  console.log("\nWarnings");
  for (const warning of result.warnings) console.log(`  ${warning}`);
}
