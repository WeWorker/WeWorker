/**
 * Baidu Tieba Adapter Script
 *
 * NOTE: Runs in isolated world — can only access DOM and same-origin web APIs.
 *
 * Maintainer: WeWorker project
 */

// ─── Utilities ───────────────────────────────────────────────────────────────

function normalizedText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisibleElement(el) {
  return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects?.().length));
}

function isTiebaPage() {
  return /(^|\.)tieba\.baidu\.com$/i.test(window.location.hostname);
}

function isThreadPath(pathname = window.location.pathname) {
  return /^\/p\/\d+/i.test(pathname);
}

function isForumPath(pathname = window.location.pathname) {
  return pathname === '/f' || pathname.startsWith('/f/');
}

function threadIdFromUrl(url = window.location.href) {
  try {
    const { pathname } = new URL(url, window.location.origin);
    return pathname.match(/^\/p\/(\d+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function getForumNameFromPage() {
  const fromUrl = (() => {
    try {
      const url = new URL(window.location.href);
      return normalizedText(url.searchParams.get('kw') || '');
    } catch {
      return '';
    }
  })();
  return fromUrl
    || normalizedText(document.querySelector('.head-name, .name-info-link, .forum-info-left')?.textContent || '').replace(/吧.*/, '')
    || normalizedText(document.querySelector('.card_title_fname, .forum_name, .fname, .u-f-item')?.textContent || '')
    || normalizedText(document.querySelector('a[href*="/f?kw="]')?.textContent || '').replace(/吧$/, '');
}

function normalizeForumUrl({ forum_name = '', url = '' } = {}) {
  const rawUrl = String(url || '').trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl, window.location.origin).href;
    } catch {
      return rawUrl;
    }
  }
  const name = String(forum_name || getForumNameFromPage() || '').trim();
  return name ? `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}` : 'https://tieba.baidu.com/';
}

function normalizeThreadUrl({ thread_id = '', url = '' } = {}) {
  const rawUrl = String(url || '').trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl, window.location.origin).href;
    } catch {
      return rawUrl;
    }
  }
  const id = String(thread_id || '').trim();
  return id ? `https://tieba.baidu.com/p/${encodeURIComponent(id)}` : window.location.href;
}

function isSameNormalizedPage(targetUrl) {
  try {
    const current = new URL(window.location.href);
    const target = new URL(targetUrl, window.location.origin);
    return current.origin === target.origin
      && current.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '')
      && (current.pathname !== '/f' || current.searchParams.get('kw') === target.searchParams.get('kw'));
  } catch {
    return false;
  }
}

function navigateAndAskRetry(targetUrl, message) {
  window.location.assign(targetUrl);
  return {
    ok: true,
    needs_retry: true,
    url: targetUrl,
    message: message || '已跳转页面，请等待页面加载完成后再次调用该工具。',
  };
}

function hasLoginGate() {
  const bodyText = normalizedText(document.body?.innerText || '');
  const loginControls = Array.from(document.querySelectorAll('a, button, span, div')).some((el) => {
    if (!isVisibleElement(el)) return false;
    const text = normalizedText(el.innerText || el.textContent || el.getAttribute?.('title') || '');
    return /^登录$|立即登录|扫码登录|帐号登录/.test(text);
  });
  return loginControls || /登录后|请先登录|扫码登录|帐号登录/.test(bodyText);
}

function loginRequiredResult(action) {
  return {
    status: 'login_required',
    logged_in: false,
    action,
    message: '当前百度贴吧页面要求登录后才能继续。请在 WeWorker 控制的浏览器中完成登录后，再重新调用该工具。',
    url: window.location.href,
  };
}

function firstText(selectors, root = document) {
  for (const selector of selectors) {
    const el = root.querySelector?.(selector);
    const text = normalizedText(el?.innerText || el?.textContent || el?.getAttribute?.('title') || '');
    if (text) return text;
  }
  return '';
}

