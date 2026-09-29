import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-v2.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { managedAdapterSkill } from '../adapter-views.js';
import { extractFlagArgs } from '../index.js';

const root = resolve(import.meta.dirname, '../..');
const sites = ['news.ycombinator.com', '36kr.com'];
const inventory = JSON.parse(readFileSync(resolve(root, 'docs/opencli_news_wave2_inventory.json'), 'utf8'));

function node(text = '', { one = {}, all = {}, attrs = {}, container = null } = {}) {
  return {
    textContent: text,
    innerText: text,
    querySelector: (selector) => one[selector] || selector.split(',').map((part) => one[part.trim()]).find(Boolean) || null,
    querySelectorAll: (selector) => all[selector] || selector.split(',').flatMap((part) => all[part.trim()] || []),
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selector) => (container && selector.includes('article-item') ? container : null),
    parentElement: null,
  };
}

function setup(site, { url, payload = {}, bodyText = '', one = {}, all = {}, privileged } = {}) {
  const pkg = validateV2AdapterDir(resolve(root, 'adapters', site));
  const handlers = new Map(), requests = [], calls = [];
  const location = new URL(url || 'https://' + pkg.manifest.match[0] + '/');
  const context = {
    URL, URLSearchParams, Set, Map, Date, Promise, AbortController,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout() {},
    console, location,
    document: {
      body: { innerText: bodyText },
      title: '',
      querySelector: (selector) => one[selector] || selector.split(',').map((part) => one[part.trim()]).find(Boolean) || null,
      querySelectorAll: (selector) => all[selector] || selector.split(',').flatMap((part) => all[part.trim()] || []),
    },
    __webmcpRegister: (definition) => { for (const tool of definition.tools) handlers.set(tool.name, tool.handler); },
    __webmcpWecliRuntime: {
      requestPrivileged: async (action, body) => {
        calls.push({ action, body });
        if (action === 'backend_fetch') {
          requests.push({ url: body.url, options: body.options, browserFallback: body.browserFallback, redactBodyInTrace: body.redactBodyInTrace });
          const computed = typeof payload === 'function' ? payload(String(body.url)) : payload;
          if (privileged) return privileged(action, body, computed);
          return { ok: true, status: 200, url: String(body.url), body: JSON.stringify(computed) };
        }
        return privileged ? privileged(action, body) : {};
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  const internal = resolve(root, 'adapters', site, 'extension/internal');
  if (existsSync(internal)) for (const file of readdirSync(internal).sort()) vm.runInContext(readFileSync(resolve(internal, file), 'utf8'), context, { filename: file });
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, 'adapters', site, command.module), 'utf8'), context, { filename: command.module });
  return { pkg, handlers, context, requests, calls, run: (id, args = {}) => handlers.get(site + '.' + id)(args) };
}

