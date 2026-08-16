import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { getFirebaseAuth, getMissingFirebaseEnvKeys } from "@/lib/firebase";
import { authNotAllowedMessage, isAllowedAuthEmail } from "@/lib/auth-allowed";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function enforceAllowedUser(user: User | null): Promise<User | null> {
  if (!user) return null;
  if (isAllowedAuthEmail(user.email)) return user;
  await firebaseSignOut(getFirebaseAuth());
  return null;
}

function assertFirebaseReady() {
  const missing = getMissingFirebaseEnvKeys();
  if (missing.length > 0) {
    throw new Error(
      "Firebase is not configured. On the server: add VITE_FIREBASE_* to .env, then run npm run build and pm2 restart.",
    );
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const missingFirebase = getMissingFirebaseEnvKeys();

  useEffect(() => {
    if (missingFirebase.length > 0) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(getFirebaseAuth(), (nextUser) => {
      void enforceAllowedUser(nextUser).then((allowed) => {
        setUser(allowed);
        setLoading(false);
      });
    });
  }, []);

  const signIn = async (email: string, password: string) => {
    assertFirebaseReady();
    const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
    const allowed = await enforceAllowedUser(cred.user);
    if (!allowed) {
      throw new Error(authNotAllowedMessage());
    }
  };

  const signUp = async (email: string, password: string) => {
    assertFirebaseReady();
    const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
    const allowed = await enforceAllowedUser(cred.user);
    if (!allowed) {
      throw new Error(authNotAllowedMessage());
    }
  };

  const signOut = async () => {
    assertFirebaseReady();
    await firebaseSignOut(getFirebaseAuth());
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
