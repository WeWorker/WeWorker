/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/search.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page navigation through the host resume protocol;
 * the keyword stays strictly URL-encoded and render timeouts are separated
 * from genuine empty result lists. */
(function () {
  __webcliRegisterCommand('search', async (args = {}) => {
    const api = window.__kr36;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new api.ArgumentError('query must be a non-empty string');
    const limit = api.integerArg('limit', args.limit, 20, 50);
    const target = 'https://www.36kr.com/search/articles/' + encodeURIComponent(query);
    if (!api.same(target)) return api.navigate(target);
    api.guard();
    const rendered = await api.waitFor(async () =>
      Boolean(document.querySelector('.article-item-title, [class*="article-item"], .search-result, [class*="search-result"]'))
      || document.querySelectorAll('a[href*="/p/"]').length > 0);
    if (!rendered) {
      throw new api.CommandExecutionError('36kr search page did not render results within the wait budget', 'The page may still be loading or 36kr changed its DOM structure');
    }
    const seen = new Set();
    const items = [];
    /* article-item-title contains the clickable title link (source selector). */
    const titleEls = document.querySelectorAll('.article-item-title a[href*="/p/"], .article-item-title[href*="/p/"]');
    for (const el of Array.from(titleEls)) {
      const href = el.getAttribute('href') || '';
      const title = el.textContent?.trim() || '';
      if (!title || seen.has(href)) continue;
      seen.add(href);
      const item = typeof el.closest === 'function' ? (el.closest('[class*="article-item"]') || el.parentElement) : el.parentElement;
      const dateEl = typeof item?.querySelector === 'function' ? item.querySelector('[class*="time"], [class*="date"], time') : null;
      const date = dateEl?.textContent?.trim() || '';
      items.push({ title, url: api.normalizeArticleUrl(href), date });
    }
    /* Fallback: generic /p/ links with meaningful text (source behavior). */
    if (!items.length) {
      for (const el of Array.from(document.querySelectorAll('a[href*="/p/"]'))) {
        const href = el.getAttribute('href') || '';
        const title = el.textContent?.trim() || '';
        if (!title || title.length < 8 || seen.has(href) || seen.has(title)) continue;
        seen.add(href);
        seen.add(title);
        items.push({ title, url: api.normalizeArticleUrl(href), date: '' });
      }
    }
    if (!items.length) {
      throw new api.EmptyResultError('No 36kr articles matched the query', 'Try a different query or check your keyword');
    }
    return items.slice(0, limit).map((item, index) => ({
      rank: index + 1,
      title: item.title,
      date: item.date,
      url: item.url,
    }));
  });
})();
