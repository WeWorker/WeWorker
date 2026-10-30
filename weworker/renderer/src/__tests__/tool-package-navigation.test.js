import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_PACKAGE_EDITOR_PAGE,
  TOOL_PACKAGE_LIST_PAGE,
  createToolPackageNavigationState,
  toolPackageNavigationReducer,
} from '../utils/tool-package-navigation.js'

test('opening an item enters its editor and returning keeps the current list', () => {
  const skills = createToolPackageNavigationState('skills')
  const skillEditor = toolPackageNavigationReducer(skills, { type: 'open-editor' })
  assert.deepEqual(skillEditor, { workspaceTab: 'skills', page: TOOL_PACKAGE_EDITOR_PAGE })

  const skillList = toolPackageNavigationReducer(skillEditor, { type: 'back-to-list' })
  assert.deepEqual(skillList, { workspaceTab: 'skills', page: TOOL_PACKAGE_LIST_PAGE })

  const scenarios = toolPackageNavigationReducer(skillList, { type: 'switch-tab', workspaceTab: 'scenarios' })
  assert.deepEqual(scenarios, { workspaceTab: 'scenarios', page: TOOL_PACKAGE_LIST_PAGE })

  const scenarioEditor = toolPackageNavigationReducer(scenarios, { type: 'open-editor' })
  assert.deepEqual(scenarioEditor, { workspaceTab: 'scenarios', page: TOOL_PACKAGE_EDITOR_PAGE })
  assert.deepEqual(toolPackageNavigationReducer(scenarioEditor, { type: 'back-to-list' }), scenarios)
})

test('switching lists from an editor returns to list mode', () => {
  const skillEditor = { workspaceTab: 'skills', page: TOOL_PACKAGE_EDITOR_PAGE }
  assert.deepEqual(
    toolPackageNavigationReducer(skillEditor, { type: 'switch-tab', workspaceTab: 'scenarios' }),
    { workspaceTab: 'scenarios', page: TOOL_PACKAGE_LIST_PAGE },
  )
})
