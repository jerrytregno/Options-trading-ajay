export type NineFifteenDirection = "up" | "down" | "flat";

export const NINE_FIFTEEN_RUPEE_LEVELS = [10, 20, 30, 40, 50] as const;
export type NineFifteenRupeLevel = (typeof NINE_FIFTEEN_RUPEE_LEVELS)[number];

/** 15-min checkpoints after 9:15 — did Nifty hit target by this time? */
export const NINE_FIFTEEN_TIME_CHECKPOINTS = ["9:30", "9:45", "10:00"] as const;
export type NineFifteenTimeCheckpoint = (typeof NINE_FIFTEEN_TIME_CHECKPOINTS)[number];

/** ~NSE cash sessions per year (matches server backtest 1y slice). */
export const NSE_SESSIONS_ONE_YEAR = 252;
/** ~5 years of NSE cash sessions for the extended live backtest. */

/** CE/PE strategy backtest exit targets (Nifty index points from 9:15 open). */
export const NINE_FIFTEEN_CEPE_TARGETS = [10, 20, 30, 40, 50, 100] as const;
export type NineFifteenCePeTarget = (typeof NINE_FIFTEEN_CEPE_TARGETS)[number];

export interface NineFifteenCheckpointLevels {
  high: number;
  low: number;
  upLevels: Record<NineFifteenCePeTarget, boolean>;
  downLevels: Record<NineFifteenCePeTarget, boolean>;
}

