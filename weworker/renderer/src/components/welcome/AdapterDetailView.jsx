import React, { useEffect, useState } from 'react'
import { DownOutlined } from '@ant-design/icons'
import SiteIcon from '../icons/SiteIcon.jsx'
import { fetchAdapterHubDetail } from '../../api/adapter-hub-api.js'
import { installedAdapterVersion } from '../../api/adapter-updates-api.js'
import { showNotification, useNotificationsStore } from '../../store/notifications.js'
import { shortToolName } from '../../utils/tool-name.js'
import './adapter-detail.css'

function PromptRow({ text }) {
  const [status, setStatus] = useState('')
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('已复制')
    } catch {
      setStatus('复制失败')
    }
  }
  return <div className="adapter-detail__prompt">
    <pre><code>{text}</code></pre>
    <div className="adapter-detail__prompt-actions">
      <button type="button" onClick={copyPrompt}>复制</button>
      <span role="status">{status}</span>
    </div>
  </div>
}

function parametersOf(command) {
  if (Array.isArray(command.parameters)) return command.parameters
  const schema = command.parametersSchema
  return Object.entries(schema?.properties || {}).map(([name, value]) => ({
    name,
    type: value?.type,
    description: value?.description,
    required: Array.isArray(schema?.required) && schema.required.includes(name),
  }))
}

export default function AdapterDetailView({ mode, site, entry, onClose, action }) {
  const remote = mode === 'hub'
  const [hubDetail, setHubDetail] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const id = remote ? entry.id : site.id

  useEffect(() => {
    if (!remote) return
    const controller = new AbortController()
    const notice = showNotification('正在加载详情…', { type: 'loading', duration: 0 })
    const dismiss = () => useNotificationsStore.getState().dismiss(notice)
    fetchAdapterHubDetail(id, controller.signal).then(data => {
      if (!controller.signal.aborted) setHubDetail(data)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause.message || '无法读取 AdapterHub 详情。')
    }).finally(dismiss)
    return () => {
      controller.abort()
      dismiss()
    }
  }, [remote, id, attempt])

  const detail = remote ? hubDetail : site
  const name = remote ? detail?.display || entry.name : site.name
  const commands = (remote ? detail?.commands : detail?.tools) || []
  const scenarios = detail?.scenarios || []
  const uploader = detail?.uploader || '未知'
  const domains = [...new Set([detail?.domains, detail?.match].filter(Array.isArray).flat()
    .filter(value => typeof value === 'string' && value.trim()))]
  return (
    <section className="adapter-detail" aria-label={`${name} 详情`}>
      <button type="button" onClick={onClose}>返回列表</button>
      {error && <div role="status">
        <p>{error}</p>
        <button type="button" onClick={() => { setError(''); setAttempt(value => value + 1) }}>重试</button>
      </div>}
      {detail && <>
        <header className="adapter-detail__header">
          <div className="adapter-detail__identity">
            <SiteIcon site={{ ...detail, id, name }} size={54} />
            <div>
              <h1>{name}</h1>
              <dl className="adapter-detail__metadata">
                <div><dt>上传用户：</dt><dd>{uploader}</dd></div>
                <div><dt>域名：</dt><dd>{domains.length ? domains.join('、') : '未提供'}</dd></div>
              </dl>
              <p>{detail.detailDescription || detail.description}</p>
            </div>
          </div>
          <dl className="adapter-detail__stats">
            <div><dt>命令</dt><dd>{detail.commandCount ?? commands.length}</dd></div>
            {remote && Number.isFinite(detail.downloads) && <div><dt>下载</dt><dd>{detail.downloads}</dd></div>}
            {remote && Number.isFinite(detail.favoriteCount) && <div><dt>收藏</dt><dd>{detail.favoriteCount}</dd></div>}
            <div><dt>版本</dt><dd>{remote ? detail.version : installedAdapterVersion(site)}</dd></div>
          </dl>
          {action}
        </header>
        <section>
          <h2>推荐提示词 <small>{scenarios.length} 个场景</small></h2>
          <div className="adapter-detail__scenarios">
            {scenarios.length === 0 && <p>暂无推荐提示词。</p>}
            {scenarios.map((scenario, index) => (
              <article key={scenario.id || index}>
                <h3>{scenario.title || '未命名场景'}</h3>
                {scenario.summary && <p>{scenario.summary}</p>}
                {scenario.prompts?.filter(prompt => typeof prompt?.text === 'string' && prompt.text.trim()).map((prompt, i) => (
                  <PromptRow key={i} text={prompt.text} />
                ))}
              </article>
            ))}
          </div>
        </section>
        <section>
          <h2>包含命令 <small>{commands.length} 个</small></h2>
          <div className="adapter-detail__commands">
            {commands.length === 0 && <p>暂无命令。</p>}
            {commands.map((command, index) => {
              const commandName = command.commandName || shortToolName(command.name || command.id || '未命名命令', id)
              const parameters = parametersOf(command)
              return <details key={`${commandName}-${index}`}>
                <summary>
                  <span className="adapter-detail__command-info">
                    <strong>{commandName}</strong>
                    <span>{command.description || '暂无说明'}</span>
                  </span>
                  <DownOutlined className="adapter-detail__command-chevron" aria-hidden="true" />
                </summary>
                <div className="adapter-detail__parameters">
                  {parameters.length === 0 ? <p>此命令无参数。</p> : <>
                    <h3>参数说明</h3>
                    <dl>
                      {parameters.map(parameter => (
                        <div key={parameter.name}>
                          <dt>
                            <code>{parameter.name}</code>
                            {parameter.type && <span>{Array.isArray(parameter.type) ? parameter.type.join(' / ') : parameter.type}</span>}
                            {parameter.required && <span className="adapter-detail__parameter-required">必填</span>}
                          </dt>
                          {parameter.description && <dd>{parameter.description}</dd>}
                        </div>
                      ))}
                    </dl>
                  </>}
                </div>
              </details>
            })}
          </div>
        </section>
      </>}
    </section>
  )
}
