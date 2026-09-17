import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from './logger.js'
import { getSiteMemory, type SiteMemoryRecord, type SiteApiCandidate } from './site-memory.js'

const log = createLogger('adapter-scaffold')

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(MODULE_DIR, '../../..')
const DEFAULT_ADAPTER_ROOT = path.join(REPO_ROOT, 'extension', 'adapters')
const GENERATED_SUBDIR = 'webcli-generated'

export interface GenerateAdapterScaffoldOptions {
  outputRoot?: string
  updateManifest?: boolean
}

export interface GeneratedAdapterScaffold {
  siteKey: string
  adapterDir: string
  generatedDir: string
  mode: 'augment_existing_adapter' | 'bootstrap_adapter_draft'
  generationStrategy: 'list_only' | 'action_only' | 'hybrid'
  files: {
    manifest: string
    adapterIndex: string
    sharedRuntime: string
    supportFile: string
    indexSnippet: string
    integrationGuide: string
    discoveryIndex: string
    discoveryRegistry: string
  }
  toolNames: string[]
  primaryListApiUrl: string
  secondaryApiUrl: string
  actionApiUrls: string[]
  manifestUpdated: boolean
  indexCatalogUpdated: boolean
  registryCatalogUpdated: boolean
  supportFiles: string[]
  indexSnippet: string
}

interface SelectedApis {
  primary: SiteApiCandidate | null
  secondary: SiteApiCandidate | null
}

type SelectedActionCandidate = SiteMemoryRecord['actionApiCandidates'][number]
type CandidateTransport = 'get_query' | 'post_form' | 'post_json'

interface ExistingAdapterState {
  exists: boolean
  manifestExists: boolean
  indexExists: boolean
}

interface AdapterManifestShape {
  id?: string
  name?: string
  description?: string
  match?: string[]
  homepage_url?: string
  requires_auth?: boolean
  auth_check_tool?: string
  version?: string
  author?: string
  scenarios?: Array<{ id?: string; title: string; summary: string; prompts?: Array<{ text: string }> }>
  support_files?: string[]
  generated_from?: Record<string, unknown>
  [key: string]: unknown
}

interface AdapterRegistryEntry {
  id: string
  name?: string
  description?: string
  author?: string
  match?: string[]
  homepage_url?: string
  requires_auth?: boolean
  auth_check_tool?: string
  version?: string
  verified_on?: string
  scenarios?: Array<{ id?: string; title: string; summary: string; prompts?: Array<{ text: string }> }>
  i18n?: Record<string, unknown>
  [key: string]: unknown
}

interface AdapterRegistryShape {
  version: number
  updated_at: string
  adapters: AdapterRegistryEntry[]
}

interface ListSupportBlock {
  toolName: string
  functionSource: string
  toolDefinition: string
}

interface ActionSupportBlock {
  functionSource: string
  toolDefinition: string
  handlerName?: string
  normalizedToolName?: string
  normalizedHandlerName?: string
  candidate?: SelectedActionCandidate
}

interface CandidateDefaults {
  defaults: Record<string, unknown>
  transport: CandidateTransport
}

interface SemanticReadSupportBlock {
  functionSource: string
  toolDefinitions: string[]
  toolNames: string[]
}

interface ActionPlanSupportBlock {
  functionSource: string
  toolDefinitions: string[]
  toolNames: string[]
}

interface GeneratedSupportModuleFile {
  relPath: string
  absPath: string
  content: string
}

export function generateAdapterScaffold(siteOrUrl: string, options: GenerateAdapterScaffoldOptions = {}): GeneratedAdapterScaffold {
  const memory = getSiteMemory(siteOrUrl)
  if (!memory) {
    throw new Error(`site memory not found for ${siteOrUrl}`)
  }
  return writeScaffoldFromSiteMemory(memory, options)
}

export function writeScaffoldFromSiteMemory(memory: SiteMemoryRecord, options: GenerateAdapterScaffoldOptions = {}): GeneratedAdapterScaffold {
  const adapterRoot = options.outputRoot ?? DEFAULT_ADAPTER_ROOT
  const adapterDir = path.join(adapterRoot, memory.siteKey)
  const generatedDir = path.join(adapterDir, GENERATED_SUBDIR)
  const safeSiteToken = toSafeFileToken(memory.siteKey)
  const sharedRuntimeRel = `${GENERATED_SUBDIR}/shared/${safeSiteToken}.runtime.generated.js`
  const supportFileRel = `${GENERATED_SUBDIR}/${safeSiteToken}.site-memory.generated.js`
  const indexSnippetRel = `${GENERATED_SUBDIR}/${safeSiteToken}.index-snippet.generated.txt`
  const guideRel = `${GENERATED_SUBDIR}/${safeSiteToken}.integration.generated.md`
  const sharedRuntimePath = path.join(adapterDir, sharedRuntimeRel)
  const supportFilePath = path.join(adapterDir, supportFileRel)
  const indexSnippetPath = path.join(adapterDir, indexSnippetRel)
  const integrationGuidePath = path.join(adapterDir, guideRel)
  const manifestPath = path.join(adapterDir, 'manifest.json')
  const indexPath = path.join(adapterDir, 'index.js')
  const discoveryIndexPath = path.join(adapterRoot, 'index.json')
  const discoveryRegistryPath = path.join(adapterRoot, 'registry.json')
  const updateManifest = options.updateManifest ?? true

  const existing = detectExistingAdapterState(adapterDir, manifestPath, indexPath)
  const mode: GeneratedAdapterScaffold['mode'] = existing.indexExists || existing.manifestExists
    ? 'augment_existing_adapter'
    : 'bootstrap_adapter_draft'

  fs.mkdirSync(generatedDir, { recursive: true })

  // OpenCLI-aligned quick scaffold is read-only. Writes require the Generation
  // Harness agent to author semantic payload construction and focused mocks.
  const actionCandidates = selectActionCandidates(memory)
    .filter((candidate) => (candidate.method || 'GET').toUpperCase() === 'GET')
  const { primary, secondary } = selectApis(memory, actionCandidates)
  if (!primary && actionCandidates.length === 0) {
    throw new Error(`no reusable list or action api candidates available for ${memory.siteKey}`)
  }

  const generationStrategy: GeneratedAdapterScaffold['generationStrategy'] = primary
    ? (actionCandidates.length > 0 ? 'hybrid' : 'list_only')
    : 'action_only'
  const includeDetailHints = hasUsefulDetailHints(memory)
  const normalizedActionToolNames = collectNormalizedActionToolNames(memory.siteKey, actionCandidates)
  const semanticToolNames = collectSemanticReadToolNames(memory.siteKey, actionCandidates)
  const actionPlanToolNames = collectActionPlanToolNames(memory.siteKey, actionCandidates)
  const toolNames = buildGeneratedToolNames(memory.siteKey, {
    hasPrimary: Boolean(primary),
    hasSecondary: Boolean(primary && secondary),
    includeDetailHints,
    actionCandidates,
    normalizedActionToolNames,
    semanticToolNames,
    actionPlanToolNames,
  })
  const supportBundle = {
    sharedRuntime: '',
    moduleFiles: [] as GeneratedSupportModuleFile[],
    entryFile: buildSupportFile(memory, {
      primary,
      secondary,
      includeDetailHints,
      actionCandidates,
    }),
    supportFiles: [sharedRuntimeRel, supportFileRel],
  }
  const indexSnippet = buildIndexSnippet(memory.siteKey)
  const integrationGuide = buildIntegrationGuide(memory, {
    supportFileRel,
    indexSnippetRel,
    manifestPath,
    indexPath,
    toolNames,
    primary,
    secondary,
    actionCandidates,
    mode,
    generationStrategy,
  })

  fs.mkdirSync(path.dirname(sharedRuntimePath), { recursive: true })
  fs.writeFileSync(sharedRuntimePath, `${supportBundle.sharedRuntime}\n`, 'utf8')
  for (const moduleFile of supportBundle.moduleFiles) {
    fs.mkdirSync(path.dirname(moduleFile.absPath), { recursive: true })
    fs.writeFileSync(moduleFile.absPath, `${moduleFile.content}\n`, 'utf8')
  }
  fs.writeFileSync(supportFilePath, `${supportBundle.entryFile}\n`, 'utf8')
  fs.writeFileSync(indexSnippetPath, `${indexSnippet}\n`, 'utf8')
  fs.writeFileSync(integrationGuidePath, `${integrationGuide}\n`, 'utf8')

  const manifestUpdated = ensureAdapterManifest(memory, manifestPath, supportBundle.supportFiles, updateManifest)
  ensureAdapterIndexShell(memory, indexPath, existing.indexExists)
  const resolvedManifest = readManifestOrDefault(memory, manifestPath)
  const indexCatalogUpdated = ensureAdapterIndexCatalog(adapterRoot, memory.siteKey)
  const registryCatalogUpdated = ensureAdapterRegistryCatalog(memory, adapterRoot, resolvedManifest)

  log.info('adapter scaffold generated', {
    siteKey: memory.siteKey,
    adapterDir,
    mode,
    generationStrategy,
    supportFileRel,
    manifestUpdated,
    indexCatalogUpdated,
    registryCatalogUpdated,
  })

  return {
    siteKey: memory.siteKey,
    adapterDir,
    generatedDir,
    mode,
    generationStrategy,
    files: {
      manifest: manifestPath,
      adapterIndex: indexPath,
      sharedRuntime: sharedRuntimePath,
      supportFile: supportFilePath,
      indexSnippet: indexSnippetPath,
      integrationGuide: integrationGuidePath,
      discoveryIndex: discoveryIndexPath,
      discoveryRegistry: discoveryRegistryPath,
    },
    toolNames,
    primaryListApiUrl: primary?.url || '',
    secondaryApiUrl: secondary?.url || '',
    actionApiUrls: actionCandidates.map((candidate) => candidate.url),
    manifestUpdated,
    indexCatalogUpdated,
    registryCatalogUpdated,
    supportFiles: supportBundle.supportFiles,
    indexSnippet,
  }
}

function detectExistingAdapterState(adapterDir: string, manifestPath: string, indexPath: string): ExistingAdapterState {
  return {
    exists: fs.existsSync(adapterDir),
    manifestExists: fs.existsSync(manifestPath),
    indexExists: fs.existsSync(indexPath),
  }
}

function ensureAdapterManifest(memory: SiteMemoryRecord, manifestPath: string, supportFileRels: string[], shouldWrite: boolean): boolean {
  const manifest = readManifestOrDefault(memory, manifestPath)
  const currentSupportFiles = Array.isArray(manifest.support_files) ? manifest.support_files.filter((item): item is string => typeof item === 'string') : []
  const preservedSupportFiles = currentSupportFiles.filter((item) => !item.startsWith(`${GENERATED_SUBDIR}/`))
  const nextSupportFiles = Array.from(new Set([...preservedSupportFiles, ...supportFileRels]))
  const changed = !arraysEqual(currentSupportFiles, nextSupportFiles) || !fs.existsSync(manifestPath)

  manifest.support_files = nextSupportFiles

  if (changed && shouldWrite) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  return changed && shouldWrite
}

function readManifestOrDefault(memory: SiteMemoryRecord, manifestPath: string): AdapterManifestShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AdapterManifestShape
    if (parsed && typeof parsed === 'object') {
      return parsed
    }
  } catch {
    // noop
  }

  return {
    id: memory.siteKey,
    name: memory.siteHost,
    description: `Generated adapter shell for ${memory.siteHost}`,
    match: [memory.siteHost],
    homepage_url: memory.canonicalEntryUrl || memory.siteOrigin,
    requires_auth: true,
    auth_check_tool: undefined,
    version: memory.updatedAt,
    author: 'site-memory-scaffold',
    scenarios: buildScaffoldScenarios(memory),
    generated_from: {
      source: 'site_memory',
      workflow_version: memory.workflowVersion,
      generated_at: new Date().toISOString(),
      recommended_strategy: memory.recommendedStrategy,
    },
  }
}

