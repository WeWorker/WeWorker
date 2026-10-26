import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  acceptTerminalCompletion,
  completeTerminalCommand,
  getChatBangCompletionCandidates,
  getTerminalCommandCompletionCandidates,
  getTerminalCompletionCandidates,
  getTerminalHistoryCompletionCandidates,
  getWebcliCompletionCandidates,
  shouldUsePathCompletionForCommand,
} from '../utils/terminal-completion.js'

const root = 'C:\\Users\\fixture-user\\.weworker\\user-files'
const files = [
  { name: 'TestDev_new', path: `${root}\\TestDev_new`, is_directory: true },
  { name: 'WeWorker', path: `${root}\\WeWorker`, is_directory: true },
  { name: '目录摘要报告.txt', path: `${root}\\目录摘要报告.txt`, is_directory: false },
]

const sites = [
  {
    id: 'expense.example.com',
    name: 'ExpenseDemo费用管理示例',
    enabled: true,
    tools: [
      {
        name: 'expense.example.com.navigate_to_budget_request',
        description: '进入预算申请页面',
        parameters: [
          { name: 'amount', required: true },
          { name: 'remark', required: false },
        ],
      },
      {
        name: 'expense.example.com.wecli watch',
        description: '监听 ExpenseDemo 状态',
        parameters: [
          { name: 'target', required: true },
          { name: 'timeout', required: true },
        ],
      },
    ],
  },
  {
    id: 'ai-platform.example.com',
    name: 'ai-platform.example.com',
    enabled: true,
    tools: [
      {
        name: 'ai-platform.example.com.open_home',
        description: '打开首页',
      },
    ],
  },
]

