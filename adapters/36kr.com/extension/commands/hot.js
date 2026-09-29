/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/hot.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page navigation runs through the host resume
 * protocol; each requested board keeps its own source URL (dated boards for
 * renqi/zonghe/shoucang, static catalog route) and DOM polling is bounded.
 * Rows are bound to the verified board regions only — never to whatever /p/
 * links happen to exist on the page — and the page title plus (for catalog)
 * the section titles must confirm the requested board before anything is
 * returned. Region shape verified against the live read-only DOM on
 * 2026-09-29; see docs/opencli_news_wave2_migration.md. */
(function () {
  /* Board rows on every verified board page are .article-wrapper items whose
   * title link is a.article-item-title. On dated board pages the board list is
   * the .article-list outside any .list-section-wrapper; the catalog page
   * aggregates three .list-section-wrapper boards labeled 人气榜/综合榜/收藏榜. */
  function mainBoardLists() {
    return Array.from(document.querySelectorAll('.article-list'))
      .filter((list) => !list.closest('.list-section-wrapper'));
  }

  function rowsFromWrappers(wrappers) {
    const rows = [];
    const seenUrls = new Set();
    for (const wrapper of wrappers) {
      const titleEl = typeof wrapper.querySelector === 'function' ? wrapper.querySelector('.article-item-title') : null;
      if (!titleEl) continue;
      const title = (titleEl.textContent || '').trim();
      const url = window.__kr36.normalizeArticleUrl(titleEl.getAttribute('href'));
      if (!title || !url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      rows.push({ title, url });
    }
    return rows;
  }

  __webcliRegisterCommand('hot', async (args = {}) => {
    const api = window.__kr36;
    const type = args.type === undefined || args.type === null ? 'catalog' : String(args.type);
    if (!api.HOT_TYPE_MAP[type]) {
      throw new api.ArgumentError('Unknown type "' + type + '". Valid types: ' + Object.keys(api.HOT_TYPE_MAP).join(', '));
    }
    const limit = api.integerArg('limit', args.limit, 20, 50);
    const url = api.buildHotListUrl(type);
    const expectedBoard = type === 'catalog' ? '热榜' : api.hotTypeLabel(type);
    if (!api.same(url)) return api.navigate(url);
    api.guard();

    /* Wait for the trusted board region itself, not for any /p/ link: header
     * and footer links also match /p/ and would fake a rendered board. */
    const rendered = await api.waitFor(async () =>
      (type === 'catalog' ? document.querySelectorAll('.list-section-wrapper').length > 0 : mainBoardLists().length > 0));
    if (!rendered) {
      if (document.querySelectorAll('a[href*="/p/"]').length > 0) {
        /* The page has content but no trusted board region — recommendations
         * and navigation links are never treated as board results. */
        throw new api.CommandExecutionError('36kr page rendered but the ' + expectedBoard + ' board area was not found', '36kr may have changed its DOM structure; page-level links are not treated as board results');
      }
      throw new api.CommandExecutionError('36kr ' + api.hotTypeLabel(type) + ' board area did not render within the wait budget', 'The board may still be loading or 36kr changed its DOM structure');
    }

    /* The page title must confirm the requested board (dated titles are
     * "资讯<board><date>_36氪", catalog is "36氪资讯热榜频道_36氪"). */
    const pageBoard = api.boardLabelFromPageTitle(document.title);
    if (pageBoard !== expectedBoard) {
      throw new api.CommandExecutionError(
        'Requested board ' + expectedBoard + ' but the rendered page shows ' + JSON.stringify(pageBoard || document.title || ''),
        'The board routing or page structure changed; refusing to relabel another board as ' + expectedBoard);
    }

    const collected = [];
    let wrapperCount = 0;
    if (type === 'catalog') {
      /* Catalog aggregates the three mini boards; rows are attributed to the
       * board their section actually names, never blanket-labeled. */
      const sections = Array.from(document.querySelectorAll('.list-section-wrapper'));
      const recognized = sections.filter((section) => api.sectionBoardLabel(
        typeof section.querySelector === 'function' ? (section.querySelector('.list-title')?.textContent || '') : '') !== null
        || api.sectionBoardLabel(section.textContent || '') !== null);
      if (!recognized.length) {
        throw new api.CommandExecutionError('36kr catalog page rendered but no recognized board section was found', '36kr may have changed its board section structure');
      }
      for (const section of recognized) {
        const label = api.sectionBoardLabel(
          (typeof section.querySelector === 'function' ? (section.querySelector('.list-title')?.textContent || '') : '')
          || (section.textContent || ''));
        if (!label) continue;
        /* Board link: the section title anchors the full board page; fall back
         * to the catalog page itself when it is not a /hot-list/ route. */
        let boardUrl = url;
        const link = typeof section.querySelector === 'function' ? section.querySelector('.list-title a[href]') : null;
        if (link) {
          try {
            const candidate = new URL(link.getAttribute('href'), location.href);
            if (candidate.protocol === 'https:' && candidate.hostname === 'www.36kr.com' && candidate.pathname.startsWith('/hot-list/')) boardUrl = candidate.href;
          } catch { /* keep page url */ }
        }
        const wrappers = typeof section.querySelectorAll === 'function' ? Array.from(section.querySelectorAll('.article-wrapper')) : [];
        wrapperCount += wrappers.length;
        for (const row of rowsFromWrappers(wrappers)) collected.push({ ...row, board: label, board_url: boardUrl });
      }
    } else {
      for (const list of mainBoardLists()) {
        const wrappers = typeof list.querySelectorAll === 'function' ? Array.from(list.querySelectorAll('.article-wrapper')) : [];
        wrapperCount += wrappers.length;
        for (const row of rowsFromWrappers(wrappers)) collected.push({ ...row, board: api.hotTypeLabel(type), board_url: url });
      }
    }

    if (!wrapperCount) {
      /* The trusted board region rendered with no rows at all — a genuinely
       * empty board, not a parsing failure. */
      throw new api.EmptyResultError('36kr ' + api.hotTypeLabel(type) + ' board rendered with no entries', 'The board is empty for the requested date');
    }
    if (!collected.length) {
      /* Rows exist in the trusted region but none yielded a valid official
       * article title link — the row structure changed. */
      throw new api.CommandExecutionError('Could not parse any 36kr ' + api.hotTypeLabel(type) + ' board rows', '36kr may have changed its board row structure');
    }
    return collected.slice(0, limit).map((row, index) => ({
      rank: index + 1,
      title: row.title,
      url: row.url,
      type,
      board: row.board,
      board_url: row.board_url,
    }));
  });
})();
