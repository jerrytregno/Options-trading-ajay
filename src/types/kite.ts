export interface KiteProfile {
  user_id: string;
  user_name: string;
  email: string;
  broker: string;
  exchanges: string[];
  products: string[];
  order_types: string[];
}

/** Result of the most recent headless Zerodha login attempt on the server. */
export interface KiteAutoLoginRun {
  at: string;
  ok: boolean;
  attempts: number;
  userId?: string;
  error?: string;
}

export interface KiteAutoLoginStatus {
  /** KITE_AUTO_LOGIN_ENABLED=1 on the server. */
  enabled: boolean;
  /** All credentials needed for a headless login are present. */
  configured: boolean;
  /** IST time of the daily refresh, e.g. "07:40". */
  refreshAtIst: string;
  running: boolean;
  lastRun: KiteAutoLoginRun | null;
}

export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

export interface KiteQuote {
  instrument_token: number;
  last_price: number;
  change: number;
  change_percent: number;
  volume: number;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  greeks?: OptionGreeks;
  depth?: {
    buy: { price: number; quantity: number; orders?: number }[];
    sell: { price: number; quantity: number; orders?: number }[];
  };
}

export interface KiteInstrument {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry?: string;
  strike?: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
}

export interface KitePosition {
  tradingsymbol: string;
  exchange: string;
  instrument_token: number;
  product: string;
  quantity: number;
  overnight_quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
  m2m: number;
  unrealised: number;
  realised: number;
}

export interface KiteHolding {
  tradingsymbol: string;
  exchange: string;
  isin: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
  day_change: number;
  day_change_percentage: number;
}

export interface OptionChainRow {
  strike: number;
  isAtm?: boolean;
  ce?: KiteInstrument & { quote?: KiteQuote };
  pe?: KiteInstrument & { quote?: KiteQuote };
}

export interface OptionChainResponse {
  symbol: string;
  exchange: string;
  expiry: string;
  expiries: string[];
  spotPrice: number;
  atmStrike: number;
  chain: OptionChainRow[];
  updatedAt: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

