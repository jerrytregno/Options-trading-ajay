/**
 * Audit harness for the day-scalper backtest.
 *
 * Feeds hand-built sessions through `simulateDayScalperTrades` to expose whether the entry bar
 * can decide its own outcome. Entry is at the pullback limit (close ∓ 2), so any target resolved
 * on the same bar would still be decided by data that also defined whether the fill happened.
 */
import { DAY_SCALPER_RULES, simulateDayScalperTrades } from "../server/day-scalper.js";
import type { DayScalperCandle } from "../src/types/day-scalper.js";

function bar(timeIst: string, open: number, high: number, low: number, close: number): DayScalperCandle {
  const [hour, minute] = timeIst.split(":").map(Number);
  return {
    time: `2026-08-25T${timeIst}:00+0530`,
    timeIst,
    mins: hour * 60 + minute,
    open,
    high,
    low,
    close,
  };
}

function pad(session: DayScalperCandle[], from: string, flat: number): DayScalperCandle[] {
  const [h, m] = from.split(":").map(Number);
  const out = [...session];
  for (let mins = h * 60 + m; mins <= 15 * 60 + 30; mins += 1) {
    const label = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    out.push(bar(label, flat, flat, flat, flat));
  }
  return out;
}

const rules = {
  ...DAY_SCALPER_RULES,
  minMovePts: 5,
  initialStopPts: 10,
  minCloseMarkPts: 2,
};

console.log("rules:", {
  minMovePts: rules.minMovePts,
  minCloseMarkPts: rules.minCloseMarkPts,
  initialStopPts: rules.initialStopPts,
  takeProfitFromClose: 3,
});

/* ---------------------------------------------------------------- scenario A
 * CE signal, pullback fill at 24013, then next bar collapses through the −10 stop.
 */
const crash = pad(
  [
    bar("09:30", 24000, 24016, 23999, 24015), // body +15 → CE
    bar("09:31", 24016, 24020, 24010, 24018), // open gate ok, low ≤ 24013 → entry 24013
    bar("09:32", 24018, 24018, 23970, 23972), // collapse through stop 24003
  ],
  "09:33",
  23972,
);

const a = simulateDayScalperTrades(crash, rules, "Monday");
console.log("\n[A] pullback fill then next bar collapses");
for (const t of a.trades) {
  console.log(
    `  ${t.side} sig ${t.signalTimeIst} body ${t.signalMovePts} | entry ${t.entryTimeIst} @ ${t.entryPrice} ` +
      `| close→mark ${t.signalToMarkPts} | exit ${t.exitTimeIst} @ ${t.exitPrice} ${t.outcome} | pnl ${t.pnlPts} ` +
      `| bars held ${t.barsHeld}`,
  );
}

/* ---------------------------------------------------------------- scenario B — PE mirror */
const spike = pad(
  [
    bar("09:30", 24000, 24001, 23984, 23985), // body −15 → PE, close 23985
    bar("09:31", 23984, 23987, 23982, 23986), // open ≤ 23984.5, high ≥ 23987 → entry 23987
    bar("09:32", 23986, 24030, 23986, 24028), // rips against PE
  ],
  "09:33",
  24028,
);

const b = simulateDayScalperTrades(spike, rules, "Monday");
console.log("\n[B] PE pullback fill then next bar rips");
for (const t of b.trades) {
  console.log(
    `  ${t.side} sig ${t.signalTimeIst} body ${t.signalMovePts} | entry ${t.entryTimeIst} @ ${t.entryPrice} ` +
      `| close→mark ${t.signalToMarkPts} | exit ${t.exitTimeIst} @ ${t.exitPrice} ${t.outcome} | pnl ${t.pnlPts} ` +
      `| bars held ${t.barsHeld}`,
  );
}

/* ---------------------------------------------------------------- scenario C — skip when pullback never reaches close − 2 */
console.log("\n[C] shallow pullback → no trade");
for (const pullback of [0.5, 1, 1.5, 1.9, 2, 3, 5]) {
  const session = pad(
    [
      bar("09:30", 24000, 24016, 23999, 24015),
      bar("09:31", 24016, 24020, 24015 - pullback, 24018),
      bar("09:32", 24018, 24018, 23960, 23962),
    ],
    "09:33",
    23962,
  );
  const res = simulateDayScalperTrades(session, rules, "Monday");
  const t = res.trades[0];
  console.log(
    `  pullback ${pullback.toFixed(1)} pts → ${t ? `${t.outcome} ${t.pnlPts > 0 ? "+" : ""}${t.pnlPts} pts` : `skipped (${res.summary.skipped[0]?.reason ?? "—"})`}`,
  );
}
