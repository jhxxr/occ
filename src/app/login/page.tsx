"use client";

import { FormEvent, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Eye, EyeOff, LoaderCircle, Satellite } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * 只接受站内绝对路径。
 *
 * `startsWith("/")` 挡不住协议相对地址：`//evil.com` 会被浏览器当成外站，
 * Next 的 router.replace 也会直接硬跳过去 —— 登录页挂个 ?from=//evil.com
 * 就能做成「真域名 + 真证书」的钓鱼跳板。反斜杠同理（部分浏览器等价于 /）。
 */
function safeRedirect(target: string | null): string {
  if (!target) return "/";
  if (target[0] !== "/") return "/";
  if (target[1] === "/" || target[1] === "\\") return "/";
  if (target.includes("\\")) return "/";
  return target;
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const from = safeRedirect(search.get("from"));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "登录失败");
      router.replace(from);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-sidebar text-sidebar-text shadow-sm">
            <Satellite className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-text">Orbit Control</h1>
            <p className="text-xs text-muted">成本 · 收益 · 风险</p>
          </div>
        </div>

        <Card>
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-base">登录控制台</CardTitle>
            <p className="text-sm text-muted">使用你的私人账号继续</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="username">账号</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入账号"
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">密码</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="输入密码"
                    className="pr-11"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted transition-colors hover:text-text"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    title={showPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              {error && (
                <div
                  className="flex items-start gap-2 rounded-md border border-coral/25 bg-coral/5 px-3 py-2 text-xs text-coral"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {loading ? "正在登录" : "登录"}
              </Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-5 text-center text-xs text-muted">Orbit Control Center</p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted" role="status">
          正在加载登录页
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
