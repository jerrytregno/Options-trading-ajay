import type {
  NineFifteenCandleRow,
  NineFifteenCandlesResult,
  NineFifteenCePeGuide,
  NineFifteenCePeStrategyStats,
  NineFifteenDirection,
  NineFifteenLevelSummary,
  NineFifteenOptionSide,
  NineFifteenRupeLevel,
} from "../src/types/nine-fifteen.js";
import { NINE_FIFTEEN_RUPEE_LEVELS } from "../src/types/nine-fifteen.js";

const NIFTY_SPOT_KEY = "NSE:NIFTY 50";
const IST = "Asia/Kolkata";
/** Smaller chunks — full-session minute data is much larger per request. */
const CHUNK_TRADING_DAYS = 25;
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

export type CandleFetcher = (
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) => Promise<{ instrument: string; candles: unknown[] }>;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function getIstParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    weekday: parts.find((part) => part.type === "weekday")?.value ?? "",
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

function istDateKey(date: Date): string {
  const ist = getIstParts(date);
  return `${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`;
}

function istMinutes(date: Date): number {
  const ist = getIstParts(date);
  return ist.hour * 60 + ist.minute;
}

function listTradingDatesIst(daysBack: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let offset = daysBack; offset >= 0; offset -= 1) {
    const d = new Date(today.getTime() - offset * 86_400_000);
    const ist = getIstParts(d);
    if (ist.weekday === "Sat" || ist.weekday === "Sun") continue;
    dates.push(`${ist.year}-${pad2(ist.month)}-${pad2(ist.day)}`);
  }
  return dates;
}

function chunkTradingDates(dates: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < dates.length; i += size) {
    chunks.push(dates.slice(i, i + size));
  }
  return chunks;
}

function directionFromOhlc(open: number, close: number): NineFifteenDirection {
  if (close > open) return "up";
  if (close < open) return "down";
  return "flat";
}

function buildLevelFlags(
  openPx: number,
  highPx: number,
  lowPx: number,
): {
  maxGainFromOpen: number;
  maxLossFromOpen: number;
  gainLevels: Record<NineFifteenRupeLevel, boolean>;
  lossLevels: Record<NineFifteenRupeLevel, boolean>;
} {
  const maxGainFromOpen = Math.max(0, highPx - openPx);
  const maxLossFromOpen = Math.max(0, openPx - lowPx);

  const gainLevels = {} as Record<NineFifteenRupeLevel, boolean>;
  const lossLevels = {} as Record<NineFifteenRupeLevel, boolean>;

  for (const level of NINE_FIFTEEN_RUPEE_LEVELS) {
    gainLevels[level] = highPx >= openPx + level;
    lossLevels[level] = lowPx <= openPx - level;
  }

  return { maxGainFromOpen, maxLossFromOpen, gainLevels, lossLevels };
}

function buildDayLevelFlags(
  openPx: number,
  sessionHigh: number,
  sessionLow: number,
): {
  maxDayUpFrom915: number;
  maxDayDownFrom915: number;
  dayUpLevels: Record<NineFifteenRupeLevel, boolean>;
  dayDownLevels: Record<NineFifteenRupeLevel, boolean>;
} {
  const maxDayUpFrom915 = Math.max(0, sessionHigh - openPx);
  const maxDayDownFrom915 = Math.max(0, openPx - sessionLow);

  const dayUpLevels = {} as Record<NineFifteenRupeLevel, boolean>;
  const dayDownLevels = {} as Record<NineFifteenRupeLevel, boolean>;

  for (const level of NINE_FIFTEEN_RUPEE_LEVELS) {
    dayUpLevels[level] = sessionHigh >= openPx + level;
    dayDownLevels[level] = sessionLow <= openPx - level;
  }

  return { maxDayUpFrom915, maxDayDownFrom915, dayUpLevels, dayDownLevels };
}

type DayAccumulator = {
  open915: number;
  close915: number;
  high915: number;
  low915: number;
  sessionHigh: number;
  sessionLow: number;
  has915: boolean;
};

