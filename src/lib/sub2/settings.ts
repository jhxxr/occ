import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { maskSub2ProxyUrl, validateSub2ProxyUrl } from "@/lib/sub2/proxy";

export const SUB2_PROXY_SETTING_KEY = "sub2ProxyUrl";

export async function getSub2ProxyUrl(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: SUB2_PROXY_SETTING_KEY },
  });
  if (!row?.value) return null;

  const proxyUrl = decryptSecret(row.value);
  if (!proxyUrl) return null;

  try {
    return validateSub2ProxyUrl(proxyUrl);
  } catch {
    console.error("[orbit] Sub2API 代理配置无效，已回退直连。");
    return null;
  }
}

export function publicSub2ProxyUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const proxyUrl = decryptSecret(value);
  return proxyUrl ? maskSub2ProxyUrl(proxyUrl) : null;
}

export function encryptSub2ProxyUrl(value: string): string {
  return encryptSecret(validateSub2ProxyUrl(value));
}
