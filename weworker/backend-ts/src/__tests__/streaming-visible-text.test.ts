import { describe, expect, it } from 'vitest'
import { StreamingVisibleText, stripThinkingTags } from '../streaming-visible-text.js'
import { parseAssistantMemoryOutput } from '../memory/memory-extractor.js'

describe('streaming assistant text', () => {
  it('handles every possible split of hidden delimiters and image prefixes', () => {
    const text = 'hello<weworker_memory>{"should_remember":false}</weworker_memory>![image](data:image/png;base64,AAAA)world'
    for (let split = 0; split <= text.length; split++) {
      const filter = new StreamingVisibleText()
      expect(filter.push(text.slice(0, split)) + filter.push(text.slice(split)) + filter.finish()).toBe('helloworld')
    }
    const filter = new StreamingVisibleText()
    expect([...text].map(char => filter.push(char)).join('') + filter.finish()).toBe('helloworld')
  })

  it('preserves ordinary markdown images and punctuation', () => {
    const filter = new StreamingVisibleText()
    const text = 'hello ![image](https://example.com/image.png) <tag> world!'
    expect([...text].map(char => filter.push(char)).join('') + filter.finish()).toBe(text)
  })
  it('emits ordinary words before the text block finishes without duplicating them', () => {
    const filter = new StreamingVisibleText()
    expect(filter.push('你好，')).toBe('你好，')
    expect(filter.push('正在处理。')).toBe('正在处理。')
    expect(filter.finish()).toBe('')
  })

  it('hides a memory block split across deltas and preserves it for parsing', () => {
    const filter = new StreamingVisibleText()
    const parts = ['回答', '<wewor', 'ker_memory>{"should_remember":true,"memory_type":"user_usage",',
      '"content":"偏好简洁回复"}</weworker_mem', 'ory>结束']
    const visible = parts.map(part => filter.push(part)).join('') + filter.finish()
    expect(visible).toBe('回答结束')
    const parsed = parseAssistantMemoryOutput(parts.join(''))
    expect(parsed.decision?.should_remember).toBe(true)
    expect(parsed.decision?.candidate?.content).toBe('偏好简洁回复')
  })

  it('never exposes an unfinished memory block', () => {
    const filter = new StreamingVisibleText()
    expect(filter.push('可见<weworker_memory>{"should_remember":')).toBe('可见')
    expect(filter.finish()).toBe('')
  })

  it('keeps a base64 image out of the visible response across deltas', () => {
    const filter = new StreamingVisibleText()
    const parts = ['截图前 ', '![screen', 'shot](data:im', 'age/png;base64,AAAA', 'BBBB)', ' 截图后']
    const visible = parts.map(part => filter.push(part)).join('') + filter.finish()
    expect(visible).toBe('截图前  截图后')
  })

  it('hides provider thinking tags across arbitrary stream splits', () => {
    const text = '答案前<THINK>内部推理</tHiNk>答案后'
    for (let split = 0; split <= text.length; split++) {
      const filter = new StreamingVisibleText()
      const visible = filter.push(text.slice(0, split)) + filter.push(text.slice(split)) + filter.finish()
      expect(visible).toBe('答案前答案后')
    }
    const filter = new StreamingVisibleText()
    expect([...text].map(part => filter.push(part)).join('') + filter.finish()).toBe('答案前答案后')
  })

  it('does not treat ordinary text with a similar tag name as thinking', () => {
    const filter = new StreamingVisibleText()
    expect(filter.push('literal <thing> text')).toBe('literal <thing> text')
    expect(filter.finish()).toBe('')
  })

  it('removes complete and unfinished thinking blocks from non-stream text', () => {
    expect(stripThinkingTags('答案前<think>内部推理</think>答案后')).toBe('答案前答案后')
    expect(stripThinkingTags('答案前<think>内部推理')).toBe('答案前')
  })
})
