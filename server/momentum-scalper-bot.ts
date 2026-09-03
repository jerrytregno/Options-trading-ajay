import fs from "fs";
import path from "path";
import { getIndianMarketContext, formatWeekdayFromDateKey } from "../src/lib/market-time.js";
import { legLabel, type TradeLeg } from "../src/lib/trade-calculations.js";
import type { DayScalperCandle, DayScalperSide } from "../src/types/day-scalper.js";
import type { BotTradeLogStatus } from "../src/types/trade-log.js";
import { prewarmNiftyOptionChain, resolveAtmNiftyOption } from "./atm-option.js";
import { appendBotTradeLog, makeBotTradeLogId, makeStrategyTradeLogId } from "./bot-trade-log.js";
import { assertKiteEgressReady, clearKiteRejectedIp } from "./trading-ip.js";
import {
  cancelRegularOrder,
  fetchMisNetPosition,
  fetchMisPosition,
  fetchNetQty,
  fetchNiftyAndOptionQuotes,
  fetchEquityAvailableBalance,
  fetchOptionLtp,
  fetchOrdersByIds,
  fetchTradeBook,
  isInsufficientFundsError,
  KiteOrderRejectedError,
  kiteGet,
  parseMarginShortfall,
  placeRegularLimitOrder,
  placeRegularMarketOrder,
  waitForOrderComplete,
} from "./kite-client.js";
import {
  createNiftyTickerConnection,
  resolveInstrumentToken,
  resolveNifty50InstrumentToken,
  type NiftyTick,
  type NiftyTickerConnection,
} from "./kite-ticker.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { kiteSessionAgeHours, loadKiteSession } from "./kite-session-store.js";
import { isInBotWsHours, isPast916EntryWindow } from "./nine-sixteen-logic.js";
import {
  computeAffordableLots,
  getMaxLotsPerOrder,
  splitQuantityIntoOrderChunks,
} from "./nine-sixteen-sizing.js";
import {
  createExitState,
  detectSignalSide,
  evaluateMomentumExit,
  formatIstMins,
  momentumProfitExitLimitPrice,
  momentumProfitExitPnlPct,
  MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT,
  momentumExitProfileConfig,
  momentumExitProfileForEntryMins,
  momentumGateLevel,
  momentumGateFirstTickPasses,
  trapsPullbackEntryLevel,
  trapsPullbackEntryTriggered,
  MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS,
  MOMENTUM_SCALPER_SCAN_START_MINS,
  signedSignalMovePts,
  type MomentumEntryDecision,
  momentumPnlPctOfEntryCost,
  momentumPnlStopPct,
  momentumPnlTargetPct,
  MOMENTUM_SCALPER_FORCE_EXIT_IST,
  MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT,
  MOMENTUM_SCALPER_LIVE_RULES,
  MOMENTUM_SCALPER_PNL_ARM_PCT,
  momentumLiveDayEntryCutoffReached,
  momentumLiveEntryAllowed,
  momentumNextLiveEntryOpenMins,
  formatMomentumLiveScheduleLabel,
  momentumLiveRsiFromBarCloses,
  formatMomentumLiveRsiBucketsLabel,
  MOMENTUM_SCALPER_RSI_PERIOD,
  sessionCloseMinsForWeekday,
  indexPnlPts,
  isPastMomentumForceExit,
  istMinsFromDate,
  istTimeLabel,
  type MomentumExitProfile,
  type MomentumScalperExitState,
} from "./momentum-scalper-logic.js";

interface PendingSignal {
  side: DayScalperSide;
  signalTimeIst: string;
  movePts: number;
  /** Minute-of-day of the signal candle — entry logic only runs on the very next minute. */
  signalMins: number;
  /** Reference close from the signal candle — gate is measured against this. */
  signalClose: number;
  /** Last websocket tick on the signal candle — gate compares the next minute's first tick to this. */
  signalLastTick: number;
  /** Nifty at the second minute's first tick once the gate passes — pullback is measured from here. */
  entryStartPrice: number | null;
  /** True once the second minute's first tick has been checked against {@link signalLastTick}. */
  gateChecked: boolean;
  /** True once the first-tick gate cleared. */
  momentumGateSeen: boolean;
  /** Pullback entry already attempted for this setup. */
  entryAttempted: boolean;
  /**
   * Option premium the entry was sized and decided against, read the instant the open gate passed.
   * The market buy goes out immediately afterwards, so this is the quote the fill is judged
   * against rather than a level being waited for. null until the ATM contract is armed.
   */
  optionMarkPrice: number | null;
  /** Contract the mark belongs to. Entry must buy this one, not a freshly resolved ATM. */
  optionTradingsymbol: string | null;
  /** Latest Wilder RSI(14) on Nifty 1-min closes — refreshed on every websocket tick. */
  liveRsi: number | null;
}

export type MomentumScalperBotPhase =
  | "off"
  | "waiting"
  | "scanning"
  | "entering"
  | "in_position"
  | "exiting"
  | "done"
  | "error";

export interface MomentumExitRuleSummary {
  armPct: number;
  stepPct: number;
  /** Signed stop level on the P&L scale, e.g. −3. */
  initialStopPnlPct: number;
  initialStopHoldSec: number;
  /** True when the stop fires at the level itself rather than strictly beyond it. */
  stopBreachInclusive: boolean;
  /** Signed level that exits at once, with no hold and no limit, e.g. −6. */
  hardStopPnlPct: number;
}

export interface MomentumScalperBotStatus {
  enabled: boolean;
  phase: MomentumScalperBotPhase;
  dateIST: string;
  weekday: string;
  message: string;
  rules: typeof MOMENTUM_SCALPER_LIVE_RULES;
  wsConnected: boolean;
  tradesToday: number;
  /** True when today's session ended early because a trade closed at a loss. */
  stoppedForLossToday: boolean;
  /** Lots per entry (default 25), bought as a single order. */
  maxLots: number;
  /** Lots pre-armed for the pending signal's trigger, once priced. */
  plannedLots: number | null;
  /** Head-room % added to the premium when sizing, to cover the ask and charges. */
  premiumSafetyPct: number;
  pendingSignal: {
    side: DayScalperSide;
    signalTimeIst: string;
    movePts: number;
    /** Premium captured when the open gate passed; null until the gate passes and a tick lands. */
    optionMarkPrice: number | null;
    optionTradingsymbol: string | null;
    /** RSI(14) at the signal close, updated every Nifty tick during the momentum minute. */
    liveRsi: number | null;
  } | null;
  leg: TradeLeg | null;
  tradingsymbol: string | null;
  quantity: number | null;
  entryPrice: number | null;
  lastOptionPrice: number | null;
  entryIndexPrice: number | null;
  initialStopPnlPct: number;
  initialStopHoldSec: number;
  /** Signed hard-stop level for the active profile, e.g. −6. */
  hardStopPnlPct: number;
  /** True once a profit rung is locked on the P&L ladder. */
  trailing: boolean;
  /** Own-leg P&L as a percentage of premium paid. */
  pnlPct: number | null;
  /** Highest locked rung (also the current stop, in %). 0 = nothing locked yet. */
  pnlLockedPct: number;
  /** Next take-profit rung — reaching it expands the ladder, it does not exit. */
  pnlTargetPct: number | null;
  /** Current stop rung in % — the initial stop before the ladder locks, then the locked rung. */
  pnlStopPct: number | null;
  pnlArmPct: number;
  pnlStepPct: number;
  lastSpot: number | null;
  unrealisedPnl: number | null;
  indexPnlPts: number | null;
  lastBarTimeIst: string | null;
  completedBars: number;
  /** True once scanning is allowed (clock past the scan start). */
  nineSixteenSettled: boolean;
  /** Earliest IST entry windows for live Traps (e.g. 10:30–12:00 & 13:45–15:10). */
  scanStartIst: string | null;
  /** Exit ladder frozen at entry — opening window uses the 5% ladder. */
  exitProfile: MomentumExitProfile | null;
  /**
   * Both ladders, so the panel can describe each one without reading the *active* profile. Using
   * the active values there rendered the standard rules with the opening profile's stop and hold
   * whenever an opening-window trade was live.
   */
  exitRules: Record<MomentumExitProfile, MomentumExitRuleSummary>;
  /** Profit % the marketable limit will aim for when the locked floor is touched. */
  profitExitPnlPct: number | null;
  /** Premium that profit target works out to on this entry. */
  profitExitPrice: number | null;
  /** How far under the locked floor a profit exit is priced, in P&L %. */
  profitExitGivebackPct: number;
  /** Final MIS safety square-off for an open leg (entries stop earlier, at the trade window close). */
  forceExitIst: string;
  /** Wilder RSI(14) from live Nifty 1-min bars — null until 14 prior closes exist. */
  liveNiftyRsi: number | null;
  liveRsiBucketsIst: string;
  sessionConnected: boolean;
  updatedAt: string;
  logs: { time: string; message: string; type: "info" | "success" | "warning" | "error" }[];
}

const STATE_DIR = path.join(process.cwd(), "data");
const NIFTY_SPOT_KEY = "NSE:NIFTY 50";
const RSI_PREFILL_SESSION_OPEN_MINS = 9 * 60 + 15;
const RSI_PREFILL_SESSION_CLOSE_MINS = 15 * 60 + 30;
const STATE_FILE = path.join(STATE_DIR, "momentum-scalper-state.json");
const RAN_MARKER = (dateIst: string) => path.join(STATE_DIR, `momentum-scalper-ran-${dateIst}.json`);
const CLAIM_FILE = path.join(STATE_DIR, "momentum-scalper-claim.json");
const POLL_MS = 1000;
const POSITION_RECONCILE_MS = 5000;
/**
 * How long after an entry the broker reconcile refuses to declare the leg closed. The positions
 * book lags the fill, and a "closed" verdict inside that lag drops a live position: the bot stops
 * running its stop and ladder, books a fictional exit, and is free to open a second leg.
 */
const POSITION_RECONCILE_GRACE_MS = 20_000;
/** Consecutive broker readings agreeing the leg is gone before the bot lets go of it. */
const BROKER_CLOSED_CONFIRMATIONS = 2;
const SQUARE_OFF_MAX_ROUNDS = 3;
const MAX_PARALLEL_ORDERS = 9;
/**
 * One entry, one order, at most this many lots. Splitting a bigger size across parallel orders
 * left the bot tracking only part of its own position, so the whole trade is capped to a single
 * order instead — the exchange freeze limit for Nifty MIS is 25 lots anyway.
 */
const DEFAULT_MAX_LOTS = 25;
/**
 * Head-room added to the premium when working out how many lots the balance covers.
 *
 * Sizing runs off the last traded price, but a market BUY lifts the ask and then pays brokerage
 * and taxes on top, so the cash actually needed is always a little above premium × quantity. With
 * the balance buffer at its default of zero, every lot the bot can theoretically afford gets used
 * and that shortfall is exactly what comes back as an insufficient-funds rejection.
 */
function entryPremiumSafetyPct(): number {
  const raw = process.env.MOMENTUM_SCALPER_PREMIUM_SAFETY_PCT?.trim();
  const parsed = raw ? Number(raw) : 2;
  if (!Number.isFinite(parsed) || parsed < 0) return 2;
  return Math.min(parsed, 25);
}

/** The premium to size against: what the bot expects to actually pay, not the last print. */
function sizingPremium(premium: number): number {
  return premium * (1 + entryPremiumSafetyPct() / 100);
}

const SCHEDULE_LABEL = formatMomentumLiveScheduleLabel();
const DISABLED_MESSAGE = "Disabled — press Enable to arm Traps";
/**
 * Entry windows ({@link SCHEDULE_LABEL}) still gate new trades when the bot is armed; the schedule
 * no longer toggles the enabled flag — only the UI Enable button does.
 */
let scheduleDateIst: string | null = null;

/** Exported for schedule tests. */
export function momentumInScheduledWindow(nowMins: number): boolean {
  return momentumLiveEntryAllowed(nowMins);
}

