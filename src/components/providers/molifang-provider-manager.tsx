"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox, Input, Label } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";

interface ProviderMeta {
  id: string;
  name: string;
  baseUrl: string;
  discountRate: number;
  lastBalance: number | null;
}

interface BoundKey {
  id: string;
  name: string;
  keyPreview: string;
  status: string;
  countAsCost: boolean;
  lastBalance: number | null;
  lastTotalActualCost: number | null;
  lastTodayActualCost: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  modelStats: unknown[];
}

export default function MolifangProviderManager() {
  const params = useParams();
  const id = String(params.id || "");
  const [provider, setProvider] = useState<ProviderMeta | null>(null);
  const [keys, setKeys] = useState<BoundKey[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [countAsCost, setCountAsCost] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [providerRes, keyRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch(`/api/upstream/${id}/bound-keys`, { cache: "no-store" }),
      ]);
      const providerJson = await providerRes.json();
      const keyJson = await keyRes.json();
      if (!keyRes.ok) throw new Error(keyJson.error || "加载失败");
      setProvider(
        (providerJson.data || []).find((item: ProviderMeta) => item.id === id) || null,
      );
      setKeys(keyJson.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [id]);

  useEffect(() => {
    if (id) void Promise.resolve().then(load);
  }, [id, load]);

  async function addKey(event: React.FormEvent) {
    event.preventDefault();
    setBusy("add");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/upstream/${id}/bound-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, secret, countAsCost }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "绑定失败");
      setName("");
      setSecret("");
      setMessage("API Key 已验证并绑定，历史累计已作为基线，不会重复计费");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "绑定失败");
    } finally {
      setBusy(null);
    }
  }

  async function patchKey(key: BoundKey, patch: Record<string, unknown>, label: string) {
    setBusy(key.id);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/upstream/${id}/bound-keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || `${label}失败`);
      setMessage(`${key.name} · ${label}完成`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label}失败`);
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(key: BoundKey) {
    if (!confirm(`移除「${key.name}」？密钥会被擦除，用量历史继续保留。`)) return;
    setBusy(key.id);
    try {
      const response = await fetch(`/api/upstream/${id}/bound-keys/${key.id}`, {
        method: "DELETE",
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "移除失败");
      setMessage(`${key.name} 已移除，历史记录已保留`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失败");
    } finally {
      setBusy(null);
    }
  }

  const totalBalance = keys
    .filter((key) => key.status === "active")
    .reduce((sum, key) => sum + (key.lastBalance || 0), 0);
  const totalCost = keys
    .filter((key) => key.status === "active" && key.countAsCost)
    .reduce((sum, key) => sum + (key.lastTotalActualCost || 0), 0);

  return (
    <div className="space-y-6">
      <Link href="/providers" className="inline-flex items-center gap-1 text-sm text-secondary hover:text-cyan">
        <ArrowLeft className="h-4 w-4" /> 上游站点
      </Link>
      <TopBar
        title={`${provider?.name || "MoLiFang"} · 绑定密钥`}
        subtitle="每条 Key 独立读取 /v1/usage，再汇总为一个供应商"
        showSync={false}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-xs text-muted">启用 Key</p><p className="font-data text-2xl text-text">{keys.filter((key) => key.status === "active").length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted">聚合余额</p><p className="font-data text-2xl text-mint">{formatRmb(totalBalance * (provider?.discountRate || 1))}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted">计入成本的累计用量</p><p className="font-data text-2xl text-amber">{formatRmb(totalCost * (provider?.discountRate || 1))}</p></CardContent></Card>
      </div>

      <Card className="border-cyan/25">
        <CardContent className="p-5">
          <form onSubmit={addKey} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] items-end">
            <div className="space-y-1.5"><Label htmlFor="bound-name">Key 名称</Label><Input id="bound-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="项目 A" required /></div>
            <div className="space-y-1.5"><Label htmlFor="bound-secret">API Key</Label><Input id="bound-secret" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="sk-..." required /></div>
            <Button type="submit" disabled={busy === "add"}><Plus className="h-4 w-4" />{busy === "add" ? "验证中…" : "验证并绑定"}</Button>
            <label className="sm:col-span-3 inline-flex items-center gap-2 text-xs text-secondary"><Checkbox checked={countAsCost} onChange={(event) => setCountAsCost(event.target.checked)} />计入中转成本</label>
          </form>
        </CardContent>
      </Card>

      {(message || error) && <p className={cn("text-sm", error ? "text-coral" : "text-mint")}>{error || message}</p>}

      <div className="space-y-3">
        {keys.map((key) => (
          <Card key={key.id} className={cn(key.lastError && "border-coral/30", key.status !== "active" && "opacity-70")}>
            <CardContent className="p-5 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-text">{key.name}</h3><Badge variant={key.status === "active" ? "mint" : "default"}>{key.status === "active" ? "启用" : "停用"}</Badge>{key.countAsCost && <Badge variant="amber">计入成本</Badge>}</div>
                  <p className="font-data text-xs text-muted">{key.keyPreview}</p>
                  <p className="text-xs text-secondary">余额 {formatRmb((key.lastBalance || 0) * (provider?.discountRate || 1))} · 今日实际用量 {(key.lastTodayActualCost || 0).toFixed(6)} · 累计 {(key.lastTotalActualCost || 0).toFixed(6)}</p>
                  <p className="text-[11px] text-muted">{key.lastSuccessAt ? `成功同步于 ${new Date(key.lastSuccessAt).toLocaleString("zh-CN")}` : "尚未成功同步"}</p>
                  {key.lastError && <p className="text-xs text-coral">{key.lastError}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={busy === key.id || key.status !== "active"} onClick={() => patchKey(key, { sync: true }, "同步")}><RefreshCw className={cn("h-3.5 w-3.5", busy === key.id && "animate-spin")} />同步</Button>
                  <Button size="sm" variant="secondary" disabled={busy === key.id} onClick={() => patchKey(key, { countAsCost: !key.countAsCost }, key.countAsCost ? "取消计入成本" : "计入成本")}><KeyRound className="h-3.5 w-3.5" />{key.countAsCost ? "取消成本" : "计入成本"}</Button>
                  <Button size="sm" variant="secondary" disabled={busy === key.id} onClick={() => patchKey(key, { status: key.status === "active" ? "disabled" : "active" }, key.status === "active" ? "停用" : "启用")}>{key.status === "active" ? "停用" : "启用"}</Button>
                  <Button size="sm" variant="danger" disabled={busy === key.id} onClick={() => removeKey(key)}><Trash2 className="h-3.5 w-3.5" />移除</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {!keys.length && <Card><CardContent className="py-10 text-center text-sm text-muted">还没有绑定 Key。添加后会先验证并建立用量基线。</CardContent></Card>}
      </div>

      <Link href={`/providers/${id}/usage`} className={buttonVariants({ variant: "outline" })}>查看按 Key / 按日用量</Link>
    </div>
  );
}
