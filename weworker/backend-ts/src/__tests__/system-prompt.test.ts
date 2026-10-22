// Unit tests for system prompt changes (Req 4.1-4.4)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ParsedAdapter } from '../adapter-parser.js'

// --- Test adapter fixtures ---

function makeAdapter(overrides: Partial<ParsedAdapter> = {}): ParsedAdapter {
  return {
    id: 'jd_com',
    name: '京东',
    description: '京东：导航主页、查看购物车、查看订单、购买商品、支付',
    match: ['jd.com'],
    gateAliases: [],
    homepageUrl: 'https://www.jd.com/',
    tools: [
      {
        name: 'jd.com.search_products',
        description: '搜索京东商品',
        parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
      },
      {
        name: 'jd.com.view_cart',
        description: '查看购物车',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    testPrompts: [],
    requiresAuth: false,
    authCheckTool: null,
    hidden: false,
    defaultEnabled: true,
    detailDescription: '',
    registryScenarios: [],
    icon: 'globe',
    promptVarDisplay: {},
    ...overrides,
  }
}

function makeAuthAdapter(overrides: Partial<ParsedAdapter> = {}): ParsedAdapter {
  return makeAdapter({
    id: 'mail_163_com',
    name: '网易邮箱',
    description: '网易邮箱：收发邮件',
    match: ['mail.163.com'],
    homepageUrl: 'https://mail.163.com/',
    requiresAuth: true,
    authCheckTool: 'mail.163.com.check_login_status',
    tools: [
      {
        name: 'mail.163.com.check_login_status',
        description: '检查登录状态',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'mail.163.com.send_email',
        description: '发送邮件',
        parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      },
    ],
    ...overrides,
  })
}
// --- Mocks ---

// Mock parseAllAdapters to return controlled test data
const mockAdapterMap = new Map<string, ParsedAdapter>()

vi.mock('../adapter-parser.js', () => ({
  parseAllAdapters: () => mockAdapterMap,
}))

// Mock getSiteEnabled to control which adapters are "enabled"
const enabledSites = new Set<string>()

vi.mock('../config.js', () => ({
  getSiteEnabled: (id: string) => enabledSites.has(id),
  getUserDirectory: () => 'C:\\Users\\test\\.weworker\\user-files',
  getUserDirectoryBlacklist: () => [],
}))

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// --- Import the function under test (after mocks are set up) ---
// buildSystemPrompt is not exported, so we need to access it indirectly.
// We'll import the module and extract it via a helper approach.
// Since buildSystemPrompt is a private function, we test it through the module internals.

// Actually, buildSystemPrompt is a module-level function (not exported).
// We need to either export it for testing or test it through streamChat.
// Let's check if we can access it 鈥?if not, we'll need a different approach.

// The cleanest approach: dynamically import agent.ts and extract buildSystemPrompt.
// Since it's not exported, we'll use a workaround: mock the dependencies and
// call the function through a re-export or by reading the prompt from streamChat setup.

// Alternative: We can test the prompt content by importing the module and
// checking what buildSystemPrompt produces. Let's add a test export.

// For now, let's use a pragmatic approach: import the module and test the
// buildSystemPrompt function. We need to make it accessible.
// The simplest way is to re-export it for testing.

// Let's check if there's a way to access it...
// Looking at agent.ts, buildSystemPrompt() is called inside streamChat().
// We can't easily extract just the prompt without running streamChat.
// The best approach is to export buildSystemPrompt for testing.

// We'll add a named export. But first, let's write the tests assuming
// buildSystemPrompt is exported (task 4.1 already modified agent.ts).

describe('System Prompt - webcli call instructions (Req 4.1)', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('contains webcli call usage instructions', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('webcli call')
  })

  it('contains full tool name and direct flag instructions', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('使用完整工具名称')
    expect(prompt).toContain('--key=value')
  })

  it('contains example tool name format with dots', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    // Should show dotted tool name format example
    expect(prompt).toContain('jd.com.search_products')
  })
})

describe('System Prompt - Skill activation instructions (Req 4.2)', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('reuses available Skill instructions and only reloads missing or invalid instructions', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    // Should mention activating Skills
    expect(prompt).toContain('Skill')
    // Should instruct to use Skill documentation for tool names/args
    expect(prompt).toContain('优先使用当前上下文已有的 Skill 说明和工具参数')
    expect(prompt).toContain('相关说明缺失、不完整或已失效时，再激活对应 Skill')
    expect(prompt).toContain('不要为寻找同一缺失信息重复读取同一版本的说明')
    expect(prompt).not.toContain('当用户提到某个网站时，你应该激活对应的 Skill')
  })

  it('instructs to use tool names and args from Skill documentation', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    // Should reference Skill documentation as the source for tool info
    expect(prompt).toContain('Skill')
    expect(prompt).toContain('webcli call')
  })
})

