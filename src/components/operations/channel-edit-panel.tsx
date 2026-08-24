"use client";

import { useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { errorOf, readJson } from "@/lib/sync-client";

/**
 * 渠道完整编辑面板：展开行里直接改名称 / Base URL / 模型 / 分组 /
 * 权重优先级等，并支持启停、测速、删除。Key 默认不回填（服务端不返回
 * 凭证），留空 = 不改动；只有显式填写才会替换。
 */
export function ChannelEditPanel({
  siteId,
  channelId,
  channel,
  onChanged,
}: {
  siteId: string;
  channelId: number;
  channel: {
    name: string;
    group: string;
    models: string[];
    priority: number;
    weight?: number;
    enabled: boolean;
    autoBan: boolean;
    remark?: string;
  };
  onChanged: () => void;
}) {
  // 用 key 绑定渠道数据：刷新列表后父组件传入新渠道时整体重置表单，
  // 避免「保存成功但表单还停留在旧值」或残留上一次的编辑。
  return (
    <ChannelEditPanelInner
      key={`${siteId}:${channelId}:${channel.name}:${channel.models.length}:${channel.priority}:${channel.enabled}`}
      siteId={siteId}
      channelId={channelId}
      channel={channel}
      onChanged={onChanged}
    />
  );
}

function ChannelEditPanelInner({
  siteId,
  channelId,
  channel,
  onChanged,
}: {
  siteId: string;
  channelId: number;
  channel: {
    name: string;
    group: string;
    models: string[];
    priority: number;
    weight?: number;
    enabled: boolean;
    autoBan: boolean;
    remark?: string;
  };
  onChanged: () => void;
}) {
  const base = `/api/channels/${encodeURIComponent(siteId)}/${channelId}`;
  const [name, setName] = useState(channel.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [group, setGroup] = useState(channel.group);
  const [modelsText, setModelsText] = useState(channel.models.join(","));
  const [priority, setPriority] = useState(String(channel.priority));
  const [weight, setWeight] = useState(String(channel.weight ?? 0));
  const [autoBan, setAutoBan] = useState(channel.autoBan);
  const [remark, setRemark] = useState(channel.remark || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const modelList = useMemo(
    () => modelsText.split(/[\n,]+/).map((m) => m.trim()).filter(Boolean),
    [modelsText],
  );

  const save = async () => {
    if (!name.trim()) { setError("渠道名称不能为空"); return; }
    if (modelList.length === 0) { setError("至少保留一个模型"); return; }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        models: modelList,
        group: group.trim() || "default",
        priority: Number(priority) || 0,
        weight: Number(weight) || 0,
        autoBan: autoBan ? 1 : 0,
        remark: remark.trim(),
      };
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      if (key.trim()) body.key = key.trim();
      const response = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await readJson(response);
      if (!response.ok) throw new Error(errorOf(json, `HTTP ${response.status}`));
      setBaseUrl("");
      setKey("");
      setMessage("已保存；刷新列表后生效");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const doAction = async (action: "enable" | "disable" | "test") => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${base}?action=${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await readJson(response);
      if (!response.ok) throw new Error(errorOf(json, `HTTP ${response.status}`));
      setMessage(
        action === "test"
          ? `测速完成：${(json.data as { message?: string })?.message || "成功"}`
          : action === "enable"
            ? "已启用"
            : "已禁用",
      );
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`确认删除渠道「${channel.name}」(#${channelId})？此操作不可恢复。`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(base, { method: "DELETE" });
      const json = await readJson(response);
      if (!response.ok) throw new Error(errorOf(json, `HTTP ${response.status}`));
      setMessage("已删除；正在刷新列表");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[12px] border border-border-subtle bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
          <Pencil className="h-3.5 w-3.5" /> 渠道编辑
          <Badge variant={channel.enabled ? "mint" : "coral"}>{channel.enabled ? "启用" : "停用"}</Badge>
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant={channel.enabled ? "outline" : "default"} disabled={busy} onClick={() => void doAction(channel.enabled ? "disable" : "enable")}>
            {channel.enabled ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {channel.enabled ? "禁用" : "启用"}
          </Button>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void doAction("test")}>
            <Play className="h-3.5 w-3.5" /> 测速
          </Button>
          <Button type="button" size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
            <Trash2 className="h-3.5 w-3.5" /> 删除
          </Button>
        </div>
      </div>

      {(message || error) && (
        <div className="mt-3 text-xs" role={error ? "alert" : "status"}>
          {message && <p className="font-data text-mint">{message}</p>}
          {error && <p className="text-coral">{error}</p>}
        </div>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>渠道名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>
        <div className="space-y-1.5">
          <Label>分组</Label>
          <Input value={group} onChange={(e) => setGroup(e.target.value)} disabled={busy} placeholder="default" />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label>模型（逗号或换行分隔，可自由增删）· 当前 {channel.models.length} 个</Label>
          <Textarea value={modelsText} onChange={(e) => setModelsText(e.target.value)} disabled={busy} className="min-h-[72px] font-data text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label>Base URL（留空不改动）</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} placeholder="不修改则留空" />
        </div>
        <div className="space-y-1.5">
          <Label>渠道 Key（留空不改动）</Label>
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} placeholder="仅更换凭据时填写" autoComplete="new-password" />
        </div>
        <div className="space-y-1.5">
          <Label>优先级</Label>
          <Input type="number" min="0" value={priority} onChange={(e) => setPriority(e.target.value)} disabled={busy} />
        </div>
        <div className="space-y-1.5">
          <Label>权重</Label>
          <Input type="number" min="0" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} />
        </div>
        <label htmlFor={`autoban-${siteId}-${channelId}`} className="flex items-center gap-2 text-xs text-secondary md:col-span-2">
          <input id={`autoban-${siteId}-${channelId}`} type="checkbox" checked={autoBan} disabled={busy} onChange={(e) => setAutoBan(e.target.checked)} className="h-4 w-4 shrink-0 cursor-pointer rounded-[5px] border-border accent-[var(--accent)]" />
          自动封禁（AutoBan）：请求异常时自动禁用该渠道
        </label>
        <div className="space-y-1.5 md:col-span-2">
          <Label>备注</Label>
          <Input value={remark} onChange={(e) => setRemark(e.target.value)} disabled={busy} placeholder="可选" />
        </div>
      </div>

      <div className="mt-4 flex justify-end border-t border-border-subtle pt-3">
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存全部修改
        </Button>
      </div>
    </section>
  );
}
