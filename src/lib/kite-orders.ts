export type KiteOrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";

/** Kite API: -1 = auto protection, or 0.01–100 for custom % band. */
export function resolveMarketProtection(envValue?: string) {
  if (envValue == null || envValue.trim() === "") return "-1";
  const num = Number(envValue);
  if (num === -1) return "-1";
  if (num > 0 && num <= 100) return String(num);
  return "-1";
}

export function orderTypeNeedsMarketProtection(orderType: string) {
  const normalized = orderType.toUpperCase();
  return normalized === "MARKET" || normalized === "SL-M";
}

export function normalizeKiteOrderBody(
  input: Record<string, string | number | undefined | null>,
  marketProtection = "-1"
): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    body[key] = String(value);
  }
  if (!body.variety) body.variety = "regular";
  if (body.exchange === "NFO" && body.product === "CNC") {
    body.product = "NRML";
  }
  if (orderTypeNeedsMarketProtection(body.order_type) && !body.market_protection) {
    body.market_protection = marketProtection;
  }
  return body;
}

/** Aggressive square-off: MARKET with exchange protection (server also enforces). */
export function buildProtectedMarketOrder(
  fields: Record<string, string | number>,
  marketProtection = "-1"
) {
  return normalizeKiteOrderBody(
    { ...fields, order_type: "MARKET", variety: "regular", validity: "DAY" },
    marketProtection
  );
}

/** Limit exit at current premium — no market_protection needed. */
export function buildLimitExitOrder(
  fields: Record<string, string | number>,
  limitPrice: number
) {
  return normalizeKiteOrderBody({
    ...fields,
    order_type: "LIMIT",
    price: Number(limitPrice.toFixed(2)),
    variety: "regular",
    validity: "DAY",
  });
}

export const NIFTY_OPTION_TICK = 0.05;
export const DEFAULT_BRACKET_STOPLOSS_POINTS = 20;

export function roundToOptionTick(value: number, tick = NIFTY_OPTION_TICK) {
  return Math.round(value / tick) * tick;
}

/** Premium points above entry for a fixed INR profit target. */
export function profitTargetPointsFromInr(quantity: number, targetProfitInr: number) {
  const qty = Math.max(1, quantity);
  return roundToOptionTick(targetProfitInr / qty);
}

/** Limit / bracket target premium: entry + (target INR ÷ qty). */
export function profitTargetPremiumPrice(
  entryPremium: number,
  quantity: number,
  targetProfitInr: number
) {
  const qty = Math.max(1, quantity);
  return roundToOptionTick(entryPremium + targetProfitInr / qty);
}

/** Bracket entry — Zerodha squares off at entry + squareoff points (profit target). */
export function buildBracketEntryOrder(
  fields: Record<string, string | number>,
  quantity: number,
  targetProfitInr: number,
  stoplossPoints = DEFAULT_BRACKET_STOPLOSS_POINTS,
  marketProtection = "-1"
) {
  const squareoff = profitTargetPointsFromInr(quantity, targetProfitInr);
  const orderType = String(fields.order_type ?? "MARKET").toUpperCase();
  const payload: Record<string, string | number> = {
    ...fields,
    variety: "bo",
    validity: "DAY",
    squareoff,
    stoploss: stoplossPoints,
  };
  if (orderType === "MARKET" || orderType === "SL-M") {
    return normalizeKiteOrderBody(payload, marketProtection);
  }
  return normalizeKiteOrderBody(payload);
}

export function kiteOrdersApiPath(variety: string) {
  switch (variety.toLowerCase()) {
    case "bo":
      return "/orders/bo";
    case "co":
      return "/orders/co";
    case "amo":
      return "/orders/amo";
    default:
      return "/orders/regular";
  }
}
