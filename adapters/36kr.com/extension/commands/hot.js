/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/hot.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page navigation runs through the host resume
 * protocol; each requested board keeps its own source URL (dated boards for
 * renqi/zonghe/shoucang, static catalog route) and DOM polling is bounded. */
(function () {
  __webcliRegisterCommand('hot', async (args = {}) => {
    const api = window.__kr36;
    const type = args.type === undefined || args.type === null ? 'catalog' : String(args.type);
    if (!api.HOT_TYPE_MAP[type]) {
      throw new api.ArgumentError('Unknown type "' + type + '". Valid types: ' + Object.keys(api.HOT_TYPE_MAP).join(', '));
    }
    const limit = api.integerArg('limit', args.limit, 20, 50);
    const url = api.buildHotListUrl(type);
    if (!api.same(url)) return api.navigate(url);
    api.guard();
    const rendered = await api.waitFor(async () => document.querySelectorAll('a[href*="/p/"]').length > 0);
    if (!rendered) {
      throw new api.CommandExecutionError('36kr hot list page did not render article links within the wait budget', 'The board may still be loading or 36kr changed its DOM structure');
    }
    const seen = new Set();
    const items = [];
    for (const el of Array.from(document.querySelectorAll('a[href*="/p/"]'))) {
      const href = el.getAttribute('href') || '';
      const title = el.textContent?.trim() || '';
      if (!title || title.length < 5 || seen.has(href) || seen.has(title)) continue;
      seen.add(href);
      seen.add(title);
      items.push({ title, url: api.normalizeArticleUrl(href) });
    }
    if (!items.length) {
      throw new api.CommandExecutionError('Could not retrieve 36kr hot list', '36kr may have changed its DOM structure');
    }
    return items.slice(0, limit).map((item, index) => ({
      rank: index + 1,
      title: item.title,
      url: item.url,
      type,
      board: api.hotTypeLabel(type),
      board_url: url,
    }));
  });
})();
