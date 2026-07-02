export type WatchlistSegment = "index" | "equity" | "commodity";

export interface WatchlistItem {
  id: string;
  label: string;
  segment: WatchlistSegment;
  /** Kite quote key, or MCX base name when resolveMcx is true */
  kiteKey: string;
  resolveMcx?: boolean;
}

export const WATCHLIST_ITEMS: WatchlistItem[] = [
  { id: "nifty", label: "Nifty 50", segment: "index", kiteKey: "NSE:NIFTY 50" },
  { id: "banknifty", label: "Bank Nifty", segment: "index", kiteKey: "NSE:NIFTY BANK" },
  { id: "reliance", label: "Reliance", segment: "equity", kiteKey: "NSE:RELIANCE" },
  { id: "tcs", label: "TCS", segment: "equity", kiteKey: "NSE:TCS" },
  { id: "infy", label: "Infosys", segment: "equity", kiteKey: "NSE:INFY" },
  { id: "gold", label: "Gold", segment: "commodity", kiteKey: "GOLDM", resolveMcx: true },
  { id: "silver", label: "Silver", segment: "commodity", kiteKey: "SILVERM", resolveMcx: true },
  { id: "crude", label: "Crude Oil", segment: "commodity", kiteKey: "CRUDEOIL", resolveMcx: true },
  { id: "naturalgas", label: "Natural Gas", segment: "commodity", kiteKey: "NATURALGAS", resolveMcx: true },
];

export const WATCHLIST_DEFAULT = WATCHLIST_ITEMS.map((item) => item.kiteKey);

export const WATCHLIST_SEGMENT_LABELS: Record<WatchlistSegment, string> = {
  index: "Indices",
  equity: "Equities",
  commodity: "Commodities",
};

export function getWatchlistItem(id: string) {
  return WATCHLIST_ITEMS.find((item) => item.id === id);
}