function clickControl(control) {
  const target = control?.closest?.('button, a, [role="button"], .button-wrapper, [class*="button"], [class*="btn"]') || control;
  target?.dispatchEvent?.(new MouseEvent('mouseover', { bubbles: true }));
  target?.dispatchEvent?.(new MouseEvent('mousedown', { bubbles: true }));
  target?.click?.();
  target?.dispatchEvent?.(new MouseEvent('mouseup', { bubbles: true }));
}

function findVisibleControl(patterns) {
  return Array.from(document.querySelectorAll('button, a, span, div, [role="button"]')).find((el) => {
    if (!isVisibleElement(el)) return false;
    const combined = normalizedText([
      el.innerText || el.textContent || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('class') || '',
      el.getAttribute?.('id') || '',
    ].join(' '));
    return patterns.some((pattern) => pattern.test(combined));
  }) || null;
}

function findExactActionControl(text) {
  const candidates = Array.from(document.querySelectorAll('button, a, span, div, [role="button"]'))
    .filter((el) => {
      if (!isVisibleElement(el)) return false;
      const label = normalizedText(el.innerText || el.textContent || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '');
      return label === text;
    })
    .map((el) => ({
      el,
      area: (() => {
        const rect = el.getBoundingClientRect?.();
        return rect ? rect.width * rect.height : Number.MAX_SAFE_INTEGER;
      })(),
      clickable: Boolean(el.closest?.('button, a, [role="button"], .button-wrapper, [class*="button"], [class*="btn"]')),
    }))
    .sort((left, right) => Number(right.clickable) - Number(left.clickable) || left.area - right.area);
  return candidates[0]?.el || null;
}

// ─── Login ──────────────────────────────────────────────────────────────────

