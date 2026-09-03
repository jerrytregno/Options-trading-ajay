import fs from "fs";
import path from "path";
import { getIndianMarketContext } from "../src/lib/market-time.js";
import {
  isPast916EntryWindow,
  isPastNineSixteenForceExit,
  isReadyFor916Entry,
  isReadyForEntryPrewarm,
  isReadyForAtmPreResolve,
  isInNineSixteenBurst,
  msUntilEntryInstant,
  isInBotWsHours,
  isPastBotWsHours,
  msUntilWsDisconnect,
  isReadyToSeal915Close,
  isIn915OpenTickWindow,
  isIn915CloseTickWindow,
  decide915Entry,
  exitModeFrom915Change,
  msUntilNextEntryPhase,
  build915BarFromCaptured,
  computePnlTargetAmount,
  getPnlExitStartLabel,
  getPnlTrailScheduleLabel,
  getNineSixteenPnlTrailArmPct,
  pnlPctOfEntryCost,
  nextLockedPnlPct,
  trailingPnlTargetPct,
  trailingPnlStopPct,
  shouldExitOnTrailingPnl,
  shouldInstantExitTrailingPnl,
  NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT,
  NINE_SIXTEEN_PNL_TRAIL_FIRST_LOCK_PCT,
  ownLegUnrealisedPnl,
  ownPositionSync,
  isPlausiblePnlPct,
  NINE_SIXTEEN_PNL_TRAIL_STEP_PCT,
  getNineSixteenSpotPollMs,
  decideNineFifteenEntry,
  getNineFifteenLadderLabel,
  getHardStopScheduleLabel,
  computeHardStopSpot,
  shouldHardStopNineSixteen,
  isHardStopWindowActive,
  getHardStopStartLabel,
  NINE_SIXTEEN_HARD_STOP_INDEX_POINTS,
  isReadyForNineFifteenPreResolve,
  isReadyForNineFifteenEntry,
  isPastNineFifteenEntryWindow,
  isPastNineFifteenSignalRead,
  isPastNineFifteenMinute,
  msUntilNineFifteenEntry,
  NINE_FIFTEEN_TAKE_PROFIT_PCT,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  nineFifteenDeployedCapital,
  shouldExitNineFifteenTakeProfit,
  nineFifteenPnlRemainingToTarget,
  formatNineFifteenExitSummary,
  type NineSixteenExitMode,
} from "./nine-sixteen-logic.js";
import { legLabel, type TradeLeg } from "../src/lib/trade-calculations.js";
import {
  prewarmNiftyOptionChain,
  resolveAtmNiftyOption,
  type ResolvedAtmOption,
} from "./atm-option.js";
import {
  formatLotSplitLabel,
  getMaxLotsPerOrder,
  resolveEntryQuantity,
  splitLotsIntoOrderChunks,
  splitQuantityIntoOrderChunks,
} from "./nine-sixteen-sizing.js";
import {
  assertKiteEgressReady,
  clearKiteRejectedIp,
} from "./trading-ip.js";
import {
  fetchEquityAvailableBalance,
  fetchMisPosition,
  fetchNetQty,
  fetchNiftyAndOptionQuotes,
  fetchNiftySpot,
  fetchOptionLtp,
  findOpenNiftyMisOption,
  fetchOrdersByIds,
  kiteGet,
  cancelRegularOrder,
  placeRegularLimitOrder,
  placeRegularMarketOrder,
  waitForOrderComplete,
} from "./kite-client.js";
import {
  hasNiftyTickerInstance,
  isKiteTickerConnected,
  resolveInstrumentToken,
  resolveNifty50InstrumentToken,
  setBotTickerInstruments,
  startNiftyTicker,
  stopNiftyTicker,
  type NiftyTick,
} from "./kite-ticker.js";
import { kiteSessionAgeHours, loadKiteSession } from "./kite-session-store.js";
import { appendBotTradeLog, loadBotTradeLogs, makeBotTradeLogId, makeClosedBotTradeLogId, makeSessionOutcomeLogId } from "./bot-trade-log.js";
import type { BotTradeLogStatus } from "../src/types/trade-log.js";

export interface LiveSpotSample {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  /** Last spot of the second (close). */
  niftySpot: number | null;
  /** First / highest / lowest spot seen inside this one-second bucket. */
  openSpot: number | null;
  highSpot: number | null;
  lowSpot: number | null;
  /** highSpot − lowSpot, i.e. how far price travelled inside the second. */
  rangePts: number | null;
  ticksInSecond: number;
  lastTickAtIST: string | null;
  stale: boolean;
}

/** One websocket tick exactly as received — the finest granularity Kite provides. */
export interface RawTickRow {
  seq: number;
  dateIST: string;
  /** HH:MM:SS.mmm when our server parsed the packet. */
  timeIST: string;
  epochMs: number;
  /** Exchange-stamped time (quote mode); null when the exchange does not stamp it. */
  exchangeTimeIST: string | null;
  kind: "nifty" | "option";
  instrumentToken: number;
  price: number;
  /** Move versus the previous tick of the same instrument. */
  changePts: number | null;
}

/** The day runs up to two trades: the 9:15:06 leg, then the 9:16:00 one. */
export type NineSixteenTradeSlot = "nine-fifteen" | "nine-sixteen";

export type NineFifteenTpOrderStatus =
  | "none"
  | "pending"
  | "partial"
  | "complete"
  | "cancelled"
  | "failed";

export type NineSixteenBotPhase =
  | "off"
  | "waiting"
  | "entering"
  | "in_position"
  | "exiting"
  | "done"
  | "error";

export interface NineSixteenBotStatus {
  enabled: boolean;
  phase: NineSixteenBotPhase;
  dateIST: string;
  message: string;
  /** First WS tick in 9:15:00–9:15:15 (direction filter only — not the ±25 exit anchor). */
  open915: number | null;
  /** Last WS tick before 9:16:00, logged as 9:15:59 close. */
  close915: number | null;
  wsConnected: boolean;
  /** Nifty 50 spot at option fill (~9:16:00); index exit target is ± from this spot. */
  entrySpot: number | null;
  /** main = |Δ|≥15 (only band entered live). near_miss kept for legacy state / exit ladder. */
  exitMode: NineSixteenExitMode | null;
  /** Human-readable index exit schedule for this trade. */
  indexExitSchedule: string | null;
  /** Nifty level that triggers the adverse hard stop. */
  hardStopSpot: number | null;
  /** True once the clock is past the hard-stop start time and it is scanning. */
  hardStopActive: boolean;
  hardStopPoints: number;
  /** IST time the hard stop starts scanning, e.g. "09:55". */
  hardStopStartLabel: string;
  leg: TradeLeg | null;
  tradingsymbol: string | null;
  targetSpot: number | null;
  lastSpot: number | null;
  entryPrice: number | null;
  lastOptionPrice: number | null;
  quantity: number | null;
  unrealisedPnl: number | null;
  /** Nifty index points still needed to hit exit target (0 = target touched). */
  niftyPointsToTarget: number | null;
  /** Unrealised P&L needed to reach the next trailing take-profit rung. */
  pnlTargetAmount: number | null;
  pnlTargetPct: number;
  pnlExitActive: boolean;
  pnlExitStartLabel: string;
  pnlExitSchedule?: string;
  /** Live P&L as a % of the premium paid at entry. */
  pnlPct: number | null;
  /** Highest locked stop floor on the 9:16 trailing ladder (0 until +8% prints). */
  pnlLockedPct: number;
  /** Trailing stop rung — null until the ladder arms. */
  pnlStopPct: number | null;
  /** Unrealised P&L level that trips the trailing stop. */
  pnlStopAmount: number | null;
  /** True once profit has touched +5% and the trailing stop is live. */
  pnlTrailArmed: boolean;
  pnlTrailArmPct: number;
  pnlTrailStepPct: number;
  /** The 9:15 leg — armed, read and settled independently of the 9:16 one. */
  nineFifteenEnabled: boolean;
  /** Which of the day's two trades is open, or which one is next. */
  tradeSlot: NineSixteenTradeSlot;
  /** Last Nifty print before 9:15:05 — the read that decides red or green. */
  nineFifteenMarkPrice: number | null;
  nineFifteenMarkAt: string | null;
  /** Mark minus the 9:15 open. Negative is red, which is the only side that trades. */
  nineFifteenMarkChange: number | null;
  /** True once the 9:15 attempt is over for the day, however it ended. */
  nineFifteenSettled: boolean;
  nineFifteenNote: string | null;
  /** True when a 9:15 leg outlived its minute, which cancels the 9:16 trade for the day. */
  nineFifteenBlocked916: boolean;
  nineFifteenLadder: string;
  nineFifteenTakeProfitPct: number;
  /** Resting +5% limit sell price, when armed. */
  nineFifteenTpLimitPrice?: number | null;
  /** Capital deployed at entry (entry × qty). */
  nineFifteenDeployedCapital?: number | null;
  /** +5% profit aim in rupees. */
  nineFifteenTpProfitAim?: number | null;
  /** Rupees still needed to reach the profit aim (0 at/above target). */
  nineFifteenPnlRemaining?: number | null;
  nineFifteenTpOrderStatus?: NineFifteenTpOrderStatus;
  nineFifteenTpOrderIds?: string[];
  nineFifteenTpFilledQty?: number;
  nineFifteenTpPendingQty?: number;
  nineFifteenTpPlacedAt?: string | null;
  nineFifteenTpLastSyncedAt?: string | null;
  /** @deprecated Use nineFifteenTakeProfitPct — kept for older panels. */
  nineFifteenTrailArmPct?: number;
  /** @deprecated Trailing ladder removed for 9:15. */
  nineFifteenTrailStepPct?: number;
  sessionConnected: boolean;
  sessionAgeHours: number | null;
  updatedAt: string;
  /** Nifty ±25 / P&L exit check interval while in trade (ms). */
  spotPollMs: number;
  logs: { time: string; message: string; type: "info" | "success" | "warning" | "error" }[];
  /** Per-second Nifty spot samples while websocket is live (newest first). */
  liveSpotSamples?: LiveSpotSample[];
  liveSpotSampleCount?: number;
  /** Individual websocket ticks (newest first) — full day is on disk under data/ticks. */
  rawTicks?: RawTickRow[];
  rawTickCount?: number;
  rawTickFile?: string | null;
}

const STATE_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(STATE_DIR, "nine-sixteen-state.json");
const CAPTURE_FILE = path.join(STATE_DIR, "nine-sixteen-capture.json");
const RAN_FILE = (dateIst: string) => path.join(STATE_DIR, `nine-sixteen-ran-${dateIst}.json`);
const TICK_DIR = path.join(STATE_DIR, "ticks");
const TICK_FILE = (dateIst: string) => path.join(TICK_DIR, `ws-ticks-${dateIst}.jsonl`);

interface PersistedBotState {
  dateIST: string;
  phase: NineSixteenBotPhase;
  open915: number;
  entrySpot?: number;
  exitMode?: NineSixteenExitMode;
  leg: TradeLeg;
  tradingsymbol: string;
  quantity: number;
  entryPrice: number;
  /** Lot size of the open leg — split exits need it after a restart. */
  lotSize?: number;
  /** Highest trailing P&L rung locked before the restart. */
  lockedPnlPct?: number;
  /** Contract this bot bought today, so a restart does not adopt another bot's leg. */
  ownedSymbol?: string;
  /** Which of the day's two trades this leg is, so the right exit rules resume. */
  tradeSlot?: NineSixteenTradeSlot;
  /** True once the 9:15 attempt is over, so a restart does not re-fire it. */
  nineFifteenSettled?: boolean;
  /** Resting +5% take-profit limit sell orders for the 9:15 leg. */
  nineFifteenTpOrderIds?: string[];
  nineFifteenTpLimitPrice?: number;
  nineFifteenTpOrderStatus?: NineFifteenTpOrderStatus;
  nineFifteenTpFilledQty?: number;
  nineFifteenTpPendingQty?: number;
  nineFifteenTpPlacedAt?: string;
}

interface PersistedCaptureState {
  dateIST: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
}

/** 9:16 entries are armed on startup; disable in the UI if you only want the websocket monitor. */
let enabled = true;
/**
 * The 9:15 leg is armed on startup alongside 9:16. Each can be turned off independently in the UI.
 */
let nineFifteenEnabled = true;
/** Which of the day's two trades the open position belongs to. */
let tradeSlot: NineSixteenTradeSlot = "nine-sixteen";
/** Sealed from the last tick strictly before 9:15:05 — the read that decides red or green. */
let nineFifteenMarkPrice: number | null = null;
let nineFifteenMarkAtLabel: string | null = null;
/** Set once the 9:15 attempt is over — traded, skipped or failed — so it runs at most once a day. */
let nineFifteenSettled = false;
/** Short description of how the 9:15 attempt went, for the panel. */
let nineFifteenNote: string | null = null;
/** True once a 9:15 leg has been held past 9:16:00 — the 9:16 trade stands down for the day. */
let nineFifteenOverranMinute = false;
let nineFifteenBurstInFlight = false;
let nineFifteenTimer: ReturnType<typeof setTimeout> | null = null;
let nineFifteenTimerDate: string | null = null;
/** Resting +5% take-profit limit sell for the 9:15 leg. */
let nineFifteenTpOrderIds: string[] = [];
let nineFifteenTpLimitPrice = 0;
let nineFifteenTpOrderStatus: NineFifteenTpOrderStatus = "none";
let nineFifteenTpFilledQty = 0;
let nineFifteenTpPendingQty = 0;
let nineFifteenTpPlacedAt: string | null = null;
let nineFifteenTpLastSyncedAt: string | null = null;
let nineFifteenTpLastLogKey = "";
let nineFifteenDate: string | null = null;
let monitorLoopStarted = false;
let phase: NineSixteenBotPhase = "waiting";
let message =
  enabled || nineFifteenEnabled
    ? "Server bot waiting for Kite websocket 9:15 ticks"
    : "9:16 trading disabled — websocket monitor active";
let open915 = 0;
let entrySpot = 0;
let exitMode: NineSixteenExitMode = "main";
let leg: TradeLeg | null = null;
let tradingsymbol: string | null = null;
/**
 * Contract this bot actually placed BUY orders in today. Momentum scalper trades the same ATM
 * strikes, so this — not "an open MIS leg exists" — is the only proof a position is ours.
 */
let ownedSymbol: string | null = null;
let quantity = 0;
let entryPrice = 0;
/** Lot size of the open Nifty MIS leg (for split exit sizing). */
let positionLotSize = 0;
let lastSpot: number | null = null;
let lastOptionPrice: number | null = null;
let unrealisedPnl: number | null = null;
/** Highest +5% P&L rung locked by the trailing ladder (0 = not armed yet). */
let lockedPnlPct = 0;
let capturedOpen915: number | null = null;
let capturedClose915: number | null = null;
let capturedHigh915: number | null = null;
let capturedLow915: number | null = null;
let lastTickBeforeClose: number | null = null;
let tickHigh915: number | null = null;
let tickLow915: number | null = null;
let tickCount915 = 0;
let openTickAtLabel: string | null = null;
let closeTickAtLabel: string | null = null;
let tickerStartInFlight = false;
let niftyInstrumentToken = 0;
let optionInstrumentToken = 0;
let squareOffInFlight = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastQuoteRefreshAt = 0;
let lastPositionSyncAt = 0;
let quoteRefreshInFlight = false;
let loopBusy = false;
const logs: NineSixteenBotStatus["logs"] = [];

/** Once-a-day cache warm (9:00) so the 9:16:00 order path makes no cold calls. */
let prewarmDoneDate: string | null = null;
let prewarmInFlight = false;
let lastPrewarmAttemptAt = 0;
const PREWARM_RETRY_MS = 60_000;

/** ATM PE resolved at 9:15:04, so the 9:15:06 order makes no REST call of its own. */
let nineFifteenPreResolvedPe: ResolvedAtmOption | null = null;
let nineFifteenPreResolvedDate: string | null = null;
let nineFifteenPreResolveInFlight = false;

/** ATM CE/PE resolved at 9:15:58 from the live websocket spot (zero REST at 9:16:00). */
let preResolvedDate: string | null = null;
let preResolvedCe: ResolvedAtmOption | null = null;
let preResolvedPe: ResolvedAtmOption | null = null;
let preResolveInFlight = false;
let lastPreResolveAttemptAt = 0;
const PRE_RESOLVE_RETRY_MS = 1_000;

/** Dedicated 9:16:00.000 trigger — the poll loop alone can be up to 250ms late. */
let entryTimer: ReturnType<typeof setTimeout> | null = null;
let entryTimerDate: string | null = null;
let entryBurstInFlight = false;

/** Keep ~2h of per-second Nifty samples in memory; UI gets the newest slice. */
const LIVE_SPOT_MAX_SAMPLES = 7_200;
const LIVE_SPOT_STATUS_SAMPLES = 180;
let liveSpotSamples: LiveSpotSample[] = [];
let liveSpotSeq = 0;
let liveSpotDateIst: string | null = null;
let liveSpotTicksThisSecond = 0;
let liveSpotLatestTick: NiftyTick | null = null;
let liveSpotSampleTimer: ReturnType<typeof setTimeout> | null = null;
let liveSpotSampling = false;
/** Open/high/low accumulated inside the current one-second bucket. */
let secondOpenSpot: number | null = null;
let secondHighSpot: number | null = null;
let secondLowSpot: number | null = null;

