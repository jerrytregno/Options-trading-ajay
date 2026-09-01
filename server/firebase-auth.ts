import crypto from "crypto";
import type express from "express";

/**
 * Verifies Firebase ID tokens without the admin SDK, using Google's published x509 certs.
 * Only used to prove a request came from the signed-in app user before the server shares its
 * stored Kite session — never as a substitute for the Kite OAuth cookie on data routes.
 */

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let certCache: { keys: Record<string, string>; expiresAt: number } | null = null;

function getProjectId(): string | null {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    null
  );
}

/** Emails allowed to act as the app owner. Empty means any verified Firebase user of this project. */
function allowedEmails(): string[] {
  const raw = process.env.VITE_AUTH_ALLOWED_EMAILS?.trim() || process.env.AUTH_ALLOWED_EMAILS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function getSigningCerts(): Promise<Record<string, string>> {
  if (certCache && certCache.expiresAt > Date.now()) return certCache.keys;

  const res = await fetch(CERT_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Failed to fetch Firebase certs (HTTP ${res.status})`);
  const keys = (await res.json()) as Record<string, string>;

  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const ttlMs = maxAge ? Number(maxAge) * 1000 : 3_600_000;
  certCache = { keys, expiresAt: Date.now() + ttlMs };
  return keys;
}

function base64UrlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface VerifiedFirebaseUser {
  uid: string;
  email: string | null;
}

/** Returns the verified user, or null when the token is absent, malformed, expired or untrusted. */
export async function verifyFirebaseIdToken(token: string): Promise<VerifiedFirebaseUser | null> {
  const projectId = getProjectId();
  if (!projectId) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
  };
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSec) return null;
  if (payload.iat && payload.iat > nowSec + 300) return null;

  let certs: Record<string, string>;
  try {
    certs = await getSigningCerts();
  } catch {
    return null;
  }

  const cert = certs[header.kid];
  if (!cert) return null;

  let publicKey: crypto.KeyObject;
  try {
    publicKey = new crypto.X509Certificate(cert).publicKey;
  } catch {
    return null;
  }

  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    base64UrlDecode(parts[2]),
  );
  if (!signatureValid) return null;

  const email = payload.email ?? null;
  const allowlist = allowedEmails();
  if (allowlist.length > 0 && !allowlist.includes((email ?? "").toLowerCase())) return null;

  return { uid: payload.sub, email };
}

/** True when the request carries a valid `Authorization: Bearer <firebase id token>`. */
export async function isRequestFromSignedInUser(req: express.Request): Promise<boolean> {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return (await verifyFirebaseIdToken(match[1].trim())) !== null;
}
