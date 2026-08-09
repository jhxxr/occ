import { ProxyAgent } from "proxy-agent";

const SUPPORTED_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks5:",
  "socks5h:",
]);

const agents = new Map<string, ProxyAgent>();

export function validateSub2ProxyUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("代理地址不能为空");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("代理地址格式不正确");
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error("仅支持 HTTP/HTTPS 或 SOCKS5 代理");
  }
  if (!url.hostname) throw new Error("代理地址缺少主机名");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("代理地址不能包含路径、查询参数或片段");
  }

  return url.toString();
}

export function maskSub2ProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.host;
    const credentials = url.username || url.password ? "••••:••••@" : "";
    return `${url.protocol}//${credentials}${host}/`;
  } catch {
    return "已配置";
  }
}

function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = agents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent({
      getProxyForUrl: () => proxyUrl,
    });
    agents.set(proxyUrl, agent);
  }
  return agent;
}

/** Server-only fetch used for Sub2API requests that need a configured proxy. */
export async function fetchSub2(
  url: string,
  init: RequestInit,
  proxyUrl?: string | null,
): Promise<Response> {
  if (!proxyUrl) return fetch(url, init);

  const { default: nodeFetch } = await import("node-fetch");
  return nodeFetch(url, {
    method: init.method,
    headers: init.headers as Record<string, string> | undefined,
    body: init.body as never,
    signal: init.signal,
    agent: getProxyAgent(proxyUrl),
  }) as unknown as Response;
}
