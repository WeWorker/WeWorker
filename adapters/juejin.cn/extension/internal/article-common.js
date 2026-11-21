/* Site publishing helpers. Copied into each existing Extension Adapter by build.mjs. */
(() => {
  class PublishError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const fail = (code, message) => { throw new PublishError(code, message); };
  async function privileged(action, payload) {
    return window.__webmcpWecliRuntime.requestPrivileged(action, payload);
  }
  async function main(fn, args = {}) {
    const expression = `(async()=>{try{return {data:await (${fn.toString()})(${JSON.stringify(args)})}}catch(e){return {error:{code:e.code||'PAGE_ERROR',message:e.message}}}})()`;
    const result = (await privileged('main_world_eval', { expression })).value;
    if (!result || result.error) fail(result?.error?.code || 'PAGE_ERROR', result?.error?.message || 'No page result');
    return result.data;
  }
  function id(value) {
    if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) fail('INVALID_ARGS', 'Article ID must be a decimal string');
    return value;
  }
  function execute(args) { if (args.execute !== true && args.execute !== 'true') fail('INVALID_ARGS', 'execute=true is required for this write'); }
  function route(url, read = false) {
    return { __webcli_navigation: { version: 1, url, resume: read, ...(read ? {} : { phase: 'prepare', result: { status: 'prepared', executed: false, message: 'Editor opened; repeat the same authorized call. No article was submitted.' } }) } };
  }
  function local(path) { return typeof path === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(path); }
  async function text(path) {
    if (!local(path)) fail('INVALID_ARGS', 'file must be an absolute local path');
    const r = await privileged('backend_file_read', { path, encoding: 'utf8', maxBytes: 1048576 });
    if (typeof r.content !== 'string' || !r.content.trim() || r.truncated) fail('INVALID_ARGS', 'Article file is empty or truncated');
    return r.content;
  }
  async function images(paths) {
    const unique = [...new Set(paths)];
    if (unique.length > 16) fail('INVALID_ARGS', 'At most 16 local images');
    let total = 0;
    const result = [];
    for (const path of unique) {
      if (!local(path) || !/\.(png|jpe?g|webp|gif)$/i.test(path)) fail('INVALID_ARGS', 'Images must be absolute PNG/JPEG/WebP/GIF paths');
      const r = await privileged('backend_file_read', { path, encoding: 'base64', maxBytes: 8388608 });
      if (!r.content || r.truncated) fail('INVALID_ARGS', 'Image is empty or truncated');
      const size = atob(r.content).length;
      total += size;
      if (size > 8388608 || total > 33554432) fail('INVALID_ARGS', 'Images exceed 8 MiB each / 32 MiB total');
      const ext = path.split('.').pop().toLowerCase();
      result.push({ path, name: path.split(/[\\/]/).pop(), content: r.content, size, type: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] });
    }
    return result;
  }
  async function stage(image) {
    const key = '__wwArticleFile_' + crypto.randomUUID().replaceAll('-', '');
    await main(({ key }) => { window[key] = []; }, { key });
    try {
      for (let i = 0; i < image.content.length; i += 45000) await main(({ key, part }) => { window[key].push(part); }, { key, part: image.content.slice(i, i + 45000) });
      await main(({ key, name, type, size }) => {
        const bytes = Uint8Array.from(atob(window[key].join('')), c => c.charCodeAt(0));
        if (bytes.length !== size) throw new Error('Image staging size mismatch');
        window[key] = new File([bytes], name, { type });
      }, { key, name: image.name, type: image.type, size: image.size });
      return key;
    } catch (e) { await unstage(key); throw e; }
  }
  async function unstage(key) { await main(({ key }) => { delete window[key]; }, { key }); }
  function title(value, max = 100) { if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max) fail('INVALID_ARGS', 'Invalid title (1..' + max + ' characters)'); return value.trim(); }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function cleanHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allowed = new Set(['P','BR','H1','H2','H3','H4','H5','H6','STRONG','B','EM','I','U','S','BLOCKQUOTE','UL','OL','LI','PRE','CODE','A','IMG','FIGURE','FIGCAPTION','TABLE','THEAD','TBODY','TR','TH','TD','HR']);
    for (const el of doc.body.querySelectorAll('*')) {
      if (!allowed.has(el.tagName)) fail('INVALID_ARGS', 'Unsupported HTML tag: ' + el.tagName);
      for (const a of [...el.attributes]) {
        if (!['href','src','alt','title'].includes(a.name)) el.removeAttribute(a.name);
      }
      if (el.hasAttribute('href') && !/^https:\/\//i.test(el.getAttribute('href'))) fail('INVALID_ARGS', 'Links must use HTTPS');
    }
    return doc.body;
  }
  window.__articlePublish = { PublishError, fail, privileged, main, id, execute, route, local, text, images, stage, unstage, title, wait, cleanHTML };
})();
