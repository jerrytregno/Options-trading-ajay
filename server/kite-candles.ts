import { kiteGet } from "./kite-client.js";
import { getKiteInstruments } from "./kite-instruments.js";

export interface KiteInstrument {
  instrument_token: number;
  tradingsymbol: string;
  name: string;
  expiry?: string;
  strike?: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
}

export async function getCachedInstruments(exchange: string): Promise<KiteInstrument[]> {
  const rows = await getKiteInstruments(exchange);
  return rows.map((row) => ({
    instrument_token: row.instrument_token,
    tradingsymbol: row.tradingsymbol,
    name: row.name ?? "",
    expiry: row.expiry,
    strike: row.strike,
    lot_size: row.lot_size ?? 1,
    instrument_type: row.instrument_type ?? "",
    segment: row.segment ?? "",
    exchange: row.exchange ?? exchange,
  }));
}

/**
 * Kept out of `app.ts` so the backtest build worker can pull in the fetcher without dragging
 * Express, the live bot and the auth stack into a process that only crunches candles.
 */
export async function fetchHistoricalCandles(
  accessToken: string,
  resolvedKey: string,
  interval: string,
  from: string,
  to: string,
) {
  const [exchange, tradingsymbol] = resolvedKey.split(":");
  const instruments = await getCachedInstruments(exchange);
  const match = instruments.find((item) => item.tradingsymbol === tradingsymbol);

  if (!match) {
    throw new Error(`Instrument not found: ${resolvedKey}`);
  }

  const data = await kiteGet<{ candles: unknown[] }>(
    `/instruments/historical/${match.instrument_token}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken,
  );

  return {
    instrument: resolvedKey,
    candles: data.candles ?? data,
  };
}
