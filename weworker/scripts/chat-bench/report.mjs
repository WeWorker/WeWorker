// 报告输出：每用例 JSONL 逐事件明细 + summary.md 汇总 + cases.json 机读。
import fs from 'node:fs'
import path from 'node:path'

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }) }

const fmtMs = (ms) => ms == null ? '-' : `${Math.round(ms)}ms`
const fmtTok = (n) => n == null ? '-' : String(n)
const pct = (x) => x == null ? '-' : `${(x * 100).toFixed(1)}%`
const money = (x) => x == null ? '-' : `$${Number(x).toFixed(5)}`
function truncate(s, n = 30) {
  s = String(s || '').replace(/[\r\n|]/g, ' ')
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function formatAssertions(a) {
  if (!a || !Object.keys(a).length) return '-'
  const parts = []
  if (a.expectToolsOk != null) {
    parts.push(a.expectToolsOk ? '✓tools' : `✗tools(${(a.expectToolsMissed || []).join(';')})`)
  }
  if (a.maxMsOk != null) parts.push(a.maxMsOk ? '✓ms' : `✗ms(>${a.expectMaxMs})`)
  if (a.routeOk != null) {
    parts.push(a.routeOk ? '✓route' : `✗route(期望${a.expectRoute ? '走路由' : '落回LLM'})`)
  }
  return parts.join(' ') || '-'
}

/** 这一轮到底走没走快速路由——报告里第一眼要看的那个字。 */
function formatRoute(r) {
  const route = r.route
  if (!route) return '-'
  if (!route.hit) return '未命中(LLM)'
  return `命中 ${route.tool || '?'}${route.source ? ` [${route.source}]` : ''}`
}

/**
 * 「用户实际拿到了什么」——只看有没有命中路由会漏掉一整类问题：
 * 命中是命中了，但工具报错，用户看到的是 60 字的失败提示（没有数据、也没有 LLM 兜底）。
 *
 * 判据直接对渲染器的模板，不猜（`api-query-router/generic-renderer.ts`）：
 *   `⚠️ 查询失败：…` / `⚠️ 查询返回为空。` / `⚠️ 结果过大已落盘…`
 * 三者都带全角感叹号前缀，正常数据表不会以它开头 —— 所以「首行前缀」即可判定。
 */
const RESULT_KINDS = [
  ['报错', /⚠️ 查询失败：/],
  ['空结果', /⚠️ 查询返回为空。/],
  ['落盘指针', /⚠️ 结果过大已落盘/],
]

export function classifyResult(r) {
  const text = String(r.answer ?? '')
  if (!text.trim()) return '无输出'
  for (const [kind, re] of RESULT_KINDS) if (re.test(text)) return kind
  return '数据'
}

/** 首行摘要：给表格用的一格短文本。 */
function firstLine(text, n = 26) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || ''
  return truncate(line, n)
}

/** 回答原文的摘录：限行数 + 字符数，超出加省略标记（完整文本在 cases.json）。 */
function answerExcerpt(text, maxLines = 20, maxChars = 1500) {
  const s = String(text || '').trim()
  if (!s) return ''
  let lines = s.split('\n')
  let cut = false
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); cut = true }
  let out = lines.join('\n')
  if (out.length > maxChars) { out = out.slice(0, maxChars); cut = true }
  return cut ? `${out}\n…（截断：完整 ${s.length} 字符，见 cases.json 的 answer）` : out
}

