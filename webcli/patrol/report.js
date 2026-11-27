/**
 * 巡检报告。
 *
 * 核心约定：**未覆盖 ≠ 通过**。覆盖率是报告的头号指标，排在通过率之前——
 * 否则"35 个站只跑了 3 个"会被读成一片绿。
 */

const CONTENT_ESCALATION = 'content_degraded'

export function buildReport({ runId, startedAt = null, finishedAt = null, rows = [], siteCount = 0, loginHealth = [], previousReport = null }) {
  const covered = rows.filter((row) => row.verdict !== 'uncovered')
  const passed = covered.filter((row) => row.verdict === 'pass')
  const failed = covered.filter((row) => row.verdict === 'failed')
  const uncovered = rows
    .filter((row) => row.verdict === 'uncovered')
    .map((row) => ({ adapterId: row.adapterId, tool: row.tool, reason: row.details?.reason ?? row.kind ?? 'unknown' }))

  const coveredSites = new Set(covered.map((row) => row.adapterId))

  const previousByTool = new Map((previousReport?.results ?? []).map((item) => [item.tool, item]))

  const results = rows.map((row) => {
    const prev = previousByTool.get(row.tool)
    // 内容退化需要"连续两次"才升级——单次波动不惊动人
    const escalated = row.kind === CONTENT_ESCALATION && prev?.kind === CONTENT_ESCALATION
    return { ...row, escalated }
  })

  const reEvidence = results
    .filter((row) => row.kind === 'site_changed' || row.escalated)
    .map((row) => ({ adapterId: row.adapterId, tool: row.tool, reason: row.kind, evidence: row.details ?? {} }))

  const newlyFailed = results
    .filter((row) => row.verdict === 'failed' && previousByTool.get(row.tool)?.verdict !== 'failed')
    .map((row) => row.tool)
  const recovered = results
    .filter((row) => row.verdict === 'pass' && previousByTool.get(row.tool)?.verdict === 'failed')
    .map((row) => row.tool)

  return {
    runId,
    startedAt,
    finishedAt,
    coverage: {
      sites: `${coveredSites.size}/${siteCount}`,
      tools: `${covered.length}/${rows.length}`,
    },
    passed: passed.length,
    failed: failed.length,
    uncovered,
    results,
    reEvidence,
    newlyFailed,
    recovered,
    loginHealth,
  }
}

export function formatTextReport(report) {
  const lines = []
  lines.push(`覆盖 ${report.coverage.sites} 站 · ${report.coverage.tools} 条命令   通过 ${report.passed} / 失败 ${report.failed} / 未覆盖 ${report.uncovered.length}`)

  if (report.failed > 0) {
    lines.push('')
    lines.push('── 失败 ──')
    for (const row of report.results.filter((item) => item.verdict === 'failed')) {
      lines.push(`[${row.kind}] ${row.tool}`)
      for (const [key, value] of Object.entries(row.details ?? {})) {
        if (Array.isArray(value) && value.length > 0) lines.push(`       ${key}: ${JSON.stringify(value)}`)
      }
    }
  }

  if (report.uncovered.length > 0) {
    lines.push('')
    lines.push('── 未覆盖（不计入通过）──')
    const byReason = {}
    for (const item of report.uncovered) (byReason[item.reason] ??= []).push(item.tool)
    for (const [reason, tools] of Object.entries(byReason)) lines.push(`  ${reason}: ${tools.length} 条（如 ${tools[0]}）`)
  }

  if (report.reEvidence.length > 0) {
    lines.push('')
    lines.push('── 需重新取证 ──')
    for (const item of report.reEvidence) lines.push(`  ${item.tool}（${item.reason}）`)
  }

  if (report.newlyFailed.length > 0) lines.push(`\n新增失败：${report.newlyFailed.join(', ')}`)
  if (report.recovered.length > 0) lines.push(`已恢复：${report.recovered.join(', ')}`)

  return lines.join('\n')
}