export interface NineFifteenCandleRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  direction: NineFifteenDirection;
  /** Max rise from 9:15:00 open during the 1-min bar (high − open). */
  maxGainFromOpen: number;
  /** Max fall from 9:15:00 open during the 1-min bar (open − low). */
  maxLossFromOpen: number;
  gainLevels: Record<NineFifteenRupeLevel, boolean>;
  lossLevels: Record<NineFifteenRupeLevel, boolean>;
  /** Session low after 9:16 entry (for ±30 backtest exits). */
  sessionLowAfter916?: number;
  /** Session high after 9:16 entry (for ±30 backtest exits). */
  sessionHighAfter916?: number;
  /** Session high after 9:15 (through 3:30 PM). */
  sessionHigh: number;
  /** Session low after 9:15 (through 3:30 PM). */
  sessionLow: number;
  /** Max Nifty rise from 9:15 open anytime during the session. */
  maxDayUpFrom915: number;
  /** Max Nifty fall from 9:15 open anytime during the session. */
  maxDayDownFrom915: number;
  /** Session high touched open + ₹10 … +₹50 (buy CE target zone). */
  dayUpLevels: Record<NineFifteenRupeLevel, boolean>;
  /** Session low touched open − ₹10 … −₹50 (buy PE target zone). */
  dayDownLevels: Record<NineFifteenRupeLevel, boolean>;
  /** High/low vs 9:15 open by 9:30, 9:45, 10:00 (inclusive). */
  checkpoints: Record<NineFifteenTimeCheckpoint, NineFifteenCheckpointLevels>;
  /** First ±25 from 9:16 Kite open using bars from 9:16 (incl. entry minute; hit time = candle open). */
  firstHitUp30?: NineFifteenTargetHit | null;
  firstHitDown30?: NineFifteenTargetHit | null;
  /** First ±20 from 9:16 Kite open (same exit window as ±30). */
  firstHitUp20?: NineFifteenTargetHit | null;
  firstHitDown20?: NineFifteenTargetHit | null;
  /** First ±25 from 9:16 Kite open (same exit window as ±30). */
  firstHitUp25?: NineFifteenTargetHit | null;
  firstHitDown25?: NineFifteenTargetHit | null;
  /** Main live-aligned exit: ±25 until 10:01 · ±20 from 10:01 · ±15 from 11:01. */
  tiered25Then20Then15Up?: NineFifteenTargetHit | null;
  tiered25Then20Then15Down?: NineFifteenTargetHit | null;
  /** Tighter consolidated main: ±20 until 10:01 · ±50/3 from 10:01 · ±35/3 from 11:01 (×scale). */
  tieredConsolidatedAltMainUp?: NineFifteenTargetHit | null;
  tieredConsolidatedAltMainDown?: NineFifteenTargetHit | null;
  /** First ±15 from 9:16 Kite open (near-miss fixed target). */
  firstHitUp15?: NineFifteenTargetHit | null;
  firstHitDown15?: NineFifteenTargetHit | null;
  /** Near-miss: ±20 before 10:01 IST, ±10 from 10:01 (first hit per direction). */
  switch20Then10After1001Up?: NineFifteenTargetHit | null;
  switch20Then10After1001Down?: NineFifteenTargetHit | null;
  /** Tighter consolidated near-miss: ±50/3 before 10:01, ±20/3 from 10:01 (×scale). */
  switchConsolidatedAltNearUp?: NineFifteenTargetHit | null;
  switchConsolidatedAltNearDown?: NineFifteenTargetHit | null;
  /** Flat consolidated exit hits from 9:16 (±50/40/30/20 at Sensex scale). */
  consolidatedFlat50Up?: NineFifteenTargetHit | null;
  consolidatedFlat50Down?: NineFifteenTargetHit | null;
  consolidatedFlat40Up?: NineFifteenTargetHit | null;
  consolidatedFlat40Down?: NineFifteenTargetHit | null;
  consolidatedFlat30Up?: NineFifteenTargetHit | null;
  consolidatedFlat30Down?: NineFifteenTargetHit | null;
  consolidatedFlat20Up?: NineFifteenTargetHit | null;
  consolidatedFlat20Down?: NineFifteenTargetHit | null;
  /** Backtest entry: Kite 9:16 candle open at 09:16:00. */
  entryAtLive916?: NineFifteenTradeEntry | null;
  /**
   * Two-candle confirmation study: the 9:16 bar's own close − open, the 9:18 open used as that
   * study's entry, and the band exits measured from it (bars from 9:18 only).
   */
  change916?: number | null;
  entryAt918?: NineFifteenTradeEntry | null;
  confirm918MainUp?: NineFifteenTargetHit | null;
  confirm918MainDown?: NineFifteenTargetHit | null;
  confirm918NearUp?: NineFifteenTargetHit | null;
  confirm918NearDown?: NineFifteenTargetHit | null;
  confirm918ExpiryUp?: NineFifteenTargetHit | null;
  confirm918ExpiryDown?: NineFifteenTargetHit | null;
  /** Nifty-only 9:17 two-candle confirm — ±15→±10@10:02→±5@11:02 from 9:17 entry. */
  niftyConfirm917Up?: NineFifteenTargetHit | null;
  niftyConfirm917Down?: NineFifteenTargetHit | null;
  /** Custom ±60/40/30 tiered exits from 9:16 entry (Sensex study). */
  custom60MainUp?: NineFifteenTargetHit | null;
  custom60MainDown?: NineFifteenTargetHit | null;
  custom60NearUp?: NineFifteenTargetHit | null;
  custom60NearDown?: NineFifteenTargetHit | null;
  custom60StopCe?: NineFifteenTargetHit | null;
  custom60StopPe?: NineFifteenTargetHit | null;
  maxFavorableCeAfter918?: NineFifteenMfePeak | null;
  maxFavorablePeAfter918?: NineFifteenMfePeak | null;
  /** Prior NSE session 15:30 close (from Kite minute candles). */
  prevDayClose?: number | null;
  /** 9:15 open − prev day close (gap at session start). */
  gapFromPrevClose?: number | null;
  gapFromPrevCloseDirection?: NineFifteenDirection | null;
  /** ±25 before 10:01 IST, ±20 from 10:01 (first hit per direction). */
  switch25Then20After1010Up?: NineFifteenTargetHit | null;
  switch25Then20After1010Down?: NineFifteenTargetHit | null;
  /** ±25 before 11:01 IST, ±15 from 11:01. */
  switch25Then15After1101Up?: NineFifteenTargetHit | null;
  switch25Then15After1101Down?: NineFifteenTargetHit | null;
  /** Max favorable move after entry (CE = high−entry, PE = entry−low) from 9:16+ bars. */
  maxFavorableCeAfterEntry?: NineFifteenMfePeak | null;
  maxFavorablePeAfterEntry?: NineFifteenMfePeak | null;
  /** Wilder RSI(14) on 1-min Nifty closes at the 9:15 bar (uses prior session minutes). */
  rsi915?: number | null;
  /** Wilder RSI(14) at the 9:16 bar close (includes 9:15 bar in lookback). */
  rsi916?: number | null;
  /**
   * Breakout backtest only: first adverse touch of the fixed stop from the 9:16 entry
   * (CE stops below entry, PE stops above). Null when the day is not a trade day.
   */
  breakoutStopHit?: NineFifteenTargetHit | null;
  /** Breakout backtest Tuesday only: first ±10 touch from 9:16 entry. */
  breakoutTuesdayTargetHit?: NineFifteenTargetHit | null;
  /** Stop distance used for this row's band — main 70 · near-miss 70. */
  breakoutStopPoints?: number | null;
  /** Closest approach to tiered profit target over the full 9:16–15:30 session. */
  breakoutClosestToTarget?: NineFifteenBreakoutTargetApproach | null;
  /** Tuesday only: closest the session came to the flat ±10 target (0 gap once touched). */
  tuesdayTenClosest?: NineFifteenBreakoutTargetApproach | null;
}

