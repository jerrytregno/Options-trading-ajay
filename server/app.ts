import "./load-env.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import {
  ensureNineFifteenPayload,
  isMarketHoursIst,
  isValidMidRunKey,
  midRowsFile,
  NIFTY_INDEX_PROFILE,
  NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  type IndexProfile,
} from "./nine-fifteen-candles.js";
import { getNineSixteenBotStatus, getNineSixteenBotStatusLive, getNineSixteenBotLiveTick, listBotTradeLogs, setNineFifteenBotEnabled, setNineSixteenBotEnabled } from "./nine-sixteen-bot.js";
import {
  TRAPS_BACKTEST_DEFAULT_CAPITAL,
  TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
  TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
  TRAPS_BACKTEST_DEFAULT_STANDARD_STOP_PCT,
  TRAPS_BACKTEST_LIVE_MIN_BODY_PTS,
  TRAPS_BACKTEST_MAX_STANDARD_STOP_PCT,
  TRAPS_BACKTEST_MIN_STANDARD_STOP_PCT,
  TRAPS_BACKTEST_RELAXED_MIN_BODY_PTS,
  buildTrapsBacktest,
} from "./traps-backtest.js";
import type { TrapsBacktestResult } from "../src/types/traps-backtest.js";
import {
  getMomentumScalperBotStatus,
  getMomentumScalperBotStatusLive,
  reconcileMomentumScalperBrokerPosition,
  setMomentumScalperBotEnabled,
} from "./momentum-scalper-bot.js";
import {
  listSnapshotDates,
  loadBrokerFillsSnapshot,
  reconcileBrokerFillsWithSession,
} from "./broker-trades.js";
import { deleteBotTradeLog } from "./bot-trade-log.js";
import {
  clearNiftyLogTest,
  getNiftyLogTestStatus,
  startNiftyLogTest,
  stopNiftyLogTest,
} from "./nifty-log-test.js";
import { saveKiteSession, clearKiteSession, loadKiteSession } from "./kite-session-store.js";
import { getKiteAutoLoginStatus, triggerKiteAutoLoginNow } from "./kite-auto-login.js";
import { isRequestFromSignedInUser } from "./firebase-auth.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
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

// The backtest payload is tens of MB of highly repetitive JSON; gzip takes it down by ~95%.
app.use(compression());
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
      autoLogin: getKiteAutoLoginStatus(),
      message: "Zerodha integration unavailable",
    });
  }

  // The cookie is per-browser, but auto-login and the 9:16 bot share the token file. Fall back to
  // the stored session so any of *your* devices sees the day's connection — but only for a signed-in
  // app user, since handing the cookie to an anonymous caller would expose the whole portfolio.
  const cookieToken = req.cookies[TOKEN_COOKIE] as string | undefined;
  const storedToken = (await isRequestFromSignedInUser(req)) ? loadKiteSession()?.accessToken : undefined;
  const candidates = [cookieToken, storedToken].filter(
    (token, index, all): token is string => Boolean(token) && all.indexOf(token) === index,
  );

  for (const accessToken of candidates) {
    try {
      const profile = await kiteGet<Record<string, unknown>>("/user/profile", accessToken);
      if (accessToken !== cookieToken) {
        res.cookie(TOKEN_COOKIE, accessToken, { ...cookieOptions(), maxAge: 86400000 });
      }
      return res.json({
        configured: true,
        connected: true,
        profile,
        loginUrl: getLoginUrl(),
        autoLogin: getKiteAutoLoginStatus(),
      });
    } catch {
      /* fall through to the next token source */
    }
  }

  if (cookieToken) res.clearCookie(TOKEN_COOKIE, cookieOptions());
  return res.json({
    configured: true,
    connected: false,
    profile: null,
    loginUrl: getLoginUrl(),
    autoLogin: getKiteAutoLoginStatus(),
  });
});

