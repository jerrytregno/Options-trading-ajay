import { computeZerodhaIntradayOptionsCharges } from "../src/lib/zerodha-intraday-charges.js";
import { findAtmStrike } from "../src/lib/greeks.js";
import { rsiAtBarIndex } from "../src/lib/rsi.js";
import type { DayScalperCandle, DayScalperOutcome, DayScalperRules, DayScalperSide } from "../src/types/day-scalper.js";
import type {
  TrapsBacktestBucket,
  TrapsBacktestDay,
  TrapsBacktestResult,
  TrapsBacktestStats,
  TrapsBacktestTrade,
  TrapsExitProfile,
} from "../src/types/traps-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { kiteGet } from "./kite-client.js";
import { getKiteInstruments } from "./kite-instruments.js";
import {
  MOMENTUM_OPENING_EXIT_CONFIG,
  MOMENTUM_SCALPER_FORCE_EXIT_IST,
  MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT,
  MOMENTUM_SCALPER_LIVE_RULES,
  MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
  MOMENTUM_SCALPER_RSI_PERIOD,
  momentumLiveRsiBlocksEntry,
  formatMomentumLiveRsiBucketsLabel,
  MOMENTUM_SCALPER_SCAN_START_MINS,
  MOMENTUM_STANDARD_EXIT_CONFIG,
  momentumProfitExitPnlPct,
  createExitState,
  detectSignalSide,
  evaluateMomentumExit,
  momentumExitProfileForEntryMins,
  momentumGateSeenInMinuteBar,
  sessionCloseMinsForWeekday,
  type MomentumExitProfileConfig,
} from "./momentum-scalper-logic.js";

const IST = "Asia/Kolkata";
const SPOT_KEY = "NSE:NIFTY 50";
const CHAIN_EXCHANGE = "NFO";
const CHAIN_SYMBOL = "NIFTY";
const SESSION_OPEN_MINS = 9 * 60 + 15;
const SESSION_CLOSE_MINS = 15 * 60 + 30;
const FORCE_EXIT_MINS = 15 * 60 + 25;
const BUCKET_SIZE_MINS = 15;
/** Spacing between the synthetic readings fed into the exit engine inside one minute bar. */
const READING_GAP_MS = 15_000;
/** Guard against a pathological day burning the Kite history rate limit. */
const MAX_OPTION_FETCHES_PER_DAY = 60;
/** Kite serves 3 historical requests a second; 350 ms keeps a long run comfortably under it. */
const HISTORY_CALL_SPACING_MS = 350;
/** Bound to the live bot's period so the backtest column can never describe a different filter. */
export const TRAPS_BACKTEST_RSI_PERIOD = MOMENTUM_SCALPER_RSI_PERIOD;

const round2 = (v: number) => Math.round(v * 100) / 100;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function minsToHm(mins: number): string {
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

// Built once. A year's run parses hundreds of thousands of candles, and constructing a formatter
// costs far more than using one — doing it per candle dominated the parse.
const IST_HM_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const IST_WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "long" });

function istHourMinute(date: Date): { hour: number; minute: number } {
  const parts = IST_HM_FORMAT.formatToParts(date);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { hour: hour % 24, minute };
}

function weekdayFromDateKey(date: string): string {
  return IST_WEEKDAY_FORMAT.format(new Date(`${date}T06:00:00.000Z`));
}

function parseMinuteCandles(raw: unknown): DayScalperCandle[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: DayScalperCandle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close] = row;
    if (typeof time !== "string") continue;
    if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) continue;

    const parsed = new Date(time);
    if (!Number.isFinite(parsed.getTime())) continue;

    const { hour, minute } = istHourMinute(parsed);
    const mins = hour * 60 + minute;
    if (mins < SESSION_OPEN_MINS || mins > SESSION_CLOSE_MINS) continue;

    out.push({
      time,
      timeIst: `${pad2(hour)}:${pad2(minute)}`,
      mins,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
    });
  }

  out.sort((a, b) => a.mins - b.mins);
  return out;
}

/**
 * Kite allows 3 historical calls a second and a multi-day run makes dozens back to back, so every
 * call in this module waits its turn rather than risking a 429 halfway through a session.
 */
