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
    ["i.weread.qq.com", { prefix: ["/book/", "/user/", "/review/", "/shelf/"] }],
    ["tieba.baidu.com", {
      exact: /* @__PURE__ */ new Set([
        "/c/f/frs/page_pc"
      ]),
      methods: /* @__PURE__ */ new Map([
        ["/c/f/frs/page_pc", /* @__PURE__ */ new Set(["POST"])]
      ])
    }]
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
    const method = String(options.method || "GET").toUpperCase();
    const rule = endpoints.get(url.hostname);
    const allowedMethods = rule?.methods?.get(url.pathname) || /* @__PURE__ */ new Set(["GET"]);
    if (!allowedMethods.has(method)) {
      throw new CommandExecutionError("Only GET requests are allowed");
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
          ...(options.body != null ? { body: String(options.body) } : {})
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

  // webcli/scripts/opencli-wave5/node-crypto.js
  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32(a << s | a >>> 32 - s, b);
  }
  function ff(a, b, c, d, x, s, t) {
    return cmn(b & c | ~b & d, a, b, x, s, t);
  }
  function gg(a, b, c, d, x, s, t) {
    return cmn(b & d | c & ~d, a, b, x, s, t);
  }
  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function md51(s) {
    const n = s.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << (i % 4 << 3);
    tail[i >> 2] |= 128 << (i % 4 << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function md5blk(s) {
    const blks = [];
    for (let i = 0; i < 64; i += 4) {
      blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return blks;
  }
  var hexChr = "0123456789abcdef".split("");
  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j++) s += hexChr[n >> j * 8 + 4 & 15] + hexChr[n >> j * 8 & 15];
    return s;
  }
  function add32(a, b) {
    return a + b & 4294967295;
  }
  function md5(input) {
    const bytes = unescape(encodeURIComponent(String(input)));
    return md51(bytes).map(rhex).join("");
  }
  function createHash(algorithm) {
    if (String(algorithm).toLowerCase() !== "md5") throw new Error(`node:crypto.createHash('${algorithm}') is unavailable in the extension runtime`);
    let data = "";
    return {
      update(chunk) {
        data += String(chunk);
        return this;
      },
      digest(encoding) {
        const hex = md5(data);
        if (encoding === "hex" || encoding === void 0) return hex;
        throw new Error(`node:crypto digest encoding '${encoding}' is unavailable in the extension runtime`);
      }
    };
  }

  // webcli/scripts/opencli-wave5/upstream/tieba/utils.js
  var MAX_TIEBA_LIMIT = 20;
  var TIEBA_PC_SIGN_SALT = "36770b1f34c9bbf2e7d1a99d2b82fa9e";
  var TIEBA_TIME_ZONE = "Asia/Shanghai";
  function normalizeTiebaLimit(value, fallback = MAX_TIEBA_LIMIT) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < 1)
      return fallback;
    return Math.min(Math.trunc(parsed), MAX_TIEBA_LIMIT);
  }
  function normalizeText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }
  function signTiebaPcParams(params) {
    const payload = Object.keys(params).sort((left, right) => left.localeCompare(right)).map((key) => `${key}=${params[key]}`).join("") + TIEBA_PC_SIGN_SALT;
    return createHash("md5").update(payload).digest("hex");
  }
  function parseTiebaCount(text) {
    const value = normalizeText(text).toUpperCase();
    if (!value)
      return 0;
    const compact = value.replace(/[^\d.W万]/g, "");
    if (compact.endsWith("\u4E07")) {
      return Math.round(parseFloat(compact.slice(0, -1)) * 1e4);
    }
    if (compact.endsWith("W")) {
      return Math.round(parseFloat(compact.slice(0, -1)) * 1e4);
    }
    return parseInt(compact.replace(/[^\d]/g, ""), 10) || 0;
  }
  function parseTiebaLastReply(text) {
    const normalized = normalizeText(text).replace(/^回复于/, "").trim();
    const match = normalized.match(/(刚刚|\d+\s*(?:分钟|小时|天)前|\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/);
    return match ? match[1].trim() : normalized;
  }
  function buildTiebaThreadUrl(id, rawUrl) {
    const explicitUrl = normalizeText(rawUrl);
    if (explicitUrl)
      return explicitUrl;
    return id ? `https://tieba.baidu.com/p/${id}` : "";
  }
  function resolveTiebaThreadId(raw) {
    const direct = normalizeText(raw.threadId);
    if (direct)
      return direct;
    const fromUrl = normalizeText(raw.url).match(/\/p\/(\d+)/);
    return fromUrl ? fromUrl[1] : "";
  }
  function getTiebaFeedComponent(feed, name) {
    const components = Array.isArray(feed?.components) ? feed.components : [];
    const match = components.find((entry) => normalizeText(entry.component) === name);
    if (!match)
      return {};
    const payload = match[name];
    return payload && typeof payload === "object" ? payload : {};
  }
  function extractTiebaFeedAuthor(feed) {
    const head = getTiebaFeedComponent(feed, "feed_head");
    const mainData = Array.isArray(head.main_data) ? head.main_data : [];
    for (const item of mainData) {
      const textRecord = item.text;
      const author = normalizeText(textRecord?.text);
      if (author)
        return author;
    }
    return "";
  }
  function extractTiebaFeedTitle(feed) {
    const title = getTiebaFeedComponent(feed, "feed_title");
    const titleData = Array.isArray(title.data) ? title.data : [];
    const firstTitle = titleData[0];
    const textInfo = firstTitle?.text_info;
    return normalizeText(textInfo?.text) || normalizeText(feed?.business_info_map?.title);
  }
  function extractTiebaFeedCommentCount(feed) {
    const social = getTiebaFeedComponent(feed, "feed_social");
    const commentCount = Number(social.comment_num ?? feed?.business_info_map?.comment_num ?? 0);
    return Number.isFinite(commentCount) ? commentCount : 0;
  }
  function extractTiebaFeedThreadId(feed) {
    const direct = normalizeText(feed?.business_info_map?.thread_id);
    if (direct)
      return direct;
    const logParams = Array.isArray(feed?.log_param) ? feed.log_param : [];
    const fromLog = normalizeText(logParams.find((item) => normalizeText(item?.key) === "tid")?.value);
    if (fromLog)
      return fromLog;
    const fromSchema = normalizeText(feed?.schema).match(/[?&]tid=(\d+)/);
    return fromSchema ? fromSchema[1] : "";
  }
  function extractTiebaFeedLastReply(feed) {
    const head = getTiebaFeedComponent(feed, "feed_head");
    const extraData = Array.isArray(head.extra_data) ? head.extra_data : [];
    const first = extraData[0];
    const prefix = normalizeText(first?.business_info_map?.time_prefix);
    const textRecord = first?.text;
    const rawTime = normalizeText(textRecord?.text);
    const formattedTime = /^\d+$/.test(rawTime) ? formatTiebaUnixTime(rawTime) : rawTime;
    return [prefix, formattedTime].filter(Boolean).join("");
  }
  function buildTiebaPostCardsFromPagePc(rawFeeds) {
    return rawFeeds.filter((entry) => normalizeText(entry.layout) === "feed" && entry.feed).map((entry) => {
      const feed = entry.feed;
      const threadId = extractTiebaFeedThreadId(feed);
      return {
        title: extractTiebaFeedTitle(feed),
        author: extractTiebaFeedAuthor(feed),
        descInfo: extractTiebaFeedLastReply(feed),
        commentCount: extractTiebaFeedCommentCount(feed),
        actionTexts: [],
        threadId,
        url: buildTiebaThreadUrl(threadId)
      };
    }).filter((entry) => normalizeText(entry.title));
  }
  function buildTiebaPostItems(rawCards, requestedLimit) {
    const limit = normalizeTiebaLimit(requestedLimit);
    return rawCards.map((raw) => {
      const title = normalizeText(raw.title);
      const id = resolveTiebaThreadId(raw);
      const actionTexts = Array.isArray(raw.actionTexts) ? raw.actionTexts.map(normalizeText).filter(Boolean) : [];
      const commentText = actionTexts.find((text) => /评论/.test(text)) || actionTexts[actionTexts.length - 1] || "";
      return {
        title,
        author: normalizeText(raw.author),
        replies: Number.isFinite(Number(raw.commentCount)) ? Number(raw.commentCount) : parseTiebaCount(commentText),
        last_reply: parseTiebaLastReply(String(raw.descInfo ?? "")),
        id,
        url: buildTiebaThreadUrl(id, raw.url)
      };
    }).filter((item) => item.title).slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }));
  }
  function buildTiebaSearchItems(rawItems, requestedLimit) {
    const limit = normalizeTiebaLimit(requestedLimit);
    return rawItems.map((raw) => {
      const url = normalizeText(raw.url);
      const directId = normalizeText(raw.id);
      const idFromUrl = url.match(/\/p\/(\d+)/)?.[1] || "";
      return {
        title: normalizeText(raw.title),
        forum: normalizeText(raw.forum),
        author: normalizeText(raw.author),
        time: normalizeText(raw.time),
        snippet: normalizeText(raw.snippet).slice(0, 200),
        id: directId || idFromUrl,
        url
      };
    }).filter((item) => item.title).slice(0, limit).map((item, index) => ({ rank: index + 1, ...item }));
  }
  function formatTiebaUnixTime(value) {
    const ts = Number(value || 0);
    if (!Number.isFinite(ts) || ts <= 0)
      return "";
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: TIEBA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date(ts * 1e3));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  }
  function parseTiebaReplyTime(text) {
    const normalized = normalizeText(text);
    const withoutFloor = normalized.replace(/^第\d+楼\s+/, "").trim();
    const match = withoutFloor.match(/^(刚刚|昨天|前天|\d+\s*(?:分钟|小时|天)前|\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/);
    return match ? match[1].trim() : withoutFloor;
  }
  function buildMainPostItem(mainPost) {
    if (!mainPost)
      return null;
    const title = normalizeText(mainPost.title);
    const author = normalizeText(mainPost.author) || normalizeText(mainPost.fallbackAuthor);
    const body = normalizeText(mainPost.contentText) || normalizeText(mainPost.structuredText);
    const hasMedia = Boolean(mainPost.hasMedia);
    const content = [title, body || (hasMedia ? "[media]" : "")].filter(Boolean).join(" ").trim();
    if (!content)
      return null;
    return {
      floor: 1,
      author,
      content,
      time: normalizeText(mainPost.visibleTime) || formatTiebaUnixTime(mainPost.structuredTime)
    };
  }
  function buildTiebaReadItems(payload, options = {}) {
    const fallback = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 30;
    const limit = Math.max(1, Math.trunc(fallback));
    const includeMainPost = options.includeMainPost !== false;
    const items = [];
    const mainPost = buildMainPostItem(payload.mainPost);
    if (includeMainPost && mainPost)
      items.push(mainPost);
    const replies = Array.isArray(payload.replies) ? payload.replies : [];
    const replyItems = [];
    for (const reply of replies) {
      const floor = Number(reply.floor || 0);
      const content = normalizeText(reply.content);
      if (!Number.isFinite(floor) || floor < 1 || !content)
        continue;
      replyItems.push({
        floor,
        author: normalizeText(reply.author),
        content,
        time: parseTiebaReplyTime(String(reply.time ?? ""))
      });
    }
    return items.concat(replyItems.slice(0, limit));
  }

  // webcli/scripts/opencli-wave5/upstream/tieba/hot.js
  cli({
    site: "tieba",
    name: "hot",
    access: "read",
    description: "Tieba hot topics",
    domain: "tieba.baidu.com",
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of items to return" }
    ],
    columns: ["rank", "title", "discussions", "description", "url"],
    func: async (page, kwargs) => {
      const limit = normalizeTiebaLimit(kwargs.limit);
      await page.goto("https://tieba.baidu.com/hottopic/browse/topicList?res_type=1");
      const raw = await page.evaluate(`(() => {
      const items = document.querySelectorAll('li.topic-top-item');
      return Array.from(items).map((item) => {
        const titleEl = item.querySelector('a.topic-text');
        const numEl = item.querySelector('span.topic-num');
        const descEl = item.querySelector('p.topic-top-item-desc');
        const href = titleEl?.getAttribute('href') || '';

        return {
          title: titleEl?.textContent?.trim() || '',
          discussions: numEl?.textContent?.trim() || '',
          description: descEl?.textContent?.trim() || '',
          url: href.startsWith('http') ? href : 'https://tieba.baidu.com' + href,
        };
      }).filter((item) => item.title).slice(0, ${limit});
    })()`);
      const items = Array.isArray(raw) ? raw : [];
      if (!items.length) {
        throw new EmptyResultError("tieba hot", "Tieba may have blocked the hot page, or the DOM structure may have changed");
      }
      return items.map((item, index) => ({
        rank: index + 1,
        title: item.title || "",
        discussions: item.discussions || "",
        description: item.description || "",
        url: item.url || ""
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/tieba/posts.js
  function getForumPageNumber(kwargs) {
    return Math.max(1, Number(kwargs.page || 1));
  }
  function getForumUrl(kwargs) {
    const forum = String(kwargs.forum || "");
    return `https://tieba.baidu.com/f?kw=${encodeURIComponent(forum)}&ie=utf-8&pn=${(getForumPageNumber(kwargs) - 1) * 50}`;
  }
  function buildTiebaPagePcParams(kwargs, limit) {
    return {
      kw: encodeURIComponent(String(kwargs.forum || "")),
      pn: String(getForumPageNumber(kwargs)),
      sort_type: "-1",
      is_newfrs: "1",
      is_newfeed: "1",
      rn: "30",
      rn_need: String(Math.min(Math.max(limit + 10, 10), 30)),
      tbs: "",
      subapp_type: "pc",
      _client_type: "20"
    };
  }
  async function fetchTiebaPagePc(page, kwargs, limit) {
    await page.goto(getForumUrl(kwargs), { waitUntil: "none" });
    await page.wait(2);
    const params = buildTiebaPagePcParams(kwargs, limit);
    const cookies = await page.getCookies({ domain: "tieba.baidu.com" });
    const cookieHeader = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const body = new URLSearchParams({
      ...params,
      sign: signTiebaPcParams(params)
    }).toString();
    const response = await fetch("https://tieba.baidu.com/c/f/frs/page_pc", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        cookie: cookieHeader,
        "x-requested-with": "XMLHttpRequest",
        referer: getForumUrl(kwargs),
        "user-agent": "Mozilla/5.0"
      },
      body
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  cli({
    site: "tieba",
    name: "posts",
    access: "read",
    description: "Browse posts in a tieba forum",
    domain: "tieba.baidu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "forum", positional: true, required: true, type: "string", help: "Forum name in Chinese" },
      { name: "page", type: "int", default: 1, help: "Page number" },
      { name: "limit", type: "int", default: 20, help: "Number of items to return" }
    ],
    columns: ["rank", "title", "author", "replies"],
    func: async (page, kwargs) => {
      const limit = normalizeTiebaLimit(kwargs.limit);
      const payload = await fetchTiebaPagePc(page, kwargs, limit);
      const rawFeeds = Array.isArray(payload.page_data?.feed_list) ? payload.page_data.feed_list : [];
      const rawCards = buildTiebaPostCardsFromPagePc(rawFeeds);
      const items = buildTiebaPostItems(rawCards, limit);
      if (!items.length || payload.error_code) {
        throw new EmptyResultError("tieba posts", "Tieba may have blocked the forum page, or the DOM structure may have changed");
      }
      return items;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/tieba/read.js
  function getThreadUrl(kwargs) {
    const threadId = String(kwargs.id || "");
    const pageNumber = Math.max(1, Number(kwargs.page || 1));
    return `https://tieba.baidu.com/p/${encodeURIComponent(threadId)}?pn=${pageNumber}`;
  }
  function assertTiebaReadTargetPage(raw, kwargs) {
    const expectedThreadId = String(kwargs.id || "").trim();
    const expectedPageNumber = Math.max(1, Number(kwargs.page || 1));
    const pathname = String(raw.pageMeta?.pathname || "").trim();
    const actualThreadId = pathname.match(/^\/p\/(\d+)/)?.[1] || "";
    const actualPn = String(raw.pageMeta?.pn || "").trim();
    if (!actualThreadId || actualThreadId !== expectedThreadId) {
      throw new EmptyResultError("tieba read", "Tieba did not land on the requested thread page");
    }
    if (expectedPageNumber > 1 && actualPn !== String(expectedPageNumber)) {
      throw new EmptyResultError("tieba read", "Tieba did not land on the requested page");
    }
  }
  function buildExtractReadEvaluate() {
    return `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (predicate, timeoutMs = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return true;
          await wait(100);
        }
        return false;
      };
      const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const getVueProps = (element) => {
        const vue = element && element.__vue__ ? element.__vue__ : null;
        return vue ? (vue._props || vue.$props || {}) : {};
      };
      const extractStructuredText = (content) => {
        if (!Array.isArray(content)) return '';
        return content
          .map((part) => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '')
          .join('')
          .replace(/\\s+/g, ' ')
          .trim();
      };
      const parseFloor = (text) => {
        const match = (text || '').match(/\u7B2C(\\d+)\u697C/);
        return match ? parseInt(match[1], 10) : 0;
      };

      await waitFor(() => {
        const hasMainTree = document.querySelector('.pb-title-wrap.pc-pb-title') || document.querySelector('.pb-content-wrap');
        return Boolean(hasMainTree || document.querySelector('.pb-comment-item'));
      });

      const titleNode = document.querySelector('.pb-title-wrap.pc-pb-title');
      const titleProps = getVueProps(titleNode);
      const mainUser = document.querySelector('.head-line.user-info:not(.no-extra-margin)');
      const mainUserProps = getVueProps(mainUser);
      const contentWrap = document.querySelector('.pb-content-wrap');
      const contentProps = getVueProps(contentWrap);
      const structuredContent = Array.isArray(contentProps.content) ? contentProps.content : [];
      const visibleContent = normalizeText(
        contentWrap?.querySelector('.pb-content-item .text')?.textContent
        || contentWrap?.querySelector('.text')?.textContent
        || contentWrap?.textContent
      );

      return {
        pageMeta: {
          pathname: window.location.pathname || '',
          pn: new URLSearchParams(window.location.search).get('pn') || '',
        },
        mainPost: {
          title: typeof titleProps.title === 'string' && titleProps.title.trim()
            ? titleProps.title.trim()
            : normalizeText(titleNode?.textContent).replace(/-\u767E\u5EA6\u8D34\u5427$/, '').trim(),
          author: normalizeText(
            mainUser?.querySelector('.head-name')?.textContent
            || mainUser?.querySelector('.name-info .head-name')?.textContent
            || ''
          ),
          fallbackAuthor: mainUserProps?.userShowInfo?.[0]?.text?.text || '',
          contentText: visibleContent,
          structuredText: extractStructuredText(structuredContent),
          visibleTime: (() => {
            const userText = normalizeText(mainUser?.textContent);
            const match = userText.match(/(\u521A\u521A|\u6628\u5929|\u524D\u5929|\\d+\\s*(?:\u5206\u949F|\u5C0F\u65F6|\u5929)\u524D|\\d{2}-\\d{2}(?:\\s+\\d{2}:\\d{2})?|\\d{4}-\\d{2}-\\d{2}(?:\\s+\\d{2}:\\d{2})?)/);
            return match ? match[1].trim() : '';
          })(),
          structuredTime: mainUserProps?.descInfo?.time || 0,
          hasMedia: structuredContent.length > 0 && !extractStructuredText(structuredContent),
        },
        replies: Array.from(document.querySelectorAll('.pb-comment-item')).map((item) => {
          const meta = item.querySelector('.comment-desc-left')?.textContent?.replace(/\\s+/g, ' ').trim() || '';
          return {
            floor: parseFloor(meta),
            author: item.querySelector('.head-name')?.textContent?.trim() || '',
            content: item.querySelector('.comment-content .pb-content-item .text')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
            time: meta,
          };
        }),
      };
    })()
  `;
  }
  cli({
    site: "tieba",
    name: "read",
    access: "read",
    description: "Read a tieba thread",
    domain: "tieba.baidu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "id", positional: true, required: true, type: "string", help: "Thread ID" },
      { name: "page", type: "int", default: 1, help: "Page number" },
      { name: "limit", type: "int", default: 30, help: "Number of replies to return" }
    ],
    columns: ["floor", "author", "content", "time"],
    func: async (page, kwargs) => {
      const pageNumber = Math.max(1, Number(kwargs.page || 1));
      await page.goto(getThreadUrl(kwargs));
      const raw = await page.evaluate(buildExtractReadEvaluate()) || {};
      assertTiebaReadTargetPage(raw, kwargs);
      const items = buildTiebaReadItems(raw, {
        limit: kwargs.limit,
        includeMainPost: pageNumber === 1
      });
      if (!items.length) {
        throw new EmptyResultError("tieba read", "Tieba may have blocked the thread page, or the DOM structure may have changed");
      }
      return items;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/tieba/search.js
  var MAX_SUPPORTED_PAGE = "1";
  function buildExtractSearchResultsEvaluate(limit) {
    return `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (predicate, timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return true;
          await wait(100);
        }
        return false;
      };
      const getVueProps = (element) => {
        const vue = element && element.__vue__ ? element.__vue__ : null;
        return vue ? (vue._props || vue.$props || {}) : {};
      };
      await waitFor(() => {
        const bodyText = document.body?.innerText || '';
        return Boolean(
          document.querySelector('.threadcardclass.thread-new3.index-feed-cards')
          || document.querySelector('.search-no-result, .search-nodata, .no-result')
          || /\u767E\u5EA6\u5B89\u5168\u9A8C\u8BC1|\u5B89\u5168\u9A8C\u8BC1|\u8BF7\u5B8C\u6210\u9A8C\u8BC1/.test(bodyText)
        );
      });
      const items = document.querySelectorAll('.threadcardclass.thread-new3.index-feed-cards');
      return Array.from(items).slice(0, ${limit}).map((item) => {
        const forum = item.querySelector('.forum-name-text, .forum-name')?.textContent?.trim() || '';
        const meta = item.querySelector('.user-forum-info')?.textContent?.replace(/\\s+/g, ' ').trim() || '';
        const metaWithoutForum = forum && meta.startsWith(forum)
          ? meta.slice(forum.length).trim()
          : meta;
        const metaMatch = metaWithoutForum.match(/^(.*?)\\s*\u53D1\u5E03\u4E8E\\s*(.+)$/);
        const actionBar = item.querySelector('.action-bar-container.search-action-bar');
        const businessInfo = getVueProps(actionBar).businessInfo || {};
        const href = item.querySelector('a[href*="/p/"]')?.href || '';
        const threadId = String(businessInfo.thread_id || '').trim();
        const title = item.querySelector('.title-wrap')?.textContent?.trim()
          || item.querySelector('.title-content-wrap')?.textContent?.trim()
          || '';
        const snippet = item.querySelector('.title-content-wrap')?.textContent?.trim()
          || item.querySelector('.abstract-wrap')?.textContent?.trim()
          || '';

        return {
          title,
          forum,
          author: metaMatch ? metaMatch[1].trim() : metaWithoutForum,
          time: metaMatch ? metaMatch[2].trim() : '',
          snippet: snippet.substring(0, 200),
          id: threadId,
          url: href || (threadId ? 'https://tieba.baidu.com/p/' + threadId : ''),
        };
      }).filter((item) => item.title);
    })()
  `;
  }
  function getSearchUrl(kwargs) {
    const keyword = String(kwargs.keyword || "");
    const pageNumber = Number(kwargs.page || 1);
    return `https://tieba.baidu.com/f/search/res?qw=${encodeURIComponent(keyword)}&ie=utf-8&pn=${pageNumber}`;
  }
  function assertSupportedPage(kwargs) {
    const pageNumber = String(kwargs.page || 1);
    if (pageNumber === MAX_SUPPORTED_PAGE)
      return;
    throw new ArgumentError(`tieba search currently only supports --page ${MAX_SUPPORTED_PAGE}`, `Baidu Tieba search no longer exposes stable browser pagination; omit --page or use --page ${MAX_SUPPORTED_PAGE}`);
  }
  cli({
    site: "tieba",
    name: "search",
    access: "read",
    description: "Search posts across tieba",
    domain: "tieba.baidu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "keyword", positional: true, required: true, type: "string", help: "Search keyword" },
      // Restrict unsupported pages before the browser session starts.
      { name: "page", type: "int", default: 1, choices: ["1"], help: "Page number (currently only 1 is supported)" },
      { name: "limit", type: "int", default: 20, help: "Number of items to return" }
    ],
    columns: ["rank", "id", "title", "forum", "author", "time", "url"],
    func: async (page, kwargs) => {
      assertSupportedPage(kwargs);
      const limit = normalizeTiebaLimit(kwargs.limit);
      await page.goto(getSearchUrl(kwargs));
      const raw = await page.evaluate(buildExtractSearchResultsEvaluate(limit));
      const items = buildTiebaSearchItems(Array.isArray(raw) ? raw : [], limit);
      if (!items.length) {
        throw new EmptyResultError("tieba search", "Tieba may have blocked the result page, or the DOM structure may have changed");
      }
      return items;
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
