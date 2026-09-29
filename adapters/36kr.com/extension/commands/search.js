/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/search.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page navigation through the host resume protocol;
 * the keyword stays strictly URL-encoded. Results are bound to the verified
 * result region (ul.kr-search-result-list-main article cards); the previous
 * unconditional whole-page /p/ fallback is gone because it mixed recommended
 * content into search results. A genuine empty state is only reported when
 * the page's own no-result notice (.kr-search-nodata) is present; a result
 * area without items and without that notice is a structure error. Region
 * shape verified against the live read-only DOM on 2026-09-29. */
(function () {
  __webcliRegisterCommand('search', async (args = {}) => {
    const api = window.__kr36;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new api.ArgumentError('query must be a non-empty string');
    const limit = api.integerArg('limit', args.limit, 20, 50);
    const target = 'https://www.36kr.com/search/articles/' + encodeURIComponent(query);
    if (!api.same(target)) return api.navigate(target);
    api.guard();

    /* Wait for the trusted result region: either article cards or the page's
     * own no-result notice. Any other /p/ links (header/footer/recommendation
     * slots) never count as rendered results. */
    const rendered = await api.waitFor(async () => {
      const area = document.querySelector('.kr-search-result-list');
      if (!area) return false;
      if (typeof area.querySelector === 'function' && area.querySelector('.kr-search-nodata')) return true;
      return document.querySelectorAll('.kr-search-result-list-main .article-item-title').length > 0;
    });
    if (!rendered) {
      if (document.querySelectorAll('a[href*="/p/"]').length > 0) {
        /* The page has content but no trusted result region — recommendation
         * and navigation links are never treated as search results. */
        throw new api.CommandExecutionError('36kr search page rendered without the trusted result area', '36kr may have changed its DOM structure; page-level links are not treated as results');
      }
      throw new api.CommandExecutionError('36kr search result area did not render within the wait budget', 'The page may still be loading or 36kr changed its DOM structure');
    }

    const area = document.querySelector('.kr-search-result-list');
    const noResultNotice = typeof area.querySelector === 'function' && Boolean(area.querySelector('.kr-search-nodata'));
    const titleEls = Array.from(document.querySelectorAll('.kr-search-result-list-main .article-item-title'));
    if (!titleEls.length) {
      if (noResultNotice) {
        throw new api.EmptyResultError('No 36kr articles matched the query', 'Try a different query or check your keyword');
      }
      throw new api.CommandExecutionError('36kr search result area rendered without article cards and without a no-result notice', '36kr may have changed its search result structure');
    }
    if (noResultNotice && titleEls.length) {
      throw new api.CommandExecutionError('36kr search page shows both results and a no-result notice', '36kr may have changed its search result structure');
    }
    const seen = new Set();
    const items = [];
    for (const el of titleEls) {
      const href = el.getAttribute('href') || '';
      const title = (el.textContent || '').trim();
      const url = api.normalizeArticleUrl(href);
      if (!title || !url || seen.has(url)) continue;
      seen.add(url);
      /* Result cards currently expose no date element (verified 2026-09-29);
       * the field stays an empty string instead of being fabricated. */
      items.push({ title, url, date: '' });
    }
    if (!items.length) {
      throw new api.CommandExecutionError('Could not parse any 36kr search result cards', '36kr may have changed its search result card structure');
    }
    return items.slice(0, limit).map((item, index) => ({
      rank: index + 1,
      title: item.title,
      date: item.date,
      url: item.url,
    }));
  });
})();
