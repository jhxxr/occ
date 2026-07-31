import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  sessionCookieOptions,
  validateCredentials,
  verifySessionToken,
  COOKIE_NAME,
  clearSessionCookieOptions,
} from "@/lib/auth";
import {
  checkLoginAllowed,
  clientKey,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/rate-limit";

/** POST { username, password } → set session cookie */
export async function POST(req: NextRequest) {
  try {
    const key = clientKey(req);
    const verdict = checkLoginAllowed(key);
    if (!verdict.allowed) {
      return NextResponse.json(
        {
          error:
            verdict.scope === "global"
              ? `登录失败次数过多，请 ${verdict.retryAfterSec} 秒后再试`
              : `密码错误次数过多，请 ${verdict.retryAfterSec} 秒后再试`,
        },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } },
      );
    }

    const body = await req.json();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      return NextResponse.json(
        { error: "请输入账号和密码" },
        { status: 400 },
      );
    }
    if (!validateCredentials(username, password)) {
      recordLoginFailure(key);
      return NextResponse.json(
        { error: "账号或密码错误" },
        { status: 401 },
      );
    }
    recordLoginSuccess(key);
    const token = createSessionToken(username);
    const res = NextResponse.json({
      data: { ok: true, username },
    });
    const opt = sessionCookieOptions(token, req);
    res.cookies.set(opt);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "登录失败" },
      { status: 500 },
    );
  }
}

/** GET — 当前会话 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const session = verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  return NextResponse.json({ data: { username: session.u } });
}

/** DELETE — 登出 */
export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(clearSessionCookieOptions(req));
  return res;
}
