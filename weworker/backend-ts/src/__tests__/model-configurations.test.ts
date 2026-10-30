import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../config.js'
import { createModelConfiguration, getModelConfiguration, activateModelConfiguration, updateModelConfiguration, publicModelConfigurations, buildModelConfigurationNames, renameModelConfiguration, validateModelConfigurationName, deleteModelConfiguration } from '../model-configurations.js'
import { applySecrets, clearSecretsOnDisk, extractSecrets } from '../settings-secrets.js'
import { resolveWebwrightModelConfig, suggestExplorationBaseUrl } from '../webwright-model-config.js'

function legacySettings(): Settings {
  return {
    active_provider: 'anthropic', api_key: 'fixture-active-key', model: 'claude-sonnet-4-6',
    api_key_deepseek: 'legacy-key', model_deepseek: 'legacy-model', added_providers: ['deepseek'],
    custom_auth_type: 'api_key', base_url_custom: 'https://example.com/legacy', openai_base_url_custom: 'https://example.com/legacy/v1',
  } as Settings
}

describe('multiple model configurations', () => {
  it('persists a deduplicated custom model list and rejects invalid entries', () => {
    const created = createModelConfiguration(legacySettings(), 'custom')
    const state = { ...legacySettings(), ...created.updates }
    const updates = updateModelConfiguration(state, created.id, { custom_models: ['my-model', ' my-model ', 'another-model'] })
    const next = { ...state, ...updates }
    expect(getModelConfiguration(next, created.id)?.custom_models).toEqual(['my-model', 'another-model'])
    expect(publicModelConfigurations(next)[created.id].custom_models).toEqual(['my-model', 'another-model'])
    expect(() => updateModelConfiguration(state, created.id, { custom_models: [''] })).toThrow('自定义模型列表无效')
    expect(() => updateModelConfiguration(state, created.id, { custom_models: Array(201).fill('model') })).toThrow('自定义模型列表无效')
  })

  it('fixes preset names and protects only fixed entries from rename and deletion', () => {
    const state = { ...legacySettings(), model_configuration_names: { anthropic: 'old name', glm: 'old name', deepseek: 'old name' } }
    const original = structuredClone(state)
    const names = { anthropic: 'Anthropic', glm: '智谱 coding plan', deepseek: 'DeepSeek' }
    expect(buildModelConfigurationNames(state)).toMatchObject(names)
    for (const [id, name] of Object.entries(names)) {
      expect(() => renameModelConfiguration(state, id, 'changed name')).toThrow('固定供应商名称不能修改')
      expect(renameModelConfiguration(state, id, name)).toEqual({})
      expect(() => deleteModelConfiguration(state, id)).toThrow('固定供应商不能删除')
      const created = createModelConfiguration(state, id)
      const next = { ...state, ...created.updates }
      expect(renameModelConfiguration(next, created.id, 'extra configuration').model_configurations?.[created.id].name).toBe('extra configuration')
      expect(deleteModelConfiguration(next, created.id).model_configurations?.[created.id]).toBeUndefined()
    }
    expect(state).toEqual(original)
  })

  it('creates blank custom drafts without inheriting legacy or existing configuration data', () => {
    const legacy = { ...legacySettings(), api_key_custom: 'fixture-legacy-key',
      openai_api_key_custom: 'fixture-legacy-openai-key', model_custom: 'fixture-legacy-model',
      openai_model_custom: 'fixture-legacy-openai-model', custom_auth_type: 'auth_token' as const,
      base_url_is_full_custom: true, openai_base_url_is_full_custom: true,
      models_url_custom: 'https://example.com/catalog', models_url_is_full_custom: true,
      models_auth_type_custom: 'auth_token' as const,
      openai_models_url_custom: 'https://example.org/catalog', openai_models_url_is_full_custom: true,
    }
    const blank = {
      provider_id: 'custom', model: '', api_key: '', base_url: '', base_url_is_full: false,
      openai_model: '', openai_api_key: '', openai_base_url: '', openai_base_url_is_full: false,
      auth_type: 'api_key', models_url: '', models_url_is_full: false, models_auth_type: 'inherit',
      openai_models_url: '', openai_models_url_is_full: false,
      weworker_protocol: 'anthropic_messages',
    }
    const first = createModelConfiguration(legacy, 'custom')
    expect(first.updates.model_configurations[first.id]).toMatchObject(blank)
    let state = { ...legacy, ...first.updates }
    state = { ...state, ...updateModelConfiguration(state, first.id, {
      api_key: 'fixture-existing-key', model: 'fixture-existing-model',
      base_url: 'https://example.com/messages', base_url_is_full: true,
      openai_api_key: 'fixture-existing-openai-key', openai_model: 'fixture-existing-openai-model',
      openai_base_url: 'https://example.org/completions', openai_base_url_is_full: true,
      auth_type: 'auth_token', models_url: 'https://example.com/models', models_url_is_full: true,
      models_auth_type: 'auth_token', openai_models_url: 'https://example.org/models', openai_models_url_is_full: true,
    }) }
    const original = structuredClone(state)
    const second = createModelConfiguration(state, 'custom')
    expect(second.updates.model_configurations[second.id]).toMatchObject(blank)
    expect(second.updates.model_configurations[first.id]).toEqual(original.model_configurations[first.id])
    expect(state).toEqual(original)
    const next = { ...state, ...second.updates }
    expect(publicModelConfigurations(next)[second.id]).toMatchObject({ has_key: false, has_openai_key: false })
    expect(() => activateModelConfiguration(next, second.id)).toThrow('请先保存')
    const reloaded = applySecrets(clearSecretsOnDisk(next), extractSecrets(next))
    expect(reloaded.model_configurations?.[second.id]).toMatchObject(blank)
  })

  it('numbers new configurations while preserving and naming historical configurations', () => {
    const legacy = legacySettings()
    const original = structuredClone(legacy)
    const first = createModelConfiguration(legacy, 'deepseek')
    expect(first.updates.model_configuration_names?.deepseek).toBe('DeepSeek')
    expect(first.updates.model_configurations[first.id].name).toBe('DeepSeek(1)')
    const state = { ...legacy, ...first.updates }
    const second = createModelConfiguration(state, 'deepseek')
    expect(second.updates.model_configurations[second.id].name).toBe('DeepSeek(2)')
    expect(legacy).toEqual(original)
    const fresh = { added_providers: [] } as unknown as Settings
    const newFirst = createModelConfiguration(fresh, 'deepseek')
    expect(newFirst.updates.model_configurations[newFirst.id].name).toBe('DeepSeek(1)')
  })

  it('reserves explicit names before generating names for older unnamed entries', () => {
    const first = createModelConfiguration(legacySettings(), 'deepseek')
    const state = { ...legacySettings(), ...first.updates, model_configuration_names: {} }
    state.model_configurations[first.id].name = 'DeepSeek(1)'
    expect(buildModelConfigurationNames(state)).toMatchObject({ deepseek: 'DeepSeek', [first.id]: 'DeepSeek(1)' })
    expect(createModelConfiguration(state, 'deepseek').updates.model_configuration_names?.deepseek).toBe('DeepSeek')
  })

  it('renames legacy, built-in and incomplete active configurations without changing service settings', () => {
    const created = createModelConfiguration(legacySettings(), 'deepseek')
    let state = { ...legacySettings(), ...created.updates, active_model_configuration: created.id }
    state.model_configurations[created.id].api_key = ''
    const original = structuredClone(state)
    state = { ...state, ...renameModelConfiguration(state, created.id, '  工作模型  ') }
    state = { ...state, ...renameModelConfiguration(state, 'custom', '历史模型') }
    state = { ...state, ...renameModelConfiguration(state, 'builtin', '内置助手') }
    expect(state.model_configurations[created.id]).toEqual({ ...original.model_configurations[created.id], name: '工作模型' })
    expect(state.model_configuration_names).toMatchObject({ custom: '历史模型', builtin: '内置助手' })
    for (const field of ['api_key', 'model', 'api_key_deepseek', 'model_deepseek', 'base_url_custom', 'openai_base_url_custom', 'active_model_configuration'] as const) {
      expect(state[field]).toEqual(original[field])
    }
    expect(() => renameModelConfiguration(state, 'unregistered', 'name')).toThrow()
  })

  it('deletes only inactive independent configurations and refuses built-in or active entries', () => {
    const first = createModelConfiguration(legacySettings(), 'deepseek')
    const second = createModelConfiguration({ ...legacySettings(), ...first.updates }, 'deepseek')
    const state = { ...legacySettings(), ...first.updates, ...second.updates }
    const updates = deleteModelConfiguration(state, first.id)
    expect(updates.model_configurations?.[first.id]).toBeUndefined()
    expect(updates.model_configurations?.[second.id]).toBeDefined()
    expect(() => deleteModelConfiguration({ ...state, active_model_configuration: second.id }, second.id)).toThrow('当前使用中')
    expect(() => deleteModelConfiguration(state, 'builtin')).toThrow('模型配置不存在')
  })

  it('validates names and keeps names in public responses without exposing credentials', () => {
    for (const name of ['', '   ', null, 123, 'x'.repeat(81)]) {
      expect(() => validateModelConfigurationName(name)).toThrow()
    }
    expect(validateModelConfigurationName('  自定义配置  ')).toBe('自定义配置')
    const created = createModelConfiguration(legacySettings(), 'deepseek')
    const state = { ...legacySettings(), ...created.updates }
    const updates = updateModelConfiguration(state, created.id, { name: '  开发模型  ' })
    expect(publicModelConfigurations({ ...state, ...updates })[created.id].name).toBe('开发模型')
    expect(JSON.stringify(publicModelConfigurations({ ...state, ...updates }))).not.toContain('legacy-key')
  })

  it('does not combine a cleared per-configuration OpenAI URL with the legacy full URL mode', () => {
    const legacy = { ...legacySettings(), openai_base_url_custom: 'https://example.com/inference/?version=1', openai_base_url_is_full_custom: true }
    const first = createModelConfiguration(legacy, 'custom')
    let state = { ...legacy, ...first.updates }
    state = { ...state, ...updateModelConfiguration(state, first.id, {
      api_key: 'fixture-key', openai_base_url: '', openai_base_url_is_full: false,
    }) }
    const second = createModelConfiguration(state, 'custom')
    expect(second.updates.model_configurations[second.id]).toMatchObject({ openai_base_url: '', openai_base_url_is_full: false })
  })

  it('saves and activates two models of the same provider independently', () => {
    const legacy = legacySettings()
    const first = createModelConfiguration(legacy, 'deepseek')
    let state = { ...legacy, ...first.updates }
    state = { ...state, ...updateModelConfiguration(state, first.id, { api_key: 'first-key', model: 'first-model', context_limit: 200000 }) }
    const second = createModelConfiguration(state, 'deepseek')
    state = { ...state, ...second.updates }
    expect(first.id).not.toBe(second.id)
    // 模型名没有内置默认值：新配置的模型为空，未选定前不允许激活。
    expect(state.model_configurations[second.id].model).toBe('')
    expect(() => activateModelConfiguration(state, second.id)).toThrow()
    state = { ...state, ...updateModelConfiguration(state, second.id, { model: 'second-default' }) }
    state = { ...state, ...activateModelConfiguration(state, second.id) }
    expect(state).toMatchObject({ api_key: 'first-key', model: 'second-default' })
    state = { ...state, ...updateModelConfiguration(state, second.id, { api_key: 'second-key', model: 'second-model', context_limit: 400000 }) }
    state = { ...state, ...activateModelConfiguration(state, first.id) }
    expect(state).toMatchObject({ api_key: 'first-key', model: 'first-model', context_limit: 200000 })
    state = { ...state, ...updateModelConfiguration(state, second.id, { model: 'edited-second' }) }
    expect(state.model).toBe('first-model')
    state = { ...state, ...activateModelConfiguration(state, second.id) }
    expect(state).toMatchObject({ api_key: 'second-key', model: 'edited-second', context_limit: 400000 })
    expect(state.model_configurations[first.id].model).toBe('first-model')
    expect(state.api_key_deepseek).toBe('legacy-key')
    expect(state.model_deepseek).toBe('legacy-model')
  })

  it('isolates custom endpoints and authentication and keeps advanced settings when saving only a model', () => {
    const created = createModelConfiguration(legacySettings(), 'custom')
    let state = { ...legacySettings(), ...created.updates }
    state = { ...state, ...updateModelConfiguration(state, created.id, {
      api_key: 'custom-key', model: 'custom-model', base_url: 'https://example.org/anthropic',
      openai_base_url: 'https://example.org/v1', auth_type: 'auth_token',
    }) }
    state = { ...state, ...activateModelConfiguration(state, created.id) }
    state = { ...state, ...updateModelConfiguration(state, created.id, { model: 'changed-model', api_key: '' }) }
    expect(state).toMatchObject({ model: 'changed-model', api_key: 'custom-key', active_auth_type: 'auth_token', custom_auth_type: 'api_key' })
    expect(resolveWebwrightModelConfig(state)).toMatchObject({ base_url: 'https://example.org/v1', model: 'changed-model' })
    expect(state.openai_base_url_custom).toBe('https://example.com/legacy/v1')
    expect(() => updateModelConfiguration(state, created.id, { base_url: '' })).toThrow()
    expect(() => updateModelConfiguration(state, created.id, { context_limit: -1 })).toThrow()
    expect(() => createModelConfiguration(state, 'builtin')).toThrow()
    expect(() => createModelConfiguration(state, 'builtin_dev')).toThrow()
  })

  it('persists the selected WeWorker conversation protocol and activates it with the model', () => {
    const created = createModelConfiguration(legacySettings(), 'custom')
    let state = { ...legacySettings(), ...created.updates }
    state = { ...state, ...updateModelConfiguration(state, created.id, {
      api_key: 'fixture-key', model: 'fixture-model', base_url: 'https://example.org/v1',
      weworker_protocol: 'openai_chat_completions',
    }) }

    expect(state.model_configurations[created.id].weworker_protocol).toBe('openai_chat_completions')
    state = { ...state, ...activateModelConfiguration(state, created.id) }
    expect(state.active_weworker_protocol).toBe('openai_chat_completions')
    state = { ...state, ...updateModelConfiguration(state, created.id, { weworker_protocol: 'openai_responses' }) }
    expect(state.model_configurations[created.id].weworker_protocol).toBe('openai_responses')
    expect(state.active_weworker_protocol).toBe('openai_responses')
    expect(() => updateModelConfiguration(state, created.id, { weworker_protocol: 'unsupported' })).toThrow()
  })

  it('keeps custom website exploration credentials and model independent from Claude Code', () => {
    const created = createModelConfiguration(legacySettings(), 'custom')
    let state = { ...legacySettings(), ...created.updates }
    state = { ...state, ...updateModelConfiguration(state, created.id, {
      api_key: 'fixture-claude-key', model: 'fixture-claude-model',
      base_url: 'https://example.com/anthropic',
      openai_api_key: 'fixture-openai-key', openai_model: 'fixture-openai-model',
      openai_base_url: 'https://example.org/v1',
    }) }
    state = { ...state, ...activateModelConfiguration(state, created.id) }

    expect(state).toMatchObject({ api_key: 'fixture-claude-key', model: 'fixture-claude-model' })
    expect(resolveWebwrightModelConfig(state)).toMatchObject({
      api_key: 'fixture-openai-key', model: 'fixture-openai-model', base_url: 'https://example.org/v1',
    })
  })

  it('redacts each key from public responses and includes it in encrypted secret storage', () => {
    const created = createModelConfiguration(legacySettings(), 'deepseek')
    const state = { ...legacySettings(), ...created.updates }
    state.model_configurations[created.id].api_key = 'private-entry-key'
    const secrets = extractSecrets(state)
    const publicSettings = clearSecretsOnDisk(state)
    expect(JSON.stringify(publicSettings)).not.toContain('private-entry-key')
    expect(JSON.stringify(publicModelConfigurations(state))).not.toContain('private-entry-key')
    expect(publicModelConfigurations(state)[created.id].has_key).toBe(true)
    expect(applySecrets(publicSettings, secrets).model_configurations?.[created.id].api_key).toBe('private-entry-key')
  })

  it('uses each custom configuration address while preserving an independent exploration service', () => {
    const created = createModelConfiguration(legacySettings(), 'custom')
    let state = { ...legacySettings(), ...created.updates }
    state = { ...state, ...updateModelConfiguration(state, created.id, {
      api_key: 'fixture-config-key', model: 'fixture-config-model',
      base_url: 'https://example.org/custom', openai_base_url: '',
    }) }
    state = { ...state, ...activateModelConfiguration(state, created.id) }
    expect(resolveWebwrightModelConfig(state)).toMatchObject({
      base_url: 'https://example.org/custom', api_key: 'fixture-config-key', model: 'fixture-config-model',
    })
    expect(suggestExplorationBaseUrl(state)).toEqual({ url: 'https://example.org/custom/v1', generated: true })
    const independent = { ...state, exploration_base_url: 'https://example.com/exploration',
      exploration_use_main_key: false, exploration_api_key: 'fixture-exploration-key', exploration_model: 'fixture-exploration-model' }
    expect(resolveWebwrightModelConfig(independent)).toMatchObject({ base_url: 'https://example.com/exploration',
      api_key: 'fixture-exploration-key', model: 'fixture-exploration-model' })
    expect(suggestExplorationBaseUrl(independent)).toEqual({ url: 'https://example.com/exploration', generated: false })
  })

  it('rejects malformed configuration endpoints and providers outside the registered profile', () => {
    const created = createModelConfiguration(legacySettings(), 'custom')
    const state = { ...legacySettings(), ...created.updates }
    for (const base_url of ['file:///tmp/fixture', 'https://example.com/?token=fixture', 'https://example.com/v1/messages']) {
      expect(() => updateModelConfiguration(state, created.id, { base_url })).toThrow()
    }
    state.model_configurations[created.id].provider_id = 'unregistered'
    expect(getModelConfiguration(state, created.id)).toBeUndefined()
    expect(publicModelConfigurations(state)).toEqual({})
    expect(() => activateModelConfiguration(state, created.id)).toThrow()
    expect(() => createModelConfiguration(state, 'unregistered')).toThrow()
  })

  it('persists and reloads model edits and deletions without restoring removed configurations', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-model-config-test-'))
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(directory)
    const { setMasterKeyForTests } = await import('../secret-store.js')
    setMasterKeyForTests('0123456789abcdef0123456789abcdef')
    try {
      const config = await import('../config.js')
      const initial = config.getSettings()
      const first = createModelConfiguration(initial, 'deepseek')
      let state = config.updateSettings(first.updates)
      state = config.updateSettings(updateModelConfiguration(state, first.id, { name: 'saved configuration', model: 'saved-one', api_key: 'persisted-one', context_limit: 250000 }))
      const second = createModelConfiguration(state, 'deepseek')
      state = config.updateSettings(second.updates)
      state = config.updateSettings(updateModelConfiguration(state, second.id, { model: 'saved-two', api_key: 'persisted-two', context_limit: 500000 }))
      config.updateSettings(activateModelConfiguration(state, first.id))
      const custom = createModelConfiguration(config.getSettings(), 'custom')
      state = config.updateSettings(custom.updates)
      config.updateSettings(updateModelConfiguration(state, custom.id, {
        base_url: 'https://example.com/arbitrary/endpoint?version=1', base_url_is_full: true,
        openai_base_url: 'https://example.com/openai/custom?version=2', openai_base_url_is_full: true,
        api_key: 'custom-test-key', model: 'custom-test-model',
        models_url: 'https://example.org/models?version=1', models_url_is_full: true, models_auth_type: 'auth_token', openai_models_url: 'https://example.org/v1', openai_models_url_is_full: false,
      }))
      state = config.updateSettings(renameModelConfiguration(config.getSettings(), 'builtin', 'built-in assistant'))
      config.updateSettings(renameModelConfiguration(state, 'custom', 'legacy assistant'))
      const raw = fs.readFileSync(path.join(directory, '.weworker', 'settings.json'), 'utf8')
      expect(raw).not.toContain('persisted-one')
      expect(raw).not.toContain('persisted-two')
      config.resetSettingsStateForTests()
      const restored = config.getSettings()
      expect(restored.active_model_configuration).toBe(first.id)
      expect(restored.context_limit).toBe(250000)
      expect(restored.model_configurations?.[first.id]).toMatchObject({ name: 'saved configuration', model: 'saved-one', api_key: 'persisted-one' })
      expect(restored.model_configuration_names).toMatchObject({ builtin: 'built-in assistant', custom: 'legacy assistant', deepseek: 'DeepSeek' })
      expect(restored.model_configurations?.[second.id]).toMatchObject({ model: 'saved-two', api_key: 'persisted-two' })
      expect(restored.model_deepseek).toBe(initial.model_deepseek)
      expect(restored.model_configurations?.[custom.id]).toMatchObject({
        models_url: 'https://example.org/models?version=1', models_url_is_full: true, models_auth_type: 'auth_token', openai_models_url: 'https://example.org/v1', openai_models_url_is_full: false,
        base_url: 'https://example.com/arbitrary/endpoint?version=1', base_url_is_full: true,
        openai_base_url: 'https://example.com/openai/custom?version=2', openai_base_url_is_full: true,
      })

      const remaining = structuredClone(restored.model_configurations!)
      delete remaining[second.id]
      const deleted = config.updateSettings(deleteModelConfiguration(restored, second.id))
      expect(deleted.model_configurations).toEqual(remaining)
      expect(publicModelConfigurations(deleted)[second.id]).toBeUndefined()
      expect(extractSecrets(deleted)[`model_configurations.${second.id}.api_key`]).toBeUndefined()
      expect(deleted.active_model_configuration).toBe(first.id)
      const disk = JSON.parse(fs.readFileSync(path.join(directory, '.weworker', 'settings.json'), 'utf8'))
      expect(disk.model_configurations[second.id]).toBeUndefined()
      config.resetSettingsStateForTests()
      expect(config.getSettings().model_configurations).toEqual(remaining)

      // Unrelated partial updates must retain the complete model collection.
      state = config.updateSettings({ welcome_featured_site_limit: 12 })
      expect(state.model_configurations).toEqual(remaining)
      expect(() => deleteModelConfiguration(state, first.id)).toThrow('当前使用中')
      state = config.updateSettings({ active_model_configuration: '' })
      state = config.updateSettings(deleteModelConfiguration(state, first.id))
      state = config.updateSettings(deleteModelConfiguration(state, custom.id))
      expect(state.model_configurations).toEqual({})
      config.resetSettingsStateForTests()
      expect(config.getSettings().model_configurations).toEqual({})
    } finally {
      homedir.mockRestore()
      setMasterKeyForTests(null)
    }
  })
})
