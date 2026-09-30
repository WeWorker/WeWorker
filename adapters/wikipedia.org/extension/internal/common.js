/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112,
 * clis/wikipedia/{utils,search,summary,random,trending,page}.js.
 * Apache-2.0, Copyright 2025 jackwener. Modified for WeWorker v2 restricted
 * background fetch, validated language/arguments, explicit unknown fields,
 * API/shape errors and truncation metadata. No OpenCLI runtime dependency. */
(function () {
  function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
  function text(value, name) {
    if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGS', name + ' must be non-empty text');
    return value.trim();
  }
  function integer(value, fallback, min, max) {
    const raw = value === undefined ? fallback : value;
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(n) || n < min || n > max) fail('INVALID_ARGS', 'Integer argument is outside ' + min + '..' + max);
    return n;
  }
  function language(args) {
    const lang = text(args.lang === undefined ? 'en' : args.lang, 'lang').toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]+)?$/.test(lang)) fail('INVALID_ARGS', 'lang must be a Wikipedia language code');
    return lang;
  }
  function pageUrl(title, lang) { return 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')); }
  function plain(value) {
    return String(value).replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,
      entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[entity]);
  }
  async function request(lang, path, params, randomRedirects = 0) {
    const url = new URL('https://' + lang + '.wikipedia.org' + path);
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
    let r;
    try {
      r = await window.__webmcpWecliRuntime.requestPrivileged('backend_fetch', {
        url: url.href, browserFallback: false, redactBodyInTrace: true,
        options: { method: 'GET', redirect: 'manual', maxResponseBytes: 8 * 1024 * 1024,
          headers: { Accept: 'application/json', 'User-Agent': 'WeWorker/1.0 (https://github.com/WeWorker/WeWorker)' } },
      });
    } catch { fail('FETCH_ERROR', 'Wikipedia request failed; retain trace for diagnosis'); }
    // The random endpoint may select a summary via an HTTP redirect. Follow
    // only that documented read flow, bounded and confined to this language's
    // summary endpoint; never enable general HTTP redirect following.
    if (r?.status >= 300 && r?.status < 400 && randomRedirects > 0) {
      const location = r.headers?.location || r.headers?.Location;
      let next;
      try { next = new URL(location, url); } catch { fail('HTTP_ERROR', 'Invalid random article redirect'); }
      if (!location || next.origin !== url.origin || next.username || next.password
          || !next.pathname.startsWith('/api/rest_v1/page/summary/') || next.search || next.hash) fail('HTTP_ERROR', 'Unexpected random article redirect');
      return request(lang, next.pathname, undefined, randomRedirects - 1);
    }
    if (r?.redirected || (r?.url && r.url !== url.href) || (r?.status >= 300 && r?.status < 400)) fail('HTTP_ERROR', 'Unexpected HTTP redirect');
    if (!r?.ok) fail(r?.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', 'Wikipedia HTTP ' + r?.status);
    let data;
    try { data = JSON.parse(r.body); } catch { fail('PARSE_ERROR', 'Wikipedia returned malformed JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('PARSE_ERROR', 'Wikipedia response is not an object');
    if (data.error || data.errors) fail('API_ERROR', 'Wikipedia returned an API error');
    return data;
  }
  function titleOf(row) {
    if (!row || typeof row.title !== 'string' || !row.title.trim()) fail('PARSE_ERROR', 'Article identity is missing');
    return row.title;
  }
  function rowsAt(rows, name) {
    if (!Array.isArray(rows)) fail('PARSE_ERROR', 'Missing ' + name + ' list');
    if (!rows.length) fail('NOT_FOUND', 'The API returned an empty ' + name + ' list');
    return rows;
  }
  function summaryRow(data, lang) {
    const title = titleOf(data);
    if (typeof data.extract !== 'string') fail('PARSE_ERROR', 'Article summary extract is missing');
    return { title, description: typeof data.description === 'string' ? data.description : null,
      extract: data.extract.slice(0, 300), url: pageUrl(title, lang),
      extract_truncated: data.extract.length > 300, extract_length: data.extract.length,
      content_scope: 'lead_summary', article_type: typeof data.type === 'string' ? data.type : null };
  }
  const api = {
    async search(args) {
      const lang = language(args), query = text(args.query, 'query');
      const limit = integer(args.limit, 10, 1, 50);
      const data = await request(lang, '/w/api.php', {action:'query',list:'search',srsearch:query,srlimit:limit,format:'json',utf8:1});
      return rowsAt(data.query?.search, 'search').slice(0, limit).map(row => {
        const title = titleOf(row);
        if (typeof row.snippet !== 'string') fail('PARSE_ERROR', 'Search snippet is missing');
        const snippet = plain(row.snippet);
        return {title, snippet:snippet.slice(0,120), snippet_truncated:snippet.length>120, url:pageUrl(title,lang)};
      });
    },
    async summary(args) {
      const lang = language(args), title = text(args.title, 'title');
      return [summaryRow(await request(lang, '/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g,'_'))), lang)];
    },
    async random(args) {
      const lang = language(args);
      return [summaryRow(await request(lang, '/api/rest_v1/page/random/summary', undefined, 2), lang)];
    },
    async trending(args) {
      const lang = language(args), limit = integer(args.limit, 10, 1, 50);
      const date = new Date(Date.now()-86400000).toISOString().slice(0,10);
      const data = await request(lang, '/api/rest_v1/feed/featured/' + date.replace(/-/g,'/'));
      return rowsAt(data.mostread?.articles, 'mostread').slice(0,limit).map((row,i) => ({
        rank:i+1,title:titleOf(row),description:typeof row.description==='string'?row.description.slice(0,80):null,
        description_truncated:typeof row.description==='string'&&row.description.length>80,
        views:Number.isSafeInteger(row.views)&&row.views>=0?row.views:null,
        feed_date:date, mostread_date:typeof data.mostread.date==='string'?data.mostread.date:null,
        url:pageUrl(row.title,lang),
      }));
    },
    async page(args) {
      const lang = language(args), title = text(args.title,'title');
      const cap = integer(args.paragraphs,0,0,Number.MAX_SAFE_INTEGER);
      const data = await request(lang,'/w/api.php',{action:'query',format:'json',formatversion:2,
        prop:'extracts|info|description',inprop:'url',explaintext:1,redirects:1,titles:title});
      const pages = rowsAt(data.query?.pages, 'pages');
      if (pages.length !== 1) fail('PARSE_ERROR','Expected one resolved article');
      const row = pages[0];
      if (row?.missing === true || row?.missing === '') fail('NOT_FOUND','Article does not exist');
      if (row?.invalid === true || row?.invalid === '') fail('INVALID_ARGS','Invalid Wikipedia article title');
      const resolved = titleOf(row);
      if (typeof row.extract !== 'string') fail('PARSE_ERROR','Page extract is missing');
      if (!row.extract.trim()) fail('EMPTY_RESULT','Article exists but the API returned no plain-text extract');
      const all = row.extract.split(/\n{2,}/).map(p=>p.trim()).filter(Boolean);
      const selected = cap>0?all.slice(0,cap):all;
      return [{title:resolved,description:typeof row.description==='string'?row.description:null,
        pageId:Number.isSafeInteger(row.pageid)?row.pageid:null,paragraphs:selected.length,
        extract:selected.join('\n\n'),url:pageUrl(resolved,lang),extract_truncated:selected.length<all.length,
        total_paragraphs:all.length,content_scope:'api_plain_text_extract'}];
    },
  };
  window.__wikiReference = api;
})();
