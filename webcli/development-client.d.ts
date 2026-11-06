import type { GeneratedInstallReview } from './generation-harness/install-review.js'

export interface DevelopmentClientOptions {
  fetch?: typeof globalThis.fetch
  env?: Record<string, string | undefined>
}
export type DevelopmentResult<T = Record<string, unknown>> = {
  schemaVersion: 1
  command: string
} & ({ ok: true; data: T } | { ok: false; error: { code: string; message: string }; data?: T })
export interface DevelopmentReview extends GeneratedInstallReview {
  review_id: string
  changedTools: string[]
  draftBaseDigest: string | null
  applied: boolean
  overwritesNewerBase: boolean
}
export interface DevelopmentApplyReceipt {
  name: string
  version: string
  digest: string
  revision: number
  refreshed: boolean
  acknowledged: boolean
  installed: true
  applied: boolean
}
export function callDevelopment(command: 'review', args: Record<string, unknown>, options?: DevelopmentClientOptions): Promise<DevelopmentResult<DevelopmentReview>>
export function callDevelopment(command: 'apply', args: Record<string, unknown>, options?: DevelopmentClientOptions): Promise<DevelopmentResult<DevelopmentApplyReceipt>>
export function callDevelopment(command: string, args: Record<string, unknown>, options?: DevelopmentClientOptions): Promise<DevelopmentResult>
