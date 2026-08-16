"use client";

import { FormEvent, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox, Input, Label, Select, Textarea } from "@/components/ui/input";
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
  Database,
  Unplug,
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
  dbBound?: boolean;
  dbDsnMasked?: string | null;
  dbHost?: string | null;
  dbName?: string | null;
  dbLastTestAt?: string | null;
  dbLastTestOk?: boolean | null;
  dbLastTestError?: string | null;
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
  dbDsn: "",
  /** When editing: user clicked 清除绑定 */
  clearDb: false,
};

export default function DownstreamPage() {
  const [list, setList] = useState<Site[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBound, setEditingBound] = useState(false);
  const [editingMasked, setEditingMasked] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
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
    setEditingBound(false);
    setEditingMasked(null);
    setForm(emptyForm);
    setError(null);
    setTestMsg(null);
    setShowForm(true);
  }

  function startEdit(s: Site) {
    setEditingId(s.id);
    setEditingBound(Boolean(s.dbBound));
    setEditingMasked(s.dbDsnMasked || null);
    setForm({
      name: s.name,
      baseUrl: s.baseUrl,
      adminKey: "",
      adminUserId: s.adminUserId ?? 1,
      quotaPerDollar: s.quotaPerDollar ?? 500000,
      revenueCurrency: s.revenueCurrency === "USD" ? "USD" : "CNY",
      enabled: s.enabled,
      notes: s.notes || "",
      dbDsn: "",
      clearDb: false,
    });
    setError(null);
    setTestMsg(null);
    setShowForm(true);
  }

  function resetForm() {
    setEditingId(null);
    setEditingBound(false);
    setEditingMasked(null);
    setForm(emptyForm);
    setError(null);
    setTestMsg(null);
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
        if (form.clearDb) {
          payload.dbDsn = "";
        } else if (form.dbDsn.trim()) {
          payload.dbDsn = form.dbDsn.trim();
        }
        // omit dbDsn → keep existing binding
        const res = await fetch("/api/downstream", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "更新失败");
      } else {
        if (!form.adminKey.trim()) throw new Error("请填写访问令牌");
        const payload: Record<string, unknown> = {
          name: form.name,
          baseUrl: form.baseUrl,
          adminKey: form.adminKey.trim(),
          adminUserId: Number(form.adminUserId) || 1,
          quotaPerDollar: Number(form.quotaPerDollar) || 500000,
          revenueCurrency: form.revenueCurrency,
          enabled: form.enabled,
          notes: form.notes || null,
        };
        if (form.dbDsn.trim()) payload.dbDsn = form.dbDsn.trim();
        const res = await fetch("/api/downstream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

  async function testDbConnection() {
    setTesting(true);
    setTestMsg(null);
    setError(null);
    try {
      const paste = form.dbDsn.trim();

      let res: Response;
      if (paste) {
        // Prefer paste (create form or overwrite-before-save)
        const url = editingId
          ? `/api/downstream/${editingId}/db/test`
          : "/api/downstream/db/test";
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dbDsn: paste }),
        });
      } else if (editingId && editingBound && !form.clearDb) {
        res = await fetch(`/api/downstream/${editingId}/db/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } else {
        throw new Error("请先填写 DSN");
      }

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "测连失败");
      if (!json.success) {
        setTestMsg(null);
        throw new Error(json.error || "连接失败");
      }
      const d = json.data || {};
      setTestMsg(
        `连接成功 · ${d.host || "?"}/${d.database || "?"} · ${d.latencyMs ?? "?"}ms` +
          (d.persisted ? "" : "（未写入状态；保存绑定后再测可记录结果）"),
      );
      if (d.persisted) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "测连失败");
    } finally {
      setTesting(false);
    }
  }

  async function testSavedOnCard(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/downstream/${id}/db/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json().catch(() => ({}));
      // Always refresh so dbLastTest* badges update on soft failures (HTTP 200 + success:false)
      await load();
      if (!res.ok) throw new Error(json.error || "测连失败");
      if (!json.success) throw new Error(json.error || "连接失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "测连失败");
    } finally {
      setBusyId(null);
    }
  }

  function formatRevenue(s: Site) {
    if (s.lastRevenue == null) return "—";
    return formatRmb(s.lastRevenue);
  }

  function dbBadge(s: Site) {
    if (!s.dbBound) return null;
    if (s.dbLastTestOk === false) {
      return (
        <Badge variant="amber" title={s.dbLastTestError || "测连失败"}>
          数据库·异常
        </Badge>
      );
    }
    return (
      <Badge variant="mint" title={s.dbDsnMasked || undefined}>
        数据库·已绑定
      </Badge>
    );
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

      {error && !showForm && (
        <p className="text-xs text-coral" role="alert">
          {error}
        </p>
      )}

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

              {/* NewAPI database binding */}
              <div className="space-y-2 sm:col-span-2 lg:col-span-3 rounded-lg border border-border/60 bg-surface-2/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Database className="h-3.5 w-3.5 text-cyan" />
                  <Label htmlFor="dbDsn" className="!mb-0">
                    NewAPI 数据库 DSN
                    <span className="ml-1 font-normal text-muted">（可选）</span>
                  </Label>
                  {editingBound && !form.clearDb && (
                    <Badge variant="mint">已绑定</Badge>
                  )}
                  {form.clearDb && (
                    <Badge variant="amber">将在保存后解除绑定</Badge>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  与 NewAPI 的{" "}
                  <code className="text-secondary">SQL_DSN</code>{" "}
                  相同，例如{" "}
                  <code className="text-secondary">
                    user:pass@tcp(host:3306)/dbname
                  </code>
                  。建议只读账号；跨公网请在 DSN 加{" "}
                  <code className="text-secondary">?tls=true</code>
                  。本期仅保存与测连（同步仍走 API）；除 TLS 外多数 query
                  参数测连时忽略。
                </p>
                {editingBound && editingMasked && !form.clearDb && !form.dbDsn && (
                  <p className="text-xs font-data text-secondary">
                    当前：{editingMasked}
                  </p>
                )}
                <Input
                  id="dbDsn"
                  type="password"
                  autoComplete="off"
                  value={form.dbDsn}
                  disabled={form.clearDb}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      dbDsn: e.target.value,
                      clearDb: false,
                    })
                  }
                  placeholder={
                    editingBound && !form.clearDb
                      ? "留空=不改；填写新 DSN 覆盖"
                      : "user:pass@tcp(host:3306)/dbname"
                  }
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={testing || form.clearDb}
                    onClick={() => void testDbConnection()}
                  >
                    <Database
                      className={`h-3.5 w-3.5 ${testing ? "animate-pulse" : ""}`}
                    />
                    {testing ? "测试中…" : "测试连接"}
                  </Button>
                  {editingId && editingBound && !form.clearDb && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setForm({ ...form, clearDb: true, dbDsn: "" })
                      }
                    >
                      <Unplug className="h-3.5 w-3.5" />
                      清除绑定
                    </Button>
                  )}
                  {form.clearDb && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setForm({ ...form, clearDb: false })}
                    >
                      撤销清除
                    </Button>
                  )}
                </div>
                {testMsg && (
                  <p className="text-xs text-mint">{testMsg}</p>
                )}
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
                <Checkbox
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                />
                启用同步
              </label>
              {error && (
                <p className="text-xs text-coral sm:col-span-2 lg:col-span-3">
                  {error}
                </p>
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
                "transition-all duration-200 hover:shadow-lg",
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
                    {dbBadge(s)}
                    {(s.excludeCount ?? 0) > 0 && (
                      <Badge variant="amber">
                        剔除 {s.excludeCount} 号
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted">{s.baseUrl}</p>
                  {s.dbBound && (s.dbHost || s.dbName) && (
                    <p className="truncate text-xs font-data text-secondary">
                      DB {s.dbHost || "?"}
                      {s.dbName ? ` / ${s.dbName}` : ""}
                      {s.dbLastTestAt
                        ? ` · 测连 ${new Date(s.dbLastTestAt).toLocaleString("zh-CN")}`
                        : " · 尚未测连"}
                      {s.dbLastTestOk === false && s.dbLastTestError ? (
                        <span className="text-coral"> · {s.dbLastTestError}</span>
                      ) : null}
                    </p>
                  )}
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
                  {s.dbBound && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === s.id}
                      title="测试已绑定数据库"
                      onClick={() => void testSavedOnCard(s.id)}
                    >
                      <Database className="h-3.5 w-3.5" />
                      测库
                    </Button>
                  )}
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
