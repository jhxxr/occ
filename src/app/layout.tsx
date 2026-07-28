import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/layout/sidebar";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {loggedIn ? (
          <>
            <Sidebar />
            <main className="min-h-screen pt-14 md:pt-0 md:pl-56">
              <div className="relative mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                <div className="pointer-events-none absolute inset-0 orbit-grid opacity-40" />
                <div className="relative z-10">{children}</div>
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
