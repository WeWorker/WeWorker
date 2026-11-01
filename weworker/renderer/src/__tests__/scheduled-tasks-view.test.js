import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { scheduledTasksPageState } from '../utils/scheduled-tasks-view.js'
import { useScheduledTasksStore } from '../store/scheduled-tasks.js'

const initialState = useScheduledTasksStore.getState()
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

test('failed rename or deletion leaves task data and selection intact', async () => {
  globalThis.window = {}
  const task = { id: 'example-task', title: 'Original task', enabled: true }
  useScheduledTasksStore.setState({ tasks: [task], activeTaskId: task.id, executions: { [task.id]: [{ id: 'example-run' }] } })
  globalThis.fetch = async () => Response.json({ error: 'Example rejection' }, { status: 500 })
  await assert.rejects(useScheduledTasksStore.getState().updateTask(task.id, { title: 'New title' }), /Example rejection/)
  await assert.rejects(useScheduledTasksStore.getState().deleteTask(task.id), /Example rejection/)
  assert.deepEqual(useScheduledTasksStore.getState().tasks, [task])
  assert.equal(useScheduledTasksStore.getState().activeTaskId, task.id)
  assert.equal(useScheduledTasksStore.getState().executions[task.id].length, 1)
})

test('rename patches only the title and deletion clears only the target task', async () => {
  globalThis.window = {}
  const tasks = [{ id: 'example-one', title: 'One', enabled: true }, { id: 'example-two', title: 'Two' }]
  useScheduledTasksStore.setState({ tasks, activeTaskId: tasks[0].id, executions: { 'example-one': [], 'example-two': [] } })
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { title: 'Renamed' })
    return Response.json({ ...tasks[0], title: 'Renamed' })
  }
  await useScheduledTasksStore.getState().updateTask(tasks[0].id, { title: 'Renamed' })
  assert.equal(useScheduledTasksStore.getState().tasks[0].enabled, true)
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'DELETE')
    return new Response(null, { status: 204 })
  }
  await useScheduledTasksStore.getState().deleteTask(tasks[0].id)
  assert.deepEqual(useScheduledTasksStore.getState().tasks, [tasks[1]])
  assert.equal(useScheduledTasksStore.getState().activeTaskId, null)
  assert.deepEqual(useScheduledTasksStore.getState().executions, { 'example-two': [] })
})

test('the sidebar switch PATCHes the requested state and failed updates preserve the current state', async () => {
  const source = fs.readFileSync(new URL('../components/sidebar/ScheduledTasksList.jsx', import.meta.url), 'utf8')
  assert.match(source, /<AppSwitch[\s\S]*?checked=\{Boolean\(task\.enabled\)\}[\s\S]*?onChange=\{toggleEnabled\}/)
  assert.match(source, /aria-label=\{`\$\{task\.enabled \? '关闭' : '启用'\}定时任务 \$\{title\}`\}/)
  assert.match(source, /className="sidebar-row-actions"[\s\S]*?onClick=\{\(event\) => event\.stopPropagation\(\)\}[\s\S]*?<AppSwitch/)
  assert.match(source, /await updateTask\(task\.id, \{ enabled: event\.target\.checked \}\)/)

  const task = { id: 'example-toggle', title: 'Example schedule', enabled: true }
  globalThis.window = {}
  useScheduledTasksStore.setState({ tasks: [task] })
  globalThis.fetch = async (url, options) => {
    assert.match(url, /\/scheduled-tasks\/example-toggle$/)
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { enabled: false })
    return Response.json({ ...task, enabled: false })
  }

  await useScheduledTasksStore.getState().updateTask(task.id, { enabled: false })
  assert.equal(useScheduledTasksStore.getState().tasks[0].enabled, false)

  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'PATCH')
    assert.deepEqual(JSON.parse(options.body), { enabled: true })
    return Response.json({ error: 'Example rejection' }, { status: 500 })
  }

  await assert.rejects(useScheduledTasksStore.getState().updateTask(task.id, { enabled: true }), /Example rejection/)
  assert.deepEqual(useScheduledTasksStore.getState().tasks, [{ ...task, enabled: false }])
})

test('creating a task from the sidebar requests an enabled schedule', async () => {
  const source = fs.readFileSync(new URL('../components/layout/Sidebar.jsx', import.meta.url), 'utf8')
  const start = source.indexOf('const handleCreateTask =')
  const end = source.indexOf('const handleCreateWork =', start)
  assert.ok(start >= 0 && end > start)
  let requestedTask
  const pageStore = { getState: () => ({ closePage() {} }) }
  const context = vm.createContext({
    leaveWebsiteExploration: async () => true,
    useExplorationPageStore: pageStore,
    useToolPackagePageStore: pageStore,
    createTask: async (task) => { requestedTask = task; return { id: 'task-example', ...task } },
    showAlert: (message) => assert.fail(message),
  })

  await vm.runInContext(`${source.slice(start, end)}\nhandleCreateTask()`, context)
  assert.equal(requestedTask.enabled, true)
  assert.equal(requestedTask.cron_expression, '0 * * * *')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  useScheduledTasksStore.setState(initialState, true)
})

test('the scheduled tasks section has its own loading, empty, error and task states', () => {
  assert.equal(scheduledTasksPageState('tasks', null, 'idle'), 'loading')
  assert.equal(scheduledTasksPageState('tasks', null, 'loading'), 'loading')
  assert.equal(scheduledTasksPageState('tasks', null, 'ready'), 'empty')
  assert.equal(scheduledTasksPageState('tasks', null, 'error'), 'error')
  assert.equal(scheduledTasksPageState('tasks', 'task-1', 'ready'), 'task')
})

test('other sidebar sections do not render a scheduled tasks page', () => {
  assert.equal(scheduledTasksPageState('conversation', null, 'ready'), 'none')
  assert.equal(scheduledTasksPageState('conversation', 'task-1', 'ready'), 'none')
})

test('task loading remains pending until the response arrives and preserves selection', async () => {
  globalThis.window = {}
  let respond
  globalThis.fetch = () => new Promise(resolve => { respond = resolve })
  useScheduledTasksStore.setState({ activeTaskId: 'task-1' })
  const pending = useScheduledTasksStore.getState().loadTasks()
  assert.equal(useScheduledTasksStore.getState().tasksStatus, 'loading')
  await new Promise(resolve => setImmediate(resolve))
  respond(Response.json({ tasks: [{ id: 'task-1', title: 'Example schedule' }] }))
  await pending
  assert.equal(useScheduledTasksStore.getState().tasksStatus, 'ready')
  assert.equal(useScheduledTasksStore.getState().tasks[0].id, 'task-1')
  assert.equal(useScheduledTasksStore.getState().activeTaskId, 'task-1')
})

test('failed requests become a retryable error instead of an empty list or unhandled rejection', async () => {
  globalThis.window = {}
  for (const response of [
    async () => Response.json({}, { status: 503 }),
    async () => { throw new Error('Example offline error') },
  ]) {
    globalThis.fetch = response
    await useScheduledTasksStore.getState().loadTasks()
    assert.equal(useScheduledTasksStore.getState().tasksStatus, 'error')
  }
  globalThis.fetch = async () => Response.json({ tasks: [] })
  await useScheduledTasksStore.getState().loadTasks()
  assert.equal(useScheduledTasksStore.getState().tasksStatus, 'ready')
  assert.deepEqual(useScheduledTasksStore.getState().tasks, [])
})
