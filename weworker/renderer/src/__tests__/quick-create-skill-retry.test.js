import test from 'node:test'
import assert from 'node:assert/strict'
import { createTemplateSkill, stripSkillFrontmatter } from '../components/dedicated-agents/quick-create/skill-retry.js'

const MARKDOWN = [
  '---',
  'name: invoice-self-check-helper',
  'description: fixture',
  '---',
  '',
  '# 发票自查助手',
  '',
  '- 复查范围：2024 年至今。',
].join('\n')

/** 模拟后端落盘形态：frontmatter name 被强制改写为实际目录名，并补 allowed-tools。 */
const storedForm = (name) => [
  '---',
  `name: ${name}`,
  'description: fixture',
  'allowed-tools: Bash(webcli call *)',
  '---',
  '',
  '# 发票自查助手',
  '',
  '- 复查范围：2024 年至今。',
].join('\n')

/** 内容确实不同：模拟用户改了答案后有意再建一个。 */
const storedFormDifferent = (name) => storedForm(name) + '\n- 新增的复查范围。'

test('stripSkillFrontmatter ignores the header the backend rewrites', () => {
  assert.equal(stripSkillFrontmatter(storedForm('invoice-self-check-helper-3')), stripSkillFrontmatter(MARKDOWN))
  assert.equal(stripSkillFrontmatter('---\nname: a\n---\n正文'), '正文')
  assert.equal(stripSkillFrontmatter('没有 frontmatter 的正文'), '没有 frontmatter 的正文')
})

test('reuses an existing skill with identical body instead of suffixing a new one', async () => {
  const created = []
  const result = await createTemplateSkill({
    baseName: 'invoice-self-check-helper',
    markdown: MARKDOWN,
    createSkill: async (name) => { created.push(name); throw new Error(`Skill「${name}」已存在，请换一个名称`) },
    fetchSkill: async (name) => ({ name, markdown: storedForm(name) }),
  })
  assert.equal(result.name, 'invoice-self-check-helper')
  assert.deepEqual(created, ['invoice-self-check-helper'])
})

test('falls back to suffixed names when the existing skill body differs', async () => {
  const created = []
  const result = await createTemplateSkill({
    baseName: 'invoice-self-check-helper',
    markdown: MARKDOWN,
    createSkill: async (name) => {
      created.push(name)
      if (name === 'invoice-self-check-helper') throw new Error(`Skill「${name}」已存在，请换一个名称`)
      return { name }
    },
    fetchSkill: async (name) => ({ name, markdown: storedFormDifferent(name) }),
  })
  assert.equal(result.name, 'invoice-self-check-helper-2')
  assert.deepEqual(created, ['invoice-self-check-helper', 'invoice-self-check-helper-2'])
})

test('rethrows the conflict after exhausting suffix attempts', async () => {
  await assert.rejects(createTemplateSkill({
    baseName: 'invoice-self-check-helper',
    markdown: MARKDOWN,
    createSkill: async (name) => { throw new Error(`Skill「${name}」已存在，请换一个名称`) },
    fetchSkill: async (name) => ({ name, markdown: storedForm(name) + '\n不同内容' }),
    maxAttempts: 3,
  }), /invoice-self-check-helper-3.*已存在/)
})

test('non-conflict failures surface immediately without retry', async () => {
  const created = []
  await assert.rejects(createTemplateSkill({
    baseName: 'invoice-self-check-helper',
    markdown: MARKDOWN,
    createSkill: async (name) => { created.push(name); throw new Error('无法连接 WeWorker 后端，请等待服务启动后重试') },
    fetchSkill: async () => { throw new Error('不应读取 Skill') },
  }), /无法连接/)
  assert.deepEqual(created, ['invoice-self-check-helper'])
})

test('treats an unreadable existing skill as non-reusable and keeps suffixing', async () => {
  const created = []
  const result = await createTemplateSkill({
    baseName: 'invoice-self-check-helper',
    markdown: MARKDOWN,
    createSkill: async (name) => {
      created.push(name)
      if (name === 'invoice-self-check-helper') throw new Error(`Skill「${name}」已存在，请换一个名称`)
      return { name }
    },
    fetchSkill: async () => { throw new Error('网络瞬断') },
  })
  assert.equal(result.name, 'invoice-self-check-helper-2')
  assert.deepEqual(created, ['invoice-self-check-helper', 'invoice-self-check-helper-2'])
})

test('keeps searching well past -9 when many same-prefixed skills exist with different content', async () => {
  // 模拟反复测试积累：-1 … -12 全被占用且内容不同，-13 空闲。
  const taken = new Set(['invoice-self-check-helper'])
  for (let i = 2; i <= 12; i++) taken.add(`invoice-self-check-helper-${i}`)
  const created = []
  const result = await createTemplateSkill({
    baseName: 'invoice-self-check-helper',
    markdown: MARKDOWN,
    createSkill: async (name) => {
      created.push(name)
      if (taken.has(name)) throw new Error(`Skill「${name}」已存在，请换一个名称`)
      return { name }
    },
    fetchSkill: async (name) => ({ name, markdown: storedFormDifferent(name) }),
  })
  assert.equal(result.name, 'invoice-self-check-helper-13')
  assert.equal(created.length, 13)
})
