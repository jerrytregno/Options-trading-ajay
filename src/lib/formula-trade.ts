import { placeKiteOrder } from "@/lib/auto-trade";
import { findAtmStrike } from "@/lib/greeks";
import { getIndianMarketContext } from "@/lib/market-time";
import { parseTradeLeg, type TradeLeg } from "@/lib/trade-calculations";
import type { OptionChainResponse } from "@/types/kite";

export type FormulaOptionId = 1 | 2;

/** Strategy variant: Formula 1 uses VWAP filter; Formula 2 is RSI-only. */
export type FormulaVariantId = 1 | 2;

export type FormulaPhase =
  | "idle"
  | "waiting"
  | "entering"
  | "in_position"
  | "exiting"
  | "cooldown"
  | "stopped";

/** All formula thresholds in one place. Signals use 1-minute candles; orders poll every second. */
export const FORMULA_RULES = {
  decisionTimeframe: "1m" as const,
  rsiPeriod: 14,
  rsiConfirmCandles: 1,
  putRsiAbove: 70,
  takeProfitMinPct: 8,
  takeProfitMaxPct: 12,
  stopLossPct: 15,
  /** From 3:15 PM, exit when premium profit reaches at least this %. */
  hardExitMinProfitPct: 0.5,
  hardExitWindowStartHour: 15,
  hardExitWindowStartMinute: 15,
  /** Mandatory square-off at 3:29 PM IST. */
  hardExitForceHour: 15,
  hardExitForceMinute: 29,
  riskPerTradePct: 1,
  maxConsecutiveLosses: 2,
  cooldownCandles: 5,
} as const;

export interface FormulaVariantRule {
  id: FormulaVariantId;
  name: string;
  shortLabel: string;
  usesVwap: boolean;
}

export const FORMULA_VARIANTS: Record<FormulaVariantId, FormulaVariantRule> = {
  1: {
    id: 1,
    name: "Formula 1",
    shortLabel: "RSI + VWAP",
    usesVwap: true,
  },
  2: {
    id: 2,
    name: "Formula 2",
    shortLabel: "RSI only",
    usesVwap: false,
  },
};

/** Per-variant Call RSI thresholds (Put RSI shared via FORMULA_RULES.putRsiAbove). */
export const FORMULA_VARIANT_RSI: Record<FormulaVariantId, { callRsiBelow: number }> = {
  1: { callRsiBelow: 30 },
  2: { callRsiBelow: 25 },
};

export interface FormulaOptionRule {
  id: FormulaOptionId;
  leg: TradeLeg;
  name: string;
  entryLabel: string;
  exitLabel: string;
}

export const FORMULA_OPTIONS: Record<FormulaOptionId, FormulaOptionRule> = {
  1: {
    id: 1,
    leg: "CE_BUY",
    name: "ATM Call",
    entryLabel: "RSI < 30 (1m · 1 bar) · ATM CE",
    exitLabel: "TP 8–12% · SL −15% · 3:15–3:29 exit ≥0.5% · force 3:29",
  },
  2: {
    id: 2,
    leg: "PE_BUY",
    name: "ATM Put",
    entryLabel: "RSI > 70 (1m · 1 bar) · ATM PE",
    exitLabel: "TP 8–12% · SL −15% · 3:15–3:29 exit ≥0.5% · force 3:29",
  },
};

export interface FormulaEntryContext {
  recentRsi: number[];
  spot: number;
  vwap: number | null;
}

export function formulaUsesVwap(variant: FormulaVariantId) {
  return FORMULA_VARIANTS[variant].usesVwap;
}

export function formulaCallRsiBelow(variant: FormulaVariantId) {
  return FORMULA_VARIANT_RSI[variant].callRsiBelow;
}

export function formulaCallEntryLabel(variant: FormulaVariantId) {
  const usesVwap = formulaUsesVwap(variant);
  const rsi = `RSI < ${formulaCallRsiBelow(variant)} (1m · 1 bar) · ATM CE`;
  return usesVwap ? `${rsi} · spot > VWAP` : rsi;
}

