export interface StreamInstrument {
  id: string;
  label: string;
  kiteKey: string;
  /** Underlying name in Kite instruments master (e.g. NIFTY, DIXON). */
  chainSymbol: string;
  /** NFO for NSE F&O · BFO for Sensex options. */
  chainExchange: "NFO" | "BFO";
}

export const STREAM_INSTRUMENTS: StreamInstrument[] = [
  {
    id: "nifty50",
    label: "Nifty 50",
    kiteKey: "NSE:NIFTY 50",
    chainSymbol: "NIFTY",
    chainExchange: "NFO",
  },
  {
    id: "sensex",
    label: "Sensex",
    kiteKey: "BSE:SENSEX",
    chainSymbol: "SENSEX",
    chainExchange: "BFO",
  },
  {
    id: "dixon",
    label: "Dixon",
    kiteKey: "NSE:DIXON",
    chainSymbol: "DIXON",
    chainExchange: "NFO",
  },
  {
    id: "hdfcbank",
    label: "HDFC Bank",
    kiteKey: "NSE:HDFCBANK",
    chainSymbol: "HDFCBANK",
    chainExchange: "NFO",
  },
];

export const DEFAULT_STREAM_INSTRUMENT_ID = "nifty50";

export function getStreamInstrument(id: string) {
  return STREAM_INSTRUMENTS.find((item) => item.id === id) ?? STREAM_INSTRUMENTS[0];
}
