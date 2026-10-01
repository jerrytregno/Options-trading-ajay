import { getIndianMarketContext } from "../src/lib/market-time.js";
import type { DayScalperCandle } from "../src/types/day-scalper.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import {
  formatIstMins,
  istMinsFromDate,
  momentumLiveRsiFromBarCloses,
  MOMENTUM_SCALPER_RSI_PERIOD,
} from "./momentum-scalper-logic.js";

export const NIFTY_SPOT_INSTRUMENT_KEY = "NSE:NIFTY 50";

/** Calendar days of 1-min history to seed RSI(14) — covers prior sessions before today's open. */
export const NIFTY_RSI_KITE_LOOKBACK_DAYS = 5;

const SESSION_OPEN_MINS = 9 * 60 + 15;
const SESSION_CLOSE_MINS = 15 * 60 + 30;

export function kiteRsiHistoryFromDate(dateIst: string, lookbackDays = NIFTY_RSI_KITE_LOOKBACK_DAYS): string {
  const anchor = new Date(`${dateIst}T12:00:00+05:30`);
  anchor.setDate(anchor.getDate() - lookbackDays);
  const y = anchor.getFullYear();
  const m = String(anchor.getMonth() + 1).padStart(2, "0");
  const d = String(anchor.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseKiteMinuteCandles(raw: unknown): DayScalperCandle[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: DayScalperCandle[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close] = row;
    if (typeof time !== "string") continue;
    if (![open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) continue;

    const parsed = new Date(time);
    if (!Number.isFinite(parsed.getTime())) continue;

    const mins = istMinsFromDate(parsed);
    if (mins < SESSION_OPEN_MINS || mins > SESSION_CLOSE_MINS) continue;

    out.push({
      time,
      timeIst: formatIstMins(mins),
      mins,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
    });
  }

  out.sort((a, b) => a.mins - b.mins);
  return out;
}

/** Live websocket bars override Zerodha history for the same minute — used in unit tests only. */
export function mergeNiftyMinuteBarsForRsi(
  prefill: DayScalperCandle[],
  live: DayScalperCandle[],
  current: DayScalperCandle | null,
): DayScalperCandle[] {
  const byMins = new Map<number, DayScalperCandle>();
  for (const bar of prefill) byMins.set(bar.mins, bar);
  for (const bar of live) byMins.set(bar.mins, bar);
  if (current && current.close > 0) byMins.set(current.mins, current);
  return [...byMins.values()].sort((a, b) => a.mins - b.mins);
}

/** Stamp the forming minute with the live Nifty spot so RSI tracks the current print between Kite polls. */
export function patchFormingMinuteClose(
  closes: number[],
  bars: DayScalperCandle[],
  liveSpot: number,
  nowMins: number,
): number[] {
  if (!(liveSpot > 0) || closes.length === 0 || bars.length === 0) return closes;
  const lastBar = bars.at(-1);
  if (!lastBar || lastBar.mins !== nowMins) return closes;
  const next = closes.slice();
  next[next.length - 1] = liveSpot;
  return next;
}

/**
 * Wilder RSI(14) from Zerodha 1-min Nifty candles — the same OHLC series Kite charts use.
 * Kite Connect has no indicator endpoint; this reads history and applies the chart formula.
 */
export async function fetchNiftyRsi14FromKite(
  accessToken: string,
  options?: { liveSpot?: number | null; dateIst?: string; toTimeIst?: string },
): Promise<{ rsi: number | null; barCount: number }> {
  const ctx = getIndianMarketContext();
  const dateIst = options?.dateIst ?? ctx.dateIST;
  const toTimeIst = options?.toTimeIst ?? ctx.timeIST;
  const from = `${kiteRsiHistoryFromDate(dateIst)} 09:15:00`;
  const to = `${dateIst} ${toTimeIst}`;

  const { candles } = await fetchHistoricalCandles(
    accessToken,
    NIFTY_SPOT_INSTRUMENT_KEY,
    "minute",
    from,
    to,
  );

  const bars = parseKiteMinuteCandles(candles);
  let closes = bars.map((bar) => bar.close).filter((close) => close > 0);
  if (options?.liveSpot != null && options.liveSpot > 0) {
    closes = patchFormingMinuteClose(closes, bars, options.liveSpot, istMinsFromDate(new Date()));
  }

  const rsi = momentumLiveRsiFromBarCloses(closes, MOMENTUM_SCALPER_RSI_PERIOD);
  return { rsi, barCount: closes.length };
}
