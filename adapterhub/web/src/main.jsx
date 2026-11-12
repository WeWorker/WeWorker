import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import './styles.css'
import { CATEGORIES, SOURCES, siteCategory, siteSource } from './site-classification.js'

// 根据当前访问地址自动推导应用基路径
const BASE = (() => {
  const marker = '/adapterhub'
  const index = location.pathname.indexOf(marker)
  return index >= 0 ? location.pathname.slice(0, index) + marker : marker
})()
const api = async (path, options = {}) => {
  const response = await fetch(BASE + path, { credentials: 'same-origin', ...options })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message = body?.message || body?.error?.message || `请求失败 (${response.status})`
    const err = new Error(message)
    err.status = response.status; err.code = body?.error?.code
    throw err
  }
  return response.json()
}

const number = (value) => new Intl.NumberFormat('zh-CN').format(value || 0)
const bytes = (value) => value > 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((value || 0) / 1024))} KB`
const runtimeName = (runtime) => runtime === 'toolkit' ? 'Toolkit' : 'Extension'
const fmt = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

function go(path) { history.pushState({}, '', BASE + path); window.dispatchEvent(new PopStateEvent('popstate')) }
function useRoute() {
  const current = () => { const f = `${location.pathname}${location.search}`; const s = f.startsWith(BASE) ? f.slice(BASE.length) : f; return s || '/' }
  const [path, setPath] = useState(current)
  useEffect(() => { const change = () => setPath(current()); addEventListener('popstate', change); return () => removeEventListener('popstate', change) }, [])
  return path
}
function Link({ href, children, className = '' }) {
  return <a className={className} href={BASE + href} onClick={(event) => { event.preventDefault(); event.stopPropagation(); go(href) }}>{children}</a>
}
async function copy(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const field = document.createElement('textarea')
  field.value = value; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select()
  const copied = document.execCommand('copy'); field.remove()
  if (!copied) throw new Error('复制失败')
}

function CopyButton({ text, children = '复制', className = 'button secondary', onCopied }) {
  const [status, setStatus] = useState('idle')
  const copyText = async () => {
    try { await copy(text); setStatus('copied'); onCopied?.(); setTimeout(() => setStatus('idle'), 1600) }
    catch { setStatus('error') }
  }
  return <button className={className} type="button" onClick={copyText}>{status === 'copied' ? '✓ 已复制' : status === 'error' ? '复制失败' : children}</button>
}

function scenarioPrompts(scenarios = []) {
  return scenarios.flatMap((scenario) => (scenario.prompts || []).map((prompt) => ({ ...prompt, scenarioTitle: scenario.title || '推荐场景' }))).filter((prompt) => prompt.text)
}

function InstallDialog({ target, downloadHref, title, scenarios = [], installable = false, onClose }) {
  const [status, setStatus] = useState('idle')
  const [showPrompts, setShowPrompts] = useState(false)
  const dialog = useRef(null); const copyButton = useRef(null)
  const command = `webcli adapterhub install ${target}`
  useEffect(() => {
    copyButton.current?.focus()
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape)
  }, [onClose])
  const prompts = scenarioPrompts(scenarios)
  const copyCommand = async (event) => { event.stopPropagation(); try { await copy(command); setStatus('copied'); setShowPrompts(true); setTimeout(() => setStatus('idle'), 1600) } catch { setStatus('error') } }
  const text = status === 'copied' ? '✓ 已复制' : status === 'error' ? '复制失败' : '复制命令'
  const trapFocus = (event) => {
    if (event.key !== 'Tab') return
    const controls = [...dialog.current.querySelectorAll('button, a[href]')]
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return createPortal(<div className="modal-backdrop" onClick={(event) => { event.stopPropagation(); onClose() }}>
    <section className="install-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="install-dialog-title" onClick={(event) => event.stopPropagation()} onKeyDown={trapFocus}>
      <div className="dialog-head"><div><h2 id="install-dialog-title">{title}</h2><p>复制命令到终端执行，或直接下载 Adapter 包文件。还没有 webcli？<Link href="/docs">查看安装指引</Link></p></div><button className="dialog-close" type="button" onClick={onClose}>关闭</button></div>
      <section className="install-command-section">
        <div className="install-section-label"><strong>推荐方式：复制命令安装</strong><span>在终端执行，自动完成安装</span></div>
        <div className="dialog-command"><code>{command}</code><button ref={copyButton} className="button primary" type="button" onClick={copyCommand}>{text}</button></div>
      </section>
      {showPrompts && prompts.length ? <section className="install-prompts">
        <div className="install-prompts-head"><div><h3>安装后怎么用</h3><p>复制下面的自然语言提示词，直接发给 Agent。</p></div><CopyButton text={prompts.map((prompt) => prompt.text).join('\n')} className="button secondary" children="复制全部提示词" /></div>
        <div className="install-prompt-list">{prompts.map((prompt, index) => <div className="install-prompt" key={`${prompt.text}-${index}`}><span className="prompt-scenario">{prompt.scenarioTitle}</span><p>{prompt.text}</p><CopyButton text={prompt.text} children="复制" /></div>)}</div>
      </section> : null}
      <div className={`dialog-download ${installable ? '' : 'is-unavailable'}`}>
        <div><strong>下载 Adapter 包</strong><span>{installable ? '适合离线安装、校验、归档或手动传输。' : '该 Adapter 当前没有可下载的 .adapt 制品，暂时只能通过命令安装。'}</span></div>
        {installable ? <a className="button secondary" href={BASE + downloadHref} download onClick={(event) => { event.stopPropagation(); setShowPrompts(true) }}>下载 .adapt</a> : <span className="download-unavailable">暂不可下载</span>}
      </div>
    </section>
  </div>, document.body)
}
function InstallAction({ target, downloadHref, title = '安装 Adapter', scenarios = [], installable = false, variant = 'hover' }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef(null)
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()) }
  return <>
    <button ref={trigger} className={`button primary install-action ${variant}`} type="button" aria-label={`安装 ${target}`} onClick={(event) => { event.stopPropagation(); setOpen(true) }}>安装</button>
    {open ? <InstallDialog target={target} downloadHref={downloadHref} title={title} scenarios={scenarios} installable={installable} onClose={close} /> : null}
  </>
}

function LoginButton({ me }) {
  if (me === undefined) return null
  if (me?.logged_in) return <button className="button secondary login-btn" type="button" onClick={() => go('/me')} title={`已登录：${me.userid}`}>👤 {me.userid}</button>
  if (!me?.login_url) return null
  return <button className="button secondary login-btn" type="button" onClick={() => { location.href = me.login_url }}>登录</button>
}

function Shell({ children }) {
  const route = useRoute()
  const [query, setQuery] = useState(new URLSearchParams(location.search).get('q') || '')
  const [me, setMe] = useState(undefined)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  useEffect(() => { api('/api/v1/me').then(setMe).catch(() => setMe(null)) }, [])
  // 匿名浏览完整可用：不自动跳转登录。登录只为 PAT/收藏/我管理的等个人能力。
  // 未登录时顶部显示「登录」按钮供用户主动点击。
  useEffect(() => setQuery(new URLSearchParams(location.search).get('q') || ''), [route])
  const active = route.startsWith('/me') ? 'me' : route.startsWith('/docs') ? 'docs' : 'sites'
  const submit = (event) => { event.preventDefault(); const next = query.trim(); go(next ? `/sites?q=${encodeURIComponent(next)}` : '/sites') }
  return <>
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/sites" className="brand"><span className="brand-mark">W</span><span>WeWorker AdapterHub</span></Link>
        <form className="global-search" onSubmit={submit} role="search">
          <label className="sr-only" htmlFor="global-search">搜索 Adapter</label>
          <input id="global-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 Adapter 名称或域名" />
          <kbd>/</kbd>
        </form>
        <nav aria-label="主导航">
          <Link href="/sites" className={active === 'sites' ? 'active' : ''}>适配器</Link>
          <Link href="/docs" className={active === 'docs' ? 'active' : ''}>文档</Link>
          {me?.logged_in ? <button type="button" className="nav-action" onClick={() => setUploadOpen(true)}>上传</button> : null}
          {me?.logged_in ? <button type="button" className="nav-action" onClick={() => setTokenOpen(true)}>令牌</button> : null}
        </nav>
        <LoginButton me={me} />
      </div>
    </header>
    <main>{children}</main>
    <footer>WeWorker AdapterHub <span>{me?.logged_in ? `已登录：${me.userid}` : '免登录浏览，使用 WebCLI 安装'}</span></footer>
    {tokenOpen && me?.logged_in ? <TokenManager me={me} onClose={() => setTokenOpen(false)} /> : null}
    {uploadOpen && me?.logged_in ? <UploadDialog me={me} onClose={() => setUploadOpen(false)} /> : null}
  </>
}

function State({ loading, error, empty, children }) {
  if (loading) return <div className="panel state catalog-skeleton" aria-label="正在加载目录"><span /><span /><span /><span /></div>
  if (error) return <div className="panel state error">{error}</div>
  if (empty) return <div className="panel state">没有找到匹配结果，请换一个关键词。</div>
  return children
}
function Metric({ value, label }) { return <div className="metric"><strong>{typeof value === 'number' ? number(value) : value}</strong><span>{label}</span></div> }
function Runtime({ value }) { return <span className={`badge ${value}`}>{runtimeName(value)}</span> }
function OriginBadge({ value }) { return <span className={`badge ${value === 'user' ? 'origin-user' : 'origin-official'}`}>{value === 'user' ? '用户上传' : '官方'}</span> }
function AdapterAuthor({ site, compact = false }) {
  if (site?.origin !== 'user' || !site.author) return null
  return <span className={`adapter-author ${compact ? 'compact' : ''}`}><span aria-hidden="true">👤</span>{compact ? site.author : <>作者 <strong>{site.author}</strong></>}</span>
}

function FilterMenu({ label, value, options, onChange }) {
  const select = (event, next) => { const details = event.currentTarget.closest('details'); onChange(next); details.removeAttribute('open'); requestAnimationFrame(() => details.querySelector('summary').focus()) }
  return <details className="filter-menu" name="catalog-filter" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.removeAttribute('open') }}>
    <summary><span>{label}</span><strong>{options.find((option) => option.value === value)?.label}</strong><i aria-hidden="true" /></summary>
    <div className="filter-options" role="menu" aria-label={label}>
      {options.map((option) => <button type="button" role="menuitemradio" aria-checked={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={(event) => select(event, option.value)}><span>{option.label}</span><small>{option.count}</small></button>)}
    </div>
  </details>
}

// 命令行（只读展示，点击查看详情：命令说明 + 参数说明）
function CommandRow({ command, rank, scenarios = [] }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="command-row command-row-btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
      {rank ? <span className="rank">{rank}</span> : null}
      <div className="command-main"><span className="command-name">{command.commandName}</span><p>{command.description || command.fullName}</p></div>
      <span className="command-detail-hint">详情</span>
    </button>
    {open ? <CommandDetailDialog command={command} scenarios={scenarios} onClose={() => setOpen(false)} /> : null}
  </>
}

// 参数表：从 JSON Schema 提取 名称/类型/必填/说明/默认值/枚举
function ParameterTable({ schema }) {
  const props = schema?.properties || {}
  const required = Array.isArray(schema?.required) ? schema.required : []
  const entries = Object.entries(props)
  if (!entries.length) return <p className="muted">此命令无参数。</p>
  return <div className="param-table-wrap"><table className="param-table"><thead><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr></thead><tbody>
    {entries.map(([name, def]) => <tr key={name}>
      <td><code>{name}</code>{def.default !== undefined ? <span className="param-default">默认 {String(def.default)}</span> : null}{Array.isArray(def.enum) ? <span className="param-enum">{def.enum.join(' | ')}</span> : null}</td>
      <td>{def.type || '-'}</td>
      <td>{required.includes(name) ? <span className="param-required">必填</span> : <span className="param-optional">选填</span>}</td>
      <td>{def.description || '-'}</td>
    </tr>)}
  </tbody></table></div>
}

function schemaType(def = {}) {
  return ['integer', 'number', 'boolean', 'array', 'object'].includes(def.type) ? def.type : 'string'
}
function schemaPlaceholder(def = {}) { return `<${schemaType(def)}>` }
function buildCliCommand(command) {
  const props = command.parametersSchema?.properties || {}
  const args = Object.fromEntries(Object.entries(props).map(([name, def]) => [name, schemaPlaceholder(def)]))
  const base = `webcli call ${command.fullName}`
  return Object.keys(args).length ? `${base} --args '${JSON.stringify(args)}'` : base
}
function buildCliFlags(command) {
  const props = command.parametersSchema?.properties || {}
  return Object.entries(props).map(([name, def]) => `--${name} ${schemaPlaceholder(def)}`).join('  ')
}

function CommandDetailDialog({ command, scenarios = [], onClose }) {
  const dialog = useRef(null)
  const cliCommand = buildCliCommand(command)
  const cliFlags = buildCliFlags(command)
  const prompts = scenarioPrompts(scenarios)
  useEffect(() => {
    dialog.current?.querySelector('button.dialog-close')?.focus()
    const escape = (event) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', escape); return () => removeEventListener('keydown', escape)
  }, [onClose])
  return <div className="modal-backdrop command-detail-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <section className="dialog command-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="command-detail-title" ref={dialog} onClick={(e) => e.stopPropagation()}>
      <div className="dialog-head"><div>
        <h2 id="command-detail-title">{command.commandName}</h2>
        <code className="command-full-name">{command.fullName}</code>
      </div>
      <button className="dialog-close" type="button" onClick={onClose}>关闭</button></div>
      <div className="command-detail-body">
        <section><h3>命令说明</h3><p>{command.description || '暂无说明'}</p></section>
        <section className="cli-command-section"><h3>WebCLI 调用</h3><pre className="cli-command-pre"><code>{cliCommand}</code></pre><p className="cli-flags"><span>参数速览</span>{cliFlags || '无参数'}</p><CopyButton text={cliCommand} className="button primary" children="复制 WebCLI 命令" /></section>
        {prompts.length ? <section className="agent-prompt-section"><h3>Agent 自然语言提示词</h3><p className="section-note">来自 manifest 推荐场景，复制后可直接发给 Agent。</p><div className="agent-prompt-list">{prompts.map((prompt, index) => <div className="agent-prompt" key={`${prompt.text}-${index}`}><div><span>{prompt.scenarioTitle}</span><p>{prompt.text}</p></div><CopyButton text={prompt.text} children="复制" /></div>)}</div></section> : null}
        <section><h3>参数</h3><ParameterTable schema={command.parametersSchema} /></section>
        {command.resultSchema && Object.keys(command.resultSchema || {}).length > 0
          ? <section><h3>返回结果</h3><pre className="schema-pre"><code>{JSON.stringify(command.resultSchema, null, 2)}</code></pre></section> : null}
      </div>
    </section>
  </div>
}

// 列表卡片：点击展开命令（只读），整包下载
function AdapterCard({ site, favorited, onToggleFav }) {
  const [commands, setCommands] = useState([])
  const [open, setOpen] = useState(false)
  const [cmdError, setCmdError] = useState('')
  const load = () => {
    if (!open && !commands.length) {
      setCmdError('')
      api(`/api/v1/adapters/${encodeURIComponent(site.name)}/commands?page_size=100`).then((data) => setCommands(data.items)).catch((error) => setCmdError(error.message))
    }
    setOpen(!open)
  }
  return <article className={`panel site-card ${open ? 'is-open' : ''}`}>
    {onToggleFav ? <FavStar site={site} favorited={favorited} onToggle={onToggleFav} className="card-corner" /> : null}
    <div className="site-head" onClick={load}>
      <div className="site-monogram" aria-hidden="true">{site.name.slice(0, 1).toUpperCase()}</div>
      <div className="site-title">
        <div className="site-name-line"><Link href={`/sites/${encodeURIComponent(site.name)}`}><h2>{site.display || site.name}</h2></Link><code>{site.name}</code></div>
        <div className="adapter-byline"><OriginBadge value={site.origin} /><AdapterAuthor site={site} /></div>
        <p>{site.description || 'Adapter 命令集合'}</p>
      </div>
      <div className="site-metrics">
        <Metric value={site.commandCount} label="命令" />
        <Metric value={site.downloads} label="下载" />
      </div>
      <InstallAction target={site.name} scenarios={site.scenarios} installable={site.installable} downloadHref={`/api/v1/adapters/${encodeURIComponent(site.name)}/download`} title={`安装 ${site.display || site.name}`} />
    </div>
    <div className="site-foot">
      <button className="text-button site-toggle" type="button" onClick={(event) => { event.stopPropagation(); load() }} aria-expanded={open}>{open ? '收起命令' : `展开 ${site.commandCount} 个命令`}</button>
      <Link href={`/sites/${encodeURIComponent(site.name)}`}>查看详情</Link>
    </div>
    {open ? <div className="command-list" onClick={(event) => event.stopPropagation()}>
      {commands.map((command, index) => <CommandRow key={command.id} command={command} rank={index + 1} scenarios={site.scenarios} />)}
      {!commands.length && !cmdError ? <div className="inline-state skeleton-lines"><span /><span /><span /></div> : null}
      {cmdError ? <div className="inline-state error">命令加载失败：{cmdError}</div> : null}
    </div> : null}
  </article>
}

// 收藏星标：悬停时右上角可点，已收藏常驻点亮
function FavStar({ site, favorited, onToggle, className = '' }) {
  const [busy, setBusy] = useState(false)
  const toggle = async (event) => {
    event.preventDefault(); event.stopPropagation()
    if (busy) return
    setBusy(true)
    try { await onToggle(site) } finally { setBusy(false) }
  }
  return <button type="button" className={`fav-star ${favorited ? 'is-faved' : ''} ${className}`} aria-pressed={favorited} aria-label={favorited ? `取消收藏 ${site.name}` : `收藏 ${site.name}`} title={favorited ? '取消收藏' : '收藏'} onClick={toggle}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill={favorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.56l-5.9 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"/></svg>
  </button>
}

// 网格卡片（4×3 翻页视图）：名称+域名开头（域名即安装命令参数），点击进详情看命令
function AdapterGridCard({ site, favorited, onToggleFav }) {
  return <article className="grid-card panel">
    {onToggleFav ? <FavStar site={site} favorited={favorited} onToggle={onToggleFav} className="card-corner" /> : null}
    <Link href={`/sites/${encodeURIComponent(site.name)}`} className="grid-card-body">
      <div className="grid-card-name">{site.display || site.name}</div>
      <code className="grid-card-domain">{site.name}</code>
      <div className="adapter-byline"><OriginBadge value={site.origin} /><AdapterAuthor site={site} compact /></div>
      <p className="grid-card-desc">{site.description || 'Adapter 命令集合'}</p>
    </Link>
    <div className="grid-card-foot">
      <div className="grid-card-meta"><span>{number(site.commandCount)} 命令</span><span>{number(site.downloads)} 下载</span></div>
      <InstallAction target={site.name} scenarios={site.scenarios} installable={site.installable} downloadHref={`/api/v1/adapters/${encodeURIComponent(site.name)}/download`} title={`安装 ${site.display || site.name}`} />
    </div>
  </article>
}

function Pagination({ page, totalPages, onPrev, onNext }) {
  if (totalPages <= 1) return null
  return <div className="pagination">
    <button className="button secondary" type="button" onClick={onPrev} disabled={page <= 1}>上一页</button>
    <span className="page-indicator">第 {page} / {totalPages} 页</span>
    <button className="button secondary" type="button" onClick={onNext} disabled={page >= totalPages}>下一页</button>
  </div>
}

function Catalog() {
  const routeQuery = new URLSearchParams(location.search).get('q') || ''
  const [sort, setSort] = useState('favorites')
  const [source, setSource] = useState('all')
  const [category, setCategory] = useState('全部')
  const [origin, setOrigin] = useState('all')
  const [related, setRelated] = useState('all')
  const [view, setView] = useState('card')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [me, setMe] = useState(undefined)
  const [favs, setFavs] = useState(null)
  const [managed, setManaged] = useState(null)
  useEffect(() => { api('/api/v1/me').then(setMe).catch(() => setMe(null)) }, [])
  const loadRelated = () => {
    api('/api/v1/me/adapters').then((d) => { setFavs(new Set(d.favorites || [])); setManaged(new Set(d.managed || [])) }).catch(() => { setFavs(new Set()); setManaged(new Set()) })
  }
  useEffect(() => { if (me?.logged_in) loadRelated() }, [me?.logged_in])
  const toggleFav = async (site) => {
    if (!me?.logged_in) return
    const was = favs?.has(site.name)
    // 乐观更新
    setFavs((prev) => { const next = new Set(prev || []); was ? next.delete(site.name) : next.add(site.name); return next })
    try {
      await api(`/api/v1/me/favorites/${encodeURIComponent(site.name)}`, { method: was ? 'DELETE' : 'PUT' })
    } catch (err) {
      setFavs((prev) => { const next = new Set(prev || []); was ? next.add(site.name) : next.delete(site.name); return next }) // 回滚
      setError(`收藏操作失败：${err.message}`)
    }
  }
  useEffect(() => { setData(null); setError(''); api(`/api/v1/adapters?page_size=100&sort=${sort === 'name' ? 'name' : sort === 'downloads' ? 'downloads' : sort === 'recent' ? 'recent' : 'favorites'}`).then(setData).catch((e) => setError(e.message)) }, [sort])
  useEffect(() => { setPage(1) }, [source, category, origin, related, routeQuery, sort, view])
  const sites = data?.items || []
  const query = routeQuery.trim().toLowerCase()
  const filteredSites = useMemo(() => sites.filter((site) => {
    const matchesQuery = !query || `${site.name} ${site.display || ''} ${site.description}`.toLowerCase().includes(query)
    const matchesSource = source === 'all' || siteSource(site) === source
    const matchesCategory = category === '全部' || siteCategory(site) === category
    const matchesOrigin = origin === 'all' || (site.origin || 'official') === origin
    const matchesRelated = related === 'all'
      || (related === 'favorites' && favs?.has(site.name))
      || (related === 'managed' && managed?.has(site.name))
    return matchesQuery && matchesSource && matchesCategory && matchesOrigin && matchesRelated
  }), [sites, query, source, category, origin, related, favs, managed])
  const totalCommands = sites.reduce((sum, site) => sum + site.commandCount, 0)
  const filteredCommands = filteredSites.reduce((sum, site) => sum + site.commandCount, 0)
  const filtering = source !== 'all' || category !== '全部' || origin !== 'all' || related !== 'all' || routeQuery
  const sourceCount = (value) => value === 'all' ? sites.length : sites.filter((site) => siteSource(site) === value).length
  const categoryCount = (value) => value === '全部' ? sites.length : sites.filter((site) => siteCategory(site) === value).length
  const originCount = (value) => value === 'all' ? sites.length : sites.filter((site) => (site.origin || 'official') === value).length
  const relatedCount = (value) => value === 'all' ? sites.length : sites.filter((site) => value === 'favorites' ? favs?.has(site.name) : managed?.has(site.name)).length
  const visibleCategories = CATEGORIES.filter((value) => value === '全部' || categoryCount(value) > 0)
  const clearFilters = () => { setSource('all'); setCategory('全部'); setOrigin('all'); setRelated('all'); if (routeQuery) go('/sites') }
  const pageSize = 12
  const totalPages = Math.max(1, Math.ceil(filteredSites.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const cardItems = filteredSites.slice((safePage - 1) * pageSize, safePage * pageSize)
  const relatedEmpty = related === 'favorites' && !(favs?.size)
  const managedEmpty = related === 'managed' && !(managed?.size)
  return <div className="page">
    <div className="page-head">
      <div><h1>Adapter 目录</h1><p>可独立安装的 Adapter（站点整包），安装即获得该站点的全部命令。</p></div>
      <div className="catalog-toolbar">
        <div className="view-toggle" role="tablist" aria-label="展示方式">
          <button type="button" role="tab" aria-selected={view === 'card'} className={view === 'card' ? 'active' : ''} onClick={() => setView('card')}>卡片</button>
          <button type="button" role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>列表</button>
        </div>
        <label className="field">排序
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="favorites">收藏量</option><option value="downloads">下载量</option><option value="recent">最新</option><option value="name">名称</option>
          </select>
        </label>
        {me?.logged_in ? <div className="related-toggle" role="group" aria-label="与我相关">
          {[['all', '全部'], ['favorites', '我收藏的'], ['managed', '我管理的']].map(([value, label]) =>
            <button key={value} type="button" className={related === value ? 'active' : ''} aria-pressed={related === value} onClick={() => setRelated(value)}>{label}</button>)}
        </div> : null}
      </div>
    </div>
    {data ? <section className="catalog-summary panel" aria-label="AdapterHub 目录统计与筛选">
      <div className="summary-metrics">
        <div><strong>{number(filteredSites.length)}</strong><span>Adapter</span></div>
        <div><strong>{number(filteredCommands)}</strong><span>命令</span></div>
        {filtering ? <p>筛选自 {sites.length} 个 Adapter、{totalCommands} 个命令</p> : <p>覆盖外部站点与内网系统</p>}
      </div>
      <div className="catalog-controls">
        <FilterMenu label="站点环境" value={source} options={SOURCES.map(([value, label]) => ({ value, label, count: sourceCount(value) }))} onChange={setSource} />
        <FilterMenu label="类别" value={category} options={visibleCategories.map((value) => ({ value, label: value, count: categoryCount(value) }))} onChange={setCategory} />
        <FilterMenu label="Adapter 来源" value={origin} options={[{ value: 'all', label: '全部', count: originCount('all') }, { value: 'official', label: '官方内置', count: originCount('official') }, { value: 'user', label: '用户上传', count: originCount('user') }]} onChange={setOrigin} />
        {filtering ? <button className="reset-filter" type="button" onClick={clearFilters}>重置筛选</button> : null}
      </div>
    </section> : null}
    {routeQuery ? <div className="query-note">“{routeQuery}” 的 Adapter 结果 <Link href="/sites">清除</Link></div> : null}
    <State loading={!data && !error} error={error} empty={false}>
      {filteredSites.length ? (
        view === 'card' ? <>
          <div className="adapter-grid">{cardItems.map((site) => <AdapterGridCard site={site} key={site.name} favorited={Boolean(favs?.has(site.name))} onToggleFav={me?.logged_in ? toggleFav : undefined} />)}</div>
          <Pagination page={safePage} totalPages={totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => Math.min(totalPages, p + 1))} />
        </> : <div className="catalog">{filteredSites.map((site) => <AdapterCard site={site} key={site.name} favorited={Boolean(favs?.has(site.name))} onToggleFav={me?.logged_in ? toggleFav : undefined} />)}</div>
      ) : relatedEmpty || managedEmpty ? <div className="panel state empty-state">
        {related === 'favorites'
          ? <><span>还没有收藏的 Adapter，去目录点卡片右上角的星标吧。</span><button className="button secondary" type="button" onClick={clearFilters}>浏览全部 Adapter</button></>
          : <><span>还没有你管理的 Adapter。上传第一个 Adapter 即自动成为归属人。</span><button className="button secondary" type="button" onClick={clearFilters}>浏览全部 Adapter</button></>}
      </div> : <div className="panel state empty-state"><span>没有找到匹配「{routeQuery}」的 Adapter（搜索范围：名称与域名）。换个关键词或清除筛选试试。</span><button className="button secondary" type="button" onClick={clearFilters}>清除全部筛选</button></div>}
    </State>
  </div>
}

// 推荐提示词：安装后可直接对 AI 助手说的话（${xxx} 为占位符）
function ScenarioSection({ scenarios }) {
  return <section className="scenario-section">
    <div className="section-head"><h2>推荐提示词</h2><span>{scenarios.length} 个场景</span></div>
    <div className="scenario-list">{scenarios.map((s, i) => <ScenarioCard key={i} scenario={s} />)}</div>
  </section>
}

function ScenarioCard({ scenario }) {
  const [status, setStatus] = useState('idle')
  const copyText = async (text) => { try { await copy(text); setStatus('copied'); setTimeout(() => setStatus('idle'), 1600) } catch { setStatus('error') } }
  return <div className="panel scenario-card">
    <div className="scenario-head"><strong>{scenario.title || '未命名场景'}</strong>{scenario.summary ? <p>{scenario.summary}</p> : null}</div>
    {scenario.prompts?.map((p, j) => <div key={j} className="scenario-prompt">
      <pre><code>{p.text}</code></pre>
      <button className="button secondary" type="button" onClick={() => copyText(p.text)}>{status === 'copied' ? '✓ 已复制' : '复制'}</button>
    </div>)}
  </div>
}

function AdapterDetail({ id }) {
  const [site, setSite] = useState(null), [commands, setCommands] = useState(null), [error, setError] = useState('')
  useEffect(() => { Promise.all([api(`/api/v1/adapters/${encodeURIComponent(id)}`), api(`/api/v1/adapters/${encodeURIComponent(id)}/commands?page_size=100`)]).then(([a, b]) => { setSite(a); setCommands(b.items) }).catch((e) => setError(e.message)) }, [id])
  return <div className="page"><State loading={!site && !error} error={error}>{site ? <>
    <Link href="/sites" className="back">返回 Adapter 目录</Link>
    <section className="detail-head panel"><div><h1>{site.display || site.name}</h1><code>{site.name}</code><div className="adapter-byline detail-byline"><OriginBadge value={site.origin} /><AdapterAuthor site={site} /></div><p>{site.description}</p></div><div className="site-metrics"><Metric value={site.commandCount} label="命令"/><Metric value={site.downloads} label="下载"/><Metric value={site.favoriteCount} label="收藏"/></div><InstallAction variant="always" target={site.name} scenarios={site.scenarios} installable={site.installable} downloadHref={`/api/v1/adapters/${encodeURIComponent(site.name)}/download`} title={`安装 ${site.display || site.name}`} /></section>
    {site.scenarios?.length ? <ScenarioSection scenarios={site.scenarios} /> : null}
    <section><div className="section-head"><h2>包含命令</h2><span>{commands?.length || 0} 个（点击行查看参数说明）</span></div><div className="panel command-list standalone">{commands?.map((command, i) => <CommandRow key={command.id} command={command} rank={i + 1} scenarios={site.scenarios} />)}</div></section>
  </> : null}</State></div>
}

function Docs() {
  const rows = [['list','列出 Adapter'],['find <关键词>','按名称、域名、用途检索'],['info <目标>','查看 Adapter 详情'],['download <目标>','下载 .adapt 包'],['validate <文件>','离线校验包结构与哈希'],['install <目标>','安装整个 Adapter'],['update [<目标>|--all]','检查并更新已安装 Adapter'],['remove <目标>','卸载 Adapter'],['publish <目录或.adapt>','发布/更新 Adapter（需访问令牌）']]
  return <div className="page docs"><div className="page-head"><div><h1>webcli adapterhub 命令介绍</h1><p>Adapter 是唯一可安装单位（站点整包），安装即获得该站点的全部命令。不支持命令级单独下载。</p></div></div><section className="panel content-panel"><h2>连接地址</h2><p>默认已内置官方地址，无需任何配置。</p></section><section className="panel content-panel"><h2>命令</h2><table><thead><tr><th>命令</th><th>用途</th></tr></thead><tbody>{rows.map(([name, purpose]) => <tr key={name}><td><code>webcli adapterhub {name}</code></td><td>{purpose}</td></tr>)}</tbody></table></section><section className="panel content-panel"><h2>安装示例</h2><pre><code>{`# 安装整个 Adapter（站点整包，含全部命令）
