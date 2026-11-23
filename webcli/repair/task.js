/**
 * 修复任务结构与状态机(纯逻辑 + 持久化)。
 * 状态机:open → diagnosing → draft-ready → published;diagnosing/draft-ready 可转
 * needs-login / needs-regeneration / archived;needs-login 可重开;published/archived 受限。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const TASK_STATUSES = ["open", "diagnosing", "draft-ready", "published", "archived", "needs-login", "needs-regeneration"];

const TRANSITIONS = {
  open: ["diagnosing", "archived"],
  diagnosing: ["draft-ready", "needs-login", "needs-regeneration", "archived", "open"],
  "draft-ready": ["published", "archived"],
  published: [],
  archived: ["open"],
  "needs-login": ["open", "archived"],
  "needs-regeneration": ["archived"],
};

export function buildTask({ source, adapterId, failures = [], repro = null, now = Date.now() }) {
  if (!["errdetail", "patrol", "manual"].includes(source)) throw new Error(`未知任务来源: ${source}`);
  if (typeof adapterId !== "string" || !adapterId) throw new Error("adapterId 必填");
  if (!Array.isArray(failures) || !failures.length) throw new Error("failures 至少一条");
  for (const f of failures) {
    if (typeof f.tool !== "string" || !f.tool) throw new Error("failure.tool 必填");
    if (!Number.isFinite(f.count) || f.count < 1) throw new Error("failure.count 必须为正数");
  }
  const iso = new Date(now).toISOString();
  return {
    id: `rt-${iso.slice(0, 10)}-${adapterId}`,
    source, adapterId, runtime: null, failures, repro,
    status: "open", createdAt: iso, updatedAt: iso,
  };
}

export function transition(task, to) {
  if (!TASK_STATUSES.includes(to)) throw new Error(`未知状态: ${to}`);
  const allowed = TRANSITIONS[task.status] || [];
  if (!allowed.includes(to)) throw new Error(`非法状态迁移: ${task.status} → ${to}(允许: ${allowed.join(", ") || "无"})`);
  return { ...task, status: to, updatedAt: new Date().toISOString() };
}

export function tasksDir(home = homedir()) {
  return path.join(home, ".webcli", "repair-tasks");
}

export function saveTask(task, dir = tasksDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${task.id}.json`);
  fs.writeFileSync(file, JSON.stringify(task, null, 2) + "\n");
  return file;
}

export function loadTask(id, dir = tasksDir()) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
}

export function listTasks(dir = tasksDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}
