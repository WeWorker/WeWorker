import fs from 'node:fs';
import path from 'node:path';
import { resolveAdaptersDir } from './paths.js';
import {
    buildApiSourceEvidence,
    normalizeRequestBodyEvidence,
    normalizeResponseBodyEvidence
} from './generation-harness/source-evidence.js';
const log = {
    info () {}
};
const DEFAULT_ADAPTER_ROOT = resolveAdaptersDir();
const GENERATED_SUBDIR = 'webcli-generated';
export function writeScaffoldFromSiteMemory(memory, options = {}) {
    memory = sanitizeScaffoldMemory(memory);
    const adapterRoot = options.outputRoot ?? DEFAULT_ADAPTER_ROOT;
    const adapterDir = path.join(adapterRoot, memory.siteKey);
    const generatedDir = path.join(adapterDir, GENERATED_SUBDIR);
    const safeSiteToken = toSafeFileToken(memory.siteKey);
    const sharedRuntimeRel = `${GENERATED_SUBDIR}/shared/${safeSiteToken}.runtime.generated.js`;
    const supportFileRel = `${GENERATED_SUBDIR}/${safeSiteToken}.site-entry.generated.js`;
    const indexSnippetRel = `${GENERATED_SUBDIR}/${safeSiteToken}.index-snippet.generated.txt`;
    const guideRel = `${GENERATED_SUBDIR}/${safeSiteToken}.integration.generated.md`;
    const sharedRuntimePath = path.join(adapterDir, sharedRuntimeRel);
    const supportFilePath = path.join(adapterDir, supportFileRel);
    const indexSnippetPath = path.join(adapterDir, indexSnippetRel);
    const integrationGuidePath = path.join(adapterDir, guideRel);
    const skillPath = path.join(adapterDir, 'SKILL.md');
    const generatedSkillPath = path.join(adapterDir, 'SKILL.generated.md');
    const knowledgeJsonPath = path.join(adapterDir, 'WEBCLI_KNOWLEDGE.json');
    const knowledgeMarkdownPath = path.join(adapterDir, 'WEBCLI_KNOWLEDGE.md');
    const manifestPath = path.join(adapterDir, 'manifest.json');
    const indexPath = path.join(adapterDir, 'index.js');
    const discoveryIndexPath = path.join(adapterRoot, 'index.json');
    const updateManifest = options.updateManifest ?? true;
    const existing = detectExistingAdapterState(adapterDir, manifestPath, indexPath);
    const mode = existing.indexExists || existing.manifestExists ? 'augment_existing_adapter' : 'bootstrap_adapter_draft';
    fs.mkdirSync(generatedDir, {
        recursive: true
    });
    const initialActionCandidates = selectActionCandidates(memory);
    const { primary, secondary } = selectApis(memory, initialActionCandidates);
    const semanticConfig = buildScaffoldSemanticConfig(memory, {
        hasPrimary: Boolean(primary),
        hasSecondary: Boolean(primary && secondary),
        actionCandidates: initialActionCandidates
    });
    const actionCandidates = applySemanticToolNamesToCandidates(initialActionCandidates, semanticConfig);
    const primaryToolName = primary ? semanticConfig.getToolName(`${memory.siteKey}.search_records`) : '';
    const secondaryToolName = primary && secondary ? semanticConfig.getToolName(`${memory.siteKey}.fetch_summary_groups`) : '';
    const detailToolName = semanticConfig.getToolName(`${memory.siteKey}.list_detail_candidates`);
    if (!primary && actionCandidates.length === 0) {
        throw new Error(`no reusable list or action api candidates available for ${memory.siteKey}`);
    }
    const generationStrategy = primary ? actionCandidates.length > 0 ? 'hybrid' : 'list_only' : 'action_only';
    const includeDetailHints = hasUsefulDetailHints(memory);
    const normalizedActionToolNames = collectNormalizedActionToolNames(memory.siteKey, actionCandidates);
    const semanticToolNames = collectSemanticReadToolNames(memory.siteKey, actionCandidates);
    const toolNames = buildGeneratedToolNames(memory.siteKey, {
        hasPrimary: Boolean(primary),
        hasSecondary: Boolean(primary && secondary),
        includeDetailHints,
        actionCandidates,
        normalizedActionToolNames,
        semanticToolNames,
        primaryToolName,
        secondaryToolName,
        detailToolName
    });
    const supportBundle = buildSupportBundle(memory, {
        adapterDir,
        sharedRuntimeRel,
        supportFileRel,
        primary,
        secondary,
        includeDetailHints,
        actionCandidates,
        semanticConfig,
        primaryToolName,
        secondaryToolName,
        detailToolName
    });
    const retainedGeneratedToolSupportFiles = collectRetainedGeneratedToolSupportFiles(manifestPath, adapterDir, supportBundle.supportFiles);
    const finalToolNames = mergeToolNamesWithRetainedGeneratedTools(memory.siteKey, toolNames, retainedGeneratedToolSupportFiles);
    const finalSupportFiles = mergeSupportFilesWithRetainedGeneratedTools(supportBundle.supportFiles, retainedGeneratedToolSupportFiles, supportFileRel);
    supportBundle.entryFile.content = buildSiteEntryFile(memory, finalToolNames, supportBundle.actionHints);
    const indexSnippet = buildIndexSnippet(memory.siteKey);
    const integrationGuide = buildIntegrationGuide(memory, {
        supportFiles: finalSupportFiles,
        supportFileRel,
        indexSnippetRel,
        manifestPath: 'manifest.json',
        indexPath: 'index.js',
        toolNames: finalToolNames,
        primary,
        secondary,
        actionCandidates,
        mode,
        generationStrategy
    });
    fs.mkdirSync(path.dirname(sharedRuntimePath), {
        recursive: true
    });
    fs.writeFileSync(sharedRuntimePath, `${supportBundle.sharedRuntime.content}\n`, 'utf8');
    for (const toolFile of supportBundle.toolFiles){
        fs.mkdirSync(path.dirname(toolFile.absPath), {
            recursive: true
        });
        fs.writeFileSync(toolFile.absPath, `${toolFile.content}\n`, 'utf8');
    }
    fs.writeFileSync(supportFilePath, `${supportBundle.entryFile.content}\n`, 'utf8');
    fs.writeFileSync(indexSnippetPath, `${indexSnippet}\n`, 'utf8');
    fs.writeFileSync(integrationGuidePath, `${integrationGuide}\n`, 'utf8');
    const removedGeneratedFiles = cleanupGeneratedArtifacts(adapterDir, generatedDir, [
        ...finalSupportFiles,
        indexSnippetRel,
        guideRel
    ]);
    const manifestUpdated = ensureAdapterManifest(memory, manifestPath, finalSupportFiles, finalToolNames, updateManifest, semanticConfig);
    const manifest = readManifestOrDefault(memory, manifestPath, semanticConfig);
    const skillContent = buildAdapterSkillMarkdown(memory, manifest, supportBundle);
    const skillAlreadyExists = fs.existsSync(skillPath);
    const skillWritePath = skillAlreadyExists ? generatedSkillPath : skillPath;
    fs.writeFileSync(skillWritePath, `${skillContent}\n`, 'utf8');
    const knowledgePack = buildWebCliKnowledgePack(memory, {
        manifest,
        toolNames: finalToolNames,
        primary,
        secondary,
        actionCandidates,
        supportBundle,
        mode,
        generationStrategy,
        semanticConfig
    });
    const mergedKnowledgePack = mergeWebCliKnowledgePack(readExistingWebCliKnowledgePack(knowledgeJsonPath), knowledgePack);
    fs.writeFileSync(knowledgeJsonPath, `${JSON.stringify(mergedKnowledgePack, null, 2)}\n`, 'utf8');
    fs.writeFileSync(knowledgeMarkdownPath, `${buildWebCliKnowledgeMarkdown(mergedKnowledgePack)}\n`, 'utf8');
    ensureAdapterIndexShell(memory, indexPath, existing.indexExists);
    const indexCatalogUpdated = ensureAdapterIndexCatalog(adapterRoot, memory.siteKey);
    log.info('adapter scaffold generated', {
        siteKey: memory.siteKey,
        adapterDir,
        mode,
        generationStrategy,
        supportFiles: finalSupportFiles,
        manifestUpdated,
        indexCatalogUpdated
    });
    return {
        siteKey: memory.siteKey,
        adapterDir,
        generatedDir,
        mode,
        generationStrategy,
        files: {
            manifest: manifestPath,
            adapterIndex: indexPath,
            supportFile: supportFilePath,
            sharedRuntime: sharedRuntimePath,
            indexSnippet: indexSnippetPath,
            integrationGuide: integrationGuidePath,
            skill: skillPath,
            generatedSkill: skillAlreadyExists ? generatedSkillPath : '',
            writtenSkill: skillWritePath,
            knowledgeJson: knowledgeJsonPath,
            knowledgeMarkdown: knowledgeMarkdownPath,
            discoveryIndex: discoveryIndexPath
        },
        skillPreserved: skillAlreadyExists,
        toolNames: finalToolNames,
        primaryListApiUrl: primary?.url || '',
        secondaryApiUrl: secondary?.url || '',
        actionApiUrls: actionCandidates.map((candidate)=>candidate.url),
        manifestUpdated,
        indexCatalogUpdated,
        supportFiles: finalSupportFiles,
        indexSnippet,
        semanticEnhancement: semanticConfig.summary,
        removedGeneratedFiles
    };
}
function detectExistingAdapterState(adapterDir, manifestPath, indexPath) {
    return {
        exists: fs.existsSync(adapterDir),
        manifestExists: fs.existsSync(manifestPath),
        indexExists: fs.existsSync(indexPath)
    };
}
function ensureAdapterManifest(memory, manifestPath, supportFileRels, toolNames, shouldWrite, semanticConfig) {
    const manifest = readManifestOrDefault(memory, manifestPath, semanticConfig);
    const currentSupportFiles = Array.isArray(manifest.support_files) ? manifest.support_files.filter((item)=>typeof item === 'string') : [];
    const preservedSupportFiles = currentSupportFiles.filter((item)=>!item.startsWith(`${GENERATED_SUBDIR}/`));
    const nextSupportFiles = Array.from(new Set([
        ...preservedSupportFiles,
        ...supportFileRels
    ]));
    const currentToolExecution = manifest.tool_execution && typeof manifest.tool_execution === 'object'
        ? manifest.tool_execution
        : {};
    const nextToolExecution = { ...currentToolExecution };
    for (const toolName of toolNames || []){
        if (!toolName || nextToolExecution[toolName]) continue;
        nextToolExecution[toolName] = { type: 'api', runtime: 'background' };
    }
    const changed = !arraysEqual(currentSupportFiles, nextSupportFiles)
        || JSON.stringify(currentToolExecution) !== JSON.stringify(nextToolExecution)
        || !fs.existsSync(manifestPath);
    manifest.support_files = nextSupportFiles;
    manifest.tool_execution = nextToolExecution;
    if (changed && shouldWrite) {
        fs.mkdirSync(path.dirname(manifestPath), {
            recursive: true
        });
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    return changed && shouldWrite;
}
function collectRetainedGeneratedToolSupportFiles(manifestPath, adapterDir, currentSupportFiles) {
    let currentManifestSupportFiles = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        currentManifestSupportFiles = Array.isArray(parsed?.support_files) ? parsed.support_files.filter((item)=>typeof item === 'string') : [];
    } catch  {
        return [];
    }
    const current = new Set(currentSupportFiles.map((item)=>normalizeRelPath(item)));
    return currentManifestSupportFiles.map((item)=>normalizeRelPath(item)).filter((item)=>item.startsWith(`${GENERATED_SUBDIR}/tools/`) && item.endsWith('.generated.js')).filter((item)=>!current.has(item)).filter((item)=>fs.existsSync(path.join(adapterDir, item)));
}
function mergeSupportFilesWithRetainedGeneratedTools(currentSupportFiles, retainedGeneratedToolSupportFiles, entryFileRel) {
    const entry = normalizeRelPath(entryFileRel);
    const result = [];
    const append = (item)=>{
        const normalized = normalizeRelPath(item);
        if (!normalized || result.includes(normalized)) return;
        result.push(normalized);
    };
    for (const item of currentSupportFiles){
        const normalized = normalizeRelPath(item);
        if (normalized && normalized !== entry) append(normalized);
    }
    for (const item of retainedGeneratedToolSupportFiles){
        append(item);
    }
    append(entry);
    return result;
}
function mergeToolNamesWithRetainedGeneratedTools(siteKey, currentToolNames, retainedGeneratedToolSupportFiles) {
    const retainedToolNames = retainedGeneratedToolSupportFiles.map((item)=>generatedToolNameFromSupportFile(siteKey, item)).filter(Boolean);
    return Array.from(new Set([
        ...currentToolNames,
        ...retainedToolNames
    ]));
}
function generatedToolNameFromSupportFile(siteKey, relPath) {
    const normalized = normalizeRelPath(relPath);
    const prefix = `${GENERATED_SUBDIR}/tools/`;
    const suffix = '.generated.js';
    if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) return '';
    const localName = normalized.slice(prefix.length, -suffix.length);
    return localName ? `${siteKey}.${localName}` : '';
}
function readManifestOrDefault(memory, manifestPath, semanticConfig) {
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    } catch  {}
    return {
        id: memory.siteKey,
        name: memory.siteHost,
        description: semanticConfig?.manifestDescription || `基于站点记忆生成的 ${memory.siteHost} 适配器骨架`,
        match: [
            memory.siteHost
        ],
        homepage_url: memory.canonicalEntryUrl || memory.siteOrigin,
        requires_auth: true,
        auth_check_tool: memory.siteHost.endsWith('.example.com') ? 'login.example.com.check_login_status' : undefined,
        version: memory.updatedAt,
        author: 'site-memory-scaffold',
        quick_prompts: buildQuickPrompts(memory, semanticConfig),
        generated_from: {
            source: 'site_memory',
            workflow_version: memory.workflowVersion,
            generated_at: new Date().toISOString(),
            recommended_strategy: memory.recommendedStrategy
        }
    };
}
function ensureAdapterIndexShell(memory, indexPath, alreadyExists) {
    if (alreadyExists) return;
    const content = `/**
 * 为 ${memory.siteKey} 自动生成的适配器壳文件
 *
 * 当前站点之前没有 index.js，所以先生成这个最小壳层。
 * 后续可以继续补充站点专属工具，同时保留 generated support tools 的挂载。
 */

window.__webmcpRegister({
  name: ${serializeJsValue(`generated-${memory.siteKey}-adapter`)},
  match: ${serializeJsValue([
        memory.siteHost
    ])},
  tools: [
    ...(window.__webmcpGeneratedSupport?.[${serializeJsValue(memory.siteKey)}]?.tools || []),
  ],
})
`;
    fs.mkdirSync(path.dirname(indexPath), {
        recursive: true
    });
    fs.writeFileSync(indexPath, content, 'utf8');
}
function ensureAdapterIndexCatalog(adapterRoot, siteKey) {
    const catalogPath = path.join(adapterRoot, 'index.json');
    const currentIds = readAdapterIndexCatalog(catalogPath);
    const nextIds = Array.from(new Set([
        ...currentIds,
        siteKey
    ])).sort((left, right)=>left.localeCompare(right));
    if (arraysEqual(currentIds, nextIds) && fs.existsSync(catalogPath)) return false;
    fs.mkdirSync(path.dirname(catalogPath), {
        recursive: true
    });
    fs.writeFileSync(catalogPath, `${JSON.stringify(nextIds, null, 2)}\n`, 'utf8');
    return true;
}
function readAdapterIndexCatalog(catalogPath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        if (Array.isArray(parsed)) {
            return parsed.filter((item)=>typeof item === 'string');
        }
    } catch  {}
    return [];
}
function cleanupGeneratedArtifacts(adapterDir, generatedDir, expectedRelFiles) {
    const expected = new Set(expectedRelFiles.map((item)=>normalizeRelPath(item)).filter(Boolean));
    const removed = [];
    if (!fs.existsSync(generatedDir)) return removed;
    for (const absPath of walkFilesRecursively(generatedDir)){
        const relPath = normalizeRelPath(path.relative(adapterDir, absPath));
        if (!expected.has(relPath)) {
            fs.rmSync(absPath, {
                force: true
            });
            removed.push(relPath);
        }
    }
    pruneEmptyDirectories(generatedDir);
    return removed.sort((left, right)=>left.localeCompare(right));
}
function walkFilesRecursively(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    const result = [];
    for (const entry of fs.readdirSync(dirPath, {
        withFileTypes: true
    })){
        const absPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            result.push(...walkFilesRecursively(absPath));
        } else if (entry.isFile()) {
            result.push(absPath);
        }
    }
    return result;
}
function pruneEmptyDirectories(dirPath) {
    if (!fs.existsSync(dirPath)) return false;
    for (const entry of fs.readdirSync(dirPath, {
        withFileTypes: true
    })){
        if (!entry.isDirectory()) continue;
        pruneEmptyDirectories(path.join(dirPath, entry.name));
    }
    const remaining = fs.readdirSync(dirPath);
    if (remaining.length === 0) {
        fs.rmdirSync(dirPath);
        return true;
    }
    return false;
}
function normalizeRelPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}
function buildScaffoldSemanticConfig(memory, context = {}) {
    const raw = memory?.scaffoldSemanticHints && typeof memory.scaffoldSemanticHints === 'object' ? memory.scaffoldSemanticHints : {};
    const siteKey = memory.siteKey;
    const toolOverrides = new Map();
    for (const item of Array.isArray(raw.toolOverrides) ? raw.toolOverrides : []){
        const sourceToolName = safeString(item?.sourceToolName);
        if (!sourceToolName) continue;
        toolOverrides.set(sourceToolName, {
            toolName: normalizeSemanticToolName(item?.toolName, siteKey, sourceToolName),
            description: safeString(item?.description),
            parameterDescriptions: normalizeSemanticParameterDescriptions(item?.parameterDescriptions),
            parameterUiHints: normalizeSemanticParameterUiHints(item?.parameterUiHints)
        });
    }
    const manifestDescription = safeString(raw.manifestDescription);
    const quickPrompts = Array.isArray(raw.quickPrompts) ? raw.quickPrompts.map((item)=>safeString(item)).filter(Boolean).slice(0, 3) : [];
    const uiHintCount = [...toolOverrides.values()].reduce((sum, item)=>sum + Object.keys(item.parameterUiHints || {}).length, 0);
    return {
        manifestDescription,
        quickPrompts,
        getToolOverride (sourceToolName) {
            return toolOverrides.get(sourceToolName) || null;
        },
        getToolName (sourceToolName) {
            return toolOverrides.get(sourceToolName)?.toolName || sourceToolName;
        },
        getDescription (sourceToolName, fallback) {
            return toolOverrides.get(sourceToolName)?.description || fallback;
        },
        applyParameterDescriptions (sourceToolName, schema) {
            return applySemanticParameterDescriptions(schema, toolOverrides.get(sourceToolName)?.parameterDescriptions);
        },
        summary: {
            analysisSource: safeString(raw.analysisSource) || 'heuristic',
            provider: safeString(raw.provider),
            model: safeString(raw.model),
            toolOverrideCount: toolOverrides.size,
            uiHintCount,
            quickPromptCount: quickPrompts.length,
            manifestDescriptionApplied: Boolean(manifestDescription)
        }
    };
}
function normalizeSemanticToolName(value, siteKey, fallback) {
    const raw = safeString(value);
    if (!raw) return fallback;
    const prefix = `${siteKey}.`;
    const local = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.includes('.') ? raw.split('.').slice(1).join('.') : raw;
    const sanitizedLocal = local.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return sanitizedLocal ? `${siteKey}.${sanitizedLocal}` : fallback;
}
function normalizeSemanticParameterDescriptions(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([key, item])=>[
            safeString(key),
            safeString(item)
        ]).filter(([key, item])=>Boolean(key && item)));
}
function applySemanticParameterDescriptions(schema, parameterDescriptions) {
    if (!schema || typeof schema !== 'object' || !parameterDescriptions || Object.keys(parameterDescriptions).length === 0) {
        return schema;
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (!properties) return schema;
    const nextProperties = {};
    for (const [key, value] of Object.entries(properties)){
        const description = parameterDescriptions[key];
        nextProperties[key] = description ? {
            ...value,
            description
        } : value;
    }
    return {
        ...schema,
        properties: nextProperties
    };
}
function normalizeSemanticParameterUiHints(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([key, item])=>[
            safeString(key),
            normalizeSemanticUiHint(item)
        ]).filter(([key, item])=>Boolean(key && item)));
}
function normalizeSemanticUiHint(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const widget = safeString(value.widget).toLowerCase();
    const allowedWidgets = new Set([
        'text',
        'textarea',
        'date',
        'time',
        'datetime',
        'number',
        'boolean'
    ]);
    if (!allowedWidgets.has(widget)) return null;
    return {
        widget,
        placeholder: safeString(value.placeholder),
        example: safeString(value.example)
    };
}
function applySemanticParameterUiHints(schema, parameterUiHints) {
    if (!schema || typeof schema !== 'object' || !parameterUiHints || Object.keys(parameterUiHints).length === 0) {
        return schema;
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (!properties) return schema;
    const nextProperties = {};
    for (const [key, value] of Object.entries(properties)){
        const hint = parameterUiHints[key];
        nextProperties[key] = hint ? {
            ...value,
            'x-ui': hint
        } : value;
    }
    return {
        ...schema,
        properties: nextProperties
    };
}
function applySemanticToolNamesToCandidates(candidates, semanticConfig) {
    return candidates.map((candidate)=>{
        const sourceToolName = candidate.toolName;
        const semanticToolName = semanticConfig.getToolName(sourceToolName);
        return {
            ...candidate,
            sourceToolName,
            toolName: semanticToolName === sourceToolName ? toUserFacingGeneratedToolName(sourceToolName) : semanticToolName
        };
    });
}
function toUserFacingGeneratedToolName(toolName) {
    const value = safeString(toolName);
    if (!value) return value;
    return value.replace(/_draft$/, '');
}
function buildSupportBundle(memory, context) {
    const toolModules = [];
    const semanticReadCandidate = selectSemanticReadCandidate(context.actionCandidates);
    const actionHintRegistry = buildActionHintRegistry(memory.siteKey, context.actionCandidates, semanticReadCandidate);
    const toolNames = buildGeneratedToolNames(memory.siteKey, {
        hasPrimary: Boolean(context.primary),
        hasSecondary: Boolean(context.primary && context.secondary),
        includeDetailHints: context.includeDetailHints,
        actionCandidates: context.actionCandidates,
        normalizedActionToolNames: collectNormalizedActionToolNames(memory.siteKey, context.actionCandidates),
        semanticToolNames: collectSemanticReadToolNames(memory.siteKey, context.actionCandidates),
        primaryToolName: context.primaryToolName,
        secondaryToolName: context.secondaryToolName,
        detailToolName: context.detailToolName
    });
    toolModules.push(buildLoginStatusToolModule(memory.siteKey));
    if (context.primary) {
        toolModules.push(buildListToolModule({
            siteKey: memory.siteKey,
            candidate: context.primary,
            toolName: context.primaryToolName || `${memory.siteKey}.search_records`,
            description: context.semanticConfig.getDescription(`${memory.siteKey}.search_records`, `主列表/搜索工具，基于已捕获接口 ${context.primary.url} 生成。当前这是站点记忆里最强的可复用列表接口。`),
            parameterDescriptions: context.semanticConfig.getToolOverride(`${memory.siteKey}.search_records`)?.parameterDescriptions || {},
            parameterUiHints: context.semanticConfig.getToolOverride(`${memory.siteKey}.search_records`)?.parameterUiHints || {}
        }));
    }
    if (context.primary && context.secondary) {
        toolModules.push(buildListToolModule({
            siteKey: memory.siteKey,
            candidate: context.secondary,
            toolName: context.secondaryToolName || `${memory.siteKey}.fetch_summary_groups`,
            description: context.semanticConfig.getDescription(`${memory.siteKey}.fetch_summary_groups`, `摘要/分组辅助工具，基于已捕获接口 ${context.secondary.url} 生成。适合补充探索阶段发现的相关列表或分组数据。`),
            parameterDescriptions: context.semanticConfig.getToolOverride(`${memory.siteKey}.fetch_summary_groups`)?.parameterDescriptions || {},
            parameterUiHints: context.semanticConfig.getToolOverride(`${memory.siteKey}.fetch_summary_groups`)?.parameterUiHints || {}
        }));
    }
    for (const candidate of context.actionCandidates){
        toolModules.push(...buildActionToolModules(memory.siteKey, candidate, context.semanticConfig));
    }
    if (semanticReadCandidate) {
        toolModules.push(...buildSemanticToolModules(memory.siteKey, semanticReadCandidate, context.semanticConfig));
    }
    if (context.includeDetailHints) {
        toolModules.push(buildDetailHintsToolModule(memory, context.detailToolName, context.semanticConfig));
    }
    const orderedToolFiles = toolNames.map((toolName)=>toolModules.find((module)=>module.toolName === toolName)).filter((module)=>Boolean(module)).map((module)=>({
            relPath: module.relPath,
            absPath: path.join(context.adapterDir, module.relPath),
            content: module.content,
            toolDefinition: module.toolDefinition || null
        }));
    const sharedRuntime = {
        relPath: context.sharedRuntimeRel,
        absPath: path.join(context.adapterDir, context.sharedRuntimeRel),
        content: buildSharedRuntimeFile()
    };
    const entryFile = {
        relPath: context.supportFileRel,
        absPath: path.join(context.adapterDir, context.supportFileRel),
        content: buildSiteEntryFile(memory, toolNames, actionHintRegistry)
    };
    return {
        sharedRuntime,
        toolFiles: orderedToolFiles,
        entryFile,
        actionHints: actionHintRegistry,
        supportFiles: [
            sharedRuntime.relPath,
            ...orderedToolFiles.map((file)=>file.relPath),
            entryFile.relPath
        ]
    };
}
function buildSharedRuntimeFile() {
    return `/**
 * Shared generated runtime helpers
 *
 * Injected before generated tool modules.
 */

(function initGeneratedRuntime() {
  const runtime = window.__webmcpGeneratedRuntime || (window.__webmcpGeneratedRuntime = {});
  const globalStore = window.__webmcpGeneratedSupport || (window.__webmcpGeneratedSupport = {});

  function ensureSiteStore(siteKey) {
    if (!globalStore[siteKey]) {
      globalStore[siteKey] = {
        source: 'site_memory',
        workflowVersion: '',
        toolNames: [],
        actionHints: {},
        tools: [],
      };
    }
    return globalStore[siteKey];
  }

  function resetSiteStore(siteKey) {
    if (typeof siteKey !== 'string' || !siteKey.trim()) return;
    delete globalStore[siteKey];
  }

  function registerTool(siteKey, toolDefinition) {
    const siteStore = ensureSiteStore(siteKey);
    const existing = siteStore.tools.find((item) => item?.name === toolDefinition?.name);
    if (existing) return existing;
    siteStore.tools.push(toolDefinition);
    return toolDefinition;
  }

  async function invokeTool(siteKey, toolName, args = {}) {
    const siteStore = ensureSiteStore(siteKey);
    const tool = siteStore.tools.find((item) => item?.name === toolName);
    if (!tool || typeof tool.handler !== 'function') {
      throw new Error(\`Generated tool not found: \${toolName}\`);
    }
    return tool.handler(args || {});
  }

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

  Object.assign(runtime, {
    __initialized: true,
    ensureSiteStore,
    resetSiteStore,
    registerTool,
    invokeTool,
    parseMaybeJson,
    hasOwnKey,
    hasMeaningfulValue,
    sameStructuredValue,
    isPlainObject,
    cloneStructuredValue,
    normalizeValueAgainstDefault,
    normalizeArgsWithDefaults,
    normalizePlainObjectArg,
    encodeFormBody,
    fetchGet,
    postForm,
    sendJson,
    checkLoginStatus,
    toAvailabilitySlot,
    formatLocalDate,
    withDayOffset,
    resolveDateLabel,
    normalizeClockToken,
    extractGenericActionIntent,
    deriveLookupDateValue,
    getByPath,
    summarizeAvailability,
    normalizeListItems,
  });
})();
`;
}
function buildSiteEntryFile(memory, toolNames, actionHintRegistry) {
    return `/**
 * Generated site entry for ${memory.siteKey}
 */

(function initGeneratedSiteEntry() {
  const runtime = window.__webmcpGeneratedRuntime;
  if (!runtime) {
    throw new Error('Generated runtime not initialized before site entry injection');
  }

  const siteStore = runtime.ensureSiteStore(${serializeJsValue(memory.siteKey)});
  siteStore.source = 'site_memory';
  siteStore.workflowVersion = ${serializeJsValue(memory.workflowVersion)};
  siteStore.toolNames = ${serializeJsValue(toolNames)};
  siteStore.actionHints = ${serializeJsValue(actionHintRegistry)};

  const orderMap = new Map(siteStore.toolNames.map((name, index) => [name, index]));
  siteStore.tools.sort((left, right) => {
    const leftOrder = orderMap.has(left?.name) ? orderMap.get(left.name) : Number.MAX_SAFE_INTEGER;
    const rightOrder = orderMap.has(right?.name) ? orderMap.get(right.name) : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left?.name || '').localeCompare(String(right?.name || ''));
  });
})();
`;
}
function buildToolModuleRel(siteKey, toolName) {
    const localName = toolName.startsWith(`${siteKey}.`) ? toolName.slice(siteKey.length + 1) : toolName;
    return `${GENERATED_SUBDIR}/tools/${toSafeFileToken(localName)}.generated.js`;
}
function createGeneratedToolModule(siteKey, toolName, functionSource, toolDefinitionSource) {
    const definitionSource = typeof toolDefinitionSource === 'string' ? toolDefinitionSource : toolDefinitionSource.source;
    const toolDefinition = typeof toolDefinitionSource === 'string' ? null : toolDefinitionSource.metadata;
    return {
        toolName,
        relPath: buildToolModuleRel(siteKey, toolName),
        toolDefinition,
        content: `/**
 * Generated tool module for ${toolName}
 */

(function registerGeneratedTool_${toSafeIdentifier(toolName)}() {
  const runtime = window.__webmcpGeneratedRuntime;
  if (!runtime) {
    throw new Error('Generated runtime not initialized before tool module injection');
  }

  const siteKey = ${serializeJsValue(siteKey)};
  const {
    checkLoginStatus,
    cloneStructuredValue,
    deriveLookupDateValue,
    extractGenericActionIntent,
    fetchGet,
    hasMeaningfulValue,
    hasOwnKey,
    invokeTool,
    normalizeArgsWithDefaults,
    normalizeListItems,
    normalizePlainObjectArg,
    postForm,
    registerTool,
    sameStructuredValue,
    sendJson,
    toAvailabilitySlot,
  } = runtime;

${functionSource ? `${functionSource}\n\n` : ''}  registerTool(siteKey, ${definitionSource});
})();
`
    };
}
function buildGeneratedToolDefinitionSource(input) {
    const generationSource = input.generationSource || null;
    const accessSource = input.access ? `\n    access: ${serializeJsValue(input.access)},` : '';
    return {
        source: `{
    name: ${serializeJsValue(input.toolName)},
    description: ${serializeJsValue(input.description)},
    parameters: ${JSON.stringify(input.parameters, null, 6)},${accessSource}
    generationSource: ${serializeJsValue(generationSource)},
    handler: ${input.handlerSource},
  }`,
        metadata: {
            name: input.toolName,
            description: input.description,
            parameters: input.parameters,
            ...(input.access ? { access: input.access } : {}),
            generationSource
        }
    };
}

function structuralScaffoldUrl(input) {
    try {
        const url = new URL(String(input || ''));
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, ':value');
        url.hash = '';
        url.username = '';
        url.password = '';
        return url.toString();
    } catch {
        return safeString(input).split('#', 1)[0];
    }
}

function sanitizeScaffoldCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    const requestEvidence = normalizeRequestBodyEvidence(candidate);
    const responseEvidence = normalizeResponseBodyEvidence(candidate);
    const responseHints = normalizeKnowledgeResponseHints(candidate.responseHints)
        || summarizeKnowledgeResponsePreview(candidate.responsePreview ?? candidate.responseBodyPreview ?? candidate.responseBody);
    const {
        requestBodyPreview,
        requestBody,
        requestHeaders,
        responsePreview,
        responseBodyPreview,
        responseBody,
        ...safeCandidate
    } = candidate;
    return {
        ...safeCandidate,
        url: structuralScaffoldUrl(candidate.url),
        requestEvidence,
        responseEvidence,
        responseHints,
        sourceEvidence: buildApiSourceEvidence({ ...candidate, requestEvidence }, {
            sourceKind: candidate?.actionName ? 'action_capture' : 'passive_list'
        })
    };
}

function sanitizeScaffoldMemory(memory) {
    return {
        ...(memory || {}),
        siteOrigin: structuralScaffoldUrl(memory?.siteOrigin),
        canonicalEntryUrl: structuralScaffoldUrl(memory?.canonicalEntryUrl),
        canonicalResultUrl: structuralScaffoldUrl(memory?.canonicalResultUrl),
        lastSourceUrl: structuralScaffoldUrl(memory?.lastSourceUrl),
        verdictReason: structuralizeUrlsInText(memory?.verdictReason),
        reason: structuralizeUrlsInText(memory?.reason),
        listApiCandidates: (Array.isArray(memory?.listApiCandidates) ? memory.listApiCandidates : []).map(sanitizeScaffoldCandidate),
        actionApiCandidates: (Array.isArray(memory?.actionApiCandidates) ? memory.actionApiCandidates : []).map(sanitizeScaffoldCandidate),
        actionCaptureHistory: (Array.isArray(memory?.actionCaptureHistory) ? memory.actionCaptureHistory : []).map(sanitizeScaffoldCandidate)
    };
}

