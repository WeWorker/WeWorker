import { createSkillManagementRouter, sanitizeSkillDirectoryName } from './skill-management.js'
import { officialSkillBuildTime } from './skill-build-time.js'
import { randomUUID as channelQrId, createHash } from 'node:crypto'
import { changeChannelConfiguration, createChannelMutationQueue, getChannelConfiguration, isChannelType, publicChannelSettings, type ChannelType } from './channels/channel-configurations.js'
import express from 'express'
import { createChatTurnRegistry } from './chat-turn-lifecycle.js'
import { createAssistantSegments } from './chat-assistant-segments.js'
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
  DEFAULT_MEMORY_BUDGETS,
  normalizeMemoryBudgets,
  type MemoryBudgets,
  type Settings,
} from './config.js'
import { normalizeDownloadSubdirectory } from './download-directory.js'
import {
  normalizeUserDirectoryBlacklist,
  countInvalidBlacklistEntries,
  type UserDirectoryBlacklistEntry,
} from './user-directory-blacklist.js'
import { isAllowedHost, isAllowedOrigin, isAuthorizedHttpRequest, LOCAL_HTTP_PORT, redactSensitive } from './http-security.js'
import { isLlmProtocol, normalizeLlmUrlInput, resolveAnthropicEndpoint } from './llm-egress.js'
import {
  ALLOWED_PROVIDER_IDS,
  PROVIDER_BASE_URLS,
  findProviderByWeWorkerBaseUrl,
  PROVIDERS,
  getProvider,
} from './provider-registry.js'
import { listProviderModels, probeTimedMainConnection, probeProviderProtocol, type ProbeTarget } from './provider-model-services.js'
import { modelCatalogConfigPatch, resolveModelCatalogConfig } from './model-catalog-config.js'
import { registerExplorationModelRoutes } from './exploration-model-settings.js'
import { resolveThinkingEffort } from './thinking-effort.js'
import { buildProviderVisibility } from './provider-visibility.js'
import { createModelConfiguration, getModelConfiguration, activateModelConfiguration, updateModelConfiguration, publicModelConfigurations, buildModelConfigurationNames, renameModelConfiguration, deleteModelConfiguration } from './model-configurations.js'
import { buildAnthropicAuthHeaders, isAnthropicAuthType } from './anthropic-auth.js'
import { activateBuiltinProvider, builtinProviderAccess, isBuiltinProvider, publicBuiltinProviders } from './builtin-provider.js'
import { configuredModel } from './provider-config.js'
import { DEFAULT_CONTEXT_LIMIT, parseContextLimit } from './context-window.js'
import { isAuthorizedModelConfigRequest, resolveWebwrightModelConfig } from './webwright-model-config.js'
import { assertAllowedWeixinBaseUrl, buildAllowedWeixinBaseUrls } from './channel-egress.js'
import { resolveWeixinToken, syncWeixinChannel } from './channels/sync-weixin-channel.js'
import { isProbeChannel, probeChannel } from './channels/channel-probe.js'
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
  readResourceFilePreview,
  resolveCustomSkillAssetDir,
  saveCustomSkills,
  DuplicateSkillNameError,
} from './custom-skills.js'
import { resolveWebcliEntry } from './webcli-path.js'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { getSiteMemory, listSiteMemories, saveSiteMemoryFromActionCapture, saveSiteMemoryFromWorkflow } from './site-memory.js'
import * as store from './works-store.js'
import { tryBackendProfileQueryRoute } from './profile-query-route.js'
import { disposeChatSession, disposeIdleChatSession, getSteerableChatSession, hasChatSession, hasSpareChatSession } from './chat-session.js'
import { buildConfiguredModelEnv, messagePromptText, streamChat, type SSEEvent } from './agent.js'
import { matchSiteAdapter, resolveSiteToolkitPrompt } from './site-gate.js'
import { listToolkitSkills, resolveToolkitSkillPrompt, toolkitGateCandidates } from './toolkit-skills.js'
import { decideTier4, openTier4Turn } from './tier4-dispatch.js'
import { checkWebwrightHealth, fetchWebwrightTask } from './webwright-client.js'
import { graduationHint, recordTier4HostUsage, shouldSuggestGraduation } from './tier4-graduation.js'
import { computeRoutableSitesFromConfig, getScopedRouterConfig } from './router-config/index.js'
import { listAliasTexts } from './api-query-router/aliases.js'
import { tryIntelligentQueryRoute } from './api-query-router/index.js'
import { prepareModelRuntime } from './anthropic-endpoint-relay.js'
import { ensureRuntimeSkillsDir } from './runtime-skills-dir.js'
import { importSkillZip, importSkillZipFile } from './skill-zip-import.js'
import { renderPrompt } from './prompt-loader.js'
import {
  configureAdapterRuntimeReload,
  scheduleAdapterRuntimeReload,
} from './adapter-runtime-reload.js'
import {
  resolveStyleId,
  sanitizeStyleSettingsPatch,
  sanitizeWorkStylePatch,
} from './style-settings.js'
import { processMemoryEvent } from './memory/memory-lifecycle.js'
import { buildMemoryEventContext } from './memory/memory-event-context.js'
import { planCompletedChatMemoryEvents, applyAdmissionToCandidate } from './memory/memory-event-planner.js'
import { isMemoryProtocolFailure } from './memory/memory-protocol.js'
import type { MemoryParseOutcome } from './memory/memory-extractor.js'
import { getMemoryStore, type MemoryStore } from './memory/memory-store.js'
import {
  enforceConfiguredMemoryBudget,
  resolveMemoryBudgetKey,
  summarizeMemoryBudgetUsage,
  type MemoryBudgetKey,
  type MemoryBudgetUsage,
} from './memory/memory-capacity.js'
import type { MemoryUpdateCandidate } from './memory/memory-types.js'
import { buildAgentFilesystemSettings, createUnifiedToolGuard } from './user-directory-access.js'
import { resolvePendingAskUser, resolveToolDisplayName } from './tools.js'
import { createDesktopUserMedia } from './user-media.js'
import { inferTerminalShell, onTerminalEvent, runWeWorkerPowerShell, stopTerminalSession } from './powershell-runner.js'
import { createTurnTimingLedger } from './turn-timing.js'
import { channelManager } from './channels/channel-manager.js'
import { QqQrService, FeishuQrService } from './channels/app-bot-qr.js'
import { syncAppBotChannel } from './channels/sync-app-bot-channel.js'
import { QQChannel } from './channels/qq-channel.js'
import { WeixinChannel, fetchQRCode, pollQRStatus } from './channels/weixin-channel.js'
import { WecomChannel } from './channels/wecom-channel.js'
import { WecomQrService } from './channels/wecom-qr.js'
import { syncWecomChannel } from './channels/sync-wecom-channel.js'
import { FeishuChannel } from './channels/feishu-channel.js'
import { registerDedicatedAgentRoutes } from './dedicated-agents/routes.js'
import { buildDesktopAgentTurnOptions, startAllDedicatedAgents } from './dedicated-agents/agent-channel.js'
import { findAgentByBotId, findAgentByWeixinToken, findAgentByWorkId, listAgentProjectIds } from './dedicated-agents/agent-store.js'
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
registerDedicatedAgentRoutes(app)
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
    extension_instance: bridgeStatus.getExtensionInstance(),
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
  const visible = buildProviderVisibility(s)
  const names = buildModelConfigurationNames(s)
  return {
    active_provider: s.active_model_configuration || s.active_provider,
    onboarding_completed: s.onboarding_completed === true,
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
    base_url: isBuiltinProvider(s.active_provider) ? '' : s.base_url,
    model: s.model,
    context_limit: s.context_limit,
    has_api_key: !!s.api_key,
    providers: Object.fromEntries(Object.entries({
      ...publicBuiltinProviders(PROVIDERS),
      anthropic: { has_key: !!s.api_key_anthropic, model: configuredModel('anthropic', s.model_anthropic || ''), context_limit: s.context_limit_anthropic, added: s.added_providers.includes('anthropic'), visible: visible('anthropic') },
      bank_coding: { has_key: !!s.api_key_bank_coding, model: configuredModel('bank_coding', s.model_bank_coding || ''), context_limit: s.context_limit_bank_coding || DEFAULT_CONTEXT_LIMIT, added: s.added_providers.includes('bank_coding'), visible: visible('bank_coding') },
      glm:       { has_key: !!s.api_key_glm,       model: configuredModel('glm', s.model_glm || ''), context_limit: s.context_limit_glm, added: s.added_providers.includes('glm'), visible: visible('glm') },
      deepseek:  { has_key: !!s.api_key_deepseek,  model: configuredModel('deepseek', s.model_deepseek || ''), context_limit: s.context_limit_deepseek, added: s.added_providers.includes('deepseek'), visible: visible('deepseek') },
      custom:    { models_url_is_full: s.models_url_is_full_custom ?? Boolean(s.models_url_custom), openai_models_url_is_full: s.openai_models_url_is_full_custom ?? Boolean(s.openai_models_url_custom), models_url: s.models_url_custom || '', models_auth_type: s.models_auth_type_custom || 'inherit', openai_models_url: s.openai_models_url_custom || '', has_key: !!s.api_key_custom, openai_has_key: !!s.openai_api_key_custom || !!s.api_key_custom, model: configuredModel('custom', s.model_custom || ''), openai_model: s.openai_model_custom || s.model_custom, context_limit: s.context_limit_custom, base_url: s.base_url_custom, base_url_is_full: s.base_url_is_full_custom === true, weworker_protocol: s.weworker_protocol_custom || 'anthropic_messages', openai_base_url: s.openai_base_url_custom, openai_base_url_is_full: s.openai_base_url_is_full_custom === true, auth_type: s.custom_auth_type, added: s.added_providers.includes('custom'), visible: visible('custom') },
      ...publicModelConfigurations(s),
    }).filter(([id]) => ALLOWED_PROVIDER_IDS.has(id) || Boolean(getModelConfiguration(s, id)))
      .map(([id, configuration]) => [id, { ...configuration, name: names[id] }])),
    zcf_default_role: s.zcf_default_role,
    zcf_enabled_roles: s.zcf_enabled_roles,
    zcf_custom_roles: s.zcf_custom_roles,
    // 长期记忆按档位预算（估算 token）；Renderer 设置页读取。
    memory_budgets: normalizeMemoryBudgets(s.memory_budgets),
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

// Complete the first-run model setup. Built-in providers need no user input;
// predefined providers must already have a saved API key.
app.post('/settings/onboarding/complete', (req, res) => {
  const provider = typeof req.body?.provider === 'string' ? req.body.provider.trim() : ''
  const isPredefined = getProvider(provider)?.fixed === true
  if (!isBuiltinProvider(provider) && !isPredefined) {
    res.status(400).json({ detail: '请选择内置模型或预定义供应商' })
    return
  }

  try {
    const current = getSettings()
    let updates: Partial<Settings>
    if (isBuiltinProvider(provider)) {
      const builtin = getProvider(provider)
      if (!builtin) throw new Error('内置模型在当前构建中不可用')
      updates = activateBuiltinProvider(builtin)
    } else {
      const apiKey = provider === 'anthropic' ? current.api_key_anthropic
        : provider === 'bank_coding' ? current.api_key_bank_coding || ''
        : provider === 'glm' ? current.api_key_glm
          : current.api_key_deepseek
      if (!apiKey?.trim()) {
        res.status(400).json({ detail: '请先填写并保存 API Key' })
        return
      }
      const model = configuredModel(provider, provider === 'anthropic' ? current.model_anthropic
        : provider === 'bank_coding' ? current.model_bank_coding || ''
        : provider === 'glm' ? current.model_glm
          : current.model_deepseek)
      if (provider === 'bank_coding' && !model?.trim()) throw new Error('请先选择并保存模型')
      updates = {
        active_provider: provider,
        active_model_configuration: '',
        active_auth_type: getProvider(provider)?.authType || 'api_key',
        api_key: apiKey,
        model,
        context_limit: provider === 'anthropic' ? current.context_limit_anthropic
          : provider === 'bank_coding' ? current.context_limit_bank_coding || DEFAULT_CONTEXT_LIMIT
          : provider === 'glm' ? current.context_limit_glm
            : current.context_limit_deepseek,
        base_url: getProvider(provider)?.weworker.baseUrl || '',
        base_url_is_full: false,
      }
    }
    res.json(buildSettingsResponse(updateSettings({ ...updates, onboarding_completed: true })))
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
  }
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

// 风格设置（默认 / 预定义内置 / 自定义）。沿用既有 zcf_* 键名以避免数据迁移。
app.post('/settings/styles', (req, res) => {
  const { zcf_enabled_roles, zcf_custom_roles, zcf_default_role } = req.body as {
    zcf_enabled_roles?: string[]
    zcf_custom_roles?: Array<{ id?: string; label: string; prompt: string }>
    zcf_default_role?: string
  }
  const updates: Partial<Settings> = sanitizeStyleSettingsPatch({
    ...(typeof zcf_default_role === 'string' ? { zcf_default_role } : {}),
    ...(Array.isArray(zcf_enabled_roles) ? { zcf_enabled_roles } : {}),
    ...(Array.isArray(zcf_custom_roles) ? { zcf_custom_roles: zcf_custom_roles as Settings['zcf_custom_roles'] } : {}),
  }, getSettings())
  res.json(buildSettingsResponse(updateSettings(updates)))
})

// Save config for a specific provider (does NOT switch active provider)
app.post('/settings/provider/add', (req, res) => {
  try {
    const { id, updates } = createModelConfiguration(getSettings(), req.body.provider)
    res.json({ ...buildSettingsResponse(updateSettings(updates)), created_provider: id })
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/settings/provider/delete', (req, res) => {
  try {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : ''
    res.json(buildSettingsResponse(updateSettings(deleteModelConfiguration(getSettings(), provider))))
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/settings/provider', (req, res) => {
  const { provider, name, api_key, openai_api_key, model, openai_model, context_limit, base_url, base_url_is_full, openai_base_url, openai_base_url_is_full, auth_type, weworker_protocol, added } = req.body as {
    provider: string; name?: unknown; api_key?: string; openai_api_key?: string; model?: string; openai_model?: string; context_limit?: unknown; base_url?: string; base_url_is_full?: boolean; openai_base_url?: string; openai_base_url_is_full?: boolean; auth_type?: unknown; weworker_protocol?: unknown; added?: boolean
  }
  let nameUpdates: Partial<Settings> = {}
  if (name !== undefined) {
    try {
      nameUpdates = renameModelConfiguration(getSettings(), provider, name)
      if (Object.keys(req.body).every(key => key === 'provider' || key === 'name')) {
        res.json(buildSettingsResponse(updateSettings(nameUpdates)))
        return
      }
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
      return
    }
  }
  if (getModelConfiguration(getSettings(), provider)) {
    try {
      res.json(buildSettingsResponse(updateSettings(updateModelConfiguration(getSettings(), provider, req.body))))
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (!ALLOWED_PROVIDER_IDS.has(provider)) {
    res.status(400).json({ detail: `Provider '${provider}' is not allowed in this build` })
    return
  }
  if (isBuiltinProvider(provider)) {
    res.status(403).json({ detail: '内置模型由应用提供方管理，不支持修改' })
    return
  }
  if (getProvider(provider)?.fixedModel && model !== undefined && model !== configuredModel(provider, model)) {
    res.status(400).json({ detail: '此配置使用固定模型，不支持修改模型' })
    return
  }
  let allowedBaseUrl: string | undefined
  let allowedOpenAiBaseUrl: string | undefined
  if (provider === 'custom' && base_url_is_full !== undefined && typeof base_url_is_full !== 'boolean') {
    res.status(400).json({ detail: '使用完整 URL 必须为布尔值' })
    return
  }
  if (provider === 'custom' && (base_url !== undefined || base_url_is_full !== undefined)) {
    try {
      const value = base_url ?? getSettings().base_url_custom
      if (value || base_url !== undefined) allowedBaseUrl = normalizeLlmUrlInput(value, base_url_is_full ?? getSettings().base_url_is_full_custom ?? false)
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
      return
    }
  }
  if (provider === 'custom' && openai_base_url_is_full !== undefined && typeof openai_base_url_is_full !== 'boolean') {
    res.status(400).json({ detail: '使用完整 URL 必须为布尔值' })
    return
  }
  if (provider === 'custom' && (openai_base_url !== undefined || openai_base_url_is_full !== undefined)) {
    try {
      const value = openai_base_url ?? getSettings().openai_base_url_custom
      allowedOpenAiBaseUrl = value.trim() ? normalizeLlmUrlInput(value, openai_base_url_is_full ?? getSettings().openai_base_url_is_full_custom ?? false) : ''
    } catch (e) {
      res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
      return
    }
  }
  if (provider === 'custom' && auth_type !== undefined && !isAnthropicAuthType(auth_type)) {
    res.status(400).json({ detail: "auth_type must be 'auth_token' or 'api_key'" })
    return
  }
  if (provider === 'custom' && weworker_protocol !== undefined && !isLlmProtocol(weworker_protocol)) {
    res.status(400).json({ detail: 'WeWorker 对话协议无效' })
    return
  }
  const parsedContextLimit = context_limit === undefined ? undefined : parseContextLimit(context_limit)
  if (context_limit !== undefined && parsedContextLimit === null) {
    res.status(400).json({ detail: '上下文窗口请输入 1K 到 100M 之间的整数，可使用 K/M 单位' })
    return
  }
  const updates: Partial<ReturnType<typeof getSettings>> = { ...nameUpdates }
  if (provider === 'custom') {
    try {
      const current = getSettings()
      const catalog = modelCatalogConfigPatch(req.body, {
        models_url: current.models_url_custom, models_url_is_full: current.models_url_is_full_custom,
        openai_models_url: current.openai_models_url_custom, openai_models_url_is_full: current.openai_models_url_is_full_custom,
      })
      if (catalog.models_url !== undefined) updates.models_url_custom = catalog.models_url
      if (catalog.models_url_is_full !== undefined) updates.models_url_is_full_custom = catalog.models_url_is_full
      if (catalog.models_auth_type !== undefined) updates.models_auth_type_custom = catalog.models_auth_type
      if (catalog.openai_models_url !== undefined) updates.openai_models_url_custom = catalog.openai_models_url
      if (catalog.openai_models_url_is_full !== undefined) updates.openai_models_url_is_full_custom = catalog.openai_models_url_is_full
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
      return
    }
  }
  if (api_key) {
    if (provider === 'anthropic') updates.api_key_anthropic = api_key
    else if (provider === 'bank_coding') updates.api_key_bank_coding = api_key
    else if (provider === 'glm') updates.api_key_glm = api_key
    else if (provider === 'deepseek') updates.api_key_deepseek = api_key
    else if (provider === 'custom') updates.api_key_custom = api_key
  }
  if (openai_api_key && provider === 'custom') updates.openai_api_key_custom = openai_api_key
  if (model) {
    if (provider === 'anthropic') updates.model_anthropic = model
    else if (provider === 'bank_coding') updates.model_bank_coding = model
    else if (provider === 'glm') updates.model_glm = model
    else if (provider === 'deepseek') updates.model_deepseek = model
    else if (provider === 'custom') updates.model_custom = model
  }
  if (openai_model && provider === 'custom') updates.openai_model_custom = openai_model.trim()
  if (parsedContextLimit !== undefined && parsedContextLimit !== null) {
    if (provider === 'anthropic') updates.context_limit_anthropic = parsedContextLimit
    else if (provider === 'bank_coding') updates.context_limit_bank_coding = parsedContextLimit
    else if (provider === 'glm') updates.context_limit_glm = parsedContextLimit
    else if (provider === 'deepseek') updates.context_limit_deepseek = parsedContextLimit
    else if (provider === 'custom') updates.context_limit_custom = parsedContextLimit
  }
  if (provider === 'custom' && base_url !== undefined) updates.base_url_custom = allowedBaseUrl
  if (provider === 'custom' && base_url_is_full !== undefined) updates.base_url_is_full_custom = base_url_is_full
  if (provider === 'custom' && openai_base_url !== undefined) updates.openai_base_url_custom = allowedOpenAiBaseUrl
  if (provider === 'custom' && openai_base_url_is_full !== undefined) updates.openai_base_url_is_full_custom = openai_base_url_is_full
  if (provider === 'custom' && isAnthropicAuthType(auth_type)) updates.custom_auth_type = auth_type
  if (provider === 'custom' && isLlmProtocol(weworker_protocol)) updates.weworker_protocol_custom = weworker_protocol
  // If this provider is currently active, also update the active key/model/url
  const current = getSettings()
  if (added === true) {
    updates.added_providers = current.added_providers.includes(provider)
      ? current.added_providers
      : [...current.added_providers, provider]
  }
  if (current.active_provider === provider && !current.active_model_configuration) {
    if (provider === 'custom' && isAnthropicAuthType(auth_type)) updates.active_auth_type = auth_type
    if (api_key) updates.api_key = api_key
    if (model) updates.model = model
    if (parsedContextLimit !== undefined && parsedContextLimit !== null) updates.context_limit = parsedContextLimit
    if (provider === 'custom' && base_url !== undefined) updates.base_url = allowedBaseUrl
    if (provider === 'custom' && base_url_is_full !== undefined) updates.base_url_is_full = base_url_is_full
    if (provider === 'custom' && isLlmProtocol(weworker_protocol)) updates.active_weworker_protocol = weworker_protocol
  }
  res.json(buildSettingsResponse(updateSettings(updates)))
})

// Switch which provider is active
app.post('/settings/provider/activate', (req, res) => {
  const { provider } = req.body as { provider: string }
  if (getModelConfiguration(getSettings(), provider)) {
    try {
      res.json(buildSettingsResponse(updateSettings(activateModelConfiguration(getSettings(), provider))))
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (!ALLOWED_PROVIDER_IDS.has(provider)) {
    res.status(400).json({ detail: `Provider '${provider}' is not allowed in this build` })
    return
  }
  const builtin = getProvider(provider)
  if (builtin && isBuiltinProvider(provider)) {
    try {
      res.json(buildSettingsResponse(updateSettings(activateBuiltinProvider(builtin))))
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  const current = getSettings()
  const key =
    provider === 'anthropic' ? current.api_key_anthropic :
    provider === 'bank_coding' ? current.api_key_bank_coding || '' :
    provider === 'glm'       ? current.api_key_glm :
    provider === 'deepseek'  ? current.api_key_deepseek :
    provider === 'custom'    ? current.api_key_custom : ''
  const model =
    provider === 'anthropic' ? current.model_anthropic :
    provider === 'bank_coding' ? current.model_bank_coding || '' :
    provider === 'glm'       ? current.model_glm :
    provider === 'deepseek'  ? current.model_deepseek :
    provider === 'custom'    ? current.model_custom : ''
  const contextLimit =
    provider === 'anthropic' ? current.context_limit_anthropic :
    provider === 'bank_coding' ? current.context_limit_bank_coding || DEFAULT_CONTEXT_LIMIT :
    provider === 'glm'       ? current.context_limit_glm :
    provider === 'deepseek'  ? current.context_limit_deepseek :
    provider === 'custom'    ? current.context_limit_custom : current.context_limit
  const baseUrl =
    provider === 'custom' ? current.base_url_custom : (getProvider(provider)?.weworker.baseUrl ?? '')
  try {
    if (provider === 'custom') normalizeLlmUrlInput(baseUrl, current.base_url_is_full_custom ?? false)
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
    return
  }
  const updates: Partial<ReturnType<typeof getSettings>> = {
    active_provider: provider,
    active_model_configuration: '',
    active_auth_type: provider === 'custom' ? current.custom_auth_type : getProvider(provider)?.authType || 'api_key',
    active_weworker_protocol: provider === 'custom' ? current.weworker_protocol_custom || 'anthropic_messages' : 'anthropic_messages',
    api_key: key,
    model,
    context_limit: contextLimit,
    base_url: baseUrl,
    base_url_is_full: provider === 'custom' && current.base_url_is_full_custom === true,
  }
  res.json(buildSettingsResponse(updateSettings(updates)))
})

type ProviderRequestBody = {
  provider?: string
  api_key?: string
  openai_api_key?: string
  model?: string
  openai_model?: string
  base_url?: string
  base_url_is_full?: boolean
  openai_base_url?: string
  openai_base_url_is_full?: boolean
  auth_type?: unknown
  weworker_protocol?: unknown
  target?: ProbeTarget
  auto_auth?: boolean
}

function resolveProviderAccess(body: ProviderRequestBody) {
  const settings = getSettings()
  const configuration = getModelConfiguration(settings, body.provider)
  const provider = getProvider(configuration?.provider_id || body.provider || '')
  if (!provider) throw new Error(`Provider '${body.provider || ''}' is not allowed in this build`)
  if (isBuiltinProvider(provider.id)) return builtinProviderAccess(provider)
  const weworkerProtocol = provider.id === 'custom'
    ? body.weworker_protocol === undefined
      ? configuration?.weworker_protocol || settings.weworker_protocol_custom || 'anthropic_messages'
      : isLlmProtocol(body.weworker_protocol) ? body.weworker_protocol : (() => { throw new Error('WeWorker 对话协议无效') })()
    : provider.weworker.protocol
  const savedApiKey =
    configuration?.api_key ?? (provider.id === 'anthropic' ? settings.api_key_anthropic :
      provider.id === 'bank_coding' ? settings.api_key_bank_coding || '' :
      provider.id === 'glm' ? settings.api_key_glm :
      provider.id === 'deepseek' ? settings.api_key_deepseek : settings.api_key_custom)
  const savedOpenAiApiKey = configuration?.openai_api_key ?? (provider.id === 'custom' ? settings.openai_api_key_custom || savedApiKey : savedApiKey)
  const anthropicFullUrl = provider.id === 'custom'
    && (body.base_url_is_full ?? (configuration ? configuration.base_url_is_full ?? false : settings.base_url_is_full_custom ?? false))
  if (typeof anthropicFullUrl !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
  const anthropicUrl = body.base_url === undefined ? configuration?.base_url ?? settings.base_url_custom : body.base_url
  const openaiFullUrl = provider.id === 'custom'
    && (body.openai_base_url_is_full ?? (configuration ? configuration.openai_base_url_is_full ?? false : settings.openai_base_url_is_full_custom ?? false))
  if (typeof openaiFullUrl !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
  const openaiUrl = body.openai_base_url === undefined ? configuration?.openai_base_url ?? settings.openai_base_url_custom : body.openai_base_url
  const weworkerUrl = body.target === 'weworker'
    ? (body.base_url === undefined ? configuration?.base_url ?? settings.base_url_custom : body.base_url)
    : undefined
  const weworkerFullUrl = body.target === 'weworker'
    ? (body.base_url_is_full ?? (configuration ? configuration.base_url_is_full ?? false : settings.base_url_is_full_custom ?? false))
    : undefined
  if (weworkerFullUrl !== undefined && typeof weworkerFullUrl !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
  return {
    provider,
    target: body.target,
    weworkerProtocol,
    ...(weworkerUrl?.trim() ? { weworkerBaseUrl: normalizeLlmUrlInput(weworkerUrl, weworkerFullUrl === true) } : {}),
    ...(weworkerFullUrl !== undefined ? { weworkerFullUrl } : {}),
    apiKey: body.api_key?.trim() || savedApiKey,
    openaiApiKey: body.openai_api_key?.trim() || savedOpenAiApiKey,
    anthropicBaseUrl: provider.id === 'custom'
      ? anthropicUrl?.trim() ? normalizeLlmUrlInput(anthropicUrl, anthropicFullUrl) : undefined
      : provider.weworker.baseUrl,
    anthropicFullUrl,
    openaiBaseUrl: provider.id === 'custom'
      ? openaiUrl?.trim() ? normalizeLlmUrlInput(openaiUrl, openaiFullUrl) : undefined
      : provider.webwright.baseUrl,
    openaiFullUrl,
    anthropicAuthType: provider.id === 'custom'
      ? (body.auth_type === undefined
          ? configuration?.auth_type ?? settings.custom_auth_type
          : isAnthropicAuthType(body.auth_type)
            ? body.auth_type
            : (() => { throw new Error("auth_type must be 'auth_token' or 'api_key'") })())
      : provider.authType,
  }
}

function resolveProviderRequest(body: ProviderRequestBody) {
  const access = resolveProviderAccess(body)
  if (isBuiltinProvider(access.provider.id)) return { ...access, model: access.provider.defaultModel }
  const settings = getSettings()
  const savedModel =
    getModelConfiguration(settings, body.provider)?.model ?? (
    access.provider.id === 'anthropic' ? settings.model_anthropic :
    access.provider.id === 'bank_coding' ? settings.model_bank_coding || '' :
    access.provider.id === 'glm' ? settings.model_glm :
    access.provider.id === 'deepseek' ? settings.model_deepseek : settings.model_custom)
  const savedOpenAiModel = getModelConfiguration(settings, body.provider)?.openai_model || savedModel
  return {
    ...access,
    model: configuredModel(access.provider.id, body.model === undefined ? savedModel : body.model.trim()),
    openaiModel: configuredModel(access.provider.id, body.openai_model === undefined ? savedOpenAiModel : body.openai_model.trim()),
  }
}

app.post('/settings/provider/models', async (req, res) => {
  try {
    const settings = getSettings()
    const configuration = getModelConfiguration(settings, req.body.provider)
    if ((configuration?.provider_id || req.body.provider) === 'custom') {
      const saved = configuration || {
        models_url: settings.models_url_custom, models_auth_type: settings.models_auth_type_custom,
        models_url_is_full: settings.models_url_is_full_custom,
        openai_models_url: settings.openai_models_url_custom,
        openai_models_url_is_full: settings.openai_models_url_is_full_custom,
      }
      const catalog = resolveModelCatalogConfig({ ...req.body,
        ...(req.body.target === 'weworker' ? { openai_models_url: '', openai_models_url_is_full: true } : {}),
        ...(req.body.target === 'webwright' ? { models_url: '', models_url_is_full: true, models_auth_type: 'inherit' } : {}),
      }, saved)
      const input = resolveProviderAccess({ ...req.body,
        ...(catalog.models_url || req.body.target === 'webwright' ? { base_url: '', base_url_is_full: false } : {}),
        ...(catalog.openai_models_url || req.body.target === 'weworker' ? { openai_base_url: '', openai_base_url_is_full: false } : {}),
      })
      res.json(await listProviderModels({ ...input, modelsUrl: catalog.models_url,
        modelsUrlIsFull: catalog.models_url_is_full, openaiModelsUrlIsFull: catalog.openai_models_url_is_full,
        modelsAuthType: catalog.models_auth_type, openaiModelsUrl: catalog.openai_models_url }))
    } else res.json(await listProviderModels(resolveProviderAccess(req.body as ProviderRequestBody)))
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
      ? await probeTimedMainConnection({ ...input, autoAuth: body.auto_auth === true })
      : await probeProviderProtocol({ ...input, target: body.target, verifyResponse: true }))
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

registerExplorationModelRoutes(app, { getSettings, updateSettings })

app.get('/settings/channels', (_req, res) => {
  res.json(publicChannelSettings(getSettings()))
})

const queueChannelMutation = createChannelMutationQueue()

// A WeCom bot serves either the main channel or exactly one dedicated agent.
function assertWecomBotNotUsedByAgent(botId: string | undefined): void {
  const agent = botId ? findAgentByBotId(botId) : null
  if (agent) throw new Error(`该企业微信机器人已被专属 Agent「${agent.name}」使用，一个机器人只能连接一个 Agent`)
}

// Same rule for WeChat bots, identified by their login token.
function assertWeixinTokenNotUsedByAgent(token: string | undefined): void {
  const agent = token ? findAgentByWeixinToken(token) : null
  if (agent) throw new Error(`该微信机器人已被专属 Agent「${agent.name}」使用，一个机器人只能连接一个 Agent`)
}

async function syncChannelSettings(previous: Settings, updated: Settings) {
  await syncAppBotChannel('qq', channelManager, previous.channels.qq, updated.channels.qq,
    config => new QQChannel(config), () => channelLog.error('QQ channel start failed'))
  await syncAppBotChannel('feishu', channelManager, previous.channels.feishu, updated.channels.feishu,
    config => new FeishuChannel(config), () => channelLog.error('Feishu channel start failed'))
  await syncWecomChannel(channelManager, previous.channels.wecom, updated.channels.wecom,
    config => new WecomChannel(config), () => channelLog.error('WeCom channel start failed'))
  await syncWeixinChannel(channelManager, previous.channels.weixin, updated.channels.weixin,
    config => new WeixinChannel(config), () => channelLog.error('Weixin channel start failed'))
}

async function mutateChannelProfile(type: ChannelType, action: string, id: unknown, input: Record<string, unknown> = {}) {
  return queueChannelMutation('settings', async () => {
    const previous = getSettings()
    if (type === 'weixin' && action === 'save' && input.base_url !== undefined) {
      if (typeof input.base_url !== 'string') throw new Error('微信服务地址格式无效')
      input = { ...input, base_url: assertAllowedWeixinBaseUrl(input.base_url, ALLOWED_WEIXIN_BASE_URLS) }
    }
    const change = changeChannelConfiguration(previous, type, action, id, input)
    if (action === 'save' || action === 'activate') {
      const entry = change.updates.channel_configurations[change.id]
      if (type === 'wecom') assertWecomBotNotUsedByAgent(entry ? (entry.config as { bot_id?: string }).bot_id : '')
      if (type === 'weixin') assertWeixinTokenNotUsedByAgent(entry ? (entry.config as { token?: string }).token : '')
    }
    const updated = updateSettings(change.updates)
    await syncChannelSettings(previous, updated)
    return { ...publicChannelSettings(getSettings()), selected_id: change.id }
  })
}

app.post('/settings/channels/configuration', async (req, res) => {
  const { channel, action, id, config = {}, name } = req.body || {}
  if (!isChannelType(channel) || !config || typeof config !== 'object' || Array.isArray(config)) return res.status(400).json({ detail: '机器人配置格式无效' })
  try { res.json(await mutateChannelProfile(channel, action, id, action === 'rename' ? { name } : config)) }
  catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '机器人操作失败' }) }
})

const channelProbesInFlight = new Set<string>()
app.post('/settings/channels/probe', async (req, res) => {
  const { channel, config = {}, profile_id } = req.body || {}
  if (!isProbeChannel(channel) || !config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ detail: '通道或配置格式无效' })
  }
  if (channelProbesInFlight.has(channel)) return res.status(409).json({ detail: '该通道正在检测，请稍后重试' })
  channelProbesInFlight.add(channel)
  try {
    const settings = getSettings()
    const saved = profile_id === undefined ? settings.channels[channel] : getChannelConfiguration(settings, channel, profile_id).config
    const isActive = profile_id === undefined || settings.active_channel_configurations?.[channel] === profile_id
    const active = channel === 'wecom' && isActive ? channelManager.getChannel('wecom') : undefined
    const wxUser = channel === 'weixin' && isActive ? store.getLatestChannelNotifyTarget('weixin') : null
    const result = await probeChannel(channel, config, { ...saved }, {
      allowedWeixinUrls: ALLOWED_WEIXIN_BASE_URLS,
      activeWecom: active instanceof WecomChannel ? active : undefined,
      weixinUser: wxUser?.user_id ? { id: wxUser.user_id, contextToken: wxUser.extra?.context_token } : undefined,
    })
    res.json(result)
  } catch {
    res.status(500).json({ detail: '通道检测失败，请稍后重试' })
  } finally {
    channelProbesInFlight.delete(channel)
  }
})

app.post('/settings/channels', async (req, res) => {
  try { await queueChannelMutation('settings', async () => {
  const { qq, weixin, wecom, feishu } = req.body as {
    qq?: { enabled?: boolean; app_id?: string; app_secret?: string; owner_user_id?: string; owner_permission_level?: string }
    weixin?: { enabled?: boolean; token?: string; base_url?: string; owner_user_id?: string; owner_permission_level?: string }
    wecom?: { enabled?: boolean; bot_id?: string; secret?: string; owner_user_id?: string; owner_permission_level?: string }
    feishu?: { enabled?: boolean; app_id?: string; app_secret?: string; owner_user_id?: string; owner_permission_level?: string }
  }
  const s = getSettings()
  const nextOwnerIds = {
    qq: qq?.owner_user_id ?? s.channels.qq.owner_user_id,
    weixin: weixin?.owner_user_id ?? s.channels.weixin.owner_user_id,
    wecom: wecom?.owner_user_id ?? s.channels.wecom.owner_user_id,
    feishu: feishu?.owner_user_id ?? s.channels.feishu.owner_user_id,
  }
  for (const channel of ['qq', 'weixin', 'wecom', 'feishu'] as const) {
    const error = validateOwnerUserId(channel, nextOwnerIds[channel])
    if (error) return res.status(400).json({ detail: error })
  }
  try {
    assertWecomBotNotUsedByAgent(String(wecom?.bot_id ?? s.channels.wecom.bot_id ?? '').trim())
  } catch (e) {
    return res.status(409).json({ detail: e instanceof Error ? e.message : String(e) })
  }
  let nextWeixinBaseUrl: string
  let nextWeixinToken: string
  try {
    nextWeixinToken = resolveWeixinToken(weixin?.token, s.channels.weixin.token)
    nextWeixinBaseUrl = assertAllowedWeixinBaseUrl(weixin?.base_url ?? s.channels.weixin.base_url, ALLOWED_WEIXIN_BASE_URLS)
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
    return
  }
  try {
    assertWeixinTokenNotUsedByAgent(nextWeixinToken)
  } catch (e) {
    return res.status(409).json({ detail: e instanceof Error ? e.message : String(e) })
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
        token: nextWeixinToken,
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
      feishu: {
        enabled: feishu?.enabled ?? s.channels.feishu.enabled,
        app_id: feishu?.app_id ?? s.channels.feishu.app_id,
        app_secret: feishu?.app_secret ?? s.channels.feishu.app_secret,
        owner_user_id: nextOwnerIds.feishu,
        owner_permission_level: normalizeOwnerPermissionLevel(feishu?.owner_permission_level ?? s.channels.feishu.owner_permission_level),
      },
    },
  })

  // Dynamic channel start/stop based on new settings
  if (qq) await syncAppBotChannel('qq', channelManager, s.channels.qq, updated.channels.qq,
    config => new QQChannel(config), () => channelLog.error('QQ channel start failed'))

  // WeChat
  await syncWeixinChannel(channelManager, s.channels.weixin, updated.channels.weixin,
    config => new WeixinChannel(config), () => channelLog.error('Weixin channel start failed'))

  // WeCom (浼佷笟寰俊)
  await syncWecomChannel(channelManager, s.channels.wecom, updated.channels.wecom,
    config => new WecomChannel(config), () => channelLog.error('WeCom channel start failed'))

  if (feishu) await syncAppBotChannel('feishu', channelManager, s.channels.feishu, updated.channels.feishu,
    config => new FeishuChannel(config), () => channelLog.error('Feishu channel start failed'))

  res.json(publicChannelSettings(updated))
  }) } catch { res.status(500).json({ detail: '保存机器人配置失败，请重试' }) }
})

// 鈹€鈹€ WeChat QR Login 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// These credential-bearing responses must never be cached or logged.
for (const [type, service] of [['qq', new QqQrService()], ['feishu', new FeishuQrService()]] as const) {
  app.post(`/settings/${type}/qr-start`, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json(await service.start()) }
    catch { res.status(502).json({ detail: '获取二维码失败，请稍后重试或手动配置' }) }
  })
  app.post(`/settings/${type}/qr-poll`, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (typeof req.body?.session_id !== 'string') { res.status(400).json({ detail: '请先获取二维码' }); return }
    try { res.json(await service.poll(req.body.session_id)) }
    catch { res.status(502).json({ detail: '获取扫码结果失败，请重新扫码或手动配置' }) }
  })
  app.post(`/settings/${type}/qr-cancel`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (typeof req.body?.session_id === 'string') service.cancel(req.body.session_id)
    res.json({ ok: true })
  })
}

// In-memory QR login state
const wecomQr = new WecomQrService()
app.post('/settings/wecom/qr-start', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try { res.json(await wecomQr.start()) }
  catch { res.status(502).json({ detail: '获取企业微信二维码失败，请稍后重试' }) }
})
app.post('/settings/wecom/qr-poll', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (typeof req.body?.session_id !== 'string') { res.status(400).json({ detail: '请先获取二维码' }); return }
  try { res.json(await wecomQr.poll(req.body.session_id)) }
  catch { res.status(502).json({ detail: '获取扫码结果失败，请重新扫码或手动填写' }) }
})
app.post('/settings/wecom/qr-cancel', (req, res) => {
  if (typeof req.body?.session_id === 'string') wecomQr.cancel(req.body.session_id)
  res.json({ ok: true })
})

let _weixinQrState: { qrcode: string; qrcodeUrl: string; startedAt: number; profileId?: string; sessionId: string; completing?: boolean } | null = null

app.post('/settings/weixin/qr-start', async (req, res) => {
  try {
    const s = getSettings()
    const profileId = req.body?.profile_id
    const saved = profileId === undefined ? s.channels.weixin : getChannelConfiguration(s, 'weixin', profileId).config as typeof s.channels.weixin
    const baseUrl = assertAllowedWeixinBaseUrl(saved.base_url, ALLOWED_WEIXIN_BASE_URLS)
    const qr = await fetchQRCode(baseUrl)
    _weixinQrState = { qrcode: qr.qrcode, qrcodeUrl: qr.qrcode_img_content, startedAt: Date.now(), profileId, sessionId: channelQrId() }
    res.json({ ok: true, qrcode_url: qr.qrcode_img_content, session_id: _weixinQrState.sessionId })
  } catch (e) {
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/settings/weixin/qr-poll', async (req, res) => {
  if (!_weixinQrState) {
    res.status(400).json({ detail: '请先发起扫码登录' })
    return
  }
  const run = _weixinQrState
  if (run.completing) return res.json({ status: 'waiting', message: '正在保存配置…' })
  if ((run.profileId && req.body?.session_id !== run.sessionId) || (req.body?.session_id && req.body.session_id !== run.sessionId)) return res.status(409).json({ detail: '二维码已被替换，请重新扫码' })
  // Expire after 5 minutes
  if (Date.now() - _weixinQrState.startedAt > 5 * 60_000) {
    _weixinQrState = null
    res.json({ status: 'expired', message: '二维码已过期，请重新生成' })
    return
  }
  try {
    const s = getSettings()
    const saved = run.profileId ? getChannelConfiguration(s, 'weixin', run.profileId).config as typeof s.channels.weixin : s.channels.weixin
    const baseUrl = assertAllowedWeixinBaseUrl(saved.base_url, ALLOWED_WEIXIN_BASE_URLS)
    const status = await pollQRStatus(baseUrl, run.qrcode)
    if (_weixinQrState !== run) return res.status(409).json({ detail: '二维码已更新，请重新扫码' })

    if (status.status === 'confirmed' && status.bot_token) {
      if (run.completing) return res.json({ status: 'waiting', message: '正在保存配置…' })
      run.completing = true
      const config = {
        enabled: true, token: status.bot_token,
        base_url: assertAllowedWeixinBaseUrl(status.baseurl || saved.base_url, ALLOWED_WEIXIN_BASE_URLS),
        owner_user_id: saved.token === status.bot_token ? saved.owner_user_id : '',
        owner_permission_level: saved.token === status.bot_token ? normalizeOwnerPermissionLevel(saved.owner_permission_level) : 'qa_only',
      }
      if (run.profileId) await mutateChannelProfile('weixin', 'save', run.profileId, config)
      else await queueChannelMutation('settings', async () => {
        assertWeixinTokenNotUsedByAgent(config.token)
        const previous = getSettings()
        const updated = updateSettings({ channels: { ...previous.channels, weixin: { ...previous.channels.weixin, ...config, owner_permission_level: normalizeOwnerPermissionLevel(config.owner_permission_level) } } })
        await syncChannelSettings(previous, updated)
      })
      if (_weixinQrState === run) _weixinQrState = null

      res.json({ status: 'confirmed', message: '微信连接成功' })
    } else if (status.status === 'expired') {
      _weixinQrState = null
      res.json({ status: 'expired', message: '二维码已过期，请重新生成' })
    } else {
      res.json({ status: status.status, message: status.status === 'scaned' ? '已扫码，请在微信确认' : '等待扫码…' })
    }
  } catch (e) {
    run.completing = false
    res.status(500).json({ detail: e instanceof Error ? e.message : String(e) })
  }
})

// 鈹€鈹€ Skills 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

app.use(createSkillManagementRouter(SKILLS_DIR, (name) => officialSkillBuildTime(name,
  (id) => parseAllAdapters().get(id)?.managed?.source === 'builtin',
)))

app.post('/skills/import-zip', express.raw({ type: ['application/zip', 'application/x-zip-compressed'], limit: '50mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ detail: '请选择 ZIP 文件' })
    return
  }
  try {
    const archiveName = typeof req.query.name === 'string' && req.query.name
      ? req.query.name
      : 'imported-skill.zip'
    const skills = await importSkillZip(req.body, SKILLS_DIR, archiveName)
    res.json({ ok: true, skills })
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : '导入 Skill ZIP 失败' })
  }
})

app.post('/skills/import-zip-path', async (req, res) => {
  const archivePath = typeof req.body?.path === 'string' ? req.body.path : ''
  if (!archivePath) {
    res.status(400).json({ detail: '请选择 ZIP 文件' })
    return
  }
  try {
    const skills = await importSkillZipFile(archivePath, SKILLS_DIR)
    res.json({ ok: true, skills })
  } catch (error) {
    res.status(400).json({ detail: error instanceof Error ? error.message : '导入 Skill ZIP 失败' })
  }
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
  let runtime: Awaited<ReturnType<typeof prepareModelRuntime>> | undefined
  try {
    runtime = await prepareModelRuntime(settings)
    for await (const msg of query({
      prompt: '浣犲ソ',
      options: {
        model: settings.model,
        permissionMode: 'default',
        canUseTool: createUnifiedToolGuard(),
        settings: buildAgentFilesystemSettings(getUserDirectory()),
        mcpServers: { weworker: mcpServer },
        env: buildConfiguredModelEnv(runtime.settings),
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
  } finally {
    await runtime?.close()
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
    iconUrl: a.iconUrl,
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
  // 路由直达徽标（第 3/4 层之上的配置面）：只对**已启用**站点计算，且条目必须落在当前
  // Adapter 集合内（作用域过滤），因此站点被禁用或它的路由条目引用了不存在的工具时，
  // 徽标会如实熄灭，而不是留下一个「配置里还写着」的假亮。
  // 坏配置不能让只读接口 500：加载失败一律退化为「全部不可直达」。
  const enabledIds = new Set(sites.filter((site) => site.enabled).map((site) => site.id))
  const { routable: routableIds, entryCount: routeEntryCount } = computeRoutableSitesFromConfig(enabledIds)
  res.json(sites.map((site) => ({
    ...site,
    routable: routableIds.has(site.id),
    routeEntryCount: routeEntryCount.get(site.id) ?? 0,
  })))
})

// 当前生效的 `!别名` 清单（`router-config/aliases.json` + 用户覆盖层，经作用域过滤）。
// 输入框据此判断「`!xxx` 是路由命令还是 shell 命令」，从而与后端别名**同源**——
// 改配置后前端不需要跟着改硬编码清单，避免两边漂移。
app.get('/router/aliases', (_req, res) => {
  try {
    const enabledIds = new Set(
      [...parseAllAdapters().values()]
        .filter(a => getSiteEnabled(a.id, a.defaultEnabled, a.managed?.enabled))
        .map(a => a.id),
    )
    res.json({ aliases: listAliasTexts(getScopedRouterConfig(enabledIds).bundle.aliases?.aliases) })
  } catch (error) {
    log.warn('router aliases unavailable', error)
    res.json({ aliases: [] })
  }
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
    { name: 'send_file_to_user', description: '把文件发给当前对话的用户（桌面端显示为附件，机器人对话发回该会话）', parameters: [{ name: 'file_path', type: 'string', description: '文件绝对路径', required: true }] },
    { name: 'send_image_to_user', description: '把图片发给当前对话的用户（桌面端直接显示，机器人对话发回该会话）', parameters: [{ name: 'file_path', type: 'string', description: '图片绝对路径', required: true }] },
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
  // Dedicated agent conversations share the same work records and are visible in the main list.
  res.json(store.listWorks())
})

app.get('/projects', (_req, res) => {
  // 专属 Agent folders are generated from the Agent name: flag them so the
  // renderer can hide the manual rename entry.
  const agentProjectIds = listAgentProjectIds()
  res.json(store.listProjects().map((project) => (
    agentProjectIds.has(project.id) ? { ...project, dedicated_agent: true } : project
  )))
})

app.post('/projects', (req, res) => {
  try {
    const { name } = req.body as { name?: string }
    res.status(201).json(store.createProject(name || ''))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(message.includes('already exists') ? 409 : 400).json({ detail: message })
  }
})

app.patch('/projects/:id', (req, res) => {
  try {
    if (listAgentProjectIds().has(req.params.id)) {
      res.status(400).json({ detail: '这个文件夹由专属 Agent 自动维护，改名请直接修改 Agent 名称' })
      return
    }
    const { name } = req.body as { name?: string }
    const project = store.renameProject(req.params.id, name || '')
    if (!project) { res.status(404).json({ detail: 'Not found' }); return }
    res.json(project)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(message.includes('already exists') ? 409 : 400).json({ detail: message })
  }
})

app.delete('/projects/:id', (req, res) => {
  try {
    store.deleteProject(req.params.id)
    res.json({ ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message === 'project not found') { res.status(404).json({ detail: message }); return }
    res.status(409).json({ detail: message })
  }
})

app.post('/works', (req, res) => {
  const { project_id, zcf_role } = req.body as { project_id?: string | null; zcf_role?: string | null }
  const work = store.createWork('', project_id ?? null)
  if (zcf_role !== undefined) {
    const prefs = sanitizeWorkStylePatch({ zcf_role }, getSettings())
    const updated = store.updateWorkStyle(work.id, prefs)
    broadcastSSE({ type: 'works_changed', workId: work.id })
    res.json(updated ?? work)
    return
  }
  broadcastSSE({ type: 'works_changed', workId: work.id })
  res.json(work)
})

app.patch('/works/:id/style', (req, res) => {
  const { zcf_role } = req.body as { zcf_role?: string | null }
  const prefs = sanitizeWorkStylePatch({ zcf_role }, getSettings())
  const updated = store.updateWorkStyle(req.params.id, prefs)
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
  disposeChatSession(req.params.id, 'work_deleted')
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
  enabled: z.boolean().optional().default(true),
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

  let endpoint: string
  try {
    endpoint = resolveAnthropicEndpoint(settings)
  } catch (e) {
    res.status(400).json({ detail: e instanceof Error ? e.message : String(e) })
    return
  }
  const effectiveProviderId = settings.active_provider === 'custom'
    ? findProviderByWeWorkerBaseUrl(settings.base_url)?.id || settings.active_provider
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
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...buildAnthropicAuthHeaders(settings.api_key, effectiveProviderId, settings.active_auth_type ?? settings.custom_auth_type),
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
    // The next turn must start from the compacted history, not the live session's full context.
    if (result.status === 'completed') disposeIdleChatSession(workId, 'manual_compaction')
    res.json({ ok: true, ...result, events })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    chatLog.error('conversation compaction route failed', { workId, detail })
    res.status(500).json({ ok: false, detail })
    return
  }
})


// ── Chat pre-start: start the Claude Code CLI while the user is typing ─────────
// Options must match the /works/:id/chat call below so the first turn's
// configuration fingerprint equals the warm session's (see chat-session.ts).
const chatWarmupsInFlight = new Set<string>()
const SPARE_WARMUP_KEY = '\u0000spare'
type ThinkingEffortInput = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined

async function prewarmChatSession(input: {
  key: string
  workId: string | null
  zcf: { zcf_role?: string | null }
  messages: store.Message[]
  thinkingEffort: ThinkingEffortInput
  dedicatedAgentOptions?: ReturnType<typeof buildDesktopAgentTurnOptions>
}): Promise<void> {
  if (chatWarmupsInFlight.has(input.key)) return
  chatWarmupsInFlight.add(input.key)
  try {
    const settings = getSettings()
    const styleId = resolveStyleId(input.zcf, settings)
    for await (const event of streamChat(input.messages, settings, undefined, {
      ...(input.workId ? { workId: input.workId } : {}),
      styleId,
      thinkingEffort: resolveThinkingEffort(settings.active_provider, settings.model, input.thinkingEffort),
      reuseSession: true,
      warmupOnly: true,
      ...(input.dedicatedAgentOptions ?? {}),
    })) {
      if (event.type === 'error') chatLog.warn('chat warm-up skipped', event.content)
    }
  } catch (error) {
    chatLog.warn('chat warm-up failed', error instanceof Error ? error.message : String(error))
  } finally {
    chatWarmupsInFlight.delete(input.key)
  }
}

// Existing work (including dedicated-agent conversations): warm its own session.
app.post('/works/:id/warmup', (req, res) => {
  const workId = req.params.id
  const { thinkingEffort } = (req.body ?? {}) as { thinkingEffort?: ThinkingEffortInput }
  const work = store.getWorkWithMessages(workId)
  if (!work) {
    res.status(404).json({ detail: 'Work not found' })
    return
  }
  if (hasChatSession(workId) || chatWarmupsInFlight.has(workId)) {
    res.json({ status: 'ready' })
    return
  }
  let dedicatedAgentOptions: ReturnType<typeof buildDesktopAgentTurnOptions> | undefined
  const dedicatedAgent = findAgentByWorkId(workId)
  if (dedicatedAgent) {
    try {
      dedicatedAgentOptions = buildDesktopAgentTurnOptions(dedicatedAgent)
    } catch {
      res.json({ status: 'skipped' })
      return
    }
  }
  res.json({ status: 'starting' })
  void prewarmChatSession({ key: workId, workId, zcf: work, messages: work.messages, thinkingEffort, dedicatedAgentOptions })
})

// Welcome screen: no work exists until the first send; keep one spare session.
app.post('/chat/warmup', (req, res) => {
  const { thinkingEffort, zcfRole } = (req.body ?? {}) as {
    thinkingEffort?: ThinkingEffortInput
    zcfRole?: string | null
  }
  if (hasSpareChatSession() || chatWarmupsInFlight.has(SPARE_WARMUP_KEY)) {
    res.json({ status: 'ready' })
    return
  }
  res.json({ status: 'starting' })
  void prewarmChatSession({
    key: SPARE_WARMUP_KEY,
    workId: null,
    zcf: { zcf_role: zcfRole ?? null },
    messages: [],
    thinkingEffort,
  })
})

const chatTurns = createChatTurnRegistry()
const chatSteeringListeners = new Map<string, {
  checkpoint: () => store.Message | undefined
  notify: (message: store.Message, requestId?: string, previousAssistant?: store.Message) => void
}>()
app.post('/works/:id/chat/steer', (req, res) => {
  const { message, attachments, requestId } = req.body ?? {}
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length > 100)) {
    res.status(400).json({ detail: 'invalid requestId' })
    return
  }
  if ((typeof message !== 'string' || !message.trim()) && (!Array.isArray(attachments) || !attachments.length)) {
    res.status(400).json({ detail: 'message or attachments required' })
    return
  }
  const session = getSteerableChatSession(req.params.id)
  const listener = chatSteeringListeners.get(req.params.id)
  if (!session || !listener || !store.getWork(req.params.id)) {
    res.status(409).json({ code: 'steering_unavailable', detail: '当前回复暂不支持接收补充指令，消息保留在队列中' })
    return
  }
  let files: store.ContentBlock[]
  try { files = Array.isArray(attachments) ? importChatAttachments(attachments) : [] }
  catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : 'failed to import attachments' }); return }
  // Synchronous checkpoint + user append: no stream event can cross this boundary.
  const previousAssistant = listener.checkpoint()
  const saved = store.appendMessage(req.params.id, 'user', [
    ...files, ...(typeof message === 'string' && message.trim() ? [{ type: 'text' as const, text: message }] : []),
  ])
  session.steer({ type: 'user', uuid: channelQrId(), session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: messagePromptText(saved) },
  }, { id: saved.id, role: saved.role, digest: createHash('sha256').update(JSON.stringify(saved.content)).digest('hex') },
  previousAssistant ? { id: previousAssistant.id, role: previousAssistant.role, digest: createHash('sha256').update(JSON.stringify(previousAssistant.content)).digest('hex') } : undefined)
  listener.notify(saved, requestId, previousAssistant)
  res.json({ status: 'accepted', message: saved, previousAssistant })
})

app.post('/works/:id/chat/stop', async (req, res) => {
  const status = await chatTurns.stop(req.params.id)
  res.status(status === 'timeout' ? 409 : 200).json({
    status,
    ...(status === 'timeout' ? { detail: '当前回复尚未停止，请稍后重试；排队消息已保留' } : {}),
  })
})

app.post('/works/:id/chat', async (req, res) => {
  const turn = chatTurns.start(req.params.id)
  if (!turn) {
    res.status(409).json({ detail: '当前对话仍在处理上一条消息，请稍后重试' })
    return
  }
  const onDisconnect = () => { if (!res.writableEnded) turn.controller.abort() }
  res.on('close', onDisconnect)
  try {
    await handleChatRequest(req, res, turn.controller)
  } finally {
    chatSteeringListeners.delete(req.params.id)
    res.off('close', onDisconnect)
    turn.finish()
  }
})

async function handleChatRequest(req: express.Request<{ id: string }>, res: express.Response, abortController: AbortController) {
  const workId = req.params.id
  const { message, modelMessage, attachments, retryCompaction, thinkingEffort } = req.body as {
    message: string;
    modelMessage?: string;
    attachments?: Array<{ path?: string; name?: string }>;
    retryCompaction?: boolean;
    thinkingEffort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  // Conversations owned by a dedicated agent run as that agent (its skills and tool limits).
  const dedicatedAgent = findAgentByWorkId(workId)
  let dedicatedAgentOptions: ReturnType<typeof buildDesktopAgentTurnOptions> | undefined
  if (dedicatedAgent) {
    try {
      dedicatedAgentOptions = buildDesktopAgentTurnOptions(dedicatedAgent)
    } catch (e) {
      res.status(500).json({ detail: `专属 Agent 运行环境准备失败：${e instanceof Error ? e.message : String(e)}` })
      return
    }
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
    const title = generateTitle(titleSource)
    store.updateTitle(workId, title)
    broadcastSSE({ type: 'title_update', title, workId })
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
  const styleId = resolveStyleId(work, settings)

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

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
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  let steeringSession: ReturnType<typeof getSteerableChatSession>
  const segments = createAssistantSegments(workId, assistantContent, message => {
    steeringSession?.refreshSteeredAssistant({
      id: message.id, role: message.role, digest: createHash('sha256').update(JSON.stringify(message.content)).digest('hex'),
    })
  })
  const flushText = () => {
    if (!currentText) return
    assistantContent.push({ type: 'text', text: currentText })
    currentText = ''
  }
  chatSteeringListeners.set(workId, {
    checkpoint: () => {
      steeringSession = getSteerableChatSession(workId)
      flushText()
      return segments.checkpoint()
    },
    notify: (message, requestId, previousAssistant) => send({ type: 'steering_message_saved', message, requestId, previousAssistant }),
  })

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
        broadcastSSE({ type: 'title_update', title: llmTitle, workId })
        broadcastSSE({ type: 'works_changed', workId })
      }
    })
  }

  const chatStartTime = Date.now()
  const turnId = Math.random().toString(36).slice(2, 8)
  let stepIndex = 0
  let lastToolName = ''
  // Per-turn timing accumulators. `llmMs` (all LLM generation segments) and
  // `execMs` (tool execution) are disjoint by construction, so
  // llmMs + execMs === totalMs — including tools that never emit a
  // `tool_call_result` event (see turn-timing.ts).
  const turnTiming = createTurnTimingLedger({ startedAt: chatStartTime })
  /** 回合结束时的冻结快照（turn_end 与持久化 timing 共用同一口径）。 */
  let turnTimingResult: ReturnType<typeof turnTiming.finish> | null = null

  const tag = `[${workId}][${turnId}]`

  // Optional product profiles may answer a query before the normal LLM route.
  // The public profile has no registered route and always falls through.
  // Dedicated agents skip profile routes: those may answer with other websites.
  if (!dedicatedAgent && await tryBackendProfileQueryRoute({ message, workId, turnId, chatStartTime, send, log: (m: string) => chatLog.info(`${tag} ${m}`), llmRouteSettings: getSettings() })) {
    finished = true
    res.off('close', onClose)
    broadcastSSE({ type: 'works_changed', workId })
    res.end()
    return
  }

  // Deterministic routing layers (weworker/router-config, see
  // docs/intelligent_routing_design.md). Every layer answers "not mine" when
  // unsure and `tryIntelligentQueryRoute` returns false, so a message that no
  // layer claims continues into the normal LLM pipeline below — exactly the
  // pre-routing behaviour. `WEWORKER_API_QUERY_ROUTE=0` turns the whole layer
  // off. Skipped on retry-with-compaction, which must re-run the turn through
  // the model rather than replay the same routed answer.
  if (retryCompaction !== true && message?.trim()) {
    const routed = await tryIntelligentQueryRoute({
      message,
      workId,
      turnId,
      chatStartTime,
      send,
      log: (m: string) => chatLog.info(`${tag} ${m}`),
      // Messages *before* the current turn: the follow-up gate needs them to
      // tell "那第二个呢" apart from a fresh query.
      history: workWithMessages.messages.filter((msg) => msg.id !== savedUserMessage?.id),
    })
    if (routed) {
      finished = true
      res.off('close', onClose)
      broadcastSSE({ type: 'works_changed', workId })
      res.end()
      return
    }
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
    // siteGate（第3层聚焦，第14行）：确定性快路未命中后，按保守站点信号预注入该 adapter 工具清单，
    // 省「激活 Skill」一整轮推理；未命中维持现状（漏判免费）。已毕业 toolkit skill 并入候选：
    // 已毕业站点同样回第3层并预注入 toolkit 工具清单，不再被第4层重复探索。
    const toolkitSkills = listToolkitSkills()
    const toolkitById = new Map(toolkitSkills.map((skill) => [skill.id, skill]))
    const siteGate = matchSiteAdapter(
      message,
      [...allAdapters.values(), ...toolkitGateCandidates(toolkitSkills)],
      // toolkit skill 不在站点设置里，恒视为启用；不动 enabledAdapterIds 本体。
      new Set([...enabledAdapterIds, ...toolkitById.keys()]),
    )
    const toolkitHit = siteGate.adapterId ? toolkitById.get(siteGate.adapterId) : undefined
    const siteToolkit = siteGate.adapterId && !fs.existsSync(path.join(SKILLS_DIR, `webcli-${siteGate.adapterId}`, 'SKILL.md.disabled'))
      ? (toolkitHit ? resolveToolkitSkillPrompt(toolkitHit) : resolveSiteToolkitPrompt(siteGate.adapterId))
      : null
    if (siteGate.reason !== 'miss') {
      chatLog.info(
        `${tag} sitegate: ${siteGate.reason}` +
          (siteGate.adapterId ? ` adapter=${siteGate.adapterId}` : '') +
          (siteGate.signals.length ? ` signals=${siteGate.signals.join(',')}` : '') +
          (siteToolkit ? ` tools=${siteToolkit.toolCount}/${siteToolkit.total}` : ''),
      )
    }
    // 第4层即时执行（第15行）：siteGate miss + 消息含未注册站点 URL 信号 + 网站探索agent健康 +
    // 建任务成功 → 该轮转交网站探索agent，事件源换成第4层流；任一条件不过 → 第3层 streamChat
    // （今天的行为，漏判免费）。急停 WEWORKER_TIER4=0 时 decideTier4 直接返回不转发。
    let tier4Task: { taskId: string; startUrl: string; startedAt: number } | null = null
    let tier4Source: AsyncGenerator<SSEEvent> | null = null
    const tier4 = decideTier4(message, siteGate, allAdapters)
    if (tier4.dispatch) {
      const health = await checkWebwrightHealth()
      if (!health.ok) {
        chatLog.info(`${tag} tier4: unavailable reason=health(${health.reason || 'down'})`)
      } else {
        const opened = await openTier4Turn({ message, startUrl: tier4.startUrl!, abortSignal: abortController.signal })
        if (opened.ok) {
          tier4Task = { taskId: opened.taskId, startUrl: tier4.startUrl!, startedAt: Date.now() }
          tier4Source = opened.run
          chatLog.info(`${tag} tier4: task=${opened.taskId} url=${tier4.startUrl}`)
        } else {
          chatLog.info(`${tag} tier4: unavailable reason=create-${opened.code}${opened.message ? ` (${opened.message})` : ''}`)
        }
      }
    } else if (siteGate.reason === 'miss') {
      // miss 时 siteGate 无日志行，这里补观测：为什么没走第4层。
      chatLog.info(`${tag} tier4: skip reason=${tier4.reason}`)
    }
    for await (const ev of tier4Source ?? streamChat(modelMessages, settings, abortController, {
      enabledAdapterIds,
      workId,
      styleId,
      thinkingEffort: resolveThinkingEffort(settings.active_provider, settings.model, thinkingEffort),
      memoryScope: initialMemoryScope,
      ...(siteToolkit ? { siteToolkitPrompt: siteToolkit.prompt } : {}),
      onAskUser: (event) => send(event),
      // send_image_to_user / send_file_to_user show their media in this desktop conversation.
      userMedia: createDesktopUserMedia({
        append: (block) => {
          if (currentText) {
            assistantContent.push({ type: 'text', text: currentText })
            currentText = ''
          }
          assistantContent.push(block)
        },
        send,
      }),
      // Keep this work's Claude Code process between turns (skips the CLI cold start).
      reuseSession: true,
      ...(dedicatedAgentOptions ?? {}),
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
          thinkMs = turnTiming.toolStarted(ev.id)
        }
        // Resolve SDK tool name back to original adapter name
        const cleanName = resolveToolDisplayName(ev.name ?? '')
        lastToolName = cleanName
        if (!isUpdate) {
          chatLog.info(`${tag} 🔧 step ${stepIndex}: ${cleanName} (think=${(thinkMs! / 1000).toFixed(2)}s)`)
        }
        // Send cleaned name + LLM think time to frontend via SSE
        send({ ...ev, name: cleanName, ...(thinkMs !== undefined ? { thinkMs } : {}) })
        flushText()
        // If this tool id already exists (args update from full assistant message), merge instead of duplicating
        const existingIdx = assistantContent.findIndex(b => b.type === 'tool_use' && (b as { id: string }).id === ev.id)
        if (existingIdx >= 0) {
          assistantContent[existingIdx] = {
            ...(assistantContent[existingIdx] as object),
            args: ev.args ?? (assistantContent[existingIdx] as { args?: unknown }).args,
            name: cleanName || (assistantContent[existingIdx] as { name?: string }).name,
          } as store.ContentBlock
          segments.refresh(existingIdx)
        } else {
          toolCallMap.set(ev.id, { name: cleanName, args: ev.args })
          assistantContent.push({ type: 'tool_use', id: ev.id, name: cleanName, args: ev.args, status: 'running', ...(thinkMs !== undefined ? { thinkMs } : {}) })
        }
      } else if (ev.type === 'tool_call_result' && ev.id) {
        const toolDuration = turnTiming.toolSettled(ev.id) ?? 0
        chatLog.info(`${tag} ✅ step ${stepIndex}: ${lastToolName} done (exec=${(toolDuration / 1000).toFixed(2)}s)`)
        send({ ...ev, execMs: toolDuration })
        const idx = assistantContent.findIndex(b => b.type === 'tool_use' && (b as { id: string }).id === ev.id)
        if (idx >= 0) {
          assistantContent[idx] = { ...(assistantContent[idx] as object), result: ev.result, status: ev.isError ? 'failed' : 'done', execMs: toolDuration } as store.ContentBlock
          segments.refresh(idx)
        } else {
          assistantContent.push({ type: 'tool_use', id: ev.id, name: '', args: {}, result: ev.result, status: ev.isError ? 'failed' : 'done', execMs: toolDuration })
        }
      } else if (ev.type === 'tool_call_image' && ev.id) {
        // 只回图片的工具（例如读图片的 Read）没有 tool_call_result 事件：
        // 按同一口径在这里结算它的执行时间，避免这段时间被算进 llmMs。
        const imageToolDuration = turnTiming.toolObserved(ev.id)
        send(ev)
        const idx = assistantContent.findIndex(b => b.type === 'tool_use' && (b as { id: string }).id === ev.id)
        if (idx >= 0) {
          const currentStatus = (assistantContent[idx] as Extract<store.ContentBlock, { type: 'tool_use' }>).status
          assistantContent[idx] = {
            ...(assistantContent[idx] as object),
            image: ev.data,
            status: currentStatus === 'failed' ? 'failed' : 'done',
            ...(imageToolDuration !== undefined ? { execMs: imageToolDuration } : {}),
          } as store.ContentBlock
          segments.refresh(idx)
        } else {
          assistantContent.push({ type: 'tool_use', id: ev.id, name: 'capture_screenshot', args: {}, image: ev.data, status: 'done', ...(imageToolDuration !== undefined ? { execMs: imageToolDuration } : {}) })
        }
      } else {
        if (ev.type === 'error') streamFailed = true
        send(ev)
      }
    }
    // 第4层回合收尾（第16行）：只观测 + 毕业提示，不改写本轮结果。
    if (tier4Task) {
      const tier4View = await fetchWebwrightTask(tier4Task.taskId)
      chatLog.info(
        `${tag} tier4: done task=${tier4Task.taskId} status=${tier4View?.status ?? 'unknown'}` +
          ` steps=${tier4View?.current_step ?? 0} ms=${Date.now() - tier4Task.startedAt}` +
          ` final_chars=${(tier4View?.final_response ?? '').length}`,
      )
      // 毕业引导：同 host 第 N 次成功探索后提示可固化为本地 Toolkit（只提示，不自动生成）。
      if (tier4View?.status === 'succeeded') {
        try {
          const host = new URL(tier4Task.startUrl).hostname.toLowerCase()
          const count = recordTier4HostUsage(host)
          if (shouldSuggestGraduation(count)) {
            const hint = graduationHint(host, count)
            send({ type: 'text_delta', content: hint })
            currentText += hint
            chatLog.info(`${tag} tier4: graduation host=${host} count=${count}`)
          }
        } catch {
          // 计数落盘失败不影响本轮结果——毕业提示只是锦上添花。
        }
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
    // Close the turn: trailing LLM text generation is whatever is left after
    // every tool interval; tools without a result event are settled here so
    // their time is never charged to llmMs.
    turnTimingResult = turnTiming.finish()
    // Mark as finished so that the subsequent res.end() → close event
    // does not trigger abort on the already-completed query.
    chatLog.info(
      `${tag} ◼ turn end — total=${(turnTimingResult.totalMs / 1000).toFixed(2)}s` +
        `, llm=${(turnTimingResult.llmMs / 1000).toFixed(2)}s` +
        `, exec=${(turnTimingResult.execMs / 1000).toFixed(2)}s, steps=${stepIndex}`,
    )
    send({ type: 'turn_end', turnId, workId, totalMs: turnTimingResult.totalMs, llmMs: turnTimingResult.llmMs, execMs: turnTimingResult.execMs, steps: stepIndex })
    finished = true
    res.off('close', onClose)
  }

  // Finalize text
  flushText()
  // Stop/error must also settle tools in segments saved before a steering message.
  for (let index = 0; index < assistantContent.length; index++) {
    const block = assistantContent[index]
    if (!turnSucceeded && block.type === 'tool_use' && block.status === 'running') {
      assistantContent[index] = { ...block, status: 'cancelled' }
      segments.refresh(index)
    }
  }

  // Persist assistant message
  if (assistantContent.length > 0) {
    const timing = turnTimingResult ?? turnTiming.finish()
    assistantContent.push({ type: 'timing', totalMs: timing.totalMs, llmMs: timing.llmMs, execMs: timing.execMs, steps: stepIndex })
    segments.checkpoint()
  }

  // Dedicated agent turns run with long-term memory off: nothing to plan or report.
  if (dedicatedAgent) {
    store.markExternalWrite()
    broadcastSSE({ type: 'works_changed', workId })
    res.end()
    return
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
  // 准入被拒时也必须给出状态：否则模型会照旧对用户宣称「已写入」，而界面什么都不显示。
  const memoryAdmitReasons: string[] = []
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
    if (planned.events.length === 0 && planned.admitReason) memoryAdmitReasons.push(planned.admitReason)
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
          if (memoryResult.status === 'saved') {
            enforceMemoryBudgetAfterWrite(memoryStore, event.expectedMemoryType, tag)
          }
        }).catch(() => {
          broadcastSSE({ type: 'memory_status', workId, eventId: event.eventId, status: 'failed' })
        })
      }
    })
    return
  }

  // 候选被准入层拒绝时也要如实告知：模型已经回答过用户，界面若不显示状态，
  // 用户会以为记忆已保存（"写入了却查不到"的真实成因）。
  if (memoryCandidates.length > 0
    && plannedMemoryEvents.length === 0
    && memoryAdmitReasons.some((reason) => reason !== 'ignore')) {
    const rejectionText: Record<string, string> = {
      execution_evidence_insufficient: '本轮没有实际执行动作，不构成任务记忆',
      task_assessment_insufficient: '任务结果信息不完整',
      declarative_invalid: '缺少可核验的执行证据',
      unknown_site: '目标站点不在当前支持范围内',
      disabled_site: '目标站点的 Adapter 已停用',
      missing_site: '缺少站点信息',
      turn_failed: '本轮未成功完成',
      no_candidate: '内容不满足长期记忆的保存条件',
    }
    const reason = memoryAdmitReasons.find((item) => item !== 'ignore') || 'no_candidate'
    const error = `${rejectionText[reason] || '内容不满足长期记忆的保存条件'}，本次未写入长期记忆`
    const rejectionEventId = `${savedUserMessage.id}:admission-rejected`
    send({ type: 'memory_status', status: 'failed', workId, eventId: rejectionEventId, error })
    broadcastSSE({ type: 'memory_status', status: 'failed', workId, eventId: rejectionEventId, error })
  }

  chatLog.info(` sending res.end() for workId=${workId}`)
  broadcastSSE({ type: 'works_changed', workId })
  res.end()
}

