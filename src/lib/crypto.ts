import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function deriveKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error("ENCRYPTION_SECRET is required");
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a secret string. Returns `iv:tag:ciphertext` hex bundle. */
export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypt a secret produced by encryptSecret. Falls back to raw value for legacy plain text. */
export function decryptSecret(bundle: string): string {
  if (!bundle.includes(":")) {
    // Legacy / unencrypted value (dev convenience)
    return bundle;
  }
  const [ivHex, tagHex, dataHex] = bundle.split(":");
  if (!ivHex || !tagHex || !dataHex) return bundle;
  try {
    const key = deriveKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    return bundle;
  }
}

/** Mask a key for UI display: show first 4 and last 4 chars. */
export function maskSecret(value: string, visible = 4): string {
  if (!value) return "";
  if (value.length <= visible * 2) return "••••••••";
  return `${value.slice(0, visible)}${"•".repeat(8)}${value.slice(-visible)}`;
}
