import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function runRuntimeNativeInput(');
const end = source.indexOf('\nfunction normalizeRuntimeBrowserFetchHeaders', start);
function setup(borrowed = false, fail = false) {
  const calls = [], attached = new Set(borrowed ? [7] : []);
  const context = vm.createContext({
    cdpAttachedTabs: attached,
    createRuntimeHelperError: (code, message) => Object.assign(new Error(message), { code }),
    chrome: { debugger: {
      attach: async target => { calls.push(['attach', target.tabId]); },
      sendCommand: async (target, method, args) => { calls.push([method, target, args]); if (fail) throw new Error('fixture failure'); },
      detach: async target => calls.push(['detach', target]),
    } },
  });
  vm.runInContext(source.slice(start, end), context);
  return { calls, attached, run: payload => context.runRuntimeNativeInput(7, payload) };
}
test('native text is scoped to sender tab and detaches its own connection', async () => {
  const s = setup(); await s.run({ type: 'text', text: 'Fixture 文本', tabId: 999 });
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls[1])), ['Input.insertText', { tabId: 7 }, { text: 'Fixture 文本' }]);
  assert.equal(s.calls.at(-1)[0], 'detach'); assert.equal(s.attached.size, 0);
});
test('Enter has keyDown/keyUp and carriage return', async () => {
  const s = setup(); await s.run({ type: 'key', key: 'Enter' });
  const input = s.calls.filter(c => c[0] === 'Input.dispatchKeyEvent');
  assert.deepEqual(input.map(c => c[2].type), ['keyDown', 'keyUp']); assert.equal(input[0][2].text, '\r');
});
test('borrowed debugger attachment remains attached', async () => {
  const s = setup(true); await s.run({ type: 'key', key: 'PageDown' });
  assert.equal(s.calls.some(c => c[0] === 'detach'), false); assert.equal(s.attached.has(7), true);
});
test('failed commands release owned attachment', async () => {
  const s = setup(false, true); await assert.rejects(s.run({ type: 'text', text: 'Fixture' }), /fixture failure/);
  assert.equal(s.calls.at(-1)[0], 'detach');
});
for (const payload of [{ type: 'text', text: 'x'.repeat(20001) }, { type: 'text', text: 1 }, { type: 'key', key: 'Control+L' }, { type: 'key', key: '__proto__' }, { type: 'Runtime.evaluate' }, { type: 'click', x: 1, y: 2 }]) {
  test('invalid native input rejected before debugger attachment: ' + JSON.stringify(payload).slice(0, 70), async () => {
    const s = setup(); await assert.rejects(s.run(payload), { code: 'INVALID_ARGS' }); assert.equal(s.calls.length, 0);
  });
}
test('helper is routed from sender tab, not global direct/background context', () => {
  assert.match(source, /case 'native_input':\s+return runRuntimeNativeInput\(tab\.id, payload\)/);
});
