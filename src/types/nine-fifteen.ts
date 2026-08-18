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
  /** First ±15 from 9:16 Kite open (near-miss fixed target). */
  firstHitUp15?: NineFifteenTargetHit | null;
  firstHitDown15?: NineFifteenTargetHit | null;
  /** Near-miss: ±20 before 10:01 IST, ±10 from 10:01 (first hit per direction). */
  switch20Then10After1001Up?: NineFifteenTargetHit | null;
  switch20Then10After1001Down?: NineFifteenTargetHit | null;
  /** Backtest entry: Kite 9:16 candle open at 09:16:00. */
  entryAtLive916?: NineFifteenTradeEntry | null;
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
  /** Breakout backtest with stop active from 15:00 IST. */
  breakoutStopHit1500?: NineFifteenTargetHit | null;
  /** Stop distance used for this row's band — main 70 · near-miss 70. */
  breakoutStopPoints?: number | null;
  /** Closest approach to tiered profit target over the full 9:16–15:30 session. */
  breakoutClosestToTarget?: NineFifteenBreakoutTargetApproach | null;
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
}

export interface NineFifteenBreakoutStats {
  label: string;
  stopMainPoints: number;
  stopNearMissPoints: number;
  /** First IST time the adverse stop is scanned (11:00:00 or 15:00:00 depending on variant). */
  stopActiveFromIst: string;
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
   * Live bot consolidation: |Δ|≥15 with main tiered exits + 11≤|Δ|<15 with near-miss exits.
   */
  liveConsolidatedFollow: NineFifteenCePeStrategyStats;
  liveConsolidatedFilterStats: NineFifteenFollowFilterStats;
  /** Backtest-only stop-loss study (±70 main / ±70 near-miss) — live bot has no stop. */
  breakout: NineFifteenBreakoutStats;
  /** Same breakout study with stop scanned from 15:00 IST instead of 11:00. */
  breakoutAt1500: NineFifteenBreakoutStats;
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
  breakout: NineFifteenBreakoutStats;
  breakoutAt1500: NineFifteenBreakoutStats;
}

export interface NineFifteenFollowFilterStats {
  minAbsDiff: number;
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
