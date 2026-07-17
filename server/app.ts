import "./load-env.js";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { WATCHLIST_ITEMS } from "../src/lib/watchlist.js";
import { getStreamInstrument } from "../src/lib/stream-instruments.js";
import {
  calculateGreeks,
  filterStrikesAroundAtm,
  findAtmStrike,
} from "../src/lib/greeks.js";
import { getIndianMarketContext, getNseSessionKiteRange } from "../src/lib/market-time.js";
import { parseKiteCandles } from "../src/lib/candles.js";
import { buildSessionContext } from "../src/lib/session-context.js";
import {
  RSI_CALL_FORCE_THRESHOLD,
  RSI_PUT_FORCE_THRESHOLD,
} from "../src/lib/gemini-trade-rules.js";
import { buildTechnicalSnapshot } from "../src/lib/technical-indicators.js";
import {
  normalizeKiteOrderBody,
  resolveMarketProtection,
} from "../src/lib/kite-orders.js";
import { fetchLiveAtmScenarios } from "./prediction-option-pnl.js";
import { getKiteInstruments } from "./kite-instruments.js";
import { getRelaySecret, kiteHttpFetch } from "./kite-http.js";
import {
  assertKiteEgressReady,
  buildTradingIpInfo,
  enrichKiteIpOrderError,
} from "./trading-ip.js";
import {
  backtestPredictionDay,
  getPredictionStatus,
  livePrediction,
  trainPredictionModel,
  type PredictionDeps,
} from "./prediction.js";
import {
  importTradebookCsvIntoHistory,
  syncTodayOrdersIntoHistory,
} from "./trade-history.js";
import {
  getMlTradingStatus,
  matchMlTradingPattern,
  syncMlTradingData,
} from "./ml-trading.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const KITE_BASE = "https://api.kite.trade";
const TOKEN_COOKIE = "kite_access_token";

interface KiteApiResponse<T = unknown> {
  status: string;
  message?: string;
  data?: T;
}

function parseKiteResponse<T>(json: unknown): T {
  const payload = json as KiteApiResponse<T>;
  if (payload.status === "error") {
    throw new Error(payload.message ?? "Kite API error");
  }
  return payload.data as T;
}

function getAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:5173";
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function getKiteConfig() {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  const appUrl = getAppUrl();

  if (!apiKey || apiKey === "your_api_key") {
    return { configured: false as const, apiKey: null, apiSecret: null, appUrl };
  }

  return { configured: true as const, apiKey, apiSecret: apiSecret ?? "", appUrl };
}

function getLoginUrl() {
  const config = getKiteConfig();
  if (!config.configured || !config.apiKey) return null;
  const redirectUrl = `${config.appUrl}/api/kite/callback`;
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${config.apiKey}&redirect_url=${encodeURIComponent(redirectUrl)}`;
}

async function kiteGet<T>(path: string, accessToken: string): Promise<T> {
  const config = getKiteConfig();
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${config.apiKey}:${accessToken}`,
    },
  });
  const json: unknown = await res.json();
  try {
    return parseKiteResponse<T>(json);
  } catch (error) {
    throw await enrichKiteApiError(error);
  }
}

async function kitePost<T>(path: string, accessToken: string, body: Record<string, string>): Promise<T> {
  const config = getKiteConfig();
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${config.apiKey}:${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const json: unknown = await res.json();
  try {
    return parseKiteResponse<T>(json);
  } catch (error) {
    throw await enrichKiteApiError(error);
  }
}

async function kitePostJson<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  const config = getKiteConfig();
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${config.apiKey}:${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json();
  try {
    return parseKiteResponse<T>(json);
  } catch (error) {
    throw await enrichKiteApiError(error);
  }
}

async function enrichKiteApiError(error: unknown): Promise<Error> {
  const raw = error instanceof Error ? error.message : "Kite API error";
  const message = await enrichKiteIpOrderError(raw);
  return new Error(message);
}

interface KiteInstrument {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  expiry?: string;
  strike?: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
}

async function getCachedInstruments(exchange: string): Promise<KiteInstrument[]> {
  const rows = await getKiteInstruments(exchange);
  return rows.map((row) => ({
    instrument_token: row.instrument_token,
    tradingsymbol: row.tradingsymbol,
    name: row.name ?? "",
    expiry: row.expiry,
    strike: row.strike,
    lot_size: row.lot_size ?? 1,
    instrument_type: row.instrument_type ?? "",
    segment: row.segment ?? "",
    exchange: row.exchange ?? exchange,
  }));
}

interface KiteQuotePayload {
  last_price: number;
  oi?: number;
  volume?: number;
  change?: number;
  change_percent?: number;
  depth?: {
    buy?: { price: number; quantity: number; orders?: number }[];
    sell?: { price: number; quantity: number; orders?: number }[];
  };
}

function getEffectiveLtp(quote?: KiteQuotePayload) {
  if (!quote) return 0;
  if (quote.last_price > 0) return quote.last_price;

  const bid = quote.depth?.buy?.[0]?.price ?? 0;
  const ask = quote.depth?.sell?.[0]?.price ?? 0;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return bid || ask || 0;
}

function buildQuoteLookup(quotes: Record<string, KiteQuotePayload>) {
  const lookup = new Map<string, KiteQuotePayload>();

  for (const [key, value] of Object.entries(quotes)) {
    lookup.set(key, value);
    const tradingsymbol = key.includes(":") ? key.split(":").slice(1).join(":") : key;
    lookup.set(tradingsymbol, value);
  }

  return lookup;
}

function getInstrumentQuote(lookup: Map<string, KiteQuotePayload>, instrument: KiteInstrument) {
  return (
    lookup.get(`${instrument.exchange}:${instrument.tradingsymbol}`) ??
    lookup.get(instrument.tradingsymbol)
  );
}

function getOptionSide(instrument: KiteInstrument): "CE" | "PE" | null {
  if (instrument.tradingsymbol.endsWith("CE")) return "CE";
  if (instrument.tradingsymbol.endsWith("PE")) return "PE";
  if (instrument.instrument_type === "CE" || instrument.instrument_type === "PE") {
    return instrument.instrument_type;
  }
  return null;
}

function filterUnderlyingOptions(
  instruments: KiteInstrument[],
  chainSymbol: string,
  chainExchange: string
) {
  const segment = `${chainExchange}-OPT`;
  return instruments.filter(
    (item) =>
      item.segment === segment &&
      item.name === chainSymbol &&
      (item.tradingsymbol.endsWith("CE") || item.tradingsymbol.endsWith("PE"))
  );
}

function getNearestExpiry(expiries: string[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sorted = [...expiries].sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );
  const upcoming = sorted.filter((expiry) => new Date(expiry) >= today);
  return upcoming[0] ?? sorted[0];
}

async function fetchQuotesInBatches(
  accessToken: string,
  keys: string[],
  batchSize = 400
) {
  const quotes: Record<string, KiteQuotePayload> = {};

  for (let index = 0; index < keys.length; index += batchSize) {
    const batch = keys.slice(index, index + batchSize);
    const batchQuotes = await kiteGet<Record<string, KiteQuotePayload>>(
      `/quote?${batch.map((key) => `i=${encodeURIComponent(key)}`).join("&")}`,
      accessToken
    );
    Object.assign(quotes, batchQuotes);
  }

  return quotes;
}

let mcxInstrumentsCache: KiteInstrument[] | null = null;
let mcxCacheTime = 0;
const MCX_CACHE_TTL = 60 * 60 * 1000;

async function getMcxInstruments() {
  if (mcxInstrumentsCache && Date.now() - mcxCacheTime < MCX_CACHE_TTL) {
    return mcxInstrumentsCache;
  }
  mcxInstrumentsCache = await getCachedInstruments("MCX");
  mcxCacheTime = Date.now();
  return mcxInstrumentsCache;
}

function resolveNearestFutureKey(baseName: string, instruments: KiteInstrument[]) {
  const futures = instruments
    .filter((item) => item.name === baseName && item.instrument_type === "FUT" && item.expiry)
    .sort((a, b) => new Date(a.expiry!).getTime() - new Date(b.expiry!).getTime());

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nearest = futures.find((item) => new Date(item.expiry!) >= today) ?? futures[0];
  if (!nearest) return null;
  return {
    kiteKey: `${nearest.exchange}:${nearest.tradingsymbol}`,
    tradingsymbol: nearest.tradingsymbol,
    expiry: nearest.expiry,
  };
}

function resolveMcxKey(baseName: string, instruments: KiteInstrument[]) {
  const resolved = resolveNearestFutureKey(baseName, instruments);
  return resolved?.kiteKey ?? null;
}

async function resolveWatchlistKeys() {
  const mcxInstruments = await getMcxInstruments().catch(() => [] as KiteInstrument[]);

  return WATCHLIST_ITEMS.map((item) => {
    if (item.resolveMcx) {
      const resolvedKey = resolveMcxKey(item.kiteKey, mcxInstruments) ?? `MCX:${item.kiteKey}`;
      return { ...item, resolvedKey };
    }
    return { ...item, resolvedKey: item.kiteKey };
  });
}

async function resolveWatchlistInstrument(idOrKey: string) {
  const item = WATCHLIST_ITEMS.find((entry) => entry.id === idOrKey);
  if (item) {
    if (item.resolveMcx) {
      const mcxInstruments = await getMcxInstruments().catch(() => [] as KiteInstrument[]);
      return resolveMcxKey(item.kiteKey, mcxInstruments) ?? `MCX:${item.kiteKey}`;
    }
    return item.kiteKey;
  }

  return findInstrumentKey(idOrKey);
}

function formatKiteDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getHistoricalDateRange(days: number) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { from: formatKiteDateTime(from), to: formatKiteDateTime(to) };
}

