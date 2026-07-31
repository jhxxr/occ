"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";
import {
  ArrowLeft,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
  ExternalLink,
} from "lucide-react";

interface RechargeItem {
  id: string;
  paidRmb: number;
  creditGained: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  consumedBefore: number | null;
  consumedAfter: number | null;
  source: string;
  status: string;
  note: string | null;
  rechargedAt: string;
}

interface Summary {
  totalPaidRmb: number;
  totalCredit: number;
  effectiveRate: number | null;
  count: number;
  pendingCount: number;
}

interface Payload {
  provider: {
    id: string;
    name: string;
    baseUrl: string;
    discountRate: number;
    lastBalance: number | null;
    lastConsumed: number | null;
  };
  items: RechargeItem[];
  summary: Summary;
}

export default function RechargesPage() {
  const params = useParams();
  const id = String(params.id || "");

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [paidRmb, setPaidRmb] = useState("");
  const [note, setNote] = useState("");
  const [showForm, setShowForm] = useState(false);

  // edit pending
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPaid, setEditPaid] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/upstream/${id}/recharges`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void Promise.resolve().then(load);
  }, [id, load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/upstream/${id}/recharges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paidRmb: Number(paidRmb),
          note: note || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "记录失败");
      const item = json.data.item as RechargeItem;
      setMsg(
        item.creditGained > 0
          ? `已记录：实付 ${formatRmb(item.paidRmb)}，到账面值 ${item.creditGained.toFixed(2)}`
          : `已记录实付；额度暂无法推算，请先同步上游后再点「重算额度」`,
      );
      setPaidRmb("");
      setNote("");
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "记录失败");
    } finally {
      setSaving(false);
    }
  }

  async function savePaid(rechargeId: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/upstream/${id}/recharges`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rechargeId,
          paidRmb: Number(editPaid),
          recalculateCredit: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      setEditingId(null);
      setMsg("已更新");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function recalc(rechargeId: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/upstream/${id}/recharges`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rechargeId, recalculateCredit: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "重算失败");
      setMsg(`额度已重算为 ${json.data.item.creditGained.toFixed(2)}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重算失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(rechargeId: string) {
    if (!confirm("删除这条充值记录？")) return;
    await fetch(
      `/api/upstream/${id}/recharges?rechargeId=${rechargeId}`,
      { method: "DELETE" },
    );
    await load();
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
      <div className="rounded-lg border border-coral/30 bg-coral/5 p-6 text-sm text-coral" role="alert">
        {error || "无数据"}
      </div>
    );
  }

  const { provider, items, summary } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/providers"
          className="inline-flex items-center gap-1 text-secondary hover:text-cyan"
        >
          <ArrowLeft className="h-4 w-4" />
          上游站点
        </Link>
        <span className="text-muted">/</span>
        <span className="text-text">{provider.name} · 充值台账</span>
      </div>

      <TopBar
        title={`${provider.name} · 充值台账`}
        subtitle="只填实付人民币；到账额度 = Δ余额 + Δ全账号消耗（含未计入中转的 Key）"
        showSync={false}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">累计实付</div>
            <div className="font-data text-2xl font-semibold text-coral">
              {formatRmb(summary.totalPaidRmb)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">累计到账面值</div>
            <div className="font-data text-2xl font-semibold">
              {summary.totalCredit.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">实际购入单价</div>
            <div className="font-data text-2xl font-semibold text-amber">
              {summary.effectiveRate != null
                ? formatRmb(summary.effectiveRate)
                : "—"}
              <span className="text-xs text-muted font-normal"> / 面值</span>
            </div>
            <div className="text-[11px] text-muted">
              当前设定 {formatRmb(provider.discountRate)}/面值
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] text-muted">待补金额</div>
            <div className="font-data text-2xl font-semibold">
              {summary.pendingCount}
              <span className="text-sm text-muted font-normal"> 笔</span>
            </div>
            <div className="text-[11px] text-muted">
              当前余额面值 {provider.lastBalance?.toFixed(2) ?? "—"}
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
          去充值
        </a>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-3.5 w-3.5" />
          记录一笔充值
        </Button>
        <Button size="sm" variant="secondary" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </Button>
        {msg && <span className="text-xs text-mint font-data">{msg}</span>}
        {error && <span className="text-xs text-coral">{error}</span>}
      </div>

      {showForm && (
        <Card className="border-cyan/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal flex items-center gap-2">
              <Wallet className="h-4 w-4 text-cyan" />
              新充值记录
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onCreate} className="grid gap-3 sm:grid-cols-3 items-end">
              <div className="space-y-1">
                <Label htmlFor="paid">实付人民币 *</Label>
                <Input
                  id="paid"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={paidRmb}
                  onChange={(e) => setPaidRmb(e.target.value)}
                  placeholder="例如 100"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="note">备注</Label>
                <Input
                  id="note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="可选：支付宝 / 活动价…"
                />
              </div>
              <p className="text-[11px] text-muted sm:col-span-3 leading-relaxed">
                到账额度会自动用「当前余额与全账号消耗 − 上次记录点」推算，
                <strong className="text-secondary">包含未勾选中转的 Key 消耗</strong>
                ，避免漏算。请先在上游面板充值并点一次「同步」，再来这里填实付。
              </p>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "保存中…" : "保存"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowForm(false)}
                >
                  取消
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-text normal-case tracking-normal">
            历史记录（{items.length}）
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted">
              还没有充值记录。充值后同步上游，再点「记录一笔充值」填实付即可。
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-2">时间</th>
                  <th className="px-4 py-2">来源</th>
                  <th className="px-4 py-2 text-right">实付</th>
                  <th className="px-4 py-2 text-right">到账面值</th>
                  <th className="px-4 py-2 text-right">单价</th>
                  <th className="px-4 py-2">状态</th>
                  <th className="px-4 py-2">备注</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const unit =
                    r.creditGained > 0 && r.paidRmb > 0
                      ? r.paidRmb / r.creditGained
                      : null;
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border-subtle/60",
                        r.status === "pending" && "bg-amber/[0.04]",
                      )}
                    >
                      <td className="px-4 py-2.5 font-data text-xs text-secondary whitespace-nowrap">
                        {new Date(r.rechargedAt).toLocaleString("zh-CN")}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={r.source === "auto" ? "violet" : "cyan"}>
                          {r.source === "auto" ? "自动检测" : "手动"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right font-data">
                        {editingId === r.id ? (
                          <Input
                            className="h-8 w-24 ml-auto text-right"
                            type="number"
                            step="0.01"
                            value={editPaid}
                            onChange={(e) => setEditPaid(e.target.value)}
                          />
                        ) : (
                          formatRmb(r.paidRmb)
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-data">
                        {r.creditGained.toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-data text-amber">
                        {unit != null ? formatRmb(unit) : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge
                          variant={
                            r.status === "confirmed" ? "mint" : "amber"
                          }
                        >
                          {r.status === "confirmed" ? "已确认" : "待补金额"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted max-w-[180px] truncate">
                        {r.note || "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 justify-end">
                          {editingId === r.id ? (
                            <>
                              <Button
                                size="sm"
                                disabled={saving}
                                onClick={() => savePaid(r.id)}
                              >
                                保存
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditingId(null)}
                              >
                                取消
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setEditingId(r.id);
                                  setEditPaid(String(r.paidRmb || ""));
                                }}
                              >
                                填金额
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={saving}
                                onClick={() => recalc(r.id)}
                              >
                                重算额度
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => remove(r.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-coral" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted max-w-3xl leading-relaxed">
        <strong className="text-secondary">额度公式</strong>
        ：到账 = (充值后余额 − 充值前余额) + (期间全账号消耗)。
        全账号消耗包含未勾选「计入中转」的 Key，因此个人消耗不会把充值额度算少。
        检测只发生在你点同步/记录时，不会后台高频请求上游。
      </p>
    </div>
  );
}
