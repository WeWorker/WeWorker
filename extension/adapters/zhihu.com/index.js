/**
 * Zhihu Adapter Script
 *
 * Runs in the browser extension isolated world and uses only public DOM/page
 * state available to the current user session. It must not read, persist, or
 * return cookies, tokens, account credentials, or browser profile data.
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

function isZhihuPage() {
  return /(^|\.)zhihu\.com$/i.test(window.location.hostname);
}

function isQuestionPath(pathname = window.location.pathname) {
  return /^\/question\/\d+/i.test(pathname);
}

function isArticlePath(pathname = window.location.pathname) {
  return /^\/p\/\d+/i.test(pathname);
}

function currentContentType(pathname = window.location.pathname) {
  if (isQuestionPath(pathname)) return 'question';
  if (isArticlePath(pathname)) return 'article';
  return '';
}

function contentIdFromUrl(url = window.location.href) {
  try {
    const { pathname } = new URL(url, window.location.origin);
    const match = pathname.match(/^\/(?:question|p)\/(\d+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function normalizeContentUrl({ id = '', url = '', type = '' } = {}) {
  const rawUrl = String(url || '').trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl, window.location.origin).href;
    } catch {
      return rawUrl;
    }
  }
  const rawId = String(id || '').trim();
  if (!rawId) return window.location.href;
  const normalizedType = String(type || '').toLowerCase() === 'article' ? 'article' : 'question';
  return normalizedType === 'article'
    ? `https://www.zhihu.com/p/${rawId}`
    : `https://www.zhihu.com/question/${rawId}`;
}

function isSameContentPage(targetUrl) {
  try {
    const current = new URL(window.location.href);
    const target = new URL(targetUrl, window.location.origin);
    return current.origin === target.origin
      && current.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '');
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

function firstText(selectors, root = document) {
  for (const selector of selectors) {
    const el = root.querySelector?.(selector);
    const text = normalizedText(el?.innerText || el?.textContent || el?.getAttribute?.('title') || '');
    if (text) return text;
  }
  return '';
}

function hasLoginGate() {
  const loginInputs = Array.from(document.querySelectorAll([
    'input[name="username"]',
    'input[name="password"]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="验证码"]',
    '.SignFlow',
    '.Modal-wrapper .SignContainer',
  ].join(','))).some(isVisibleElement);
  const bodyText = normalizedText(document.body?.innerText || '');
  const visibleLoginButton = Array.from(document.querySelectorAll('button, a, span, div'))
    .some((el) => {
      if (!isVisibleElement(el)) return false;
      const text = normalizedText(el.innerText || el.textContent || '');
      return /^登录$|登录\/注册|注册\/登录|登录后/.test(text);
    });
  return Boolean(loginInputs) || visibleLoginButton || /登录后查看更多|登录后参与|请先登录/.test(bodyText);
}

function loginRequiredResult(action) {
  return {
    status: 'login_required',
    logged_in: false,
    action,
    message: '当前知乎页面要求登录后才能继续。请在 WeWorker 控制的浏览器中完成登录后，再重新调用该工具。',
    url: window.location.href,
  };
}

function actionControlSnapshot(control) {
  if (!control) return '';
  const descendants = Array.from(control.querySelectorAll?.('*') || []).slice(0, 30);
  return normalizedText([
    control.textContent || '',
    control.getAttribute?.('class') || '',
    control.getAttribute?.('aria-pressed') || '',
    control.getAttribute?.('aria-label') || '',
    control.getAttribute?.('title') || '',
    ...descendants.flatMap((el) => [
      el.textContent || '',
      el.getAttribute?.('class') || '',
      el.getAttribute?.('aria-pressed') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('fill') || '',
      el.getAttribute?.('style') || '',
    ]),
  ].join(' '));
}

function controlLooksActive(el) {
  if (!el) return false;
  const snapshot = actionControlSnapshot(el);
  return /(active|is-active|selected|true|已赞同|已点赞|已收藏|取消赞同|取消点赞|取消收藏)/i.test(snapshot);
}

function extractActionCount(snapshot) {
  const matches = Array.from(normalizedText(snapshot).matchAll(/(\d+(?:\.\d+)?)([万Kk])?/g));
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const value = Number(last[1]);
  if (!Number.isFinite(value)) return null;
  const unit = last[2] || '';
  if (unit === '万') return value * 10000;
  if (/k/i.test(unit)) return value * 1000;
  return value;
}

function findActionControl(kind) {
  const selectors = kind === 'like'
    ? [
      '.VoteButton--up',
      '.ContentItem-actions button',
      'button[aria-label*="赞"]',
      'button[title*="赞"]',
      'button',
      '[role="button"]',
    ]
    : [
      '.CollectionButton',
      '.ContentItem-actions button',
      'button[aria-label*="收藏"]',
      'button[title*="收藏"]',
      'button',
      '[role="button"]',
    ];

  const pattern = kind === 'like'
    ? /赞同|点赞|喜欢|upvote|like/i
    : /收藏|加入收藏|collect|favorite|star/i;

  for (const selector of selectors) {
    const hit = Array.from(document.querySelectorAll(selector)).find((el) => {
      if (!isVisibleElement(el)) return false;
      const combined = actionControlSnapshot(el);
      return pattern.test(combined);
    });
    if (hit) return hit;
  }

  return null;
}

function clickControl(control) {
  const target = control?.closest?.('button, a, [role="button"]') || control;
  target?.dispatchEvent?.(new MouseEvent('mouseover', { bubbles: true }));
  target?.dispatchEvent?.(new MouseEvent('mousedown', { bubbles: true }));
  target?.click?.();
  target?.dispatchEvent?.(new MouseEvent('mouseup', { bubbles: true }));
}

function visibleModalText() {
  const modal = Array.from(document.querySelectorAll('.Modal, .Modal-wrapper, [role="dialog"], .Popover, .CollectionModal'))
    .find(isVisibleElement);
  return normalizedText(modal?.innerText || modal?.textContent || '');
}

async function waitForActionState(kind, control, beforeSnapshot = '', timeout = 3500) {
  const deadline = Date.now() + timeout;
  const beforeCount = extractActionCount(beforeSnapshot);
  while (Date.now() < deadline) {
    const latest = findActionControl(kind) || control;
    const latestSnapshot = actionControlSnapshot(latest);
    const modalText = visibleModalText();
    if (hasLoginGate()) return { active: false, needs_login: true };
    if (kind === 'favorite' && /收藏夹|创建收藏夹|选择收藏夹|加入收藏夹/.test(modalText)) {
      return { active: false, needs_user_action: true, modal: 'collection_dialog' };
    }
    if (controlLooksActive(latest)) return { active: true, evidence: 'active_control' };
    const latestCount = extractActionCount(latestSnapshot);
    if (beforeCount !== null && latestCount !== null && latestCount > beforeCount) {
      return { active: true, evidence: 'count_increased' };
    }
    await sleep(250);
  }
  const latest = findActionControl(kind) || control;
  return { active: controlLooksActive(latest), evidence: controlLooksActive(latest) ? 'active_control' : '' };
}

// ─── Login ──────────────────────────────────────────────────────────────────

async function checkLoginStatus() {
  const headerRoots = Array.from(document.querySelectorAll([
    '.AppHeader',
    '.GlobalSideBar',
    '.TopstoryTabs',
    'header',
  ].join(',')));
  const scope = headerRoots.length ? headerRoots : [document];
  const findAll = (selector) => scope.flatMap((root) => Array.from(root.querySelectorAll(selector)));

  const avatar = findAll('.Avatar, img[class*="Avatar"], .AppHeader-profile img, button img')
    .find((el) => isVisibleElement(el) && /avatar|头像|profile/i.test(`${el.getAttribute?.('class') || ''} ${el.getAttribute?.('alt') || ''}`));
  const profileLink = findAll('a[href*="/people/"], a[href*="/org/"]')
    .find((link) => !/\/people\/?$|\/org\/?$/.test(link.getAttribute('href') || ''));
  const loginEntry = findAll('button, a, span, div')
    .find((el) => isVisibleElement(el) && /^登录$|登录\/注册|注册\/登录/.test(normalizedText(el.innerText || el.textContent || '')));
  const loginGate = hasLoginGate();

  return {
    logged_in: Boolean(avatar || profileLink) && !loginGate && !Boolean(loginEntry && !avatar),
    username: normalizedText(avatar?.getAttribute?.('alt') || profileLink?.textContent || ''),
    profile_url: absoluteUrl(profileLink?.getAttribute?.('href') || ''),
    signals: {
      has_avatar: Boolean(avatar),
      has_profile_link: Boolean(profileLink),
      has_login_entry: Boolean(loginEntry),
      has_login_gate: loginGate,
    },
    url: window.location.href,
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

function parseSearchResults(limit, requestedType = 'all') {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const results = [];
  const seen = new Set();
  const roots = Array.from(document.querySelectorAll([
    '.SearchResult-Card',
    '.SearchItem',
    '.List-item',
    '.ContentItem',
    'section',
    'article',
  ].join(',')));

  function addFromRoot(root) {
    if (results.length >= safeLimit) return;
    const link = root.querySelector?.('a[href*="/question/"], a[href*="/p/"]')
      || root.closest?.('a[href*="/question/"], a[href*="/p/"]');
    if (!link) return;
    const url = absoluteUrl(link.getAttribute('href') || '');
    if (!url || seen.has(url)) return;
    const type = /\/p\/\d+/i.test(url) ? 'article' : 'question';
    if (requestedType === 'question' && type !== 'question') return;
    if (requestedType === 'article' && type !== 'article') return;
    seen.add(url);

    const title = normalizedText(
      link.getAttribute('title')
      || root.querySelector?.('h2, h1, .ContentItem-title, .QuestionItem-title, .SearchItem-title')?.textContent
      || link.textContent
      || '',
    );
    const excerpt = normalizedText(root.querySelector?.('.RichContent-inner, .SearchItem-excerpt, .ContentItem-excerpt, .Highlight')?.textContent || root.textContent || '').slice(0, 400);
    const author = normalizedText(root.querySelector?.('.AuthorInfo-name, .UserLink, a[href*="/people/"]')?.textContent || '');
    const stats = normalizedText(root.querySelector?.('.ContentItem-actions, .SearchItem-footer, .List-itemMeta')?.textContent || '').slice(0, 240);

    if (!title && !excerpt) return;
    results.push({
      id: contentIdFromUrl(url),
      type,
      title,
      url,
      author,
      excerpt,
      stats,
    });
  }

  roots.forEach(addFromRoot);
  if (!results.length) {
    Array.from(document.querySelectorAll('a[href*="/question/"], a[href*="/p/"]')).forEach(addFromRoot);
  }
  return results;
}

async function searchContent({ query = '', type = 'all', limit = 5 } = {}) {
  const keyword = String(query || '').trim();
  if (!keyword) {
    return { error: 'Missing required parameter', message: 'query parameter is required' };
  }
  const normalizedType = ['question', 'article'].includes(String(type || '').toLowerCase())
    ? String(type).toLowerCase()
    : 'all';
  const targetUrl = `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`;
  const current = new URL(window.location.href);
  const currentQuery = current.searchParams.get('q') || '';
  if (!current.pathname.startsWith('/search') || currentQuery !== keyword) {
    return navigateAndAskRetry(targetUrl, `已打开知乎搜索页，请等待"${keyword}"搜索结果加载完成后再次调用该工具。`);
  }
  if (hasLoginGate()) return loginRequiredResult('search_content');

  await sleep(600);
  const results = parseSearchResults(limit, normalizedType);
  return {
    query: keyword,
    type: normalizedType,
    count: results.length,
    results,
    url: window.location.href,
  };
}

// ─── Detail and comments ────────────────────────────────────────────────────

function parseAnswer(root) {
  const author = normalizedText(root.querySelector?.('.AuthorInfo-name, .UserLink, meta[itemprop="name"]')?.textContent || '');
  const content = normalizedText(root.querySelector?.('.RichContent-inner, .RichText, .ContentItem-content')?.textContent || root.textContent || '').slice(0, 1000);
  const voteText = normalizedText(root.querySelector?.('.VoteButton--up, button[aria-label*="赞"]')?.textContent || '');
  const answerUrl = absoluteUrl(root.querySelector?.('a[href*="/answer/"]')?.getAttribute('href') || '');
  return { author, content, voteText, url: answerUrl };
}

function parseQuestionDetail() {
  const title = firstText(['h1.QuestionHeader-title', '.QuestionHeader-title', 'h1']);
  const description = firstText(['.QuestionRichText .RichText', '.QuestionRichText', '.QuestionHeader-detail', '.RichText']).slice(0, 1200);
  const answerRoots = Array.from(document.querySelectorAll('.AnswerItem, .List-item, .ContentItem'))
    .filter((root) => normalizedText(root.querySelector?.('.RichContent-inner, .RichText, .ContentItem-content')?.textContent || '').length > 20);
  const answers = answerRoots.map(parseAnswer).filter((item) => item.content).slice(0, 5);
  const stats = firstText(['.QuestionHeader-side', '.QuestionHeader-actions', '.NumberBoard', '.List-headerText']);
  return {
    type: 'question',
    id: contentIdFromUrl(),
    title,
    description,
    stats,
    answer_count: answers.length,
    answers,
    url: window.location.href,
  };
}

function parseArticleDetail() {
  const title = firstText(['h1.Post-Title', '.Post-Title', 'h1']);
  const author = firstText(['.AuthorInfo-name', '.Post-Author .UserLink', 'a[href*="/people/"]']);
  const content = firstText(['.Post-RichText', '.RichText', 'article']).slice(0, 3000);
  const stats = firstText(['.ContentItem-actions', '.Post-Sub', '.Post-NormalSub']);
  return {
    type: 'article',
    id: contentIdFromUrl(),
    title,
    author,
    content,
    stats,
    url: window.location.href,
  };
}

async function openContent({ url = '', id = '', type = '' } = {}) {
  const targetUrl = normalizeContentUrl({ id, url, type });
  if (!isQuestionPath() && !isArticlePath()) {
    return navigateAndAskRetry(targetUrl, '已打开知乎详情页，请等待页面加载完成后再次调用该工具读取详情。');
  }
  if ((id || url) && !isSameContentPage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开知乎详情页，请等待页面加载完成后再次调用该工具读取详情。');
  }
  if (hasLoginGate()) return loginRequiredResult('open_content');

  await sleep(600);
  if (currentContentType() === 'article') return parseArticleDetail();
  return parseQuestionDetail();
}

function collectVisibleComments(limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  const roots = Array.from(document.querySelectorAll([
    '.CommentItem',
    '.CommentItemV2',
    '.NestComment',
    '.Comments-container .List-item',
    '.AnswerItem',
  ].join(',')));
  let comments = roots.map((root) => {
    const author = normalizedText(root.querySelector?.('.CommentItemV2-meta a, .CommentItem-meta a, .UserLink, .AuthorInfo-name')?.textContent || '');
    const content = normalizedText(root.querySelector?.('.CommentItemV2-content, .CommentItem-content, .RichContent-inner, .RichText')?.textContent || root.textContent || '').slice(0, 800);
    const time = normalizedText(root.querySelector?.('time, .CommentItemV2-time, .CommentItem-time')?.textContent || root.querySelector?.('time')?.getAttribute?.('datetime') || '');
    const like = normalizedText(root.querySelector?.('.CommentItemV2-likeBtn, .CommentItem-likeBtn, button[aria-label*="赞"]')?.textContent || '');
    return { author, content, time, like };
  }).filter((item) => item.content).slice(0, safeLimit);

  if (comments.length) return comments;
  comments = collectModernArticleComments(safeLimit);
  if (comments.length) return comments;
  return collectTextSectionComments(safeLimit);
}

function collectModernArticleComments(limit) {
  const pageTitle = normalizedText(document.querySelector('h1')?.textContent || '');
  const panels = Array.from(document.querySelectorAll('div')).filter((el) => {
    if (!isVisibleElement(el)) return false;
    const text = normalizedText(el.textContent || '');
    return /\d+\s*条评论/.test(text)
      && /(默认|最新)/.test(text)
      && (!pageTitle || !text.includes(pageTitle));
  });
  const panel = panels.sort((a, b) => normalizedText(a.textContent || '').length - normalizedText(b.textContent || '').length)[0];
  if (!panel) return [];

  const authorLinks = Array.from(panel.querySelectorAll('a')).filter((link) => {
    if (!isVisibleElement(link)) return false;
    const text = normalizedText(link.textContent || '');
    const href = link.getAttribute('href') || '';
    if (!text || text.length > 40) return false;
    if (/^(展开|收起|查看|回复|赞|踩|更多|举报)$/.test(text)) return false;
    return /\/people\/|\/org\//.test(href) || /css-10u695f|UserLink/.test(String(link.className || ''));
  });

  const seen = new Set();
  const comments = [];
  for (const authorLink of authorLinks) {
    if (comments.length >= limit) break;
    const author = normalizedText(authorLink.textContent || '');
    let cursor = authorLink.parentElement;
    const candidates = [];
    while (cursor && cursor !== panel) {
      const text = normalizedText(cursor.textContent || '');
      if (text.length >= author.length + 8 && text.length <= 1200) {
        candidates.push({ root: cursor, text });
      }
      cursor = cursor.parentElement;
    }
    const root = candidates.find((candidate) => /回复|赞|发布于|编辑于|IP属地/.test(candidate.text))?.root
      || candidates[candidates.length - 1]?.root
      || authorLink.parentElement;

    const rawText = normalizedText(root?.textContent || '');
    if (!rawText || rawText.length <= author.length) continue;
    const content = rawText
      .replace(author, '')
      .replace(/^[:：\s]+/, '')
      .replace(/展开其他\s*\d+\s*条回复.*/u, '')
      .replace(/回复\s*$/u, '')
      .trim()
      .slice(0, 800);
    const key = `${author}:${content.slice(0, 80)}`;
    if (!content || seen.has(key)) continue;
    seen.add(key);

    const time = (rawText.match(/(\d{4}-\d{2}-\d{2}|今天|昨天|\d+\s*(?:分钟|小时|天)前|IP属地[^\s]+)/u) || [])[0] || '';
    const like = (rawText.match(/(\d+\s*赞|赞\s*\d+)/u) || [])[0] || '';
    comments.push({ author, content, time, like });
  }

  return comments;
}

