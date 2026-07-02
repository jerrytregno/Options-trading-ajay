import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { KiteProfile } from "@/types/kite";

interface KiteContextValue {
  connected: boolean;
  configured: boolean;
  loading: boolean;
  profile: KiteProfile | null;
  loginUrl: string | null;
  refreshStatus: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const KiteContext = createContext<KiteContextValue | null>(null);

export function KiteProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<KiteProfile | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/kite/status", { credentials: "include" });
      const data = await res.json();
      setConnected(Boolean(data.connected));
      setConfigured(Boolean(data.configured));
      setProfile(data.profile ?? null);
      setLoginUrl(data.loginUrl ?? null);
    } catch {
      setConnected(false);
      setConfigured(false);
      setProfile(null);
      setLoginUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await fetch("/api/kite/disconnect", { method: "POST", credentials: "include" });
    await refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  return (
    <KiteContext.Provider
      value={{ connected, configured, loading, profile, loginUrl, refreshStatus, disconnect }}
    >
      {children}
    </KiteContext.Provider>
  );
}

export function useKite() {
  const context = useContext(KiteContext);
  if (!context) throw new Error("useKite must be used within KiteProvider");
  return context;
}