let nextHistoryCallAt = 0;
async function paceHistoryCall(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextHistoryCallAt - now);
  nextHistoryCallAt = Math.max(now, nextHistoryCallAt) + HISTORY_CALL_SPACING_MS;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function fetchMinuteCandlesByToken(
  accessToken: string,
  instrumentToken: number,
  date: string,
): Promise<DayScalperCandle[]> {
  await paceHistoryCall();
  const from = encodeURIComponent(`${date} 09:15:00`);
  const to = encodeURIComponent(`${date} 15:30:00`);
  const data = await kiteGet<{ candles?: unknown[] }>(
    `/instruments/historical/${instrumentToken}/minute?from=${from}&to=${to}`,
    accessToken,
  );
  return parseMinuteCandles(data.candles ?? data);
}

export interface OptionRow {
  instrumentToken: number;
  tradingsymbol: string;
  expiry: string;
  strike: number;
  lotSize: number;
  optionType: DayScalperSide;
}

/** A contract's session bars plus a minute index, so the entry bar is a lookup rather than a scan. */
interface LoadedOptionBars {
  bars: DayScalperCandle[];
  byMins: Map<number, DayScalperCandle>;
}

interface OptionChain {
  /** Every listed NIFTY option, grouped by expiry date key. */
  byExpiry: Map<string, OptionRow[]>;
  expiries: string[];
}

async function loadOptionChain(): Promise<OptionChain> {
  const rows = await getKiteInstruments(CHAIN_EXCHANGE);
  const byExpiry = new Map<string, OptionRow[]>();

  for (const row of rows) {
    if (row.name !== CHAIN_SYMBOL) continue;
    if (row.segment !== `${CHAIN_EXCHANGE}-OPT`) continue;
    const optionType = row.instrument_type === "CE" ? "CE" : row.instrument_type === "PE" ? "PE" : null;
    if (!optionType) continue;
    const expiry = (row.expiry ?? "").slice(0, 10);
    const strike = Number(row.strike ?? 0);
    if (!expiry || !(strike > 0)) continue;

    const list = byExpiry.get(expiry) ?? [];
    list.push({
      instrumentToken: row.instrument_token,
      tradingsymbol: row.tradingsymbol,
      expiry,
      strike,
      lotSize: row.lot_size ?? 75,
      optionType,
    });
    byExpiry.set(expiry, list);
  }

  return { byExpiry, expiries: [...byExpiry.keys()].sort() };
}

/**
 * The contract the bot would have traded on `date` — the nearest expiry still ahead of that
 * session, not the nearest expiry ahead of today. Backtesting a Wednesday with this week's
 * instrument list would otherwise price the trade off next week's series.
 */
function expiryForDate(chain: OptionChain, date: string): string | null {
  return chain.expiries.find((expiry) => expiry >= date) ?? null;
}

function emptyStats(): TrapsBacktestStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    winRatePct: 0,
    grossPnl: 0,
    charges: 0,
    netPnl: 0,
    avgWin: 0,
    avgLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    profitFactor: null,
    avgPnlPct: 0,
    avgHoldMinutes: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    maxDrawdown: 0,
  };
}

