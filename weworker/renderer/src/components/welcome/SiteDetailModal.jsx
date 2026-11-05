import React, { useEffect, useRef, useState } from 'react'
import SiteIcon from '../icons/SiteIcon.jsx'
import PromptRichText from '../prompt/PromptRichText.jsx'
import EditablePromptTemplate from '../prompt/EditablePromptTemplate.jsx'
import { getScenarioPromptText } from '../../utils/site-scenarios.js'
import { buildPromptFromTemplate } from '../../utils/prompt-template.js'
import { ClosePanelIcon, RobotIcon } from './WelcomeIcons.jsx'
import { assistantText, userPromptTemplate } from './welcome-utils.js'
import { shortToolName } from '../../utils/tool-name.js'

const DETAIL_HERO_MIN_WIDTH = 680
const fallbackDetailDescription = (siteName) => `${siteName} 可以让 WeWorker 根据你的自然语言指令执行网页任务，例如打开页面、读取内容、搜索信息、点击按钮、下载文件或整理结果。执行过程中如果遇到登录、确认、支付等敏感步骤，会停下来等你确认。`

function clearTextSelection() {
  if (typeof window === 'undefined') return
  window.getSelection?.()?.removeAllRanges()
}

export default function SiteDetailModal({ site, scenarios, onClose, onUseScenario }) {
  const panelRef = useRef(null)
  const [showHero, setShowHero] = useState(true)
  const demoScenarios = scenarios.filter((scenario) => getScenarioPromptText(site, scenario))
  const toolItems = (site.tools || []).filter((tool) => tool.name)
  const toolNames = toolItems.map((tool) => tool.name)
  const primaryScenario = demoScenarios[0] || scenarios[0]
  const primaryPrompt = primaryScenario ? userPromptTemplate(primaryScenario) || getScenarioPromptText(site, primaryScenario) : ''
  const primaryReply = primaryScenario ? assistantText(site, primaryScenario) : ''
  const detailDescription = site.detailDescription || fallbackDetailDescription(site.name)
  const [scenarioPromptValues, setScenarioPromptValues] = useState({})

  const updateScenarioPromptValue = (scenarioKey, slotKey, value) => {
    setScenarioPromptValues((current) => ({
      ...current,
      [scenarioKey]: {
        ...(current[scenarioKey] || {}),
        [slotKey]: value,
      },
    }))
  }

  const buildScenarioPrompt = (scenario, template, scenarioKey) => {
    if (template?.trim()) {
      return buildPromptFromTemplate(template, scenarioPromptValues[scenarioKey] || {}, site.promptVarDisplay || {}).trim()
    }
    return getScenarioPromptText(site, scenario)
  }

  useEffect(() => {
    clearTextSelection()
  }, [])

  useEffect(() => {
    const node = panelRef.current
    if (!node) return undefined

    const updateHeroVisibility = () => {
      setShowHero(node.getBoundingClientRect().width >= DETAIL_HERO_MIN_WIDTH)
    }

    updateHeroVisibility()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateHeroVisibility) : null
    observer?.observe(node)
    window.addEventListener('resize', updateHeroVisibility)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateHeroVisibility)
    }
  }, [])

  return (
    <div
      style={detailOverlayStyle}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        aria-label={`${site.name} 详情`}
        style={detailPanelStyle}
        onMouseDown={(event) => {
          clearTextSelection()
          event.stopPropagation()
        }}
      >
        <DetailCloseButton onClose={onClose} />

        <header style={detailHeaderStyle}>
          <SiteIcon site={site} size={54} />
          <div style={detailHeaderCopyStyle}>
            <h2 style={detailTitleStyle}>{site.name}</h2>
            <p style={detailSubtitleStyle}>{site.description}</p>
          </div>
        </header>

        {false && (
        <div style={detailHeroStyle}>
          <div style={detailHeroChatStyle}>
            {primaryPrompt && (
              <div style={detailHeroUserBubbleStyle}>
                <span style={speakerChipStyle}>用户</span>
                <PromptRichText text={primaryPrompt} varDisplay={site.promptVarDisplay || {}} />
              </div>
            )}
            {primaryReply && (
              <div style={detailHeroAssistantBubbleStyle}>
                <RobotIcon size={17} />
                <span>{primaryReply}</span>
              </div>
            )}
          </div>
        </div>
        )}

        <p style={detailDescriptionStyle}>{detailDescription}</p>

        <section style={detailSectionStyle}>
          <h3 style={detailSectionTitleStyle}>可以这样用</h3>
          <div style={detailScenarioGridStyle}>
            {demoScenarios.map((scenario) => {
              const prompt = userPromptTemplate(scenario) || getScenarioPromptText(site, scenario)
              const scenarioKey = `${scenario.id || scenario.title}-${prompt}`
              return (
                <div
                  key={scenario.id || scenario.title}
                  role="button"
                  tabIndex={0}
                  onClick={() => onUseScenario(scenario, buildScenarioPrompt(scenario, prompt, scenarioKey))}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    onUseScenario(scenario, buildScenarioPrompt(scenario, prompt, scenarioKey))
                  }}
                  style={detailScenarioCardStyle}
                >
                  <span style={detailScenarioTitleStyle}>{scenario.title}</span>
                  <span style={detailScenarioPromptStyle}>
                    <EditablePromptTemplate
                      text={prompt}
                      varDisplay={site.promptVarDisplay || {}}
                      values={scenarioPromptValues[scenarioKey] || {}}
                      onChange={(slotKey, value) => updateScenarioPromptValue(scenarioKey, slotKey, value)}
                    />
                  </span>
                  <span style={detailScenarioUseStyle}>填入对话框</span>
                </div>
              )
            })}
          </div>
        </section>

        <section style={detailSectionStyle}>
          <h3 style={detailSectionTitleStyle}>工具包</h3>
          <div style={detailToolGridStyle}>
            {toolItems.map((tool) => (
              <div key={tool.name} style={detailToolCardStyle}>
                <code style={detailToolNameStyle}>{shortToolName(tool.name, site.id)}</code>
                <p style={detailToolDescriptionStyle}>{tool.description || '暂无说明'}</p>
              </div>
            ))}
          </div>
        </section>

        <section style={detailSectionStyle}>
          <h3 style={detailSectionTitleStyle}>信息</h3>
          <div style={detailInfoTableStyle}>
            <div style={detailInfoRowStyle}><span>场景</span><strong>{site.scenarioCount ?? scenarios.length}</strong></div>
            <div style={detailInfoRowStyle}><span>工具</span><strong>{site.toolCount ?? toolNames.length}</strong></div>
            <div style={detailInfoRowStyle}><span>状态</span><strong>{site.enabled ? '已启用' : '未启用'}</strong></div>
            <div style={detailInfoRowStyle}><span>站点 ID</span><strong>{site.id}</strong></div>
          </div>
        </section>
      </section>
    </div>
  )
}

