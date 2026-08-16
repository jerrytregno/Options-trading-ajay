import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export function getMissingFirebaseEnvKeys(): string[] {
  return (
    Object.entries(firebaseConfig) as [string, string | undefined][]
  )
    .filter(([, value]) => !value?.trim())
    .map(([key]) => key);
}

let app: FirebaseApp | undefined;
let auth: Auth | undefined;

if (getMissingFirebaseEnvKeys().length === 0) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    throw new Error("Firebase auth is not configured.");
  }
  return auth;
}

export { auth };
export default app;
