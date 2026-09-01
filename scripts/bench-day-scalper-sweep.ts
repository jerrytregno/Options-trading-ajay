/**
 * Sizing check for widening the year sweep to a third (close→mark) dimension.
 * Times one synthetic session across the full config grid.
 */
import { DAY_SCALPER_RULES, simulateDayScalperTrades } from "../server/day-scalper.js";
import {
  DAY_SCALPER_YEAR_CLOSE_MARKS,
  DAY_SCALPER_YEAR_INITIAL_STOPS,
  DAY_SCALPER_YEAR_MIN_MOVES,
} from "../src/types/day-scalper-year.js";
import type { DayScalperCandle } from "../src/types/day-scalper.js";

function syntheticSession(seed: number): DayScalperCandle[] {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const out: DayScalperCandle[] = [];
  let price = 24000;
  for (let mins = 9 * 60 + 15; mins <= 15 * 60 + 30; mins += 1) {
    const drift = (rand() - 0.5) * 24;
    const open = price;
    const close = open + drift;
    const high = Math.max(open, close) + rand() * 8;
    const low = Math.min(open, close) - rand() * 8;
    price = close;
    out.push({
      time: "",
      timeIst: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`,
      mins,
      open,
      high,
      low,
      close,
    });
  }
  return out;
}

const SESSIONS = 246;
const days = Array.from({ length: 8 }, (_, i) => syntheticSession(i + 1));

const grid2d = DAY_SCALPER_YEAR_MIN_MOVES.length * DAY_SCALPER_YEAR_INITIAL_STOPS.length;
const grid3d = grid2d * DAY_SCALPER_YEAR_CLOSE_MARKS.length;
console.log(`grid: 2D ${grid2d} configs · 3D ${grid3d} configs · ${SESSIONS} sessions`);

let tradeTotal = 0;
const started = performance.now();
for (const candles of days) {
  for (const minMovePts of DAY_SCALPER_YEAR_MIN_MOVES) {
    for (const initialStopPts of DAY_SCALPER_YEAR_INITIAL_STOPS) {
      for (const minCloseMarkPts of DAY_SCALPER_YEAR_CLOSE_MARKS) {
        const { trades } = simulateDayScalperTrades(
          candles,
          { ...DAY_SCALPER_RULES, minMovePts, initialStopPts, minCloseMarkPts },
          "Monday",
        );
        tradeTotal += trades.length;
      }
    }
  }
}
const elapsed = performance.now() - started;

const perDay = elapsed / days.length;
console.log(`3D sweep: ${perDay.toFixed(0)} ms per session → ${((perDay * SESSIONS) / 1000).toFixed(1)} s for the year`);
console.log(`avg trades per config-session: ${(tradeTotal / (days.length * grid3d)).toFixed(2)}`);
console.log(
  `if every trade were stored: ~${((tradeTotal / days.length) * SESSIONS).toLocaleString()} compact rows for the year`,
);
console.log(`totals-only payload: ${grid3d} configs × ~15 fields ≈ ${((grid3d * 15 * 8) / 1e6).toFixed(1)} MB raw numbers`);
console.log(
  `day-rows payload: ${grid3d} × ${SESSIONS} = ${(grid3d * SESSIONS).toLocaleString()} rows ≈ ${((grid3d * SESSIONS * 80) / 1e6).toFixed(0)} MB JSON`,
);
