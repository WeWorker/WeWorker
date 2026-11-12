import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

function endpoint(events: object[]) {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function streamConversationCompaction(')
  const end = source.indexOf('\n//', start)
  const scope: Record<string, any> = {
    streamChat: async function* () { yield* events },
    chatLog: { error() {} },
  }
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText + '\nthis.compact = streamConversationCompaction', scope)
  return () => scope.compact('public-fixture', [], {}, () => {})
}

const completed = { type: 'context_compaction_end', compaction: { status: 'completed' } }
const skipped = { type: 'context_compaction_end', compaction: { status: 'skipped', reason: 'no_droppable_history' } }

it('does not report success when validation fails after an earlier completed summary', async () => {
  await expect(endpoint([completed, { type: 'error', content: 'Prompt is too long' }])()).rejects.toThrow('Prompt is too long')
})

it('accepts successful trimming after an intermediate failed summary', async () => {
  const result = await endpoint([{ type: 'context_compaction_end', compaction: { status: 'failed', error: 'No reduction' } }, completed])()
  expect(result).toEqual({ status: 'completed' })
})

it('reports only the final compaction status when later trimming cannot progress', async () => {
  expect(await endpoint([completed, skipped])()).toEqual({ status: 'skipped', reason: 'no_droppable_history' })
  await expect(endpoint([completed, { type: 'context_compaction_end', compaction: { status: 'failed', error: 'Public failure' } }])()).rejects.toThrow('Public failure')
})
