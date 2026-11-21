window.__webcliRegisterCommand('albums', async function(params={}) {
async function evaluate(fn, args) {
  const expression = `(${fn.toString()})(${JSON.stringify(args)})`;
  const r = await window.__webmcpWecliRuntime.requestPrivileged('main_world_eval', {expression});
  if (!r || r.value === undefined) throw new Error('页面读取失败');
  return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
}
async function read(args) {
  const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
  const store = pinia?._s.get('board');
  if (!store) throw new Error('专辑页面未就绪，请登录后重试');
  const pause = () => new Promise(r => setTimeout(r, 700));
  for (let i=0;i<12 && !store.userBoardList?.length;i++) await pause();
  const countText = [...document.querySelectorAll('span')].map(e=>e.textContent).find(t=>/^专辑[・·]\d+$/.test(t));
  const total = countText ? Number(countText.match(/\d+/)[0]) : null;
  let previous = -1, stalled = 0;
  for (let i=0;i<30;i++) {
    const n = store.userBoardList.length;
    if (n>=args.limit || (total!==null && n>=total)) break;
    stalled = n===previous ? stalled+1 : 0;
    if(stalled>=4) break;
    previous=n;
    window.scrollTo(0,document.documentElement.scrollHeight);
    await pause();
  }
  const rows=[...new Map(store.userBoardList.map(b=>[b.id,{id:b.id,name:b.name,note_count:b.total,url:'https://www.xiaohongshu.com/board/'+b.id}])).values()];
  return JSON.stringify({albums:rows.slice(0,args.limit),loaded:rows.length,total,complete:total!==null && rows.length>=total && rows.length<=args.limit});
}
  const limit=Number(params.limit??200);
  if(!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('limit 必须为 1–1000');
  let id=params.id;
  if(!id) id=await evaluate(()=>{const u=window.__INITIAL_STATE__?.user?.userInfo;const v=u?._value??u??{};return JSON.stringify(v.userId||v.user_id||v.userID||'');},{});
  if(!/^[a-f0-9]{24}$/i.test(id||'')) throw new Error('无法确定当前用户，请先打开已登录的小红书首页，或传 id');
  const url=new URL('https://www.xiaohongshu.com/user/profile/'+id+'?tab=fav&subTab=board');
  if(location.pathname!==url.pathname||new URL(location.href).searchParams.get('subTab')!=='board') return {__webcli_navigation:{version:1,url:url.href,resume:true}};
  return evaluate(read,{limit});
});
