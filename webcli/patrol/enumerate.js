/**
 * 巡检清单：已装 adapter 的每条工具一行，标注"有没有样本 / 有没有基线 / 能不能安全执行"。
 *
 * 样本来自 e2e-cases/*.json（既有资产，人工维护了参数与安全跑法）；
 * 没有样本的命令**不是错误**，只是本轮只判连通并标 needs-sample。
 */

/** `safetyMode === 'none'` 表示"没有安全跑法"——写命令直接跳过。 */
const UNSAFE_SAFETY_MODES = new Set(['none', undefined, null, ''])

/** 只读语义的 safety 值，读命令不需要 safetyMode。 */
const READ_SAFETY = new Set(['read', 'sensitive_read'])

export function indexSamples(manifests) {
  const map = new Map()
  for (const [fileName, manifest] of manifests) {
    for (const testCase of manifest.cases ?? []) {
      map.set(testCase.command, { ...testCase, source: `${fileName}#${testCase.id}` })
    }
  }
  return map
}

/**
 * @param {{ adapterId: string, tools: Array<{tool: string}>, samples: Map, baseline: object|null }} input
 * @returns {Array<{tool, adapterId, hasSample, hasBaseline, skipReason, sample}>}
 */
export function buildPatrolList({ adapterId, tools, samples, baseline }) {
  return tools.map(({ tool }) => {
    const sample = samples.get(tool) ?? null
    const hasSample = sample !== null
    const hasBaseline = Boolean(baseline?.tools?.[tool]?.shape)

    let skipReason = null
    if (!hasSample) {
      skipReason = 'needs-sample'
    } else {
      const isRead = READ_SAFETY.has(sample.safety)
      const hasSafeWriteMode = !UNSAFE_SAFETY_MODES.has(sample.safetyMode)
      if (!isRead && !hasSafeWriteMode) skipReason = 'unsafe-write'
    }

    return { adapterId, tool, hasSample, hasBaseline, skipReason, sample }
  })
}
