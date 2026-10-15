import express from 'express'
import cors from 'cors'
import { createWebsiteExplorationRouter } from './website-exploration.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from './logger.js'
import { z } from 'zod'
import { bridgeStatus } from './bridge-status.js'
import { createAdapterStateRefreshHandler } from './adapter-state-refresh.js'
import { bridgeRpcClient } from './bridge-rpc-client.js'
import { explorationAgentCoordinator } from './exploration-agent.js'
import {
  expandHomePath,
  getSettings,
  initSettings,
  getUserDirectory,
  getDownloadDirectory,
  getDownloadSubdirectory,
  getUserDirectoryBlacklist,
  getPasteTextAttachmentThreshold,
  getWelcomeFeaturedSiteLimit,
  normalizeMaxChatAttachments,
  normalizePasteTextAttachmentThreshold,
  normalizeWelcomeFeaturedSiteLimit,
  updateSettings,
  getSiteEnabled,
  toggleSite,
  getSiteVisible,
  setSiteVisibility,
  setAllEnabledSitesWelcomeVisibility,
  DEFAULT_RESOURCE_PREVIEW_EXTENSIONS,
  getResourcePreviewExtensions,
  isResourcePreviewExtensionsCustomized,
  updateResourcePreviewExtensions,
  resetResourcePreviewExtensions,
  getOpenBrowserAllowedOrigins,
  normalizeOpenBrowserAllowedOrigin,
  normalizeOpenBrowserAllowedOrigins,
  type Settings,
} from './config.js'
import { normalizeDownloadSubdirectory } from './download-directory.js'
import {
  normalizeUserDirectoryBlacklist,
  countInvalidBlacklistEntries,
  type UserDirectoryBlacklistEntry,
} from './user-directory-blacklist.js'
import { isAllowedHost, isAllowedOrigin, isAuthorizedHttpRequest, LOCAL_HTTP_PORT, redactSensitive } from './http-security.js'
import { assertAllowedLlmBaseUrl, normalizeLlmBaseUrl } from './llm-egress.js'
import {
  ALLOWED_PROVIDER_IDS,
  PROVIDER_BASE_URLS,
  buildRuntimeAllowedLlmBaseUrls,
  findProviderByWeWorkerBaseUrl,
  getProvider,
} from './provider-registry.js'
import { listProviderModels, probeMainConnection, probeProviderProtocol, type ProbeTarget } from './provider-model-services.js'
import { registerExplorationModelRoutes } from './exploration-model-settings.js'
import { buildAnthropicAuthHeaders, isAnthropicAuthType } from './anthropic-auth.js'
import { parseContextLimit } from './context-window.js'
import { isAuthorizedModelConfigRequest, resolveWebwrightModelConfig } from './webwright-model-config.js'
import { assertAllowedWeixinBaseUrl, buildAllowedWeixinBaseUrls } from './channel-egress.js'
import { normalizeOwnerPermissionLevel, validateOwnerUserId } from './channels/channel-permissions.js'
import { clearAdapterCache, getRegistryDefaultIcon, getRegistryIconById, parseAllAdapters } from './adapter-parser.js'
import type { StaticToolDef } from './adapter-parser.js'
import { refreshDesktopAdapterSkills, toggleDesktopAdapter } from '../../../webcli/adapter-desktop.js'
import { findAdaptersDirectory, resolveToolsForAdapter } from './adapter-tool-list.js'
import { getOfficialScenarioDefs, resolveSiteScenarios } from './site-scenarios.js'
import { createUserScenario, deleteUserScenario, getCustomScenariosForSite, hasOfficialScenario, resetUserScenario, saveUserScenario } from './user-scenarios.js'
import type { ScenarioResetField } from './user-scenarios.js'
import {
  importCustomSkillResources,
  importSkillDirectoryResources,
  listCustomSkills,
  listSkillDirectoryResources,
  readResourceFilePreview,
  resolveCustomSkillAssetDir,
  saveCustomSkills,
  saveSkillDirectoryResources,
  DuplicateSkillNameError,
} from './custom-skills.js'
import { resolveWebcliEntry } from './webcli-path.js'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { getSiteMemory, listSiteMemories, saveSiteMemoryFromActionCapture, saveSiteMemoryFromWorkflow } from './site-memory.js'
import * as store from './works-store.js'
import { tryBackendProfileQueryRoute } from './profile-query-route.js'
import { buildConfiguredModelEnv, generateAssistantStatusLine, streamChat } from './agent.js'
import { ensureRuntimeSkillsDir } from './runtime-skills-dir.js'
import { renderPrompt } from './prompt-loader.js'
import {
  configureAdapterRuntimeReload,
  scheduleAdapterRuntimeReload,
} from './adapter-runtime-reload.js'
import {
  ensureBundledZcfInstalled,
  buildZcfCatalogResponse,
  getZcfPackageVersion,
  readZcfSyncMeta,
  resolveZcfPrefs,
  sanitizeZcfRoleSettingsPatch,
  sanitizeWorkZcfPrefsPatch,
  sanitizeZcfDefaultSettings,
  syncZcfTemplates,
  type ZcfLang,
} from './zcf-sync.js'
import { appendAssistantStatusLine, extractAssistantStatusLine, finalizeAssistantTextWithStatus } from './assistant-status.js'
import { processMemoryEvent } from './memory/memory-lifecycle.js'
import { buildMemoryEventContext } from './memory/memory-event-context.js'
import { planCompletedChatMemoryEvents, applyAdmissionToCandidate } from './memory/memory-event-planner.js'
import { isMemoryProtocolFailure } from './memory/memory-protocol.js'
import type { MemoryParseOutcome } from './memory/memory-extractor.js'
import { getMemoryStore } from './memory/memory-store.js'
import type { MemoryUpdateCandidate } from './memory/memory-types.js'
import { buildAgentFilesystemSettings, createUnifiedToolGuard } from './user-directory-access.js'
import { resolvePendingAskUser, resolveToolDisplayName } from './tools.js'
import { inferTerminalShell, onTerminalEvent, runWeWorkerPowerShell, stopTerminalSession } from './powershell-runner.js'
import { channelManager } from './channels/channel-manager.js'
import { QQChannel } from './channels/qq-channel.js'
import { WeixinChannel, fetchQRCode, pollQRStatus } from './channels/weixin-channel.js'
import { WecomChannel } from './channels/wecom-channel.js'
import { scheduler, Scheduler } from './scheduler.js'
import { broadcastSSE, registerSSEClient, unregisterSSEClient } from './notifier.js'
import {
  createUserFile,
  createUserFolder,
  deleteUserItem,
  getUserFileImportJob,
  importChatAttachments,
  importUserFiles,
  listUserFiles,
  pasteUserItem,
  renameUserItem,
  startUserFileImportJob,
} from './user-files.js'

const log = createLogger('server')
const chatLog = createLogger('chat')
const channelLog = createLogger('channels')

// Prevent Claude Agent SDK's internal async errors from crashing the process
// (e.g. writing to a closed transport after abort)
process.on('uncaughtException', (err) => {
  const msg = err.message || ''
  if (msg.includes('aborted') || msg.includes('Operation aborted') || msg.includes('ABORT_ERR')) {
    log.info('Ignoring abort-related uncaught exception:', msg)
    return
  }
  log.error('uncaughtException:', msg)
  log.error(err.stack || '')
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (msg?.includes('aborted') || msg?.includes('Operation aborted') || msg?.includes('ABORT_ERR')) {
    log.info('Ignoring abort-related unhandled rejection:', msg)
    return
  }
  log.error('unhandledRejection:', msg)
})

// Set process.resourcesPath for packaged app
if (process.env.WEWORKER_PACKAGED && process.env.WEWORKER_RESOURCES_PATH) {
  ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = process.env.WEWORKER_RESOURCES_PATH
}

const SKILLS_DIR = ensureRuntimeSkillsDir()

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Run the webcli CLI as a child process, picking the correct interpreter and
 * entry file for the current runtime.
 *
 * - Packaged app: the user has no system Node.js, so we reuse the Electron
 *   binary as a Node runtime (ELECTRON_RUN_AS_NODE=1) and run the esbuild
 *   bundle `webcli.cjs` (the source `index.js` is not shipped 鈥?it is merged
 *   into webcli.cjs at build time).
 * - Dev mode: use the system `node` to run the source entry `index.js`.
 *
 * The previous implementation hard-coded `execFile('node', [.../index.js])`,
 * which failed in packaged builds (no `node` on PATH, and `index.js` absent),
 * silently leaving the runtime skills directory empty.
 */
function runWebcli(extraArgs: string[], cb: (err: Error | null) => void = () => {}): void {
  const isPackaged = !!process.env.WEWORKER_PACKAGED

  const nodeBin = isPackaged
    ? (process.env.WEWORKER_EXEC_PATH || process.execPath)
    : 'node'

  const webcliEntry = resolveWebcliEntry()

  const env = {
    ...process.env,
    ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: getOpenBrowserAllowedOrigins().join(','),
  }

  log.info(`Running webcli: ${nodeBin} ${webcliEntry} ${extraArgs.join(' ')}`)
  execFile(nodeBin, [webcliEntry, ...extraArgs], { env }, (err, stdout, stderr) => {
    if (err) log.error(`webcli ${extraArgs.join(' ')} failed: ${err.message} ${stderr}`)
    else if (stdout?.trim()) log.info(`webcli ${extraArgs.join(' ')}: ${stdout.trim()}`)
    cb(err)
  })
}

function runWebcliAsync(extraArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    runWebcli(extraArgs, (err) => err ? reject(err) : resolve())
  })
}

configureAdapterRuntimeReload((siteKey) => (
  runWebcliAsync(['install', '--skills', siteKey, '--target', SKILLS_DIR])
))

bridgeStatus.onAdapterScaffoldGenerated(({ siteKey }) => {
  void scheduleAdapterRuntimeReload(siteKey).catch((e) => {
    log.error(`Failed to hot-reload generated adapter ${siteKey}: ${e instanceof Error ? e.message : String(e)}`)
  })
})
const handleAdapterStateRefresh = createAdapterStateRefreshHandler({
  clearCache: clearAdapterCache,
  refreshSkills: () => refreshDesktopAdapterSkills(SKILLS_DIR),
  broadcast: (event) => broadcastSSE(event),
})

bridgeStatus.onAdapterStateChanged(handleAdapterStateRefresh)

const app = express()
const HTTP_AUTH_TOKEN = process.env.WEWORKER_HTTP_TOKEN || ''
const BACKEND_INSTANCE_ID = process.env.WEWORKER_BACKEND_INSTANCE_ID || ''
const MODEL_CONFIG_TOKEN = process.env.WEWORKER_MODEL_CONFIG_TOKEN || ''

function requireHttpAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = req.header('X-WeWorker-Auth')
  if (!isAuthorizedHttpRequest(token, HTTP_AUTH_TOKEN)) {
    res.status(401).json({ detail: 'Unauthorized' })
    return
  }
  next()
}

app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host, LOCAL_HTTP_PORT)) {
    res.status(403).json({ detail: 'Forbidden host' })
    return
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    res.status(403).json({ detail: 'Forbidden origin' })
    return
  }
  next()
})

app.use(cors({
  origin(origin, cb) {
    cb(null, isAllowedOrigin(origin) ? (origin || false) : false)
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-WeWorker-Auth'],
  maxAge: 600,
}))

app.get('/internal/webwright/model-config', (req, res) => {
  if (!isAuthorizedModelConfigRequest(req.header('Authorization'), MODEL_CONFIG_TOKEN)) {
    res.status(401).json({ detail: 'Unauthorized' })
    return
  }
  try {
    const config = resolveWebwrightModelConfig(getSettings())
    res.setHeader('Cache-Control', 'no-store')
    res.json(config)
  } catch (error) {
    res.status(409).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})
app.use(requireHttpAuth)
app.use(express.json({ limit: '50mb' }))
app.use('/api/website-exploration', createWebsiteExplorationRouter())
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const detail = err instanceof Error ? err.message : String(err || '')
  const status = typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : 500
  const type = String((err as { type?: unknown })?.type || '')
  if (status === 413 || type === 'entity.too.large') {
    res.status(413).json({ detail: '上传内容过大，请拆分资源文件或压缩后再上传' })
    return
  }
  next(err)
})

const PORT = LOCAL_HTTP_PORT

// 鈹€鈹€ Status 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.get('/status', (_req, res) => {
  res.json({
    service: 'weworker-backend',
    runtime_mode: BACKEND_INSTANCE_ID ? 'managed' : 'standalone',
    backend_instance_id: BACKEND_INSTANCE_ID,
    bridge: bridgeStatus.isConnected() ? 'running' : 'disconnected',
    extension: bridgeStatus.isExtensionConnected() ? 'connected' : 'disconnected',
    extension_version: bridgeStatus.getExtensionVersion(),
    external_write: store.getLastExternalWrite(),
    channels: channelManager.getStatuses(),
  })
})

// 鈹€鈹€ Settings 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const ALLOWED_WEIXIN_BASE_URLS = buildAllowedWeixinBaseUrls()

function hostToOpenBrowserOrigins(rawHost: string): string[] {
  const host = String(rawHost || '').trim()
  if (!host || host.includes('*')) return []
  const candidates = /^https?:\/\//i.test(host)
    ? [host]
    : [`https://${host}`, `http://${host}`]
  return candidates
    .map((candidate) => normalizeOpenBrowserAllowedOrigin(candidate))
    .filter((origin): origin is string => Boolean(origin))
}

