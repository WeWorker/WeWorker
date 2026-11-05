const { contextBridge, ipcRenderer, webUtils } = require('electron')

let lastDroppedFilePaths = []

window.addEventListener('drop', (event) => {
  try {
    lastDroppedFilePaths = Array.from(event.dataTransfer?.files || [])
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean)
  } catch {
    lastDroppedFilePaths = []
  }
}, true)

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  getStatus: () => ipcRenderer.invoke('get-status'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onWindowMaximizedState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, maximized) => callback(maximized === true)
    ipcRenderer.on('window:maximized-state', handler)
    return () => ipcRenderer.removeListener('window:maximized-state', handler)
  },
  getUpdateState: () => ipcRenderer.invoke('updates:get-state'),
  getUpdateSettings: () => ipcRenderer.invoke('updates:get-settings'),
  setUpdateSettings: (settings) => ipcRenderer.invoke('updates:set-settings', settings),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateState: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('updates:state', handler)
    return () => ipcRenderer.removeListener('updates:state', handler)
  },
  getHttpAuthToken: () => ipcRenderer.invoke('get-http-auth-token'),
  getAppSettings: () => ipcRenderer.invoke('app-settings:get'),
  setAppSettings: (patch) => ipcRenderer.invoke('app-settings:set', patch),
  onOpenDedicatedAgents: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = () => callback()
    ipcRenderer.on('app:open-dedicated-agents', handler)
    return () => ipcRenderer.removeListener('app:open-dedicated-agents', handler)
  },
  focusWindow: () => ipcRenderer.invoke('focus-main-window'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openWebwright: () => ipcRenderer.invoke('open-webwright'),
  downloadWebsiteAdapter: (toolkitId) => ipcRenderer.invoke('download-website-adapter', toolkitId),
  cancelWebsiteAdapterDownload: () => ipcRenderer.invoke('cancel-website-adapter-download'),
  onWebsiteExplorationOpen: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('website-exploration:open', handler)
    return () => ipcRenderer.removeListener('website-exploration:open', handler)
  },
  setExplorationDirty: (value) => ipcRenderer.send('website-exploration:dirty', value === true),
  onExplorationLeave: (callback) => {
    const handler = async (_event, id) => {
      let allowed = false
      try { allowed = await callback() } catch {}
      ipcRenderer.send('website-exploration:leave-result', id, allowed === true)
    }
    ipcRenderer.on('website-exploration:leave', handler)
    return () => ipcRenderer.removeListener('website-exploration:leave', handler)
  },
  openChromeUrl: (url) => ipcRenderer.invoke('open-chrome-url', url),
  openChrome: () => ipcRenderer.invoke('open-chrome'),
  getDedicatedBrowserStatus: () => ipcRenderer.invoke('dedicated-browser:get-status'),
  showDedicatedBrowser: () => ipcRenderer.invoke('dedicated-browser:show'),
  hideDedicatedBrowser: (options) => ipcRenderer.invoke('dedicated-browser:hide', options?.soft === true ? { soft: true } : undefined),
  siteAuthControl: (action, payload) => ipcRenderer.invoke('site-auth:control', action, payload),
  onSiteAuthEvent: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, event) => callback(event)
    ipcRenderer.on('site-auth:event', handler)
    return () => ipcRenderer.removeListener('site-auth:event', handler)
  },
  restartDedicatedBrowser: () => ipcRenderer.invoke('dedicated-browser:restart'),
  selectFiles: (options) => ipcRenderer.invoke('select-files', options),
  selectDirectory: (options) => ipcRenderer.invoke('select-directory', options),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  resolveSkillDirectory: (payload) => ipcRenderer.invoke('resolve-skill-directory', payload),
  readSkillResourcePreview: (payload) => ipcRenderer.invoke('read-skill-resource-preview', payload),
  importSkillResources: (payload) => ipcRenderer.invoke('import-skill-resources', payload),
  onSkillResourceImportProgress: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const handler = (_event, progress) => callback(progress)
    ipcRenderer.on('skill-resource-import-progress', handler)
    return () => ipcRenderer.removeListener('skill-resource-import-progress', handler)
  },
  revealInFileManager: (targetPath) => ipcRenderer.invoke('reveal-in-file-manager', targetPath),
  openTerminal: (targetPath) => ipcRenderer.invoke('open-terminal', targetPath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getLastDroppedFilePaths: () => lastDroppedFilePaths.slice(),
  readClipboardFilePaths: () => ipcRenderer.invoke('read-clipboard-file-paths'),
  saveClipboardImage: () => ipcRenderer.invoke('save-clipboard-image'),
  savePastedText: (text) => ipcRenderer.invoke('save-pasted-text', text),
  saveFormattedBody: (body) => ipcRenderer.invoke('save-formatted-body', body),
  readLocalImageThumbnail: (targetPath) => ipcRenderer.invoke('read-local-image-thumbnail', targetPath),
})
