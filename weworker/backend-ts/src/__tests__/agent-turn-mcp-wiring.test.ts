/**
 * streamChat 的回合工具服务器接线（专属 Agent 身份）。
 *
 * 修复的约束：专属 Agent 回合的工具服务器必须由 streamChat 统一构建——
 * 同时拿到 opts.dedicatedAgent 身份与本回合的 userMedia 出口。此前
 * buildAgentChatOptions 自带一个不带 userMedia 的 mcpServerOverride，
 * 整体替换掉了带出口的服务器，导致所有 Bot 回合里 send_file_to_user /
 * send_image_to_user 永远报「当前对话无法发送文件」。
 *
 * streamChat 无法整体实例化（拉起真实 CLI），按仓库既有做法抽取源码
 * 片段在 vm 中执行（见 wecom-channel-notify-target.test.ts）。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(new URL('../agent.ts', import.meta.url), 'utf8')

/** 切出「构建回合服务器 + 选择生效服务器」的片段并在给定 opts 下执行。 */
function runServerSlice(opts: Record<string, unknown>) {
  const start = source.indexOf('  const mcpServer = _buildMcpServer({')
  const activeLine = '  const activeMcpServer = opts.mcpServerOverride || mcpServer'
  const end = source.indexOf(activeLine, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  const sink = { file: async () => {}, image: () => {} }
  const built: Array<Record<string, unknown>> = []
  const context = vm.createContext({
    _buildMcpServer: (ctx: Record<string, unknown>) => { built.push(ctx); return { marker: 'built-server' } },
    channelPermissionMode: 'full',
    workspaceDirectory: 'C:/weworker-fixtures',
    abortController: { signal: null },
    turnBindings: { userMedia: sink, extraToolGuard: undefined },
    readQueryScope: { current: 'turn-fixture' },
    opts,
    // const 声明不会挂到 context 上，用该变量把片段结果带出来。
    __sliceResult: undefined as unknown,
  })
  const code = ts.transpileModule(`${source.slice(start, end) + activeLine}\n;__sliceResult = activeMcpServer`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInContext(code, context)
  return { built, activeMcpServer: (context as unknown as { __sliceResult: unknown }).__sliceResult }
}

/** 切出 sessionMode 判定并求值。 */
function runSessionMode(opts: Record<string, unknown>): boolean {
  const start = source.indexOf('  const sessionMode = opts.reuseSession === true')
  const endToken = '&& !opts.compactionOnly'
  const end = source.indexOf(endToken, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  const context = vm.createContext({ opts, internal: {}, __sliceResult: undefined as unknown })
  const code = ts.transpileModule(`${source.slice(start, end + endToken.length)}\n;__sliceResult = sessionMode`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInContext(code, context)
  return (context as unknown as { __sliceResult: unknown }).__sliceResult as boolean
}

const reusableTurn = { reuseSession: true, workId: 'work-fixture', streaming: true }

describe('streamChat 的专属 Agent 服务器接线', () => {
  it('dedicatedAgent 身份与本回合的 userMedia 出口进入同一个服务器', () => {
    const { built } = runServerSlice({
      ...reusableTurn,
      workId: 'work-fixture',
      onAskUser: null,
      channelAskUserHandler: null,
      dedicatedAgent: { agentId: 'agent-fixture', ownerUserId: 'owner-fixture' },
    })
    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({
      channelPermissionMode: 'full',
      dedicatedAgent: { agentId: 'agent-fixture', ownerUserId: 'owner-fixture' },
    })
    // 关键回归点：工具服务器拿得到本回合的文件出口。
    const userMedia = built[0].userMedia as () => unknown
    expect(typeof userMedia).toBe('function')
    expect(userMedia()).toMatchObject({ file: expect.any(Function), image: expect.any(Function) })
  })

  it('非 Agent 回合不携带 dedicatedAgent 键', () => {
    const { built } = runServerSlice({ workId: 'work-fixture', onAskUser: null, channelAskUserHandler: null })
    expect(built[0]).not.toHaveProperty('dedicatedAgent')
  })

  it('显式 mcpServerOverride 仍然整体优先生效（网站探索等调用方）', () => {
    const override = { marker: 'override-server' }
    const { built, activeMcpServer } = runServerSlice({
      workId: 'work-fixture', onAskUser: null, channelAskUserHandler: null, mcpServerOverride: override,
    })
    expect(built).toHaveLength(1)
    expect(activeMcpServer).toBe(override)
  })
})

describe('专属 Agent 回合保持一次性执行', () => {
  it('dedicatedAgent 与 mcpServerOverride 一样阻止会话复用', () => {
    expect(runSessionMode({ ...reusableTurn, dedicatedAgent: { agentId: 'agent-fixture', ownerUserId: 'owner-fixture' } })).toBe(false)
    expect(runSessionMode({ ...reusableTurn, mcpServerOverride: { marker: 'override-server' } })).toBe(false)
  })

  it('普通桌面回合仍可复用', () => {
    expect(runSessionMode(reusableTurn)).toBe(true)
  })
})
