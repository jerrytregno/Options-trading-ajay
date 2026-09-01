/**
 * Sanity check for the mid-session backtest (signal bar → next-bar entry → ±target race).
 *
 * Feeds synthetic Kite minute candles through the real pipeline so the aggregation, the window
 * bounds and the win/loss classification are all exercised end to end.
 *
 * Everything is derived from the configured bar size, so this keeps working when
 * NINE_FIFTEEN_MID_BAR_MINUTES changes. Each scripted day is built as:
 *   spike (arms the signal) → 9 flat minutes → slow ±2/min drift that resolves the trade.
 * The flat gap makes the entry price independent of where the block boundaries land, and the
 * drift is gentle enough that no block clears the signal threshold on its own.
 *
 * Run: npx esbuild scripts/check-mid-backtest.ts --bundle --platform=node --format=esm \
 *        --outfile=/tmp/chkmid.mjs && node /tmp/chkmid.mjs
 */
import {
  fetchNineFifteenCandleHistory,
  NINE_FIFTEEN_MID_BAR_MINUTES,
  NINE_FIFTEEN_MID_SIGNAL_MOVE,
  NINE_FIFTEEN_MID_STOP,
  NINE_FIFTEEN_MID_STOP_LEVELS,
  NINE_FIFTEEN_MID_SIGNAL_THRESHOLDS,
  NINE_FIFTEEN_MID_TARGET,
  type CandleFetcher,
} from "../server/nine-fifteen-candles.js";

const BASE = 24000;
/** Every synthetic 9:15 bar opens flat and closes +20, below the signal threshold. */
const OPEN_BAR_MOVE = 20;
const SESSION_START = 9 * 60 + 15;
const SESSION_END = 15 * 60 + 30;
/** Every run in the result is now built off raw 1-min Kite candles. */
const BAR = 1;
/**
 * Block size used only to script a move that needs aggregation to be visible. Nothing in the
 * result aggregates any more, so that day is purely a negative test.
 */
const AGG_BAR = NINE_FIFTEEN_MID_BAR_MINUTES;

/** Flat minutes between the signal and the drift, so the entry block is always quiet. */
const FLAT_GAP = 10;
const DRIFT_STEP = 2;
/** Drift bars needed to travel past the ±target level at DRIFT_STEP per minute. */
const DRIFT_BARS = Math.ceil((NINE_FIFTEEN_MID_TARGET + 1) / DRIFT_STEP);
/** Drift bar (1-based) that first touches the profit target at DRIFT_STEP per minute. */
const BARS_TO_TARGET = Math.ceil(NINE_FIFTEEN_MID_TARGET / DRIFT_STEP);
/** Drift bar (1-based) that first touches the −stop level at DRIFT_STEP per minute. */
const BARS_TO_STOP = Math.ceil(NINE_FIFTEEN_MID_STOP / DRIFT_STEP);
/**
 * Quiet bars carry a 1-pt wick, so after the drift ends the session peaks one point beyond the
 * drift's last close — that wick is what a winner's run past the target comes from.
 */
const WICK = 1;
const EXPECTED_BEYOND = DRIFT_BARS * DRIFT_STEP + WICK - NINE_FIFTEEN_MID_TARGET;
/** A loser only ever gets the quiet-bar wick in its favour before the stop. */
const EXPECTED_SHORT = NINE_FIFTEEN_MID_TARGET - WICK;

const blockStart = (mins: number) =>
  SESSION_START + Math.floor((mins - SESSION_START) / AGG_BAR) * AGG_BAR;
const hhmmss = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;

type ScriptedBar = { mins: number; delta: number; highExtra?: number; lowExtra?: number };

type DayPlan = {
  /** Minute of the last bar in the move that arms the signal. */
  lastSignalMins: number;
  bars: ScriptedBar[];
  /** Signed open→close travel of the signal block. */
  signalMove: number;
};

/** One big minute that arms the signal, optionally followed by a resolving drift. */
function spikeDay(
  spikeMins: number,
  spikeDelta: number,
  driftSign: -1 | 0 | 1,
  driftBars = DRIFT_BARS,
): DayPlan {
  const bars: ScriptedBar[] = [{ mins: spikeMins, delta: spikeDelta }];
  if (driftSign !== 0) {
    for (let i = 0; i < driftBars; i += 1) {
      bars.push({
        mins: spikeMins + FLAT_GAP + i,
        delta: driftSign * DRIFT_STEP,
        highExtra: 0,
        lowExtra: 0,
      });
    }
  }
  return { lastSignalMins: spikeMins, bars, signalMove: spikeDelta };
}

/**
 * A move that only exists once bars are aggregated: BAR consecutive minutes, each too small to
 * arm a signal on its own, filling exactly one block.
 */
function aggregateOnlyDay(nearMins: number, driftSign: -1 | 0 | 1): DayPlan {
  const start = blockStart(nearMins);
  const perBar = Math.ceil((NINE_FIFTEEN_MID_SIGNAL_MOVE + 1) / AGG_BAR);
  const bars: ScriptedBar[] = [];
  for (let i = 0; i < AGG_BAR; i += 1) bars.push({ mins: start + i, delta: perBar });

  const lastSignalMins = start + AGG_BAR - 1;
  if (driftSign !== 0) {
    for (let i = 0; i < DRIFT_BARS; i += 1) {
      bars.push({
        mins: lastSignalMins + FLAT_GAP + i,
        delta: driftSign * DRIFT_STEP,
        highExtra: 0,
        lowExtra: 0,
      });
    }
  }
  return { lastSignalMins, bars, signalMove: perBar * AGG_BAR };
}

