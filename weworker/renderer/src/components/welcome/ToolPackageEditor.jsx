import AppSwitch from '../common/AppSwitch.jsx'
import SkillAddMenu from './SkillAddMenu.jsx'
import { skillDirectoryName, withInstalledSkillState, publicSkillEntries } from '../../utils/skill-management.js'
import { selectCatalogSkills, skillSelectionKey, findSelectedSkill, formatSkillCreatedAt } from '../../utils/skill-catalog.js'
import { RightOutlined, FileTextOutlined, FolderOutlined, PlusOutlined, SortAscendingOutlined } from '@ant-design/icons'
import './skill-files.css'
import SkillTags from './SkillTags.jsx'
import { SKILL_TAGS_STORAGE_KEY, skillTagKey, normalizeSkillTags, skillTags, loadSkillTagOverrides } from '../../utils/skill-tags.js'
import AppDropdownSelect, { DropdownMenuCheck } from '../common/AppDropdownSelect.jsx'
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createSiteScenario, deleteSiteScenario, fetchCustomSkillDirectory, fetchPublicSkillDirectory, importCustomSkillResources, importPublicSkillResources, importPublicSkillZipPath, loadSkillResourcePreview, resetSiteScenario, updateSiteCustomSkills, updateSiteScenario } from '../../api/sites-api.js'
import { buildPreviewExtensionSet, enrichResourcesForPreview, isReadableResourceName } from '../../utils/resource-preview-extensions.js'
import customSkillTemplateMarkdown from './custom-skill-template.md?raw'
import {
  BUILTIN_PLACEHOLDER_USAGE,
  buildBuiltinVariableHelpEntries,
  buildOfficialAdapterToolSection,
} from './custom-skill-builtins.js'
import SkillMarkdownCodeTextarea from './SkillMarkdownCodeTextarea.jsx'
import { useFitTextareaHeight } from './use-fit-textarea-height.js'
import {
  CODE_EDITOR_FONT_SIZE,
  CODE_EDITOR_LINE_HEIGHT,
  codeEditorFitHeight,
  codeEditorLineNumberRowStyle,
  countEditorLines,
} from './code-editor-metrics.js'
import { FileIcon, FolderIcon, EyeIcon, RefreshIcon } from '../icons/PanelIcons.jsx'
import {
  DROPDOWN_MENU_DIVIDER_CLASS,
  DROPDOWN_MENU_ITEM_CLASS,
  DROPDOWN_MENU_LIST_CLASS,
  dropdownMenuItemClassName,
} from '../common/dropdown-menu-styles.js'
import { DropdownMenuPortal, useDropdownDismiss } from '../common/DropdownMenuPortal.jsx'
import { BackIcon, PanelExpandIcon, PanelHideIcon } from './WelcomeIcons.jsx'
import { filterScenarios } from './welcome-utils.js'
import { SKILL_SCOPE_PUBLIC, SKILL_SCOPE_SITE, useToolPackagePageStore } from '../../store/tool-package-page.js'
import { useSitesStore } from '../../store/sites.js'
import { useSettingsStore } from '../../store/settings.js'
import { resolveSkillDirectoryPath } from '../../utils/skill-directory-path.js'
import { parseSkillMarkdownMeta } from '../../utils/skill-markdown-meta.js'
import {
  findDuplicateCustomSkillName,
  findDuplicateCustomSkillNameForSkill,
} from '../../utils/custom-skill-duplicates.js'
import { backendFetch } from '../../api/http.js'
import { showAlert, showConfirm } from '../../store/dialog.js'

const SKILLS_API = 'http://127.0.0.1:8765'
const PUBLIC_BUILTIN_SKILL_NAMES = new Set(['webcli', 'personal-codewords', 'complex-task-planner'])
const PUBLIC_BUILTIN_DEFAULT_DESCRIPTIONS = {
  webcli: 'WebCLI 浏览器自动化',
  'personal-codewords': '个人暗号',
  'complex-task-planner': '复杂多步骤任务规划与分步执行',
}

const STORAGE_PREFIX = 'weworker:custom-skills:'
const SEARCH_FIELD_BACKGROUND = 'var(--bg-secondary)'
const EMPTY_PARAM = { name: '', type: 'string', description: '', required: false }
const DEFAULT_SIDE_PANE_WIDTH = 220
const MIN_SIDE_PANE_WIDTH = 180
const MAX_SIDE_PANE_WIDTH = 420
const RESIZE_HANDLE_WIDTH = 6
const MIN_EDITOR_PANE_WIDTH = 140
const MIN_RIGHT_PANE_WIDTH = 120
const LIST_ITEM_HEIGHT = 72
const WORKSPACE_TAB_SKILLS = 'skills'
const WORKSPACE_TAB_SCENARIOS = 'scenarios'
const TOOLKIT_KIND_SCENE = 'scene'
const TOOLKIT_KIND_BUILTIN = 'builtin'
const UNSAVED_SCENARIO_MESSAGE = '当前场景有未保存修改，切换后将丢失，是否继续？'
const DEFAULT_NEW_FILE_NAME = 'untitled.txt'
const DEFAULT_FOLDER_NAME = '新建文件夹'
const FORCE_RESOURCE_PREVIEW_MAX_BYTES = 256 * 1024

function makeSkillId() {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeScenarioId() {
  return `custom-scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeParams(parameters) {
  if (!Array.isArray(parameters)) return []
  return parameters.map((param) => ({
    name: param?.name || '',
    type: param?.type || 'string',
    description: param?.description || '',
    required: Boolean(param?.required),
  }))
}

function normalizeResources(resources) {
  if (!Array.isArray(resources)) return []
  return resources
    .map((resource) => ({
      name: resource?.name || resource?.relativePath?.split('/')?.pop() || '',
      relativePath: resource?.relativePath || '',
      size: Number.isFinite(resource?.size) ? resource.size : 0,
      modified_at: resource?.modified_at || '',
      is_directory: resource?.is_directory === true,
      readable: resource?.readable === true,
      content: typeof resource?.content === 'string' ? resource.content : undefined,
    }))
    .filter((resource) => resource.relativePath)
}

function normalizeTool(tool, source = 'official') {
  const knownSource = tool?.source
  const resolvedSource = knownSource === 'custom'
    || knownSource === 'public-custom'
    || knownSource === 'public-skill'
    || knownSource === 'official-skill'
    || knownSource === 'system'
    ? knownSource
    : source
  return {
    id: tool.id || tool.name || makeSkillId(),
    name: tool.name || '',
    description: tool.description || '',
    parameters: normalizeParams(tool.parameters),
    markdown: typeof tool.markdown === 'string' ? tool.markdown : customSkillTemplateMarkdown,
    resources: normalizeResources(tool.resources),
    enabled: tool.enabled !== false,
    draft: tool.draft === true,
    directoryName: tool.directoryName,
    createdAt: tool.createdAt,
    creationOrderKey: tool.creationOrderKey,
    promptOnly: tool.promptOnly === true,
    source: resolvedSource,
  }
}

function attachToolSite(tool, toolSite) {
  return {
    ...tool,
    siteId: toolSite?.id || '',
    siteName: toolSite?.name || '',
  }
}

function toolKey(tool) {
  return `${tool.source}:${tool.siteId || ''}:${tool.id || tool.name}`
}

function loadCustomSkills(siteId) {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${siteId}`)
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.map((item) => normalizeTool(item, 'custom')) : []
  } catch {
    return []
  }
}

function clearLocalCustomSkills(siteId) {
  try {
    window.localStorage.removeItem(`${STORAGE_PREFIX}${siteId}`)
  } catch {
    // localStorage may be unavailable.
  }
}

function normalizeCustomSkills(skills) {
  return Array.isArray(skills) ? skills.map((item) => normalizeTool(item, 'custom')) : []
}

function initialCustomSkills(site) {
  const localSkills = loadCustomSkills(site.id)
  if (localSkills.length > 0) return localSkills
  return normalizeCustomSkills(site.customSkills)
}

function loadCustomSkillsForSite(toolSite) {
  const localSkills = loadCustomSkills(toolSite.id)
  if (localSkills.length > 0) return localSkills
  return normalizeCustomSkills(toolSite.customSkills)
}

function buildInitialCustomSkillsBySite(siteList, currentSite) {
  const map = {}
  for (const toolSite of siteList) {
    map[toolSite.id] = toolSite.id === currentSite.id
      ? initialCustomSkills(currentSite)
      : loadCustomSkillsForSite(toolSite)
  }
  return map
}

function scenarioKey(scenario) {
  return scenario?._toolPackageKey || scenario?.id || scenario?.title || ''
}

function resolveScenarioApiId(scenario) {
  return scenario?.id || scenario?.title || ''
}

function resolveScenarioSiteId(scenario, scenarioSiteIds = [], fallbackSiteId = '') {
  return scenario?._toolPackageSiteId || scenarioSiteIds[0] || fallbackSiteId || ''
}

function normalizeScenarioForEditor(scenario, index) {
  const id = scenario?.id || scenario?.title || `scenario-${index}`
  const siteId = scenario?._toolPackageSiteId || ''
  const compositeKey = siteId ? `${siteId}:${id}` : id
  return {
    ...scenario,
    id: scenario?.id || id,
    _toolPackageKey: scenario?._toolPackageKey || compositeKey,
    updatedAt: scenario.updatedAt || scenario.updated_at || '',
  }
}

function isUserScenario(scenario) {
  return scenario?.source === 'user'
}

function scenarioSourceBadgeLabel(scenario) {
  return isUserScenario(scenario) ? '场景信息 · 自定义 · 可编辑' : '场景信息 · 官方只读'
}

function mergeScenarioListForEditor(scenarios, previousScenarios = []) {
  const previousByKey = new Map(previousScenarios.map((scenario) => [scenarioKey(scenario), scenario]))
  return (scenarios || []).map((scenario, index) => {
    const normalized = normalizeScenarioForEditor(scenario, index)
    const previous = previousByKey.get(scenarioKey(normalized))
    return {
      ...normalized,
      _toolPackageSiteId: normalized._toolPackageSiteId || previous?._toolPackageSiteId || '',
      _toolPackageSiteName: normalized._toolPackageSiteName || previous?._toolPackageSiteName || '',
      updatedAt: normalized.updatedAt || previous?.updatedAt || '',
    }
  })
}

function createEmptySkill(siteId) {
  return {
    id: makeSkillId(),
    name: `${siteId}.new_skill`,
    description: '',
    parameters: [{ ...EMPTY_PARAM }],
    markdown: customSkillTemplateMarkdown,
    resources: [],
    source: 'custom',
    promptOnly: true,
  }
}

function cloneAsCustom(tool) {
  return {
    ...normalizeTool(tool, 'custom'),
    directoryName: undefined,
    createdAt: undefined,
    creationOrderKey: undefined,
    draft: false,
    id: makeSkillId(),
    name: `${tool.name || 'custom.skill'}_copy`,
    markdown: buildOfficialToolMarkdown({ ...tool, name: `${tool.name || 'custom.skill'}_copy` }),
    resources: [],
    source: 'custom',
    promptOnly: true,
  }
}

function formatSkillResourcePath(skillPath, relativePath) {
  const base = String(skillPath || '').replace(/\/+$/, '')
  const rel = String(relativePath || '').replace(/^\/+/, '').replace(/\\/g, '/')
  return rel ? `${base}/${rel}` : base
}

function buildResourceHint(resource, skillName) {
  const relativePath = resource.relativePath || resource.name || ''
  const normalized = relativePath.replace(/\\/g, '/')
  const fileName = normalized.split('/').filter(Boolean).pop() || resource.name || normalized
  const skillPath = skillName ? '{{skill.path}}' : '当前 skill 目录'
  const fullPath = formatSkillResourcePath(skillPath, normalized)
  return `本技能所需文件 \`${fileName}\` 的路径为 \`${fullPath}\`。`
}

function getResourceFileToken(resource) {
  const relativePath = resource?.relativePath || resource?.name || ''
  const normalized = String(relativePath).replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || resource?.name || normalized
}

function hasResourceHintForFile(markdown, resource) {
  const fileToken = getResourceFileToken(resource)
  if (!fileToken) return false
  return String(markdown || '').split('\n').some((line) => (
    isResourceHintLine(line) && line.includes(`\`${fileToken}\``)
  ))
}

function appendResourceHintForResource(markdown, resource, skillName) {
  if (!resource || resource.is_directory === true) return String(markdown || '')
  if (hasResourceHintForFile(markdown, resource)) return String(markdown || '')
  const hint = buildResourceHint(resource, skillName)
  if (!hint) return String(markdown || '')
  const body = String(markdown || '').replace(/\s+$/, '')
  return body ? `${body}\n\n${hint}` : hint
}

function appendResourceHintsForAddedFiles(markdown, previousResources, nextResources, skillName) {
  const previousPaths = new Set(
    (previousResources || [])
      .filter((resource) => resource.is_directory !== true)
      .map((resource) => normalizeResourcePath(resource.relativePath)),
  )
  const addedFiles = (nextResources || []).filter((resource) => {
    if (resource.is_directory === true) return false
    const path = normalizeResourcePath(resource.relativePath)
    return path && !previousPaths.has(path)
  })
  return addedFiles.reduce(
    (current, resource) => appendResourceHintForResource(current, resource, skillName),
    markdown,
  )
}

function findResourceByPath(resources, relativePath) {
  const normalized = normalizeResourcePath(relativePath)
  return (resources || []).find((resource) => normalizeResourcePath(resource.relativePath) === normalized) || null
}

function isResourceHintLine(line) {
  return String(line || '').trim().startsWith('本技能所需文件 ')
}

function stripResourceHints(markdown) {
  const lines = String(markdown || '').split('\n')
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start += 1
  while (start < end && isResourceHintLine(lines[start])) start += 1
  while (start < end && lines[start].trim() === '') start += 1
  while (end > start && lines[end - 1].trim() === '') end -= 1
  while (end > start && isResourceHintLine(lines[end - 1])) end -= 1
  while (end > start && lines[end - 1].trim() === '') end -= 1
  return lines.slice(start, end).join('\n')
}

function buildResourceTree(resources) {
  const root = { type: 'folder', name: '', path: '', children: [] }
  for (const resource of resources || []) {
    const parts = String(resource.relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) continue
    let parent = root
    parts.forEach((part, index) => {
      const pathKey = parts.slice(0, index + 1).join('/')
      const isFile = index === parts.length - 1 && resource.is_directory !== true
      let node = parent.children.find((child) => child.name === part && child.path === pathKey)
      if (!node) {
        node = isFile
          ? { type: 'file', name: part, path: pathKey, resource }
          : { type: 'folder', name: part, path: pathKey, children: [] }
        parent.children.push(node)
        parent.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      }
      if (node.type === 'folder' && index === parts.length - 1 && resource.is_directory === true) {
        node.resource = resource
      }
      if (node.type === 'folder') parent = node
    })
  }
  return root
}

function normalizeResourcePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function existingResourcePaths(resources) {
  return new Set((resources || []).map((resource) => normalizeResourcePath(resource.relativePath)).filter(Boolean))
}

function joinResourcePath(parentPath, name) {
  const parent = normalizeResourcePath(parentPath)
  const child = normalizeResourcePath(name)
  if (!parent) return child
  if (!child) return parent
  return `${parent}/${child}`
}

function makeUniqueResourcePath(resources, desiredPath) {
  const paths = existingResourcePaths(resources)
  const normalized = normalizeResourcePath(desiredPath)
  if (!paths.has(normalized)) return normalized
  const parts = normalized.split('/').filter(Boolean)
  const baseName = parts.pop() || normalized
  const prefix = parts.length ? `${parts.join('/')}/` : ''
  const dot = baseName.lastIndexOf('.')
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName
  const ext = dot > 0 ? baseName.slice(dot) : ''
  let index = 2
  while (paths.has(`${prefix}${stem} (${index})${ext}`)) index += 1
  return `${prefix}${stem} (${index})${ext}`
}

function buildResourceEntry({ relativePath, isDirectory = false, content = '', previewExtensions }) {
  const normalizedPath = normalizeResourcePath(relativePath)
  const name = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath
  const now = new Date().toISOString()
  if (isDirectory) {
    return {
      name,
      relativePath: normalizedPath,
      size: 0,
      modified_at: now,
      is_directory: true,
    }
  }
  const readable = isReadableResourceName(name, previewExtensions)
  return {
    name,
    relativePath: normalizedPath,
    size: readable ? new TextEncoder().encode(content).length : 0,
    modified_at: now,
    is_directory: false,
    readable,
    content: readable ? content : undefined,
  }
}

function appendResourceFolder(resources, folderName = DEFAULT_FOLDER_NAME, parentPath = '', previewExtensions) {
  const relativePath = makeUniqueResourcePath(resources || [], joinResourcePath(parentPath, folderName))
  const entry = buildResourceEntry({ relativePath, isDirectory: true, previewExtensions })
  return {
    resources: [...(resources || []), entry],
    path: relativePath,
  }
}

function appendResourceFile(resources, parentPath = '', fileName = DEFAULT_NEW_FILE_NAME, previewExtensions) {
  const relativePath = makeUniqueResourcePath(resources || [], joinResourcePath(parentPath, fileName))
  const entry = buildResourceEntry({ relativePath, content: '', previewExtensions })
  return {
    resources: [...(resources || []), entry],
    path: relativePath,
  }
}

function resolveFolderParentPath(nodePath) {
  return normalizeResourcePath(nodePath)
}

function getResourceParentPath(nodePath) {
  const normalized = normalizeResourcePath(nodePath)
  const slashIndex = normalized.lastIndexOf('/')
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : ''
}

function removeResourceFile(resources, relativePath) {
  const normalized = normalizeResourcePath(relativePath)
  return (resources || []).filter((resource) => normalizeResourcePath(resource.relativePath) !== normalized)
}

function removeResourcePath(resources, relativePath) {
  const normalized = normalizeResourcePath(relativePath)
  if (!normalized) return resources || []
  return (resources || []).filter((resource) => {
    const path = normalizeResourcePath(resource.relativePath)
    if (path === normalized) return false
    if (path.startsWith(`${normalized}/`)) return false
    return true
  })
}

function resolveRenamedResourcePath(oldPath, newName) {
  const normalizedOld = normalizeResourcePath(oldPath)
  const trimmed = String(newName || '').trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
  if (!trimmed || !normalizedOld) return ''
  const parts = normalizedOld.split('/').filter(Boolean)
  const parentPath = parts.slice(0, -1).join('/')
  return joinResourcePath(parentPath, trimmed)
}

function renameResourceEntry(resources, oldPath, newName) {
  const normalizedOld = normalizeResourcePath(oldPath)
  const desiredPath = resolveRenamedResourcePath(oldPath, newName)
  if (!desiredPath || !normalizedOld) return null
  if (desiredPath === normalizedOld) return resources

  const paths = existingResourcePaths(resources)
  if (paths.has(desiredPath)) return null

  const trimmed = desiredPath.split('/').filter(Boolean).pop() || desiredPath
  return (resources || []).map((resource) => {
    const resourcePath = normalizeResourcePath(resource.relativePath)
    if (resourcePath === normalizedOld) {
      return { ...resource, relativePath: desiredPath, name: trimmed }
    }
    if (resourcePath.startsWith(`${normalizedOld}/`)) {
      const updatedPath = `${desiredPath}${resourcePath.slice(normalizedOld.length)}`
      const updatedName = updatedPath.split('/').filter(Boolean).pop() || updatedPath
      return { ...resource, relativePath: updatedPath, name: updatedName }
    }
    return resource
  })
}