export function formulaPutEntryLabel(variant: FormulaVariantId) {
  const usesVwap = formulaUsesVwap(variant);
  const rsi = `RSI > ${FORMULA_RULES.putRsiAbove} (1m · 1 bar) · ATM PE`;
  return usesVwap ? `${rsi} · spot < VWAP` : rsi;
}

export function premiumProfitPct(entryPremium: number, currentPremium: number) {
  if (entryPremium <= 0 || currentPremium <= 0) return 0;
  return ((currentPremium - entryPremium) / entryPremium) * 100;
}

export function rsiHeldForCandles(recentRsi: number[], count: number, compare: "below" | "above", level: number) {
  if (recentRsi.length < count) return false;
  const slice = recentRsi.slice(-count);
  return compare === "below"
    ? slice.every((r) => r < level)
    : slice.every((r) => r > level);
}

export function callEntrySignal(
  { recentRsi, spot, vwap }: FormulaEntryContext,
  variant: FormulaVariantId = 1
) {
  if (spot <= 0) return false;
  const rsiOk = rsiHeldForCandles(
    recentRsi,
    FORMULA_RULES.rsiConfirmCandles,
    "below",
    formulaCallRsiBelow(variant)
  );
  if (!rsiOk) return false;
  if (!formulaUsesVwap(variant)) return true;
  if (vwap == null) return false;
  return spot > vwap;
}

export function putEntrySignal(
  { recentRsi, spot, vwap }: FormulaEntryContext,
  variant: FormulaVariantId = 1
) {
  if (spot <= 0) return false;
  const rsiOk = rsiHeldForCandles(
    recentRsi,
    FORMULA_RULES.rsiConfirmCandles,
    "above",
    FORMULA_RULES.putRsiAbove
  );
  if (!rsiOk) return false;
  if (!formulaUsesVwap(variant)) return true;
  if (vwap == null) return false;
  return spot < vwap;
}

export function checkFormulaEntry(option: FormulaOptionId, ctx: FormulaEntryContext, variant: FormulaVariantId = 1) {
  return option === 1 ? callEntrySignal(ctx, variant) : putEntrySignal(ctx, variant);
}

/** One position at a time — enter whichever option signals next (Call wins if both). */
export function pickFormulaEntryOption(ctx: FormulaEntryContext, variant: FormulaVariantId = 1): FormulaOptionId | null {
  if (callEntrySignal(ctx, variant)) return 1;
  if (putEntrySignal(ctx, variant)) return 2;
  return null;
}

export function getFormulaIstMinutes(date = new Date()) {
  const ctx = getIndianMarketContext(date);
  const ist = ctx.timeIST.split(":").map(Number);
  return ist[0] * 60 + ist[1];
}

/** No new formula entries from 3:15 PM IST. */
export function isPastFormulaHardExit(date = new Date()) {
  const ctx = getIndianMarketContext(date);
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const minutes = getFormulaIstMinutes(date);
  return minutes >= FORMULA_RULES.hardExitWindowStartHour * 60 + FORMULA_RULES.hardExitWindowStartMinute;
}

export function isInFormulaHardExitWindow(date = new Date()) {
  const minutes = getFormulaIstMinutes(date);
  const start = FORMULA_RULES.hardExitWindowStartHour * 60 + FORMULA_RULES.hardExitWindowStartMinute;
  const force = FORMULA_RULES.hardExitForceHour * 60 + FORMULA_RULES.hardExitForceMinute;
  return minutes >= start && minutes < force;
}

export function isPastFormulaForceExit(date = new Date()) {
  const ctx = getIndianMarketContext(date);
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const minutes = getFormulaIstMinutes(date);
  return minutes >= FORMULA_RULES.hardExitForceHour * 60 + FORMULA_RULES.hardExitForceMinute;
}

