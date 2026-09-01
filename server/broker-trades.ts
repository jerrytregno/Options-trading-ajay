import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { getIndianMarketContext } from "../src/lib/market-time.js";
import { fetchTradeBook, type KiteTrade } from "./kite-client.js";
import { loadKiteSession } from "./kite-session-store.js";
import { appendBotTradeLog, loadBotTradeLogs } from "./bot-trade-log.js";
import type { BotTradeLog, BrokerFill, BrokerTradeSummary } from "../src/types/trade-log.js";

const SNAPSHOT_DIR = path.join(process.cwd(), "data", "broker-fills");

function snapshotFile(dateIst: string) {
  return path.join(SNAPSHOT_DIR, `${dateIst}.json`);
}

export interface BrokerFillsSnapshot {
  dateIST: string;
  fetchedAt: string;
  fills: BrokerFill[];
}

/**
 * Kite returns naive IST timestamps ("2026-08-25 09:16:03"), so the string is split rather than
 * pushed through Date, which would read it as UTC on this server and shift every fill by 5:30.
 */
function splitKiteTimestamp(raw: string | null | undefined): { date: string | null; time: string | null } {
  if (!raw) return { date: null, time: null };
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(raw.trim());
  if (!match) return { date: null, time: null };
  return { date: match[1], time: match[2] };
}

function normalizeFill(trade: KiteTrade): { fill: BrokerFill; dateIST: string | null } | null {
  if (!trade || !trade.tradingsymbol) return null;
  const qty = Number(trade.quantity);
  const price = Number(trade.average_price);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return null;

  const stamp = splitKiteTimestamp(
    trade.fill_timestamp ?? trade.exchange_timestamp ?? trade.order_timestamp,
  );

  return {
    dateIST: stamp.date,
    fill: {
      tradeId: String(trade.trade_id ?? ""),
      orderId: String(trade.order_id ?? ""),
      tradingsymbol: trade.tradingsymbol,
      transactionType: trade.transaction_type === "SELL" ? "SELL" : "BUY",
      quantity: qty,
      price,
      filledAtIst: stamp.time,
    },
  };
}

