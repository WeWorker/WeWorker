/**
 * 本地跨 adapter 经验库(~/.webcli/repair-knowledge.json)。
 * 修复结束自动沉淀;修复/探索前按 site+runtime+错误签名检索 Top-K 注入。
 * 淘汰策略 LRU(主键 date 新→旧,hits 仅平局裁决);failed 合并不抹已知修法。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const KNOWLEDGE_LIMIT = 200;

export function knowledgePath(home = homedir()) {
  return path.join(home, ".webcli", "repair-knowledge.json");
}

export function loadKnowledge(file = knowledgePath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, `${file}.corrupt.bak`); } catch { /* 备份失败不阻塞 */ }
    }
    return { entries: [] };
  }
}

// 去重键:吃清洗截断后的字段,避免"同前缀不同后缀"假去重失效
export function entryKey(entry) {
  const key = `${String(entry.site || "")}|${String(entry.runtime || "")}|${String(entry.symptom || "").slice(0, 500)}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

export function recordExperience(file, entry, now = new Date().toISOString()) {
  const clean = {
    site: String(entry.site || ""), runtime: String(entry.runtime || ""),
    symptom: String(entry.symptom || "").slice(0, 500),
    rootCause: String(entry.rootCause || "").slice(0, 500),
    fixStrategy: String(entry.fixStrategy || "").slice(0, 1000),
    outcome: entry.outcome === "failed" ? "failed" : "fixed",
    evidenceRef: String(entry.evidenceRef || "").slice(0, 200), date: now,
  };
  clean.id = entryKey(clean);
  const data = loadKnowledge(file);
  const idx = data.entries.findIndex((e) => e.id === clean.id);
  if (idx >= 0) {
    const prev = data.entries[idx];
    if (clean.outcome === "failed") {
      // failed 合并不抹已知修法:保留旧 rootCause/fixStrategy/outcome/evidenceRef,只刷新 hits/date
      data.entries[idx] = { ...prev, hits: (prev.hits || 0) + 1, date: clean.date, lastOutcome: "failed" };
    } else {
      data.entries[idx] = { ...prev, ...clean, hits: (prev.hits || 0) + 1, lastOutcome: "fixed" };
    }
  } else {
    data.entries.push({ ...clean, hits: 1, lastOutcome: clean.outcome });
  }
  // LRU:主键 date 降序(新→旧),hits 降序仅平局裁决;超限裁尾,刚沉淀的经验永不被裁
  data.entries.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.hits || 0) - (a.hits || 0));
  if (data.entries.length > KNOWLEDGE_LIMIT) data.entries = data.entries.slice(0, KNOWLEDGE_LIMIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子写:先落 tmp 再 rename,避免写一半损坏
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return clean;
}

// 首参为库文件路径(与 recordExperience/loadKnowledge 一致;测试显式传临时文件)
export function searchExperience(file = knowledgePath(), { site = "", runtime = "", errSignature = "" } = {}, k = 3) {
  const { entries } = loadKnowledge(file);
  const sigTokens = String(errSignature).toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  return entries.map((e) => {
    let score = 0;
    if (site && e.site === site) score += 2;
    if (runtime && e.runtime === runtime) score += 1;
    const hay = `${e.symptom} ${e.rootCause}`.toLowerCase();
    score += sigTokens.filter((t) => hay.includes(t)).length;
    return { entry: e, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.entry);
}

export function injectContext(entries) {
  if (!entries.length) return "经验库暂无相关条目。";
  return "相关修复经验:\n" + entries.map((e) =>
    `- [${e.site}/${e.runtime}] 症状: ${e.symptom}\n  根因: ${e.rootCause}\n  策略: ${e.fixStrategy}(${e.outcome},出现 ${e.hits || 1} 次)`,
  ).join("\n");
}
