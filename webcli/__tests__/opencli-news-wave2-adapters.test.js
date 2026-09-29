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

/* Minimal DOM node mock. `parents` is the ancestor chain (nearest first) used
 * by closest(); `.cls` selectors match any whitespace-separated class. */
function matchesClassSelector(el, selector) {
  if (!el || typeof selector !== 'string') return false;
  const classes = String(selector).split(',').flatMap((part) => part.trim().split(/\s+/));
  const own = String(el.className || '').split(/\s+/);
  return classes.every((cls) => !cls.startsWith('.') || own.includes(cls.slice(1)));
}

function node(text = '', { one = {}, all = {}, attrs = {}, className = '', parents = [] } = {}) {
  return {
    textContent: text,
    innerText: text,
    className,
    parentElement: parents[0] || null,
    querySelector: (selector) => one[selector] || selector.split(',').map((part) => one[part.trim()]).find(Boolean) || null,
    querySelectorAll: (selector) => all[selector] || selector.split(',').flatMap((part) => all[part.trim()] || []),
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selector) => parents.find((parent) => matchesClassSelector(parent, selector)) || null,
  };
}

function setup(site, { url, payload = {}, bodyText = '', title = '', one = {}, all = {}, privileged } = {}) {
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
      title,
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
    ['123', { id: 123, type: 'story', by: 'hn-fix-author', score: 42, title: 'Ask HN: Example', text: '<p>Hello <a href="https://example.com">world</a></p>', url: 'https://news.ycombinator.com/item?id=123', kids: [456] }],
    ['456', { id: 456, type: 'comment', by: 'hn-fix-replier', text: '<p>Top level</p>', kids: [789] }],
  ]);
  const treeSetup = (map = tree) => setup('news.ycombinator.com', {
    payload: (url) => map.get(url.match(/item\/(\d+)\.json$/)?.[1]) ?? null,
  });

  it('renders the story header, indented comments and hidden-reply stubs from the source fixture', async () => {
    const rows = await treeSetup().run('read', { id: '123', limit: 5, depth: 1, replies: 5, 'max-length': 2000 });
    expect(rows).toEqual([
      { type: 'POST', author: 'hn-fix-author', score: 42, text: 'Ask HN: Example\nHello world (https://example.com)\nhttps://news.ycombinator.com/item?id=123' },
      { type: 'L0', author: 'hn-fix-replier', score: '', text: 'Top level' },
      { type: 'L1', author: '', score: '', text: '  [+1 more replies]' },
    ]);
  });

  it('keeps absent author/score unknown instead of fabricating 0 or [deleted]', async () => {
    const minimal = new Map([
      ['1', { id: 1, type: 'story', title: 'Minimal fixture story', kids: [2] }],
      ['2', { id: 2, type: 'comment', text: 'comment without author' }],
    ]);
    const rows = await treeSetup(minimal).run('read', { id: '1', limit: 5, depth: 1 });
    expect(rows[0]).toMatchObject({ type: 'POST', author: null, score: null });
    expect(rows[0].text).toBe('Minimal fixture story');
    expect(rows[1]).toMatchObject({ type: 'L0', author: null, text: 'comment without author' });
    expect(JSON.stringify(rows)).not.toContain('[deleted]');
    const zeroScore = new Map([['3', { id: 3, type: 'story', title: 'Zero score fixture', score: 0 }]]);
    const zero = await treeSetup(zeroScore).run('read', { id: '3' });
    expect(zero[0]).toMatchObject({ type: 'POST', score: 0, author: null });
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
      payload: (url) => url.endsWith('/user/fixture-user.json') ? { id: 'fixture-user', created: 1160418111, karma: 1, about: '<i>hi</i>' } : null,
    });
    expect(await s.run('user', { username: 'fixture-user' })).toEqual({ username: 'fixture-user', karma: 1, created: '2006-10-09', about: '<i>hi</i>' });
    expect(s.requests[0].url).toBe('https://hacker-news.firebaseio.com/v0/user/fixture-user.json');
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

/* ---- 36kr helpers: board rows wrapped like the verified live DOM ---- */
function boardWrapper(title, href, className = 'article-wrapper') {
  const titleLink = node(title, { attrs: { href }, className: 'article-item-title weight-bold' });
  return node('', { className, one: { '.article-item-title': titleLink } });
}

