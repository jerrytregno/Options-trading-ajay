import fs from "fs";
import path from "path";
import { parseKiteCandles } from "../src/lib/candles.js";
import { getIndianMarketContext, getNseSessionKiteRange } from "../src/lib/market-time.js";
import {
  isPast916EntryWindow,
  isPastNineSixteenForceExit,
  isReadyFor916Entry,
  legFrom915Direction,
  msUntil916Entry,
  NINE_SIXTEEN_INDEX_TARGET,
  NINE_SIXTEEN_SPOT_POLL_MS,
  parse915Bar,
  pick915Candle,
  shouldExitNineSixteen,
} from "./nine-sixteen-logic.js";
import { legLabel, type TradeLeg } from "../src/lib/trade-calculations.js";
import { resolveAtmNiftyOption } from "./atm-option.js";
import {
  assertKiteEgressReady,
} from "./trading-ip.js";
import {
  fetchHistoricalCandles,
  fetchNetQty,
  fetchNiftySpot,
  placeRegularMarketOrder,
  waitForOrderComplete,
} from "./kite-client.js";
import { kiteSessionAgeHours, loadKiteSession } from "./kite-session-store.js";

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
  open915: number | null;
  leg: TradeLeg | null;
  tradingsymbol: string | null;
  targetSpot: number | null;
  lastSpot: number | null;
  sessionConnected: boolean;
  sessionAgeHours: number | null;
  updatedAt: string;
  logs: { time: string; message: string; type: "info" | "success" | "warning" | "error" }[];
}

const STATE_DIR = path.join(process.cwd(), "data");
const RAN_FILE = (dateIst: string) => path.join(STATE_DIR, `nine-sixteen-ran-${dateIst}.json`);

let enabled = process.env.NINE_SIXTEEN_BOT_ENABLED === "1";
let phase: NineSixteenBotPhase = enabled ? "waiting" : "off";
let message = enabled ? "Server bot waiting for 9:16 IST" : "Server bot disabled";
let open915 = 0;
let leg: TradeLeg | null = null;
let tradingsymbol: string | null = null;
let quantity = 0;
let lastSpot: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let loopBusy = false;
const logs: NineSixteenBotStatus["logs"] = [];

function pushLog(text: string, type: NineSixteenBotStatus["logs"][number]["type"] = "info") {
  logs.unshift({
    time: new Date().toLocaleTimeString("en-IN", { hour12: false }),
    message: text,
    type,
  });
  logs.splice(20);
  console.log(`[nine-sixteen-bot] ${text}`);
}

function markRanToday(dateIst: string) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(RAN_FILE(dateIst), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
}

function hasRanToday(dateIst: string): boolean {
  return fs.existsSync(RAN_FILE(dateIst));
}

function finishDay(dateIst: string, note: string, type: NineSixteenBotStatus["logs"][number]["type"] = "info") {
  markRanToday(dateIst);
  phase = "done";
  message = note;
  pushLog(note, type);
}

async function fetch915Bar(accessToken: string) {
  const range = getNseSessionKiteRange();
  const raw = await fetchHistoricalCandles(accessToken, "NSE:NIFTY 50", "minute", range.from, range.to);
  const candles = parseKiteCandles(raw);
  return parse915Bar(pick915Candle(candles));
}