/**
 * `count` back-to-back candles each moving `delta`, so a momentum-confirmation run arms on the
 * last one and entry lands on the candle after it.
 */
function runDay(startMins: number, delta: number, count: number, driftSign: -1 | 0 | 1): DayPlan {
  const bars: ScriptedBar[] = [];
  for (let i = 0; i < count; i += 1) bars.push({ mins: startMins + i, delta });

  const lastSignalMins = startMins + count - 1;
  if (driftSign !== 0) {
    for (let i = 0; i < DRIFT_BARS; i += 1) {
      bars.push({
        mins: lastSignalMins + FLAT_GAP + i,
        delta: driftSign * DRIFT_STEP,
        highExtra: 0,
        lowExtra: 0,
      });
    }
  }
  return { lastSignalMins, bars, signalMove: delta };
}

/** A streak one candle too short, capped by an opposite candle that resets the count. */
function shortStreakDay(startMins: number, delta: number, count: number): DayPlan {
  const bars: ScriptedBar[] = [];
  for (let i = 0; i < count; i += 1) bars.push({ mins: startMins + i, delta });
  bars.push({ mins: startMins + count, delta: -delta });
  return { lastSignalMins: startMins + count, bars, signalMove: -delta };
}

/** Two big candles back to back but pointing opposite ways — momentum is broken, so no signal. */
function whipsawDay(startMins: number, delta: number): DayPlan {
  return {
    lastSignalMins: startMins + 1,
    bars: [
      { mins: startMins, delta },
      { mins: startMins + 1, delta: -delta },
    ],
    signalMove: -delta,
  };
}

const PLANS: Record<string, DayPlan> = {
  // Monday · CE signal at 10:30 that drifts up into the target.
  "2026-08-17": spikeDay(10 * 60 + 30, 60, 1),
  // Friday · PE signal at 11:00 that drifts down into the target.
  "2026-08-14": spikeDay(11 * 60, -60, -1),
  // Wednesday · CE signal at 12:00 that drifts down far enough to hit the −70 stop.
  "2026-08-12": spikeDay(12 * 60, 60, -1, BARS_TO_STOP),
  // Tuesday · CE signal at 13:00 that never moves again — must time out at the 14:00 cut-off.
  "2026-08-11": spikeDay(13 * 60, 60, 0),
  // Wednesday · same flat trade on a normal day — must run to the 15:30 cut-off instead.
  "2026-08-05": spikeDay(13 * 60, 60, 0),
  // Tuesday · signal at 14:00, so entry would land after the Tuesday cut-off — never taken.
  "2026-08-04": spikeDay(14 * 60, 60, 0),
  // 9:50 — before the 10:00 window, must be ignored.
  "2026-08-13": spikeDay(9 * 60 + 50, 60, 1),
  // 15:05 — after the 14:59 window, must be ignored.
  "2026-08-10": spikeDay(15 * 60 + 5, 60, 1),
  // Spread across 3 minutes and never big enough in any single one — invisible to 1-min bars.
  "2026-08-07": aggregateOnlyDay(13 * 60 + 30, 1),
  // Below the 25-pt bar but above 20/15/10: only the looser 1-min thresholds should take these.
  "2026-08-19": spikeDay(11 * 60 + 30, 22, 0),
  "2026-08-06": spikeDay(11 * 60 + 30, 18, 0),
  "2026-08-03": spikeDay(11 * 60 + 30, 12, 0),
  // Thursday · two consecutive +12 candles, so the confirmation run arms and enters on the third.
  "2026-08-20": runDay(11 * 60, 12, 2, 1),
  // Tuesday · +12 then −12 back to back — big enough but opposite, so confirmation must reject it.
  "2026-08-18": whipsawDay(11 * 60, 12),
  // Thursday · ten tiny green candles in a row — colour alone must arm the fade on the eleventh.
  "2026-07-30": runDay(11 * 60, 3, 10, -1),
  // Wednesday · nine green candles then a red one — one short, so the 10-candle fade must not arm.
  "2026-07-29": shortStreakDay(11 * 60, 3, 9),
  // Tuesday · five green candles — arms the 5-candle fade on the sixth.
  "2026-07-28": runDay(11 * 60, 3, 5, -1),
  // Monday · four green then a red — one short for the 5-candle fade.
  "2026-07-27": shortStreakDay(11 * 60, 3, 4),
};

/** Ten same-colour candles in a row — arms the 10-candle exhaustion fade. */
const STREAK10_DAY = "2026-07-30";
/** Nine in a row then a reversal — one candle short of the 10-candle fade. */
const SHORT10_STREAK_DAY = "2026-07-29";
/** Five same-colour candles — arms the 5-candle exhaustion fade. */
const STREAK5_DAY = "2026-07-28";
/** Four in a row then a reversal — one candle short of the 5-candle fade. */
const SHORT5_STREAK_DAY = "2026-07-27";

