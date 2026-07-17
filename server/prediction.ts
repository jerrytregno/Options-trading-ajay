import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  buildPredictionLiveSnapshot,
  fetchGeminiSentimentFeatures,
} from "./prediction-snapshot.js";
import { enrichBacktestWithOptionPnl } from "./prediction-option-pnl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADING_AI_DIR = path.join(__dirname, "../trading-ai");
const DATA_DIR = path.join(TRADING_AI_DIR, "data");
const MODEL_DIR = path.join(TRADING_AI_DIR, "model");

export const PREDICTION_INTERVALS = ["minute", "3minute", "5minute", "15minute"] as const;
export type PredictionInterval = (typeof PREDICTION_INTERVALS)[number];

const INTERVAL_MINUTES: Record<PredictionInterval, number> = {
  minute: 1,
  "3minute": 3,
  "5minute": 5,
  "15minute": 15,
};

export const PREDICTION_PRIMARY_ID = "nifty_fut";

export const PREDICTION_AUX_INSTRUMENTS = [
  { id: "banknifty", kiteKey: "NSE:NIFTY BANK", label: "Bank Nifty" },
  { id: "vix", kiteKey: "NSE:INDIA VIX", label: "India VIX" },
  { id: "reliance", kiteKey: "NSE:RELIANCE", label: "Reliance" },
  { id: "hdfc", kiteKey: "NSE:HDFCBANK", label: "HDFC Bank" },
  { id: "icici", kiteKey: "NSE:ICICIBANK", label: "ICICI Bank" },
  { id: "infy", kiteKey: "NSE:INFY", label: "Infosys" },
  { id: "tcs", kiteKey: "NSE:TCS", label: "TCS" },
] as const;

export type CandleFetcher = (
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) => Promise<{ instrument: string; candles: unknown[] }>;

export type FutureResolver = (underlying: string) => Promise<string | null>;

export interface PredictionDeps {
  fetchCandles: CandleFetcher;
  resolveFuture: FutureResolver;
  getHistoricalDateRange: (days: number) => { from: string; to: string };
}

export interface PredictionStatus {
  interval: PredictionInterval;
  pythonAvailable: boolean;
  pythonVersion: string | null;
  xgboostAvailable: boolean;
  modelTrained: boolean;
  schemaCurrent: boolean;
  metrics: Record<string, unknown> | null;
  instruments: Array<{ id: string; label: string; kiteKey?: string }>;
  primaryId: string;
  note: string;
  trainingDateRange?: { min: string; max: string } | null;
}

export const PREDICTION_SCHEMA_VERSION = 3;

export function parsePredictionInterval(value: string | undefined | null): PredictionInterval {
  if (value && (PREDICTION_INTERVALS as readonly string[]).includes(value)) {
    return value as PredictionInterval;
  }
  return "minute";
}

export function horizonKey(interval: PredictionInterval): string {
  return `next_${interval}_candle`;
}

function intervalDataDir(interval: PredictionInterval) {
  return path.join(DATA_DIR, interval);
}

function rawPath(interval: PredictionInterval) {
  const current = path.join(intervalDataDir(interval), "raw_instruments.json");
  if (fs.existsSync(current)) return current;
  if (interval === "minute") {
    const legacy = path.join(DATA_DIR, "raw_instruments.json");
    if (fs.existsSync(legacy)) return legacy;
  }
  return current;
}

function intervalModelDir(interval: PredictionInterval) {
  return path.join(MODEL_DIR, interval);
}

function modelPath(interval: PredictionInterval) {
  const current = path.join(intervalModelDir(interval), "ensemble_nifty.pkl");
  if (fs.existsSync(current)) return current;
  if (interval === "minute") {
    const legacy = path.join(MODEL_DIR, "ensemble_nifty.pkl");
    if (fs.existsSync(legacy)) return legacy;
  }
  return current;
}

function legacyModelPath(interval: PredictionInterval) {
  if (interval === "minute") {
    return path.join(MODEL_DIR, "xgb_nifty.pkl");
  }
  return path.join(intervalModelDir(interval), "xgb_nifty.pkl");
}

