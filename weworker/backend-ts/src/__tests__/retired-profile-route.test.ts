import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { looksLikeAuthFailure, looksLikeMissingArg } from '../api-query-router/legacy-error-hints.js'

const base = path.dirname(fileURLToPath(import.meta.url))
const read = (relative: string) => fs.readFileSync(path.resolve(base, relative), 'utf8')

describe('retired profile route integration', () => {
  it('does not preempt the desktop shared router or ship injected legacy routes', () => {
    const server = read('../server.ts')
    const bundler = read('../../../scripts/bundle-backend-ts.cjs')
    expect(server).not.toContain('tryBackendProfileQueryRoute')
    expect(bundler).not.toContain('WEWORKER_QUERY_ROUTES_CONFIG')
    expect(bundler).not.toContain("path.join(outDir, 'query-routes.json')")
    expect(server).toContain('tryRoutedTurn({')
  })

  it('keeps the shared router error hints independent of retired profile imports', () => {
    const engine = read('../api-query-router/index.ts')
    expect(engine).not.toContain("query-router/configurable-query-route.js")
    expect(looksLikeAuthFailure('{"retCode":3001}')).toBe(true)
    expect(looksLikeMissingArg('missing required argument')).toBe(true)
  })
})