/** @internal Exported for schedule regression tests. */
export function applyMomentumDailySchedule(dateIst: string, weekday: string, nowMs = Date.now()) {
  applyDailySchedule(dateIst, weekday, nowMs);
}

function applyDailySchedule(dateIst: string, weekday: string, nowMs = Date.now()) {
  if (weekday === "Saturday" || weekday === "Sunday") return;
  if (!enabled) return;

  if (scheduleDateIst !== dateIst) scheduleDateIst = dateIst;

  const nowMins = istMinsFromDate(new Date(nowMs));
  if (!momentumInScheduledWindow(nowMins)) return;

  const session = loadKiteSession();
  if (session?.accessToken) void warmRsiFromKiteHistory(session.accessToken, dateIst);
}

/** Traps scans only after the 9:16 trade entry window and before the afternoon cutoff. */
function momentumScanReady(nowMins: number): boolean {
  if (!momentumLiveEntryAllowed(nowMins)) return false;
  return isPast916EntryWindow();
}

/**
 * Earliest minute a signal candle may be read today.
 *
 * `resumeScanAfterMins` pushes the floor past a trade that already ran, so a single setup is not
 * re-entered from the same bar after a restart.
 */
function scanFloorMins(): number {
  return Math.max(resumeScanAfterMins, MOMENTUM_SCALPER_SCAN_START_MINS);
}

/**
 * Lots per entry. The balance may allow more; the extra is deliberately left on the table.
 *
 * Capped at the per-order freeze limit as well as the configured value, because the entry is a
 * single order by design. A larger number here would not split into several orders — it would go
 * out as one oversized order and be rejected by the exchange. Lowering it still works.
 */
function maxLotsPerTrade(): number {
  const ceiling = Math.max(1, Math.min(DEFAULT_MAX_LOTS, getMaxLotsPerOrder()));
  const raw = process.env.MOMENTUM_SCALPER_MAX_LOTS?.trim();
  if (!raw) return ceiling;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return ceiling;
  return Math.min(Math.floor(parsed), ceiling);
}

/**
 * Starts disabled until the UI Enable button arms it. The main loop always runs so an open position
 * can still be managed to its exit while disabled.
 */
let enabled = false;
let phase: MomentumScalperBotPhase = "off";
let message = DISABLED_MESSAGE;
let timer: ReturnType<typeof setTimeout> | null = null;
let tickerStop: (() => void) | null = null;
let tickerConn: NiftyTickerConnection | null = null;
let tickerAttaching = false;
let wsConnected = false;
let niftyInstrumentToken = 0;
let optionInstrumentToken = 0;

let lastSpot: number | null = null;
/** Wilder RSI(14) on Nifty 1-min closes — recomputed on every Nifty tick. */
let liveNiftyRsi: number | null = null;
let lastOptionPrice: number | null = null;
let tradingsymbol: string | null = null;
let quantity = 0;
let entryPrice = 0;
let entryIndexPrice = 0;
let entryTimeIst: string | null = null;
let positionLotSize = 0;
let leg: TradeLeg | null = null;
let unrealisedPnl: number | null = null;
let tradesToday = 0;
let resumeScanAfterMins = 0;

let pendingSignal: PendingSignal | null = null;
let exitState: MomentumScalperExitState | null = null;

/** Contract, premium and lot count resolved at the gate, immediately before the market buy. */
interface PreparedEntry {
  side: DayScalperSide;
  tradingsymbol: string;
  lotSize: number;
  instrumentToken: number;
  optionLtp: number;
  lots: number;
  quantity: number;
  /** Balance the sizing was computed against — reported when a margin reject downsizes it. */
  availableBalance: number;
  /** The pending signal this plan belongs to — never reuse across setups. */
  signalMins: number;
}

let preparedEntry: PreparedEntry | null = null;
let atmArmInFlight = false;
let marketEntryInFlight = false;

let completedBars: DayScalperCandle[] = [];
let currentBar: DayScalperCandle | null = null;
/** Session 1-min bars from Zerodha historical API — merged under live websocket bars for RSI. */
let rsiPrefillBars: DayScalperCandle[] = [];
let rsiPrefillDateIst: string | null = null;
let rsiPrefillPromise: Promise<void> | null = null;
let lastProcessedBarMins = -1;
let squareOffInFlight = false;

const logs: MomentumScalperBotStatus["logs"] = [];

interface PersistedState {
  dateIST: string;
  phase: MomentumScalperBotPhase;
  tradingsymbol: string | null;
  quantity: number;
  entryPrice: number;
  entryIndexPrice: number;
  entryTimeIst: string | null;
  positionLotSize: number;
  leg: TradeLeg | null;
  exitState: MomentumScalperExitState | null;
  tradesToday: number;
  resumeScanAfterMins: number;
  optionInstrumentToken: number;
}

/**
 * Written immediately before the entry order leaves, and only cleared once the leg is confirmed
 * flat. `momentum-scalper-state.json` is written after the fills land, so on its own it leaves a
 * window where a crash mid-entry loses all record of an open position and the bot restarts
 * believing it is flat — free to buy a second one. The claim closes that window.
 */
interface EntryClaim {
  dateIST: string;
  tradingsymbol: string;
  side: DayScalperSide;
  entryIndexPrice: number;
  lotSize: number;
  /** What this bot asked for. Caps recovery so lots it does not own are never adopted. */
  quantity: number;
  at: string;
}

let entryClaim: EntryClaim | null = null;

function writeEntryClaim(claim: EntryClaim) {
  entryClaim = claim;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CLAIM_FILE, JSON.stringify(claim, null, 2));
}

function clearEntryClaim() {
  entryClaim = null;
  if (fs.existsSync(CLAIM_FILE)) fs.unlinkSync(CLAIM_FILE);
}

/** True whenever there is a leg to look after — tracked, mid-exit, or only known via a claim. */
function isHoldingPosition(): boolean {
  return phase === "in_position" || phase === "exiting" || Boolean(entryClaim);
}

function loadEntryClaim(dateIst: string) {
  try {
    if (!fs.existsSync(CLAIM_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CLAIM_FILE, "utf-8")) as EntryClaim;
    // Yesterday's claim is meaningless — MIS legs never survive the session.
    if (parsed.dateIST !== dateIst) {
      clearEntryClaim();
      return;
    }
    entryClaim = parsed;
  } catch {
    clearEntryClaim();
  }
}

let sessionDateIst = "";

function ensureSessionDate(dateIst: string) {
  if (sessionDateIst === dateIst) return;
  sessionDateIst = dateIst;
  loadEntryClaim(dateIst);
  if (phase !== "in_position" && phase !== "exiting") {
    enabled = false;
    phase = "off";
    message = DISABLED_MESSAGE;
    completedBars = [];
    currentBar = null;
    lastProcessedBarMins = -1;
    clearPendingSignal();
    tradesToday = 0;
    resumeScanAfterMins = 0;
    rsiPrefillBars = [];
    rsiPrefillDateIst = null;
    rsiPrefillPromise = null;
    liveNiftyRsi = null;
  }
}

function pushLog(note: string, type: MomentumScalperBotStatus["logs"][number]["type"] = "info") {
  // Must be pinned to IST: the server runs in UTC, so the host's local time is 5:30 behind.
  logs.unshift({ time: getIndianMarketContext().timeIST, message: note, type });
  if (logs.length > 30) logs.length = 30;
  console.log(`[traps] ${note}`);
}

function saveState(dateIst: string) {
  if (phase !== "in_position" && phase !== "exiting") {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    return;
  }
  const payload: PersistedState = {
    dateIST: dateIst,
    phase,
    tradingsymbol,
    quantity,
    entryPrice,
    entryIndexPrice,
    entryTimeIst,
    positionLotSize,
    leg,
    exitState,
    tradesToday,
    resumeScanAfterMins,
    optionInstrumentToken,
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

/**
 * A state file written before the index trail was replaced by the P&L ladder has no
 * `lockedPnlPct`. Rebuild it rather than resuming with an undefined field, which would disable
 * the stop entirely.
 */
function normalizeExitState(state: MomentumScalperExitState | null): MomentumScalperExitState | null {
  if (!state) return null;
  const legacy = state as Partial<MomentumScalperExitState>;
  return {
    ...state,
    exitProfile: legacy.exitProfile === "opening" ? "opening" : "standard",
    lockedPnlPct: Number.isFinite(legacy.lockedPnlPct) ? Number(legacy.lockedPnlPct) : 0,
    initialStopBreachSinceMs:
      legacy.initialStopBreachSinceMs != null && Number.isFinite(legacy.initialStopBreachSinceMs)
        ? Number(legacy.initialStopBreachSinceMs)
        : null,
  };
}

function exitProfileForEntry(now = new Date()): MomentumExitProfile {
  return momentumExitProfileForEntryMins(istMinsFromDate(now));
}

function activeExitProfile(): MomentumExitProfile {
  return exitState?.exitProfile ?? "standard";
}

function exitRuleSummary(profile: MomentumExitProfile): MomentumExitRuleSummary {
  const config = momentumExitProfileConfig(profile);
  return {
    armPct: config.armPct,
    stepPct: config.stepPct,
    initialStopPnlPct: -config.initialStopLossPct,
    initialStopHoldSec: config.initialStopHoldMs / 1000,
    stopBreachInclusive: profile !== "opening",
    hardStopPnlPct: -config.hardStopLossPct,
  };
}

function exitProfileLabel(profile: MomentumExitProfile): string {
  return profile === "opening" ? "opening window (09:15–09:20)" : "standard";
}

let stateLoadedForDate: string | null = null;

/**
 * Hydrate the persisted position at most once per session date.
 *
 * The poll loop used to call {@link loadState} on every iteration, which overwrote live in-memory
 * state with the last snapshot written to disk. State is only persisted on entry and when a profit
 * rung locks, so the initial-stop hold timer — which lives purely in memory between those points —
 * was reset to null roughly once a second and could never reach its hold. That silently disabled
 * the held stops (now only the opening profile's −10% one; the standard −4% stop exits at once).
 */
function loadStateOnce(dateIst: string) {
  if (stateLoadedForDate === dateIst) return;
  stateLoadedForDate = dateIst;
  loadState(dateIst);
}

function loadState(dateIst: string) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PersistedState;
    if (parsed.dateIST !== dateIst) return;
    phase = parsed.phase;
    tradingsymbol = parsed.tradingsymbol;
    quantity = parsed.quantity;
    entryPrice = parsed.entryPrice;
    entryIndexPrice = parsed.entryIndexPrice;
    entryTimeIst = parsed.entryTimeIst ?? null;
    positionLotSize = parsed.positionLotSize;
    leg = parsed.leg;
    exitState = normalizeExitState(parsed.exitState);
    // A pending signal only lives for one momentum candle, so it is never persisted — but an
    // in-memory one from before the reload has to go, or it outlives its candle.
    clearPendingSignal();
    tradesToday = parsed.tradesToday;
    resumeScanAfterMins = parsed.resumeScanAfterMins;
    optionInstrumentToken = parsed.optionInstrumentToken;
    // Restart the grace window rather than trusting the old fill time: the bot should be sure the
    // broker book has caught up before it can decide a recovered leg is gone.
    positionOpenedAtMs = phase === "in_position" || phase === "exiting" ? Date.now() : 0;
    brokerClosedStreak = 0;
    message = `Recovered ${phase} · ${tradingsymbol ?? "—"}`;
  } catch {
    /* ignore corrupt state */
  }
}

function sessionAlreadyDone(dateIst: string): boolean {
  return fs.existsSync(RAN_MARKER(dateIst));
}

function sessionStoppedForLoss(dateIst: string): boolean {
  try {
    const raw = fs.readFileSync(RAN_MARKER(dateIst), "utf-8");
    const parsed = JSON.parse(raw) as { reason?: string };
    return parsed.reason === "loss";
  } catch {
    return false;
  }
}

function markSessionDone(dateIst: string, reason: "loss" | "finished" = "finished") {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    RAN_MARKER(dateIst),
    JSON.stringify({ dateIST: dateIst, at: new Date().toISOString(), reason }),
  );
}

