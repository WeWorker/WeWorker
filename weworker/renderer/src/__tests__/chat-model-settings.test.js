import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { useSettingsStore } from '../store/settings.js'
import { fetchProviderModels } from '../api/provider-models.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const initialState = useSettingsStore.getState()

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  useSettingsStore.setState(initialState, true)
})

describe('chat model settings integration', () => {
  it('submits settings saves as one checked activation and preserves state on rejection', async () => {
    globalThis.window = {}
    const before = useSettingsStore.getState()
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'custom', model: 'example-draft', activate: true })
      return Response.json({ detail: '网站探索模型不可用' }, { status: 400 })
    }
    await assert.rejects(useSettingsStore.getState().saveProvider('custom', { model: 'example-draft' }, { activate: true }), /不可用/)
    assert.equal(useSettingsStore.getState().activeProvider, before.activeProvider)
    assert.equal(useSettingsStore.getState().providers, before.providers)
  })

  it('completes first-run onboarding through the backend and updates the gate state', async () => {
    globalThis.window = {}
    let request
    globalThis.fetch = async (url, options) => {
      request = { path: new URL(url).pathname, body: JSON.parse(options.body) }
      return Response.json({
        onboarding_completed: true,
        active_provider: 'builtin',
        model: 'ark-code-latest',
        providers: { builtin: { has_key: true, model: 'ark-code-latest' } },
      })
    }
    await useSettingsStore.getState().completeOnboarding('builtin')
    assert.deepEqual(request, { path: '/settings/onboarding/complete', body: { provider: 'builtin' } })
    assert.equal(useSettingsStore.getState().onboardingCompleted, true)
    assert.equal(useSettingsStore.getState().activeProvider, 'builtin')
  })

  it('does not mark onboarding complete when the backend rejects a provider without a key', async () => {
    globalThis.window = {}
    globalThis.fetch = async () => Response.json({ detail: '请先填写并保存 API Key' }, { status: 400 })
    await assert.rejects(useSettingsStore.getState().completeOnboarding('anthropic'), /API Key/)
    assert.equal(useSettingsStore.getState().onboardingCompleted, initialState.onboardingCompleted)
  })

  it('saves a preset key before activating it and synchronizes model settings', async () => {
    globalThis.window = {}
    const calls = []
    globalThis.fetch = async (url, options) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) })
      return Response.json({ active_provider: calls.length === 1 ? 'builtin' : 'anthropic', model: 'fixture-model', providers: { anthropic: { has_key: true, model: 'fixture-model' } } })
    }
    await useSettingsStore.getState().configurePresetProvider('anthropic', '  fixture-key  ')
    assert.deepEqual(calls, [
      { path: '/settings/provider', body: { provider: 'anthropic', api_key: 'fixture-key' } },
      { path: '/settings/provider/activate', body: { provider: 'anthropic' } },
    ])
    assert.equal(useSettingsStore.getState().providers.anthropic.has_key, true)
    assert.equal(useSettingsStore.getState().activeProvider, 'anthropic')
    assert.equal(JSON.stringify(useSettingsStore.getState()).includes('fixture-key'), false)
  })

  it('rejects blank keys and non-preset IDs without saving or switching', async () => {
    globalThis.window = {}
    globalThis.fetch = async () => { throw new Error('unexpected request') }
    await assert.rejects(useSettingsStore.getState().configurePresetProvider('deepseek', '  '), /API Key/)
    await assert.rejects(useSettingsStore.getState().configurePresetProvider('custom', 'fixture-key'), /预定义供应商/)
    assert.equal(useSettingsStore.getState().activeProvider, initialState.activeProvider)
  })

  it('does not activate when saving the preset key fails', async () => {
    globalThis.window = {}
    globalThis.fetch = async (url) => {
      assert.ok(url.endsWith('/settings/provider'))
      return Response.json({ detail: '模拟保存失败' }, { status: 500 })
    }
    await assert.rejects(useSettingsStore.getState().configurePresetProvider('glm', 'fixture-key'), /模拟保存失败/)
    assert.equal(useSettingsStore.getState().activeProvider, initialState.activeProvider)
  })

  it('retains saved key metadata and the old active provider when activation fails', async () => {
    globalThis.window = {}
    globalThis.fetch = async url => url.endsWith('/activate')
      ? Response.json({ detail: '模拟切换失败' }, { status: 500 })
      : Response.json({ active_provider: initialState.activeProvider, providers: { deepseek: { has_key: true } } })
    await assert.rejects(useSettingsStore.getState().configurePresetProvider('deepseek', 'fixture-key'), /模拟切换失败/)
    assert.equal(useSettingsStore.getState().providers.deepseek.has_key, true)
    assert.equal(useSettingsStore.getState().activeProvider, initialState.activeProvider)
  })

  it('deletes an independent model configuration and refreshes the provider list', async () => {
    globalThis.window = {}
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider/delete'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'model-fixture' })
      return Response.json({ active_provider: 'builtin', providers: { builtin: { has_key: true, model: 'fixture-model' } } })
    }
    await useSettingsStore.getState().deleteProvider('model-fixture')
    assert.deepEqual(useSettingsStore.getState().providers, { builtin: { has_key: true, model: 'fixture-model' } })
  })

  it('saves a configuration name without sending service settings or changing the selected model', async () => {
    globalThis.window = {}
    const providers = { builtin: { name: '内置助手', has_key: true, model: 'fixture-model' } }
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'builtin', name: '内置助手' })
      return Response.json({ active_provider: 'builtin', model: 'fixture-model', providers })
    }
    await useSettingsStore.getState().saveProvider('builtin', { name: '内置助手' })
    assert.equal(useSettingsStore.getState().providers.builtin.name, '内置助手')
    assert.equal(useSettingsStore.getState().activeProvider, 'builtin')
    assert.equal(useSettingsStore.getState().model, 'fixture-model')
  })

  it('saves the OpenAI full URL mode independently from the Claude Code URL mode', async () => {
    globalThis.window = {}
    const updates = { base_url_is_full: false, openai_base_url: 'https://example.com/custom/?version=2', openai_base_url_is_full: true }
    globalThis.fetch = async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { provider: 'custom', ...updates })
      return Response.json({ active_provider: 'custom', providers: { custom: updates } })
    }
    await useSettingsStore.getState().saveProvider('custom', updates)
    assert.deepEqual(useSettingsStore.getState().providers.custom, updates)
  })

  it('saves exact endpoint text and full URL mode without appending or removing any suffix', async () => {
    globalThis.window = {}
    const endpoint = 'https://example.com/custom/infer/?api-version=1&route=a%2Fb'
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'custom', base_url: endpoint, base_url_is_full: true })
      return Response.json({ active_provider: 'custom', providers: { custom: { base_url: endpoint, base_url_is_full: true } } })
    }
    await useSettingsStore.getState().saveProvider('custom', { base_url: endpoint, base_url_is_full: true })
    assert.equal(useSettingsStore.getState().providers.custom.base_url, endpoint)
    assert.equal(useSettingsStore.getState().providers.custom.base_url_is_full, true)
  })

  it('adds the same supplier twice using distinct configuration IDs', async () => {
    globalThis.window = {}
    const providers = { deepseek: { has_key: true, model: 'legacy-model' } }
    let sequence = 0
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider/add'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'deepseek' })
      const id = `model-${++sequence}`
      providers[id] = { provider_id: 'deepseek', model: 'new-model', added: true, visible: true }
      return Response.json({ active_provider: 'anthropic', providers, created_provider: id })
    }
    const first = await useSettingsStore.getState().addProvider('deepseek')
    const second = await useSettingsStore.getState().addProvider('deepseek')
    assert.notEqual(first, second)
    assert.equal(useSettingsStore.getState().providers.deepseek.model, 'legacy-model')
    assert.equal(useSettingsStore.getState().providers[first].provider_id, 'deepseek')
    assert.equal(useSettingsStore.getState().providers[second].provider_id, 'deepseek')
  })

  it('activates a provider using its saved model and updates the shared settings', async () => {
    globalThis.window = {}
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider/activate'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'custom' })
      return Response.json({ active_provider: 'custom', model: 'saved-model', providers: { custom: { model: 'saved-model' } } })
    }
    await useSettingsStore.getState().activateProvider('custom')
    assert.equal(useSettingsStore.getState().activeProvider, 'custom')
    assert.equal(useSettingsStore.getState().model, 'saved-model')
  })

  it('changes only the model without overwriting credentials or other provider settings', async () => {
    globalThis.window = {}
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'custom', model: 'new-model' })
      return Response.json({ active_provider: 'custom', model: 'new-model', providers: { custom: { model: 'new-model' } } })
    }
    await useSettingsStore.getState().saveProvider('custom', { model: 'new-model' })
    assert.equal(useSettingsStore.getState().model, 'new-model')
    assert.equal(useSettingsStore.getState().providers.custom.model, 'new-model')
  })

  it('persists an explicitly selected provider before its credentials are configured', async () => {
    globalThis.window = {}
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'anthropic', added: true })
      return Response.json({
        active_provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        providers: { anthropic: { added: true, visible: true, has_key: false } },
      })
    }
    await useSettingsStore.getState().saveProvider('anthropic', { added: true })
    assert.equal(useSettingsStore.getState().providers.anthropic.added, true)
    assert.equal(useSettingsStore.getState().providers.anthropic.visible, true)
  })

  it('preserves the previous selection when activation or saving fails', async () => {
    globalThis.window = {}
    globalThis.fetch = async () => Response.json({ detail: '请先配置供应商' }, { status: 400 })
    await assert.rejects(useSettingsStore.getState().activateProvider('custom'), /请先配置/)
    await assert.rejects(useSettingsStore.getState().saveProvider('custom', { model: 'new-model' }), /请先配置/)
    assert.equal(useSettingsStore.getState().activeProvider, initialState.activeProvider)
    assert.equal(useSettingsStore.getState().model, initialState.model)
  })

  it('loads the same catalog endpoint as settings with cancellation support', async () => {
    globalThis.window = {}
    const controller = new AbortController()
    globalThis.fetch = async (url, options) => {
      assert.ok(url.endsWith('/settings/provider/models'))
      assert.deepEqual(JSON.parse(options.body), { provider: 'custom' })
      assert.equal(options.signal, controller.signal)
      return Response.json({ models: ['model-a', 'model-b'], source: 'remote' })
    }
    assert.deepEqual(await fetchProviderModels({ provider: 'custom' }, controller.signal), {
      models: ['model-a', 'model-b'], source: 'remote',
    })
  })
})
