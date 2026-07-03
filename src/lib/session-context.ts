import type { ParsedCandle } from "./candles";

function sessionVwap(candles: ParsedCandle[]) {
  let cumulativeVolume = 0;
  let cumulativePriceVolume = 0;
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typical * candle.volume;
    cumulativeVolume += candle.volume;
  }
  if (cumulativeVolume <= 0) return null;
  return cumulativePriceVolume / cumulativeVolume;
}

/** Compact session summary — small token footprint for Gemini. */
export interface SessionContextCompact {
  dateIST: string;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  dayClose: number;
  dayVwap: number | null;
  barCount: number;
  changeFromOpen: number;
  changeFromOpenPct: number;
  /** First 15 minutes (9:15–9:30) range */
  openingRange: { high: number; low: number } | null;
  /** Last 30 one-minute bars as "HH:MM,o,h,l,c" */
  recent1m: string[];
  sessionTrend: "up" | "down" | "sideways";
}

const DEFAULT_RECENT_1M_BARS = 30;
const OPENING_RANGE_BARS = 15;

function formatIstTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function compactBar(candle: ParsedCandle) {
  return `${formatIstTime(candle.timestamp)},${candle.open.toFixed(1)},${candle.high.toFixed(1)},${candle.low.toFixed(1)},${candle.close.toFixed(1)}`;
}

export function buildSessionContext(
  candles: ParsedCandle[],
  dateIST: string,
  maxRecentBars = DEFAULT_RECENT_1M_BARS
): SessionContextCompact | null {
  if (candles.length === 0) return null;

  const dayOpen = candles[0].open;
  const dayClose = candles[candles.length - 1].close;
  const dayHigh = Math.max(...candles.map((c) => c.high));
  const dayLow = Math.min(...candles.map((c) => c.low));
  const changeFromOpen = dayClose - dayOpen;
  const changeFromOpenPct = dayOpen > 0 ? (changeFromOpen / dayOpen) * 100 : 0;

  const openingSlice = candles.slice(0, OPENING_RANGE_BARS);
  const openingRange =
    openingSlice.length > 0
      ? {
          high: Math.max(...openingSlice.map((c) => c.high)),
          low: Math.min(...openingSlice.map((c) => c.low)),
        }
      : null;

  const recent1m = candles.slice(-maxRecentBars).map(compactBar);

  let sessionTrend: SessionContextCompact["sessionTrend"] = "sideways";
  if (changeFromOpenPct > 0.08) sessionTrend = "up";
  else if (changeFromOpenPct < -0.08) sessionTrend = "down";

  const dayVwap = sessionVwap(candles);

  return {
    dateIST,
    dayOpen: Number(dayOpen.toFixed(2)),
    dayHigh: Number(dayHigh.toFixed(2)),
    dayLow: Number(dayLow.toFixed(2)),
    dayClose: Number(dayClose.toFixed(2)),
    dayVwap: dayVwap != null ? Number(dayVwap.toFixed(2)) : null,
    barCount: candles.length,
    changeFromOpen: Number(changeFromOpen.toFixed(2)),
    changeFromOpenPct: Number(changeFromOpenPct.toFixed(3)),
    openingRange,
    recent1m,
    sessionTrend,
  };
}

/** Last ~60s of 1s candles as 12 compact 5-second buckets (minimal tokens). */
export function compactRecent1s(candles: ParsedCandle[], bucketSeconds = 5, maxBuckets = 12): string[] {
  if (candles.length === 0) return [];

  const slice = candles.slice(-bucketSeconds * maxBuckets);
  const buckets: ParsedCandle[][] = [];
  let bucketStart = slice[0].timestamp;

  for (const candle of slice) {
    const bucketIndex = Math.floor((candle.timestamp - bucketStart) / (bucketSeconds * 1000));
    if (!buckets[bucketIndex]) buckets[bucketIndex] = [];
    buckets[bucketIndex].push(candle);
  }

  return buckets
    .filter(Boolean)
    .map((group) => {
      const open = group[0].open;
      const close = group[group.length - 1].close;
      const high = Math.max(...group.map((c) => c.high));
      const low = Math.min(...group.map((c) => c.low));
      return `${formatIstTime(group[0].timestamp)},${open.toFixed(1)},${high.toFixed(1)},${low.toFixed(1)},${close.toFixed(1)}`;
    });
}
