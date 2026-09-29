/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/news.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background execution through the restricted
 * backend_fetch helper. The source silently returned [] on HTTP failure; this
 * version reports HTTP errors explicitly. The document must actually be an
 * RSS envelope: a bounded structure scan validates root/channel/item closure
 * and nesting, so an HTTP 200 HTML error page, malformed XML (unclosed or
 * mismatched rss/channel/item tags) and format drift are parse errors, never
 * empty results; items that exist but cannot be projected (no usable title)
 * are parse errors too. Pseudo-tags inside CDATA sections count as neither
 * items nor error envelopes. Only a structurally valid channel with zero
 * items is a genuine empty feed. Titles decode CDATA/XML entities and dates
 * come from the full pubDate (ISO 8601 UTC) instead of a 10-character slice
 * that could lose the year; an invalid or missing pubDate stays null rather
 * than being guessed. */
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

    /* Envelope validation via the bounded structure scan (CDATA-aware): an
     * HTTP 200 HTML error page, malformed XML or drifted structure is an
     * interface/parse failure, never an empty result. */
    const doc = api.parseRssEnvelope(xml);
    if (doc.isHtml) {
      throw new api.CommandExecutionError('36kr feed returned an HTML document instead of RSS', 'The feed endpoint may be degraded or its format changed');
    }
    if (doc.error) {
      throw new api.CommandExecutionError('36kr feed could not be parsed as an RSS document (' + doc.error + ')', 'The feed format may have changed or the response is malformed');
    }

    /* Item children come from the scan (names lowercased), so pseudo-tags
     * inside CDATA sections never become phantom items or fields. */
    const items = [];
    for (const item of doc.items) {
      const title = api.decodeXmlText(item.title ?? '');
      if (!title) continue;
      const url = api.decodeXmlText(item.link ?? '');
      /* Full ISO 8601 date from a valid pubDate; null when missing/invalid. */
      const date = api.parseRssDate(item.pubdate ?? '');
      /* Plain-text summary from the HTML description (first ~120 chars, source semantics). */
      const summary = api.decodeXmlText(item.description ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      items.push({ rank: items.length + 1, title, summary, date, url });
    }
    if (!doc.items.length) {
      throw new api.EmptyResultError('36kr feed has no items', 'The feed channel is valid but empty');
    }
    if (!items.length) {
      throw new api.CommandExecutionError(
        '36kr feed has ' + doc.items.length + ' item(s) but none had a usable title',
        'The feed item structure may have changed; items that cannot be projected are reported instead of silently dropped',
      );
    }
    return items.slice(0, limit);
  });
})();
