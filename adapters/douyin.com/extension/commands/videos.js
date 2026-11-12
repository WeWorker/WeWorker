/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
(function(){const {CliError,ArgumentError,CommandExecutionError,EmptyResultError,AuthRequiredError,navigate,same,guard,integer,bool,list,browserFetch,toUnixSeconds,validateTiming,fetchDouyinUserVideos,fetchDouyinComments}=window.__douyin;
const WORK_LIST_URL = 'https://creator.douyin.com/janus/douyin/creator/pc/work_list';
const MAX_HOPS = 50;
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = MAX_HOPS * 50;
function isScheduledWork(work) {
    return (work.public_time ?? 0) > Date.now() / 1000;
}
function countEligibleWorks(items, status) {
    return status === 'scheduled' ? items.filter(isScheduledWork).length : items.length;
}
function normalizeVideosLimit(raw) {
    const value = raw === undefined || raw === null || raw === '' ? DEFAULT_LIMIT : Number(raw);
    if (!Number.isInteger(value) || value < MIN_LIMIT || value > MAX_LIMIT) {
        throw new ArgumentError(`douyin videos limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`);
    }
    return value;
}
function pageSizeForLimit(limit) {
    if (limit < 20)
        return 20;
    if (limit > 50)
        return 50;
    return limit;
}
function normalizeVideoStatus(status, publicTime) {
    if (typeof status === 'number')
        return status;
    if (!status)
        return publicTime && publicTime > Date.now() / 1000 ? 'scheduled' : 'published';
    if (status.is_delete)
        return 'deleted';
    if (status.is_prohibited)
        return 'prohibited';
    if (status.in_reviewing)
        return 'reviewing';
    if (status.is_private)
        return 'private';
    if (publicTime && publicTime > Date.now() / 1000)
        return 'scheduled';
    return 'published';
}
__webcliRegisterCommand("videos",async (kwargs={}) => {
kwargs={...{"limit":20,"status":"all"},...kwargs};kwargs["limit"]=integer(kwargs["limit"],20,2500);if(location.hostname!=='creator.douyin.com')return navigate('https://creator.douyin.com/creator-micro/content/manage');

        const statusMap = { all: 0, published: 1, reviewing: 3, scheduled: 0 };
        const statusNum = statusMap[kwargs.status] ?? null;
        const limit = normalizeVideosLimit(kwargs.limit);
        const pageSize = pageSizeForLimit(limit);
        // work_list is cursor-paginated: it ignores page_num and advances through max_cursor.
        // Walk the cursor until the server stops reporting has_more.
        const items = [];
        const seenAwemeIds = new Set();
        let cursor;
        for (let hop = 0; hop < MAX_HOPS && countEligibleWorks(items, kwargs.status) < limit; hop++) {
            const params = new URLSearchParams({
                page_size: String(pageSize),
                status: String(statusNum),
            });
            if (cursor !== undefined)
                params.set('max_cursor', String(cursor));
            const res = (await browserFetch('GET', `${WORK_LIST_URL}?${params.toString()}`));
            const payload = res.data && typeof res.data === 'object' ? res.data : res;
            const batch = payload.work_list ?? payload.aweme_list ?? res.work_list ?? res.aweme_list;if(!Array.isArray(batch))throw new CommandExecutionError('Douyin missing work list');
            if (batch.length === 0)
                break;
            for (const work of batch) {
                const awemeId = work?.aweme_id == null ? '' : String(work.aweme_id);
                if (awemeId && seenAwemeIds.has(awemeId))
                    continue;
                if (awemeId)
                    seenAwemeIds.add(awemeId);
                items.push(work);
            }
            const nextCursor = payload.max_cursor ?? res.max_cursor;
            const hasMore = payload.has_more ?? res.has_more;
            if (!hasMore || nextCursor === undefined || nextCursor === null
                || (cursor !== undefined && String(nextCursor) === String(cursor)))
                break;
            cursor = nextCursor;
        }
        let rows = items;
        // The API has a bug with status=16 for scheduled, so filter client-side
        if (kwargs.status === 'scheduled') {
            rows = rows.filter(isScheduledWork);
        }
        return rows.slice(0, limit).map((v) => ({
            aweme_id: v.aweme_id,
            title: v.desc ?? '',
            context_title: Array.from(String(v.desc || v.aweme_id || '').replace(/\s+/g, ' ').trim()).slice(0, 60).join(''),
            status: normalizeVideoStatus(v.status, v.public_time),
            play_count: v.statistics?.play_count ?? null,
            digg_count: v.statistics?.digg_count ?? null,
            comment_count: v.statistics?.comment_count ?? null,
            collect_count: v.statistics?.collect_count ?? null,
            share_count: v.statistics?.share_count ?? null,
            duration: v.duration ?? null,
            create_time: new Date((v.create_time ?? v.public_time ?? null) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        }));
    });})();
