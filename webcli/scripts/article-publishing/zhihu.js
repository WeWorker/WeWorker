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
        if (localStorage.getItem('ww-article-submit:' + draftId) || sessionStorage.getItem('ww-article-submit:' + draftId)) throw new Error('Draft submission already attempted; inspect article-status before editing');
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
        window.__wwArticleSavedNeedsReload = id;
        return { status: 'draft_saved', draft_id: id, title: j.title, image_count: imageCount, verification: 'draft_api', editor_url: location.href };
      }, { title, expectedText, imageCount: refs.length });
      if (r) return r;
    }
    H.fail('OUTCOME_UNKNOWN', 'Draft content not fully verified; inspect it before retrying');
  }
  // Serialized into MAIN world: every dependency stays inside this function.
  async function preflightPage({ id, title }) {
    const assertPage = () => {
      if (location.hostname !== 'zhuanlan.zhihu.com' || location.pathname !== '/p/' + id + '/edit') throw new Error('Editor navigated away from the target draft');
    };
    assertPage();
    if (localStorage.getItem('ww-article-submit:' + id) || sessionStorage.getItem('ww-article-submit:' + id)) {
      const e = new Error('Submission was already attempted; query article-status before any retry'); e.code = 'OUTCOME_UNKNOWN'; throw e;
    }
    const res = await fetch('/api/articles/' + id + '/draft', { credentials: 'include' });
    const j = JSON.parse((await res.text()).replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"'));
    assertPage();
    if (!res.ok || String(j.id) !== id || j.title !== title || !j.content || j.state !== 'draft') throw new Error('Target is not an unpublished matching draft');
    const parse = html => new DOMParser().parseFromString(html || '', 'text/html').body;
    const expected = parse(j.content), norm = text => text.replace(/[\s\u200b\ufeff]/g, '');
    if (!norm(expected.textContent)) throw new Error('Draft body is empty');
    const images = [...expected.querySelectorAll('img')];
    if (images.some(img => !/^https:\/\//.test(img.getAttribute('src') || ''))) throw new Error('Draft contains unuploaded images');
    if (window.__wwArticleSavedNeedsReload === id) return { reload: true, reason: 'saved_editor_requires_reload' };
    const ed = document.querySelector('.public-DraftEditor-content');
    let fiber = ed?.[Object.keys(ed).find(k => k.startsWith('__reactFiber$'))], node;
    for (let i = 0; fiber && i < 48; i++, fiber = fiber.return) {
      if (typeof fiber.stateNode?.syncDraft === 'function') { node = fiber.stateNode; break; }
    }
    if (!node || typeof node.state?.content !== 'string' || String(node.props?.postId) !== id) throw new Error('Editor state cannot be verified');
    const matches = html => {
      const body = parse(html);
      return norm(body.textContent) === norm(expected.textContent) && body.querySelectorAll('img').length === images.length;
    };
    const titleInput = document.querySelector('textarea[placeholder*="标题"]');
    const states = [node.state.content, node.state.realTimeContent, node.props.content].filter(v => typeof v === 'string');
    if (titleInput?.value !== title || !states.every(matches) || ed.querySelectorAll('img').length !== images.length) return { reload: true, reason: 'editor_server_mismatch' };
    // Below-the-fold images use loading=lazy; check the actual resource rather than
    // treating viewport deferral as an upload failure. This does not edit the draft.
    await Promise.all([...ed.querySelectorAll('img')].map(async img => {
      if (img.complete && img.naturalWidth) return;
      img.loading = 'eager';
      let timer;
      try {
        if (typeof img.decode === 'function') await Promise.race([
          img.decode(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Image load timed out')), 8000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }));
    const failedImages = [...ed.querySelectorAll('img')].some(img => !img.complete || !img.naturalWidth);
    if (failedImages) throw new Error('Editor images have not finished loading');
    return { reload: false, image_count: images.length };
  }
  async function publishUnsafe(a) {
    H.execute(a); const id = H.id(a['draft-id']), title = H.title(a.title);
    if (!['ai','none'].includes(a.declaration || 'none')) H.fail('INVALID_ARGS','declaration must be ai or none');
    if (!ready(id)) return H.route(editorURL(id));
    const checked = await H.main(preflightPage, { id, title });
    if (checked.reload) {
      const route = H.route(editorURL(id));
      Object.assign(route.__webcli_navigation.result, { draft_id: id, reason: checked.reason, message: 'Draft verified; editor reloaded to synchronize its state. Repeat this authorized publish call. Nothing was submitted.' });
      return route;
    }
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
        const options = [...document.querySelectorAll('[role=option]')].filter(e => e.getClientRects().length && e.textContent.includes('包含 AI 辅助创作'));
        if (options.length !== 1) throw new Error('AI declaration option missing'); options[0].click();
      });
    }
    await H.wait(800);
    // Recheck after asynchronous UI work; a different task must not switch the target.
    const finalCheck = await H.main(preflightPage, { id, title });
    if (finalCheck.reload) H.fail('EDITOR_NOT_READY', 'Editor changed during preparation; nothing was submitted');
    await H.main(({ id, title, declaration }) => {
      if (location.pathname !== '/p/' + id + '/edit') throw new Error('Editor navigated away');
      if (declaration === 'ai' && ![...document.querySelectorAll('button[role=combobox]')].some(e => e.textContent.includes('包含 AI 辅助创作'))) throw new Error('AI declaration not retained');
      const alerts = [...document.querySelectorAll('[role=alert]')].filter(e => e.getClientRects().length && e.textContent.trim());
      if (alerts.length) throw new Error('Editor validation: ' + alerts.map(e => e.textContent.trim()).join('; ').slice(0, 300));
      if (localStorage.getItem('ww-article-submit:' + id) || sessionStorage.getItem('ww-article-submit:' + id)) throw new Error('Submission already attempted');
      const buttons = [...document.querySelectorAll('button')].filter(e => e.getClientRects().length && e.textContent.trim() === '发布');
      if (buttons.length !== 1 || buttons[0].disabled) throw new Error('Publish button unavailable or ambiguous');
      const key = 'ww-article-submit:' + id;
      const receipt = { title, at: Date.now(), phase: 'click_dispatched', request_seen: false };
      // Persistent per-article journal also protects other tabs and survives reload.
      localStorage.setItem(key, JSON.stringify(receipt)); sessionStorage.setItem(key, JSON.stringify(receipt));
      const original = window.fetch;
      const stop = () => { if (window.fetch === wrapped) window.fetch = original; };
      const wrapped = async function(input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
        const matches = url.origin === location.origin && url.pathname === '/api/articles/' + id + '/publish' && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST';
        if (!matches) return original.apply(this, arguments);
        receipt.request_seen = true; receipt.phase = 'request_sent'; localStorage.setItem(key, JSON.stringify(receipt));
        try {
          const response = await original.apply(this, arguments);
          receipt.http_status = response.status;
          receipt.phase = response.ok ? 'response_received' : 'request_rejected';
          localStorage.setItem(key, JSON.stringify(receipt));
          return response;
        } catch (error) {
          receipt.phase = 'network_error'; localStorage.setItem(key, JSON.stringify(receipt)); throw error;
        } finally { stop(); }
      };
      window.fetch = wrapped;
      // This observer records only URL identity, HTTP status and timing, never headers/body.
      setTimeout(stop, 30000);
      try { buttons[0].click(); } catch (error) { stop(); throw error; }
    }, { id, title, declaration: a.declaration });
    for (let i = 0; i < 12; i++) {
      await H.wait(500);
      const observed = await H.main(async ({ id, title }) => {
        const record = JSON.parse(localStorage.getItem('ww-article-submit:' + id) || 'null');
        if (!record) throw new Error('Submission journal missing');
        let res = await fetch('/api/articles/' + id, { credentials: 'include' });
        if (res.status === 404) res = await fetch('/api/articles/' + id + '/draft', { credentials: 'include' });
        let state = null;
        if (res.ok) {
          const article = JSON.parse((await res.text()).replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"'));
          if (String(article.id) !== id || article.title !== title) throw new Error('Article identity changed');
          state = article.state;
        }
        const alerts = [...document.querySelectorAll('[role=alert]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()).filter(Boolean);
        return { phase: record.phase, request_seen: record.request_seen, http_status: record.http_status, state, alerts: alerts.join('; ').slice(0,300) };
      }, { id, title });
      if (observed.state === 'published') return { status: 'published', article_id: id, title, url: 'https://zhuanlan.zhihu.com/p/' + id, verified: true, verification: 'article_api' };
      if (observed.phase === 'request_rejected' || observed.phase === 'network_error' || observed.alerts) H.fail('OUTCOME_UNKNOWN', 'Publish was attempted but not confirmed; HTTP=' + (observed.http_status || 'unknown') + '; ' + (observed.alerts || observed.phase) + '. Query article-status; do not automatically retry.');
      if (observed.phase === 'response_received') return { status: 'submission_received', article_id: id, title, url: 'https://zhuanlan.zhihu.com/p/' + id, verified: false, verification: 'publish_http_response', http_status: observed.http_status, next_action: 'article-status --id=' + id, message: 'Publish endpoint responded; final state is not yet published. Query status; do not resubmit.' };
    }
    H.fail('OUTCOME_UNKNOWN', 'Publish click dispatched, but no publish response or published state was verified. Inspect article-status and editor validation; do not automatically retry.');
  }

  async function publish(a) {
    try { return await publishUnsafe(a); }
    catch (e) {
      if (e.code === 'OUTCOME_UNKNOWN') throw e;
      if ((a.execute === true || a.execute === 'true') && /^\d{1,30}$/.test(a['draft-id'] || '') && ready(a['draft-id'])) {
        let attempted = false;
        try { attempted = await H.main(({ id }) => !!(localStorage.getItem('ww-article-submit:' + id) || sessionStorage.getItem('ww-article-submit:' + id)), { id: a['draft-id'] }); } catch {}
        if (attempted) H.fail('OUTCOME_UNKNOWN', 'Submission attempted; query article-status before retrying. Detail: ' + e.message);
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