/** Force a headless Kite login now instead of waiting for the 07:40 IST refresh. */
app.post("/api/kite/auto-login", async (req, res) => {
  // Hands back a live Kite cookie, so it must never answer an anonymous caller.
  if (!(await isRequestFromSignedInUser(req))) {
    return res.status(401).json({ error: "Sign in to the app first" });
  }

  const status = getKiteAutoLoginStatus();
  if (!status.configured) {
    return res.status(400).json({
      error: "Auto-login is not configured — set KITE_USER_ID, KITE_PASSWORD and KITE_TOTP_SECRET",
    });
  }

  try {
    const run = await triggerKiteAutoLoginNow();
    if (!run.ok) return res.status(502).json({ error: run.error ?? "Auto-login failed", run });

    const session = loadKiteSession();
    if (session) {
      res.cookie(TOKEN_COOKIE, session.accessToken, { ...cookieOptions(), maxAge: 86400000 });
    }
    return res.json({ success: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Auto-login failed";
    return res.status(502).json({ error: message });
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

/** Backtest profile — Nifty only. */
function resolveIndexProfile(raw: unknown): IndexProfile | null {
  const id = String(raw ?? NIFTY_INDEX_PROFILE.id).trim().toLowerCase();
  if (id === NIFTY_INDEX_PROFILE.id) return NIFTY_INDEX_PROFILE;
  return null;
}

/**
 * Builds the Nifty backtest cache after a restart so the next visitor gets a warm page
 * instead of waiting minutes for a cold build — every deploy invalidates the cache.
 *
 * A build is minutes of synchronous work, which would stall the event loop the live 9:16 bot
 * runs on, so this only ever runs with the market closed. During market hours the cache stays
 * cold and the first request rebuilds it, exactly as before.
 */
export async function warmBacktestCaches(): Promise<void> {
  if (isMarketHoursIst()) {
    console.log("[backtest-warm] market hours — skipping (first request will build)");
    return;
  }

  const session = loadKiteSession();
  if (!session?.accessToken) {
    console.log("[backtest-warm] no stored Kite session — skipping");
    return;
  }

  const started = Date.now();
  try {
    await ensureNineFifteenPayload(
      session.accessToken,
      NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
      false,
      NIFTY_INDEX_PROFILE,
    );
    console.log(`[backtest-warm] nifty ready in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[backtest-warm] nifty failed — ${message}`);
  }
}

app.get("/api/kite/nine-fifteen-candles", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const profile = resolveIndexProfile(req.query.index);
  if (!profile) {
    return res.status(400).json({ error: "Query index must be nifty" });
  }

  const days = Math.min(
    Math.max(Number(req.query.days ?? NINE_FIFTEEN_DEFAULT_HISTORY_DAYS), 30),
    NINE_FIFTEEN_DEFAULT_HISTORY_DAYS,
  );
  const force = req.query.refresh === "1";

  try {
    const { gzipPath } = await ensureNineFifteenPayload(accessToken, days, force, profile);

    /**
     * The cached file is already the gzipped response body, so stream it rather than reading it
     * back into a ~85 MB object. Bypassing `compression()` here is the point of the exercise:
     * this host has no headroom to hold a parsed payload per index.
     */
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Vary", "Accept-Encoding");
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
    if (acceptsGzip) res.setHeader("Content-Encoding", "gzip");

    const source = fs.createReadStream(gzipPath);
    source.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "Backtest cache unreadable" });
      else res.end();
    });
    return acceptsGzip
      ? source.pipe(res)
      : source.pipe(zlib.createGunzip()).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load 9:15 candles";
    return res.status(502).json({ error: message });
  }
});

