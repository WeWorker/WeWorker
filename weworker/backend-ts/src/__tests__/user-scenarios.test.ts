import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ParsedAdapter } from '../adapter-parser.js'
import {
  getUserScenariosForSite,
  mergeOfficialAndUserScenarios,
  migrateLegacyScenarioStore,
  resetUserScenario,
  saveUserScenario,
} from '../user-scenarios.js'

function mockAdapter(): ParsedAdapter {
  return {
    id: 'mail.163.com',
    name: '网易邮箱',
    description: '公开邮箱示例',
    detailDescription: '',
    match: ['mail.163.com'],
    gateAliases: [],
    homepageUrl: 'https://mail.163.com/',
    tools: [],
    testPrompts: [],
    requiresAuth: true,
    authCheckTool: null,
    hidden: false,
    defaultEnabled: true,
    registryScenarios: [
      {
        id: 'search-mail',
        title: '搜索邮件',
        summary: '新版官方说明',
        prompts: [{ text: '搜索邮件${关键词}' }],
      },
      {
        id: 'download-attachment',
        title: '下载附件',
        summary: '下载邮件附件',
        prompts: [{ text: '下载邮件附件' }],
      },
    ],
    icon: 'ticket',
    promptVarDisplay: {},
  }
}

describe('user scenario overrides', () => {
  let tempDir: string
  let scenariosFile: string
  let adapters: Map<string, ParsedAdapter>

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-scenarios-'))
    scenariosFile = path.join(tempDir, 'scenarios.json')
    process.env.WEWORKER_SCENARIOS_FILE = scenariosFile
    adapters = new Map([['mail.163.com', mockAdapter()]])
  })

  afterEach(() => {
    delete process.env.WEWORKER_SCENARIOS_FILE
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('removes previous official titles during the one-time version-1 migration', () => {
    const migrated = migrateLegacyScenarioStore({
      version: 1,
      sites: {
        'mail.163.com': [
          { id: 'legacy-mail', title: '读取邮件列表', summary: '旧系统场景' },
          { id: 'custom-mail', title: '我的邮件入口', summary: '用户场景' },
        ],
      },
    })

    expect(migrated).toEqual({
      version: 2,
      sites: {
        'mail.163.com': [
          { id: 'custom-mail', title: '我的邮件入口', summary: '用户场景' },
        ],
      },
    })
  })

  it('uses a user scenario as a full override and preserves user-only scenarios', () => {
    const merged = mergeOfficialAndUserScenarios(
      mockAdapter().registryScenarios,
      [
        { id: 'search-mail', title: '我的处理入口', summary: '用户完整覆盖' },
        { id: 'removed-official', title: '保留的旧场景', summary: '用户修改过' },
      ],
    )

    expect(merged.map((scenario) => scenario.id)).toEqual([
      'search-mail',
      'download-attachment',
      'removed-official',
    ])
    expect(merged[0]).toMatchObject({ title: '我的处理入口', summary: '用户完整覆盖' })
    expect(merged[2]).toMatchObject({ title: '保留的旧场景' })
  })

  it('reads official scenarios without copying them into the user file', () => {
    const scenarios = getUserScenariosForSite(adapters, 'mail.163.com')

    expect(scenarios.map((scenario) => scenario.id)).toEqual(['search-mail', 'download-attachment'])
    expect(fs.existsSync(scenariosFile)).toBe(false)
  })

  it('stores only edited overrides and removes them on full reset', () => {
    const saved = saveUserScenario(adapters, 'mail.163.com', 'search-mail', {
      title: '我的处理入口',
    })
    const stored = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'))

    expect(saved?.title).toBe('我的处理入口')
    expect(stored.version).toBe(2)
    expect(stored.sites['mail.163.com']).toHaveLength(1)
    expect(getUserScenariosForSite(adapters, 'mail.163.com')[0].title).toBe('我的处理入口')

    const restored = resetUserScenario(adapters, 'mail.163.com', 'search-mail')
    const resetStore = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'))
    expect(restored?.title).toBe('搜索邮件')
    expect(resetStore.sites['mail.163.com']).toBeUndefined()
  })

  it('migrates a legacy file before returning the current official scenarios', () => {
    fs.writeFileSync(scenariosFile, JSON.stringify({
      version: 1,
      sites: {
        'mail.163.com': [
          { id: 'legacy-mail', title: '读取邮件列表', summary: '旧系统场景' },
          { id: 'custom-mail', title: '我的邮件入口', summary: '用户场景' },
        ],
      },
    }))

    const scenarios = getUserScenariosForSite(adapters, 'mail.163.com')
    const stored = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'))

    expect(stored.version).toBe(2)
    expect(stored.sites['mail.163.com'].map((scenario: { id: string }) => scenario.id)).toEqual(['custom-mail'])
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'search-mail',
      'download-attachment',
      'custom-mail',
    ])
  })
})
