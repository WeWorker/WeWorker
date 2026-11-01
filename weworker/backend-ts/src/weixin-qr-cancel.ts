export type WeixinQrSessionState = {
  sessionId: string
  completing?: boolean
}

export function cancelWeixinQrSession<T extends WeixinQrSessionState>(state: T | null, sessionId: unknown): T | null {
  if (!state || typeof sessionId !== 'string' || state.sessionId !== sessionId || state.completing) return state
  return null
}
