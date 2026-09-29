/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112
 * (clis/36kr/hot.js), Apache-2.0, Copyright 2025 jackwener.
 * Modified for WeWorker v2: page navigation runs through the host resume
 * protocol; each requested board keeps its own source URL (dated boards for
 * renqi/zonghe/shoucang, static catalog route) and DOM polling is bounded.
 * Rows are bound to the verified board regions only — never to whatever /p/
 * links happen to exist on the page — and the page title plus (for catalog)
 * the section titles must confirm the requested board before anything is
 * returned. Region shape verified against the live read-only DOM on
 * 2026-09-29; see docs/opencli_news_wave2_migration.md. The wait is for a
 * parseable row inside the trusted region, not for the container: dynamic
 * pages render the container before its rows, and these pages have no
 * verified empty-state marker, so an empty-looking region is reported as a
 * render/structure anomaly instead of an empty board. */
(function () {
  /* Board rows on every verified board page are .article-wrapper items whose
   * title link is a.article-item-title. On dated board pages the board list is
   * the .article-list outside any .list-section-wrapper; the catalog page
   * aggregates three .list-section-wrapper boards labeled 人气榜/综合榜/收藏榜. */
  function mainBoardLists() {
    return Array.from(document.querySelectorAll('.article-list'))
      .filter((list) => !list.closest('.list-section-wrapper'));
  }

  function catalogSections() {
    return Array.from(document.querySelectorAll('.list-section-wrapper'));
  }

  /* Board a catalog section actually names, from its own title first. */
  function sectionBoardName(section) {
    const titleText = typeof section.querySelector === 'function'
      ? (section.querySelector('.list-title')?.textContent || '')
      : '';
    return window.__kr36.sectionBoardLabel(titleText)
      || window.__kr36.sectionBoardLabel(section.textContent || '');
  }

  function recognizedSections() {
    return catalogSections().filter((section) => sectionBoardName(section) !== null);
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

  function wrappersOf(container) {
    return typeof container.querySelectorAll === 'function'
      ? Array.from(container.querySelectorAll('.article-wrapper'))
      : [];
  }

  function trustedRegions(type) {
    return type === 'catalog' ? recognizedSections() : mainBoardLists();
  }

  /* Parseable rows inside the trusted regions only. Catalog rows count only
   * inside recognized board sections, so a successful probe always means the
   * extraction below will return at least one row. */
  function parseableRowCount(type) {
    let count = 0;
    for (const region of trustedRegions(type)) count += rowsFromWrappers(wrappersOf(region)).length;
    return count;
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

    /* Wait for a parseable row inside the trusted board region itself — not
     * for the container and not for any /p/ link: dynamic pages render the
     * board container before its rows (a bare container is not evidence of an
     * empty board), and header/footer /p/ links would fake a rendered board.
     * No verified empty-state marker exists on these pages, so a region that
     * never gains a row fails below as a render/structure anomaly, never as
     * an empty result. */
    const rendered = await api.waitFor(() => parseableRowCount(type) > 0);
    if (!rendered) {
      const regionCount = type === 'catalog' ? catalogSections().length : mainBoardLists().length;
      if (!regionCount) {
        if (document.querySelectorAll('a[href*="/p/"]').length > 0) {
          /* The page has content but no trusted board region — recommendations
           * and navigation links are never treated as board results. */
          throw new api.CommandExecutionError('36kr page rendered but the ' + expectedBoard + ' board area was not found', '36kr may have changed its DOM structure; page-level links are not treated as board results');
        }
        throw new api.CommandExecutionError('36kr ' + api.hotTypeLabel(type) + ' board area did not render within the wait budget', 'The board may still be loading or 36kr changed its DOM structure');
      }
      if (type === 'catalog' && !recognizedSections().length) {
        throw new api.CommandExecutionError('36kr catalog page rendered but no recognized board section was found', '36kr may have changed its board section structure');
      }
      let wrapperCount = 0;
      for (const region of trustedRegions(type)) wrapperCount += wrappersOf(region).length;
      if (wrapperCount > 0) {
        /* Rows exist in the trusted region but none ever yielded a valid
         * official article title link — the row structure changed. */
        throw new api.CommandExecutionError('Could not parse any 36kr ' + api.hotTypeLabel(type) + ' board rows within the wait budget', '36kr may have changed its board row structure');
      }
      throw new api.CommandExecutionError(
        '36kr ' + api.hotTypeLabel(type) + ' board area rendered but no entries appeared within the wait budget',
        'No verified empty-state marker exists for 36kr board pages, so an empty-looking region is reported as a render or structure anomaly instead of an empty board',
      );
    }

    /* The page title must confirm the requested board (dated titles are
     * "资讯<board><date>_36氪", catalog is "36氪资讯热榜频道_36氪"). */
    const pageBoard = api.boardLabelFromPageTitle(document.title);
    if (pageBoard !== expectedBoard) {
      throw new api.CommandExecutionError(
        'Requested board ' + expectedBoard + ' but the rendered page shows ' + JSON.stringify(pageBoard || document.title || ''),
        'The board routing or page structure changed; refusing to relabel another board as ' + expectedBoard,
      );
    }

    const collected = [];
    if (type === 'catalog') {
      /* Catalog aggregates the three mini boards; rows are attributed to the
       * board their section actually names, never blanket-labeled. */
      for (const section of recognizedSections()) {
        const label = sectionBoardName(section);
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
        for (const row of rowsFromWrappers(wrappersOf(section))) collected.push({ ...row, board: label, board_url: boardUrl });
      }
    } else {
      for (const list of mainBoardLists()) {
        for (const row of rowsFromWrappers(wrappersOf(list))) collected.push({ ...row, board: api.hotTypeLabel(type), board_url: url });
      }
    }

    if (!collected.length) {
      /* Defensive: the successful probe guarantees a parseable row, so this
       * only triggers if the DOM changed between probe and extraction. */
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