/** Raw ticks: ring buffer for the UI, append-only JSONL on disk for the full day. */
const RAW_TICK_MAX_MEMORY = 5_000;
const RAW_TICK_STATUS_ROWS = 250;
const TICK_FILE_RETENTION_DAYS = 10;
let rawTicks: RawTickRow[] = [];
let rawTickSeq = 0;
let rawTickDateIst: string | null = null;
let rawTickPending: string[] = [];
let lastNiftyTickPrice: number | null = null;
let lastOptionTickPrice: number | null = null;

function pushLog(text: string, type: NineSixteenBotStatus["logs"][number]["type"] = "info") {
  if (
    (type === "error" || type === "warning") &&
    logs[0]?.message === text &&
    logs[0]?.type === type
  ) {
    return;
  }
  logs.unshift({
    time: getIndianMarketContext().timeIST,
    message: text,
    type,
  });
  logs.splice(20);
  console.log(`[nine-sixteen-bot] ${text}`);
}

function clearLiveSpotSampleTimer() {
  if (liveSpotSampleTimer) clearTimeout(liveSpotSampleTimer);
  liveSpotSampleTimer = null;
}

/** HH:MM:SS.mmm IST — raw ticks need sub-second resolution to be worth keeping. */
function istClockLabelMs(ms: number): string {
  return `${istClockLabel(ms)}.${String(ms % 1000).padStart(3, "0")}`;
}

