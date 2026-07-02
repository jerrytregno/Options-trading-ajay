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

dotenv.config({ path: ".env.local" });
dotenv.config();

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

function matchesOptionUnderlying(item: KiteInstrument, symbol: string) {
  if (item.name === symbol) return true;
  if (!item.tradingsymbol.startsWith(symbol)) return false;

  const suffix = item.tradingsymbol.slice(symbol.length);
  return suffix.length > 0 && /\d/.test(suffix[0]);
}

function filterOptionInstruments(instruments: KiteInstrument[], symbol: string, exchange: string) {
  const optionSegment = exchange === "BFO" ? "BFO-OPT" : "NFO-OPT";

  return instruments.filter((item) => {
    if (item.segment !== optionSegment) return false;
    if (item.instrument_type !== "CE" && item.instrument_type !== "PE") return false;
    return matchesOptionUnderlying(item, symbol);
  });
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
  const quotes: Record<string, {
    last_price: number;
    oi?: number;
    volume?: number;
    change?: number;
    change_percent?: number;
  }> = {};

  for (let index = 0; index < keys.length; index += batchSize) {
    const batch = keys.slice(index, index + batchSize);
    const batchQuotes = await kiteGet<Record<string, {
      last_price: number;
      oi?: number;
      volume?: number;
      change?: number;
      change_percent?: number;
    }>>(
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
  const symbol = (req.query.symbol as string) ?? "NIFTY";
  const exchange = (req.query.exchange as string) ?? "NFO";
  const expiryParam = req.query.expiry as string | undefined;

  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const allInstruments = await getCachedInstruments(exchange);

    if (allInstruments.length === 0) {
      return res.status(502).json({ error: `Failed to load ${exchange} instrument master from Zerodha` });
    }

    const underlyingOptions = filterOptionInstruments(allInstruments, symbol, exchange);

    if (underlyingOptions.length === 0) {
      return res.status(404).json({ error: `No options found for ${symbol}` });
    }

    const expiries = [...new Set(underlyingOptions.map((i) => i.expiry).filter(Boolean))] as string[];
    const selectedExpiry = expiryParam && expiries.includes(expiryParam)
      ? expiryParam
      : getNearestExpiry(expiries);

    const spotKeys: Record<string, string> = {
      NIFTY: "NSE:NIFTY 50",
      BANKNIFTY: "NSE:NIFTY BANK",
      FINNIFTY: "NSE:NIFTY FIN SERVICE",
      SENSEX: "BSE:SENSEX",
      RELIANCE: "NSE:RELIANCE",
      TCS: "NSE:TCS",
      INFY: "NSE:INFY",
      HDFCBANK: "NSE:HDFCBANK",
    };
    const spotKey = spotKeys[symbol] ?? (exchange === "BFO" ? "BSE:SENSEX" : "NSE:NIFTY 50");

    let spotPrice = 0;
    try {
      const spotQuotes = await kiteGet<Record<string, { last_price: number }>>(
        `/quote?i=${encodeURIComponent(spotKey)}`,
        accessToken
      );
      spotPrice = spotQuotes[spotKey]?.last_price ?? 0;
    } catch {
      spotPrice = 0;
    }

    const expiryOptions = underlyingOptions.filter((i) => i.expiry === selectedExpiry);
    const allStrikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))];
    const atmStrike = findAtmStrike(allStrikes, spotPrice);
    const visibleStrikes = filterStrikesAroundAtm(allStrikes, atmStrike, 15);
    const scopedOptions = expiryOptions.filter((i) => visibleStrikes.has(i.strike!));
    const quoteKeys = [
      ...scopedOptions.map((i) => `${i.exchange}:${i.tradingsymbol}`),
      spotKey,
    ];

    const quotes = await fetchQuotesInBatches(accessToken, quoteKeys);
    spotPrice = quotes[spotKey]?.last_price ?? spotPrice;

    const byStrike = new Map<number, { strike: number; isAtm: boolean; ce?: unknown; pe?: unknown }>();
    for (const instrument of scopedOptions) {
      const key = `${instrument.exchange}:${instrument.tradingsymbol}`;
      const quoteData = quotes[key];
      const optionType = instrument.instrument_type as "CE" | "PE";
      const greeks =
        quoteData?.last_price && spotPrice > 0
          ? calculateGreeks(spotPrice, instrument.strike!, selectedExpiry, quoteData.last_price, optionType)
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
              last_price: quoteData.last_price,
              change: quoteData.change ?? 0,
              change_percent: quoteData.change_percent ?? 0,
              volume: quoteData.volume ?? 0,
              oi: quoteData.oi,
              greeks: greeks ?? undefined,
            }
          : undefined,
      };

      if (instrument.instrument_type === "CE") row.ce = enriched;
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

app.post("/api/kite/orders", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });
  try {
    const body: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.body)) {
      body[key] = String(value);
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
