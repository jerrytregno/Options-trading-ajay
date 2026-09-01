/**
 * Momentum scalper backtest — signal body, momentum open gate (+0.1), pullback entry (−2/+2 from
 * close), fixed take-profit at signal close ±3 index pts, plus a selectable initial stop.
 */

export const DAY_SCALPER_MIN_MOVE_PTS = 5;
export const DAY_SCALPER_MIN_MOVE_MIN = 5;
export const DAY_SCALPER_MIN_MOVE_MAX = 20;
export const DAY_SCALPER_TRIGGER_PTS = 2;
/** First take-profit distance from entry — trailing starts once this prints. */
export const DAY_SCALPER_INITIAL_TARGET_PTS = 5;
export const DAY_SCALPER_TRAIL_STEP_PTS = 2;
export const DAY_SCALPER_TRADE_WINDOW_OPEN = "09:30";
export const DAY_SCALPER_TRADE_WINDOW_CLOSE = "15:00";
export const DAY_SCALPER_TUESDAY_TRADE_WINDOW_CLOSE = "13:00";
export const DAY_SCALPER_INITIAL_STOP_MIN = 5;
export const DAY_SCALPER_INITIAL_STOP_MAX = 20;
export const DAY_SCALPER_DEFAULT_INITIAL_STOP_PTS = 10;
/** Candle 2 must open at least this far past candle 1's close in the signal direction. */
export const DAY_SCALPER_MOMENTUM_OPEN_GAP_PTS = 0.1;
/** Take-profit is anchored to candle 1's close — +3 for CE, −3 for PE (5 pts from a 2-pt pullback entry). */
export const DAY_SCALPER_TAKE_PROFIT_FROM_SIGNAL_CLOSE_PTS = 3;

/**
 * Required signal close → momentum mark gap (pts) before a trade is taken. Fixed at 4, not tunable:
 * a signal whose candle 2 never pulls back this far is no trade at all, so it must never reach the
 * book and be graded as a loss. MIN/MAX only bound the read-only comparison table.
 */
export const DAY_SCALPER_CLOSE_MARK_MIN = 1;
export const DAY_SCALPER_CLOSE_MARK_MAX = 20;
export const DAY_SCALPER_CLOSE_MARK_DEFAULT = 2;

export function clampCloseMarkPts(value: unknown): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return DAY_SCALPER_CLOSE_MARK_DEFAULT;
  return Math.min(
    DAY_SCALPER_CLOSE_MARK_MAX,
    Math.max(DAY_SCALPER_CLOSE_MARK_MIN, parsed),
  );
}

export function clampMinMovePts(value: unknown): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return DAY_SCALPER_MIN_MOVE_PTS;
  return Math.min(DAY_SCALPER_MIN_MOVE_MAX, Math.max(DAY_SCALPER_MIN_MOVE_MIN, parsed));
}

export function clampInitialStopPts(value: unknown): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return DAY_SCALPER_DEFAULT_INITIAL_STOP_PTS;
  return Math.min(
    DAY_SCALPER_INITIAL_STOP_MAX,
    Math.max(DAY_SCALPER_INITIAL_STOP_MIN, parsed),
  );
}

export interface DayScalperRules {
  minMovePts: number;
  /**
   * What `minMovePts` is measured against on the signal candle.
   *
   * `body` (the default) uses close − open. `range` uses high − low, which is what Traps runs on:
   * its candles are built from the websocket tick stream, so the true extremes of the minute are
   * known rather than inferred from the first and last print. Direction is read from the body
   * either way — a candle with no colour is not a signal however wide it is.
   */
  signalMeasure?: "body" | "range";
  triggerPts: number;
  initialTargetPts: number;
  trailStepPts: number;
  /** Stop distance below/above entry before the initial target prints (5–20). */
  initialStopPts: number;
  /**
   * How far candle 2 must pull back from candle 1's close before the entry triggers (1–20), and
   * the exact price the fill happens at. Applied while scanning, so a signal whose pullback never
   * arrives leaves the book flat and the next signal stays eligible.
   */
  minCloseMarkPts: number;
  sessionOpenIst: string;
  sessionCloseIst: string;
  tradeWindowOpenIst: string;
  tradeWindowCloseIst: string;
  tuesdayTradeWindowCloseIst: string;
}

export interface DayScalperCandle {
  time: string;
  timeIst: string;
  mins: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type DayScalperSide = "CE" | "PE";

export type DayScalperOutcome = "stop" | "target" | "trail-stop" | "eod";

/** Gap from signal-candle close to the momentum-candle mark (CE low · PE high), in index points. */
export interface DayScalperSignalToMarkStats {
  /** CE trades — largest (signal close − momentum low). */
  maxCeLowPts: number | null;
  /** PE trades — largest (momentum high − signal close). */
  maxPeHighPts: number | null;
  /** Mean gap across every trade in the sample. */
  avgPts: number | null;
  /** CE-only mean of (signal close − momentum low). */
  avgCeLowPts: number | null;
  /** PE-only mean of (momentum high − signal close). */
  avgPeHighPts: number | null;
  ceSamples: number;
  peSamples: number;
}

export interface DayScalperTrade {
  id: number;
  side: DayScalperSide;

  signalIndex: number;
  signalTimeIst: string;
  signalOpen: number;
  signalClose: number;
  signalMovePts: number;

  momentumIndex: number;
  momentumTimeIst: string;
  momentumOpen: number;
  momentumLow: number;
  momentumHigh: number;
  /** Marked extreme on the momentum bar — CE low · PE high. */
  triggerPrice: number;
  /** Signal close → momentum mark: CE = close − low · PE = high − close. */
  signalToMarkPts: number;

  entryIndex: number;
  entryTimeIst: string;
  entryPrice: number;
  initialStopPrice: number;
  /** Stop level at exit — initial stop or the trailing lock. */
  stopPrice: number;
  /** Active take-profit at exit (signal close ±3 or legacy trailing TP). */
  targetPrice: number;
  /** Profit distance locked at exit — target hit (+5 with default pullback) or trailing peak. */
  peakLockedPts: number;

  outcome: DayScalperOutcome;
  exitIndex: number;
  exitTimeIst: string;
  exitPrice: number;
  pnlPts: number;
  barsHeld: number;
  liveMinutes: number;
}

export interface DayScalperSkippedSignal {
  index: number;
  timeIst: string;
  side: DayScalperSide;
  movePts: number;
  reason: "in-trade" | "no-entry-bar" | "outside-window" | "momentum-open" | "no-pullback";
}

export interface DayScalperSummary {
  qualifyingBars: number;
  trades: number;
  wins: number;
  losses: number;
  winPct: number;
  netPts: number;
  grossWinPts: number;
  grossLossPts: number;
  avgPts: number;
  bestPts: number | null;
  worstPts: number | null;
  ceTrades: number;
  peTrades: number;
  maxDrawdownPts: number;
  maxLosingStreak: number;
  signalToMark: DayScalperSignalToMarkStats;
  skipped: DayScalperSkippedSignal[];
}

export interface DayScalperResult {
  date: string;
  weekday: string;
  instrument: string;
  indexId: "nifty";
  indexLabel: string;
  sessionComplete: boolean;
  rules: DayScalperRules;
  candles: DayScalperCandle[];
  trades: DayScalperTrade[];
  summary: DayScalperSummary;
  /** One full replay of the session per close→mark minimum, so each row is a real sequence. */
  closeMarkComparison: DayScalperCloseMarkRow[];
}

export interface DayScalperCloseMarkRow {
  closeMarkPts: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winPct: number;
  netPts: number;
}
