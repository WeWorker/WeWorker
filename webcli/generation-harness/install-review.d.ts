import type { V2Package } from '../adapter-catalog.js'
export interface GeneratedInstallReview {
  profile: string
  name: string
  version: string
  digest: string
  stateRevision: number
  baselineDigest: string | null
  currentVersion: string | null
  currentSource: string | null
  targetSource: 'generated'
  permissions: string[]
  addedPermissions: string[]
  sourceChange: boolean
  downgrade: boolean
  reviewId: string
}
export function describeGeneratedInstall(draft: { adapterDir: string }, options: { pkg: V2Package }): GeneratedInstallReview
export function resolveGeneratedInstallApproval(review: GeneratedInstallReview, approval: { reviewId?: string; acceptChanges?: boolean }): {
  expectedStateRevision: number
  allowSourceChange: boolean
  allowDowngrade: boolean
  allowPermissionChange: boolean
}