const GEMINI_MODEL_OUTPUT_LIMIT = 65536;

function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
  const cacheMs = Math.max(Number(process.env.GEMINI_CACHE_MS ?? 1000), 1000);
  const entryCacheMs = Math.max(Number(process.env.GEMINI_ENTRY_CACHE_MS ?? 10000), 1000);

  const thinkingBudgetRaw = process.env.GEMINI_THINKING_BUDGET ?? "-1";
  const thinkingBudget =
    thinkingBudgetRaw === "-1" || thinkingBudgetRaw === "dynamic"
      ? -1
      : Number(thinkingBudgetRaw);

  const maxOutputTokens = Math.min(
    Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? GEMINI_MODEL_OUTPUT_LIMIT), 256),
    GEMINI_MODEL_OUTPUT_LIMIT
  );

  return {
    configured: Boolean(apiKey),
    apiKey: apiKey ?? null,
    model,
    cacheMs,
    entryCacheMs,
    thinkingBudget: Number.isFinite(thinkingBudget) ? thinkingBudget : -1,
    maxOutputTokens,
  };
}

/** Cap thinking so structured JSON output is not truncated (counts toward maxOutputTokens). */
function resolveThinkingBudget(config: ReturnType<typeof getGeminiConfig>, cap: number) {
  if (config.thinkingBudget === -1) return cap;
  return Math.min(config.thinkingBudget, cap);
}

function compactStreamingSnapshotForEntry(snapshot: Record<string, unknown> | undefined) {
  if (!snapshot) return undefined;
  const technicals = snapshot.technicals as Record<string, unknown> | undefined;
  const recentSeconds = Array.isArray(snapshot.recentSeconds)
    ? snapshot.recentSeconds.slice(-30)
    : [];
  return {
    spot: snapshot.spot,
    liveNow: snapshot.liveNow,
    recentSeconds,
    recentRsi1m: snapshot.recentRsi1m,
    technicals: technicals
      ? {
          rsi14: technicals.rsi14,
          vwap: technicals.vwap,
          ema9: technicals.ema9,
          ema20: technicals.ema20,
          ema50: technicals.ema50,
          trend: technicals.trend,
          macd: technicals.macd,
          bollinger: technicals.bollinger,
          atr14: technicals.atr14,
        }
      : undefined,
  };
}

