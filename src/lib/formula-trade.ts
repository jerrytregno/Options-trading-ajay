import { placeKiteOrder } from "@/lib/auto-trade";
import { findAtmStrike } from "@/lib/greeks";
import { getIndianMarketContext } from "@/lib/market-time";
import { parseTradeLeg, type TradeLeg } from "@/lib/trade-calculations";
import type { OptionChainResponse } from "@/types/kite";

export type FormulaOptionId = 1 | 2;

/** Strategy variant: Formula 1 uses VWAP; Formula 2 is RSI-only; Formula 3 uses EMA trend; Formula 4 is manual CE/PE. */
export type FormulaVariantId = 1 | 2 | 3 | 4;

export type FormulaFilterType = "vwap" | "none" | "ema";

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
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  /** Formula 4: exit when net premium P&L reaches this (INR). */
  manualTargetProfitInr: 50,
} as const;

export const FORMULA_4_TARGET_PROFIT_INR = FORMULA_RULES.manualTargetProfitInr;

export interface FormulaVariantRule {
  id: FormulaVariantId;
  name: string;
  displayName: string;
  riskTag: string;
  shortLabel: string;
  filterType: FormulaFilterType;
  /** @deprecated use filterType === "vwap" */
  usesVwap: boolean;
}

export const FORMULA_VARIANTS: Record<FormulaVariantId, FormulaVariantRule> = {
  1: {
    id: 1,
    name: "Formula 1",
    displayName: "Formula 1 (Safest)",
    riskTag: "Safest",
    shortLabel: "RSI + VWAP",
    filterType: "vwap",
    usesVwap: true,
  },
  2: {
    id: 2,
    name: "Formula 2",
    displayName: "Formula 2 (Risk)",
    riskTag: "Risk",
    shortLabel: "RSI only",
    filterType: "none",
    usesVwap: false,
  },
  3: {
    id: 3,
    name: "Formula 3",
    displayName: "Formula 3 (Safest EMI)",
    riskTag: "Safest EMI",
    shortLabel: "RSI + EMA trend",
    filterType: "ema",
    usesVwap: false,
  },
  4: {
    id: 4,
    name: "Formula 4",
    displayName: "Formula 4 (Manual)",
    riskTag: "Manual",
    shortLabel: "Manual · +₹50",
    filterType: "none",
    usesVwap: false,
  },
};

export function formulaDisplayName(variant: FormulaVariantId) {
  return FORMULA_VARIANTS[variant].displayName;
}

/** Per-variant Call RSI thresholds (Put RSI shared via FORMULA_RULES.putRsiAbove). */
export const FORMULA_VARIANT_RSI: Record<FormulaVariantId, { callRsiBelow: number }> = {
  1: { callRsiBelow: 30 },
  2: { callRsiBelow: 25 },
  3: { callRsiBelow: 30 },
  4: { callRsiBelow: 30 },
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
  ema20: number | null;
  ema50: number | null;
}

export function formulaFilterType(variant: FormulaVariantId): FormulaFilterType {
  return FORMULA_VARIANTS[variant].filterType;
}

export function formulaUsesVwap(variant: FormulaVariantId) {
  return FORMULA_VARIANTS[variant].filterType === "vwap";
}

export function formulaUsesEma(variant: FormulaVariantId) {
  return FORMULA_VARIANTS[variant].filterType === "ema";
}

export function formulaIsManual(variant: FormulaVariantId) {
  return variant === 4;
}

export function formulaCallRsiBelow(variant: FormulaVariantId) {
  return FORMULA_VARIANT_RSI[variant].callRsiBelow;
}

export function formulaCallEntryLabel(variant: FormulaVariantId) {
  const rsi = `RSI < ${formulaCallRsiBelow(variant)} (1m · 1 bar) · ATM CE`;
  if (formulaUsesEma(variant)) {
    return `${rsi} · spot > EMA ${FORMULA_RULES.emaFastPeriod} · EMA ${FORMULA_RULES.emaFastPeriod} > EMA ${FORMULA_RULES.emaSlowPeriod}`;
  }
  if (formulaUsesVwap(variant)) return `${rsi} · spot > VWAP`;
  return rsi;
}

