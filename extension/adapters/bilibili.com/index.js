/**
 * Bilibili Adapter Script
 *
 * NOTE: Runs in isolated world — can only access DOM, not page JS variables.
 *
 * Maintainer: WeWorker project
 */

// ─── Utilities ───────────────────────────────────────────────────────────────

function absoluteUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return '';
  }
}

function normalizedText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBilibiliVideoPath(pathname = window.location.pathname) {
  return /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i.test(pathname);
}

function normalizeVideoUrl(videoUrl = '') {
  const raw = String(videoUrl || '').trim();
  if (!raw) return window.location.href;
  if (/^https:\/\/www\.bilibili\.com\/video\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const id = raw.replace(/^\/+|\/+$/g, '');
  if (/^(BV[0-9A-Za-z]+|av\d+)$/i.test(id)) {
    return `https://www.bilibili.com/video/${id}`;
  }
  return `https://www.bilibili.com/video/${id}`;
}

function isSamePage(targetUrl) {
  try {
    const current = new URL(window.location.href);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') && current.search === target.search;
  } catch {
    return false;
  }
}

function navigateAndAskRetry(targetUrl, reason) {
  window.location.assign(targetUrl);
  return {
    ok: true,
    needs_retry: true,
    url: targetUrl,
    message: reason || '已跳转页面，请等待页面加载完成后再次调用该工具。',
  };
}

function firstText(selectors, root = document) {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = normalizedText(el?.innerText || el?.textContent || el?.getAttribute?.('title') || '');
    if (text) return text;
  }
  return '';
}

