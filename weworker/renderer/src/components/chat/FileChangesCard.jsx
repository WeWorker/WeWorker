import React, { useEffect, useState } from 'react'
import { FileTextOutlined } from '@ant-design/icons'
import { backendFetch } from '../../api/http.js'
import { useFileChangesStore } from '../../store/file-changes.js'
import { useUserFilesStore } from '../../store/user-files.js'
import { fileChangeBase, fileSizeLabel, fileChangeEntries, fileChangeToolState, fileChangeTotals, fileChangeLabel, fileChangeName } from '../../utils/file-changes.js'
import './file-changes.css'

export default function FileChangesCard({ workId, content, streaming = false, scope = 'chat', revision = '' }) {
  const toolState = fileChangeToolState(content)
  const [result, setResult] = useState({ key: '', records: [], error: false })
  const [retry, setRetry] = useState(0)
  const key = `${scope}:${workId}:${toolState}`
  const filesRevision = result.key === key ? JSON.stringify(result.records) : ''
  useEffect(() => {
    if (result.key === key && result.records.some(record => record.files?.length)) {
      void useUserFilesStore.getState().refreshForChanges(workId, scope)
    }
  }, [workId, scope, filesRevision])
  useEffect(() => {
    const tools = JSON.parse(toolState).map(([id]) => id)
    if (!workId || (scope === 'chat' && !tools.length)) return undefined
    const controller = new AbortController()
    let busy = false
    const load = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try {
        const records = []
        for (let i = 0; i < Math.max(1, tools.length); i += 100) {
          let offset = 0
          do {
            const query = new URLSearchParams({ offset: String(offset), ...(scope === 'chat' ? { tools: tools.slice(i, i + 100).join(',') } : {}) })
            const response = await backendFetch(`${fileChangeBase(workId, scope)}?${query}`, { signal: controller.signal })
            if (!response.ok) throw new Error('Failed to load changes')
            const page = await response.json()
            records.push(...page.records)
            offset = Number.isInteger(page.nextOffset) && page.nextOffset > offset ? page.nextOffset : null
          } while (offset !== null && !controller.signal.aborted)
        }
        if (!controller.signal.aborted) {
          setResult({ key, records, error: false })
          useFileChangesStore.getState().refreshPanel(workId, tools, records, scope)
        }
      } catch { if (!controller.signal.aborted) setResult({ key, records: [], error: true }) }
      finally { busy = false }
    }
    void load()
    const timer = streaming ? setInterval(load, 2000) : setTimeout(load, 600)
    return () => { controller.abort(); clearInterval(timer); clearTimeout(timer) }
  }, [workId, toolState, streaming, retry, scope, revision])
  // Keep recording and file-panel refreshes active without growing the reply
  // while this turn is running. Its summary belongs after execution finishes.
  if (streaming || !workId || (scope === 'chat' && toolState === '[]') || result.key !== key) return null
  if (result.error) return <button className="file-changes-load-error" type="button" onClick={() => setRetry(value => value + 1)}>产物记录加载失败，点击重试</button>
  if (!result.records.length) return null
  const entries = fileChangeEntries(result.records)
  if (!entries.length) return null
  const totals = fileChangeTotals(result.records)
  // One visible row per output; the sidebar retains every before/after version.
  const latest = [...new Map(entries.map(entry => [entry.path, entry])).values()]
  const open = entry => useFileChangesStore.getState().openPanel(workId, result.records, entry?.recordId ?? entries[0]?.recordId, entry?.fileIndex ?? 0, scope)
  return <section className="file-changes-card" aria-label="产物与变更">
    <div className="file-changes-card__header">
      <FileTextOutlined className="file-changes-card__icon" />
      <div className="file-changes-card__heading"><strong>产物与变更 · {totals.files} 个文件</strong>
        {(totals.added > 0 || totals.removed > 0) && <span title="各次修改累计增删行数"><span className="file-change-added">+{totals.added}</span> <span className="file-change-removed">−{totals.removed}</span></span>}
      </div>
      <button type="button" className="file-changes-view" onClick={() => open()} disabled={!entries.length}>查看详情</button>
    </div>
    <div className="file-changes-card__files">{latest.slice(0, 5).map(entry => <button type="button" className="file-changes-file" key={`${entry.recordId}:${entry.fileIndex}`} onClick={() => open(entry)}>
      <span className={`file-change-operation file-change-operation--${entry.operation || 'unknown'}`}>{fileChangeLabel(entry.operation)}</span>
      <span className="file-changes-path" title={entry.path}>{fileChangeName(entry.path)}</span>
      {entry.status === 'recording' ? <span className="file-change-state">记录未完成</span> : entry.comparable !== false ? <span className="file-changes-counts"><span className="file-change-added">+{entry.added}</span> <span className="file-change-removed">−{entry.removed}</span></span> : <span className="file-change-state">{fileSizeLabel(entry.size) || '文件'}</span>}
    </button>)}</div>
    {entries.length > 5 && <button type="button" className="file-changes-more" onClick={() => open()}>查看全部 {entries.length} 项记录</button>}
  </section>
}
