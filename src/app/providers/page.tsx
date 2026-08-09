"use client";

import { FormEvent, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox, Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { formatRmb } from "@/lib/utils";
import Link from "next/link";
import {
  Archive,
  Database,
  ExternalLink,
  KeyRound,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";

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
  retiredAt: string | null;
  retirementType: "NORMAL" | "BALANCE_LOSS" | null;
  retirementNote: string | null;
  retiredBalance: number | null;
  retiredCostRate: number | null;
  balanceWriteOffRmb: number | null;
  boundKeyCount?: number;
  activeBoundKeyCount?: number;
  failedBoundKeyCount?: number;
}

interface RetirementDraft {
  provider: Provider;
  type: "NORMAL" | "BALANCE_LOSS";
  balance: string;
  costRate: string;
  day: string;
  note: string;
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

function shanghaiDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default function ProvidersPage() {
  const [list, setList] = useState<Provider[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retirement, setRetirement] = useState<RetirementDraft | null>(null);

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
        } else if (form.type !== "MOLIFANG" && !form.apiKey.trim()) {
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

  async function remove(p: Provider) {
    if (
      !confirm(
        `永久删除「${p.name}」？在线明细、日汇总和归档文件都会清除，财务核销记录会保留。`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/providers?id=${p.id}&permanent=1`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "永久删除失败");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "永久删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function openRetirement(p: Provider) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/providers/${p.id}/lifecycle`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "弃用信息加载失败");
      const defaults = json.data.defaults;
      setRetirement({
        provider: p,
        type: "NORMAL",
        balance: String(defaults.balance ?? p.lastBalance ?? 0),
        costRate: String(defaults.costRate ?? p.discountRate),
        day: defaults.day || shanghaiDay(),
        note: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "弃用信息加载失败");
    } finally {
      setSaving(false);
    }
  }

  async function submitRetirement() {
    if (!retirement) return;
    setSaving(true);
    setError(null);
    try {
      const isLoss = retirement.type === "BALANCE_LOSS";
      const res = await fetch(
        `/api/providers/${retirement.provider.id}/lifecycle`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "retire",
            type: retirement.type,
            balance: isLoss ? Number(retirement.balance) : undefined,
            costRate: isLoss ? Number(retirement.costRate) : undefined,
            day: isLoss ? retirement.day : undefined,
            note: retirement.note || undefined,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "弃用失败");
      setRetirement(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "弃用失败");
    } finally {
      setSaving(false);
    }
  }

  async function restore(p: Provider) {
    const detail =
      p.retirementType === "BALANCE_LOSS"
        ? "恢复后，本次余额损失核销会标记为作废。"
        : "恢复后将重新启用同步。";
    if (!confirm(`恢复「${p.name}」？${detail}`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/providers/${p.id}/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "恢复失败");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复失败");
    } finally {
      setSaving(false);
    }
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
  const editingRetired = editingId
    ? list.find((provider) => provider.id === editingId)?.retiredAt != null
    : false;
  const writeOffEstimate = retirement
    ? Math.max(0, Number(retirement.balance) || 0) *
      Math.max(0, Number(retirement.costRate) || 0)
    : 0;

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
                  <option value="MOLIFANG">MoLiFang 多 Key</option>
                  <option value="ONEAPI">OneAPI</option>
                  <option value="OTHER">Other</option>
                </Select>
              </div>

              {isSub2 ? (
                <div className="space-y-3 rounded-[var(--r-lg)] border border-cyan/25 bg-cyan/10 p-3.5">
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
              ) : form.type === "MOLIFANG" ? (
                <div className="rounded-[var(--r-lg)] border border-mint/25 bg-mint/10 p-3.5 text-xs leading-5 text-secondary">
                  先创建供应商，保存后进入「绑定密钥」，可添加多条普通
                  <code className="mx-1 font-data text-mint">sk-...</code>
                  Key。每条 Key 会单独读取
                  <code className="mx-1 font-data text-mint">/v1/usage</code>
                  并汇总余额和成本，不需要 JWT。
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
                {!isSub2 && form.type !== "MOLIFANG" && (
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
                <Checkbox
                                    checked={form.enabled}
                  disabled={editingRetired}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }/>
                {editingRetired ? "已弃用（需从站点列表恢复）" : "启用同步"}
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
              <Card key={p.id} className="transition-all duration-200 hover:shadow-lg">
                <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-text">{p.name}</h3>
                      <Badge variant="cyan">{p.type}</Badge>
                      {p.type === "MOLIFANG" && (
                        <Badge variant={p.failedBoundKeyCount ? "coral" : "mint"}>
                          {p.activeBoundKeyCount || 0} 个 Key
                          {p.failedBoundKeyCount ? ` · ${p.failedBoundKeyCount} 失败` : ""}
                        </Badge>
                      )}
                      {p.type === "SUB2API" && p.accountPasswordSet && (
                        <Badge variant="mint">自动登录</Badge>
                      )}
                      {p.type === "SUB2API" && p.refreshTokenSet && (
                        <Badge variant="violet">可刷新 JWT</Badge>
                      )}
                      {p.retiredAt ? (
                        <Badge
                          variant={
                            p.retirementType === "BALANCE_LOSS" ? "coral" : "amber"
                          }
                        >
                          {p.retirementType === "BALANCE_LOSS"
                            ? "已弃用 · 余额已核销"
                            : "已弃用"}
                        </Badge>
                      ) : (
                        !p.enabled && <Badge>已停用</Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted">{p.baseUrl}</p>
                    <p className="text-xs text-secondary font-data">
                      {p.type === "MOLIFANG" ? (
                        <>
                          已绑定多 Key · 成本 {formatRmb(p.discountRate)}/面值 · 预警{" "}
                          {formatRmb(p.alertThreshold * p.discountRate)}
                        </>
                      ) : p.type === "SUB2API" ? (
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
                    {p.retiredAt && (
                      <p className="text-xs text-amber">
                        弃用于 {new Date(p.retiredAt).toLocaleDateString("zh-CN")}
                        {p.balanceWriteOffRmb != null && p.balanceWriteOffRmb > 0
                          ? ` · 核销 ${formatRmb(p.balanceWriteOffRmb)}`
                          : ""}
                      </p>
                    )}
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
                    {(p.type === "SUB2API" || p.type === "MOLIFANG") && !p.retiredAt && (
                      <Link
                        href={`/providers/${p.id}`}
                        aria-label="密钥与分组"
                        title="密钥与分组管理"
                        className={buttonVariants({ variant: "default", size: "icon" })}
                      >
                        <SlidersHorizontal className="h-4 w-4" />
                      </Link>
                    )}
                    {p.type === "SUB2API" && p.retiredAt && (
                      <Link
                        href={`/providers/${p.id}/usage`}
                        aria-label="本地使用记录"
                        title="查看本地使用记录"
                        className={buttonVariants({ variant: "default", size: "icon" })}
                      >
                        <Database className="h-4 w-4" />
                      </Link>
                    )}
                    {p.type === "SUB2API" && p.accountPasswordSet && !p.retiredAt && (
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
                    {p.retiredAt ? (
                      <>
                        <Button
                          size="icon"
                          variant="secondary"
                          onClick={() => restore(p)}
                          aria-label="恢复使用"
                          title="恢复使用"
                          disabled={saving}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="danger"
                          onClick={() => remove(p)}
                          aria-label="永久删除"
                          title="永久删除"
                          disabled={saving}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => openRetirement(p)}
                        aria-label="弃用上游"
                        title="弃用上游"
                        disabled={saving}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      {retirement && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-md"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !saving) {
              setRetirement(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="retirement-title"
            className="glass-strong w-full max-w-lg overflow-hidden rounded-[var(--r-xl)]"
          >
            <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
              <div>
                <h2 id="retirement-title" className="text-base font-semibold text-text">
                  弃用 {retirement.provider.name}
                </h2>
                <p className="mt-1 text-xs text-muted">
                  停止远端同步并保留日汇总、充值台账和财务历史
                </p>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setRetirement(null)}
                disabled={saving}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <Segmented
                ariaLabel="弃用方式"
                className="w-full"
                value={retirement.type}
                onChange={(type) => setRetirement({ ...retirement, type })}
                options={[
                  { value: "NORMAL", label: "正常弃用" },
                  {
                    value: "BALANCE_LOSS",
                    tone: "coral",
                    label: (
                      <>
                        <TriangleAlert className="h-3.5 w-3.5" />
                        跑路核销
                      </>
                    ),
                  },
                ]}
              />

              {retirement.type === "BALANCE_LOSS" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="retiredBalance">无法追回余额</Label>
                    <Input
                      id="retiredBalance"
                      type="number"
                      min="0"
                      step="0.0001"
                      value={retirement.balance}
                      onChange={(event) =>
                        setRetirement({
                          ...retirement,
                          balance: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="retiredCostRate">购入成本（元 / 面值）</Label>
                    <Input
                      id="retiredCostRate"
                      type="number"
                      min="0.0001"
                      step="0.0001"
                      value={retirement.costRate}
                      onChange={(event) =>
                        setRetirement({
                          ...retirement,
                          costRate: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="retiredDay">确认损失日期</Label>
                    <Input
                      id="retiredDay"
                      type="date"
                      value={retirement.day}
                      onChange={(event) =>
                        setRetirement({ ...retirement, day: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>本次核销成本</Label>
                    <div className="flex h-10 items-center rounded-[var(--r-md)] border border-coral/30 bg-coral/10 px-3.5 font-data font-semibold text-coral">
                      {formatRmb(writeOffEstimate)}
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="retirementNote">备注</Label>
                <Textarea
                  id="retirementNote"
                  value={retirement.note}
                  onChange={(event) =>
                    setRetirement({ ...retirement, note: event.target.value })
                  }
                  placeholder="退款、失联或处置说明"
                />
              </div>
              {error && <p className="text-xs text-coral">{error}</p>}
            </div>

            <div className="flex justify-end gap-2 border-t border-border-subtle px-5 py-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setRetirement(null)}
                disabled={saving}
              >
                取消
              </Button>
              <Button
                type="button"
                variant={retirement.type === "BALANCE_LOSS" ? "danger" : "default"}
                onClick={submitRetirement}
                disabled={
                  saving ||
                  (retirement.type === "BALANCE_LOSS" &&
                    (!retirement.day ||
                      Number(retirement.balance) < 0 ||
                      Number(retirement.costRate) <= 0))
                }
              >
                <Archive className="h-4 w-4" />
                {saving ? "处理中…" : "确认弃用"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
