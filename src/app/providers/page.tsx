"use client";

import { FormEvent, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatRmb } from "@/lib/utils";
import Link from "next/link";
import { Pencil, Plus, Trash2, KeyRound, SlidersHorizontal, ExternalLink, Wallet } from "lucide-react";

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  type: string;
  accountEmail: string | null;
  accountPasswordSet?: boolean;
  refreshTokenSet?: boolean;
  tokenExpiresAt: string | null;
  discountRate: number;
  currency: string;
  alertThreshold: number;
  quotaPerDollar: number;
  enabled: boolean;
  notes: string | null;
  lastBalance: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

const emptyForm = {
  name: "",
  baseUrl: "",
  apiKey: "",
  type: "NEWAPI",
  accountEmail: "",
  accountPassword: "",
  discountRate: 7.2,
  currency: "USD",
  alertThreshold: 10,
  quotaPerDollar: 500000,
  enabled: true,
  notes: "",
};

export default function ProvidersPage() {
  const [list, setList] = useState<Provider[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

async function load() {
    const res = await fetch("/api/providers");
    const json = await res.json();
    setList(json.data || []);
  }

  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);

  function startEdit(p: Provider) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: "",
      type: p.type,
      accountEmail: p.accountEmail || "",
      accountPassword: "",
      discountRate: p.discountRate,
      currency: p.currency,
      alertThreshold: p.alertThreshold,
      quotaPerDollar: p.quotaPerDollar,
      enabled: p.enabled,
      notes: p.notes || "",
    });
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        const payload: Record<string, unknown> = {
          id: editingId,
          name: form.name,
          baseUrl: form.baseUrl,
          type: form.type,
          discountRate: Number(form.discountRate),
          currency: form.currency,
          alertThreshold: Number(form.alertThreshold),
          quotaPerDollar: Number(form.quotaPerDollar),
          enabled: form.enabled,
          notes: form.notes || null,
          accountEmail: form.accountEmail || null,
          relogin: form.type === "SUB2API" && !!form.accountPassword.trim(),
        };
        if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        if (form.accountPassword.trim()) {
          payload.accountPassword = form.accountPassword.trim();
        }
        const res = await fetch("/api/providers", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "更新失败");
      } else {
        if (form.type === "SUB2API") {
          if (!form.accountEmail.trim() || !form.accountPassword.trim()) {
            if (!form.apiKey.trim()) {
              throw new Error("Sub2API 请填写邮箱+密码（推荐），或单独填 JWT");
            }
          }
        } else if (!form.apiKey.trim()) {
          throw new Error("请填写 API Key");
        }
        const res = await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            accountEmail: form.accountEmail || null,
            accountPassword: form.accountPassword || null,
            discountRate: Number(form.discountRate),
            alertThreshold: Number(form.alertThreshold),
            quotaPerDollar:
              form.type === "SUB2API" ? 1 : Number(form.quotaPerDollar),
            notes: form.notes || null,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "创建失败");
      }
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("确认删除该上游站点？相关快照也会删除。")) return;
    await fetch(`/api/providers?id=${id}`, { method: "DELETE" });
    await load();
  }

  async function relogin(id: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, relogin: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "重新登录失败");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新登录失败");
    } finally {
      setSaving(false);
    }
  }

  const isSub2 = form.type === "SUB2API";

  return (
    <div className="space-y-6">
      <TopBar
        title="上游站点"
        subtitle="配置 NewAPI / Sub2API / OneAPI 等上游中转账号"
        showSync={false}
      />

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-text normal-case tracking-normal text-base font-semibold">
              <Plus className="h-4 w-4 text-cyan" />
              {editingId ? "编辑上游" : "添加上游"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="name">名称</Label>
                <Input
                  id="name"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="如：EasyTokens"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="baseUrl">站点 URL</Label>
                <Input
                  id="baseUrl"
                  required
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://api.example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="type">框架类型</Label>
                <Select
                  id="type"
                  value={form.type}
                  onChange={(e) => {
                    const type = e.target.value;
                    setForm({
                      ...form,
                      type,
                      quotaPerDollar: type === "SUB2API" ? 1 : 500000,
                    });
                  }}
                >
                  <option value="NEWAPI">NewAPI</option>
                  <option value="SUB2API">Sub2API</option>
                  <option value="ONEAPI">OneAPI</option>
                  <option value="OTHER">Other</option>
                </Select>
              </div>

              {isSub2 ? (
                <div className="space-y-3 rounded-lg border border-cyan/20 bg-cyan/5 p-3">
                  <p className="text-xs leading-5 text-secondary">
                    Sub2API 绑定<strong className="text-text">面板邮箱+密码</strong>
                    后，同步时会自动登录 / 刷新 JWT，无需再手动复制
                    auth_token。密码 AES 加密存本地库。
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="accountEmail">面板邮箱</Label>
                    <Input
                      id="accountEmail"
                      type="email"
                      autoComplete="username"
                      value={form.accountEmail}
                      onChange={(e) =>
                        setForm({ ...form, accountEmail: e.target.value })
                      }
                      placeholder="you@example.com"
                      required={!editingId}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="accountPassword">
                      面板密码
                      {editingId && (
                        <span className="ml-1 text-muted">（留空则不修改）</span>
                      )}
                    </Label>
                    <Input
                      id="accountPassword"
                      type="password"
                      autoComplete="current-password"
                      value={form.accountPassword}
                      onChange={(e) =>
                        setForm({ ...form, accountPassword: e.target.value })
                      }
                      placeholder="••••••••"
                      required={!editingId}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="apiKey">
                      JWT（可选，一般不用填）
                      {editingId && (
                        <span className="ml-1 text-muted">留空自动维护</span>
                      )}
                    </Label>
                    <Input
                      id="apiKey"
                      type="password"
                      autoComplete="off"
                      value={form.apiKey}
                      onChange={(e) =>
                        setForm({ ...form, apiKey: e.target.value })
                      }
                      placeholder="保存时若填了密码会自动登录获取"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="apiKey">
                    API Key / Access Token
                    {editingId && (
                      <span className="ml-1 text-muted">（留空则不修改）</span>
                    )}
                  </Label>
                  <Input
                    id="apiKey"
                    type="password"
                    autoComplete="off"
                    value={form.apiKey}
                    onChange={(e) =>
                      setForm({ ...form, apiKey: e.target.value })
                    }
                    placeholder={editingId ? "••••••••" : "sk-... 或系统令牌"}
                    required={!editingId}
                  />
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="discountRate">购入成本（元 / 面值单位）</Label>
                  <Input
                    id="discountRate"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={form.discountRate}
                    onChange={(e) =>
                      setForm({ ...form, discountRate: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alertThreshold">预警阈值（面值单位）</Label>
                  <Input
                    id="alertThreshold"
                    type="number"
                    step="0.1"
                    min="0"
                    value={form.alertThreshold}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        alertThreshold: Number(e.target.value),
                      })
                    }
                  />
                </div>
                {!isSub2 && (
                  <div className="space-y-1.5 col-span-2">
                    <Label htmlFor="quotaPerDollar">Quota / 面值单位</Label>
                    <Input
                      id="quotaPerDollar"
                      type="number"
                      step="1"
                      min="1"
                      value={form.quotaPerDollar}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          quotaPerDollar: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="notes">备注</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="可选"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                  className="rounded border-border"
                />
                启用同步
              </label>
              {error && <p className="text-xs text-coral" role="alert">{error}</p>}
              <div className="flex gap-2 pt-1">
                <Button type="submit" disabled={saving} className="flex-1">
                  {saving
                    ? isSub2
                      ? "登录并保存…"
                      : "保存中…"
                    : editingId
                      ? "更新"
                      : "添加"}
                </Button>
                {editingId && (
                  <Button type="button" variant="secondary" onClick={resetForm}>
                    取消
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-3 xl:col-span-3">
          {list.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted">
                还没有上游站点，请在左侧添加。
              </CardContent>
            </Card>
          ) : (
            list.map((p) => (
              <Card key={p.id} className="transition-[border-color,box-shadow] hover:border-border hover:shadow-sm">
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-text">{p.name}</h3>
                      <Badge variant="cyan">{p.type}</Badge>
                      {p.type === "SUB2API" && p.accountPasswordSet && (
                        <Badge variant="mint">自动登录</Badge>
                      )}
                      {p.type === "SUB2API" && p.refreshTokenSet && (
                        <Badge variant="violet">可刷新 JWT</Badge>
                      )}
                      {!p.enabled && <Badge>已停用</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted">{p.baseUrl}</p>
                    <p className="text-xs text-secondary font-data">
                      {p.type === "SUB2API" ? (
                        <>
                          账号: {p.accountEmail || "—"} · 令牌: {p.apiKey || "未获取"}
                          {p.tokenExpiresAt
                            ? ` · 到期 ${new Date(p.tokenExpiresAt).toLocaleString("zh-CN")}`
                            : ""}
                        </>
                      ) : (
                        <>
                          Key: {p.apiKey} · 成本 {formatRmb(p.discountRate)}/面值 · 预警{" "}
                          {formatRmb(p.alertThreshold * p.discountRate)}
                        </>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      余额{" "}
                      {p.lastBalance != null
                        ? formatRmb(p.lastBalance * p.discountRate)
                        : "—"}
                      {p.lastError && (
                        <span className="text-coral"> · {p.lastError}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <a
                      href={p.baseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="打开网站"
                      aria-label="打开网站"
                      className={buttonVariants({ variant: "outline", size: "icon" })}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    {p.type === "SUB2API" && (
                      <Link
                        href={`/providers/${p.id}/recharges`}
                        aria-label="充值台账"
                        title="充值台账"
                        className={buttonVariants({ variant: "outline", size: "icon" })}
                      >
                        <Wallet className="h-4 w-4" />
                      </Link>
                    )}
                    {p.type === "SUB2API" && (
                      <Link
                        href={`/providers/${p.id}`}
                        aria-label="密钥与分组"
                        title="密钥与分组管理"
                        className={buttonVariants({ variant: "default", size: "icon" })}
                      >
                        <SlidersHorizontal className="h-4 w-4" />
                      </Link>
                    )}
                    {p.type === "SUB2API" && p.accountPasswordSet && (
                      <Button
                        size="icon"
                        variant="secondary"
                        onClick={() => relogin(p.id)}
                        aria-label="重新登录刷新 JWT"
                        title="重新登录刷新 JWT"
                        disabled={saving}
                      >
                        <KeyRound className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="secondary"
                      onClick={() => startEdit(p)}
                      aria-label="编辑"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="danger"
                      onClick={() => remove(p.id)}
                      aria-label="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
