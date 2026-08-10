"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Input } from "@/components/ui/input";
import {
  Table,
  THead,
  TBody,
  HeadRow,
  TH,
  TR,
  TD,
} from "@/components/ui/table";
import { formatRmb } from "@/lib/utils";
import { ArrowLeft, ExternalLink, RefreshCw, Save, Users, WalletCards } from "lucide-react";

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
  isPrivate?: boolean;
}

interface Payload {
  site: {
    id: string;
    name: string;
    baseUrl: string;
    excludeUserIds: number[];
    privateUserIds: number[];
    lastRevenue: number | null;
    lastConsumed: number | null;
  };
  users: UserRow[];
  summary: {
    revenueUsd: number;
    excludedUsd: number;
    privateUsd: number;
    publicUsd: number;
    includedCount: number;
    excludedCount: number;
    privateCount: number;
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
  const [privateIds, setPrivateIds] = useState<Set<number>>(new Set());
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
      setPrivateIds(new Set<number>(json.data.site.privateUserIds || []));
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
    const empty = {
      revenueUsd: 0,
      excludedUsd: 0,
      privateUsd: 0,
      publicUsd: 0,
      includedCount: 0,
      excludedCount: 0,
      privateCount: 0,
    };
    if (!data) return empty;
    const out = { ...empty };
    for (const u of data.users) {
      const isAdmin = u.role >= 100;
      const isEx = isAdmin || excluded.has(u.id);
      if (isEx) {
        out.excludedUsd += u.issuedUsd;
        out.excludedCount++;
        continue;
      }
      out.revenueUsd += u.issuedUsd;
      out.includedCount++;
      // 私域是付费账号的子集；公共池 = 付费 − 私域
      if (privateIds.has(u.id)) {
        out.privateUsd += u.issuedUsd;
        out.privateCount++;
      } else {
        out.publicUsd += u.issuedUsd;
      }
    }
    return out;
  }, [data, excluded, privateIds]);

  function toggle(uid: number, locked: boolean) {
    if (locked) return;
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
    // 剔除优先：一个号被标成测试号就不该再算私域
    setPrivateIds((prev) => {
      if (!prev.has(uid) || excluded.has(uid)) return prev;
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
  }

  function togglePrivate(uid: number, locked: boolean) {
    if (locked) return;
    setPrivateIds((prev) => {
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

  function clearPrivate() {
    setPrivateIds(new Set());
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
          privateUserIds: Array.from(privateIds),
          resync: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      const sync = json.data?.sync;
      setMsg(
        sync?.success
          ? `已保存并重算收入：¥${Number(sync.revenue || 0).toFixed(2)}`
          : `已保存账号名单${sync?.error ? `（同步失败：${sync.error}）` : ""}`,
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
        <Spinner />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-coral/30 bg-coral/5 p-6 text-sm text-coral" role="alert">
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
        subtitle="剔除 = 测试号不算收入；私域 = 自己推广的用户，其余算公共池"
        showSync={false}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              其中私域
            </div>
            <div className="font-data text-2xl font-semibold text-cyan">
              {formatRmb(preview.privateUsd)}
            </div>
            <div className="text-xs text-muted">
              {preview.privateCount} 个账号 · 自己推广
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              其中公共池
            </div>
            <div className="font-data text-2xl font-semibold text-violet">
              {formatRmb(preview.publicUsd)}
            </div>
            <div className="text-xs text-muted">
              {preview.includedCount - preview.privateCount} 个账号 · 其他渠道
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
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={data.site.baseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开网站
        </a>
        <Link
          href={`/downstream/${id}/recharges`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <WalletCards className="h-3.5 w-3.5" />
          用户充值
        </Link>
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
        <Button size="sm" variant="ghost" onClick={clearPrivate}>
          清空私域标记
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
          <Input
            className="h-9 w-full max-w-xs"
            placeholder="搜索用户名 / 邮箱 / ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <HeadRow>
                <TH className="w-12">剔除</TH>
                <TH className="w-12">私域</TH>
                <TH>用户</TH>
                <TH>角色</TH>
                <TH className="text-right">已发放</TH>
                <TH className="text-right">已用</TH>
                <TH className="text-right">请求</TH>
              </HeadRow>
            </THead>
            <TBody>
              {filtered.map((u) => {
                const locked = u.role >= 100;
                const checked = locked || excluded.has(u.id);
                // 剔除掉的号谈不上私域，勾选框锁死
                const isPrivate = !checked && privateIds.has(u.id);
                return (
                  <TR
                    key={u.id}
                    tone={checked ? "warn" : isPrivate ? "info" : undefined}
                  >
                    <TD>
                      <Checkbox
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggle(u.id, locked)}
                        title={
                          locked
                            ? "超管默认不计入收入"
                            : checked
                              ? "取消剔除"
                              : "剔除出收入"
                        }
                      />
                    </TD>
                    <TD>
                      <Checkbox
                        checked={isPrivate}
                        disabled={checked}
                        onChange={() => togglePrivate(u.id, checked)}
                        title={
                          checked
                            ? "已剔除的账号不计私域"
                            : isPrivate
                              ? "取消私域标记"
                              : "标记为私域（自己推广）"
                        }
                      />
                    </TD>
                    <TD>
                      <div className="font-medium text-text">{u.username}</div>
                      <div className="text-[11px] text-muted font-data">
                        #{u.id}
                        {u.email ? ` · ${u.email}` : ""}
                      </div>
                    </TD>
                    <TD>
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
                    </TD>
                    <TD className="text-right font-data">
                      {formatRmb(u.issuedUsd)}
                    </TD>
                    <TD className="text-right font-data text-secondary">
                      {formatRmb(u.usedUsd)}
                    </TD>
                    <TD className="text-right font-data text-muted">
                      {u.request_count ?? 0}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
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
      <p className="text-[11px] text-muted max-w-2xl leading-relaxed">
        私域口径：先剔测试号，剩下的付费账号里勾了「私域」的算你自己推广的用户，
        其余（含朋友推广的）全进公共池。报表里私域 / 公共的成本按收入占比分摊 ——
        上游成本记在 Key 上，追不到具体是谁烧的，所以那两个毛利数是估算，总毛利仍是实测值。
      </p>
    </div>
  );
}
