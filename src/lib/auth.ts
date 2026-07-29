/**
 * 私人单用户会话（无注册）
 * Cookie: orbit_session = base64url(payload).base64url(hmac)
 */

import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "orbit_session";
const SESSION_DAYS = 30;

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) throw new Error("AUTH_SECRET is required");
  return value;
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function sign(payloadB64: string): string {
  return b64url(createHmac("sha256", secret()).update(payloadB64).digest());
}

export type SessionPayload = {
  u: string; // username
  exp: number; // unix ms
};

export function createSessionToken(username: string): string {
  const payload: SessionPayload = {
    u: username,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const raw = fromB64url(payloadB64).toString("utf8");
    const payload = JSON.parse(raw) as SessionPayload;
    if (!payload?.u || !payload?.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 固定私人账号（无注册） */
export function validateCredentials(username: string, password: string): boolean {
  const u = process.env.AUTH_USERNAME?.trim();
  const p = process.env.AUTH_PASSWORD;
  if (!u || !p) return false;
  // timing-ish compare
  try {
    const ub = Buffer.from(username);
    const ue = Buffer.from(u);
    const pb = Buffer.from(password);
    const pe = Buffer.from(p);
    if (ub.length !== ue.length || pb.length !== pe.length) return false;
    return timingSafeEqual(ub, ue) && timingSafeEqual(pb, pe);
  } catch {
    return username === u && password === p;
  }
}

/**
 * A Secure cookie is dropped by the browser over plain HTTP, which silently
 * breaks login for HTTP deployments. Decide from the request's actual scheme
 * (honouring X-Forwarded-Proto behind a reverse proxy) rather than NODE_ENV.
 */
function isSecureRequest(req?: Request): boolean {
  if (!req) return process.env.NODE_ENV === "production";
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieOptions(token: string, req?: Request) {
  return {
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(req),
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

export function clearSessionCookieOptions(req?: Request) {
  return {
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(req),
    path: "/",
    maxAge: 0,
  };
}

export { COOKIE_NAME };