function metricsPath(interval: PredictionInterval) {
  const current = path.join(intervalModelDir(interval), "metrics.json");
  if (fs.existsSync(current)) return current;
  if (interval === "minute") {
    const legacy = path.join(MODEL_DIR, "metrics.json");
    if (fs.existsSync(legacy)) return legacy;
  }
  return current;
}

function minTrainingBars(interval: PredictionInterval) {
  return Math.max(100, Math.floor(300 / INTERVAL_MINUTES[interval]));
}

function intervalLabel(interval: PredictionInterval) {
  return interval === "minute" ? "1 min" : interval.replace("minute", " min");
}

function runPython(
  script: string,
  options?: { stdin?: string; interval?: PredictionInterval },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const interval = options?.interval ?? "minute";
  return new Promise((resolve) => {
    const child = spawn("python3", [path.join(TRADING_AI_DIR, script)], {
      cwd: TRADING_AI_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PREDICTION_INTERVAL: interval,
      },
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
    if (options?.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

export async function checkPython(): Promise<{ ok: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["--version"]);
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.stderr.on("data", (c) => {
      out += String(c);
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, version: out.trim() || null });
    });
    child.on("error", () => resolve({ ok: false, version: null }));
  });
}

export async function checkMlStack(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("python3", [
      "-c",
      "from xgboost import XGBClassifier; from lightgbm import LGBMClassifier; from catboost import CatBoostClassifier",
    ]);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function readMetrics(interval: PredictionInterval): Record<string, unknown> | null {
  const file = metricsPath(interval);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isModelSchemaCurrent(metrics: Record<string, unknown> | null, interval: PredictionInterval): boolean {
  if (!modelExists(interval)) return false;
  if (!metrics) return false;
  if (metrics.schemaVersion !== PREDICTION_SCHEMA_VERSION) return false;
  const expectedHorizon = horizonKey(interval);
  if (metrics.horizon !== expectedHorizon && !(interval === "minute" && metrics.horizon === "next_1m_candle")) {
    return false;
  }
  if (metrics.modelType !== "ensemble_xgb_lgbm_cat" && metrics.modelType !== "directional_binary_ensemble") {
    return false;
  }
  const features = metrics.features;
  return (
    Array.isArray(features) &&
    features.includes("return_1m") &&
    !features.includes("returns_1")
  );
}

function modelExists(interval: PredictionInterval): boolean {
  return fs.existsSync(modelPath(interval)) || fs.existsSync(legacyModelPath(interval));
}

function formatPythonError(stderr: string, stdout: string, interval: PredictionInterval): string {
  const combined = `${stderr}\n${stdout}`;
  if (/libomp|libxgboost|OpenMP/i.test(combined)) {
    return "XGBoost needs OpenMP on macOS. Run: brew install libomp, then retry training.";
  }
  if (/training data did not have the following fields|feature schema/i.test(combined)) {
    return `Model outdated — click Train model to upgrade the ${intervalLabel(interval)} feature schema.`;
  }
  const lines = combined.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last?.startsWith("{")) {
    try {
      const parsed = JSON.parse(last) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      // ignore
    }
  }
  return last ?? "Python script failed";
}

export async function getPredictionStatus(intervalInput?: string): Promise<PredictionStatus> {
  const interval = parsePredictionInterval(intervalInput);
  const py = await checkPython();
  const xgboostAvailable = py.ok ? await checkMlStack() : false;
  const metrics = readMetrics(interval);

  const modelTrained = modelExists(interval);
  const schemaCurrent = isModelSchemaCurrent(metrics, interval);
  const label = intervalLabel(interval);

  let note = `Next ${label} candle · Up/Down directional model · trained on meaningful moves (≥0.05%). Retrain after schema updates.`;
  if (!py.ok) {
    note = "Install Python 3 and run: pip install -r trading-ai/requirements.txt";
  } else if (!xgboostAvailable) {
    note = "ML stack failed to load. Run: pip install -r trading-ai/requirements.txt && brew install libomp (macOS)";
  } else if (!modelTrained) {
    note = `Connect Kite, then train on ${label} history (walk-forward validated). Each interval has its own model.`;
  } else if (!schemaCurrent) {
    note = `Model outdated for ${label} — click Train model once to upgrade the feature schema.`;
  }

  const trainingRaw = loadTrainingRawDataset(interval);
  const trainingDateRange = trainingRaw ? getTrainingDateBounds(trainingRaw) : null;

  return {
    interval,
    pythonAvailable: py.ok,
    pythonVersion: py.version,
    xgboostAvailable,
    modelTrained,
    schemaCurrent,
    metrics,
    instruments: [
      { id: PREDICTION_PRIMARY_ID, label: "Nifty Futures (primary)" },
      ...PREDICTION_AUX_INSTRUMENTS.map((i) => ({ id: i.id, label: i.label, kiteKey: i.kiteKey })),
    ],
    primaryId: PREDICTION_PRIMARY_ID,
    note,
    trainingDateRange,
  };
}

async function loadInstrumentCandles(
  deps: PredictionDeps,
  accessToken: string,
  id: string,
  kiteKey: string,
  interval: string,
  days: number,
) {
  const range = deps.getHistoricalDateRange(days);
  return loadInstrumentCandlesRange(deps, accessToken, id, kiteKey, interval, range.from, range.to);
}

async function loadInstrumentCandlesRange(
  deps: PredictionDeps,
  accessToken: string,
  id: string,
  kiteKey: string,
  interval: string,
  from: string,
  to: string,
) {
  const historical = await deps.fetchCandles(accessToken, kiteKey, interval, from, to);
  return {
    id,
    kiteKey: historical.instrument,
    candles: historical.candles,
    barCount: Array.isArray(historical.candles) ? historical.candles.length : 0,
  };
}

interface TrainingRawPayload {
  primaryId: string;
  interval?: string;
  days?: number;
  instruments: Array<{
    id: string;
    kiteKey?: string;
    candles: unknown[];
    barCount?: number;
  }>;
  exportedAt?: string;
}

function istDateFromTimestamp(value: string | number | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function loadTrainingRawDataset(interval: PredictionInterval): TrainingRawPayload | null {
  const file = rawPath(interval);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as TrainingRawPayload;
  } catch {
    return null;
  }
}

function getTrainingDateBounds(raw: TrainingRawPayload): { min: string; max: string } | null {
  const primary = raw.instruments.find((item) => item.id === raw.primaryId) ?? raw.instruments[0];
  if (!primary?.candles?.length) return null;

  let min = "9999-99-99";
  let max = "0000-00-00";
  for (const candle of primary.candles) {
    if (!Array.isArray(candle) || candle[0] == null) continue;
    const day = istDateFromTimestamp(String(candle[0]));
    if (day < min) min = day;
    if (day > max) max = day;
  }
  if (min === "9999-99-99") return null;
  return { min, max };
}

const BACKTEST_MIN_HISTORY_BARS = 21;

function filterCandlesForWalkForwardBacktest(
  candles: unknown[],
  targetDate: string,
): { candles: unknown[]; historyBars: number; targetBars: number } {
  const kept: unknown[] = [];
  let historyBars = 0;
  let targetBars = 0;

  for (const candle of candles) {
    if (!Array.isArray(candle) || candle[0] == null) continue;
    const day = istDateFromTimestamp(String(candle[0]));
    if (day < targetDate) {
      kept.push(candle);
      historyBars += 1;
    } else if (day === targetDate) {
      kept.push(candle);
      targetBars += 1;
    }
  }

  return { candles: kept, historyBars, targetBars };
}

function getTodayIstDate(): string {
  return istDateFromTimestamp(new Date());
}

function getTomorrowIstDate(): string {
  const today = getTodayIstDate();
  const d = new Date(`${today}T12:00:00+05:30`);
  d.setDate(d.getDate() + 1);
  return istDateFromTimestamp(d);
}

function isTodayIst(dateStr: string): boolean {
  return dateStr === getTodayIstDate();
}

function isTomorrowIst(dateStr: string): boolean {
  return dateStr === getTomorrowIstDate();
}

function isLiveBacktestDate(dateStr: string): boolean {
  return isTodayIst(dateStr) || isTomorrowIst(dateStr);
}

function mergeCandlesByTime(existing: unknown[], incoming: unknown[]): unknown[] {
  const byTime = new Map<string, unknown>();
  for (const candle of [...existing, ...incoming]) {
    if (!Array.isArray(candle) || candle[0] == null) continue;
    byTime.set(String(candle[0]), candle);
  }
  return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
}

async function prepareBacktestPayload(
  deps: PredictionDeps,
  accessToken: string,
  interval: PredictionInterval,
  dateStr: string,
) {
  const raw = loadTrainingRawDataset(interval);
  if (!raw) {
    throw new Error(
      "Train the model first. Check model uses your saved training candles (60 days by default).",
    );
  }

  const liveToday = isLiveBacktestDate(dateStr);
  let sourceInstruments = raw.instruments;

  if (liveToday) {
    const live = await assembleRawDataset(deps, accessToken, interval, 5);
    sourceInstruments = raw.instruments.map((inst) => {
      const liveInst = live.instruments.find((i) => i.id === inst.id);
      const history = (inst.candles ?? []).filter(
        (c) => Array.isArray(c) && c[0] && istDateFromTimestamp(String(c[0])) < dateStr,
      );
      const sessionLive = (liveInst?.candles ?? []).filter(
        (c) => Array.isArray(c) && c[0] && istDateFromTimestamp(String(c[0])) === dateStr,
      );
      const candles = mergeCandlesByTime(history, sessionLive);
      return { ...inst, candles, barCount: candles.length };
    });
  }

  const instruments = sourceInstruments.map((item) => {
    const sliced = filterCandlesForWalkForwardBacktest(item.candles ?? [], dateStr);
    return {
      ...item,
      candles: sliced.candles,
      barCount: sliced.candles.length,
    };
  });

  const primary = instruments.find((item) => item.id === PREDICTION_PRIMARY_ID);
  if (!primary?.candles?.length) {
    throw new Error(`No training candles found for ${dateStr}.`);
  }

  const primarySlice = filterCandlesForWalkForwardBacktest(
    sourceInstruments.find((item) => item.id === PREDICTION_PRIMARY_ID)?.candles ?? [],
    dateStr,
  );
  const { historyBars, targetBars } = primarySlice;

  if (targetBars === 0) {
    if (!liveToday) {
      throw new Error(`No training data for ${dateStr}. Pick a date inside your trained range.`);
    }
    if (historyBars < BACKTEST_MIN_HISTORY_BARS) {
      throw new Error(
        `Not enough candles before ${dateStr} (${historyBars}). Pick a later date or retrain with 60 days.`,
      );
    }
  } else if (historyBars < BACKTEST_MIN_HISTORY_BARS) {
    throw new Error(
      `Not enough candles before ${dateStr} (${historyBars}). Pick a later date or retrain with 60 days.`,
    );
  }

  return {
    primaryId: raw.primaryId ?? PREDICTION_PRIMARY_ID,
    interval: raw.interval ?? interval,
    days: raw.days,
    instruments,
    exportedAt: raw.exportedAt,
    source: liveToday ? "training_data+live" : "training_data",
    targetDate: dateStr,
    historyBars,
    targetBars,
    liveToday,
    asOf: new Date().toISOString(),
  };
}

export function validateBacktestDate(dateStr: string, interval: PredictionInterval = "minute") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error("Invalid date format. Use YYYY-MM-DD.");
  }

  const picked = new Date(`${dateStr}T12:00:00+05:30`);
  const tomorrowIst = new Date(`${getTomorrowIstDate()}T23:59:59+05:30`);
  if (picked > tomorrowIst) {
    throw new Error("Date cannot be more than 1 day ahead (tomorrow IST).");
  }

  const raw = loadTrainingRawDataset(interval);
  if (!raw) {
    throw new Error(
      "Train the model first. Check model reads from your saved training candles.",
    );
  }

  const bounds = getTrainingDateBounds(raw);
  if (!bounds) {
    throw new Error("Training dataset has no candle dates. Retrain the model.");
  }

  if (dateStr < bounds.min) {
    throw new Error(`Pick a date on or after ${bounds.min} from your training data.`);
  }
  if (!isLiveBacktestDate(dateStr) && dateStr > bounds.max) {
    throw new Error(`Pick a date within your training data (${bounds.min} to ${bounds.max}).`);
  }

  const primary = raw.instruments.find((item) => item.id === PREDICTION_PRIMARY_ID);
  const slice = filterCandlesForWalkForwardBacktest(primary?.candles ?? [], dateStr);
  const liveToday = isLiveBacktestDate(dateStr);
  if (!liveToday && slice.targetBars === 0) {
    throw new Error(`No candles on ${dateStr} in your training data (${bounds.min} to ${bounds.max}).`);
  }
  if (slice.historyBars < BACKTEST_MIN_HISTORY_BARS) {
    throw new Error(
      `Not enough candles before ${dateStr} (${slice.historyBars}). Pick a later date in your training range.`,
    );
  }
}

