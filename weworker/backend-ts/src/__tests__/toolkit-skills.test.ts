/**
 * 已毕业 toolkit skill 识别单测（第16行）。
 *
 * 这层的输入是**用户机器上任意目录**（`<user_directory>/.claude/skills/`），内容由第三方
 * 安装包写入：坏 JSON、缺字段、非目录都必须被跳过而不是抛异常，且「识别失败 = 视为未毕业」
 * 只会让它回第4层（多跑一次探索），绝不会把错工具清单注入给模型。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearToolkitSkillsCache,
  listToolkitSkills,
  resolveToolkitSkillPrompt,
  toolkitGateCandidates,
} from '../toolkit-skills.js'

const tempDirs: string[] = []

function tempSkillsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-toolkit-skills-'))
  tempDirs.push(dir)
  clearToolkitSkillsCache()
  return dir
}

function writeSkill(skillsDir: string, dirName: string, manifest: unknown): void {
  const dir = path.join(skillsDir, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    'utf-8',
  )
}

const TOOLKIT = {
  id: 'example-toolkit',
  name: '示例站点工具包',
  adapter_type: 'toolkit',
  allowed_domains: ['Shop.Example.org', 'shop.example.org'],
  tools: [
    { name: 'example-toolkit.search', description: '搜索', parameters_schema: { properties: { q: { type: 'string' } } } },
    { name: 'example-toolkit.detail' },
  ],
}

afterEach(() => {
  clearToolkitSkillsCache()
  while (tempDirs.length > 0) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
})

describe('listToolkitSkills：扫描与容错', () => {
  it('识别 adapter_type=toolkit 的 skill，域名去重并小写', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'example-toolkit', TOOLKIT)

    const skills = listToolkitSkills({ skillsDir: dir })
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: 'example-toolkit', name: '示例站点工具包', hosts: ['shop.example.org'] })
  })

  it('工具映射为 StaticToolDef 形状且标为可直调（toolkit 走本地 Runtime，无页面依赖）', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'example-toolkit', TOOLKIT)

    const [skill] = listToolkitSkills({ skillsDir: dir })
    expect(skill.tools.map((tool) => tool.name)).toEqual(['example-toolkit.search', 'example-toolkit.detail'])
    expect(skill.tools[0]).toMatchObject({ directCapable: true, executionMode: 'direct', description: '搜索' })
    expect(skill.tools[0].parameters).toEqual({ properties: { q: { type: 'string' } } })
    // 缺 description 时退化为空串（不写 undefined，避免下游拼接出 "undefined"）
    expect(skill.tools[1].description).toBe('')
    expect(skill.tools[1].parameters).toEqual({})
  })

  it('非 toolkit 类型的 skill 不参与（普通 Skill 不是站点能力包）', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'plain-skill', { id: 'plain-skill', adapter_type: 'plain', allowed_domains: ['x.example.org'] })
    expect(listToolkitSkills({ skillsDir: dir })).toEqual([])
  })

  it('缺 allowed_domains / 空数组 → 跳过（没有域名就没有站点信号，无法参与第3层）', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'no-domains', { id: 'a', adapter_type: 'toolkit' })
    writeSkill(dir, 'empty-domains', { id: 'b', adapter_type: 'toolkit', allowed_domains: [] })
    writeSkill(dir, 'blank-domains', { id: 'c', adapter_type: 'toolkit', allowed_domains: ['  ', ''] })
    expect(listToolkitSkills({ skillsDir: dir })).toEqual([])
  })

  it('坏 JSON / 缺 manifest / 非目录条目全部跳过，不影响其余 skill', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'broken-json', '{ this is not json')
    writeSkill(dir, 'good-one', TOOLKIT)
    fs.mkdirSync(path.join(dir, 'no-manifest'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'stray-file.txt'), 'ignored', 'utf-8')

    const skills = listToolkitSkills({ skillsDir: dir })
    expect(skills.map((skill) => skill.id)).toEqual(['example-toolkit'])
  })

  it('目录不存在 → 空数组，不抛异常', () => {
    expect(listToolkitSkills({ skillsDir: path.join(os.tmpdir(), 'weworker-no-such-dir-xyz') })).toEqual([])
  })

  it('无 name 时用目录名/id 兜底', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'dir-name-fallback', { adapter_type: 'toolkit', allowed_domains: ['a.example.org'] })
    expect(listToolkitSkills({ skillsDir: dir })[0]).toMatchObject({ id: 'dir-name-fallback', name: 'dir-name-fallback' })
  })

  it('TTL 缓存：同一目录只扫一次，清缓存后重新扫', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'example-toolkit', TOOLKIT)
    expect(listToolkitSkills({ skillsDir: dir })).toHaveLength(1)

    writeSkill(dir, 'second-toolkit', {
      id: 'second-toolkit',
      adapter_type: 'toolkit',
      allowed_domains: ['other.example.org'],
    })
    // 缓存未过期：看不到新装的包（最长 TTL 后自动生效）。
    expect(listToolkitSkills({ skillsDir: dir })).toHaveLength(1)
    clearToolkitSkillsCache()
    expect(listToolkitSkills({ skillsDir: dir })).toHaveLength(2)
  })

  it('工具名缺失的条目被丢弃（无名工具无法调用）', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'example-toolkit', { ...TOOLKIT, tools: [{ description: '无名' }, { name: '' }, { name: 'ok' }] })
    expect(listToolkitSkills({ skillsDir: dir })[0].tools.map((tool) => tool.name)).toEqual(['ok'])
  })
})

describe('toolkitGateCandidates：并入 siteGate 候选', () => {
  it('产出 matchSiteAdapter 需要的最小形状（id/name/match）', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'example-toolkit', TOOLKIT)
    const skills = listToolkitSkills({ skillsDir: dir })
    expect(toolkitGateCandidates(skills)).toEqual([
      { id: 'example-toolkit', name: '示例站点工具包', match: ['shop.example.org'] },
    ])
  })
})

describe('resolveToolkitSkillPrompt：预注入清单', () => {
  it('复用站点速查格式，且工具被标为 direct 组', () => {
    const dir = tempSkillsDir()
    writeSkill(dir, 'example-toolkit', TOOLKIT)
    const [skill] = listToolkitSkills({ skillsDir: dir })

    const toolkit = resolveToolkitSkillPrompt(skill)
    expect(toolkit.total).toBe(2)
    expect(toolkit.toolCount).toBe(2)
    expect(toolkit.prompt).toContain('## 站点工具速查：示例站点工具包（shop.example.org）')
    expect(toolkit.prompt).toContain('**direct（API 后台工具')
    expect(toolkit.prompt).toContain('`example-toolkit.search`')
  })
})