/** One Tuesday session in the flat ±10 log (live Tuesday exit rule). */
export interface NineFifteenTuesdayTargetRow {
  date: string;
  /** 9:15 close − open that decided the side. */
  change915: number;
  /** null when the day was skipped (|Δ| < 11) — no trade, so no target. */
  side: "CE" | "PE" | null;
  band: "main" | "near_miss" | null;
  /** 9:16 Kite open used as entry. */
  entryIndexPrice: number | null;
  /** entry ±10 (CE up · PE down). */
  targetIndexPrice: number | null;
  /** First ±10 touch from 9:16. Null = never reached that day. */
  hit: NineFifteenTargetHit | null;
  /** Closest approach across 9:16–15:30 — how near it got on a miss. */
  closest: NineFifteenBreakoutTargetApproach | null;
}

export interface NineFifteenTuesdayTargetStats {
  targetPoints: number;
  totalTuesdays: number;
  tradeDays: number;
  skippedDays: number;
  hits: number;
  misses: number;
  /** Hits as a share of trade days (skipped Tuesdays excluded). */
  hitPct: number;
  rows: NineFifteenTuesdayTargetRow[];
}

/**
 * Mid-session backtest (study only): any signal bar between 10:00 and 14:20 IST that travels
 * far enough from its own open — up → CE, down → PE — entered at the next bar's open and
 * raced to ±`targetPoints` from that entry.
 */
export interface NineFifteenMidTradeRow {
  date: string;
  /** Start of the bar that produced the signal. */
  signalTimeIst: string;
  /** Signal bar close − open (signed). */
  signalMovePts: number;
  side: "CE" | "PE";
  /** Start of the next bar — the entry bar. */
  entryTimeIst: string;
  /** Entry bar open. */
  entryIndexPrice: number;
  /** entry + target for CE · entry − target for PE. */
  targetIndexPrice: number;
  /** entry − target for CE · entry + target for PE. */
  stopIndexPrice: number;
  /** Square-off time for this session: 15:30, or 14:00 on a Tuesday. */
  deadlineIst: string;
  /**
   * `timeout` = neither level printed before the cut-off, so the trade was squared off there.
   * It never reached the target, so it is scored as a loss.
   */
  outcome: "target" | "stop" | "timeout";
  /** Bar that touched target or stop, or the cut-off bar on a timeout. */
  exitTimeIst: string | null;
  /** Minutes between entry and exit. */
  minutesToExit: number | null;
  /** Best move in the trade direction up to the exit bar. */
  maxFavourablePts: number;
  /** Worst move against the trade up to the exit bar. */
  maxAdversePts: number;
  /** Move in the trade direction at the cut-off — only set when the trade timed out. */
  timeoutMovePts: number | null;
  /**
   * Winners only: extra points the index ran past the target before the cut-off, i.e. what a
   * wider target would have captured. 0 when the target was the high-water mark.
   */
  beyondTargetPts: number | null;
  /** Losers only (stopped or timed out): how far the best move fell short of the target. */
  shortOfTargetPts: number | null;
}

/** One weekday × time-slot bucket of the mid-session grid. */
export interface NineFifteenMidGridCell {
  wins: number;
  /** Everything that failed to reach the target — stops and timeouts together. */
  losses: number;
  /** Subset of `losses` that ran out of time rather than being stopped. */
  timedOut: number;
  /** Wins as a share of every trade in the bucket. Null when the bucket is empty. */
  winPct: number | null;
  /** Points booked in the bucket, timeouts marked to the cut-off price. */
  netPoints: number;
}

export interface NineFifteenMidGridRow {
  /** Slot start, HH:MM IST. */
  fromIst: string;
  /** Slot end, HH:MM IST. */
  toIst: string;
  /** Weekdays that never trade in this slot (shown as inactive in the grid). */
  inactiveWeekdays?: string[];
  /** One cell per entry in `NineFifteenMidGrid.weekdays`. */
  cells: NineFifteenMidGridCell[];
  total: NineFifteenMidGridCell;
}

