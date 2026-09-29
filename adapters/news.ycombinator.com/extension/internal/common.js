/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/hackernews/*.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: background API execution through the restricted
 * backend_fetch helper (declared API hosts, manual redirects, redacted traces),
 * strict argument/ID validation and a bounded per-invocation item request budget.
 * Absent fields (author/score) stay null — unknown is never rewritten into a
 * fabricated 0 or "[deleted]"; deletion is only claimed for items the API
 * itself marks deleted. No OpenCLI runtime or pipeline engine is reused. */
(function () {
  class CliError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  class ArgumentError extends CliError {
    constructor(message) { super('INVALID_ARGS', message); }
  }
  class CommandExecutionError extends CliError {
    constructor(message) { super('COMMAND_EXEC', message); }
  }
  class HttpError extends CliError {
    constructor(message) { super('HTTP_ERROR', message); }
  }
  class FetchError extends CliError {
    constructor(message) { super('FETCH_ERROR', message); }
  }
  class EmptyResultError extends CliError {
    constructor(message, hint) { super('EMPTY_RESULT', hint || message); }
  }

  const FIREBASE_ITEM_BASE = 'https://hacker-news.firebaseio.com/v0/item';
  /* Single read invocation may fetch at most this many story/comment items.
   * Documented in guidance.md and docs/opencli_news_wave2_migration.md. */
  const READ_REQUEST_BUDGET = 200;
  const HN_USERNAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

  function integerArg(name, value, fallback, min, max) {
    const raw = value === undefined ? fallback : value;
    const parsed = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new ArgumentError(name + ' must be an integer between ' + min + ' and ' + max);
    }
    return parsed;
  }

  function itemUrl(id) {
    return FIREBASE_ITEM_BASE + '/' + encodeURIComponent(String(id)) + '.json';
  }

  async function fetchJson(url) {
    let response;
    try {
      response = await window.__webmcpWecliRuntime.requestPrivileged('backend_fetch', {
        url,
        browserFallback: false,
        redactBodyInTrace: true,
        options: { method: 'GET', redirect: 'manual' },
      });
    } catch {
      throw new FetchError('Hacker News API request failed; check connectivity and retry');
    }
    if (response?.redirected || (response?.url && response.url !== url) || (response?.status >= 300 && response?.status < 400)) {
      throw new HttpError('Hacker News API redirected unexpectedly');
    }
    if (!response?.ok) throw new HttpError('Hacker News API returned HTTP ' + String(response?.status));
    let payload;
    try { payload = JSON.parse(response.body); } catch { throw new CommandExecutionError('Hacker News API returned invalid JSON'); }
    return payload;
  }

  /* HN stores comment text as a small HTML subset — convert to plain text. */
  function htmlToText(html) {
    if (!html) return '';
    return String(html)
      .replace(/<p>/gi, '\n\n')
      .replace(/<\/p>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<i>(.*?)<\/i>/gi, '$1')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
      .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '\n$1\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x2F;/g, '/')
      .trim();
  }

  function indentLines(text, depth) {
    if (depth === 0) return text;
    const indent = '  '.repeat(depth);
    const prefix = indent + '> ';
    return text.split('\n').map((line) => prefix + line).join('\n');
  }

  function moreRepliesIndent(depth) {
    return '  '.repeat(depth + 1);
  }

  /* Listing commands keep the source pre-fetch cap: ids fetched are
   * min(limit + 10, 50); deleted/dead/untitled items are dropped afterwards. */
  async function storyList(endpoint, limit, withCounts) {
    const ids = await fetchJson(endpoint);
    if (!Array.isArray(ids)) throw new CommandExecutionError('Hacker News API returned no story id list');
    const idsToFetch = ids.slice(0, Math.min(limit + 10, 50));
    const items = await Promise.all(idsToFetch.map((id) => fetchJson(itemUrl(id))));
    const rows = [];
    for (const item of items) {
      if (!item || !item.title || item.deleted || item.dead) continue;
      const row = { rank: rows.length + 1, id: item.id, title: item.title };
      if (withCounts) {
        row.score = item.score ?? null;
        row.author = item.by ?? null;
        row.comments = item.descendants ?? null;
      } else {
        row.author = item.by ?? null;
      }
      row.url = item.url ?? null;
      rows.push(row);
      if (rows.length >= limit) break;
    }
    if (!rows.length) throw new EmptyResultError('No Hacker News stories available', 'The list is empty or every item is deleted, dead or untitled');
    return rows;
  }

  async function algoliaSearch(query, limit, sort) {
    const url = new URL('https://hn.algolia.com/api/v1/' + (sort === 'date' ? 'search_by_date' : 'search'));
    url.searchParams.set('query', query);
    url.searchParams.set('tags', 'story');
    url.searchParams.set('hitsPerPage', String(limit));
    const payload = await fetchJson(url.toString());
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.hits)) {
      throw new CommandExecutionError('Algolia search response has no hits array');
    }
    const rows = payload.hits
      .filter((hit) => hit && typeof hit === 'object')
      .map((hit, index) => ({
        rank: index + 1,
        id: hit.objectID != null ? String(hit.objectID) : null,
        title: hit.title ?? null,
        score: hit.points ?? null,
        author: hit.author ?? null,
        comments: hit.num_comments ?? null,
        url: hit.url ?? null,
      }))
      .slice(0, limit);
    if (!rows.length) throw new EmptyResultError('No Hacker News stories matched the query');
    return rows;
  }

  async function readStory(args) {
    const rawId = args.id === undefined || args.id === null ? '' : String(args.id);
    if (!/^\d+$/.test(rawId.trim())) {
      throw new ArgumentError('Invalid HN item id: ' + JSON.stringify(args.id ?? '') + '; pass a numeric id like 39847301');
    }
    const id = rawId.trim();
    const limit = integerArg('limit', args.limit, 25, 1, 1000);
    const maxDepth = integerArg('depth', args.depth, 2, 1, 100);
    const maxReplies = integerArg('replies', args.replies, 5, 1, 1000);
    const maxLength = integerArg('max-length', args['max-length'], 2000, 100, 100000);

    const budget = { remaining: READ_REQUEST_BUDGET };
    let failedFetches = 0;
    let budgetReached = false;

    async function fetchMany(ids) {
      const take = Math.min(ids.length, Math.max(0, budget.remaining));
      if (take < ids.length) budgetReached = true;
      budget.remaining -= take;
      return Promise.all(ids.slice(0, take).map(async (nodeId) => {
        try { return await fetchJson(itemUrl(nodeId)); }
        catch { failedFetches += 1; return null; }
      }));
    }

    budget.remaining -= 1;
    const story = await fetchJson(itemUrl(id));
    if (!story || story.deleted || story.dead) {
      throw new EmptyResultError('hackernews/' + id, 'Story not found, deleted, or dead');
    }

    const results = [];

    const storyBodyRaw = htmlToText(story.text || '');
    const storyBody = storyBodyRaw.length > maxLength
      ? storyBodyRaw.slice(0, maxLength) + '\n... [truncated]'
      : storyBodyRaw;
    const storyParts = [story.title || ''];
    if (storyBody) storyParts.push('\n' + storyBody);
    if (story.url) storyParts.push('\n' + story.url);
    results.push({
      type: 'POST',
      /* Missing by/score stay null (unknown); a real 0 score is preserved.
       * "[deleted]" is only used when the API itself reports deleted items,
       * and those are skipped before rendering. */
      author: story.by ?? null,
      score: typeof story.score === 'number' ? story.score : null,
      text: storyParts.join('').trim(),
    });

    async function walkComment(node, depth) {
      if (!node || node.deleted || node.dead || node.type !== 'comment') return;
      const bodyText = htmlToText(node.text || '');
      const truncated = bodyText.length > maxLength
        ? bodyText.slice(0, maxLength) + '...'
        : bodyText;
      results.push({
        type: depth === 0 ? 'L0' : 'L' + depth,
        /* Missing author stays null (unknown); deleted/dead comments are
         * skipped above, so absence here never implies deletion. */
        author: node.by ?? null,
        score: '',
        text: indentLines(truncated, depth),
      });

      const childIds = Array.isArray(node.kids) ? node.kids : [];

      if (depth + 1 >= maxDepth) {
        if (childIds.length > 0) {
          results.push({
            type: 'L' + (depth + 1),
            author: '',
            score: '',
            text: moreRepliesIndent(depth) + '[+' + childIds.length + ' more replies]',
          });
        }
        return;
      }

      const toProcessCount = Math.min(childIds.length, maxReplies);
      const replies = await fetchMany(childIds.slice(0, toProcessCount));
      for (const reply of replies) await walkComment(reply, depth + 1);

      const hidden = childIds.length - toProcessCount;
      if (hidden > 0) {
        results.push({
          type: 'L' + (depth + 1),
          author: '',
          score: '',
          text: moreRepliesIndent(depth) + '[+' + hidden + ' more replies]',
        });
      }
    }

    const topKids = Array.isArray(story.kids) ? story.kids : [];
    const requested = topKids.slice(0, limit);
    const fetched = await fetchMany(requested);
    for (const comment of fetched) await walkComment(comment, 0);

    const hiddenTopLevel = Math.max(0, topKids.length - fetched.length);
    if (hiddenTopLevel > 0) {
      results.push({
        type: '',
        author: '',
        score: '',
        text: '[+' + hiddenTopLevel + ' more top-level comments]',
      });
    }
    if (budgetReached) {
      results.push({
        type: '',
        author: '',
        score: '',
        text: '[request budget of ' + READ_REQUEST_BUDGET + ' item fetches reached; remaining branches are not expanded]',
      });
    }
    if (failedFetches > 0) {
      results.push({
        type: '',
        author: '',
        score: '',
        text: '[' + failedFetches + ' comment fetch(es) failed and were skipped]',
      });
    }
    return results;
  }

  async function userProfile(args) {
    const username = typeof args.username === 'string' ? args.username.trim() : '';
    if (!HN_USERNAME_RE.test(username)) {
      throw new ArgumentError('Invalid HN username: ' + JSON.stringify(args.username ?? '') + '; pass the account name like example-user');
    }
    const payload = await fetchJson('https://hacker-news.firebaseio.com/v0/user/' + encodeURIComponent(username) + '.json');
    if (!payload || typeof payload !== 'object' || !payload.id) {
      throw new EmptyResultError('hackernews user ' + username, 'User not found on Hacker News');
    }
    const created = Number.isFinite(payload.created)
      ? new Date(payload.created * 1000).toISOString().slice(0, 10)
      : '';
    return {
      username: payload.id,
      karma: typeof payload.karma === 'number' ? payload.karma : null,
      created: created || null,
      about: typeof payload.about === 'string' ? payload.about : null,
    };
  }

  window.__hackernews = {
    CliError,
    ArgumentError,
    CommandExecutionError,
    HttpError,
    FetchError,
    EmptyResultError,
    READ_REQUEST_BUDGET,
    integerArg,
    itemUrl,
    fetchJson,
    htmlToText,
    storyList,
    algoliaSearch,
    readStory,
    userProfile,
  };
})();