function formatBytes(size) {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function buildForcePreviewConfirmMessage(resource) {
  const relativePath = resource?.relativePath || resource?.name || '文件'
  const name = relativePath.split('/').filter(Boolean).pop() || relativePath
  const sizeLabel = formatBytes(resource?.size || 0)
  const maxLabel = formatBytes(FORCE_RESOURCE_PREVIEW_MAX_BYTES)
  const lines = [
    `「${name}」不在可预览后缀列表中（${sizeLabel}）。`,
    `确认后将从磁盘读取内容，最多加载 ${maxLabel}。`,
  ]
  if ((resource?.size || 0) > FORCE_RESOURCE_PREVIEW_MAX_BYTES) {
    lines.push('较大文件将被截断；二进制文件可能无法显示可读文本。')
  }
  lines.push('', '确定预览吗？')
  return lines.join('\n')
}

function buildOfficialToolMarkdown(tool) {
  const lines = [
    '---',
    `name: "${tool.name || ''}"`,
    `description: "${tool.description || ''}"`,
    '---',
    '',
    `# ${tool.name || '未命名 skill'}`,
    '',
  ]
  if (tool.description) {
    lines.push(tool.description, '')
  }
  if (tool.parameters?.length) {
    lines.push('## 参数', '')
    for (const param of tool.parameters) {
      const required = param.required ? '，必填' : '，可选'
      lines.push(`- \`${param.name || '未命名参数'}\`：${param.type || 'string'}${required}${param.description ? `。${param.description}` : ''}`)
    }
    lines.push('')
  } else {
    lines.push('## 参数', '', '无参数。', '')
  }
  lines.push('## 调用方式', '', '该工具由官方适配器提供，不能在这里修改。')
  return lines.join('\n')
}

function buildOfficialSiteSkill(siteInfo, tools = []) {
  const skillName = `webcli-${siteInfo.id}`
  const lines = [
    '---',
    `name: "${skillName}"`,
    `description: "${siteInfo.description || `${siteInfo.name}: adapter tools`}"`,
    'allowed-tools: Bash(webcli *)',
    '---',
    '',
    `# ${siteInfo.name || siteInfo.id}`,
    '',
  ]
  if (siteInfo.description) lines.push(siteInfo.description, '')
  if (siteInfo.match?.length) lines.push(`Matches: ${siteInfo.match.join(', ')}`, '')
  lines.push(`## Tools (${tools.length})`, '')
  for (const tool of tools) {
    lines.push(buildOfficialAdapterToolSection(tool), '')
  }
  return {
    id: skillName,
    name: skillName,
    description: siteInfo.description || '',
    parameters: [],
    markdown: lines.join('\n'),
    resources: [],
    source: 'official-skill',
    promptOnly: false,
    siteId: siteInfo.id || '',
    siteName: siteInfo.name || '',
  }
}

function summarizeParams(parameters) {
  if (!parameters?.length) return '无参数'
  return parameters
    .slice(0, 3)
    .map((param) => `${param.name || '未命名'}${param.required ? '*' : ''}`)
    .join(', ')
}

function countLines(value) {
  return countEditorLines(value)
}

const SKILL_MD_PATH = 'SKILL.md'
const RESOURCES_SECTION_PATH = '__resources__'

const EditorPaneScrollContext = createContext(null)
const ResourceSectionStickyContext = createContext(() => {})

function isResourceExpandedPath(path) {
  return Boolean(path) && path !== SKILL_MD_PATH && path !== RESOURCES_SECTION_PATH
}

function buildResourcesSectionStickyPath(expandedPath, resources) {
  if (!isResourceExpandedPath(expandedPath)) return '资源文件'
  const normalized = normalizeResourcePath(expandedPath)
  const resource = findResourceByPath(resources, normalized)
  if (!resource || resource.is_directory === true) return '资源文件'
  return `资源文件/${normalized}`
}

function useScrollPastScrollRoot(scrollRef, targetEl) {
  const [scrolledPast, setScrolledPast] = useState(false)

  useEffect(() => {
    const root = scrollRef?.current
    if (!root || !targetEl) {
      setScrolledPast(false)
      return undefined
    }

    const update = () => {
      const rootRect = root.getBoundingClientRect()
      const targetRect = targetEl.getBoundingClientRect()
      setScrolledPast(targetRect.top < rootRect.top - 1)
    }

    update()

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.rootBounds) {
          update()
          return
        }
        setScrolledPast(
          !entry.isIntersecting
          && entry.boundingClientRect.top < entry.rootBounds.top,
        )
      },
      { root, threshold: 0 },
    )
    observer.observe(targetEl)
    root.addEventListener('scroll', update, { passive: true })

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    resizeObserver?.observe(root)
    resizeObserver?.observe(targetEl)

    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', update)
      resizeObserver?.disconnect()
    }
  }, [scrollRef, targetEl])

  return scrolledPast
}

function ResourceFileScrollSentinel({ active }) {
  const sentinelRef = useRef(null)
  const setActiveFileSentinel = useContext(ResourceSectionStickyContext)

  useLayoutEffect(() => {
    if (!active) {
      setActiveFileSentinel(null)
      return undefined
    }
    setActiveFileSentinel(sentinelRef.current)
    return () => setActiveFileSentinel(null)
  }, [active, setActiveFileSentinel])

  if (!active) return null
  return <div ref={sentinelRef} style={resourceFileScrollSentinelStyle} aria-hidden="true" />
}

function ResourcesCollapsibleSection({
  expandedPath,
  resources,
  collapsed,
  onToggle,
  actions,
  meta,
  children,
}) {
  const scrollRef = useContext(EditorPaneScrollContext)
  const [activeFileSentinel, setActiveFileSentinel] = useState(null)
  const scrolledPastFile = useScrollPastScrollRoot(scrollRef, activeFileSentinel)
  const stickyPath = scrolledPastFile
    ? buildResourcesSectionStickyPath(expandedPath, resources)
    : null

  return (
    <ResourceSectionStickyContext.Provider value={setActiveFileSentinel}>
      <CollapsibleSection
        title="资源文件"
        fileIcon={<FolderOutlined />}
        stickyPath={stickyPath}
        meta={meta}
        collapsed={collapsed}
        onToggle={onToggle}
        actions={actions}
      >
        {children}
      </CollapsibleSection>
    </ResourceSectionStickyContext.Provider>
  )
}

function editableScenarioPayload(scenario) {
  return {
    title: scenario?.title || '',
    summary: scenario?.summary || '',
    steps: Array.isArray(scenario?.steps) ? scenario.steps : [],
    prompts: Array.isArray(scenario?.prompts) ? scenario.prompts : [],
  }
}

function serializeScenarioDraft(payload) {
  return JSON.stringify({
    title: payload?.title || '',
    summary: payload?.summary || '',
    steps: Array.isArray(payload?.steps) ? payload.steps : [],
    prompts: (Array.isArray(payload?.prompts) ? payload.prompts : []).map((prompt) => ({
      text: typeof prompt?.text === 'string' ? prompt.text : '',
      reply: typeof prompt?.reply === 'string' ? prompt.reply : '',
    })),
  })
}

function scenarioEditorRevision(scenario) {
  return `${scenarioKey(scenario)}:${scenario?.updatedAt || scenario?.updated_at || ''}`
}

function formatScenarioUpdatedAt(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return '--'
  return `保存于 ${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)}`
}

function formatScenarioUpdatedAtTitle(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return '最近修改：--'
  return `最近修改：${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)}`
}

function clampPaneWidth(width) {
  return Math.min(MAX_SIDE_PANE_WIDTH, Math.max(MIN_SIDE_PANE_WIDTH, width))
}

function computeEffectiveRightPaneWidth({
  workspaceWidth,
  leftPaneWidth,
  preferredRightWidth,
  rightOpen,
}) {
  if (!rightOpen) return 0
  const available = Math.max(0, workspaceWidth - leftPaneWidth - RESIZE_HANDLE_WIDTH)
  if (available <= RESIZE_HANDLE_WIDTH) return 0

  const preferredTotal = preferredRightWidth + RESIZE_HANDLE_WIDTH
  const centerWithPreferred = available - preferredTotal
  if (centerWithPreferred >= MIN_EDITOR_PANE_WIDTH) {
    return preferredRightWidth
  }

  const maxRight = Math.max(
    MIN_RIGHT_PANE_WIDTH,
    available - RESIZE_HANDLE_WIDTH - MIN_EDITOR_PANE_WIDTH,
  )
  return Math.min(preferredRightWidth, maxRight)
}

function isPublicBuiltinSkillName(name) {
  return PUBLIC_BUILTIN_SKILL_NAMES.has(name)
}

function buildPublicBuiltinSkillTool(entry) {
  const markdown = typeof entry.content === 'string' ? entry.content : ''
  const meta = parseSkillMarkdownMeta(markdown)
  return {
    id: entry.name,
    name: entry.name,
    description: meta.description || PUBLIC_BUILTIN_DEFAULT_DESCRIPTIONS[entry.name] || '',
    parameters: [],
    markdown,
    resources: normalizeResources(entry.resources),
    source: 'public-skill',
    promptOnly: false,
    siteId: '',
    siteName: '',
    enabled: entry.enabled === true,
    draft: entry.draft === true,
    directoryName: entry.name,
    createdAt: entry.createdAt,
    creationOrderKey: entry.creationOrderKey,
  }
}

function buildPublicCustomSkillTool(entry) {
  const markdown = entry.draft ? customSkillTemplateMarkdown : typeof entry.content === 'string' ? entry.content : customSkillTemplateMarkdown
  const meta = parseSkillMarkdownMeta(markdown)
  const name = entry.name || entry.id || makeSkillId()
  return {
    id: name,
    name: meta.name || name,
    description: meta.description || '',
    parameters: [],
    markdown,
    resources: normalizeResources(entry.resources),
    source: 'public-custom',
    promptOnly: true,
    siteId: '',
    siteName: '',
    enabled: entry.enabled === true,
    draft: entry.draft === true,
    directoryName: entry.name,
    createdAt: entry.createdAt,
    creationOrderKey: entry.creationOrderKey,
  }
}

function buildToolTooltip(tool) {
  const params = (tool.parameters || [])
    .map((param) => {
      const required = param.required ? '必填' : '可选'
      return `${param.name || '未命名'} (${param.type || 'string'}, ${required})${param.description ? `: ${param.description}` : ''}`
    })
    .join('\n')
  return [
    tool.name,
    tool.siteName ? `站点：${tool.siteName}` : '',
    tool.source === 'system' ? '类型：内置工具'
      : tool.source === 'public-skill' ? '类型：公共 skill'
        : (tool.source === 'public-custom' || tool.source === 'custom' ? '类型：自定义' : '类型：官方只读'),
    tool.description ? `说明：${tool.description}` : '',
    params ? `参数：\n${params}` : '参数：无参数',
  ].filter(Boolean).join('\n')
}

function buildToolSiteMetaPrefix(tool) {
  if (tool.source === 'system') return '内置 · '
  if (tool.source === 'public-skill' || tool.source === 'public-custom') return '公共 · '
  return tool.siteName ? `${tool.siteName} · ` : ''
}

function buildScenarioSiteMetaPrefix(scenario) {
  return scenario._toolPackageSiteName ? `${scenario._toolPackageSiteName} · ` : ''
}

async function fetchPublicSkillsFromApi() {
  const res = await backendFetch(`${SKILLS_API}/skills`)
  if (!res.ok) throw new Error('读取 Skill 列表失败，请重试')
  const entries = await res.json()
  if (!Array.isArray(entries)) throw new Error('Skill 列表格式异常')
  return entries
}

