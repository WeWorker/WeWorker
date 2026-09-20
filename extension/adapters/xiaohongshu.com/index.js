/**
 * Xiaohongshu (小红书) Adapter Script
 *
 * NOTE: Runs in isolated world — can only access DOM, not page JS variables.
 *
 * Verified: xiaohongshu.com, March 2026
 * Maintainer: WeWorker project
 */

// ─── Utilities ───────────────────────────────────────────────────────────────

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for element: ${selector}`));
    }, timeout);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function isVisibleElement(el) {
  return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects?.().length));
}

function isXiaohongshuPage() {
  return /(^|\.)xiaohongshu\.com$/i.test(window.location.hostname);
}

function isNotePath(pathname = window.location.pathname) {
  return /^\/(?:explore|search_result)\/[0-9a-f]+/i.test(pathname);
}

function normalizeNoteUrl({ id = '', url = '' } = {}) {
  const rawUrl = String(url || '').trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      return parsed.href;
    } catch {
      return rawUrl;
    }
  }
  const noteId = String(id || '').trim();
  return noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : window.location.href;
}

function noteIdFromUrl(url = window.location.href) {
  try {
    const { pathname } = new URL(url, window.location.origin);
    const match = pathname.match(/\/(?:explore|search_result)\/([0-9a-f]+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function isSameNotePage(targetUrl) {
  try {
    const current = new URL(window.location.href);
    const target = new URL(targetUrl, window.location.origin);
    return current.origin === target.origin
      && current.pathname.replace(/^\/search_result\//, '/explore/').replace(/\/$/, '')
        === target.pathname.replace(/^\/search_result\//, '/explore/').replace(/\/$/, '');
  } catch {
    return false;
  }
}

function hasLoginGate() {
  const loginForm = Array.from(document.querySelectorAll([
    'input[name="xhs-pc-web-phone"]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="验证码"]',
    '#login-btn',
  ].join(','))).find(isVisibleElement);
  const bodyText = normalizedText(document.body?.innerText || '');
  const visibleLoginButton = Array.from(document.querySelectorAll('button, a, span, div'))
    .some((el) => {
      const text = normalizedText(el.innerText || el.textContent || '');
      return isVisibleElement(el) && (/^登录$|登录\/注册$/.test(text) || text === '登录探索更多内容');
    });
  return Boolean(loginForm) || visibleLoginButton || /登录探索更多内容|登录后查看更多|登录后才能/.test(bodyText);
}

function loginRequiredResult(action) {
  return {
    status: 'login_required',
    logged_in: false,
    action,
    message: '当前小红书页面要求登录后才能继续。请在 WeWorker 控制的浏览器中完成登录后，再重新调用该工具。',
    url: window.location.href,
  };
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

function controlLooksActive(el) {
  if (!el) return false;
  const descendants = Array.from(el.querySelectorAll?.('*') || []).slice(0, 30);
  const combined = [
    el.getAttribute?.('class') || '',
    el.getAttribute?.('aria-pressed') || '',
    el.getAttribute?.('aria-checked') || '',
    el.getAttribute?.('data-active') || '',
    el.getAttribute?.('title') || '',
    el.getAttribute?.('aria-label') || '',
    el.textContent || '',
    ...descendants.flatMap((child) => [
      child.getAttribute?.('class') || '',
      child.getAttribute?.('aria-pressed') || '',
      child.getAttribute?.('aria-checked') || '',
      child.getAttribute?.('data-active') || '',
      child.getAttribute?.('fill') || '',
      child.getAttribute?.('stroke') || '',
      child.getAttribute?.('style') || '',
    ]),
  ].join(' ');
  if (/(active|selected|true|已|取消|liked|collected|收藏成功|已收藏|followed)/i.test(combined)) {
    return true;
  }

  const styleValues = [el, ...descendants]
    .map((node) => {
      try {
        const style = window.getComputedStyle(node);
        return `${style.color} ${style.fill} ${style.stroke}`;
      } catch {
        return '';
      }
    })
    .join(' ');
  return /(255,\s*36,\s*66|#ff2442|rgb\(255,\s*36,\s*66\))/i.test(styleValues);
}

function pageActionFeedback(kind) {
  const bodyText = normalizedText(document.body?.innerText || '');
  if (kind === 'like' && /点赞成功|已点赞|取消点赞/.test(bodyText)) return 'like_feedback';
  if (kind === 'favorite' && /收藏成功|已收藏|取消收藏|已添加到收藏/.test(bodyText)) return 'favorite_feedback';
  return '';
}

function actionControlSnapshot(control) {
  if (!control) return '';
  return normalizedText([
    control.textContent || '',
    control.getAttribute?.('class') || '',
    control.getAttribute?.('aria-pressed') || '',
    control.getAttribute?.('aria-checked') || '',
    control.getAttribute?.('data-active') || '',
    ...Array.from(control.querySelectorAll?.('*') || []).slice(0, 30).map((el) => [
      el.textContent || '',
      el.getAttribute?.('class') || '',
      el.getAttribute?.('aria-pressed') || '',
      el.getAttribute?.('aria-checked') || '',
      el.getAttribute?.('data-active') || '',
      el.getAttribute?.('fill') || '',
      el.getAttribute?.('stroke') || '',
      el.getAttribute?.('style') || '',
    ].join(' ')),
  ].join(' '));
}

function extractActionCount(snapshot) {
  const matches = Array.from(normalizedText(snapshot).matchAll(/(\d+(?:\.\d+)?)(万)?/g));
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  const value = Number(last[1]);
  if (!Number.isFinite(value)) return null;
  return last[2] ? value * 10000 : value;
}

async function waitForActionState(kind, control, beforeSnapshot = '', timeout = 3000) {
  const deadline = Date.now() + timeout;
  const beforeCount = extractActionCount(beforeSnapshot);
  while (Date.now() < deadline) {
    const latest = findActionControl(kind) || control;
    const latestSnapshot = actionControlSnapshot(latest);
    if (controlLooksActive(latest)) return { active: true, feedback: pageActionFeedback(kind) };
    const feedback = pageActionFeedback(kind);
    if (feedback) return { active: true, feedback };
    const latestCount = extractActionCount(latestSnapshot);
    if (beforeCount !== null && latestCount !== null && latestCount > beforeCount) {
      return { active: true, feedback: 'count_increased' };
    }
    await sleep(250);
  }
  const latest = findActionControl(kind) || control;
  const latestSnapshot = actionControlSnapshot(latest);
  const latestCount = extractActionCount(latestSnapshot);
  return {
    active: controlLooksActive(latest) || (beforeCount !== null && latestCount !== null && latestCount > beforeCount),
    feedback: pageActionFeedback(kind),
  };
}

function findDetailActionBarControl(kind) {
  const commentInput = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], div, span'))
    .find((el) => {
      const text = normalizedText(el.getAttribute?.('placeholder') || el.innerText || el.textContent || '');
      return isVisibleElement(el) && /说点什么/.test(text);
    });
  const inputRect = commentInput?.getBoundingClientRect?.();
  if (!inputRect || inputRect.width <= 0 || inputRect.height <= 0) return null;

  const centerY = inputRect.top + inputRect.height / 2;
  const candidates = Array.from(document.querySelectorAll('button, a, div, span, svg'))
    .map((el) => ({ el, rect: el.getBoundingClientRect?.() }))
    .filter(({ el, rect }) => {
      if (!rect || !isVisibleElement(el)) return false;
      if (rect.width < 8 || rect.height < 8 || rect.width > 160 || rect.height > 80) return false;
      if (rect.left <= inputRect.right - 4) return false;
      return Math.abs((rect.top + rect.height / 2) - centerY) <= 36;
    })
    .sort((a, b) => a.rect.left - b.rect.left);

  const groups = [];
  for (const candidate of candidates) {
    const previous = groups[groups.length - 1];
    if (previous && candidate.rect.left - previous.right <= 56) {
      previous.items.push(candidate);
      previous.right = Math.max(previous.right, candidate.rect.right);
      previous.left = Math.min(previous.left, candidate.rect.left);
    } else {
      groups.push({
        left: candidate.rect.left,
        right: candidate.rect.right,
        items: [candidate],
      });
    }
  }

  const index = kind === 'like' ? 0 : 1;
  const group = groups[index];
  if (!group) return null;
  const groupElements = group.items.map(({ el }) => el).filter(Boolean);
  let commonParent = groupElements[0] || null;
  while (commonParent && groupElements.some((el) => !commonParent.contains(el))) {
    commonParent = commonParent.parentElement;
  }
  if (commonParent && commonParent !== document.body) {
    const rect = commonParent.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.width <= 180 && rect.height > 0 && rect.height <= 90) {
      return commonParent;
    }
  }

  const preferred = group.items.find(({ el }) => ['BUTTON', 'A', 'SVG'].includes(el.tagName))
    || group.items.find(({ el }) => !/^\d+$/.test(normalizedText(el.innerText || el.textContent || '')))
    || group.items[0];
  let el = preferred?.el || null;
  for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
    const rect = cur.getBoundingClientRect?.();
    if (!rect || rect.width > 180 || rect.height > 90) continue;
    const className = String(cur.className || '');
    const role = cur.getAttribute?.('role') || '';
    if (['BUTTON', 'A'].includes(cur.tagName)
      || role === 'button'
      || /like|collect|star|favorite|action|interact|engage|wrapper|icon/i.test(className)) {
      el = cur;
    }
  }
  return el;
}

function findActionControl(kind) {
  const selectors = kind === 'like'
    ? [
      '.interact-container .like-wrapper',
      '.interaction-container .like-wrapper',
      '.note-detail .like-wrapper',
      '[class*="like-wrapper"]',
      '[class*="like"]',
    ]
    : [
      '.interact-container .collect-wrapper',
      '.interaction-container .collect-wrapper',
      '.note-detail .collect-wrapper',
      '[class*="collect-wrapper"]',
      '[class*="collect"]',
      '[class*="star"]',
      '[class*="collection"]',
      '[class*="favorite"]',
    ];
  for (const selector of selectors) {
    const controls = Array.from(document.querySelectorAll(selector));
    const hit = controls.find((el) => {
      const text = normalizedText(el.innerText || el.textContent || '');
      const title = normalizedText(el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '');
      const className = String(el.className || '');
      const combined = `${text} ${title} ${className}`;
      return kind === 'like'
        ? /赞|like/i.test(combined)
        : /收藏|collect|favorite/i.test(combined);
    }) || controls[0];
    if (hit) return hit;
  }
  return findDetailActionBarControl(kind);
}

function clickControl(control) {
  if (!control) return false;
  const rect = control.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    control.click?.();
    return true;
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const target = document.elementFromPoint(x, y) || control;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventCtor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new EventCtor(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type.endsWith('down') ? 1 : 0,
      pointerType: 'mouse',
    }));
  }
  return true;
}

// ─── DOM Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse note cards from the search results page.
 *
 * DOM structure:
 * - Container: .feeds-container
 * - Each card: section.note-item[data-index]
 * - Note ID: a.cover[href] → /explore/{id} or /search_result/{id}
 * - Cover image: a.cover img[src]
 * - Title: .footer a.title span
 * - Author name: .card-bottom-wrapper .author .name
 * - Author profile: .card-bottom-wrapper .author[href]
 * - Post date: .card-bottom-wrapper .author .time
 * - Likes: .like-wrapper .count
 */
function parseNoteCards() {
  const notes = [];
  const cards = document.querySelectorAll('section.note-item');

  for (const card of cards) {
    try {
      // 帖子链接和 ID：优先取 a.cover 的 href
      const coverLink = card.querySelector('a.cover');
      const rawHref = coverLink?.getAttribute('href') || '';
      // href 格式：/explore/{id} 或 /search_result/{id}?...
      const idMatch = rawHref.match(/\/(?:explore|search_result)\/([a-f0-9]+)/);
      const noteId = idMatch?.[1] || '';
      const noteUrl = absoluteUrl(rawHref) || (noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : '');

      // 封面图
      const imgEl = card.querySelector('a.cover img');
      const image = imgEl?.getAttribute('src') || '';

      // 标题
      const titleEl = card.querySelector('.footer a.title span');
      const title = titleEl?.textContent?.trim() || '';

      // 作者信息
      const authorEl = card.querySelector('.card-bottom-wrapper .author');
      const authorName = authorEl?.querySelector('.name')?.textContent?.trim() || '';
      const authorHref = authorEl?.getAttribute('href') || '';
      const authorUrl = authorHref ? `https://www.xiaohongshu.com${authorHref.startsWith('/') ? authorHref : '/' + authorHref}` : '';

      // 发布时间
      const timeEl = card.querySelector('.card-bottom-wrapper .author .time');
      const postTime = timeEl?.textContent?.trim() || '';

      // 点赞数
      const likesEl = card.querySelector('.like-wrapper .count');
      const likes = likesEl?.textContent?.trim() || '0';

      if (title || noteId) {
        notes.push({ noteId, title, image, authorName, authorUrl, postTime, likes, url: noteUrl });
      }
    } catch (err) {
      console.error('Failed to parse note card:', err);
    }
  }

  return notes;
}

