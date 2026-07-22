import type { ParsedCandle } from "@/lib/candles";
import { getIndianMarketContext } from "@/lib/market-time";
import { NIFTY_SPOT_QUOTE_KEY, fetchNiftySpotPrice } from "@/lib/prediction-auto-trade";
import type { TradeLeg } from "@/lib/trade-calculations";
import type { NineFifteenDirection } from "@/types/nine-fifteen";

/** Nifty index points from 9:15 open — exit target (not option premium). */
export const NINE_SIXTEEN_INDEX_TARGET = 50;
export const NINE_SIXTEEN_ENTRY_BUFFER_SEC = 3;
export const NINE_SIXTEEN_ENTRY_WINDOW_END_MINUTE = 9 * 60 + 18;
export const NINE_SIXTEEN_SPOT_POLL_MS = 500;
export const NINE_SIXTEEN_AUTO_ENABLED_KEY = "nine_sixteen_auto_enabled";
export const NINE_SIXTEEN_RAN_PREFIX = "nine_sixteen_auto_ran_";

export type NineSixteenAutoPhase =
  | "idle"
  | "waiting_916"
  | "entering"
  | "in_position"
  | "exiting"
  | "done";

export interface NineSixteen915Bar {
  open: number;
  close: number;
  high: number;
  low: number;
  change: number;
  direction: NineFifteenDirection;
}

function istTimeParts(date: Date) {
  const ctx = getIndianMarketContext(date);
  const [hour, minute, second] = ctx.timeIST.split(":").map(Number);
  return { ...ctx, hour, minute, second };
}

export function istSecondsOfDay(date = new Date()): number {
  const { hour, minute, second } = istTimeParts(date);
  return hour * 3600 + minute * 60 + second;
}

export function nineSixteenEntryTargetSec(bufferSec = NINE_SIXTEEN_ENTRY_BUFFER_SEC): number {
  return 9 * 3600 + 16 * 60 + bufferSec;
}

export function nineSixteenEntryWindowEndSec(): number {
  return NINE_SIXTEEN_ENTRY_WINDOW_END_MINUTE * 60;
}

export function msUntil916Entry(nowMs = Date.now(), bufferSec = NINE_SIXTEEN_ENTRY_BUFFER_SEC): number {
  const now = new Date(nowMs);
  const ctx = getIndianMarketContext(now);
  if (ctx.sessionStatus === "closed_weekend") {
    return 60_000;
  }
  const nowSec = istSecondsOfDay(now);
  const targetSec = nineSixteenEntryTargetSec(bufferSec);
  if (nowSec >= targetSec) return 0;
  if (ctx.sessionStatus === "post_market") return 60_000;
  return Math.max(250, (targetSec - nowSec) * 1000);
}

export function isPast916EntryWindow(nowMs = Date.now()): boolean {
  return istSecondsOfDay(new Date(nowMs)) > nineSixteenEntryWindowEndSec();
}

export function isReadyFor916Entry(nowMs = Date.now()): boolean {
  const nowSec = istSecondsOfDay(new Date(nowMs));
  return nowSec >= nineSixteenEntryTargetSec() && nowSec <= nineSixteenEntryWindowEndSec();
}

export function directionFrom915Bar(open: number, close: number): NineFifteenDirection {
  if (close > open) return "up";
  if (close < open) return "down";
  return "flat";
}

export function legFrom915Direction(direction: NineFifteenDirection): TradeLeg | null {
  if (direction === "up") return "CE_BUY";
  if (direction === "down") return "PE_BUY";
  return null;
}

export function parse915Bar(candle: ParsedCandle | null | undefined): NineSixteen915Bar | null {
  if (!candle || candle.open <= 0) return null;
  const change = candle.close - candle.open;
  return {
    open: candle.open,
    close: candle.close,
    high: candle.high,
    low: candle.low,
    change,
    direction: directionFrom915Bar(candle.open, candle.close),
  };
}

export function pick915Candle(candles: ParsedCandle[]): ParsedCandle | null {
  if (candles.length === 0) return null;
  const first = candles[0];
  const istMinute = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(first.timestamp));
  if (istMinute === "09:15") return first;
  return candles.find((candle) => {
    const label = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(candle.timestamp));
    return label === "09:15";
  }) ?? first;
}

export async function fetchToday915Bar(): Promise<NineSixteen915Bar | null> {
  try {
    const res = await fetch("/api/kite/nifty-session", { credentials: "include" });
    const json = await res.json();
    if (!res.ok) return null;
    const candles = (json.data?.candles ?? []) as ParsedCandle[];
    return parse915Bar(pick915Candle(candles));
  } catch {
    return null;
  }
}

export function shouldExitNineSixteen(
  spot: number,
  open915: number,
  leg: TradeLeg,
  target = NINE_SIXTEEN_INDEX_TARGET,
): boolean {
  if (spot <= 0 || open915 <= 0) return false;
  if (leg === "CE_BUY") return spot >= open915 + target;
  if (leg === "PE_BUY") return spot <= open915 - target;
  return false;
}

export function nineSixteenExitLabel(
  open915: number,
  leg: TradeLeg,
  target = NINE_SIXTEEN_INDEX_TARGET,
): string {
  if (leg === "CE_BUY") {
    return `Nifty ≥ ${(open915 + target).toFixed(2)} (+${target} from 9:15 open)`;
  }
  return `Nifty ≤ ${(open915 - target).toFixed(2)} (−${target} from 9:15 open)`;
}

export function nineSixteenRanKey(dateIst: string): string {
  return `${NINE_SIXTEEN_RAN_PREFIX}${dateIst}`;
}

export function hasNineSixteenRanToday(dateIst: string): boolean {
  try {
    return sessionStorage.getItem(nineSixteenRanKey(dateIst)) === "1";
  } catch {
    return false;
  }
}

export function markNineSixteenRanToday(dateIst: string): void {
  try {
    sessionStorage.setItem(nineSixteenRanKey(dateIst), "1");
  } catch {
    /* ignore */
  }
}

export function isNineSixteenAutoEnabled(): boolean {
  try {
    return sessionStorage.getItem(NINE_SIXTEEN_AUTO_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNineSixteenAutoEnabled(enabled: boolean): void {
  try {
    if (enabled) sessionStorage.setItem(NINE_SIXTEEN_AUTO_ENABLED_KEY, "1");
    else sessionStorage.removeItem(NINE_SIXTEEN_AUTO_ENABLED_KEY);
  } catch {
    /* ignore */
  }
}

export function isPastNineSixteenForceExit(nowMs = Date.now()): boolean {
  const ctx = getIndianMarketContext(new Date(nowMs));
  if (!ctx.isMarketOpen && ctx.sessionStatus === "post_market") return true;
  const { hour, minute } = istTimeParts(new Date(nowMs));
  return hour * 60 + minute >= 15 * 60 + 25;
}

export { fetchNiftySpotPrice, NIFTY_SPOT_QUOTE_KEY };
