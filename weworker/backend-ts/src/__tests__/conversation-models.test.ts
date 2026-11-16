import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../config.js'
import type { Express } from 'express'
import { createConversationModelStore, defaultConversationModel, resolveConversationModelSettings, parseConversationModel, registerConversationModelRoutes } from '../conversation-models.js'

function defaults(): Settings {
  return { active_provider: 'custom', active_model_configuration: 'example-a', model: 'default-a', api_key: 'placeholder-a',
    base_url: 'https://example.com/v1', context_limit: 200000, model_configurations: {
      'example-a': { provider_id: 'custom', model: 'default-a', api_key: 'placeholder-a', base_url: 'https://example.com/v1', context_limit: 200000, auth_type: 'api_key', openai_base_url: '' },
      'example-b': { provider_id: 'custom', model: 'default-b', api_key: 'placeholder-b', base_url: 'https://example.org/infer', base_url_is_full: true,
        weworker_protocol: 'openai_chat_completions', context_limit: 128000, auth_type: 'auth_token', openai_base_url: '' },
    } } as unknown as Settings
}

describe('conversation-specific model configuration', () => {
  it('route writes only the selected conversation and rejects running or missing conversations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-route-test-'))
    try {
      const models = createConversationModelStore(path.join(dir, 'models.json'))
      const settings = defaults(), before = structuredClone(settings)
      const handlers = new Map<string, Function>()
      registerConversationModelRoutes({ get: (p: string, h: Function) => handlers.set('GET ' + p, h), post: (p: string, h: Function) => handlers.set('POST ' + p, h) } as unknown as Express,
        { getSettings: () => settings, hasWork: id => id !== 'missing', isBusy: id => id === 'running', models })
      let data: any, status = 200
      const res = { json(value: unknown) { data = value; return this }, status(value: number) { status = value; return this } }
      const selection = { provider: 'example-b', model: 'session-b', thinking_effort: 'high' }
      handlers.get('POST /works/:id/model')!({ params: { id: 'a' }, body: selection }, res)
      expect(data).toMatchObject({ ...selection, context_limit: 128000 })
      expect(settings).toEqual(before)
      handlers.get('GET /works/:id/model')!({ params: { id: 'b' } }, res)
      expect(data.model).toBe('default-a')
      handlers.get('POST /works/:id/model')!({ params: { id: 'running' }, body: selection }, res)
      expect(status).toBe(409)
      expect(models.get('running')).toBeUndefined()
      handlers.get('POST /works/:id/model')!({ params: { id: 'missing' }, body: selection }, res)
      expect(status).toBe(404)
      expect(models.get('a')).toEqual(selection)
      models.set('deleted-config', { provider: 'missing-config', model: 'old-model' })
      handlers.get('GET /works/:id/model')!({ params: { id: 'deleted-config' } }, res)
      expect(data).toMatchObject({ provider: 'missing-config', model: 'old-model', unavailable: true })
      handlers.get('POST /works/:id/model')!({ params: { id: 'deleted-config' }, body: selection }, res)
      expect(data).toMatchObject(selection)
      expect(data.unavailable).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('resolves a session model without modifying defaults or provider configurations', () => {
    const settings = defaults(), original = structuredClone(settings)
    const runtime = resolveConversationModelSettings(settings, { provider: 'example-b', model: 'session-b' })
    expect(runtime).toMatchObject({ active_provider: 'custom', active_model_configuration: 'example-b', model: 'session-b', api_key: 'placeholder-b',
      base_url: 'https://example.org/infer', base_url_is_full: true, active_weworker_protocol: 'openai_chat_completions', active_auth_type: 'auth_token', context_limit: 128000 })
    expect(settings).toEqual(original)
    expect(defaultConversationModel(settings)).toEqual({ provider: 'example-a', model: 'default-a', thinking_effort: 'off' })
  })
  it('retains each session across reload while new sessions inherit new defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-model-test-'))
    const file = path.join(dir, 'models.json')
    try {
      const store = createConversationModelStore(file)
      const settings = defaults()
      store.ensure('a', defaultConversationModel(settings))
      store.set('b', { provider: 'example-b', model: 'session-b', thinking_effort: 'high' })
      settings.model = 'changed-default'
      const restored = createConversationModelStore(file)
      expect(restored.ensure('a', defaultConversationModel(settings)).model).toBe('default-a')
      expect(restored.get('b')?.model).toBe('session-b')
      expect(restored.ensure('c', defaultConversationModel(settings)).model).toBe('changed-default')
      const serialized = fs.readFileSync(file, 'utf8')
      expect(serialized).not.toMatch(/placeholder|api_key|base_url/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('does not silently fall back to defaults when a session configuration disappears', () => {
    expect(() => resolveConversationModelSettings(defaults(), { provider: 'deleted', model: 'example' })).toThrow('不存在')
    expect(() => parseConversationModel({ provider: 'example-a', model: 'example', api_key: 'placeholder' })).toThrow()
    expect(() => parseConversationModel({ provider: 'example-a', model: 'example', thinking_effort: 'invalid' })).toThrow()
  })
  it('uses the selected builtin context limit instead of the default provider window', () => {
    const settings = { ...defaults(), context_limit: 1000000 }
    expect(resolveConversationModelSettings(settings, { provider: 'builtin', model: 'ignored' }).context_limit).toBe(200000)
    expect(resolveConversationModelSettings({ ...settings, builtin_context_limits: { builtin: 128000 } }, { provider: 'builtin', model: 'ignored' }).context_limit).toBe(128000)
  })
})