/**
 * Parse note detail from the current explore page.
 *
 * DOM structure:
 * - Title: #detail-title
 * - Body text: #detail-desc .note-text (plain text spans + hashtag links)
 * - Post date: .bottom-container .date
 * - Images (图文): .note-slider .swiper-slide:not(.swiper-slide-duplicate)[data-swiper-slide-index] img[src]
 * - Video (视频): .xgplayer video[src] (blob URL, not useful)
 *   - Cover: xg-poster[style] → background-image url
 *   - Duration: xg-time span:last-child
 * - Total comments: .comments-container .total
 * - Each top-level comment: .parent-comment .comment-item (not .comment-item-sub)
 *   - Comment ID: [id^="comment-"]
 *   - Author name: .author .name
 *   - Content: .content .note-text span (first plain span)
 *   - Date: .info .date span:first-child
 *   - Location: .info .date .location
 *   - Likes: .interactions .like .count
 *   - Reply count: .interactions .reply .count
 */
function parseNoteDetail() {
  const title = document.querySelector('#detail-title')?.textContent?.trim() || '';

  // 正文：拼接所有文本节点和 hashtag 链接文本
  const descEl = document.querySelector('#detail-desc .note-text');
  let body = '';
  if (descEl) {
    body = Array.from(descEl.childNodes)
      .map(node => node.textContent?.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  // 检测是否为视频帖子
  const playerEl = document.querySelector('.xgplayer');
  let noteType = 'image';
  let video = null;

  if (playerEl) {
    noteType = 'video';
    // 封面图：从 xg-poster 的 background-image style 中提取 URL
    const posterEl = playerEl.querySelector('xg-poster');
    const posterStyle = posterEl?.getAttribute('style') || '';
    const coverMatch = posterStyle.match(/url\(["']?([^"')]+)["']?\)/);
    const cover = coverMatch?.[1] || '';
    // 时长：xg-time 的最后一个 span（格式 "00:09"）
    const durationEl = playerEl.querySelector('xg-time span:last-child');
    const duration = durationEl?.textContent?.trim() || '';
    video = { cover, duration };
  }

  // 图片列表（视频帖子无图片）：排除 swiper 的 duplicate slide，按 data-swiper-slide-index 排序去重
  const imageMap = new Map();
  const slideEls = document.querySelectorAll('.note-slider .swiper-slide:not(.swiper-slide-duplicate)');
  for (const slide of slideEls) {
    const idx = parseInt(slide.getAttribute('data-swiper-slide-index') ?? '-1', 10);
    if (idx < 0) continue;
    const src = slide.querySelector('img[src]')?.getAttribute('src') || '';
    if (src && !imageMap.has(idx)) {
      imageMap.set(idx, src);
    }
  }
  const images = Array.from(imageMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, src]) => src);

  // 发布时间
  const dateEl = document.querySelector('.bottom-container .date');
  const postDate = dateEl?.textContent?.trim() || '';

  // 评论总数
  const totalEl = document.querySelector('.comments-container .total');
  const totalComments = totalEl?.textContent?.trim() || '';

  // 解析顶层评论（排除子评论）
  const comments = [];
  const commentEls = document.querySelectorAll('.parent-comment .comment-item:not(.comment-item-sub)');
  for (const el of commentEls) {
    const commentId = el.id?.replace('comment-', '') || '';
    const authorName = el.querySelector('.author .name')?.textContent?.trim() || '';
    // 评论正文：取第一个纯文本 span（跳过 emoji img）
    const contentSpans = el.querySelectorAll('.content .note-text span');
    const content = Array.from(contentSpans).map(s => s.textContent?.trim()).filter(Boolean).join('') || '';
    const dateSpans = el.querySelectorAll('.info .date span');
    const commentDate = dateSpans[0]?.textContent?.trim() || '';
    const location = el.querySelector('.info .date .location')?.textContent?.trim() || '';
    const likes = el.querySelector('.interactions .like .count')?.textContent?.trim() || '0';
    const replyCount = el.querySelector('.interactions .reply .count')?.textContent?.trim() || '0';

    if (content || authorName) {
      comments.push({ commentId, authorName, content, date: commentDate, location, likes, replyCount });
    }
  }

  return { title, body, noteType, video, images, postDate, totalComments, comments };
}

