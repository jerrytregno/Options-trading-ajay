import { estimateOptionPremium, findAtmStrike } from "../src/lib/greeks.js";
import { getKiteInstruments, type KiteInstrumentRow } from "./kite-instruments.js";
import { kiteHttpFetch } from "./kite-http.js";
import { ZERODHA_ROUND_TRIP_CHARGE_INR } from "./prediction-option-pnl.js";

const KITE_BASE = "https://api.kite.trade";
const CHAIN_SYMBOL = "NIFTY";
const ENTRY_TIME = "09:15";
const SESSION_END_TIME = "15:29";
const OPTION_INTERVAL = "minute";
const DEFAULT_IV = 0.16;

/** Exit when net profit reaches this fixed INR amount (after brokerage). Default only — UI/API can override. */
export const ML_OPTION_TARGET_PROFIT_INR = 500;

/** Always trade exactly one NFO lot (lot size from instrument master, e.g. 75). */
export const ML_OPTION_LOTS = 1;

const MIN_TARGET_PROFIT_INR = 1;
const MAX_TARGET_PROFIT_INR = 1_000_000;

export function parseMlTargetProfitInr(raw: unknown, fallback = ML_OPTION_TARGET_PROFIT_INR): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TARGET_PROFIT_INR, Math.max(MIN_TARGET_PROFIT_INR, Math.round(n)));
}

