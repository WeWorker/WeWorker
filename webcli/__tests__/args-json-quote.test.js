// Feature: args-json-quote, --args 引号剥离重试(cmd/宿主场景单引号成内容的一部分)
// **Validates: Requirements——同一条命令在 Bash 与 cmd 下行为一致**
import { describe, it, expect } from 'vitest'
import { parseArgsJson } from '../index.js'

const SQ = String.fromCharCode(39)

describe('parseArgsJson 引号剥离重试', () => {
  it('首尾成对单引号包裹的 JSON → 剥离后解析成功(cmd 转发场景)', () => {
    const args = parseArgsJson(`${SQ}{"filter":"myTeam","mode":"security","maxDays":7,"includeOverdue":false}${SQ}`)
    expect(args).toEqual({ filter: 'myTeam', mode: 'security', maxDays: 7, includeOverdue: false })
  })
  it('首尾成对双引号包裹的 JSON → 剥离后解析成功', () => {
    // 现实形态:--args '"{"a":1}"' 的双引号经某层转发未被消费,CLI 收到带外层双引号的输入
    const args = parseArgsJson('"{"a":1}"')
    expect(args).toEqual({ a: 1 })
  })
  it('JSON 内容内部的引号不受影响(只剥最外层配对引号)', () => {
    const args = parseArgsJson(`${SQ}{"keyword":"it${SQ}s a ticket","limit":5}${SQ}`)
    expect(args).toEqual({ keyword: "it's a ticket", limit: 5 })
  })
  it('裸 JSON 仍正常解析(不剥内容中的引号)', () => {
    expect(parseArgsJson('{"filter":"myTeam"}')).toEqual({ filter: 'myTeam' })
  })
  it('剥离后仍非法 → 落回 key=value → 最终报错不变', () => {
    expect(() => parseArgsJson(`${SQ}{filter:myTeam}${SQ}`)).toThrow(/--args 必须是有效的 JSON/)
  })
  it('非 JSON 形态(引号包裹普通文本)不误剥 → 报错', () => {
    expect(() => parseArgsJson(`${SQ}hello world${SQ}`)).toThrow(/--args 必须是有效的 JSON/)
  })
})
