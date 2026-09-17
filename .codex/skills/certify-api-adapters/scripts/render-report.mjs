#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONDITIONAL_GROUPS = [
  {
    id: 'login',
    title: '登录限制',
    reasons: new Set(['LIVE_AUTH', 'SAFE_DRY_RUN_AUTH']),
    action: '在对应站点完成登录并确认浏览器会话有效，然后重载扩展并重跑。登录态由浏览器保存，报告和 profile 不保存 Cookie。',
  },
  {
    id: 'permission',
    title: '权限限制',
    reasons: new Set(['LIVE_PERMISSION', 'SAFE_DRY_RUN_PERMISSION']),
    action: '使用当前开发者有权访问的子系统、发布单或工单绑定；不要借用其他开发者 profile 中的权限对象。',
  },
  {
    id: 'fixture',
    title: '缺少安全测试数据',
    reasons: new Set(['LIVE_FIXTURE_NOT_FOUND', 'SAFE_DRY_RUN_FIXTURE_NOT_FOUND']),
    action: '准备专用 UAT、沙箱或可回收 fixture，并记录别名、最小定位参数、预期变化和清理方式。',
  },
  {
    id: 'page-context',
    title: '缺少页面上下文',
    reasons: new Set(['LIVE_PAGE_CONTEXT']),
    action: '打开并登录匹配站点的正常业务页面，确保标签页不是错误页，再重跑依赖页面态的工具。',
  },
  {
    id: 'dry-run',
    title: 'dry-run 已通过，待可逆 UAT 实写',
    reasons: new Set(['SAFE_DRY_RUN_PASS']),
    action: '指定专用 UAT 记录和回滚步骤，获得单独授权后执行确认写入并验证回滚。',
  },
  {
    id: 'mutation',
    title: '生产写入未授权',
    reasons: new Set(['PRODUCTION_MUTATION_NOT_AUTHORIZED']),
    action: '优先提供沙箱/UAT；若只能写生产，需要逐工具明确授权、影响范围、验证点和回滚方案。',
  },
]

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function option(name, fallback = null) {
  const prefix = `--${name}=`
  const value = process.argv.find((arg) => arg.startsWith(prefix))
  return value ? value.slice(prefix.length) : fallback
}

function flattenTools(matrix) {
  return (matrix.adapters || []).flatMap((adapter) => (
    (adapter.tools || []).map((tool) => ({ ...tool, adapterId: adapter.id }))
  ))
}

function groupConditionalTools(tools) {
  const groups = CONDITIONAL_GROUPS.map((group) => ({ ...group, tools: [] }))
  const other = { id: 'other', title: '其他条件', action: '检查矩阵 reasonCode 并补充共享 playbook。', tools: [] }
  for (const tool of tools.filter((candidate) => candidate.result === 'CONDITIONAL')) {
    const group = groups.find((candidate) => candidate.reasons.has(tool.reasonCode)) || other
    group.tools.push(tool)
  }
  return [...groups, ...(other.tools.length > 0 ? [other] : [])]
}

function toolList(tools) {
  return tools
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => `<code>${escapeHtml(tool.name)}</code>`)
    .join('\n')
}