const meanOf = (list, pick) => {
  const vals = list.map(pick).filter((v) => v != null)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

const KIND_ORDER = ['数据', '报错', '空结果', '落盘指针', '无输出']

/**
 * `results.md`：**逐条结果速查表**——「每个回答：是否命中路由 / 结果 / 耗时 / 首行」一表看完。
 * 与 summary.md 的分工：summary.md 是分析报告（汇总、来源分布、回答原文全文、异常），
 * 这里是纯台账（id 升序、一行一条、正负例分开），用来快速扫「哪条没拿到数据」。
 * 别的脚本（或人工复核）直接读这个文件即可，不必每次从 summary/cases.json 里翻。
 */
export function writeResultsMd({ runDir, runTs, results }) {
  const routed = results.filter(r => r.route?.hit)
  const fellBack = results.filter(r => r.route && !r.route.hit)
  const noRouteInfo = results.filter(r => !r.route)
  const dataKinds = new Set(['数据', '落盘指针'])
  const routedNoData = routed.filter(r => !dataKinds.has(classifyResult(r)))
  const kinds = {}
  for (const r of results) kinds[classifyResult(r)] = (kinds[classifyResult(r)] || 0) + 1

  const pos = results.filter(r => /(^|[-_])pos/.test(r.id))
  const neg = results.filter(r => /(^|[-_])neg/.test(r.id))
  const rest = results.filter(r => !pos.includes(r) && !neg.includes(r))

  const md = []
  md.push('# 逐条结果速查')
  md.push('')
  md.push(`- 运行：${runTs}`)
  md.push(`- 用例：${results.length}（ok ${results.filter(r => r.status === 'ok').length} / 异常 ${results.filter(r => r.status !== 'ok').length}）`)
  md.push(`- 是否命中路由：命中 **${routed.length}** / 落回 LLM **${fellBack.length}**${noRouteInfo.length ? ` / 无判定 ${noRouteInfo.length}` : ''}`)
  md.push(`- 命中且拿到数据：**${routed.length - routedNoData.length}** 条；命中但没拿到数据：**${routedNoData.length}** 条${routedNoData.length ? `（${routedNoData.map(r => r.id).join('、')}）` : ''}`)
  md.push(`- 结果分布：${KIND_ORDER.filter(k => kinds[k]).map(k => `${k} ${kinds[k]}`).join(' ｜ ')}`)
  md.push('')
  md.push('> 「是否命中路由」的判据是 `turn_end` 带不带 `routeTool`（只有快速路由的 `emitRoutedAnswer` 会带），不是猜的。')
  md.push('> 「结果」判据见 `report.mjs` 的 `classifyResult`（直接对渲染器模板）。单跳命中工具报错时**不回落 LLM**，用户看到的就是那句失败提示。')
  md.push('> 完整回答原文见 `summary.md` 的「每个回答的实际结果」或 `cases.json` 的 `answer`；逐事件明细见 `cases/<id>.jsonl`。')
  md.push('')

  const table = (list, title) => {
    if (!list.length) return
    md.push(`## ${title}（${list.length}）`)
    md.push('')
    md.push('| id | 输入 | 是否命中路由 | 结果 | status | totalMs | llmMs | execMs | steps | 回答首行 |')
    md.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const r of [...list].sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh', { numeric: true }))) {
      const t = r.timing || {}
      const ms = (v) => v == null ? '-' : `${Math.round(v)}`
      md.push(`| ${r.id} | ${truncate(r.prompt, 30)} | ${formatRoute(r)} | ${classifyResult(r)} | ${r.status} | ${ms(t.totalMs ?? r.wallMs)} | ${ms(t.llmMs)} | ${ms(t.execMs)} | ${t.steps ?? r.stepCount ?? '-'} | ${firstLine(r.answer)} |`)
    }
    md.push('')
  }
  table(pos, '正例')
  table(neg, '负例')
  table(rest, '其它')

  // 按耗时降序的 Top：找「哪条特别慢」比逐条扫表快
  const slow = [...results].sort((a, b) => (b.timing?.totalMs ?? b.wallMs ?? 0) - (a.timing?.totalMs ?? a.wallMs ?? 0)).slice(0, 10)
  md.push('## 最慢 10 条')
  md.push('')
  md.push('| id | 是否命中路由 | 结果 | totalMs | status |')
  md.push('|---|---|---|---|---|')
  for (const r of slow) md.push(`| ${r.id} | ${formatRoute(r)} | ${classifyResult(r)} | ${Math.round(r.timing?.totalMs ?? r.wallMs ?? 0)} | ${r.status} |`)
  md.push('')

  const out = path.join(runDir, 'results.md')
  fs.writeFileSync(out, md.join('\n'), 'utf8')
  return out
}

/**
 * @param {object} opts
 * @param {string} opts.outDir
 * @param {string} opts.runTs
 * @param {object[]} opts.results  CaseResult[]（含 trace）
 * @returns {{runDir:string, summaryPath:string}}
 */
