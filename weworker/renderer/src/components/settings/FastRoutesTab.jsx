import React, { useEffect, useRef, useState } from 'react'
import MessageItem from '../chat/MessageItem.jsx'
import { showConfirm } from '../../store/dialog.js'
import {
  listFastRoutes, testFastRouteCandidate, approveFastRouteCandidate,
  ignoreFastRouteCandidate, deleteLocalFastRoute,
} from '../../api/fast-routes.js'
import './fast-routes.css'

const verified = (candidate) => candidate.verification === 'verified'
  && candidate.runnableArgs != null
  && typeof candidate.runnableArgs === 'object'
  && !Array.isArray(candidate.runnableArgs)

function safeFields(candidate) {
  return Array.isArray(candidate.displayFields)
    ? candidate.displayFields.filter((field) => typeof field?.key === 'string' && typeof field?.label === 'string')
    : []
}

export default function FastRoutesTab() {
  const [data, setData] = useState({ candidates: [], routes: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [tested, setTested] = useState({})
  const [selected, setSelected] = useState({})
  const [availableFields, setAvailableFields] = useState({})
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [])

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      const next = await listFastRoutes()
      if (mounted.current) {
        setData(next)
        setTested({})
        setSelected({})
        setAvailableFields({})
      }
    } catch (cause) {
      if (mounted.current) setError(cause?.message || '加载快捷路由失败')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  async function action(key, callback, success, reload = false) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(key)
    setError('')
    setMessage('')
    try {
      const result = await callback()
      if (!mounted.current) return
      if (reload) await refresh()
      if (mounted.current) setMessage(success)
      return result
    } catch (cause) {
      if (mounted.current) setError(cause?.message || '操作失败')
      return null
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy('')
    }
  }

  const test = async (candidate) => {
    if (!verified(candidate) || inFlight.current) return
    const chosen = selected[candidate.id] ?? safeFields(candidate).map((field) => field.key)
    // An initial empty list asks the backend to discover safe defaults. After that,
    // an empty selection cannot be previewed or approved.
    if (availableFields[candidate.id] && chosen.length === 0) return
    setTested((current) => ({ ...current, [candidate.id]: null }))
    await action(`test:${candidate.id}`, async () => {
      const result = await testFastRouteCandidate(candidate.id, chosen)
      if (result.ok !== true || typeof result.previewMarkdown !== 'string'
        || typeof result.previewToken !== 'string' || !result.previewToken
        || !Number.isSafeInteger(result.revision) || result.revision < 0
        || !Array.isArray(result.displayFields)) throw new Error('测试未返回有效的只读预览凭证')
      if (candidate.revision != null && result.revision !== candidate.revision) throw new Error('候选路由已变化，请刷新列表后重新测试')
      const fields = safeFields(result)
      if (fields.length !== result.displayFields.length || fields.some((field) => !field.key)) throw new Error('测试返回的展示字段无效')
      if (chosen.length && (fields.length !== chosen.length || chosen.some((key) => !fields.some((field) => field.key === key)))) {
        throw new Error('测试预览字段与所选字段不一致')
      }
      if (mounted.current) {
        setAvailableFields((current) => ({ ...current, [candidate.id]: current[candidate.id] ?? (safeFields(candidate).length ? safeFields(candidate) : fields) }))
        setSelected((current) => ({ ...current, [candidate.id]: current[candidate.id] ?? fields.map((field) => field.key) }))
        setTested((current) => ({ ...current, [candidate.id]: {
          candidateId: candidate.id, revision: result.revision, token: result.previewToken,
          fields: chosen.length ? chosen : fields.map((field) => field.key), preview: result.previewMarkdown,
        } }))
      }
    }, '只读测试完成。请检查结果后决定是否启用。')
  }

  const enable = async (candidate) => {
    const receipt = tested[candidate.id]
    const selectedKeys = selected[candidate.id] ?? []
    if (!verified(candidate) || !receipt?.token || receipt.candidateId !== candidate.id
      || !Number.isSafeInteger(receipt.revision) || (candidate.revision != null && receipt.revision !== candidate.revision)
      || selectedKeys.length === 0 || selectedKeys.length !== receipt.fields.length
      || selectedKeys.some((key) => !receipt.fields.includes(key))) return
    await action(`approve:${candidate.id}`, () => approveFastRouteCandidate(candidate.id, selectedKeys, receipt.token, receipt.revision), '快捷路由已启用', true)
  }

  const ignore = async (candidate) => {
    await action(`ignore:${candidate.id}`, () => ignoreFastRouteCandidate(candidate.id), '已忽略候选路由', true)
  }

  const remove = async (route) => {
    if (route.source !== 'local') return
    if (!await showConfirm(`确定删除本地快捷路由“${route.title || route.id}”吗？此操作不会删除系统路由。`, '删除本地快捷路由', { danger: true })) return
    if (!Number.isSafeInteger(route.revision) || route.revision < 0) {
      setError('本地路由缺少版本信息，请刷新列表后重试')
      return
    }
    await action(`delete:${route.id}`, () => deleteLocalFastRoute(route.id, route.revision), '本地快捷路由已删除', true)
  }

  const toggleField = (candidate, key) => {
    if (inFlight.current) return
    const initial = (availableFields[candidate.id] ?? safeFields(candidate)).map((field) => field.key)
    setSelected((current) => {
      const values = current[candidate.id] ?? initial
      return { ...current, [candidate.id]: values.includes(key) ? values.filter((value) => value !== key) : [...values, key] }
    })
    // A token is bound to the exact fields previewed. Any edit requires re-test.
    setTested((current) => ({ ...current, [candidate.id]: null }))
  }

  return (
    <div className="fast-routes settings-stack">
      <p className="fast-routes__intro">候选路由必须先通过真实只读测试，检查预览并选择展示字段后才能启用。测试不会启用路由。</p>
      {loading && <p role="status">正在加载快捷路由…</p>}
      {error && <div className="settings-background-section__error" role="alert">{error} <button type="button" disabled={Boolean(busy)} onClick={refresh}>重试</button></div>}
      {message && <p role="status">{message}</p>}
      {!loading && <>
        <section className="fast-routes__section" aria-label="待审核路由">
          <h4>待审核</h4>
          {data.candidates.length === 0 && <p>暂无待审核的快捷路由。</p>}
          {data.candidates.map((candidate) => {
            const fields = availableFields[candidate.id] ?? safeFields(candidate)
            const canTest = verified(candidate)
            const preview = tested[candidate.id]
            const chosen = selected[candidate.id] ?? fields.map((field) => field.key)
            const canEnable = Boolean(preview?.token && preview.candidateId === candidate.id
              && (candidate.revision == null || preview.revision === candidate.revision)
              && chosen.length > 0 && chosen.length === preview.fields.length
              && chosen.every((key) => preview.fields.includes(key)))
            return <article key={candidate.id} className="fast-routes__card">
              <h5>{candidate.title || candidate.id}</h5>
              {candidate.siteName && <p>站点：{candidate.siteName}</p>}
              {candidate.description && <p>{candidate.description}</p>}
              {!canTest && <p className="fast-routes__warning">仅发现路由身份，尚无已核实的固定参数，暂无法验证、测试或启用。</p>}
              {canTest && <>
                <div className="fast-routes__actions">
                  <button type="button" className="settings-btn settings-btn-secondary" disabled={Boolean(busy) || (Boolean(availableFields[candidate.id]) && chosen.length === 0)} onClick={() => test(candidate)}>{busy === `test:${candidate.id}` ? '测试中…' : '运行只读测试'}</button>
                  <button type="button" className="settings-btn settings-btn-primary" disabled={Boolean(busy) || !canEnable} onClick={() => enable(candidate)}>{busy === `approve:${candidate.id}` ? '启用中…' : '确认启用'}</button>
                </div>
                {preview && <div className="fast-routes__preview" aria-label="只读测试结果">
                  <strong>只读测试预览</strong>
                  {preview.preview ? <MessageItem message={{ role: 'assistant', content: [{ type: 'text', text: preview.preview }] }} /> : <p>测试成功，结果为空。</p>}
                  </div>}
                 {fields.length > 0 && <fieldset className="fast-routes__fields">
                    <legend>展示字段（仅可选择后端提供的安全字段）</legend>
                    {fields.map((field) => <label key={field.key}><input type="checkbox" checked={chosen.includes(field.key)} disabled={Boolean(busy)} onChange={() => toggleField(candidate, field.key)} />{field.label}</label>)}
                  {availableFields[candidate.id] && !preview && <p>展示字段已更改，请重新运行只读测试。</p>}
                   {chosen.length === 0 && <p>请至少选择一个展示字段。</p>}
                   </fieldset>}
              </>}
              <div className="fast-routes__actions"><button type="button" className="settings-btn settings-btn-secondary" disabled={Boolean(busy)} onClick={() => ignore(candidate)}>{busy === `ignore:${candidate.id}` ? '忽略中…' : '忽略'}</button></div>
            </article>
          })}
        </section>
        <section className="fast-routes__section" aria-label="已配置路由">
          <h4>已配置路由</h4>
          {data.routes.length === 0 && <p>暂无已配置的快捷路由。</p>}
          {data.routes.map((route) => <article key={`${route.source}:${route.id}`} className="fast-routes__card">
            <h5>{route.title || route.id} <span className="fast-routes__badge">{route.source === 'local' ? '本地' : '系统 · 仅查看'}</span></h5>
            {route.siteName && <p>站点：{route.siteName}</p>}
            {route.description && <p>{route.description}</p>}
            {route.source === 'local' && <button type="button" className="settings-btn settings-btn-secondary" disabled={Boolean(busy)} onClick={() => remove(route)}>{busy === `delete:${route.id}` ? '删除中…' : '删除本地路由'}</button>}
          </article>)}
        </section>
      </>}
    </div>
  )
}