function collectTextSectionComments(limit) {
  const text = document.body?.innerText || '';
  const headers = Array.from(text.matchAll(/\d+\s*条评论/gu))
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0)
    .filter((index) => {
      const head = text.slice(index, index + 300);
      return head.includes('默认') && head.includes('最新');
    });
  let sectionStart = headers[headers.length - 1] ?? -1;
  if (sectionStart < 0) {
    const defaultIndex = text.lastIndexOf('默认');
    const latestIndex = defaultIndex >= 0 ? text.indexOf('最新', defaultIndex) : -1;
    if (latestIndex >= 0 && latestIndex - defaultIndex < 200) sectionStart = latestIndex + '最新'.length;
  }
  if (sectionStart < 0) return [];
  const sectionText = text.slice(sectionStart, sectionStart + 6000)
    .replace(/^[\s\S]*?默认[\s\S]*?最新/u, '');

  const stopPattern = /^(写下你的评论|相关推荐|发布评论|登录后|选择语言|热门搜索|©|知乎指南|申请转载)$/u;
  const noisePattern = /^(默认|最新|赞|回复|分享|收藏|举报|展开|收起|发布评论|添加评论|写下你的评论|喜欢|​|\d+)$/u;
  const metaPattern = /^(发布于|编辑于|IP属地|\d+\s*(?:分钟|小时|天)前|昨天|今天|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})/u;
  const lines = sectionText
    .split(/\n+/)
    .map((line) => normalizedText(line))
    .filter(Boolean);

  const comments = [];
  for (let i = 0; i < lines.length && comments.length < limit; i += 1) {
    const author = lines[i];
    if (!author || author.length > 40 || noisePattern.test(author) || stopPattern.test(author) || metaPattern.test(author)) continue;

    const contentParts = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (stopPattern.test(line)) break;
      if (metaPattern.test(line)) break;
      if (/^(赞|回复|展开其他|收起|举报)$/u.test(line)) break;
      if (line.length <= 40 && j > i + 1 && !/[，。！？,.!?]/u.test(line)) break;
      if (!noisePattern.test(line)) contentParts.push(line);
      if (contentParts.join(' ').length > 30) {
        const next = lines[j + 1] || '';
        if (metaPattern.test(next) || /^(赞|回复)/u.test(next)) break;
      }
    }

    const content = normalizedText(contentParts.join(' ')).slice(0, 800);
    if (!content || content.length < 4 || noisePattern.test(content) || metaPattern.test(content)) continue;
    comments.push({ author, content, time: '', like: '', source: 'text_section' });
    i += Math.max(1, contentParts.length);
  }
  return comments;
}

