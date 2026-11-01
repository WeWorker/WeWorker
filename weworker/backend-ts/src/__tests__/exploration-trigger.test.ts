/**
 * 第 4 层触发契约（`网站 <URL> 直接查询：<问题>` / `!explore <URL> <问题>`）。
 *
 * 这层的价值不在「能命中多少句」，而在**该不该命中的边界**：只有显式写出站点标记词、
 * URL、查询标记词与问题四段，才算用户要求探索；其余一律落回 LLM。所以负例比正例更重要。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPLORATION_TRIGGER,
  parseExplorationTrigger,
} from '../exploration-trigger.js'

function requestOf(message: string) {
  const result = parseExplorationTrigger(message)
  if (!result.ok) throw new Error(`预期命中，实际 ${result.reason}`)
  return result.request
}

function reasonOf(message: string) {
  const result = parseExplorationTrigger(message)
  if (result.ok) throw new Error(`预期不命中，实际命中 ${result.request.startUrl}`)
  return result.reason
}

describe('正例：唯一的探索接口', () => {
  it('完整句式', () => {
    const request = requestOf('网站 https://example.com/list 直接查询：最新公告')
    expect(request).toEqual({
      startUrl: 'https://example.com/list',
      query: '最新公告',
      force: false,
      form: 'prose',
    })
  })

  it('裸域名放行，补成 https', () => {
    expect(requestOf('网站 example.com 直接查询：价格').startUrl).toBe('https://example.com')
  })

  it('礼貌前缀与全角冒号、站点词后的冒号都接受', () => {
    expect(requestOf('帮我 网站：https://example.com 直接查询： 排名').query).toBe('排名')
    expect(requestOf('请帮我 网站 https://example.com 直接查询:报价').query).toBe('报价')
    expect(requestOf('麻烦 网站 http://example.com 直接查询：库存').startUrl).toBe('http://example.com')
  })

  it('URL 与查询标记词之间可以没有空格（URL 在中文处截止）', () => {
    expect(requestOf('网站 http://example.com直接查询：库存').startUrl).toBe('http://example.com')
  })

  it('问题里可以带空格与标点', () => {
    expect(requestOf('网站 https://example.com 直接查询：明天 上午 的 排班？').query).toBe('明天 上午 的 排班？')
  })

  it('中文路径用尖括号表达', () => {
    const request = requestOf('网站 <http://example.com/查询公告> 直接查询：标题')
    expect(request.startUrl).toBe('http://example.com/查询公告')
  })
})

describe('负例：不是探索指令就不许触发', () => {
  it('普通对话里贴链接', () => {
    expect(reasonOf('帮我看看 https://example.com/list 有什么')).toBe('not-site-command')
    expect(reasonOf('这个网站怎么样')).toBe('not-site-command')
  })

  it('缺站点标记词', () => {
    expect(reasonOf('https://example.com 直接查询：价格')).toBe('not-site-command')
  })

  it('缺查询标记词 / 缺冒号 / 空问题', () => {
    expect(reasonOf('网站 https://example.com')).toBe('missing-query-marker')
    expect(reasonOf('网站 https://example.com 直接查询 价格')).toBe('missing-query-marker')
    expect(reasonOf('网站 https://example.com 直接查询：')).toBe('empty-query')
    expect(reasonOf('网站 https://example.com 直接查询：   ')).toBe('empty-query')
  })

  it('缺 URL', () => {
    expect(reasonOf('网站 直接查询：价格')).toBe('missing-url')
  })

  it('存量事故：中文被截断后的残片不得被猜成路径', () => {
    expect(reasonOf('网站 http://example.com/查询公告 直接查询：标题')).toBe('ambiguous-url-boundary')
  })

  it('URL 前有无法解释的前缀', () => {
    expect(reasonOf('网站 这个 https://example.com 直接查询：价格')).toBe('ambiguous-url-boundary')
  })

  it('空消息', () => {
    expect(reasonOf('')).toBe('not-site-command')
  })
})

describe('强制档：!explore', () => {
  it('标记为 force，其余格式一致', () => {
    const request = requestOf('!explore https://example.com/a 最新公告')
    expect(request).toEqual({
      startUrl: 'https://example.com/a',
      query: '最新公告',
      force: true,
      form: 'bang',
    })
  })

  it('不做站点标记词与查询标记词的要求（显式命令行）', () => {
    expect(requestOf('!explore example.com 价格').startUrl).toBe('https://example.com')
  })

  it('缺问题不触发', () => {
    expect(reasonOf('!explore https://example.com/a')).toBe('empty-query')
    expect(reasonOf('!explore')).toBe('missing-url')
  })

  it('注册表关闭 allowBang 时整条不认', () => {
    const result = parseExplorationTrigger('!explore https://example.com/a x', {
      ...DEFAULT_EXPLORATION_TRIGGER,
      allowBang: false,
    })
    expect(result.ok).toBe(false)
  })
})
