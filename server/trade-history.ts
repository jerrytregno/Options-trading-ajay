import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildClosedTrades,
  normalizeKiteOrder,
  type ClosedTradeRow,
  type KiteOrderRow,
} from "../src/lib/portfolio-pnl.js";
import { parseZerodhaTradebookCsv } from "../src/lib/zerodha-tradebook-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "../data/kite-trade-history.json");

export interface TradeHistoryMeta {
  lastSyncedAt: string | null;
  importedAt: string | null;
  source: "kite_orders" | "tradebook_csv" | "mixed";
}

export interface TradeHistoryStore {
  trades: ClosedTradeRow[];
  meta: TradeHistoryMeta;
}

const EMPTY_STORE: TradeHistoryStore = {
  trades: [],
  meta: { lastSyncedAt: null, importedAt: null, source: "kite_orders" },
};

export function mergeClosedTrades(
  stored: ClosedTradeRow[],
  incoming: ClosedTradeRow[],
): ClosedTradeRow[] {
  const byId = new Map<string, ClosedTradeRow>();
  for (const trade of stored) byId.set(trade.id, trade);
  for (const trade of incoming) byId.set(trade.id, trade);
  return [...byId.values()].sort(
    (a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime(),
  );
}

async function ensureDataDir() {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
}

export async function loadTradeHistory(): Promise<TradeHistoryStore> {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TradeHistoryStore>;
    if (!parsed || !Array.isArray(parsed.trades)) return { ...EMPTY_STORE };
    return {
      trades: parsed.trades,
      meta: { ...EMPTY_STORE.meta, ...parsed.meta },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STORE };
    throw err;
  }
}

export async function saveTradeHistory(store: TradeHistoryStore): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(HISTORY_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function closedTradesFromOrders(rawOrders: unknown[]): ClosedTradeRow[] {
  const orders = rawOrders
    .map((row) => normalizeKiteOrder(row as Record<string, unknown>))
    .filter((row): row is KiteOrderRow => row != null);
  return buildClosedTrades(orders);
}

export async function syncTodayOrdersIntoHistory(rawOrders: unknown[]): Promise<TradeHistoryStore> {
  const store = await loadTradeHistory();
  const todayTrades = closedTradesFromOrders(rawOrders);
  const merged = mergeClosedTrades(store.trades, todayTrades);
  const next: TradeHistoryStore = {
    trades: merged,
    meta: {
      ...store.meta,
      lastSyncedAt: new Date().toISOString(),
      source: store.meta.importedAt ? "mixed" : "kite_orders",
    },
  };
  await saveTradeHistory(next);
  return next;
}

export async function importTradebookCsvIntoHistory(csv: string): Promise<TradeHistoryStore> {
  const store = await loadTradeHistory();
  const orders = parseZerodhaTradebookCsv(csv);
  const imported = buildClosedTrades(orders);
  const merged = mergeClosedTrades(store.trades, imported);
  const next: TradeHistoryStore = {
    trades: merged,
    meta: {
      ...store.meta,
      importedAt: new Date().toISOString(),
      source: store.meta.lastSyncedAt ? "mixed" : "tradebook_csv",
    },
  };
  await saveTradeHistory(next);
  return next;
}
