/**
 * 命令名按包身份派生:webgo 包输出 webgo,其余(行内 @webank/webcli、公开
 * weworker-webcli)输出 webcli。用于 route 输出、help 文本与版本提示等
 * 用户可见文案,让同一份代码在 webgo/webcli 两个包内自报正确命令名。
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function cliNameFromPkgName(name) {
  return name === "@webank/webgo" ? "webgo" : "webcli";
}

let cached;
export function cliName(options = {}) {
  // 桌面端内嵌等场景的 env 覆盖:打包注入 WEBCLI_CLI_NAME=webgo 即可让
  // 内嵌 CLI 输出 webgo/WebGo,无需改 package.json(公开包身份保持不变)。
  // 覆盖值不写缓存(进程内 env 固定,但隔离了测试与其他调用方的缓存)。
  const override = options.env?.WEBCLI_CLI_NAME?.trim?.() || process.env.WEBCLI_CLI_NAME?.trim?.();
  if (override) return override;
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"));
    cached = cliNameFromPkgName(pkg.name);
  } catch {
    cached = "webcli";
  }
  return cached;
}

/** 品牌标签(大写首字母):webgo → WebGo,其余 → WebCLI。用于服务名等展示文案。 */
export function cliLabel(options = {}) {
  return cliName(options) === "webgo" ? "WebGo" : "WebCLI";
}
