/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/*.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page commands run through the host navigation
 * resume protocol; the RSS feed is fetched by the restricted backend_fetch
 * helper. Bounded DOM polling replaces the source's fixed waits and every
 * empty/timeout/error outcome is explicit. No OpenCLI runtime is reused. */
(function () {
  class CliError extends Error {
    constructor(code, message, hint) { super(hint ? message + ' — ' + hint : message); this.code = code; }
  }
  class ArgumentError extends CliError {
    constructor(message) { super('INVALID_ARGS', message); }
  }
  class CommandExecutionError extends CliError {
    constructor(message, hint) { super('COMMAND_EXEC', message, hint); }
  }
  class HttpError extends CliError {
    constructor(message) { super('HTTP_ERROR', message); }
  }
  class FetchError extends CliError {
    constructor(message) { super('FETCH_ERROR', message); }
  }
  class EmptyResultError extends CliError {
    constructor(message, hint) { super('EMPTY_RESULT', message, hint); }
  }

  const HOT_TYPE_MAP = {
    renqi: '人气榜',
    zonghe: '综合榜',
    shoucang: '收藏榜',
    catalog: '热门资讯',
  };
  /* Client-rendered pages are polled for at most ~5s (16 x 300ms), matching the
   * source's 5s deadline. Timeout is reported explicitly, never as an empty list. */
  const RENDER_POLL_ROUNDS = 16;
  const RENDER_POLL_INTERVAL_MS = 300;
  /* The source article command only returns the first 800 characters of the
   * extracted page text; this cap is preserved and made explicit in the output. */
  const ARTICLE_BODY_MAX_CHARS = 800;

  function integerArg(name, value, fallback, max) {
    const raw = value === undefined ? fallback : value;
    const parsed = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      throw new ArgumentError(name + ' must be an integer between 1 and ' + max);
    }
    return parsed;
  }

  function navigate(url) {
    return { __webcli_navigation: { version: 1, url, resume: true } };
  }

  function same(url) {
    const a = new URL(location.href);
    const b = new URL(url);
    return a.origin === b.origin && a.pathname === b.pathname
      && [...a.searchParams].length === [...b.searchParams].length
      && [...a.searchParams].every(([k, v]) => a.searchParams.getAll(k).join('\0') === b.searchParams.getAll(k).join('\0'));
  }

  function guard() {
    const text = document.body?.innerText || '';
    if (/验证码|安全验证|滑动验证|访问验证/.test(text)) {
      throw new CliError('CAPTCHA_REQUIRED', 'Complete 36kr verification in the connected browser');
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(probe) {
    for (let round = 0; round < RENDER_POLL_ROUNDS; round += 1) {
      if (await probe()) return true;
      await sleep(RENDER_POLL_INTERVAL_MS);
    }
    return false;
  }

  function getShanghaiDate(date = new Date()) {
    /* Shanghai stays on UTC+8 year-round, so a fixed offset is sufficient and
     * avoids the slow Intl timezone path (source note). */
    return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function buildHotListUrl(listType, date = new Date()) {
    if (listType === 'catalog') {
      return 'https://www.36kr.com/hot-list/catalog';
    }
    return 'https://www.36kr.com/hot-list/' + listType + '/' + getShanghaiDate(date) + '/1';
  }

  function normalizeArticleUrl(href) {
    if (!href) return '';
    return href.startsWith('http') ? href : 'https://36kr.com' + href;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  /* Strict article identity: a bare numeric id, or an http(s) URL on a 36kr.com
   * host whose path contains /p/<digits>. The source also stripped every
   * non-digit from arbitrary input; that guessing is intentionally not kept. */
  function parseArticleId(input) {
    const raw = String(input ?? '').trim();
    if (/^\d+$/.test(raw)) return raw;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      if (host !== '36kr.com' && !host.endsWith('.36kr.com')) return null;
      const match = url.pathname.match(/\/p\/(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function hotTypeLabel(type) {
    return HOT_TYPE_MAP[type] || null;
  }

  window.__kr36 = {
    CliError,
    ArgumentError,
    CommandExecutionError,
    HttpError,
    FetchError,
    EmptyResultError,
    HOT_TYPE_MAP,
    ARTICLE_BODY_MAX_CHARS,
    integerArg,
    navigate,
    same,
    guard,
    sleep,
    waitFor,
    getShanghaiDate,
    buildHotListUrl,
    normalizeArticleUrl,
    normalizeText,
    parseArticleId,
    hotTypeLabel,
  };
})();
