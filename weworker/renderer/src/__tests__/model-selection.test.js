import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { selectModelAfterCatalogRefresh, buildProbeResultRows, buildProviderProbeTargets, buildModelOptions, buildModelCatalogAccess, getModelCatalogIssue, getModelCatalogStatus, buildSettingsProviderLists, buildChatProviderOptions, getVisibleModelRefreshDetail, isModelRefreshFailed, shouldShowModelRefreshFailure } from '../utils/model-selection.js'
import { getOpenAiUrlHint } from '../utils/provider-url.js'

it('defaults OpenAI protocol to Chat Completions and offers Responses as an alternate', () => {
  const settings = fs.readFileSync(new URL('../components/settings/SettingsModal.jsx', import.meta.url), 'utf8')
  assert.match(settings, /Chat Completions（广泛兼容，推荐）/)
  assert.match(settings, /Responses API（新版）/)
  assert.match(settings, /f\.weworker_protocol === 'openai_responses' \? 'openai_responses' : 'openai_chat_completions'/)
  assert.equal(getOpenAiUrlHint(false), '填写基础 URL，软件自动追加 /chat/completions')
  assert.equal(getOpenAiUrlHint(false, true), '填写基础 URL，软件自动追加 /responses')
})

it('shows unconfigured presets in chat with key state, keeping configured additional entries', () => {
  const templates = [{ id: 'builtin', name: '内置模型' }, { id: 'anthropic', name: 'Anthropic' }, { id: 'glm', name: '智谱 coding plan' }, { id: 'deepseek', name: 'DeepSeek' }, { id: 'custom', name: '自定义' }]
  const options = buildChatProviderOptions(templates, {
    anthropic: { has_key: true },
    'model-extra': { provider_id: 'custom', has_key: true, base_url: 'https://example.com', name: '额外配置', model: 'fixture-model' },
    'model-empty': { provider_id: 'custom', has_key: false },
  }, 'builtin')
  assert.deepEqual(options.map(item => item.value), ['builtin', 'anthropic', 'glm', 'deepseek', 'model-extra'])
  assert.deepEqual(options.slice(1, 4).map(item => item.keyConfigured), [true, false, false])
  assert.equal(options[4].label, '额外配置')
  assert.deepEqual(options.map(item => item.keyConfigured), [true, true, false, false, true])
  assert.equal(buildChatProviderOptions(templates, {}, 'old-provider')[0].value, 'old-provider')
})

it('hides custom configurations missing a conversation key or URL, including the active entry', () => {
  const templates = [{ id: 'builtin' }, { id: 'custom' }]
  for (const id of ['custom', 'model-custom']) {
    for (const fields of [{ has_key: false, base_url: 'https://example.com' }, { has_key: true, base_url: '  ' }, { has_key: false, openai_has_key: true, openai_base_url: 'https://example.org' }]) {
      const options = buildChatProviderOptions(templates, { [id]: { provider_id: 'custom', ...fields } }, id)
      assert.deepEqual(options.map(item => item.value), ['builtin'])
      assert.ok(options.every(item => item.keyConfigured === true))
    }
    const options = buildChatProviderOptions(templates, { [id]: { provider_id: 'custom', has_key: true, base_url: 'https://example.com' } }, id)
    assert.equal(options.at(-1).value, id)
    assert.equal(options.at(-1).keyConfigured, true)
  }
})

