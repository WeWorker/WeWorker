import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSkillMarkdownMeta } from '../utils/skill-markdown-meta.js'

describe('parseSkillMarkdownMeta', () => {
  it('preserves the full invocation name on request without changing display names', () => {
    const markdown = '---\nname: webcli-example\nuser-invocable: false\n---\nInstructions'
    assert.equal(parseSkillMarkdownMeta(markdown).name, 'example')
    assert.equal(parseSkillMarkdownMeta(markdown, { preserveNamePrefix: true }).name, 'webcli-example')
    assert.equal(parseSkillMarkdownMeta(markdown).userInvocable, false)
  })
  it('parses folded YAML description blocks', () => {
    const markdown = `---
name: personal-codewords
description: >
  Resolves the user's personal shorthand commands (codewords) into concrete
  actions. Activate when the user sends a short phrase.
compatibility: Designed for WeWorker
---

# personal-codewords
`
    const meta = parseSkillMarkdownMeta(markdown)
    assert.equal(meta.name, 'personal-codewords')
    assert.match(meta.description, /Resolves the user's personal shorthand commands/)
    assert.match(meta.description, /Activate when the user sends a short phrase/)
    assert.doesNotMatch(meta.description, />/)
  })

  it('parses single-line quoted descriptions', () => {
    const markdown = `---
name: demo
description: "一行描述"
---
`
    const meta = parseSkillMarkdownMeta(markdown)
    assert.equal(meta.description, '一行描述')
  })
})
