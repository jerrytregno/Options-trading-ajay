import fs from "fs";
import path from "path";
import { getIndianMarketContext } from "../src/lib/market-time.js";
import {
  isPast916EntryWindow,
  isPastNineSixteenForceExit,
  isReadyFor916Entry,
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
  getNineSixteenPnlTargetPct,
  getPnlExitStartLabel,
  getPnlExitScheduleLabel,
  activePnlTargetPct,
  isPnlExitWindowActive,
  activeIndexTargetPoints,
  getIndexExitScheduleLabel,
  getNineSixteenSpotPollMs,
  shouldExitNineSixteen,
  shouldExitOnPnlTarget,
  type NineSixteenExitMode,
} from "./nine-sixteen-logic.js";
import { legLabel, type TradeLeg } from "../src/lib/trade-calculations.js";
import { resolveAtmNiftyOption } from "./atm-option.js";
import { resolveEntryQuantity } from "./nine-sixteen-sizing.js";
import {
  assertKiteEgressReady,
  clearKiteRejectedIp,
} from "./trading-ip.js";
import {
  fetchMisPosition,
  fetchNetQty,
  fetchNiftyAndOptionQuotes,
  fetchNiftySpot,
  fetchOptionLtp,
  findOpenNiftyMisOption,
  kiteGet,
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
  /** main = |Δ|≥15; near_miss = 11≤|Δ|<15. */
  exitMode: NineSixteenExitMode | null;
  /** Human-readable index exit schedule for this trade. */
  indexExitSchedule: string | null;
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
  /** Unrealised P&L needed to hit +% exit. */
  pnlTargetAmount: number | null;
  pnlTargetPct: number;
  pnlExitActive: boolean;
  pnlExitStartLabel: string;
  pnlExitSchedule?: string;
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
}

interface PersistedCaptureState {
  dateIST: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
}

let enabled = process.env.NINE_SIXTEEN_BOT_ENABLED === "1";
let phase: NineSixteenBotPhase = enabled ? "waiting" : "off";
let message = enabled ? "Server bot waiting for Kite websocket 9:15 ticks" : "Server bot disabled";
let open915 = 0;
let entrySpot = 0;
let exitMode: NineSixteenExitMode = "main";
let leg: TradeLeg | null = null;
let tradingsymbol: string | null = null;
let quantity = 0;
let entryPrice = 0;
let lastSpot: number | null = null;
let lastOptionPrice: number | null = null;
let unrealisedPnl: number | null = null;
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
    time: new Date().toLocaleTimeString("en-IN", { hour12: false }),
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
    message = `In position · exit ${getIndexExitScheduleLabel(exitMode)} from ${entrySpot > 0 ? entrySpot.toFixed(2) : "—"}`;
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

