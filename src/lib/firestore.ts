import { getFirestore, type Firestore } from "firebase/firestore";
import app, { getMissingFirebaseEnvKeys } from "@/lib/firebase";

let db: Firestore | undefined;
if (getMissingFirebaseEnvKeys().length === 0 && app) {
  db = getFirestore(app);
}

export function getDb(): Firestore {
  if (!db) throw new Error("Firestore is not configured.");
  return db;
}

export { db };
