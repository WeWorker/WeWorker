import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import type { Settings } from '../config.js'
import type { Express } from 'express'
import { createConversationModelStore, currentConversationModel, defaultConversationModel, initialConversationContextLimit, resolveConversationModelSettings, parseConversationModel, registerConversationModelRoutes, resolveWorkModelSettings } from '../conversation-models.js'
import { selectGenerationModel } from '../exploration-generation-model.js'

function defaults(): Settings {
  return { active_provider: 'custom', active_model_configuration: 'example-a', model: 'default-a', api_key: 'placeholder-a',
    base_url: 'https://example.com/v1', context_limit: 200000, model_configurations: {
      'example-a': { provider_id: 'custom', model: 'default-a', api_key: 'placeholder-a', base_url: 'https://example.com/v1', context_limit: 200000, auth_type: 'api_key', openai_base_url: '' },
      'example-b': { provider_id: 'custom', model: 'default-b', api_key: 'placeholder-b', base_url: 'https://example.org/infer', base_url_is_full: true,
        weworker_protocol: 'openai_chat_completions', context_limit: 128000, auth_type: 'auth_token', openai_base_url: '' },
    } } as unknown as Settings
}

describe('conversation-specific model configuration', () => {
  it('global activation overrides old selections, while new local selections leave defaults and in-flight snapshots intact', () => {
    const settings = { ...defaults(), model_selection_revision: 'revision-one' }
    const local = { provider: 'example-b', model: 'local-b', selection_revision: 'revision-one' }
    const running = resolveConversationModelSettings(settings, currentConversationModel(settings, local))
    const activated = { ...settings, model: 'global-next', model_selection_revision: 'revision-two' }
    expect(currentConversationModel(activated, local)).toEqual(defaultConversationModel(activated))
    expect(currentConversationModel(activated, { provider: 'example-b', model: 'legacy' })).toEqual(defaultConversationModel(activated))
    const newLocal = { ...local, model: 'next-local', selection_revision: 'revision-two' }
    expect(currentConversationModel(activated, newLocal)).toEqual(newLocal)
    expect(resolveConversationModelSettings(activated, currentConversationModel(activated, newLocal)).model).toBe('next-local')
    expect(activated.model).toBe('global-next')
    expect(running.model).toBe('local-b')
  })

  it('route writes only the selected conversation while running and rejects missing conversations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-route-test-'))
    try {
      const models = createConversationModelStore(path.join(dir, 'models.json'))
      const settings = defaults(), before = structuredClone(settings)
      const handlers = new Map<string, Function>()
      const onContextLimitChanged = vi.fn()
      registerConversationModelRoutes(Object.fromEntries(['GET', 'POST', 'PATCH'].map(method => [method.toLowerCase(),
        (p: string, h: Function) => handlers.set(`${method} ${p}`, h)])) as unknown as Express,
        { getSettings: () => settings, hasWork: id => id !== 'missing', isBusy: id => id === 'running', onContextLimitChanged, models, getGenerationWork: () => undefined })
      let data: any, status = 200
      const res = { json(value: unknown) { data = value; return this }, status(value: number) { status = value; return this } }
      const selection = { provider: 'example-b', model: 'session-b', thinking_effort: 'high' }
      handlers.get('POST /works/:id/model')!({ params: { id: 'a' }, body: selection }, res)
      expect(data).toMatchObject({ ...selection, context_limit: 128000 })
      expect(settings).toEqual(before)
      handlers.get('GET /works/:id/model')!({ params: { id: 'b' } }, res)
      expect(data.model).toBe('default-a')
      handlers.get('POST /works/:id/model')!({ params: { id: 'running' }, body: selection }, res)
      expect(status).toBe(200)
      expect(models.get('running')).toEqual(selection)
      handlers.get('POST /works/:id/model')!({ params: { id: 'missing' }, body: selection }, res)
      expect(status).toBe(404)
      expect(models.get('a')).toEqual(selection)
      models.set('deleted-config', { provider: 'missing-config', model: 'old-model' })
      handlers.get('GET /works/:id/model')!({ params: { id: 'deleted-config' } }, res)
      expect(data).toMatchObject({ provider: 'missing-config', model: 'old-model', unavailable: true })
      handlers.get('POST /works/:id/model')!({ params: { id: 'deleted-config' }, body: selection }, res)
      expect(data).toMatchObject(selection)
      expect(data.unavailable).toBeUndefined()
      settings.model_selection_revision = 'latest-revision'
      handlers.get('POST /works/:id/model')!({ params: { id: 'a' }, body: selection }, res)
      expect(status).toBe(409)
      expect(models.get('a')).toEqual(selection)
      handlers.get('GET /works/:id/model')!({ params: { id: 'a' } }, res)
      expect(data).toMatchObject({ provider: 'example-a', model: 'default-a', selection_revision: 'latest-revision', context_limit: 200_000 })
      const patch = handlers.get('PATCH /works/:id/context-limit')!
      for (const limit of [63_999, 960_001, 64_000.5, '80000', null]) {
        status = 200
        patch({ params: { id: 'a' }, body: { context_limit: limit } }, res)
        expect(status).toBe(400)
      }
      expect(models.getRecord('a').contextLimit).toBeUndefined()
      patch({ params: { id: 'missing' }, body: { context_limit: 80_000 } }, res)
      expect(status).toBe(404)
      status = 200
      patch({ params: { id: 'a' }, body: { context_limit: 80_000 } }, res)
      expect(status).toBe(200)
      expect(data).toEqual({ context_limit: 80_000 })
      expect(onContextLimitChanged).toHaveBeenCalledExactlyOnceWith('a')
      handlers.get('GET /works/:id/model')!({ params: { id: 'a' } }, res)
      expect(data).toMatchObject({ provider: 'example-a', context_limit: 80_000 })
      handlers.get('POST /works/:id/model')!({ params: { id: 'a' }, body: { ...selection, selection_revision: 'latest-revision' } }, res)
      expect(data).toMatchObject({ provider: 'example-b', context_limit: 80_000 })
      expect(models.getRecord('a').contextLimit).toBe(80_000)
      handlers.get('GET /works/:id/model')!({ params: { id: 'b' } }, res)
      expect(data.context_limit).toBe(200_000)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('pins the effective source model across global activation and reads the current Workshop credentials', () => {
    const settings = { ...defaults(), model_selection_revision: 'before' }
    const a = settings.model_configurations!['example-a']
    const b = settings.model_configurations!['example-b']
    a.openai_base_url = 'https://example.com/workshop'
    a.openai_model = 'workshop-a'
    const selected = selectGenerationModel(settings, { provider: '__exploration__:example-b', model: 'ignored-shared-model', selection_revision: 'before' })
    expect(selected).toEqual({ provider: 'example-b', model: 'default-b', selection_revision: 'before' })
    const activated = { ...settings, model_selection_revision: 'after', model_configurations: {
      ...settings.model_configurations, 'example-b': { ...b, model: 'new-b', api_key: 'fixture-key-rotated' },
    } }
    expect(selectGenerationModel(activated, selected)).toEqual({ provider: 'example-a', model: 'workshop-a', selection_revision: 'after' })
    const generationWork = { workId: 'owned', explorationId: 'example', runId: 'round-one' }
    expect(resolveWorkModelSettings('owned', activated, { ...generationWork, modelSelection: selected })).toMatchObject({
      model: 'default-b', api_key: 'fixture-key-rotated', base_url: 'https://example.org/infer', base_url_is_full: true,
      active_weworker_protocol: 'openai_chat_completions', active_auth_type: 'auth_token', context_limit: 128000,
    })
    expect(resolveWorkModelSettings('owned', activated, generationWork).model).toBe('workshop-a')
  })

  it('returns a read-only Workshop status and refuses ordinary model overrides for generation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-model-route-test-'))
    try {
      const models = createConversationModelStore(path.join(dir, 'models.json'))
      const settings = { ...defaults(), model_selection_revision: 'current' }
      const a = settings.model_configurations!['example-a']
      a.openai_base_url = 'https://example.com/workshop/v1'
      a.openai_api_key = 'fixture-workshop-key'
      const ordinary = { provider: 'example-b', model: 'ordinary-model', thinking_effort: 'off' as const }
      models.set('owned', ordinary, 96000)
      const handlers = new Map<string, Function>()
      registerConversationModelRoutes({ get: (p: string, h: Function) => handlers.set('GET ' + p, h), post: (p: string, h: Function) => handlers.set('POST ' + p, h), patch: (p: string, h: Function) => handlers.set('PATCH ' + p, h) } as unknown as Express, {
        getSettings: () => settings, hasWork: () => true, isBusy: () => false, models,
        getGenerationWork: id => id === 'owned' ? { workId: id, explorationId: 'example', runId: 'round-one',
          modelSelection: { provider: 'example-a', model: 'pinned-model', selection_revision: 'previous' } } : undefined,
      })
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis(), setHeader: vi.fn() }
      const req = { params: { id: 'owned' }, body: { ...ordinary, model: 'replacement' } }
      handlers.get('GET /works/:id/model')!(req, res)
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'example-a', model: 'pinned-model', read_only: true, context_limit: 96000 }))
      expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/example\.com|fixture-workshop-key/)
      handlers.get('POST /works/:id/model')!(req, res)
      expect(res.status).toHaveBeenLastCalledWith(409)
      expect(models.get('owned')).toEqual(ordinary)
      delete settings.model_configurations!['example-a']
      handlers.get('GET /works/:id/model')!(req, res)
      expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'pinned-model', read_only: true, unavailable: true }))
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
  it('snapshots the selected model budget at desktop creation and keeps it after settings change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-creation-test-'))
    const file = path.join(dir, 'models.json')
    try {
      const settings = { ...defaults(), model_selection_revision: 'current' }
      let create: Function | undefined
      let seq = 0
      const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
      const start = source.indexOf("app.post('/works',")
      const end = source.indexOf("\napp.patch('/works/:id/style'", start)
      vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText, {
        app: { post: (_path: string, callback: Function) => { create = callback } },
        store: { createWork: () => ({ id: `work-${++seq}` }) },
        conversationModels: createConversationModelStore(file), getSettings: () => settings,
        currentConversationModel, defaultConversationModel, initialConversationContextLimit, parseConversationModel,
        broadcastSSE: vi.fn(),
      })
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      const selected = settings.model_configurations!['example-b']
      const selection = { provider: 'example-b', model: 'different-model-name', selection_revision: 'current' }
      create!({ body: { model_selection: selection } }, res)
      selected.context_limit = 32_000
      create!({ body: { model_selection: selection } }, res)
      selected.context_limit = 1_000_000
      create!({ body: { model_selection: selection } }, res)
      create!({ body: {} }, res)
      expect(res.status).not.toHaveBeenCalled()
      const restored = createConversationModelStore(file)
      expect(restored.getRecord('work-1')).toMatchObject({ selection, contextLimit: 128_000 })
      expect(restored.getRecord('work-2').contextLimit).toBe(64_000)
      expect(restored.getRecord('work-3').contextLimit).toBe(960_000)
      expect(restored.getRecord('work-4').contextLimit).toBe(200_000)
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
