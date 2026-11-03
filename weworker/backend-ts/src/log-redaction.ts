import { redactSensitive } from './http-security.js'

const SECRET_KEY = /^(?:x-api-key|api[_-]?key|authorization|cookie|set-cookie|(?:access|refresh|bot)[_-]?token|token|secret|clientSecret|password|passwd)$/i

/** Redaction replaces credential values, never shortens diagnostic payloads. */
export function redactLogText(text: string): string {
  const cleaned = text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/(\b(?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/(--(?:api[_-]?key|token|secret|password|passwd)\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1"[REDACTED]"')
    .replace(/(\\+["'](?:x-api-key|api[_-]?key|authorization|cookie|set-cookie|(?:access|refresh|bot)[_-]?token|token|secret|clientSecret|password|passwd)\\+["']\s*:\s*)(\\+["'])([\s\S]*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:["']?)(?:x-api-key|api[_-]?key|authorization|cookie|set-cookie|(?:access|refresh|bot)[_-]?token|token|secret|clientSecret|password|passwd)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi, '$1"[REDACTED]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, '[USER_HOME]')
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '[USER_HOME]')
  return redactSensitive(cleaned)
}

export function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    // Tool results can contain JSON nested in stdout/output strings.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value)
        if (parsed && typeof parsed === 'object') {
          const safe = JSON.stringify(redactLogValue(parsed))
          return safe === JSON.stringify(parsed) ? value : safe
        }
      } catch { /* Ordinary text retains its original whitespace. */ }
    }
    return redactLogText(value)
  }
  if (Array.isArray(value)) return value.map(redactLogValue)
  if (value && typeof value === 'object') {
    const block = value as Record<string, unknown>
    return Object.fromEntries(Object.entries(block).map(([key, item]) => {
      if (SECRET_KEY.test(key)) return [key, '[REDACTED]']
      if ((block.type === 'tool_call_image' && key === 'data')
        || (block.type === 'tool_use' && key === 'image')
        || (block.type === 'image_url' && key === 'image_url')) return [key, '[image omitted]']
      if ((block.type === 'file_attachment' && key === 'path')
        || (block.type === 'skill_context' && key === 'directory')) return [key, '[path omitted]']
      return [key, redactLogValue(item)]
    }))
  }
  return value
}
