export function projectErrorMessage(detail, fallback) {
  if (typeof detail !== 'string' || !detail.trim()) return fallback
  if (/UNIQUE constraint failed:\s*projects\.name/i.test(detail)) {
    return '已存在同名工作区，请换一个名称。'
  }
  if (detail === 'project folder already exists') {
    return '工作区文件夹已存在，请换一个名称或选择其他文件夹。'
  }
  return detail
}