export async function loadBrokerFillsSnapshot(dateIst: string): Promise<BrokerFillsSnapshot | null> {
  try {
    const raw = await fsp.readFile(snapshotFile(dateIst), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BrokerFillsSnapshot>;
    if (!parsed || !Array.isArray(parsed.fills)) return null;
    return {
      dateIST: parsed.dateIST ?? dateIst,
      fetchedAt: parsed.fetchedAt ?? new Date().toISOString(),
      fills: parsed.fills,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeSnapshot(snapshot: BrokerFillsSnapshot) {
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fsp.writeFile(snapshotFile(snapshot.dateIST), JSON.stringify(snapshot, null, 2), "utf-8");
}

export function listSnapshotDates(): string[] {
  try {
    return fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/**
 * Pull today's tradebook and fold it into the day's snapshot. Kite only serves the current day, so
 * the snapshot on disk — not the API — is what makes older fills recoverable.
 */
export async function snapshotBrokerFills(accessToken: string): Promise<BrokerFillsSnapshot> {
  const todayIst = getIndianMarketContext().dateIST;
  const trades = await fetchTradeBook(accessToken);

  const byDate = new Map<string, Map<string, BrokerFill>>();
  for (const trade of trades) {
    const normalized = normalizeFill(trade);
    if (!normalized) continue;
    const dateIst = normalized.dateIST ?? todayIst;
    if (!byDate.has(dateIst)) byDate.set(dateIst, new Map());
    // trade_id is unique per fill, so re-fetching through the day cannot double-count.
    byDate.get(dateIst)!.set(normalized.fill.tradeId || `${normalized.fill.orderId}-${normalized.fill.price}`, normalized.fill);
  }

  if (!byDate.has(todayIst)) byDate.set(todayIst, new Map());

  let todaySnapshot: BrokerFillsSnapshot = { dateIST: todayIst, fetchedAt: new Date().toISOString(), fills: [] };

  for (const [dateIst, fills] of byDate) {
    const existing = await loadBrokerFillsSnapshot(dateIst);
    const merged = new Map<string, BrokerFill>();
    for (const fill of existing?.fills ?? []) merged.set(fill.tradeId || `${fill.orderId}-${fill.price}`, fill);
    for (const [key, fill] of fills) merged.set(key, fill);

    const snapshot: BrokerFillsSnapshot = {
      dateIST: dateIst,
      fetchedAt: new Date().toISOString(),
      fills: [...merged.values()].sort((a, b) => (a.filledAtIst ?? "").localeCompare(b.filledAtIst ?? "")),
    };
    await writeSnapshot(snapshot);
    if (dateIst === todayIst) todaySnapshot = snapshot;
  }

  return todaySnapshot;
}

export function summarise(symbol: string, fills: BrokerFill[], fetchedAt: string): BrokerTradeSummary {
  let buyQty = 0;
  let buyValue = 0;
  let sellQty = 0;
  let sellValue = 0;
  const orderIds = new Set<string>();

  for (const fill of fills) {
    if (fill.orderId) orderIds.add(fill.orderId);
    if (fill.transactionType === "BUY") {
      buyQty += fill.quantity;
      buyValue += fill.quantity * fill.price;
    } else {
      sellQty += fill.quantity;
      sellValue += fill.quantity * fill.price;
    }
  }

  const avgBuy = buyQty > 0 ? buyValue / buyQty : null;
  const avgSell = sellQty > 0 ? sellValue / sellQty : null;
  const matched = Math.min(buyQty, sellQty);
  const times = fills.map((f) => f.filledAtIst).filter((t): t is string => Boolean(t)).sort();

  return {
    tradingsymbol: symbol,
    buyQuantity: buyQty,
    sellQuantity: sellQty,
    avgBuyPrice: avgBuy != null ? Math.round(avgBuy * 100) / 100 : null,
    avgSellPrice: avgSell != null ? Math.round(avgSell * 100) / 100 : null,
    realisedPnl:
      avgBuy != null && avgSell != null && matched > 0 ? Math.round((avgSell - avgBuy) * matched * 100) / 100 : null,
    firstFillIst: times[0] ?? null,
    lastFillIst: times[times.length - 1] ?? null,
    orderIds: [...orderIds],
    fills,
    fetchedAt,
  };
}

function hmsToSecs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] ?? 0);
}

function byFillTime(a: BrokerFill, b: BrokerFill): number {
  return (a.filledAtIst ?? "99:99:99").localeCompare(b.filledAtIst ?? "99:99:99");
}

/**
 * Cut a symbol's fills into round trips: a run of fills from the first buy until the position is
 * flat again. Entries and exits are split into several orders, so counting fills would be
 * meaningless — the net quantity returning to zero is what marks the end of one trade.
 */
export function segmentRoundTrips(fills: BrokerFill[]): BrokerFill[][] {
  const trips: BrokerFill[][] = [];
  let current: BrokerFill[] = [];
  let net = 0;

  for (const fill of [...fills].sort(byFillTime)) {
    current.push(fill);
    net += fill.transactionType === "BUY" ? fill.quantity : -fill.quantity;
    if (net === 0) {
      trips.push(current);
      current = [];
    }
  }
  // A leg still open at the time of the snapshot.
  if (current.length > 0) trips.push(current);

  return trips;
}

/** Seconds into the IST day for an ISO instant. Trade logs are stamped in UTC. */
function istSecsFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return (pick("hour") % 24) * 3600 + pick("minute") * 60 + pick("second");
}

interface Trip {
  fills: BrokerFill[];
  buyQty: number;
  startSecs: number | null;
  endSecs: number | null;
}

function toTrip(fills: BrokerFill[]): Trip {
  const times = fills.map((f) => hmsToSecs(f.filledAtIst)).filter((t): t is number => t != null);
  return {
    fills,
    buyQty: fills.reduce((sum, f) => (f.transactionType === "BUY" ? sum + f.quantity : sum), 0),
    startSecs: times.length > 0 ? Math.min(...times) : null,
    endSecs: times.length > 0 ? Math.max(...times) : null,
  };
}

/** Beyond this, a time-only match is guesswork and the log is better left unreconciled. */
const MAX_TIME_MATCH_SECS = 15 * 60;

/**
 * Split a symbol's fills between the logs that traded it. Several logs can share a strike on one
 * day — the scalper re-entering, or two bots holding it — so trades are paired to round trips one
 * for one, preferring an exact quantity match and falling back to closest time. Matching by order
 * alone is not safe here: a 75-quantity scalper trade would happily absorb an 8,385-quantity 9:16
 * round trip. A log with no convincing candidate is left empty rather than given someone else's.
 */
export function assignFillsToLogs(logs: BotTradeLog[], fills: BrokerFill[]): Map<string, BrokerFill[]> {
  const assigned = new Map<string, BrokerFill[]>();
  for (const log of logs) assigned.set(log.id, []);
  if (logs.length === 0 || fills.length === 0) return assigned;

  const trips = segmentRoundTrips(fills).map(toTrip);
  if (trips.length === 0) return assigned;

  if (logs.length === 1) {
    assigned.set(logs[0].id, [...fills].sort(byFillTime));
    return assigned;
  }

  interface Pair {
    logId: string;
    tripIndex: number;
    score: number;
  }
  const pairs: Pair[] = [];

  for (const log of logs) {
    const entrySecs = hmsToSecs(log.entryTimeIst);
    // createdAt is written as the trade is booked, so it stands in for a missing exit stamp.
    const exitSecs = hmsToSecs(log.exitTimeIst) ?? istSecsFromIso(log.createdAt);

    trips.forEach((trip, tripIndex) => {
      const qtyExact = log.quantity != null && log.quantity > 0 && log.quantity === trip.buyQty;

      const deltas: number[] = [];
      if (exitSecs != null && trip.endSecs != null) deltas.push(Math.abs(exitSecs - trip.endSecs));
      if (entrySecs != null && trip.startSecs != null) deltas.push(Math.abs(entrySecs - trip.startSecs));
      const delta = deltas.length > 0 ? Math.min(...deltas) : null;

      if (!qtyExact && (delta == null || delta > MAX_TIME_MATCH_SECS)) return;
      pairs.push({
        logId: log.id,
        tripIndex,
        score: (qtyExact ? 0 : 1_000_000) + (delta ?? 500_000),
      });
    });
  }

  pairs.sort((a, b) => a.score - b.score);

  const usedLogs = new Set<string>();
  const usedTrips = new Set<number>();
  for (const pair of pairs) {
    if (usedLogs.has(pair.logId) || usedTrips.has(pair.tripIndex)) continue;
    usedLogs.add(pair.logId);
    usedTrips.add(pair.tripIndex);
    assigned.set(pair.logId, trips[pair.tripIndex].fills);
  }

  return assigned;
}

export interface ReconcileResult {
  dateIST: string;
  fillsSeen: number;
  logsUpdated: number;
  datesTouched: string[];
}

/**
 * Match stored broker fills onto every bot trade log, whichever strategy produced it, so the
 * Firebase copy carries what Zerodha actually executed and not only what the bot believed.
 */
export async function reconcileBrokerFills(accessToken?: string | null): Promise<ReconcileResult> {
  const todayIst = getIndianMarketContext().dateIST;
  let fillsSeen = 0;

  if (accessToken) {
    try {
      const snapshot = await snapshotBrokerFills(accessToken);
      fillsSeen = snapshot.fills.length;
    } catch (err) {
      console.error("[broker-trades] tradebook fetch failed", err);
    }
  }

  const store = await loadBotTradeLogs();
  const logsByDate = new Map<string, BotTradeLog[]>();
  for (const log of store.trades) {
    if (!log.tradingsymbol) continue;
    if (!logsByDate.has(log.dateIST)) logsByDate.set(log.dateIST, []);
    logsByDate.get(log.dateIST)!.push(log);
  }

  let logsUpdated = 0;
  const datesTouched: string[] = [];

  for (const [dateIst, logs] of logsByDate) {
    const snapshot = await loadBrokerFillsSnapshot(dateIst);
    if (!snapshot || snapshot.fills.length === 0) continue;

    const bySymbol = new Map<string, BrokerFill[]>();
    for (const fill of snapshot.fills) {
      if (!bySymbol.has(fill.tradingsymbol)) bySymbol.set(fill.tradingsymbol, []);
      bySymbol.get(fill.tradingsymbol)!.push(fill);
    }

    let touched = false;
    for (const [symbol, symbolFills] of bySymbol) {
      const symbolLogs = logs.filter((log) => log.tradingsymbol === symbol);
      if (symbolLogs.length === 0) continue;

      const assigned = assignFillsToLogs(symbolLogs, symbolFills);
      for (const log of symbolLogs) {
        const mine = assigned.get(log.id) ?? [];
        // Nothing matched this pass, so anything stored earlier was a mis-attribution and has to go
        // rather than linger as a broker-verified number that no fill supports.
        const summary = mine.length > 0 ? summarise(symbol, mine, snapshot.fetchedAt) : null;
        if (JSON.stringify(log.broker ?? null) === JSON.stringify(summary)) continue;

        await appendBotTradeLog({ ...log, broker: summary });
        logsUpdated += 1;
        touched = true;
      }
    }
    if (touched) datesTouched.push(dateIst);
  }

  return { dateIST: todayIst, fillsSeen, logsUpdated, datesTouched };
}

/** Reconcile using the stored Kite session, if there is a usable one. */
export async function reconcileBrokerFillsWithSession(): Promise<ReconcileResult> {
  const session = loadKiteSession();
  return reconcileBrokerFills(session?.accessToken ?? null);
}

let timer: NodeJS.Timeout | null = null;

/**
 * Kite drops the tradebook overnight, so waiting for someone to open the Trades page would lose a
 * day's fills. Poll through the session instead, and once more after the close.
 */
export function startBrokerReconcileLoop(intervalMs = 5 * 60_000) {
  if (timer) return;
  const tick = async () => {
    try {
      const ctx = getIndianMarketContext();
      const [hh, mm] = ctx.timeIST.split(":").map(Number);
      const mins = hh * 60 + mm;
      // 09:10 to 15:45 IST — covers the whole session plus the post-close settle.
      if (ctx.sessionStatus !== "closed_weekend" && mins >= 550 && mins <= 945) {
        const result = await reconcileBrokerFillsWithSession();
        if (result.logsUpdated > 0) {
          console.log(
            `[broker-trades] reconciled ${result.logsUpdated} trade log(s) from ${result.fillsSeen} Zerodha fill(s)`,
          );
        }
      }
    } catch (err) {
      console.error("[broker-trades] reconcile loop error", err);
    }
  };

  timer = setInterval(() => void tick(), intervalMs);
  setTimeout(() => void tick(), 20_000);
}