function parseSessionRows(raw: unknown[]): NineFifteenCandleRow[] {
  const days = new Map<string, DayAccumulator>();

  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 6) continue;
    const [time, open, high, low, close] = item as [string, number, number, number, number, number];
    const parsed = new Date(String(time));
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinutes(parsed);
    if (mins < SESSION_OPEN_MINUTES || mins > SESSION_CLOSE_MINUTES) continue;

    const openPx = Number(open);
    const highPx = Number(high);
    const lowPx = Number(low);
    const closePx = Number(close);
    if (![openPx, highPx, lowPx, closePx].every(Number.isFinite)) continue;

    const date = istDateKey(parsed);
    const ist = getIstParts(parsed);
    const acc = days.get(date) ?? {
      open915: 0,
      close915: 0,
      high915: 0,
      low915: 0,
      sessionHigh: -Infinity,
      sessionLow: Infinity,
      has915: false,
    };

    acc.sessionHigh = Math.max(acc.sessionHigh, highPx);
    acc.sessionLow = Math.min(acc.sessionLow, lowPx);

    if (ist.hour === 9 && ist.minute === 15) {
      acc.open915 = openPx;
      acc.close915 = closePx;
      acc.high915 = highPx;
      acc.low915 = lowPx;
      acc.has915 = true;
    }

    days.set(date, acc);
  }

  const rows: NineFifteenCandleRow[] = [];

  for (const [date, acc] of days) {
    if (!acc.has915 || !Number.isFinite(acc.sessionHigh) || !Number.isFinite(acc.sessionLow)) continue;

    const change = acc.close915 - acc.open915;
    const changePct = acc.open915 !== 0 ? (change / acc.open915) * 100 : 0;
    const minuteLevels = buildLevelFlags(acc.open915, acc.high915, acc.low915);
    const dayLevels = buildDayLevelFlags(acc.open915, acc.sessionHigh, acc.sessionLow);

    rows.push({
      date,
      open: acc.open915,
      close: acc.close915,
      high: acc.high915,
      low: acc.low915,
      change,
      changePct,
      direction: directionFromOhlc(acc.open915, acc.close915),
      ...minuteLevels,
      sessionHigh: acc.sessionHigh,
      sessionLow: acc.sessionLow,
      ...dayLevels,
    });
  }

  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

function buildLevelSummary(
  rows: NineFifteenCandleRow[],
  pick: (row: NineFifteenCandleRow) => Record<NineFifteenRupeLevel, boolean>,
): NineFifteenLevelSummary[] {
  const total = rows.length;
  return NINE_FIFTEEN_RUPEE_LEVELS.map((level) => {
    const hitCount = rows.filter((row) => pick(row)[level]).length;
    return {
      level,
      hitCount,
      hitPct: total > 0 ? (hitCount / total) * 100 : 0,
    };
  });
}

function buildSummary(rows: NineFifteenCandleRow[]) {
  const up = rows.filter((row) => row.direction === "up").length;
  const down = rows.filter((row) => row.direction === "down").length;
  const flat = rows.filter((row) => row.direction === "flat").length;
  const total = rows.length;
  return {
    total,
    up,
    down,
    flat,
    upPct: total > 0 ? (up / total) * 100 : 0,
    downPct: total > 0 ? (down / total) * 100 : 0,
    gainLevels: buildLevelSummary(rows, (row) => row.gainLevels),
    lossLevels: buildLevelSummary(rows, (row) => row.lossLevels),
    dayUpLevels: buildLevelSummary(rows, (row) => row.dayUpLevels),
    dayDownLevels: buildLevelSummary(rows, (row) => row.dayDownLevels),
  };
}

function strategyStats(
  label: string,
  allRows: NineFifteenCandleRow[],
  tradeRows: NineFifteenCandleRow[],
  side: "CE" | "PE" | "MIXED",
  hitRow: (row: NineFifteenCandleRow) => boolean,
): NineFifteenCePeStrategyStats {
  const sampleDays = allRows.length;
  const tradeDays = tradeRows.length;
  const targetHits = tradeRows.filter(hitRow).length;
  return {
    label,
    side,
    sampleDays,
    tradeDays,
    targetHits,
    targetHitPct: tradeDays > 0 ? (targetHits / tradeDays) * 100 : 0,
  };
}

function todayIstDateKey(): string {
  return istDateKey(new Date());
}

