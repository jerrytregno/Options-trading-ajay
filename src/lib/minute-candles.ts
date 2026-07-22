import type { ParsedCandle } from "@/lib/candles";
import { NSE_SESSION_OPEN_MINUTES } from "@/lib/prediction-intervals";

function istMinutesSinceMidnight(timestamp: number): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const h = Number(fmt.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(fmt.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

function istDayStartMs(timestamp: number): number {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
  return new Date(`${date}T00:00:00+05:30`).getTime();
}

/** Roll up 1-second stream candles into 1-minute OHLCV bars for formula decisions. */
export function aggregateSecondCandlesToMinutes(secondCandles: ParsedCandle[]): ParsedCandle[] {
  if (secondCandles.length === 0) return [];

  const buckets = new Map<number, ParsedCandle>();

  for (const candle of secondCandles) {
    const minuteTs = Math.floor(candle.timestamp / 60_000) * 60_000;
    const existing = buckets.get(minuteTs);

    if (!existing) {
      buckets.set(minuteTs, {
        time: new Date(minuteTs).toISOString(),
        timestamp: minuteTs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
      continue;
    }

    buckets.set(minuteTs, {
      ...existing,
      high: Math.max(existing.high, candle.high),
      low: Math.min(existing.low, candle.low),
      close: candle.close,
      volume: existing.volume + candle.volume,
    });
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, candle]) => candle);
}

/** Overlay live 1m bars from the stream onto Kite session history (updates the forming bar). */
export function mergeMinuteCandles(sessionCandles: ParsedCandle[], liveCandles: ParsedCandle[]): ParsedCandle[] {
  if (sessionCandles.length === 0) return liveCandles;
  if (liveCandles.length === 0) return sessionCandles;

  const merged = [...sessionCandles];
  const indexByTs = new Map(merged.map((candle, index) => [candle.timestamp, index]));

  for (const candle of liveCandles) {
    const index = indexByTs.get(candle.timestamp);
    if (index !== undefined) {
      merged[index] = candle;
      continue;
    }
    if (candle.timestamp > merged[merged.length - 1].timestamp) {
      merged.push(candle);
      indexByTs.set(candle.timestamp, merged.length - 1);
    }
  }

  return merged;
}

/** Roll up 1-minute candles into N-minute OHLCV bars (NSE 9:15 anchor when in session). */
export function aggregateCandlesToInterval(
  minuteCandles: ParsedCandle[],
  intervalMinutes: number,
): ParsedCandle[] {
  if (minuteCandles.length === 0) return [];
  if (intervalMinutes <= 1) return minuteCandles;

  const buckets = new Map<number, ParsedCandle>();

  for (const candle of minuteCandles) {
    const dayStart = istDayStartMs(candle.timestamp);
    const mins = istMinutesSinceMidnight(candle.timestamp);
    const rel = mins - NSE_SESSION_OPEN_MINUTES;
    const bucketRel =
      rel >= 0
        ? Math.floor(rel / intervalMinutes) * intervalMinutes
        : Math.floor(mins / intervalMinutes) * intervalMinutes;
    const bucketMins = rel >= 0 ? NSE_SESSION_OPEN_MINUTES + bucketRel : bucketRel;
    const bucketTs = dayStart + bucketMins * 60_000;

    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, {
        time: new Date(bucketTs).toISOString(),
        timestamp: bucketTs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      });
      continue;
    }

    buckets.set(bucketTs, {
      ...existing,
      high: Math.max(existing.high, candle.high),
      low: Math.min(existing.low, candle.low),
      close: candle.close,
      volume: existing.volume + candle.volume,
    });
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => c);
}