async function persistPublicCustomSkill(skill, previousName = '') {
  const diskName = String(skill?.id || skill?.name || '').trim()
  const content = typeof skill?.markdown === 'string' ? skill.markdown : ''
  if (!diskName) return null
  const res = await backendFetch(`${SKILLS_API}/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: diskName,
      previousName,
      content,
      resources: skill.resources || [],
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || '保存公共 skill 失败')
  return data || { name: diskName }
}

async function deletePublicCustomSkillByName(name) {
  const res = await backendFetch(`${SKILLS_API}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
  return res.ok
}

export default function ToolPackageEditor({
  site,
  sites = [site],
  allSites = [],
  editableSites = [],
  selectedSiteIds = [],
  onToggleSiteId,
  scenarioSiteIds = [],
  onToggleScenarioSiteId,
  onSkillScopeChange,
  skillScope = SKILL_SCOPE_SITE,
  scenarios,
  onClose,
  onReloadSites,
  onDirtyChange,
}) {
  const isPublicScope = skillScope === SKILL_SCOPE_PUBLIC
  const siteList = useMemo(
    () => (allSites?.length ? allSites : sites?.length ? sites : [site]).filter(item => item?.id),
    [allSites, site, sites],
  )
  const officialTools = useMemo(
    () => siteList.flatMap((toolSite) => (
      (toolSite.tools || []).map((tool) => attachToolSite(normalizeTool(tool, 'official'), toolSite))
    )),
    [siteList],
  )
  const [scenarioList, setScenarioList] = useState(() => (scenarios || []).map(normalizeScenarioForEditor))
  const [customSkillsBySite, setCustomSkillsBySite] = useState(() => buildInitialCustomSkillsBySite(siteList, site))
  const [customSkillSaveSiteId, setCustomSkillSaveSiteId] = useState('')
  const [customSkillSaveTick, setCustomSkillSaveTick] = useState(0)
  const [selectedScenarioId, setSelectedScenarioId] = useState(scenarioKey(scenarioList[0]))
  const [workspaceTab, setWorkspaceTab] = useState(WORKSPACE_TAB_SKILLS)
  const openSessionId = useToolPackagePageStore((s) => s.openSessionId)
  const requestedWorkspaceTab = useToolPackagePageStore((s) => s.workspaceTab)
  const requestedPublicSkill = useToolPackagePageStore((s) => s.selectedPublicSkillName)
  const [selectedToolKey, setSelectedToolKey] = useState('')

  React.useEffect(() => {
    if (requestedWorkspaceTab === WORKSPACE_TAB_SCENARIOS || requestedWorkspaceTab === WORKSPACE_TAB_SKILLS) {
      setWorkspaceTab(requestedWorkspaceTab)
    }
  }, [openSessionId, requestedWorkspaceTab])

  const [scenarioSearchQuery, setScenarioSearchQuery] = useState('')
  const [toolSearchQuery, setToolSearchQuery] = useState('')
  const [skillFilter, setSkillFilter] = useState('all')
  const [skillSort, setSkillSort] = useState('created')
  const [toolkitSearchQuery, setToolkitSearchQuery] = useState('')
  const [toolkitKind, setToolkitKind] = useState(TOOLKIT_KIND_SCENE)
  const systemTools = useSitesStore((s) => s.systemTools)
  const refreshSites = useSitesStore((s) => s.refreshSites)
  const [dragOverEditor, setDragOverEditor] = useState(false)
  const [leftPaneWidth, setLeftPaneWidth] = useState(DEFAULT_SIDE_PANE_WIDTH)
  const [rightPaneWidth, setRightPaneWidth] = useState(DEFAULT_SIDE_PANE_WIDTH)
  const [resizingSide, setResizingSide] = useState('')
  const [rightPaneOpen, setRightPaneOpen] = useState(false)
  const [rightPaneView, setRightPaneView] = useState('skill')
  const [scenarioDirty, setScenarioDirty] = useState(false)
  const [creatingScenario, setCreatingScenario] = useState(false)
  const [refreshingSkills, setRefreshingSkills] = useState(false)
  const [importingSkillZip, setImportingSkillZip] = useState(false)
  const [customSkillBlockedSaveSiteId, setCustomSkillBlockedSaveSiteId] = useState('')
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const resizeStateRef = useRef(null)
  const workspaceRef = useRef(null)
  const scenarioSiteIdRef = useRef('')
  const customSkillsSaveTimerRef = useRef(null)
  const [installedSkills, setInstalledSkills] = useState([])
  const [skillsLoadError, setSkillsLoadError] = useState('')
  const [togglingSkills, setTogglingSkills] = useState(new Set())
  const togglingSkillsRef = useRef(new Set())
  const [publicBuiltinSkills, setPublicBuiltinSkills] = useState([])
  const [publicCustomSkills, setPublicCustomSkills] = useState([])
  const [publicCustomSaveName, setPublicCustomSaveName] = useState('')
  const [publicCustomSaveTick, setPublicCustomSaveTick] = useState(0)
  const publicCustomSkillsRef = useRef(publicCustomSkills)
  publicCustomSkillsRef.current = publicCustomSkills

  const applyInstalledSkills = React.useCallback((entries) => {
    setInstalledSkills(entries)
    setPublicBuiltinSkills(entries.filter(entry => isPublicBuiltinSkillName(entry.name)).map(buildPublicBuiltinSkillTool))
    setPublicCustomSkills(entries.filter(entry => !isPublicBuiltinSkillName(entry.name)).map(buildPublicCustomSkillTool))
    setSkillsLoadError('')
  }, [])
  const reloadPublicSkills = React.useCallback(async () => {
    const entries = await fetchPublicSkillsFromApi()
    applyInstalledSkills(entries)
  }, [applyInstalledSkills])

  React.useEffect(() => {
    let cancelled = false
    fetchPublicSkillsFromApi().then(entries => {
      if (!cancelled) applyInstalledSkills(entries)
    }).catch(error => { if (!cancelled) setSkillsLoadError(error.message) })
    return () => { cancelled = true }
  }, [applyInstalledSkills])

  const siteSkillDirectoryNames = useMemo(() => new Set(siteList.flatMap(toolSite => [
    `webcli-${toolSite.id}`,
    ...(customSkillsBySite[toolSite.id] || loadCustomSkillsForSite(toolSite)).map(skill => skillDirectoryName({ ...skill, source: 'custom' })),
  ])), [siteList, customSkillsBySite])

  const catalogPublicBuiltinSkills = useMemo(
    () => publicBuiltinSkills,
    [publicBuiltinSkills],
  )

  const catalogPublicCustomSkills = useMemo(
    () => publicCustomSkills.filter(skill => !siteSkillDirectoryNames.has(skill.id)).map((skill) => normalizeTool(skill, 'public-custom')),
    [publicCustomSkills, siteSkillDirectoryNames],
  )
  const publicDuplicateCheckSkills = useMemo(
    () => [...catalogPublicBuiltinSkills, ...catalogPublicCustomSkills],
    [catalogPublicBuiltinSkills, catalogPublicCustomSkills],
  )

  const catalogOfficialSkills = useMemo(() => (
    siteList.map((toolSite) => buildOfficialSiteSkill(
      toolSite,
      (toolSite.tools || []).map((tool) => attachToolSite(normalizeTool(tool, 'official'), toolSite)),
    ))
  ), [siteList])

  const customSkillsBySiteRef = useRef(customSkillsBySite)
  customSkillsBySiteRef.current = customSkillsBySite
  const hasPendingCustomSkillSave = customSkillSaveSiteId && customSkillSaveTick > 0
  const blockedCustomSkillSaveSiteId = customSkillBlockedSaveSiteId

  const mutateCustomSkillsForSite = (siteId, updater) => {
    setCustomSkillsBySite((current) => ({
      ...current,
      [siteId]: updater(current[siteId] || []),
    }))
    setCustomSkillSaveSiteId(siteId)
    setCustomSkillSaveTick((tick) => tick + 1)
  }

  const catalogCustomSkills = useMemo(() => {
    const seen = new Set()
    const items = []
    for (const toolSite of siteList) {
      for (const skill of (customSkillsBySite[toolSite.id] || loadCustomSkillsForSite(toolSite))) {
        const attached = attachToolSite(normalizeTool(skill, 'custom'), toolSite)
        const dedupeKey = `${attached.siteId}:${attached.id || attached.name}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        items.push(attached)
      }
    }
    return items
  }, [siteList, customSkillsBySite])

  const allSkills = useMemo(
    () => {
      const siteSkills = [...catalogOfficialSkills, ...catalogCustomSkills]
      const publicNames = new Set(publicSkillEntries(installedSkills, siteSkills).map(entry => entry.name))
      return [...catalogPublicBuiltinSkills, ...catalogPublicCustomSkills].filter(tool => publicNames.has(tool.id))
        .concat(siteSkills).map(tool => withInstalledSkillState(tool, installedSkills))
    },
    [catalogPublicBuiltinSkills, catalogPublicCustomSkills, catalogOfficialSkills, catalogCustomSkills, installedSkills],
  )

  const selectedScenario = scenarioList.find((scenario) => scenarioKey(scenario) === selectedScenarioId) || scenarioList[0]
  const selectedScenarioEditable = isUserScenario(selectedScenario)
  const selectedScenarioSiteId = scenarioSiteIds[0] || editableSites[0]?.id || site.id
  const visibleScenarioList = useMemo(
    () => filterScenarios(scenarioList, scenarioSearchQuery),
    [scenarioList, scenarioSearchQuery],
  )
  const showScenarioWorkspace = workspaceTab === WORKSPACE_TAB_SCENARIOS
  const showSkillsRightPane = workspaceTab === WORKSPACE_TAB_SKILLS
  const showRightPaneShell = showSkillsRightPane
  const effectiveRightPaneOpen = showRightPaneShell && rightPaneOpen

  useEffect(() => {
    const node = workspaceRef.current
    if (!node) return undefined

    const syncWidth = () => {
      setWorkspaceWidth(node.clientWidth)
    }

    syncWidth()
    const observer = new ResizeObserver(() => syncWidth())
    observer.observe(node)
    return () => observer.disconnect()
  }, [showRightPaneShell, showScenarioWorkspace])

  const effectiveRightPaneWidth = useMemo(
    () => computeEffectiveRightPaneWidth({
      workspaceWidth,
      leftPaneWidth,
      preferredRightWidth: rightPaneWidth,
      rightOpen: effectiveRightPaneOpen,
    }),
    [workspaceWidth, leftPaneWidth, rightPaneWidth, effectiveRightPaneOpen],
  )

  const [tagOverrides, setTagOverrides] = useState(() => loadSkillTagOverrides(window.localStorage))
  const getTags = tool => skillTags(tool, tagOverrides)
  const saveTags = (tool, tags) => {
    const next = { ...tagOverrides, [skillTagKey(tool)]: normalizeSkillTags(tags) }
    try { window.localStorage.setItem(SKILL_TAGS_STORAGE_KEY, JSON.stringify(next)); setTagOverrides(next); return true }
    catch { void showAlert('标签保存失败，请重试'); return false }
  }
  const visibleSkills = selectCatalogSkills(allSkills, { filter: skillFilter, sort: skillSort, query: toolSearchQuery, getTags })
  const filterToolkitToolsBySearch = (tools) => {
    const query = toolkitSearchQuery.trim().toLowerCase()
    if (!query) return tools
    return tools.filter((tool) => {
      const haystack = [
        tool.name,
        tool.description,
        tool.siteName,
        ...((tool.parameters || []).flatMap((param) => [param.name, param.type, param.description])),
      ].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }
  const builtinToolkitTools = useMemo(
    () => (systemTools || []).map((tool) => normalizeTool(tool, 'system')),
    [systemTools],
  )
  const toolkitKindOptions = useMemo(() => ([
    { value: TOOLKIT_KIND_SCENE, label: '场景工具包' },
    { value: TOOLKIT_KIND_BUILTIN, label: '内置工具包' },
  ]), [])
  const selectedTool = findSelectedSkill(allSkills, selectedToolKey)
  const visibleToolkitTools = useMemo(() => {
    const base = toolkitKind === TOOLKIT_KIND_BUILTIN
      ? builtinToolkitTools
      : officialTools.filter(tool => tool.siteId === selectedTool?.siteId)
    return filterToolkitToolsBySearch(base)
  }, [toolkitKind, builtinToolkitTools, officialTools, selectedTool?.siteId, toolkitSearchQuery])
  const showSceneToolkitUnavailable = selectedTool?.source?.startsWith('public-') && toolkitKind === TOOLKIT_KIND_SCENE
  const showToolkitSearch = !showSceneToolkitUnavailable
  const selectedToolSite = siteList.find((item) => item.id === selectedTool?.siteId) || site
  const selectedIsCustom = selectedTool?.source === 'custom' || selectedTool?.source === 'public-custom'
  const selectedIsEditable = selectedIsCustom
  const selectedCustomSkillDuplicateName = selectedTool?.source === 'custom'
    ? findDuplicateCustomSkillNameForSkill(customSkillsBySite[selectedTool.siteId] || [], selectedTool.id)
    : selectedTool?.source === 'public-custom'
      ? findDuplicateCustomSkillNameForSkill(publicDuplicateCheckSkills, selectedTool.id || selectedTool.name)
      : ''

  const slashMenuTools = useMemo(() => {
    const sourceSites = selectedTool?.source?.startsWith('public-')
      ? (allSites?.length ? allSites : sites?.length ? sites : [site]).filter(Boolean)
      : [selectedToolSite].filter(Boolean)
    return sourceSites.flatMap((toolSite) => (
      (toolSite.tools || []).map((tool) => attachToolSite(normalizeTool(tool, 'official'), toolSite))
    ))
  }, [allSites, selectedTool, selectedToolSite, site, sites])

  useEffect(() => {
    setCustomSkillsBySite((current) => {
      const next = { ...current }
      let changed = false
      for (const toolSite of siteList) {
        if (
          (hasPendingCustomSkillSave && toolSite.id === customSkillSaveSiteId)
          || toolSite.id === blockedCustomSkillSaveSiteId
        ) continue
        const latest = loadCustomSkillsForSite(toolSite)
        const previousKey = JSON.stringify((next[toolSite.id] || []).map((skill) => [skill.id, skill.name, skill.markdown, skill.resources?.length || 0]))
        const latestKey = JSON.stringify(latest.map((skill) => [skill.id, skill.name, skill.markdown, skill.resources?.length || 0]))
        if (previousKey === latestKey) continue
        next[toolSite.id] = latest
        changed = true
      }
      return changed ? next : current
    })
  }, [siteList, hasPendingCustomSkillSave, customSkillSaveSiteId, blockedCustomSkillSaveSiteId])

  useEffect(() => {
    const timer = setInterval(() => {
      if (!customSkillsSaveTimerRef.current) refreshSites?.()
    }, 2000)
    return () => clearInterval(timer)
  }, [isPublicScope, refreshSites])

  useEffect(() => {
    setCustomSkillsBySite((current) => ({
      ...current,
      [site.id]: initialCustomSkills(site),
    }))
    setCustomSkillBlockedSaveSiteId('')
  }, [site.id])

  useEffect(() => {
    if (!customSkillSaveSiteId || customSkillSaveTick === 0) return undefined
    const siteId = customSkillSaveSiteId
    if (customSkillsSaveTimerRef.current) clearTimeout(customSkillsSaveTimerRef.current)
    customSkillsSaveTimerRef.current = setTimeout(async () => {
      try {
        const skills = customSkillsBySiteRef.current[siteId] || []
        const duplicateName = findDuplicateCustomSkillName(skills)
        if (duplicateName) {
          customSkillsSaveTimerRef.current = null
          setCustomSkillSaveSiteId('')
          setCustomSkillSaveTick(0)
          setCustomSkillBlockedSaveSiteId(siteId)
          return
        }
        const saved = await updateSiteCustomSkills(siteId, skills)
        customSkillsSaveTimerRef.current = null
        setCustomSkillSaveSiteId('')
        setCustomSkillSaveTick(0)
        setCustomSkillBlockedSaveSiteId((current) => (current === siteId ? '' : current))
        clearLocalCustomSkills(siteId)
        setCustomSkillsBySite((current) => ({
          ...current,
          [siteId]: normalizeCustomSkills(saved),
        }))
        setInstalledSkills(await fetchPublicSkillsFromApi())
        await onReloadSites?.()
      } catch (e) {
        console.error('[tool-package] update custom skills failed:', e)
        if (e instanceof Error && e.message.includes('Skill name already exists')) {
          customSkillsSaveTimerRef.current = null
          setCustomSkillSaveSiteId('')
          setCustomSkillSaveTick(0)
          setCustomSkillBlockedSaveSiteId(siteId)
          return
        }
        showAlert(e instanceof Error ? e.message : '保存自定义 skill 失败')
        await onReloadSites?.()
      }
    }, 700)
    return () => {
      if (customSkillsSaveTimerRef.current) {
        clearTimeout(customSkillsSaveTimerRef.current)
        customSkillsSaveTimerRef.current = null
      }
    }
  }, [customSkillSaveSiteId, customSkillSaveTick, onReloadSites])

  useEffect(() => {
    if (!publicCustomSaveName || publicCustomSaveTick === 0) return undefined
    const saveName = publicCustomSaveName
    const timer = setTimeout(async () => {
      const skill = publicCustomSkillsRef.current.find((item) => item.id === saveName || item.name === saveName)
      if (!skill) return
      const duplicateName = findDuplicateCustomSkillNameForSkill(publicDuplicateCheckSkills, saveName)
      if (duplicateName) {
        setPublicCustomSaveName('')
        setPublicCustomSaveTick(0)
        return
      }
      try {
        const saved = await persistPublicCustomSkill(skill, saveName)
        if (saved?.name) {
          const savedName = saved.name
          // Update both catalogs together so a rename cannot briefly remove the
          // selected card while the subsequent list refresh is still in flight.
          setInstalledSkills((current) => current.map((entry) => entry.name === saveName ? saved : entry))
          setPublicCustomSkills((current) => current.map((item) => (
            (item.id === saveName || item.name === saveName)
              ? {
                  ...item,
                  id: savedName,
                  name: savedName,
                  directoryName: savedName,
                  resources: Array.isArray(saved.resources) ? normalizeResources(saved.resources) : item.resources,
                }
              : item
          )))
          if (savedName !== saveName) {
            const oldKey = skillTagKey(skill)
            const overrides = loadSkillTagOverrides(window.localStorage)
            if (Object.hasOwn(overrides, oldKey)) {
              const next = { ...overrides, [skillTagKey({ ...skill, id: savedName })]: overrides[oldKey] }
              try { window.localStorage.setItem(SKILL_TAGS_STORAGE_KEY, JSON.stringify(next)); setTagOverrides(next) }
              catch { void showAlert('名称已保存，但标签同步失败，请重新设置标签') }
            }
            setPublicCustomSaveName(savedName)
            setSelectedToolKey((current) => current === skillSelectionKey(skill) ? skillSelectionKey({ ...skill, id: savedName }) : current)
          }
        }
        setPublicCustomSaveName('')
        setPublicCustomSaveTick(0)
        await reloadPublicSkills()
      } catch (e) {
        console.error('[tool-package] update public custom skill failed:', e)
        if (e instanceof Error && e.message.includes('Skill name already exists')) {
          setPublicCustomSaveName('')
          setPublicCustomSaveTick(0)
          return
        }
        showAlert(e instanceof Error ? e.message : '保存公共 skill 失败')
      }
    }, 700)
    return () => clearTimeout(timer)
  }, [isPublicScope, publicCustomSaveName, publicCustomSaveTick, reloadPublicSkills, publicDuplicateCheckSkills])

  useEffect(() => {
    onDirtyChange?.(scenarioDirty)
  }, [onDirtyChange, scenarioDirty])

  useEffect(() => {
    const epoch = (scenarios || []).map((item) => item._toolPackageKey || item.id || item.title).join('\n')
    const sameEpoch = scenarioSiteIdRef.current === epoch
    setScenarioList((current) => {
      const next = sameEpoch
        ? mergeScenarioListForEditor(scenarios || [], current)
        : (scenarios || []).map(normalizeScenarioForEditor)
      if (!scenarioDirty || !selectedScenarioId) return next
      const editing = current.find((item) => scenarioKey(item) === selectedScenarioId)
      if (!editing) return next
      return next.map((item) => (
        scenarioKey(item) === selectedScenarioId ? editing : item
      ))
    })
    scenarioSiteIdRef.current = epoch
  }, [scenarios, scenarioDirty, selectedScenarioId])

  useEffect(() => {
    if (!scenarioList[0]) {
      if (selectedScenarioId) setSelectedScenarioId('')
      return
    }
    if (selectedScenarioId && scenarioList.some((scenario) => scenarioKey(scenario) === selectedScenarioId)) return
    setSelectedScenarioId(scenarioKey(scenarioList[0]))
  }, [scenarioList, selectedScenarioId])

  useEffect(() => {
    if (!showScenarioWorkspace || !visibleScenarioList.length) return
    if (selectedScenarioId && visibleScenarioList.some((scenario) => scenarioKey(scenario) === selectedScenarioId)) return
    setSelectedScenarioId(scenarioKey(visibleScenarioList[0]))
  }, [visibleScenarioList, selectedScenarioId, showScenarioWorkspace])

  useEffect(() => {
    setSelectedToolKey('')
  }, [skillScope])

  useEffect(() => {
    if (selectedToolKey) return
    const preferred = isPublicScope
      ? (catalogPublicCustomSkills.find((skill) => skill.id === requestedPublicSkill || skill.name === requestedPublicSkill) || catalogPublicCustomSkills[0] || catalogPublicBuiltinSkills[0])
      : (catalogCustomSkills.find((tool) => tool.siteId === site.id)
        || catalogOfficialSkills.find((tool) => tool.siteId === site.id)
        || catalogCustomSkills[0]
        || catalogOfficialSkills[0])
    if (preferred) setSelectedToolKey(skillSelectionKey(preferred))
  }, [catalogCustomSkills, catalogOfficialSkills, catalogPublicBuiltinSkills, catalogPublicCustomSkills, isPublicScope, selectedToolKey, site.id, requestedPublicSkill])

  useEffect(() => {
    if (!selectedToolKey) return
    const selected = findSelectedSkill(allSkills, selectedToolKey)
    if (selected) {
      const stableKey = skillSelectionKey(selected)
      if (stableKey !== selectedToolKey) setSelectedToolKey(stableKey)
      return
    }
    const fallback = isPublicScope
      ? (catalogPublicCustomSkills[0] || catalogPublicBuiltinSkills[0])
      : (catalogCustomSkills[0] || catalogOfficialSkills[0])
    setSelectedToolKey(fallback ? skillSelectionKey(fallback) : '')
  }, [allSkills, selectedToolKey, catalogCustomSkills, catalogOfficialSkills, catalogPublicBuiltinSkills, catalogPublicCustomSkills, isPublicScope])

  useEffect(() => {
    if (!resizingSide) return undefined

    const handlePointerMove = (event) => {
      const resizeState = resizeStateRef.current
      if (!resizeState) return
      const deltaX = event.clientX - resizeState.startX
      if (resizeState.side === 'left') {
        setLeftPaneWidth(clampPaneWidth(resizeState.startLeftWidth + deltaX))
      } else {
        setRightPaneWidth(clampPaneWidth(resizeState.startRightWidth - deltaX))
      }
    }

    const stopResize = () => {
      resizeStateRef.current = null
      setResizingSide('')
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }
  }, [resizingSide])

  const startPaneResize = (side, event) => {
    event.preventDefault()
    resizeStateRef.current = {
      side,
      startX: event.clientX,
      startLeftWidth: leftPaneWidth,
      startRightWidth: rightPaneWidth,
    }
    setResizingSide(side)
  }

  const confirmDiscardScenarioChanges = async () => !scenarioDirty || await showConfirm(UNSAVED_SCENARIO_MESSAGE, '未保存的修改')

  const markScenarioCleanAfterLeave = () => {
    if (scenarioDirty) setScenarioDirty(false)
  }

  const handleClose = async () => {
    if (!await confirmDiscardScenarioChanges()) return
    markScenarioCleanAfterLeave()
    onClose?.()
  }

  const handleRefreshSkills = async () => {
    if (refreshingSkills) return
    setRefreshingSkills(true)
    try {
      if (customSkillsSaveTimerRef.current) {
        clearTimeout(customSkillsSaveTimerRef.current)
        customSkillsSaveTimerRef.current = null
      }
      await reloadPublicSkills()
      setCustomSkillBlockedSaveSiteId('')
      for (const toolSite of siteList) clearLocalCustomSkills(toolSite.id)
      await refreshSites?.()
      await onReloadSites?.()
    } catch (error) {
      console.error('[tool-package] refresh skills failed:', error)
      showAlert(error instanceof Error ? error.message : '刷新 skills 失败')
    } finally {
      setRefreshingSkills(false)
    }
  }

  const selectTool = async (tool) => {
    const nextKey = skillSelectionKey(tool)
    if (workspaceTab === WORKSPACE_TAB_SKILLS && selectedToolKey === nextKey) {
      setRightPaneView('skill')
      setRightPaneOpen(true)
      return
    }
    if (!await confirmDiscardScenarioChanges()) return
    markScenarioCleanAfterLeave()
    setSelectedToolKey(nextKey)
    setWorkspaceTab(WORKSPACE_TAB_SKILLS)
    setRightPaneView('skill')
    setRightPaneOpen(true)
  }

  const selectScenario = async (scenario) => {
    const nextKey = scenarioKey(scenario)
    if (workspaceTab === WORKSPACE_TAB_SCENARIOS && selectedScenarioId === nextKey) return
    if (!await confirmDiscardScenarioChanges()) return
    markScenarioCleanAfterLeave()
    setSelectedScenarioId(nextKey)
    setWorkspaceTab(WORKSPACE_TAB_SCENARIOS)
  }

  const switchWorkspaceTab = async (nextTab) => {
    if (nextTab === workspaceTab) return
    if (workspaceTab === WORKSPACE_TAB_SCENARIOS && nextTab === WORKSPACE_TAB_SKILLS) {
      if (!await confirmDiscardScenarioChanges()) return
      markScenarioCleanAfterLeave()
    }
    setWorkspaceTab(nextTab)
  }

  const saveSelectedScenario = async (nextScenario) => {
    if (!selectedScenario) {
      throw new Error('未选择场景')
    }
    if (!isUserScenario(selectedScenario)) {
      throw new Error('官方场景不可编辑')
    }
    const scenarioSiteId = resolveScenarioSiteId(selectedScenario, scenarioSiteIds, site.id)
    const apiScenarioId = resolveScenarioApiId(selectedScenario)
    const listKey = scenarioKey(selectedScenario)
    if (!scenarioSiteId || !apiScenarioId) {
      throw new Error('场景站点 ID 无效')
    }
    const optimisticScenario = { ...selectedScenario, ...nextScenario }
    setScenarioList((current) =>
      current.map((scenario) => scenarioKey(scenario) === listKey ? optimisticScenario : scenario)
    )
    try {
      const saved = await updateSiteScenario(scenarioSiteId, apiScenarioId, {
        title: optimisticScenario.title,
        summary: optimisticScenario.summary,
        steps: optimisticScenario.steps,
        prompts: optimisticScenario.prompts,
      })
      const savedScenario = normalizeScenarioForEditor({
        ...saved,
        _toolPackageSiteId: selectedScenario._toolPackageSiteId || scenarioSiteId,
        _toolPackageSiteName: selectedScenario._toolPackageSiteName || '',
        updatedAt: saved.updated_at || saved.updatedAt || new Date().toISOString(),
        source: 'user',
      }, scenarioList.findIndex((scenario) => scenarioKey(scenario) === listKey))
      setScenarioList((current) =>
        current.map((scenario) => scenarioKey(scenario) === listKey ? savedScenario : scenario)
      )
      setSelectedScenarioId(scenarioKey(savedScenario))
      await onReloadSites?.()
      return savedScenario
    } catch (e) {
      console.error('[tool-package] update scenario failed:', e)
      setScenarioList((current) =>
        current.map((scenario) => scenarioKey(scenario) === listKey ? selectedScenario : scenario)
      )
      throw e
    }
  }

  const resetSelectedScenario = async (fields) => {
    if (!selectedScenario) return
    if (!isUserScenario(selectedScenario)) {
      throw new Error('官方场景不可编辑')
    }
    const scenarioSiteId = resolveScenarioSiteId(selectedScenario, scenarioSiteIds, site.id)
    const apiScenarioId = resolveScenarioApiId(selectedScenario)
    const listKey = scenarioKey(selectedScenario)
    if (!scenarioSiteId || !apiScenarioId) {
      throw new Error('场景站点 ID 无效')
    }
    try {
      const restored = await resetSiteScenario(scenarioSiteId, apiScenarioId, fields)
      const nextScenario = normalizeScenarioForEditor({
        ...restored,
        _toolPackageSiteId: selectedScenario._toolPackageSiteId || scenarioSiteId,
        _toolPackageSiteName: selectedScenario._toolPackageSiteName || '',
      }, scenarioList.findIndex((scenario) => scenarioKey(scenario) === listKey))
      setScenarioList((current) =>
        current.map((scenario) => scenarioKey(scenario) === listKey ? nextScenario : scenario)
      )
      setSelectedScenarioId(scenarioKey(nextScenario))
      await onReloadSites?.()
      return nextScenario
    } catch (e) {
      console.error('[tool-package] reset scenario failed:', e)
      throw e
    }
  }

  const refreshSelectedScenario = async () => {
    await onReloadSites?.()
    const refreshed = scenarioList.find((scenario) => scenarioKey(scenario) === selectedScenarioId) || selectedScenario
    return refreshed || null
  }

  const deleteSelectedScenario = async () => {
    if (!selectedScenario) return false
    if (!isUserScenario(selectedScenario)) {
      throw new Error('官方场景不可删除')
    }
    const scenarioName = selectedScenario.title || '未命名场景'
    if (!await showConfirm(`确定删除自定义场景「${scenarioName}」吗？删除后无法直接恢复。`, '删除场景', { danger: true })) return false
    const scenarioSiteId = resolveScenarioSiteId(selectedScenario, scenarioSiteIds, site.id)
    const apiScenarioId = resolveScenarioApiId(selectedScenario)
    const listKey = scenarioKey(selectedScenario)
    if (!scenarioSiteId || !apiScenarioId) {
      throw new Error('场景站点 ID 无效')
    }
    await deleteSiteScenario(scenarioSiteId, apiScenarioId)
    const nextScenarioList = scenarioList.filter((scenario) => scenarioKey(scenario) !== listKey)
    const fallback = nextScenarioList.find((scenario) => scenario._toolPackageSiteId === scenarioSiteId) || nextScenarioList[0]
    setScenarioList(nextScenarioList)
    setSelectedScenarioId(fallback ? scenarioKey(fallback) : '')
    markScenarioCleanAfterLeave()
    await onReloadSites?.()
    return true
  }

  const addScenario = async () => {
    if (creatingScenario) return
    if (!await confirmDiscardScenarioChanges()) return
    markScenarioCleanAfterLeave()
    const scenarioSiteId = selectedScenarioSiteId
    const scenarioSite = editableSites.find((item) => item.id === scenarioSiteId) || site
    if (!scenarioSiteId) {
      showAlert('请先选择站点')
      return
    }
    const id = makeScenarioId()
    const nextScenario = {
      id,
      title: '新建场景',
      summary: '',
      steps: [],
      prompts: [],
    }
    setCreatingScenario(true)
    try {
      const created = await createSiteScenario(scenarioSiteId, nextScenario)
      const normalized = normalizeScenarioForEditor({
        ...created,
        source: 'user',
        _toolPackageSiteId: scenarioSiteId,
        _toolPackageSiteName: scenarioSite?.name || '',
        _toolPackageKey: `${scenarioSiteId}:${created.id || id}`,
        updatedAt: created.updated_at || created.updatedAt || new Date().toISOString(),
      }, 0)
      setScenarioList((current) => [normalized, ...current])
      setSelectedScenarioId(scenarioKey(normalized))
      setWorkspaceTab(WORKSPACE_TAB_SCENARIOS)
      await onReloadSites?.()
    } catch (error) {
      console.error('[tool-package] create scenario failed:', error)
      showAlert(error instanceof Error ? error.message : '新增场景失败')
    } finally {
      setCreatingScenario(false)
    }
  }

  const updateSelectedSkill = (patch) => {
    if (!selectedTool || !selectedIsCustom) return
    if (selectedTool.source === 'public-custom') {
      const skillId = selectedTool.id || selectedTool.name
      setPublicCustomSkills((current) => current.map((skill) => (
        (skill.id === skillId || skill.name === skillId) ? { ...skill, ...patch } : skill
      )))
      setPublicCustomSaveName(skillId)
      setPublicCustomSaveTick((tick) => tick + 1)
      return
    }
    const ownerSiteId = selectedTool.siteId || site.id
    mutateCustomSkillsForSite(ownerSiteId, (current) =>
      current.map((skill) => skill.id === selectedTool.id ? { ...skill, ...patch } : skill)
    )
  }

  const updateParam = (index, patch) => {
    if (!selectedTool || !selectedIsCustom) return
    const nextParams = selectedTool.parameters.map((param, paramIndex) =>
      paramIndex === index ? { ...param, ...patch } : param
    )
    updateSelectedSkill({ parameters: nextParams })
  }

  const addCustomSkill = async (baseTool) => {
    if (!await confirmDiscardScenarioChanges()) return
    markScenarioCleanAfterLeave()
    setToolSearchQuery('')
    const next = { ...cloneAsCustom(baseTool), id: `public-${makeSkillId().replace(/^custom-/, '')}`, source: 'public-custom', siteId: '', siteName: '' }
    setPublicCustomSkills((current) => [next, ...current])
    setSelectedToolKey(skillSelectionKey(next))
    setWorkspaceTab(WORKSPACE_TAB_SKILLS)
    try {
      const saved = await persistPublicCustomSkill(next)
      await reloadPublicSkills()
      setSelectedToolKey(skillSelectionKey({ ...next, id: saved.name }))
    } catch (e) {
      void showAlert(e instanceof Error ? e.message : '新增 Skill 失败，请重试')
    }
  }

  const createBlankSkill = async (name) => {
    const res = await backendFetch(`${SKILLS_API}/skills/folders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || '新增 Skill 失败')
    setInstalledSkills(current => [...current, data])
    const next = buildPublicCustomSkillTool(data)
    setPublicCustomSkills(current => [...current, next])
    setToolSearchQuery('')
    setSelectedToolKey(skillSelectionKey(next))
    setWorkspaceTab(WORKSPACE_TAB_SKILLS)
    setRightPaneView('skill')
    setRightPaneOpen(true)
  }

  const toggleSkill = async (tool, enabled) => {
    const name = skillDirectoryName(tool)
    if (togglingSkillsRef.current.has(name)) return
    togglingSkillsRef.current.add(name)
    setTogglingSkills(new Set(togglingSkillsRef.current))
    try {
      const res = await backendFetch(`${SKILLS_API}/skills/${encodeURIComponent(name)}/toggle`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '更新 Skill 状态失败')
      setInstalledSkills(current => current.map(entry => entry.name === name ? { ...entry, enabled: data.enabled } : entry))
    } catch (error) {
      void showAlert(error instanceof Error ? error.message : '更新 Skill 状态失败')
    } finally {
      togglingSkillsRef.current.delete(name)
      setTogglingSkills(new Set(togglingSkillsRef.current))
    }
  }

  const importSkillZipFile = async () => {
    const paths = await window.electronAPI?.selectFiles?.({
      title: '导入 Skill ZIP',
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
    })
    const archivePath = paths?.[0]
    if (!archivePath) return
    setImportingSkillZip(true)
    try {
      const result = await importPublicSkillZipPath(archivePath)
      await reloadPublicSkills()
      const names = Array.isArray(result?.skills) ? result.skills.map((item) => item?.name).filter(Boolean) : []
      void showAlert(names.length ? `已导入 ${names.length} 个 Skill` : 'Skill 导入成功')
    } catch (error) {
      void showAlert(error instanceof Error ? error.message : '导入 Skill ZIP 失败')
    } finally {
      setImportingSkillZip(false)
    }
  }

  const deleteCustomSkill = async () => {
    if (!selectedIsCustom || !selectedTool) return
    const skillName = selectedTool.name || selectedTool.id || '未命名 skill'
    if (!await showConfirm(`确定删除自定义 skill「${skillName}」吗？删除后无法直接恢复。`, '删除 Skill', { danger: true })) return
    if (selectedTool.source === 'public-custom') {
      const diskName = selectedTool.id || selectedTool.name
      try {
        await deletePublicCustomSkillByName(diskName)
        setPublicCustomSkills((current) => current.filter((skill) => skill.id !== diskName && skill.name !== diskName))
        const fallback = catalogPublicCustomSkills.find((tool) => tool.id !== diskName)
          || catalogPublicBuiltinSkills[0]
        setSelectedToolKey(fallback ? skillSelectionKey(fallback) : '')
      } catch (e) {
        console.error('[tool-package] delete public custom skill failed:', e)
      }
      setWorkspaceTab(WORKSPACE_TAB_SKILLS)
      return
    }
    const ownerSiteId = selectedTool.siteId || site.id
    mutateCustomSkillsForSite(ownerSiteId, (current) => current.filter((skill) => skill.id !== selectedTool.id))
    const fallbackOfficial = catalogOfficialSkills.find((tool) => tool.siteId === site.id) || catalogOfficialSkills[0]
    if (fallbackOfficial) setSelectedToolKey(skillSelectionKey(fallbackOfficial))
    setWorkspaceTab(WORKSPACE_TAB_SKILLS)
  }

  const handleToolDrop = (event) => {
    event.preventDefault()
    setDragOverEditor(false)
    const key = event.dataTransfer.getData('application/x-weworker-tool')
    const sourceTool = allSkills.find((tool) => toolKey(tool) === key)
    if (sourceTool) addCustomSkill(sourceTool)
  }

  return (
    <div className="tool-package-shell" style={shellStyle}>
      <div className="tool-package-frame">
        <header className="tool-package-header-bar" style={headerShellStyle}>
          <div className="header-tab-row" style={headerTabRowStyle}>
            <WorkspaceTabBar value={workspaceTab} onChange={switchWorkspaceTab} />
            <div style={headerTabActionsStyle}>
              {workspaceTab === WORKSPACE_TAB_SKILLS && (
                <IconButton
                  label="刷新 skills"
                  onClick={handleRefreshSkills}
                  disabled={refreshingSkills}
                >
                  <RefreshIcon />
                </IconButton>
              )}
              {showRightPaneShell && (
                <IconButton
                  label={rightPaneOpen ? '隐藏 Skill 面板' : '展开 Skill 面板'}
                  onClick={() => setRightPaneOpen((current) => !current)}
                >
                  {rightPaneOpen ? <PanelHideIcon /> : <PanelExpandIcon />}
                </IconButton>
              )}
              <IconButton label="返回" onClick={handleClose}>
                <BackIcon />
              </IconButton>
            </div>
          </div>
        </header>

        <div
          ref={workspaceRef}
          className="tool-package-workspace"
          style={workspaceStyle}
        >
        <aside className={`scrollbar-hover-only${showSkillsRightPane ? ' skill-catalog-workspace' : ''}${showScenarioWorkspace ? ' scenario-workspace-sidebar' : ''}`} style={{ ...leftPaneStyle, flex: showSkillsRightPane ? '1 1 0' : `0 0 ${leftPaneWidth}px`, width: showSkillsRightPane ? undefined : leftPaneWidth, maxWidth: showSkillsRightPane ? undefined : leftPaneWidth }}>
          {showScenarioWorkspace ? (
            <>
              <button data-app-button="action"
                type="button"
                className="tool-package-primary-btn"
                onClick={addScenario}
                disabled={creatingScenario}
                style={{
                  ...primaryButtonStyle,
                  ...(creatingScenario ? disabledButtonStyle : null),
                }}
              >
                {creatingScenario ? '新增中' : '新增场景'}
              </button>
              <ScenarioSiteSelect
                sites={editableSites}
                selectedId={selectedScenarioSiteId}
                onChange={onToggleScenarioSiteId}
              />
              <div className="scenario-search-field" style={scenarioSearchShellStyle}>
                <input
                  type="search"
                  value={scenarioSearchQuery}
                  onChange={(event) => setScenarioSearchQuery(event.target.value)}
                  placeholder="搜索"
                  aria-label="搜索场景"
                  style={scenarioSearchInputStyle}
                />
              </div>
              <div className="scenario-list-heading" style={rightPanelHeaderStyle}>
                <div style={paneTitleStyle}>可用场景</div>
                <div style={rightPanelMetaStyle}>共 {visibleScenarioList.length} 个</div>
              </div>
              <ScenarioSidebarList
                scenarios={visibleScenarioList}
                selectedScenarioId={selectedScenarioId}
                onSelect={selectScenario}
                searchQuery={scenarioSearchQuery}
              />
            </>
          ) : (
            <>
          <div className="skill-catalog-toolbar">
            <AppDropdownSelect
              className="skill-catalog-filter"
              ariaLabel="筛选 Skill"
              value={skillFilter}
              options={[{ value: 'all', label: '全部' }, { value: 'custom', label: '自定义' }]}
              onChange={setSkillFilter}
              minMenuWidth={120}
            />
            <input type="search" aria-label="搜索 Skill 名称、描述或标签" placeholder="搜索名称、描述或标签" value={toolSearchQuery} onChange={event => setToolSearchQuery(event.target.value)} />
            <AppDropdownSelect
              className="skill-catalog-sort"
              ariaLabel="Skill 排序"
              prefix={<SortAscendingOutlined aria-hidden="true" />}
              value={skillSort}
              options={[{ value: 'created', label: '创建时间' }, { value: 'name', label: '名称' }]}
              menuHeader="排序方式"
              onChange={setSkillSort}
              minMenuWidth={150}
            />
            <SkillAddMenu busy={importingSkillZip} onUpload={importSkillZipFile} onCreate={createBlankSkill} />
          </div>
          {skillsLoadError && <div role="alert">{skillsLoadError}<button data-app-button="action" type="button" onClick={() => reloadPublicSkills().catch(error => setSkillsLoadError(error.message))}>重试</button></div>}
          <ToolList tools={visibleSkills} selectedTool={selectedTool} onSelect={selectTool} getTags={getTags} onToggle={toggleSkill} togglingSkills={togglingSkills} />
          {!visibleSkills.length && <div style={emptyEditorStyle}>没有匹配的 skill。</div>}
            </>
          )}
        </aside>

        {showScenarioWorkspace && <div
          role="separator"
          aria-label="调整左侧工具列表宽度"
          aria-orientation="vertical"
          onPointerDown={(event) => startPaneResize('left', event)}
          style={{
            ...resizeHandleStyle,
            flex: `0 0 ${RESIZE_HANDLE_WIDTH}px`,
            ...(resizingSide === 'left' ? resizeHandleActiveStyle : null),
          }}
        />}

        {showScenarioWorkspace && <main
          className="tool-package-editor-pane scenario-workspace-editor"
          style={{
            ...editorPaneStyle,
            flex: '1 1 0',
            minWidth: 0,
            minHeight: 0,
            boxShadow: !showScenarioWorkspace && dragOverEditor ? 'inset 0 0 0 2px var(--accent)' : editorPaneStyle.boxShadow,
          }}
          onDragOver={showScenarioWorkspace ? undefined : (event) => {
            event.preventDefault()
            setDragOverEditor(true)
          }}
          onDragLeave={showScenarioWorkspace ? undefined : () => setDragOverEditor(false)}
          onDrop={showScenarioWorkspace ? undefined : handleToolDrop}
        >
          {showScenarioWorkspace && selectedScenario ? (
            <ScenarioEditor
              key={scenarioKey(selectedScenario)}
              scenario={selectedScenario}
              editable={selectedScenarioEditable}
              onSave={saveSelectedScenario}
              onReset={resetSelectedScenario}
              onRefresh={refreshSelectedScenario}
              onDelete={deleteSelectedScenario}
              onDirtyChange={setScenarioDirty}
            />
          ) : showScenarioWorkspace ? (
            <div style={emptyEditorStyle}>请选择一个场景。</div>
          ) : selectedTool ? (
            <ToolEditor
              tags={getTags(selectedTool)}
              onTagsChange={tags => saveTags(selectedTool, tags)}
              key={selectedToolKey}
              tool={selectedTool}
              site={selectedToolSite}
              scenarios={scenarioList}
              editable={selectedIsEditable}
              isCustom={selectedIsCustom}
              slashMenuTools={slashMenuTools}
              slashSystemTools={builtinToolkitTools}
              duplicateNameWarning={selectedCustomSkillDuplicateName}
              onChange={updateSelectedSkill}
              onParamChange={updateParam}
              onAddParam={() => updateSelectedSkill({ parameters: [...selectedTool.parameters, { ...EMPTY_PARAM }] })}
              onDeleteParam={(index) => updateSelectedSkill({ parameters: selectedTool.parameters.filter((_, i) => i !== index) })}
              onDelete={deleteCustomSkill}
            />
          ) : (
            <div style={emptyEditorStyle}>{isPublicScope ? '请选择一个公共 skill。' : '请选择一个工具，或点击新增 skill。'}</div>
          )}
        </main>}

        {showRightPaneShell && <div
          className={`skill-detail-drawer${effectiveRightPaneOpen ? ' is-open' : ''}`}
          aria-hidden={!effectiveRightPaneOpen}
          style={{
            flex: effectiveRightPaneOpen ? `0 0 ${Math.min(560, Math.max(0, workspaceWidth - 280, workspaceWidth * 0.42))}px` : '0 0 0px',
            width: effectiveRightPaneOpen ? Math.min(560, Math.max(0, workspaceWidth - 280, workspaceWidth * 0.42)) : 0,
          }}
        >
          <div className="skill-detail-drawer-header">
            <div className="skill-detail-drawer-tabs" role="tablist" aria-label="Skill 侧栏视图">
              <button type="button" role="tab" aria-selected={rightPaneView === 'skill'} onClick={() => setRightPaneView('skill')}>Skill 详情</button>
              <button type="button" role="tab" aria-selected={rightPaneView === 'toolkit'} onClick={() => setRightPaneView('toolkit')}>工具包</button>
            </div>
            <IconButton label="关闭右侧面板" onClick={() => setRightPaneOpen(false)}><PanelHideIcon /></IconButton>
          </div>
          <div className="skill-detail-drawer-content">
            {rightPaneView === 'skill' && selectedTool ? (
              <ToolEditor
                tags={getTags(selectedTool)}
                onTagsChange={tags => saveTags(selectedTool, tags)}
                key={selectedToolKey}
                tool={selectedTool}
                site={selectedToolSite}
                scenarios={scenarioList}
                editable={selectedIsEditable}
                isCustom={selectedIsCustom}
                slashMenuTools={slashMenuTools}
                slashSystemTools={builtinToolkitTools}
                duplicateNameWarning={selectedCustomSkillDuplicateName}
                onChange={updateSelectedSkill}
                onParamChange={updateParam}
                onAddParam={() => updateSelectedSkill({ parameters: [...selectedTool.parameters, { ...EMPTY_PARAM }] })}
                onDeleteParam={(index) => updateSelectedSkill({ parameters: selectedTool.parameters.filter((_, i) => i !== index) })}
                onDelete={deleteCustomSkill}
              />
            ) : rightPaneView === 'toolkit' ? (
              <aside className="skill-drawer-toolkit" style={{ ...rightPaneStyle, width: '100%', flex: '1 1 auto', maxWidth: 'none' }}>
              <div style={rightPanelHeaderStyle}>
                <div style={rightPanelHeaderTopRowStyle}>
                  <DropdownSelect
                    value={toolkitKind}
                    onChange={setToolkitKind}
                    options={toolkitKindOptions}
                    ariaLabel="工具包类型"
                    compact
                    minMenuWidth={152}
                  />
                  {showToolkitSearch && (
                    <div style={toolkitSearchShellStyle}>
                      <input
                        type="search"
                        value={toolkitSearchQuery}
                        onChange={(event) => setToolkitSearchQuery(event.target.value)}
                        placeholder="搜索"
                        aria-label={toolkitKind === TOOLKIT_KIND_BUILTIN ? '搜索内置工具' : '搜索场景工具'}
                        style={toolkitSearchInputStyle}
                      />
                    </div>
                  )}
                </div>
                <div style={rightPanelMetaStyle}>
                  {showSceneToolkitUnavailable
                    ? '公共 skill 不可用'
                    : toolkitKind === TOOLKIT_KIND_BUILTIN
                      ? `内置工具 ${visibleToolkitTools.length} 个 · 与站点无关`
                      : `场景工具 ${visibleToolkitTools.length} 个 · 与当前站点相关`}
                </div>
              </div>
              {showSceneToolkitUnavailable ? (
                <div style={emptyEditorStyle}>公共 skill 不关联场景工具包，可切换到内置工具包查看系统工具。</div>
              ) : (
                <ToolkitToolList tools={visibleToolkitTools} searchQuery={toolkitSearchQuery} />
              )}
              </aside>
            ) : <div style={emptyEditorStyle}>请选择一个 Skill。</div>}
          </div>
        </div>}
        </div>
      </div>
    </div>
  )
}

function DropdownSelect({
  value,
  onChange,
  options,
  ariaLabel,
  fullWidth = false,
  compact = false,
  minMenuWidth,
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const currentLabel = options.find((option) => option.value === value)?.label || options[0]?.label || ''
  const closeMenu = () => setOpen(false)

  useDropdownDismiss(open, closeMenu, triggerRef, menuRef)

  return (
    <div
      style={{
        position: 'relative',
        ...(fullWidth ? { width: '100%', minWidth: 0 } : null),
        ...(compact ? { flexShrink: 0 } : null),
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        style={{
          ...(compact ? scopeSelectCompactStyle : scopeSelectFullStyle),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span style={scopeSelectLabelStyle}>{currentLabel}</span>
        <span style={scopeSelectCaretStyle} aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <DropdownMenuPortal
        ref={menuRef}
        open={open}
        anchorRef={triggerRef}
        minWidth={minMenuWidth ?? (compact ? 128 : 180)}
      >
        <div role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              onClick={() => {
                onChange(option.value)
                closeMenu()
              }}
              className={dropdownMenuItemClassName({ selected: value === option.value })}
            >
              {option.label}
              <DropdownMenuCheck selected={value === option.value} />
            </button>
          ))}
        </div>
      </DropdownMenuPortal>
    </div>
  )
}

function WorkspaceTabBar({ value, onChange }) {
  const barRef = useRef(null)
  const tabRefs = useRef([])
  const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false })

  const syncIndicator = () => {
    const index = value === WORKSPACE_TAB_SKILLS ? 0 : 1
    const tab = tabRefs.current[index]
    const bar = barRef.current
    if (!tab || !bar) return
    const tabRect = tab.getBoundingClientRect()
    const barRect = bar.getBoundingClientRect()
    setIndicator({
      left: tabRect.left - barRect.left,
      width: tabRect.width,
      ready: tabRect.width > 0,
    })
  }

  useLayoutEffect(() => {
    syncIndicator()
  }, [value])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined
    const observer = new ResizeObserver(() => syncIndicator())
    observer.observe(bar)
    tabRefs.current.forEach((tab) => {
      if (tab) observer.observe(tab)
    })
    return () => observer.disconnect()
  }, [value])

  return (
    <div ref={barRef} className="workspace-tab-bar" role="tablist" aria-label="工作区切换">
      <span
        className={`workspace-tab-indicator${indicator.ready ? ' workspace-tab-indicator--ready' : ''}`}
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: indicator.width,
        }}
        aria-hidden="true"
      />
      <button
        type="button"
        role="tab"
        ref={(node) => { tabRefs.current[0] = node }}
        aria-selected={value === WORKSPACE_TAB_SKILLS}
        className={`workspace-tab${value === WORKSPACE_TAB_SKILLS ? ' workspace-tab--active' : ''}`}
        onClick={() => onChange(WORKSPACE_TAB_SKILLS)}
      >
        SKILLS
      </button>
      <button
        type="button"
        role="tab"
        ref={(node) => { tabRefs.current[1] = node }}
        aria-selected={value === WORKSPACE_TAB_SCENARIOS}
        className={`workspace-tab${value === WORKSPACE_TAB_SCENARIOS ? ' workspace-tab--active' : ''}`}
        onClick={() => onChange(WORKSPACE_TAB_SCENARIOS)}
      >
        场景
      </button>
    </div>
  )
}