function openCommentsIfNeeded() {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
  const commentButton = buttons.find((el) => {
    if (!isVisibleElement(el)) return false;
    const text = normalizedText(el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
    return /评论|查看评论|条评论/.test(text);
  });
  if (commentButton) {
    clickControl(commentButton);
    return true;
  }
  return false;
}

async function readComments({ url = '', id = '', type = '', limit = 10 } = {}) {
  const targetUrl = normalizeContentUrl({ id, url, type });
  if (!isQuestionPath() && !isArticlePath()) {
    return navigateAndAskRetry(targetUrl, '已打开知乎详情页，请等待页面加载完成后再次调用该工具读取回答或评论。');
  }
  if ((id || url) && !isSameContentPage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开知乎详情页，请等待页面加载完成后再次调用该工具读取回答或评论。');
  }
  if (hasLoginGate()) return loginRequiredResult('read_comments');

  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  let comments = collectVisibleComments(safeLimit);
  let opened = false;
  if (!comments.length) {
    opened = openCommentsIfNeeded();
    await sleep(1200);
    comments = collectVisibleComments(safeLimit);
  }
  if (!comments.length) {
    const target = document.querySelector('.Comments-container, .QuestionAnswers-answers, .List, .AnswerItem, article');
    if (target?.scrollIntoView) target.scrollIntoView({ block: 'center' });
    else window.scrollTo({ top: Math.max(0, document.body.scrollHeight * 0.55), behavior: 'auto' });
    await sleep(1500);
    comments = collectVisibleComments(safeLimit);
  }

  return {
    type: currentContentType(),
    id: contentIdFromUrl(),
    count: comments.length,
    comments,
    opened_comments_panel: opened,
    message: comments.length ? '已读取当前页面可见回答或评论。' : '当前页面未读取到回答或评论；可能内容尚未加载、评论关闭或页面结构已变化。',
    url: window.location.href,
  };
}

// ─── High-impact actions ────────────────────────────────────────────────────

async function ensureActionPage(args, actionName) {
  const { id = '', url = '', type = '' } = args || {};
  const targetUrl = normalizeContentUrl({ id, url, type });
  if (!isQuestionPath() && !isArticlePath()) {
    return navigateAndAskRetry(targetUrl, `已打开知乎详情页，请等待页面加载完成后再次调用该工具${actionName}。`);
  }
  if ((id || url) && !isSameContentPage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, `已打开知乎详情页，请等待页面加载完成后再次调用该工具${actionName}。`);
  }
  return null;
}

