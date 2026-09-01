import crypto from "crypto";
import { kiteGet, parseKiteResponse } from "./kite-client.js";
import { kiteHttpFetch } from "./kite-http.js";
import {
  kiteSessionAgeHours,
  loadKiteSession,
  saveKiteSession,
} from "./kite-session-store.js";
import { generateTotp, msLeftInTotpStep } from "./kite-totp.js";
import { istMsOfDay } from "./nine-sixteen-logic.js";

const KITE_WEB = "https://kite.zerodha.com";
const KITE_API = "https://api.kite.trade";

/**
 * Zerodha flushes every access token between ~05:00 and 07:30 IST. A token minted at or after
 * 07:30 survives until the next morning's flush, so refresh just after the window closes.
 */
const FLUSH_END_MS_OF_DAY = (7 * 60 + 30) * 60_000;
const REFRESH_AT_MS_OF_DAY = (7 * 60 + 40) * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 90_000;

export interface KiteAutoLoginRun {
  at: string;
  ok: boolean;
  attempts: number;
  userId?: string;
  error?: string;
}

let lastRun: KiteAutoLoginRun | null = null;
let running = false;
let dailyTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;

export function isKiteAutoLoginConfigured(): boolean {
  return Boolean(
    process.env.KITE_API_KEY?.trim() &&
      process.env.KITE_API_SECRET?.trim() &&
      process.env.KITE_USER_ID?.trim() &&
      process.env.KITE_PASSWORD?.trim() &&
      process.env.KITE_TOTP_SECRET?.trim(),
  );
}

export function getKiteAutoLoginStatus() {
  return {
    enabled: process.env.KITE_AUTO_LOGIN_ENABLED === "1",
    configured: isKiteAutoLoginConfigured(),
    refreshAtIst: "07:40",
    running,
    lastRun,
  };
}

/** Epoch ms of the most recent 07:30 IST token flush. */
export function lastFlushBoundaryMs(nowMs = Date.now()): number {
  const istMidnight = nowMs - istMsOfDay(nowMs);
  const todayFlush = istMidnight + FLUSH_END_MS_OF_DAY;
  return nowMs >= todayFlush ? todayFlush : todayFlush - DAY_MS;
}

/** True when the stored token was minted after the last flush, so it is still good for today. */
export function isStoredSessionFreshForToday(nowMs = Date.now()): boolean {
  const session = loadKiteSession();
  if (!session) return false;
  const saved = new Date(session.savedAt).getTime();
  if (!Number.isFinite(saved)) return false;
  return saved >= lastFlushBoundaryMs(nowMs);
}

/**
 * Minimal cookie jar. Zerodha's login, 2FA and connect-redirect steps all share one session,
 * and the global fetch has no jar of its own.
 */
class CookieJar {
  private jar = new Map<string, string>();

