export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

export const WEEKDAY_FILTER_OPTIONS = [
  { value: 0, label: '日' },
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
]

export const FREQUENCY_OPTIONS = [
  { value: 'every_n_minutes', label: '每隔 N 分钟' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
]

export const WEEKDAY_OPTIONS = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '0', label: '周日' },
]

export const MINUTE_INTERVAL_OPTIONS = [5, 10, 15, 20, 30]

function normalizeWeekdays(weekdays) {
  if (!Array.isArray(weekdays)) return ALL_WEEKDAYS
  return [...new Set(weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    .sort((a, b) => a - b)
}

function parseWeekdayField(field) {
  if (field === '*') return ALL_WEEKDAYS
  const days = new Set()
  for (const part of String(field || '').split(',')) {
    const range = part.match(/^(\d)-(\d)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > 7 || end > 7) return null
      for (let value = start; value <= end; value += 1) days.add(value % 7)
      continue
    }
    if (!/^\d$/.test(part) || Number(part) > 7) return null
    days.add(Number(part) % 7)
  }
  return [...days].sort((a, b) => a - b)
}

function weekdayField(weekdays) {
  const days = normalizeWeekdays(weekdays)
  if (days.length === 0) return ''
  return days.length === ALL_WEEKDAYS.length ? '*' : days.join(',')
}

export function buildCron({ frequency, hour, minute, weekday, weekdays, minuteInterval }) {
  const days = weekdayField(weekdays)
  if (!days) return ''

  switch (frequency) {
    case 'every_n_minutes':
      return `*/${minuteInterval || 30} * * * ${days}`
    case 'hourly':
      return `${minute || 0} * * * ${days}`
    case 'daily':
      return `${minute ?? 0} ${hour ?? 9} * * ${days}`
    case 'weekly':
      return normalizeWeekdays(weekdays).includes(Number(weekday))
        ? `${minute ?? 0} ${hour ?? 9} * * ${weekday ?? 1}`
        : ''
    default:
      return '0 * * * *'
  }
}

export function parseCron(expression) {
  const fallback = { frequency: 'daily', hour: 9, minute: 0, weekday: '1', weekdays: ALL_WEEKDAYS, minuteInterval: 30 }
  if (!expression) return fallback
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return fallback

  const [min, hr, day, month, dow] = parts
  const parsedDays = parseWeekdayField(dow)
  if (parsedDays === null || day !== '*' || month !== '*') return fallback
  const weekdays = dow === '*' ? ALL_WEEKDAYS : parsedDays

  const everyN = min.match(/^\*\/(\d+)$/)
  if (everyN && hr === '*') {
    return { ...fallback, frequency: 'every_n_minutes', minuteInterval: parseInt(everyN[1], 10), weekdays }
  }

  if (/^\d+$/.test(min) && hr === '*') {
    return { ...fallback, frequency: 'hourly', minute: parseInt(min, 10), weekdays }
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d$/.test(dow)) {
    return { ...fallback, frequency: 'weekly', hour: parseInt(hr, 10), minute: parseInt(min, 10), weekday: String(Number(dow) % 7) }
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
    return { ...fallback, frequency: 'daily', hour: parseInt(hr, 10), minute: parseInt(min, 10), weekdays }
  }

  return fallback
}

export function getNextRuns({ frequency, hour, minute, weekday, weekdays, minuteInterval }, count = 3, now = new Date()) {
  const allowedDays = new Set(normalizeWeekdays(weekdays))
  if (allowedDays.size === 0) return []
  const runs = []

  if (frequency === 'every_n_minutes') {
    const interval = (minuteInterval || 30) * 60 * 1000
    const msIntoHour = now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds()
    let candidate = new Date(now.getTime() - msIntoHour + Math.ceil(msIntoHour / interval) * interval)
    let attempts = 0
    while (runs.length < count && attempts < 100000) {
      if (allowedDays.has(candidate.getDay())) runs.push(new Date(candidate))
      candidate = new Date(candidate.getTime() + interval)
      attempts += 1
    }
  } else if (frequency === 'hourly') {
    const candidate = new Date(now)
    candidate.setMinutes(minute || 0, 0, 0)
    if (candidate <= now) candidate.setHours(candidate.getHours() + 1)
    while (runs.length < count) {
      if (allowedDays.has(candidate.getDay())) runs.push(new Date(candidate))
      candidate.setHours(candidate.getHours() + 1)
    }
  } else if (frequency === 'daily') {
    const candidate = new Date(now)
    candidate.setHours(hour ?? 9, minute || 0, 0, 0)
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1)
    while (runs.length < count) {
      if (allowedDays.has(candidate.getDay())) runs.push(new Date(candidate))
      candidate.setDate(candidate.getDate() + 1)
    }
  } else if (frequency === 'weekly') {
    const day = Number(weekday ?? 1)
    if (!allowedDays.has(day)) return []
    const candidate = new Date(now)
    candidate.setHours(hour ?? 9, minute ?? 0, 0, 0)
    let diff = (day - candidate.getDay() + 7) % 7
    if (diff === 0 && candidate <= now) diff = 7
    candidate.setDate(candidate.getDate() + diff)
    for (let index = 0; index < count; index += 1) {
      runs.push(new Date(candidate))
      candidate.setDate(candidate.getDate() + 7)
    }
  }

  return runs
}

export function nextRunsSummary(schedule) {
  const runs = getNextRuns(schedule, 3)
  if (runs.length === 0) return '过滤日期与执行频率不匹配，请调整设置'
  const format = (date) => date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `接下来执行: ${runs.map(format).join('、')}`
}
