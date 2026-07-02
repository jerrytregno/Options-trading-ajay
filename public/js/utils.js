export function fmt(n, d = 2) {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
}

export function fmtCurrency(n) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
}

export function changeClass(v) {
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted";
}

export async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}
