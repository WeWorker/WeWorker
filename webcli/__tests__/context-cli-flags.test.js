import { expect, it } from 'vitest';
import { extractContextFlags } from '../context-cli-flags.js';

it.each([
  ['--decision=read'], ['--decision', 'approve'], ['--decision=reject'],
  ['--step=review', '--reply-to=record-1'],
])('preserves ordinary Adapter arguments %j', (...flags) => {
  const argv = ['call', 'example.com.review', '--id=123', ...flags];
  expect(extractContextFlags(argv)).toEqual({ args: argv });
});

it('preserves business arguments when creating a context', () => {
  const result = extractContextFlags(['call', 'example.com.review', '--decision=read', '--new-context']);
  expect(result.context).toMatch(/^[a-f0-9-]{36}$/);
  expect(result.args).toEqual(['call', 'example.com.review', '--decision=read']);
  expect(result.decision).toBeUndefined();
});

it('accepts namespaced routing controls alongside same-named business arguments', () => {
  expect(extractContextFlags(['call', 'example.com.review', '--decision=approve', '--step=business',
    '--context-decision=d1', '--context-step', 's1', '--context', 'session'])).toEqual({
    args: ['call', 'example.com.review', '--decision=approve', '--step=business'],
    context: 'session', decision: 'd1', step: 's1',
  });
});

it('preserves existing explicit context associations', () => {
  expect(extractContextFlags(['call', 'example.com.detail', '--decision=d1', '--step=s1', '--context=session']))
    .toEqual({ args: ['call', 'example.com.detail'], context: 'session', decision: 'd1', step: 's1' });
  expect(extractContextFlags(['route', '--context=session', '--context-reply-to=q1', 'Answer']))
    .toEqual({ args: ['route', 'Answer'], context: 'session', 'reply-to': 'q1' });
});

it('does not opt into context parsing after the option terminator', () => {
  const argv = ['call', 'example.com.review', '--decision=read', '--', '--context=session'];
  expect(extractContextFlags(argv)).toEqual({ args: argv });
});

it.each([
  [['call', 'example.com.review', '--context-decision=d1'], 'context_required'],
  [['call', 'example.com.review', '--context=session', '--context-step=s1'], 'context_invalid_association'],
  [['call', 'example.com.review', '--context=session', '--context-step=s1', '--context-step=s2'], 'context_duplicate_flag'],
])('rejects incomplete explicit routing controls %j', (argv, code) => {
  expect(() => extractContextFlags(argv)).toThrow(code);
});
