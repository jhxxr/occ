/**
 * 下游 NewAPI 渠道管理写入的唯一出口（模型确认 / 渠道编辑 / 启停 / 删除 / 测速）。
 *
 * 安全约束：
 * - 写请求一律「服务端先 GET 完整渠道对象再合并覆盖」，绝不把 GET 到的
 *   key 裸串回传浏览器；只有用户显式填写新 Key 时才替换 key 字段。
 * - 返回给上层的 SafeChannelRecord 不含任何凭证字段。
 * - 写操作 retries: 0，避免提交结果未知时重复执行。
 */

import type { DownstreamSite } from "@prisma/client";
import { newApiAdminHeaders, fetchJson } from "@/lib/adapters";
import { decryptSecret } from "@/lib/crypto";
import { normalizeBaseUrl } from "@/lib/utils";

export const MODEL_WRITE_FIELDS = [
  "id",
  "add_models",
  "remove_models",
  "ignore_models",
] as const;
export const ROUTE_WRITE_FIELDS = ["id", "priority"] as const;

type ChannelAdminSite = Pick<
  DownstreamSite,
  "baseUrl" | "adminKey" | "adminUserId"
>;

interface NewApiEnvelope<T> {
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
}

export interface CreatedChannelInput {
  name: string;
  type: number;
  baseUrl: string;
  key: string;
  models: string[];
  group: string;
  priority: number;
  status: number;
  autoBan: number;
}

export interface SafeChannelRecord {
  id: number;
  name: string;
  type: number | null;
  group: string;
  models: string[];
  priority: number | null;
  status: number | null;
  autoBan: number | null;
}

function safeChannel(value: unknown): SafeChannelRecord {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const models = typeof row.models === "string"
    ? row.models.split(",").map((item) => item.trim()).filter(Boolean)
    : Array.isArray(row.models)
      ? row.models.filter((item): item is string => typeof item === "string")
      : [];
  return {
    id: Number(row.id || 0),
    name: typeof row.name === "string" ? row.name : "",
    type: typeof row.type === "number" ? row.type : null,
    group: typeof row.group === "string" ? row.group : "",
    models,
    priority: typeof row.priority === "number" ? row.priority : null,
    status: typeof row.status === "number" ? row.status : null,
    autoBan: typeof row.auto_ban === "number" ? row.auto_ban : null,
  };
}

function channelItems(value: unknown): unknown[] {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = root.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).items)) {
    return (data as Record<string, unknown>).items as unknown[];
  }
  return [];
}

interface DetectModelData {
  channel_id?: number;
  channel_name?: string;
  add_models?: unknown;
  remove_models?: unknown;
  last_check_time?: number;
  auto_added_models?: number;
}

interface ApplyModelData {
  id?: number;
  added_models?: unknown;
  removed_models?: unknown;
  ignored_models?: unknown;
  remaining_models?: unknown;
  remaining_remove_models?: unknown;
  models?: string;
}

export interface ChannelModelStatus {
  channelId: number;
  channelName: string;
  pendingAddModels: string[];
  pendingRemoveModels: string[];
  lastCheckTime: number | null;
  autoAddedModels: number;
}

export interface ApplyModelUpdatesInput {
  addModels: string[];
  removeModels: string[];
  ignoreModels: string[];
}

