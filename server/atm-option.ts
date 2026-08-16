import { findAtmStrike } from "../src/lib/greeks.js";
import { getStreamInstrument } from "../src/lib/stream-instruments.js";
import { parseTradeLeg, type TradeLeg } from "../src/lib/trade-calculations.js";
import { getKiteInstruments } from "./kite-instruments.js";
import { kiteGet } from "./kite-client.js";

type KiteInstrument = {
  instrument_token?: number;
  tradingsymbol: string;
  name: string;
  expiry?: string;
  strike?: number;
  lot_size?: number;
  instrument_type?: string;
  segment?: string;
  exchange?: string;
};

function filterUnderlyingOptions(instruments: KiteInstrument[], chainSymbol: string, chainExchange: string) {
  const segment = `${chainExchange}-OPT`;
  return instruments.filter(
    (item) =>
      item.segment === segment &&
      item.name === chainSymbol &&
      (item.tradingsymbol.endsWith("CE") || item.tradingsymbol.endsWith("PE")),
  );
}

function getNearestExpiry(expiries: string[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sorted = [...expiries].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const upcoming = sorted.filter((expiry) => new Date(expiry) >= today);
  return upcoming[0] ?? sorted[0];
}

export interface ResolvedAtmOption {
  strike: number;
  tradingsymbol: string;
  lotSize: number;
  spotPrice: number;
  instrumentToken: number;
}

/**
 * Load the NFO instrument master into cache ahead of time. The dump is ~100k rows, so paying
 * for it at 9:16:00 costs seconds of the entry window.
 */
export async function prewarmNiftyOptionChain(): Promise<number> {
  const streamInst = getStreamInstrument("nifty50");
  const rows = await getKiteInstruments(streamInst.chainExchange);
  return rows.length;
}

/**
 * `spotPrice` lets callers pass the live websocket Nifty tick. Kite caps /quote at one request
 * per second, so skipping that call keeps the 9:16:00 order path free of REST latency.
 */
export async function resolveAtmNiftyOption(
  accessToken: string,
  leg: TradeLeg,
  options?: { spotPrice?: number },
): Promise<ResolvedAtmOption | null> {
  const streamInst = getStreamInstrument("nifty50");
  const rows = await getKiteInstruments(streamInst.chainExchange);
  const instruments: KiteInstrument[] = rows.map((row) => ({
    instrument_token: row.instrument_token,
    tradingsymbol: row.tradingsymbol,
    name: row.name ?? "",
    expiry: row.expiry,
    strike: row.strike,
    lot_size: row.lot_size ?? 65,
    instrument_type: row.instrument_type ?? "",
    segment: row.segment ?? "",
    exchange: row.exchange ?? streamInst.chainExchange,
  }));

  const underlyingOptions = filterUnderlyingOptions(
    instruments,
    streamInst.chainSymbol,
    streamInst.chainExchange,
  );
  if (underlyingOptions.length === 0) return null;

  const expiries = [...new Set(underlyingOptions.map((i) => i.expiry).filter(Boolean))] as string[];
  const selectedExpiry = getNearestExpiry(expiries);
  const expiryOptions = underlyingOptions.filter((i) => i.expiry === selectedExpiry);

  let spotPrice = options?.spotPrice != null && options.spotPrice > 0 ? options.spotPrice : 0;
  if (spotPrice <= 0) {
    const spotQuotes = await kiteGet<Record<string, { last_price?: number }>>(
      `/quote?i=${encodeURIComponent(streamInst.kiteKey)}`,
      accessToken,
    );
    spotPrice = spotQuotes[streamInst.kiteKey]?.last_price ?? 0;
  }
  const strikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))];
  const atmStrike = findAtmStrike(strikes, spotPrice);
  const { optionType } = parseTradeLeg(leg);

  const match = expiryOptions.find(
    (item) => item.strike === atmStrike && item.tradingsymbol.endsWith(optionType),
  );
  if (!match) return null;

  return {
    strike: atmStrike,
    tradingsymbol: match.tradingsymbol,
    lotSize: match.lot_size ?? 65,
    spotPrice,
    instrumentToken: match.instrument_token ?? 0,
  };
}
