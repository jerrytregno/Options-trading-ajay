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
