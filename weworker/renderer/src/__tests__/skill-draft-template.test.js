import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { parseSkillMarkdownMeta } from '../utils/skill-markdown-meta.js'

// Exercise the same disk-entry conversion used after creation and list reload.
const source = fs.readFileSync(new URL('../components/welcome/ToolPackageEditor.jsx', import.meta.url), 'utf8')
const template = fs.readFileSync(new URL('../components/welcome/custom-skill-template.md', import.meta.url), 'utf8')
const normalize = source.slice(source.indexOf('function normalizeResources('), source.indexOf('function normalizeTool('))
const convert = source.slice(source.indexOf('function buildPublicCustomSkillTool('), source.indexOf('function buildToolTooltip('))
const buildTool = vm.runInNewContext(`${normalize}\n${convert}\nbuildPublicCustomSkillTool`, {
  customSkillTemplateMarkdown: template, parseSkillMarkdownMeta,
})

test('new and reopened empty Skill folders offer the editable template without replacing their name', () => {
  const entry = { name: 'example-skill', content: '', draft: true, enabled: false, resources: [] }
  for (const diskEntry of [entry, JSON.parse(JSON.stringify(entry))]) {
    const tool = buildTool(diskEntry)
    assert.equal(tool.markdown, template)
    assert.equal(tool.name, 'example-skill')
    assert.equal(tool.directoryName, 'example-skill')
    assert.equal(tool.enabled, false)
    assert.equal(tool.source, 'public-custom')
  }
  assert.equal(entry.content, '')
})

test('saved Skill content, including deliberately emptied documents, is not replaced by a template', () => {
  for (const content of ['# My instructions\nKeep this text.', '', '   ']) {
    const tool = buildTool({ name: 'example-skill', content, draft: false, enabled: false })
    assert.equal(tool.markdown, content)
    assert.equal(tool.source, 'public-skill')
  }
})
