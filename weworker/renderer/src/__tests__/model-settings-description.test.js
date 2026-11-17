import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MODEL_SETTINGS_DESCRIPTION } from '../config/model-settings-text.js'

test('public builds keep the regular model settings tip', () => {
  assert.equal(MODEL_SETTINGS_DESCRIPTION, '选择模型并管理连接配置。')
})

test('the model page keeps the original settings description', () => {
  const source = readFileSync(new URL('../components/settings/SettingsModal.jsx', import.meta.url), 'utf8')
  assert.match(source, /model: '选择模型并管理连接配置。'/)
})
