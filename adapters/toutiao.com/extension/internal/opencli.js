/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2: restricted fetch, navigation continuation, validated inputs and explicit parse failures.
 * Rebuild: node webcli/scripts/opencli-wave4/build.mjs */
var __wave4 = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // <stdin>
  var stdin_exports = {};
  __export(stdin_exports, {
    commands: () => commands,
    invoke: () => invoke
  });

  // webcli/scripts/opencli-wave4/errors.js
  var CliError = class extends Error {
    constructor(code, message, hint) {
      super(message);
      this.name = this.constructor.name;
      this.code = code;
      this.hint = hint;
    }
  };
  var ArgumentError = class extends CliError {
    constructor(message, hint) {
      super("ARGUMENT", message, hint);
    }
  };
  var CommandExecutionError = class extends CliError {
    constructor(message, hint) {
      super("COMMAND_EXEC", message, hint);
    }
  };
  var AuthRequiredError = class extends CliError {
    constructor(site, message) {
      super("AUTH_REQUIRED", message || `Please log into ${site}`);
    }
  };
  var EmptyResultError = class extends CliError {
    constructor(command, message) {
      super("EMPTY_RESULT", message || command);
    }
  };

  // webcli/scripts/opencli-wave4/fetch.js
  var endpoints = /* @__PURE__ */ new Map([
    ["www.toutiao.com", /* @__PURE__ */ new Set(["/hot-event/hot-board/", "/api/pc/feed/"])],
    ["export.arxiv.org", /* @__PURE__ */ new Set(["/api/query"])]
  ]);
  async function fetch(raw, options = {}) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !endpoints.get(url.hostname)?.has(url.pathname)) {
      throw new CommandExecutionError("Request is outside the fixed source API endpoints");
    }
    let response;
    try {
      response = await window.__webmcpWecliRuntime.requestPrivileged("backend_fetch", {
        url: url.href,
        browserFallback: false,
        redactBodyInTrace: true,
        options: {
          method: "GET",
          redirect: "manual",
          maxResponseBytes: 4 * 1024 * 1024,
          headers: { Accept: "application/json, application/atom+xml", ...options.headers }
        }
      });
    } catch {
      throw new CommandExecutionError("Source request failed; retain the trace for diagnosis");
    }
    if (response?.redirected || response?.status >= 300 && response?.status < 400 || response?.url && response.url !== url.href) {
      throw new CommandExecutionError("Unexpected API redirect");
    }
    if (typeof response?.body !== "string" || response.body.length > 4 * 1024 * 1024) throw new CommandExecutionError("Missing or oversized response body");
    return { ok: response.ok, status: response.status, text: async () => response.body, json: async () => JSON.parse(response.body) };
  }

  // webcli/scripts/opencli-wave4/registry.js
  var commands = /* @__PURE__ */ new Map();
  var Strategy = { PUBLIC: "public", COOKIE: "cookie" };
  function cli(command) {
    commands.set(`${command.site}/${command.name}`, command);
    return command;
  }

  // webcli/scripts/opencli-wave4/upstream/toutiao/utils.js
  var ARTICLES_MIN_PAGE = 1;
  var ARTICLES_MAX_PAGE = 4;
  var HOT_MIN_LIMIT = 1;
  var HOT_MAX_LIMIT = 50;
  var RECOMMEND_MIN_LIMIT = 1;
  var RECOMMEND_MAX_LIMIT = 50;
  function parseArticlesPage(raw, fallback = 1) {
    if (raw === void 0 || raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--page must be an integer between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < ARTICLES_MIN_PAGE || parsed > ARTICLES_MAX_PAGE) {
      throw new ArgumentError(`--page must be between ${ARTICLES_MIN_PAGE} and ${ARTICLES_MAX_PAGE}, got ${parsed}`);
    }
    return parsed;
  }
  function parseRecommendLimit(raw, fallback = 20) {
    if (raw === void 0 || raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--limit must be an integer between ${RECOMMEND_MIN_LIMIT} and ${RECOMMEND_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < RECOMMEND_MIN_LIMIT || parsed > RECOMMEND_MAX_LIMIT) {
      throw new ArgumentError(`--limit must be between ${RECOMMEND_MIN_LIMIT} and ${RECOMMEND_MAX_LIMIT}, got ${parsed}`);
    }
    return parsed;
  }
  function parseRecommendCategory(raw, fallback = "__all__") {
    if (raw === void 0 || raw === null || raw === "") return fallback;
    const value = String(raw).trim();
    if (!RECOMMEND_CATEGORIES.includes(value)) {
      throw new ArgumentError(`--category must be one of ${RECOMMEND_CATEGORIES.join(", ")}, got ${JSON.stringify(raw)}`);
    }
    return value;
  }
  function parseHotLimit(raw, fallback = 30) {
    if (raw === void 0 || raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--limit must be an integer between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${JSON.stringify(raw)}`);
    }
    if (parsed < HOT_MIN_LIMIT || parsed > HOT_MAX_LIMIT) {
      throw new ArgumentError(`--limit must be between ${HOT_MIN_LIMIT} and ${HOT_MAX_LIMIT}, got ${parsed}`);
    }
    return parsed;
  }
  var NON_TITLE_LINES = /* @__PURE__ */ new Set([
    "\u5C55\u73B0",
    "\u9605\u8BFB",
    "\u70B9\u8D5E",
    "\u8BC4\u8BBA",
    "\u67E5\u770B\u6570\u636E",
    "\u67E5\u770B\u8BC4\u8BBA",
    "\u4FEE\u6539",
    "\u66F4\u591A",
    "\u9996\u53D1",
    "\u5DF2\u53D1\u5E03",
    "\u5B9A\u65F6\u53D1\u5E03",
    "\u5B9A\u65F6\u53D1\u5E03\u4E2D",
    "\u7531\u6587\u7AE0\u751F\u6210",
    "\u5BA1\u6838\u4E2D"
  ]);
  var STATS_RE = /展现\s*([\d,]+)\s*阅读\s*([\d,]+)\s*点赞\s*([\d,]+)\s*评论\s*([\d,]*)/;
  function parseToutiaoArticlesText(text) {
    const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(line)) continue;
      const date = line;
      let title = null;
      let status = null;
      let stats = null;
      for (let back = 3; back >= 1; back--) {
        const prev = lines[i - back] || "";
        if (!prev || prev.length >= 100 || /^\d+$/.test(prev) || NON_TITLE_LINES.has(prev)) continue;
        title = prev;
        break;
      }
      for (let fwd = 1; fwd < 8; fwd++) {
        const fwdLine = lines[i + fwd] || "";
        if (/^\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(fwdLine)) break;
        if (fwdLine === "\u5DF2\u53D1\u5E03" || fwdLine === "\u5B9A\u65F6\u53D1\u5E03\u4E2D" || fwdLine === "\u5BA1\u6838\u4E2D" || fwdLine === "\u7531\u6587\u7AE0\u751F\u6210") {
          status = fwdLine;
        }
        if (fwdLine.includes("\u5C55\u73B0") && fwdLine.includes("\u9605\u8BFB")) {
          const match = fwdLine.match(STATS_RE);
          if (match) {
            stats = {
              "\u5C55\u73B0": match[1],
              "\u9605\u8BFB": match[2],
              "\u70B9\u8D5E": match[3],
              "\u8BC4\u8BBA": match[4] || "0"
            };
          }
        }
      }
      if (!title) continue;
      if (stats) {
        results.push({ title, date, status, ...stats });
      } else {
        results.push({
          title,
          date,
          status,
          "\u5C55\u73B0": null,
          "\u9605\u8BFB": null,
          "\u70B9\u8D5E": null,
          "\u8BC4\u8BBA": null
        });
      }
    }
    return results;
  }
  function trimOrNull(v) {
    const s = String(v ?? "").trim();
    return s ? s : null;
  }
  function pickImage(item) {
    const url = item?.Image?.url;
    if (typeof url === "string" && url) return url;
    const firstFromList = Array.isArray(item?.Image?.url_list) ? item.Image.url_list.map((entry) => typeof entry === "string" ? entry : entry?.url).find((u) => typeof u === "string" && u) : null;
    return firstFromList || null;
  }
  function parseHot(v) {
    if (v === null || v === void 0 || v === "" || typeof v === "boolean") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function mapHotRow(item, index) {
    if (!item || typeof item !== "object") return null;
    const groupId = trimOrNull(item.ClusterIdStr || (item.ClusterId != null ? String(item.ClusterId) : null));
    const title = trimOrNull(item.Title);
    if (!title) return null;
    return {
      rank: index + 1,
      group_id: groupId,
      title,
      query: trimOrNull(item.QueryWord) || title,
      hot_value: parseHot(item.HotValue),
      label: trimOrNull(item.Label),
      url: trimOrNull(item.Url),
      image_url: pickImage(item)
    };
  }
  var HOT_BOARD_URL = "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc";
  var RECOMMEND_URL = "https://www.toutiao.com/api/pc/feed/";
  var RECOMMEND_CATEGORIES = [
    "__all__",
    "news_tech",
    "news_finance",
    "news_world",
    "news_sports",
    "news_entertainment",
    "news_military"
  ];
  function pickFeedImage(item) {
    const raw = trimOrNull(item?.image_url) || trimOrNull(item?.middle_image?.url);
    if (!raw) return null;
    return raw.startsWith("//") ? `https:${raw}` : raw;
  }
  function firstPartyToutiaoUrl(sourceUrl) {
    const raw = trimOrNull(sourceUrl);
    if (!raw) return null;
    try {
      const url = raw.startsWith("/") ? new URL(raw, "https://www.toutiao.com") : new URL(raw);
      if (!/^https?:$/i.test(url.protocol) || !/(^|\.)toutiao\.com$/i.test(url.hostname)) {
        throw new CommandExecutionError(`Malformed toutiao recommend row: off-domain source_url ${JSON.stringify(raw)}.`);
      }
      return url;
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error;
      throw new CommandExecutionError(`Malformed toutiao recommend row: invalid source_url ${JSON.stringify(raw)}.`);
    }
  }
  function articleIdFromToutiaoPath(pathname) {
    return String(pathname || "").match(/^\/(?:group|article)\/([A-Za-z0-9_-]+)\/?$/)?.[1] || "";
  }
  function buildGroupIdentity(sourceUrl, rawGroupId) {
    const source = firstPartyToutiaoUrl(sourceUrl);
    const sourceId = source ? articleIdFromToutiaoPath(source.pathname) : "";
    const explicitId = trimOrNull(rawGroupId);
    const groupId = explicitId || trimOrNull(sourceId);
    if (!groupId) {
      throw new CommandExecutionError("Malformed toutiao recommend row: missing group_id and article source_url.");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(groupId)) {
      throw new CommandExecutionError(`Malformed toutiao recommend row: invalid group_id ${JSON.stringify(rawGroupId)}.`);
    }
    if (sourceId && explicitId && explicitId !== sourceId) {
      throw new CommandExecutionError(`Malformed toutiao recommend row: group_id/source_url mismatch for ${JSON.stringify(rawGroupId)}.`);
    }
    return {
      groupId,
      url: `https://www.toutiao.com/group/${groupId}/`
    };
  }
  function formatBehotTime(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return `${new Date(seconds * 1e3).toISOString().slice(0, 19)}Z`;
  }
  function mapRecommendRow(item, index) {
    if (!item || typeof item !== "object") return null;
    if (item.is_feed_ad) return null;
    const title = trimOrNull(item.title);
    if (!title) return null;
    const identity2 = buildGroupIdentity(
      item.source_url,
      item.group_id != null ? String(item.group_id) : null
    );
    return {
      rank: index + 1,
      group_id: identity2.groupId,
      title,
      abstract: trimOrNull(item.abstract),
      source: trimOrNull(item.source),
      tag: trimOrNull(item.chinese_tag),
      comments: parseHot(item.comments_count),
      published_at: formatBehotTime(item.behot_time),
      url: identity2.url,
      image_url: pickFeedImage(item)
    };
  }
  function looksToutiaoAuthWallText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    return /登录|请登录|账号登录|扫码登录|安全验证|验证码|captcha/.test(text) || /\b(login|sign in|captcha|verification required)\b/.test(text) || /mp\.toutiao\.com\/profile_v4\/login/.test(text);
  }

  // webcli/scripts/opencli-wave4/upstream/toutiao/hot.js
  cli({
    site: "toutiao",
    name: "hot",
    access: "read",
    description: "\u4ECA\u65E5\u5934\u6761\u9996\u9875\u70ED\u699C\uFF08\u516C\u5F00 API\uFF0C\u65E0\u9700\u767B\u5F55\uFF09",
    domain: "www.toutiao.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "limit", type: "int", default: 30, help: "\u8FD4\u56DE\u6761\u6570 (1-50)" }
    ],
    columns: ["rank", "group_id", "title", "query", "hot_value", "label", "url", "image_url"],
    func: async (kwargs) => {
      const limit = parseHotLimit(kwargs?.limit, 30);
      let resp;
      try {
        resp = await fetch(HOT_BOARD_URL, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://www.toutiao.com/"
          }
        });
      } catch (error) {
        throw new CommandExecutionError(`toutiao hot-board request failed: ${error?.message || error}`);
      }
      if (!resp.ok) {
        throw new CommandExecutionError(`toutiao hot-board failed: HTTP ${resp.status}`);
      }
      let payload;
      try {
        payload = await resp.json();
      } catch (error) {
        throw new CommandExecutionError(`toutiao hot-board returned malformed JSON: ${error?.message || error}`);
      }
      if (payload?.status && payload.status !== "success") {
        throw new CommandExecutionError(`toutiao hot-board returned status=${payload.status}`);
      }
      if (payload?.error || payload?.message) {
        throw new CommandExecutionError(`toutiao hot-board returned error: ${payload.error || payload.message}`);
      }
      if (!Array.isArray(payload?.data)) throw new CommandExecutionError("Toutiao hot-board missing data array");
      const list = payload.data;
      const rows = list.map(mapHotRow).filter(Boolean).slice(0, limit);
      if (rows.length === 0) {
        throw new EmptyResultError("toutiao hot", "\u4E0A\u6E38 hot-board \u8FD4\u56DE\u7A7A\u5217\u8868\u3002");
      }
      return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
    }
  });

  // webcli/scripts/opencli-wave4/upstream/toutiao/recommend.js
  cli({
    site: "toutiao",
    name: "recommend",
    access: "read",
    description: "\u4ECA\u65E5\u5934\u6761\u9891\u9053\u63A8\u8350\u6D41\uFF08\u516C\u5F00 API\uFF0C\u65E0\u9700\u767B\u5F55\uFF09",
    domain: "www.toutiao.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "category", type: "string", default: "__all__", help: `\u9891\u9053 (${RECOMMEND_CATEGORIES.join(", ")})` },
      { name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u6761\u6570 (1-50)" }
    ],
    columns: ["rank", "group_id", "title", "abstract", "source", "tag", "comments", "published_at", "url", "image_url"],
    func: async (kwargs) => {
      const category = parseRecommendCategory(kwargs?.category, "__all__");
      const limit = parseRecommendLimit(kwargs?.limit, 20);
      const url = `${RECOMMEND_URL}?category=${encodeURIComponent(category)}`;
      let resp;
      try {
        resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "application/json",
            Referer: "https://www.toutiao.com/"
          }
        });
      } catch (error) {
        throw new CommandExecutionError(`toutiao recommend request failed: ${error?.message || error}`);
      }
      if (!resp.ok) {
        throw new CommandExecutionError(`toutiao recommend failed: HTTP ${resp.status}`);
      }
      let payload;
      try {
        payload = await resp.json();
      } catch (error) {
        throw new CommandExecutionError(`toutiao recommend returned malformed JSON: ${error?.message || error}`);
      }
      if (payload?.message && payload.message !== "success") {
        throw new CommandExecutionError(`toutiao recommend returned message=${payload.message}`);
      }
      if (!Array.isArray(payload?.data)) {
        throw new CommandExecutionError("toutiao recommend returned a non-array data field");
      }
      const rows = payload.data.map(mapRecommendRow).filter(Boolean).slice(0, limit);
      if (rows.length === 0) {
        throw new EmptyResultError("toutiao recommend", `\u9891\u9053 ${category} \u8FD4\u56DE\u7A7A\u5217\u8868\u3002`);
      }
      return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
    }
  });

  // webcli/scripts/opencli-wave4/upstream/toutiao/articles.js
  cli({
    site: "toutiao",
    name: "articles",
    access: "read",
    description: "\u83B7\u53D6\u5934\u6761\u53F7\u521B\u4F5C\u8005\u540E\u53F0\u6587\u7AE0\u5217\u8868\u53CA\u6570\u636E",
    domain: "mp.toutiao.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "page", type: "int", default: 1, help: "\u9875\u7801 (1-4)" }
    ],
    columns: ["title", "date", "status", "\u5C55\u73B0", "\u9605\u8BFB", "\u70B9\u8D5E", "\u8BC4\u8BBA"],
    func: async (page, kwargs) => {
      const articlePage = parseArticlesPage(kwargs.page, 1);
      let text;
      try {
        await page.goto(`https://mp.toutiao.com/profile_v4/manage/content/all?page=${articlePage}`);
        await page.wait("networkidle");
        await page.wait(3);
        text = await page.evaluate(`
(async () => {
    await new Promise(r => setTimeout(r, 2000));
    return document.body.innerText || '';
})()
`);
      } catch (error) {
        throw new CommandExecutionError(`toutiao articles render failed: ${error?.message || error}`);
      }
      if (looksToutiaoAuthWallText(text)) {
        throw new AuthRequiredError("mp.toutiao.com", "Toutiao creator articles require a logged-in mp.toutiao.com browser session");
      }
      const rows = parseToutiaoArticlesText(text);
      if (rows.length === 0) {
        throw new EmptyResultError(
          "toutiao articles",
          `\u672A\u6293\u53D6\u5230\u521B\u4F5C\u8005\u540E\u53F0\u6587\u7AE0 (page=${articlePage})\u3002\u53EF\u80FD\u9875\u9762\u5C1A\u672A\u5B8C\u6210\u6E32\u67D3\u6216\u65E0\u6587\u7AE0\u3002`
        );
      }
      return rows;
    }
  });

  // webcli/scripts/opencli-wave4/site-auth.js
  function registerSiteAuthCommands(config) {
    cli({
      site: config.site,
      name: "whoami",
      access: "read",
      browser: true,
      domain: "mp.toutiao.com",
      description: "\u9A8C\u8BC1\u5934\u6761\u53F7\u767B\u5F55\u8EAB\u4EFD",
      args: [],
      func: async (page) => ({ logged_in: true, site: config.site, ...await config.verify(page) })
    });
    cli({
      site: config.site,
      name: "login",
      access: "write",
      browser: true,
      domain: "mp.toutiao.com",
      description: "\u6253\u5F00\u5934\u6761\u53F7\u767B\u5F55\u9875\uFF1B\u4EBA\u5DE5\u5B8C\u6210\u540E\u8C03\u7528 whoami",
      args: [],
      func: async () => ({ __webcli_navigation: {
        version: 1,
        url: config.loginUrl,
        resume: false,
        result: { status: "login_required", executed: false, message: "\u8BF7\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u767B\u5F55\uFF0C\u518D\u8C03\u7528 whoami \u9A8C\u8BC1\u3002" }
      } })
    });
  }

  // webcli/scripts/opencli-wave4/upstream/toutiao/auth.js
  async function hasToutiaoSessionCookie(page) {
    const cookies = await page.getCookies({ url: "https://mp.toutiao.com" });
    return cookies.some((c) => c.name === "sessionid" && c.value);
  }
  async function verifyToutiaoIdentity(page) {
    if (!await hasToutiaoSessionCookie(page)) {
      throw new AuthRequiredError("toutiao.com", "Toutiao sessionid cookie missing");
    }
    await page.goto("https://mp.toutiao.com/");
    await page.wait(2);
    const probe = await page.evaluate(`
    (() => {
      if (/\\/auth\\/page\\/login/.test(location.href)) {
        return { kind: 'auth', detail: 'mp.toutiao.com redirected to /auth/page/login \u2014 anonymous' };
      }
      let userId = '', nickname = '';
      try {
        const seen = new Set();
        const stack = [window.__INITIAL_STATE__, window.__REDUX_STATE__, window.__SSR_DATA__].filter(Boolean);
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== 'object' || seen.has(node)) continue;
          seen.add(node);
          if (Array.isArray(node)) { stack.push(...node); continue; }
          const u = node.userInfo || node.user || node.currentUser || node.userBase;
          if (u && typeof u === 'object' && (u.user_id || u.userId || u.uid)) {
            userId = String(u.user_id || u.userId || u.uid || '');
            nickname = String(u.screen_name || u.name || u.nickname || u.user_name || '');
            break;
          }
          for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
        }
      } catch {}
      if (!userId) {
        const ssoUid = (document.cookie.split('; ').find(c => c.startsWith('sso_uid=')) || '').split('=')[1] || '';
        if (ssoUid) userId = ssoUid;
      }
      if (!nickname) {
        const el = document.querySelector('.user-name, .header-username, .avatar-name, [class*="userName"]');
        nickname = (el?.innerText || '').trim();
      }
      if (!userId) {
        return { kind: 'structure', detail: 'Toutiao dashboard identity fields were not recognized; login status is unknown' };
      }
      return { ok: true, user_id: userId, nickname };
    })()
  `);
    if (probe?.kind === "structure") throw new CommandExecutionError(probe.detail);
    if (probe?.kind === "auth") throw new AuthRequiredError("toutiao.com", probe.detail);
    if (!probe?.ok) throw new CommandExecutionError(`Unexpected Toutiao probe: ${JSON.stringify(probe)}`);
    return { user_id: probe.user_id, nickname: probe.nickname };
  }
  registerSiteAuthCommands({
    site: "toutiao",
    domain: "toutiao.com",
    loginUrl: "https://mp.toutiao.com/auth/page/login",
    columns: ["user_id", "nickname"],
    quickCheck: hasToutiaoSessionCookie,
    verify: verifyToutiaoIdentity,
    poll: async (page) => {
      if (!await hasToutiaoSessionCookie(page)) {
        throw new AuthRequiredError("toutiao.com", "Waiting for Toutiao sessionid cookie");
      }
      return verifyToutiaoIdentity(page);
    }
  });

  // webcli/scripts/opencli-wave4/toutiao-creator.js
  var STATUS = "/mp/agw/media/user_login_status_api";
  var IDENTITY = "/mp/agw/creator_center/user_info";
  async function readApi(page, path) {
    const result = await page.evaluate(`async () => {
    const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', redirect: 'error' });
    let data; try { data = await r.json(); } catch { return { status: r.status, malformed: true }; }
    return { status: r.status, data };
  }`);
    if ([401, 403].includes(result?.status)) throw new AuthRequiredError("mp.toutiao.com");
    if (result?.status !== 200 || result?.malformed || !result?.data || result.data.code !== 0) {
      throw new CommandExecutionError("Toutiao creator API rejected the request or returned an unknown response");
    }
    return result.data;
  }
  async function requireSession(page) {
    const status = await readApi(page, STATUS);
    if (status.data?.is_login === false) throw new AuthRequiredError("mp.toutiao.com");
    if (status.data?.is_login !== true) throw new CommandExecutionError("Toutiao login status field is missing or invalid");
  }
  async function identity(page) {
    await page.goto("https://mp.toutiao.com/");
    await requireSession(page);
    const data = await readApi(page, IDENTITY);
    const id = typeof data.user_id_str === "string" && /^\d+$/.test(data.user_id_str) ? data.user_id_str : Number.isSafeInteger(data.user_id) && data.user_id > 0 ? String(data.user_id) : null;
    if (!id || typeof data.name !== "string" || !data.name.trim()) throw new CommandExecutionError("Toutiao creator identity fields are missing or invalid");
    return { logged_in: true, site: "toutiao", user_id: id, nickname: data.name.trim() };
  }
  cli({
    site: "toutiao",
    name: "whoami",
    access: "read",
    browser: true,
    domain: "mp.toutiao.com",
    description: "\u901A\u8FC7\u5934\u6761\u53F7\u767B\u5F55\u72B6\u6001\u53CA\u7528\u6237\u63A5\u53E3\u9A8C\u8BC1\u5F53\u524D\u8EAB\u4EFD",
    args: [],
    func: identity
  });
  cli({
    site: "toutiao",
    name: "articles",
    access: "read",
    browser: true,
    domain: "mp.toutiao.com",
    description: "\u8BFB\u53D6\u5934\u6761\u53F7\u521B\u4F5C\u8005\u540E\u53F0\u6587\u7AE0\u5217\u8868\u53CA\u6307\u6807",
    args: [{ name: "page", type: "int", default: 1, help: "\u9875\u7801 (1-4)" }],
    func: async (page, args) => {
      const number = parseArticlesPage(args.page, 1);
      await page.goto(`https://mp.toutiao.com/profile_v4/manage/content/all?page=${number}`);
      await requireSession(page);
      for (let attempt = 0; attempt < 5; attempt++) {
        const probe = await page.evaluate(`() => {
        const list = document.querySelector('.all-content-list');
        const empty = list?.querySelector('.byte-empty');
        const emptyText = empty?.querySelector('.byte-empty-description')?.textContent?.replace(/\\s+/g, '') || '';
        const loading = !!list?.querySelector('[aria-busy="true"], .byte-spin-loading');
        const children = list ? [...list.children] : [];
        return { list: !!list, loading, text: list?.innerText || '',
          explicitEmpty: !!empty && children.length === 1 && children[0] === empty && /^\u6682\u65E0\u4F5C\u54C1[\uFF0C,]\u8D76\u7D27\u53BB\u521B\u4F5C\u5427(?:\u5F00\u59CB\u521B\u4F5C)?$/.test(emptyText) };
      }`);
        if (probe?.list && !probe.loading) {
          if (probe.explicitEmpty) return [];
          const rows = parseToutiaoArticlesText(probe.text);
          if (rows.length) return rows;
        }
        if (attempt < 4) await page.wait(1);
      }
      throw new CommandExecutionError("Toutiao article list has no recognized rows or verified empty state; inspect the page before retrying");
    }
  });

  // webcli/scripts/opencli-wave4/runtime.js
  var domains = { toutiao: ["www.toutiao.com", "mp.toutiao.com"], smzdm: ["search.smzdm.com"] };
  var helper = (action, payload) => window.__webmcpWecliRuntime.requestPrivileged(action, payload);
  var Page = class {
    constructor(command) {
      this.command = command;
      this.pending = null;
    }
    async goto(raw) {
      const target = new URL(raw), current = new URL(location.href);
      if (target.protocol !== "https:" || target.username || target.password || target.port || !domains[this.command.site]?.includes(target.hostname)) throw new ArgumentError("Untrusted navigation target");
      if (current.hostname === target.hostname && /\/auth\/page\/login|\/passport\//.test(current.pathname)) throw new AuthRequiredError(target.hostname);
      const markerKey = "__ww_wave4_navigation";
      if (current.origin === target.origin && current.pathname === target.pathname && [...target.searchParams].every(([k, v]) => current.searchParams.get(k) === v)) {
        sessionStorage.removeItem(markerKey);
        return;
      }
      if (this.command.name === "whoami" && current.hostname === "mp.toutiao.com" && current.pathname.startsWith("/profile_v4/")) return;
      let previous;
      try {
        previous = JSON.parse(sessionStorage.getItem(markerKey));
      } catch {
      }
      if (previous?.url === target.href && Date.now() - previous.at < 105e3) throw new CommandExecutionError("Site redirected the requested page; check login or site verification");
      sessionStorage.setItem(markerKey, JSON.stringify({ url: target.href, at: Date.now() }));
      this.pending = { __webcli_navigation: { version: 1, url: target.href, resume: this.command.access !== "write" } };
      throw new CommandExecutionError("Navigation required");
    }
    async evaluate(source) {
      if (this.pending) throw new CommandExecutionError("Navigation required");
      const expression = `(async () => { const result = (${source}); return typeof result === 'function' ? await result() : await result; })()`;
      const result = await helper("main_world_eval", { expression });
      if (!result || !Object.hasOwn(result, "value")) throw new CommandExecutionError("Missing page evaluation result");
      return result.value;
    }
    async wait(value) {
      if (typeof value === "number") await new Promise((resolve) => setTimeout(resolve, Math.min(value, 3) * 1e3));
    }
    async getCookies(options) {
      const result = await helper("cookies_get", options);
      return Array.isArray(result) ? result : result?.cookies || [];
    }
  };
  function normalize(command, input) {
    const args = { ...input };
    for (const spec of command.args || []) {
      let value = args[spec.name];
      if (value === void 0) value = spec.default;
      if (value === void 0) {
        if (spec.required) throw new ArgumentError(`${spec.name} is required`);
        continue;
      }
      if (spec.type === "int") {
        if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
        if (!Number.isSafeInteger(value) || value < 1) throw new ArgumentError(`${spec.name} must be a positive integer`);
      } else if (typeof value !== "string" || !value.trim() || value.length > 2e3) throw new ArgumentError(`${spec.name} must be a non-empty string of at most 2000 characters`);
      args[spec.name] = value;
    }
    if (command.site === "arxiv" && command.name === "paper" && !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/.test(args.id)) throw new ArgumentError("Invalid arXiv paper ID");
    if (command.site === "arxiv" && command.name === "author" && /["\\\r\n]/.test(args.author)) throw new ArgumentError("Author must be a name, without query operators or quotes");
    return args;
  }
  async function invoke(key, input = {}) {
    const command = commands.get(key);
    if (!command) throw new ArgumentError("Unknown command");
    const args = normalize(command, input), page = new Page(command);
    try {
      return command.browser === false ? await command.func(args) : await command.func(page, args);
    } catch (error) {
      if (page.pending) return page.pending;
      throw error;
    }
  }
  return __toCommonJS(stdin_exports);
})();

window.__wave4 = __wave4;
