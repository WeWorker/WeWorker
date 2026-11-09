import { useState, useEffect, useCallback } from 'react'
import { fetchStats, groupByDomain, groupByUser, fetchActiveUsers } from '../lib/stats'
import { fetchVisits } from '../lib/visits'

const SINCE_OPTIONS = [
  { value: '1d', label: '近1天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: '90d', label: '近90天' },
  { value: 'custom', label: '自定义' },
]
const KIND_OPTIONS = ['adapter', 'builtin']
const VIEW_OPTIONS = ['adapter', 'user', 'err']

// 用 officialWeb 主题 token class（bg-bg / bg-surface / text-[rgb(var(--color-text))] / border-border
// / text-accent / text-muted），自动跟随明暗主题切换，不硬编码颜色。

export default function Stats() {
  const [groups, setGroups] = useState([])
  const [totalCalls, setTotalCalls] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statsUnavailable, setStatsUnavailable] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set())
  const [view, setView] = useState('adapter')

  // 时间窗:预设走 since 相对窗;自定义走 from/to(YYYY-MM-DD,UTC 日界)。
  // 自定义模式下一律回落 since=30d(后端 from/to 存在时忽略 since;旧 server 未升级时
  // 也回落到合理的 30 天窗,绝不让字面 'custom' 出现在请求里)。
  // 起止都没填时即 30d 预设;from>to 产生空窗(后端契约如此),由日期输入 min/max 约束。
  const [since, setSince] = useState('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const isCustom = since === 'custom'
  const effSince = isCustom ? '30d' : since
  const apiFrom = isCustom ? customFrom || null : null
  const apiTo = isCustom ? customTo || null : null

  const [kind, setKind] = useState('adapter')

  // 按错误视图(err):错误类型聚合 rows + 失败总数(UI 渲染在下一任务)
  const [errRows, setErrRows] = useState([])
  const [totalFailed, setTotalFailed] = useState(0)

  // 网站访问量（PV/UV）
  const [visits, setVisits] = useState(null)
  const [visitsLoading, setVisitsLoading] = useState(true)
  const [visitsError, setVisitsError] = useState(null)
  const [visitsUnavailable, setVisitsUnavailable] = useState(false)

  const [active, setActive] = useState(null)
  const [activeLoading, setActiveLoading] = useState(true)
  const [activeError, setActiveError] = useState(null)
  const [activeUnavailable, setActiveUnavailable] = useState(false)

  const loadActive = useCallback(async () => {
    setActiveLoading(true)
    setActiveError(null)
    setActiveUnavailable(false)
    try {
      const data = await fetchActiveUsers({ since: effSince, from: apiFrom, to: apiTo, kind })
      setActiveUnavailable(Boolean(data.unavailable))
      setActive(data)
    } catch (e) {
      setActiveError(e.message)
    } finally {
      setActiveLoading(false)
    }
  }, [effSince, apiFrom, apiTo, kind])

  useEffect(() => {
    loadActive()
  }, [loadActive])

  const loadVisits = useCallback(async () => {
    setVisitsLoading(true)
    setVisitsError(null)
    setVisitsUnavailable(false)
    try {
      const data = await fetchVisits({ since: effSince, from: apiFrom, to: apiTo })
      setVisitsUnavailable(Boolean(data.unavailable))
      setVisits(data)
    } catch (e) {
      setVisitsError(e.message)
    } finally {
      setVisitsLoading(false)
    }
  }, [effSince, apiFrom, apiTo])

  useEffect(() => {
    loadVisits()
  }, [loadVisits])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setStatsUnavailable(false)
    try {
      const by = view === 'user' ? 'user' : view === 'err' ? 'err' : 'tool'
      const data = await fetchStats({ by, since: effSince, kind, from: apiFrom, to: apiTo })
      setStatsUnavailable(Boolean(data.unavailable))
      const rows = data.rows || []
      if (view === 'err') {
        setErrRows(rows)
        setTotalFailed(data.totalFailed || 0)
        setGroups([])
      } else {
        setGroups(view === 'user' ? groupByUser(rows) : groupByDomain(rows))
        setErrRows([])
        setTotalFailed(0)
      }
      setTotalCalls(data.totalCalls || 0)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [view, effSince, kind, apiFrom, apiTo])

  useEffect(() => {
    load()
  }, [load])

  // 切换视图时清空展开态 + groups，避免 fetch 期间用旧视图数据套新列模板渲染崩溃
  const switchView = (v) => {
    setView(v)
    setExpanded(new Set())
    setGroups([])
    setLoading(true)
  }

  const toggle = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const okColor = (rate) =>
    rate == null
      ? 'text-muted'
      : rate >= 95
        ? 'text-emerald-500'
        : rate >= 80
          ? 'text-amber-500'
          : 'text-red-500'

  const fmt = (n) => Number(n).toLocaleString()

  const isErr = view === 'err'
  const isUser = view === 'user'
  const cols = isErr
    ? 'grid-cols-[1fr_90px_80px_80px_1fr]'
    : isUser
      ? 'grid-cols-[1fr_100px_40px]'
      : 'grid-cols-[1fr_80px_80px_80px_80px_40px]'

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-28 pb-16">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-[rgb(var(--color-text))] mb-2">Adapter 调用统计</h1>
          <p className="text-muted">全团队 adapter 调用频次、成功率与耗时分布。</p>
        </div>
        <button
          onClick={() => { load(); loadVisits(); loadActive(); }}
          disabled={loading}
          className="px-4 py-2.5 rounded-lg border border-accent/40 bg-accent/5 text-accent hover:bg-accent/10 text-sm font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
        >
          <svg
            className={loading ? 'animate-spin' : ''}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-6 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted">视图</span>
          <div className="flex bg-surface border border-border rounded-lg overflow-hidden">
            {VIEW_OPTIONS.map((v) => (
              <button
                key={v}
                onClick={() => switchView(v)}
                className={`px-3 py-1.5 transition-colors ${
                  view === v
                    ? 'bg-accent/20 text-[rgb(var(--color-text))]'
                    : 'text-muted hover:text-[rgb(var(--color-text))]'
                }`}
              >
                {v === 'err' ? '按错误' : v === 'user' ? '按用户' : '按 Adapter'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted">时间窗</span>
          <div className="flex bg-surface border border-border rounded-lg overflow-hidden">
            {SINCE_OPTIONS.map((s) => (
              <button
                key={s.value}
                onClick={() => setSince(s.value)}
                className={`px-3 py-1.5 transition-colors ${
                  since === s.value
                    ? 'bg-accent/20 text-[rgb(var(--color-text))]'
                    : 'text-muted hover:text-[rgb(var(--color-text))]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {isCustom && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-border bg-surface text-[rgb(var(--color-text))] text-sm"
              />
              <span className="text-muted">至</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-border bg-surface text-[rgb(var(--color-text))] text-sm"
              />
            </div>
          )}
        </div>
        {view !== 'err' && (
          <div className="flex items-center gap-2">
            <span className="text-muted">类型</span>
            <div className="flex bg-surface border border-border rounded-lg overflow-hidden">
              {KIND_OPTIONS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`px-3 py-1.5 transition-colors ${
                    kind === k
                      ? 'bg-accent/20 text-[rgb(var(--color-text))]'
                      : 'text-muted hover:text-[rgb(var(--color-text))]'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        )}
        {!loading && !error && !statsUnavailable && (
          view === 'err'
            ? errRows.length > 0 && (
                <div className="text-muted ml-auto">
                  {errRows.length} 类错误 · {fmt(totalFailed)} 次失败
                </div>
              )
            : groups.length > 0 && (
                <div className="text-muted ml-auto">
                  {isUser ? `${groups.length} 个用户` : `${groups.length} 个 adapter`} · {fmt(totalCalls)} 次调用
                </div>
              )
        )}
      </div>

      {/* 网站访问量（PV/UV） */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-[rgb(var(--color-text))]">网站访问量</h2>
          {!visitsLoading && !visitsError && visits && (
            <div className="text-muted text-sm">
              总 PV {fmt(visits.totalPv)} · 总 UV {fmt(visits.totalUv)}
            </div>
          )}
        </div>

        {visitsLoading && (
          <div className="bg-surface border border-border rounded-xl p-4 animate-pulse">
            <div className="h-4 bg-subtle/40 rounded w-1/2" />
          </div>
        )}

        {visitsError && (
          <div className="bg-surface border border-border rounded-xl p-4 text-sm text-red-500">
            网站访问量加载失败：{visitsError}
          </div>
        )}

        {!visitsLoading && !visitsError && visitsUnavailable && (
          <div className="bg-surface border border-border rounded-xl p-4 text-sm text-muted">
            网站访问统计服务暂未接入；页面可正常使用。
          </div>
        )}

        {!visitsLoading && !visitsError && !visitsUnavailable && visits && visits.rows.length === 0 && (
          <div className="bg-surface border border-border rounded-xl p-4 text-muted text-sm">暂无访问数据。</div>
        )}

        {!visitsLoading && !visitsError && !visitsUnavailable && visits && visits.rows.length > 0 && (
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[1fr_100px_100px] gap-3 px-4 py-3 text-xs text-muted border-b border-border bg-bg/40">
              <div>日期</div>
              <div className="text-right">PV</div>
              <div className="text-right">UV</div>
            </div>
            {visits.rows.map((r) => {
              const maxPv = Math.max(...visits.rows.map((x) => x.pv), 1)
              return (
                <div key={r.day} className="grid grid-cols-[1fr_100px_100px] gap-3 px-4 py-2.5 text-sm border-b border-border/60 last:border-b-0 items-center">
                  <div className="flex items-center gap-3">
                    <span className="text-[rgb(var(--color-text))] font-medium shrink-0">{r.day}</span>
                    <div className="h-1.5 bg-subtle/40 rounded-full flex-1 overflow-hidden">
                      <div
                        className="h-full bg-accent/70 rounded-full"
                        style={{ width: `${(r.pv / maxPv) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right text-[rgb(var(--color-text))] tabular-nums">{fmt(r.pv)}</div>
                  <div className="text-right text-[rgb(var(--color-text-soft))] tabular-nums">{fmt(r.uv)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 用户活跃（DAU/MAU） */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-[rgb(var(--color-text))]">用户活跃</h2>
          {!activeLoading && !activeError && !activeUnavailable && active && (
            <div className="text-muted text-sm">MAU（近30天）{fmt(active.mau)}</div>
          )}
        </div>

        {activeLoading && (
          <div className="bg-surface border border-border rounded-xl p-4 animate-pulse">
            <div className="h-4 bg-subtle/40 rounded w-1/2" />
          </div>
        )}

        {activeError && (
          <div className="bg-surface border border-border rounded-xl p-4 text-sm text-red-500">
            用户活跃加载失败：{activeError}
          </div>
        )}

        {!activeLoading && !activeError && activeUnavailable && (
          <div className="bg-surface border border-border rounded-xl p-4 text-sm text-muted">
            用户活跃统计暂未接入；页面可正常使用。
          </div>
        )}

        {!activeLoading && !activeError && !activeUnavailable && active && active.rows.length === 0 && (
          <div className="bg-surface border border-border rounded-xl p-4 text-muted text-sm">暂无活跃数据。</div>
        )}

        {!activeLoading && !activeError && !activeUnavailable && active && active.rows.length > 0 && (
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_120px] gap-3 px-4 py-3 text-xs text-muted border-b border-border bg-bg/40">
              <div>日期</div>
              <div className="text-right">DAU</div>
            </div>
            {active.rows.map((r) => {
              const maxDau = Math.max(...active.rows.map((x) => x.dau), 1)
              return (
                <div key={r.day} className="grid grid-cols-[1fr_120px] gap-3 px-4 py-2.5 text-sm border-b border-border/60 last:border-b-0 items-center">
                  <div className="flex items-center gap-3">
                    <span className="text-[rgb(var(--color-text))] font-medium shrink-0">{r.day}</span>
                    <div className="h-1.5 bg-subtle/40 rounded-full flex-1 overflow-hidden">
                      <div className="h-full bg-accent/70 rounded-full" style={{ width: `${(r.dau / maxDau) * 100}%` }} />
                    </div>
                  </div>
                  <div className="text-right text-[rgb(var(--color-text))] tabular-nums">{fmt(r.dau)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-lg p-4 animate-pulse">
              <div className="h-4 bg-subtle/40 rounded w-1/3" />
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-16">
          <div className="text-red-500 mb-2">统计加载失败</div>
          <p className="text-muted text-sm">{error}</p>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && statsUnavailable && (
        <div className="text-center py-16 rounded-xl border border-border bg-surface/40">
          <div className="text-[rgb(var(--color-text))] mb-2">统计服务暂未接入</div>
          <p className="text-muted text-sm">当前官网未配置 /api/stats 反向代理，稍后接入后这里会展示 Adapter 调用统计。</p>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && !statsUnavailable && !isErr && groups.length === 0 && (
        <div className="text-center py-16">
          <div className="text-[rgb(var(--color-text))] mb-2">暂无埋点数据。</div>
        </div>
      )}

      {/* Table */}
      {!loading && !error && !statsUnavailable && (
        isErr ? (
          errRows.length > 0 ? (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className={`grid ${cols} gap-3 px-4 py-3 text-xs text-muted border-b border-border bg-bg/40`}>
                <div>错误类型</div>
                <div className="text-right">调用次数</div>
                <div className="text-right">涉及工具</div>
                <div className="text-right">涉及用户</div>
                <div>样例工具</div>
              </div>
              {errRows.map((r) => (
                <div
                  key={r.err}
                  className={`grid ${cols} gap-3 px-4 py-3 text-sm border-b border-border last:border-b-0 items-center`}
                >
                  <div className="text-[rgb(var(--color-text))] font-medium truncate" title={r.err}>
                    {r.err}
                  </div>
                  <div className="text-right tabular-nums text-red-500">{fmt(r.calls)}</div>
                  <div className="text-right tabular-nums text-[rgb(var(--color-text-soft))]">{fmt(r.tools)}</div>
                  <div className="text-right tabular-nums text-[rgb(var(--color-text-soft))]">{fmt(r.users)}</div>
                  <div className="text-muted truncate" title={r.sampleTool}>
                    {r.sampleTool}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-16">
              <div className="text-[rgb(var(--color-text))] mb-2">该时间窗内无失败调用。</div>
            </div>
          )
        ) : (
          groups.length > 0 && (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              {/* Header row */}
              <div className={`grid ${cols} gap-3 px-4 py-3 text-xs text-muted border-b border-border bg-bg/40`}>
                <div>{isUser ? '用户' : '域名'}</div>
                <div className="text-right">调用次数</div>
                {!isUser && <div className="text-right">成功率</div>}
                {!isUser && <div className="text-right">p50(ms)</div>}
                {!isUser && <div className="text-right">p95(ms)</div>}
                <div></div>
              </div>

              {groups.map((g) => {
                const key = isUser ? g.user : g.domain
                const isOpen = expanded.has(key)
                return (
                  <div key={key} className="border-b border-border last:border-b-0">
                    {/* Summary row */}
                    <button
                      onClick={() => toggle(key)}
                      className={`w-full grid ${cols} gap-3 px-4 py-3 text-sm hover:bg-bg/40 transition-colors text-left`}
                    >
                      <div className="text-[rgb(var(--color-text))] font-medium truncate flex items-center gap-2">
                        <svg
                          className={`text-muted transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`}
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                        {key}
                      </div>
                      <div className="text-right text-[rgb(var(--color-text))] tabular-nums">{fmt(g.calls)}</div>
                      {!isUser && (
                        <div className={`text-right tabular-nums ${okColor(g.okRate)}`}>
                          {g.okRate != null ? `${g.okRate.toFixed(1)}%` : '—'}
                        </div>
                      )}
                      {!isUser && <div className="text-right text-[rgb(var(--color-text-soft))] tabular-nums">{g.p50}</div>}
                      {!isUser && <div className="text-right text-[rgb(var(--color-text-soft))] tabular-nums">{g.p95}</div>}
                      <div></div>
                    </button>

                    {/* Detail (expanded) */}
                    {isOpen && (
                      <div className="bg-bg/40 px-4 py-2">
                        {isUser
                          ? g.domains.length === 0
                            ? <div className="text-muted text-sm py-2 pl-6">无调用。</div>
                            : g.domains.map((d) => (
                                <div
                                  key={d.domain}
                                  className={`grid ${cols} gap-3 py-2 text-sm border-t border-border/60 first:border-t-0`}
                                >
                                  <div className="text-[rgb(var(--color-text-soft))] truncate pl-6" title={d.domain}>
                                    {d.domain}
                                  </div>
                                  <div className="text-right text-[rgb(var(--color-text-soft))] tabular-nums">
                                    {fmt(d.calls)}
                                  </div>
                                  <div></div>
                                </div>
                              ))
                          : g.tools.length === 0
                            ? <div className="text-muted text-sm py-2 pl-6">无工具调用。</div>
                            : g.tools.map((tool) => (
                                <div
                                  key={tool.tool}
                                  className={`grid ${cols} gap-3 py-2 text-sm border-t border-border/60 first:border-t-0`}
                                >
                                  <div className="text-[rgb(var(--color-text-soft))] truncate pl-6" title={tool.tool}>
                                    {tool.tool}
                                  </div>
                                  <div className="text-right text-[rgb(var(--color-text-soft))] tabular-nums">
                                    {fmt(tool.calls)}
                                  </div>
                                  <div className={`text-right tabular-nums ${okColor(tool.okRate)}`}>
                                    {tool.okRate != null ? `${tool.okRate.toFixed(1)}%` : '—'}
                                  </div>
                                  <div className="text-right text-[rgb(var(--color-text-faint))] tabular-nums">{tool.p50}</div>
                                  <div className="text-right text-[rgb(var(--color-text-faint))] tabular-nums">{tool.p95}</div>
                                  <div></div>
                                </div>
                              ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        )
      )}
    </div>
  )
}