async function checkLoginStatus() {
  const isNavigationUserText = (text) => /^(我的|首页|登录|发贴|贴吧|消息|设置|贴子|帖子|回复|关注|粉丝|动态|精品|热门游戏)$/.test(normalizedText(text));
  const profilePageUsername = /^\/home\/main/i.test(window.location.pathname)
    ? firstText([
      '.user-information-wrapper .user-name',
      '.user-info-wrapper .user-name',
      '.user-info .user-name',
      '.user-info .head-name',
      '.user-top-info-wrapper .head-name',
    ])
    : '';
  const loginLink = Array.from(document.querySelectorAll('a, button, span, div')).find((el) => {
    if (!isVisibleElement(el)) return false;
    return /^登录$/.test(normalizedText(el.innerText || el.textContent || ''));
  });
  const userLink = Array.from(document.querySelectorAll([
    'a[href*="/home/main"]',
    'a[href*="/i/i"]',
    '.u_username a',
    '.user_name a',
    '.userinfo_username',
  ].join(','))).find((el) => {
    const text = normalizedText(el.innerText || el.textContent || el.getAttribute?.('title') || '');
    const href = absoluteUrl(el.getAttribute?.('href') || '');
    let isTiebaProfileLink = false;
    try {
      const linkUrl = new URL(href || window.location.href, window.location.origin);
      isTiebaProfileLink = /(^|\.)tieba\.baidu\.com$/i.test(linkUrl.hostname)
        && (/^\/home\/main/i.test(linkUrl.pathname) || /^\/i\/i/i.test(linkUrl.pathname));
    } catch { }
    return isVisibleElement(el) && text && !isNavigationUserText(text) && isTiebaProfileLink;
  });
  const avatar = Array.from(document.querySelectorAll([
    '.u_menu_item img',
    '.userbar img',
    '.userinfo img',
    'a[href*="/home/main"] img',
    'a[href*="/i/i"] img',
  ].join(','))).find((img) => {
    const alt = normalizedText(img.getAttribute('alt') || '');
    const src = String(img.getAttribute('src') || '');
    return isVisibleElement(img) && (alt || /portrait|avatar|user/i.test(src));
  });
  const rawUsername = normalizedText(
    profilePageUsername
      || (userLink?.matches?.('.u_username a, .user_name a, .userinfo_username')
      ? (userLink.innerText || userLink.textContent || userLink.getAttribute?.('title') || '')
      : (avatar?.getAttribute?.('alt') || '')),
  );
  const username = isNavigationUserText(rawUsername) ? '' : rawUsername;
  const loginGate = hasLoginGate();
  const loggedIn = !loginGate && !loginLink && Boolean(username || userLink || avatar || isThreadPath() || isForumPath() || /^\/home\/main/i.test(window.location.pathname));

  return {
    logged_in: loggedIn,
    username: loggedIn ? username : '',
    profile_url: loggedIn && username
      ? (profilePageUsername ? window.location.href : absoluteUrl(userLink?.getAttribute?.('href') || ''))
      : '',
    signals: {
      has_user_link: Boolean(userLink),
      has_avatar: Boolean(avatar),
      has_login_entry: Boolean(loginLink),
      has_login_gate: loginGate,
    },
    url: window.location.href,
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

function parseThreadSearchResults(limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const results = [];
  const seen = new Set();
  const primaryLinks = Array.from(document.querySelectorAll('a.item-link-bg'));
  const links = primaryLinks.length ? primaryLinks : Array.from(document.querySelectorAll('a[href*="/p/"]')).filter((link) => {
    const className = String(link.className || '');
    return !/(^|\s)(action-link-bg|comment-link-zone|hot-thread|topic-card|topic-card-wrapper)(\s|$)/.test(className);
  });
  const pairedThreadLinks = primaryLinks.length
    ? Array.from(document.querySelectorAll('a.comment-link-zone[href*="/p/"]'))
    : [];
  const noiseLine = /^(发贴|登录|登录贴吧|首页|我的|综合|贴|吧|人|关注|分享|点击登录|其他方式登录|下载贴吧APP|大家都在逛的吧|折叠导航栏)$/;

  function chooseSearchCard(link) {
    const preferred = link.closest('.s_post, .search_post, .result, .list_item, .search-item, .thread-item, .search-result-item, .post-item, li');
    if (preferred && normalizedText(preferred.textContent || '').length > 10) return preferred;
    let cursor = link.parentElement;
    const candidates = [];
    while (cursor && cursor !== document.body) {
      const text = normalizedText(cursor.textContent || '');
      const threadLinkCount = cursor.querySelectorAll?.('a[href*="/p/"]').length || 0;
      if (text.length >= 20 && text.length <= 1200 && threadLinkCount <= 10 && /(发布于|评论|回复|吧|长图|\d+)/.test(text)) {
        candidates.push({ el: cursor, length: text.length });
      }
      if (text.length > 2200 || threadLinkCount > 24) break;
      cursor = cursor.parentElement;
    }
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0]?.el || link.parentElement || link;
  }

  function cleanSearchLines(root) {
    return (root.innerText || root.textContent || '')
      .split(/\n+/)
      .map((line) => normalizedText(line))
      .filter((line) => line && !noiseLine.test(line));
  }

  function addFromLink(link, index = 0) {
    if (results.length >= safeLimit) return;
    const root = chooseSearchCard(link);
    const url = absoluteUrl(
      link.getAttribute('href')
      || root.querySelector?.('a.comment-link-zone[href*="/p/"], a[href*="/p/"]:not(.action-link-bg):not(.hot-thread):not(.topic-card):not(.topic-card-wrapper)')?.getAttribute('href')
      || pairedThreadLinks[index]?.getAttribute('href')
      || '',
    );
    const id = threadIdFromUrl(url);
    if (!url || !id || seen.has(id)) return;
    seen.add(id);

    const lines = cleanSearchLines(root);
    const forum = normalizedText(root.querySelector?.('a[href*="/f?kw="], .p_forum, .forum_name, .forum-card-wrapper')?.textContent || lines.find((line) => /吧$|吧\s/.test(line)) || '')
      .replace(/^来自[:：]?/, '')
      .replace(/\s*吧\s*关注?$/, '')
      .replace(/吧$/, '');
    const rawExplicitTitle = normalizedText(
      link.getAttribute('title')
      || link.innerText
      || link.textContent
      || root.querySelector?.('.p_title, .thread_name, .item-title, .title, h3, h4')?.textContent
      || '',
    );
    const explicitTitle = rawExplicitTitle && !noiseLine.test(rawExplicitTitle) ? rawExplicitTitle : '';
    const contentLines = lines.filter((line) => {
      if (line === forum || line === `${forum}吧`) return false;
      if (/^发布于\s*\d{4}/.test(line)) return false;
      if (/发布于\s*\d{4}[-年]/.test(line) && line.length <= 28) return false;
      if (/^\d+$|^\d+(\.\d+)?[万wW]?$/.test(line)) return false;
      if (/^(长图|图)$/.test(line)) return false;
      if (/关注\+?\d*$/.test(line)) return false;
      return true;
    });
    const excerpt = normalizedText(root.querySelector?.('.p_content, .content, .abstract, .s_post_summary')?.textContent || contentLines.join(' ')).slice(0, 300);
    const titleCandidate = contentLines.find((line) => line.length >= 4 && line.length <= 80 && !/^发布于/.test(line))
      || contentLines.find((line) => line.length >= 4 && !/^发布于/.test(line))
      || excerpt;
    const title = explicitTitle
      ? explicitTitle
      : titleCandidate.slice(0, 80);
    const author = normalizedText(root.querySelector?.('.p_author, .author, .user_name, a[href*="/home"]')?.textContent || '');
    const stats = normalizedText(root.querySelector?.('.p_reply, .reply_num, .stats, .threadlist_rep_num')?.textContent || '');

    if (!title && !excerpt) return;
    results.push({ id, type: 'thread', title, url, forum, author, excerpt, stats });
  }

  links.forEach(addFromLink);
  return results;
}

function parseForumSearchResults(query, limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const results = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a[href*="/f?kw="], a[href^="/f?kw="]'));
  for (const link of links) {
    if (results.length >= safeLimit) break;
    const url = absoluteUrl(link.getAttribute('href') || '');
    let forumName = normalizedText(link.innerText || link.textContent || link.getAttribute('title') || '').replace(/吧$/, '');
    try {
      forumName = forumName || normalizedText(new URL(url).searchParams.get('kw') || '');
    } catch { }
    if (!forumName || seen.has(forumName)) continue;
    seen.add(forumName);
    results.push({
      id: forumName,
      type: 'forum',
      title: `${forumName}吧`,
      url,
      excerpt: normalizedText(link.closest('div, li, tr')?.textContent || '').slice(0, 240),
    });
  }

  const cleanQuery = String(query || '').trim();
  if (!results.length && cleanQuery) {
    results.push({
      id: cleanQuery,
      type: 'forum',
      title: `${cleanQuery}吧`,
      url: `https://tieba.baidu.com/f?kw=${encodeURIComponent(cleanQuery)}`,
      excerpt: '可打开该贴吧首页继续查看帖子列表。',
    });
  }
  return results;
}

async function searchContent({ query = '', type = 'thread', limit = 5 } = {}) {
  const keyword = String(query || '').trim();
  if (!keyword) {
    return { error: 'Missing required parameter', message: 'query parameter is required' };
  }
  const normalizedType = ['all', 'forum', 'thread'].includes(String(type || '').toLowerCase())
    ? String(type || '').toLowerCase()
    : 'thread';
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));

  if (normalizedType === 'forum') {
    const targetUrl = `https://tieba.baidu.com/f?kw=${encodeURIComponent(keyword)}`;
    if (!isSameNormalizedPage(targetUrl)) {
      return navigateAndAskRetry(targetUrl, `已打开“${keyword}吧”，请等待页面加载完成后再次调用该工具。`);
    }
    const forum = getForumNameFromPage() || keyword;
    const threadLinks = parseForumThreadList(Math.min(safeLimit, 5));
    return {
      query: keyword,
      type: normalizedType,
      count: 1,
      results: [{
        id: forum,
        type: 'forum',
        title: `${forum}吧`,
        url: window.location.href,
        excerpt: firstText(['.card_num, .forum_info, .profile_top', '.head_content', 'body']).slice(0, 300),
        threads: threadLinks,
      }],
      url: window.location.href,
    };
  }

  const targetUrl = `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(keyword)}`;
  const currentQuery = (() => {
    try {
      return new URL(window.location.href).searchParams.get('qw') || '';
    } catch {
      return '';
    }
  })();
  if (!window.location.pathname.startsWith('/f/search/res') || currentQuery !== keyword) {
    return navigateAndAskRetry(targetUrl, `已打开贴吧搜索页，请等待“${keyword}”搜索结果加载完成后再次调用该工具。`);
  }

  const threadResults = parseThreadSearchResults(safeLimit);
  const forumResults = normalizedType === 'all' ? parseForumSearchResults(keyword, Math.max(1, safeLimit - threadResults.length)) : [];
  const results = normalizedType === 'all' ? [...threadResults, ...forumResults].slice(0, safeLimit) : threadResults;
  return {
    query: keyword,
    type: normalizedType,
    count: results.length,
    results,
    url: window.location.href,
  };
}

