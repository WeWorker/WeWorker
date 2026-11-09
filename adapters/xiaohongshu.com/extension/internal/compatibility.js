// Preserve old names and Chinese filter values; all reads use the new implementation.
window.__xhsCompatibility = async function (name, input = {}) {
  const args = { ...input };
  if (name === 'search') {
    const fields = { sortBy: ['sort', ['综合', '最新', '最多点赞', '最多评论', '最多收藏'], ['comprehensive', 'latest', 'most-liked', 'most-commented', 'most-collected']], noteType: ['note-type', ['不限', '视频', '图文'], ['all', 'video', 'image']], publishTime: ['publish-time', ['不限', '一天内', '一周内', '半年内'], ['anytime', 'day', 'week', 'half-year']], searchScope: ['scope', ['不限', '已看过', '未看过', '已关注'], ['all', 'seen', 'unseen', 'following']], location: ['location', ['不限', '同城', '附近'], ['all', 'same-city', 'nearby']] };
    args.query = args.query ?? args.keyword;
    for (const [old, [key, values, mapped]] of Object.entries(fields)) {
      if (args[old] !== undefined && values.includes(args[old])) args[key] = mapped[values.indexOf(args[old])];
      else if (old !== key && args[old] !== undefined) throw new Error('Invalid legacy filter: ' + old);
    }
  }
  if (name === 'note' || name === 'comments') args['note-id'] = args['note-id'] || args.url || args.id || location.href;
  return window.__xhsOpenCLI.invoke(name, args);
};

window.__xhsLegacyAction = async function (name, input = {}) {
  const id = input.id === undefined ? '' : String(input.id).trim();
  if (id && !/^[a-f0-9]{24}$/i.test(id)) throw new Error('Invalid note id');
  const target = window.__xhsOpenCLI.trustedUrl(input.url || (id ? `https://www.xiaohongshu.com/explore/${id}` : location.href));
  const getNoteId = path => path.match(/^\/(?:explore|search_result|note|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1] || path.match(/^\/user\/profile\/[a-f0-9]{24}\/([a-f0-9]{24})\/?$/i)?.[1];
  const targetId = getNoteId(target.pathname);
  if (target.hostname !== 'www.xiaohongshu.com' || !targetId) throw new Error('A Xiaohongshu note page is required');
  if (id && id !== targetId) throw new Error('Note id does not match its URL');
  const current = new URL(location.href);
  if (current.origin !== target.origin || getNoteId(current.pathname) !== targetId) {
    return { __webcli_navigation: { version: 1, url: target.href, resume: false, phase: 'prepare', result: { status: 'ready_to_retry', executed: false, message: '笔记页面已打开，尚未点赞或收藏；请用相同参数再次调用。' } } };
  }
  return window.__xiaohongshu_com_internal.invoke(`xiaohongshu.com.${name}`, input);
};