describe('model catalog connection prerequisites', () => {
  const form = { api_key: '', openai_api_key: '', base_url: 'https://example.com', openai_base_url: 'https://example.org/v1', base_url_is_full: false, openai_base_url_is_full: false, auth_type: 'api_key' }

  it('requires an address and a key for the selected interface', () => {
    assert.match(getModelCatalogIssue('custom', { ...form, base_url: '' }, { has_key: true }), /接口地址/)
    assert.match(getModelCatalogIssue('custom', { ...form, base_url: 'invalid' }, { has_key: true }), /有效/)
    assert.match(getModelCatalogIssue('custom', { ...form, base_url: 'file:///fixture' }, { has_key: true }), /HTTP/)
    assert.match(getModelCatalogIssue('custom', { ...form, api_key: '  ' }), /API Key/)
    assert.match(getModelCatalogIssue('custom', { ...form, api_key: 'fixture-key' }, { has_key: true }, 'webwright'), /API Key/)
  })

  it('accepts saved keys without revealing them, including legacy OpenAI metadata', () => {
    assert.equal(getModelCatalogIssue('custom', form, { has_key: true }), '')
    assert.equal(getModelCatalogIssue('custom', form, { has_openai_key: true }, 'webwright'), '')
    assert.equal(getModelCatalogIssue('custom', form, { openai_has_key: true }, 'webwright'), '')
    assert.equal(getModelCatalogIssue('deepseek', form, { has_key: true }), '')
  })

  it('does not guess a models URL from a complete endpoint', () => {
    assert.match(getModelCatalogIssue('custom', { ...form, base_url_is_full: true }, { has_key: true }), /完整 URL/)
  })

  it('sends only the selected interface credentials and ignores unrelated invalid edits', () => {
    const draft = { ...form, api_key: ' fixture-main-key ', openai_api_key: ' fixture-openai-key ' }
    const main = buildModelCatalogAccess('model-fixture', 'custom', { ...draft, openai_base_url: 'unfinished' })
    assert.equal(main.api_key, 'fixture-main-key')
    assert.equal(main.openai_api_key, '')
    assert.equal(main.openai_base_url, '')
    assert.equal(main.target, 'weworker')
    const openai = buildModelCatalogAccess('model-fixture', 'custom', { ...draft, base_url: 'unfinished' }, 'webwright')
    assert.equal(openai.api_key, '')
    assert.equal(openai.base_url, '')
    assert.equal(openai.openai_api_key, 'fixture-openai-key')
    assert.equal(openai.openai_base_url, form.openai_base_url)
    assert.equal(openai.target, 'webwright')
  })

  it('uses the selected WeWorker protocol when validating and requesting its model catalog', () => {
    const openaiChat = { ...form, weworker_protocol: 'openai_chat_completions', models_url: '', base_url: 'https://example.com/v1' }
    assert.equal(getModelCatalogIssue('custom', openaiChat, { has_key: true }), '')
    const access = buildModelCatalogAccess('fixture', 'custom', openaiChat)
    assert.equal(access.weworker_protocol, 'openai_chat_completions')
    assert.equal(access.api_key, '')
    assert.equal(access.openai_api_key, '')
    assert.equal(access.base_url, openaiChat.base_url)
  })

  it('allows explicit catalog URLs with full conversation endpoints and keeps the two catalogs separate', () => {
    const draft = { ...form, base_url_is_full: true, models_url: 'https://example.org/models?version=1', models_auth_type: 'auth_token', openai_models_url: 'https://example.com/catalog' }
    assert.equal(getModelCatalogIssue('custom', draft, { has_key: true }), '')
    assert.match(getModelCatalogIssue('custom', { ...draft, models_url: 'invalid' }, { has_key: true }), /有效/)
    const main = buildModelCatalogAccess('fixture', 'custom', draft)
    assert.equal(main.models_url, draft.models_url)
    assert.equal(main.models_auth_type, 'auth_token')
    assert.equal(main.openai_models_url, '')
    const openai = buildModelCatalogAccess('fixture', 'custom', draft, 'webwright')
    assert.equal(openai.models_url, '')
    assert.equal(openai.openai_models_url, draft.openai_models_url)
    assert.equal(buildModelCatalogAccess('fixture', 'custom', form).models_url, '')
  })

  it('sends independent catalog URL modes and requires full mode for query parameters', () => {
    const draft = { ...form, models_url: 'https://example.com/v1', models_url_is_full: false, openai_models_url: 'https://example.org/models?version=1', openai_models_url_is_full: true }
    assert.equal(buildModelCatalogAccess('fixture', 'custom', draft).models_url_is_full, false)
    assert.equal(buildModelCatalogAccess('fixture', 'custom', draft, 'webwright').openai_models_url_is_full, true)
    assert.equal(getModelCatalogIssue('custom', draft, { has_key: true }), '')
    assert.equal(getModelCatalogIssue('custom', draft, { has_openai_key: true }, 'webwright'), '')
    assert.match(getModelCatalogIssue('custom', { ...draft, openai_models_url_is_full: false }, { has_openai_key: true }, 'webwright'), /完整 URL/)
    assert.equal(buildModelCatalogAccess('fixture', 'custom', { ...form, models_url: 'https://example.com/models' }).models_url_is_full, true)
  })

  it('shows automatic authentication failures instead of a built-in catalog success', () => {
    const failed = getModelCatalogStatus({ source: 'fallback', models: ['fallback-model'], warning: 'HTTP 401 Unauthorized', explicitRefresh: false }, false)
    assert.equal(failed.failed, true)
    assert.match(failed.hint, /不代表对话不可用/)
    assert.equal(failed.detail, 'HTTP 401 Unauthorized')
    assert.equal(getModelCatalogStatus({ source: 'remote', models: [] }, false).failed, true)
    assert.equal(getModelCatalogStatus({ source: 'remote', models: ['fixture-model'] }, false).hint, '已获取 1 个模型')
  })
})