export async function buildRawDatasetForRange(
  deps: PredictionDeps,
  accessToken: string,
  interval: PredictionInterval,
  from: string,
  to: string,
) {
  const niftyFut = await deps.resolveFuture("NIFTY");
  if (!niftyFut) {
    throw new Error("Could not resolve nearest Nifty future on NFO");
  }

  const primary = await loadInstrumentCandlesRange(
    deps,
    accessToken,
    PREDICTION_PRIMARY_ID,
    niftyFut,
    interval,
    from,
    to,
  );

  const aux = await Promise.all(
    PREDICTION_AUX_INSTRUMENTS.map(async (item) => {
      try {
        return await loadInstrumentCandlesRange(
          deps,
          accessToken,
          item.id,
          item.kiteKey,
          interval,
          from,
          to,
        );
      } catch (error) {
        return {
          id: item.id,
          kiteKey: item.kiteKey,
          candles: [],
          barCount: 0,
          error: error instanceof Error ? error.message : "Failed",
        };
      }
    }),
  );

  return {
    primaryId: PREDICTION_PRIMARY_ID,
    interval,
    instruments: [primary, ...aux],
    exportedAt: new Date().toISOString(),
  };
}

export async function assembleRawDataset(
  deps: PredictionDeps,
  accessToken: string,
  interval: PredictionInterval,
  days: number,
) {
  const niftyFut = await deps.resolveFuture("NIFTY");
  if (!niftyFut) {
    throw new Error("Could not resolve nearest Nifty future on NFO");
  }

  const primary = await loadInstrumentCandles(
    deps,
    accessToken,
    PREDICTION_PRIMARY_ID,
    niftyFut,
    interval,
    days,
  );

  const aux = await Promise.all(
    PREDICTION_AUX_INSTRUMENTS.map(async (item) => {
      try {
        return await loadInstrumentCandles(deps, accessToken, item.id, item.kiteKey, interval, days);
      } catch (error) {
        return {
          id: item.id,
          kiteKey: item.kiteKey,
          candles: [],
          barCount: 0,
          error: error instanceof Error ? error.message : "Failed",
        };
      }
    }),
  );

  return {
    primaryId: PREDICTION_PRIMARY_ID,
    interval,
    days,
    instruments: [primary, ...aux],
    exportedAt: new Date().toISOString(),
  };
}

