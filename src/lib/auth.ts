/**
 * 私人单用户会话（无注册）
 * Cookie: orbit_session = base64url(payload).base64url(hmac)
 */

import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "orbit_session";
const SESSION_DAYS = 30;
/**
 * 会话签名密钥的版本前缀。
 * 改这个字符串会让所有已发出的会话立即失效（紧急踢人用）。
 * 必须与 auth-edge.ts 里的同名常量保持一致。
 */
const SESSION_KEY_VERSION = "orbit-session-v1";

function secret(): string {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value) throw new Error("AUTH_SECRET is required");
  return value;
}

/**
 * 签名密钥 = HMAC(AUTH_SECRET, 版本 | 用户名 | 密码)。
 *
 * 把当前凭据绑进密钥里，改密码就等于换密钥，所有旧 Cookie 当场失效。
 * 否则会话在 30 天内不可撤销：登出只是清了浏览器那份 Cookie，
 * 被复制走的 token 照样能用，改用户名/密码也拦不住它。
 *
 * 中间件跑在 Edge、连不上数据库，所以撤销状态不能放库里 ——
 * 用凭据派生密钥是这套架构下唯一不加基础设施就能做到的撤销手段。
 */
function sessionKey(): Buffer {
  const u = process.env.AUTH_USERNAME?.trim() ?? "";
  const p = process.env.AUTH_PASSWORD ?? "";
  return createHmac("sha256", secret())
    .update(`${SESSION_KEY_VERSION}|${u}|${p}`)
    .digest();
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
  return b64url(createHmac("sha256", sessionKey()).update(payloadB64).digest());
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