/**
 * Mid-session results laid out as weekday (columns) × signal time slot (rows), so a bucket that
 * consistently wins or loses is visible at a glance.
 */
export interface NineFifteenMidGrid {
  slotMinutes: number;
  /** Column order — full weekday names, Monday first. */
  weekdays: string[];
  rows: NineFifteenMidGridRow[];
  /** One per weekday, aligned to `weekdays`. */
  columnTotals: NineFifteenMidGridCell[];
  total: NineFifteenMidGridCell;
}

/** Full stop sweep at each signal threshold, in points. */
export type NineFifteenMidStopLevel = 70 | 60 | 50 | 40 | 30 | 20 | 10;
/** @deprecated Use NineFifteenMidStopLevel — tighter-only slice. */
export type NineFifteenMidStopVariant = Exclude<NineFifteenMidStopLevel, 70>;
/** 1-min candle must travel at least this many points from its open to arm a trade. */
export type NineFifteenMidSignalThreshold = 25 | 20 | 15 | 10;

export interface NineFifteenMidBacktestStats {
  /** Signal/entry bar size in minutes, aggregated from Kite 1-min candles off the 9:15 open. */
  barMinutes: number;
  /** Minimum open→close travel on a signal bar that arms a trade. */
  signalMovePoints: number;
  /** Target and stop distance from the entry bar open. */
  targetPoints: number;
  /** Adverse move that stops the trade — may differ from `targetPoints`. */
  stopPoints: number;
  windowFromIst: string;
  windowToIst: string;
  /** Square-off time on a normal day. */
  deadlineIst: string;
  /** Square-off time on a Tuesday. */
  deadlineIstTuesday: string;
  sessionsScanned: number;
  /**
   * Every session the scan covered, newest first — including days that produced no signal, so a
   * bucket can be shown against its full set of trading days rather than just its hits.
   */
  sessionDates: string[];
  totalSignals: number;
  /** Signals dropped because the entry bar fell at or after that day's cut-off. */
  skippedAfterDeadline: number;
  ceSignals: number;
  peSignals: number;
  /** Target reached first. */
  wins: number;
  /** Never reached the target — stopped out or squared off at the cut-off. */
  losses: number;
  /** Subset of `losses` that ran out of time rather than being stopped. */
  timedOut: number;
  /** Wins as a share of every trade — nothing is excluded, since every trade now resolves. */
  winPct: number;
  /** Index points booked by every winning trade added up. */
  totalProfitPoints: number;
  /** Index points given up by every losing trade added up, as a positive number. */
  totalLossPoints: number;
  /** totalProfitPoints − totalLossPoints. */
  netPoints: number;
  avgMinutesToTarget: number | null;
  /** Average points a winner ran past the target before the cut-off. */
  avgBeyondTargetPts: number | null;
  /** Largest run past the target across all winners. */
  maxBeyondTargetPts: number | null;
  /** Average points a loser's best move fell short of the target. */
  avgShortOfTargetPts: number | null;
  /** Mean minutes from entry to exit for stopped-out trades only. */
  avgMinutesToStop: number | null;
  /**
   * CE/PE split of the same trades, precomputed so the client never has to walk `rows` — with
   * ~50 runs on the page that scan adds up to hundreds of thousands of iterations per render.
   */
  sideTotals: NineFifteenMidSideSplit;
  /** Weekday × signal-time breakdown of the same trades in `rows`. */
  grid: NineFifteenMidGrid;
  /**
   * Identifies this run's trade rows, which are served separately by
   * `/api/kite/mid-trade-rows`. The rows are ~93% of the payload and are only needed when a
   * grid cell is expanded, so shipping them with the page made every load wait on data almost
   * nobody opens.
   */
  runKey: string;
  /** Only populated by offline tooling; the API strips these in favour of `runKey`. */
  rows?: NineFifteenMidTradeRow[];
  /** Total signals divided by every session scanned — including quiet days with no trade. */
  avgTradesPerSession: number;
}

/** Wins, losses and net points booked by one option side. */
export interface NineFifteenMidSideTotals {
  wins: number;
  losses: number;
  netPoints: number;
}

export interface NineFifteenMidSideSplit {
  CE: NineFifteenMidSideTotals;
  PE: NineFifteenMidSideTotals;
}

/**
 * Breakout backtest (stop-loss study — backtest only, never used by the live bot).
 * Same 9:16 entry and same tiered index targets as the live backtest, plus a fixed adverse
 * stop measured from the entry price: main band ±70, near-miss band ±70.
 */