export async function buildRawDataset(
  deps: PredictionDeps,
  accessToken: string,
  interval: PredictionInterval,
  days: number,
) {
  const payload = await assembleRawDataset(deps, accessToken, interval, days);
  fs.mkdirSync(intervalDataDir(interval), { recursive: true });
  fs.writeFileSync(rawPath(interval), JSON.stringify(payload, null, 2));
  return payload;
}

export async function trainPredictionModel(
  deps: PredictionDeps,
  accessToken: string,
  intervalInput = "minute",
  days = 60,
) {
  const interval = parsePredictionInterval(intervalInput);
  const dataset = await buildRawDataset(deps, accessToken, interval, days);
  const primaryBars = dataset.instruments.find((i) => i.id === PREDICTION_PRIMARY_ID)?.barCount ?? 0;
  const minBars = minTrainingBars(interval);
  if (primaryBars < minBars) {
    throw new Error(
      `Not enough Nifty future bars (${primaryBars}). Need ≥${minBars} ${interval} bars.`,
    );
  }

  const result = await runPython("train.py", { interval });
  const lastLine = result.stdout.trim().split("\n").pop() ?? "";
  let parsed: { ok?: boolean; metrics?: Record<string, unknown>; error?: string };
  try {
    parsed = JSON.parse(lastLine) as typeof parsed;
  } catch {
    throw new Error(formatPythonError(result.stderr, result.stdout, interval));
  }

  if (result.code !== 0 || parsed.error) {
    throw new Error(parsed.error ?? formatPythonError(result.stderr, result.stdout, interval));
  }

  return { dataset, metrics: parsed.metrics ?? null, interval };
}

