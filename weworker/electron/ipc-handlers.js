import { BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage } from 'electron'
import { app } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { pipeline } from 'stream/promises'
import { saveAdapterStream } from './website-adapter-export.js'

const websiteDownloads = new Map()

// Chrome executable paths by platform
function getChromeExecutable() {
  if (process.platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    return paths.find(p => fs.existsSync(p)) || null
  }
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
    return paths.find(p => fs.existsSync(p)) || null
  }
  return null
}

function sanitizeSkillPathSegment(value) {
  return (value || 'custom')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/, '_')
    .trim() || 'custom'
}

function resolvePublicSkillDirectory(skillName) {
  return path.join(os.homedir(), '.weworker', 'claude-config', 'skills', sanitizeSkillPathSegment(skillName || ''))
}

function resolveCustomSkillDirectory(_siteId, skillId, skillName) {
  return path.join(os.homedir(), '.weworker', 'claude-config', 'skills', `webcli-${sanitizeSkillPathSegment(skillName || skillId)}`)
}

const RESOURCE_PREVIEW_MAX_BYTES = 256 * 1024
const SKILL_MARKDOWN_FILES = new Set(['SKILL.md', 'SKILL.md.disabled'])
const CUSTOM_SKILL_MARKER_FILENAME = '.weworker-custom-skill.json'

function normalizeResourceRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (normalized.some((part) => part === '.' || part === '..')) return ''
  return normalized.join('/')
}

function resolveResourceFilePath(root, relativePath) {
  const normalized = normalizeResourceRelativePath(relativePath)
  if (!normalized) throw new Error('invalid resource path')
  if (SKILL_MARKDOWN_FILES.has(normalized)) throw new Error('cannot preview skill markdown here')
  const absolute = path.join(root, ...normalized.split('/'))
  const resolvedRoot = path.resolve(root)
  const resolvedFile = path.resolve(absolute)
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('invalid resource path')
  }
  return absolute
}

