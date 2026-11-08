/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112 (Apache-2.0).
 * Modified: bounded backend binary transfer, v2 host navigation, explicit per-file outcomes. */
(function () {
  const {ArgumentError,CommandExecutionError,integer,navigate,same,guard,normalizeDoubanSubjectId,loadDoubanSubjectPhotos}=window.__douban;
  const hosts=new Set(['img1.doubanio.com','img2.doubanio.com','img3.doubanio.com','img9.doubanio.com']);
  const extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','image/avif':'.avif'};
  function safeName(s){return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,80)||'photo'}
  async function savePhoto(photo,subjectId,output) {
    const url=new URL(photo.imageUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!hosts.has(url.hostname))throw new CommandExecutionError('Photo asset host is not allowed');
    const runtime=window.__webmcpWecliRuntime;
    const response=await runtime.requestPrivileged('backend_fetch',{url:url.href,browserFallback:false,redactBodyInTrace:true,options:{redirect:'manual',responseEncoding:'base64',maxResponseBytes:8388608,timeoutMs:15000,headers:{Referer:'https://movie.douban.com/'}}});
    if(response.status!==200)throw new CommandExecutionError('Photo HTTP '+response.status+'; redirects are not followed');
    if(response.bodyEncoding!=='base64')throw new CommandExecutionError('Bridge binary response support is unavailable; reload the updated client before downloading');
    const mime=String(response.headers?.['content-type']||response.headers?.['Content-Type']||'').split(';')[0].trim().toLowerCase();
    if(!extensions[mime]||!Number.isSafeInteger(response.size)||response.size<1||response.size>8388608)throw new CommandExecutionError('Photo is not a supported nonempty image');
    const filename=subjectId+'_'+String(photo.index).padStart(3,'0')+'_'+safeName(photo.photoId||'photo')+'_'+safeName(photo.title||photo.photoId)+extensions[mime];
    const destination=output.replace(/[\\/]+$/,'')+'/'+subjectId+'/'+filename;
    const result=await runtime.requestPrivileged('backend_file_write',{path:destination,encoding:'base64',content:response.body});
    return {saved:result.path||destination,size:response.size};
  }
  window.__doubanDownload={savePhoto,safeName};
  __webcliRegisterCommand('download',async(args={})=>{
    const id=normalizeDoubanSubjectId(String(args.id||'')),limit=integer(args.limit,120,500),type=String(args.type||'Rb');
    const output=args.output??'./douban-downloads';if(typeof output!=='string'||!output.trim()||output.includes('\0'))throw new ArgumentError('output must be a nonempty directory');
    const photoId=String(args['photo-id']||'').trim();if(photoId&&!/^\d+$/.test(photoId))throw new ArgumentError('photo-id must be numeric');
    const target='https://movie.douban.com/subject/'+id+'/photos?type='+encodeURIComponent(type);if(!same(target))return {__webcli_navigation:{version:1,url:target,resume:false,result:{status:'prepared',message:'海报页已准备，尚未下载；请核对后重新调用。'}}};guard();
    const data=await loadDoubanSubjectPhotos(id,photoId?{type,targetPhotoId:photoId}:{type,limit});
    const photos=photoId?data.photos.filter(p=>p.photoId===photoId):data.photos;
    if(!photos.length)throw new CommandExecutionError(photoId?'Photo was not found under the selected subject':'No photos extracted; download not performed');
    const results=new Array(photos.length);let cursor=0;const deadline=Date.now()+75000;
    await Promise.all(Array.from({length:Math.min(3,photos.length)},async()=>{while(cursor<photos.length){const index=cursor++,photo=photos[index];const row={index:photo.index,title:photo.title,photo_id:photo.photoId,image_url:photo.imageUrl,detail_url:photo.detailUrl,requested_type:type,page_title:data.subjectTitle};if(Date.now()>deadline){results[index]={...row,status:'not_attempted',error:'Download call budget reached; retry explicit remaining photo-id'};continue;}try{results[index]={...row,status:'success',...await savePhoto(photo,id,output)}}catch(error){results[index]={...row,status:'failed',error:error.message}}}}));return results;
  });
})();
