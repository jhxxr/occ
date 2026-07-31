"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { formatRmb, cn } from "@/lib/utils";
import {
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  Database,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  Wallet,
} from "lucide-react";

interface Group {
  id: number;
  name: string;
  description?: string;
  platform?: string;
  rate_multiplier: number;
  status?: string;
  allow_image_generation?: boolean;
  image_rate_multiplier?: number;
  subscription_type?: string;
}

interface ApiKeyRow {
  id: number;
  key: string;
  name: string;
  group_id: number | null;
  status: string;
  last_used_at?: string | null;
  quota?: number;
  quota_used?: number;
  group?: Group | null;
  countAsCost?: boolean;
  totalActualCost?: number;
  todayActualCost?: number;
  costRmbTotal?: number;
  costRmbToday?: number;
}

interface ProviderMeta {
  id: string;
  name: string;
  baseUrl: string;
  type: string;
  lastBalance: number | null;
  discountRate?: number;
  accountEmail: string | null;
}

function rateLabel(n: number | undefined | null) {
  if (n == null) return "—";
  return `${n}x`;
}

function platformVariant(
  p?: string,
): "cyan" | "mint" | "amber" | "violet" | "coral" | "default" {
  switch ((p || "").toLowerCase()) {
    case "openai":
      return "mint";
    case "anthropic":
      return "amber";
    case "gemini":
      return "violet";
    case "grok":
      return "coral";
    case "image":
      return "amber";
    default:
      return "cyan";
  }
}

/** 生图/图片专用分组：按名称识别，不把仅 allow_image_generation 的对话组算进来 */
function isImageGroup(g: Group): boolean {
  const text = `${g.name || ""} ${g.description || ""} ${g.platform || ""}`;
  return /生图|image\b|img\b|banana|香蕉|dall|midjourney|flux/i.test(text);
}

/** 分类排序权重：对话模型按常见平台，图片单独一类靠后 */
const CATEGORY_ORDER: Record<string, number> = {
  openai: 10,
  anthropic: 20,
  gemini: 30,
  google: 30,
  grok: 40,
  xai: 40,
  image: 90,
  other: 100,
};

function groupCategory(g: Group): { key: string; label: string } {
  if (isImageGroup(g)) return { key: "image", label: "生图 / 图片" };
  const p = (g.platform || "").toLowerCase();
  if (p === "openai") return { key: "openai", label: "OpenAI / GPT" };
  if (p === "anthropic") return { key: "anthropic", label: "Anthropic / Claude" };
  if (p === "gemini" || p === "google") return { key: "gemini", label: "Gemini" };
  if (p === "grok" || p === "xai") return { key: "grok", label: "Grok" };
  if (p) return { key: p, label: p };
  return { key: "other", label: "其他" };
}

function compareGroups(a: Group, b: Group): number {
  const ca = groupCategory(a);
  const cb = groupCategory(b);
  const oa = CATEGORY_ORDER[ca.key] ?? 80;
  const ob = CATEGORY_ORDER[cb.key] ?? 80;
  if (oa !== ob) return oa - ob;
  if (ca.key !== cb.key) return ca.key.localeCompare(cb.key);
  // 同类型：低倍率在前
  const ra = a.rate_multiplier ?? 0;
  const rb = b.rate_multiplier ?? 0;
  if (ra !== rb) return ra - rb;
  return (a.name || "").localeCompare(b.name || "", "zh-CN");
}

