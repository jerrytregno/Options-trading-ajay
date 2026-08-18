/** Accounts allowed to use the app. Sign-up is closed — these must already exist in Firebase. */
const DEFAULT_ALLOWED_EMAILS = ["jerry@swatle.ai", "ngeorge10@gmail.com"];

function allowedEmails(): string[] {
  const raw = import.meta.env.VITE_AUTH_ALLOWED_EMAILS?.trim();
  if (!raw) return DEFAULT_ALLOWED_EMAILS;
  const parsed = raw
    .split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_EMAILS;
}

/** Fail closed: an unknown or missing email is never allowed to stay signed in. */
export function isAllowedAuthEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  return allowedEmails().includes(normalized);
}

/** Same wording as a bad password so an unlisted account cannot be told apart from a typo. */
export function authFailedMessage(): string {
  return "Wrong email or password.";
}
