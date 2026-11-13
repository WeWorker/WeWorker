import crypto from 'node:crypto'

const configuredPort = Number(process.env.WEWORK_PORT || 8765)
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
  throw new Error('Invalid local backend port')
}
export const LOCAL_HTTP_PORT = configuredPort

export function isAllowedHost(hostHeader: string | undefined, port = LOCAL_HTTP_PORT): boolean {
  const host = String(hostHeader || '').toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

export function isAllowedOrigin(
  originHeader: string | undefined,
  rendererOrigin = process.env.WEWORKER_RENDERER_ORIGIN,
): boolean {
  if (!originHeader) return true
  if (originHeader === 'null' || originHeader === 'file://') return true
  const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    rendererOrigin,
  ].filter(Boolean))
  return allowedOrigins.has(originHeader)
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function isAuthorizedHttpRequest(providedToken: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return true
  if (!providedToken) return false
  return timingSafeEqualString(providedToken, expectedToken)
}

export function redactSensitive(text: string): string {
  return text
    .replace(/(x-api-key\s*[:=]\s*)([^\s,'"}]+)/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s,'"}]+)/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s,'"}]+)/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|bot_token|clientSecret)\s*[:=]\s*)([^\s,'"}]+)/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_API_KEY]')
}
