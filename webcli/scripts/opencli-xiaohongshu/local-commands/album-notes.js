window.__webcliRegisterCommand('album-notes', async function(params={}) {
async function evaluate(fn, args) {
  const expression = `(${fn.toString()})(${JSON.stringify(args)})`;
  const r = await window.__webmcpWecliRuntime.requestPrivileged('main_world_eval', {expression});
  if (!r || r.value === undefined) throw new Error('页面读取失败');
  return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
}
async function read(args) {
  const s=document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s.get('board');
  if(!s) throw new Error('专辑未就绪');
  const pause=()=>new Promise(r=>setTimeout(r,700));
  for(let i=0;i<15 && !s.boardFeedsMap[args.id];i++) await pause();
  let page=s.boardFeedsMap[args.id];
  if(!page) throw new Error('未读取到专辑：请检查登录和访问权限');
  let previous=-1,stalled=0;
  for(let i=0;i<30 && page.hasMore && page.notes.length<args.limit;i++) {
    stalled=page.notes.length===previous?stalled+1:0;if(stalled>=4)break;previous=page.notes.length;
    window.scrollTo(0,document.documentElement.scrollHeight);await pause();page=s.boardFeedsMap[args.id];
  }
  const notes=[...new Map(page.notes.map(n=>{const q=new URLSearchParams({xsec_source:'pc_user'});if(n.xsecToken)q.set('xsec_token',n.xsecToken);return [n.noteId,{id:n.noteId,title:n.displayTitle,type:n.type,url:'https://www.xiaohongshu.com/explore/'+n.noteId+'?'+q}]})).values()];
  return JSON.stringify({album:{id:args.id,name:s.boardDetails.name,note_count:s.boardDetails.total},notes:notes.slice(0,args.limit),has_more:!!page.hasMore,complete:!page.hasMore&&notes.length<=args.limit});
}
 const id=params['album-id'];const limit=Number(params.limit??200);
 if(!/^[a-f0-9]{24}$/i.test(id||''))throw new Error('album-id 必须为 24 位十六进制 ID');
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('limit 必须为 1–1000');
 if(location.pathname!=='/board/'+id)return {__webcli_navigation:{version:1,url:'https://www.xiaohongshu.com/board/'+id,resume:true}};
 return evaluate(read,{id,limit});
});
