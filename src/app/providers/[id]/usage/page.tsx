"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";
import {
  ArrowLeft,
  Archive,
  Database,
  Download,
  FileDown,
  Filter,
  RefreshCw,
} from "lucide-react";

interface UsageItem {
  id: string;
  remoteId: string;
  remoteKeyId: string | null;
  keyName: string | null;
  model: string | null;
  groupName: string | null;
  actualCost: number;
  standardCost: number;
  rateMultiplier: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestType: string | null;
  requestAt: string;
  day: string;
}

interface KeyOpt {
  remoteKeyId: string;
  name: string;
  countAsCost: boolean;
}

interface StatsPayload {
  discountRate: number;
  summary: {
    requests: number;
    actualCost: number;
    costRmb: number;
    totalTokens: number;
  };
  byKey: {
    remoteKeyId: string;
    keyName: string;
    requests: number;
    actualCost: number;
    costRmb: number;
    totalTokens: number;
    countAsCost: boolean;
  }[];
  byDay: {
    day: string;
    requests: number;
    actualCost: number;
    costRmb: number;
  }[];
  keys: KeyOpt[];
}

interface RetentionStatus {
  provider: { id: string; name: string; retiredAt: string | null };
  policy: { rawRetentionDays: number; detailRetentionDays: number };
  online: {
    detailRows: number;
    rawRows: number;
    rawDue: number;
    detailDue: number;
  };
  archived: {
    batches: number;
    rows: number;
    rawBytes: number;
    archiveBytes: number;
  };
  recentArchives: {
    id: string;
    rowCount: number;
    rawBytes: number;
    archiveBytes: number;
    firstRequestAt: string;
    lastRequestAt: string;
    createdAt: string;
  }[];
  scheduler: {
    state?: string;
    at?: string;
    message?: string;
  } | null;
}

function fmtDay(d = new Date(), offset = 0) {
  const x = new Date(d);
  x.setDate(x.getDate() + offset);
  return x.toISOString().slice(0, 10);
}

