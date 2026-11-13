import React, { useEffect, useState } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import { backendFetch } from '../../api/http.js'
import { useFileChangesStore } from '../../store/file-changes.js'
import { fileChangeEntries, fileChangeLabel, fileChangeName } from '../../utils/file-changes.js'
import '../chat/file-changes.css'

const snapshotLabel = snapshot => ({ missing: '文件不存在', binary: '二进制文件', too_large: '文件过大', unavailable: '快照不完整', text: '文本快照' }[snapshot?.state] || '暂无快照')
export default function FileChangesSidePanel() {
  const { workId, records, recordId, fileIndex, selectFile, closePanel } = useFileChangesStore()
  const [state, setState] = useState({ key: '', loading: true, data: null, error: false })
  const [retry, setRetry] = useState(0)
  const [visibleRows, setVisibleRows] = useState(200)
  const selectedRecord = records.find(record => record.id === recordId)
  const revision = `${selectedRecord?.status}:${selectedRecord?.completedAt || ''}`
  const key = `${workId}:${recordId}:${fileIndex}:${revision}`
  useEffect(() => {
    const controller = new AbortController()
    setVisibleRows(200)
    setState({ key, loading: true, data: null, error: false })
    const load = async () => {
      try {
        const response = await backendFetch(`/works/${encodeURIComponent(workId)}/file-changes/${encodeURIComponent(recordId)}?file=${fileIndex}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Failed to load comparison')
        const data = await response.json()
        if (!controller.signal.aborted) setState({ key, loading: false, data, error: false })
      } catch { if (!controller.signal.aborted) setState({ key, loading: false, data: null, error: true }) }
    }
    void load()
    return () => controller.abort()
  }, [workId, recordId, fileIndex, revision, retry])
  const data = state.key === key ? state.data : null
  const entries = fileChangeEntries(records)
  return <aside className="file-changes-panel" aria-label="修改前后对比">
    <header className="file-changes-panel__header"><strong>修改对比</strong><button type="button" title="关闭" aria-label="关闭修改对比" onClick={closePanel}><CloseOutlined /></button></header>
    <nav className="file-changes-panel__files" aria-label="修改文件列表">{entries.map(entry => <button type="button" key={`${entry.recordId}:${entry.fileIndex}`} aria-current={entry.recordId === recordId && entry.fileIndex === fileIndex ? 'true' : undefined}
      onClick={() => selectFile(entry.recordId, entry.fileIndex)} title={`${entry.path}\n${new Date(entry.startedAt).toLocaleString()}`}>
      <span className={`file-change-operation file-change-operation--${entry.operation || 'unknown'}`}>{fileChangeLabel(entry.operation)}</span>
      <span className="file-changes-path">{fileChangeName(entry.path)}</span>
      <span className="file-change-added">+{entry.added}</span><span className="file-change-removed">−{entry.removed}</span>
    </button>)}</nav>
    {(state.key !== key || state.loading) && <p className="file-changes-panel__hint" role="status">加载中…</p>}
    {state.key === key && state.error && <button className="file-changes-load-error" type="button" onClick={() => setRetry(value => value + 1)}>无法读取对比，点击重试</button>}
    {data && <div className="file-changes-panel__body">
      {(data.status === 'failed' || data.status === 'recording' || data.note) && <div className="file-changes-panel__details">
        {data.status === 'failed' && <span title="工具执行失败，可能已发生部分修改">执行失败</span>}
        {data.status === 'recording' && <span title="执行中或已中断，尚无最终快照">记录未完成</span>}
        {data.note && <span className="file-changes-note" title={data.note} tabIndex={0}>记录范围 ⓘ</span>}
      </div>}
      <div className="file-change-diff-head"><strong>修改前</strong><strong>修改后</strong></div>
      {data.diff ? <div className="file-change-diff" role="table" aria-label="文件差异">
        {data.diff.rows.slice(0, visibleRows).map((row, index) => <div className={`file-change-diff-row file-change-diff-row--${row.kind}`} role="row" key={index}>
          <div role="cell" className={row.kind === 'remove' ? 'is-removed' : ''}><span className="file-change-line">{row.beforeLine}</span><code>{row.kind === 'add' ? '' : row.text || '\u00a0'}</code></div>
          <div role="cell" className={row.kind === 'add' ? 'is-added' : ''}><span className="file-change-line">{row.afterLine}</span><code>{row.kind === 'remove' ? '' : row.text || '\u00a0'}</code></div>
        </div>)}
        {data.diff.rows.length === 0 && <p className="file-changes-panel__hint">空文件</p>}
        {visibleRows < data.diff.rows.length && <button type="button" className="file-changes-more" onClick={() => setVisibleRows(count => count + 200)}>继续显示差异（{visibleRows}/{data.diff.rows.length} 行）</button>}
      </div> : <div className="file-change-metadata"><p>{snapshotLabel(data.file.before)}</p><p>{snapshotLabel(data.file.after)}</p></div>}
    </div>}
  </aside>
}
