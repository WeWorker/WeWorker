/**
 * 分层验证(确定性判定):静态 → 复现重放 → fixture 断言 → 回归冒烟。
 * 实跑依赖 Webwright 运行时,仅工作台机器可用;测试注入 replayImpl。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readPackageDirectory } from "../adapter-package-files.js";

export function assertExpect(result, expect = {}) {
  const errors = [];
  const dig = (obj, p) => String(p).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  for (const p of expect.requiredPaths || []) if (dig(result, p) === undefined) errors.push(`缺字段 ${p}`);
  for (const p of expect.notEmpty || []) {
    const v = dig(result, p);
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) errors.push(`空值 ${p}`);
  }
  for (const [p, want] of Object.entries(expect.equals || {})) {
    if (JSON.stringify(dig(result, p)) !== JSON.stringify(want)) errors.push(`不等 ${p}`);
  }
  for (const [p, re] of Object.entries(expect.patterns || {})) {
    if (!new RegExp(re).test(String(dig(result, p) ?? ""))) errors.push(`不匹配 ${p}`);
  }
  for (const [p, n] of Object.entries(expect.rowCount || {})) {
    const v = dig(result, p);
    if (!Array.isArray(v) || v.length < n) errors.push(`行数 ${p} < ${n}`);
  }
  return errors;
}

export function verifyStatically(draftDir, { baseVersion } = {}) {
  const pkg = readPackageDirectory(draftDir);
  const checks = [{ name: "manifest-schema", passed: Boolean(pkg.manifest?.version && Array.isArray(pkg.commands) && pkg.commands.length) }];
  if (baseVersion !== undefined) {
    checks.push({ name: "version-bumped", passed: pkg.manifest.version !== baseVersion });
  }
  for (const command of pkg.commands.filter((c) => c.runtime === "wewright")) {
    const file = path.join(draftDir, command.module);
    const exists = existsSync(file);
    checks.push({ name: `module-exists:${command.id}`, passed: exists });
    if (exists) checks.push({ name: `module-nonempty:${command.id}`, passed: readFileSync(file).length > 0 });
  }
  return { pkg, checks };
}

export async function replayCommand({ pkg, commandId, args = {}, runtimePath, env }) {
  const { runToolkitTool } = await import("../toolkit-runner.js");
  const command = pkg.commands.find((c) => c.id === commandId);
  if (!command) throw new Error(`命令不存在: ${commandId}`);
  const match = {
    adapter: { root: pkg.root, entryPath: path.join(pkg.root, command.module) },
    tool: { id: command.id, name: `${pkg.manifest.name}.${command.id}` },
  };
  // 验证重放流量不计入业务 errdetail 统计:endpoint null 时 reportMetric 静默,
  // 避免修复循环的失败重放推高同一错误签名、重复触发任务(metrics 自激)。
  return runToolkitTool(match, args, { runtimePath, env, metricsConfig: { endpoint: null } });
}

/**
 * 修复分层验证主入口:静态 → 复现重放 → fixture 断言 → 回归冒烟。
 * 契约:本函数对包非法/断言非法不抛错,一律转失败 check;调用方仍应对意外异常兜底。
 */
export async function verifyRepair({ task, draftDir, baseVersion, fixtures = [], smoke = true, runtimePath, env, log = () => {}, replayImpl = replayCommand }) {
  const checks = [];
  let pkg;
  try {
    const stat = verifyStatically(draftDir, { baseVersion });
    pkg = stat.pkg;
    checks.push(...stat.checks);
  } catch (e) {
    // 包非法(缺 manifest/校验不过)时 pkg 不可用无法继续,记失败 check 并提前返回。
    checks.push({ name: "static:package-invalid", passed: false, error: e.message });
    log(`[verify] ${checks.map((c) => `${c.passed ? "✓" : "✗"}${c.name}`).join(" ")}`);
    return { passed: false, checks };
  }
  const primary = task.failures?.[0]?.tool?.split(".").pop();
  let replayOk = false;
  let replayResult = null;
  if (primary) {
    try {
      const completed = await replayImpl({ pkg, commandId: primary, args: task.repro?.sample || {}, runtimePath, env });
      replayOk = completed.exitCode === 0;
      replayResult = completed.result;
      checks.push({ name: `replay:${primary}`, passed: replayOk, exitCode: completed.exitCode, stderrTail: completed.stderrTail || null });
    } catch (e) {
      checks.push({ name: `replay:${primary}`, passed: false, error: e.message });
    }
  }
  if (replayOk) {
    for (const fixture of fixtures.filter((f) => f.commandId === primary)) {
      let errors;
      try {
        errors = assertExpect(replayResult, fixture.expect);
      } catch (e) {
        // 断言本身非法(如非法正则 SyntaxError)同样转失败 check,不外抛。
        errors = [e.message];
      }
      checks.push({ name: `fixture:${fixture.id}`, passed: !errors.length, errors });
    }
    if (smoke) {
      for (const command of pkg.commands.filter((c) => c.runtime === "wewright" && c.id !== primary)) {
        try {
          const completed = await replayImpl({ pkg, commandId: command.id, args: {}, runtimePath, env });
          checks.push({ name: `smoke:${command.id}`, passed: completed.exitCode === 0 });
        } catch (e) {
          checks.push({ name: `smoke:${command.id}`, passed: false, error: e.message });
        }
      }
    }
  }
  const passed = checks.length > 0 && checks.every((c) => c.passed);
  log(`[verify] ${checks.map((c) => `${c.passed ? "✓" : "✗"}${c.name}`).join(" ")}`);
  return { passed, checks };
}
