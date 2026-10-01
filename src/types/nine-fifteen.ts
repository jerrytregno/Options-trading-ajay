export type NineFifteenDirection = "up" | "down" | "flat";

export const NINE_FIFTEEN_RUPEE_LEVELS = [10, 20, 30, 40, 50] as const;
export type NineFifteenRupeLevel = (typeof NINE_FIFTEEN_RUPEE_LEVELS)[number];

/** 15-min checkpoints after 9:15 — did Nifty hit target by this time? */
export const NINE_FIFTEEN_TIME_CHECKPOINTS = ["9:30", "9:45", "10:00"] as const;
export type NineFifteenTimeCheckpoint = (typeof NINE_FIFTEEN_TIME_CHECKPOINTS)[number];

/** ~NSE cash sessions per year (matches server backtest 1y slice). */
export const NSE_SESSIONS_ONE_YEAR = 252;
/** Two calendar years of NSE sessions (~252 × 2). */
export const NSE_SESSIONS_TWO_YEARS = NSE_SESSIONS_ONE_YEAR * 2;
/** Calendar days to request from Kite for the 2-year backtest cache (matches server ceiling). */
export const BACKTEST_MAX_HISTORY_DAYS =
  Math.ceil(NSE_SESSIONS_TWO_YEARS * (365 / NSE_SESSIONS_ONE_YEAR)) + 120;
/** Max sessions the backtesting page can show. */
export const BACKTEST_MAX_SESSIONS = NSE_SESSIONS_TWO_YEARS;

/** Calendar lookback for a window button (matches server `calendarDaysForSessionLookback`). */
export function backtestDaysForSessions(sessions: number): number {
  return Math.min(
    BACKTEST_MAX_HISTORY_DAYS,
    Math.ceil(sessions * (365 / NSE_SESSIONS_ONE_YEAR)) + 45,
  );
}

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
  /** First ±10 from 9:16 Kite open (flat PE target). */
  firstHitUp10?: NineFifteenTargetHit | null;
  firstHitDown10?: NineFifteenTargetHit | null;
  /** First ±8 from 9:16 Kite open (flat PE target). */
  firstHitUp8?: NineFifteenTargetHit | null;
  firstHitDown8?: NineFifteenTargetHit | null;
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
  /** Kite 1-min open at 10:00:00 IST (Nifty at the 10 AM checkpoint). */
  indexOpenAt1000?: number | null;
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
  /** Red 9:15 · |Δ| ≥ 15 · flat −15/−10 by 9:16 second candle (backtest). */
  liveRedPeMain916ConfirmFollow?: NineFifteenCePeStrategyStats;
  liveRedPeMain916ConfirmFilterStats?: NineFifteenFollowFilterStats;
  /** Same band · only days where 9:16 open ≤ 9:15 close (both red) · flat −15 exit. */
  liveRedPeMain916BothRedFollow?: NineFifteenCePeStrategyStats;
  liveRedPeMain916BothRedFilterStats?: NineFifteenFollowFilterStats;
  /** Nifty — 9:17 two-candle confirm with 9:15 |Δ| > 30 · 9:16 |Δ| > 10 · ±15/10/5 exits. */
  niftyConfirm917Follow?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats?: NineFifteenFollowFilterStats;
  /** Same 9:17 confirm study with 9:15 |Δ| > 11 · 9:16 |Δ| > 10. */
  niftyConfirm917Follow11?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats11?: NineFifteenFollowFilterStats;
  /** Backtest-only stop-loss study (±70 main / ±70 near-miss) — live bot has no stop. */
  breakout?: NineFifteenBreakoutStats;
  /** Every Tuesday in the window vs the live flat ±10 exit — hit time or closest miss. */
  tuesdayTenPoint?: NineFifteenTuesdayTargetStats;
}

export interface NineFifteenFollowBacktestBlock {
  fromDate: string;
  toDate: string;
  nseSessions: number;
  cePeGuide: NineFifteenCePeGuide;
  /** Red 9:15 · |Δ| ≥ 15 · flat −15/−10 by 9:16 second candle (backtest). */
  liveRedPeMain916ConfirmFollow?: NineFifteenCePeStrategyStats;
  liveRedPeMain916ConfirmFilterStats?: NineFifteenFollowFilterStats;
  /** Same band · only days where 9:16 open ≤ 9:15 close (both red) · flat −15 exit. */
  liveRedPeMain916BothRedFollow?: NineFifteenCePeStrategyStats;
  liveRedPeMain916BothRedFilterStats?: NineFifteenFollowFilterStats;
  /** Nifty — 9:17 two-candle confirm with 9:15 |Δ| > 30 · 9:16 |Δ| > 10 · ±15/10/5 exits. */
  niftyConfirm917Follow?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats?: NineFifteenFollowFilterStats;
  /** Same 9:17 confirm study with 9:15 |Δ| > 11 · 9:16 |Δ| > 10. */
  niftyConfirm917Follow11?: NineFifteenCePeStrategyStats;
  niftyConfirm917FilterStats11?: NineFifteenFollowFilterStats;
  breakout?: NineFifteenBreakoutStats;
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
  /** Red PE studies: passed |Δ| filter but 9:16 open was not ≥0.1 below 9:15 close. */
  skipped916Confirm?: number;
  /** 916 hybrid: red confirm days using flat −15 from 9:16. */
  redConfirmFlat15Trades?: number;
  /** 916 hybrid: green gap days using flat −10 from 9:16. */
  greenGapFlat10Trades?: number;
  /** @deprecated use redConfirmFlat15Trades */
  redConfirmMainBandTrades?: number;
  /** @deprecated use greenGapFlat10Trades */
  greenGapFlat15Trades?: number;
  /** Optional UI copy overrides (e.g. live dual-band consolidation). */
  display?: {
    filterTitle: string;
    takenLabel: string;
    skippedLabel: string;
    skipped916Label?: string;
    redConfirmLabel?: string;
    greenGapLabel?: string;
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
  /** Intraday miss held as NRML until next expiry Tuesday 15:00 IST — same flat PE target from 9:16 entry. */
  nrmlCarry?: NineFifteenNrmlCarryOutcome | null;
  /** At 10:00 IST: Nifty vs the session exit target (entry ± targetPoints). */
  targetGapAt1000?: NineFifteenTargetGapAtCheckpoint | null;
}

/** Snapshot at a session checkpoint — how far index was from the exit target. */
export interface NineFifteenTargetGapAtCheckpoint {
  checkpointIst: string;
  /** Nifty at the checkpoint (10:00 bar open). */
  indexPrice: number;
  /** Exit target index level. */
  targetIndexPrice: number;
  /** Points still needed in trade direction (0 if index already at/past target). */
  pointsFromTarget: number;
}

/** NRML carry: hold PE from 9:16 entry through next expiry Tuesday 15:00 IST. */
export interface NineFifteenNrmlCarryOutcome {
  deadlineDate: string;
  deadlineLabel: string;
  wouldWin: boolean;
  hit: NineFifteenTargetHit | null;
  /** Session date when the carry target was first hit (null if never). */
  hitDate: string | null;
  /** Best PE move from entry across post-entry carry sessions (index points). */
  maxMoveInDirection: number;
  /** False when deadline session is missing from Kite history. */
  dataComplete: boolean;
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
