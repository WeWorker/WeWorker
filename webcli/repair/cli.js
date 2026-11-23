/**
 * webgo repair <task|run|list|show> —— 修复任务 CLI(工作台机器使用)。
 * 退出码:0 成功;2 参数错误;1 运行错误。--json 时 stdout 仅一个 JSON 对象。
 */
export async function runRepairCli(args, { outputFormat } = {}) {
  const [sub, ...rest] = args;
  const fail = (message, code = 1) => { console.error(`[repair] ${message}`); process.exitCode = code; };
  const emit = (value) => console.log(outputFormat === 'json' || rest.includes('--json') ? JSON.stringify(value, null, 2) : value);
  const { listTasks, loadTask, saveTask } = await import("./task.js");
  const { tasksFromErrDetail, fetchErrDetail } = await import("./task-source.js");

  try {
    if (sub === "task" && rest.includes("--from")) {
      const opt = (name, dflt) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : dflt; };
      const since = opt("--since", "7d");
      const minCalls = parseInt(opt("--min-calls", "3"), 10);
      const detail = await fetchErrDetail({ since });
      const tasks = tasksFromErrDetail(detail, { minCalls });
      const existing = listTasks();
      let created = 0, skipped = 0;
      for (const t of tasks) {
        // 同日同 adapter 已有未终态任务 → 跳过(保护 diagnosing/needs-login 等进行中状态不被打回 open)
        const hit = existing.find((e) => e.id === t.id && !["published", "archived"].includes(e.status));
        if (hit) { skipped++; continue; }
        saveTask(t); created++;
      }
      return emit(`生成 ${created} 个修复任务(跳过进行中 ${skipped} 个): ${tasks.map((t) => t.id).join(", ") || "(无)"}`);
    }
    if (sub === "run" && rest[0]) {
      const { runRepairLoop } = await import("./executor.js");
      const task = loadTask(rest[0]);
      if (["published", "archived"].includes(task.status)) return fail(`任务 ${task.id} 已终态(${task.status}),不可执行`);
      const { task: done, outcome, draft, verification, error, reasoning } = await runRepairLoop({ task, llm: await resolveLlm(), log: (m) => console.error(m) });
      if (outcome === "draft-ready" && draft) {
        // 人工发布通知:草稿位置/版本/验证结果/下一步(spec 十一)
        const passed = verification.checks.filter((c) => c.passed).length;
        return emit([
          `修复循环结束: ${done.id} → draft-ready`,
          `草稿: ${draft.draftDir}(版本 ${draft.version})`,
          `验证: ${passed}/${verification.checks.length} checks`,
          "下一步: 人工审阅 diff 后发布(adapterhub publish)",
        ].join("\n"));
      }
      const extra = error ? `(${error})` : reasoning ? `(${reasoning})` : "";
      return emit(`修复循环结束: ${done.id} → ${outcome}${extra}`);
    }
    if (sub === "list") return emit(listTasks().map((t) => `${t.id} [${t.status}] ${t.source} 失败:${t.failures.reduce((s, f) => s + f.count, 0)}`).join("\n") || "(无任务)");
    if (sub === "show" && rest[0]) return emit(JSON.stringify(loadTask(rest[0]), null, 2));
    throw new Error("用法: webgo repair task --from errors [--since 7d] [--min-calls 3] | repair run <taskId> | repair list | repair show <taskId>");
  } catch (e) {
    // 退出码约定(见头注释):用法/参数错误 2(先例 adapterhub-cli.js UsageError → 2),运行错误 1
    return fail(e.message, String(e.message).startsWith("用法:") ? 2 : 1);
  }

  async function resolveLlm() {
    const cmd = process.env.WEBCLI_REPAIR_LLM_CMD;
    if (!cmd) throw new Error("缺少 WEBCLI_REPAIR_LLM_CMD(或在聊天 agent 内直接调用 runRepairLoop 注入 llm)");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const make = (phase) => async (ctx) => {
      const out = await run(cmd, [], { input: JSON.stringify({ phase, ...ctx }), shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 });
      return parseProposal(out.stdout);
    };
    return { diagnose: make("diagnose"), revise: make("revise") };
  }
}

// 提案解析(stdout 末行优先):LLM 可能附带说明文字,末行不是 JSON 时截取首个平衡 {...} 块再试。
// 平衡扫描感知字符串字面量,值里出现花括号不会误判配对。
export function parseProposal(stdout) {
  const text = String(stdout).trim();
  const candidates = [text.split(/\r?\n/).at(-1)];
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { candidates.push(text.slice(start, i + 1)); break; }
    }
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* 尝试下一候选 */ }
  }
  throw new Error("LLM 输出不是合法 JSON(stdout 末行或首个平衡 {...} 块须为提案 JSON 对象)");
}
