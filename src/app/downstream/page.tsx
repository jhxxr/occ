"use client";

import { FormEvent, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatRmb, cn } from "@/lib/utils";
import Link from "next/link";
import {
  Pencil,
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  Users,
  X,
} from "lucide-react";

interface Site {
  id: string;
  name: string;
  baseUrl: string;
  adminKey: string;
  adminUserId?: number;
  quotaPerDollar?: number;
  revenueCurrency?: string;
  excludeCount?: number;
  enabled: boolean;
  notes: string | null;
  lastConsumed: number | null;
  lastRevenue: number | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

const emptyForm = {
  name: "",
  baseUrl: "",
  adminKey: "",
  adminUserId: 1,
  quotaPerDollar: 500000,
  revenueCurrency: "CNY",
  enabled: true,
  notes: "",
};

export default function DownstreamPage() {
  const [list, setList] = useState<Site[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/downstream");
    const json = await res.json();
    setList(json.data || []);
  }

  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setShowForm(true);
  }

  function startEdit(s: Site) {
    setEditingId(s.id);
    setForm({
      name: s.name,
      baseUrl: s.baseUrl,
      adminKey: "",
      adminUserId: s.adminUserId ?? 1,
      quotaPerDollar: s.quotaPerDollar ?? 500000,
      revenueCurrency: s.revenueCurrency === "USD" ? "USD" : "CNY",
      enabled: s.enabled,
      notes: s.notes || "",
    });
    setError(null);
    setShowForm(true);
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setShowForm(false);
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
          enabled: form.enabled,
          notes: form.notes || null,
          adminUserId: Number(form.adminUserId) || 1,
          quotaPerDollar: Number(form.quotaPerDollar) || 500000,
          revenueCurrency: form.revenueCurrency,
        };
        if (form.adminKey.trim()) payload.adminKey = form.adminKey.trim();
        const res = await fetch("/api/downstream", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "更新失败");
      } else {
        if (!form.adminKey.trim()) throw new Error("请填写访问令牌");
        const res = await fetch("/api/downstream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            adminUserId: Number(form.adminUserId) || 1,
            quotaPerDollar: Number(form.quotaPerDollar) || 500000,
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
    if (!confirm("确认删除该下游站点？")) return;
    await fetch(`/api/downstream?id=${id}`, { method: "DELETE" });
    await load();
  }

  async function syncOne(id: string) {
    setBusyId(id);
    try {
      await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "downstream", id }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  function formatRevenue(s: Site) {
    if (s.lastRevenue == null) return "—";
    // 已按站点币种落库；USD 模式在展示时不再乘汇率（同步层已处理成可对比口径时）
    // 这里统一人民币符号展示数值
    return formatRmb(s.lastRevenue);
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="下游自营站"
        subtitle="默认按人民币 1:1 核算收入 · 可剔除测试账号"
        showSync={false}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {list.length === 0
            ? "尚未绑定自营 NewAPI"
            : `${list.length} 个站点`}
        </p>
        {!showForm && (
          <Button size="sm" variant="secondary" onClick={startCreate}>
            <Plus className="h-3.5 w-3.5" />
            添加站点
          </Button>
        )}
      </div>

      {/* Compact create / edit drawer */}
      {showForm && (
        <Card className="border-cyan/25">
          <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
            <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal">
              {editingId ? "编辑站点" : "添加下游站点"}
            </CardTitle>
            <Button size="icon" variant="ghost" onClick={resetForm} aria-label="关闭">
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0">
            <form
              onSubmit={onSubmit}
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              <div className="space-y-1">
                <Label htmlFor="name">名称</Label>
                <Input
                  id="name"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="OrbitAI 自营站"
                />
              </div>
              <div className="space-y-1">
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
              <div className="space-y-1">
                <Label htmlFor="adminKey">
                  访问令牌
                  {editingId && (
                    <span className="ml-1 text-muted">（空=不改）</span>
                  )}
                </Label>
                <Input
                  id="adminKey"
                  type="password"
                  autoComplete="off"
                  value={form.adminKey}
                  onChange={(e) =>
                    setForm({ ...form, adminKey: e.target.value })
                  }
                  placeholder={editingId ? "••••••••" : "系统访问令牌"}
                  required={!editingId}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="revenueCurrency">收入币种</Label>
                <Select
                  id="revenueCurrency"
                  value={form.revenueCurrency}
                  onChange={(e) =>
                    setForm({ ...form, revenueCurrency: e.target.value })
                  }
                >
                  <option value="CNY">人民币 1:1（推荐）</option>
                  <option value="USD">按面值再×市场汇率</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adminUserId">用户 ID</Label>
                <Input
                  id="adminUserId"
                  type="number"
                  min={1}
                  value={form.adminUserId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      adminUserId: Number(e.target.value) || 1,
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="quotaPerDollar">Quota / 面值单位</Label>
                <Input
                  id="quotaPerDollar"
                  type="number"
                  min={1}
                  value={form.quotaPerDollar}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      quotaPerDollar: Number(e.target.value) || 500000,
                    })
                  }
                />
              </div>
              <div className="space-y-1 sm:col-span-2 lg:col-span-3">
                <Label htmlFor="notes">备注</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="min-h-[56px]"
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
              {error && (
                <p className="text-xs text-coral sm:col-span-2">{error}</p>
              )}
              <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "保存中…" : editingId ? "保存" : "添加"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={resetForm}
                >
                  取消
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Site cards — primary workspace */}
      {list.length === 0 && !showForm ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted">还没有下游站点</p>
            <Button size="sm" onClick={startCreate}>
              <Plus className="h-3.5 w-3.5" />
              添加自营 NewAPI
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((s) => (
            <Card
              key={s.id}
              className={cn(
                "transition-[border-color,box-shadow] hover:border-border hover:shadow-sm",
                !s.enabled && "border-dashed bg-surface-2",
              )}
            >
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
                <div className="min-w-0 space-y-2 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-text">{s.name}</h3>
                    <Badge variant={s.enabled ? "mint" : "default"}>
                      {s.enabled ? "启用" : "停用"}
                    </Badge>
                    <Badge variant="cyan">
                      {s.revenueCurrency === "USD"
                        ? "收入·面值×汇率"
                        : "收入·人民币1:1"}
                    </Badge>
                    {(s.excludeCount ?? 0) > 0 && (
                      <Badge variant="amber">
                        剔除 {s.excludeCount} 号
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted">{s.baseUrl}</p>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <div>
                      <div className="text-xs text-muted">近窗消耗</div>
                      <div className="font-data text-text">
                        {formatRmb(s.lastConsumed)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">核算收入</div>
                      <div className="font-data text-mint text-lg">
                        {formatRevenue(s)}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted font-data">
                    {s.lastSyncAt
                      ? `同步于 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`
                      : "尚未同步"}
                    {s.lastError ? (
                      <span className="text-coral"> · {s.lastError}</span>
                    ) : null}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <a
                    href={s.baseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="打开网站"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    打开
                  </a>
                  <Link
                    href={`/downstream/${s.id}`}
                    title="剔除测试账号"
                    className={buttonVariants({ variant: "default", size: "sm" })}
                  >
                    <Users className="h-3.5 w-3.5" />
                    收入账号
                  </Link>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === s.id}
                    onClick={() => syncOne(s.id)}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${busyId === s.id ? "animate-spin" : ""}`}
                    />
                    同步
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => startEdit(s)}
                    aria-label="编辑"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
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