function ToolkitToolList({ tools, searchQuery = '' }) {
  const detailsRefs = useRef([])

  const handleToggle = (index, event) => {
    const current = event.currentTarget
    if (current.open) {
      detailsRefs.current.forEach((element, itemIndex) => {
        if (itemIndex !== index && element) element.open = false
      })
    }
  }

  return (
    <div className="right-panel-list scrollbar-hover-only">
      {tools.map((tool, index) => (
        <details
          key={`${toolKey(tool)}:${index}`}
          ref={(element) => { detailsRefs.current[index] = element }}
          className="right-panel-details"
          onToggle={(event) => handleToggle(index, event)}
        >
          <summary className="right-panel-item right-panel-item--summary" title={buildToolTooltip(tool)}>
            <span className="right-panel-item-title">
              {buildToolSiteMetaPrefix(tool)}{tool.name}
            </span>
            <span className="right-panel-item-desc">
              {tool.description || summarizeParams(tool.parameters)}
            </span>
          </summary>
          <div className="right-panel-expand">
            <div className="right-panel-expand-section">
              <div className="right-panel-expand-label">说明</div>
              <p className="right-panel-expand-text">{tool.description?.trim() || '暂无说明'}</p>
            </div>
            <div className="right-panel-expand-section">
              <div className="right-panel-expand-label">参数</div>
              {!tool.parameters?.length ? (
                <p className="right-panel-expand-text">无参数</p>
              ) : (
                <div className="right-panel-param-list">
                  {tool.parameters.map((param, paramIndex) => (
                    <div key={`${param.name || 'param'}-${paramIndex}`} className="right-panel-param-row">
                      <div className="right-panel-param-head">
                        <span className="right-panel-param-name">{param.name || '未命名'}</span>
                        <span className="right-panel-param-type">{param.type || 'string'}</span>
                        <span className="right-panel-param-required">{param.required ? '必填' : '可选'}</span>
                      </div>
                      {param.description?.trim() && (
                        <p className="right-panel-param-desc">{param.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </details>
      ))}
      {tools.length === 0 && (
        <div style={emptyEditorStyle}>
          {searchQuery.trim() ? '没有匹配的工具。' : '暂无工具。'}
        </div>
      )}
    </div>
  )
}

function ScenarioSiteSelect({ sites, selectedId, onChange }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const selectedSite = sites.find((item) => item.id === selectedId) || sites[0]
  const closeMenu = () => setOpen(false)
  useDropdownDismiss(open, closeMenu, triggerRef, menuRef)

  const selectSite = (siteId) => {
    if (!siteId || siteId === selectedId) {
      closeMenu()
      return
    }
    onChange?.(siteId)
    closeMenu()
  }

  return (
    <div className="scenario-site-select" style={scenarioSiteSelectShellStyle}>
      <span style={scenarioSiteSelectLabelStyle}>场景站点</span>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={sites.length === 0}
        style={scenarioSiteSelectTriggerStyle}
        aria-label="选择场景站点"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={scenarioSiteSelectValueStyle}>{selectedSite?.name || '选择站点'}</span>
        <span style={scenarioSiteSelectCaretStyle} aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <DropdownMenuPortal
        ref={menuRef}
        open={open}
        anchorRef={triggerRef}
        matchAnchorWidth
        offsetY={6}
      >
        <div role="listbox" aria-label="选择场景站点" className={`${DROPDOWN_MENU_LIST_CLASS} scrollbar-hover-only`}>
          {sites.map((site) => {
            const selected = site.id === selectedSite?.id
            return (
              <button
                key={site.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => selectSite(site.id)}
                className={dropdownMenuItemClassName({ selected })}
              >
                {site.name}
                <DropdownMenuCheck selected={selected} />
              </button>
            )
          })}
        </div>
      </DropdownMenuPortal>
    </div>
  )
}

function ScenarioSidebarList({ scenarios, selectedScenarioId, onSelect, searchQuery = '' }) {
  return (
    <div className="scenario-list" style={toolListStyle}>
      {scenarios.map((scenario) => {
        const key = scenarioKey(scenario)
        const active = key === selectedScenarioId
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(scenario)}
            className={`tool-package-list-item${active ? ' is-active' : ''}`}
            title={scenario.summary || scenario.title || '未命名场景'}
          >
            <span style={toolNameStyle}>
              {buildScenarioSiteMetaPrefix(scenario)}{scenario.title || '未命名场景'}
            </span>
            <span style={toolDescStyle}>{scenario.summary || '暂无说明'}</span>
          </button>
        )
      })}
      {scenarios.length === 0 && (
        <div style={emptyEditorStyle}>
          {searchQuery.trim() ? '没有匹配的场景。' : '暂无可用场景。'}
        </div>
      )}
    </div>
  )
}

function ToolList({ tools, selectedTool, onSelect, getTags, onToggle, togglingSkills }) {
  return (
    <div className="skill-catalog-grid" style={toolListStyle}>
      {tools.map((tool) => {
        const key = skillSelectionKey(tool)
        const active = !!selectedTool && key === skillSelectionKey(selectedTool)
        const createdAtLabel = formatSkillCreatedAt(tool)
        return (
          <div
            key={key}
            role="button"
            tabIndex={0}
            aria-label={tool.name || '未命名 skill'}
            aria-pressed={active}
            onClick={() => onSelect(tool)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(tool)
              }
            }}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('application/x-weworker-tool', toolKey(tool))}
            title={tool.name || '未命名 skill'}
            className={`tool-package-list-item skill-catalog-item${active ? ' is-active' : ''}`}
          >
            <span className="skill-card-heading">
              <span style={toolNameStyle}>{tool.name}</span>
              {createdAtLabel ? (
                <time className="skill-card-created-at" dateTime={new Date(tool.createdAt).toISOString()} title={`创建／添加时间：${new Date(tool.createdAt).toLocaleString('zh-CN', { hour12: false })}`} aria-label={`创建／添加时间：${createdAtLabel}`}>
                  {createdAtLabel}
                </time>
              ) : <span className="skill-card-created-at" title="暂无创建／添加时间">时间未知</span>}
            </span>
            <span style={toolDescStyle}>{tool.draft ? '空白文件夹 · 待编写 SKILL.md' : tool.description || summarizeParams(tool.parameters)}</span>
            <span className="skill-catalog-list-tags">{getTags(tool).map(tag => <span key={tag}>{tag}</span>)}</span>
            <span className="skill-card-switch" title={tool.draft ? '请先编写 SKILL.md，再启用' : !tool.installed ? 'Skill 尚未安装，请刷新后重试' : tool.enabled ? '已启用，下次对话可加载' : '已关闭，下次对话不再加载'} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
              <AppSwitch aria-label={`启用 ${tool.name}`} checked={tool.enabled} disabled={!tool.installed || tool.draft || togglingSkills.has(skillDirectoryName(tool))} onChange={event => onToggle(tool, event.target.checked)} />
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ScenarioEditor({ scenario, editable = false, canReset = false, onSave, onReset, onRefresh, onDelete, onDirtyChange }) {
  const [draft, setDraft] = useState(() => editableScenarioPayload(scenario))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveState, setSaveState] = useState('')
  const [collapsedSections, setCollapsedSections] = useState({
    title: true,
    summary: true,
    prompt: true,
  })
  const syncedRevisionRef = useRef(scenarioEditorRevision(scenario))
  const promptText = draft.prompts?.[0]?.text || ''
  const dirty = serializeScenarioDraft(editableScenarioPayload(scenario)) !== serializeScenarioDraft(draft)

  useEffect(() => {
    const nextRevision = scenarioEditorRevision(scenario)
    if (syncedRevisionRef.current === nextRevision) return
    syncedRevisionRef.current = nextRevision
    setDraft(editableScenarioPayload(scenario))
    setSaveState('')
  }, [scenario])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => {
    onDirtyChange?.(false)
  }, [onDirtyChange])

  const toggleSection = (section) => {
    setCollapsedSections((current) => ({ ...current, [section]: !current[section] }))
  }

  const updateDraft = (patch) => {
    if (!editable) return
    setSaveState('')
    setDraft((current) => ({ ...current, ...patch }))
  }

  const updatePrompt = (text) => {
    if (!editable) return
    const prompts = draft.prompts?.length ? [...draft.prompts] : [{ text: '' }]
    prompts[0] = { ...prompts[0], text }
    updateDraft({ prompts })
  }

  const saveDraft = async () => {
    if (!editable || !dirty || saving) return
    setSaving(true)
    setSaveState('')
    try {
      const saved = await onSave(draft)
      if (!saved) {
        throw new Error('保存未生效')
      }
      syncedRevisionRef.current = scenarioEditorRevision(saved)
      setDraft(editableScenarioPayload(saved))
      setSaveState('已保存')
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败'
      setSaveState(message.includes('fetch') || message.includes('Failed') ? '保存失败：服务未响应' : `保存失败：${message}`)
    } finally {
      setSaving(false)
    }
  }

  const resetDraft = async (fields) => {
    if (!editable || !canReset) return
    setSaving(true)
    setSaveState('')
    try {
      const restored = await onReset(fields)
      if (restored) {
        syncedRevisionRef.current = scenarioEditorRevision(restored)
        setDraft(editableScenarioPayload(restored))
      }
      setSaveState('已恢复')
    } catch {
      setSaveState('恢复失败')
    } finally {
      setSaving(false)
    }
  }

  const refreshDraft = async () => {
    if (saving || deleting) return
    setSaving(true)
    setSaveState('')
    try {
      const refreshed = await onRefresh?.()
      const nextScenario = refreshed || scenario
      syncedRevisionRef.current = scenarioEditorRevision(nextScenario)
      setDraft(editableScenarioPayload(nextScenario))
      setSaveState('已刷新')
    } catch {
      setSaveState('刷新失败')
    } finally {
      setSaving(false)
    }
  }

  const deleteDraft = async () => {
    if (!editable || saving || deleting) return
    setDeleting(true)
    setSaveState('')
    try {
      const deleted = await onDelete?.()
      if (!deleted) setSaveState('')
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败'
      setSaveState(`删除失败：${message}`)
    } finally {
      setDeleting(false)
    }
  }

  const sectionResetAction = (fields) => (
    editable && canReset
      ? <IconButton label="恢复默认值" onClick={() => resetDraft(fields)} disabled={saving || deleting} compact><RestoreIcon /></IconButton>
      : null
  )

  return (
    <EditorPaneShell
      layoutKey={`scenario:${scenarioKey(scenario)}`}
      className="scenario-editor-shell"
      header={(
        <>
          <div>
            <div style={sourceBadgeStyle}>{scenarioSourceBadgeLabel(scenario)}</div>
            <h3 style={editorTitleStyle}>{draft.title || '未命名场景'}</h3>
          </div>
          <div style={scenarioHeaderActionsStyle}>
            <span style={updatedAtStyle} title={formatScenarioUpdatedAtTitle(scenario.updatedAt)}>
              {formatScenarioUpdatedAt(scenario.updatedAt)}
            </span>
            {saveState && <span style={saveStateStyle}>{saveState}</span>}
            {editable ? (
              <>
                <IconButton
                  label={saving ? '保存中' : '保存'}
                  onClick={saveDraft}
                  disabled={saving || deleting || !dirty}
                  accent
                >
                  <SaveIcon />
                </IconButton>
                <IconButton
                  label={deleting ? '删除中' : '删除场景'}
                  onClick={deleteDraft}
                  disabled={saving || deleting}
                  danger
                >
                  <TrashIcon />
                </IconButton>
              </>
            ) : (
              <IconButton label={saving ? '刷新中' : '刷新'} onClick={refreshDraft} disabled={saving || deleting}>
                <RestoreIcon />
              </IconButton>
            )}
          </div>
        </>
      )}
    >
        <div className="scenario-editor-form" style={formStyle}>
      <CollapsibleSection
        title="场景名称"
        meta={`${countLines(draft.title)} 行`}
        collapsed={Boolean(collapsedSections.title)}
        onToggle={() => toggleSection('title')}
        actions={sectionResetAction(['title'])}
      >
        <CodeTextInput
          value={draft.title || ''}
          onChange={(value) => updateDraft({ title: value })}
          readOnly={!editable}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="说明"
        meta={`${countLines(draft.summary)} 行`}
        collapsed={Boolean(collapsedSections.summary)}
        onToggle={() => toggleSection('summary')}
        actions={sectionResetAction(['summary'])}
      >
        <CodeTextarea
          value={draft.summary || ''}
          onChange={(value) => updateDraft({ summary: value })}
          readOnly={!editable}
          fitContent
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="对话提示词"
        meta={`${countLines(promptText)} 行`}
        collapsed={Boolean(collapsedSections.prompt)}
        onToggle={() => toggleSection('prompt')}
        actions={sectionResetAction(['prompts'])}
      >
        <CodeTextarea
          value={promptText}
          onChange={updatePrompt}
          minHeight={124}
          readOnly={!editable}
          fitContent
        />
      </CollapsibleSection>
        </div>
    </EditorPaneShell>
  )
}

function EditorPaneShell({ header, children, layoutKey = '', className = '' }) {
  const shellRef = useRef(null)
  const headerRef = useRef(null)
  const scrollRef = useRef(null)
  const [scrollHeight, setScrollHeight] = useState(0)

  useLayoutEffect(() => {
    const shellNode = shellRef.current
    const headerNode = headerRef.current
    if (!shellNode || !headerNode) return undefined

    const syncScrollHeight = () => {
      const next = Math.max(0, shellNode.clientHeight - headerNode.offsetHeight)
      setScrollHeight((current) => (current === next ? current : next))
    }

    syncScrollHeight()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncScrollHeight) : null
    observer?.observe(shellNode)
    observer?.observe(headerNode)
    window.addEventListener('resize', syncScrollHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', syncScrollHeight)
    }
  }, [layoutKey])

  return (
    <EditorPaneScrollContext.Provider value={scrollRef}>
      <div ref={shellRef} className={`tool-package-editor-shell${className ? ` ${className}` : ''}`} style={editorPaneShellStyle}>
        <div ref={headerRef} style={editorPaneHeaderStyle}>{header}</div>
        <div
          ref={scrollRef}
          className="tool-package-editor-scroll scrollbar-hover-only"
          style={{
            ...editorPaneScrollStyle,
            height: scrollHeight > 0 ? scrollHeight : undefined,
            maxHeight: scrollHeight > 0 ? scrollHeight : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </EditorPaneScrollContext.Provider>
  )
}

function IconButton({ label, onClick, disabled, accent = false, danger = false, compact = false, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...iconButtonStyle,
        ...(compact ? compactIconButtonStyle : null),
        ...(accent && !disabled ? iconButtonAccentStyle : null),
        ...(danger && !disabled ? iconButtonDangerStyle : null),
        ...(disabled ? disabledButtonStyle : null),
      }}
    >
      {children}
    </button>
  )
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M3 2.5h8.2L13.5 4.8V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A.5.5 0 0 1 3 2.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5 2.5v4h6v-4M5.25 14v-4.2h5.5V14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M5 4.2A5 5 0 1 1 3.7 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.1 1.9v2.3H2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M3.5 4.5h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6 4.5V3.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8V4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 4.5l.4 7.2a.8.8 0 0 0 .8.8h4a.8.8 0 0 0 .8-.8l.4-7.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M11.1 2.9a1 1 0 0 1 1.4 0l.6.6a1 1 0 0 1 0 1.4L5.5 12.5 3 13l.5-2.5L11.1 2.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ResourceNodeNameField({
  name,
  displayLabel,
  isRenaming,
  onCommit,
  onCancel,
}) {
  const inputRef = useRef(null)
  const draftRef = useRef(name)
  const committedRef = useRef(false)
  const [draft, setDraft] = useState(name)

  const updateDraft = (value) => {
    draftRef.current = value
    setDraft(value)
  }

  const commitDraft = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCommit(draftRef.current.trim())
  }

  useEffect(() => {
    if (!isRenaming) {
      committedRef.current = false
      updateDraft(name)
      return undefined
    }

    committedRef.current = false
    updateDraft(name)
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })

    const handlePointerDown = (event) => {
      if (inputRef.current?.contains(event.target)) return
      commitDraft()
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [isRenaming, name])

  if (isRenaming) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => updateDraft(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            commitDraft()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!committedRef.current) {
              committedRef.current = true
              onCancel()
            }
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (!committedRef.current) commitDraft()
          }, 0)
        }}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        style={resourceNameInputStyle}
        aria-label="编辑名称"
      />
    )
  }

  return (
    <span style={resourceNodeNameStyle} title={displayLabel}>
      {displayLabel}
    </span>
  )
}