async function reconcilePositionWithKiteInner(accessToken: string, dateIst: string) {
  const open = await findOpenNiftyMisOption(accessToken);

  if (open) {
    tradingsymbol = open.tradingsymbol;
    quantity = open.quantity;
    entryPrice = open.average_price;
    lastOptionPrice = open.last_price;
    unrealisedPnl = open.unrealised ?? open.pnl;
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

    message = `In position · exit ${getIndexExitScheduleLabel(exitMode)} from ${entrySpot > 0 ? entrySpot.toFixed(2) : "pending"}`;
    saveBotState(dateIst);
    return;
  }

  // Do not race a live square-off — squareOff persists the closed log itself.
  if (squareOffInFlight || phase === "exiting") return;

  const wasTracking =
    phase === "in_position" ||
    Boolean(tradingsymbol) ||
    fs.existsSync(STATE_FILE);

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
  if (entrySpot <= 0 || !leg) return null;
  const pts = activeIndexTargetPoints(exitMode);
  return leg === "CE_BUY" ? entrySpot + pts : entrySpot - pts;
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
  const id =
    status === "closed" && tradingsymbol
      ? makeBotTradeLogId(dateIst, tradingsymbol)
      : makeSessionOutcomeLogId(dateIst, status);

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
      close915: close,
      change915: change,
      entrySpot: entrySpot > 0 ? entrySpot : null,
      targetSpot: computeTargetSpot(),
      entryPrice: entryPrice > 0 ? entryPrice : null,
      exitPrice: extra?.exitPrice ?? null,
      exitSpot: extra?.exitSpot ?? lastSpot,
      pnl: extra?.pnl ?? unrealisedPnl,
      exitReason: extra?.exitReason ?? (status === "skipped" || status === "no_entry" ? note : null),
      message: note,
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

function finishDay(dateIst: string, note: string, type: NineSixteenBotStatus["logs"][number]["type"] = "info") {
  markRanToday(dateIst);
  phase = "done";
  message = note;
  tradingsymbol = null;
  quantity = 0;
  entryPrice = 0;
  entrySpot = 0;
  exitMode = "main";
  open915 = 0;
  leg = null;
  lastSpot = null;
  lastOptionPrice = null;
  unrealisedPnl = null;
  lastQuoteRefreshAt = 0;
  lastPositionSyncAt = 0;
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
    if (phase !== "in_position" && phase !== "exiting") {
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
    void evaluateLiveExits();
  }
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

async function squareOff(accessToken: string, reason: string) {
  if (squareOffInFlight) return;
  squareOffInFlight = true;
  try {
    await squareOffInner(accessToken, reason);
  } finally {
    squareOffInFlight = false;
  }
}

async function squareOffInner(accessToken: string, reason: string) {
  const dateIst = getIndianMarketContext().dateIST;
  if (!tradingsymbol || quantity <= 0) {
    await persistTradeLog(dateIst, "closed", reason, { exitReason: reason, pnl: unrealisedPnl });
    finishDay(dateIst, reason, "success");
    return;
  }

  phase = "exiting";
  message = reason;
  pushLog(reason, "success");

  const openQty = await fetchNetQty(accessToken, tradingsymbol);
  if (openQty <= 0) {
    await persistTradeLog(dateIst, "closed", "Already flat", { exitReason: reason, pnl: unrealisedPnl });
    finishDay(dateIst, "Already flat", "info");
    return;
  }

  const exitSide = leg === "PE_BUY" ? "SELL" : "SELL";
  const orderId = await placeRegularMarketOrder(accessToken, {
    tradingsymbol,
    exchange: "NFO",
    transaction_type: exitSide,
    product: "MIS",
    quantity,
  });
  const exitFill = await waitForOrderComplete(accessToken, orderId);
  const exitPrice = exitFill.average_price;
  const pnl = entryPrice > 0 ? (exitPrice - entryPrice) * quantity : unrealisedPnl;
  await persistTradeLog(dateIst, "closed", `CLOSED · ${reason}`, {
    exitPrice,
    exitSpot: lastSpot,
    pnl,
    exitReason: reason,
  });
  finishDay(dateIst, `CLOSED · ${reason}`, "success");
}

async function tryEnter(accessToken: string, dateIst: string) {
  phase = "entering";
  message = "Placing 9:16:00 entry…";

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
  await assertKiteEgressReady();

  const resolved = await resolveAtmNiftyOption(accessToken, nextLeg);
  if (!resolved) throw new Error("ATM option not found");

  const optionLtp = await fetchOptionLtp(accessToken, resolved.tradingsymbol);
  if (optionLtp <= 0) throw new Error("Option LTP unavailable for sizing");

  const sizing = await resolveEntryQuantity(accessToken, resolved.lotSize, optionLtp);
  if (sizing.lots <= 0 || sizing.quantity <= 0) {
    const skipNote = `SKIPPED · balance too low for 1 lot · need ~₹${Math.ceil(sizing.costPerLot)} · available ₹${Math.floor(sizing.availableBalance)} · open ${bar.open.toFixed(2)} · close ${bar.close.toFixed(2)} · Δ ${bar.change.toFixed(2)}`;
    pushLog(skipNote, "warning");
    await persistTradeLog(dateIst, "skipped", skipNote);
    finishDay(dateIst, skipNote, "warning");
    return;
  }

  tradingsymbol = resolved.tradingsymbol;
  quantity = sizing.quantity;

  const modeLabel = exitMode === "near_miss" ? "near-miss exits (±20→±10@10:01)" : "main exits (±25→±20@10:01→±15@11:01)";
  pushLog(
    `9:15 ${bar.direction.toUpperCase()} · |Δ| ${Math.abs(bar.change).toFixed(2)} → ${legLabel(nextLeg)} ${resolved.tradingsymbol} · ${modeLabel} · ${sizing.lots} lot(s) · ₹${Math.floor(sizing.availableBalance)} avail`,
    "success",
  );

  const orderId = await placeRegularMarketOrder(accessToken, {
    tradingsymbol: resolved.tradingsymbol,
    exchange: "NFO",
    transaction_type: "BUY",
    product: "MIS",
    quantity: sizing.quantity,
  });
  await waitForOrderComplete(accessToken, orderId);
  clearKiteRejectedIp();

  const filled = await fetchMisPosition(accessToken, tradingsymbol, "MIS");
  if (filled) {
    entryPrice = filled.average_price;
    lastOptionPrice = filled.last_price;
    unrealisedPnl = filled.unrealised ?? filled.pnl;
  }

  // Lock exit anchor = Nifty 50 WS spot at fill (~9:16:00), not 9:15 open / not option premium
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
    throw new Error("Nifty spot unavailable at entry — cannot set index exit from Nifty spot at 9:16:00");
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
  message = `In position · WS exit ${getIndexExitScheduleLabel(exitMode)} from ${entrySpot.toFixed(2)} · P&L ${getPnlExitScheduleLabel()}`;
  pushLog(
    `Entry Nifty spot ${entrySpot.toFixed(2)} · index exit ${getIndexExitScheduleLabel(exitMode)} (${exitMode}) · 9:15 chose CE/PE + exit band`,
    "success",
  );
  pushLog(
    optionInstrumentToken > 0
      ? `Exit websocket live · Nifty 50 + ${resolved.tradingsymbol}`
      : "Exit websocket live · Nifty 50 (option token missing — P&L uses quote fallback)",
    optionInstrumentToken > 0 ? "success" : "warning",
  );
  pushLog(message, "success");
  saveBotState(dateIst);
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

  if (syncPosition && tradingsymbol) {
    try {
      const pos = await fetchMisPosition(accessToken, tradingsymbol, "MIS");
      if (pos) {
        quantity = pos.quantity;
        entryPrice = pos.average_price;
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

async function checkAndMaybeExit(accessToken: string, _dateIst: string): Promise<boolean> {
  if (phase !== "in_position") return false;

  if (isPastNineSixteenForceExit()) {
    await squareOff(accessToken, "End of day square-off");
    return true;
  }

  // Exit on whichever fires first: tiered index target OR option P&L % (not both required).
  const spot = lastSpot ?? 0;
  if (leg && entrySpot > 0 && spot > 0) {
    const indexTarget = activeIndexTargetPoints(exitMode);
    if (shouldExitNineSixteen(spot, entrySpot, leg, indexTarget)) {
      await squareOff(
        accessToken,
        `Target hit · ±${indexTarget} · Nifty spot ${spot.toFixed(2)} (from entry spot ${entrySpot.toFixed(2)})`,
      );
      return true;
    }
  }

  const pnlPctActive = activePnlTargetPct();
  if (
    pnlPctActive != null &&
    isPnlExitWindowActive() &&
    unrealisedPnl != null &&
    entryPrice > 0 &&
    quantity > 0 &&
    shouldExitOnPnlTarget(unrealisedPnl, entryPrice, quantity, pnlPctActive)
  ) {
    const entryAmount = entryPrice * quantity;
    await squareOff(
      accessToken,
      `P&L target hit · +${pnlPctActive}% (₹${Math.round(unrealisedPnl)} on ₹${Math.round(entryAmount)})`,
    );
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
  } else if (Date.now() - lastPositionSyncAt >= 5000 && tradingsymbol) {
    try {
      const pos = await fetchMisPosition(accessToken, tradingsymbol, "MIS");
      if (pos) {
        quantity = pos.quantity;
        entryPrice = pos.average_price;
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
  if (!enabled || loopBusy) return;
  loopBusy = true;

  try {
    const ctx = getIndianMarketContext();

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
      quantity = 0;
      clearCaptures(ctx.dateIST);
      message = "New session — waiting for Kite websocket 9:15 ticks";
    }

    const sessionEarly = loadKiteSession();

    if (hasRanToday(ctx.dateIST) && phase !== "in_position" && phase !== "exiting") {
      phase = "done";
      if (isInBotWsHours() && sessionEarly?.accessToken) {
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
      phase = "waiting";
      const waitMs = msUntilNextEntryPhase(false);
      message = isInBotWsHours()
        ? isKiteTickerConnected()
          ? "Websocket live · waiting for first Nifty tick in 9:15:00–9:15:15"
          : `Connecting Kite websocket · ${Math.ceil(waitMs / 1000)}s`
        : `Waiting to connect Kite websocket at 9:00:00 · ${Math.ceil(waitMs / 1000)}s`;
      return;
    }

    try {
      await reconcilePositionWithKite(session.accessToken, ctx.dateIST);
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
        await persistTradeLog(ctx.dateIST, "no_entry", "NO ENTRY · Market closed");
        finishDay(ctx.dateIST, "NO ENTRY · Market closed");
      }
      return;
    }

    if (phase === "in_position" || phase === "exiting") {
      await tickInPosition(session.accessToken, ctx.dateIST);
      return;
    }

    if (isPast916EntryWindow()) {
      await persistTradeLog(ctx.dateIST, "no_entry", "NO ENTRY · Missed 9:16 entry window");
      finishDay(ctx.dateIST, "NO ENTRY · Missed 9:16 entry window", "warning");
      return;
    }

    await ensureNiftyTicker(session.accessToken, ctx.dateIST);

    if (isReadyToSeal915Close()) {
      seal915CloseFromTicks(ctx.dateIST);
    }

    const has915Ohlc =
      capturedOpen915 != null &&
      capturedOpen915 > 0 &&
      capturedClose915 != null &&
      capturedClose915 > 0;

    if (has915Ohlc && isReadyFor916Entry()) {
      await tryEnter(session.accessToken, ctx.dateIST);
      return;
    }

    if (isReadyFor916Entry() && !has915Ohlc) {
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
    if (!isInBotWsHours()) {
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
    phase = "error";
    message = err instanceof Error ? err.message : "Bot error";
    pushLog(message, "error");
    const authFail = /api_key|access_token|TokenException|Incorrect/i.test(message);
    // Auth failures are recoverable with daily login — never burn the trading day.
    if (authFail) {
      phase = "waiting";
      message = "Kite session invalid — reconnect in Settings before 9:15";
      return;
    }
    if (isPast916EntryWindow()) {
      await persistTradeLog(getIndianMarketContext().dateIST, "error", message);
      finishDay(getIndianMarketContext().dateIST, message, "error");
    } else {
      phase = "waiting";
    }
  } finally {
    loopBusy = false;
  }
}

function scheduleNext() {
  if (!enabled) return;
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
  const activePts = activeIndexTargetPoints(exitMode);
  const targetSpot =
    entrySpot > 0 && leg
      ? leg === "CE_BUY"
        ? entrySpot + activePts
        : entrySpot - activePts
      : null;

  let niftyPointsToTarget: number | null = null;
  if (targetSpot != null && lastSpot != null && lastSpot > 0 && leg) {
    niftyPointsToTarget =
      leg === "CE_BUY" ? Math.max(0, targetSpot - lastSpot) : Math.max(0, lastSpot - targetSpot);
  }

  let pnl: number | null = null;
  if (entryPrice > 0 && lastOptionPrice != null && lastOptionPrice > 0 && quantity > 0) {
    pnl = (lastOptionPrice - entryPrice) * quantity;
  } else if (unrealisedPnl != null) {
    pnl = unrealisedPnl;
  }

  const pnlTargetPct = activePnlTargetPct() ?? getNineSixteenPnlTargetPct();
  const pnlExitActive = isPnlExitWindowActive();
  const pnlTargetAmount =
    entryPrice > 0 && quantity > 0 && activePnlTargetPct() != null
      ? computePnlTargetAmount(entryPrice, quantity, activePnlTargetPct()!)
      : null;

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
    indexExitSchedule: inTrade ? getIndexExitScheduleLabel(exitMode) : null,
    leg,
    tradingsymbol,
    targetSpot,
    lastSpot,
    entryPrice: entryPrice > 0 ? entryPrice : null,
    lastOptionPrice,
    quantity: quantity > 0 ? quantity : null,
    unrealisedPnl: pnl,
    niftyPointsToTarget,
    pnlTargetAmount,
    pnlTargetPct,
    pnlExitActive,
    pnlExitStartLabel: getPnlExitStartLabel(),
    pnlExitSchedule: getPnlExitScheduleLabel(),
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

export async function getNineSixteenBotStatusLive(): Promise<NineSixteenBotStatus> {
  const session = loadKiteSession();
  const ctx = getIndianMarketContext();
  if (!session?.accessToken) return buildStatusSnapshot();

  loadBotState(ctx.dateIST);

  try {
    await reconcilePositionWithKite(session.accessToken, ctx.dateIST);
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
  loadBotState(ctx.dateIST);
  loadCaptures(ctx.dateIST);
}

export function setNineSixteenBotEnabled(next: boolean) {
  enabled = next;
  if (!enabled) {
    if (timer) clearTimeout(timer);
    timer = null;
    haltBotTicker(true);
    if (phase === "in_position" || phase === "exiting") {
      message = `Auto exit paused · ${getIndexExitScheduleLabel(exitMode)} · P&L ${getPnlExitScheduleLabel()}`;
    } else {
      phase = "off";
      message = "Server bot disabled";
    }
    return;
  }
  phase = "waiting";
  message = "Server bot enabled — WS 9:00–16:00 · 9:16:00 entry";
  pushLog("Server 9:16 bot enabled", "info");
  scheduleNext();
}

export function startNineSixteenBot() {
  startNineSixteenLiveMonitor();
  if (!enabled) return;
  pushLog("Server 9:16 bot started with app", "info");
  scheduleNext();
}

export async function listBotTradeLogs() {
  return loadBotTradeLogs();
}