describe('System Prompt - behavioral rules retained (Req 4.3)', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('retains open_browser 5-second wait rule', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('open_browser')
    expect(prompt).toContain('5')
    // Check for the wait instruction in Chinese
    expect(prompt).toMatch(/等待至少 5 秒/)
  })

  it('uses API type metadata for planning and direct mode for runtime routing', async () => {
    const itsmAdapter = makeAuthAdapter({
      id: 'itsm.example.com',
      match: ['itsm.example.com'],
      toolExecution: {
        'itsm.example.com.ls': { type: 'api', runtime: 'background' },
      },
    })
    mockAdapterMap.set(itsmAdapter.id, itsmAdapter)
    enabledSites.add(itsmAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('type=api, runtime=background')
    expect(prompt).toContain('mode=direct')
    expect(prompt).toContain('无需先打开业务页或检测页面登录')
  })

  it('retains ask_user rules and forbids AskUserQuestion', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('ask_user')
    expect(prompt).toMatch(/AskUserQuestion/)
    expect(prompt).toMatch(/禁止调用内置工具/)
  })

  it('does not require assistant replies to append a current-status line', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).not.toContain('当前状态回复规则')
    expect(prompt).not.toContain('每次回复都要写')
    expect(prompt).not.toContain('当前状态：<简短状态>')
  })

  it('requires TodoWrite when todo state changes', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('TodoWrite')
    expect(prompt).toContain('完整最新列表')
    expect(prompt).toContain('completed')
    expect(prompt).toContain('已完成 todo 不可修改、删除或回退状态')
    expect(prompt).not.toContain('todo_patch')
    expect(prompt).not.toContain('complex_task_plan')
  })

  it('retains retry limits (max 2 retries / 3 total calls)', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    // Should mention retry limits: "鏈€澶氶噸璇?2 娆? or "鎬诲叡璋冪敤涓嶈秴杩?3 娆?
    expect(prompt).toMatch(/最多重试 2 次|不超过 3 次/)
  })
})

describe('System Prompt - no per-adapter tool lists (Req 4.4)', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('does NOT contain individual adapter tool names in a supported sites list', async () => {
    const jdAdapter = makeAdapter()
    const mailAdapter = makeAuthAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    mockAdapterMap.set(mailAdapter.id, mailAdapter)
    enabledSites.add(jdAdapter.id)
    enabledSites.add(mailAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    // The prompt should NOT contain a "supported websites" enumeration
    // with individual tool names like "jd.com.view_cart" listed as separate tools.
    // The example "jd.com.search_products" may appear as an example format, which is fine.
    // But there should be no per-adapter tool listing section.

    // Verify no "supportedList" style enumeration exists
    // (the old code had a supportedList variable with adapter names/descriptions/URLs)
    expect(prompt).not.toContain('支持的网站列表')
  })

  it('leaves login to WeWorker instead of asking the model to pre-check it', async () => {
    const authAdapterNoCheck = makeAuthAdapter({
      id: 'custom_auth',
      name: '自定义认证站',
      match: ['custom-auth.com'],
      requiresAuth: true,
      authCheckTool: null,
      tools: [
        {
          name: 'custom-auth.com.do_something',
          description: '执行操作',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      ],
    })
    mockAdapterMap.set(authAdapterNoCheck.id, authAdapterNoCheck)
    enabledSites.add(authAdapterNoCheck.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('网站工具会自动处理登录')
    expect(prompt).toContain('AUTH_REQUIRED')
    expect(prompt).not.toContain('custom_auth.check_login_status')
    expect(prompt).not.toMatch(/logged_in: false/)
  })

  it('asks the user to sign in inside WeWorker browser when it serves Adapter calls', async () => {
    const mailAdapter = makeAuthAdapter()
    mockAdapterMap.set(mailAdapter.id, mailAdapter)
    enabledSites.add(mailAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const dedicated = buildSystemPrompt({ browserInstance: 'dedicated' })
    expect(dedicated).toContain('WeWorker 浏览器')
    expect(dedicated).toContain('不要让用户去自己的 Chrome 登录')
    const own = buildSystemPrompt({ browserInstance: 'system' })
    expect(own).toContain('在浏览器中打开该网站的登录页')
    expect(own).not.toContain('WeWorker 浏览器')
  })

  it('does not include disabled auth adapters in login detection rules', async () => {
    const mailAdapter = makeAuthAdapter()
    mockAdapterMap.set(mailAdapter.id, mailAdapter)
    // NOT adding to enabledSites 鈥?adapter is disabled

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    // Should NOT contain the disabled adapter's info
    expect(prompt).not.toContain('网易邮箱')
    expect(prompt).not.toContain('mail.163.com.check_login_status')
  })
})

describe('System Prompt - file access scope', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('includes file access scope section with user directory path', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('## 文件访问范围')
    expect(prompt).toContain('C:\\Users\\test\\.weworker\\user-files')
    expect(prompt).toContain('原生文件工具、WeWorker Shell 和带路径参数的 MCP 工具只能访问用户目录')
  })
})

describe('System Prompt - file encryption rules', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('includes file encryption workflow on Windows', async () => {
    if (process.platform !== 'win32') return

    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('## 文件加密处理规则')
    expect(prompt).toContain('check_file_encryption')
    expect(prompt).toContain('decrypt_file')
    expect(prompt).toMatch(/必须先调用.*check_file_encryption/)
    expect(prompt).toMatch(/encrypted.*decrypt_file/s)
    expect(prompt).toMatch(/加密检查失败/)
    expect(prompt).toMatch(/sd_decrypt\.exe/)
    expect(prompt).toMatch(/非 OA 环境/)
    expect(prompt).toMatch(/不要阻塞或等待用户确认/)
  })

  it('omits file encryption workflow on non-Windows platforms', async () => {
    if (process.platform === 'win32') return

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).not.toContain('## 文件加密处理规则')
  })
})

