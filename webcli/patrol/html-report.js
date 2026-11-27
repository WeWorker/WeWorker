/**
 * 巡检 HTML 报告:单文件自包含(inline CSS、零外部依赖、系统字体栈、中文)。
 *
 * 设计裁决(dataviz):覆盖率/计数用 stat tile,明细用表格——数据本质是表格+状态,
 * 不做装饰性图表,无图表即无图例;状态永不裸用颜色承载语义,一律「色点 + 文字标签」
 * 配对,文字永远走墨色 token 不走状态色;明暗双主题靠 prefers-color-scheme 换
 * surface token,状态色四值两模式通用(已验证色板,固定不换)。
 *
 * 安全:站点数据含用户内容,所有动态文本(工具名/站点/错误消息/details)过 escapeHtml。
 */
import { BASELINE_VERSION } from './baseline.js'

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * 状态 → 色点与文字标签。色值即 CSS 内联值,明暗两模式通用;
 * kind 参数预留(当前色板只按 verdict 分级)。
 */
export function statusMeta(verdict, kind = null) {
  void kind
  if (verdict === 'pass') return { dot: '#0ca30c', label: '通过' }
  if (verdict === 'uncovered') return { dot: '#fab219', label: '未覆盖' }
  return { dot: '#ec835a', label: '失败' }
}

const CSS = `
:root {
  color-scheme: light dark;
  --page: #f5f4f1;
  --card: #ffffff;
  --ink: #1f1f1e;
  --ink-muted: #6e6b64;
  --line: rgba(31, 31, 30, 0.12);
  --track: rgba(31, 31, 30, 0.08);
  --group-bg: rgba(31, 31, 30, 0.045);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #161616;
    --card: #1f1f1e;
    --ink: #ececeb;
    --ink-muted: #9d9b95;
    --line: rgba(236, 236, 235, 0.16);
    --track: rgba(236, 236, 235, 0.1);
    --group-bg: rgba(236, 236, 235, 0.05);
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background: var(--page);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.55;
  padding: 36px 16px 56px;
}
.wrap { max-width: 960px; margin: 0 auto; }
h1 { font-size: 22px; font-weight: 650; }
.masthead p { margin-top: 6px; font-size: 12.5px; }
h2 { font-size: 15px; font-weight: 600; margin: 28px 0 10px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.kpis { display: grid; grid-template-columns: 1.5fr 1.5fr 1fr 1fr 1fr; gap: 10px; margin-top: 22px; }
.tile-label { font-size: 12px; color: var(--ink-muted); }
.tile-value { font-size: 26px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
.bar-row { margin-top: 10px; }
.bar { display: flex; gap: 2px; height: 14px; border-radius: 4px; overflow: hidden; }
.seg { flex-basis: 0; }
.bar-empty { background: var(--track); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th { font-size: 12px; font-weight: 500; color: var(--ink-muted); text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
.group-head th { background: var(--group-bg); font-weight: 600; font-size: 12.5px; padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 12.5px; }
.num { font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-muted); }
.empty { color: var(--ink-muted); font-size: 13px; }
.detail-json { font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 12px; color: var(--ink-muted); white-space: pre-wrap; word-break: break-word; }
.delta-label { display: inline-block; min-width: 64px; color: var(--ink-muted); font-size: 12.5px; }
.footer { margin-top: 32px; color: var(--ink-muted); font-size: 12px; }
@media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
`

const fmtTime = (iso) => iso ?? '—'

const dotHtml = (verdict) => {
  const { dot, label } = statusMeta(verdict)
  return `<span class="dot" style="background:${dot}" title="${label}"></span>${label}`
}

const formatDuration = (row) => {
  const ms = row.durationMs ?? row.details?.durationMs
  return typeof ms === 'number' ? String(ms) : '—'
}

