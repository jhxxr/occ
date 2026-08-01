"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox, Input, Label } from "@/components/ui/input";
import { CostLedger } from "@/components/self-hosted/cost-ledger";
import {
  Table,
  THead,
  TBody,
  HeadRow,
  TH,
  TR,
  TD,
} from "@/components/ui/table";
import { formatRmb, cn } from "@/lib/utils";
import {
  ArrowLeft,
  RefreshCw,
  Download,
  ExternalLink,
} from "lucide-react";

interface GroupRow {
  id: string;
  remoteGroupId: number;
  name: string;
  platform: string;
  sellRate: number;
  track: boolean;
  status: string;
  lastOfficialCost: number;
  todayOfficialCost: number;
  lastRequests: number;
  todayRequests: number;
  notes: string | null;
}

interface AccountRow {
  id: string;
  remoteAccountId: number;
  name: string;
  platform: string;
  accountType: string;
  status: string;
  purchaseCostRmb: number;
  track: boolean;
  groupIds: string;
  groupNames: string;
  notes: string | null;
  lastUsedAt: string | null;
}

interface Overview {
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    lastSyncAt: string | null;
    lastError: string | null;
    lastConsumed: number | null;
  };
  groups: GroupRow[];
  accounts: AccountRow[];
  summary: {
    trackedGroups: number;
    trackedAccounts: number;
    monthOfficialCost: number;
    monthSellRevenueRmb: number;
    monthRequests: number;
    accountPurchaseRmb: number;
    /** 成本台账在本月实际入账/摊销的金额 */
    operatingCostRmb: number;
  };
}