function closedTradeWasLoss(
  pnl: number | null,
  entryPrem: number,
  qty: number,
  fallbackUnrealised: number | null,
): boolean {
  if (pnl != null) return pnl < 0;
  const pct = momentumPnlPctOfEntryCost(fallbackUnrealised, entryPrem, qty);
  return pct != null && pct < 0;
}

function stopTrapsAfterLoss(dateIst: string, pnlLabel: string) {
  enabled = false;
  clearPendingSignal();
  const note =
    `Stopped for the day after a loss${pnlLabel} — resumes tomorrow ${formatIstMins(MOMENTUM_SCALPER_SCAN_START_MINS)}`;
  finishDay(dateIst, note, "loss");
}

function updateCurrentBar(spot: number, now = new Date()) {
  const mins = istMinsFromDate(now);
  if (!currentBar || currentBar.mins !== mins) {
    if (currentBar) {
      completedBars.push({ ...currentBar });
    }
    // Only a new bar needs its label and ISO stamp — both are wasted work on the other ~99% of ticks.
    currentBar = {
      time: now.toISOString(),
      timeIst: formatIstMins(mins),
      mins,
      open: spot,
      high: spot,
      low: spot,
      close: spot,
    };
    return;
  }
  currentBar.high = Math.max(currentBar.high, spot);
  currentBar.low = Math.min(currentBar.low, spot);
  currentBar.close = spot;
}