function DetailCloseButton({ onClose }) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="关闭详情"
      title="关闭"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      style={{
        ...detailCloseStyle,
        ...(hovered ? detailCloseHoverStyle : null),
      }}
    >
      <ClosePanelIcon size={14} />
    </button>
  )
}

const detailOverlayStyle = {
  position: 'relative',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  padding: 0,
  boxSizing: 'border-box',
  background: 'transparent',
  overflow: 'visible',
}

const detailPanelStyle = {
  position: 'relative',
  width: '100%',
  maxWidth: 1040,
  minWidth: 0,
  borderRadius: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  boxShadow: 'none',
  padding: '8px 0 40px',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 28,
}

const detailCloseStyle = {
  position: 'absolute',
  top: 10,
  right: 0,
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-primary)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
  lineHeight: 1,
  outline: 'none',
  transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
}

const detailCloseHoverStyle = {
  background: 'var(--bg-tertiary)',
  borderColor: 'color-mix(in srgb, var(--text-muted) 55%, var(--border))',
  color: 'var(--text-primary)',
}

const detailHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  paddingRight: 40,
}

const detailHeaderCopyStyle = {
  minWidth: 0,
  display: 'grid',
  gap: 8,
}

const detailTitleStyle = {
  margin: 0,
  fontSize: 'var(--font-size-display)',
  lineHeight: 1.15,
  fontWeight: 820,
}