function boardList(wrappers, { inSection = false, section = null } = {}) {
  return node('', { className: 'article-list', all: { '.article-wrapper': wrappers }, parents: inSection && section ? [section] : [] });
}

function boardSection(labelText, wrappers, boardHref) {
  const one = { '.list-title': node(labelText, { className: 'list-title' }) };
  if (boardHref !== null) one['.list-title a[href]'] = node('', { attrs: { href: boardHref } });
  return node('', { className: 'list-section-wrapper', one, all: { '.article-wrapper': wrappers } });
}

function boardDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

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

  it('extracts the dated board from its own list, ignoring sidebar recommendations', async () => {
    const date = boardDate();
    const boardUrl = 'https://www.36kr.com/hot-list/renqi/' + date + '/1';
    const sidebarSection = boardSection('36氪综合榜查看完整榜单', [boardWrapper('侧栏推荐文章标题', '/p/9001')], '/hot-list/zonghe/' + date + '/1');
    const sidebarList = boardList([boardWrapper('侧栏推荐文章标题', '/p/9001')], { inSection: true, section: sidebarSection });
    const mainList = boardList([
      boardWrapper('人气榜文章标题一', '/p/1001'),
      boardWrapper('人气榜文章标题一', '/p/1001'), // duplicate url collapses
      boardWrapper('人气榜文章标题二', '/p/1002'),
    ]);
    const s = setup('36kr.com', {
      url: boardUrl,
      title: '资讯人气榜' + date + '_36氪',
      all: { '.article-list': [mainList, sidebarList] },
    });
    const rows = await s.run('hot', { type: 'renqi', limit: '2' });
    expect(rows).toEqual([
      { rank: 1, title: '人气榜文章标题一', url: 'https://www.36kr.com/p/1001', type: 'renqi', board: '人气榜', board_url: boardUrl },
      { rank: 2, title: '人气榜文章标题二', url: 'https://www.36kr.com/p/1002', type: 'renqi', board: '人气榜', board_url: boardUrl },
    ]);
  });

  it('attributes catalog rows to the board section they actually come from', async () => {
    const date = boardDate();
    const sections = [
      boardSection('36氪人气榜查看完整榜单', [boardWrapper('人气榜分区内文章', '/p/1001'), boardWrapper('人气榜分区第二篇', '/p/1002')], '/hot-list/renqi/' + date + '/1'),
      boardSection('36氪综合榜查看完整榜单', [boardWrapper('人气榜分区内文章', '/p/1001'), boardWrapper('综合榜分区内文章', '/p/2001')], '/hot-list/zonghe/' + date + '/1'),
      boardSection('36氪研究院精选', [boardWrapper('未知分区文章不应入选', '/p/7001')], null),
    ];
    const s = setup('36kr.com', {
      url: 'https://www.36kr.com/hot-list/catalog',
      title: '36氪资讯热榜频道_36氪',
      all: { '.list-section-wrapper': sections },
    });
    const rows = await s.run('hot', { type: 'catalog', limit: '4' });
    expect(rows).toEqual([
      { rank: 1, title: '人气榜分区内文章', url: 'https://www.36kr.com/p/1001', type: 'catalog', board: '人气榜', board_url: 'https://www.36kr.com/hot-list/renqi/' + date + '/1' },
      { rank: 2, title: '人气榜分区第二篇', url: 'https://www.36kr.com/p/1002', type: 'catalog', board: '人气榜', board_url: 'https://www.36kr.com/hot-list/renqi/' + date + '/1' },
      /* The same article legitimately appears again as a real row of 综合榜. */
      { rank: 3, title: '人气榜分区内文章', url: 'https://www.36kr.com/p/1001', type: 'catalog', board: '综合榜', board_url: 'https://www.36kr.com/hot-list/zonghe/' + date + '/1' },
      { rank: 4, title: '综合榜分区内文章', url: 'https://www.36kr.com/p/2001', type: 'catalog', board: '综合榜', board_url: 'https://www.36kr.com/hot-list/zonghe/' + date + '/1' },
    ]);
  });

  it('fails on a page whose board sections are all unrecognized', async () => {
    const s = setup('36kr.com', {
      url: 'https://www.36kr.com/hot-list/catalog',
      title: '36氪资讯热榜频道_36氪',
      all: { '.list-section-wrapper': [boardSection('36氪研究院精选', [boardWrapper('未知分区文章', '/p/7001')], null)] },
    });
    await expect(s.run('hot', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('no recognized board section') });
  });

  it('never treats page-wide recommendation links as a board (full page with only recommendations)', async () => {
    const boardUrl = 'https://www.36kr.com/hot-list/renqi/' + boardDate() + '/1';
    const recommendations = { 'a[href*="/p/"]': [node('一条与榜单无关的推荐内容标题', { attrs: { href: '/p/9999' } })] };
    const s = setup('36kr.com', { url: boardUrl, title: '资讯人气榜' + boardDate() + '_36氪', all: recommendations });
    await expect(s.run('hot', { type: 'renqi' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('board area was not found') });
    const catalog = setup('36kr.com', { url: 'https://www.36kr.com/hot-list/catalog', title: '36氪资讯热榜频道_36氪', all: recommendations });
    await expect(catalog.run('hot', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('board area was not found') });
  });

  it('reports a persistently empty board region as a render anomaly, never as an empty board', async () => {
    const date = boardDate();
    const boardUrl = 'https://www.36kr.com/hot-list/renqi/' + date + '/1';
    const dated = setup('36kr.com', { url: boardUrl, title: '资讯人气榜' + date + '_36氪', all: { '.article-list': [boardList([])] } });
    await expect(dated.run('hot', { type: 'renqi' })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('no entries appeared'),
    });
    const catalog = setup('36kr.com', {
      url: 'https://www.36kr.com/hot-list/catalog',
      title: '36氪资讯热榜频道_36氪',
      all: { '.list-section-wrapper': [boardSection('36氪人气榜查看完整榜单', [], null)] },
    });
    await expect(catalog.run('hot', {})).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('no entries appeared'),
    });
  });

  it('waits for late-filling rows instead of misreporting a still-loading board as empty', async () => {
    const date = boardDate();
    /* The container renders before its rows: the first polls see an empty
     * .article-list / recognized section, later polls see the filled one. */
    let datedPolls = 0;
    const datedRows = [boardWrapper('延迟填充的人气榜文章', '/p/1001')];
    const dated = setup('36kr.com', {
      url: 'https://www.36kr.com/hot-list/renqi/' + date + '/1',
      title: '资讯人气榜' + date + '_36氪',
      all: {
        get '.article-list'() {
          datedPolls += 1;
          return [boardList(datedPolls < 3 ? [] : datedRows)];
        },
      },
    });
    expect(await dated.run('hot', { type: 'renqi' })).toEqual([
      { rank: 1, title: '延迟填充的人气榜文章', url: 'https://www.36kr.com/p/1001', type: 'renqi', board: '人气榜', board_url: 'https://www.36kr.com/hot-list/renqi/' + date + '/1' },
    ]);
    expect(datedPolls).toBeGreaterThanOrEqual(3);

    let catalogPolls = 0;
    const catalogRows = [boardWrapper('延迟填充的分区文章', '/p/2001')];
    const catalog = setup('36kr.com', {
      url: 'https://www.36kr.com/hot-list/catalog',
      title: '36氪资讯热榜频道_36氪',
      all: {
        get '.list-section-wrapper'() {
          catalogPolls += 1;
          return [boardSection('36氪人气榜查看完整榜单', catalogPolls < 3 ? [] : catalogRows, '/hot-list/renqi/' + date + '/1')];
        },
      },
    });
    expect(await catalog.run('hot', {})).toEqual([
      { rank: 1, title: '延迟填充的分区文章', url: 'https://www.36kr.com/p/2001', type: 'catalog', board: '人气榜', board_url: 'https://www.36kr.com/hot-list/renqi/' + date + '/1' },
    ]);
    expect(catalogPolls).toBeGreaterThanOrEqual(3);
  });

  it('distinguishes a not-yet-rendered board from unparseable rows', async () => {
    const date = boardDate();
    const boardUrl = 'https://www.36kr.com/hot-list/renqi/' + date + '/1';
    const timeout = setup('36kr.com', { url: boardUrl, all: {} });
    await expect(timeout.run('hot', { type: 'renqi' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('did not render') });
    const brokenRows = boardList([
      boardWrapper('', '/p/1001'), // no title text
      boardWrapper('有标题但外域链接', 'https://example.com/p/1002'),
    ]);
    const unparsable = setup('36kr.com', { url: boardUrl, title: '资讯人气榜' + date + '_36氪', all: { '.article-list': [brokenRows] } });
    await expect(unparsable.run('hot', { type: 'renqi' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('Could not parse') });
    const captcha = setup('36kr.com', {
      url: boardUrl, title: '资讯人气榜' + date + '_36氪',
      all: { '.article-list': [boardList([boardWrapper('人气榜文章标题一', '/p/1001')])] },
      bodyText: '请完成安全验证',
    });
    await expect(captcha.run('hot', { type: 'renqi' })).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' });
  });

  it('refuses to relabel a rendered page whose board differs from the request', async () => {
    const date = boardDate();
    const boardUrl = 'https://www.36kr.com/hot-list/renqi/' + date + '/1';
    const mainList = boardList([boardWrapper('综合榜内容文章', '/p/3001')]);
    const s = setup('36kr.com', { url: boardUrl, title: '资讯综合榜' + date + '_36氪', all: { '.article-list': [mainList] } });
    await expect(s.run('hot', { type: 'renqi' })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('Requested board 人气榜'),
    });
    const untitled = setup('36kr.com', { url: 'https://www.36kr.com/hot-list/catalog', title: '36氪首页', all: { '.list-section-wrapper': [boardSection('36氪人气榜查看完整榜单', [boardWrapper('标题', '/p/1')], null)] } });
    await expect(untitled.run('hot', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('Requested board 热榜') });
  });
});