function CollapsibleSection({ title, stickyPath, meta, collapsed, onToggle, actions, titleAddon, children, sticky = true, fileIcon }) {
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onToggle()
    }
  }
  const displayTitle = !collapsed && stickyPath ? stickyPath : title

  if (fileIcon) {
    return (
      <section className="skill-file-section">
        <div className={`skill-file-section-header${!collapsed && sticky ? ' is-sticky' : ''}`}>
          <button
            type="button"
            className="skill-file-section-toggle"
            aria-label={title}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <RightOutlined className="skill-file-section-chevron" aria-hidden="true" />
            <span className="skill-file-section-icon" aria-hidden="true">{fileIcon}</span>
            <span className="skill-file-section-title" title={displayTitle}>{displayTitle}</span>
            {meta && <span className="skill-file-section-meta">{meta}</span>}
          </button>
          {titleAddon && <div className="skill-file-section-notice">{titleAddon}</div>}
          {actions && <div className="skill-file-section-actions">{actions}</div>}
        </div>
        {!collapsed && <div className="skill-file-section-body">{children}</div>}
      </section>
    )
  }

  return (
    <section style={collapsibleSectionStyle}>
      <div
        role="button"
        tabIndex={0}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.currentTarget.blur()
          onToggle()
        }}
        onKeyDown={handleKeyDown}
        style={{
          ...collapsibleHeaderStyle,
          ...(!collapsed && sticky ? collapsibleHeaderStickyStyle : null),
        }}
      >
        <div style={collapsibleToggleStyle}>
          <span style={collapseIconBoxStyle}>
            <span style={{
              ...collapseIconStyle,
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            }}
            />
          </span>
          <span style={collapsibleTitleStyle}>{displayTitle}</span>
          {titleAddon}
          {meta && <span style={collapsibleMetaStyle}>{meta}</span>}
        </div>
        {actions && <div onClick={(event) => event.stopPropagation()}>{actions}</div>}
      </div>
      {!collapsed && children}
    </section>
  )
}