describe('System Prompt - channel permission modes', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('qa_only prompt forbids webcli and bash automation', async () => {
    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt({ channelPermissionMode: 'qa_only' })

    expect(prompt).toContain('仅有问答权限')
    expect(prompt).toContain('不能操作网站、调用 webcli')
    expect(prompt).toContain('不要调用 Skill、Bash、PowerShell 或任何工具')
    expect(prompt).not.toContain('webcli_call')
  })

  it('no_bash prompt disables Adapter execution with native or WeWorker Shell', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt({ channelPermissionMode: 'no_bash' })

    expect(prompt).not.toContain('webcli_call')
    expect(prompt).toContain('原生命令工具限制')
    expect(prompt).toContain('不要调用 Claude Code 内置 Bash 或 PowerShell')
    expect(prompt).toContain('当前权限模式不能执行 Extension Adapter 或 Toolkit Adapter')
    expect(prompt).toContain('严禁用 `weworker_powershell` 调用 webcli')
    expect(prompt).not.toMatch(/璇峰嬁灏濊瘯鎵撳紑娴忚鍣ㄦ垨鎿嶄綔缃戠珯/)
  })

  it('full prompt runs both Adapter types through the native shell and webcli', async () => {
    const jdAdapter = makeAdapter()
    mockAdapterMap.set(jdAdapter.id, jdAdapter)
    enabledSites.add(jdAdapter.id)

    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).not.toContain('webcli_call')
    const nativeShell = process.platform === 'win32' ? 'PowerShell' : 'Bash'
    expect(prompt).toContain(`Claude Code 内置 ${nativeShell} 已开放`)
    expect(prompt).toContain('不受 WeWorker 用户目录白名单、黑名单、绝对路径或命令类型限制')
    expect(prompt).toContain('webcli call <完整工具名> --参数名=参数值')
    expect(prompt).toContain('Extension Adapter 或 Toolkit Adapter')
    expect(prompt).toContain('Chrome 扩展 Bridge 或内嵌 Toolkit Runtime')
    expect(prompt).toContain('WeWorker Shell')
    expect(prompt).toContain(`必须使用 Claude Code 内置 ${nativeShell}`)
    expect(prompt).toContain('不得使用 `weworker_powershell`')
    expect(prompt).not.toContain(`不要调用 Claude Code 内置 ${nativeShell}`)
  })

  it('uses native PowerShell throughout the Windows full prompt', async () => {
    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt({ channelPermissionMode: 'full', platform: 'win32' })

    expect(prompt).toContain('Claude Code 内置 PowerShell 已开放')
    expect(prompt).toContain('必须使用 Claude Code 内置 PowerShell')
    expect(prompt).toContain('当前平台默认 Shell（powershell）')
    expect(prompt).not.toContain('Claude Code 内置 Bash 已开放')
  })
})

describe('System Prompt - file encoding rules', () => {
  beforeEach(() => {
    mockAdapterMap.clear()
    enabledSites.clear()
  })

  it('includes UTF-8 first and platform-specific fallback encodings', async () => {
    const { buildSystemPrompt } = await import('../agent.js')
    const prompt = buildSystemPrompt()

    expect(prompt).toContain('## 文件读取编码规则')
    expect(prompt).toMatch(/默认首选 UTF-8/)
    expect(prompt).toContain('gbk')
    expect(prompt).toContain('macintosh')
    expect(prompt).toContain('latin1')
    expect(prompt).toContain('big5')
    expect(prompt).toMatch(/乱码/)
  })
})


describe('shared exploration guidance', () => {
  it('uses the shared CLI and Skill in full mode and preserves restricted modes', async () => {
    const { buildSystemPrompt } = await import('../agent.js')
    const full = buildSystemPrompt({ channelPermissionMode: 'full' })
    expect(full).toContain('webcli skills read webcli-api-exploration')
    expect(full).toContain('collecting/validating 只是运行中')
    expect(full).toContain('exploration.cancel')
    expect(full).toContain('客户端模型凭据仅用于模型连接')
    expect(full).toContain('不得为注入凭据而重启 Bridge')
    expect(full).toContain('不要求同时具有 `mode=direct`')
    expect(full).not.toContain('对于没有对应 Skill 的网站，你没有操作能力')
    for (const mode of ['qa_only', 'no_bash'] as const) {
      const restricted = buildSystemPrompt({ channelPermissionMode: mode })
      expect(restricted).not.toContain('webcli skills read webcli-api-exploration')
    }
  })
})
