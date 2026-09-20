import { describe, expect, it } from 'vitest';
import { extractAnthropicTextContent } from '../ai-analyzer.js';

describe('Anthropic response text extraction', () => {
  it('reads text after provider-specific thinking blocks', () => {
    expect(extractAnthropicTextContent([
      { type: 'thinking', thinking: 'internal reasoning' },
      { type: 'text', text: '{"type":"final","content":"ok"}' },
    ])).toBe('{"type":"final","content":"ok"}');
  });

  it('joins multiple text blocks and ignores non-text content', () => {
    expect(extractAnthropicTextContent([
      { type: 'text', text: '{"type":"final",' },
      { type: 'redacted_thinking', data: 'hidden' },
      { type: 'text', text: '"content":"ok"}' },
    ])).toBe('{"type":"final","content":"ok"}');
  });
});
