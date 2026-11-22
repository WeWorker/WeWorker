import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  TemplateSkillWriteError,
  normalizeTemplateSkillMarkdown,
  writeTemplateSkillLocally,
} from '../template-skill-writer.js'
import { findTemplate, renderTemplateSkill } from '../../renderer/src/components/dedicated-agents/quick-create/templates.js'

function fixtureLocations(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-template-skill-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    libraryDir: path.join(root, 'private'),
    runtimeSkillsDir: path.join(root, 'public'),
  }
}

test('writes an allowed built-in template Skill to the private library', t => {
  const locations = fixtureLocations(t)
  const result = writeTemplateSkillLocally({
    templateId: 'invoice-self-check-helper',
    name: 'invoice-self-check-helper',
    markdown: '---\nname: wrong-name\ndescription: fixture\n---\n\nbody',
  }, locations)

  assert.equal(result.name, 'invoice-self-check-helper')
  assert.equal(result.scope, 'private')
  assert.equal(
    fs.readFileSync(path.join(locations.libraryDir, result.name, 'SKILL.md'), 'utf8'),
    result.markdown,
  )
  assert.match(result.markdown, /^---\nname: invoice-self-check-helper$/m)
  assert.match(result.markdown, /^allowed-tools: Bash\(webcli call \*\)$/m)
})

test('allows only retry suffixes for the matching built-in template', t => {
  const locations = fixtureLocations(t)
  const result = writeTemplateSkillLocally({
    templateId: 'apikey-usage-helper',
    name: 'apikey-usage-helper-2',
    markdown: 'fixture body',
  }, locations)
  assert.equal(result.name, 'apikey-usage-helper-2')

  assert.throws(() => writeTemplateSkillLocally({
    templateId: 'apikey-usage-helper',
    name: '../outside',
    markdown: 'fixture body',
  }, locations), TemplateSkillWriteError)
  assert.throws(() => writeTemplateSkillLocally({
    templateId: 'unknown-template',
    name: 'apikey-usage-helper-3',
    markdown: 'fixture body',
  }, locations), TemplateSkillWriteError)
})

test('preserves cross-scope duplicate detection', t => {
  const locations = fixtureLocations(t)
  const publicSkill = path.join(locations.runtimeSkillsDir, 'invoice-self-check-helper')
  fs.mkdirSync(publicSkill, { recursive: true })
  fs.writeFileSync(path.join(publicSkill, 'SKILL.md'), 'fixture')

  assert.throws(() => writeTemplateSkillLocally({
    templateId: 'invoice-self-check-helper',
    name: 'invoice-self-check-helper',
    markdown: 'fixture body',
  }, locations), error => error.code === 'SKILL_EXISTS' && /已存在/.test(error.message))
})

test('measures the normalized Skill with its UTF-8 byte length', t => {
  const locations = fixtureLocations(t)
  assert.throws(() => writeTemplateSkillLocally({
    templateId: 'invoice-self-check-helper',
    name: 'invoice-self-check-helper',
    markdown: '中'.repeat(70_000),
  }, locations), error => error.code === 'SKILL_TOO_LARGE')
})

test('writes the real invoice template without a loopback HTTP request', t => {
  const locations = fixtureLocations(t)
  const template = findTemplate('invoice-self-check-helper')
  const source = renderTemplateSkill(template, template.defaultAnswers)
  assert.ok(Buffer.byteLength(source, 'utf8') > 32 * 1024)

  const result = writeTemplateSkillLocally({
    templateId: template.id,
    name: template.skillName,
    markdown: source,
  }, locations)
  assert.equal(result.name, template.skillName)
  assert.ok(fs.existsSync(path.join(locations.libraryDir, template.skillName, 'SKILL.md')))
})

test('normalization matches the backend frontmatter contract', () => {
  const markdown = normalizeTemplateSkillMarkdown('plain body', 'invoice-self-check-helper')
  assert.match(markdown, /^---\nname: invoice-self-check-helper\ndescription: "invoice-self-check-helper"\nallowed-tools: Bash\(webcli call \*\)\n---\n\nplain body\n$/)
})
