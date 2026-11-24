import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fetchAdapterHub, installAdapterFromHub } from '../../api/adapter-hub-api.js'
import { showNotification, updateNotification } from '../../store/notifications.js'
import { useSitesStore } from '../../store/sites.js'
import SiteIcon from '../icons/SiteIcon.jsx'
import './adapter-hub.css'

export default function AdapterHub() {
  const refreshSites = useSitesStore(state => state.refreshSites)
  const [entries, setEntries] = useState(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [installing, setInstalling] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const installingRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    fetchAdapterHub(controller.signal).then(items => {
      if (!controller.signal.aborted) setEntries(items)
    }).catch(() => {
      if (controller.signal.aborted) return
      setEntries([])
      setFailed(true)
    })
    return () => controller.abort()
  }, [reloadTick])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries || []
    return (entries || []).filter(entry => [entry.id, entry.name, entry.description]
      .some(value => value.toLowerCase().includes(needle)))
  }, [entries, query])

  const install = async (entry) => {
    if (installingRef.current) return
    installingRef.current = true
    setInstalling(entry.id)
    const notice = showNotification(`正在安装 ${entry.name}…`, { type: 'loading', duration: 0 })
    try {
      await installAdapterFromHub(entry.id, entry.version)
      await refreshSites()
      updateNotification(notice, `已安装 ${entry.name}`, { type: 'success' })
      setReloadTick(tick => tick + 1)
    } catch (error) {
      updateNotification(notice, error.message || '安装 Adapter 失败，请稍后重试。', { type: 'error', duration: 8000 })
    } finally {
      installingRef.current = false
      setInstalling('')
    }
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
      {entries === null ? (
        <p className="adapter-hub__empty">正在加载 AdapterHub…</p>
      ) : failed ? (
        <div className="adapter-hub__empty">
          <span>AdapterHub 暂不可用，请稍后重试。</span>
          <button type="button" className="adapter-hub__retry" onClick={() => setReloadTick(tick => tick + 1)}>重试</button>
        </div>
      ) : visible.length === 0 ? (
        <p className="adapter-hub__empty">{query.trim() ? '没有匹配的 Adapter。' : 'AdapterHub 暂无可用 Adapter。'}</p>
      ) : (
        <div className="tool-package-card-grid" role="list" aria-label="AdapterHub 列表">
          {visible.map(entry => {
            const upToDate = Boolean(entry.installedVersion) && entry.installedVersion === entry.version
            const pending = installing === entry.id
            return (
              <article key={entry.id} role="listitem" className="tool-package-entry tool-package-entry--hub">
                <span className="tool-package-entry__icon" aria-hidden="true">
                  {entry.iconUrl ? <img src={entry.iconUrl} alt="" /> : <SiteIcon site={{ id: entry.id, name: entry.name }} size={34} />}
                </span>
                <div className="tool-package-entry__body">
                  <h2 className="tool-package-entry__title" title={entry.name}>{entry.name}</h2>
                  <span className="tool-package-entry__description">{entry.description || entry.id}</span>
                </div>
                <button
                  type="button"
                  className="tool-package-card-action is-update"
                  disabled={upToDate || pending || Boolean(installing)}
                  aria-label={upToDate ? `${entry.name} 已安装` : `安装 ${entry.name}`}
                  onClick={() => install(entry)}
                >
                  {pending ? '安装中…' : upToDate ? '已安装' : entry.installedVersion ? '更新' : '安装'}
                </button>
                <div className="tool-package-entry__footer">
                  <div className="adapter-hub__meta">
                    <span>最新 {entry.version || '—'}</span>
                    {entry.installedVersion && <span>已安装 {entry.installedVersion}</span>}
                    {entry.official && <span className="adapter-hub__official">官方</span>}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
