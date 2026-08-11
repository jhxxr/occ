"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, Copy, ExternalLink, Gift, RefreshCw } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR, HeadRow } from "@/components/ui/table";
import { cn, formatRmb } from "@/lib/utils";

interface RedemptionCode {
  id: string;
  remoteId: number;
  name: string;
  keyPreview: string;
  quota: number;
  status: number;
  createdAtRemote: string | null;
  redeemedAt: string | null;
  usedUserId: number | null;
  expiredAt: string | null;
}

interface PageData {
  site: { id: string; name: string; baseUrl: string; quotaPerDollar: number };
  codes: RedemptionCode[];
}

const STATUS: Record<number, { label: string; variant: "mint" | "amber" | "default" }> = {
  1: { label: "可兑换", variant: "mint" },
  2: { label: "已禁用", variant: "default" },
  3: { label: "已兑换", variant: "amber" },
};

export default function DownstreamRedemptionsPage() {
  const params = useParams();
  const id = String(params.id || "");
  const [data, setData] = useState<PageData | null>(null);
  const [name, setName] = useState("赠送额度");
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("1");
  const [expiry, setExpiry] = useState("");
  const [createdKeys, setCreatedKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/downstream/${id}/recharges`, { cache: "no-store" });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "兑换码记录加载失败");
    setData(json.data);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const timer = window.setTimeout(() => {
      void load().catch((reason) => setError(reason.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id, load]);

  const quotaPerDollar = Number(data?.site.quotaPerDollar || 500_000);
  const amountValue = Number(amount) || 0;
  const quota = Math.round(amountValue * quotaPerDollar);
  const activeCount = useMemo(
    () => data?.codes.filter((code) => code.status === 1).length || 0,
    [data],
  );
  const redeemedCount = useMemo(
    () => data?.codes.filter((code) => code.status === 3).length || 0,
    [data],
  );

  async function createCodes() {
    const countValue = Number(count);
    if (!name.trim() || amountValue <= 0 || !Number.isInteger(countValue) || countValue < 1 || countValue > 100) {
      setError("请填写名称、正数赠送面值和 1-100 的创建数量");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const expiredTime = expiry ? Math.floor(new Date(`${expiry}T23:59:59`).getTime() / 1000) : 0;
      const response = await fetch(`/api/downstream/${id}/recharges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, quota, count: countValue, expiredTime }),
      });
      const json = await response.json();
      if (!response.ok) {
        if (Array.isArray(json.keys) && json.keys.length) setCreatedKeys(json.keys);
        throw new Error(json.error || "创建兑换码失败");
      }
      setCreatedKeys(json.data.keys || []);
      setMessage(
        json.data.syncWarning || `已创建 ${json.data.keys?.length || 0} 个赠送兑换码`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建兑换码失败");
    } finally {
      setBusy(false);
    }
  }

  async function syncCodes() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/downstream/${id}/recharges`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "同步兑换码失败");
      setMessage(`已同步 ${json.data.count} 条兑换码记录`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步兑换码失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyKeys() {
    await navigator.clipboard.writeText(createdKeys.join("\n"));
    setMessage("兑换码已复制");
  }

  return (
    <div className="space-y-5">
      <Link href={`/downstream/${id}`} className="inline-flex items-center gap-1 text-sm text-secondary hover:text-cyan">
        <ArrowLeft className="h-4 w-4" />收入账号
      </Link>
      <TopBar
        title={`${data?.site.name || "中转站"} · 赠送兑换码`}
        subtitle="创建 NewAPI 原生兑换码；用户兑换后由远端记录对应到账账号"
        showSync={false}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(340px,0.9fr)_minmax(360px,1.1fr)]">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text">创建赠送码</h2>
            <a
              href={data?.site.baseUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              <ExternalLink className="h-3.5 w-3.5" />打开 NewAPI
            </a>
          </div>
          <div className="space-y-1"><Label htmlFor="name">批次名称</Label><Input id="name" maxLength={20} value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="amount">单个赠送面值</Label><Input id="amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="人民币面值 ¥" /></div>
            <div className="space-y-1"><Label htmlFor="count">创建数量</Label><Input id="count" type="number" min="1" max="100" step="1" value={count} onChange={(event) => setCount(event.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label htmlFor="expiry">有效期（可选）</Label><Input id="expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></div>
          <div className="grid grid-cols-2 divide-x divide-border-subtle border-y border-border-subtle py-3 text-center">
            <div><div className="text-[11px] text-muted">单码面值</div><div className="font-data text-base text-violet">{formatRmb(amountValue)}</div></div>
            <div><div className="text-[11px] text-muted">NewAPI quota</div><div className="font-data text-base text-secondary">{quota.toLocaleString("zh-CN")}</div></div>
          </div>
          <div className="flex gap-2 text-xs leading-5 text-muted"><Gift className="mt-0.5 h-4 w-4 shrink-0 text-violet" /><span>兑换码由 NewAPI 原子核销并记录兑换账号。赠送额度没有现金收入，用户消费时仍会产生上游成本。</span></div>
          <Button className="w-full" disabled={busy} onClick={() => void createCodes()}><Gift className="h-4 w-4" />{busy ? "处理中…" : "创建赠送兑换码"}</Button>
          {message && <div className="flex items-center gap-2 text-xs text-mint"><CheckCircle2 className="h-4 w-4" />{message}</div>}
          {error && <div className="text-xs text-coral" role="alert">{error}</div>}
        </section>

        <section className="min-w-0 space-y-3 border-l-0 border-border-subtle lg:border-l lg:pl-5">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text">本次生成</h2>{createdKeys.length > 0 && <Button size="sm" variant="ghost" onClick={() => void copyKeys()}><Copy className="h-3.5 w-3.5" />复制全部</Button>}</div>
          {createdKeys.length ? (
            <div className="max-h-[390px] space-y-1 overflow-y-auto border-y border-border-subtle py-2">
              {createdKeys.map((key) => <div key={key} className="select-all px-2 py-2 font-data text-sm text-cyan">{key}</div>)}
            </div>
          ) : (
            <div className="border-y border-border-subtle py-12 text-center text-sm text-muted">创建后兑换码只在这里完整显示，请及时复制交付给用户。</div>
          )}
          <p className="text-[11px] leading-5 text-muted">Orbit 数据库只保存脱敏预览。完整兑换码来自本次 NewAPI 响应，不会长期明文保存。</p>
        </section>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">兑换记录</CardTitle><div className="mt-1 text-xs text-muted">{activeCount} 个可兑换 · {redeemedCount} 个已兑换</div></div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void syncCodes()}><RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />同步</Button>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table><THead><HeadRow><TH>批次 / 兑换码</TH><TH className="text-right">面值</TH><TH>状态</TH><TH>兑换账号</TH><TH>时间</TH></HeadRow></THead><TBody>
            {(data?.codes || []).map((code) => {
              const expired = !!code.expiredAt && new Date(code.expiredAt) < new Date() && code.status === 1;
              const status = expired ? { label: "已过期", variant: "default" as const } : STATUS[code.status] || { label: `状态 ${code.status}`, variant: "default" as const };
              return <TR key={code.id}><TD><div className="text-sm text-text">{code.name || "未命名"}</div><div className="font-data text-[11px] text-muted">#{code.remoteId} · {code.keyPreview}</div></TD><TD className="text-right font-data text-violet">{formatRmb(code.quota / quotaPerDollar)}</TD><TD><Badge variant={status.variant}>{status.label}</Badge></TD><TD className="font-data text-xs">{code.usedUserId ? `#${code.usedUserId}` : "—"}</TD><TD className="text-xs text-muted">{code.redeemedAt ? new Date(code.redeemedAt).toLocaleString("zh-CN") : code.createdAtRemote ? new Date(code.createdAtRemote).toLocaleString("zh-CN") : "—"}</TD></TR>;
            })}
          </TBody></Table>
          {!data?.codes.length && <div className="py-10 text-center text-sm text-muted">还没有同步到兑换码记录</div>}
        </CardContent>
      </Card>
    </div>
  );
}