export interface MlTradingHourSlotLike {
  hour_label: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MlTradingOptionTrade {
  date: string;
  entryTime: typeof ENTRY_TIME;
  exitTime: string;
  exitReason: "target" | "eod";
  targetProfitInr: number;
  targetProfitRupees: number;
  targetHit: boolean;
  side: "CE" | "PE";
  action: "Buy Call" | "Buy Put";
  atmStrike: number;
  expiry: string;
  lotSize: number;
  lots: number;
  symbol: string | null;
  entrySpot: number;
  exitSpot: number;
  spotMovePct: number;
  entryPremium: number;
  exitPremium: number;
  quantity: number;
  costRupees: number;
  grossPnlRupees: number;
  brokerageRupees: number;
  netPnlRupees: number;
  dataSource: "kite" | "model";
  isProjection: boolean;
  note?: string;
}

interface OptionContext {
  expiryOptions: KiteInstrumentRow[];
  strikes: number[];
  lotSize: number;
  expiry: string;
}

interface TargetExitResult {
  hit: boolean;
  exitTime: string;
  exitPremium: number;
  exitSpot: number;
  exitReason: "target" | "eod";
  grossPnlRupees: number;
  netPnlRupees: number;
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

function candleMinuteKey(raw: string | number | Date): string {
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
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
  const match = s.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (match) return `${match[1]} ${match[2]}:${match[3]}`;
  return s.slice(0, 16);
}

function buildMinuteCloseMap(candles: unknown[]): Map<string, number> {
  const closeMap = new Map<string, number>();
  for (const candle of candles) {
    if (!Array.isArray(candle) || candle[0] == null) continue;
    const key = candleMinuteKey(String(candle[0]));
    const close = Number(candle[4]);
    const open = Number(candle[1]);
    if (Number.isFinite(close)) closeMap.set(key, close);
    if (Number.isFinite(open)) closeMap.set(`${key}:open`, open);
  }
  return closeMap;
}

function lookupPremium(map: Map<string, number>, key: string): number | null {
  if (!key) return null;
  const direct = map.get(key);
  if (direct != null) return direct;
  const open = map.get(`${key}:open`);
  if (open != null) return open;
  const [datePart, timePart] = key.split(" ");
  const [hh, mm] = timePart.split(":").map(Number);
  const prev = `${datePart} ${String(hh).padStart(2, "0")}:${String(Math.max(0, mm - 1)).padStart(2, "0")}`;
  const next = `${datePart} ${String(hh).padStart(2, "0")}:${String(mm + 1).padStart(2, "0")}`;
  return map.get(prev) ?? map.get(next) ?? null;
}

function sortedMinuteKeys(priceMap: Map<string, number>, afterKey: string, untilKey: string): string[] {
  return [...priceMap.keys()]
    .filter((key) => !key.endsWith(":open") && key > afterKey && key <= untilKey)
    .sort();
}

function exitTimeLabel(exitKey: string): string {
  return exitKey.split(" ")[1] ?? exitKey;
}

function targetNetProfitRupees(targetInr = ML_OPTION_TARGET_PROFIT_INR): number {
  return targetInr;
}

function spotAtTime(
  slots: MlTradingHourSlotLike[],
  timeLabel: string,
  field: "open" | "close",
): number | null {
  const slot = slots.find((s) => s.hour_label === timeLabel);
  if (slot) return slot[field];
  if (timeLabel === ENTRY_TIME && slots.length > 0) return slots[0].open;
  if (slots.length > 0) return slots[slots.length - 1].close;
  return null;
}

function sideFromPrediction(predictedOutcome: string, predictedDayReturnPct = 0): "CE" | "PE" {
  if (predictedOutcome === "bearish") return "PE";
  if (predictedOutcome === "bullish") return "CE";
  return predictedDayReturnPct >= 0 ? "CE" : "PE";
}

function actionLabel(side: "CE" | "PE"): "Buy Call" | "Buy Put" {
  return side === "CE" ? "Buy Call" : "Buy Put";
}

function scanTargetProfitExit(
  closeMap: Map<string, number>,
  entryKey: string,
  sessionEndKey: string,
  entryPremium: number,
  quantity: number,
  spotByTime: Map<string, number>,
  targetInr = ML_OPTION_TARGET_PROFIT_INR,
): TargetExitResult {
  const targetNet = targetNetProfitRupees(targetInr);
  const forwardKeys = sortedMinuteKeys(closeMap, entryKey, sessionEndKey);

  for (const minuteKey of forwardKeys) {
    const premium = lookupPremium(closeMap, minuteKey);
    if (premium == null) continue;
    const gross = (premium - entryPremium) * quantity;
    const net = gross - ZERODHA_ROUND_TRIP_CHARGE_INR;
    if (net >= targetNet) {
      return {
        hit: true,
        exitTime: exitTimeLabel(minuteKey),
        exitPremium: premium,
        exitSpot: spotByTime.get(minuteKey) ?? spotByTime.get(exitTimeLabel(minuteKey)) ?? 0,
        exitReason: "target",
        grossPnlRupees: Number(gross.toFixed(2)),
        netPnlRupees: Number(net.toFixed(2)),
      };
    }
  }

  const lastKey = forwardKeys[forwardKeys.length - 1] ?? sessionEndKey;
  const lastPremium = lookupPremium(closeMap, lastKey) ?? entryPremium;
  const gross = (lastPremium - entryPremium) * quantity;
  const net = gross - ZERODHA_ROUND_TRIP_CHARGE_INR;
  return {
    hit: false,
    exitTime: exitTimeLabel(lastKey),
    exitPremium: lastPremium,
    exitSpot: spotByTime.get(lastKey) ?? spotByTime.get(exitTimeLabel(lastKey)) ?? 0,
    exitReason: "eod",
    grossPnlRupees: Number(gross.toFixed(2)),
    netPnlRupees: Number(net.toFixed(2)),
  };
}

function scanTargetProfitExitHourly(
  date: string,
  slots: MlTradingHourSlotLike[],
  ctx: OptionContext,
  side: "CE" | "PE",
  strike: number,
  entryPremium: number,
  quantity: number,
  targetInr = ML_OPTION_TARGET_PROFIT_INR,
): TargetExitResult {
  const targetNet = targetNetProfitRupees(targetInr);
  const entryIdx = slots.findIndex((s) => s.hour_label === ENTRY_TIME);
  const startIdx = entryIdx >= 0 ? entryIdx : 0;

  for (let i = startIdx; i < slots.length; i++) {
    const slot = slots[i];
    const premium = estimateOptionPremium(
      slot.close,
      strike,
      date,
      slot.hour_label,
      ctx.expiry,
      side,
      DEFAULT_IV,
    );
    const gross = (premium - entryPremium) * quantity;
    const net = gross - ZERODHA_ROUND_TRIP_CHARGE_INR;
    if (net >= targetNet) {
      return {
        hit: true,
        exitTime: slot.hour_label,
        exitPremium: premium,
        exitSpot: slot.close,
        exitReason: "target",
        grossPnlRupees: Number(gross.toFixed(2)),
        netPnlRupees: Number(net.toFixed(2)),
      };
    }
  }

  const last = slots[slots.length - 1];
  const lastPremium = estimateOptionPremium(
    last.close,
    strike,
    date,
    last.hour_label,
    ctx.expiry,
    side,
    DEFAULT_IV,
  );
  const gross = (lastPremium - entryPremium) * quantity;
  const net = gross - ZERODHA_ROUND_TRIP_CHARGE_INR;
  return {
    hit: false,
    exitTime: last.hour_label,
    exitPremium: lastPremium,
    exitSpot: last.close,
    exitReason: "eod",
    grossPnlRupees: Number(gross.toFixed(2)),
    netPnlRupees: Number(net.toFixed(2)),
  };
}

function buildSpotByHour(slots: MlTradingHourSlotLike[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const slot of slots) {
    map.set(slot.hour_label, slot.close);
  }
  return map;
}

function buildTrade(
  date: string,
  side: "CE" | "PE",
  ctx: OptionContext,
  entrySpot: number,
  exit: TargetExitResult,
  entryPremium: number,
  dataSource: "kite" | "model",
  isProjection: boolean,
  symbol: string | null,
  note?: string,
  targetInr = ML_OPTION_TARGET_PROFIT_INR,
): MlTradingOptionTrade {
  const lotSize = ctx.lotSize;
  const quantity = lotSize * ML_OPTION_LOTS;
  const costRupees = Number((entryPremium * quantity).toFixed(2));
  const spotMovePct =
    entrySpot > 0 && exit.exitSpot > 0
      ? Number(((exit.exitSpot - entrySpot) / entrySpot * 100).toFixed(3))
      : 0;

  return {
    date,
    entryTime: ENTRY_TIME,
    exitTime: exit.exitTime,
    exitReason: exit.exitReason,
    targetProfitInr: targetInr,
    targetProfitRupees: targetNetProfitRupees(targetInr),
    targetHit: exit.hit,
    side,
    action: actionLabel(side),
    atmStrike: findAtmStrike(ctx.strikes, entrySpot),
    expiry: ctx.expiry,
    lotSize,
    lots: ML_OPTION_LOTS,
    symbol,
    entrySpot: Number(entrySpot.toFixed(2)),
    exitSpot: Number(exit.exitSpot.toFixed(2)),
    spotMovePct,
    entryPremium: Number(entryPremium.toFixed(2)),
    exitPremium: Number(exit.exitPremium.toFixed(2)),
    quantity,
    costRupees,
    grossPnlRupees: exit.grossPnlRupees,
    brokerageRupees: ZERODHA_ROUND_TRIP_CHARGE_INR,
    netPnlRupees: exit.netPnlRupees,
    dataSource,
    isProjection,
    note,
  };
}

async function fetchKiteMinuteCloseMap(
  accessToken: string,
  apiKey: string,
  date: string,
  instrument: KiteInstrumentRow,
): Promise<Map<string, number>> {
  const from = `${date} 09:15:00`;
  const to = `${date} 15:29:00`;
  const data = await kiteGet<{ candles: unknown[] }>(
    `/instruments/historical/${instrument.instrument_token}/${OPTION_INTERVAL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken,
    apiKey,
  );
  return buildMinuteCloseMap(data.candles ?? []);
}

export async function computeDayOptionTrade(
  accessToken: string,
  apiKey: string,
  date: string,
  slots: MlTradingHourSlotLike[],
  predictedOutcome: string,
  niftyOptions: KiteInstrumentRow[],
  options: {
    isProjection?: boolean;
    predictedDayReturnPct?: number;
    targetProfitInr?: number;
  } = {},
): Promise<MlTradingOptionTrade | null> {
  const fullSlots = slots.filter((s) => s.open > 0 && s.close > 0);
  if (fullSlots.length < 1) return null;

  const entrySpot = spotAtTime(fullSlots, ENTRY_TIME, "open");
  if (entrySpot == null || entrySpot <= 0) return null;

  const expiries = [...new Set(niftyOptions.map((i) => i.expiry).filter(Boolean))] as string[];
  const expiry = expiryForDate(expiries, date);
  const expiryOptions = niftyOptions.filter((i) => i.expiry === expiry);
  const strikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))].sort(
    (a, b) => a - b,
  );
  const lotSize = expiryOptions[0]?.lot_size ?? 75;
  const ctx: OptionContext = { expiryOptions, strikes, lotSize, expiry };

  const side = sideFromPrediction(predictedOutcome, options.predictedDayReturnPct ?? 0);
  const strike = findAtmStrike(ctx.strikes, entrySpot);
  const instrument = resolveOptionInstrument(ctx.expiryOptions, ctx.expiry, strike, side);
  const quantity = lotSize * ML_OPTION_LOTS;

  let entryPremium: number | null = null;
  let dataSource: "kite" | "model" = "model";
  let note: string | undefined;
  let closeMap: Map<string, number> | null = null;

  if (instrument) {
    try {
      closeMap = await fetchKiteMinuteCloseMap(accessToken, apiKey, date, instrument);
      const entryKey = `${date} ${ENTRY_TIME}`;
      entryPremium = lookupPremium(closeMap, entryKey);
      if (entryPremium != null && entryPremium > 0) dataSource = "kite";
    } catch {
      note = "Kite historical option data unavailable — using model estimate";
    }
  }

  if (entryPremium == null || entryPremium <= 0) {
    entryPremium = estimateOptionPremium(entrySpot, strike, date, ENTRY_TIME, ctx.expiry, side, DEFAULT_IV);
    dataSource = "model";
  }

  const targetInr = options.targetProfitInr ?? ML_OPTION_TARGET_PROFIT_INR;
  const sessionEndKey = `${date} ${SESSION_END_TIME}`;
  const entryKey = `${date} ${ENTRY_TIME}`;
  const spotByHour = buildSpotByHour(fullSlots);

  let exit: TargetExitResult;
  if (closeMap && closeMap.size > 0 && dataSource === "kite") {
    const spotByTime = new Map<string, number>();
    for (const [hour, spot] of spotByHour) {
      spotByTime.set(`${date} ${hour}`, spot);
      spotByTime.set(hour, spot);
    }
    exit = scanTargetProfitExit(closeMap, entryKey, sessionEndKey, entryPremium, quantity, spotByTime, targetInr);
  } else {
    exit = scanTargetProfitExitHourly(
      date,
      fullSlots,
      ctx,
      side,
      strike,
      entryPremium,
      quantity,
      targetInr,
    );
    if (dataSource !== "kite") dataSource = "model";
  }

  return buildTrade(
    date,
    side,
    ctx,
    entrySpot,
    exit,
    entryPremium,
    dataSource,
    Boolean(options.isProjection),
    instrument?.tradingsymbol ?? null,
    note,
    targetInr,
  );
}

export async function enrichMlTradingWithOptionTrades(
  accessToken: string,
  apiKey: string,
  match: Record<string, unknown>,
  targetProfitInr = ML_OPTION_TARGET_PROFIT_INR,
): Promise<Record<string, unknown>> {
  try {
    const allInstruments = await getKiteInstruments("NFO", accessToken, apiKey);
    const niftyOptions = filterNiftyOptions(allInstruments);
    if (!niftyOptions.length) {
      return { ...match, optionTradesError: "No NIFTY options found in NFO instrument master" };
    }

    const currentDate = String(match.currentDate ?? "");
    const todayExpiry = expiryForDate(
      [...new Set(niftyOptions.map((i) => i.expiry).filter(Boolean))] as string[],
      currentDate,
    );
    const todayLotSize =
      niftyOptions.find((i) => i.expiry === todayExpiry)?.lot_size ?? 75;

    const todaySlots =
      ((match.currentPattern as { fullDaySlots?: MlTradingHourSlotLike[] })?.fullDaySlots ??
        []) as MlTradingHourSlotLike[];
    const todayIsProjection =
      todaySlots.length > 0 && !todaySlots.some((s) => s.hour_label === SESSION_END_TIME.slice(0, 5));

    const prediction = String(match.prediction ?? "neutral");
    const expectedDayReturnPct = Number(match.expectedDayReturnPct ?? 0);

    const todayOptionTrade = await computeDayOptionTrade(
      accessToken,
      apiKey,
      currentDate,
      todaySlots,
      prediction,
      niftyOptions,
      {
        isProjection: todayIsProjection,
        predictedDayReturnPct: expectedDayReturnPct,
        targetProfitInr,
      },
    );

    const weekMatches = (match.weekMatches as Record<string, unknown>[] | undefined) ?? [];
    const dayMatches = (match.matches as Record<string, unknown>[] | undefined) ?? [];
    const tradeOpts = { targetProfitInr };

    const weekEntries = await Promise.all(
      weekMatches.map(async (weekMatch) => {
        const analogDate = String(weekMatch.todayAnalogDate ?? "");
        const slots = (weekMatch.todayAnalogFullDaySlots as MlTradingHourSlotLike[]) ?? [];
        const trade = await computeDayOptionTrade(
          accessToken,
          apiKey,
          analogDate,
          slots,
          String(weekMatch.todayAnalogOutcome ?? ""),
          niftyOptions,
          tradeOpts,
        );
        return [analogDate, trade] as const;
      }),
    );
    const weekOptionTrades = Object.fromEntries(weekEntries);

    const dayEntries = await Promise.all(
      dayMatches.map(async (dayMatch) => {
        const date = String(dayMatch.date ?? "");
        const slots = (dayMatch.fullDaySlots as MlTradingHourSlotLike[]) ?? [];
        const trade = await computeDayOptionTrade(
          accessToken,
          apiKey,
          date,
          slots,
          String(dayMatch.outcome ?? ""),
          niftyOptions,
          tradeOpts,
        );
        return [date, trade] as const;
      }),
    );
    const dayOptionTrades = Object.fromEntries(dayEntries);

    const historicalTrades = [
      ...Object.values(weekOptionTrades),
      ...Object.values(dayOptionTrades),
    ].filter(Boolean) as MlTradingOptionTrade[];
    const avgHistoricalNetPnl =
      historicalTrades.length > 0
        ? Number(
            (
              historicalTrades.reduce((sum, trade) => sum + trade.netPnlRupees, 0) /
              historicalTrades.length
            ).toFixed(2),
          )
        : null;

    return {
      ...match,
      todayOptionTrade,
      weekOptionTrades,
      dayOptionTrades,
      avgHistoricalNetPnl,
      optionTradeMeta: {
        entryTime: ENTRY_TIME,
        exitRule: `₹${targetProfitInr} net profit`,
        sessionEnd: SESSION_END_TIME,
        lots: ML_OPTION_LOTS,
        lotSize: todayLotSize,
        expiry: todayExpiry,
        targetProfitInr,
        note: `ATM at 9:15 · ${ML_OPTION_LOTS} lot (×${todayLotSize} qty) · exit when net profit hits ₹${targetProfitInr} (else ${SESSION_END_TIME}) · ₹50 brokerage`,
      },
    };
  } catch (err) {
    return {
      ...match,
      optionTradesError: err instanceof Error ? err.message : "Failed to compute option trades",
    };
  }
}

interface BatchDayRow {
  date: string;
  directionCorrect?: boolean;
  predictedOutcome: string;
  actualOutcome: string;
  predictedDayReturnPct: number;
  actualDayReturnPct: number;
  dayReturnErrorPct: number;
  actualSlots?: MlTradingHourSlotLike[];
}

export async function enrichBatchBacktestWithOptionTargets(
  accessToken: string,
  apiKey: string,
  batch: Record<string, unknown>,
  targetProfitInr = ML_OPTION_TARGET_PROFIT_INR,
): Promise<Record<string, unknown>> {
  const rawDays = (batch.days as BatchDayRow[] | undefined) ?? [];
  if (!rawDays.length) return batch;

  const allInstruments = await getKiteInstruments("NFO", accessToken, apiKey);
  const niftyOptions = filterNiftyOptions(allInstruments);
  if (!niftyOptions.length) {
    return { ...batch, optionTradesError: "No NIFTY options found for profit-target backtest" };
  }

  const enrichedDays = await Promise.all(
    rawDays.map(async (day) => {
      const slots = day.actualSlots ?? [];
      const trade = await computeDayOptionTrade(
        accessToken,
        apiKey,
        day.date,
        slots,
        day.predictedOutcome,
        niftyOptions,
        { predictedDayReturnPct: day.predictedDayReturnPct, targetProfitInr },
      );

      const profitTargetHit = trade?.targetHit ?? false;

      return {
        ...day,
        profitTargetHit,
        success: profitTargetHit,
        optionSide: trade?.side ?? null,
        optionNetPnlRupees: trade?.netPnlRupees ?? null,
        optionExitTime: trade?.exitTime ?? null,
        optionExitReason: trade?.exitReason ?? null,
        targetProfitInr,
      };
    }),
  );

  const tested = enrichedDays.length;
  const daysCorrect = enrichedDays.filter((d) => d.success).length;
  const daysWrong = tested - daysCorrect;

  return {
    ...batch,
    targetProfitInr,
    successMetric: "profit_target",
    daysCorrect,
    daysWrong,
    directionAccuracyPct: batch.directionAccuracyPct,
    profitTargetAccuracyPct: tested ? round1(daysCorrect / tested * 100) : 0,
    days: enrichedDays,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