export function renderReport(matrix) {
  if (!matrix || !Array.isArray(matrix.adapters)) throw new Error('matrix.adapters is required')
  const tools = flattenTools(matrix)
  const conditionalGroups = groupConditionalTools(tools)
  const failTools = tools.filter((tool) => tool.result === 'FAIL')
  const summary = matrix.summary || {}
  const adapterSummary = summary.adapters || {}
  const toolSummary = summary.tools || {}
  const conditionalCount = conditionalGroups.reduce((count, group) => count + group.tools.length, 0)
  if (conditionalCount !== (toolSummary.CONDITIONAL || 0)) throw new Error('conditional group count does not match matrix summary')

  const conditionalHtml = conditionalGroups.map((group) => `
      <details>
        <summary>${escapeHtml(group.title)}：${group.tools.length}</summary>
        <p><strong>解决：</strong>${escapeHtml(group.action)}</p>
        <div class="tool-list">${toolList(group.tools)}</div>
      </details>`).join('')
  const failRows = failTools.map((tool) => `
          <tr><td>${escapeHtml(tool.adapterId)}</td><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.reasonCode)}</td></tr>`).join('')
  const adapterRows = matrix.adapters.map((adapter) => `
          <tr><td><code>${escapeHtml(adapter.id)}</code></td><td class="${escapeHtml(adapter.result.toLowerCase())}">${escapeHtml(adapter.result)}</td><td class="num">${adapter.summary?.PASS || 0}</td><td class="num">${adapter.summary?.CONDITIONAL || 0}</td><td class="num">${adapter.summary?.FAIL || 0}</td></tr>`).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WeWorker API Adapter 认证报告</title>
  <style>
    :root{color-scheme:light dark;--page:light-dark(#f5f7fa,#12151b);--surface:light-dark(#fff,#1d2129);--soft:light-dark(#edf1f6,#292f39);--text:light-dark(#18202c,#eef2f7);--muted:light-dark(#607083,#aab5c4);--border:light-dark(#d8dee7,#3a414d);--green:light-dark(#218c5a,#4bc887);--amber:light-dark(#b9780d,#f1b84d);--red:light-dark(#c93238,#ff6b70);font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);line-height:1.55}main{width:min(1120px,calc(100% - 32px));margin:32px auto 60px;display:grid;gap:20px}h1,h2{margin:0;line-height:1.25}p{margin:0}.lead{color:var(--muted);max-width:86ch}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,section{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px}.metric span{display:block}.metric .label{color:var(--muted)}.metric .value{font-size:30px;font-weight:700}.metric .note{font-size:13px;color:var(--muted)}section{display:grid;gap:12px}.result{display:flex;gap:8px;flex-wrap:wrap}.pill{padding:4px 10px;border-radius:999px;background:var(--soft);font-weight:600}.pass{color:var(--green)}.conditional{color:var(--amber)}.fail{color:var(--red)}details{border:1px solid var(--border);border-radius:10px;padding:11px 13px}summary{cursor:pointer;font-weight:600}details[open] summary{margin-bottom:8px}.tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 14px;margin-top:8px}.tool-list code{overflow-wrap:anywhere}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-size:13px}.num{text-align:right;font-variant-numeric:tabular-nums}tbody tr:last-child td{border-bottom:0}code{font-family:"SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}.safety{color:var(--muted)}@media(max-width:720px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.tool-list{grid-template-columns:1fr}}@media(max-width:420px){main{width:calc(100% - 20px)}.metrics{grid-template-columns:1fr}.metric,section{padding:15px}}
  </style>
</head>
<body>
  <main>
    <header>
      <h1>API Adapter 全量认证</h1>
      <p class="lead">范围 ${matrix.adapterCount} 个 Adapter、${matrix.toolCount} 个 API/background 工具。真实链路：${escapeHtml(matrix.callPath || 'webcli call -> Bridge -> Chrome Extension -> Adapter')}。</p>
    </header>
    <div class="metrics">
      <div class="metric"><span class="label">工具 PASS</span><span class="value pass">${toolSummary.PASS || 0}</span><span class="note">真实读取成功</span></div>
      <div class="metric"><span class="label">工具 CONDITIONAL</span><span class="value conditional">${toolSummary.CONDITIONAL || 0}</span><span class="note">按限制类型逐项处理</span></div>
      <div class="metric"><span class="label">工具 FAIL</span><span class="value fail">${toolSummary.FAIL || 0}</span><span class="note">发布阻塞</span></div>
      <div class="metric"><span class="label">Adapter 结果</span><span class="value">${adapterSummary.PASS || 0}/${adapterSummary.CONDITIONAL || 0}/${adapterSummary.FAIL || 0}</span><span class="note">PASS / CONDITIONAL / FAIL</span></div>
    </div>
    <section>
      <h2>CONDITIONAL 限制与解决方向</h2>
      <p class="lead">每个工具只按当前首要阻塞原因归入一组。登录、权限、fixture 和页面上下文均属于当前 profile，不能跨开发者复用。</p>${conditionalHtml}
    </section>
    <section>
      <h2>FAIL 工具：${failTools.length}</h2>
      <div class="table-wrap"><table><thead><tr><th>Adapter</th><th>工具</th><th>失败类型</th></tr></thead><tbody>${failRows}
        </tbody></table></div>
    </section>
    <section>
      <h2>Adapter 矩阵</h2>
      <div class="table-wrap"><table><thead><tr><th>Adapter</th><th>结果</th><th class="num">PASS</th><th class="num">CONDITIONAL</th><th class="num">FAIL</th></tr></thead><tbody>${adapterRows}
        </tbody></table></div>
    </section>
    <section class="safety"><p><strong>安全边界：</strong>报告只使用矩阵中的工具名、状态和原因码；不嵌入 Cookie、token、业务正文、参数值、profile 能力值或用户路径。</p></section>
  </main>
</body>
</html>
`
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const matrixPath = option('matrix')
    const outputPath = option('output')
    if (!matrixPath || !outputPath) throw new Error('--matrix and --output are required')
    const matrix = JSON.parse(readFileSync(resolve(matrixPath), 'utf8'))
    const html = renderReport(matrix)
    writeFileSync(resolve(outputPath), html, 'utf8')
    process.stdout.write(`${JSON.stringify({ output: outputPath, adapterCount: matrix.adapterCount, toolCount: matrix.toolCount })}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
