import { describe, expect, it } from 'vitest'
import { compactHref, renderFromSchema } from '../declarative-renderer.js'
import { SPILL_INLINE_MAX_CHARS } from '../generic-renderer.js'

/**
 * 真实形状：今日头条热榜的 url 是 53 字符规范路径 + ~775 字符 `log_pb` 埋点参数。
 * 这不是构造出来的极端值，是从线上落盘文件里量出来的。
 */
const TRACKING_QUERY =
  '?category_name=topic_innerflow&event_type=hot_board&log_pb=%7B%22category_name%22%3A%22topic_innerflow%22%2C%22cluster_type%22%3A%222%22%7D&style_id=40187&ug_source=&source=m_redirect'

function trackingUrl(id: string): string {
  return `https://www.toutiao.com/trending/${id}/${TRACKING_QUERY}`
}

describe('声明式渲染器：链接列的 href 收敛', () => {
  it('常规链接原样保留（v2ex / arxiv 这类短链接不受影响）', () => {
    const url = 'https://www.v2ex.com/t/1024317#reply3'
    expect(compactHref(url)).toBe(url)
  })

  it('埋点 URL 去掉 query/hash，只留下能点开的规范链接', () => {
    const url = trackingUrl('7696389122834910756')
    // 线上实测单条 829 字符；此处只要越过收敛阈值就足以覆盖这条分支
    expect(url.length).toBeGreaterThan(200)
    expect(compactHref(url)).toBe('https://www.toutiao.com/trending/7696389122834910756/')
  })

  it('定位信息全在 query 里的超长 URL 不动它（宁可不省体积，也不造坏链接）', () => {
    const url = `https://example.com/?article_id=${'x'.repeat(400)}`
    expect(compactHref(url)).toBe(url)
  })

  it('链接列用收敛后的 href，且显式 `_label` 仍然优先', () => {
    const column = { type: 'link' as const, key: 'url', title: '链接' }
    const row = { url: trackingUrl('7696389122834910756') }
    const cell = renderFromSchema(
      { title: 'T', columns: [column], maxRows: 5 },
      [row],
      { now: new Date() },
    )!
    expect(cell).toContain('](https://www.toutiao.com/trending/7696389122834910756/)')
    expect(cell).not.toContain('log_pb')

    const labelled = renderFromSchema(
      { title: 'T', columns: [column], maxRows: 5 },
      [{ ...row, url_label: '看热榜' }],
      { now: new Date() },
    )!
    expect(labelled).toContain('[看热榜](')
  })

  it('20 行真实热榜渲染后能内联展示，不再顶穿落盘上限退化成指针', () => {
    const schema = {
      title: '今日头条热榜',
      columns: [
        { type: 'number' as const, key: 'rank', title: '排名' },
        { type: 'text' as const, key: 'title', title: '标题' },
        { type: 'number' as const, key: 'hot_value', title: '热度' },
        { type: 'link' as const, key: 'url', title: '链接' },
      ],
      maxRows: 20,
    }
    const rows = Array.from({ length: 20 }, (_, index) => ({
      rank: index + 1,
      title: `第 ${index + 1} 条热榜标题`,
      hot_value: 1_200_000 + index,
      url: trackingUrl(`7696389122834${String(index).padStart(4, '0')}`),
    }))
    const out = renderFromSchema(schema, rows, { now: new Date() })!
    expect(out.length).toBeLessThan(SPILL_INLINE_MAX_CHARS)
    expect(out).toContain('| 排名 | 标题 | 热度 | 链接 |')
  })
})
