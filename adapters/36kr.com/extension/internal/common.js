/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/*.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page commands run through the host navigation
 * resume protocol; the RSS feed is fetched by the restricted backend_fetch
 * helper. Bounded DOM polling replaces the source's fixed waits and every
 * empty/timeout/error outcome is explicit. Article identity accepts only the
 * official hosts and a whole /p/<digits> path (anchored, no digit-guessing);
 * list links that are not official article URLs are dropped, not rewritten.
 * RSS text decodes CDATA/entities and dates parse the full pubDate. No
 * OpenCLI runtime is reused. */
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
  /* Official article hosts only; everything else (m. mirrors, foreign domains,
   * protocol-relative //host/p/...) is rejected rather than rewritten. */
  const OFFICIAL_HOSTS = new Set(['36kr.com', 'www.36kr.com']);
  /* 36kr article ids are plain decimal strings without leading zeros. At most
   * 16 digits so every accepted id is also an exactly representable safe
   * integer — ids that would lose precision when handled numerically are
   * rejected instead of silently becoming another id. */
  const ARTICLE_ID_RE = /^[1-9]\d{0,15}$/;
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

  /* Canonicalize an article link seen in a board/search DOM into
   * https://www.36kr.com/p/<id>, or null when it is not an official article
   * path. Relative links resolve against the official origin; foreign hosts,
   * protocol-relative //host/p/ links and non-article paths are rejected. */
  function normalizeArticleUrl(href) {
    if (!href || typeof href !== 'string') return null;
    let url;
    try {
      url = new URL(href.trim(), 'https://www.36kr.com');
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!OFFICIAL_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/p\/(\d{1,16})\/?$/);
    if (!match || !ARTICLE_ID_RE.test(match[1]) || !Number.isSafeInteger(Number(match[1]))) return null;
    return 'https://www.36kr.com/p/' + match[1];
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  /* Strict article identity: a bare decimal id (no leading zeros, safe as an
   * integer), or an https:// URL on an official 36kr.com host whose whole path
   * is /p/<digits> (an optional trailing slash is fine; query/hash are ignored
   * for identity). Partial matches like /p/123abc or /foo/p/123 are rejected —
   * the source also stripped every non-digit from arbitrary input; that
   * guessing is intentionally not kept. */
  function parseArticleId(input) {
    const raw = String(input ?? '').trim();
    if (ARTICLE_ID_RE.test(raw) && Number.isSafeInteger(Number(raw))) return raw;
    if (!/^https:\/\//i.test(raw)) return null;
    try {
      const url = new URL(raw);
      if (url.username || url.password) return null;
      if (!OFFICIAL_HOSTS.has(url.hostname.toLowerCase())) return null;
      const match = url.pathname.match(/^\/p\/(\d{1,16})\/?$/);
      if (!match || !ARTICLE_ID_RE.test(match[1]) || !Number.isSafeInteger(Number(match[1]))) return null;
      return match[1];
    } catch {
      return null;
    }
  }

  function hotTypeLabel(type) {
    return HOT_TYPE_MAP[type] || null;
  }

  /* ---- Board-page DOM binding (verified read-only evidence, 2026-09-29) ----
   * Dated board pages (/hot-list/<type>/<date>/1) render one .article-list that
   * is NOT inside a .list-section-wrapper, with .article-wrapper rows each
   * holding an a.article-item-title; their <title> is "资讯<board><date>_36氪".
   * The catalog page renders three .list-section-wrapper boards (36氪人气榜/
   * 综合榜/收藏榜) of ten .article-wrapper rows each; <title> contains 热榜. */
  const BOARD_LABELS = ['人气榜', '综合榜', '收藏榜'];

  function boardLabelFromPageTitle(title) {
    const text = String(title || '');
    const match = BOARD_LABELS.find((label) => text.includes(label));
    if (match) return match;
    return text.includes('热榜') ? '热榜' : null;
  }

  /* Catalog section titles look like "36氪人气榜查看完整榜单". */
  function sectionBoardLabel(text) {
    const value = String(text || '');
    return BOARD_LABELS.find((label) => value.includes(label)) || null;
  }

  /* ---- RSS helpers (news) ----
   * CDATA plus a minimal single-pass XML entity decode; no new dependency. */
  const XML_NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function xmlCodePoint(code) {
    if (!Number.isSafeInteger(code) || code < 0x20 || code > 0x10ffff) return '';
    if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) return '';
    try { return String.fromCodePoint(code); } catch { return ''; }
  }

  function decodeXmlText(value) {
    let text = String(value ?? '').trim();
    const cdata = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) text = cdata[1].trim();
    return text
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => xmlCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => xmlCodePoint(Number(dec)))
      .replace(/&([a-zA-Z]+);/g, (whole, name) => Object.prototype.hasOwnProperty.call(XML_NAMED_ENTITIES, name) ? XML_NAMED_ENTITIES[name] : whole)
      .trim();
  }

  /* ---- Bounded XML structure scan (RSS envelope) ----
   * Single left-to-right pass with no new dependency. Comments, CDATA
   * sections, processing instructions and declarations are skipped as whole
   * units, so markup-looking text inside them never opens or closes an
   * element (a fake <item> or <html> inside a description CDATA is neither
   * an item nor an error envelope). Every real element is recorded with its
   * parent index and inner text range; well-formedness is tag matching: each
   * end tag must close the innermost open element and nothing may stay open
   * at end of input. */
  function findStartTagEnd(text, from) {
    let quote = '';
    for (let j = from + 1; j < text.length; j += 1) {
      const ch = text.charAt(j);
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') return j;
    }
    return -1;
  }

  function findDeclarationEnd(text, from) {
    let quote = '';
    let depth = 0;
    for (let j = from + 2; j < text.length; j += 1) {
      const ch = text.charAt(j);
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth += 1;
      else if (ch === ']') depth = depth > 0 ? depth - 1 : 0;
      else if (ch === '>' && depth === 0) return j;
    }
    return -1;
  }

  function scanXmlElements(xml) {
    const text = String(xml ?? '');
    const elements = [];
    const stack = [];
    let error = null;
    let firstElementName = null;
    let sawHtmlDoctype = false;
    let i = 0;
    while (i < text.length && error === null) {
      const lt = text.indexOf('<', i);
      if (lt < 0) break;
      const next = text.charAt(lt + 1);
      if (next === '!') {
        if (text.startsWith('<!--', lt)) {
          const end = text.indexOf('-->', lt + 4);
          if (end < 0) { error = 'unterminated comment'; break; }
          i = end + 3;
        } else if (text.startsWith('<![CDATA[', lt)) {
          const end = text.indexOf(']]>', lt + 9);
          if (end < 0) { error = 'unterminated CDATA section'; break; }
          i = end + 3;
        } else {
          const close = findDeclarationEnd(text, lt);
          if (close < 0) { error = 'unterminated declaration'; break; }
          if (/^<!doctype\s+html(\s|$)/i.test(text.slice(lt, close))) sawHtmlDoctype = true;
          i = close + 1;
        }
      } else if (next === '?') {
        const end = text.indexOf('?>', lt + 2);
        if (end < 0) { error = 'unterminated processing instruction'; break; }
        i = end + 2;
      } else if (next === '/') {
        const end = text.indexOf('>', lt + 2);
        if (end < 0) { error = 'unterminated end tag'; break; }
        const name = text.slice(lt + 2, end).trim().split(/\s+/)[0].toLowerCase();
        const openIndex = stack.pop();
        if (openIndex === undefined || elements[openIndex].name !== name) {
          error = 'unexpected closing tag </' + name + '>';
          break;
        }
        elements[openIndex].innerEnd = lt;
        i = end + 1;
      } else if (/[A-Za-z_:]/.test(next)) {
        const close = findStartTagEnd(text, lt);
        if (close < 0) { error = 'unterminated start tag'; break; }
        let last = close - 1;
        while (last > lt && /\s/.test(text.charAt(last))) last -= 1;
        const selfClosing = text.charAt(last) === '/';
        const name = text.slice(lt + 1, selfClosing ? last : close).trim().split(/\s+/)[0].toLowerCase();
        const element = {
          name,
          index: elements.length,
          parentIndex: stack.length ? stack[stack.length - 1] : -1,
          innerStart: close + 1,
          innerEnd: close + 1,
        };
        elements.push(element);
        if (firstElementName === null) firstElementName = name;
        if (!selfClosing) stack.push(element.index);
        i = close + 1;
      } else {
        error = 'unexpected markup';
        break;
      }
    }
    if (error === null && stack.length) {
      error = 'unclosed element <' + elements[stack[stack.length - 1]].name + '>';
    }
    return { error, elements, firstElementName, sawHtmlDoctype };
  }

  /* Validate the RSS envelope and collect item children. Returns exactly one
   * of: { isHtml: true } when the document's real root element (or doctype)
   * is HTML — an HTTP 200 HTML error page, where CDATA content never counts;
   * { error } with a concrete reason for any structural problem (tag
   * mismatch, unclosed root/channel/item, root is not a single <rss>,
   * channel missing or repeated, items outside the channel); or
   * { items: [...] } where each item maps every child element name
   * (lowercased, first occurrence) to its raw inner text. Only items that are
   * real children of the single real <channel> are returned. A structurally
   * valid channel with zero items is a legitimate empty feed — the caller
   * decides that, not this parser. */
  function parseRssEnvelope(xml) {
    const text = String(xml ?? '');
    const scan = scanXmlElements(text);
    if (scan.firstElementName === 'html' || scan.sawHtmlDoctype) return { isHtml: true, error: null, items: [] };
    if (scan.error) return { isHtml: false, error: scan.error, items: [] };
    const roots = scan.elements.filter((element) => element.parentIndex === -1);
    if (roots.length !== 1) return { isHtml: false, error: 'expected one root element, found ' + roots.length, items: [] };
    if (roots[0].name !== 'rss') return { isHtml: false, error: 'root element is not <rss>', items: [] };
    const channels = scan.elements.filter((element) => element.parentIndex === roots[0].index && element.name === 'channel');
    if (channels.length !== 1) return { isHtml: false, error: 'expected one <channel> inside <rss>, found ' + channels.length, items: [] };
    if (scan.elements.some((element) => element.name === 'item' && element.parentIndex === roots[0].index)) {
      return { isHtml: false, error: 'found <item> elements outside <channel>', items: [] };
    }
    const items = [];
    for (const element of scan.elements) {
      if (element.parentIndex !== channels[0].index || element.name !== 'item') continue;
      const child = {};
      for (const sub of scan.elements) {
        if (sub.parentIndex !== element.index || child[sub.name] !== undefined) continue;
        child[sub.name] = text.slice(sub.innerStart, sub.innerEnd);
      }
      items.push(child);
    }
    return { isHtml: false, error: null, items };
  }

  /* Standard RFC 822 pubDate ("Tue, 26 Mar 2026 18:30:00 +0800"), plus the
   * simplified "2026-03-26 18:30:00 +0800" form the live feed emits. Anything
   * else (or an unparseable value) is null — never a guessed date. */
  const RSS_DATE_RFC822_RE = /^(?:[A-Za-z]{3},\s*)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[+-]\d{4}|UT|GMT|UTC|[A-Za-z])$/;
  const RSS_DATE_ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?\s*[+-]\d{4}$/;

  function parseRssDate(value) {
    const raw = decodeXmlText(value).replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    if (!RSS_DATE_RFC822_RE.test(raw) && !RSS_DATE_ISO_LIKE_RE.test(raw)) return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
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
    BOARD_LABELS,
    boardLabelFromPageTitle,
    sectionBoardLabel,
    decodeXmlText,
    parseRssEnvelope,
    parseRssDate,
  };
})();
