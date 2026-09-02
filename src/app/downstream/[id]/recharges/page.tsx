"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  ExternalLink,
  Gift,
  RefreshCw,
  WalletCards,
} from "lucide-react";
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
  giftManaged: boolean;
  createdAtRemote: string | null;
  redeemedAt: string | null;
  usedUserId: number | null;
  expiredAt: string | null;
}

interface CreditLot {
  id: string;
  userId: number | null;
  source: "PRIVATE_DIRECT" | "GIFT_CARD_SALE";
  ownership: "PRIVATE" | "PUBLIC";
  originalQuota: number;
  remainingQuota: number;
  faceValueRmb: number | null;
  cashBasisRmb: number | null;
  assumedNoFee: boolean;
  occurredAt: string;
  note: string | null;
  redemptionId: string | null;
}

interface SiteUser {
  userId: number;
  username: string;
  role: number;
}

interface PageData {
  site: { id: string; name: string; baseUrl: string; quotaPerDollar: number };
  codes: RedemptionCode[];
  lots: CreditLot[];
  users: SiteUser[];
}

const STATUS: Record<number, { label: string; variant: "mint" | "amber" | "default" }> = {
  1: { label: "可兑换", variant: "mint" },
  2: { label: "已禁用", variant: "default" },
  3: { label: "已兑换", variant: "amber" },
};

function localDateTimeValue(value = new Date()): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