// ─── Tool Handler Functions ──────────────────────────────────────────────────

async function checkLoginStatus() {
  const headerRoots = Array.from(document.querySelectorAll([
    'header',
    '.reds-sticky',
    '.header',
    '.nav',
    '.navbar',
    '.login-container',
    '.user',
    '.user-side',
  ].join(',')));
  const scope = headerRoots.length ? headerRoots : [document];
  const findAll = (selector) => scope.flatMap((root) => Array.from(root.querySelectorAll(selector)));

  const loginForm = Array.from(document.querySelectorAll('input[name="xhs-pc-web-phone"], input[placeholder*="手机号"], input[placeholder*="验证码"], #login-btn'))
    .find(isVisibleElement);
  const loginEntry = findAll('button, a, span, div')
    .find((el) => /^登录$|登录\/注册|登录后|登陆/.test(normalizedText(el.innerText || el.textContent || '')));
  const avatar = findAll('img[class*="avatar"], [class*="avatar"] img, .avatar img, .user-avatar img')
    .find((el) => {
      const text = normalizedText(el.getAttribute?.('alt') || el.getAttribute?.('title') || el.textContent || '');
      const className = String(el.className || '');
      return /avatar|头像|user/i.test(`${text} ${className}`);
    });
  const profileLink = findAll('a[href*="/user/profile/"], a[href*="/user/profile"]')
    .find((link) => !/\/user\/profile\/?$/.test(link.getAttribute('href') || ''));

  return {
    logged_in: Boolean(avatar || profileLink) && !hasLoginGate() && !Boolean(loginForm || (loginEntry && !avatar)),
    username: normalizedText(avatar?.getAttribute?.('alt') || profileLink?.textContent || ''),
    profile_url: absoluteUrl(profileLink?.getAttribute?.('href') || ''),
    signals: {
      has_avatar: Boolean(avatar),
      has_profile_link: Boolean(profileLink),
      has_login_entry: Boolean(loginEntry),
      has_login_form: Boolean(loginForm),
    },
    url: window.location.href,
  };
}

