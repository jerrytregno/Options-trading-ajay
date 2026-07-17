import { findAtmStrike } from "../src/lib/greeks.js";
import { getKiteInstruments, type KiteInstrumentRow } from "./kite-instruments.js";
import { kiteHttpFetch } from "./kite-http.js";

const KITE_BASE = "https://api.kite.trade";
const CHAIN_SYMBOL = "NIFTY";
const NIFTY_SPOT_KEY = "NSE:NIFTY 50";
/** Must match BACKTEST_CONFIDENCE_THRESHOLD in src/lib/prediction-confidence.ts */
const CONFIDENCE_THRESHOLD = 0.85;
const RISK_PER_TRADE_PCT = 1;
const STOP_LOSS_PCT = 15;
/** Net profit target per trade (after Zerodha charges). */
export const PREDICTION_TARGET_PROFIT_INR = 200;
/** Zerodha flat charge per order leg (buy or sell). */
export const ZERODHA_ORDER_CHARGE_INR = 25;
/** Round-trip cost per completed option trade (buy + sell). */
export const ZERODHA_ROUND_TRIP_CHARGE_INR = ZERODHA_ORDER_CHARGE_INR * 2;
const OPTION_SCAN_INTERVAL = "minute";

interface KiteQuotePayload {
  last_price?: number;
  depth?: {
    buy?: { price: number }[];
    sell?: { price: number }[];
  };
}

interface BacktestBar {
  time: string;
  timeLabel?: string;
  close: number;
  nextClose?: number | null;
  revealed?: boolean;
  probabilities: { down: number; flat: number; up: number };
}

export interface OptionTradePlan {
  availableBalance: number;
  lotSize: number;
  expiry: string;
  atmStrike: number;
  spotPrice?: number;
  atmCallSymbol?: string;
  atmPutSymbol?: string;
  atmCallPremium?: number;
  atmPutPremium?: number;
  suggestedLotsCall?: number;
  suggestedLotsPut?: number;
  costPerLotCall?: number;
  costPerLotPut?: number;
  riskPerTradePct: number;
  targetProfitInr: number;
  stopLossPct: number;
}

export type OptionExitReason = "target" | "stop" | "eod" | "open";

export interface BarOptionTrade {
  /** True when a position was opened on this signal bar. */
  tradeEntered: boolean;
  /** Signal fired but skipped (e.g. already in a trade). */
  skipped?: boolean;
  skipReason?: string;
  strike: number;
  symbol: string;
  side: "CE" | "PE";
  entryPremium: number | null;
  /** Premium needed for net profit target (predicted exit level). */
  targetExitPremium: number | null;
  exitPremium: number | null;
  exitTimeLabel?: string | null;
  holdMinutes?: number | null;
  exitReason?: OptionExitReason | null;
  lots: number;
  quantity: number;
  costRupees: number | null;
  grossPnlRupees: number | null;
  brokerageRupees: number | null;
  pnlRupees: number | null;
}

export interface LiveAtmSideScenario {
  direction: "up" | "down";
  side: "CE" | "PE";
  probability: number;
  signalAtThreshold: boolean;
  symbol: string;
  strike: number;
  entryPremium: number;
  /** How entry premium was chosen (target bar open vs live quote). */
  entrySource?: "target_open" | "prior_close" | "live";
  costPerLot: number;
  exitPremiumAtClose: number | null;
  exitLabel: string | null;
  candleClosed: boolean;
  /** Live mark when target candle has not closed yet. */
  exitPremiumLive?: number | null;
  grossPnlLive1Lot?: number | null;
  netPnlLive1Lot?: number | null;
  grossPnl1Lot: number | null;
  netPnl1Lot: number | null;
  /** Premium needed for ₹200 net (1 lot), same as auto-trader target. */
  targetExitPremium: number | null;
  /** IST HH:mm when 1m premium scan first hits ₹200 net (1 lot). */
  profitAtMinute: string | null;
  profitAtExitPremium: number | null;
  profitAtNetPnl: number | null;
  profitAtHoldMinutes: number | null;
  profitScanReason: OptionExitReason | null;
}

export interface LiveAtmScenarios {
  spotPrice: number;
  atmStrike: number;
  expiry: string;
  lotSize: number;
  targetCandleLabel: string;
  callPremium: number;
  putPremium: number;
  callSymbol: string;
  putSymbol: string;
  callCostPerLot: number;
  putCostPerLot: number;
  up: LiveAtmSideScenario;
  down: LiveAtmSideScenario;
  error?: string;
}

function getTodayIstDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export function isTodayIstBacktestDate(dateStr: string): boolean {
  return dateStr === getTodayIstDate();
}

async function kiteGet<T>(path: string, accessToken: string, apiKey: string): Promise<T> {
  const res = await kiteHttpFetch(`${KITE_BASE}${path}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${apiKey}:${accessToken}`,
    },
  });
  const json = (await res.json()) as { status?: string; message?: string; data?: T };
  if (json.status === "error") throw new Error(json.message ?? "Kite API error");
  return json.data as T;
}

function getEffectiveLtp(quote?: KiteQuotePayload): number {
  if (!quote) return 0;
  if (quote.last_price && quote.last_price > 0) return quote.last_price;
  const bid = quote.depth?.buy?.[0]?.price ?? 0;
  const ask = quote.depth?.sell?.[0]?.price ?? 0;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return bid || ask || 0;
}

function filterNiftyOptions(instruments: KiteInstrumentRow[]) {
  return instruments.filter(
    (item) =>
      item.segment === "NFO-OPT" &&
      item.name === CHAIN_SYMBOL &&
      (item.tradingsymbol.endsWith("CE") || item.tradingsymbol.endsWith("PE")),
  );
}

function expiryForDate(expiries: string[], targetDate: string): string {
  const target = new Date(`${targetDate}T12:00:00+05:30`).getTime();
  const sorted = [...new Set(expiries)].sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime(),
  );
  const upcoming = sorted.filter((expiry) => new Date(`${expiry}T12:00:00+05:30`).getTime() >= target);
  return upcoming[0] ?? sorted[sorted.length - 1];
}

function confidentDirection(probs: { down: number; flat: number; up: number }) {
  const { down, up } = probs;
  if (up >= CONFIDENCE_THRESHOLD && up > down) return "up" as const;
  if (down >= CONFIDENCE_THRESHOLD && down > up) return "down" as const;
  return null;
}

function lotsForRisk(capital: number, entryPremium: number, lotSize: number): number {
  if (capital <= 0 || entryPremium <= 0 || lotSize <= 0) return 1;
  const riskBudget = capital * (RISK_PER_TRADE_PCT / 100);
  const lossPerLot = entryPremium * (STOP_LOSS_PCT / 100) * lotSize;
  if (lossPerLot <= 0) return 1;
  return Math.max(1, Math.floor(riskBudget / lossPerLot));
}

function istMinuteKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const pick = (type: string) => fmt.find((p) => p.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

function barMinuteKey(bar: BacktestBar, targetDate: string): string {
  if (bar.time) {
    const key = istMinuteKey(bar.time);
    if (key) return key;
  }
  if (bar.timeLabel) {
    const parts = bar.timeLabel.trim().split(":");
    if (parts.length >= 2) {
      const hh = parts[0].padStart(2, "0");
      const mm = parts[1].padStart(2, "0");
      return `${targetDate} ${hh}:${mm}`;
    }
  }
  return "";
}

function minuteKeyToTimeLabel(key: string): string {
  return key.split(" ")[1] ?? key;
}

function addIntervalMinutes(key: string, minutes: number): string {
  const [datePart, timePart] = key.split(" ");
  const d = new Date(`${datePart}T${timePart}:00+05:30`);
  d.setMinutes(d.getMinutes() + minutes);
  return istMinuteKey(d.toISOString());
}

function minutesBetween(startKey: string, endKey: string): number {
  const [d1, t1] = startKey.split(" ");
  const [d2, t2] = endKey.split(" ");
  const start = new Date(`${d1}T${t1}:00+05:30`).getTime();
  const end = new Date(`${d2}T${t2}:00+05:30`).getTime();
  return Math.max(0, Math.round((end - start) / 60_000));
}

function candleMinuteKey(raw: string | number | Date): string {
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return istMinuteKey(d.toISOString());
  const match = s.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (match) return `${match[1]} ${match[2]}:${match[3]}`;
  return s.slice(0, 16);
}

function buildCandleCloseMap(candles: unknown[]): Map<string, number> {
  return buildCandlePriceMaps(candles).closeMap;
}

function buildCandlePriceMaps(candles: unknown[]): {
  closeMap: Map<string, number>;
  openMap: Map<string, number>;
} {
  const closeMap = new Map<string, number>();
  const openMap = new Map<string, number>();
  for (const candle of candles) {
    if (!Array.isArray(candle) || candle[0] == null) continue;
    const key = candleMinuteKey(String(candle[0]));
    const open = Number(candle[1]);
    const close = Number(candle[4]);
    if (Number.isFinite(open)) openMap.set(key, open);
    if (Number.isFinite(close)) closeMap.set(key, close);
  }
  return { closeMap, openMap };
}

function resolveHoldEntryPremium(
  targetKey: string,
  asOfKey: string,
  openMap: Map<string, number>,
  closeMap: Map<string, number>,
  livePremium: number,
): { entry: number; source: "target_open" | "prior_close" | "live" } {
  const nowKey = istMinuteKey(new Date().toISOString());
  if (nowKey >= targetKey) {
    const open = lookupPremium(openMap, targetKey);
    if (open != null && open > 0) {
      return { entry: open, source: "target_open" };
    }
    const priorClose = lookupPremium(closeMap, asOfKey);
    if (priorClose != null && priorClose > 0) {
      return { entry: priorClose, source: "prior_close" };
    }
  }
  if (livePremium > 0) {
    return { entry: livePremium, source: "live" };
  }
  return { entry: 0, source: "live" };
}

function sortedMinuteKeys(
  priceMap: Map<string, number>,
  afterKey: string,
  untilKey: string,
): string[] {
  return [...priceMap.keys()]
    .filter((key) => key > afterKey && key <= untilKey)
    .sort();
}

function lookupPremium(map: Map<string, number>, key: string): number | null {
  if (!key) return null;
  const direct = map.get(key);
  if (direct != null) return direct;
  const prev = map.get(addIntervalMinutes(key, -1));
  if (prev != null) return prev;
  return map.get(addIntervalMinutes(key, 1)) ?? null;
}

function strikesMatch(a: number | undefined, b: number): boolean {
  if (a == null) return false;
  return Math.round(a) === Math.round(b);
}

function resolveOptionInstrument(
  options: KiteInstrumentRow[],
  expiry: string,
  strike: number,
  side: "CE" | "PE",
): KiteInstrumentRow | null {
  return (
    options.find(
      (item) =>
        item.expiry === expiry &&
        strikesMatch(item.strike, strike) &&
        item.tradingsymbol.endsWith(side),
    ) ?? null
  );
}

function nowIstDateTime(): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const pick = (type: string) => fmt.find((p) => p.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

function targetExitPremiumForProfit(
  entryPremium: number,
  quantity: number,
  netTargetInr = PREDICTION_TARGET_PROFIT_INR,
): number {
  const grossNeeded = netTargetInr + ZERODHA_ROUND_TRIP_CHARGE_INR;
  return Number((entryPremium + grossNeeded / quantity).toFixed(2));
}

interface SimulatedExit {
  exitPremium: number;
  exitKey: string;
  exitReason: OptionExitReason;
  grossPnlRupees: number;
  pnlRupees: number;
}

function simulateHoldUntilExit(
  priceMap: Map<string, number>,
  entryKey: string,
  sessionEndKey: string,
  entryPremium: number,
  quantity: number,
  livePremium?: number,
): SimulatedExit | null {
  const stopPremium = entryPremium * (1 - STOP_LOSS_PCT / 100);
  const forwardKeys = sortedMinuteKeys(priceMap, entryKey, sessionEndKey);

  for (const minuteKey of forwardKeys) {
    const premium = lookupPremium(priceMap, minuteKey);
    if (premium == null) continue;

    if (premium <= stopPremium) {
      const gross = (premium - entryPremium) * quantity;
      return {
        exitPremium: premium,
        exitKey: minuteKey,
        exitReason: "stop",
        grossPnlRupees: gross,
        pnlRupees: gross - ZERODHA_ROUND_TRIP_CHARGE_INR,
      };
    }

    const gross = (premium - entryPremium) * quantity;
    const net = gross - ZERODHA_ROUND_TRIP_CHARGE_INR;
    if (net >= PREDICTION_TARGET_PROFIT_INR) {
      return {
        exitPremium: premium,
        exitKey: minuteKey,
        exitReason: "target",
        grossPnlRupees: gross,
        pnlRupees: net,
      };
    }
  }

  if (forwardKeys.length === 0) {
    if (livePremium != null && livePremium > 0) {
      const gross = (livePremium - entryPremium) * quantity;
      return {
        exitPremium: livePremium,
        exitKey: entryKey,
        exitReason: "open",
        grossPnlRupees: gross,
        pnlRupees: gross - ZERODHA_ROUND_TRIP_CHARGE_INR,
      };
    }
    return null;
  }

  const lastKey = forwardKeys[forwardKeys.length - 1]!;
  const lastPremium = lookupPremium(priceMap, lastKey);
  if (lastPremium == null) return null;

  const atOrPastSquareOff = lastKey >= sessionEndKey;
  const markPremium =
    !atOrPastSquareOff && livePremium != null && livePremium > 0
      ? livePremium
      : lastPremium;
  const gross = (markPremium - entryPremium) * quantity;
  return {
    exitPremium: markPremium,
    exitKey: lastKey,
    exitReason: atOrPastSquareOff ? "eod" : "open",
    grossPnlRupees: gross,
    pnlRupees: gross - ZERODHA_ROUND_TRIP_CHARGE_INR,
  };
}

/** ATM option ₹ P/L from Zerodha — only for today's session. Holds until net target, −15% SL, or 3:29 PM. */
export async function enrichBacktestWithOptionPnl(
  accessToken: string,
  apiKey: string,
  targetDate: string,
  _interval: string,
  bars: BacktestBar[],
): Promise<{
  bars: Array<BacktestBar & { option?: BarOptionTrade | null }>;
  tradePlan: OptionTradePlan | null;
  error?: string;
}> {
  if (!isTodayIstBacktestDate(targetDate)) {
    return { bars: bars.map((b) => ({ ...b, option: null })), tradePlan: null };
  }

  try {
    const margins = await kiteGet<{
      equity?: { available?: { live_balance?: number }; net?: number };
    }>("/user/margins", accessToken, apiKey);
    const availableBalance =
      margins.equity?.available?.live_balance ?? margins.equity?.net ?? 0;

    const allInstruments = await getKiteInstruments("NFO", accessToken, apiKey);
    const niftyOptions = filterNiftyOptions(allInstruments);
    if (!niftyOptions.length) {
      return {
        bars: bars.map((b) => ({ ...b, option: null })),
        tradePlan: null,
        error: "No NIFTY options found in NFO instrument master",
      };
    }

    const expiries = [...new Set(niftyOptions.map((i) => i.expiry).filter(Boolean))] as string[];
    const expiry = expiryForDate(expiries, targetDate);
    const expiryOptions = niftyOptions.filter((i) => i.expiry === expiry);
    const strikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))].sort(
      (a, b) => a - b,
    );
    const lotSize = expiryOptions[0]?.lot_size ?? 75;

    const spotQuotes = await kiteGet<Record<string, KiteQuotePayload>>(
      `/quote?i=${encodeURIComponent(NIFTY_SPOT_KEY)}`,
      accessToken,
      apiKey,
    );
    const spotPrice = getEffectiveLtp(spotQuotes[NIFTY_SPOT_KEY]);

    const from = `${targetDate} 09:15:00`;
    const to = nowIstDateTime();
    const sessionEndKey = `${targetDate} 15:29`;

    type SignalSpec = {
      barIndex: number;
      strike: number;
      side: "CE" | "PE";
      instrument: KiteInstrumentRow;
      entryKey: string;
    };

    const signals: SignalSpec[] = [];
    bars.forEach((bar, index) => {
      if (!bar.revealed) return;
      const direction = confidentDirection(bar.probabilities);
      if (!direction) return;
      const side = direction === "up" ? "CE" : "PE";
      const strike = findAtmStrike(strikes, bar.close);
      const instrument = resolveOptionInstrument(expiryOptions, expiry, strike, side);
      if (!instrument) return;
      const entryKey = barMinuteKey(bar, targetDate);
      if (!entryKey) return;
      signals.push({ barIndex: index, strike, side, instrument, entryKey });
    });

    const uniqueTokens = new Map<number, KiteInstrumentRow>();
    for (const spec of signals) {
      uniqueTokens.set(spec.instrument.instrument_token, spec.instrument);
    }

    const priceMaps = new Map<number, Map<string, number>>();
    for (const instrument of uniqueTokens.values()) {
      const data = await kiteGet<{ candles: unknown[] }>(
        `/instruments/historical/${instrument.instrument_token}/${OPTION_SCAN_INTERVAL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        accessToken,
        apiKey,
      );
      priceMaps.set(instrument.instrument_token, buildCandleCloseMap(data.candles ?? []));
    }

    const liveQuoteKeys = [...uniqueTokens.values()].map((i) => `NFO:${i.tradingsymbol}`);
    let liveQuotes: Record<string, KiteQuotePayload> = {};
    if (liveQuoteKeys.length) {
      liveQuotes = await kiteGet<Record<string, KiteQuotePayload>>(
        `/quote?${liveQuoteKeys.map((k) => `i=${encodeURIComponent(k)}`).join("&")}`,
        accessToken,
        apiKey,
      );
    }

    const enrichedBars = bars.map((bar) => ({ ...bar, option: null as BarOptionTrade | null }));
    let busyUntilMinuteKey: string | null = null;

    for (const spec of signals) {
      const entryKey = spec.entryKey;

      if (busyUntilMinuteKey && entryKey <= busyUntilMinuteKey) {
        enrichedBars[spec.barIndex].option = {
          tradeEntered: false,
          skipped: true,
          skipReason: "In trade",
          strike: spec.strike,
          symbol: spec.instrument.tradingsymbol,
          side: spec.side,
          entryPremium: null,
          targetExitPremium: null,
          exitPremium: null,
          lots: 0,
          quantity: 0,
          costRupees: null,
          grossPnlRupees: null,
          brokerageRupees: null,
          pnlRupees: null,
        };
        continue;
      }

      const priceMap = priceMaps.get(spec.instrument.instrument_token);
      if (!priceMap) continue;

      const entryPremium = lookupPremium(priceMap, entryKey);
      if (entryPremium == null) continue;

      const ls = spec.instrument.lot_size ?? lotSize;
      const lots = lotsForRisk(availableBalance, entryPremium, ls);
      const quantity = lots * ls;
      const targetExitPremium = targetExitPremiumForProfit(entryPremium, quantity);
      const liveKey = `NFO:${spec.instrument.tradingsymbol}`;
      const livePremium = getEffectiveLtp(liveQuotes[liveKey]) || undefined;

      const simulated = simulateHoldUntilExit(
        priceMap,
        entryKey,
        sessionEndKey,
        entryPremium,
        quantity,
        livePremium,
      );

      if (!simulated) continue;

      busyUntilMinuteKey = simulated.exitKey;

      enrichedBars[spec.barIndex].option = {
        tradeEntered: true,
        strike: spec.strike,
        symbol: spec.instrument.tradingsymbol,
        side: spec.side,
        entryPremium,
        targetExitPremium,
        exitPremium: simulated.exitPremium,
        exitTimeLabel: minuteKeyToTimeLabel(simulated.exitKey),
        holdMinutes: minutesBetween(entryKey, simulated.exitKey),
        exitReason: simulated.exitReason,
        lots,
        quantity,
        costRupees: entryPremium * quantity,
        grossPnlRupees: simulated.grossPnlRupees,
        brokerageRupees: ZERODHA_ROUND_TRIP_CHARGE_INR,
        pnlRupees: simulated.pnlRupees,
      };
    }

    const atmStrike = findAtmStrike(strikes, spotPrice > 0 ? spotPrice : bars.at(-1)?.close ?? 0);
    const callInst = resolveOptionInstrument(expiryOptions, expiry, atmStrike, "CE");
    const putInst = resolveOptionInstrument(expiryOptions, expiry, atmStrike, "PE");
    const atmQuoteKeys = [callInst, putInst]
      .filter(Boolean)
      .map((i) => `NFO:${i!.tradingsymbol}`);
    let atmCallPremium = 0;
    let atmPutPremium = 0;
    if (atmQuoteKeys.length) {
      const quotes = await kiteGet<Record<string, KiteQuotePayload>>(
        `/quote?${atmQuoteKeys.map((k) => `i=${encodeURIComponent(k)}`).join("&")}`,
        accessToken,
        apiKey,
      );
      if (callInst) atmCallPremium = getEffectiveLtp(quotes[`NFO:${callInst.tradingsymbol}`]);
      if (putInst) atmPutPremium = getEffectiveLtp(quotes[`NFO:${putInst.tradingsymbol}`]);
    }

    const ls = callInst?.lot_size ?? lotSize;
    const suggestedLotsCall =
      atmCallPremium > 0 ? lotsForRisk(availableBalance, atmCallPremium, ls) : undefined;
    const suggestedLotsPut =
      atmPutPremium > 0 ? lotsForRisk(availableBalance, atmPutPremium, ls) : undefined;

    const tradePlan: OptionTradePlan = {
      availableBalance,
      lotSize: ls,
      expiry,
      atmStrike,
      spotPrice: spotPrice > 0 ? spotPrice : undefined,
      atmCallSymbol: callInst?.tradingsymbol,
      atmPutSymbol: putInst?.tradingsymbol,
      atmCallPremium: atmCallPremium || undefined,
      atmPutPremium: atmPutPremium || undefined,
      suggestedLotsCall,
      suggestedLotsPut,
      costPerLotCall:
        atmCallPremium > 0 ? Math.round(atmCallPremium * ls) : undefined,
      costPerLotPut: atmPutPremium > 0 ? Math.round(atmPutPremium * ls) : undefined,
      riskPerTradePct: RISK_PER_TRADE_PCT,
      targetProfitInr: PREDICTION_TARGET_PROFIT_INR,
      stopLossPct: STOP_LOSS_PCT,
    };

    return { bars: enrichedBars, tradePlan };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load Zerodha option prices";
    console.error("[prediction-option-pnl]", message, err);
    return {
      bars: bars.map((b) => ({ ...b, option: null })),
      tradePlan: null,
      error: message,
    };
  }
}

function targetMinuteSettled(targetKey: string): boolean {
  const nowKey = istMinuteKey(new Date().toISOString());
  return Boolean(targetKey && nowKey > targetKey);
}

function buildProfitTargetScan(
  priceMap: Map<string, number>,
  entryKey: string,
  sessionEndKey: string,
  entryPremium: number,
  lotSize: number,
  livePremium?: number,
): Pick<
  LiveAtmSideScenario,
  | "targetExitPremium"
  | "profitAtMinute"
  | "profitAtExitPremium"
  | "profitAtNetPnl"
  | "profitAtHoldMinutes"
  | "profitScanReason"
> {
  if (entryPremium <= 0 || lotSize <= 0) {
    return {
      targetExitPremium: null,
      profitAtMinute: null,
      profitAtExitPremium: null,
      profitAtNetPnl: null,
      profitAtHoldMinutes: null,
      profitScanReason: null,
    };
  }

  const targetExitPremium = targetExitPremiumForProfit(entryPremium, lotSize);
  const simulated = simulateHoldUntilExit(
    priceMap,
    entryKey,
    sessionEndKey,
    entryPremium,
    lotSize,
    livePremium,
  );

  if (!simulated) {
    return {
      targetExitPremium,
      profitAtMinute: null,
      profitAtExitPremium: null,
      profitAtNetPnl: null,
      profitAtHoldMinutes: null,
      profitScanReason: null,
    };
  }

  return {
    targetExitPremium,
    profitAtMinute:
      simulated.exitReason === "target" ? minuteKeyToTimeLabel(simulated.exitKey) : null,
    profitAtExitPremium: simulated.exitReason === "target" ? simulated.exitPremium : null,
    profitAtNetPnl: simulated.exitReason === "target" ? Math.round(simulated.pnlRupees) : null,
    profitAtHoldMinutes:
      simulated.exitReason === "target" ? minutesBetween(entryKey, simulated.exitKey) : null,
    profitScanReason: simulated.exitReason,
  };
}

function buildLiveSideScenario(
  direction: "up" | "down",
  side: "CE" | "PE",
  probability: number,
  threshold: number,
  symbol: string,
  strike: number,
  entryPremium: number,
  lotSize: number,
  exitPremiumAtClose: number | null,
  targetCandleLabel: string,
  candleClosed: boolean,
  exitPremiumLive: number | null = null,
  entrySource: "target_open" | "prior_close" | "live" = "live",
  profitScan?: Pick<
    LiveAtmSideScenario,
    | "targetExitPremium"
    | "profitAtMinute"
    | "profitAtExitPremium"
    | "profitAtNetPnl"
    | "profitAtHoldMinutes"
    | "profitScanReason"
  >,
): LiveAtmSideScenario {
  const costPerLot = Math.round(entryPremium * lotSize);
  const grossPnl1Lot =
    entryPremium > 0 && exitPremiumAtClose != null
      ? Math.round((exitPremiumAtClose - entryPremium) * lotSize)
      : null;
  const netPnl1Lot = grossPnl1Lot != null ? grossPnl1Lot - ZERODHA_ROUND_TRIP_CHARGE_INR : null;
  const canShowLivePnl =
    !candleClosed &&
    entryPremium > 0 &&
    exitPremiumLive != null &&
    (entrySource !== "live" || entryPremium !== exitPremiumLive);
  const grossPnlLive1Lot = canShowLivePnl
    ? Math.round((exitPremiumLive - entryPremium) * lotSize)
    : null;
  const netPnlLive1Lot =
    grossPnlLive1Lot != null ? grossPnlLive1Lot - ZERODHA_ROUND_TRIP_CHARGE_INR : null;

  return {
    direction,
    side,
    probability,
    signalAtThreshold: probability >= threshold,
    symbol,
    strike,
    entryPremium,
    entrySource,
    costPerLot,
    exitPremiumAtClose,
    exitLabel: candleClosed ? `${targetCandleLabel} close` : null,
    candleClosed,
    exitPremiumLive: !candleClosed ? exitPremiumLive : null,
    grossPnlLive1Lot,
    netPnlLive1Lot,
    grossPnl1Lot,
    netPnl1Lot,
    targetExitPremium: profitScan?.targetExitPremium ?? null,
    profitAtMinute: profitScan?.profitAtMinute ?? null,
    profitAtExitPremium: profitScan?.profitAtExitPremium ?? null,
    profitAtNetPnl: profitScan?.profitAtNetPnl ?? null,
    profitAtHoldMinutes: profitScan?.profitAtHoldMinutes ?? null,
    profitScanReason: profitScan?.profitScanReason ?? null,
  };
}

/** Live ATM call/put entry cost + 1-candle hold P/L if signal ≥ threshold. */
export async function fetchLiveAtmScenarios(
  accessToken: string,
  apiKey: string,
  asOf: string,
  intervalMinutes = 1,
  probUp = 0,
  probDown = 0,
  threshold = 0.75,
): Promise<LiveAtmScenarios> {
  const emptySide = (
    direction: "up" | "down",
    side: "CE" | "PE",
    probability: number,
  ): LiveAtmSideScenario => ({
    direction,
    side,
    probability,
    signalAtThreshold: probability >= threshold,
    symbol: "",
    strike: 0,
    entryPremium: 0,
    costPerLot: 0,
    exitPremiumAtClose: null,
    exitLabel: null,
    candleClosed: false,
    grossPnl1Lot: null,
    netPnl1Lot: null,
    targetExitPremium: null,
    profitAtMinute: null,
    profitAtExitPremium: null,
    profitAtNetPnl: null,
    profitAtHoldMinutes: null,
    profitScanReason: null,
  });

  try {
    const asOfKey = istMinuteKey(asOf);
    if (!asOfKey) throw new Error("Invalid asOf timestamp");
    const targetKey = addIntervalMinutes(asOfKey, Math.max(1, intervalMinutes));
    const targetCandleLabel = minuteKeyToTimeLabel(targetKey);
    const targetDate = targetKey.split(" ")[0] ?? getTodayIstDate();
    const candleClosed = targetMinuteSettled(targetKey);

    const allInstruments = await getKiteInstruments("NFO", accessToken, apiKey);
    const niftyOptions = filterNiftyOptions(allInstruments);
    if (!niftyOptions.length) throw new Error("No NIFTY options found");

    const expiries = [...new Set(niftyOptions.map((i) => i.expiry).filter(Boolean))] as string[];
    const expiry = expiryForDate(expiries, targetDate);
    const expiryOptions = niftyOptions.filter((i) => i.expiry === expiry);
    const strikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))].sort(
      (a, b) => a - b,
    );
    const lotSize = expiryOptions[0]?.lot_size ?? 75;

    const spotQuotes = await kiteGet<Record<string, KiteQuotePayload>>(
      `/quote?i=${encodeURIComponent(NIFTY_SPOT_KEY)}`,
      accessToken,
      apiKey,
    );
    const spotPrice = getEffectiveLtp(spotQuotes[NIFTY_SPOT_KEY]);
    const atmStrike = findAtmStrike(strikes, spotPrice > 0 ? spotPrice : 0);
    const callInst = resolveOptionInstrument(expiryOptions, expiry, atmStrike, "CE");
    const putInst = resolveOptionInstrument(expiryOptions, expiry, atmStrike, "PE");
    if (!callInst || !putInst) throw new Error("ATM CE/PE not found");

    const quoteKeys = [`NFO:${callInst.tradingsymbol}`, `NFO:${putInst.tradingsymbol}`];
    const quotes = await kiteGet<Record<string, KiteQuotePayload>>(
      `/quote?${quoteKeys.map((k) => `i=${encodeURIComponent(k)}`).join("&")}`,
      accessToken,
      apiKey,
    );
    const callPremium = getEffectiveLtp(quotes[`NFO:${callInst.tradingsymbol}`]);
    const putPremium = getEffectiveLtp(quotes[`NFO:${putInst.tradingsymbol}`]);

    const from = `${targetDate} 09:15:00`;
    const to = nowIstDateTime();
    const [callMaps, putMaps] = await Promise.all(
      [callInst, putInst].map(async (inst) => {
        const data = await kiteGet<{ candles: unknown[] }>(
          `/instruments/historical/${inst.instrument_token}/${OPTION_SCAN_INTERVAL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          accessToken,
          apiKey,
        );
        return buildCandlePriceMaps(data.candles ?? []);
      }),
    );
    const callMap = callMaps.closeMap;
    const putMap = putMaps.closeMap;
    const callLivePremium = callPremium;
    const putLivePremium = putPremium;
    const callEntry = resolveHoldEntryPremium(
      targetKey,
      asOfKey,
      callMaps.openMap,
      callMap,
      callLivePremium,
    );
    const putEntry = resolveHoldEntryPremium(
      targetKey,
      asOfKey,
      putMaps.openMap,
      putMap,
      putLivePremium,
    );

    const callExit = candleClosed ? lookupPremium(callMap, targetKey) : null;
    const putExit = candleClosed ? lookupPremium(putMap, targetKey) : null;
    /** Enter on the predicted bar; scan 1m closes after the feature bar (same as backtest). */
    const entryKey = asOfKey;
    const sessionEndKey = `${targetDate} 15:29`;
    const scanCall =
      probUp >= threshold
        ? buildProfitTargetScan(
            callMap,
            entryKey,
            sessionEndKey,
            callEntry.entry,
            lotSize,
            callLivePremium,
          )
        : undefined;
    const scanPut =
      probDown >= threshold
        ? buildProfitTargetScan(
            putMap,
            entryKey,
            sessionEndKey,
            putEntry.entry,
            lotSize,
            putLivePremium,
          )
        : undefined;

    return {
      spotPrice,
      atmStrike,
      expiry,
      lotSize,
      targetCandleLabel,
      callPremium: callEntry.entry,
      putPremium: putEntry.entry,
      callSymbol: callInst.tradingsymbol,
      putSymbol: putInst.tradingsymbol,
      callCostPerLot: callEntry.entry > 0 ? Math.round(callEntry.entry * lotSize) : 0,
      putCostPerLot: putEntry.entry > 0 ? Math.round(putEntry.entry * lotSize) : 0,
      up: buildLiveSideScenario(
        "up",
        "CE",
        probUp,
        threshold,
        callInst.tradingsymbol,
        atmStrike,
        callEntry.entry,
        lotSize,
        callExit,
        targetCandleLabel,
        candleClosed,
        callLivePremium,
        callEntry.source,
        scanCall,
      ),
      down: buildLiveSideScenario(
        "down",
        "PE",
        probDown,
        threshold,
        putInst.tradingsymbol,
        atmStrike,
        putEntry.entry,
        lotSize,
        putExit,
        targetCandleLabel,
        candleClosed,
        putLivePremium,
        putEntry.source,
        scanPut,
      ),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load ATM scenarios";
    return {
      spotPrice: 0,
      atmStrike: 0,
      expiry: "",
      lotSize: 75,
      targetCandleLabel: "",
      callPremium: 0,
      putPremium: 0,
      callSymbol: "",
      putSymbol: "",
      callCostPerLot: 0,
      putCostPerLot: 0,
      up: emptySide("up", "CE", probUp),
      down: emptySide("down", "PE", probDown),
      error: message,
    };
  }
}