function parseForumThreadList(limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const results = [];
  const seen = new Set();
  const roots = Array.from(document.querySelectorAll('.j_thread_list, .threadlist_li, li, div'));
  for (const root of roots) {
    if (results.length >= safeLimit) break;
    const link = root.querySelector?.('a[href*="/p/"]') || root.closest?.('a[href*="/p/"]');
    if (!link) continue;
    const url = absoluteUrl(link.getAttribute('href') || '');
    const id = threadIdFromUrl(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = normalizedText(link.getAttribute('title') || link.innerText || link.textContent || root.querySelector?.('.threadlist_title, .j_th_tit')?.textContent || '');
    if (!title) continue;
    results.push({
      id,
      title,
      url,
      author: normalizedText(root.querySelector?.('.frs-author-name, .tb_icon_author, .threadlist_author')?.textContent || ''),
      stats: normalizedText(root.querySelector?.('.threadlist_rep_num, .reply_num')?.textContent || ''),
    });
  }
  return results;
}

// ─── Thread detail / replies ────────────────────────────────────────────────

function parsePostRoot(root, index) {
  const author = normalizedText(root.querySelector?.('.p_author_name, .d_name a, .louzhubiaoshi, .user_name, a[href*="/home"]')?.textContent || '');
  const content = normalizedText(root.querySelector?.('.d_post_content, .j_d_post_content, .post_bubble_middle_inner, .content')?.innerText || root.querySelector?.('.d_post_content, .j_d_post_content, .post_bubble_middle_inner, .content')?.textContent || '').slice(0, 1200);
  const floor = normalizedText(root.querySelector?.('.tail-info, .post-tail-wrap, .core_reply_tail')?.textContent || '').match(/\d+\s*楼/)?.[0] || (index === 0 ? '1楼' : '');
  const time = normalizedText(Array.from(root.querySelectorAll('.tail-info, .post-tail-wrap span, .core_reply_tail span'))
    .map((el) => el.textContent || '')
    .find((text) => /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}|分钟前|小时前|昨天|今天/.test(text)) || '');
  return {
    author,
    content,
    floor,
    time,
  };
}

