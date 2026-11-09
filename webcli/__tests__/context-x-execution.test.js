import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { compileResultBindings, extractBoundEntities } from '../result-bindings.js';
import { captureResult } from '../context-profile.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';
const root = resolve(import.meta.dirname, '../../adapters/x.com'), username = 'example_person', uid = '1234567890';
const ids = ['1937205528846655537', '1937205528846655599'];
function setup({ noAuthor = false, notificationTarget = true, captureDataOnly = false, captureError = false } = {}) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), requests = [], helpers = [], storage = new Map(); let pattern = '';
  const user = { __typename: 'User', rest_id: uid, core: { screen_name: username, name: 'Example person' }, legacy: { id_str: uid, screen_name: username, name: 'Example person', description: 'Example bio', created_at: '2020-01-01T00:00:00Z' } };
  const tweets = ids.map((id, index) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: { result: noAuthor ? {} : user } },
    note_tweet: { note_tweet_results: { result: { text: 'Example complete note content ' + '正文'.repeat(200) } } },
    legacy: { id_str: id, full_text: `Example post ${index} ` + '内容'.repeat(100), created_at: '2026-11-01T00:00:00Z', user_id_str: uid,
      extended_entities: { media: [{ type: 'photo', media_url_https: `https://pbs.twimg.com/media/example${index}.jpg` }] } } }));
  const tweetEntries = tweets.map(t => ({ entryId: 'tweet-' + t.rest_id, content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: t } } } }));
  const userEntry = { entryId: 'user-' + uid, content: { entryType: 'TimelineTimelineItem', itemContent: { user_results: { result: user } } } };
  const instructions = [{ type: 'TimelineAddEntries', entries: [...tweetEntries, userEntry] }, { type: 'TimelineTerminateTimeline', direction: 'Bottom' }];
  const timeline = { instructions }, list = { id_str: '7654321', name: 'Example list', mode: 'Private' };
  const notification = notificationTarget ? { __typename: 'TweetNotification', id: 'notification-example', tweet_result: { result: tweets[0] } } : { __typename: 'TimelineNotification', id: 'notification-example', message: { text: 'Example account notification' } };
  const payload = { data: {
    user: { result: { ...user, timeline_v2: { timeline }, timeline: { timeline } } }, tweetResult: { result: tweets[0] },
    threaded_conversation_with_injections_v2: timeline, home: { home_timeline_urt: timeline },
    search_by_raw_query: { search_timeline: { timeline } }, bookmark_timeline_v2: { timeline }, bookmark_collection_timeline: { timeline },
    list: { tweets_timeline: { timeline } },
    viewer: { bookmark_collections_slice: { items: [{ id: 'example-folder', name: 'Example folder' }] },
      list_management_timeline: { timeline: { instructions: [{ entries: [{ entryId: 'owned-subscribed-list-module-example', content: { itemContent: { list } } }] }] } },
      timeline_response: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [{ entryId: 'notification-example', content: { itemContent: notification } }] }] } } },
  } };
  const devicePayload = { globalObjects: { tweets: Object.fromEntries(tweets.map(t => [t.rest_id, t.legacy])), users: { [uid]: user.legacy } },
    timeline: { instructions: [{ addEntries: { entries: ids.map(id => ({ content: { item: { content: { tweet: { id } } } } })) } }] } };
  const clicks = [], flags = new Map(ids.map(id => [id, { liked: false, bookmarked: false }]));
  const articles = [...ids].reverse().map(id => {
    const ownLink = { href: `https://x.com/${username}/status/${id}` };
    const root = { querySelectorAll: selector => selector.includes('/status/') ? [ownLink, { href: `https://x.com/${username}/status/${ids[0]}` }] : [],
      querySelector: selector => {
        if (selector === 'a[href*="/status/"] time') return { closest: () => ownLink };
        const state = flags.get(id);
        const buttons = { '[data-testid="like"]': !state.liked, '[data-testid="unlike"]': state.liked,
          '[data-testid="bookmark"]': !state.bookmarked, '[data-testid="removeBookmark"]': state.bookmarked };
        if (!buttons[selector]) return null;
        return { click: () => { clicks.push({ id, selector }); if (selector.includes('Bookmark') || selector.includes('bookmark')) state.bookmarked = !state.bookmarked; else state.liked = !state.liked; } };
      } };
    return root;
  });
  const profileLink = { getAttribute: () => '/' + username };
  const trend = { textContent: 'Example topic', querySelector: s => s === ':scope > div' ? { children: [{ textContent: 'Trending' }, { textContent: 'Example topic' }] } : null };
  const context = { URL, URLSearchParams, Response, console, Date, location: new URL('https://x.com/home'),
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {}, scrollTo() {}, dispatchEvent() {}, PopStateEvent: class {},
    performance: { getEntriesByType: () => [] },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    document: { title: 'Example', cookie: 'ct0=example-placeholder', scripts: [], body: { innerText: '', scrollHeight: 100 },
      querySelector: s => s.includes('Profile_Link') ? profileLink : s.includes('primaryColumn') ? {} : null,
      querySelectorAll: s => s === 'article' ? articles : s === '[data-testid="trend"]' ? [trend] : s.includes('img[src') ? [{ src: 'https://pbs.twimg.com/media/example.jpg?format=jpg' }] : [] },
    fetch: async (input, options = {}) => {
      const url = new URL(input, context.location.href); requests.push({ url, options });
      if (!url.pathname.includes('/graphql/') && !url.pathname.includes('device_follow')) throw new Error(`Unexpected request ${url.pathname}`);
      return new Response(JSON.stringify(url.pathname.includes('device_follow') ? devicePayload : payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      helpers.push({ action });
      if (action === 'main_world_eval') return { value: await vm.runInContext(args.expression, context) };
      if (action === 'cookies_get') return [{ name: 'ct0', value: 'example-placeholder' }, { name: 'auth_token', value: 'example-placeholder' }];
      if (action === 'network_capture_start') { pattern = args.pattern; return {}; }
      if (action === 'network_capture_read') return { entries: [{ url: `https://x.com/i/api/graphql/example${pattern}`, responsePreview: JSON.stringify(captureError ? { errors: [{ message: 'Example capture error' }] } : captureDataOnly ? payload.data : payload) }] };
      throw new Error(`Unexpected helper ${action}`);
    } },
  };
  context.history = { pushState: (_state, _title, path) => { context.location = new URL(path, context.location.href); } };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const f of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', f), 'utf8'), context);
  for (const c of pkg.commands) vm.runInContext(readFileSync(resolve(root, c.module), 'utf8'), context);
  const entries = pkg.commands.map(c => ({ ...c, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  const run = (name, args = {}) => handlers.get(`x.com.${name}`)(args);
  return { context, requests, helpers, clicks, flags, articles, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run,
    read: async (name, args = {}) => { for (let i = 0; i < 5; i++) { const raw = await run(name, args); if (!raw.__webcli_navigation?.resume) return raw; context.location = new URL(raw.__webcli_navigation.url); } throw new Error('Unexpected navigation loop'); } };
}
function extract(s, command, args, raw) { return extractBoundEntities(s.catalog.resultBindings.get(`x.com.${command}`), args, raw); }
function capture(s, command, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `x.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state); registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true }); return { state, snapshot };
}
it.each([
  ['bookmark-folder', { 'folder-id': 'example-folder' }], ['bookmarks', {}], ['device-follow', {}], ['likes', { username }],
  ['list-tweets', { listId: '7654321' }], ['search', { query: 'Example' }], ['thread', { 'tweet-id': ids[0] }], ['timeline', {}],
  ['tweets', { username, 'page-delay': 0 }], ['collection', { username, until: '2026-01-01T00:00:00Z', 'page-delay': 0 }],
])('%s actual query routes reversed second post to its own thread with exact identity', async (command, args) => {
  const s = setup(), raw = await s.read(command, args), { state, snapshot } = capture(s, command, args, raw);
  expect(snapshot.entities.length).toBe(2);
  const result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: 'x.com.thread', args: { 'tweet-id': ids[0] } });
  const detail = await s.read('thread', result.steps[0].args); expect(detail[0].id).toBe(ids[0]);
});
it.each([
  ['article', { 'tweet-id': ids[0] }, 'thread', 'thread', { 'tweet-id': ids[0] }],
  ['download', { 'tweet-url': `https://x.com/${username}/status/${ids[0]}` }, 'source', 'thread', { 'tweet-id': ids[0] }],
  ['bookmark-folders', {}, 'detail', 'bookmark-folder', { 'folder-id': 'example-folder' }],
  ['lists', {}, 'detail', 'list-tweets', { listId: '7654321' }],
  ['followers', { user: username }, 'detail', 'profile', { username }], ['following', { user: username }, 'detail', 'profile', { username }],
  ['profile', { username }, 'detail', 'tweets', { username }], ['whoami', {}, 'detail', 'profile', { username }],
  ['trending', {}, 'search', 'search', { query: 'Example topic' }],
  ['notifications', {}, 'detail', 'thread', { 'tweet-id': ids[0] }],
])('%s runs its real query and declared %s follow-up', async (command, args, action, target, expected) => {
  const s = setup(), raw = await s.read(command, args), b = extract(s, command, args, raw).entities[0].bindings[action];
  expect(b).toMatchObject({ ready: true, tool: `x.com.${target}`, args: expected });
  const { state, snapshot } = capture(s, command, args, raw);
  const decision = await routeContext(state, snapshot.actions.find(a => a.id === action).label + '这条', { catalog: s.catalog, now: 1001 });
  expect(decision.steps[0]).toMatchObject({ tool: b.tool, args: expected });
  const next = await s.read(target, decision.steps[0].args); expect(Array.isArray(next) ? next.length > 0 : !!next).toBe(true);
});
it('a notification with no target tweet cannot bind its notification ID or notifications URL to post actions', async () => {
  const s = setup({ notificationTarget: false }), raw = await s.read('notifications');
  for (const b of Object.values(extract(s, 'notifications', {}, raw).entities[0].bindings)) expect(b.ready).toBe(false);
});
it('an unknown author is not replaced by an invented unknown handle', async () => {
  const s = setup({ noAuthor: true }), raw = await s.read('thread', { 'tweet-id': ids[0] });
  expect(extract(s, 'thread', { 'tweet-id': ids[0] }, raw).entities[0].bindings.author.ready).toBe(false);
});
it('reply text clarification survives persistence while retaining the selected tweet URL', async () => {
  const s = setup(), args = { 'tweet-id': ids[0] }, raw = await s.read('thread', args), { state } = capture(s, 'thread', args, raw);
  const pending = await routeContext(state, '回复帖子第二条', { catalog: s.catalog, now: 1001 });
  expect(pending.missingFields).toEqual(['arguments.text']);
  const result = await routeContext(JSON.parse(JSON.stringify(state)), 'Example reply body', { catalog: s.catalog, now: 1002, replyTo: pending.clarificationId });
  expect(result.steps[0]).toMatchObject({ tool: 'x.com.reply', args: { url: `https://x.com/i/status/${ids[0]}`, text: 'Example reply body' } });
});

it.each([['like', false], ['unlike', true], ['bookmark', false], ['unbookmark', true]])('%s uses the selected primary post, not a preceding post quoting it', async (action, initial) => {
  const s = setup(), args = { 'tweet-id': ids[0] }, raw = await s.read('thread', args), b = extract(s, 'thread', args, raw).entities[0].bindings[action];
  s.flags.get(ids[0]).liked = initial; s.flags.get(ids[0]).bookmarked = initial;
  s.context.location = new URL(b.args.url);
  const result = await s.run(action, b.args); expect(result[0].status).toBe('success');
  expect(s.clicks).toHaveLength(1); expect(s.clicks[0].id).toBe(ids[0]);
});
it('a quoted link alone cannot authorize liking its containing parent post', async () => {
  const s = setup(); s.articles.pop(); s.context.location = new URL(`https://x.com/i/status/${ids[0]}`);
  await expect(s.run('like', { url: s.context.location.href })).rejects.toThrow(); expect(s.clicks).toHaveLength(0);
});

it('single-tweet media uses the returned target identity and excludes other posts and page images', async () => {
  const s = setup(), raw = await s.read('download', { 'tweet-url': `https://x.com/${username}/status/${ids[1]}` });
  expect(raw).toHaveLength(1); expect(raw[0]).toMatchObject({ tweet_id: ids[1], url: 'https://pbs.twimg.com/media/example1.jpg' });
  expect(raw[0].url).not.toContain('example0');
});

it('selection titles are bounded while full post content and collection completion evidence remain intact', async () => {
  const s = setup(), args = { username, until: '2026-01-01T00:00:00Z', 'page-delay': 0 }, raw = await s.read('collection', args);
  expect(raw.receipt.completed).toBe(true); expect(raw.posts[0].text).toContain('正文'.repeat(200));
  expect(Buffer.byteLength(raw.posts[0].context_title)).toBeLessThanOrEqual(240);
});

it.each(['followers', 'notifications'])('%s also routes a captured response that already contains the GraphQL data object', async command => {
  const s = setup({ captureDataOnly: true }), args = command === 'followers' ? { user: username } : {}, raw = await s.read(command, args);
  expect(raw.length).toBeGreaterThan(0); expect(extract(s, command, args, raw).entities[0].bindings.detail.ready).toBe(true);
});
it.each(['followers', 'notifications'])('%s reports captured GraphQL errors instead of an empty successful result', async command => {
  const s = setup({ captureError: true }); await expect(s.read(command, command === 'followers' ? { user: username } : {})).rejects.toThrow(/GraphQL/);
});

it('selected X like prepares its target page before any write or evaluation', async () => {
  const s = setup(), result = await s.run('like', { url: `https://x.com/i/status/${ids[0]}` });
  expect(result).toMatchObject({ __webcli_navigation: { url: `https://x.com/i/status/${ids[0]}`, resume: false, phase: 'prepare', result: { executed: false } } });
  expect(s.clicks).toEqual([]); expect(s.helpers).toEqual([]);
});
