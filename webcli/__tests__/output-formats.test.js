import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatCallOutput, resolveOutputFormat } from '../output-format.js';
import { extractRuntimeFlags } from '../index.js';

const entry = fileURLToPath(new URL('../index.js', import.meta.url));
it('preserves existing defaults and full JSON; accepts explicit format aliases', () => {
  expect(resolveOutputFormat(undefined, true)).toBe('markdown');
  expect(resolveOutputFormat(undefined, false)).toBe('json');
  expect(resolveOutputFormat('MD')).toBe('markdown'); expect(resolveOutputFormat('yml')).toBe('yaml');
  const value = { rows: [{ id: '007', title: '示例' }], cursor: 'example' };
  expect(formatCallOutput(value, 'json')).toBe(JSON.stringify(value, null, 2));
  expect(formatCallOutput(value, 'md')).toBe(formatCallOutput(value, 'markdown'));
  for (const invalid of ['', 'xml', 'jsonl']) expect(() => resolveOutputFormat(invalid)).toThrow();
});
it('keeps business format parameters separate and rejects an empty explicit format', () => {
  expect(extractRuntimeFlags(['call', 'example.read', '--format=pdf', '--output-format=csv']).args).toEqual(['call', 'example.read', '--format=pdf']);
  expect(extractRuntimeFlags(['--output-format=']).outputFormat).toBe('');
  const result = spawnSync(process.execPath, [entry, 'call', 'browser.help', '--output-format='], { encoding: 'utf8' });
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('缺少参数值');
});
it('quotes CSV headers and cells, handles CR/LF and retains later-row columns and nested data', () => {
  const csv = formatCallOutput([{ 'a,b': 'one"two', title: 'first\r\nsecond' }, { 'a,b': '007', detail: { value: false } }], 'csv');
  expect(csv).toBe('"a,b",title,detail\r\n"one""two","first\r\nsecond",\r\n007,,"{""value"":false}"');
  expect(formatCallOutput({ items: [{ id: '007', title: '示例' }] }, 'csv', { columns: ['title', 'id'] })).toBe('title,id\r\n示例,007');
  expect(formatCallOutput([], 'csv')).toBe('');
});
it('serializes nested YAML without inferred string types, tags or anchors', () => {
  const value = { id: '007', truth: 'true', date: '2026-10-18', empty: {}, array: [], rows: [{ text: 'a\nb', value: false, n: 0, absent: null }], tag: '!!js/function &example', omitted: undefined };
  expect(formatCallOutput(value, 'yaml')).toBe('"id": "007"\n"truth": "true"\n"date": "2026-10-18"\n"empty": {}\n"array": []\n"rows":\n  -\n    "text": "a\\nb"\n    "value": false\n    "n": 0\n    "absent": null\n"tag": "!!js/function &example"');
});
it('renders plain primary text and tables without terminal controls', () => {
  expect(formatCallOutput({ result: { text: 'Example\nresponse' } }, 'plain')).toBe('Example\nresponse');
  expect(formatCallOutput({ ok: true, details: { id: '007' } }, 'plain')).toBe('ok: true\ndetails: {"id":"007"}');
  const table = formatCallOutput([{ id: '007', text: '示例\n\x1b[2J\x7f' }, { id: '0', text: 'ok' }], 'table');
  expect(table).toContain('示例\\u000a\\u001b[2J\\u007f'); expect(table).not.toContain('\x1b');
  expect(table.split('\n')).toHaveLength(6);
});
it.each(['browser', 'exploration', 'profile'])('formats %s management help while keeping its default JSON', namespace => {
  const run = format => execFileSync(process.execPath, [entry, 'call', namespace + '.help', ...(format ? ['--output-format=' + format] : [])], { encoding: 'utf8' });
  const value = JSON.parse(run());
  for (const format of ['json', 'yaml', 'plain', 'csv', 'table', 'markdown']) expect(run(format).trimEnd()).toBe(formatCallOutput(value, format).trimEnd());
});
it('preserves nonzero errors and refuses non-JSON follow before starting a Bridge', () => {
  const result = spawnSync(process.execPath, [entry, 'call', 'browser.unknown', '--output-format=yaml'], { encoding: 'utf8' });
  expect(result.status).toBe(1); expect(result.stdout).toContain('"code": "UNKNOWN_COMMAND"');
  const follow = spawnSync(process.execPath, [entry, 'call', 'browser.console', '--follow', '--output-format=csv'], { encoding: 'utf8' });
  expect(follow.status).toBe(1); expect(follow.stdout).toBe(''); expect(follow.stderr).toContain('JSON Lines'); expect(follow.stderr).not.toContain('Bridge not running');
});

it('formats catalog lists and global help; rejects unsupported Adapter output before a mutation', () => {
  for (const args of [['list'], ['adapter', 'list'], ['--help'], ['adapter', '--help']]) {
    // The complete prepared Adapter catalog exceeds Node's default 1 MiB pipe
    // buffer. Keep the full JSON/YAML comparison with an explicit finite bound.
    const run = format => execFileSync(process.execPath, [entry, ...args, '--output-format=' + format], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
    const value = JSON.parse(run('json'));
    expect(run('yaml').trimEnd()).toBe(formatCallOutput(value, 'yaml').trimEnd());
  }
  const rejected = spawnSync(process.execPath, [entry, 'adapter', 'install', '--directory=example', '--output-format=yaml'], { encoding: 'utf8' });
  expect(rejected.status).toBe(1); expect(rejected.stderr).toContain('list, info and help');
});