export function formulaPutEntryLabel(variant: FormulaVariantId) {
  const rsi = `RSI > ${FORMULA_RULES.putRsiAbove} (1m · 1 bar) · ATM PE`;
  if (formulaUsesEma(variant)) {
    return `${rsi} · spot < EMA ${FORMULA_RULES.emaFastPeriod} · EMA ${FORMULA_RULES.emaFastPeriod} < EMA ${FORMULA_RULES.emaSlowPeriod}`;
  }
  if (formulaUsesVwap(variant)) return `${rsi} · spot < VWAP`;
  return rsi;
}

export function emaFilterMet(left: number, right: number, op: "gt" | "lt"): boolean | null {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return null;
  return op === "gt" ? left > right : left < right;
}

export function formulaCallEmaFilters(ctx: Pick<FormulaEntryContext, "spot" | "ema20" | "ema50">) {
  const { spot, ema20, ema50 } = ctx;
  return {
    spotAboveEma20: ema20 != null ? emaFilterMet(spot, ema20, "gt") : null,
    ema20AboveEma50: ema20 != null && ema50 != null ? emaFilterMet(ema20, ema50, "gt") : null,
  };
}

export function formulaPutEmaFilters(ctx: Pick<FormulaEntryContext, "spot" | "ema20" | "ema50">) {
  const { spot, ema20, ema50 } = ctx;
  return {
    spotBelowEma20: ema20 != null ? emaFilterMet(spot, ema20, "lt") : null,
    ema20BelowEma50: ema20 != null && ema50 != null ? emaFilterMet(ema20, ema50, "lt") : null,
  };
}

export function formulaCallTrendOk(ctx: Pick<FormulaEntryContext, "spot" | "ema20" | "ema50">) {
  const { spotAboveEma20, ema20AboveEma50 } = formulaCallEmaFilters(ctx);
  return spotAboveEma20 === true && ema20AboveEma50 === true;
}

export function formulaPutTrendOk(ctx: Pick<FormulaEntryContext, "spot" | "ema20" | "ema50">) {
  const { spotBelowEma20, ema20BelowEma50 } = formulaPutEmaFilters(ctx);
  return spotBelowEma20 === true && ema20BelowEma50 === true;
}

export function formulaEmaTrendLabel(
  { spot, ema20, ema50 }: Pick<FormulaEntryContext, "spot" | "ema20" | "ema50">
): "bull" | "bear" | "mixed" | "—" {
  if (spot <= 0 || ema20 == null || ema50 == null) return "—";
  if (formulaCallTrendOk({ spot, ema20, ema50 })) return "bull";
  if (formulaPutTrendOk({ spot, ema20, ema50 })) return "bear";
  return "mixed";
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
  { recentRsi, spot, vwap, ema20, ema50 }: FormulaEntryContext,
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
  if (formulaUsesEma(variant)) return formulaCallTrendOk({ spot, ema20, ema50 });
  if (formulaUsesVwap(variant)) {
    if (vwap == null) return false;
    return spot > vwap;
  }
  return true;
}

export function putEntrySignal(
  { recentRsi, spot, vwap, ema20, ema50 }: FormulaEntryContext,
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
  if (formulaUsesEma(variant)) return formulaPutTrendOk({ spot, ema20, ema50 });
  if (formulaUsesVwap(variant)) {
    if (vwap == null) return false;
    return spot < vwap;
  }
  return true;
}

export function checkFormulaEntry(option: FormulaOptionId, ctx: FormulaEntryContext, variant: FormulaVariantId = 1) {
  return option === 1 ? callEntrySignal(ctx, variant) : putEntrySignal(ctx, variant);
}

/** One position at a time — enter whichever option signals next (Call wins if both). */
export function pickFormulaEntryOption(ctx: FormulaEntryContext, variant: FormulaVariantId = 1): FormulaOptionId | null {
  if (formulaIsManual(variant)) return null;
  if (callEntrySignal(ctx, variant)) return 1;
  if (putEntrySignal(ctx, variant)) return 2;
  return null;
}

export function checkFormula4Exit(pnlInr: number) {
  return pnlInr >= FORMULA_4_TARGET_PROFIT_INR;
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