function structuralizeUrlsInText(value) {
    return safeString(value).replace(/https?:\/\/[^\s，。；）)]+/g, (url)=>structuralScaffoldUrl(url));
}

function resolveGenerationSource(candidate, sourceKind) {
    return /^api-source-v\d+$/.test(String(candidate?.sourceEvidence?.version || ''))
        ? candidate.sourceEvidence
        : buildApiSourceEvidence(candidate, { sourceKind });
}
function buildRequestInvokeLine(input) {
    const method = (input.method || 'POST').toUpperCase();
    if (input.transport === 'get_query') {
        return `    return fetchGet(${serializeJsValue(stripRequestUrlQuery(input.url))}, ${input.payloadRef});`;
    }
    if (input.transport === 'post_form') {
        return `    return postForm(${serializeJsValue(input.url)}, ${input.payloadRef});`;
    }
    return `    return sendJson(${serializeJsValue(input.url)}, ${serializeJsValue(method)}, ${input.payloadRef});`;
}
function buildActionToolDescription(candidate, transport) {
    if (transport === 'get_query') {
        return `读取/查询工具，来自捕获到的 ${candidate.method} ${candidate.url}，动作为 ${candidate.actionName}。可由客户端、Agent 或插件界面传入参数调用。${renderActionResponseHintSentence(candidate)}`;
    }
    return `动作执行工具，来自捕获到的 ${candidate.method} ${candidate.url}，动作为 ${candidate.actionName}。会调用真实业务接口，由当前客户端或 Agent 宿主展示最终参数并请求确认。`;
}
function buildLoginStatusToolModule(siteKey) {
    const toolName = `${siteKey}.check_login_status`;
    return createGeneratedToolModule(siteKey, toolName, '', buildGeneratedToolDefinitionSource({
        toolName,
        description: `登录状态检查工具。用于确认 ${siteKey} 当前页面是否已登录，以及当前会话是否可继续调用站点接口。`,
        parameters: {
            type: 'object',
            properties: {},
            required: []
        },
        generationSource: {
            version: 'api-source-v1',
            fingerprint: '',
            sourceKind: 'utility',
            method: '',
            endpoint: '',
            queryKeys: [],
            bodyKeys: [],
            risk: { level: 'unknown', confidence: 1, evidence: ['login_utility_not_runtime_tested'] }
        },
        handlerSource: '() => checkLoginStatus()'
    }));
}
function buildListToolModule(input) {
    const { siteKey, candidate, toolName, description, parameterDescriptions = {}, parameterUiHints = {} } = input;
    const functionName = `run_${toSafeIdentifier(toolName)}`;
    const { defaults, transport } = deriveCandidateDefaults(candidate);
    const parameterNames = [
        ...Object.keys(defaults),
        ...((candidate.apiEvidence?.queryKeys) || []),
        ...((candidate.apiEvidence?.requestShape?.keys) || []),
        ...((candidate.sourceEvidence?.queryKeys) || []),
        ...((candidate.sourceEvidence?.bodyKeys) || [])
    ].filter((key)=>!isSensitiveKnowledgeKey(key));
    const schema = applySemanticParameterUiHints(buildCapturedFieldsSchema(defaults, '列表请求中的默认字段', parameterDescriptions, parameterNames), parameterUiHints);
    const invokeLine = buildRequestInvokeLine({
        url: candidate.url,
        method: candidate.method,
        transport,
        payloadRef: 'params'
    });
    return createGeneratedToolModule(siteKey, toolName, `  async function ${functionName}(args = {}) {
    const params = {
      ...${serializeJsValue(defaults)},
      ...(args || {}),
    };

${invokeLine}
  }`, buildGeneratedToolDefinitionSource({
        toolName,
        description,
        parameters: schema,
        generationSource: resolveGenerationSource(candidate, 'passive_list'),
        handlerSource: `(args) => ${functionName}(args || {})`
    }));
}
function buildActionToolModules(siteKey, candidate, semanticConfig) {
    const modules = [];
    const { defaults, transport } = deriveActionCandidateDefaults(candidate);
    const sourceToolName = candidate.sourceToolName || candidate.toolName;
    const parameterDescriptions = semanticConfig?.getToolOverride(sourceToolName)?.parameterDescriptions || {};
    const parameterUiHints = semanticConfig?.getToolOverride(sourceToolName)?.parameterUiHints || {};
    const isSideEffectingAction = transport !== 'get_query';
    const baseSchema = isSideEffectingAction
        ? {
            type: 'object',
            properties: {},
            required: [],
            'x-webcli-agent-authored': false
        }
        : buildCapturedFieldsSchema(defaults, '查询参数', parameterDescriptions, candidate?.sourceEvidence?.queryKeys || []);
    const schema = markActionSchemaForConfirmation(applySemanticParameterUiHints(baseSchema, parameterUiHints), candidate, isSideEffectingAction);
    const handlerName = `run_${toSafeIdentifier(candidate.toolName)}`;
    const description = semanticConfig?.getDescription(sourceToolName, buildActionToolDescription(candidate, transport)) || buildActionToolDescription(candidate, transport);
    const functionSource = isSideEffectingAction ? `  async function ${handlerName}(args = {}) {
    const {
      __confirmed = false,
      ...semanticArgs
    } = args || {};
    if (!Boolean(__confirmed)) {
      return {
        ok: false,
        blocked: true,
        requiresConfirmation: true,
        actionToolName: ${serializeJsValue(candidate.toolName)},
        semanticArgs,
        warnings: ['missing_confirmation'],
        confirmationHint: '该工具会触发真实业务动作，请由当前客户端或 Agent 宿主确认参数后再提交。',
      };
    }
    throw new Error('AGENT_AUTHORED_WRITE_REQUIRED');
  }` : `  async function ${handlerName}(args = {}) {
    return fetchGet(${serializeJsValue(stripRequestUrlQuery(candidate.url))}, args || {});
  }`;
    modules.push(createGeneratedToolModule(siteKey, candidate.toolName, functionSource, buildGeneratedToolDefinitionSource({
        toolName: candidate.toolName,
        description,
        parameters: schema,
        ...(isSideEffectingAction ? { access: 'write' } : {}),
        generationSource: resolveGenerationSource(candidate, 'action_capture'),
        handlerSource: `(args) => ${handlerName}(args || {})`
    })));
    if (canBuildNormalizedReadTool(candidate)) {
        const normalizedToolName = buildNormalizedActionToolName(candidate.toolName || `${siteKey}.${candidate.actionName}_draft`);
        const normalizedHandlerName = `run_${toSafeIdentifier(normalizedToolName)}`;
        const normalizedSourceToolName = buildNormalizedActionToolName(sourceToolName || `${siteKey}.${candidate.actionName}_draft`);
        const normalizedDescription = semanticConfig?.getDescription(normalizedSourceToolName, `读取 ${candidate.toolName} 的结果，并按捕获到的响应结构归一化返回。归一化结果会提供 id、display、availability 和 raw 字段。${renderActionResponseHintSentence(candidate)}`) || `读取 ${candidate.toolName} 的结果，并按捕获到的响应结构归一化返回。归一化结果会提供 id、display、availability 和 raw 字段。${renderActionResponseHintSentence(candidate)}`;
        modules.push(createGeneratedToolModule(siteKey, normalizedToolName, `  async function ${normalizedHandlerName}(args = {}) {
    const { availabilitySlot = '', onlyAvailable = false, limit = 0, query = '', resourceId = '', ...requestArgs } = args || {};
    const result = await invokeTool(siteKey, ${serializeJsValue(candidate.toolName)}, requestArgs);
    return normalizeListItems(result, ${serializeJsValue({
            toolName: candidate.toolName,
            actionName: candidate.actionName,
            responseHints: candidate.responseHints || null
        })}, { availabilitySlot, onlyAvailable, limit, query, resourceId });
  }`, buildGeneratedToolDefinitionSource({
            toolName: normalizedToolName,
            description: normalizedDescription,
            parameters: applySemanticParameterUiHints(buildNormalizedActionToolSchema(defaults, parameterDescriptions), parameterUiHints),
            generationSource: resolveGenerationSource(candidate, 'action_capture'),
            handlerSource: `(args) => ${normalizedHandlerName}(args || {})`
        })));
    }
    return modules;
}
function buildSemanticToolModules(siteKey, candidate, semanticConfig) {
    if (!canBuildNormalizedReadTool(candidate)) return [];
    const normalizedToolName = buildNormalizedActionToolName(candidate.toolName || `${siteKey}.${candidate.actionName}_draft`);
    const modules = [
        createGeneratedToolModule(siteKey, `${siteKey}.list_resources`, `  async function listSemanticResources(args = {}) {
    return invokeTool(siteKey, ${serializeJsValue(normalizedToolName)}, args || {});
  }`, buildGeneratedToolDefinitionSource({
            toolName: `${siteKey}.list_resources`,
            description: semanticConfig?.getDescription(`${siteKey}.list_resources`, `资源列表工具，基于 ${normalizedToolName} 生成，返回带有稳定 id/display/availability 映射的归一化资源项。`) || `资源列表工具，基于 ${normalizedToolName} 生成，返回带有稳定 id/display/availability 映射的归一化资源项。`,
            parameters: semanticConfig?.applyParameterDescriptions(`${siteKey}.list_resources`, buildSemanticListResourcesSchema(candidate)) || buildSemanticListResourcesSchema(candidate),
            generationSource: resolveGenerationSource(candidate, 'action_capture'),
            handlerSource: '(args) => listSemanticResources(args || {})'
        }))
    ];
    if (hasAvailabilityHints(candidate)) {
        modules.push(createGeneratedToolModule(siteKey, `${siteKey}.find_available_resources`, `  async function findSemanticAvailableResources(args = {}) {
    const { availabilitySlot = '', limit = 0, ...requestArgs } = args || {};
    return invokeTool(siteKey, ${serializeJsValue(normalizedToolName)}, {
      ...requestArgs,
      availabilitySlot,
      onlyAvailable: true,
      limit,
    });
  }`, buildGeneratedToolDefinitionSource({
            toolName: `${siteKey}.find_available_resources`,
            description: semanticConfig?.getDescription(`${siteKey}.find_available_resources`, `资源可用性筛选工具，基于 ${normalizedToolName} 生成，可按可用时段筛选归一化资源。`) || `资源可用性筛选工具，基于 ${normalizedToolName} 生成，可按可用时段筛选归一化资源。`,
            parameters: semanticConfig?.applyParameterDescriptions(`${siteKey}.find_available_resources`, buildSemanticFindAvailableSchema(candidate)) || buildSemanticFindAvailableSchema(candidate),
            generationSource: resolveGenerationSource(candidate, 'action_capture'),
            handlerSource: '(args) => findSemanticAvailableResources(args || {})'
        })));
    }
    return modules;
}
function buildActionPlanningToolModules(siteKey, candidate, semanticReadCandidate) {
    return [];
}
function buildDetailHintsToolModule(memory, toolName, semanticConfig) {
    const finalToolName = toolName || `${memory.siteKey}.list_detail_candidates`;
    return createGeneratedToolModule(memory.siteKey, finalToolName, `  function listDetailCandidates() {
    return {
      mode: ${serializeJsValue(memory.detailHints.mode)},
      bestCandidateHref: ${serializeJsValue(memory.detailHints.bestCandidateHref)},
      bestCandidateText: ${serializeJsValue(memory.detailHints.bestCandidateText)},
      networkDetailCandidates: ${serializeJsValue(memory.detailHints.networkDetailCandidates.slice(0, 10))},
    };
  }`, buildGeneratedToolDefinitionSource({
        toolName: finalToolName,
        description: semanticConfig?.getDescription(`${memory.siteKey}.list_detail_candidates`, `详情候选辅助工具。返回探索阶段捕获到的详情链接候选及相关元数据。`) || `详情候选辅助工具。返回探索阶段捕获到的详情链接候选及相关元数据。`,
        parameters: {
            type: 'object',
            properties: {},
            required: []
        },
        handlerSource: '() => listDetailCandidates()'
    }));
}
function buildIndexSnippet(siteKey) {
    return `// 把这一行加入 extension/adapters/${siteKey}/index.js 的 tools 数组中
...(window.__webmcpGeneratedSupport?.[${serializeJsValue(siteKey)}]?.tools || []),
`;
}
function buildIntegrationGuide(memory, context) {
    const lines = [
        '# 自动生成适配器接入说明',
        '',
        `站点：${memory.siteHost}`,
        `工作流版本：${memory.workflowVersion}`,
        `生成模式：${context.mode}`,
        `生成策略：${context.generationStrategy}`,
        '',
        '## 目标',
        '',
        '本次 scaffold 遵循当前适配器架构：',
        '- 实现会拆分为 shared runtime、generated tool modules 和一个轻量 site entry 文件',
        '- adapter manifest 会通过 support_files 按顺序在 index.js 之前注入这些文件',
        '- index.js 通过 generated support registry 对外暴露这些工具',
        '',
        '## 生成文件',
        '',
        ...context.supportFiles.map((file)=>`- 支撑文件：${file}`),
        `- Index 片段：${context.indexSnippetRel}`,
        '',
        '## 必要接线',
        '',
        `1. 确认 ${context.manifestPath} 中包含：`,
        '',
        '```json',
        JSON.stringify({
            support_files: context.supportFiles
        }, null, 2),
        '```',
        '',
        `2. 把下面这一行加入 ${context.indexPath} 的 tools 数组中：`,
        '',
        '```js',
        buildIndexSnippet(memory.siteKey).trimEnd(),
        '```',
        '',
        '## 运行时启用',
        '',
        '- scaffold 生成器也会同步更新 extension/adapters/index.json，让扩展初始化阶段可以发现这个适配器。',
        '- 生成或更新适配器后，重新加载一次 Chrome 扩展，让后台重新扫描已安装适配器。',
        '- 生成工具默认标记为 API background/direct，应先在无目标标签页的情况下直接调用。',
        `- 只有 direct 调用返回登录或页面上下文错误时，才打开 ${memory.canonicalEntryUrl || memory.siteOrigin || `https://${memory.siteHost}/`} 完成登录。`,
        '',
        '## 生成工具',
        '',
        ...context.toolNames.map((name)=>`- ${name}`),
        '',
        '## API 信号',
        '',
        ...context.primary ? [
            `- 主列表接口：${context.primary.method} ${context.primary.url}`
        ] : [],
        ...context.secondary ? [
            `- 次要列表接口：${context.secondary.method} ${context.secondary.url}`
        ] : [],
        ...context.actionCandidates.map((candidate)=>`- 动作接口（${candidate.actionName}）：${candidate.method} ${candidate.url}`),
        ...context.actionCandidates.flatMap((candidate)=>renderActionHintLines(memory.siteKey, candidate, selectSemanticReadCandidate(context.actionCandidates))),
        '',
        '## 说明',
        '',
        '- 当前生成器仍保留通用列表工具名，因为探索阶段还不能稳定推断完整业务意图。',
        '- 当存在更强动作信号时，弱记录型列表接口会被自动降权或过滤。',
        '- 动作类工具会保留站点记忆里的动作语义命名，因为 action capture 通常比列表探索更接近真实业务动作。',
        '- 当前输出可由客户端、Agent 或插件界面直接调用，不再额外生成 plan/prepare 编排层；写操作由当前调用宿主按最终 payload 完成一次用户确认。',
        '- 如果捕获时带入了默认值，重新生成前建议继续做几轮 capture，把默认参数质量提上来。'
    ];
    return lines.join('\n');
}
function buildAdapterSkillMarkdown(memory, manifest, supportBundle) {
    const tools = supportBundle.toolFiles.map((file)=>file.toolDefinition).filter(Boolean);
    const title = manifest?.name || memory.siteHost || memory.siteKey;
    const rawDescription = safeString(manifest?.description);
    const description = rawDescription && !/^Generated adapter shell/i.test(rawDescription)
        ? rawDescription
        : `基于站点记忆生成的 ${memory.siteHost || memory.siteKey} 适配器。`;
    const matches = Array.isArray(manifest?.match) && manifest.match.length > 0
        ? manifest.match.filter((item)=>typeof item === 'string' && item.trim())
        : [
            memory.siteHost || memory.siteKey
        ].filter(Boolean);
    const lines = [
        `# ${title}`,
        '',
        description,
        ''
    ];
    if (matches.length > 0) {
        lines.push(`Matches: ${matches.join(', ')}`, '');
    }
    if (manifest?.requires_auth) {
        lines.push('> Requires authentication. Direct tools should reuse the browser session first; open the website only after a login or page-context error.', '');
    }
    lines.push(
        '## Execution Rules',
        '',
        '- Generated tools are `type=api, runtime=background` and `mode=direct`.',
        '- Do not open the target website or run a login check before the first direct call.',
        '- Open the website only when a direct call reports a login or page-context error.',
        ''
    );
    const usageLines = buildSkillUsageGuidance(memory.siteKey, supportBundle.actionHints || {});
    if (usageLines.length > 0) {
        lines.push('## 使用建议', '', ...usageLines, '');
    }
    lines.push(
        '## 优化上下文',
        '',
        '- 后续优化本 adapter 前，优先读取同目录的 `WEBCLI_KNOWLEDGE.md`，其中包含自动探索/录制沉淀的关键接口、字段映射、脱敏样例和已知问题。',
        '- 如果存在 `WEBCLI_KNOWLEDGE.json`，可用于程序化分析接口结构和工具映射。',
        '- 如果存在 `SKILL.generated.md`，它是最近一次 scaffold 生成的 skill 草稿，可与当前 `SKILL.md` 对比合并。',
        ''
    );
    if (tools.length === 0) {
        lines.push('No tools defined.');
        return lines.join('\n');
    }
    lines.push(`## Tools (${tools.length})`, '');
    for (const tool of tools){
        lines.push(`### ${tool.name}`, '');
        if (tool.description) {
            lines.push(tool.description, '');
        }
        lines.push('Execution: type=api, runtime=background', '', 'Execution: mode=direct', '');
        const toolNotes = buildSkillToolNotes(tool.name, supportBundle.actionHints || {});
        if (toolNotes.length > 0) {
            lines.push(...toolNotes, '');
        }
        const params = buildSkillParameterLines(tool.parameters);
        if (params.length > 0) {
            lines.push('Parameters:', '', ...params, '');
        }
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function buildWebCliKnowledgePack(memory, context = {}) {
    const generatedAt = new Date().toISOString();
    const apiMap = new Map();
    const addApi = (candidate, source, extra = {})=>{
        const normalized = normalizeKnowledgeApiCandidate(candidate, source, extra);
        if (!normalized) return;
        const existing = apiMap.get(normalized.id);
        apiMap.set(normalized.id, existing ? mergeKnowledgeApi(existing, normalized) : normalized);
    };

    if (context.primary) addApi(context.primary, 'exploration', { role: 'primary_list' });
    if (context.secondary) addApi(context.secondary, 'exploration', { role: 'secondary_list' });
    for (const candidate of Array.isArray(memory.listApiCandidates) ? memory.listApiCandidates : []) {
        addApi(candidate, 'exploration', { role: 'list_candidate' });
    }
    for (const candidate of Array.isArray(memory.actionCaptureHistory) ? memory.actionCaptureHistory : []) {
        addApi(candidate, 'action_capture_history', { actionName: candidate.actionName, toolName: candidate.toolName });
    }
    for (const candidate of Array.isArray(memory.actionApiCandidates) ? memory.actionApiCandidates : []) {
        addApi(candidate, 'action_candidate', { actionName: candidate.actionName, toolName: candidate.toolName });
    }
    for (const candidate of Array.isArray(context.actionCandidates) ? context.actionCandidates : []) {
        addApi(candidate, 'generated_tool', { actionName: candidate.actionName, toolName: candidate.toolName });
    }

    const apis = [...apiMap.values()]
        .sort((left, right)=>scoreKnowledgeApi(right) - scoreKnowledgeApi(left) || left.id.localeCompare(right.id))
        .slice(0, 50);
    const toolDefinitions = (context.supportBundle?.toolFiles || []).map((file)=>file.toolDefinition).filter(Boolean);
    const knownIssues = inferKnowledgeKnownIssues(memory, apis);
    const businessMappings = inferKnowledgeBusinessMappings(memory, toolDefinitions);
    const changeHistory = buildKnowledgeChangeHistory(memory, {
        generatedAt,
        toolNames: context.toolNames || [],
        knownIssues
    });

    return {
        version: 'webcli-knowledge-v1',
        siteKey: memory.siteKey,
        siteHost: memory.siteHost || memory.siteKey,
        siteOrigin: memory.siteOrigin || '',
        updatedAt: generatedAt,
        summary: {
            adapterName: safeString(context.manifest?.name) || memory.siteHost || memory.siteKey,
            adapterDescription: safeString(context.manifest?.description),
            authRequired: Boolean(context.manifest?.requires_auth),
            generatedTools: (context.toolNames || []).slice(0, 80),
            generationMode: context.mode || '',
            generationStrategy: context.generationStrategy || '',
            semanticEnhancement: context.semanticConfig?.summary || null
        },
        exploration: {
            entryUrl: memory.canonicalEntryUrl || '',
            resultUrl: memory.canonicalResultUrl || '',
            lastSourceUrl: memory.lastSourceUrl || '',
            workflowVersion: memory.workflowVersion || '',
            workflowVersionsSeen: Array.isArray(memory.workflowVersionsSeen) ? memory.workflowVersionsSeen.slice(0, 10) : [],
            verdictPattern: memory.verdictPattern || memory.pattern || '',
            recommendedStrategy: memory.recommendedStrategy || '',
            verdictReason: truncateKnowledgeText(memory.verdictReason || memory.reason || '', 800),
            resultSignals: memory.resultSignals || {}
        },
        apis,
        tools: buildKnowledgeTools(toolDefinitions, context.supportBundle?.actionHints || {}),
        businessMappings,
        knownIssues,
        optimizationNotes: buildKnowledgeOptimizationNotes(memory, apis, businessMappings),
        limits: {
            maxApis: 50,
            maxExamplesPerApi: 3,
            maxPreviewBytes: 2048,
            rawEvidenceStored: false
        },
        changeHistory
    };
}

function readExistingWebCliKnowledgePack(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function mergeWebCliKnowledgePack(existing, current) {
    if (!existing || existing.version !== 'webcli-knowledge-v1') return current;
    const apiMap = new Map();
    for (const api of Array.isArray(existing.apis) ? existing.apis : []) {
        if (!api?.id) continue;
        apiMap.set(api.id, normalizeExistingKnowledgeApi(api));
    }
    for (const api of Array.isArray(current.apis) ? current.apis : []) {
        if (!api?.id) continue;
        const previous = apiMap.get(api.id);
        apiMap.set(api.id, previous ? mergeKnowledgeApi(previous, api) : api);
    }
    const apis = [...apiMap.values()]
        .sort((left, right)=>scoreKnowledgeApi(right) - scoreKnowledgeApi(left) || left.id.localeCompare(right.id))
        .slice(0, current.limits?.maxApis || 50);
    const tools = dedupeKnowledgeTools([
        ...(Array.isArray(current.tools) ? current.tools : []),
        ...(Array.isArray(existing.tools) ? existing.tools : [])
    ]).slice(0, 80);
    const businessMappings = dedupeKnowledgeMappings([
        ...(Array.isArray(current.businessMappings) ? current.businessMappings : []),
        ...(Array.isArray(existing.businessMappings) ? existing.businessMappings : [])
    ]).slice(0, 20);
    const knownIssues = dedupeKnowledgeIssues([
        ...(Array.isArray(current.knownIssues) ? current.knownIssues : []),
        ...(Array.isArray(existing.knownIssues) ? existing.knownIssues : [])
    ]).slice(0, 30);
    const optimizationNotes = uniqueKnowledgeStrings([
        ...(Array.isArray(current.optimizationNotes) ? current.optimizationNotes : []),
        ...(Array.isArray(existing.optimizationNotes) ? existing.optimizationNotes : [])
    ]).slice(0, 20);
    const changeHistory = dedupeKnowledgeChangeHistory([
        ...(Array.isArray(current.changeHistory) ? current.changeHistory : []),
        ...(Array.isArray(existing.changeHistory) ? existing.changeHistory : [])
    ]).slice(0, 30);
    const generatedTools = uniqueKnowledgeStrings([
        ...((current.summary?.generatedTools || [])),
        ...((existing.summary?.generatedTools || []))
    ]).slice(0, 80);
    return {
        ...existing,
        ...current,
        summary: {
            ...(existing.summary || {}),
            ...(current.summary || {}),
            generatedTools
        },
        exploration: {
            ...(existing.exploration || {}),
            ...(current.exploration || {})
        },
        apis,
        tools,
        businessMappings,
        knownIssues,
        optimizationNotes,
        changeHistory,
        limits: {
            ...(existing.limits || {}),
            ...(current.limits || {})
        }
    };
}

function normalizeExistingKnowledgeApi(api) {
    return {
        ...api,
        roles: uniqueKnowledgeStrings(api.roles || []),
        sources: uniqueKnowledgeStrings(api.sources || []),
        sourceActions: uniqueKnowledgeStrings(api.sourceActions || []),
        backingTools: uniqueKnowledgeStrings(api.backingTools || []),
        queryKeys: uniqueKnowledgeStrings(api.queryKeys || []).sort(),
        responseEvidence: normalizeResponseBodyEvidence({ responseEvidence: api.responseEvidence }),
        examples: [],
        seenCount: Math.max(1, Number(api.seenCount || 1))
    };
}

function normalizeKnowledgeApiCandidate(candidate, source, extra = {}) {
    const urlText = safeString(candidate?.url);
    if (!urlText) return null;
    const method = (safeString(candidate?.method) || 'GET').toUpperCase();
    const parsed = parseKnowledgeUrl(urlText);
    const pathName = parsed?.pathname || stripKnowledgeQuery(urlText);
    const queryKeys = parsed
        ? [...parsed.searchParams.keys()]
            .filter((key)=>!isSensitiveKnowledgeKey(key))
            .sort((left, right)=>left.localeCompare(right))
        : [];
    const requestEvidence = normalizeRequestBodyEvidence(candidate);
    const requestShape = summarizeKnowledgeRequestEvidence(requestEvidence);
    const responseEvidence = normalizeResponseBodyEvidence(candidate);
    const responseHints = normalizeKnowledgeResponseHints(candidate?.responseHints);
    const responseShape = responseHints || summarizeKnowledgeResponseEvidence(responseEvidence);
    const id = buildKnowledgeApiFingerprint({
        method,
        pathName,
        queryKeys,
        requestShape
    });
    const requestSample = summarizeKnowledgeRequestSample(candidate, parsed, requestShape);
    const purpose = safeString(candidate?.aiPurpose) || safeString(candidate?.purpose) || inferKnowledgeApiPurpose(candidate, extra);
    return {
        id,
        method,
        path: pathName,
        url: normalizeKnowledgeUrlForDisplay(urlText),
        purpose,
        roles: [extra.role || source].filter(Boolean),
        sources: [source].filter(Boolean),
        sourceActions: [extra.actionName || candidate?.actionName].map(safeString).filter(Boolean),
        backingTools: [extra.toolName || candidate?.toolName].map(safeString).filter(Boolean),
        queryKeys,
        requestShape,
        responseEvidence,
        responseShape,
        examples: [{
            source,
            request: requestSample,
        }].filter((item)=>Object.keys(item.request || {}).length > 0),
        seenCount: 1,
        firstSeenAt: safeString(candidate?.capturedAt),
        lastSeenAt: safeString(candidate?.capturedAt),
        contentType: safeString(candidate?.responseContentType || candidate?.contentType)
    };
}

function mergeKnowledgeApi(left, right) {
    const examples = dedupeKnowledgeExamples([...(left.examples || []), ...(right.examples || [])]).slice(0, 3);
    return {
        ...left,
        purpose: pickLongerKnowledgeText(left.purpose, right.purpose, 240),
        roles: uniqueKnowledgeStrings([...(left.roles || []), ...(right.roles || [])]).slice(0, 8),
        sources: uniqueKnowledgeStrings([...(left.sources || []), ...(right.sources || [])]).slice(0, 8),
        sourceActions: uniqueKnowledgeStrings([...(left.sourceActions || []), ...(right.sourceActions || [])]).slice(0, 12),
        backingTools: uniqueKnowledgeStrings([...(left.backingTools || []), ...(right.backingTools || [])]).slice(0, 12),
        queryKeys: uniqueKnowledgeStrings([...(left.queryKeys || []), ...(right.queryKeys || [])]).sort(),
        requestShape: mergeKnowledgeShape(left.requestShape, right.requestShape),
        responseEvidence: right.responseEvidence || left.responseEvidence,
        responseShape: mergeKnowledgeResponseShape(left.responseShape, right.responseShape),
        examples,
        seenCount: Number(left.seenCount || 0) + Number(right.seenCount || 0),
        firstSeenAt: pickEarlierKnowledgeIso(left.firstSeenAt, right.firstSeenAt),
        lastSeenAt: pickLaterKnowledgeIso(left.lastSeenAt, right.lastSeenAt),
        contentType: left.contentType || right.contentType
    };
}

function buildKnowledgeApiFingerprint({ method, pathName, queryKeys, requestShape }) {
    const requestKeys = Array.isArray(requestShape?.keys)
        ? requestShape.keys.filter((key)=>!isSensitiveKnowledgeKey(key)).sort()
        : [];
    const queryPart = queryKeys.length ? `?${queryKeys.join(',')}` : '';
    const requestPart = requestKeys.length ? `#body:${requestKeys.join(',')}` : '';
    return `${method.toUpperCase()} ${pathName}${queryPart}${requestPart}`;
}

function summarizeKnowledgePayloadShape(value) {
    const text = safeString(value);
    if (!text) return { kind: 'empty', keys: [] };
    const parsed = parseKnowledgeJsonLike(text);
    if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed)) {
            return { kind: 'array', keys: [], itemType: inferKnowledgeValueType(parsed[0]) };
        }
        return {
            kind: 'object',
            keys: Object.keys(parsed).filter((key)=>!isSensitiveKnowledgeKey(key)).sort().slice(0, 80),
            fieldTypes: summarizeKnowledgeFieldTypes(parsed)
        };
    }
    const formKeys = [...new Set([...text.matchAll(/([A-Za-z0-9_.$-]+)=/g)].map((match)=>match[1]).filter(Boolean))]
        .filter((key)=>!isSensitiveKnowledgeKey(key))
        .sort();
    return {
        kind: formKeys.length ? 'form' : 'text',
        keys: formKeys.slice(0, 80)
    };
}