describe('provider model selection', () => {
  it('keeps custom models alongside refreshed catalog entries and marks them removable', () => {
    assert.deepEqual(buildModelOptions(['remote-a'], 'my-local-model', { customModels: ['my-local-model'] }), [
      { value: 'remote-a', label: 'remote-a', currentOnly: false },
      { value: 'my-local-model', label: 'my-local-model', currentOnly: false, custom: true },
    ])
    assert.equal(selectModelAfterCatalogRefresh('my-local-model', { source: 'remote', models: ['remote-a'] }, { customModels: ['my-local-model'] }), 'my-local-model')
    assert.equal(selectModelAfterCatalogRefresh('stale-model', { source: 'remote', models: ['remote-a'] }, { customModels: ['my-local-model'] }), 'remote-a')
  })

  it('keeps an unlisted current model as an enabled option', () => {
    assert.deepEqual(buildModelOptions(['deepseek-v4-flash'], 'deepseek-chat'), [
      { value: 'deepseek-chat', label: 'deepseek-chat（当前配置）', currentOnly: true },
      { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash', currentOnly: false },
    ])
  })

  it('can omit the current-config suffix for compact chat selectors', () => {
    assert.deepEqual(
      buildModelOptions(['deepseek-v4-flash'], 'deepseek-chat', { annotateCurrent: false }),
      [
        { value: 'deepseek-chat', label: 'deepseek-chat', currentOnly: true },
        { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash', currentOnly: false },
      ],
    )
    assert.deepEqual(buildModelOptions(['deepseek-v4-flash'], 'deepseek-chat', { annotateCurrent: true })[0].label, 'deepseek-chat（当前配置）')
  })
  it('deduplicates catalog models without relabeling a listed current model', () => {
    assert.deepEqual(buildModelOptions(['model-a', 'model-a', 'model-b'], 'model-a'), [
      { value: 'model-a', label: 'model-a', currentOnly: false },
      { value: 'model-b', label: 'model-b', currentOnly: false },
    ])
  })

  it('selects the first remote model after refresh when the current model is stale', () => {
    assert.equal(selectModelAfterCatalogRefresh('glm-5.2', { source: 'remote', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }), 'deepseek-v4-flash')
    assert.equal(selectModelAfterCatalogRefresh('deepseek-v4-pro', { source: 'remote', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] }), 'deepseek-v4-pro')
    assert.equal(selectModelAfterCatalogRefresh('glm-5.2', { source: 'fallback', models: ['deepseek-v4-flash'] }), 'glm-5.2')
  })

  it('reports refresh failure for fallback and empty remote catalogs', () => {
    assert.equal(isModelRefreshFailed({ source: 'fallback', models: ['model-a'] }), true)
    assert.equal(isModelRefreshFailed({ source: 'remote', models: [] }), true)
    assert.equal(isModelRefreshFailed({ source: 'remote', models: ['model-a'] }), false)
    assert.equal(isModelRefreshFailed(null), false)
  })

  it('shows refresh failure only after an explicit refresh', () => {
    assert.equal(shouldShowModelRefreshFailure({ source: 'fallback', models: [], explicitRefresh: false }), false)
    assert.equal(shouldShowModelRefreshFailure({ source: 'fallback', models: [], explicitRefresh: true }), true)
    assert.equal(shouldShowModelRefreshFailure({ source: 'remote', models: [], explicitRefresh: true }), true)
    assert.equal(shouldShowModelRefreshFailure({ source: 'remote', models: ['model-a'], explicitRefresh: true }), false)
  })

  it('shows the remote response detail only after an explicit refresh', () => {
    const detail = 'OpenAI 接口：HTTP 401 Unauthorized\n{"error":{"message":"invalid key"}}'
    assert.equal(getVisibleModelRefreshDetail({ source: 'fallback', models: [], warning: detail, explicitRefresh: false }), '')
    assert.equal(getVisibleModelRefreshDetail({ source: 'fallback', models: [], warning: detail, explicitRefresh: true }), detail)
    assert.equal(getVisibleModelRefreshDetail({ source: 'remote', models: [], explicitRefresh: true }), '远程接口返回空模型列表')
  })

  it('shows added and legacy-configured providers in settings', () => {
    const providerList = [
      { id: 'anthropic' },
      { id: 'deepseek' },
      { id: 'custom' },
    ]
    const { visible, addable } = buildSettingsProviderLists(providerList, {
      anthropic: { added: true },
      deepseek: { has_key: true },
      custom: { base_url: 'https://gateway.example/v1' },
    })
    assert.deepEqual(visible.map(({ id }) => id), ['anthropic', 'deepseek', 'custom'])
    assert.deepEqual(addable.map(({ id }) => id), ['anthropic', 'deepseek', 'custom'])
  })

  it('shows fixed presets while custom configurations are added explicitly', () => {
    const providerList = [{ id: 'anthropic' }, { id: 'custom' }]
    const { visible, addable } = buildSettingsProviderLists(providerList, {})
    assert.deepEqual(visible.map(({ id }) => id), ['anthropic'])
    assert.deepEqual(addable.map(({ id }) => id), ['anthropic', 'custom'])
  })

  it('initially shows built-ins and fixed presets despite empty credentials', () => {
    const templates = [
      { id: 'builtin' },
      { id: 'anthropic', defaultModel: 'default-claude' },
      { id: 'deepseek', defaultModel: 'default-deepseek' },
      { id: 'custom', defaultModel: '' },
    ]
    const { visible, addable } = buildSettingsProviderLists(templates, {
      anthropic: { model: 'default-claude', has_key: false, added: false, visible: false },
      deepseek: { model: 'default-deepseek', has_key: false },
      custom: { model: '', base_url: '', openai_base_url: '' },
    })
    assert.deepEqual(visible.map(provider => provider.id), ['builtin', 'anthropic', 'deepseek'])
    assert.deepEqual(addable.map(provider => provider.id), ['anthropic', 'deepseek', 'custom'])
  })

  it('retains historical model-only settings and explicit additions without changing saved data', () => {
    const templates = [
      { id: 'anthropic', defaultModel: 'default-claude' },
      { id: 'deepseek', defaultModel: 'default-deepseek' }, { id: 'custom' },
    ]
    const providers = {
      anthropic: { model: 'user-selected-model', has_key: false },
      deepseek: { model: 'default-deepseek', has_key: true, visible: false },
      custom: { openai_base_url: 'https://example.com/custom', openai_base_url_is_full: true },
      'model-added-empty': { provider_id: 'anthropic', added: true, has_key: false },
    }
    const before = structuredClone(providers)
    const { visible } = buildSettingsProviderLists(templates, providers)
    assert.deepEqual(visible.map(provider => provider.id), ['anthropic', 'deepseek', 'custom', 'model-added-empty'])
    assert.deepEqual(providers, before)
  })

  it('keeps fixed presets visible even with legacy hidden metadata', () => {
    const { visible } = buildSettingsProviderLists([{ id: 'anthropic', defaultModel: 'new-default' }], {
      anthropic: { model: 'old-default', has_key: false, visible: false },
    })
    assert.deepEqual(visible.map(provider => provider.id), ['anthropic'])
  })

  it('keeps the supplier selectable and shows multiple independent models', () => {
    const providerList = [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'custom' }]
    const { visible, addable } = buildSettingsProviderLists(providerList, {
      deepseek: { has_key: true, model: 'legacy' },
      'model-first': { provider_id: 'deepseek', model: 'model-one' },
      'model-second': { provider_id: 'deepseek', model: 'model-two' },
      'model-custom': { provider_id: 'custom', model: 'gateway-model' },
    })
    assert.deepEqual(visible.map(({ id }) => id), ['deepseek', 'model-first', 'model-second', 'model-custom'])
    assert.deepEqual(visible.slice(1).map(({ providerId }) => providerId), ['deepseek', 'deepseek', 'custom'])
    assert.deepEqual(addable.map(({ id }) => id), ['deepseek', 'custom'])
  })

  it('shows configuration names separately from suppliers and names older unnamed entries', () => {
    const providerList = [{ id: 'builtin', name: '内置模型' }, { id: 'deepseek', name: 'DeepSeek' }]
    const stored = {
      builtin: { name: '内置助手' },
      deepseek: { name: 'old preset name', has_key: true, model: 'legacy' },
      'model-one': { provider_id: 'deepseek', model: 'first' },
      'model-two': { provider_id: 'deepseek', name: 'DeepSeek(1)', model: 'second' },
    }
    const original = structuredClone(stored)
    const { visible, addable } = buildSettingsProviderLists(providerList, stored)
    assert.deepEqual(visible.map(provider => provider.name), ['内置助手', 'DeepSeek', 'DeepSeek(2)', 'DeepSeek(1)'])
    assert.deepEqual(visible.map(provider => provider.supplierName), ['内置模型', 'DeepSeek', 'DeepSeek', 'DeepSeek'])
    assert.equal(addable[0].name, 'DeepSeek')
    assert.deepEqual(stored, original)
    assert.equal(buildSettingsProviderLists(providerList, {}).visible[0].name, '内置模型')
  })
})
