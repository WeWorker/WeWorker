/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/news.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background execution through the restricted
 * backend_fetch helper. The source silently returned [] on HTTP failure; this
 * version reports HTTP errors explicitly. The document must actually be an
 * RSS envelope (an HTTP 200 HTML error page or malformed XML is a parse error,
 * not an empty result); only a valid RSS channel with no items is a genuine
 * empty feed. Titles decode CDATA/XML entities and dates come from the full
 * pubDate (ISO 8601 UTC) instead of a 10-character slice that could lose the
 * year; an invalid or missing pubDate stays null rather than being guessed. */
(function () {
  const FEED_URL = 'https://www.36kr.com/feed';

  __webcliRegisterCommand('news', async (args = {}) => {
    const api = window.__kr36;
    const limit = api.integerArg('limit', args.limit, 20, 50);
    let response;
    try {
      response = await window.__webmcpWecliRuntime.requestPrivileged('backend_fetch', {
        url: FEED_URL,
        browserFallback: false,
        redactBodyInTrace: true,
        options: {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WeWorker-WebCLI/1.0)' },
        },
      });
    } catch {
      throw new api.FetchError('36kr feed request failed; check connectivity and retry');
    }
    if (response?.redirected || (response?.url && response.url !== FEED_URL) || (response?.status >= 300 && response?.status < 400)) {
      throw new api.HttpError('36kr feed redirected unexpectedly');
    }
    if (!response?.ok) throw new api.HttpError('36kr feed returned HTTP ' + String(response?.status));
    const xml = String(response.body || '');

    /* Envelope validation: an HTTP 200 HTML error page or a malformed
     * document is an interface/parse failure, never an empty result. */
    if (/<html[\s>]|<!doctype html/i.test(xml)) {
      throw new api.CommandExecutionError('36kr feed returned an HTML document instead of RSS', 'The feed endpoint may be degraded or its format changed');
    }
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml) || !/<\/channel>/i.test(xml)) {
      throw new api.CommandExecutionError('36kr feed could not be parsed as an RSS document', 'The feed format may have changed');
    }
    const channel = xml.match(/<channel[\s>][\s\S]*?<\/channel>/i)?.[0] || '';

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(channel)) && items.length < limit) {
      const block = match[1];
      const title = api.decodeXmlText(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
      if (!title) continue;
      const linkRaw = block.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/)?.[1]
        ?? block.match(/<link>([\s\S]*?)<\/link>/)?.[1]
        ?? '';
      const url = api.decodeXmlText(linkRaw);
      /* Full ISO 8601 date from a valid pubDate; null when missing/invalid. */
      const date = api.parseRssDate(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '');
      /* Plain-text summary from the HTML description (first ~120 chars, source semantics). */
      const rawDesc = api.decodeXmlText(block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
        ?? block.match(/<description>([\s\S]*?)<\/description>/)?.[1]
        ?? '');
      const summary = rawDesc
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      items.push({ rank: items.length + 1, title, summary, date, url });
    }
    if (!items.length) {
      throw new api.EmptyResultError('36kr feed has no items', 'The feed channel is valid but empty');
    }
    return items;
  });
})();
