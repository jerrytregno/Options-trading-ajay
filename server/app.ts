import "./load-env.js";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { fetchNineFifteenCandleHistory, NINE_FIFTEEN_DEFAULT_HISTORY_DAYS } from "./nine-fifteen-candles.js";
import { getNineSixteenBotStatus, getNineSixteenBotStatusLive, getNineSixteenBotLiveTick, listBotTradeLogs, setNineSixteenBotEnabled } from "./nine-sixteen-bot.js";
import {
  clearNiftyLogTest,
  getNiftyLogTestStatus,
  startNiftyLogTest,
  stopNiftyLogTest,
} from "./nifty-log-test.js";
import { saveKiteSession, clearKiteSession } from "./kite-session-store.js";
import { getKiteInstruments } from "./kite-instruments.js";
import { getRelaySecret, kiteHttpFetch, probeDirectIpv4 } from "./kite-http.js";
import { kiteGet, parseKiteResponse } from "./kite-client.js";
import { buildTradingIpInfo, enrichKiteIpOrderError } from "./trading-ip.js";
import {
  importTradebookCsvIntoHistory,
  syncTodayOrdersIntoHistory,
} from "./trade-history.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const KITE_BASE = "https://api.kite.trade";
const TOKEN_COOKIE = "kite_access_token";

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

