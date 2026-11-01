/* v2 compatibility implementation for github.com; preserves the tracked legacy executable logic. */
(function () {
  var captured = [];
  var previousRegister = window.__webmcpRegister;
  window.__webmcpRegister = function (adapter) { captured.push(adapter || {}); };
  window.__webmcpGeneratedSupport = window.__webmcpGeneratedSupport || {};
  window.__webmcpGeneratedLegacyHandlers = window.__webmcpGeneratedLegacyHandlers || {};
  try {
/* embedded legacy source: index.js */
/**
 * GitHub Adapter Script
 *
 * NOTE: Runs in isolated world — can only access DOM, not page JS variables.
 *
 * Verified: GitHub, September 2026
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

function normalizeRepositoryUrl(repositoryUrl = '') {
  const raw = String(repositoryUrl || '').trim();
  if (!raw) return window.location.href;
  if (/^https:\/\/github\.com\//i.test(raw)) return raw;
  return `https://github.com/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function normalizedText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isGitHubRepositoryPath(pathname = window.location.pathname) {
  return /^\/[^/]+\/[^/]+\/?$/.test(pathname);
}

function isSameUrl(targetUrl) {
  const current = new URL(window.location.href);
  const target = new URL(targetUrl);
  return current.origin === target.origin && current.pathname.replace(/\/$/, '') === target.pathname.replace(/\/$/, '') && current.search === target.search;
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

function repositoryFromPath(pathname = window.location.pathname) {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)/);
  return match ? `${match[1]}/${match[2]}` : '';
}

function findFirstRepositoryLink(root = document) {
  const links = Array.from(root.querySelectorAll('a[href^="/"]'));
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/^\/([^/?#]+)\/([^/?#]+)$/);
    if (!match) continue;
    const owner = match[1];
    const repo = match[2];
    if (['login', 'signup', 'features', 'enterprise', 'pricing', 'marketplace', 'explore', 'topics', 'collections'].includes(owner)) continue;
    return { full_name: `${owner}/${repo}`, url: absoluteUrl(href), link };
  }
  return null;
}

// ─── Login / page state ──────────────────────────────────────────────────────

async function checkLoginStatus() {
  const metaLogin = document.querySelector('meta[name="user-login"]')?.content || '';
  const actor = document.querySelector('meta[name="octolytics-actor-login"]')?.content || '';
  const avatarMenu = document.querySelector([
    'button[aria-label*="Open user"]',
    'button[aria-label*="View profile"]',
    'summary[aria-label*="View profile"]',
    'summary[aria-label*="profile"]',
    'button.AppHeader-user',
    'img.avatar',
  ].join(','));
  const loginLink = document.querySelector('a[href="/login"], a[href^="/login?"]');
  const signupLink = document.querySelector('a[href="/signup"], a[href^="/signup?"]');

  let profileHref = '';
  for (const link of Array.from(document.querySelectorAll('a[href^="/"]'))) {
    const href = link.getAttribute('href') || '';
    if (!/^\/[A-Za-z0-9-]+$/.test(href)) continue;
    if (['/login', '/signup', '/features', '/enterprise', '/pricing', '/marketplace', '/explore', '/topics', '/collections'].includes(href)) continue;
    if (link.querySelector('img.avatar')) {
      profileHref = href;
      break;
    }
  }

  const username = metaLogin || actor || (profileHref ? profileHref.slice(1) : '');
  const loggedIn = Boolean(username || avatarMenu) && !Boolean(loginLink && signupLink && !avatarMenu);

  return {
    logged_in: loggedIn,
    username,
    profile_url: username ? `https://github.com/${username}` : (profileHref ? absoluteUrl(profileHref) : ''),
    signals: {
      has_avatar_menu: Boolean(avatarMenu),
      has_login_link: Boolean(loginLink),
      has_signup_link: Boolean(signupLink),
    },
    url: window.location.href,
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

async function searchRepositories({ query = 'weworker', limit = 5 } = {}) {
  const keyword = String(query || 'weworker').trim();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
  const targetUrl = `https://github.com/search?q=${encodeURIComponent(keyword)}&type=repositories`;
  if (!isSameUrl(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 GitHub 仓库搜索页，请等待搜索结果加载后再次调用该工具。');
  }

  const results = [];
  const seen = new Set();
  const candidates = Array.from(document.querySelectorAll('[data-testid="results-list"] div.search-title, div[data-testid="results-list"] article, .Box-sc-g0xbh4-0'));
  const fallbackLinks = Array.from(document.querySelectorAll('a[href^="/"]'));

  function addResult(root) {
    if (results.length >= safeLimit) return;
    const link = root.querySelector?.('a[href^="/"]') || root.closest?.('a[href^="/"]') || root;
    if (!link) return;
    const href = link.getAttribute('href') || '';
    const match = href.match(/^\/([^/?#]+)\/([^/?#]+)$/);
    if (!match) return;
    const fullName = `${match[1]}/${match[2]}`;
    if (seen.has(fullName)) return;
    seen.add(fullName);

    const container = root.closest?.('article, div[data-testid="results-list"] > div, .Box-sc-g0xbh4-0') || root.parentElement || root;
    const text = normalizedText(container.innerText);
    const language = (text.match(/\b(JavaScript|TypeScript|Python|Java|Go|Rust|C\+\+|C#|PHP|Ruby|Shell|Vue|HTML|CSS)\b/) || [])[1] || '';
    const stars = (text.match(/(\d+(?:\.\d+)?k?|\d+)\s+stars?/i) || text.match(/Stars?\s*(\d+(?:\.\d+)?k?)/i) || [])[1] || '';
    const descriptionEl = container.querySelector?.('p, [data-testid="results-list"] span');
    results.push({
      full_name: fullName,
      url: absoluteUrl(href),
      description: normalizedText(descriptionEl?.innerText || ''),
      language,
      stars,
    });
  }

  candidates.forEach(addResult);
  if (!results.length) fallbackLinks.forEach(addResult);

  return {
    query: keyword,
    count: results.length,
    repositories: results,
    url: window.location.href,
  };
}

// ─── Repository detail ───────────────────────────────────────────────────────

async function getRepositoryDetail({ repository_url = '' } = {}) {
  const targetUrl = normalizeRepositoryUrl(repository_url);
  if (!isGitHubRepositoryPath() || !isSameUrl(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 GitHub 仓库页，请等待页面加载完成后再次调用该工具。');
  }

  const fullName = repositoryFromPath();
  const description = normalizedText(document.querySelector('[data-testid="repository-about-description"], .BorderGrid-cell p, p.f4')?.innerText || '');
  const readmeSummary = normalizedText(document.querySelector('#readme article, article.markdown-body')?.innerText || '').slice(0, 1200);
  const languages = Array.from(document.querySelectorAll('[data-testid="repository-language-stats"] li, .Layout-sidebar a[href*="search?l="]'))
    .map((el) => normalizedText(el.innerText))
    .filter(Boolean)
    .slice(0, 8);

  const social = {};
  for (const link of Array.from(document.querySelectorAll('a[href$="/stargazers"], a[href$="/forks"], a[href$="/watchers"]'))) {
    const href = link.getAttribute('href') || '';
    const text = normalizedText(link.innerText);
    if (href.endsWith('/stargazers')) social.stars = text;
    if (href.endsWith('/forks')) social.forks = text;
    if (href.endsWith('/watchers')) social.watchers = text;
  }

  return {
    full_name: fullName,
    description,
    readme_summary: readmeSummary,
    languages,
    stars: social.stars || '',
    forks: social.forks || '',
    watchers: social.watchers || '',
    issues_url: fullName ? `https://github.com/${fullName}/issues` : '',
    pulls_url: fullName ? `https://github.com/${fullName}/pulls` : '',
    code_url: window.location.href,
    title: document.title,
  };
}

// ─── Issue / PR detail ───────────────────────────────────────────────────────

async function getIssueOrPrDetail({ issue_url = '', max_comments = 3 } = {}) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const target = new URL(issue_url ? normalizeRepositoryUrl(issue_url) : window.location.href);
  const route = target.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pulls|pull)(?:\/(\d+))?\/?$/);
  if (target.origin !== 'https://github.com' || target.username || target.password || !route
      || (route[4] ? route[3] === 'pulls' : route[3] === 'pull')) {
    fail('INVALID_ARGS', 'Use a GitHub Issue/PR detail URL or an issues/pulls list URL.');
  }

  const checkPage = (checkMissing = true) => {
    if (checkMissing && /^Page not found\b/i.test(document.title || '')) fail('NOT_FOUND', 'GitHub page is unavailable; check its URL and browser access.');
    if (window.location.pathname === '/login' || document.querySelector('form[action="/session"]')) {
      fail('AUTH_REQUIRED', 'Complete GitHub login in the connected browser before retrying.');
    }
  };
  checkPage(false);
  const navigation = url => ({ __webcli_navigation: { version: 1, url, resume: true } });
  const key = '__weworker_github_detail_navigation';
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(key)); } catch { }
  const prefix = `/${route[1]}/${route[2]}/${route[3] === 'pulls' ? 'pull' : 'issues'}/`;
  const current = new URL(window.location.href);
  const resumed = !route[4] && pending?.list === target.href && Date.now() - pending.at >= 0 && Date.now() - pending.at < 120000
    && pending.detail === current.href && current.origin === target.origin
    && current.pathname.startsWith(prefix) && /^\d+\/?$/.test(current.pathname.slice(prefix.length));
  if (!isSameUrl(target.href) && !resumed) return navigation(target.href);
  checkPage();

  const waitFor = async read => {
    for (let attempt = 0; attempt < 60; attempt++) {
      checkPage();
      const value = read();
      if (value) return value;
      if (attempt < 59) await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail('NOT_READY', 'GitHub Issue/PR content is not ready or the page structure is unsupported; retain the trace and retry.');
  };
  if (!route[4] && !resumed) {
    const detail = await waitFor(() => {
      for (const link of document.querySelectorAll('a[href]')) {
        let url;
        try { url = new URL(link.getAttribute('href'), window.location.href); } catch { continue; }
        if (url.origin === target.origin && !url.username && !url.password && url.pathname.startsWith(prefix)
            && /^\d+\/?$/.test(url.pathname.slice(prefix.length))) return url.href;
      }
    });
    try { sessionStorage.setItem(key, JSON.stringify({ list: target.href, detail, at: Date.now() })); }
    catch { fail('NAVIGATION_UNAVAILABLE', 'GitHub read navigation requires browser session storage.'); }
    return navigation(detail);
  }
  const detailPath = window.location.pathname.match(/^\/[^/]+\/[^/]+\/(issues|pull)\/\d+\/?$/);
  if (!detailPath) fail('NOT_READY', 'GitHub has not reached an Issue/PR detail page.');
  const content = await waitFor(() => {
    const titleNode = document.querySelector('bdi.js-issue-title, [data-testid="issue-title"], h1 bdi');
    const bodyNode = document.querySelector('.js-comment-body, [data-testid="markdown-body"], .comment-body');
    const title = normalizedText(titleNode?.innerText || '');
    return title && bodyNode ? { title, bodySummary: normalizedText(bodyNode.innerText || '').slice(0, 1200) } : null;
  });
  if (resumed) { try { sessionStorage.removeItem(key); } catch { } }
  const count = Number(max_comments);
  const safeMaxComments = Number.isFinite(count) ? Math.max(0, Math.min(Math.floor(count), 10)) : 3;
  const kind = window.location.pathname.includes('/pull/') ? 'pull_request' : (window.location.pathname.includes('/issues/') ? 'issue' : 'list_or_unknown');
  const title = content.title;
  const state = normalizedText(document.querySelector('[data-testid="issue-state"], .State, span.State')?.innerText || '');
  const author = normalizedText(document.querySelector('.author, a.author, [data-hovercard-type="user"]')?.innerText || '');
  const bodySummary = content.bodySummary;
  const labels = Array.from(document.querySelectorAll('a.IssueLabel, [data-testid="label"]'))
    .map((el) => normalizedText(el.innerText))
    .filter(Boolean);
  const comments = Array.from(document.querySelectorAll('.js-comment, .TimelineItem'))
    .map((el) => ({ text: normalizedText(el.innerText).slice(0, 600) }))
    .filter((item) => item.text)
    .slice(0, safeMaxComments);

  return {
    kind,
    title,
    state,
    author,
    body_summary: bodySummary,
    labels,
    comments_count: comments.length,
    comments,
    url: window.location.href,
  };
}

// ─── Star ───────────────────────────────────────────────────────────────────

function detectStarState() {
  const controls = Array.from(document.querySelectorAll('button, summary, a')).map((el) => ({
    element: el,
    text: normalizedText(el.innerText || el.getAttribute('aria-label') || ''),
    aria: el.getAttribute('aria-label') || '',
    title: el.getAttribute('title') || '',
  }));
  const unstar = controls.find((item) => /unstar/i.test(`${item.text} ${item.aria} ${item.title}`));
  const star = controls.find((item) => /\bstar\b/i.test(`${item.text} ${item.aria} ${item.title}`));
  return { alreadyStarred: Boolean(unstar), starControl: star?.element || null };
}

async function starCurrentRepository({ repository_url = '', confirm = false } = {}) {
  const targetUrl = normalizeRepositoryUrl(repository_url);
  if (!isGitHubRepositoryPath() || !isSameUrl(targetUrl)) {
    return navigateAndAskRetry(targetUrl, '已打开 GitHub 仓库页，请等待页面加载完成后再次调用该工具。');
  }

  const repository = repositoryFromPath();
  const before = detectStarState();
  if (before.alreadyStarred) {
    return {
      repository,
      changed: false,
      starred: true,
      message: '仓库已经 Star，未执行取消操作。',
      url: window.location.href,
    };
  }

  if (!confirm) {
    return {
      repository,
      changed: false,
      starred: false,
      needs_confirmation: true,
      message: '需要显式传入 confirm=true 才会执行 Star。',
      url: window.location.href,
    };
  }

  if (!before.starControl) {
    return {
      repository,
      changed: false,
      starred: false,
      error: '未找到 Star 按钮。',
      url: window.location.href,
    };
  }

  before.starControl.click();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = detectStarState();
  return {
    repository,
    changed: after.alreadyStarred,
    starred: after.alreadyStarred,
    message: after.alreadyStarred ? '已执行 Star。' : '未能确认 Star 是否成功。',
    url: window.location.href,
  };
}

// ─── Adapter Registration ───────────────────────────────────────────────────

window.__webmcpRegister({
  name: 'github-adapter',
  match: ['github.com'],
  tools: [
    {
      name: 'github.com.check_login_status',
      description: '检查当前 GitHub 浏览器会话是否已登录，并返回登录状态。不会返回 Cookie、Token、邮箱等敏感信息。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => checkLoginStatus(),
    },
    {
      name: 'github.com.search_repositories',
      description: '根据关键词搜索 GitHub 仓库，并返回仓库名称、描述、语言、星标数和链接。首次调用可能会跳转搜索页，页面加载后再次调用可读取结果。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '返回数量，1-10' },
        },
        required: [],
      },
      handler: (args) => searchRepositories(args),
    },
    {
      name: 'github.com.get_repository_detail',
      description: '打开或读取 GitHub 仓库详情页，返回仓库名称、简介、README 摘要、语言、star/fork/watch 信息和关键链接。首次调用可能会跳转仓库页，页面加载后再次调用可读取详情。',
      parameters: {
        type: 'object',
        properties: {
          repository_url: { type: 'string', description: '仓库 URL 或 owner/repo；为空时使用当前页' },
        },
        required: [],
      },
      handler: (args) => getRepositoryDetail(args),
    },
    {
      name: 'github.com.get_issue_or_pr_detail',
      description: '打开或读取 GitHub Issue/Pull Request 详情页，返回标题、状态、作者、正文摘要、标签、评论摘要和链接。传列表页时会进入第一条详情，页面加载后再次调用可读取详情。',
      parameters: {
        type: 'object',
        properties: {
          issue_url: { type: 'string', description: 'Issue/PR URL；为空时使用当前页' },
          max_comments: { type: 'number', description: '最多返回评论摘要数量，0-10' },
        },
        required: [],
      },
      handler: (args) => getIssueOrPrDetail(args),
    },
    {
      name: 'github.com.star_current_repository',
      description: '对当前 GitHub 仓库执行 Star；如果已经 Star 则返回已 Star，不执行取消。必须显式传入 confirm=true 才会修改当前账号状态。',
      safety: 'write',
      requiresConfirmation: true,
      confirmationMessage: '即将使用当前 GitHub 登录账号 Star 目标仓库。确认后只会执行 Star，不会执行 Unstar。',
      parameters: {
        type: 'object',
        properties: {
          repository_url: { type: 'string', description: '仓库 URL 或 owner/repo；为空时使用当前页' },
          confirm: { type: 'boolean', description: '必须显式为 true 才执行 Star' },
        },
        required: [],
      },
      handler: (args) => starCurrentRepository(args),
    },
  ],
});

  } finally {
    window.__webmcpRegister = previousRegister;
  }
  var tools = [];
  for (var i = 0; i < captured.length; i++) {
    var list = Array.isArray(captured[i].tools) ? captured[i].tools : [];
    for (var j = 0; j < list.length; j++) if (list[j] && typeof list[j].handler === 'function') tools.push(list[j]);
  }
  var support = window.__webmcpGeneratedSupport["github.com"];
  if (support && Array.isArray(support.tools)) {
    for (var k = 0; k < support.tools.length; k++) if (support.tools[k] && typeof support.tools[k].handler === 'function') tools.push(support.tools[k]);
  }
  var byName = Object.create(null);
  for (var n = 0; n < tools.length; n++) {
    var tool = tools[n];
    var names = [tool.publicName, tool.name, tool.handlerName];
    for (var z = 0; z < names.length; z++) if (typeof names[z] === 'string' && names[z] && !byName[names[z]]) byName[names[z]] = tool;
  }
  window["__github_com_internal"] = {
    invoke: async function (publicName, params) {
      var tool = byName[publicName];
      if (!tool || typeof tool.handler !== 'function') throw new Error('Legacy handler unavailable for ' + "github.com" + '.' + publicName);
      return tool.handler(params || {});
    },
    names: Object.keys(byName)
  };
})();
