import { showAlert } from '../store/dialog.js'

export async function handleChatLinkClick(event) {
  if (event.button != null && event.button !== 0 && event.button !== 1) return
  const href = event.currentTarget.getAttribute('href')
  if (href?.startsWith('#')) return

  let url
  try {
    url = new URL(href)
  } catch {
    event.preventDefault()
    return
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
    event.preventDefault()
    return
  }

  if (typeof window.electronAPI?.openExternal !== 'function') return
  // Cancel navigation synchronously, before waiting for the main process.
  event.preventDefault()
  try {
    await window.electronAPI.openExternal(href)
  } catch {
    void showAlert('无法打开默认浏览器，请稍后重试。')
  }
}