function summarise(trades: TrapsBacktestTrade[]): TrapsBacktestStats {
  const stats = emptyStats();
  if (trades.length === 0) return stats;

  const ordered = [...trades].sort((a, b) =>
    a.date === b.date ? a.entryMins - b.entryMins : a.date.localeCompare(b.date),
  );

  let winSum = 0;
  let lossSum = 0;
  let pnlPctSum = 0;
  let holdSum = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let equity = 0;
  let peak = 0;

  for (const trade of ordered) {
    stats.trades += 1;
    stats.grossPnl += trade.grossPnl;
    stats.charges += trade.charges;
    stats.netPnl += trade.netPnl;
    pnlPctSum += trade.pnlPct;
    holdSum += trade.holdMinutes;

    if (trade.netPnl > 0) {
      stats.wins += 1;
      winSum += trade.netPnl;
      winStreak += 1;
      lossStreak = 0;
      stats.maxWinStreak = Math.max(stats.maxWinStreak, winStreak);
      stats.largestWin = Math.max(stats.largestWin, trade.netPnl);
    } else if (trade.netPnl < 0) {
      stats.losses += 1;
      lossSum += Math.abs(trade.netPnl);
      lossStreak += 1;
      winStreak = 0;
      stats.maxLossStreak = Math.max(stats.maxLossStreak, lossStreak);
      stats.largestLoss = Math.min(stats.largestLoss, trade.netPnl);
    } else {
      stats.flat += 1;
      winStreak = 0;
      lossStreak = 0;
    }

    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    stats.maxDrawdown = Math.max(stats.maxDrawdown, peak - equity);
  }

  const decided = stats.wins + stats.losses;
  stats.winRatePct = decided > 0 ? round2((stats.wins / decided) * 100) : 0;
  stats.avgWin = stats.wins > 0 ? round2(winSum / stats.wins) : 0;
  stats.avgLoss = stats.losses > 0 ? round2(-lossSum / stats.losses) : 0;
  stats.profitFactor = lossSum > 0 ? round2(winSum / lossSum) : null;
  stats.avgPnlPct = round2(pnlPctSum / stats.trades);
  stats.avgHoldMinutes = round2(holdSum / stats.trades);
  stats.grossPnl = round2(stats.grossPnl);
  stats.charges = round2(stats.charges);
  stats.netPnl = round2(stats.netPnl);
  stats.largestWin = round2(stats.largestWin);
  stats.largestLoss = round2(stats.largestLoss);
  stats.maxDrawdown = round2(stats.maxDrawdown);
  return stats;
}

/**
 * One minute bar expanded into the price path the exit engine walks. The adverse extreme is fed
 * before the favourable one so a stop that a bar could have hit always wins the race against a
 * ladder rung inside that same bar — minute data cannot say which came first, and assuming the
 * kinder order is how a backtest flatters itself.
 *
 * The entry bar is the one place that asymmetry has to be enforced by hand. The position opens
 * partway through it, and the bar's high may well have printed *before* the premium fell to the
 * trigger, so crediting it would hand the trade a profit it was never in for. With a first rung
 * only 0.50% away — under a rupee on a ₹130 premium — that single reading is enough to close
 * almost every trade on its own entry minute at a rung. So the entry bar contributes its low
 * (a stop it might genuinely have suffered) and its close, never its high.
 */
function barReadings(bar: DayScalperCandle, fromEntry: boolean): number[] {
  const path = fromEntry ? [bar.low, bar.close] : [bar.open, bar.low, bar.high, bar.close];
  return path.filter((price) => Number.isFinite(price) && price > 0);
}

interface SimulatedExit {
  exitPremium: number;
  exitMins: number;
  outcome: DayScalperOutcome;
  lockedPnlPct: number;
  maxFavourablePct: number;
  maxAdversePct: number;
}

/**
 * Where a stop actually fills inside the bar that broke it.
 *
 * The bot sells at market the moment the level is crossed, so the fill belongs at the level — not
 * at the bar's extreme, which would charge the trade for every tick that printed after it was
 * already out. When the whole bar sits below the level the minute gapped through it and no such
 * cross exists, so the open is the closest thing to a first-tick fill.
 */
function stopFillPrice(levelPrice: number, bar: DayScalperCandle): number {
  if (levelPrice >= bar.high) return bar.open;
  if (levelPrice <= bar.low) return bar.low;
  return levelPrice;
}

/** Standard-profile initial stop for a backtest run (opening window keeps its own −10% / 15s hold). */
function trapsExitConfigForProfile(
  profile: TrapsExitProfile,
  standardStopPct: number,
): MomentumExitProfileConfig {
  if (profile === "opening") return MOMENTUM_OPENING_EXIT_CONFIG;
  return { ...MOMENTUM_STANDARD_EXIT_CONFIG, initialStopLossPct: standardStopPct };
}

/**
 * Replays the live exit engine over the option's own minute bars.
 *
 * Readings inside a bar are spaced {@link READING_GAP_MS} apart. The standard profile's stop has
 * no hold, so the first reading through it exits; the spacing still matters for the opening
 * profile, whose stop only fires after a breach survives 15 unbroken seconds.
 */