function ensureAdapterIndexShell(memory: SiteMemoryRecord, indexPath: string, alreadyExists: boolean): void {
  if (alreadyExists) return

  const content = `/**
 * Generated adapter shell for ${memory.siteKey}
 *
 * This file was created because no adapter index.js existed yet.
 * Add site-specific tools here and keep the generated support tools mounted.
 */

window.__webmcpRegister({
  name: ${serializeJsValue(`generated-${memory.siteKey}-adapter`)},
  match: ${serializeJsValue([memory.siteHost])},
  tools: [
    ...(window.__webmcpGeneratedSupport?.[${serializeJsValue(memory.siteKey)}]?.tools || []),
  ],
})
`

  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.writeFileSync(indexPath, content, 'utf8')
}

function ensureAdapterIndexCatalog(adapterRoot: string, siteKey: string): boolean {
  const catalogPath = path.join(adapterRoot, 'index.json')
  const currentIds = readAdapterIndexCatalog(catalogPath)
  const nextIds = Array.from(new Set([...currentIds, siteKey])).sort((left, right) => left.localeCompare(right))
  if (arraysEqual(currentIds, nextIds) && fs.existsSync(catalogPath)) return false

  fs.mkdirSync(path.dirname(catalogPath), { recursive: true })
  fs.writeFileSync(catalogPath, `${JSON.stringify(nextIds, null, 2)}\n`, 'utf8')
  return true
}

function readAdapterIndexCatalog(catalogPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string')
    }
  } catch {
    // noop
  }
  return []
}

function ensureAdapterRegistryCatalog(
  memory: SiteMemoryRecord,
  adapterRoot: string,
  manifest: AdapterManifestShape,
): boolean {
  const registryPath = path.join(adapterRoot, 'registry.json')
  const registry = readAdapterRegistryOrDefault(registryPath)
  const desiredEntry = buildRegistryEntry(memory, manifest)
  const existingIndex = registry.adapters.findIndex((entry) => entry?.id === desiredEntry.id)

  let changed = false
  if (existingIndex >= 0) {
    const merged = mergeRegistryEntry(registry.adapters[existingIndex], desiredEntry)
    if (JSON.stringify(registry.adapters[existingIndex]) !== JSON.stringify(merged)) {
      registry.adapters[existingIndex] = merged
      changed = true
    }
  } else {
    registry.adapters.push(desiredEntry)
    changed = true
  }

  if (!fs.existsSync(registryPath)) {
    changed = true
  }

  if (!changed) return false

  registry.updated_at = new Date().toISOString()
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  return true
}

function readAdapterRegistryOrDefault(registryPath: string): AdapterRegistryShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as AdapterRegistryShape
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.adapters)) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        updated_at: safeString(parsed.updated_at) || new Date().toISOString(),
        adapters: parsed.adapters.filter((entry): entry is AdapterRegistryEntry => Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string')),
      }
    }
  } catch {
    // noop
  }

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    adapters: [],
  }
}

function buildRegistryEntry(memory: SiteMemoryRecord, manifest: AdapterManifestShape): AdapterRegistryEntry {
  const match = Array.isArray(manifest.match) && manifest.match.length > 0
    ? manifest.match.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [memory.siteHost]

  return {
    id: safeString(manifest.id) || memory.siteKey,
    name: safeString(manifest.name) || memory.siteKey,
    description: safeString(manifest.description) || `Generated adapter shell for ${memory.siteHost}`,
    author: safeString(manifest.author) || 'site-memory-scaffold',
    match,
    homepage_url: safeString(manifest.homepage_url) || memory.canonicalEntryUrl || memory.siteOrigin,
    requires_auth: typeof manifest.requires_auth === 'boolean' ? manifest.requires_auth : true,
    auth_check_tool: safeString(manifest.auth_check_tool) || undefined,
    version: safeString(manifest.version) || memory.updatedAt,
    verified_on: (safeString(memory.updatedAt) || new Date().toISOString()).slice(0, 10),
    scenarios: Array.isArray(manifest.scenarios) && manifest.scenarios.length > 0
      ? manifest.scenarios
      : buildScaffoldScenarios(memory),
  }
}

function mergeScenarios(
  current: AdapterRegistryEntry['scenarios'],
  desired: AdapterRegistryEntry['scenarios'],
): AdapterRegistryEntry['scenarios'] {
  const merged = new Map<string, NonNullable<AdapterRegistryEntry['scenarios']>[number]>()
  for (const scenario of [...(current ?? []), ...(desired ?? [])]) {
    if (!scenario?.title?.trim()) continue
    const key = safeString(scenario.id) || scenario.title.trim()
    if (!merged.has(key)) merged.set(key, scenario)
  }
  return [...merged.values()]
}

function mergeRegistryEntry(current: AdapterRegistryEntry, desired: AdapterRegistryEntry): AdapterRegistryEntry {
  const mergedMatch = Array.from(new Set([
    ...(Array.isArray(current.match) ? current.match.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []),
    ...(Array.isArray(desired.match) ? desired.match.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []),
  ]))

  return {
    ...current,
    id: desired.id,
    name: safeString(current.name) || desired.name,
    description: safeString(current.description) || desired.description,
    author: safeString(current.author) || desired.author,
    match: mergedMatch.length > 0 ? mergedMatch : desired.match,
    homepage_url: safeString(current.homepage_url) || desired.homepage_url,
    requires_auth: typeof current.requires_auth === 'boolean' ? current.requires_auth : desired.requires_auth,
    auth_check_tool: safeString(current.auth_check_tool) || desired.auth_check_tool,
    version: safeString(desired.version) || safeString(current.version) || undefined,
    verified_on: safeString(desired.verified_on) || safeString(current.verified_on) || undefined,
    scenarios: mergeScenarios(current.scenarios, desired.scenarios),
  }
}

