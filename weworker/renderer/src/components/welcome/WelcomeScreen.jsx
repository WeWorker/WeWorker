import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSitesStore } from '../../store/sites.js'
import { useSettingsStore } from '../../store/settings.js'
import { useCapabilitiesPanelStore } from '../../store/capabilities-panel.js'
import { useUserFilesStore } from '../../store/user-files.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useWorksStore } from '../../store/works.js'
import { useScheduledTasksStore } from '../../store/scheduled-tasks.js'
import SiteIcon from '../icons/SiteIcon.jsx'
import PromptRichText from '../prompt/PromptRichText.jsx'
import EditablePromptTemplate from '../prompt/EditablePromptTemplate.jsx'
import SiteDetailModal from './SiteDetailModal.jsx'
import Tooltip from '../Tooltip.jsx'
import AnimatedCollapse from '../common/AnimatedCollapse.jsx'
import { normalizeSiteScenarios, getScenarioPromptText } from '../../utils/site-scenarios.js'
import { buildPromptFromTemplate, hasPromptTemplateVars } from '../../utils/prompt-template.js'
import { getSiteDragId, hasSiteDragData, setSiteDragData } from '../../utils/site-drag.js'
import FeaturedSiteActions from './FeaturedSiteActions.jsx'
import { ClosePanelIcon, EyeIcon, EyeOffIcon, FourSquaresIcon, ListIcon, RobotIcon, TrialChatIcon } from './WelcomeIcons.jsx'
import { AppstoreAddOutlined } from '@ant-design/icons'
import {
  ADD_FEATURED_DROP_TARGET,
  CONVERSATION_EXAMPLE_VISIBLE_KEY,
  DEFAULT_WELCOME_FEATURED_SITE_LIMIT,
  FEATURED_ORDER_KEY,
  FEATURED_SQUARE_CARDS_KEY,
  FEATURED_VISIBLE_COUNT_KEY,
  assistantText,
  clampText,
  fallbackScenarios,
  filterScenarios,
  getFeaturedSiteAvailability,
  getHiddenFeaturedSites,
  readFeaturedOrder,
  readFeaturedSquareCards,
  readFeaturedVisibleCount,
  readConversationExampleVisible,
  userPromptTemplate,
} from './welcome-utils.js'
import { FEATURED_GRID_COLUMN_GAP, useWelcomeResponsiveLayout } from './welcome-responsive.js'

const FEATURED_LAYOUT_TRANSITION_MS = 180
const SHOWCASE_TOGGLE_TRANSITION_MS = 220
const FLOATING_PICKER_GAP = 6
const FLOATING_PICKER_MARGIN = 14
const FLOATING_PICKER_SEARCH_HEIGHT = 20
const FLOATING_PICKER_HEADER_PADDING_Y = 6
const FLOATING_PICKER_CHROME_HEIGHT = FLOATING_PICKER_HEADER_PADDING_Y * 2 + FLOATING_PICKER_SEARCH_HEIGHT
const FLOATING_PICKER_MIN_LIST_HEIGHT = 48
const FEATURED_PICKER_MIN_WIDTH = 260
const FLOATING_PICKER_TRANSITION_MS = 150
const WELCOME_CONTENT_MAX_WIDTH = 800

function featuredAdaptivePickerFrameStyle(placement) {
  const width = placement?.pickerWidth ?? FEATURED_PICKER_MIN_WIDTH
  return {
    left: placement?.pickerLeft ?? 0,
    minWidth: width,
    width,
  }
}

function TypingLines({ text }) {
  const content = String(text || '')
  const [visibleChars, setVisibleChars] = useState(0)

  useEffect(() => {
    setVisibleChars(0)
    if (content.length === 0) return undefined
    const timer = window.setInterval(() => {
      setVisibleChars((current) => {
        if (current >= content.length) {
          window.clearInterval(timer)
          return current
        }
        return current + 1
      })
    }, 22)
    return () => window.clearInterval(timer)
  }, [content])

  const shown = content.slice(0, visibleChars)
  const active = visibleChars > 0 && visibleChars < content.length
  return (
    <span style={typingTextStyle}>
      {shown}
      {active && <span style={caretStyle} />}
    </span>
  )
}

function scenarioPickerTemplateSource(scenario) {
  return userPromptTemplate(scenario) || scenario.summary || ''
}

function scenarioPickerHint(scenario) {
  const promptText = scenarioPickerTemplateSource(scenario)
  return clampText(String(promptText).replace(/\s+/g, ' ').trim(), 72)
}

