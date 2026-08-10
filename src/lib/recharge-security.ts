import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export const RECHARGE_GRACE_COOKIE = "orbit_recharge_grace";
const GRACE_SECONDS = 10 * 60;
const VERSION = "orbit-recharge-v1";

function secret(): string {
  const value = process.env.RECHARGE_SECURITY_PASSWORD?.trim();
  if (!value) throw new Error("RECHARGE_SECURITY_PASSWORD is required");
  return value;
}

function key(username: string): Buffer {
  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret) throw new Error("AUTH_SECRET is required");
  return createHmac("sha256", authSecret)
    .update(`${VERSION}|${username}|${secret()}`)
    .digest();
}

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function rechargeGraceToken(username: string, now = Date.now()): string {
  const exp = now + GRACE_SECONDS * 1000;
  const payload = b64(JSON.stringify({ v: VERSION, u: username, exp }));
  const sig = b64(createHmac("sha256", key(username)).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyRechargeGraceToken(
  token: string | null | undefined,
  username: string,
  now = Date.now(),
): boolean {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    const expected = b64(createHmac("sha256", key(username)).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: string;
      u?: string;
      exp?: number;
    };
    return parsed.v === VERSION && parsed.u === username && !!parsed.exp && now < parsed.exp;
  } catch {
    return false;
  }
}

export async function rechargeGraceStatus(): Promise<{ unlocked: boolean; expiresAt: number | null }> {
  const store = await cookies();
  const username = verifySessionToken(store.get(COOKIE_NAME)?.value)?.u;
  const token = store.get(RECHARGE_GRACE_COOKIE)?.value;
  if (!username || !verifyRechargeGraceToken(token, username)) {
    return { unlocked: false, expiresAt: null };
  }
  try {
    const payload = JSON.parse(Buffer.from(token!.split(".")[0]!, "base64url").toString("utf8")) as { exp?: number };
    return { unlocked: true, expiresAt: payload.exp ?? null };
  } catch {
    return { unlocked: false, expiresAt: null };
  }
}

export function graceCookieOptions(token: string, req: Request) {
  const forwarded = req.headers.get("x-forwarded-proto");
  const secure = forwarded
    ? forwarded.split(",")[0]?.trim() === "https"
    : new URL(req.url).protocol === "https:";
  return {
    name: RECHARGE_GRACE_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict" as const,
    secure,
    path: "/api",
    maxAge: GRACE_SECONDS,
  };
}

export function clearGraceCookieOptions(req: Request) {
  return { ...graceCookieOptions("", req), maxAge: 0 };
}

export { GRACE_SECONDS };
