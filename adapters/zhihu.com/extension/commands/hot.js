/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){__webcliRegisterCommand('hot',async(args={})=>{const c=window.__zhihu,limit=c.integer(args.limit,20,50);if(!c.ready('https://www.zhihu.com/'))return c.navigate('https://www.zhihu.com/');c.guard();const fetch=c.safeFetch;const rows=await ((async () => {
  const res = await fetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50', {
    credentials: 'include'
  });
  const text = await res.text();
  const d = JSON.parse(
    text.replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"')
  );
  return (d?.data || []).map((item) => {
    const t = item.target || {};
    const questionId = t.id == null ? '' : String(t.id);
    return {
      title: t.title,
      context_title: c.contextTitle(t.title),
      question_id: questionId,
      url: 'https://www.zhihu.com/question/' + questionId,
      answer_count: t.answer_count,
      follower_count: t.follower_count,
      heat: item.detail_text || '',
    };
  });
})()
);if(!Array.isArray(rows)||!rows.length)throw new c.CommandExecutionError('No hot list extracted; response or empty status unknown');return rows.slice(0,limit).map((x,i)=>({rank:i+1,title:x.title,context_title:x.context_title,question_id:x.question_id,heat:x.heat,answers:x.answer_count??null,url:x.url}));});})();
