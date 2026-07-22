import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { checkPython } from "./prediction.js";
import { enrichBatchBacktestWithOptionTargets, enrichMlTradingWithOptionTrades } from "./ml-trading-options.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_AI_DIR = path.join(__dirname, "../trading-ai");
const ML_DATA_DIR = path.join(TRADING_AI_DIR, "data/ml-trading");
const RAW_CANDLES_PATH = path.join(ML_DATA_DIR, "hourly_nifty_candles.json");
const META_PATH = path.join(ML_DATA_DIR, "meta.json");

export const ML_TRADING_INTERVAL = "60minute";
export const ML_TRADING_DAYS = 365;
export const NIFTY_SPOT_KEY = "NSE:NIFTY 50";

function formatKiteDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function getMlBatchBacktestCandleRange(tradingDays: number): { from: string; to: string } {
  const to = new Date();
  to.setHours(15, 29, 59, 0);
  const from = new Date(to);
  // N sessions + 365d lookback for earliest target + weekends/holidays buffer
  from.setDate(from.getDate() - tradingDays - 400);
  from.setHours(9, 15, 0, 0);
  return { from: formatKiteDateTime(from), to: formatKiteDateTime(to) };
}

export function getMlBacktestDateRange(targetDate: string): { from: string; to: string } {
  const target = new Date(`${targetDate}T12:00:00+05:30`);
  if (Number.isNaN(target.getTime())) {
    throw new Error("Invalid target date — use YYYY-MM-DD");
  }
  const start = new Date(target);
  start.setDate(start.getDate() - 365);
  start.setHours(9, 15, 0, 0);
  const end = new Date(target);
  end.setHours(15, 29, 59, 0);
  return { from: formatKiteDateTime(start), to: formatKiteDateTime(end) };
}

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00+05:30`).getTime());
}

export type CandleFetcher = (
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) => Promise<{ instrument: string; candles: unknown[] }>;

export type DateRangeFn = (days: number) => { from: string; to: string };

export interface MlTradingDeps {
  fetchCandles: CandleFetcher;
  getHistoricalDateRange: DateRangeFn;
}

export interface MlTradingStatus {
  pythonAvailable: boolean;
  pythonVersion: string | null;
  libraryBuilt: boolean;
  patternCount: number;
  firstDate: string | null;
  lastDate: string | null;
  lastSyncedAt: string | null;
  candleCount: number;
  instrument: string;
  interval: string;
  days: number;
  note: string;
}

function runMlTradingPython(stdin: Record<string, unknown>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [path.join(TRADING_AI_DIR, "ml_trading.py")], {
      cwd: TRADING_AI_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(JSON.stringify(stdin));
    child.stdin.end();
  });
}

function parsePythonJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Python returned empty output");
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(trimmed.slice(0, 400) || "Invalid Python JSON output");
  }
}

function readMeta(): { lastSyncedAt?: string; candleCount?: number } {
  try {
    if (!fs.existsSync(META_PATH)) return {};
    return JSON.parse(fs.readFileSync(META_PATH, "utf-8")) as { lastSyncedAt?: string; candleCount?: number };
  } catch {
    return {};
  }
}

function writeMeta(meta: { lastSyncedAt: string; candleCount: number; from: string; to: string }) {
  fs.mkdirSync(ML_DATA_DIR, { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), "utf-8");
}

export async function getMlTradingStatus(): Promise<MlTradingStatus> {
  const py = await checkPython();
  const meta = readMeta();

  let libraryBuilt = false;
  let patternCount = 0;
  let firstDate: string | null = null;
  let lastDate: string | null = null;

  if (py.ok) {
    try {
      const { code, stdout, stderr } = await runMlTradingPython({ action: "status" });
      if (code === 0) {
        const json = parsePythonJson(stdout);
        libraryBuilt = Boolean(json.libraryBuilt);
        patternCount = Number(json.patternCount ?? 0);
        firstDate = typeof json.firstDate === "string" ? json.firstDate : null;
        lastDate = typeof json.lastDate === "string" ? json.lastDate : null;
      } else if (stderr) {
        console.warn("[ml-trading] status stderr:", stderr);
      }
    } catch (err) {
      console.warn("[ml-trading] status failed:", err);
    }
  }

  return {
    pythonAvailable: py.ok,
    pythonVersion: py.version,
    libraryBuilt,
    patternCount,
    firstDate,
    lastDate,
    lastSyncedAt: meta.lastSyncedAt ?? null,
    candleCount: meta.candleCount ?? 0,
    instrument: NIFTY_SPOT_KEY,
    interval: ML_TRADING_INTERVAL,
    days: ML_TRADING_DAYS,
    note: libraryBuilt
      ? "Week-pattern matching ready — today's full-hour forecast from similar historical weeks."
      : "Sync 1 year of hourly NIFTY 50 candles to build the pattern library.",
  };
}

export async function syncMlTradingData(
  deps: MlTradingDeps,
  accessToken: string,
): Promise<{ candleCount: number; patternCount: number; firstDate: string | null; lastDate: string | null }> {
  const range = deps.getHistoricalDateRange(ML_TRADING_DAYS);
  const { candles } = await deps.fetchCandles(
    accessToken,
    NIFTY_SPOT_KEY,
    ML_TRADING_INTERVAL,
    range.from,
    range.to,
  );

  if (!Array.isArray(candles) || candles.length < 20) {
    throw new Error(`Not enough hourly candles (${candles?.length ?? 0}). Need Zerodha historical access.`);
  }

  fs.mkdirSync(ML_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    RAW_CANDLES_PATH,
    JSON.stringify(
      {
        instrument: NIFTY_SPOT_KEY,
        interval: ML_TRADING_INTERVAL,
        from: range.from,
        to: range.to,
        candles,
      },
      null,
      2,
    ),
    "utf-8",
  );

  writeMeta({
    lastSyncedAt: new Date().toISOString(),
    candleCount: candles.length,
    from: range.from,
    to: range.to,
  });

  const { code, stdout, stderr } = await runMlTradingPython({ action: "build", candles });
  const json = parsePythonJson(stdout);
  if (code !== 0 || !json.ok) {
    throw new Error(String(json.error ?? stderr ?? "Failed to build pattern library"));
  }

  return {
    candleCount: candles.length,
    patternCount: Number(json.patternCount ?? 0),
    firstDate: typeof json.firstDate === "string" ? json.firstDate : null,
    lastDate: typeof json.lastDate === "string" ? json.lastDate : null,
  };
}

export async function matchMlTradingPattern(
  deps: MlTradingDeps,
  accessToken: string,
  apiKey: string,
  topK = 8,
  targetProfitInr?: number,
): Promise<Record<string, unknown>> {
  let candles: unknown[] = [];
  const range = deps.getHistoricalDateRange(10);
  try {
    const fresh = await deps.fetchCandles(
      accessToken,
      NIFTY_SPOT_KEY,
      ML_TRADING_INTERVAL,
      range.from,
      range.to,
    );
    candles = fresh.candles ?? [];
  } catch {
    // fall back to cached library only
  }

  if (candles.length === 0 && fs.existsSync(RAW_CANDLES_PATH)) {
    const cached = JSON.parse(fs.readFileSync(RAW_CANDLES_PATH, "utf-8")) as { candles?: unknown[] };
    candles = cached.candles ?? [];
  }

  const { code, stdout, stderr } = await runMlTradingPython({
    action: "match",
    candles,
    topK,
  });
  const json = parsePythonJson(stdout);
  if (code !== 0 || !json.ok) {
    throw new Error(String(json.error ?? stderr ?? "Pattern match failed"));
  }

  const base = (json.data as Record<string, unknown>) ?? {};
  return enrichMlTradingWithOptionTrades(accessToken, apiKey, base, targetProfitInr);
}

export async function backtestMlTrading(
  deps: MlTradingDeps,
  accessToken: string,
  targetDate: string,
  topK = 8,
  simulationBars = 1,
): Promise<Record<string, unknown>> {
  if (!isValidIsoDate(targetDate)) {
    throw new Error("Invalid date — use YYYY-MM-DD");
  }

  const range = getMlBacktestDateRange(targetDate);
  const { candles } = await deps.fetchCandles(
    accessToken,
    NIFTY_SPOT_KEY,
    ML_TRADING_INTERVAL,
    range.from,
    range.to,
  );

  if (!Array.isArray(candles) || candles.length < 100) {
    throw new Error(
      `Not enough hourly candles for backtest (${candles?.length ?? 0}). Need Zerodha historical access for ${range.from} → ${range.to}.`,
    );
  }

  const { code, stdout, stderr } = await runMlTradingPython({
    action: "backtest",
    candles,
    targetDate,
    topK,
    simulationBars,
  });
  const json = parsePythonJson(stdout);
  if (code !== 0 || !json.ok) {
    throw new Error(String(json.error ?? stderr ?? "ML trading backtest failed"));
  }

  return (json.data as Record<string, unknown>) ?? {};
}

export async function backtestMlTradingBatch(
  deps: MlTradingDeps,
  accessToken: string,
  apiKey: string,
  days = 30,
  topK = 8,
  simulationBars = 1,
  targetProfitInr?: number,
): Promise<Record<string, unknown>> {
  const safeDays = Math.min(Math.max(days, 5), 60);
  const range = getMlBatchBacktestCandleRange(safeDays);

  let candles: unknown[] = [];
  try {
    const fetched = await deps.fetchCandles(
      accessToken,
      NIFTY_SPOT_KEY,
      ML_TRADING_INTERVAL,
      range.from,
      range.to,
    );
    candles = fetched.candles ?? [];
  } catch {
    // fall through to cache
  }

  if (candles.length < 500 && fs.existsSync(RAW_CANDLES_PATH)) {
    const cached = JSON.parse(fs.readFileSync(RAW_CANDLES_PATH, "utf-8")) as { candles?: unknown[] };
    if ((cached.candles?.length ?? 0) > candles.length) {
      candles = cached.candles ?? [];
    }
  }

  if (!Array.isArray(candles) || candles.length < 500) {
    throw new Error(
      `Not enough hourly candles for ${safeDays}-day batch backtest (${candles?.length ?? 0}). Sync ML data or connect Kite historical access.`,
    );
  }

  const { code, stdout, stderr } = await runMlTradingPython({
    action: "backtest-batch",
    candles,
    days: safeDays,
    topK,
    simulationBars,
  });
  const json = parsePythonJson(stdout);
  if (code !== 0 || !json.ok) {
    throw new Error(String(json.error ?? stderr ?? "ML batch backtest failed"));
  }

  const base = (json.data as Record<string, unknown>) ?? {};
  return enrichBatchBacktestWithOptionTargets(accessToken, apiKey, base, targetProfitInr);
}
