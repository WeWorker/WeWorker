window.__webcliRegisterCommand('video-media', async function(params={}) {
async function evaluate(fn, args) {
  const expression = `(${fn.toString()})(${JSON.stringify(args)})`;
  const r = await window.__webmcpWecliRuntime.requestPrivileged('main_world_eval', {expression});
  if (!r || r.value === undefined) throw new Error('页面读取失败');
  return typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
}

 const url=new URL(params.url);
 if(url.protocol!=='https:'||url.hostname!=='www.xiaohongshu.com'||url.username||url.password||url.port||!/^\/explore\/[a-f0-9]{24}$/.test(url.pathname))throw new Error('需要小红书笔记 HTTPS URL');
 if(location.pathname!==url.pathname)return {__webcli_navigation:{version:1,url:url.href,resume:true}};
 return evaluate(async ({id})=>{
  let n;for(let i=0;i<15;i++){const s=document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia?._s.get('note');n=s?.noteDetailMap?.[id]?.note;if(n?.noteId||n?.video)break;await new Promise(r=>setTimeout(r,700));}
  if(!n?.video)throw new Error('未读取到视频，笔记可能非视频或不可访问');
  const streams=Object.values(n.video.media?.stream||{}).flat().filter(s=>s.masterUrl&&s.format==='mp4'&&s.audioCodec).map(s=>({url:s.masterUrl.replace(/^http:/,'https:'),width:s.width,height:s.height,size:s.size,duration_ms:s.duration})).filter(s=>{const u=new URL(s.url);return u.protocol==='https:'&&(u.hostname==='xhscdn.com'||u.hostname.endsWith('.xhscdn.com'))&&!u.username&&!u.password&&!u.port;});
  if(!streams.length)throw new Error('没有包含音轨的 MP4 媒体流');
  return JSON.stringify({id,title:n.title||n.desc||'',streams});
 },{id:url.pathname.split('/').pop()});
});