function CodeTextInput({ value, onChange, readOnly = false }) {
  return (
    <div style={codeEditorShellStyle}>
      <div style={lineNumbersStyle}>1</div>
      <input
        value={value}
        onChange={(event) => {
          if (!readOnly) onChange(event.target.value)
        }}
        readOnly={readOnly}
        style={{
          ...codeInputStyle,
          ...(readOnly ? readOnlyCodeFieldStyle : null),
        }}
      />
    </div>
  )
}

function CodeTextarea({ value, onChange, minHeight = 96, readOnly = false, maxHeight, fitContent = false }) {
  const lines = countLines(value)
  const fitHeight = codeEditorFitHeight(lines, minHeight)
  const textareaRef = useRef(null)
  const lineNumbersRef = useRef(null)
  const resolvedHeight = useFitTextareaHeight(textareaRef, value, {
    fitContent,
    minHeight,
    estimatedHeight: fitContent ? fitHeight : (maxHeight ?? minHeight),
  })
  const boxHeight = fitContent ? resolvedHeight : (maxHeight ?? minHeight)

  const syncLineNumbersScroll = (event) => {
    if (fitContent || !lineNumbersRef.current) return
    lineNumbersRef.current.scrollTop = event.target.scrollTop
  }

  return (
    <div style={{
      ...codeEditorShellStyle,
      minHeight: boxHeight,
      ...(fitContent ? { height: boxHeight, flexShrink: 0 } : { maxHeight: boxHeight }),
    }}>
      <div ref={lineNumbersRef} style={{
        ...(fitContent ? lineNumbersStyle : lineNumbersScrollStyle),
        ...(fitContent ? { minHeight: boxHeight, height: boxHeight } : null),
      }}>
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} style={codeEditorLineNumberRowStyle()}>{index + 1}</span>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className="code-editor-textarea-scroll scrollbar-hover-only"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncLineNumbersScroll}
        readOnly={readOnly}
        style={{
          ...codeTextareaStyle,
          ...(readOnly ? readOnlyCodeFieldStyle : null),
          minHeight: fitContent ? minHeight : boxHeight,
          height: boxHeight,
          overflowY: fitContent ? 'hidden' : 'auto',
          overflowX: 'auto',
          whiteSpace: 'pre',
          resize: 'none',
        }}
      />
    </div>
  )
}

function ToolEditor({ tags, onTagsChange, tool, site, scenarios, editable, isCustom = false, slashMenuTools = [], slashSystemTools = [], duplicateNameWarning = '', onChange, onDelete }) {
  if (editable) {
    return (
      <SkillDocumentEditor
        tags={tags} onTagsChange={onTagsChange}
        tool={tool}
        site={site}
        scenarios={scenarios}
        editable
        isCustom
        slashMenuTools={slashMenuTools}
        slashSystemTools={slashSystemTools}
        duplicateNameWarning={duplicateNameWarning}
        onChange={onChange}
        onDelete={onDelete}
      />
    )
  }

  return (
    <SkillDocumentEditor
        tags={tags} onTagsChange={onTagsChange}
      tool={tool}
      site={site}
      scenarios={scenarios}
      editable={false}
      isCustom={isCustom}
      slashMenuTools={slashMenuTools}
      slashSystemTools={slashSystemTools}
      duplicateNameWarning={duplicateNameWarning}
    />
  )
}

function skillSourceLabel(tool) {
  if (tool?.source === 'public-skill') return '公共 skill'
  if (tool?.source === 'public-custom' || tool?.source === 'custom') return '自定义'
  return '官方只读'
}

function skillSourceBadgeLabel(tool) {
  if (tool?.source === 'public-skill') return '公共 skill · 不可修改'
  if (tool?.source === 'public-custom' || tool?.source === 'custom') return '自定义 skill · 可修改'
  return '官方 skill · 不可修改'
}

function hasSkillDiskLocation(tool) {
  return tool?.source === 'public-custom' || tool?.source === 'custom'
}

function updateResourceContent(resources, relativePath, content) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/')
  return resources.map((resource) => {
    if (resource.relativePath !== normalizedPath) return resource
    if (resource.readable !== true || resource.is_directory === true) return resource
    return {
      ...resource,
      content,
      size: new TextEncoder().encode(content).length,
      modified_at: new Date().toISOString(),
    }
  })
}

function SkillDocumentEditor({ tags, onTagsChange, tool, site, scenarios, editable, isCustom = false, slashMenuTools = [], slashSystemTools = [], duplicateNameWarning = '', onChange, onDelete }) {
  const [expandedPath, setExpandedPath] = useState(SKILL_MD_PATH)
  const [renamingPath, setRenamingPath] = useState(null)
  const [forcedPreviews, setForcedPreviews] = useState({})
  const [resourceImportProgress, setResourceImportProgress] = useState(null)
  const resourcePreviewExtensions = useSettingsStore((s) => s.resourcePreviewExtensions)
  const previewExtensionSet = useMemo(
    () => buildPreviewExtensionSet(resourcePreviewExtensions),
    [resourcePreviewExtensions],
  )
  const storedMarkdown = (editable || isCustom)
    ? (typeof tool.markdown === 'string' ? tool.markdown : customSkillTemplateMarkdown)
    : (typeof tool.markdown === 'string' && tool.markdown.trim() ? tool.markdown : buildOfficialToolMarkdown(tool))
  const resources = editable ? (tool.resources || []) : (isCustom ? (tool.resources || []) : [])
  const displayResources = useMemo(
    () => enrichResourcesForPreview(resources, previewExtensionSet),
    [resources, previewExtensionSet],
  )
  const markdown = storedMarkdown

  const loadResourcePreview = async (relativePath) => {
    const normalizedPath = normalizeResourcePath(relativePath)
    setForcedPreviews((current) => ({
      ...current,
      [normalizedPath]: { loading: true },
    }))
    try {
      const preview = await loadSkillResourcePreview({
        source: tool.source,
        skillId: tool.id || tool.name,
        siteId: site.id,
        relativePath: normalizedPath,
      })
      setForcedPreviews((current) => ({
        ...current,
        [normalizedPath]: {
          loading: false,
          content: preview?.content || '',
          truncated: preview?.truncated === true,
          isBinary: preview?.isBinary === true,
        },
      }))
      return preview
    } catch (error) {
      const message = error instanceof Error ? error.message : '预览失败'
      setForcedPreviews((current) => ({
        ...current,
        [normalizedPath]: {
          loading: false,
          error: message,
        },
      }))
      throw error
    }
  }

  useEffect(() => {
    const path = expandedPath
    if (!path || path === SKILL_MD_PATH || path === RESOURCES_SECTION_PATH) return
    const resource = findResourceByPath(displayResources, path)
    if (!resource || resource.is_directory || typeof resource.content === 'string') return
    if (!resource.readable) return
    const normalizedPath = normalizeResourcePath(path)
    const current = forcedPreviews[normalizedPath]
    if (current?.loading || typeof current?.content === 'string' || current?.error) return
    loadResourcePreview(normalizedPath).catch(() => {})
  }, [expandedPath, displayResources, forcedPreviews, tool.id, tool.name, tool.source, site.id])

  useEffect(() => {
    setExpandedPath(SKILL_MD_PATH)
    setRenamingPath(null)
    setForcedPreviews({})
  }, [tool.id])

  const toggleExpandedPath = (path) => {
    setExpandedPath((current) => {
      if (current === path) {
        if (path === SKILL_MD_PATH || path === RESOURCES_SECTION_PATH) return null
        const parentPath = getResourceParentPath(path)
        return parentPath || RESOURCES_SECTION_PATH
      }
      const normalized = normalizeResourcePath(path)
      setForcedPreviews((previews) => {
        if (!previews[normalized]?.error) return previews
        const next = { ...previews }
        delete next[normalized]
        return next
      })
      return path
    })
  }

  const resourcesSectionCollapsed = expandedPath === SKILL_MD_PATH || expandedPath === null

  const toggleResourcesSection = () => {
    if (resourcesSectionCollapsed) {
      setExpandedPath(RESOURCES_SECTION_PATH)
      return
    }
    setExpandedPath(null)
  }

  const markResourceExpanded = (path, { rename = false } = {}) => {
    setExpandedPath(path)
    if (rename) setRenamingPath(path)
  }

  const handleRenameResource = (oldPath, newName) => {
    const trimmed = String(newName || '').trim()
    if (!trimmed) {
      setRenamingPath(null)
      return
    }
    const nextResources = renameResourceEntry(resources, oldPath, trimmed)
    if (!nextResources) {
      setRenamingPath(null)
      return
    }
    const nextPath = resolveRenamedResourcePath(oldPath, trimmed)
    onChange?.({
      resources: nextResources,
    })
    if (expandedPath === oldPath) setExpandedPath(nextPath)
    else if (expandedPath.startsWith(`${oldPath}/`)) {
      setExpandedPath(`${nextPath}${expandedPath.slice(oldPath.length)}`)
    }
    setRenamingPath(null)
  }

  const handleCreateFolder = (parentPath) => {
    const { resources: nextResources, path } = appendResourceFolder(resources, DEFAULT_FOLDER_NAME, parentPath, previewExtensionSet)
    onChange?.({ resources: nextResources })
    markResourceExpanded(path, { rename: true })
  }

  const handleCreateFile = (parentPath) => {
    const { resources: nextResources, path } = appendResourceFile(resources, parentPath, DEFAULT_NEW_FILE_NAME, previewExtensionSet)
    const addedResource = findResourceByPath(nextResources, path)
    onChange?.({
      resources: nextResources,
      markdown: appendResourceHintForResource(storedMarkdown, addedResource, tool.name),
    })
    markResourceExpanded(path, { rename: true })
  }

  const handleUploadFiles = async (parentPath) => {
    try {
      const paths = await window.electronAPI?.selectFiles?.({
        filters: [{ name: '所有文件', extensions: ['*'] }],
      })
      if (!Array.isArray(paths) || paths.length === 0) return
      const onProgress = (progress) => {
        if (!progress) return
        const percent = progress.total_bytes > 0
          ? Math.max(0, Math.min(100, Math.round((progress.copied_bytes / progress.total_bytes) * 100)))
          : (progress.total_files > 0 ? Math.max(0, Math.min(100, Math.round((progress.copied_files / progress.total_files) * 100))) : 0)
        setResourceImportProgress({
          ...progress,
          percent,
          currentFile: progress.current_file || progress.currentFile || '',
        })
      }
      if (tool.source === 'public-custom') {
        const diskName = tool.id || tool.name
        const nextResources = await importPublicSkillResources(diskName, paths, parentPath, onProgress)
        markResourceExpanded(parentPath)
        onChange?.({
          resources: normalizeResources(nextResources),
          markdown: appendResourceHintsForAddedFiles(storedMarkdown, resources, normalizeResources(nextResources), tool.name),
        })
        setResourceImportProgress((current) => (current?.status === 'done' ? null : current))
        return
      }
      const saved = await importCustomSkillResources(site.id, tool.id, paths, parentPath, onProgress, tool.name)
      const normalized = normalizeTool(saved, 'custom')
      markResourceExpanded(parentPath)
      onChange?.({
        resources: normalized.resources,
        markdown: appendResourceHintsForAddedFiles(storedMarkdown, resources, normalized.resources, tool.name),
      })
      setResourceImportProgress((current) => (current?.status === 'done' ? null : current))
    } catch (error) {
      console.error('[tool-package] upload resource files failed:', error)
      showAlert(error instanceof Error ? error.message : '上传文件失败')
      setResourceImportProgress(null)
    }
  }

  const handleUploadFolder = async (parentPath) => {
    try {
      const paths = await window.electronAPI?.selectDirectory?.()
      if (!Array.isArray(paths) || paths.length === 0) return
      const onProgress = (progress) => {
        if (!progress) return
        const percent = progress.total_bytes > 0
          ? Math.max(0, Math.min(100, Math.round((progress.copied_bytes / progress.total_bytes) * 100)))
          : (progress.total_files > 0 ? Math.max(0, Math.min(100, Math.round((progress.copied_files / progress.total_files) * 100))) : 0)
        setResourceImportProgress({
          ...progress,
          percent,
          currentFile: progress.current_file || progress.currentFile || '',
        })
      }
      if (tool.source === 'public-custom') {
        const diskName = tool.id || tool.name
        const nextResources = await importPublicSkillResources(diskName, paths, parentPath, onProgress)
        markResourceExpanded(parentPath)
        onChange?.({
          resources: normalizeResources(nextResources),
          markdown: appendResourceHintsForAddedFiles(storedMarkdown, resources, normalizeResources(nextResources), tool.name),
        })
        setResourceImportProgress((current) => (current?.status === 'done' ? null : current))
        return
      }
      const saved = await importCustomSkillResources(site.id, tool.id, paths, parentPath, onProgress, tool.name)
      const normalized = normalizeTool(saved, 'custom')
      markResourceExpanded(parentPath)
      onChange?.({
        resources: normalized.resources,
        markdown: appendResourceHintsForAddedFiles(storedMarkdown, resources, normalized.resources, tool.name),
      })
      setResourceImportProgress((current) => (current?.status === 'done' ? null : current))
    } catch (error) {
      console.error('[tool-package] upload resource folder failed:', error)
      showAlert(error instanceof Error ? error.message : '上传文件夹失败')
      setResourceImportProgress(null)
    }
  }

  const handleDeleteResource = async (relativePath, { isFolder = false } = {}) => {
    const normalized = normalizeResourcePath(relativePath)
    const name = normalized.split('/').filter(Boolean).pop() || normalized
    const confirmMessage = isFolder
      ? `确定删除文件夹「${name}」及其中的所有文件吗？`
      : `确定删除资源文件「${name}」吗？`
    if (!await showConfirm(confirmMessage, '删除资源', { danger: true })) return
    const nextResources = isFolder
      ? removeResourcePath(resources, relativePath)
      : removeResourceFile(resources, relativePath)
    setForcedPreviews((current) => {
      let changed = false
      const next = { ...current }
      for (const key of Object.keys(next)) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : current
    })
    if (expandedPath === normalized || expandedPath?.startsWith(`${normalized}/`)) {
      setExpandedPath(RESOURCES_SECTION_PATH)
    }
    onChange?.({
      resources: nextResources,
    })
  }

  const handleRequestPreview = async (relativePath, resource) => {
    if (!resource || resource.is_directory || resource.readable === true) return
    if (!await showConfirm(buildForcePreviewConfirmMessage(resource), '预览资源')) return

    const normalizedPath = normalizeResourcePath(relativePath)
    markResourceExpanded(normalizedPath)

    try {
      await loadResourcePreview(normalizedPath)
    } catch (error) {
      showAlert(error instanceof Error ? error.message : '预览失败')
    }
  }

  return (
    <EditorPaneShell
      layoutKey={`${tool.id || tool.name}:${expandedPath || 'none'}`}
      header={(
        <>
          <div className="skill-editor-header-content">
            <h3 style={editorTitleStyle}>{tool.name || '未命名 skill'}</h3>
            <div className="skill-editor-kicker">
              <span className="skill-editor-kicker-dot" aria-hidden="true" />
              {skillSourceBadgeLabel(tool)}
            </div>
            <SkillTags key={toolKey(tool)} tags={tags} onChange={onTagsChange} />
          </div>
          {editable && (
            <div className="skill-editor-actions" style={scenarioHeaderActionsStyle}>
              {hasSkillDiskLocation(tool) && (
                <OpenSkillFolderButton site={site} tool={tool} />
              )}
              <CustomSkillBuiltinVarsHelp site={site} tool={tool} />
              <button data-app-button="action" data-variant="danger" type="button" onClick={onDelete} style={dangerButtonStyle}>删除</button>
            </div>
          )}
        </>
      )}
    >
        <div className="skill-files-group">
      <CollapsibleSection
        title={tool.draft ? "SKILL.md（尚未创建，输入后保存）" : "SKILL.md"}
        fileIcon={<FileTextOutlined />}
        stickyPath={SKILL_MD_PATH}
        meta={`${countLines(markdown)} 行`}
        collapsed={expandedPath !== SKILL_MD_PATH}
        onToggle={() => toggleExpandedPath(SKILL_MD_PATH)}
        titleAddon={duplicateNameWarning ? (
          <span style={duplicateSkillNameWarningStyle} title={`重复名称：${duplicateNameWarning}`}>
            名称重复，该 skill 可能工作不正常
          </span>
        ) : null}
      >
        {editable ? (
          <SkillMarkdownCodeTextarea
            value={markdown}
            site={site}
            tool={tool}
            officialTools={slashMenuTools}
            systemTools={slashSystemTools}
            onChange={(value) => {
              const meta = parseSkillMarkdownMeta(value)
              onChange({
                markdown: value,
                ...(meta.description ? { description: meta.description } : null),
              })
            }}
            minHeight={320}
            fitContent
          />
        ) : (
          <CodeTextarea
            value={markdown}
            onChange={() => {}}
            readOnly
            minHeight={320}
            fitContent
          />
        )}
      </CollapsibleSection>

      {editable && (
      <ResourcesCollapsibleSection
        expandedPath={expandedPath}
        resources={displayResources}
        meta={`${displayResources.length} 个文件`}
        collapsed={resourcesSectionCollapsed}
        onToggle={toggleResourcesSection}
        actions={editable ? (
              <ResourceAddMenu showLabel
                onNewFolder={() => handleCreateFolder('')}
                onNewFile={() => handleCreateFile('')}
                onUploadFolder={() => handleUploadFolder('')}
                onUploadFiles={() => handleUploadFiles('')}
              />
        ) : null}
      >
        {resourceImportProgress && (
          <SkillResourceImportProgress progress={resourceImportProgress} />
        )}
        <ResourceTree
          key={tool.id || tool.name}
          resources={displayResources}
          editable={editable}
          expandedPath={expandedPath}
          renamingPath={renamingPath}
          forcedPreviews={forcedPreviews}
          onTogglePath={toggleExpandedPath}
          onStartRename={setRenamingPath}
          onRenameResource={handleRenameResource}
          onCancelRename={() => setRenamingPath(null)}
          onCreateFolder={handleCreateFolder}
          onCreateFile={handleCreateFile}
          onUploadFiles={handleUploadFiles}
          onUploadFolder={handleUploadFolder}
          onDeleteResource={handleDeleteResource}
          onRequestPreview={editable ? handleRequestPreview : undefined}
          onResourceChange={(relativePath, content) => {
            onChange?.({ resources: updateResourceContent(resources, relativePath, content) })
          }}
        />
      </ResourcesCollapsibleSection>
      )}
        </div>
    </EditorPaneShell>
  )
}