function buildSupportFile(
  memory: SiteMemoryRecord,
  context: {
    primary: SiteApiCandidate | null
    secondary: SiteApiCandidate | null
    includeDetailHints: boolean
    actionCandidates: SelectedActionCandidate[]
  },
): string {
  const { primary, secondary, includeDetailHints, actionCandidates } = context
  const toolNames = buildGeneratedToolNames(memory.siteKey, {
    hasPrimary: Boolean(primary),
    hasSecondary: Boolean(primary && secondary),
    includeDetailHints,
    actionCandidates,
    normalizedActionToolNames: collectNormalizedActionToolNames(memory.siteKey, actionCandidates),
    semanticToolNames: collectSemanticReadToolNames(memory.siteKey, actionCandidates),
    actionPlanToolNames: collectActionPlanToolNames(memory.siteKey, actionCandidates),
  })
  const primaryBlock = primary
    ? buildListSupportBlock({
      candidate: primary,
      toolName: `${memory.siteKey}.search_records`,
      functionName: 'run_primary_list',
      description: `Generated primary list/search tool backed by ${primary.url}. This is the strongest reusable list API discovered from site memory.`,
    })
    : null
  const secondaryBlock = secondary
    ? buildListSupportBlock({
      candidate: secondary,
      toolName: `${memory.siteKey}.fetch_summary_groups`,
      functionName: 'run_secondary_list',
      description: `Generated secondary summary tool backed by ${secondary.url}. Useful for related list or grouping data discovered during exploration.`,
    })
    : null
  const actionBlocks = actionCandidates.map((candidate, index) => buildActionSupportBlock(memory.siteKey, candidate, index))
  const semanticReadCandidate = selectSemanticReadCandidate(actionCandidates)
  const actionHintRegistry = buildActionHintRegistry(memory.siteKey, actionCandidates, semanticReadCandidate)
  const semanticReadBlock = buildSemanticReadSupportBlock(memory.siteKey, actionBlocks)
  const actionPlanBlock = buildActionPlanSupportBlock(memory.siteKey, actionBlocks)

  const toolDefs: string[] = []
  toolDefs.push(`      {
        name: ${serializeJsValue(`${memory.siteKey}.check_login_status`)},
        description: ${serializeJsValue(`Generated login-status scaffold for ${memory.siteHost}. Verifies that the current page is not the company SSO page and that cookie-auth API calls are likely usable.`)},
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        handler: () => checkLoginStatus(),
      }`)

  if (primaryBlock) toolDefs.push(primaryBlock.toolDefinition)
  if (secondaryBlock) toolDefs.push(secondaryBlock.toolDefinition)
  for (const block of actionBlocks) {
    toolDefs.push(block.toolDefinition)
  }
  if (semanticReadBlock) {
    toolDefs.push(...semanticReadBlock.toolDefinitions)
  }
  if (actionPlanBlock) {
    toolDefs.push(...actionPlanBlock.toolDefinitions)
  }
  if (includeDetailHints) {
    toolDefs.push(`      {
        name: ${serializeJsValue(`${memory.siteKey}.list_detail_candidates`)},
        description: ${serializeJsValue('Returns detail URL hints captured during exploration without navigating the page.')},
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        handler: () => listDetailCandidates(),
      }`)
  }

  return `/**
 * Generated support tools for ${memory.siteKey}
 *
 * Source:
 * - workflow version: ${memory.workflowVersion}
${memory.recommendedStrategy ? ` * - recommended strategy: ${memory.recommendedStrategy}\n` : ''}${primary ? ` * - primary list API: ${primary.url}\n` : ''}${secondary ? ` * - secondary API: ${secondary.url}\n` : ''}${actionCandidates.map((candidate) => ` * - action API (${candidate.actionName}): ${candidate.url}\n`).join('')} *
 * This file is injected before adapter index.js through manifest.support_files.
 */

(function initGeneratedSupport() {
  const globalStore = window.__webmcpGeneratedSupport || (window.__webmcpGeneratedSupport = {});
  if (globalStore[${serializeJsValue(memory.siteKey)}]) return;

  function parseMaybeJson(text) {
    if (typeof text !== 'string') return text;
    const normalized = text.trim();
    if (!normalized) return normalized;
    try {
      return JSON.parse(normalized);
    } catch {
      return normalized;
    }
  }

  function hasOwnKey(value, key) {
    return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
  }

  function hasMeaningfulValue(value) {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  function sameStructuredValue(left, right) {
    if (left === right) return true;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function cloneStructuredValue(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      if (Array.isArray(value)) return [...value];
      if (isPlainObject(value)) return { ...value };
      return value;
    }
  }

  function normalizeValueAgainstDefault(value, defaultValue) {
    if (!hasMeaningfulValue(value)) return value;
    if (typeof value !== 'string') return value;

    const normalized = value.trim();
    if (!normalized) return value;

    if (typeof defaultValue === 'number' && /^-?\\d+(?:\\.\\d+)?$/.test(normalized)) {
      return Number(normalized);
    }
    if (typeof defaultValue === 'boolean' && /^(true|false)$/i.test(normalized)) {
      return normalized.toLowerCase() === 'true';
    }

    const suspiciousStructuredString = normalized === '[object Object]' || normalized === '[object Array]';
    const parsed = parseMaybeJson(value);

    if (Array.isArray(defaultValue)) {
      if (Array.isArray(parsed)) return parsed;
      if (suspiciousStructuredString) return cloneStructuredValue(defaultValue);
      return value;
    }

    if (isPlainObject(defaultValue)) {
      if (isPlainObject(parsed)) return parsed;
      if (suspiciousStructuredString) return cloneStructuredValue(defaultValue);
      return value;
    }

    return value;
  }

  function normalizeArgsWithDefaults(args, defaults) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
    const normalized = { ...args };
    Object.keys(normalized).forEach((key) => {
      if (!hasOwnKey(defaults, key)) return;
      normalized[key] = normalizeValueAgainstDefault(normalized[key], defaults[key]);
    });
    return normalized;
  }

  function normalizePlainObjectArg(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value };
    }
    if (typeof value !== 'string') return {};
    const parsed = parseMaybeJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  }

  function encodeFormBody(params) {
    const body = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      body.set(key, String(value));
    });
    return body.toString();
  }

  async function fetchGet(url, params) {
    const requestUrl = new URL(url, window.location.origin);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      requestUrl.searchParams.set(key, String(value));
    });

    const response = await fetch(requestUrl.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
      },
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: requestUrl.toString(),
      data: parseMaybeJson(text),
      rawText: text,
    };
  }

  async function postForm(url, params) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: encodeFormBody(params),
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url,
      data: parseMaybeJson(text),
      rawText: text,
    };
  }

  async function sendJson(url, method, payload) {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url,
      data: parseMaybeJson(text),
      rawText: text,
    };
  }

  function checkLoginStatus() {
    const hostname = window.location.hostname;
    const href = window.location.href;
    const onLoginPage = /(^|\\.)(login|signin|sso|auth)(\\.|$)/i.test(hostname)
      || /\\/(login|signin|sso|auth)(?:[/?#]|$)/i.test(window.location.pathname);
    const hasVisibleBody = !!document.body && document.body.innerText.trim().length > 0;
    return {
      logged_in: hasVisibleBody && !onLoginPage,
      on_login_page: onLoginPage,
      current_url: href,
      hint: onLoginPage ? 'current page looks like login page' : 'page is available for cookie-auth API calls',
    };
  }

  function toAvailabilitySlot(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2})/);
    return match ? \`\${match[1]}T\${match[2]}\` : trimmed;
  }

  function formatLocalDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return \`\${year}-\${month}-\${day}\`;
  }

  function withDayOffset(referenceDate, offsetDays) {
    const base = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate())
      : new Date();
    base.setDate(base.getDate() + offsetDays);
    return base;
  }

  function resolveDateLabel(text, referenceDate = new Date()) {
    if (typeof text !== 'string') return '';
    const normalized = text.trim();
    if (!normalized) return '';

    const explicitIso = normalized.match(/(\\d{4}-\\d{2}-\\d{2})/);
    if (explicitIso) return explicitIso[1];

    const explicitCn = normalized.match(/(\\d{4})年(\\d{1,2})月(\\d{1,2})日/);
    if (explicitCn) {
      return \`\${explicitCn[1]}-\${String(Number(explicitCn[2])).padStart(2, '0')}-\${String(Number(explicitCn[3])).padStart(2, '0')}\`;
    }

    const monthDay = normalized.match(/(\\d{1,2})月(\\d{1,2})日/);
    if (monthDay) {
      const base = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? referenceDate : new Date();
      return \`\${base.getFullYear()}-\${String(Number(monthDay[1])).padStart(2, '0')}-\${String(Number(monthDay[2])).padStart(2, '0')}\`;
    }

    if (/大后天/.test(normalized)) return formatLocalDate(withDayOffset(referenceDate, 3));
    if (/后天/.test(normalized)) return formatLocalDate(withDayOffset(referenceDate, 2));
    if (/明天/.test(normalized)) return formatLocalDate(withDayOffset(referenceDate, 1));
    if (/今天|今日/.test(normalized)) return formatLocalDate(withDayOffset(referenceDate, 0));

    const nextWeek = normalized.match(/下周([一二三四五六日天])/);
    if (nextWeek) {
      const weekdayMap = {
        '一': 1,
        '二': 2,
        '三': 3,
        '四': 4,
        '五': 5,
        '六': 6,
        '日': 0,
        '天': 0,
      };
      const target = weekdayMap[nextWeek[1]];
      if (target !== undefined) {
        const base = withDayOffset(referenceDate, 0);
        const current = base.getDay();
        const delta = ((7 - current + target) % 7) + 7;
        return formatLocalDate(withDayOffset(base, delta));
      }
    }

    return '';
  }

  function normalizeClockToken(token, context = '') {
    if (typeof token !== 'string') return '';
    const normalized = token.trim().replace(/点半$/, ':30').replace(/点$/, ':00');
    const match = normalized.match(/^(\\d{1,2})(?::(\\d{2}))?$/);
    if (!match) return '';

    let hour = Number(match[1]);
    const minute = Number(match[2] || '0');
    if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) return '';

    if (/凌晨/.test(context)) {
      if (hour === 12) hour = 0;
    } else if (/中午/.test(context)) {
      if (hour >= 1 && hour <= 10) hour += 12;
    } else if (/下午|晚上|晚间|傍晚/.test(context)) {
      if (hour >= 1 && hour <= 11) hour += 12;
    } else if (/上午|早上|早晨|清晨/.test(context)) {
      if (hour === 12) hour = 0;
    }

    return \`\${String(hour).padStart(2, '0')}:\${String(minute).padStart(2, '0')}\`;
  }

  function extractGenericActionIntent(instruction) {
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    const result = {
      resourceQuery: '',
      startTime: '',
      endTime: '',
    };
    if (!text) return result;

    const explicitRange = text.match(/(\\d{4}-\\d{2}-\\d{2})[ T](\\d{1,2}:\\d{2})(?::\\d{2})?\\s*(?:-|~|至|到)\\s*(?:(\\d{4}-\\d{2}-\\d{2})[ T])?(\\d{1,2}:\\d{2})(?::\\d{2})?/);
    if (explicitRange) {
      const startHour = explicitRange[2].padStart(5, '0');
      const endDate = explicitRange[3] || explicitRange[1];
      const endHour = explicitRange[4].padStart(5, '0');
      result.startTime = \`\${explicitRange[1]} \${startHour}:00\`;
      result.endTime = \`\${endDate} \${endHour}:00\`;
    } else {
      const startOnly = text.match(/(\\d{4}-\\d{2}-\\d{2})[ T](\\d{1,2}:\\d{2})(?::\\d{2})?/);
      if (startOnly) result.startTime = \`\${startOnly[1]} \${startOnly[2].padStart(5, '0')}:00\`;
    }

    if (!result.startTime || !result.endTime) {
      const resolvedDate = resolveDateLabel(text, new Date());
      const relativeRange = text.match(/((?:今天|今日|明天|后天|大后天|下周[一二三四五六日天]|\\d{4}-\\d{2}-\\d{2}|\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{1,2}月\\d{1,2}日)[^\\d]{0,12})?(\\d{1,2}(?::\\d{2})?|\\d{1,2}点半|\\d{1,2}点)\\s*(?:-|~|至|到)\\s*((?:今天|今日|明天|后天|大后天|下周[一二三四五六日天]|\\d{4}-\\d{2}-\\d{2}|\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{1,2}月\\d{1,2}日)[^\\d]{0,12})?(\\d{1,2}(?::\\d{2})?|\\d{1,2}点半|\\d{1,2}点)/);
      if (resolvedDate && relativeRange) {
        const startContext = (relativeRange[1] || '') + ' ' + text;
        const endContext = (relativeRange[3] || relativeRange[1] || '') + ' ' + text;
        const startClock = normalizeClockToken(relativeRange[2], startContext);
        const endClock = normalizeClockToken(relativeRange[4], endContext);
        const endDate = resolveDateLabel(relativeRange[3] || relativeRange[1] || text, new Date()) || resolvedDate;
        if (!result.startTime && startClock) result.startTime = \`\${resolvedDate} \${startClock}:00\`;
        if (!result.endTime && endClock) result.endTime = \`\${endDate} \${endClock}:00\`;
      } else if (resolvedDate) {
        const singleTime = text.match(/((?:今天|今日|明天|后天|大后天|下周[一二三四五六日天]|上午|下午|中午|晚上|晚间|早上|早晨|清晨|凌晨)[^\\d]{0,12})?(\\d{1,2}(?::\\d{2})?|\\d{1,2}点半|\\d{1,2}点)/);
        if (singleTime) {
          const clock = normalizeClockToken(singleTime[2], (singleTime[1] || '') + ' ' + text);
          if (!result.startTime && clock) result.startTime = \`\${resolvedDate} \${clock}:00\`;
        }
      }
    }

    const quoted = text.match(/["'“”‘’]([^"'“”‘’]{1,40})["'“”‘’]/);
    if (quoted) {
      result.resourceQuery = quoted[1].trim();
    } else {
      const reverseResourceMatch = text.match(/的\\s*([A-Za-z0-9_\\-\\u4e00-\\u9fa5]{1,30})\\s*(?:会议室|资源|房间|教室|工位|设备)/);
      const compactResourceMatch = text.match(/([A-Za-z0-9_\\-]{1,30})\\s*(?:会议室|资源|房间|教室|工位|设备)/);
      const forwardResourceMatch = text.match(/(?:会议室|资源|房间|教室|工位|设备)\\s*([A-Za-z0-9_\\-\\u4e00-\\u9fa5]{1,30})/);
      const resourceMatch = reverseResourceMatch || compactResourceMatch || forwardResourceMatch;
      if (resourceMatch) result.resourceQuery = resourceMatch[1].trim();
    }

    return result;
  }

  function deriveLookupDateValue(fieldName, startTime) {
    if (typeof fieldName !== 'string' || typeof startTime !== 'string') return '';
    const normalizedField = fieldName.trim().toLowerCase();
    const normalizedStartTime = startTime.trim();
    if (!normalizedField || !normalizedStartTime) return '';
    const dateMatch = normalizedStartTime.match(/^(\\d{4}-\\d{2}-\\d{2})(?:[ T](\\d{2}:\\d{2}:\\d{2}|\\d{2}:\\d{2}))?/);
    if (!dateMatch) return '';

    const dateOnly = dateMatch[1];
    const timePart = dateMatch[2] || '00:00:00';
    const normalizedTime = timePart.length === 5 ? \`\${timePart}:00\` : timePart;

    if (/booktime|bookingtime|meetingtime|querytime|targettime/.test(normalizedField)) {
      return \`\${dateOnly} 00:00:00\`;
    }
    if (/(date|day)$/.test(normalizedField) || /bookdate|meetingdate|querydate|targetdate/.test(normalizedField)) {
      return dateOnly;
    }
    if (/time/.test(normalizedField)) {
      return \`\${dateOnly} \${normalizedTime}\`;
    }

    return '';
  }

  function getByPath(value, dottedPath) {
    if (!dottedPath) return value;
    return dottedPath.split('.').reduce((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return current[key];
    }, value);
  }

  function summarizeAvailability(availabilityValue, slotKey) {
    if (!availabilityValue || typeof availabilityValue !== 'object' || Array.isArray(availabilityValue)) {
      return {
        slotKey: slotKey || '',
        status: 'unknown',
        slotValue: undefined,
      };
    }

    if (!slotKey) {
      const entries = Object.entries(availabilityValue);
      return {
        slotKey: '',
        status: 'unknown',
        slotValue: undefined,
        totalSlots: entries.length,
        availableSlots: entries.filter(([, value]) => value === null || value === undefined || value === '').length,
      };
    }

    const slotValue = availabilityValue[slotKey];
    if (slotValue === null || slotValue === undefined || slotValue === '') {
      return {
        slotKey,
        status: 'available',
        slotValue,
      };
    }

    return {
      slotKey,
      status: 'unavailable',
      slotValue,
    };
  }

  function normalizeListItems(result, hintConfig, options = {}) {
    const hints = hintConfig?.responseHints || {};
    const listPath = hints.listPath || '';
    const rawItems = getByPath(result?.data, listPath);
    const list = Array.isArray(rawItems) ? rawItems : [];
    const availabilitySlot = typeof options.availabilitySlot === 'string' ? options.availabilitySlot.trim() : '';
    const onlyAvailable = Boolean(options.onlyAvailable);
    const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
    const resourceId = typeof options.resourceId === 'string' ? options.resourceId.trim() : '';
    const limit = Number(options.limit || 0);
    const normalized = list.map((item, index) => {
      const idKey = hints.preferredIdKey || '';
      const displayKey = hints.preferredDisplayKey || '';
      const availabilityKey = hints.preferredAvailabilityKey || '';
      const availability = availabilityKey && item && typeof item === 'object' ? item[availabilityKey] : undefined;
      const availabilitySummary = summarizeAvailability(availability, availabilitySlot);

      return {
        index,
        id: idKey && item && typeof item === 'object' ? item[idKey] : undefined,
        display: displayKey && item && typeof item === 'object' ? item[displayKey] : undefined,
        availability: availabilitySummary,
        raw: item,
      };
    });

    const filtered = normalized
      .filter((item) => {
        if (resourceId && String(item.id ?? '') !== resourceId) return false;
        if (query) {
          const haystack = [item.id, item.display].filter(Boolean).join(' ').toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        if (onlyAvailable && item.availability?.status !== 'available') return false;
        return true;
      });

    return {
      ok: result?.ok,
      status: result?.status,
      url: result?.url,
      listPath,
      totalItems: list.length,
      returnedItems: limit > 0 ? filtered.slice(0, limit) : filtered,
      mapping: {
        preferredIdKey: hints.preferredIdKey || '',
        preferredDisplayKey: hints.preferredDisplayKey || '',
        preferredAvailabilityKey: hints.preferredAvailabilityKey || '',
        idLikeKeys: hints.idLikeKeys || [],
        displayLikeKeys: hints.displayLikeKeys || [],
        availabilityLikeKeys: hints.availabilityLikeKeys || [],
      },
      rawData: result?.data,
    };
  }

${primaryBlock ? `${primaryBlock.functionSource}\n\n` : ''}${secondaryBlock ? `${secondaryBlock.functionSource}\n\n` : ''}${actionBlocks.map((block) => `${block.functionSource}\n\n`).join('')}${semanticReadBlock ? `${semanticReadBlock.functionSource}\n\n` : ''}${actionPlanBlock ? `${actionPlanBlock.functionSource}\n\n` : ''}${includeDetailHints ? `  function listDetailCandidates() {
    return {
      mode: ${serializeJsValue(memory.detailHints.mode)},
      bestCandidateHref: ${serializeJsValue(memory.detailHints.bestCandidateHref)},
      bestCandidateText: ${serializeJsValue(memory.detailHints.bestCandidateText)},
      networkDetailCandidates: ${serializeJsValue(memory.detailHints.networkDetailCandidates.slice(0, 10))},
    };
  }

` : ''}  globalStore[${serializeJsValue(memory.siteKey)}] = {
    source: 'site_memory',
    workflowVersion: ${serializeJsValue(memory.workflowVersion)},
    toolNames: ${serializeJsValue(toolNames)},
    actionHints: ${serializeJsValue(actionHintRegistry)},
    tools: [
${toolDefs.join(',\n')}
    ],
  };
})();
`
}