/** Trade rows for one mid-backtest run, fetched only when a grid cell is expanded. */
app.get("/api/kite/mid-trade-rows", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const profile = resolveIndexProfile(req.query.index);
  if (!profile) {
    return res.status(400).json({ error: "Query index must be nifty" });
  }

  const runKey = String(req.query.run ?? "");
  if (!isValidMidRunKey(runKey)) {
    return res.status(400).json({ error: "Invalid run key" });
  }

  const file = midRowsFile(profile, runKey);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Trade rows not built yet — reload the backtest first" });
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Vary", "Accept-Encoding");
  const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
  if (acceptsGzip) res.setHeader("Content-Encoding", "gzip");

  const source = fs.createReadStream(file);
  source.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "Trade rows unreadable" });
    else res.end();
  });
  return acceptsGzip ? source.pipe(res) : source.pipe(zlib.createGunzip()).pipe(res);
});

type SessionMinuteCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

function parseSessionMinuteCandles(raw: unknown): SessionMinuteCandle[] {
  return (Array.isArray(raw) ? raw : [])
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
    .filter((c): c is SessionMinuteCandle => c != null);
}

/** Full session 1-min candles for one IST date (09:15–15:30) on either index. */
app.get("/api/kite/index-session-minutes", async (req, res) => {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const date = String(req.query.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Query date=YYYY-MM-DD required" });
  }

  const profile = resolveIndexProfile(req.query.index);
  if (!profile) {
    return res.status(400).json({ error: "Query index must be nifty" });
  }

  try {
    const from = `${date} 09:15:00`;
    const to = `${date} 15:30:00`;
    const { candles: raw } = await fetchHistoricalCandles(
      accessToken,
      profile.spotKey,
      "minute",
      from,
      to,
    );

    return res.json({
      data: {
        date,
        instrument: profile.spotKey,
        indexId: profile.id,
        indexLabel: profile.label,
        from,
        to,
        candles: parseSessionMinuteCandles(raw),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load session minutes";
    return res.status(502).json({ error: message });
  }
});

/**
 * Traps backtest over a short date range, replayed against the real option candles the bot would
 * have traded. Each run costs one Nifty history call plus one per distinct ATM contract per day,
 * so completed runs are memoised until the process restarts.
 */
const trapsBacktestCache = new Map<string, TrapsBacktestResult>();

async function handleTrapsBacktest(
  req: express.Request,
  res: express.Response,
  minBodyPts: number,
) {
  const accessToken = req.cookies[TOKEN_COOKIE];
  if (!accessToken) return res.status(401).json({ error: "Not connected to Zerodha" });

  const from = String(req.query.from ?? "").trim();
  const to = String(req.query.to ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "Query from=YYYY-MM-DD and to=YYYY-MM-DD required" });
  }
  if (from > to) {
    return res.status(400).json({ error: "from must be on or before to" });
  }

  const capital = Math.max(
    10_000,
    Math.round(Number(req.query.capital ?? TRAPS_BACKTEST_DEFAULT_CAPITAL) || TRAPS_BACKTEST_DEFAULT_CAPITAL),
  );
  const maxLots = Math.min(
    TRAPS_BACKTEST_DEFAULT_MAX_LOTS,
    Math.max(1, Math.round(Number(req.query.lots ?? TRAPS_BACKTEST_DEFAULT_MAX_LOTS) || TRAPS_BACKTEST_DEFAULT_MAX_LOTS)),
  );
  const standardStopPct = Math.min(
    TRAPS_BACKTEST_MAX_STANDARD_STOP_PCT,
    Math.max(
      TRAPS_BACKTEST_MIN_STANDARD_STOP_PCT,
      Math.round(
        Number(req.query.stop ?? TRAPS_BACKTEST_DEFAULT_STANDARD_STOP_PCT) ||
          TRAPS_BACKTEST_DEFAULT_STANDARD_STOP_PCT,
      ),
    ),
  );
  const rsiFilter = req.query.rsiFilter === "1" || req.query.rsiFilter === "true";

  const cacheKey = `${from}|${to}|${capital}|${maxLots}|body${minBodyPts}|stop${standardStopPct}|rsi${rsiFilter ? 1 : 0}`;
  if (req.query.refresh !== "1") {
    const cached = trapsBacktestCache.get(cacheKey);
    if (cached) return res.json({ data: cached, cached: true });
  }

  try {
    const result = await buildTrapsBacktest(accessToken, {
      from,
      to,
      capital,
      maxLots,
      premiumSafetyPct: TRAPS_BACKTEST_DEFAULT_SAFETY_PCT,
      minBodyPts,
      standardStopPct,
      rsiFilter,
    });
    trapsBacktestCache.set(cacheKey, result);
    return res.json({ data: result, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build the Traps backtest";
    return res.status(502).json({ error: message });
  }
}

app.get("/api/kite/traps-backtest", (req, res) =>
  void handleTrapsBacktest(req, res, TRAPS_BACKTEST_LIVE_MIN_BODY_PTS),
);

/** Same engine as traps-backtest but signal body > 1 pt instead of live Traps' > 2 pt. */
app.get("/api/kite/traps-backtest-1pt", (req, res) =>
  void handleTrapsBacktest(req, res, TRAPS_BACKTEST_RELAXED_MIN_BODY_PTS),
);

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
    const candles = parseSessionMinuteCandles(raw);

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

/**
 * Pull Zerodha's tradebook and stamp the executed fills onto every bot trade log. Safe to call
 * repeatedly — fills are keyed by trade id and logs are upserted.
 */
app.post("/api/trades/reconcile", async (_req, res) => {
  try {
    const result = await reconcileBrokerFillsWithSession();
    const store = await listBotTradeLogs();
    return res.json({ data: store.trades, meta: { updatedAt: store.updatedAt, reconcile: result } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reconcile with Zerodha";
    return res.status(500).json({ error: message });
  }
});

/** Destructive, so it answers only the signed-in app user. */
app.delete("/api/trades/:id", async (req, res) => {
  if (!(await isRequestFromSignedInUser(req))) {
    return res.status(401).json({ error: "Sign in to the app first" });
  }
  try {
    const { removed, store } = await deleteBotTradeLog(req.params.id);
    if (!removed) return res.status(404).json({ error: "Trade log not found" });
    return res.json({ data: store.trades, meta: { updatedAt: store.updatedAt } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete trade log";
    return res.status(500).json({ error: message });
  }
});

app.get("/api/broker/fills", async (req, res) => {
  try {
    const dateIst = typeof req.query.date === "string" && req.query.date ? req.query.date : null;
    if (dateIst) {
      const snapshot = await loadBrokerFillsSnapshot(dateIst);
      return res.json({ data: snapshot, meta: { dates: listSnapshotDates() } });
    }
    return res.json({ data: null, meta: { dates: listSnapshotDates() } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load broker fills";
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
  setNineSixteenBotEnabled(req.body?.enabled === true);
  try {
    const data = await getNineSixteenBotStatusLive();
    return res.json({ data });
  } catch {
    return res.json({ data: getNineSixteenBotStatus() });
  }
});

app.post("/api/nine-fifteen/bot/toggle", async (req, res) => {
  setNineFifteenBotEnabled(req.body?.enabled === true);
  try {
    const data = await getNineSixteenBotStatusLive();
    return res.json({ data });
  } catch {
    return res.json({ data: getNineSixteenBotStatus() });
  }
});

app.get("/api/momentum-scalper/bot/status", async (_req, res) => {
  try {
    const data = await getMomentumScalperBotStatusLive();
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load Traps status";
    return res.status(500).json({ error: message });
  }
});

app.post("/api/momentum-scalper/bot/toggle", async (req, res) => {
  // Strict `true` only. `Boolean()` would arm the bot on a stray "false" string or any truthy
  // value, and arming is the direction that costs money.
  setMomentumScalperBotEnabled(req.body?.enabled === true);
  try {
    const data = await getMomentumScalperBotStatusLive();
    return res.json({ data });
  } catch {
    return res.json({ data: getMomentumScalperBotStatus() });
  }
});

app.post("/api/momentum-scalper/bot/reconcile", async (_req, res) => {
  try {
    const data = await reconcileMomentumScalperBrokerPosition();
    return res.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reconcile with Zerodha";
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
