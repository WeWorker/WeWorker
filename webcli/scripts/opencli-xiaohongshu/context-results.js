const from = path => ({ from: 'item.' + path });
const value = value => ({ value });
const action = (id, label, command, args) => ({ id, label, command, args });
const rule = actions => [{ itemsPath: '$', idField: 'context_ref', titleField: 'context_title', actions }];
const variants = (item, when) => ({ id: item.id, label: item.label, variants: [{ when, command: item.command, args: item.args }] });
const noteActions = [
  action('detail', '查看笔记', 'note', { 'note-id': from('context_note_url') }),
  action('comments', '查看评论', 'comments', { 'note-id': from('context_note_url') }),
  action('download', '下载媒体', 'download', { 'note-id': from('context_note_url') }),
  action('like', '点赞', 'like-note', { id: from('context_note_id'), url: from('context_note_url'), confirm: value(true) }),
  action('favorite', '收藏', 'favorite-note', { id: from('context_note_id'), url: from('context_note_url'), confirm: value(true) }),
];
const authorActions = [
  action('detail', '查看作者', 'user', { id: from('context_user_id') }),
  action('follow', '关注作者', 'follow', { 'user-id': from('context_user_id') }),
  action('unfollow', '取消关注作者', 'unfollow', { 'user-id': from('context_user_id') }),
];
const draftActions = [
  action('detail', '查看草稿', 'draft-open', { id: from('id'), type: from('type') }),
  action('delete', '删除草稿', 'draft-delete', { id: from('id'), type: from('type'), execute: value(true) }),
];
const ownDelete = action('delete', '删除作品', 'delete-note', { 'note-id': from('context_note_id'), execute: value(true) });
const noActions = reason => [{ actions: [], reason }];
export const resultMetadata = {
  ...Object.fromEntries(['feed', 'search', 'search-notes', 'liked', 'saved', 'user'].map(name => [name, rule(noteActions)])),
  ...Object.fromEntries(['note', 'open-note'].map(name => [name, rule([
    ...noteActions.filter(a => a.id !== 'detail').map(a => variants(a, { field: 'title' })),
  ])])),
  ...Object.fromEntries(['comments', 'read-comments'].map(name => [name, rule(authorActions)])),
  'creator-notes': rule([action('detail', '查看作品数据', 'creator-note-detail', { 'note-id': from('context_note_id') }), ownDelete]),
  'creator-notes-summary': rule([action('detail', '查看作品数据', 'creator-note-detail', { 'note-id': from('context_note_id') }), ownDelete]),
  'creator-note-detail': rule([variants(ownDelete, { section: '笔记信息', metric: 'note_id' })]),
  drafts: rule(draftActions),
  'draft-open': rule(draftActions.filter(a => a.id !== 'detail')),
  notifications: rule(authorActions),
  ...Object.fromEntries(['whoami', 'check-login-status'].map(name => [name, [{ itemPath: '$', idField: 'site', titleField: 'context_title', actions: [
    action('detail', '查看本人作品', 'creator-notes', {}),
    action('profile', '查看账号资料', 'creator-profile', {}),
    action('stats', '查看账号统计', 'creator-stats', {}),
    action('drafts', '查看本人草稿', 'drafts', {}),
  ] }]])),
  'creator-profile': noActions('返回完整账号资料及汇总字段，不含可选择的作品或用户ID；作品列表应独立调用creator-notes，不将字段行映射为作品操作。'),
  'creator-stats': noActions('返回所选周期的账号指标及趋势；指标不是笔记对象，当前无按指标下钻或修改指标的命令。'),
  'navigate-to-homepage': noActions('仅导航回首页的回执，不返回候选对象；需要推荐列表时调用feed。'),
};

const compact = text => Array.from(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('');
const noteId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? value : null;
function signedNote(raw, expected) {
  try {
    const url = new URL(raw);
    const id = url.pathname.match(/^\/(?:explore|search_result|note|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1]
      || url.pathname.match(/^\/user\/profile\/[a-f0-9]{24}\/([a-f0-9]{24})\/?$/i)?.[1];
    if (url.protocol === 'https:' && url.hostname === 'www.xiaohongshu.com' && !url.username && !url.password && !url.port
      && id && (!expected || id === expected) && url.searchParams.get('xsec_token')?.trim()) return { id, url: url.href };
  } catch { /* Missing provenance leaves an unavailable action. */ }
  return null;
}
export function decorateResults(name, args, result) {
  if (name === 'whoami' && result?.logged_in === true) return { ...result, context_title: compact(result.username) };
  if (!Array.isArray(result) || !resultMetadata[name]) return result;
  return result.map((row, index) => {
    const detail = name === 'note';
    const own = ['creator-notes', 'creator-notes-summary', 'creator-note-detail'].includes(name);
    const id = noteId(own && name === 'creator-note-detail' ? args['note-id'] : row.id);
    const target = signedNote(detail ? args['note-id'] : row.url, id);
    const user = row.userId;
    return { ...row, context_ref: String(index + 1), context_title: compact(row.title || row.text || row.content || row.author || row.metric || (row.field === 'title' ? row.value : row.field) || row.action || row.id),
      context_note_id: own ? id : target?.id ?? null, context_note_url: target?.url ?? null,
      context_user_id: typeof user === 'string' && /^[a-f0-9]{24}$/i.test(user) ? user : null };
  });
}
