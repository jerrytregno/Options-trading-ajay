import type { ClosedTradeRow } from "./portfolio-pnl";

const STORAGE_KEY = "optionflow-closed-trades-v1";

export function loadStoredClosedTrades(): ClosedTradeRow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClosedTradeRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStoredClosedTrades(trades: ClosedTradeRow[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch {
    // quota or private mode
  }
}

export function mergeStoredClosedTrades(
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