async function likeContent(args = {}) {
  const navigation = await ensureActionPage(args, '点赞或赞同');
  if (navigation) return navigation;
  if (hasLoginGate()) return loginRequiredResult('like_content');

  const control = findActionControl('like');
  if (controlLooksActive(control)) {
    return { changed: false, liked: true, message: '当前内容已经点赞或赞同，未执行取消操作。', url: window.location.href };
  }
  if (!args.confirm) {
    return {
      changed: false,
      liked: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行点赞或赞同。',
      url: window.location.href,
    };
  }
  if (!control) {
    return { changed: false, liked: false, error: '未找到点赞或赞同按钮。', url: window.location.href };
  }

  const beforeSnapshot = actionControlSnapshot(control);
  clickControl(control);
  const state = await waitForActionState('like', control, beforeSnapshot);
  if (state.needs_login) return loginRequiredResult('like_content');
  const liked = Boolean(state.active);
  return {
    changed: liked,
    liked,
    evidence: state.evidence || (liked ? 'active_control' : ''),
    message: liked ? '已执行点赞或赞同。' : '已尝试点赞或赞同，但未能确认是否成功。',
    url: window.location.href,
  };
}

async function favoriteContent(args = {}) {
  const navigation = await ensureActionPage(args, '收藏');
  if (navigation) return navigation;
  if (hasLoginGate()) return loginRequiredResult('favorite_content');

  const control = findActionControl('favorite');
  if (controlLooksActive(control)) {
    return { changed: false, favorited: true, message: '当前内容已经收藏，未执行取消收藏操作。', url: window.location.href };
  }
  if (!args.confirm) {
    return {
      changed: false,
      favorited: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行收藏。',
      url: window.location.href,
    };
  }
  if (!control) {
    return { changed: false, favorited: false, error: '未找到收藏按钮。', url: window.location.href };
  }

  const beforeSnapshot = actionControlSnapshot(control);
  clickControl(control);
  const state = await waitForActionState('favorite', control, beforeSnapshot);
  if (state.needs_login) return loginRequiredResult('favorite_content');
  if (state.needs_user_action) {
    return {
      changed: false,
      favorited: false,
      needs_user_action: true,
      reason: state.modal,
      message: '页面弹出了收藏夹或确认弹层，需要用户手动选择后才能确认收藏结果。',
      url: window.location.href,
    };
  }
  const favorited = Boolean(state.active);
  return {
    changed: favorited,
    favorited,
    evidence: state.evidence || (favorited ? 'active_control' : ''),
    message: favorited ? '已执行收藏。' : '已尝试收藏，但未能确认是否成功。',
    url: window.location.href,
  };
}