export function checkFormulaExit(profitPct: number, _entryTimeMs: number, now = Date.now()) {
  const at = new Date(now);

  if (isPastFormulaForceExit(at)) {
    return { exit: true, reason: "Hard exit 3:29 PM IST" };
  }
  if (profitPct <= -FORMULA_RULES.stopLossPct) {
    return { exit: true, reason: `Stop loss ${profitPct.toFixed(1)}%` };
  }
  if (isInFormulaHardExitWindow(at)) {
    if (profitPct >= FORMULA_RULES.hardExitMinProfitPct) {
      return { exit: true, reason: `End-of-day exit ${profitPct.toFixed(1)}% (≥0.5%)` };
    }
    return { exit: false, reason: "" };
  }
  if (profitPct >= FORMULA_RULES.takeProfitMinPct) {
    return { exit: true, reason: `Take profit ${profitPct.toFixed(1)}%` };
  }
  return { exit: false, reason: "" };
}

/** Size lots so max loss at stop ≈ 1% of capital. */
export function formulaLotsForRisk(capital: number, entryPremium: number, lotSize: number) {
  if (capital <= 0 || entryPremium <= 0 || lotSize <= 0) return 1;
  const riskBudget = capital * (FORMULA_RULES.riskPerTradePct / 100);
  const lossPerLotAtStop =
    entryPremium * (FORMULA_RULES.stopLossPct / 100) * lotSize;
  if (lossPerLotAtStop <= 0) return 1;
  return Math.max(1, Math.floor(riskBudget / lossPerLotAtStop));
}

export async function fetchFormulaOptionChain(underlyingId: string): Promise<OptionChainResponse | null> {
  try {
    const res = await fetch(
      `/api/kite/option-chain?underlying=${encodeURIComponent(underlyingId)}`,
      { credentials: "include" }
    );
    const json = await res.json();
    if (!res.ok) return null;
    return json.data as OptionChainResponse;
  } catch {
    return null;
  }
}

/** Always pick the at-the-money strike for the given leg (CE or PE). */
export function resolveFormulaInstrument(
  chain: OptionChainResponse | null,
  leg: TradeLeg,
  spotPrice?: number
) {
  if (!chain || chain.chain.length === 0) return null;

  const strikes = chain.chain.map((row) => row.strike);
  const atmStrike =
    spotPrice != null && spotPrice > 0
      ? findAtmStrike(strikes, spotPrice)
      : chain.atmStrike;

  const row =
    chain.chain.find((r) => r.strike === atmStrike) ??
    chain.chain.find((r) => r.isAtm) ??
    chain.chain.find((r) => r.strike === chain.atmStrike);

  if (!row) return null;

  const { optionType } = parseTradeLeg(leg);
  const legInstrument = optionType === "CE" ? row.ce : row.pe;
  if (!legInstrument?.tradingsymbol) return null;

  return {
    strike: row.strike,
    tradingsymbol: legInstrument.tradingsymbol,
    lotSize: legInstrument.lot_size ?? 75,
    isAtm: row.strike === atmStrike || row.isAtm === true,
  };
}

export async function placeFormulaEntry(
  tradingsymbol: string,
  leg: TradeLeg,
  quantity: number,
  exchange: "NFO" | "BFO" = "NFO"
) {
  const { transactionType } = parseTradeLeg(leg);
  return placeKiteOrder({
    tradingsymbol,
    exchange,
    transaction_type: transactionType,
    product: "MIS",
    quantity,
    order_type: "MARKET",
  });
}

export async function placeFormulaExit(
  tradingsymbol: string,
  leg: TradeLeg,
  quantity: number,
  exchange: "NFO" | "BFO" = "NFO"
) {
  const { transactionType } = parseTradeLeg(leg);
  const exitType = transactionType === "BUY" ? "SELL" : "BUY";
  return placeKiteOrder({
    tradingsymbol,
    exchange,
    transaction_type: exitType,
    product: "MIS",
    quantity,
    order_type: "MARKET",
  });
}
