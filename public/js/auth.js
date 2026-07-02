import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, GoogleAuthProvider, signInWithPopup,
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

const app = initializeApp(window.APP_CONFIG.firebase);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

let currentUser = null;
const listeners = new Set();

export function getUser() { return currentUser; }

export function onAuthChange(fn) {
  listeners.add(fn);
  fn(currentUser);
  return () => listeners.delete(fn);
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  listeners.forEach((fn) => fn(user));
});

export async function signIn(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signUp(email, password) {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function signInGoogle() {
  await signInWithPopup(auth, googleProvider);
}

export async function logOut() {
  await signOut(auth);
}