// ─── Adapter Registration ───────────────────────────────────────────────────

window.__webmcpRegister({
  name: 'zhihu-adapter',
  match: ['zhihu.com'],
  tools: [
    {
      name: 'zhihu.com.check_login_status',
      description: '检查当前知乎浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、账号凭据或其他敏感信息。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => checkLoginStatus(),
    },
    {
      name: 'zhihu.com.search_content',
      description: '按关键词搜索知乎问题和文章。首次调用可能会跳转搜索结果页，页面加载后再次调用可读取结果。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          type: { type: 'string', enum: ['all', 'question', 'article'], description: '搜索类型' },
          limit: { type: 'number', description: '最多返回结果数量，1-10' },
        },
        required: ['query'],
      },
      handler: (args) => searchContent(args),
    },
    {
      name: 'zhihu.com.open_content',
      description: '打开或读取知乎问题/文章详情，返回标题、正文、回答摘要或文章内容。首次调用可能会跳转详情页，页面加载后再次调用可读取内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '问题或文章 URL' },
          id: { type: 'string', description: '问题或文章 ID' },
          type: { type: 'string', enum: ['question', 'article'], description: '内容类型' },
        },
      },
      handler: (args) => openContent(args),
    },
    {
      name: 'zhihu.com.read_comments',
      description: '读取当前或指定知乎问题、文章或回答下的可见回答/评论摘要。首次调用可能会跳转详情页，页面加载后再次调用可读取内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '问题或文章 URL；为空时使用当前页' },
          id: { type: 'string', description: '问题或文章 ID；为空时使用当前页' },
          type: { type: 'string', enum: ['question', 'article'], description: '内容类型' },
          limit: { type: 'number', description: '最多返回评论数量，1-20' },
        },
      },
      handler: (args) => readComments(args),
    },
    {
      name: 'zhihu.com.like_content',
      description: '对当前或指定知乎内容执行点赞/赞同；如果已经点赞或赞同则返回已完成，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '问题或文章 URL；为空时使用当前页' },
          id: { type: 'string', description: '问题或文章 ID；为空时使用当前页' },
          type: { type: 'string', enum: ['question', 'article'], description: '内容类型' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行点赞或赞同' },
        },
      },
      handler: (args) => likeContent(args),
    },
    {
      name: 'zhihu.com.favorite_content',
      description: '对当前或指定知乎内容执行收藏；如果已经收藏则返回已收藏，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '问题或文章 URL；为空时使用当前页' },
          id: { type: 'string', description: '问题或文章 ID；为空时使用当前页' },
          type: { type: 'string', enum: ['question', 'article'], description: '内容类型' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行收藏' },
        },
      },
      handler: (args) => favoriteContent(args),
    },
  ],
});
