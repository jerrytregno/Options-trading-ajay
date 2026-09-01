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

type KiteInstrumentLike = Omit<KiteInstrument, "name"> & { name?: string };

function isUnderlyingOption(
  item: KiteInstrumentLike,
  chainSymbol: string,
  chainExchange: string,
): boolean {
  return (
    item.segment === `${chainExchange}-OPT` &&
    item.name === chainSymbol &&
    (item.tradingsymbol.endsWith("CE") || item.tradingsymbol.endsWith("PE"))
  );
}

function getNearestExpiry(expiries: string[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sorted = [...expiries].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const upcoming = sorted.filter((expiry) => new Date(expiry) >= today);
  return upcoming[0] ?? sorted[0];
}

export interface NearestExpiryChain {
  byStrike: Map<number, { CE?: KiteInstrument; PE?: KiteInstrument }>;
  strikes: number[];
}

/**
 * Derived front-expiry chain, rebuilt only when the instrument master itself changes.
 *
 * The dump is ~100k rows and reducing it to one expiry costs a full map plus three passes. That
 * landed on the entry path, which is the one place in the bot where tens of milliseconds are worth
 * something. The cached rows array is replaced wholesale when the master refreshes, so its
 * identity is a sound cache key; the expiry roll is caught by keying on the date as well.
 */
let chainCache: { rows: unknown; dayKey: string; chain: NearestExpiryChain | null } | null = null;

/** @internal Exported so the chain reduction can be checked against a brute-force reference. */
export function nearestExpiryChain(
  rows: KiteInstrumentLike[],
  chainSymbol: string,
  chainExchange: string,
): NearestExpiryChain | null {
  const dayKey = new Date().toDateString();
  if (chainCache && chainCache.rows === rows && chainCache.dayKey === dayKey) {
    return chainCache.chain;
  }

  // Narrowed before it is copied: the underlying's options are a few thousand of the ~100k rows,
  // and mapping the whole dump first threw almost all of that allocation away.
  const underlyingOptions: KiteInstrument[] = [];
  for (const row of rows) {
    if (!isUnderlyingOption(row, chainSymbol, chainExchange)) continue;
    underlyingOptions.push({
      instrument_token: row.instrument_token,
      tradingsymbol: row.tradingsymbol,
      name: row.name ?? "",
      expiry: row.expiry,
      strike: row.strike,
      lot_size: row.lot_size ?? 65,
      instrument_type: row.instrument_type ?? "",
      segment: row.segment ?? "",
      exchange: row.exchange ?? chainExchange,
    });
  }

  let chain: NearestExpiryChain | null = null;

  if (underlyingOptions.length > 0) {
    const expiries = [...new Set(underlyingOptions.map((i) => i.expiry).filter(Boolean))] as string[];
    const selectedExpiry = getNearestExpiry(expiries);

    const byStrike = new Map<number, { CE?: KiteInstrument; PE?: KiteInstrument }>();
    for (const item of underlyingOptions) {
      if (item.expiry !== selectedExpiry) continue;
      const strike = item.strike;
      if (!strike) continue;
      let entry = byStrike.get(strike);
      if (!entry) {
        entry = {};
        byStrike.set(strike, entry);
      }
      if (item.tradingsymbol.endsWith("CE")) entry.CE ??= item;
      else if (item.tradingsymbol.endsWith("PE")) entry.PE ??= item;
    }
    if (byStrike.size > 0) chain = { byStrike, strikes: [...byStrike.keys()] };
  }

  chainCache = { rows, dayKey, chain };
  return chain;
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
  const chain = nearestExpiryChain(rows, streamInst.chainSymbol, streamInst.chainExchange);
  if (!chain) return null;

  let spotPrice = options?.spotPrice != null && options.spotPrice > 0 ? options.spotPrice : 0;
  if (spotPrice <= 0) {
    const spotQuotes = await kiteGet<Record<string, { last_price?: number }>>(
      `/quote?i=${encodeURIComponent(streamInst.kiteKey)}`,
      accessToken,
    );
    spotPrice = spotQuotes[streamInst.kiteKey]?.last_price ?? 0;
  }
  const atmStrike = findAtmStrike(chain.strikes, spotPrice);
  const { optionType } = parseTradeLeg(leg);

  const match = chain.byStrike.get(atmStrike)?.[optionType];
  if (!match) return null;

  return {
    strike: atmStrike,
    tradingsymbol: match.tradingsymbol,
    lotSize: match.lot_size ?? 65,
    spotPrice,
    instrumentToken: match.instrument_token ?? 0,
  };
}