async function fetchHistoricalCandles(
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) {
  const [exchange, tradingsymbol] = resolvedKey.split(":");
  const instruments = await getCachedInstruments(exchange);
  const match = instruments.find((item) => item.tradingsymbol === tradingsymbol);

  if (!match) {
    throw new Error(`Instrument not found: ${resolvedKey}`);
  }

  const data = await kiteGet<{ candles: unknown[] }>(
    `/instruments/historical/${match.instrument_token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken,
  );

  return {
    instrument: resolvedKey,
    candles: data.candles ?? data,
  };
}

function verifyRelaySecret(req: express.Request): boolean {
  const secret = getRelaySecret();
  if (!secret) return false;
  return req.header("X-Kite-Relay-Secret") === secret;
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

app.get("/api/kite/public-egress-ip", async (_req, res) => {
  try {
    const ip = await probeDirectIpv4(true);
    if (!ip) {
      return res.status(502).json({ error: "Failed to detect egress IP" });
    }
    return res.json({ data: { ip } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to detect egress IP";
    return res.status(502).json({ error: message });
  }
});

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

      const sessionText = await sessionRes.text();
      if (!sessionText.trim() || /^\s*</.test(sessionText)) {
        throw new Error(
          `Kite login returned HTML instead of JSON (HTTP ${sessionRes.status})`,
        );
      }
      let sessionJson: unknown;
      try {
        sessionJson = JSON.parse(sessionText) as unknown;
      } catch {
        throw new Error(
          `Kite login returned non-JSON (HTTP ${sessionRes.status}): ${sessionText.replace(/\s+/g, " ").trim().slice(0, 80)}`,
        );
      }
      const session = parseKiteResponse<{ access_token: string }>(sessionJson);

      let userId: string | undefined;
      let userName: string | undefined;
      try {
        const profile = await kiteGet<{ user_id?: string; user_name?: string }>(
          "/user/profile",
          session.access_token,
        );
        userId = profile.user_id;
        userName = profile.user_name;
      } catch {
        /* profile optional for bot session file */
      }

      saveKiteSession({
        accessToken: session.access_token,
        savedAt: new Date().toISOString(),
        userId,
        userName,
      });

      res.cookie(TOKEN_COOKIE, session.access_token, {
        ...cookieOptions(),
        maxAge: 86400000,
      });

      return res.redirect(`${base}/dashboard/settings?kite=connected`);
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
  clearKiteSession();
  res.json({ success: true });
});

app.get("/api/kite/nine-fifteen-candles", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const days = Math.min(
    Math.max(Number(req.query.days ?? NINE_FIFTEEN_DEFAULT_HISTORY_DAYS), 30),
    NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  );
  const force = req.query.refresh === "1";

  try {
    const data = await fetchNineFifteenCandleHistory(accessToken, fetchHistoricalCandles, days, force);
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load 9:15 candles";
    return res.status(502).json({ error: message });
  }
});

/** Full NSE session 1-min Nifty 50 candles for one IST date (09:15–15:30). */
app.get("/api/kite/nifty-session-minutes", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const date = String(req.query.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Query date=YYYY-MM-DD required" });
  }

  try {
    const from = `${date} 09:15:00`;
    const to = `${date} 15:30:00`;
    const { candles: raw } = await fetchHistoricalCandles(
      accessToken,
      "NSE:NIFTY 50",
      "minute",
      from,
      to,
    );
    const candles = (Array.isArray(raw) ? raw : [])
      .map((row) => {
        if (!Array.isArray(row) || row.length < 5) return null;
        const [time, open, high, low, close] = row;
        if (
          typeof time !== "string" ||
          ![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))
        ) {
          return null;
        }
        return {
          time,
          open: open as number,
          high: high as number,
          low: low as number,
          close: close as number,
        };
      })
      .filter((c): c is { time: string; open: number; high: number; low: number; close: number } => c != null);

    return res.json({
      data: {
        date,
        instrument: "NSE:NIFTY 50",
        from,
        to,
        candles,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load session minutes";
    return res.status(502).json({ error: message });
  }
});

/** Live positions, holdings, and margins — polled from Zerodha for real-time P&L. */
app.get("/api/kite/portfolio/live", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  try {
    const [positions, holdings, margins] = await Promise.all([
      kiteGet<{ net?: unknown[]; day?: unknown[] }>("/portfolio/positions", accessToken),
      kiteGet<unknown[]>("/portfolio/holdings", accessToken),
      kiteGet<{
        equity?: {
          net?: number;
          available?: { live_balance?: number; cash?: number };
          utilised?: { debits?: number };
        };
      }>("/user/margins", accessToken),
    ]);

    const equity = margins.equity ?? {};
    return res.json({
      data: {
        positions,
        holdings: holdings ?? [],
        margins: {
          available: equity.available?.live_balance ?? equity.net ?? 0,
          cash: equity.available?.cash ?? 0,
          used: equity.utilised?.debits ?? 0,
          net: equity.net ?? 0,
        },
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch live portfolio";
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

app.get("/api/nine-sixteen/bot/status", async (_req, res) => {
  try {
    const data = await getNineSixteenBotStatusLive();
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load bot status";
    return res.status(500).json({ error: message });
  }
});

app.get("/api/nine-sixteen/bot/live", async (_req, res) => {
  try {
    const data = await getNineSixteenBotLiveTick();
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load live P&L";
    return res.status(500).json({ error: message });
  }
});

app.get("/api/trades", async (_req, res) => {
  try {
    const store = await listBotTradeLogs();
    return res.json({
      data: store.trades,
      meta: { updatedAt: store.updatedAt },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load trade logs";
    return res.status(500).json({ error: message });
  }
});

app.get("/api/log-test/status", (_req, res) => {
  return res.json({ data: getNiftyLogTestStatus() });
});

app.post("/api/log-test/start", async (_req, res) => {
  try {
    const data = await startNiftyLogTest();
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start log test";
    return res.status(400).json({ error: message });
  }
});

app.post("/api/log-test/stop", (_req, res) => {
  return res.json({ data: stopNiftyLogTest() });
});

app.post("/api/log-test/clear", (_req, res) => {
  return res.json({ data: clearNiftyLogTest() });
});

app.post("/api/nine-sixteen/bot/toggle", async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  setNineSixteenBotEnabled(enabled);
  try {
    const data = await getNineSixteenBotStatusLive();
    return res.json({ data });
  } catch {
    return res.json({ data: getNineSixteenBotStatus() });
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
