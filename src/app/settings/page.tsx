"use client";

import { FormEvent, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Shield, Coins } from "lucide-react";

export default function SettingsPage() {
  const [usdCny, setUsdCny] = useState("7.2");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => {
        if (j.data?.usdCny != null) setUsdCny(String(j.data.usdCny));
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usdCny: Number(usdCny) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      setMsg("设置已保存");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="系统设置"
        subtitle="汇率、加密与同步相关偏好"
        showSync={false}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
              <Coins className="h-4 w-4 text-amber" />
              汇率与折算
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="usdCny">备用折算率（面值→人民币）</Label>
                <Input
                  id="usdCny"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={usdCny}
                  onChange={(e) => setUsdCny(e.target.value)}
                />
                <p className="text-xs text-muted leading-relaxed">
                  界面统一显示人民币。上游优先用各站「购入成本」；仅当下游选择「面值×汇率」时使用此备用折算率。你的自营站 1:1
                  充值不走这里。
                </p>
              </div>
              {msg && (
                <p className="text-xs text-secondary">{msg}</p>
              )}
              <Button type="submit" disabled={saving}>
                {saving ? "保存中…" : "保存设置"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
              <Shield className="h-4 w-4 text-cyan" />
              安全说明
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-secondary leading-relaxed">
            <p>
              API Key 使用 AES-256-GCM 加密后写入本地 SQLite（
              <code className="font-data text-xs text-cyan">prisma/dev.db</code>
              ）。
            </p>
            <p>
              请在 <code className="font-data text-xs text-cyan">.env</code> 中设置
              强随机 <code className="font-data text-xs">ENCRYPTION_SECRET</code>
              ，并避免将数据库与密钥提交到公开仓库。
            </p>
            <p className="text-xs text-muted">
              利润公式（人民币）：上游成本 = Σ(增量消耗面值 × 购入成本)；净利润 =
              下游收入 − 上游成本。首次同步不把历史消耗计为当日成本。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
