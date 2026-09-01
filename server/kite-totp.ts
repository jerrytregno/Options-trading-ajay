import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 decode. Ignores spaces and `=` padding, as printed by authenticator setup keys. */
function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new Error("TOTP secret is empty");

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`TOTP secret has a non-base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(out);
}

/**
 * RFC 6238 TOTP. Zerodha uses the authenticator defaults: SHA-1, 30-second step, 6 digits.
 * `secret` is the base32 setup key shown when external TOTP is enabled in the Kite console.
 */
export function generateTotp(secret: string, atMs = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / 30);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 1_000_000).padStart(6, "0");
}

/** Ms remaining in the current 30s TOTP step — used to avoid submitting a code about to roll over. */
export function msLeftInTotpStep(atMs = Date.now()): number {
  return 30_000 - (atMs % 30_000);
}