describe('36kr news feed', () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>36氪</title>
<item>
  <title><![CDATA[红杉中国领投AI公司「示例」 A &amp; B &#65;]]></title>
  <link><![CDATA[https://36kr.com/p/1111111111111111?f=rss]]></link>
  <pubDate>Tue, 26 Mar 2026 10:00:00 +0800</pubDate>
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
  <pubDate>这不是一个日期</pubDate>
</item>
</channel></rss>`;

  it('parses ranked RSS items with full dates, CDATA and entities', async () => {
    const s = setup('36kr.com', { payload: rss });
    const rows = await s.run('news', { limit: '2' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      rank: 1,
      title: '红杉中国领投AI公司「示例」 A & B A',
      summary: '这是描述文本 & 含实体',
      date: '2026-03-26T02:00:00.000Z',
      url: 'https://36kr.com/p/1111111111111111?f=rss',
    });
    expect(rows[1].date).toBe(null); // invalid pubDate stays unknown instead of being guessed
    expect(s.requests[0].url).toBe('https://www.36kr.com/feed');
    expect(s.requests[0].options.headers['User-Agent']).toContain('WeWorker-WebCLI');
    expect(s.requests[0].browserFallback).toBe(false);
    expect(s.requests[0].redactBodyInTrace).toBe(true);
  });

  it('accepts the simplified feed-style pubDate and emits the full timestamp', async () => {
    const feed = '<rss version="2.0"><channel><item><title>示例资讯</title><link>https://36kr.com/p/4444444444444444</link><pubDate>2026-03-26 09:00:00 +0800</pubDate></item></channel></rss>';
    const s = setup('36kr.com', { payload: feed });
    expect(await s.run('news', {})).toEqual([
      { rank: 1, title: '示例资讯', summary: '', date: '2026-03-26T01:00:00.000Z', url: 'https://36kr.com/p/4444444444444444' },
    ]);
  });

  it('separates interface failures (HTTP 200 HTML / malformed XML) from a genuinely empty feed', async () => {
    const http = setup('36kr.com', { payload: rss, privileged: () => ({ ok: false, status: 503, url: 'https://www.36kr.com/feed', body: '' }) });
    await expect(http.run('news', {})).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    const network = setup('36kr.com', { payload: () => { throw new TypeError('network unavailable'); } });
    await expect(network.run('news', {})).rejects.toMatchObject({ code: 'FETCH_ERROR' });
    const htmlErrorPage = setup('36kr.com', { payload: '<!DOCTYPE html><html><body>upstream error page</body></html>' });
    await expect(htmlErrorPage.run('news', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('HTML document') });
    const malformed = setup('36kr.com', { payload: 'not-an-rss-document at all' });
    await expect(malformed.run('news', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('could not be parsed') });
    const empty = setup('36kr.com', { payload: '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>' });
    await expect(empty.run('news', {})).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
    await expect(setup('36kr.com').run('news', { limit: '0' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('rejects structurally broken RSS envelopes instead of reporting an empty feed', async () => {
    for (const xml of [
      '<rss><channel></channel>',                                            // unclosed root <rss>
      '<rss><channel><item><title>x</title></channel></rss>',                 // unclosed <item>
      '<rss><channel></channel><item><title>x</title></item></rss>',          // item outside the channel
      '<rss><channel></channel></rss><rss><channel></channel></rss>',         // two roots
      '<feed><entry><title>x</title></entry></feed>',                         // root is not rss
    ]) {
      const s = setup('36kr.com', { payload: xml });
      await expect(s.run('news', {})).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('could not be parsed') });
    }
    /* Items that all fail projection (no usable title anywhere) are a parse
     * error, not an empty feed. */
    const untitled = setup('36kr.com', { payload: '<rss><channel><item><description>x</description></item><item><link>https://36kr.com/p/6666666666666666</link></item></channel></rss>' });
    await expect(untitled.run('news', {})).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('none had a usable title'),
    });
  });

  it('never lets CDATA pseudo-markup count as items, fields or an HTML error page', async () => {
    /* A description CDATA carrying an <html> body and fake <item>/<title>
     * text: the document must still parse as RSS with exactly one real item
     * and must not be mistaken for an HTML error page. */
    const cdataFeed = '<rss version="2.0"><channel><item><title>真实条目标题</title><link>https://36kr.com/p/5555555555555555</link><pubDate>2026-03-26 09:00:00 +0800</pubDate><description><![CDATA[<html><body>伪页面正文</body></html> 与伪条目文字 <item><title>伪条目标题</title></item> 以及 <rss></rss> <channel></channel>]]></description></item></channel></rss>';
    const s = setup('36kr.com', { payload: cdataFeed });
    const rows = await s.run('news', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rank: 1, title: '真实条目标题', url: 'https://36kr.com/p/5555555555555555', date: '2026-03-26T01:00:00.000Z' });
    expect(rows[0].summary).toContain('伪页面正文');
    expect(rows[0].summary).not.toContain('<item>');
    /* Whole-document HTML detection fires only on a real root/doctype: a
     * feed whose only <html> text sits inside CDATA is not an error page. */
    const cdataOnlyHtml = '<?xml version="1.0"?><rss version="2.0"><channel><item><title>仅CDATA含html</title><description><![CDATA[<html>not an error page</html>]]></description></item></channel></rss>';
    const htmlInCdata = setup('36kr.com', { payload: cdataOnlyHtml });
    expect(await htmlInCdata.run('news', {})).toEqual([
      { rank: 1, title: '仅CDATA含html', summary: 'not an error page', date: null, url: '' },
    ]);
  });
});

describe('36kr search', () => {
  const target = (query) => 'https://www.36kr.com/search/articles/' + encodeURIComponent(query);

  it('encodes the keyword and navigates through the official search route', async () => {
    const s = setup('36kr.com', { url: 'https://www.36kr.com/' });
    const result = await s.run('search', { query: '人工智能 AI' });
    expect(result).toMatchObject({ __webcli_navigation: { version: 1, resume: true } });
    expect(result.__webcli_navigation.url).toBe(target('人工智能 AI'));
    expect(s.calls).toHaveLength(0);
    await expect(setup('36kr.com').run('search', { query: ' ' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('extracts only cards from the trusted result list and skips invalid links', async () => {
    const cards = [
      node('AI 芯片新进展', { attrs: { href: '/p/2001' }, className: 'article-item-title weight-bold' }),
      node('外站链接不应入选', { attrs: { href: 'https://example.com/p/9999' }, className: 'article-item-title' }),
      node('协议相对链接不应入选', { attrs: { href: '//example.org/p/8888' }, className: 'article-item-title' }),
      node('AI 芯片新进展', { attrs: { href: '/p/2001' }, className: 'article-item-title weight-bold' }), // duplicate url
    ];
    const s = setup('36kr.com', {
      url: target('人工智能'),
      one: { '.kr-search-result-list': node('', { className: 'kr-search-result-list' }) },
      all: {
        '.kr-search-result-list-main .article-item-title': cards,
        'a[href*="/p/"]': [node('与搜索无关的推荐文章标题', { attrs: { href: '/p/7007' } })],
      },
    });
    expect(await s.run('search', { query: '人工智能', limit: '5' })).toEqual([
      { rank: 1, title: 'AI 芯片新进展', date: '', url: 'https://www.36kr.com/p/2001' },
    ]);
  });

  it('treats the page no-result notice as the only genuine empty state', async () => {
    const s = setup('36kr.com', {
      url: target('不存在的词条'),
      one: { '.kr-search-result-list': node('', { className: 'kr-search-result-list', one: { '.kr-search-nodata': node('很抱歉，没有找到相关结果') } }) },
      all: {},
    });
    await expect(s.run('search', { query: '不存在的词条' })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });

  it('fails on a result area that has neither cards nor a no-result notice (never empty)', async () => {
    const s = setup('36kr.com', {
      url: target('异常'),
      one: { '.kr-search-result-list': node('', { className: 'kr-search-result-list' }) },
      all: {},
    });
    await expect(s.run('search', { query: '异常' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('did not render') });
  });

  it('never treats page-wide recommendation links as search results', async () => {
    const s = setup('36kr.com', {
      url: target('任意'),
      all: { 'a[href*="/p/"]': [node('一条与结果无关的推荐内容标题', { attrs: { href: '/p/9998' } })] },
    });
    await expect(s.run('search', { query: '任意' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('without the trusted result area') });
  });

  it('reports a render timeout and an inconsistent page separately', async () => {
    const timeout = setup('36kr.com', { url: target('fixture'), all: {}, one: {} });
    await expect(timeout.run('search', { query: 'fixture' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('did not render') });
    const inconsistent = setup('36kr.com', {
      url: target('fixture'),
      one: { '.kr-search-result-list': node('', { className: 'kr-search-result-list', one: { '.kr-search-nodata': node('很抱歉') } }) },
      all: { '.kr-search-result-list-main .article-item-title': [node('结果标题', { attrs: { href: '/p/3001' } })] },
    });
    await expect(inconsistent.run('search', { query: 'fixture' })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('both results and a no-result notice') });
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

  it('accepts numeric ids and strict official /p/ URLs only', async () => {
    const s = setup('36kr.com', { url: articleUrl, one: articleDom.one, all: articleDom.all });
    await s.run('article', { id: '1234567' });
    await s.run('article', { id: 'https://www.36kr.com/p/1234567?from=fixture' });
    await s.run('article', { id: 'https://36kr.com/p/1234567/' });
    await s.run('article', { id: 'https://www.36kr.com/p/1234567#section' });
    const foreign = setup('36kr.com');
    for (const id of [
      'https://www.36kr.com/p/123abc',   // trailing junk after digits
      'https://www.36kr.com/foo/p/123',  // non-article path containing /p/
      'https://example.com/p/1234567',   // foreign host
      'https://m.36kr.com/p/1234567',    // unofficial 36kr subdomain
      'https://sub.36kr.com/p/1234567',
      'http://www.36kr.com/p/1234567',   // non-https protocol
      'https://user:pass@www.36kr.com/p/1234567',
      '//www.36kr.com/p/1234567',        // protocol-relative
      'not-a-url', 'abc123', '',
      '0123456',                          // leading zero
      '123456789012345678',               // too long for a safe integer
    ]) {
      await expect(foreign.run('article', { id })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    }
    expect(foreign.calls).toHaveLength(0);
  });

  it('canonicalizes board and search links, rejecting foreign or partial ones', () => {
    const s = setup('36kr.com');
    const api = s.context.__kr36;
    expect(api.normalizeArticleUrl('/p/2001')).toBe('https://www.36kr.com/p/2001');
    expect(api.normalizeArticleUrl('https://36kr.com/p/1004?from=hot')).toBe('https://www.36kr.com/p/1004');
    expect(api.normalizeArticleUrl('https://www.36kr.com/p/1004/')).toBe('https://www.36kr.com/p/1004');
    expect(api.normalizeArticleUrl('//example.org/p/1')).toBe(null);
    expect(api.normalizeArticleUrl('https://example.com/p/9')).toBe(null);
    expect(api.normalizeArticleUrl('/p/123abc')).toBe(null);
    expect(api.normalizeArticleUrl('/newsflashes/123')).toBe(null);
    expect(api.normalizeArticleUrl('')).toBe(null);
    expect(api.parseArticleId('https://www.36kr.com/p/123abc')).toBe(null);
    expect(api.parseArticleId('https://www.36kr.com/foo/p/123')).toBe(null);
    expect(api.parseArticleId('https://www.36kr.com/p/123/')).toBe('123');
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
    expect(byField.url).toBe('https://www.36kr.com/p/1234567');
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