describe('terminal path completion', () => {
  it('suggests shell commands while typing the command token', () => {
    assert.deepEqual(
      getTerminalCommandCompletionCandidates({ command: 'l', cursor: 1 }).slice(0, 1).map((item) => ({
        name: item.name,
        value: item.value,
        isDirectory: item.isDirectory,
        kind: item.kind,
      })),
      [{ name: 'ls', value: 'ls ', isDirectory: false, kind: 'cmd' }],
    )
  })

  it('suggests the built-in webcli command', () => {
    assert.deepEqual(
      getTerminalCommandCompletionCandidates({ command: 'web', cursor: 3 }).slice(0, 1),
      [{ name: 'webcli', value: 'webcli ', isDirectory: false, kind: 'cmd', description: 'WeWorker 网站工具命令' }],
    )
  })

  it('can list root shell commands for chat bang completion only when requested', () => {
    assert.deepEqual(getTerminalCommandCompletionCandidates({ command: '', cursor: 0 }), [])
    assert.deepEqual(
      getTerminalCommandCompletionCandidates({ command: '', cursor: 0, includeEmpty: true }).slice(0, 1).map((item) => item.name),
      ['webcli'],
    )
  })

  it('does not suggest commands while typing an argument token', () => {
    assert.deepEqual(
      getTerminalCommandCompletionCandidates({ command: 'ls T', cursor: 4 }),
      [],
    )
  })

  it('completes the current path token with Tab', () => {
    assert.deepEqual(
      completeTerminalCommand({ command: 'cd Tes', cursor: 6, cwd: root, root, files }),
      { command: 'cd TestDev_new/', cursor: 15, completed: true },
    )
  })

  it('keeps the command unchanged when there is no matching path', () => {
    assert.deepEqual(
      completeTerminalCommand({ command: 'cat missing', cursor: 11, cwd: root, root, files }),
      { command: 'cat missing', cursor: 11, completed: false },
    )
  })

  it('uses the common prefix when multiple paths match', () => {
    assert.deepEqual(
      completeTerminalCommand({
        command: 'ls Te',
        cursor: 5,
        cwd: root,
        root,
        files: [
          ...files,
          { name: 'TestReport.txt', path: `${root}\\TestReport.txt`, is_directory: false },
        ],
      }),
      { command: 'ls Test', cursor: 7, completed: true },
    )
  })

  it('lists matching completion candidates for the terminal prompt', () => {
    assert.deepEqual(
      getTerminalCompletionCandidates({
        command: 'ls Te',
        cursor: 5,
        cwd: root,
        root,
        files: [
          ...files,
          { name: 'TestReport.txt', path: `${root}\\TestReport.txt`, is_directory: false },
        ],
      }),
      [
        { name: 'TestDev_new', value: 'TestDev_new/', isDirectory: true },
        { name: 'TestReport.txt', value: 'TestReport.txt', isDirectory: false },
      ],
    )
  })

  it('accepts a selected completion candidate into the current token', () => {
    assert.deepEqual(
      acceptTerminalCompletion({
        command: 'ls T',
        cursor: 4,
        candidate: { value: 'TestDev_new/', isDirectory: true },
      }),
      { command: 'ls TestDev_new/', cursor: 15, completed: true },
    )
  })

  it('accepts a selected command completion and inserts a trailing space', () => {
    assert.deepEqual(
      acceptTerminalCompletion({
        command: 'l',
        cursor: 1,
        candidate: { value: 'ls ', kind: 'cmd' },
      }),
      { command: 'ls ', cursor: 3, completed: true },
    )
  })

  it('resolves chat bang candidates in command, argument, path, then history order', () => {
    assert.equal(getChatBangCompletionCandidates({
      command: 'g', cursor: 1, cwd: root, root, files, sessions: [],
    })[0].name, 'git')

    assert.equal(getChatBangCompletionCandidates({
      command: 'git ', cursor: 4, cwd: root, root, files, sessions: [],
    })[0].name, 'status')

    assert.deepEqual(getChatBangCompletionCandidates({
      command: 'cat Tes', cursor: 7, cwd: root, root, files, sessions: [],
    }), [
      { name: 'TestDev_new', value: 'TestDev_new/', isDirectory: true },
    ])

    assert.deepEqual(getChatBangCompletionCandidates({
      command: 'cat His',
      cursor: 7,
      cwd: root,
      root,
      files: [],
      sessions: [{ output: '-rw-r--r-- 1 user group 12 Aug 2 10:00 History.txt' }],
    }), [
      { name: 'History.txt', value: 'History.txt', isDirectory: false },
    ])
  })

  it('can force chat bang completion between command and file sources', () => {
    assert.deepEqual(getChatBangCompletionCandidates({
      command: 'cat ', cursor: 4, cwd: root, root, files, sessions: [], source: 'files',
    }).map((item) => item.name), ['TestDev_new', 'WeWorker', '目录摘要报告.txt'])

    assert.deepEqual(getChatBangCompletionCandidates({
      command: 'cat Tes', cursor: 7, cwd: root, root, files, sessions: [], source: 'commands',
    }), [])
  })

  it('quotes file candidates containing spaces and keeps directory quotes open', () => {
    const spacedFiles = [
      {
        name: 'My Folder',
        path: `${root}\\My Folder`,
        is_directory: true,
        children: [
          { name: 'Nested File.txt', path: `${root}\\My Folder\\Nested File.txt`, is_directory: false },
        ],
      },
      { name: 'My Report.txt', path: `${root}\\My Report.txt`, is_directory: false },
    ]
    assert.deepEqual(
      getTerminalCompletionCandidates({ command: 'cat My', cursor: 6, cwd: root, root, files: spacedFiles }),
      [
        { name: 'My Folder', value: '"My Folder/', isDirectory: true },
        { name: 'My Report.txt', value: '"My Report.txt"', isDirectory: false },
      ],
    )
    assert.deepEqual(
      getTerminalCompletionCandidates({ command: 'cat "My R', cursor: 9, cwd: root, root, files: spacedFiles }),
      [{ name: 'My Report.txt', value: '"My Report.txt"', isDirectory: false }],
    )
    assert.deepEqual(
      getTerminalCompletionCandidates({
        command: 'cat "My Folder/Nes', cursor: 18, cwd: root, root, files: spacedFiles,
      }),
      [{ name: 'Nested File.txt', value: '"My Folder/Nested File.txt"', isDirectory: false }],
    )
    assert.deepEqual(
      completeTerminalCommand({ command: 'cat "My Folder', cursor: 14, cwd: root, root, files: spacedFiles }),
      { command: 'cat "My Folder/', cursor: 15, completed: true },
    )
  })

  it('builds completion candidates from recent ls output', () => {
    assert.deepEqual(
      getTerminalHistoryCompletionCandidates({
        command: 'ls T',
        cursor: 4,
        sessions: [{
          output: [
            'total 77',
            'drwxr-xr-x 1 fixture-user 197609     0 Jul  7 18:38 TestDev_new',
            'drwxr-xr-x 1 fixture-user 197609     0 Jul  2 19:04 WeWorker',
            '-rwxr-xr-x 1 fixture-user 197609 68120 Jul  1 20:03 vfcompat.dll',
            '-rw-r--r-- 1 fixture-user 197609   545 Jul  2 10:29 目录摘要报告.txt',
          ].join('\n'),
        }],
      }),
      [
        { name: 'TestDev_new', value: 'TestDev_new/', isDirectory: true },
      ],
    )
  })

  it('shows file candidates after accepting a command and trailing space', () => {
    assert.deepEqual(
      getTerminalHistoryCompletionCandidates({
        command: 'cat ',
        cursor: 4,
        sessions: [{
          output: [
            'total 77',
            'drwxr-xr-x 1 fixture-user 197609     0 Jul  7 18:38 TestDev_new',
            'drwxr-xr-x 1 fixture-user 197609     0 Jul  2 19:04 WeWorker',
            '-rwxr-xr-x 1 fixture-user 197609 68120 Jul  1 20:03 vfcompat.dll',
            '-rw-r--r-- 1 fixture-user 197609   545 Jul  2 10:29 目录摘要报告.txt',
          ].join('\n'),
        }],
      }),
      [
        { name: 'TestDev_new', value: 'TestDev_new/', isDirectory: true },
        { name: 'WeWorker', value: 'WeWorker/', isDirectory: true },
        { name: '目录摘要报告.txt', value: '目录摘要报告.txt', isDirectory: false },
        { name: 'vfcompat.dll', value: 'vfcompat.dll', isDirectory: false },
      ],
    )
  })

  it('shows webcli commands after the webcli command token', () => {
    const candidates = getWebcliCompletionCandidates({ command: 'webcli ', cursor: 7 })

    assert.deepEqual(
      candidates.slice(0, 4).map((item) => ({ name: item.name, value: item.value, kind: item.kind })),
      [
        { name: 'call', value: 'call ', kind: 'subcommand' },
        { name: 'adapter', value: 'adapter ', kind: 'subcommand' },
        { name: 'service', value: 'service ', kind: 'subcommand' },
        { name: 'install --skills', value: 'install --skills ', kind: 'subcommand' },
      ],
    )
  })

  it('shows webcli service subcommands instead of path candidates', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli service ', cursor: 15 }).map((item) => item.name),
      ['start', 'stop', 'status', 'logs'],
    )
  })

  it('shows webcli adapter subcommands instead of path candidates', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli adapter ', cursor: 15 }).map((item) => item.name),
      ['list', 'info', 'skill', 'knowledge', 'skills-path', 'install', 'remove'],
    )
  })

  it('shows webcli call arguments and common tool names', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli call ', cursor: 12 }).map((item) => item.name).slice(0, 4),
      ['open_browser', 'click', 'input_text'],
    )
  })

  it('shows the latest --key=value parameter template after a webcli call tool', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({
        command: 'webcli call expense.example.com.navigate_to_budget_request ',
        cursor: 'webcli call expense.example.com.navigate_to_budget_request '.length,
        sites,
      }).map((item) => ({ name: item.name, value: item.value, kind: item.kind })),
      [
        {
          name: '--amount=<amount>',
          value: '--amount=<amount> ',
          kind: 'value',
        },
      ],
    )
  })

  it('shows parameter templates for multi-token webcli tool names', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({
        command: 'webcli call expense.example.com.wecli watch ',
        cursor: 'webcli call expense.example.com.wecli watch '.length,
        sites,
      }).map((item) => item.value),
      ['--target=<target> --timeout=<timeout> '],
    )
  })

  it('shows site tools for webcli call from loaded sites', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli call expense', cursor: 19, sites }).map((item) => ({
        name: item.name,
        value: item.value,
        kind: item.kind,
      })),
      [
        {
          name: 'expense.example.com.navigate_to_budget_request',
          value: 'expense.example.com.navigate_to_budget_request ',
          kind: 'tool',
        },
        {
          name: 'expense.example.com.wecli watch',
          value: 'expense.example.com.wecli watch ',
          kind: 'tool',
        },
      ],
    )
  })

  it('shows adapter ids for webcli adapter commands that need a site id', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli adapter info ', cursor: 20, sites }).map((item) => ({
        name: item.name,
        value: item.value,
        kind: item.kind,
      })),
      [
        { name: 'expense.example.com', value: 'expense.example.com ', kind: 'site' },
        { name: 'ai-platform.example.com', value: 'ai-platform.example.com ', kind: 'site' },
      ],
    )
  })

  it('shows adapter ids after webcli install --skills', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli install --skills ', cursor: 24, sites }).map((item) => item.name),
      ['expense.example.com', 'ai-platform.example.com'],
    )
  })

  it('shows java options without affecting other commands', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'java ', cursor: 5 }).map((item) => ({
        name: item.name,
        kind: item.kind,
      })).slice(0, 3),
      [
        { name: '-version', kind: 'option' },
        { name: '-jar', kind: 'option' },
        { name: '-cp', kind: 'option' },
      ],
    )
  })

  it('shows mvn options from its own command definition', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'mvn ', cursor: 4 }).map((item) => item.name).slice(0, 4),
      ['-v', '--version', 'clean', 'test'],
    )
  })

  it('shows git subcommands from its own command definition', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'git ', cursor: 4 }).map((item) => item.name).slice(0, 4),
      ['status', 'add', 'commit', 'checkout'],
    )
  })

  it('shows npm subcommands from its own command definition', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'npm ', cursor: 4 }).map((item) => item.name).slice(0, 4),
      ['install', 'run', 'test', 'build'],
    )
  })

  it('shows pnpm subcommands from its own command definition', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'pnpm ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['install', 'run', 'test', 'build'],
    )
  })

  it('shows yarn subcommands from its own command definition', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'yarn ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['install', 'run', 'test', 'build'],
    )
  })

  it('shows node and python runtime options', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'node ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['--version', '--eval', '--print', '--inspect'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'python ', cursor: 7 }).map((item) => item.name).slice(0, 4),
      ['--version', '-m', '-c', '-i'],
    )
  })

  it('shows pip, docker, kubectl, curl, and ssh common options', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'pip ', cursor: 4 }).map((item) => item.name).slice(0, 4),
      ['install', 'uninstall', 'list', 'show'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'docker ', cursor: 7 }).map((item) => item.name).slice(0, 4),
      ['ps', 'images', 'run', 'exec'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'kubectl ', cursor: 8 }).map((item) => item.name).slice(0, 4),
      ['get', 'describe', 'logs', 'exec'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'curl ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['-X', '-H', '-d', '-I'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'ssh ', cursor: 4 }).map((item) => item.name).slice(0, 4),
      ['-p', '-i', '-L', '-N'],
    )
  })

  it('shows common file command options from their own definitions', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'ls ', cursor: 3 }).map((item) => item.name).slice(0, 4),
      ['-la', '-lh', '-a', '-R'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'grep ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['-n', '-i', '-r', '-E'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'find ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['-name', '-type', '-maxdepth', '-exec'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'rm ', cursor: 3 }).map((item) => item.name).slice(0, 3),
      ['-r', '-f', '-i'],
    )
  })

  it('uses PowerShell options for PowerShell aliases instead of bash options', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'ls ', cursor: 3, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Force', '-Recurse', '-Name', '-File'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'rm ', cursor: 3, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Recurse', '-Force', '-Confirm', '-WhatIf'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'cat ', cursor: 4, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Raw', '-Tail', '-Wait', '-Encoding'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'cp ', cursor: 3, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Recurse', '-Force', '-Confirm', '-WhatIf'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'mv ', cursor: 3, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Force', '-Confirm', '-WhatIf', '-Destination'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'mkdir ', cursor: 6, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Force', '-ItemType', '-Path', '-Name'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'ps ', cursor: 3, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Name', '-Id', '-Module', '-FileVersionInfo'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'curl ', cursor: 5, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Uri', '-Method', '-Headers', '-Body'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'find ', cursor: 5, shell: 'powershell' }).map((item) => item.name).slice(0, 4),
      ['-Path', '-Filter', '-Recurse', '-File'],
    )
  })

  it('shows Windows and shell launcher command options', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'tasklist ', cursor: 9 }).map((item) => item.name).slice(0, 4),
      ['/fi', '/svc', '/v', '/fo'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'powershell ', cursor: 11 }).map((item) => item.name).slice(0, 4),
      ['-NoProfile', '-ExecutionPolicy', '-Command', '-File'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'bash ', cursor: 5 }).map((item) => item.name).slice(0, 3),
      ['-c', '-l', '-i'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'cmd ', cursor: 4 }).map((item) => item.name).slice(0, 2),
      ['/c', '/k'],
    )
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'pwsh ', cursor: 5 }).map((item) => item.name).slice(0, 4),
      ['-NoProfile', '-ExecutionPolicy', '-Command', '-File'],
    )
  })

  it('does not provide webcli candidates where a path argument is expected', () => {
    assert.deepEqual(
      getWebcliCompletionCandidates({ command: 'webcli adapter install --file ', cursor: 30 }),
      [],
    )
  })

  it('only falls back to path completion for webcli path arguments', () => {
    assert.equal(shouldUsePathCompletionForCommand({ command: 'webcli ', cursor: 7 }), false)
    assert.equal(shouldUsePathCompletionForCommand({ command: 'webcli adapter info ', cursor: 20 }), false)
    assert.equal(shouldUsePathCompletionForCommand({ command: 'webcli call open_browser --args ', cursor: 30 }), false)
    assert.equal(shouldUsePathCompletionForCommand({ command: 'webcli adapter install --file ', cursor: 30 }), true)
    assert.equal(shouldUsePathCompletionForCommand({ command: 'webcli adapter install --file "My F', cursor: 35 }), true)
  })

  it('keeps path completion available for regular registered shell commands', () => {
    assert.equal(shouldUsePathCompletionForCommand({ command: 'git add ', cursor: 8 }), true)
    assert.equal(shouldUsePathCompletionForCommand({ command: 'java -jar ', cursor: 10 }), true)
    assert.equal(shouldUsePathCompletionForCommand({ command: 'docker run ', cursor: 11 }), true)
  })
})
