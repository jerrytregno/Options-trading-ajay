/** Wilder RSI from a close series; returns value at the last close in the array. */
export function rsiWilderFromCloses(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** RSI at `endIndex` using `period` prior 1-min closes (inclusive of bar at endIndex). */
export function rsiAtBarIndex(closes: number[], endIndex: number, period = 14): number | null {
  if (endIndex < period || endIndex >= closes.length) return null;
  return rsiWilderFromCloses(closes.slice(endIndex - period, endIndex + 1), period);
}