function OpenSkillFolderButton({ site, tool }) {
  const [opening, setOpening] = useState(false)
  const userDirectory = useSettingsStore((s) => s.userDirectory)

  const handleOpenFolder = async () => {
    if (opening) return
    setOpening(true)
    try {
      let dirPath = ''
      if (tool.source === 'public-custom') {
        const skillId = tool.id || tool.name
        try {
          const data = await fetchPublicSkillDirectory(skillId)
          dirPath = data.path
        } catch (error) {
          if (error instanceof Error && error.message === 'Skill not found') {
            showAlert('Skill folder not found. Please refresh the skill list.')
            return
          }
          dirPath = await window.electronAPI?.resolveSkillDirectory?.({
            source: 'public-custom',
            skillId,
          }) || resolveSkillDirectoryPath({
            source: 'public-custom',
            skillId,
            userDirectory,
          })
        }
      } else if (tool.source === 'custom') {
        try {
          const data = await fetchCustomSkillDirectory(site.id, tool.id)
          dirPath = data.path
        } catch {
          dirPath = await window.electronAPI?.resolveSkillDirectory?.({
            source: 'custom',
            siteId: site.id,
            skillId: tool.id,
            skillName: tool.name,
          }) || resolveSkillDirectoryPath({
            source: 'custom',
            siteId: site.id,
            skillId: tool.id,
            skillName: tool.name,
            userDirectory,
          })
        }
      } else {
        showAlert('当前 skill 没有本地文件夹')
        return
      }
      if (!dirPath) {
        showAlert('无法获取 skill 文件夹路径')
        return
      }
      const openPath = window.electronAPI?.openPath
      if (!openPath) {
        showAlert('当前环境无法打开文件夹')
        return
      }
      const err = await openPath(dirPath)
      if (err) showAlert(err)
    } catch (error) {
      showAlert(error instanceof Error ? error.message : '打开文件夹失败')
    } finally {
      setOpening(false)
    }
  }

  return (
    <button data-app-button="action"
      type="button"
      onClick={handleOpenFolder}
      disabled={opening}
      style={{
        ...openFolderButtonStyle,
        ...(opening ? disabledButtonStyle : null),
      }}
      title="在文件管理器中打开 skill 文件夹"
    >
      <FolderIcon size={14} />
      打开文件夹
    </button>
  )
}

function CustomSkillBuiltinVarsHelp({ site, tool }) {
  const [open, setOpen] = useState(false)
  const shellRef = useRef(null)
  const entries = useMemo(
    () => buildBuiltinVariableHelpEntries({ site, tool }),
    [site, tool],
  )

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (shellRef.current && !shellRef.current.contains(event.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  return (
    <div ref={shellRef} style={builtinHelpShellStyle}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={builtinHelpButtonStyle}
        title="查看内置变量与使用说明"
        aria-expanded={open}
      >
        内置变量
      </button>
      {open && (
        <div style={builtinHelpPanelStyle} role="dialog" aria-label="自定义 skill 内置变量说明">
          <div style={builtinHelpPanelTitleStyle}>内置变量</div>
          <p style={builtinHelpSummaryStyle}>{BUILTIN_PLACEHOLDER_USAGE}</p>
          <div style={builtinHelpPanelBodyStyle}>
            <section style={builtinHelpSectionStyle}>
              <div style={builtinHelpSectionTitleStyle}>可用占位符</div>
              <div style={builtinHelpItemsStyle}>
                {entries.map((entry) => (
                  <div key={entry.key} style={builtinHelpItemStyle}>
                    <div style={builtinHelpItemHeadStyle}>
                      <code style={builtinHelpCodeStyle}>{entry.placeholder}</code>
                    </div>
                    <p style={builtinHelpItemDescStyle}>{entry.description}</p>
                    {entry.preview && (
                      <div style={builtinHelpPreviewStyle}>当前值：{entry.preview}</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

function ResourceNodeActions({ preview = null, rename = null, add = null, trailing = null }) {
  return (
    <div style={resourceNodeActionsStyle}>
      <div style={resourceNodeActionSlotStyle}>{preview}</div>
      <div style={resourceNodeActionSlotStyle}>{rename}</div>
      <div style={resourceNodeActionSlotStyle}>{add}</div>
      <div style={resourceNodeActionSlotStyle}>{trailing}</div>
    </div>
  )
}

function SkillResourceImportProgress({ progress }) {
  const percent = Math.max(0, Math.min(100, Number(progress?.percent || 0)))
  const currentFile = String(progress?.currentFile || progress?.current_file || '').trim()
  const label = progress?.status === 'error'
    ? (progress?.error || '上传失败')
    : progress?.status === 'done'
      ? '上传完成'
      : currentFile || '正在上传资源'

  return (
    <div style={skillResourceImportProgressWrapStyle}>
      <div style={skillResourceImportProgressHeaderStyle}>
        <span style={skillResourceImportProgressLabelStyle}>{label}</span>
        <span style={skillResourceImportProgressPercentStyle}>{percent}%</span>
      </div>
      <div style={skillResourceImportProgressBarOuterStyle}>
        <div style={{
          ...skillResourceImportProgressBarInnerStyle,
          width: `${percent}%`,
          background: progress?.status === 'error' ? 'var(--danger)' : 'var(--accent)',
        }}
        />
      </div>
    </div>
  )
}

function ResourceAddMenu({ onNewFolder, onNewFile, onUploadFolder, onUploadFiles, showLabel = false }) {
  const [open, setOpen] = useState(false)
  const shellRef = useRef(null)
  const menuRef = useRef(null)

  const closeMenu = () => setOpen(false)
  useDropdownDismiss(open, closeMenu, shellRef, menuRef)

  const run = (action) => {
    closeMenu()
    action?.()
  }

  return (
    <div
      ref={shellRef}
      style={resourceAddMenuShellStyle}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {showLabel ? (
        <button
          type="button"
          className="skill-file-add"
          aria-label="新建或上传"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <PlusOutlined aria-hidden="true" />
          添加
        </button>
      ) : <IconButton
        label="新建或上传"
        onClick={() => setOpen((value) => !value)}
        compact
      >
        <PlusIcon />
      </IconButton>}
      <DropdownMenuPortal
        ref={menuRef}
        open={open}
        anchorRef={shellRef}
        align="end"
        minWidth={140}
      >
        <button type="button" className={DROPDOWN_MENU_ITEM_CLASS} onClick={() => run(onNewFolder)}>新建文件夹</button>
        <button type="button" className={DROPDOWN_MENU_ITEM_CLASS} onClick={() => run(onNewFile)}>新建文件</button>
        <div className={DROPDOWN_MENU_DIVIDER_CLASS} />
        <button type="button" className={DROPDOWN_MENU_ITEM_CLASS} onClick={() => run(onUploadFolder)}>上传文件夹</button>
        <button type="button" className={DROPDOWN_MENU_ITEM_CLASS} onClick={() => run(onUploadFiles)}>上传文件</button>
      </DropdownMenuPortal>
    </div>
  )
}

function ResourceTree({
  resources,
  editable = false,
  onResourceChange,
  expandedPath,
  renamingPath,
  forcedPreviews = {},
  onTogglePath,
  onStartRename,
  onRenameResource,
  onCancelRename,
  onCreateFolder,
  onCreateFile,
  onUploadFiles,
  onUploadFolder,
  onDeleteResource,
  onRequestPreview,
}) {
  const tree = useMemo(() => buildResourceTree(resources), [resources])
  const displayNodes = tree.children

  if (!editable && !resources?.length) {
    return <div style={emptyEditorStyle}>暂无资源文件。</div>
  }

  if (editable && !displayNodes.length) {
    return <div style={resourceEmptyFolderStyle}>暂无文件，可从右上角添加。</div>
  }

  return (
    <div style={resourceTreeStyle}>
      {displayNodes.map((node) => (
        <ResourceTreeNode
          key={node.path || node.name}
          node={node}
          depth={0}
          expandedPath={expandedPath}
          renamingPath={renamingPath}
          forcedPreviews={forcedPreviews}
          onTogglePath={onTogglePath}
          onStartRename={onStartRename}
          onRenameResource={onRenameResource}
          onCancelRename={onCancelRename}
          editable={editable}
          onResourceChange={onResourceChange}
          onCreateFolder={onCreateFolder}
          onCreateFile={onCreateFile}
          onUploadFiles={onUploadFiles}
          onUploadFolder={onUploadFolder}
          onDeleteResource={onDeleteResource}
          onRequestPreview={onRequestPreview}
        />
      ))}
    </div>
  )
}

function getResourceNodeLineCount(node, forcedPreview) {
  if (node.type === 'file') {
    const content = node.resource?.content ?? forcedPreview?.content
    return content ? countLines(content) : 0
  }
  return Array.isArray(node.children) ? node.children.length : 0
}

function ResourceTreeNode({
  node,
  depth,
  expandedPath,
  renamingPath,
  forcedPreviews = {},
  onTogglePath,
  onStartRename,
  onRenameResource,
  onCancelRename,
  editable = false,
  onResourceChange,
  onCreateFolder,
  onCreateFile,
  onUploadFiles,
  onUploadFolder,
  onDeleteResource,
  onRequestPreview,
}) {
  const isActiveExpanded = expandedPath === node.path
  const isRenaming = renamingPath === node.path
  const showFolderChildren = node.type === 'folder'
    && isResourceExpandedPath(expandedPath)
    && (expandedPath === node.path || expandedPath.startsWith(`${node.path}/`))
  const isNodeExpanded = node.type === 'folder' ? showFolderChildren : isActiveExpanded
  const resourcePath = node.resource?.relativePath || node.path
  const forcedPreview = forcedPreviews[normalizeResourcePath(resourcePath)]
  const lineCount = getResourceNodeLineCount(node, forcedPreview)
  const canEditFile = editable && node.type === 'file' && node.resource?.readable === true
  let filePreviewValue = '该文件无法直接预览。'
  if (typeof node.resource?.content === 'string') {
    filePreviewValue = node.resource.content
  } else if (forcedPreview?.loading) {
    filePreviewValue = '正在加载预览。'
  } else if (forcedPreview?.error) {
    filePreviewValue = `预览失败：${forcedPreview.error}`
  } else if (typeof forcedPreview?.content === 'string') {
    filePreviewValue = forcedPreview.content
  } else if (node.resource?.readable) {
    filePreviewValue = ''
  }
  const showForcePreview = node.type === 'file'
    && node.resource?.readable !== true
    && !node.resource?.is_directory
    && typeof onRequestPreview === 'function'
  const parentPath = resolveFolderParentPath(node.path)
  const showFolderMenu = editable && node.type === 'folder'
  const showFolderDelete = editable && node.type === 'folder'
  const showFileDelete = editable && node.type === 'file'
  const hasForcedPreview = typeof forcedPreview?.content === 'string'
  const displayPath = resourcePath || node.path
  const displayLabel = isRenaming ? node.name : (isActiveExpanded ? displayPath : node.name)

  return (
    <div>
      <div style={{
        ...resourceNodeRowStyle,
        ...(isActiveExpanded ? resourceStickyHeaderStyle : null),
      }}
      >
        <div style={resourceNodeMainRowStyle}>
          <button
            type="button"
            aria-label={isNodeExpanded ? '收起' : '展开'}
            onClick={() => onTogglePath(node.path)}
            style={{ ...resourceExpandButtonStyle, marginLeft: 10 + depth * 16 }}
          >
            <span style={collapseIconBoxStyle}>
              <span style={{
                ...collapseIconStyle,
                transform: isNodeExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              }}
              />
            </span>
          </button>
          <div
            onClick={() => {
              if (!isRenaming) onTogglePath(node.path)
            }}
            onKeyDown={(event) => {
              if (isRenaming) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onTogglePath(node.path)
              }
            }}
            role={isRenaming ? undefined : 'button'}
            tabIndex={isRenaming ? -1 : 0}
            style={{
              ...(node.type === 'folder' ? resourceNodeBodyStyle : resourceFileNodeBodyStyle),
              cursor: isRenaming ? 'default' : 'pointer',
            }}
            title={displayPath}
          >
            <span style={resourceNodeKindIconStyle} aria-hidden="true">
              {node.type === 'folder' ? <FolderIcon size={14} /> : <FileIcon size={14} />}
            </span>
            <ResourceNodeNameField
              name={node.name}
              displayLabel={displayLabel}
              isRenaming={isRenaming}
              onCommit={(nextName) => onRenameResource?.(node.path, nextName)}
              onCancel={() => onCancelRename?.()}
            />
            <span style={resourceNodeMetaStyle}>
              {node.type === 'folder'
                ? `${lineCount} 项`
                : `${formatBytes(node.resource?.size || 0)}${(node.resource?.readable || hasForcedPreview) && lineCount > 0 ? ` · ${lineCount} 行` : ''}${canEditFile ? ' · 可编辑' : ''}`}
            </span>
          </div>
        </div>
        {!isRenaming && (
          <ResourceNodeActions
            preview={showForcePreview ? (
              <IconButton
                label="预览"
                compact
                onClick={(event) => {
                  event.stopPropagation()
                  onRequestPreview?.(resourcePath, node.resource)
                }}
              >
                <EyeIcon size={14} />
              </IconButton>
            ) : null}
            rename={editable ? (
              <IconButton
                label="重命名"
                compact
                onClick={(event) => {
                  event.stopPropagation()
                  onStartRename?.(node.path)
                }}
              >
                <PencilIcon />
              </IconButton>
            ) : null}
            trailing={(showFileDelete || showFolderDelete) ? (
              <IconButton
                label={showFolderDelete ? '删除文件夹' : '删除文件'}
                compact
                onClick={() => onDeleteResource?.(resourcePath, { isFolder: showFolderDelete })}
              >
                <TrashIcon />
              </IconButton>
            ) : null}
            add={showFolderMenu ? (
              <ResourceAddMenu
                onNewFolder={() => onCreateFolder?.(parentPath)}
                onNewFile={() => onCreateFile?.(parentPath)}
                onUploadFolder={() => onUploadFolder?.(parentPath)}
                onUploadFiles={() => onUploadFiles?.(parentPath)}
              />
            ) : null}
          />
        )}
      </div>
      {showFolderChildren && (
        <div>
          {(node.children || []).length === 0 ? (
            <div style={{ ...resourceEmptyFolderStyle, paddingLeft: 26 + depth * 16 }}>
              空文件夹，使用右侧 + 新建或上传。
            </div>
          ) : (
            (node.children || []).map((child) => (
              <ResourceTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedPath={expandedPath}
                renamingPath={renamingPath}
                forcedPreviews={forcedPreviews}
                onTogglePath={onTogglePath}
                onStartRename={onStartRename}
                onRenameResource={onRenameResource}
                onCancelRename={onCancelRename}
                editable={editable}
                onResourceChange={onResourceChange}
                onCreateFolder={onCreateFolder}
                onCreateFile={onCreateFile}
                onUploadFiles={onUploadFiles}
                onUploadFolder={onUploadFolder}
                onDeleteResource={onDeleteResource}
                onRequestPreview={onRequestPreview}
              />
            ))
          )}
        </div>
      )}
      {isActiveExpanded && node.type === 'file' && (
        <>
          <ResourceFileScrollSentinel active />
          <CodeTextarea
            value={filePreviewValue}
            onChange={(value) => {
              if (!canEditFile) return
              onResourceChange?.(node.resource?.relativePath || node.path, value)
            }}
            readOnly={!canEditFile}
            minHeight={92}
            fitContent
          />
        </>
      )}
    </div>
  )
}

const shellStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 0,
  height: '100%',
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  boxSizing: 'border-box',
  overflow: 'hidden',
}

const headerShellStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  flexShrink: 0,
  minWidth: 0,
}

const headerTabRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
}

const headerTabActionsStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  flexShrink: 0,
}

const scopeFiltersStyle = {
  display: 'grid',
  gap: 8,
  flexShrink: 0,
  width: '100%',
  minWidth: 0,
}

const scopeFiltersSecondaryStyle = {
  minHeight: 32,
  display: 'flex',
  alignItems: 'stretch',
  width: '100%',
  minWidth: 0,
}

const scopeFiltersCompactStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
}

const scopeSelectFullStyle = {
  width: '100%',
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}

const scopeSelectCompactStyle = {
  ...scopeSelectFullStyle,
  width: 'auto',
  minWidth: 128,
}

const scopeSelectLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
}

const scopeSelectCaretStyle = {
  flexShrink: 0,
  color: 'var(--text-muted)',
  fontSize: 11,
}

const scopeHintFullStyle = {
  width: '100%',
  minHeight: 32,
  height: 32,
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--bg-secondary) 55%, var(--bg-primary))',
  color: 'var(--text-muted)',
  padding: '0 10px',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  whiteSpace: 'nowrap',
}

const workspaceStyle = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
  overflow: 'hidden',
}

const leftPaneStyle = {
  flexShrink: 0,
  minWidth: 0,
  minHeight: 0,
  borderRight: '1px solid var(--border)',
  padding: '12px 10px 12px 12px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
  overflowY: 'auto',
  overflowX: 'hidden',
  boxSizing: 'border-box',
  background: 'var(--bg-secondary)',
}

const skillsHeaderControlsStyle = {
  width: '100%',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 8,
  flexShrink: 0,
}

const rightPaneStyle = {
  minWidth: 0,
  width: '100%',
  minHeight: 0,
  borderLeft: '1px solid var(--border)',
  padding: '12px 12px 12px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  overflow: 'hidden',
  position: 'relative',
  zIndex: 1,
  boxSizing: 'border-box',
  background: 'var(--bg-secondary)',
}

const resizeHandleStyle = {
  minWidth: 6,
  width: 6,
  minHeight: 0,
  cursor: 'col-resize',
  position: 'relative',
  touchAction: 'none',
}

const resizeHandleActiveStyle = {
  background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
}

const editorPaneStyle = {
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  borderRadius: 0,
  background: 'var(--bg-secondary)',
  padding: 0,
  boxSizing: 'border-box',
  boxShadow: 'none',
}

const editorPaneShellStyle = {
  flex: 1,
  minHeight: 0,
  height: '100%',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const editorPaneScrollStyle = {
  flex: 'none',
  minHeight: 0,
  padding: '0 16px 16px',
}

const paneTitleStyle = {
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 760,
  lineHeight: '22px',
}

const toolListStyle = {
  display: 'grid',
  gap: 4,
}

const toolFilterBarStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'stretch',
  minWidth: 0,
  width: '100%',
  height: 30,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: SEARCH_FIELD_BACKGROUND,
  overflow: 'hidden',
}

const filterInputStyle = {
  width: '100%',
  minWidth: 0,
  height: '100%',
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '0 9px',
  fontFamily: 'inherit',
  fontSize: 11,
  outline: 'none',
}

const filterSelectRootStyle = {
  position: 'relative',
  flexShrink: 0,
  height: '100%',
}

function getFilterSelectTriggerStyle(mode, isActive) {
  const base = {
    height: '100%',
    boxSizing: 'border-box',
    border: 'none',
    borderLeft: '1px solid var(--border)',
    background: isActive
      ? 'color-mix(in srgb, var(--accent) 6%, var(--bg-secondary))'
      : 'transparent',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    padding: '0 6px',
    flexShrink: 0,
    outline: 'none',
  }

  if (mode === 'icon') {
    return {
      ...base,
      width: 28,
      minWidth: 28,
      maxWidth: 28,
      padding: 0,
      flex: '0 0 28px',
    }
  }

  if (mode === 'compact') {
    return {
      ...base,
      flex: '0 0 44px',
      minWidth: 44,
      maxWidth: 56,
      padding: '0 4px',
    }
  }

  return {
    ...base,
    flex: '0 0 72px',
    minWidth: 72,
    maxWidth: 96,
    padding: '0 7px',
  }
}

const filterSelectLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
}

