import type { ParsedCandle } from "./candles";

export interface MovingAveragePoint {
  time: string;
  value: number;
}

export interface MacdPoint {
  time: string;
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerPoint {
  time: string;
  upper: number;
  middle: number;
  lower: number;
}

export interface TechnicalSnapshot {
  rsi14: number | null;
  sma9: number | null;
  sma20: number | null;
  sma50: number | null;
  ema9: number | null;
  ema21: number | null;
  ema20: number | null;
  ema50: number | null;
  macd: MacdPoint | null;
  bollinger: BollingerPoint | null;
  vwap: number | null;
  atr14: number | null;
  trend: "bullish" | "bearish" | "neutral";
  emaCross: "golden" | "death" | "none";
}

function sma(values: number[], period: number) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function emaSeries(values: number[], period: number) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const series: number[] = [];
  let prev = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  series.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] - prev) * multiplier + prev;
    series.push(prev);
  }
  return series;
}

export function calculateRsi(closes: number[], period = 14) {
  if (closes.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateMacd(closes: number[]): MacdPoint | null {
  if (closes.length < 35) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const offset = ema12.length - ema26.length;
  const macdLine = ema26.map((value, index) => ema12[index + offset] - value);
  const signalSeries = emaSeries(macdLine, 9);
  const macd = macdLine[macdLine.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  const lastIndex = closes.length - 1;
  return {
    time: String(lastIndex),
    macd,
    signal,
    histogram: macd - signal,
  };
}

export function calculateBollinger(closes: number[], period = 20, stdDev = 2): BollingerPoint | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  return {
    time: String(closes.length - 1),
    upper: middle + stdDev * deviation,
    middle,
    lower: middle - stdDev * deviation,
  };
}

export function calculateVwap(candles: ParsedCandle[]) {
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

export function calculateAtr(candles: ParsedCandle[], period = 14) {
  if (candles.length <= period) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prev = candles[i - 1];
    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - prev.close),
        Math.abs(current.low - prev.close)
      )
    );
  }
  return sma(trs, period);
}

export function buildMovingAverageSeries(candles: ParsedCandle[], period: number): MovingAveragePoint[] {
  const closes = candles.map((c) => c.close);
  const series: MovingAveragePoint[] = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const value = sma(closes.slice(0, i + 1), period);
    if (value == null) continue;
    series.push({ time: candles[i].time, value });
  }
  return series;
}

export interface FibLevel {
  ratio: number;
  price: number;
  label: string;
}

export function calculateFibonacciRetracement(high: number, low: number): FibLevel[] {
  const diff = high - low;
  if (diff <= 0) return [];
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  return ratios.map((ratio) => ({
    ratio,
    price: high - diff * ratio,
    label: ratio === 0 ? "0%" : ratio === 1 ? "100%" : `${(ratio * 100).toFixed(1)}%`,
  }));
}

export interface RsiPoint {
  time: string;
  value: number;
}

export function buildRsiSeries(candles: ParsedCandle[], period = 14): RsiPoint[] {
  const closes = candles.map((c) => c.close);
  const series: RsiPoint[] = [];
  for (let i = period; i < closes.length; i += 1) {
    const rsi = calculateRsi(closes.slice(0, i + 1), period);
    if (rsi == null) continue;
    series.push({ time: candles[i].time, value: rsi });
  }
  return series;
}

export function buildTechnicalSnapshot(candles: ParsedCandle[]): TechnicalSnapshot {
  const closes = candles.map((c) => c.close);
  const ema9Series = emaSeries(closes, 9);
  const ema21Series = emaSeries(closes, 21);
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema9 = ema9Series.length ? ema9Series[ema9Series.length - 1] : null;
  const ema21 = ema21Series.length ? ema21Series[ema21Series.length - 1] : null;
  const ema20 = ema20Series.length ? ema20Series[ema20Series.length - 1] : null;
  const ema50 = ema50Series.length ? ema50Series[ema50Series.length - 1] : null;
  const sma9 = sma(closes, 9);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = calculateRsi(closes, 14);
  const macd = calculateMacd(closes);
  const bollinger = calculateBollinger(closes, 20, 2);
  const vwap = calculateVwap(candles);
  const atr14 = calculateAtr(candles, 14);

  let trend: TechnicalSnapshot["trend"] = "neutral";
  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21 && closes[closes.length - 1] > ema9) trend = "bullish";
    else if (ema9 < ema21 && closes[closes.length - 1] < ema9) trend = "bearish";
  }

  let emaCross: TechnicalSnapshot["emaCross"] = "none";
  if (ema9Series.length >= 2 && ema21Series.length >= 2) {
    const prevDiff = ema9Series[ema9Series.length - 2] - ema21Series[ema21Series.length - 2];
    const currDiff = ema9Series[ema9Series.length - 1] - ema21Series[ema21Series.length - 1];
    if (prevDiff <= 0 && currDiff > 0) emaCross = "golden";
    if (prevDiff >= 0 && currDiff < 0) emaCross = "death";
  }

  return {
    rsi14,
    sma9,
    sma20,
    sma50,
    ema9,
    ema21,
    ema20,
    ema50,
    macd,
    bollinger,
    vwap,
    atr14,
    trend,
    emaCross,
  };
}