function maskKey(k: string) {
  if (!k || k.length < 12) return "••••";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export default function Sub2ManagePage() {
  const params = useParams();
  const id = String(params.id || "");

  const [provider, setProvider] = useState<ProviderMeta | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [billableKeys, setBillableKeys] = useState(0);
  const [billableCostRmb, setBillableCostRmb] = useState(0);
  const [newName, setNewName] = useState("");
  const [newGroupId, setNewGroupId] = useState<string>("");

  const groupMap = useMemo(() => {
    const m = new Map<number, Group>();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [provRes, dataRes] = await Promise.all([
        fetch("/api/providers"),
        fetch(`/api/upstream/${id}/sub2`),
      ]);
      const provJson = await provRes.json();
      const dataJson = await dataRes.json();
      if (!dataRes.ok) throw new Error(dataJson.error || "加载失败");

      const p = (provJson.data || []).find((x: ProviderMeta) => x.id === id);
      setProvider(p || { id, name: "上游", baseUrl: "", type: "SUB2API", lastBalance: null, accountEmail: null });
      setGroups(dataJson.data.groups || []);
      setKeys(dataJson.data.keys || []);
      setBillableKeys(dataJson.data.billable_keys || 0);
      setBillableCostRmb(dataJson.data.billable_cost_rmb || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void Promise.resolve().then(load);
  }, [id, load]);

  async function switchGroup(keyId: number, groupId: number) {
    setBusy(`key-${keyId}`);
    setMsg(null);
    try {
      const res = await fetch(`/api/upstream/${id}/sub2/keys/${keyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "切换分组失败");
      setMsg(`已将 Key #${keyId} 切换到分组 ${json.data?.group?.name || groupId}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换失败");
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus(key: ApiKeyRow) {
    const next = key.status === "active" ? "inactive" : "active";
    setBusy(`key-${key.id}`);
    setMsg(null);
    try {
      const res = await fetch(`/api/upstream/${id}/sub2/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "更新状态失败");
      setMsg(`Key「${key.name}」已${next === "active" ? "启用" : "停用"}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(null);
    }
  }

  async function renameKey(key: ApiKeyRow) {
    const name = prompt("新名称", key.name);
    if (!name || name === key.name) return;
    setBusy(`key-${key.id}`);
    try {
      const res = await fetch(`/api/upstream/${id}/sub2/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "重命名失败");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(key: ApiKeyRow) {
    if (!confirm(`确认删除 API Key「${key.name}」？此操作不可恢复。`)) return;
    setBusy(`key-${key.id}`);
    try {
      const res = await fetch(`/api/upstream/${id}/sub2/keys/${key.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "删除失败");
      setMsg(`已删除 ${key.name}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusy(null);
    }
  }

  async function createNewKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const res = await fetch(`/api/upstream/${id}/sub2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          group_id: newGroupId ? Number(newGroupId) : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "创建失败");
      setMsg(`已创建 Key「${json.data?.name}」`);
      setShowCreate(false);
      setNewName("");
      setNewGroupId("");
      // reveal new key once
      if (json.data?.id) {
        setRevealed((r) => ({ ...r, [json.data.id]: true }));
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(null);
    }
  }

  async function toggleCountAsCost(key: ApiKeyRow) {
    const newVal = !key.countAsCost;
    const prevVal = !!key.countAsCost;
    setMsg(null);
    setError(null);

    // 乐观更新：立刻改 UI，不整页刷新
    setKeys((prev) =>
      prev.map((k) => (k.id === key.id ? { ...k, countAsCost: newVal } : k)),
    );
    setBillableKeys((n) => Math.max(0, n + (newVal ? 1 : -1)));
    setBillableCostRmb((n) =>
      Math.max(0, n + (newVal ? 1 : -1) * (key.costRmbTotal || 0)),
    );

    try {
      const res = await fetch(`/api/upstream/${id}/sub2/keys/${key.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ countAsCost: newVal }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "更新失败");
      setMsg(
        newVal
          ? `「${key.name}」已计入中转`
          : `「${key.name}」已取消计入`,
      );
    } catch (e) {
      // 失败回滚该项
      setKeys((prev) =>
        prev.map((k) =>
          k.id === key.id ? { ...k, countAsCost: prevVal } : k,
        ),
      );
      setBillableKeys((n) => Math.max(0, n + (prevVal ? 1 : -1)));
      setBillableCostRmb((n) =>
        Math.max(0, n + (prevVal ? 1 : -1) * (key.costRmbTotal || 0)),
      );
      setError(e instanceof Error ? e.message : "更新失败");
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("已复制到剪贴板");
    } catch {
      setMsg("复制失败，请手动选择");
    }
  }


  // 分类 + 同类型低倍率优先
  const sortedGroups = useMemo(() => [...groups].sort(compareGroups), [groups]);

  const groupedSections = useMemo(() => {
    const sections: { key: string; label: string; items: Group[] }[] = [];
    const index = new Map<string, number>();
    for (const g of sortedGroups) {
      const cat = groupCategory(g);
      let i = index.get(cat.key);
      if (i == null) {
        i = sections.length;
        index.set(cat.key, i);
        sections.push({ key: cat.key, label: cat.label, items: [] });
      }
      sections[i].items.push(g);
    }
    return sections;
  }, [sortedGroups]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-cyan" />
      </div>
    );
  }

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
        <span className="text-text">{provider?.name || "管理"}</span>
      </div>

      <TopBar
        title={`${provider?.name || "Sub2API"} · 密钥与分组`}
        subtitle={
          provider
            ? `${provider.baseUrl} · 余额 ${formatRmb(
                provider.lastBalance != null
                  ? provider.lastBalance * (provider.discountRate ?? 1)
                  : null,
              )} · ${provider.accountEmail || ""}`
            : "管理 API Key 与分组倍率"
        }
        showSync={false}
      />

      <div className="flex flex-wrap items-center gap-2">
        {provider?.baseUrl && (
          <a
            href={provider.baseUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="打开面板网站（充值/订阅）"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            打开网站
          </a>
        )}
        <Link
          href={`/providers/${id}/recharges`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <Wallet className="h-3.5 w-3.5" />
          充值台账
        </Link>
        <Link
          href={`/providers/${id}/usage`}
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          <Database className="h-3.5 w-3.5" />
          使用记录库
        </Link>
        <Button size="sm" variant="secondary" onClick={load} disabled={!!busy}>
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
          刷新
        </Button>
        <Button size="sm" onClick={() => setShowCreate((v) => !v)} variant="secondary">
          <Plus className="h-3.5 w-3.5" />
          新建 API Key
        </Button>
        <span className="text-xs text-muted font-data">
          中转 Key {billableKeys} 个 · 累计成本 {formatRmb(billableCostRmb)}
        </span>
        {msg && <span className="text-xs text-mint font-data">{msg}</span>}
        {error && <span className="text-xs text-coral">{error}</span>}
      </div>

      {showCreate && (
        <Card className="border-cyan/30">
          <CardHeader>
            <CardTitle className="text-base font-semibold text-text normal-case tracking-normal">
              新建 API Key
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={createNewKey}
              className="grid gap-3 sm:grid-cols-3 items-end"
            >
              <div className="space-y-1.5">
                <Label htmlFor="newName">名称</Label>
                <Input
                  id="newName"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如：codex-main"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="newGroup">分组</Label>
                <Select
                  id="newGroup"
                  value={newGroupId}
                  onChange={(e) => setNewGroupId(e.target.value)}
                >
                  <option value="">（默认）</option>
                  {groupedSections.map((section) => (
                    <optgroup key={section.key} label={section.label}>
                      {section.items.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} · {g.rate_multiplier}x
                          {g.description
                            ? ` — ${g.description.replace(/\n/g, " ").slice(0, 28)}`
                            : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy === "create"}>
                  {busy === "create" ? "创建中…" : "创建"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowCreate(false)}
                >
                  取消
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Groups — 按类型分节，同类型低倍率在前；生图单独一类 */}
      <section className="space-y-5">
        <div className="flex items-end justify-between">
          <h2 className="text-sm font-medium tracking-wide text-secondary">
            可用分组与倍率
          </h2>
          <span className="text-xs text-muted font-data">
            {groups.length} 个分组 · 低价优先
          </span>
        </div>

        {groupedSections.map((section) => (
          <div key={section.key} className="space-y-3">
            <div className="flex items-center gap-2 border-b border-border-subtle pb-2">
              <Badge
                variant={
                  section.key === "image"
                    ? "amber"
                    : platformVariant(section.key)
                }
              >
                {section.label}
              </Badge>
              <span className="text-[11px] text-muted font-data">
                {section.items.length} 组 ·{" "}
                {rateLabel(section.items[0]?.rate_multiplier)}
                {section.items.length > 1
                  ? ` → ${rateLabel(section.items[section.items.length - 1]?.rate_multiplier)}`
                  : ""}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {section.items.map((g) => (
                <Card
                  key={g.id}
                  className={cn(
                    "overflow-hidden",
                    section.key === "image" && "border-amber/25",
                  )}
                >
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="font-semibold text-text truncate">
                            {g.name}
                          </h3>
                          <Badge
                            variant={
                              section.key === "image"
                                ? "amber"
                                : platformVariant(g.platform)
                            }
                          >
                            {section.key === "image"
                              ? "生图"
                              : g.platform || "—"}
                          </Badge>
                          {section.key !== "image" &&
                            g.allow_image_generation && (
                              <Badge
                                variant="default"
                                title="allow_image_generation=true：允许生图能力，非生图专用"
                              >
                                可生图
                              </Badge>
                            )}
                        </div>
                        {g.description && (
                          <p className="mt-1 text-[11px] text-muted line-clamp-2 whitespace-pre-line">
                            {g.description}
                          </p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-data text-2xl font-semibold text-cyan">
                          {rateLabel(g.rate_multiplier)}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-muted">
                          倍率
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3 text-[11px] text-secondary font-data">
                      <span>ID {g.id}</span>
                      {g.image_rate_multiplier != null &&
                        g.image_rate_multiplier !== g.rate_multiplier && (
                          <span>图 {g.image_rate_multiplier}x</span>
                        )}
                      {g.subscription_type && <span>{g.subscription_type}</span>}
                      <span>
                        Keys:{" "}
                        {keys.filter((k) => k.group_id === g.id).length}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </section>

      {/* Keys */}
      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <h2 className="text-sm font-medium tracking-wide text-secondary">
            API 密钥
          </h2>
          <span className="text-xs text-muted font-data">{keys.length} 个</span>
        </div>

        <div className="space-y-3">
          {keys.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted">
                暂无 API Key
              </CardContent>
            </Card>
          ) : (
            keys.map((k) => {
              const g = k.group || (k.group_id != null ? groupMap.get(k.group_id) : null);
              const show = !!revealed[k.id];
              return (
                <Card key={k.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-text">{k.name}</h3>
                          <Badge
                            variant={
                              k.status === "active" ? "mint" : "default"
                            }
                          >
                            {k.status}
                          </Badge>
                          {k.countAsCost && (
                            <Badge variant="amber">计入中转</Badge>
                          )}
                          {g && (
                            <Badge variant={platformVariant(g.platform)}>
                              {g.name} · {rateLabel(g.rate_multiplier)}
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 font-data text-xs text-secondary">
                          <span>{show ? k.key : maskKey(k.key)}</span>
                          <button
                            type="button"
                            className="text-muted hover:text-cyan"
                            onClick={() =>
                              setRevealed((r) => ({
                                ...r,
                                [k.id]: !r[k.id],
                              }))
                            }
                            aria-label={show ? "隐藏" : "显示"}
                          >
                            {show ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="text-muted hover:text-cyan"
                            onClick={() => copyText(k.key)}
                            aria-label="复制"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="text-[11px] text-muted">
                          ID {k.id}
                          {k.last_used_at
                            ? ` · 最近使用 ${new Date(k.last_used_at).toLocaleString("zh-CN")}`
                            : " · 尚未使用"}
                        </p>
                        <p className="text-[11px] font-data text-secondary">
                          累计扣费面值 {(k.totalActualCost ?? 0).toFixed(4)}
                          {" · 今日 "}
                          {(k.todayActualCost ?? 0).toFixed(4)}
                          {" · 折合成本 "}
                          <span className={k.countAsCost ? "text-amber" : ""}>
                            {formatRmb(k.costRmbTotal ?? 0)}
                          </span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <label
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 h-8 text-xs cursor-pointer select-none",
                            k.countAsCost
                              ? "border-amber/40 bg-amber/10 text-amber"
                              : "border-border text-secondary hover:border-cyan/40",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={!!k.countAsCost}
                            onChange={() => toggleCountAsCost(k)}
                            className="rounded border-border"
                          />
                          计入中转成本
                        </label>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === `key-${k.id}`}
                          onClick={() => renameKey(k)}
                        >
                          重命名
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === `key-${k.id}`}
                          onClick={() => toggleStatus(k)}
                        >
                          {k.status === "active" ? "停用" : "启用"}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy === `key-${k.id}`}
                          onClick={() => removeKey(k)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-[1fr_auto] items-end">
                      <div className="space-y-1.5">
                        <Label className="text-[11px]">切换分组</Label>
                        <Select
                          value={String(k.group_id ?? "")}
                          disabled={busy === `key-${k.id}`}
                          onChange={(e) => {
                            const gid = Number(e.target.value);
                            if (gid && gid !== k.group_id) switchGroup(k.id, gid);
                          }}
                        >
                          {groupedSections.map((section) => (
                            <optgroup key={section.key} label={section.label}>
                              {section.items.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.name} · {opt.rate_multiplier}x
                                  {opt.description
                                    ? ` — ${opt.description.replace(/\n/g, " ").slice(0, 36)}`
                                    : ""}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                      </div>
                      <div className="text-xs text-muted font-data pb-2">
                        当前倍率{" "}
                        <span className="text-cyan text-sm font-semibold">
                          {rateLabel(g?.rate_multiplier)}
                        </span>
                      </div>
                    </div>

                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </section>

      <p className="text-[11px] text-muted leading-relaxed max-w-2xl">
        <KeyRound className="inline h-3 w-3 mr-1" />
        操作通过你绑定的面板账号 JWT 代理到 Sub2API（
        <code className="font-data text-cyan">/api/v1/groups/available</code>、
        <code className="font-data text-cyan">/api/v1/keys</code>
        ）。切换分组会立即影响该 Key 的计费倍率与可用模型通道。
        勾选「计入中转成本」的 Key 再绑定下游站点/分组，收益报表就能用
        <strong className="text-secondary">倍率法</strong>
        估算这个 Key 赚了多少，并与下游日志实测收入互相校验。
      </p>
    </div>
  );
}