function threadTitleFromPage() {
  return firstText([
    '.core_title_txt',
    'h1',
    '.thread-title',
    '.post_title',
    'title',
  ]).replace(/-百度贴吧$/, '').trim();
}

function getMainThreadContainerText() {
  return normalizedText(document.querySelector('.main-content, .pb-page-wrapper, .pc-pb-box, .center-content')?.innerText || '');
}

function extractFallbackThreadContent(title = '') {
  const text = getMainThreadContainerText();
  if (!text) return '';
  const normalizedTitle = normalizedText(title).replace(/-百度贴吧$/, '');
  let content = text;
  if (normalizedTitle && content.includes(normalizedTitle)) {
    content = content.slice(content.indexOf(normalizedTitle) + normalizedTitle.length);
  }
  content = content
    .replace(/^\s*[\d\s]+/, '')
    .replace(/\s+\d+\s+\d+\s+\d+\s+\d+\s+全部回复[\s\S]*$/u, '')
    .replace(/\s+全部回复\s*\(\d+\)[\s\S]*$/u, '')
    .replace(/\s+只看楼主[\s\S]*$/u, '');
  return normalizedText(content).slice(0, 1200);
}

function extractFallbackReplies(limit = 10) {
  const text = getMainThreadContainerText();
  if (!text) return [];
  const afterLoginPrompt = text.split(/想说点啥？先登录一下吧~?/).slice(1).join(' ');
  const source = afterLoginPrompt || text.split(/全部回复\s*\(\d+\).*?(?:正序|倒序)/).slice(1).join(' ');
  if (!source) return [];
  const cleaned = normalizedText(source)
    .replace(/使用百度前必读[\s\S]*$/u, '')
    .replace(/\s+\d+\s+\d+\s+\d+\s+\d+\s+/g, ' ');
  const chunks = cleaned
    .split(/(?=(?:[\u4e00-\u9fa5A-Za-z0-9_]{2,24}\s+(?:\d{4}-\d{1,2}-\d{1,2}|IP属地|来自|回复|发布于)))/u)
    .map((item) => normalizedText(item))
    .filter((item) => item.length >= 12);
  const fallbackChunks = chunks.length ? chunks : cleaned.match(/.{20,260}(?:。|！|？|$)/gu) || [];
  return fallbackChunks.slice(0, Math.max(1, Math.min(Number(limit) || 10, 20))).map((content, index) => ({
    author: '',
    content: normalizedText(content).slice(0, 800),
    floor: index === 0 ? '可见回复' : '',
    time: '',
  })).filter((item) => (
    item.content.length >= 30
    && !/^\d+\s*楼\s*(?:\d{4}-\d{1,2}-\d{1,2})?\s*(?:[\u4e00-\u9fa5]{2})?$/.test(item.content)
    && !/^\d+\s*回复\b/.test(item.content)
  ));
}

