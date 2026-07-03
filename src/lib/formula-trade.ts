import { placeKiteOrder } from "@/lib/auto-trade";
import { getIndianMarketContext } from "@/lib/market-time";
import { buildProtectedMarketOrder } from "@/lib/kite-orders";
import { parseTradeLeg, type TradeLeg } from "@/lib/trade-calculations";
import type { OptionChainResponse } from "@/types/kite";

export const FORMULA_NEXT_KEY = "optionflow_formula_next";

export type FormulaOptionId = 1 | 2;

export type FormulaPhase =
  | "idle"
  | "waiting"
  | "entering"
  | "in_position"
  | "exiting"
  | "cooldown"
  | "stopped";

/** All formula thresholds in one place. */
export const FORMULA_RULES = {
  rsiPeriod: 14,
  rsiConfirmCandles: 2,
  callRsiBelow: 15,
  putRsiAbove: 75,
  takeProfitMinPct: 8,
  takeProfitMaxPct: 12,
  stopLossPct: 15,
  timeStopMinutes: 20,
  hardExitHour: 15,
  hardExitMinute: 15,
  riskPerTradePct: 1,
  maxConsecutiveLosses: 2,
  cooldownCandles: 5,
} as const;

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
    name: "Call · Option 1",
    entryLabel: "RSI < 15 (2 candles) & spot > VWAP",
    exitLabel: "TP 8–12% · SL −15% · 20m · 3:15 PM",
  },
  2: {
    id: 2,
    leg: "PE_BUY",
    name: "Put · Option 2",
    entryLabel: "RSI > 75 (2 candles) & spot < VWAP",
    exitLabel: "TP 8–12% · SL −15% · 20m · 3:15 PM",
  },
};

export interface FormulaEntryContext {
  recentRsi: number[];
  spot: number;
  vwap: number | null;
}

export function getStoredFormulaOption(): FormulaOptionId {
  try {
    return sessionStorage.getItem(FORMULA_NEXT_KEY) === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}

export function storeNextFormulaOption(option: FormulaOptionId) {
  try {
    sessionStorage.setItem(FORMULA_NEXT_KEY, String(option));
  } catch {
    /* ignore */
  }
}

export function flipFormulaOption(option: FormulaOptionId): FormulaOptionId {
  return option === 1 ? 2 : 1;
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

export function callEntrySignal({ recentRsi, spot, vwap }: FormulaEntryContext) {
  if (vwap == null || spot <= 0) return false;
  return (
    rsiHeldForCandles(recentRsi, FORMULA_RULES.rsiConfirmCandles, "below", FORMULA_RULES.callRsiBelow) &&
    spot > vwap
  );
}

export function putEntrySignal({ recentRsi, spot, vwap }: FormulaEntryContext) {
  if (vwap == null || spot <= 0) return false;
  return (
    rsiHeldForCandles(recentRsi, FORMULA_RULES.rsiConfirmCandles, "above", FORMULA_RULES.putRsiAbove) &&
    spot < vwap
  );
}

export function checkFormulaEntry(option: FormulaOptionId, ctx: FormulaEntryContext) {
  return option === 1 ? callEntrySignal(ctx) : putEntrySignal(ctx);
}

export function isPastFormulaHardExit(date = new Date()) {
  const ctx = getIndianMarketContext(date);
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const ist = ctx.timeIST.split(":").map(Number);
  const minutes = ist[0] * 60 + ist[1];
  return minutes >= FORMULA_RULES.hardExitHour * 60 + FORMULA_RULES.hardExitMinute;
}

export function checkFormulaExit(profitPct: number, entryTimeMs: number, now = Date.now()) {
  if (isPastFormulaHardExit(new Date(now))) {
    return { exit: true, reason: "Hard exit 3:15 PM IST" };
  }
  if (profitPct >= FORMULA_RULES.takeProfitMinPct) {
    return { exit: true, reason: `Take profit ${profitPct.toFixed(1)}%` };
  }
  if (profitPct <= -FORMULA_RULES.stopLossPct) {
    return { exit: true, reason: `Stop loss ${profitPct.toFixed(1)}%` };
  }
  const elapsedMin = (now - entryTimeMs) / 60000;
  if (elapsedMin >= FORMULA_RULES.timeStopMinutes) {
    return { exit: true, reason: `Time stop ${FORMULA_RULES.timeStopMinutes} min` };
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

export function resolveFormulaInstrument(chain: OptionChainResponse | null, leg: TradeLeg) {
  if (!chain) return null;
  const row = chain.chain.find((r) => r.isAtm) ?? chain.chain.find((r) => r.strike === chain.atmStrike);
  if (!row) return null;
  const { optionType } = parseTradeLeg(leg);
  const legInstrument = optionType === "CE" ? row.ce : row.pe;
  if (!legInstrument?.tradingsymbol) return null;
  return {
    strike: row.strike,
    tradingsymbol: legInstrument.tradingsymbol,
    lotSize: legInstrument.lot_size ?? 75,
  };
}

export async function placeFormulaEntry(tradingsymbol: string, leg: TradeLeg, quantity: number) {
  const { transactionType } = parseTradeLeg(leg);
  return placeKiteOrder(
    buildProtectedMarketOrder({
      tradingsymbol,
      exchange: "NFO",
      transaction_type: transactionType,
      product: "MIS",
      quantity,
    })
  );
}

export async function placeFormulaExit(tradingsymbol: string, leg: TradeLeg, quantity: number) {
  const { transactionType } = parseTradeLeg(leg);
  const exitType = transactionType === "BUY" ? "SELL" : "BUY";
  return placeKiteOrder(
    buildProtectedMarketOrder({
      tradingsymbol,
      exchange: "NFO",
      transaction_type: exitType,
      product: "MIS",
      quantity,
    })
  );
}