function buildCePeGuide(rows: NineFifteenCandleRow[]): NineFifteenCePeGuide {
  const minuteUp = rows.filter((row) => row.direction === "up");
  const minuteDown = rows.filter((row) => row.direction === "down");
  const minuteDirectional = rows.filter((row) => row.direction === "up" || row.direction === "down");

  const followDirection = strategyStats(
    "Follow 9:15 bar: UP→CE, DOWN→PE",
    rows,
    minuteDirectional,
    "MIXED",
    (row) =>
      row.direction === "up" ? row.dayUpLevels[50] : row.direction === "down" && row.dayDownLevels[50],
  );
  const alwaysCall = strategyStats(
    "Buy CE every day at 9:15",
    rows,
    rows,
    "CE",
    (row) => row.dayUpLevels[50],
  );
  const alwaysPut = strategyStats(
    "Buy PE every day at 9:15",
    rows,
    rows,
    "PE",
    (row) => row.dayDownLevels[50],
  );
  const minuteUpBuyCall = strategyStats(
    "9:15 bar closes UP → buy CE",
    rows,
    minuteUp,
    "CE",
    (row) => row.dayUpLevels[50],
  );
  const minuteDownBuyPut = strategyStats(
    "9:15 bar closes DOWN → buy PE",
    rows,
    minuteDown,
    "PE",
    (row) => row.dayDownLevels[50],
  );
  const minuteUpBuyPut = strategyStats(
    "9:15 bar UP → buy PE (fade)",
    rows,
    minuteUp,
    "PE",
    (row) => row.dayDownLevels[50],
  );
  const minuteDownBuyCall = strategyStats(
    "9:15 bar DOWN → buy CE (fade)",
    rows,
    minuteDown,
    "CE",
    (row) => row.dayUpLevels[50],
  );

  const strategies = [
    followDirection,
    alwaysCall,
    alwaysPut,
    minuteUpBuyCall,
    minuteDownBuyPut,
    minuteUpBuyPut,
    minuteDownBuyCall,
  ];
  const bestStrategy = [...strategies].sort((a, b) => b.targetHitPct - a.targetHitPct)[0];

  const entryRule =
    followDirection.targetHitPct >= Math.max(alwaysCall.targetHitPct, alwaysPut.targetHitPct) &&
    followDirection.targetHitPct >=
      Math.max(minuteUpBuyPut.targetHitPct, minuteDownBuyCall.targetHitPct)
      ? "At 9:16 (after 9:15 bar closes): UP → buy CE (target Nifty +50 from 9:15 open). DOWN → buy PE (target −50). Skip flat bars."
      : alwaysCall.targetHitPct >= alwaysPut.targetHitPct
        ? "Blind CE at 9:15 — historically more sessions hit +50 from open than PE hits −50."
        : "Blind PE at 9:15 — historically more sessions hit −50 from open than CE hits +50.";

  const todayRow = rows.find((row) => row.date === todayIstDateKey()) ?? null;
  let todaySignal: NineFifteenCePeGuide["todaySignal"] = null;
  if (todayRow) {
    let side: NineFifteenOptionSide = "WAIT";
    let note = "";
    if (todayRow.direction === "up") {
      side = "CE";
      note = `9:15 bar closed UP (+${todayRow.change.toFixed(2)} pts) — buy CE, target day high ≥ open + ₹50`;
    } else if (todayRow.direction === "down") {
      side = "PE";
      note = `9:15 bar closed DOWN (${todayRow.change.toFixed(2)} pts) — buy PE, target day low ≤ open − ₹50`;
    } else {
      note = "9:15 bar flat — no directional signal; wait or skip.";
    }
    todaySignal = {
      date: todayRow.date,
      minuteDirection: todayRow.direction,
      side,
      note,
    };
  }

  return {
    followDirection,
    alwaysCall,
    alwaysPut,
    minuteUpBuyCall,
    minuteDownBuyPut,
    minuteUpBuyPut,
    minuteDownBuyCall,
    bestStrategy,
    entryRule,
    todaySignal,
  };
}

const cache = new Map<string, { at: number; data: NineFifteenCandlesResult }>();
const CACHE_MS = 30 * 60_000;

export function invalidateNineFifteenCache() {
  cache.clear();
}

/** 9:15 bar + full session move from 9:15 open (for CE/PE +50 day targets). */
export async function fetchNineFifteenCandleHistory(
  accessToken: string,
  fetchCandles: CandleFetcher,
  daysRequested = 365,
  force = false,
): Promise<NineFifteenCandlesResult> {
  const days = Math.min(Math.max(Math.round(daysRequested), 30), 365);
  const cacheKey = `nine-fifteen:session:v4:${days}`;
  if (force) invalidateNineFifteenCache();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.data;
  }

  const tradingDates = listTradingDatesIst(days);
  if (tradingDates.length === 0) {
    throw new Error("No trading dates in range");
  }

  const chunks = chunkTradingDates(tradingDates, CHUNK_TRADING_DAYS);
  const allRaw: unknown[] = [];

  for (const chunk of chunks) {
    const from = `${chunk[0]} 09:15:00`;
    const to = `${chunk[chunk.length - 1]} 15:30:00`;
    const { candles } = await fetchCandles(accessToken, NIFTY_SPOT_KEY, "minute", from, to);
    allRaw.push(...candles);
    await new Promise((resolve) => setTimeout(resolve, 450));
  }

  const rows = parseSessionRows(allRaw);
  const result: NineFifteenCandlesResult = {
    instrument: NIFTY_SPOT_KEY,
    daysRequested: days,
    fromDate: rows[rows.length - 1]?.date ?? tradingDates[0] ?? "",
    toDate: rows[0]?.date ?? tradingDates[tradingDates.length - 1] ?? "",
    rows,
    summary: buildSummary(rows),
    cePeGuide: buildCePeGuide(rows),
  };

  cache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}
