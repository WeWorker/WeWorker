import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractShape } from './shape.js'

export const BASELINE_VERSION = 1

export function baselineDir(repoRoot) {
  return join(repoRoot, 'webcli', 'patrol', 'baselines')
}

export function baselinePath(repoRoot, adapterId) {
  return join(baselineDir(repoRoot), `${adapterId}.json`)
}

export function loadBaseline(repoRoot, adapterId) {
  const file = baselinePath(repoRoot, adapterId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveBaseline(repoRoot, adapterId, baseline) {
  mkdirSync(baselineDir(repoRoot), { recursive: true })
  writeFileSync(baselinePath(repoRoot, adapterId), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

/** 判断一个路径在本次采样里是否非空（用于 requiredNonEmpty 的首采记录）。 */
function isNonEmpty(value) {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.length > 0
  return true
}

/**
 * 从一次成功执行的结果生成基线条目。
 *
 * 基线来源有两条路（spec：fixture 优先）：
 * - 已有 `verificationFixture` 的命令**优先**用它推导 shape（fixture 形如
 *   `{ requiredPaths, types, notEmpty }`：types 逐条入 shape，notEmpty 即 requiredNonEmpty，
 *   source 记 'verificationFixture'）；
 * - 没有 fixture 的走首跑自建：对本次结果 extractShape，source 记 'first-run'。
 *
 * fixture 里的 `requiredPaths` 是取证时的"必返路径"声明，本期未映射（shape 已由 types 覆盖），
 * 留作子项目后续对齐；判定仍走 shape + requiredNonEmpty。
 */
export function buildBaseline({ tool, parsed, sampleSource, updatedAt, updatedBy, fixture = null }) {
  if (fixture) {
    return {
      source: 'verificationFixture',
      shape: { ...fixture.types },
      requiredNonEmpty: [...(fixture.notEmpty ?? [])],
      sampleSource,
      updatedAt,
      updatedBy,
    }
  }

  const shape = extractShape(parsed)
  const requiredNonEmpty = Object.entries(parsed ?? {})
    .filter(([, value]) => isNonEmpty(value))
    .map(([key]) => key)

  return { source: 'first-run', shape, requiredNonEmpty, sampleSource, updatedAt, updatedBy }
}

/** 更新前的预览：哪些会新增 / 变化 / 移除，供人确认。 */
export function diffBaselinePlan(oldBaseline, newBaseline) {
  const oldTools = oldBaseline?.tools ?? {}
  const newTools = newBaseline?.tools ?? {}
  const changed = []
  const added = []
  for (const [tool, entry] of Object.entries(newTools)) {
    if (!(tool in oldTools)) added.push(tool)
    else if (JSON.stringify(oldTools[tool].shape) !== JSON.stringify(entry.shape)) changed.push(tool)
  }
  const removed = Object.keys(oldTools).filter((tool) => !(tool in newTools))
  return { added, changed, removed }
}
