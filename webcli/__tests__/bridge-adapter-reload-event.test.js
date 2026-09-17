import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('bridge generated-adapter hot reload event', () => {
  it('broadcasts scaffold completion to long-lived clients', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'bridge.js'), 'utf8')
    const scaffoldWrite = source.indexOf('const result = writeScaffoldFromSiteMemory(readOnlyQuickMemory)')
    const reloadEvent = source.indexOf("type: 'adapter_scaffold_generated'", scaffoldWrite)
    const resultReply = source.indexOf("type: 'generate_adapter_scaffold_result'", reloadEvent)

    expect(scaffoldWrite).toBeGreaterThanOrEqual(0)
    expect(reloadEvent).toBeGreaterThan(scaffoldWrite)
    expect(resultReply).toBeGreaterThan(reloadEvent)
  })
})