function ScenarioPickerListItem({
  scenario,
  site,
  index,
  itemKey,
  isHovered,
  isExpanded,
  promptValues,
  onPromptValueChange,
  onHover,
  onFill,
  onToggleExpand,
}) {
  const promptTemplate = userPromptTemplate(scenario)
  const templateSource = scenarioPickerTemplateSource(scenario)
  const promptText = promptTemplate || scenario.summary || scenario.title
  const hintText = scenarioPickerHint(scenario)
  const hasTemplateVars = hasPromptTemplateVars(templateSource)

  return (
    <div className="scenario-picker-item">
      <div
        className={`scenario-picker-item-row${isHovered ? ' is-hovered' : ''}`}
        onMouseEnter={() => onHover(itemKey)}
        onMouseLeave={() => onHover(null)}
      >
        <span className="scenario-picker-item-fill-wrap">
          <Tooltip text="在对话中使用" light placement="top" delay={300}>
            <button
              type="button"
              className="scenario-picker-item-fill"
              aria-label="在对话中使用"
              onClick={(event) => {
                event.stopPropagation()
                onFill()
              }}
            >
              <TrialChatIcon size={18} />
            </button>
          </Tooltip>
        </span>
        <button
          type="button"
          className="scenario-picker-item-main"
          onFocus={() => onHover(itemKey)}
          onBlur={() => onHover(null)}
          onClick={(event) => {
            event.stopPropagation()
            onToggleExpand()
          }}
        >
          <span className="scenario-picker-item-index" aria-hidden="true">{index + 1}</span>
          <span className="scenario-picker-item-body">
            <span className="scenario-picker-item-title">{scenario.title}</span>
            {hasTemplateVars && templateSource ? (
              <span className="scenario-picker-item-hint">
                <PromptRichText
                  text={templateSource}
                  varDisplay={site.promptVarDisplay || {}}
                  valueOverrides={promptValues}
                  style={{ whiteSpace: 'nowrap' }}
                />
              </span>
            ) : hintText ? (
              <span className="scenario-picker-item-hint">{hintText}</span>
            ) : (
              <span className="scenario-picker-item-hint">未配置提示词</span>
            )}
          </span>
        </button>
        <button
          type="button"
          className={`scenario-picker-item-expand${isExpanded ? ' is-expanded' : ''}`}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? '收起提示词' : '展开提示词'}
          onClick={(event) => {
            event.stopPropagation()
            onToggleExpand()
          }}
        >
          ▾
        </button>
      </div>
      <AnimatedCollapse open={isExpanded} duration={170} unmountOnExit>
        <div
          className="scenario-picker-item-detail scenario-picker-item-detail-panel"
          tabIndex={0}
          title="双击在对话中使用"
          onDoubleClick={(event) => {
            event.stopPropagation()
            if (event.target?.closest?.('input, textarea, button, select, [contenteditable="true"]')) return
            onFill()
          }}
          onFocus={() => onHover(itemKey)}
          onBlur={() => onHover(null)}
          onMouseEnter={() => onHover(itemKey)}
          onMouseLeave={() => onHover(null)}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="scenario-picker-item-detail-hint" aria-hidden="true">
            双击在对话中使用
          </div>
          {!promptText ? (
            '未配置提示词'
          ) : hasTemplateVars ? (
            <EditablePromptTemplate
              text={templateSource}
              varDisplay={site.promptVarDisplay || {}}
              values={promptValues}
              onChange={onPromptValueChange}
              editMode="pencil"
            />
          ) : (
            <PromptRichText text={promptText} varDisplay={site.promptVarDisplay || {}} />
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

export default function WelcomeScreen({ onFillInput }) {
  const sites = useSitesStore((s) => s.sites)
  const loadSites = useSitesStore((s) => s.load)
  const toggleSiteVisibility = useSitesStore((s) => s.toggleVisibility)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const welcomeFeaturedSiteLimit = useSettingsStore((s) => s.welcomeFeaturedSiteLimit)
  const capabilitiesPanelOpen = useCapabilitiesPanelStore((s) => s.open)
  const openCapabilitiesPanel = useCapabilitiesPanelStore((s) => s.openPanel)
  const closeCapabilitiesPanel = useCapabilitiesPanelStore((s) => s.closePanel)
  const closeUserFilesPanel = useUserFilesStore((s) => s.closePanel)
  const openToolPackagePage = useToolPackagePageStore((s) => s.openPage)
  const sectionRef = useRef(null)
  const welcomeScrollRef = useRef(null)
  const featuredGridRef = useRef(null)
  const featuredLayoutRefs = useRef(new Map())
  const previousFeaturedLayoutRects = useRef(new Map())
  const suppressFeaturedCardClickRef = useRef(false)
  const featuredCardPointerRef = useRef(null)
  const lastFeaturedCardToggleRef = useRef({ siteId: null, at: 0 })
  const { showShowcase } = useWelcomeResponsiveLayout(sectionRef)
  const [featuredSquareCards, setFeaturedSquareCards] = useState(readFeaturedSquareCards)
  const [activeIndex, setActiveIndex] = useState(0)
  const [hoveredSiteId, setHoveredSiteId] = useState(null)
  const [selectedFeaturedSiteId, setSelectedFeaturedSiteId] = useState(null)
  const [scenarioPickerSiteId, setScenarioPickerSiteId] = useState(null)
  const [detailRow, setDetailRow] = useState(null)
  const [featuredOrder, setFeaturedOrder] = useState(readFeaturedOrder)
  const [featuredVisibleCount, setFeaturedVisibleCount] = useState(readFeaturedVisibleCount)
  const [draggingSiteId, setDraggingSiteId] = useState(null)
  const [isDraggingSiteFromPanel, setIsDraggingSiteFromPanel] = useState(false)
  const [dragOverSiteId, setDragOverSiteId] = useState(null)
  const [addPickerOpen, setAddPickerOpen] = useState(false)
  const [addTriggerHovered, setAddTriggerHovered] = useState(false)
  const [hoveredAddSiteId, setHoveredAddSiteId] = useState(null)
  const [hoveredScenarioKey, setHoveredScenarioKey] = useState(null)
  const [addPickerQuery, setAddPickerQuery] = useState('')
  const [scenarioPickerQuery, setScenarioPickerQuery] = useState('')
  const [expandedScenarioPickerKey, setExpandedScenarioPickerKey] = useState(null)
  const [scenarioPromptValues, setScenarioPromptValues] = useState({})
  const [hoveredFeaturedAction, setHoveredFeaturedAction] = useState(null)
  const [skillsScenariosPickerSiteId, setSkillsScenariosPickerSiteId] = useState(null)
  const [showConversationExample, setShowConversationExample] = useState(readConversationExampleVisible)
  const [floatingPickerPlacement, setFloatingPickerPlacement] = useState({
    side: 'above',
    maxHeight: FLOATING_PICKER_CHROME_HEIGHT + FLOATING_PICKER_MIN_LIST_HEIGHT,
    maxListHeight: FLOATING_PICKER_MIN_LIST_HEIGHT,
    pickerLeft: 0,
    pickerWidth: FEATURED_PICKER_MIN_WIDTH,
  })
  const [mountedFloatingPickerKey, setMountedFloatingPickerKey] = useState('')
  const [floatingPickerClosing, setFloatingPickerClosing] = useState(false)
  const [featuredGridLayoutEpoch, setFeaturedGridLayoutEpoch] = useState(0)
  const bumpFeaturedGridLayout = useCallback(() => {
    setFeaturedGridLayoutEpoch((current) => current + 1)
  }, [])

  useEffect(() => {
    if (sites.length === 0) loadSites()
  }, [])

  useEffect(() => {
    if (!settingsLoaded) loadSettings()
  }, [settingsLoaded, loadSettings])

  useEffect(() => {
    if (!scenarioPickerSiteId && !addPickerOpen && !skillsScenariosPickerSiteId) return undefined
    const handlePointerDown = (event) => {
      if (event.target?.closest?.('[data-welcome-picker]')) return
      if (event.target?.closest?.('[data-featured-site-item]')) return
      setScenarioPickerSiteId(null)
      setAddPickerOpen(false)
      setSkillsScenariosPickerSiteId(null)
      setSelectedFeaturedSiteId(null)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [scenarioPickerSiteId, addPickerOpen, skillsScenariosPickerSiteId])

  useEffect(() => {
    setScenarioPickerSiteId(null)
    setSkillsScenariosPickerSiteId(null)
    setHoveredFeaturedAction(null)
    setSelectedFeaturedSiteId(null)
  }, [featuredSquareCards])

  useLayoutEffect(() => {
    const grid = featuredGridRef.current
    if (!grid || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(bumpFeaturedGridLayout)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [featuredSquareCards, bumpFeaturedGridLayout])

  useEffect(() => {
    window.addEventListener('resize', bumpFeaturedGridLayout)
    return () => window.removeEventListener('resize', bumpFeaturedGridLayout)
  }, [bumpFeaturedGridLayout])

  const enabledRows = useMemo(() => {
    return sites
      .filter((site) => site.enabled)
      .map((site) => {
        const scenarios = normalizeSiteScenarios(site)
        const visibleScenarios = scenarios.length ? scenarios : fallbackScenarios(site)
        return { site, scenarios: visibleScenarios }
      })
      .filter((row) => row.scenarios.length > 0)
  }, [sites])

  const rows = useMemo(() => enabledRows.filter(({ site }) => site.visible), [enabledRows])

  const showcaseItems = useMemo(() => {
    return rows.flatMap(({ site, scenarios }) =>
      scenarios.map((scenario) => ({ site, scenario, prompt: getScenarioPromptText(site, scenario) }))
    ).slice(0, 6)
  }, [rows])

  const orderedEnabledRows = useMemo(() => {
    const byId = new Map(enabledRows.map((row) => [row.site.id, row]))
    const ordered = featuredOrder.map((id) => byId.get(id)).filter(Boolean)
    const orderedIds = new Set(ordered.map((row) => row.site.id))
    return [...ordered, ...enabledRows.filter((row) => !orderedIds.has(row.site.id))]
  }, [enabledRows, featuredOrder])

  const orderedRows = useMemo(() => orderedEnabledRows.filter(({ site }) => site.visible), [orderedEnabledRows])
  const hiddenWelcomeSites = useMemo(() => orderedEnabledRows.filter(({ site }) => !site.visible), [orderedEnabledRows])

  const featuredSiteLimit = Math.max(1, Number(welcomeFeaturedSiteLimit) || DEFAULT_WELCOME_FEATURED_SITE_LIMIT)
  const maxVisibleFeaturedCount = Math.min(featuredSiteLimit, orderedEnabledRows.length)
  const visibleFeaturedCount = Math.min(
    Math.max(0, featuredVisibleCount),
    maxVisibleFeaturedCount,
    orderedRows.length,
  )
  const featuredSites = orderedRows.slice(0, visibleFeaturedCount)
  const hiddenFeaturedSites = getHiddenFeaturedSites({
    visibleSites: orderedRows,
    enabledSites: hiddenWelcomeSites,
    visibleCount: visibleFeaturedCount,
  })
  const featuredAvailability = getFeaturedSiteAvailability({
    siteLimit: featuredSiteLimit,
    visibleCount: visibleFeaturedCount,
    availableCount: hiddenFeaturedSites.length,
  })
  const featuredSiteLimitReached = featuredAvailability.limitReached
  const canAddFeaturedSite = featuredAvailability.canAdd
  const allAvailableFeaturedSitesShown = hiddenFeaturedSites.length === 0
  const addFeaturedLimitTitle = featuredSiteLimitReached
    ? `已达上限 ${featuredSiteLimit} 个，可在设置 → 配置中调整「欢迎页常用场景网站上限」`
    : (allAvailableFeaturedSitesShown ? '已添加全部可用网站' : undefined)
  const featuredLayoutSignature = `${featuredSquareCards ? 'grid' : 'list'}:${featuredSites.map(({ site }) => site.id).join('|')}:${canAddFeaturedSite ? 'add' : 'no-add'}`
  const filteredHiddenFeaturedSites = useMemo(() => {
    const query = addPickerQuery.trim().toLowerCase()
    if (!query) return hiddenFeaturedSites
    return hiddenFeaturedSites.filter(({ site, scenarios }) => {
      const haystack = [
        site.name,
        site.description,
        ...scenarios.flatMap((scenario) => [
          scenario.title,
          scenario.summary,
          ...(scenario.prompts || []).map((prompt) => prompt?.text || ''),
        ]),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [hiddenFeaturedSites, addPickerQuery])
  const activeFloatingPickerKey = scenarioPickerSiteId
    ? `scenario:${scenarioPickerSiteId}`
    : (addPickerOpen ? 'add' : '')
  const mountedScenarioPickerSiteId = mountedFloatingPickerKey.startsWith('scenario:')
    ? mountedFloatingPickerKey.slice('scenario:'.length)
    : null
  const mountedAddPickerOpen = mountedFloatingPickerKey === 'add'

  useEffect(() => {
    if (activeIndex >= showcaseItems.length) setActiveIndex(0)
  }, [activeIndex, showcaseItems.length])

  useEffect(() => {
    if (activeFloatingPickerKey) {
      setMountedFloatingPickerKey(activeFloatingPickerKey)
      setFloatingPickerClosing(false)
      return undefined
    }

    if (!mountedFloatingPickerKey) return undefined

    setFloatingPickerClosing(true)
    const timer = window.setTimeout(() => {
      setMountedFloatingPickerKey('')
      setFloatingPickerClosing(false)
    }, FLOATING_PICKER_TRANSITION_MS)
    return () => window.clearTimeout(timer)
  }, [activeFloatingPickerKey, mountedFloatingPickerKey])

  useEffect(() => {
    if (!scenarioPickerSiteId) {
      setScenarioPickerQuery('')
      setHoveredScenarioKey(null)
      setExpandedScenarioPickerKey(null)
      setSelectedFeaturedSiteId(null)
      return
    }
    if (!featuredSites.some(({ site }) => site.id === scenarioPickerSiteId)) {
      setScenarioPickerSiteId(null)
      setScenarioPickerQuery('')
      setHoveredScenarioKey(null)
      setSelectedFeaturedSiteId(null)
    }
  }, [featuredSites, scenarioPickerSiteId])

  useLayoutEffect(() => {
    if (!activeFloatingPickerKey) return undefined

    const updatePlacement = () => {
      const anchorId = scenarioPickerSiteId || ADD_FEATURED_DROP_TARGET
      const anchor = featuredLayoutRefs.current.get(anchorId)
      if (!anchor) return

      const anchorRect = anchor.getBoundingClientRect()
      const sectionRect = sectionRef.current?.getBoundingClientRect()
      const scrollRect = welcomeScrollRef.current?.getBoundingClientRect()
      const chatDockRect = document.querySelector('[data-chat-bottom-dock]')?.getBoundingClientRect()
      const topLimit = Math.max(
        FLOATING_PICKER_MARGIN,
        scrollRect?.top ?? sectionRect?.top ?? FLOATING_PICKER_MARGIN,
      )
      const bottomLimit = chatDockRect
        ? chatDockRect.top - FLOATING_PICKER_MARGIN
        : Math.min(
          window.innerHeight - FLOATING_PICKER_MARGIN,
          sectionRect?.bottom ?? window.innerHeight - FLOATING_PICKER_MARGIN,
        )
      const spaceAbove = Math.max(0, anchorRect.top - topLimit - FLOATING_PICKER_GAP)
      const spaceBelow = Math.max(0, bottomLimit - anchorRect.bottom - FLOATING_PICKER_GAP)
      const side = spaceBelow >= spaceAbove ? 'below' : 'above'
      const available = side === 'below' ? spaceBelow : spaceAbove
      const maxListHeight = Math.max(
        FLOATING_PICKER_MIN_LIST_HEIGHT,
        available - FLOATING_PICKER_CHROME_HEIGHT,
      )
      const maxHeight = maxListHeight + FLOATING_PICKER_CHROME_HEIGHT

      let pickerLeft = 0
      let pickerWidth = FEATURED_PICKER_MIN_WIDTH
      const horizontalBounds = sectionRect || scrollRect
      if (horizontalBounds) {
        const availableWidth = Math.max(0, horizontalBounds.width)
        pickerWidth = Math.max(FEATURED_PICKER_MIN_WIDTH, Math.min(availableWidth, WELCOME_CONTENT_MAX_WIDTH))
        let absoluteLeft = anchorRect.left
        const minLeft = horizontalBounds.left
        const maxLeft = horizontalBounds.right - pickerWidth
        absoluteLeft = Math.min(Math.max(absoluteLeft, minLeft), maxLeft)
        pickerLeft = absoluteLeft - anchorRect.left
      }

      setFloatingPickerPlacement((current) => (
        current.side === side
          && current.maxHeight === maxHeight
          && current.maxListHeight === maxListHeight
          && current.pickerLeft === pickerLeft
          && current.pickerWidth === pickerWidth
          ? current
          : { side, maxHeight, maxListHeight, pickerLeft, pickerWidth }
      ))
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    const scrollNode = welcomeScrollRef.current
    const resizeObserver = scrollNode && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updatePlacement)
      : null
    resizeObserver?.observe(scrollNode)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
      resizeObserver?.disconnect()
    }
  }, [activeFloatingPickerKey, scenarioPickerSiteId, showConversationExample])

  const active = showcaseItems[activeIndex]

  const bindFeaturedLayoutNode = (layoutId) => (node) => {
    if (node) featuredLayoutRefs.current.set(layoutId, node)
    else featuredLayoutRefs.current.delete(layoutId)
  }

  useLayoutEffect(() => {
    const gridRect = featuredGridRef.current?.getBoundingClientRect()
    const nextRects = new Map()
    const animations = []
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const [layoutId, node] of featuredLayoutRefs.current.entries()) {
      if (!node?.isConnected) continue
      const rawNextRect = node.getBoundingClientRect()
      const nextRect = {
        left: gridRect ? rawNextRect.left - gridRect.left : rawNextRect.left,
        top: gridRect ? rawNextRect.top - gridRect.top : rawNextRect.top,
        width: rawNextRect.width,
        height: rawNextRect.height,
      }
      const previousRect = previousFeaturedLayoutRects.current.get(layoutId)
      nextRects.set(layoutId, nextRect)

      if (reduceMotion) continue

      if (!previousRect) {
        animations.push(node.animate(
          [
            { opacity: 0 },
            { opacity: 1 },
          ],
          { duration: 170, easing: 'ease-out' },
        ))
        continue
      }

      const deltaX = previousRect.left - nextRect.left
      const deltaY = previousRect.top - nextRect.top
      const moved = Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1
      const resized = Math.abs(previousRect.width - nextRect.width) > 1 || Math.abs(previousRect.height - nextRect.height) > 1
      if (!moved && !resized) continue

      animations.push(node.animate(
        [
          { opacity: 0.65 },
          { opacity: 1 },
        ],
        { duration: FEATURED_LAYOUT_TRANSITION_MS, easing: 'ease-out' },
      ))
    }
    previousFeaturedLayoutRects.current = nextRects
    return () => animations.forEach((animation) => animation.cancel())
  }, [featuredLayoutSignature])

  useEffect(() => {
    if (!detailRow) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setDetailRow(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [detailRow])

  const fillScenario = (item) => {
    if (item?.prompt) {
      onFillInput?.(item.prompt)
    }
  }

  const updateScenarioPromptValue = (scenarioKey, slotKey, value) => {
    setScenarioPromptValues((current) => ({
      ...current,
      [scenarioKey]: {
        ...(current[scenarioKey] || {}),
        [slotKey]: value,
      },
    }))
  }

  const buildScenarioPickerPrompt = (site, scenario, scenarioKey) => {
    const templateSource = scenarioPickerTemplateSource(scenario)
    const slotValues = scenarioPromptValues[scenarioKey] || {}
    const varDisplay = site.promptVarDisplay || {}
    if (templateSource?.trim() && hasPromptTemplateVars(templateSource)) {
      return buildPromptFromTemplate(templateSource, slotValues, varDisplay).trim()
    }
    const promptTemplate = userPromptTemplate(scenario)
    if (promptTemplate?.trim()) {
      return buildPromptFromTemplate(promptTemplate, slotValues, varDisplay).trim()
    }
    return getScenarioPromptText(site, scenario)
  }

  const focusSitePreview = (siteId) => {
    const nextIndex = showcaseItems.findIndex((candidate) => candidate.site.id === siteId)
    if (nextIndex >= 0) setActiveIndex(nextIndex)
  }

  const openSiteDetail = (site, scenarios) => {
    focusSitePreview(site.id)
    setScenarioPickerSiteId(null)
    setSelectedFeaturedSiteId(null)
    setDetailRow({ site, scenarios })
  }

  const handleOpenAllScenarios = () => {
    if (capabilitiesPanelOpen) {
      closeCapabilitiesPanel()
      return
    }
    closeUserFilesPanel()
    openCapabilitiesPanel('list')
  }

  const handleOpenSiteSkillsOrScenarios = (siteId, workspaceTab) => {
    setScenarioPickerSiteId(null)
    setAddPickerOpen(false)
    setSkillsScenariosPickerSiteId(null)
    setSelectedFeaturedSiteId(null)
    closeUserFilesPanel()
    closeCapabilitiesPanel()
    useWorksStore.setState({ activeWorkId: null })
    useScheduledTasksStore.setState({ activeTaskId: null })
    openToolPackagePage(siteId, { workspaceTab })
  }

  const toggleSkillsScenariosPicker = (siteId) => {
    setScenarioPickerSiteId(null)
    setSelectedFeaturedSiteId(null)
    setAddPickerOpen(false)
    setSkillsScenariosPickerSiteId((current) => (current === siteId ? null : siteId))
  }

  const toggleFeaturedSquareCards = () => {
    setFeaturedSquareCards((current) => {
      const next = !current
      try {
        window.localStorage.setItem(FEATURED_SQUARE_CARDS_KEY, String(next))
      } catch {
        // localStorage may be unavailable in restricted environments.
      }
      return next
    })
  }

  const openScenarioPicker = (siteId) => {
    focusSitePreview(siteId)
    setAddPickerOpen(false)
    setScenarioPickerQuery('')
    setHoveredScenarioKey(null)
    setScenarioPickerSiteId((current) => {
      if (current === siteId) {
        setSelectedFeaturedSiteId(null)
        return null
      }
      setSelectedFeaturedSiteId(siteId)
      return siteId
    })
  }

  const toggleFeaturedCardPicker = (siteId) => {
    focusSitePreview(siteId)
    setAddPickerOpen(false)
    setScenarioPickerQuery('')
    setHoveredScenarioKey(null)
    setScenarioPickerSiteId((current) => {
      if (current === siteId) {
        setSelectedFeaturedSiteId(null)
        return null
      }
      setSelectedFeaturedSiteId(siteId)
      return siteId
    })
  }

  const handleFeaturedCardPointerDown = (event, siteId) => {
    if (event.target?.closest?.('[data-featured-action]')) return
    featuredCardPointerRef.current = {
      siteId,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    }
    focusSitePreview(siteId)
  }

  const handleFeaturedCardPointerUp = (event, siteId) => {
    if (event.target?.closest?.('[data-featured-action]')) return
    const pending = featuredCardPointerRef.current
    featuredCardPointerRef.current = null
    if (!pending || pending.siteId !== siteId || pending.dragging) return
    const dx = event.clientX - pending.x
    const dy = event.clientY - pending.y
    if ((dx * dx + dy * dy) > 36) return
    event.preventDefault()
    event.stopPropagation()
    const now = Date.now()
    const last = lastFeaturedCardToggleRef.current
    if (last.siteId === siteId && now - last.at < 260) return
    lastFeaturedCardToggleRef.current = { siteId, at: now }
    toggleFeaturedCardPicker(siteId)
  }

  const handleFeaturedCardClick = (event) => {
    if (suppressFeaturedCardClickRef.current) {
      suppressFeaturedCardClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
  }

  const featuredActionProps = (site, scenarios, isHovered, isPicking) => ({
    site,
    scenarios,
    isHovered,
    isPicking,
    hoveredFeaturedAction,
    setHoveredFeaturedAction,
    skillsScenariosPickerSiteId,
    toggleSkillsScenariosPicker,
    handleOpenSiteSkillsOrScenarios,
    openSiteDetail,
    removeFeaturedSite,
    openScenarioPicker,
    gridLayoutEpoch: featuredGridLayoutEpoch,
  })

  const persistFeaturedOrder = (ids) => {
    setFeaturedOrder(ids)
    try {
      window.localStorage.setItem(FEATURED_ORDER_KEY, JSON.stringify(ids))
    } catch {
      // localStorage may be unavailable in restricted environments.
    }
  }

  const persistFeaturedVisibleCount = (count) => {
    setFeaturedVisibleCount(count)
    try {
      window.localStorage.setItem(FEATURED_VISIBLE_COUNT_KEY, String(count))
    } catch {
      // localStorage may be unavailable in restricted environments.
    }
  }

  const toggleConversationExample = () => {
    setShowConversationExample((visible) => {
      const next = !visible
      try {
        window.localStorage.setItem(CONVERSATION_EXAMPLE_VISIBLE_KEY, String(next))
      } catch {
        // localStorage may be unavailable in restricted environments.
      }
      return next
    })
  }

  const moveFeaturedSite = (sourceId, targetId) => {
    if (!sourceId || !targetId || sourceId === targetId) return
    const ids = orderedRows.map((row) => row.site.id)
    const sourceIndex = ids.indexOf(sourceId)
    const targetIndex = ids.indexOf(targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const next = [...ids]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved)
    persistFeaturedOrder(next)
  }

  const insertFeaturedSiteBefore = (sourceId, targetId) => {
    if (!sourceId || !targetId || sourceId === targetId) return
    const ids = orderedRows.map((row) => row.site.id)
    const sourceIndex = ids.indexOf(sourceId)
    const targetIndex = ids.indexOf(targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const wasVisible = sourceIndex < visibleFeaturedCount
    const next = [...ids]
    const [moved] = next.splice(sourceIndex, 1)
    const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
    next.splice(adjustedTargetIndex, 0, moved)
    persistFeaturedOrder(next)
    if (!wasVisible) {
      persistFeaturedVisibleCount(Math.min(maxVisibleFeaturedCount, visibleFeaturedCount + 1))
    }
    focusSitePreview(sourceId)
    setSelectedFeaturedSiteId(sourceId)
  }

  const insertFeaturedSiteAtVisibleEnd = (sourceId) => {
    if (!sourceId) return
    const ids = orderedRows.map((row) => row.site.id)
    const sourceIndex = ids.indexOf(sourceId)
    if (sourceIndex < 0) return
    const wasVisible = sourceIndex < visibleFeaturedCount
    const next = [...ids]
    const [moved] = next.splice(sourceIndex, 1)
    const insertIndex = wasVisible ? Math.max(0, visibleFeaturedCount - 1) : visibleFeaturedCount
    next.splice(Math.min(insertIndex, next.length), 0, moved)
    persistFeaturedOrder(next)
    if (!wasVisible) {
      persistFeaturedVisibleCount(Math.min(maxVisibleFeaturedCount, visibleFeaturedCount + 1))
    }
    focusSitePreview(sourceId)
    setSelectedFeaturedSiteId(sourceId)
  }

  const handleAddFeaturedSite = () => {
    setScenarioPickerSiteId(null)
    setSelectedFeaturedSiteId(null)
    setAddPickerOpen((open) => !open)
  }

  const selectFeaturedSite = async (siteId) => {
    const selectedRow = hiddenFeaturedSites.find(({ site }) => site.id === siteId)
    if (!selectedRow) return
    if (!selectedRow.site.visible) {
      await toggleSiteVisibility(siteId)
      const site = useSitesStore.getState().sites.find((item) => item.id === siteId)
      if (!site?.visible) return
    }

    const ids = orderedEnabledRows.map((row) => row.site.id)
    const sourceIndex = ids.indexOf(siteId)
    if (sourceIndex < 0) return
    const next = [...ids]
    const [selected] = next.splice(sourceIndex, 1)
    next.splice(visibleFeaturedCount, 0, selected)
    const nextCount = featuredAvailability.nextVisibleCount
    persistFeaturedOrder(next)
    persistFeaturedVisibleCount(nextCount)
    focusSitePreview(siteId)
    setSelectedFeaturedSiteId(siteId)
    setAddPickerOpen(false)
    setAddPickerQuery('')
  }

  const removeFeaturedSite = (siteId) => {
    const ids = orderedRows.map((row) => row.site.id)
    const index = ids.indexOf(siteId)
    if (index < 0) return
    const next = [...ids]
    const [removed] = next.splice(index, 1)
    next.splice(Math.max(0, visibleFeaturedCount - 1), 0, removed)
    persistFeaturedOrder(next)
    persistFeaturedVisibleCount(Math.max(0, visibleFeaturedCount - 1))
    setScenarioPickerSiteId((current) => (current === siteId ? null : current))
    setHoveredSiteId((current) => (current === siteId ? null : current))
    setSelectedFeaturedSiteId((current) => (current === siteId ? null : current))
  }

  if (detailRow) {
    return (
      <div ref={welcomeScrollRef} data-welcome-scroll style={welcomeScrollStyle}>
        <SiteDetailModal
          site={detailRow.site}
          scenarios={detailRow.scenarios}
          onClose={() => setDetailRow(null)}
          onUseScenario={(scenario, editedPrompt) => {
            const item = {
              site: detailRow.site,
              scenario,
              prompt: editedPrompt || getScenarioPromptText(detailRow.site, scenario),
            }
            fillScenario(item)
            setDetailRow(null)
          }}
        />
      </div>
    )
  }

  return (
    <div ref={welcomeScrollRef} data-welcome-scroll style={welcomeScrollStyle}>
      <section ref={sectionRef} style={welcomeSectionStyle}>
        <header className="welcome-introduction" style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, fontWeight: 760, marginBottom: 6 }}>WeWorker</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 15, margin: 0 }}>
            像聊天一样操作网站，选择一个场景就能开始。
          </p>
        </header>

        {showShowcase && (
        <div
          style={{
            ...showcaseStyle,
            ...(showConversationExample ? showcaseVisibleStyle : showcaseHiddenStyle),
          }}
          aria-hidden={!showConversationExample}
        >
          {showConversationExample && active ? (
            <>
              <div style={scenarioBadgeStyle}>
                <SiteIcon site={active.site} size={24} />
                <span style={scenarioBadgeSiteStyle}>{active.site.name}</span>
                <span style={scenarioBadgeTitleStyle}>{active.scenario.title}</span>
              </div>

              <div style={conversationStyle}>
                <div style={userBubbleStyle}>
                  <span style={speakerChipStyle}>用户</span>
                  {userPromptTemplate(active.scenario) ? (
                    <PromptRichText
                      text={userPromptTemplate(active.scenario)}
                      varDisplay={active.site.promptVarDisplay || {}}
                      style={{ minWidth: 0, overflowWrap: 'anywhere' }}
                    />
                  ) : (
                    <span>{clampText(active.prompt, 110)}</span>
                  )}
                </div>
                <div style={assistantBubbleStyle}>
                  <RobotIcon />
                  <TypingLines text={assistantText(active.site, active.scenario)} />
                </div>
              </div>

              <button data-app-button="action" type="button" onClick={() => fillScenario(active)} style={tryButtonStyle}>
                在对话中使用
              </button>

              <div style={dotsStyle}>
                {showcaseItems.map((item, index) => (
                  <button
                    key={`${item.site.id}-${item.scenario.id || item.scenario.title}-${index}`}
                    type="button"
                    aria-label={`切换到 ${item.site.name} ${item.scenario.title}`}
                    onClick={() => setActiveIndex(index)}
                    style={{
                      ...dotStyle,
                      background: index === activeIndex ? 'var(--text-primary)' : 'color-mix(in srgb, var(--text-muted) 50%, transparent)',
                      transform: index === activeIndex ? 'scale(1.12)' : 'scale(1)',
                    }}
                  />
                ))}
              </div>
            </>
          ) : showConversationExample ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>暂无可展示场景，请先在设置中启用网站。</div>
          ) : null}
        </div>
        )}

        <div className="welcome-featured-toolbar" style={featuredHeaderStyle}>
          <div style={featuredHeaderTitleRowStyle}>
            <span>常用场景</span>
            <button
              type="button"
              onClick={toggleFeaturedSquareCards}
              style={featuredViewToggleStyle}
              title={featuredSquareCards ? '切换为列表显示' : '切换为卡片显示'}
              aria-label={featuredSquareCards ? '切换为列表显示' : '切换为卡片显示'}
              aria-pressed={featuredSquareCards}
            >
              {featuredSquareCards ? <ListIcon size={14} /> : <FourSquaresIcon size={14} />}
            </button>
          </div>
          <div style={featuredHeaderActionsStyle}>
            <button type="button" onClick={handleOpenAllScenarios} style={{ ...allScenariosButtonStyle, borderRadius: 8 }}>
              {capabilitiesPanelOpen ? <ClosePanelIcon /> : <ListIcon />}
              {capabilitiesPanelOpen ? '关闭所有场景' : '查看所有场景'}
            </button>
            {showShowcase && (
              <button
                type="button"
                onClick={toggleConversationExample}
                style={allScenariosButtonStyle}
              >
                {showConversationExample ? <EyeOffIcon /> : <EyeIcon />}
                {showConversationExample ? '隐藏对话示例' : '展示对话示例'}
              </button>
            )}
          </div>
        </div>

        <div
          ref={featuredGridRef}
          data-featured-grid=""
          style={featuredSquareCards ? featuredSquareGridStyle : featuredGridStyle}
        >
          {featuredSites.map(({ site, scenarios }) => {
            const isHovered = hoveredSiteId === site.id
            const isSelected = selectedFeaturedSiteId === site.id
            const isPicking = scenarioPickerSiteId === site.id
            const isScenarioPickerMounted = mountedScenarioPickerSiteId === site.id
            const isScenarioPickerClosing = floatingPickerClosing && isScenarioPickerMounted
            const showCardActions = isSelected || isPicking || skillsScenariosPickerSiteId === site.id
            const isCardFocused = isSelected || isPicking || isScenarioPickerMounted || skillsScenariosPickerSiteId === site.id
            const isDropTarget = (draggingSiteId || isDraggingSiteFromPanel) && draggingSiteId !== site.id && dragOverSiteId === site.id
            const filteredScenarios = filterScenarios(scenarios, scenarioPickerQuery)
            const actionProps = featuredActionProps(site, scenarios, isSelected || isHovered, isPicking)
            return (
              <div
                key={site.id}
                ref={bindFeaturedLayoutNode(site.id)}
                style={{
                  ...featuredSiteWrapStyle,
                  ...(isSelected || isPicking || isScenarioPickerMounted || skillsScenariosPickerSiteId === site.id ? featuredSiteWrapActiveStyle : null),
                }}
                draggable
                onDragStart={(e) => {
                  suppressFeaturedCardClickRef.current = true
                  if (featuredCardPointerRef.current?.siteId === site.id) {
                    featuredCardPointerRef.current.dragging = true
                  }
                  setSelectedFeaturedSiteId(site.id)
                  setDraggingSiteId(site.id)
                  setIsDraggingSiteFromPanel(false)
                  setSiteDragData(e.dataTransfer, site.id)
                }}
                onDragOver={(e) => {
                  const canDropSite = (draggingSiteId && draggingSiteId !== site.id) || hasSiteDragData(e.dataTransfer)
                  if (canDropSite) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setIsDraggingSiteFromPanel(!draggingSiteId && hasSiteDragData(e.dataTransfer))
                    setDragOverSiteId(site.id)
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    setDragOverSiteId((current) => (current === site.id ? null : current))
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const sourceId = getSiteDragId(e.dataTransfer) || draggingSiteId
                  insertFeaturedSiteBefore(sourceId, site.id)
                  setDraggingSiteId(null)
                  setIsDraggingSiteFromPanel(false)
                  setDragOverSiteId(null)
                }}
                onDragEnd={() => {
                  setDraggingSiteId(null)
                  setIsDraggingSiteFromPanel(false)
                  setDragOverSiteId(null)
                  setSelectedFeaturedSiteId(null)
                  featuredCardPointerRef.current = null
                  window.setTimeout(() => {
                    suppressFeaturedCardClickRef.current = false
                  }, 0)
                }}
              >
                {featuredSquareCards ? (
                  <div style={featuredSquareCardUnitStyle}>
                    <div
                      data-featured-site-item
                      className={`featured-site-card featured-site-card--square${isCardFocused ? ' is-focused' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
                      role="button"
                      tabIndex={0}
                      style={{
                        ...featuredSquareCardStyle,
                        ...featuredCardFocusStyle({
                          active: isCardFocused,
                          hovered: isHovered,
                          dropTarget: isDropTarget,
                          square: true,
                        }),
                        opacity: draggingSiteId === site.id ? 0.56 : 1,
                        cursor: 'default',
                      }}
                      onPointerDown={(e) => handleFeaturedCardPointerDown(e, site.id)}
                      onPointerUp={(e) => handleFeaturedCardPointerUp(e, site.id)}
                      onClick={handleFeaturedCardClick}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openScenarioPicker(site.id)
                        }
                      }}
                      onMouseEnter={() => {
                        setHoveredSiteId(site.id)
                        focusSitePreview(site.id)
                      }}
                      onPointerEnter={() => {
                        setHoveredSiteId(site.id)
                        focusSitePreview(site.id)
                      }}
                      onMouseLeave={() => {
                        if (skillsScenariosPickerSiteId === site.id) return
                        setHoveredSiteId((current) => (current === site.id ? null : current))
                      }}
                      onPointerLeave={() => {
                        if (skillsScenariosPickerSiteId === site.id) return
                        setHoveredSiteId((current) => (current === site.id ? null : current))
                      }}
                    >
                      <span style={featuredSquareCardIconStyle} data-featured-card-icon>
                        <SiteIcon site={site} size={34} />
                      </span>
                      <span style={featuredSquareCardTitleStyle} data-featured-card-title>{site.name}</span>
                      <FeaturedSiteActions
                        {...actionProps}
                        layout="column"
                        compact
                        showActions={showCardActions}
                      />
                    </div>
                  </div>
                ) : (
                  <div
                    data-featured-site-item
                    className={`featured-site-card featured-site-card--list${isCardFocused ? ' is-focused' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
                    role="button"
                    tabIndex={0}
                    onPointerDown={(e) => handleFeaturedCardPointerDown(e, site.id)}
                    onPointerUp={(e) => handleFeaturedCardPointerUp(e, site.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openScenarioPicker(site.id)
                      }
                    }}
                    onMouseEnter={() => {
                      setHoveredSiteId(site.id)
                      focusSitePreview(site.id)
                    }}
                    onPointerEnter={() => {
                      setHoveredSiteId(site.id)
                      focusSitePreview(site.id)
                    }}
                    onMouseLeave={() => {
                      if (skillsScenariosPickerSiteId === site.id) return
                      setHoveredSiteId((current) => (current === site.id ? null : current))
                    }}
                    onPointerLeave={() => {
                      if (skillsScenariosPickerSiteId === site.id) return
                      setHoveredSiteId((current) => (current === site.id ? null : current))
                    }}
                    style={{
                      ...featuredItemStyle,
                      justifyContent: 'flex-start',
                      ...featuredCardFocusStyle({
                        active: isCardFocused,
                        hovered: isHovered,
                        dropTarget: isDropTarget,
                        square: false,
                      }),
                      opacity: draggingSiteId === site.id ? 0.56 : 1,
                      cursor: 'default',
                    }}
                    onClick={handleFeaturedCardClick}
                  >
                    <span style={featuredIconStyle} data-featured-card-icon><SiteIcon site={site} size={34} /></span>
                    <span style={featuredCopyStyle} data-featured-card-title>
                      <span style={featuredTitleStyle}>{site.name}</span>
                      <span style={featuredSummaryStyle}>{clampText(site.description, 42)}</span>
                    </span>
                    <FeaturedSiteActions {...actionProps} layout="row" showActions={showCardActions} />
                  </div>
                )}

                {isDropTarget && (
                  <span style={featuredSquareCards ? dropInsertIndicatorCardStyle : dropInsertIndicatorStyle} />
                )}

                {isScenarioPickerMounted && (
                  <div
                    data-welcome-picker
                    className={isScenarioPickerClosing ? 'motion-popover-exit' : 'motion-popover-enter'}
                    style={{
                      ...floatingPickerStyle(floatingPickerPlacement, featuredAdaptivePickerFrameStyle(floatingPickerPlacement)),
                      pointerEvents: isScenarioPickerClosing ? 'none' : 'auto',
                    }}
                  >
                    <div style={pickerHeaderRowStyle}>
                      <div style={pickerSearchWrapStyle}>
                        <input
                          type="search"
                          value={scenarioPickerQuery}
                          onChange={(e) => setScenarioPickerQuery(e.target.value)}
                          placeholder="搜索场景或提示词..."
                          aria-label="搜索场景或提示词"
                          style={pickerSearchInputStyle}
                        />
                      </div>
                    </div>
                    <div style={addPickerListShellStyle}>
                      <div
                        className="scrollbar-hover-only"
                        style={{
                        ...addPickerListScrollStyle,
                        maxHeight: floatingPickerPlacement.maxListHeight,
                      }}>
                      {filteredScenarios.map((scenario) => {
                        const scenarioItemKey = `${site.id}-${scenario.id || scenario.title}`
                        return (
                          <ScenarioPickerListItem
                            key={scenario.id || scenario.title}
                            scenario={scenario}
                            site={site}
                            index={scenarios.indexOf(scenario)}
                            itemKey={scenarioItemKey}
                            isHovered={hoveredScenarioKey === scenarioItemKey}
                            isExpanded={expandedScenarioPickerKey === scenarioItemKey}
                            promptValues={scenarioPromptValues[scenarioItemKey] || {}}
                            onPromptValueChange={(slotKey, value) => (
                              updateScenarioPromptValue(scenarioItemKey, slotKey, value)
                            )}
                            onHover={setHoveredScenarioKey}
                            onFill={() => {
                              const nextIndex = showcaseItems.findIndex((candidate) => candidate.site.id === site.id && candidate.scenario.title === scenario.title)
                              if (nextIndex >= 0) setActiveIndex(nextIndex)
                              fillScenario({
                                site,
                                scenario,
                                prompt: buildScenarioPickerPrompt(site, scenario, scenarioItemKey),
                              })
                              setScenarioPickerSiteId(null)
                              setSelectedFeaturedSiteId(null)
                              setScenarioPickerQuery('')
                              setExpandedScenarioPickerKey(null)
                            }}
                            onToggleExpand={() => {
                              setExpandedScenarioPickerKey((current) => (
                                current === scenarioItemKey ? null : scenarioItemKey
                              ))
                            }}
                          />
                        )
                      })}
                      {scenarios.length > 0 && filteredScenarios.length === 0 && (
                        <div style={pickerEmptyStyle}>没有匹配的场景</div>
                      )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {(canAddFeaturedSite || featuredSiteLimitReached || allAvailableFeaturedSitesShown) && (
            <div
              ref={bindFeaturedLayoutNode(ADD_FEATURED_DROP_TARGET)}
              style={{
                ...featuredSiteWrapStyle,
                ...(addPickerOpen || mountedAddPickerOpen ? featuredSiteWrapActiveStyle : null),
              }}
              onDragOver={(e) => {
                const canDropSite = Boolean(draggingSiteId) || hasSiteDragData(e.dataTransfer)
                if (canDropSite) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setIsDraggingSiteFromPanel(!draggingSiteId && hasSiteDragData(e.dataTransfer))
                  setDragOverSiteId(ADD_FEATURED_DROP_TARGET)
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setDragOverSiteId((current) => (current === ADD_FEATURED_DROP_TARGET ? null : current))
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                const sourceId = getSiteDragId(e.dataTransfer) || draggingSiteId
                insertFeaturedSiteAtVisibleEnd(sourceId)
                setDraggingSiteId(null)
                setIsDraggingSiteFromPanel(false)
                setDragOverSiteId(null)
              }}
            >
              {((draggingSiteId || isDraggingSiteFromPanel) && dragOverSiteId === ADD_FEATURED_DROP_TARGET) && (
                <span style={dropInsertIndicatorStyle} />
              )}
              <button
                data-welcome-picker
                type="button"
                disabled={!canAddFeaturedSite}
                title={addFeaturedLimitTitle}
                onMouseEnter={() => {
                  if (canAddFeaturedSite) setAddTriggerHovered(true)
                }}
                onMouseLeave={() => setAddTriggerHovered(false)}
                onFocus={() => {
                  if (canAddFeaturedSite) setAddTriggerHovered(true)
                }}
                onBlur={() => setAddTriggerHovered(false)}
                onClick={canAddFeaturedSite ? handleAddFeaturedSite : undefined}
                style={{
                  ...addFeaturedCardStyle,
                  ...(featuredSquareCards ? featuredSquareAddCardStyle : null),
                  justifyContent: featuredSquareCards ? 'center' : 'flex-start',
                  background: canAddFeaturedSite && (addTriggerHovered || addPickerOpen || dragOverSiteId === ADD_FEATURED_DROP_TARGET)
                    ? 'color-mix(in srgb, var(--bg-tertiary) 64%, var(--bg-primary))'
                    : (featuredSquareCards ? 'transparent' : addFeaturedCardStyle.background),
                  boxShadow: addFeaturedCardStyle.boxShadow,
                  opacity: canAddFeaturedSite ? 1 : 0.45,
                  cursor: canAddFeaturedSite ? 'pointer' : 'not-allowed',
                }}
              >
                <span
                  style={{
                    ...(featuredSquareCards ? featuredSquareAddIconStyle : addFeaturedIconStyle),
                    color: addTriggerHovered || addPickerOpen ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  <AppstoreAddOutlined aria-hidden="true" />
                </span>
                {!featuredSquareCards && (
                  <span style={addFeaturedCopyStyle}>
                    <span style={addFeaturedTitleStyle}>添加</span>
                    <span style={addFeaturedSummaryStyle}>选择一个网站加入常用场景</span>
                  </span>
                )}
              </button>

              {mountedAddPickerOpen && (
                <div
                  data-welcome-picker
                  className={floatingPickerClosing ? 'motion-popover-exit' : 'motion-popover-enter'}
                  style={{
                    ...floatingPickerStyle(floatingPickerPlacement, featuredAdaptivePickerFrameStyle(floatingPickerPlacement)),
                    pointerEvents: floatingPickerClosing ? 'none' : 'auto',
                  }}
                >
                  <div style={pickerHeaderRowStyle}>
                    <div style={pickerSearchWrapStyle}>
                      <input
                        type="search"
                        value={addPickerQuery}
                        onChange={(e) => setAddPickerQuery(e.target.value)}
                        placeholder="搜索网站或场景..."
                        aria-label="搜索网站或场景"
                        style={pickerSearchInputStyle}
                      />
                    </div>
                  </div>
                  <div style={addPickerListShellStyle}>
                    <div
                      className="scrollbar-hover-only"
                      style={{
                      ...addPickerListScrollStyle,
                      maxHeight: floatingPickerPlacement.maxListHeight,
                    }}>
                    {filteredHiddenFeaturedSites.map(({ site, scenarios }) => {
                      const isAddHovered = hoveredAddSiteId === site.id
                      return (
                        <button
                          key={site.id}
                          type="button"
                          title={site.name}
                          onMouseEnter={() => setHoveredAddSiteId(site.id)}
                          onMouseLeave={() => setHoveredAddSiteId((current) => (current === site.id ? null : current))}
                          onFocus={() => setHoveredAddSiteId(site.id)}
                          onBlur={() => setHoveredAddSiteId((current) => (current === site.id ? null : current))}
                          onClick={() => selectFeaturedSite(site.id)}
                          style={{
                            ...addPickerItemStyle,
                            background: isAddHovered ? 'var(--bg-hover)' : 'transparent',
                          }}
                        >
                          <SiteIcon site={site} size={28} />
                          <span style={addPickerItemCopyStyle}>
                            <span style={addPickerItemTitleStyle}>{site.name}</span>
                            <span style={addPickerItemSummaryStyle}>{clampText(site.description, 42)}</span>
                          </span>
                          <span style={addPickerItemCountStyle}>{scenarios.length} 场景</span>
                        </button>
                      )
                    })}
                    {filteredHiddenFeaturedSites.length === 0 && (
                      <div style={pickerEmptyStyle}>没有匹配的网站</div>
                    )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      </section>
    </div>
  )
}

const welcomeScrollStyle = {
  flex: 1,
  overflowX: 'hidden',
  overflowY: 'auto',
  padding: '24px 24px 188px',
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  background: 'var(--bg-primary)',
}

const welcomeSectionStyle = {
  width: '100%',
  maxWidth: WELCOME_CONTENT_MAX_WIDTH,
  minWidth: 0,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
}

const caretStyle = {
  display: 'inline-block',
  width: 6,
  height: 16,
  marginLeft: 2,
  background: 'var(--accent)',
  borderRadius: 1,
  verticalAlign: '-2px',
  animation: 'working-fade 0.8s ease-in-out infinite',
}

const showcaseStyle = {
  position: 'relative',
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  flexShrink: 0,
  boxSizing: 'border-box',
  borderRadius: 8,
  background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, var(--bg-secondary)), color-mix(in srgb, #c7b8ff 26%, var(--bg-secondary)))',
  overflow: 'hidden',
  display: 'block',
  transition: `height ${SHOWCASE_TOGGLE_TRANSITION_MS}ms ease, opacity ${SHOWCASE_TOGGLE_TRANSITION_MS}ms ease, padding ${SHOWCASE_TOGGLE_TRANSITION_MS}ms ease, border-color ${SHOWCASE_TOGGLE_TRANSITION_MS}ms ease, box-shadow ${SHOWCASE_TOGGLE_TRANSITION_MS}ms ease, transform ${SHOWCASE_TOGGLE_TRANSITION_MS}ms ease`,
}

const showcaseVisibleStyle = {
  height: 330,
  opacity: 1,
  padding: '36px 52px 68px',
  border: '1px solid color-mix(in srgb, var(--accent) 16%, var(--border))',
  boxShadow: 'none',
  transform: 'translateY(0)',
  pointerEvents: 'auto',
}

const showcaseHiddenStyle = {
  height: 0,
  opacity: 0,
  padding: '0 52px',
  border: '1px solid transparent',
  boxShadow: '0 0 0 rgba(0,0,0,0)',
  transform: 'translateY(-8px)',
  pointerEvents: 'none',
}

const scenarioBadgeStyle = {
  position: 'absolute',
  top: 38,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
  maxWidth: '86%',
  minHeight: 48,
  boxSizing: 'border-box',
  padding: '10px 20px 10px 12px',
  borderRadius: 16,
  border: '1px solid color-mix(in srgb, var(--border) 70%, var(--bg-secondary))',
  background: 'color-mix(in srgb, var(--bg-secondary) 92%, transparent)',
  boxShadow: 'none',
  fontSize: 16,
  lineHeight: 1.2,
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const scenarioBadgeSiteStyle = {
  flexShrink: 0,
  fontWeight: 840,
}

const scenarioBadgeTitleStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--text-secondary)',
  fontSize: 15,
  fontWeight: 680,
}

const conversationStyle = {
  position: 'absolute',
  top: 104,
  left: '50%',
  transform: 'translateX(-50%)',
  width: '94%',
  maxWidth: 920,
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

const userBubbleStyle = {
  alignSelf: 'flex-end',
  minWidth: 0,
  maxWidth: '48%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'row-reverse',
  alignItems: 'flex-start',
  gap: 8,
  padding: '11px 14px',
  borderRadius: '14px 14px 4px 14px',
  background: 'color-mix(in srgb, var(--bg-secondary) 94%, transparent)',
  border: '1px solid var(--border)',
  boxShadow: 'none',
  fontSize: 13,
  lineHeight: 1.55,
  overflowWrap: 'anywhere',
}

const assistantBubbleStyle = {
  alignSelf: 'flex-start',
  width: 'fit-content',
  minWidth: 0,
  maxWidth: '58%',
  minHeight: 72,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 9,
  padding: '12px 15px',
  borderRadius: '14px 14px 14px 4px',
  background: 'color-mix(in srgb, var(--bg-secondary) 88%, var(--accent) 8%)',
  border: 'none',
  boxShadow: 'none',
  fontSize: 13,
  lineHeight: 1.55,
  overflowWrap: 'break-word',
  overflow: 'visible',
}

const typingTextStyle = {
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  width: '100%',
  whiteSpace: 'pre-wrap',
  wordBreak: 'normal',
  overflowWrap: 'break-word',
}

const speakerChipStyle = {
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 850,
  color: 'var(--text-secondary)',
}

const tryButtonStyle = {
  position: 'absolute',
  left: '50%',
  bottom: 22,
  transform: 'translateX(-50%)',
  border: 'none',
  borderRadius: 10,
  background: 'var(--text-primary)',
  color: 'var(--bg-secondary)',
  padding: '10px 18px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 780,
  boxShadow: 'none',
  zIndex: 2,
}

const dotsStyle = {
  position: 'absolute',
  right: 18,
  top: '46%',
  transform: 'translateY(-50%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const dotStyle = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
}

const featuredHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 16,
  fontWeight: 760,
  color: 'var(--text-primary)',
}

const featuredHeaderTitleRowStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const featuredViewToggleStyle = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
}

const featuredHeaderActionsStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  flexWrap: 'wrap',
}

const allScenariosButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  border: '1px solid var(--border)',
  borderRadius: 999,
  background: 'var(--bg-secondary)',
  color: 'var(--text-secondary)',
  padding: '7px 11px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 650,
}

const featuredGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  columnGap: FEATURED_GRID_COLUMN_GAP,
  rowGap: 8,
}

const featuredSquareGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
  gap: 10,
  overflow: 'visible',
}

const featuredSquareCardUnitStyle = {
  position: 'relative',
  width: '100%',
  minWidth: 0,
  overflow: 'visible',
}

const featuredSquareCardStyle = {
  position: 'relative',
  width: '100%',
  minHeight: 96,
  aspectRatio: '1',
  borderRadius: 10,
  border: '1px solid transparent',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '8px 6px',
  boxSizing: 'border-box',
  textAlign: 'center',
  transition: 'background-color 0.16s ease, border-color 0.16s ease, opacity 0.16s ease',
}

function featuredCardFocusStyle({ active, hovered, dropTarget, square }) {
  const idleBackground = 'transparent'
  if (dropTarget) {
    return {
      background: 'color-mix(in srgb, var(--accent) 8%, var(--bg-primary))',
      borderColor: 'color-mix(in srgb, var(--accent) 46%, transparent)',
      boxShadow: 'none',
      transform: 'translateY(0)',
    }
  }
  if (active) {
    return {
      background: 'color-mix(in srgb, var(--bg-tertiary) 82%, var(--bg-primary))',
      borderColor: 'transparent',
      boxShadow: 'none',
      transform: 'translateY(0)',
    }
  }
  if (hovered) {
    return {
      background: 'color-mix(in srgb, var(--bg-tertiary) 48%, transparent)',
      borderColor: 'transparent',
      boxShadow: 'none',
      transform: 'translateY(0)',
    }
  }
  return {
    background: idleBackground,
    borderColor: 'transparent',
    boxShadow: 'none',
    transform: 'translateY(0)',
  }
}

const featuredSquareCardIconStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

const featuredSquareCardTitleStyle = {
  width: '100%',
  minWidth: 0,
  padding: '0 2px',
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1.25,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const featuredSquareAddCardStyle = {
  minHeight: 96,
  aspectRatio: '1',
  borderRadius: 10,
  border: '1px solid transparent',
  background: 'transparent',
  padding: '8px',
}

const featuredSquareAddIconStyle = {
  width: 40,
  height: 40,
  borderRadius: 12,
  border: '1px solid color-mix(in srgb, var(--border) 52%, transparent)',
  background: 'color-mix(in srgb, var(--bg-tertiary) 36%, transparent)',
  fontSize: 21,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  lineHeight: 0,
  transition: 'color 0.16s ease, background-color 0.16s ease, border-color 0.16s ease',
}

const featuredSiteWrapStyle = {
  position: 'relative',
  minWidth: 0,
  overflow: 'visible',
}

const featuredSiteWrapActiveStyle = {
  zIndex: 24,
  isolation: 'isolate',
}

const dropInsertIndicatorStyle = {
  position: 'absolute',
  left: -9,
  top: 8,
  bottom: 8,
  width: 3,
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--text-muted) 40%, transparent)',
  pointerEvents: 'none',
}

const dropInsertIndicatorCardStyle = {
  position: 'absolute',
  left: -6,
  top: 6,
  bottom: 6,
  width: 3,
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--text-muted) 40%, transparent)',
  pointerEvents: 'none',
}

const featuredItemStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 62,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: '1px solid transparent',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '8px 10px',
  boxSizing: 'border-box',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
  transition: 'background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease',
}

const addFeaturedCardStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 62,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: 'none',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--bg-secondary) 70%, transparent)',
  color: 'var(--text-secondary)',
  padding: '8px 10px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
  transition: 'background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease',
}

const addFeaturedIconStyle = {
  width: 36,
  height: 36,
  borderRadius: 11,
  border: 0,
  background: 'color-mix(in srgb, var(--bg-tertiary) 42%, transparent)',
  fontSize: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  lineHeight: 0,
  transition: 'color 0.16s ease, background-color 0.16s ease',
}

const addFeaturedCopyStyle = {
  minWidth: 0,
  display: 'grid',
  gap: 2,
}

const addFeaturedTitleStyle = {
  fontSize: 14,
  fontWeight: 780,
  color: 'var(--text-primary)',
}

const addFeaturedSummaryStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-secondary)',
  fontSize: 12,
}

const floatingPickerStyle = (placement, { left = 0, right, minWidth = 0, width } = {}) => ({
  position: 'absolute',
  left,
  ...(right !== undefined ? { right } : null),
  ...(width !== undefined ? { width } : null),
  minWidth,
  zIndex: 12,
  '--motion-origin': placement.side === 'below' ? '50% 0' : '50% 100%',
  ...(placement.side === 'below'
    ? { top: `calc(100% + ${FLOATING_PICKER_GAP}px)` }
    : { bottom: `calc(100% + ${FLOATING_PICKER_GAP}px)` }),
  border: '1px solid var(--border)',
  borderRadius: 12,
  background: 'var(--bg-secondary)',
  boxShadow: 'none',
  maxHeight: placement.maxHeight,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  overflowX: 'hidden',
})

const pickerHeaderRowStyle = {
  display: 'flex',
  alignItems: 'center',
  padding: `${FLOATING_PICKER_HEADER_PADDING_Y}px 10px`,
  background: 'var(--bg-secondary)',
  flexShrink: 0,
  minWidth: 0,
}

const pickerSearchWrapStyle = {
  flex: '1 1 0',
  minWidth: 0,
}

const pickerSearchInputStyle = {
  width: '100%',
  height: FLOATING_PICKER_SEARCH_HEIGHT,
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 6,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  outline: 'none',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: `${FLOATING_PICKER_SEARCH_HEIGHT}px`,
}

const addPickerListShellStyle = {
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'hidden',
  padding: '0 10px 6px',
  background: 'var(--bg-secondary)',
}

const addPickerListScrollStyle = {
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
  display: 'grid',
  gap: 2,
  minWidth: 0,
}

const addPickerItemStyle = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  border: 'none',
  borderRadius: 9,
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '8px 0',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
  transition: 'background 0.14s ease, box-shadow 0.14s ease',
}

const addPickerItemCopyStyle = {
  minWidth: 0,
  flex: 1,
  display: 'grid',
  gap: 2,
}

const addPickerItemTitleStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  fontWeight: 760,
}

const addPickerItemSummaryStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-secondary)',
  fontSize: 11,
}

const addPickerItemCountStyle = {
  flexShrink: 0,
  border: '1px solid var(--border)',
  borderRadius: 999,
  background: 'var(--bg-primary)',
  color: 'var(--text-muted)',
  padding: '3px 6px',
  fontSize: 11,
  lineHeight: 1,
}

const pickerEmptyStyle = {
  padding: '16px 10px',
  color: 'var(--text-muted)',
  fontSize: 12,
  textAlign: 'center',
}

const featuredIconStyle = {
  width: 42,
  height: 42,
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

const featuredCopyStyle = {
  minWidth: 0,
  flex: 1,
  display: 'grid',
  gap: 2,
}

const featuredTitleStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 14,
  fontWeight: 780,
}

const featuredSummaryStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-secondary)',
  fontSize: 12,
}

const featuredSiteStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-muted)',
  fontSize: 11,
}