export interface ApplyModelUpdatesResult {
  channelId: number;
  addedModels: string[];
  removedModels: string[];
  ignoredModels: string[];
  remainingAddModels: string[];
  remainingRemoveModels: string[];
  models: string[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function adminRequest(site: ChannelAdminSite) {
  const adminKey = decryptSecret(site.adminKey);
  if (!adminKey) throw new Error("下游站点 Admin Key 无法解密");
  return {
    baseUrl: normalizeBaseUrl(site.baseUrl),
    headers: newApiAdminHeaders(adminKey, site.adminUserId || 1),
  };
}

export async function createChannel(
  site: ChannelAdminSite,
  input: CreatedChannelInput,
): Promise<SafeChannelRecord> {
  const { baseUrl, headers } = adminRequest(site);
  if (!input.key.trim()) throw new Error("渠道 Key 不能为空");
  if (!input.baseUrl.trim()) throw new Error("渠道 Base URL 不能为空");
  if (!input.models.length) throw new Error("至少选择一个渠道模型");
  const response = await fetchJson(`${baseUrl}/api/channel/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mode: "single",
      channel: {
        name: input.name,
        type: input.type,
        base_url: input.baseUrl,
        key: input.key,
        models: input.models.join(","),
        group: input.group,
        priority: input.priority,
        status: input.status,
        auto_ban: input.autoBan,
      },
    }),
    timeoutMs: 30_000,
    retries: 0,
  });
  const root = responseError<unknown>(response, "创建渠道失败");
  const created = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : null;
  let id = Number(created?.id || 0);
  if (!id) {
    const listed = await fetchJson(`${baseUrl}/api/channel/?p=0&page_size=1000`, {
      method: "GET", headers, timeoutMs: 30_000, retries: 0,
    });
    const match = channelItems(listed.data)
      .map((item) => safeChannel(item))
      .filter((item) => item.name === input.name)
      .sort((a, b) => b.id - a.id)[0];
    id = match?.id || 0;
  }
  if (!id) throw new Error("创建渠道成功但无法回读新渠道 ID");
  const read = await fetchJson(`${baseUrl}/api/channel/${id}`, {
    method: "GET", headers, timeoutMs: 30_000, retries: 0,
  });
  const readRoot = responseError<unknown>(read, "读取新建渠道失败");
  return safeChannel(readRoot.data || created);
}

function responseError<T>(
  response: { ok: boolean; status: number; data: unknown },
  fallback: string,
): NewApiEnvelope<T> {
  const root =
    response.data && typeof response.data === "object" && !Array.isArray(response.data)
      ? (response.data as NewApiEnvelope<T>)
      : null;
  if (!response.ok || root?.success === false) {
    throw new Error(
      root?.message || root?.error || `${fallback} (HTTP ${response.status})`,
    );
  }
  if (!root) throw new Error(`${fallback}：响应格式无效`);
  return root;
}

/**
 * 手动探测并持久化待确认差异。NewAPI 源码中该操作使用
 * checkAndPersist(..., true, false)，因此只写 settings，不改 models/abilities。
 */
export async function detectModelUpdates(
  site: ChannelAdminSite,
  channelId: number,
): Promise<ChannelModelStatus> {
  const { baseUrl, headers } = adminRequest(site);
  const response = await fetchJson(
    `${baseUrl}/api/channel/upstream_updates/detect`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ id: channelId }),
      timeoutMs: 45_000,
      retries: 0,
    },
  );
  const root = responseError<DetectModelData>(response, "探测上游模型失败");
  const data = root.data;
  if (!data) throw new Error("探测上游模型失败：响应缺少 data");
  return {
    channelId: data.channel_id ?? channelId,
    channelName: data.channel_name || `#${channelId}`,
    pendingAddModels: stringArray(data.add_models),
    pendingRemoveModels: stringArray(data.remove_models),
    lastCheckTime:
      typeof data.last_check_time === "number" ? data.last_check_time : null,
    autoAddedModels:
      typeof data.auto_added_models === "number" ? data.auto_added_models : 0,
  };
}

/** 应用只会与 detect 保存的 pending 列表求交集；调用方必须先 detect。 */
export async function applyModelUpdates(
  site: ChannelAdminSite,
  channelId: number,
  input: ApplyModelUpdatesInput,
): Promise<ApplyModelUpdatesResult> {
  const { baseUrl, headers } = adminRequest(site);
  const response = await fetchJson(
    `${baseUrl}/api/channel/upstream_updates/apply`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: channelId,
        add_models: input.addModels,
        remove_models: input.removeModels,
        ignore_models: input.ignoreModels,
      }),
      timeoutMs: 30_000,
      // 写操作不重试，避免提交结果未知时重复执行。
      retries: 0,
    },
  );
  const root = responseError<ApplyModelData>(response, "应用模型变更失败");
  const data = root.data;
  if (!data) throw new Error("应用模型变更失败：响应缺少 data");
  return {
    channelId: data.id ?? channelId,
    addedModels: stringArray(data.added_models),
    removedModels: stringArray(data.removed_models),
    ignoredModels: stringArray(data.ignored_models),
    remainingAddModels: stringArray(data.remaining_models),
    remainingRemoveModels: stringArray(data.remaining_remove_models),
    models: String(data.models || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  };
}

export interface ChannelEditInput {
  name?: string;
  baseUrl?: string;
  /** 用户显式填写的新 Key；空/undefined 表示不改动现有凭据 */
  key?: string;
  models?: string[];
  group?: string;
  priority?: number;
  weight?: number;
  status?: number;
  autoBan?: number;
  remark?: string;
}