export interface NineFifteenBreakoutTargetApproach {
  timeIst: string;
  /** Bar extreme in trade direction (high for CE · low for PE). */
  indexPrice: number;
  /** Tiered target distance active at that minute (±25/±20 main · ±20/±10 near-miss). */
  targetPoints: number;
  targetIndexPrice: number;
  /** Index points still needed to reach target (0 if touched on that bar). */
  gapToTargetPts: number;
}

export interface NineFifteenBreakoutTrade {
  date: string;
  side: "CE" | "PE";
  band: "main" | "near_miss";
  /** 9:15 close − open that produced the signal. */
  change: number;
  entry: NineFifteenTradeEntry | null;
  /** Index target at entry (main 25 · near-miss 20) — tightens later in the day. */
  targetPoints: number;
  /** Fixed adverse stop distance from entry (main 70 · near-miss 70). */
  stopPoints: number;
  /** Tiered target touch, if the day ever reached it. */
  targetHit: NineFifteenTargetHit | null;
  /** Adverse stop touch, if the day ever reached it. */
  stopHit: NineFifteenTargetHit | null;
  /**
   * Minute in the session when Nifty came closest to the tiered profit target (9:16–15:30).
   */
  closestToTarget: NineFifteenBreakoutTargetApproach | null;
  /** `open` = neither level touched, trade rides to 15:30. */
  outcome: "target" | "stop" | "open";
  /** When the ±70 stop starts scanning for this session (11:01 Tue · 12:01 other days). */
  stopActiveFromIst: string;
}

export interface NineFifteenBreakoutStats {
  label: string;
  stopMainPoints: number;
  stopNearMissPoints: number;
  /** Default stop scan start (Mon/Wed–Fri). */
  stopActiveFromIst: string;
  /** Tuesday stop scan start. */
  stopActiveFromIstTuesday: string;
  sampleDays: number;
  tradeDays: number;
  /** Existing backtest with no stop-loss — baseline for comparison. */
  baseWins: number;
  baseLosses: number;
  baseWinPct: number;
  /** With the stop applied. */
  wins: number;
  stopped: number;
  openAtClose: number;
  winPct: number;
  /** Base wins the stop turned into losses (stop touched before the target). */
  missedWins: NineFifteenBreakoutTrade[];
  /** Base losses that hit the stop — exited early instead of riding to 15:30. */
  stoppedLosses: NineFifteenBreakoutTrade[];
}

/** Max favorable excursion after 9:16 entry (one Kite minute bar). */
export interface NineFifteenMfePeak {
  timeIst: string;
  indexPrice: number;
  movePts: number;
}

export interface NineFifteenTradeEntry {
  timeIst: string;
  indexPrice: number;
}

/** When ±target from 9:15 open was first reached (backtest estimate). */
export interface NineFifteenTargetHit {
  timeIst: string;
  levelLabel: string;
  /** Theoretical index level touched (entry ± points). */
  indexPrice: number;
  /**
   * Breakout stop only: actual candle extreme at exit (CE = bar low · PE = bar high).
   * May be beyond the stop level when the 1-min bar overshoots.
   */
  exitIndexPrice?: number;
  /** Breakout stop only: exitIndexPrice − indexPrice (signed index points). */
  exitVsStopPts?: number;
}

export interface NineFifteenLevelSummary {
  level: NineFifteenRupeLevel;
  hitCount: number;
  hitPct: number;
}