function buildDefaultOpenBrowserAllowedOrigins(): string[] {
  const origins = new Set<string>()
  for (const [adapterId, adapter] of parseAllAdapters()) {
    if (!getSiteEnabled(adapterId, adapter.defaultEnabled, adapter.managed?.enabled)) continue
    const homepageOrigin = normalizeOpenBrowserAllowedOrigin(adapter.homepageUrl)
    if (homepageOrigin) origins.add(homepageOrigin)
    for (const match of adapter.match || []) {
      for (const origin of hostToOpenBrowserOrigins(match)) origins.add(origin)
    }
  }
  return [...origins].sort()
}

function buildSettingsResponse(s: ReturnType<typeof getSettings>) {
  return {
    active_provider: s.active_provider,
    user_directory: s.user_directory,
    download_subdirectory: getDownloadSubdirectory(),
    download_directory: getDownloadDirectory(),
    max_chat_attachments: s.max_chat_attachments,
    paste_text_attachment_threshold: getPasteTextAttachmentThreshold(),
    welcome_featured_site_limit: getWelcomeFeaturedSiteLimit(),
    resource_preview_extensions: getResourcePreviewExtensions(),
    resource_preview_extensions_customized: isResourcePreviewExtensionsCustomized(),
    default_resource_preview_extensions: [...DEFAULT_RESOURCE_PREVIEW_EXTENSIONS],
    user_directory_blacklist: getUserDirectoryBlacklist(),
    default_open_browser_allowed_origins: buildDefaultOpenBrowserAllowedOrigins(),
    open_browser_allowed_origins: getOpenBrowserAllowedOrigins(),
    base_url: s.base_url,
    model: s.model,
    context_limit: s.context_limit,
    has_api_key: !!s.api_key,
    providers: {
      anthropic: { has_key: !!s.api_key_anthropic, model: s.model_anthropic, context_limit: s.context_limit_anthropic },
      glm:       { has_key: !!s.api_key_glm,       model: s.model_glm, context_limit: s.context_limit_glm },
      deepseek:  { has_key: !!s.api_key_deepseek,  model: s.model_deepseek, context_limit: s.context_limit_deepseek },
      custom:    { has_key: !!s.api_key_custom,     model: s.model_custom, context_limit: s.context_limit_custom, base_url: s.base_url_custom, openai_base_url: s.openai_base_url_custom, auth_type: s.custom_auth_type },
    },
    zcf_default_role: s.zcf_default_role,
    zcf_default_mode: s.zcf_default_mode,
    zcf_lang: s.zcf_lang,
    zcf_enabled_roles: s.zcf_enabled_roles,
    zcf_custom_roles: s.zcf_custom_roles,
    zcf_package_version: getZcfPackageVersion(),
    zcf_sync: readZcfSyncMeta(),
  }
}

