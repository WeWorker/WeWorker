import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { useWorksStore } from '../store/works.js'

const NL = String.fromCharCode(10)
function read(relative) { return readFileSync(new URL(relative, import.meta.url), 'utf8') }
function loadFunctions(source, names, context = {}) {
  const scope = vm.createContext(context)
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`)
    assert.ok(start >= 0, `Missing function ${name}`)
    const end = source.indexOf(NL + '}', start) + 2
    vm.runInContext(source.slice(start, end), scope)
  }
  return scope
}

test('D10 broadcasts fallback and generated titles and applies global title events', async () => {
  const backend = read('../../../backend-ts/src/server.ts')
  assert.match(backend, /broadcastSSE\(\{ type: 'title_update', title, workId \}\)/)
  assert.match(backend, /broadcastSSE\(\{ type: 'title_update', title: llmTitle, workId \}\)/)

  const before = useWorksStore.getState()
  try {
    useWorksStore.setState({ works: [{ id: 'fixture-a', title: '' }] })
    const source = read('../App.jsx')
    const start = source.indexOf('    const handleEvent = (data) => {')
    const end = source.indexOf('    const connect = () => {', start)
    const scope = vm.createContext({ useWorksStore })
    vm.runInContext(source.slice(start, end) + NL + 'globalThis.receive = handleEvent', scope)
    scope.receive(JSON.stringify({ type: 'title_update', workId: 'fixture-a', title: '模型生成标题' }))
    assert.equal(useWorksStore.getState().works[0].title, '模型生成标题')
  } finally {
    useWorksStore.setState(before, true)
  }
})

const scheduleSource = read('../utils/scheduled-task-schedule.js').replace(/^export /gm, '')
const schedule = loadFunctions(scheduleSource, ['buildCron', 'parseCron', 'getNextRuns'])
for (const [fields, expected] of [
  [{ frequency: 'daily', hour: 0, minute: 0 }, '0 0 * * *'],
  [{ frequency: 'weekly', hour: 0, minute: 0, weekday: '1' }, '0 0 * * 1'],
  [{ frequency: 'weekly', hour: 0, minute: 0, weekday: 0 }, '0 0 * * 0'],
]) {
  test(`D11 schedule preserves ${expected}`, () => {
    assert.equal(schedule.buildCron(fields), expected)
    assert.equal(schedule.buildCron(schedule.parseCron(expected)), expected)
    assert.equal(schedule.getNextRuns(fields, 1)[0].getHours(), 0)
    if (fields.frequency === 'weekly') assert.equal(schedule.getNextRuns(fields, 1)[0].getDay(), Number(fields.weekday))
  })
}

function renameFixture(resources, markdown, oldPath, newName) {
  const source = read('../components/welcome/ToolPackageEditor.jsx')
  const names = ['formatSkillResourcePath', 'buildResourceHint', 'normalizeResourcePath', 'existingResourcePaths', 'joinResourcePath', 'resolveRenamedResourcePath', 'renameResourceEntry', 'renameResourceHints']
  let patch
  const scope = loadFunctions(source, names, {
    resources, storedMarkdown: markdown, tool: { name: 'fixture-skill' }, expandedPath: oldPath,
    setRenamingPath() {}, setExpandedPath() {}, onChange(value) { patch = value },
  })
  const start = source.indexOf('  const handleRenameResource = (oldPath, newName) => {')
  const end = source.indexOf('  const handleCreateFolder = ', start)
  vm.runInContext(source.slice(start, end) + NL + 'globalThis.rename = handleRenameResource', scope)
  scope.rename(oldPath, newName)
  return patch
}

test('D12 renames generated file references with their resource', () => {
  const markdown = ['# 测试技能', '', '本技能所需文件 `untitled.txt` 的路径为 `{{skill.path}}/untitled.txt`。'].join(NL)
  const patch = renameFixture([{ name: 'untitled.txt', relativePath: 'untitled.txt', content: 'fixture' }], markdown, 'untitled.txt', '中文资源.txt')
  assert.equal(patch.resources[0].relativePath, '中文资源.txt')
  assert.equal(patch.markdown, ['# 测试技能', '', '本技能所需文件 `中文资源.txt` 的路径为 `{{skill.path}}/中文资源.txt`。'].join(NL))
})

test('D12 folder rename changes descendant hints but not user prose or unrelated paths', () => {
  const markdown = ['用户说明：old/data.txt', '本技能所需文件 `data.txt` 的路径为 `{{skill.path}}/old/data.txt`。', '本技能所需文件 `data.txt` 的路径为 `{{skill.path}}/other/data.txt`。'].join(NL)
  const patch = renameFixture([{ relativePath: 'old', is_directory: true }, { relativePath: 'old/data.txt' }, { relativePath: 'other/data.txt' }], markdown, 'old', '新目录')
  assert.equal(patch.markdown, ['用户说明：old/data.txt', '本技能所需文件 `data.txt` 的路径为 `{{skill.path}}/新目录/data.txt`。', '本技能所需文件 `data.txt` 的路径为 `{{skill.path}}/other/data.txt`。'].join(NL))
})