export interface NineFifteenCandlesResult {
  instrument: string;
  /** Which index this result was computed from. */
  indexId: "nifty";
  /** Display label, e.g. "Nifty 50" or "Sensex". */
  indexLabel: string;
  /** Point thresholds were multiplied by this relative to the Nifty baseline. */
  pointScale: number;
  /** Weekly options expiry weekday for this index. */
  expiryWeekday: string;
  daysRequested: number;
  /** Always Zerodha Kite historical minute candles for NSE:NIFTY 50. */
  dataSource: "zerodha_kite";
  fromDate: string;
  toDate: string;
  rows: NineFifteenCandleRow[];
  /** Count of valid NSE session rows in the 1y backtest slice (from Kite only). */
  nseSessionsOneYear: number;
  summary: {
    total: number;
    up: number;
    down: number;
    flat: number;
    upPct: number;
    downPct: number;
    gainLevels: NineFifteenLevelSummary[];
    lossLevels: NineFifteenLevelSummary[];
    dayUpLevels: NineFifteenLevelSummary[];
    dayDownLevels: NineFifteenLevelSummary[];
  };
  cePeGuide: NineFifteenCePeGuide;
  /** Follow UP→CE / DOWN→PE at ±25 with |9:15 diff| ≥ 15. */
  followFilterStats: NineFifteenFollowFilterStats;
  /** Hypothetical: 11 ≤ |9:15 Δ| < 15 · ±20 until 10:01 then ±10. */
  nearMissFollow: NineFifteenCePeStrategyStats;
  nearMissFollowFilterStats: NineFifteenFollowFilterStats;
  /**
   * Backtest consolidation (historical dual-band study): main + near-miss. Live 9:16 bot enters main only.
   */
  liveConsolidatedFollow: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStats: NineFifteenFollowFilterStats;
  /** |9:15 Δ| &lt; 11 split: 0–5.5 PE · 5.6–10.9 CE @ 9:16 (backtest of skipped days). */
  liveSmallBodyPutFollow?: NineFifteenCePeStrategyStats;
  liveSmallBodyPutFilterStats?: NineFifteenFollowFilterStats;
  liveSmallBodySplitBuckets?: NineFifteenSmallBodySplitBuckets;
  /** |9:15 Δ| &lt; 11 follow candle: UP→CE · DOWN→PE @ 9:16 (same exits). */
  liveSmallBodyDirectionFollow?: NineFifteenCePeStrategyStats;
  /** Red 9:15 · |Δ| ≥ 15 → PE @ 9:16 · main-band exits only (backtest). */
  liveRedPeMainFollow?: NineFifteenCePeStrategyStats;
  liveRedPeMainFilterStats?: NineFifteenFollowFilterStats;
  /** Red 9:15 · |Δ| > 10 (body) → PE @ 9:16 · main-band exits only (backtest). */
  liveRedPeBody10Follow?: NineFifteenCePeStrategyStats;
  liveRedPeBody10FilterStats?: NineFifteenFollowFilterStats;
  /** Same entries as `liveConsolidatedFollow` but tighter tiered exits. */
  liveConsolidatedFollowAlt: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStatsAlt: NineFifteenFollowFilterStats;
  /** Flat take-profit variants: main/near ±50/40, ±40/30, ±30/20 (Sensex scale). */
  liveConsolidatedFlatVariants: NineFifteenConsolidatedFlatVariant[];
  /** Nifty — 9:17 two-candle confirm with 9:15 |Δ| > 30 · 9:16 |Δ| > 10 · ±15/10/5 exits. */
  niftyConfirm917Follow?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats?: NineFifteenFollowFilterStats;
  /** Same 9:17 confirm study with 9:15 |Δ| > 11 · 9:16 |Δ| > 10. */
  niftyConfirm917Follow11?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats11?: NineFifteenFollowFilterStats;
  /** Backtest-only stop-loss study (±70 main / ±70 near-miss) — live bot has no stop. */
  breakout: NineFifteenBreakoutStats;
  /** Every Tuesday in the window vs the live flat ±10 exit — hit time or closest miss. */
  tuesdayTenPoint: NineFifteenTuesdayTargetStats;
  /** Mid-session study: 25-pt 1-min bar → next 1-min entry → +20 / −70 stop. */
  midBacktest1m: NineFifteenMidBacktestStats;
  midBacktest1mTp15: NineFifteenMidBacktestStats;
  /** Same as `midBacktest1mTp10BySignalAndStop[25][70]` — kept for callers that only need the baseline. */
  midBacktest1mTp10: NineFifteenMidBacktestStats;
  /**
   * +10 take-profit run at every stop level (70 → 10) for each 1-min signal threshold (25 → 10).
   * Each row in a block shares the same entries; only the stop changes.
   */
  midBacktest1mTp10BySignalAndStop: Record<
    NineFifteenMidSignalThreshold,
    Record<NineFifteenMidStopLevel, NineFifteenMidBacktestStats>
  >;
  /**
   * Duplicate of the ±10 pt 1-min entry block above, but take-profit is +5 / −5 at every stop.
   * Same entries — only the profit target changes.
   */
  midBacktest1mMove10Tp5ByStop: Record<
    NineFifteenMidStopLevel,
    NineFifteenMidBacktestStats
  >;
  /**
   * Momentum-confirmation variant: two consecutive 1-min candles must each move 10+ points the
   * same way, entry opens on the third candle. Same +10 target and stop sweep as the blocks above.
   */
  midBacktest1mTwoCandleTp10ByStop: Record<
    NineFifteenMidStopLevel,
    NineFifteenMidBacktestStats
  >;
  /**
   * Exhaustion/reversal: ten same-colour 1-min candles, then fade on the eleventh at +10 target.
   */
  midBacktest1mExhaustion10Tp10ByStop: Record<
    NineFifteenMidStopLevel,
    NineFifteenMidBacktestStats
  >;
  /**
   * Same fade rules with a shorter run — five same-colour candles, entry on the sixth at +10.
   */
  midBacktest1mExhaustion5Tp10ByStop: Record<
    NineFifteenMidStopLevel,
    NineFifteenMidBacktestStats
  >;
}

