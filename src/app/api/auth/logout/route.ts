import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookieOptions } from "@/lib/auth";

/** POST/DELETE 登出 */
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(clearSessionCookieOptions(req));
  return res;
}

export async function DELETE(req: NextRequest) {
  return POST(req);
}
