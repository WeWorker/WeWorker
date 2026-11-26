import React, { useEffect, useRef, useState } from 'react'
import { applyAdapterUpdate, checkAdapterUpdates, fetchAdapterUpdateProgress, fetchAdapterUpdates, installedAdapterVersion } from '../../api/adapter-updates-api.js'
import { showNotification, updateNotification, useNotificationsStore } from '../../store/notifications.js'
import { useSitesStore } from '../../store/sites.js'
import AppSwitch from '../common/AppSwitch.jsx'
import SiteIcon from '../icons/SiteIcon.jsx'
import AdapterDetailView from './AdapterDetailView.jsx'
import AdapterTransferButton from './AdapterTransferButton.jsx'
import './adapter-management.css'
import './adapter-hub.css'

const statusLabels = {
  available: '有可用更新',
  current: '已是最新版本',
  'local-newer': '本地版本较新',
  unlisted: '更新目录未收录',
  unsupported: '不支持在线更新',
}

export default function AdapterManagement() {
  const sites = useSitesStore(state => state.sites)
  const sitesStatus = useSitesStore(state => state.sitesStatus)
  const loadSites = useSitesStore(state => state.loadSites)
  const refreshSites = useSitesStore(state => state.refreshSites)
  const toggle = useSitesStore(state => state.toggle)
  const togglingIds = useSitesStore(state => state.togglingIds)
  const toggleError = useSitesStore(state => state.toggleError)
  const [snapshot, setSnapshot] = useState(null)
  const [operation, setOperation] = useState(null)
  const [transfer, setTransfer] = useState(null)
  const [selectedSite, setSelectedSite] = useState(null)
  const [query, setQuery] = useState('')
  const runningOperation = useRef(false)
  const reportedToggleError = useRef(null)

  useEffect(() => {
    if (operation || (snapshot && snapshot.status !== 'checking')) return undefined
    const controller = new AbortController()
    const readStatus = async () => {
      try {
        const next = await fetchAdapterUpdates(controller.signal)
        if (!controller.signal.aborted) setSnapshot(next)
      } catch {
        if (!controller.signal.aborted) setSnapshot({ status: 'error', items: {} })
      }
    }
    const timer = snapshot ? setTimeout(readStatus, 1200) : undefined
    if (!snapshot) void readStatus()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [snapshot, operation])

  const updatingId = operation?.action === 'apply' ? operation.id : null
  useEffect(() => {
    if (!updatingId) return
    const controller = new AbortController()
    let timer = setTimeout(poll, 350)
    async function poll() {
      try {
        const next = await fetchAdapterUpdateProgress(controller.signal)
        if (!controller.signal.aborted && next?.name === updatingId) {
          setTransfer(previous => previous?.status === 'complete' ? previous : next)
        }
      } catch {
        // The update request reports the result even if progress polling fails.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 350)
      }
    }
    return () => { controller.abort(); clearTimeout(timer) }
  }, [updatingId])

  const run = async (action, id, version) => {
    if (runningOperation.current || !snapshot || snapshot.status === 'checking') return
    runningOperation.current = true
    setOperation({ action, id })
    const name = sites.find(site => site.id === id)?.name || id
    const notice = showNotification(
      action === 'check' ? '正在检测 Adapter 版本…' : `正在更新 ${name}…`,
      { type: 'loading', duration: 0 },
    )
    try {
      if (action === 'check') {
        const next = await checkAdapterUpdates()
        setSnapshot(next)
        if (next.status === 'error') throw new Error('检测失败，请稍后重试。')
        updateNotification(notice, '已检测最新版本', { type: 'success' })
      } else {
        setSnapshot(await applyAdapterUpdate(id, version))
        setTransfer({ name: id, status: 'complete' })
        await refreshSites()
        updateNotification(notice, `已将 ${name} 更新至 ${version}`, { type: 'success' })
      }
    } catch (cause) {
      updateNotification(notice, cause.message || '操作失败，请稍后重试。', { type: 'error', duration: 8000 })
    } finally {
      runningOperation.current = false
      setOperation(null)
      setTransfer(null)
    }
  }

  useEffect(() => {
    if (!toggleError || toggleError === reportedToggleError.current) return
    reportedToggleError.current = toggleError
    showNotification(toggleError.message || '操作 Adapter 失败，请稍后重试。', { type: 'error', duration: 8000 })
  }, [toggleError])

  const items = snapshot?.items || {}
  const siteById = new Map(sites.map(site => [site.id, site]))
  const ids = new Set([...siteById.keys(), ...Object.keys(items)])
  const keyword = query.trim().toLowerCase()
  const visibleIds = [...ids].filter(id => {
    const site = siteById.get(id)
    return !keyword || [id, site?.name, site?.description].some(value =>
      typeof value === 'string' && value.toLowerCase().includes(keyword),
    )
  })
  const checking = operation?.action === 'check' || snapshot?.status === 'checking'
  const unavailable = !snapshot || checking || Boolean(operation)
  const scanning = ids.size === 0 && (sitesStatus === 'idle' || sitesStatus === 'loading')

  useEffect(() => {
    if (!scanning) return undefined
    const notice = showNotification('正在扫描已安装的 Adapter…', { type: 'loading', duration: 0 })
    return () => useNotificationsStore.getState().dismiss(notice)
  }, [scanning])

  if (selectedSite) return <AdapterDetailView mode="local" site={selectedSite} onClose={() => setSelectedSite(null)} />

  return (
    <section className="tool-package-list-page adapter-management" aria-label="已安装 Adapter">
      <div className="adapter-hub__toolbar">
        <input
          type="search"
          className="adapter-hub__search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索 Adapter"
          aria-label="搜索已安装的 Adapter"
        />
      </div>
      {visibleIds.length > 0 ? (
        <div className="tool-package-card-grid" role="list" aria-label="已安装的 Adapter">
          {visibleIds.map(id => {
            const site = siteById.get(id)
            const name = site?.name || id
            const item = Object.hasOwn(items, id) ? items[id] : null
            const available = snapshot?.status === 'ready' && item?.status === 'available' && item.latestVersion
            return (
              <article key={id} role="listitem" className="tool-package-entry tool-package-entry--adapter" onClick={() => setSelectedSite(site || { id, name, version: item?.currentVersion })} onKeyDown={event => {
                   if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
                   event.preventDefault()
                   setSelectedSite(site || { id, name, version: item?.currentVersion })
                 }} tabIndex={0}>
                <span className="tool-package-entry__icon" aria-hidden="true"><SiteIcon site={site || { id, name }} size={34} /></span>
                <div className="tool-package-entry__body">
                  <h2 className="tool-package-entry__title" title={name}>{name}</h2>
                  <span className="tool-package-entry__description">{site?.description || id}</span>
                </div>
                {updatingId === id ? (
                  <AdapterTransferButton job={transfer ?? { status: 'downloading' }} entry={{ name }} activeLabel="更新中…" minimumWaitingProgress={50} />
                ) : <button
                  type="button"
                  className={`tool-package-card-action${available ? ' is-update' : ''}`}
                  disabled={unavailable || (available && togglingIds.includes(id))}
                  aria-label={available ? `更新 ${name} 至 ${item.latestVersion}` : `检测 ${name} 最新版本`}
                  onClick={event => { event.stopPropagation(); available ? run('apply', id, item.latestVersion) : run('check', id) }}
                >
                  {operation?.id === id ? '检测中…' : available ? '更新' : '检测'}
                </button>}
                <div className="tool-package-entry__footer">
                  <div className="adapter-management__versions">
                    <span>当前 {item?.currentVersion || installedAdapterVersion(site)}</span>
                    <span>最新 {item?.latestVersion || '—'}</span>
                    {item?.status && <span className={available ? 'adapter-management__available' : undefined}>{item.unavailableReason || statusLabels[item.status]}</span>}
                  </div>
                  {site && <label className="adapter-management__switch" onClick={event => event.stopPropagation()}>
                    <span>{site.enabled === false ? '已停用' : '已启用'}</span>
                    <AppSwitch
                      aria-label={`启用 ${name}`}
                      checked={site.enabled !== false}
                      disabled={togglingIds.includes(id) || (operation?.action === 'apply' && operation.id === id)
                        || (site.managed && !site.enabled && !site.managed.canEnable)}
                      onChange={event => { event.stopPropagation(); toggle(id) }}
                    />
                  </label>}
                </div>
              </article>
            )
          })}
        </div>
      ) : ids.size > 0 ? (
        <p className="adapter-hub__empty" role="status">没有匹配的 Adapter。</p>
      ) : sitesStatus === 'error' ? (
        <div className="adapter-hub__empty" role="status">
          <span>无法读取已安装的 Adapter。</span>
          <button type="button" className="adapter-hub__retry" onClick={loadSites}>重试</button>
        </div>
      ) : sitesStatus === 'ready' ? (
        <p className="adapter-hub__empty" role="status">暂无已安装的 Adapter。</p>
      ) : null}
    </section>
  )
}
