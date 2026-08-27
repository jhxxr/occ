/**
 * 分组分类 + 排序，供「密钥与分组」详情页和首页卡片共用，
 * 保证两处看到的分类口径完全一致。
 */

/** 分类/排序所需的最小分组字段（Sub2Group 与缓存 JSON 都满足） */
export interface GroupRateLike {
  name: string;
  description?: string | null;
  platform?: string | null;
  rate_multiplier: number;
  allow_image_generation?: boolean;
}

/** 生图/图片专用分组：按名称识别，不把仅 allow_image_generation 的对话组算进来 */
export function isImageGroup(g: GroupRateLike): boolean {
  const text = `${g.name || ""} ${g.description || ""} ${g.platform || ""}`;
  return /生图|image\b|img\b|banana|香蕉|dall|midjourney|flux/i.test(text);
}

/** 分类排序权重：对话模型按常见平台，图片单独一类靠后 */
export const CATEGORY_ORDER: Record<string, number> = {
  openai: 10,
  anthropic: 20,
  gemini: 30,
  google: 30,
  grok: 40,
  xai: 40,
  image: 90,
  other: 100,
};

export function groupCategory(g: GroupRateLike): { key: string; label: string } {
  if (isImageGroup(g)) return { key: "image", label: "生图 / 图片" };
  const p = (g.platform || "").toLowerCase();
  if (p === "openai") return { key: "openai", label: "OpenAI / GPT" };
  if (p === "anthropic") return { key: "anthropic", label: "Anthropic / Claude" };
  if (p === "gemini" || p === "google") return { key: "gemini", label: "Gemini" };
  if (p === "grok" || p === "xai") return { key: "grok", label: "Grok" };
  if (p) return { key: p, label: p };
  return { key: "other", label: "其他" };
}

export function compareGroups(a: GroupRateLike, b: GroupRateLike): number {
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

export function platformVariant(
  p?: string | null,
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
