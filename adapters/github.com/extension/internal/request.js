/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112,
 * clis/github-trending/repos.js. Apache-2.0, Copyright 2025 jackwener.
 * Modified: WeWorker restricted background helper, main-area extraction,
 * strict argument types and period-label verification. */
(function () {
  function fail(code,message) { const e=new Error(message);e.code=code;throw e; }
  window.__githubTrending.repos = async (args={}) => {
    const since = args.since === undefined ? 'daily' : args.since;
    if (typeof since !== 'string' || !['daily','weekly','monthly'].includes(since.toLowerCase())) fail('INVALID_ARGS','since must be daily, weekly or monthly');
    const period = since.toLowerCase();
    const raw = args.limit === undefined ? 25 : args.limit;
    const limit = typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):raw;
    if (!Number.isSafeInteger(limit)||limit<1||limit>25) fail('INVALID_ARGS','limit must be 1..25');
    const language = args.language === undefined ? '' : args.language;
    if (typeof language!=='string'||/[\x00-\x1f\x7f/\\?#]/.test(language)||language.trim()==='.'||language.trim()==='..') fail('INVALID_ARGS','Invalid language slug');
    const url = new URL('https://github.com/trending'+(language.trim()?'/'+encodeURIComponent(language.trim()):''));
    url.searchParams.set('since',period);
    let r;
    try { r=await window.__webmcpWecliRuntime.requestPrivileged('backend_fetch',{
      url:url.href,browserFallback:false,redactBodyInTrace:true,
      options:{method:'GET',redirect:'manual',maxResponseBytes:4*1024*1024,
        headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 (compatible; WeWorker/1.0)'}},
    }); } catch { fail('FETCH_ERROR','GitHub Trending request failed; retain trace for diagnosis'); }
    if (r?.redirected||(r?.url&&r.url!==url.href)||(r?.status>=300&&r?.status<400)) fail('HTTP_ERROR','Unexpected GitHub redirect');
    if (!r?.ok) fail('HTTP_ERROR','GitHub HTTP '+r?.status);
    // Scope to the actual main document, excluding script/template text and sidebar-free global navigation.
    const html=String(r.body||'').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
    const main=html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    if (!main) fail('PARSE_ERROR','GitHub Trending main area is missing');
    const blocks=[...main.matchAll(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g)].slice(0,limit);
    const label={daily:'today',weekly:'this week',monthly:'this month'}[period];
    for(const block of blocks) {
      const actual=block[1].match(/[\d,]+\s+stars\s+(today|this week|this month)/i)?.[1]?.toLowerCase();
      if(actual!==label) fail('PARSE_ERROR','Trending period does not match '+period);
    }
    const rows=window.__githubTrending.parseTrendingHtml(main,limit);
    if(!rows.length) fail('EMPTY_RESULT','GitHub explicitly reports no trending repositories for these filters');
    return rows.map((row,index)=>({rank:index+1,...row,since:period,requested_language:language.trim()}));
  };
})();
