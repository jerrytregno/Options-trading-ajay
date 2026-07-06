import type { ParsedCandle } from "@/lib/candles";

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
