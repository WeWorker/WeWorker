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
export function cliName() {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"));
    cached = cliNameFromPkgName(pkg.name);
  } catch {
    cached = "webcli";
  }
  return cached;
}
