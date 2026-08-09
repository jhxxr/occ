"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { TopBar } from "@/components/layout/top-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  THead,
  TBody,
  HeadRow,
  TH,
  TR,
  TD,
} from "@/components/ui/table";
import {
  Shield,
  Coins,
  Puzzle,
  Copy,
  Check,
  Plus,
  Trash2,
  Link2,
} from "lucide-react";

interface TokenRow {
  id: string;
  tokenPrefix: string;
  providerId: string | null;
  providerName: string | null;
  label: string;
  enabled: boolean;
  expiresAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}

export default function SettingsPage() {
  const [usdCny, setUsdCny] = useState("7.2");
  const [sub2ProxyUrl, setSub2ProxyUrl] = useState("");
  const [sub2ProxyConfigured, setSub2ProxyConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 扩展注入
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [tokenLabel, setTokenLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [freshWarning, setFreshWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [extError, setExtError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => {
        if (j.data?.usdCny != null) setUsdCny(String(j.data.usdCny));
        if (j.data?.sub2ProxyUrl) setSub2ProxyUrl(String(j.data.sub2ProxyUrl));
        setSub2ProxyConfigured(!!j.data?.sub2ProxyConfigured);
      })
      .catch(() => {});
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/extension/tokens", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "加载失败");
      setTokens(json.data || []);
    } catch (e) {
      setExtError(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadTokens);
  }, [loadTokens]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usdCny: Number(usdCny),
          sub2ProxyUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      setSub2ProxyConfigured(!!sub2ProxyUrl.trim());
      setMsg("设置已保存");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function createToken() {
    setCreating(true);
    setExtError(null);
    setFreshLink(null);
    setFreshWarning(null);
    setCopied(false);
    try {
      const res = await fetch("/api/extension/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: tokenLabel || "浏览器扩展",
          providerId: null,
          rotate: false,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");

      const token: string = json.data.token;
      // 完整可粘贴的注入链接：扩展保存后直接用
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      const link = `${origin}/api/extension/inject?token=${encodeURIComponent(token)}`;
      setFreshLink(link);
      setFreshWarning(json.data.warning || "该 token 仅显示一次，请立即保存。");
      setTokenLabel("");
      await loadTokens();
    } catch (e) {
      setExtError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setCreating(false);
    }
  }

  async function copyLink() {
    if (!freshLink) return;
    await navigator.clipboard.writeText(freshLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function revokeToken(id: string) {
    if (!confirm("吊销后扩展里的旧链接立刻失效，确认？")) return;
    await fetch(`/api/extension/tokens?id=${id}`, { method: "DELETE" });
    if (freshLink?.includes(id)) {
      setFreshLink(null);
    }
    await loadTokens();
  }

  return (
    <div className="space-y-6">
      <TopBar
        title="系统设置"
        subtitle="汇率、加密与浏览器扩展注入"
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
                  onChange={(e) => setUsdCny(e.target.value)}
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
                  onChange={(e) => setSub2ProxyUrl(e.target.value)}
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
              {msg && <p className="text-xs text-secondary">{msg}</p>}
              <Button type="submit" disabled={saving}>
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

      {/* 浏览器扩展注入 */}
      <Card className="border-cyan/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-text normal-case tracking-normal">
            <Puzzle className="h-4 w-4 text-cyan" />
            浏览器扩展 · JWT 注入链接
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-secondary leading-relaxed">
            某些第三方上游不方便存邮箱密码。生成一条长期注入链接，粘到 Chrome / Edge 扩展里，
            登录面板后一键把 JWT 推回 Orbit。链接本身就是密钥，勿公开分享；泄露立刻吊销。
          </p>

          <div className="flex gap-3 items-end flex-wrap">
            <div className="space-y-1.5 flex-1 min-w-[200px]">
              <Label>备注（可选）</Label>
              <Input
                value={tokenLabel}
                onChange={(e) => setTokenLabel(e.target.value)}
                placeholder="如：家用浏览器"
                maxLength={100}
              />
            </div>
            <Button
              onClick={createToken}
              disabled={creating}
            >
              <Plus className="h-3.5 w-3.5" />
              {creating ? "生成中…" : "生成注入链接"}
            </Button>
          </div>

          {freshLink && (
            <div className="rounded-lg border border-mint/30 bg-mint/5 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm text-mint">
                <Link2 className="h-4 w-4" />
                新链接已生成 · 只显示这一次
              </div>
              {freshWarning && (
                <p className="text-xs text-amber">{freshWarning}</p>
              )}
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={freshLink}
                  className="font-data text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button size="sm" variant="secondary" onClick={copyLink}>
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-mint" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "已复制" : "复制"}
                </Button>
              </div>
              <p className="text-[11px] text-muted">
                粘贴到扩展的「Orbit 注入链接」输入框 → 保存。之后打开任意已添加的上游面板登录，点「抓取并推送」即可。
              </p>
            </div>
          )}

          {extError && <p className="text-xs text-coral">{extError}</p>}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-secondary">已签发</h3>
              <span className="text-[11px] text-muted font-data">
                {tokens.length} 条
              </span>
            </div>
            {tokens.length === 0 ? (
              <p className="text-xs text-muted py-4 text-center">
                还没有注入链接。生成一条，粘到扩展里就能用。
              </p>
            ) : (
              <div className="overflow-x-auto rounded-[var(--r-lg)] border border-border-subtle">
                <Table>
                  <THead>
                    <HeadRow>
                      <TH className="px-3">前缀</TH>
                      <TH className="px-3">备注</TH>
                      <TH className="px-3">绑定</TH>
                      <TH className="px-3">有效期</TH>
                      <TH className="px-3">使用</TH>
                      <TH className="px-3">最近</TH>
                      <TH className="px-3" />
                    </HeadRow>
                  </THead>
                  <TBody>
                    {tokens.map((t) => (
                      <TR key={t.id}>
                        <TD className="px-3 font-data text-xs text-cyan">
                          {t.tokenPrefix}…
                        </TD>
                        <TD className="px-3 text-xs">{t.label || "—"}</TD>
                        <TD className="px-3">
                          {t.providerName ? (
                            <Badge variant="cyan">{t.providerName}</Badge>
                          ) : (
                            <Badge variant="default">按 host 匹配</Badge>
                          )}
                          {!t.enabled && (
                            <Badge variant="coral" className="ml-1">
                              已停用
                            </Badge>
                          )}
                        </TD>
                        <TD className="px-3 text-[11px] font-data">
                          {t.expired ? (
                            <Badge variant="coral">已过期</Badge>
                          ) : t.expiresAt ? (
                            <span className="text-muted">
                              {new Date(t.expiresAt).toLocaleDateString("zh-CN")}
                            </span>
                          ) : (
                            <span className="text-muted">永久</span>
                          )}
                        </TD>
                        <TD className="px-3 font-data text-xs">
                          {t.useCount}
                        </TD>
                        <TD className="px-3 text-[11px] text-muted font-data">
                          {t.lastUsedAt
                            ? new Date(t.lastUsedAt).toLocaleString("zh-CN")
                            : "从未"}
                        </TD>
                        <TD className="px-3 text-right">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => revokeToken(t.id)}
                            aria-label="吊销"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-coral" />
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </div>

          <p className="text-[11px] text-muted leading-relaxed">
            扩展目录：
            <code className="font-data text-cyan">F:\newapi\orbit-jwt-grabber</code>
            。Chrome / Edge → 扩展 → 开发者模式 → 加载已解压的扩展程序。
            同一上游再次生成会自动轮换旧链接。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
