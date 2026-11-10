import fs from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { LlmProtocol } from './llm-egress.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

export interface HarnessProvider {
  slot: string
  key: string
  url: string
  model: string
  protocol: LlmProtocol
}

// Read data only: never boot DSH, load plugin bundles, or follow user-supplied
// credential file paths. YAML diagnostics may contain secrets and stay private.
export async function discoverHarnessProviders(home: string, env: NodeJS.ProcessEnv) {
  const configuredRoot = text(env.DSH_HOME)
  const root = configuredRoot === '~' ? home : /^~[/\\]/.test(configuredRoot)
    ? path.join(home, configuredRoot.slice(2)) : configuredRoot || path.join(home, '.dsh')
  const providers: HarnessProvider[] = []
  let issue = false
  try {
    if (!(await fs.stat(root)).isDirectory()) return { providers, issue: true }
  } catch (error) { return { providers, issue: (error as NodeJS.ErrnoException).code !== 'ENOENT' } }
  async function read(file: string, fallback: unknown): Promise<unknown> {
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(file, 'r')
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid configuration file')
      const document = parseDocument(await handle.readFile('utf8'), { uniqueKeys: true })
      if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML')
      return document.toJS({ maxAliasCount: 50 }) ?? fallback
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      issue = true
      return null
    } finally { await handle?.close() }
  }

  const credentialDocument = await read(path.join(root, '.credentials.yaml'), {})
  if (credentialDocument === null || Array.isArray(credentialDocument) || typeof credentialDocument !== 'object') return { providers, issue: true }
  const credentials = object(credentialDocument)
  // Current versioned store and the pre-release flat reference map.
  const legacy = !Object.hasOwn(credentials, 'version') && Object.values(credentials).every(value => typeof value === 'string')
  const validCredentials = credentials.version === 1 || legacy
  if (!validCredentials) return { providers, issue: true }
  const refs = legacy ? credentials : validCredentials ? object(credentials.refs) : {}
  const records = validCredentials ? object(credentials.records) : {}
  const resolveKey = (reference: string) => Object.hasOwn(refs, reference) ? text(refs[reference]) : text(env[reference])
  const homePatch = await read(path.join(root, 'cordis.patch.yml'), [])
  if (!Array.isArray(homePatch)) return { providers, issue: true }
  let profiles: string[] = []
  try {
    profiles = (await fs.readdir(path.join(root, 'profiles'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name).sort().slice(0, 100)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue = true }
  // A stored official key also works before a profile has a user patch.
  if (!profiles.length) profiles = ['']
  const protocols: Record<string, LlmProtocol> = {
    'openai-completions': 'openai_chat_completions',
    'openai-responses': 'openai_responses',
    'anthropic-messages': 'anthropic_messages',
  }
  // 新版凭据以 records 保存登录令牌（deepseek-account-platform/default → payload.token），
  // 没有 refs 映射；只把 grant 记录的 token 当作官方 key，会话 secret 不在取值范围内。
  const storedToken = (() => {
    const preferred = object(records['deepseek-account-platform/default'])
    for (const record of [preferred, ...Object.values(records).map(object)]) {
      const payload = object(record.payload)
      const token = text(payload.token)
      if (token) return token
    }
    return ''
  })()
  function addModels(slot: string, config: ObjectValue, key: string, url: string, protocol: LlmProtocol) {
    if (!key || !url) return
    const models = Array.isArray(config.models) ? config.models.slice(0, 100).map(model => text(object(model).id)).filter(Boolean) : ['']
    for (const model of new Set(models)) providers.push({ slot: `${slot}/${model}`, key, url, model, protocol })
  }
  for (const profile of profiles) {
    const profilePatch = profile ? await read(path.join(root, 'profiles', profile, 'cordis.patch.yml'), []) : []
    if (!Array.isArray(profilePatch)) { issue = true; continue }
    const entries = new Map<string, ObjectValue>([['llm-deepseek', { id: 'llm-deepseek' }]])
    // Cordis config patches replace the complete entry config; the home patch
    // takes precedence over a profile patch, rather than merging providers.
    for (const layer of [profilePatch, homePatch]) {
      if (!Array.isArray(layer)) { issue = true; continue }
      for (const raw of layer) {
        const entry = object(raw)
        const id = text(entry.id) || text(entry.name)
        if (id) entries.set(id, { ...entries.get(id), ...entry })
      }
    }
    for (const [id, entry] of entries) {
      if (entry.disabled === true) continue
      const name = text(entry.name)
      const config = object(entry.config)
      const official = name ? ['@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-llm-deepseek'].includes(name) : id === 'llm-deepseek'
      if (official) {
        addModels(`${profile}/${id}`, config, resolveKey(text(config.apiKeyEnv) || 'DEEPSEEK_API_KEY') || storedToken,
          text(config.baseURL) || text(env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com/anthropic', 'anthropic_messages')
      } else if (name === '@deepseek-ai/dsh-llm-pi-ai' || (!name && id === 'llm-pi-ai')) {
        for (const [providerId, rawConfig] of Object.entries(object(config.providers)).slice(0, 100)) {
          const provider = object(rawConfig)
          const protocol = Object.hasOwn(protocols, text(provider.api)) ? protocols[text(provider.api)] : undefined
          // A plugin catalog may define arbitrary protocols/endpoints. Only
          // explicit routes can be reproduced without executing those plugins.
          if (!protocol || !text(provider.baseURL)) continue
          const reference = text(provider.apiKeyEnv)
          const record = object(records[`llm-pi-ai/${providerId}`])
          const key = reference ? resolveKey(reference) : record.kind === 'api-key' ? text(record.key) : ''
          addModels(`${profile}/${id}/${providerId}`, provider, key, text(provider.baseURL), protocol)
        }
      }
    }
  }
  return { providers, issue }
}
