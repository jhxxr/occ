import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/layout/sidebar";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orbit Control Center · API 中转成本收益",
  description:
    "聚合上游 API 中转站余额与下游自营站收益，核算真实毛利与资金风险",
};

/**
 * 本版本 metadata.themeColor / colorScheme 已废弃，必须走 viewport 导出。
 * 两个 media 分支让移动端浏览器 UI 跟随主题。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f5" },
    { media: "(prefers-color-scheme: dark)", color: "#06080a" },
  ],
};

/*
 * 在 HTML 解析期同步执行，早于首帧绘制 —— 深色模式刷新不会白闪。
 * 读不到偏好就回退系统设置；localStorage 被禁用时静默跟随系统。
 */
const THEME_INIT = `(function(){try{var c=localStorage.getItem("orbit-theme");var d=c==="dark"||((c==="auto"||!c)&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  const loggedIn = !!verifySessionToken(token);

  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {loggedIn ? (
          <>
            <Sidebar />
            <main className="min-h-screen pt-16 md:pt-0 md:pl-64">
              <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
                <div>{children}</div>
              </div>
            </main>
          </>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
