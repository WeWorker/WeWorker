import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const read = file => readFileSync(new URL('../../extension/' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function declaration(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing runtime function: ' + name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const worker = read('background/service-worker.js');
const shared = ['isMissingToolArg', 'normalizeToolArgsForSchema', 'validateToolValueType'].map(name => declaration(worker, name)).join('\n');
const offscreen = read('offscreen/direct-frame.js');
const cases = [
  ['page', declaration(read('content/injector.js'), 'createWecliRuntime') + '; createWecliRuntime().validateArgs'],
  ['service worker', shared + declaration(worker, 'validateToolCallArgs') + '; validateToolCallArgs'],
  ['direct runtime', shared + declaration(worker, 'createDirectWecliRuntime') + '; createDirectWecliRuntime().validateArgs'],
  ['offscreen', ['createRuntimeError','isMissingArg','normalizeArgsForSchema','validateValueType','validateArgs'].map(name => declaration(offscreen, name)).join('\n') + '; validateArgs'],
  ['managed background', declaration(read('background/managed-background-runtime.js'), 'initializeRuntime') + '; initializeRuntime("fixture", {}); window.__webmcpWecliRuntime.validateArgs'],
];
describe('legacy schema controls at every extension validation boundary', () => {
  it.each(cases)('%s ignores required/default retired controls while preserving business validation', (_name, source) => {
    const validate = vm.runInNewContext(source, { window: {}, chrome: {}, console });
    const schema = { type: 'object', properties: { target: { type: 'string' }, __confirmed: { type: 'boolean', default: true }, body: { type: 'object' } }, required: ['target', '__confirmed'], additionalProperties: false };
    for (const marker of [undefined, false, true, 'mistyped', [true, false]]) {
      const args = { target: 'example', body: { __confirmed: 'business field' }, ...(marker === undefined ? {} : { __confirmed: marker }) };
      expect(validate(args, schema)).toEqual({ target: 'example', body: args.body });
      expect(args.__confirmed).toEqual(marker);
    }
    expect(() => validate({}, schema)).toThrow(/target/);
    expect(() => validate({ target: 123 }, schema)).toThrow();
    expect(() => validate({ target: 'example', extra: true }, schema)).toThrow();
  });
});
import { toAdapterHelpModel, renderCommandHelp } from '../progressive-help.js';

it('omits legacy controls from help and examples for old package schemas', () => {
  const adapter = { schema_version: 2, name: 'example.com', version: '1.0.0', commands: [{ id: 'submit', runtime: 'http', safety: 'write', requires_confirmation: true,
    schema: { type: 'object', required: ['target', '__confirmed'], properties: { target: { type: 'string' }, __confirmed: { type: 'boolean', default: true } } } }] };
  const model = toAdapterHelpModel(adapter);
  expect(model.commands[0].params.map(p => p.name)).toEqual(['target']);
  expect(renderCommandHelp(model, model.commands[0])).not.toContain('__confirmed');
  expect(renderCommandHelp(model, model.commands[0])).not.toContain('Confirmation:');
});
