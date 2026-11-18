import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MODEL_SETTINGS_DESCRIPTION, MODEL_SETTINGS_DESCRIPTION_DANGER } from '../config/model-settings-text.js'

test('public builds keep the regular model settings tip', () => {
  assert.equal(MODEL_SETTINGS_DESCRIPTION, '选择模型并管理连接配置。')
  assert.equal(MODEL_SETTINGS_DESCRIPTION_DANGER, false)
})

test('the model page renders the shared description instead of a hard-coded copy', () => {
  const source = readFileSync(new URL('../components/settings/SettingsModal.jsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ MODEL_SETTINGS_DESCRIPTION, MODEL_SETTINGS_DESCRIPTION_DANGER \} from '\.\.\/\.\.\/config\/model-settings-text\.js'/)
  assert.match(source, /model: MODEL_SETTINGS_DESCRIPTION,/)
  assert.doesNotMatch(source, /model: '选择模型并管理连接配置。'/)
})

test('the danger tone only applies to the model page when the build enables it', () => {
  const source = readFileSync(new URL('../components/settings/SettingsModal.jsx', import.meta.url), 'utf8')
  assert.match(source, /tab === 'model' && MODEL_SETTINGS_DESCRIPTION_DANGER/)
  const css = readFileSync(new URL('../workspace-refresh.css', import.meta.url), 'utf8')
  assert.match(css, /\.settings-page-description--danger \{ color: var\(--error\); \}/)
})
