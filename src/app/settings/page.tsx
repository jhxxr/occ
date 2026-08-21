"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Shield,
  Coins,
  Timer,
  KeyRound,
  Copy,
  Check,
  Plus,
  Trash2,
  Ban,
} from "lucide-react";

interface PublicApiTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AutoSyncBackoffEntry {
  key: string;
  name: string;
  failures: number;
  nextAt: string;
  lastAt: string;
  lastError: string;
  failureClass: "credential" | "rate-limit" | "network";
}

interface AutoSyncStatus {
  config: {
    enabled: boolean;
    intervalMinutes: number;
    scope: "all" | "upstream";
    stealthRandom: boolean;
  };
  hardDisabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastOk: number | null;
  lastFail: number | null;
  lastSkipped: number | null;
  lastRateLimited: boolean;
  backoff: AutoSyncBackoffEntry[];
}

/** 与 auto-sync.ts 的 MIN_INTERVAL_MINUTES 对齐；服务端 zod 才是硬校验 */
const MIN_AUTO_INTERVAL = 15;

const FAILURE_CLASS_LABEL: Record<AutoSyncBackoffEntry["failureClass"], string> = {
  credential: "凭据失效 · 需人工处理",
  "rate-limit": "被上游限流",
  network: "连接失败",
};

function timeOf(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN");
}

