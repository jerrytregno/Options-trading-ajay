import type { ParsedCandle } from "@/lib/candles";
import type { TechnicalSnapshot } from "@/lib/technical-indicators";
import type { SessionContextCompact } from "@/lib/session-context";
import type { OptionChainResponse } from "@/types/kite";
import type { NiftyStreamResponse } from "@/types/streaming";
import type { StreamInstrument } from "@/lib/stream-instruments";
import { AI_AUTO_TARGET_PROFIT_INR } from "@/lib/auto-trade";

export interface MarketTechnicalsSummary {
  id: string;
  label: string;
  spot: number;
  rsi14: number | null;
  vwap: number | null;
  ema20: number | null;
  ema50: number | null;
  trend: TechnicalSnapshot["trend"];
}

/** Latest spot + indicators refreshed on every stream tick (~1s). */
export interface LiveMarketNow {
  at: string;
  spot: number;
  volume: number;
  change: number;
  changePercent: number;
  rsi14: number | null;
  vwap: number | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
}

/** One-second spot + volume history for Gemini (last N seconds). */
export interface SecondTick {
  time: string;
  spot: number;
  volume: number;
}

export interface StreamingGeminiPayload {
  underlyingId: string;
  instrumentLabel: string;
  chainSymbol: string;
  chainExchange: string;
  spot: number;
  change: number;
  changePercent: number;
  technicals: TechnicalSnapshot;
  /** Current tick — spot, volume, RSI, EMA, VWAP (updated each poll). */
  liveNow: LiveMarketNow;
  /** Last ~60 one-second bars: time, spot, volume. */
  recentSeconds: SecondTick[];
  liveMetrics: {
    volumePerMinute: number;
    volumePerSecond: number;
    buyBookOrders: number;
    sellBookOrders: number;
    totalBookOrders: number;
    priceMove: number;
    sessionHigh: number;
    sessionLow: number;
  };
  fibLevels: Array<{ label: string; price: number }>;
  atmStrike: number | null;
  expiry: string | null;
  atmCeLtp: number | null;
  atmPeLtp: number | null;
  sessionContext: SessionContextCompact | null;
  recent1s: string[];
  lastCandle: ParsedCandle | null;
  recentRsi1m: number[];
  allMarkets: MarketTechnicalsSummary[];
  exitTargetProfitInr: number;
}

function formatIstSecond(timestamp: number) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

export function buildRecentSecondTicks(candles: ParsedCandle[], limit = 60): SecondTick[] {
  return candles.slice(-limit).map((candle) => ({
    time: formatIstSecond(candle.timestamp),
    spot: Number(candle.close.toFixed(2)),
    volume: candle.volume,
  }));
}

export function buildLiveMarketNow(input: {
  stream: NiftyStreamResponse;
  technicals: TechnicalSnapshot;
}): LiveMarketNow {
  const { stream, technicals } = input;
  return {
    at: stream.updatedAt || new Date().toISOString(),
    spot: stream.quote.last_price,
    volume: stream.quote.volume ?? 0,
    change: stream.quote.change,
    changePercent: stream.quote.change_percent,
    rsi14: technicals.rsi14,
    vwap: technicals.vwap,
    ema9: technicals.ema9,
    ema20: technicals.ema20,
    ema50: technicals.ema50,
  };
}

export function buildStreamingGeminiPayload(input: {
  instrument: StreamInstrument;
  stream: NiftyStreamResponse;
  technicals: TechnicalSnapshot;
  liveMetrics: StreamingGeminiPayload["liveMetrics"];
  fibLevels: Array<{ label: string; price: number }>;
  chain: OptionChainResponse | null;
  sessionContext: SessionContextCompact | null;
  recent1s: string[];
  lastCandle: ParsedCandle | null;
  recentRsi1m: number[];
  allMarkets: MarketTechnicalsSummary[];
  secondCandles: ParsedCandle[];
}): StreamingGeminiPayload {
  const atmRow = input.chain?.chain.find((row) => row.isAtm);
  const liveNow = buildLiveMarketNow({ stream: input.stream, technicals: input.technicals });
  return {
    underlyingId: input.instrument.id,
    instrumentLabel: input.instrument.label,
    chainSymbol: input.instrument.chainSymbol,
    chainExchange: input.instrument.chainExchange,
    spot: input.stream.quote.last_price,
    change: input.stream.quote.change,
    changePercent: input.stream.quote.change_percent,
    technicals: input.technicals,
    liveNow,
    recentSeconds: buildRecentSecondTicks(input.secondCandles),
    liveMetrics: input.liveMetrics,
    fibLevels: input.fibLevels,
    atmStrike: input.chain?.atmStrike ?? null,
    expiry: input.chain?.expiry ?? null,
    atmCeLtp: atmRow?.ce?.quote?.last_price ?? null,
    atmPeLtp: atmRow?.pe?.quote?.last_price ?? null,
    sessionContext: input.sessionContext,
    recent1s: input.recent1s,
    lastCandle: input.lastCandle,
    recentRsi1m: input.recentRsi1m,
    allMarkets: input.allMarkets,
    exitTargetProfitInr: AI_AUTO_TARGET_PROFIT_INR,
  };
}