const GEMINI_TRADE_SCHEMA = {
  type: "object",
  properties: {
    bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    action: { type: "string", enum: ["CE_BUY", "PE_BUY", "WAIT"] },
    strike: { type: "number", nullable: true },
    product: { type: "string", enum: ["MIS", "NRML"] },
    orderType: { type: "string", enum: ["MARKET", "LIMIT"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    summary: { type: "string" },
    entryPlan: { type: "string" },
    riskPlan: { type: "string" },
    invalidation: { type: "string" },
  },
  required: [
    "bias",
    "action",
    "confidence",
    "summary",
    "entryPlan",
    "riskPlan",
    "invalidation",
    "product",
    "orderType",
  ],
};

interface GeminiSuggestionPayload {
  bias: string;
  action: string;
  strike: number | null;
  product: string;
  orderType: string;
  confidence: string;
  summary: string;
  entryPlan: string;
  riskPlan: string;
  invalidation: string;
}

let geminiSuggestionCaches = new Map<
  string,
  {
    suggestion: GeminiSuggestionPayload;
    model: string;
    updatedAt: string;
    thinking?: string;
    expiry: number;
  }
>();

function geminiSuggestionCacheKey(input: Record<string, unknown>) {
  const tech = input.technicals as Record<string, unknown> | undefined;
  const spot = Math.round(Number(input.spot ?? 0));
  const rsi = Math.round(Number(tech?.rsi14 ?? input.rsi ?? 0));
  return `${String(input.underlyingId ?? "nifty50")}|${spot}|${rsi}`;
}

const RSI_PUT_BIAS_THRESHOLD = RSI_PUT_FORCE_THRESHOLD;
const RSI_CALL_BIAS_THRESHOLD = RSI_CALL_FORCE_THRESHOLD;

function extractRsi14(input: Record<string, unknown>): number | null {
  const liveNow = input.liveNow as Record<string, unknown> | undefined;
  const tech = input.technicals as Record<string, unknown> | undefined;
  const rsi = liveNow?.rsi14 ?? tech?.rsi14 ?? input.rsi;
  return typeof rsi === "number" && Number.isFinite(rsi) ? rsi : null;
}

/** RSI extremes are hard rules; 30–70 zone keeps Gemini's choice. */
function applyRsiDirectionBias(
  suggestion: GeminiSuggestionPayload,
  input: Record<string, unknown>,
): GeminiSuggestionPayload {
  const rsi = extractRsi14(input);
  if (rsi == null) return suggestion;

  if (rsi > RSI_PUT_BIAS_THRESHOLD) {
    if (suggestion.action === "PE_BUY") return suggestion;
    return {
      ...suggestion,
      action: "PE_BUY",
      bias: "bearish",
      confidence: "high",
      summary: `RSI ${rsi.toFixed(1)} > ${RSI_PUT_BIAS_THRESHOLD} → Put Buy. ${suggestion.summary}`,
    };
  }

  if (rsi < RSI_CALL_BIAS_THRESHOLD) {
    if (suggestion.action === "CE_BUY") return suggestion;
    return {
      ...suggestion,
      action: "CE_BUY",
      bias: "bullish",
      confidence: "high",
      summary: `RSI ${rsi.toFixed(1)} < ${RSI_CALL_BIAS_THRESHOLD} → Call Buy. ${suggestion.summary}`,
    };
  }

  return suggestion;
}

function extractRsiFromEntryInput(input: Record<string, unknown>): number | null {
  const snapshot = input.streamingSnapshot as Record<string, unknown> | undefined;
  if (snapshot) return extractRsi14(snapshot);
  return extractRsi14(input);
}

function applyRsiEntryGuard(
  input: Record<string, unknown>,
  payload: { signal: string; reason: string; limitPrice: number | null },
) {
  const rsi = extractRsiFromEntryInput(input);
  const planned = String(input.plannedAction ?? input.leg ?? "");
  if (rsi == null) return payload;

  if (rsi > RSI_PUT_BIAS_THRESHOLD && planned === "CE_BUY") {
    return {
      signal: "ABORT",
      reason: `RSI ${rsi.toFixed(1)} > ${RSI_PUT_BIAS_THRESHOLD} — Call Buy plan invalid; need Put Buy`,
      limitPrice: null,
    };
  }
  if (rsi < RSI_CALL_BIAS_THRESHOLD && planned === "PE_BUY") {
    return {
      signal: "ABORT",
      reason: `RSI ${rsi.toFixed(1)} < ${RSI_CALL_BIAS_THRESHOLD} — Put Buy plan invalid; need Call Buy`,
      limitPrice: null,
    };
  }
  return payload;
}

function buildGeminiTradePrompt(input: Record<string, unknown>, marketContext: ReturnType<typeof getIndianMarketContext>) {
  const label = String(input.instrumentLabel ?? "Nifty 50");
  const symbol = String(input.chainSymbol ?? "NIFTY");
  const exchange = String(input.chainExchange ?? "NFO");

  return `You are an expert Indian options intraday trader on ${exchange} (${label} / ${symbol}).

IMPORTANT — use this exact clock and session (Indian Standard Time):
- Current date & time: ${marketContext.currentDateTimeIST}
- NSE/BSE F&O session: ${marketContext.sessionHoursIST}, ${marketContext.sessionDays}
- Session status: ${marketContext.sessionStatus}${marketContext.isMarketOpen ? ` (${marketContext.minutesFromOpen} min since open, ${marketContext.minutesToClose} min to close)` : ""}

Rules:
- Underlying: ${label} (${symbol}) on ${exchange}.
- Only recommend active intraday trades when session status is "open".
- If pre_market, post_market, or closed_weekend → action should be WAIT with reason about session timing.
- After ~3:15 PM IST favour MIS square-off / no new entries unless strong edge.
- Prefer ATM or one-strike OTM weekly/monthly options (MIS for intraday).
- ENTRY actions: ONLY "CE_BUY" or "PE_BUY" (buy to open long options). NEVER "CE_SELL" or "PE_SELL" — no naked short/writing (margin). The app auto-sells to close after the profit target.
- Auto-trade loop exits each position at +₹${Number(input.exitTargetProfitInr ?? 150)} premium P&L (handled by app — do not estimate profit).
- Use liveNow (spot, volume, RSI, EMA, VWAP refreshed every second) and recentSeconds (last ~60 one-second spot+volume ticks) plus technicals, fibLevels, sessionContext, recent1s, recentRsi1m, allMarkets.
- RSI direction rules (mandatory):
  • RSI(14) > ${RSI_PUT_BIAS_THRESHOLD} → action MUST be PE_BUY (Put Buy).
  • RSI(14) < ${RSI_CALL_BIAS_THRESHOLD} → action MUST be CE_BUY (Call Buy).
  • RSI between ${RSI_CALL_BIAS_THRESHOLD} and ${RSI_PUT_BIAS_THRESHOLD} → you choose CE_BUY vs PE_BUY using EMA stack, spot vs VWAP/EMA20, MACD, trend, volume, and recentSeconds momentum.
- Weigh ema20 vs ema50 stack, spot vs ema20/vwap, and volume together when RSI is in the neutral zone.
- Keep each field concise for 1-second intraday context.

Live streaming snapshot (full technicals + multi-market context):
${JSON.stringify({ marketContext, ...input })}`;
}

const GEMINI_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    signal: { type: "string", enum: ["ENTER", "WAIT", "ABORT"] },
    reason: { type: "string" },
    limitPrice: { type: "number", nullable: true },
  },
  required: ["signal", "reason"],
};

let geminiEntryCache: {
  signal: string;
  reason: string;
  limitPrice: number | null;
  model: string;
  updatedAt: string;
} | null = null;
let geminiEntryCacheKey = "";
let geminiEntryCacheExpiry = 0;

function buildEntryCacheKey(input: Record<string, unknown>) {
  const ltp = Number(input.optionLtp ?? 0);
  const spot = Number(input.spot ?? 0);
  return [
    String(input.plannedAction ?? input.leg ?? ""),
    String(input.strike ?? ""),
    Math.round(ltp),
    Math.round(spot),
  ].join("|");
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

function extractGeminiResponse(payload: unknown) {
  const data = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(data.error.message);

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const thoughts: string[] = [];
  const outputs: string[] = [];
  const jsonFallbacks: string[] = [];

  for (const part of parts) {
    if (!part.text?.trim()) continue;
    if (part.thought) {
      thoughts.push(part.text.trim());
      if (part.text.includes("{")) jsonFallbacks.push(part.text.trim());
      continue;
    }
    outputs.push(part.text.trim());
  }

  let text = outputs.join("\n").trim();
  if (!text && jsonFallbacks.length > 0) {
    text = jsonFallbacks.join("\n").trim();
  }
  if (!text && parts.length > 0) {
    text = parts
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  }

  if (!text) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Empty Options AI response (${reason})` : "Empty response from Options AI");
  }

  return {
    text,
    thinking: thoughts.join("\n\n").trim(),
    finishReason: data.candidates?.[0]?.finishReason,
  };
}

function recoverPartialGeminiJson(text: string): Record<string, unknown> | null {
  const signalMatch = text.match(/"signal"\s*:\s*"(ENTER|WAIT|ABORT)"/i);
  if (signalMatch) {
    const reasonMatch = text.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const limitMatch = text.match(/"limitPrice"\s*:\s*(null|-?\d+(?:\.\d+)?)/);
    let limitPrice: number | null = null;
    if (limitMatch && limitMatch[1] !== "null") {
      const parsedLimit = Number(limitMatch[1]);
      limitPrice = Number.isFinite(parsedLimit) ? parsedLimit : null;
    }
    return {
      signal: signalMatch[1].toUpperCase(),
      reason: reasonMatch?.[1]?.replace(/\\"/g, '"') ?? "Recovered from partial AI response",
      limitPrice,
    };
  }

  const actionMatch = text.match(/"action"\s*:\s*"(CE_BUY|PE_BUY|WAIT)"/i);
  if (actionMatch) {
    const pick = (key: string) => text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))?.[1];
    const pickNum = (key: string) => {
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*(null|-?\\d+(?:\\.\\d+)?)`));
      if (!m || m[1] === "null") return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    };
    return {
      action: actionMatch[1].toUpperCase(),
      bias: pick("bias") ?? "neutral",
      confidence: pick("confidence") ?? "medium",
      summary: pick("summary") ?? "Recovered from partial AI response",
      entryPlan: pick("entryPlan") ?? "",
      riskPlan: pick("riskPlan") ?? "",
      invalidation: pick("invalidation") ?? "",
      product: pick("product") ?? "MIS",
      orderType: pick("orderType") ?? "MARKET",
      strike: pickNum("strike"),
    };
  }

  return null;
}

