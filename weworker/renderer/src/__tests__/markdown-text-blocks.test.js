import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { JSDOM } from 'jsdom'
import { partitionContentBlocks } from '../utils/group-tool-blocks.js'

const markdown = '`ls` finished.\n\n| Type | Name |\n| --- | --- |\n| file | `example.json` |\n| file | `other.json` |\n\nDone.'

function renderText(content) {
  return partitionContentBlocks(content).map(item => {
    if (item.kind !== 'block' || item.block.type !== 'text') return ''
    return renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, item.block.text.trim()))
  }).join('')
}

describe('fragmented assistant Markdown', () => {
  it('renders inline code and every table row across any text split', () => {
    const expected = renderText([{ type: 'text', text: markdown }])
    for (let split = 1; split < markdown.length; split++) {
      const html = renderText([
        { type: 'text', text: markdown.slice(0, split) },
        { type: 'text', text: markdown.slice(split) },
      ])
      assert.equal(html, expected, `split at ${split}`)
      const document = new JSDOM(html).window.document
      assert.equal(document.querySelectorAll('tbody tr').length, 2)
      assert.deepEqual([...document.querySelectorAll('code')].map(node => node.textContent), ['ls', 'example.json', 'other.json'])
    }
  })

  it('keeps whitespace-only fragments and never mutates saved blocks', () => {
    const content = [...markdown].map(text => Object.freeze({ type: 'text', text }))
    Object.freeze(content)
    assert.equal(renderText(content), renderText([{ type: 'text', text: markdown }]))
    assert.equal(content.length, markdown.length)
    assert.equal(content[0].text, '`')
  })

  it('preserves tool, image, error and timing boundaries and stable text keys', () => {
    const before = { type: 'text', id: 'example-text', text: 'Before ' }
    const tool = { type: 'tool_use', id: 'example-tool', name: 'Bash' }
    const image = { type: 'image', data: 'ZXhhbXBsZQ==' }
    const error = { type: 'error', text: 'Example failure' }
    const timing = { type: 'timing', totalMs: 1000 }
    const content = [before, { type: 'text', text: 'tool' }, tool, { type: 'text', text: 'After tool' }, image, { type: 'text', text: 'After image' }, error, { type: 'text', text: 'After error' }, timing]
    const items = partitionContentBlocks(content)
    assert.equal(items[0].key, partitionContentBlocks([before])[0].key)
    assert.equal(items[0].block.text, 'Before tool')
    assert.deepEqual(items.slice(1).map(item => item.kind === 'tool_exec_group' ? item.blocks[0] : item.block), [tool, content[3], image, content[5], error, content[7], timing])
  })
})