describe('OpenCLI news wave2 v2 contracts', () => {
  it.each(sites)('%s preserves inventoried source arguments, defaults and enums', (site) => {
    const { pkg } = setup(site);
    expect(pkg.commands).toHaveLength(inventory.filter((entry) => entry.package === site).length);
    for (const command of pkg.commands) {
      const original = inventory.find((entry) => entry.package === site && entry.name === command.id);
      expect(original).toBeDefined();
      if (original.access === 'write') expect(command.safety).toBe('write');
      for (const arg of original.args || []) {
        const schema = command.schema.properties[arg.name];
        expect(schema).toBeDefined();
        if (arg.default !== undefined) expect(schema.default).toEqual(arg.default);
        if (arg.choices) expect(schema.enum).toEqual(arg.choices);
      }
    }
  });

  it.each(sites)('%s loads every command through the real v2 bootstrap', (site) => {
    const { pkg, handlers } = setup(site);
    expect([...handlers.keys()]).toEqual(pkg.commands.map((command) => site + '.' + command.id));
    expect(JSON.parse(readFileSync(resolve(root, 'weworker/build-profile.json'))).adapters).toContain(site);
  });

  it.each(sites)('%s keeps maintained business guidance in deterministic Skills', (site) => {
    const { pkg } = setup(site);
    const guidance = readFileSync(resolve(root, 'adapters', site, 'guidance.md'), 'utf8');
    const adapter = { id: site, version: pkg.manifest.version, guidance, tools: [], match: pkg.manifest.match };
    const skill = managedAdapterSkill(adapter);
    expect(skill).toContain(guidance.trim());
    expect(skill).toBe(managedAdapterSkill(adapter));
    expect(guidance).toContain('本轮证据');
  });

  it.each(sites)('%s is read-only and keeps the OpenCLI license packaged', (site) => {
    const { pkg } = setup(site);
    expect(pkg.commands.every((command) => command.safety === 'read')).toBe(true);
    expect(JSON.parse(readFileSync(resolve(root, 'weworker/package.json'), 'utf8')).build.extraResources)
      .toContainEqual({ from: '../docs/third_party/OpenCLI-LICENSE.txt', to: 'licenses/OpenCLI-LICENSE.txt' });
  });

  it('declares only public API hosts beyond the package route domain', () => {
    const hn = setup('news.ycombinator.com').pkg;
    expect(hn.manifest.match).toEqual(['news.ycombinator.com']);
    expect(hn.manifest.runtime_allowed_hosts).toEqual(['hacker-news.firebaseio.com', 'hn.algolia.com']);
    expect(hn.commands.every((command) => command.execution?.runtime === 'background')).toBe(true);
    const kr = setup('36kr.com').pkg;
    expect(kr.manifest.match).toEqual(['www.36kr.com']);
    expect(kr.manifest.runtime_allowed_hosts).toBeUndefined();
    expect(kr.commands.filter((command) => command.execution?.runtime === 'background').map((command) => command.id)).toEqual(['news']);
  });
});

