import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';

// Evaluate preserved function bodies with inert DOM controls; no network or browser.
describe('social command legacy confirmation', () => {
  for (const [site, names] of [['bilibili.com', ['likeVideo', 'favoriteVideo']], ['xiaohongshu.com', ['likeNote', 'favoriteNote']]]) {
    for (const name of names) it(site + ' ' + name + ' retains its business-specific confirm option', async () => {
      const source = readFileSync(new URL('../../adapters/' + site + '/extension/internal/legacy.js', import.meta.url), 'utf8');
      const start = source.indexOf('async function ' + name + '(');
      const end = source.indexOf('\n}', start) + 2;
      const tools = [];
      const scope = vm.createContext({
        window: { location: { href: 'https://example.com/item' }, __webmcpRegister: entry => tools.push(...entry.tools) },
        normalizeVideoUrl: () => '', normalizeNoteUrl: () => '',
        isBilibiliVideoPath: () => true, isSamePage: () => true, isNotePath: () => true,
        hasLoginGate: () => false, findControl: () => null, findActionControl: () => null,
        controlLooksActive: () => false,
      });
      vm.runInContext(source.slice(start, end), scope);
      expect(await vm.runInContext(name + '({})', scope)).toMatchObject({ needs_confirmation: true });
      vm.runInContext(buildV2Bootstrap({ name: 'demo', commands: [{ id: 'run', runtime: 'extension', safety: 'write', requires_confirmation: false }] }), scope);
      vm.runInContext('window.__webcliRegisterCommand("run", ' + name + ')', scope);
      expect((await tools[0].handler({ __confirmed: true })).needs_confirmation).toBe(true);
      const result = await tools[0].handler({ confirm: true });
      expect(result.needs_confirmation).toBeUndefined();
      expect(result.error).toBeTruthy(); // reached the missing-control check after the old gate
    });
  }
});