async function placeSplitOrders(
  accessToken: string,
  input: {
    tradingsymbol: string;
    transaction_type: "BUY" | "SELL";
    quantities: number[];
    /** Set to rest the order instead of crossing the spread. */
    limitPrice?: number;
  },
) {
  const orderIds: string[] = [];
  const failures: Error[] = [];
  for (let i = 0; i < input.quantities.length; i += MAX_PARALLEL_ORDERS) {
    const burst = input.quantities.slice(i, i + MAX_PARALLEL_ORDERS);
    const results = await Promise.allSettled(
      burst.map((quantity) =>
        input.limitPrice != null
          ? placeRegularLimitOrder(accessToken, {
              tradingsymbol: input.tradingsymbol,
              exchange: "NFO",
              transaction_type: input.transaction_type,
              product: "MIS",
              quantity,
              price: input.limitPrice,
            })
          : placeRegularMarketOrder(accessToken, {
              tradingsymbol: input.tradingsymbol,
              exchange: "NFO",
              transaction_type: input.transaction_type,
              product: "MIS",
              quantity,
            }),
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") orderIds.push(result.value);
      else failures.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    }
    if (i + MAX_PARALLEL_ORDERS < input.quantities.length) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }
  return { orderIds, failures };
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pull resting limit orders and report what they actually traded.
 *
 * Cancelling is not the end of the story: a fill can land in the moment between the read and the
 * cancel, so the filled quantity is re-read afterwards. Under-counting here would make the bot
 * re-sell lots it no longer owns.
 */
async function settleLimitOrders(accessToken: string, orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0;

  const before = await fetchOrdersByIds(accessToken, orderIds).catch(() => null);
  await Promise.allSettled(
    orderIds
      .filter((id) => (before?.get(id)?.status ?? "OPEN") !== "COMPLETE")
      .map((id) => cancelRegularOrder(accessToken, id).catch(() => undefined)),
  );

  // Let the cancels register before taking the number that decides what is still owed.
  await sleepMs(150);
  const after = await fetchOrdersByIds(accessToken, orderIds).catch(() => before);

  let filled = 0;
  for (const id of orderIds) {
    const row = after?.get(id) ?? before?.get(id);
    filled += Number(row?.filled_quantity) || 0;
  }
  return filled;
}

/**
 * Send the remaining quantity out at market. Used for stops, force exits and manual closes.
 */
async function marketSellQuantity(
  accessToken: string,
  symbol: string,
  totalQty: number,
  lotSize: number,
  reason: string,
): Promise<number> {
  const quantities = splitQuantityIntoOrderChunks(totalQty, lotSize);
  pushLog(`MARKET SELL ${totalQty} qty — ${reason}`);
  const placed = await placeSplitOrders(accessToken, {
    tradingsymbol: symbol,
    transaction_type: "SELL",
    quantities,
  });
  for (const failure of placed.failures) {
    pushLog(`Exit order rejected · ${failure.message}`, "error");
  }
  if (placed.orderIds.length === 0) return 0;

  let filledTotal = 0;
  const settled = await Promise.allSettled(
    placed.orderIds.map((orderId) => waitForOrderComplete(accessToken, orderId)),
  );
  for (const row of settled) {
    if (row.status === "fulfilled") filledTotal += row.value.filled_quantity;
    else if (row.reason instanceof KiteOrderRejectedError) {
      filledTotal += row.reason.filledQuantity;
    }
  }
  return filledTotal;
}

/**
 * How long a marketable profit limit is given to trade before the rest is crossed at market.
 *
 * It is priced through the touch, so in a normal book it fills on arrival and this timer never
 * matters. It exists for the case it is there to survive: a gap that leaves the limit stranded
 * above the market, where waiting any longer only widens the loss.
 */
const MOMENTUM_PROFIT_EXIT_FILL_WINDOW_MS = 2_000;
const MOMENTUM_PROFIT_EXIT_POLL_MS = 200;

/**
 * Sell `totalQty` with a limit priced through the touch, and report what actually traded.
 *
 * The orders go out before anything is polled, so the decision to exit and the order hitting the
 * exchange are not separated by a round trip.
 */
async function marketableLimitSell(
  accessToken: string,
  symbol: string,
  totalQty: number,
  lotSize: number,
  limitPrice: number,
): Promise<number> {
  const placed = await placeSplitOrders(accessToken, {
    tradingsymbol: symbol,
    transaction_type: "SELL",
    quantities: splitQuantityIntoOrderChunks(totalQty, lotSize),
    limitPrice,
  });
  for (const failure of placed.failures) {
    pushLog(`Exit limit rejected · ${failure.message}`, "error");
  }
  if (placed.orderIds.length === 0) return 0;

  const deadline = Date.now() + MOMENTUM_PROFIT_EXIT_FILL_WINDOW_MS;
  while (Date.now() < deadline) {
    await sleepMs(MOMENTUM_PROFIT_EXIT_POLL_MS);
    const rows = await fetchOrdersByIds(accessToken, placed.orderIds).catch(() => null);
    if (!rows) continue;
    let done = 0;
    let filled = 0;
    for (const id of placed.orderIds) {
      const row = rows.get(id);
      filled += Number(row?.filled_quantity) || 0;
      const status = row?.status ?? "";
      if (status === "COMPLETE" || status === "CANCELLED" || status === "REJECTED") done += 1;
    }
    if (done === placed.orderIds.length) {
      if (filled > 0) pushLog(`Exit limit filled ${filled} qty @ ₹${limitPrice.toFixed(2)}`, "success");
      return filled;
    }
  }

  // Cancels whatever is still working and returns the quantity that traded in the meantime.
  const filled = await settleLimitOrders(accessToken, placed.orderIds);
  if (filled > 0) pushLog(`Exit limit filled ${filled} qty @ ₹${limitPrice.toFixed(2)}`, "success");
  return filled;
}

async function completeTrackedExit(
  accessToken: string,
  dateIst: string,
  reason: string,
  exitIndexPrice: number,
  exitOptPrice: number | null,
) {
  if (!tradingsymbol || quantity <= 0) return;

  const symbol = tradingsymbol;
  const closedQty = quantity;
  const closedEntry = entryPrice;
  const fallbackUnrealised = unrealisedPnl;
  const side: DayScalperSide = leg?.startsWith("PE") ? "PE" : "CE";
  const idxPnl = indexPnlPts(side, entryIndexPrice, exitIndexPrice);
  const resolvedExitPrice = exitOptPrice ?? lastOptionPrice;
  const pnl =
    resolvedExitPrice != null && closedEntry > 0
      ? (resolvedExitPrice - closedEntry) * closedQty
      : fallbackUnrealised;

  clearEntryClaim();

  await persistTrade(dateIst, "closed", reason, {
    status: "closed",
    leg,
    tradingsymbol: symbol,
    quantity: closedQty,
    entryPrice,
    entrySpot: entryIndexPrice,
    exitSpot: exitIndexPrice,
    exitPrice: resolvedExitPrice,
    pnl,
    exitReason: reason,
    closedAt: new Date().toISOString(),
    message: `${reason} · index ${idxPnl >= 0 ? "+" : ""}${idxPnl.toFixed(2)} pts`,
  });

  positionOpenedAtMs = 0;
  brokerClosedStreak = 0;
  tradingsymbol = null;
  quantity = 0;
  entryPrice = 0;
  entryIndexPrice = 0;
  entryTimeIst = null;
  leg = null;
  exitState = null;
  unrealisedPnl = null;
  lastOptionPrice = null;
  optionInstrumentToken = 0;
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  const ctx = getIndianMarketContext();
  const closeMins = sessionCloseMinsForWeekday(
    formatWeekdayFromDateKey(ctx.dateIST),
    MOMENTUM_SCALPER_LIVE_RULES,
  );
  pushLog(reason, "success");
  if (closedTradeWasLoss(pnl, closedEntry, closedQty, fallbackUnrealised)) {
    const pnlLabel = pnl != null ? ` (₹${pnl.toFixed(0)})` : "";
    stopTrapsAfterLoss(ctx.dateIST, pnlLabel);
    return;
  }

  if (istMinsFromDate(new Date()) >= closeMins) {
    finishDay(ctx.dateIST, "Trade closed after the entry cutoff — done for today");
    return;
  }

  resumeScanAfterMins = istMinsFromDate(new Date());
  phase = "scanning";
  message = "Flat — resuming scan";
  attachTicker(accessToken);
}

/**
 * Book the entry from this bot's own fills. The broker's net MIS position for the contract is
 * deliberately not used — the 9:16 bot can hold lots in the same ATM strike, and inheriting its
 * quantity made both bots manage (and square off) each other's legs.
 */
function applyOwnEntryFills(
  symbol: string,
  lotSize: number,
  fills: { average_price: number; filled_quantity: number }[],
): boolean {
  let notional = 0;
  let filledQty = 0;
  for (const fill of fills) {
    if (fill.filled_quantity > 0 && fill.average_price > 0) {
      notional += fill.average_price * fill.filled_quantity;
      filledQty += fill.filled_quantity;
    }
  }
  if (filledQty <= 0) return false;

  tradingsymbol = symbol;
  quantity = filledQty;
  entryPrice = notional / filledQty;
  positionLotSize = lotSize;
  // Seed the mark at cost so P&L reads 0 until the first live tick, never a stale price.
  lastOptionPrice = entryPrice;
  unrealisedPnl = 0;
  return true;
}

/**
 * Settle a claim that outlived its position record. Either the leg is still open at the broker —
 * in which case this bot takes its own lots back under management rather than buying again — or
 * it is gone and the claim is dropped so scanning can resume. Entries stay blocked until then.
 */
async function resolveEntryClaim(accessToken: string, dateIst: string) {
  const claim = entryClaim;
  if (!claim) return;
  // Nothing to settle while a position is already tracked or an entry is mid-flight.
  if (phase === "entering" || phase === "in_position" || phase === "exiting") return;

  let position: Awaited<ReturnType<typeof fetchMisPosition>>;
  try {
    position = await fetchMisPosition(accessToken, claim.tradingsymbol);
  } catch {
    // Keep the claim: entries stay blocked until the broker can actually confirm the leg.
    return;
  }

  if (!position || position.quantity <= 0) {
    pushLog(`Claimed ${claim.tradingsymbol} is flat at Zerodha — clearing claim`, "info");
    clearEntryClaim();
    return;
  }

  // Only ever take back what this bot bought, even if the strike holds more.
  const ownQty = Math.min(position.quantity, claim.quantity);
  const avgPrice = position.average_price > 0 ? position.average_price : 0;
  if (ownQty <= 0 || avgPrice <= 0) {
    pushLog(`Claimed ${claim.tradingsymbol} has no usable fill data — clearing claim`, "warning");
    clearEntryClaim();
    return;
  }

  tradingsymbol = claim.tradingsymbol;
  quantity = ownQty;
  entryPrice = avgPrice;
  entryIndexPrice = claim.entryIndexPrice;
  entryTimeIst = istTimeLabel(new Date(claim.at));
  positionOpenedAtMs = entryAnchorMs() || Date.now();
  brokerClosedStreak = 0;
  positionLotSize = claim.lotSize > 0 ? claim.lotSize : 65;
  leg = claim.side === "CE" ? "CE_BUY" : "PE_BUY";
  exitState = createExitState(claim.side, entryIndexPrice, exitProfileForEntry(new Date(claim.at)));
  lastOptionPrice = position.last_price > 0 ? position.last_price : avgPrice;
  unrealisedPnl = (lastOptionPrice - entryPrice) * quantity;
  clearPendingSignal();
  phase = "in_position";
  message = `Recovered ${claim.side} · ${claim.tradingsymbol} · ${ownQty} qty`;
  pushLog(
    `Recovered an unrecorded ${claim.side} leg from the entry claim · ${claim.tradingsymbol} · ` +
      `${ownQty} qty @ ${avgPrice.toFixed(2)} · exit ladder re-anchored at index ${entryIndexPrice.toFixed(2)}`,
    "warning",
  );

  optionInstrumentToken =
    optionInstrumentToken > 0
      ? optionInstrumentToken
      : ((await resolveInstrumentToken("NFO", claim.tradingsymbol, accessToken)) ?? 0);
  attachTicker(accessToken);
  saveState(dateIst);
}

/**
 * Pay the slow, signal-independent costs while the momentum candle is still forming.
 *
 * Everything here is a cache fill, so nothing it does is visible in the trade — but each one is a
 * network round trip that would otherwise sit between the gate passing and the order going out.
 * The egress route in particular expires every 45 seconds and re-probes the outbound IP several
 * times when it does, which is by far the worst thing that can happen on the entry path.
 *
 * Failures are swallowed: this is an optimisation, and {@link buildEntryPlan} re-checks the same
 * things for real. Fired at most once per pending signal.
 */
function warmEntryPath(accessToken: string) {
  void Promise.allSettled([
    assertKiteEgressReady(),
    prewarmNiftyOptionChain(),
    fetchEquityAvailableBalance(accessToken),
  ]);
}

/**
 * Size the entry as one order of at most {@link maxLotsPerTrade} lots. What the balance would
 * allow beyond that is intentionally unused — a second order would leave part of the position
 * outside what this bot tracks and manages to its exit.
 */
async function buildEntryPlan(
  accessToken: string,
  side: DayScalperSide,
  spot: number,
  signalMins: number,
): Promise<PreparedEntry> {
  const entryLeg: TradeLeg = side === "CE" ? "CE_BUY" : "PE_BUY";

  // The egress check and the contract lookup need nothing from each other, so they overlap. Spot
  // comes from the live tick, which keeps the ATM resolution off the /quote endpoint entirely.
  const [, resolved] = await Promise.all([
    assertKiteEgressReady(),
    resolveAtmNiftyOption(accessToken, entryLeg, { spotPrice: spot }),
  ]);
  if (!resolved) throw new Error("ATM option not found");

  // Likewise the premium and the balance: sizing needs both, neither needs the other. Serialising
  // them used to cost a whole round trip before the market order could go out.
  const [optionLtp, availableBalance] = await Promise.all([
    fetchOptionLtp(accessToken, resolved.tradingsymbol),
    fetchEquityAvailableBalance(accessToken),
  ]);
  if (optionLtp <= 0) throw new Error("Option LTP unavailable");

  const { lots, costPerLot, usableBalance } = computeAffordableLots({
    availableBalance,
    lotSize: resolved.lotSize,
    optionLtp: sizingPremium(optionLtp),
  });
  const cappedLots = Math.min(lots, Math.floor(maxLotsPerTrade()));
  const quantity = cappedLots * resolved.lotSize;

  if (cappedLots <= 0 || quantity <= 0) {
    // Name the numbers — "balance too low" on its own gives nothing to act on.
    throw new Error(
      `Balance too low for 1 lot of ${resolved.tradingsymbol} — need ~₹${Math.ceil(costPerLot)} ` +
        `(₹${optionLtp.toFixed(2)} × ${resolved.lotSize} + ${entryPremiumSafetyPct()}% headroom), ` +
        `usable ₹${Math.floor(usableBalance)} of ₹${Math.floor(availableBalance)} available`,
    );
  }

  return {
    side,
    tradingsymbol: resolved.tradingsymbol,
    lotSize: resolved.lotSize,
    instrumentToken: resolved.instrumentToken,
    optionLtp,
    lots: cappedLots,
    quantity,
    availableBalance,
    signalMins,
  };
}

/**
 * Pick the next size to try after the broker refused the current one for funds.
 *
 * Zerodha usually quotes the required and available margin back, and scaling the lot count by that
 * ratio lands on an affordable size in one step. Without those figures there is nothing to compute
 * from, so it steps down a single lot. Either way the result is always at least one lot smaller,
 * so the retry loop cannot spin on the same quantity.
 */
export function nextEntryLotsAfterMarginReject(
  currentLots: number,
  shortfall: { required: number; available: number } | null,
): number {
  if (currentLots <= 1) return 0;
  let next = currentLots - 1;
  if (shortfall && shortfall.required > 0) {
    const scaled = Math.floor((currentLots * shortfall.available) / shortfall.required);
    if (scaled < next) next = scaled;
  }
  return Math.max(0, next);
}

/**
 * Resolve the ATM contract once the gate passed and the 2-pt pullback printed, then buy at market.
 *
 * The strike is chosen from the live Nifty spot at that moment — not from the signal candle close,
 * which can be a minute and several points away. {@link buildEntryPlan} also quotes the premium and
 * sizes the order against a freshly read balance, so by the time it returns there is nothing left
 * to wait for and the order goes straight out.
 */
async function armAtmContractForSignal(accessToken: string, side: DayScalperSide, spot: number) {
  const signal = pendingSignal;
  if (!signal || signal.side !== side || !signal.momentumGateSeen) return;
  if (signal.optionTradingsymbol != null) return;
  if (atmArmInFlight) return;
  if (!(spot > 0)) return;

  atmArmInFlight = true;
  try {
    const plan = await buildEntryPlan(accessToken, side, spot, signal.signalMins);
    if (!pendingSignal || pendingSignal.side !== side || !pendingSignal.momentumGateSeen) return;
    preparedEntry = plan;
    pendingSignal.optionTradingsymbol = plan.tradingsymbol;
    pendingSignal.optionMarkPrice = plan.optionLtp;
    pushLog(
      `ATM armed — ${plan.tradingsymbol} @ Nifty ${spot.toFixed(2)}, ` +
        `premium ₹${plan.optionLtp.toFixed(2)} · buying at market now.`,
      "info",
    );
  } catch (err) {
    pushLog(
      `ATM arm failed — ${err instanceof Error ? err.message : "could not resolve the ATM leg"}`,
      "warning",
    );
    clearPendingSignal();
    return;
  } finally {
    atmArmInFlight = false;
  }

  await enterAtMarket(accessToken, spot);
}


/**
 * Close the position and book the trade.
 *
 * @param limitPrice Marketable limit for the first round, used by profit exits off a locked floor.
 *   Omitted for stops, the {@link MOMENTUM_SCALPER_FORCE_EXIT_IST} guard and manual closes, which
 *   cross at market. Any round after the first crosses regardless — the patient price has already
 *   been tried by then.
 */
async function squareOff(
  accessToken: string,
  reason: string,
  exitIndexPrice: number,
  limitPrice?: number,
) {
  if (squareOffInFlight || !tradingsymbol || quantity <= 0) return;
  squareOffInFlight = true;
  phase = "exiting";
  message = reason;
  pushLog(reason, "success");

  const symbol = tradingsymbol;
  const lotSize = positionLotSize > 0 ? positionLotSize : 65;
  const side: DayScalperSide = leg?.startsWith("PE") ? "PE" : "CE";
  const idxPnl = indexPnlPts(side, entryIndexPrice, exitIndexPrice);

  try {
    let remainingQty = quantity;
    let filledWhollyOnLimit = false;

    if (limitPrice != null && limitPrice > 0) {
      pushLog(
        `LIMIT SELL ${remainingQty} qty @ ₹${limitPrice.toFixed(2)} — marketable, priced through the touch`,
      );
      const filled = await marketableLimitSell(accessToken, symbol, remainingQty, lotSize, limitPrice);
      remainingQty -= filled;
      if (remainingQty > 0 && (await fetchNetQty(accessToken, symbol)) <= 0) remainingQty = 0;
      filledWhollyOnLimit = remainingQty <= 0 && filled >= quantity;
    }

    for (let round = 1; round <= SQUARE_OFF_MAX_ROUNDS && remainingQty > 0; round += 1) {
      const brokerQty = await fetchNetQty(accessToken, symbol);
      if (brokerQty <= 0) break;

      const filled = await marketSellQuantity(
        accessToken,
        symbol,
        Math.min(remainingQty, brokerQty),
        lotSize,
        round === 1 ? reason : `retry ${round}/${SQUARE_OFF_MAX_ROUNDS}`,
      );
      remainingQty -= filled;
      if ((await fetchNetQty(accessToken, symbol)) <= 0) remainingQty = 0;
    }

    if (remainingQty > 0) {
      quantity = remainingQty;
      phase = "in_position";
      message = `Exit incomplete — ${remainingQty} qty still open`;
      pushLog(
        `Exit incomplete · ${remainingQty} qty of ${symbol} is still open after ` +
          `${SQUARE_OFF_MAX_ROUNDS} rounds — holding the position and retrying, no new trade ` +
          `will start until it is flat. Check Zerodha.`,
        "error",
      );
      saveState(getIndianMarketContext().dateIST);
      return;
    }

    // A limit that took the whole position traded at its own price. Reading the LTP back would
    // book the trade at wherever the premium drifted to in the seconds after the fill.
    let exitOptPrice: number | null = filledWhollyOnLimit ? (limitPrice ?? null) : null;
    if (exitOptPrice == null) {
      try {
        exitOptPrice = await fetchOptionLtp(accessToken, symbol);
      } catch {
        exitOptPrice = lastOptionPrice;
      }
    }
    await completeTrackedExit(accessToken, getIndianMarketContext().dateIST, reason, exitIndexPrice, exitOptPrice);
    void idxPnl;
  } catch (err) {
    phase = "in_position";
    message = err instanceof Error ? err.message : "Exit failed";
    pushLog(message, "error");
    saveState(getIndianMarketContext().dateIST);
  } finally {
    squareOffInFlight = false;
  }
}

async function persistTrade(
  dateIst: string,
  status: BotTradeLogStatus,
  note: string,
  extra: Partial<{
    leg: TradeLeg | null;
    tradingsymbol: string | null;
    quantity: number | null;
    entryPrice: number | null;
    entrySpot: number | null;
    exitSpot: number | null;
    exitPrice: number | null;
    pnl: number | null;
    exitReason: string | null;
    closedAt: string | null;
    message: string;
    status: BotTradeLogStatus;
  }> = {},
) {
  const id =
    extra.closedAt != null
      ? makeStrategyTradeLogId(dateIst, "momentum-scalper", extra.tradingsymbol ?? tradingsymbol, entryTimeIst)
      : makeBotTradeLogId(dateIst, extra.tradingsymbol ?? tradingsymbol);
  await appendBotTradeLog({
    id,
    source: "momentum-scalper",
    dateIST: dateIst,
    status: extra.status ?? status,
    leg: extra.leg ?? leg,
    tradingsymbol: extra.tradingsymbol ?? tradingsymbol,
    quantity: extra.quantity ?? (quantity > 0 ? quantity : null),
    open915: null,
    entrySpot: extra.entrySpot ?? (entryIndexPrice > 0 ? entryIndexPrice : lastSpot),
    targetSpot: null,
    entryPrice: extra.entryPrice ?? (entryPrice > 0 ? entryPrice : null),
    exitPrice: extra.exitPrice ?? null,
    exitSpot: extra.exitSpot ?? null,
    pnl: extra.pnl ?? null,
    exitReason: extra.exitReason ?? note,
    message: extra.message ?? note,
    logs: [...logs].slice(0, 12).reverse(),
    createdAt: new Date().toISOString(),
    closedAt: extra.closedAt ?? null,
    entryTimeIst,
    exitTimeIst: extra.closedAt != null ? istTimeLabel(new Date()) : null,
  });
}

function finishDay(dateIst: string, note: string, reason: "loss" | "finished" = "finished") {
  phase = "done";
  message = note;
  pushLog(note, reason === "loss" ? "warning" : "info");
  markSessionDone(dateIst, reason);
  if (tickerStop) {
    tickerStop();
    tickerStop = null;
  }
}

let lastPositionReconcileAt = 0;
let positionReconcileInFlight = false;
/** Wall clock of the fill this bot is currently managing — anchors the reconcile grace window. */
let positionOpenedAtMs = 0;
let brokerClosedStreak = 0;

function resetTrackedPosition() {
  positionOpenedAtMs = 0;
  brokerClosedStreak = 0;
  tradingsymbol = null;
  quantity = 0;
  entryPrice = 0;
  entryIndexPrice = 0;
  entryTimeIst = null;
  positionLotSize = 0;
  leg = null;
  exitState = null;
  unrealisedPnl = null;
  lastOptionPrice = null;
  optionInstrumentToken = 0;
  clearEntryClaim();
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

function entryAnchorMs(): number {
  if (entryClaim?.at) {
    const ms = new Date(entryClaim.at).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

async function resolveExternalExitPrice(accessToken: string, symbol: string): Promise<number | null> {
  const entryMs = entryAnchorMs();
  try {
    const orders = await kiteGet<
      {
        tradingsymbol: string;
        transaction_type: string;
        status: string;
        average_price: number;
        order_timestamp: string;
      }[]
    >("/orders", accessToken);
    const exitOrder = orders
      .filter(
        (o) =>
          o.tradingsymbol === symbol &&
          o.transaction_type === "SELL" &&
          o.status === "COMPLETE" &&
          o.average_price > 0 &&
          (entryMs <= 0 || new Date(o.order_timestamp).getTime() >= entryMs),
      )
      .sort(
        (a, b) => new Date(b.order_timestamp).getTime() - new Date(a.order_timestamp).getTime(),
      )[0];
    if (exitOrder) return exitOrder.average_price;
  } catch {
    /* use LTP fallback */
  }
  if (lastOptionPrice != null && lastOptionPrice > 0) return lastOptionPrice;
  try {
    const ltp = await fetchOptionLtp(accessToken, symbol);
    return ltp > 0 ? ltp : null;
  } catch {
    return null;
  }
}

/**
 * Whether the broker's answer means this bot's leg is gone. Pure so it can be tested directly —
 * getting it wrong is the worst failure mode the bot has: it abandons a live position, stops
 * running the stop and ladder, books an invented exit, and is free to open a second leg.
 *
 * @internal Exported for reconcile regression tests.
 */
export function evaluateBrokerLegClosed(input: {
  /** Time since the fill, or null when unknown. Inside the grace window nothing is concluded. */
  positionAgeMs: number | null;
  /** Whether the positions book carried a row for the contract at all. */
  brokerFound: boolean;
  brokerQty: number;
  /** Quantity this bot booked from its own BUY fills. */
  ownQty: number;
  /** SELL quantity that landed on the contract after our entry. */
  sellQtyAfterEntry: number;
  graceMs?: number;
}): boolean {
  if (input.ownQty <= 0) return false;

  // Zerodha's positions book trails the fill by a few seconds. Concluding anything about a leg
  // this young would just be reading the lag.
  const grace = input.graceMs ?? POSITION_RECONCILE_GRACE_MS;
  if (input.positionAgeMs != null && input.positionAgeMs < grace) return false;

  // No row at all means the book has not published the contract, not that it is flat: a closed
  // intraday leg stays in the book at quantity 0.
  if (!input.brokerFound) return false;
  if (input.brokerQty <= 0) return true;

  // The book still holds at least our size, so our lots cannot all be gone — whatever was sold
  // belonged to someone else. Selling in a shared strike is not evidence about *our* leg: on
  // 2026-08-28 a manual 3445-qty exit in the same contract would otherwise have been read as
  // covering the bot's 1625 and released a position that was still fully open.
  if (input.brokerQty >= input.ownQty) return false;

  // Below our size, so part of our leg is provably gone. Release only once enough selling landed
  // after our entry to account for the whole of it.
  return input.sellQtyAfterEntry >= input.ownQty;
}

/**
 * True when Zerodha no longer holds this bot's own leg — either the contract is flat, or enough
 * SELL fills landed after our entry to cover the quantity we booked from our own BUY fills.
 */
async function brokerShowsOwnLegClosed(accessToken: string): Promise<boolean> {
  if (!tradingsymbol || quantity <= 0) return false;

  const symbol = tradingsymbol;
  const ownQty = quantity;
  const positionAgeMs = positionOpenedAtMs > 0 ? Date.now() - positionOpenedAtMs : null;

  // Inside the grace window the answer cannot change the verdict, so skip the broker call.
  if (positionAgeMs != null && positionAgeMs < POSITION_RECONCILE_GRACE_MS) return false;

  const broker = await fetchMisNetPosition(accessToken, symbol);
  const entryMs = entryAnchorMs();

  let sellQtyAfterEntry = 0;
  if (broker.found && broker.quantity > 0 && entryMs > 0) {
    try {
      const trades = await fetchTradeBook(accessToken);
      for (const row of trades) {
        if (row.tradingsymbol !== symbol || row.product !== "MIS" || row.transaction_type !== "SELL") {
          continue;
        }
        const ts = Date.parse(
          row.fill_timestamp ?? row.exchange_timestamp ?? row.order_timestamp ?? "",
        );
        if (!(Number.isFinite(ts) && ts >= entryMs)) continue;
        sellQtyAfterEntry += row.quantity;
      }
    } catch {
      /* cannot confirm partial close */
    }
  }

  return evaluateBrokerLegClosed({
    positionAgeMs,
    brokerFound: broker.found,
    brokerQty: broker.quantity,
    ownQty,
    sellQtyAfterEntry,
  });
}

async function closePositionAfterExternalExit(
  accessToken: string,
  dateIst: string,
  reason: string,
) {
  if (!tradingsymbol || quantity <= 0) return;

  const symbol = tradingsymbol;
  const closedQty = quantity;
  const closedEntry = entryPrice;
  const closedIndexEntry = entryIndexPrice;
  const closedLeg = leg;
  const side: DayScalperSide = leg?.startsWith("PE") ? "PE" : "CE";
  const exitIndexPrice = lastSpot != null && lastSpot > 0 ? lastSpot : closedIndexEntry;
  const idxPnl = indexPnlPts(side, closedIndexEntry, exitIndexPrice);

  const exitOptPrice = await resolveExternalExitPrice(accessToken, symbol);
  const fallbackUnrealised = unrealisedPnl;
  const pnl =
    exitOptPrice != null && closedEntry > 0
      ? (exitOptPrice - closedEntry) * closedQty
      : fallbackUnrealised;

  await persistTrade(dateIst, "closed", reason, {
    status: "closed",
    leg: closedLeg,
    tradingsymbol: symbol,
    quantity: closedQty,
    entryPrice: closedEntry,
    entrySpot: closedIndexEntry,
    exitSpot: exitIndexPrice,
    exitPrice: exitOptPrice,
    pnl,
    exitReason: reason,
    closedAt: new Date().toISOString(),
    message: `${reason} · index ${idxPnl >= 0 ? "+" : ""}${idxPnl.toFixed(2)} pts`,
  });

  resetTrackedPosition();
  pushLog(`${reason} · ${symbol} — resuming flat`, "info");

  const weekday = formatWeekdayFromDateKey(dateIst);
  const closeMins = sessionCloseMinsForWeekday(weekday, MOMENTUM_SCALPER_LIVE_RULES);
  if (closedTradeWasLoss(pnl, closedEntry, closedQty, fallbackUnrealised)) {
    const pnlLabel = pnl != null ? ` (₹${pnl.toFixed(0)})` : "";
    stopTrapsAfterLoss(dateIst, pnlLabel);
    return;
  }

  if (istMinsFromDate(new Date()) >= closeMins) {
    finishDay(dateIst, "Trade closed on Zerodha — done for today");
    return;
  }

  resumeScanAfterMins = istMinsFromDate(new Date());
  phase = enabled ? "scanning" : "off";
  message = enabled ? "Flat — resuming scan" : DISABLED_MESSAGE;
  if (enabled) attachTicker(accessToken);
}

async function reconcileBrokerPositionInner(accessToken: string, dateIst: string) {
  if (squareOffInFlight) return;
  if (phase !== "in_position" && phase !== "exiting") return;
  if (!tradingsymbol || quantity <= 0) return;

  let closed = false;
  try {
    closed = await brokerShowsOwnLegClosed(accessToken);
  } catch {
    return;
  }
  if (!closed) {
    brokerClosedStreak = 0;
    return;
  }

  // Giving up a position is irreversible here — the bot stops managing it and starts scanning
  // again. One reading is not enough to act on, so require the broker to say it twice.
  brokerClosedStreak += 1;
  if (brokerClosedStreak < BROKER_CLOSED_CONFIRMATIONS) {
    pushLog(
      `Zerodha shows ${tradingsymbol} flat — confirming once more before releasing the position`,
      "warning",
    );
    return;
  }

  await closePositionAfterExternalExit(
    accessToken,
    dateIst,
    "Reconciled — position closed on Zerodha",
  );
}

async function reconcileBrokerPosition(accessToken: string, dateIst: string) {
  if (positionReconcileInFlight) return;
  if (Date.now() - lastPositionReconcileAt < POSITION_RECONCILE_MS) return;
  positionReconcileInFlight = true;
  lastPositionReconcileAt = Date.now();
  try {
    await reconcileBrokerPositionInner(accessToken, dateIst);
  } finally {
    positionReconcileInFlight = false;
  }
}

/** Force a broker position check — used by the API when the UI is stuck after a manual square-off. */
export async function reconcileMomentumScalperBrokerPosition(): Promise<MomentumScalperBotStatus> {
  const session = loadKiteSession();
  const ctx = getIndianMarketContext();
  if (!session?.accessToken) {
    throw new Error("Connect Kite in Settings");
  }
  lastPositionReconcileAt = 0;
  await reconcileBrokerPositionInner(session.accessToken, ctx.dateIST);
  return getMomentumScalperBotStatusLive();
}

/** Own-leg P&L as a percentage of the premium paid — drives the ladder. Null until priced. */
function currentPnlPct(): number | null {
  return momentumPnlPctOfEntryCost(unrealisedPnl, entryPrice, quantity);
}

/**
 * Single exit evaluation, run on every Nifty tick and on every option quote tick.
 * option tick (P&L moves the ladder). Both feeds matter, so neither can be skipped.
 */
function runExitCheck() {
  if (phase !== "in_position" || !exitState || lastSpot == null || !(lastSpot > 0)) return;

  const profile = activeExitProfile();
  const previousLocked = exitState.lockedPnlPct;
  const result = evaluateMomentumExit(exitState, {
    spot: lastSpot,
    pnlPct: currentPnlPct(),
    nowMs: Date.now(),
  });
  exitState = result.state;

  if (exitState.lockedPnlPct > previousLocked) {
    const locked = exitState.lockedPnlPct;
    pushLog(
      `+${locked}% reached — floor locked at +${locked}%, next target ` +
        `+${momentumPnlTargetPct(locked, profile)}%. Nothing sold yet: coming back down to ` +
        `+${locked}% is what triggers the exit, at ~+${momentumProfitExitPnlPct(locked)}%.`,
      "info",
    );
    saveState(getIndianMarketContext().dateIST);
  }

  if (result.exit) {
    void handleExitHit(
      result.exit.exitIndexPrice,
      result.exit.outcome,
      result.exit.lockedPnlPct,
      result.exit.hardStop === true,
    );
  }
}

async function handleExitHit(
  exitIndexPrice: number,
  outcome: string,
  lockedPnlPct = 0,
  hardStop = false,
) {
  const session = loadKiteSession();
  if (!session?.accessToken) return;
  const profile = activeExitProfile();
  const config = momentumExitProfileConfig(profile);
  const pnlPct = currentPnlPct();
  const pnlLabel = pnlPct != null ? ` · P&L ${pnlPct.toFixed(2)}%` : "";
  // The opening profile breaches strictly below its level; the standard one breaches at it.
  const breachWord = profile === "opening" ? "below" : "at or below";
  if (hardStop) {
    await squareOff(
      session.accessToken,
      `Exited — hard stop, option P&L broke −${config.hardStopLossPct}%${pnlLabel}. ` +
        `No ${config.initialStopHoldMs / 1000}s hold and no limit, straight to market.`,
      exitIndexPrice,
    );
    return;
  }

  // Profit exit: price came back to the locked floor. Sold with a limit set a tenth of a percent
  // under that floor, which is through the touch at the moment it goes out.
  if (outcome === "trail-stop" && lockedPnlPct > 0 && entryPrice > 0) {
    const limitPrice = momentumProfitExitLimitPrice(entryPrice, lockedPnlPct);
    const aimPct = momentumProfitExitPnlPct(lockedPnlPct);
    await squareOff(
      session.accessToken,
      `Exited — P&L came back to the locked +${lockedPnlPct}% floor${pnlLabel}. ` +
        `Marketable limit sell at ₹${limitPrice.toFixed(2)} (~+${aimPct}% on the ₹${entryPrice.toFixed(2)} entry). ` +
        `Nifty ${exitIndexPrice.toFixed(2)}.`,
      exitIndexPrice,
      limitPrice > 0 ? limitPrice : undefined,
    );
    return;
  }

  const label =
    outcome === "stop"
      ? config.initialStopHoldMs <= 0
        ? `Exited — initial stop hit (option P&L ${breachWord} −${config.initialStopLossPct}%)${pnlLabel}.`
        : `Exited — initial stop hit (option P&L stayed ${breachWord} −${config.initialStopLossPct}% for ${config.initialStopHoldMs / 1000}s without recovering)${pnlLabel}.`
      : `Exited — Nifty ${exitIndexPrice.toFixed(2)}${pnlLabel}.`;
  await squareOff(session.accessToken, label, exitIndexPrice);
}

function parseKiteMinuteRows(raw: unknown): DayScalperCandle[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: DayScalperCandle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close] = row;
    if (typeof time !== "string") continue;
    if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) continue;

    const parsed = new Date(time);
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinsFromDate(parsed);
    if (mins < RSI_PREFILL_SESSION_OPEN_MINS || mins > RSI_PREFILL_SESSION_CLOSE_MINS) continue;

    out.push({
      time,
      timeIst: formatIstMins(mins),
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

/** Live websocket bars override Zerodha history for the same minute. */
export function mergeNiftyMinuteBarsForRsi(
  prefill: DayScalperCandle[],
  live: DayScalperCandle[],
  current: DayScalperCandle | null,
): DayScalperCandle[] {
  const byMins = new Map<number, DayScalperCandle>();
  for (const bar of prefill) byMins.set(bar.mins, bar);
  for (const bar of live) byMins.set(bar.mins, bar);
  if (current && current.close > 0) byMins.set(current.mins, current);
  return [...byMins.values()].sort((a, b) => a.mins - b.mins);
}

async function warmRsiFromKiteHistory(accessToken: string, dateIst: string): Promise<void> {
  if (rsiPrefillDateIst === dateIst && rsiPrefillBars.length >= MOMENTUM_SCALPER_RSI_PERIOD + 1) {
    refreshLiveNiftyRsi();
    return;
  }
  if (rsiPrefillPromise) {
    await rsiPrefillPromise;
    refreshLiveNiftyRsi();
    return;
  }

  rsiPrefillPromise = (async () => {
    try {
      const ctx = getIndianMarketContext();
      const { candles } = await fetchHistoricalCandles(
        accessToken,
        NIFTY_SPOT_KEY,
        "minute",
        `${dateIst} 09:15:00`,
        `${dateIst} ${ctx.timeIST}`,
      );
      rsiPrefillBars = parseKiteMinuteRows(candles);
      rsiPrefillDateIst = dateIst;
      refreshLiveNiftyRsi();
      if (liveNiftyRsi != null) {
        pushLog(
          `RSI primed from Zerodha — ${rsiPrefillBars.length} session 1-min closes · RSI(14) ${liveNiftyRsi.toFixed(1)}`,
          "info",
        );
      }
    } catch (err) {
      pushLog(
        `RSI history fetch failed — ${err instanceof Error ? err.message : "falling back to websocket bars"}`,
        "warning",
      );
    } finally {
      rsiPrefillPromise = null;
    }
  })();

  await rsiPrefillPromise;
  refreshLiveNiftyRsi();
}

function niftyBarClosesForRsi(): number[] {
  return mergeNiftyMinuteBarsForRsi(rsiPrefillBars, completedBars, currentBar)
    .map((bar) => bar.close)
    .filter((close) => close > 0);
}

/** Recompute RSI from Zerodha history, completed websocket bars, and the forming minute. */
function refreshLiveNiftyRsi(): number | null {
  liveNiftyRsi = momentumLiveRsiFromBarCloses(niftyBarClosesForRsi(), MOMENTUM_SCALPER_RSI_PERIOD);
  return liveNiftyRsi;
}

function onNiftyTick(tick: NiftyTick) {
  if (!(tick.lastPrice > 0)) return;
  lastSpot = tick.lastPrice;
  const prevMins = currentBar?.mins ?? -1;
  updateCurrentBar(tick.lastPrice, new Date(tick.receivedAtMs));
  refreshLiveNiftyRsi();

  runExitCheck();

  if (currentBar && currentBar.mins !== prevMins && prevMins >= 0) {
    void onMinuteClosed();
  }

  evaluateTriggerOnTick(tick.receivedAtMs);
}

/**
 * Second minute: first tick vs signal last tick for the gate, then wait for a 2-pt pullback from start.
 */
function evaluateTriggerOnTick(_tickAtMs: number) {
  // Ticks keep flowing while a disabled bot sees an open position out — none may start a new one.
  if (!enabled) return;
  if (!pendingSignal || !currentBar) return;
  if (phase === "entering" || phase === "in_position" || phase === "exiting") return;
  if (entryClaim) return;
  if (lastSpot == null || lastSpot <= 0) return;

  if (currentBar.mins !== pendingSignal.signalMins + 1) {
    if (!atmArmInFlight && !marketEntryInFlight) expirePendingSignal(currentBar.mins);
    return;
  }

  if (!pendingSignal.gateChecked) {
    pendingSignal.gateChecked = true;
    const gateLevel = momentumGateLevel(pendingSignal.side, pendingSignal.signalLastTick);
    const pass = momentumGateFirstTickPasses(
      pendingSignal.side,
      lastSpot,
      pendingSignal.signalLastTick,
    );
    if (!pass) {
      pushLog(
        `No trade — ${pendingSignal.signalTimeIst} ${pendingSignal.side} setup cancelled. ` +
          `First tick ${lastSpot.toFixed(2)} did not reach ` +
          `${pendingSignal.side === "CE" ? "≥" : "≤"} ${gateLevel.toFixed(2)} ` +
          `(last tick ${pendingSignal.signalLastTick.toFixed(2)}).`,
        "warning",
      );
      clearPendingSignal();
      return;
    }

    pendingSignal.momentumGateSeen = true;
    pendingSignal.entryStartPrice = lastSpot;
    const session = loadKiteSession();
    if (session?.accessToken) warmEntryPath(session.accessToken);
    const pullbackLevel = trapsPullbackEntryLevel(pendingSignal.side, lastSpot);
    pushLog(
      `Gate passed — ${pendingSignal.side} ${pendingSignal.signalTimeIst} · start ${lastSpot.toFixed(2)} · ` +
        `waiting for ${pendingSignal.side === "CE" ? "drop" : "gain"} to ${pullbackLevel.toFixed(2)} ` +
        `(−/+${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS} pts).`,
      "info",
    );
    return;
  }

  if (!pendingSignal.momentumGateSeen || pendingSignal.entryAttempted) return;
  if (pendingSignal.entryStartPrice == null) return;
  if (!trapsPullbackEntryTriggered(pendingSignal.side, lastSpot, pendingSignal.entryStartPrice)) return;

  pendingSignal.entryAttempted = true;
  const session = loadKiteSession();
  if (!session?.accessToken) {
    pendingSignal.entryAttempted = false;
    return;
  }
  void armAtmContractForSignal(session.accessToken, pendingSignal.side, lastSpot);
}

async function onMinuteClosed() {
  // The ticker outlives a disable while a leg is being seen out, so this has to re-check rather
  // than assume it only runs for an armed bot — otherwise a disabled bot still arms signals.
  if (!enabled) return;
  const session = loadKiteSession();
  if (!session?.accessToken) return;
  const ctx = getIndianMarketContext();
  const weekday = formatWeekdayFromDateKey(ctx.dateIST);
  const closeMins = sessionCloseMinsForWeekday(weekday, MOMENTUM_SCALPER_LIVE_RULES);

  if (completedBars.length === 0) return;
  const bar = completedBars[completedBars.length - 1];
  if (bar.mins <= lastProcessedBarMins) return;
  lastProcessedBarMins = bar.mins;

  if (bar.mins >= closeMins) {
    // Entry cutoff only. A live trade keeps running on tick-driven exits; the day is finished
    // when that trade closes, not here.
    if (phase === "in_position" || phase === "exiting" || phase === "entering") return;
    if (phase !== "done") finishDay(ctx.dateIST, "Entry window closed — no new trades today");
    return;
  }

  if (phase === "in_position" || phase === "exiting" || phase === "entering") return;
  if (bar.mins < scanFloorMins()) return;
  if (!isPast916EntryWindow()) return;
  if (!momentumScanReady(bar.mins)) {
    if (pendingSignal) clearPendingSignal();
    return;
  }

  // Entries are decided tick-by-tick across the momentum candle that follows the signal.
  expirePendingSignal(bar.mins);

  const side = detectSignalSide(bar, MOMENTUM_SCALPER_LIVE_RULES);
  if (!side) return;
  if (bar.mins >= sessionCloseMinsForWeekday(weekday, MOMENTUM_SCALPER_LIVE_RULES)) return;

  const movePts = signedSignalMovePts(bar, MOMENTUM_SCALPER_LIVE_RULES);
  const bodyPts = Math.round((bar.close - bar.open) * 100) / 100;
  const signalLastTick =
    lastSpot != null && lastSpot > 0 ? lastSpot : bar.close > 0 ? bar.close : bar.open;
  const gateNeed = momentumGateLevel(side, signalLastTick).toFixed(2);
  pendingSignal = {
    side,
    signalTimeIst: bar.timeIst,
    movePts,
    signalMins: bar.mins,
    signalClose: bar.close,
    signalLastTick,
    entryStartPrice: null,
    gateChecked: false,
    momentumGateSeen: false,
    entryAttempted: false,
    optionMarkPrice: null,
    optionTradingsymbol: null,
    liveRsi: liveNiftyRsi,
  };
  warmEntryPath(session.accessToken);
  pushLog(
    `Setup — ${side === "CE" ? "Bullish" : "Bearish"} ${bar.timeIst} candle ` +
      `(${Math.abs(movePts)} pt range, ${bodyPts > 0 ? "+" : ""}${bodyPts} pt body) → ${side} idea. ` +
      `Next minute: first tick must reach ${side === "CE" ? "≥" : "≤"} ${gateNeed} ` +
      `(last tick ${signalLastTick.toFixed(2)}), then ${side === "CE" ? "drop" : "gain"} ` +
      `${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS} pts from start.`,
    "info",
  );
}

/** Tear down a pending setup and everything armed alongside it. */
function clearPendingSignal() {
  pendingSignal = null;
  preparedEntry = null;
}

/**
 * Drop a signal whose momentum candle passed without an entry going out.
 *
 * Expiring at `signalMins + 1` rather than after it matters. Both callers reach this only once the
 * momentum minute is genuinely over — the bar-close path runs after `currentBar` has rolled on,
 * and the tick path calls it only when the live bar is not the momentum minute. Waiting a further
 * minute let the next bar's signal overwrite this one silently, leaving its prepared plan behind.
 */
function expirePendingSignal(nowMins: number) {
  if (!pendingSignal) return;
  if (nowMins < pendingSignal.signalMins + 1) return;
  const contract = pendingSignal.optionTradingsymbol ?? `the ATM ${pendingSignal.side}`;
  pushLog(
    `No trade — the minute after the ${pendingSignal.signalTimeIst} ${pendingSignal.side} setup ` +
      `ended without a market buy going out on ${contract}.`,
    "warning",
  );
  clearPendingSignal();
}

const inr = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;

function logPlannedSize(plan: PreparedEntry) {
  pushLog(
    `Sized at the ₹${plan.optionLtp.toFixed(2)} premium — ${plan.lots} lot${plan.lots === 1 ? "" : "s"} × ` +
      `${plan.lotSize} = ${inr(plan.optionLtp * plan.lotSize * plan.lots)} ` +
      `(${inr(sizingPremium(plan.optionLtp) * plan.lotSize * plan.lots)} with ${entryPremiumSafetyPct()}% headroom) ` +
      `of ${inr(plan.availableBalance)} available.`,
    "info",
  );
}

function entryDecisionFromSignal(signal: PendingSignal, indexPrice: number): MomentumEntryDecision {
  return {
    side: signal.side,
    signalMovePts: signal.movePts,
    entryIndexPrice: indexPrice,
  };
}

async function adoptEntryFill(
  accessToken: string,
  dateIst: string,
  plan: PreparedEntry,
  decision: MomentumEntryDecision,
  fill: { average_price: number; filled_quantity: number },
) {
  const entryLeg: TradeLeg = decision.side === "CE" ? "CE_BUY" : "PE_BUY";
  const filledLots = Math.round(fill.filled_quantity / plan.lotSize);
  const sizeLabel = `${filledLots} lot${filledLots === 1 ? "" : "s"}`;

  if (!applyOwnEntryFills(plan.tradingsymbol, plan.lotSize, [fill])) {
    throw new Error("Entry order reported no filled quantity");
  }

  entryIndexPrice = decision.entryIndexPrice;
  entryTimeIst = istTimeLabel(new Date());
  positionOpenedAtMs = Date.now();
  brokerClosedStreak = 0;
  if (lastSpot == null || lastSpot <= 0) {
    lastSpot = decision.entryIndexPrice;
  }
  const entryProfile = exitProfileForEntry();
  exitState = createExitState(decision.side, entryIndexPrice, entryProfile);
  clearPendingSignal();
  tradesToday += 1;
  phase = "in_position";
  const profileConfig = momentumExitProfileConfig(entryProfile);
  message =
    entryProfile === "opening"
      ? `In ${decision.side} · opening ladder SL below −${profileConfig.initialStopLossPct}% (${profileConfig.initialStopHoldMs / 1000}s hold) · TP +${profileConfig.armPct}%`
      : `In ${decision.side} · SL ${MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT}% P&L (${profileConfig.initialStopHoldMs / 1000}s hold) · ` +
        `ladder from +${MOMENTUM_SCALPER_PNL_ARM_PCT}% P&L`;
  pushLog(
    `Entered ${legLabel(entryLeg)} ${plan.tradingsymbol} · ${sizeLabel} · MIS market @ ₹${entryPrice.toFixed(2)} · ` +
      `Nifty ${decision.entryIndexPrice.toFixed(2)} · ${exitProfileLabel(entryProfile)} exit rules`,
    "success",
  );

  optionInstrumentToken =
    plan.instrumentToken > 0
      ? plan.instrumentToken
      : ((await resolveInstrumentToken("NFO", plan.tradingsymbol, accessToken)) ?? 0);
  attachTicker(accessToken);
  saveState(dateIst);
  clearKiteRejectedIp();
}

/**
 * Buy the armed contract at market, right now.
 *
 * Everything the order needs was settled by {@link buildEntryPlan} a moment ago — the contract, a
 * live premium quote and a lot count sized against a freshly read balance — so this does no
 * further reading before sending. The one thing it will do is re-send smaller: Zerodha prices a
 * market buy off the ask plus charges while the plan is priced off the last trade, so a refusal
 * for funds is a sizing problem rather than a reason to abandon the setup. That retry only runs on
 * a refusal that filled nothing; a partial fill is inventory and is adopted as it stands.
 */
async function enterAtMarket(accessToken: string, spotAtGate: number) {
  if (marketEntryInFlight) return;
  const signal = pendingSignal;
  const plan = preparedEntry;
  if (!signal || !plan || !signal.momentumGateSeen) return;
  if (phase === "entering" || phase === "in_position" || phase === "exiting") return;
  if (entryClaim) return;
  if (plan.side !== signal.side || plan.signalMins !== signal.signalMins) return;

  if (plan.lots <= 0 || plan.quantity <= 0) {
    pushLog(
      `Entry blocked — balance will not cover 1 lot of ${plan.tradingsymbol} at ₹${plan.optionLtp.toFixed(2)}`,
      "warning",
    );
    clearPendingSignal();
    return;
  }

  const ctx = getIndianMarketContext();
  const weekday = formatWeekdayFromDateKey(ctx.dateIST);
  if (
    currentBar &&
    (currentBar.mins >= sessionCloseMinsForWeekday(weekday, MOMENTUM_SCALPER_LIVE_RULES) ||
      currentBar.mins < scanFloorMins() ||
      !momentumScanReady(currentBar.mins))
  ) {
    clearPendingSignal();
    return;
  }

  const spot = lastSpot != null && lastSpot > 0 ? lastSpot : spotAtGate > 0 ? spotAtGate : signal.signalClose;
  const decision = entryDecisionFromSignal(signal, spot);

  marketEntryInFlight = true;
  phase = "entering";
  logPlannedSize(plan);
  message = `Market buy ${plan.tradingsymbol} · ${plan.lots} lot${plan.lots === 1 ? "" : "s"}`;

  let lots = plan.lots;
  let filled: { average_price: number; filled_quantity: number } | null = null;
  try {
    while (lots > 0 && filled == null) {
      const quantity = lots * plan.lotSize;
      writeEntryClaim({
        dateIST: ctx.dateIST,
        tradingsymbol: plan.tradingsymbol,
        side: decision.side,
        entryIndexPrice: decision.entryIndexPrice,
        lotSize: plan.lotSize,
        quantity,
        at: new Date().toISOString(),
      });

      try {
        const orderId = await placeRegularMarketOrder(accessToken, {
          tradingsymbol: plan.tradingsymbol,
          exchange: "NFO",
          transaction_type: "BUY",
          product: "MIS",
          quantity,
        });
        filled = await waitForOrderComplete(accessToken, orderId);
      } catch (err) {
        // Lots that traded before the refusal are inventory, whatever the order status says. They
        // are taken as the position rather than re-sent — sending again would double the leg.
        if (err instanceof KiteOrderRejectedError && err.filledQuantity > 0) {
          pushLog(
            `Partly filled — ${err.filledQuantity} of ${quantity} ${plan.tradingsymbol} traded before the order ${err.status.toLowerCase()}. Holding what filled.`,
            "warning",
          );
          filled = {
            average_price: err.averagePrice || plan.optionLtp,
            filled_quantity: err.filledQuantity,
          };
          break;
        }
        if (!isInsufficientFundsError(err)) throw err;

        const next = nextEntryLotsAfterMarginReject(lots, parseMarginShortfall(err));
        if (next <= 0) throw err;
        pushLog(
          `Margin short at ${lots} lot${lots === 1 ? "" : "s"} — retrying ${plan.tradingsymbol} at ${next}.`,
          "warning",
        );
        lots = next;
      }
    }
    if (!filled) throw new Error(`Balance will not cover any size of ${plan.tradingsymbol}`);
  } catch (err) {
    // Nothing traded, so the claim is a false breadcrumb — drop it and go back to scanning.
    clearEntryClaim();
    const note = err instanceof Error ? err.message : "Market entry failed";
    pushLog(note, "error");
    clearPendingSignal();
    phase = "scanning";
    message = note;
    marketEntryInFlight = false;
    return;
  }

  try {
    const quantity = filled.filled_quantity;
    await adoptEntryFill(
      accessToken,
      ctx.dateIST,
      { ...plan, lots: Math.round(quantity / plan.lotSize), quantity },
      decision,
      filled,
    );
  } catch (err) {
    // The lots are real even though the bot could not finish recording them. The claim is left
    // standing on purpose: it is what the reconciler reads to adopt the leg instead of stranding it.
    const note = err instanceof Error ? err.message : "Entry fill could not be adopted";
    pushLog(`${note} — the claim is left standing so the leg is reconciled, not abandoned.`, "error");
    phase = "error";
    message = note;
  } finally {
    marketEntryInFlight = false;
  }
}

function tickerTokens(): number[] {
  const tokens = [niftyInstrumentToken, optionInstrumentToken];
  return [...new Set(tokens.filter((token) => token > 0))];
}

/**
 * The scalper subscribes to Nifty while scanning and adds the option leg on entry, so this has to
 * resubscribe an existing connection rather than bail out — otherwise no option ticks ever
 * arrive, `unrealisedPnl` never moves, and the P&L ladder can never lock rungs.
 */
function attachTicker(accessToken: string) {
  if (tickerStop) {
    tickerConn?.setInstruments(tickerTokens());
    return;
  }
  if (tickerAttaching) return;
  tickerAttaching = true;
  void (async () => {
    try {
      if (niftyInstrumentToken <= 0) {
        niftyInstrumentToken = await resolveNifty50InstrumentToken(accessToken);
      }
      void warmRsiFromKiteHistory(accessToken, getIndianMarketContext().dateIST);
    } catch {
      tickerAttaching = false;
      return;
    }
    const conn = createNiftyTickerConnection({
      accessToken,
      instrumentTokens: tickerTokens(),
      onConnect: () => {
        wsConnected = true;
      },
      onDisconnect: () => {
        wsConnected = false;
      },
      onTick: (tick) => {
        if (tick.instrumentToken === niftyInstrumentToken) onNiftyTick(tick);
        else if (tick.instrumentToken === optionInstrumentToken) {
          lastOptionPrice = tick.lastPrice;
          if (entryPrice > 0 && quantity > 0) {
            unrealisedPnl = (tick.lastPrice - entryPrice) * quantity;
            // The ladder is driven by P&L, which only moves on option ticks.
            runExitCheck();
          }
        }
      },
    });
    tickerConn = conn;
    tickerStop = () => {
      wsConnected = false;
      tickerConn = null;
      conn.stop();
    };
    tickerAttaching = false;
    // The option leg can be booked while the connection is still opening.
    conn.setInstruments(tickerTokens());
  })();
}

async function refreshQuotes(accessToken: string) {
  if (!tradingsymbol) return;
  try {
    const { niftySpot, optionLtp } = await fetchNiftyAndOptionQuotes(accessToken, tradingsymbol);
    if (niftySpot > 0) lastSpot = niftySpot;
    if (optionLtp > 0) lastOptionPrice = optionLtp;
    if (entryPrice > 0 && lastOptionPrice != null) {
      unrealisedPnl = (lastOptionPrice - entryPrice) * quantity;
    }
  } catch {
    /* ignore */
  }
}

async function mainLoop() {
  const session = loadKiteSession();
  const ctx = getIndianMarketContext();
  const weekday = formatWeekdayFromDateKey(ctx.dateIST);
  applyDailySchedule(ctx.dateIST, weekday);

  // Disabled means no new trades, but a leg that is already open still has to be managed to its
  // exit — dropping out here would leave it to the broker's auto square-off.
  if (!enabled && !isHoldingPosition()) {
    // A position seen out under a disabled bot leaves the ticker attached, and it would otherwise
    // stay subscribed until the process restarts, still building bars for a bot that is off.
    if (tickerStop) {
      tickerStop();
      tickerStop = null;
    }
    clearPendingSignal();
    phase = "off";
    scheduleNext(5000);
    return;
  }

  if (!session?.accessToken) {
    phase = "waiting";
    message = "Connect Kite in Settings";
    scheduleNext(5000);
    return;
  }

  if (weekday === "Saturday" || weekday === "Sunday") {
    phase = "waiting";
    message = "Weekend — bot idle";
    scheduleNext(30_000);
    return;
  }

  loadStateOnce(ctx.dateIST);
  ensureSessionDate(ctx.dateIST);

  if (sessionAlreadyDone(ctx.dateIST) && !entryClaim && phase !== "in_position" && phase !== "exiting") {
    phase = "done";
    message = `Today's scan finished — idle until tomorrow ${formatIstMins(MOMENTUM_SCALPER_SCAN_START_MINS)}`;
    scheduleNext(30_000);
    return;
  }

  if (kiteSessionAgeHours(session) > 23) {
    phase = "waiting";
    message = "Kite session stale — reconnect in Settings";
    scheduleNext(10_000);
    return;
  }

  const nowMins = istMinsFromDate(new Date());
  const pastScanWindow =
    momentumLiveDayEntryCutoffReached(nowMins) || ctx.sessionStatus === "post_market";

  if (isInBotWsHours()) {
    attachTicker(session.accessToken);
  }

  // An open trade is never cut at the entry cutoff — it runs its own target/stop. Only the
  // 15:25 MIS safety exit can close it early, so the broker never squares it off behind us.
  if (phase === "in_position" || phase === "exiting") {
    await reconcileBrokerPosition(session.accessToken, ctx.dateIST);
    if (phase !== "in_position" && phase !== "exiting") {
      scheduleNext(POLL_MS);
      return;
    }
    if (!wsConnected) await refreshQuotes(session.accessToken);
    // Exits are normally tick-driven; re-check here so a websocket drop cannot leave the ladder
    // unevaluated.
    runExitCheck();
    if (isPastMomentumForceExit() && phase === "in_position" && lastSpot != null) {
      // Beating Zerodha's own square-off is the entire point; there is no time to work a limit.
      await squareOff(
        session.accessToken,
        `Force exit ${MOMENTUM_SCALPER_FORCE_EXIT_IST} (MIS auto square-off guard)`,
        lastSpot,
      );
    }
    scheduleNext(POLL_MS);
    return;
  }

  // A claim standing outside a tracked position means a crash landed in the gap between the
  // order and the state write. Settle it against the broker — before the entry cutoff check, so
  // an orphaned leg still gets adopted and managed rather than left running unattended.
  if (entryClaim && phase !== "entering") {
    phase = "waiting";
    message = `Checking Zerodha for a claimed ${entryClaim.tradingsymbol} leg before scanning`;
    await resolveEntryClaim(session.accessToken, ctx.dateIST);
    // Slower than the normal poll: this hits /portfolio/positions, and it only retries when the
    // broker could not be reached at all.
    scheduleNext(3000);
    return;
  }

  // Flat and disabled: the loop was only alive to see a position out. Stand down.
  if (!enabled) {
    phase = "off";
    message = DISABLED_MESSAGE;
    scheduleNext(5000);
    return;
  }

  if (pastScanWindow) {
    phase = sessionAlreadyDone(ctx.dateIST) ? "done" : "waiting";
    message = sessionAlreadyDone(ctx.dateIST)
      ? `Today's scan finished — idle until tomorrow ${formatIstMins(MOMENTUM_SCALPER_SCAN_START_MINS)}`
      : `Past today's entry cutoff (${SCHEDULE_LABEL}) — no new entries until tomorrow`;
    scheduleNext(30_000);
    return;
  }

  if (!wsConnected) {
    phase = "waiting";
    message = "Waiting for Kite websocket — signals use live ticks only (no historical candle API)";
    scheduleNext(2000);
    return;
  }

  if (!momentumScanReady(istMinsFromDate(new Date()))) {
    if (pendingSignal) clearPendingSignal();
    phase = "waiting";
    const nextOpen = momentumNextLiveEntryOpenMins(nowMins);
    message =
      !isPast916EntryWindow()
        ? "On hold — waiting for the 9:16 trade to finish (after 9:16:30 IST)"
        : nextOpen != null
          ? `On hold — scanning opens ${formatIstMins(nextOpen)} IST`
          : DISABLED_MESSAGE;
    scheduleNext(POLL_MS);
    return;
  }

  phase = "scanning";
  message = pendingSignal
    ? `${pendingSignal.side} signal ${pendingSignal.signalTimeIst} · ` +
      (pendingSignal.entryAttempted
        ? pendingSignal.momentumGateSeen
          ? pendingSignal.optionMarkPrice != null
            ? `buying at market (₹${pendingSignal.optionMarkPrice.toFixed(2)} premium)`
            : "pullback hit — resolving the ATM leg"
          : "gate failed — no trade"
        : pendingSignal.momentumGateSeen
          ? pendingSignal.entryStartPrice != null
            ? `gate passed from ${pendingSignal.entryStartPrice.toFixed(2)} · waiting for ${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS} pt pullback`
            : "gate passed — waiting for pullback"
          : `waiting for first tick ${pendingSignal.side === "CE" ? "≥" : "≤"} ${momentumGateLevel(pendingSignal.side, pendingSignal.signalLastTick).toFixed(2)} vs last ${pendingSignal.signalLastTick.toFixed(2)}`)
    : `Scanning live bars · range ≥ ${MOMENTUM_SCALPER_LIVE_RULES.minMovePts} pts · first-tick gate ±0.2 · ${MOMENTUM_SCALPER_ENTRY_PULLBACK_PTS} pt pullback entry · SL ${MOMENTUM_SCALPER_INITIAL_STOP_PNL_PCT}% P&L`;

  scheduleNext(POLL_MS);
}

function scheduleNext(delayMs: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void mainLoop().catch((err) => {
      phase = "error";
      message = err instanceof Error ? err.message : "Loop error";
      pushLog(message, "error");
      scheduleNext(10_000);
    });
  }, delayMs);
}

function buildStatus(): MomentumScalperBotStatus {
  const ctx = getIndianMarketContext();
  const weekday = formatWeekdayFromDateKey(ctx.dateIST);
  const profile = activeExitProfile();
  const profileConfig = momentumExitProfileConfig(profile);
  const locked = exitState?.lockedPnlPct ?? 0;
  const idxPnl =
    phase === "in_position" && exitState && lastSpot != null
      ? indexPnlPts(exitState.side, entryIndexPrice, lastSpot)
      : null;
  return {
    enabled,
    phase,
    dateIST: ctx.dateIST,
    weekday,
    message,
    rules: MOMENTUM_SCALPER_LIVE_RULES,
    wsConnected,
    tradesToday,
    stoppedForLossToday: sessionStoppedForLoss(ctx.dateIST),
    maxLots: maxLotsPerTrade(),
    plannedLots: pendingSignal && preparedEntry?.side === pendingSignal.side ? preparedEntry.lots : null,
    premiumSafetyPct: entryPremiumSafetyPct(),
    pendingSignal,
    leg,
    tradingsymbol,
    quantity: quantity > 0 ? quantity : null,
    entryPrice: entryPrice > 0 ? entryPrice : null,
    lastOptionPrice,
    entryIndexPrice: entryIndexPrice > 0 ? entryIndexPrice : null,
    initialStopPnlPct: -profileConfig.initialStopLossPct,
    initialStopHoldSec: profileConfig.initialStopHoldMs / 1000,
    hardStopPnlPct: -profileConfig.hardStopLossPct,
    trailing: (exitState?.lockedPnlPct ?? 0) >= profileConfig.armPct,
    pnlPct: phase === "in_position" ? currentPnlPct() : null,
    pnlLockedPct: exitState?.lockedPnlPct ?? 0,
    pnlTargetPct: exitState ? momentumPnlTargetPct(exitState.lockedPnlPct, profile) : null,
    pnlStopPct: exitState ? momentumPnlStopPct(exitState.lockedPnlPct, profile) : null,
    pnlArmPct: profileConfig.armPct,
    pnlStepPct: profileConfig.stepPct,
    exitProfile: exitState?.exitProfile ?? null,
    exitRules: {
      standard: exitRuleSummary("standard"),
      opening: exitRuleSummary("opening"),
    },
    profitExitPnlPct: locked > 0 ? momentumProfitExitPnlPct(locked) : null,
    profitExitPrice: locked > 0 && entryPrice > 0 ? momentumProfitExitLimitPrice(entryPrice, locked) : null,
    profitExitGivebackPct: MOMENTUM_PROFIT_EXIT_GIVEBACK_PCT,
    lastSpot,
    unrealisedPnl,
    indexPnlPts: idxPnl,
    lastBarTimeIst: currentBar?.timeIst ?? completedBars.at(-1)?.timeIst ?? null,
    completedBars: completedBars.length,
    nineSixteenSettled: momentumScanReady(istMinsFromDate(new Date())),
    scanStartIst: SCHEDULE_LABEL,
    forceExitIst: MOMENTUM_SCALPER_FORCE_EXIT_IST,
    liveNiftyRsi,
    liveRsiBucketsIst: formatMomentumLiveRsiBucketsLabel(),
    sessionConnected: Boolean(loadKiteSession()?.accessToken),
    updatedAt: new Date().toISOString(),
    logs: [...logs],
  };
}

export function getMomentumScalperBotStatus(): MomentumScalperBotStatus {
  return buildStatus();
}

export async function getMomentumScalperBotStatusLive(): Promise<MomentumScalperBotStatus> {
  const session = loadKiteSession();
  if (session?.accessToken && (phase === "in_position" || phase === "exiting")) {
    await refreshQuotes(session.accessToken);
  }
  return buildStatus();
}

export function setMomentumScalperBotEnabled(next: boolean) {
  const ctx = getIndianMarketContext();
  if (next && sessionAlreadyDone(ctx.dateIST)) {
    const detail = sessionStoppedForLoss(ctx.dateIST)
      ? "today's session ended after a loss"
      : "today's session is finished";
    pushLog(`Cannot enable — ${detail}`, "warning");
    return;
  }
  enabled = next;
  if (!enabled) {
    // Keep the loop and the ticker alive if a leg is open: the P&L ladder needs option ticks, and
    // tearing them down here would strand the position until the broker squares it off.
    if (isHoldingPosition()) {
      message = "Disabled — seeing the open position out, no new entries";
      pushLog(message, "warning");
      scheduleNext(0);
      return;
    }
    if (timer) clearTimeout(timer);
    timer = null;
    if (tickerStop) {
      tickerStop();
      tickerStop = null;
    }
    phase = "off";
    message = DISABLED_MESSAGE;
    pushLog("Traps disabled", "info");
    return;
  }
  phase = "waiting";
  message = "Traps enabled — scanning after 9:16:30 through entry cutoff";
  pushLog("Traps enabled", "info");
  const session = loadKiteSession();
  if (session?.accessToken) void warmRsiFromKiteHistory(session.accessToken, ctx.dateIST);
  scheduleNext(0);
}

export function startMomentumScalperBot() {
  const ctx = getIndianMarketContext();
  loadStateOnce(ctx.dateIST);
  loadEntryClaim(ctx.dateIST);
  if (isHoldingPosition()) {
    pushLog("Recovered an open position on startup — managing it out", "warning");
  } else {
    enabled = false;
    phase = "off";
    message = DISABLED_MESSAGE;
  }
  scheduleNext(0);
}

export function startMomentumScalperLiveMonitor() {
  const ctx = getIndianMarketContext();
  loadStateOnce(ctx.dateIST);
}
