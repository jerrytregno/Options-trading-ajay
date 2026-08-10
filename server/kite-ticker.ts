import { KiteTicker, type Tick, type Ticker } from "kiteconnect";
import { getKiteInstruments } from "./kite-instruments.js";

/** Stable NSE index token; refreshed from instruments master when possible. */
export const NIFTY_50_INSTRUMENT_TOKEN_FALLBACK = 256265;

export interface NiftyTick {
  lastPrice: number;
  instrumentToken: number;
  receivedAtMs: number;
  /** Exchange-side timestamp (full mode) — distinguishes a new print from a re-broadcast. */
  exchangeTimestampMs: number | null;
}

type TickHandler = (tick: NiftyTick) => void;

export interface NiftyTickerConnection {
  stop: () => void;
  connected: () => boolean;
  setInstruments: (tokens: number[]) => void;
}

interface Subscriber {
  id: number;
  tokens: number[];
  onTick: TickHandler;
  onConnect?: () => void;
  onDisconnect?: (error?: Error) => void;
  onError?: (error: Error) => void;
}

/**
 * kiteconnect v5 keeps `ws`, `should_reconnect` and even the event-handler registry in
 * module-level variables shared by every KiteTicker instance, and its internal retry path
 * ends in `process.exit(1)`. So we run exactly one instance, bind its handlers exactly once
 * (they can never be removed), disable its auto-reconnect, and supervise reconnects here.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let ticker: Ticker | null = null;
let tickerAccessToken = "";
let pendingAccessToken = "";
let handlersBound = false;
let socketOpen = false;
let wantConnection = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

let subscribers: Subscriber[] = [];
let subscriberSeq = 0;
let botSubscriberId: number | null = null;

function getApiKey(): string {
  const apiKey = process.env.KITE_API_KEY?.trim();
  if (!apiKey || apiKey === "your_api_key") {
    throw new Error("KITE_API_KEY not configured");
  }
  return apiKey;
}

function uniqueTokens(tokens: number[]): number[] {
  return [...new Set(tokens.filter((token) => Number.isFinite(token) && token > 0))];
}

/** Null on instruments the exchange does not stamp (and on ltp/quote packets). */
function readExchangeTimestampMs(tick: Tick): number | null {
  const stamp = (tick as { exchange_timestamp?: Date | string | null }).exchange_timestamp;
  if (!stamp) return null;
  const ms = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function allTokens(): number[] {
  return uniqueTokens(subscribers.flatMap((sub) => sub.tokens));
}

function applySubscriptions() {
  const tokens = allTokens();
  if (!ticker || !socketOpen || tokens.length === 0) return;
  ticker.subscribe(tokens);
  // Full mode carries exchange_timestamp; quote/ltp packets do not.
  ticker.setMode(ticker.modeFull, tokens);
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(reason: string) {
  if (!wantConnection || reconnectTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
  const note = `${reason} · reconnecting in ${Math.round(delay / 1000)}s`;
  for (const sub of [...subscribers]) sub.onDisconnect?.(new Error(note));
}

function bindHandlers(instance: Ticker) {
  // `on()` appends to a module-global registry with no way to unregister — bind once, ever.
  if (handlersBound) return;
  handlersBound = true;

  instance.on("connect", () => {
    socketOpen = true;
    reconnectAttempt = 0;
    applySubscriptions();
    for (const sub of [...subscribers]) sub.onConnect?.();
  });

  instance.on("ticks", (ticks: Tick[]) => {
    const receivedAtMs = Date.now();
    for (const tick of ticks) {
      if (!(tick.last_price > 0)) continue;
      const payload: NiftyTick = {
        lastPrice: tick.last_price,
        instrumentToken: tick.instrument_token,
        receivedAtMs,
        exchangeTimestampMs: readExchangeTimestampMs(tick),
      };
      for (const sub of [...subscribers]) {
        if (!sub.tokens.includes(tick.instrument_token)) continue;
        sub.onTick(payload);
      }
    }
  });

  instance.on("error", (error: Error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const sub of [...subscribers]) sub.onError?.(err);
  });

  // `close` always fires; `disconnect` is suppressed for reconnected sockets by a
  // stale module-global url check inside the library.
  instance.on("close", () => {
    if (!socketOpen && !wantConnection) return;
    socketOpen = false;
    if (wantConnection) scheduleReconnect("Kite websocket closed");
  });
}

function openSocket() {
  if (!wantConnection) return;
  try {
    if (!ticker || tickerAccessToken !== pendingAccessToken) {
      // reconnect:false — the library's own retry path terminates the process when it gives up.
      ticker = new KiteTicker({
        api_key: getApiKey(),
        access_token: pendingAccessToken,
        reconnect: false,
      });
      tickerAccessToken = pendingAccessToken;
      bindHandlers(ticker);
    }
    ticker.connect();
  } catch (err) {
    // A throw here would be unhandled inside the retry timer and take the process down.
    console.error("[kite-ticker] connect failed", err instanceof Error ? err.message : err);
    scheduleReconnect("Kite websocket connect failed");
  }
}

function addSubscriber(options: {
  accessToken: string;
  tokens: number[];
  onTick: TickHandler;
  onConnect?: () => void;
  onDisconnect?: (error?: Error) => void;
  onError?: (error: Error) => void;
}): Subscriber {
  subscriberSeq += 1;
  const sub: Subscriber = {
    id: subscriberSeq,
    tokens: uniqueTokens(options.tokens),
    onTick: options.onTick,
    onConnect: options.onConnect,
    onDisconnect: options.onDisconnect,
    onError: options.onError,
  };
  subscribers.push(sub);

  pendingAccessToken = options.accessToken;
  wantConnection = true;

  if (socketOpen) {
    applySubscriptions();
    sub.onConnect?.();
  } else {
    clearReconnectTimer();
    reconnectAttempt = 0;
    openSocket();
  }
  return sub;
}

function removeSubscriber(id: number) {
  const before = subscribers.length;
  subscribers = subscribers.filter((sub) => sub.id !== id);
  if (subscribers.length === before) return;

  if (subscribers.length > 0) {
    applySubscriptions();
    return;
  }

  wantConnection = false;
  clearReconnectTimer();
  socketOpen = false;
  try {
    ticker?.disconnect();
  } catch {
    /* ignore */
  }
}

export async function resolveNifty50InstrumentToken(accessToken: string): Promise<number> {
  try {
    const rows = await getKiteInstruments("NSE", accessToken, getApiKey());
    const match = rows.find(
      (row) => row.tradingsymbol === "NIFTY 50" && (row.segment === "INDICES" || row.exchange === "NSE"),
    );
    if (match?.instrument_token) return match.instrument_token;
  } catch (err) {
    console.warn(
      "[kite-ticker] NIFTY 50 token lookup failed — using 256265",
      err instanceof Error ? err.message : err,
    );
  }
  return NIFTY_50_INSTRUMENT_TOKEN_FALLBACK;
}

export async function resolveInstrumentToken(
  exchange: string,
  tradingsymbol: string,
  accessToken: string,
): Promise<number | null> {
  try {
    const rows = await getKiteInstruments(exchange, accessToken, getApiKey());
    const match = rows.find((row) => row.tradingsymbol === tradingsymbol);
    if (match?.instrument_token) return match.instrument_token;
  } catch (err) {
    console.warn(
      `[kite-ticker] ${exchange}:${tradingsymbol} token lookup failed`,
      err instanceof Error ? err.message : err,
    );
  }
  return null;
}

export function isKiteTickerConnected(): boolean {
  return socketOpen && botSubscriberId != null;
}

export function hasNiftyTickerInstance(): boolean {
  return botSubscriberId != null;
}

/**
 * Attach to the shared Kite websocket. Multiple callers (bot, log test) share one socket —
 * a second physical connection would corrupt the library's module-global state.
 */
export function createNiftyTickerConnection(options: {
  accessToken: string;
  instrumentToken?: number;
  instrumentTokens?: number[];
  onTick: TickHandler;
  onConnect?: () => void;
  onDisconnect?: (error?: Error) => void;
  onError?: (error: Error) => void;
}): NiftyTickerConnection {
  const tokens = options.instrumentTokens ?? (options.instrumentToken ? [options.instrumentToken] : []);
  const sub = addSubscriber({ ...options, tokens });

  return {
    connected: () => socketOpen,
    setInstruments: (nextTokens: number[]) => {
      sub.tokens = uniqueTokens(nextTokens);
      applySubscriptions();
    },
    stop: () => removeSubscriber(sub.id),
  };
}

export function startNiftyTicker(options: {
  accessToken: string;
  instrumentToken?: number;
  instrumentTokens?: number[];
  onTick: TickHandler;
  onConnect?: () => void;
  onDisconnect?: (error?: Error) => void;
  onError?: (error: Error) => void;
}): void {
  stopNiftyTicker();
  const tokens = options.instrumentTokens ?? (options.instrumentToken ? [options.instrumentToken] : []);
  const sub = addSubscriber({ ...options, tokens });
  botSubscriberId = sub.id;
}

export function setBotTickerInstruments(tokens: number[]): void {
  if (botSubscriberId == null) return;
  const sub = subscribers.find((row) => row.id === botSubscriberId);
  if (!sub) return;
  sub.tokens = uniqueTokens(tokens);
  applySubscriptions();
}

export function stopNiftyTicker(): void {
  if (botSubscriberId == null) return;
  const id = botSubscriberId;
  botSubscriberId = null;
  removeSubscriber(id);
}