function normalizeKnowledgeResponseHints(hints) {
    if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return null;
    return {
        topLevelKeys: Array.isArray(hints.topLevelKeys) ? hints.topLevelKeys.slice(0, 40) : [],
        listPath: safeString(hints.listPath),
        itemKeys: Array.isArray(hints.itemKeys) ? hints.itemKeys.slice(0, 80) : [],
        idLikeKeys: Array.isArray(hints.idLikeKeys) ? hints.idLikeKeys.slice(0, 30) : [],
        displayLikeKeys: Array.isArray(hints.displayLikeKeys) ? hints.displayLikeKeys.slice(0, 30) : [],
        availabilityLikeKeys: Array.isArray(hints.availabilityLikeKeys) ? hints.availabilityLikeKeys.slice(0, 30) : [],
        preferredIdKey: safeString(hints.preferredIdKey),
        preferredDisplayKey: safeString(hints.preferredDisplayKey),
        preferredAvailabilityKey: safeString(hints.preferredAvailabilityKey)
    };
}

function summarizeKnowledgeResponsePreview(value) {
    const parsed = parseKnowledgeJsonLike(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const topLevelKeys = Array.isArray(parsed) ? [] : Object.keys(parsed).slice(0, 40);
    const listInfo = findKnowledgeListShape(parsed);
    return {
        topLevelKeys,
        listPath: listInfo?.path || '',
        itemKeys: listInfo?.itemKeys || [],
        idLikeKeys: pickKnowledgeKeysByPattern(listInfo?.itemKeys || [], /(id|Id|ID)$/),
        displayLikeKeys: pickKnowledgeKeysByPattern(listInfo?.itemKeys || [], /(name|title|code|text|label|display|roomcode|roomCode)$/),
        availabilityLikeKeys: pickKnowledgeKeysByPattern(listInfo?.itemKeys || [], /(available|availability|status|meetingInfoMaps|calendar|slots?)/i),
        preferredIdKey: pickKnowledgePreferredKey(listInfo?.itemKeys || [], ['id', 'roomId', 'resourceId']),
        preferredDisplayKey: pickKnowledgePreferredKey(listInfo?.itemKeys || [], ['roomcode', 'roomCode', 'name', 'title', 'display']),
        preferredAvailabilityKey: pickKnowledgePreferredKey(listInfo?.itemKeys || [], ['meetingInfoMaps', 'available', 'availability', 'status'])
    };
}

function summarizeKnowledgeRequestSample(candidate, parsedUrl, requestShape) {
    const result = {};
    if (parsedUrl) {
        for (const key of [...parsedUrl.searchParams.keys()].slice(0, 20)) {
            if (!isSensitiveKnowledgeKey(key)) result[key] = ':value';
        }
    }
    for (const key of (requestShape?.keys || []).slice(0, 30)) {
        result[key] = `<${requestShape?.fieldTypes?.[key] || 'value'}>`;
    }
    return result;
}

function summarizeKnowledgeResponseEvidence(evidence) {
    const shape = evidence?.bodyShape;
    if (!shape || shape.type !== 'object') return null;
    const topLevelKeys = Object.keys(shape.properties || {}).slice(0, 40);
    const firstArray = findKnowledgeArrayShape(shape, '');
    const itemKeys = firstArray?.itemShape?.type === 'object'
        ? Object.keys(firstArray.itemShape.properties || {}).slice(0, 80)
        : [];
    return {
        topLevelKeys,
        listPath: firstArray?.path || '',
        itemKeys,
        idLikeKeys: pickKnowledgeKeysByPattern(itemKeys, /(id|Id|ID)$/),
        displayLikeKeys: pickKnowledgeKeysByPattern(itemKeys, /(name|title|code|text|label|display|roomcode|roomCode)$/),
        availabilityLikeKeys: pickKnowledgeKeysByPattern(itemKeys, /(available|availability|status|meetingInfoMaps|calendar|slots?)/i),
        preferredIdKey: pickKnowledgePreferredKey(itemKeys, ['id', 'roomId', 'resourceId']),
        preferredDisplayKey: pickKnowledgePreferredKey(itemKeys, ['roomcode', 'roomCode', 'name', 'title', 'display']),
        preferredAvailabilityKey: pickKnowledgePreferredKey(itemKeys, ['meetingInfoMaps', 'available', 'availability', 'status'])
    };
}

function findKnowledgeArrayShape(shape, prefix) {
    if (!shape || typeof shape !== 'object') return null;
    if (shape.type === 'array') return { path: prefix, itemShape: shape.items };
    if (shape.type !== 'object') return null;
    for (const [key, nested] of Object.entries(shape.properties || {})) {
        const pathName = prefix ? `${prefix}.${key}` : key;
        const found = findKnowledgeArrayShape(nested, pathName);
        if (found) return found;
    }
    return null;
}

function buildKnowledgeTools(toolDefinitions, actionHints) {
    return toolDefinitions.map((tool)=>({
        name: tool.name,
        description: truncateKnowledgeText(tool.description || '', 400),
        parameters: summarizeKnowledgeToolParameters(tool.parameters),
        backingApis: inferKnowledgeBackingApis(tool.name, actionHints),
        sideEffect: Boolean(tool.parameters?.['x-webcli-requires-confirmation']),
        notes: buildKnowledgeToolNotes(tool, actionHints?.[tool.name])
    })).slice(0, 80);
}

function summarizeKnowledgeToolParameters(schema) {
    const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    return Object.entries(properties).map(([name, property])=>({
        name,
        type: Array.isArray(property?.enum) ? 'enum' : safeString(property?.type) || 'string',
        required: required.has(name),
        description: truncateKnowledgeText(property?.description || '', 220),
        enum: Array.isArray(property?.enum) ? property.enum.map((item)=>String(item)).slice(0, 30) : undefined,
        hasDefault: Object.prototype.hasOwnProperty.call(property || {}, 'default') || undefined
    }));
}

function buildKnowledgeToolNotes(tool, hint) {
    const notes = [];
    if (tool.parameters?.['x-webcli-requires-confirmation']) notes.push('该工具可能触发真实业务动作，调用前需要确认。');
    if (hint?.responseHints?.listPath) notes.push(`响应列表路径：${hint.responseHints.listPath}`);
    if (hint?.planningHints?.resourceLookupToolNames?.length) notes.push(`可先调用资源查询工具：${hint.planningHints.resourceLookupToolNames.join(', ')}`);
    return notes;
}

function inferKnowledgeBackingApis(toolName, actionHints) {
    const hint = actionHints?.[toolName];
    return hint?.url ? [hint.url] : [];
}

function inferKnowledgeBusinessMappings(memory, toolDefinitions) {
    const mappings = [];
    for (const tool of toolDefinitions) {
        const properties = tool.parameters?.properties && typeof tool.parameters.properties === 'object' ? tool.parameters.properties : {};
        for (const [field, schema] of Object.entries(properties)) {
            if (!Array.isArray(schema?.enum) || schema.enum.length === 0) continue;
            mappings.push({
                field,
                canonicalValues: schema.enum.map((item)=>String(item)).slice(0, 50),
                aliases: inferKnowledgeAliases(field, schema, memory)
            });
        }
    }
    return dedupeKnowledgeMappings(mappings).slice(0, 20);
}

function inferKnowledgeAliases(field, schema, memory) {
    const aliases = {};
    if (field === 'workplace') {
        for (const item of schema.enum || []) {
            const canonical = String(item).trim();
            const shortName = canonical.replace(/(?:研发中心|办公区|园区|中心|大厦|职场)$/u, '').trim();
            if (shortName && shortName !== canonical && aliases[shortName] === undefined) {
                aliases[shortName] = canonical;
            }
        }
    }
    return aliases;
}

function inferKnowledgeKnownIssues(memory, apis) {
    const issues = [];
    for (const api of apis) {
        const hasDateTimeQuery = (api.queryKeys || []).some((key)=>/time|date/i.test(key));
        if (api.method === 'GET' && hasDateTimeQuery) {
            issues.push({
                scope: api.id,
                issue: 'GET 查询参数中包含日期时间字段时，要确认目标站点接受的空格编码形式；部分站点要求 %20，不能使用 +。'
            });
        }
    }
    if (memory?.actionEvidenceSummary?.historyCount > (memory?.actionApiCandidates?.length || 0)) {
        issues.push({
            scope: 'action_candidates',
            issue: '同一动作可能有多轮录制证据；优化时应优先参考 actionEvidenceSummary 中 selectedUrl 和 selectedSignals。'
        });
    }
    return dedupeKnowledgeIssues(issues).slice(0, 30);
}

function buildKnowledgeOptimizationNotes(memory, apis, businessMappings) {
    const notes = [
        '自动生成的工具是第一版草稿，优化时优先读取本文件中的 canonical APIs、业务映射和 knownIssues。',
        '不要要求最终用户填写内部 ID；应通过查询类 API 将自然语言参数解析为业务 ID。',
    ];
    if (businessMappings.length > 0) notes.push('存在枚举型业务参数，调用工具前应先按 businessMappings 做别名归一化。');
    if (apis.some((api)=>api.responseShape?.preferredIdKey && api.responseShape?.preferredDisplayKey)) {
        notes.push('响应结构中已识别 ID/display 字段，可用于把用户可读名称映射到接口所需 ID。');
    }
    return notes.slice(0, 20);
}

function buildKnowledgeChangeHistory(memory, context) {
    const entries = [{
        at: context.generatedAt,
        source: 'scaffold',
        note: `生成或更新 adapter：tools=${context.toolNames.length}，captureCount=${Number(memory.captureCount || 0)}。`
    }];
    for (const issue of context.knownIssues || []) {
        entries.push({
            at: context.generatedAt,
            source: 'knowledge',
            note: `记录已知问题：${issue.issue}`
        });
    }
    return entries.slice(0, 30);
}

function buildWebCliKnowledgeMarkdown(pack) {
    const lines = [
        `# ${pack.siteKey} 自动优化知识包`,
        '',
        '这份文件由 WebCLI 自动探索/录制/生成流程维护，供 WeWorker 客户端、Claude Code、OpenClaw 或用户自己的 Agent 做后续多轮优化时优先读取。',
        '',
        '## 概览',
        '',
        `- 站点：${pack.siteHost || pack.siteKey}`,
        `- 用途：${pack.summary?.adapterDescription || 'WebCLI 自动生成的站点适配器知识。'}`,
        `- 生成策略：${pack.summary?.generationStrategy || 'unknown'}`,
        `- 当前工具：${(pack.summary?.generatedTools || []).join(', ') || 'none'}`,
        `- 原始证据：不存储完整原始响应，仅保留脱敏后的结构摘要和小样例。`,
        '',
        '## 关键接口',
        ''
    ];
    for (const api of (pack.apis || []).slice(0, 20)) {
        const response = api.responseShape || {};
        lines.push(`- ${api.method} ${api.path}`);
        if (api.purpose) lines.push(`  用途：${api.purpose}`);
        if (api.queryKeys?.length) lines.push(`  查询参数：${api.queryKeys.join(', ')}`);
        if (api.requestShape?.keys?.length) lines.push(`  请求体字段：${api.requestShape.keys.join(', ')}`);
        const shapeParts = [
            response.listPath ? `list=${response.listPath}` : '',
            response.preferredIdKey ? `id=${response.preferredIdKey}` : '',
            response.preferredDisplayKey ? `display=${response.preferredDisplayKey}` : '',
            response.preferredAvailabilityKey ? `availability=${response.preferredAvailabilityKey}` : ''
        ].filter(Boolean);
        if (shapeParts.length) lines.push(`  响应结构：${shapeParts.join(', ')}`);
    }
    if (pack.businessMappings?.length) {
        lines.push('', '## 业务映射', '');
        for (const mapping of pack.businessMappings) {
            lines.push(`- ${mapping.field}: ${(mapping.canonicalValues || []).join('、')}`);
            const aliasEntries = Object.entries(mapping.aliases || {});
            if (aliasEntries.length) lines.push(`  别名：${aliasEntries.map(([alias, value])=>`${alias}=>${value}`).join(', ')}`);
        }
    }
    if (pack.knownIssues?.length) {
        lines.push('', '## 已知问题', '');
        for (const issue of pack.knownIssues) lines.push(`- ${issue.issue}`);
    }
    if (pack.optimizationNotes?.length) {
        lines.push('', '## 优化建议', '');
        for (const note of pack.optimizationNotes) lines.push(`- ${note}`);
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function buildSkillUsageGuidance(siteKey, actionHints) {
    const lines = [];
    const loginToolName = `${siteKey}.check_login_status`;
    lines.push(`- 进入站点后先调用 \`${loginToolName}\` 检查登录态；未登录时先让用户在浏览器里完成登录。`);
    const writeHints = Object.entries(actionHints || {}).filter(([, hint])=>hint?.planningHints?.kind === 'write_action');
    for (const [toolName] of writeHints){
        lines.push(`- \`${toolName}\` 可能触发真实业务动作；调用时由当前客户端或 Agent 宿主展示最终 payload 并请求确认。`);
    }
    const planHints = Object.entries(actionHints || {}).filter(([, hint])=>hint?.planningHints?.planActionToolName || hint?.planningHints?.prepareActionToolName);
    for (const [toolName, hint] of planHints){
        const planning = hint.planningHints || {};
        if (planning.planActionToolName) {
            lines.push(`- 对于 \`${toolName}\` 这类可能产生业务副作用的动作，优先调用 \`${planning.planActionToolName}\` 从自然语言或显式参数生成待确认方案。`);
        } else if (planning.prepareActionToolName) {
            lines.push(`- 对于 \`${toolName}\` 这类可能产生业务副作用的动作，优先调用 \`${planning.prepareActionToolName}\` 准备并检查 payload。`);
        }
    }
    return Array.from(new Set(lines));
}
function buildSkillToolNotes(toolName, actionHints) {
    const hint = actionHints?.[toolName];
    const planning = hint?.planningHints || null;
    const lines = [];
    if (planning?.kind === 'write_action') {
        lines.push('调用建议：该工具可能触发真实业务动作；提交前由当前客户端或 Agent 宿主展示最终 payload 并请求确认。');
    }
    if (planning?.resourceLookupToolNames?.length) {
        lines.push(`资源查询工具：${planning.resourceLookupToolNames.map((name)=>`\`${name}\``).join(', ')}`);
    }
    if (planning?.prepareActionToolName) {
        lines.push(`准备工具：\`${planning.prepareActionToolName}\``);
    }
    if (planning?.planActionToolName) {
        lines.push(`计划工具：\`${planning.planActionToolName}\``);
    }
    const responseHints = hint?.responseHints || null;
    if (responseHints?.listPath) {
        const pieces = [
            `列表路径：${responseHints.listPath}`,
            responseHints.preferredIdKey ? `ID 字段：${responseHints.preferredIdKey}` : '',
            responseHints.preferredDisplayKey ? `展示字段：${responseHints.preferredDisplayKey}` : '',
            responseHints.preferredAvailabilityKey ? `可用性字段：${responseHints.preferredAvailabilityKey}` : ''
        ].filter(Boolean);
        lines.push(`响应结构：${pieces.join('；')}`);
    }
    return lines;
}
function buildSkillParameterLines(schema) {
    const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    return Object.entries(properties).map(([name, property])=>{
        const type = formatSkillSchemaType(property);
        const req = required.has(name) ? ' **(required)**' : '';
        const details = [
            safeString(property?.description),
            Array.isArray(property?.enum) && property.enum.length > 0 ? `可选值：${property.enum.map((item)=>String(item)).join('、')}` : '',
            Object.prototype.hasOwnProperty.call(property || {}, 'default') ? `默认值：${formatSkillDefaultValue(property.default)}` : ''
        ].filter(Boolean);
        const suffix = details.length > 0 ? ` — ${details.join('；')}` : '';
        return `- \`${name}\`: ${type}${req}${suffix}`;
    });
}
function formatSkillSchemaType(schema = {}) {
    if (Array.isArray(schema?.enum) && schema.enum.length > 0) return 'enum';
    if (Array.isArray(schema?.type)) return schema.type.join('|');
    return schema?.type || 'string';
}
function formatSkillDefaultValue(value) {
    if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
    try {
        const text = JSON.stringify(value);
        return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    } catch  {
        return String(value);
    }
}

function parseKnowledgeUrl(value) {
    const text = safeString(value);
    if (!text) return null;
    try {
        return new URL(text);
    } catch  {
        try {
            return new URL(text, 'https://example.invalid');
        } catch  {
            return null;
        }
    }
}

function stripKnowledgeQuery(value) {
    const text = safeString(value);
    if (!text) return '';
    return text.split('?')[0].replace(/^https?:\/\/[^/]+/i, '') || text;
}

function normalizeKnowledgeUrlForDisplay(value) {
    const text = safeString(value);
    if (!text) return '';
    const parsed = parseKnowledgeUrl(text);
    if (!parsed) return truncateKnowledgeText(text, 500);
    if (parsed.hostname === 'example.invalid') {
        return `${parsed.pathname}${parsed.search}`;
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function parseKnowledgeJsonLike(value) {
    const text = safeString(value);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch  {}
    const start = Math.min(...['{', '['].map((token)=>{
        const index = text.indexOf(token);
        return index >= 0 ? index : Number.POSITIVE_INFINITY;
    }));
    if (!Number.isFinite(start)) return null;
    const sliced = text.slice(start);
    for (let end = sliced.length; end > Math.max(0, sliced.length - 200); end--) {
        try {
            return JSON.parse(sliced.slice(0, end));
        } catch  {}
    }
    return null;
}

function summarizeKnowledgeFieldTypes(object) {
    return Object.fromEntries(Object.entries(object)
        .filter(([key])=>!isSensitiveKnowledgeKey(key))
        .slice(0, 80)
        .map(([key, value])=>[
            key,
            inferKnowledgeValueType(value)
        ]));
}

function inferKnowledgeValueType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}

function findKnowledgeListShape(value, pathPrefix = '') {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        const item = value.find((entry)=>entry && typeof entry === 'object' && !Array.isArray(entry));
        return {
            path: pathPrefix || '$',
            itemKeys: item ? Object.keys(item).slice(0, 80) : []
        };
    }
    for (const [key, child] of Object.entries(value)) {
        const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        if (Array.isArray(child)) {
            const item = child.find((entry)=>entry && typeof entry === 'object' && !Array.isArray(entry));
            return {
                path: childPath,
                itemKeys: item ? Object.keys(item).slice(0, 80) : []
            };
        }
    }
    for (const [key, child] of Object.entries(value)) {
        const found = findKnowledgeListShape(child, pathPrefix ? `${pathPrefix}.${key}` : key);
        if (found) return found;
    }
    return null;
}

function pickKnowledgeKeysByPattern(keys, pattern) {
    return (Array.isArray(keys) ? keys : []).filter((key)=>pattern.test(key)).slice(0, 20);
}

function pickKnowledgePreferredKey(keys, preferred) {
    const set = new Set(Array.isArray(keys) ? keys : []);
    return preferred.find((key)=>set.has(key)) || '';
}

function getKnowledgePath(value, dotPath) {
    const parts = safeString(dotPath).split('.').filter(Boolean);
    let current = value;
    for (const part of parts) {
        if (!current || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function isSensitiveKnowledgeKey(key) {
    return /token|access.?token|authorization|cookie|session|ticket|password|passwd|secret|credential|key/i.test(safeString(key));
}

function redactKnowledgeString(value) {
    return safeString(value)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/([?&](?:token|access_token|msToken|ticket|sid|session|password|passwd|secret|key)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
        .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]');
}

function truncateKnowledgeText(value, max = 2048) {
    const text = redactKnowledgeString(typeof value === 'string' ? value : value == null ? '' : String(value));
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function escapeKnowledgeRegex(value) {
    return safeString(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueKnowledgeStrings(values) {
    return Array.from(new Set((values || []).map(safeString).filter(Boolean)));
}

function mergeKnowledgeShape(left, right) {
    if (!left) return right;
    if (!right) return left;
    return {
        kind: left.kind === right.kind ? left.kind : left.kind || right.kind,
        keys: uniqueKnowledgeStrings([...(left.keys || []), ...(right.keys || [])]).sort().slice(0, 100),
        fieldTypes: Object.fromEntries(Object.entries({
                ...(right.fieldTypes || {}),
                ...(left.fieldTypes || {})
            })
            .filter(([key])=>!isSensitiveKnowledgeKey(key))
            .slice(0, 100))
    };
}

function mergeKnowledgeResponseShape(left, right) {
    if (!left) return right;
    if (!right) return left;
    const merged = {
        topLevelKeys: uniqueKnowledgeStrings([...(left.topLevelKeys || []), ...(right.topLevelKeys || [])]).slice(0, 60),
        listPath: left.listPath || right.listPath || '',
        itemKeys: uniqueKnowledgeStrings([...(left.itemKeys || []), ...(right.itemKeys || [])]).slice(0, 100),
        idLikeKeys: uniqueKnowledgeStrings([...(left.idLikeKeys || []), ...(right.idLikeKeys || [])]).slice(0, 40),
        displayLikeKeys: uniqueKnowledgeStrings([...(left.displayLikeKeys || []), ...(right.displayLikeKeys || [])]).slice(0, 40),
        availabilityLikeKeys: uniqueKnowledgeStrings([...(left.availabilityLikeKeys || []), ...(right.availabilityLikeKeys || [])]).slice(0, 40),
        preferredIdKey: left.preferredIdKey || right.preferredIdKey || '',
        preferredDisplayKey: left.preferredDisplayKey || right.preferredDisplayKey || '',
        preferredAvailabilityKey: left.preferredAvailabilityKey || right.preferredAvailabilityKey || ''
    };
    return Object.values(merged).some((value)=>Array.isArray(value) ? value.length > 0 : Boolean(value)) ? merged : null;
}

function dedupeKnowledgeExamples(examples) {
    const seen = new Set();
    const result = [];
    for (const example of examples || []) {
        const key = JSON.stringify({
            request: example.request || {},
        }).slice(0, 500);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(example);
    }
    return result;
}

function pickLongerKnowledgeText(left, right, max = 240) {
    const a = safeString(left);
    const b = safeString(right);
    return truncateKnowledgeText(b.length > a.length ? b : a, max);
}

function pickEarlierKnowledgeIso(left, right) {
    if (!left) return right || '';
    if (!right) return left;
    return Date.parse(left) <= Date.parse(right) ? left : right;
}

function pickLaterKnowledgeIso(left, right) {
    if (!left) return right || '';
    if (!right) return left;
    return Date.parse(left) >= Date.parse(right) ? left : right;
}

function scoreKnowledgeApi(api) {
    let score = Number(api.seenCount || 0);
    if (api.roles?.includes('primary_list')) score += 8;
    if (api.roles?.includes('generated_tool')) score += 6;
    if (api.backingTools?.length) score += 5;
    if (api.responseShape?.listPath) score += 4;
    if (api.responseShape?.preferredIdKey) score += 2;
    if (api.method !== 'GET') score += 2;
    if (/static|favicon|avatar|log|track|beacon/i.test(api.path || '')) score -= 6;
    return score;
}

function dedupeKnowledgeMappings(mappings) {
    const byField = new Map();
    for (const mapping of mappings || []) {
        const current = byField.get(mapping.field);
        if (!current) {
            byField.set(mapping.field, mapping);
            continue;
        }
        byField.set(mapping.field, {
            field: mapping.field,
            canonicalValues: uniqueKnowledgeStrings([...(current.canonicalValues || []), ...(mapping.canonicalValues || [])]),
            aliases: {
                ...(current.aliases || {}),
                ...(mapping.aliases || {})
            }
        });
    }
    return [...byField.values()];
}

function dedupeKnowledgeIssues(issues) {
    const seen = new Set();
    return (issues || []).filter((issue)=>{
        const key = `${issue.scope}:${issue.issue}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function dedupeKnowledgeTools(tools) {
    const byName = new Map();
    for (const tool of tools || []) {
        const name = safeString(tool?.name);
        if (!name || byName.has(name)) continue;
        byName.set(name, tool);
    }
    return [...byName.values()];
}

function dedupeKnowledgeChangeHistory(entries) {
    const seen = new Set();
    return (entries || []).filter((entry)=>{
        const key = `${safeString(entry?.at)}:${safeString(entry?.source)}:${safeString(entry?.note)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function inferKnowledgeApiPurpose(candidate, extra) {
    const action = safeString(extra.actionName || candidate?.actionName);
    if (action) return `支持 ${action} 相关工具`;
    const url = safeString(candidate?.url).toLowerCase();
    if (/rooms|getrooms|meetingrooms/.test(url)) return '查询会议室或资源列表';
    if (/list|search|query/.test(url)) return '查询列表数据';
    if ((candidate?.method || '').toUpperCase() !== 'GET') return '提交业务动作';
    return '';
}

function buildGeneratedToolNames(siteKey, context) {
    const names = [
        `${siteKey}.check_login_status`
    ];
    if (context.hasPrimary) names.push(context.primaryToolName || `${siteKey}.search_records`);
    if (context.hasSecondary) names.push(context.secondaryToolName || `${siteKey}.fetch_summary_groups`);
    for (const candidate of context.actionCandidates){
        names.push(candidate.toolName);
    }
    for (const name of context.normalizedActionToolNames){
        names.push(name);
    }
    for (const name of context.semanticToolNames){
        names.push(name);
    }
    if (context.includeDetailHints) names.push(context.detailToolName || `${siteKey}.list_detail_candidates`);
    return names;
}
function buildActionHintRegistry(siteKey, actionCandidates, semanticReadCandidate) {
    const entries = actionCandidates.filter((candidate)=>candidate.toolName).map((candidate)=>[
            candidate.toolName,
            {
                actionName: candidate.actionName,
                method: candidate.method,
                url: candidate.url,
                normalizedToolName: canBuildNormalizedReadTool(candidate) ? buildNormalizedActionToolName(candidate.toolName) : '',
                semanticToolNames: buildSemanticToolNamesForCandidate(siteKey, candidate),
                responseHints: candidate.responseHints || null,
                planningHints: buildActionPlanningHints(siteKey, candidate, semanticReadCandidate)
            }
        ]);
    return Object.fromEntries(entries);
}
function buildSemanticToolNamesForCandidate(siteKey, candidate) {
    if (!canBuildNormalizedReadTool(candidate)) return [];
    const names = [
        `${siteKey}.list_resources`
    ];
    if (hasAvailabilityHints(candidate)) {
        names.push(`${siteKey}.find_available_resources`);
    }
    return names;
}
function buildActionPlanningHints(siteKey, candidate, semanticReadCandidate) {
    const parameterNames = extractActionParameterNames(candidate);
    const kind = (candidate.method || '').toUpperCase() === 'GET' ? 'read_query' : 'write_action';
    const resourceIdParameter = selectResourceReferenceField(parameterNames);
    const startTimeParameter = selectStartTimeField(parameterNames);
    const endTimeParameter = selectEndTimeField(parameterNames);
    const lookupToolNames = semanticReadCandidate ? buildSemanticToolNamesForCandidate(siteKey, semanticReadCandidate) : [];
    const normalizedLookupToolName = semanticReadCandidate?.toolName ? buildNormalizedActionToolName(semanticReadCandidate.toolName) : '';
    const preferredLookupIdKey = semanticReadCandidate?.responseHints?.preferredIdKey || '';
    const preferredLookupDisplayKey = semanticReadCandidate?.responseHints?.preferredDisplayKey || '';
    const preferredLookupAvailabilityKey = semanticReadCandidate?.responseHints?.preferredAvailabilityKey || '';
    const availabilityLookupToolName = lookupToolNames.includes(`${siteKey}.find_available_resources`) ? `${siteKey}.find_available_resources` : '';
    const hints = {
        kind,
        parameterNames
    };
    if (resourceIdParameter) hints.resourceIdParameter = resourceIdParameter;
    if (lookupToolNames.length > 0) hints.resourceLookupToolNames = lookupToolNames;
    if (normalizedLookupToolName) hints.resourceLookupNormalizedToolName = normalizedLookupToolName;
    if (preferredLookupIdKey) hints.preferredLookupIdKey = preferredLookupIdKey;
    if (preferredLookupDisplayKey) hints.preferredLookupDisplayKey = preferredLookupDisplayKey;
    if (preferredLookupAvailabilityKey) hints.preferredLookupAvailabilityKey = preferredLookupAvailabilityKey;
    if (startTimeParameter) hints.startTimeParameter = startTimeParameter;
    if (endTimeParameter) hints.endTimeParameter = endTimeParameter;
    if (availabilityLookupToolName) hints.availabilityLookupToolName = availabilityLookupToolName;
    return Object.keys(hints).length > 0 ? hints : null;
}
function extractActionParameterNames(candidate) {
    const defaults = deriveActionCandidateDefaults(candidate).defaults;
    return Object.keys(defaults);
}
function selectResourceReferenceField(parameterNames) {
    const strongMatches = parameterNames.filter((name)=>/(?:room|resource|asset|desk|seat|device|workspace|meetingRoom)id$/i.test(name));
    if (strongMatches.length > 0) return strongMatches[0];
    const genericMatches = parameterNames.filter((name)=>/(^|_)(resource|asset|room|desk|seat|device)_?id$/i.test(name));
    return genericMatches[0] || '';
}
function selectStartTimeField(parameterNames) {
    return parameterNames.find((name)=>/^(start|from)(time|date)?$/i.test(name)) || '';
}
function selectEndTimeField(parameterNames) {
    return parameterNames.find((name)=>/^(end|to)(time|date)?$/i.test(name)) || '';
}
function selectLookupDateField(parameterNames) {
    const strongMatch = parameterNames.find((name)=>/booktime|bookingtime|meetingtime|querytime|targettime/i.test(name));
    if (strongMatch) return strongMatch;
    const dateMatch = parameterNames.find((name)=>/bookdate|meetingdate|querydate|targetdate|(^|_)(date|day)$/i.test(name));
    if (dateMatch) return dateMatch;
    const genericTimeMatch = parameterNames.find((name)=>/time/i.test(name) && !/start|end/i.test(name));
    return genericTimeMatch || '';
}
function collectNormalizedActionToolNames(siteKey, actionCandidates) {
    return actionCandidates.filter(canBuildNormalizedReadTool).map((candidate)=>buildNormalizedActionToolName(candidate.toolName || `${siteKey}.${candidate.actionName}_draft`));
}
function collectSemanticReadToolNames(siteKey, actionCandidates) {
    const candidate = selectSemanticReadCandidate(actionCandidates);
    if (!candidate) return [];
    const names = [
        `${siteKey}.list_resources`
    ];
    if (hasAvailabilityHints(candidate)) {
        names.push(`${siteKey}.find_available_resources`);
    }
    return names;
}
function collectActionPlanToolNames(siteKey, actionCandidates) {
    const semanticReadCandidate = selectSemanticReadCandidate(actionCandidates);
    if (!semanticReadCandidate) return [];
    return actionCandidates.flatMap((candidate)=>{
        if (!canBuildPrepareActionTool(siteKey, candidate, semanticReadCandidate)) return [];
        return [
            buildPrepareActionToolName(siteKey, candidate.actionName),
            buildPlanActionToolName(siteKey, candidate.actionName)
        ];
    });
}
function buildPrepareActionToolName(siteKey, actionName) {
    return `${siteKey}.prepare_${toSafeIdentifier(actionName)}`;
}
function buildPlanActionToolName(siteKey, actionName) {
    return `${siteKey}.plan_${toSafeIdentifier(actionName)}`;
}
function canBuildPrepareActionTool(siteKey, candidate, semanticReadCandidate) {
    if (!semanticReadCandidate) return false;
    if ((candidate.method || '').toUpperCase() === 'GET') return false;
    const planningHints = buildActionPlanningHints(siteKey, candidate, semanticReadCandidate);
    return typeof planningHints?.resourceIdParameter === 'string' && Boolean(planningHints.resourceIdParameter) && Array.isArray(planningHints.resourceLookupToolNames) && planningHints.resourceLookupToolNames.length > 0;
}
export function selectApis(memory, actionCandidates) {
    const sorted = collectRankedListCandidates(memory, actionCandidates.length > 0);
    return {
        primary: sorted[0] || null,
        secondary: sorted[1] || null
    };
}
function collectRankedListCandidates(memory, hasActionCandidates) {
    const merged = new Map();
    for (const candidate of memory.listApiCandidates){
        merged.set(candidateKey(candidate), candidate);
    }
    for (const candidate of extractVerdictApiCandidates(memory.verdictReason)){
        const key = candidateKey(candidate);
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, candidate);
            continue;
        }
        merged.set(key, {
            ...existing,
            sourceSteps: Array.from(new Set([
                ...existing.sourceSteps || [],
                ...candidate.sourceSteps || []
            ]))
        });
    }
    const threshold = hasActionCandidates ? 2 : 0;
    return [
        ...merged.values()
    ].map((candidate)=>({
            candidate,
            score: scoreListCandidate(candidate)
        })).filter((entry)=>entry.score > threshold).sort((left, right)=>{
        if (left.score !== right.score) return right.score - left.score;
        return left.candidate.url.localeCompare(right.candidate.url);
    }).map((entry)=>entry.candidate).slice(0, 2);
}
function extractVerdictApiCandidates(verdictReason) {
    const text = safeString(verdictReason);
    if (!text) return [];
    const matches = text.match(/https?:\/\/[^\s，。；）)]+/g) || [];
    const seen = new Set();
    const candidates = [];
    for (const raw of matches){
        const url = stripTrailingPunctuation(raw);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        candidates.push({
            url,
            method: 'GET',
            requestBodyPreview: '',
            sourceSteps: [
                'verdict_reason'
            ]
        });
    }
    return candidates;
}
function scoreListCandidate(candidate) {
    const probe = `${candidateUrlSignals(candidate.url)} ${candidate.requestBodyPreview || ''}`.toLowerCase();
    let score = 0;
    if (/get[a-z0-9]*list|\/list\b|search|query|getrooms|rooms|availability|calendar|schedule/.test(probe)) score += 3;
    if (/room|rooms|meeting|calendar|availability|schedule/.test(probe)) score += 2;
    if (hasPagingSignals(candidate)) score += 2;
    if (safeString(candidate.requestBodyPreview)) score += 1;
    const method = safeString(candidate.method || 'GET').toUpperCase();
    const responseContentType = safeString(candidate.responseContentType).toLowerCase();
    const responseEvidence = normalizeResponseBodyEvidence(candidate);
    if (method === 'GET' && (/(?:application|text)\/json/.test(responseContentType) || responseEvidence.bodyKind === 'json')) {
        score += 2;
    }
    if ((candidate.sourceSteps || []).some((step)=>step && step !== 'final_network')) score += 1;
    if ((candidate.sourceSteps || []).includes('verdict_reason')) score += 2;
    if (/violation|audit|log|record|records|history|statistics|report/.test(probe)) score -= 3;
    if ((candidate.sourceSteps || []).every((step)=>step === 'final_network') && !safeString(candidate.requestBodyPreview) && !hasQueryParams(candidate.url)) {
        score -= 1;
    }
    return score;
}
function candidateUrlSignals(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return `${parsed.pathname} ${parsed.search}`;
    } catch {
        return rawUrl;
    }
}
function selectActionCandidates(memory) {
    const candidates = Array.isArray(memory.actionApiCandidates) ? [
        ...memory.actionApiCandidates
    ] : [];
    candidates.sort((left, right)=>{
        const leftScore = actionCandidateScore(left);
        const rightScore = actionCandidateScore(right);
        if (leftScore !== rightScore) return rightScore - leftScore;
        return right.capturedAt.localeCompare(left.capturedAt);
    });
    const seen = new Set();
    const result = [];
    for (const candidate of candidates){
        const key = candidate.toolName || `${candidate.actionName} ${(candidate.method || '').toUpperCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
        if (result.length >= 3) break;
    }
    return result;
}
function actionCandidateScore(candidate) {
    let score = 0;
    if (candidate.primarySelection === 'user') score += 100;
    else if (candidate.primarySelection === 'ai' || candidate.aiIsPrimary) score += 30;
    if (candidate.intercepted) score += 4;
    if ((candidate.method || '').toUpperCase() !== 'GET') score += 3;
    const requestEvidence = normalizeRequestBodyEvidence(candidate);
    if (!requestEvidence.bodyOmitted && requestEvidence.bodyKind !== 'none') score += 1;
    if (normalizeResponseBodyEvidence(candidate).bodyKind !== 'none') score += 1;
    if ((candidate.responseContentType || '').toLowerCase().includes('json')) score += 1;
    score += Math.min(Array.isArray(requestEvidence.bodyKeys) ? requestEvidence.bodyKeys.length : 0, 8);
    score += responseHintScore(candidate.responseHints);
    return score;
}
function responseHintScore(hints) {
    if (!hints) return 0;
    let score = 0;
    if (hints.listPath) score += 1;
    if (hints.itemKeys.length > 0) score += 2;
    if (hints.idLikeKeys.length > 0) score += 1;
    if (hints.displayLikeKeys.length > 0) score += 1;
    if (hints.availabilityLikeKeys.length > 0) score += 1;
    if (hints.preferredIdKey) score += 1;
    if (hints.preferredDisplayKey) score += 1;
    if (hints.preferredAvailabilityKey) score += 1;
    return score;
}
function hasUsefulDetailHints(memory) {
    return Boolean(memory.detailHints.bestCandidateHref || memory.detailHints.bestCandidateText || memory.detailHints.networkDetailCandidates.length > 0);
}
function hasPagingSignals(candidate) {
    const probe = `${candidate.url} ${candidate.requestBodyPreview || ''}`.toLowerCase();
    return /currentpage|pagesize|page=|pagecount|limit=|offset=/.test(probe);
}
function deriveCandidateDefaults(candidate) {
    const transport = inferCandidateTransport(candidate);
    return {
        defaults: {},
        transport
    };
}

function summarizeKnowledgeRequestEvidence(evidence) {
    if (!evidence || evidence.bodyKind === 'none') return { kind: 'empty', keys: [] };
    if (evidence.bodyOmitted || evidence.bodyKind === 'opaque') {
        return { kind: 'opaque', keys: [], bodyTruncated: Boolean(evidence.bodyTruncated), bodyOmitted: true };
    }
    const properties = evidence.bodyShape?.type === 'object' && evidence.bodyShape.properties && typeof evidence.bodyShape.properties === 'object'
        ? evidence.bodyShape.properties
        : {};
    const keys = Object.keys(properties).filter((key)=>!isSensitiveKnowledgeKey(key)).sort().slice(0, 80);
    return {
        kind: evidence.bodyKind === 'form' ? 'form' : evidence.bodyShape?.type || evidence.bodyKind,
        keys,
        fieldTypes: Object.fromEntries(keys.map((key)=>[key, safeString(properties[key]?.type) || 'unknown'])),
        bodyTruncated: Boolean(evidence.bodyTruncated),
        bodyOmitted: Boolean(evidence.bodyOmitted)
    };
}
function inferCandidateTransport(candidate) {
    const method = (candidate.method || 'GET').toUpperCase();
    if (method === 'GET') return 'get_query';
    const evidence = normalizeRequestBodyEvidence(candidate);
    if (evidence.bodyKind === 'json') return 'post_json';
    return 'post_form';
}
function buildSensitiveActionFieldConfigs(parameterNames) {
    const resourceIdParameter = selectResourceReferenceField(parameterNames);
    const startTimeField = selectStartTimeField(parameterNames);
    const endTimeField = selectEndTimeField(parameterNames);
    return [
        resourceIdParameter ? {
            fieldName: resourceIdParameter,
            warningCode: 'resource_id_uses_captured_default'
        } : null,
        startTimeField ? {
            fieldName: startTimeField,
            warningCode: 'start_time_uses_captured_default'
        } : null,
        endTimeField ? {
            fieldName: endTimeField,
            warningCode: 'end_time_uses_captured_default'
        } : null
    ].filter((config)=>Boolean(config));
}
function deriveActionCandidateDefaults(candidate) {
    const transport = inferActionCandidateTransport(candidate);
    return {
        defaults: {},
        transport
    };
}
function inferActionCandidateTransport(candidate) {
    const method = (candidate.method || 'GET').toUpperCase();
    if (method === 'GET') return 'get_query';
    const evidence = normalizeRequestBodyEvidence(candidate);
    if (evidence.bodyKind === 'json') return 'post_json';
    return 'post_form';
}
function parseCandidateBodyDefaults(preview) {
    const normalized = safeString(preview);
    if (!normalized) return {};
    if (normalized.startsWith('{') || normalized.startsWith('[')) {
        try {
            const parsed = JSON.parse(normalized);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? Object.fromEntries(Object.entries(parsed).filter(([, value])=>!isStructuralPlaceholderValue(value)))
                : {};
        } catch {
            return {};
        }
    }
    return parseFormBodyPreview(normalized);
}
function parseUrlQueryDefaults(input) {
    try {
        const parsed = new URL(input);
        const result = {};
        for (const [key, value] of parsed.searchParams.entries()){
            if (isSensitiveKnowledgeKey(key) || isStructuralPlaceholderValue(value)) continue;
            result[key] = coerceStringValue(value);
        }
        return result;
    } catch  {
        return {};
    }
}
function stripRequestUrlQuery(input) {
    try {
        const parsed = new URL(input);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch  {
        return safeString(input).split(/[?#]/, 1)[0];
    }
}
function parseFormBodyPreview(preview) {
    const params = new URLSearchParams(preview || '');
    const result = {};
    for (const [key, value] of params.entries()){
        if (isStructuralPlaceholderValue(value)) continue;
        result[key] = coerceStringValue(value);
    }
    return result;
}
function parseActionRequestPreview(preview) {
    const normalized = safeString(preview);
    if (!normalized) return {};
    try {
        return JSON.parse(normalized);
    } catch  {
        if (normalized.startsWith('{') || normalized.startsWith('[') || /\[truncated\]/i.test(normalized)) return {};
        const form = parseFormBodyPreview(normalized);
        return Object.keys(form).length > 0 ? form : {};
    }
}
function isStructuralPlaceholderValue(value) {
    return typeof value === 'string' && /^(?::value|<value>|\[redacted\])$/i.test(value.trim());
}
function buildCapturedFieldsSchema(defaults, descriptionPrefix, parameterDescriptions = {}, parameterNames = []) {
    const properties = {};
    for (const key of [...new Set([...Object.keys(defaults), ...parameterNames].filter(Boolean))]){
        const hasDefault = Object.prototype.hasOwnProperty.call(defaults, key);
        const value = defaults[key];
        properties[key] = {
            ...(hasDefault ? inferJsonSchema(value) : { type: 'string' }),
            description: parameterDescriptions[key] || `${descriptionPrefix}: ${key}`,
            ...(hasDefault ? { default: value } : {})
        };
    }
    return {
        type: 'object',
        properties,
        required: []
    };
}
function buildActionToolSchema(payload, parameterDescriptions = {}) {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        return {
            type: 'object',
            properties: {
                payload: {
                    type: 'object',
                    description: '完整动作请求 JSON 载荷。',
                    default: payload
                }
            },
            required: []
        };
    }
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(payload)){
        properties[key] = {
            ...inferJsonSchema(value),
            description: parameterDescriptions[key] || `动作请求默认字段：${key}`,
            default: value
        };
        if (!isOptionalDefaultValue(value)) {
            required.push(key);
        }
    }
    return {
        type: 'object',
        properties,
        required
    };
}
function stripSchemaDefaults(value) {
    if (Array.isArray(value)) {
        return value.map((item)=>stripSchemaDefaults(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const result = {};
    for (const [key, nested] of Object.entries(value)){
        if (key === 'default') continue;
        result[key] = stripSchemaDefaults(nested);
    }
    return result;
}
function buildConfirmedActionToolSchema(schema) {
    return stripSchemaDefaults(schema);
}
function markActionSchemaForConfirmation(schema, candidate, shouldConfirm) {
    if (!shouldConfirm) return schema;
    return {
        ...schema,
        'x-webcli-requires-confirmation': true,
        'x-webcli-confirmation-message': `将执行 ${candidate.actionName || '当前动作'}，并调用真实业务接口。请确认参数无误后继续。`
    };
}
function inferJsonSchema(value) {
    if (Array.isArray(value)) {
        const first = value[0];
        return {
            type: 'array',
            items: first === undefined ? {} : inferJsonSchema(first)
        };
    }
    if (value && typeof value === 'object') {
        const properties = {};
        const required = [];
        for (const [key, nested] of Object.entries(value)){
            properties[key] = inferJsonSchema(nested);
            if (!isOptionalDefaultValue(nested)) required.push(key);
        }
        return {
            type: 'object',
            properties,
            required
        };
    }
    if (typeof value === 'number') return {
        type: 'number'
    };
    if (typeof value === 'boolean') return {
        type: 'boolean'
    };
    return {
        type: 'string'
    };
}
function buildQuickPrompts(memory, semanticConfig) {
    if (Array.isArray(semanticConfig?.quickPrompts) && semanticConfig.quickPrompts.length > 0) {
        return semanticConfig.quickPrompts.slice(0, 3);
    }
    const prompts = [];
    const firstAction = memory.actionApiCandidates[0];
    if (firstAction?.toolName) {
        prompts.push(`帮我调用 ${semanticConfig?.getToolName(firstAction.toolName) || firstAction.toolName}，先查看并按需调整参数`);
    }
    if (memory.listApiCandidates[0]) {
        prompts.push(`帮我读取 ${memory.siteHost} 的列表数据`);
    }
    if (prompts.length === 0) {
        prompts.push(`帮我探索 ${memory.siteHost} 的可复用接口`);
    }
    return prompts;
}
function renderActionResponseHintSentence(candidate) {
    const hints = candidate.responseHints;
    if (!hints) return '';
    const parts = [];
    if (hints.listPath) parts.push(`响应列表路径为 ${hints.listPath}`);
    if (hints.idLikeKeys.length > 0) parts.push(`ID 类字段有 ${hints.idLikeKeys.join(', ')}`);
    if (hints.displayLikeKeys.length > 0) parts.push(`展示字段有 ${hints.displayLikeKeys.join(', ')}`);
    if (hints.availabilityLikeKeys.length > 0) parts.push(`可用性字段有 ${hints.availabilityLikeKeys.join(', ')}`);
    if (hints.preferredIdKey) parts.push(`推荐 ID 字段为 ${hints.preferredIdKey}`);
    if (hints.preferredDisplayKey) parts.push(`推荐展示字段为 ${hints.preferredDisplayKey}`);
    if (hints.preferredAvailabilityKey) parts.push(`推荐可用性字段为 ${hints.preferredAvailabilityKey}`);
    if (parts.length === 0) return '';
    return ` 响应结构提示：${parts.join('；')}。`;
}
function renderActionHintLines(siteKey, candidate, semanticReadCandidate) {
    const hints = candidate.responseHints;
    const lines = [];
    if (hints) {
        if (hints.listPath) lines.push(`- 响应列表路径（${candidate.actionName}）：${hints.listPath}`);
        if (hints.itemKeys.length > 0) lines.push(`- 响应项字段（${candidate.actionName}）：${hints.itemKeys.join(', ')}`);
        if (hints.idLikeKeys.length > 0) lines.push(`- ID 类字段（${candidate.actionName}）：${hints.idLikeKeys.join(', ')}`);
        if (hints.displayLikeKeys.length > 0) lines.push(`- 展示字段（${candidate.actionName}）：${hints.displayLikeKeys.join(', ')}`);
        if (hints.availabilityLikeKeys.length > 0) lines.push(`- 可用性字段（${candidate.actionName}）：${hints.availabilityLikeKeys.join(', ')}`);
        if (hints.preferredIdKey) lines.push(`- 推荐 ID 字段（${candidate.actionName}）：${hints.preferredIdKey}`);
        if (hints.preferredDisplayKey) lines.push(`- 推荐展示字段（${candidate.actionName}）：${hints.preferredDisplayKey}`);
        if (hints.preferredAvailabilityKey) lines.push(`- 推荐可用性字段（${candidate.actionName}）：${hints.preferredAvailabilityKey}`);
    }
    const planningHints = buildActionPlanningHints(siteKey, candidate, semanticReadCandidate);
    if (planningHints) {
        const parameterNames = Array.isArray(planningHints.parameterNames) ? planningHints.parameterNames.filter(Boolean) : [];
        const resourceIdParameter = typeof planningHints.resourceIdParameter === 'string' ? planningHints.resourceIdParameter : '';
        const resourceLookupToolNames = Array.isArray(planningHints.resourceLookupToolNames) ? planningHints.resourceLookupToolNames.filter((value)=>typeof value === 'string' && Boolean(value)) : [];
        const availabilityLookupToolName = typeof planningHints.availabilityLookupToolName === 'string' ? planningHints.availabilityLookupToolName : '';
        const startTimeParameter = typeof planningHints.startTimeParameter === 'string' ? planningHints.startTimeParameter : '';
        const endTimeParameter = typeof planningHints.endTimeParameter === 'string' ? planningHints.endTimeParameter : '';
        if (parameterNames.length > 0) lines.push(`- 动作参数字段（${candidate.actionName}）：${parameterNames.join(', ')}`);
        if (resourceIdParameter) lines.push(`- 资源 ID 参数（${candidate.actionName}）：${resourceIdParameter}`);
        if (resourceLookupToolNames.length > 0) lines.push(`- 建议配合使用的资源查询工具（${candidate.actionName}）：${resourceLookupToolNames.join(', ')}`);
        if (availabilityLookupToolName) lines.push(`- 建议配合使用的可用性筛选工具（${candidate.actionName}）：${availabilityLookupToolName}`);
        if (startTimeParameter || endTimeParameter) lines.push(`- 时间参数（${candidate.actionName}）：${startTimeParameter || '?'} -> ${endTimeParameter || '?'}`);
    }
    return lines;
}
function canBuildNormalizedReadTool(candidate) {
    const method = (candidate.method || '').toUpperCase();
    const hints = candidate.responseHints;
    return method === 'GET' && Boolean(hints?.listPath);
}
function buildNormalizedActionToolName(toolName) {
    return /_draft$/.test(toolName) ? toolName.replace(/_draft$/, '_normalized') : `${toolName}_normalized`;
}
function buildNormalizedActionToolSchema(defaults, parameterDescriptions = {}) {
    const base = buildCapturedFieldsSchema(defaults, '动作请求中的默认字段', parameterDescriptions);
    return {
        ...base,
        properties: {
            ...base.properties,
            availabilitySlot: {
                type: 'string',
                description: '可选的可用时段键，例如 2026-05-14T14:30。',
                default: ''
            },
            query: {
                type: 'string',
                description: '可选关键字，会对归一化后的 id 和 display 字段做不区分大小写匹配。',
                default: ''
            },
            resourceId: {
                type: 'string',
                description: '可选的精确资源 ID 过滤条件。',
                default: ''
            },
            onlyAvailable: {
                type: 'boolean',
                description: '为 true 时，只保留在指定时段内看起来可用的资源。',
                default: false
            },
            limit: {
                type: 'number',
                description: '可选，限制返回的最大资源数量。',
                default: 0
            }
        },
        required: []
    };
}
function buildPrepareActionToolSchema(defaults, resourceIdParameter) {
    const base = stripSchemaDefaults(buildActionToolSchema(defaults));
    return {
        ...base,
        properties: {
            ...base.properties,
            resourceQuery: {
                type: 'string',
                description: 'Optional query matched against normalized resource id/display fields before preparing the action payload.',
                default: ''
            },
            resourceId: {
                type: 'string',
                description: `Optional explicit resource id. When provided, it is copied into ${resourceIdParameter} unless that action field is already set.`,
                default: ''
            },
            availabilitySlot: {
                type: 'string',
                description: 'Optional availability slot key to validate before preparing the action payload.',
                default: ''
            },
            lookupArgs: {
                type: 'object',
                description: 'Optional arguments passed through to the generated resource lookup tool.',
                default: {}
            },
            requireAvailable: {
                type: 'boolean',
                description: 'When true, availabilitySlot lookup only accepts resources that look available.',
                default: true
            },
            limit: {
                type: 'number',
                description: 'Maximum number of normalized lookup resources to inspect.',
                default: 5
            }
        },
        required: []
    };
}
function buildPlanActionToolSchema(defaults) {
    const actionSchema = stripSchemaDefaults(buildActionToolSchema(defaults));
    return {
        type: 'object',
        properties: {
            instruction: {
                type: 'string',
                description: 'Natural-language instruction to plan from. The generated planner only extracts generic resource and time hints.',
                default: ''
            },
            resourceQuery: {
                type: 'string',
                description: 'Optional explicit resource query. Overrides resource words inferred from instruction.',
                default: ''
            },
            availabilitySlot: {
                type: 'string',
                description: 'Optional explicit availability slot key. Overrides inferred start-time slot.',
                default: ''
            },
            startTime: {
                type: 'string',
                description: 'Optional explicit start time to copy into the action payload when a matching action field exists.',
                default: ''
            },
            endTime: {
                type: 'string',
                description: 'Optional explicit end time to copy into the action payload when a matching action field exists.',
                default: ''
            },
            lookupArgs: {
                type: 'object',
                description: 'Optional arguments passed through to the generated resource lookup tool.',
                default: {}
            },
            actionOverrides: {
                type: 'object',
                description: 'Optional action field overrides merged into the prepared payload.',
                default: {},
                properties: actionSchema.properties
            },
            requireAvailable: {
                type: 'boolean',
                description: 'When true, availabilitySlot lookup only accepts resources that look available.',
                default: true
            },
            limit: {
                type: 'number',
                description: 'Maximum number of normalized lookup resources to inspect.',
                default: 5
            }
        },
        required: [
            'instruction'
        ]
    };
}
function selectSemanticReadCandidate(actionCandidates) {
    return actionCandidates.find((candidate)=>canBuildNormalizedReadTool(candidate)) || null;
}
function hasAvailabilityHints(candidate) {
    const hints = candidate.responseHints;
    return Boolean(hints?.preferredAvailabilityKey || (hints?.availabilityLikeKeys?.length || 0) > 0);
}
function buildSemanticListResourcesSchema(candidate) {
    const defaults = deriveActionCandidateDefaults(candidate).defaults;
    const base = buildNormalizedActionToolSchema(defaults);
    const properties = {
        ...base.properties
    };
    delete properties.onlyAvailable;
    return {
        ...base,
        properties,
        required: []
    };
}
function buildSemanticFindAvailableSchema(candidate) {
    const defaults = deriveActionCandidateDefaults(candidate).defaults;
    const base = buildNormalizedActionToolSchema(defaults);
    return {
        ...base,
        required: [
            'availabilitySlot'
        ]
    };
}
function isOptionalDefaultValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
}
function candidateKey(candidate) {
    const method = (candidate.method || 'GET').toUpperCase();
    const rawUrl = stripTrailingPunctuation(candidate.url);
    try {
        const parsed = new URL(rawUrl);
        parsed.search = '';
        parsed.hash = '';
        return `${method} ${parsed.toString()}`;
    } catch  {
        return `${method} ${rawUrl.split(/[?#]/, 1)[0]}`;
    }
}
function stripTrailingPunctuation(url) {
    return url.replace(/[，。；）)\],]+$/g, '');
}
function hasQueryParams(input) {
    try {
        const parsed = new URL(input);
        return [
            ...parsed.searchParams.keys()
        ].length > 0;
    } catch  {
        return false;
    }
}
function coerceStringValue(value) {
    if (/^-?\d+$/.test(value)) return Number(value);
    return value;
}
function toSafeFileToken(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
function toSafeIdentifier(value) {
    return value.replace(/[^a-zA-Z0-9_$]+/g, '_').replace(/^[^a-zA-Z_$]+/, '_');
}
function arraysEqual(left, right) {
    if (left.length !== right.length) return false;
    return left.every((value, index)=>value === right[index]);
}
function safeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function serializeJsValue(value) {
    return JSON.stringify(value, null, 2);
}
