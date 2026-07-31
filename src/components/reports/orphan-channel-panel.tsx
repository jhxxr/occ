"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";
import { Search, Trash2, EyeOff, Archive } from "lucide-react";

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

interface CoverageRow {
  downstreamId: string;
  name: string;
  /** 已落锚点、下次不用再扫的天数 */
  anchored: number;
  total: number;
  missing: number;
  /** 其中只剩月汇总的天数（精度已降级） */
  compacted: number;
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
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/orphan-channels?startDay=${period.startDay}&endDay=${period.endDay}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setEntries(json.data.entries);
      setCoverage(json.data.coverage || []);
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
  }, [period.startDay, period.endDay]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function scan(force = false) {
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
          force,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "检测失败");
      const s = json.data.summary;
      const scanNote =
        s.daysSkipped > 0
          ? `扫了 ${s.daysScanned} 天、跳过 ${s.daysSkipped} 天（已缓存）`
          : `扫了 ${s.daysScanned} 天 ${s.logsFetched} 条日志`;
      const deferNote =
        s.daysDeferred > 0
          ? ` · 还剩 ${s.daysDeferred} 天未扫，再点一次继续（分批是为了不打爆下游站点）`
          : "";
      // 重扫已压缩月份必须一次扫完整月，否则删掉月汇总就会丢数据
      const refusedNote =
        s.monthsRefused > 0
          ? ` · 有 ${s.monthsRefused} 个已压缩月份未重扫：请把区间设为整月并把「单次最多扫描天数」调到 31`
          : "";
      setMsg(
        (s.orphans > 0
          ? `${scanNote} · 已删除渠道 ${s.orphans} 个（新增 ${s.created}），待补录 ${formatRmb(s.unresolvedRevenueRmb)}`
          : `${scanNote} · 没有发现已删除渠道的消费`) + deferNote + refusedNote,
      );
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "检测失败");
    } finally {
      setScanning(false);
    }
  }

  /** 压缩老缓存：只动数据库，不碰日志 */
  async function compact() {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/orphan-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compact" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "压缩失败");
      const s = json.data.summary;
      if (s.months === 0) {
        setMsg("没有可压缩的老缓存（近两个月保留逐日精度）");
      } else {
        const saved = s.bytesBefore - s.bytesAfter;
        const pct =
          s.bytesBefore > 0 ? Math.round((saved / s.bytesBefore) * 100) : 0;
        setMsg(
          `已压缩 ${s.months} 个月、${s.daysCompacted} 天 → ${s.months} 行，省 ${pct}%（${s.bytesBefore}→${s.bytesAfter} 字节）`,
        );
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "压缩失败");
    } finally {
      setBusy(false);
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
  const missingDays = coverage.reduce((s, c) => s + c.missing, 0);
  const totalDays = coverage.reduce((s, c) => s + c.total, 0);
  const anchoredDays = coverage.reduce((s, c) => s + c.anchored, 0);
  const compactedDays = coverage.reduce((s, c) => s + c.compacted, 0);
  const allAnchored = totalDays > 0 && missingDays === 0;
  const cacheHint =
    totalDays === 0
      ? null
      : (allAnchored
          ? `本周期 ${totalDays} 天已全部缓存，无需重扫`
          : `已缓存 ${anchoredDays}/${totalDays} 天 · 还需扫描 ${missingDays} 天`) +
        (compactedDays > 0 ? ` · 其中 ${compactedDays} 天已压缩为月汇总` : "");

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
          {cacheHint && (
            <p className="mt-0.5 text-[11px] font-data text-muted">{cacheHint}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="secondary" disabled={scanning} onClick={() => scan()}>
            <Search className={cn("h-3.5 w-3.5", scanning && "animate-pulse")} />
            {scanning
              ? "扫描中…"
              : allAnchored
                ? "重新检测"
                : `扫描 ${missingDays} 天`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={scanning || busy}
            title="把上上个月及更早的逐日缓存压成一个月一行，只留渠道 id / 面值 / 请求数"
            onClick={compact}
          >
            <Archive className="h-3.5 w-3.5" />
            压缩旧缓存
          </Button>
          {allAnchored && (
            <Button
              size="sm"
              variant="ghost"
              disabled={scanning}
              title="无视缓存重扫整个周期（日志被清理过时用）"
              onClick={() => scan(true)}
            >
              强制重扫
            </Button>
          )}
        </div>
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
