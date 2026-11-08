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

  // webcli/scripts/opencli-wave5/upstream/1688/shared.js
  var SEARCH_URL_PREFIX = "https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=";
  var DETAIL_URL_PREFIX = "https://detail.1688.com/offer/";
  var STORE_MOBILE_URL_PREFIX = "https://winport.m.1688.com/page/index.html?memberId=";
  var STRATEGY = "cookie";
  var SEARCH_LIMIT_DEFAULT = 20;
  var SEARCH_LIMIT_MAX = 100;
  var STORE_GENERIC_HOSTS = /* @__PURE__ */ new Set(["www", "detail", "s", "winport", "work", "air", "dj"]);
  var TRACKING_QUERY_KEYS = /* @__PURE__ */ new Set([
    "spm",
    "tracelog",
    "clickid",
    "source",
    "scene",
    "from",
    "src",
    "ns",
    "cna",
    "pvid"
  ]);
  var CAPTCHA_URL_MARKER = "/_____tmd_____/punish";
  var CAPTCHA_TEXT_PATTERNS = [
    "\u8BF7\u62D6\u52A8\u4E0B\u65B9\u6ED1\u5757\u5B8C\u6210\u9A8C\u8BC1",
    "\u8BF7\u6309\u4F4F\u6ED1\u5757\uFF0C\u62D6\u52A8\u5230\u6700\u53F3\u8FB9",
    "\u901A\u8FC7\u9A8C\u8BC1\u4EE5\u786E\u4FDD\u6B63\u5E38\u8BBF\u95EE",
    "\u9A8C\u8BC1\u7801\u62E6\u622A",
    "\u8BBF\u95EE\u9A8C\u8BC1",
    "\u6ED1\u52A8\u9A8C\u8BC1"
  ];
  var LOGIN_TEXT_PATTERNS = [
    "\u8BF7\u767B\u5F55",
    "\u767B\u5F55\u540E",
    "\u8D26\u53F7\u767B\u5F55",
    "\u624B\u673A\u767B\u5F55",
    "\u7ACB\u5373\u767B\u5F55",
    "\u626B\u7801\u767B\u5F55",
    "\u8BF7\u5148\u5B8C\u6210\u767B\u5F55",
    "\u8BF7\u5148\u767B\u5F55\u540E\u67E5\u770B"
  ];
  var LOGIN_URL_PATTERNS = ["/member/login", "passport", "login.taobao.com", "account.1688.com"];
  var FACTORY_BADGE_PATTERNS = [
    "\u6E90\u5934\u5DE5\u5382",
    "\u6DF1\u5EA6\u9A8C\u5382",
    "\u5B9E\u529B\u5DE5\u5382",
    "\u5DE5\u5382\u6863\u6848",
    "\u52A0\u5DE5\u4E13\u533A",
    "\u9A8C\u5382\u62A5\u544A",
    "\u5382\u5BB6\u76F4\u9500",
    "\u751F\u4EA7\u5382\u5BB6",
    "\u5DE5\u5382\u76F4\u4F9B"
  ];
  var SERVICE_BADGE_PATTERNS = [
    "\u5EF6\u671F\u5FC5\u8D54",
    "\u54C1\u8D28\u4FDD\u969C",
    "\u7834\u635F\u5305\u8D54",
    "\u9000\u8D27\u5305\u8FD0\u8D39",
    "\u665A\u53D1\u5FC5\u8D54",
    "7*24\u5C0F\u65F6\u54CD\u5E94",
    "48\u5C0F\u65F6\u53D1\u8D27",
    "72\u5C0F\u65F6\u53D1\u8D27",
    "\u540E\u5929\u8FBE",
    "\u5305\u90AE",
    "\u95EA\u7535\u62FF\u6837"
  ];
  var CHINA_LOCATIONS = [
    "\u5317\u4EAC",
    "\u5929\u6D25",
    "\u4E0A\u6D77",
    "\u91CD\u5E86",
    "\u6CB3\u5317",
    "\u5C71\u897F",
    "\u8FBD\u5B81",
    "\u5409\u6797",
    "\u9ED1\u9F99\u6C5F",
    "\u6C5F\u82CF",
    "\u6D59\u6C5F",
    "\u5B89\u5FBD",
    "\u798F\u5EFA",
    "\u6C5F\u897F",
    "\u5C71\u4E1C",
    "\u6CB3\u5357",
    "\u6E56\u5317",
    "\u6E56\u5357",
    "\u5E7F\u4E1C",
    "\u6D77\u5357",
    "\u56DB\u5DDD",
    "\u8D35\u5DDE",
    "\u4E91\u5357",
    "\u9655\u897F",
    "\u7518\u8083",
    "\u9752\u6D77",
    "\u53F0\u6E7E",
    "\u5185\u8499\u53E4",
    "\u5E7F\u897F",
    "\u897F\u85CF",
    "\u5B81\u590F",
    "\u65B0\u7586",
    "\u9999\u6E2F",
    "\u6FB3\u95E8"
  ];
  function cleanText(value) {
    return typeof value === "string" ? value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : "";
  }
  function cleanMultilineText(value) {
    return typeof value === "string" ? value.replace(/\u00a0/g, " ").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") : "";
  }
  function uniqueNonEmpty(values) {
    return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
  }
  function parseSearchLimit(input) {
    const parsed = Number.parseInt(String(input ?? SEARCH_LIMIT_DEFAULT), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new ArgumentError("1688 search --limit must be a positive integer", 'Example: opencli 1688 search "\u684C\u9762\u7F6E\u7269\u67B6" --limit 20');
    }
    return Math.min(SEARCH_LIMIT_MAX, parsed);
  }
  function buildSearchUrl(query) {
    const normalized = cleanText(query);
    if (!normalized) {
      throw new ArgumentError("1688 search query cannot be empty", 'Example: opencli 1688 search "\u684C\u9762\u7F6E\u7269\u67B6" --limit 20');
    }
    return `${SEARCH_URL_PREFIX}${encodeURIComponent(normalized)}`;
  }
  function buildDetailUrl(input) {
    const offerId = extractOfferId(input);
    if (!offerId) {
      throw new ArgumentError("1688 item expects an offer URL or offer ID", "Example: opencli 1688 item 887904326744");
    }
    return `${DETAIL_URL_PREFIX}${offerId}.html`;
  }
  function resolveStoreUrl(input) {
    const normalized = cleanText(input);
    if (!normalized) {
      throw new ArgumentError("1688 store expects a store URL or member ID", "Example: opencli 1688 store https://yinuoweierfushi.1688.com/");
    }
    const memberId = extractMemberId(normalized);
    if (memberId) {
      return `${STORE_MOBILE_URL_PREFIX}${memberId}`;
    }
    if (/^https?:\/\//i.test(normalized)) {
      return canonicalizeStoreUrl(normalized);
    }
    if (normalized.endsWith(".1688.com")) {
      return canonicalizeStoreUrl(`https://${normalized}`);
    }
    if (/^[a-z0-9-]+$/i.test(normalized)) {
      return canonicalizeStoreUrl(`https://${normalized}.1688.com`);
    }
    throw new ArgumentError("1688 store expects a store URL or member ID", "Example: opencli 1688 store b2b-22154705262941f196");
  }
  function canonicalizeStoreUrl(input) {
    const url = parse1688Url(input);
    const memberId = extractMemberId(url.toString());
    if (memberId) {
      return `${STORE_MOBILE_URL_PREFIX}${memberId}`;
    }
    const host = normalizeStoreHost(url.hostname);
    if (!host) {
      throw new ArgumentError("Invalid 1688 store URL", "Example: opencli 1688 store https://yinuoweierfushi.1688.com/");
    }
    return `https://${host}`;
  }
  function canonicalizeItemUrl(input) {
    const offerId = extractOfferId(input);
    if (offerId) {
      return `${DETAIL_URL_PREFIX}${offerId}.html`;
    }
    const url = parse1688UrlOrNull(input);
    if (!url)
      return null;
    stripTrackingParams(url);
    url.hash = "";
    return url.toString();
  }
  function canonicalizeSellerUrl(input) {
    const memberId = extractMemberId(input);
    if (memberId) {
      return `${STORE_MOBILE_URL_PREFIX}${memberId}`;
    }
    const url = parse1688UrlOrNull(input);
    if (!url)
      return null;
    const host = normalizeStoreHost(url.hostname);
    if (!host)
      return null;
    return `https://${host}`;
  }
  function extractOfferId(input) {
    const normalized = cleanText(input);
    if (!normalized)
      return null;
    const directId = normalized.match(/^\d{6,}$/)?.[0];
    if (directId)
      return directId;
    const detailMatch = normalized.match(/\/offer\/(\d{6,})\.html/i);
    if (detailMatch)
      return detailMatch[1];
    const queryMatch = normalized.match(/[?&]offerId=(\d{6,})/i);
    if (queryMatch)
      return queryMatch[1];
    return null;
  }
  function extractMemberId(input) {
    const normalized = cleanText(input);
    if (!normalized)
      return null;
    const direct = normalized.match(/\bb2b-[a-z0-9]+\b/i)?.[0];
    if (direct)
      return direct;
    const queryMatch = normalized.match(/[?&]memberId=(b2b-[a-z0-9]+)/i);
    if (queryMatch)
      return queryMatch[1];
    const mobileMatch = normalized.match(/\/winport\/(b2b-[a-z0-9]+)\.html/i);
    if (mobileMatch)
      return mobileMatch[1];
    return null;
  }
  function extractShopId(input) {
    const normalized = cleanText(input);
    if (!normalized)
      return null;
    try {
      const url = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`);
      const host = normalizeStoreHost(url.hostname);
      if (!host)
        return null;
      return host.split(".")[0] ?? null;
    } catch {
      return /^[a-z0-9-]+$/i.test(normalized) ? normalized : null;
    }
  }
  function buildProvenance(sourceUrl) {
    return {
      source_url: sourceUrl,
      fetched_at: (/* @__PURE__ */ new Date()).toISOString(),
      strategy: STRATEGY
    };
  }
  function parsePriceText(text) {
    const normalized = normalizeNumericText(cleanText(text));
    const matches = normalized.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];
    const values = matches.map((value) => Number.parseFloat(value.replace(/,/g, ""))).filter((value) => Number.isFinite(value));
    if (values.length === 0) {
      return {
        price_text: normalized,
        price_min: null,
        price_max: null,
        currency: null
      };
    }
    return {
      price_text: normalized,
      price_min: values[0] ?? null,
      price_max: values[values.length - 1] ?? values[0] ?? null,
      currency: normalized.includes("\xA5") || normalized.includes("\u5143") ? "CNY" : null
    };
  }
  function normalizePriceTiers(rawTiers, unit) {
    return rawTiers.map((tier) => {
      const quantityMin = toNumber(tier.beginAmount);
      const priceText = cleanText(tier.price);
      const price = toNumber(tier.price);
      return {
        quantity_text: quantityMin !== null ? `${quantityMin}${unit ?? ""}` : "",
        quantity_min: quantityMin,
        price_text: priceText,
        price,
        currency: priceText ? "CNY" : null
      };
    }).filter((tier) => tier.price_text);
  }
  function parseMoqText(text) {
    const normalized = normalizeNumericText(cleanText(text));
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*(件|个|套|箱|包|双|台|把|只|pcs|piece|pieces)?\s*起批/i) ?? normalized.match(/≥\s*(\d+(?:\.\d+)?)/);
    const rangeMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:~|-|至|到)\s*\d+(?:\.\d+)?\s*(件|个|套|箱|包|双|台|把|只|pcs|piece|pieces)/i);
    if (!match && !rangeMatch) {
      return {
        moq_text: normalized,
        moq_value: null
      };
    }
    return {
      moq_text: normalized,
      moq_value: Number.parseFloat((match ?? rangeMatch)[1])
    };
  }
  function extractLocation(text) {
    const normalized = cleanMultilineText(text);
    const primaryRegion = normalized.split(/送至|发往/)[0] ?? normalized;
    const lines = primaryRegion.split("\n");
    for (const line of lines) {
      const compact = cleanText(line);
      if (!compact || compact.length > 16)
        continue;
      if (CHINA_LOCATIONS.some((location2) => compact.startsWith(location2))) {
        return compact;
      }
    }
    const locationPattern = new RegExp(`(${CHINA_LOCATIONS.join("|")})[\\u4e00-\\u9fa5]{0,8}`);
    return primaryRegion.match(locationPattern)?.[0] ?? null;
  }
  function extractAddress(text) {
    const normalized = cleanMultilineText(text);
    const lineMatch = normalized.match(/地址[:：]\s*([^\n]+)/);
    if (lineMatch)
      return cleanText(lineMatch[1]);
    return normalized.split("\n").map((line) => cleanText(line)).find((line) => line.includes("\u7701") || line.includes("\u5E02") || line.includes("\u533A") || line.includes("\u53BF")) ?? null;
  }
  function extractMetric(text, label) {
    const normalized = cleanMultilineText(text);
    const direct = normalized.match(new RegExp(`(?:^|\\n)\\s*${escapeForRegex(label)}[:\uFF1A]?\\s*([^\\n]+)`));
    if (direct)
      return cleanText(direct[1]);
    const lineBased = normalized.match(new RegExp(`(?:^|\\n)\\s*${escapeForRegex(label)}\\n([^\\n]+)`));
    return lineBased ? cleanText(lineBased[1]) : null;
  }
  function extractYearsOnPlatform(text) {
    return text.match(/入驻\d+年/)?.[0] ?? null;
  }
  function extractMainBusiness(text) {
    const value = extractMetric(text, "\u4E3B\u8425");
    return value ? value.replace(/^：/, "").trim() : null;
  }
  function extractBadges(text, candidates) {
    return uniqueNonEmpty(candidates.filter((candidate) => cleanMultilineText(text).includes(candidate)));
  }
  function guessTopCategories(text) {
    const mainBusiness = extractMainBusiness(text);
    if (!mainBusiness)
      return [];
    return uniqueNonEmpty(mainBusiness.split(/[、,/|]/).map((value) => value.trim()));
  }
  function isCaptchaState(state) {
    const href = cleanText(state.href).toLowerCase();
    const title = cleanText(state.title);
    const bodyText = cleanMultilineText(state.body_text);
    if (href.includes(CAPTCHA_URL_MARKER))
      return true;
    return CAPTCHA_TEXT_PATTERNS.some((pattern) => title.includes(pattern) || bodyText.includes(pattern));
  }
  function isLoginState(state) {
    const href = cleanText(state.href).toLowerCase();
    const title = cleanText(state.title);
    const bodyText = cleanMultilineText(state.body_text);
    if (LOGIN_URL_PATTERNS.some((pattern) => href.includes(pattern)))
      return true;
    return LOGIN_TEXT_PATTERNS.some((pattern) => title.includes(pattern) || bodyText.includes(pattern));
  }
  function buildCaptchaHint(action) {
    return [
      `Open a clean 1688 ${action} page in the shared Chrome profile and finish any slider challenge first.`,
      "If you run opencli via CDP, set OPENCLI_CDP_TARGET=1688.com or a more specific 1688 host before retrying."
    ].join(" ");
  }
  async function readPageState(page) {
    const result = await page.evaluate(`
    (() => ({
      href: window.location.href,
      title: document.title || '',
      body_text: document.body ? document.body.innerText || '' : '',
    }))()
  `);
    return {
      href: cleanText(result.href),
      title: cleanText(result.title),
      body_text: cleanMultilineText(result.body_text)
    };
  }
  async function gotoAndReadState(page, url, settleMs = 2500, action = "page") {
    try {
      await page.goto(url, { settleMs });
      await page.wait(1.5);
      return readPageState(page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Site redirected the requested page")) {
        try {
          const redirectedState = await readPageState(page);
          assertAuthenticatedState(redirectedState, action);
        } catch (stateError) {
          if (stateError instanceof AuthRequiredError) throw stateError;
        }
      }
      if (message.includes("Inspected target navigated or closed") || message.includes("Cannot find context with specified id") || message.includes("Target closed")) {
        throw new CommandExecutionError(`1688 ${action} navigation lost the current browser target`, `${buildCaptchaHint(action)} If CDP is attached to a stale or blocked tab, open a fresh 1688 tab and point OPENCLI_CDP_TARGET at that tab.`);
      }
      throw error;
    }
  }
  function assertAuthenticatedState(state, action) {
    if (!isCaptchaState(state) && !isLoginState(state))
      return;
    throw new AuthRequiredError("1688.com", `\u8BF7\u5148\u5728\u5171\u4EAB Chrome \u5B8C\u6210 1688 \u767B\u5F55/\u9A8C\u8BC1\uFF0C\u518D\u91CD\u8BD5\uFF08${action}\uFF09`);
  }
  function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.replace(/,/g, "").trim();
      if (!normalized)
        return null;
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  function normalizeMediaUrl(input) {
    const raw = cleanText(input);
    if (!raw)
      return "";
    let value = raw.replace(/^url\((.*)\)$/i, "$1").replace(/^['"]|['"]$/g, "").replace(/\\u002F/g, "/").replace(/&amp;/g, "&").trim();
    if (!value || value.startsWith("data:") || value.startsWith("blob:"))
      return "";
    if (value.startsWith("//"))
      value = `https:${value}`;
    try {
      const url = new URL(value);
      return url.toString();
    } catch {
      return "";
    }
  }
  function uniqueMediaSources(values) {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const value of values) {
      const url = normalizeMediaUrl(value.url);
      if (!url)
        continue;
      const key = `${value.type}:${url}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      result.push({
        ...value,
        url,
        source: cleanText(value.source) || void 0
      });
    }
    return result;
  }
  function normalizeNumericText(value) {
    return value.replace(/([¥$€])\s+(?=\d)/g, "$1").replace(/(\d)\s*\.\s*(\d)/g, "$1.$2").replace(/\s*([~-])\s*/g, "$1").trim();
  }
  function escapeForRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function parse1688Url(input) {
    const normalized = cleanText(input);
    try {
      const url = new URL(normalized);
      if (!url.hostname.endsWith(".1688.com") && url.hostname !== "1688.com" && url.hostname !== "www.1688.com") {
        throw new Error("invalid-host");
      }
      stripTrackingParams(url);
      url.hash = "";
      return url;
    } catch {
      throw new ArgumentError("Invalid 1688 URL", "Use a URL under 1688.com (for example: https://detail.1688.com/offer/887904326744.html)");
    }
  }
  function parse1688UrlOrNull(input) {
    try {
      return parse1688Url(input);
    } catch {
      return null;
    }
  }
  function normalizeStoreHost(hostname) {
    const lower = cleanText(hostname).toLowerCase();
    if (!lower.endsWith(".1688.com"))
      return null;
    const [subdomain] = lower.split(".");
    if (!subdomain || STORE_GENERIC_HOSTS.has(subdomain))
      return null;
    return lower;
  }
  function stripTrackingParams(url) {
    const keys = [...url.searchParams.keys()];
    for (const key of keys) {
      if (TRACKING_QUERY_KEYS.has(key) || key.toLowerCase().startsWith("utm_")) {
        url.searchParams.delete(key);
      }
    }
  }

  // webcli/scripts/opencli-wave5/upstream/1688/assets.js
  var DETAIL_CONTAINER_SELECTOR = ".de-description-detail, #detailContentContainer, .html-description, .desc-lazyload-container";
  function inDetailContainer(el, selector = DETAIL_CONTAINER_SELECTOR) {
    let node = el;
    while (node) {
      if (node.closest && node.closest(selector))
        return true;
      const rootNode = node.getRootNode ? node.getRootNode() : null;
      if (rootNode && rootNode.host) {
        const host = rootNode.host;
        if (host && host.matches && host.matches(selector))
          return true;
        node = host;
      } else {
        node = null;
      }
    }
    return false;
  }
  function scriptToReadAssets() {
    return `
    (() => {
      const root = window.context ?? {};
      const model = root.result?.global?.globalData?.model ?? null;
      const gallery = root.result?.data?.gallery?.fields ?? null;
      const defaultSrcProps = ['data-lazyload-src', 'data-src', 'data-ks-lazyload', 'currentSrc', 'src'];
      const groups = [
        { key: 'main', type: 'image', selectors: ['#dt-tab img', '.detail-gallery-turn img.detail-gallery-img', '.img-list-wrapper img.od-gallery-img', '.od-scroller-item span'] },
        { key: 'video', type: 'video', selectors: ['.lib-video video', 'video[src]', 'video source[src]'] },
        { key: 'sku', type: 'image', selectors: ['.pc-sku-wrapper .prop-item-inner-wrapper', '.sku-item-wrapper', '.specification-cell', '.sku-filter-button', '.expand-view-item', '.feature-item img'], srcProps: ['backgroundImage'] },
      ];
      const detailContainerSelector = ${JSON.stringify(DETAIL_CONTAINER_SELECTOR)};
      // Inject the module-level implementation rather than hand-copying it, so
      // the unit tests exercise the same code that runs in the page.
      const inDetailContainerImpl = ${inDetailContainer.toString()};
      const inDetailContainer = (el) => inDetailContainerImpl(el, detailContainerSelector);
      const assets = [];
      const seen = new Set();

      const normalizeUrl = (value) => {
        if (typeof value !== 'string') return '';
        let next = value
          .replace(/^url\\((.*)\\)$/i, '$1')
          .replace(/^['"]|['"]$/g, '')
          .replace(/\\\\u002F/g, '/')
          .replace(/&amp;/g, '&')
          .trim();
        if (!next || next.startsWith('blob:') || next.startsWith('data:')) return '';
        if (next.startsWith('//')) next = 'https:' + next;
        try {
          return new URL(next, location.href).toString();
        } catch {
          return '';
        }
      };

      const push = (type, group, url, source) => {
        const normalized = normalizeUrl(url);
        if (!normalized) return;
        const key = type + ':' + normalized;
        if (seen.has(key)) return;
        seen.add(key);
        assets.push({ type, group, url: normalized, source });
      };

      const queryAllDeep = (selector) => {
        const results = [];
        const visitedRoots = new Set();
        const walkRoots = (root, fn) => {
          if (!root || visitedRoots.has(root)) return;
          visitedRoots.add(root);
          fn(root);
          const childElements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
          for (const child of childElements) {
            if (child && child.shadowRoot) {
              walkRoots(child.shadowRoot, fn);
            }
          }
        };
        walkRoots(document, (root) => {
          if (root.querySelectorAll) {
            results.push(...Array.from(root.querySelectorAll(selector)));
          }
        });
        return results;
      };

      const valuesFromElement = (element, srcProps) => {
        const values = [];
        const props = srcProps && srcProps.length ? srcProps : defaultSrcProps;
        for (const prop of props) {
          try {
            if (prop === 'backgroundImage') {
              const bg = getComputedStyle(element).backgroundImage || '';
              const matches = bg.match(/url\\(([^)]+)\\)/g) || [];
              for (const match of matches) {
                const clean = match.replace(/^url\\(/, '').replace(/\\)$/, '');
                values.push(clean);
              }
              continue;
            }

            const direct = element[prop];
            if (typeof direct === 'string' && direct) values.push(direct);
            const attr = element.getAttribute ? element.getAttribute(prop) : '';
            if (attr) values.push(attr);
          } catch {}
        }

        if (element.tagName === 'SOURCE' && element.parentElement?.tagName === 'VIDEO') {
          values.push(element.src || element.getAttribute('src') || '');
        }

        if (element.tagName === 'VIDEO') {
          values.push(element.currentSrc || '');
          values.push(element.src || '');
        }

        return values;
      };

      for (const group of groups) {
        for (const selector of group.selectors) {
          for (const element of queryAllDeep(selector)) {
            for (const value of valuesFromElement(element, group.srcProps)) {
              push(group.type, group.key, value, 'dom:' + selector);
            }
          }
        }
      }

      // \u8BE6\u60C5\u533A\u7D20\u6750\uFF1A\u5168\u91CF\u6536\u96C6 img/source\uFF08\u7A7F\u900F shadowRoot\uFF09+ host \u94FE\u5F52\u5C5E\u5224\u65AD
      for (const element of [...queryAllDeep('img'), ...queryAllDeep('source')]) {
        if (!inDetailContainer(element)) continue;
        for (const value of valuesFromElement(element)) {
          push('image', 'detail', value, 'shadow:html-description');
        }
      }

      const scriptTexts = Array.from(document.scripts).map((script) => script.textContent || '');
      const videoRegex = /https?:\\/\\/[^"'\\s]+\\.(?:mp4|m3u8)(?:\\?[^"'\\s]*)?/gi;
      for (const scriptText of scriptTexts) {
        const matches = scriptText.match(videoRegex) || [];
        for (const match of matches) {
          push('video', 'video', match, 'script');
        }
      }

      const toJson = (value) => JSON.parse(JSON.stringify(value ?? null));
      return {
        href: window.location.href,
        title: document.title || '',
        offerTitle: model?.offerTitleModel?.subject ?? '',
        offerId: model?.tradeModel?.offerId ?? '',
        gallery: toJson(gallery),
        scannedAssets: assets,
      };
    })()
  `;
  }
  function normalizeAssets(payload) {
    const offerId = cleanText(String(payload.offerId ?? "")) || extractOfferId(cleanText(payload.href)) || null;
    const itemUrl = offerId ? buildDetailUrl(offerId) : cleanText(payload.href);
    const seededAssets = [
      ...(payload.gallery?.mainImage ?? []).map((url) => ({ type: "image", group: "main", url, source: "page_state:mainImage" })),
      ...(payload.gallery?.offerImgList ?? []).map((url) => ({ type: "image", group: "main", url, source: "page_state:offerImgList" })),
      ...(payload.gallery?.wlImageInfos ?? []).map((item) => ({
        type: "image",
        group: "main",
        url: item?.fullPathImageURI ?? "",
        source: "page_state:wlImageInfos"
      }))
    ];
    const assets = uniqueMediaSources([...seededAssets, ...payload.scannedAssets ?? []]);
    const mainImages = assets.filter((item) => item.type === "image" && item.group === "main").map((item) => item.url);
    const skuImages = assets.filter((item) => item.type === "image" && item.group === "sku").map((item) => item.url);
    const detailImages = assets.filter((item) => item.type === "image" && item.group === "detail").map((item) => item.url);
    const videos = assets.filter((item) => item.type === "video").map((item) => item.url);
    const otherImages = assets.filter((item) => item.type === "image" && !["main", "sku", "detail"].includes(item.group)).map((item) => item.url);
    return {
      offer_id: offerId,
      title: cleanText(payload.offerTitle) || cleanText(payload.title) || null,
      display_title: cleanText(payload.offerTitle) || cleanText(payload.title) || itemUrl,
      item_url: itemUrl,
      main_images: mainImages,
      sku_images: skuImages,
      detail_images: detailImages,
      videos,
      other_images: otherImages,
      raw_assets: assets,
      source: [...new Set(assets.map((item) => cleanText(item.source)).filter(Boolean))],
      main_count: mainImages.length,
      sku_count: skuImages.length,
      detail_count: detailImages.length,
      video_count: videos.length,
      ...buildProvenance(cleanText(payload.href) || itemUrl)
    };
  }
  async function readAssetsPayload(page, itemUrl) {
    const state = await gotoAndReadState(page, itemUrl, 2500, "assets");
    assertAuthenticatedState(state, "assets");
    await page.autoScroll({ times: 6, delayMs: 500 });
    await page.evaluate(`(() => {
      const el = document.querySelector('.html-description, v-detail-e, .de-description-detail, #detailContentContainer');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    })()`);
    await waitForDetailImages(page);
    return await page.evaluate(scriptToReadAssets());
  }
  async function waitForDetailImages(page, { attempts = 10, intervalSeconds = 0.5 } = {}) {
    const countJs = `(() => {
      const sel = ${JSON.stringify(DETAIL_CONTAINER_SELECTOR)};
      let total = 0;
      const walk = (root) => {
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) walk(node.shadowRoot);
        }
        for (const host of root.querySelectorAll(sel)) {
          total += host.querySelectorAll('img, source').length;
          if (host.shadowRoot) total += host.shadowRoot.querySelectorAll('img, source').length;
        }
      };
      walk(document);
      return total;
    })()`;
    let previous = -1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let current = 0;
      try {
        current = Number(await page.evaluate(countJs)) || 0;
      } catch {
        return;
      }
      if (current > 0 && current === previous)
        return;
      previous = current;
      await page.wait(intervalSeconds);
    }
  }
  async function extractAssetsForInput(page, input) {
    const itemUrl = buildDetailUrl(String(input ?? ""));
    const payload = await readAssetsPayload(page, itemUrl);
    return normalizeAssets(payload);
  }
  cli({
    site: "1688",
    name: "assets",
    access: "read",
    description: "\u5217\u51FA 1688 \u5546\u54C1\u9875\u53EF\u63D0\u53D6\u7684\u56FE\u7247/\u89C6\u9891\u7D20\u6750",
    domain: "www.1688.com",
    strategy: Strategy.COOKIE,
    args: [
      {
        name: "input",
        required: true,
        positional: true,
        help: "1688 \u5546\u54C1 URL \u6216 offer ID\uFF08\u5982 887904326744\uFF09"
      }
    ],
    columns: ["offer_id", "title", "main_count", "sku_count", "detail_count", "video_count"],
    func: async (page, kwargs) => {
      return [await extractAssetsForInput(page, String(kwargs.input ?? ""))];
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

  // webcli/scripts/opencli-wave5/upstream/1688/auth.js
  async function has1688LogonCookie(page) {
    let cookies;
    try {
      cookies = await page.getCookies({ url: "https://www.1688.com" });
    } catch (error) {
      if (String(error?.message || error).includes("Runtime helper URL host")) {
        return false;
      }
      throw error;
    }
    return cookies.some((c) => c.name === "__cn_logon__" && c.value === "true");
  }
  async function verify1688Identity(page) {
    await page.goto("https://www.1688.com/");
    await page.wait(2);
    let cookies;
    try {
      cookies = await page.getCookies({ url: "https://www.1688.com" });
    } catch (error) {
      if (String(error?.message || error).includes("Runtime helper URL host")) {
        throw new AuthRequiredError("1688.com", "请先在共享 Chrome 完成 1688 登录/验证，再重试（whoami）");
      }
      throw error;
    }
    const cookieMap = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    if (cookieMap["__cn_logon__"] !== "true") {
      throw new AuthRequiredError("1688.com", "1688 __cn_logon__ cookie absent after navigation");
    }
    const unb = cookieMap["unb"] || "";
    if (!unb) {
      throw new AuthRequiredError("1688.com", "1688 unb cookie missing \u2014 partial logged-in state");
    }
    let name = "";
    try {
      name = cookieMap["lid"] ? decodeURIComponent(cookieMap["lid"]) : "";
    } catch {
      name = cookieMap["lid"] || "";
    }
    return { user_id: String(unb), name };
  }
  registerSiteAuthCommands({
    site: "1688",
    domain: "1688.com",
    loginUrl: "https://login.1688.com/member/signin.htm",
    columns: ["user_id", "name"],
    quickCheck: has1688LogonCookie,
    verify: verify1688Identity,
    poll: async (page) => {
      if (!await has1688LogonCookie(page)) {
        throw new AuthRequiredError("1688.com", "Waiting for 1688 __cn_logon__=true cookie");
      }
      return verify1688Identity(page);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/1688/download.js
  function extFromUrl(url, fallback) {
    try {
      const ext = (new URL(url).pathname.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0].toLowerCase();
      if (ext && ext.length <= 8)
        return ext;
    } catch {
    }
    return fallback;
  }
  function toDownloadItems(offerId, assets) {
    const items = [];
    const pushImages = (urls, prefix) => {
      urls.forEach((url, index) => {
        items.push({
          type: "image",
          url,
          filename: `${offerId}_${prefix}_${String(index + 1).padStart(2, "0")}${extFromUrl(url, ".jpg")}`
        });
      });
    };
    pushImages(assets.main_images, "main");
    pushImages(assets.sku_images, "sku");
    pushImages(assets.detail_images, "detail");
    pushImages(assets.other_images, "other");
    assets.videos.forEach((url, index) => {
      items.push({
        type: "video",
        url,
        filename: `${offerId}_video_${String(index + 1).padStart(2, "0")}${extFromUrl(url, ".mp4")}`
      });
    });
    return items;
  }
  cli({
    site: "1688",
    name: "download",
    access: "read",
    description: "\u5217\u51FA 1688 \u5546\u54C1\u9875\u53EF\u63D0\u53D6\u7684\u56FE\u7247\u548C\u89C6\u9891\u7D20\u6750\uFF08URL \u4E0E\u6587\u4EF6\u540D\uFF0C\u4E0D\u843D\u76D8\uFF09",
    domain: "www.1688.com",
    strategy: Strategy.COOKIE,
    args: [
      {
        name: "input",
        required: true,
        positional: true,
        help: "1688 \u5546\u54C1 URL \u6216 offer ID\uFF08\u5982 887904326744\uFF09"
      }
    ],
    columns: ["index", "type", "url", "filename"],
    func: async (page, kwargs) => {
      const assets = await extractAssetsForInput(page, String(kwargs.input ?? ""));
      const offerId = cleanText(assets.offer_id) || "1688";
      const items = toDownloadItems(offerId, assets);
      if (items.length === 0) {
        return [];
      }
      return items.map((item, index) => ({ index: index + 1, ...item }));
    }
  });

  // webcli/scripts/opencli-wave5/utils.js
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // webcli/scripts/opencli-wave5/upstream/1688/item.js
  function normalizeItemPayload(payload) {
    const href = cleanText(payload.href);
    const bodyText = cleanMultilineText(payload.bodyText);
    const sellerName = cleanText(payload.seller?.companyName);
    const sellerUrlRaw = cleanText(payload.seller?.winportUrl ?? payload.seller?.sellerWinportUrlMap?.defaultUrl ?? payload.seller?.sellerWinportUrlMap?.indexUrl);
    const sellerUrl = canonicalizeSellerUrl(sellerUrlRaw);
    const offerId = cleanText(String(payload.offerId ?? "")) || extractOfferId(href) || null;
    const memberId = cleanText(payload.seller?.memberId) || extractMemberId(sellerUrlRaw || href) || null;
    const shopId = extractShopId(sellerUrl ?? href);
    const unit = cleanText(payload.trade?.unit);
    const priceDisplay = cleanText(payload.trade?.priceDisplay);
    const priceRange = parsePriceText(priceDisplay ? `\xA5${priceDisplay}` : bodyText);
    const moqText = extractMoqText(bodyText, payload.trade?.beginAmount, unit);
    const moq = parseMoqText(moqText);
    const services = uniqueServices(payload);
    const serviceBadges = uniqueNonEmpty(services.map((service) => cleanText(service.serviceName)));
    const attributes = normalizeVisibleAttributes(payload.trade?.offerIDatacenterSellInfo);
    const priceTiers = normalizePriceTiers(payload.trade?.offerPriceModel?.currentPrices ?? [], unit || null);
    const images = uniqueNonEmpty([
      ...payload.gallery?.mainImage ?? [],
      ...payload.gallery?.offerImgList ?? [],
      ...(payload.gallery?.wlImageInfos ?? []).map((item) => item.fullPathImageURI ?? "")
    ]);
    const detailUrl = offerId ? buildDetailUrl(offerId) : href;
    const provenance = buildProvenance(href || detailUrl);
    return {
      offer_id: offerId,
      member_id: memberId,
      shop_id: shopId,
      title: cleanText(payload.offerTitle) || stripAlibabaSuffix(payload.title) || firstNonEmptyLine(bodyText) || null,
      display_title: cleanText(payload.offerTitle) || stripAlibabaSuffix(payload.title) || firstNonEmptyLine(bodyText) || detailUrl,
      item_url: detailUrl,
      main_images: images,
      price_text: priceRange.price_text || null,
      price_tiers: priceTiers,
      currency: priceRange.currency,
      moq_text: moq.moq_text || null,
      moq_value: moq.moq_value,
      seller_name: sellerName || null,
      seller_url: sellerUrl,
      shop_name: sellerName || null,
      origin_place: extractLocation(bodyText),
      delivery_days_text: extractDeliveryDaysText(bodyText, services, payload.shipping),
      customization_text: extractKeywordLine(bodyText, ["\u6765\u6837\u5B9A\u5236", "\u6765\u56FE\u5B9A\u5236", "\u652F\u6301\u5B9A\u5236", "\u53EF\u5B9A\u5236", "\u5B9A\u5236"]),
      private_label_text: extractKeywordLine(bodyText, ["\u8D34\u724C", "\u8D34\u6807", "\u5B9A\u5236logo", "\u6253logo", "OEM", "ODM"]),
      visible_attributes: attributes,
      sales_text: extractSalesText(bodyText),
      service_badges: serviceBadges,
      stock_quantity: extractStockQuantity(bodyText),
      ...provenance
    };
  }
  function normalizeVisibleAttributes(raw) {
    if (!isRecord(raw))
      return [];
    return Object.entries(raw).filter(([key, value]) => key !== "sellPointModel" && cleanText(key) && cleanText(String(value))).map(([key, value]) => ({ key: cleanText(key), value: cleanText(String(value)) }));
  }
  function uniqueServices(payload) {
    const combined = [
      ...Array.isArray(payload.services) ? payload.services : [],
      ...Array.isArray(payload.shipping?.protectionInfos) ? payload.shipping.protectionInfos : [],
      ...Array.isArray(payload.shipping?.buyerProtectionModel) ? payload.shipping.buyerProtectionModel : []
    ];
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const service of combined) {
      const key = cleanText(service.serviceName);
      if (!key || seen.has(key))
        continue;
      seen.add(key);
      result.push(service);
    }
    return result;
  }
  function stripAlibabaSuffix(title) {
    return cleanText(title).replace(/\s*-\s*阿里巴巴$/, "").trim();
  }
  function firstNonEmptyLine(text) {
    return text.split("\n").map((line) => cleanText(line)).find(Boolean) ?? "";
  }
  function extractMoqText(bodyText, beginAmount, unit) {
    const lineMatch = bodyText.match(/\d+(?:\.\d+)?\s*(件|个|套|箱|包|双|台|把|只)\s*起批/);
    if (lineMatch)
      return lineMatch[0];
    const moqValue = toNumber(beginAmount);
    if (moqValue !== null) {
      return `${moqValue}${unit || ""}\u8D77\u6279`;
    }
    return "";
  }
  function extractDeliveryDaysText(bodyText, services, shipping) {
    const shippingText = cleanText(shipping?.deliveryLimitText) || cleanText(shipping?.logisticsText);
    if (shippingText)
      return shippingText;
    const textMatch = bodyText.match(/\d+\s*(?:小时|天)(?:内)?发货/);
    if (textMatch)
      return textMatch[0];
    const hourMatch = services.find((service) => typeof service.agreeDeliveryHours === "number");
    if (hourMatch && typeof hourMatch.agreeDeliveryHours === "number") {
      return `${hourMatch.agreeDeliveryHours}\u5C0F\u65F6\u5185\u53D1\u8D27`;
    }
    return null;
  }
  function extractKeywordLine(bodyText, keywords) {
    const lines = bodyText.split("\n").map((line) => cleanText(line)).filter(Boolean);
    for (const line of lines) {
      if (keywords.some((keyword) => line.includes(keyword))) {
        return line;
      }
    }
    return null;
  }
  function extractSalesText(bodyText) {
    const match = bodyText.match(/(?:全网销量|已售)\s*\d+(?:\.\d+)?\+?\s*[件套个单]?/);
    return match ? cleanText(match[0]) : null;
  }
  function extractStockQuantity(bodyText) {
    const match = bodyText.match(/库存\s*(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
  }
  async function readItemPayload(page, itemUrl) {
    const state = await gotoAndReadState(page, itemUrl, 2500, "item");
    assertAuthenticatedState(state, "item");
    const payload = await page.evaluate(`
    (() => {
      const root = window.context ?? {};
      const model = root.result?.global?.globalData?.model ?? null;
      const toJson = (value) => JSON.parse(JSON.stringify(value ?? null));
      return {
        href: window.location.href,
        title: document.title || '',
        bodyText: document.body ? document.body.innerText || '' : '',
        offerTitle: model?.offerTitleModel?.subject ?? '',
        offerId: model?.tradeModel?.offerId ?? '',
        seller: toJson(model?.sellerModel),
        trade: toJson(model?.tradeModel),
        gallery: toJson(root.result?.data?.gallery?.fields ?? null),
        shipping: toJson(root.result?.data?.shippingServices?.fields ?? null),
        services: toJson(root.result?.data?.shippingServices?.fields?.protectionInfos ?? []),
      };
    })()
  `);
    const resolvedOfferId = cleanText(String(payload.offerId ?? "")) || extractOfferId(cleanText(payload.href));
    if (!resolvedOfferId) {
      throw new CommandExecutionError("1688 item page did not expose product context", "\u5F53\u524D tab \u975E\u5546\u54C1\u8BE6\u60C5\u4E0A\u4E0B\u6587\uFF0C\u8BF7\u5207\u5230 detail.1688.com \u5546\u54C1\u9875\u5E76\u91CD\u8BD5");
    }
    return payload;
  }
  cli({
    site: "1688",
    name: "item",
    access: "read",
    description: "1688 \u5546\u54C1\u8BE6\u60C5\uFF08\u516C\u5F00\u5546\u54C1\u5B57\u6BB5\u3001\u4EF7\u683C\u9636\u68AF\u3001\u5356\u5BB6\u57FA\u7840\u4FE1\u606F\uFF09",
    domain: "www.1688.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      {
        name: "input",
        required: true,
        positional: true,
        help: "1688 \u5546\u54C1 URL \u6216 offer ID\uFF08\u5982 887904326744\uFF09"
      }
    ],
    columns: ["offer_id", "title", "price_text", "moq_text", "seller_name", "origin_place"],
    func: async (page, kwargs) => {
      const itemUrl = buildDetailUrl(String(kwargs.input ?? ""));
      const payload = await readItemPayload(page, itemUrl);
      return [normalizeItemPayload(payload)];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/1688/search.js
  var SEARCH_ITEM_URL_PATTERNS = [
    "detail.1688.com/offer/",
    "detail.m.1688.com/page/index.html?offerId="
  ];
  var MAX_SEARCH_PAGES = 12;
  function normalizeSearchCandidate(candidate, sourceUrl) {
    const canonicalItemUrl = canonicalizeItemUrl(cleanText(candidate.item_url));
    const containerText = cleanText(candidate.container_text);
    const priceText = firstNonEmpty([
      normalizeInlineText(candidate.price_text),
      normalizeInlineText(extractPriceText(candidate.hover_price_text))
    ]);
    const priceRange = parsePriceText(priceText || containerText);
    const moq = parseMoqText(firstNonEmpty([
      normalizeInlineText(candidate.moq_text),
      normalizeInlineText(extractMoqText2(containerText))
    ]));
    const canonicalSellerUrl = canonicalizeSellerUrl(cleanText(candidate.seller_url));
    const evidenceText = uniqueNonEmpty([
      containerText,
      ...candidate.desc_rows ?? [],
      ...candidate.tag_items ?? [],
      ...candidate.hover_items ?? []
    ]).join("\n");
    const badges = extractBadges(evidenceText, [...FACTORY_BADGE_PATTERNS, ...SERVICE_BADGE_PATTERNS]);
    const salesText = firstNonEmpty([
      extractSalesText2(candidate.sales_text),
      extractSalesText2(containerText)
    ]);
    const returnRateText = extractReturnRateText([...candidate.tag_items ?? [], ...candidate.hover_items ?? []]);
    const provenance = buildProvenance(sourceUrl);
    return {
      rank: 0,
      offer_id: extractOfferId(canonicalItemUrl ?? "") ?? null,
      member_id: extractMemberId(canonicalSellerUrl ?? "") ?? null,
      shop_id: extractShopId(canonicalSellerUrl ?? "") ?? null,
      title: cleanText(candidate.title) || firstWord(containerText) || null,
      display_title: cleanText(candidate.title) || firstWord(containerText) || canonicalItemUrl,
      item_url: canonicalItemUrl,
      seller_name: cleanText(candidate.seller_name) || null,
      seller_url: canonicalSellerUrl,
      price_text: priceRange.price_text || null,
      price_min: priceRange.price_min,
      price_max: priceRange.price_max,
      currency: priceRange.currency,
      moq_text: moq.moq_text || null,
      moq_value: moq.moq_value,
      location: extractLocation(containerText),
      badges,
      sales_text: salesText || null,
      return_rate_text: returnRateText,
      source_url: provenance.source_url,
      fetched_at: provenance.fetched_at,
      strategy: provenance.strategy
    };
  }
  function extractMoqText2(text) {
    const normalized = normalizeInlineText(text);
    return normalized.match(/\d+(?:\.\d+)?\s*(件|个|套|箱|包|双|台|把|只)\s*起批/i)?.[0] ?? normalized.match(/≥\s*\d+(?:\.\d+)?\s*(件|个|套|箱|包|双|台|把|只)?/i)?.[0] ?? normalized.match(/\d+(?:\.\d+)?\s*(?:~|-|至|到)\s*\d+(?:\.\d+)?\s*(件|个|套|箱|包|双|台|把|只)/i)?.[0] ?? "";
  }
  function extractPriceText(text) {
    const normalized = normalizeInlineText(text);
    return normalized.match(/[¥$€]\s*\d+(?:\.\d+)?/)?.[0] ?? "";
  }
  function extractSalesText2(text) {
    const normalized = normalizeInlineText(text);
    if (!normalized)
      return "";
    if (/^\d+(?:\.\d+)?\+?\s*(件|套|个|单)$/.test(normalized)) {
      return normalized;
    }
    const match = normalized.match(/(?:已售|销量|售)\s*\d+(?:\.\d+)?\+?\s*(件|套|个|单)?/);
    return match ? cleanText(match[0]) : "";
  }
  function firstWord(text) {
    return text.split(/\s+/).find(Boolean) ?? "";
  }
  function firstNonEmpty(values) {
    return values.map((value) => cleanText(value)).find(Boolean) ?? "";
  }
  function normalizeInlineText(text) {
    return cleanText(text).replace(/([¥$€])\s+(?=\d)/g, "$1").replace(/(\d)\s*\.\s*(\d)/g, "$1.$2").replace(/\s*([~-])\s*/g, "$1").trim();
  }
  function extractReturnRateText(values) {
    return uniqueNonEmpty(values.map((value) => normalizeInlineText(value))).find((value) => /^回头率\s*\d+(?:\.\d+)?%$/.test(value)) ?? null;
  }
  function buildDedupeKey(row) {
    if (row.offer_id)
      return `offer:${row.offer_id}`;
    if (row.item_url)
      return `url:${row.item_url}`;
    return null;
  }
  async function submitHomepageSearch(page, query) {
    const submitted = await page.evaluateWithArgs(`
      (async () => {
        const keyword = String(query || '').trim();
        const input = document.querySelector('#alisearch-input, textarea[name="keywords"], input[name="keywords"]');
        if (!keyword || !input) return false;
        input.focus();
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, keyword);
        else input.value = keyword;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const form = input.closest('form');
        const button = document.querySelector('button.searchBtn--bnk9giWe, button[type="submit"], input[type="submit"]');
        if (button) {
          button.click();
          return true;
        }
        if (form) {
          form.requestSubmit ? form.requestSubmit() : form.submit();
          return true;
        }
        return false;
      })()
    `, { query });
    if (!submitted) {
      throw new CommandExecutionError("1688 homepage search box was not found", "Open https://www.1688.com/ and verify the search box is visible before retrying.");
    }
    await page.wait(3);
  }
  async function readSearchPayload(page, url) {
    const state = await gotoAndReadState(page, url, 2500, "search");
    assertAuthenticatedState(state, "search");
    const query = (() => {
      try {
        return new URL(url).searchParams.get("keywords") || "";
      } catch {
        return "";
      }
    })();
    if (query && /^https:\/\/www\.1688\.com\/?$/i.test(state.href)) {
      await submitHomepageSearch(page, query);
      const afterSubmit = await readPageState(page);
      assertAuthenticatedState(afterSubmit, "search");
    }
    const payload = await page.evaluate(`
    (() => {
      const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const normalizeUrl = (href) => {
        if (!href) return '';
        try {
          return new URL(href, window.location.href).toString();
        } catch {
          return '';
        }
      };
      const isItemHref = (href) => ${JSON.stringify(SEARCH_ITEM_URL_PATTERNS)}
        .some((pattern) => (href || '').includes(pattern));
      const uniqueTexts = (values) => [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
      const collectTexts = (root, selector) => uniqueTexts(
        Array.from(root.querySelectorAll(selector)).map((node) => node.innerText || node.textContent || ''),
      );
      const firstText = (root, selectors) => {
        for (const selector of selectors) {
          const node = root.querySelector(selector);
          const value = normalizeText(node ? node.innerText || node.textContent || '' : '');
          if (value) return value;
        }
        return '';
      };
      const findMoqText = (values, priceText) => {
        const moqPattern = /(\u2265\\s*\\d+(?:\\.\\d+)?\\s*(\u4EF6|\u4E2A|\u5957|\u7BB1|\u5305|\u53CC|\u53F0|\u628A|\u53EA)?)|(\\d+(?:\\.\\d+)?\\s*(?:~|-|\u81F3|\u5230)\\s*\\d+(?:\\.\\d+)?\\s*(\u4EF6|\u4E2A|\u5957|\u7BB1|\u5305|\u53CC|\u53F0|\u628A|\u53EA))|(\\d+(?:\\.\\d+)?\\s*(\u4EF6|\u4E2A|\u5957|\u7BB1|\u5305|\u53CC|\u53F0|\u628A|\u53EA)\\s*\u8D77\u6279)/i;
        return values.find((value) => moqPattern.test(value))
          || normalizeText(priceText).match(moqPattern)?.[0]
          || '';
      };
      const isSellerHref = (href) => {
        if (!href) return false;
        try {
          const url = new URL(href, window.location.href);
          const host = url.hostname || '';
          if (!host.endsWith('.1688.com')) return false;
          if (
            host === 's.1688.com'
            || host === 'r.1688.com'
            || host === 'air.1688.com'
            || host === 'detail.1688.com'
            || host === 'detail.m.1688.com'
            || host === 'dj.1688.com'
          ) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      };
      const pickContainer = (anchor) => {
        let node = anchor;
        while (node && node !== document.body) {
          const text = normalizeText(node.innerText || node.textContent || '');
          if (text.length >= 40 && text.length <= 2000) {
            return node;
          }
          node = node.parentElement;
        }
        return anchor;
      };
      const collectCandidates = () => {
        const anchors = Array.from(document.querySelectorAll('a')).filter((anchor) => isItemHref(anchor.href || ''));
        const seen = new Set();
        const items = [];
        for (const anchor of anchors) {
          const href = anchor.href || '';
          if (!href || seen.has(href)) continue;
          seen.add(href);

          const container = pickContainer(anchor);
          const tagItems = collectTexts(container, '.offer-tag-row .offer-desc-item');
          const hoverItems = collectTexts(container, '.offer-hover-wrapper .offer-desc-item');
          const sellerAnchor = Array.from(container.querySelectorAll('a'))
            .find((link) => isSellerHref(link.href || ''));
          const hoverPriceText = firstText(container, [
            '.offer-hover-wrapper .hover-price-item',
            '.offer-hover-wrapper .price-item',
          ]);

          items.push({
            item_url: href,
            title: firstText(container, ['.offer-title-row .title-text', '.offer-title-row'])
              || normalizeText(anchor.innerText || anchor.textContent || ''),
            container_text: normalizeText(container.innerText || container.textContent || ''),
            desc_rows: collectTexts(container, '.offer-desc-row'),
            price_text: firstText(container, ['.offer-price-row .price-item']),
            sales_text: firstText(container, ['.offer-price-row .col-desc_after', '.offer-desc-row .col-desc_after']),
            hover_price_text: hoverPriceText,
            moq_text: findMoqText(hoverItems, hoverPriceText),
            tag_items: tagItems,
            hover_items: hoverItems,
            seller_name: sellerAnchor ? normalizeText(sellerAnchor.innerText || sellerAnchor.textContent || '') : null,
            seller_url: sellerAnchor ? sellerAnchor.href : null,
          });
        }
        return items;
      };
      const findNextUrl = () => {
        const selectors = [
          'a.fui-next:not(.disabled)',
          'a.next-pagination-item:not(.disabled)',
          'a[rel="next"]:not(.disabled)',
          'a[data-role="next"]:not(.disabled)',
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) continue;
          const href = normalizeUrl(node.getAttribute('href') || node.href || '');
          if (href) return href;
        }
        const textBased = Array.from(document.querySelectorAll('a'))
          .find((node) => /\u4E0B\u4E00\u9875|next/i.test(normalizeText(node.textContent || '')));
        if (!textBased) return '';
        return normalizeUrl(textBased.getAttribute('href') || textBased.href || '');
      };

      return {
        href: window.location.href,
        title: document.title || '',
        bodyText: document.body ? document.body.innerText || '' : '',
        next_url: findNextUrl(),
        candidates: collectCandidates(),
      };
    })()
  `);
    if (!payload || typeof payload !== "object") {
      throw new CommandExecutionError("1688 search page did not return a readable payload", "Open the same query in Chrome and verify the page is fully loaded before retrying.");
    }
    return payload;
  }
  async function collectSearchRows(page, query, limit) {
    const rowsByKey = /* @__PURE__ */ new Map();
    const seenPages = /* @__PURE__ */ new Set();
    let nextUrl = buildSearchUrl(query);
    let pageCount = 0;
    while (nextUrl && rowsByKey.size < limit && pageCount < MAX_SEARCH_PAGES) {
      if (seenPages.has(nextUrl))
        break;
      seenPages.add(nextUrl);
      pageCount += 1;
      const payload = await readSearchPayload(page, nextUrl);
      const sourceUrl = cleanText(payload.href) || nextUrl;
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      for (const candidate of candidates) {
        const row = normalizeSearchCandidate(candidate, sourceUrl);
        const dedupeKey = buildDedupeKey(row);
        if (!dedupeKey || rowsByKey.has(dedupeKey))
          continue;
        rowsByKey.set(dedupeKey, row);
        if (rowsByKey.size >= limit)
          break;
      }
      const candidateNextUrl = cleanText(payload.next_url);
      if (!candidateNextUrl || candidateNextUrl === sourceUrl)
        break;
      nextUrl = candidateNextUrl;
    }
    if (rowsByKey.size === 0) {
      throw new EmptyResultError("1688 search", "No visible results were extracted. Retry with a different query or open the same search page in Chrome first.");
    }
    return [...rowsByKey.values()].slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
  }
  cli({
    site: "1688",
    name: "search",
    access: "read",
    description: "1688 \u5546\u54C1\u641C\u7D22\uFF08\u7ED3\u679C\u5019\u9009\u3001\u5356\u5BB6\u94FE\u63A5\u3001\u4EF7\u683C/MOQ/\u9500\u91CF\u6587\u672C\uFF09",
    domain: "www.1688.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      {
        name: "query",
        required: true,
        positional: true,
        help: '\u641C\u7D22\u5173\u952E\u8BCD\uFF0C\u5982 "\u7F6E\u7269\u67B6"'
      },
      {
        name: "limit",
        type: "int",
        default: SEARCH_LIMIT_DEFAULT,
        help: `\u7ED3\u679C\u6570\u91CF\u4E0A\u9650\uFF08\u9ED8\u8BA4 ${SEARCH_LIMIT_DEFAULT}\uFF0C\u6700\u5927 ${SEARCH_LIMIT_MAX}\uFF09`
      }
    ],
    columns: ["rank", "offer_id", "title", "item_url", "price_text", "moq_text", "seller_name", "member_id", "location"],
    func: async (page, kwargs) => {
      const query = String(kwargs.query ?? "");
      const limit = parseSearchLimit(kwargs.limit);
      return collectSearchRows(page, query, limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/1688/store.js
  function normalizeStorePayload(input) {
    const storePayload = input.storePayload;
    const contactPayload = input.contactPayload;
    const seed = input.seed;
    const contactText = cleanMultilineText(contactPayload?.bodyText);
    const storeText = cleanMultilineText(storePayload?.bodyText);
    const seedText = cleanMultilineText(seed?.bodyText);
    const combinedText = [contactText, storeText, seedText].filter(Boolean).join("\n");
    const sellerUrlRaw = cleanText(seed?.seller?.winportUrl ?? seed?.seller?.sellerWinportUrlMap?.defaultUrl ?? storePayload?.href ?? input.resolvedUrl);
    const storeUrl = safeCanonicalStoreUrl(sellerUrlRaw || input.resolvedUrl) ?? input.resolvedUrl;
    const sellerUrl = canonicalizeSellerUrl(sellerUrlRaw) ?? storeUrl;
    const companyUrl = pickCompanyUrl(contactPayload?.href, storeUrl);
    const memberId = cleanText(seed?.seller?.memberId) || input.explicitMemberId || extractMemberId(input.resolvedUrl) || extractMemberId(storePayload?.href ?? "") || null;
    const shopId = extractShopId(sellerUrl) ?? extractShopId(storeUrl);
    const companyName = cleanText(seed?.seller?.companyName) || firstNamedLine(contactText) || firstNamedLine(storeText) || null;
    const serviceBadges = uniqueNonEmpty([
      ...extractBadges(combinedText, SERVICE_BADGE_PATTERNS),
      ...(seed?.services ?? []).map((service) => cleanText(service.serviceName))
    ]);
    const factoryBadges = extractBadges(combinedText, FACTORY_BADGE_PATTERNS);
    return {
      member_id: memberId,
      shop_id: shopId,
      store_name: companyName,
      store_url: storeUrl,
      company_name: companyName,
      company_url: companyUrl,
      business_model_text: firstMetric(combinedText, ["\u7ECF\u8425\u6A21\u5F0F", "\u751F\u4EA7\u52A0\u5DE5", "\u4E3B\u8425\u4EA7\u54C1"]),
      years_on_platform_text: extractYearsOnPlatform(combinedText),
      location: extractAddress(contactText) ?? extractAddress(storeText),
      staff_size_text: firstMetric(combinedText, ["\u5458\u5DE5\u4EBA\u6570", "\u5458\u5DE5\u603B\u6570"]),
      factory_badges: factoryBadges,
      service_badges: serviceBadges,
      response_rate_text: firstMetric(combinedText, ["\u54CD\u5E94\u7387", "\u56DE\u590D\u7387", "\u54CD\u5E94\u901F\u5EA6"]),
      return_rate_text: extractReturnRate(combinedText),
      top_categories: guessTopCategories(combinedText),
      phone_text: extractMetric(contactText, "\u7535\u8BDD"),
      mobile_text: extractMetric(contactText, "\u624B\u673A"),
      ...buildProvenance(cleanText(contactPayload?.href) || cleanText(storePayload?.href) || input.resolvedUrl)
    };
  }
  function safeCanonicalStoreUrl(url) {
    try {
      return canonicalizeStoreUrl(url);
    } catch {
      return null;
    }
  }
  function pickCompanyUrl(contactHref, storeUrl) {
    const fromPage = cleanText(contactHref);
    if (fromPage) {
      const normalized = buildContactUrl(fromPage);
      if (normalized)
        return normalized;
    }
    return buildContactUrl(storeUrl);
  }
  function buildContactUrl(storeUrl) {
    try {
      const parsed = new URL(storeUrl);
      if (!parsed.hostname.endsWith(".1688.com"))
        return null;
      return `${parsed.protocol}//${parsed.hostname}/page/contactinfo.html`;
    } catch {
      return null;
    }
  }
  function firstNamedLine(text) {
    return text.split("\n").map((line) => cleanText(line)).find((line) => line.includes("\u6709\u9650\u516C\u53F8") || line.includes("\u5546\u884C") || line.includes("\u5DE5\u5382")) ?? null;
  }
  function firstMetric(text, labels) {
    for (const label of labels) {
      const value = extractMetric(text, label);
      if (value)
        return value;
    }
    return null;
  }
  function extractReturnRate(text) {
    const inline = text.match(/回头率\s*([0-9.]+%)/);
    if (inline)
      return cleanText(inline[0]);
    const multiline = text.match(/回头率\s*\n\s*([0-9.]+%)/);
    if (!multiline)
      return null;
    return `\u56DE\u5934\u7387${cleanText(multiline[1])}`;
  }
  function firstOfferId(links) {
    for (const link of links) {
      const offerId = extractOfferId(link);
      if (offerId)
        return offerId;
    }
    return null;
  }
  function firstContactUrl(links) {
    for (const link of links) {
      const url = buildContactUrl(link);
      if (url)
        return url;
    }
    return null;
  }
  async function readStorePayload(page, url, action) {
    const state = await gotoAndReadState(page, url, 2500, action);
    assertAuthenticatedState(state, action);
    return await page.evaluate(`
    (() => ({
      href: window.location.href,
      title: document.title || '',
      bodyText: document.body ? document.body.innerText || '' : '',
      offerLinks: Array.from(document.querySelectorAll('a[href*="detail.1688.com/offer/"], a[href*="offerId="]'))
        .map((anchor) => anchor.href)
        .filter(Boolean),
      contactLinks: Array.from(document.querySelectorAll('a[href*="contactinfo"]'))
        .map((anchor) => anchor.href)
        .filter(Boolean),
    }))()
  `);
  }
  async function readItemSeed(page, offerId) {
    const itemUrl = buildDetailUrl(offerId);
    const state = await gotoAndReadState(page, itemUrl, 2500, "store seed item");
    assertAuthenticatedState(state, "store seed item");
    const seed = await page.evaluate(`
    (() => {
      const model = window.context?.result?.global?.globalData?.model ?? null;
      const toJson = (value) => JSON.parse(JSON.stringify(value ?? null));
      return {
        href: window.location.href,
        bodyText: document.body ? document.body.innerText || '' : '',
        seller: toJson(model?.sellerModel),
        services: toJson(model?.shippingServices?.fields?.buyerProtectionModel ?? []),
      };
    })()
  `);
    const hasSellerContext = !!cleanText(seed?.seller?.memberId) || !!cleanText(seed?.seller?.winportUrl);
    if (!hasSellerContext) {
      throw new CommandExecutionError("1688 store seed item did not expose seller context", "\u5F53\u524D tab \u975E\u5546\u54C1\u8BE6\u60C5\u4E0A\u4E0B\u6587\uFF0C\u8BF7\u5207\u5230 detail.1688.com \u5546\u54C1\u9875\u5E76\u91CD\u8BD5");
    }
    return seed;
  }
  function hasAnyEvidence(storePayload, contactPayload, seed) {
    return !!cleanText(storePayload?.bodyText) || !!cleanText(contactPayload?.bodyText) || !!cleanText(seed?.bodyText);
  }
  cli({
    site: "1688",
    name: "store",
    access: "read",
    description: "1688 \u5E97\u94FA/\u4F9B\u5E94\u5546\u516C\u5F00\u4FE1\u606F\uFF08\u8054\u7CFB\u65B9\u5F0F\u3001\u4E3B\u8425\u3001\u5165\u9A7B\u5E74\u9650\u3001\u516C\u5F00\u670D\u52A1\u4FE1\u53F7\uFF09",
    domain: "www.1688.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      {
        name: "input",
        required: true,
        positional: true,
        help: "1688 \u5E97\u94FA URL \u6216 member ID\uFF08\u5982 b2b-22154705262941f196\uFF09"
      }
    ],
    columns: ["store_name", "years_on_platform_text", "location", "return_rate_text"],
    func: async (page, kwargs) => {
      const rawInput = String(kwargs.input ?? "");
      const resolvedUrl = resolveStoreUrl(rawInput);
      const explicitMemberId = extractMemberId(rawInput);
      const storePayload = await readStorePayload(page, resolvedUrl, "store");
      let contactPayload = null;
      let seed = null;
      if (!hasAnyEvidence(storePayload, null, null)) {
        const contactUrl = firstContactUrl(storePayload.contactLinks ?? []) || buildContactUrl(storePayload.href || resolvedUrl);
        contactPayload = contactUrl ? await readStorePayload(page, contactUrl, "store contact") : null;
      }
      const offerId = extractOfferId(rawInput) || firstOfferId(storePayload.offerLinks ?? []) || firstOfferId(contactPayload?.offerLinks ?? []);
      if (!hasAnyEvidence(storePayload, contactPayload, null) && offerId) {
        try {
          seed = await readItemSeed(page, offerId);
        } catch (error) {
          if (!(error instanceof CommandExecutionError))
            throw error;
        }
      }
      if (!hasAnyEvidence(storePayload, contactPayload, seed)) {
        throw new EmptyResultError("1688 store", "Store page is reachable but no visible fields were extracted. Open the store page in Chrome and retry.");
      }
      return [
        normalizeStorePayload({
          resolvedUrl,
          storePayload,
          contactPayload,
          seed,
          explicitMemberId
        })
      ];
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
    "1688": ["1688.com", "www.1688.com", "login.1688.com", "login.taobao.com", "account.1688.com", "detail.1688.com", "detail.m.1688.com", "winport.m.1688.com", "s.1688.com"],
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
