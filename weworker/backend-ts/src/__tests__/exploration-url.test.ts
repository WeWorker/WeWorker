/**
 * URL 边界解析回归（存量事故：中文被整串吞进 URL）。
 *
 * 事故原文：`http://example.com/查询公告` 旧实现整串成为 URL，探索起点指向一个不存在的
 * 中文路径，任务跑偏且没有任何报错。这里把边界钉死：裸 URL 只吃 ASCII，中文必须用
 * `<...>` 显式界定；末尾标点不进 URL；多个候选按原文位置排序。
 */
import { describe, expect, it } from 'vitest'
import { extractUnknownSiteUrl } from '../tier4-dispatch.js'
import { hostOf, isSiteLikeUrl, normalizeUrlCandidate, scanUrlTokens, stripUrlPunctuation } from '../exploration-url.js'

describe('scanUrlTokens', () => {
  it('裸 URL 在中文处截止，中文不进入 URL', () => {
    const [token] = scanUrlTokens('http://example.com/查询公告')
    expect(token.url).toBe('http://example.com/')
    expect(token.wrapped).toBe(false)
    expect(token.start).toBe(0)
    expect(token.end).toBe('http://example.com/'.length)
  })

  it('尖括号是中文路径的唯一出口', () => {
    const text = '网站 <http://example.com/查询公告> 直接查询：价格'
    const [token] = scanUrlTokens(text)
    expect(token.url).toBe('http://example.com/查询公告')
    expect(token.wrapped).toBe(true)
    expect(text.slice(token.start, token.end)).toBe('<http://example.com/查询公告>')
  })

  it('末尾标点与中文标点不进 URL', () => {
    expect(scanUrlTokens('http://example.com/a;')[0].url).toBe('http://example.com/a')
    expect(scanUrlTokens('http://example.com/a。')[0].url).toBe('http://example.com/a')
    expect(scanUrlTokens('见 (http://example.com/a)').at(0)?.url).toBe('http://example.com/a')
  })

  it('裸域名补 scheme，路径在中文处截止', () => {
    expect(scanUrlTokens('example.com')[0].url).toBe('https://example.com')
    expect(scanUrlTokens('example.com/查询')[0].url).toBe('https://example.com/')
    expect(scanUrlTokens('shop.example.org:8443/a')[0].url).toBe('https://shop.example.org:8443/a')
  })

  it('多个候选按原文位置排序（不是「先所有 scheme 再所有裸域」）', () => {
    const tokens = scanUrlTokens('先看 example.com 再看 https://other.example.org/x')
    expect(tokens.map((token) => token.url)).toEqual(['https://example.com', 'https://other.example.org/x'])
  })

  it('不把邮箱后半段当成站点', () => {
    expect(scanUrlTokens('联系 user@example.com')).toHaveLength(0)
  })

  it('非 URL 文本返回空；文件扩展名顶层域不算站点', () => {
    expect(scanUrlTokens('帮我总结一下这段话')).toHaveLength(0)
    expect(scanUrlTokens('')).toHaveLength(0)
    // `v1.2.zip` 形状上像 URL，所以 tokenizer 照实返回；「是不是站点」由 isSiteLikeUrl 判定。
    expect(scanUrlTokens('下载 v1.2.zip 之后再说').map((token) => token.url)).toEqual(['https://v1.2.zip'])
    expect(isSiteLikeUrl('https://v1.2.zip')).toBe(false)
    expect(isSiteLikeUrl('https://v1.example.com/report.pdf')).toBe(true)
  })
})

describe('normalizeUrlCandidate', () => {
  it('拒绝非 http(s) 与非 URL', () => {
    expect(normalizeUrlCandidate('ftp://example.com')).toBeNull()
    expect(normalizeUrlCandidate('帮我看看')).toBeNull()
    expect(normalizeUrlCandidate('')).toBeNull()
  })

  it('hostOf 解析失败不抛', () => {
    expect(hostOf('http://example.com/a')).toBe('example.com')
    expect(hostOf('not a url')).toBe('')
  })

  it('stripUrlPunctuation 只剥句尾', () => {
    expect(stripUrlPunctuation('http://example.com/a.')).toBe('http://example.com/a')
    expect(stripUrlPunctuation('http://example.com/a?x=1;')).toBe('http://example.com/a?x=1')
  })
})

describe('extractUnknownSiteUrl（回滚路径用的旧语义，边界已修）', () => {
  it('中文不再进 URL', () => {
    expect(extractUnknownSiteUrl('看看 http://example.com/查询公告', new Set())).toBe('http://example.com/')
  })

  it('文件扩展名 TLD 不算站点信号', () => {
    expect(extractUnknownSiteUrl('下载 v1.2.zip', new Set())).toBeNull()
  })

  it('已注册 host 跳过，继续找下一个未注册站点', () => {
    const message = '在 example.com 和 https://other.example.net/x 都看看'
    expect(extractUnknownSiteUrl(message, new Set(['example.com']))).toBe('https://other.example.net/x')
  })

  it('没有任何站点信号返回 null', () => {
    expect(extractUnknownSiteUrl('帮我总结一下这段话', new Set())).toBeNull()
  })
})
