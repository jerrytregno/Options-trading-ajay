import { gunzipSync } from "node:zlib";
import { kiteHttpFetch } from "./kite-http.js";

const KITE_BASE = "https://api.kite.trade";
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Serve stale cache on rate limit / transient errors (instruments change once per day). */
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;

export interface KiteInstrumentRow {
  instrument_token: number;
  tradingsymbol: string;
  name?: string;
  expiry?: string;
  strike?: number;
  lot_size?: number;
  instrument_type?: string;
  segment?: string;
  exchange?: string;
}

type CacheEntry = { data: KiteInstrumentRow[]; time: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<KiteInstrumentRow[]>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of line) {
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

function parseInstrumentsCsv(csv: string): KiteInstrumentRow[] {
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
      lot_size: row.lot_size ? Number(row.lot_size) : undefined,
      instrument_type: row.instrument_type,
      segment: row.segment,
      exchange: row.exchange,
    }];
  });
}

async function downloadInstrumentsCsv(
  exchange: string,
  accessToken?: string,
  apiKey?: string,
): Promise<string> {
  const headers: Record<string, string> = { "X-Kite-Version": "3" };
  if (accessToken && apiKey) {
    headers.Authorization = `token ${apiKey}:${accessToken}`;
  }

  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(750 * 2 ** attempt, 8000));
    }

    const res = await kiteHttpFetch(`${KITE_BASE}/instruments/${exchange}`, { headers });
    lastStatus = res.status;

    if (res.status === 429 || res.status === 503) {
      continue;
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch ${exchange} instruments (${res.status})`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    try {
      return gunzipSync(buffer).toString("utf-8");
    } catch {
      return buffer.toString("utf-8");
    }
  }

  throw new Error(`Failed to fetch ${exchange} instruments (${lastStatus})`);
}

async function loadInstruments(
  exchange: string,
  accessToken?: string,
  apiKey?: string,
): Promise<KiteInstrumentRow[]> {
  const csv = await downloadInstrumentsCsv(exchange, accessToken, apiKey);
  return parseInstrumentsCsv(csv);
}

/** Cached Kite instrument master — deduped in-flight + stale fallback on 429. */
export async function getKiteInstruments(
  exchange: string,
  accessToken?: string,
  apiKey?: string,
): Promise<KiteInstrumentRow[]> {
  const key = exchange.toUpperCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.data;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const data = await loadInstruments(key, accessToken, apiKey);
      cache.set(key, { data, time: Date.now() });
      return data;
    } catch (err) {
      if (cached && Date.now() - cached.time < STALE_MAX_MS) {
        console.warn(
          `[kite-instruments] ${key} unavailable — using stale cache (${Math.round((Date.now() - cached.time) / 60_000)}m old)`,
          err instanceof Error ? err.message : err,
        );
        return cached.data;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}