/** Only day in the script where two same-direction 10-pt candles land back to back. */
const TWO_CANDLE_DAY = "2026-08-20";
/** Two 10-pt candles back to back, but opposite — must never arm a confirmation signal. */
const WHIPSAW_DAY = "2026-08-18";

/** Days whose only signal is a sub-25 spike, keyed by the smallest threshold that takes it. */
const LOOSE_SIGNAL_DAYS = {
  move20: "2026-08-19",
  move15: "2026-08-06",
  move10: "2026-08-03",
} as const;

const TUESDAY_DEADLINE = 14 * 60;
const NORMAL_DEADLINE = SESSION_END;

function isWeekday(dateKey: string): boolean {
  const day = new Date(`${dateKey}T12:00:00+05:30`).getUTCDay();
  return day !== 0 && day !== 6;
}

function datesBetween(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${fromKey}T12:00:00+05:30`);
  const end = new Date(`${toKey}T12:00:00+05:30`);
  while (cursor.getTime() <= end.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    if (isWeekday(key)) out.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function buildDay(dateKey: string): unknown[] {
  const scripted = new Map((PLANS[dateKey]?.bars ?? []).map((b) => [b.mins, b]));
  const candles: unknown[] = [];
  let price = BASE;

  for (let mins = SESSION_START; mins <= SESSION_END; mins += 1) {
    const bar = mins === SESSION_START ? { mins, delta: OPEN_BAR_MOVE } : scripted.get(mins);
    const open = price;
    const close = bar ? open + bar.delta : open;
    const high = Math.max(open, close) + (bar?.highExtra ?? 1);
    const low = Math.min(open, close) - (bar?.lowExtra ?? 1);
    price = close;

    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    candles.push([`${dateKey}T${hh}:${mm}:00+05:30`, open, high, low, close, 1000]);
  }

  return candles;
}

const fakeFetcher: CandleFetcher = async (_token, instrument, _interval, from, to) => {
  const dates = datesBetween(from.slice(0, 10), to.slice(0, 10));
  const candles: unknown[] = [];
  for (const date of dates) candles.push(...buildDay(date));
  return { instrument, candles };
};

const result = await fetchNineFifteenCandleHistory("fake-token", fakeFetcher, 365, true, false);
const mid = result.midBacktest1m;

console.log(
  `bar ${mid.barMinutes} min · signal ${mid.signalMovePoints} · target ${mid.targetPoints} ·`,
  `window ${mid.windowFromIst}–${mid.windowToIst}`,
);
console.log("sessions scanned:", mid.sessionsScanned);
console.log(
  `cut-off ${mid.deadlineIst} · Tuesday ${mid.deadlineIstTuesday} ·`,
  `${mid.skippedAfterDeadline} signal(s) skipped for landing past it`,
);
console.log(
  "signals:", mid.totalSignals,
  "| CE", mid.ceSignals, "PE", mid.peSignals,
  "| wins", mid.wins, "losses", mid.losses, "(timed out", mid.timedOut, ")",
  "| winPct", mid.winPct.toFixed(2),
);
console.table(
  mid.rows.map((r) => ({
    date: r.date,
    signal: r.signalTimeIst,
    move: r.signalMovePts,
    side: r.side,
    entry: r.entryTimeIst,
    price: r.entryIndexPrice,
    target: r.targetIndexPrice,
    stop: r.stopIndexPrice,
    outcome: r.outcome,
    exit: r.exitTimeIst,
    cutoff: r.deadlineIst,
    past: r.beyondTargetPts,
    short: r.shortOfTargetPts,
    timeout: r.timeoutMovePts,
  })),
);

let failures = 0;
const expect = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(ok ? "ok  " : "FAIL", label, "=>", got, ok ? "" : `(want ${want})`);
};

expect("bar size", mid.barMinutes, BAR);
expect("signal threshold", mid.signalMovePoints, NINE_FIFTEEN_MID_SIGNAL_MOVE);
expect("target", mid.targetPoints, NINE_FIFTEEN_MID_TARGET);
expect("stop", mid.stopPoints, NINE_FIFTEEN_MID_STOP);
expect("avg past target (wins)", mid.avgBeyondTargetPts, EXPECTED_BEYOND);
expect("max past target (wins)", mid.maxBeyondTargetPts, EXPECTED_BEYOND);
expect("avg short of target (losses)", mid.avgShortOfTargetPts, EXPECTED_SHORT);
// The grid re-buckets the same trades, so every axis has to add back up to the headline counts.
const gridCells = mid.grid.rows.flatMap((row) => row.cells);
const sum = (pick: (c: (typeof gridCells)[number]) => number) =>
  gridCells.reduce((total, cell) => total + pick(cell), 0);
expect("session dates listed", mid.sessionDates.length, mid.sessionsScanned);
expect("session dates newest first", mid.sessionDates[0], [...mid.sessionDates].sort().reverse()[0]);
expect(
  "every signal lands on a scanned session",
  mid.rows.every((row) => mid.sessionDates.includes(row.date)),
  true,
);
expect("grid row count", mid.grid.rows.length, 10);
expect("grid last slot", mid.grid.rows[9]?.fromIst, "14:30");
expect("grid last slot end", mid.grid.rows[9]?.toIst, "15:00");
expect(
  "tuesday inactive on last slot",
  JSON.stringify(mid.grid.rows[9]?.inactiveWeekdays),
  JSON.stringify(["Tuesday"]),
);
expect("grid wins reconcile", sum((c) => c.wins), mid.wins);
expect("grid losses reconcile", sum((c) => c.losses), mid.losses);
expect("grid timeouts reconcile", sum((c) => c.timedOut), mid.timedOut);
expect("grid grand total wins", mid.grid.total.wins, mid.wins);
expect("grid grand total net", mid.grid.total.netPoints, 2 * NINE_FIFTEEN_MID_TARGET - NINE_FIFTEEN_MID_STOP);
expect(
  "grid column totals reconcile",
  mid.grid.columnTotals.reduce((t, c) => t + c.wins + c.losses, 0),
  mid.totalSignals,
);
expect(
  "grid row totals reconcile",
  mid.grid.rows.reduce((t, r) => t + r.total.wins + r.total.losses, 0),
  mid.totalSignals,
);

// One stop at −70, two timeouts flat — net = 2×20 − 70.
expect("total profit points", mid.totalProfitPoints, 2 * NINE_FIFTEEN_MID_TARGET);
expect("total loss points", mid.totalLossPoints, NINE_FIFTEEN_MID_STOP);
expect("net points", mid.netPoints, 2 * NINE_FIFTEEN_MID_TARGET - NINE_FIFTEEN_MID_STOP);
expect("normal cut-off", mid.deadlineIst, hhmmss(NORMAL_DEADLINE));
expect("tuesday cut-off", mid.deadlineIstTuesday, hhmmss(TUESDAY_DEADLINE));
expect("total signals", mid.totalSignals, 5);
expect("wins", mid.wins, 2);
expect("losses (stopped + timed out)", mid.losses, 3);
expect("timed out", mid.timedOut, 2);
expect("skipped for landing past cut-off", mid.skippedAfterDeadline, 1);
expect("win pct", Number(mid.winPct.toFixed(2)), 40);

expect(
  "avg trades per session",
  mid.avgTradesPerSession,
  Number((mid.totalSignals / mid.sessionsScanned).toFixed(2)),
);

// sideTotals + avgMinutesToStop are precomputed server-side so the page never walks `rows`.
// They must reconcile exactly with the rows they replaced.
const tradePnl = (row: (typeof mid.rows)[number]) => {
  if (row.outcome === "target") return NINE_FIFTEEN_MID_TARGET;
  if (row.outcome === "stop") return -NINE_FIFTEEN_MID_STOP;
  return row.timeoutMovePts ?? 0;
};

for (const side of ["CE", "PE"] as const) {
  const rows = mid.rows.filter((row) => row.side === side);
  expect(
    `sideTotals ${side} wins`,
    mid.sideTotals[side].wins,
    rows.filter((row) => row.outcome === "target").length,
  );
  expect(
    `sideTotals ${side} losses`,
    mid.sideTotals[side].losses,
    rows.filter((row) => row.outcome !== "target").length,
  );
  expect(
    `sideTotals ${side} net`,
    mid.sideTotals[side].netPoints,
    Number(rows.reduce((sum, row) => sum + tradePnl(row), 0).toFixed(2)),
  );
}

expect(
  "sideTotals cover every trade",
  mid.sideTotals.CE.wins + mid.sideTotals.CE.losses + mid.sideTotals.PE.wins + mid.sideTotals.PE.losses,
  mid.totalSignals,
);

const stopMins = mid.rows
  .filter((row) => row.outcome === "stop")
  .map((row) => row.minutesToExit)
  .filter((m): m is number => m != null);
expect(
  "avgMinutesToStop",
  mid.avgMinutesToStop,
  stopMins.length > 0 ? stopMins.reduce((a, b) => a + b, 0) / stopMins.length : null,
);

const byDate = new Map(mid.rows.map((r) => [r.date, r]));

/** Times the engine should report. On 1-min bars the signal minute is the spike itself. */
function expectDay(
  date: string,
  side: "CE" | "PE",
  outcome: "target" | "stop" | "timeout",
  deadline = NORMAL_DEADLINE,
) {
  const plan = PLANS[date];
  const row = byDate.get(date);
  const signalBlock = plan.lastSignalMins;
  expect(`${date} present`, row != null, true);
  if (!row) return;
  expect(`${date} side`, row.side, side);
  expect(`${date} signal move`, row.signalMovePts, plan.signalMove);
  expect(`${date} signal block`, row.signalTimeIst, hhmmss(signalBlock));
  expect(`${date} entry block`, row.entryTimeIst, hhmmss(signalBlock + BAR));
  expect(`${date} outcome`, row.outcome, outcome);
  expect(`${date} cut-off`, row.deadlineIst, hhmmss(deadline));

  if (outcome === "timeout") {
    // Squared off on the last bar of the day it was still allowed to hold.
    expect(`${date} exit`, row.exitTimeIst, hhmmss(deadline));
    expect(`${date} minutes held`, row.minutesToExit, deadline - (signalBlock + BAR));
    expect(`${date} flat at cut-off`, row.timeoutMovePts, 0);
    expect(`${date} past target`, row.beyondTargetPts, null);
    expect(`${date} short of target`, row.shortOfTargetPts, EXPECTED_SHORT);
    return;
  }

  expect(
    `${date} exit`,
    row.exitTimeIst,
    hhmmss(
      plan.lastSignalMins +
        FLAT_GAP +
        (outcome === "stop" ? BARS_TO_STOP : BARS_TO_TARGET) -
        1,
    ),
  );
  expect(`${date} timeout move`, row.timeoutMovePts, null);
  if (outcome === "target") {
    expect(`${date} past target`, row.beyondTargetPts, EXPECTED_BEYOND);
    expect(`${date} short of target`, row.shortOfTargetPts, null);
  } else {
    expect(`${date} past target`, row.beyondTargetPts, null);
    expect(`${date} short of target`, row.shortOfTargetPts, EXPECTED_SHORT);
  }
}

expectDay("2026-08-17", "CE", "target");
expectDay("2026-08-14", "PE", "target");
expectDay("2026-08-12", "CE", "stop");
// Same flat trade, two different cut-offs.
expectDay("2026-08-11", "CE", "timeout", TUESDAY_DEADLINE);
expectDay("2026-08-05", "CE", "timeout", NORMAL_DEADLINE);
expect("09:50 signal ignored (before window)", byDate.has("2026-08-13"), false);
expect("15:05 signal ignored (after window)", byDate.has("2026-08-10"), false);
expect("tuesday 14:00 signal never entered", byDate.has("2026-08-04"), false);
// Spread over 3 minutes, so no single minute clears 25 — nothing aggregates any more.
expect("aggregation-only move invisible to 1-min bars", byDate.has("2026-08-07"), false);
expect("22-pt spike below the 25-pt threshold", byDate.has(LOOSE_SIGNAL_DAYS.move20), false);
expect("18-pt spike below the 25-pt threshold", byDate.has(LOOSE_SIGNAL_DAYS.move15), false);
expect("12-pt spike below the 25-pt threshold", byDate.has(LOOSE_SIGNAL_DAYS.move10), false);

// --- 1-min runs: same +10 target and −70 stop, four different signal thresholds ---
console.log("\n--- 1-min signal thresholds ---");

const matrix = result.midBacktest1mTp10BySignalAndStop;
const move25 = matrix[25][70];
const move20 = matrix[20][70];
const move15 = matrix[15][70];
const move10 = matrix[10][70];

expect("midBacktest1mTp10 aliases 25/70", result.midBacktest1mTp10.totalSignals, move25.totalSignals);

const hasSignalOn = (stats: typeof move25, date: string) =>
  stats.rows.some((row) => row.date === date);

for (const [label, stats, wantMove] of [
  ["25-pt", move25, NINE_FIFTEEN_MID_SIGNAL_MOVE],
  ["20-pt", move20, 20],
  ["15-pt", move15, 15],
  ["10-pt", move10, 10],
] as const) {
  console.log(
    `${label}: ${stats.totalSignals} signals · target ${stats.targetPoints} · stop ${stats.stopPoints} · bar ${stats.barMinutes}m`,
  );
  expect(`${label} reports its threshold`, stats.signalMovePoints, wantMove);
  expect(`${label} target stays +10`, stats.targetPoints, 10);
  expect(`${label} stop stays −70`, stats.stopPoints, NINE_FIFTEEN_MID_STOP);
  expect(`${label} uses 1-min bars`, stats.barMinutes, 1);
  expect(`${label} scans the same sessions`, stats.sessionsScanned, mid.sessionsScanned);
}

// A looser trigger can only ever add signals, never drop one the stricter run took.
expect("20-pt takes at least every 25-pt signal", move20.totalSignals >= move25.totalSignals, true);
expect("15-pt takes at least every 20-pt signal", move15.totalSignals >= move20.totalSignals, true);
expect("10-pt takes at least every 15-pt signal", move10.totalSignals >= move15.totalSignals, true);

// The three scripted sub-25 spikes are what separate the four thresholds.
expect("25-pt run skips the 22-pt spike", hasSignalOn(move25, LOOSE_SIGNAL_DAYS.move20), false);
expect("20-pt run takes the 22-pt spike", hasSignalOn(move20, LOOSE_SIGNAL_DAYS.move20), true);
expect("15-pt run takes the 22-pt spike", hasSignalOn(move15, LOOSE_SIGNAL_DAYS.move20), true);
expect("10-pt run takes the 22-pt spike", hasSignalOn(move10, LOOSE_SIGNAL_DAYS.move20), true);
expect("25-pt run skips the 18-pt spike", hasSignalOn(move25, LOOSE_SIGNAL_DAYS.move15), false);
expect("20-pt run skips the 18-pt spike", hasSignalOn(move20, LOOSE_SIGNAL_DAYS.move15), false);
expect("15-pt run takes the 18-pt spike", hasSignalOn(move15, LOOSE_SIGNAL_DAYS.move15), true);
expect("10-pt run takes the 18-pt spike", hasSignalOn(move10, LOOSE_SIGNAL_DAYS.move15), true);
expect("25-pt run skips the 12-pt spike", hasSignalOn(move25, LOOSE_SIGNAL_DAYS.move10), false);
expect("20-pt run skips the 12-pt spike", hasSignalOn(move20, LOOSE_SIGNAL_DAYS.move10), false);
expect("15-pt run skips the 12-pt spike", hasSignalOn(move15, LOOSE_SIGNAL_DAYS.move10), false);
expect("10-pt run takes the 12-pt spike", hasSignalOn(move10, LOOSE_SIGNAL_DAYS.move10), true);

// --- Stop sweep at each signal threshold: seven stops, same entries within each block ---
console.log("\n--- stop sweep by signal threshold ---");

expect(
  "four signal blocks",
  NINE_FIFTEEN_MID_SIGNAL_THRESHOLDS.every((t) => matrix[t]),
  true,
);

for (const threshold of NINE_FIFTEEN_MID_SIGNAL_THRESHOLDS) {
  const byStop = matrix[threshold];
  const baseline = byStop[70];
  console.log(`\n±${threshold} pt · ${baseline.totalSignals} entries at −70`);
  expect(`±${threshold} has every stop level`, Object.keys(byStop).length, NINE_FIFTEEN_MID_STOP_LEVELS.length);

  for (const stop of NINE_FIFTEEN_MID_STOP_LEVELS) {
    const run = byStop[stop];
    console.log(`  −${stop}: ${run.wins}W/${run.losses}L · net ${run.netPoints}`);
    expect(`±${threshold} −${stop} reports its stop`, run.stopPoints, stop);
    expect(`±${threshold} −${stop} keeps +10 target`, run.targetPoints, 10);
    expect(`±${threshold} −${stop} keeps trigger`, run.signalMovePoints, threshold);
    expect(`±${threshold} −${stop} same entry count`, run.totalSignals, baseline.totalSignals);
    expect(
      `±${threshold} −${stop} same entry dates`,
      JSON.stringify(run.rows.map((r) => r.date)),
      JSON.stringify(baseline.rows.map((r) => r.date)),
    );
    expect(`±${threshold} −${stop} grid net`, run.grid.total.netPoints, run.netPoints);
  }

  for (let i = 1; i < NINE_FIFTEEN_MID_STOP_LEVELS.length; i += 1) {
    const wider = byStop[NINE_FIFTEEN_MID_STOP_LEVELS[i - 1]];
    const tighter = byStop[NINE_FIFTEEN_MID_STOP_LEVELS[i]];
    expect(
      `±${threshold} −${tighter.stopPoints} wins ≤ −${wider.stopPoints}`,
      tighter.wins <= wider.wins,
      true,
    );
  }
}

for (const stop of NINE_FIFTEEN_MID_STOP_LEVELS) {
  expect(`±25 −${stop} net`, matrix[25][stop].netPoints, 2 * 10 - stop);
}

// --- ±10 pt entry duplicate at +5 take-profit ---
console.log("\n--- ±10 pt entry at +5 take-profit ---");

const move10Tp5 = result.midBacktest1mMove10Tp5ByStop;
const move10Tp5Baseline = move10Tp5[70];

expect("move10 tp5 has every stop level", Object.keys(move10Tp5).length, NINE_FIFTEEN_MID_STOP_LEVELS.length);
console.log(`${move10Tp5Baseline.totalSignals} entries · target ${move10Tp5Baseline.targetPoints}`);

expect("move10 tp5 matches ±10 tp10 entry count", move10Tp5Baseline.totalSignals, move10.totalSignals);
expect(
  "move10 tp5 same entry dates",
  JSON.stringify(move10Tp5Baseline.rows.map((r) => `${r.date}@${r.entryTimeIst}`)),
  JSON.stringify(move10.rows.map((r) => `${r.date}@${r.entryTimeIst}`)),
);

for (const stop of NINE_FIFTEEN_MID_STOP_LEVELS) {
  const run = move10Tp5[stop];
  console.log(`  −${stop}: ${run.wins}W/${run.losses}L · net ${run.netPoints}`);
  expect(`move10 tp5 −${stop} reports its stop`, run.stopPoints, stop);
  expect(`move10 tp5 −${stop} keeps +5 target`, run.targetPoints, 5);
  expect(`move10 tp5 −${stop} keeps ±10 trigger`, run.signalMovePoints, 10);
  expect(`move10 tp5 −${stop} same entry count`, run.totalSignals, move10Tp5Baseline.totalSignals);
  expect(`move10 tp5 −${stop} grid net`, run.grid.total.netPoints, run.netPoints);
  expect(`move10 tp5 −${stop} wins ≥ tp10`, run.wins >= matrix[10][stop].wins, true);
}

// --- Two-candle confirmation: both candles ±10 the same way, entry on the third ---
console.log("\n--- two-candle confirmation (±10, enter on 3rd) ---");

const twoCandle = result.midBacktest1mTwoCandleTp10ByStop;
const twoBaseline = twoCandle[70];

expect("two-candle has every stop level", Object.keys(twoCandle).length, NINE_FIFTEEN_MID_STOP_LEVELS.length);
console.log(`${twoBaseline.totalSignals} confirmed entries vs ${move10.totalSignals} single-candle`);

// Demanding a second candle can only ever remove signals the single-candle run took.
expect(
  "confirmation takes fewer trades than single ±10",
  twoBaseline.totalSignals < move10.totalSignals,
  true,
);
expect(
  "every confirmed entry also exists in the single ±10 run",
  twoBaseline.rows.every((row) =>
    move10.rows.some((r) => r.date === row.date && r.entryTimeIst === row.entryTimeIst),
  ),
  true,
);

// The scripted run day arms; the whipsaw and the lone spikes must not.
expect("takes the two-candle run day", hasSignalOn(twoBaseline, TWO_CANDLE_DAY), true);
expect("rejects opposite-direction pair", hasSignalOn(twoBaseline, WHIPSAW_DAY), false);
expect("rejects the lone 12-pt spike", hasSignalOn(twoBaseline, LOOSE_SIGNAL_DAYS.move10), false);
expect("rejects the lone 22-pt spike", hasSignalOn(twoBaseline, LOOSE_SIGNAL_DAYS.move20), false);
expect("single ±10 does take the whipsaw candles", hasSignalOn(move10, WHIPSAW_DAY), true);

// Entry is the candle after the confirming one, i.e. the third of the run.
const confirmedRow = twoBaseline.rows.find((row) => row.date === TWO_CANDLE_DAY);
expect(`${TWO_CANDLE_DAY} row present`, confirmedRow != null, true);
if (confirmedRow) {
  const plan = PLANS[TWO_CANDLE_DAY];
  expect(`${TWO_CANDLE_DAY} side`, confirmedRow.side, "CE");
  expect(`${TWO_CANDLE_DAY} confirms on 2nd candle`, confirmedRow.signalTimeIst, hhmmss(plan.lastSignalMins));
  expect(`${TWO_CANDLE_DAY} enters on 3rd candle`, confirmedRow.entryTimeIst, hhmmss(plan.lastSignalMins + BAR));
  expect(`${TWO_CANDLE_DAY} hits target`, confirmedRow.outcome, "target");
}

for (const stop of NINE_FIFTEEN_MID_STOP_LEVELS) {
  const run = twoCandle[stop];
  console.log(`  −${stop}: ${run.wins}W/${run.losses}L · net ${run.netPoints}`);
  expect(`two-candle −${stop} reports its stop`, run.stopPoints, stop);
  expect(`two-candle −${stop} keeps +10 target`, run.targetPoints, 10);
  expect(`two-candle −${stop} keeps ±10 trigger`, run.signalMovePoints, 10);
  expect(`two-candle −${stop} uses 1-min bars`, run.barMinutes, 1);
  expect(`two-candle −${stop} same entry count`, run.totalSignals, twoBaseline.totalSignals);
  expect(
    `two-candle −${stop} same entry dates`,
    JSON.stringify(run.rows.map((r) => r.date)),
    JSON.stringify(twoBaseline.rows.map((r) => r.date)),
  );
  expect(`two-candle −${stop} grid net`, run.grid.total.netPoints, run.netPoints);
  // The run drifts straight into target, so no stop is ever touched — net is +10 at every level.
  expect(`two-candle −${stop} net`, run.netPoints, 10);
}

// --- Exhaustion fade: 10 same-colour candles, reverse on the 11th, +10 target ---
console.log("\n--- exhaustion fade (10 same-colour, reverse on 11th, +10) ---");

const fade10ByStop = result.midBacktest1mExhaustion10Tp10ByStop;
const fade10Baseline = fade10ByStop[70];

expect("fade10 has every stop level", Object.keys(fade10ByStop).length, NINE_FIFTEEN_MID_STOP_LEVELS.length);
console.log(`${fade10Baseline.totalSignals} fade-10 entries · target ${fade10Baseline.targetPoints}`);

expect("fade10 arms on the ten-candle streak", hasSignalOn(fade10Baseline, STREAK10_DAY), true);
expect("nine candles is not enough for fade10", hasSignalOn(fade10Baseline, SHORT10_STREAK_DAY), false);
expect("streak invisible to the ±10 block", hasSignalOn(move10, STREAK10_DAY), false);
expect("streak invisible to two-candle block", hasSignalOn(twoBaseline, STREAK10_DAY), false);

const fade10Row = fade10Baseline.rows.find((row) => row.date === STREAK10_DAY);
expect(`${STREAK10_DAY} row present`, fade10Row != null, true);
if (fade10Row) {
  const plan = PLANS[STREAK10_DAY];
  expect(`${STREAK10_DAY} green run buys PE`, fade10Row.side, "PE");
  expect(`${STREAK10_DAY} arms on the 10th candle`, fade10Row.signalTimeIst, hhmmss(plan.lastSignalMins));
  expect(`${STREAK10_DAY} enters on the 11th`, fade10Row.entryTimeIst, hhmmss(plan.lastSignalMins + BAR));
  expect(
    `${STREAK10_DAY} target is entry −10`,
    fade10Row.targetIndexPrice,
    Number((fade10Row.entryIndexPrice - 10).toFixed(2)),
  );
  expect(`${STREAK10_DAY} hits target`, fade10Row.outcome, "target");
}

for (const stop of NINE_FIFTEEN_MID_STOP_LEVELS) {
  const run = fade10ByStop[stop];
  console.log(`  −${stop}: ${run.wins}W/${run.losses}L · net ${run.netPoints}`);
  expect(`fade10 −${stop} reports its stop`, run.stopPoints, stop);
  expect(`fade10 −${stop} keeps +10 target`, run.targetPoints, 10);
  expect(`fade10 −${stop} uses 1-min bars`, run.barMinutes, 1);
  expect(`fade10 −${stop} same entry count`, run.totalSignals, fade10Baseline.totalSignals);
  expect(`fade10 −${stop} grid net`, run.grid.total.netPoints, run.netPoints);
  expect(
    `fade10 −${stop} always trades against the run`,
    run.rows.every((r) => (r.signalMovePts > 0 ? r.side === "PE" : r.side === "CE")),
    true,
  );
}

// --- Exhaustion fade: 5 same-colour candles, reverse on the 6th, +10 target ---
console.log("\n--- exhaustion fade (5 same-colour, reverse on 6th, +10) ---");

const fade5ByStop = result.midBacktest1mExhaustion5Tp10ByStop;
const fade5Baseline = fade5ByStop[70];

expect("fade5 has every stop level", Object.keys(fade5ByStop).length, NINE_FIFTEEN_MID_STOP_LEVELS.length);
console.log(`${fade5Baseline.totalSignals} fade-5 entries · target ${fade5Baseline.targetPoints}`);

expect("fade5 takes at least every fade10 signal", fade5Baseline.totalSignals >= fade10Baseline.totalSignals, true);
expect("fade5 arms on the five-candle streak", hasSignalOn(fade5Baseline, STREAK5_DAY), true);
expect("four candles is not enough for fade5", hasSignalOn(fade5Baseline, SHORT5_STREAK_DAY), false);
expect("fade5 also arms on the ten-candle streak", hasSignalOn(fade5Baseline, STREAK10_DAY), true);

const fade5Row = fade5Baseline.rows.find((row) => row.date === STREAK5_DAY);
expect(`${STREAK5_DAY} row present`, fade5Row != null, true);
if (fade5Row) {
  const plan = PLANS[STREAK5_DAY];
  expect(`${STREAK5_DAY} green run buys PE`, fade5Row.side, "PE");
  expect(`${STREAK5_DAY} arms on the 5th candle`, fade5Row.signalTimeIst, hhmmss(plan.lastSignalMins));
  expect(`${STREAK5_DAY} enters on the 6th`, fade5Row.entryTimeIst, hhmmss(plan.lastSignalMins + BAR));
  expect(
    `${STREAK5_DAY} target is entry −10`,
    fade5Row.targetIndexPrice,
    Number((fade5Row.entryIndexPrice - 10).toFixed(2)),
  );
  expect(`${STREAK5_DAY} hits target`, fade5Row.outcome, "target");
}

for (const stop of NINE_FIFTEEN_MID_STOP_LEVELS) {
  const run = fade5ByStop[stop];
  console.log(`  −${stop}: ${run.wins}W/${run.losses}L · net ${run.netPoints}`);
  expect(`fade5 −${stop} reports its stop`, run.stopPoints, stop);
  expect(`fade5 −${stop} keeps +10 target`, run.targetPoints, 10);
  expect(`fade5 −${stop} uses 1-min bars`, run.barMinutes, 1);
  expect(`fade5 −${stop} same entry count`, run.totalSignals, fade5Baseline.totalSignals);
  expect(`fade5 −${stop} grid net`, run.grid.total.netPoints, run.netPoints);
  expect(
    `fade5 −${stop} always trades against the run`,
    run.rows.every((r) => (r.signalMovePts > 0 ? r.side === "PE" : r.side === "CE")),
    true,
  );
}

// Same invariant the other way round — the follow blocks must trade *with* the candle.
expect(
  "non-fade blocks trade with the run",
  [mid, move10, twoBaseline].every((s) =>
    s.rows.every((r) => (r.signalMovePts > 0 ? r.side === "CE" : r.side === "PE")),
  ),
  true,
);

for (let i = 1; i < NINE_FIFTEEN_MID_STOP_LEVELS.length; i += 1) {
  const wider = fade10ByStop[NINE_FIFTEEN_MID_STOP_LEVELS[i - 1]];
  const tighter = fade10ByStop[NINE_FIFTEEN_MID_STOP_LEVELS[i]];
  expect(`fade10 −${tighter.stopPoints} wins ≤ −${wider.stopPoints}`, tighter.wins <= wider.wins, true);
  const wider5 = fade5ByStop[NINE_FIFTEEN_MID_STOP_LEVELS[i - 1]];
  const tighter5 = fade5ByStop[NINE_FIFTEEN_MID_STOP_LEVELS[i]];
  expect(`fade5 −${tighter5.stopPoints} wins ≤ −${wider5.stopPoints}`, tighter5.wins <= wider5.wins, true);
}

// A doji has no colour, so it can never arm any block nor sit inside a streak.
expect(
  "no signal ever comes from a flat candle",
  [mid, move10, twoBaseline, fade10Baseline, fade5Baseline].every((s) =>
    s.rows.every((r) => r.signalMovePts !== 0),
  ),
  true,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
