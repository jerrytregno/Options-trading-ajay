import type { ParsedCandle } from "@/lib/candles";
import { appendSecondCandle } from "@/lib/second-candles";
import { enrichQuoteMetrics, type RawKiteQuote } from "@/lib/quote-depth";
import {
  buildRsiSeries,
  buildTechnicalSnapshot,
  calculateFibonacciRetracement,
} from "@/lib/technical-indicators";
import { aggregateSecondCandlesToMinutes, mergeMinuteCandles } from "@/lib/minute-candles";
import { compactRecent1s } from "@/lib/session-context";
import { buildStreamingGeminiPayload } from "@/lib/streaming-snapshot";
import {
  getStreamInstrument,
  STREAM_INSTRUMENTS,
} from "@/lib/stream-instruments";
import type { OptionChainResponse } from "@/types/kite";
import type { NiftySessionResponse, NiftyStreamResponse } from "@/types/streaming";

export const MARKET_STREAM_LIVE_KEY = "optionflow_streaming_live";
export const GEMINI_INSTRUMENT_KEY = "optionflow_gemini_instrument";
export const GEMINI_AI_KEY = "optionflow_gemini_ai";

export function emptyInstrumentRecord<T>(value: T): Record<string, T> {
  return Object.fromEntries(STREAM_INSTRUMENTS.map((item) => [item.id, value]));
}

export function quoteToStreamResponse(
  instrument: (typeof STREAM_INSTRUMENTS)[number],
  quote: RawKiteQuote,
  previousCumulativeVolume = 0
): NiftyStreamResponse {
  const metrics = enrichQuoteMetrics(quote, previousCumulativeVolume);
  return {
    instrument: instrument.kiteKey,
    interval: "second",
    quote: {
      last_price: quote.last_price ?? 0,
      change: quote.change ?? 0,
      change_percent: quote.change_percent ?? 0,
      volume: metrics.cumulativeVolume,
      cumulativeVolume: metrics.cumulativeVolume,
      volumePerSecond: metrics.volumePerSecond,
      buyOrders: metrics.orderBook.buyOrders,
      sellOrders: metrics.orderBook.sellOrders,
      totalBookOrders: metrics.orderBook.totalOrders,
      buyBookQuantity: metrics.orderBook.buyQuantity,
      sellBookQuantity: metrics.orderBook.sellQuantity,
      ohlc: quote.ohlc,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function buildGeminiSnapshotFromFeed(input: {
  streamInstrumentId: string;
  stream: NiftyStreamResponse | null;
  secondCandles: ParsedCandle[];
  sessionsByInstrument: Record<string, NiftySessionResponse>;
  candlesByInstrument: Record<string, ParsedCandle[]>;
  streamsByInstrument: Record<string, NiftyStreamResponse>;
  chain: OptionChainResponse | null;
}) {
  const { streamInstrumentId, stream, secondCandles, sessionsByInstrument, candlesByInstrument, streamsByInstrument, chain } =
    input;
  if (!stream || secondCandles.length === 0) return null;

  const selectedInstrument = getStreamInstrument(streamInstrumentId);
  const sessionData = sessionsByInstrument[streamInstrumentId] ?? null;
  const streamMinuteCandles = aggregateSecondCandlesToMinutes(secondCandles);
  const minuteCandles = mergeMinuteCandles(sessionData?.candles ?? [], streamMinuteCandles);
  const technicals = buildTechnicalSnapshot(minuteCandles);
  const rsiSeries = buildRsiSeries(minuteCandles, 14);
  const lastSecond = secondCandles[secondCandles.length - 1];
  const last = minuteCandles[minuteCandles.length - 1];
  const liveMetrics = last
    ? {
        volumePerMinute: last.volume,
        volumePerSecond: lastSecond?.volume ?? stream.quote.volumePerSecond ?? 0,
        buyBookOrders: stream.quote.buyOrders ?? 0,
        sellBookOrders: stream.quote.sellOrders ?? 0,
        totalBookOrders: stream.quote.totalBookOrders ?? 0,
        priceMove: last.close - last.open,
        sessionHigh: Math.max(...minuteCandles.map((c) => c.high)),
        sessionLow: Math.min(...minuteCandles.map((c) => c.low)),
      }
    : {
        volumePerMinute: 0,
        volumePerSecond: stream.quote.volumePerSecond ?? 0,
        buyBookOrders: stream.quote.buyOrders ?? 0,
        sellBookOrders: stream.quote.sellOrders ?? 0,
        totalBookOrders: stream.quote.totalBookOrders ?? 0,
        priceMove: 0,
        sessionHigh: 0,
        sessionLow: 0,
      };
  const sessionFibLevels =
    liveMetrics.sessionHigh > liveMetrics.sessionLow
      ? calculateFibonacciRetracement(liveMetrics.sessionHigh, liveMetrics.sessionLow)
      : [];

  const allMarkets = STREAM_INSTRUMENTS.map((inst) => {
    const candles = candlesByInstrument[inst.id] ?? [];
    const streamMinutes = aggregateSecondCandlesToMinutes(candles);
    const minutes = mergeMinuteCandles(sessionsByInstrument[inst.id]?.candles ?? [], streamMinutes);
    const tech = buildTechnicalSnapshot(minutes);
    const spot = candles[candles.length - 1]?.close ?? streamsByInstrument[inst.id]?.quote.last_price ?? 0;
    const snap = buildTechnicalSnapshot(minutes);
    return {
      id: inst.id,
      label: inst.label,
      spot,
      rsi14: tech.rsi14,
      vwap: tech.vwap,
      ema20: tech.ema20,
      ema50: tech.ema50,
      trend: snap.trend,
    };
  });

  return buildStreamingGeminiPayload({
    instrument: selectedInstrument,
    stream,
    technicals,
    liveMetrics,
    fibLevels: sessionFibLevels,
    chain,
    sessionContext: sessionData?.session ?? null,
    recent1s: compactRecent1s(secondCandles),
    lastCandle: secondCandles[secondCandles.length - 1] ?? null,
    recentRsi1m: rsiSeries.slice(-5).map((p) => p.value),
    allMarkets,
    secondCandles,
  });
}

export function appendQuoteToCandles(
  prev: Record<string, ParsedCandle[]>,
  quoteData: Record<string, unknown>,
  lastVolumeByInstrument: Record<string, number>
) {
  const next = { ...prev };
  for (const inst of STREAM_INSTRUMENTS) {
    const quote = quoteData[inst.kiteKey] as RawKiteQuote | undefined;
    if (!quote?.last_price) continue;
    const lastVol = lastVolumeByInstrument[inst.id] ?? 0;
    next[inst.id] = appendSecondCandle(prev[inst.id] ?? [], quote.last_price, quote.volume ?? 0, lastVol);
    lastVolumeByInstrument[inst.id] = quote.volume ?? 0;
  }
  return next;
}

export function quotesToStreamsByInstrument(
  quoteData: Record<string, unknown>,
  lastVolumeByInstrument: Record<string, number>
): Record<string, NiftyStreamResponse> {
  const now = new Date().toISOString();
  const next: Record<string, NiftyStreamResponse> = {};
  for (const inst of STREAM_INSTRUMENTS) {
    const quote = quoteData[inst.kiteKey] as RawKiteQuote | undefined;
    if (!quote?.last_price) continue;
    const prevVol = lastVolumeByInstrument[inst.id] ?? 0;
    next[inst.id] = { ...quoteToStreamResponse(inst, quote, prevVol), updatedAt: now };
  }
  return next;
}
