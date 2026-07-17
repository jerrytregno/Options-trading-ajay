import { estimateOptionPremium, findAtmStrike } from "../src/lib/greeks.js";
import { getKiteInstruments, type KiteInstrumentRow } from "./kite-instruments.js";
import { kiteHttpFetch } from "./kite-http.js";
import { ZERODHA_ROUND_TRIP_CHARGE_INR } from "./prediction-option-pnl.js";

const KITE_BASE = "https://api.kite.trade";
const CHAIN_SYMBOL = "NIFTY";
const ENTRY_TIME = "09:15";
const EXIT_TIME = "15:15";
const OPTION_INTERVAL = "minute";
const DEFAULT_IV = 0.16;

export interface MlTradingHourSlotLike {
  hour_label: string;
  open: number;
  close: number;
}

export interface MlTradingOptionTrade {
  date: string;
  entryTime: typeof ENTRY_TIME;
  exitTime: typeof EXIT_TIME;
  side: "CE" | "PE";
  action: "Buy Call" | "Buy Put";
  atmStrike: number;
  expiry: string;
  lotSize: number;
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

function lookupPremium(map: Map<string, number>, key: string): number | null {
  if (!key) return null;
  const direct = map.get(key);
  if (direct != null) return direct;
  const [datePart, timePart] = key.split(" ");
  const [hh, mm] = timePart.split(":").map(Number);
  const prev = `${datePart} ${String(hh).padStart(2, "0")}:${String(Math.max(0, mm - 1)).padStart(2, "0")}`;
  const next = `${datePart} ${String(hh).padStart(2, "0")}:${String(mm + 1).padStart(2, "0")}`;
  return map.get(prev) ?? map.get(next) ?? null;
}

function spotAtTime(slots: MlTradingHourSlotLike[], timeLabel: string, field: "open" | "close"): number | null {
  const slot = slots.find((s) => s.hour_label === timeLabel);
  if (slot) return slot[field];
  if (timeLabel === ENTRY_TIME && slots.length > 0) return slots[0].open;
  if (timeLabel === EXIT_TIME && slots.length > 0) return slots[slots.length - 1].close;
  return null;
}

function sideFromOutcome(outcome: string | undefined, entrySpot: number, exitSpot: number): "CE" | "PE" {
  if (outcome === "bearish") return "PE";
  if (outcome === "bullish") return "CE";
  return exitSpot >= entrySpot ? "CE" : "PE";
}

function actionLabel(side: "CE" | "PE"): "Buy Call" | "Buy Put" {
  return side === "CE" ? "Buy Call" : "Buy Put";
}

function buildTrade(
  date: string,
  side: "CE" | "PE",
  ctx: OptionContext,
  entrySpot: number,
  exitSpot: number,
  entryPremium: number,
  exitPremium: number,
  dataSource: "kite" | "model",
  isProjection: boolean,
  symbol: string | null,
  note?: string,
): MlTradingOptionTrade {
  const lotSize = ctx.lotSize;
  const quantity = lotSize;
  const grossPnlRupees = Number(((exitPremium - entryPremium) * quantity).toFixed(2));
  const netPnlRupees = Number((grossPnlRupees - ZERODHA_ROUND_TRIP_CHARGE_INR).toFixed(2));
  const spotMovePct = entrySpot > 0 ? Number(((exitSpot - entrySpot) / entrySpot * 100).toFixed(3)) : 0;

  return {
    date,
    entryTime: ENTRY_TIME,
    exitTime: EXIT_TIME,
    side,
    action: actionLabel(side),
    atmStrike: findAtmStrike(ctx.strikes, entrySpot),
    expiry: ctx.expiry,
    lotSize,
    symbol,
    entrySpot: Number(entrySpot.toFixed(2)),
    exitSpot: Number(exitSpot.toFixed(2)),
    spotMovePct,
    entryPremium: Number(entryPremium.toFixed(2)),
    exitPremium: Number(exitPremium.toFixed(2)),
    quantity,
    costRupees: Number((entryPremium * quantity).toFixed(2)),
    grossPnlRupees,
    brokerageRupees: ZERODHA_ROUND_TRIP_CHARGE_INR,
    netPnlRupees,
    dataSource,
    isProjection,
    note,
  };
}

async function fetchKitePremiums(
  accessToken: string,
  apiKey: string,
  date: string,
  instrument: KiteInstrumentRow,
): Promise<{ entryPremium: number | null; exitPremium: number | null }> {
  const from = `${date} 09:15:00`;
  const to = `${date} 15:29:00`;
  const data = await kiteGet<{ candles: unknown[] }>(
    `/instruments/historical/${instrument.instrument_token}/${OPTION_INTERVAL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    accessToken,
    apiKey,
  );
  const { openMap, closeMap } = buildCandlePriceMaps(data.candles ?? []);
  const entryKey = `${date} ${ENTRY_TIME}`;
  const exitKey = `${date} ${EXIT_TIME}`;
  return {
    entryPremium: lookupPremium(openMap, entryKey) ?? lookupPremium(closeMap, entryKey),
    exitPremium: lookupPremium(closeMap, exitKey) ?? lookupPremium(openMap, exitKey),
  };
}

async function computeDayOptionTrade(
  accessToken: string,
  apiKey: string,
  date: string,
  slots: MlTradingHourSlotLike[],
  outcome: string | undefined,
  niftyOptions: KiteInstrumentRow[],
  options: {
    exitSpotOverride?: number | null;
    isProjection?: boolean;
    sideOverride?: "CE" | "PE";
  } = {},
): Promise<MlTradingOptionTrade | null> {
  const entrySpot = spotAtTime(slots, ENTRY_TIME, "open");
  const exitSpot =
    options.exitSpotOverride ??
    spotAtTime(slots, EXIT_TIME, "close");
  if (entrySpot == null || exitSpot == null || entrySpot <= 0 || exitSpot <= 0) {
    return null;
  }

  const expiries = [...new Set(niftyOptions.map((i) => i.expiry).filter(Boolean))] as string[];
  const expiry = expiryForDate(expiries, date);
  const expiryOptions = niftyOptions.filter((i) => i.expiry === expiry);
  const strikes = [...new Set(expiryOptions.map((i) => i.strike!).filter(Boolean))].sort(
    (a, b) => a - b,
  );
  const lotSize = expiryOptions[0]?.lot_size ?? 75;
  const ctx: OptionContext = { expiryOptions, strikes, lotSize, expiry };

  const side = options.sideOverride ?? sideFromOutcome(outcome, entrySpot, exitSpot);
  const strike = findAtmStrike(ctx.strikes, entrySpot);
  const instrument = resolveOptionInstrument(ctx.expiryOptions, ctx.expiry, strike, side);

  let entryPremium: number | null = null;
  let exitPremium: number | null = null;
  let dataSource: "kite" | "model" = "model";
  let note: string | undefined;

  if (instrument) {
    try {
      const kitePremiums = await fetchKitePremiums(accessToken, apiKey, date, instrument);
      entryPremium = kitePremiums.entryPremium;
      exitPremium = kitePremiums.exitPremium;
      if (entryPremium != null && exitPremium != null && entryPremium > 0 && exitPremium > 0) {
        dataSource = "kite";
      }
    } catch {
      note = "Kite historical option data unavailable — using model estimate";
    }
  }

  if (entryPremium == null || entryPremium <= 0) {
    entryPremium = estimateOptionPremium(entrySpot, strike, date, ENTRY_TIME, ctx.expiry, side, DEFAULT_IV);
    dataSource = "model";
  }
  if (exitPremium == null || exitPremium <= 0) {
    exitPremium = estimateOptionPremium(exitSpot, strike, date, EXIT_TIME, ctx.expiry, side, DEFAULT_IV);
    if (dataSource !== "kite") dataSource = "model";
  }

  return buildTrade(
    date,
    side,
    ctx,
    entrySpot,
    exitSpot,
    entryPremium,
    exitPremium,
    dataSource,
    Boolean(options.isProjection),
    instrument?.tradingsymbol ?? null,
    note,
  );
}

function projectedExitSpot(
  match: Record<string, unknown>,
  slots: MlTradingHourSlotLike[],
  entrySpot: number,
): number | null {
  const hourPredictions = match.hourPredictions as
    | { hourLabel: string; predClose: number | null; status: string }[]
    | undefined;
  const exitFromPred = hourPredictions?.find((row) => row.hourLabel === EXIT_TIME)?.predClose;
  if (exitFromPred != null && exitFromPred > 0) return exitFromPred;

  const actualExit = spotAtTime(slots, EXIT_TIME, "close");
  if (actualExit != null && actualExit > 0) return actualExit;

  const expectedDayReturnPct = Number(match.expectedDayReturnPct ?? 0);
  if (entrySpot > 0 && expectedDayReturnPct !== 0) {
    return Number((entrySpot * (1 + expectedDayReturnPct / 100)).toFixed(2));
  }
  return null;
}

export async function enrichMlTradingWithOptionTrades(
  accessToken: string,
  apiKey: string,
  match: Record<string, unknown>,
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
    const todayEntry = spotAtTime(todaySlots, ENTRY_TIME, "open");
    const todayExitOverride = projectedExitSpot(match, todaySlots, todayEntry ?? 0);
    const todayIsProjection = todayExitOverride != null && spotAtTime(todaySlots, EXIT_TIME, "close") == null;

    const prediction = String(match.prediction ?? "neutral");
    const sideOverride: "CE" | "PE" =
      prediction === "bearish"
        ? "PE"
        : prediction === "bullish"
          ? "CE"
          : sideFromOutcome(prediction, todayEntry ?? 0, todayExitOverride ?? todayEntry ?? 0);

    const todayOptionTrade = await computeDayOptionTrade(
      accessToken,
      apiKey,
      currentDate,
      todaySlots,
      prediction,
      niftyOptions,
      {
        exitSpotOverride: todayExitOverride,
        isProjection: todayIsProjection,
        sideOverride,
      },
    );

    const weekMatches = (match.weekMatches as Record<string, unknown>[] | undefined) ?? [];
    const dayMatches = (match.matches as Record<string, unknown>[] | undefined) ?? [];

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
        exitTime: EXIT_TIME,
        lotSize: todayLotSize,
        expiry: todayExpiry,
        note: "ATM strike at 9:15 · enter option at 9:15 · exit at 3:15 · 1 lot · ₹50 round-trip brokerage",
      },
    };
  } catch (err) {
    return {
      ...match,
      optionTradesError: err instanceof Error ? err.message : "Failed to compute option trades",
    };
  }
}