  absorb(res: Response): void {
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const raw = headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    for (const line of raw) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function loginHeaders(jar: CookieJar, extra: Record<string, string> = {}): Record<string, string> {
  const cookie = jar.header();
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: `${KITE_WEB}/`,
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

async function readJson(res: Response, step: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${step} returned non-JSON (HTTP ${res.status}): ${text.replace(/\s+/g, " ").trim().slice(0, 120)}`,
    );
  }
}

function kiteErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const message = typeof body.message === "string" ? body.message : null;
  return message || fallback;
}

/**
 * Drives Zerodha's internal login endpoints to obtain a one-time `request_token` without a browser.
 * These endpoints are undocumented and can change without notice.
 */
async function fetchRequestToken(apiKey: string): Promise<string> {
  const userId = process.env.KITE_USER_ID!.trim();
  const password = process.env.KITE_PASSWORD!;
  const totpSecret = process.env.KITE_TOTP_SECRET!.trim();

  const jar = new CookieJar();
  const connectUrl = `${KITE_WEB}/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;

  const primed = await fetch(connectUrl, { headers: loginHeaders(jar), redirect: "follow" });
  jar.absorb(primed);

  const loginRes = await fetch(`${KITE_WEB}/api/login`, {
    method: "POST",
    headers: loginHeaders(jar, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ user_id: userId, password }),
    redirect: "manual",
  });
  jar.absorb(loginRes);

  const loginBody = await readJson(loginRes, "Kite login");
  const loginData = loginBody.data as { request_id?: string } | undefined;
  if (!loginData?.request_id) {
    throw new Error(kiteErrorMessage(loginBody, "Kite rejected the user ID or password"));
  }

  // A code within a second of rolling over is often rejected — wait for the next step instead.
  if (msLeftInTotpStep() < 2_000) {
    await new Promise((resolve) => setTimeout(resolve, msLeftInTotpStep() + 500));
  }

  const twofaRes = await fetch(`${KITE_WEB}/api/twofa`, {
    method: "POST",
    headers: loginHeaders(jar, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({
      user_id: userId,
      request_id: loginData.request_id,
      twofa_value: generateTotp(totpSecret),
      twofa_type: "totp",
      skip_session: "true",
    }),
    redirect: "manual",
  });
  jar.absorb(twofaRes);

  const twofaBody = await readJson(twofaRes, "Kite 2FA");
  const twofaData = twofaBody.data as { request_token?: string } | undefined;
  if (twofaRes.status >= 400 && !twofaData?.request_token) {
    throw new Error(kiteErrorMessage(twofaBody, "Kite rejected the TOTP code"));
  }
  if (twofaData?.request_token) return twofaData.request_token;

  // Otherwise the token arrives on the connect redirect chain, which must not be auto-followed.
  let next: string | null = `${connectUrl}&skip_session=true`;
  for (let hop = 0; hop < 10 && next; hop += 1) {
    const found = new URL(next, KITE_WEB).searchParams.get("request_token");
    if (found) return found;

    const res: Response = await fetch(next, { headers: loginHeaders(jar), redirect: "manual" });
    jar.absorb(res);
    const location = res.headers.get("location");
    if (!location) {
      const finalToken = new URL(res.url, KITE_WEB).searchParams.get("request_token");
      if (finalToken) return finalToken;
      break;
    }
    next = new URL(location, KITE_WEB).toString();
  }

  throw new Error("Login succeeded but Kite never returned a request_token");
}

/** Exchange the one-time request token for the day's access token and persist it. */
async function exchangeRequestToken(apiKey: string, apiSecret: string, requestToken: string) {
  const checksum = crypto
    .createHash("sha256")
    .update(`${apiKey}${requestToken}${apiSecret}`)
    .digest("hex");

  const res = await kiteHttpFetch(`${KITE_API}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
  });

  const body = await readJson(res, "Kite token exchange");
  const session = parseKiteResponse<{ access_token: string }>(body);

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
    /* profile is a nicety — the token itself is what the bot needs */
  }

  saveKiteSession({
    accessToken: session.access_token,
    savedAt: new Date().toISOString(),
    userId,
    userName,
  });

  return { accessToken: session.access_token, userId, userName };
}

/** One full headless login. Throws on failure so callers can decide whether to retry. */
export async function runKiteAutoLogin(): Promise<{ accessToken: string; userId?: string }> {
  if (!isKiteAutoLoginConfigured()) {
    throw new Error(
      "Auto-login needs KITE_API_KEY, KITE_API_SECRET, KITE_USER_ID, KITE_PASSWORD and KITE_TOTP_SECRET",
    );
  }

  const apiKey = process.env.KITE_API_KEY!.trim();
  const apiSecret = process.env.KITE_API_SECRET!.trim();
  const requestToken = await fetchRequestToken(apiKey);
  return exchangeRequestToken(apiKey, apiSecret, requestToken);
}

/** True when the stored token still answers `/user/profile`. */
async function storedSessionWorks(): Promise<boolean> {
  const session = loadKiteSession();
  if (!session) return false;
  try {
    await kiteGet("/user/profile", session.accessToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * Login with retries. Resolves once a token is stored (or a fresh one already is), and gives up
 * after `MAX_ATTEMPTS` so a broken password cannot spin all morning.
 */
async function refreshWithRetries(reason: string, force = false): Promise<KiteAutoLoginRun> {
  if (running) return lastRun ?? { at: new Date().toISOString(), ok: false, attempts: 0, error: "already running" };
  running = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  try {
    if (!force && isStoredSessionFreshForToday() && (await storedSessionWorks())) {
      console.log(`[kite-auto-login] ${reason}: today's token is already valid — skipping`);
      lastRun = { at: new Date().toISOString(), ok: true, attempts: 0, userId: loadKiteSession()?.userId };
      return lastRun;
    }

    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const { userId } = await runKiteAutoLogin();
        console.log(`[kite-auto-login] ${reason}: connected as ${userId ?? "Kite user"} on attempt ${attempt}`);
        lastRun = { at: new Date().toISOString(), ok: true, attempts: attempt, userId };
        return lastRun;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(`[kite-auto-login] ${reason}: attempt ${attempt}/${MAX_ATTEMPTS} failed — ${lastError}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    console.error(`[kite-auto-login] ${reason}: giving up — connect Kite manually in Settings`);
    lastRun = { at: new Date().toISOString(), ok: false, attempts: MAX_ATTEMPTS, error: lastError };
    return lastRun;
  } finally {
    running = false;
  }
}

/** Force a login now, ignoring any stored token. Used by the manual Settings button. */
export function triggerKiteAutoLoginNow(): Promise<KiteAutoLoginRun> {
  return refreshWithRetries("manual", true);
}

export function msUntilRefresh(nowMs = Date.now()): number {
  const delay = REFRESH_AT_MS_OF_DAY - istMsOfDay(nowMs);
  return delay > 0 ? delay : delay + DAY_MS;
}

function scheduleNextRefresh(): void {
  if (dailyTimer) clearTimeout(dailyTimer);
  const delay = msUntilRefresh();
  dailyTimer = setTimeout(() => {
    void refreshWithRetries("07:40 IST refresh").finally(scheduleNextRefresh);
  }, delay);
  dailyTimer.unref?.();

  const mins = Math.round(delay / 60_000);
  console.log(`[kite-auto-login] next refresh in ${Math.floor(mins / 60)}h ${mins % 60}m (07:40 IST)`);
}

/**
 * Arm the daily 07:40 IST refresh. Also logs in immediately when the process starts after the
 * morning flush without a usable token, so a restart or deploy never leaves the bot disconnected.
 */
export function startKiteAutoLogin(): void {
  if (!isKiteAutoLoginConfigured()) {
    console.warn(
      "[kite-auto-login] enabled but credentials are incomplete — need KITE_USER_ID, KITE_PASSWORD and KITE_TOTP_SECRET (external TOTP setup key; Zerodha-app-only 2FA cannot be automated)",
    );
    return;
  }

  scheduleNextRefresh();

  if (istMsOfDay() >= FLUSH_END_MS_OF_DAY && !isStoredSessionFreshForToday()) {
    console.log("[kite-auto-login] startup: no token for today — logging in now");
    void refreshWithRetries("startup");
  }
}

/** Age of the stored session in hours, or null when nothing is stored. */
export function storedSessionAgeHours(): number | null {
  const session = loadKiteSession();
  return session ? kiteSessionAgeHours(session) : null;
}
