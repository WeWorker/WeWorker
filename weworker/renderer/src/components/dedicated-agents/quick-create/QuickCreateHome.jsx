import React, { useMemo } from 'react'
import { Alert } from 'antd'
import { useDedicatedAgentsStore } from '../../../store/dedicated-agents.js'
import { useSitesStore } from '../../../store/sites.js'
import SiteIcon from '../../icons/SiteIcon.jsx'
import { BUILT_IN_TEMPLATES } from './templates.js'
import { hintStyle, titleStyle } from '../styles.js'
import './quick-create.css'

/**
 * 新建 WeWorker Bot 的第一步：选一个内置 Bot 模板，或走自定义创建。
 * 模板卡片整体可点、点击即进入流程；自定义放在底部作为次级入口。
 * 与 WeWorker Bot 列表同属一个页面，这里不放“取消”返回按钮。
 */
export default function QuickCreateHome({ draftKey }) {
  const existingDraft = useDedicatedAgentsStore((s) => s.agents.find((agent) => agent.draft && (agent.draftKey || agent.id) === draftKey))
  const updateDraftAgent = useDedicatedAgentsStore((s) => s.updateDraftAgent)
  const sites = useSitesStore((s) => s.sites)
  const siteById = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites])

  const startCustom = () => updateDraftAgent({ createMode: 'custom' }, draftKey)
  const startTemplate = (template) => {
    // 同一模板再次进入时保留之前的回答和进度。
    const resume = existingDraft?.templateId === template.id
    updateDraftAgent(resume ? { createMode: 'template' } : {
      createMode: 'template',
      templateId: template.id,
      templateAnswers: undefined,
      templateSkill: undefined,
      quickStep: 'questions',
      quickQuestionIndex: 0,
    }, draftKey)
  }

  return (
    <div className="quick-create" style={{ maxWidth: 760 }}>
      <h2 style={titleStyle}>新建 WeWorker Bot ✨</h2>
      <div style={{ ...hintStyle, margin: '6px 0 22px' }}>
        挑一个内置 Bot，答几个问题、扫个码就能上岗；也可以自由搭配一个属于自己的。
      </div>

      {BUILT_IN_TEMPLATES.map((template) => {
        const site = siteById.get(template.siteId)
        const ready = Boolean(site?.enabled)
        const card = (
          <>
            <div className="quick-create__template-head">
              <span className="quick-create__template-emoji" aria-hidden="true">{template.emoji}</span>
              <span className="quick-create__template-name">{template.name}</span>
              <span className="quick-create__template-site">
                <SiteIcon site={site || { id: template.siteId }} size={14} />
                {template.siteLabel}
              </span>
            </div>
            <div className="quick-create__template-tagline">{template.tagline}</div>
            <ul className="quick-create__template-highlights">
              {template.highlights.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <span className="quick-create__template-cta" aria-hidden="true">开始创建 →</span>
            {!ready && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 10 }}
                message={`先在「SKILLS与场景」启用 ${template.siteLabel}（${template.siteId}）网站，再回来创建这个 Bot。`}
              />
            )}
          </>
        )
        return ready ? (
          <div
            key={template.id}
            role="button"
            tabIndex={0}
            className="quick-create__template-card is-selectable"
            onClick={() => startTemplate(template)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startTemplate(template) }
            }}
          >
            {card}
          </div>
        ) : (
          <div key={template.id} className="quick-create__template-card">
            {card}
          </div>
        )
      })}

      <div className="quick-create__divider" aria-hidden="true"><span>或者</span></div>

      <button type="button" className="quick-create__custom" onClick={startCustom}>
        <span className="quick-create__custom-emoji" aria-hidden="true">🧰</span>
        <span className="quick-create__custom-body">
          <span className="quick-create__custom-title">自定义创建</span>
          <span className="quick-create__custom-desc">网站、专属知识、本地目录和机器人，一步步自由搭配</span>
        </span>
        <span className="quick-create__custom-arrow" aria-hidden="true">→</span>
      </button>
    </div>
  )
}