function buildIndexSnippet(siteKey: string): string {
  return `// Add this inside the adapter tools array in extension/adapters/${siteKey}/index.js
...(window.__webmcpGeneratedSupport?.[${serializeJsValue(siteKey)}]?.tools || []),
`
}

function buildIntegrationGuide(
  memory: SiteMemoryRecord,
  context: {
    supportFileRel: string
    indexSnippetRel: string
    manifestPath: string
    indexPath: string
    toolNames: string[]
    primary: SiteApiCandidate | null
    secondary: SiteApiCandidate | null
    actionCandidates: SelectedActionCandidate[]
    mode: GeneratedAdapterScaffold['mode']
    generationStrategy: GeneratedAdapterScaffold['generationStrategy']
  },
): string {
  const lines = [
    '# Generated Adapter Integration Draft',
    '',
    `Site: ${memory.siteHost}`,
    `Workflow Version: ${memory.workflowVersion}`,
    `Mode: ${context.mode}`,
    `Generation Strategy: ${context.generationStrategy}`,
    '',
    '## Goal',
    '',
    'This draft follows the current adapter architecture:',
    '- implementation lives in an extra JS support file under the site adapter directory',
    '- adapter manifest injects that file before index.js via support_files',
    '- index.js exposes the generated tools by delegating to the generated support registry',
    '',
    '## Generated Files',
    '',
    `- Support file: ${context.supportFileRel}`,
    `- Index snippet: ${context.indexSnippetRel}`,
    '',
    '## Required Wiring',
    '',
    `1. Confirm ${context.manifestPath} contains:`,
    '',
    '```json',
    JSON.stringify({ support_files: [context.supportFileRel] }, null, 2),
    '```',
    '',
    `2. Add this line inside the tools array of ${context.indexPath}:`,
    '',
    '```js',
    buildIndexSnippet(memory.siteKey).trimEnd(),
    '```',
    '',
    '## Runtime Activation',
    '',
    '- The scaffold generator also updates extension/adapters/index.json and extension/adapters/registry.json so the adapter becomes discoverable by extension bootstrap.',
    '- After generating or updating an adapter, reload the Chrome extension once so background discovery re-scans installed adapters.',
    `- Then open or refresh ${memory.canonicalEntryUrl || memory.siteOrigin || `https://${memory.siteHost}/`} so the site adapter can be injected into a live tab.`,
    '',
    '## Generated Tools',
    '',
    ...context.toolNames.map((name) => `- ${name}`),
    '',
    '## API Signals',
    '',
    ...(context.primary ? [`- Primary list API: ${context.primary.method} ${context.primary.url}`] : []),
    ...(context.secondary ? [`- Secondary list API: ${context.secondary.method} ${context.secondary.url}`] : []),
    ...context.actionCandidates.map((candidate) => `- Action API (${candidate.actionName}): ${candidate.method} ${candidate.url}`),
    ...context.actionCandidates.flatMap((candidate) => renderActionHintLines(memory.siteKey, candidate, selectSemanticReadCandidate(context.actionCandidates))),
    '',
    '## Notes',
    '',
    '- The current generator keeps generic list-tool names because exploration does not yet infer stable business intent.',
    '- Weak record-like list endpoints are filtered out when stronger action signals exist.',
    '- Captured action tools keep the action-derived tool name from site memory because action capture already carries stronger business semantics.',
    '- Action tools are side-effecting by nature. Review captured defaults such as roomId, attendees, and time range before real execution.',
    '- After plan/prepare review, pass business parameters and, when available, __fieldSources from result.resolvedFields. The current client or Agent host owns final execution confirmation.',
    '- This output is intended to be directly consumed by later AI models or human follow-up work.',
  ]

  return lines.join('\n')
}

function buildGeneratedToolNames(
  siteKey: string,
  context: {
    hasPrimary: boolean
    hasSecondary: boolean
    includeDetailHints: boolean
    actionCandidates: SelectedActionCandidate[]
    normalizedActionToolNames: string[]
    semanticToolNames: string[]
    actionPlanToolNames: string[]
  },
): string[] {
  const names = [
    `${siteKey}.check_login_status`,
  ]
  if (context.hasPrimary) names.push(`${siteKey}.search_records`)
  if (context.hasSecondary) names.push(`${siteKey}.fetch_summary_groups`)
  for (const candidate of context.actionCandidates) {
    names.push(candidate.toolName)
  }
  for (const name of context.normalizedActionToolNames) {
    names.push(name)
  }
  for (const name of context.semanticToolNames) {
    names.push(name)
  }
  for (const name of context.actionPlanToolNames) {
    names.push(name)
  }
  if (context.includeDetailHints) names.push(`${siteKey}.list_detail_candidates`)
  return names
}

function buildActionHintRegistry(
  siteKey: string,
  actionCandidates: SelectedActionCandidate[],
  semanticReadCandidate: SelectedActionCandidate | null,
): Record<string, unknown> {
  const entries = actionCandidates
    .filter((candidate) => candidate.toolName)
    .map((candidate) => [candidate.toolName, {
      actionName: candidate.actionName,
      method: candidate.method,
      url: candidate.url,
      normalizedToolName: canBuildNormalizedReadTool(candidate) ? buildNormalizedActionToolName(candidate.toolName) : '',
      semanticToolNames: buildSemanticToolNamesForCandidate(siteKey, candidate),
      responseHints: candidate.responseHints || null,
      planningHints: buildActionPlanningHints(siteKey, candidate, semanticReadCandidate),
    }])

  return Object.fromEntries(entries)
}

function buildSemanticToolNamesForCandidate(siteKey: string, candidate: SelectedActionCandidate): string[] {
  if (!canBuildNormalizedReadTool(candidate)) return []
  const names = [`${siteKey}.list_resources`]
  if (hasAvailabilityHints(candidate)) {
    names.push(`${siteKey}.find_available_resources`)
  }
  return names
}

function buildActionPlanningHints(
  siteKey: string,
  candidate: SelectedActionCandidate,
  semanticReadCandidate: SelectedActionCandidate | null,
): Record<string, unknown> | null {
  const parameterNames = extractActionParameterNames(candidate)
  const kind = (candidate.method || '').toUpperCase() === 'GET' ? 'read_query' : 'write_action'
  const resourceIdParameter = selectResourceReferenceField(parameterNames)
  const startTimeParameter = selectStartTimeField(parameterNames)
  const endTimeParameter = selectEndTimeField(parameterNames)
  const lookupToolNames = semanticReadCandidate ? buildSemanticToolNamesForCandidate(siteKey, semanticReadCandidate) : []
  const normalizedLookupToolName = semanticReadCandidate?.toolName
    ? buildNormalizedActionToolName(semanticReadCandidate.toolName)
    : ''
  const preferredLookupIdKey = semanticReadCandidate?.responseHints?.preferredIdKey || ''
  const preferredLookupDisplayKey = semanticReadCandidate?.responseHints?.preferredDisplayKey || ''
  const preferredLookupAvailabilityKey = semanticReadCandidate?.responseHints?.preferredAvailabilityKey || ''
  const availabilityLookupToolName = lookupToolNames.includes(`${siteKey}.find_available_resources`)
    ? `${siteKey}.find_available_resources`
    : ''

  const hints: Record<string, unknown> = {
    kind,
    parameterNames,
  }
  if (resourceIdParameter) hints.resourceIdParameter = resourceIdParameter
  if (lookupToolNames.length > 0) hints.resourceLookupToolNames = lookupToolNames
  if (normalizedLookupToolName) hints.resourceLookupNormalizedToolName = normalizedLookupToolName
  if (preferredLookupIdKey) hints.preferredLookupIdKey = preferredLookupIdKey
  if (preferredLookupDisplayKey) hints.preferredLookupDisplayKey = preferredLookupDisplayKey
  if (preferredLookupAvailabilityKey) hints.preferredLookupAvailabilityKey = preferredLookupAvailabilityKey
  if (startTimeParameter) hints.startTimeParameter = startTimeParameter
  if (endTimeParameter) hints.endTimeParameter = endTimeParameter
  if (availabilityLookupToolName) hints.availabilityLookupToolName = availabilityLookupToolName
  if (kind === 'write_action' && resourceIdParameter && lookupToolNames.length > 0) {
    hints.prepareActionToolName = buildPrepareActionToolName(siteKey, candidate.actionName)
    hints.planActionToolName = buildPlanActionToolName(siteKey, candidate.actionName)
  }

  return Object.keys(hints).length > 0 ? hints : null
}

function extractActionParameterNames(candidate: SelectedActionCandidate): string[] {
  const defaults = deriveActionCandidateDefaults(candidate).defaults
  return Object.keys(defaults)
}

function selectResourceReferenceField(parameterNames: string[]): string {
  const strongMatches = parameterNames.filter((name) => /(?:room|resource|asset|desk|seat|device|workspace|meetingRoom)id$/i.test(name))
  if (strongMatches.length > 0) return strongMatches[0]
  const genericMatches = parameterNames.filter((name) => /(^|_)(resource|asset|room|desk|seat|device)_?id$/i.test(name))
  return genericMatches[0] || ''
}

function selectStartTimeField(parameterNames: string[]): string {
  return parameterNames.find((name) => /^(start|from)(time|date)?$/i.test(name)) || ''
}

function selectEndTimeField(parameterNames: string[]): string {
  return parameterNames.find((name) => /^(end|to)(time|date)?$/i.test(name)) || ''
}

