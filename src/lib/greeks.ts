export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  iv: number;
}

const RISK_FREE_RATE = 0.065;

function normPdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function blackScholes(
  spot: number,
  strike: number,
  timeToExpiry: number,
  volatility: number,
  type: "CE" | "PE"
) {
  if (timeToExpiry <= 0 || volatility <= 0 || spot <= 0 || strike <= 0) {
    return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 = (Math.log(spot / strike) + (RISK_FREE_RATE + 0.5 * volatility * volatility) * timeToExpiry) / (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;

  let price: number;
  let delta: number;

  if (type === "CE") {
    price = spot * normCdf(d1) - strike * Math.exp(-RISK_FREE_RATE * timeToExpiry) * normCdf(d2);
    delta = normCdf(d1);
  } else {
    price = strike * Math.exp(-RISK_FREE_RATE * timeToExpiry) * normCdf(-d2) - spot * normCdf(-d1);
    delta = normCdf(d1) - 1;
  }

  const gamma = normPdf(d1) / (spot * volatility * sqrtT);
  const vega = (spot * normPdf(d1) * sqrtT) / 100;
  const theta =
    (-(spot * normPdf(d1) * volatility) / (2 * sqrtT) -
      RISK_FREE_RATE * strike * Math.exp(-RISK_FREE_RATE * timeToExpiry) * normCdf(type === "CE" ? d2 : -d2) *
        (type === "CE" ? 1 : -1)) /
    365;

  return { price, delta, gamma, theta, vega };
}

export function blackScholesPrice(
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  volatility: number,
  type: "CE" | "PE",
): number {
  const { price } = blackScholes(spot, strike, timeToExpiryYears, volatility, type);
  return Math.max(0, price);
}

export function timeToExpiryYearsFrom(dateIso: string, timeHm: string, expiry: string): number {
  const entryMs = new Date(`${dateIso}T${timeHm}:00+05:30`).getTime();
  const expMs = new Date(`${expiry}T15:30:00+05:30`).getTime();
  const ms = Math.max(expMs - entryMs, 60_000);
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

/** Model premium when historical option quotes are unavailable. */
export function estimateOptionPremium(
  spot: number,
  strike: number,
  dateIso: string,
  timeHm: string,
  expiry: string,
  type: "CE" | "PE",
  iv = 0.16,
): number {
  const tte = timeToExpiryYearsFrom(dateIso, timeHm, expiry);
  return Number(blackScholesPrice(spot, strike, tte, iv, type).toFixed(2));
}

function impliedVolatility(
  marketPrice: number,
  spot: number,
  strike: number,
  timeToExpiry: number,
  type: "CE" | "PE"
) {
  if (marketPrice <= 0 || spot <= 0 || strike <= 0 || timeToExpiry <= 0) return 0;

  let sigma = 0.25;
  for (let i = 0; i < 60; i++) {
    const { price, vega } = blackScholes(spot, strike, timeToExpiry, sigma, type);
    const diff = price - marketPrice;
    if (Math.abs(diff) < 0.01) break;
    if (vega === 0) break;
    sigma -= diff / (vega * 100);
    sigma = Math.max(0.05, Math.min(3, sigma));
  }

  return sigma;
}

export function getTimeToExpiry(expiry: string) {
  const expiryDate = new Date(`${expiry}T15:30:00+05:30`);
  const now = Date.now();
  const ms = expiryDate.getTime() - now;
  const minute = 60 * 1000;
  return Math.max(ms / (365.25 * 24 * 60 * 60 * 1000), minute / (365.25 * 24 * 60 * 60 * 1000));
}

export function calculateGreeks(
  spot: number,
  strike: number,
  expiry: string,
  marketPrice: number,
  type: "CE" | "PE"
): OptionGreeks | null {
  if (marketPrice <= 0 || spot <= 0 || strike <= 0) return null;

  const timeToExpiry = getTimeToExpiry(expiry);
  const iv = impliedVolatility(marketPrice, spot, strike, timeToExpiry, type);
  if (iv <= 0) return null;

  const { delta, gamma, theta, vega } = blackScholes(spot, strike, timeToExpiry, iv, type);
  return {
    delta,
    gamma,
    theta,
    vega,
    iv: iv * 100,
  };
}

export function findAtmStrike(strikes: number[], spotPrice: number) {
  if (strikes.length === 0 || spotPrice <= 0) return 0;
  return strikes.reduce((closest, strike) =>
    Math.abs(strike - spotPrice) < Math.abs(closest - spotPrice) ? strike : closest
  );
}

export function filterStrikesAroundAtm(strikes: number[], atmStrike: number, window = 15) {
  if (strikes.length === 0) return new Set<number>();
  const sorted = [...strikes].sort((a, b) => a - b);
  const atmIndex = sorted.indexOf(atmStrike);
  if (atmIndex === -1) return new Set(sorted);

  const start = Math.max(0, atmIndex - window);
  const end = Math.min(sorted.length, atmIndex + window + 1);
  return new Set(sorted.slice(start, end));
}
