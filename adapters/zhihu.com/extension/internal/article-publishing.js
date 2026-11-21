/* Zhihu article editor: site image uploader + site save action + server draft readback. */
(() => {
  const H = window.__articlePublish;
  const editorURL = id => id ? 'https://zhuanlan.zhihu.com/p/' + id + '/edit' : 'https://zhuanlan.zhihu.com/write';
  function ready(id) { return location.hostname === 'zhuanlan.zhihu.com' && (id ? location.pathname === '/p/' + id + '/edit' : location.pathname === '/write'); }
  async function prepare(a) {
    H.execute(a); const title = H.title(a.title), draftId = a['draft-id'] ? H.id(a['draft-id']) : null;
    const doc = H.cleanHTML(await H.text(a.file));
    // The article API strips raw HTML tables. Preserve every cell as a readable list.
    for (const table of doc.querySelectorAll('table')) {
      const list = doc.ownerDocument.createElement('ul');
      for (const row of table.querySelectorAll('tr')) {
        const item = doc.ownerDocument.createElement('li');
        item.innerHTML = [...row.querySelectorAll('th,td')].map(cell => cell.innerHTML).join('：');
        list.appendChild(item);
      }
      table.replaceWith(list);
    }
    const refs = [...doc.querySelectorAll('img')];
    for (const img of refs) if (!H.local(img.getAttribute('src'))) H.fail('INVALID_ARGS', 'Use absolute local image paths in HTML; upload is handled by this command');
    const files = await H.images(refs.map(img => img.getAttribute('src')));
    const expectedText = doc.textContent.replace(/[\s\u200b\ufeff]/g, '');
    if (!expectedText) H.fail('INVALID_ARGS', 'Article body must contain text');
    if (!ready(draftId)) return H.route(editorURL(draftId));
    await H.main(async ({ draftId }) => {
      if (draftId) {
        const res = await fetch('/api/articles/' + draftId + '/draft', { credentials: 'include' });
        const draft = await res.json();
        if (!res.ok || draft.state !== 'draft') throw new Error('Target is not an unpublished draft');
      }
      const ed = document.querySelector('.public-DraftEditor-content');
      if (!ed) throw new Error('Editor not ready');
      if (!draftId && (ed.textContent.trim() || ed.querySelector('img') || document.querySelector('textarea[placeholder*="标题"]')?.value.trim())) throw new Error('Existing content; pass its draft-id explicitly');
    }, { draftId });
    const media = new Map();
    for (const file of files) {
      const key = await H.stage(file);
      try {
        const image = await H.main(async ({ key }) => {
          const ed = document.querySelector('.public-DraftEditor-content');
          let fiber = ed[Object.keys(ed).find(k => k.startsWith('__reactFiber$'))];
          for (let i = 0; fiber && i < 48; i++, fiber = fiber.return) {
            const node = fiber.stateNode;
            if (typeof node?.syncDraft !== 'function' || typeof node.props?.uploadImage !== 'function') continue;
            const result = await node.props.uploadImage(window[key], 'default', 'article');
            const p = result?.payload;
            if (result?.type !== 'upload/image/success' || !p?.hash || !/^https:\/\/(?:[^/]+\.)?(?:zhimg\.com|zhihu\.com)\//.test(p.src)) throw new Error('Site image upload receipt invalid: ' + (result?.type || 'missing type') + ' / fields=' + Object.keys(p || {}).join(','));
            const el = document.createElement('img');
            for (const [k,v] of Object.entries({src:p.src,'data-original-src':p.originalSrc,'data-rawwidth':p.dataRawwidth,'data-rawheight':p.dataRawheight,'data-size':'normal','data-watermark':p.watermark})) if (v) el.setAttribute(k,v);
            return el.outerHTML;
          }
          throw new Error('Site image uploader unavailable');
        }, { key });
        media.set(file.path, image);
      } finally { await H.unstage(key); }
    }
    for (const img of refs) {
      const replacement = new DOMParser().parseFromString(media.get(img.getAttribute('src')), 'text/html').body.firstElementChild;
      replacement.setAttribute('alt', img.getAttribute('alt') || '');
      img.replaceWith(replacement);
    }
    // Use the site's own save action: it retains authentication, signing and pending-write handling.
    // Pasting a large rich article can render before its serializer/autosave finishes.
    await H.main(async ({ html, title }) => {
      const ed = document.querySelector('.public-DraftEditor-content');
      let fiber = ed[Object.keys(ed).find(k => k.startsWith('__reactFiber$'))];
      for (let i = 0; fiber && i < 48; i++, fiber = fiber.return) {
        const node = fiber.stateNode;
        if (typeof node?.syncDraft === 'function' && typeof node.props?.updateDraft === 'function') {
          await node.props.updateDraft({ content: html, title }); return;
        }
      }
      throw new Error('Site draft save action unavailable');
    }, { html: doc.innerHTML, title });
    for (let i = 0; i < 24; i++) {
      await H.wait(500);
      const r = await H.main(async ({ title, expectedText, imageCount }) => {
        const id = location.pathname.match(/^\/p\/(\d+)\/edit$/)?.[1]; if (!id) return null;
        const res = await fetch('/api/articles/' + id + '/draft', { credentials: 'include' });
        if (!res.ok) throw new Error('Draft readback failed');
        const j = JSON.parse((await res.text()).replace(/("id"\s*:\s*)(\d{16,})/g,'$1"$2"'));
        const body = new DOMParser().parseFromString(j.content || '', 'text/html').body;
        if (j.title !== title || body.textContent.replace(/[\s\u200b\ufeff]/g,'') !== expectedText || body.querySelectorAll('img').length !== imageCount) return null;
        if ([...body.querySelectorAll('img')].some(img=>!/^https:\/\//.test(img.getAttribute('src')||''))) throw new Error('Unuploaded image in saved draft');
        return { status: 'draft_saved', draft_id: id, title: j.title, image_count: imageCount, verification: 'draft_api', editor_url: location.href };
      }, { title, expectedText, imageCount: refs.length });
      if (r) return r;
    }
    H.fail('OUTCOME_UNKNOWN', 'Draft content not fully verified; inspect it before retrying');
  }
  async function publishUnsafe(a) {
    H.execute(a); const id = H.id(a['draft-id']), title = H.title(a.title);
    if (!ready(id)) return H.route(editorURL(id));
    if (!['ai','none'].includes(a.declaration || 'none')) H.fail('INVALID_ARGS','declaration must be ai or none');
    if (a.declaration === 'ai') {
      await H.main(() => {
        const boxes = [...document.querySelectorAll('button[role=combobox]')];
        if (boxes.some(e => e.textContent.includes('包含 AI 辅助创作'))) return;
        const box = boxes.find(e => e.textContent.trim() === '无声明');
        if (!box) throw new Error('Creation declaration missing'); box.click();
      });
      await H.wait(200);
      await H.main(() => {
        if ([...document.querySelectorAll('button[role=combobox]')].some(e => e.textContent.includes('包含 AI 辅助创作'))) return;
        const options = [...document.querySelectorAll('[role=option]')].filter(e => e.textContent.includes('包含 AI 辅助创作'));
        if (options.length !== 1) throw new Error('AI declaration option missing'); options[0].click();
      });
    }
    await H.wait(800);
    await H.main(async ({ id, title, declaration }) => {
      const res = await fetch('/api/articles/' + id + '/draft'); const j = await res.json();
      if (!res.ok || j.title !== title || !j.content || j.state !== 'draft') throw new Error('Draft is not an unpublished matching article');
      if (declaration === 'ai' && ![...document.querySelectorAll('button[role=combobox]')].some(e => e.textContent.includes('包含 AI 辅助创作'))) throw new Error('AI declaration not retained');
      if (sessionStorage.getItem('ww-article-submit:' + id)) throw new Error('Already attempted; inspect article-status before resubmitting');
      const buttons = [...document.querySelectorAll('button')].filter(e => e.getClientRects().length && e.textContent.trim() === '发布');
      if (buttons.length !== 1 || buttons[0].disabled) throw new Error('Publish button unavailable or ambiguous');
      sessionStorage.setItem('ww-article-submit:' + id, JSON.stringify({ title, at: Date.now() }));
      buttons[0].click();
    }, { id, title, declaration: a.declaration });
    return { status: 'submission_started', article_id: id, title, url: 'https://zhuanlan.zhihu.com/p/' + id, verified: false,
      next_action: 'article-status --id=' + id, message: 'One submit action was dispatched. Query status separately; do not automatically resubmit.' };
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
    const id = H.id(a.id);
    if (location.hostname !== 'zhuanlan.zhihu.com') return H.route('https://zhuanlan.zhihu.com/', true);
    return H.main(async ({ id }) => {
      let res = await fetch('/api/articles/' + id, { credentials: 'include' });
      if (res.status === 404) res = await fetch('/api/articles/' + id + '/draft', { credentials: 'include' });
      if (!res.ok) throw new Error('Article status request failed (' + res.status + ')');
      const j = JSON.parse((await res.text()).replace(/("id"\s*:\s*)(\d{16,})/g,'$1"$2"'));
      if (String(j.id) !== id || typeof j.title !== 'string' || typeof j.state !== 'string') throw new Error('Malformed article status');
      return { status: j.state === 'published' ? 'published' : j.state === 'draft' ? 'draft' : 'submitted', article_id: id, title: j.title, url: 'https://zhuanlan.zhihu.com/p/' + id, platform_status: j.state, verified: true, verification: 'article_api' };
    }, { id });
  }
  window.__zhihuPublishing = { prepare, publish, status };
})();
