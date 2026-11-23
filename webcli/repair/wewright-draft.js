/**
 * wewright 包修复草稿:digest 守护读取 + 补丁叠加 + 版本 patch+1,落独立草稿目录。
 * 不动 live 安装;通过验证 + 人工确认后才是安装/发布。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { readPackageDirectory, writePackageDirectory } from "../adapter-package-files.js";
import { resolveUserAdaptersDir } from "../paths.js";

// readPackageDirectory 产裸 hex digest;本模块对外统一 sha256: 前缀(与 adapterhub/registry 约定一致)。
function withShaPrefix(digest) {
  return String(digest).startsWith("sha256:") ? String(digest) : `sha256:${digest}`;
}

function shortDigest(digest) {
  return withShaPrefix(digest).slice(7, 19);
}

export function readWewrightTarget(adapterId, { env = process.env, home = homedir() } = {}) {
  const root = path.join(resolveUserAdaptersDir({ env, home }), adapterId);
  if (!fs.existsSync(root)) throw new Error(`未找到已装 adapter: ${adapterId}(路径 ${root})`);
  const pkg = readPackageDirectory(root);
  if (!pkg.commands.some((c) => c.runtime === "wewright")) {
    throw new Error(`adapter ${adapterId} 不含 wewright 命令,请走既有 extension/http 修复工作流`);
  }
  return { adapterId, pkg: { ...pkg, digest: withShaPrefix(pkg.digest) } };
}

export function patchVersion(version) {
  const parts = String(version).split(".");
  const patch = (parseInt(parts[2] || "0", 10) || 0) + 1;
  return [parts[0] || "0", parts[1] || "0", String(patch)].join(".");
}

export function writeRepairDraftWewright({ adapterId, expectedDigest, patchedFiles, env = process.env, home = homedir(), draftsRoot = path.join(homedir(), ".webcli", "repair-drafts"), now = Date.now() }) {
  const { pkg } = readWewrightTarget(adapterId, { env, home });
  if (pkg.digest !== withShaPrefix(expectedDigest)) {
    throw new Error(`ADAPTER_BASE_CHANGED: 包基线已变化(期望 ${shortDigest(expectedDigest)},实际 ${shortDigest(pkg.digest)}),请重新读取取证`);
  }
  const names = Object.keys(patchedFiles || {});
  if (!names.length) throw new Error("patchedFiles 至少一个文件");
  for (const name of names) {
    if (!pkg.files.has(name)) throw new Error(`补丁文件不在包内: ${name}`);
  }
  const manifest = { ...pkg.manifest, version: patchVersion(pkg.manifest.version) };
  const files = new Map(pkg.files);
  for (const [name, content] of Object.entries(patchedFiles)) {
    files.set(name, Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"));
  }
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
  // writePackageDirectory 要求 manifest.name 与目录名一致,草稿根不能带后缀;
  // 用时间戳父目录隔离多次修复,叶目录保持原名。
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const draftDir = path.join(draftsRoot, stamp, adapterId);
  writePackageDirectory(draftDir, files);
  const drafted = readPackageDirectory(draftDir);
  return { draftDir, digest: withShaPrefix(drafted.digest), version: manifest.version, files: [...files.keys()] };
}
