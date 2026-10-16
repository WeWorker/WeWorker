/**
 * 通用渲染器 · 落盘大结果的回读渲染。
 *
 * 背景：工具输出超过 LARGE_OUTPUT_THRESHOLD_CHARS（16k 字符）会被落盘，只回一个
 * `large_output` 指针。LLM 路径上指针是终点没问题——模型会按需用 `webcli_result` 回读；
 * 但路由 fast-path 回合**零 LLM**，落库的只有渲染出的这段 md，指针就等于「查到了但没给
 * 数据」（实测：`今日头条热榜` / `微信读书排行榜` 都只回了「结果过大已落盘」）。
 */
import { describe, expect, it } from 'vitest'
import { renderGeneric } from '../generic-renderer.js'

const POINTER = JSON.stringify({
  type: 'large_output',
  tool: 'toutiao.com.hot',
  file: '/tmp/tool-results/work-1/toutiao.com.hot-1.json',
  count: 20,
  header: 'count=20',
  hint: '完整结果已落盘，这里只给计数与表头，不含具体数据。',
})

describe('renderGeneric · 落盘指针回读', () => {
  it('缺省不回读 → 指针文案（既有行为，逐字不变）', () => {
    const md = renderGeneric(POINTER, '今日头条热榜')
    expect(md).toContain('结果过大已落盘')
    expect(md).toContain('count=20')
    expect(md).toContain('webcli_result')
  })

  it('可回读 → 直接渲染落盘内容，不再出现指针文案', () => {
    const payload = JSON.stringify({
      ok: true,
      count: 2,
      items: [{ id: 1, title: '甲条' }, { id: 2, title: '乙条' }],
    })
    const md = renderGeneric(POINTER, '今日头条热榜', undefined, { rehydrate: () => payload })
    expect(md).not.toContain('结果过大已落盘')
    expect(md).toContain('甲条')
    expect(md).toContain('乙条')
  })

  it('回读失败（null）→ 退回指针文案', () => {
    const md = renderGeneric(POINTER, '今日头条热榜', undefined, { rehydrate: () => null })
    expect(md).toContain('结果过大已落盘')
  })

  it('回读成功但渲染出来仍超上限 → 退回指针文案', () => {
    const cols = 8
    const huge = JSON.stringify({
      ok: true,
      items: Array.from({ length: 30 }, (_, row) =>
        Object.fromEntries(
          Array.from({ length: cols }, (_, col) => [`列${col}`, `${row}-${col}-${'x'.repeat(80)}`]),
        ),
      ),
    })
    const md = renderGeneric(POINTER, '今日头条热榜', undefined, { rehydrate: () => huge })
    expect(md).toContain('结果过大已落盘')
  })

  it('非指针输出不受影响', () => {
    const md = renderGeneric(JSON.stringify({ ok: true, items: [{ id: 3, title: '丙条' }] }))
    expect(md).toContain('丙条')
    expect(md).not.toContain('结果过大已落盘')
  })
})