export function writeReport({ outDir, runTs, results }) {
  const runDir = path.join(outDir, runTs)
  const casesDir = path.join(runDir, 'cases')
  ensureDir(casesDir)

  // 1) 每用例逐事件 JSONL 明细
  for (const r of results) {
    const safeId = String(r.id).replace(/[^\w.-]/g, '_')
    const f = path.join(casesDir, `${safeId}.jsonl`)
    const lines = (r.trace || []).map(ev => JSON.stringify(ev))
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8')
  }

  // 2) cases.json（去掉 trace，trace 已在 jsonl；保留 answer/steps/timing/usage/resultKind）
  const slim = results.map((r) => {
    const { trace, ...rest } = r
    return { ...rest, resultKind: classifyResult(r) }
  })
  fs.writeFileSync(path.join(runDir, 'cases.json'), JSON.stringify(slim, null, 2), 'utf8')

  // 3) summary.md
  const ok = results.filter(r => r.status === 'ok')
  const bad = results.filter(r => r.status !== 'ok')
  const totalMs = results.reduce((s, r) => s + (r.timing?.totalMs ?? r.wallMs ?? 0), 0)
  const totalIn = results.reduce((s, r) => s + (r.usage?.total_input_tokens ?? r.usage?.total_in ?? 0), 0)
  const totalOut = results.reduce((s, r) => s + (r.usage?.output_tokens ?? r.usage?.output ?? 0), 0)
  const totalCost = results.reduce((s, r) => s + (r.usage?.total_cost_usd ?? r.usage?.cost ?? 0), 0)
  const hitVals = results.map(r => r.usage?.cache_hit_rate ?? r.usage?.cache_hit).filter(v => v != null)
  const avgHit = hitVals.length ? hitVals.reduce((a, b) => a + b, 0) / hitVals.length : null

  const sorted = [...results].sort(
    (a, b) => (b.timing?.totalMs ?? b.wallMs ?? 0) - (a.timing?.totalMs ?? a.wallMs ?? 0)
  )

  const md = []
  md.push('# Chat Bench 报告')
  md.push('')
  md.push(`- 运行时间: ${runTs}`)
  md.push(`- 用例数: ${results.length}（ok ${ok.length} / 异常 ${bad.length}）`)
  md.push(`- 对话总耗时(sum totalMs): ${(totalMs / 1000).toFixed(1)}s`)
  md.push(`- token: in ${totalIn.toLocaleString()} / out ${totalOut.toLocaleString()}`)
  md.push(`- 总 cost: ${money(totalCost)}　平均 cache_hit: ${pct(avgHit)}`)
  md.push('')
  md.push('## 用例明细（按 totalMs 降序）')
  md.push('')
  md.push('| id | prompt | status | 是否命中路由 | 结果 | totalMs | llmMs | execMs | steps | in/out | cache_hit | cost | 断言 |')
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of sorted) {
    const u = r.usage || {}
    const t = r.timing || {}
    const inTok = u.total_input_tokens ?? u.total_in ?? u.input_tokens ?? u.input
    const outTok = u.output_tokens ?? u.output
    md.push(
      `| ${r.id} | ${truncate(r.prompt, 30)} | ${r.status} | ${formatRoute(r)} | ${classifyResult(r)} | ${fmtMs(t.totalMs)} | ${fmtMs(t.llmMs)} | ${fmtMs(t.execMs)} | ${t.steps ?? r.stepCount ?? '-'} | ${fmtTok(inTok)}/${fmtTok(outTok)} | ${pct(u.cache_hit_rate ?? u.cache_hit)} | ${money(u.total_cost_usd ?? u.cost)} | ${formatAssertions(r.assertions)} |`,
    )
  }
  md.push('')

  // ── 路由命中汇总：这是「智能路由到底省了多少」的正面回答 ────────────────────
  const routed = results.filter(r => r.route?.hit)
  const fellBack = results.filter(r => r.route && !r.route.hit)
  const routedAvg = meanOf(routed, r => r.timing?.totalMs ?? r.wallMs)
  const fellBackAvg = meanOf(fellBack, r => r.timing?.totalMs ?? r.wallMs)
  md.push('## 路由命中汇总')
  md.push('')
  md.push(`- 走快速路由：**${routed.length}** 条，平均 ${fmtMs(routedAvg)}（其中 llmMs 平均 ${fmtMs(meanOf(routed, r => r.timing?.llmMs))}）`)
  md.push(`- 落回 LLM：**${fellBack.length}** 条，平均 ${fmtMs(fellBackAvg)}`)
  if (routedAvg != null && fellBackAvg != null) {
    md.push(`- 同批对比：走路由每条省约 ${fmtMs(Math.max(0, fellBackAvg - routedAvg))}（不同问题难度不同，仅作量级参考）`)
  }
  const routeFails = results.filter(r => r.assertions?.routeOk === false)
  if (routeFails.length) {
    md.push('')
    md.push(`- ⚠️ 命中判定与预期不符 ${routeFails.length} 条：${routeFails.map(r => r.id).join('、')}`)
  }

  // 命中的**结果质量**：命中不等于拿到了数据。工具报错时用户只看到失败提示，
  // 单跳命中还不会回落给 LLM 兜底 —— 不单列出来，这一整类会被 ✓route 掩盖。
  const dataKinds = new Set(['数据', '落盘指针'])
  const routedNoData = routed.filter(r => !dataKinds.has(classifyResult(r)))
  if (routed.length) {
    md.push('')
    md.push(`- 命中且拿到数据：**${routed.length - routedNoData.length}** 条；命中但没拿到数据：**${routedNoData.length}** 条`)
    if (routedNoData.length) {
      const kinds = {}
      for (const r of routedNoData) (kinds[classifyResult(r)] ||= []).push(r.id)
      for (const [kind, ids] of Object.entries(kinds)) {
        md.push(`  - ${kind}：${ids.length} 条 —— ${ids.join('、')}`)
      }
      md.push('  - 读法：这些条目的「命中」只是路由判定没错，用户实际拿到的是失败提示（单跳命中不回落 LLM，无兜底）。')
    }
  }
  if (routed.length) {
    const bySource = {}
    for (const r of routed) {
      const key = r.route.source || '(未标来源)'
      ;(bySource[key] ||= []).push(r)
    }
    md.push('')
    md.push('| 命中来源(routeSource) | 条数 | 平均 totalMs |')
    md.push('|---|---|---|')
    for (const [source, rs] of Object.entries(bySource).sort((a, b) => b[1].length - a[1].length)) {
      md.push(`| ${source} | ${rs.length} | ${fmtMs(meanOf(rs, r => r.timing?.totalMs ?? r.wallMs))} |`)
    }
  }
  md.push('')

  if (bad.length) {
    md.push('## 异常 / 超时用例')
    md.push('')
    for (const r of bad) {
      md.push(`### ${r.id} — \`${r.status}\``)
      md.push(`- prompt: ${r.prompt}`)
      if (r.error) md.push(`- error: ${truncate(r.error, 200)}`)
      md.push('')
    }
  }

  // 按 site 汇总（多为 test-prompts 来源）
  const bySite = {}
  for (const r of results) {
    if (!r.siteId) continue
    ;(bySite[r.siteId] ||= []).push(r)
  }
  if (Object.keys(bySite).length) {
    md.push('## 按 site 汇总')
    md.push('')
    md.push('| siteId | 用例数 | ok | 平均 totalMs | 平均 cache_hit |')
    md.push('|---|---|---|---|---|')
    for (const [site, rs] of Object.entries(bySite)) {
      const o = rs.filter(r => r.status === 'ok').length
      const avg = rs.reduce((s, r) => s + (r.timing?.totalMs ?? 0), 0) / rs.length
      const hv = rs.map(r => r.usage?.cache_hit_rate ?? r.usage?.cache_hit).filter(v => v != null)
      const avgH = hv.length ? hv.reduce((a, b) => a + b, 0) / hv.length : null
      md.push(`| ${site} | ${rs.length} | ${o} | ${fmtMs(avg)} | ${pct(avgH)} |`)
    }
    md.push('')
  }

  // ── 每个回答的实际结果（用户实际看到的那段原文）────────────────────────────
  md.push('## 每个回答的实际结果')
  md.push('')
  md.push('按 id 排序；每条给「路由判定 → 耗时 → 结果分类 → 回答原文」。原文超过 20 行或 1500 字符只截前段，完整文本在 `cases.json` 的 `answer` 字段。')
  md.push('')
  for (const r of [...results].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const t = r.timing || {}
    md.push(`### ${r.id} — ${r.prompt}`)
    md.push(`- 路由：${formatRoute(r)}${r.route?.args ? `　参数 ${r.route.args}` : ''}`)
    md.push(`- 耗时：total ${fmtMs(t.totalMs)}（exec ${fmtMs(t.execMs)} / llm ${fmtMs(t.llmMs)}，${t.steps ?? r.stepCount ?? '-'} 步）`)
    md.push(`- 结果：**${classifyResult(r)}**（${r.textLength ?? 0} 字符${r.answerTruncated ? '，原文已截断' : ''}）`)
    if (r.error) md.push(`- error：${truncate(r.error, 200)}`)
    const body = answerExcerpt(r.answer)
    md.push('')
    md.push(body ? '```text\n' + body + '\n```' : '（无回答文本）')
    md.push('')
  }

  md.push('## 明细')
  md.push('- 每用例逐 SSE 事件（含 think/exec/usage）：`cases/<id>.jsonl`')
  md.push('- 全量机读结果（含 steps/timing/usage）：`cases.json`')
  fs.writeFileSync(path.join(runDir, 'summary.md'), md.join('\n'), 'utf8')

  // 4) results.md：逐条结果速查台账（正/负例分开，id 升序）
  const resultsPath = writeResultsMd({ runDir, runTs, results })

  return { runDir, summaryPath: path.join(runDir, 'summary.md'), resultsPath }
}

// CLI：从既有运行目录的 cases.json 重新生成 results.md（不重跑 bench、不动 summary/jsonl）。
//   node scripts/chat-bench/report.mjs --from-cases ./bench-out/<时间戳>
if (process.argv.includes('--from-cases')) {
  const i = process.argv.indexOf('--from-cases')
  const runDir = path.resolve(process.argv[i + 1] || '')
  const casesPath = path.join(runDir, 'cases.json')
  if (!fs.existsSync(casesPath)) {
    console.error(`[results] 找不到 ${casesPath}`)
    process.exit(1)
  }
  const results = JSON.parse(fs.readFileSync(casesPath, 'utf8'))
  const out = writeResultsMd({ runDir, runTs: path.basename(runDir), results })
  console.log(`[results] 已生成 ${out}（${results.length} 条）`)
}
