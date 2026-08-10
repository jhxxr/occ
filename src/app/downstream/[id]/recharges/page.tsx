"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, Gift, LockKeyhole, RefreshCw, Search, WalletCards } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR, HeadRow } from "@/components/ui/table";
import { formatRmb, cn } from "@/lib/utils";

interface UserRow {
  id: number;
  username: string;
  email?: string;
  role: number;
  status?: number;
  quota: number;
  used_quota: number;
  excluded?: boolean;
  isPrivate?: boolean;
}
interface Operation {
  id: string;
  userId: number;
  paidRmb: number;
  creditedRmb: number;
  bonusRmb: number;
  status: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  note: string | null;
  createdAt: string;
}

const STATUS: Record<string, { label: string; variant: "mint" | "amber" | "coral" | "default" }> = {
  APPLIED: { label: "已到账", variant: "mint" },
  VERIFY_REQUIRED: { label: "待核验", variant: "amber" },
  FAILED: { label: "失败", variant: "coral" },
  DISPATCHING: { label: "处理中", variant: "default" },
};

export default function DownstreamRechargesPage() {
  const params = useParams();
  const id = String(params.id || "");
  const [siteName, setSiteName] = useState("");
  const [quotaPerDollar, setQuotaPerDollar] = useState(500000);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [paid, setPaid] = useState("");
  const [credited, setCredited] = useState("");
  const [note, setNote] = useState("");
  const [securityPassword, setSecurityPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [usersRes, historyRes, securityRes] = await Promise.all([
      fetch(`/api/downstream/${id}/users`, { cache: "no-store" }),
      fetch(`/api/downstream/${id}/recharges`, { cache: "no-store" }),
      fetch("/api/recharge-security", { cache: "no-store" }),
    ]);
    const usersJson = await usersRes.json();
    const historyJson = await historyRes.json();
    const securityJson = await securityRes.json();
    if (!usersRes.ok) throw new Error(usersJson.error || "用户加载失败");
    if (!historyRes.ok) throw new Error(historyJson.error || "充值记录加载失败");
    setSiteName(usersJson.data.site.name);
    setQuotaPerDollar(Number(usersJson.data.site.quotaPerDollar || 500000));
    setUsers(usersJson.data.users || []);
    setOperations(historyJson.data.operations || []);
    setUnlocked(!!securityJson.data?.unlocked);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const timer = window.setTimeout(() => {
      void load().catch((e) => setError(e.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id, load]);

  const eligible = useMemo(() => users.filter((user) => user.role < 100 && !user.excluded), [users]);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return eligible;
    return eligible.filter((user) => user.username.toLowerCase().includes(text) || (user.email || "").toLowerCase().includes(text) || String(user.id).includes(text));
  }, [eligible, query]);
  const selected = users.find((user) => user.id === selectedId) || null;
  const paidValue = Number(paid) || 0;
  const creditedValue = Number(credited) || 0;
  const bonus = Math.max(0, creditedValue - paidValue);
  const bonusPct = creditedValue > 0 ? (bonus / creditedValue) * 100 : 0;
  const currentRmb = selected ? selected.quota / quotaPerDollar : 0;

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/recharge-security", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: securityPassword }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "安全密码错误");
      setUnlocked(true); setUnlockOpen(false); setSecurityPassword("");
      setMsg("充值权限已解锁 10 分钟");
    } catch (e) { setError(e instanceof Error ? e.message : "解锁失败"); }
    finally { setBusy(false); }
  }

  async function recharge() {
    if (!unlocked) { setUnlockOpen(true); return; }
    if (!selected || creditedValue <= 0 || paidValue < 0 || paidValue > creditedValue) { setError("请选择用户，并正确填写实收和到账面值"); return; }
    setBusy(true); setError(null); setMsg(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/downstream/${id}/recharges`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: selected.id, paidRmb: paidValue, creditedRmb: creditedValue, note, idempotencyKey }) });
      const json = await res.json();
      if (res.status === 403) { setUnlocked(false); setUnlockOpen(true); throw new Error(json.error || "充值权限已过期"); }
      if (!res.ok) throw new Error(json.error || "充值失败");
      setMsg(json.data.status === "APPLIED" ? `已为 ${selected.username} 充值 ${formatRmb(creditedValue)}` : "请求结果需要核验，请勿重复充值");
      setPaid(""); setCredited(""); setNote("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "充值失败"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <Link href={`/downstream/${id}`} className="inline-flex items-center gap-1 text-sm text-secondary hover:text-cyan"><ArrowLeft className="h-4 w-4" />收入账号</Link>
      <TopBar title={`${siteName || "中转站"} · 用户充值`} subtitle="实收与到账分开记录，赠送额度不会虚增未来利润" showSync={false} />

      <div className="grid gap-5 lg:grid-cols-[minmax(280px,0.9fr)_minmax(360px,1.1fr)]">
        <section className="min-w-0 space-y-3">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text">选择用户</h2><span className="text-xs text-muted">{eligible.length} 个可充值账号</span></div>
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" /><Input className="pl-9" placeholder="搜索用户名 / 邮箱 / ID" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className="max-h-[460px] overflow-y-auto border-y border-border-subtle">
            {filtered.map((user) => {
              const active = user.id === selectedId;
              return <button key={user.id} type="button" onClick={() => setSelectedId(user.id)} className={cn("flex w-full items-center justify-between gap-3 border-b border-border-subtle px-2 py-3 text-left last:border-0 hover:bg-surface-2", active && "bg-cyan/5 ring-1 ring-inset ring-cyan/40")}>
                <div className="min-w-0"><div className="truncate font-medium text-text">{user.username}</div><div className="truncate text-[11px] font-data text-muted">#{user.id}{user.email ? ` · ${user.email}` : ""}</div></div>
                <div className="shrink-0 text-right"><div className="font-data text-sm text-secondary">{formatRmb(user.quota / quotaPerDollar)}</div><Badge variant={user.isPrivate ? "cyan" : "default"}>{user.isPrivate ? "私域" : "公共"}</Badge></div>
              </button>;
            })}
            {!filtered.length && <div className="py-10 text-center text-sm text-muted">没有可充值的匹配用户</div>}
          </div>
          <p className="text-[11px] leading-5 text-muted">测试号和超管已自动排除，不会出现在可充值列表，也不计入预收款余额。</p>
        </section>

        <section className="min-w-0 space-y-4 border-l-0 border-border-subtle lg:border-l lg:pl-5">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text">本次充值</h2><Badge variant={unlocked ? "mint" : "amber"}>{unlocked ? "已解锁" : "需要安全密码"}</Badge></div>
          {selected ? <div className="flex items-center justify-between border-y border-border-subtle py-3"><div><div className="font-medium text-text">{selected.username}</div><div className="text-xs text-muted">当前余额</div></div><div className="font-data text-xl text-cyan">{formatRmb(currentRmb)}</div></div> : <div className="border-y border-border-subtle py-8 text-center text-sm text-muted">先从左侧选择充值用户</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="paid">实收金额</Label><Input id="paid" type="number" min="0" step="0.01" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="实际收到 ¥" /></div>
            <div className="space-y-1"><Label htmlFor="credited">到账面值</Label><Input id="credited" type="number" min="0.01" step="0.01" value={credited} onChange={(e) => setCredited(e.target.value)} placeholder="用户实际获得 ¥" /></div>
          </div>
          <div className="grid grid-cols-3 divide-x divide-border-subtle border-y border-border-subtle py-3 text-center">
            <div><div className="text-[11px] text-muted">赠送</div><div className="font-data text-base text-violet">{formatRmb(bonus)}</div></div>
            <div><div className="text-[11px] text-muted">赠送占比</div><div className="font-data text-base text-secondary">{bonusPct.toFixed(1)}%</div></div>
            <div><div className="text-[11px] text-muted">充值后</div><div className="font-data text-base text-cyan">{formatRmb(currentRmb + creditedValue)}</div></div>
          </div>
          <div className="flex gap-2 text-xs leading-5 text-muted"><Gift className="mt-0.5 h-4 w-4 shrink-0 text-violet" /><span>实收部分随消费确认收入；赠送部分消费收入为 0，但仍承担上游成本，因此会真实降低毛利。</span></div>
          <div className="space-y-1"><Label htmlFor="note">备注</Label><Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：老客户续费，赠送活动额度" /></div>
          <Button className="w-full" disabled={busy || !selected} onClick={recharge}><WalletCards className="h-4 w-4" />{busy ? "处理中…" : `确认充值 ${creditedValue > 0 ? formatRmb(creditedValue) : ""}`}</Button>
          {msg && <div className="flex items-center gap-2 text-xs text-mint"><CheckCircle2 className="h-4 w-4" />{msg}</div>}
          {error && <div className="text-xs text-coral" role="alert">{error}</div>}
        </section>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">充值记录</CardTitle><Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table><THead><HeadRow><TH>时间 / 用户</TH><TH className="text-right">实收</TH><TH className="text-right">到账</TH><TH className="text-right">赠送</TH><TH>状态</TH><TH>备注</TH></HeadRow></THead><TBody>{operations.map((op) => { const status = STATUS[op.status] || { label: op.status, variant: "default" as const }; return <TR key={op.id} tone={op.status === "VERIFY_REQUIRED" ? "warn" : undefined}><TD><div className="font-data text-xs text-secondary">{new Date(op.createdAt).toLocaleString("zh-CN")}</div><div className="text-[11px] text-muted">用户 #{op.userId}</div></TD><TD className="text-right font-data">{formatRmb(op.paidRmb)}</TD><TD className="text-right font-data text-cyan">{formatRmb(op.creditedRmb)}</TD><TD className="text-right font-data text-violet">{formatRmb(op.bonusRmb)}</TD><TD><Badge variant={status.variant}>{status.label}</Badge></TD><TD className="max-w-[220px] truncate text-xs text-muted">{op.note || "—"}</TD></TR>; })}</TBody></Table>
          {!operations.length && <div className="py-10 text-center text-sm text-muted">还没有管理端充值记录</div>}
        </CardContent>
      </Card>

      {unlockOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="dialog" aria-modal="true" aria-labelledby="unlock-title"><form onSubmit={unlock} className="w-full max-w-sm rounded-[var(--r-md)] border border-border bg-surface-1 p-5 shadow-2xl"><div className="mb-4 flex items-start gap-3"><div className="rounded-[var(--r-sm)] bg-amber/10 p-2"><LockKeyhole className="h-5 w-5 text-amber" /></div><div><h2 id="unlock-title" className="font-semibold text-text">解锁充值权限</h2><p className="text-xs leading-5 text-muted">输入环境变量配置的独立安全密码，成功后 10 分钟内无需再次输入。</p></div></div><Label htmlFor="security-password">安全密码</Label><Input id="security-password" type="password" autoFocus autoComplete="current-password" value={securityPassword} onChange={(e) => setSecurityPassword(e.target.value)} /><div className="mt-4 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setUnlockOpen(false)}>取消</Button><Button type="submit" disabled={busy}>解锁 10 分钟</Button></div></form></div>}
    </div>
  );
}
