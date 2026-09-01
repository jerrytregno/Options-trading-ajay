import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/contexts/auth-context";
import { auth } from "@/lib/firebase";
import type { KiteAutoLoginStatus, KiteProfile } from "@/types/kite";

/**
 * Proves to the server that this is the signed-in app user, so it may share the Kite session
 * that auto-login stored. Without it the server only trusts this browser's own Kite cookie.
 */
async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await auth.currentUser?.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

interface KiteContextValue {
  connected: boolean;
  configured: boolean;
  loading: boolean;
  profile: KiteProfile | null;
  loginUrl: string | null;
  autoLogin: KiteAutoLoginStatus | null;
  refreshStatus: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Force a headless login now. Resolves with an error message, or null on success. */
  autoLoginNow: () => Promise<string | null>;
}

const KiteContext = createContext<KiteContextValue | null>(null);

export function KiteProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<KiteProfile | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [autoLogin, setAutoLogin] = useState<KiteAutoLoginStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/kite/status", {
        credentials: "include",
        headers: await authHeaders(),
      });
      const data = await res.json();
      setConnected(Boolean(data.connected));
      setConfigured(Boolean(data.configured));
      setProfile(data.profile ?? null);
      setLoginUrl(data.loginUrl ?? null);
      setAutoLogin(data.autoLogin ?? null);
    } catch {
      setConnected(false);
      setConfigured(false);
      setProfile(null);
      setLoginUrl(null);
      setAutoLogin(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await fetch("/api/kite/disconnect", { method: "POST", credentials: "include" });
    await refreshStatus();
  }, [refreshStatus]);

  const autoLoginNow = useCallback(async () => {
    try {
      const res = await fetch("/api/kite/auto-login", {
        method: "POST",
        credentials: "include",
        headers: await authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      await refreshStatus();
      return res.ok ? null : (data.error ?? "Auto-login failed");
    } catch {
      await refreshStatus();
      return "Auto-login request failed";
    }
  }, [refreshStatus]);

  // Firebase restores the session asynchronously, so the first status call can happen before
  // there is an ID token to send. Re-check once sign-in settles to pick up the stored Kite session.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, user?.uid]);

  return (
    <KiteContext.Provider
      value={{
        connected,
        configured,
        loading,
        profile,
        loginUrl,
        autoLogin,
        refreshStatus,
        disconnect,
        autoLoginNow,
      }}
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
