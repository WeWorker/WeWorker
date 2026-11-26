import React, { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAdapterHub, fetchAdapterHubInstallProgress, installAdapterFromHub } from '../../api/adapter-hub-api.js'
import { showNotification, useNotificationsStore } from '../../store/notifications.js'
import { useSitesStore } from '../../store/sites.js'
import SiteIcon from '../icons/SiteIcon.jsx'
import AdapterDetailView from './AdapterDetailView.jsx'
import './adapter-hub.css'

function formatBytes(bytes, speed = false) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)}MB`
  if (speed || bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

function TransferButton({ job, entry }) {
  const [waitingProgress, setWaitingProgress] = useState(4)
  const queued = job.status === 'queued'
  const phaseLabels = { verifying: '校验中…', extracting: '解包中…', writing: '写入中…', complete: '已完成' }
  const phaseLabel = phaseLabels[job.status]
  const received = job.receivedBytes ?? 0
  const total = job.totalBytes ?? entry.totalBytes
  const percent = received > 0 && total >= received ? Math.floor(received / total * 100) : null
  const waiting = !queued && !phaseLabel && percent === null && waitingProgress < 50

  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setWaitingProgress(value => Math.min(50, value + 2)), 250)
    return () => clearInterval(timer)
  }, [waiting])

  const width = queued ? 0 : phaseLabel ? 100 : Math.max(waitingProgress, percent ?? 0)
  const label = phaseLabel || (queued ? '排队中' : job.status === 'preparing' ? '准备中…' : '下载中…')
  const stats = job.status !== 'downloading' || percent === null ? '' : `${percent}% (${formatBytes(received)}/${formatBytes(total)}) · ${formatBytes(job.bytesPerSecond ?? 0, true)}/s`
  const status = queued && job.queuePosition ? `排队第 ${job.queuePosition} 位` : stats || label
  return (
    <button type="button" disabled className="tool-package-card-action adapter-hub__transfer"
      aria-label={`${label} ${entry.name}`} title={status} style={{ '--transfer-progress': `${width}%` }}>
      <span className="adapter-hub__transfer-fill" aria-hidden="true" />
      <span className="adapter-hub__transfer-label">{label}</span>
    </button>
  )
}

export default function AdapterHub() {
  const addInstalledSite = useSitesStore(state => state.addInstalledSite)
  const [entries, setEntries] = useState(null)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [query, setQuery] = useState('')
  const [localJobs, setLocalJobs] = useState(() => new Map())
  const [remoteJobs, setRemoteJobs] = useState(() => new Map())
  const [installed, setInstalled] = useState(() => new Map())
  const [reloadTick, setReloadTick] = useState(0)
  const [selectedEntry, setSelectedEntry] = useState(null)
  const submitting = useRef(new Set())
  const progressRevision = useRef(0)
  const gridRef = useRef(null)
  const footerRef = useRef(null)
  const feed = useRef(null)
  const needle = query.trim()

  useEffect(() => {
    const controller = new AbortController()
    const current = { signal: controller.signal, query: needle, nextPage: null, pending: false }
    feed.current = current
    setEntries(null)
    setHasMore(false)
    setLoadingMore(false)
    setLoadMoreFailed(false)
    setFailed(false)
    let notice
    const dismiss = () => {
      if (notice !== undefined) useNotificationsStore.getState().dismiss(notice)
    }
    const start = async () => {
      notice = showNotification('正在加载 AdapterHub…', { type: 'loading', duration: 0 })
      try {
        const result = await fetchAdapterHub({ page: 1, query: needle, signal: current.signal })
        if (current.signal.aborted) return
        current.nextPage = result.hasMore ? 2 : null
        setHasMore(result.hasMore)
        setEntries(result.items)
      } catch {
        if (current.signal.aborted) return
        setEntries([])
        setFailed(true)
      } finally {
        dismiss()
      }
    }
    const timer = needle ? setTimeout(start, 240) : undefined
    if (!needle) void start()
    return () => {
      clearTimeout(timer)
      controller.abort()
      dismiss()
    }
  }, [needle, reloadTick])

  const loadMore = useCallback(async () => {
    const current = feed.current
    const page = current?.nextPage
    if (!page || current.pending || current.signal.aborted) return
    current.pending = true
    setLoadingMore(true)
    setLoadMoreFailed(false)
    try {
      const result = await fetchAdapterHub({ page, query: current.query, signal: current.signal })
      if (current.signal.aborted) return
      current.nextPage = result.hasMore ? page + 1 : null
      setHasMore(result.hasMore)
      setEntries(previous => Array.from(new Map([...previous, ...result.items].map(item => [item.id, item])).values()))
    } catch {
      if (!current.signal.aborted) setLoadMoreFailed(true)
    } finally {
      current.pending = false
      if (!current.signal.aborted) setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    if (!hasMore || loadingMore || loadMoreFailed || !footerRef.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void loadMore()
    }, { root: gridRef.current, rootMargin: '0px 0px 160px 0px' })
    observer.observe(footerRef.current)
    return () => observer.disconnect()
  }, [entries, hasMore, loadingMore, loadMoreFailed, loadMore, selectedEntry])

  const hasLocalJobs = localJobs.size > 0
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const poll = async () => {
      const revision = progressRevision.current
      let active = false
      try {
        const items = await fetchAdapterHubInstallProgress(controller.signal)
        if (controller.signal.aborted) return
        active = items.length > 0
        if (revision === progressRevision.current) setRemoteJobs(new Map(items.map(job => [job.name, job])))
      } catch {
        // The install request reports the outcome even if progress polling fails.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, hasLocalJobs || active ? 350 : 1500)
      }
    }
    if (hasLocalJobs) void poll()
    else timer = setTimeout(poll, 350)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [hasLocalJobs])

  const install = async (entry) => {
    if (submitting.current.has(entry.id) || remoteJobs.has(entry.id)) return
    submitting.current.add(entry.id)
    const removeJob = jobs => {
      const remaining = new Map(jobs)
      remaining.delete(entry.id)
      return remaining
    }
    setLocalJobs(jobs => new Map(jobs).set(entry.id, { status: 'preparing' }))
    try {
      const result = await installAdapterFromHub(entry.id, entry.version)
      if (result?.site?.id === entry.id) addInstalledSite(result.site)
      progressRevision.current++
      setRemoteJobs(removeJob)
      setLocalJobs(jobs => new Map(jobs).set(entry.id, { status: 'complete' }))
      await new Promise(resolve => setTimeout(resolve, 280))
      setInstalled(versions => new Map(versions).set(entry.id, entry.version))
      showNotification(`已${entry.action === 'update' ? '更新' : '安装'} ${entry.name}`, { type: 'success' })
    } catch (error) {
      showNotification(error.message || '安装 Adapter 失败，请稍后重试。', { type: 'error', duration: 8000 })
    } finally {
      submitting.current.delete(entry.id)
      progressRevision.current++
      setLocalJobs(removeJob)
      setRemoteJobs(removeJob)
    }
  }

  if (selectedEntry) {
    const job = remoteJobs.get(selectedEntry.id) || localJobs.get(selectedEntry.id)
    const current = installed.get(selectedEntry.id) === selectedEntry.version
    const label = current || (!selectedEntry.action && selectedEntry.installedVersion) ? '已安装'
      : selectedEntry.action === 'update' ? '更新' : selectedEntry.action === 'install' ? '安装' : '不可安装'
    return <AdapterDetailView mode="hub" entry={selectedEntry} onClose={() => setSelectedEntry(null)} action={
      job ? <TransferButton job={job} entry={selectedEntry} /> :
        <button type="button" className="tool-package-card-action is-update" disabled={current || !selectedEntry.action} onClick={() => install(selectedEntry)}>
          {label}
        </button>
    } />
  }

  return (
    <section className="tool-package-list-page adapter-hub" aria-label="AdapterHub">
      <div className="adapter-hub__toolbar">
        <input
          type="search"
          className="adapter-hub__search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索 Adapter"
          aria-label="搜索 AdapterHub"
        />
      </div>
      {entries === null ? null : failed ? (
        <div className="adapter-hub__empty">
          <span>AdapterHub 暂不可用，请稍后重试。</span>
          <button type="button" className="adapter-hub__retry" onClick={() => setReloadTick(tick => tick + 1)}>重试</button>
        </div>
      ) : entries.length === 0 && !hasMore ? (
        <p className="adapter-hub__empty">{query.trim() ? '没有匹配的 Adapter。' : 'AdapterHub 暂无可用 Adapter。'}</p>
      ) : (
        <div ref={gridRef} className="tool-package-card-grid adapter-hub__grid" role="list" aria-label="AdapterHub 列表">
          {entries.map(raw => {
            const installedVersion = installed.get(raw.id)
            const entry = installedVersion && installedVersion === raw.version
              ? { ...raw, installedVersion, action: null, unavailableReason: '' } : raw
            const upToDate = Boolean(entry.installedVersion) && entry.installedVersion === entry.version
            const job = remoteJobs.get(entry.id) || localJobs.get(entry.id)
            const label = upToDate ? '已安装' : entry.action === 'update' ? '更新' : entry.action === 'install' ? '安装' : entry.installedVersion ? '已安装' : '不可安装'
            return (
              <article key={entry.id} role="listitem" className="tool-package-entry tool-package-entry--hub" onClick={() => setSelectedEntry(entry)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedEntry(entry) } }} tabIndex={0}>
                <span className="tool-package-entry__icon" aria-hidden="true">
                  {entry.iconUrl ? <img src={entry.iconUrl} alt="" /> : <SiteIcon site={{ id: entry.id, name: entry.name }} size={34} />}
                </span>
                <div className="tool-package-entry__body">
                  <h2 className="tool-package-entry__title" title={entry.name}>{entry.name}</h2>
                  <span className="tool-package-entry__description">{entry.description || entry.id}</span>
                </div>
                {job ? <TransferButton job={job} entry={entry} /> : (
                  <button
                    type="button"
                    className="tool-package-card-action is-update"
                    disabled={!entry.action}
                    aria-label={`${label} ${entry.name}`}
                    onClick={event => { event.stopPropagation(); install(entry) }}
                  >
                    {label}
                  </button>
                )}
                <div className="tool-package-entry__footer">
                  <div className="adapter-hub__meta">
                    <span>最新 {entry.version || '—'}</span>
                    {entry.installedVersion && <span>已安装 {entry.installedVersion}</span>}
                    {entry.official && <span className="adapter-hub__official">官方</span>}
                    {entry.unavailableReason && <span>{entry.unavailableReason}</span>}
                  </div>
                </div>
              </article>
            )
          })}
          {hasMore && (
            <div ref={footerRef} className="adapter-hub__pagination" role="listitem">
              {loadingMore ? (
                <span role="status"><i className="adapter-hub__spinner" aria-hidden="true" />正在加载更多…</span>
              ) : (
                <button type="button" className="adapter-hub__retry" onClick={loadMore}>
                  {loadMoreFailed ? '加载失败，重试' : '加载更多'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
