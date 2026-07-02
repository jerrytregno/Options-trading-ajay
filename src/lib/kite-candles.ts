export interface KiteCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface WatchlistHistoryItem {
  id: string;
  label: string;
  segment: string;
  kiteKey: string;
  candles: unknown[];
  error?: string;
}

export function parseKiteCandles(raw: unknown[]): KiteCandle[] {
  return raw
    .map((row) => {
      if (Array.isArray(row)) {
        return {
          date: String(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0),
        };
      }

      const record = row as Record<string, unknown>;
      return {
        date: String(record.date ?? record.time ?? ""),
        open: Number(record.open),
        high: Number(record.high),
        low: Number(record.low),
        close: Number(record.close),
        volume: Number(record.volume ?? 0),
      };
    })
    .filter((candle) => Number.isFinite(candle.close));
}

export function formatChartDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}
