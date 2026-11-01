import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { selectCatalogSkills, skillSelectionKey, findSelectedSkill, formatSkillCreatedAt } from '../utils/skill-catalog.js'

const skills = [
  { id: 'older-official', name: 'Zoo', description: 'example', source: 'official-skill', createdAt: 100, creationOrderKey: '1:1' },
  { id: 'new-custom', name: 'Alpha', description: 'custom', source: 'public-custom', createdAt: 200, creationOrderKey: '1:3' },
  { id: 'old-custom', name: 'Beta', description: 'custom', source: 'custom', createdAt: 100, creationOrderKey: '1:2' },
  { id: 'builtin', name: 'Built-in', description: '', source: 'public-skill', createdAt: 300, creationOrderKey: '1:4' },
]

test('shows the sorting timestamp in local time and leaves missing or invalid dates unknown', () => {
  const createdAt = new Date(2026, 9, 21, 9, 5).getTime()
  assert.equal(formatSkillCreatedAt({ createdAt }), '2026-10-21 09:05')
  for (const value of [undefined, null, 0, -1, NaN, Infinity, 1e20]) {
    assert.equal(formatSkillCreatedAt({ createdAt: value }), '')
  }
})

test('renders a Skill root icon when available and keeps the document fallback', () => {
  const source = fs.readFileSync(new URL('../components/welcome/ToolPackageEditor.jsx', import.meta.url), 'utf8')
  assert.match(source, /tool\.iconUrl\s*\?\s*<img src=\{tool\.iconUrl\}/)
  assert.match(source, /function buildOfficialSiteSkill\([\s\S]*?iconUrl: siteInfo\.iconUrl/)
  assert.match(source, /:\s*<FileTextOutlined \/>/)
})

test('selection follows a public directory after rename, reload and sorting', () => {
  const selected = skills[1]
  const key = skillSelectionKey(selected)
  const updated = skills.map(skill => skill === selected ? { ...skill, id: 'renamed', name: 'Zulu' } : { ...skill })
  for (const sort of ['name', 'created']) {
    const found = findSelectedSkill(selectCatalogSkills(updated, { sort }), key)
    assert.equal(found.id, 'renamed')
    assert.equal(skillSelectionKey(found), key)
  }
  assert.equal(findSelectedSkill(updated.filter(skill => skill.id !== 'renamed'), key), null)
})

test('selection resolves before directory metadata loads and site IDs remain stable', () => {
  const skill = skills[1]
  const initial = skillSelectionKey({ ...skill, creationOrderKey: undefined })
  assert.equal(findSelectedSkill(skills, initial), skill)
  const site = { source: 'custom', siteId: 'example', id: 'task', name: 'Old' }
  assert.equal(skillSelectionKey(site), skillSelectionKey({ ...site, name: 'New', creationOrderKey: '1:99' }))
})

test('defaults to newest creation time and uses a stable key when timestamps match', () => {
  assert.deepEqual(selectCatalogSkills(skills).map(skill => skill.id), ['builtin', 'new-custom', 'older-official', 'old-custom'])
})

test('filters all or both public and site custom Skills while preserving independent search', () => {
  assert.deepEqual(selectCatalogSkills(skills, { filter: 'custom' }).map(skill => skill.id), ['new-custom', 'old-custom'])
  assert.deepEqual(selectCatalogSkills(skills, { filter: 'custom', query: 'alpha' }).map(skill => skill.id), ['new-custom'])
  const adapterSkill = { id: 'adapter', name: 'Adapter Skill', source: 'public-skill' }
  assert.deepEqual(selectCatalogSkills([...skills, adapterSkill], { filter: 'custom' }).map(skill => skill.id), ['new-custom', 'old-custom'])
})

test('sorts by display name without changing the creation-time default', () => {
  assert.deepEqual(selectCatalogSkills(skills, { sort: 'name' }).map(skill => skill.id), ['new-custom', 'old-custom', 'builtin', 'older-official'])
  const renamed = skills.map(skill => skill.id === 'new-custom' ? { ...skill, name: 'Yoyo' } : skill)
  assert.deepEqual(selectCatalogSkills(renamed).map(skill => skill.id), ['builtin', 'new-custom', 'older-official', 'old-custom'])
  assert.deepEqual(selectCatalogSkills(renamed, { sort: 'name' }).map(skill => skill.id), ['old-custom', 'builtin', 'new-custom', 'older-official'])
})

test('rename and reversed API order cannot move equal-time or unknown-time directories', () => {
  for (const createdAt of [100, null, undefined, NaN]) {
    const original = skills.map(skill => ({ ...skill, createdAt }))
    const renamed = original.map(skill => ({ ...skill, id: 'renamed-' + skill.id, name: 'New ' + skill.name })).reverse()
    assert.deepEqual(selectCatalogSkills(renamed).map(skill => skill.creationOrderKey), selectCatalogSkills(original).map(skill => skill.creationOrderKey))
  }
})

test('searches tags within custom results and leaves source order unchanged', () => {
  const original = [...skills]
  assert.deepEqual(selectCatalogSkills(skills, { filter: 'custom', query: '工作', getTags: skill => skill.id === 'old-custom' ? ['工作'] : [] }).map(skill => skill.id), ['old-custom'])
  assert.deepEqual(selectCatalogSkills(skills, { query: 'missing' }), [])
  assert.deepEqual(skills, original)
})
