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
  async function restrictedFetch(raw, options = {}) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed(url)) {
      throw new CommandExecutionError("Request is outside the fixed source API endpoints");
    }
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      throw new CommandExecutionError("Only GET and POST requests are allowed");
    }
    if (method === "POST" && url.hostname !== WEREAD_DOMAIN) {
      throw new CommandExecutionError("POST requests are only allowed for fixed WeRead web API endpoints");
    }
    let response;
    try {
      response = await window.__webmcpWecliRuntime.requestPrivileged("backend_fetch", {
        url: url.href,
        browserFallback: false,
        redactBodyInTrace: true,
        options: {
          method,
          redirect: "manual",
          maxResponseBytes: 4 * 1024 * 1024,
          headers: { Accept: "application/json", ...options.headers },
          ...options.body === void 0 ? {} : { body: options.body }
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
  var fetch = restrictedFetch;

  // webcli/scripts/opencli-wave5/registry.js
  var commands = /* @__PURE__ */ new Map();
  var Strategy = { PUBLIC: "public", COOKIE: "cookie", UI: "ui", INTERCEPT: "intercept" };
  function cli(command) {
    commands.set(`${command.site}/${command.name}`, command);
    return command;
  }

  // webcli/scripts/opencli-wave5/upstream/weread/utils.js
  var WEREAD_DOMAIN = "weread.qq.com";
  var WEREAD_WEB_ORIGIN = `https://${WEREAD_DOMAIN}`;
  var WEREAD_SHELF_URL = `${WEREAD_WEB_ORIGIN}/web/shelf`;
  var WEB_API = `${WEREAD_WEB_ORIGIN}/web`;
  var API = `https://i.${WEREAD_DOMAIN}`;
  var WEREAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var WEREAD_AUTH_ERRCODES = /* @__PURE__ */ new Set([-2010, -2012]);
  function getWereadErrCode(data) {
    return Number(data?.errcode ?? data?.errCode);
  }
  function isAuthErrorResponse(resp, data) {
    return resp.status === 401 || WEREAD_AUTH_ERRCODES.has(getWereadErrCode(data));
  }
  function getCurrentVid(cookies) {
    return String(cookies.find((cookie) => cookie.name === "wr_vid")?.value || "").trim();
  }
  function getWebShelfStorageKeys(currentVid) {
    return {
      rawBooksKey: `shelf:rawBooks:${currentVid}`,
      shelfIndexesKey: `shelf:shelfIndexes:${currentVid}`
    };
  }
  function normalizeWebShelfSnapshot(value) {
    return {
      snapshotLoaded: value?.snapshotLoaded === true,
      rawBooks: Array.isArray(value?.rawBooks) ? value.rawBooks : [],
      shelfIndexes: Array.isArray(value?.shelfIndexes) ? value.shelfIndexes : []
    };
  }
  function buildShelfSnapshotPollScript(storageKeys, requireTrustedIndexes) {
    return `
    (() => new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const rawBooksKey = ${JSON.stringify(storageKeys.rawBooksKey)};
      const shelfIndexesKey = ${JSON.stringify(storageKeys.shelfIndexesKey)};
      const requireTrustedIndexes = ${JSON.stringify(requireTrustedIndexes)};

      const readJson = (raw) => {
        if (typeof raw !== 'string') return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };

      const collectBookIds = (items) => Array.isArray(items)
        ? Array.from(new Set(items.map((item) => String(item?.bookId || '').trim()).filter(Boolean)))
        : [];

      // Mirror of getTrustedIndexedBookIds in Node.js \u2014 keep in sync
      const hasTrustedIndexes = (rawBooks, shelfIndexes) => {
        const rawBookIds = collectBookIds(rawBooks);
        if (rawBookIds.length === 0) return false;

        const rawBookIdSet = new Set(rawBookIds);
        const projectedIndexedBookIds = Array.isArray(shelfIndexes)
          ? Array.from(new Set(
              shelfIndexes
                .filter((entry) => Number.isFinite(entry?.idx))
                .sort((left, right) => Number(left?.idx ?? Number.MAX_SAFE_INTEGER) - Number(right?.idx ?? Number.MAX_SAFE_INTEGER))
                .map((entry) => String(entry?.bookId || '').trim())
                .filter((bookId) => rawBookIdSet.has(bookId)),
            ))
          : [];

        return projectedIndexedBookIds.length === rawBookIds.length;
      };

      const poll = () => {
        const rawBooks = readJson(localStorage.getItem(rawBooksKey));
        const shelfIndexes = readJson(localStorage.getItem(shelfIndexesKey));
        const snapshotLoaded = Array.isArray(rawBooks);
        const ready = snapshotLoaded && (!requireTrustedIndexes || hasTrustedIndexes(rawBooks, shelfIndexes));

        if (ready || Date.now() >= deadline) {
          resolve({
            snapshotLoaded,
            rawBooks: Array.isArray(rawBooks) ? rawBooks : [],
            shelfIndexes: Array.isArray(shelfIndexes) ? shelfIndexes : [],
          });
          return;
        }

        setTimeout(poll, 100);
      };

      poll();
    }))
  `;
  }
  async function fetchWebApi(path, params) {
    const url = new URL(`${WEB_API}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    }
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
    }
    try {
      return await resp.json();
    } catch {
      throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
    }
  }
  async function fetchPrivateApi(page, path, params) {
    const url = new URL(`${API}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    }
    const urlStr = url.toString();
    let resp;
    try {
      resp = await fetch(urlStr);
    } catch (error) {
      throw new CliError("FETCH_ERROR", `Failed to fetch ${path}: ${error instanceof Error ? error.message : String(error)}`, "WeRead API may be temporarily unavailable");
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
    }
    if (isAuthErrorResponse(resp, data)) {
      throw new CliError("AUTH_REQUIRED", "Not logged in to WeRead", "Please log in to weread.qq.com in Chrome first");
    }
    if (!resp.ok) {
      throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
    }
    if (data?.errcode != null && data.errcode !== 0) {
      throw new CliError("API_ERROR", data.errmsg ?? `WeRead API error ${data.errcode}`);
    }
    return data;
  }
  function getUniqueRawBookIds(snapshot) {
    return Array.from(new Set(snapshot.rawBooks.map((book) => String(book?.bookId || "").trim()).filter(Boolean)));
  }
  function getTrustedIndexedBookIds(snapshot) {
    const rawBookIds = getUniqueRawBookIds(snapshot);
    if (rawBookIds.length === 0)
      return [];
    const rawBookIdSet = new Set(rawBookIds);
    const projectedIndexedBookIds = Array.from(new Set(snapshot.shelfIndexes.filter((entry) => Number.isFinite(entry?.idx)).sort((left, right) => Number(left?.idx ?? Number.MAX_SAFE_INTEGER) - Number(right?.idx ?? Number.MAX_SAFE_INTEGER)).map((entry) => String(entry?.bookId || "").trim()).filter((bookId) => rawBookIdSet.has(bookId))));
    return projectedIndexedBookIds.length === rawBookIds.length ? projectedIndexedBookIds : [];
  }
  function buildWebShelfEntries(snapshot, readerUrls = []) {
    const rawBookIds = getUniqueRawBookIds(snapshot);
    const trustedIndexedBookIds = getTrustedIndexedBookIds(snapshot);
    const orderedBookIds = trustedIndexedBookIds.length > 0 ? trustedIndexedBookIds : rawBookIds;
    const rawBookById = /* @__PURE__ */ new Map();
    for (const book of snapshot.rawBooks) {
      const bookId = String(book?.bookId || "").trim();
      if (!bookId || rawBookById.has(bookId))
        continue;
      rawBookById.set(bookId, book);
    }
    return orderedBookIds.map((bookId, index) => {
      const book = rawBookById.get(bookId);
      return {
        bookId,
        title: String(book?.title || "").trim(),
        author: String(book?.author || "").trim(),
        readerUrl: String(readerUrls[index] || "").trim()
      };
    });
  }
  async function loadWebShelfSnapshotWithVid(page) {
    await page.goto(WEREAD_SHELF_URL);
    const cookies = await page.getCookies({ domain: WEREAD_DOMAIN });
    const currentVid = getCurrentVid(cookies);
    if (!currentVid) {
      return { snapshot: { snapshotLoaded: false, rawBooks: [], shelfIndexes: [] }, currentVid: "" };
    }
    const result = await page.evaluate(buildShelfSnapshotPollScript(getWebShelfStorageKeys(currentVid), false));
    return {
      snapshot: normalizeWebShelfSnapshot(result),
      currentVid
    };
  }
  async function loadWebShelfSnapshot(page) {
    const { snapshot } = await loadWebShelfSnapshotWithVid(page);
    return snapshot;
  }
  async function waitForTrustedWebShelfSnapshot(page, snapshot, currentVid) {
    if (!snapshot.snapshotLoaded)
      return snapshot;
    if (getTrustedIndexedBookIds(snapshot).length > 0)
      return snapshot;
    if (!currentVid)
      return snapshot;
    const result = await page.evaluate(buildShelfSnapshotPollScript(getWebShelfStorageKeys(currentVid), true));
    return normalizeWebShelfSnapshot(result);
  }
  async function resolveShelfReader(page, bookId) {
    const { snapshot: initialSnapshot, currentVid } = await loadWebShelfSnapshotWithVid(page);
    const snapshot = await waitForTrustedWebShelfSnapshot(page, initialSnapshot, currentVid);
    if (!snapshot.snapshotLoaded) {
      return { snapshot, readerUrl: null };
    }
    const rawBookIds = getUniqueRawBookIds(snapshot);
    const trustedIndexedBookIds = getTrustedIndexedBookIds(snapshot);
    const canUseRawOrderFallback = trustedIndexedBookIds.length === 0 && rawBookIds.length > 0 && snapshot.shelfIndexes.length === 0;
    if (trustedIndexedBookIds.length === 0 && !canUseRawOrderFallback) {
      return { snapshot, readerUrl: null };
    }
    const readerUrls = await page.evaluate(`
    (() => Array.from(document.querySelectorAll('a.shelfBook[href]'))
      .map((anchor) => {
        const href = anchor.getAttribute('href') || '';
        return href ? new URL(href, location.origin).toString() : '';
      })
      .filter(Boolean))
  `);
    const expectedEntryCount = trustedIndexedBookIds.length > 0 ? trustedIndexedBookIds.length : rawBookIds.length;
    if (readerUrls.length !== expectedEntryCount) {
      return { snapshot, readerUrl: null };
    }
    const entries = buildWebShelfEntries(snapshot, readerUrls);
    const entry = entries.find((candidate) => candidate.bookId === bookId);
    return {
      snapshot,
      readerUrl: entry?.readerUrl || null
    };
  }
  function formatDate(ts) {
    if (!Number.isFinite(ts) || ts <= 0)
      return "-";
    const d = new Date(ts * 1e3 + 8 * 36e5);
    return d.toISOString().slice(0, 10);
  }

  // webcli/scripts/opencli-wave5/upstream/weread/ai-outline.js
  var WEB_API2 = `${WEREAD_WEB_ORIGIN}/web`;
  function buildCookieHeader(cookies) {
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  async function postWebApiWithCookies(page, path, body) {
    const url = `${WEB_API2}${path}`;
    const [apiCookies, domainCookies] = await Promise.all([
      page.getCookies({ url }),
      page.getCookies({ domain: WEREAD_DOMAIN })
    ]);
    const merged = /* @__PURE__ */ new Map();
    for (const c of domainCookies) merged.set(c.name, c);
    for (const c of apiCookies) merged.set(c.name, c);
    const cookieHeader = buildCookieHeader(Array.from(merged.values()));
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": WEREAD_UA,
        "Content-Type": "application/json",
        "Origin": WEREAD_WEB_ORIGIN,
        "Referer": `${WEREAD_WEB_ORIGIN}/`,
        ...cookieHeader ? { "Cookie": cookieHeader } : {}
      },
      body: JSON.stringify(body)
    });
    if (resp.status === 401) {
      throw new CliError("AUTH_REQUIRED", "Not logged in to WeRead", "Please log in to weread.qq.com in Chrome first");
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
    }
    if (WEREAD_AUTH_ERRCODES.has(getWereadErrCode(data))) {
      throw new CliError("AUTH_REQUIRED", "Not logged in to WeRead", "Please log in to weread.qq.com in Chrome first");
    }
    if (!resp.ok) {
      throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
    }
    return data;
  }
  async function postWebApi(path, body) {
    const url = `${WEB_API2}${path}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": WEREAD_UA,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
    }
    try {
      return await resp.json();
    } catch {
      throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
    }
  }
  cli({
    site: "weread",
    name: "ai-outline",
    access: "read",
    description: "Get AI-generated outline for a book",
    domain: "weread.qq.com",
    strategy: Strategy.COOKIE,
    defaultFormat: "plain",
    args: [
      { name: "book-id", positional: true, required: true, help: "Book ID (from shelf or search results)" },
      { name: "limit", type: "int", default: 200, help: "Max outline items to return" },
      { name: "depth", type: "int", default: 4, help: "Max outline depth (2=topics, 3=key points, 4=details)" },
      { name: "raw", type: "boolean", default: false, help: "Output structured rows (chapter/idx/level/text) for programmatic use" }
    ],
    columns: void 0,
    func: async (page, args) => {
      const bookId = String(args["book-id"] || "").trim();
      const rawMode = Boolean(args.raw);
      const chapterData = await postWebApiWithCookies(page, "/book/chapterInfos", {
        bookIds: [bookId],
        sinces: [0]
      });
      const chapters = chapterData?.data?.[0]?.updated ?? [];
      if (chapters.length === 0) {
        throw new CliError("NOT_FOUND", "No chapters found for this book", "Check that the book ID is correct");
      }
      const chapterUids = chapters.map((c) => c.chapterUid);
      const chapterNameMap = /* @__PURE__ */ new Map();
      for (const c of chapters) {
        chapterNameMap.set(c.chapterUid, c.title ?? "");
      }
      const outlineData = await postWebApi("/book/outline", {
        bookId,
        chapterUids
      });
      const itemsArray = outlineData?.itemsArray ?? [];
      const maxDepth = Number(args.depth);
      const rawRows = [];
      for (const entry of itemsArray) {
        const items = entry.items;
        if (!Array.isArray(items) || items.length === 0) continue;
        const chapterName = chapterNameMap.get(entry.chapterUid) ?? `Chapter ${entry.chapterUid}`;
        let lastL3Idx = "";
        let l4Counter = 0;
        for (const item of items) {
          const level = item.level ?? 1;
          if (level <= 1) continue;
          if (level > maxDepth) continue;
          let idx = item.uiIdx ?? "";
          if (level === 3 && idx) {
            lastL3Idx = idx;
            l4Counter = 0;
          }
          if (level === 4 && !idx && lastL3Idx) {
            l4Counter++;
            idx = `${lastL3Idx}.${l4Counter}`;
          }
          rawRows.push({ chapter: chapterName, idx, level, text: item.text ?? "" });
        }
      }
      if (rawRows.length === 0) {
        throw new CliError("NOT_FOUND", "No AI outline available for this book", "AI outlines may not be generated for all books");
      }
      if (rawMode) {
        return rawRows.slice(0, Number(args.limit));
      }
      const grouped = /* @__PURE__ */ new Map();
      for (const row of rawRows) {
        if (!grouped.has(row.chapter)) grouped.set(row.chapter, []);
        grouped.get(row.chapter).push(row);
      }
      const results = [];
      for (const [chapter, rows] of grouped) {
        const lines = [`\u{1F4D6} ${chapter}`];
        for (const row of rows) {
          const indent = "  ".repeat(row.level - 2);
          const prefix = row.level === 2 ? `${row.idx}. ` : `${row.idx} `;
          lines.push(`${indent}${prefix}${row.text}`);
        }
        results.push({ outline: lines.join("\n") });
      }
      return results.slice(0, Number(args.limit));
    }
  });

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

  // webcli/scripts/opencli-wave5/upstream/weread/auth.js
  async function hasWereadSessionCookie(page) {
    const cookies = await page.getCookies({ url: "https://weread.qq.com" });
    return cookies.some((c) => c.name === "wr_vid" && c.value);
  }
  async function verifyWereadIdentity(page) {
    if (!await hasWereadSessionCookie(page)) {
      throw new AuthRequiredError("weread.qq.com", "WeRead wr_vid cookie missing");
    }
    await page.goto("https://weread.qq.com/");
    await page.wait(2);
    const result = await page.evaluate(`(async () => {
    try {
      const wrVid = (document.cookie.split('; ').find(c => c.startsWith('wr_vid=')) || '').split('=')[1] || '';
      if (!wrVid) {
        return { kind: 'auth', detail: 'WeRead wr_vid cookie absent in document.cookie' };
      }
      const res = await fetch('/web/user', { credentials: 'include', headers: { 'Accept': 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        return { kind: 'auth', detail: 'WeRead /web/user HTTP ' + res.status };
      }
      if (!res.ok) return { kind: 'http', httpStatus: res.status };
      const d = await res.json();
      if (d && d.errCode && d.errCode !== 0) {
        return { kind: 'auth', detail: 'WeRead /web/user errCode=' + d.errCode };
      }
      return {
        ok: true,
        user_id: String(d.userVid || wrVid),
        name: String(d.name || d.nickName || ''),
      };
    } catch (e) {
      return { kind: 'exception', detail: String(e && e.message || e) };
    }
  })()`);
    if (result?.kind === "auth") throw new AuthRequiredError("weread.qq.com", result.detail);
    if (result?.kind === "http") throw new CommandExecutionError(`HTTP ${result.httpStatus} from /web/user`);
    if (result?.kind === "exception") throw new CommandExecutionError(`WeRead whoami failed: ${result.detail}`);
    if (!result?.ok) throw new CommandExecutionError(`Unexpected WeRead probe: ${JSON.stringify(result)}`);
    return { user_id: result.user_id, name: result.name };
  }
  registerSiteAuthCommands({
    site: "weread",
    domain: "weread.qq.com",
    loginUrl: "https://weread.qq.com/",
    columns: ["user_id", "name"],
    quickCheck: hasWereadSessionCookie,
    verify: verifyWereadIdentity,
    poll: async (page) => {
      if (!await hasWereadSessionCookie(page)) {
        throw new AuthRequiredError("weread.qq.com", "Waiting for WeRead wr_vid cookie");
      }
      return verifyWereadIdentity(page);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/book.js
  function decodeHtmlText(value) {
    return value.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-fA-F]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
  }
  function normalizeSearchText(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function buildSearchIdentity(title, author) {
    return `${normalizeSearchText(title)}\0${normalizeSearchText(author)}`;
  }
  function countSearchTitles(entries) {
    const counts = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const key = normalizeSearchText(entry.title);
      if (!key)
        continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
  function countSearchIdentities(entries) {
    const counts = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const key = buildSearchIdentity(entry.title, entry.author);
      if (!normalizeSearchText(entry.title) || !normalizeSearchText(entry.author))
        continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
  function strictTitleFromWereadDocumentTitle(rawTitle) {
    const suffix = " - \u5FAE\u4FE1\u8BFB\u4E66";
    const normalized = String(rawTitle || "").trim();
    if (!normalized.endsWith(suffix))
      return "";
    const base = normalized.slice(0, -suffix.length).trim();
    return base.includes(" - ") ? "" : base;
  }
  function extractReaderFallbackMetadata(doc) {
    const text = (node) => node?.textContent?.trim() || "";
    const firstText = (...sels) => {
      for (const s of sels) {
        const v = text(doc.querySelector(s));
        if (v)
          return v;
      }
      return "";
    };
    const bodyText = doc.body?.innerText?.replace(/\s+/g, " ").trim() || "";
    const extractRating = () => {
      const match = bodyText.match(/微信读书推荐值\s*([0-9.]+%)/);
      return match ? match[1] : "";
    };
    const extractPublisher = () => {
      const direct = text(doc.querySelector(".introDialog_content_pub_line"));
      return direct.startsWith("\u51FA\u7248\u793E") ? direct.replace(/^出版社\s*/, "").trim() : "";
    };
    const extractIntro = () => {
      const selectors = [
        ".horizontalReaderCoverPage_content_bookInfo_intro",
        ".wr_flyleaf_page_bookIntro_content",
        ".introDialog_content_intro_para"
      ];
      for (const selector of selectors) {
        const value = text(doc.querySelector(selector));
        if (value)
          return value;
      }
      return "";
    };
    const categorySource = Array.from(doc.scripts || []).map((script) => script.textContent || "").find((scriptText) => scriptText.includes('"category"')) || "";
    const categoryMatch = categorySource.match(/"category"\s*:\s*"([^"]+)"/);
    const title = firstText(".horizontalReaderCoverPage_content_bookTitle", ".wr_flyleaf_page_bookInfo_bookTitle", ".outline_book_detail_header_title", ".readerTopBar_title_link") || strictTitleFromWereadDocumentTitle(doc.title || "");
    const author = firstText(".horizontalReaderCoverPage_content_author", ".wr_flyleaf_page_bookInfo_author", ".outline_book_detail_header_author");
    return {
      title,
      author,
      publisher: extractPublisher(),
      intro: extractIntro(),
      category: categoryMatch ? categoryMatch[1].trim() : "",
      rating: extractRating(),
      metadataReady: Boolean(title || author)
    };
  }
  async function resolveSearchReaderUrl(title, author) {
    const normalizedTitle = normalizeSearchText(title);
    const normalizedAuthor = normalizeSearchText(author);
    if (!normalizedTitle)
      return "";
    try {
      const [data, htmlEntries] = await Promise.all([
        fetchWebApi("/search/global", { keyword: normalizedTitle }),
        (async () => {
          const url = new URL("/web/search/books", WEREAD_WEB_ORIGIN);
          url.searchParams.set("keyword", normalizedTitle);
          const resp = await fetch(url.toString(), {
            headers: { "User-Agent": WEREAD_UA }
          });
          if (!resp.ok)
            return [];
          const html = await resp.text();
          const items = Array.from(html.matchAll(/<li[^>]*class="wr_bookList_item"[^>]*>([\s\S]*?)<\/li>/g));
          return items.map((match) => {
            const chunk = match[1];
            const hrefMatch = chunk.match(/<a[^>]*href="([^"]+)"[^>]*class="wr_bookList_item_link"[^>]*>|<a[^>]*class="wr_bookList_item_link"[^>]*href="([^"]+)"[^>]*>/);
            const titleMatch = chunk.match(/<p[^>]*class="wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
            const authorMatch = chunk.match(/<p[^>]*class="wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
            const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
            return {
              title: decodeHtmlText(titleMatch?.[1] || ""),
              author: decodeHtmlText(authorMatch?.[1] || ""),
              url: href ? new URL(href, WEREAD_WEB_ORIGIN).toString() : ""
            };
          }).filter((entry) => entry.title && entry.url);
        })()
      ]);
      const books = Array.isArray(data?.books) ? data.books : [];
      const apiIdentityCounts = countSearchIdentities(books.map((item) => ({
        title: item.bookInfo?.title ?? "",
        author: item.bookInfo?.author ?? ""
      })));
      const htmlIdentityCounts = countSearchIdentities(htmlEntries.filter((entry) => entry.author));
      const identityKey = buildSearchIdentity(normalizedTitle, normalizedAuthor);
      if (normalizedAuthor && (apiIdentityCounts.get(identityKey) || 0) === 1 && (htmlIdentityCounts.get(identityKey) || 0) === 1) {
        const exactMatch = htmlEntries.find((entry) => buildSearchIdentity(entry.title, entry.author) === identityKey);
        if (exactMatch?.url)
          return exactMatch.url;
      }
      const sameTitleHtmlEntries = htmlEntries.filter((entry) => normalizeSearchText(entry.title) === normalizedTitle);
      if (normalizedAuthor && sameTitleHtmlEntries.some((entry) => normalizeSearchText(entry.author))) {
        return "";
      }
      const apiTitleCounts = countSearchTitles(books.map((item) => ({ title: item.bookInfo?.title ?? "" })));
      const htmlTitleCounts = countSearchTitles(htmlEntries);
      if ((apiTitleCounts.get(normalizedTitle) || 0) !== 1 || (htmlTitleCounts.get(normalizedTitle) || 0) !== 1) {
        return "";
      }
      return htmlEntries.find((entry) => normalizeSearchText(entry.title) === normalizedTitle)?.url || "";
    } catch {
      return "";
    }
  }
  async function loadReaderFallbackResult(page, readerUrl) {
    await page.goto(readerUrl);
    await page.wait({ selector: ".horizontalReaderCoverPage_content_bookTitle, .wr_flyleaf_page_bookInfo_bookTitle, .readerTopBar_title_link", timeout: 10 });
    const result = await page.evaluate(`
    (${extractReaderFallbackMetadata.toString()})(document)
  `);
    return {
      title: String(result?.title || "").trim(),
      author: String(result?.author || "").trim(),
      publisher: String(result?.publisher || "").trim(),
      intro: String(result?.intro || "").trim(),
      category: String(result?.category || "").trim(),
      rating: String(result?.rating || "").trim(),
      metadataReady: result?.metadataReady === true
    };
  }
  cli({
    site: "weread",
    name: "book",
    access: "read",
    description: "View book details on WeRead",
    domain: "weread.qq.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "book-id", positional: true, required: true, help: "Book ID from search or shelf results" }
    ],
    columns: ["bookId", "title", "author", "publisher", "intro", "category", "rating"],
    func: async (page, args) => {
      const bookId = String(args["book-id"] || "").trim();
      try {
        const data = await fetchPrivateApi(page, "/book/info", { bookId });
        const rating = data.newRating ? `${(data.newRating / 10).toFixed(1)}%` : "-";
        return [{
          bookId: args["book-id"],
          title: data.title ?? "",
          author: data.author ?? "",
          publisher: data.publisher ?? "",
          intro: data.intro ?? "",
          category: data.category ?? "",
          rating
        }];
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "AUTH_REQUIRED") {
          throw error;
        }
        const { readerUrl: resolvedReaderUrl, snapshot } = await resolveShelfReader(page, bookId);
        let readerUrl = resolvedReaderUrl;
        if (!readerUrl) {
          const cachedBook = snapshot.rawBooks.find((book) => String(book?.bookId || "").trim() === bookId);
          readerUrl = await resolveSearchReaderUrl(String(cachedBook?.title || ""), String(cachedBook?.author || ""));
        }
        if (!readerUrl) {
          throw error;
        }
        const data = await loadReaderFallbackResult(page, readerUrl);
        if (!data.metadataReady || !data.title) {
          throw error;
        }
        return [{
          bookId: args["book-id"],
          title: data.title,
          author: data.author,
          publisher: data.publisher,
          intro: data.intro,
          category: data.category,
          rating: data.rating
        }];
      }
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/book-search.js
  var MAX_LIMIT = 100;
  var MAX_FRAGMENT_SIZE = 500;
  var SEARCH_PAGE_SIZE = 50;
  function decodeHtmlText2(value) {
    return String(value || "").replace(/<[^>]+>/g, "").replace(/&#x([0-9a-fA-F]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
  }
  function normalizeSearchText2(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }
  function normalizePositiveInteger(value, defaultValue, label, maxValue) {
    const raw = value ?? defaultValue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ArgumentError(`${label} must be a positive integer`);
    }
    if (maxValue != null && n > maxValue) {
      throw new ArgumentError(`${label} must be <= ${maxValue}`);
    }
    return n;
  }
  function parseOptionalFiniteNumber(value) {
    if (value == null || value === "")
      return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function parseHasMore(value) {
    if (value === true || value === 1 || value === "1")
      return true;
    if (value === false || value === 0 || value === "0")
      return false;
    return null;
  }
  function normalizeRequiredString(value, label) {
    const text = normalizeSearchText2(value);
    if (!text) {
      throw new ArgumentError(`${label} is required`);
    }
    return text;
  }
  function parseWereadReaderUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""), WEREAD_WEB_ORIGIN);
    } catch {
      return "";
    }
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (url.protocol !== "https:" || url.hostname !== "weread.qq.com" || pathParts[0] !== "web" || pathParts[1] !== "reader" || !pathParts[2]) {
      return "";
    }
    if (pathParts.length !== 3) {
      return "";
    }
    return url.toString();
  }
  async function fetchJson(url, label) {
    let resp;
    try {
      resp = await fetch(url.toString(), {
        headers: { "User-Agent": WEREAD_UA }
      });
    } catch (error) {
      throw new CommandExecutionError(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resp.ok) {
      throw new CommandExecutionError(`${label} request failed: HTTP ${resp.status}`);
    }
    try {
      return await resp.json();
    } catch {
      throw new CommandExecutionError(`${label} returned invalid JSON`);
    }
  }
  async function fetchText(url, label) {
    let resp;
    try {
      resp = await fetch(url.toString(), {
        headers: { "User-Agent": WEREAD_UA }
      });
    } catch (error) {
      throw new CommandExecutionError(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resp.ok) {
      throw new CommandExecutionError(`${label} request failed: HTTP ${resp.status}`);
    }
    return resp.text();
  }
  function buildReaderUrlFromInfoId(infoId) {
    const text = normalizeSearchText2(infoId);
    return text ? `${WEREAD_WEB_ORIGIN}/web/reader/${text}` : "";
  }
  function extractReaderInitialState(html) {
    const marker = "window.__INITIAL_STATE__=";
    const start = html.indexOf(marker);
    if (start < 0)
      return null;
    const jsonStart = start + marker.length;
    const cleanupStart = html.indexOf(";(function(){var s;", jsonStart);
    const scriptEnd = html.indexOf("<\/script>", jsonStart);
    const jsonEnd = cleanupStart >= 0 ? cleanupStart : scriptEnd;
    if (jsonEnd < 0)
      return null;
    try {
      return JSON.parse(html.slice(jsonStart, jsonEnd));
    } catch {
      return null;
    }
  }
  function extractJsonLdBookInfo(html) {
    const match = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match)
      return {};
    try {
      const data = JSON.parse(match[1]);
      const info = {};
      info.bookId = normalizeSearchText2(data?.["@Id"]);
      info.title = normalizeSearchText2(data?.name);
      info.author = normalizeSearchText2(data?.author?.name);
      info.readerUrl = normalizeSearchText2(data?.url);
      return info;
    } catch {
      return {};
    }
  }
  function parseReaderMetadata(html, readerUrl) {
    const state = extractReaderInitialState(html);
    const reader = state?.reader ?? {};
    const info = reader.bookInfo ?? {};
    const jsonLd = extractJsonLdBookInfo(html);
    const chapters = Array.isArray(reader.chapterInfos) ? reader.chapterInfos : [];
    const infoId = normalizeSearchText2(reader.infoId) || normalizeSearchText2(info.encodeId);
    const metadata = {};
    metadata.bookId = normalizeSearchText2(info.bookId) || normalizeSearchText2(reader.bookId) || jsonLd.bookId;
    metadata.title = normalizeSearchText2(info.title) || jsonLd.title;
    metadata.author = normalizeSearchText2(info.author) || jsonLd.author;
    metadata.readerUrl = normalizeSearchText2(readerUrl) || buildReaderUrlFromInfoId(infoId) || jsonLd.readerUrl;
    metadata.chapters = chapters;
    return metadata;
  }
  async function loadReaderMetadata(readerUrl) {
    if (!readerUrl)
      return null;
    const html = await fetchText(readerUrl, "WeRead reader page");
    const metadata = parseReaderMetadata(html, readerUrl);
    return metadata.bookId ? metadata : null;
  }
  function parseSearchHtmlEntries(html) {
    const items = Array.from(html.matchAll(/<li[^>]*class="wr_bookList_item"[^>]*>([\s\S]*?)<\/li>/g));
    return items.map((match) => {
      const chunk = match[1];
      const hrefMatch = chunk.match(/<a[^>]*href="([^"]+)"[^>]*class="wr_bookList_item_link"[^>]*>|<a[^>]*class="wr_bookList_item_link"[^>]*href="([^"]+)"[^>]*>/);
      const titleMatch = chunk.match(/<p[^>]*class="wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
      const authorMatch = chunk.match(/<p[^>]*class="wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
      const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
      const entry = {};
      entry.title = decodeHtmlText2(titleMatch?.[1] || "");
      entry.author = decodeHtmlText2(authorMatch?.[1] || "");
      entry.readerUrl = href ? parseWereadReaderUrl(href) : "";
      return entry;
    }).filter((entry) => entry.title && entry.readerUrl);
  }
  async function loadSearchHtmlEntries(bookQuery) {
    const url = new URL("/web/search/books", WEREAD_WEB_ORIGIN);
    url.searchParams.set("keyword", bookQuery);
    return parseSearchHtmlEntries(await fetchText(url, "WeRead search page"));
  }
  function resolveReaderUrlForBook(book, htmlEntries) {
    const title = normalizeSearchText2(book.title);
    const author = normalizeSearchText2(book.author);
    if (!title)
      return "";
    if (author) {
      const exact = htmlEntries.filter((entry) => normalizeSearchText2(entry.title) === title && normalizeSearchText2(entry.author) === author);
      if (exact.length === 1)
        return exact[0].readerUrl;
    }
    const sameTitle = htmlEntries.filter((entry) => normalizeSearchText2(entry.title) === title);
    return sameTitle.length === 1 ? sameTitle[0].readerUrl : "";
  }
  async function searchBookByQuery(bookQuery, bookRank) {
    const url = new URL("/web/search/global", `${WEREAD_WEB_ORIGIN}/web`);
    url.searchParams.set("keyword", bookQuery);
    const data = await fetchJson(url, "WeRead book search");
    if (!Array.isArray(data?.books)) {
      throw new CommandExecutionError("WeRead book search returned malformed books");
    }
    const books = data.books;
    if (books.length === 0) {
      throw new EmptyResultError("weread book-search", `No WeRead books found for "${bookQuery}"`);
    }
    if (bookRank > books.length) {
      throw new ArgumentError(`book-rank must be <= ${books.length}`, `Only ${books.length} book search result(s) were returned for "${bookQuery}"`);
    }
    const bookInfo = books[bookRank - 1]?.bookInfo ?? {};
    const selected = {
      bookId: normalizeSearchText2(bookInfo.bookId),
      title: normalizeSearchText2(bookInfo.title),
      author: normalizeSearchText2(bookInfo.author),
      readerUrl: "",
      chapters: []
    };
    if (!selected.bookId) {
      throw new CommandExecutionError(`WeRead book search result ${bookRank} is missing bookId`);
    }
    const htmlEntries = await loadSearchHtmlEntries(bookQuery);
    selected.readerUrl = resolveReaderUrlForBook(selected, htmlEntries);
    const readerMetadata = await loadReaderMetadata(selected.readerUrl);
    return {
      ...selected,
      ...Object.fromEntries(Object.entries(readerMetadata ?? {}).filter(([, value]) => value != null && value !== "" && !(Array.isArray(value) && value.length === 0)))
    };
  }
  async function resolveBookTarget(target, bookRank) {
    if (/^https?:\/\//i.test(target)) {
      const readerUrl = parseWereadReaderUrl(target);
      if (!readerUrl) {
        throw new ArgumentError("book URL must be a https://weread.qq.com/web/reader/<id> URL");
      }
      const metadata = await loadReaderMetadata(readerUrl);
      if (!metadata?.bookId) {
        throw new CommandExecutionError("Could not parse a bookId from the reader URL");
      }
      return metadata;
    }
    if (/^\d+$/.test(target)) {
      const metadata = {};
      metadata.bookId = target;
      metadata.title = "";
      metadata.author = "";
      metadata.readerUrl = "";
      metadata.chapters = [];
      return metadata;
    }
    return searchBookByQuery(target, bookRank);
  }
  async function searchWithinBook(bookId, query, limit, fragmentSize) {
    const rows = [];
    let maxIdx = 0;
    while (rows.length < limit) {
      const remaining = limit - rows.length;
      const pageSize = remaining < SEARCH_PAGE_SIZE ? remaining : SEARCH_PAGE_SIZE;
      const url = new URL("/web/book/search", WEREAD_WEB_ORIGIN);
      url.searchParams.set("bookId", bookId);
      url.searchParams.set("keyword", query);
      url.searchParams.set("maxIdx", String(maxIdx));
      url.searchParams.set("count", String(pageSize));
      url.searchParams.set("fragmentSize", String(fragmentSize));
      url.searchParams.set("onlyCount", "0");
      const data = await fetchJson(url, "WeRead in-book search");
      if (!Array.isArray(data?.result)) {
        throw new CommandExecutionError("WeRead in-book search returned malformed result");
      }
      const result = data.result.map((item) => {
        if (!item || typeof item !== "object") {
          throw new CommandExecutionError("WeRead in-book search returned malformed match");
        }
        const snippet = normalizeSearchText2(item.abstract);
        const searchIdx = parseOptionalFiniteNumber(item.searchIdx);
        if (!snippet || searchIdx == null || searchIdx <= 0) {
          throw new CommandExecutionError("WeRead in-book search returned malformed match");
        }
        return {
          ...item,
          abstract: snippet,
          chapterIdx: parseOptionalFiniteNumber(item.chapterIdx),
          chapterUid: parseOptionalFiniteNumber(item.chapterUid),
          searchIdx
        };
      });
      if (result.length === 0)
        break;
      rows.push(...result);
      const lastSearchIdx = result[result.length - 1].searchIdx;
      if (lastSearchIdx <= maxIdx)
        throw new CommandExecutionError("WeRead in-book search returned non-advancing searchIdx");
      maxIdx = lastSearchIdx;
      if (rows.length >= limit)
        break;
      const hasMore = parseHasMore(data?.hasMore);
      if (hasMore == null) {
        if (result.length < pageSize)
          break;
        throw new CommandExecutionError("WeRead in-book search returned malformed pagination state");
      }
      if (!hasMore)
        break;
    }
    if (rows.length === 0) {
      throw new EmptyResultError("weread book-search", `No matches for "${query}" in book ${bookId}`);
    }
    return rows.slice(0, limit);
  }
  function buildChapterMap(chapters) {
    const map = /* @__PURE__ */ new Map();
    for (const chapter of chapters) {
      const chapterUid = parseOptionalFiniteNumber(chapter?.chapterUid);
      if (chapterUid == null)
        continue;
      map.set(chapterUid, {
        chapterIdx: parseOptionalFiniteNumber(chapter?.chapterIdx),
        chapterTitle: normalizeSearchText2(chapter?.title)
      });
    }
    return map;
  }
  function buildRows(book, matches) {
    const chapterMap = buildChapterMap(book.chapters ?? []);
    return matches.map((item, index) => {
      const chapterUid = parseOptionalFiniteNumber(item?.chapterUid);
      const chapter = chapterMap.get(chapterUid) ?? {};
      const chapterIdx = chapter.chapterIdx ?? parseOptionalFiniteNumber(item?.chapterIdx);
      return {
        rank: index + 1,
        book_title: book.title || null,
        author: book.author || null,
        chapter_idx: chapterIdx,
        chapter_title: chapter.chapterTitle || null,
        snippet: normalizeSearchText2(item?.abstract),
        search_idx: item.searchIdx,
        chapter_uid: chapterUid,
        book_id: book.bookId,
        url: book.readerUrl || null
      };
    });
  }
  function formatMarkdownResults(book, query, rows) {
    const title = book.title || `WeRead book ${book.bookId}`;
    const lines = [`# ${title}`];
    if (book.author)
      lines.push(`- author: ${book.author}`);
    lines.push(`- book_id: \`${book.bookId}\``);
    lines.push(`- query: \`${query}\``);
    lines.push(`- matches: ${rows.length}`);
    if (book.readerUrl)
      lines.push(`- url: ${book.readerUrl}`);
    lines.push("");
    for (const row of rows) {
      const chapterLabel = row.chapter_title || `chapter ${row.chapter_uid ?? ""}`.trim();
      lines.push(`## ${row.rank}. ${chapterLabel}`);
      const details = [];
      if (row.chapter_idx !== null)
        details.push(`chapter_idx: ${row.chapter_idx}`);
      if (row.chapter_uid !== null)
        details.push(`chapter_uid: ${row.chapter_uid}`);
      details.push(`search_idx: ${row.search_idx}`);
      lines.push("");
      lines.push(`> ${row.snippet}`);
      lines.push("");
      for (const detail of details) {
        lines.push(`- ${detail}`);
      }
      if (row.rank < rows.length)
        lines.push("");
    }
    return lines.join("\n");
  }
  cli({
    site: "weread",
    name: "book-search",
    access: "read",
    description: "Search within a WeRead book after resolving it by title",
    domain: "weread.qq.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    defaultFormat: "md",
    args: [
      { name: "book", positional: true, required: true, help: "Book title keyword, numeric bookId, or reader URL" },
      { name: "query", positional: true, required: true, help: "Keyword to search inside the selected book" },
      { name: "book-rank", type: "int", default: 1, help: "Which book search result to use when book is a title keyword" },
      { name: "limit", type: "int", default: 20, help: "Max in-book matches to return (1-100)" },
      { name: "fragment-size", type: "int", default: 150, help: "Snippet length around each match (1-500)" },
      { name: "raw", type: "boolean", default: false, help: "Output structured rows instead of markdown text" }
    ],
    func: async (args) => {
      const bookTarget = normalizeRequiredString(args.book, "book");
      const query = normalizeRequiredString(args.query, "query");
      const bookRank = normalizePositiveInteger(args["book-rank"], 1, "book-rank");
      const limit = normalizePositiveInteger(args.limit, 20, "limit", MAX_LIMIT);
      const fragmentSize = normalizePositiveInteger(args["fragment-size"], 150, "fragment-size", MAX_FRAGMENT_SIZE);
      const book = await resolveBookTarget(bookTarget, bookRank);
      const matches = await searchWithinBook(book.bookId, query, limit, fragmentSize);
      const rows = buildRows(book, matches);
      if (Boolean(args.raw))
        return rows;
      return [{ markdown: formatMarkdownResults(book, query, rows) }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/highlights.js
  cli({
    site: "weread",
    name: "highlights",
    access: "read",
    description: "List your highlights (underlines) in a book",
    domain: "weread.qq.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "book-id", positional: true, required: true, help: "Book ID (from shelf or search results)" },
      { name: "limit", type: "int", default: 20, help: "Max results" }
    ],
    columns: ["chapter", "text", "createTime"],
    func: async (page, args) => {
      const data = await fetchPrivateApi(page, "/book/bookmarklist", { bookId: args["book-id"] });
      const items = data?.updated ?? [];
      return items.slice(0, Number(args.limit)).map((item) => ({
        chapter: item.chapterName ?? "",
        text: item.markText ?? "",
        createTime: formatDate(item.createTime)
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/notebooks.js
  cli({
    site: "weread",
    name: "notebooks",
    access: "read",
    description: "List books that have highlights or notes",
    domain: "weread.qq.com",
    strategy: Strategy.COOKIE,
    columns: ["title", "author", "noteCount", "bookId"],
    func: async (page, _args) => {
      const data = await fetchPrivateApi(page, "/user/notebooks");
      const books = data?.books ?? [];
      return books.map((item) => ({
        title: item.book?.title ?? "",
        author: item.book?.author ?? "",
        // TODO: bookmarkCount/reviewCount field names from community docs, verify with real API
        noteCount: (item.bookmarkCount ?? 0) + (item.reviewCount ?? 0),
        bookId: item.bookId ?? ""
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/notes.js
  cli({
    site: "weread",
    name: "notes",
    access: "read",
    description: "List your notes (thoughts) on a book",
    domain: "weread.qq.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "book-id", positional: true, required: true, help: "Book ID (from shelf or search results)" },
      { name: "limit", type: "int", default: 20, help: "Max results" }
    ],
    columns: ["chapter", "text", "review", "createTime"],
    func: async (page, args) => {
      const data = await fetchPrivateApi(page, "/review/list", {
        bookId: args["book-id"],
        listType: "11",
        mine: "1",
        synckey: "0"
      });
      const items = data?.reviews ?? [];
      return items.slice(0, Number(args.limit)).map((item) => ({
        chapter: item.review?.chapterName ?? "",
        text: item.review?.abstract ?? "",
        review: item.review?.content ?? "",
        createTime: formatDate(item.review?.createTime)
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/ranking.js
  cli({
    site: "weread",
    name: "ranking",
    access: "read",
    description: "WeRead book rankings by category",
    domain: "weread.qq.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "category", positional: true, default: "all", help: "Category: all (default), rising, or numeric category ID" },
      { name: "limit", type: "int", default: 20, help: "Max results" }
    ],
    columns: ["rank", "title", "author", "category", "readingCount", "bookId"],
    func: async (args) => {
      const cat = encodeURIComponent(args.category ?? "all");
      const data = await fetchWebApi(`/bookListInCategory/${cat}`, { rank: "1" });
      const books = data?.books ?? [];
      return books.slice(0, Number(args.limit)).map((item, i) => ({
        rank: i + 1,
        title: item.bookInfo?.title ?? "",
        author: item.bookInfo?.author ?? "",
        category: item.bookInfo?.category ?? "",
        readingCount: item.readingCount ?? 0,
        bookId: item.bookInfo?.bookId ?? ""
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/weread/search.js
  function decodeNumericHtmlEntity(raw, radix) {
    const codePoint = parseInt(raw, radix);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 1114111) {
      return null;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return null;
    }
  }
  function decodeHtmlText3(value) {
    return value.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-fA-F]+);/gi, (entity, n) => decodeNumericHtmlEntity(n, 16) ?? entity).replace(/&#(\d+);/g, (entity, n) => decodeNumericHtmlEntity(n, 10) ?? entity).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  }
  function normalizeSearchTitle(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function buildSearchIdentity2(title, author) {
    return `${normalizeSearchTitle(title)}\0${normalizeSearchTitle(author)}`;
  }
  function countSearchTitles2(entries) {
    const counts = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const key = normalizeSearchTitle(entry.title);
      if (!key)
        continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
  function countSearchIdentities2(entries) {
    const counts = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const key = buildSearchIdentity2(entry.title, entry.author);
      if (!normalizeSearchTitle(entry.title) || !normalizeSearchTitle(entry.author))
        continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
  function isUniqueCount(counts, key) {
    return (counts.get(key) || 0) <= 1;
  }
  function buildSearchUrlQueues(entries) {
    const exactQueues = /* @__PURE__ */ new Map();
    const titleOnlyQueues = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const titleKey = normalizeSearchTitle(entry.title);
      if (!titleKey || !entry.url)
        continue;
      const queueMap = entry.author ? exactQueues : titleOnlyQueues;
      const queueKey = entry.author ? buildSearchIdentity2(entry.title, entry.author) : titleKey;
      const current = queueMap.get(queueKey);
      if (current) {
        current.push(entry.url);
        continue;
      }
      queueMap.set(queueKey, [entry.url]);
    }
    return { exactQueues, titleOnlyQueues };
  }
  function resolveSearchResultUrl(params) {
    const { exactQueues, titleOnlyQueues, apiIdentityCounts, htmlIdentityCounts, apiTitleCounts, htmlTitleCounts, title, author } = params;
    const identityKey = buildSearchIdentity2(title, author);
    if (isUniqueCount(apiIdentityCounts, identityKey) && isUniqueCount(htmlIdentityCounts, identityKey)) {
      const exactUrl = exactQueues.get(identityKey)?.shift();
      if (exactUrl)
        return exactUrl;
    }
    const titleKey = normalizeSearchTitle(title);
    if (!isUniqueCount(apiTitleCounts, titleKey) || !isUniqueCount(htmlTitleCounts, titleKey)) {
      return "";
    }
    return titleOnlyQueues.get(titleKey)?.shift() ?? "";
  }
  async function loadSearchHtmlEntries2(query) {
    const url = new URL("/web/search/books", WEREAD_WEB_ORIGIN);
    url.searchParams.set("keyword", query);
    let resp;
    try {
      resp = await fetch(url.toString(), {
        headers: { "User-Agent": WEREAD_UA }
      });
    } catch (error) {
      throw new CommandExecutionError(`Failed to fetch WeRead search page: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!resp.ok) {
      throw new CommandExecutionError(`WeRead search page request failed: HTTP ${resp.status}`);
    }
    const html = await resp.text();
    const items = Array.from(html.matchAll(/<li[^>]*class="wr_bookList_item"[^>]*>([\s\S]*?)<\/li>/g));
    return items.map((match) => {
      const chunk = match[1];
      const hrefMatch = chunk.match(/<a[^>]*href="([^"]+)"[^>]*class="wr_bookList_item_link"[^>]*>|<a[^>]*class="wr_bookList_item_link"[^>]*href="([^"]+)"[^>]*>/);
      const titleMatch = chunk.match(/<p[^>]*class="wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
      const authorMatch = chunk.match(/<p[^>]*class="wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
      const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
      const title = decodeHtmlText3(titleMatch?.[1] || "");
      const author = decodeHtmlText3(authorMatch?.[1] || "");
      return {
        author,
        url: href ? new URL(href, WEREAD_WEB_ORIGIN).toString() : "",
        title
      };
    }).filter((item) => item.url && item.title);
  }
  cli({
    site: "weread",
    name: "search",
    access: "read",
    description: "Search books on WeRead",
    domain: "weread.qq.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "query", positional: true, required: true, help: "Search keyword" },
      { name: "limit", type: "int", default: 10, help: "Max results" }
    ],
    columns: ["rank", "title", "author", "bookId", "url"],
    func: async (args) => {
      const [data, htmlEntries] = await Promise.all([
        fetchWebApi("/search/global", { keyword: args.query }),
        loadSearchHtmlEntries2(String(args.query ?? ""))
      ]);
      const books = data?.books ?? [];
      if (!Array.isArray(books)) {
        throw new CommandExecutionError("WeRead search API returned an unreadable books payload");
      }
      if (books.length === 0) {
        throw new EmptyResultError("weread search", `No books were returned for query ${args.query}.`);
      }
      const { exactQueues, titleOnlyQueues } = buildSearchUrlQueues(htmlEntries);
      const apiIdentityCounts = countSearchIdentities2(books.map((item) => ({
        title: item.bookInfo?.title ?? "",
        author: item.bookInfo?.author ?? ""
      })));
      const htmlIdentityCounts = countSearchIdentities2(htmlEntries.filter((entry) => entry.author));
      const apiTitleCounts = countSearchTitles2(books.map((item) => ({ title: item.bookInfo?.title ?? "" })));
      const htmlTitleCounts = countSearchTitles2(htmlEntries);
      return books.slice(0, Number(args.limit)).map((item, i) => {
        const title = item.bookInfo?.title ?? "";
        const author = item.bookInfo?.author ?? "";
        return {
          rank: i + 1,
          title,
          author,
          bookId: item.bookInfo?.bookId ?? "",
          url: resolveSearchResultUrl({
            exactQueues,
            titleOnlyQueues,
            apiIdentityCounts,
            htmlIdentityCounts,
            apiTitleCounts,
            htmlTitleCounts,
            title,
            author
          })
        };
      });
    }
  });

  // webcli/scripts/opencli-wave5/logger.js
  function log() {
  }

  // webcli/scripts/opencli-wave5/upstream/weread/shelf.js
  function normalizeShelfLimit(limit) {
    if (!Number.isFinite(limit))
      return 0;
    return Math.max(0, Math.trunc(limit));
  }
  function normalizePrivateApiRows(data, limit) {
    const books = data?.books ?? [];
    return books.slice(0, limit).map((item) => ({
      title: item.bookInfo?.title ?? item.title ?? "",
      author: item.bookInfo?.author ?? item.author ?? "",
      // TODO: readingProgress field name from community docs, verify with real API response
      progress: item.readingProgress != null ? `${item.readingProgress}%` : "-",
      bookId: item.bookId ?? item.bookInfo?.bookId ?? ""
    }));
  }
  function normalizeWebShelfRows(snapshot, limit) {
    if (limit <= 0)
      return [];
    return buildWebShelfEntries(snapshot).map((entry) => ({
      title: entry.title,
      author: entry.author,
      progress: "-",
      bookId: entry.bookId
    })).filter((item) => Boolean(item.title || item.bookId)).slice(0, limit);
  }
  cli({
    site: "weread",
    name: "shelf",
    access: "read",
    description: "List books on your WeRead bookshelf",
    domain: "weread.qq.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "limit", type: "int", default: 20, help: "Max results" }
    ],
    columns: ["title", "author", "progress", "bookId"],
    func: async (page, args) => {
      const limit = normalizeShelfLimit(Number(args.limit));
      if (limit <= 0)
        return [];
      try {
        const data = await fetchPrivateApi(page, "/shelf/sync", { synckey: "0", lectureSynckey: "0" });
        return normalizePrivateApiRows(data, limit);
      } catch (error) {
        if (!(error instanceof CliError) || error.code !== "AUTH_REQUIRED") {
          throw error;
        }
        const snapshot = await loadWebShelfSnapshot(page);
        if (!snapshot.snapshotLoaded) {
          throw error;
        }
        log.warn("WeRead private API auth expired; showing cached shelf data from localStorage. Results may be stale, and detail commands may still require re-login.");
        return normalizeWebShelfRows(snapshot, limit);
      }
    }
  });

  // webcli/scripts/opencli-wave5/runtime.js
  var domains = {
    v2ex: ["www.v2ex.com", "v2ex.com"],
    gitee: ["gitee.com", "www.gitee.com"],
    tieba: ["tieba.baidu.com"],
    weread: ["weread.qq.com", "i.weread.qq.com", "www.weread.qq.com"],
    xueqiu: ["xueqiu.com", "www.xueqiu.com", "stock.xueqiu.com", "danjuanfunds.com", "www.danjuanfunds.com"],
    weibo: ["weibo.com", "www.weibo.com", "s.weibo.com"],
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
    async evaluateWithArgs(source, args = {}) {
      if (this.pending) throw new CommandExecutionError("Navigation required");
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
      return command.browser === false ? await command.func(args) : await command.func(page, args);
    } catch (error) {
      if (page.pending) return page.pending;
      throw error;
    }
  }
  return __toCommonJS(stdin_exports);
})();

window.__wave5 = __wave5;
