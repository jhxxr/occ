"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorOf, readJson } from "@/lib/sync-client";

type KeyMode = "bound" | "provider" | "manual";

interface Source {
  providerId: string;
  providerName: string;
  type: string;
  baseUrl: string;
  providerKeyAvailable: boolean;
  boundKeys: { id: string; name: string; keyPreview: string }[];
}

export function ChannelCreateDialog({ siteId, onCreated }: { siteId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [providerId, setProviderId] = useState("");
  const [keyMode, setKeyMode] = useState<KeyMode>("manual");
  const [boundKeyId, setBoundKeyId] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [group, setGroup] = useState("default");
  const [priority, setPriority] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const provider = sources.find((item) => item.providerId === providerId);
  const modelList = useMemo(
    () => models.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
    [models],
  );

  useEffect(() => {
    if (!open) return;
    void fetch(`/api/channels/${encodeURIComponent(siteId)}/sources`, { cache: "no-store" })
      .then(async (response) => {
        const json = await readJson(response);
        if (!response.ok) throw new Error(errorOf(json, "读取上游来源失败"));
        setSources((json.data as Source[]) || []);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "读取上游来源失败"));
  }, [open, siteId]);

  const chooseProvider = (id: string) => {
    setProviderId(id);
    setManualKey("");
    const next = sources.find((item) => item.providerId === id);
    setBaseUrl(next?.baseUrl || "");
    setBoundKeyId(next?.boundKeys[0]?.id || "");
    if (next?.boundKeys.length) setKeyMode("bound");
    else if (next?.providerKeyAvailable) setKeyMode("provider");
    else setKeyMode("manual");
  };

  const submit = async () => {
    if (!providerId || !name.trim() || !baseUrl.trim() || !modelList.length) {
      setError("请填写上游来源、名称、Base URL 和至少一个模型");
      return;
    }
    if (keyMode === "bound" && !boundKeyId) {
      setError("请选择一个已登记的绑定 Key，或改用其他 Key 来源");
      return;
    }
    if (keyMode === "provider" && !provider?.providerKeyAvailable) {
      setError("该上游没有可用的主 Key，请改为手动输入");
      return;
    }
    if (keyMode === "manual" && !manualKey.trim()) {
      setError("请输入本次创建渠道要使用的 Key");
      return;
    }
    if (!window.confirm(`确认在当前下游创建渠道“${name.trim()}”吗？`)) return;

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(siteId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          keyMode,
          ...(keyMode === "bound" ? { boundKeyId } : {}),
          ...(keyMode === "manual" ? { manualKey: manualKey.trim() } : {}),
          name: name.trim(),
          type: 1,
          baseUrl: baseUrl.trim(),
          models: modelList,
          group: group.trim() || "default",
          priority: Number(priority) || 0,
          status: 1,
          autoBan: 0,
        }),
      });
      const json = await readJson(response);
      if (!response.ok) throw new Error(errorOf(json, "创建渠道失败"));
      setOpen(false);
      setName("");
      setModels("");
      setManualKey("");
      setBoundKeyId("");
      setProviderId("");
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建渠道失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return <Button size="sm" onClick={() => { setOpen(true); setError(null); }}><Plus className="h-3.5 w-3.5" />新建下游渠道</Button>;
  }

  return (
    <Card className="border-accent/40">
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-sm">新建下游渠道</CardTitle>
          <p className="mt-1 text-xs text-muted">可选已有 Key 或直接粘贴；已保存的凭据不会返回浏览器。</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setManualKey(""); }}>取消</Button>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        {error && <Callout tone="error" className="md:col-span-2">{error}</Callout>}
        <div className="space-y-1.5">
          <Label>上游来源</Label>
          <Select value={providerId} onChange={(event) => chooseProvider(event.target.value)}>
            <option value="">选择上游</option>
            {sources.map((item) => <option key={item.providerId} value={item.providerId}>{item.providerName} · {item.type}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Key 来源</Label>
          <Select value={keyMode} onChange={(event) => { setKeyMode(event.target.value as KeyMode); setManualKey(""); }} disabled={!provider}>
            <option value="bound" disabled={!provider?.boundKeys.length}>已登记绑定 Key{provider && !provider.boundKeys.length ? "（无）" : ""}</option>
            <option value="provider" disabled={!provider?.providerKeyAvailable}>上游主 Key{provider && !provider.providerKeyAvailable ? "（未配置）" : ""}</option>
            <option value="manual">手动输入 Key</option>
          </Select>
        </div>

        {keyMode === "bound" && (
          <div className="space-y-1.5 md:col-span-2">
            <Label>绑定 Key</Label>
            <Select value={boundKeyId} onChange={(event) => setBoundKeyId(event.target.value)} disabled={!provider}>
              <option value="">选择绑定 Key</option>
              {(provider?.boundKeys || []).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.keyPreview}</option>)}
            </Select>
          </div>
        )}
        {keyMode === "provider" && (
          <Callout tone="info" className="md:col-span-2" title="使用上游主 Key">Orbit 将在服务端解密该上游已配置的主 Key，并直接写入新渠道；浏览器看不到明文。</Callout>
        )}
        {keyMode === "manual" && (
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="channel-manual-key">手动输入 Key</Label>
            <div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" /><Input id="channel-manual-key" type="password" autoComplete="new-password" className="pl-9 font-data" value={manualKey} onChange={(event) => setManualKey(event.target.value)} placeholder="sk-...（仅用于本次创建，不保存到 Orbit）" /></div>
            <p className="text-[10px] text-muted">手动 Key 不会自动登记为成本 Key；创建成功后立即从表单清除。</p>
          </div>
        )}

        <div className="space-y-1.5"><Label>渠道名称</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="OpenAI 主线路" /></div>
        <div className="space-y-1.5"><Label>Base URL</Label><Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com" /></div>
        <div className="space-y-1.5 md:col-span-2"><Label>模型（逗号或换行分隔）</Label><Textarea value={models} onChange={(event) => setModels(event.target.value)} placeholder="gpt-4o\ngpt-4o-mini" /></div>
        <div className="space-y-1.5"><Label>分组</Label><Input value={group} onChange={(event) => setGroup(event.target.value)} /></div>
        <div className="space-y-1.5"><Label>优先级</Label><Input type="number" min="0" value={priority} onChange={(event) => setPriority(event.target.value)} /></div>
        <div className="md:col-span-2"><Button disabled={saving} onClick={() => void submit()}>{saving ? "创建并回读中…" : "确认创建"}</Button></div>
      </CardContent>
    </Card>
  );
}
