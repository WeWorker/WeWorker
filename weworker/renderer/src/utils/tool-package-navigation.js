export const TOOL_PACKAGE_LIST_PAGE = 'list'
export const TOOL_PACKAGE_EDITOR_PAGE = 'editor'

export function createToolPackageNavigationState(workspaceTab = 'skills') {
  return { workspaceTab, page: TOOL_PACKAGE_LIST_PAGE }
}

export function toolPackageNavigationReducer(state, action) {
  switch (action.type) {
    case 'open-editor':
      return {
        workspaceTab: action.workspaceTab || state.workspaceTab,
        page: TOOL_PACKAGE_EDITOR_PAGE,
      }
    case 'back-to-list':
      return state.page === TOOL_PACKAGE_LIST_PAGE
        ? state
        : { ...state, page: TOOL_PACKAGE_LIST_PAGE }
    case 'switch-tab':
      return action.workspaceTab === state.workspaceTab && state.page === TOOL_PACKAGE_LIST_PAGE
        ? state
        : createToolPackageNavigationState(action.workspaceTab)
    default:
      return state
  }
}