function saveDirectorySetting(rawValue: string | undefined, key: 'user_directory' | 'download_directory'): ReturnType<typeof getSettings> {
  const raw = (rawValue || '').trim()
  if (!raw) throw new Error(`${key} is required`)
  const dir = path.resolve(expandHomePath(raw))
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${key} must be a directory`)
  return updateSettings({ [key]: dir } as Partial<Settings>)
}

app.get('/settings', (_req, res) => {
  res.json(buildSettingsResponse(getSettings()))
})

app.post('/settings/user-directory', (req, res) => {
  const { user_directory } = req.body as { user_directory?: string }
  try {
    res.json(buildSettingsResponse(saveDirectorySetting(user_directory, 'user_directory')))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to create directory' })
  }
})

function saveDownloadSubdirectorySetting(rawValue: string | undefined): ReturnType<typeof getSettings> {
  const userRoot = getUserDirectory()
  const subpath = normalizeDownloadSubdirectory(rawValue, userRoot)
  const fullPath = path.join(userRoot, subpath)
  fs.mkdirSync(fullPath, { recursive: true })
  if (!fs.statSync(fullPath).isDirectory()) throw new Error('download_subdirectory must be a directory')
  return updateSettings({ download_directory: subpath })
}

app.post('/settings/download-directory', (req, res) => {
  const { download_subdirectory, download_directory } = req.body as {
    download_subdirectory?: string
    download_directory?: string
  }
  try {
    res.json(buildSettingsResponse(saveDownloadSubdirectorySetting(download_subdirectory ?? download_directory)))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to create directory' })
  }
})

app.post('/settings/chat-attachments', (req, res) => {
  const { max_chat_attachments } = req.body as { max_chat_attachments?: number }
  const next = normalizeMaxChatAttachments(max_chat_attachments)
  res.json(buildSettingsResponse(updateSettings({ max_chat_attachments: next })))
})

app.post('/settings/paste-text-attachment-threshold', (req, res) => {
  const { paste_text_attachment_threshold } = req.body as { paste_text_attachment_threshold?: number }
  const next = normalizePasteTextAttachmentThreshold(paste_text_attachment_threshold)
  res.json(buildSettingsResponse(updateSettings({ paste_text_attachment_threshold: next })))
})

app.post('/settings/welcome-featured-sites', (req, res) => {
  const { welcome_featured_site_limit } = req.body as { welcome_featured_site_limit?: number }
  const next = normalizeWelcomeFeaturedSiteLimit(welcome_featured_site_limit)
  res.json(buildSettingsResponse(updateSettings({ welcome_featured_site_limit: next })))
})

app.post('/settings/resource-preview-extensions', (req, res) => {
  const { resource_preview_extensions, reset } = req.body as {
    resource_preview_extensions?: string[]
    reset?: boolean
  }
  if (reset) {
    res.json(buildSettingsResponse(resetResourcePreviewExtensions()))
    return
  }
  if (!Array.isArray(resource_preview_extensions)) {
    res.status(400).json({ detail: 'resource_preview_extensions must be an array' })
    return
  }
  res.json(buildSettingsResponse(updateResourcePreviewExtensions(resource_preview_extensions)))
})

app.post('/settings/user-directory-blacklist', (req, res) => {
  const { user_directory_blacklist } = req.body as { user_directory_blacklist?: UserDirectoryBlacklistEntry[] }
  const entries = Array.isArray(user_directory_blacklist) ? user_directory_blacklist : []
  const sanitized = normalizeUserDirectoryBlacklist(entries)
  const dropped = countInvalidBlacklistEntries(entries)
  const response = buildSettingsResponse(updateSettings({
    user_directory_blacklist: sanitized,
  }))
  res.json({ ...response, blacklist_dropped: dropped })
})

app.post('/settings/permissions', (req, res) => {
  const { open_browser_allowed_origins } = req.body as { open_browser_allowed_origins?: string[] }
  if (!Array.isArray(open_browser_allowed_origins)) {
    res.status(400).json({ detail: 'open_browser_allowed_origins must be an array' })
    return
  }
  const sanitized = normalizeOpenBrowserAllowedOrigins(open_browser_allowed_origins)
  res.json(buildSettingsResponse(updateSettings({
    open_browser_allowed_origins: sanitized,
  })))
})

app.get('/zcf/catalog', (_req, res) => {
  const settings = getSettings()
  res.json(buildZcfCatalogResponse(settings))
})

app.post('/zcf/sync', async (req, res) => {
  const settings = getSettings()
  const lang = (req.body as { lang?: ZcfLang })?.lang ?? settings.zcf_lang ?? 'zh-CN'
  try {
    const meta = await syncZcfTemplates(lang)
    updateSettings({ zcf_lang: lang })
    res.json({ ok: true, ...meta, package_version: getZcfPackageVersion() })
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : 'zcf sync failed' })
  }
})

app.post('/settings/zcf-defaults', (req, res) => {
  const { zcf_default_role, zcf_default_mode, zcf_lang } = req.body as {
    zcf_default_role?: string
    zcf_default_mode?: string
    zcf_lang?: ZcfLang
  }
  const settings = getSettings()
  const updates: Partial<Settings> = {
    ...sanitizeZcfDefaultSettings({ zcf_default_role, zcf_default_mode }, settings),
  }
  if (zcf_lang === 'zh-CN' || zcf_lang === 'en') updates.zcf_lang = zcf_lang
  res.json(buildSettingsResponse(updateSettings(updates)))
})

app.post('/settings/zcf-roles', (req, res) => {
  const { zcf_enabled_roles, zcf_custom_roles, zcf_default_role } = req.body as {
    zcf_enabled_roles?: string[]
    zcf_custom_roles?: Array<{ id?: string; label: string; prompt: string }>
    zcf_default_role?: string
  }
  const updates: Partial<Settings> = sanitizeZcfRoleSettingsPatch({
    ...(typeof zcf_default_role === 'string' ? { zcf_default_role } : {}),
    ...(Array.isArray(zcf_enabled_roles) ? { zcf_enabled_roles } : {}),
    ...(Array.isArray(zcf_custom_roles) ? { zcf_custom_roles: zcf_custom_roles as Settings['zcf_custom_roles'] } : {}),
  }, getSettings())
  res.json(buildSettingsResponse(updateSettings(updates)))
})

// Save config for a specific provider (does NOT switch active provider)
app.post('/settings/provider', (req, res) => {
  const { provider, api_key, model, context_limit, base_url, openai_base_url, auth_type } = req.body as {
    provider: string; api_key?: string; model?: string; context_limit?: unknown; base_url?: string; openai_base_url?: string; auth_type?: unknown
  }
  if (!ALLOWED_PROVIDER_IDS.has(provider)) {
    res.status(400).json({ detail: `Provider '${provider}' is not allowed in this build` })
    return
  }
  let allowedBaseUrl: string | undefined
  let allowedOpenAiBaseUrl: string | undefined
  if (provider === 'custom' && base_url !== undefined) {
    try {
      allowedBaseUrl = normalizeLlmBaseUrl(base_url)
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
      return
    }
  }
  if (provider === 'custom' && openai_base_url !== undefined) {
    try {
      allowedOpenAiBaseUrl = openai_base_url.trim() ? normalizeLlmBaseUrl(openai_base_url) : ''
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
      return
    }
  }
  if (provider === 'custom' && auth_type !== undefined && !isAnthropicAuthType(auth_type)) {
    res.status(400).json({ detail: "auth_type must be 'auth_token' or 'api_key'" })
    return
  }
  const parsedContextLimit = context_limit === undefined ? undefined : parseContextLimit(context_limit)
  if (context_limit !== undefined && parsedContextLimit === null) {
    res.status(400).json({ detail: '上下文窗口请输入 1K 到 100M 之间的整数，可使用 K/M 单位' })
    return
  }
  const updates: Partial<ReturnType<typeof getSettings>> = {}
  if (api_key) {
    if (provider === 'anthropic') updates.api_key_anthropic = api_key
    else if (provider === 'glm') updates.api_key_glm = api_key
    else if (provider === 'deepseek') updates.api_key_deepseek = api_key
    else if (provider === 'custom') updates.api_key_custom = api_key
  }
  if (model) {
    if (provider === 'anthropic') updates.model_anthropic = model
    else if (provider === 'glm') updates.model_glm = model
    else if (provider === 'deepseek') updates.model_deepseek = model
    else if (provider === 'custom') updates.model_custom = model
  }
  if (parsedContextLimit !== undefined && parsedContextLimit !== null) {
    if (provider === 'anthropic') updates.context_limit_anthropic = parsedContextLimit
    else if (provider === 'glm') updates.context_limit_glm = parsedContextLimit
    else if (provider === 'deepseek') updates.context_limit_deepseek = parsedContextLimit
    else if (provider === 'custom') updates.context_limit_custom = parsedContextLimit
  }
  if (provider === 'custom' && base_url !== undefined) updates.base_url_custom = allowedBaseUrl
  if (provider === 'custom' && openai_base_url !== undefined) updates.openai_base_url_custom = allowedOpenAiBaseUrl
  if (provider === 'custom' && isAnthropicAuthType(auth_type)) updates.custom_auth_type = auth_type
  // If this provider is currently active, also update the active key/model/url
  const current = getSettings()
  if (current.active_provider === provider) {
    if (api_key) updates.api_key = api_key
    if (model) updates.model = model
    if (parsedContextLimit !== undefined && parsedContextLimit !== null) updates.context_limit = parsedContextLimit
    if (provider === 'custom' && base_url !== undefined) updates.base_url = allowedBaseUrl
  }
  res.json(buildSettingsResponse(updateSettings(updates)))
})

// Switch which provider is active
app.post('/settings/provider/activate', (req, res) => {
  const { provider } = req.body as { provider: string }
  if (!ALLOWED_PROVIDER_IDS.has(provider)) {
    res.status(400).json({ detail: `Provider '${provider}' is not allowed in this build` })
    return
  }
  const current = getSettings()
  const key =
    provider === 'anthropic' ? current.api_key_anthropic :
    provider === 'glm'       ? current.api_key_glm :
    provider === 'deepseek'  ? current.api_key_deepseek :
    provider === 'custom'    ? current.api_key_custom : ''
  const model =
    provider === 'anthropic' ? current.model_anthropic :
    provider === 'glm'       ? current.model_glm :
    provider === 'deepseek'  ? current.model_deepseek :
    provider === 'custom'    ? current.model_custom : ''
  const contextLimit =
    provider === 'anthropic' ? current.context_limit_anthropic :
    provider === 'glm'       ? current.context_limit_glm :
    provider === 'deepseek'  ? current.context_limit_deepseek :
    provider === 'custom'    ? current.context_limit_custom : current.context_limit
  const baseUrl =
    provider === 'custom' ? current.base_url_custom : (PROVIDER_BASE_URLS[provider] ?? '')
  try {
    if (provider === 'custom') assertAllowedLlmBaseUrl(baseUrl, buildRuntimeAllowedLlmBaseUrls(baseUrl, current.openai_base_url_custom))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
    return
  }
  const updates: Partial<ReturnType<typeof getSettings>> = {
    active_provider: provider,
    api_key: key,
    model,
    context_limit: contextLimit,
    base_url: baseUrl,
  }
  res.json(buildSettingsResponse(updateSettings(updates)))
})

type ProviderRequestBody = {
  provider?: string
  api_key?: string
  model?: string
  base_url?: string
  openai_base_url?: string
  auth_type?: unknown
  target?: ProbeTarget
  auto_auth?: boolean
}

function resolveProviderAccess(body: ProviderRequestBody) {
  const provider = getProvider(body.provider || '')
  if (!provider) throw new Error(`Provider '${body.provider || ''}' is not allowed in this build`)
  const settings = getSettings()
  const savedApiKey =
    provider.id === 'anthropic' ? settings.api_key_anthropic :
    provider.id === 'glm' ? settings.api_key_glm :
    provider.id === 'deepseek' ? settings.api_key_deepseek : settings.api_key_custom
  const normalizeOptionalBaseUrl = (value: string | undefined): string | undefined => {
    if (!value?.trim()) return undefined
    return normalizeLlmBaseUrl(value)
  }
  return {
    provider,
    apiKey: body.api_key?.trim() || savedApiKey,
    anthropicBaseUrl: provider.id === 'custom'
      ? normalizeOptionalBaseUrl(body.base_url === undefined ? settings.base_url_custom : body.base_url)
      : provider.weworker.baseUrl,
    openaiBaseUrl: provider.id === 'custom'
      ? normalizeOptionalBaseUrl(body.openai_base_url === undefined ? settings.openai_base_url_custom : body.openai_base_url)
      : provider.webwright.baseUrl,
    anthropicAuthType: provider.id === 'custom'
      ? (body.auth_type === undefined
          ? settings.custom_auth_type
          : isAnthropicAuthType(body.auth_type)
            ? body.auth_type
            : (() => { throw new Error("auth_type must be 'auth_token' or 'api_key'") })())
      : undefined,
  }
}

function resolveProviderRequest(body: ProviderRequestBody) {
  const access = resolveProviderAccess(body)
  const settings = getSettings()
  const savedModel =
    access.provider.id === 'anthropic' ? settings.model_anthropic :
    access.provider.id === 'glm' ? settings.model_glm :
    access.provider.id === 'deepseek' ? settings.model_deepseek : settings.model_custom
  return {
    ...access,
    model: body.model === undefined ? savedModel : body.model.trim(),
  }
}

app.post('/settings/provider/models', async (req, res) => {
  try {
    const input = resolveProviderAccess(req.body as ProviderRequestBody)
    res.json(await listProviderModels(input))
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/settings/provider/probe', async (req, res) => {
  try {
    const body = req.body as ProviderRequestBody
    if (body.target !== 'weworker' && body.target !== 'webwright') {
      res.status(400).json({ detail: "target must be 'weworker' or 'webwright'" })
      return
    }
    const input = resolveProviderRequest(body)
    res.json(body.target === 'weworker'
      ? await probeMainConnection({ ...input, autoAuth: body.auto_auth === true })
      : await probeProviderProtocol({ ...input, target: body.target, verifyResponse: true }))
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

registerExplorationModelRoutes(app, { getSettings, updateSettings })

app.get('/settings/channels', (_req, res) => {
  const s = getSettings()
  res.json({
    qq: {
      enabled: s.channels.qq.enabled,
      app_id: s.channels.qq.app_id,
      has_app_secret: !!s.channels.qq.app_secret,
      owner_user_id: s.channels.qq.owner_user_id || '',
      owner_permission_level: normalizeOwnerPermissionLevel(s.channels.qq.owner_permission_level),
    },
    weixin: {
      enabled: s.channels.weixin.enabled,
      has_token: !!s.channels.weixin.token,
      base_url: s.channels.weixin.base_url || '',
      owner_user_id: s.channels.weixin.owner_user_id || '',
      owner_permission_level: normalizeOwnerPermissionLevel(s.channels.weixin.owner_permission_level),
    },
    wecom: {
      enabled: s.channels.wecom.enabled,
      bot_id: s.channels.wecom.bot_id,
      has_secret: !!s.channels.wecom.secret,
      owner_user_id: s.channels.wecom.owner_user_id || '',
      owner_permission_level: normalizeOwnerPermissionLevel(s.channels.wecom.owner_permission_level),
    },
  })
})

app.post('/settings/channels', async (req, res) => {
  const { qq, weixin, wecom } = req.body as {
    qq?: { enabled?: boolean; app_id?: string; app_secret?: string; owner_user_id?: string; owner_permission_level?: string }
    weixin?: { enabled?: boolean; base_url?: string; owner_user_id?: string; owner_permission_level?: string }
    wecom?: { enabled?: boolean; bot_id?: string; secret?: string; owner_user_id?: string; owner_permission_level?: string }
  }
  const s = getSettings()
  const nextOwnerIds = {
    qq: qq?.owner_user_id ?? s.channels.qq.owner_user_id,
    weixin: weixin?.owner_user_id ?? s.channels.weixin.owner_user_id,
    wecom: wecom?.owner_user_id ?? s.channels.wecom.owner_user_id,
  }
  for (const channel of ['qq', 'weixin', 'wecom'] as const) {
    const error = validateOwnerUserId(channel, nextOwnerIds[channel])
    if (error) return res.status(400).json({ detail: error })
  }
  let nextWeixinBaseUrl: string
  try {
    nextWeixinBaseUrl = assertAllowedWeixinBaseUrl(weixin?.base_url ?? s.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS)
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
    return
  }

  const updated = updateSettings({
    channels: {
      qq: {
        enabled: qq?.enabled ?? s.channels.qq.enabled,
        app_id: qq?.app_id ?? s.channels.qq.app_id,
        app_secret: qq?.app_secret ?? s.channels.qq.app_secret,
        owner_user_id: nextOwnerIds.qq,
        owner_permission_level: normalizeOwnerPermissionLevel(qq?.owner_permission_level ?? s.channels.qq.owner_permission_level),
      },
      weixin: {
        enabled: weixin?.enabled ?? s.channels.weixin.enabled,
        token: s.channels.weixin.token, // token is set via QR login, not here
        base_url: nextWeixinBaseUrl,
        owner_user_id: nextOwnerIds.weixin,
        owner_permission_level: normalizeOwnerPermissionLevel(weixin?.owner_permission_level ?? s.channels.weixin.owner_permission_level),
      },
      wecom: {
        enabled: wecom?.enabled ?? s.channels.wecom.enabled,
        bot_id: wecom?.bot_id ?? s.channels.wecom.bot_id,
        secret: wecom?.secret ?? s.channels.wecom.secret,
        owner_user_id: nextOwnerIds.wecom,
        owner_permission_level: normalizeOwnerPermissionLevel(wecom?.owner_permission_level ?? s.channels.wecom.owner_permission_level),
      },
    },
  })

  // Dynamic channel start/stop based on new settings
  // QQ
  if (updated.channels.qq.enabled && updated.channels.qq.app_id && updated.channels.qq.app_secret) {
    if (!channelManager.has('qq')) {
      const qqChannel = new QQChannel(
        { app_id: updated.channels.qq.app_id, app_secret: updated.channels.qq.app_secret },
      )
      channelManager.register('qq', qqChannel)
      qqChannel.start().catch(e => channelLog.error('start error:', e))
    }
  } else {
    await channelManager.unregister('qq')
  }

  // WeChat
  if (updated.channels.weixin.enabled && updated.channels.weixin.token) {
    if (!channelManager.has('weixin')) {
      const wxChannel = new WeixinChannel(
        { token: updated.channels.weixin.token, base_url: updated.channels.weixin.base_url },
      )
      channelManager.register('weixin', wxChannel)
      wxChannel.start().catch(e => channelLog.error('start error:', e))
    }
  } else {
    await channelManager.unregister('weixin')
  }

  // WeCom (浼佷笟寰俊)
  if (updated.channels.wecom.enabled && updated.channels.wecom.bot_id && updated.channels.wecom.secret) {
    if (!channelManager.has('wecom')) {
      const wecomChannel = new WecomChannel(
        { enabled: true, bot_id: updated.channels.wecom.bot_id, secret: updated.channels.wecom.secret },
      )
      channelManager.register('wecom', wecomChannel)
      wecomChannel.start().catch(e => channelLog.error('start error:', e))
    }
  } else {
    await channelManager.unregister('wecom')
  }

  res.json({
    qq: {
      enabled: updated.channels.qq.enabled,
      app_id: updated.channels.qq.app_id,
      has_app_secret: !!updated.channels.qq.app_secret,
      owner_user_id: updated.channels.qq.owner_user_id || '',
      owner_permission_level: normalizeOwnerPermissionLevel(updated.channels.qq.owner_permission_level),
    },
    weixin: {
      enabled: updated.channels.weixin.enabled,
      has_token: !!updated.channels.weixin.token,
      base_url: updated.channels.weixin.base_url || '',
      owner_user_id: updated.channels.weixin.owner_user_id || '',
      owner_permission_level: normalizeOwnerPermissionLevel(updated.channels.weixin.owner_permission_level),
    },
    wecom: {
      enabled: updated.channels.wecom.enabled,
      bot_id: updated.channels.wecom.bot_id,
      has_secret: !!updated.channels.wecom.secret,
      owner_user_id: updated.channels.wecom.owner_user_id || '',
      owner_permission_level: normalizeOwnerPermissionLevel(updated.channels.wecom.owner_permission_level),
    },
  })
})

// 鈹€鈹€ WeChat QR Login 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// In-memory QR login state
let _weixinQrState: { qrcode: string; qrcodeUrl: string; startedAt: number } | null = null

app.post('/settings/weixin/qr-start', async (_req, res) => {
  try {
    const s = getSettings()
    const baseUrl = assertAllowedWeixinBaseUrl(s.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS)
    const qr = await fetchQRCode(baseUrl)
    _weixinQrState = { qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content, startedAt: Date.now() }
    res.json({ ok: true, qrcode_url: qr.qrcode_img_content })
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/settings/weixin/qr-poll', async (_req, res) => {
  if (!_weixinQrState) {
    res.status(400).json({ detail: '璇峰厛鍙戣捣鎵爜鐧诲綍' })
    return
  }
  // Expire after 5 minutes
  if (Date.now() - _weixinQrState.startedAt > 5 * 60_000) {
    _weixinQrState = null
    res.json({ status: 'expired', message: '浜岀淮鐮佸凡杩囨湡锛岃閲嶆柊鐢熸垚' })
    return
  }
  try {
    const s = getSettings()
    const baseUrl = assertAllowedWeixinBaseUrl(s.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS)
    const status = await pollQRStatus(baseUrl, _weixinQrState.qrcode)

    if (status.status === 'confirmed' && status.bot_token) {
      // Save token and enable channel
      updateSettings({
        channels: {
          ...s.channels,
          weixin: {
            enabled: true,
            token: status.bot_token,
            base_url: assertAllowedWeixinBaseUrl(status.baseurl || s.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS),
            owner_user_id: s.channels.weixin.owner_user_id || '',
            owner_permission_level: normalizeOwnerPermissionLevel(s.channels.weixin.owner_permission_level),
          },
        },
      })
      _weixinQrState = null

      // Start the channel
      const wxConfig = { token: status.bot_token, base_url: assertAllowedWeixinBaseUrl(status.baseurl || s.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS) }
      const wxChannel = new WeixinChannel(wxConfig)
      channelManager.register('weixin', wxChannel)
      wxChannel.start().catch(e => channelLog.error('start error:', e))

      res.json({ status: 'confirmed', message: '鉁?寰俊杩炴帴鎴愬姛' })
    } else if (status.status === 'expired') {
      _weixinQrState = null
      res.json({ status: 'expired', message: '浜岀淮鐮佸凡杩囨湡锛岃閲嶆柊鐢熸垚' })
    } else {
      res.json({ status: status.status, message: status.status === 'scaned' ? '宸叉壂鐮侊紝璇峰湪寰俊纭' : '绛夊緟鎵爜...' })
    }
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

// 鈹€鈹€ Skills 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function readSkill(name: string): { name: string; content: string; enabled: boolean; resources: ReturnType<typeof listSkillDirectoryResources> } | null {
  const dir = path.join(SKILLS_DIR, name)
  const active = path.join(dir, 'SKILL.md')
  const disabled = path.join(dir, 'SKILL.md.disabled')
  try {
    const resources = listSkillDirectoryResources(dir)
    if (fs.existsSync(active)) {
      return { name, content: fs.readFileSync(active, 'utf8'), enabled: true, resources }
    } else if (fs.existsSync(disabled)) {
      return { name, content: fs.readFileSync(disabled, 'utf8'), enabled: false, resources }
    }
    return null
  } catch {
    return null
  }
}

function extractSkillNameFromMarkdown(content: string): string {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return ''
  const nameLine = match[1].split(/\r?\n/).find((line) => /^\s*name\s*:/.test(line))
  if (!nameLine) return ''
  return nameLine
    .replace(/^\s*name\s*:\s*/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

function isTemplateSkillName(name: string): boolean {
  const normalized = String(name || '').trim()
  return !normalized || normalized.includes('{{') || normalized.includes('}}')
}

function sanitizeSkillDirectoryName(name: string): string {
  return (name || 'custom')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/, '_')
    .trim() || 'custom'
}

app.get('/skills', (_req, res) => {
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    const skills = dirs.map(readSkill).filter(Boolean)
    res.json(skills)
  } catch {
    res.json([])
  }
})

app.post('/skills', (req, res) => {
  const { name, previousName, content, resources } = req.body as { name: string; previousName?: string; content: string; resources?: unknown[] }
  if (!name?.trim() || !content?.trim()) {
    res.status(400).json({ detail: 'name and content required' })
    return
  }
  const frontmatterName = extractSkillNameFromMarkdown(content)
  const preferredName = frontmatterName && !isTemplateSkillName(frontmatterName) ? frontmatterName : name
  const safeName = sanitizeSkillDirectoryName(preferredName)
  const previousSafeName = previousName?.trim() ? sanitizeSkillDirectoryName(previousName) : ''
  const dir = path.join(SKILLS_DIR, safeName)
  if (previousSafeName && previousSafeName !== safeName) {
    const previousDir = path.join(SKILLS_DIR, previousSafeName)
    if (fs.existsSync(dir)) {
      res.status(409).json({ detail: `Skill name already exists: ${safeName}` })
      return
    }
    if (fs.existsSync(previousDir)) {
      fs.renameSync(previousDir, dir)
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
  const savedResources = Array.isArray(resources)
    ? saveSkillDirectoryResources(dir, resources)
    : listSkillDirectoryResources(dir)
  res.json({ ok: true, name: safeName, resources: savedResources })
})

app.post('/skills/:name/resources/import', (req, res) => {
  const safeName = sanitizeSkillDirectoryName(req.params.name)
  const dir = path.join(SKILLS_DIR, safeName)
  if (!fs.existsSync(dir)) {
    res.status(404).json({ detail: 'Skill not found' })
    return
  }
  try {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : []
    const parentRelativePath = typeof req.body?.parentRelativePath === 'string' ? req.body.parentRelativePath : ''
    const resources = importSkillDirectoryResources(dir, paths, parentRelativePath)
    res.json({ ok: true, name: safeName, resources })
  } catch (e: any) {
    res.status(400).json({ detail: e.message || 'import failed' })
  }
})

app.get('/skills/:name/resources/preview', (req, res) => {
  const safeName = sanitizeSkillDirectoryName(req.params.name)
  const dir = path.join(SKILLS_DIR, safeName)
  if (!fs.existsSync(dir)) {
    res.status(404).json({ detail: 'Skill not found' })
    return
  }
  const relativePath = typeof req.query.path === 'string' ? req.query.path : ''
  try {
    const preview = readResourceFilePreview(dir, relativePath)
    res.json({ ok: true, ...preview })
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to preview resource' })
  }
})

app.get('/skills/:name/directory', (req, res) => {
  const safeName = sanitizeSkillDirectoryName(req.params.name)
  const dir = path.join(SKILLS_DIR, safeName)
  if (!fs.existsSync(dir)) {
    res.status(404).json({ detail: 'Skill not found' })
    return
  }
  res.json({ ok: true, path: dir })
})

// Toggle skill enabled/disabled
app.post('/skills/:name/toggle', (req, res) => {
  const safeName = sanitizeSkillDirectoryName(req.params.name)
  const dir = path.join(SKILLS_DIR, safeName)
  const active = path.join(dir, 'SKILL.md')
  const disabled = path.join(dir, 'SKILL.md.disabled')
  try {
    if (fs.existsSync(active)) {
      fs.renameSync(active, disabled)
      res.json({ ok: true, enabled: false })
    } else if (fs.existsSync(disabled)) {
      fs.renameSync(disabled, active)
      res.json({ ok: true, enabled: true })
    } else {
      res.status(404).json({ detail: 'Skill not found' })
    }
  } catch (e: any) {
    res.status(500).json({ detail: e.message })
  }
})

app.delete('/skills/:name', (req, res) => {
  const safeName = sanitizeSkillDirectoryName(req.params.name)
  try {
    fs.rmSync(path.join(SKILLS_DIR, safeName), { recursive: true, force: true })
    res.json({ ok: true })
  } catch {
    res.status(404).json({ detail: 'Skill not found' })
  }
})

// 鈹€鈹€ Debug 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.post('/debug/chat', async (_req, res) => {
  const settings = getSettings()
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const { buildMcpServer } = await import('./tools.js')
  const mcpServer = buildMcpServer()
  log.debug(' static adapter tools:', [...parseAllAdapters().values()].flatMap(a => a.tools).map(t => t.name))
  const msgs: string[] = []
  try {
    for await (const msg of query({
      prompt: '浣犲ソ',
      options: {
        model: settings.model,
        permissionMode: 'default',
        canUseTool: createUnifiedToolGuard(),
        settings: buildAgentFilesystemSettings(getUserDirectory()),
        mcpServers: { weworker: mcpServer },
        env: buildConfiguredModelEnv(settings),
      },
    })) {
      msgs.push(msg.type)
      if ((msg as { type: string }).type === 'assistant') {
        const content = (msg as { message?: { content?: unknown[] } }).message?.content
        res.json({ ok: true, msgs, content })
        return
      }
    }
  } catch (e) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e), msgs })
    return
  }
  res.json({ ok: false, msgs, note: 'no assistant message' })
})

// 鈹€鈹€ Sites & Tools 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.get('/registry-icons', (_req, res) => {
  res.json({
    defaultIcon: getRegistryDefaultIcon(),
    byId: getRegistryIconById(),
  })
})

function formatAdapterToolsForApi(tools: StaticToolDef[]) {
  return tools.map((t) => {
    const params = t.parameters as Record<string, unknown>
    const props = (params?.properties as Record<string, { type?: string; description?: string }>) ?? {}
    const required = (params?.required as string[]) ?? []
    const patchedProps = { ...props }
    const patchedRequired = [...required]
    if (props.file_base64) {
      patchedProps.file_path = {
        type: 'string',
        description: '本地文件的绝对路径（与 file_base64 二选一）',
      }
      const idx = patchedRequired.indexOf('file_base64')
      if (idx >= 0) patchedRequired.splice(idx, 1)
    }
    return {
      name: t.name,
      description: t.description,
      parameters: Object.entries(patchedProps).map(([name, def]) => ({
        name,
        type: def.type ?? 'string',
        description: def.description ?? '',
        required: patchedRequired.includes(name),
      })),
    }
  })
}

app.get('/sites', (_req, res) => {
  const allAdapters = parseAllAdapters()
  const adaptersDir = findAdaptersDirectory()
  const settings = getSettings()
  const customTP = settings.custom_test_prompts || {}
  const sites = [...allAdapters.values()].map(a => {
    const enabled = getSiteEnabled(a.id, a.defaultEnabled, a.managed?.enabled)
    // Visibility: user setting takes precedence; if no user setting, use registry default
    const userToggle = settings.site_toggles[a.id]
    const visible = userToggle === undefined
      ? (enabled && !a.hidden)  // No user setting: use registry hidden default
      : (userToggle !== false && userToggle !== 'hidden')  // User has set: respect it
    const officialScenarioDefs = getOfficialScenarioDefs(a)
    const officialScenarios = resolveSiteScenarios(
      a,
      a.registryScenarios?.length ? officialScenarioDefs : undefined,
    )
    const customScenarioDefs = getCustomScenariosForSite(allAdapters, a.id)
    const customScenarios = customScenarioDefs.length
      ? resolveSiteScenarios(a, customScenarioDefs).map((scenario) => ({ ...scenario, source: 'user' as const }))
      : []
    const scenarios = [...officialScenarios, ...customScenarios]
    const customSkills = listCustomSkills(a.id)
    const resolvedTools = resolveToolsForAdapter(a, adaptersDir)
    return {
    id: a.id,
    name: a.name,
    icon: a.icon,
    promptVarDisplay: a.promptVarDisplay,
    description: a.description,
    detailDescription: a.detailDescription,
    toolCount: resolvedTools.length,
    customSkillCount: customSkills.length,
    scenarioCount: scenarios.length,
    enabled,
    visible: enabled && visible,
    hidden: a.hidden,
    managed: a.managed,
    testPrompts: customTP[a.id] != null ? customTP[a.id] : a.testPrompts,
    customSkills,
    scenarios: scenarios.map((sc) => ({
      id: sc.id,
      title: sc.title,
      summary: sc.summary,
      steps: sc.steps,
      toolNames: sc.toolNames,
      prompts: sc.prompts,
      updated_at: sc.updated_at,
      source: sc.source,
    })),
    tools: formatAdapterToolsForApi(resolvedTools),
  }})
  res.json(sites)
})

app.post('/sites/:id/toggle', async (req, res) => {
  const adapterId = req.params.id
  let enabled: boolean
  try {
    if (!parseAllAdapters().has(adapterId)) {
      res.status(404).json({ detail: 'Site not found' })
      return
    }
    enabled = toggleDesktopAdapter(adapterId) ?? toggleSite(adapterId)
    await scheduleAdapterRuntimeReload(adapterId)
  } catch (error) {
    res.status(409).json({ detail: error instanceof Error ? error.message : 'Adapter selection could not be refreshed' })
    return
  }
  res.json({ id: adapterId, enabled })
})

app.post('/sites/welcome-visibility', (req, res) => {
  const { visible, ids } = req.body as { visible?: boolean; ids?: string[] }
  const allAdapters = parseAllAdapters()
  const adapterIds = Array.isArray(ids)
    ? ids.filter((id) => allAdapters.has(id))
    : [...allAdapters.keys()]
  const managedStates = new Map([...allAdapters.values()].filter(a => a.managed).map(a => [a.id, a.managed!.enabled]))
  setAllEnabledSitesWelcomeVisibility(adapterIds, visible === true, managedStates)
  res.json({ ok: true, visible: visible === true, ids: adapterIds })
})

app.post('/sites/:id/visibility', (req, res) => {
  const adapterId = req.params.id
  const { visible } = req.body as { visible: boolean }
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(adapterId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  setSiteVisibility(adapterId, visible, allAdapters.get(adapterId)?.managed?.enabled)
  res.json({ id: adapterId, visible })
})

app.put('/sites/:id/scenarios/:scenarioId', (req, res) => {
  const siteId = req.params.id
  const scenarioId = req.params.scenarioId
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  if (hasOfficialScenario(allAdapters, siteId, scenarioId)) {
    res.status(403).json({ detail: '官方场景不可编辑' })
    return
  }
  const saved = saveUserScenario(allAdapters, siteId, scenarioId, req.body)
  if (!saved) {
    res.status(404).json({ detail: 'Scenario not found' })
    return
  }
  res.json({ ok: true, scenario: saved })
})

app.post('/sites/:id/scenarios', (req, res) => {
  const siteId = req.params.id
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  const scenarioId = typeof req.body?.id === 'string' ? req.body.id.trim() : ''
  const created = createUserScenario(allAdapters, siteId, scenarioId, req.body)
  if (!created) {
    res.status(409).json({ detail: '场景名称已存在或无效' })
    return
  }
  res.json({ ok: true, scenario: created })
})

app.delete('/sites/:id/scenarios/:scenarioId', (req, res) => {
  const siteId = req.params.id
  const scenarioId = req.params.scenarioId
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  if (hasOfficialScenario(allAdapters, siteId, scenarioId)) {
    res.status(403).json({ detail: '官方场景不可删除' })
    return
  }
  if (!deleteUserScenario(allAdapters, siteId, scenarioId)) {
    res.status(404).json({ detail: 'Scenario not found' })
    return
  }
  res.json({ ok: true })
})

app.post('/sites/:id/scenarios/:scenarioId/reset', (req, res) => {
  const siteId = req.params.id
  const scenarioId = req.params.scenarioId
  const allowedFields = new Set<ScenarioResetField>(['title', 'summary', 'steps', 'prompts'])
  const fields = Array.isArray(req.body?.fields)
    ? req.body.fields.filter((field: unknown): field is ScenarioResetField => typeof field === 'string' && allowedFields.has(field as ScenarioResetField))
    : undefined
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  if (hasOfficialScenario(allAdapters, siteId, scenarioId)) {
    res.status(403).json({ detail: '官方场景不可编辑' })
    return
  }
  const restored = resetUserScenario(allAdapters, siteId, scenarioId, fields)
  if (!restored) {
    res.status(404).json({ detail: 'Official scenario not found' })
    return
  }
  res.json({ ok: true, scenario: restored })
})

app.put('/sites/:id/custom-skills', (req, res) => {
  const siteId = req.params.id
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  const skills = Array.isArray(req.body?.skills) ? req.body.skills : []
  try {
    const saved = saveCustomSkills(siteId, skills)
    runWebcli(['install', '--skills', siteId, '--target', SKILLS_DIR])
    res.json({ ok: true, skills: saved })
  } catch (e) {
    if (e instanceof DuplicateSkillNameError) {
      res.status(e.statusCode).json({ detail: e.message })
      return
    }
    res.status(500).json({ detail: e instanceof Error ? e.message : 'failed to save custom skills' })
  }
})

app.post('/sites/:id/custom-skills/:skillId/resources/import', (req, res) => {
  const siteId = req.params.id
  const skillId = req.params.skillId
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  try {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : []
    const parentRelativePath = typeof req.body?.parentRelativePath === 'string' ? req.body.parentRelativePath : ''
    const skill = importCustomSkillResources(siteId, skillId, paths, parentRelativePath)
    runWebcli(['install', '--skills', siteId, '--target', SKILLS_DIR])
    res.json({ ok: true, skill })
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to import custom skill resources' })
  }
})

app.get('/sites/:id/custom-skills/:skillId/resources/preview', (req, res) => {
  const siteId = req.params.id
  const skillId = req.params.skillId
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  const relativePath = typeof req.query.path === 'string' ? req.query.path : ''
  try {
    const preview = readResourceFilePreview(resolveCustomSkillAssetDir(siteId, skillId), relativePath)
    res.json({ ok: true, ...preview })
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to preview resource' })
  }
})

app.get('/sites/:id/custom-skills/:skillId/directory', (req, res) => {
  const siteId = req.params.id
  const skillId = req.params.skillId
  const allAdapters = parseAllAdapters()
  if (!allAdapters.has(siteId)) {
    res.status(404).json({ detail: 'Site not found' })
    return
  }
  res.json({ ok: true, path: resolveCustomSkillAssetDir(siteId, skillId) })
})


// 鈹€鈹€ Test Prompts CRUD 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.post('/sites/:id/test-prompts', (req, res) => {
  const siteId = req.params.id
  const { prompt } = req.body as { prompt: string }
  if (!prompt?.trim()) {
    res.status(400).json({ detail: 'prompt required' })
    return
  }
  const s = getSettings()
  const allAdapters = parseAllAdapters()
  const adapter = allAdapters.get(siteId)
  const custom = { ...s.custom_test_prompts }
  if (custom[siteId] == null) {
    custom[siteId] = [...(adapter?.testPrompts ?? [])]
  }
  custom[siteId] = [...custom[siteId]!, prompt.trim()]
  updateSettings({ custom_test_prompts: custom })
  res.json({ ok: true, prompts: custom[siteId] })
})

app.put('/sites/:id/test-prompts/:index', (req, res) => {
  const siteId = req.params.id
  const index = parseInt(req.params.index, 10)
  const { prompt } = req.body as { prompt: string }
  if (isNaN(index) || index < 0 || !prompt?.trim()) {
    res.status(400).json({ detail: 'invalid request' })
    return
  }
  const s = getSettings()
  const allAdapters = parseAllAdapters()
  const adapter = allAdapters.get(siteId)
  const custom = { ...s.custom_test_prompts }
  if (custom[siteId] == null) {
    custom[siteId] = [...(adapter?.testPrompts ?? [])]
  }
  const list = [...custom[siteId]!]
  if (index >= list.length) {
    res.status(404).json({ detail: 'prompt not found' })
    return
  }
  list[index] = prompt.trim()
  custom[siteId] = list
  updateSettings({ custom_test_prompts: custom })
  res.json({ ok: true })
})

app.delete('/sites/:id/test-prompts/:index', (req, res) => {
  const siteId = req.params.id
  const index = parseInt(req.params.index, 10)
  if (isNaN(index) || index < 0) {
    res.status(400).json({ detail: 'invalid index' })
    return
  }
  const s = getSettings()
  const allAdapters = parseAllAdapters()
  const adapter = allAdapters.get(siteId)
  const custom = { ...s.custom_test_prompts }
  if (custom[siteId] == null) {
    custom[siteId] = [...(adapter?.testPrompts ?? [])]
  }
  const list = [...custom[siteId]!]
  if (index >= list.length) {
    res.status(404).json({ detail: 'prompt not found' })
    return
  }
  list.splice(index, 1)
  custom[siteId] = list
  updateSettings({ custom_test_prompts: custom })
  res.json({ ok: true })
})

// Reset test prompts to manifest defaults
app.post('/sites/:id/reset-prompts', (req, res) => {
  const siteId = req.params.id
  const { type } = req.body as { type?: string }
  if (type && type !== 'test') {
    res.status(400).json({ detail: 'type must be "test"' })
    return
  }
  const s = getSettings()
  const custom = { ...s.custom_test_prompts }
  custom[siteId] = null as unknown as string[]
  updateSettings({ custom_test_prompts: custom } as Partial<Settings>)
  res.json({ ok: true })
})

app.get('/tools', (_req, res) => {
  const allAdapters = parseAllAdapters()
  const adaptersDir = findAdaptersDirectory()
  const tools = [...allAdapters.values()]
    .filter(a => getSiteEnabled(a.id, a.defaultEnabled, a.managed?.enabled))
    .flatMap(a => resolveToolsForAdapter(a, adaptersDir))
  res.json({ tools })
})

app.get('/system-tools', (_req, res) => {
  const userDir = getUserDirectory()
  const tools = [
    { name: 'open_browser', description: '打开 Chrome 浏览器并导航到指定 URL', parameters: [{ name: 'url', type: 'string', description: '要打开的完整 URL', required: true }] },
    { name: 'capture_screenshot', description: '截取当前浏览器标签页的屏幕截图', parameters: [{ name: 'fullPage', type: 'boolean', description: '是否截取整个页面', required: false }] },
    { name: 'list_files', description: `列出指定目录中的文件（默认用户目录 ${userDir}，按修改时间倒序）`, parameters: [{ name: 'directory', type: 'string', description: `目录路径（默认 ${userDir}）`, required: false }, { name: 'keyword', type: 'string', description: '按文件名关键字过滤', required: false }, { name: 'limit', type: 'number', description: '最大返回数量（默认 50）', required: false }] },
    { name: 'ask_user', description: '向用户提出选择题，等待用户回答', parameters: [{ name: 'question', type: 'string', description: '问题内容', required: true }, { name: 'options', type: 'array', description: '选项列表', required: true }] },
    { name: 'create_scheduled_task', description: '创建定时任务，按 cron 表达式周期执行', parameters: [{ name: 'title', type: 'string', description: '任务标题', required: true }, { name: 'cron_expression', type: 'string', description: 'Cron 表达式', required: true }, { name: 'prompt_template', type: 'string', description: '任务指令', required: true }] },
    { name: 'list_scheduled_tasks', description: '列出所有定时任务及执行状态', parameters: [] },
    { name: 'send_file_to_user', description: '通过企业微信发送文件给用户', parameters: [{ name: 'file_path', type: 'string', description: '文件绝对路径', required: true }] },
    { name: 'send_image_to_user', description: '通过企业微信发送图片给用户', parameters: [{ name: 'file_path', type: 'string', description: '图片绝对路径', required: true }] },
    ...(process.platform === 'win32' ? [
      { name: 'check_file_encryption', description: '检查文件是否被 DLP 加密（仅 Windows）', parameters: [{ name: 'file_path', type: 'string', description: '文件绝对路径', required: true }] },
      { name: 'decrypt_file', description: '解密被 DLP 加密的文件（仅 Windows）', parameters: [{ name: 'file_path', type: 'string', description: '文件或文件夹路径', required: true }] },
    ] : []),
  ]
  res.json(tools)
})

// 鈹€鈹€ Explore APIs (deprecated 鈥?use webcli call directly) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.get('/exploration/capabilities', (_req, res) => {
  const state = bridgeRpcClient.getCapabilities()
  res.json({
    ...state,
    passiveExploration: state.capabilities.includes('passive_exploration_v1'),
    safeApiProbe: state.capabilities.includes('safe_api_probe_v1'),
    apiReplay: state.capabilities.includes('api_replay_v1'),
    actionCapture: state.capabilities.includes('action_capture_v1'),
    clientAgent: true,
    generationHarness: state.capabilities.includes('generation_harness_v1'),
  })
})

app.get('/exploration/tabs', async (_req, res) => {
  try {
    const state = bridgeRpcClient.getCapabilities()
    if (!state.bridgeConnected) {
      res.status(503).json({ detail: 'BRIDGE_DISCONNECTED' })
      return
    }
    if (!state.extensionConnected) {
      res.status(503).json({ detail: 'EXTENSION_DISCONNECTED' })
      return
    }
    if (!state.capabilities.includes('passive_exploration_v1')) {
      res.status(409).json({ detail: 'EXTENSION_CAPABILITY_MISSING' })
      return
    }
    res.json({ tabs: await bridgeRpcClient.listExplorableTabs() })
  } catch (error) {
    res.status(502).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

const explorationRunInputSchema = z.object({
  goal: z.string().trim().min(1).max(2_000),
  tabId: z.number().int().nonnegative(),
})

app.post('/exploration/runs', async (req, res) => {
  const parsed = explorationRunInputSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ detail: parsed.error.issues[0]?.message || 'Invalid exploration request' })
    return
  }
  try {
    const tabs = await bridgeRpcClient.listExplorableTabs()
    const tab = tabs.find((item) => item.id === parsed.data.tabId)
    if (!tab) {
      res.status(404).json({ detail: 'TARGET_TAB_NOT_FOUND' })
      return
    }
    res.status(202).json(explorationAgentCoordinator.start(parsed.data.goal, tab))
  } catch (error) {
    res.status(502).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/exploration/runs/:taskId', (req, res) => {
  const run = explorationAgentCoordinator.get(req.params.taskId)
  if (!run) {
    res.status(404).json({ detail: 'EXPLORATION_RUN_NOT_FOUND' })
    return
  }
  res.json(run)
})

app.post('/exploration/runs/:taskId/cancel', (req, res) => {
  const run = explorationAgentCoordinator.cancel(req.params.taskId)
  if (!run) {
    res.status(404).json({ detail: 'EXPLORATION_RUN_NOT_FOUND' })
    return
  }
  res.json(run)
})

app.post('/exploration/runs/:taskId/save', (req, res) => {
  try {
    res.json(explorationAgentCoordinator.saveMemory(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/scaffold', async (req, res) => {
  try {
    const run = await explorationAgentCoordinator.startGeneration(req.params.taskId, undefined, 'quick')
    res.status(202).json({ run })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

const explorationGenerationInputSchema = z.object({
  goal: z.string().trim().min(1).max(2_000).optional(),
  mode: z.enum(['auto', 'agent', 'classic', 'quick']).optional(),
})

const explorationGenerationResumeInputSchema = z.object({
  answer: z.string().trim().min(1).max(4_000),
})

const explorationActionCaptureInputSchema = z.object({
  actionName: z.string().trim().min(1).max(200),
  mode: z.enum(['observe', 'intercept']).optional(),
  timeoutSeconds: z.number().int().min(5).max(300).optional(),
  pattern: z.string().max(500).optional(),
})

app.post('/exploration/runs/:taskId/action-capture', async (req, res) => {
  const parsed = explorationActionCaptureInputSchema.safeParse(req.body || {})
  if (!parsed.success) {
    res.status(400).json({ detail: parsed.error.issues[0]?.message || 'Invalid action capture request' })
    return
  }
  try {
    res.status(202).json(await explorationAgentCoordinator.startActionCapture(req.params.taskId, parsed.data))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.get('/exploration/runs/:taskId/action-capture', async (req, res) => {
  try {
    res.json(await explorationAgentCoordinator.getActionCapture(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/action-capture/analyze', async (req, res) => {
  try {
    res.status(202).json(await explorationAgentCoordinator.retryActionCaptureAnalysis(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/action-capture/stop', async (req, res) => {
  try {
    res.json(await explorationAgentCoordinator.stopActionCapture(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

const explorationActionCandidateSchema = z.object({
  candidateIndex: z.number().int().min(0),
})

app.post('/exploration/runs/:taskId/action-capture/select', async (req, res) => {
  const parsed = explorationActionCandidateSchema.safeParse(req.body || {})
  if (!parsed.success) {
    res.status(400).json({ detail: parsed.error.issues[0]?.message || 'Invalid candidate selection' })
    return
  }
  try {
    res.json(await explorationAgentCoordinator.selectActionCaptureCandidate(req.params.taskId, parsed.data.candidateIndex))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/action-capture/clear', async (req, res) => {
  try {
    res.json(await explorationAgentCoordinator.clearActionCapture(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/generation', async (req, res) => {
  const parsed = explorationGenerationInputSchema.safeParse(req.body || {})
  if (!parsed.success) {
    res.status(400).json({ detail: parsed.error.issues[0]?.message || 'Invalid generation request' })
    return
  }
  try {
    res.status(202).json(await explorationAgentCoordinator.startGeneration(req.params.taskId, parsed.data.goal, parsed.data.mode))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/generation/resume', async (req, res) => {
  const parsed = explorationGenerationResumeInputSchema.safeParse(req.body || {})
  if (!parsed.success) {
    res.status(400).json({ detail: parsed.error.issues[0]?.message || 'Invalid generation resume request' })
    return
  }
  try {
    res.status(202).json(await explorationAgentCoordinator.resumeGeneration(req.params.taskId, parsed.data.answer))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.get('/exploration/runs/:taskId/generation', async (req, res) => {
  try {
    res.json(await explorationAgentCoordinator.getGeneration(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/generation/cancel', async (req, res) => {
  try {
    res.json(await explorationAgentCoordinator.cancelGeneration(req.params.taskId))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/exploration/runs/:taskId/generation/publish', async (req, res) => {
  try {
    const approval = z.object({ reviewId: z.string().regex(/^[a-f0-9]{64}$/).optional(), acceptChanges: z.boolean().optional() }).strict().parse(req.body || {})
    const run = await explorationAgentCoordinator.publishGeneration(req.params.taskId, approval)
    const siteKey = typeof run.generationRun?.siteKey === 'string' ? run.generationRun.siteKey : ''
    if (siteKey && run.generationRun?.status === 'completed') await scheduleAdapterRuntimeReload(siteKey)
    res.json(run)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(message === 'EXPLORATION_RUN_NOT_FOUND' ? 404 : 409).json({ detail: message })
  }
})

app.post('/explore/state', (_req, res) => {
  res.status(410).json({ detail: 'Use `webcli call inspect_page_state` instead' })
})

app.post('/explore/network', (_req, res) => {
  res.status(410).json({ detail: 'Use `webcli call inspect_network_requests` instead' })
})

app.post('/explore/eval', (_req, res) => {
  res.status(410).json({ detail: 'Use `webcli call evaluate_in_page` instead' })
})

app.post('/explore/analyze', (_req, res) => {
  res.status(410).json({ detail: 'Use `webcli call explore_site` instead' })
})

app.post('/explore/workflow', (_req, res) => {
  res.status(410).json({ detail: 'Use `webcli call explore_site_workflow` instead' })
})

app.post('/explore/action-capture', (_req, res) => {
  res.status(410).json({ detail: 'Use `webcli call capture_site_action_workflow` instead' })
})

app.get('/explore/site-memory', (req, res) => {
  const site = typeof req.query.site === 'string' ? req.query.site : ''
  if (!site) {
    res.json(listSiteMemories())
    return
  }
  const result = getSiteMemory(site)
  if (!result) {
    res.status(404).json({ detail: 'site memory not found' })
    return
  }
  res.json(result)
})

app.post('/explore/scaffold', async (req, res) => {
  try {
    const { site } = req.body as { site?: string }
    if (!site?.trim()) {
      res.status(400).json({ detail: 'site required' })
      return
    }
    const memory = getSiteMemory(site)
    if (!memory) {
      res.status(404).json({ detail: 'site memory not found' })
      return
    }
    const run = await bridgeRpcClient.startGenerationRun({ siteKey: memory.siteKey, memory: memory as unknown as Record<string, unknown>, goal: '快速生成并验证查询工具', tabId: null, mode: 'quick' })
    res.status(202).json({ run, pendingInstallation: true })
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

// 鈹€鈹€ Works 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.get('/works', (_req, res) => {
  res.json(store.listWorks())
})

app.post('/works', (req, res) => {
  const work = store.createWork()
  const { zcf_role, zcf_mode } = req.body as { zcf_role?: string | null; zcf_mode?: string | null }
  if (zcf_role !== undefined || zcf_mode !== undefined) {
    const prefs = sanitizeWorkZcfPrefsPatch({ zcf_role, zcf_mode }, getSettings())
    const updated = store.updateWorkZcfPrefs(work.id, prefs)
    broadcastSSE({ type: 'works_changed', workId: work.id })
    res.json(updated ?? work)
    return
  }
  broadcastSSE({ type: 'works_changed', workId: work.id })
  res.json(work)
})

app.patch('/works/:id/zcf', (req, res) => {
  const { zcf_role, zcf_mode } = req.body as { zcf_role?: string | null; zcf_mode?: string | null }
  const prefs = sanitizeWorkZcfPrefsPatch({ zcf_role, zcf_mode }, getSettings())
  const updated = store.updateWorkZcfPrefs(req.params.id, prefs)
  if (!updated) { res.status(404).json({ detail: 'Not found' }); return }
  res.json(updated)
})

app.get('/works/:id', (req, res) => {
  const work = store.getWorkWithMessages(req.params.id)
  if (!work) { res.status(404).json({ detail: 'Not found' }); return }
  res.json(work)
})

app.patch('/works/:id', (req, res) => {
  const { title, preserveOrder } = req.body as { title: string; preserveOrder?: boolean }
  if (preserveOrder) {
    store.updateTitlePreserveOrder(req.params.id, title)
  } else {
    store.updateTitle(req.params.id, title)
  }
  res.json({ ok: true })
})

app.delete('/works/:id', (req, res) => {
  store.deleteWork(req.params.id)
  res.json({ ok: true })
})

app.patch('/works/:id/label', (req, res) => {
  const { label } = req.body as { label: string | null }
  const valid = [null, 'red', 'orange', 'yellow', 'green', 'blue', 'purple']
  if (!valid.includes(label)) {
    res.status(400).json({ detail: 'Invalid label color' })
    return
  }
  store.updateLabel(req.params.id, label as store.LabelColor)
  res.json({ ok: true })
})

app.get('/settings/label-names', (_req, res) => {
  res.json(getSettings().label_names || {})
})

app.post('/settings/label-names', (req, res) => {
  const names = req.body as Record<string, string>
  updateSettings({ label_names: names })
  res.json(names)
})

app.get('/user-files', (_req, res) => {
  try {
    res.json(listUserFiles())
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : 'failed to list user files' })
  }
})

app.post('/user-files/folder', (req, res) => {
  const { parent_path, name } = req.body as { parent_path?: string; name?: string }
  try {
    res.json(createUserFolder(parent_path, name || ''))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to create folder' })
  }
})

app.post('/user-files/file', (req, res) => {
  const { parent_path, name } = req.body as { parent_path?: string; name?: string }
  try {
    res.json(createUserFile(parent_path, name || ''))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to create file' })
  }
})

app.post('/user-files/rename', (req, res) => {
  const { target_path, name } = req.body as { target_path?: string; name?: string }
  try {
    res.json(renameUserItem(target_path, name || ''))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to rename item' })
  }
})

app.post('/user-files/delete', (req, res) => {
  const { target_path } = req.body as { target_path?: string }
  try {
    res.json(deleteUserItem(target_path))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to delete item' })
  }
})

app.post('/user-files/paste', (req, res) => {
  const { source_path, target_parent_path, mode } = req.body as { source_path?: string; target_parent_path?: string; mode?: 'copy' | 'cut' }
  try {
    res.json(pasteUserItem(source_path, target_parent_path, mode))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to paste item' })
  }
})

app.post('/user-files/import', (req, res) => {
  const { paths, target_parent_path } = req.body as { paths?: string[]; target_parent_path?: string }
  try {
    res.json(importUserFiles(paths, target_parent_path))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to import files' })
  }
})

app.post('/user-files/import-jobs', (req, res) => {
  const { paths, target_parent_path } = req.body as { paths?: string[]; target_parent_path?: string }
  try {
    res.json(startUserFileImportJob(paths, target_parent_path))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to start import job' })
  }
})

app.get('/user-files/import-jobs/:id', (req, res) => {
  const job = getUserFileImportJob(req.params.id)
  if (!job) {
    res.status(404).json({ detail: 'import job not found' })
    return
  }
  res.json(job)
})

app.post('/works/:id/messages/delete', (req, res) => {
  const { messageIds } = req.body as { messageIds: string[] }
  if (!messageIds?.length) { res.status(400).json({ detail: 'messageIds required' }); return }
  store.deleteMessages(messageIds)
  res.json({ ok: true, deleted: messageIds.length })
})

// 鈹€鈹€ Scheduled Tasks 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const CreateTaskSchema = z.object({
  title: z.string().min(1),
  cron_expression: z.string().min(1),
  prompt_template: z.string().default(''),
  notify_channels: z.array(z.string()).optional().default([]),
  enabled: z.boolean().optional().default(false),
})

const UpdateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  cron_expression: z.string().min(1).optional(),
  prompt_template: z.string().optional(),
  enabled: z.boolean().optional(),
  notify_channels: z.array(z.string()).optional(),
})

app.get('/scheduled-tasks', (_req, res) => {
  const tasks = store.listScheduledTasks()
  res.json({ tasks })
})

app.post('/scheduled-tasks', (req, res) => {
  const parsed = CreateTaskSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' })
    return
  }
  const { title, cron_expression, prompt_template, notify_channels, enabled } = parsed.data

  const validation = Scheduler.validateCron(cron_expression)
  if (!validation.valid) {
    res.status(400).json({ error: validation.error ?? 'Invalid cron expression' })
    return
  }

  const task = store.createScheduledTask({
    title,
    cron_expression,
    prompt_template,
    enabled,
    notify_channels,
  })
  if (enabled) {
    scheduler.register(task.id, task.cron_expression)
  }
  res.json(task)
})

app.get('/scheduled-tasks/:id', (req, res) => {
  const task = store.getScheduledTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const executions = store.listTaskExecutions(task.id)
  const nextRun = Scheduler.getNextRun(task.cron_expression)
  res.json({
    task,
    executions,
    next_run: nextRun ? nextRun.toISOString() : undefined,
  })
})

app.patch('/scheduled-tasks/:id', (req, res) => {
  const existing = store.getScheduledTask(req.params.id)
  if (!existing) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  const parsed = UpdateTaskSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' })
    return
  }
  const updates = parsed.data

  if (updates.cron_expression) {
    const validation = Scheduler.validateCron(updates.cron_expression)
    if (!validation.valid) {
      res.status(400).json({ error: validation.error ?? 'Invalid cron expression' })
      return
    }
  }

  const updated = store.updateScheduledTask(req.params.id, updates)
  if (!updated) {
    res.status(404).json({ error: 'Task not found' })
    return
  }

  // Sync scheduler based on enabled state and cron changes
  if (updates.enabled === false) {
    scheduler.unregister(updated.id)
  } else if (updates.enabled === true) {
    scheduler.register(updated.id, updated.cron_expression)
  } else if (updates.cron_expression && updated.enabled) {
    // cron changed but enabled wasn't explicitly set 鈥?re-register if task is enabled
    scheduler.register(updated.id, updated.cron_expression)
  }

  res.json(updated)
})

app.delete('/scheduled-tasks/:id', (req, res) => {
  const task = store.getScheduledTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  scheduler.unregister(task.id)
  store.deleteScheduledTask(task.id)
  res.status(204).end()
})

// 鈹€鈹€ Health Check 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

import { analyzeWorkTools, saveResults, loadResults, type HealthCheckResults } from './health-check.js'

// Analyze a health check work's tool calls
app.post('/health-check/analyze', (req, res) => {
  const { workId, siteId } = req.body as { workId: string; siteId: string }
  if (!workId || !siteId) { res.status(400).json({ detail: 'workId and siteId required' }); return }

  const tools = analyzeWorkTools(workId, siteId)

  // Persist results (merge with existing)
  const existing = loadResults() || { lastRun: '', results: {} }
  existing.lastRun = new Date().toISOString()
  existing.results[siteId] = { tools, workId }
  saveResults(existing)

  res.json({ tools })
})

app.get('/health-check/results', (_req, res) => {
  const results = loadResults()
  res.json(results || null)
})

// Get test prompts for all adapters
app.get('/health-check/test-prompts', (_req, res) => {
  const allAdapters = parseAllAdapters()
  const settings = getSettings()
  const customTP = settings.custom_test_prompts || {}
  const prompts: Array<{ siteId: string; siteName: string; prompt: string; toolCount: number; toolNames: string[] }> = []
  for (const [id, adapter] of allAdapters) {
    if (!getSiteEnabled(id, adapter.defaultEnabled, adapter.managed?.enabled)) continue
    const testPrompts = customTP[id] != null ? customTP[id]! : adapter.testPrompts
    if (testPrompts.length === 0) continue
    // Return all test prompts for each site
    for (const prompt of testPrompts) {
      prompts.push({
        siteId: id,
        siteName: adapter.name,
        prompt,
        toolCount: adapter.tools.length,
        toolNames: adapter.tools.map(t => t.name),
      })
    }
  }
  res.json(prompts)
})

// 鈹€鈹€ SSE Events 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  registerSSEClient(res)

  req.on('close', () => {
    unregisterSSEClient(res)
  })
})

// 鈹€鈹€ User Choice (answer to ask_user) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.post('/works/:id/user-choice', (req, res) => {
  const workId = req.params.id
  const { answer } = req.body as { answer: string }

  if (!answer?.trim()) {
    res.status(400).json({ detail: 'answer required' })
    return
  }

  const resolved = resolvePendingAskUser(workId, answer)
  if (!resolved) {
    res.status(404).json({ detail: 'No pending choice for this work' })
    return
  }

  res.json({ ok: true })
})

app.post('/terminal/run', async (req, res) => {
  const { command, cwd, shell, outputEncoding, workId } = req.body as {
    command?: string
    cwd?: string
    shell?: 'bash' | 'powershell'
    outputEncoding?: string
    workId?: string
  }
  try {
    const startedAt = Date.now()
    const result = await runWeWorkerPowerShell({
      command: command || '',
      cwd,
      shell,
      outputEncoding,
      workId,
      source: 'user',
    })
    if (workId && store.getWork(workId)) {
      const toolId = `terminal-${result.sessionId}`
      store.appendMessage(workId, 'user', [{ type: 'text', text: `!${result.command}` }])
      store.appendMessage(workId, 'assistant', [{
        type: 'tool_use',
        id: toolId,
        name: 'weworker_powershell',
        args: { command: result.command, shell: result.shell },
        result: JSON.stringify({ output: result.output || '', exitCode: result.exitCode ?? null }),
        status: result.exitCode === 0 ? 'done' : 'failed',
        execMs: Date.now() - startedAt,
      }])
    }
    res.json({
      ok: result.exitCode === 0,
      sessionId: result.sessionId,
      shell: result.shell,
      outputEncoding: result.outputEncoding,
      exitCode: result.exitCode,
      signal: result.signal,
      output: result.output,
      cwd: result.cwd,
    })
  } catch (e) {
    if (workId && command?.trim() && store.getWork(workId)) {
      store.appendMessage(workId, 'user', [{ type: 'text', text: `!${command.trim()}` }])
      store.appendMessage(workId, 'assistant', [{
        type: 'tool_use',
        id: `terminal-error-${Date.now().toString(36)}`,
        name: 'weworker_powershell',
        args: { command: command.trim(), shell: inferTerminalShell(command.trim(), shell) },
        result: e instanceof Error ? e.message : String(e),
        status: 'failed',
      }])
    }
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/terminal/stop', (req, res) => {
  const { sessionId } = req.body as { sessionId?: string }
  const stopped = stopTerminalSession(sessionId)
  res.json({ ok: stopped })
})

function extractAnthropicText(payload: unknown): string {
  const data = payload as { content?: Array<{ type?: string; text?: string }> }
  return (data.content || [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim()
}

function parseTerminalAssistJson(text: string): {
  title: string
  message: string
  bullets: string[]
  command: string
} {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const raw = (fenced || text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    const [first, ...rest] = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return {
      title: (first || '我理解了你的终端请求。').slice(0, 240),
      message: rest.join('\n').slice(0, 800),
      bullets: [],
      command: '',
    }
  }
  let parsed: Partial<{
    title: unknown
    message: unknown
    bullets: unknown
    command: unknown
  }>
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<{
      title: unknown
      message: unknown
      bullets: unknown
      command: unknown
    }>
  } catch {
    const clean = raw.replace(/```(?:json)?|```/gi, '').trim()
    const [first, ...rest] = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return {
      title: (first || '我理解了你的终端请求。').slice(0, 240),
      message: rest.join('\n').slice(0, 800),
      bullets: [],
      command: '',
    }
  }
  return {
    title: String(parsed.title || '我理解了你的终端请求。').trim().slice(0, 240),
    message: String(parsed.message || '').trim().slice(0, 800),
    bullets: Array.isArray(parsed.bullets)
      ? parsed.bullets.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
      : [],
    command: String(parsed.command || '').trim().replace(/\r?\n/g, ' && ').slice(0, 500),
  }
}

app.post('/terminal/assist', async (req, res) => {
  const { input, cwd, shell, context } = req.body as {
    input?: string
    cwd?: string
    shell?: 'bash' | 'powershell'
    context?: string
  }
  const prompt = String(input || '').trim()
  if (!prompt) {
    res.status(400).json({ detail: 'input required' })
    return
  }

  const settings = getSettings()
  if (!settings.api_key) {
    res.status(400).json({ detail: 'API key not configured' })
    return
  }

  let baseUrl: string
  try {
    baseUrl = assertAllowedLlmBaseUrl(settings.base_url, buildRuntimeAllowedLlmBaseUrls(settings.base_url_custom, settings.openai_base_url_custom))
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
    return
  }
  const effectiveProviderId = settings.active_provider === 'custom'
    ? findProviderByWeWorkerBaseUrl(baseUrl)?.id || settings.active_provider
    : settings.active_provider

  const terminalPrompt = renderPrompt('terminal', {})
  const system = terminalPrompt.endsWith('\n') ? terminalPrompt.slice(0, -1) : terminalPrompt
  const user = [
    `当前 shell: ${inferTerminalShell('', shell)}`,
    `当前目录: ${cwd || getUserDirectory()}`,
    context ? `最近终端上下文:\n${String(context).slice(-3000)}` : '',
    `用户输入: ${prompt}`,
  ].filter(Boolean).join('\n\n')

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...buildAnthropicAuthHeaders(settings.api_key, effectiveProviderId, settings.custom_auth_type),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = (data as { error?: { message?: string } }).error?.message || 'AI assistant failed'
      res.status(400).json({ detail })
      return
    }
    const text = extractAnthropicText(data)
    const parsed = parseTerminalAssistJson(text)
    res.json({
      input: prompt,
      cwd: cwd || getUserDirectory(),
      shell: shell === 'powershell' ? 'powershell' : 'bash',
      ...parsed,
    })
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : 'AI assistant failed' })
  }
})

// 鈹€鈹€ Chat (SSE streaming) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

import { generateTitle, generateTitleWithLLM } from './title-utils.js'

async function streamConversationCompaction(
  workId: string,
  messages: store.Message[],
  settings: ReturnType<typeof getSettings>,
  send: (event: object) => void,
): Promise<{ status: 'completed' | 'skipped'; reason?: string }> {
  let completed = false
  let skipped = false
  let skipReason = ''
  let failureReason = ''
  for await (const event of streamChat(messages, settings, undefined, {
    workId,
    forceCompaction: true,
    compactionOnly: true,
  })) {
    if (event.type === 'context_compaction_start' || event.type === 'context_compaction_end') {
      send(event)
      if (event.type === 'context_compaction_end' && event.compaction?.status === 'completed') completed = true
      if (event.type === 'context_compaction_end' && event.compaction?.status === 'skipped') {
        skipped = true
        skipReason = event.compaction.reason || 'no_droppable_history'
      }
      if (event.type === 'context_compaction_end' && event.compaction?.status === 'failed') {
        failureReason = event.compaction.error || '摘要器未完成压缩'
      }
    }
    if (event.type === 'context_snapshot') send(event)
    if (event.type === 'usage') send(event)
    if (event.type === 'error') {
      failureReason = event.content || '压缩请求返回错误'
      break
    }
  }
  if (completed) return { status: 'completed' }
  if (skipped) return { status: 'skipped', reason: skipReason }
  const detail = failureReason || '对话压缩未完成'
  chatLog.error('conversation compaction failed', { workId, detail })
  throw new Error(detail)
}

app.post('/works/:id/compact', async (req, res) => {
  const workId = req.params.id
  const work = store.getWorkWithMessages(workId)
  if (!work) {
    res.status(404).json({ detail: 'Work not found' })
    return
  }
  const settings = getSettings()
  const events: object[] = []
  try {
    const result = await streamConversationCompaction(workId, work.messages, settings, (event) => {
      events.push(event)
    })
    res.json({ ok: true, ...result, events })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    chatLog.error('conversation compaction route failed', { workId, detail })
    res.status(500).json({ ok: false, detail })
    return
  }
})


app.post('/works/:id/chat', async (req, res) => {
  const workId = req.params.id
  const { message, modelMessage, attachments, retryCompaction } = req.body as {
    message: string;
    modelMessage?: string;
    attachments?: Array<{ path?: string; name?: string }>;
    retryCompaction?: boolean;
  }

  if (!message?.trim() && (!Array.isArray(attachments) || attachments.length === 0)) {
    res.status(400).json({ detail: 'message or attachments required' })
    return
  }

  const work = store.getWork(workId)
  if (!work) {
    res.status(404).json({ detail: 'Work not found' })
    return
  }

  let userContent: store.ContentBlock[] = []
  let importedAttachments: store.ContentBlock[] = []
  let savedUserMessage: store.Message | null = null
  if (retryCompaction === true) {
    const existingWork = store.getWorkWithMessages(workId)
    if (!existingWork) {
      res.status(404).json({ detail: 'Work not found' })
      return
    }
    savedUserMessage = [...existingWork.messages].reverse().find((msg) => msg.role === 'user') ?? null
    if (!savedUserMessage) {
      res.status(400).json({ detail: '没有可重试的用户消息' })
      return
    }
    userContent = savedUserMessage.content
  } else {
    try {
      importedAttachments = Array.isArray(attachments) ? importChatAttachments(attachments) : []
      userContent = [
        ...importedAttachments,
        ...(message?.trim() ? [{ type: 'text' as const, text: message }] : []),
      ]
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : 'failed to import attachments' })
      return
    }

    // Save user message
    savedUserMessage = store.appendMessage(workId, 'user', userContent)
  }

  // Auto-title from first message: immediate fallback, then async LLM refinement
  const isFirstMessage = !work.title
  const titleSource = message?.trim() || importedAttachments.map((block) => block.type === 'file_attachment' ? block.name : '').filter(Boolean).join(', ')
  if (isFirstMessage && retryCompaction !== true) {
    store.updateTitle(workId, generateTitle(titleSource))
  }

  const workWithMessages = store.getWorkWithMessages(workId)!
  const modelInputMessage = typeof modelMessage === 'string' && modelMessage.trim() ? modelMessage : message
  const modelMessages = modelInputMessage === message
    ? workWithMessages.messages
    : workWithMessages.messages.map((msg) => (
        msg.id === savedUserMessage.id
          ? {
              ...msg,
              content: [
                ...importedAttachments,
                { type: 'text' as const, text: modelInputMessage },
              ],
            }
          : msg
      ))
  const settings = getSettings()
  const zcfPrefs = resolveZcfPrefs(work, settings)

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const abortController = new AbortController()

  // Listen on the response (not request) for client disconnect.
  // req.on('close') fires when the request body stream ends (i.e. right
  // after express.json() consumes the POST body), NOT when the TCP
  // connection drops. res.on('close') fires when the underlying socket
  // is closed, which is what we actually want.
  let finished = false
  const onClose = () => {
    chatLog.info(` res.close fired 鈥?finished=${finished}, workId=${workId}`)
    if (!finished) {
      chatLog.info('client disconnected while streaming, aborting')
      abortController.abort()
    }
  }
  res.on('close', onClose)

  // Accumulate assistant content for persistence
  const assistantContent: store.ContentBlock[] = []
  let currentText = ''
  const toolCallMap = new Map<string, { name: string; args: unknown }>()
  let memoryCandidateIndex = 0
  const memoryCandidates: MemoryUpdateCandidate[] = []

  const send = (event: object) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const processMemoryCandidate = (candidate: MemoryUpdateCandidate) => {
    memoryCandidateIndex += 1
    memoryCandidates.push(candidate)
    chatLog.info(`${tag} memory_candidate_received`, {
      candidate_index: memoryCandidateIndex,
      candidate_action: candidate.action,
      candidate_memory_type: candidate.memory_type,
    })
  }

  if (retryCompaction !== true) {
    send({ type: 'user_message_saved', message: savedUserMessage })
  }

  // Fire async LLM title generation (non-blocking)
  if (isFirstMessage) {
    generateTitleWithLLM(titleSource, settings).then(llmTitle => {
      if (llmTitle) {
        store.updateTitle(workId, llmTitle)
        send({ type: 'title_update', title: llmTitle, workId })
        broadcastSSE({ type: 'works_changed', workId })
      }
    })
  }

  const chatStartTime = Date.now()
  const turnId = Math.random().toString(36).slice(2, 8)
  let stepIndex = 0
  let lastToolStartTime = 0
  let lastToolName = ''
  let lastStepEndTime = chatStartTime
  // Per-turn timing accumulators: llmMsTotal = all LLM generation segments, execMsTotal = all tool execution
  let llmMsTotal = 0
  let execMsTotal = 0

  const tag = `[${workId}][${turnId}]`

  // Optional product profiles may answer a query before the normal LLM route.
  // The public profile has no registered route and always falls through.
  if (await tryBackendProfileQueryRoute({ message, workId, turnId, chatStartTime, send, log: (m: string) => chatLog.info(`${tag} ${m}`), llmRouteSettings: getSettings() })) {
    finished = true
    res.off('close', onClose)
    broadcastSSE({ type: 'works_changed', workId })
    res.end()
    return
  }

  const unsubscribeTerminalEvents = onTerminalEvent((event) => {
    if (event.workId !== workId) return
    send({ type: 'terminal_event', data: event })
  })

  let turnSucceeded = false
  let streamFailed = false
  // Each assistant response owns an independent memory decision. Keep every
  // decision; a later response must not overwrite an earlier one.
  const memoryParseOutcomes: MemoryParseOutcome[] = []
  let memoryAdapters: Array<{ id: string; name: string; match: string[] }> = []
  let enabledAdapterIds = new Set<string>()
  let initialMemoryScope = { user: 'local' }
  try {
    chatLog.info(`${tag} 鈻?turn start`)
    // Send turnId to frontend so users can correlate logs
    send({ type: 'turn_start', turnId, workId })
    // Build the set of enabled adapter IDs from config
    const allAdapters = parseAllAdapters()
    enabledAdapterIds = new Set(
      [...allAdapters.entries()].filter(([id, a]) => getSiteEnabled(id, a.defaultEnabled, a.managed?.enabled)).map(([id]) => id)
    )
    memoryAdapters = [...allAdapters.values()].map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      match: adapter.match,
    }))
    initialMemoryScope = buildMemoryEventContext({
      baseScope: { user: 'local' },
      userMessage: message,
      adapters: memoryAdapters,
      toolCalls: [],
    }).scope as { user: string }
    for await (const ev of streamChat(modelMessages, settings, abortController, {
      enabledAdapterIds,
      workId,
      zcfRole: zcfPrefs.zcfRole,
      zcfMode: zcfPrefs.zcfMode,
      memoryScope: initialMemoryScope,
      onAskUser: (event) => send(event),
    })) {
      if (ev.type === 'skill_context' && ev.skillContext) {
        assistantContent.push(ev.skillContext)
      } else if (ev.type === 'text_delta' && ev.content) {
        send(ev)
        currentText += ev.content
      } else if (ev.type === 'memory_candidate' && ev.candidate) {
        processMemoryCandidate(ev.candidate)
      } else if (ev.type === 'memory_parse' && ev.memoryParse) {
        memoryParseOutcomes.push(ev.memoryParse.outcome)
      } else if (ev.type === 'context_compaction_start' || ev.type === 'context_compaction_end') {
        send(ev)
      } else if (ev.type === 'tool_call_start' && ev.id) {
        // Deduplicate: streaming mode sends tool_call_start twice (stream_event + assistant message)
        const isUpdate = toolCallMap.has(ev.id)
        let thinkMs: number | undefined
        if (!isUpdate) {
          stepIndex++
          lastToolStartTime = Date.now()
          thinkMs = lastToolStartTime - lastStepEndTime
          llmMsTotal += thinkMs
        }
        // Resolve SDK tool name back to original adapter name
        const cleanName = resolveToolDisplayName(ev.name ?? '')
        lastToolName = cleanName
        if (!isUpdate) {
          chatLog.info(`${tag} 🔧 step ${stepIndex}: ${cleanName} (think=${(thinkMs! / 1000).toFixed(2)}s)`)
        }
        // Send cleaned name + LLM think time to frontend via SSE
        send({ ...ev, name: cleanName, ...(thinkMs !== undefined ? { thinkMs } : {}) })
        if (currentText) {
          assistantContent.push({ type: 'text', text: currentText })
          currentText = ''
        }
        // If this tool id already exists (args update from full assistant message), merge instead of duplicating
        const existingIdx = assistantContent.findIndex(b => b.type === 'tool_use' && (b as { id: string }).id === ev.id)
        if (existingIdx >= 0) {
          assistantContent[existingIdx] = {
            ...(assistantContent[existingIdx] as object),
            args: ev.args ?? (assistantContent[existingIdx] as { args?: unknown }).args,
            name: cleanName || (assistantContent[existingIdx] as { name?: string }).name,
          } as store.ContentBlock
        } else {
          toolCallMap.set(ev.id, { name: cleanName, args: ev.args })
          assistantContent.push({ type: 'tool_use', id: ev.id, name: cleanName, args: ev.args, status: 'running', ...(thinkMs !== undefined ? { thinkMs } : {}) })
        }
      } else if (ev.type === 'tool_call_result' && ev.id) {
        const toolDuration = lastToolStartTime ? Date.now() - lastToolStartTime : 0
        execMsTotal += toolDuration
        chatLog.info(`${tag} ✅ step ${stepIndex}: ${lastToolName} done (exec=${(toolDuration / 1000).toFixed(2)}s)`)
        lastStepEndTime = Date.now()
        send({ ...ev, execMs: toolDuration })
        const idx = assistantContent.findIndex(b => b.type === 'tool_use' && (b as { id: string }).id === ev.id)
        if (idx >= 0) {
          assistantContent[idx] = { ...(assistantContent[idx] as object), result: ev.result, status: ev.isError ? 'failed' : 'done', execMs: toolDuration } as store.ContentBlock
        } else {
          assistantContent.push({ type: 'tool_use', id: ev.id, name: '', args: {}, result: ev.result, status: ev.isError ? 'failed' : 'done', execMs: toolDuration })
        }
      } else if (ev.type === 'tool_call_image' && ev.id) {
        send(ev)
        const idx = assistantContent.findIndex(b => b.type === 'tool_use' && (b as { id: string }).id === ev.id)
        if (idx >= 0) {
          const currentStatus = (assistantContent[idx] as Extract<store.ContentBlock, { type: 'tool_use' }>).status
          assistantContent[idx] = { ...(assistantContent[idx] as object), image: ev.data, status: currentStatus === 'failed' ? 'failed' : 'done' } as store.ContentBlock
        } else {
          assistantContent.push({ type: 'tool_use', id: ev.id, name: 'capture_screenshot', args: {}, image: ev.data, status: 'done' })
        }
      } else {
        if (ev.type === 'error') streamFailed = true
        send(ev)
      }
    }
    turnSucceeded = !streamFailed && !abortController.signal.aborted
  } catch (e) {
    // Silently ignore abort errors (user cancelled)
    const isAbort = e instanceof Error && (
      e.name === 'AbortError' ||
      e.message?.includes('aborted') ||
      e.message?.includes('Operation aborted')
    )
    if (!isAbort) {
      chatLog.info(`${tag} streamChat error: ${e instanceof Error ? e.message : String(e)}`)
      send({ type: 'error', content: e instanceof Error ? e.message : String(e) })
    } else {
      chatLog.info(`${tag} streamChat aborted (user cancelled)`)
    }
  } finally {
    unsubscribeTerminalEvents()
    // Account for trailing LLM text generation after the last tool
    // (or the entire turn when no tools ran — lastStepEndTime stays at chatStartTime)
    const trailingLlmMs = Date.now() - lastStepEndTime
    llmMsTotal += trailingLlmMs
    // Mark as finished so that the subsequent res.end() → close event
    // does not trigger abort on the already-completed query.
    chatLog.info(`${tag} ◼ turn end — total=${((Date.now() - chatStartTime) / 1000).toFixed(2)}s, steps=${stepIndex}`)
    send({ type: 'turn_end', turnId, workId, totalMs: Date.now() - chatStartTime, llmMs: llmMsTotal, execMs: execMsTotal, steps: stepIndex })
    finished = true
    res.off('close', onClose)
  }

  // Finalize text
  if (currentText) assistantContent.push({ type: 'text', text: currentText })

  let assistantText = assistantContent
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

  const finalizedAssistantText = await finalizeAssistantTextWithStatus({
    text: assistantText,
    hasAssistantContent: assistantContent.length > 0,
    generateStatusLine: () => generateAssistantStatusLine(assistantText, settings),
    fallbackStatusLine: '当前状态：已完成当前回复，等待下一步指令',
  })

  if (finalizedAssistantText && finalizedAssistantText !== assistantText) {
    const existingStatus = extractAssistantStatusLine(assistantText)
    if (!existingStatus) {
      const statusSuffix = finalizedAssistantText.slice(assistantText.length)
      for (let i = assistantContent.length - 1; i >= 0; i -= 1) {
        const block = assistantContent[i]
        if (block.type === 'text') {
          assistantContent[i] = { ...block, text: block.text + statusSuffix }
          break
        }
      }
      if (!assistantContent.some((block) => block.type === 'text')) {
        assistantContent.push({ type: 'text', text: finalizedAssistantText })
      }
      if (statusSuffix) {
        send({ type: 'text_delta', content: statusSuffix })
      } else if (!assistantText) {
        const fallbackText = appendAssistantStatusLine('', finalizedAssistantText)
        if (fallbackText) {
          assistantContent.push({ type: 'text', text: fallbackText })
          send({ type: 'text_delta', content: fallbackText })
        }
      }
    }
  }

  // Persist assistant message
  if (assistantContent.length > 0) {
    assistantContent.push({ type: 'timing', totalMs: Date.now() - chatStartTime, llmMs: llmMsTotal, execMs: execMsTotal, steps: stepIndex })
    store.appendMessage(workId, 'assistant', assistantContent)
  }

  const toolCallsForMemory = assistantContent
    .filter((block): block is Extract<store.ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => ({ name: block.name, args: block.args, status: block.status }))
  const memoryParseOutcome = memoryParseOutcomes.length > 0
    ? memoryParseOutcomes.includes('present_parse_error')
      ? 'present_parse_error'
      : memoryParseOutcomes.includes('present_ok')
        ? 'present_ok'
        : memoryParseOutcomes.includes('present_ignore')
          ? 'present_ignore'
          : 'missing'
    : 'missing' as MemoryParseOutcome
  const plannedMemoryEvents = memoryCandidates.flatMap((candidate, index) => {
    const planned = planCompletedChatMemoryEvents({
      baseEventId: `${savedUserMessage.id}:model-${index + 1}`,
      baseScope: { user: 'local' },
      userMessage: message,
      adapters: memoryAdapters,
      enabledAdapterIds,
      toolCalls: toolCallsForMemory,
      turnSucceeded,
      candidate,
    })
    chatLog.info(`${tag} memory_candidate_plan`, {
      candidate_index: index + 1,
      candidate_action: candidate.action,
      candidate_memory_type: candidate.memory_type,
      admit_reason: planned.admitReason,
      event_count: planned.events.length,
    })
    return planned.events.map((event) => ({ event, candidate }))
  })

  const protocolCheck = isMemoryProtocolFailure({
    toolCalls: toolCallsForMemory,
    parseOutcome: memoryParseOutcome,
    aborted: abortController.signal.aborted,
  })

  chatLog.info(`${tag} memory_plan`, {
    has_candidate: memoryCandidateIndex > 0,
    candidate_count: memoryCandidateIndex,
    parse_outcome: memoryParseOutcome,
    turn_succeeded: turnSucceeded,
    has_terminal_shell: protocolCheck.hasTerminalShell,
    protocol_violation: protocolCheck.violated ? protocolCheck.code : undefined,
  })

  if (protocolCheck.violated) {
    const protocolEventId = `${savedUserMessage.id}:protocol-${protocolCheck.code}`
    chatLog.info(`${tag} memory_protocol_violation`, {
      code: protocolCheck.code,
      parse_outcome: memoryParseOutcome,
    })
    send({
      type: 'memory_status',
      status: 'failed',
      workId,
      eventId: protocolEventId,
      error: protocolCheck.code === 'memory_block_parse_error'
        ? 'AI 返回的长期记忆候选不符合协议，未写入长期记忆'
        : '本回合执行了命令，但记忆协议未返回，未写入长期记忆',
    })
    broadcastSSE({
      type: 'memory_status',
      status: 'failed',
      workId,
      eventId: protocolEventId,
      error: protocolCheck.code === 'memory_block_parse_error'
        ? 'AI 返回的长期记忆候选不符合协议，未写入长期记忆'
        : '本回合执行了命令，但记忆协议未返回，未写入长期记忆',
    })
  }

  if (plannedMemoryEvents.length > 0) {
    for (const { event } of plannedMemoryEvents) {
      send({ type: 'memory_status', status: 'processing', workId, eventId: event.eventId })
    }
    broadcastSSE({ type: 'works_changed', workId })
    res.end()
    setImmediate(() => {
      let memoryStore: ReturnType<typeof getMemoryStore>
      try {
        memoryStore = getMemoryStore()
      } catch (error) {
        chatLog.info(`${tag} memory store unavailable: ${error instanceof Error ? error.message : String(error)}`)
        for (const { event } of plannedMemoryEvents) {
          broadcastSSE({ type: 'memory_status', workId, eventId: event.eventId, status: 'failed' })
        }
        return
      }
      for (const { event, candidate } of plannedMemoryEvents) {
        const patched = applyAdmissionToCandidate(candidate, event)
        void processMemoryEvent({
          eventId: event.eventId,
          scope: event.scope,
          expectedMemoryType: event.expectedMemoryType,
          store: memoryStore,
          candidate: patched,
        }).then((memoryResult) => {
          broadcastSSE({
            type: 'memory_status',
            workId,
            eventId: event.eventId,
            status: memoryResult.status,
            ...(memoryResult.status === 'failed' ? { error: memoryResult.error } : {}),
          })
        }).catch(() => {
          broadcastSSE({ type: 'memory_status', workId, eventId: event.eventId, status: 'failed' })
        })
      }
    })
    return
  }

  chatLog.info(` sending res.end() for workId=${workId}`)
  broadcastSSE({ type: 'works_changed', workId })
  res.end()
})

// 鈹€鈹€ Logs 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const LOG_FILE = process.env.WEWORK_LOG_FILE || path.join(os.homedir(), 'Library', 'Logs', 'WeWork', 'main.log')

app.get('/logs', (req, res) => {
  const lines = parseInt(req.query.lines as string, 10) || 500
  try {
    if (!fs.existsSync(LOG_FILE)) {
      res.json({ lines: [], path: LOG_FILE })
      return
    }
    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const allLines = content.split('\n').filter(l => l.trim())
    const tail = allLines.slice(-lines).map(redactSensitive)
    res.json({ lines: tail, path: LOG_FILE, total: allLines.length })
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

// 鈹€鈹€ Start 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

bridgeStatus.start()
bridgeRpcClient.start()

// Install adapter skills via webcli at startup
runWebcli(['install', '--skills', '--target', SKILLS_DIR], (err) => {
  if (!err) log.info('Skills installed at startup')
})

async function startConfiguredChannels(): Promise<void> {
  const s0 = getSettings()

  if (s0.channels.qq.enabled && s0.channels.qq.app_id && s0.channels.qq.app_secret) {
    const qqChannel = new QQChannel(
      { app_id: s0.channels.qq.app_id, app_secret: s0.channels.qq.app_secret },
    )
    channelManager.register('qq', qqChannel)
    channelManager.startAll().catch(e => channelLog.error('start error:', e))
  }

  if (s0.channels.weixin.enabled && s0.channels.weixin.token) {
    try {
      const wxChannel = new WeixinChannel(
        { token: s0.channels.weixin.token, base_url: assertAllowedWeixinBaseUrl(s0.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS) },
      )
      channelManager.register('weixin', wxChannel)
      wxChannel.start().catch(e => channelLog.error('start error:', e))
    } catch (e) {
      channelLog.error('weixin channel blocked:', e instanceof Error ? e.message : String(e))
    }
  }

  if (s0.channels.wecom.enabled && s0.channels.wecom.bot_id && s0.channels.wecom.secret) {
    const wecomChannel = new WecomChannel(
      { enabled: true, bot_id: s0.channels.wecom.bot_id, secret: s0.channels.wecom.secret },
    )
    channelManager.register('wecom', wecomChannel)
    wecomChannel.start().catch(e => channelLog.error('start error:', e))
  }
}

async function bootstrap(): Promise<void> {
  await initSettings()
  try {
    ensureBundledZcfInstalled(getSettings().zcf_lang)
  } catch (e) {
    log.warn('ZCF template sync skipped on startup:', e instanceof Error ? e.message : String(e))
  }
  await startConfiguredChannels()
  app.listen(PORT, '127.0.0.1', () => {
    log.info(`WeWorker backend running on http://127.0.0.1:${PORT}`)
    scheduler.start()
  })
}

bootstrap().catch((error) => {
  log.error('Failed to start backend:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
