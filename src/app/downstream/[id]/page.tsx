"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatRmb, cn } from "@/lib/utils";
import { ArrowLeft, ExternalLink, RefreshCw, Save, Users } from "lucide-react";

interface UserRow {
  id: number;
  username: string;
  display_name?: string;
  role: number;
  status?: number;
  email?: string;
  quota: number;
  used_quota: number;
  issuedUsd: number;
  usedUsd: number;
  request_count?: number;
  excluded?: boolean;
}

interface Payload {
  site: {
    id: string;
    name: string;
    baseUrl: string;
    excludeUserIds: number[];
    lastRevenue: number | null;
    lastConsumed: number | null;
  };
  users: UserRow[];
  summary: {
    revenueUsd: number;
    excludedUsd: number;
    includedCount: number;
    excludedCount: number;
  };
}

function roleLabel(role: number) {
  if (role >= 100) return "超管";
  if (role >= 10) return "管理";
  return "用户";
}

export default function DownstreamUsersPage() {
  const params = useParams();
  const id = String(params.id || "");

  const [data, setData] = useState<Payload | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/downstream/${id}/users`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setData(json.data);
      // Pre-check: saved exclusions + auto role>=100 stay checked but role>=100 locked
      const set = new Set<number>(json.data.site.excludeUserIds || []);
      setExcluded(set);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void Promise.resolve().then(load);
  }, [id, load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const kw = q.trim().toLowerCase();
    if (!kw) return data.users;
    return data.users.filter(
      (u) =>
        u.username.toLowerCase().includes(kw) ||
        (u.display_name || "").toLowerCase().includes(kw) ||
        (u.email || "").toLowerCase().includes(kw) ||
        String(u.id).includes(kw),
    );
  }, [data, q]);

  const preview = useMemo(() => {
    if (!data) return { revenueUsd: 0, excludedUsd: 0, includedCount: 0, excludedCount: 0 };
    let revenueUsd = 0;
    let excludedUsd = 0;
    let includedCount = 0;
    let excludedCount = 0;
    for (const u of data.users) {
      const isAdmin = u.role >= 100;
      const isEx = isAdmin || excluded.has(u.id);
      if (isEx) {
        excludedUsd += u.issuedUsd;
        excludedCount++;
      } else {
        revenueUsd += u.issuedUsd;
        includedCount++;
      }
    }
    return { revenueUsd, excludedUsd, includedCount, excludedCount };
  }, [data, excluded]);

  function toggle(uid: number, locked: boolean) {
    if (locked) return;
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function excludeZero() {
    if (!data) return;
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const u of data.users) {
        if (u.role < 100 && u.issuedUsd <= 0) next.add(u.id);
      }
      return next;
    });
  }

  function clearManual() {
    // keep only nothing — admins still auto-excluded in calc
    setExcluded(new Set());
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/downstream/${id}/users`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          excludeUserIds: Array.from(excluded),
          resync: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      const sync = json.data?.sync;
      setMsg(
        sync?.success
          ? `已保存并重算收入：¥${Number(sync.revenue || 0).toFixed(2)}`
          : `已保存排除列表${sync?.error ? `（同步失败：${sync.error}）` : ""}`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-cyan" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-coral/30 bg-coral/5 p-6 text-sm text-coral">
        {error || "无数据"}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/downstream"
          className="inline-flex items-center gap-1 text-secondary hover:text-cyan"
        >
          <ArrowLeft className="h-4 w-4" />
          下游站点
        </Link>
        <span className="text-muted">/</span>
        <span className="text-text">{data.site.name}</span>
      </div>

      <TopBar
        title={`${data.site.name} · 收入账号`}
        subtitle="勾选要剔除的测试账号；超管(role≥100)默认不计入收入"
        showSync={false}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              计入收入
            </div>
            <div className="font-data text-2xl font-semibold text-mint">
              {formatRmb(preview.revenueUsd)}
            </div>
            <div className="text-xs text-muted">
              {preview.includedCount} 个账号 · 人民币 1:1
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              已剔除
            </div>
            <div className="font-data text-2xl font-semibold text-amber">
              {formatRmb(preview.excludedUsd)}
            </div>
            <div className="text-xs text-muted">
              {preview.excludedCount} 个账号
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              上次同步收入
            </div>
            <div className="font-data text-2xl font-semibold text-text">
              {formatRmb(data.site.lastRevenue)}
            </div>
            <div className="text-xs text-muted">
              消耗 {formatRmb(data.site.lastConsumed)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={data.site.baseUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button size="sm" variant="outline">
            <ExternalLink className="h-3.5 w-3.5" />
            打开网站
          </Button>
        </a>
        <Button size="sm" variant="secondary" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
          刷新用户
        </Button>
        <Button size="sm" variant="secondary" onClick={excludeZero}>
          剔除 0 额度号
        </Button>
        <Button size="sm" variant="ghost" onClick={clearManual}>
          清空手动剔除
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          <Save className="h-3.5 w-3.5" />
          {saving ? "保存并重算…" : "保存并重算收入"}
        </Button>
        {msg && <span className="text-xs text-mint font-data">{msg}</span>}
        {error && <span className="text-xs text-coral">{error}</span>}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
            <Users className="h-4 w-4 text-cyan" />
            用户列表
          </CardTitle>
          <input
            className="h-8 w-full max-w-xs rounded-lg border border-border bg-surface-2 px-3 text-sm text-text placeholder:text-muted"
            placeholder="搜索用户名 / 邮箱 / ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2 w-12">剔除</th>
                <th className="px-4 py-2">用户</th>
                <th className="px-4 py-2">角色</th>
                <th className="px-4 py-2 text-right">已发放</th>
                <th className="px-4 py-2 text-right">已用</th>
                <th className="px-4 py-2 text-right">请求</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => {
                const locked = u.role >= 100;
                const checked = locked || excluded.has(u.id);
                return (
                  <tr
                    key={u.id}
                    className={cn(
                      "border-b border-border-subtle/60 hover:bg-surface-2/50",
                      checked && "bg-amber/[0.04]",
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggle(u.id, locked)}
                        className="rounded border-border"
                        title={
                          locked
                            ? "超管默认不计入收入"
                            : checked
                              ? "取消剔除"
                              : "剔除出收入"
                        }
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-text">{u.username}</div>
                      <div className="text-[11px] text-muted font-data">
                        #{u.id}
                        {u.email ? ` · ${u.email}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          u.role >= 100
                            ? "coral"
                            : u.role >= 10
                              ? "violet"
                              : "default"
                        }
                      >
                        {roleLabel(u.role)}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right font-data">
                      {formatRmb(u.issuedUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-data text-secondary">
                      {formatRmb(u.usedUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-data text-muted">
                      {u.request_count ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="py-10 text-center text-sm text-muted">无匹配用户</div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted max-w-2xl leading-relaxed">
        收入口径（人民币 1:1）：非剔除用户的{" "}
        <code className="font-data text-cyan">(剩余额度 + 已用额度)</code>{" "}
        面值直接计为元。超管账号始终排除。保存后会立即重新同步下游快照。
      </p>
    </div>
  );
}
