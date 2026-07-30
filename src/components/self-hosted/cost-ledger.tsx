"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";
import { Plus, Trash2, CircleSlash } from "lucide-react";

interface CostEntry {
  id: string;
  name: string;
  amountRmb: number;
  mode: string;
  startDay: string;
  plannedEndDay: string | null;
  actualEndDay: string | null;
  status: string;
  category: string;
  providerId: string | null;
  accountId: string | null;
  note: string | null;
  allocatedRmb: number;
  effectiveEndDay: string | null;
  effectiveDays: number | null;
  earlyEnded: boolean;
  openEnded: boolean;
}

interface AccountOption {
  id: string;
  name: string;
}

const ONE_TIME = "ONE_TIME";
const PERIOD = "PERIOD";

export function CostLedger({
  providerId,
  accounts,
  onChanged,
}: {
  providerId: string;
  accounts: AccountOption[];
  onChanged?: () => void;
}) {
  const [entries, setEntries] = useState<CostEntry[]>([]);
  const [periodLabel, setPeriodLabel] = useState("");
  const [totalRmb, setTotalRmb] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<typeof ONE_TIME | typeof PERIOD>(ONE_TIME);
  const [startDay, setStartDay] = useState("");
  const [plannedEndDay, setPlannedEndDay] = useState("");
  const [accountId, setAccountId] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/operating-costs?providerId=${providerId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setEntries(json.data.entries);
      setPeriodLabel(json.data.period.label);
      setTotalRmb(json.data.totalRmb);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }, [providerId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function submit() {
    const value = Number(amount);
    if (!name.trim()) {
      setError("请填写名称");
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      setError("金额无效");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/operating-costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          amountRmb: value,
          mode,
          startDay: startDay || undefined,
          plannedEndDay: mode === PERIOD ? plannedEndDay || null : null,
          category: "self-hosted",
          providerId,
          accountId: accountId || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      setMsg(`已记入「${name.trim()}」`);
      setName("");
      setAmount("");
      setPlannedEndDay("");
      setAccountId("");
      setShowForm(false);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, note: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/operating-costs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "更新失败");
      setMsg(note);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: CostEntry) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/operating-costs?id=${entry.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "删除失败");
      setMsg(`已删除「${entry.name}」`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  /** 账号被风控：整笔成本压缩到今天为止的实际存活区间 */
  async function endToday(entry: CostEntry) {
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
    const day = today < entry.startDay ? entry.startDay : today;
    await patch(
      entry.id,
      { actualEndDay: day },
      `「${entry.name}」已按 ${day} 结束，成本压缩到实际存活区间`,
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
            成本台账
          </CardTitle>
          <p className="text-[11px] text-muted">
            {periodLabel ? `${periodLabel} 入账 ` : ""}
            <span className="font-data text-amber">{formatRmb(totalRmb)}</span>
            {" · 一次性整笔计入记账日；按期摊销的账号被风控后填实际结束日即压缩摊完"}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-3.5 w-3.5" />
          {showForm ? "收起" : "记一笔"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {showForm && (
          <div className="grid gap-3 rounded-lg border border-border-subtle bg-surface-2/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label className="text-xs text-muted">名称</Label>
              <Input
                className="h-8"
                value={name}
                placeholder="如：Claude 账号 ×3"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs text-muted">金额 ¥</Label>
              <Input
                className="h-8 font-data"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs text-muted">入账方式</Label>
              <select
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value === PERIOD ? PERIOD : ONE_TIME)
                }
              >
                <option value={ONE_TIME}>一次性整笔</option>
                <option value={PERIOD}>按有效期摊销</option>
              </select>
            </div>
            <div>
              <Label className="text-xs text-muted">
                {mode === PERIOD ? "开始日" : "记账日"}
              </Label>
              <Input
                className="h-8 font-data"
                type="date"
                value={startDay}
                onChange={(e) => setStartDay(e.target.value)}
              />
            </div>
            {mode === PERIOD && (
              <div>
                <Label className="text-xs text-muted">计划结束日</Label>
                <Input
                  className="h-8 font-data"
                  type="date"
                  value={plannedEndDay}
                  onChange={(e) => setPlannedEndDay(e.target.value)}
                />
              </div>
            )}
            <div>
              <Label className="text-xs text-muted">归属账号（可选）</Label>
              <select
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">整站成本</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <Button size="sm" disabled={busy} onClick={submit}>
                保存
              </Button>
            </div>
          </div>
        )}

        {(msg || error) && (
          <div className="flex gap-3 text-xs">
            {msg && <span className="text-mint font-data">{msg}</span>}
            {error && <span className="text-coral">{error}</span>}
          </div>
        )}

        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            还没有成本记录 · 买号、订阅费记进来才会计入周/月毛利
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-2 py-2">项目</th>
                  <th className="px-2 py-2">方式</th>
                  <th className="px-2 py-2">区间</th>
                  <th className="px-2 py-2 text-right">总额</th>
                  <th className="px-2 py-2 text-right">本期入账</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border-subtle/60">
                    <td className="px-2 py-2">
                      <div className="max-w-[200px] truncate">{e.name}</div>
                      {e.accountId && (
                        <div className="text-[11px] text-muted">
                          {accounts.find((a) => a.id === e.accountId)?.name ||
                            "已删除账号"}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {e.mode === ONE_TIME ? (
                        <Badge variant="default">一次性</Badge>
                      ) : e.earlyEnded ? (
                        <Badge variant="coral">提前结束</Badge>
                      ) : e.openEnded ? (
                        <Badge variant="default">进行中</Badge>
                      ) : (
                        <Badge variant="mint">按期摊销</Badge>
                      )}
                    </td>
                    <td className="px-2 py-2 font-data text-[11px] text-muted">
                      {e.mode === ONE_TIME
                        ? e.startDay
                        : `${e.startDay} ~ ${e.effectiveEndDay || "未定"}${e.effectiveDays ? ` · ${e.effectiveDays}天` : ""}`}
                    </td>
                    <td className="px-2 py-2 text-right font-data text-xs text-muted">
                      {formatRmb(e.amountRmb)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-right font-data text-xs",
                        e.allocatedRmb > 0 ? "text-amber" : "text-muted",
                      )}
                    >
                      {formatRmb(e.allocatedRmb)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {e.mode === PERIOD && !e.actualEndDay && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            title="账号被风控/停用：整笔成本压缩到实际存活区间"
                            onClick={() => endToday(e)}
                          >
                            <CircleSlash className="h-3.5 w-3.5" />
                            今天结束
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busy}
                          aria-label="删除"
                          onClick={() => remove(e)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-coral" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