async function squareOff(accessToken: string, reason: string) {
  if (!tradingsymbol || quantity <= 0) {
    finishDay(getIndianMarketContext().dateIST, reason, "success");
    return;
  }

  phase = "exiting";
  message = reason;
  pushLog(reason, "success");

  const openQty = await fetchNetQty(accessToken, tradingsymbol);
  if (openQty <= 0) {
    finishDay(getIndianMarketContext().dateIST, "Already flat", "info");
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
  await waitForOrderComplete(accessToken, orderId);
  finishDay(getIndianMarketContext().dateIST, `Exited · ${reason}`, "success");
}

async function tryEnter(accessToken: string, dateIst: string) {
  phase = "entering";
  message = "Reading 9:15 bar…";

  const bar = await fetch915Bar(accessToken);
  if (!bar) throw new Error("9:15 candle not available");

  open915 = bar.open;
  const nextLeg = legFrom915Direction(bar.direction);
  if (!nextLeg) {
    finishDay(dateIst, "9:15 bar flat — skipped", "warning");
    return;
  }

  leg = nextLeg;
  await assertKiteEgressReady();

  const resolved = await resolveAtmNiftyOption(accessToken, nextLeg);
  if (!resolved) throw new Error("ATM option not found");

  tradingsymbol = resolved.tradingsymbol;
  quantity = resolved.lotSize;

  pushLog(
    `9:15 ${bar.direction.toUpperCase()} → ${legLabel(nextLeg)} ${resolved.tradingsymbol}`,
    "success",
  );

  const orderId = await placeRegularMarketOrder(accessToken, {
    tradingsymbol: resolved.tradingsymbol,
    exchange: "NFO",
    transaction_type: "BUY",
    product: "MIS",
    quantity: resolved.lotSize,
  });
  await waitForOrderComplete(accessToken, orderId);

  phase = "in_position";
  message = `In position · exit Nifty ±${NINE_SIXTEEN_INDEX_TARGET} from ${open915.toFixed(2)}`;
  pushLog(message, "success");
}

async function tickInPosition(accessToken: string) {
  const spot = await fetchNiftySpot(accessToken);
  if (spot > 0) lastSpot = spot;

  if (isPastNineSixteenForceExit()) {
    await squareOff(accessToken, "End of day square-off");
    return;
  }

  if (leg && open915 > 0 && spot > 0 && shouldExitNineSixteen(spot, open915, leg)) {
    await squareOff(accessToken, `Target hit · Nifty ${spot.toFixed(2)}`);
  }
}

async function mainLoop() {
  if (!enabled || loopBusy) return;
  loopBusy = true;

  try {
    const ctx = getIndianMarketContext();

    if (ctx.sessionStatus === "closed_weekend") {
      phase = "waiting";
      message = "Weekend — resumes Monday";
      return;
    }

    if (phase === "done" && !hasRanToday(ctx.dateIST) && ctx.sessionStatus !== "post_market") {
      phase = "waiting";
      open915 = 0;
      leg = null;
      tradingsymbol = null;
      quantity = 0;
      message = "New session — waiting for 9:16 IST";
    }

    if (hasRanToday(ctx.dateIST)) {
      phase = "done";
      message = "Session complete for today";
      return;
    }

    const session = loadKiteSession();
    if (!session) {
      phase = "waiting";
      message = "Connect Kite in the app before 9:15 (daily login required)";
      return;
    }

    if (kiteSessionAgeHours(session) > 23) {
      phase = "waiting";
      message = "Kite session stale — reconnect in Settings before 9:15";
      return;
    }

    if (ctx.sessionStatus === "post_market") {
      if (phase === "in_position") {
        await tickInPosition(session.accessToken);
      } else if (phase !== "done") {
        finishDay(ctx.dateIST, "Market closed");
      }
      return;
    }

    if (phase === "in_position" || phase === "exiting") {
      await tickInPosition(session.accessToken);
      return;
    }

    if (isPast916EntryWindow()) {
      finishDay(ctx.dateIST, "Missed 9:16 entry window", "warning");
      return;
    }

    if (!isReadyFor916Entry()) {
      phase = "waiting";
      message = `Waiting for 9:16 · ${Math.ceil(msUntil916Entry() / 1000)}s`;
      return;
    }

    await tryEnter(session.accessToken, ctx.dateIST);
  } catch (err) {
    phase = "error";
    message = err instanceof Error ? err.message : "Bot error";
    pushLog(message, "error");
    if (isPast916EntryWindow()) {
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
  const delay =
    phase === "in_position" || phase === "exiting"
      ? NINE_SIXTEEN_SPOT_POLL_MS
      : Math.max(500, msUntil916Entry());
  timer = setTimeout(() => {
    void mainLoop().finally(scheduleNext);
  }, delay);
}

export function getNineSixteenBotStatus(): NineSixteenBotStatus {
  const ctx = getIndianMarketContext();
  const session = loadKiteSession();
  const targetSpot =
    open915 > 0 && leg
      ? leg === "CE_BUY"
        ? open915 + NINE_SIXTEEN_INDEX_TARGET
        : open915 - NINE_SIXTEEN_INDEX_TARGET
      : null;

  return {
    enabled,
    phase,
    dateIST: ctx.dateIST,
    message,
    open915: open915 > 0 ? open915 : null,
    leg,
    tradingsymbol,
    targetSpot,
    lastSpot,
    sessionConnected: Boolean(session),
    sessionAgeHours: session ? kiteSessionAgeHours(session) : null,
    updatedAt: new Date().toISOString(),
    logs: [...logs],
  };
}

export function setNineSixteenBotEnabled(next: boolean) {
  enabled = next;
  if (!enabled) {
    phase = "off";
    message = "Server bot disabled";
    if (timer) clearTimeout(timer);
    timer = null;
    return;
  }
  phase = "waiting";
  message = "Server bot enabled — waiting for 9:16 IST";
  pushLog("Server 9:16 bot enabled", "info");
  scheduleNext();
}

export function startNineSixteenBot() {
  if (!enabled) return;
  pushLog("Server 9:16 bot started with app", "info");
  scheduleNext();
}
