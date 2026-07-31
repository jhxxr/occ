import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/layout/sidebar";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orbit Control Center · API 中转成本收益",
  description:
    "聚合上游 API 中转站余额与下游自营站收益，核算真实毛利与资金风险",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  const loggedIn = !!verifySessionToken(token);

  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full">
        {loggedIn ? (
          <>
            <Sidebar />
            <main className="min-h-screen pt-14 md:pt-0 md:pl-60">
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
