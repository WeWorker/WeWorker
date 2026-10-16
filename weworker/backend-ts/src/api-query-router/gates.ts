/**
 * 两道硬门（详见 docs/intelligent_routing_design.md §2 第 4/5 行）。
 *
 * 精度红线贯穿本文件：**漏判免费、误判致命**。门只负责「拦下不该被快捷层接走的句子」，
 * 拦错一条真查询的代价只是走一次 LLM（结果仍正确），所以词表刻意只收明确非查询的标记。
 *
 * 两道门对 `!` 显式点名一律豁免——用户主动点名工具是更高优先级的指令，由调用方在
 * 进入本模块前判断。
 */

import type { Message } from '../works-store.js'

/**
 * 硬门①（讨论态）：消息在「谈论/问询系统或任务本身」而非发起数据查询时出现的词。
 *
 * 典型事故句：「这个功能是否正常」「刚才那个查询失败了」「这是我常用的归档习惯：先按月分组」
 * ——分别由 `是否`、`失败`、`习惯` 命中。
 *
 * 刻意只收「明确非查询」的词：查询词（有哪些 / 多少 / 列表 / 到期 …）一律不进此表。
 */
const DISCUSSION_MARKER_RE =
  /是否|正常吗|正常么|可用吗|通不通|挂了|宕机|失败|报错|出错|异常|错误|习惯|偏好|记住|记忆|值得|建议|这个功能|该功能|这个系统|本系统|为什么|为何|怎么|什么意思|叫什么|是什么|[吗呢]\s*[？?。!！]{0,2}\s*$/

/** 含讨论态标记 → 整条消息落回 LLM（任何快捷层都不接，`!` 显式别名豁免）。 */
export function isDiscussionMessage(message: string): boolean {
  const text = message?.trim() ?? ''
  if (!text) return false
  return DISCUSSION_MARKER_RE.test(text)
}

/**
 * 硬门①b（追问态）回指标记：
 * - 指代：这个/那个/这些/那些/其中/里面/上面/前面…/它（负向后顾排除「其它」的「它」）；
 * - 序号回指：第一条 / 第 2 条 / 最后一条 / 最新一条 / 上一个。
 * - 刻意不收：他/她/谁（人称代词多指人）；「此」「该」单字误伤面大（此外/应该）。
 */
const REFERENTIAL_RE =
  /这个|那个|这些|那些|其中|里面|上[面边]|前面(那个|提到|的)|刚才|刚刚|同上|(?<!其)它|第一[条个位项]|第\s*\d+\s*[条个位项]|第[一二三四五六七八九十]+[条个位项]|最后一条|最新一条|上一[条个次]/

/**
 * 近窗：从尾部向前最多回看几条 assistant 消息里的 fast-path timing 块。
 * 取 3：覆盖「fast-path → LLM 追问 → 再追问」链路——第二次追问的回指对象可能仍是
 * fast-path 那份列表，而中间隔着的 LLM 回合 timing 块不带 routeTool。
 */
const FASTPATH_LOOKBACK_ASSISTANT_MSGS = 3

/** 近窗内是否存在 fast-path 命中（timing 块带 routeTool）。 */
function hasRecentFastPath(history: Message[] | undefined): boolean {
  if (!history?.length) return false
  let seen = 0
  for (let i = history.length - 1; i >= 0 && seen < FASTPATH_LOOKBACK_ASSISTANT_MSGS; i--) {
    if (history[i].role !== 'assistant') continue
    seen++
    if ((history[i].content ?? []).some((block) => block.type === 'timing' && !!block.routeTool)) {
      return true
    }
  }
  return false
}

/**
 * 追问态判定：回指词 **且** 近窗内有 fast-path 命中。
 *
 * fast-path 命中的回合零 LLM，结果只以渲染 md 落库；紧随其后的追问（「第一条什么状态」）
 * 若被宽泛层再次抢中，会原样重跑同一查询、把追问意图整条吞掉。落回 LLM 后模型能拿到完整
 * 历史（含 timing 块的路由来源投影，见 agent.ts contentBlockPromptText）并正确接住。
 *
 * `recentHistory` 应为「当前用户消息之前」的消息数组；不传 = 守卫不生效（行为零变化）。
 */
export function isFollowUpMessage(message: string, recentHistory?: Message[]): boolean {
  const text = message?.trim() ?? ''
  if (!text) return false
  if (!REFERENTIAL_RE.test(text)) return false
  return hasRecentFastPath(recentHistory)
}

/** 供测试与日志断言用的正则导出（不参与业务逻辑）。 */
export const __gatesForTests = { DISCUSSION_MARKER_RE, REFERENTIAL_RE }
