import { create } from 'zustand'

export const WORKSPACE_TAB_SKILLS = 'skills'
export const WORKSPACE_TAB_SCENARIOS = 'scenarios'
export const WORKSPACE_TAB_ADAPTERS = 'adapters'
export const ADAPTER_WORKSPACE_TITLE = 'Adapter、Skill 与场景'

export const WORKSPACE_TABS = [
  { id: WORKSPACE_TAB_ADAPTERS, label: 'Adapter' },
  { id: WORKSPACE_TAB_SKILLS, label: 'Skills' },
  { id: WORKSPACE_TAB_SCENARIOS, label: '场景' },
]

function normalizeWorkspaceTab(tab) {
  return WORKSPACE_TABS.some(({ id }) => id === tab) ? tab : WORKSPACE_TAB_ADAPTERS
}

function normalizeSiteIds(siteIds, fallbackSiteId = '') {
  const ids = Array.isArray(siteIds)
    ? siteIds.filter(Boolean)
    : (siteIds ? [siteIds] : [])
  if (ids.length > 0) return [...new Set(ids)]
  return fallbackSiteId ? [fallbackSiteId] : []
}

export const useToolPackagePageStore = create((set) => ({
  open: false,
  openSessionId: 0,
  workspaceTab: WORKSPACE_TAB_ADAPTERS,
  selectedSiteIds: [],
  scenarioSiteIds: [],
  selectedPublicSkillName: '',
  openPage: (siteId, options = {}) => set((state) => {
    const normalizedSiteId = typeof siteId === 'string' && siteId ? siteId : ''
    const nextSiteIds = normalizedSiteId
      ? [normalizedSiteId]
      : state.selectedSiteIds
    const nextScenarioSiteIds = normalizedSiteId
      ? [normalizedSiteId]
      : (state.scenarioSiteIds.length > 0 ? [state.scenarioSiteIds[0]] : state.selectedSiteIds.slice(0, 1))
    return {
      open: true,
      openSessionId: state.openSessionId + 1,
      workspaceTab: normalizeWorkspaceTab(options.workspaceTab || (options.publicSkillName || normalizedSiteId
        ? WORKSPACE_TAB_SKILLS
        : WORKSPACE_TAB_ADAPTERS)),
      selectedPublicSkillName: options.publicSkillName || '',
      selectedSiteIds: nextSiteIds,
      scenarioSiteIds: nextScenarioSiteIds,
    }
  }),
  closePage: () => set({ open: false }),
  setSelectedSiteIds: (siteIds) => set({
    selectedSiteIds: normalizeSiteIds(siteIds),
  }),
  toggleSelectedSiteId: (siteId) => set((state) => {
    const current = normalizeSiteIds(state.selectedSiteIds)
    if (!siteId) return state
    if (current.includes(siteId)) {
      if (current.length <= 1) return state
      return { selectedSiteIds: current.filter((id) => id !== siteId) }
    }
    return { selectedSiteIds: [...current, siteId] }
  }),
  setSelectedSiteId: (siteId) => set({
    selectedSiteIds: siteId ? [siteId] : [],
  }),
  setScenarioSiteIds: (siteIds) => set({
    scenarioSiteIds: normalizeSiteIds(siteIds).slice(0, 1),
  }),
  toggleScenarioSiteId: (siteId) => set((state) => {
    if (!siteId) return state
    if (state.scenarioSiteIds[0] === siteId) return state
    return { scenarioSiteIds: [siteId] }
  }),
}))