function collectPostRoots() {
  const roots = Array.from(document.querySelectorAll([
    '.l_post',
    '.j_l_post',
    '[data-field][class*="l_post"]',
    '.p_postlist > div',
  ].join(','))).filter((root) => normalizedText(root.textContent || '').length > 20);
  return roots.length ? roots : Array.from(document.querySelectorAll('.d_post_content, .j_d_post_content'))
    .map((content) => content.closest('.l_post, .j_l_post, div'))
    .filter(Boolean);
}

async function openThreadDetail({ thread_id = '', url = '' } = {}) {
  const targetUrl = normalizeThreadUrl({ thread_id, url });
  if (!isThreadPath()) {
    return navigateAndAskRetry(targetUrl, '已打开贴吧帖子详情页，请等待页面加载完成后再次调用该工具读取详情。');
  }
  if ((thread_id || url) && !isSameNormalizedPage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开贴吧帖子详情页，请等待页面加载完成后再次调用该工具读取详情。');
  }

  await sleep(800);
  const posts = collectPostRoots();
  const firstPost = posts[0] ? parsePostRoot(posts[0], 0) : null;
  const title = threadTitleFromPage();
  const forum = getForumNameFromPage();
  const stats = normalizedText(document.querySelector('.core_title_info, .l_reply_num, .pb_footer, .thread_infos')?.textContent || '');
  const fallbackContent = firstPost?.content ? '' : extractFallbackThreadContent(title);
  const fallbackReplies = posts.length > 1 ? [] : extractFallbackReplies(3);
  return {
    type: 'thread',
    id: threadIdFromUrl(),
    title,
    forum,
    author: firstPost?.author || '',
    content: firstPost?.content || fallbackContent,
    stats,
    reply_count: Math.max(0, posts.length - 1, fallbackReplies.length),
    url: window.location.href,
  };
}

