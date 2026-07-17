import "./load-env.js";

const DEFAULT_ENTERPRISE_EMAILS = ["jerry@blazly.ai"];

function parseEmailList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
}

export function getEnterpriseEmails(): string[] {
  const fromEnv = parseEmailList(process.env.ENTERPRISE_EMAILS);
  const merged = new Set([...DEFAULT_ENTERPRISE_EMAILS.map((e) => e.toLowerCase()), ...fromEnv]);
  return [...merged];
}

export function isEnterpriseEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getEnterpriseEmails().includes(email.trim().toLowerCase());
}

export function assertEnterpriseEmail(email: string | null | undefined): void {
  if (!isEnterpriseEmail(email)) {
    throw new Error("Enterprise access required. Contact support to upgrade your account.");
  }
}
