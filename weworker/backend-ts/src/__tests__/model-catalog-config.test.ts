import { expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import { modelCatalogConfigPatch, resolveModelCatalogConfig, resolveModelCatalogEndpoint } from '../model-catalog-config.js'
import { listProviderModels, probeTimedMainConnection } from '../provider-model-services.js'
import { createModelConfiguration, updateModelConfiguration, activateModelConfiguration, publicModelConfigurations } from '../model-configurations.js'
import { getProvider } from '../provider-registry.js'

const catalogUrl = 'https://example.org/models/?api-version=1&route=a%2Fb'
const input = { provider: getProvider('custom')!, apiKey: 'fixture-main-key', model: 'fixture-model',
  anthropicBaseUrl: 'https://example.com/anthropic', anthropicAuthType: 'api_key' as const,
  modelsUrl: catalogUrl, modelsAuthType: 'auth_token' as const, target: 'weworker' as const }

it.each([
  ['https://example.com', 'https://example.com/v1/models'],
  ['https://example.com/', 'https://example.com/v1/models'],
  ['https://example.com/proxy/', 'https://example.com/proxy/v1/models'],
  ['https://example.com/v1/', 'https://example.com/v1/models'],
  ['https://example.com/proxy/v2', 'https://example.com/proxy/v2/models'],
  ['https://example.com/v1/models/', 'https://example.com/v1/models'],
  ['https://example.com/models', 'https://example.com/models'],
])('completes catalog base URL %s without duplicating suffixes', (base, expected) => {
  expect(resolveModelCatalogEndpoint(base, false)).toBe(expected)
})

it('preserves exact complete URLs and treats legacy URLs without a mode as complete', () => {
  expect(resolveModelCatalogEndpoint(catalogUrl, true)).toBe(catalogUrl)
  expect(resolveModelCatalogEndpoint(catalogUrl)).toBe(catalogUrl)
  expect(() => resolveModelCatalogEndpoint(catalogUrl, false)).toThrow()
  expect(() => modelCatalogConfigPatch({ models_url_is_full: 'false' })).toThrow()
  expect(() => modelCatalogConfigPatch({ models_url_is_full: false }, { models_url: catalogUrl })).toThrow()
  expect(resolveModelCatalogConfig({ models_url_is_full: false }, { models_url: 'https://example.com/v1', models_url_is_full: true }))
    .toEqual({ models_url: 'https://example.com/v1', models_url_is_full: false })
})

it.each(['weworker', 'webwright'] as const)('uses the saved base mode for %s catalog requests independently of inference URL modes', async target => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
  const result = await listProviderModels({ ...input, target, modelsUrl: 'https://example.com/', modelsUrlIsFull: false,
    openaiModelsUrl: 'https://example.org/v1/', openaiModelsUrlIsFull: false, openaiApiKey: 'fixture-openai-key',
    anthropicFullUrl: true, openaiFullUrl: true }, fetchMock)
  expect(result.source).toBe('remote')
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([target === 'weworker' ? 'https://example.com/v1/models' : 'https://example.org/v1/models'])
})

it('preserves legacy catalog settings while new configurations start with empty base-mode catalogs', () => {
  const legacy = { added_providers: [], api_key_custom: 'fixture-key', base_url_custom: 'https://example.com',
    models_url_custom: catalogUrl, openai_models_url_custom: 'https://example.org/v1', openai_models_url_is_full_custom: false } as unknown as Settings
  const created = createModelConfiguration(legacy, 'custom')
  let state = { ...legacy, ...created.updates }
  expect(state.model_configurations[created.id]).toMatchObject({ models_url: '', models_url_is_full: false, openai_models_url_is_full: false })
  expect(state.models_url_custom).toBe(catalogUrl)
  state = { ...state, ...updateModelConfiguration(state, created.id, { models_url: 'https://example.com/v1', models_url_is_full: false }) }
  const copy = createModelConfiguration(state, 'custom')
  expect(copy.updates.model_configurations[copy.id]).toMatchObject({ models_url: '', models_url_is_full: false, openai_models_url_is_full: false })
  expect(copy.updates.model_configurations[created.id]).toMatchObject({ models_url: 'https://example.com/v1', models_url_is_full: false })
  expect(() => updateModelConfiguration(state, created.id, { models_url: catalogUrl })).toThrow()
})

