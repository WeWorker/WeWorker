import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(testDir, '..')
const backendRoot = path.resolve(testDir, '../../../backend-ts')
const appSource = fs.readFileSync(path.join(sourceRoot, 'App.jsx'), 'utf8')
const storeSource = fs.readFileSync(path.join(sourceRoot, 'store/dedicated-agents.js'), 'utf8')
const composerSource = fs.readFileSync(path.join(sourceRoot, 'components/dedicated-agents/SkillComposer.jsx'), 'utf8')
const toolsSource = fs.readFileSync(path.join(backendRoot, 'src/tools.ts'), 'utf8')
const skillUpdatesSource = fs.readFileSync(path.join(backendRoot, 'src/dedicated-agents/skill-updates.ts'), 'utf8')
const runtimeSource = fs.readFileSync(path.join(backendRoot, 'src/dedicated-agents/agent-runtime.ts'), 'utf8')

test('conversation skill updates reach the renderer through the event store', () => {
  // Backend broadcasts the rewrite; App.jsx routes it into the store.
  assert.match(skillUpdatesSource, /type: 'agent_skill_updated'/)
  assert.match(toolsSource, /broadcastSSE\(outcome\.event\)/)
  assert.match(appSource, /parsed\.type === 'agent_skill_updated'/)
  assert.match(appSource, /useDedicatedAgentsStore\.getState\(\)\.handleSkillUpdated\(parsed\)/)
  assert.match(storeSource, /handleSkillUpdated: \(event\)/)
  assert.match(storeSource, /skillUpdates/)
})

test('the open skill editor reloads clean content and warns on dirty content', () => {
  // Subscribes to the per-skill update event with a seq counter.
  assert.match(composerSource, /s\.skillUpdates\[skillName\]/)
  assert.match(composerSource, /updateSeq/)
  // Clean editor: silently load the rewritten content.
  assert.match(composerSource, /applied: true/)
  // Dirty editor: warn about the overwrite and offer to load the latest.
  assert.match(composerSource, /保存会覆盖对话中的更新/)
  assert.match(composerSource, /载入最新内容/)
  // The last update (conversation or desktop) is visible below the skill tag.
  assert.match(composerSource, /最近更新/)
  assert.match(composerSource, /对话中更新/)
})

test('the dedicated agent runtime allows and guides the update tool', () => {
  assert.match(runtimeSource, /mcp__weworker__update_agent_skill/)
  assert.match(runtimeSource, /mcp__weworker__update_agent_skill 更新对应 Skill/)
})
