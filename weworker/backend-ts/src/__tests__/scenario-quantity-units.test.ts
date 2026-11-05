import { describe, expect, it } from 'vitest'
import { compilePatternRegex, normalizeText } from '../api-query-router/scenario-route-compiler.js'
import { buildManifestTemplateIndex, matchManifestTemplate } from '../api-query-router/manifest-templates.js'

const regexFor = (template: string, names: string[], params?: Record<string, unknown>) => {
  const index: Record<string, number> & { __params?: Record<string, unknown> } = {}
  names.forEach((name, i) => { index[name] = i })
  index.__params = params
  const compiled = compilePatternRegex(template, index)
  return new RegExp(compiled.regex, compiled.flags)
}

describe('scenario route quantity placeholders', () => {
  it.each([
    ['近${7天}记录', '近14天记录', '近14周记录', '14'],
    ['共${3个}项目', '共8个项目', '共8条项目', '8'],
    ['每${2小时}同步', '每12小时同步', '每12分钟同步', '12'],
    ['翻${3页}', '翻5页', '翻5楼', '5'],
  ])('keeps the unit literal in %s', (template, valid, invalid, quantity) => {
    const name = template.match(/\$\{([^}]+)\}/)?.[1] ?? ''
    const re = regexFor(template, [name])
    expect(re.exec(normalizeText(valid))?.groups?.s0).toBe(quantity)
    expect(re.test(normalizeText(invalid))).toBe(false)
    expect(re.test(normalizeText(`${valid}附加文字`))).toBe(false)
  })

  it('keeps placeholder names and whitespace normalization, while ordinary slots stay unrestricted', () => {
    const re = regexFor('查 ${7天} 的 ${项目}', ['7天', '项目'])
    expect(re.exec(normalizeText('查 21天 的 示例项目'))?.groups).toMatchObject({ s0: '21', s1: '示例项目' })
    expect(re.test(normalizeText('查 21周 的 示例项目'))).toBe(false)
    expect(regexFor('查询${项目}', ['项目']).exec('查询不限单位')?.groups?.s0).toBe('不限单位')
  })

  it('preserves numeric schema and repeated slot matching without capturing the unit', () => {
    const re = regexFor('近${7天}比${7天}', ['7天'], { '7天': { type: 'integer' } })
    expect(re.exec('近12天比3天')?.groups?.s0).toBe('12')
    expect(re.test('近12周比3天')).toBe(false)
    expect(re.test('近12天比3周')).toBe(false)
  })
})

describe('manifest template quantity placeholders', () => {
  const directTools = [{ name: 'example.read', aliases: [], safety: 'read', requiresConfirmation: false }]
  const makeIndex = (slot: string, validate: string) => buildManifestTemplateIndex([
    { adapterId: 'example', defs: [{ id: 'quantity', pattern: `查询近\${${slot}}记录`, tool: 'example.read', slots: { [slot]: { arg: 'count', validate } } }] },
  ], directTools)

  it.each([
    ['7天', '查询近14天记录', '查询近14周记录', '14'],
    ['3个', '查询近8个记录', '查询近8条记录', '8'],
    ['2小时', '查询近12小时记录', '查询近12分钟记录', '12'],
  ])('extracts only quantity and rejects substituted units for %s', (slot, valid, invalid, quantity) => {
    const index = makeIndex(slot, '\\d+')
    expect(index.skipped).toEqual([])
    expect(matchManifestTemplate(valid, index)?.args).toEqual({ count: quantity })
    expect(matchManifestTemplate(valid, index)?.slotValues).toEqual([{ name: slot, kind: 'free', raw: quantity }])
    expect(matchManifestTemplate(invalid, index)).toBeNull()
    expect(matchManifestTemplate(`${valid}附加文字`, index)).toBeNull()
  })

  it('keeps ordinary free slot validation unchanged', () => {
    const index = makeIndex('数量', '\\d+')
    expect(matchManifestTemplate('查询近14记录', index)?.args).toEqual({ count: '14' })
    expect(matchManifestTemplate('查询近任意记录', index)).toBeNull()
  })
})
