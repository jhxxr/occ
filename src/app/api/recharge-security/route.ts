import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "crypto";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import {
  clearGraceCookieOptions,
  graceCookieOptions,
  rechargeGraceStatus,
  rechargeGraceToken,
} from "@/lib/recharge-security";

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

function passwordMatches(input: string): boolean {
  const expected = process.env.RECHARGE_SECURITY_PASSWORD?.trim();
  if (!expected) throw new Error("RECHARGE_SECURITY_PASSWORD is required");
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET() {
  return NextResponse.json({ data: await rechargeGraceStatus() });
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }
  const store = await cookies();
  const session = verifySessionToken(store.get(COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const body = await req.json();
  if (!passwordMatches(String(body.password || ""))) {
    return NextResponse.json({ error: "安全密码错误" }, { status: 401 });
  }
  const token = rechargeGraceToken(session.u);
  const res = NextResponse.json({ data: { unlocked: true } });
  res.cookies.set(graceCookieOptions(token, req));
  return res;
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ data: { unlocked: false } });
  res.cookies.set(clearGraceCookieOptions(req));
  return res;
}