function simulateExit(
  side: DayScalperSide,
  entryPremium: number,
  entryMins: number,
  spotAtEntry: number,
  profile: TrapsExitProfile,
  optionBars: DayScalperCandle[],
  spotByMins: Map<number, DayScalperCandle>,
  standardStopPct: number,
): SimulatedExit {
  const exitConfig = trapsExitConfigForProfile(profile, standardStopPct);
  let state = createExitState(side, spotAtEntry, profile);
  let maxFavourablePct = 0;
  let maxAdversePct = 0;
  let lastPrice = entryPremium;
  let lastMins = entryMins;

  for (const bar of optionBars) {
    if (bar.mins < entryMins) continue;

    const spot = spotByMins.get(bar.mins)?.close ?? spotAtEntry;

    if (bar.mins >= FORCE_EXIT_MINS) {
      return {
        exitPremium: round2(bar.open),
        exitMins: bar.mins,
        outcome: "eod",
        lockedPnlPct: state.lockedPnlPct,
        maxFavourablePct: round2(maxFavourablePct),
        maxAdversePct: round2(maxAdversePct),
      };
    }

    const readings = barReadings(bar, bar.mins === entryMins);
    const baseMs = bar.mins * 60_000;

    for (let i = 0; i < readings.length; i += 1) {
      const price = readings[i];
      const pnlPct = ((price - entryPremium) / entryPremium) * 100;
      maxFavourablePct = Math.max(maxFavourablePct, pnlPct);
      maxAdversePct = Math.min(maxAdversePct, pnlPct);
      lastPrice = price;
      lastMins = bar.mins;

      const result = evaluateMomentumExit(
        state,
        {
          spot,
          pnlPct,
          nowMs: baseMs + i * READING_GAP_MS,
        },
        exitConfig,
      );
      state = result.state;

      if (result.exit) {
        // Profit exits fill on a marketable limit set a tenth of a percent under the locked floor,
        // so the simulation books that price rather than the floor the trigger sat on.
        const levelPct =
          result.exit.outcome === "trail-stop"
            ? momentumProfitExitPnlPct(result.exit.lockedPnlPct)
            : -exitConfig.initialStopLossPct;
        return {
          exitPremium: round2(stopFillPrice(entryPremium * (1 + levelPct / 100), bar)),
          exitMins: bar.mins,
          outcome: result.exit.outcome,
          lockedPnlPct: result.exit.lockedPnlPct,
          maxFavourablePct: round2(maxFavourablePct),
          maxAdversePct: round2(maxAdversePct),
        };
      }
    }
  }

  return {
    exitPremium: round2(lastPrice),
    exitMins: lastMins,
    outcome: "eod",
    lockedPnlPct: state.lockedPnlPct,
    maxFavourablePct: round2(maxFavourablePct),
    maxAdversePct: round2(maxAdversePct),
  };
}

export const TRAPS_BACKTEST_DEFAULT_CAPITAL = 200_000;
export const TRAPS_BACKTEST_DEFAULT_MAX_LOTS = 25;
export const TRAPS_BACKTEST_DEFAULT_SAFETY_PCT = 2;
/** Live Traps standard-profile initial stop — also the backtest slider default. */
export const TRAPS_BACKTEST_DEFAULT_STANDARD_STOP_PCT = MOMENTUM_SCALPER_INITIAL_STOP_LOSS_PCT;
export const TRAPS_BACKTEST_MIN_STANDARD_STOP_PCT = 1;
export const TRAPS_BACKTEST_MAX_STANDARD_STOP_PCT = 6;
/** Matches live Traps — the signal candle's high-to-low range must exceed this many points. */
export const TRAPS_BACKTEST_LIVE_MIN_BODY_PTS = MOMENTUM_SCALPER_LIVE_RULES.minMovePts;
/** Relaxed backtest-only variant: green/red candle with a range over 1 pt. */
export const TRAPS_BACKTEST_RELAXED_MIN_BODY_PTS = 1;

// Inherits signalMeasure: "range" from the live rules, so the backtest qualifies a signal candle
// exactly the way the bot does off the tick stream.
function trapsBacktestRules(minBodyPts: number): DayScalperRules {
  return { ...MOMENTUM_SCALPER_LIVE_RULES, minMovePts: minBodyPts };
}

function resolveMinBodyPts(options: TrapsBacktestOptions): number {
  return options.minBodyPts ?? TRAPS_BACKTEST_LIVE_MIN_BODY_PTS;
}