async function readReplies({ thread_id = '', url = '', limit = 10 } = {}) {
  const targetUrl = normalizeThreadUrl({ thread_id, url });
  if (!isThreadPath()) {
    return navigateAndAskRetry(targetUrl, '已打开贴吧帖子详情页，请等待页面加载完成后再次调用该工具读取回复。');
  }
  if ((thread_id || url) && !isSameNormalizedPage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开贴吧帖子详情页，请等待页面加载完成后再次调用该工具读取回复。');
  }

  await sleep(1000);
  let roots = collectPostRoots();
  if (roots.length <= 1) {
    const target = document.querySelector('.p_postlist, .l_post, .j_l_post, .d_post_content');
    if (target?.scrollIntoView) target.scrollIntoView({ block: 'center' });
    else window.scrollTo({ top: Math.max(0, document.body.scrollHeight * 0.4), behavior: 'auto' });
    await sleep(1200);
    roots = collectPostRoots();
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  const replies = roots.slice(1).map((root, index) => parsePostRoot(root, index + 1))
    .filter((item) => item.content)
    .slice(0, safeLimit);
  const fallbackReplies = replies.length ? [] : extractFallbackReplies(safeLimit);
  const finalReplies = replies.length ? replies : fallbackReplies;

  return {
    type: 'thread',
    id: threadIdFromUrl(),
    count: finalReplies.length,
    replies: finalReplies,
    message: finalReplies.length ? '已读取当前页面可见回复。' : '当前页面未读取到回复；可能内容尚未加载、帖子暂无回复或页面结构已变化。',
    url: window.location.href,
  };
}

// ─── High-impact actions ────────────────────────────────────────────────────

function forumActionState(kind) {
  const bodyText = normalizedText(document.body?.innerText || '');
  if (kind === 'follow' && /已关注|取消关注/.test(bodyText)) return { done: true, evidence: 'followed_text' };
  if (kind === 'sign' && /已签到|连续签到|今日已签到|签到排名|连签\s*\d+\s*天/.test(bodyText)) return { done: true, evidence: 'signed_text' };
  return { done: false, evidence: '' };
}

async function ensureForumPage(args = {}, actionName = '') {
  const targetUrl = normalizeForumUrl(args);
  if (!isForumPath()) {
    return navigateAndAskRetry(targetUrl, `已打开贴吧首页，请等待页面加载完成后再次调用该工具${actionName}。`);
  }
  if ((args.forum_name || args.url) && !isSameNormalizedPage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, `已打开贴吧首页，请等待页面加载完成后再次调用该工具${actionName}。`);
  }
  return null;
}

async function followForum(args = {}) {
  const navigation = await ensureForumPage(args, '关注贴吧');
  if (navigation) return navigation;
  if (hasLoginGate()) return loginRequiredResult('follow_forum');

  const before = forumActionState('follow');
  if (before.done) {
    return {
      changed: false,
      followed: true,
      evidence: before.evidence,
      message: '当前贴吧已经关注，未执行取消关注操作。',
      forum: getForumNameFromPage(),
      url: window.location.href,
    };
  }
  if (!args.confirm) {
    return {
      changed: false,
      followed: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行关注贴吧。',
      forum: getForumNameFromPage(),
      url: window.location.href,
    };
  }

  const control = findVisibleControl([/关注|加关注|like_forum|j_head_focus_btn|focus_btn/i]);
  if (!control) {
    return {
      changed: false,
      followed: false,
      error: '未找到关注贴吧按钮。',
      forum: getForumNameFromPage(),
      url: window.location.href,
    };
  }
  clickControl(control);
  await sleep(1800);
  const after = forumActionState('follow');
  if (hasLoginGate()) return loginRequiredResult('follow_forum');
  return {
    changed: after.done,
    followed: after.done,
    evidence: after.evidence,
    message: after.done ? '已执行关注贴吧。' : '已尝试关注贴吧，但未能确认是否成功。',
    forum: getForumNameFromPage(),
    url: window.location.href,
  };
}