export async function livePrediction(
  deps: PredictionDeps,
  accessToken: string,
  kiteApiKey: string,
  intervalInput = "minute",
  days = 5,
) {
  const interval = parsePredictionInterval(intervalInput);
  if (!modelExists(interval)) {
    throw new Error(`Model not trained yet for ${intervalLabel(interval)}. Run training first.`);
  }
  if (!isModelSchemaCurrent(readMetrics(interval), interval)) {
    throw new Error(
      `Model outdated for ${intervalLabel(interval)} — click Train model to upgrade the feature schema.`,
    );
  }

  const dataset = await assembleRawDataset(deps, accessToken, interval, days);
  const niftyFut =
    dataset.instruments.find((i) => i.id === PREDICTION_PRIMARY_ID)?.kiteKey ?? null;

  if (niftyFut) {
    const [micro, gemini] = await Promise.all([
      buildPredictionLiveSnapshot(accessToken, kiteApiKey, niftyFut),
      fetchGeminiSentimentFeatures(),
    ]);
    (dataset as Record<string, unknown>).liveSnapshot = { ...micro, ...gemini };
  }

  const result = await runPython("predict.py", { stdin: JSON.stringify(dataset), interval });
  const lastLine = result.stdout.trim().split("\n").pop() ?? "";
  let parsed: { ok?: boolean; data?: Record<string, unknown>; error?: string };
  try {
    parsed = JSON.parse(lastLine) as typeof parsed;
  } catch {
    throw new Error(formatPythonError(result.stderr, result.stdout, interval));
  }

  if (result.code !== 0 || parsed.error) {
    throw new Error(parsed.error ?? formatPythonError(result.stderr, result.stdout, interval));
  }

  return parsed.data;
}