function parseGeminiJson(text: string) {
  const candidates = [
    text.trim(),
    text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    extractJsonObject(text),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try next candidate */
    }
  }

  throw new Error("Options AI returned invalid JSON");
}

function parseGeminiJsonLenient(text: string, finishReason?: string) {
  try {
    return parseGeminiJson(text);
  } catch {
    const recovered = recoverPartialGeminiJson(text);
    if (recovered) return recovered;
    if (finishReason === "MAX_TOKENS") {
      throw new Error("Options AI response truncated — increase GEMINI_MAX_OUTPUT_TOKENS");
    }
    throw new Error("Options AI returned invalid JSON");
  }
}

function normalizeGeminiSuggestion(parsed: Record<string, unknown>): GeminiSuggestionPayload {
  const entryActions = new Set(["CE_BUY", "PE_BUY"]);
  const biasValues = new Set(["bullish", "bearish", "neutral"]);
  const confidenceValues = new Set(["high", "medium", "low"]);

  const rawAction = String(parsed.action ?? "WAIT");
  const action = entryActions.has(rawAction) ? rawAction : "WAIT";
  const bias = biasValues.has(String(parsed.bias)) ? String(parsed.bias) : "neutral";
  const confidence = confidenceValues.has(String(parsed.confidence))
    ? String(parsed.confidence)
    : "medium";

  return {
    bias,
    action,
    strike: typeof parsed.strike === "number" ? parsed.strike : null,
    product: parsed.product === "NRML" ? "NRML" : "MIS",
    orderType: parsed.orderType === "MARKET" ? "MARKET" : "LIMIT",
    confidence,
    summary: String(parsed.summary ?? "No suggestion available."),
    entryPlan: String(parsed.entryPlan ?? ""),
    riskPlan: String(parsed.riskPlan ?? ""),
    invalidation: String(parsed.invalidation ?? ""),
  };
}

async function callGeminiEntry(prompt: string) {
  const config = getGeminiConfig();
  if (!config.apiKey) throw new Error("Options AI API key not configured");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: Math.max(config.maxOutputTokens, 4096),
          responseMimeType: "application/json",
          responseSchema: GEMINI_ENTRY_SCHEMA,
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: resolveThinkingBudget(config, 2048),
          },
        },
      }),
    }
  );

  const json: unknown = await res.json();
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ?? "Options AI request failed";
    throw new Error(message);
  }
  return extractGeminiResponse(json);
}

async function callGemini(prompt: string) {
  const config = getGeminiConfig();
  if (!config.apiKey) throw new Error("Options AI API key not configured");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: Math.max(config.maxOutputTokens, 8192),
          responseMimeType: "application/json",
          responseSchema: GEMINI_TRADE_SCHEMA,
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: resolveThinkingBudget(config, 6144),
          },
        },
      }),
    }
  );

  const json: unknown = await res.json();
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ?? "Options AI request failed";
    throw new Error(message);
  }
  return extractGeminiResponse(json);
}

