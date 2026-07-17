export interface StreamInstrument {
  id: string;
  label: string;
  kiteKey: string;
  /** Underlying name in Kite instruments master (e.g. NIFTY). */
  chainSymbol: string;
  /** NFO for NSE F&O options chain. */
  chainExchange: "NFO" | "BFO";
  /** Nearest FUT on NFO — used for volume & order book when kiteKey is an index. */
  activityUnderlying?: string;
}

export const STREAM_INSTRUMENTS: StreamInstrument[] = [
  {
    id: "nifty50",
    label: "Nifty 50",
    kiteKey: "NSE:NIFTY 50",
    chainSymbol: "NIFTY",
    chainExchange: "NFO",
    activityUnderlying: "NIFTY",
  },
];

export const DEFAULT_STREAM_INSTRUMENT_ID = "nifty50";

export function getStreamInstrument(id: string) {
  return STREAM_INSTRUMENTS.find((item) => item.id === id) ?? STREAM_INSTRUMENTS[0];
}

export function isStreamInstrumentId(id: string) {
  return STREAM_INSTRUMENTS.some((item) => item.id === id);
}
