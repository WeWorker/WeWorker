/**
 * 路由接线的**架构守卫**。
 *
 * 企微（wecom-channel）在自己的流式回合里内联跑模型，微信（weixin-channel）与飞书/QQ 走
 * `runChannelChat`，这些渠道都不方便在单测里启真实通道，所以这里按源码断言把接线钉住：
 *
 * - 所有入口只能调用共享入口 `tryRoutedTurn`，不允许再直接调用 `tryIntelligentQueryRoute`
 *   （本次改动就是把接线收敛成一份，散落的第二次接线正是「定时任务/渠道不走路由」的成因）；
 * - WeWorker Bot 的回合必须显式跳过路由（桌面、定时、企微、微信四条路径都要有）；
 * - 桌面端保持 `persist: true`（路由层自己落库），其它入口自己落库。
 *
 * 行为级覆盖在 routed-turn / channel-routed-turn / task-executor-routing 三个测试里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (relative: string): string => fs.readFileSync(path.resolve(__dirname, relative), 'utf8')

const sources = {
  server: read('../server.ts'),
  taskExecutor: read('../task-executor.ts'),
  channelManager: read('../channels/channel-manager.ts'),
  wecom: read('../channels/wecom-channel.ts'),
  weixin: read('../channels/weixin-channel.ts'),
  agentChannel: read('../dedicated-agents/agent-channel.ts'),
  channelProfile: read('../channels/channel-profile.ts'),
}

describe('智能路由接线', () => {
  it('四个入口都走共享入口，没有各自直连级联', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, `${name} 不应直接调用 tryIntelligentQueryRoute`).not.toContain('tryIntelligentQueryRoute')
    }
    expect(sources.server).toContain('tryRoutedTurn({')
    expect(sources.taskExecutor).toContain('tryRoutedTurn({')
    expect(sources.channelManager).toContain('tryRoutedTurn({')
    expect(sources.wecom).toContain('tryRoutedTurn({')
  })

  it('desktop forwards only an unmodified, attachment-free card hint', () => {
    expect(sources.server).toContain('scenario?: unknown;')
    expect(sources.server).toContain('scenario: importedAttachments.length === 0 && modelInputMessage === message ? scenario : undefined,')
    expect(sources.server).toContain("desktopPermission.channelPermissionMode !== 'ask' && retryCompaction !== true && message?.trim()")
  })

  it('desktop exact-route learning stays unverified without a structured execution receipt', () => {
    expect(sources.server).toContain("const learningEligible = plainDesktopQuestion && directRoute.status === 'miss'")
    expect(sources.server).toContain('observation?.event({ type: ev.type, id: ev.id, name: ev.name, args: ev.args })')
    expect(sources.server).toContain('observation?.finish({ completed: turnSucceeded')
    expect(sources.server).not.toContain('observation?.structuredIdentity(')
    expect(sources.server).toContain('verification: \'identity_only_unverified\', runnableArgs: null')
    expect(sources.server).toContain("res.status(409).json({ detail: '候选缺少可信固定参数")
  })

  it('approved exact routes are scoped, revalidated and fall back before visible output', () => {
    expect(sources.server).toContain('workWithMessages.workspace_directory')
    expect(sources.server).toContain('localFastRoutes.execute(match.route, { workId, isReserved: fastRouteReserved })')
    expect(sources.server).toContain("directRoute = { status: 'failed', reason: 'local_route_failed' }")
    expect(sources.server.indexOf("store.appendMessage(workId, 'assistant', [{ type: 'text', text: answer }")).toBeLessThan(
      sources.server.indexOf("send({ type: 'text_delta', content: answer })"),
    )
  })

  it('桌面端保持自己落库，其它入口自己写', () => {
    // 桌面 /chat 的持久化行为必须与下沉前逐字一致。
    expect(sources.server).toContain('persist: true')
    expect(sources.taskExecutor).toContain('persist: false')
    expect(sources.channelManager).toContain('persist: false')
    expect(sources.wecom).toContain('persist: false')
  })

  it('WeWorker Bot 的四条路径都跳过路由', () => {
    // 桌面：唯一确定性入口跳过专属 Agent，旧 profile 入口已退役。
    expect(sources.server).toContain('if (!dedicatedAgent && desktopPermission.channelPermissionMode')
    expect(sources.server).not.toContain('tryBackendProfileQueryRoute(')
    // 定时任务：agent 任务不进路由。
    expect(sources.taskExecutor).toContain('const routed = agent')
    // 企微 / 微信：由 profile 上的WeWorker Bot 标记决定。
    expect(sources.wecom).toContain('this._profile.dedicatedAgentId')
    expect(sources.weixin).toContain('dedicatedAgent: !!this._profile.dedicatedAgentId')
    expect(sources.channelManager).toContain('opts?.dedicatedAgent')
    // WeWorker Bot 的渠道 profile 必须带上这个标记，否则上面的判断恒为假。
    expect(sources.agentChannel).toContain('dedicatedAgentId: agentId')
    expect(sources.channelProfile).toContain('dedicatedAgentId?: string')
  })

  it('企微路由命中后不再跑模型回合', () => {
    // 命中时用空流顶掉 streamChat：收尾/发送仍走同一条路径，但不再付模型成本。
    expect(sources.wecom).toContain('routed?.handled || turn.abortController.signal.aborted ? noModelEvents() : streamChat(')
    // 路由回合的 timing 自带 routeTool，不能再叠一条模型计时把来源抹掉。
    expect(sources.wecom).toContain('if (!routed?.handled) {')
  })

  it('定时任务与渠道都自己落库，避免同一条回复写两次', () => {
    expect(sources.taskExecutor).toContain('routedAssistantBlocks(routed)')
    expect(sources.channelManager).toContain("{ type: 'timing', ...routed.timing }")
    expect(sources.wecom).toContain("{ type: 'timing', ...routed.timing }")
  })
})
