import { describe, expect, it } from 'vitest'
import { parseJsonc, stripJsonComments } from '../router-config/jsonc.js'

/**
 * JSONC 解析的正确性单测。
 *
 * 核心风险只有一个：**把字符串里的 `//` 误当注释删掉**（URL `https://…`、工具名里的斜杠）。
 * 一旦发生，配置会静默变成错的值或直接解析失败，而失败又被 loader 吞成「该层回退」，
 * 现象是「路由莫名其妙不生效」——极难排查。所以这里把它钉死。
 */
describe('stripJsonComments：注释剥离', () => {
  it('剥离行注释，保留换行', () => {
    const src = '{\n  // 这一条查热榜\n  "a": 1\n}'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 1 })
    // 换行数不变，保证 JSON.parse 报错时行号能对上原文件
    expect(stripJsonComments(src).split('\n').length).toBe(src.split('\n').length)
  })

  it('剥离块注释，内部换行原样保留', () => {
    const src = '{\n  /* 说明\n     第二行 */\n  "a": 1\n}'
    const out = stripJsonComments(src)
    expect(JSON.parse(out)).toEqual({ a: 1 })
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })

  it('剥离行尾注释', () => {
    expect(JSON.parse(stripJsonComments('{ "a": 1, // 说明\n "b": 2 }'))).toEqual({ a: 1, b: 2 })
  })
})

describe('stripJsonComments：字符串内容绝不被改动', () => {
  it('URL 里的 // 保留', () => {
    const src = '{ "url": "https://example.com/a//b" }'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ url: 'https://example.com/a//b' })
  })

  it('字符串里的 /* 与 */ 保留', () => {
    const src = '{ "note": "a /* not a comment */ b" }'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ note: 'a /* not a comment */ b' })
  })

  it('转义引号不破坏字符串状态', () => {
    const src = '{ "q": "他说 \\"a // b\\" 然后离开" }'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ q: '他说 "a // b" 然后离开' })
  })

  it('转义反斜杠后紧跟引号，仍能正确结束字符串', () => {
    // 值为单个反斜杠：JSON 里写作 "\\"，剥注释后必须仍是 "\\"
    const src = '{ "p": "C:\\\\path", // 后有注释\n "q": 1 }'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ p: 'C:\\path', q: 1 })
  })

  it('注释里的引号不会让解析器进入字符串态', () => {
    const src = '{\n  // 说明里有个 " 引号\n  "a": 1\n}'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 1 })
  })
})

describe('stripJsonComments：尾逗号', () => {
  it('对象与数组的尾逗号都被去掉', () => {
    expect(JSON.parse(stripJsonComments('{ "a": [1, 2,], }'))).toEqual({ a: [1, 2] })
  })

  it('尾逗号与注释混用', () => {
    const src = '{\n  "a": [1, 2,], // 尾逗号在注释前\n}'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: [1, 2] })
  })

  it('字符串里的逗号不受影响', () => {
    expect(JSON.parse(stripJsonComments('{ "a": "x,]" }'))).toEqual({ a: 'x,]' })
  })
})

describe('parseJsonc：真实配置片段', () => {
  it('读取带中文注释与成功示例的层配置', () => {
    const src = `{
  // ── 本文件 = 第 1 层（显式点名）────────────────
  // 成功示例：输入 "!hn" → 调用 news.ycombinator.com.top
  "news.ycombinator.com": [
    {
      // 别名必须与 adapter 站名同源，避免与其他站撞名
      "id": "hn-top",
      "alias": "!hn",
      "tool": "news.ycombinator.com.top",
      "examples": ["!hn"],
      "args": { "limit": 20 }, // 固定参数写在配置里
    },
  ],
}`
    const parsed = parseJsonc(src) as Record<string, Array<Record<string, unknown>>>
    expect(Object.keys(parsed)).toEqual(['news.ycombinator.com'])
    expect(parsed['news.ycombinator.com'][0]).toMatchObject({
      id: 'hn-top',
      alias: '!hn',
      tool: 'news.ycombinator.com.top',
      examples: ['!hn'],
      args: { limit: 20 },
    })
  })

  it('注释被完整剥离后仍是合法 JSON 文本', () => {
    const out = stripJsonComments('{ /* a */ "k": 1 }')
    expect(out.includes('/*')).toBe(false)
    expect(JSON.parse(out)).toEqual({ k: 1 })
  })
})
