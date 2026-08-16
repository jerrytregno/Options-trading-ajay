import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  type Unsubscribe,
} from "firebase/firestore";
import type { BotTradeLog } from "@/types/trade-log";
import { getDb } from "@/lib/firestore";

function tradeLogsCollection(userId: string) {
  return collection(getDb(), "users", userId, "tradeLogs");
}

export async function syncServerTradesToFirestore(userId: string): Promise<number> {
  const res = await fetch("/api/trades", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load trades from server");

  const json = (await res.json()) as { data?: BotTradeLog[] };
  const trades = json.data ?? [];
  let synced = 0;

  for (const trade of trades) {
    if (trade.source !== "nine-sixteen") continue;
    const ref = doc(tradeLogsCollection(userId), trade.id);
    const existing = await getDoc(ref);
    if (existing.exists()) continue;

    await setDoc(ref, {
      ...trade,
      userId,
      syncedAt: serverTimestamp(),
    });
    synced += 1;
  }

  return synced;
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
      const trades = snapshot.docs
        .map((docSnap) => docSnap.data() as BotTradeLog)
        .filter((row) => row.source === "nine-sixteen");
      onChange(trades);
    },
    (error) => onError?.(error),
  );
}
