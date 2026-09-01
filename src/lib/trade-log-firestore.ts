import {
  collection,
  deleteDoc,
  getDocs,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";
import type { BotTradeLog } from "@/types/trade-log";
import { auth } from "@/lib/firebase";
import { db } from "@/lib/firestore";

function tradeLogsCollection(userId: string) {
  return collection(db, "users", userId, "tradeLogs");
}

/** Firestore rejects `undefined`; optional fields on BotTradeLog have to be dropped, not passed. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[key] = stripUndefined(val);
    }
    return out as T;
  }
  return value;
}

/**
 * Whether the stored copy still matches the server's. Broker fills land minutes after a trade
 * closes and P&L is restated on reconcile, so a doc that already exists is not necessarily
 * current — comparing beats the old "skip if present" rule, which froze the first version forever.
 */
function isSameTrade(stored: unknown, incoming: BotTradeLog): boolean {
  if (!stored || typeof stored !== "object") return false;
  const prev = stored as Record<string, unknown>;
  const fields: (keyof BotTradeLog)[] = [
    "status",
    "quantity",
    "entryPrice",
    "exitPrice",
    "pnl",
    "exitReason",
    "message",
    "closedAt",
    "entryTimeIst",
    "exitTimeIst",
  ];
  for (const field of fields) {
    if ((prev[field] ?? null) !== (incoming[field] ?? null)) return false;
  }
  return JSON.stringify(prev.broker ?? null) === JSON.stringify(incoming.broker ?? null);
}

export interface SyncResult {
  synced: number;
  total: number;
}

/**
 * Push every strategy's trades — 9:16 and momentum scalper — into Firestore, first asking
 * the server to stamp Zerodha's executed fills onto them so the saved copy is the broker's record
 * and not just the bot's own accounting.
 */
export async function syncServerTradesToFirestore(userId: string): Promise<SyncResult> {
  let trades: BotTradeLog[] = [];

  // Reconcile first so broker fills are attached before the upload; fall back to the plain read if
  // Zerodha is unreachable, since stale fills should never block saving the trades themselves.
  try {
    const res = await fetch("/api/trades/reconcile", { method: "POST", credentials: "include" });
    if (!res.ok) throw new Error("reconcile failed");
    trades = ((await res.json()) as { data?: BotTradeLog[] }).data ?? [];
  } catch {
    const res = await fetch("/api/trades", { credentials: "include" });
    if (!res.ok) throw new Error("Failed to load trades from server");
    trades = ((await res.json()) as { data?: BotTradeLog[] }).data ?? [];
  }

  const existing = new Map<string, unknown>();
  const snapshot = await getDocs(tradeLogsCollection(userId));
  for (const docSnap of snapshot.docs) existing.set(docSnap.id, docSnap.data());

  let synced = 0;
  for (const trade of trades) {
    if (isSameTrade(existing.get(trade.id), trade)) continue;
    await setDoc(
      doc(tradeLogsCollection(userId), trade.id),
      stripUndefined({ ...trade, userId, syncedAt: serverTimestamp() }),
      { merge: true },
    );
    synced += 1;
  }

  return { synced, total: trades.length };
}

/**
 * Remove a trade log from both stores. Firestore is what the Trades page reads, and the server
 * JSON is what re-populates it on the next sync, so deleting one alone would bring it straight
 * back. The server copy goes first: if that fails there is nothing to undo, whereas dropping the
 * Firestore doc first would resurrect it on the next visit.
 */
export async function deleteTradeLog(userId: string, tradeId: string): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`/api/trades/${encodeURIComponent(tradeId)}`, {
    method: "DELETE",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // A 404 means the server already has no such log, which still leaves the Firestore copy to clear.
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to delete the trade log on the server");
  }

  await deleteDoc(doc(tradeLogsCollection(userId), tradeId));
}

export function subscribeTradeLogs(
  userId: string,
  onChange: (trades: BotTradeLog[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  const q = query(tradeLogsCollection(userId), orderBy("createdAt", "desc"));
  return onSnapshot(
    q,
    (snapshot) => {
      onChange(snapshot.docs.map((docSnap) => docSnap.data() as BotTradeLog));
    },
    (error) => onError?.(error),
  );
}