function findControl(patterns) {
  const controls = Array.from(document.querySelectorAll('button, .video-toolbar-left .toolbar-left-item, .video-toolbar-left [class*="toolbar"], .ops span, .ops button, .bpx-player-ctrl-btn, [role="button"], a'));
  return controls.find((el) => {
    const text = normalizedText(el.innerText || el.textContent || '');
    const title = normalizedText(el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-title') || '');
    const className = String(el.className || '');
    const combined = `${text} ${title} ${className}`;
    return patterns.some((pattern) => pattern.test(combined));
  }) || null;
}

function controlLooksActive(el) {
  if (!el) return false;
  const combined = [
    el.getAttribute('class') || '',
    el.getAttribute('aria-pressed') || '',
    el.getAttribute('title') || '',
    el.getAttribute('aria-label') || '',
    el.textContent || '',
  ].join(' ');
  return /(on|active|selected|true|已|取消|liked|favorited|is-.*active)/i.test(combined);
}

function videoIdFromUrl(url = window.location.href) {
  try {
    const { pathname } = new URL(url, window.location.origin);
    const match = pathname.match(/\/video\/([^/?#]+)/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

// ─── Login / page state ──────────────────────────────────────────────────────

async function checkLoginStatus() {
  const avatar = document.querySelector('.header-avatar-wrap img, .bili-avatar img, a[href*="space.bilibili.com"] img, .right-entry__outside .avatar');
  const loginEntry = Array.from(document.querySelectorAll('a, button, span, div'))
    .find((el) => /^登录$/.test(normalizedText(el.innerText || el.textContent || '')));
  const spaceLink = Array.from(document.querySelectorAll('a[href*="space.bilibili.com/"]'))
    .find((link) => !/\/0(?:\?|$|\/)/.test(link.getAttribute('href') || ''));
  const username = normalizedText(avatar?.getAttribute('alt') || document.querySelector('.nickname, .user-name, .header-entry-mini .name')?.textContent || '');
  const profileUrl = absoluteUrl(spaceLink?.getAttribute('href') || '');
  const loggedIn = Boolean(avatar || spaceLink) && !Boolean(loginEntry && !avatar && !spaceLink);

  return {
    logged_in: loggedIn,
    username,
    profile_url: profileUrl,
    signals: {
      has_avatar: Boolean(avatar),
      has_space_link: Boolean(spaceLink),
      has_login_entry: Boolean(loginEntry),
    },
    url: window.location.href,
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

async function searchVideos({ query = 'weworker', limit = 5 } = {}) {
  const keyword = String(query || 'weworker').trim();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const targetUrl = `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
  if (!isSamePage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 B 站搜索页，请等待搜索结果加载后再次调用该工具。');
  }

  const results = [];
  const seen = new Set();
  const roots = Array.from(document.querySelectorAll('.video-list-item, .bili-video-card, .video-item, .search-card, .card-box, li'));

  function addResult(root) {
    if (results.length >= safeLimit) return;
    const link = root.querySelector?.('a[href*="/video/"]') || root.closest?.('a[href*="/video/"]');
    if (!link) return;
    const url = absoluteUrl(link.getAttribute('href') || '');
    const id = videoIdFromUrl(url);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const title = normalizedText(link.getAttribute('title') || root.querySelector?.('[title]')?.getAttribute('title') || root.querySelector?.('.bili-video-card__info--tit, .title, h3')?.textContent || link.textContent || '');
    const author = normalizedText(root.querySelector?.('.bili-video-card__info--author, .up-name, .upname, a[href*="space.bilibili.com"]')?.textContent || '');
    const stats = normalizedText(root.querySelector?.('.bili-video-card__stats, .so-icon, .tags')?.textContent || '');
    const description = normalizedText(root.querySelector?.('.desc, .description, .bili-video-card__info--desc')?.textContent || '').slice(0, 300);

    if (!title && !id) return;
    results.push({
      id,
      title,
      url,
      author,
      stats,
      description,
    });
  }

  roots.forEach(addResult);
  if (!results.length) {
    Array.from(document.querySelectorAll('a[href*="/video/"]')).forEach((link) => addResult(link));
  }

  return {
    query: keyword,
    count: results.length,
    videos: results,
    url: window.location.href,
  };
}

// ─── Video detail ───────────────────────────────────────────────────────────

async function openVideoDetail({ video_url = '' } = {}) {
  const targetUrl = normalizeVideoUrl(video_url);
  if (!isBilibiliVideoPath() || !isSamePage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 B 站视频详情页，请等待页面加载完成后再次调用该工具。');
  }

  const title = firstText(['h1.video-title', '.video-title', 'h1[title]', 'h1']);
  const author = firstText(['.up-name', '.up-info .name', '.username', 'a[href*="space.bilibili.com"]']);
  const statsText = firstText(['.video-info-detail-list', '.video-data', '.view-text', '.video-info']);
  const publishTime = firstText(['.pubdate-text', '.pubdate', '.video-pubdate']);
  const description = firstText(['.desc-info-text', '.video-desc-container', '.basic-desc-info', '.desc']).slice(0, 1200);
  const tags = Array.from(document.querySelectorAll('.tag-link, .video-tag-container a, a[href*="/v/topic/detail"]'))
    .map((el) => normalizedText(el.innerText || el.textContent || ''))
    .filter(Boolean)
    .slice(0, 12);

  return {
    id: videoIdFromUrl(),
    title,
    author,
    stats: statsText,
    published_at: publishTime,
    description,
    tags,
    url: window.location.href,
    title_text: document.title,
  };
}

// ─── Comments ───────────────────────────────────────────────────────────────

async function readComments({ limit = 10 } = {}) {
  if (!isBilibiliVideoPath()) {
    return {
      ok: false,
      error: '当前页面不是 B 站视频详情页。请先打开视频详情页。',
      url: window.location.href,
    };
  }

  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  const roots = Array.from(document.querySelectorAll('.reply-item, .root-reply-container, .list-item.reply-wrap, .comment-item, bili-comment-thread-renderer'));
  const comments = roots.map((root) => {
    const author = normalizedText(root.querySelector?.('.user-name, .sub-user-name, .name, a[href*="space.bilibili.com"]')?.textContent || '');
    const content = normalizedText(root.querySelector?.('.reply-content, .root-reply, .text, .content, bili-rich-text')?.textContent || root.textContent || '').slice(0, 800);
    const time = normalizedText(root.querySelector?.('.reply-time, .time, .sub-reply-time')?.textContent || '');
    const like = normalizedText(root.querySelector?.('.reply-like, .like, .like-count')?.textContent || '');
    return { author, content, time, like };
  }).filter((item) => item.content).slice(0, safeLimit);

  return {
    video_id: videoIdFromUrl(),
    count: comments.length,
    comments,
    message: comments.length ? '已读取当前页面可见评论。' : '当前页面未读取到可见评论；可滚动到评论区并等待加载后再次调用。',
    url: window.location.href,
  };
}

// ─── Like / Favorite ────────────────────────────────────────────────────────

async function likeVideo({ video_url = '', confirm = false } = {}) {
  const targetUrl = normalizeVideoUrl(video_url);
  if (!isBilibiliVideoPath() || !isSamePage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 B 站视频详情页，请等待页面加载完成后再次调用该工具。');
  }

  const control = findControl([/点赞|like/i, /video-like/i]);
  if (controlLooksActive(control)) {
    return {
      changed: false,
      liked: true,
      message: '视频已经点赞，未执行取消点赞操作。',
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

  control.click();
  await sleep(1200);
  const after = findControl([/点赞|like/i, /video-like/i]);
  const liked = controlLooksActive(after || control);
  return {
    changed: liked,
    liked,
    message: liked ? '已执行点赞。' : '未能确认点赞是否成功。',
    url: window.location.href,
  };
}

function findFavoriteSubmitButton() {
  return Array.from(document.querySelectorAll('button, .btn, .submit, .fav-add-btn, .collection-submit'))
    .find((el) => /确定|完成|收藏|提交|确认/.test(normalizedText(el.innerText || el.textContent || el.getAttribute('title') || ''))) || null;
}

function findFavoriteFolder(folderName) {
  const wanted = normalizedText(folderName);
  if (!wanted) return null;
  return Array.from(document.querySelectorAll('label, li, .fav-item, .collection-item, .group-list-item, .favlist-item'))
    .find((el) => normalizedText(el.innerText || el.textContent || '').includes(wanted)) || null;
}

function hasFavoriteDialog() {
  return Boolean(document.querySelector('.favorite-dialog, .fav-box, .collection-dialog, .bili-dialog, .van-popover, .bili-modal') ||
    Array.from(document.querySelectorAll('button, .btn')).some((el) => /确定|完成/.test(normalizedText(el.innerText || el.textContent || ''))));
}

async function favoriteVideo({ video_url = '', folder_name = '', confirm = false } = {}) {
  const targetUrl = normalizeVideoUrl(video_url);
  if (!isBilibiliVideoPath() || !isSamePage(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 B 站视频详情页，请等待页面加载完成后再次调用该工具。');
  }

  const control = findControl([/收藏|favorite|fav/i, /video-fav/i]);
  if (controlLooksActive(control)) {
    return {
      changed: false,
      favorited: true,
      message: '视频已经收藏，未执行取消收藏操作。',
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

  control.click();
  await sleep(1000);

  if (hasFavoriteDialog()) {
    const folder = findFavoriteFolder(folder_name);
    if (!folder) {
      return {
        changed: false,
        favorited: false,
        needs_folder_selection: true,
        message: folder_name ? `未找到名为“${folder_name}”的收藏夹。请确认收藏夹名称后再次调用。` : '页面要求选择收藏夹；请传入 folder_name 或手动选择收藏夹后确认。',
        url: window.location.href,
      };
    }
    folder.click();
    await sleep(500);
    const submit = findFavoriteSubmitButton();
    if (!submit) {
      return {
        changed: false,
        favorited: false,
        needs_manual_submit: true,
        message: '已尝试选择收藏夹，但未找到确认按钮；请手动确认收藏。',
        url: window.location.href,
      };
    }
    submit.click();
    await sleep(1200);
  }

  const after = findControl([/收藏|favorite|fav/i, /video-fav/i]);
  const favorited = controlLooksActive(after || control);
  return {
    changed: favorited,
    favorited,
    message: favorited ? '已执行收藏。' : '已尝试收藏，但未能确认收藏是否成功。',
    url: window.location.href,
  };
}

// ─── Adapter Registration ───────────────────────────────────────────────────

window.__webmcpRegister({
  name: 'bilibili-adapter',
  match: ['bilibili.com'],
  tools: [
    {
      name: 'bilibili.com.check_login_status',
      description: '检查当前 B 站浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、账号凭据或其他敏感信息。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => checkLoginStatus(),
    },
    {
      name: 'bilibili.com.search_videos',
      description: '根据关键词搜索 B 站视频，并返回标题、链接、UP 主、播放信息和摘要。首次调用可能会跳转搜索页，页面加载后再次调用可读取结果。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '返回数量，1-10' },
        },
        required: [],
      },
      handler: (args) => searchVideos(args),
    },
    {
      name: 'bilibili.com.open_video_detail',
      description: '打开或读取 B 站视频详情页，返回标题、UP 主、播放量、弹幕数、发布时间、简介和关键链接。首次调用可能会跳转视频页，页面加载后再次调用可读取详情。',
      parameters: {
        type: 'object',
        properties: {
          video_url: { type: 'string', description: '视频 URL、BV 号或 av 号；为空时使用当前页' },
        },
        required: [],
      },
      handler: (args) => openVideoDetail(args),
    },
    {
      name: 'bilibili.com.read_comments',
      description: '读取当前 B 站视频页的评论摘要。页面评论未加载时，可先滚动到评论区后再次调用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回评论数量，1-20' },
        },
        required: [],
      },
      handler: (args) => readComments(args),
    },
    {
      name: 'bilibili.com.like_video',
      description: '对当前或指定 B 站视频执行点赞；如果已经点赞则返回已点赞，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态。',
      safety: 'write',
      requiresConfirmation: true,
      confirmationMessage: '即将使用当前 B 站登录账号点赞目标视频。确认后只会执行点赞，不会执行取消点赞。',
      parameters: {
        type: 'object',
        properties: {
          video_url: { type: 'string', description: '视频 URL、BV 号或 av 号；为空时使用当前页' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行点赞' },
        },
        required: [],
      },
      handler: (args) => likeVideo(args),
    },
    {
      name: 'bilibili.com.favorite_video',
      description: '对当前或指定 B 站视频执行收藏；如果已经收藏则返回已收藏，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态；需要选择收藏夹时可传 folder_name。',
      safety: 'write',
      requiresConfirmation: true,
      confirmationMessage: '即将使用当前 B 站登录账号收藏目标视频。确认后只会执行收藏，不会执行取消收藏。',
      parameters: {
        type: 'object',
        properties: {
          video_url: { type: 'string', description: '视频 URL、BV 号或 av 号；为空时使用当前页' },
          folder_name: { type: 'string', description: '收藏夹名称；当页面弹出收藏夹选择时用于选择目标收藏夹' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行收藏' },
        },
        required: [],
      },
      handler: (args) => favoriteVideo(args),
    },
  ],
});