// ── Long-term memory management (Renderer) ─────────────────────────────────

/** /memory/records 单次返回上限。 */
const MEMORY_RECORDS_LIMIT = 200
const MEMORY_TYPE_FILTERS: MemoryBudgetKey[] = ['user_usage', 'task_execution', 'other', 'extension']

function buildMemorySettingsResponse(): {
  budgets: MemoryBudgets
  defaults: MemoryBudgets
  usage: Record<MemoryBudgetKey, MemoryBudgetUsage>
} {
  return {
    budgets: normalizeMemoryBudgets(getSettings().memory_budgets),
    defaults: { ...DEFAULT_MEMORY_BUDGETS },
    usage: summarizeMemoryBudgetUsage(getMemoryStore()),
  }
}

/**
 * 记忆写入成功后的容量执行：① 融合近重复 → ② 按价值淘汰，全部用 supersede 保留审计。
 * 任何异常都被吞掉并记日志，绝不能让记忆写入或聊天响应失败；
 * 日志只记录数量与用量，不记录记忆正文。
 */
function enforceMemoryBudgetAfterWrite(
  memoryStore: MemoryStore,
  memoryType: string | undefined,
  tag: string,
): void {
  enforceConfiguredMemoryBudget(memoryStore, memoryType, getSettings().memory_budgets, (payload) => {
    chatLog.info(`${tag} memory_budget_enforced`, payload)
  })
}

