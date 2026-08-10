import { getIndianMarketContext } from "../src/lib/market-time.js";
import { loadKiteSession } from "./kite-session-store.js";
import {
  createNiftyTickerConnection,
  resolveNifty50InstrumentToken,
  type NiftyTick,
  type NiftyTickerConnection,
} from "./kite-ticker.js";

export interface NiftyLogTestSample {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  niftySpot: number | null;
  ticksInSecond: number;
  lastTickAtIST: string | null;
  stale: boolean;
}

export interface NiftyLogTestStatus {
  running: boolean;
  wsConnected: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  message: string;
  sampleCount: number;
  lastPrice: number | null;
  samples: NiftyLogTestSample[];
}

const MAX_SAMPLES = 7_200;

let running = false;
let connection: NiftyTickerConnection | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let samples: NiftyLogTestSample[] = [];
let latestTick: NiftyTick | null = null;
let ticksThisSecond = 0;
let startedAt: string | null = null;
let stoppedAt: string | null = null;
let message = "Log test idle";

function istLabel(ms: number): string {
  return getIndianMarketContext(new Date(ms)).timeIST;
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function appendSample() {
  if (!running) return;
  const now = Date.now();
  const ctx = getIndianMarketContext(new Date(now));
  const sample: NiftyLogTestSample = {
    seq: samples.length + 1,
    dateIST: ctx.dateIST,
    timeIST: ctx.timeIST,
    epochMs: now,
    niftySpot: latestTick?.lastPrice ?? null,
    ticksInSecond: ticksThisSecond,
    lastTickAtIST: latestTick ? istLabel(latestTick.receivedAtMs) : null,
    stale: ticksThisSecond === 0,
  };
  ticksThisSecond = 0;
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) {
    samples = samples.slice(samples.length - MAX_SAMPLES);
  }
  message = sample.niftySpot != null
    ? `Logging · ${sample.timeIST} · ${sample.niftySpot.toFixed(2)}${sample.stale ? " · no new tick this second" : ""}`
    : `Logging · ${sample.timeIST} · waiting for first tick`;
}

function scheduleNextSecond() {
  clearTimer();
  if (!running) return;
  const delay = Math.max(20, 1000 - (Date.now() % 1000));
  timer = setTimeout(() => {
    appendSample();
    scheduleNextSecond();
  }, delay);
}

export function getNiftyLogTestStatus(): NiftyLogTestStatus {
  return {
    running,
    wsConnected: connection?.connected() === true,
    startedAt,
    stoppedAt,
    message,
    sampleCount: samples.length,
    lastPrice: latestTick?.lastPrice ?? null,
    samples: [...samples].reverse(),
  };
}

export async function startNiftyLogTest(): Promise<NiftyLogTestStatus> {
  if (running) return getNiftyLogTestStatus();

  const session = loadKiteSession();
  if (!session?.accessToken) {
    throw new Error("Connect Kite in Settings before starting log test");
  }

  samples = [];
  latestTick = null;
  ticksThisSecond = 0;
  stoppedAt = null;
  startedAt = new Date().toISOString();
  running = true;
  message = "Connecting Kite websocket…";

  const instrumentToken = await resolveNifty50InstrumentToken(session.accessToken);
  connection = createNiftyTickerConnection({
    accessToken: session.accessToken,
    instrumentToken,
    onTick: (tick) => {
      latestTick = tick;
      ticksThisSecond += 1;
    },
    onConnect: () => {
      message = "Websocket live · logging Nifty spot every second";
    },
    onDisconnect: (error) => {
      if (!running) return;
      message = `Websocket disconnected${error?.message ? ` · ${error.message}` : ""}`;
    },
    onError: (error) => {
      if (!running) return;
      message = `Websocket error · ${error.message}`;
    },
  });

  scheduleNextSecond();
  console.log("[log-test] started");
  return getNiftyLogTestStatus();
}

export function stopNiftyLogTest(): NiftyLogTestStatus {
  running = false;
  clearTimer();
  connection?.stop();
  connection = null;
  stoppedAt = new Date().toISOString();
  message = samples.length
    ? `Stopped · ${samples.length} second sample(s)`
    : "Stopped · no samples";
  console.log(`[log-test] stopped · ${samples.length} samples`);
  return getNiftyLogTestStatus();
}

export function clearNiftyLogTest(): NiftyLogTestStatus {
  if (running) stopNiftyLogTest();
  samples = [];
  latestTick = null;
  ticksThisSecond = 0;
  startedAt = null;
  stoppedAt = null;
  message = "Log test idle";
  return getNiftyLogTestStatus();
}
