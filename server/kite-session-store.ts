import fs from "fs";
import path from "path";

export interface StoredKiteSession {
  accessToken: string;
  savedAt: string;
  userId?: string;
  userName?: string;
}

const SESSION_FILE = path.join(process.cwd(), "data/kite-session.json");

export function saveKiteSession(session: StoredKiteSession): void {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export function loadKiteSession(): StoredKiteSession | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) as StoredKiteSession;
    if (!parsed.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearKiteSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    /* ignore */
  }
}

export function kiteSessionAgeHours(session: StoredKiteSession): number {
  const saved = new Date(session.savedAt).getTime();
  if (!Number.isFinite(saved)) return Number.POSITIVE_INFINITY;
  return (Date.now() - saved) / 3_600_000;
}