function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export default function UsagePage() {
  const params = useParams();
  const id = String(params.id || "");

  const [startDate, setStartDate] = useState(fmtDay(new Date(), -7));
  const [endDate, setEndDate] = useState(fmtDay(new Date(), 0));
  const [remoteKeyId, setRemoteKeyId] = useState("");
  const [onlyBillable, setOnlyBillable] = useState(true);
  const [page, setPage] = useState(1);

  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [logs, setLogs] = useState<UsageItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize] = useState(50);

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [maintaining, setMaintaining] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("上游");
  const [providerRetired, setProviderRetired] = useState(false);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        view: "stats",
        startDate,
        endDate,
        onlyBillable: onlyBillable ? "1" : "0",
      });
      const lq = new URLSearchParams({
        view: "logs",
        startDate,
        endDate,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (remoteKeyId) lq.set("remoteKeyId", remoteKeyId);

      const [sRes, lRes, pRes, rRes] = await Promise.all([
        fetch(`/api/upstream/${id}/usage?${q}`),
        fetch(`/api/upstream/${id}/usage?${lq}`),
        fetch("/api/providers"),
        fetch(`/api/upstream/${id}/usage/retention`),
      ]);
      const sJson = await sRes.json();
      const lJson = await lRes.json();
      const pJson = await pRes.json();
      const rJson = await rRes.json();
      if (!sRes.ok) throw new Error(sJson.error || "统计加载失败");
      if (!lRes.ok) throw new Error(lJson.error || "明细加载失败");
      if (!rRes.ok) throw new Error(rJson.error || "存储状态加载失败");

      setStats(sJson.data);
      setLogs(lJson.data.items || []);
      setTotal(lJson.data.total || 0);
      setRetention(rJson.data);
      const p = (pJson.data || []).find(
        (x: { id: string; retiredAt?: string | null }) => x.id === id,
      );
      if (p) {
        setProviderName(p.name);
        setProviderRetired(!!p.retiredAt);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [id, startDate, endDate, remoteKeyId, onlyBillable, page, pageSize]);

  useEffect(() => {
    if (id) void Promise.resolve().then(load);
  }, [id, load]);

  async function pullRemote() {
    setSyncing(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/upstream/${id}/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          apiKeyId: remoteKeyId || undefined,
          maxPages: 100,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "同步失败");
      const s = json.data.sync;
      setMsg(
        `已同步 ${s.fetched} 条（新增 ${s.inserted} / 更新 ${s.updated}），重建 ${s.daysRebuilt} 天聚合`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  async function runMaintenance() {
    setMaintaining(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/upstream/${id}/usage/retention`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "维护失败");
      const result = json.data.result;
      setRetention(json.data.status);
      setMsg(
        `维护完成：归档 ${result.rowsArchived} 条，清理 ${result.detailRowsDeleted} 条在线明细`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "维护失败");
    } finally {
      setMaintaining(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  const keyOptions = useMemo(() => {
    const fromStats = stats?.keys || [];
    if (fromStats.length) return fromStats;
    return (stats?.byKey || []).map((k) => ({
      remoteKeyId: k.remoteKeyId,
      name: k.keyName || k.remoteKeyId,
      countAsCost: k.countAsCost,
    }));
  }, [stats]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm">
        <Link
          href={`/providers/${id}`}
          className="inline-flex items-center gap-1 text-secondary hover:text-cyan"
        >
          <ArrowLeft className="h-4 w-4" />
          密钥/分组
        </Link>
        <span className="text-muted">/</span>
        <span className="text-text">使用记录</span>
      </div>

      <TopBar
        title={`${providerName} · 使用记录库`}
        subtitle="从 EasyTokens /usage 增量同步到本地，按 Key / 日期筛选统计"
        showSync={false}
      />

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <Label>开始</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setPage(1);
                setStartDate(e.target.value);
              }}
              className="w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label>结束</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => {
                setPage(1);
                setEndDate(e.target.value);
              }}
              className="w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label>API Key</Label>
            <Select
              value={remoteKeyId}
              onChange={(e) => {
                setPage(1);
                setRemoteKeyId(e.target.value);
              }}
              className="w-[200px]"
            >
              <option value="">全部 Key</option>
              {keyOptions.map((k) => (
                <option key={k.remoteKeyId} value={k.remoteKeyId}>
                  {k.name || k.remoteKeyId}
                  {k.countAsCost ? " · 中转" : ""}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-secondary pb-2">
            <input
              type="checkbox"
              checked={onlyBillable}
              onChange={(e) => setOnlyBillable(e.target.checked)}
              className="rounded border-border"
            />
            统计仅中转 Key
          </label>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            <Filter className="h-3.5 w-3.5" />
            查询本地
          </Button>
          <Button
            size="sm"
            onClick={pullRemote}
            disabled={syncing || providerRetired}
            title={providerRetired ? "已弃用上游不再访问远端" : undefined}
          >
            <Download className={cn("h-3.5 w-3.5", syncing && "animate-pulse")} />
            {providerRetired ? "已停止同步" : syncing ? "同步中…" : "从远端同步"}
          </Button>
          {msg && <span className="text-xs text-mint font-data">{msg}</span>}
          {error && <span className="text-xs text-coral">{error}</span>}
        </CardContent>
      </Card>

      {/* Stats cards */}
      {stats && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] text-muted uppercase tracking-wider">
                请求数
              </div>
              <div className="font-data text-2xl font-semibold">
                {stats.summary.requests.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] text-muted uppercase tracking-wider">
                实际扣费面值
              </div>
              <div className="font-data text-2xl font-semibold">
                {stats.summary.actualCost.toFixed(4)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] text-muted uppercase tracking-wider">
                业务成本（人民币）
              </div>
              <div className="font-data text-2xl font-semibold text-amber">
                {formatRmb(stats.summary.costRmb)}
              </div>
              <div className="text-[11px] text-muted">
                × 购入成本 {stats.discountRate}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] text-muted uppercase tracking-wider">
                Tokens
              </div>
              <div className="font-data text-2xl font-semibold">
                {(stats.summary.totalTokens / 1e6).toFixed(2)}M
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* By key */}
      {stats && stats.byKey.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal flex items-center gap-2">
              <Database className="h-4 w-4 text-cyan" />
              按 Key 汇总
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2">Key</th>
                  <th className="px-4 py-2">归因</th>
                  <th className="px-4 py-2 text-right">请求</th>
                  <th className="px-4 py-2 text-right">实际扣费</th>
                  <th className="px-4 py-2 text-right">业务成本</th>
                  <th className="px-4 py-2 text-right">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {stats.byKey.map((k) => (
                  <tr
                    key={k.remoteKeyId}
                    className="border-b border-border-subtle/60"
                  >
                    <td className="px-4 py-2">
                      <div className="font-medium">{k.keyName || k.remoteKeyId}</div>
                      <div className="text-[11px] text-muted font-data">
                        #{k.remoteKeyId}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={k.countAsCost ? "mint" : "default"}>
                        {k.countAsCost ? "中转" : "不计入"}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right font-data">
                      {k.requests}
                    </td>
                    <td className="px-4 py-2 text-right font-data">
                      {k.actualCost.toFixed(4)}
                    </td>
                    <td className="px-4 py-2 text-right font-data text-amber">
                      {formatRmb(k.costRmb)}
                    </td>
                    <td className="px-4 py-2 text-right font-data text-muted">
                      {(k.totalTokens / 1e3).toFixed(1)}k
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Detail logs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal">
            明细（本地库 {total} 条）
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted">
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="font-data">
              {page} / {pages}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="py-12 text-center text-sm text-muted">加载中…</div>
          ) : logs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted space-y-2">
              <p>本地暂无记录</p>
              <p className="text-xs">
                {providerRetired
                  ? "该区间没有在线明细，可在下方下载历史归档"
                  : "选择日期后点「从远端同步」拉取 EasyTokens 使用记录"}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2">时间</th>
                  <th className="px-4 py-2">Key</th>
                  <th className="px-4 py-2">模型</th>
                  <th className="px-4 py-2">分组</th>
                  <th className="px-4 py-2 text-right">实际扣费</th>
                  <th className="px-4 py-2 text-right">倍率</th>
                  <th className="px-4 py-2 text-right">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-border-subtle/50 hover:bg-surface-2/40"
                  >
                    <td className="px-4 py-2 font-data text-xs text-secondary whitespace-nowrap">
                      {new Date(r.requestAt).toLocaleString("zh-CN")}
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-xs">{r.keyName || "—"}</div>
                      <div className="text-[10px] text-muted font-data">
                        {r.remoteKeyId}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs font-data">{r.model || "—"}</td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {r.groupName || "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-data text-xs">
                      {r.actualCost.toFixed(5)}
                    </td>
                    <td className="px-4 py-2 text-right font-data text-xs text-muted">
                      {r.rateMultiplier != null ? `${r.rateMultiplier}x` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-data text-xs text-muted">
                      {r.totalTokens.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {retention && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm font-semibold normal-case tracking-normal text-text">
                <Archive className="h-4 w-4 text-cyan" />
                存储维护
              </CardTitle>
              <p className="mt-1 text-[11px] text-muted">
                原始 JSON {retention.policy.rawRetentionDays} 天 · 在线明细{" "}
                {retention.policy.detailRetentionDays} 天 · 日汇总长期保留
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={runMaintenance}
              disabled={maintaining}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", maintaining && "animate-spin")}
              />
              {maintaining ? "维护中…" : "立即维护"}
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid border-y border-border-subtle sm:grid-cols-2 lg:grid-cols-4">
              <div className="border-b border-border-subtle px-4 py-3 sm:border-r lg:border-b-0">
                <div className="text-[10px] uppercase text-muted">在线明细</div>
                <div className="mt-1 font-data text-lg font-semibold">
                  {retention.online.detailRows.toLocaleString()}
                </div>
              </div>
              <div className="border-b border-border-subtle px-4 py-3 lg:border-b-0 lg:border-r">
                <div className="text-[10px] uppercase text-muted">含原始 JSON</div>
                <div className="mt-1 font-data text-lg font-semibold">
                  {retention.online.rawRows.toLocaleString()}
                </div>
              </div>
              <div className="border-b border-border-subtle px-4 py-3 sm:border-r sm:border-b-0">
                <div className="text-[10px] uppercase text-muted">待维护</div>
                <div className="mt-1 font-data text-lg font-semibold text-amber">
                  {(retention.online.rawDue + retention.online.detailDue).toLocaleString()}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-[10px] uppercase text-muted">归档</div>
                <div className="mt-1 font-data text-lg font-semibold">
                  {retention.archived.batches} 批
                </div>
                <div className="text-[10px] text-muted">
                  {fmtBytes(retention.archived.rawBytes)} →{" "}
                  {fmtBytes(retention.archived.archiveBytes)}
                </div>
              </div>
            </div>

            {retention.recentArchives.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-subtle text-left text-[10px] uppercase text-muted">
                      <th className="px-4 py-2">期间</th>
                      <th className="px-4 py-2 text-right">记录</th>
                      <th className="px-4 py-2 text-right">压缩后</th>
                      <th className="w-14 px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {retention.recentArchives.map((archive) => (
                      <tr
                        key={archive.id}
                        className="border-b border-border-subtle/60 last:border-0"
                      >
                        <td className="px-4 py-2 font-data text-secondary">
                          {new Date(archive.firstRequestAt).toLocaleDateString("zh-CN")}
                          {archive.firstRequestAt !== archive.lastRequestAt
                            ? ` - ${new Date(archive.lastRequestAt).toLocaleDateString("zh-CN")}`
                            : ""}
                        </td>
                        <td className="px-4 py-2 text-right font-data">
                          {archive.rowCount.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right font-data text-muted">
                          {fmtBytes(archive.archiveBytes)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <a
                            href={`/api/upstream/${id}/usage/archives/${archive.id}`}
                            className={buttonVariants({
                              variant: "ghost",
                              size: "icon",
                              className: "h-8 w-8",
                            })}
                            aria-label="下载归档"
                            title="下载 gzip 归档"
                          >
                            <FileDown className="h-4 w-4" />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted max-w-3xl leading-relaxed">
        数据来自 EasyTokens <code className="font-data text-cyan">GET /api/v1/usage</code>
        ，按 <code className="font-data">remoteId</code> 去重写入本地数据库。
        勾选「计入中转」的 Key 才会把实际扣费 × 购入成本计入业务成本。
        可反复同步同一时间段做增量更新。
      </p>
    </div>
  );
}
