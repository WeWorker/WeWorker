import React, { useMemo } from 'react'
import { useDedicatedAgentsStore } from '../../../store/dedicated-agents.js'
import { useSitesStore } from '../../../store/sites.js'
import SiteIcon from '../../icons/SiteIcon.jsx'
import { BUILT_IN_TEMPLATES } from './templates.js'
import { hintStyle, titleStyle } from '../styles.js'
import './quick-create.css'

/**
 * 新建 WeWorker Bot 的第一步，分两个部分：
 * - BotHub：AppStore 风格的小卡片（图标 + 名称 + 一句话简介 + 创建按钮），
 *   详细说明留给流程页，首页不占用太多信息；
 * - 自定义新建：自由搭配的次级入口。
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
      quickStep: template.introMarkdown ? 'intro' : 'questions',
      quickQuestionIndex: 0,
    }, draftKey)
  }

  return (
    <div className="quick-create" style={{ maxWidth: 760 }}>
      <h2 style={titleStyle}>新建 WeWorker Bot ✨</h2>
      <div style={{ ...hintStyle, margin: '6px 0 22px' }}>
        从 BotHub 挑一个现成的 Bot，或自由搭配一个属于自己的。
      </div>

      <section className="quick-create__section">
        <div className="quick-create__section-head">
          <h3 className="quick-create__section-title">BotHub</h3>
          <span className="quick-create__section-sub">答几个问题、扫个码就能上岗</span>
        </div>
        <div className="quick-create__hub">
          {BUILT_IN_TEMPLATES.map((template) => {
            const site = siteById.get(template.siteId)
            const ready = Boolean(site?.enabled)
            const cardBody = (
              <>
                <span className="quick-create__hub-icon" aria-hidden="true">{template.emoji}</span>
                <span className="quick-create__hub-body">
                  <span className="quick-create__hub-name">
                    {template.name}
                    {ready && (
                      <span className="quick-create__hub-site">
                        <SiteIcon site={site || { id: template.siteId }} size={12} />
                        {template.siteLabel}
                      </span>
                    )}
                  </span>
                  <span className="quick-create__hub-desc">
                    {ready ? template.tagline : `需先在「SKILLS与场景」启用 ${template.siteLabel} 网站`}
                  </span>
                </span>
                <span className={`quick-create__hub-cta${ready ? '' : ' is-muted'}`} aria-hidden="true">
                  {ready ? '创建' : '未启用'}
                </span>
              </>
            )
            return ready ? (
              <div
                key={template.id}
                role="button"
                tabIndex={0}
                className="quick-create__hub-card is-selectable"
                onClick={() => startTemplate(template)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startTemplate(template) }
                }}
              >
                {cardBody}
              </div>
            ) : (
              <div
                key={template.id}
                className="quick-create__hub-card"
                title={`先在「SKILLS与场景」启用 ${template.siteLabel}（${template.siteId}）网站，再回来创建这个 Bot。`}
              >
                {cardBody}
              </div>
            )
          })}
        </div>
      </section>

      <section className="quick-create__section">
        <div className="quick-create__section-head">
          <h3 className="quick-create__section-title">自定义新建</h3>
          <span className="quick-create__section-sub">网站、专属知识、本地目录和机器人，一步步自由搭配</span>
        </div>
        <button type="button" className="quick-create__custom" onClick={startCustom}>
          <span className="quick-create__custom-emoji" aria-hidden="true">🧰</span>
          <span className="quick-create__custom-body">
            <span className="quick-create__custom-title">自定义创建</span>
          </span>
          <span className="quick-create__custom-arrow" aria-hidden="true">→</span>
        </button>
      </section>
    </div>
  )
}
