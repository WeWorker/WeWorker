import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { resolveDesktopChatPermission } from '../chat-permission-mode.js'

// Execute the actual HTTP handler branches with isolated dispatchers. Importing
// the server would start listeners and load the developer's application data.
const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)

function dispatchBranch(condition: string): string {
  let found: ts.IfStatement | undefined
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(tree).includes(condition)) found = node
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (!found) throw new Error(`Missing chat dispatch branch: ${condition}`)
  return ts.transpileModule(`(async () => { ${found.getText(tree)} })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
}

describe.each([
  ['profile query', 'tryBackendProfileQueryRoute'],
  ['deterministic query', 'message?.trim()'],
  ['website exploration', 'exploration.dispatch'],
])('desktop %s dispatch', (_name, condition) => {
  it.each((['ask', 'workspace', 'full'] as const).flatMap(mode =>
    [false, true].map(webcliRouteEnabled => ({ mode, webcliRouteEnabled })),
  ))('respects $mode confirmation mode with WebCLI routing=$webcliRouteEnabled', async ({ mode, webcliRouteEnabled }) => {
    const dispatch = vi.fn(async () => true)
    const context = vm.createContext({
      desktopPermission: resolveDesktopChatPermission(mode), dedicatedAgent: null,
      settings: { webcli_route_enabled: webcliRouteEnabled },
      message: 'Public fixture request', workId: 'fixture-work', turnId: 'fixture-turn', chatStartTime: 0,
      send: vi.fn(), appendWorkLog: vi.fn(), chatLog: { info: vi.fn() }, tag: 'fixture', getSettings: () => ({}),
      finished: false, res: { off: vi.fn(), end: vi.fn() }, onClose: vi.fn(), broadcastSSE: vi.fn(),
      retryCompaction: false, workWithMessages: { messages: [] }, savedUserMessage: undefined,
      tryBackendProfileQueryRoute: dispatch,
      tryRoutedTurn: async () => ({ handled: await dispatch() }),
      exploration: { dispatch: true, startUrl: 'https://example.com', query: 'Public query', reason: 'explicit' },
      siteGate: { reason: 'covered' }, abortController: new AbortController(),
      checkWebwrightHealth: async () => ({ ok: true }), tier4Task: null, tier4Source: null,
      openTier4Turn: async () => ({ ok: await dispatch(), taskId: 'fixture-task', run: null }),
      recordWorkLogStream: vi.fn(async function* () {}),
      modelMessages: [],
    })
    await vm.runInContext(dispatchBranch(condition), context)
    // Ask must fall through to the model's per-tool approval path. Automatic
    // query/exploration dispatch has no operation confirmation callback.
    const skip = mode === 'ask' || (condition === 'exploration.dispatch' && webcliRouteEnabled)
    expect(dispatch).toHaveBeenCalledTimes(skip ? 0 : 1)
  })
})
