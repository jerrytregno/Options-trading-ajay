import type { ParsedCandle } from "@/lib/candles";

export const MAX_SECOND_CANDLES = 600;

export function appendSecondCandle(
  candles: ParsedCandle[],
  price: number,
  quoteVolume: number,
  previousQuoteVolume: number,
  maxCandles = MAX_SECOND_CANDLES
): ParsedCandle[] {
  if (price <= 0) return candles;

  const secondTs = Math.floor(Date.now() / 1000) * 1000;
  let volumeDelta =
    quoteVolume > previousQuoteVolume ? quoteVolume - previousQuoteVolume : 0;
  if (volumeDelta <= 0) volumeDelta = 1;

  const last = candles[candles.length - 1];
  if (last?.timestamp === secondTs) {
    const updated: ParsedCandle = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: last.volume + volumeDelta,
    };
    return [...candles.slice(0, -1), updated].slice(-maxCandles);
  }

  const open = last?.close ?? price;
  const newCandle: ParsedCandle = {
    time: new Date(secondTs).toISOString(),
    timestamp: secondTs,
    open,
    high: Math.max(open, price),
    low: Math.min(open, price),
    close: price,
    volume: volumeDelta,
  };

  return [...candles, newCandle].slice(-maxCandles);
}
