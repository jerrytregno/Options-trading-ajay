import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WATCHLIST_ITEMS } from "../src/lib/watchlist.js";
import {
  calculateGreeks,
  filterStrikesAroundAtm,
  findAtmStrike,
} from "../src/lib/greeks.js";
import { getIndianMarketContext } from "../src/lib/market-time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env.local") });
dotenv.config({ path: path.join(projectRoot, ".env") });
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
  const res = await fetch(`${KITE_BASE}${path}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${config.apiKey}:${accessToken}`,
    },
  });
  const json: unknown = await res.json();
  return parseKiteResponse<T>(json);
}

async function kitePost<T>(path: string, accessToken: string, body: Record<string, string>): Promise<T> {
  const config = getKiteConfig();
  const res = await fetch(`${KITE_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${config.apiKey}:${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const json: unknown = await res.json();
  return parseKiteResponse<T>(json);
}

async function kitePostJson<T>(path: string, accessToken: string, body: unknown): Promise<T> {
  const config = getKiteConfig();
  const res = await fetch(`${KITE_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${config.apiKey}:${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json();
  return parseKiteResponse<T>(json);
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

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseInstrumentsCsv(csv: string): KiteInstrument[] {
  const normalized = csv.replace(/^\uFEFF/, "").trim();
  const lines = normalized.split("\n");
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).flatMap((line) => {
    if (!line.trim()) return [];

    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header.trim()] = values[index]?.trim() ?? "";
    });

    const instrumentToken = Number(row.instrument_token);
    if (!Number.isFinite(instrumentToken)) return [];

    return [{
      instrument_token: instrumentToken,
      tradingsymbol: row.tradingsymbol,
      name: row.name,
      expiry: row.expiry || undefined,
      strike: row.strike ? Number(row.strike) : undefined,
      lot_size: Number(row.lot_size),
      instrument_type: row.instrument_type,
      segment: row.segment,
      exchange: row.exchange,
    }];
  });
}

const instrumentsCache = new Map<string, { data: KiteInstrument[]; time: number }>();
const INSTRUMENTS_CACHE_TTL = 60 * 60 * 1000;

