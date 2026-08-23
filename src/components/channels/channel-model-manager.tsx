"use client";

import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorOf, readJson } from "@/lib/sync-client";

interface ChannelModelStatus {
  channelId: number;
  channelName: string;
  pendingAddModels: string[];
  pendingRemoveModels: string[];
  lastCheckTime: number | null;
  autoAddedModels: number;
}

interface ApplyModelUpdatesResult {
  addedModels: string[];
  removedModels: string[];
  ignoredModels: string[];
  models: string[];
}

interface ModelApplyResponse {
  applied: ApplyModelUpdatesResult;
  refreshed: ChannelModelStatus;
}

export function ChannelModelManager({
  siteId,
  channelId,
  currentModels,
}: {
  siteId: string;
  channelId: number;
  currentModels: string[];
}) {
  const [status, setStatus] = useState<ChannelModelStatus | null>(null);
  const [selectedAdd, setSelectedAdd] = useState<string[]>([]);
  const [selectedRemove, setSelectedRemove] = useState<string[]>([]);
  const [actualModels, setActualModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const endpoint = `/api/channels/${encodeURIComponent(siteId)}/${channelId}/models`;

  const detect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const json = await readJson(response);
      if (!response.ok) throw new Error(errorOf(json, `HTTP ${response.status}`));
      const next = json.data as ChannelModelStatus | undefined;
      if (!next) throw new Error("空响应");
      setStatus(next);
      setSelectedAdd([]);
      setSelectedRemove([...next.pendingRemoveModels]);
      setMessage(
        next.pendingAddModels.length + next.pendingRemoveModels.length === 0
          ? "已与上游一致，没有待确认变更"
          : `发现 ${next.pendingAddModels.length} 个可新增、${next.pendingRemoveModels.length} 个建议移除`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "探测上游模型失败");
    } finally {
      setBusy(false);
    }
  }, [endpoint]);

  const apply = useCallback(
    async (ignoreAllAdditions = false) => {
      if (!status) return;
      const addModels = ignoreAllAdditions ? [] : selectedAdd;
      const removeModels = ignoreAllAdditions ? [] : selectedRemove;
      const ignoreModels = ignoreAllAdditions ? status.pendingAddModels : [];
      if (!addModels.length && !removeModels.length && !ignoreModels.length) {
        setError("没有可应用的模型变更");
        return;
      }
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ addModels, removeModels, ignoreModels }),
        });
        const json = await readJson(response);
        if (!response.ok) throw new Error(errorOf(json, `HTTP ${response.status}`));
        const result = json.data as ModelApplyResponse | undefined;
        if (!result) throw new Error("空响应");
        setStatus(result.refreshed);
        setSelectedAdd([]);
        setSelectedRemove([...result.refreshed.pendingRemoveModels]);
        setActualModels(result.applied.models);
        setMessage(
          ignoreAllAdditions
            ? `已忽略 ${result.applied.ignoredModels.length} 个待新增模型`
            : `已新增 ${result.applied.addedModels.length} 个、移除 ${result.applied.removedModels.length} 个；服务端实际启用 ${result.applied.models.length} 个`,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "应用模型变更失败");
      } finally {
        setBusy(false);
      }
    },
    [endpoint, selectedAdd, selectedRemove, status],
  );

  return (
    <section className="rounded-[12px] border border-border-subtle bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">模型确认</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            当前启用 {currentModels.length} 个。探测只更新待确认列表，点击应用后才改变路由模型。
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void detect()}>
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
          {busy ? "处理中…" : "探测上游模型"}
        </Button>
      </div>

      {(message || error) && (
        <div className="mt-3 text-xs" role={error ? "alert" : "status"}>
          {message && <p className="font-data text-mint">{message}</p>}
          {error && <p className="text-coral">{error}</p>}
        </div>
      )}

      {actualModels && (
        <div className="mt-3 rounded-[9px] border border-mint/25 bg-mint/5 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-mint">
            服务端回读的实际模型 · {actualModels.length}
          </div>
          <div className="mt-2 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {actualModels.map((model) => <Badge key={model}>{model}</Badge>)}
          </div>
        </div>
      )}

      {!status && (
        <div className="mt-3 rounded-[9px] border border-dashed border-border-subtle px-3 py-4 text-center text-xs text-muted">
          待手动探测；页面不会批量请求所有渠道。
        </div>
      )}

      {status && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <ModelSelectionList title={`可新增 · ${status.pendingAddModels.length}`} hint="默认不选；未选择的仍保留待确认。" models={status.pendingAddModels} selected={selectedAdd} tone="add" disabled={busy} onChange={setSelectedAdd} idPrefix={`${siteId}-${channelId}`} />
          <ModelSelectionList title={`建议移除 · ${status.pendingRemoveModels.length}`} hint="默认全选；取消后仍保留待确认。" models={status.pendingRemoveModels} selected={selectedRemove} tone="remove" disabled={busy} onChange={setSelectedRemove} idPrefix={`${siteId}-${channelId}`} />
          {(status.pendingAddModels.length > 0 || status.pendingRemoveModels.length > 0) && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle pt-3 lg:col-span-2">
              {status.pendingAddModels.length > 0 && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void apply(true)}>全部忽略新增</Button>}
              <Button type="button" size="sm" disabled={busy} onClick={() => void apply(false)}>应用勾选</Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ModelSelectionList({
  title,
  hint,
  models,
  selected,
  tone,
  disabled,
  onChange,
  idPrefix,
}: {
  title: string;
  hint: string;
  models: string[];
  selected: string[];
  tone: "add" | "remove";
  disabled: boolean;
  onChange: (models: string[]) => void;
  idPrefix: string;
}) {
  const selectedSet = new Set(selected);
  const allSelected = models.length > 0 && models.every((model) => selectedSet.has(model));
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className={cn("text-xs font-semibold", tone === "add" ? "text-mint" : "text-coral")}>{title}</div>
          <p className="mt-0.5 text-[10px] text-muted">{hint}</p>
        </div>
        {models.length > 0 && <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={disabled} onClick={() => onChange(allSelected ? [] : [...models])}>{allSelected ? "取消全选" : "全选"}</Button>}
      </div>
      {models.length === 0 ? (
        <p className="mt-2 rounded-[8px] border border-dashed border-border-subtle px-3 py-3 text-center text-[11px] text-muted">无</p>
      ) : (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-[9px] border border-border-subtle bg-surface-solid p-2">
          {models.map((model) => {
            const checked = selectedSet.has(model);
            const id = `model-${idPrefix}-${tone}-${encodeURIComponent(model)}`;
            return (
              <label key={model} htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-[7px] px-2 py-1.5 text-xs text-secondary hover:bg-surface-2 hover:text-text">
                <Checkbox id={id} name={`${tone}Models`} className="mt-0.5" checked={checked} disabled={disabled} onChange={() => onChange(checked ? selected.filter((item) => item !== model) : [...selected, model])} />
                <span className="min-w-0 break-all font-data leading-relaxed">{model}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
