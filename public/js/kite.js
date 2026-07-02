import { api } from "./utils.js";

let state = { connected: false, configured: false, profile: null, loginUrl: null, loading: true };
const listeners = new Set();

export function getKite() { return state; }

export function onKiteChange(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function notify() { listeners.forEach((fn) => fn(state)); }

export async function refreshKite() {
  state.loading = true;
  notify();
  try {
    const data = await api("/api/kite/status");
    state = { ...state, ...data, loading: false };
  } catch {
    state = { connected: false, configured: false, profile: null, loginUrl: null, loading: false };
  }
  notify();
}

export async function disconnectKite() {
  await api("/api/kite/disconnect", { method: "POST" });
  await refreshKite();
}

refreshKite();