function resolveStandardStopPct(options: TrapsBacktestOptions): number {
  const raw =
    options.standardStopPct ?? TRAPS_BACKTEST_DEFAULT_STANDARD_STOP_PCT;
  if (!Number.isFinite(raw)) return TRAPS_BACKTEST_DEFAULT_STANDARD_STOP_PCT;
  return Math.min(
    TRAPS_BACKTEST_MAX_STANDARD_STOP_PCT,
    Math.max(TRAPS_BACKTEST_MIN_STANDARD_STOP_PCT, Math.round(raw)),
  );
}

function signalBarRsi(
  niftyCloses: number[],
  niftyBarIndex: Map<number, number>,
  signalMins: number,
): number | null {
  const idx = niftyBarIndex.get(signalMins);
  if (idx == null) return null;
  return rsiAtBarIndex(niftyCloses, idx, TRAPS_BACKTEST_RSI_PERIOD);
}

export interface TrapsBacktestOptions {
  from: string;
  to: string;
  capital: number;
  maxLots: number;
  /** Head-room applied to the premium when sizing, mirroring the live bot. */
  premiumSafetyPct: number;
  /**
   * Signal-candle body threshold in Nifty points. Defaults to the live Traps value ({@link
   * TRAPS_BACKTEST_LIVE_MIN_BODY_PTS}). Use {@link TRAPS_BACKTEST_RELAXED_MIN_BODY_PTS} for the
   * 1-point backtest duplicate — never passed to the live bot.
   */
  minBodyPts?: number;
  /**
   * Standard-profile initial stop as a positive percent (4 → exit at −4% option P&L). The
   * opening-window profile keeps its own −10% / 15s hold regardless.
   */
  standardStopPct?: number;
  /** Block CE when RSI > 70 and PE when RSI < 30 at the signal candle close (Nifty 1-min from Kite). */
  rsiFilter?: boolean;
}

function tradingDatesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T06:00:00.000Z`);
  const end = new Date(`${to}T06:00:00.000Z`);
  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
    const key = d.toISOString().slice(0, 10);
    const weekday = weekdayFromDateKey(key);
    if (weekday === "Saturday" || weekday === "Sunday") continue;
    out.push(key);
  }
  return out;
}

function lotsForPremium(
  premium: number,
  lotSize: number,
  capital: number,
  maxLots: number,
  safetyPct: number,
): number {
  const sizingPremium = premium * (1 + safetyPct / 100);
  const perLot = sizingPremium * lotSize;
  if (!(perLot > 0)) return 0;
  return Math.max(0, Math.min(maxLots, Math.floor(capital / perLot)));
}

export interface TrapsSessionInput {
  date: string;
  weekday: string;
  expiry: string;
  spotBars: DayScalperCandle[];
  /** Every listed contract on `expiry`, both sides. */
  contracts: OptionRow[];
  /** Resolves that contract's own 1-minute bars for the session; null when unavailable. */
  loadOptionBars: (contract: OptionRow) => Promise<DayScalperCandle[] | null>;
  options: TrapsBacktestOptions;
  warnings: string[];
}

/**
 * Replays one session. Kept free of Kite so the whole entry/exit path can be exercised against
 * hand-built candles.
 */
export async function simulateTrapsSession(input: TrapsSessionInput): Promise<TrapsBacktestDay> {
  const { date, weekday, expiry, spotBars, contracts, loadOptionBars, options, warnings } = input;

  const day: TrapsBacktestDay = {
    date,
    weekday,
    expiry,
    niftyOpen: spotBars[0]?.open ?? 0,
    niftyClose: spotBars[spotBars.length - 1]?.close ?? 0,
    signals: 0,
    gatePasses: 0,
    stats: emptyStats(),
    trades: [],
    skips: [],
  };

  const spotByMins = new Map(spotBars.map((bar) => [bar.mins, bar] as const));
  const niftyCloses = spotBars.map((bar) => bar.close);
  const niftyBarIndex = new Map(spotBars.map((bar, index) => [bar.mins, index] as const));
  const strikes = [...new Set(contracts.map((row) => row.strike))];
  // Indexed once instead of scanned per setup — a day can produce dozens of gate passes and the
  // chain runs to hundreds of contracts.
  const contractByStrikeSide = new Map<string, OptionRow>();
  for (const row of contracts) {
    contractByStrikeSide.set(`${row.strike}:${row.optionType}`, row);
  }
  const optionCache = new Map<number, LoadedOptionBars | null>();
  let optionFetches = 0;

  const rules = trapsBacktestRules(resolveMinBodyPts(options));
  const standardStopPct = resolveStandardStopPct(options);
  const rsiFilter = options.rsiFilter === true;
  const entryCutoff = sessionCloseMinsForWeekday(weekday, rules);
  let flatFromMins = MOMENTUM_SCALPER_SCAN_START_MINS;

  for (const signalBar of spotBars) {
    if (signalBar.mins < MOMENTUM_SCALPER_SCAN_START_MINS) continue;
    if (signalBar.mins < flatFromMins) continue;
    if (signalBar.mins + 1 > entryCutoff) break;

    const side = detectSignalSide(signalBar, rules);
    if (!side) continue;
    day.signals += 1;

    const signalRsi = signalBarRsi(niftyCloses, niftyBarIndex, signalBar.mins);
    const rsiBlock = rsiFilter ? momentumLiveRsiBlocksEntry(signalRsi) : { blocked: false };
    if (rsiBlock.blocked) {
      day.skips.push({
        date,
        timeIst: signalBar.timeIst,
        side,
        reason: "rsi-filter",
        detail: rsiBlock.reason ?? "RSI filter",
      });
      continue;
    }

    const momentumBar = spotByMins.get(signalBar.mins + 1);
    if (!momentumBar) continue;
    if (!momentumGateSeenInMinuteBar(side, momentumBar, signalBar.close)) continue;
    day.gatePasses += 1;

    // The live bot resolves the strike from the spot at the instant the gate passes — the
    // momentum minute's open, not the signal candle's close.
    const strike = findAtmStrike(strikes, momentumBar.open);
    const contract = contractByStrikeSide.get(`${strike}:${side}`);
    if (!contract) {
      day.skips.push({
        date,
        timeIst: momentumBar.timeIst,
        side,
        reason: "no-option-contract",
        detail: `No ${side} listed at strike ${strike} for expiry ${expiry}`,
      });
      continue;
    }

    let loaded = optionCache.get(contract.instrumentToken);
    if (loaded === undefined) {
      if (optionFetches >= MAX_OPTION_FETCHES_PER_DAY) {
        warnings.push(`${date}: stopped after ${MAX_OPTION_FETCHES_PER_DAY} option history calls — later setups were not evaluated.`);
        break;
      }
      optionFetches += 1;
      try {
        const bars = await loadOptionBars(contract);
        loaded = bars ? { bars, byMins: new Map(bars.map((bar) => [bar.mins, bar] as const)) } : null;
      } catch (error) {
        loaded = null;
        warnings.push(
          `${date}: ${contract.tradingsymbol} history failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      optionCache.set(contract.instrumentToken, loaded);
    }

    const optionBars = loaded?.bars;
    if (!optionBars || optionBars.length === 0) {
      day.skips.push({
        date,
        timeIst: momentumBar.timeIst,
        side,
        reason: "no-option-data",
        detail: `No minute candles for ${contract.tradingsymbol}`,
      });
      continue;
    }

    const entryBar = loaded?.byMins.get(momentumBar.mins);
    if (!entryBar) {
      day.skips.push({
        date,
        timeIst: momentumBar.timeIst,
        side,
        reason: "no-option-data",
        detail: `${contract.tradingsymbol} did not trade at ${momentumBar.timeIst}`,
      });
      continue;
    }

    // The entry is a market buy taken the moment the gate passes, so it pays the option's price at
    // the start of that minute. Live that is the first tick; here it is the bar's open.
    const entryPremium = round2(entryBar.open);
    if (!(entryPremium > 0)) {
      day.skips.push({
        date,
        timeIst: momentumBar.timeIst,
        side,
        reason: "no-option-data",
        detail: `${contract.tradingsymbol} opened at ₹${round2(entryBar.open)} at ${momentumBar.timeIst}`,
      });
      continue;
    }

    const lots = lotsForPremium(
      entryPremium,
      contract.lotSize,
      options.capital,
      options.maxLots,
      options.premiumSafetyPct,
    );
    if (lots <= 0) {
      day.skips.push({
        date,
        timeIst: momentumBar.timeIst,
        side,
        reason: "premium-too-expensive",
        detail: `₹${round2(entryPremium)} × ${contract.lotSize} exceeds the ₹${options.capital.toLocaleString("en-IN")} capital for even one lot`,
      });
      continue;
    }

    const profile = momentumExitProfileForEntryMins(momentumBar.mins);
    const exit = simulateExit(
      side,
      entryPremium,
      momentumBar.mins,
      momentumBar.close,
      profile,
      optionBars,
      spotByMins,
      standardStopPct,
    );

    const quantity = lots * contract.lotSize;
    const grossPnl = (exit.exitPremium - entryPremium) * quantity;
    const charges = computeZerodhaIntradayOptionsCharges(entryPremium, exit.exitPremium, quantity).total;

    // Read at the signal bar, not the momentum bar the trade enters on: the entry fires partway
    // through the momentum minute, so that minute's close is not knowable at the decision point.
    const rawSignalRsi = signalRsi;

    day.trades.push({
      date,
      weekday,
      signalTimeIst: signalBar.timeIst,
      entryTimeIst: momentumBar.timeIst,
      entryMins: momentumBar.mins,
      exitTimeIst: minsToHm(exit.exitMins),
      exitMins: exit.exitMins,
      side,
      tradingsymbol: contract.tradingsymbol,
      strike,
      expiry,
      lotSize: contract.lotSize,
      lots,
      quantity,
      spotAtEntry: round2(momentumBar.close),
      spotAtExit: round2(spotByMins.get(exit.exitMins)?.close ?? momentumBar.close),
      signalRangePts: round2(signalBar.high - signalBar.low),
      signalBodyPts: round2(signalBar.close - signalBar.open),
      entryPremium: round2(entryPremium),
      exitPremium: exit.exitPremium,
      pnlPct: round2(((exit.exitPremium - entryPremium) / entryPremium) * 100),
      grossPnl: round2(grossPnl),
      charges: round2(charges),
      netPnl: round2(grossPnl - charges),
      outcome: exit.outcome,
      exitProfile: profile,
      lockedPnlPct: exit.lockedPnlPct,
      holdMinutes: exit.exitMins - momentumBar.mins,
      maxFavourablePct: exit.maxFavourablePct,
      maxAdversePct: exit.maxAdversePct,
      signalRsi: rawSignalRsi != null ? round2(rawSignalRsi) : null,
    });

    // One position at a time, exactly like the live bot — scanning only resumes after the exit.
    flatFromMins = exit.exitMins;
  }

  day.stats = summarise(day.trades);
  return day;
}