export interface NineFifteenConsolidatedFlatVariant {
  id: "flat50_40" | "flat40_30" | "flat30_20";
  mainTargetPoints: number;
  nearTargetPoints: number;
  follow: NineFifteenCePeStrategyStats;
  filterStats: NineFifteenFollowFilterStats;
}

export interface NineFifteenFollowBacktestBlock {
  fromDate: string;
  toDate: string;
  nseSessions: number;
  cePeGuide: NineFifteenCePeGuide;
  followFilterStats: NineFifteenFollowFilterStats;
  nearMissFollow: NineFifteenCePeStrategyStats;
  nearMissFollowFilterStats: NineFifteenFollowFilterStats;
  liveConsolidatedFollow: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStats: NineFifteenFollowFilterStats;
  liveSmallBodyPutFollow?: NineFifteenCePeStrategyStats;
  liveSmallBodyPutFilterStats?: NineFifteenFollowFilterStats;
  liveSmallBodySplitBuckets?: NineFifteenSmallBodySplitBuckets;
  liveSmallBodyDirectionFollow?: NineFifteenCePeStrategyStats;
  /** Red 9:15 · |Δ| ≥ 15 → PE @ 9:16 · main-band exits only (backtest). */
  liveRedPeMainFollow?: NineFifteenCePeStrategyStats;
  liveRedPeMainFilterStats?: NineFifteenFollowFilterStats;
  /** Red 9:15 · |Δ| > 10 (body) → PE @ 9:16 · main-band exits only (backtest). */
  liveRedPeBody10Follow?: NineFifteenCePeStrategyStats;
  liveRedPeBody10FilterStats?: NineFifteenFollowFilterStats;
  liveConsolidatedFollowAlt: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStatsAlt: NineFifteenFollowFilterStats;
  liveConsolidatedFlatVariants: NineFifteenConsolidatedFlatVariant[];
  /** Nifty — 9:17 two-candle confirm with 9:15 |Δ| > 30 · 9:16 |Δ| > 10 · ±15/10/5 exits. */
  niftyConfirm917Follow?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats?: NineFifteenFollowFilterStats;
  /** Same 9:17 confirm study with 9:15 |Δ| > 11 · 9:16 |Δ| > 10. */
  niftyConfirm917Follow11?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats11?: NineFifteenFollowFilterStats;
  breakout: NineFifteenBreakoutStats;
}

export interface NineFifteenFollowFilterStats {
  minAbsDiff: number;
  /** When true, entry requires |Δ| strictly above minAbsDiff (not ≥). */
  minAbsDiffExclusive?: boolean;
  /** When set, band is minAbsDiff ≤ |Δ| < maxAbsDiffExclusive (near-miss study). */
  maxAbsDiffExclusive?: number;
  targetPoints: number;
  totalFollowTrades: number;
  filteredTrades: number;
  wins: number;
  losses: number;
  winPct: number;
  skippedSmallBar: number;
  /** Optional UI copy overrides (e.g. live dual-band consolidation). */
  display?: {
    filterTitle: string;
    takenLabel: string;
    skippedLabel: string;
  };
}

/** |9:15 body below the live floor — split into PUT (small) and CE (larger) buckets. */
export const SMALL_BODY_MAX_EXCLUSIVE = 11;
export const SMALL_BODY_PUT_MAX_INCLUSIVE = 5.5;
export const SMALL_BODY_CE_MIN_INCLUSIVE = 5.6;

export interface NineFifteenSmallBodySplitBucketStats {
  rangeLabel: string;
  side: "CE" | "PE";
  trades: number;
  wins: number;
  losses: number;
  winPct: number;
}

export interface NineFifteenSmallBodySplitBuckets {
  put: NineFifteenSmallBodySplitBucketStats;
  call: NineFifteenSmallBodySplitBucketStats;
}

