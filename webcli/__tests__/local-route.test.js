import { describe, expect, it } from 'vitest';
import { matchLocalRoute } from '../local-route.js';

const rules = {
  version: 1,
  min_confidence: 0.8,
  entries: [
    {
      tool: 'example.org.search',
      priority: 10,
      patterns: [
        { type: 'regex', expression: '(?:示例站)[\\s\\S]{0,12}?(?:搜索|查一下)(?:\\s+|[:：])\\s*(\\S[\\s\\S]{0,60})$', flags: 'i', weight: 1 },
      ],
      negative_patterns: ['全文', '正文'],
      arg_extractors: [
        { regex: '(?:搜索|查一下)(?:\\s+|[:：])\\s*(\\S[\\s\\S]{0,60})$', flags: 'i', arg: 'query', type: 'string' },
      ],
      default_args: { limit: 10 },
    },
    {
      tool: 'example.org.topics',
      priority: 5,
      patterns: [
        { type: 'keyword', keywords: ['示例站', '热榜'], match_mode: 'all', weight: 1 },
      ],
      negative_patterns: [],
      arg_extractors: [
        { regex: '(?:第)\\s*(\\d{1,3})\\s*(?:条|个)', flags: 'i', arg: 'index', type: 'integer', min: 1, max: 50 },
      ],
      default_args: {},
    },
    {
      tool: 'example.org.lowweight',
      priority: 1,
      patterns: [
        { type: 'regex', expression: '示例站\\s*随便看看', flags: 'i', weight: 0.5 },
      ],
      negative_patterns: [],
      arg_extractors: [],
      default_args: {},
    },
  ],
};

const availableTools = new Set(['example.org.search', 'example.org.topics']);
const adapterOf = tool => tool === 'example.org.search'
  ? { adapter: { id: 'example.org', description: 'Example site' }, command: { id: 'search', name: tool, description: 'Search the site' } }
  : tool === 'example.org.topics'
    ? { adapter: { id: 'example.org', description: 'Example site' }, command: { id: 'topics', name: tool, description: 'Hot topics' } }
    : null;

function match(request, options = {}) {
  return matchLocalRoute(request, { rules, availableTools, adapterOf, ...options });
}

describe('local deterministic routing', () => {
  it('routes a matching request and extracts arguments', () => {
    const result = match('示例站 搜索: 量子力学 导论');
    expect(result).toBeTruthy();
    expect(result.kind).toBe('routed');
    expect(result.source).toBe('local-regex');
    expect(result.site.adapterId).toBe('example.org');
    expect(result.command.name).toBe('search');
    expect(result.args).toEqual({ limit: 10, query: '量子力学 导论' });
    expect(result.callCommand).toContain('webcli call example.org.search --args ');
    expect(result.callCommand).toContain('"limit":10');
  });

  it('rejects a request that hits a negative pattern', () => {
    expect(match('示例站 搜索: 量子力学 全文')).toBeNull();
  });

  it('rejects discussion-mode questions', () => {
    expect(match('示例站搜索怎么用？')).toBeNull();
    expect(match('这个支持吗')).toBeNull();
  });

  it('coerces integer arguments with clamping and drops bad values', () => {
    const result = match('示例站 热榜 第 3 条');
    expect(result?.command.name).toBe('topics');
    expect(result?.args.index).toBe(3);
    expect(match('示例站 热榜 第 999 条')?.args.index).toBe(50); // clamped to max
    expect(match('示例站 热榜')?.args).toEqual({}); // no index extracted, no guess
  });

  it('drops hits below the confidence threshold', () => {
    expect(match('示例站 随便看看')).toBeNull();
  });

  it('never recommends a tool outside the current catalog', () => {
    const result = matchLocalRoute('示例站 随便看看', {
      rules, availableTools: new Set(['example.org.search']), adapterOf,
    });
    expect(result).toBeNull();
  });

  it('honors a known adapter restriction', () => {
    expect(match('示例站 搜索: 量子力学', { knownSite: 'other.com' })).toBeNull();
    expect(match('示例站 搜索: 量子力学', { knownSite: 'example.org' })).toBeTruthy();
  });

  it('prefers the higher-priority entry when several match', () => {
    // Both entries can match keyword+regex surfaces; priority 10 must win over 5.
    const result = match('示例站 搜索: 热榜 关键词');
    expect(result?.tool ?? result?.command.name).toBe('search');
  });

  it('returns null for empty, malformed or missing rules', () => {
    expect(match('')).toBeNull();
    expect(match('   ')).toBeNull();
    expect(matchLocalRoute('示例站 搜索: x', { rules: null, availableTools, adapterOf })).toBeNull();
    expect(matchLocalRoute('示例站 搜索: x', { rules: { entries: 'nope' }, availableTools, adapterOf })).toBeNull();
  });
});
