import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function deriveKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error("ENCRYPTION_SECRET is required");
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a secret string. Returns `iv:tag:ciphertext` hex bundle. */
export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** `iv:tag:ciphertext` —— iv 12 字节、tag 16 字节，都是十六进制 */
const BUNDLE_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i;

/**
 * 判断是不是 encryptSecret 产出的密文包。
 *
 * 不能只看有没有冒号 —— 明文凭据里带冒号很常见（URL、`user:pass`），
 * 那样会被误当成密文去解密，然后走进解密失败分支。
 */
export function isEncryptedBundle(value: string): boolean {
  return BUNDLE_RE.test(value);
}

/**
 * 解密 encryptSecret 的产物；不是密文包的按历史明文原样返回。
 *
 * 解密失败（多半是换过 ENCRYPTION_SECRET）返回空字符串，**绝不能返回密文本身**：
 * 调用方普遍写的是 `const raw = decryptSecret(x); if (!raw) throw "缺少 Key"`，
 * 返回密文会让这类守卫全部失效，然后把 `9f3c…:a1b2…:c4d5…` 当成 API Key
 * 发给第三方站点（既泄露密文，又让报错变得完全无法定位）。
 */
export function decryptSecret(bundle: string): string {
  if (!bundle) return "";
  if (!isEncryptedBundle(bundle)) {
    // Legacy / unencrypted value (dev convenience)
    return bundle;
  }
  const [ivHex, tagHex, dataHex] = bundle.split(":");
  try {
    const key = deriveKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    console.error(
      "[orbit] 凭据解密失败：密文与当前 ENCRYPTION_SECRET 不匹配。" +
        "如果刚轮换过密钥，需要重新填写受影响的上游/下游凭据。",
    );
    return "";
  }
}

export function hashExtensionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createExtensionToken(): {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const token = `oct_${randomBytes(32).toString("hex")}`;
  return {
    token,
    tokenHash: hashExtensionToken(token),
    tokenPrefix: token.slice(0, 12),
  };
}

/** Mask a key for UI display: show first 4 and last 4 chars. */
export function maskSecret(value: string, visible = 4): string {
  if (!value) return "";
  if (value.length <= visible * 2) return "••••••••";
  return `${value.slice(0, visible)}${"•".repeat(8)}${value.slice(-visible)}`;
}