export async function backtestPredictionDay(
  deps: PredictionDeps,
  accessToken: string,
  dateStr: string,
  intervalInput = "minute",
  apiKey?: string,
) {
  const interval = parsePredictionInterval(intervalInput);
  validateBacktestDate(dateStr, interval);

  if (!modelExists(interval)) {
    throw new Error(`Model not trained yet for ${intervalLabel(interval)}. Run training first.`);
  }
  if (!isModelSchemaCurrent(readMetrics(interval), interval)) {
    throw new Error(`Model outdated for ${intervalLabel(interval)} — click Train model first.`);
  }

  const payload = await prepareBacktestPayload(deps, accessToken, interval, dateStr);
  const result = await runPython("backtest_day.py", { stdin: JSON.stringify(payload), interval });
  const lastLine = result.stdout.trim().split("\n").pop() ?? "";
  let parsed: { ok?: boolean; data?: Record<string, unknown>; error?: string };
  try {
    parsed = JSON.parse(lastLine) as typeof parsed;
  } catch {
    throw new Error(formatPythonError(result.stderr, result.stdout, interval));
  }

  if (result.code !== 0 || parsed.error) {
    throw new Error(parsed.error ?? formatPythonError(result.stderr, result.stdout, interval));
  }

  const data = parsed.data as { summary?: Record<string, unknown>; bars?: unknown[] };
  if (apiKey && isTodayIst(dateStr) && Array.isArray(data.bars) && data.bars.length > 0) {
    const enriched = await enrichBacktestWithOptionPnl(
      accessToken,
      apiKey,
      dateStr,
      interval,
      data.bars as Parameters<typeof enrichBacktestWithOptionPnl>[4],
    );
    data.bars = enriched.bars;
    data.summary = {
      ...data.summary,
      ...(enriched.tradePlan ? { tradePlan: enriched.tradePlan } : {}),
      ...(enriched.error ? { optionEnrichmentError: enriched.error } : {}),
    };
  }

  return data;
}
