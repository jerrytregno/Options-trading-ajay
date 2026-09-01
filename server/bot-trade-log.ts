import fs from "fs/promises";
import path from "path";
import type { BotTradeLog } from "../src/types/trade-log.js";

const LOG_PATH = path.join(process.cwd(), "data", "bot-trade-logs.json");

interface BotTradeLogStore {
  trades: BotTradeLog[];
  updatedAt: string | null;
}

const EMPTY: BotTradeLogStore = { trades: [], updatedAt: null };

async function ensureDir() {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
}

export async function loadBotTradeLogs(): Promise<BotTradeLogStore> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BotTradeLogStore>;
    if (!parsed || !Array.isArray(parsed.trades)) return { ...EMPTY };
    const trades = parsed.trades
      .filter((row) => row.source === "nine-sixteen" || row.source === "momentum-scalper")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return {
      trades,
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

export async function appendBotTradeLog(trade: BotTradeLog): Promise<BotTradeLogStore> {
  const store = await loadBotTradeLogs();
  const existing = store.trades.findIndex((row) => row.id === trade.id);
  if (existing >= 0) {
    store.trades[existing] = trade;
  } else {
    store.trades.unshift(trade);
  }
  store.trades.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const next: BotTradeLogStore = {
    trades: store.trades,
    updatedAt: new Date().toISOString(),
  };
  await ensureDir();
  await fs.writeFile(LOG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/**
 * Drop one log by id. Used to clear a record that never corresponded to a real trade — e.g. the
 * phantom leg a bot books when it adopts another bot's position in the same contract.
 */
export async function deleteBotTradeLog(id: string): Promise<{ removed: boolean; store: BotTradeLogStore }> {
  const store = await loadBotTradeLogs();
  const remaining = store.trades.filter((row) => row.id !== id);
  if (remaining.length === store.trades.length) return { removed: false, store };

  const next: BotTradeLogStore = { trades: remaining, updatedAt: new Date().toISOString() };
  await ensureDir();
  await fs.writeFile(LOG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return { removed: true, store: next };
}

export function makeBotTradeLogId(dateIst: string, tradingsymbol: string | null): string {
  const suffix = tradingsymbol ?? "session";
  return `${dateIst}-${suffix}-${Date.now()}`;
}

/** Stable id for one skip / no-entry / session outcome per day (upsert). */
export function makeSessionOutcomeLogId(dateIst: string, status: string): string {
  return `${dateIst}-session-${status}`;
}

export function makeClosedBotTradeLogId(dateIst: string, tradingsymbol: string | null): string {
  const suffix = tradingsymbol ?? "session";
  return `${dateIst}-${suffix}-closed`;
}

/**
 * Id for bots that can take several trades a day. The 9:16 bot trades once, so it keeps the older
 * `makeClosedBotTradeLogId` scheme and its synced history stays addressable; the momentum scalper
 * would otherwise overwrite itself whenever two trades landed on the same ATM strike, and would
 * collide with a 9:16 trade holding that strike too.
 */
export function makeStrategyTradeLogId(
  dateIst: string,
  source: BotTradeLog["source"],
  tradingsymbol: string | null,
  entryTimeIst: string | null,
): string {
  const symbol = tradingsymbol ?? "session";
  const at = (entryTimeIst ?? "").replace(/[^0-9]/g, "") || String(Date.now());
  return `${dateIst}-${source}-${symbol}-${at}`;
}
