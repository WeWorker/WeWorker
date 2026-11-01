import { describe, expect, it, beforeEach } from 'vitest'
import {
  applySecrets,
  collectPlaintextSecretsFromRaw,
  extractSecrets,
  rawFileHasPlaintextSecrets,
  clearSecretsOnDisk,
} from '../settings-secrets.js'
import type { Settings } from '../config.js'

const baseSettings = (): Settings => ({
  onboarding_completed: true,
  active_provider: 'anthropic',
  api_key: 'active-key',
  base_url: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-6',
  context_limit: 1_000_000,
  api_key_anthropic: 'anthropic-key',
  model_anthropic: 'claude-sonnet-4-6',
  context_limit_anthropic: 1_000_000,
  api_key_glm: '',
  model_glm: 'glm-4.7',
  context_limit_glm: 1_000_000,
  api_key_deepseek: '',
  model_deepseek: 'deepseek-chat',
  context_limit_deepseek: 1_000_000,
  api_key_custom: '',
  openai_api_key_custom: '',
  model_custom: '',
  openai_model_custom: '',
  context_limit_custom: 1_000_000,
  base_url_custom: '',
  openai_base_url_custom: '',
  exploration_base_url: '',
  exploration_api_key: 'fixture-exploration-key',
  exploration_model: '',
  exploration_use_main_key: true,
  custom_auth_type: 'auth_token',
  added_providers: [],
  channels: {
    qq: { enabled: true, app_id: 'qq-id', app_secret: 'qq-secret', owner_user_id: 'owner-1', owner_permission_level: 'full' },
    weixin: { enabled: true, token: 'wx-token', base_url: '', owner_user_id: '', owner_permission_level: 'full' },
    wecom: { enabled: true, bot_id: 'bot', secret: 'wecom-secret', owner_user_id: '', owner_permission_level: 'full' },
    feishu: { enabled: true, app_id: 'feishu-app', app_secret: 'feishu-secret', owner_user_id: '', owner_permission_level: 'full' },
  },
  site_toggles: {},
  custom_test_prompts: {},
  label_names: {},
  user_directory: '',
  download_directory: '',
  max_chat_attachments: 60,
  paste_text_attachment_threshold: 20000,
  open_browser_allowed_origins: [],
  api_query_llm_route: true,
  welcome_featured_site_limit: 50,
  resource_preview_extensions: null,
  user_directory_blacklist: [],
  zcf_default_role: 'weworker-clear',
  zcf_enabled_roles: ['weworker-clear'],
  zcf_custom_roles: [],
  memory_budgets: { user_usage: 800, task_execution: 1600, other: 1200, extension: 800 },
  scheduled_task_history_limit: 50,
})

describe('settings-secrets', () => {
  it('extracts and applies secret fields', () => {
    const settings = baseSettings()
    const secrets = extractSecrets(settings)
    expect(secrets['api_key_anthropic']).toBe('anthropic-key')
    expect(secrets['channels.qq.app_secret']).toBe('qq-secret')

    const cleared = applySecrets(settings, {})
    expect(cleared.api_key_anthropic).toBe('')
    expect(cleared.channels.qq.app_secret).toBe('')
    expect(secrets.exploration_api_key).toBe('fixture-exploration-key')
    expect(clearSecretsOnDisk(settings).exploration_api_key).toBe('')
    expect(applySecrets(cleared, secrets).exploration_api_key).toBe('fixture-exploration-key')
    expect(secrets['channels.feishu.app_secret']).toBe('feishu-secret')
    expect(clearSecretsOnDisk(settings).channels.feishu.app_secret).toBe('')
    expect(applySecrets(cleared, secrets).channels.feishu.app_secret).toBe('feishu-secret')
  })

  it('detects legacy plaintext secrets in raw settings', () => {
    const raw = {
      api_key_custom: 'legacy-key',
      channels: { wecom: { secret: 'legacy-secret' } },
    }
    expect(rawFileHasPlaintextSecrets(raw)).toBe(true)
    expect(collectPlaintextSecretsFromRaw(raw)['api_key_custom']).toBe('legacy-key')
  })
})

describe('secret-store', () => {
  beforeEach(() => {
    process.env.WEWORKER_TEST_MASTER_KEY = '0123456789abcdef0123456789abcdef'
  })

  it('encrypts and decrypts secrets with SM4', async () => {
    const { initSecretStore, encryptSecret, decryptSecret } = await import('../secret-store.js')
    await initSecretStore()
    const encrypted = encryptSecret('super-secret-key')
    expect(encrypted).not.toBe('super-secret-key')
    expect(decryptSecret(encrypted)).toBe('super-secret-key')
  })
})
