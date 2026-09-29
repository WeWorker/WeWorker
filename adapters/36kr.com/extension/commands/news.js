/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/news.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2 background execution through the restricted
 * backend_fetch helper. The source silently returned [] on HTTP failure; this
 * version reports the HTTP error explicitly. */
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
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) && items.length < limit) {
      const block = match[1];
      const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
      const url = block.match(/<link><!\[CDATA\[(.*?)\]\]>/)?.[1]
        ?? block.match(/<link>(.*?)<\/link>/)?.[1]
        ?? '';
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() ?? '';
      const date = pubDate.slice(0, 10);
      /* Plain-text summary from the HTML description (first ~120 chars, source semantics). */
      const rawDesc = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? '';
      const summary = rawDesc
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (title) {
        items.push({ rank: items.length + 1, title, summary, date, url: url.trim() });
      }
    }
    if (!items.length) {
      throw new api.EmptyResultError('36kr feed has no items', 'The feed may be empty or its format changed');
    }
    return items;
  });
})();