function pruneOldTickFiles() {
  try {
    const cutoff = Date.now() - TICK_FILE_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(TICK_DIR)) {
      if (!name.startsWith("ws-ticks-")) continue;
      const file = path.join(TICK_DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch {
    /* retention is best-effort */
  }
}

/** Buffered so a 7-hour session costs one small append per second, not one per tick. */
function flushRawTicks() {
  if (rawTickPending.length === 0 || !rawTickDateIst) return;
  const lines = rawTickPending;
  rawTickPending = [];
  try {
    fs.mkdirSync(TICK_DIR, { recursive: true });
    fs.appendFileSync(TICK_FILE(rawTickDateIst), `${lines.join("\n")}\n`);
  } catch (err) {
    console.error("[nine-sixteen-bot] raw tick write failed", err);
  }
}

function recordRawTick(tick: NiftyTick, kind: RawTickRow["kind"]) {
  const ctx = getIndianMarketContext(new Date(tick.receivedAtMs));
  if (rawTickDateIst !== ctx.dateIST) {
    flushRawTicks();
    rawTickDateIst = ctx.dateIST;
    rawTicks = [];
    rawTickSeq = 0;
    lastNiftyTickPrice = null;
    lastOptionTickPrice = null;
    pruneOldTickFiles();
  }

  const prev = kind === "nifty" ? lastNiftyTickPrice : lastOptionTickPrice;
  rawTickSeq += 1;
  const row: RawTickRow = {
    seq: rawTickSeq,
    dateIST: ctx.dateIST,
    timeIST: istClockLabelMs(tick.receivedAtMs),
    epochMs: tick.receivedAtMs,
    exchangeTimeIST:
      tick.exchangeTimestampMs != null ? istClockLabel(tick.exchangeTimestampMs) : null,
    kind,
    instrumentToken: tick.instrumentToken,
    price: tick.lastPrice,
    changePts: prev != null ? Number((tick.lastPrice - prev).toFixed(2)) : null,
  };

  if (kind === "nifty") lastNiftyTickPrice = tick.lastPrice;
  else lastOptionTickPrice = tick.lastPrice;

  rawTicks.push(row);
  if (rawTicks.length > RAW_TICK_MAX_MEMORY) {
    rawTicks = rawTicks.slice(rawTicks.length - RAW_TICK_MAX_MEMORY);
  }
  rawTickPending.push(JSON.stringify(row));
}

function appendLiveSpotSample() {
  if (!liveSpotSampling) return;
  const now = Date.now();
  const ctx = getIndianMarketContext(new Date(now));
  if (liveSpotDateIst !== ctx.dateIST) {
    liveSpotDateIst = ctx.dateIST;
    liveSpotSamples = [];
    liveSpotSeq = 0;
  }
  liveSpotSeq += 1;
  const close = liveSpotLatestTick?.lastPrice ?? lastSpot;
  const sample: LiveSpotSample = {
    seq: liveSpotSeq,
    dateIST: ctx.dateIST,
    timeIST: ctx.timeIST,
    epochMs: now,
    niftySpot: close,
    openSpot: secondOpenSpot,
    highSpot: secondHighSpot,
    lowSpot: secondLowSpot,
    rangePts:
      secondHighSpot != null && secondLowSpot != null
        ? Number((secondHighSpot - secondLowSpot).toFixed(2))
        : null,
    ticksInSecond: liveSpotTicksThisSecond,
    lastTickAtIST: liveSpotLatestTick ? istClockLabel(liveSpotLatestTick.receivedAtMs) : null,
    stale: liveSpotTicksThisSecond === 0,
  };
  liveSpotTicksThisSecond = 0;
  secondOpenSpot = null;
  secondHighSpot = null;
  secondLowSpot = null;
  liveSpotSamples.push(sample);
  if (liveSpotSamples.length > LIVE_SPOT_MAX_SAMPLES) {
    liveSpotSamples = liveSpotSamples.slice(liveSpotSamples.length - LIVE_SPOT_MAX_SAMPLES);
  }
  flushRawTicks();
}

function scheduleLiveSpotSample() {
  clearLiveSpotSampleTimer();
  if (!liveSpotSampling) return;
  const delay = Math.max(20, 1000 - (Date.now() % 1000));
  liveSpotSampleTimer = setTimeout(() => {
    appendLiveSpotSample();
    scheduleLiveSpotSample();
  }, delay);
}

function startLiveSpotSampling() {
  if (liveSpotSampling) return;
  liveSpotSampling = true;
  liveSpotTicksThisSecond = 0;
  scheduleLiveSpotSample();
}

function stopLiveSpotSampling(clearSamples = false) {
  liveSpotSampling = false;
  clearLiveSpotSampleTimer();
  liveSpotTicksThisSecond = 0;
  secondOpenSpot = null;
  secondHighSpot = null;
  secondLowSpot = null;
  flushRawTicks();
  if (clearSamples) {
    liveSpotSamples = [];
    liveSpotSeq = 0;
    liveSpotDateIst = null;
    liveSpotLatestTick = null;
    rawTicks = [];
  }
}

function haltBotTicker(clearSamples = false) {
  stopLiveSpotSampling(clearSamples);
  stopNiftyTicker();
}

function clearNineFifteenTpTracking() {
  nineFifteenTpOrderIds = [];
  nineFifteenTpLimitPrice = 0;
  nineFifteenTpOrderStatus = "none";
  nineFifteenTpFilledQty = 0;
  nineFifteenTpPendingQty = 0;
  nineFifteenTpPlacedAt = null;
  nineFifteenTpLastSyncedAt = null;
  nineFifteenTpLastLogKey = "";
}

function saveBotState(dateIst: string) {
  if (phase !== "in_position" && phase !== "exiting") {
    try {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } catch {
      /* ignore */
    }
    return;
  }
  if (!tradingsymbol || !leg || open915 <= 0) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload: PersistedBotState = {
    dateIST: dateIst,
    phase,
    open915,
    entrySpot: entrySpot > 0 ? entrySpot : undefined,
    exitMode,
    leg,
    tradingsymbol,
    quantity,
    entryPrice,
    lotSize: positionLotSize > 0 ? positionLotSize : undefined,
    lockedPnlPct: lockedPnlPct > 0 ? lockedPnlPct : undefined,
    ownedSymbol: ownedSymbol ?? undefined,
    tradeSlot,
    nineFifteenSettled: nineFifteenSettled || undefined,
    nineFifteenTpOrderIds: tradeSlot === "nine-fifteen" && nineFifteenTpOrderIds.length > 0 ? nineFifteenTpOrderIds : undefined,
    nineFifteenTpLimitPrice:
      tradeSlot === "nine-fifteen" && nineFifteenTpLimitPrice > 0 ? nineFifteenTpLimitPrice : undefined,
    nineFifteenTpOrderStatus:
      tradeSlot === "nine-fifteen" && nineFifteenTpOrderStatus !== "none" ? nineFifteenTpOrderStatus : undefined,
    nineFifteenTpFilledQty:
      tradeSlot === "nine-fifteen" && nineFifteenTpFilledQty > 0 ? nineFifteenTpFilledQty : undefined,
    nineFifteenTpPendingQty:
      tradeSlot === "nine-fifteen" && nineFifteenTpPendingQty > 0 ? nineFifteenTpPendingQty : undefined,
    nineFifteenTpPlacedAt: tradeSlot === "nine-fifteen" && nineFifteenTpPlacedAt ? nineFifteenTpPlacedAt : undefined,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

function loadBotState(dateIst: string) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as PersistedBotState;
    if (parsed.dateIST !== dateIst) return;
    if (parsed.phase !== "in_position" && parsed.phase !== "exiting") return;
    phase = parsed.phase;
    open915 = parsed.open915;
    entrySpot = parsed.entrySpot ?? 0;
    exitMode = parsed.exitMode ?? inferExitModeFromCaptures() ?? "main";
    leg = parsed.leg;
    tradingsymbol = parsed.tradingsymbol;
    quantity = parsed.quantity;
    entryPrice = parsed.entryPrice;
    positionLotSize = parsed.lotSize ?? 0;
    lockedPnlPct = parsed.lockedPnlPct ?? 0;
    ownedSymbol = parsed.ownedSymbol ?? parsed.tradingsymbol;
    tradeSlot = parsed.tradeSlot ?? "nine-sixteen";
    nineFifteenSettled = parsed.nineFifteenSettled ?? tradeSlot === "nine-fifteen";
    nineFifteenTpOrderIds = parsed.nineFifteenTpOrderIds ?? [];
    nineFifteenTpLimitPrice = parsed.nineFifteenTpLimitPrice ?? 0;
    nineFifteenTpOrderStatus = parsed.nineFifteenTpOrderStatus ?? (nineFifteenTpOrderIds.length > 0 ? "pending" : "none");
    nineFifteenTpFilledQty = parsed.nineFifteenTpFilledQty ?? 0;
    nineFifteenTpPendingQty = parsed.nineFifteenTpPendingQty ?? Math.max(0, quantity - nineFifteenTpFilledQty);
    nineFifteenTpPlacedAt = parsed.nineFifteenTpPlacedAt ?? null;
    nineFifteenTpLastSyncedAt = null;
    nineFifteenTpLastLogKey = "";
    message =
      tradeSlot === "nine-fifteen"
        ? `In 9:15 position · ${getNineFifteenLadderLabel()}`
        : `In position · P&L trail ${getPnlTrailScheduleLabel(dateIst)}`;
  } catch {
    /* ignore corrupt state */
  }
}

function inferExitModeFromCaptures(): NineSixteenExitMode | null {
  if (capturedOpen915 == null || capturedClose915 == null) return null;
  return exitModeFrom915Change(capturedClose915 - capturedOpen915);
}

/**
 * The main loop wakes every 50–250ms near 9:16 and the UI polls status every second;
 * without this gate both would hammer /portfolio/positions past Kite's rate limit.
 */
const RECONCILE_MIN_INTERVAL_MS = 5_000;
/** Minimal pause between failed entry attempts (still within 9:16:00–9:16:30). */
const ENTRY_RETRY_DELAY_MS = 250;
/** Parallel SELL rounds attempted per square-off before deferring to the next tick. */
const SQUARE_OFF_MAX_ROUNDS = 3;
/** Extra BUY rounds used to reach the target size after a partial split fill. */
const ENTRY_TOP_UP_MAX_ROUNDS = 2;
/** Gap enforced between square-off attempts so tick-driven retries cannot spam orders. */
const SQUARE_OFF_RETRY_COOLDOWN_MS = 3_000;
let lastSquareOffAttemptAt = 0;
let lastReconcileAt = 0;
let reconcileInFlight = false;

async function reconcilePositionWithKite(accessToken: string, dateIst: string) {
  if (reconcileInFlight) return;
  if (Date.now() - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return;
  reconcileInFlight = true;
  lastReconcileAt = Date.now();
  try {
    await reconcilePositionWithKiteInner(accessToken, dateIst);
  } finally {
    reconcileInFlight = false;
  }
}

/**
 * True only for a position this bot actually opened. Momentum scalper trades the same ATM
 * contracts, so an open MIS leg in our symbol is not automatically ours — claiming it made both
 * bots manage (and square off) the same lots.
 */
function isOwnPosition(symbol: string): boolean {
  return ownedSymbol != null && symbol === ownedSymbol;
}

let warnedForeignPosition = "";

async function reconcilePositionWithKiteInner(accessToken: string, dateIst: string) {
  const open = await findOpenNiftyMisOption(accessToken);

  if (open && !isOwnPosition(open.tradingsymbol)) {
    // Someone else's leg (momentum scalper or a manual trade) — leave it completely alone.
    if (warnedForeignPosition !== open.tradingsymbol) {
      warnedForeignPosition = open.tradingsymbol;
      pushLog(
        `Ignoring ${open.tradingsymbol} · ${open.quantity} qty — not opened by the 9:16 bot`,
        "info",
      );
    }
    return;
  }

  if (open) {
    tradingsymbol = open.tradingsymbol;
    // Never take the broker's aggregate quantity — another bot may hold lots in this contract.
    if (quantity <= 0) quantity = open.quantity;
    if (entryPrice <= 0) entryPrice = open.average_price;
    lastOptionPrice = open.last_price;
    unrealisedPnl = ownLegUnrealisedPnl(entryPrice, quantity, open.last_price);
    leg = open.tradingsymbol.endsWith("PE") ? "PE_BUY" : "CE_BUY";
    phase = "in_position";

    if (open915 <= 0 && capturedOpen915 != null && capturedOpen915 > 0) {
      open915 = capturedOpen915;
    }

    const inferred = inferExitModeFromCaptures();
    if (inferred) exitMode = inferred;

    if (entrySpot <= 0) {
      try {
        const spot = await fetchNiftySpot(accessToken);
        if (spot > 0) entrySpot = spot;
      } catch {
        /* keep unset until quotes refresh */
      }
    }

    message = `In position · P&L trail ${getPnlTrailScheduleLabel(dateIst)}`;
    saveBotState(dateIst);
    return;
  }

  // Do not race a live square-off — squareOff persists the closed log itself.
  if (squareOffInFlight || phase === "exiting") return;

  // Entry still in flight or retrying — no MIS position is expected; never finish the day.
  if (phase === "entering") return;
  if (!isPast916EntryWindow() && entryPrice <= 0 && phase !== "in_position") return;

  const wasTracking =
    phase === "in_position" || (entryPrice > 0 && quantity > 0 && Boolean(tradingsymbol));

  if (!wasTracking) return;

  const symbol = tradingsymbol;
  const closedId = makeClosedBotTradeLogId(dateIst, symbol);
  const store = await loadBotTradeLogs();
  const alreadyLogged = store.trades.some(
    (row) =>
      row.id === closedId ||
      (row.dateIST === dateIst &&
        row.status === "closed" &&
        (row.tradingsymbol === symbol || Boolean(symbol && row.tradingsymbol === symbol))),
  );

  if (!alreadyLogged && symbol && entryPrice > 0 && quantity > 0) {
    let exitPrice = lastOptionPrice;
    try {
      const orders = await kiteGet<
        { tradingsymbol: string; transaction_type: string; status: string; average_price: number; order_timestamp: string }[]
      >("/orders", accessToken);
      const exitOrder = orders
        .filter(
          (o) =>
            o.tradingsymbol === symbol &&
            o.transaction_type === "SELL" &&
            o.status === "COMPLETE" &&
            o.average_price > 0,
        )
        .sort(
          (a, b) =>
            new Date(b.order_timestamp).getTime() - new Date(a.order_timestamp).getTime(),
        )[0];
      if (exitOrder) exitPrice = exitOrder.average_price;
    } catch {
      /* use last known LTP */
    }

    const pnl =
      exitPrice != null && exitPrice > 0
        ? (exitPrice - entryPrice) * quantity
        : unrealisedPnl;

    try {
      await appendBotTradeLog({
        id: closedId,
        source: "nine-sixteen",
        dateIST: dateIst,
        status: "closed",
        leg,
        tradingsymbol: symbol,
        quantity,
        open915: open915 > 0 ? open915 : capturedOpen915,
        close915: capturedClose915,
        change915:
          open915 > 0 && capturedClose915 != null
            ? capturedClose915 - open915
            : capturedOpen915 != null && capturedClose915 != null
              ? capturedClose915 - capturedOpen915
              : null,
        entrySpot: entrySpot > 0 ? entrySpot : null,
        targetSpot: computeTargetSpot(),
        entryPrice,
        exitPrice: exitPrice ?? null,
        exitSpot: lastSpot,
        pnl,
        exitReason: "Reconciled — flat on Zerodha",
        message: `CLOSED · reconciled flat · ${symbol}`,
        logs: sessionLogsCopy(),
        createdAt: new Date().toISOString(),
        closedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[nine-sixteen-bot] reconcile trade log save failed", err);
      pushLog(
        `Trade log save failed · ${err instanceof Error ? err.message : "unknown"}`,
        "error",
      );
    }
  }

  finishDay(dateIst, "Session complete · no open position on Zerodha", "success");
}

function markRanToday(dateIst: string) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(RAN_FILE(dateIst), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
}

function hasRanToday(dateIst: string): boolean {
  return fs.existsSync(RAN_FILE(dateIst));
}

function computeTargetSpot(): number | null {
  return null;
}

function sessionLogsCopy() {
  return [...logs];
}

async function persistTradeLog(
  dateIst: string,
  status: BotTradeLogStatus,
  note: string,
  extra?: {
    exitPrice?: number | null;
    exitSpot?: number | null;
    pnl?: number | null;
    exitReason?: string | null;
  },
) {
  const closedAt = status === "closed" ? new Date().toISOString() : new Date().toISOString();
  const open =
    open915 > 0 ? open915 : capturedOpen915 != null && capturedOpen915 > 0 ? capturedOpen915 : null;
  const close =
    capturedClose915 != null && capturedClose915 > 0 ? capturedClose915 : null;
  const change = open != null && close != null ? close - open : null;
  // Two trades can now land on the same day, and both buy the ATM PE — so the day's session-level
  // outcomes are keyed by slot as well as status, or the second would overwrite the first.
  const id =
    status === "closed" && tradingsymbol
      ? makeBotTradeLogId(dateIst, tradingsymbol)
      : makeSessionOutcomeLogId(dateIst, `${tradeSlot}-${status}`);
  const slotNote = tradeSlot === "nine-fifteen" ? `[9:15] ${note}` : note;

  try {
    await appendBotTradeLog({
      id,
      source: "nine-sixteen",
      dateIST: dateIst,
      status,
      leg,
      tradingsymbol,
      quantity: quantity > 0 ? quantity : null,
      open915: open,
      // The 9:15 leg is entered inside its own candle, so that candle has no close yet. Booking
      // one would record a bar the trade was never taken on.
      close915: tradeSlot === "nine-fifteen" ? null : close,
      change915: tradeSlot === "nine-fifteen" ? null : change,
      entrySpot: entrySpot > 0 ? entrySpot : null,
      targetSpot: computeTargetSpot(),
      entryPrice: entryPrice > 0 ? entryPrice : null,
      exitPrice: extra?.exitPrice ?? null,
      exitSpot: extra?.exitSpot ?? lastSpot,
      pnl: extra?.pnl ?? unrealisedPnl,
      exitReason: extra?.exitReason ?? (status === "skipped" || status === "no_entry" ? note : null),
      message: slotNote,
      logs: sessionLogsCopy(),
      createdAt: new Date().toISOString(),
      closedAt,
    });
  } catch (err) {
    console.error("[nine-sixteen-bot] trade log save failed", err);
    pushLog(
      `Trade log save failed · ${err instanceof Error ? err.message : "unknown"}`,
      "error",
    );
  }
}

function finishDay(
  dateIst: string,
  note: string,
  type: NineSixteenBotStatus["logs"][number]["type"] = "info",
) {
  markRanToday(dateIst);
  phase = "done";
  message = note;
  tradeSlot = "nine-sixteen";
  tradingsymbol = null;
  ownedSymbol = null;
  quantity = 0;
  entryPrice = 0;
  positionLotSize = 0;
  entrySpot = 0;
  exitMode = "main";
  open915 = 0;
  leg = null;
  lastSpot = null;
  lastOptionPrice = null;
  unrealisedPnl = null;
  lockedPnlPct = 0;
  lastQuoteRefreshAt = 0;
  lastPositionSyncAt = 0;
  warnedForeignPosition = "";
  clearCaptures(dateIst);
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
  pushLog(note, type);
}

function saveCaptures(dateIst: string) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload: PersistedCaptureState = {
    dateIST: dateIst,
    open: capturedOpen915,
    close: capturedClose915,
    high: capturedHigh915,
    low: capturedLow915,
  };
  fs.writeFileSync(CAPTURE_FILE, JSON.stringify(payload, null, 2));
}

function loadCaptures(dateIst: string) {
  try {
    if (!fs.existsSync(CAPTURE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CAPTURE_FILE, "utf-8")) as PersistedCaptureState;
    if (parsed.dateIST !== dateIst) return;
    if (parsed.open != null && parsed.open > 0) capturedOpen915 = parsed.open;
    if (parsed.close != null && parsed.close > 0) capturedClose915 = parsed.close;
    if (parsed.high != null && parsed.high > 0) capturedHigh915 = parsed.high;
    if (parsed.low != null && parsed.low > 0) capturedLow915 = parsed.low;
  } catch {
    /* ignore */
  }
}

function resetTickRuntime() {
  lastTickBeforeClose = null;
  tickHigh915 = null;
  tickLow915 = null;
  tickCount915 = 0;
  openTickAtLabel = null;
  closeTickAtLabel = null;
  optionInstrumentToken = 0;
  // Websocket stays up 9:00–16:00 — only drop the option leg subscription.
  if (niftyInstrumentToken > 0) setBotTickerInstruments([niftyInstrumentToken]);
}

function clearCaptures(_dateIst: string) {
  capturedOpen915 = null;
  capturedClose915 = null;
  capturedHigh915 = null;
  capturedLow915 = null;
  resetTickRuntime();
  try {
    if (fs.existsSync(CAPTURE_FILE)) fs.unlinkSync(CAPTURE_FILE);
  } catch {
    /* ignore */
  }
}

function istClockLabel(ms: number): string {
  // en-IN + hour12:false can yield "24:…" at midnight — normalize.
  const raw = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
  const m = /^(\d{1,2})(:\d{2}:\d{2})$/.exec(raw);
  if (!m) return raw;
  const hour = Number(m[1]) % 24;
  return `${String(hour).padStart(2, "0")}${m[2]}`;
}

function handle915CaptureTick(tick: NiftyTick, dateIst: string) {
  const price = tick.lastPrice;
  if (!isIn915CloseTickWindow(tick.receivedAtMs)) return;

  // Seal the five-second read before this tick overwrites the running "last tick" — the read is
  // the last print strictly before 9:15:05, so a tick landing at 9:15:05.4 must not become it.
  if (isPastNineFifteenSignalRead(tick.receivedAtMs)) {
    sealNineFifteenMark();
  }

  lastTickBeforeClose = price;
  closeTickAtLabel = istClockLabel(tick.receivedAtMs);
  tickCount915 += 1;
  tickHigh915 = tickHigh915 == null ? price : Math.max(tickHigh915, price);
  tickLow915 = tickLow915 == null ? price : Math.min(tickLow915, price);

  if (isIn915OpenTickWindow(tick.receivedAtMs) && (capturedOpen915 == null || capturedOpen915 <= 0)) {
    capturedOpen915 = price;
    openTickAtLabel = istClockLabel(tick.receivedAtMs);
    capturedHigh915 = tickHigh915;
    capturedLow915 = tickLow915;
    saveCaptures(dateIst);
    pushLog(`9:15:00 open (first WS tick @ ${openTickAtLabel}) · ${price.toFixed(2)}`, "success");
    message = `Open locked ${price.toFixed(2)} · collecting ticks until 9:16:00`;
  }
}

function handleBotTick(tick: NiftyTick) {
  const dateIst = getIndianMarketContext().dateIST;
  const isOption = optionInstrumentToken > 0 && tick.instrumentToken === optionInstrumentToken;
  const isNifty =
    !isOption && (niftyInstrumentToken <= 0 || tick.instrumentToken === niftyInstrumentToken);

  if (isNifty) {
    lastSpot = tick.lastPrice;
    liveSpotLatestTick = tick;
    liveSpotTicksThisSecond += 1;
    if (secondOpenSpot == null) secondOpenSpot = tick.lastPrice;
    secondHighSpot = secondHighSpot == null ? tick.lastPrice : Math.max(secondHighSpot, tick.lastPrice);
    secondLowSpot = secondLowSpot == null ? tick.lastPrice : Math.min(secondLowSpot, tick.lastPrice);
    recordRawTick(tick, "nifty");
    // The 9:15 leg trades inside the very candle it is reading, so capture keeps running while it
    // is open — the 9:16 decision needs that candle's close either way.
    if (tradeSlot === "nine-fifteen" || (phase !== "in_position" && phase !== "exiting")) {
      handle915CaptureTick(tick, dateIst);
    }
  }

  if (isOption) {
    lastOptionPrice = tick.lastPrice;
    recordRawTick(tick, "option");
    if (entryPrice > 0 && quantity > 0) {
      unrealisedPnl = (lastOptionPrice - entryPrice) * quantity;
    }
  }

  if (phase === "in_position") {
    // Never let a tick-driven exit failure become an unhandled rejection (crashes the process).
    void evaluateLiveExits().catch((err) => {
      pushLog(
        `Tick exit check failed · ${err instanceof Error ? err.message : "unknown"}`,
        "warning",
      );
    });
  }
}

/**
 * Freeze the 9:15:05 read.
 *
 * Called from the tick handler and again from the 9:15:06 timer, because a minute quiet enough to
 * print nothing after 9:15:05 would otherwise never seal one.
 */
function sealNineFifteenMark() {
  if (nineFifteenMarkPrice != null) return;
  if (!isPastNineFifteenSignalRead()) return;
  if (lastTickBeforeClose == null || lastTickBeforeClose <= 0) return;
  if (capturedOpen915 == null || capturedOpen915 <= 0) return;

  nineFifteenMarkPrice = lastTickBeforeClose;
  nineFifteenMarkAtLabel = closeTickAtLabel;
  const change = nineFifteenMarkPrice - capturedOpen915;
  pushLog(
    `9:15:05 read · ${nineFifteenMarkPrice.toFixed(2)} vs open ${capturedOpen915.toFixed(2)} · ` +
      `Δ ${change >= 0 ? "+" : ""}${change.toFixed(2)} (${change < 0 ? "red" : change > 0 ? "green" : "flat"})`,
    change < 0 ? "success" : "info",
  );
}

function seal915CloseFromTicks(dateIst: string) {
  if (capturedClose915 != null && capturedClose915 > 0) {
    return;
  }
  if (lastTickBeforeClose == null || lastTickBeforeClose <= 0) {
    return;
  }
  capturedClose915 = lastTickBeforeClose;
  capturedHigh915 = tickHigh915 ?? Math.max(capturedOpen915 ?? capturedClose915, capturedClose915);
  capturedLow915 = tickLow915 ?? Math.min(capturedOpen915 ?? capturedClose915, capturedClose915);
  saveCaptures(dateIst);
  const open = capturedOpen915 ?? 0;
  const delta = capturedClose915 - open;
  pushLog(
    `9:15:59 close (last WS tick${closeTickAtLabel ? ` @ ${closeTickAtLabel}` : ""} before 9:16:00) · ${capturedClose915.toFixed(2)} · Δ ${delta.toFixed(2)} · ${tickCount915} tick(s)`,
    "success",
  );
  message =
    open > 0
      ? `9:15 WS OHLC locked · open ${open.toFixed(2)} · close ${capturedClose915.toFixed(2)} · Δ ${delta.toFixed(2)} · entering now`
      : `9:15:59 close locked · missing 9:15:00–9:15:15 open tick`;
}

/** Kite caps concurrent websockets per API key — back off between reconnect attempts. */
const TICKER_RESTART_MIN_INTERVAL_MS = 3_000;
let lastTickerStartAt = 0;

async function ensureNiftyTicker(accessToken: string, _dateIst: string) {
  if (!isInBotWsHours() && phase !== "in_position" && phase !== "exiting") return;
  if (hasNiftyTickerInstance() || tickerStartInFlight) return;
  if (Date.now() - lastTickerStartAt < TICKER_RESTART_MIN_INTERVAL_MS) return;

  lastTickerStartAt = Date.now();
  tickerStartInFlight = true;
  try {
    niftyInstrumentToken = await resolveNifty50InstrumentToken(accessToken);
    const tokens = optionInstrumentToken > 0
      ? [niftyInstrumentToken, optionInstrumentToken]
      : [niftyInstrumentToken];
    startNiftyTicker({
      accessToken,
      instrumentTokens: tokens,
      onTick: (tick) => handleBotTick(tick),
      onConnect: () => {
        startLiveSpotSampling();
        pushLog("Kite websocket connected · listening for Nifty 50 ticks", "success");
        if (phase === "waiting") {
          message = capturedOpen915
            ? `WS live · open ${capturedOpen915.toFixed(2)} · waiting for 9:16:00 close`
            : "Kite websocket live · waiting for first 9:15:00–9:15:15 tick";
        }
      },
      onDisconnect: (error) => {
        // The shared ticker reconnects itself; REST polling covers the gap meanwhile.
        pushLog(
          `Kite websocket disconnected${error?.message ? ` · ${error.message}` : ""}`,
          "warning",
        );
      },
      onError: (error) => {
        pushLog(`Kite websocket: ${error.message}`, "warning");
      },
    });
  } finally {
    tickerStartInFlight = false;
  }
}

/**
 * From 9:00: pull the NFO instrument master into cache, settle the whitelisted egress route,
 * and open a connection to /user/margins. Each of these otherwise runs cold inside tryEnter
 * and pushes the first order several seconds past 9:16:00.
 */
async function prewarmEntryPath(accessToken: string, dateIst: string) {
  if (prewarmDoneDate === dateIst || prewarmInFlight) return;
  if (Date.now() - lastPrewarmAttemptAt < PREWARM_RETRY_MS) return;
  prewarmInFlight = true;
  lastPrewarmAttemptAt = Date.now();
  try {
    const [chain, egress, balance] = await Promise.allSettled([
      prewarmNiftyOptionChain(),
      assertKiteEgressReady(true),
      fetchEquityAvailableBalance(accessToken),
    ]);

    if (chain.status !== "fulfilled") {
      pushLog(
        `Pre-warm retry · NFO instruments unavailable · ${chain.reason instanceof Error ? chain.reason.message : "unknown"}`,
        "warning",
      );
      return;
    }

    prewarmDoneDate = dateIst;
    pushLog(
      `Pre-warmed for 9:16:00 · ${chain.value} NFO instruments cached · ${
        egress.status === "fulfilled" ? "egress ready" : "egress pending"
      } · ${balance.status === "fulfilled" ? `₹${Math.floor(balance.value)} avail` : "balance pending"}`,
      "success",
    );
  } finally {
    prewarmInFlight = false;
  }
}

/**
 * At 9:15:58 resolve both ATM legs from the live websocket spot. The 9:15 close still decides
 * CE vs PE at 9:16:00 — this only pre-computes the strike so entry is a pure order placement.
 * Instruments are already cached and the spot comes from a tick, so this costs no REST call.
 */
async function preResolveAtmSymbols(accessToken: string, dateIst: string) {
  if (preResolvedDate === dateIst || preResolveInFlight) return;
  if (Date.now() - lastPreResolveAttemptAt < PRE_RESOLVE_RETRY_MS) return;
  const spot = lastSpot;
  if (spot == null || spot <= 0) return;

  preResolveInFlight = true;
  lastPreResolveAttemptAt = Date.now();
  try {
    // Refill the 45s egress route cache so tryEnter never probes the outbound IP at 9:16:00.
    // Non-forcing (never clears the existing route) and detached, so it cannot delay arming.
    void assertKiteEgressReady().catch(() => {
      /* tryEnter re-checks and surfaces the real error */
    });

    const [ce, pe] = await Promise.all([
      resolveAtmNiftyOption(accessToken, "CE_BUY", { spotPrice: spot }),
      resolveAtmNiftyOption(accessToken, "PE_BUY", { spotPrice: spot }),
    ]);
    if (!ce || !pe) {
      pushLog("ATM pre-resolve incomplete · 9:16:00 will resolve live", "warning");
      return;
    }
    preResolvedCe = ce;
    preResolvedPe = pe;
    preResolvedDate = dateIst;
    pushLog(
      `ATM pre-resolved @ spot ${spot.toFixed(2)} · CE ${ce.tradingsymbol} · PE ${pe.tradingsymbol} · armed for 9:16:00`,
      "success",
    );
  } catch (err) {
    pushLog(
      `ATM pre-resolve failed · ${err instanceof Error ? err.message : "unknown"} · 9:16:00 will resolve live`,
      "warning",
    );
  } finally {
    preResolveInFlight = false;
  }
}

/**
 * Time-gated cache warming; each step is a no-op outside its window or once done for the day.
 * Both steps are detached: they are pure optimisations, and if a cache is unexpectedly cold
 * they must never hold the poll loop past 9:16:00. tryEnter resolves live either way.
 */
function maintainEntryReadiness(accessToken: string, dateIst: string) {
  if (isReadyForEntryPrewarm()) {
    void prewarmEntryPath(accessToken, dateIst).catch(() => {
      /* logged inside */
    });
  }
  if (isReadyForAtmPreResolve()) {
    void preResolveAtmSymbols(accessToken, dateIst).catch(() => {
      /* logged inside */
    });
  }
}

/**
 * Resolve the ATM PE at 9:15:04, two seconds before the 9:15 order can go out.
 *
 * Only the put is resolved: the 9:15 trade has no long side, so warming the call would spend a
 * chain lookup on a leg that can never be bought.
 */
async function preResolveNineFifteenPe(accessToken: string, dateIst: string) {
  if (nineFifteenPreResolvedDate === dateIst || nineFifteenPreResolveInFlight) return;
  const spot = lastSpot;
  if (spot == null || spot <= 0) return;

  nineFifteenPreResolveInFlight = true;
  try {
    void assertKiteEgressReady().catch(() => {
      /* the entry re-checks and surfaces the real error */
    });
    const pe = await resolveAtmNiftyOption(accessToken, "PE_BUY", { spotPrice: spot });
    if (!pe) {
      pushLog("9:15 ATM PE pre-resolve incomplete · 9:15:06 will resolve live", "warning");
      return;
    }
    nineFifteenPreResolvedPe = pe;
    nineFifteenPreResolvedDate = dateIst;
    pushLog(`9:15 ATM PE armed @ spot ${spot.toFixed(2)} · ${pe.tradingsymbol}`, "info");
  } catch (err) {
    pushLog(
      `9:15 ATM PE pre-resolve failed · ${err instanceof Error ? err.message : "unknown"}`,
      "warning",
    );
  } finally {
    nineFifteenPreResolveInFlight = false;
  }
}

/**
 * Cached route first — pre-warmed at 9:00 and refilled at 9:15:58, so this is normally free.
 * A cached "blocked" verdict lives 45s, longer than the whole entry window, so re-probe before
 * giving up in case the outbound IP just changed or recovered.
 */
async function assertEgressReadyForEntry() {
  try {
    await assertKiteEgressReady();
  } catch {
    await assertKiteEgressReady(true);
  }
}

/**
 * Attempt 1 reuses the 9:15:58 pre-resolved leg for the fastest possible order. Retries
 * re-resolve against the current websocket spot so a fast move still gets the right strike.
 */
async function resolveEntryOption(
  accessToken: string,
  entryLeg: TradeLeg,
  attempt: number,
  dateIst: string,
): Promise<ResolvedAtmOption | null> {
  if (attempt === 1 && preResolvedDate === dateIst) {
    const cached = entryLeg === "CE_BUY" ? preResolvedCe : preResolvedPe;
    if (cached) return cached;
  }
  return resolveAtmNiftyOption(accessToken, entryLeg, {
    spotPrice: lastSpot != null && lastSpot > 0 ? lastSpot : undefined,
  });
}

/** Kite allows ~10 order requests/sec — send simultaneously, but never exceed one burst. */
const MAX_PARALLEL_ORDERS_PER_BURST = 9;

async function placeSplitMarketOrders(
  accessToken: string,
  input: {
    tradingsymbol: string;
    transaction_type: "BUY" | "SELL";
    quantities: number[];
  },
): Promise<{ orderIds: string[]; failures: Error[] }> {
  const orderIds: string[] = [];
  const failures: Error[] = [];

  for (let i = 0; i < input.quantities.length; i += MAX_PARALLEL_ORDERS_PER_BURST) {
    const burst = input.quantities.slice(i, i + MAX_PARALLEL_ORDERS_PER_BURST);
    const results = await Promise.allSettled(
      burst.map((quantity) =>
        placeRegularMarketOrder(accessToken, {
          tradingsymbol: input.tradingsymbol,
          exchange: "NFO",
          transaction_type: input.transaction_type,
          product: "MIS",
          quantity,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        orderIds.push(result.value);
      } else {
        failures.push(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
      }
    }
    if (i + MAX_PARALLEL_ORDERS_PER_BURST < input.quantities.length) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  return { orderIds, failures };
}

async function placeSplitLimitOrders(
  accessToken: string,
  input: {
    tradingsymbol: string;
    transaction_type: "BUY" | "SELL";
    quantities: number[];
    price: number;
  },
): Promise<{ orderIds: string[]; failures: Error[] }> {
  const orderIds: string[] = [];
  const failures: Error[] = [];
  const price = Number(input.price.toFixed(2));

  for (let i = 0; i < input.quantities.length; i += MAX_PARALLEL_ORDERS_PER_BURST) {
    const burst = input.quantities.slice(i, i + MAX_PARALLEL_ORDERS_PER_BURST);
    const results = await Promise.allSettled(
      burst.map((quantity) =>
        placeRegularLimitOrder(accessToken, {
          tradingsymbol: input.tradingsymbol,
          exchange: "NFO",
          transaction_type: input.transaction_type,
          product: "MIS",
          quantity,
          price,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        orderIds.push(result.value);
      } else {
        failures.push(
          result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
        );
      }
    }
    if (i + MAX_PARALLEL_ORDERS_PER_BURST < input.quantities.length) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  return { orderIds, failures };
}

async function cancelNineFifteenTakeProfitOrders(accessToken: string): Promise<void> {
  if (nineFifteenTpOrderIds.length === 0) return;
  for (const orderId of nineFifteenTpOrderIds) {
    try {
      await cancelRegularOrder(accessToken, orderId);
    } catch {
      /* already filled or cancelled */
    }
  }
  if (nineFifteenTpFilledQty <= 0) {
    nineFifteenTpOrderStatus = "cancelled";
  }
  nineFifteenTpOrderIds = [];
  nineFifteenTpPendingQty = Math.max(0, quantity - nineFifteenTpFilledQty);
}

async function resolveNineFifteenTakeProfitExitPrice(accessToken: string): Promise<number | null> {
  if (nineFifteenTpOrderIds.length === 0) {
    return nineFifteenTpLimitPrice > 0 ? nineFifteenTpLimitPrice : lastOptionPrice;
  }
  try {
    const rows = await fetchOrdersByIds(accessToken, nineFifteenTpOrderIds);
    let notional = 0;
    let filledQty = 0;
    for (const row of rows.values()) {
      const qty = Number(row.filled_quantity) || 0;
      const avg = Number(row.average_price) || 0;
      if (qty <= 0 || avg <= 0) continue;
      notional += avg * qty;
      filledQty += qty;
    }
    if (filledQty > 0) return notional / filledQty;
  } catch {
    /* fall through */
  }
  return nineFifteenTpLimitPrice > 0 ? nineFifteenTpLimitPrice : lastOptionPrice;
}

async function syncNineFifteenTakeProfitOrders(
  accessToken: string,
  dateIst: string,
): Promise<NineFifteenTpOrderStatus> {
  if (tradeSlot !== "nine-fifteen" || quantity <= 0) {
    return nineFifteenTpOrderStatus;
  }

  if (nineFifteenTpOrderIds.length === 0) {
    nineFifteenTpLastSyncedAt = new Date().toISOString();
    return nineFifteenTpOrderStatus;
  }

  try {
    const rows = await fetchOrdersByIds(accessToken, nineFifteenTpOrderIds);
    let filledQty = 0;
    let pendingQty = 0;
    let anyRejected = false;

    for (const orderId of nineFifteenTpOrderIds) {
      const row = rows.get(orderId);
      if (!row) {
        pendingQty += Math.max(0, quantity - filledQty - pendingQty);
        continue;
      }
      const orderQty = Number(row.quantity) || 0;
      const orderFilled = Number(row.filled_quantity) || 0;
      filledQty += orderFilled;
      pendingQty += Math.max(0, orderQty - orderFilled);
      const status = (row.status ?? "").toUpperCase();
      if (status === "REJECTED") anyRejected = true;
    }

    nineFifteenTpFilledQty = filledQty;
    nineFifteenTpPendingQty = pendingQty;
    nineFifteenTpLastSyncedAt = new Date().toISOString();

    let nextStatus: NineFifteenTpOrderStatus = "pending";
    if (filledQty >= quantity) nextStatus = "complete";
    else if (filledQty > 0) nextStatus = "partial";
    else if (anyRejected && pendingQty <= 0) nextStatus = "failed";

    const logKey = `${nextStatus}:${filledQty}/${quantity}`;
    if (logKey !== nineFifteenTpLastLogKey) {
      nineFifteenTpLastLogKey = logKey;
      if (nextStatus === "partial") {
        pushLog(
          `9:15 limit sell partially filled · ${filledQty}/${quantity} qty @ ₹${nineFifteenTpLimitPrice.toFixed(2)} · ${pendingQty} still working on Kite`,
          "info",
        );
      } else if (nextStatus === "complete") {
        pushLog(
          `9:15 limit sell fully filled on Kite · ${filledQty} qty @ ₹${nineFifteenTpLimitPrice.toFixed(2)}`,
          "success",
        );
      } else if (nextStatus === "failed") {
        pushLog("9:15 limit sell rejected on Kite — market backup at +5% remains active", "warning");
      }
    }

    nineFifteenTpOrderStatus = nextStatus;
    saveBotState(dateIst);
    return nextStatus;
  } catch (err) {
    pushLog(
      `9:15 limit sell sync failed · ${err instanceof Error ? err.message : "could not read Kite orders"}`,
      "warning",
    );
    return nineFifteenTpOrderStatus;
  }
}

async function placeNineFifteenTakeProfitOrders(accessToken: string, dateIst: string): Promise<void> {
  if (!tradingsymbol || quantity <= 0 || entryPrice <= 0) return;

  if (nineFifteenTpOrderIds.length > 0) {
    await cancelNineFifteenTakeProfitOrders(accessToken);
  }

  const limitPrice = nineFifteenTakeProfitLimitPrice(entryPrice);
  if (!(limitPrice > 0)) return;

  const lotSize = positionLotSize > 0 ? positionLotSize : 65;
  const chunks = splitQuantityIntoOrderChunks(quantity, lotSize);
  const capital = nineFifteenDeployedCapital(entryPrice, quantity);
  const profitAim = nineFifteenTakeProfitAmount(entryPrice, quantity);

  pushLog(
    `9:15 TP limit · SELL ${quantity} qty @ ₹${limitPrice.toFixed(2)} ` +
      `(+${NINE_FIFTEEN_TAKE_PROFIT_PCT}% on ₹${Math.round(capital)} deployed → ₹${Math.round(profitAim)} profit aim)`,
    "success",
  );

  const placed = await placeSplitLimitOrders(accessToken, {
    tradingsymbol,
    transaction_type: "SELL",
    quantities: chunks,
    price: limitPrice,
  });
  for (const failure of placed.failures) {
    pushLog(`9:15 TP limit rejected · ${failure.message}`, "warning");
  }
  if (placed.orderIds.length === 0) {
    nineFifteenTpOrderStatus = "failed";
    pushLog("9:15 TP limit not placed — will exit at +5% via market backup if price prints", "warning");
    saveBotState(dateIst);
    return;
  }

  nineFifteenTpOrderIds = placed.orderIds;
  nineFifteenTpLimitPrice = limitPrice;
  nineFifteenTpOrderStatus = "pending";
  nineFifteenTpFilledQty = 0;
  nineFifteenTpPendingQty = quantity;
  nineFifteenTpPlacedAt = new Date().toISOString();
  nineFifteenTpLastSyncedAt = nineFifteenTpPlacedAt;
  nineFifteenTpLastLogKey = `pending:0/${quantity}`;
  pushLog(
    `9:15 limit sell LIVE on Kite · ${placed.orderIds.length} order(s) · ${quantity} qty @ ₹${limitPrice.toFixed(2)} · tracking until filled`,
    "success",
  );
  saveBotState(dateIst);
}

async function completeNineFifteenTakeProfitExit(
  accessToken: string,
  dateIst: string,
  via: "limit" | "market" | "hard-stop" | "eod",
): Promise<void> {
  if (squareOffInFlight || phase === "exiting" || !tradingsymbol || quantity <= 0) return;

  phase = "exiting";

  const exitPrice = await resolveNineFifteenTakeProfitExitPrice(accessToken);
  const closedQty = quantity;
  const closedEntry = entryPrice;
  const pnl =
    closedEntry > 0 && exitPrice != null && exitPrice > 0
      ? (exitPrice - closedEntry) * closedQty
      : unrealisedPnl;

  const summary = formatNineFifteenExitSummary({
    exitPrice,
    quantity: closedQty,
    entryPrice: closedEntry,
    pnl,
    via,
  });
  message = summary;

  clearNineFifteenTpTracking();

  await persistTradeLog(dateIst, "closed", summary, {
    exitPrice: exitPrice != null && exitPrice > 0 ? exitPrice : null,
    exitSpot: lastSpot,
    pnl,
    exitReason: summary,
  });
  concludeTrade(dateIst, summary, "success");
}

const TERMINAL_ORDER_STATUSES = new Set(["COMPLETE", "REJECTED", "CANCELLED"]);

/**
 * Quantity already working on Kite for this symbol/side. Retry rounds subtract this so a
 * slow order can never be duplicated into an oversized (or short) position.
 */
async function pendingOrderQuantity(
  accessToken: string,
  symbol: string,
  side: "BUY" | "SELL",
): Promise<number> {
  try {
    const orders = await kiteGet<
      {
        tradingsymbol: string;
        transaction_type: string;
        status: string;
        quantity: number;
        filled_quantity: number;
      }[]
    >("/orders", accessToken);
    return orders
      .filter(
        (order) =>
          order.tradingsymbol === symbol &&
          order.transaction_type === side &&
          !TERMINAL_ORDER_STATUSES.has((order.status ?? "").toUpperCase()),
      )
      .reduce(
        (sum, order) => sum + Math.max(0, (order.quantity ?? 0) - (order.filled_quantity ?? 0)),
        0,
      );
  } catch {
    return 0;
  }
}

async function awaitOrderFills(
  accessToken: string,
  orderIds: string[],
): Promise<{
  fills: { average_price: number; filled_quantity: number }[];
  failures: Error[];
}> {
  const results = await Promise.allSettled(
    orderIds.map((orderId) => waitForOrderComplete(accessToken, orderId)),
  );
  const fills: { average_price: number; filled_quantity: number }[] = [];
  const failures: Error[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      fills.push(result.value);
    } else {
      failures.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    }
  }
  return { fills, failures };
}

function weightedAverageFillPrice(
  fills: { average_price: number; filled_quantity: number }[],
): number {
  let notional = 0;
  let qty = 0;
  for (const fill of fills) {
    if (fill.filled_quantity > 0 && fill.average_price > 0) {
      notional += fill.average_price * fill.filled_quantity;
      qty += fill.filled_quantity;
    }
  }
  return qty > 0 ? notional / qty : 0;
}

/**
 * Book the entry from this bot's own fills. The broker's net MIS position for the contract is
 * deliberately not used — momentum scalper can hold lots in the same symbol, and inheriting its
 * quantity made both bots manage (and square off) each other's legs.
 */
function applyOwnEntryFills(
  symbol: string,
  lotSize: number,
  fills: { average_price: number; filled_quantity: number }[],
): boolean {
  const filledQty = fills.reduce(
    (sum, fill) => sum + (fill.filled_quantity > 0 ? fill.filled_quantity : 0),
    0,
  );
  const avgPrice = weightedAverageFillPrice(fills);
  if (filledQty <= 0 || avgPrice <= 0) return false;

  // Top-up rounds add to the leg we already hold rather than replacing it.
  const priorQty = tradingsymbol === symbol ? quantity : 0;
  const priorPrice = priorQty > 0 ? entryPrice : 0;

  positionLotSize = lotSize;
  tradingsymbol = symbol;
  quantity = priorQty + filledQty;
  entryPrice =
    priorQty > 0 && priorPrice > 0
      ? (priorPrice * priorQty + avgPrice * filledQty) / (priorQty + filledQty)
      : avgPrice;
  // Seed the mark at cost so P&L reads 0 until the first live tick, never a stale price.
  lastOptionPrice = entryPrice;
  unrealisedPnl = 0;
  return true;
}

/**
 * Fold a broker position read into our own book without inheriting anyone else's lots.
 *
 * `pos.quantity` is the net across every bot holding the contract, and `pos.average_price` is
 * blended over all of the day's buys in that symbol — including round trips already closed. Taking
 * either at face value booked an entry price this bot never paid (on 2026-08-25 it recorded 29.58,
 * the blend of its own closed 6305 @ 39.17 and the scalper's open 8385 @ 22.37) and fed the
 * trailing ladder a percentage computed from lots it did not own.
 */
function applyOwnPositionSync(pos: { quantity: number; average_price: number }) {
  const next = ownPositionSync({ quantity, entryPrice }, pos);
  quantity = next.quantity;
  entryPrice = next.entryPrice;
}

/**
 * Recovery-only sync: used when this bot placed orders but lost track of the fills (crash or a
 * failed order lookup). Guarded by {@link isOwnPosition} so it can never claim a foreign leg.
 */
async function syncOwnEntryFromMisPosition(
  accessToken: string,
  symbol: string,
  lotSize: number,
): Promise<boolean> {
  if (!isOwnPosition(symbol)) return false;
  const filled = await fetchMisPosition(accessToken, symbol, "MIS");
  if (!filled || filled.quantity <= 0 || filled.average_price <= 0) return false;
  positionLotSize = lotSize;
  tradingsymbol = symbol;
  // Own fills are gone, so the broker is all we have — but if we still know our own quantity it
  // caps what we adopt, and a good entry price is never replaced by the broker's daily blend.
  quantity = quantity > 0 ? Math.min(quantity, filled.quantity) : filled.quantity;
  if (entryPrice <= 0) entryPrice = filled.average_price;
  lastOptionPrice = filled.last_price;
  unrealisedPnl = ownLegUnrealisedPnl(entryPrice, quantity, filled.last_price);
  return true;
}

async function finalizeEntryInPosition(
  accessToken: string,
  dateIst: string,
  resolved: { tradingsymbol: string; instrumentToken: number; lotSize: number },
  attempt: number,
  splitLabel: string,
) {
  if (lastSpot != null && lastSpot > 0) {
    entrySpot = lastSpot;
  } else {
    try {
      const spot = await fetchNiftySpot(accessToken);
      if (spot > 0) {
        entrySpot = spot;
        lastSpot = spot;
      }
    } catch {
      /* required for index exits — retry on next tick */
    }
  }

  if (entrySpot <= 0) {
    pushLog("Nifty spot unavailable at entry — P&L trail exits only", "warning");
  }

  optionInstrumentToken =
    resolved.instrumentToken > 0
      ? resolved.instrumentToken
      : ((await resolveInstrumentToken("NFO", resolved.tradingsymbol, accessToken)) ?? 0);
  if (niftyInstrumentToken > 0) {
    setBotTickerInstruments(
      optionInstrumentToken > 0 ? [niftyInstrumentToken, optionInstrumentToken] : [niftyInstrumentToken],
    );
  }

  phase = "in_position";
  message = `In position · P&L trail ${getPnlTrailScheduleLabel(dateIst)}`;
  pushLog(
    `Entry filled on attempt ${attempt} · ${splitLabel} · ${quantity} qty @ ₹${entryPrice.toFixed(2)}` +
      (entrySpot > 0 ? ` · Nifty spot ${entrySpot.toFixed(2)}` : "") +
      ` · ${exitMode} band (entry only)`,
    "success",
  );
  pushLog(`P&L exit ${getPnlTrailScheduleLabel(dateIst)}`, "info");
  pushLog(getHardStopScheduleLabel(), "info");
  pushLog(
    optionInstrumentToken > 0
      ? `Exit websocket live · Nifty 50 + ${resolved.tradingsymbol}`
      : "Exit websocket live · Nifty 50 (option token missing — P&L uses quote fallback)",
    optionInstrumentToken > 0 ? "success" : "warning",
  );
  pushLog(message, "success");
  saveBotState(dateIst);
}

/** One round of parallel SELL orders for whatever is still open. */
async function squareOffAllSplitOrders(
  accessToken: string,
  symbol: string,
  lotSize: number,
  round: number,
  ownRemainingQty: number,
): Promise<{ average_price: number; filled_quantity: number }[]> {
  const brokerQty = await fetchNetQty(accessToken, symbol);
  if (brokerQty <= 0 || ownRemainingQty <= 0) return [];

  // Momentum scalper may hold lots in this same contract — only ever sell our own.
  const openQty = Math.min(brokerQty, ownRemainingQty);

  const working = round > 1 ? await pendingOrderQuantity(accessToken, symbol, "SELL") : 0;
  const qtyToSell = openQty - working;
  if (qtyToSell <= 0) {
    pushLog(`Exit round ${round} · ${working} qty already working on Kite · waiting`, "info");
    return [];
  }

  const quantities = splitQuantityIntoOrderChunks(qtyToSell, lotSize);
  if (quantities.length === 0) return [];

  pushLog(
    `Exit round ${round} · ${quantities.length} parallel SELL order(s) · max ${getMaxLotsPerOrder()} lots each · ${qtyToSell} qty`,
    "info",
  );

  const { orderIds, failures } = await placeSplitMarketOrders(accessToken, {
    tradingsymbol: symbol,
    transaction_type: "SELL",
    quantities,
  });

  for (const failure of failures) {
    pushLog(`Exit order rejected · ${failure.message}`, "warning");
  }

  const { fills, failures: fillFailures } = await awaitOrderFills(accessToken, orderIds);
  for (const failure of fillFailures) {
    pushLog(`Exit order did not fill · ${failure.message}`, "warning");
  }
  return fills;
}

async function squareOff(accessToken: string, reason: string) {
  if (squareOffInFlight) return;
  // Ticks arrive several times a second — never re-fire orders faster than Kite can settle them.
  if (Date.now() - lastSquareOffAttemptAt < SQUARE_OFF_RETRY_COOLDOWN_MS) return;
  squareOffInFlight = true;
  lastSquareOffAttemptAt = Date.now();
  try {
    await squareOffInner(accessToken, reason);
  } finally {
    squareOffInFlight = false;
  }
}

/**
 * Wrap up a closed trade.
 *
 * The 9:16 leg ends the day with it. The 9:15 leg only clears the decks: the 9:16 decision is
 * still ahead, so the day is not marked as run and the 9:15 open/close captures it depends on
 * are left untouched.
 */
function concludeTrade(
  dateIst: string,
  note: string,
  type: NineSixteenBotStatus["logs"][number]["type"],
) {
  if (tradeSlot !== "nine-fifteen") {
    finishDay(dateIst, note, type);
    return;
  }

  pushLog(note, type);
  nineFifteenSettled = true;
  nineFifteenNote = note;
  // Squaring off in "exiting" skips the exit checks, so this is the other place the overrun can
  // be noticed: a leg that lived past 9:16:00 takes the 9:16 trade down with it.
  if (isPastNineFifteenMinute()) nineFifteenOverranMinute = true;
  tradeSlot = "nine-sixteen";
  phase = "waiting";
  tradingsymbol = null;
  ownedSymbol = null;
  quantity = 0;
  entryPrice = 0;
  positionLotSize = 0;
  entrySpot = 0;
  exitMode = "main";
  leg = null;
  lastOptionPrice = null;
  unrealisedPnl = null;
  lockedPnlPct = 0;
  clearNineFifteenTpTracking();
  lastQuoteRefreshAt = 0;
  lastPositionSyncAt = 0;
  warnedForeignPosition = "";
  optionInstrumentToken = 0;
  if (niftyInstrumentToken > 0) setBotTickerInstruments([niftyInstrumentToken]);
  saveBotState(dateIst);
  message = `${note} · waiting for the 9:16:00 decision`;
}

async function squareOffInner(accessToken: string, reason: string) {
  const dateIst = getIndianMarketContext().dateIST;
  if (!tradingsymbol || quantity <= 0) {
    await persistTradeLog(dateIst, "closed", reason, { exitReason: reason, pnl: unrealisedPnl });
    concludeTrade(dateIst, reason, "success");
    return;
  }

  phase = "exiting";
  message = reason;
  if (tradeSlot !== "nine-fifteen") {
    pushLog(reason, "success");
  }

  const symbol = tradingsymbol;
  const lotSize = positionLotSize > 0 ? positionLotSize : 65;

  if (tradeSlot === "nine-fifteen" && nineFifteenTpOrderIds.length > 0) {
    await cancelNineFifteenTakeProfitOrders(accessToken);
  }

  const brokerQty = await fetchNetQty(accessToken, symbol);
  if (brokerQty <= 0) {
    await persistTradeLog(dateIst, "closed", "Already flat", { exitReason: reason, pnl: unrealisedPnl });
    concludeTrade(dateIst, "Already flat", "info");
    return;
  }

  // Track what *we* still owe, not the broker net — another bot's lots in this contract are none
  // of our business and must survive our square-off.
  let remainingQty = quantity;

  // Keep firing parallel SELL rounds until our own leg is flat — a stuck leg must never be abandoned.
  const fills: { average_price: number; filled_quantity: number }[] = [];
  for (let round = 1; round <= SQUARE_OFF_MAX_ROUNDS && remainingQty > 0; round += 1) {
    try {
      const roundFills = await squareOffAllSplitOrders(
        accessToken,
        symbol,
        lotSize,
        round,
        remainingQty,
      );
      fills.push(...roundFills);
      remainingQty -= roundFills.reduce((sum, fill) => sum + fill.filled_quantity, 0);
    } catch (err) {
      pushLog(
        `Exit round ${round} failed · ${err instanceof Error ? err.message : "unknown"}`,
        "warning",
      );
    }

    // A flat broker position means our leg is gone regardless of what the fill reports said.
    try {
      if ((await fetchNetQty(accessToken, symbol)) <= 0) remainingQty = 0;
    } catch {
      /* unknown — trust our own fill accounting */
    }

    if (remainingQty > 0 && round < SQUARE_OFF_MAX_ROUNDS) {
      pushLog(`Exit incomplete · ${remainingQty} qty still open · retrying`, "warning");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (remainingQty > 0) {
    // Stay in position so the next tick retries; never mark the day done holding stock.
    phase = "in_position";
    message = `EXIT FAILED · ${remainingQty} qty still open · retrying on next tick`;
    pushLog(message, "error");
    saveBotState(dateIst);
    return;
  }

  const exitPrice = weightedAverageFillPrice(fills);
  const closedQty = fills.reduce((sum, fill) => sum + fill.filled_quantity, 0) || quantity;
  const closedEntry = entryPrice;
  const pnl =
    closedEntry > 0 && exitPrice > 0 ? (exitPrice - closedEntry) * closedQty : unrealisedPnl;

  let exitNote = reason;
  if (tradeSlot === "nine-fifteen") {
    if (reason.startsWith("TRADE EXITED")) {
      exitNote = reason;
    } else {
      const via = /hard stop/i.test(reason) ? "hard-stop" : /square-off/i.test(reason) ? "eod" : "market";
      exitNote = formatNineFifteenExitSummary({
        exitPrice: exitPrice > 0 ? exitPrice : null,
        quantity: closedQty,
        entryPrice: closedEntry,
        pnl,
        via,
      });
    }
    message = exitNote;
  } else {
    exitNote = `CLOSED · ${reason}`;
  }

  await persistTradeLog(dateIst, "closed", exitNote, {
    exitPrice: exitPrice > 0 ? exitPrice : null,
    exitSpot: lastSpot,
    pnl,
    exitReason: exitNote,
  });
  concludeTrade(dateIst, exitNote, "success");
}

/**
 * After a partial split fill, buy the missing quantity while the 9:16 window is still open.
 * Re-checks live balance each round so a top-up can never overspend.
 */
async function topUpEntryQuantity(
  accessToken: string,
  resolved: { tradingsymbol: string; lotSize: number },
  targetQuantity: number,
) {
  for (let round = 1; round <= ENTRY_TOP_UP_MAX_ROUNDS; round += 1) {
    if (isPast916EntryWindow()) return;

    const working = await pendingOrderQuantity(accessToken, resolved.tradingsymbol, "BUY");
    const missing = targetQuantity - quantity - working;
    if (missing < resolved.lotSize) return;

    let affordableLots = Math.floor(missing / resolved.lotSize);
    try {
      const ltp = await fetchOptionLtp(accessToken, resolved.tradingsymbol);
      if (ltp > 0) {
        const sizing = await resolveEntryQuantity(accessToken, resolved.lotSize, ltp, {
          maxLots: affordableLots,
        });
        affordableLots = sizing.lots;
      }
    } catch {
      /* quote/balance hiccup — fall back to the missing lots */
    }

    if (affordableLots <= 0) return;

    const chunks = splitLotsIntoOrderChunks(affordableLots).map((lots) => lots * resolved.lotSize);
    pushLog(`Entry top-up round ${round} · ${formatLotSplitLabel(splitLotsIntoOrderChunks(affordableLots))}`, "info");

    const placed = await placeSplitMarketOrders(accessToken, {
      tradingsymbol: resolved.tradingsymbol,
      transaction_type: "BUY",
      quantities: chunks,
    });
    const { fills } = await awaitOrderFills(accessToken, placed.orderIds);
    applyOwnEntryFills(resolved.tradingsymbol, resolved.lotSize, fills);
  }
}

function clearFailedEntryAttempt() {
  tradingsymbol = null;
  quantity = 0;
  entryPrice = 0;
  lastOptionPrice = null;
  unrealisedPnl = null;
  lockedPnlPct = 0;
}

function isRetryableEntryOrderError(message: string): boolean {
  return /REJECTED|CANCELLED|fill timeout|timeout/i.test(message);
}

function isMarginRelatedOrderError(message: string): boolean {
  return /margin|insufficient|fund|balance|required|maximum allowed|quantity limit|exceed.*quantity/i.test(message);
}

function entryRetryDelayMs() {
  return ENTRY_RETRY_DELAY_MS;
}

function resetNineFifteenForDay(dateIst: string) {
  if (nineFifteenDate === dateIst) return;
  nineFifteenDate = dateIst;
  tradeSlot = "nine-sixteen";
  nineFifteenMarkPrice = null;
  nineFifteenMarkAtLabel = null;
  nineFifteenSettled = false;
  nineFifteenOverranMinute = false;
  nineFifteenNote = null;
  nineFifteenPreResolvedPe = null;
  nineFifteenPreResolvedDate = null;
  nineFifteenTimerDate = null;
  clearNineFifteenTpTracking();
}

/** Close the 9:15 attempt without touching the day — the 9:16 decision still gets its turn. */
function settleNineFifteen(note: string, type: NineSixteenBotStatus["logs"][number]["type"]) {
  nineFifteenSettled = true;
  nineFifteenNote = note;
  pushLog(note, type);
  // A leg bought on the 9:15 rules keeps them. Re-labelling an open position here — which an
  // error thrown after the fill would otherwise do — would hand it to the 9:16 index exits.
  if (quantity > 0 && tradingsymbol) {
    if (phase === "entering") phase = "in_position";
    return;
  }
  if (phase === "entering") phase = "waiting";
  tradeSlot = "nine-sixteen";
  message = `${note} · waiting for 9:16:00`;
}

/** Attempt 1 uses the leg resolved at 9:15:05; retries re-resolve against the live spot. */
async function resolveNineFifteenOption(
  accessToken: string,
  attempt: number,
  dateIst: string,
): Promise<ResolvedAtmOption | null> {
  if (attempt === 1 && nineFifteenPreResolvedDate === dateIst && nineFifteenPreResolvedPe) {
    return nineFifteenPreResolvedPe;
  }
  return resolveAtmNiftyOption(accessToken, "PE_BUY", {
    spotPrice: lastSpot != null && lastSpot > 0 ? lastSpot : undefined,
  });
}

async function finalizeNineFifteenEntry(
  accessToken: string,
  dateIst: string,
  resolved: { tradingsymbol: string; instrumentToken: number; lotSize: number },
  attempt: number,
  splitLabel: string,
) {
  if (lastSpot != null && lastSpot > 0) entrySpot = lastSpot;

  // The position is already live, so nothing past this point may throw its way out of being
  // booked — a missing option token only costs the tick feed, which the quote poll covers.
  phase = "in_position";
  tradeSlot = "nine-fifteen";
  try {
    optionInstrumentToken =
      resolved.instrumentToken > 0
        ? resolved.instrumentToken
        : ((await resolveInstrumentToken("NFO", resolved.tradingsymbol, accessToken)) ?? 0);
  } catch {
    optionInstrumentToken = 0;
  }
  if (niftyInstrumentToken > 0) {
    setBotTickerInstruments(
      optionInstrumentToken > 0 ? [niftyInstrumentToken, optionInstrumentToken] : [niftyInstrumentToken],
    );
  }

  nineFifteenSettled = true;
  message = `In 9:15 position · ${getNineFifteenLadderLabel()}`;
  pushLog(
    `9:15 entry filled on attempt ${attempt} · ${splitLabel} · ${quantity} qty @ ₹${entryPrice.toFixed(2)}`,
    "success",
  );
  pushLog(getNineFifteenLadderLabel(), "info");
  pushLog(getHardStopScheduleLabel(), "info");
  try {
    await placeNineFifteenTakeProfitOrders(accessToken, dateIst);
  } catch (err) {
    pushLog(
      `9:15 TP limit placement failed · ${err instanceof Error ? err.message : "unknown"} · market backup at +${NINE_FIFTEEN_TAKE_PROFIT_PCT}% remains active`,
      "warning",
    );
  }
  saveBotState(dateIst);
}

/**
 * The 9:15 trade: read the minute five seconds in and buy the ATM PE at 9:15:06 if it is red.
 *
 * Nothing in here ends the day. Whether it trades, skips or fails to fill, the 9:16 decision is
 * still taken at 9:16:00 — the only thing that stops it is this leg still being open by then.
 */
async function tryEnterNineFifteen(accessToken: string, dateIst: string) {
  sealNineFifteenMark();

  const open = capturedOpen915;
  if (open == null || open <= 0) {
    settleNineFifteen("9:15 trade skipped · no open tick in 9:15:00–9:15:15", "warning");
    return;
  }
  if (nineFifteenMarkPrice == null) {
    settleNineFifteen("9:15 trade skipped · no Nifty tick before 9:15:05", "warning");
    return;
  }

  const decision = decideNineFifteenEntry(open, nineFifteenMarkPrice);
  if (decision.action === "skip") {
    settleNineFifteen(`9:15 trade skipped · ${decision.reason}`, "info");
    return;
  }

  phase = "entering";
  tradeSlot = "nine-fifteen";
  leg = "PE_BUY";
  open915 = open;
  clearFailedEntryAttempt();
  message = "Placing 9:15:06 PE entry…";
  pushLog(
    `9:15 RED · ${decision.dropPts.toFixed(2)} pts below the open at the 5s mark → buying the ATM PE`,
    "success",
  );
  await assertEgressReadyForEntry();

  let attempt = 0;
  let maxLotsCap: number | undefined;
  let lastAttemptLots = 0;
  let lastFailure = "";

  while (!isPastNineFifteenEntryWindow()) {
    attempt += 1;
    try {
      const resolved = await resolveNineFifteenOption(accessToken, attempt, dateIst);
      if (!resolved) throw new Error("ATM PE not found");

      const optionLtp = await fetchOptionLtp(accessToken, resolved.tradingsymbol);
      if (optionLtp <= 0) throw new Error("Option LTP unavailable for sizing");

      const sizing = await resolveEntryQuantity(accessToken, resolved.lotSize, optionLtp, {
        maxLots: maxLotsCap,
      });
      if (sizing.lots <= 0 || sizing.quantity <= 0) {
        lastFailure = `balance too low for 1 lot · need ~₹${Math.ceil(sizing.costPerLot)} · available ₹${Math.floor(sizing.availableBalance)}`;
        break;
      }

      lastAttemptLots = sizing.lots;
      const lotChunks = splitLotsIntoOrderChunks(sizing.lots);
      const splitLabel = formatLotSplitLabel(lotChunks);
      pushLog(
        `9:15 entry attempt ${attempt} · PE ${resolved.tradingsymbol} @ ₹${optionLtp.toFixed(2)} · ${splitLabel}`,
        attempt === 1 ? "success" : "info",
      );

      ownedSymbol = resolved.tradingsymbol;
      const placed = await placeSplitMarketOrders(accessToken, {
        tradingsymbol: resolved.tradingsymbol,
        transaction_type: "BUY",
        quantities: lotChunks.map((lots) => lots * resolved.lotSize),
      });
      for (const failure of placed.failures) {
        pushLog(`9:15 entry order rejected · ${failure.message}`, "warning");
      }

      const { fills, failures: fillFailures } = await awaitOrderFills(accessToken, placed.orderIds);
      if (fills.length === 0) {
        throw fillFailures[0] ?? placed.failures[0] ?? new Error("All 9:15 entry orders failed");
      }
      clearKiteRejectedIp();
      if (!applyOwnEntryFills(resolved.tradingsymbol, resolved.lotSize, fills)) {
        throw new Error("9:15 entry orders reported no filled quantity");
      }

      await finalizeNineFifteenEntry(accessToken, dateIst, resolved, attempt, splitLabel);
      return;
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : "Entry failed";
      if (isMarginRelatedOrderError(lastFailure) && lastAttemptLots > 0) {
        maxLotsCap = lastAttemptLots - 1;
      } else if (/REJECTED/i.test(lastFailure) && lastAttemptLots > 1) {
        maxLotsCap = lastAttemptLots - 1;
      }
      pushLog(`9:15 entry attempt ${attempt} failed · ${lastFailure}`, "warning");
      if (!isRetryableEntryOrderError(lastFailure) && !/LTP unavailable|ATM PE not found/i.test(lastFailure)) {
        break;
      }
      if (isPastNineFifteenEntryWindow()) break;
      await new Promise((resolve) => setTimeout(resolve, entryRetryDelayMs()));
    }
  }

  // A BUY can fill even when the attempt around it threw, so never walk away from the claimed
  // contract on the word of an exception alone — ask Kite before giving the slot up.
  if (ownedSymbol) {
    const symbol = ownedSymbol;
    const adopted = await syncOwnEntryFromMisPosition(accessToken, symbol, positionLotSize || 0).catch(
      () => false,
    );
    if (adopted && quantity > 0) {
      await finalizeNineFifteenEntry(
        accessToken,
        dateIst,
        { tradingsymbol: symbol, instrumentToken: 0, lotSize: positionLotSize },
        attempt,
        "recovered from Kite after a failed attempt",
      );
      return;
    }
    ownedSymbol = null;
  }

  clearFailedEntryAttempt();
  leg = null;
  settleNineFifteen(`9:15 trade not taken · ${lastFailure || "entry window closed"}`, "warning");
}

async function tryEnter(accessToken: string, dateIst: string) {
  phase = "entering";
  message = "Placing 9:16:00 entry…";
  clearFailedEntryAttempt();

  if (nineFifteenOverranMinute) {
    const note = "SKIPPED · the 9:15 trade was still open at 9:16:00";
    await persistTradeLog(dateIst, "skipped", note, { exitReason: note });
    finishDay(dateIst, note, "warning");
    return;
  }

  if (capturedOpen915 == null || capturedClose915 == null) {
    throw new Error("Missing captured 9:15 open/close — cannot enter");
  }

  const bar = build915BarFromCaptured(
    capturedOpen915,
    capturedClose915,
    capturedHigh915 ?? Math.max(capturedOpen915, capturedClose915),
    capturedLow915 ?? Math.min(capturedOpen915, capturedClose915),
  );
  if (!bar) throw new Error("Invalid captured 9:15 open/close");

  open915 = bar.open;
  pushLog(
    `9:16:00 entry check · 9:15:00 open ${bar.open.toFixed(2)} · 9:15:59 close ${bar.close.toFixed(2)} (WS ticks) · Δ ${bar.change.toFixed(2)} (${bar.direction})`,
    "info",
  );
  const entryDecision = decide915Entry(bar);
  if (entryDecision.action === "skip") {
    const skipNote = `SKIPPED · ${entryDecision.reason} · open ${bar.open.toFixed(2)} · close ${bar.close.toFixed(2)} · Δ ${bar.change.toFixed(2)}`;
    pushLog(skipNote, "warning");
    await persistTradeLog(dateIst, "skipped", skipNote, { exitReason: entryDecision.reason });
    finishDay(dateIst, skipNote, "warning");
    return;
  }

  const nextLeg = entryDecision.leg;
  exitMode = entryDecision.exitMode;
  leg = nextLeg;
  await assertEgressReadyForEntry();

  const modeLabel =
    exitMode === "near_miss" ? "near-miss exits (±20→±10@10:01)" : "main exits (±25→±20@10:01→±15@11:01)";

  let attempt = 0;
  let maxLotsCap: number | undefined;
  let lastAttemptLots = 0;
  let lastFailure = "";

  while (!isPast916EntryWindow()) {
    attempt += 1;
    clearFailedEntryAttempt();
    message = attempt === 1 ? "Placing 9:16:00 entry…" : `Retrying entry (${attempt}) until 9:16:30…`;

    try {
      const resolved = await resolveEntryOption(accessToken, nextLeg, attempt, dateIst);
      if (!resolved) throw new Error("ATM option not found");

      const optionLtp = await fetchOptionLtp(accessToken, resolved.tradingsymbol);
      if (optionLtp <= 0) throw new Error("Option LTP unavailable for sizing");

      const sizing = await resolveEntryQuantity(accessToken, resolved.lotSize, optionLtp, {
        maxLots: maxLotsCap,
      });
      if (sizing.lots <= 0 || sizing.quantity <= 0) {
        lastFailure = `balance too low for 1 lot · need ~₹${Math.ceil(sizing.costPerLot)} · available ₹${Math.floor(sizing.availableBalance)}`;
        pushLog(`Entry attempt ${attempt} · ${lastFailure} · retrying with fresh LTP…`, "warning");
        await new Promise((resolve) => setTimeout(resolve, entryRetryDelayMs()));
        continue;
      }

      lastAttemptLots = sizing.lots;
      const lotChunks = splitLotsIntoOrderChunks(sizing.lots);
      const splitLabel = formatLotSplitLabel(lotChunks);

      pushLog(
        `Entry attempt ${attempt} · ${legLabel(nextLeg)} ${resolved.tradingsymbol} @ ₹${optionLtp.toFixed(2)} · ${modeLabel} · ${splitLabel} · ₹${Math.floor(sizing.availableBalance)} avail`,
        attempt === 1 ? "success" : "info",
      );

      // Never double-buy *our own* leg after a partially-completed attempt. A leg opened by
      // momentum scalper is not a duplicate of ours, so it must not short-circuit this entry.
      const existingBeforeOrders = await findOpenNiftyMisOption(accessToken);
      if (
        existingBeforeOrders &&
        existingBeforeOrders.quantity > 0 &&
        isOwnPosition(existingBeforeOrders.tradingsymbol)
      ) {
        const existingSymbol = existingBeforeOrders.tradingsymbol;
        if (!(await syncOwnEntryFromMisPosition(accessToken, existingSymbol, resolved.lotSize))) {
          throw new Error("Open MIS position on Kite but could not sync entry");
        }
        leg = existingSymbol.endsWith("PE") ? "PE_BUY" : "CE_BUY";
        await finalizeEntryInPosition(
          accessToken,
          dateIst,
          { ...resolved, tradingsymbol: existingSymbol, instrumentToken: 0 },
          attempt,
          `resumed own open position (${quantity} qty)`,
        );
        return;
      }

      const orderQuantities = lotChunks.map((lots) => lots * resolved.lotSize);
      // Claim the contract before the first BUY leaves, so a crash mid-entry still recovers.
      ownedSymbol = resolved.tradingsymbol;
      const placed = await placeSplitMarketOrders(accessToken, {
        tradingsymbol: resolved.tradingsymbol,
        transaction_type: "BUY",
        quantities: orderQuantities,
      });
      for (const failure of placed.failures) {
        pushLog(`Entry order rejected at placement · ${failure.message}`, "warning");
      }

      const { fills, failures: fillFailures } = await awaitOrderFills(accessToken, placed.orderIds);

      if (fills.length === 0) {
        const firstErr = fillFailures[0] ?? placed.failures[0];
        throw firstErr ?? new Error("All split entry orders failed");
      }

      clearKiteRejectedIp();

      if (!applyOwnEntryFills(resolved.tradingsymbol, resolved.lotSize, fills)) {
        throw new Error("Split entry orders reported no filled quantity");
      }

      const rejectedCount = placed.failures.length + fillFailures.length;
      if (rejectedCount > 0) {
        pushLog(
          `Partial entry · ${fills.length}/${orderQuantities.length} orders filled · ${quantity} qty · topping up before 9:16:30`,
          "warning",
        );
        await topUpEntryQuantity(accessToken, resolved, sizing.quantity);
      }

      await finalizeEntryInPosition(accessToken, dateIst, resolved, attempt, splitLabel);
      return;
    } catch (err) {
      clearFailedEntryAttempt();
      lastFailure = err instanceof Error ? err.message : "Entry failed";

      if (isMarginRelatedOrderError(lastFailure) && lastAttemptLots > 0) {
        maxLotsCap = lastAttemptLots - 1;
      } else if (/REJECTED/i.test(lastFailure) && lastAttemptLots > 1) {
        maxLotsCap = lastAttemptLots - 1;
      }

      if (!isRetryableEntryOrderError(lastFailure) && !/LTP unavailable|ATM option not found/i.test(lastFailure)) {
        throw err;
      }

      pushLog(`Entry attempt ${attempt} failed · ${lastFailure} · retrying with fresh ATM LTP…`, "warning");
      if (isPast916EntryWindow()) break;
      await new Promise((resolve) => setTimeout(resolve, entryRetryDelayMs()));
    }
  }

  clearFailedEntryAttempt();
  const note =
    attempt > 0
      ? `NO ENTRY · ${lastFailure || "Order failed"} · ${attempt} attempt(s) before 9:16:30`
      : "NO ENTRY · Missed 9:16 entry window";
  pushLog(note, "warning");
  await persistTradeLog(dateIst, "no_entry", note);
  finishDay(dateIst, note, "warning");
}

function purgeStaleIpErrorLogs() {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const entry = logs[i];
    if (
      entry.type === "error" &&
      /Kite blocked IP|IPv6|not whitelisted/i.test(entry.message)
    ) {
      logs.splice(i, 1);
    }
  }
}

async function refreshLiveQuotes(accessToken: string, dateIst: string) {
  if (quoteRefreshInFlight) return;
  quoteRefreshInFlight = true;
  try {
    await refreshLiveQuotesInner(accessToken, dateIst);
  } finally {
    quoteRefreshInFlight = false;
  }
}

async function refreshLiveQuotesInner(accessToken: string, dateIst: string) {
  let synced = false;
  const now = Date.now();
  const syncPosition = now - lastPositionSyncAt >= 5000;

  if (syncPosition && tradingsymbol && isOwnPosition(tradingsymbol)) {
    try {
      const pos = await fetchMisPosition(accessToken, tradingsymbol, "MIS");
      if (pos) {
        applyOwnPositionSync(pos);
        lastPositionSyncAt = now;
        synced = true;
      }
    } catch {
      /* keep last known qty/entry */
    }
  }

  if (tradingsymbol) {
    try {
      const { niftySpot, optionLtp } = await fetchNiftyAndOptionQuotes(accessToken, tradingsymbol);
      if (niftySpot > 0) {
        lastSpot = niftySpot;
        synced = true;
      }
      if (optionLtp > 0) {
        lastOptionPrice = optionLtp;
        synced = true;
      }
    } catch {
      try {
        const spot = await fetchNiftySpot(accessToken);
        if (spot > 0) {
          lastSpot = spot;
          synced = true;
        }
      } catch {
        /* spot quote optional */
      }
      try {
        const ltp = await fetchOptionLtp(accessToken, tradingsymbol);
        if (ltp > 0) {
          lastOptionPrice = ltp;
          synced = true;
        }
      } catch {
        /* keep last LTP */
      }
    }
  } else {
    try {
      const spot = await fetchNiftySpot(accessToken);
      if (spot > 0) {
        lastSpot = spot;
        synced = true;
      }
    } catch {
      /* spot quote optional for display */
    }
  }

  if (entryPrice > 0 && lastOptionPrice != null && lastOptionPrice > 0 && quantity > 0) {
    unrealisedPnl = (lastOptionPrice - entryPrice) * quantity;
  }

  if (synced) {
    lastQuoteRefreshAt = now;
    clearKiteRejectedIp();
    purgeStaleIpErrorLogs();
  }

  saveBotState(dateIst);
}

async function maybeHardStopExit(accessToken: string, slotLabel: string): Promise<boolean> {
  if (entrySpot <= 0 || lastSpot == null || lastSpot <= 0 || !leg) return false;
  if (!shouldHardStopNineSixteen(lastSpot, entrySpot, leg)) return false;

  const stopSpot = computeHardStopSpot(entrySpot, leg);
  await squareOff(
    accessToken,
    `${slotLabel} hard stop at ${getHardStopStartLabel()} · Nifty ${lastSpot.toFixed(2)} is ` +
      `${NINE_SIXTEEN_HARD_STOP_INDEX_POINTS} pts adverse from entry ${entrySpot.toFixed(2)} ` +
      `(stop ${stopSpot.toFixed(2)})`,
  );
  return true;
}

async function checkAndMaybeExitNineFifteen(accessToken: string, dateIst: string): Promise<boolean> {
  // The main loop hands every pass to the position while one is open, so sealing the 9:15 close
  // has to happen here too — otherwise a leg held across 9:16:00 leaves the candle unrecorded.
  if (isReadyToSeal915Close()) seal915CloseFromTicks(dateIst);

  if (!nineFifteenOverranMinute && isPastNineFifteenMinute()) {
    nineFifteenOverranMinute = true;
    pushLog("9:15 leg still open at 9:16:00 · the 9:16 trade is skipped today", "warning");
  }

  if (isPastNineSixteenForceExit()) {
    await squareOff(accessToken, "End of day square-off");
    return true;
  }

  if (await maybeHardStopExit(accessToken, "9:15")) return true;

  await syncNineFifteenTakeProfitOrders(accessToken, dateIst);

  if (tradingsymbol && quantity > 0) {
    try {
      const brokerQty = await fetchNetQty(accessToken, tradingsymbol);
      if (brokerQty <= 0) {
        await completeNineFifteenTakeProfitExit(accessToken, dateIst, "limit");
        return true;
      }
      if (brokerQty < quantity) {
        quantity = brokerQty;
        saveBotState(dateIst);
        if (nineFifteenTpOrderIds.length > 0) {
          await placeNineFifteenTakeProfitOrders(accessToken, dateIst);
        }
      }
    } catch {
      /* position poll optional */
    }
  }

  const legPnl = ownLegUnrealisedPnl(entryPrice, quantity, lastOptionPrice);
  if (shouldExitNineFifteenTakeProfit(legPnl, entryPrice, quantity)) {
    await cancelNineFifteenTakeProfitOrders(accessToken);
    await squareOff(
      accessToken,
      formatNineFifteenExitSummary({
        exitPrice: nineFifteenTpLimitPrice > 0 ? nineFifteenTpLimitPrice : lastOptionPrice,
        quantity,
        entryPrice,
        pnl: legPnl,
        via: "market",
      }),
    );
    return true;
  }

  return false;
}

async function checkAndMaybeExit(accessToken: string, _dateIst: string): Promise<boolean> {
  if (phase !== "in_position") return false;

  if (tradeSlot === "nine-fifteen") {
    return checkAndMaybeExitNineFifteen(accessToken, _dateIst);
  }

  if (isPastNineSixteenForceExit()) {
    await squareOff(accessToken, "End of day square-off");
    return true;
  }

  if (await maybeHardStopExit(accessToken, "9:16")) return true;

  // Trailing option P&L % — plus the 10:00 ±30 Nifty hard stop above.
  const legPnl = ownLegUnrealisedPnl(entryPrice, quantity, lastOptionPrice);
  const pnlPct = pnlPctOfEntryCost(legPnl, entryPrice, quantity);
  if (pnlPct == null) return false;
  if (!isPlausiblePnlPct(pnlPct)) {
    pushLog(
      `Ignoring implausible P&L reading ${pnlPct.toFixed(1)}% · ladder held at +${lockedPnlPct}%`,
      "warning",
    );
    return false;
  }

  const previousLocked = lockedPnlPct;
  lockedPnlPct = nextLockedPnlPct(lockedPnlPct, pnlPct, _dateIst);
  if (lockedPnlPct > previousLocked) {
    pushLog(
      `Trailing ladder → locked SL +${lockedPnlPct}% · next TP +${trailingPnlTargetPct(lockedPnlPct, _dateIst)}%` +
        ` (P&L +${pnlPct.toFixed(2)}%)`,
      "success",
    );
    saveBotState(_dateIst);
  }

  if (shouldExitOnTrailingPnl(lockedPnlPct, pnlPct)) {
    const entryAmount = entryPrice * quantity;
    const reason = shouldInstantExitTrailingPnl(pnlPct)
      ? `9:16 +${NINE_SIXTEEN_PNL_INSTANT_EXIT_PCT}% instant exit · P&L +${pnlPct.toFixed(2)}% · ` +
        `₹${Math.round(legPnl ?? 0)} on ₹${Math.round(entryAmount)}`
      : `9:16 trailing stop · fell below locked +${lockedPnlPct}% (now +${pnlPct.toFixed(2)}% · ` +
        `₹${Math.round(legPnl ?? 0)} on ₹${Math.round(entryAmount)})`;
    await squareOff(accessToken, reason);
    return true;
  }

  return false;
}

async function evaluateLiveExits() {
  if (phase !== "in_position" || squareOffInFlight) return;
  const session = loadKiteSession();
  if (!session?.accessToken) return;
  await checkAndMaybeExit(session.accessToken, getIndianMarketContext().dateIST);
}

async function tickInPosition(accessToken: string, dateIst: string) {
  await ensureNiftyTicker(accessToken, dateIst);
  if (tradingsymbol && optionInstrumentToken <= 0) {
    optionInstrumentToken = (await resolveInstrumentToken("NFO", tradingsymbol, accessToken)) ?? 0;
    if (niftyInstrumentToken > 0 && optionInstrumentToken > 0) {
      setBotTickerInstruments([niftyInstrumentToken, optionInstrumentToken]);
    }
  }

  if (!isKiteTickerConnected()) {
    const pollMs = getNineSixteenSpotPollMs();
    if (Date.now() - lastQuoteRefreshAt >= pollMs) {
      await refreshLiveQuotes(accessToken, dateIst);
    }
  } else if (Date.now() - lastPositionSyncAt >= 5000 && tradingsymbol && isOwnPosition(tradingsymbol)) {
    try {
      const pos = await fetchMisPosition(accessToken, tradingsymbol, "MIS");
      if (pos) {
        applyOwnPositionSync(pos);
        lastPositionSyncAt = Date.now();
        // No option tick feed (token unresolved) — positions LTP keeps the P&L exit alive.
        if (optionInstrumentToken <= 0 && pos.last_price > 0) {
          lastOptionPrice = pos.last_price;
        }
        if (lastOptionPrice != null && lastOptionPrice > 0 && entryPrice > 0 && quantity > 0) {
          unrealisedPnl = (lastOptionPrice - entryPrice) * quantity;
        }
        saveBotState(dateIst);
      }
    } catch {
      /* keep last known qty/entry */
    }
  }

  await checkAndMaybeExit(accessToken, dateIst);
}

async function mainLoop() {
  if (loopBusy) return;
  loopBusy = true;

  try {
    const ctx = getIndianMarketContext();
    resetNineFifteenForDay(ctx.dateIST);

    if (ctx.sessionStatus === "closed_weekend") {
      haltBotTicker();
      phase = "waiting";
      message = "Weekend — resumes Monday";
      return;
    }

    if (isPastBotWsHours() && phase !== "in_position" && phase !== "exiting") {
      haltBotTicker();
    }

    if (phase === "done" && !hasRanToday(ctx.dateIST) && ctx.sessionStatus !== "post_market") {
      phase = "waiting";
      open915 = 0;
      entrySpot = 0;
      exitMode = "main";
      leg = null;
      tradingsymbol = null;
      ownedSymbol = null;
      warnedForeignPosition = "";
      quantity = 0;
      clearCaptures(ctx.dateIST);
      message = "New session — waiting for Kite websocket 9:15 ticks";
    }

    const sessionEarly = loadKiteSession();

    if (hasRanToday(ctx.dateIST) && phase !== "in_position" && phase !== "exiting") {
      phase = "done";
      if (isInBotWsHours() && sessionEarly?.accessToken) {
        // Safety net for a failed exit of *our* leg. Legs opened by another bot are skipped.
        let recoveredPosition = false;
        try {
          await reconcilePositionWithKite(sessionEarly.accessToken, ctx.dateIST);
          recoveredPosition = (phase as NineSixteenBotPhase) === "in_position";
        } catch {
          /* transient Kite glitch — retry next loop */
        }
        if (recoveredPosition) {
          await tickInPosition(sessionEarly.accessToken, ctx.dateIST);
          return;
        }
        await ensureNiftyTicker(sessionEarly.accessToken, ctx.dateIST);
        message = isKiteTickerConnected()
          ? "Session complete · websocket live until 16:00"
          : "Session complete · keeping websocket until 16:00";
      } else if (isPastBotWsHours()) {
        haltBotTicker();
        message = "Session complete · websocket off after 16:00";
      } else {
        message = "Session complete for today";
      }
      return;
    }

    const session = sessionEarly;
    if (!session) {
      phase = "waiting";
      message = "Connect Kite in the app before 9:15 (daily login required)";
      return;
    }

    loadCaptures(ctx.dateIST);

    // Pre-open: skip reconcile/finishDay so overnight token errors cannot burn the day.
    if (ctx.sessionStatus === "pre_market") {
      if (kiteSessionAgeHours(session) > 23) {
        phase = "waiting";
        message = "Kite session stale — reconnect in Settings before 9:15";
        return;
      }
      await ensureNiftyTicker(session.accessToken, ctx.dateIST);
      if (enabled) maintainEntryReadiness(session.accessToken, ctx.dateIST);
      phase = "waiting";
      const waitMs = msUntilNextEntryPhase(false);
      if (!enabled) {
        message = isInBotWsHours()
          ? isKiteTickerConnected()
            ? "9:16 trading disabled · websocket live · waiting for 9:15 ticks"
            : `9:16 trading disabled · connecting websocket · ${Math.ceil(waitMs / 1000)}s`
          : `9:16 trading disabled · websocket connects at 9:00 · ${Math.ceil(waitMs / 1000)}s`;
      } else {
        message = isInBotWsHours()
          ? isKiteTickerConnected()
            ? "Websocket live · waiting for first Nifty tick in 9:15:00–9:15:15"
            : `Connecting Kite websocket · ${Math.ceil(waitMs / 1000)}s`
          : `Waiting to connect Kite websocket at 9:00:00 · ${Math.ceil(waitMs / 1000)}s`;
      }
      return;
    }

    try {
      // 9:15:58–9:16:30: /portfolio/positions stays off the wire so it cannot delay the order.
      // tryEnter still calls findOpenNiftyMisOption before every order, so a stray open leg
      // is caught either way.
      if (!isInNineSixteenBurst()) {
        await reconcilePositionWithKite(session.accessToken, ctx.dateIST);
      }
    } catch (err) {
      const note = err instanceof Error ? err.message : "Reconcile failed";
      // Transient HTML/JSON glitches must not block WS capture or 9:16:00 entry
      if (/HTML instead of JSON|non-JSON|empty body|Unexpected token|is not valid JSON|502|503|504|429/i.test(note)) {
        pushLog(`Reconcile deferred (Kite glitch): ${note}`, "warning");
      } else if (/api_key|access_token|TokenException|Incorrect/i.test(note)) {
        phase = "waiting";
        message = "Kite session invalid — reconnect in Settings before 9:15";
        pushLog(message, "warning");
        return;
      } else {
        throw err;
      }
    }

    if (kiteSessionAgeHours(session) > 23) {
      phase = "waiting";
      message = "Kite session stale — reconnect in Settings before 9:15";
      return;
    }

    if (ctx.sessionStatus === "post_market") {
      if (phase === "in_position") {
        await tickInPosition(session.accessToken, ctx.dateIST);
      } else if (phase !== "done") {
        if (enabled) {
          await persistTradeLog(ctx.dateIST, "no_entry", "NO ENTRY · Market closed");
          finishDay(ctx.dateIST, "NO ENTRY · Market closed", "info");
        } else {
          phase = "done";
          message = "9:16 trading disabled · market closed";
        }
      }
      return;
    }

    if (phase === "in_position" || phase === "exiting") {
      await tickInPosition(session.accessToken, ctx.dateIST);
      return;
    }

    if (isPast916EntryWindow()) {
      if (!enabled) {
        await ensureNiftyTicker(session.accessToken, ctx.dateIST);
        phase = "done";
        message = isKiteTickerConnected()
          ? "9:16 trading disabled · websocket live until 16:00"
          : "9:16 trading disabled · keeping websocket until 16:00";
        return;
      }
      await persistTradeLog(ctx.dateIST, "no_entry", "NO ENTRY · Missed 9:16 entry window");
      finishDay(ctx.dateIST, "NO ENTRY · Missed 9:16 entry window", "warning");
      return;
    }

    await ensureNiftyTicker(session.accessToken, ctx.dateIST);
    if (enabled) maintainEntryReadiness(session.accessToken, ctx.dateIST);

    if (nineFifteenEnabled && !nineFifteenSettled) {
      if (isReadyForNineFifteenPreResolve()) {
        void preResolveNineFifteenPe(session.accessToken, ctx.dateIST).catch(() => {
          /* logged inside */
        });
      }
      // Backstop for the 9:15:06.000 timer — a poll that gets here first still enters on time.
      if (isReadyForNineFifteenEntry()) {
        await tryEnterNineFifteen(session.accessToken, ctx.dateIST);
        return;
      }
      if (isPastNineFifteenEntryWindow()) {
        settleNineFifteen("9:15 trade skipped · past the 9:15:20 entry window", "info");
      }
    }

    if (isReadyToSeal915Close()) {
      seal915CloseFromTicks(ctx.dateIST);
    }

    const has915Ohlc =
      capturedOpen915 != null &&
      capturedOpen915 > 0 &&
      capturedClose915 != null &&
      capturedClose915 > 0;

    if (enabled && has915Ohlc && (isReadyFor916Entry() || phase === "entering") && !isPast916EntryWindow()) {
      await tryEnter(session.accessToken, ctx.dateIST);
      return;
    }

    if (enabled && isReadyFor916Entry() && !has915Ohlc) {
      const reason =
        capturedOpen915 == null || capturedOpen915 <= 0
          ? "NO ENTRY · No 9:15:00 open tick between 9:15:00–9:15:15"
          : "NO ENTRY · No 9:15:59 close tick before 9:16:00";
      pushLog(reason, "warning");
      await persistTradeLog(ctx.dateIST, "no_entry", reason);
      finishDay(ctx.dateIST, reason, "warning");
      return;
    }

    phase = "waiting";
    const waitMs = msUntilNextEntryPhase(has915Ohlc);
    if (!enabled) {
      message = isKiteTickerConnected()
        ? "9:16 trading disabled · websocket live · capturing 9:15 ticks"
        : isInBotWsHours()
          ? "9:16 trading disabled · connecting websocket"
          : `9:16 trading disabled · websocket connects at 9:00 · ${Math.ceil(waitMs / 1000)}s`;
    } else if (!isInBotWsHours()) {
      message = `Waiting to connect Kite websocket at 9:00:00 · ${Math.ceil(waitMs / 1000)}s`;
    } else if (capturedOpen915 == null || capturedOpen915 <= 0) {
      message = isKiteTickerConnected()
        ? "Websocket live · waiting for first Nifty tick in 9:15:00–9:15:15"
        : `Connecting Kite websocket · ${Math.ceil(waitMs / 1000)}s`;
    } else if (capturedClose915 == null || capturedClose915 <= 0) {
      message = `Open ${capturedOpen915.toFixed(2)} · waiting for last tick before 9:16:00`;
    } else {
      message = `9:15 WS OHLC ready · waiting for 9:16:00 entry · ${Math.ceil(waitMs / 1000)}s`;
    }
  } catch (err) {
    await handleBotLoopError(err);
  } finally {
    loopBusy = false;
  }
}

/** Shared recovery for both the poll loop and the 9:16:00 entry burst. */
async function handleBotLoopError(err: unknown) {
  const wasEntering = phase === "entering";
  const holdsPosition =
    phase === "in_position" ||
    phase === "exiting" ||
    (Boolean(tradingsymbol) && entryPrice > 0 && quantity > 0);
  phase = "error";
  message = err instanceof Error ? err.message : "Bot error";
  pushLog(message, "error");
  const authFail = /api_key|access_token|TokenException|Incorrect/i.test(message);
  // Auth failures are recoverable with daily login — never burn the trading day.
  if (authFail) {
    phase = holdsPosition ? "in_position" : "waiting";
    message = "Kite session invalid — reconnect in Settings before 9:15";
    return;
  }
  // An open leg must keep being managed until it is squared off.
  if (holdsPosition) {
    phase = "in_position";
    message = `Recovering · ${message}`;
    return;
  }
  if (isPast916EntryWindow()) {
    await persistTradeLog(getIndianMarketContext().dateIST, "error", message);
    finishDay(getIndianMarketContext().dateIST, message, "error");
  } else if (wasEntering || (entryPrice <= 0 && isReadyFor916Entry())) {
    clearFailedEntryAttempt();
    phase = "entering";
  } else {
    phase = "waiting";
  }
}

/**
 * Seal the 9:15 close and place the entry the instant 9:16:00 arrives. The poll loop wakes on
 * a 50–250ms cadence, and that lag lands directly on the order timestamp.
 */
async function runEntryBurst() {
  if (!enabled || entryBurstInFlight) return;

  // A poll iteration may already be mid-flight; wait it out so entry cannot fire twice.
  for (let i = 0; i < 40 && loopBusy; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (loopBusy) {
    pushLog("9:16:00 timer yielded to in-flight poll · entry continues on the poll loop", "warning");
    return;
  }

  const ctx = getIndianMarketContext();
  if (ctx.sessionStatus === "closed_weekend" || ctx.sessionStatus === "post_market") return;
  if (phase === "in_position" || phase === "exiting" || phase === "done") return;
  if (isPast916EntryWindow() || hasRanToday(ctx.dateIST)) return;

  const session = loadKiteSession();
  if (!session?.accessToken) return;

  entryBurstInFlight = true;
  loopBusy = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  try {
    seal915CloseFromTicks(ctx.dateIST);
    if (
      capturedOpen915 == null ||
      capturedOpen915 <= 0 ||
      capturedClose915 == null ||
      capturedClose915 <= 0
    ) {
      // No usable 9:15 bar — the poll loop logs the NO ENTRY reason on its next pass.
      return;
    }
    await tryEnter(session.accessToken, ctx.dateIST);
  } catch (err) {
    await handleBotLoopError(err);
  } finally {
    loopBusy = false;
    entryBurstInFlight = false;
    scheduleNext();
  }
}

/**
 * Fire the 9:15 entry the instant 9:15:06 arrives, rather than on the next 250ms poll.
 *
 * Errors are swallowed into a settled 9:15 attempt instead of the shared bot error handler: a
 * failure on this leg must not leave the bot in a state that costs it the 9:16 trade.
 */
async function runNineFifteenEntryBurst() {
  if (!nineFifteenEnabled || nineFifteenBurstInFlight || nineFifteenSettled) return;

  // A poll iteration may already be mid-flight; wait it out so entry cannot fire twice.
  for (let i = 0; i < 40 && loopBusy; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (loopBusy) {
    pushLog("9:15:06 timer yielded to in-flight poll · entry continues on the poll loop", "warning");
    return;
  }

  const ctx = getIndianMarketContext();
  if (ctx.sessionStatus === "closed_weekend" || ctx.sessionStatus === "post_market") return;
  if (phase === "in_position" || phase === "exiting" || phase === "done") return;
  if (isPastNineFifteenEntryWindow() || hasRanToday(ctx.dateIST)) return;

  const session = loadKiteSession();
  if (!session?.accessToken) return;

  nineFifteenBurstInFlight = true;
  loopBusy = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  try {
    await tryEnterNineFifteen(session.accessToken, ctx.dateIST);
  } catch (err) {
    settleNineFifteen(
      `9:15 trade not taken · ${err instanceof Error ? err.message : "unknown error"}`,
      "error",
    );
  } finally {
    loopBusy = false;
    nineFifteenBurstInFlight = false;
    scheduleNext();
  }
}

/** Same wall-clock re-arming as the 9:16:00 timer below, aimed at 9:15:06.000. */
function armNineFifteenTimer() {
  const ctx = getIndianMarketContext();
  if (ctx.sessionStatus === "closed_weekend" || ctx.sessionStatus === "post_market") return;
  if (nineFifteenSettled || nineFifteenBurstInFlight || hasRanToday(ctx.dateIST)) return;

  const delay = msUntilNineFifteenEntry();
  if (delay < 0 || delay > 10 * 60 * 1000) return;

  if (nineFifteenTimer) clearTimeout(nineFifteenTimer);
  nineFifteenTimer = setTimeout(() => {
    nineFifteenTimer = null;
    void runNineFifteenEntryBurst();
  }, delay);

  if (nineFifteenTimerDate !== ctx.dateIST) {
    nineFifteenTimerDate = ctx.dateIST;
    pushLog(`9:15:06.000 entry armed · T-${(delay / 1000).toFixed(1)}s`, "info");
  }
}

/**
 * Aim a one-shot timer at 9:16:00.000 IST. Re-armed on every poll so the delay is recomputed
 * from the wall clock each time: one long setTimeout would drift under load and would not
 * follow an NTP correction, and by 9:15:59 the poll runs every 50ms so the final arm lands
 * within milliseconds of the target.
 */
function armEntryInstantTimer() {
  const ctx = getIndianMarketContext();
  if (ctx.sessionStatus === "closed_weekend" || ctx.sessionStatus === "post_market") return;
  const delay = msUntilEntryInstant();
  // Only inside the final 10 minutes, so a restart at 02:00 never holds a stale timer.
  if (delay < 0 || delay > 10 * 60 * 1000) return;
  if (entryBurstInFlight || hasRanToday(ctx.dateIST)) return;

  if (entryTimer) clearTimeout(entryTimer);
  entryTimer = setTimeout(() => {
    entryTimer = null;
    void runEntryBurst();
  }, delay);

  if (entryTimerDate !== ctx.dateIST) {
    entryTimerDate = ctx.dateIST;
    pushLog(`9:16:00.000 entry armed · T-${(delay / 1000).toFixed(1)}s`, "info");
  }
}

function scheduleNext() {
  if (!monitorLoopStarted) return;
  if (enabled) {
    armEntryInstantTimer();
  } else if (entryTimer) {
    clearTimeout(entryTimer);
    entryTimer = null;
    entryTimerDate = null;
  }
  if (nineFifteenEnabled) {
    armNineFifteenTimer();
  } else if (nineFifteenTimer) {
    clearTimeout(nineFifteenTimer);
    nineFifteenTimer = null;
    nineFifteenTimerDate = null;
  }
  if (timer) clearTimeout(timer);
  const has915Ohlc =
    capturedOpen915 != null &&
    capturedOpen915 > 0 &&
    capturedClose915 != null &&
    capturedClose915 > 0;
  let delay: number;
  if (phase === "in_position" || phase === "exiting") {
    delay = isKiteTickerConnected() ? 1000 : getNineSixteenSpotPollMs();
  } else if (phase === "done" && isInBotWsHours()) {
    // Keep WS alive until 16:00 even after entry/skip is finished.
    delay = Math.min(30_000, Math.max(1000, msUntilWsDisconnect()));
  } else {
    delay = Math.max(50, msUntilNextEntryPhase(has915Ohlc));
  }
  timer = setTimeout(() => {
    void mainLoop().finally(scheduleNext);
  }, delay);
}

function buildStatusSnapshot(): NineSixteenBotStatus {
  const ctx = getIndianMarketContext();
  const session = loadKiteSession();

  let pnl: number | null = null;
  if (entryPrice > 0 && lastOptionPrice != null && lastOptionPrice > 0 && quantity > 0) {
    pnl = (lastOptionPrice - entryPrice) * quantity;
  } else if (unrealisedPnl != null) {
    pnl = unrealisedPnl;
  }

  const pnlPct = pnlPctOfEntryCost(pnl, entryPrice, quantity);
  const onNineFifteenLeg = tradeSlot === "nine-fifteen";
  const pnlTargetPct = onNineFifteenLeg
    ? NINE_FIFTEEN_TAKE_PROFIT_PCT
    : trailingPnlTargetPct(lockedPnlPct, ctx.dateIST);
  const pnlStopPct = onNineFifteenLeg ? null : trailingPnlStopPct(lockedPnlPct);
  const pnlTrailArmed = onNineFifteenLeg
    ? nineFifteenTpOrderIds.length > 0 || (entryPrice > 0 && quantity > 0)
    : lockedPnlPct >= NINE_SIXTEEN_PNL_TRAIL_FIRST_LOCK_PCT;
  const sizeKnown = entryPrice > 0 && quantity > 0;
  const pnlTargetAmount = onNineFifteenLeg
    ? sizeKnown
      ? nineFifteenTakeProfitAmount(entryPrice, quantity)
      : null
    : sizeKnown
      ? computePnlTargetAmount(entryPrice, quantity, pnlTargetPct)
      : null;
  const pnlStopAmount =
    sizeKnown && pnlStopPct != null ? computePnlTargetAmount(entryPrice, quantity, pnlStopPct) : null;
  const nineFifteenCapital =
    onNineFifteenLeg && sizeKnown ? nineFifteenDeployedCapital(entryPrice, quantity) : null;
  const nineFifteenProfitAim =
    onNineFifteenLeg && sizeKnown ? nineFifteenTakeProfitAmount(entryPrice, quantity) : null;
  const nineFifteenRemaining =
    onNineFifteenLeg && sizeKnown ? nineFifteenPnlRemainingToTarget(pnl, entryPrice, quantity) : null;

  const inTrade = phase === "in_position" || phase === "exiting";

  return {
    enabled,
    phase,
    dateIST: ctx.dateIST,
    message,
    open915: open915 > 0 ? open915 : capturedOpen915 != null && capturedOpen915 > 0 ? capturedOpen915 : null,
    close915: capturedClose915 != null && capturedClose915 > 0 ? capturedClose915 : null,
    wsConnected: isKiteTickerConnected(),
    entrySpot: entrySpot > 0 ? entrySpot : null,
    exitMode: inTrade ? exitMode : null,
    indexExitSchedule: null,
    hardStopSpot:
      inTrade && entrySpot > 0 && leg ? computeHardStopSpot(entrySpot, leg) : null,
    hardStopActive: inTrade && isHardStopWindowActive(),
    hardStopPoints: NINE_SIXTEEN_HARD_STOP_INDEX_POINTS,
    hardStopStartLabel: getHardStopStartLabel(),
    leg,
    tradingsymbol,
    targetSpot: null,
    lastSpot,
    entryPrice: entryPrice > 0 ? entryPrice : null,
    lastOptionPrice,
    quantity: quantity > 0 ? quantity : null,
    unrealisedPnl: pnl,
    niftyPointsToTarget: null,
    pnlTargetAmount,
    pnlTargetPct,
    pnlExitActive: pnlTrailArmed,
    pnlExitStartLabel: getPnlExitStartLabel(),
    pnlExitSchedule: getPnlTrailScheduleLabel(ctx.dateIST),
    pnlPct,
    pnlLockedPct: lockedPnlPct,
    pnlStopPct,
    pnlStopAmount,
    pnlTrailArmed,
    pnlTrailArmPct: onNineFifteenLeg ? NINE_FIFTEEN_TAKE_PROFIT_PCT : getNineSixteenPnlTrailArmPct(ctx.dateIST),
    pnlTrailStepPct: onNineFifteenLeg ? 0 : NINE_SIXTEEN_PNL_TRAIL_STEP_PCT,
    nineFifteenEnabled,
    tradeSlot,
    nineFifteenMarkPrice,
    nineFifteenMarkAt: nineFifteenMarkAtLabel,
    nineFifteenMarkChange:
      nineFifteenMarkPrice != null && capturedOpen915 != null && capturedOpen915 > 0
        ? nineFifteenMarkPrice - capturedOpen915
        : null,
    nineFifteenSettled,
    nineFifteenNote,
    nineFifteenBlocked916: nineFifteenOverranMinute,
    nineFifteenLadder: getNineFifteenLadderLabel(),
    nineFifteenTakeProfitPct: NINE_FIFTEEN_TAKE_PROFIT_PCT,
    nineFifteenTpLimitPrice:
      onNineFifteenLeg && nineFifteenTpLimitPrice > 0 ? nineFifteenTpLimitPrice : null,
    nineFifteenDeployedCapital: nineFifteenCapital,
    nineFifteenTpProfitAim: nineFifteenProfitAim,
    nineFifteenPnlRemaining: nineFifteenRemaining,
    nineFifteenTpOrderStatus: onNineFifteenLeg ? nineFifteenTpOrderStatus : undefined,
    nineFifteenTpOrderIds: onNineFifteenLeg && nineFifteenTpOrderIds.length > 0 ? [...nineFifteenTpOrderIds] : undefined,
    nineFifteenTpFilledQty: onNineFifteenLeg ? nineFifteenTpFilledQty : undefined,
    nineFifteenTpPendingQty: onNineFifteenLeg ? nineFifteenTpPendingQty : undefined,
    nineFifteenTpPlacedAt: onNineFifteenLeg ? nineFifteenTpPlacedAt : undefined,
    nineFifteenTpLastSyncedAt: onNineFifteenLeg ? nineFifteenTpLastSyncedAt : undefined,
    nineFifteenTrailArmPct: NINE_FIFTEEN_TAKE_PROFIT_PCT,
    nineFifteenTrailStepPct: 0,
    sessionConnected: Boolean(session),
    sessionAgeHours: session ? kiteSessionAgeHours(session) : null,
    updatedAt: new Date().toISOString(),
    spotPollMs: getNineSixteenSpotPollMs(),
    logs: [...logs],
    liveSpotSampleCount: liveSpotSamples.length,
    liveSpotSamples: [...liveSpotSamples].slice(-LIVE_SPOT_STATUS_SAMPLES).reverse(),
    rawTickCount: rawTickSeq,
    rawTicks: [...rawTicks].slice(-RAW_TICK_STATUS_ROWS).reverse(),
    rawTickFile: rawTickDateIst ? TICK_FILE(rawTickDateIst) : null,
  };
}

export function getNineSixteenBotStatus(): NineSixteenBotStatus {
  return buildStatusSnapshot();
}

/**
 * True once the 9:16 bot can neither take nor hold a trade today. Momentum scalper hands off on
 * this instead of a fixed clock time: past 9:16:30 the bot is either holding a leg or will never
 * enter, so "not occupied" settles it — including when the 9:16 bot is disabled entirely.
 */
export function isNineSixteenSettledForDay(nowMs = Date.now()): boolean {
  if (!isPast916EntryWindow(nowMs)) return false;
  return !isNineSixteenBotOccupied();
}

/** True while the 9:16 bot is entering, holding, or exiting — momentum scalper must stand down. */
export function isNineSixteenBotOccupied(): boolean {
  if (phase === "entering" || phase === "in_position" || phase === "exiting") return true;
  try {
    const dateIst = getIndianMarketContext().dateIST;
    if (!fs.existsSync(STATE_FILE)) return false;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as {
      dateIST?: string;
      phase?: NineSixteenBotPhase;
    };
    if (parsed.dateIST !== dateIst) return false;
    return parsed.phase === "entering" || parsed.phase === "in_position" || parsed.phase === "exiting";
  } catch {
    return false;
  }
}

export async function getNineSixteenBotStatusLive(): Promise<NineSixteenBotStatus> {
  const session = loadKiteSession();
  const ctx = getIndianMarketContext();
  if (!session?.accessToken) return buildStatusSnapshot();

  loadBotState(ctx.dateIST);

  try {
    // UI polling must not spend Kite rate limit during the 9:16:00 entry burst.
    if (!isInNineSixteenBurst()) {
      await reconcilePositionWithKite(session.accessToken, ctx.dateIST);
    }
    // While ticks are streaming the snapshot is already fresh — REST would just burn quota.
    if (
      (phase === "in_position" || phase === "exiting") &&
      !isKiteTickerConnected() &&
      (lastQuoteRefreshAt === 0 ||
        Date.now() - lastQuoteRefreshAt >= getNineSixteenSpotPollMs())
    ) {
      await refreshLiveQuotes(session.accessToken, ctx.dateIST);
    }
  } catch (err) {
    const note = err instanceof Error ? err.message : "Live sync failed";
    if (phase === "in_position") {
      pushLog(note, "warning");
    }
  }

  return buildStatusSnapshot();
}

export type NineSixteenBotLiveTick = Pick<
  NineSixteenBotStatus,
  | "lastSpot"
  | "lastOptionPrice"
  | "entryPrice"
  | "quantity"
  | "unrealisedPnl"
  | "niftyPointsToTarget"
  | "targetSpot"
  | "updatedAt"
>;

export async function getNineSixteenBotLiveTick(): Promise<NineSixteenBotLiveTick> {
  await getNineSixteenBotStatusLive();
  const snapshot = buildStatusSnapshot();
  return {
    lastSpot: snapshot.lastSpot,
    lastOptionPrice: snapshot.lastOptionPrice,
    entryPrice: snapshot.entryPrice,
    quantity: snapshot.quantity,
    unrealisedPnl: snapshot.unrealisedPnl,
    niftyPointsToTarget: snapshot.niftyPointsToTarget,
    targetSpot: snapshot.targetSpot,
    updatedAt: snapshot.updatedAt,
  };
}

export function startNineSixteenLiveMonitor() {
  const ctx = getIndianMarketContext();
  resetNineFifteenForDay(ctx.dateIST);
  loadBotState(ctx.dateIST);
  loadCaptures(ctx.dateIST);
}

export function startNineSixteenMonitorLoop() {
  if (monitorLoopStarted) return;
  monitorLoopStarted = true;
  if (phase === "off") {
    phase = "waiting";
    message = enabled
      ? "Server bot waiting for Kite websocket 9:15 ticks"
      : "9:16 trading disabled — websocket monitor active";
  }
  scheduleNext();
}

export function setNineSixteenBotEnabled(next: boolean) {
  enabled = next;
  startNineSixteenMonitorLoop();
  if (!enabled) {
    if (entryTimer) clearTimeout(entryTimer);
    entryTimer = null;
    entryTimerDate = null;
    if (phase === "in_position" || phase === "exiting") {
      message = `9:16 trading disabled · still managing open position · ${getPnlTrailScheduleLabel(getIndianMarketContext().dateIST)}`;
      pushLog("9:16 trading disabled — open position still managed", "warning");
    } else if (phase === "done") {
      message = isKiteTickerConnected()
        ? "9:16 trading disabled · websocket live until 16:00"
        : "9:16 trading disabled · session complete";
      pushLog("9:16 trading disabled — websocket monitor continues", "info");
    } else {
      phase = "waiting";
      message = isKiteTickerConnected()
        ? "9:16 trading disabled · websocket live"
        : "9:16 trading disabled — websocket monitor active";
      pushLog("9:16 trading disabled — websocket monitor continues", "info");
    }
    scheduleNext();
    return;
  }
  if (phase === "off") phase = "waiting";
  message = "9:16 trading enabled — WS 9:00–16:00 · 9:16:00 entry";
  pushLog("9:16 trading enabled", "info");
  scheduleNext();
}

export function setNineFifteenBotEnabled(next: boolean) {
  nineFifteenEnabled = next;
  startNineSixteenMonitorLoop();
  if (!nineFifteenEnabled) {
    if (nineFifteenTimer) clearTimeout(nineFifteenTimer);
    nineFifteenTimer = null;
    nineFifteenTimerDate = null;
    pushLog(
      tradeSlot === "nine-fifteen" && (phase === "in_position" || phase === "exiting")
        ? "9:15 trading disabled — open 9:15 position still managed"
        : "9:15 trading disabled",
      "info",
    );
  } else {
    pushLog("9:15 trading enabled — red at the 9:15:05 read buys the ATM PE at 9:15:06", "info");
  }
  scheduleNext();
}

export function startNineSixteenBot() {
  startNineSixteenLiveMonitor();
  startNineSixteenMonitorLoop();
  if (nineFifteenEnabled && enabled) {
    pushLog("9:15 and 9:16 trading enabled on startup", "info");
  } else if (enabled) {
    pushLog("9:16 trading enabled on startup", "info");
  } else if (nineFifteenEnabled) {
    pushLog("9:15 trading enabled on startup — red at 9:15:05 read buys the ATM PE at 9:15:06", "info");
  } else {
    pushLog("9:16 websocket monitor started (trading disabled)", "info");
  }
}

export async function listBotTradeLogs() {
  return loadBotTradeLogs();
}