function readTextPreview(filePath, maxBytes = RESOURCE_PREVIEW_MAX_BYTES) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error('resource file not found')
  const size = stat.size
  const previewBytes = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(previewBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.readSync(fd, buffer, 0, previewBytes, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (buffer.includes(0)) {
    return { content: '', truncated: false, size, previewBytes, isBinary: true }
  }
  const truncated = size > previewBytes
  const prefix = truncated
    ? `（已截断：以下仅显示前 ${previewBytes} 字节，文件共 ${size} 字节）\n\n`
    : ''
  return {
    content: `${prefix}${buffer.toString('utf-8')}`,
    truncated,
    size,
    previewBytes,
    isBinary: false,
  }
}

const PREVIEW_EXTENSIONS = new Set([
  '.adoc', '.bash', '.bat', '.c', '.cc', '.cfg', '.cmake', '.clj', '.cljs', '.cmd',
  '.conf', '.cpp', '.cs', '.css', '.csv', '.cxx', '.dart', '.env', '.erl', '.ex',
  '.exs', '.fish', '.fs', '.fsx', '.go', '.gradle', '.graphql', '.gql', '.h', '.hpp',
  '.hs', '.htm', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.kts',
  '.less', '.log', '.lua', '.m', '.make', '.md', '.mdx', '.mjs', '.mk', '.mm',
  '.ndjson', '.php', '.pl', '.pm', '.properties', '.proto', '.ps1', '.py', '.r',
  '.rb', '.rs', '.rst', '.sass', '.scala', '.scss', '.sh', '.sql', '.svg', '.svelte',
  '.swift', '.tex', '.toml', '.ts', '.tsv', '.tsx', '.txt', '.vb', '.vue', '.xml',
  '.yaml', '.yml', '.zsh',
])

function safeItemName(name) {
  const safeName = path.basename(name || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
  if (!safeName || safeName === '.' || safeName === '..') return ''
  return safeName
}

function uniqueDestinationPath(parent, name) {
  const parsed = path.parse(name)
  let candidate = path.join(parent, name)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${parsed.name} (${index})${parsed.ext}`)
    index += 1
  }
  return candidate
}

function importFilesIntoDirectory(importRoot, sourcePaths) {
  fs.mkdirSync(importRoot, { recursive: true })
  for (const rawPath of sourcePaths) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    const resolved = path.resolve(rawPath)
    const stat = fs.statSync(resolved)
    const destName = safeItemName(path.basename(resolved))
    if (!destName) continue
    const dest = uniqueDestinationPath(importRoot, destName)
    if (stat.isDirectory()) {
      fs.cpSync(resolved, dest, { recursive: true, errorOnExist: true })
    } else if (stat.isFile()) {
      fs.copyFileSync(resolved, dest)
    }
  }
}

function collectImportSource(source) {
  const resolved = path.resolve(source)
  const stat = fs.statSync(resolved)
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a file or folder: ' + source)
  const info = stat.isDirectory() ? collectDirectoryStats(resolved) : { size: stat.size, files: 1 }
  return {
    path: source,
    resolved,
    size: info.size,
    files: info.files,
  }
}

function collectDirectoryStats(dir) {
  let size = 0
  let files = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const childInfo = collectDirectoryStats(child)
      size += childInfo.size
      files += childInfo.files
    } else if (entry.isFile()) {
      size += fs.statSync(child).size
      files += 1
    }
  }
  return { size, files: Math.max(files, 1) }
}

function cloneSkillImportJob(job) {
  return { ...job }
}

const skillImportJobs = new Map()

function emitSkillImportProgress(event, job) {
  event.sender.send('skill-resource-import-progress', cloneSkillImportJob(job))
}

async function copyFileWithProgress(source, dest, job, event) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  job.current_file = path.basename(source)
  emitSkillImportProgress(event, job)
  const read = fs.createReadStream(source)
  read.on('data', (chunk) => {
    job.copied_bytes = Math.min(job.total_bytes, job.copied_bytes + chunk.length)
    emitSkillImportProgress(event, job)
  })
  await pipeline(read, fs.createWriteStream(dest))
  job.copied_files = Math.min(job.total_files, job.copied_files + 1)
  emitSkillImportProgress(event, job)
}

async function copyDirectoryWithProgress(sourceDir, destDir, job, event) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryWithProgress(source, dest, job, event)
    } else if (entry.isFile()) {
      await copyFileWithProgress(source, dest, job, event)
    }
  }
}

async function runSkillImportJob(event, job, sources, targetDir) {
  try {
    job.status = 'running'
    emitSkillImportProgress(event, job)
    for (const source of sources) {
      const stat = fs.statSync(source.resolved)
      const destName = safeItemName(path.basename(source.resolved))
      if (!destName) continue
      const dest = uniqueDestinationPath(targetDir, destName)
      if (stat.isDirectory()) {
        await copyDirectoryWithProgress(source.resolved, dest, job, event)
      } else {
        await copyFileWithProgress(source.resolved, dest, job, event)
      }
    }
    job.status = 'done'
    job.current_file = null
    job.copied_bytes = job.total_bytes
    job.copied_files = job.total_files
    emitSkillImportProgress(event, job)
  } catch (error) {
    job.status = 'error'
    job.current_file = null
    job.error = error instanceof Error ? error.message : 'failed to import skill resources'
    emitSkillImportProgress(event, job)
  } finally {
    const timer = setTimeout(() => skillImportJobs.delete(job.id), 10 * 60 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

function isReadableResourceFile(filePath, size) {
  if (size > RESOURCE_PREVIEW_MAX_BYTES) return false
  return PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function listSkillDirectoryResources(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const stat = fs.statSync(absolute)
      if (entry.isDirectory()) {
        out.push({
          name: entry.name,
          relativePath: path.relative(root, absolute).replace(/\\/g, '/'),
          size: 0,
          modified_at: stat.mtime.toISOString(),
          is_directory: true,
        })
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const item = {
        name: entry.name,
        relativePath: path.relative(root, absolute).replace(/\\/g, '/'),
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
        is_directory: false,
      }
      if (isReadableResourceFile(absolute, stat.size)) {
        item.readable = true
        item.content = fs.readFileSync(absolute, 'utf-8')
      }
      out.push(item)
    }
  }
  walk(root)
  return out
    .filter((resource) => {
      const normalized = normalizeResourceRelativePath(resource.relativePath)
      return normalized && !SKILL_MARKDOWN_FILES.has(normalized) && normalized !== CUSTOM_SKILL_MARKER_FILENAME
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function readClipboardFilePaths() {
  if (process.platform === 'win32') {
    const buffer = clipboard.readBuffer('FileNameW')
    if (!buffer?.length) return []
    return buffer.toString('utf16le')
      .split('\0')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  if (process.platform === 'darwin') {
    const raw = clipboard.read('NSFilenamesPboardType') || clipboard.read('public.file-url') || clipboard.read('text/uri-list')
    if (!raw) return []
    return raw.split('\n').map(parseClipboardUriEntry).filter(Boolean)
  }
  const raw = clipboard.read('text/uri-list') || clipboard.read('text/plain')
  if (!raw) return []
  return raw.split('\n').map(parseClipboardUriEntry).filter(Boolean)
}

function saveClipboardImage() {
  const image = clipboard.readImage()
  if (!image || image.isEmpty()) return null
  const buffer = image.toPNG()
  if (!buffer?.length) return null

  const dir = path.join(os.tmpdir(), 'weworker-clipboard-images')
  fs.mkdirSync(dir, { recursive: true })
  const name = `clipboard-image-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, buffer)
  return { path: filePath, name }
}

function savePastedText(text) {
  const content = String(text || '').trim()
  if (!content) return null

  const dir = path.join(os.tmpdir(), 'weworker-pasted-text')
  fs.mkdirSync(dir, { recursive: true })
  const name = `pasted-text-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, 'utf8')
  return { path: filePath, name }
}

const LOCAL_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

function readLocalImageThumbnail(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null
  const resolved = path.resolve(targetPath)
  const ext = path.extname(resolved).toLowerCase()
  const mime = LOCAL_IMAGE_MIME[ext]
  if (!mime) return null
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) return null

  const image = nativeImage.createFromPath(resolved)
  if (!image.isEmpty()) {
    const resized = image.resize({ width: 96, height: 96, quality: 'good' })
    return resized.toDataURL()
  }

  const buffer = fs.readFileSync(resolved)
  if (!buffer.length) return null
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function parseClipboardUriEntry(entry) {
  const trimmed = String(entry || '').trim()
  if (!trimmed || trimmed.startsWith('#')) return ''
  if (trimmed.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    } catch {
      return ''
    }
  }
  return trimmed
}

/**
 * `browserControls.openBrowser` handles "open Chrome" when WeWorker manages its
 * own browser; it returns false to fall back to the user's Chrome.
 */
export function registerIpcHandlers(bridgeManager, pythonManager, webwrightManager, httpAuthToken, updateManager, browserControls = {}) {
  ipcMain.handle('get-status', () => ({
    bridge: bridgeManager.getStatus(),
    python: pythonManager.getStatus(),
    webwright: webwrightManager.getStatus(),
  }))

  ipcMain.handle('get-version', () => app.getVersion())

  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return true
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle('window:is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() === true)

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return true
  })

  ipcMain.handle('updates:get-state', () => updateManager?.getState?.() || null)

  ipcMain.handle('updates:get-settings', () => updateManager?.getSettings?.() || null)

  ipcMain.handle('updates:set-settings', (_event, settings) => updateManager?.setSettings?.(settings) || null)

  ipcMain.handle('updates:check', () => updateManager?.checkForUpdates?.() || null)

  ipcMain.handle('updates:download', () => updateManager?.downloadUpdate?.() || null)

  ipcMain.handle('updates:install', () => updateManager?.installUpdate?.() || null)

  ipcMain.handle('get-http-auth-token', () => httpAuthToken || '')

  ipcMain.handle('focus-main-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    if (win.isMinimized()) win.restore()
    win.focus()
    event.sender.focus()
    return true
  })

  ipcMain.handle('open-external', (_event, url) => {
    return shell.openExternal(url)
  })

  ipcMain.handle('open-webwright', (event) => {
    event.sender.send('website-exploration:open')
    return true
  })

  ipcMain.handle('download-website-adapter', async (event, toolkitId) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof toolkitId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(toolkitId)) throw new Error('无效的 Adapter')
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '导出 Adapter', defaultPath: toolkitId + '.zip', filters: [{ name: 'Adapter ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return { cancelled: true }
    if (websiteDownloads.has(event.sender)) throw new Error('已有导出正在运行')
    const controller = new AbortController()
    websiteDownloads.set(event.sender, controller)
    const close = () => controller.abort()
    event.sender.once('destroyed', close)
    try {
      const response = await fetch('http://127.0.0.1:8765/api/website-exploration/toolkits/' + toolkitId + '/export', {
        headers: { 'X-WeWorker-Auth': httpAuthToken }, redirect: 'error', signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error('导出失败，请刷新正式验证状态后重试')
      await saveAdapterStream(response.body, result.filePath, controller.signal)
      return { saved: true }
    } catch (error) {
      if (controller.signal.aborted) return { cancelled: true }
      throw new Error('导出未完成，已有文件保持不变，请重试')
    } finally {
      websiteDownloads.delete(event.sender)
      event.sender.off('destroyed', close)
    }
  })
  ipcMain.handle('cancel-website-adapter-download', (event) => {
    if (event.senderFrame === event.sender.mainFrame) websiteDownloads.get(event.sender)?.abort()
  })

  ipcMain.handle('select-files', async (_event, options = {}) => {
    const filters = Array.isArray(options?.filters) ? options.filters : undefined
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      ...(filters ? { filters } : null),
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('select-directory', async (_event, options = {}) => {
    const defaultPath = typeof options?.defaultPath === 'string' && options.defaultPath.trim()
      ? path.resolve(options.defaultPath)
      : undefined
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : null),
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('read-clipboard-file-paths', () => readClipboardFilePaths())

  ipcMain.handle('save-clipboard-image', () => saveClipboardImage())

  ipcMain.handle('save-pasted-text', (_event, text) => savePastedText(text))

  ipcMain.handle('read-local-image-thumbnail', (_event, targetPath) => {
    try {
      return readLocalImageThumbnail(targetPath)
    } catch {
      return null
    }
  })

  ipcMain.handle('open-path', async (_event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return 'invalid path'
    return shell.openPath(targetPath)
  })

  ipcMain.handle('resolve-skill-directory', async (_event, payload = {}) => {
    const { source, skillId, siteId, skillName } = payload
    if (source === 'public-custom') {
      return resolvePublicSkillDirectory(skillId)
    }
    if (source === 'custom') {
      return resolveCustomSkillDirectory(siteId, skillId, skillName)
    }
    return ''
  })

  ipcMain.handle('read-skill-resource-preview', async (_event, payload = {}) => {
    const { source, skillId, siteId, relativePath } = payload
    let root = ''
    if (source === 'public-custom') root = resolvePublicSkillDirectory(skillId)
    else if (source === 'custom') root = resolveCustomSkillDirectory(siteId, skillId)
    else throw new Error('unsupported skill source')
    const absolute = resolveResourceFilePath(root, relativePath)
    if (!fs.existsSync(absolute)) throw new Error('resource file not found')
    const preview = readTextPreview(absolute)
    return { ok: true, ...preview }
  })

  ipcMain.handle('import-skill-resources', async (_event, payload = {}) => {
    const { source, skillId, siteId, skillName, paths, parentRelativePath, jobId } = payload
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths is required')
    let root = ''
    if (source === 'public-custom') root = resolvePublicSkillDirectory(skillId)
    else if (source === 'custom') root = resolveCustomSkillDirectory(siteId, skillId, skillName)
    else throw new Error('unsupported skill source')
    fs.mkdirSync(root, { recursive: true })
    const parentDir = normalizeResourceRelativePath(parentRelativePath)
    const importRoot = parentDir ? path.join(root, ...parentDir.split('/')) : root
    const job = {
      id: jobId || randomUUID(),
      status: 'pending',
      total_bytes: 0,
      copied_bytes: 0,
      total_files: 0,
      copied_files: 0,
      current_file: null,
      error: null,
    }
    const sources = paths.map((sourcePath) => collectImportSource(sourcePath))
    job.total_bytes = sources.reduce((sum, item) => sum + item.size, 0)
    job.total_files = sources.reduce((sum, item) => sum + item.files, 0)
    skillImportJobs.set(job.id, job)
    emitSkillImportProgress(_event, job)
    try {
      await runSkillImportJob(_event, job, sources, importRoot)
      if (job.status === 'error') throw new Error(job.error || 'failed to import skill resources')
      return { ok: true, jobId: job.id, resources: listSkillDirectoryResources(root) }
    } finally {
      skillImportJobs.delete(job.id)
    }
  })

  ipcMain.handle('reveal-in-file-manager', async (_event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string' || !fs.existsSync(targetPath)) return 'invalid path'
    shell.showItemInFolder(targetPath)
    return ''
  })

  ipcMain.handle('open-terminal', async (_event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string' || !fs.existsSync(targetPath)) return 'invalid path'
    const stat = fs.statSync(targetPath)
    const cwd = stat.isDirectory() ? targetPath : path.dirname(targetPath)
    if (process.platform === 'win32') {
      const wtCandidates = [
        process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\wt.exe' : '',
        'C:\\Users\\' + (process.env.USERNAME || '') + '\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
      ].filter(Boolean)
      const wt = wtCandidates.find(p => fs.existsSync(p))
      if (wt) {
        spawn(wt, ['-d', cwd], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
        return ''
      }
      const psPath = cwd.replace(/'/g, "''")
      spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', "Set-Location -LiteralPath '" + psPath + "'"], { cwd, detached: true, stdio: 'ignore', windowsHide: false }).unref()
      return ''
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' }).unref()
      return ''
    }
    spawn('x-terminal-emulator', [], { cwd, detached: true, stdio: 'ignore' }).unref()
    return ''
  })

  // Open Chrome browser (without navigating to a specific URL)
  ipcMain.handle('open-chrome', async () => {
    if (await browserControls.openBrowser?.()) return
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Google Chrome'], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      const chrome = getChromeExecutable()
      if (chrome) {
        spawn(chrome, [], { detached: true, stdio: 'ignore' }).unref()
      }
    }
  })

  // Open a chrome:// URL directly using the Chrome executable
  ipcMain.handle('open-chrome-url', (_event, url) => {
    if (process.platform === 'darwin') {
      // Use AppleScript to tell Chrome to open the URL in a new tab
      const script = `tell application "Google Chrome"
  activate
  if (count of windows) = 0 then
    make new window
  end if
  tell front window
    make new tab with properties {URL:"${url}"}
  end tell
end tell`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'win32') {
      const chrome = getChromeExecutable()
      if (chrome) {
        // Don't use --new-window: it can fail with chrome:// URLs when Chrome is already running.
        // Just pass the URL directly — Chrome will open it in a new tab in the existing window.
        spawn(chrome, [url], { detached: true, stdio: 'ignore' }).unref()
      } else {
        shell.openExternal('https://www.google.com/chrome/')
      }
    }
  })
}
