/**
 * 让裸 node 也能解析项目里的 `@/...` 别名与省略的 .ts 扩展名，
 * 只给 scripts/ 下的自检脚本用，不参与构建。
 *
 *   node --experimental-strip-types --import ./scripts/alias-hook.mjs scripts/check-reporting.ts
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function withExtension(filePath) {
  if (path.extname(filePath)) return filePath;
  for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
    if (existsSync(filePath + ext)) return filePath + ext;
  }
  const indexed = path.join(filePath, "index.ts");
  return existsSync(indexed) ? indexed : filePath;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const resolved = withExtension(path.join(srcDir, specifier.slice(2)));
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
