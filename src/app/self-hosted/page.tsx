"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Plus,
  ServerCog,
  ExternalLink,
  Trash2,
  Settings2,
  X,
} from "lucide-react";

interface Site {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  lastConsumed: number | null;
  notes: string | null;
}

export default function SelfHostedListPage() {
  const [list, setList] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [name, setName] = useState("自建 Sub2API");
  const [baseUrl, setBaseUrl] = useState("https://sub2.example.com");
  const [adminKey, setAdminKey] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/self-hosted");
      const json = await res.json();
      setList(json.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/self-hosted", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, baseUrl, adminKey, notes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "创建失败");
      setMsg(
        `已添加：同步到 ${json.data.meta.groups} 个分组、${json.data.meta.accounts} 个账号`,
      );
      setShowForm(false);
      setAdminKey("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("删除该自建上游？分组/账号配置会一并删除。")) return;
    await fetch(`/api/self-hosted?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="自建上游"
        subtitle="自建 Sub2API 管理端（X-API-Key）。按分组设卖出倍率、按账号填买号成本。"
        showSync={false}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {list.length === 0 ? "尚未添加自建站点" : `${list.length} 个自建站点`}
        </p>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-3.5 w-3.5" />
            添加自建 Sub2API
          </Button>
        )}
      </div>

      {showForm && (
        <Card className="border-cyan/30">
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal">
              绑定管理员 API Key
            </CardTitle>
            <Button size="icon" variant="ghost" onClick={() => setShowForm(false)}>
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>名称</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label>站点 URL</Label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  required
                  type="url"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Admin API Key</Label>
                <Input
                  type="password"
                  value={adminKey}
                  onChange={(e) => setAdminKey(e.target.value)}
                  placeholder="admin-xxxxxxxx"
                  required
                  autoComplete="off"
                />
                <p className="text-[11px] text-muted">
                  使用请求头 <code className="font-data text-cyan">X-API-Key</code>
                  ，与用户侧 JWT / 邮箱密码完全独立。
                </p>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>备注</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="min-h-[56px]"
                />
              </div>
              {error && (
                <p className="text-xs text-coral sm:col-span-2">{error}</p>
              )}
              {msg && <p className="text-xs text-mint sm:col-span-2">{msg}</p>}
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "验证并添加…" : "添加"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowForm(false)}
                >
                  取消
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted">加载中…</div>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center space-y-3">
            <ServerCog className="h-8 w-8 text-muted mx-auto" />
            <p className="text-sm text-secondary">还没有自建上游</p>
            <p className="text-xs text-muted max-w-md mx-auto">
              用于你自己部署的 Sub2API。填写管理端 Admin Key 后，可按分组统计官方用量，
              并给每个反代号设置采购成本与卖出倍率。
            </p>
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              添加
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((s) => (
            <Card key={s.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-text">{s.name}</h3>
                    <Badge variant="violet">自建管理端</Badge>
                    <Badge variant={s.enabled ? "mint" : "default"}>
                      {s.enabled ? "启用" : "停用"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted truncate">{s.baseUrl}</p>
                  <p className="text-xs font-data text-secondary">
                    Key: {s.apiKey}
                    {s.lastConsumed != null && (
                      <> · 官方累计用量面值 {s.lastConsumed.toFixed(2)}</>
                    )}
                  </p>
                  <p className="text-[11px] text-muted">
                    {s.lastSyncAt
                      ? `同步于 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`
                      : "尚未同步"}
                    {s.lastError ? (
                      <span className="text-coral"> · {s.lastError}</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={s.baseUrl} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="outline">
                      <ExternalLink className="h-3.5 w-3.5" />
                      打开
                    </Button>
                  </a>
                  <Link href={`/self-hosted/${s.id}`}>
                    <Button size="sm">
                      <Settings2 className="h-3.5 w-3.5" />
                      分组与账号
                    </Button>
                  </Link>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => remove(s.id)}
                    aria-label="删除"
                  >
                    <Trash2 className="h-4 w-4 text-coral" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