/**
 * GET 完整渠道对象（含 key）→ 合并覆盖 → PUT /api/channel/。
 * NewAPI 的 PUT 是整对象更新：缺的字段会被清掉，所以必须先回读再改。
 * 回读的 key 只在内存中流转：用户没填新 Key 就原样带回，绝不返回给浏览器。
 */
export async function updateChannel(
  site: ChannelAdminSite,
  channelId: number,
  input: ChannelEditInput,
): Promise<SafeChannelRecord> {
  const { baseUrl, headers } = adminRequest(site);

  const getRes = await fetchJson(`${baseUrl}/api/channel/${channelId}`, {
    method: "GET", headers, timeoutMs: 30_000, retries: 0,
  });
  const getRoot = responseError<Record<string, unknown>>(getRes, "读取渠道失败");
  const current = getRoot.data && typeof getRoot.data === "object"
    ? getRoot.data as Record<string, unknown>
    : null;
  if (!current) throw new Error("读取渠道失败：响应缺少 data");

  const nextModels = input.models != null
    ? [...input.models]
    : typeof current.models === "string"
      ? current.models.split(",").map((m) => m.trim()).filter(Boolean)
      : [];

  const payload: Record<string, unknown> = {
    ...current,
    id: channelId,
    name: input.name?.trim() || current.name,
    base_url: input.baseUrl?.trim() || current.base_url,
    key: input.key?.trim() ? input.key.trim() : current.key,
    models: nextModels.join(","),
    group: input.group ?? current.group,
    priority: input.priority ?? current.priority,
    weight: input.weight ?? current.weight,
    status: input.status ?? current.status,
    auto_ban: input.autoBan ?? current.auto_ban,
    remark: input.remark ?? current.remark,
  };

  const putRes = await fetchJson(`${baseUrl}/api/channel/`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
    timeoutMs: 30_000,
    retries: 0,
  });
  responseError<unknown>(putRes, "保存渠道失败");

  // PUT 响应不带渠道对象，回读一次拿规范化后的记录
  const read = await fetchJson(`${baseUrl}/api/channel/${channelId}`, {
    method: "GET", headers, timeoutMs: 30_000, retries: 0,
  });
  const readRoot = responseError<unknown>(read, "回读渠道失败");
  return safeChannel(readRoot.data);
}

const STATUS_ENABLED = 1;
const STATUS_MANUALLY_DISABLED = 2;

/** 启用 / 手动禁用。NewAPI status：1=启用，2=手动禁用。 */
export async function setChannelStatus(
  site: ChannelAdminSite,
  channelId: number,
  enabled: boolean,
): Promise<SafeChannelRecord> {
  return updateChannel(site, channelId, {
    status: enabled ? STATUS_ENABLED : STATUS_MANUALLY_DISABLED,
  });
}

/** 删除渠道。NewAPI DELETE /api/channel/<id>。不可恢复。 */
export async function deleteChannel(
  site: ChannelAdminSite,
  channelId: number,
): Promise<void> {
  const { baseUrl, headers } = adminRequest(site);
  const res = await fetchJson(`${baseUrl}/api/channel/${channelId}`, {
    method: "DELETE",
    headers,
    timeoutMs: 30_000,
    retries: 0,
  });
  responseError<unknown>(res, "删除渠道失败");
}

export interface ChannelTestResult {
  timeMs: number | null;
  message: string;
}

/**
 * 触发 NewAPI 渠道测速（GET /api/channel/test/<id>?model=）。
 * NewAPI 返回顶层 { success, message, time, error_code }，time 单位为秒。
 */
export async function testChannel(
  site: ChannelAdminSite,
  channelId: number,
  model?: string,
): Promise<ChannelTestResult> {
  const { baseUrl, headers } = adminRequest(site);
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  const res = await fetchJson(`${baseUrl}/api/channel/test/${channelId}${query}`, {
    method: "GET",
    headers,
    timeoutMs: 120_000,
    retries: 0,
  });
  const root = res.data && typeof res.data === "object" && !Array.isArray(res.data)
    ? res.data as { success?: boolean; message?: string; time?: number; error_code?: string }
    : null;
  if (!res.ok || !root || root.success === false) {
    throw new Error(
      root?.message ||
      (root?.error_code ? `测速失败（${root.error_code}）` : `测速失败 (HTTP ${res.status})`),
    );
  }
  const timeSec = typeof root.time === "number" && Number.isFinite(root.time)
    ? root.time
    : null;
  return {
    timeMs: timeSec != null ? Math.round(timeSec * 1000) : null,
    message:
      timeSec != null
        ? `耗时 ${timeSec.toFixed(2)}s`
        : root.message || "测速完成",
  };
}
