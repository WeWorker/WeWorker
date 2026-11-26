import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import { automaticWorkshopUpdate } from '../adapter-workshop-config.js'
import { getModelConfiguration, updateModelConfiguration, publicModelConfigurations,
  renameModelConfiguration } from '../model-configurations.js'
import { getProvider } from '../provider-registry.js'
import { configuredModel, explorationResetPatch } from '../provider-config.js'
import { isBuiltinProvider } from '../builtin-provider.js'
import { isLlmProtocol, normalizeLlmUrlInput } from '../llm-egress.js'
import { isAnthropicAuthType } from '../anthropic-auth.js'
import { MODEL_CONTEXT_LIMIT_ERROR, parseModelContextLimit } from '../context-window.js'
import { modelCatalogConfigPatch } from '../model-catalog-config.js'
import { resolveWebwrightModelConfig } from '../webwright-model-config.js'

function fixture(fetchImpl: typeof fetch) {
  let state = { active_provider: 'custom', active_model_configuration: 'fixture', added_providers: [],
    model_configurations: { fixture: { provider_id: 'custom', name: 'Fixture',
      api_key: 'fixture-key', model: 'fixture-model', base_url: 'https://example.com/gateway',
      openai_base_url: '', auth_type: 'api_key', context_limit: 200000, weworker_protocol: 'anthropic_messages' } },
  } as unknown as Settings
  let handler: (req: any, res: any) => Promise<void>
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.post('/settings/provider',")
  const end = source.indexOf('\napp.post(', start + 1)
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    app: { post: (_path: string, callback: typeof handler) => { handler = callback } },
    getSettings: () => state, updateSettings: (patch: Partial<Settings>) => (state = { ...state, ...patch }),
    buildSettingsResponse: (s: Settings) => ({ providers: publicModelConfigurations(s) }),
    getModelConfiguration, updateModelConfiguration, renameModelConfiguration,
    automaticWorkshopUpdate: (current: any, next: any, input: any) => automaticWorkshopUpdate(current, next, input, fetchImpl),
    ALLOWED_PROVIDER_IDS: new Set(['custom']), getProvider, configuredModel, explorationResetPatch,
    isBuiltinProvider, isLlmProtocol, normalizeLlmUrlInput, isAnthropicAuthType, parseModelContextLimit, MODEL_CONTEXT_LIMIT_ERROR, modelCatalogConfigPatch,
  })
  return {
    state: () => state,
    async save(input: Record<string, unknown>, provider = 'fixture') {
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
      await handler!({ body: { provider, ...input } }, res)
      expect(res.status).not.toHaveBeenCalled()
      return res.json.mock.calls[0][0]
    },
  }
}

describe('saving main model automatically configures Adapter workshop', () => {
  it('persists verified Anthropic sibling with saved credentials and preserves active chat protocol', async () => {
    const f = fixture(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
    const response = await f.save({ base_url: 'https://example.com/gateway', model: 'fixture-model', api_key: '',
      openai_base_url: '', openai_model: 'fixture-model' })
    expect(f.state().model_configurations!.fixture).toMatchObject({
      weworker_protocol: 'anthropic_messages', openai_base_url: 'https://example.com/gateway/v1',
      openai_api_key: 'fixture-key', openai_model: 'fixture-model',
    })
    expect(f.state().active_weworker_protocol).toBe('anthropic_messages')
    expect(resolveWebwrightModelConfig(f.state())).toMatchObject({
      protocol: 'openai_chat_completions', base_url: 'https://example.com/gateway/v1', api_key: 'fixture-key',
    })
    expect(response.providers.fixture.openai_base_url).toBe('https://example.com/gateway/v1')
    expect(JSON.stringify(response)).not.toContain('fixture-key')
  })

  it('keeps the main save working when OpenAI is unavailable without adding a guessed endpoint', async () => {
    const f = fixture(async () => new Response('{}', { status: 401 }))
    await f.save({ base_url: 'https://example.org/anthropic', model: 'fixture-next-model' })
    expect(f.state().model_configurations!.fixture).toMatchObject({ model: 'fixture-next-model', openai_base_url: '' })
  })

  it('configures OpenAI chat directly and preserves main protocol', async () => {
    const f = fixture(async () => { throw new Error('no probe needed') })
    await f.save({ base_url: 'https://example.org/v1', weworker_protocol: 'openai_chat_completions' })
    expect(f.state().model_configurations!.fixture).toMatchObject({ weworker_protocol: 'openai_chat_completions',
      openai_base_url: 'https://example.org/v1', openai_api_key: 'fixture-key', openai_model: 'fixture-model' })
    expect(f.state().active_weworker_protocol).toBe('openai_chat_completions')
  })

  it('also handles the legacy custom configuration path', async () => {
    const f = fixture(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
    f.state().active_model_configuration = ''
    await f.save({ api_key: 'fixture-legacy-key', model: 'fixture-model',
      base_url: 'https://example.org/anthropic', weworker_protocol: 'anthropic_messages' }, 'custom')
    expect(f.state()).toMatchObject({ openai_base_url_custom: 'https://example.org/anthropic/v1',
      openai_api_key_custom: 'fixture-legacy-key', openai_model_custom: 'fixture-model',
      active_weworker_protocol: 'anthropic_messages' })
  })
})