async function fetchInstruments(exchange: string): Promise<KiteInstrument[]> {
  const res = await fetch(`${KITE_BASE}/instruments/${exchange}`, {
    headers: { "X-Kite-Version": "3" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${exchange} instruments (${res.status})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  let csv: string;

  try {
    csv = gunzipSync(buffer).toString("utf-8");
  } catch {
    csv = buffer.toString("utf-8");
  }

  return parseInstrumentsCsv(csv);
}

async function getCachedInstruments(exchange: string) {
  const cached = instrumentsCache.get(exchange);
  if (cached && Date.now() - cached.time < INSTRUMENTS_CACHE_TTL) {
    return cached.data;
  }

  const data = await fetchInstruments(exchange);
  instrumentsCache.set(exchange, { data, time: Date.now() });
  return data;
}

interface KiteQuotePayload {
  last_price: number;
  oi?: number;
  volume?: number;
  change?: number;
  change_percent?: number;
  depth?: {
    buy?: { price: number; quantity: number }[];
    sell?: { price: number; quantity: number }[];
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

function filterNiftyOptions(instruments: KiteInstrument[]) {
  return instruments.filter(
    (item) =>
      item.segment === "NFO-OPT" &&
      /^NIFTY\d/.test(item.tradingsymbol) &&
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

function resolveMcxKey(baseName: string, instruments: KiteInstrument[]) {
  const futures = instruments
    .filter((item) => item.name === baseName && item.instrument_type === "FUT" && item.expiry)
    .sort((a, b) => new Date(a.expiry!).getTime() - new Date(b.expiry!).getTime());

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nearest = futures.find((item) => new Date(item.expiry!) >= today) ?? futures[0];
  return nearest ? `${nearest.exchange}:${nearest.tradingsymbol}` : null;
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
  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const cacheMs = Math.max(Number(process.env.GEMINI_CACHE_MS ?? 1000), 1000);
  const entryCacheMs = Math.max(Number(process.env.GEMINI_ENTRY_CACHE_MS ?? 15000), 5000);

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

const GEMINI_TRADE_SCHEMA = {
  type: "object",
  properties: {
    bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    action: { type: "string", enum: ["CE_BUY", "CE_SELL", "PE_BUY", "PE_SELL", "WAIT"] },
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

let geminiSuggestionCache: {
  suggestion: GeminiSuggestionPayload;
  model: string;
  updatedAt: string;
  thinking?: string;
} | null = null;
let geminiSuggestionCacheExpiry = 0;

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

  for (const part of parts) {
    if (!part.text?.trim()) continue;
    if (part.thought) thoughts.push(part.text.trim());
    else outputs.push(part.text.trim());
  }

  let text = outputs.join("\n").trim();
  if (!text && parts.length > 0) {
    text = parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  }

  if (!text) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Empty Gemini response (${reason})` : "Empty response from Gemini");
  }

  return {
    text,
    thinking: thoughts.join("\n\n").trim(),
  };
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

  throw new Error("Gemini returned invalid JSON");
}

function normalizeGeminiSuggestion(parsed: Record<string, unknown>): GeminiSuggestionPayload {
  const actionValues = new Set(["CE_BUY", "CE_SELL", "PE_BUY", "PE_SELL", "WAIT"]);
  const biasValues = new Set(["bullish", "bearish", "neutral"]);
  const confidenceValues = new Set(["high", "medium", "low"]);

  const action = actionValues.has(String(parsed.action)) ? String(parsed.action) : "WAIT";
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
  if (!config.apiKey) throw new Error("Gemini API key not configured");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
          responseSchema: GEMINI_ENTRY_SCHEMA,
          thinkingConfig: {
            includeThoughts: false,
            thinkingBudget: 1024,
          },
        },
      }),
    }
  );

  const json: unknown = await res.json();
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ?? "Gemini request failed";
    throw new Error(message);
  }
  return extractGeminiResponse(json);
}

async function callGemini(prompt: string) {
  const config = getGeminiConfig();
  if (!config.apiKey) throw new Error("Gemini API key not configured");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: config.maxOutputTokens,
          responseMimeType: "application/json",
          responseSchema: GEMINI_TRADE_SCHEMA,
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: config.thinkingBudget,
          },
        },
      }),
    }
  );

  const json: unknown = await res.json();
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } }).error?.message ?? "Gemini request failed";
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

      const sessionRes = await fetch(`${KITE_BASE}/session/token`, {
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
      const message = error instanceof Error ? error.message : "Authentication failed";
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

app.get("/api/kite/nifty-stream", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const instrument = "NSE:NIFTY 50";
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

app.post("/api/gemini/trade-suggestion", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const gemini = getGeminiConfig();
  if (!gemini.configured) {
    return res.status(503).json({ error: "Gemini API key not configured on server" });
  }

  const now = Date.now();
  if (geminiSuggestionCache && now < geminiSuggestionCacheExpiry) {
    return res.json({
      data: {
        ...geminiSuggestionCache,
        cached: true,
        refreshInMs: geminiSuggestionCacheExpiry - now,
      },
    });
  }

  try {
    const input = req.body as Record<string, unknown>;
    const marketContext = getIndianMarketContext();
    const snapshot = { marketContext, ...input };

    const prompt = `You are an expert Indian Nifty 50 options intraday trader on NSE F&O.

IMPORTANT — use this exact clock and session (Indian Standard Time):
- Current date & time: ${marketContext.currentDateTimeIST}
- NSE F&O session: ${marketContext.sessionHoursIST}, ${marketContext.sessionDays}
- Session status: ${marketContext.sessionStatus}${marketContext.isMarketOpen ? ` (${marketContext.minutesFromOpen} min since open, ${marketContext.minutesToClose} min to close)` : ""}

Rules:
- Only recommend active intraday trades when session status is "open".
- If pre_market, post_market, or closed_weekend → action should be WAIT with reason about session timing.
- After ~3:15 PM IST favour MIS square-off / no new entries unless strong edge.
- Prefer ATM or one-strike OTM Nifty weekly options (MIS for intraday).
- Keep each field concise for 1-second intraday context.

Live snapshot (includes marketContext):
${JSON.stringify(snapshot)}`;

    const { text, thinking } = await callGemini(prompt);
    const parsed = parseGeminiJson(text);
    const suggestion = normalizeGeminiSuggestion(parsed);
    const payload = {
      suggestion,
      thinking: thinking || undefined,
      model: gemini.model,
      updatedAt: new Date().toISOString(),
      cached: false,
      refreshInMs: gemini.cacheMs,
    };

    geminiSuggestionCache = {
      suggestion,
      model: gemini.model,
      updatedAt: payload.updatedAt,
      thinking: payload.thinking,
    };
    geminiSuggestionCacheExpiry = now + gemini.cacheMs;

    return res.json({ data: payload });
  } catch (error) {
    if (geminiSuggestionCache) {
      return res.json({
        data: {
          ...geminiSuggestionCache,
          cached: true,
          stale: true,
          refreshInMs: Math.max(geminiSuggestionCacheExpiry - now, 0),
          warning: error instanceof Error ? error.message : "Using last AI suggestion",
        },
      });
    }

    const message = error instanceof Error ? error.message : "Gemini suggestion failed";
    return res.status(502).json({ error: message });
  }
});

app.post("/api/gemini/entry-timing", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const gemini = getGeminiConfig();
  if (!gemini.configured) {
    return res.status(503).json({ error: "Gemini API key not configured on server" });
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

    const prompt = `You are executing a planned Nifty 50 options trade on NSE F&O.
Decide if NOW is the right second to ENTER or keep WAITing.

Clock (IST): ${marketContext.currentDateTimeIST}
Session: ${marketContext.sessionStatus}, ${marketContext.minutesToClose} min to close

Return JSON only:
- ENTER when entry conditions from the plan are met NOW (momentum, premium, spot vs strike). If the setup is still valid and premium is tradeable, prefer ENTER over prolonged WAIT.
- WAIT only when timing is genuinely not ideal yet (max ~1-2 checks), not indefinitely.
- ABORT when invalidation/risk plan is breached — do not enter.

Planned trade snapshot:
${JSON.stringify({ marketContext, ...input })}`;

    const { text } = await callGeminiEntry(prompt);
    const parsed = parseGeminiJson(text);
    const signal = ["ENTER", "WAIT", "ABORT"].includes(String(parsed.signal))
      ? String(parsed.signal)
      : "WAIT";

    const payload = {
      signal,
      reason: String(parsed.reason ?? "Waiting for better timing"),
      limitPrice: typeof parsed.limitPrice === "number" ? parsed.limitPrice : null,
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
  const symbol = "NIFTY";
  const exchange = "NFO";
  const expiryParam = req.query.expiry as string | undefined;
  const spotKey = "NSE:NIFTY 50";

  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const allInstruments = await getCachedInstruments(exchange);

    if (allInstruments.length === 0) {
      return res.status(502).json({ error: "Failed to load NFO instrument master from Zerodha" });
    }

    const underlyingOptions = filterNiftyOptions(allInstruments);

    if (underlyingOptions.length === 0) {
      return res.status(404).json({ error: "No Nifty 50 options found" });
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
    const body: Record<string, string> = { variety: "regular" };
    for (const [key, value] of Object.entries(req.body)) {
      if (value === undefined || value === null || value === "") continue;
      body[key] = String(value);
    }
    if (body.exchange === "NFO" && body.product === "CNC") {
      body.product = "NRML";
    }
    const data = await kitePost<{ order_id: string }>("/orders/regular", accessToken, body);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to place order";
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
