"use client";

import { FormEvent, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Satellite } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const from = search.get("from") || "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      router.replace(from.startsWith("/") ? from : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="pointer-events-none absolute inset-0 orbit-grid opacity-40" />
      <Card className="relative z-10 w-full max-w-sm border-border-subtle bg-surface/90 backdrop-blur">
        <CardHeader className="items-center text-center space-y-3 pb-2">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <span className="absolute inset-0 rounded-full border border-cyan/30" />
            <span className="absolute inset-1 rounded-full border border-cyan/20 border-dashed animate-[spin_12s_linear_infinite]" />
            <Satellite className="h-5 w-5 text-cyan" />
          </div>
          <div>
            <CardTitle className="text-lg font-semibold text-text normal-case tracking-normal">
              Orbit Control
            </CardTitle>
            <p className="mt-1 text-xs text-muted tracking-wide">
              私人控制台 · 请登录
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="username">账号</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="账号"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="密码"
                required
              />
            </div>
            {error && (
              <p className="text-xs text-coral">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "登录中…" : "登录"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-sm text-muted">
          加载中…
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
