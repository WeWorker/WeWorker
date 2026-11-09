/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {ArgumentError,CommandExecutionError,browserFetch}=window.__douyin;const requireObjectEvaluateResult=(r)=>{if(!r||typeof r!=='object')throw new CommandExecutionError('Malformed delete result');return r;};const CREATOR_MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage';
const WORK_LIST_URL = '/janus/douyin/creator/pc/work_list?status=0&count=20&max_cursor=0&scene=star_atlas&device_platform=android&aid=1128';
function readAwemeId(raw) {
    const value = String(raw ?? '').trim();
    if (!value) {
        throw new ArgumentError('douyin delete aweme_id cannot be empty');
    }
    if (!/^\d+$/.test(value)) {
        throw new ArgumentError('douyin delete aweme_id must be a numeric id');
    }
    return value;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function deleteViaCreatorManage(workId) {



    const result = requireObjectEvaluateResult(await ((__portValue0,__portValue1)=>(
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const targetId = __portValue0;
      const textOf = (node) => (node && (node.innerText || node.textContent) || '').trim();
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

      async function loadTarget() {
        const res = await fetch(__portValue1, { credentials: 'include' });
        const payload = await res.json();
        const list = Array.isArray(payload.aweme_list) ? payload.aweme_list : [];
        const matches = list
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => String(entry.aweme_id || '') === targetId || String(entry.item_id || '') === targetId);
        if (matches.length === 0) {
          return { ok: false, reason: 'not_found', status_code: payload.status_code, count: list.length };
        }
        if (matches.length !== 1) {
          return { ok: false, reason: 'target_not_unique', count: matches.length };
        }
        const { entry: item, index } = matches[0];
        const title = normalize(item.desc || item.caption || item.title || item.item_title || '');
        return { ok: true, item, index, listCount: list.length, title };
      }

      function visibleWorkCards() {
        const candidates = Array.from(document.querySelectorAll('[class*="video-card"]'))
          .filter((element) => {
            const text = normalize(textOf(element));
            return text.includes('删除作品') && text.includes('继续编辑');
          });
        return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
      }

      const target = await loadTarget();
      if (!target.ok) return target;

      const allTab = Array.from(document.querySelectorAll('button,[role="button"],span,div'))
        .find((element) => /^全部作品$/.test(normalize(textOf(element))));
      allTab?.click();
      await sleep(1000);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const cards = visibleWorkCards();
        if (cards.length >= target.listCount && cards[target.index]) {
          const matches=cards.filter(card=>[...card.querySelectorAll('a[href]')].some(a=>{try{return new URL(a.href).pathname==='/video/'+targetId}catch{return false}}));if(matches.length!==1)return {ok:false,reason:'target_dom_identity_unverified'};const card=matches[0];
          const deleteButton = Array.from(card.querySelectorAll('button,[role="button"],span,div'))
            .find((element) => /^删除作品$/.test(normalize(textOf(element))));
          if (!deleteButton) return { ok: false, reason: 'delete_button_not_found', aweme_id: target.item.aweme_id, item_id: target.item.item_id, index: target.index, cardCount: cards.length };
          deleteButton.click();
          await sleep(800);
          const confirmButton = Array.from(document.querySelectorAll('button,[role="button"]'))
            .find((element) => ['确定', '确认', '删除'].includes(normalize(textOf(element))));
          if (!confirmButton) return { ok: false, reason: 'confirm_button_not_found', aweme_id: target.item.aweme_id, item_id: target.item.item_id };
          confirmButton.click();
          for (let wait = 0; wait < 20; wait += 1) {
            await sleep(500);
            const after = await loadTarget();
            if (!after.ok && after.reason === 'not_found') {
              return { ok: true, aweme_id: target.item.aweme_id, item_id: target.item.item_id, title: target.title };
            }
          }
          return { ok: false, reason: 'delete_not_confirmed', aweme_id: target.item.aweme_id, item_id: target.item.item_id };
        }
        await sleep(500);
      }
      return { ok: false, reason: 'card_not_found', aweme_id: target.item.aweme_id, item_id: target.item.item_id, index: target.index, listCount: target.listCount };
    })()
  ))(String(workId),WORK_LIST_URL), '抖音后台管理删除响应异常');

    if (!result?.ok) {
        throw new CommandExecutionError(`抖音后台管理删除失败: ${JSON.stringify(result)}`);
    }
    return result;
}
async function findWorkListItem(workId) {
    const data = await browserFetch('GET', `https://creator.douyin.com${WORK_LIST_URL}`, { timeoutMs: 8000 });
    const list = data.data?.work_list ?? data.aweme_list ?? data.work_list ?? [];
    if (!Array.isArray(list)) {
        throw new CommandExecutionError('抖音作品列表响应缺少 work_list/aweme_list');
    }
    return list.find((entry) => String(entry.aweme_id || '') === workId || String(entry.item_id || '') === workId) || null;
}
const run=async (kwargs={}) => {
        const awemeId = readAwemeId(kwargs.aweme_id);
        try {
            const deleted = await deleteViaCreatorManage(awemeId);
            return [{ status: `✅ 已通过后台管理删除 ${deleted.aweme_id || awemeId}` }];
        } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            if (!fallbackMessage.includes('"reason":"not_found"')) {
                throw fallbackError;
            }
        }

        const before = await findWorkListItem(awemeId);
        if (!before) {
            throw new CommandExecutionError(`抖音作品 ${awemeId} 未在作品列表中找到，未执行删除`);
        }
        const url = 'https://creator.douyin.com/web/api/media/aweme/delete/?aid=1128';
        await browserFetch('POST', url, { body: { aweme_id: awemeId }, timeoutMs: 8000 });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            await sleep(500);
            const after = await findWorkListItem(awemeId);
            if (!after) {
                return [{ status: `✅ 已删除 ${awemeId}` }];
            }
        }
        throw new CommandExecutionError(`抖音作品 ${awemeId} 删除后仍在作品列表中，删除未确认`);
    };__webcliRegisterCommand('delete',async(args={})=>{readAwemeId(args.aweme_id);if(!window.__douyin.same(CREATOR_MANAGE_URL))return {__webcli_navigation:{version:1,url:CREATOR_MANAGE_URL,resume:false,phase:'prepare',result:{status:'prepared',message:'作品管理页已准备，核对目标后再次确认；尚未删除。'}}};return run(args);});})();