const detailSubtitleStyle = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 'var(--font-size-body)',
  lineHeight: 1.5,
}

const detailHeroStyle = {
  position: 'relative',
  minHeight: 260,
  borderRadius: 18,
  border: '1px solid color-mix(in srgb, var(--accent) 20%, var(--border))',
  background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, var(--bg-secondary)), color-mix(in srgb, #c7b8ff 28%, var(--bg-secondary)))',
  boxShadow: 'none',
  overflow: 'hidden',
  padding: '36px 54px',
  boxSizing: 'border-box',
}

const detailHeroChatStyle = {
  height: '100%',
  minHeight: 190,
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: 22,
}

const detailHeroUserBubbleStyle = {
  alignSelf: 'flex-end',
  maxWidth: '48%',
  display: 'flex',
  flexDirection: 'row-reverse',
  alignItems: 'flex-start',
  gap: 8,
  padding: '12px 15px',
  borderRadius: '14px 14px 4px 14px',
  border: '1px solid var(--border)',
  background: 'color-mix(in srgb, var(--bg-secondary) 94%, transparent)',
  boxShadow: 'none',
  fontSize: 'var(--font-size-body)',
  lineHeight: 1.55,
  boxSizing: 'border-box',
  overflowWrap: 'break-word',
}

const detailHeroAssistantBubbleStyle = {
  alignSelf: 'flex-start',
  maxWidth: '54%',
  display: 'flex',
  gap: 10,
  padding: '14px 16px',
  borderRadius: '14px 14px 14px 4px',
  border: '1px solid color-mix(in srgb, var(--accent) 26%, var(--border))',
  background: 'color-mix(in srgb, var(--bg-secondary) 88%, var(--accent) 8%)',
  boxShadow: 'none',
  fontSize: 'var(--font-size-body)',
  lineHeight: 1.62,
  whiteSpace: 'pre-wrap',
  boxSizing: 'border-box',
  overflowWrap: 'break-word',
}

const detailDescriptionStyle = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: 'var(--font-size-body)',
  lineHeight: 1.75,
}

const detailSectionStyle = {
  display: 'grid',
  gap: 12,
}

const detailSectionTitleStyle = {
  margin: 0,
  fontSize: 'var(--font-size-subtitle)',
  lineHeight: 1.3,
  fontWeight: 780,
}

const detailScenarioGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 12,
}

const detailScenarioCardStyle = {
  minWidth: 0,
  border: '1px solid var(--border)',
  borderRadius: 12,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  padding: '13px 14px',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  display: 'grid',
  gap: 7,
  boxShadow: 'none',
}

const detailScenarioTitleStyle = {
  fontSize: 'var(--font-size-body)',
  fontWeight: 780,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const detailScenarioPromptStyle = {
  minHeight: 38,
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.55,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
}

const detailScenarioUseStyle = {
  color: 'var(--accent)',
  fontSize: 12,
  fontWeight: 720,
}

const detailToolGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
}

const detailToolCardStyle = {
  minWidth: 0,
  display: 'grid',
  gap: 7,
  padding: '12px 13px',
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--bg-primary)',
}

const detailToolNameStyle = {
  minWidth: 0,
  display: 'block',
  color: 'var(--accent)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  fontWeight: 760,
  lineHeight: 1.35,
  overflowWrap: 'anywhere',
}

const detailToolDescriptionStyle = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.55,
  overflowWrap: 'break-word',
}

const detailInfoTableStyle = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  overflow: 'hidden',
  background: 'var(--bg-primary)',
}

const detailInfoRowStyle = {
  display: 'grid',
  gridTemplateColumns: '160px minmax(0, 1fr)',
  gap: 18,
  padding: '14px 16px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  fontSize: 13,
}

const speakerChipStyle = {
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 850,
  color: 'var(--text-secondary)',
}