async function signForum(args = {}) {
  const navigation = await ensureForumPage(args, '签到');
  if (navigation) return navigation;
  if (hasLoginGate()) return loginRequiredResult('sign_forum');

  const before = forumActionState('sign');
  if (before.done) {
    return {
      changed: false,
      signed: true,
      evidence: before.evidence,
      message: '当前贴吧今日已经签到，未重复执行签到。',
      forum: getForumNameFromPage(),
      url: window.location.href,
    };
  }
  if (!args.confirm) {
    return {
      changed: false,
      signed: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行签到。',
      forum: getForumNameFromPage(),
      url: window.location.href,
    };
  }

  const control = findExactActionControl('签到') || findVisibleControl([/签到|sign|j_sign|sign_btn/i]);
  if (!control) {
    return {
      changed: false,
      signed: false,
      error: '未找到签到按钮。',
      forum: getForumNameFromPage(),
      url: window.location.href,
    };
  }
  clickControl(control);
  await sleep(2000);
  const after = forumActionState('sign');
  if (hasLoginGate()) return loginRequiredResult('sign_forum');
  return {
    changed: after.done,
    signed: after.done,
    evidence: after.evidence,
    message: after.done ? '已执行签到。' : '已尝试签到，但未能确认是否成功。',
    forum: getForumNameFromPage(),
    url: window.location.href,
  };
}

// ─── Adapter Registration ───────────────────────────────────────────────────

window.__webmcpRegister({
  name: 'tieba-adapter',
  match: ['tieba.baidu.com'],
  tools: [
    {
      name: 'tieba.baidu.com.check_login_status',
      description: '检查当前百度贴吧浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、账号凭据或其他敏感信息。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => checkLoginStatus(),
    },
    {
      name: 'tieba.baidu.com.search_content',
      description: '按关键词搜索贴吧或帖子。搜索帖子时首次调用可能会跳转搜索结果页，页面加载后再次调用可读取结果；搜索贴吧时会打开对应贴吧首页。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或贴吧名称' },
          type: { type: 'string', enum: ['all', 'forum', 'thread'], description: '搜索类型：贴吧、帖子或全部' },
          limit: { type: 'number', description: '最多返回结果数量，1-10' },
        },
        required: ['query'],
      },
      handler: (args) => searchContent(args),
    },
    {
      name: 'tieba.baidu.com.open_thread_detail',
      description: '打开或读取贴吧帖子详情，返回标题、贴吧、楼主、正文和基础统计信息。首次调用可能会跳转详情页，页面加载后再次调用可读取内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '帖子 URL；为空时使用当前页' },
          thread_id: { type: 'string', description: '帖子 ID；为空时使用当前页' },
        },
      },
      handler: (args) => openThreadDetail(args),
    },
    {
      name: 'tieba.baidu.com.read_replies',
      description: '读取当前或指定贴吧帖子下的可见回复摘要。首次调用可能会跳转详情页，页面加载后再次调用可读取回复。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '帖子 URL；为空时使用当前页' },
          thread_id: { type: 'string', description: '帖子 ID；为空时使用当前页' },
          limit: { type: 'number', description: '最多返回回复数量，1-20' },
        },
      },
      handler: (args) => readReplies(args),
    },
    {
      name: 'tieba.baidu.com.follow_forum',
      description: '关注当前或指定贴吧；如果已经关注则返回已关注，不执行取消关注。必须显式传入 confirm=true 才会修改当前账号状态。',
      safety: 'write',
      requiresConfirmation: true,
      confirmationMessage: '即将使用当前百度贴吧登录账号关注目标贴吧。确认后只会执行关注，不会执行取消关注。',
      parameters: {
        type: 'object',
        properties: {
          forum_name: { type: 'string', description: '贴吧名称；为空时使用当前贴吧' },
          url: { type: 'string', description: '贴吧 URL；为空时使用当前贴吧' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行关注' },
        },
      },
      handler: (args) => followForum(args),
    },
    {
      name: 'tieba.baidu.com.sign_forum',
      description: '对当前或指定贴吧执行签到；如果今日已经签到则返回已签到，不重复签到。必须显式传入 confirm=true 才会修改当前账号状态。',
      safety: 'write',
      requiresConfirmation: true,
      confirmationMessage: '即将使用当前百度贴吧登录账号对目标贴吧签到。确认后只会执行签到，不会执行发帖或回复。',
      parameters: {
        type: 'object',
        properties: {
          forum_name: { type: 'string', description: '贴吧名称；为空时使用当前贴吧' },
          url: { type: 'string', description: '贴吧 URL；为空时使用当前贴吧' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行签到' },
        },
      },
      handler: (args) => signForum(args),
    },
  ],
});