webcli adapterhub install example.com

# 检查并更新已安装的 Adapter
webcli adapterhub update --all

# 查看本地已安装
webcli adapterhub installed`}</code></pre></section><section className="panel content-panel"><h2>发布你自己的 Adapter</h2><p>准备一个 v2 格式的 Adapter 目录（<code>manifest.json</code> + <code>extension/commands/</code>），然后：</p><pre><code>{`webcli adapterhub publish ./my-adapter/ --yes`}</code></pre><p className="muted">首个发布者自动成为归属人；之后仅归属人或管理员可发布新版本。同版本号内容不同会被拒绝，请递增版本号。</p></section></div>
}

function MePage() {
  const [me, setMe] = useState(undefined)
  const [error, setError] = useState('')
  useEffect(() => { api('/api/v1/me').then(setMe).catch((e) => { setMe(null); setError(e.message) }) }, [])
  return <div className="page">
    <State loading={me === undefined} error={!me && error}>{me ? <>
      <section className="panel content-panel"><h2>登录状态</h2>
        {me.logged_in
          ? <><dl><dt>用户</dt><dd><code>{me.userid}</code></dd><dt>登录方式</dt><dd>{me.auth}</dd></dl>{me.logout_url ? <button className="button secondary" type="button" onClick={() => { location.href = me.logout_url }}>退出登录</button> : null}</>
          : <><p className="muted">当前为匿名浏览。</p>{me.login_url ? <button className="button primary" type="button" onClick={() => { location.href = me.login_url }}>登录</button> : null}</>}
      </section>
    </> : null}</State>
  </div>
}

function App() {
  const route = useRoute()
  const path = route.split('?')[0]
  let page = <Catalog />
  const site = path.match(/^\/sites\/([^/]+)$/)
  if (path === '/docs') page = <Docs />
  else if (path === '/me') page = <MePage />
  else if (site) page = <AdapterDetail id={decodeURIComponent(site[1])} />
  return <Shell>{page}</Shell>
}

function UploadDialog({ me, onClose }) {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dialog = useRef(null)
  const fileInput = useRef(null)
  const previousFocus = useRef(document.activeElement)

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    const trapFocus = (e) => {
      if (e.key !== 'Tab' || !dialog.current) return
      const controls = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]
      const first = controls[0], last = controls.at(-1)
      if (!first || !last) return
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    addEventListener('keydown', esc); addEventListener('keydown', trapFocus)
    requestAnimationFrame(() => dialog.current?.querySelector('button.dialog-close')?.focus())
    return () => {
      removeEventListener('keydown', esc); removeEventListener('keydown', trapFocus)
      previousFocus.current?.focus?.()
    }
  }, [onClose, busy])

  const inspectFile = async (selected) => {
    if (!selected) return
    setError(''); setResult(null); setPreview(null); setConfirming(false); setFile(selected)
    if (!/\.adapt$/i.test(selected.name)) {
      setError('请选择 .adapt 包文件。')
      setFile(null); return
    }
    try {
      const buf = await selected.arrayBuffer()
      const { strFromU8, unzipSync } = await import('fflate')
      const files = unzipSync(new Uint8Array(buf))
      const manifestFile = files['manifest.json']
      if (!manifestFile) throw new Error('包内缺少 manifest.json')
      const manifest = JSON.parse(strFromU8(manifestFile))
      if (manifest.schema_version !== 2) throw new Error('需要 v2 包（schema_version=2）')
      setPreview({
        name: manifest.name, version: manifest.version, display: manifest.display || manifest.name,
        description: manifest.description, commandCount: (manifest.commands || []).length,
        commands: (manifest.commands || []).map((c) => c.id).filter(Boolean), size: selected.size,
      })
    } catch (err) {
      setError(`包预览失败：${err.message}`); setFile(null)
    }
  }
  const selectFile = (event) => inspectFile(event.target.files?.[0])
  const upload = async (e) => {
    e?.preventDefault?.(); setError(''); setResult(null); setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const resp = await api('/api/v1/adapters', {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(buf),
      })
      setResult(resp); setConfirming(false)
    } catch (err) { setError(err.message); setConfirming(false) }
    finally { setBusy(false) }
  }
  const reset = () => { setFile(null); setPreview(null); setError(''); setResult(null); setConfirming(false); if (fileInput.current) fileInput.current.value = '' }

  return createPortal(
    <div className="modal-backdrop upload-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="upload-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="upload-dlg-title" aria-describedby="upload-dlg-description" onClick={(event) => event.stopPropagation()}>
        <header className="upload-head">
          <div className="upload-title-row">
            <span className="upload-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
            <div><h2 id="upload-dlg-title">发布 Adapter</h2><p id="upload-dlg-description">上传 v2 .adapt 包，校验后发布到 AdapterHub</p></div>
          </div>
          <button className="dialog-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭上传弹窗">关闭</button>
        </header>
        <div className="upload-body">
          {result ? (
            <div className="upload-result">
              <div className="upload-success" role="status">
                <span className="success-mark" aria-hidden="true">✓</span>
                <div><strong>{result.duplicate ? '内容未变，已确认发布' : 'Adapter 发布成功'}</strong><p>{result.name} <code>v{result.version}</code>{result.size ? ` · ${bytes(result.size)}` : ''}</p></div>
              </div>
              <div className="install-next"><span>安装命令</span><div><code>webcli adapterhub install {result.name}</code><CopyButton text={`webcli adapterhub install ${result.name}`} className="button secondary" children="复制" /></div></div>
              <div className="dialog-actions"><button className="button secondary" type="button" onClick={reset}>再发布一个</button><button className="button primary" type="button" onClick={onClose}>完成</button></div>
            </div>
          ) : (
            <>
              <div className={`file-picker ${dragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); inspectFile(e.dataTransfer.files?.[0]) }}>
                <input ref={fileInput} id="adapter-package-file" className="upload-file-input" type="file" accept=".adapt" onChange={selectFile} disabled={busy} />
                <label htmlFor="adapter-package-file" className="file-picker-content">
                  <span className="file-upload-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M8 4h11l5 5v19H8V4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M18 4v6h6M16 22V14m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
                  <strong>{file ? file.name : '选择 .adapt 包'}</strong><span>{file ? `${bytes(file.size)} · 点击可重新选择` : '拖放文件到这里，或点击浏览本地文件'}</span>
                </label>
              </div>
              <div className="upload-guidance"><span className="guidance-dot" aria-hidden="true">1</span><span>上传前会在浏览器中读取 manifest，先确认包名、版本和命令数量。</span><span className="guidance-dot" aria-hidden="true">2</span><span>发布后由服务端完成权限与版本冲突校验。</span></div>
              {preview ? <div className="package-preview"><div className="preview-heading"><div><span className="preview-kicker">已读取包信息</span><strong>{preview.display}</strong></div><code>v{preview.version}</code></div><dl><dt>Adapter 标识</dt><dd><code>{preview.name}</code></dd><dt>包含命令</dt><dd>{preview.commandCount} 个{preview.commands.length ? <span className="command-inline"> · {preview.commands.slice(0, 4).join(', ')}{preview.commands.length > 4 ? ` 等 ${preview.commands.length} 个` : ''}</span> : null}</dd><dt>包大小</dt><dd>{bytes(preview.size)}</dd></dl><p className="upload-hint">如果覆盖已有 Adapter，你需要是归属人或管理员。同一版本内容不同会被拒绝，请递增版本号。</p></div> : null}
              {error ? <p className="form-error" role="alert">{error}</p> : null}
              {preview ? <div className={`dialog-actions ${confirming ? 'is-confirming' : ''}`}>
                {confirming ? <span className="confirm-copy">确认发布 <code>{preview.name}</code> <code>v{preview.version}</code>？</span> : <button className="button secondary" type="button" onClick={reset} disabled={busy}>重新选择</button>}
                {confirming ? <button className="button secondary" type="button" onClick={() => setConfirming(false)} disabled={busy}>返回</button> : null}
                <button className="button primary" type="button" onClick={() => confirming ? upload() : setConfirming(true)} disabled={busy}>{busy ? <><span className="button-spinner" aria-hidden="true" />发布中…</> : confirming ? '确认发布' : '继续发布'}</button>
              </div> : null}
            </>
          )}
        </div>
      </section>
    </div>, document.body)
}

