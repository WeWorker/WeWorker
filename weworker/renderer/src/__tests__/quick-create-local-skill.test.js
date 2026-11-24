import assert from 'node:assert/strict'
import test from 'node:test'
import { createTemplateSkillLocal } from '../components/dedicated-agents/quick-create/local-skill.js'

test('quick-create passes only template Skill data to the dedicated IPC', async t => {
  let received
  globalThis.window = { electronAPI: {
    createTemplateSkillLocal: async payload => {
      received = payload
      return { ok: true, name: payload.name, scope: 'private' }
    },
  } }
  t.after(() => { delete globalThis.window })

  const result = await createTemplateSkillLocal('invoice-self-check-helper', 'invoice-self-check-helper-2', 'fixture markdown')
  assert.deepEqual(received, {
    templateId: 'invoice-self-check-helper',
    name: 'invoice-self-check-helper-2',
    markdown: 'fixture markdown',
  })
  assert.deepEqual(result, { name: 'invoice-self-check-helper-2', scope: 'private' })
})

test('quick-create preserves local writer errors for duplicate retry', async t => {
  globalThis.window = { electronAPI: {
    createTemplateSkillLocal: async () => ({ ok: false, code: 'SKILL_EXISTS', detail: 'Skill「fixture」已存在，请换一个名称' }),
  } }
  t.after(() => { delete globalThis.window })

  await assert.rejects(
    createTemplateSkillLocal('invoice-self-check-helper', 'invoice-self-check-helper', 'fixture'),
    /已存在/,
  )
})

test('quick-create fails clearly when the temporary IPC is unavailable', async t => {
  globalThis.window = { electronAPI: {} }
  t.after(() => { delete globalThis.window })
  await assert.rejects(
    createTemplateSkillLocal('invoice-self-check-helper', 'invoice-self-check-helper', 'fixture'),
    /不支持内置模板 Skill 本地创建/,
  )
})