export default function SettingsPage() {
  const [usdCny, setUsdCny] = useState("7.2");
  const [sub2ProxyUrl, setSub2ProxyUrl] = useState("");
  const [sub2ProxyConfigured, setSub2ProxyConfigured] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [usdCnyDirty, setUsdCnyDirty] = useState(false);
  const [sub2ProxyDirty, setSub2ProxyDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 自动同步
  const [autoSync, setAutoSync] = useState<AutoSyncStatus | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoInterval, setAutoInterval] = useState("60");
  const [autoScope, setAutoScope] = useState<"all" | "upstream">("all");
  const [autoStealth, setAutoStealth] = useState(false);
  const [autoDirty, setAutoDirty] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);

  // 对外 API Token（鉴权 /api/status-page/<token> 与 /api/public/group-uptime）
  const [tokens, setTokens] = useState<PublicApiTokenRow[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("官网状态页");
  const [tokenExpiry, setTokenExpiry] = useState<"never" | "90" | "365">("never");
  const [tokenCreating, setTokenCreating] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokenBusyId, setTokenBusyId] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    setTokensLoading(true);
    setTokensError(null);
    try {
      const res = await fetch("/api/settings/api-tokens", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载 Token 失败");
      setTokens((json.data as PublicApiTokenRow[]) || []);
    } catch (error) {
      setTokensError(error instanceof Error ? error.message : "加载 Token 失败");
    } finally {
      setTokensLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoaded(false);
    setSettingsLoadError(null);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载设置失败");
      if (json.data?.usdCny == null) throw new Error("汇率设置缺失");
      setUsdCny(String(json.data.usdCny));
      setSub2ProxyUrl(String(json.data.sub2ProxyUrl || ""));
      setSub2ProxyConfigured(!!json.data.sub2ProxyConfigured);
      if (json.data.autoSync) {
        const status = json.data.autoSync as AutoSyncStatus;
        setAutoSync(status);
        setAutoEnabled(status.config.enabled);
        setAutoInterval(String(status.config.intervalMinutes));
        setAutoScope(status.config.scope);
        setAutoStealth(status.config.stealthRandom === true);
        setAutoDirty(false);
      }
      setUsdCnyDirty(false);
      setSub2ProxyDirty(false);
      setSettingsLoaded(true);
    } catch (error) {
      setSettingsLoadError(
        error instanceof Error ? error.message : "加载设置失败",
      );
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadSettings);
    void Promise.resolve().then(loadTokens);
  }, [loadSettings, loadTokens]);

  async function createToken(e: FormEvent) {
    e.preventDefault();
    setTokenCreating(true);
    setTokenMsg(null);
    setCreatedToken(null);
    setCopied(false);
    try {
      const body: { name: string; expiresInDays?: number | null } = {
        name: tokenName.trim() || "对外分组 Uptime",
      };
      if (tokenExpiry !== "never") {
        body.expiresInDays = Number(tokenExpiry);
      } else {
        body.expiresInDays = null;
      }
      const res = await fetch("/api/settings/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "创建失败");
      const raw = String(json.data?.token || "");
      if (!raw) throw new Error("服务端未返回明文 Token");
      setCreatedToken(raw);
      setTokenMsg("Token 已生成，请立即复制保存，关闭后无法再查看明文。");
      await loadTokens();
    } catch (err) {
      setTokenMsg(err instanceof Error ? err.message : "创建失败");
    } finally {
      setTokenCreating(false);
    }
  }

  async function patchToken(
    id: string,
    action: "revoke" | "enable" | "disable" | "delete",
  ) {
    setTokenBusyId(id);
    setTokenMsg(null);
    try {
      const res = await fetch("/api/settings/api-tokens", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "操作失败");
      setTokenMsg(
        action === "delete"
          ? "已删除"
          : action === "revoke"
            ? "已吊销"
            : action === "enable"
              ? "已启用"
              : "已停用",
      );
      await loadTokens();
    } catch (err) {
      setTokenMsg(err instanceof Error ? err.message : "操作失败");
    } finally {
      setTokenBusyId(null);
    }
  }

  async function copyCreatedToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setTokenMsg("复制失败，请手动选中复制");
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!settingsLoaded) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(usdCnyDirty ? { usdCny: Number(usdCny) } : {}),
          ...(sub2ProxyDirty ? { sub2ProxyUrl } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      setSub2ProxyConfigured(!!sub2ProxyUrl.trim());
      setUsdCnyDirty(false);
      setSub2ProxyDirty(false);
      setMsg("设置已保存");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveAutoSync(e: FormEvent) {
    e.preventDefault();
    setAutoSaving(true);
    setAutoMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoSync: {
            enabled: autoEnabled,
            intervalMinutes: Number(autoInterval),
            scope: autoScope,
            stealthRandom: autoStealth,
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      if (json.data?.autoSync) setAutoSync(json.data.autoSync as AutoSyncStatus);
      setAutoDirty(false);
      setAutoMsg(autoEnabled ? "自动同步已开启" : "自动同步已关闭");
    } catch (err) {
      setAutoMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setAutoSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="系统设置"
        subtitle="汇率、加密、自动同步与对外 API Token"
        showSync={false}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
              <Coins className="h-4 w-4 text-amber" />
              汇率与折算
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="usdCny">备用折算率（面值→人民币）</Label>
                <Input
                  id="usdCny"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={usdCny}
                  disabled={!settingsLoaded}
                  onChange={(e) => {
                    setUsdCny(e.target.value);
                    setUsdCnyDirty(true);
                  }}
                />
                <p className="text-xs text-muted leading-relaxed">
                  界面统一显示人民币。上游优先用各站「购入成本」；仅当下游选择「面值×汇率」时使用此备用折算率。你的自营站 1:1
                  充值不走这里。
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sub2ProxyUrl">Sub2API 登录代理（可选）</Label>
                <Input
                  id="sub2ProxyUrl"
                  type="text"
                  autoComplete="off"
                  value={sub2ProxyUrl}
                  disabled={!settingsLoaded}
                  onChange={(e) => {
                    setSub2ProxyUrl(e.target.value);
                    setSub2ProxyDirty(true);
                  }}
                  placeholder="socks5://user:password@127.0.0.1:1080"
                />
                <p className="text-xs text-muted leading-relaxed">
                  仅用于第三方 Sub2API 的登录、刷新 JWT 与同步请求，可填
                  <code className="font-data text-cyan">http://</code>、
                  <code className="font-data text-cyan">https://</code> 或
                  <code className="font-data text-cyan">socks5://</code> 地址。
                  {sub2ProxyConfigured && " 已保存的账号密码会脱敏显示；清空后保存即可停用代理。"}
                </p>
              </div>
              {settingsLoadError && (
                <div className="flex items-center gap-3 text-xs text-coral">
                  <span>{settingsLoadError}，现有设置不会被覆盖。</span>
                  <Button type="button" size="sm" variant="secondary" onClick={loadSettings}>
                    重试
                  </Button>
                </div>
              )}
              {msg && <p className="text-xs text-secondary">{msg}</p>}
              <Button
                type="submit"
                disabled={
                  saving ||
                  !settingsLoaded ||
                  (!usdCnyDirty && !sub2ProxyDirty)
                }
              >
                {saving ? "保存中…" : "保存设置"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
              <Shield className="h-4 w-4 text-cyan" />
              安全说明
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-secondary leading-relaxed">
            <p>
              API Key 使用 AES-256-GCM 加密后写入本地 SQLite（
              <code className="font-data text-xs text-cyan">prisma/dev.db</code>
              ）。
            </p>
            <p>
              请在 <code className="font-data text-xs text-cyan">.env</code> 中设置
              强随机 <code className="font-data text-xs">ENCRYPTION_SECRET</code>
              ，并避免将数据库与密钥提交到公开仓库。
            </p>
            <p className="text-xs text-muted">
              利润公式（人民币）：上游成本 = Σ(增量消耗面值 × 购入成本)；净利润 =
              下游收入 − 上游成本。首次同步不把历史消耗计为当日成本。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 对外 API Token */}
      <Card className="border-cyan/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
            <KeyRound className="h-4 w-4 text-cyan" />
            对外 API Token
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs leading-relaxed text-muted">
            用于鉴权公开 Uptime 接口。只返回中转站「分组」24h 可用性，不含具体上游渠道。
            时区固定
            <code className="mx-1 font-data text-cyan">Asia/Shanghai</code>
            。Token 明文仅在创建时显示一次，数据库只存 hash。
          </p>

          <div className="rounded-[var(--r-md)] border border-border-subtle bg-surface-2/60 px-3 py-2.5 text-xs text-secondary">
            <p className="font-semibold text-text">NewAPI Uptime 绑定（推荐）</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              对齐 Uptime Kuma 状态页 URL：把 Token 直接放进路径当 slug，无需 Header / Query。
            </p>
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-data text-[11px] leading-relaxed text-cyan">
{`URL  = https://你的控制台域名
Slug = occ_xxxxxxxx

实际请求：
  GET /api/status-page/occ_xxxxxxxx
  GET /api/status-page/heartbeat/occ_xxxxxxxx`}
            </pre>
            <p className="mt-2 font-semibold text-text">原始 JSON（可选）</p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-data text-[11px] leading-relaxed text-cyan">
{`curl -H "Authorization: Bearer occ_xxx" \\
  https://你的控制台域名/api/public/group-uptime`}
            </pre>
          </div>

          <form onSubmit={createToken} className="grid gap-3 sm:grid-cols-[1fr_8rem_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="tokenName">名称</Label>
              <Input
                id="tokenName"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="官网状态页"
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tokenExpiry">有效期</Label>
              <Select
                id="tokenExpiry"
                value={tokenExpiry}
                onChange={(e) =>
                  setTokenExpiry(e.target.value as "never" | "90" | "365")
                }
              >
                <option value="never">永不过期</option>
                <option value="90">90 天</option>
                <option value="365">365 天</option>
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={tokenCreating} className="w-full sm:w-auto">
                <Plus className="h-3.5 w-3.5" />
                {tokenCreating ? "生成中…" : "生成 Token"}
              </Button>
            </div>
          </form>

          {createdToken && (
            <div className="rounded-[var(--r-md)] border border-mint/30 bg-mint/10 px-3 py-3">
              <p className="text-xs font-semibold text-mint">
                新 Token（只显示一次）
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded-md bg-surface-solid px-2.5 py-2 font-data text-[12px] text-text">
                  {createdToken}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void copyCreatedToken()}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
            </div>
          )}

          {tokenMsg && <p className="text-xs text-secondary">{tokenMsg}</p>}
          {tokensError && (
            <div className="flex items-center gap-3 text-xs text-coral">
              <span>{tokensError}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void loadTokens()}>
                重试
              </Button>
            </div>
          )}

          <div className="space-y-2 border-t border-border-subtle pt-3">
            <p className="text-xs font-semibold text-secondary">已生成的 Token</p>
            {tokensLoading ? (
              <p className="text-xs text-muted">加载中…</p>
            ) : tokens.length === 0 ? (
              <p className="text-xs text-muted">还没有 Token，生成后给另一个网站调用。</p>
            ) : (
              <ul className="space-y-2">
                {tokens.map((t) => {
                  const revoked = !!t.revokedAt;
                  const expired =
                    !!t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now();
                  const status = revoked
                    ? "已吊销"
                    : expired
                      ? "已过期"
                      : t.enabled
                        ? "有效"
                        : "已停用";
                  const busy = tokenBusyId === t.id;
                  return (
                    <li
                      key={t.id}
                      className="flex flex-col gap-2 rounded-[var(--r-md)] border border-border-subtle bg-surface-2/50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-text">{t.name}</span>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                              revoked || expired
                                ? "bg-coral/12 text-coral"
                                : t.enabled
                                  ? "bg-mint/12 text-mint"
                                  : "bg-surface-3 text-muted",
                            )}
                          >
                            {status}
                          </span>
                        </div>
                        <p className="mt-1 font-data text-[11px] text-muted">
                          {t.tokenPrefix}… · {t.scopes.join(", ")} · 创建{" "}
                          {timeOf(t.createdAt)}
                          {t.lastUsedAt ? ` · 最近使用 ${timeOf(t.lastUsedAt)}` : ""}
                          {t.expiresAt ? ` · 到期 ${timeOf(t.expiresAt)}` : " · 永不过期"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {!revoked && t.enabled && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void patchToken(t.id, "disable")}
                          >
                            停用
                          </Button>
                        )}
                        {!revoked && !t.enabled && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void patchToken(t.id, "enable")}
                          >
                            启用
                          </Button>
                        )}
                        {!revoked && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void patchToken(t.id, "revoke")}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            吊销
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`确定删除 Token「${t.name}」？`)) {
                              void patchToken(t.id, "delete");
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 自动同步 */}
      <Card className="border-violet/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
            <Timer className="h-4 w-4 text-violet" />
            自动同步
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs leading-relaxed text-muted">
            默认关闭。开启后按下面的间隔在后台自动跑一轮同步，跟你点「全量同步」做的事一样。
            上游是别人的站，所以带了一套护栏：间隔下限 {autoSync ? MIN_AUTO_INTERVAL : 15} 分钟、
            每轮时间加抖动避免固定时刻、同一主机的请求串行且留间隔、命中限流按
            <code className="font-data text-cyan"> Retry-After </code>
            整站退避、连续失败的目标指数退避（凭据类直接退到 6 小时并标出来等你处理）。
            可选「同态随机同步」会加大抖动、打乱目标顺序并在目标之间随机停顿，降低被上游识别为固定脚本巡检的特征。
            <strong className="text-secondary">手动同步不受退避与同态随机影响，随时可以点。</strong>
          </p>

          {autoSync?.hardDisabled && (
            <p className="rounded-[var(--r-md)] border border-warn/25 bg-warn/10 px-3 py-2 text-xs text-warn">
              当前部署设了 <code className="font-data">AUTO_SYNC_ENABLED=false</code>
              ，自动同步被环境变量硬关，下面的开关不会生效。
            </p>
          )}

          <form onSubmit={saveAutoSync} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="autoEnabled">状态</Label>
                <Select
                  id="autoEnabled"
                  value={autoEnabled ? "on" : "off"}
                  onChange={(e) => {
                    setAutoEnabled(e.target.value === "on");
                    setAutoDirty(true);
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="on">开启</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="autoInterval">间隔（分钟）</Label>
                <Input
                  id="autoInterval"
                  type="number"
                  min={MIN_AUTO_INTERVAL}
                  max={1440}
                  step="5"
                  value={autoInterval}
                  onChange={(e) => {
                    setAutoInterval(e.target.value);
                    setAutoDirty(true);
                  }}
                />
                <p className="text-xs text-muted">
                  不能小于 {MIN_AUTO_INTERVAL} 分钟
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="autoScope">范围</Label>
                <Select
                  id="autoScope"
                  value={autoScope}
                  onChange={(e) => {
                    setAutoScope(e.target.value === "upstream" ? "upstream" : "all");
                    setAutoDirty(true);
                  }}
                >
                  <option value="all">全部（上游 + 下游）</option>
                  <option value="upstream">仅上游</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="autoStealth">同态随机同步</Label>
                <Select
                  id="autoStealth"
                  value={autoStealth ? "on" : "off"}
                  onChange={(e) => {
                    setAutoStealth(e.target.value === "on");
                    setAutoDirty(true);
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="on">开启</option>
                </Select>
                <p className="text-xs text-muted">
                  打乱顺序与节奏，降低脚本巡检特征
                </p>
              </div>
            </div>

            {autoMsg && <p className="text-xs text-secondary">{autoMsg}</p>}
            <Button type="submit" disabled={autoSaving || !autoDirty}>
              {autoSaving ? "保存中…" : "保存自动同步设置"}
            </Button>
          </form>

          {autoSync && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              <div className="grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
                <p>
                  上次运行：
                  <span className="font-data text-secondary">
                    {timeOf(autoSync.lastFinishedAt)}
                  </span>
                  {autoSync.lastOk != null && (
                    <span className="font-data text-secondary">
                      {" "}
                      · {autoSync.lastOk} 成功 / {autoSync.lastFail ?? 0} 失败
                      {autoSync.lastSkipped ? ` · 跳过 ${autoSync.lastSkipped}` : ""}
                    </span>
                  )}
                </p>
                <p>
                  下次预计：
                  <span className="font-data text-secondary">
                    {autoSync.config.enabled ? timeOf(autoSync.nextRunAt) : "未开启"}
                  </span>
                  {autoSync.config.enabled && autoSync.config.stealthRandom && (
                    <span className="font-data text-secondary"> · 同态随机</span>
                  )}
                </p>
              </div>
              {autoSync.lastRateLimited && (
                <p className="text-xs text-warn">
                  上一轮命中了上游限流，下一轮已自动延后。
                </p>
              )}
              {autoSync.backoff.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-secondary">
                    退避中的目标（自动同步会跳过，手动仍可同步）
                  </p>
                  {autoSync.backoff.map((entry) => (
                    <div
                      key={entry.key}
                      className={cn(
                        "rounded-[var(--r-md)] border px-2.5 py-1.5 text-xs",
                        entry.failureClass === "credential"
                          ? "border-coral/25 bg-coral/10 text-coral"
                          : "border-warn/25 bg-warn/10 text-warn",
                      )}
                    >
                      <span className="font-medium">{entry.name}</span>
                      <span className="font-data">
                        {" "}
                        · {FAILURE_CLASS_LABEL[entry.failureClass]} · 连续失败{" "}
                        {entry.failures} 次 · {timeOf(entry.nextAt)} 后重试
                      </span>
                      {entry.lastError && (
                        <span className="block opacity-80">{entry.lastError}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