const filterSelectCaretStyle = {
  flex: '0 0 auto',
  color: 'var(--text-muted)',
  fontSize: 10,
  lineHeight: 1,
}

const toolNameStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 760,
  fontSize: 13,
}

const toolDescStyle = {
  minWidth: 0,
  color: 'var(--text-secondary)',
  fontSize: 11,
  lineHeight: 1.35,
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  overflow: 'hidden',
}

const toolMetaStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-muted)',
  fontSize: 11,
}

const formStyle = {
  display: 'grid',
  gap: 14,
}

const editorHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

const editorPaneHeaderStyle = {
  ...editorHeaderStyle,
  flex: '0 0 auto',
  flexShrink: 0,
  padding: '12px 16px 14px',
}

const scenarioHeaderActionsStyle = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const sourceBadgeStyle = {
  color: 'var(--accent)',
  fontSize: 12,
  fontWeight: 720,
}

const updatedAtStyle = {
  color: 'var(--text-muted)',
  fontSize: 11,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minWidth: 116,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

const saveStateStyle = {
  color: 'var(--text-muted)',
  fontSize: 12,
  whiteSpace: 'nowrap',
}

const editorTitleStyle = {
  margin: '4px 0 0',
  fontSize: 20,
  lineHeight: 1.25,
  overflowWrap: 'anywhere',
}

const fieldStyle = {
  display: 'grid',
  gap: 6,
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 720,
}

const collapsibleSectionStyle = {
  display: 'grid',
  gap: 0,
  minWidth: 0,
  borderRadius: 8,
  background: 'var(--bg-primary)',
  overflow: 'visible',
  outline: 'none',
  boxShadow: 'inset 0 0 0 1px var(--border)',
}

const collapsibleHeaderStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 5,
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-primary)',
  padding: '0 10px',
  boxSizing: 'border-box',
  cursor: 'pointer',
  outline: 'none',
  boxShadow: 'none',
  appearance: 'none',
  WebkitAppearance: 'none',
  WebkitTapHighlightColor: 'transparent',
}

const collapsibleHeaderStickyStyle = {
  position: 'sticky',
  top: 0,
  zIndex: 6,
  background: 'var(--bg-primary)',
  borderBottom: '1px solid var(--border)',
}

const collapsibleToggleStyle = {
  minWidth: 0,
  flex: '1 1 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--text-primary)',
  padding: 0,
  fontFamily: 'inherit',
  fontSize: 12,
}

const collapsibleTitleStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 650,
  lineHeight: 1.2,
}

const collapsibleMetaStyle = {
  flex: '0 0 auto',
  marginLeft: 'auto',
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 400,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1,
}

const duplicateSkillNameWarningStyle = {
  flex: '0 0 auto',
  marginLeft: 4,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'rgba(239, 68, 68, 0.12)',
  color: 'var(--danger, #ef4444)',
  fontSize: 11,
  fontWeight: 650,
  whiteSpace: 'nowrap',
}

const collapseIconBoxStyle = {
  width: 16,
  height: 16,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
}

const collapseIconStyle = {
  width: 0,
  height: 0,
  borderLeft: '4px solid transparent',
  borderRight: '4px solid transparent',
  borderTop: '5px solid var(--text-muted)',
  color: 'var(--text-muted)',
  transformOrigin: '50% 45%',
  transition: 'transform 120ms ease',
}

const iconButtonStyle = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-primary)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
  lineHeight: 1,
  outline: 'none',
}

const compactIconButtonStyle = {
  width: 24,
  height: 24,
  borderRadius: 6,
}

const iconButtonAccentStyle = {
  borderColor: 'var(--accent)',
  background: 'var(--accent)',
  color: '#fff',
}

const iconButtonDangerStyle = {
  borderColor: 'color-mix(in srgb, var(--danger, #ef4444) 44%, var(--border))',
  background: 'color-mix(in srgb, var(--danger, #ef4444) 12%, var(--bg-primary))',
  color: 'var(--danger, #ef4444)',
}

const inputStyle = {
  width: '100%',
  minWidth: 0,
  height: 34,
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  padding: '0 10px',
  fontFamily: 'inherit',
  fontSize: 13,
}

const textareaStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 96,
  resize: 'vertical',
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  padding: '9px 10px',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.55,
}

const codeEditorShellStyle = {
  width: '100%',
  minWidth: 0,
  display: 'grid',
  gridTemplateColumns: '38px minmax(0, 1fr)',
  boxSizing: 'border-box',
  background: 'var(--bg-primary)',
  overflow: 'hidden',
}

const lineNumbersStyle = {
  display: 'grid',
  alignContent: 'start',
  gap: 0,
  borderRight: '1px solid var(--border)',
  background: 'color-mix(in srgb, var(--bg-secondary) 70%, var(--bg-primary))',
  color: 'var(--text-muted)',
  padding: '9px 8px',
  boxSizing: 'border-box',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: CODE_EDITOR_FONT_SIZE,
  lineHeight: CODE_EDITOR_LINE_HEIGHT,
  textAlign: 'right',
  userSelect: 'none',
}

const lineNumbersScrollStyle = {
  ...lineNumbersStyle,
  overflow: 'hidden',
}

const codeInputStyle = {
  width: '100%',
  minWidth: 0,
  height: 34,
  boxSizing: 'border-box',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '0 10px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
}

const readOnlyCodeFieldStyle = {
  color: 'var(--text-secondary)',
  cursor: 'default',
}

const codeTextareaStyle = {
  width: '100%',
  minWidth: 0,
  resize: 'vertical',
  boxSizing: 'border-box',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  padding: '9px 10px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: CODE_EDITOR_FONT_SIZE,
  lineHeight: CODE_EDITOR_LINE_HEIGHT,
}

const paramsHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 720,
}

const paramsStyle = {
  display: 'grid',
  gap: 10,
}

const resourceAddMenuShellStyle = {
  position: 'relative',
  display: 'inline-flex',
}

const skillResourceImportProgressWrapStyle = {
  display: 'grid',
  gap: 6,
  padding: '10px 12px 8px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-primary)',
}

const skillResourceImportProgressHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
  color: 'var(--text-secondary)',
  fontSize: 12,
}

const skillResourceImportProgressLabelStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const skillResourceImportProgressPercentStyle = {
  flex: '0 0 auto',
}

const skillResourceImportProgressBarOuterStyle = {
  height: 6,
  borderRadius: 999,
  overflow: 'hidden',
  background: 'var(--border)',
}

const skillResourceImportProgressBarInnerStyle = {
  height: '100%',
  borderRadius: 999,
  transition: 'width 120ms linear',
}

const resourceTreeStyle = {
  display: 'grid',
  gap: 0,
  borderTop: '1px solid var(--border)',
}

const resourceNodeRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-primary)',
  paddingRight: 10,
  minHeight: 34,
}

const resourceNodeActionsStyle = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 4,
}

const resourceNodeActionSlotStyle = {
  width: 24,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
}

const resourceNodeMainRowStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 0,
}

const resourceExpandButtonStyle = {
  flex: '0 0 auto',
  width: 16,
  height: 34,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  padding: 0,
}

const resourceNodeBodyStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  height: 34,
  display: 'grid',
  gridTemplateColumns: '16px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
  padding: '0 4px 0 0',
}

const resourceFileNodeBodyStyle = {
  ...resourceNodeBodyStyle,
}

const resourceNodeKindIconStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  color: 'var(--text-muted)',
  flexShrink: 0,
}

const resourceNameInputStyle = {
  minWidth: 0,
  width: '100%',
  height: 26,
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  padding: '0 6px',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 650,
  outline: 'none',
}

const resourceStickyHeaderStyle = {
  position: 'sticky',
  top: 0,
  zIndex: 5,
  background: 'var(--bg-primary)',
  borderBottom: '1px solid var(--border)',
}

const resourceFileScrollSentinelStyle = {
  height: 0,
  width: '100%',
  pointerEvents: 'none',
}

const resourceEmptyFolderStyle = {
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 26,
  color: 'var(--text-muted)',
  fontSize: 12,
  borderBottom: '1px solid var(--border)',
}

const resourceNodeNameStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 650,
  lineHeight: 1.2,
}

const resourceNodeMetaStyle = {
  flex: '0 0 auto',
  color: 'var(--text-muted)',
  fontSize: 11,
  whiteSpace: 'nowrap',
  lineHeight: 1,
}

const paramRowStyle = {
  minWidth: 0,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 110px auto',
  gap: 8,
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-primary)',
  padding: 10,
}

const checkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  color: 'var(--text-secondary)',
  fontSize: 12,
}

const scenarioSiteSelectShellStyle = {
  width: '100%',
  display: 'grid',
  gap: 6,
  color: 'var(--text-secondary)',
  fontSize: 11,
  flexShrink: 0,
}

const scenarioSiteSelectLabelStyle = {
  fontWeight: 700,
}

const scenarioSiteSelectTriggerStyle = {
  width: '100%',
  height: 30,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: SEARCH_FIELD_BACKGROUND,
  color: 'var(--text-primary)',
  padding: '0 9px',
  fontFamily: 'inherit',
  fontSize: 12,
  outline: 'none',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  cursor: 'pointer',
}

const scenarioSiteSelectValueStyle = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
}

const scenarioSiteSelectCaretStyle = {
  flexShrink: 0,
  color: 'var(--text-muted)',
  fontSize: 10,
}

const scenarioSearchShellStyle = {
  width: '100%',
  height: 30,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: SEARCH_FIELD_BACKGROUND,
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
  flexShrink: 0,
}

const scenarioSearchInputStyle = {
  ...filterInputStyle,
  width: '100%',
  height: '100%',
  fontSize: 12,
}

const rightPanelHeaderStyle = {
  display: 'grid',
  gap: 4,
  flexShrink: 0,
}

const rightPanelHeaderTopRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 6,
  minWidth: 0,
}

const toolkitSearchShellStyle = {
  flex: '1 1 96px',
  width: 96,
  minWidth: 0,
  height: 22,
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: SEARCH_FIELD_BACKGROUND,
  display: 'flex',
  alignItems: 'center',
  overflow: 'hidden',
}

const toolkitSearchInputStyle = {
  ...filterInputStyle,
  width: '100%',
  height: '100%',
  fontSize: 12,
  lineHeight: 1.2,
  padding: '0 6px',
}

const rightPanelMetaStyle = {
  color: 'var(--text-muted)',
  fontSize: 11,
}

const primaryButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  alignSelf: 'stretch',
  width: '100%',
  minWidth: 0,
  maxWidth: 'none',
  flexShrink: 0,
  height: 36,
  border: 'none',
  borderRadius: 8,
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 760,
  boxSizing: 'border-box',
}

const smallButtonStyle = {
  minHeight: 28,
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-primary)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  padding: '0 9px',
}

const disabledButtonStyle = {
  opacity: 0.55,
  cursor: 'default',
}

const dangerButtonStyle = {
  ...smallButtonStyle,
  color: 'var(--danger, #ef4444)',
}

const builtinHelpShellStyle = {
  position: 'relative',
  display: 'inline-flex',
}

const openFolderButtonStyle = {
  ...smallButtonStyle,
  minHeight: 28,
  color: 'var(--text-secondary)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
}

const builtinHelpButtonStyle = {
  ...smallButtonStyle,
  minHeight: 28,
  color: 'var(--text-secondary)',
}

const builtinHelpPanelStyle = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 30,
  width: 'min(420px, calc(100vw - 48px))',
  maxHeight: 'min(70vh, 520px)',
  overflowY: 'auto',
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--bg-primary)',
  boxShadow: 'none',
  padding: '12px 14px',
  boxSizing: 'border-box',
}

const builtinHelpPanelTitleStyle = {
  fontSize: 13,
  fontWeight: 760,
  color: 'var(--text-primary)',
  marginBottom: 10,
}

const builtinHelpPanelBodyStyle = {
  display: 'grid',
  gap: 14,
}

const builtinHelpSectionStyle = {
  display: 'grid',
  gap: 8,
}

const builtinHelpSectionTitleStyle = {
  fontSize: 12,
  fontWeight: 760,
  color: 'var(--accent)',
}

const builtinHelpSummaryStyle = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
}

const builtinHelpItemsStyle = {
  display: 'grid',
  gap: 8,
}

const builtinHelpItemStyle = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg-secondary)',
  padding: '8px 10px',
}

const builtinHelpItemHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 4,
}

const builtinHelpCodeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  color: 'var(--text-primary)',
}

const builtinHelpItemDescStyle = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
}

const builtinHelpPreviewStyle = {
  marginTop: 4,
  fontSize: 11,
  lineHeight: 1.45,
  color: 'var(--text-muted)',
  overflowWrap: 'anywhere',
}

const emptyEditorStyle = {
  color: 'var(--text-muted)',
  fontSize: 13,
  padding: 12,
}
