export type WatchlistSegment = "index" | "equity" | "commodity";

export interface WatchlistItem {
  id: string;
  label: string;
  segment: WatchlistSegment;
  /** Kite quote key, or MCX base name when resolveMcx is true */
  kiteKey: string;
  tradingViewSymbol: string;
  resolveMcx?: boolean;
}

export const WATCHLIST_ITEMS: WatchlistItem[] = [
  { id: "nifty", label: "Nifty 50", segment: "index", kiteKey: "NSE:NIFTY 50", tradingViewSymbol: "NSE:NIFTY" },
  { id: "banknifty", label: "Bank Nifty", segment: "index", kiteKey: "NSE:NIFTY BANK", tradingViewSymbol: "NSE:BANKNIFTY" },
  { id: "reliance", label: "Reliance", segment: "equity", kiteKey: "NSE:RELIANCE", tradingViewSymbol: "NSE:RELIANCE" },
  { id: "tcs", label: "TCS", segment: "equity", kiteKey: "NSE:TCS", tradingViewSymbol: "NSE:TCS" },
  { id: "infy", label: "Infosys", segment: "equity", kiteKey: "NSE:INFY", tradingViewSymbol: "NSE:INFY" },
  { id: "gold", label: "Gold", segment: "commodity", kiteKey: "GOLDM", tradingViewSymbol: "MCX:GOLD1!", resolveMcx: true },
  { id: "silver", label: "Silver", segment: "commodity", kiteKey: "SILVERM", tradingViewSymbol: "MCX:SILVER1!", resolveMcx: true },
  { id: "crude", label: "Crude Oil", segment: "commodity", kiteKey: "CRUDEOIL", tradingViewSymbol: "MCX:CRUDEOIL1!", resolveMcx: true },
  { id: "naturalgas", label: "Natural Gas", segment: "commodity", kiteKey: "NATURALGAS", tradingViewSymbol: "MCX:NATURALGAS1!", resolveMcx: true },
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
