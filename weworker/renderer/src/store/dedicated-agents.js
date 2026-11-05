import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { fetchAgents } from '../api/dedicated-agents-api.js'
import { useWorksStore } from './works.js'
import { useScheduledTasksStore } from './scheduled-tasks.js'
import { useToolPackagePageStore } from './tool-package-page.js'
import { useExplorationPageStore } from './exploration-page.js'
import { useWebsiteExplorationStore, leaveWebsiteExploration } from './website-exploration.js'

const DRAFT_FIELDS = [
  'id', 'draftKey', 'name', 'description', 'site_id', 'siteId', 'skill_name', 'examples',
  'skillMode', 'goal', 'knowledge', 'skillName', 'skillMarkdown', 'existingSkill',
  'examplesText', 'savedSkillName', 'skillScope', 'accessMode', 'channel', 'wizardStep',
  'pairing_code', 'paired',
]
const persistDraft = (agent) => ({
  ...Object.fromEntries(DRAFT_FIELDS.filter((field) => agent[field] !== undefined).map((field) => [field, agent[field]])),
  draft: true,
})
const matchesDraft = (agent, key) => agent.draft && (agent.draftKey === key || agent.id === key)
const emptyStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const defaultStorage = () => { try { return globalThis.localStorage || emptyStorage } catch { return emptyStorage } }

/** view: 'list' (empty state / intro), 'create' (wizard) or 'detail' (selectedId). */
export const createDedicatedAgentsStore = ({ storage = defaultStorage(), fetchAgentList = fetchAgents } = {}) => create(persist((set) => ({
  open: false,
  view: 'list',
  selectedId: null,
  agents: [],
  draftAgentId: null,
  loaded: false,
  loadError: '',

  openPage: () => set({ open: true }),
  closePage: () => set({ open: false }),
  startCreate: () => set((state) => {
    const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const draft = {
      id,
      draftKey: id,
      draft: true,
      name: '新建WeWorker Bot',
      description: '',
      site_id: '',
      skill_name: '',
      examples: [],
      enabled: true,
      paired: false,
      connection: { status: 'stopped' },
      wecom: { bot_id: '', has_secret: false },
    }
    return { agents: [...state.agents, draft], view: 'create', selectedId: id, draftAgentId: id }
  }),
  selectAgent: (id) => set((state) => {
    const selected = id ? state.agents.find((agent) => agent.id === id) : null
    return { view: selected?.draft ? 'create' : (id ? 'detail' : 'list'), selectedId: id || null, draftAgentId: selected?.draft ? id : null }
  }),

  /** Keep the in-progress wizard visible without persisting a partial backend record. */
  updateDraftAgent: (patch, draftKey) => set((state) => {
    const draft = state.agents.find((agent) => matchesDraft(agent, draftKey || state.draftAgentId))
    if (!draft) return {}
    const nextId = patch?.id || draft.id
    return {
      agents: state.agents.map((entry) => entry.id === draft.id
        ? { ...entry, ...patch, id: nextId, draftKey: entry.draftKey || entry.id, draft: true }
        : entry),
      draftAgentId: state.draftAgentId === draft.id ? nextId : state.draftAgentId,
      selectedId: state.selectedId === draft.id ? nextId : state.selectedId,
    }
  }),

  cancelCreate: () => set({
    draftAgentId: null,
    view: 'list',
    selectedId: null,
  }),

  /** Replace the temporary row once the wizard has completed pairing. */
  completeCreate: (agent, draftKey) => set((state) => {
    const draft = state.agents.find((entry) => matchesDraft(entry, draftKey || state.draftAgentId))
    if (!agent?.id || !draft) return {}
    const active = state.selectedId === draft.id
    return {
      agents: state.agents.filter((entry) => entry.id !== draft.id && entry.id !== agent.id).concat({ ...agent, draft: false }),
      ...(active ? { draftAgentId: null, view: 'detail', selectedId: agent.id } : {}),
    }
  }),

  loadAgents: async () => {
    try {
      const agents = await fetchAgentList()
      set((state) => {
        const drafts = state.agents.filter((agent) => agent.draft)
        const draftIds = new Set(drafts.map((agent) => agent.id))
        return { agents: [...agents.filter((agent) => !draftIds.has(agent.id)), ...drafts], loaded: true, loadError: '' }
      })
      return agents
    } catch (error) {
      set({ loaded: true, loadError: error.message || '加载失败' })
      return null
    }
  },

  upsertAgent: (agent) => set((state) => {
    if (!agent?.id) return {}
    const exists = state.agents.some((entry) => entry.id === agent.id)
    return {
      agents: exists
        ? state.agents.map((entry) => (entry.id === agent.id ? { ...entry, ...agent, draft: entry.draft || agent.draft } : entry))
        : [...state.agents, agent],
    }
  }),

  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter((entry) => entry.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
    view: state.selectedId === id ? 'list' : state.view,
    draftAgentId: state.draftAgentId === id ? null : state.draftAgentId,
  })),
}), {
  name: 'weworker-dedicated-agent-drafts',
  version: 1,
  storage: createJSONStorage(() => storage),
  partialize: (state) => ({ agents: state.agents.filter((agent) => agent.draft).map(persistDraft) }),
  merge: (saved, current) => ({ ...current, agents: (Array.isArray(saved?.agents) ? saved.agents : [])
    .filter((agent) => agent?.draft && typeof agent.id === 'string')
    .map((agent) => persistDraft({ ...agent, draftKey: agent.draftKey || agent.id })) }),
}))

export const useDedicatedAgentsStore = createDedicatedAgentsStore()

/** Close every other main view and show the WeWorker Bot page. */
export async function showDedicatedAgentsPage() {
  if (!await leaveWebsiteExploration()) return false
  useToolPackagePageStore.getState().closePage()
  useExplorationPageStore.getState().closePage()
  useWorksStore.setState({ activeWorkId: null })
  useScheduledTasksStore.setState({ activeTaskId: null })
  useDedicatedAgentsStore.getState().openPage()
  return true
}

// Opening any other main view closes the WeWorker Bot page, so existing
// navigation handlers do not need to know about it.
const closeWhen = (opened) => {
  if (opened && useDedicatedAgentsStore.getState().open) useDedicatedAgentsStore.getState().closePage()
}
useWorksStore.subscribe((state, previous) => {
  if (state.activeWorkId && state.activeWorkId !== previous.activeWorkId) closeWhen(true)
})
useScheduledTasksStore.subscribe((state, previous) => {
  if (state.activeTaskId && state.activeTaskId !== previous.activeTaskId) closeWhen(true)
})
useToolPackagePageStore.subscribe((state, previous) => closeWhen(state.open && !previous.open))
useExplorationPageStore.subscribe((state, previous) => closeWhen(state.open && !previous.open))
useWebsiteExplorationStore.subscribe((state, previous) => closeWhen(state.open && !previous.open))
