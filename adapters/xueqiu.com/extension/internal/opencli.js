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

  // webcli/scripts/opencli-wave5/upstream/xueqiu/auth.js
  async function hasXueqiuAccessToken(page) {
    const cookies = await page.getCookies({ url: "https://xueqiu.com" });
    return cookies.some((c) => c.name === "xq_a_token" && c.value);
  }
  async function verifyXueqiuIdentity(page) {
    if (!await hasXueqiuAccessToken(page)) {
      throw new AuthRequiredError("xueqiu.com", "Xueqiu xq_a_token cookie missing \u2014 anonymous");
    }
    await page.goto("https://xueqiu.com/");
    await page.wait(2);
    const probe = await page.evaluate(`(async () => {
    try {
      const res = await fetch(
        'https://stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=1&category=1&pid=-1',
        { credentials: 'include' },
      );
      if (res.status === 403) {
        return { kind: 'http', httpStatus: 403, detail: 'xueqiu stock API 403 \u2014 anti-bot / rate limit' };
      }
      if (!res.ok) return { kind: 'http', httpStatus: res.status };
      const d = await res.json();
      if (d?.error_code === 60201) {
        return { kind: 'auth', detail: 'xueqiu portfolio API error_code 60201 \u7528\u6237id\u65E0\u6548 \u2014 anonymous' };
      }
      if (d?.error_code) {
        return { kind: 'xq-error', errorCode: d.error_code, detail: d.error_description || 'xueqiu API error' };
      }
      const uCookie = document.cookie.split('; ').find(c => c.startsWith('u='))?.split('=')[1] || '';
      const cookiesuCookie = document.cookie.split('; ').find(c => c.startsWith('cookiesu='))?.split('=')[1] || '';
      if (!uCookie || uCookie === cookiesuCookie) {
        return { kind: 'auth', detail: 'xueqiu u cookie equals cookiesu (device id) \u2014 anonymous despite portfolio API 200' };
      }
      return { ok: true, user_id: uCookie };
    } catch (e) {
      return { kind: 'exception', detail: String(e && e.message || e) };
    }
  })()`);
    if (probe?.kind === "auth") throw new AuthRequiredError("xueqiu.com", probe.detail);
    if (probe?.kind === "http") throw new CommandExecutionError(`HTTP ${probe.httpStatus} from xueqiu stock API: ${probe.detail || ""}`);
    if (probe?.kind === "xq-error") throw new CommandExecutionError(`xueqiu API error_code ${probe.errorCode}: ${probe.detail}`);
    if (probe?.kind === "exception") throw new CommandExecutionError(`xueqiu whoami failed: ${probe.detail}`);
    if (!probe?.ok) throw new CommandExecutionError(`Unexpected xueqiu probe: ${JSON.stringify(probe)}`);
    return { user_id: String(probe.user_id) };
  }
  registerSiteAuthCommands({
    site: "xueqiu",
    domain: "xueqiu.com",
    loginUrl: "https://xueqiu.com/",
    columns: ["user_id"],
    quickCheck: hasXueqiuAccessToken,
    verify: verifyXueqiuIdentity,
    poll: async (page) => {
      if (!await hasXueqiuAccessToken(page)) {
        throw new AuthRequiredError("xueqiu.com", "Waiting for Xueqiu xq_a_token cookie");
      }
      return verifyXueqiuIdentity(page);
    }
  });

  // webcli/scripts/opencli-wave5/logger.js
  function log() {
  }

  // webcli/scripts/opencli-wave5/utils.js
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // webcli/scripts/opencli-wave5/upstream/xueqiu/comments.js
  var XUEQIU_SYMBOL_PATTERN = /^(?:[A-Z]{2}\d{5,6}|\d{4,6}|[A-Z]{1,5}(?:[.-][A-Z]{1,2})?)$/;
  var FAILURE_REASON_BY_KIND = {
    auth: "auth failure",
    "anti-bot": "anti-bot challenge",
    argument: "invalid symbol",
    empty: "no more discussion data",
    incompatible: "unexpected response shape",
    unknown: "unknown request failure"
  };
  function getCommentList(json) {
    if (Array.isArray(json.list))
      return json.list;
    if (isRecord(json.data) && Array.isArray(json.data.list))
      return json.data.list;
    return null;
  }
  function isAntiBotHtml(response, envelopeText) {
    const htmlText = `${envelopeText} ${response.textSnippet}`.toLowerCase();
    return response.contentType.includes("text/html") && (/captcha|challenge|aliyun_waf|risk/i.test(htmlText) || /_WAF_|_waf_|renderData|aliyun_waf/i.test(response.textSnippet));
  }
  function toFiniteCount(value) {
    const count = Number(value ?? 0);
    return Number.isFinite(count) ? count : 0;
  }
  function normalizeIdentifier(value) {
    if (typeof value === "string")
      return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    return "";
  }
  function buildPaginationStopMessage(requestNumber, collected, target, reason) {
    return `xueqiu comments pagination stopped after request ${requestNumber}, collected ${collected}/${target} items, reason: ${reason}`;
  }
  function throwFirstPageFailure(kind, symbol) {
    if (kind === "auth" || kind === "anti-bot") {
      throw new AuthRequiredError("xueqiu.com", "Stock discussions require login or challenge clearance");
    }
    if (kind === "argument") {
      throw new ArgumentError(`xueqiu comments received an invalid symbol: ${symbol}`);
    }
    if (kind === "empty") {
      throw new EmptyResultError(`xueqiu/comments ${symbol}`, `No discussion data found for ${symbol}`);
    }
    throw new CommandExecutionError(`Unexpected response while loading xueqiu comments for ${symbol}`, "Run the command again with --verbose to inspect the raw site response.");
  }
  function getCommentItems(json) {
    if (!isRecord(json))
      return [];
    const list = getCommentList(json) ?? [];
    return list.filter((item) => !!item && typeof item === "object");
  }
  function classifyXueqiuCommentsResponse(response) {
    const jsonRecord = isRecord(response.json) ? response.json : null;
    const commentList = jsonRecord ? getCommentList(jsonRecord) : null;
    const envelopeText = [
      jsonRecord?.error,
      jsonRecord?.errors,
      jsonRecord?.code,
      jsonRecord?.message,
      jsonRecord?.msg
    ].filter(Boolean).join(" ").toLowerCase();
    const responseText = `${envelopeText} ${response.textSnippet}`.toLowerCase();
    if (isAntiBotHtml(response, envelopeText)) {
      return { kind: "anti-bot" };
    }
    if (response.status === 0 && /failed to fetch|network/i.test(response.textSnippet || "")) {
      return { kind: "anti-bot" };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "auth" };
    }
    if (/login required|unauthorized|unauthorised|forbidden|not logged in|need login/.test(responseText)) {
      return { kind: "auth" };
    }
    if (/invalid symbol|invalid code|bad symbol/.test(envelopeText)) {
      return { kind: "argument" };
    }
    if (/no data|no result|not found|no matching/.test(envelopeText)) {
      return { kind: "empty" };
    }
    if (commentList && commentList.length === 0) {
      return { kind: "empty" };
    }
    if (response.contentType.includes("application/json") && jsonRecord && commentList === null) {
      return { kind: "incompatible" };
    }
    return { kind: "unknown" };
  }
  function normalizeCommentItem(item) {
    const text = String(item.description ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    const id = normalizeIdentifier(item.id);
    const userId = normalizeIdentifier(item.user?.id);
    const createdAtDate = item.created_at ? new Date(item.created_at) : null;
    const createdAt = createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? createdAtDate.toISOString() : null;
    return {
      id,
      author: String(item.user?.screen_name ?? ""),
      text,
      likes: toFiniteCount(item.fav_count),
      replies: toFiniteCount(item.reply_count),
      retweets: toFiniteCount(item.retweet_count),
      created_at: createdAt,
      url: userId && id ? `https://xueqiu.com/${userId}/${id}` : null
    };
  }
  function toCommentOutputRow(row) {
    const { id: _id, ...outputRow } = row;
    return outputRow;
  }
  function describeFailureKind(kind) {
    return FAILURE_REASON_BY_KIND[kind];
  }
  async function fetchCommentsPage(page, symbol, pageNumber, pageSize) {
    const url = new URL("https://xueqiu.com/query/v1/symbol/search/status");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("count", String(pageSize));
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("sort", "time");
    return page.evaluate(`
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(url.toString())}, {
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'x-requested-with': 'XMLHttpRequest',
          },
          referrer: ${JSON.stringify(`https://xueqiu.com/S/${symbol}`)},
          referrerPolicy: 'strict-origin-when-cross-origin',
        });
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let json = null;
        if (contentType.includes('application/json')) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        return {
          status: response.status,
          contentType,
          json,
          textSnippet: text.slice(0, 2000),
        };
      } catch (error) {
        return {
          status: 0,
          contentType: 'text/plain',
          json: null,
          textSnippet: error instanceof Error ? error.message : String(error),
        };
      }
    })()
  `);
  }
  async function collectCommentRows(options) {
    const warn = options.warn ?? log.warn;
    let rows = [];
    const seenIds = /* @__PURE__ */ new Set();
    for (let requestNumber = 1; requestNumber <= options.maxRequests; requestNumber += 1) {
      const response = await options.fetchPage(requestNumber, options.pageSize);
      const classified = classifyXueqiuCommentsResponse(response);
      if (requestNumber === 1 && classified.kind !== "unknown") {
        throwFirstPageFailure(classified.kind, options.symbol);
      } else if (classified.kind === "empty") {
        break;
      } else if (classified.kind !== "unknown") {
        warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, describeFailureKind(classified.kind)));
        break;
      }
      const rawItems = getCommentItems(response.json);
      const pageRows = rawItems.map((item) => normalizeCommentItem(item)).filter((row) => row.id);
      if (pageRows.length === 0) {
        if (requestNumber === 1) {
          throw new CommandExecutionError(`Unexpected response while loading xueqiu comments for ${options.symbol}`, "Run the command again with --verbose to inspect the raw site response.");
        }
        if (classified.kind === "unknown") {
          warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, describeFailureKind(classified.kind)));
        }
        break;
      }
      let advanced = false;
      for (const row of pageRows) {
        if (seenIds.has(row.id))
          continue;
        seenIds.add(row.id);
        rows.push(row);
        advanced = true;
      }
      if (rows.length >= options.limit) {
        return rows.slice(0, options.limit);
      }
      if (rawItems.length < options.pageSize) {
        break;
      }
      if (!advanced) {
        warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, "pagination did not advance"));
        break;
      }
      if (requestNumber === options.maxRequests) {
        warn(buildPaginationStopMessage(requestNumber, rows.length, options.limit, "reached safety cap"));
      }
    }
    return rows.slice(0, options.limit);
  }
  cli({
    site: "xueqiu",
    name: "comments",
    access: "read",
    description: "\u83B7\u53D6\u5355\u53EA\u80A1\u7968\u7684\u8BA8\u8BBA\u52A8\u6001",
    domain: "xueqiu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      {
        name: "symbol",
        positional: true,
        required: true,
        help: "Stock symbol, e.g. SH600519, AAPL, or 00700"
      },
      { name: "limit", type: "int", default: 20, help: "Number of discussion posts to return" }
    ],
    columns: ["author", "text", "likes", "replies", "retweets", "created_at", "url"],
    func: async (page, args) => {
      const symbol = normalizeSymbolInput(args.symbol);
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new ArgumentError("xueqiu comments requires --limit to be a positive integer");
      }
      if (limit > 100) {
        throw new ArgumentError("xueqiu comments supports --limit up to 100");
      }
      const pageSize = Math.min(limit, 20);
      await page.goto("https://xueqiu.com");
      const rows = await collectCommentRows({
        symbol,
        limit,
        pageSize,
        maxRequests: 5,
        fetchPage: (pageNumber, currentPageSize) => fetchCommentsPage(page, symbol, pageNumber, currentPageSize),
        warn: log.warn
      });
      return rows.map((row) => toCommentOutputRow(row));
    }
  });
  function normalizeSymbolInput(raw) {
    const symbol = String(raw ?? "").trim().toUpperCase();
    if (!symbol)
      throw new ArgumentError("xueqiu comments requires a symbol");
    if (/^HTTPS?:\/\//.test(symbol)) {
      throw new ArgumentError("xueqiu comments only accepts a symbol, not a URL");
    }
    if (!XUEQIU_SYMBOL_PATTERN.test(symbol)) {
      throw new ArgumentError(`xueqiu comments received an invalid symbol: ${symbol}`);
    }
    return symbol;
  }

  // webcli/scripts/opencli-wave5/upstream/xueqiu/danjuan-utils.js
  var DANJUAN_DOMAIN = "danjuanfunds.com";
  var DANJUAN_ASSET_PAGE = `https://${DANJUAN_DOMAIN}/my-money`;
  var GAIN_URL = `https://${DANJUAN_DOMAIN}/djapi/fundx/profit/assets/gain?gains=%5B%22private%22%5D`;
  var SUMMARY_URL = `https://${DANJUAN_DOMAIN}/djapi/fundx/profit/assets/summary?invest_account_id=`;
  async function fetchDanjuanAll(page) {
    const raw = await page.evaluate(`
    (async () => {
      const f = async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return { _err: r.status };
        try { return await r.json(); } catch { return { _err: 'parse' }; }
      };
      const n = (v) => { if (v == null || typeof v === 'string' && !v.trim()) return null; const x = Number(v); return Number.isFinite(x) ? x : null; };

      const gain = await f(${JSON.stringify(GAIN_URL)});
      if (gain._err) return { _httpError: gain._err };

      const root = gain.data || {};
      const fundSec = (root.items || []).find(i => i && i.summary_type === 'FUND');
      const rawAccs = fundSec && Array.isArray(fundSec.invest_account_list)
        ? fundSec.invest_account_list : [];

      const accounts = rawAccs.map(a => ({
        accountId:   String(a.invest_account_id || ''),
        accountName: a.invest_account_name || '',
        accountType: a.invest_account_type || '',
        accountCode: a.invest_account_code || '',
        marketValue: n(a.market_value),
        dailyGain:   n(a.daily_gain),
        mainFlag:    !!a.main_flag,
      }));

      if (!accounts.length) {
        return { _emptyAccounts: true };
      }

      const details = await Promise.all(
        accounts.map(a => f(${JSON.stringify(SUMMARY_URL)} + encodeURIComponent(a.accountId)))
      );

      const holdings = [];
      const detailErrors = [];
      for (let i = 0; i < accounts.length; i++) {
        const d = details[i];
        if (d._err) {
          detailErrors.push({
            accountId: accounts[i].accountId,
            accountName: accounts[i].accountName,
            error: d._err,
          });
          continue;
        }
        const data = d.data || {};
        const funds = Array.isArray(data.items) ? data.items : [];
        const acc = accounts[i];
        for (const fd of funds) {
          holdings.push({
            accountId:        acc.accountId,
            accountName:      data.invest_account_name || acc.accountName,
            accountType:      data.invest_account_type || acc.accountType,
            fdCode:           fd.fd_code || '',
            fdName:           fd.fd_name || '',
            category:         fd.category_text || fd.category || '',
            marketValue:      n(fd.market_value),
            volume:           n(fd.volume),
            usableRemainShare:n(fd.usable_remain_share),
            dailyGain:        n(fd.daily_gain),
            holdGain:         n(fd.hold_gain),
            holdGainRate:     n(fd.hold_gain_rate),
            totalGain:        n(fd.total_gain),
            nav:              n(fd.nav),
            marketPercent:    n(fd.market_percent),
          });
        }
      }

      return {
        asOf:                root.daily_gain_date || null,
        totalAssetAmount:    n(root.amount),
        totalAssetDailyGain: n(root.daily_gain),
        totalAssetHoldGain:  n(root.hold_gain),
        totalAssetTotalGain: n(root.total_gain),
        totalFundMarketValue:n(fundSec && fundSec.amount),
        accounts,
        holdings,
        detailErrors,
      };
    })()
  `);
    if (raw?._httpError) {
      throw new Error(`HTTP ${raw._httpError} \u2014 Hint: not logged in to ${DANJUAN_DOMAIN}?`);
    }
    if (raw?._emptyAccounts) {
      throw new Error(`No fund accounts found \u2014 Hint: not logged in to ${DANJUAN_DOMAIN}?`);
    }
    if (Array.isArray(raw?.detailErrors) && raw.detailErrors.length > 0) {
      const failedAccounts = raw.detailErrors.map((item) => {
        const label = item.accountName && item.accountId ? `${item.accountName} (${item.accountId})` : item.accountName || item.accountId || "unknown account";
        return `${label}: ${item.error}`;
      }).join(", ");
      throw new Error(`Failed to fetch Danjuan account details: ${failedAccounts}`);
    }
    return raw;
  }

  // webcli/scripts/opencli-wave5/upstream/xueqiu/utils.js
  var CHINA_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  function formatChinaDate(ts) {
    if (ts == null) return null;
    const parts = Object.fromEntries(
      CHINA_DATE_FORMATTER.formatToParts(new Date(ts)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function stripHtml(html) {
    return (html || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  }
  async function fetchXueqiuJson(page, url) {
    const result = await page.evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!res.ok) return { __xqErr: res.status };
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { __xqErr: 'parse', contentType: res.headers.get('content-type') || '', textSnippet: text.slice(0, 500) };
    }
  })()`);
    const r = result;
    if (r?.__xqErr !== void 0) {
      const code = r.__xqErr;
      if (code === 401 || code === 403) {
        throw new AuthRequiredError("xueqiu.com", "\u672A\u767B\u5F55\u6216\u767B\u5F55\u5DF2\u8FC7\u671F");
      }
      if (code === "parse") {
        const text = String(r.textSnippet || "");
        if (/captcha|challenge|aliyun_waf|renderData|_waf_/i.test(`${r.contentType || ""} ${text}`)) {
          throw new AuthRequiredError("xueqiu.com", "Xueqiu request requires login or challenge clearance");
        }
        throw new CommandExecutionError("\u54CD\u5E94\u4E0D\u662F\u6709\u6548 JSON", "\u53EF\u80FD\u89E6\u53D1\u4E86\u98CE\u63A7\uFF0C\u8BF7\u68C0\u67E5\u767B\u5F55\u72B6\u6001\u6216\u7A0D\u540E\u91CD\u8BD5");
      }
      throw new CommandExecutionError(`HTTP ${code}`, "\u8BF7\u68C0\u67E5\u7F51\u7EDC\u8FDE\u63A5\u6216\u767B\u5F55\u72B6\u6001");
    }
    return result;
  }
  function isXueqiuSymbolQuery(value) {
    return /^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$|^(?:SH|SZ|BJ)\d{5,6}$|^\d{5,6}$|^\d{4,5}$/i.test(String(value || "").trim());
  }
  async function resolveXueqiuSymbolSearchFallback(page, query) {
    const raw = String(query || "").trim().toUpperCase();
    const candidates = [];
    if (/^(?:SH|SZ|BJ)\d{5,6}$/.test(raw) || /^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/.test(raw) || /^\d{4,5}$/.test(raw)) {
      candidates.push(raw);
    } else if (/^\d{6}$/.test(raw)) {
      candidates.push(`SH${raw}`, `SZ${raw}`, `BJ${raw}`);
    }
    for (const symbol of candidates) {
      const quoteUrl = `https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol=${encodeURIComponent(symbol)}`;
      const d = await fetchXueqiuJson(page, quoteUrl);
      const item = d?.data?.items?.[0];
      const q = item?.quote || {};
      if (!q.symbol) continue;
      return [{
        symbol: q.symbol,
        name: q.name,
        exchange: q.exchange,
        price: q.current,
        changePercent: q.percent != null ? q.percent.toFixed(2) + "%" : null,
        url: "https://xueqiu.com/S/" + q.symbol
      }];
    }
    return [];
  }

  // webcli/scripts/opencli-wave5/upstream/xueqiu/earnings-date.js
  cli({
    site: "xueqiu",
    name: "earnings-date",
    access: "read",
    description: "\u83B7\u53D6\u80A1\u7968\u9884\u8BA1\u8D22\u62A5\u53D1\u5E03\u65E5\u671F\uFF08\u516C\u53F8\u5927\u4E8B\uFF09",
    domain: "xueqiu.com",
    browser: true,
    args: [
      {
        name: "symbol",
        required: true,
        positional: true,
        help: "\u80A1\u7968\u4EE3\u7801\uFF0C\u5982 SH600519\u3001SZ000858\u300100700"
      },
      { name: "next", type: "bool", default: false, help: "\u4EC5\u8FD4\u56DE\u6700\u8FD1\u4E00\u6B21\u672A\u53D1\u5E03\u7684\u8D22\u62A5\u65E5\u671F" },
      { name: "limit", type: "int", default: 10, help: "\u8FD4\u56DE\u6570\u91CF\uFF0C\u9ED8\u8BA4 10" }
    ],
    columns: ["date", "report", "status"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const symbol = String(kwargs.symbol).toUpperCase();
      const url = `https://stock.xueqiu.com/v5/stock/screener/event/list.json?symbol=${encodeURIComponent(symbol)}&page=1&size=100`;
      const d = await fetchXueqiuJson(page, url);
      if (!d.data?.items)
        throw new EmptyResultError("xueqiu/earnings-date", "\u8BF7\u786E\u8BA4\u80A1\u7968\u4EE3\u7801\u662F\u5426\u6B63\u786E: " + symbol);
      const now = Date.now();
      let results = d.data.items.filter((item) => item.subtype === 2).map((item) => {
        const ts = item.timestamp;
        const dateStr = ts ? formatChinaDate(ts) : null;
        const isFuture = ts && ts > now;
        return { date: dateStr, report: item.message, status: isFuture ? "\u23F3 \u672A\u53D1\u5E03" : "\u2705 \u5DF2\u53D1\u5E03", _ts: ts, _future: isFuture };
      });
      if (kwargs.next) {
        const future = results.filter((r) => r._future).sort((a, b) => a._ts - b._ts);
        results = future.length ? [future[0]] : [];
      }
      return results.slice(0, kwargs.limit).map(({ date, report, status }) => ({ date, report, status }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/feed.js
  cli({
    site: "xueqiu",
    name: "feed",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u9996\u9875\u65F6\u95F4\u7EBF\uFF08\u5173\u6CE8\u7528\u6237\u7684\u52A8\u6001\uFF09",
    domain: "xueqiu.com",
    browser: true,
    args: [
      { name: "page", type: "int", default: 1, help: "\u9875\u7801\uFF0C\u9ED8\u8BA4 1" },
      { name: "limit", type: "int", default: 20, help: "\u6BCF\u9875\u6570\u91CF\uFF0C\u9ED8\u8BA4 20" }
    ],
    columns: ["author", "text", "likes", "replies", "url"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const url = `https://xueqiu.com/v4/statuses/home_timeline.json?page=${kwargs.page}&count=${kwargs.limit}`;
      const d = await fetchXueqiuJson(page, url);
      return (d.home_timeline || d.list || []).slice(0, kwargs.limit).map((item) => {
        const user = item.user || {};
        return {
          author: user.screen_name,
          text: stripHtml(item.description).substring(0, 200),
          likes: item.fav_count,
          replies: item.reply_count,
          url: "https://xueqiu.com/" + user.id + "/" + item.id
        };
      });
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/fund-holdings.js
  cli({
    site: "xueqiu",
    name: "fund-holdings",
    access: "read",
    description: "\u83B7\u53D6\u86CB\u5377\u57FA\u91D1\u6301\u4ED3\u660E\u7EC6\uFF08\u53EF\u7528 --account \u6309\u5B50\u8D26\u6237\u8FC7\u6EE4\uFF09",
    domain: "danjuanfunds.com",
    strategy: Strategy.COOKIE,
    navigateBefore: "https://danjuanfunds.com/my-money",
    args: [
      { name: "account", type: "str", default: "", help: "\u6309\u5B50\u8D26\u6237\u540D\u79F0\u6216 ID \u8FC7\u6EE4" }
    ],
    columns: ["accountName", "fdCode", "fdName", "marketValue", "volume", "dailyGain", "holdGain", "holdGainRate", "marketPercent"],
    func: async (page, args) => {
      const snapshot = await fetchDanjuanAll(page);
      if (!snapshot.accounts.length) {
        throw new Error("No fund accounts found \u2014 Hint: not logged in to danjuanfunds.com?");
      }
      const filter = String(args.account ?? "").trim();
      const rows = filter ? snapshot.holdings.filter((h) => h.accountId === filter || h.accountName.includes(filter)) : snapshot.holdings;
      if (!rows.length) {
        throw new Error(filter ? `No holdings matched account filter: ${filter}` : "No holdings found.");
      }
      return rows;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/fund-snapshot.js
  cli({
    site: "xueqiu",
    name: "fund-snapshot",
    access: "read",
    description: "\u83B7\u53D6\u86CB\u5377\u57FA\u91D1\u5FEB\u7167\uFF08\u603B\u8D44\u4EA7\u3001\u5B50\u8D26\u6237\u3001\u6301\u4ED3\uFF0C\u63A8\u8350 -f json \u8F93\u51FA\uFF09",
    domain: "danjuanfunds.com",
    strategy: Strategy.COOKIE,
    navigateBefore: "https://danjuanfunds.com/my-money",
    args: [],
    columns: ["asOf", "totalAssetAmount", "totalFundMarketValue", "accountCount", "holdingCount"],
    func: async (page) => {
      const s = await fetchDanjuanAll(page);
      return [{
        asOf: s.asOf,
        totalAssetAmount: s.totalAssetAmount,
        totalAssetDailyGain: s.totalAssetDailyGain,
        totalFundMarketValue: s.totalFundMarketValue,
        accountCount: s.accounts.length,
        holdingCount: s.holdings.length,
        accounts: s.accounts,
        holdings: s.holdings
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/groups.js
  cli({
    site: "xueqiu",
    name: "groups",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u81EA\u9009\u80A1\u5206\u7EC4\u5217\u8868\uFF08\u542B\u6A21\u62DF\u7EC4\u5408\uFF09",
    domain: "xueqiu.com",
    browser: true,
    columns: ["pid", "name", "count"],
    func: async (page, _kwargs) => {
      await page.goto("https://xueqiu.com");
      const d = await fetchXueqiuJson(page, "https://stock.xueqiu.com/v5/stock/portfolio/list.json?category=1&size=20");
      if (!d.data?.stocks)
        throw new AuthRequiredError("xueqiu.com");
      return (d.data.stocks || []).map((g) => ({
        pid: String(g.id),
        name: g.name,
        count: g.symbol_count || 0
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/hot.js
  cli({
    site: "xueqiu",
    name: "hot",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u70ED\u95E8\u52A8\u6001",
    domain: "xueqiu.com",
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u6570\u91CF\uFF0C\u9ED8\u8BA4 20\uFF0C\u6700\u5927 50" }
    ],
    columns: ["rank", "author", "text", "likes", "url"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const d = await fetchXueqiuJson(page, "https://xueqiu.com/statuses/hot/listV3.json?source=hot&page=1");
      return (d.list || []).slice(0, kwargs.limit).map((item, i) => {
        const user = item.user || {};
        return {
          rank: i + 1,
          author: user.screen_name,
          text: stripHtml(item.description).substring(0, 200),
          likes: item.fav_count,
          url: "https://xueqiu.com/" + user.id + "/" + item.id
        };
      });
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/hot-stock.js
  cli({
    site: "xueqiu",
    name: "hot-stock",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u70ED\u95E8\u80A1\u7968\u699C",
    domain: "xueqiu.com",
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u6570\u91CF\uFF0C\u9ED8\u8BA4 20\uFF0C\u6700\u5927 50" },
      { name: "type", default: "10", help: "\u699C\u5355\u7C7B\u578B 10=\u4EBA\u6C14\u699C(\u9ED8\u8BA4) 12=\u5173\u6CE8\u699C" }
    ],
    columns: ["rank", "symbol", "name", "price", "changePercent", "heat"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const url = `https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=${kwargs.limit}&type=${kwargs.type}`;
      const d = await fetchXueqiuJson(page, url);
      if (!d.data?.items)
        throw new AuthRequiredError("xueqiu.com");
      return (d.data.items || []).map((s, i) => ({
        rank: i + 1,
        symbol: s.symbol,
        name: s.name,
        price: s.current,
        changePercent: s.percent != null ? s.percent.toFixed(2) + "%" : null,
        heat: s.value,
        url: "https://xueqiu.com/S/" + s.symbol
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/kline.js
  cli({
    site: "xueqiu",
    name: "kline",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u80A1\u7968K\u7EBF\uFF08\u5386\u53F2\u884C\u60C5\uFF09\u6570\u636E",
    domain: "xueqiu.com",
    browser: true,
    args: [
      {
        name: "symbol",
        required: true,
        positional: true,
        help: "\u80A1\u7968\u4EE3\u7801\uFF0C\u5982 SH600519\u3001SZ000858\u3001AAPL"
      },
      { name: "days", type: "int", default: 14, help: "\u56DE\u6EAF\u5929\u6570\uFF08\u9ED8\u8BA414\u5929\uFF09" }
    ],
    columns: ["date", "open", "high", "low", "close", "volume"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const symbol = String(kwargs.symbol).toUpperCase();
      const days = kwargs.days;
      const beginTs = Date.now();
      const url = `https://stock.xueqiu.com/v5/stock/chart/kline.json?symbol=${encodeURIComponent(symbol)}&begin=${beginTs}&period=day&type=before&count=-${days}`;
      const d = await fetchXueqiuJson(page, url);
      if (!d.data?.item?.length)
        throw new EmptyResultError("xueqiu/kline", "\u8BF7\u786E\u8BA4\u80A1\u7968\u4EE3\u7801\u662F\u5426\u6B63\u786E: " + symbol);
      const columns = d.data.column || [];
      const colIdx = {};
      columns.forEach((name, i) => {
        colIdx[name] = i;
      });
      return d.data.item.map((row) => ({
        date: colIdx.timestamp != null ? formatChinaDate(row[colIdx.timestamp]) : null,
        open: row[colIdx.open] ?? null,
        high: row[colIdx.high] ?? null,
        low: row[colIdx.low] ?? null,
        close: row[colIdx.close] ?? null,
        volume: row[colIdx.volume] ?? null,
        percent: row[colIdx.percent] ?? null,
        symbol
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/search.js
  cli({
    site: "xueqiu",
    name: "search",
    access: "read",
    description: "\u641C\u7D22\u96EA\u7403\u80A1\u7968\uFF08\u4EE3\u7801\u6216\u540D\u79F0\uFF09",
    domain: "xueqiu.com",
    browser: true,
    args: [
      { name: "query", required: true, positional: true, help: "\u641C\u7D22\u5173\u952E\u8BCD\uFF0C\u5982 \u8305\u53F0\u3001AAPL\u3001\u817E\u8BAF" },
      { name: "limit", type: "int", default: 10, help: "\u8FD4\u56DE\u6570\u91CF\uFF0C\u9ED8\u8BA4 10" }
    ],
    columns: ["symbol", "name", "exchange", "price", "changePercent", "url"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const url = `https://xueqiu.com/stock/search.json?code=${encodeURIComponent(String(kwargs.query))}&size=${kwargs.limit}`;
      const d = await fetchXueqiuJson(page, url);
      if (!d || !Array.isArray(d.stocks)) {
        if (isXueqiuSymbolQuery(kwargs.query)) {
          const fallbackRows = await resolveXueqiuSymbolSearchFallback(page, kwargs.query);
          if (fallbackRows.length) return fallbackRows.slice(0, kwargs.limit);
        }
        throw new AuthRequiredError("xueqiu.com", "Xueqiu search requires login or challenge clearance");
      }
      return d.stocks.slice(0, kwargs.limit).map((s) => {
        let symbol = "";
        if (s.exchange === "SH" || s.exchange === "SZ" || s.exchange === "BJ") {
          symbol = s.code.startsWith(s.exchange) ? s.code : s.exchange + s.code;
        } else {
          symbol = s.code;
        }
        return {
          symbol,
          name: s.name,
          exchange: s.exchange,
          price: s.current,
          changePercent: s.percentage != null ? s.percentage.toFixed(2) + "%" : null,
          url: "https://xueqiu.com/S/" + symbol
        };
      });
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/stock.js
  function fmtAmount(v) {
    if (v == null)
      return null;
    if (Math.abs(v) >= 1e12)
      return (v / 1e12).toFixed(2) + "\u4E07\u4EBF";
    if (Math.abs(v) >= 1e8)
      return (v / 1e8).toFixed(2) + "\u4EBF";
    if (Math.abs(v) >= 1e4)
      return (v / 1e4).toFixed(2) + "\u4E07";
    return String(v);
  }
  cli({
    site: "xueqiu",
    name: "stock",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u80A1\u7968\u5B9E\u65F6\u884C\u60C5",
    domain: "xueqiu.com",
    browser: true,
    args: [
      {
        name: "symbol",
        required: true,
        positional: true,
        help: "\u80A1\u7968\u4EE3\u7801\uFF0C\u5982 SH600519\u3001SZ000858\u3001AAPL\u300100700"
      }
    ],
    columns: ["name", "symbol", "price", "changePercent", "marketCap"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const symbol = String(kwargs.symbol).toUpperCase();
      const url = `https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol=${encodeURIComponent(symbol)}`;
      const d = await fetchXueqiuJson(page, url);
      if (!d.data?.items?.length)
        throw new EmptyResultError("xueqiu/stock", "\u8BF7\u786E\u8BA4\u80A1\u7968\u4EE3\u7801\u662F\u5426\u6B63\u786E: " + symbol);
      const item = d.data.items[0];
      const q = item.quote || {};
      const m = item.market || {};
      return [{
        name: q.name,
        symbol: q.symbol,
        exchange: q.exchange,
        currency: q.currency,
        price: q.current,
        change: q.chg,
        changePercent: q.percent != null ? q.percent.toFixed(2) + "%" : null,
        open: q.open,
        high: q.high,
        low: q.low,
        prevClose: q.last_close,
        amplitude: q.amplitude != null ? q.amplitude.toFixed(2) + "%" : null,
        volume: q.volume,
        amount: fmtAmount(q.amount),
        turnover_rate: q.turnover_rate != null ? q.turnover_rate.toFixed(2) + "%" : null,
        marketCap: fmtAmount(q.market_capital),
        floatMarketCap: fmtAmount(q.float_market_capital),
        ytdPercent: q.current_year_percent != null ? q.current_year_percent.toFixed(2) + "%" : null,
        market_status: m.status || null,
        time: q.timestamp ? new Date(q.timestamp).toISOString() : null,
        url: "https://xueqiu.com/S/" + q.symbol
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xueqiu/watchlist.js
  cli({
    site: "xueqiu",
    name: "watchlist",
    access: "read",
    description: "\u83B7\u53D6\u96EA\u7403\u81EA\u9009\u80A1/\u6A21\u62DF\u7EC4\u5408\u80A1\u7968\u5217\u8868",
    domain: "xueqiu.com",
    browser: true,
    args: [
      {
        name: "pid",
        default: "-1",
        help: "\u5206\u7EC4ID\uFF1A-1=\u5168\u90E8(\u9ED8\u8BA4) -4=\u6A21\u62DF -5=\u6CAA\u6DF1 -6=\u7F8E\u80A1 -7=\u6E2F\u80A1 -10=\u5B9E\u76D8 0=\u6301\u4ED3\uFF08\u901A\u8FC7 xueqiu groups \u83B7\u53D6\uFF09"
      },
      { name: "limit", type: "int", default: 100, help: "\u9ED8\u8BA4 100" }
    ],
    columns: ["symbol", "name", "price", "changePercent"],
    func: async (page, kwargs) => {
      await page.goto("https://xueqiu.com");
      const pid = String(kwargs.pid || "-1");
      const url = `https://stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=100&category=1&pid=${encodeURIComponent(pid)}`;
      const d = await fetchXueqiuJson(page, url);
      if (!d.data?.stocks)
        throw new AuthRequiredError("xueqiu.com");
      return (d.data.stocks || []).slice(0, kwargs.limit).map((s) => ({
        symbol: s.symbol,
        name: s.name,
        price: s.current,
        change: s.chg,
        changePercent: s.percent != null ? s.percent.toFixed(2) + "%" : null,
        volume: s.volume,
        url: "https://xueqiu.com/S/" + s.symbol
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
  function isRecord2(value) {
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
      if (isRecord2(obj)) obj = obj[part];
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
    if (!isRecord2(payload)) throw new CommandExecutionError("V2EX API returned an unexpected document shape");
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
      const left = isRecord2(a) ? a[key] : void 0;
      const right = isRecord2(b) ? b[key] : void 0;
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
      if (!isRecord2(stage)) throw new CommandExecutionError("Invalid pipeline stage");
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