app.get('/memory/settings', (_req, res) => {
  try {
    res.json(buildMemorySettingsResponse())
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.post('/memory/settings', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null
  const raw = body?.memory_budgets
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    res.status(400).json({ detail: 'memory_budgets must be an object' })
    return
  }
  try {
    updateSettings({ memory_budgets: normalizeMemoryBudgets(raw) })
    res.json(buildMemorySettingsResponse())
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/memory/records', (req, res) => {
  const requested = typeof req.query.type === 'string' ? req.query.type.trim() : ''
  if (requested && !MEMORY_TYPE_FILTERS.includes(requested as MemoryBudgetKey)) {
    res.status(400).json({ detail: 'unsupported memory type' })
    return
  }
  const filter = (requested || undefined) as MemoryBudgetKey | undefined
  try {
    const records = getMemoryStore().listActiveAll()
      .filter((memory) => !filter || resolveMemoryBudgetKey(memory.type) === filter)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MEMORY_RECORDS_LIMIT)
      // 只返回公开字段：绝不暴露 facts 或任何内部字段。
      .map((memory) => ({
        id: memory.id,
        type: memory.type,
        key: memory.key,
        content: memory.content,
        confidence: memory.confidence,
        status: memory.status,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      }))
    res.json({ records })
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : String(error) })
  }
})

app.delete('/memory/records/:id', (req, res) => {
  const id = String(req.params.id || '').trim()
  try {
    const memoryStore = getMemoryStore()
    if (!id || !memoryStore.get(id)) {
      res.status(404).json({ detail: 'memory not found' })
      return
    }
    memoryStore.setStatus(id, 'superseded')
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ detail: error instanceof Error ? error.message : String(error) })
  }
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

  if (s0.channels.feishu.enabled && s0.channels.feishu.app_id && s0.channels.feishu.app_secret) {
    const feishuChannel = new FeishuChannel({
      enabled: true,
      app_id: s0.channels.feishu.app_id,
      app_secret: s0.channels.feishu.app_secret,
    })
    channelManager.register('feishu', feishuChannel)
    feishuChannel.start().catch(e => channelLog.error('start error:', e))
  }

  await startAllDedicatedAgents()
}

async function bootstrap(): Promise<void> {
  await initSettings()
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
