import type { ProductType, TradeLeg } from "@/lib/trade-calculations";

export interface OrderMarginResponse {
  total?: number;
  span?: number;
  exposure?: number;
  option_premium?: number;
  charges?: number;
  leverage?: number;
}

export interface TradeOrderPayload {
  tradingsymbol: string;
  exchange: string;
  transaction_type: "BUY" | "SELL";
  order_type: string;
  product: ProductType;
  quantity: number;
  price?: number;
  trigger_price?: number;
  validity: "DAY";
  variety: "regular";
}

export interface TradePrefill {
  strike?: number;
  leg?: TradeLeg;
}
