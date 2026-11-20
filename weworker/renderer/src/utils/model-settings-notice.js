import { showNotification, updateNotification } from '../store/notifications.js'

export async function withModelSettingsNotice(action, { pending, success, failure }) {
  const id = showNotification(pending, { type: 'loading', duration: 0 })
  try {
    const result = await action()
    updateNotification(id, success, { type: 'success' })
    return result
  } catch (error) {
    updateNotification(id, error.message || failure, { type: 'error', duration: 8000 })
    throw error
  }
}
