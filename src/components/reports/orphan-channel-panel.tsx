"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";
import { Search, Trash2, EyeOff } from "lucide-react";

interface OrphanEntry {
  id: string;
  downstreamId: string;
  downstreamName: string;
  channelId: number;
  channelName: string;
  models: string[];
  quota: number;
  revenueRmb: number;
  requests: number;
  firstDay: string;
  lastDay: string;
  costMode: string;
  costRate: number | null;
  costAmountRmb: number | null;
  costRmb: number;
  resolved: boolean;
  ignored: boolean;
  marginRmb: number;
}

const RATE = "RATE";
const AMOUNT = "AMOUNT";

export function OrphanChannelPanel({
  period,
  onChanged,
}: {
  period: { startDay: string; endDay: string };
  onChanged?: () => void;
}) {
  const [entries, setEntries] = useState<OrphanEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/orphan-channels", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setEntries(json.data.entries);
      const d: Record<string, string> = {};
      for (const e of json.data.entries as OrphanEntry[]) {
        d[e.id] =
          e.costMode === AMOUNT
            ? e.costAmountRmb != null
              ? String(e.costAmountRmb)
              : ""
            : e.costRate != null
              ? String(e.costRate)
              : "";
      }
      setDraft(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function scan() {
    setScanning(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/orphan-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDay: period.startDay,
          endDay: period.endDay,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "检测失败");
      const s = json.data.summary;
      setMsg(
        s.orphans > 0
          ? `检测到 ${s.orphans} 个已删除渠道（新增 ${s.created}），待补录 ${formatRmb(s.unresolvedRevenueRmb)}`
          : "没有发现已删除渠道的消费",
      );
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "检测失败");
    } finally {
      setScanning(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, note?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/orphan-channels", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      if (note) setMsg(note);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveCost(e: OrphanEntry) {
    const raw = draft[e.id];
    if (raw == null || raw === "") {
      setError("请先填写成本");
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) {
      setError("成本数值无效");
      return;
    }
    await patch(
      e.id,
      e.costMode === AMOUNT ? { costAmountRmb: v } : { costRate: v },
      `渠道 #${e.channelId} 成本已记入`,
    );
  }

  async function remove(e: OrphanEntry) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orphan-channels?id=${e.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "删除失败");
      setMsg(`已删除渠道 #${e.channelId} 的记录`);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  const pending = entries.filter((e) => !e.resolved && !e.ignored);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-sm font-semibold normal-case tracking-normal text-text">
            旧渠道成本补录
          </CardTitle>
          <p className="text-[11px] text-muted">
            渠道从 NewAPI 删掉后消费还在、上游成本却没了 · 填成本后计入毛利
            {pending.length > 0 && (
              <span className="ml-1 text-amber">
                · {pending.length} 个待补录
              </span>
            )}
          </p>
        </div>
        <Button size="sm" variant="secondary" disabled={scanning} onClick={scan}>
          <Search className={cn("h-3.5 w-3.5", scanning && "animate-pulse")} />
          {scanning ? "扫描中…" : "扫描本周期"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {(msg || error) && (
          <div className="flex flex-wrap gap-3 text-xs">
            {msg && <span className="font-data text-mint">{msg}</span>}
            {error && <span className="text-coral">{error}</span>}
          </div>
        )}

        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            还没扫描过 · 点「扫描本周期」检查有没有走了已删除渠道的消费
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-2 py-2">渠道</th>
                  <th className="px-2 py-2">区间 / 模型</th>
                  <th className="px-2 py-2 text-right">卖出</th>
                  <th className="px-2 py-2">成本填法</th>
                  <th className="px-2 py-2 text-right">成本</th>
                  <th className="px-2 py-2 text-right">毛利</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    className={cn(
                      "border-b border-border-subtle/60",
                      !e.resolved && !e.ignored && "bg-amber/[0.04]",
                      e.ignored && "opacity-50",
                    )}
                  >
                    <td className="px-2 py-2">
                      <div className="font-data">#{e.channelId}</div>
                      <div className="text-[11px] text-muted max-w-[130px] truncate">
                        {e.channelName || "已删除"} · {e.downstreamName}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="font-data text-[11px] text-secondary">
                        {e.firstDay === e.lastDay
                          ? e.firstDay
                          : `${e.firstDay} ~ ${e.lastDay}`}
                      </div>
                      <div className="text-[11px] text-muted max-w-[150px] truncate">
                        {e.models.length ? e.models.join(", ") : "—"} ·{" "}
                        {e.requests} 次
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-data text-xs text-violet">
                      {formatRmb(e.revenueRmb)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <select
                          className="h-7 rounded-md border border-border bg-surface px-1 text-xs"
                          value={e.costMode}
                          disabled={busy || e.ignored}
                          onChange={(ev) =>
                            patch(e.id, { costMode: ev.target.value })
                          }
                        >
                          <option value={RATE}>倍率</option>
                          <option value={AMOUNT}>总额</option>
                        </select>
                        <Input
                          className="h-7 w-20 text-right font-data text-xs"
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder={e.costMode === AMOUNT ? "¥" : "×"}
                          value={draft[e.id] ?? ""}
                          disabled={e.ignored}
                          onChange={(ev) =>
                            setDraft((d) => ({ ...d, [e.id]: ev.target.value }))
                          }
                        />
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted">
                        {e.costMode === AMOUNT
                          ? "整笔总成本 ¥"
                          : "每 1 面值成本 ¥"}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-data text-xs text-amber">
                      {e.resolved ? formatRmb(e.costRmb) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-right font-data text-xs",
                        e.resolved
                          ? e.marginRmb >= 0
                            ? "text-mint"
                            : "text-coral"
                          : "text-muted",
                      )}
                    >
                      {e.ignored ? (
                        <Badge variant="default">忽略</Badge>
                      ) : e.resolved ? (
                        formatRmb(e.marginRmb)
                      ) : (
                        <Badge variant="amber">待补录</Badge>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {!e.ignored && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => saveCost(e)}
                          >
                            保存
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busy}
                          title={e.ignored ? "取消忽略" : "标记为无需补录"}
                          aria-label="忽略"
                          onClick={() =>
                            patch(
                              e.id,
                              { ignored: !e.ignored },
                              e.ignored ? "已取消忽略" : "已标记为无需补录",
                            )
                          }
                        >
                          <EyeOff
                            className={cn(
                              "h-3.5 w-3.5",
                              e.ignored ? "text-cyan" : "text-muted",
                            )}
                          />
                        </Button>
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
