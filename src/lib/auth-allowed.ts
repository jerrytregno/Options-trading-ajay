/** When set, only these emails (existing Firebase accounts) may stay signed in. */
export function isAllowedAuthEmail(email: string | null | undefined): boolean {
  const raw = import.meta.env.VITE_AUTH_ALLOWED_EMAILS?.trim();
  if (!raw) return true;
  const allowed = raw
    .split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes((email ?? "").toLowerCase());
}

export function authNotAllowedMessage(): string {
  return "This account is not authorized to use this app.";
}
