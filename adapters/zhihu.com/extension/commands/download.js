/* Adapted from OpenCLI 24136945847afbfad266c6c46a8cd335377f9112 (Apache-2.0).
 * Uses source target/identity validation and Markdown rules; v2 navigation and binary files use existing host helpers. */
(function(){
const {ArgumentError,CommandExecutionError,navigate,ready,guard}=window.__zhihu;
const imageHosts=new Set(['pic1.zhimg.com','pic2.zhimg.com','pic3.zhimg.com','pic4.zhimg.com','pica.zhimg.com','picb.zhimg.com','picx.zhimg.com','picy.zhimg.com','picx1.zhimg.com']);
const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif','image/svg+xml':'svg'};
function safeName(value){let name=String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,80);if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;return name||'article'}
function boolean(value){if(value===undefined||value===false||value==='false')return false;if(value===true||value==='true')return true;throw new ArgumentError('download-images must be true or false')}
async function exportArticle(data,options){
  if(!data.title||!data.contentHtml?.trim())throw new CommandExecutionError('Article title or full content is missing');
  const runtime=window.__webmcpWecliRuntime,safeTitle=safeName(data.title),dir=options.output.replace(/[\\/]+$/,'')+'/'+safeTitle;
  let markdown=window.__zhihuMarkdown.convertToMarkdown(data.contentHtml,[]);
  const imageResults=[],mapping={},urls=[...new Set(data.imageUrls||[])],deadline=Date.now()+70000;
  if(options.images)for(let i=0;i<urls.length;i++){
    const original=urls[i];
    try{
      if(Date.now()>deadline)throw new Error('Image download call budget reached');
      const url=new URL(original);if(url.protocol!=='https:'||url.username||url.password||url.port||!imageHosts.has(url.hostname))throw new Error('Image host is not permitted');
      const response=await runtime.requestPrivileged('backend_fetch',{url:url.href,browserFallback:false,redactBodyInTrace:true,options:{redirect:'manual',responseEncoding:'base64',maxResponseBytes:8388608,timeoutMs:15000,headers:{Referer:data.sourceUrl}}});
      if(response.status!==200)throw new Error('Image HTTP '+response.status);
      if(response.bodyEncoding!=='base64')throw new Error('Updated Bridge binary support is required');
      const mime=String(response.headers?.['content-type']||response.headers?.['Content-Type']||'').split(';')[0].trim().toLowerCase();
      if(!extensions[mime]||!Number.isSafeInteger(response.size)||response.size<1||response.size>8388608)throw new Error('Response is not a supported nonempty image');
      const local='images/img_'+String(i+1).padStart(3,'0')+'.'+extensions[mime];
      await runtime.requestPrivileged('backend_file_write',{path:dir+'/'+local,encoding:'base64',content:response.body});mapping[original]=local;imageResults.push({url:original,status:'success',saved:local,size:response.size});
    }catch(error){imageResults.push({url:original,status:'failed',error:error.message});}
  }
  markdown=window.__zhihuMarkdown.replaceImageUrls(markdown,mapping);
  const headers=['# '+data.title];if(data.author)headers.push('> 作者: '+data.author);if(data.publishTime)headers.push('> 发布时间: '+data.publishTime);headers.push('> 原文链接: '+data.sourceUrl);
  const full=headers.join('\n')+'\n\n---\n\n'+markdown+'\n',file=dir+'/'+safeTitle+'.md';
  const saved=await runtime.requestPrivileged('backend_file_write',{path:file,encoding:'utf8',content:full});
  return [{title:data.title,author:data.author||'',publish_time:data.publishTime||'',status:imageResults.some(r=>r.status==='failed')?'partial':'success',size:saved.bytesWritten??saved.size??null,saved:saved.path||file,images:imageResults}];
}
window.__zhihuDownload={safeName,boolean,exportArticle};
__webcliRegisterCommand('download',async(args={})=>{
  const target=window.__zhihuExport.parseDownloadTarget(args.url);if(!target)throw new ArgumentError('Expected a Zhihu article URL or answer ID/typed target/URL');
  const output=args.output??'./zhihu-articles';if(typeof output!=='string'||!output.trim()||output.includes('\0'))throw new ArgumentError('output must be a nonempty directory');
  const images=boolean(args['download-images']);
  const url=target.kind==='answer'?'https://www.zhihu.com/answer/'+target.answerId:target.url;
  if(!ready(url))return {__webcli_navigation:{version:1,url,resume:false,result:{status:'prepared',message:'导出页面已准备，尚未写入文件；请核对后重新调用。'}}};guard();
  const data=target.kind==='answer'?await window.__zhihuExport.extractAnswer(null,target):{...await window.__zhihuExport.extractColumnArticle(null,target),sourceUrl:target.url};
  return exportArticle(data,{output,images});
});})();
