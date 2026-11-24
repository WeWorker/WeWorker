import React, { useMemo } from 'react'
import { useSitesStore } from '../../store/sites.js'
import { useToolPackagePageStore } from '../../store/tool-package-page.js'
import { normalizeSiteScenarios } from '../../utils/site-scenarios.js'
import RenderErrorBoundary from '../common/RenderErrorBoundary.jsx'
import ToolPackageEditor from './ToolPackageEditor.jsx'
import { showConfirm } from '../../store/dialog.js'

const UNSAVED_SCENARIO_MESSAGE = '当前场景有未保存修改，切换后将丢失，是否继续？'
const EMPTY_SITE = { id: '', name: '', tools: [], scenarios: [] }

function mergeScenariosForSites(selectedSites) {
  const items = []
  for (const site of selectedSites) {
    normalizeSiteScenarios(site).forEach((scenario, index) => {
      items.push({
        ...scenario,
        _toolPackageSiteId: site.id,
        _toolPackageSiteName: site.name,
        _toolPackageKey: `${site.id}:${scenario.id || scenario.title || `scenario-${index}`}`,
      })
    })
  }
  return items
}

export default function ToolPackagePage({ onClose }) {
  const sites = useSitesStore((s) => s.sites)
  const loadSites = useSitesStore((s) => s.load)
  const selectedSiteIds = useToolPackagePageStore((s) => s.selectedSiteIds)
  const setSelectedSiteIds = useToolPackagePageStore((s) => s.setSelectedSiteIds)
  const scenarioSiteIds = useToolPackagePageStore((s) => s.scenarioSiteIds)
  const setScenarioSiteIds = useToolPackagePageStore((s) => s.setScenarioSiteIds)
  const [editorDirty, setEditorDirty] = React.useState(false)

  React.useEffect(() => {
    if (sites.length === 0) loadSites()
  }, [loadSites, sites.length])

  const editableSites = useMemo(() => (
    sites.filter((site) => site.enabled && site.visible && (site.tools?.length || site.scenarios?.length))
  ), [sites])

  React.useEffect(() => {
    if (editableSites.length === 0) return
    const validIds = new Set(editableSites.map((site) => site.id))
    const current = selectedSiteIds.filter((id) => validIds.has(id))
    if (current.length > 0) {
      if (current.length !== selectedSiteIds.length) setSelectedSiteIds(current)
      return
    }
    setSelectedSiteIds([editableSites[0].id])
  }, [editableSites, selectedSiteIds, setSelectedSiteIds])

  React.useEffect(() => {
    if (editableSites.length === 0) return
    const validIds = new Set(editableSites.map((site) => site.id))
    const current = scenarioSiteIds.filter((id) => validIds.has(id))
    if (current.length > 0) {
      const next = [current[0]]
      if (current.length !== 1 || current.length !== scenarioSiteIds.length || scenarioSiteIds[0] !== next[0]) {
        setScenarioSiteIds(next)
      }
      return
    }
    setScenarioSiteIds([editableSites[0].id])
  }, [editableSites, scenarioSiteIds, setScenarioSiteIds])

  const skillSites = useMemo(() => {
    const idSet = new Set(selectedSiteIds)
    return editableSites.filter((site) => idSet.has(site.id))
  }, [editableSites, selectedSiteIds])

  const scenarioSites = useMemo(() => {
    const idSet = new Set(scenarioSiteIds)
    return editableSites.filter((site) => idSet.has(site.id))
  }, [editableSites, scenarioSiteIds])

  const primarySite = skillSites[0] || editableSites[0] || EMPTY_SITE
  const scenarios = useMemo(
    () => mergeScenariosForSites(scenarioSites.length > 0 ? scenarioSites : (editableSites[0] ? [editableSites[0]] : [])),
    [scenarioSites, editableSites],
  )

  const confirmDiscardChanges = async () => !editorDirty || await showConfirm(UNSAVED_SCENARIO_MESSAGE, '未保存的修改')

  const handleToggleScenarioSite = async (siteId) => {
    if (!await confirmDiscardChanges()) return
    setEditorDirty(false)
    setScenarioSiteIds(siteId ? [siteId] : [])
  }

  return (
    <div style={pageStyle}>
      <RenderErrorBoundary onClose={onClose}>
        <div style={pageBodyStyle}>
          <ToolPackageEditor
          site={primarySite}
          sites={skillSites}
          allSites={editableSites}
          editableSites={editableSites}
          scenarioSiteIds={scenarioSiteIds}
          onToggleScenarioSiteId={handleToggleScenarioSite}
          scenarios={scenarios}
          onReloadSites={loadSites}
          onDirtyChange={setEditorDirty}
        />
        </div>
      </RenderErrorBoundary>
    </div>
  )
}

const pageBodyStyle = {
  flex: 1,
  minHeight: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const pageStyle = {
  flex: 1,
  overflow: 'hidden',
  padding: 0,
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  background: 'var(--bg-secondary)',
  display: 'flex',
  flexDirection: 'column',
}