function selectLookupDateField(parameterNames: string[]): string {
  const strongMatch = parameterNames.find((name) => /booktime|bookingtime|meetingtime|querytime|targettime/i.test(name))
  if (strongMatch) return strongMatch
  const dateMatch = parameterNames.find((name) => /bookdate|meetingdate|querydate|targetdate|(^|_)(date|day)$/i.test(name))
  if (dateMatch) return dateMatch
  const genericTimeMatch = parameterNames.find((name) => /time/i.test(name) && !/start|end/i.test(name))
  return genericTimeMatch || ''
}

function collectNormalizedActionToolNames(siteKey: string, actionCandidates: SelectedActionCandidate[]): string[] {
  return actionCandidates
    .filter(canBuildNormalizedReadTool)
    .map((candidate) => buildNormalizedActionToolName(candidate.toolName || `${siteKey}.${candidate.actionName}_draft`))
}

function collectSemanticReadToolNames(siteKey: string, actionCandidates: SelectedActionCandidate[]): string[] {
  const candidate = selectSemanticReadCandidate(actionCandidates)
  if (!candidate) return []

  const names = [`${siteKey}.list_resources`]
  if (hasAvailabilityHints(candidate)) {
    names.push(`${siteKey}.find_available_resources`)
  }
  return names
}

function collectActionPlanToolNames(siteKey: string, actionCandidates: SelectedActionCandidate[]): string[] {
  const semanticReadCandidate = selectSemanticReadCandidate(actionCandidates)
  if (!semanticReadCandidate) return []
  return actionCandidates.flatMap((candidate) => {
    if (!canBuildPrepareActionTool(siteKey, candidate, semanticReadCandidate)) return []
    return [
      buildPrepareActionToolName(siteKey, candidate.actionName),
      buildPlanActionToolName(siteKey, candidate.actionName),
    ]
  })
}

function buildPrepareActionToolName(siteKey: string, actionName: string): string {
  return `${siteKey}.prepare_${toSafeIdentifier(actionName)}`
}

function buildPlanActionToolName(siteKey: string, actionName: string): string {
  return `${siteKey}.plan_${toSafeIdentifier(actionName)}`
}

function canBuildPrepareActionTool(
  siteKey: string,
  candidate: SelectedActionCandidate,
  semanticReadCandidate: SelectedActionCandidate | null,
): boolean {
  if (!semanticReadCandidate) return false
  if ((candidate.method || '').toUpperCase() === 'GET') return false
  const planningHints = buildActionPlanningHints(siteKey, candidate, semanticReadCandidate)
  return typeof planningHints?.resourceIdParameter === 'string'
    && Boolean(planningHints.resourceIdParameter)
    && Array.isArray(planningHints.resourceLookupToolNames)
    && planningHints.resourceLookupToolNames.length > 0
}

function selectApis(memory: SiteMemoryRecord, actionCandidates: SelectedActionCandidate[]): SelectedApis {
  const sorted = collectRankedListCandidates(memory, actionCandidates.length > 0)
  return {
    primary: sorted[0] || null,
    secondary: sorted[1] || null,
  }
}

function collectRankedListCandidates(memory: SiteMemoryRecord, hasActionCandidates: boolean): SiteApiCandidate[] {
  const merged = new Map<string, SiteApiCandidate>()

  for (const candidate of memory.listApiCandidates) {
    merged.set(candidateKey(candidate), candidate)
  }

  for (const candidate of extractVerdictApiCandidates(memory.verdictReason)) {
    const key = candidateKey(candidate)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, candidate)
      continue
    }
    merged.set(key, {
      ...existing,
      sourceSteps: Array.from(new Set([...(existing.sourceSteps || []), ...(candidate.sourceSteps || [])])),
    })
  }

  const threshold = hasActionCandidates ? 2 : 0
  return [...merged.values()]
    .map((candidate) => ({ candidate, score: scoreListCandidate(candidate) }))
    .filter((entry) => entry.score > threshold)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      return left.candidate.url.localeCompare(right.candidate.url)
    })
    .map((entry) => entry.candidate)
    .slice(0, 2)
}

function extractVerdictApiCandidates(verdictReason: string): SiteApiCandidate[] {
  const text = safeString(verdictReason)
  if (!text) return []
  const matches = text.match(/https?:\/\/[^\s，。；）)]+/g) || []
  const seen = new Set<string>()
  const candidates: SiteApiCandidate[] = []
  for (const raw of matches) {
    const url = stripTrailingPunctuation(raw)
    if (!url || seen.has(url)) continue
    seen.add(url)
    candidates.push({
      url,
      method: 'GET',
      requestBodyPreview: '',
      sourceSteps: ['verdict_reason'],
    })
  }
  return candidates
}

function scoreListCandidate(candidate: SiteApiCandidate): number {
  const probe = `${candidateUrlSignals(candidate.url)} ${candidate.requestBodyPreview || ''}`.toLowerCase()
  let score = 0
  if (/get[a-z0-9]*list|\/list\b|search|query|getrooms|rooms|availability|calendar|schedule/.test(probe)) score += 3
  if (/room|rooms|meeting|calendar|availability|schedule/.test(probe)) score += 2
  if (hasPagingSignals(candidate)) score += 2
  if (safeString(candidate.requestBodyPreview)) score += 1
  if ((candidate.sourceSteps || []).some((step) => step && step !== 'final_network')) score += 1
  if ((candidate.sourceSteps || []).includes('verdict_reason')) score += 2
  if (/violation|audit|log|record|records|history|stat|report/.test(probe)) score -= 3
  if ((candidate.sourceSteps || []).every((step) => step === 'final_network') && !safeString(candidate.requestBodyPreview) && !hasQueryParams(candidate.url)) {
    score -= 1
  }
  return score
}

function candidateUrlSignals(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    return `${parsed.pathname} ${parsed.search}`
  } catch {
    return rawUrl
  }
}

