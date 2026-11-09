/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2: restricted fetch, bounded navigation continuation, declarative pipeline executor, validated inputs and explicit parse failures.
 * Rebuild: node webcli/scripts/opencli-wave5/build.mjs */
var __wave5 = (() => {
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

  // webcli/scripts/opencli-wave5/errors.js
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

  // webcli/scripts/opencli-wave5/fetch.js
  var endpoints = /* @__PURE__ */ new Map([
    ["www.v2ex.com", {
      exact: /* @__PURE__ */ new Set([
        "/api/topics/hot.json",
        "/api/topics/latest.json",
        "/api/topics/show.json",
        "/api/members/show.json",
        "/api/nodes/all.json",
        "/api/replies/show.json"
      ])
    }],
    ["so.gitee.com", { exact: /* @__PURE__ */ new Set(["/v1/search/widget/wong1slagnlmzwvsu5ya"]) }],
    ["gitee.com", { prefix: ["/api/v5/users/"] }],
    ["weread.qq.com", { prefix: ["/web/"] }],
    ["i.weread.qq.com", { prefix: ["/book/", "/user/", "/review/", "/shelf/"] }]
  ]);
  function allowed(url) {
    const rule = endpoints.get(url.hostname);
    if (!rule) return false;
    if (rule.exact?.has(url.pathname)) return true;
    if (rule.prefix?.some((prefix) => url.pathname.startsWith(prefix))) return true;
    return false;
  }
  async function fetch(raw, options = {}) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed(url)) {
      throw new CommandExecutionError("Request is outside the fixed source API endpoints");
    }
    if (options.method && String(options.method).toUpperCase() !== "GET") {
      throw new CommandExecutionError("Only GET requests are allowed");
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
          headers: { Accept: "application/json", ...options.headers }
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

  // webcli/scripts/opencli-wave5/registry.js
  var commands = /* @__PURE__ */ new Map();
  var Strategy = { PUBLIC: "public", COOKIE: "cookie", UI: "ui", INTERCEPT: "intercept" };
  function cli(command) {
    commands.set(`${command.site}/${command.name}`, command);
    return command;
  }

  // webcli/scripts/opencli-wave5/site-auth.js
  function registerSiteAuthCommands(config) {
    if (!config?.site || !config?.domain || !config?.loginUrl || typeof config.verify !== "function") {
      throw new Error("registerSiteAuthCommands requires site, domain, loginUrl, and verify(page)");
    }
    const identityColumns = config.columns ?? ["id", "username", "name"];
    cli({
      site: config.site,
      name: "whoami",
      access: "read",
      description: config.whoamiDescription ?? `Show the current logged-in ${config.site} account`,
      domain: config.domain,
      strategy: Strategy.COOKIE,
      browser: true,
      navigateBefore: false,
      siteSession: "persistent",
      args: [],
      columns: ["logged_in", "site", ...identityColumns],
      func: async (page) => ({ logged_in: true, site: config.site, ...await config.verify(page) })
    });
    cli({
      site: config.site,
      name: "login",
      access: "write",
      description: config.loginDescription ?? `Open the ${config.site} login page; finish signing in on the page, then verify with whoami`,
      domain: config.domain,
      strategy: Strategy.COOKIE,
      browser: true,
      navigateBefore: false,
      defaultWindowMode: "foreground",
      siteSession: "persistent",
      args: [],
      columns: ["status", "logged_in", "site", ...identityColumns],
      func: async () => ({
        __webcli_navigation: {
          version: 1,
          url: config.loginUrl,
          resume: false,
          result: {
            status: "login_required",
            executed: false,
            message: "\u8BF7\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u767B\u5F55\uFF0C\u7136\u540E\u8C03\u7528 whoami \u9A8C\u8BC1\u8EAB\u4EFD\u3002"
          }
        }
      })
    });
  }

  // webcli/scripts/opencli-wave5/upstream/weibo/utils.js
  function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
      return payload.data;
    }
    return payload;
  }
  function requireArrayEvaluateResult(payload, label) {
    if (!Array.isArray(payload)) {
      if (payload && typeof payload === "object" && "error" in payload) {
        throw new CommandExecutionError(`${label}: ${String(payload.error)}`);
      }
      throw new CommandExecutionError(`${label} returned malformed extraction payload`);
    }
    return payload;
  }
  function requireObjectEvaluateResult(payload, label) {
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new CommandExecutionError(`${label} returned malformed extraction payload`);
    }
    return payload;
  }
  async function getSelfUid(page) {
    const uid = unwrapEvaluateResult(await page.evaluate(`
    (() => {
      const app = document.querySelector('#app')?.__vue_app__;
      const vueStore = app?.['con' + 'fig']?.globalProperties?.$store;
      const uid = vueStore?.state?.['con' + 'fig']?.['con' + 'fig']?.uid;
      if (uid) return String(uid);
      return null;
    })()
  `));
    if (uid)
      return uid;
    const config = unwrapEvaluateResult(await page.evaluate(`
    (async () => {
      const resp = await fetch('/ajax/config/get_config', {credentials: 'include'});
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.ok && data.data?.uid ? String(data.data.uid) : null;
    })()
  `));
    if (config)
      return config;
    throw new AuthRequiredError("weibo.com");
  }

  // webcli/scripts/opencli-wave5/upstream/weibo/auth.js
  async function hasWeiboSessionCookie(page) {
    const cookies = await page.getCookies({ url: "https://weibo.com" });
    const names = new Set(cookies.map((c) => c.name));
    return names.has("SUB") && names.has("SUBP");
  }
  function buildWeiboIdentityProbe(uid) {
    const infoUrl = "/ajax/profile/info?uid=" + encodeURIComponent(uid);
    return `(async () => {
    try {
      const res = await fetch(${JSON.stringify(infoUrl)}, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        return { kind: 'auth', detail: 'Weibo /ajax/profile/info HTTP ' + res.status };
      }
      if (!res.ok) return { kind: 'http', httpStatus: res.status };
      const d = await res.json();
      const user = d && d.data && d.data.user;
      if (!user || !user.id) {
        return { kind: 'auth', detail: 'Weibo /ajax/profile/info returned no user \u2014 anonymous' };
      }
      return { ok: true, user_id: String(user.id), screen_name: String(user.screen_name || ''), profile_url: String(user.profile_url || '') };
    } catch (e) {
      return { kind: 'exception', detail: String(e && e.message || e) };
    }
  })()`;
  }
  async function verifyWeiboIdentity(page) {
    if (!await hasWeiboSessionCookie(page)) {
      throw new AuthRequiredError("weibo.com", "Weibo SUB / SUBP cookies missing");
    }
    await page.goto("https://weibo.com/");
    await page.wait(3);
    const uid = await getSelfUid(page);
    if (typeof uid !== "string" || !uid.trim()) {
      throw new CommandExecutionError("Weibo uid resolver returned a malformed uid");
    }
    const result = unwrapEvaluateResult(await page.evaluate(buildWeiboIdentityProbe(uid)));
    if (result?.kind === "auth") throw new AuthRequiredError("weibo.com", result.detail);
    if (result?.kind === "http") throw new CommandExecutionError(`HTTP ${result.httpStatus} from /ajax/profile/info`);
    if (result?.kind === "exception") throw new CommandExecutionError(`Weibo whoami failed: ${result.detail}`);
    if (!result || Array.isArray(result) || typeof result !== "object") {
      throw new CommandExecutionError("Weibo whoami returned malformed probe payload");
    }
    if (!result?.ok) throw new CommandExecutionError(`Unexpected Weibo probe: ${JSON.stringify(result)}`);
    if (!result.user_id) throw new CommandExecutionError("Weibo whoami returned no user id");
    return { user_id: result.user_id, screen_name: result.screen_name, profile_url: result.profile_url };
  }
  registerSiteAuthCommands({
    site: "weibo",
    domain: "weibo.com",
    loginUrl: "https://weibo.com/login",
    columns: ["user_id", "screen_name", "profile_url"],
    quickCheck: hasWeiboSessionCookie,
    verify: verifyWeiboIdentity,
    poll: async (page) => {
      if (!await hasWeiboSessionCookie(page)) {
        throw new AuthRequiredError("weibo.com", "Waiting for Weibo SUB / SUBP cookies");
      }
      return verifyWeiboIdentity(page);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/comments.js
  cli({
    site: "weibo",
    name: "comments",
    access: "read",
    description: "Get comments on a Weibo post",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "id", required: true, positional: true, help: "Post ID (numeric idstr)" },
      { name: "limit", type: "int", default: 20, help: "Number of comments (max 50)" }
    ],
    columns: ["rank", "author", "text", "likes", "replies", "time"],
    func: async (page, kwargs) => {
      const count = Math.min(kwargs.limit || 20, 50);
      await page.goto("https://weibo.com");
      await page.wait(2);
      const id = String(kwargs.id);
      const data = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const count = ${count};
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

        const url = '/ajax/statuses/buildComments?flow=0&is_reload=1&id=' + id + '&is_show_bulletin=2&is_mix=0&count=' + count;
        const resp = await fetch(url, {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const data = await resp.json();
        if (!data.ok) return {error: 'API error: ' + (data.msg || 'unknown')};

        return (data.data || []).map((c, i) => {
          const item = {
            rank: i + 1,
            author: c.user?.screen_name || '',
            author_uid: c.user?.idstr || (typeof c.user?.id === 'string' || Number.isSafeInteger(c.user?.id) ? String(c.user.id) : null),
            text: strip(c.text || ''),
            likes: c.like_count || 0,
            replies: c.total_number || 0,
            time: c.created_at || '',
          };
          if (c.reply_comment) {
            item.reply_to = (c.reply_comment.user?.screen_name || '') + ': ' + strip(c.reply_comment.text || '').substring(0, 80);
          }
          return item;
        });
      })()
    `)), "weibo comments");
      return data;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/delete.js
  var WEIBO_HOST_RE = /(^|\.)weibo\.(com|cn)$/i;
  var POST_ID_RE = /^[A-Za-z0-9]{4,32}$/;
  function normalizePostId(raw) {
    const input = String(raw ?? "").trim();
    if (!input) {
      throw new ArgumentError("weibo delete: id cannot be empty");
    }
    let candidate = input;
    try {
      const url = new URL(input);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ArgumentError("weibo delete: URL must use http or https");
      }
      if (!WEIBO_HOST_RE.test(url.hostname)) {
        throw new ArgumentError("weibo delete: URL must be a weibo.com or weibo.cn post URL");
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.hostname.toLowerCase().endsWith("weibo.cn") && parts[0] === "status") {
        candidate = parts[1] ?? "";
      } else {
        candidate = parts.at(-1) ?? "";
      }
    } catch (error) {
      if (error instanceof ArgumentError) throw error;
    }
    candidate = String(candidate ?? "").trim();
    if (!POST_ID_RE.test(candidate)) {
      throw new ArgumentError("weibo delete: id must be a numeric idstr, mblogid, or Weibo post URL");
    }
    return candidate;
  }
  cli({
    site: "weibo",
    name: "delete",
    access: "write",
    description: "Delete one of my Weibo posts by id",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      {
        name: "id",
        required: true,
        positional: true,
        help: "Post ID (numeric idstr or mblogid from URL / weibo me / weibo post output)"
      }
    ],
    columns: ["status", "id", "mblogid"],
    func: async (page, kwargs) => {
      if (!page) {
        throw new CommandExecutionError("Browser session required for weibo delete");
      }
      const raw = String(kwargs.id ?? "").trim();
      const id = normalizePostId(raw);
      await page.goto("https://weibo.com");
      await page.wait(2);
      const result = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const input = ${JSON.stringify(id)};
        const readCookie = (name) => {
          const pair = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
          return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
        };
        // Step 1: resolve mblogid / idstr to canonical idstr via /show.
        const showResp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(input), { credentials: 'include' });
        if (showResp.status === 401 || showResp.status === 403) {
          return { ok: false, error: 'auth', status: showResp.status };
        }
        // 404 from /show means the post does not exist (deleted, wrong id, or
        // not owned by the logged-in user); map to the same path as a 2xx
        // response with no idstr so the caller throws EmptyResultError
        // instead of a generic CommandExecutionError("HTTP 404").
        if (showResp.status === 404) {
          return { ok: false, error: 'not_found', input };
        }
        if (!showResp.ok) {
          return { ok: false, error: 'show_http', status: showResp.status };
        }
        const showBody = await showResp.json();
        if (!showBody || !showBody.idstr) {
          return { ok: false, error: 'not_found', input };
        }
        const idstr = String(showBody.idstr);
        const mblogid = showBody.mblogid || '';
        // Step 2: destroy. Weibo requires X-Xsrf-Token (double-submit CSRF token).
        const token = readCookie('XSRF-TOKEN');
        const destroyResp = await fetch('/ajax/statuses/destroy', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Xsrf-Token': token,
          },
          body: 'id=' + encodeURIComponent(idstr),
        });
        if (destroyResp.status === 401 || destroyResp.status === 403) {
          return { ok: false, error: 'auth', status: destroyResp.status };
        }
        if (!destroyResp.ok) {
          return { ok: false, error: 'destroy_http', status: destroyResp.status };
        }
        const destroyBody = await destroyResp.json();
        // Require an explicit success signal from the API: { ok: 1 }. A
        // missing / falsy body must not be silently treated as success.
        if (!destroyBody || typeof destroyBody !== 'object') {
          return { ok: false, error: 'api', msg: 'destroy returned malformed response', id: idstr };
        }
        if (destroyBody.ok !== 1) {
          return { ok: false, error: 'api', msg: destroyBody.msg || destroyBody.message || 'destroy returned non-ok', id: idstr };
        }
        // Step 3: postcondition evidence. A write command cannot report success
        // until the target no longer resolves after the delete API returns ok.
        const verifyResp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(idstr), { credentials: 'include' });
        if (verifyResp.status === 401 || verifyResp.status === 403) {
          return { ok: false, error: 'auth', status: verifyResp.status };
        }
        if (verifyResp.status === 404) {
          return { ok: true, id: idstr, mblogid };
        }
        if (!verifyResp.ok) {
          return { ok: false, error: 'verify_http', status: verifyResp.status, id: idstr };
        }
        let verifyBody = null;
        try {
          verifyBody = await verifyResp.json();
        } catch {
          return { ok: false, error: 'verify_malformed', msg: 'verify returned non-JSON response', id: idstr };
        }
        if (!verifyBody || typeof verifyBody !== 'object') {
          return { ok: false, error: 'verify_malformed', msg: 'verify returned malformed response', id: idstr };
        }
        if (String(verifyBody.idstr || '') === idstr) {
          return { ok: false, error: 'still_exists', id: idstr, mblogid: verifyBody.mblogid || mblogid };
        }
        if (!verifyBody.idstr || verifyBody.ok === 0) {
          return { ok: true, id: idstr, mblogid };
        }
        return { ok: false, error: 'verify_mismatch', msg: 'verify returned a different post id', id: idstr };
      })()
    `)), "weibo delete");
      if (result.error === "auth") {
        throw new AuthRequiredError("weibo.com", "Cookie \u5DF2\u8FC7\u671F\uFF01\u8BF7\u5728\u5F53\u524D Chrome \u6D4F\u89C8\u5668\u4E2D\u91CD\u65B0\u767B\u5F55 Weibo\u3002");
      }
      if (result.error === "not_found") {
        throw new EmptyResultError("weibo delete", `Post not found for id "${String(result.input ?? raw)}". Verify the post still exists and belongs to the logged-in account.`);
      }
      if (result.error === "show_http" || result.error === "destroy_http" || result.error === "verify_http") {
        throw new CommandExecutionError(`weibo delete: HTTP ${result.status}`);
      }
      if (result.error === "api" || result.error === "verify_malformed" || result.error === "verify_mismatch" || result.error === "still_exists") {
        throw new CommandExecutionError(`weibo delete: ${String(result.msg ?? result.error)}`);
      }
      if (!result.ok) {
        throw new CommandExecutionError("weibo delete returned an unexpected response");
      }
      return [{ status: "deleted", id: String(result.id ?? ""), mblogid: String(result.mblogid ?? "") }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/favorites.js
  var DEFAULT_LIMIT = 20;
  var MAX_LIMIT = 50;
  function parsePositiveInt(value, name, defaultValue) {
    const raw = value ?? defaultValue;
    const number = Number(raw);
    if (!Number.isInteger(number) || number <= 0) {
      throw new ArgumentError(`weibo favorites ${name} must be a positive integer`);
    }
    if (number > MAX_LIMIT) {
      throw new ArgumentError(`weibo favorites ${name} must be <= ${MAX_LIMIT}`);
    }
    return number;
  }
  function parseFavoriteCard(card, favUrl) {
    const raw = String(card?.text ?? "");
    const lines = raw.split("\n");
    let author = "";
    let time = "";
    let source = "";
    let content = "";
    let likes = "0";
    let comments = "0";
    let reposts = "0";
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === "\u6DFB\u52A0") continue;
      if (!time && /\d+小时前|\d+分钟前|\d+秒前|昨天|前天|\d{1,2}:\d{2}/.test(t)) {
        time = t;
        continue;
      }
      if (t.startsWith("\u6765\u81EA")) {
        source = t;
        continue;
      }
      if (content) {
        const n = Number.parseInt(t, 10);
        if (!Number.isNaN(n) && n > 0 && n < 1e6 && t === String(n)) {
          if (likes === "0") likes = t;
          else if (comments === "0") comments = t;
          else if (reposts === "0") reposts = t;
          continue;
        }
      }
      if (!author && t.length < 40) {
        author = t;
        continue;
      }
      if (!content && author) {
        content = t;
        continue;
      }
      if (content) content += ` ${t}`;
    }
    if (!content || !author) return null;
    return {
      author,
      text: content.substring(0, 300),
      time,
      source,
      likes,
      comments,
      reposts,
      url: card?.url || favUrl,
      post_key: String(card?.url || '').match(/^https:\/\/(?:www\.)?weibo\.com\/\d+\/([A-Za-z0-9]+)(?:[?#/]|$)/)?.[1] || null
    };
  }
  function dedupeFavorites(items, favUrl) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const item of items) {
      const key = item.url && item.url !== favUrl ? item.url : `${item.author}
${item.text}
${item.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }
  cli({
    site: "weibo",
    name: "favorites",
    access: "read",
    description: "\u6211\u7684\u5FAE\u535A\u6536\u85CF\u5217\u8868",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "limit", type: "int", default: 20, help: "\u6570\u91CF\uFF08\u6700\u591A50\uFF09" }
    ],
    columns: ["author", "text", "time", "source", "likes", "comments", "reposts", "url"],
    func: async (page, kwargs) => {
      const limit = parsePositiveInt(kwargs.limit, "limit", DEFAULT_LIMIT);
      const current = new URL(location.href);
      if (!['weibo.com', 'www.weibo.com'].includes(current.hostname) || !/^\/u\/page\/fav\/\d+\/?$/.test(current.pathname)) await page.goto("https://weibo.com");
      await page.wait(2);
      const uid = await getSelfUid(page);
      const favUrl = "https://www.weibo.com/u/page/fav/" + uid;
      await page.goto(favUrl);
      await page.wait(4);
      for (let i = 0; i < 3; i++) {
        await page.evaluate("() => window.scrollBy(0, 800)");
        await page.wait(1);
      }
      const rawData = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (() => {
        const scrollers = document.querySelectorAll('.wbpro-scroller-item, .vue-recycle-scroller__item-view');
        const out = [];
        for (const s of scrollers) {
          // Use textContent to preserve newlines, then split by 

          const bodyEl = s.querySelector('[class*="_body_"]') || s.querySelector('.wbpro-item-body') || s;
          // innerText preserves newlines between block elements (unlike textContent)
          const rawText = bodyEl.innerText || s.innerText || '';

          let postUrl = '';
          const anchors = s.querySelectorAll('a[href]');
          for (const a of anchors) {
            const m = String(a.href).match(/weibo\\.com\\/(\\d+)\\/([a-zA-Z0-9]+)/);
            if (m) { postUrl = 'https://weibo.com/' + m[1] + '/' + m[2]; break; }
          }

          if (rawText.length > 20) out.push({ text: rawText, url: postUrl });
          if (out.length >= ${limit}) break;
        }
        return out;
      })()
    `)), "weibo favorites");
      if (rawData.length === 0) {
        throw new EmptyResultError("weibo favorites", "No favorites were visible on the favorites page");
      }
      const items = rawData.map((card) => parseFavoriteCard(card, favUrl)).filter(Boolean);
      const uniqueItems = dedupeFavorites(items, favUrl);
      if (uniqueItems.length === 0) {
        throw new CommandExecutionError("Failed to parse visible Weibo favorites");
      }
      return uniqueItems.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/feed.js
  var TIMELINE_ENDPOINTS = {
    "for-you": "unreadfriendstimeline",
    following: "friendstimeline"
  };
  cli({
    site: "weibo",
    name: "feed",
    access: "read",
    description: "Fetch Weibo timeline (for-you or following)",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      {
        name: "type",
        default: "for-you",
        choices: ["for-you", "following"],
        help: "Timeline type: for-you (algorithmic) or following (chronological)"
      },
      { name: "limit", type: "int", default: 15, help: "Number of posts (max 50)" }
    ],
    columns: ["id", "author", "text", "reposts", "comments", "likes", "time", "url"],
    func: async (page, kwargs) => {
      const count = Math.min(kwargs.limit || 15, 50);
      const timelineType = kwargs.type === "following" ? "following" : "for-you";
      const endpoint = TIMELINE_ENDPOINTS[timelineType];
      await page.goto("https://weibo.com");
      await page.wait(2);
      const uid = await getSelfUid(page);
      const data = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const uid = ${JSON.stringify(uid)};
        const count = ${count};
        const endpoint = ${JSON.stringify(endpoint)};
        const listId = '10001' + uid;
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

        const resp = await fetch('/ajax/feed/' + endpoint + '?list_id=' + listId + '&refresh=4&since_id=0&count=' + count, { credentials: 'include' });
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const data = await resp.json();
        if (!data.ok) return { error: 'API error: ' + (data.msg || 'unknown') };

        return (data.statuses || []).slice(0, count).map(s => {
          const u = s.user || {};
          const item = {
            id: s.mblogid || s.idstr || (typeof s.id === 'string' || Number.isSafeInteger(s.id) ? String(s.id) : ''),
            post_id: s.idstr || (typeof s.id === 'string' || Number.isSafeInteger(s.id) ? String(s.id) : null),
            author_uid: u.idstr || (typeof u.id === 'string' || Number.isSafeInteger(u.id) ? String(u.id) : null),
            author: u.screen_name || '',
            text: (s.text_raw || strip(s.text || '')).substring(0, 200),
            reposts: s.reposts_count || 0,
            comments: s.comments_count || 0,
            likes: s.attitudes_count || 0,
            time: s.created_at || '',
            url: 'https://weibo.com/' + (u.id || '') + '/' + (s.mblogid || ''),
          };
          if (s.retweeted_status) {
            const rt = s.retweeted_status;
            item.retweeted = (rt.user?.screen_name || '[deleted]') + ': ' + (rt.text_raw || strip(rt.text || '')).substring(0, 100);
          }
          return item;
        });
      })()
    `)), "weibo feed");
      return data;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/hot.js
  cli({
    site: "weibo",
    name: "hot",
    access: "read",
    description: "\u5FAE\u535A\u70ED\u641C",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "limit", type: "int", default: 30, help: "Number of items (max 50)" }
    ],
    columns: ["rank", "word", "hot_value", "category", "label", "url"],
    func: async (page, kwargs) => {
      const count = Math.min(kwargs.limit || 30, 50);
      await page.goto("https://weibo.com");
      const data = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const resp = await fetch('/ajax/statuses/hot_band', {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const data = await resp.json();
        if (!data.ok) return {error: 'API error'};
        const bandList = data.data?.band_list || [];
        return bandList.map((item, i) => ({
          rank: item.realpos || (i + 1),
          word: item.word,
          hot_value: item.num || 0,
          category: item.category || '',
          label: item.label_name || '',
          url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + item.word + '#')
        }));
      })()
    `)), "weibo hot");
      return data.slice(0, count);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/me.js
  cli({
    site: "weibo",
    name: "me",
    access: "read",
    description: "My Weibo profile info",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [],
    columns: ["screen_name", "uid", "followers", "following", "statuses", "verified", "location"],
    func: async (page) => {
      await page.goto("https://weibo.com");
      await page.wait(2);
      const uid = await getSelfUid(page);
      const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const uid = ${JSON.stringify(uid)};

        // Try Vue store first
        const app = document.querySelector('#app')?.__vue_app__;
        const vueStore = app?.['con' + 'fig']?.globalProperties?.$store;
        const cfg = vueStore?.state?.['con' + 'fig']?.['con' + 'fig'];
        const u = cfg?.user;

        // Fetch detail info
        const detailResp = await fetch('/ajax/profile/detail?uid=' + uid, {credentials: 'include'});
        const detail = detailResp.ok ? await detailResp.json() : null;
        const d = detail?.data || {};

        if (u && u.id) {
          return {
            screen_name: u.screen_name,
            uid: u.idstr || (typeof u.id === 'string' || Number.isSafeInteger(u.id) ? String(u.id) : null),
            followers: u.followers_count,
            following: u.friends_count,
            statuses: u.statuses_count,
            verified: u.verified || false,
            location: u.location || '',
            description: u.description || d.description || '',
            avatar: u.avatar_hd || u.avatar_large || '',
            profile_url: 'https://weibo.com' + (u.profile_url || '/u/' + u.id),
          };
        }

        // Fallback: fetch profile API
        const resp = await fetch('/ajax/profile/info?uid=' + uid, {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const info = await resp.json();
        if (!info.ok) return {error: 'API error'};
        const p = info.data?.user;
        if (!p) return {error: 'User data not found'};
        return {
          screen_name: p.screen_name,
          uid: p.idstr || (typeof p.id === 'string' || Number.isSafeInteger(p.id) ? String(p.id) : null),
          followers: p.followers_count,
          following: p.friends_count,
          statuses: p.statuses_count,
          verified: p.verified || false,
          location: p.location || '',
          description: p.description || d.description || '',
          avatar: p.avatar_hd || p.avatar_large || '',
          profile_url: 'https://weibo.com' + (p.profile_url || '/u/' + p.id),
        };
      })()
    `)), "weibo me");
      if (data.error)
        throw new CommandExecutionError(String(data.error));
      return data;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/post.js
  cli({
    site: "weibo",
    name: "post",
    access: "read",
    description: "Get a single Weibo post",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "id", required: true, positional: true, help: "Post ID (numeric idstr or mblogid from URL)" }
    ],
    columns: ["id", "author", "text", "comments", "likes", "url"],
    func: async (page, kwargs) => {
      await page.goto("https://weibo.com");
      await page.wait(2);
      const id = String(kwargs.id);
      const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const s = await resp.json();
        if (!s.ok && !s.idstr) return {error: 'Post not found'};
        const postId = s.idstr || (typeof s.id === 'string' || Number.isSafeInteger(s.id) ? String(s.id) : '');
        if (!postId || !/^[0-9]+$/.test(postId)) return {error: 'Post returned no exact numeric identity'};

        // Fetch long text if needed
        let fullText = s.text_raw || strip(s.text || '');
        if (s.isLongText || s.is_long_text) {
          try {
            const ltResp = await fetch('/ajax/statuses/longtext?id=' + s.idstr, {credentials: 'include'});
            if (ltResp.ok) {
              const lt = await ltResp.json();
              if (lt.data?.longTextContent) fullText = strip(lt.data.longTextContent);
            }
          } catch {}
        }

        const u = s.user || {};
        const result = {
          id: postId,
          mblogid: s.mblogid,
          author: u.screen_name || '',
          author_uid: u.idstr || (typeof u.id === 'string' || Number.isSafeInteger(u.id) ? String(u.id) : null),
          text: fullText,
          created_at: s.created_at,
          source: strip(s.source || ''),
          reposts: s.reposts_count || 0,
          comments: s.comments_count || 0,
          likes: s.attitudes_count || 0,
          pic_count: s.pic_num || 0,
          url: 'https://weibo.com/' + (u.id || '') + '/' + (s.mblogid || ''),
        };

        if (s.retweeted_status) {
          const rt = s.retweeted_status;
          result.retweeted_from = (rt.user?.screen_name || '[deleted]');
          result.retweeted_text = rt.text_raw || strip(rt.text || '');
        }

        return result;
      })()
    `)), "weibo post");
      if (data.error)
        throw new CommandExecutionError(String(data.error));
      return [data];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/publish.js
  var COMPOSE_POLL_MS = 300;
  var COMPOSE_TIMEOUT_MS = 1e4;
  var SUBMIT_POLL_MS = 500;
  var SUBMIT_TIMEOUT_MS = 2e4;
  var TEXTAREA_SELECTORS = [
    'textarea[placeholder*="\u6709\u4EC0\u4E48\u65B0\u9C9C\u4E8B"]',
    'textarea[placeholder*="\u65B0\u9C9C\u4E8B"]',
    "textarea._input_13iqr_8"
  ];
  function validateText(text) {
    const t = String(text ?? "").trim();
    if (!t) throw new ArgumentError("weibo publish text cannot be empty");
    if (t.length > 2e3) throw new ArgumentError("weibo publish text exceeds 2000 characters");
    return t;
  }
  cli({
    site: "weibo",
    name: "publish",
    access: "write",
    description: "Publish a new Weibo post immediately (text only)",
    domain: "weibo.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      {
        name: "text",
        type: "string",
        required: true,
        positional: true,
        help: "Weibo text content (max 2000 chars)"
      }
    ],
    columns: ["status", "message", "text"],
    func: async (page, kwargs) => {
      if (!page) throw new CommandExecutionError("Browser session required for weibo publish");
      const text = validateText(kwargs.text);
      await page.goto("https://weibo.com", { waitUntil: "load", settleMs: 2e3 });
      await page.wait({ time: 2 });
      try {
        await getSelfUid(page);
      } catch (err) {
        if (err instanceof AuthRequiredError) throw err;
        throw new CommandExecutionError("Not logged into Weibo. Please login at weibo.com in your Chrome browser.");
      }
      const clickResult = await page.evaluate(`
            () => {
                const visible = el => !!el && el.offsetParent !== null && !el.disabled;
                const buttons = document.querySelectorAll('button[title="\u53D1\u5FAE\u535A"], button[title="\u5199\u5FAE\u535A"]');
                for (const btn of buttons) {
                    if (visible(btn)) {
                        btn.click();
                        return { ok: true };
                    }
                }
                return { ok: false, message: 'Could not find \u53D1\u5FAE\u535A button' };
            }
        `);
      if (!clickResult?.ok) {
        throw new CommandExecutionError(clickResult?.message ?? "Could not open compose editor.");
      }
      let editorFound = false;
      for (let i = 0; i < Math.ceil(COMPOSE_TIMEOUT_MS / COMPOSE_POLL_MS); i++) {
        const result = await page.evaluate(`
                (selectors => {
                    // Pick the LAST visible match across all selectors so
                    // the modal (rendered on top of the home-feed strip)
                    // wins over earlier matches. See TEXTAREA_SELECTORS.
                    let last = null;
                    for (const sel of selectors) {
                        for (const t of document.querySelectorAll(sel)) {
                            if (t.offsetParent !== null) last = t;
                        }
                    }
                    if (!last) return { found: false };
                    return { found: true, visible: true, rectTop: last.getBoundingClientRect().top };
                })(${JSON.stringify(TEXTAREA_SELECTORS)})
            `);
        if (result?.found && result.visible && result.rectTop >= 0) {
          editorFound = true;
          break;
        }
        await page.wait({ time: COMPOSE_POLL_MS / 1e3 });
      }
      if (!editorFound) {
        throw new CommandExecutionError("Weibo compose editor did not appear");
      }
      const insertResult = await page.evaluateWithArgs(`
            ((selectors) => {
                let ta = null;
                for (const sel of selectors) {
                    for (const t of document.querySelectorAll(sel)) {
                        if (t.offsetParent !== null) ta = t;
                    }
                }
                if (!ta) return { ok: false, message: 'textarea not visible' };
                ta.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (nativeSetter) {
                    nativeSetter.call(ta, textContent);
                } else {
                    ta.value = textContent;
                }
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, valueLength: ta.value.length };
            })(${JSON.stringify(TEXTAREA_SELECTORS)})
        `, { textContent: text });
      if (!insertResult?.ok) {
        throw new CommandExecutionError(insertResult?.message ?? "Could not insert text.");
      }
      await page.wait({ time: 0.5 });
      const publishResult = await page.evaluate(`
            () => {
                const visible = el => !!el && el.offsetParent !== null && !el.disabled;
                const labels = ['\u53D1\u9001', '\u53D1\u5E03'];
                for (const label of labels) {
                    const allBtns = document.querySelectorAll('button, [role="button"]');
                    for (const btn of allBtns) {
                        const t = (btn.innerText || btn.textContent || '').trim();
                        if (t === label && visible(btn)) {
                            btn.click();
                            return { ok: true, label };
                        }
                    }
                }
                return { ok: false, message: 'Could not find send button' };
            }
        `);
      if (!publishResult?.ok) {
        throw new CommandExecutionError(publishResult?.message ?? "Could not click publish.");
      }
      let finalResult = null;
      for (let i = 0; i < Math.ceil(SUBMIT_TIMEOUT_MS / SUBMIT_POLL_MS); i++) {
        await page.wait({ time: SUBMIT_POLL_MS / 1e3 });
        finalResult = await page.evaluate(`
                (() => {
                    const successMarkers = ['\u53D1\u5E03\u6210\u529F', '\u5DF2\u53D1\u5E03', '\u53D1\u9001\u6210\u529F'];
                    const errorMarkers = ['\u53D1\u5E03\u5931\u8D25', '\u53D1\u9001\u5931\u8D25', '\u5185\u5BB9\u8FDD\u89C4', '\u8BF7\u7A0D\u540E\u518D\u8BD5', '\u9891\u7E41'];
                    for (const el of document.querySelectorAll('*')) {
                        if (el.children.length > 3) continue;
                        const txt = (el.innerText || '').trim();
                        if (!txt || txt.length > 100) continue;
                        for (const m of successMarkers) {
                            if (txt.includes(m) && (txt.includes('\u6210\u529F') || txt.includes('\u5FAE\u535A'))) {
                                return { ok: true, message: txt };
                            }
                        }
                        for (const m of errorMarkers) {
                            if (txt.includes(m)) {
                                return { ok: false, message: txt };
                            }
                        }
                    }
                    return null;
                })()
            `);
        if (finalResult !== null) break;
      }
      if (!finalResult) {
        throw new CommandExecutionError("Publish button clicked but result was unclear. Check Weibo manually.");
      }
      if (!finalResult.ok) {
        throw new CommandExecutionError(finalResult.message || "Weibo publish failed");
      }
      return [{
        status: "success",
        message: finalResult.message || "Published successfully",
        text
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/search.js
  cli({
    site: "weibo",
    name: "search",
    access: "read",
    description: "\u641C\u7D22\u5FAE\u535A",
    domain: "weibo.com",
    browser: true,
    strategy: Strategy.COOKIE,
    args: [
      { name: "keyword", required: true, positional: true, help: "Search keyword" },
      { name: "limit", type: "int", default: 10, help: "Number of results (max 50)" }
    ],
    columns: ["rank", "id", "title", "author", "time", "url"],
    func: async (page, kwargs) => {
      const limit = Math.max(1, Math.min(Number(kwargs.limit) || 10, 50));
      const keyword = encodeURIComponent(String(kwargs.keyword ?? "").trim());
      await page.goto(`https://s.weibo.com/weibo?q=${keyword}`);
      await page.wait(2);
      const extracted = unwrapEvaluateResult(await page.evaluate(`
      (() => {
        const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const pageText = clean(document.body && document.body.innerText);
        const title = clean(document.title);
        if (/Sina Visitor System/i.test(title) || /访客|验证|登录|visitor/i.test(pageText)) {
          return { error: 'auth', detail: 'Weibo search requires login or visitor verification' };
        }
        const absoluteUrl = (href) => {
          if (!href) return '';
          if (href.startsWith('http://') || href.startsWith('https://')) return href;
          if (href.startsWith('//')) return window.location.protocol + href;
          if (href.startsWith('/')) return window.location.origin + href;
          return href;
        };

        const cards = Array.from(document.querySelectorAll('.card-wrap'));
        const rows = [];

        for (const card of cards) {
          const contentEl =
            card.querySelector('[node-type="feed_list_content_full"]') ||
            card.querySelector('[node-type="feed_list_content"]') ||
            card.querySelector('.txt');
          const authorEl =
            card.querySelector('.info .name') ||
            card.querySelector('.name');
          const timeEl = card.querySelector('.from a');
          const urlEl =
            card.querySelector('.from a[href*="/detail/"]') ||
            card.querySelector('.from a[href*="/status/"]') ||
            timeEl;
          const url = absoluteUrl(urlEl && urlEl.getAttribute('href'));
          const idMatch =
            url.match(/^https?:\\/\\/(?:www\\.)?weibo\\.com\\/\\d+\\/([A-Za-z0-9]+)(?:[?#/]|$)/) ||
            url.match(/^https?:\\/\\/(?:www\\.)?weibo\\.com\\/(?:detail|status)\\/([A-Za-z0-9]+)(?:[?#/]|$)/);

          const title = clean(contentEl && contentEl.textContent);
          if (!title) continue;

          rows.push({
            id: idMatch ? idMatch[1] : '',
            title,
            author: clean(authorEl && authorEl.textContent),
            time: clean(timeEl && timeEl.textContent),
            url,
          });
        }

        return rows;
      })()
    `));
      if (extracted && !Array.isArray(extracted) && extracted.error === "auth") {
        throw new AuthRequiredError("weibo.com", extracted.detail || "Weibo search requires login or visitor verification");
      }
      const data = requireArrayEvaluateResult(extracted, "weibo search");
      if (data.length === 0) {
        throw new CliError("NOT_FOUND", "No Weibo search results found", "Try a different keyword or ensure you are logged into weibo.com");
      }
      return data.slice(0, limit).map((item, index) => ({
        rank: index + 1,
        ...item
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/user.js
  cli({
    site: "weibo",
    name: "user",
    access: "read",
    description: "Get Weibo user profile",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "id", required: true, positional: true, help: "User ID (numeric uid) or screen name" }
    ],
    columns: ["screen_name", "uid", "followers", "following", "statuses", "verified", "description", "location", "url"],
    func: async (page, kwargs) => {
      await page.goto("https://weibo.com");
      await page.wait(2);
      const id = String(kwargs.id);
      const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const isUid = /^\\d+$/.test(id);
        const query = isUid ? 'uid=' + id : 'screen_name=' + encodeURIComponent(id);

        const resp = await fetch('/ajax/profile/info?' + query, {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const data = await resp.json();
        if (!data.ok || !data.data?.user) return {error: 'User not found'};

        const u = data.data.user;

        // Fetch detail info
        const detailResp = await fetch('/ajax/profile/detail?uid=' + u.id, {credentials: 'include'});
        const detail = detailResp.ok ? await detailResp.json() : null;
        const d = detail?.data || {};

        return {
          screen_name: u.screen_name,
          uid: u.idstr || (typeof u.id === 'string' || Number.isSafeInteger(u.id) ? String(u.id) : null),
          followers: u.followers_count,
          following: u.friends_count,
          statuses: u.statuses_count,
          verified: u.verified || false,
          verified_reason: u.verified_reason || '',
          description: u.description || d.description || '',
          location: u.location || '',
          gender: u.gender === 'm' ? 'male' : u.gender === 'f' ? 'female' : '',
          avatar: u.avatar_hd || u.avatar_large || '',
          url: 'https://weibo.com' + (u.profile_url || '/u/' + u.id),
          birthday: d.birthday || '',
          created_at: d.created_at || '',
          ip_location: d.ip_location || '',
        };
      })()
    `)), "weibo user");
      if (data.error)
        throw new CommandExecutionError(String(data.error));
      return data;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weibo/user-posts.js
  var MAX_LIMIT2 = 100;
  var DEFAULT_LIMIT2 = 20;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function readRequiredId(raw) {
    const value = String(raw ?? "").trim();
    if (!value) {
      throw new ArgumentError("weibo user-posts id cannot be empty");
    }
    return value;
  }
  function readLimit(raw) {
    const value = raw === void 0 || raw === null || raw === "" ? DEFAULT_LIMIT2 : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT2) {
      throw new ArgumentError(`weibo user-posts limit must be an integer between 1 and ${MAX_LIMIT2}`);
    }
    return value;
  }
  function readDate(raw, name) {
    if (raw === void 0 || raw === null || raw === "") return null;
    const value = String(raw).trim();
    if (!DATE_RE.test(value)) {
      throw new ArgumentError(`weibo user-posts ${name} must use YYYY-MM-DD`);
    }
    const date = /* @__PURE__ */ new Date(`${value}T00:00:00+08:00`);
    if (!Number.isFinite(date.getTime()) || value !== formatShanghaiDate(date)) {
      throw new ArgumentError(`weibo user-posts ${name} must be a valid calendar date`);
    }
    return value;
  }
  function formatShanghaiDate(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function dateToTimestamp(date) {
    return Math.floor((/* @__PURE__ */ new Date(`${date}T00:00:00+08:00`)).getTime() / 1e3);
  }
  function validateRange(start, end) {
    if (start && end && dateToTimestamp(start) > dateToTimestamp(end)) {
      throw new ArgumentError("weibo user-posts start must be <= end");
    }
  }
  function mapError(error) {
    const message = String(error ?? "").trim();
    if (!message) {
      throw new CommandExecutionError("weibo user-posts failed without an error message");
    }
    if (/login|cookie|登录|auth|forbidden|permission|权限|unauthorized/i.test(message)) {
      throw new AuthRequiredError("weibo.com", message);
    }
    throw new CommandExecutionError(message);
  }
  cli({
    site: "weibo",
    name: "user-posts",
    access: "read",
    description: "List Weibo posts from a user, optionally filtered by date range",
    domain: "weibo.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "id", positional: true, required: true, help: "User ID (numeric uid) or screen name" },
      { name: "start", help: "Start date in Asia/Shanghai (YYYY-MM-DD)" },
      { name: "end", help: "End date in Asia/Shanghai (YYYY-MM-DD)" },
      { name: "limit", type: "int", default: DEFAULT_LIMIT2, help: `Number of posts (1-${MAX_LIMIT2})` },
      { name: "include-retweets", type: "boolean", default: false, help: "Include retweets" }
    ],
    columns: ["rank", "id", "mblogid", "author", "uid", "text", "time", "reposts", "comments", "likes", "pic_count", "url"],
    func: async (page, kwargs) => {
      const id = readRequiredId(kwargs.id);
      const limit = readLimit(kwargs.limit);
      const start = readDate(kwargs.start, "start");
      const end = readDate(kwargs.end, "end");
      validateRange(start, end);
      const includeRetweets = Boolean(kwargs["include-retweets"]);
      const starttime = start ? dateToTimestamp(start) : null;
      const endtime = end ? dateToTimestamp(end) + 24 * 60 * 60 - 1 : null;
      await page.goto("https://weibo.com");
      await page.wait(2);
      const evaluateResult = await page.evaluate(`
      (async () => {
        const rawId = ${JSON.stringify(id)};
        const limit = ${limit};
        const includeRetweets = ${includeRetweets};
        const starttime = ${starttime === null ? "null" : starttime};
        const endtime = ${endtime === null ? "null" : endtime};
        const strip = (html) => (html || '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/\\s+/g, ' ')
          .trim();

        async function readJson(url) {
          const resp = await fetch(url, { credentials: 'include' });
          if (resp.status === 401 || resp.status === 403) {
            return { error: 'login required: HTTP ' + resp.status };
          }
          if (!resp.ok) {
            return { error: 'HTTP ' + resp.status };
          }
          try {
            return await resp.json();
          } catch {
            return { error: 'Malformed JSON response' };
          }
        }

        let uid = rawId;
        if (!/^\\d+$/.test(rawId)) {
          const profile = await readJson('/ajax/profile/info?screen_name=' + encodeURIComponent(rawId));
          if (profile.error) return profile;
          if (!profile.ok || !profile.data?.user?.id) return [rawId, [], true, false];
          uid = String(profile.data.user.id);
        }

        const rows = [];
        let sawList = false;
        let sawPostCandidates = false;
        for (let page = 1; page <= 20 && rows.length < limit; page++) {
          const qs = new URLSearchParams();
          qs.set('uid', uid);
          qs.set('page', String(page));
          qs.set('hasori', '1');
          qs.set('hasret', includeRetweets ? '1' : '0');
          if (starttime !== null) qs.set('starttime', String(starttime));
          if (endtime !== null) qs.set('endtime', String(endtime));

          const data = await readJson('/ajax/statuses/searchProfile?' + qs.toString());
          if (data.error) return data;
          if (data.ok === false) {
            return { error: 'Weibo user posts API error: ' + (data.msg || data.message || 'request failed') };
          }
          const list = data.data?.list;
          if (!Array.isArray(list)) {
            return { error: 'Weibo user posts response did not include data.list' };
          }
          sawList = true;
          if (list.length > 0) sawPostCandidates = true;
          if (list.length === 0) break;

          for (const post of list) {
            if (rows.length >= limit) break;
            const postId = post.idstr || (post.id === undefined || post.id === null ? '' : String(post.id));
            const mblogid = post.mblogid || '';
            const user = post.user || {};
            const text = post.text_raw || strip(post.text || '');
            if (!postId || !mblogid || !text) continue;
            rows.push({
              id: postId,
              mblogid,
              author: user.screen_name || '',
              uid: user.id === undefined || user.id === null ? uid : String(user.id),
              text,
              time: post.created_at || '',
              reposts: post.reposts_count ?? 0,
              comments: post.comments_count ?? 0,
              likes: post.attitudes_count ?? 0,
              pic_count: post.pic_num ?? Object.keys(post.pic_infos || {}).length,
              url: 'https://weibo.com/' + (user.id || uid) + '/' + mblogid,
            });
          }

          if (list.length < 10) break;
        }

        return [uid, rows, sawList, sawPostCandidates];
      })()
    `);
      const payload = unwrapEvaluateResult(evaluateResult);
      if (payload && !Array.isArray(payload) && typeof payload === "object" && "error" in payload) {
        mapError(payload.error);
      }
      if (!Array.isArray(payload) || payload.length !== 4 || !Array.isArray(payload[1])) {
        throw new CommandExecutionError("weibo user-posts returned malformed extraction payload");
      }
      const [resolvedUid, rows, sawList, sawPostCandidates] = payload;
      if (!sawList && rows.length === 0) {
        throw new CommandExecutionError("weibo user-posts did not observe a valid posts list");
      }
      if (sawPostCandidates && rows.length === 0) {
        throw new CommandExecutionError("weibo user-posts found post candidates but could not extract valid rows");
      }
      if (rows.length === 0) {
        throw new EmptyResultError("weibo user-posts", "No Weibo posts found for this user/date range");
      }
      return rows.slice(0, limit).map((row, index) => ({
        rank: index + 1,
        id: String(row.id),
        mblogid: row.mblogid || "",
        author: row.author || "",
        uid: String(row.uid || resolvedUid || ""),
        text: row.text || "",
        time: row.time || "",
        reposts: row.reposts ?? 0,
        comments: row.comments ?? 0,
        likes: row.likes ?? 0,
        pic_count: row.pic_count ?? 0,
        url: row.url || ""
      }));
    }
  });

  // webcli/scripts/opencli-wave5/runtime.js
  var domains = {
    v2ex: ["www.v2ex.com", "v2ex.com"],
    gitee: ["gitee.com", "www.gitee.com"],
    tieba: ["tieba.baidu.com"],
    weread: ["weread.qq.com", "i.weread.qq.com", "www.weread.qq.com"],
    xueqiu: ["xueqiu.com", "www.xueqiu.com", "stock.xueqiu.com", "danjuanfunds.com", "www.danjuanfunds.com"],
    weibo: ["weibo.com", "www.weibo.com", "s.weibo.com", "passport.weibo.com", "login.sina.com.cn"],
    "1688": ["1688.com", "www.1688.com", "login.1688.com", "detail.1688.com", "winport.m.1688.com", "s.1688.com"],
    xianyu: ["goofish.com", "www.goofish.com"],
    twitter: ["x.com", "www.x.com"]
  };
  var domainSuffix = { "1688": ".1688.com" };
  var helper = (action, payload) => window.__webmcpWecliRuntime.requestPrivileged(action, payload);
  var Page = class {
    constructor(command) {
      this.command = command;
      this.pending = null;
      this.capturePattern = null;
      this.consumedEntries = 0;
    }
    async goto(raw) {
      const target = new URL(raw), current = new URL(location.href);
      const hostAllowed = domains[this.command.site]?.includes(target.hostname) || domainSuffix[this.command.site] && target.hostname.endsWith(domainSuffix[this.command.site]) && target.hostname !== domainSuffix[this.command.site].slice(1);
      const currentHostAllowed = domains[this.command.site]?.includes(current.hostname) || domainSuffix[this.command.site] && current.hostname.endsWith(domainSuffix[this.command.site]) && current.hostname !== domainSuffix[this.command.site].slice(1);
      if (target.protocol !== "https:" || target.username || target.password || target.port || !hostAllowed) throw new ArgumentError("Untrusted navigation target");
      const markerKey = "__ww_wave5_navigation";
      if (current.origin === target.origin && current.pathname === target.pathname && [...target.searchParams].every(([k, v]) => current.searchParams.get(k) === v)) {
        sessionStorage.removeItem(markerKey);
        return;
      }
      let previous;
      try {
        previous = JSON.parse(sessionStorage.getItem(markerKey));
      } catch {
      }
      if (previous?.url === target.href && Date.now() - previous.at < 105e3) {
        if (current.protocol === "https:" && currentHostAllowed) {
          sessionStorage.removeItem(markerKey);
          return;
        }
        throw new CommandExecutionError("Site redirected the requested page; check login or site verification");
      }
      sessionStorage.setItem(markerKey, JSON.stringify({ url: target.href, at: Date.now() }));
      // A page evaluation may already have written; only untouched invocations can promise preparation.
      this.pending = { __webcli_navigation: { version: 1, url: target.href, resume: this.command.access !== "write",
        ...(this.command.access === "write" && !this.pageEvaluated ? { phase: "prepare", result: { status: "prepared", executed: false } } : {}) } };
      throw new CommandExecutionError("Navigation required");
    }
    async evaluate(source) {
      if (this.pending) throw new CommandExecutionError("Navigation required");
      this.pageEvaluated = true;
      const expression = `(async () => { const result = (${source}); return typeof result === 'function' ? await result() : await result; })()`;
      const result = await helper("main_world_eval", { expression });
      if (!result || !Object.hasOwn(result, "value")) throw new CommandExecutionError("Missing page evaluation result");
      return result.value;
    }
    async evaluateWithArgs(source, args = {}) {
      if (this.pending) throw new CommandExecutionError("Navigation required");
      this.pageEvaluated = true;
      const bindings = Object.entries(args).map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`).join("");
      const expression = `(async () => { ${bindings} const result = (${source}); return typeof result === 'function' ? await result() : await result; })()`;
      const result = await helper("main_world_eval", { expression });
      if (!result || !Object.hasOwn(result, "value")) throw new CommandExecutionError("Missing page evaluation result");
      return result.value;
    }
    async sleep(seconds) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(seconds) || 0, 0), 10) * 1e3));
    }
    async wait(value) {
      if (typeof value === "number") return this.sleep(Math.min(value, 3));
      if (value && typeof value === "object") {
        if (typeof value.time === "number") return this.sleep(Math.min(value.time, 3));
        const selector = value.selector;
        if (typeof selector === "string" && selector) {
          const budgetMs = Math.min(Math.max(Number(value.timeout) || 10, 1), 30) * 1e3;
          const deadline = Date.now() + budgetMs;
          for (; ; ) {
            const found = await this.evaluate(`() => Boolean(document.querySelector(${JSON.stringify(selector)}))`);
            if (found) return;
            if (Date.now() >= deadline) throw new CommandExecutionError(`Timed out waiting for selector ${selector}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
    }
    async getCookies(options) {
      const result = await helper("cookies_get", options);
      return Array.isArray(result) ? result : result?.cookies || [];
    }
    async autoScroll(options = {}) {
      const times = Math.min(Math.max(Number(options.times) || 1, 1), 20);
      const delayMs = Math.min(Math.max(Number(options.delayMs) || 500, 100), 5e3);
      for (let i = 0; i < times; i++) {
        await this.evaluate("() => { window.scrollTo(0, document.body.scrollHeight); }");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    async nativeClick(x, y) {
      const px = Number(x), py = Number(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) throw new ArgumentError("nativeClick requires numeric coordinates");
      const clicked = await this.evaluate(`() => { const el = document.elementFromPoint(${px}, ${py}); if (!el) return false; el.click(); return true; }`);
      if (!clicked) throw new CommandExecutionError("nativeClick target element not found");
    }
    async nativeType(selector, text) {
      if (typeof selector !== "string" || !selector) throw new ArgumentError("nativeType selector is required");
      const payload = JSON.stringify(String(text ?? ""));
      const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${payload}); else el.value = ${payload};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
      if (!ok) throw new CommandExecutionError("nativeType target element not found");
    }
    async insertText(text) {
      const ok = await this.evaluate(`() => document.execCommand('insertText', false, ${JSON.stringify(String(text ?? ""))})`);
      if (!ok) throw new CommandExecutionError("insertText was not applied");
    }
    async installInterceptor(pattern) {
      if (typeof pattern !== "string" || !pattern || pattern.length > 256) throw new ArgumentError("interceptor pattern is required");
      this.capturePattern = pattern;
      this.consumedEntries = 0;
      await helper("network_capture_start", { pattern });
    }
    async waitForCapture(seconds) {
      if (!this.capturePattern) throw new CommandExecutionError("Network interceptor is not installed");
      const deadline = Date.now() + Math.min(Math.max(Number(seconds) || 5, 1), 20) * 1e3;
      for (; ; ) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new CommandExecutionError("Timed out waiting for network capture");
        const result = await helper("network_capture_read", { waitMs: Math.min(remaining, 2e4), finish: false });
        const entries = Array.isArray(result?.entries) ? result.entries : [];
        if (entries.length > this.consumedEntries) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    async getInterceptedRequests() {
      if (!this.capturePattern) throw new CommandExecutionError("Network interceptor is not installed");
      const result = await helper("network_capture_read", { waitMs: 0, finish: false });
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      const fresh = entries.slice(this.consumedEntries);
      this.consumedEntries = entries.length;
      const requests = [];
      for (const entry of fresh) {
        const body = entry?.responsePreview;
        if (typeof body !== "string" || !body) continue;
        let data = null;
        try {
          data = JSON.parse(body);
        } catch {
          continue;
        }
        requests.push({ url: entry?.url || "", data });
      }
      return requests;
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
        const zeroAllowed = value === 0 && spec.default === 0;
        if (!Number.isSafeInteger(value) || value < 0 || value < 1 && !zeroAllowed) throw new ArgumentError(`${spec.name} must be a positive integer`);
      } else if (spec.type === "float") {
        if (typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value.trim())) value = Number(value.trim());
        if (!Number.isFinite(value) || value <= 0) throw new ArgumentError(`${spec.name} must be a positive number`);
      } else if (spec.type === "bool" || spec.type === "boolean") {
        if (typeof value === "string") value = value === "true" || value === "1";
        value = Boolean(value);
      } else {
        if (typeof value === "number") value = String(value);
        const emptyAllowed = value === "" && spec.default === "";
        if (typeof value !== "string" || !value.trim() && !emptyAllowed || value.length > 2e3) throw new ArgumentError(`${spec.name} must be a non-empty string of at most 2000 characters`);
      }
      args[spec.name] = value;
    }
    if (command.site === "v2ex") {
      if (args.limit !== void 0 && args.limit > 100) throw new ArgumentError("limit must be at most 100");
      if ((command.name === "topic" || command.name === "replies") && !/^\d{1,12}$/.test(String(args.id))) throw new ArgumentError("id must be a numeric V2EX topic ID");
      if ((command.name === "member" || command.name === "user") && !/^[A-Za-z0-9_.-]{1,32}$/.test(String(args.username))) throw new ArgumentError("Invalid V2EX username");
      if (command.name === "node" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(args.name))) throw new ArgumentError("Invalid V2EX node name");
    }
    return args;
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function resolvePath(pathStr, ctx) {
    const parts = pathStr.split(".");
    let obj, rest;
    if (parts[0] === "args") {
      obj = ctx.args;
      rest = parts.slice(1);
    } else if (parts[0] === "item") {
      obj = ctx.item;
      rest = parts.slice(1);
    } else if (parts[0] === "index") return ctx.index;
    else {
      obj = ctx.item;
      rest = parts;
    }
    for (const part of rest) {
      if (isRecord(obj)) obj = obj[part];
      else if (Array.isArray(obj) && /^\d+$/.test(part)) obj = obj[parseInt(part, 10)];
      else return null;
    }
    return obj;
  }
  function evalExpr(raw, template, ctx) {
    const expr = raw.trim();
    if (/^\d+$/.test(expr)) return Number(expr);
    const strLit = expr.match(/^(['"])(.*)\1$/);
    if (strLit) return strLit[2];
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/.test(expr)) return resolvePath(expr, ctx);
    const arithmetic = expr.match(/^index\s*([+\-*])\s*(\d+)$/);
    if (arithmetic) {
      const n = Number(arithmetic[2]);
      if (arithmetic[1] === "+") return ctx.index + n;
      if (arithmetic[1] === "-") return ctx.index - n;
      return ctx.index * n;
    }
    throw new CommandExecutionError(`Unsupported pipeline expression: ${template}`);
  }
  function render(template, ctx) {
    if (typeof template !== "string") return template;
    const full = template.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
    if (full && !full[1].includes("${{")) return evalExpr(full[1], template, ctx);
    if (!template.includes("${{")) return template;
    return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_m, expr) => String(evalExpr(expr, template, ctx)));
  }
  var PIPELINE_EXPECTS = {
    hot: { list: true },
    latest: { list: true },
    nodes: { list: true },
    node: { list: true },
    replies: { list: true },
    user: { list: true },
    topic: { list: false, requireField: "id" },
    member: { list: false, requireField: "username" }
  };
  async function pipelineFetch(stageParams, args, command) {
    const rawUrl = String(stageParams?.url || "");
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ArgumentError("pipeline url is invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== "www.v2ex.com") {
      throw new ArgumentError("pipeline url must be a plain https URL on www.v2ex.com");
    }
    for (const [key, template] of Object.entries(stageParams?.params || {})) {
      const value = render(template, { args, item: null, index: 0 });
      if (value === null || value === void 0) throw new CommandExecutionError(`Pipeline parameter ${key} did not resolve`);
      url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetch(url.href);
    } catch (error) {
      if (error && typeof error.code === "string") throw error;
      throw new CommandExecutionError(`V2EX API request failed: ${url.pathname}`);
    }
    if (!response || !response.ok) throw new CommandExecutionError(`V2EX API responded with HTTP ${response?.status ?? "unknown"}`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CommandExecutionError("V2EX API did not return a JSON document");
    }
    if (payload === null || typeof payload !== "object") throw new CommandExecutionError("V2EX API did not return a JSON document");
    const expect = PIPELINE_EXPECTS[command.name];
    if (!expect) throw new CommandExecutionError("Command pipeline is not configured");
    if (payload.status === "error") {
      const detail = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim().slice(0, 200) : "The V2EX API reported no matching object";
      throw new EmptyResultError(command.name, detail);
    }
    if (Array.isArray(payload)) return payload;
    if (!isRecord(payload)) throw new CommandExecutionError("V2EX API returned an unexpected document shape");
    if (expect.list) throw new CommandExecutionError("V2EX API returned an object where a topic list was expected");
    return payload;
  }
  function pipelineMap(stageParams, data, args) {
    if (data === null || typeof data !== "object") return data;
    const items = Array.isArray(data) ? data : [data];
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const row = {};
      for (const [key, template] of Object.entries(stageParams)) {
        const value = render(template, { args, item: items[i], index: i });
        row[key] = value === void 0 ? null : value;
      }
      rows.push(row);
    }
    return rows;
  }
  function pipelineSort(stageParams, data) {
    if (!Array.isArray(data)) return data;
    const key = String(stageParams?.by ?? "");
    if (!key) throw new CommandExecutionError("sort.by is required");
    const reverse = stageParams?.order === "desc";
    return [...data].sort((a, b) => {
      const left = isRecord(a) ? a[key] : void 0;
      const right = isRecord(b) ? b[key] : void 0;
      const cmp = String(left ?? "").localeCompare(String(right ?? ""), void 0, { numeric: true });
      return reverse ? -cmp : cmp;
    });
  }
  function pipelineLimit(stageParams, data, args) {
    if (!Array.isArray(data)) return data;
    const size = Number(render(stageParams, { args, item: null, index: 0 }));
    if (!Number.isSafeInteger(size) || size < 1) throw new CommandExecutionError("pipeline limit did not resolve to a positive integer");
    return data.slice(0, size);
  }
  async function runPipeline(command, args) {
    const stages = Array.isArray(command.pipeline) ? command.pipeline : [];
    if (!stages.length) throw new CommandExecutionError(`Command ${command.name} has no pipeline`);
    let data = null;
    let fetched = false;
    for (const stage of stages) {
      if (!isRecord(stage)) throw new CommandExecutionError("Invalid pipeline stage");
      for (const [op, params] of Object.entries(stage)) {
        if (op === "fetch") {
          if (fetched) throw new CommandExecutionError("Pipeline fetch must run exactly once");
          fetched = true;
          data = await pipelineFetch(params, args, command);
        } else if (op === "map") data = pipelineMap(params, data, args);
        else if (op === "sort") data = pipelineSort(params, data);
        else if (op === "limit") data = pipelineLimit(params, data, args);
        else throw new CommandExecutionError(`Unsupported pipeline step: ${op}`);
      }
    }
    if (!fetched) throw new CommandExecutionError("Pipeline did not fetch any data");
    if (!Array.isArray(data)) throw new CommandExecutionError("V2EX API did not produce a row list");
    if (data.length === 0) throw new EmptyResultError(command.name, "The V2EX API returned no matching entries");
    const expect = PIPELINE_EXPECTS[command.name];
    if (expect?.requireField) {
      const value = data[0]?.[expect.requireField];
      if (value === null || value === void 0 || value === "") {
        throw new CommandExecutionError(`V2EX API document is missing the ${expect.requireField} field`);
      }
    }
    return data;
  }
  async function invoke(key, input = {}) {
    const command = commands.get(key);
    if (!command) throw new ArgumentError("Unknown command");
    const args = normalize(command, input);
    if (command.pipeline) return runPipeline(command, args);
    const page = new Page(command);
    try {
      if (command.browser !== false && typeof command.navigateBefore === "string") await page.goto(command.navigateBefore);
      const result = command.browser === false ? await command.func(args) : await command.func(page, args);
      if (command.site === 'weibo' && Array.isArray(result)) return result.map(row => ({ ...row,
        context_title: Array.from(String(row.title || row.text || row.author || row.id || '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('') }));
      return result;
    } catch (error) {
      if (page.pending) return page.pending;
      throw error;
    }
  }
  return __toCommonJS(stdin_exports);
})();

window.__wave5 = __wave5;