describe('Hacker News listing commands', () => {
  const ids = (count) => Array.from({ length: count }, (_, index) => index + 1);
  const items = (count, { dead = [], deleted = [], untitled = [] } = {}) => {
    const map = {};
    for (const id of ids(count)) {
      map[String(id)] = {
        id, type: 'story', by: 'user' + id, title: untitled.includes(id) ? undefined : 'Story ' + id,
        score: id, descendants: id * 2, url: 'https://example.com/' + id,
        dead: dead.includes(id) || undefined, deleted: deleted.includes(id) || undefined,
      };
    }
    return map;
  };
  const listSetup = (endpoint, itemMap, idCount = 60) => setup('news.ycombinator.com', {
    payload: (url) => url.endsWith(endpoint) ? ids(idCount) : itemMap[url.match(/item\/(\d+)\.json$/)?.[1]] ?? null,
  });

  it.each([
    ['top', 'topstories.json'], ['best', 'beststories.json'], ['new', 'newstories.json'],
    ['ask', 'askstories.json'], ['show', 'showstories.json'],
  ])('%s fetches the official list, filters dead items and caps pre-fetch at 50', async (command, endpoint) => {
    const s = listSetup(endpoint, items(60, { dead: [2], deleted: [3], untitled: [4] }));
    const rows = await s.run(command, {});
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ rank: 1, id: 1, title: 'Story 1', score: 1, author: 'user1', comments: 2, url: 'https://example.com/1' });
    expect(rows.some((row) => [2, 3, 4].includes(row.id))).toBe(false);
    expect(rows[1]).toMatchObject({ rank: 2, id: 5 });
    expect(s.requests[0].url).toBe('https://hacker-news.firebaseio.com/v0/' + endpoint);
    expect(s.requests).toHaveLength(31); // 1 list + min(20+10, 50) item fetches
    expect(s.requests[1].url).toBe('https://hacker-news.firebaseio.com/v0/item/1.json');
    expect(s.calls[0].body).toMatchObject({ browserFallback: false, redactBodyInTrace: true, options: { method: 'GET', redirect: 'manual' } });
  });

  it('jobs keeps the source projection without score/comments columns', async () => {
    const s = listSetup('jobstories.json', items(60));
    const rows = await s.run('jobs', { limit: '3' });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ rank: 1, id: 1, title: 'Story 1', author: 'user1', url: 'https://example.com/1' });
  });

  it('limit beyond the source pre-fetch cap still returns at most 50 rows', async () => {
    const s = listSetup('topstories.json', items(60));
    expect(await s.run('top', { limit: 100 })).toHaveLength(50);
    expect(s.requests).toHaveLength(51); // 1 list + 50 items
  });

  it.each(['', ' ', '5x', '1.5', '1e1', '0', '-1', '101', true, null, [], {}])('rejects invalid limit %p before requesting', async (limit) => {
    const s = setup('news.ycombinator.com');
    await expect(s.run('top', { limit })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(s.requests).toHaveLength(0);
  });

  it('reports upstream failures and empty lists explicitly', async () => {
    const dead = listSetup('topstories.json', items(60, { dead: ids(60) }));
    await expect(dead.run('top', {})).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    for (const fixture of [
      { privileged: (_, body) => ({ ok: false, status: 403, url: body.url, body: '' }), code: 'HTTP_ERROR' },
      { privileged: (_, body) => ({ ok: true, status: 200, url: body.url, body: 'not-json' }), code: 'COMMAND_EXEC' },
      { privileged: () => ({ ok: true, status: 302, url: 'https://example.com/', body: '' }), code: 'HTTP_ERROR' },
    ]) {
      const s = setup('news.ycombinator.com', { payload: [1, 2], privileged: fixture.privileged });
      await expect(s.run('top', {})).rejects.toMatchObject({ code: fixture.code });
    }
    const notArray = setup('news.ycombinator.com', { payload: { odd: true } });
    await expect(notArray.run('top', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    const network = setup('news.ycombinator.com', { payload: () => { throw new TypeError('network unavailable'); } });
    await expect(network.run('top', {})).rejects.toMatchObject({ code: 'FETCH_ERROR' });
  });
});

describe('Hacker News search', () => {
  const hits = (count) => ({ hits: Array.from({ length: count }, (_, index) => ({
    objectID: 1000 + index, title: 'Hit ' + index, points: index, author: 'author' + index, num_comments: index, url: 'https://example.com/hit' + index,
  })) });

  it('encodes query strictly and maps Algolia fields for both sort modes', async () => {
    for (const [sort, path] of [['relevance', 'search'], ['date', 'search_by_date']]) {
      const s = setup('news.ycombinator.com', { payload: (url) => (url.includes('/api/v1/' + path) ? hits(3) : null) });
      const rows = await s.run('search', { query: 'open source', limit: '3', sort });
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ rank: 1, id: '1000', title: 'Hit 0', score: 0, author: 'author0', comments: 0, url: 'https://example.com/hit0' });
      const url = new URL(s.requests[0].url);
      expect(url.pathname).toBe('/api/v1/' + path);
      expect(url.searchParams.get('query')).toBe('open source');
      expect(url.searchParams.get('tags')).toBe('story');
      expect(url.searchParams.get('hitsPerPage')).toBe('3');
    }
  });

  it('defaults sort to relevance and rejects invalid values or queries', async () => {
    const s = setup('news.ycombinator.com', { payload: () => hits(1) });
    await s.run('search', { query: 'fixture' });
    expect(new URL(s.requests[0].url).pathname).toBe('/api/v1/search');
    const invalid = setup('news.ycombinator.com');
    await expect(invalid.run('search', { query: 'x', sort: 'popular' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(invalid.run('search', { query: ' ' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(invalid.run('search', {})).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(invalid.run('search', { query: 'x', limit: '1.5' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(invalid.requests).toHaveLength(0);
  });

  it('distinguishes API failures from genuine empty results', async () => {
    const missing = setup('news.ycombinator.com', { payload: { error: 'fixture' } });
    await expect(missing.run('search', { query: 'x' })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    const empty = setup('news.ycombinator.com', { payload: { hits: [] } });
    await expect(empty.run('search', { query: 'x' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });
});

describe('Hacker News read', () => {
  const tree = new Map([
    ['123', { id: 123, type: 'story', by: 'pg', score: 42, title: 'Ask HN: Example', text: '<p>Hello <a href="https://example.com">world</a></p>', url: 'https://news.ycombinator.com/item?id=123', kids: [456] }],
    ['456', { id: 456, type: 'comment', by: 'sama', text: '<p>Top level</p>', kids: [789] }],
  ]);
  const treeSetup = (map = tree) => setup('news.ycombinator.com', {
    payload: (url) => map.get(url.match(/item\/(\d+)\.json$/)?.[1]) ?? null,
  });

  it('renders the story header, indented comments and hidden-reply stubs from the source fixture', async () => {
    const rows = await treeSetup().run('read', { id: '123', limit: 5, depth: 1, replies: 5, 'max-length': 2000 });
    expect(rows).toEqual([
      { type: 'POST', author: 'pg', score: 42, text: 'Ask HN: Example\nHello world (https://example.com)\nhttps://news.ycombinator.com/item?id=123' },
      { type: 'L0', author: 'sama', score: '', text: 'Top level' },
      { type: 'L1', author: '', score: '', text: '  [+1 more replies]' },
    ]);
  });

  it('rejects non-numeric ids and missing/deleted stories before walking the tree', async () => {
    const s = treeSetup();
    await expect(s.run('read', { id: 'abc' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(s.run('read', { id: '12 3' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(s.requests).toHaveLength(0);
    await expect(treeSetup().run('read', { id: '99999999' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    await expect(treeSetup(new Map([['1', { id: 1, deleted: true }]])).run('read', { id: '1' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('validates tree tuning arguments like the source', async () => {
    const s = treeSetup();
    for (const args of [{ id: '123', limit: 0 }, { id: '123', depth: 0 }, { id: '123', replies: -1 }, { id: '123', 'max-length': 99 }, { id: '123', 'max-length': '1.5' }]) {
      await expect(s.run('read', args)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    expect(s.requests).toHaveLength(0);
  });

  it('keeps depth/replies cutoffs and top-level limits as hidden markers', async () => {
    const map = new Map([
      ['1', { id: 1, type: 'story', by: 'a', title: 'T', score: 5, kids: [10, 11, 12] }],
      ['10', { id: 10, type: 'comment', by: 'c1', text: 'one', kids: [20, 21] }],
      ['11', { id: 11, type: 'comment', by: 'c2', text: 'two', kids: [22] }],
      ['12', { id: 12, type: 'comment', by: 'c3', text: 'three' }],
      ['20', { id: 20, type: 'comment', by: 'd1', text: 'reply' }],
      ['22', { id: 22, type: 'comment', by: 'd2', text: 'reply2' }],
    ]);
    const rows = await treeSetup(map).run('read', { id: '1', limit: 2, depth: 3, replies: 1 });
    expect(rows.map((row) => row.type)).toEqual(['POST', 'L0', 'L1', 'L1', 'L0', 'L1', '']);
    expect(rows[1]).toMatchObject({ type: 'L0', author: 'c1', text: 'one' });
    expect(rows[2].text).toBe('  > reply');
    expect(rows[3].text).toBe('  [+1 more replies]');
    expect(rows[4]).toMatchObject({ type: 'L0', author: 'c2', text: 'two' });
    expect(rows[5].text).toBe('  > reply2');
    expect(rows[6].text).toBe('[+1 more top-level comments]');
    expect(rows.filter((row) => /\[\+\d+ more replies\]/.test(row.text)).map((row) => row.text)).toEqual(['  [+1 more replies]']);
  });

  it('truncates long bodies at max-length and skips deleted/dead/non-comment nodes', async () => {
    const long = 'x'.repeat(50);
    const map = new Map([
      ['1', { id: 1, type: 'story', by: 'a', title: 'T', score: 5, text: long + long + long, kids: [10, 11, 12, 13] }],
      ['10', { id: 10, type: 'comment', by: 'c1', text: long + long + long }],
      ['11', { id: 11, type: 'comment', by: 'c2', deleted: true, text: 'gone' }],
      ['12', { id: 12, type: 'comment', by: 'c3', dead: true, text: 'dead' }],
      ['13', { id: 13, type: 'poll', by: 'c4', text: 'not a comment' }],
    ]);
    const rows = await treeSetup(map).run('read', { id: '1', limit: 10, depth: 1, 'max-length': 100 });
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('T\n' + 'x'.repeat(100) + '\n... [truncated]');
    expect(rows[1]).toMatchObject({ type: 'L0', author: 'c1' });
    expect(rows[1].text.endsWith('...')).toBe(true);
    expect(rows[1].text.length).toBe(103);
  });

  it('stops at the documented item request budget with an explicit marker', async () => {
    const kids = Array.from({ length: 45 }, (_, index) => index + 10);
    const map = new Map([['1', { id: 1, type: 'story', by: 'a', title: 'T', score: 1, kids }]]);
    for (const kid of kids) {
      map.set(String(kid), { id: kid, type: 'comment', by: 'c' + kid, text: 'body', kids: [kid * 10 + 1, kid * 10 + 2, kid * 10 + 3, kid * 10 + 4, kid * 10 + 5] });
    }
    const s = treeSetup(map);
    const rows = await s.run('read', { id: '1', limit: 45, depth: 2, replies: 5 });
    expect(s.requests).toHaveLength(200); // 1 story + 45 top-level + 154 replies
    expect(rows.at(-1).text).toBe('[request budget of 200 item fetches reached; remaining branches are not expanded]');
    expect(rows.filter((row) => row.type === 'L0')).toHaveLength(45);
  });

  it('reports partial comment fetch failures instead of dropping them silently', async () => {
    const map = new Map([
      ['1', { id: 1, type: 'story', by: 'a', title: 'T', score: 1, kids: [10, 11] }],
      ['10', { id: 10, type: 'comment', by: 'ok', text: 'fine' }],
    ]);
    const s = setup('news.ycombinator.com', {
      payload: (url) => {
        const id = url.match(/item\/(\d+)\.json$/)?.[1];
        if (id === '11') throw new TypeError('network unavailable');
        return map.get(id) ?? null;
      },
    });
    const rows = await s.run('read', { id: '1', limit: 5, depth: 1 });
    expect(rows.map((row) => row.author)).toEqual(['a', 'ok', '']);
    expect(rows[1]).toMatchObject({ type: 'L0', author: 'ok', text: 'fine' });
    expect(rows.at(-1).text).toBe('[1 comment fetch(es) failed and were skipped]');
  });
});

describe('Hacker News user', () => {
  it('maps the public profile and reports missing users explicitly', async () => {
    const s = setup('news.ycombinator.com', {
      payload: (url) => url.endsWith('/user/pg.json') ? { id: 'pg', created: 1160418111, karma: 1, about: '<i>hi</i>' } : null,
    });
    expect(await s.run('user', { username: 'pg' })).toEqual({ username: 'pg', karma: 1, created: '2006-10-09', about: '<i>hi</i>' });
    expect(s.requests[0].url).toBe('https://hacker-news.firebaseio.com/v0/user/pg.json');
    const missing = setup('news.ycombinator.com', { payload: () => null });
    await expect(missing.run('user', { username: 'nobody' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('validates and encodes usernames instead of interpolating raw input', async () => {
    const s = setup('news.ycombinator.com', { payload: () => null });
    for (const username of ['bad name', 'a/b', 'a.b', '', 'user@example', 'x'.repeat(33)]) {
      await expect(s.run('user', { username })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    expect(s.requests).toHaveLength(0);
  });

  it('accepts real CLI flag strings for numeric arguments', async () => {
    const { args } = extractFlagArgs(['--limit=5']);
    const itemMap = {};
    for (const id of [1, 2, 3, 4, 5, 6, 7]) itemMap[String(id)] = { id, type: 'story', by: 'u', title: 'S' + id, score: id, descendants: id, url: null };
    const s = setup('news.ycombinator.com', {
      payload: (url) => url.endsWith('topstories.json') ? [1, 2, 3, 4, 5, 6, 7] : itemMap[url.match(/item\/(\d+)\.json$/)?.[1]] ?? null,
    });
    expect(await s.run('top', args)).toHaveLength(5);
  });
});

describe('36kr hot board routing', () => {
  it('routes every board type to its own official URL before extraction', async () => {
    const s = setup('36kr.com', { url: 'https://www.36kr.com/' });
    expect(await s.run('hot', { type: 'renqi' })).toMatchObject({ __webcli_navigation: { version: 1, resume: true } });
    const renqiUrl = (await s.run('hot', { type: 'renqi' })).__webcli_navigation.url;
    expect(renqiUrl).toMatch(/^https:\/\/www\.36kr\.com\/hot-list\/renqi\/\d{4}-\d{2}-\d{2}\/1$/);
    const zonghe = await s.run('hot', { type: 'zonghe' });
    expect(zonghe.__webcli_navigation.url).toContain('/hot-list/zonghe/');
    const shoucang = await s.run('hot', { type: 'shoucang' });
    expect(shoucang.__webcli_navigation.url).toContain('/hot-list/shoucang/');
    const catalog = await s.run('hot', {});
    expect(catalog.__webcli_navigation.url).toBe('https://www.36kr.com/hot-list/catalog');
    expect(s.calls).toHaveLength(0);
  });

  it('formats board dates in Asia/Shanghai with the fixed offset', () => {
    const s = setup('36kr.com');
    const fixed = new Date('2026-03-25T18:30:00.000Z');
    expect(s.context.__kr36.getShanghaiDate(fixed)).toBe('2026-03-26');
    expect(s.context.__kr36.buildHotListUrl('renqi', fixed)).toBe('https://www.36kr.com/hot-list/renqi/2026-03-26/1');
    expect(s.context.__kr36.buildHotListUrl('catalog', fixed)).toBe('https://www.36kr.com/hot-list/catalog');
  });

  it('rejects unknown board types before navigation', async () => {
    const s = setup('36kr.com');
    await expect(s.run('hot', { type: 'daily' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(s.run('hot', { limit: '1.5' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(s.calls).toHaveLength(0);
  });

  it('extracts the rendered board with dedup, board context and limit', async () => {
    const boardUrl = 'https://www.36kr.com/hot-list/renqi/' + new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) + '/1';
    const links = [
      node('人均榜文章标题一', { attrs: { href: '/p/1001' } }),
      node('人均榜文章标题一', { attrs: { href: '/p/1001' } }),
      node('人均榜文章标题二', { attrs: { href: '/p/1002' } }),
      node('短标题', { attrs: { href: '/p/1003' } }),
      node('外部链接文字较长', { attrs: { href: 'https://36kr.com/p/1004' } }),
    ];
    const s = setup('36kr.com', { url: boardUrl, all: { 'a[href*="/p/"]': links } });
    const rows = await s.run('hot', { type: 'renqi', limit: '2' });
    expect(rows).toEqual([
      { rank: 1, title: '人均榜文章标题一', url: 'https://36kr.com/p/1001', type: 'renqi', board: '人气榜', board_url: boardUrl },
      { rank: 2, title: '人均榜文章标题二', url: 'https://36kr.com/p/1002', type: 'renqi', board: '人气榜', board_url: boardUrl },
    ]);
  });

  it('distinguishes render timeout from a page whose links cannot be parsed', async () => {
    const boardUrl = 'https://www.36kr.com/hot-list/catalog';
    const timeout = setup('36kr.com', { url: boardUrl, all: {} });
    await expect(timeout.run('hot', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('did not render') });
    const unparsable = setup('36kr.com', { url: boardUrl, all: { 'a[href*="/p/"]': [node('ab', { attrs: { href: '/p/1' } })] } });
    await expect(unparsable.run('hot', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('Could not retrieve') });
    const captcha = setup('36kr.com', { url: boardUrl, all: { 'a[href*="/p/"]': [node('一个标题', { attrs: { href: '/p/1' } })] }, bodyText: '请完成安全验证' });
    await expect(captcha.run('hot', {})).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
  });
});

describe('36kr news feed', () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>36氪</title>
<item>
  <title>红杉中国领投AI公司「示例」，金额近2亿元</title>
  <link><![CDATA[https://36kr.com/p/1111111111111111?f=rss]]></link>
  <pubDate>2026-03-26 10:00:00  +0800</pubDate>
  <description><![CDATA[<p>这是描述文本 &amp; 含实体</p>]]></description>
</item>
<item>
  <title></title>
  <link><![CDATA[https://36kr.com/p/2222222222222222?f=rss]]></link>
  <pubDate>2026-03-26 09:00:00  +0800</pubDate>
</item>
<item>
  <title>马斯克旗下xAI估值突破1000亿美元</title>
  <link><![CDATA[https://36kr.com/p/3333333333333333?f=rss]]></link>
  <pubDate>2026-03-25 20:00:00  +0800</pubDate>
</item>
</channel></rss>`;

  it('parses ranked RSS items with 120-character summaries', async () => {
    const s = setup('36kr.com', { payload: rss });
    const rows = await s.run('news', { limit: '2' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rank: 1,
      title: '红杉中国领投AI公司「示例」，金额近2亿元',
      summary: '这是描述文本 & 含实体',
      date: '2026-03-26',
      url: 'https://36kr.com/p/1111111111111111?f=rss',
    });
    expect(s.requests[0].url).toBe('https://www.36kr.com/feed');
    expect(s.requests[0].options.headers['User-Agent']).toContain('WeWorker-WebCLI');
    expect(s.requests[0].browserFallback).toBe(false);
    expect(s.requests[0].redactBodyInTrace).toBe(true);
  });

  it('reports HTTP, network and empty-feed failures instead of returning an empty array', async () => {
    const http = setup('36kr.com', { payload: rss, privileged: () => ({ ok: false, status: 503, url: 'https://www.36kr.com/feed', body: '' }) });
    await expect(http.run('news', {})).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    const network = setup('36kr.com', { payload: () => { throw new TypeError('network unavailable'); } });
    await expect(network.run('news', {})).rejects.toMatchObject({ code: 'FETCH_ERROR' });
    const empty = setup('36kr.com', { payload: '<?xml version="1.0"?><rss><channel></channel></rss>' });
    await expect(empty.run('news', {})).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    await expect(setup('36kr.com').run('news', { limit: '0' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('36kr search', () => {
  it('encodes the keyword and navigates through the official search route', async () => {
    const s = setup('36kr.com', { url: 'https://www.36kr.com/' });
    const result = await s.run('search', { query: '人工智能 AI' });
    expect(result).toMatchObject({ __webcli_navigation: { version: 1, resume: true } });
    expect(result.__webcli_navigation.url).toBe('https://www.36kr.com/search/articles/' + encodeURIComponent('人工智能 AI'));
    expect(s.calls).toHaveLength(0);
    await expect(setup('36kr.com').run('search', { query: ' ' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('extracts titled cards with dates and falls back to generic article links', async () => {
    const target = 'https://www.36kr.com/search/articles/' + encodeURIComponent('人工智能');
    const dateNode = node('2026-03-26');
    const card = node('', { one: { '[class*="time"]': dateNode } });
    const titled = node('AI 芯片新进展', { attrs: { href: '/p/2001' }, container: card });
    const s = setup('36kr.com', { url: target, all: { '.article-item-title a[href*="/p/"]': [titled], 'a[href*="/p/"]': [titled] } });
    expect(await s.run('search', { query: '人工智能', limit: '1' })).toEqual([
      { rank: 1, title: 'AI 芯片新进展', date: '2026-03-26', url: 'https://36kr.com/p/2001' },
    ]);

    const generic = node('一篇足够长的通用文章标题', { attrs: { href: '/p/2002' } });
    const fallback = setup('36kr.com', { url: target, all: { 'a[href*="/p/"]': [generic] } });
    expect(await fallback.run('search', { query: '人工智能' })).toEqual([
      { rank: 1, title: '一篇足够长的通用文章标题', date: '', url: 'https://36kr.com/p/2002' },
    ]);
  });

  it('distinguishes render timeout from a rendered page without matches', async () => {
    const target = 'https://www.36kr.com/search/articles/fixture';
    const timeout = setup('36kr.com', { url: target, all: {}, one: {} });
    await expect(timeout.run('search', { query: 'fixture' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('did not render') });
    const rendered = setup('36kr.com', { url: target, one: { '.search-result': node('结果区域') }, all: {} });
    await expect(rendered.run('search', { query: 'fixture' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });
});

describe('36kr article', () => {
  const articleUrl = 'https://www.36kr.com/p/1234567';
  const paragraphs = Array.from({ length: 30 }, (_, index) => node('段落内容编号' + String(index).padStart(2, '0') + '，' + '这是一段用于验证截断语义的正文内容。'.repeat(2)));
  const bodySelector = '[class*="article-content"] p, [class*="rich-text"] p, .article p';
  const articleDom = {
    one: {
      '.article-title': node('示例文章标题'),
      '.item-time': node('· 2026-03-26 10:00'),
    },
    all: {
      '.author-name': [node('示例作者')],
      [bodySelector]: paragraphs,
    },
  };

  it('accepts numeric ids and 36kr /p/ URLs, rejecting guessed or foreign input', async () => {
    const s = setup('36kr.com', { url: articleUrl, one: articleDom.one, all: articleDom.all });
    await s.run('article', { id: '1234567' });
    await s.run('article', { id: 'https://www.36kr.com/p/1234567?from=fixture' });
    const foreign = setup('36kr.com');
    for (const id of ['https://example.com/p/1234567', 'not-a-url', 'abc123', 'https://user:pass@www.36kr.com/p/1234567', '']) {
      await expect(foreign.run('article', { id })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    expect(foreign.calls).toHaveLength(0);
  });

  it('navigates to the article page before extraction', async () => {
    const s = setup('36kr.com', { url: 'https://www.36kr.com/' });
    expect(await s.run('article', { id: '1234567' })).toEqual({ __webcli_navigation: { version: 1, url: articleUrl, resume: true } });
    expect(s.calls).toHaveLength(0);
  });

  it('returns an 800-character body with explicit truncation and length semantics', async () => {
    const s = setup('36kr.com', { url: articleUrl, one: articleDom.one, all: articleDom.all });
    const rows = await s.run('article', { id: '1234567' });
    const byField = Object.fromEntries(rows.map((row) => [row.field, row.value]));
    expect(byField.title).toBe('示例文章标题');
    expect(byField.author).toBe('示例作者');
    expect(byField.date).toBe('2026-03-26 10:00');
    expect(byField.url).toBe('https://36kr.com/p/1234567');
    expect(byField.body.length).toBe(800);
    expect(byField.body_length).toBeGreaterThan(800);
    expect(byField.body_truncated).toBe(true);
    expect(byField.content_status).toContain('partial');
    expect(byField.content_status).toContain('full article is not returned');
  });

  it('keeps short bodies untruncated while still stating the completeness scope', async () => {
    const short = { one: articleDom.one, all: { [bodySelector]: [node('这是唯一的一段正文内容，长度超过十个字符。')] } };
    const s = setup('36kr.com', { url: articleUrl, one: short.one, all: short.all });
    const byField = Object.fromEntries((await s.run('article', { id: articleUrl })).map((row) => [row.field, row.value]));
    expect(byField.body_truncated).toBe(false);
    expect(byField.body).toBe('这是唯一的一段正文内容，长度超过十个字符。');
    expect(byField.body_length).toBe(byField.body.length);
    expect(byField.content_status).toContain('not guaranteed');
  });

  it('keeps empty author/date as empty strings (source semantics) and reports missing title/body separately', async () => {
    const noMeta = { one: { '.article-title': node('只有标题') }, all: { [bodySelector]: paragraphs } };
    const s = setup('36kr.com', { url: articleUrl, one: noMeta.one, all: noMeta.all });
    const byField = Object.fromEntries((await s.run('article', { id: '1234567' })).map((row) => [row.field, row.value]));
    expect(byField.author).toBe('');
    expect(byField.date).toBe('');

    const noTitle = setup('36kr.com', { url: articleUrl, one: { '[class*="article-content"]': node('正文容器') }, all: articleDom.all });
    await expect(noTitle.run('article', { id: '1234567' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    const noBody = setup('36kr.com', { url: articleUrl, one: articleDom.one, all: {} });
    await expect(noBody.run('article', { id: '1234567' })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
    const timeout = setup('36kr.com', { url: articleUrl, one: {}, all: {} });
    await expect(timeout.run('article', { id: '1234567' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('did not render') });
  });
});