/** 退化摘要:missing / typeChanged / emptied 计数(只列非零项)。 */
function degradationSummary(details) {
  const parts = []
  if (details?.missing?.length) parts.push(`missing ${details.missing.length}`)
  if (details?.typeChanged?.length) parts.push(`typeChanged ${details.typeChanged.length}`)
  if (details?.emptied?.length) parts.push(`emptied ${details.emptied.length}`)
  return parts.join(' · ')
}

function headerHtml(report, title) {
  return [
    '<header class="masthead">',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="muted mono">runId ${escapeHtml(report.runId ?? '—')} · ${escapeHtml(fmtTime(report.startedAt))} – ${escapeHtml(fmtTime(report.finishedAt))}</p>`,
    '</header>',
  ].join('')
}

function kpiRowHtml(report) {
  const uncoveredCount = (report.uncovered ?? []).length
  const tile = (label, value) => `<div class="card"><div class="tile-label">${label}</div><div class="tile-value">${value}</div></div>`
  const statusTile = (verdict, count) => `<div class="card"><div class="tile-label">${dotHtml(verdict)}</div><div class="tile-value">${count}</div></div>`
  return [
    '<section class="kpis">',
    tile('站点覆盖', escapeHtml(report.coverage?.sites ?? '—')),
    tile('命令覆盖', escapeHtml(report.coverage?.tools ?? '—')),
    statusTile('pass', report.passed ?? 0),
    statusTile('failed', report.failed ?? 0),
    statusTile('uncovered', uncoveredCount),
    '</section>',
  ].join('')
}

/** 单条水平堆叠分布条:按计数比例分段,段间 2px 表面色间隔(gap),每段 title 提示。 */
function distributionBarHtml(report) {
  const segments = [
    { count: report.passed ?? 0, meta: statusMeta('pass') },
    { count: report.failed ?? 0, meta: statusMeta('failed') },
    { count: (report.uncovered ?? []).length, meta: statusMeta('uncovered') },
  ].filter((segment) => segment.count > 0)
  if (segments.length === 0) return '<div class="bar-row"><div class="bar bar-empty" title="无结果"></div></div>'
  const bar = segments
    .map(({ count, meta }) => `<div class="seg" style="flex-grow:${count};background:${meta.dot}" title="${meta.label} ${count}"></div>`)
    .join('')
  return `<div class="bar-row"><div class="bar">${bar}</div></div>`
}

function siteHealthHtml(results) {
  if (results.length === 0) return '<p class="empty">本次巡检无结果。</p>'
  const bySite = new Map()
  for (const row of results) {
    if (!bySite.has(row.adapterId)) bySite.set(row.adapterId, [])
    bySite.get(row.adapterId).push(row)
  }
  const rows = []
  for (const [adapterId, siteRows] of bySite) {
    const subtotal = (verdict) => siteRows.filter((row) => row.verdict === verdict).length
    rows.push(`<tr class="group-head"><th colspan="5">${escapeHtml(adapterId)} · 通过 ${subtotal('pass')} / 失败 ${subtotal('failed')} / 未覆盖 ${subtotal('uncovered')}</th></tr>`)
    for (const row of siteRows) {
      rows.push(
        [
          '<tr>',
          `<td>${dotHtml(row.verdict)}</td>`,
          `<td class="mono">${escapeHtml(row.tool)}</td>`,
          `<td class="muted">${escapeHtml(row.kind ?? '—')}</td>`,
          `<td class="num">${escapeHtml(formatDuration(row))}</td>`,
          `<td class="muted">${escapeHtml(degradationSummary(row.details) || '—')}</td>`,
          '</tr>',
        ].join(''),
      )
    }
  }
  return `<table><thead><tr><th>状态</th><th>工具</th><th>判定</th><th>耗时(ms)</th><th>退化摘要</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

function failedDetailsHtml(results) {
  const failedRows = results.filter((row) => row.verdict === 'failed')
  if (failedRows.length === 0) return '<p class="empty">无失败——本轮巡检全部通过。</p>'
  const rows = failedRows.map((row) => {
    // details 完整展开:每个键一行,值 JSON 原样(嵌套结构不折叠)
    const detailText = Object.entries(row.details ?? {})
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')
    return [
      '<tr>',
      `<td class="mono">${escapeHtml(row.tool)}</td>`,
      `<td class="muted">${escapeHtml(row.kind ?? '—')}</td>`,
      `<td class="num">${escapeHtml(formatDuration(row))}</td>`,
      `<td><div class="detail-json">${escapeHtml(detailText || '—')}</div></td>`,
      '</tr>',
    ].join('')
  })
  return `<table><thead><tr><th>工具</th><th>判定</th><th>耗时(ms)</th><th>details</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

function uncoveredHtml(uncovered) {
  if (uncovered.length === 0) return '<p class="empty">无未覆盖项。</p>'
  const rows = uncovered
    .map((item) => `<tr><td class="mono">${escapeHtml(item.adapterId)}</td><td class="mono">${escapeHtml(item.tool)}</td><td class="muted">${escapeHtml(item.reason ?? '—')}</td></tr>`)
    .join('')
  return `<table><thead><tr><th>站点</th><th>工具</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`
}

function reEvidenceHtml(reEvidence) {
  if (reEvidence.length === 0) return '<p class="empty">无需重新取证。</p>'
  const rows = reEvidence
    .map((item) => `<tr><td class="mono">${escapeHtml(item.adapterId)}</td><td class="mono">${escapeHtml(item.tool)}</td><td class="muted">${escapeHtml(item.reason ?? '—')}</td></tr>`)
    .join('')
  return `<table><thead><tr><th>站点</th><th>工具</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`
}

/** 新增失败/已恢复(对比上次):有才显示。 */
function deltaHtml(newlyFailed, recovered) {
  if (newlyFailed.length === 0 && recovered.length === 0) return ''
  const lines = []
  if (newlyFailed.length > 0) lines.push(`<p><span class="delta-label">新增失败</span><span class="mono">${escapeHtml(newlyFailed.join(', '))}</span></p>`)
  if (recovered.length > 0) lines.push(`<p><span class="delta-label">已恢复</span><span class="mono">${escapeHtml(recovered.join(', '))}</span></p>`)
  return `<section><h2>对比上次巡检</h2><div class="card">${lines.join('')}</div></section>`
}

function footerHtml() {
  return `<footer class="footer">生成时间 ${escapeHtml(new Date().toISOString())} · 数据来源:webcli 巡检内核(基线形状版本 v${BASELINE_VERSION}) · 巡检产物落盘 ~/.webcli/patrol/,不入仓</footer>`
}

/**
 * 渲染完整 HTML 报告(含 doctype 的自包含单文件)。
 * @param {object} report buildReport 的输出
 * @param {{ title?: string }} options 页面标题
 */
export function renderHtmlReport(report, { title = 'Adapter 巡检报告' } = {}) {
  const uncovered = report.uncovered ?? []
  const results = report.results ?? []
  const reEvidence = report.reEvidence ?? []
  const newlyFailed = report.newlyFailed ?? []
  const recovered = report.recovered ?? []

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<div class="wrap">',
    headerHtml(report, title),
    kpiRowHtml(report),
    distributionBarHtml(report),
    '<section><h2>站点健康度</h2><div class="card">',
    siteHealthHtml(results),
    '</div></section>',
    '<section><h2>失败明细</h2><div class="card">',
    failedDetailsHtml(results),
    '</div></section>',
    '<section><h2>未覆盖(不计入通过)</h2><div class="card">',
    uncoveredHtml(uncovered),
    '</div></section>',
    '<section><h2>需重新取证</h2><div class="card">',
    reEvidenceHtml(reEvidence),
    '</div></section>',
    deltaHtml(newlyFailed, recovered),
    footerHtml(),
    '</div>',
    '</body>',
    '</html>',
  ].join('\n')
}
