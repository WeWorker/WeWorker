import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildConfiguredModelEnv } from '../agent.js'

vi.mock('../config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../config.js')>()
  const os = await import('node:os')
  const fixtureRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-model-env-')), '.weworker')
  return { ...actual, getConfigDirectory: () => fixtureRoot }
})

const managedKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
]

const previous = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of managedKeys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('buildConfiguredModelEnv', () => {
  it.each([128000, 200000, 512000, 1000000])('passes the configured %s context window to the CLI instead of its unknown-model default', contextLimit => {
    const env = buildConfiguredModelEnv({
      api_key: 'fixture-key', base_url: 'https://example.com/anthropic', context_limit: contextLimit,
    }, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(contextLimit))
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(String(contextLimit))
  })
  it('uses WeWorker settings instead of inherited model auth env vars or .claude.json env', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-token'
    process.env.ANTHROPIC_BASE_URL = 'https://env.example.com'
    process.env.ANTHROPIC_MODEL = 'env-model'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-oauth'
    process.env.CLAUDE_CONFIG_DIR = 'C:\\Users\\someone\\.claude'

    const env = buildConfiguredModelEnv({
      api_key: 'settings-key',
      base_url: 'https://api.deepseek.com/anthropic/',
    })

    expect(env.ANTHROPIC_API_KEY).toBe('settings-key')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toContain('.weworker')
    expect(env.CLAUDE_CONFIG_DIR).not.toBe('C:\\Users\\someone\\.claude')
    expect(fs.statSync(path.join(env.CLAUDE_CONFIG_DIR!, 'skills')).isDirectory()).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8')).env).toEqual({})
  })

  it('removes inherited custom base url when settings use the default Anthropic endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://env.example.com'

    const env = buildConfiguredModelEnv({
      api_key: 'settings-key',
      base_url: 'https://api.anthropic.com',
    })

    expect(env.ANTHROPIC_API_KEY).toBe('settings-key')
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('allows the user-configured custom model base url at runtime', () => {
    const env = buildConfiguredModelEnv({
      api_key: 'settings-key',
      base_url: 'https://llm.example.com/anthropic/',
    })

    expect(env.ANTHROPIC_API_KEY).toBe('settings-key')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://llm.example.com/anthropic')
  })

  it('uses the Claude Code bearer token variable for custom providers', () => {
    const env = buildConfiguredModelEnv({
      active_provider: 'custom',
      api_key: 'custom-token',
      base_url: 'https://llm.example.com',
    })

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('custom-token')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('uses the detected API Key authentication for custom providers', () => {
    const env = buildConfiguredModelEnv({ active_provider: 'custom', api_key: 'fixture-custom-key', base_url: 'https://example.com/proxy', custom_auth_type: 'api_key' })
    expect(env.ANTHROPIC_API_KEY).toBe('fixture-custom-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('uses the known provider auth mode when a custom base url matches DeepSeek', () => {
    const env = buildConfiguredModelEnv({
      active_provider: 'custom',
      api_key: 'fixture-custom-deepseek-key',
      base_url: 'https://api.deepseek.com/anthropic/',
      custom_auth_type: 'auth_token',
    })

    expect(env.ANTHROPIC_API_KEY).toBe('fixture-custom-deepseek-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
  })
})