export default function SelfHostedDetailPage() {
  const params = useParams();
  const id = String(params.id || "");

  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  // inline editors
  const [editSell, setEditSell] = useState<Record<string, string>>({});
  const [editCost, setEditCost] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/self-hosted/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setData(json.data);
      const sell: Record<string, string> = {};
      const cost: Record<string, string> = {};
      for (const g of json.data.groups) sell[g.id] = String(g.sellRate);
      for (const a of json.data.accounts) cost[a.id] = String(a.purchaseCostRmb);
      setEditSell(sell);
      setEditCost(cost);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void Promise.resolve().then(load);
  }, [id, load]);

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/self-hosted/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "操作失败");
      if (json.data.overview) setData(json.data.overview);
      else if (json.data.groups) setData(json.data);
      else await load();
      return json.data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function syncMeta() {
    const r = await post("sync-meta");
    if (r?.meta) {
      setMsg(`元数据同步：${r.meta.groups} 分组 / ${r.meta.accounts} 账号`);
    }
  }

  async function syncUsage() {
    const r = await post("sync-usage", { days });
    if (r?.usage) {
      setMsg(
        `用量同步：${r.usage.groups} 个追踪分组，拉取 ${r.usage.fetched} 条记录`,
      );
    }
  }

  async function toggleGroupTrack(g: GroupRow) {
    // 乐观更新
    setData((d) =>
      d
        ? {
            ...d,
            groups: d.groups.map((x) =>
              x.id === g.id ? { ...x, track: !g.track } : x,
            ),
          }
        : d,
    );
    await post("update-group", { groupId: g.id, track: !g.track });
  }

  async function saveSellRate(g: GroupRow) {
    const v = Number(editSell[g.id]);
    if (!Number.isFinite(v) || v < 0) {
      setError("卖出倍率无效");
      return;
    }
    await post("update-group", { groupId: g.id, sellRate: v });
    setMsg(`「${g.name}」卖出倍率已设为 ${v}`);
  }

  async function toggleAccountTrack(a: AccountRow) {
    setData((d) =>
      d
        ? {
            ...d,
            accounts: d.accounts.map((x) =>
              x.id === a.id ? { ...x, track: !a.track } : x,
            ),
          }
        : d,
    );
    await post("update-account", { accountId: a.id, track: !a.track });
  }

  async function savePurchase(a: AccountRow) {
    const v = Number(editCost[a.id]);
    if (!Number.isFinite(v) || v < 0) {
      setError("采购成本无效");
      return;
    }
    await post("update-account", {
      accountId: a.id,
      purchaseCostRmb: v,
      track: true,
    });
    setMsg(`「${a.name}」采购成本 ${formatRmb(v)}`);
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
      <div className="p-6 text-coral text-sm">{error || "无数据"}</div>
    );
  }

  const { provider, groups, accounts, summary } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/self-hosted"
          className="inline-flex items-center gap-1 text-secondary hover:text-cyan"
        >
          <ArrowLeft className="h-4 w-4" />
          自建上游
        </Link>
        <span className="text-muted">/</span>
        <span className="text-text">{provider.name}</span>
      </div>

      <TopBar
        title={`${provider.name} · 分组与账号`}
        subtitle="官方计价 × 卖出倍率 = 卖出收入；账号填采购成本。仅统计勾选的分组/账号。"
        showSync={false}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">本月官方用量</div>
            <div className="font-data text-2xl font-semibold">
              {summary.monthOfficialCost.toFixed(2)}
            </div>
            <div className="text-[11px] text-muted">
              {summary.monthRequests} 次 · {summary.trackedGroups} 个追踪分组
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">本月卖出收入</div>
            <div className="font-data text-2xl font-semibold text-mint">
              {formatRmb(summary.monthSellRevenueRmb)}
            </div>
            <div className="text-[11px] text-muted">官方面值 × 各分组卖出倍率</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">本月成本入账</div>
            <div className="font-data text-2xl font-semibold text-amber">
              {formatRmb(summary.operatingCostRmb)}
            </div>
            <div className="text-[11px] text-muted">
              成本台账摊销（含提前结束重算）
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">账号采购登记</div>
            <div className="font-data text-2xl font-semibold text-secondary">
              {formatRmb(summary.accountPurchaseRmb)}
            </div>
            <div className="text-[11px] text-muted">
              {summary.trackedAccounts} 个追踪账号 · 不直接扣减毛利
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <a
          href={provider.baseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开面板
        </a>
        <Button size="sm" variant="secondary" disabled={busy} onClick={syncMeta}>
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
          同步分组/账号
        </Button>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted">用量天数</Label>
          <Input
            type="number"
            min={1}
            max={31}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 7)}
            className="h-8 w-16"
          />
        </div>
        <Button size="sm" disabled={busy} onClick={syncUsage}>
          <Download className="h-3.5 w-3.5" />
          拉取追踪分组用量
        </Button>
        {msg && <span className="text-xs text-mint font-data">{msg}</span>}
        {error && <span className="text-xs text-coral">{error}</span>}
      </div>

      {/* Groups */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal">
            分组（勾选要统计的 · 设置卖出倍率）
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <HeadRow>
                <TH>统计</TH>
                <TH>分组</TH>
                <TH>平台</TH>
                <TH className="text-right">卖出倍率</TH>
                <TH className="text-right">今日官方</TH>
                <TH className="text-right">累计官方</TH>
                <TH className="text-right">今日卖出¥</TH>
                <TH />
              </HeadRow>
            </THead>
            <TBody>
              {groups.map((g) => (
                <TR key={g.id} tone={g.track ? "info" : undefined}>
                  <TD>
                    <Checkbox
                                            checked={g.track}
                      onChange={() => toggleGroupTrack(g)}/>
                  </TD>
                  <TD>
                    <div className="font-medium">{g.name}</div>
                    <div className="text-[11px] text-muted font-data">
                      #{g.remoteGroupId}
                    </div>
                  </TD>
                  <TD>
                    <Badge variant="default">{g.platform || "—"}</Badge>
                  </TD>
                  <TD className="text-right">
                    <Input
                      className="h-8 w-20 ml-auto text-right font-data"
                      type="number"
                      step="0.01"
                      min="0"
                      value={editSell[g.id] ?? String(g.sellRate)}
                      onChange={(e) =>
                        setEditSell((s) => ({ ...s, [g.id]: e.target.value }))
                      }
                    />
                  </TD>
                  <TD className="text-right font-data text-xs">
                    {g.todayOfficialCost.toFixed(2)}
                  </TD>
                  <TD className="text-right font-data text-xs">
                    {g.lastOfficialCost.toFixed(2)}
                  </TD>
                  <TD className="text-right font-data text-mint text-xs">
                    {formatRmb(g.todayOfficialCost * g.sellRate)}
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => saveSellRate(g)}
                    >
                      保存倍率
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {/* Accounts */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal">
            反代账号（填采购成本）
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <HeadRow>
                <TH>统计</TH>
                <TH>账号</TH>
                <TH>平台</TH>
                <TH>分组</TH>
                <TH className="text-right">采购成本 ¥</TH>
                <TH>状态</TH>
                <TH />
              </HeadRow>
            </THead>
            <TBody>
              {accounts.map((a) => (
                <TR key={a.id} tone={a.track ? "warn" : undefined}>
                  <TD>
                    <Checkbox
                                            checked={a.track}
                      onChange={() => toggleAccountTrack(a)}/>
                  </TD>
                  <TD>
                    <div className="font-medium max-w-[200px] truncate">
                      {a.name}
                    </div>
                    <div className="text-[11px] text-muted font-data">
                      #{a.remoteAccountId} · {a.accountType}
                    </div>
                  </TD>
                  <TD>
                    <Badge>{a.platform || "—"}</Badge>
                  </TD>
                  <TD className="text-xs text-muted max-w-[140px] truncate">
                    {a.groupNames || "—"}
                  </TD>
                  <TD className="text-right">
                    <Input
                      className="h-8 w-24 ml-auto text-right font-data"
                      type="number"
                      step="0.01"
                      min="0"
                      value={editCost[a.id] ?? String(a.purchaseCostRmb)}
                      onChange={(e) =>
                        setEditCost((s) => ({ ...s, [a.id]: e.target.value }))
                      }
                    />
                  </TD>
                  <TD>
                    <Badge
                      variant={a.status === "active" ? "mint" : "default"}
                    >
                      {a.status}
                    </Badge>
                  </TD>
                  <TD className="text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => savePurchase(a)}
                    >
                      保存成本
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <CostLedger providerId={id} accounts={accounts} onChanged={load} />

      <p className="text-[11px] text-muted max-w-3xl leading-relaxed">
        <strong className="text-secondary">计算</strong>
        ：官方计价（刀）来自管理端 usage.total_cost；卖出估算 =
        官方计价 × 分组卖出倍率（0.4 → 每官方 1 刀卖 ¥0.4），仅作自建站内部参考 ——
        这批流量的真实收入落在下游 NewAPI 的消费里，别与总账相加。
        账号采购/订阅请记入下面的<strong className="text-secondary">成本台账</strong>，
        才会按记账日或有效期进入周/月毛利；账号被风控时填「实际结束日」，
        整笔成本会压缩到实际存活的那几天。鉴权使用{" "}
        <code className="font-data text-cyan">X-API-Key</code>，不影响第三方
        Sub2API 邮箱密码登录。
      </p>
    </div>
  );
}