export type NineFifteenOptionSide = "CE" | "PE" | "WAIT";

/** Full-day target miss for a strategy rule (9:15 bar OHLC included). */
export interface NineFifteenCePeFailureTrade {
  date: string;
  side: "CE" | "PE";
  direction: NineFifteenDirection;
  /** 9:15 candle open (start). */
  open915: number;
  /** 9:15 candle close (end). */
  close915: number;
  /** close915 − open915 */
  change: number;
  /** 9:15 high − low when the entry filter uses candle range instead of body. */
  candleRange915?: number;
  /** Prior session close (15:30) and gap vs 9:15 open. */
  prevDayClose?: number | null;
  gapFromPrevClose?: number | null;
  gapFromPrevCloseDirection?: NineFifteenDirection | null;
  /** Session move in trade direction vs entry (points), Kite bars ≥9:16. */
  maxMoveInDirection: number;
  /** When MFE was reached (minute candle open; same granularity as target hits). */
  maxMovePeakAt?: string | null;
  /** Nifty level at best move (session high for CE, session low for PE in that minute). */
  maxMovePeakIndex?: number | null;
  targetPoints: number;
  /** Backtest entry: Kite 9:16 open at 09:16:00. */
  entryAt?: NineFifteenTradeEntry | null;
  /** First IST HH:MM:00 when ±target was reached (Kite minute open). */
  targetHitAt?: string | null;
  targetHit?: NineFifteenTargetHit | null;
  /** Index level for entry ± target (backtest exit). */
  exitTargetIndexPrice?: number | null;
  /** Session reached entry ± target on a Kite bar from 9:16 onward (incl. entry minute). */
  winConfirmed?: boolean;
  /**
   * ±25 backtest only: diagnostic two-phase alt (±20 from 10:01) when tiered primary missed.
   */
  altTargetAfter1010?: NineFifteenAltTargetAfterTime | null;
  /** Diagnostic: ±15 from 11:01 when tiered primary missed. */
  altTarget10After1010?: NineFifteenAltTargetAfterTime | null;
  /** RSI(14) on 1-min chart at 9:15 bar close (same as row.rsi915). */
  rsi915?: number | null;
  /** RSI(14) at 9:16 bar close (same as row.rsi916). */
  rsi916?: number | null;
}

/** Hypothetical exit: one target before a switch time, tighter target after. */
export interface NineFifteenAltTargetAfterTime {
  targetBeforePoints: number;
  targetAfterPoints: number;
  switchAfterIst: string;
  wouldWin: boolean;
  hit?: NineFifteenTargetHit | null;
}

export interface NineFifteenCheckpointHitStats {
  targetHits: number;
  targetHitPct: number;
}

export interface NineFifteenCePeStrategyStats {
  label: string;
  side: "CE" | "PE" | "MIXED";
  /** Full working-day sample (same for every row). */
  sampleDays: number;
  /** Days this rule would actually place a trade. */
  tradeDays: number;
  targetHits: number;
  /** Wins ÷ tradeDays (when the rule fires) — full session through 3:30 PM. */
  targetHitPct: number;
  /** Hit rate by 9:30 / 9:45 / 10:00 IST (same target, earlier cutoff). */
  checkpointHits: Record<NineFifteenTimeCheckpoint, NineFifteenCheckpointHitStats>;
  /** Days this rule traded but full-day target was not hit. */
  failures: NineFifteenCePeFailureTrade[];
  /** Full-day target hits with 9:15 bar detail (only populated for select rules). */
  successes: NineFifteenCePeFailureTrade[];
}

/** Same strategy rows backtested at a different Nifty index target (e.g. 50 vs 100). */
export interface NineFifteenCePeGuide {
  targetPoints: number;
  followDirection: NineFifteenCePeStrategyStats;
  alwaysCall: NineFifteenCePeStrategyStats;
  alwaysPut: NineFifteenCePeStrategyStats;
  minuteUpBuyCall: NineFifteenCePeStrategyStats;
  minuteDownBuyPut: NineFifteenCePeStrategyStats;
  minuteUpBuyPut: NineFifteenCePeStrategyStats;
  minuteDownBuyCall: NineFifteenCePeStrategyStats;
  bestStrategy: NineFifteenCePeStrategyStats;
  entryRule: string;
  todaySignal: {
    date: string;
    minuteDirection: NineFifteenDirection;
    side: NineFifteenOptionSide;
    note: string;
  } | null;
}