/** Pulls the session's candles from Kite, then hands them to {@link simulateTrapsSession}. */
async function runDay(
  accessToken: string,
  date: string,
  chain: OptionChain,
  options: TrapsBacktestOptions,
  warnings: string[],
): Promise<TrapsBacktestDay | null> {
  const weekday = weekdayFromDateKey(date);
  const expiry = expiryForDate(chain, date);

  if (!expiry) {
    return {
      date,
      weekday,
      expiry: "",
      niftyOpen: 0,
      niftyClose: 0,
      signals: 0,
      gatePasses: 0,
      stats: emptyStats(),
      trades: [],
      skips: [],
      error:
        "No listed NIFTY expiry on or after this date — that series has already expired and Zerodha no longer serves its candles.",
    };
  }

  let spotBars: DayScalperCandle[];
  try {
    await paceHistoryCall();
    const { candles } = await fetchHistoricalCandles(
      accessToken,
      SPOT_KEY,
      "minute",
      `${date} 09:15:00`,
      `${date} 15:30:00`,
    );
    spotBars = parseMinuteCandles(candles);
  } catch (error) {
    return {
      date,
      weekday,
      expiry,
      niftyOpen: 0,
      niftyClose: 0,
      signals: 0,
      gatePasses: 0,
      stats: emptyStats(),
      trades: [],
      skips: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // A holiday returns an empty series — drop the date rather than reporting a zero-trade session.
  if (spotBars.length === 0) return null;

  return simulateTrapsSession({
    date,
    weekday,
    expiry,
    spotBars,
    contracts: chain.byExpiry.get(expiry) ?? [],
    loadOptionBars: (contract) =>
      fetchMinuteCandlesByToken(accessToken, contract.instrumentToken, date),
    options,
    warnings,
  });
}

function buildBuckets(trades: TrapsBacktestTrade[]): TrapsBacktestBucket[] {
  const buckets: TrapsBacktestBucket[] = [];
  for (let start = SESSION_OPEN_MINS; start < SESSION_CLOSE_MINS; start += BUCKET_SIZE_MINS) {
    const end = start + BUCKET_SIZE_MINS;
    const inBucket = trades.filter((trade) => trade.entryMins >= start && trade.entryMins < end);
    if (inBucket.length === 0) continue;
    buckets.push({
      label: minsToHm(start),
      startMins: start,
      endMins: end,
      stats: summarise(inBucket),
    });
  }
  return buckets;
}

export async function buildTrapsBacktest(
  accessToken: string,
  options: TrapsBacktestOptions,
): Promise<TrapsBacktestResult> {
  const warnings: string[] = [];
  const chain = await loadOptionChain();
  if (chain.expiries.length === 0) {
    throw new Error("No NIFTY option contracts in the Zerodha instrument dump");
  }

  const dates = tradingDatesBetween(options.from, options.to);
  if (dates.length === 0) {
    throw new Error(`No weekday sessions between ${options.from} and ${options.to}`);
  }

  const days: TrapsBacktestDay[] = [];
  for (const date of dates) {
    const day = await runDay(accessToken, date, chain, options, warnings);
    if (day) days.push(day);
  }

  const allTrades = days.flatMap((day) => day.trades);
  const buckets = buildBuckets(allTrades);
  const ranked = [...buckets].sort((a, b) => b.stats.netPnl - a.stats.netPnl);

  const outcomeOrder: DayScalperOutcome[] = ["trail-stop", "stop", "target", "eod"];
  const outcomes = outcomeOrder
    .map((outcome) => {
      const rows = allTrades.filter((trade) => trade.outcome === outcome);
      return {
        outcome,
        count: rows.length,
        netPnl: round2(rows.reduce((sum, trade) => sum + trade.netPnl, 0)),
      };
    })
    .filter((row) => row.count > 0);

  const sides: DayScalperSide[] = ["CE", "PE"];
  const profiles: TrapsExitProfile[] = ["opening", "standard"];

  const minBodyPts = resolveMinBodyPts(options);
  const standardStopPct = resolveStandardStopPct(options);
  const rsiFilter = options.rsiFilter === true;

  return {
    from: options.from,
    to: options.to,
    capital: options.capital,
    maxLots: options.maxLots,
    builtAt: new Date().toISOString(),
    rules: {
      minBodyPts,
      openGapPts: MOMENTUM_SCALPER_MOMENTUM_OPEN_GAP_PTS,
      standardArmPct: MOMENTUM_STANDARD_EXIT_CONFIG.armPct,
      standardStepPct: MOMENTUM_STANDARD_EXIT_CONFIG.stepPct,
      standardStopPct,
      standardStopHoldMs: MOMENTUM_STANDARD_EXIT_CONFIG.initialStopHoldMs,
      openingArmPct: MOMENTUM_OPENING_EXIT_CONFIG.armPct,
      openingStepPct: MOMENTUM_OPENING_EXIT_CONFIG.stepPct,
      openingStopPct: MOMENTUM_OPENING_EXIT_CONFIG.initialStopLossPct,
      openingStopHoldMs: MOMENTUM_OPENING_EXIT_CONFIG.initialStopHoldMs,
      scanStartIst: minsToHm(MOMENTUM_SCALPER_SCAN_START_MINS),
      entryCutoffIst: MOMENTUM_SCALPER_LIVE_RULES.tradeWindowCloseIst,
      forceExitIst: MOMENTUM_SCALPER_FORCE_EXIT_IST,
      rsiPeriod: TRAPS_BACKTEST_RSI_PERIOD,
      rsiFilter,
      rsiAllowedBucketsIst: formatMomentumLiveRsiBucketsLabel(),
    },
    overall: summarise(allTrades),
    days,
    buckets,
    bestBucket: ranked[0] ?? null,
    worstBucket: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    outcomes,
    bySide: sides
      .map((side) => ({ side, stats: summarise(allTrades.filter((t) => t.side === side)) }))
      .filter((row) => row.stats.trades > 0),
    byProfile: profiles
      .map((profile) => ({
        profile,
        stats: summarise(allTrades.filter((t) => t.exitProfile === profile)),
      }))
      .filter((row) => row.stats.trades > 0),
    warnings,
  };
}