it('uses the exact catalog URL and independent auth header while conversation requests keep their original address', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (url) => String(url) === catalogUrl
    ? Response.json({ data: [{ id: 'fixture-model' }] })
    : Response.json({ content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }] }))
  expect(await listProviderModels(input, fetchMock)).toEqual({ source: 'remote', models: ['fixture-model'] })
  expect(fetchMock.mock.calls[0][0]).toBe(catalogUrl)
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer fixture-main-key')
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('x-api-key')).toBe(false)
  expect((await probeTimedMainConnection(input, fetchMock)).ok).toBe(true)
  expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/anthropic/v1/messages')
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-api-key')).toBe('fixture-main-key')
})

it.each(['weworker', 'webwright'] as const)('supports %s full inference URLs with an explicit catalog endpoint', async target => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
  const result = await listProviderModels({ ...input, target, anthropicFullUrl: true,
    anthropicBaseUrl: 'https://example.com/custom-messages', openaiFullUrl: true, openaiBaseUrl: 'https://example.com/custom-completion',
    openaiApiKey: 'fixture-exploration-key', openaiModelsUrl: 'https://example.org/openai-models' }, fetchMock)
  expect(result.source).toBe('remote')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe(target === 'weworker' ? catalogUrl : 'https://example.org/openai-models')
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe(target === 'weworker' ? 'Bearer fixture-main-key' : 'Bearer fixture-exploration-key')
})

it('inherits authentication when requested and retains the old derived URL when the override is cleared', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
  await listProviderModels({ ...input, modelsAuthType: 'inherit' }, fetchMock)
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-api-key')).toBe('fixture-main-key')
  await listProviderModels({ ...input, modelsUrl: '' }, fetchMock)
  expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/anthropic/v1/models?limit=1000')
})

it('validates explicit URLs and distinguishes an omitted setting from a cleared one', () => {
  for (const url of ['invalid', 'file:///fixture', 'https://user:password@example.com/models', 'https://example.com/models#fragment', 42]) {
    expect(() => modelCatalogConfigPatch({ models_url: url })).toThrow()
  }
  expect(() => modelCatalogConfigPatch({ models_auth_type: 'invalid' })).toThrow()
  expect(resolveModelCatalogConfig({}, { models_url: catalogUrl })).toEqual({ models_url: catalogUrl })
  expect(resolveModelCatalogConfig({ models_url: '' }, { models_url: catalogUrl })).toEqual({ models_url: '' })
})

it('preserves legacy catalog fields and keeps new configuration edits independent', () => {
  const legacy = { added_providers: [], model_configurations: {}, base_url_custom: 'https://example.com/anthropic',
    custom_auth_type: 'api_key', api_key_custom: 'fixture-main-key', openai_base_url_custom: '',
    models_url_custom: catalogUrl, models_auth_type_custom: 'auth_token' } as unknown as Settings
  const created = createModelConfiguration(legacy, 'custom')
  let state = { ...legacy, ...created.updates }
  expect(state.model_configurations[created.id].models_url).toBe('')
  expect(state.models_url_custom).toBe(catalogUrl)
  state = { ...state, ...updateModelConfiguration(state, created.id, { api_key: 'fixture-new-key', base_url: 'https://example.org/anthropic', auth_type: 'api_key', model: 'fixture-model', models_url: 'https://example.org/v1/models', openai_models_url: catalogUrl, openai_models_url_is_full: true }) }
  expect(activateModelConfiguration(state, created.id)).toMatchObject({ base_url: 'https://example.org/anthropic', active_auth_type: 'api_key' })
  expect(publicModelConfigurations(state)[created.id]).toMatchObject({ models_url: 'https://example.org/v1/models', openai_models_url: catalogUrl })
  state = { ...state, ...updateModelConfiguration(state, created.id, { models_url: '' }) }
  expect(state.model_configurations[created.id].models_url).toBe('')
  expect(state.models_url_custom).toBe(catalogUrl)
  expect(createModelConfiguration(state, 'custom').updates.model_configurations).toMatchObject({ [created.id]: { models_url: '' } })
})
