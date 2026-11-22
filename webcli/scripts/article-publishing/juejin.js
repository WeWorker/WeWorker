/* Publishing uses the logged-in site's own editor and image uploader, without cookie export. */
(() => {
  const H = window.__articlePublish;
  const editorURL = id => 'https://juejin.cn/editor/drafts/' + (id || 'new?v=2');
  function ready(id) { return location.hostname === 'juejin.cn' && (id ? location.pathname === '/editor/drafts/' + id : /^\/editor\/drafts\/(new|\d+)$/.test(location.pathname)); }
  async function assertUnpublished(id) {
    await H.main(async ({ id }) => {
      const res = await fetch('https://api.juejin.cn/content_api/v1/article_draft/detail', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft_id: id }) });
      const j = await res.json(), d = j.data?.article_draft;
      if (!res.ok || j.err_no !== 0 || !d || String(d.id) !== id) throw new Error('Draft identity could not be verified');
      if (String(d.article_id) !== '0') throw new Error('Draft already mapped to an article; inspect article-status instead');
    }, { id });
  }
  async function prepare(a) {
    H.execute(a);
    const title = H.title(a.title, 100), draftId = a['draft-id'] ? H.id(a['draft-id']) : null;
    let markdown = await H.text(a.file);
    const refs = [...markdown.matchAll(/!\[[^\]\n]*\]\(([^)\n]+)\)/g)];
    for (const ref of refs) if (!H.local(ref[1]) && !/^https:\/\/[^/]+\.(juejin\.cn|byteimg\.com)\//.test(ref[1])) H.fail('INVALID_ARGS', 'Use local images or uploaded Juejin CDN URLs');
    const files = await H.images(refs.map(m => m[1]).filter(H.local));
    if (!ready(draftId)) return H.route(editorURL(draftId));
    await H.main(({ draftId }) => {
      const cm = document.querySelector('.CodeMirror')?.CodeMirror;
      const v = document.querySelector('.markdown-editor')?.__vue__;
      if (!cm || !v?.uploadImages) throw new Error('Juejin Markdown editor not ready');
      if (!draftId && (cm.getValue().trim() || document.querySelector('input.title-input')?.value.trim())) throw new Error('Existing editor has content; pass its draft-id explicitly');
    }, { draftId });
    if (draftId) await assertUnpublished(draftId);
    const media = new Map();
    for (const file of files) {
      const key = await H.stage(file);
      try {
        const url = await H.main(async ({ key }) => {
          const r = await document.querySelector('.markdown-editor').__vue__.uploadImages([window[key]]);
          if (r?.length !== 1 || !/^https:\/\/[^/]+\.(juejin\.cn|byteimg\.com)\//.test(r[0].url)) throw new Error('Image upload receipt invalid');
          return r[0].url;
        }, { key });
        media.set(file.path, url);
      } finally { await H.unstage(key); }
    }
    for (const ref of refs) if (media.has(ref[1])) markdown = markdown.replaceAll(ref[0], ref[0].replace(ref[1], media.get(ref[1])));
    await H.main(({ title, markdown }) => {
      const input = document.querySelector('input.title-input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, title); input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.CodeMirror').CodeMirror.setValue(markdown);
    }, { title, markdown });
    for (let i = 0; i < 24; i++) {
      await H.wait(500);
      const r = await H.main(async ({ title, markdown }) => {
        const id = location.pathname.match(/^\/editor\/drafts\/(\d+)$/)?.[1];
        if (!id) return null;
        const res = await fetch('https://api.juejin.cn/content_api/v1/article_draft/detail', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft_id: id }) });
        const j = await res.json();
        const d = j.data?.article_draft;
        if (!res.ok || j.err_no !== 0 || !d) throw new Error('Draft readback failed');
        const normalize = text => text.replace(/!\[([^\]\n]*)\]\((https:\/\/[^)\n]+)\)/g, (full, alt, src) => { const u = new URL(src); return /\.(juejin\.cn|byteimg\.com)$/.test(u.hostname) ? '![' + alt + '](' + u.origin + u.pathname + ')' : full; });
        return d.title === title && typeof d.mark_content === 'string' && normalize(d.mark_content) === normalize(markdown) ? { status: 'draft_saved', draft_id: id, title: d.title, image_count: (markdown.match(/!\[/g) || []).length, verification: 'draft_api', editor_url: location.href } : null;
      }, { title, markdown });
      if (r) return r;
    }
    H.fail('OUTCOME_UNKNOWN', 'Editor changed but draft save was not verified; inspect it before retrying');
  }
  async function publishUnsafe(a) {
    H.execute(a); const id = H.id(a['draft-id']);
    if (!ready(id)) return H.route(editorURL(id));
    const title = H.title(a.title, 100);
    if (!a.category || !a.tags || typeof a.summary !== 'string' || !a.summary.trim() || a.summary.length > 100) H.fail('INVALID_ARGS', 'category, tags and summary (1..100 chars) are required');
    const tags = String(a.tags).split(',').map(s => s.trim()).filter(Boolean);
    if (!tags.length || tags.length > 3) H.fail('INVALID_ARGS', 'Choose 1..3 tags');
    await assertUnpublished(id);
    await H.main(({ id, title }) => {
      if (document.querySelector('input.title-input')?.value !== title || !document.querySelector('.CodeMirror')?.CodeMirror.getValue().trim()) throw new Error('Draft title/body mismatch');
      if (sessionStorage.getItem('ww-article-submit:' + id)) throw new Error('Submission already attempted; inspect status before another call');
      const buttons = [...document.querySelectorAll('.publish-popup > button')];
      if (buttons.length !== 1) throw new Error('Publish menu missing');
      if (!document.querySelector('.publish-popup').classList.contains('active')) buttons[0].click();
    }, { id, title });
    await H.wait(300);
    await H.main(({ category }) => {
      const choices = [...document.querySelectorAll('.publish-popup .category-list .item')].filter(e => e.textContent.trim() === category);
      if (choices.length !== 1) throw new Error('Unknown category');
      choices[0].click();
    }, { category: a.category });
    for (const tag of tags) {
      await H.main(({ tag }) => {
        const root = [...document.querySelectorAll('.publish-popup .form-item')].find(e => e.querySelector('.label')?.textContent.includes('添加标签'));
        const select = root?.querySelector('.tag-input')?.__vue__;
        if (select?.value?.some(t => t.title === tag)) return;
        if (!select?.handleSearch || !select.$children[0]) throw new Error('Site tag selector unavailable');
        if (!select.$children[0].visible) select.$children[0].handleClickSelect();
        const input = root.querySelector('input');
        if (!input) throw new Error('Tag search missing');
        input.focus(); input.value = tag; input.dispatchEvent(new Event('input', { bubbles: true })); select.handleSearch(tag);
      }, { tag });
      await H.wait(800);
      await H.main(({ tag }) => {
        const root = [...document.querySelectorAll('.publish-popup .form-item')].find(e => e.querySelector('.label')?.textContent.includes('添加标签'));
        if (root?.querySelector('.tag-input')?.__vue__?.value?.some(t => t.title === tag)) return;
        const items = [...document.querySelectorAll('.byte-select-option')].filter(e => e.getClientRects().length && e.textContent.trim() === tag);
        if (items.length !== 1 || items[0].classList.contains('byte-select-option--disabled')) throw new Error('Tag unavailable, disabled or ambiguous: ' + tag);
        items[0].click();
      }, { tag });
      await H.wait(200);
    }
    await H.main(({ summary }) => {
      const el = document.querySelector('.publish-popup textarea');
      if (!el) throw new Error('Summary field missing');
      el.value = summary; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { summary: a.summary });
    await H.wait(300);
    await H.main(({ id, title, tags }) => {
      const root = document.querySelector('.publish-popup');
      if (document.querySelector('input.title-input')?.value !== title) throw new Error('Draft changed');
      const find = c => (c.$options.name || c.$options._componentTag) === 'PublishPopup' ? c : c.$children.map(find).find(Boolean);
      const post = find(document.querySelector('.markdown-editor').__vue__.$parent)?.post;
      if (!tags.every(tag => post?.tags?.some(t => t.title === tag))) throw new Error('Tag selection not retained');
      const buttons = [...root.querySelectorAll('button')].filter(e => e.textContent.trim() === '确定并发布');
      if (buttons.length !== 1 || !buttons[0].getClientRects().length || buttons[0].disabled) throw new Error('Final publish button not available');
      sessionStorage.setItem('ww-article-submit:' + id, JSON.stringify({ title, at: Date.now() }));
      buttons[0].click();
    }, { id, title, tags });
    return { status: 'submission_started', draft_id: id, title, verified: false,
      next_action: 'article-status --draft-id=' + id, message: 'One submit action was dispatched. Query status separately; do not automatically resubmit.' };
  }

  async function publish(a) {
    try { return await publishUnsafe(a); }
    catch (e) {
      if ((a.execute === true || a.execute === 'true') && /^\d{1,30}$/.test(a['draft-id'] || '') && ready(a['draft-id'])) {
        let attempted = false;
        try { attempted = await H.main(({ id }) => !!sessionStorage.getItem('ww-article-submit:' + id), { id: a['draft-id'] }); } catch {}
        if (attempted) H.fail('OUTCOME_UNKNOWN', 'A submission was attempted; inspect article-status or the creator center before retrying');
      }
      throw e;
    }
  }
  async function status(a) {
    if (!!a.id === !!a['draft-id']) H.fail('INVALID_ARGS', 'Provide exactly one of id or draft-id');
    const id = a.id ? H.id(a.id) : null, draftId = a['draft-id'] ? H.id(a['draft-id']) : null;
    if (location.hostname !== 'juejin.cn') return H.route('https://juejin.cn/', true);
    return H.main(async ({ id, draftId }) => {
      const request = async (endpoint, body) => {
        const r = await fetch('https://api.juejin.cn/content_api/v1/' + endpoint, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok || j.err_no !== 0 || !j.data) throw new Error('Article status could not be verified'); return j.data;
      };
      let draft;
      if (draftId) {
        draft = (await request('article_draft/detail', { draft_id: draftId })).article_draft;
        if (!draft || String(draft.id) !== draftId) throw new Error('Draft identity mismatch');
        id = String(draft.article_id);
        if (id === '0') return { status: 'draft', draft_id: draftId, title: draft.title, verified: true, verification: 'draft_api' };
        if (!/^\d{1,30}$/.test(id)) throw new Error('Draft returned invalid article ID');
      }
      const data = await request('article/detail', { article_id: id, req_from: 1, client_type: 2608, forbid_count: false, is_pre_load: false, need_theme: true });
      const d = data.article_info;
      if (!d || String(d.article_id) !== id) throw new Error('Article identity mismatch');
      const pageTitle = location.pathname === '/post/' + id ? document.querySelector('h1')?.textContent.trim() : null;
      return { status: 'submitted', article_id: id, ...(draftId ? { draft_id: draftId } : {}), title: d.title || draft?.title || pageTitle || null,
        url: 'https://juejin.cn/post/' + id, platform_status: { status: d.status, audit_status: d.audit_status },
        verified: true, verification: draftId ? 'draft_to_article_api' : 'article_api', message: 'Article identity verified; raw platform moderation status is preserved.' };
    }, { id, draftId });
  }
  window.__juejinPublishing = { prepare, publish, status };
})();
