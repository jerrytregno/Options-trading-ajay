/**
 * Print 9:15 open−5 backtest summary (requires Kite session in data/kite-session.json).
 * Run: npx tsx scripts/run-nine-fifteen-high-minus5-backtest.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ensureHighMinus5Backtest } from "../server/nine-fifteen-high-minus5-backtest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionPath = path.join(__dirname, "..", "data", "kite-session.json");

if (!fs.existsSync(sessionPath)) {
  console.error("No data/kite-session.json — connect Kite in the app first.");
  process.exit(1);
}

const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { accessToken?: string };
if (!session.accessToken) {
  console.error("kite-session.json has no accessToken");
  process.exit(1);
}

const { data } = await ensureHighMinus5Backtest(session.accessToken, 365, true);
const all = data.all.stats;
const red = data.red915Only.stats;
const openAtOpen = data.openAtOpen.stats;

console.log("\n9:15 backtest summary");
console.log(`${data.from} → ${data.to}\n`);

console.log("=== Open − 5 entry · TP entry − 10 ===");
console.log(`Sessions:       ${all.sessions}`);
console.log(`Win (in 9:15):  ${all.wins}  (${all.inMinuteWinPct}% of entered)`);
console.log(`Late win:       ${all.lateWins}`);
console.log(`Loss:           ${all.losses}`);
console.log(`No entry:       ${all.noEntry}`);
console.log(`TP hit rate:    ${all.winRatePct}%\n`);

console.log("=== Open − 5 entry · red 9:15 only ===");
console.log(`Sessions:       ${red.sessions}  (${red.excludedSessions ?? 0} green/flat skipped)`);
console.log(`Win (in 9:15):  ${red.wins}  (${red.inMinuteWinPct}% of entered)`);
console.log(`Late win:       ${red.lateWins}`);
console.log(`Loss:           ${red.losses}`);
console.log(`No entry:       ${red.noEntry}`);
console.log(`TP hit rate:    ${red.winRatePct}%\n`);

console.log("=== Enter at 9:15 open · TP open − 10 ===");
console.log(`Sessions:       ${openAtOpen.sessions}`);
console.log(`Win (in 9:15):  ${openAtOpen.wins}  (${openAtOpen.inMinuteWinPct}% of entered)`);
console.log(`Late win:       ${openAtOpen.lateWins}`);
console.log(`Loss:           ${openAtOpen.losses}`);
console.log(`TP hit rate:    ${openAtOpen.winRatePct}%`);