async function fetchHistoricalCandles(
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string
) {
  const [exchange, tradingsymbol] = resolvedKey.split(":");
  const instruments = await getCachedInstruments(exchange);
  const match = instruments.find((item) => item.tradingsymbol === tradingsymbol);

  if (!match) {
    throw new Error(`Instrument not found: ${resolvedKey}`);
  }

  const data = await kiteGet<{ candles: unknown[] }>(
    `/instruments/historical/${match.instrument_token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken
  );

  return {
    instrument: resolvedKey,
    candles: data.candles ?? data,
  };
}

async function findInstrumentKey(instrument: string) {
  const [exchange, symbol] = instrument.split(":");
  if (!exchange || !symbol) return instrument;

  const watchlistMatch = WATCHLIST_ITEMS.find((item) => item.id === symbol || item.kiteKey === symbol);
  if (watchlistMatch?.resolveMcx) {
    const mcxInstruments = await getMcxInstruments().catch(() => [] as KiteInstrument[]);
    return resolveMcxKey(watchlistMatch.kiteKey, mcxInstruments) ?? instrument;
  }

  if (instrument.includes(":")) return instrument;

  const mcxInstruments = await getMcxInstruments().catch(() => [] as KiteInstrument[]);
  const resolvedMcx = resolveMcxKey(symbol, mcxInstruments);
  if (resolvedMcx) return resolvedMcx;

  return instrument;
}

app.get("/api/kite/status", async (req, res) => {
  const config = getKiteConfig();

  if (!config.configured) {
    return res.json({
      configured: false,
      connected: false,
      profile: null,
      loginUrl: null,
      message: "Zerodha integration unavailable",
    });
  }

  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) {
    return res.json({
      configured: true,
      connected: false,
      profile: null,
      loginUrl: getLoginUrl(),
    });
  }

  try {
    const profile = await kiteGet<Record<string, unknown>>("/user/profile", accessToken);
    return res.json({
      configured: true,
      connected: true,
      profile,
      loginUrl: getLoginUrl(),
    });
  } catch {
    return res.json({
      configured: true,
      connected: false,
      profile: null,
      loginUrl: getLoginUrl(),
    });
  }
});

function verifyRelaySecret(req: express.Request): boolean {
  const secret = getRelaySecret();
  if (!secret) return false;
  return req.header("X-Kite-Relay-Secret") === secret;
}

app.get("/api/kite/relay-egress-ip", async (req, res) => {
  if (!verifyRelaySecret(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const ipRes = await fetch("https://api4.ipify.org", { signal: AbortSignal.timeout(5000) });
    const ip = (await ipRes.text()).trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return res.status(502).json({ error: "Failed to detect egress IP" });
    }
    return res.json({ data: { ip } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to detect egress IP";
    return res.status(502).json({ error: message });
  }
});

app.post("/api/kite/egress-relay", async (req, res) => {
  if (!verifyRelaySecret(req)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { url, method, headers, body } = req.body as {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };

  if (!url?.startsWith(`${KITE_BASE}/`)) {
    return res.status(400).json({ error: "Only api.kite.trade URLs are allowed" });
  }

  try {
    const upstream = await fetch(url, {
      method: method ?? "GET",
      headers,
      body: body ?? undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    return res.send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relay failed";
    return res.status(502).json({ error: message });
  }
});

app.get("/api/kite/trading-ip", async (req, res) => {
  const clientIp =
    (typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
      : null) ??
    req.socket.remoteAddress ??
    null;
  const force = req.query.refresh === "1";

  try {
    const data = await buildTradingIpInfo(clientIp, force);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve trading IP";
    return res.status(502).json({ error: message });
  }
});

app.get("/api/kite/callback", async (req, res) => {
  const requestToken = req.query.request_token as string | undefined;
  const status = req.query.status as string | undefined;
  const config = getKiteConfig();
  const base = config.appUrl;

  if (status === "success" && requestToken && config.configured) {
    try {
      const checksum = crypto
        .createHash("sha256")
        .update(`${config.apiKey}${requestToken}${config.apiSecret}`)
        .digest("hex");

      const sessionRes = await kiteHttpFetch(`${KITE_BASE}/session/token`, {
        method: "POST",
        headers: {
          "X-Kite-Version": "3",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          api_key: config.apiKey!,
          request_token: requestToken,
          checksum,
        }),
      });

      const sessionJson: unknown = await sessionRes.json();
      const session = parseKiteResponse<{ access_token: string }>(sessionJson);

      res.cookie(TOKEN_COOKIE, session.access_token, {
        ...cookieOptions(),
        maxAge: 86400000,
      });

      return res.redirect(`${base}/dashboard?kite=connected`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Authentication failed";
      const message = await enrichKiteIpOrderError(raw);
      return res.redirect(`${base}/dashboard/settings?kite=error&message=${encodeURIComponent(message)}`);
    }
  }

  return res.redirect(`${base}/dashboard/settings?kite=failed`);
});

app.post("/api/kite/disconnect", (_req, res) => {
  res.clearCookie(TOKEN_COOKIE, cookieOptions());
  res.json({ success: true });
});

app.get("/api/kite/quotes", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const instruments = req.query.instruments as string;

  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  if (!instruments) return res.status(400).json({ error: "instruments query param required" });

  try {
    const list = instruments.split(",").map((s) => s.trim()).filter(Boolean);
    const quotes = await kiteGet<Record<string, unknown>>(
      `/quote?${list.map((i) => `i=${encodeURIComponent(i)}`).join("&")}`,
      accessToken
    );
    return res.json({ data: quotes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch quotes";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/watchlist-quotes", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const resolved = await resolveWatchlistKeys();
    const keys = resolved.map((item) => item.resolvedKey);
    const quotes = await kiteGet<Record<string, {
      last_price: number;
      change?: number;
      change_percent?: number;
    }>>(
      `/quote?${keys.map((key) => `i=${encodeURIComponent(key)}`).join("&")}`,
      accessToken
    );

    const data = resolved.map((item) => {
      const quote = quotes[item.resolvedKey];
      return {
        id: item.id,
        label: item.label,
        segment: item.segment,
        kiteKey: item.resolvedKey,
        quote: quote
          ? {
              last_price: quote.last_price,
              change: quote.change ?? 0,
              change_percent: quote.change_percent ?? 0,
            }
          : undefined,
      };
    });

    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch watchlist quotes";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/quote-stream", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const instrument = (req.query.instrument as string | undefined)?.trim();
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  if (!instrument) return res.status(400).json({ error: "instrument query param is required" });

  try {
    const quotes = await kiteGet<Record<string, {
      last_price: number;
      change?: number;
      change_percent?: number;
      volume?: number;
      buy_quantity?: number;
      sell_quantity?: number;
      ohlc?: { open?: number; high?: number; low?: number; close?: number };
      depth?: {
        buy?: { price: number; quantity: number; orders?: number }[];
        sell?: { price: number; quantity: number; orders?: number }[];
      };
    }>>(`/quote?i=${encodeURIComponent(instrument)}`, accessToken);
    const quote = quotes[instrument];

    return res.json({
      data: {
        instrument,
        interval: "second",
        quote: {
          last_price: quote?.last_price ?? 0,
          change: quote?.change ?? 0,
          change_percent: quote?.change_percent ?? 0,
          volume: quote?.volume ?? 0,
          cumulativeVolume: quote?.volume ?? 0,
          buy_quantity: quote?.buy_quantity,
          sell_quantity: quote?.sell_quantity,
          depth: quote?.depth,
          ohlc: quote?.ohlc,
        },
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stream quote";
    return res.status(401).json({ error: message });
  }
});

/** @deprecated use /api/kite/quote-stream?instrument=NSE:NIFTY+50 */
app.get("/api/kite/nifty-stream", async (req, res) => {
  req.query.instrument = "NSE:NIFTY 50";
  const accessToken = req.cookies[TOKEN_COOKIE];
  const instrument = "NSE:NIFTY 50";
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const quotes = await kiteGet<Record<string, {
      last_price: number;
      change?: number;
      change_percent?: number;
      volume?: number;
      ohlc?: { open?: number; high?: number; low?: number; close?: number };
    }>>(`/quote?i=${encodeURIComponent(instrument)}`, accessToken);
    const quote = quotes[instrument];
    return res.json({
      data: {
        instrument,
        interval: "second",
        quote: {
          last_price: quote?.last_price ?? 0,
          change: quote?.change ?? 0,
          change_percent: quote?.change_percent ?? 0,
          volume: quote?.volume ?? 0,
          ohlc: quote?.ohlc,
        },
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to stream Nifty data";
    return res.status(401).json({ error: message });
  }
});

const INSTRUMENT_SESSION_CACHE_MS = 60000;
const instrumentSessionCache = new Map<
  string,
  {
    data: {
      instrument: string;
      session: ReturnType<typeof buildSessionContext>;
      candles: ReturnType<typeof parseKiteCandles>;
      technicals: ReturnType<typeof buildTechnicalSnapshot> | null;
      note: string;
      updatedAt: string;
      cached?: boolean;
      stale?: boolean;
    };
    updatedAt: string;
    expiry: number;
  }
>();

async function loadInstrumentSessionPayload(accessToken: string, instrument: string) {
  const marketContext = getIndianMarketContext();
  if (!marketContext.isMarketOpen && marketContext.sessionStatus !== "post_market") {
    return {
      instrument,
      session: null,
      candles: [],
      technicals: null,
      note: `Session ${marketContext.sessionStatus}`,
      updatedAt: new Date().toISOString(),
    };
  }

  const range = getNseSessionKiteRange();
  const historical = await fetchHistoricalCandles(
    accessToken,
    instrument,
    "minute",
    range.from,
    range.to
  );
  const candles = parseKiteCandles(historical.candles as unknown[]);
  const session = buildSessionContext(candles, range.dateIST);
  const technicals = buildTechnicalSnapshot(candles);
  return {
    instrument,
    session,
    candles,
    technicals,
    note: session ? `${session.barCount} x 1m bars since 09:15 IST` : "No session candles",
    updatedAt: new Date().toISOString(),
    cached: false,
  };
}

app.get("/api/kite/nearest-future", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const underlying = ((req.query.underlying as string | undefined)?.trim() || "NIFTY").toUpperCase();
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const instruments = await getCachedInstruments("NFO");
    const resolved = resolveNearestFutureKey(underlying, instruments);
    if (!resolved) {
      return res.status(404).json({ error: `No ${underlying} future found on NFO` });
    }
    return res.json({ data: resolved });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve future";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/kite/instrument-session", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const instrument = (req.query.instrument as string | undefined)?.trim();
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  if (!instrument) return res.status(400).json({ error: "instrument query param is required" });

  const now = Date.now();
  const cached = instrumentSessionCache.get(instrument);
  if (cached && now < cached.expiry) {
    return res.json({
      data: { ...cached.data, cached: true, updatedAt: cached.updatedAt },
    });
  }

  try {
    const payload = await loadInstrumentSessionPayload(accessToken, instrument);
    instrumentSessionCache.set(instrument, {
      data: payload,
      updatedAt: payload.updatedAt,
      expiry: now + INSTRUMENT_SESSION_CACHE_MS,
    });
    return res.json({ data: payload });
  } catch (error) {
    if (cached) {
      return res.json({
        data: { ...cached.data, cached: true, stale: true },
      });
    }
    const message = error instanceof Error ? error.message : "Failed to load session";
    return res.status(502).json({ error: message });
  }
});

const NIFTY_SESSION_CACHE_MS = 60000;
let niftySessionCache: {
  data: {
    instrument: string;
    session: ReturnType<typeof buildSessionContext>;
    candles: ReturnType<typeof parseKiteCandles>;
    technicals: ReturnType<typeof buildTechnicalSnapshot> | null;
    note: string;
    updatedAt: string;
    cached?: boolean;
    stale?: boolean;
  };
  updatedAt: string;
} | null = null;
let niftySessionCacheExpiry = 0;

app.get("/api/kite/nifty-session", async (req, res) => {
  req.query.instrument = "NSE:NIFTY 50";
  const accessToken = req.cookies[TOKEN_COOKIE];
  const instrument = "NSE:NIFTY 50";
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const now = Date.now();
  if (niftySessionCache && now < niftySessionCacheExpiry) {
    return res.json({
      data: { ...niftySessionCache.data, cached: true, updatedAt: niftySessionCache.updatedAt },
    });
  }

  try {
    const payload = await loadInstrumentSessionPayload(accessToken, instrument);
    niftySessionCache = { data: payload, updatedAt: payload.updatedAt };
    niftySessionCacheExpiry = now + NIFTY_SESSION_CACHE_MS;
    return res.json({ data: payload });
  } catch (error) {
    if (niftySessionCache) {
      return res.json({
        data: { ...niftySessionCache.data, cached: true, stale: true },
      });
    }
    const message = error instanceof Error ? error.message : "Failed to load session context";
    return res.status(502).json({ error: message });
  }
});

app.post("/api/gemini/trade-suggestion", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const gemini = getGeminiConfig();
  if (!gemini.configured) {
    return res.status(503).json({ error: "Options AI API key not configured on server" });
  }

  const now = Date.now();
  const input = req.body as Record<string, unknown>;
  const cacheKey = geminiSuggestionCacheKey(input);
  const cached = geminiSuggestionCaches.get(cacheKey);
  if (cached && now < cached.expiry) {
    return res.json({
      data: {
        suggestion: cached.suggestion,
        model: cached.model,
        updatedAt: cached.updatedAt,
        thinking: cached.thinking,
        cached: true,
        refreshInMs: cached.expiry - now,
      },
    });
  }

  try {
    const marketContext = getIndianMarketContext();
    const prompt = buildGeminiTradePrompt(input, marketContext);

    const { text, thinking } = await callGemini(prompt);
    const parsed = parseGeminiJsonLenient(text);
    const suggestion = applyRsiDirectionBias(normalizeGeminiSuggestion(parsed), input);
    const payload = {
      suggestion,
      thinking: thinking || undefined,
      model: gemini.model,
      updatedAt: new Date().toISOString(),
      cached: false,
      refreshInMs: gemini.cacheMs,
    };

    geminiSuggestionCaches.set(cacheKey, {
      suggestion,
      model: gemini.model,
      updatedAt: payload.updatedAt,
      thinking: payload.thinking,
      expiry: now + gemini.cacheMs,
    });

    return res.json({ data: payload });
  } catch (error) {
    const stale = geminiSuggestionCaches.get(cacheKey);
    if (stale) {
      return res.json({
        data: {
          suggestion: stale.suggestion,
          model: stale.model,
          updatedAt: stale.updatedAt,
          thinking: stale.thinking,
          cached: true,
          stale: true,
          refreshInMs: Math.max(stale.expiry - now, 0),
          warning: error instanceof Error ? error.message : "Using last AI suggestion",
        },
      });
    }

    const message = error instanceof Error ? error.message : "Options AI suggestion failed";
    return res.status(502).json({ error: message });
  }
});

app.post("/api/gemini/entry-timing", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const gemini = getGeminiConfig();
  if (!gemini.configured) {
    return res.status(503).json({ error: "Options AI API key not configured on server" });
  }

  const now = Date.now();
  const input = req.body as Record<string, unknown>;
  const cacheKey = buildEntryCacheKey(input);
  if (geminiEntryCache && geminiEntryCacheKey === cacheKey && now < geminiEntryCacheExpiry) {
    return res.json({
      data: { ...geminiEntryCache, cached: true, refreshInMs: geminiEntryCacheExpiry - now },
    });
  }

  try {
    const marketContext = getIndianMarketContext();

    if (!marketContext.isMarketOpen) {
      const payload = {
        signal: "WAIT",
        reason: `Market ${marketContext.sessionStatus} — NSE F&O hours ${marketContext.sessionHoursIST}`,
        limitPrice: null,
        model: gemini.model,
        updatedAt: new Date().toISOString(),
        cached: false,
      };
      return res.json({ data: payload });
    }

    const prompt = `You are executing a planned NSE F&O options trade using live streaming data.
Decide if NOW is the right second to ENTER or keep WAITing.

Clock (IST): ${marketContext.currentDateTimeIST}
Session: ${marketContext.sessionStatus}, ${marketContext.minutesToClose} min to close

Exit rule: position auto-exits at +₹${Number(input.exitTargetProfitInr ?? 150)} premium P&L (app handles exit — do not estimate profit).
Entry is always a BUY (CE_BUY or PE_BUY plan only) — never sell to open.

Use streamingSnapshot.liveNow (spot, volume, RSI, EMA, VWAP every second), streamingSnapshot.recentSeconds, technicals, spot, recent1s, sessionContext, and allMarkets.
- ENTER when timing aligns with the planned direction and indicators support a quick scalp to the auto-exit.
- WAIT when timing is not ideal yet.
- ABORT when this setup is invalidated.

RSI rules for the planned leg:
- RSI > ${RSI_PUT_BIAS_THRESHOLD}: only PE_BUY plans may ENTER; ABORT a CE_BUY plan.
- RSI < ${RSI_CALL_BIAS_THRESHOLD}: only CE_BUY plans may ENTER; ABORT a PE_BUY plan.
- RSI between ${RSI_CALL_BIAS_THRESHOLD} and ${RSI_PUT_BIAS_THRESHOLD}: follow the plan if indicators agree.

Return JSON only:
- signal: ENTER | WAIT | ABORT
- reason: short explanation
- limitPrice: optional limit entry price

Planned trade + live streaming snapshot:
${JSON.stringify({
  marketContext,
  plannedAction: input.plannedAction,
  strike: input.strike,
  leg: input.leg,
  product: input.product,
  summary: input.summary,
  entryPlan: input.entryPlan,
  riskPlan: input.riskPlan,
  invalidation: input.invalidation,
  spot: input.spot,
  optionLtp: input.optionLtp,
  quantity: input.quantity,
  streamingSnapshot: compactStreamingSnapshotForEntry(
    input.streamingSnapshot as Record<string, unknown> | undefined,
  ),
})}`;

    let parsed: Record<string, unknown>;
    try {
      const { text, finishReason } = await callGeminiEntry(prompt);
      parsed = parseGeminiJsonLenient(text, finishReason);
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : "Entry timing parse failed";
      const payload = {
        signal: "WAIT",
        reason: message,
        limitPrice: null,
        model: gemini.model,
        updatedAt: new Date().toISOString(),
        cached: false,
      };
      geminiEntryCache = payload;
      geminiEntryCacheKey = cacheKey;
      geminiEntryCacheExpiry = now + gemini.entryCacheMs;
      return res.json({ data: payload });
    }
    const signal = ["ENTER", "WAIT", "ABORT"].includes(String(parsed.signal))
      ? String(parsed.signal)
      : "WAIT";

    const guarded = applyRsiEntryGuard(input, {
      signal,
      reason: String(parsed.reason ?? "Waiting for better timing"),
      limitPrice: typeof parsed.limitPrice === "number" ? parsed.limitPrice : null,
    });

    const payload = {
      signal: guarded.signal,
      reason: guarded.reason,
      limitPrice: guarded.limitPrice,
      model: gemini.model,
      updatedAt: new Date().toISOString(),
      cached: false,
    };

    geminiEntryCache = payload;
    geminiEntryCacheKey = cacheKey;
    geminiEntryCacheExpiry = now + gemini.entryCacheMs;

    return res.json({ data: payload });
  } catch (error) {
    if (geminiEntryCache) {
      return res.json({
        data: { ...geminiEntryCache, cached: true, refreshInMs: Math.max(geminiEntryCacheExpiry - now, 0) },
      });
    }
    const message = error instanceof Error ? error.message : "Entry timing failed";
    return res.status(502).json({ error: message });
  }
});

app.get("/api/kite/historical", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const id = req.query.id as string | undefined;
  const instrument = req.query.instrument as string | undefined;
  const interval = (req.query.interval as string | undefined) ?? "day";
  const days = Math.min(Math.max(Number(req.query.days ?? 365), 1), 730);
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  if (!id && !instrument) {
    return res.status(400).json({ error: "id or instrument query param is required" });
  }

  try {
    const resolvedKey = id
      ? await resolveWatchlistInstrument(id)
      : await findInstrumentKey(instrument!);
    const range = from && to ? { from, to } : getHistoricalDateRange(days);
    const historical = await fetchHistoricalCandles(
      accessToken,
      resolvedKey,
      interval,
      range.from,
      range.to
    );

    return res.json({
      data: {
        id: id ?? null,
        instrument: historical.instrument,
        interval,
        candles: historical.candles,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch historical data";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/watchlist-history", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const interval = (req.query.interval as string | undefined) ?? "day";
  const days = Math.min(Math.max(Number(req.query.days ?? 365), 1), 730);

  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const range = getHistoricalDateRange(days);
    const resolved = await resolveWatchlistKeys();

    const data = await Promise.all(
      resolved.map(async (item) => {
        try {
          const historical = await fetchHistoricalCandles(
            accessToken,
            item.resolvedKey,
            interval,
            range.from,
            range.to
          );

          return {
            id: item.id,
            label: item.label,
            segment: item.segment,
            kiteKey: historical.instrument,
            candles: historical.candles,
          };
        } catch (error) {
          return {
            id: item.id,
            label: item.label,
            segment: item.segment,
            kiteKey: item.resolvedKey,
            candles: [],
            error: error instanceof Error ? error.message : "Failed to fetch historical data",
          };
        }
      })
    );

    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch watchlist history";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/option-chain", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  const underlyingId = (req.query.underlying as string | undefined) ?? "nifty50";
  const streamInst = getStreamInstrument(underlyingId);
  const symbol = streamInst.chainSymbol;
  const exchange = streamInst.chainExchange;
  const expiryParam = req.query.expiry as string | undefined;
  const spotKey = streamInst.kiteKey;

  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const allInstruments = await getCachedInstruments(exchange);

    if (allInstruments.length === 0) {
      return res.status(502).json({ error: `Failed to load ${exchange} instrument master from Zerodha` });
    }

    const underlyingOptions = filterUnderlyingOptions(allInstruments, symbol, exchange);

    if (underlyingOptions.length === 0) {
      return res.status(404).json({ error: `No ${streamInst.label} options found` });
    }

    const expiries = [...new Set(underlyingOptions.map((i) => i.expiry).filter(Boolean))] as string[];
    const selectedExpiry = expiryParam && expiries.includes(expiryParam)
      ? expiryParam
      : getNearestExpiry(expiries);

    const expiryOptions = underlyingOptions.filter((i) => i.expiry === selectedExpiry);
    const allStrikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))];

    const spotQuotes = await fetchQuotesInBatches(accessToken, [spotKey]);
    const spotPrice = getEffectiveLtp(spotQuotes[spotKey]);

    const atmStrike = findAtmStrike(allStrikes, spotPrice);
    const visibleStrikes = filterStrikesAroundAtm(allStrikes, atmStrike, 10);
    const scopedOptions = expiryOptions.filter((i) => visibleStrikes.has(i.strike!));

    const optionQuoteKeys = scopedOptions.map((i) => `${i.exchange}:${i.tradingsymbol}`);
    const optionQuotes = optionQuoteKeys.length > 0
      ? await fetchQuotesInBatches(accessToken, optionQuoteKeys)
      : {};
    const quoteLookup = buildQuoteLookup({ ...spotQuotes, ...optionQuotes });

    const byStrike = new Map<number, { strike: number; isAtm: boolean; ce?: unknown; pe?: unknown }>();
    for (const instrument of scopedOptions) {
      const quoteData = getInstrumentQuote(quoteLookup, instrument);
      const side = getOptionSide(instrument);
      if (!side) continue;

      const lastPrice = getEffectiveLtp(quoteData);
      const greeks =
        lastPrice > 0 && spotPrice > 0
          ? calculateGreeks(spotPrice, instrument.strike!, selectedExpiry, lastPrice, side)
          : null;

      const row = byStrike.get(instrument.strike!) ?? {
        strike: instrument.strike!,
        isAtm: instrument.strike === atmStrike,
      };

      const enriched = {
        ...instrument,
        quote: quoteData
          ? {
              instrument_token: instrument.instrument_token,
              last_price: lastPrice,
              change: quoteData.change ?? 0,
              change_percent: quoteData.change_percent ?? 0,
              volume: quoteData.volume ?? 0,
              oi: quoteData.oi,
              greeks: greeks ?? undefined,
            }
          : undefined,
      };

      if (side === "CE") row.ce = enriched;
      else row.pe = enriched;
      byStrike.set(instrument.strike!, row);
    }

    const chain = Array.from(byStrike.values())
      .map((row) => ({ ...row, isAtm: row.strike === atmStrike }))
      .sort((a, b) => a.strike - b.strike);

    return res.json({
      data: {
        underlyingId: streamInst.id,
        symbol,
        exchange,
        expiry: selectedExpiry,
        expiries,
        spotPrice,
        atmStrike,
        chain,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch option chain";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/margins", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const data = await kiteGet<{
      equity?: {
        net?: number;
        available?: { live_balance?: number; cash?: number };
        utilised?: { debits?: number };
      };
    }>("/user/margins", accessToken);
    const equity = data.equity ?? {};
    return res.json({
      data: {
        available: equity.available?.live_balance ?? equity.net ?? 0,
        cash: equity.available?.cash ?? 0,
        used: equity.utilised?.debits ?? 0,
        net: equity.net ?? 0,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch balance";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/positions", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const data = await kiteGet<unknown>("/portfolio/positions", accessToken);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch positions";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/holdings", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const data = await kiteGet<unknown>("/portfolio/holdings", accessToken);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch holdings";
    return res.status(401).json({ error: message });
  }
});

app.get("/api/kite/orders/:orderId", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const data = await kiteGet<unknown[]>(`/orders/${req.params.orderId}`, accessToken);
    const order = Array.isArray(data) ? data[0] : data;
    return res.json({ data: order ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch order";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/kite/orders", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const data = await kiteGet<unknown>("/orders", accessToken);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch orders";
    return res.status(401).json({ error: message });
  }
});

/** All closed trades — merges today's Kite orders with persisted history (Kite API is day-only). */
app.get("/api/kite/portfolio/trades", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const rawOrders = await kiteGet<unknown>("/orders", accessToken);
    const list = Array.isArray(rawOrders) ? rawOrders : [];
    const store = await syncTodayOrdersIntoHistory(list);
    return res.json({
      data: store.trades,
      meta: {
        ...store.meta,
        count: store.trades.length,
        note: "Zerodha Kite API returns today's orders only. Older trades are kept from daily sync and CSV import.",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load trade history";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/kite/portfolio/trades/import", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const csv =
    typeof req.body === "string"
      ? req.body
      : typeof req.body?.csv === "string"
        ? req.body.csv
        : "";
  if (!csv.trim()) {
    return res.status(400).json({ error: "CSV body required (Console → Reports → Tradebook)" });
  }

  try {
    const store = await importTradebookCsvIntoHistory(csv);
    return res.json({
      data: store.trades,
      meta: {
        ...store.meta,
        count: store.trades.length,
        importedRows: store.trades.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to import tradebook";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/kite/order-margin", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const orders = Array.isArray(req.body) ? req.body : [req.body];
    const data = await kitePostJson<unknown[]>("/margins/orders", accessToken, orders);
    return res.json({ data: Array.isArray(data) ? data[0] : data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to calculate order margin";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/kite/orders", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    await assertKiteEgressReady();
    const marketProtection = resolveMarketProtection(process.env.KITE_MARKET_PROTECTION);
    const body = normalizeKiteOrderBody(req.body as Record<string, string | number>, marketProtection);
    const kitePath = body.variety === "bo" ? "/orders/bo" : body.variety === "co" ? "/orders/co" : "/orders/regular";
    const data = await kitePost<{ order_id: string }>(kitePath, accessToken, body);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to place order";
    return res.status(400).json({ error: message });
  }
});

function getPredictionDeps(): PredictionDeps {
  return {
    fetchCandles: fetchHistoricalCandles,
    resolveFuture: async (underlying) => {
      const instruments = await getCachedInstruments("NFO");
      const resolved = resolveNearestFutureKey(underlying, instruments);
      return resolved?.kiteKey ?? null;
    },
    getHistoricalDateRange,
  };
}

app.get("/api/prediction/status", async (req, res) => {
  try {
    const interval = (req.query.interval as string | undefined) ?? "minute";
    const data = await getPredictionStatus(interval);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load prediction status";
    return res.status(500).json({ error: message });
  }
});

app.post("/api/prediction/train", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const interval = (req.body?.interval as string | undefined) ?? "minute";
  const days = Math.min(Math.max(Number(req.body?.days ?? 60), 30), 180);

  try {
    const status = await getPredictionStatus(interval);
    if (!status.pythonAvailable) {
      return res.status(503).json({
        error: "Python 3 not found. Run: pip install -r trading-ai/requirements.txt",
      });
    }
    if (!status.xgboostAvailable) {
      return res.status(503).json({
        error: "XGBoost not available. On macOS run: brew install libomp; pip install -r trading-ai/requirements.txt",
      });
    }

    const { metrics, dataset } = await trainPredictionModel(getPredictionDeps(), accessToken, interval, days);
    return res.json({
      data: {
        metrics,
        primaryBars: dataset.instruments.find((i) => i.id === "nifty_fut")?.barCount ?? 0,
        interval,
        days,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Training failed";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/prediction/live", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const interval = (req.query.interval as string | undefined) ?? "minute";

  try {
    const status = await getPredictionStatus(interval);
    if (!status.pythonAvailable) {
      return res.status(503).json({ error: "Python 3 not available" });
    }
    if (!status.modelTrained) {
      return res.status(404).json({ error: `Model not trained yet for ${interval}` });
    }
    if (!status.schemaCurrent) {
      return res.status(409).json({
        error: `Model outdated for ${interval} — click Train model to upgrade the feature schema.`,
      });
    }

    const config = getKiteConfig();
    if (!config.configured || !config.apiKey) {
      return res.status(503).json({ error: "Kite not configured" });
    }

    const data = await livePrediction(getPredictionDeps(), accessToken, config.apiKey, interval, 5);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Prediction failed";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/prediction/atm-scenarios", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const asOf = (req.query.asOf as string | undefined)?.trim();
  const interval = (req.query.interval as string | undefined) ?? "minute";
  const probUp = Number(req.query.probUp ?? 0);
  const probDown = Number(req.query.probDown ?? 0);
  const threshold = Number(req.query.threshold ?? 0.75);
  if (!asOf) return res.status(400).json({ error: "asOf query param required" });

  const intervalMinutes =
    interval === "minute"
      ? 1
      : interval === "3minute"
        ? 3
        : interval === "5minute"
          ? 5
          : interval === "15minute"
            ? 15
            : 1;

  try {
    const config = getKiteConfig();
    if (!config.configured || !config.apiKey) {
      return res.status(503).json({ error: "Kite not configured" });
    }

    const data = await fetchLiveAtmScenarios(
      accessToken,
      config.apiKey,
      asOf,
      intervalMinutes,
      probUp,
      probDown,
      threshold,
    );
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load ATM scenarios";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/prediction/backtest", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const date = (req.query.date as string | undefined)?.trim();
  const interval = (req.query.interval as string | undefined) ?? "minute";
  if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });

  try {
    const status = await getPredictionStatus(interval);
    if (!status.pythonAvailable) {
      return res.status(503).json({ error: "Python 3 not available" });
    }
    if (!status.modelTrained) {
      return res.status(404).json({ error: `Model not trained yet for ${interval}` });
    }
    if (!status.schemaCurrent) {
      return res.status(409).json({
        error: `Model outdated for ${interval} — train first before checking historical days.`,
      });
    }

    const config = getKiteConfig();
    if (!config.configured || !config.apiKey) {
      return res.status(503).json({ error: "Kite not configured" });
    }

    const data = await backtestPredictionDay(
      getPredictionDeps(),
      accessToken,
      date,
      interval,
      config.apiKey,
    );
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backtest failed";
    return res.status(400).json({ error: message });
  }
});

function getMlTradingDeps() {
  return {
    fetchCandles: fetchHistoricalCandles,
    getHistoricalDateRange,
  };
}

app.get("/api/ml-trading/status", async (_req, res) => {
  try {
    const data = await getMlTradingStatus();
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load ML trading status";
    return res.status(500).json({ error: message });
  }
});

app.post("/api/ml-trading/sync", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const status = await getMlTradingStatus();
    if (!status.pythonAvailable) {
      return res.status(503).json({
        error: "Python 3 not found. Run: pip install -r trading-ai/requirements.txt",
      });
    }

    const data = await syncMlTradingData(getMlTradingDeps(), accessToken);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync hourly data";
    return res.status(400).json({ error: message });
  }
});

app.get("/api/ml-trading/match", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const topK = Math.min(Math.max(Number(req.query.top ?? 8), 3), 20);

  try {
    const status = await getMlTradingStatus();
    if (!status.pythonAvailable) {
      return res.status(503).json({ error: "Python 3 not available" });
    }
    if (!status.libraryBuilt) {
      return res.status(404).json({ error: "Pattern library not built — sync hourly data first" });
    }

    const config = getKiteConfig();
    if (!config.configured || !config.apiKey) {
      return res.status(503).json({ error: "Kite API not configured" });
    }

    const data = await matchMlTradingPattern(getMlTradingDeps(), accessToken, config.apiKey, topK);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pattern match failed";
    return res.status(400).json({ error: message });
  }
});

if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
  const distPath = path.join(__dirname, "../dist");
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

export default app;