/**
 * Navigate to the Xiaohongshu homepage.
 */
async function navigateToHomepage() {
  try {
    const currentUrl = window.location.href;

    setTimeout(() => {
      window.location.href = 'https://www.xiaohongshu.com/';
    }, 100);

    return {
      status: 'navigating',
      message: 'Navigating to Xiaohongshu homepage. Please wait 3-5 seconds for the page to load.',
      previousUrl: currentUrl,
      targetUrl: 'https://www.xiaohongshu.com/',
    };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

/**
 * Search for notes (帖子) by keyword, with optional filters.
 *
 * 固定两步流程（每次调用都执行）：
 * 步骤1：若当前不在该关键字的搜索结果页 → 导航过去，返回 navigating（需再次调用）
 * 步骤2：已在正确的搜索结果页 → 应用筛选条件（如有）→ 解析并返回帖子列表
 *
 * 筛选面板 DOM 结构：
 * - 触发按钮：.filter（mouseenter 触发展开）
 * - 面板：.filter-panel > .filter-container > .filters-wrapper > .filters
 * - 每个 .filters 的第一个 span 是分类名称
 * - 选项：.filters .tags span（当前选中的 .tags 有 .active 类）
 *
 * @param {object} args - { keyword, sortBy?, noteType?, publishTime?, searchScope?, location? }
 */
async function searchNotes(args) {
  try {
    const { keyword, sortBy, noteType, publishTime, searchScope, location } = args;

    if (!keyword || !keyword.trim()) {
      return {
        error: 'Missing required parameter',
        message: 'keyword parameter is required',
      };
    }

    if (!window.location.href.includes('xiaohongshu.com')) {
      return {
        error: 'Not on Xiaohongshu',
        message: 'Please navigate to Xiaohongshu first using xiaohongshu.com.navigate_to_homepage',
      };
    }

    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword.trim())}&source=web_search_result_notes`;
    const currentUrl = window.location.href;

    // 步骤1：检查是否已在该关键字的搜索结果页
    // URL 中包含 search_result 且 keyword 参数匹配，才认为是正确的结果页
    const isOnCorrectPage = currentUrl.includes('xiaohongshu.com/search_result')
      && currentUrl.includes(`keyword=${encodeURIComponent(keyword.trim())}`);

    if (!isOnCorrectPage) {
      setTimeout(() => {
        window.location.href = searchUrl;
      }, 100);

      return {
        status: 'navigating',
        message: `正在搜索"${keyword.trim()}"，请等待 3-5 秒页面加载完成后再次调用此工具获取结果。`,
        keyword: keyword.trim(),
        searchUrl,
        previousUrl: currentUrl,
        note: '页面加载完成后，请用相同的 keyword（和筛选参数）再次调用 xiaohongshu.com.search_notes。',
      };
    }

    if (hasLoginGate()) {
      return loginRequiredResult('search_notes');
    }

    // 步骤2：已在正确的搜索结果页 → 应用筛选（如有）→ 解析
    const filterMap = {
      '排序依据': sortBy,
      '笔记类型': noteType,
      '发布时间': publishTime,
      '搜索范围': searchScope,
      '位置距离': location,
    };
    const hasFilters = Object.values(filterMap).some(v => v);

    if (hasFilters) {
      const filterBtn = document.querySelector('.filter');
      if (!filterBtn) {
        return { error: 'Filter button not found', message: '页面上找不到筛选按钮' };
      }

      filterBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await sleep(600);

      // 如果面板没展开（offsetParent 为 null 表示隐藏），尝试 click
      const filterPanel = document.querySelector('.filter-panel');
      if (!filterPanel || filterPanel.offsetParent === null) {
        filterBtn.click();
        await sleep(600);
      }

      for (const [categoryName, targetValue] of Object.entries(filterMap)) {
        if (!targetValue) continue;

        const filterGroups = document.querySelectorAll('.filter-panel .filters');
        let targetGroup = null;
        for (const group of filterGroups) {
          if (group.querySelector('span')?.textContent?.trim() === categoryName) {
            targetGroup = group;
            break;
          }
        }
        if (!targetGroup) continue;

        for (const tag of targetGroup.querySelectorAll('.tags')) {
          if (tag.querySelector('span')?.textContent?.trim() === targetValue) {
            if (!tag.classList.contains('active')) {
              tag.click();
              await sleep(300);
            }
            break;
          }
        }
      }

      filterBtn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      await sleep(2500);
    }

    try {
      await waitForElement('section.note-item', 8000);
    } catch (error) {
      if (hasLoginGate()) {
        return loginRequiredResult('search_notes');
      }
      throw error;
    }
    await sleep(500);

    const notes = parseNoteCards();

    return {
      status: 'success',
      keyword: keyword.trim(),
      currentUrl: window.location.href,
      appliedFilters: { sortBy, noteType, publishTime, searchScope, location },
      totalNotes: notes.length,
      notes,
    };
  } catch (error) {
    return {
      error: 'Failed to search notes',
      message: error.message,
    };
  }
}

/**
 * Open a note by ID or URL, then parse and return its detail.
 *
 * 两阶段策略：
 * 1. 若当前不在目标帖子页 → 导航过去，返回 navigating
 * 2. 若已在帖子页 → 解析并返回帖子详情（标题、正文、评论等）
 *
 * @param {object} args - { id?: string, url?: string }
 */
async function openNote(args) {
  try {
    const { id, url } = args;

    if (!id && !url) {
      return {
        error: 'Missing required parameter',
        message: 'Either id or url is required',
      };
    }

    // 解析目标 URL
    let targetUrl = '';
    let noteId = '';
    if (url) {
      // 从 URL 中提取 ID
      const match = url.match(/\/(?:explore|search_result)\/([a-f0-9]+)/);
      noteId = match?.[1] || '';
      targetUrl = normalizeNoteUrl({ url });
    } else {
      noteId = id.trim();
      targetUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    }

    // 已在目标帖子页 → 直接解析
    const currentUrl = window.location.href;
    if (currentUrl.includes(`/explore/${noteId}`)) {
      if (hasLoginGate()) {
        return loginRequiredResult('open_note');
      }
      await waitForElement('#detail-title', 8000);
      await sleep(500);

      const detail = parseNoteDetail();

      return {
        status: 'success',
        noteId,
        noteUrl: targetUrl,
        ...detail,
      };
    }

    // 不在目标页 → 导航过去
    setTimeout(() => {
      window.location.href = targetUrl;
    }, 100);

    return {
      status: 'navigating',
      message: `Opening note ${noteId}. Please wait 3-5 seconds for the page to load, then call this tool again to get the note detail.`,
      noteId,
      noteUrl: targetUrl,
      previousUrl: currentUrl,
      note: 'Wait for the note page to load, then call xiaohongshu.com.open_note again with the same id/url to parse the content.',
    };
  } catch (error) {
    return {
      error: 'Failed to open note',
      message: error.message,
    };
  }
}

async function readComments(args = {}) {
  const { id = '', url = '', limit = 10 } = args;
  const targetUrl = normalizeNoteUrl({ id, url });
  if (!isNotePath() || ((id || url) && !isSameNotePage(targetUrl))) {
    return navigateAndAskRetry(targetUrl, '已打开小红书笔记详情页，请等待页面加载完成后再次调用该工具读取评论。');
  }
  if (hasLoginGate()) {
    return loginRequiredResult('read_comments');
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  let detail = parseNoteDetail();
  if (!detail.comments.length) {
    const commentRoot = document.querySelector('.comments-container, .comment-list, [class*="comment"]');
    if (commentRoot?.scrollIntoView) {
      commentRoot.scrollIntoView({ block: 'center' });
    } else {
      window.scrollTo({ top: Math.max(0, document.body.scrollHeight * 0.65), behavior: 'auto' });
    }
    await sleep(2500);
    detail = parseNoteDetail();
  }

  return {
    noteId: noteIdFromUrl(),
    count: detail.comments.slice(0, safeLimit).length,
    totalComments: detail.totalComments,
    comments: detail.comments.slice(0, safeLimit),
    message: detail.comments.length ? '已读取当前笔记评论。' : '当前页面未读取到评论；可能评论区尚未加载、评论关闭或页面结构已变化。',
    url: window.location.href,
  };
}

async function likeNote(args = {}) {
  const { id = '', url = '', confirm = false } = args;
  const targetUrl = normalizeNoteUrl({ id, url });
  if (!isNotePath() || ((id || url) && !isSameNotePage(targetUrl))) {
    return navigateAndAskRetry(targetUrl, '已打开小红书笔记详情页，请等待页面加载完成后再次调用该工具点赞。');
  }
  if (hasLoginGate()) {
    return loginRequiredResult('like_note');
  }

  const control = findActionControl('like');
  if (controlLooksActive(control)) {
    return {
      changed: false,
      liked: true,
      message: '笔记已经点赞，未执行取消点赞操作。',
      url: window.location.href,
    };
  }
  if (!confirm) {
    return {
      changed: false,
      liked: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行点赞。',
      url: window.location.href,
    };
  }
  if (!control) {
    return {
      changed: false,
      liked: false,
      error: '未找到点赞按钮。',
      url: window.location.href,
    };
  }

  const beforeSnapshot = actionControlSnapshot(control);
  clickControl(control);
  const state = await waitForActionState('like', control, beforeSnapshot);
  const liked = Boolean(state.active || state.feedback);
  return {
    changed: liked,
    liked,
    evidence: state.feedback || (liked ? 'active_control' : ''),
    message: liked ? '已执行点赞。' : '已尝试点赞，但未能确认是否成功。',
    url: window.location.href,
  };
}

async function favoriteNote(args = {}) {
  const { id = '', url = '', confirm = false } = args;
  const targetUrl = normalizeNoteUrl({ id, url });
  if (!isNotePath() || ((id || url) && !isSameNotePage(targetUrl))) {
    return navigateAndAskRetry(targetUrl, '已打开小红书笔记详情页，请等待页面加载完成后再次调用该工具收藏。');
  }
  if (hasLoginGate()) {
    return loginRequiredResult('favorite_note');
  }

  const control = findActionControl('favorite');
  if (controlLooksActive(control)) {
    return {
      changed: false,
      favorited: true,
      message: '笔记已经收藏，未执行取消收藏操作。',
      url: window.location.href,
    };
  }
  if (!confirm) {
    return {
      changed: false,
      favorited: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行收藏。',
      url: window.location.href,
    };
  }
  if (!control) {
    return {
      changed: false,
      favorited: false,
      error: '未找到收藏按钮。',
      url: window.location.href,
    };
  }

  const beforeSnapshot = actionControlSnapshot(control);
  clickControl(control);
  const state = await waitForActionState('favorite', control, beforeSnapshot);
  const favorited = Boolean(state.active || state.feedback);
  return {
    changed: favorited,
    favorited,
    evidence: state.feedback || (favorited ? 'active_control' : ''),
    message: favorited ? '已执行收藏。' : '已尝试收藏，但未能确认是否成功。',
    url: window.location.href,
  };
}

// ─── Adapter Registration ────────────────────────────────────────────────────

window.__webmcpRegister({
  name: 'xiaohongshu-adapter',
  match: ['xiaohongshu.com'],
  tools: [
    {
      name: 'xiaohongshu.com.check_login_status',
      description: '检查当前小红书浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、账号凭据或其他敏感信息。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => checkLoginStatus(),
    },
    {
      name: 'xiaohongshu.com.navigate_to_homepage',
      description: 'Navigate to the Xiaohongshu (小红书) homepage.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => navigateToHomepage(),
    },

    {
      name: 'xiaohongshu.com.search_notes',
      description:
        'Search for notes (帖子) on Xiaohongshu by keyword with optional filters. If not on the search results page, navigates there first — call again after 3-5 seconds (with the same keyword and desired filters) to apply filters and get results.',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '搜索关键字 (e.g., "咖啡", "旅行攻略", "穿搭")',
          },
          sortBy: {
            type: 'string',
            description: '排序依据',
            enum: ['综合', '最新', '最多点赞', '最多评论', '最多收藏'],
          },
          noteType: {
            type: 'string',
            description: '笔记类型',
            enum: ['不限', '视频', '图文'],
          },
          publishTime: {
            type: 'string',
            description: '发布时间',
            enum: ['不限', '一天内', '一周内', '半年内'],
          },
          searchScope: {
            type: 'string',
            description: '搜索范围',
            enum: ['不限', '已看过', '未看过', '已关注'],
          },
          location: {
            type: 'string',
            description: '位置距离',
            enum: ['不限', '同城', '附近'],
          },
        },
        required: ['keyword'],
      },
      handler: (args) => searchNotes(args),
    },
    {
      name: 'xiaohongshu.com.open_note',
      description:
        'Open a Xiaohongshu note by ID or URL and return its full detail: title, body text, post date, and top-level comments (author, content, date, location, likes). For image notes, returns noteType="image" and images[]. For video notes, returns noteType="video" and video={cover, duration} — LIMITATION: the actual video URL is not available; the adapter runs in an isolated DOM context and cannot access the real video URL stored in the page JS memory (xgplayer config). If not already on the note page, navigates there first — call again after 3-5 seconds to get the content.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Note ID (e.g., "69a7ff7e00000000220334e1")',
          },
          url: {
            type: 'string',
            description: 'Full note URL (e.g., "https://www.xiaohongshu.com/explore/69a7ff7e00000000220334e1")',
          },
        },
      },
      handler: (args) => openNote(args),
    },
    {
      name: 'xiaohongshu.com.read_comments',
      description: '读取当前或指定小红书笔记的评论摘要。首次调用可能会跳转笔记详情页，页面加载后再次调用可读取评论。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '笔记 ID；为空时使用当前页' },
          url: { type: 'string', description: '笔记详情 URL；为空时使用当前页' },
          limit: { type: 'number', description: '最多返回评论数量，1-20' },
        },
      },
      handler: (args) => readComments(args),
    },
    {
      name: 'xiaohongshu.com.like_note',
      description: '对当前或指定小红书笔记执行点赞；如果已经点赞则返回已点赞，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '笔记 ID；为空时使用当前页' },
          url: { type: 'string', description: '笔记详情 URL；为空时使用当前页' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行点赞' },
        },
      },
      handler: (args) => likeNote(args),
    },
    {
      name: 'xiaohongshu.com.favorite_note',
      description: '对当前或指定小红书笔记执行收藏；如果已经收藏则返回已收藏，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '笔记 ID；为空时使用当前页' },
          url: { type: 'string', description: '笔记详情 URL；为空时使用当前页' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行收藏' },
        },
      },
      handler: (args) => favoriteNote(args),
    },
  ],
});
