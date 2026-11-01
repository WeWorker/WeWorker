import { showConfirm } from '../store/dialog.js'

const FULL_PERMISSION_WARNING = '完全权限允许模型访问和修改工作区外的文件，并执行本机命令。操作可能影响电脑上的其他数据。只在信任当前任务时启用。'

export function confirmChatPermissionMode(mode, confirm = showConfirm) {
  if (mode !== 'full') return Promise.resolve(true)
  return confirm(FULL_PERMISSION_WARNING, '启用完全权限', { danger: true })
}
