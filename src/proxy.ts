import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, verifySessionTokenEdge } from "@/lib/auth-edge";

const PUBLIC_PATHS = ["/login"];
const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  // 对外 Token 鉴权接口（路由内校验 Bearer / 路径 token，不走登录 Cookie）
  "/api/public",
  // Uptime Kuma 兼容：/api/status-page/<token> 与 heartbeat
  "/api/status-page",
];

function isPublic(pathname: string): boolean {
  // API 一律按接口鉴权，绝不套用静态资源那套后缀白名单。
  // 动态段能吃掉点号，所以 /api/self-hosted/<id>.png 会命中 .png 规则
  // 直接绕过登录检查（那条路由的 POST 会触发同步、改分组/账号）。
  if (pathname.startsWith("/api/")) {
    return PUBLIC_API_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg")
  ) {
    return true;
  }
  return false;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    if (pathname === "/login" || pathname.startsWith("/login/")) {
      const token = request.cookies.get(COOKIE_NAME)?.value;
      if (await verifySessionTokenEdge(token)) {
        return NextResponse.redirect(new URL("/", request.url));
      }
    }
    return NextResponse.next();
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const session = await verifySessionTokenEdge(token);

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("from", pathname);
    const res = NextResponse.redirect(login);
    res.cookies.set({
      name: COOKIE_NAME,
      value: "",
      path: "/",
      maxAge: 0,
    });
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
