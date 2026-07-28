import { NextResponse } from "next/server";
import { clearSessionCookieOptions } from "@/lib/auth";

/** POST/DELETE 登出 */
export async function POST() {
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(clearSessionCookieOptions());
  return res;
}

export async function DELETE() {
  return POST();
}
