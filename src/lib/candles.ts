export interface ParsedCandle {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type RawKiteCandle = [string, number, number, number, number, number];

export function parseKiteCandles(raw: unknown[]): ParsedCandle[] {
  return raw
    .map((item) => {
      if (!Array.isArray(item) || item.length < 6) return null;
      const [time, open, high, low, close, volume] = item as RawKiteCandle;
      const timestamp = new Date(time).getTime();
      if (!Number.isFinite(timestamp)) return null;
      return {
        time: String(time),
        timestamp,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume) || 0,
      };
    })
    .filter((item): item is ParsedCandle => item !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function mergeLiveQuote(
  candles: ParsedCandle[],
  lastPrice: number,
  quoteVolume?: number
): ParsedCandle[] {
  if (candles.length === 0 || lastPrice <= 0) return candles;

  const next = candles.map((c) => ({ ...c }));
  const last = next[next.length - 1];
  last.close = lastPrice;
  last.high = Math.max(last.high, lastPrice);
  last.low = Math.min(last.low, lastPrice);
  if (quoteVolume != null && quoteVolume > 0) {
    last.volume = quoteVolume;
  }
  return next;
}

export function volumePerSecond(candle: ParsedCandle, now = new Date()) {
  const elapsedMs = now.getTime() - candle.timestamp;
  const elapsedSec = Math.max(1, Math.min(60, elapsedMs / 1000));
  return candle.volume / elapsedSec;
}

export function priceVelocity(candle: ParsedCandle, now = new Date()) {
  const elapsedMs = now.getTime() - candle.timestamp;
  const elapsedSec = Math.max(1, Math.min(60, elapsedMs / 1000));
  return (candle.close - candle.open) / elapsedSec;
}