function selectActionCandidates(memory: SiteMemoryRecord): SelectedActionCandidate[] {
  const candidates = Array.isArray(memory.actionApiCandidates) ? [...memory.actionApiCandidates] : []
  candidates.sort((left, right) => {
    const leftScore = actionCandidateScore(left)
    const rightScore = actionCandidateScore(right)
    if (leftScore !== rightScore) return rightScore - leftScore
    return right.capturedAt.localeCompare(left.capturedAt)
  })

  const seen = new Set<string>()
  const result: SelectedActionCandidate[] = []
  for (const candidate of candidates) {
    const key = candidate.toolName || `${candidate.actionName} ${(candidate.method || '').toUpperCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
    if (result.length >= 3) break
  }
  return result
}

function actionCandidateScore(candidate: SelectedActionCandidate): number {
  let score = 0
  if (candidate.primarySelection === 'user') score += 100
  else if (candidate.primarySelection === 'ai' || candidate.aiIsPrimary) score += 30
  if (candidate.intercepted) score += 4
  if ((candidate.method || '').toUpperCase() !== 'GET') score += 3
  if ((candidate.blockedReason || '') === 'side-effect-safe-capture') score += 2
  if (safeString(candidate.requestBodyPreview)) score += 1
  if (safeString(candidate.responsePreview)) score += 1
  if ((candidate.responseContentType || '').toLowerCase().includes('json')) score += 1
  score += Math.min(countCandidatePreviewFields(candidate.requestBodyPreview), 8)
  score += responseHintScore(candidate.responseHints)
  return score
}

function responseHintScore(hints: SelectedActionCandidate['responseHints']): number {
  if (!hints) return 0
  let score = 0
  if (hints.listPath) score += 1
  if (hints.itemKeys.length > 0) score += 2
  if (hints.idLikeKeys.length > 0) score += 1
  if (hints.displayLikeKeys.length > 0) score += 1
  if (hints.availabilityLikeKeys.length > 0) score += 1
  if (hints.preferredIdKey) score += 1
  if (hints.preferredDisplayKey) score += 1
  if (hints.preferredAvailabilityKey) score += 1
  return score
}

function countCandidatePreviewFields(preview: string | undefined): number {
  const normalized = safeString(preview)
  if (!normalized) return 0
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>).length
      }
    } catch {
      return 0
    }
  }

  return [...new Set([...normalized.matchAll(/([A-Za-z0-9_]+)=/g)].map((match) => match[1]).filter(Boolean))].length
}

function hasUsefulDetailHints(memory: SiteMemoryRecord): boolean {
  return Boolean(
    memory.detailHints.bestCandidateHref
      || memory.detailHints.bestCandidateText
      || memory.detailHints.networkDetailCandidates.length > 0,
  )
}

function hasPagingSignals(candidate: SiteApiCandidate): boolean {
  const probe = `${candidate.url} ${candidate.requestBodyPreview || ''}`.toLowerCase()
  return /currentpage|pagesize|page=|pagecount|limit=|offset=/.test(probe)
}

function buildListSupportBlock(input: {
  candidate: SiteApiCandidate
  toolName: string
  functionName: string
  description: string
}): ListSupportBlock {
  const { candidate, toolName, functionName, description } = input
  const { defaults, transport } = deriveCandidateDefaults(candidate)
  const schema = buildCapturedFieldsSchema(defaults, 'Captured default field from list request')

  let invokeLine = `    return postForm(${serializeJsValue(candidate.url)}, params);`
  if (transport === 'get_query') {
    invokeLine = `    return fetchGet(${serializeJsValue(candidate.url)}, params);`
  } else if (transport === 'post_json') {
    invokeLine = `    return sendJson(${serializeJsValue(candidate.url)}, ${serializeJsValue((candidate.method || 'POST').toUpperCase())}, params);`
  }

  return {
    toolName,
    functionSource: `  async function ${functionName}(args = {}) {
    const params = {
      ...${serializeJsValue(defaults)},
      ...(args || {}),
    };

${invokeLine}
  }`,
    toolDefinition: `      {
        name: ${serializeJsValue(toolName)},
        description: ${serializeJsValue(description)},
        parameters: ${JSON.stringify(schema, null, 8)},
        handler: (args) => ${functionName}(args || {}),
      }`,
  }
}

function deriveCandidateDefaults(candidate: SiteApiCandidate): CandidateDefaults {
  const transport = inferCandidateTransport(candidate)
  const queryDefaults = parseUrlQueryDefaults(candidate.url)
  const bodyDefaults = parseCandidateBodyDefaults(candidate.requestBodyPreview || '')
  return {
    defaults: {
      ...queryDefaults,
      ...bodyDefaults,
    },
    transport,
  }
}

function inferCandidateTransport(candidate: SiteApiCandidate): CandidateTransport {
  const method = (candidate.method || 'GET').toUpperCase()
  if (method === 'GET') return 'get_query'
  const preview = safeString(candidate.requestBodyPreview)
  if (preview.startsWith('{') || preview.startsWith('[')) return 'post_json'
  return 'post_form'
}

function buildActionSupportBlock(siteKey: string, candidate: SelectedActionCandidate, index: number): ActionSupportBlock {
  const { defaults, transport } = deriveActionCandidateDefaults(candidate)
  const baseSchema = transport === 'post_json'
    ? buildActionToolSchema(parseActionRequestPreview(candidate.requestBodyPreview || ''))
    : buildCapturedFieldsSchema(defaults, 'Captured default field from action request')
  const schema = transport === 'get_query'
    ? baseSchema
    : buildConfirmedActionToolSchema(baseSchema)
  const safeName = toSafeIdentifier(`${candidate.actionName}_${index}`)
  const handlerName = `run_${safeName}`
  const method = (candidate.method || 'POST').toUpperCase()

  let invokeLine = `    return sendJson(${serializeJsValue(candidate.url)}, ${serializeJsValue(method)}, payload);`
  if (transport === 'get_query') {
    invokeLine = `    return fetchGet(${serializeJsValue(candidate.url)}, payload);`
  } else if (transport === 'post_form') {
    invokeLine = `    return postForm(${serializeJsValue(candidate.url)}, payload);`
  }

  const description = transport === 'get_query'
    ? `Generated read/query draft for ${candidate.actionName}, captured from ${candidate.method} ${candidate.url}. This tool is intended for repeatable read-path automation and should not create side effects.${renderActionResponseHintSentence(candidate)}`
    : `Generated action draft for ${candidate.actionName}, captured from ${candidate.method} ${candidate.url}. This tool may trigger a real business side effect, so the current client or Agent host must confirm the final payload before submission.`
  const sensitiveFieldConfigs = transport === 'get_query'
    ? []
    : buildSensitiveActionFieldConfigs(Object.keys(defaults))
  const functionSource = transport === 'get_query'
    ? `  async function ${handlerName}(args = {}) {
    const payload = {
      ...${serializeJsValue(defaults)},
      ...(args || {}),
    };

${invokeLine}
  }`
    : `  async function ${handlerName}(args = {}) {
    const {
      confirmed = false,
      __confirmed = false,
      __fieldSources = {},
      ...actionArgs
    } = args || {};
    const explicitFieldSources = normalizePlainObjectArg(__fieldSources);
    const defaultPayload = ${serializeJsValue(defaults)};
    const normalizedActionArgs = normalizeArgsWithDefaults(actionArgs, defaultPayload);
    const payload = {
      ...defaultPayload,
      ...normalizedActionArgs,
    };
    const warnings = [];
    const sensitiveFieldStatus = Object.fromEntries(${serializeJsValue(sensitiveFieldConfigs)}.map((config) => {
      const fieldName = config?.fieldName || '';
      if (!fieldName) return null;
      const value = payload[fieldName];
      let source = '';
      if (!hasMeaningfulValue(value)) {
        source = 'missing';
      } else if (typeof explicitFieldSources[fieldName] === 'string' && explicitFieldSources[fieldName]) {
        source = explicitFieldSources[fieldName];
      } else if (hasMeaningfulValue(defaultPayload[fieldName]) && sameStructuredValue(value, defaultPayload[fieldName])) {
        source = 'captured_default';
      } else if (hasOwnKey(normalizedActionArgs, fieldName) && hasMeaningfulValue(normalizedActionArgs[fieldName])) {
        source = 'explicit_arg';
      } else {
        source = 'derived';
      }
      if (source === 'captured_default' && config.warningCode) warnings.push(config.warningCode);
      return [fieldName, {
        fieldName,
        source,
        value,
        blocking: source === 'missing' || source === 'captured_default',
      }];
    }).filter(Boolean));
    const confirmedForSubmit = Boolean(confirmed || __confirmed);
    if (!confirmedForSubmit) warnings.push('missing_confirmation');
    const warningSet = Array.from(new Set(warnings));
    const blockedBySensitiveDefaults = Object.values(sensitiveFieldStatus).some((status) => status?.blocking);
    if (!confirmedForSubmit || blockedBySensitiveDefaults) {
      return {
        ok: false,
        blocked: true,
        requiresConfirmation: true,
        actionToolName: ${serializeJsValue(candidate.toolName)},
        payload,
        warnings: warningSet,
        sensitiveFieldStatus,
        resolvedFields: Object.fromEntries(Object.entries(sensitiveFieldStatus).map(([fieldName, status]) => [fieldName, status?.source || ''])),
        confirmationHint: 'This tool triggers a real business action. Resolve missing or captured sensitive fields first; the current client or Agent host will request confirmation for the final payload.',
        nextStep: 'resolve_sensitive_fields_then_retry_with_business_parameters_only',
      };
    }

${invokeLine}
  }`

  const blocks: ActionSupportBlock[] = [{
    functionSource,
    toolDefinition: `      {
        name: ${serializeJsValue(candidate.toolName)},
        description: ${serializeJsValue(description)},
        parameters: ${JSON.stringify(schema, null, 8)},
        handler: (args) => ${handlerName}(args || {}),
      }`,
    handlerName,
    candidate,
  }]

  if (canBuildNormalizedReadTool(candidate)) {
    const normalizedHandlerName = `${handlerName}_normalized`
    const normalizedToolName = buildNormalizedActionToolName(candidate.toolName || `${siteKey}.${candidate.actionName}_draft`)
    const normalizedSchema = buildNormalizedActionToolSchema(defaults)
    const normalizedDescription = `Runs ${candidate.toolName} and returns normalized list items using captured response hints. Normalized items expose id, display, availability, and raw fields.${renderActionResponseHintSentence(candidate)}`
    blocks.push({
      functionSource: `  async function ${normalizedHandlerName}(args = {}) {
    const { availabilitySlot = '', onlyAvailable = false, limit = 0, query = '', resourceId = '', ...requestArgs } = args || {};
    const result = await ${handlerName}(requestArgs);
    return normalizeListItems(result, ${serializeJsValue({
      toolName: candidate.toolName,
      actionName: candidate.actionName,
      responseHints: candidate.responseHints || null,
    })}, { availabilitySlot, onlyAvailable, limit, query, resourceId });
  }`,
      toolDefinition: `      {
        name: ${serializeJsValue(normalizedToolName)},
        description: ${serializeJsValue(normalizedDescription)},
        parameters: ${JSON.stringify(normalizedSchema, null, 8)},
        handler: (args) => ${normalizedHandlerName}(args || {}),
      }`,
      normalizedToolName,
      normalizedHandlerName,
      candidate,
    })
  }

  return {
    functionSource: blocks.map((block) => block.functionSource).join('\n\n'),
    toolDefinition: blocks.map((block) => block.toolDefinition).join(',\n'),
    handlerName,
    normalizedToolName: blocks.find((block) => block.normalizedToolName)?.normalizedToolName,
    normalizedHandlerName: blocks.find((block) => block.normalizedHandlerName)?.normalizedHandlerName,
    candidate,
  }
}

function buildSensitiveActionFieldConfigs(parameterNames: string[]): Array<{ fieldName: string, warningCode: string }> {
  const resourceIdParameter = selectResourceReferenceField(parameterNames)
  const startTimeField = selectStartTimeField(parameterNames)
  const endTimeField = selectEndTimeField(parameterNames)
  return [
    resourceIdParameter ? { fieldName: resourceIdParameter, warningCode: 'resource_id_uses_captured_default' } : null,
    startTimeField ? { fieldName: startTimeField, warningCode: 'start_time_uses_captured_default' } : null,
    endTimeField ? { fieldName: endTimeField, warningCode: 'end_time_uses_captured_default' } : null,
  ].filter((config): config is { fieldName: string, warningCode: string } => Boolean(config))
}

function deriveActionCandidateDefaults(candidate: SelectedActionCandidate): CandidateDefaults {
  const transport = inferActionCandidateTransport(candidate)
  const queryDefaults = parseUrlQueryDefaults(candidate.url)
  const bodyDefaults = parseCandidateBodyDefaults(candidate.requestBodyPreview || '')
  return {
    defaults: transport === 'get_query'
      ? { ...queryDefaults, ...bodyDefaults }
      : bodyDefaults,
    transport,
  }
}

function inferActionCandidateTransport(candidate: SelectedActionCandidate): CandidateTransport {
  const method = (candidate.method || 'GET').toUpperCase()
  if (method === 'GET') return 'get_query'
  const preview = safeString(candidate.requestBodyPreview)
  if (preview.startsWith('{') || preview.startsWith('[')) return 'post_json'
  return 'post_form'
}

function parseCandidateBodyDefaults(preview: string): Record<string, unknown> {
  const normalized = safeString(preview)
  if (!normalized) return {}
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return parseFormBodyPreview(normalized)
}

function parseUrlQueryDefaults(input: string): Record<string, string | number> {
  try {
    const parsed = new URL(input)
    const result: Record<string, string | number> = {}
    for (const [key, value] of parsed.searchParams.entries()) {
      result[key] = coerceStringValue(value)
    }
    return result
  } catch {
    return {}
  }
}

function parseFormBodyPreview(preview: string): Record<string, string | number> {
  const params = new URLSearchParams(preview || '')
  const result: Record<string, string | number> = {}
  for (const [key, value] of params.entries()) {
    result[key] = coerceStringValue(value)
  }
  return result
}

function parseActionRequestPreview(preview: string): unknown {
  const normalized = safeString(preview)
  if (!normalized) return {}
  try {
    return JSON.parse(normalized)
  } catch {
    const form = parseFormBodyPreview(normalized)
    return Object.keys(form).length > 0 ? form : { rawBody: normalized }
  }
}

function buildCapturedFieldsSchema(defaults: Record<string, unknown>, descriptionPrefix: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaults)) {
    properties[key] = {
      ...inferJsonSchema(value),
      description: `${descriptionPrefix}: ${key}`,
      default: value,
    }
  }

  return {
    type: 'object',
    properties,
    required: [],
  }
}

function buildActionToolSchema(payload: unknown): Record<string, unknown> {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    return {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          description: 'Full JSON payload for the captured action request.',
          default: payload,
        },
      },
      required: [],
    }
  }

  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    properties[key] = {
      ...inferJsonSchema(value),
      description: `Captured default field for action request: ${key}`,
      default: value,
    }
    if (!isOptionalDefaultValue(value)) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    required,
  }
}

function stripSchemaDefaults(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSchemaDefaults(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'default') continue
    result[key] = stripSchemaDefaults(nested)
  }
  return result
}

function buildConfirmedActionToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const sanitizedSchema = stripSchemaDefaults(schema) as Record<string, unknown>
  const properties = sanitizedSchema.properties && typeof sanitizedSchema.properties === 'object' && !Array.isArray(sanitizedSchema.properties)
    ? sanitizedSchema.properties as Record<string, unknown>
    : {}
  const required = Array.isArray(sanitizedSchema.required)
    ? sanitizedSchema.required.filter((item): item is string => typeof item === 'string')
    : []

  return {
    ...sanitizedSchema,
    'x-webcli-requires-confirmation': true,
    'x-webcli-confirmation-message': 'This tool submits a real business action. Confirm the final payload in the current client or Agent host before continuing.',
    properties: {
      ...properties,
      __fieldSources: {
        type: 'object',
        description: 'Optional internal provenance map from a reviewed plan/prepare result. When omitted, fields equal to captured defaults remain blocked as captured defaults.',
        default: {},
      },
    },
    required,
  }
}

function inferJsonSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const first = value[0]
    return {
      type: 'array',
      items: first === undefined ? {} : inferJsonSchema(first),
    }
  }
  if (value && typeof value === 'object') {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, nested] of Object.entries(value)) {
      properties[key] = inferJsonSchema(nested)
      if (!isOptionalDefaultValue(nested)) required.push(key)
    }
    return {
      type: 'object',
      properties,
      required,
    }
  }
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  return { type: 'string' }
}

function buildScaffoldScenarios(memory: SiteMemoryRecord): AdapterRegistryEntry['scenarios'] {
  return buildQuickPrompts(memory).map((text, index) => ({
    id: `scaffold-${index + 1}`,
    title: text.length > 32 ? `${text.slice(0, 32)}…` : text,
    summary: text,
    prompts: [{ text }],
  }))
}

function buildQuickPrompts(memory: SiteMemoryRecord): string[] {
  const prompts: string[] = []
  const firstAction = memory.actionApiCandidates[0]
  if (firstAction?.toolName) {
    prompts.push(`帮我先检查 ${firstAction.toolName} 的默认参数，不要直接提交`)
  }
  if (memory.listApiCandidates[0]) {
    prompts.push(`帮我读取 ${memory.siteHost} 的列表接口草稿结果`)
  }
  if (prompts.length === 0) {
    prompts.push(`帮我探索 ${memory.siteHost} 的可复用接口`)
  }
  return prompts
}

function renderActionResponseHintSentence(candidate: SelectedActionCandidate): string {
  const hints = candidate.responseHints
  if (!hints) return ''

  const parts: string[] = []
  if (hints.listPath) parts.push(`response list path ${hints.listPath}`)
  if (hints.idLikeKeys.length > 0) parts.push(`id-like fields ${hints.idLikeKeys.join(', ')}`)
  if (hints.displayLikeKeys.length > 0) parts.push(`display-like fields ${hints.displayLikeKeys.join(', ')}`)
  if (hints.availabilityLikeKeys.length > 0) parts.push(`availability-like fields ${hints.availabilityLikeKeys.join(', ')}`)
  if (hints.preferredIdKey) parts.push(`preferred id field ${hints.preferredIdKey}`)
  if (hints.preferredDisplayKey) parts.push(`preferred display field ${hints.preferredDisplayKey}`)
  if (hints.preferredAvailabilityKey) parts.push(`preferred availability field ${hints.preferredAvailabilityKey}`)
  if (parts.length === 0) return ''
  return ` Captured response hints suggest ${parts.join('; ')}.`
}

function renderActionHintLines(
  siteKey: string,
  candidate: SelectedActionCandidate,
  semanticReadCandidate: SelectedActionCandidate | null,
): string[] {
  const hints = candidate.responseHints
  const lines: string[] = []
  if (hints) {
    if (hints.listPath) lines.push(`- Response list path (${candidate.actionName}): ${hints.listPath}`)
    if (hints.itemKeys.length > 0) lines.push(`- Response item keys (${candidate.actionName}): ${hints.itemKeys.join(', ')}`)
    if (hints.idLikeKeys.length > 0) lines.push(`- ID-like keys (${candidate.actionName}): ${hints.idLikeKeys.join(', ')}`)
    if (hints.displayLikeKeys.length > 0) lines.push(`- Display-like keys (${candidate.actionName}): ${hints.displayLikeKeys.join(', ')}`)
    if (hints.availabilityLikeKeys.length > 0) lines.push(`- Availability-like keys (${candidate.actionName}): ${hints.availabilityLikeKeys.join(', ')}`)
    if (hints.preferredIdKey) lines.push(`- Preferred ID key (${candidate.actionName}): ${hints.preferredIdKey}`)
    if (hints.preferredDisplayKey) lines.push(`- Preferred display key (${candidate.actionName}): ${hints.preferredDisplayKey}`)
    if (hints.preferredAvailabilityKey) lines.push(`- Preferred availability key (${candidate.actionName}): ${hints.preferredAvailabilityKey}`)
  }

  const planningHints = buildActionPlanningHints(siteKey, candidate, semanticReadCandidate)
  if (planningHints) {
    const parameterNames = Array.isArray(planningHints.parameterNames) ? planningHints.parameterNames.filter(Boolean) : []
    const resourceIdParameter = typeof planningHints.resourceIdParameter === 'string' ? planningHints.resourceIdParameter : ''
    const resourceLookupToolNames = Array.isArray(planningHints.resourceLookupToolNames)
      ? planningHints.resourceLookupToolNames.filter((value): value is string => typeof value === 'string' && Boolean(value))
      : []
    const availabilityLookupToolName = typeof planningHints.availabilityLookupToolName === 'string' ? planningHints.availabilityLookupToolName : ''
    const startTimeParameter = typeof planningHints.startTimeParameter === 'string' ? planningHints.startTimeParameter : ''
    const endTimeParameter = typeof planningHints.endTimeParameter === 'string' ? planningHints.endTimeParameter : ''
    const prepareActionToolName = typeof planningHints.prepareActionToolName === 'string' ? planningHints.prepareActionToolName : ''
    const planActionToolName = typeof planningHints.planActionToolName === 'string' ? planningHints.planActionToolName : ''

    if (parameterNames.length > 0) lines.push(`- Action parameter fields (${candidate.actionName}): ${parameterNames.join(', ')}`)
    if (resourceIdParameter) lines.push(`- Resource ID parameter (${candidate.actionName}): ${resourceIdParameter}`)
    if (resourceLookupToolNames.length > 0) lines.push(`- Suggested resource lookup tools (${candidate.actionName}): ${resourceLookupToolNames.join(', ')}`)
    if (availabilityLookupToolName) lines.push(`- Suggested availability lookup tool (${candidate.actionName}): ${availabilityLookupToolName}`)
    if (prepareActionToolName) lines.push(`- Suggested prepare tool (${candidate.actionName}): ${prepareActionToolName}`)
    if (planActionToolName) lines.push(`- Suggested plan tool (${candidate.actionName}): ${planActionToolName}`)
    if (startTimeParameter || endTimeParameter) lines.push(`- Time parameters (${candidate.actionName}): ${startTimeParameter || '?'} -> ${endTimeParameter || '?'}`)
  }
  return lines
}

function canBuildNormalizedReadTool(candidate: SelectedActionCandidate): boolean {
  const method = (candidate.method || '').toUpperCase()
  const hints = candidate.responseHints
  return method === 'GET' && Boolean(hints?.listPath)
}

function buildNormalizedActionToolName(toolName: string): string {
  return /_draft$/.test(toolName) ? toolName.replace(/_draft$/, '_normalized') : `${toolName}_normalized`
}

function buildNormalizedActionToolSchema(defaults: Record<string, unknown>): Record<string, unknown> {
  const base = buildCapturedFieldsSchema(defaults, 'Captured default field from action request') as {
    type: string
    properties: Record<string, unknown>
    required: string[]
  }

  return {
    ...base,
    properties: {
      ...base.properties,
      availabilitySlot: {
        type: 'string',
        description: 'Optional availability slot key to evaluate, for example 2026-05-14T14:30.',
        default: '',
      },
      query: {
        type: 'string',
        description: 'Optional case-insensitive filter matched against normalized id and display fields.',
        default: '',
      },
      resourceId: {
        type: 'string',
        description: 'Optional exact normalized resource id filter.',
        default: '',
      },
      onlyAvailable: {
        type: 'boolean',
        description: 'When true, keep only items whose selected availability slot looks available.',
        default: false,
      },
      limit: {
        type: 'number',
        description: 'Optional maximum number of normalized items to return.',
        default: 0,
      },
    },
    required: [],
  }
}

function buildSemanticReadSupportBlock(siteKey: string, actionBlocks: ActionSupportBlock[]): SemanticReadSupportBlock | null {
  const selected = actionBlocks.find((block) => block.normalizedHandlerName && block.candidate && canBuildNormalizedReadTool(block.candidate))
  if (!selected?.normalizedHandlerName || !selected.candidate) return null

  const toolNames = [`${siteKey}.list_resources`]
  const toolDefinitions = [`      {
        name: ${serializeJsValue(`${siteKey}.list_resources`)},
        description: ${serializeJsValue(`Semantic read tool built on ${selected.normalizedToolName}. Returns normalized resource items with stable id/display/availability mapping.`)},
        parameters: ${JSON.stringify(buildSemanticListResourcesSchema(selected.candidate), null, 8)},
        handler: (args) => listSemanticResources(args || {}),
      }`]

  let functionSource = `  async function listSemanticResources(args = {}) {
    return ${selected.normalizedHandlerName}(args || {});
  }`

  if (hasAvailabilityHints(selected.candidate)) {
    toolNames.push(`${siteKey}.find_available_resources`)
    toolDefinitions.push(`      {
        name: ${serializeJsValue(`${siteKey}.find_available_resources`)},
        description: ${serializeJsValue(`Semantic availability tool built on ${selected.normalizedToolName}. Filters normalized resources by availability slot.`)},
        parameters: ${JSON.stringify(buildSemanticFindAvailableSchema(selected.candidate), null, 8)},
        handler: (args) => findSemanticAvailableResources(args || {}),
      }`)
    functionSource += `\n\n  async function findSemanticAvailableResources(args = {}) {
    const { availabilitySlot = '', limit = 0, ...requestArgs } = args || {};
    return ${selected.normalizedHandlerName}({
      ...requestArgs,
      availabilitySlot,
      onlyAvailable: true,
      limit,
    });
  }`
  }

  return {
    functionSource,
    toolDefinitions,
    toolNames,
  }
}

function buildActionPlanSupportBlock(siteKey: string, actionBlocks: ActionSupportBlock[]): ActionPlanSupportBlock | null {
  const selectedRead = actionBlocks.find((block) => block.normalizedHandlerName && block.candidate && canBuildNormalizedReadTool(block.candidate))
  if (!selectedRead?.normalizedHandlerName || !selectedRead.candidate) return null

  const toolDefinitions: string[] = []
  const functionSources: string[] = []
  const toolNames: string[] = []

  for (const block of actionBlocks) {
    if (!block.candidate || !canBuildPrepareActionTool(siteKey, block.candidate, selectedRead.candidate)) continue

    const planningHints = buildActionPlanningHints(siteKey, block.candidate, selectedRead.candidate)
    const resourceIdParameter = typeof planningHints?.resourceIdParameter === 'string' ? planningHints.resourceIdParameter : ''
    if (!resourceIdParameter) continue

    const { defaults } = deriveActionCandidateDefaults(block.candidate)
    const toolName = buildPrepareActionToolName(siteKey, block.candidate.actionName)
    const planToolName = buildPlanActionToolName(siteKey, block.candidate.actionName)
    const functionName = `prepare_${toSafeIdentifier(block.candidate.actionName)}_${toolDefinitions.length}`
    const planFunctionName = `plan_${toSafeIdentifier(block.candidate.actionName)}_${toolDefinitions.length}`
    const schema = buildPrepareActionToolSchema(defaults, resourceIdParameter)
    const planSchema = buildPlanActionToolSchema(defaults)
    const startTimeField = selectStartTimeField(Object.keys(defaults))
    const endTimeField = selectEndTimeField(Object.keys(defaults))
    const lookupDateField = selectLookupDateField(Object.keys(deriveActionCandidateDefaults(selectedRead.candidate).defaults))
    const sensitiveFieldConfigs = [
      resourceIdParameter ? { fieldName: resourceIdParameter, warningCode: 'resource_id_uses_captured_default' } : null,
      startTimeField ? { fieldName: startTimeField, warningCode: 'start_time_uses_captured_default' } : null,
      endTimeField ? { fieldName: endTimeField, warningCode: 'end_time_uses_captured_default' } : null,
    ].filter(Boolean)
    const requiredFields = Object.entries(defaults)
      .filter(([, value]) => !isOptionalDefaultValue(value))
      .map(([key]) => key)

    toolNames.push(toolName)
    toolNames.push(planToolName)
    functionSources.push(`  async function ${functionName}(args = {}) {
    const {
      resourceQuery = '',
      resourceId = '',
      availabilitySlot = '',
      lookupArgs = {},
      requireAvailable = true,
      limit = 5,
      __fieldSources = {},
      ...actionArgs
    } = args || {};
    const defaultPayload = ${serializeJsValue(defaults)};
    const explicitFieldSources = normalizePlainObjectArg(__fieldSources);
    const normalizedActionArgs = normalizeArgsWithDefaults(actionArgs, defaultPayload);
    const payload = {
      ...defaultPayload,
      ...normalizedActionArgs,
    };
    const lookupInput = {
      ...normalizePlainObjectArg(lookupArgs),
      limit,
    };
    if (availabilitySlot) {
      lookupInput.availabilitySlot = availabilitySlot;
      lookupInput.onlyAvailable = Boolean(requireAvailable);
    }
    if (resourceId) lookupInput.resourceId = String(resourceId);
    if (resourceQuery) lookupInput.query = String(resourceQuery);
    if (resourceId && !hasOwnKey(normalizedActionArgs, ${serializeJsValue(resourceIdParameter)}) && hasMeaningfulValue(resourceId)) {
      payload[${serializeJsValue(resourceIdParameter)}] = String(resourceId);
      explicitFieldSources[${serializeJsValue(resourceIdParameter)}] = 'explicit_resource_id';
    }

    const shouldLookup = Boolean(resourceId || resourceQuery || availabilitySlot);
    const lookupResult = shouldLookup ? await ${selectedRead.normalizedHandlerName}(lookupInput) : null;
    const lookupItems = Array.isArray(lookupResult?.returnedItems) ? lookupResult.returnedItems : [];
    const directResourceFieldValue = hasOwnKey(normalizedActionArgs, ${serializeJsValue(resourceIdParameter)})
      ? normalizedActionArgs[${serializeJsValue(resourceIdParameter)}]
      : undefined;
    const hasExplicitResourceField = hasMeaningfulValue(directResourceFieldValue);
    const exactResourceMatch = resourceId
      ? lookupItems.find((item) => String(item?.id ?? '') === String(resourceId))
      : null;
    const selectedResource = exactResourceMatch || (lookupItems.length === 1 ? lookupItems[0] : null);
    if (selectedResource && selectedResource.id !== undefined && selectedResource.id !== null && !hasExplicitResourceField) {
      payload[${serializeJsValue(resourceIdParameter)}] = selectedResource.id;
      explicitFieldSources[${serializeJsValue(resourceIdParameter)}] = 'resource_lookup';
    }

    const missingFields = ${serializeJsValue(requiredFields)}.filter((key) => {
      const value = payload[key];
      return !hasMeaningfulValue(value);
    });
    const warnings = [];
    if (shouldLookup && !selectedResource) warnings.push('resource_lookup_empty');
    if (lookupItems.length > 1 && !resourceId && !hasExplicitResourceField) warnings.push('multiple_resource_matches');
    if (availabilitySlot && selectedResource?.availability?.status && selectedResource.availability.status !== 'available') {
      warnings.push('selected_resource_not_available');
    }
    const sensitiveFieldStatus = Object.fromEntries(${serializeJsValue(sensitiveFieldConfigs)}.map((config) => {
      const fieldName = config?.fieldName || '';
      if (!fieldName) return null;
      const value = payload[fieldName];
      let source = '';
      if (!hasMeaningfulValue(value)) {
        source = 'missing';
      } else if (typeof explicitFieldSources[fieldName] === 'string' && explicitFieldSources[fieldName]) {
        source = explicitFieldSources[fieldName];
      } else if (hasMeaningfulValue(defaultPayload[fieldName]) && sameStructuredValue(value, defaultPayload[fieldName])) {
        source = 'captured_default';
      } else if (hasOwnKey(normalizedActionArgs, fieldName) && hasMeaningfulValue(normalizedActionArgs[fieldName])) {
        source = 'explicit_arg';
      } else {
        source = 'derived';
      }
      if (source === 'captured_default' && config.warningCode) warnings.push(config.warningCode);
      return [fieldName, {
        fieldName,
        source,
        value,
        blocking: source === 'missing' || source === 'captured_default',
      }];
    }).filter(Boolean));
    const warningSet = Array.from(new Set(warnings));
    const blockedBySensitiveDefaults = Object.values(sensitiveFieldStatus).some((status) => status?.blocking);
    const resolvedFields = Object.fromEntries(Object.entries(sensitiveFieldStatus).map(([fieldName, status]) => [fieldName, status?.source || '']));
    const confirmedActionArgs = {
      ...payload,
      confirmed: true,
      __fieldSources: resolvedFields,
    };

    return {
      ok: missingFields.length === 0 && warningSet.length === 0 && !blockedBySensitiveDefaults,
      ready: missingFields.length === 0 && warningSet.length === 0 && !blockedBySensitiveDefaults,
      requiresConfirmation: true,
      actionToolName: ${serializeJsValue(block.candidate.toolName)},
      prepareToolName: ${serializeJsValue(toolName)},
      resourceLookupToolName: ${serializeJsValue(selectedRead.normalizedToolName || '')},
      resourceIdParameter: ${serializeJsValue(resourceIdParameter)},
      selectedResource,
      payload,
      missingFields,
      warnings: warningSet,
      sensitiveFieldStatus,
      resolvedFields,
      confirmedActionArgs,
      lookup: lookupResult ? {
        ok: lookupResult.ok,
        status: lookupResult.status,
        url: lookupResult.url,
        totalItems: lookupResult.totalItems,
        returnedCount: lookupItems.length,
        mapping: lookupResult.mapping,
      } : null,
    };
  }`)
    functionSources.push(`  async function ${planFunctionName}(args = {}) {
    const {
      instruction = '',
      resourceQuery = '',
      availabilitySlot = '',
      startTime = '',
      endTime = '',
      lookupArgs = {},
      actionOverrides = {},
      requireAvailable = true,
      limit = 5,
    } = args || {};
    const extracted = extractGenericActionIntent(String(instruction || ''));
    const actionArgs = {
      ...normalizePlainObjectArg(actionOverrides),
    };
    const fieldSources = {};
    const normalizedLookupArgs = normalizePlainObjectArg(lookupArgs);
    const resolvedStartTime = startTime || extracted.startTime || '';
    const resolvedEndTime = endTime || extracted.endTime || '';
    const resolvedAvailabilitySlot = availabilitySlot || toAvailabilitySlot(resolvedStartTime) || '';
    const resolvedResourceQuery = resourceQuery || extracted.resourceQuery || '';
    if (resolvedStartTime && ${serializeJsValue(startTimeField)}) {
      actionArgs[${serializeJsValue(startTimeField)}] = resolvedStartTime;
      fieldSources[${serializeJsValue(startTimeField)}] = startTime ? 'explicit_plan_arg' : 'instruction_extract';
    }
    if (resolvedEndTime && ${serializeJsValue(endTimeField)}) {
      actionArgs[${serializeJsValue(endTimeField)}] = resolvedEndTime;
      fieldSources[${serializeJsValue(endTimeField)}] = endTime ? 'explicit_plan_arg' : 'instruction_extract';
    }
    if (resolvedStartTime && ${serializeJsValue(lookupDateField)} && !hasMeaningfulValue(normalizedLookupArgs[${serializeJsValue(lookupDateField)}])) {
      const derivedLookupDateValue = deriveLookupDateValue(${serializeJsValue(lookupDateField)}, resolvedStartTime);
      if (hasMeaningfulValue(derivedLookupDateValue)) {
        normalizedLookupArgs[${serializeJsValue(lookupDateField)}] = derivedLookupDateValue;
      }
    }

    const prepared = await ${functionName}({
      ...actionArgs,
      resourceQuery: resolvedResourceQuery,
      availabilitySlot: resolvedAvailabilitySlot,
      lookupArgs: normalizedLookupArgs,
      requireAvailable,
      limit,
      __fieldSources: fieldSources,
    });

    return {
      ...prepared,
      planToolName: ${serializeJsValue(planToolName)},
      sourceInstruction: instruction,
      extractedIntent: {
        resourceQuery: resolvedResourceQuery,
        availabilitySlot: resolvedAvailabilitySlot,
        startTime: resolvedStartTime,
        endTime: resolvedEndTime,
      },
      nextStep: prepared.ready
        ? 'review_payload_and_confirm_before_calling_action_tool'
        : 'resolve_missing_fields_or_warnings_before_confirmation',
    };
  }`)
    toolDefinitions.push(`      {
        name: ${serializeJsValue(toolName)},
        description: ${serializeJsValue(`Prepares a confirmation payload for ${block.candidate.toolName} by optionally resolving a resource through ${selectedRead.normalizedToolName}. This tool does not submit the side-effecting action.`)},
        parameters: ${JSON.stringify(schema, null, 8)},
        handler: (args) => ${functionName}(args || {}),
      }`)
    toolDefinitions.push(`      {
        name: ${serializeJsValue(planToolName)},
        description: ${serializeJsValue(`Plans ${block.candidate.toolName} from a natural-language instruction, then prepares a confirmation payload without submitting the side-effecting action.`)},
        parameters: ${JSON.stringify(planSchema, null, 8)},
        handler: (args) => ${planFunctionName}(args || {}),
      }`)
  }

  if (toolDefinitions.length === 0) return null

  return {
    functionSource: functionSources.join('\n\n'),
    toolDefinitions,
    toolNames,
  }
}

function buildPrepareActionToolSchema(defaults: Record<string, unknown>, resourceIdParameter: string): Record<string, unknown> {
  const base = stripSchemaDefaults(buildActionToolSchema(defaults)) as {
    type: string
    properties: Record<string, unknown>
    required: string[]
  }
  return {
    ...base,
    properties: {
      ...base.properties,
      resourceQuery: {
        type: 'string',
        description: 'Optional query matched against normalized resource id/display fields before preparing the action payload.',
        default: '',
      },
      resourceId: {
        type: 'string',
        description: `Optional explicit resource id. When provided, it is copied into ${resourceIdParameter} unless that action field is already set.`,
        default: '',
      },
      availabilitySlot: {
        type: 'string',
        description: 'Optional availability slot key to validate before preparing the action payload.',
        default: '',
      },
      lookupArgs: {
        type: 'object',
        description: 'Optional arguments passed through to the generated resource lookup tool.',
        default: {},
      },
      requireAvailable: {
        type: 'boolean',
        description: 'When true, availabilitySlot lookup only accepts resources that look available.',
        default: true,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of normalized lookup resources to inspect.',
        default: 5,
      },
    },
    required: [],
  }
}

function buildPlanActionToolSchema(defaults: Record<string, unknown>): Record<string, unknown> {
  const actionSchema = stripSchemaDefaults(buildActionToolSchema(defaults)) as {
    properties: Record<string, unknown>
  }
  return {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'Natural-language instruction to plan from. The generated planner only extracts generic resource and time hints.',
        default: '',
      },
      resourceQuery: {
        type: 'string',
        description: 'Optional explicit resource query. Overrides resource words inferred from instruction.',
        default: '',
      },
      availabilitySlot: {
        type: 'string',
        description: 'Optional explicit availability slot key. Overrides inferred start-time slot.',
        default: '',
      },
      startTime: {
        type: 'string',
        description: 'Optional explicit start time to copy into the action payload when a matching action field exists.',
        default: '',
      },
      endTime: {
        type: 'string',
        description: 'Optional explicit end time to copy into the action payload when a matching action field exists.',
        default: '',
      },
      lookupArgs: {
        type: 'object',
        description: 'Optional arguments passed through to the generated resource lookup tool.',
        default: {},
      },
      actionOverrides: {
        type: 'object',
        description: 'Optional action field overrides merged into the prepared payload.',
        default: {},
        properties: actionSchema.properties,
      },
      requireAvailable: {
        type: 'boolean',
        description: 'When true, availabilitySlot lookup only accepts resources that look available.',
        default: true,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of normalized lookup resources to inspect.',
        default: 5,
      },
    },
    required: ['instruction'],
  }
}

function selectSemanticReadCandidate(actionCandidates: SelectedActionCandidate[]): SelectedActionCandidate | null {
  return actionCandidates.find((candidate) => canBuildNormalizedReadTool(candidate)) || null
}

function hasAvailabilityHints(candidate: SelectedActionCandidate): boolean {
  const hints = candidate.responseHints
  return Boolean(hints?.preferredAvailabilityKey || (hints?.availabilityLikeKeys?.length || 0) > 0)
}

function buildSemanticListResourcesSchema(candidate: SelectedActionCandidate): Record<string, unknown> {
  const defaults = deriveActionCandidateDefaults(candidate).defaults
  const base = buildNormalizedActionToolSchema(defaults) as {
    type: string
    properties: Record<string, unknown>
    required: string[]
  }
  const properties = { ...base.properties }
  delete properties.onlyAvailable
  return {
    ...base,
    properties,
    required: [],
  }
}

function buildSemanticFindAvailableSchema(candidate: SelectedActionCandidate): Record<string, unknown> {
  const defaults = deriveActionCandidateDefaults(candidate).defaults
  const base = buildNormalizedActionToolSchema(defaults) as {
    type: string
    properties: Record<string, unknown>
    required: string[]
  }
  return {
    ...base,
    required: ['availabilitySlot'],
  }
}

function isOptionalDefaultValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function candidateKey(candidate: SiteApiCandidate): string {
  return `${(candidate.method || 'GET').toUpperCase()} ${stripTrailingPunctuation(candidate.url)}`
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[，。；）)\],]+$/g, '')
}

function hasQueryParams(input: string): boolean {
  try {
    const parsed = new URL(input)
    return [...parsed.searchParams.keys()].length > 0
  } catch {
    return false
  }
}

function coerceStringValue(value: string): string | number {
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function toSafeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function toSafeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_$]+/g, '_').replace(/^[^a-zA-Z_$]+/, '_')
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function serializeJsValue(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