function TokenManager({ me, onClose }) {
  const [tokens, setTokens] = useState(null)
  const [name, setName] = useState('')
  const [days, setDays] = useState(90)
  const [created, setCreated] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(null)
  const load = () => api('/api/v1/me/tokens').then((data) => setTokens(data.items)).catch((err) => { setTokens([]); setError(`令牌加载失败：${err.message}`) })
  useEffect(() => {
    load()
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', esc); return () => removeEventListener('keydown', esc)
  }, [onClose])
  const create = async (e) => {
    e.preventDefault(); setError(''); setCreated(null); setBusy(true)
    try {
      const r = await api('/api/v1/me/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() || '默认令牌', expires_in_days: Number(days) || 90 }) })
      setCreated(r); setName(''); setCopied(false); load()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  const revoke = async (id) => {
    setError(''); setConfirming(null)
    try { await api(`/api/v1/me/tokens/${id}`, { method: 'DELETE' }); load() } catch (err) { setError(err.message) }
  }
  // '/' 聚焦搜索（兑现 kbd 提示）
  useEffect(() => {
    const onKey = (e) => { if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); document.getElementById('global-search')?.focus() } }
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey)
  }, [])
  const copyToken = async () => { if (created?.token) { try { await copy(created.token); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch {} } }
  return createPortal(<div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="token-dialog" role="dialog" aria-modal="true" aria-labelledby="token-dlg-title" onClick={(event) => event.stopPropagation()}>
      <header className="dialog-head">
        <div><h2 id="token-dlg-title">访问令牌</h2><p>用于 webcli 上传/下载 Adapter 的身份认证</p></div>
        <div className="dialog-head-actions">
          <details className="info-tip">
            <summary aria-label="什么是访问令牌？">?</summary>
            <div className="info-popover" role="tooltip">
              <strong>个人访问令牌（PAT）</strong>
              <p>用于 webcli 等工具和 API 的身份认证，替代账号密码。</p>
              <ul>
                <li><strong>CLI 认证</strong> — 配到本地 webcli 环境变量（如 <code>ADAPTERHUB_TOKEN</code>），用于 <code>webcli adapterhub</code> 命令。</li>
                <li><strong>上传/下载 Adapter</strong> — webcli 据此身份操作 Adapter 包。</li>
              </ul>
              <p className="info-warn">创建后仅展示一次；泄露请立即撤销；建议为不同用途创建独立令牌。</p>
            </div>
          </details>
          <button className="dialog-close" type="button" onClick={onClose}>关闭</button>
        </div>
      </header>
      <form className="token-create" onSubmit={create}>
        <label className="token-name-field"><span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：本机开发" maxLength={100} />
        </label>
        <label className="token-expiry-field"><span>有效期</span>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option>
          </select>
        </label>
        <button className="button primary" type="submit" disabled={busy}>{busy ? '创建中…' : '创建令牌'}</button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      {created ? (
        <div className="token-reveal">
          <div className="token-reveal-head">
            <strong>令牌已生成</strong>
            <span className="token-reveal-warn">仅此一次，关闭后无法再查看</span>
          </div>
          <div className="token-reveal-body">
            <code className="token-value">{created.token}</code>
            <button className="button secondary" type="button" onClick={copyToken}>{copied ? '✓ 已复制' : '复制'}</button>
          </div>
        </div>
      ) : null}
      <div className="token-list-wrap">
        {tokens?.length ? (
          <table className="token-list"><thead><tr><th>名称</th><th>创建</th><th>过期</th><th>最近使用</th><th></th></tr></thead><tbody>
            {tokens.map((t) => <tr key={t.id} className={t.revoked ? 'revoked' : ''}>
              <td>{t.name || '未命名令牌'}{t.revoked ? <span className="badge system">已撤销</span> : null}</td>
              <td>{fmt(t.created_at)}</td><td>{fmt(t.expires_at)}</td><td>{fmt(t.last_used_at)}</td>
              <td>{t.revoked ? null : confirming === t.id ? <span className="revoke-confirm">
                <span className="revoke-hint">立即失效，确认？</span>
                <button className="text-button danger" type="button" onClick={() => revoke(t.id)}>确认</button>
                <button className="text-button" type="button" onClick={() => setConfirming(null)}>取消</button>
              </span> : <button className="text-button danger" type="button" onClick={() => setConfirming(t.id)}>撤销</button>}</td>
            </tr>)}
          </tbody></table>
        ) : <p className="muted token-empty">还没有令牌，创建一个开始使用。</p>}
      </div>
    </section>
  </div>, document.body)
}

createRoot(document.getElementById('root')).render(<App />)