export default function DownstreamRedemptionsPage() {
  const params = useParams();
  const id = String(params.id || "");
  const [data, setData] = useState<PageData | null>(null);
  const [name, setName] = useState("赠送额度");
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("1");
  const [expiry, setExpiry] = useState("");
  const [createdKeys, setCreatedKeys] = useState<string[]>([]);
  const [privateUserId, setPrivateUserId] = useState("");
  const [privateFaceValue, setPrivateFaceValue] = useState("");
  const [privateReceived, setPrivateReceived] = useState("");
  const [privateOccurredAt, setPrivateOccurredAt] = useState(localDateTimeValue());
  const [privateNote, setPrivateNote] = useState("");
  const [selectedCodeIds, setSelectedCodeIds] = useState<string[]>([]);
  const [giftReceived, setGiftReceived] = useState("");
  const [giftOccurredAt, setGiftOccurredAt] = useState(localDateTimeValue());
  const [giftNote, setGiftNote] = useState("");
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
  const privateFaceValueNumber = Number(privateFaceValue) || 0;
  const selectedGiftCodes = useMemo(
    () => (data?.codes || []).filter((code) => selectedCodeIds.includes(code.id)),
    [data, selectedCodeIds],
  );
  const selectedGiftFaceValue = selectedGiftCodes.reduce(
    (sum, code) => sum + code.quota / quotaPerDollar,
    0,
  );
  const activeCount = useMemo(
    () => data?.codes.filter((code) => code.status === 1).length || 0,
    [data],
  );
  const redeemedCount = useMemo(
    () => data?.codes.filter((code) => code.status === 3).length || 0,
    [data],
  );
  const redeemedManagedCodes = useMemo(
    () => data?.codes.filter((code) => code.giftManaged && code.status === 3) || [],
    [data],
  );

  async function post(body: Record<string, unknown>) {
    const response = await fetch(`/api/downstream/${id}/recharges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "保存失败");
    return json;
  }

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
      const json = await post({ name, quota, count: countValue, expiredTime });
      setCreatedKeys(json.data.keys || []);
      setMessage(json.data.syncWarning || `已创建 ${json.data.keys?.length || 0} 个赠送兑换码`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建兑换码失败");
    } finally {
      setBusy(false);
    }
  }

  async function savePrivateDirect() {
    if (!privateUserId || !(privateFaceValueNumber > 0) || !(Number(privateReceived) >= 0)) {
      setError("请选择用户并填写有效的面值和到账金额");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const json = await post({
        action: "private-direct",
        userId: Number(privateUserId),
        faceValueRmb: privateFaceValueNumber,
        cashBasisRmb: Number(privateReceived),
        occurredAt: new Date(privateOccurredAt).toISOString(),
        note: privateNote,
      });
      if (json.data.ledger?.success === false) throw new Error(json.data.ledger.error || "资金台账重算失败");
      setMessage("私域直充已登记；该用户后续消费会优先核销这笔资金");
      setPrivateFaceValue("");
      setPrivateReceived("");
      setPrivateNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "私域资金保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveGiftSale() {
    if (!selectedCodeIds.length || !(Number(giftReceived) >= 0)) {
      setError("请选择至少一张已兑换礼品卡并填写实际到账金额");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const json = await post({
        action: "gift-card-sale",
        codeIds: selectedCodeIds,
        cashBasisRmb: Number(giftReceived),
        occurredAt: new Date(giftOccurredAt).toISOString(),
        note: giftNote,
      });
      if (json.data.ledger?.success === false) throw new Error(json.data.ledger.error || "资金台账重算失败");
      setMessage("礼品卡到账已登记；私域资金会优先核销，剩余消费才计入公共池");
      setSelectedCodeIds([]);
      setGiftReceived("");
      setGiftNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "礼品卡到账保存失败");
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
        title={`${data?.site.name || "中转站"} · 礼品卡与资金台账`}
        subtitle="私域直充优先核销；礼品卡实际到账进入公共池，手续费按到账额自然扣除"
        showSync={false}
      />

      {message && <div className="flex items-center gap-2 text-xs text-mint"><CheckCircle2 className="h-4 w-4" />{message}</div>}
      {error && <div className="text-xs text-coral" role="alert">{error}</div>}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">登记私域直充</CardTitle><p className="text-xs text-muted">朋友直接付款给您的充值。该用户消费时先确认这笔私域收入。</p></CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1"><Label htmlFor="private-user">充值用户</Label><select id="private-user" value={privateUserId} onChange={(event) => setPrivateUserId(event.target.value)} className="flex h-9 w-full rounded-[var(--r-sm)] border border-border bg-surface px-3 text-sm text-text"><option value="">选择用户</option>{(data?.users || []).filter((user) => user.role < 100).map((user) => <option key={user.userId} value={user.userId}>#{user.userId} · {user.username || "未命名用户"}</option>)}</select></div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="private-face">充入面值</Label><Input id="private-face" type="number" min="0.01" step="0.01" value={privateFaceValue} onChange={(event) => setPrivateFaceValue(event.target.value)} placeholder="¥" /></div><div className="space-y-1"><Label htmlFor="private-received">实际到账</Label><Input id="private-received" type="number" min="0" step="0.01" value={privateReceived} onChange={(event) => setPrivateReceived(event.target.value)} placeholder="¥" /></div></div>
            <div className="space-y-1"><Label htmlFor="private-date">到账时间</Label><Input id="private-date" type="datetime-local" value={privateOccurredAt} onChange={(event) => setPrivateOccurredAt(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="private-note">备注（可选）</Label><Input id="private-note" maxLength={500} value={privateNote} onChange={(event) => setPrivateNote(event.target.value)} placeholder="付款人、转账说明等" /></div>
            <Button className="w-full" disabled={busy} onClick={() => void savePrivateDirect()}><WalletCards className="h-4 w-4" />登记私域资金</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">登记礼品卡到账</CardTitle><p className="text-xs text-muted">可多选已兑换的 Orbit 礼品卡，统一填写卡网实际到账；面值与到账的差额即手续费。</p></CardHeader>
          <CardContent className="space-y-3">
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-[var(--r-sm)] border border-border-subtle p-2">
              {redeemedManagedCodes.map((code) => <label key={code.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs hover:bg-surface-2"><input type="checkbox" checked={selectedCodeIds.includes(code.id)} onChange={(event) => setSelectedCodeIds((ids) => event.target.checked ? [...ids, code.id] : ids.filter((codeId) => codeId !== code.id))} /><span className="min-w-0 flex-1 truncate">#{code.remoteId} · {code.name || "未命名"} · 用户 #{code.usedUserId ?? "—"}</span><span className="font-data text-violet">{formatRmb(code.quota / quotaPerDollar)}</span></label>)}
              {!redeemedManagedCodes.length && <p className="p-2 text-xs text-muted">暂无已兑换的 Orbit 礼品卡；请先同步兑换记录。</p>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label>所选卡面值</Label><div className="flex h-9 items-center rounded-[var(--r-sm)] border border-border-subtle px-3 font-data text-sm text-violet">{formatRmb(selectedGiftFaceValue)}</div></div><div className="space-y-1"><Label htmlFor="gift-received">实际到账</Label><Input id="gift-received" type="number" min="0" max={selectedGiftFaceValue || undefined} step="0.01" value={giftReceived} onChange={(event) => setGiftReceived(event.target.value)} placeholder="¥" /></div></div>
            <div className="space-y-1"><Label htmlFor="gift-date">到账时间</Label><Input id="gift-date" type="datetime-local" value={giftOccurredAt} onChange={(event) => setGiftOccurredAt(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="gift-note">备注（可选）</Label><Input id="gift-note" maxLength={500} value={giftNote} onChange={(event) => setGiftNote(event.target.value)} placeholder="卡网结算批次、手续费说明等" /></div>
            <Button className="w-full" disabled={busy || !redeemedManagedCodes.length} onClick={() => void saveGiftSale()}><WalletCards className="h-4 w-4" />登记公共池到账</Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(340px,0.9fr)_minmax(360px,1.1fr)]">
        <section className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text">创建赠送码</h2><a href={data?.site.baseUrl || "#"} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}><ExternalLink className="h-3.5 w-3.5" />打开 NewAPI</a></div>
          <div className="space-y-1"><Label htmlFor="name">批次名称</Label><Input id="name" maxLength={20} value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="amount">单个赠送面值</Label><Input id="amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="人民币面值 ¥" /></div><div className="space-y-1"><Label htmlFor="count">创建数量</Label><Input id="count" type="number" min="1" max="100" step="1" value={count} onChange={(event) => setCount(event.target.value)} /></div></div>
          <div className="space-y-1"><Label htmlFor="expiry">有效期（可选）</Label><Input id="expiry" type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></div>
          <div className="grid grid-cols-2 divide-x divide-border-subtle border-y border-border-subtle py-3 text-center"><div><div className="text-[11px] text-muted">单码面值</div><div className="font-data text-base text-violet">{formatRmb(amountValue)}</div></div><div><div className="text-[11px] text-muted">NewAPI quota</div><div className="font-data text-base text-secondary">{quota.toLocaleString("zh-CN")}</div></div></div>
          <div className="flex gap-2 text-xs leading-5 text-muted"><Gift className="mt-0.5 h-4 w-4 shrink-0 text-violet" /><span>新建的兑换码先按历史“无手续费”登记；实际出售后在上方补填到账金额即可进入公共池。</span></div>
          <Button className="w-full" disabled={busy} onClick={() => void createCodes()}><Gift className="h-4 w-4" />{busy ? "处理中…" : "创建礼品卡兑换码"}</Button>
        </section>

        <section className="min-w-0 space-y-3 border-l-0 border-border-subtle lg:border-l lg:pl-5"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text">本次生成</h2>{createdKeys.length > 0 && <Button size="sm" variant="ghost" onClick={() => void copyKeys()}><Copy className="h-3.5 w-3.5" />复制全部</Button>}</div>{createdKeys.length ? <div className="max-h-[390px] space-y-1 overflow-y-auto border-y border-border-subtle py-2">{createdKeys.map((key) => <div key={key} className="select-all px-2 py-2 font-data text-sm text-cyan">{key}</div>)}</div> : <div className="border-y border-border-subtle py-12 text-center text-sm text-muted">创建后兑换码只在这里完整显示，请及时复制交付给用户。</div>}<p className="text-[11px] leading-5 text-muted">Orbit 数据库只保存脱敏预览。完整兑换码来自本次 NewAPI 响应，不会长期明文保存。</p></section>
      </div>

      <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><div><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">资金台账</CardTitle><div className="mt-1 text-xs text-muted">私域直充优先消耗；公共礼品卡只在私域资金耗尽后参与核销。</div></div></CardHeader><CardContent className="overflow-x-auto p-0"><Table><THead><HeadRow><TH>来源 / 用户</TH><TH className="text-right">面值</TH><TH className="text-right">实际到账</TH><TH className="text-right">未核销</TH><TH>到账时间</TH></HeadRow></THead><TBody>{(data?.lots || []).map((lot) => <TR key={lot.id}><TD><div className="text-sm text-text">{lot.source === "PRIVATE_DIRECT" ? "私域直充" : "公共礼品卡"}{lot.assumedNoFee && <Badge className="ml-2" variant="default">暂按无手续费</Badge>}</div><div className="text-[11px] text-muted">用户 #{lot.userId ?? "未兑换"}{lot.note ? ` · ${lot.note}` : ""}</div></TD><TD className="text-right font-data text-violet">{formatRmb(lot.faceValueRmb ?? lot.originalQuota / quotaPerDollar)}</TD><TD className="text-right font-data">{formatRmb(lot.cashBasisRmb || 0)}</TD><TD className="text-right font-data">{formatRmb(lot.remainingQuota / quotaPerDollar)}</TD><TD className="text-xs text-muted">{new Date(lot.occurredAt).toLocaleString("zh-CN")}</TD></TR>)}</TBody></Table>{!data?.lots.length && <div className="py-10 text-center text-sm text-muted">还没有登记资金</div>}</CardContent></Card>

      <Card><CardHeader className="flex flex-row items-center justify-between pb-2"><div><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">兑换记录</CardTitle><div className="mt-1 text-xs text-muted">{activeCount} 个可兑换 · {redeemedCount} 个已兑换</div></div><Button size="sm" variant="ghost" disabled={busy} onClick={() => void syncCodes()}><RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />同步</Button></CardHeader><CardContent className="overflow-x-auto p-0"><Table><THead><HeadRow><TH>批次 / 兑换码</TH><TH className="text-right">面值</TH><TH>状态</TH><TH>兑换账号</TH><TH>时间</TH></HeadRow></THead><TBody>{(data?.codes || []).map((code) => { const expired = !!code.expiredAt && new Date(code.expiredAt) < new Date() && code.status === 1; const status = expired ? { label: "已过期", variant: "default" as const } : STATUS[code.status] || { label: `状态 ${code.status}`, variant: "default" as const }; return <TR key={code.id}><TD><div className="text-sm text-text">{code.name || "未命名"}</div><div className="font-data text-[11px] text-muted">#{code.remoteId} · {code.keyPreview}</div></TD><TD className="text-right font-data text-violet">{formatRmb(code.quota / quotaPerDollar)}</TD><TD><Badge variant={status.variant}>{status.label}</Badge></TD><TD className="font-data text-xs">{code.usedUserId ? `#${code.usedUserId}` : "—"}</TD><TD className="text-xs text-muted">{code.redeemedAt ? new Date(code.redeemedAt).toLocaleString("zh-CN") : code.createdAtRemote ? new Date(code.createdAtRemote).toLocaleString("zh-CN") : "—"}</TD></TR>; })}</TBody></Table>{!data?.codes.length && <div className="py-10 text-center text-sm text-muted">还没有同步到兑换码记录</div>}</CardContent></Card>
    </div>
  );
}
