/**
 * 修复执行循环:取证 → 诊断(LLM 注入)→ 补丁草稿 → 分层验证,有界 ≤maxRounds 轮。
 * rootCause 'login-expired' / 'needs-regeneration' 提前终止;LLM 异常 → 'llm-error'、
 * ADAPTER_BASE_CHANGED → 'base-changed'(均为持久/外部条件,不烧轮次,回写 open 重入安全);
 * verifyRepair 契约为「不抛错」,但意外异常仍按失败轮次处理(不中断循环);
 * 经验库写入失败仅 log 降级,不影响任务状态与退出。
 */
import { homedir } from "node:os";
import { readWewrightTarget, writeRepairDraftWewright } from "./wewright-draft.js";
import { verifyRepair } from "./verify.js";
import { searchExperience, injectContext, recordExperience, knowledgePath } from "./knowledge.js";
import { transition, saveTask, tasksDir } from "./task.js";

export async function runRepairLoop({ task, llm, env = process.env, home = homedir(), maxRounds = 3, log = () => {}, now = Date.now(), save = saveTask, verifyImpl = verifyRepair, fixtures = [], runtimePath } = {}) {
  task = transition(task, "diagnosing");
  save(task, tasksDir(home));
  const { pkg } = readWewrightTarget(task.adapterId, { env, home });
  const experienceHint = injectContext(searchExperience(knowledgePath(home), { site: task.adapterId, runtime: "wewright", errSignature: task.failures?.[0]?.lastErr || "" }, 3));
  const baseVersion = pkg.manifest.version;
  let feedback = null;
  for (let round = 1; round <= maxRounds; round++) {
    log(`[repair] 第 ${round}/${maxRounds} 轮`);
    const ctx = { task, failure: task.failures?.[0], experienceHint, feedback, round, baseVersion };
    let proposal;
    try {
      proposal = round === 1 ? await llm.diagnose(ctx) : await llm.revise(ctx);
    } catch (e) {
      // LLM 服务中断属外部故障,烧轮次无意义;回写 open 等待重入(llm.revise 缺失的 TypeError 同被此 catch 覆盖)
      task = transition(task, "open");
      save(task, tasksDir(home));
      return { task, outcome: "llm-error", error: e.message };
    }
    if (proposal.rootCause === "needs-regeneration" || proposal.rootCause === "login-expired") {
      const to = proposal.rootCause === "needs-regeneration" ? "needs-regeneration" : "needs-login";
      task = transition(task, to);
      save(task, tasksDir(home));
      return { task, outcome: to, reasoning: proposal.reasoning || "" };
    }
    if (!proposal.patchedFiles || !Object.keys(proposal.patchedFiles).length) {
      feedback = "诊断未产出补丁";
      continue;
    }
    let draft;
    try {
      draft = writeRepairDraftWewright({ adapterId: task.adapterId, expectedDigest: pkg.digest, patchedFiles: proposal.patchedFiles, env, home, now });
    } catch (e) {
      if (String(e.message).includes("ADAPTER_BASE_CHANGED")) {
        // 基线漂移是持久条件,revise 修不了;回写 open,重新取证后再入
        task = transition(task, "open");
        save(task, tasksDir(home));
        return { task, outcome: "base-changed", error: e.message };
      }
      feedback = `草稿失败: ${e.message}`;
      log(`[repair] ${feedback}`);
      continue;
    }
    let verification;
    try {
      verification = await verifyImpl({ task, draftDir: draft.draftDir, baseVersion, fixtures, env, home, log, runtimePath });
    } catch (e) {
      // verifyRepair 契约是不抛错;这里兜意外异常,按失败轮次处理
      feedback = `验证异常: ${e.message}`;
      log(`[repair] ${feedback}`);
      continue;
    }
    if (verification.passed) {
      task = transition(task, "draft-ready");
      save(task, tasksDir(home));
      try {
        recordExperience(knowledgePath(home), {
          site: task.adapterId, runtime: "wewright",
          symptom: task.failures?.[0]?.lastErr || "",
          rootCause: proposal.rootCause, fixStrategy: proposal.reasoning || "",
          outcome: "fixed", evidenceRef: draft.draftDir,
        });
      } catch (e) {
        log(`[repair] 经验库写入失败: ${e.message}`);
      }
      return { task, outcome: "draft-ready", draft, verification };
    }
    feedback = `验证未通过: ${verification.checks.filter((c) => !c.passed).map((c) => c.name).join(", ")}`;
    log(`[repair] ${feedback}`);
  }
  task = transition(task, "archived");
  save(task, tasksDir(home));
  try {
    recordExperience(knowledgePath(home), {
      site: task.adapterId, runtime: "wewright",
      symptom: task.failures?.[0]?.lastErr || "",
      rootCause: "unresolved", fixStrategy: feedback || "", outcome: "failed",
      evidenceRef: "",
    });
  } catch (e) {
    log(`[repair] 经验库写入失败: ${e.message}`);
  }
  return { task, outcome: "archived" };
}
