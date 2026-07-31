/**
 * Edge-safe session helpers (Web Crypto only) for middleware.
 * Node routes can keep using @/lib/auth (node:crypto).
 */

const COOKIE_NAME = "orbit_session";
const SESSION_DAYS = 30;
/** 必须与 auth.ts 里的同名常量一致，否则两边算出的密钥不同、会话全部失效 */
const SESSION_KEY_VERSION = "orbit-session-v1";

function secretBytes(): Uint8Array | null {
  const secret = process.env.AUTH_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

function b64urlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!);
  // btoa available in Edge
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(
  raw: Uint8Array | ArrayBuffer,
): Promise<CryptoKey> {
  const buf =
    raw instanceof Uint8Array ? (raw.buffer as ArrayBuffer) : raw;
  return crypto.subtle.importKey(
    "raw",
    buf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * 与 auth.ts 的 sessionKey() 必须逐字节一致：
 * HMAC(AUTH_SECRET, 版本 | 用户名 | 密码)。改密码即换密钥、旧会话立即失效。
 */
async function sessionKeyBytes(): Promise<ArrayBuffer | null> {
  const bytes = secretBytes();
  if (!bytes) return null;
  const u = process.env.AUTH_USERNAME?.trim() ?? "";
  const p = process.env.AUTH_PASSWORD ?? "";
  const outer = await importHmacKey(bytes);
  return crypto.subtle.sign(
    "HMAC",
    outer,
    new TextEncoder().encode(`${SESSION_KEY_VERSION}|${u}|${p}`),
  );
}

async function hmacSign(payloadB64: string): Promise<string | null> {
  const keyBytes = await sessionKeyBytes();
  if (!keyBytes) return null;
  const key = await importHmacKey(keyBytes);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );
  return b64urlFromBytes(sig);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export type SessionPayload = { u: string; exp: number };

export async function verifySessionTokenEdge(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = await hmacSign(payloadB64);
  if (!expected || !timingSafeEqualStr(sig, expected)) return null;
  try {
    const raw = new TextDecoder().decode(bytesFromB64url(payloadB64));
    const payload = JSON.parse(raw) as SessionPayload;
    if (!payload?.u || !payload?.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export { COOKIE_NAME, SESSION_DAYS };
