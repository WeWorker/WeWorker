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
    constructor(command2, message) {
      super("EMPTY_RESULT", message || command2);
    }
  };
  var TimeoutError = class extends CliError {
    constructor(command2, seconds, hint) {
      super("TIMEOUT", `${command2} exceeded ${seconds}s`, hint);
    }
  };
  var LoginWallError = class extends CliError {
    constructor(message, status, url, bodyPreview, hint) {
      super("LOGIN_WALL", message, hint);
      this.status = status;
      this.url = url;
      this.bodyPreview = bodyPreview;
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
  function cli(command2) {
    commands.set(`${command2.site}/${command2.name}`, command2);
    return command2;
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/accept.js
  cli({
    site: "twitter",
    name: "accept",
    access: "write",
    description: "Auto-accept DM requests containing specific keywords",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "query", type: "string", required: true, positional: true, help: 'Keywords to match (comma-separated for OR, e.g. "\u7FA4,\u5FAE\u4FE1")' },
      { name: "max", type: "int", required: false, default: 20, help: "Maximum number of requests to accept (default: 20)" },
      { name: "timeout", type: "int", required: false, default: 600, help: "Max seconds for the overall command (default: 600 \u2014 batch op)" }
    ],
    columns: ["index", "status", "user", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter accept");
      const keywords = kwargs.query.split(",").map((k) => k.trim()).filter(Boolean);
      const maxAccepts = kwargs.max ?? 20;
      const results = [];
      let acceptCount = 0;
      const visited = /* @__PURE__ */ new Set();
      for (let round = 0; round < maxAccepts + 50; round++) {
        if (acceptCount >= maxAccepts)
          break;
        await page.goto("https://x.com/messages/requests");
        await page.wait(4);
        const convInfo = await page.evaluate(`(async () => {
        try {
          // Wait for initial items
          let attempts = 0;
          while (attempts < 10) {
            const convs = document.querySelectorAll('[data-testid="conversation"]');
            if (convs.length > 0) break;
            await new Promise(r => setTimeout(r, 1000));
            attempts++;
          }

          // Scroll to load more
          const seenCount = new Set();
          let noNewCount = 0;
          for (let scroll = 0; scroll < 20; scroll++) {
            const convs = Array.from(document.querySelectorAll('[data-testid="conversation"]'));
            const prevSize = seenCount.size;
            convs.forEach((_, i) => seenCount.add(i));
            if (convs.length >= ${maxAccepts + 10}) break;

            // Scroll last item into view
            if (convs.length > 0) {
              convs[convs.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
            }
            await new Promise(r => setTimeout(r, 1500));

            if (seenCount.size <= prevSize) {
              noNewCount++;
              if (noNewCount >= 3) break;
            } else {
              noNewCount = 0;
            }
          }

          const convs = Array.from(document.querySelectorAll('[data-testid="conversation"]'));
          if (convs.length === 0) return { ok: false, count: 0, items: [] };

          const items = convs.map((conv, idx) => {
            const text = conv.innerText || '';
            const link = conv.querySelector('a[href]');
            const href = link ? link.href : '';
            const lines = text.split('\\n').filter(l => l.trim());
            const user = lines[0] || 'Unknown';
            return { idx, text, href, user };
          });
          return { ok: true, count: convs.length, items };
        } catch(e) {
          return { ok: false, error: String(e), count: 0, items: [] };
        }
      })()`);
        if (!convInfo?.ok || convInfo.count === 0) {
          if (results.length === 0) {
            results.push({ index: 1, status: "info", user: "System", message: "No message requests found" });
          }
          break;
        }
        let foundInThisRound = false;
        for (const item of convInfo.items) {
          if (acceptCount >= maxAccepts)
            break;
          const convKey = item.href || `conv-${item.idx}`;
          if (visited.has(convKey))
            continue;
          visited.add(convKey);
          const previewMatch = keywords.some((k) => item.text.includes(k));
          if (!previewMatch)
            continue;
          const clickResult = await page.evaluate(`(async () => {
          try {
            const convs = Array.from(document.querySelectorAll('[data-testid="conversation"]'));
            const conv = convs[${item.idx}];
            if (!conv) return { ok: false, error: 'Conversation element not found' };
            conv.click();
            await new Promise(r => setTimeout(r, 2000));
            return { ok: true };
          } catch(e) {
            return { ok: false, error: String(e) };
          }
        })()`);
          if (!clickResult?.ok)
            continue;
          await page.wait(2);
          const res = await page.evaluate(`(async () => {
          try {
            const keywords = ${JSON.stringify(keywords)};

            // Get username from conversation header
            const heading = document.querySelector('[data-testid="conversation-header"]') ||
                            document.querySelector('[data-testid="DM-conversation-header"]');
            let username = 'Unknown';
            if (heading) {
              username = heading.innerText.trim().split('\\n')[0];
            }

            // Read full chat area text
            const chatArea = document.querySelector('[data-testid="DmScrollerContainer"]') ||
                             document.querySelector('[data-testid="DMConversationBody"]') ||
                             document.querySelector('main [data-testid="cellInnerDiv"]')?.closest('section') ||
                             document.querySelector('main');
            const text = chatArea ? chatArea.innerText : '';

            // Verify keyword match in full chat content
            const matchedKw = keywords.filter(k => text.includes(k));
            if (matchedKw.length === 0) {
              return { status: 'skipped', user: username, message: 'No keyword match in full content' };
            }

            // Find the Accept button
            const allBtns = Array.from(document.querySelectorAll('[role="button"]'));
            const acceptBtn = allBtns.find(btn => {
              const t = btn.innerText.trim().toLowerCase();
              return t === 'accept' || t === '\u63A5\u53D7';
            });

            if (!acceptBtn) {
              return { status: 'no_button', user: username, message: 'Keyword matched but no Accept button (already accepted?)' };
            }

            // Click Accept
            acceptBtn.click();
            await new Promise(r => setTimeout(r, 2000));

            // Check for confirmation dialog
            const btnsAfter = Array.from(document.querySelectorAll('[role="button"]'));
            const confirmBtn = btnsAfter.find(btn => {
              const t = btn.innerText.trim().toLowerCase();
              return (t === 'accept' || t === '\u63A5\u53D7') && btn !== acceptBtn;
            });
            if (confirmBtn) {
              confirmBtn.click();
              await new Promise(r => setTimeout(r, 1000));
            }

            return { status: 'accepted', user: username, message: 'Accepted! Matched: ' + matchedKw.join(', ') };
          } catch(e) {
            return { status: 'error', user: 'system', message: String(e) };
          }
        })()`);
          if (res?.status === "accepted") {
            acceptCount++;
            foundInThisRound = true;
            results.push({
              index: acceptCount,
              status: "accepted",
              user: res.user || "Unknown",
              message: res.message || "Accepted"
            });
            await page.wait(2);
            break;
          } else if (res?.status === "no_button") {
            continue;
          }
        }
        if (!foundInThisRound) {
          break;
        }
      }
      if (results.length === 0) {
        results.push({ index: 0, status: "info", user: "System", message: `No requests matched keywords "${keywords.join(", ")}"` });
      }
      return results;
    }
  });

  // webcli/scripts/opencli-wave5/node-fs.js
  function blocked(name) {
    return () => {
      throw new Error(`node:fs.${name} is unavailable in the extension runtime`);
    };
  }
  var existsSync = blocked("existsSync");
  var statSync = blocked("statSync");
  var readFileSync = blocked("readFileSync");
  var writeFileSync = blocked("writeFileSync");
  var renameSync = blocked("renameSync");
  var rmSync = blocked("rmSync");
  var mkdirSync = blocked("mkdirSync");
  var appendFileSync = blocked("appendFileSync");
  var mkdtempSync = blocked("mkdtempSync");
  var node_fs_default = { existsSync, statSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, appendFileSync, mkdtempSync };

  // webcli/scripts/opencli-wave5/node-path.js
  function extname(p) {
    const base = String(p).split(/[\\/]/).pop() || "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot).toLowerCase() : "";
  }
  function basename(p) {
    return String(p).split(/[\\/]/).pop() || "";
  }
  function dirname(p) {
    const s = String(p);
    const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return idx <= 0 ? idx === 0 ? s[0] : "." : s.slice(0, idx);
  }
  function join(...parts) {
    return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  }
  function resolve(...parts) {
    let joined = parts.filter(Boolean).join("/");
    joined = joined.replace(/\\/g, "/");
    const segments = joined.split("/");
    const absolute = /^[A-Za-z]:\//.test(joined) || joined.startsWith("/");
    const out = [];
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!absolute) out.push("..");
        continue;
      }
      out.push(segment);
    }
    if (absolute && /^[A-Za-z]:$/.test(out[0])) return out[0] + "/" + out.slice(1).join("/");
    return (absolute ? "/" : "") + out.join("/");
  }
  var node_path_default = { extname, basename, dirname, join, resolve };

  // webcli/scripts/opencli-wave5/upstream/twitter/archive.js
  var DEFAULT_MAX_PAGINATION_PAGES = 100;
  var HARD_MAX_PAGINATION_PAGES = 1e5;
  function resolveOptionalFilePath(raw, label) {
    if (raw === void 0 || raw === null || raw === "")
      return "";
    const value = String(raw).trim();
    if (!value)
      throw new ArgumentError(`${label} cannot be empty`);
    return node_path_default.resolve(value);
  }
  function ensureParentDir(filePath) {
    if (!filePath)
      return;
    node_fs_default.mkdirSync(node_path_default.dirname(filePath), { recursive: true });
  }
  function removeFile(filePath) {
    if (!filePath)
      return;
    try {
      node_fs_default.rmSync(filePath, { force: true });
    } catch {
    }
  }
  function loadJsonlArchiveState(filePath) {
    const seen = /* @__PURE__ */ new Set();
    let count = 0;
    if (!filePath || !node_fs_default.existsSync(filePath))
      return { seen, count };
    const text = node_fs_default.readFileSync(filePath, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed)
        continue;
      try {
        const row = JSON.parse(trimmed);
        if (!row?.id)
          throw new Error("missing id");
        const id = String(row.id);
        if (seen.has(id))
          throw new Error(`duplicate id ${id}`);
        seen.add(id);
        count += 1;
      } catch (error) {
        throw new CommandExecutionError(`Invalid JSONL record in ${filePath} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { seen, count };
  }
  function appendJsonlRows(filePath, rows) {
    if (!filePath || !Array.isArray(rows) || rows.length === 0)
      return;
    ensureParentDir(filePath);
    const text = rows.map((row) => JSON.stringify(row).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")).join("\n") + "\n";
    node_fs_default.appendFileSync(filePath, text, "utf8");
  }
  function removeResumeFile(filePath) {
    removeFile(filePath);
  }
  function resolveMaxPages(kwargs, fetchAll) {
    const raw = kwargs["max-pages"];
    if (raw === void 0 || raw === null || raw === "") {
      return fetchAll ? HARD_MAX_PAGINATION_PAGES : DEFAULT_MAX_PAGINATION_PAGES;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_PAGINATION_PAGES) {
      throw new ArgumentError(`--max-pages must be an integer between 1 and ${HARD_MAX_PAGINATION_PAGES}`);
    }
    return value;
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/shared.js
  var QUERY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  var SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
  var TWEET_PATH_PATTERN = /^\/(?:[^/]+|i)\/status\/(\d+)\/?$/;
  var TWEET_HOSTS = /* @__PURE__ */ new Set(["x.com", "twitter.com"]);
  var SCREEN_NAME_HOSTS = /* @__PURE__ */ new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
  var USER_BY_SCREEN_NAME_FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };
  var RESERVED_SCREEN_NAME_PATHS = /* @__PURE__ */ new Set([
    "compose",
    "explore",
    "help",
    "home",
    "i",
    "intent",
    "jobs",
    "login",
    "logout",
    "messages",
    "notifications",
    "privacy",
    "search",
    "settings",
    "signup",
    "tos"
  ]);
  function isTwitterHost(hostname) {
    return TWEET_HOSTS.has(hostname) || hostname.endsWith(".x.com") || hostname.endsWith(".twitter.com");
  }
  function parseTweetUrl(rawUrl) {
    const value = String(rawUrl ?? "").trim();
    if (!value) {
      throw new ArgumentError("twitter tweet URL cannot be empty", "Example: opencli twitter retweet https://x.com/jack/status/20");
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ArgumentError(`Invalid tweet URL: ${value}`, "Use a full https://x.com/<user>/status/<id> URL");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !isTwitterHost(hostname)) {
      throw new ArgumentError(`Invalid tweet URL host: ${value}`, "Use a full https://x.com/<user>/status/<id> URL");
    }
    const match = parsed.pathname.match(TWEET_PATH_PATTERN);
    if (!match?.[1]) {
      throw new ArgumentError(`Could not extract tweet ID from URL: ${value}`, "Use a full https://x.com/<user>/status/<id> URL");
    }
    return {
      id: match[1],
      url: parsed.toString()
    };
  }
  function buildTwitterArticleScopeSource(tweetId) {
    return `
        const tweetId = ${JSON.stringify(tweetId)};
        const __twTweetPathRe = /^\\/(?:[^/]+|i)\\/status\\/(\\d+)\\/?$/;
        const __twIsTwitterHost = (hostname) => hostname === 'x.com'
            || hostname === 'twitter.com'
            || hostname.endsWith('.x.com')
            || hostname.endsWith('.twitter.com');
        const __twGetStatusIdFromHref = (href) => {
            try {
                const parsed = new URL(href, window.location.origin);
                if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !__twIsTwitterHost(parsed.hostname.toLowerCase())) {
                    return null;
                }
                return parsed.pathname.match(__twTweetPathRe)?.[1] || null;
            } catch {
                return null;
            }
        };
        const __twHasLinkToTarget = (root) => {
            const link = root.querySelector('a[href*="/status/"] time')?.closest('a[href]');
            return Boolean(link && __twGetStatusIdFromHref(link.href) === tweetId);
        };
        const findTargetArticle = () => Array.from(document.querySelectorAll('article'))
            .find(__twHasLinkToTarget);
    `;
  }
  function sanitizeQueryId(resolved, fallbackId) {
    return typeof resolved === "string" && QUERY_ID_PATTERN.test(resolved) ? resolved : fallbackId;
  }
  function buildUserByScreenNameQueryUrl(queryId, screenName) {
    const variables = JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true });
    const features = JSON.stringify(USER_BY_SCREEN_NAME_FEATURES);
    return `/i/api/graphql/${queryId}/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  }
  function normalizeTwitterScreenName(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    let candidate = "";
    try {
      const url = raw.startsWith("/") ? new URL(raw, "https://x.com") : new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !SCREEN_NAME_HOSTS.has(url.hostname)) {
        return "";
      }
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 1) return "";
      candidate = segments[0];
    } catch {
      if (raw.includes("/") || raw.includes("?") || raw.includes("#")) return "";
      candidate = raw.replace(/^@+/, "");
    }
    if (!SCREEN_NAME_PATTERN.test(candidate)) return "";
    if (RESERVED_SCREEN_NAME_PATHS.has(candidate.toLowerCase())) return "";
    return candidate;
  }
  function keysToFlags(keys) {
    if (!Array.isArray(keys)) return {};
    return Object.fromEntries(keys.filter((key) => typeof key === "string" && key).map((key) => [key, true]));
  }
  function normalizeTwitterOperationFlags(value) {
    if (Array.isArray(value)) return keysToFlags(value);
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value).filter(([key, flag]) => typeof key === "string" && key && typeof flag === "boolean")
    );
  }
  function normalizeOperationFallback(fallback) {
    if (typeof fallback === "string") return { queryId: fallback, features: {}, fieldToggles: {} };
    return {
      queryId: fallback?.queryId || null,
      features: normalizeTwitterOperationFlags(fallback?.features),
      fieldToggles: normalizeTwitterOperationFlags(fallback?.fieldToggles)
    };
  }
  function unwrapBrowserResult(value) {
    if (value && typeof value === "object" && typeof value.session === "string" && Object.prototype.hasOwnProperty.call(value, "data")) {
      return value.data;
    }
    return value;
  }
  function isEmptyObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  }
  function looksLikePrivateTwitterTimeline(data) {
    const result = data?.data?.user?.result;
    if (!result || typeof result !== "object") return false;
    return Boolean(isEmptyObject(result.timeline) || isEmptyObject(result.timeline_v2?.timeline));
  }
  function normalizeTwitterGraphqlPayload(value) {
    const unwrapped = unwrapBrowserResult(value);
    if (unwrapped?.data && typeof unwrapped.data === "object") return unwrapped;
    if (unwrapped && typeof unwrapped === "object" && (Object.prototype.hasOwnProperty.call(unwrapped, "user") || Object.prototype.hasOwnProperty.call(unwrapped, "search_by_raw_query"))) {
      return { data: unwrapped };
    }
    return unwrapped;
  }
  function sanitizeTwitterOperationMetadata(resolved, fallback) {
    const value = unwrapBrowserResult(resolved);
    const normalizedFallback = normalizeOperationFallback(fallback);
    return {
      queryId: sanitizeQueryId(value?.queryId, normalizedFallback.queryId),
      features: Object.keys(normalizeTwitterOperationFlags(value?.features)).length > 0 ? normalizeTwitterOperationFlags(value.features) : normalizedFallback.features,
      fieldToggles: Object.keys(normalizeTwitterOperationFlags(value?.fieldToggles)).length > 0 ? normalizeTwitterOperationFlags(value.fieldToggles) : normalizedFallback.fieldToggles
    };
  }
  function parseOperationFromBundleText(text, operationName) {
    if (!text || !operationName) return null;
    const esc = operationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reA = new RegExp(`queryId:"([A-Za-z0-9_-]+)"[^}]{0,400}operationName:"${esc}"`);
    const reB = new RegExp(`operationName:"${esc}"[^}]{0,400}queryId:"([A-Za-z0-9_-]+)"`);
    let queryId = null;
    let matchIndex = -1;
    const mA = text.match(reA);
    if (mA && typeof mA.index === "number") {
      queryId = mA[1];
      matchIndex = mA.index;
    } else {
      const mB = text.match(reB);
      if (mB && typeof mB.index === "number") {
        queryId = mB[1];
        matchIndex = mB.index;
      }
    }
    if (!queryId) return null;
    const winStart = Math.max(0, matchIndex - 500);
    const winEnd = Math.min(text.length, matchIndex + 1500);
    const win = text.slice(winStart, winEnd);
    const quotedKeys = (source) => source ? Array.from(source.matchAll(/"([^"]+)"/g)).map((m) => m[1]) : [];
    const flags = (keys) => Object.fromEntries(
      (keys || []).filter((k) => typeof k === "string" && k).map((k) => [k, true])
    );
    return {
      queryId,
      features: flags(quotedKeys(win.match(/featureSwitches:\[([^\]]*)\]/)?.[1])),
      fieldToggles: flags(quotedKeys(win.match(/fieldToggles:\[([^\]]*)\]/)?.[1]))
    };
  }
  async function resolveTwitterOperationMetadata(page, operationName, fallback) {
    const parserSource = parseOperationFromBundleText.toString();
    const resolved = await page.evaluate(`async () => {
    const operationName = ${JSON.stringify(operationName)};
    const keysToFlags = (keys) => Object.fromEntries((keys || []).filter((k) => typeof k === 'string' && k).map((key) => [key, true]));
    const normalizeFlags = (value) => {
      if (Array.isArray(value)) return keysToFlags(value);
      if (!value || typeof value !== 'object') return {};
      return Object.fromEntries(Object.entries(value).filter(([key, flag]) => typeof key === 'string' && key && typeof flag === 'boolean'));
    };
    const parseOperationFromBundleText = ${parserSource};

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json', { signal: controller.signal });
        clearTimeout(timeout);
        if (ghResp.ok) {
          const data = await ghResp.json();
          const entry = data && data[operationName];
          if (entry && entry.queryId) {
            return {
              queryId: entry.queryId,
              features: normalizeFlags(entry.features ?? entry.featureSwitches),
              fieldToggles: normalizeFlags(entry.fieldToggles),
            };
          }
        }
      } catch {
        clearTimeout(timeout);
      }
    } catch {}

    try {
      const scripts = Array.from(document.scripts)
        .map(s => s.src)
        .filter(Boolean)
        .concat(performance.getEntriesByType('resource')
          .map(r => r.name)
          .filter(r => r.includes('client-web') && r.endsWith('.js')));
      const uniqueScripts = Array.from(new Set(scripts));
      const head = uniqueScripts.slice(0, 15);
      const tail = uniqueScripts.slice(-15);
      const candidates = Array.from(new Set([...head, ...tail]));
      for (const scriptUrl of candidates) {
        try {
          const text = await (await fetch(scriptUrl)).text();
          const operation = parseOperationFromBundleText(text, operationName);
          if (operation) return operation;
        } catch {}
      }
    } catch {}

    return null;
  }`);
    return sanitizeTwitterOperationMetadata(resolved, fallback);
  }
  async function resolveTwitterQueryId(page, operationName, fallbackId) {
    const operation = await resolveTwitterOperationMetadata(page, operationName, fallbackId);
    return operation.queryId;
  }
  function extractMedia(legacy) {
    const media = legacy?.extended_entities?.media || legacy?.entities?.media;
    if (!Array.isArray(media) || media.length === 0) {
      return { has_media: false, media_urls: [], media_posters: [] };
    }
    const urls = [];
    const posters = [];
    for (const m of media) {
      if (!m) continue;
      if (m.type === "video" || m.type === "animated_gif") {
        const variants = m.video_info?.variants || [];
        const mp4 = variants.find((v) => v?.content_type === "video/mp4");
        const url = mp4?.url || m.media_url_https;
        if (url) {
          urls.push(url);
          posters.push(m.media_url_https || url);
        }
      } else {
        if (m.media_url_https) {
          urls.push(m.media_url_https);
          posters.push(m.media_url_https);
        }
      }
    }
    return { has_media: urls.length > 0, media_urls: urls, media_posters: posters };
  }
  function extractCard(tweet) {
    const cardLegacy = tweet?.card?.legacy;
    if (!cardLegacy) return null;
    const bindings = Array.isArray(cardLegacy.binding_values) ? cardLegacy.binding_values : [];
    const byKey = /* @__PURE__ */ new Map();
    for (const b of bindings) {
      if (b && typeof b.key === "string") byKey.set(b.key, b.value);
    }
    const str = (key) => {
      const v = byKey.get(key);
      return typeof v?.string_value === "string" && v.string_value.length > 0 ? v.string_value : void 0;
    };
    const img = (key) => {
      const v = byKey.get(key);
      const u = v?.image_value?.url;
      return typeof u === "string" && u.length > 0 ? u : void 0;
    };
    const title = str("title");
    const description = str("description");
    const domainBinding = str("domain");
    const cardUrlBinding = str("card_url");
    const image_url = img("thumbnail_image_large") || img("photo_image_full_size_large") || img("summary_photo_image_large");
    const urlEntities = Array.isArray(tweet?.legacy?.entities?.urls) ? tweet.legacy.entities.urls : [];
    const matchingEntity = cardUrlBinding ? urlEntities.find((entity) => entity?.url === cardUrlBinding || entity?.expanded_url === cardUrlBinding) : void 0;
    const matchedExpandedUrl = matchingEntity?.expanded_url;
    const url = typeof matchedExpandedUrl === "string" && matchedExpandedUrl.length > 0 ? matchedExpandedUrl : cardUrlBinding;
    let domain = domainBinding;
    if (!domain && url) {
      try {
        domain = new URL(url).hostname;
      } catch {
      }
    }
    if (!url && !title && !description) return null;
    const out = { name: cardLegacy.name };
    if (title) out.title = title;
    if (description) out.description = description;
    if (image_url) out.image_url = image_url;
    if (url) out.url = url;
    if (domain) out.domain = domain;
    return out;
  }
  function extractQuotedTweet(tweet) {
    const legacy = tweet?.legacy;
    if (!legacy?.is_quote_status) return null;
    const q = tweet?.quoted_status_result?.result ?? tweet?.legacy?.quoted_status_result?.result;
    if (!q) return null;
    const qTw = q.tweet || q;
    if (!qTw || typeof qTw !== "object") return null;
    const qLegacy = qTw.legacy && typeof qTw.legacy === "object" ? qTw.legacy : {};
    if (typeof qTw.rest_id !== "string" || !qTw.rest_id.trim()) return null;
    const qUser = qTw.core?.user_results?.result;
    const qLegacyScreenName = qUser?.legacy?.screen_name;
    const qCoreScreenName = qUser?.core?.screen_name;
    const qScreenName = typeof qLegacyScreenName === "string" && qLegacyScreenName.trim() ? qLegacyScreenName.trim() : typeof qCoreScreenName === "string" && qCoreScreenName.trim() ? qCoreScreenName.trim() : "";
    if (!SCREEN_NAME_PATTERN.test(qScreenName)) return null;
    const qLegacyDisplayName = qUser?.legacy?.name;
    const qCoreDisplayName = qUser?.core?.name;
    const qDisplayName = typeof qLegacyDisplayName === "string" ? qLegacyDisplayName : typeof qCoreDisplayName === "string" ? qCoreDisplayName : "";
    const qNoteText = qTw.note_tweet?.note_tweet_results?.result?.text;
    const qText = typeof qNoteText === "string" && qNoteText.length > 0 ? qNoteText : typeof qLegacy.full_text === "string" ? qLegacy.full_text : "";
    const qMedia = extractMedia(qLegacy);
    const qCard = extractCard(qTw);
    if (!qText && !qMedia.has_media && !qCard) return null;
    const out = {
      id: qTw.rest_id,
      author: qScreenName,
      name: qDisplayName,
      text: qText,
      created_at: typeof qLegacy.created_at === "string" ? qLegacy.created_at : "",
      url: `https://x.com/${qScreenName}/status/${qTw.rest_id}`,
      has_media: qMedia.has_media,
      media_urls: qMedia.media_urls,
      media_posters: qMedia.media_posters
    };
    if (qCard) out.card = qCard;
    return out;
  }
  function describeTwitterApiError(operation, status, extraHint) {
    const code = Number(status);
    const prefix = `HTTP ${status}: ${operation} fetch failed`;
    let suffix;
    if (code === 429) {
      suffix = "rate-limited by Twitter (session quota); retry after cooldown (typically 15-30 min)";
    } else if (code === 401) {
      suffix = "auth failed (cookie expired or invalidated); re-login required";
    } else if (code === 403) {
      suffix = "forbidden (cookie lacks scope, or resource is private)";
    } else if (code === 404) {
      suffix = "resource not found (deleted, suspended, or private)";
    } else if (code >= 500 && code < 600) {
      suffix = "Twitter server error; retry later";
    } else {
      suffix = "possibly queryId expired, schema change, or transient";
    }
    if (extraHint) suffix = `${suffix} (${extraHint})`;
    return `${prefix} \u2014 ${suffix}`;
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/utils.js
  var TWITTER_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  var MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
  var ENGAGEMENT_WEIGHTS = Object.freeze({
    likes: 1,
    retweets: 3,
    replies: 2,
    bookmarks: 5,
    viewsLog: 0.5
  });
  function computeEngagementScore(row) {
    if (!row || typeof row !== "object") return 0;
    const num = (key) => {
      const raw = row[key];
      if (raw === void 0 || raw === null) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const score = num("likes") * ENGAGEMENT_WEIGHTS.likes + num("retweets") * ENGAGEMENT_WEIGHTS.retweets + num("replies") * ENGAGEMENT_WEIGHTS.replies + num("bookmarks") * ENGAGEMENT_WEIGHTS.bookmarks + Math.log10(num("views") + 1) * ENGAGEMENT_WEIGHTS.viewsLog;
    return Math.round(score * 100) / 100;
  }
  function applyTopByEngagement(rows, topN) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const n = Number(topN);
    if (!Number.isFinite(n) || n <= 0) return rows;
    return rows.map((row, idx) => ({ row, idx, score: computeEngagementScore(row) })).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, Math.floor(n)).map((entry) => entry.row);
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/article.js
  var TWEET_RESULT_BY_REST_ID_QUERY_ID = "7xflPyRiUxGVbJd4uWmbfg";
  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }
  cli({
    site: "twitter",
    name: "article",
    access: "read",
    description: "Fetch a Twitter Article (long-form content) and export as Markdown",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "tweet-id", type: "string", positional: true, required: true, help: "Tweet ID or URL containing the article" }
    ],
    columns: ["title", "author", "content", "url"],
    func: async (page, kwargs) => {
      let tweetId = kwargs["tweet-id"];
      const isArticleUrl = /\/article\/\d+/.test(tweetId);
      const urlMatch = tweetId.match(/\/(?:status|article)\/(\d+)/);
      if (urlMatch)
        tweetId = urlMatch[1];
      if (isArticleUrl) {
        await page.goto(`https://x.com/i/article/${tweetId}`);
        await page.wait(3);
        const resolvedId = await page.evaluate(`
        (function() {
          var links = document.querySelectorAll('a[href*="/status/"]');
          for (var i = 0; i < links.length; i++) {
            var m = links[i].href.match(/\\/status\\/(\\d+)/);
            if (m) return m[1];
          }
          var og = document.querySelector('meta[property="og:url"]');
          if (og && og.content) {
            var m2 = og.content.match(/\\/status\\/(\\d+)/);
            if (m2) return m2[1];
          }
          return null;
        })()
      `);
        const resolvedTweetId = unwrapBrowserResult(resolvedId);
        if (!resolvedTweetId || typeof resolvedTweetId !== "string") {
          throw new CommandExecutionError(`Could not resolve article ${tweetId} to a tweet ID. The article page may not contain a linked tweet.`);
        }
        tweetId = resolvedTweetId;
      }
      await page.goto(`https://x.com/i/status/${tweetId}`);
      await page.wait(3);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const queryId = await resolveTwitterQueryId(page, "TweetResultByRestId", TWEET_RESULT_BY_REST_ID_QUERY_ID);
      const rawResult = unwrapBrowserResult(await page.evaluate(`
      async () => {
        const tweetId = ${JSON.stringify(tweetId)};
        const ct0 = ${JSON.stringify(ct0)};

        const bearer = ${JSON.stringify(TWITTER_BEARER_TOKEN)};
        const headers = {
          'Authorization': 'Bearer ' + decodeURIComponent(bearer),
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes'
        };

        const variables = JSON.stringify({
          tweetId: tweetId,
          withCommunity: false,
          includePromotedContent: false,
          withVoice: false,
        });
        const features = JSON.stringify({
          longform_notetweets_consumption_enabled: true,
          responsive_web_twitter_article_tweet_consumption_enabled: true,
          longform_notetweets_rich_text_read_enabled: true,
          longform_notetweets_inline_media_enabled: true,
          articles_preview_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
        });
        const fieldToggles = JSON.stringify({
          withArticleRichContentState: true,
          withArticlePlainText: true,
        });

        const url = '/i/api/graphql/' + ${JSON.stringify(queryId)} + '/TweetResultByRestId?variables='
          + encodeURIComponent(variables)
          + '&features=' + encodeURIComponent(features)
          + '&fieldToggles=' + encodeURIComponent(fieldToggles);

        let resp;
        try {
          resp = await fetch(url, {headers, credentials: 'include'});
        } catch (error) {
          return {error: 'Twitter article request failed: ' + String(error && error.message || error)};
        }
        if (!resp.ok) return {httpStatus: resp.status};
        let d;
        try {
          d = await resp.json();
        } catch {
          return {error: 'Twitter API response was not valid JSON', hint: 'You may be logged out or the request was blocked'};
        }
        if (!d || typeof d !== 'object' || Array.isArray(d)) {
          return {error: 'Twitter API response payload was malformed'};
        }

        const result = d?.data?.tweetResult?.result;
        if (!result) {
          if (Array.isArray(d.errors) && d.errors.length > 0) {
            return {error: 'Twitter TweetResultByRestId returned GraphQL errors: ' + JSON.stringify(d.errors).slice(0, 200)};
          }
          return {error: 'Article not found'};
        }

        // Unwrap TweetWithVisibilityResults
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          return {error: 'Twitter API response tweet result was malformed'};
        }
        const tw = result.tweet || result;
        if (!tw || typeof tw !== 'object' || Array.isArray(tw)) {
          return {error: 'Twitter API response tweet result was malformed'};
        }
        const legacy = tw.legacy || {};
        const user = tw.core?.user_results?.result;
        const returnedTweetId = tw.rest_id || legacy.id_str;
        if (typeof returnedTweetId !== 'string' || returnedTweetId !== tweetId) {
          return {error: 'Twitter API response did not match requested tweet ' + tweetId};
        }
        const screenName = user?.legacy?.screen_name || user?.core?.screen_name || '';
        if (typeof screenName !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(screenName)) {
          return {error: 'Twitter API response did not include a valid author screen name for tweet ' + tweetId};
        }

        // Extract article content
        const articleResults = tw.article?.article_results?.result;
        if (!articleResults) {
          // Fallback: return note_tweet text if present
          const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
          if (noteText) {
            return [{
              title: '(Note Tweet)',
              author: screenName,
              content: noteText,
              url: 'https://x.com/' + screenName + '/status/' + tweetId,
            }];
          }
          return {error: 'Tweet ' + tweetId + ' has no article content'};
        }
        if (!articleResults || typeof articleResults !== 'object' || Array.isArray(articleResults)) {
          return {error: 'Twitter API response article result was malformed'};
        }

        const title = articleResults.title || '(Untitled)';
        const contentState = articleResults.content_state || {};
        if (!contentState || typeof contentState !== 'object' || Array.isArray(contentState)) {
          return {error: 'Twitter API response article content was malformed'};
        }
        const blocks = contentState.blocks || [];
        if (!Array.isArray(blocks)) {
          return {error: 'Twitter API response article blocks were malformed'};
        }
        // The current GraphQL response serializes Draft.js entityMap as an
        // unordered [{key, value}] array, not an object keyed by entity id.
        // Normalize both representations before resolving atomic blocks.
        const rawEntityMap = contentState.entityMap || {};
        const entityByKey = {};
        if (Array.isArray(rawEntityMap)) {
          for (const entry of rawEntityMap) {
            if (entry && entry.key != null && entry.value) {
              entityByKey[String(entry.key)] = entry.value;
            }
          }
        } else {
          for (const [key, entry] of Object.entries(rawEntityMap)) {
            entityByKey[String(key)] = entry?.value || entry;
          }
        }

        // Build media_id -> original_img_url lookup from media_entities.
        const mediaEntities = articleResults.media_entities || [];
        const mediaUrlById = {};
        for (const me of Object.values(mediaEntities)) {
          const url = me?.media_info?.original_img_url;
          if (typeof url === 'string' && me?.media_id != null) {
            mediaUrlById[String(me.media_id)] = url;
          }
        }

        // Convert draft.js blocks to Markdown
        const parts = [];
        let orderedCounter = 0;
        for (const block of blocks) {
          if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
          const blockType = block.type || 'unstyled';
          if (blockType === 'atomic') {
            const entityKey = block.entityRanges?.[0]?.key;
            const entity = entityKey == null ? null : entityByKey[String(entityKey)];
            if (entity?.type === 'MEDIA') {
              const mediaId = entity.data?.mediaItems?.[0]?.mediaId;
              const imgUrl = mediaId == null ? null : mediaUrlById[String(mediaId)];
              const caption = String(entity.data?.caption || 'Image').replaceAll(']', '&#93;');
              if (imgUrl) parts.push('![' + caption + '](' + imgUrl + ')');
            }
            continue;
          }
          const text = block.text || '';
          if (!text) continue;
          if (blockType !== 'ordered-list-item') orderedCounter = 0;

          if (blockType === 'header-one')           parts.push('# ' + text);
          else if (blockType === 'header-two')      parts.push('## ' + text);
          else if (blockType === 'header-three')    parts.push('### ' + text);
          else if (blockType === 'blockquote')       parts.push('> ' + text);
          else if (blockType === 'unordered-list-item') parts.push('- ' + text);
          else if (blockType === 'ordered-list-item') {
            orderedCounter++;
            parts.push(orderedCounter + '. ' + text);
          }
          else if (blockType === 'code-block')       parts.push('\`\`\`\\n' + text + '\\n\`\`\`');
          else                                       parts.push(text);
        }

        return [{
          title,
          author: screenName,
          content: parts.join('\\n\\n') || legacy.full_text || '',
          url: 'https://x.com/' + screenName + '/status/' + tweetId,
        }];
      }
    `));
      if (!Array.isArray(rawResult) && !isPlainObject(rawResult)) {
        throw new CommandExecutionError("Twitter article response payload is malformed");
      }
      if (rawResult?.httpStatus) {
        const message = describeTwitterApiError("TweetResultByRestId", rawResult.httpStatus);
        if (rawResult.httpStatus === 401 || rawResult.httpStatus === 403) {
          throw new AuthRequiredError("x.com", message);
        }
        throw new CommandExecutionError(message);
      }
      if (rawResult?.error) {
        throw new CommandExecutionError(rawResult.error + (rawResult.hint ? ` (${rawResult.hint})` : ""));
      }
      if (!Array.isArray(rawResult)) {
        throw new CommandExecutionError("Twitter article response payload is malformed");
      }
      return rawResult;
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

  // webcli/scripts/opencli-wave5/upstream/twitter/auth.js
  var SCREEN_NAME_POLL_SECONDS = 1;
  var SCREEN_NAME_POLLS = 8;
  var SCREEN_NAME_AGREEMENTS = 3;
  async function hasTwitterSessionCookies(page) {
    const cookies = await page.getCookies({ url: "https://x.com" });
    const names = new Set(cookies.map((cookie) => cookie.name));
    return names.has("auth_token") && names.has("ct0");
  }
  function unwrapTwitterEvaluateResult(value, label) {
    if (value && typeof value === "object" && !Array.isArray(value) && "session" in value) {
      if (typeof value.session === "string" && Object.prototype.hasOwnProperty.call(value, "data")) {
        return value.data;
      }
      throw new CommandExecutionError(`Twitter/X ${label} returned a malformed Browser Bridge envelope`);
    }
    return value;
  }
  async function readScreenName(page) {
    const href = unwrapTwitterEvaluateResult(await page.evaluate(`() => {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return link ? link.getAttribute('href') : null;
  }`), "profile link probe");
    if (href !== null && typeof href !== "string") {
      throw new CommandExecutionError("Twitter/X profile link probe returned a malformed href");
    }
    return normalizeTwitterScreenName(typeof href === "string" ? href : "");
  }
  async function readSettledScreenName(page) {
    const samples = [];
    for (let poll = 0; poll < SCREEN_NAME_POLLS; poll += 1) {
      samples.push(await readScreenName(page));
      if (poll < SCREEN_NAME_POLLS - 1) {
        await page.sleep(SCREEN_NAME_POLL_SECONDS);
      }
    }
    const tail = samples.slice(-SCREEN_NAME_AGREEMENTS);
    const username = tail[0] || "";
    return username && tail.every((sample) => sample === username) ? username : "";
  }
  async function verifyTwitterIdentity(page, { phase } = {}) {
    if (!await hasTwitterSessionCookies(page)) {
      throw new AuthRequiredError("x.com", "Twitter/X auth cookies are missing");
    }
    await page.goto("https://x.com/home");
    await page.wait({ selector: '[data-testid="primaryColumn"]' }).catch(() => {
    });
    const username = phase === "poll" ? await readScreenName(page) : await readSettledScreenName(page);
    if (!username) {
      throw new AuthRequiredError("x.com", "Could not detect the logged-in Twitter/X profile link");
    }
    return { username, url: `https://x.com/${username}` };
  }
  registerSiteAuthCommands({
    site: "twitter",
    domain: "x.com",
    loginUrl: "https://x.com/i/flow/login",
    columns: ["username", "url"],
    quickCheck: hasTwitterSessionCookies,
    verify: verifyTwitterIdentity,
    poll: async (page, options) => {
      if (!await hasTwitterSessionCookies(page)) {
        throw new AuthRequiredError("x.com", "Waiting for Twitter/X auth cookies");
      }
      return verifyTwitterIdentity(page, options);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/block.js
  cli({
    site: "twitter",
    name: "block",
    access: "write",
    description: "Block a Twitter user",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, required: true, help: "Twitter screen name (without @)" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter block");
      const username = kwargs.username.replace(/^@/, "");
      await page.goto(`https://x.com/${username}`);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            let attempts = 0;
            const getPrimary = () => document.querySelector('[data-testid="primaryColumn"]');
            const isBlockMenuItem = (item) => {
                const text = String(item.textContent || '');
                const lower = text.toLowerCase();
                const isUnblockText = lower.includes('unblock') || text.includes('\u53D6\u6D88\u5C4F\u853D') || text.includes('\u89E3\u9664\u5C4F\u853D');
                const isBlockText = (lower.includes('block') || text.includes('\u5C4F\u853D')) && !isUnblockText;
                return item.getAttribute('data-testid') === 'block' || isBlockText;
            };
            if (!getPrimary()) {
                return { ok: false, message: 'Could not find profile surface. Are you logged in?' };
            }

            // Check if already blocked (profile shows "Blocked" / unblock button)
            while (attempts < 20) {
                const primary = getPrimary();
                if (!primary) {
                    return { ok: false, message: 'Could not find profile surface. Are you logged in?' };
                }
                const blockedIndicator = primary.querySelector('[data-testid$="-unblock"]');
                if (blockedIndicator) {
                    return { ok: true, message: 'Already blocking @${username}.' };
                }

                const moreBtn = primary.querySelector('[data-testid="userActions"]');
                if (moreBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            const primary = getPrimary();
            const moreBtn = primary?.querySelector('[data-testid="userActions"]');
            if (!moreBtn) {
                return { ok: false, message: 'Could not find user actions menu. Are you logged in?' };
            }

            // Open the more actions menu
            moreBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Find the Block menu item
            const menuItems = document.querySelectorAll('[role="menuitem"]');
            let blockItem = null;
            for (const item of menuItems) {
                if (isBlockMenuItem(item)) {
                    blockItem = item;
                    break;
                }
            }

            if (!blockItem) {
                return { ok: false, message: 'Could not find Block option in menu.' };
            }

            blockItem.click();
            await new Promise(r => setTimeout(r, 1000));

            // Confirm the block in the dialog
            const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
            if (!confirmBtn) {
                return { ok: false, message: 'Block confirmation dialog did not appear.' };
            }
            writeStarted = true;
            confirmBtn.click();
            await new Promise(r => setTimeout(r, 1500));

            // Verify
            const verify = getPrimary()?.querySelector('[data-testid$="-unblock"]');
            if (verify) {
                return { ok: true, message: 'Successfully blocked @${username}.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Block action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter block confirmation", 1.5, `${result.message} Check the profile before retrying; the block may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the profile in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/bookmark.js
  cli({
    site: "twitter",
    name: "bookmark",
    access: "write",
    description: "Bookmark a tweet",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", positional: true, required: true, help: "Tweet URL to bookmark" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter bookmark");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            // Article-scoped: on conversation pages multiple bookmark/remove
            // buttons render and a bare querySelector would silently bookmark
            // a different tweet (e.g. the parent of the requested reply).
            let attempts = 0;
            let bookmarkBtn = null;
            let removeBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                removeBtn = targetArticle?.querySelector('[data-testid="removeBookmark"]') || null;
                if (removeBtn) {
                    return { ok: true, message: 'Tweet is already bookmarked.' };
                }

                bookmarkBtn = targetArticle?.querySelector('[data-testid="bookmark"]') || null;
                if (bookmarkBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!bookmarkBtn) {
                return { ok: false, message: 'Could not find Bookmark button on the requested tweet. Are you logged in?' };
            }

            writeStarted = true;
            bookmarkBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify
            const verifyArticle = findTargetArticle() || targetArticle;
            const verify = verifyArticle?.querySelector('[data-testid="removeBookmark"]');
            if (verify) {
                return { ok: true, message: 'Tweet successfully bookmarked.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Bookmark action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter bookmark confirmation", 1, `${result.message} Check the tweet before retrying; the bookmark may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/bookmark-folder.js
  var OPERATION_NAME = "BookmarkFolderTimeline";
  var FALLBACK_QUERY_ID = "13H7EUATwethsj_jZ6QQAQ";
  var FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  var MAX_PAGINATION_PAGES = 100;
  var FEATURES = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  function buildFolderTimelineUrl(queryId, folderId, count, cursor) {
    const vars = {
      bookmark_collection_id: String(folderId),
      count,
      includePromotedContent: false
    };
    if (cursor) vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/${OPERATION_NAME}?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
  }
  function extractFolderTweet(result, seen) {
    if (!result) return null;
    const tw = result.tweet || result;
    const legacy = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id)) return null;
    seen.add(tw.rest_id);
    const user = tw.core?.user_results?.result;
    const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "";
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    return {
      id: tw.rest_id,
      author: screenName,
      text: noteText || legacy.full_text || "",
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      bookmarks: legacy.bookmark_count || 0,
      created_at: legacy.created_at || "",
      url: screenName ? `https://x.com/${screenName}/status/${tw.rest_id}` : `https://x.com/i/status/${tw.rest_id}`,
      ...extractMedia(legacy)
    };
  }
  function parseBookmarkFolderTimeline(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.bookmark_collection_timeline?.timeline?.instructions || data?.data?.bookmark_timeline_v2?.timeline?.instructions || data?.data?.bookmark_timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const content = entry.content;
        if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
          if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
            nextCursor = content.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = content?.value || content?.itemContent?.value || nextCursor;
          continue;
        }
        const direct = extractFolderTweet(content?.itemContent?.tweet_results?.result, seen);
        if (direct) {
          tweets.push(direct);
          continue;
        }
        for (const item of content?.items || []) {
          const nested = extractFolderTweet(item.item?.itemContent?.tweet_results?.result, seen);
          if (nested) tweets.push(nested);
        }
      }
    }
    return { tweets, nextCursor };
  }
  cli({
    site: "twitter",
    name: "bookmark-folder",
    access: "read",
    description: "Read the tweets inside a single Twitter/X bookmark folder. Get the folder id from `opencli twitter bookmark-folders`.",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "folder-id", positional: true, type: "string", required: true, help: "Folder id from `opencli twitter bookmark-folders`." },
      { name: "limit", type: "int", default: 20, help: "Maximum number of bookmarks to return (default 20)." },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the folder by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps the API's native (saved-time) ordering." }
    ],
    columns: ["id", "author", "text", "likes", "retweets", "bookmarks", "created_at", "url", "has_media", "media_urls", "media_posters"],
    func: async (page, kwargs) => {
      const folderId = String(kwargs["folder-id"] || "").trim();
      if (!folderId || !FOLDER_ID_PATTERN.test(folderId)) {
        throw new ArgumentError(
          `Invalid folder-id: ${JSON.stringify(kwargs["folder-id"])}. Expected a safe folder ID from \`opencli twitter bookmark-folders\`.`
        );
      }
      const limit = Number(kwargs.limit ?? 20);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new ArgumentError(`Invalid --limit: ${JSON.stringify(kwargs.limit)}. Expected a positive integer.`);
      }
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const queryId = await resolveTwitterQueryId(page, OPERATION_NAME, FALLBACK_QUERY_ID);
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const allTweets = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      for (let i = 0; i < MAX_PAGINATION_PAGES && allTweets.length < limit; i++) {
        const fetchCount = Math.min(100, limit - allTweets.length + 10);
        const apiUrl = buildFolderTimelineUrl(queryId, folderId, fetchCount, cursor);
        const data = await page.evaluate(`async () => {
                const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
                return r.ok ? await r.json() : { error: r.status };
            }`);
        if (data?.error) {
          if (allTweets.length === 0)
            throw new CommandExecutionError(describeTwitterApiError("BookmarkFolderTimeline", data.error, `folder=${folderId}`));
          break;
        }
        const { tweets, nextCursor } = parseBookmarkFolderTimeline(data, seen);
        allTweets.push(...tweets);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      const trimmed = allTweets.slice(0, limit);
      return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/bookmark-folders.js
  var OPERATION_NAME2 = "bookmarkFoldersSlice";
  var FALLBACK_QUERY_ID2 = "i78YDd0Tza-dWKw5H2Y7WA";
  var FEATURES2 = {
    rweb_tipjar_consumption_enabled: false,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false
  };
  function buildUrl(queryId) {
    const variables = JSON.stringify({});
    return `/i/api/graphql/${queryId}/${OPERATION_NAME2}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(JSON.stringify(FEATURES2))}`;
  }
  function parseBookmarkFolders(data, seen) {
    const folders = [];
    const slice = data?.data?.viewer?.bookmark_collections_slice || data?.data?.viewer_v2?.user_results?.result?.bookmark_collections_slice || data?.data?.bookmark_collections_slice || null;
    const items = slice?.items || slice?.timeline?.timeline?.instructions?.flatMap?.((i) => i.entries || []) || [];
    for (const item of items) {
      const folder = item?.bookmarkCollection || item?.content?.bookmarkCollection || item?.content?.itemContent?.bookmark_collection || item;
      const id = folder?.id_str || folder?.id || folder?.rest_id || "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = folder?.name || folder?.collection_name || "";
      const itemsCount = Number(folder?.bookmarks_count ?? folder?.items_count ?? folder?.count ?? 0) || 0;
      const createdAt = folder?.created_at || folder?.timestamp_ms || "";
      folders.push({
        id: String(id),
        name: String(name),
        items: itemsCount,
        created_at: String(createdAt)
      });
    }
    return folders;
  }
  cli({
    site: "twitter",
    name: "bookmark-folders",
    access: "read",
    description: "List your Twitter/X bookmark folders (the user-created collections under Bookmarks). Returns folder id, name, item count, and created_at.",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [],
    columns: ["id", "name", "items", "created_at"],
    func: async (page) => {
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const queryId = await resolveTwitterQueryId(page, OPERATION_NAME2, FALLBACK_QUERY_ID2);
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const apiUrl = buildUrl(queryId);
      const data = await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
            return r.ok ? await r.json() : { error: r.status };
        }`);
      if (data?.error) {
        throw new CommandExecutionError(describeTwitterApiError("bookmarkFoldersSlice", data.error, "account may not have folder access"));
      }
      const seen = /* @__PURE__ */ new Set();
      return parseBookmarkFolders(data, seen);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/bookmarks.js
  var BOOKMARKS_QUERY_ID = "Fy0QMy4q_aZCpkO0PnyLYw";
  var FEATURES3 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  function buildBookmarksUrl(count, cursor) {
    const vars = {
      count,
      includePromotedContent: false
    };
    if (cursor)
      vars.cursor = cursor;
    return `/i/api/graphql/${BOOKMARKS_QUERY_ID}/Bookmarks?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES3))}`;
  }
  function extractBookmarkTweet(result, seen) {
    if (!result)
      return null;
    const tw = result.tweet || result;
    const legacy = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id))
      return null;
    seen.add(tw.rest_id);
    const user = tw.core?.user_results?.result;
    const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "";
    const displayName = user?.legacy?.name || user?.core?.name || "";
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    return {
      id: tw.rest_id,
      author: screenName,
      name: displayName,
      text: noteText || legacy.full_text || "",
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      bookmarks: legacy.bookmark_count || 0,
      created_at: legacy.created_at || "",
      url: `https://x.com/${screenName}/status/${tw.rest_id}`,
      ...extractMedia(legacy)
    };
  }
  function parseBookmarks(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.bookmark_timeline_v2?.timeline?.instructions || data?.data?.bookmark_timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const content = entry.content;
        if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
          if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
            nextCursor = content.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = content?.value || content?.itemContent?.value || nextCursor;
          continue;
        }
        const direct = extractBookmarkTweet(content?.itemContent?.tweet_results?.result, seen);
        if (direct) {
          tweets.push(direct);
          continue;
        }
        for (const item of content?.items || []) {
          const nested = extractBookmarkTweet(item.item?.itemContent?.tweet_results?.result, seen);
          if (nested)
            tweets.push(nested);
        }
      }
    }
    return { tweets, nextCursor };
  }
  function readResumeFile(filePath, expected = null) {
    if (!filePath || !node_fs_default.existsSync(filePath))
      return null;
    let parsed;
    try {
      parsed = JSON.parse(node_fs_default.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new CommandExecutionError(`Could not parse Twitter bookmarks resume file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const count = parsed?.count;
    const cursor = parsed?.cursor == null ? null : String(parsed.cursor);
    const outputFile = parsed?.outputFile ? node_path_default.resolve(String(parsed.outputFile)) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Number.isInteger(count) || count < 0 || parsed.cursor != null && typeof parsed.cursor !== "string" || cursor !== null && !cursor.trim()) {
      throw new CommandExecutionError(`Twitter bookmarks resume file ${filePath} has an invalid shape`);
    }
    if (expected) {
      if (parsed.source !== expected.source)
        throw new ArgumentError(`Resume file source mismatch: expected ${expected.source}, found ${parsed.source || "unknown"}`);
      if (outputFile !== expected.outputFile)
        throw new ArgumentError(`Resume file output mismatch: expected ${expected.outputFile || "in-memory mode"}, found ${outputFile || "in-memory mode"}`);
      if (!expected.outputFile && !Array.isArray(parsed.tweets))
        throw new CommandExecutionError(`Twitter bookmarks resume file ${filePath} is missing in-memory tweets`);
      if (!expected.outputFile && parsed.tweets.length !== count)
        throw new CommandExecutionError(`Twitter bookmarks resume file ${filePath} count does not match its in-memory tweets`);
      if (parsed.complete)
        throw new CommandExecutionError(`Twitter bookmarks resume file ${filePath} is already marked complete`);
    }
    return {
      cursor,
      count,
      tweets: Array.isArray(parsed.tweets) ? parsed.tweets : [],
      complete: Boolean(parsed.complete),
      source: parsed.source || null,
      outputFile,
      updatedAt: parsed.updatedAt || null
    };
  }
  function writeResumeFile(filePath, payload) {
    if (!filePath)
      return;
    ensureParentDir(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    try {
      node_fs_default.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2) + "\n");
      node_fs_default.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        node_fs_default.rmSync(temporaryPath, { force: true });
      } catch {
      }
      throw new CommandExecutionError(`Could not persist Twitter bookmarks resume state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cli({
    site: "twitter",
    name: "bookmarks",
    access: "read",
    description: "Fetch your Twitter/X bookmarks (the logged-in user's saved tweets, newest first)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "Maximum number of bookmarks to return (default 20). Ignored when --all is set." },
      { name: "all", type: "bool", default: false, help: "Fetch all bookmark pages until exhausted (in-memory; no file resume)." },
      { name: "max-pages", type: "int", help: `Optional pagination safety cap (default ${DEFAULT_MAX_PAGINATION_PAGES}; raised automatically with --all).` },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the bookmarks by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps the API's native (saved-time) ordering." }
    ],
    columns: ["id", "author", "text", "likes", "retweets", "bookmarks", "created_at", "url", "has_media", "media_urls", "media_posters"],
    func: async (page, kwargs) => {
      const fetchAll = Boolean(kwargs.all);
      const limit = fetchAll ? Number.POSITIVE_INFINITY : kwargs.limit || 20;
      const resumeFile = resolveOptionalFilePath(kwargs["resume-file"], "--resume-file");
      const outputFile = resolveOptionalFilePath(kwargs["output-file"], "--output-file");
      const useOutputFile = Boolean(fetchAll && outputFile);
      const maxPages = resolveMaxPages(kwargs, fetchAll);
      const topByEngagement = Number(kwargs["top-by-engagement"] || 0);
      if (useOutputFile && topByEngagement > 0) {
        throw new ArgumentError("--top-by-engagement cannot be combined with --output-file");
      }
      if (outputFile && !fetchAll) {
        throw new ArgumentError("--output-file requires --all");
      }
      if (resumeFile && !fetchAll) {
        throw new ArgumentError("--resume-file requires --all");
      }
      if (outputFile && !resumeFile) {
        throw new ArgumentError("--output-file requires --resume-file so partial archives remain resumable");
      }
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const queryId = await resolveTwitterQueryId(page, "Bookmarks", BOOKMARKS_QUERY_ID);
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const resumed = fetchAll ? readResumeFile(resumeFile, {
        source: "bookmarks",
        outputFile: useOutputFile ? outputFile : null
      }) : null;
      if (useOutputFile && resumed && resumed.count > 0 && !node_fs_default.existsSync(outputFile)) {
        throw new CommandExecutionError(`Twitter bookmarks output file is missing for resume state: ${outputFile}`);
      }
      if (useOutputFile && !resumed && node_fs_default.existsSync(outputFile)) {
        throw new ArgumentError(`Refusing to overwrite existing Twitter bookmarks output file: ${outputFile}`);
      }
      const allTweets = useOutputFile ? [] : resumed?.tweets ? [...resumed.tweets] : [];
      const jsonlState = useOutputFile ? loadJsonlArchiveState(outputFile) : null;
      const seen = useOutputFile ? jsonlState.seen : new Set(allTweets.map((tweet) => tweet?.id).filter(Boolean));
      if (useOutputFile && resumed && jsonlState.count !== resumed.count) {
        throw new CommandExecutionError(`Twitter bookmarks output file has ${jsonlState.count} record(s), expected resume count ${resumed.count}`);
      }
      let outputCount = useOutputFile ? jsonlState.count : 0;
      let cursor = resumed?.cursor || null;
      let pages = 0;
      let exhausted = false;
      while (pages < maxPages && (fetchAll || allTweets.length < limit)) {
        pages += 1;
        const currentCount = useOutputFile ? outputCount : allTweets.length;
        const remaining = fetchAll ? 100 : limit - currentCount + 10;
        const fetchCount = Math.min(100, remaining);
        const apiUrl = buildBookmarksUrl(fetchCount, cursor).replace(BOOKMARKS_QUERY_ID, queryId);
        const data = unwrapBrowserResult(await page.evaluate(`async () => {
        const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
        return r.ok ? await r.json() : { error: r.status };
      }`));
        if (data?.error) {
          if ((useOutputFile ? outputCount : allTweets.length) === 0)
            throw new CommandExecutionError(describeTwitterApiError("Bookmarks", data.error));
          break;
        }
        const hasInstructions = Array.isArray(data?.data?.bookmark_timeline_v2?.timeline?.instructions) || Array.isArray(data?.data?.bookmark_timeline?.timeline?.instructions);
        if (!hasInstructions) {
          throw new CommandExecutionError("twitter_bookmarks_protocol_error: missing Bookmarks timeline instructions");
        }
        const { tweets, nextCursor } = parseBookmarks(data, seen);
        if (useOutputFile) {
          appendJsonlRows(outputFile, tweets);
          outputCount += tweets.length;
        } else {
          allTweets.push(...tweets);
        }
        const pageComplete = !nextCursor;
        writeResumeFile(resumeFile, {
          cursor: pageComplete ? null : nextCursor,
          count: useOutputFile ? outputCount : allTweets.length,
          tweets: useOutputFile ? void 0 : allTweets,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          complete: pageComplete,
          source: "bookmarks",
          outputFile: useOutputFile ? outputFile : null
        });
        if (pageComplete) {
          exhausted = true;
          break;
        }
        if (nextCursor === cursor) {
          throw new CommandExecutionError("twitter_bookmarks_repeated_cursor: archive completion cannot be proven; resume state was retained");
        }
        cursor = nextCursor;
      }
      const finalCount = useOutputFile ? outputCount : allTweets.length;
      if (finalCount === 0) {
        throw new EmptyResultError("twitter bookmarks", "No bookmarks found for the logged-in account");
      }
      if (exhausted)
        removeResumeFile(resumeFile);
      if (useOutputFile) {
        return {
          outputFile,
          count: outputCount,
          source: "bookmarks",
          complete: exhausted,
          pages,
          ...exhausted ? {} : { cursor, resumeFile: resumeFile || null }
        };
      }
      if (fetchAll && !exhausted) {
        throw new CommandExecutionError(
          `twitter_bookmarks_archive_incomplete: stopped after ${pages} page(s); completion cannot be proven`,
          resumeFile ? `Resume with --resume-file ${resumeFile}` : "Rerun with --resume-file to preserve continuation state."
        );
      }
      const trimmed = fetchAll ? allTweets : allTweets.slice(0, limit);
      return applyTopByEngagement(trimmed, topByEngagement);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/user-timeline.js
  var USER_TWEETS_QUERY_ID = "lrMzG9qPQHpqJdP3AbM-bQ";
  var USER_BY_SCREEN_NAME_QUERY_ID = "IGgvgiOx4QZndDHuD3x9TQ";
  var MAX_USER_TWEETS_PAGES = 100;
  var USER_TWEETS_PAGE_SIZE = 100;
  var MAX_USER_TWEETS_LIMIT = MAX_USER_TWEETS_PAGES * USER_TWEETS_PAGE_SIZE;
  var DEFAULT_USER_TWEETS_PAGE_DELAY_SECONDS = 2;
  var USER_TWEETS_FEATURES = {
    rweb_video_screen_enabled: true,
    rweb_cashtags_enabled: true,
    payments_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  var USER_TWEETS_FIELD_TOGGLES = {
    withPayments: true,
    withAuxiliaryUserLabels: true,
    withArticleRichContentState: true,
    withArticlePlainText: true,
    withArticleSummaryText: true,
    withArticleVoiceOver: true,
    withGrokAnalyze: true,
    withDisallowedReplyControls: true
  };
  var USER_BY_SCREEN_NAME_FEATURES2 = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };
  var USER_BY_SCREEN_NAME_FIELD_TOGGLES = {
    withPayments: true,
    withAuxiliaryUserLabels: true
  };
  var USER_TWEETS_OPERATION = {
    queryId: USER_TWEETS_QUERY_ID,
    features: USER_TWEETS_FEATURES,
    fieldToggles: USER_TWEETS_FIELD_TOGGLES
  };
  var USER_BY_SCREEN_NAME_OPERATION = {
    queryId: USER_BY_SCREEN_NAME_QUERY_ID,
    features: USER_BY_SCREEN_NAME_FEATURES2,
    fieldToggles: USER_BY_SCREEN_NAME_FIELD_TOGGLES
  };
  function normalizeUserTweetsOperation(operation) {
    if (typeof operation === "string") {
      return { queryId: operation, features: USER_TWEETS_FEATURES, fieldToggles: USER_TWEETS_FIELD_TOGGLES };
    }
    return {
      queryId: operation?.queryId || USER_TWEETS_QUERY_ID,
      features: operation?.features || USER_TWEETS_FEATURES,
      fieldToggles: operation?.fieldToggles || USER_TWEETS_FIELD_TOGGLES
    };
  }
  function normalizeUserByScreenNameOperation(operation) {
    if (typeof operation === "string") {
      return { queryId: operation, features: USER_BY_SCREEN_NAME_FEATURES2, fieldToggles: USER_BY_SCREEN_NAME_FIELD_TOGGLES };
    }
    return {
      queryId: operation?.queryId || USER_BY_SCREEN_NAME_QUERY_ID,
      features: operation?.features || USER_BY_SCREEN_NAME_FEATURES2,
      fieldToggles: operation?.fieldToggles || USER_BY_SCREEN_NAME_FIELD_TOGGLES
    };
  }
  function appendGraphqlParams(path, variables, operation) {
    const fieldToggles = operation.fieldToggles || {};
    const params = [
      `variables=${encodeURIComponent(JSON.stringify(variables))}`,
      `features=${encodeURIComponent(JSON.stringify(operation.features || {}))}`
    ];
    if (Object.keys(fieldToggles).length > 0) {
      params.push(`fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`);
    }
    return `${path}?${params.join("&")}`;
  }
  function buildUserTweetsUrl(operation, userId, count, cursor) {
    const normalized = normalizeUserTweetsOperation(operation);
    const vars = {
      userId,
      count,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true
    };
    if (cursor) vars.cursor = cursor;
    return appendGraphqlParams(`/i/api/graphql/${normalized.queryId}/UserTweets`, vars, normalized);
  }
  function buildUserByScreenNameUrl(operation, screenName) {
    const normalized = normalizeUserByScreenNameOperation(operation);
    const vars = { screen_name: screenName, withSafetyModeUserFields: true };
    return appendGraphqlParams(`/i/api/graphql/${normalized.queryId}/UserByScreenName`, vars, normalized);
  }
  async function resolveUserTimelineContext(page, rawUsername, { allowLoggedInDefault = false, commandName = "tweets" } = {}) {
    const raw = String(rawUsername ?? "").trim();
    let username = normalizeTwitterScreenName(raw);
    if (raw && !username) {
      throw new ArgumentError(
        `twitter ${commandName} username must be a valid Twitter/X handle`,
        commandName === "collection" ? "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z" : "Example: opencli twitter tweets @jack --limit 20"
      );
    }
    if (!username && !allowLoggedInDefault) {
      throw new ArgumentError("twitter collection username must be a valid Twitter/X handle", "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z");
    }
    if (!username) {
      await page.goto("https://x.com/home");
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const href = unwrapBrowserResult(await page.evaluate(`() => {
            const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
            return link ? link.getAttribute('href') : null;
        }`));
      if (!href || typeof href !== "string") {
        throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
      username = normalizeTwitterScreenName(href);
      if (!username) {
        throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
    }
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((cookie) => cookie.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const userTweetsOperation = await resolveTwitterOperationMetadata(page, "UserTweets", USER_TWEETS_OPERATION);
    const userByScreenNameOperation = await resolveTwitterOperationMetadata(page, "UserByScreenName", USER_BY_SCREEN_NAME_OPERATION);
    const headers = JSON.stringify({
      Authorization: `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const userByScreenNameUrl = buildUserByScreenNameUrl(userByScreenNameOperation, username);
    const userId = unwrapBrowserResult(await page.evaluate(`async () => {
        const resp = await fetch(${JSON.stringify(userByScreenNameUrl)}, { headers: ${headers}, credentials: 'include' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.data?.user?.result?.rest_id || null;
    }`));
    if (!userId) throw new CommandExecutionError(`Could not resolve @${username}`);
    return { username, userId, headers, userTweetsOperation };
  }
  async function fetchUserTimelinePage(page, context, cursor, count) {
    const url = buildUserTweetsUrl(context.userTweetsOperation, context.userId, count, cursor);
    return normalizeTwitterGraphqlPayload(await page.evaluate(`async () => {
        const response = await fetch(${JSON.stringify(url)}, { headers: ${context.headers}, credentials: 'include' });
        return response.ok ? await response.json() : { error: response.status };
    }`));
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/collection.js
  var RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }
  function normalizeUntil(raw) {
    const value = String(raw ?? "").trim();
    const match = value.match(RFC3339_TIMESTAMP);
    if (!match) {
      throw new ArgumentError(
        "twitter collection --until must be an RFC3339 timestamp",
        "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z"
      );
    }
    const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , zone, , offsetHourRaw, offsetMinuteRaw] = match;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw);
    const offsetHour = zone === "Z" ? 0 : Number(offsetHourRaw);
    const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteRaw);
    const daysInMonth = month === 2 ? isLeapYear(year) ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
      throw new ArgumentError(
        "twitter collection --until must be an RFC3339 timestamp",
        "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z"
      );
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ArgumentError(
        "twitter collection --until must be an RFC3339 timestamp",
        "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z"
      );
    }
    return parsed;
  }
  function normalizeCollectionLimit(rawLimit) {
    const limit = rawLimit ?? MAX_USER_TWEETS_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_USER_TWEETS_LIMIT) {
      throw new ArgumentError(
        `twitter collection --limit must be an integer between 1 and ${MAX_USER_TWEETS_LIMIT}`,
        "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z --limit 250"
      );
    }
    return limit;
  }
  function normalizeCollectionPageDelaySeconds(rawDelay) {
    const delay = rawDelay ?? DEFAULT_USER_TWEETS_PAGE_DELAY_SECONDS;
    if (!Number.isInteger(delay) || delay < 0 || delay > 60) {
      throw new ArgumentError(
        "twitter collection --page-delay must be an integer between 0 and 60 seconds",
        "Example: opencli twitter collection @jack --until 2026-07-23T00:00:00Z --page-delay 2"
      );
    }
    return delay;
  }
  function unwrapTweetResult(result) {
    if (!result) return null;
    if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
    return result.tweet || result;
  }
  function relationshipTarget(result, fallbackId = null, contextStatus = "complete") {
    const tweet = unwrapTweetResult(result);
    const user = tweet?.core?.user_results?.result;
    const rawHandle = user?.legacy?.screen_name || user?.core?.screen_name || null;
    const authorHandle = typeof rawHandle === "string" && normalizeTwitterScreenName(rawHandle) ? normalizeTwitterScreenName(rawHandle) : null;
    const rawAuthorId = user?.rest_id || user?.legacy?.id_str || null;
    const authorId = typeof rawAuthorId === "string" && rawAuthorId.trim() ? rawAuthorId : null;
    const rawPostId = tweet?.rest_id || fallbackId || null;
    const postId = typeof rawPostId === "string" && rawPostId.trim() ? rawPostId : null;
    const hasVisibleContext = Boolean(tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text);
    const resolvedContextStatus = contextStatus === "complete" && !hasVisibleContext ? postId ? "unavailable" : "unknown" : contextStatus;
    return {
      post_id: postId,
      author_handle: authorHandle,
      author_id: authorId,
      url: postId && authorHandle ? `https://x.com/${authorHandle}/status/${postId}` : null,
      context_status: resolvedContextStatus
    };
  }
  function extractRelationship(result) {
    const tweet = unwrapTweetResult(result);
    const legacy = tweet?.legacy || {};
    const repostResult = tweet?.retweeted_status_result?.result || legacy.retweeted_status_result?.result || null;
    const repostId = legacy.retweeted_status_id_str || null;
    if (repostResult || repostId) {
      const target = relationshipTarget(repostResult, repostId, repostResult ? "complete" : "unknown");
      if (!repostResult || !target.post_id) {
        throw new CommandExecutionError("twitter_collection_unresolved_relationship: repost target is unavailable");
      }
      return { kind: "repost", target };
    }
    const quoteResult = tweet?.quoted_status_result?.result || legacy.quoted_status_result?.result || null;
    const quoteId = legacy.quoted_status_id_str || null;
    if (legacy.is_quote_status || quoteResult || quoteId) {
      return {
        kind: "quote",
        target: relationshipTarget(quoteResult, quoteId, quoteResult ? "complete" : "unavailable")
      };
    }
    const replyId = legacy.in_reply_to_status_id_str || null;
    const replyHandle = normalizeTwitterScreenName(legacy.in_reply_to_screen_name || "") || null;
    const replyAuthorId = typeof legacy.in_reply_to_user_id_str === "string" && legacy.in_reply_to_user_id_str.trim() ? legacy.in_reply_to_user_id_str : null;
    if (replyId || replyHandle || replyAuthorId) {
      return {
        kind: "reply",
        target: {
          post_id: replyId,
          author_handle: replyHandle,
          author_id: replyAuthorId,
          url: replyId && replyHandle ? `https://x.com/${replyHandle}/status/${replyId}` : null,
          context_status: replyId ? "unavailable" : "unknown"
        }
      };
    }
    return { kind: "original", target: null };
  }
  function extractCollectionPost(result, seen) {
    const tweet = unwrapTweetResult(result);
    if (!tweet?.rest_id || typeof tweet.rest_id !== "string") {
      throw new CommandExecutionError("twitter_collection_protocol_error: timeline post is missing a stable ID");
    }
    if (seen.has(tweet.rest_id)) return null;
    seen.add(tweet.rest_id);
    const legacy = tweet.legacy || {};
    const user = tweet.core?.user_results?.result;
    const author = user?.legacy?.screen_name || user?.core?.screen_name || null;
    if (!author || !normalizeTwitterScreenName(author)) {
      throw new CommandExecutionError("twitter_collection_protocol_error: timeline post is missing an author handle");
    }
    return {
      id: tweet.rest_id,
      author,
      name: user?.legacy?.name || user?.core?.name || "",
      text: tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || "",
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      views: Number(tweet.views?.count) || 0,
      is_retweet: Boolean(legacy.retweeted_status_result),
      created_at: legacy.created_at || "",
      url: `https://x.com/${author}/status/${tweet.rest_id}`,
      ...extractMedia(legacy),
      quoted_tweet: extractQuotedTweet(tweet),
      relationship: extractRelationship(tweet)
    };
  }
  function parseCollectionPage(payload, seen) {
    if (looksLikePrivateTwitterTimeline(payload)) {
      throw new EmptyResultError(
        "twitter collection",
        "Timeline is private or unavailable to the current X account; completion cannot be proven."
      );
    }
    const result = payload?.data?.user?.result;
    if (!result || typeof result !== "object") {
      throw new CommandExecutionError("twitter_collection_protocol_error: missing UserTweets result");
    }
    const instructionSets = [
      result.timeline_v2?.timeline?.instructions,
      result.timeline?.timeline?.instructions
    ].filter(Array.isArray);
    if (instructionSets.length === 0) {
      throw new CommandExecutionError(
        "twitter_collection_protocol_error: missing UserTweets timeline instructions"
      );
    }
    const posts = [];
    let nextCursor = null;
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "TimelinePinEntry") return;
      if (value.tweet_results?.result) {
        const post = extractCollectionPost(value.tweet_results.result, seen);
        if (post) posts.push(post);
      }
      if ((value.entryType === "TimelineTimelineCursor" || value.__typename === "TimelineTimelineCursor") && (value.cursorType === "Bottom" || value.cursorType === "ShowMore") && value.value) {
        nextCursor = value.value;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") visit(child);
      }
    };
    for (const instructions of instructionSets) visit(instructions);
    return [posts, nextCursor];
  }
  function parseCreatedAt(post) {
    const parsed = new Date(post.created_at);
    if (typeof post.created_at !== "string" || !post.created_at || Number.isNaN(parsed.getTime())) {
      throw new CommandExecutionError(`twitter_collection_invalid_timestamp: post ${post.id}`);
    }
    return parsed;
  }
  function completedReceipt(stopReason, until, pagesFetched, oldestSeenAt) {
    return {
      completed: true,
      stop_reason: stopReason,
      requested_until: until.toISOString(),
      pages_fetched: pagesFetched,
      oldest_seen_at: oldestSeenAt ? oldestSeenAt.toISOString() : null
    };
  }
  async function paginateCollection({ until, limit, maxPages = MAX_USER_TWEETS_PAGES, fetchPage, wait }) {
    const seen = /* @__PURE__ */ new Set();
    const seenCursors = /* @__PURE__ */ new Set();
    const posts = [];
    let cursor = null;
    let oldestSeenAt = null;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (pageIndex > 0 && wait) await wait();
      const payload = await fetchPage(cursor, USER_TWEETS_PAGE_SIZE);
      if (payload?.error) {
        throw new CommandExecutionError(`twitter_collection_request_error: UserTweets returned ${payload.error}`);
      }
      const [pagePosts, nextCursor] = parseCollectionPage(payload, seen);
      for (const post of pagePosts) {
        if (posts.length >= limit) {
          throw new CommandExecutionError("twitter_collection_limit_reached: pagination cannot prove completion");
        }
        const createdAt = parseCreatedAt(post);
        if (!oldestSeenAt || createdAt < oldestSeenAt) oldestSeenAt = createdAt;
        posts.push(post);
        if (createdAt <= until) {
          return {
            posts,
            receipt: completedReceipt("time_boundary_reached", until, pageIndex + 1, oldestSeenAt)
          };
        }
      }
      if (!nextCursor) {
        return {
          posts,
          receipt: completedReceipt("cursor_exhausted", until, pageIndex + 1, oldestSeenAt)
        };
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new CommandExecutionError("twitter_collection_repeated_cursor: pagination cannot prove completion");
      }
      if (posts.length >= limit) {
        throw new CommandExecutionError("twitter_collection_limit_reached: pagination cannot prove completion");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new CommandExecutionError("twitter_collection_page_guard_hit: pagination cannot prove completion");
  }
  cli({
    site: "twitter",
    name: "collection",
    access: "read",
    description: "Fetch a user timeline with relationship facts and a bounded completion receipt.",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, required: true, help: "Twitter screen name (with or without @)." },
      { name: "until", type: "string", required: true, help: "RFC3339 lower time boundary that must be reached or exhausted." },
      { name: "limit", type: "int", default: MAX_USER_TWEETS_LIMIT, help: "Safety ceiling; reaching it is a typed failure." },
      { name: "page-delay", type: "int", default: DEFAULT_USER_TWEETS_PAGE_DELAY_SECONDS, help: "Seconds to wait between cursor pages." }
    ],
    columns: ["posts", "receipt"],
    func: async (page, kwargs) => {
      const until = normalizeUntil(kwargs.until);
      const limit = normalizeCollectionLimit(kwargs.limit);
      const pageDelaySeconds = normalizeCollectionPageDelaySeconds(kwargs["page-delay"]);
      const context = await resolveUserTimelineContext(page, kwargs.username, {
        allowLoggedInDefault: false,
        commandName: "collection"
      });
      return paginateCollection({
        until,
        limit,
        fetchPage: (cursor, count) => fetchUserTimelinePage(page, context, cursor, count),
        wait: pageDelaySeconds > 0 ? () => page.wait(pageDelaySeconds) : null
      });
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/delete.js
  function buildDeleteScript(tweetId) {
    return `(async () => {
      try {
          const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
          ${buildTwitterArticleScopeSource(tweetId)}
          // The article's self-referential /status/<id> link can hydrate late on
          // slow networks, so poll findTargetArticle() for ~5s before giving up.
          let targetArticle = findTargetArticle();
          for (let i = 0; i < 20 && !targetArticle; i++) {
              await new Promise(r => setTimeout(r, 250));
              targetArticle = findTargetArticle();
          }

          if (!targetArticle) {
              return { ok: false, message: 'Could not find the tweet card matching the requested URL.' };
          }

          const belongsToTargetArticle = (el) => el.closest('article') === targetArticle;
          const buttons = Array.from(targetArticle.querySelectorAll('button,[role="button"]')).filter(belongsToTargetArticle);
          // X localizes the "More" caret aria-label (zh-Hans: \u66F4\u591A), so prefer the
          // language-agnostic data-testid and fall back to a multilingual label match.
          const moreMenu = Array.from(targetArticle.querySelectorAll('[data-testid="caret"]')).filter(belongsToTargetArticle).find(visible)
              || buttons.find((el) => visible(el) && /^(More|\u66F4\u591A)/.test((el.getAttribute('aria-label') || '').trim()));
          if (!moreMenu) {
              return { ok: false, message: 'Could not find the "More" context menu on the matched tweet. Are you sure you are logged in and looking at a valid tweet?' };
          }

          const beforeMenuItems = new Set(document.querySelectorAll('[role="menuitem"]'));
          moreMenu.click();
          await new Promise(r => setTimeout(r, 1000));

          const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
              .filter((item) => visible(item) && !beforeMenuItems.has(item));
          const deleteBtn = items.find((item) => {
              const text = (item.textContent || '').trim();
              // X localizes the menu item (zh-Hans: \u5220\u9664); exclude the "Add/remove
              // from Lists" item in both languages so we never click the wrong row.
              return (text.includes('Delete') || text.includes('\u5220\u9664')) && !text.includes('List') && !text.includes('\u5217\u8868');
          });

          if (!deleteBtn) {
              return { ok: false, message: 'The matched tweet menu did not contain Delete. This tweet may not belong to you.' };
          }

          deleteBtn.click();
          await new Promise(r => setTimeout(r, 1000));

          const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (confirmBtn) {
              confirmBtn.click();
              return { ok: true, message: 'Tweet successfully deleted.' };
          } else {
              return { ok: false, message: 'Delete confirmation dialog did not appear.' };
          }
      } catch (e) {
          return { ok: false, message: e.toString() };
      }
  })()`;
  }
  cli({
    site: "twitter",
    name: "delete",
    access: "write",
    description: "Delete a specific tweet by URL",
    domain: "x.com",
    strategy: Strategy.UI,
    // Utilizes internal DOM flows for interaction
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to delete" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter delete");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = unwrapBrowserResult(await page.evaluate(buildDeleteScript(target.id)));
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/device-follow.js
  var DEVICE_FOLLOW_PATH = "/i/api/2/notifications/device_follow.json";
  var MAX_LIMIT = 200;
  function parseLimit(value) {
    if (value === void 0 || value === null || value === "") return 20;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ArgumentError(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return limit;
  }
  function buildDeviceFollowUrl(count) {
    const params = new URLSearchParams({
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "1",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      include_ext_has_nft_avatar: "1",
      include_ext_is_blue_verified: "1",
      include_ext_verified_type: "1",
      skip_status: "1",
      cards_platform: "Web-12",
      include_cards: "1",
      include_ext_alt_text: "true",
      include_quote_count: "true",
      include_reply_count: "1",
      tweet_mode: "extended",
      include_ext_views: "true",
      count: String(count)
    });
    return `${DEVICE_FOLLOW_PATH}?${params.toString()}`;
  }
  function extractEntries(timeline) {
    if (!timeline || !Array.isArray(timeline.instructions)) return null;
    const out = [];
    for (const inst of timeline.instructions) {
      const entries = inst?.addEntries?.entries;
      if (Array.isArray(entries)) out.push(...entries);
    }
    return out;
  }
  function joinEntryToTweet(entry, tweets, users) {
    const tweetId = entry?.content?.item?.content?.tweet?.id;
    if (!tweetId) return null;
    const tw = tweets?.[tweetId];
    if (!tw) return null;
    const user = users?.[tw.user_id_str] || null;
    if (typeof user?.screen_name !== "string" || !user.screen_name) return null;
    return { tweetId, tweet: tw, user };
  }
  function shapeRow({ tweetId, tweet, user }) {
    const screenName = user.screen_name;
    return {
      id: tweetId,
      author: screenName,
      text: tweet?.full_text || tweet?.text || "",
      likes: tweet?.favorite_count ?? 0,
      retweets: tweet?.retweet_count ?? 0,
      replies: tweet?.reply_count ?? 0,
      // The legacy v1.1 endpoint does not return view counts even with
      // include_ext_views=true; surface null rather than a 0 sentinel
      // that would lie about real engagement (typed-errors §3).
      views: null,
      created_at: tweet?.created_at || "",
      url: `https://x.com/${screenName}/status/${tweetId}`
    };
  }
  function parseDeviceFollow(payload, seen) {
    if (!payload?.globalObjects || typeof payload.globalObjects !== "object") return null;
    const tweets = payload?.globalObjects?.tweets || {};
    const users = payload?.globalObjects?.users || {};
    if (typeof tweets !== "object" || typeof users !== "object") return null;
    const entries = extractEntries(payload?.timeline);
    if (!entries) return null;
    const rows = [];
    let unmatchedTweetEntries = 0;
    let malformedEntries = 0;
    for (const entry of entries) {
      const hasTweetEntry = Boolean(entry?.content?.item?.content?.tweet?.id);
      if (!hasTweetEntry) {
        malformedEntries++;
        continue;
      }
      const joined = joinEntryToTweet(entry, tweets, users);
      if (!joined) {
        unmatchedTweetEntries++;
        continue;
      }
      if (seen.has(joined.tweetId)) continue;
      seen.add(joined.tweetId);
      rows.push(shapeRow(joined));
    }
    return { rows, entryCount: entries.length, unmatchedTweetEntries, malformedEntries };
  }
  cli({
    site: "twitter",
    name: "device-follow",
    access: "read",
    description: 'Read the /i/timeline device-follow notification stream (tweets aggregated under a bell-icon "new posts from @userA and N others" notification)',
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: `Maximum number of tweets to return (1-${MAX_LIMIT}, default 20)` },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank by weighted engagement and return the top N. Default 0 keeps upstream ordering." }
    ],
    columns: ["id", "author", "text", "likes", "retweets", "replies", "views", "created_at", "url"],
    func: async (page, kwargs) => {
      const limit = parseLimit(kwargs.limit);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const apiUrl = buildDeviceFollowUrl(limit);
      const headers = JSON.stringify({
        Authorization: `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const data = await page.evaluate(`async () => {
        try {
          const r = await fetch("${apiUrl}", { method: "GET", headers: ${headers}, credentials: 'include' });
          if (!r.ok) return { error: r.status };
          try {
            return await r.json();
          } catch (e) {
            return { errorKind: 'non_json', detail: String(e && e.message || e) };
          }
        } catch (e) {
          return { errorKind: 'exception', detail: String(e && e.message || e) };
        }
      }`);
      if (data?.errorKind === "non_json") {
        throw new CommandExecutionError(`Twitter device-follow returned non-JSON response: ${data.detail || "unknown parse error"}`);
      }
      if (data?.errorKind === "exception") {
        throw new CommandExecutionError(`Twitter device-follow fetch failed: ${data.detail || "unknown error"}`);
      }
      if (data?.error) {
        if (data.error === 401 || data.error === 403) {
          throw new AuthRequiredError("x.com", `Twitter device-follow returned HTTP ${data.error}`);
        }
        throw new CommandExecutionError(describeTwitterApiError("device_follow", data.error));
      }
      const parsed = parseDeviceFollow(data, /* @__PURE__ */ new Set());
      if (!parsed) {
        throw new CommandExecutionError("Twitter device-follow response was missing the expected timeline/globalObjects shape.");
      }
      if (parsed.malformedEntries > 0 || parsed.unmatchedTweetEntries > 0) {
        throw new CommandExecutionError("Twitter device-follow entries could not be joined to tweet/user objects.");
      }
      if (parsed.rows.length === 0) {
        throw new EmptyResultError("twitter device-follow", "No device-follow notification tweets found.");
      }
      const rows = parsed.rows;
      const trimmed = rows.slice(0, limit);
      return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/download.js
  var USER_MEDIA_QUERY_ID = "9EovraBTXJYGSEQXZqlLmQ";
  var USER_BY_SCREEN_NAME_QUERY_ID2 = "IGgvgiOx4QZndDHuD3x9TQ";
  var MAX_PAGINATION_PAGES2 = 100;
  var USER_MEDIA_FEATURES = {
    rweb_video_screen_enabled: true,
    rweb_cashtags_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    rweb_cashtags_composer_attachment_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    rweb_conversational_replies_downvote_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  var USER_MEDIA_FIELD_TOGGLES = {
    withPayments: true,
    withAuxiliaryUserLabels: true,
    withArticleRichContentState: true,
    withArticlePlainText: true,
    withArticleSummaryText: true,
    withArticleVoiceOver: true,
    withGrokAnalyze: true,
    withDisallowedReplyControls: true
  };
  var USER_BY_SCREEN_NAME_FEATURES3 = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };
  var USER_BY_SCREEN_NAME_FIELD_TOGGLES2 = {
    withPayments: true,
    withAuxiliaryUserLabels: true
  };
  var USER_MEDIA_OPERATION = {
    queryId: USER_MEDIA_QUERY_ID,
    features: USER_MEDIA_FEATURES,
    fieldToggles: USER_MEDIA_FIELD_TOGGLES
  };
  var USER_BY_SCREEN_NAME_OPERATION2 = {
    queryId: USER_BY_SCREEN_NAME_QUERY_ID2,
    features: USER_BY_SCREEN_NAME_FEATURES3,
    fieldToggles: USER_BY_SCREEN_NAME_FIELD_TOGGLES2
  };
  function requireLimit(value) {
    const limit = Number(value ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1e3) {
      throw new ArgumentError("--limit must be an integer between 1 and 1000");
    }
    return limit;
  }
  function nextUserMediaFetchCount(limit, downloadedCount) {
    const remaining = limit - downloadedCount;
    if (remaining <= 0) return 0;
    const requested = remaining + 10;
    if (requested > 100) return 100;
    return requested;
  }
  function listTwitterMedia(items) {
    return items.map((item, index) => ({
      index: index + 1,
      tweet_id: item.tweet_id || "",
      url: item.url || "",
      type: item.type || ""
    }));
  }
  function normalizeUserMediaOperation(operation) {
    if (typeof operation === "string") {
      return { queryId: operation, features: USER_MEDIA_FEATURES, fieldToggles: USER_MEDIA_FIELD_TOGGLES };
    }
    return {
      queryId: operation?.queryId || USER_MEDIA_QUERY_ID,
      features: operation?.features || USER_MEDIA_FEATURES,
      fieldToggles: operation?.fieldToggles || USER_MEDIA_FIELD_TOGGLES
    };
  }
  function normalizeUserByScreenNameOperation2(operation) {
    if (typeof operation === "string") {
      return { queryId: operation, features: USER_BY_SCREEN_NAME_FEATURES3, fieldToggles: USER_BY_SCREEN_NAME_FIELD_TOGGLES2 };
    }
    return {
      queryId: operation?.queryId || USER_BY_SCREEN_NAME_QUERY_ID2,
      features: operation?.features || USER_BY_SCREEN_NAME_FEATURES3,
      fieldToggles: operation?.fieldToggles || USER_BY_SCREEN_NAME_FIELD_TOGGLES2
    };
  }
  function appendGraphqlParams2(path, variables, operation) {
    const fieldToggles = operation.fieldToggles || {};
    const params = [
      `variables=${encodeURIComponent(JSON.stringify(variables))}`,
      `features=${encodeURIComponent(JSON.stringify(operation.features || {}))}`
    ];
    if (Object.keys(fieldToggles).length > 0) {
      params.push(`fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`);
    }
    return `${path}?${params.join("&")}`;
  }
  function buildUserMediaUrl(operation, userId, count, cursor) {
    const normalized = normalizeUserMediaOperation(operation);
    const vars = {
      userId,
      count,
      includePromotedContent: false,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      withVoice: true
    };
    if (cursor) vars.cursor = cursor;
    return appendGraphqlParams2(`/i/api/graphql/${normalized.queryId}/UserMedia`, vars, normalized);
  }
  function buildUserByScreenNameUrl2(operation, screenName) {
    const normalized = normalizeUserByScreenNameOperation2(operation);
    const vars = { screen_name: screenName, withSafetyModeUserFields: true };
    return appendGraphqlParams2(`/i/api/graphql/${normalized.queryId}/UserByScreenName`, vars, normalized);
  }
  function classifyMediaUrl(url) {
    if (!url) return "unknown";
    if (/video\.twimg\.com|\.mp4(\?|$)|\.m3u8(\?|$)/.test(url)) return "video";
    return "image";
  }
  function requireObjectPayload(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CommandExecutionError(`Twitter ${context} returned malformed payload`);
    }
    return value;
  }
  function throwGraphqlFetchError(context, status, message) {
    if (status === 401 || status === 403) {
      throw new AuthRequiredError("x.com", `Twitter ${context} requires an authenticated x.com session`);
    }
    if (status === 404) {
      throw new EmptyResultError(`twitter download ${context}`, message || "Twitter returned not found");
    }
    const statusText = status ? `HTTP ${status}` : "fetch failed";
    throw new CommandExecutionError(`Twitter ${context} fetch failed: ${statusText}${message ? ` - ${message}` : ""}`);
  }
  function requireFetchPayload(value, context) {
    const result = requireObjectPayload(unwrapBrowserResult(value), context);
    if (result.ok === true) {
      return result.payload;
    }
    if (result.ok === false) {
      throwGraphqlFetchError(context, Number(result.status) || 0, typeof result.error === "string" ? result.error : "");
    }
    throw new CommandExecutionError(`Twitter ${context} returned malformed fetch result`);
  }
  function requireUserMediaPayload(data) {
    const payload = requireObjectPayload(data, "UserMedia");
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new CommandExecutionError(`Twitter UserMedia returned GraphQL errors: ${JSON.stringify(payload.errors).slice(0, 200)}`);
    }
    const result = payload.data?.user?.result;
    if (!result || typeof result !== "object") {
      throw new CommandExecutionError("Twitter UserMedia returned malformed user result");
    }
    const instructions = result.timeline_v2?.timeline?.instructions || result.timeline?.timeline?.instructions;
    if (!Array.isArray(instructions)) {
      throw new CommandExecutionError("Twitter UserMedia returned malformed timeline instructions");
    }
    return payload;
  }
  function parseUserMedia(data, seen) {
    const items = [];
    let nextCursor = null;
    const result = requireUserMediaPayload(data).data.user.result;
    const instructionSets = [
      result.timeline_v2?.timeline?.instructions,
      result.timeline?.timeline?.instructions
    ].filter(Array.isArray);
    const instructions = instructionSets.flat();
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "TimelinePinEntry") return;
      if (value.tweet_results?.result) {
        const raw = value.tweet_results.result;
        const tw = raw.__typename === "TweetWithVisibilityResults" && raw.tweet ? raw.tweet : raw.tweet || raw;
        const tweetId = typeof tw.rest_id === "string" || typeof tw.rest_id === "number" ? String(tw.rest_id) : "";
        if (!tweetId) {
          throw new CommandExecutionError("Twitter UserMedia returned a tweet without rest_id");
        }
        if (!seen.has(tweetId)) {
          seen.add(tweetId);
          const { media_urls } = extractMedia(tw.legacy || {});
          for (const url of media_urls) {
            items.push({ tweet_id: tweetId, url, type: classifyMediaUrl(url) });
          }
        }
      }
      if ((value.entryType === "TimelineTimelineCursor" || value.__typename === "TimelineTimelineCursor") && (value.cursorType === "Bottom" || value.cursorType === "ShowMore") && value.value) {
        nextCursor = value.value;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") visit(child);
      }
    };
    visit(instructions);
    return { items, nextCursor };
  }
  cli({
    site: "twitter",
    name: "download",
    access: "read",
    description: "List Twitter/X media URLs (images and videos). Provide either <username> to scan profile media via the GraphQL UserMedia endpoint with cursor pagination, or --tweet-url for a single tweet. Returns URLs only; download them through your own channel.",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "username", positional: true, help: "Twitter username (with or without @) to scan their profile media. Either <username> or --tweet-url is required." },
      { name: "tweet-url", help: "Single tweet URL to download. Use this OR <username>, not both required at once." },
      { name: "limit", type: "int", default: 10, help: "Maximum number of media items when scanning a profile (default 10). Ignored when --tweet-url is used." }
    ],
    columns: ["index", "tweet_id", "url", "type"],
    func: async (page, kwargs) => {
      try {
        const rawUsername = String(kwargs.username ?? "").trim();
        const tweetUrl = String(kwargs["tweet-url"] ?? "").trim();
        if (!rawUsername && !tweetUrl) {
          throw new ArgumentError("twitter download requires either <username> or --tweet-url");
        }
        if (rawUsername && tweetUrl) {
          throw new ArgumentError("Use either <username> or --tweet-url, not both");
        }
        if (tweetUrl) {
          return downloadSingleTweet(page, tweetUrl);
        }
        const limit = requireLimit(kwargs.limit);
        const username = normalizeTwitterScreenName(rawUsername);
        if (!username) {
          throw new ArgumentError("twitter download username must be a valid Twitter/X handle", "Example: opencli twitter download @jack --limit 20");
        }
        return downloadUserMedia(page, username, limit);
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CommandExecutionError(`twitter download failed: ${err?.message ?? String(err)}`);
      }
    }
  });
  async function downloadUserMedia(page, username, limit) {
    await page.goto(`https://x.com/${username}`);
    await page.wait({ selector: '[data-testid="primaryColumn"]' });
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const userMediaOperation = await resolveTwitterOperationMetadata(page, "UserMedia", USER_MEDIA_OPERATION);
    const userByScreenNameOperation = await resolveTwitterOperationMetadata(page, "UserByScreenName", USER_BY_SCREEN_NAME_OPERATION2);
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const ubsUrl = buildUserByScreenNameUrl2(userByScreenNameOperation, username);
    const userLookup = requireFetchPayload(await page.evaluate(`async () => {
      try {
        const resp = await fetch("${ubsUrl}", { headers: ${headers}, credentials: 'include' });
        if (!resp.ok) return { ok: false, status: resp.status };
        const payload = await resp.json();
        return { ok: true, payload };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    }`));
    const normalizedUserLookup = normalizeTwitterGraphqlPayload(userLookup);
    if (Array.isArray(normalizedUserLookup?.errors) && normalizedUserLookup.errors.length > 0) {
      throw new CommandExecutionError(`Twitter UserByScreenName returned GraphQL errors: ${JSON.stringify(normalizedUserLookup.errors).slice(0, 200)}`);
    }
    const userId = normalizedUserLookup?.data?.user?.result?.rest_id;
    if (!userId) throw new EmptyResultError(`twitter download @${username}`, `Could not resolve @${username}`);
    const seen = /* @__PURE__ */ new Set();
    const all = [];
    let cursor = null;
    let hasMorePages = false;
    for (let i = 0; i < MAX_PAGINATION_PAGES2 && all.length < limit; i++) {
      const fetchCount = nextUserMediaFetchCount(limit, all.length);
      if (fetchCount === 0) break;
      const url = buildUserMediaUrl(userMediaOperation, userId, fetchCount, cursor);
      const data = normalizeTwitterGraphqlPayload(requireFetchPayload(await page.evaluate(`async () => {
        try {
          const r = await fetch("${url}", { headers: ${headers}, credentials: 'include' });
          if (!r.ok) return { ok: false, status: r.status };
          return { ok: true, payload: await r.json() };
        } catch (err) {
          return { ok: false, error: err?.message ?? String(err) };
        }
        }`)));
      const { items, nextCursor } = parseUserMedia(data, seen);
      all.push(...items);
      hasMorePages = Boolean(nextCursor);
      if (!nextCursor) break;
      if (nextCursor === cursor) {
        throw new CommandExecutionError("Twitter UserMedia pagination returned the same cursor twice");
      }
      cursor = nextCursor;
    }
    if (all.length === 0) throw new EmptyResultError(`@${username} has no media`, "Account may be private, suspended, or have no media posts");
    if (all.length < limit && hasMorePages) {
      throw new CommandExecutionError(`Twitter UserMedia pagination reached the ${MAX_PAGINATION_PAGES2}-page safety cap before collecting ${limit} media items`);
    }
    const trimmed = all.slice(0, limit);
    return listTwitterMedia(trimmed);
  }
  async function downloadSingleTweet(page, tweetUrl) {
    const target = parseTweetUrl(tweetUrl);
    await page.goto(target.url);
    const cookies = await page.getCookies({ url: 'https://x.com' });
    const ct0 = cookies.find(cookie => cookie.name === 'ct0')?.value;
    if (!ct0) throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');
    const headers = { Authorization: 'Bearer ' + decodeURIComponent(TWITTER_BEARER_TOKEN), 'X-Csrf-Token': ct0,
      'X-Twitter-Auth-Type': 'OAuth2Session', 'X-Twitter-Active-User': 'yes' };
    const response = await page.evaluate(async (url, headers) => {
      const r = await fetch(url, { headers, credentials: 'include' });
      return { ok: r.ok, status: r.status, payload: await r.json() };
    }, buildTweetDetailUrl(target.id, null), headers);
    const payload = requireFetchPayload(response, 'TweetDetail');
    if (Array.isArray(payload.errors) && payload.errors.length) throw new CommandExecutionError('Twitter media query returned GraphQL errors');
    const row = parseTweetDetail(payload, new Set()).tweets.find(tweet => tweet.id === target.id);
    if (!row) throw new EmptyResultError('twitter download ' + target.id, 'Requested tweet was not present in the response');
    const items = [...new Set(row.media_urls || [])].map(url => ({ tweet_id: target.id, url, type: classifyMediaUrl(url) }));
    if (!items.length) throw new EmptyResultError('twitter download ' + target.id, 'No media found in the tweet');
    return listTwitterMedia(items);
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/follow.js
  cli({
    site: "twitter",
    name: "follow",
    access: "write",
    description: "Follow a Twitter user",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, required: true, help: "Twitter screen name (without @)" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter follow");
      const username = kwargs.username.replace(/^@/, "");
      await page.goto(`https://x.com/${username}`);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            let attempts = 0;
            let followBtn = null;
            let unfollowTestId = null;

            while (attempts < 20) {
                // Check if already following (button shows screen_name-unfollow)
                unfollowTestId = document.querySelector('[data-testid$="-unfollow"]');
                if (unfollowTestId) {
                    return { ok: true, message: 'Already following @${username}.' };
                }

                // Look for the Follow button
                followBtn = document.querySelector('[data-testid$="-follow"]');
                if (followBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!followBtn) {
                return { ok: false, message: 'Could not find Follow button. Are you logged in?' };
            }

            writeStarted = true;
            followBtn.click();
            await new Promise(r => setTimeout(r, 1500));

            // Verify
            const verify = document.querySelector('[data-testid$="-unfollow"]');
            if (verify) {
                return { ok: true, message: 'Successfully followed @${username}.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Follow action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter follow confirmation", 1.5, `${result.message} Check the profile before retrying; the follow may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the profile in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/follow-batch.js
  var USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
  var DEFAULT_DELAY_MS = 3e3;
  var MAX_DELAY_MS = 6e4;
  function parseBatchUsernames(input) {
    const raw = String(input || "").trim();
    if (!raw) {
      throw new ArgumentError("At least one Twitter/X username is required");
    }
    const usernames = [];
    const seen = /* @__PURE__ */ new Set();
    for (const part of raw.split(",")) {
      const username = part.trim().replace(/^@+/, "");
      if (!username) continue;
      if (!USERNAME_RE.test(username)) {
        throw new ArgumentError(`Invalid Twitter/X username: ${JSON.stringify(part.trim())}`);
      }
      const key = username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      usernames.push(username);
    }
    if (!usernames.length) {
      throw new ArgumentError("At least one Twitter/X username is required");
    }
    return usernames;
  }
  async function readFollowState(page, username) {
    return unwrapBrowserResult(await page.evaluate(`(async () => {
        try {
            let attempts = 0;
            while (attempts < 20) {
                const unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
                if (unfollowBtn) {
                    return { ok: true, status: 'noop', message: 'Already following @${username}.' };
                }

                const followBtn = document.querySelector('[data-testid$="-follow"]');
                if (followBtn) {
                    return { ok: false, followButtonVisible: true };
                }

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            return { ok: false, followButtonVisible: false };
        } catch (e) {
            return { ok: false, message: e.toString() };
        }
    })()`));
  }
  async function clickFollowAndVerify(page, username) {
    return unwrapBrowserResult(await page.evaluate(`(async () => {
        try {
            const followBtn = document.querySelector('[data-testid$="-follow"]');
            if (!followBtn) {
                return { ok: false, retryAfterRefresh: true, message: 'Could not find Follow button after loading profile.' };
            }

            followBtn.click();
            for (let attempts = 0; attempts < 20; attempts++) {
                await new Promise(r => setTimeout(r, 500));
                const verify = document.querySelector('[data-testid$="-unfollow"]');
                if (verify) {
                    return { ok: true, status: 'success', message: 'Successfully followed @${username}.' };
                }
            }

            return { ok: false, retryAfterRefresh: true, message: 'Follow action initiated but UI did not update.' };
        } catch (e) {
            return { ok: false, message: e.toString() };
        }
    })()`));
  }
  async function followOne(page, username) {
    await page.goto(`https://x.com/${username}`);
    await page.wait({ selector: '[data-testid="primaryColumn"]' });
    let result = await readFollowState(page, username);
    if (!result.ok && result.followButtonVisible) {
      result = await clickFollowAndVerify(page, username);
    }
    if (!result.ok && result.retryAfterRefresh) {
      await page.goto(`https://x.com/${username}`);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const refreshed = await readFollowState(page, username);
      if (refreshed.ok) {
        result = { ...refreshed, status: "success", message: `Successfully followed @${username}.` };
      }
    }
    if (!result.ok && !result.message) {
      result = { ...result, message: "Could not find Follow button. Are you logged in?" };
    }
    if (result.ok) {
      await page.wait(1);
    }
    return {
      username,
      status: result.ok ? result.status : "failed",
      message: result.message
    };
  }
  function parseDelayMs(input) {
    if (input === void 0 || input === null || input === "") {
      return DEFAULT_DELAY_MS;
    }
    const value = Number(input);
    if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
      throw new ArgumentError(`delay-ms must be an integer between 0 and ${MAX_DELAY_MS}`);
    }
    return value;
  }
  cli({
    site: "twitter",
    name: "follow-batch",
    access: "write",
    description: "Follow multiple Twitter/X users from a comma-separated username list",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "usernames", type: "string", positional: true, required: true, help: "Comma-separated Twitter/X screen names, with or without @" },
      { name: "delay-ms", type: "int", default: DEFAULT_DELAY_MS, help: "Delay between follow attempts in milliseconds" }
    ],
    columns: ["username", "status", "message"],
    func: async (page, kwargs) => {
      if (!page) {
        throw new CommandExecutionError("Browser session required for twitter follow-batch");
      }
      const usernames = parseBatchUsernames(kwargs.usernames);
      const delayMs = parseDelayMs(kwargs["delay-ms"]);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((cookie) => cookie.name === "ct0")?.value || null;
      if (!ct0) {
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      }
      const rows = [];
      for (const [index, username] of usernames.entries()) {
        if (index > 0 && delayMs > 0) {
          await page.wait(delayMs / 1e3);
        }
        rows.push(await followOne(page, username));
      }
      return rows;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/followers.js
  var MAX_PAGINATION_PAGES3 = 100;
  var CAPTURE_TIMEOUT_SECONDS = 10;
  function extractFollower(result) {
    if (!result || result.__typename !== "User")
      return null;
    const core = result.core || {};
    const legacy = result.legacy || {};
    const screenName = core.screen_name || legacy.screen_name || "";
    if (!screenName) {
      throw new CommandExecutionError("Malformed Twitter follower: missing screen_name");
    }
    return {
      screen_name: screenName,
      name: core.name || legacy.name || "",
      bio: result.profile_bio?.description || legacy.description || ""
    };
  }
  function parseFollowers(value) {
    const data = normalizeTwitterGraphqlPayload(value);
    const users = [];
    let nextCursor = null;
    let bottomTerminated = false;
    const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || data?.data?.user?.result?.timeline?.timeline?.instructions || [];
    for (const instruction of instructions) {
      if (instruction?.type === "TimelineTerminateTimeline" && instruction.direction === "Bottom") {
        bottomTerminated = true;
      }
      for (const entry of instruction.entries || []) {
        const content = entry.content;
        if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
          if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
            nextCursor = content.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = content?.value || content?.itemContent?.value || nextCursor;
          continue;
        }
        if (entry.entryId?.startsWith("user-")) {
          const user = extractFollower(content?.itemContent?.user_results?.result);
          if (user)
            users.push(user);
        }
      }
    }
    return { data, users, nextCursor: bottomTerminated ? null : nextCursor, bottomTerminated };
  }
  function twitterGraphqlError(payload) {
    const errors = payload?.errors;
    if (!Array.isArray(errors) || errors.length === 0)
      return null;
    const first = errors[0] || {};
    const code = first.code === void 0 ? "" : ` ${first.code}`;
    const message = typeof first.message === "string" ? `: ${first.message}` : "";
    return `Twitter Followers GraphQL error${code}${message}`;
  }
  function normalizeScreenName(value) {
    return normalizeTwitterScreenName(value);
  }
  cli({
    site: "twitter",
    name: "followers",
    access: "read",
    description: "Get accounts following a Twitter/X user (defaults to the logged-in user when no user is given)",
    domain: "x.com",
    strategy: Strategy.INTERCEPT,
    browser: true,
    args: [
      {
        name: "user",
        positional: true,
        type: "string",
        required: false,
        help: "Twitter/X handle (with or without @). Omit to fetch followers of the currently logged-in account."
      },
      { name: "limit", type: "int", default: 50, help: "Maximum number of follower rows to return (default 50). Must be a positive integer." }
    ],
    // Preserve the historical three-column contract even though the GraphQL
    // payload also contains per-user relationship counts. Use `twitter profile`
    // when a dedicated follower count is needed.
    columns: ["screen_name", "name", "bio"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit;
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new ArgumentError("limit must be a positive integer");
      }
      const rawUser = String(kwargs.user ?? "").trim();
      let targetUser = normalizeScreenName(rawUser);
      if (rawUser && !targetUser) {
        throw new ArgumentError("twitter followers user must be a valid Twitter/X handle", "Example: opencli twitter followers @elonmusk --limit 100");
      }
      await page.goto("https://x.com/home");
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((cookie) => cookie.name === "ct0")?.value || null;
      if (!ct0) {
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      }
      if (!targetUser) {
        const href = unwrapBrowserResult(await page.evaluate(`() => {
                const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
                return link ? link.getAttribute('href') : null;
            }`));
        if (!href || typeof href !== "string") {
          throw new AuthRequiredError("x.com", "Could not find logged-in user profile link. Are you logged in?");
        }
        targetUser = normalizeScreenName(href);
        if (!targetUser) {
          throw new AuthRequiredError("x.com", "Could not find logged-in user profile link. Are you logged in?");
        }
      }
      if (!targetUser) {
        throw new ArgumentError("twitter followers user cannot be empty", "Example: opencli twitter followers @elonmusk --limit 100");
      }
      await page.installInterceptor("/Followers?");
      const targetPath = `/${targetUser}/followers`;
      await page.evaluate(`() => {
            const targetPath = ${JSON.stringify(targetPath)};
            window.history.pushState({}, '', targetPath);
            window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        }`);
      try {
        await page.waitForCapture(CAPTURE_TIMEOUT_SECONDS);
      } catch {
        throw new TimeoutError("twitter followers API capture", CAPTURE_TIMEOUT_SECONDS, "No Followers response was observed after opening the followers list.");
      }
      const currentPath = unwrapBrowserResult(await page.evaluate("() => window.location.pathname"));
      if (typeof currentPath !== "string" || !currentPath.toLowerCase().endsWith("/followers")) {
        throw new CommandExecutionError("SPA navigation to Twitter followers failed");
      }
      const allFollowers = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      let lastRawResponse = null;
      let pages = 0;
      const consumeCaptured = async () => {
        const requests = await page.getInterceptedRequests();
        if (!Array.isArray(requests)) {
          throw new CommandExecutionError("Twitter followers interceptor returned malformed responses");
        }
        for (const request of requests) {
          const { data, users, nextCursor } = parseFollowers(request.data);
          const graphqlError = twitterGraphqlError(data);
          if (graphqlError)
            throw new CommandExecutionError(graphqlError);
          lastRawResponse = data;
          for (const user of users) {
            if (!seen.has(user.screen_name)) {
              seen.add(user.screen_name);
              allFollowers.push(user);
            }
          }
          cursor = nextCursor;
        }
      };
      await consumeCaptured();
      while (allFollowers.length < limit && cursor && pages < MAX_PAGINATION_PAGES3) {
        const beforeCount = allFollowers.length;
        const beforeCursor = cursor;
        await page.autoScroll({ times: 1, delayMs: 500 });
        try {
          await page.waitForCapture(CAPTURE_TIMEOUT_SECONDS);
        } catch {
          throw new TimeoutError("twitter followers pagination", CAPTURE_TIMEOUT_SECONDS, `Twitter returned a continuation cursor after ${allFollowers.length} rows, but the next Followers response was not observed.`);
        }
        await consumeCaptured();
        pages++;
        if (allFollowers.length === beforeCount && cursor === beforeCursor) {
          throw new CommandExecutionError("Twitter followers pagination repeated a cursor without returning new users");
        }
      }
      if (allFollowers.length < limit && cursor && pages >= MAX_PAGINATION_PAGES3) {
        throw new CommandExecutionError(`Twitter followers pagination exceeded ${MAX_PAGINATION_PAGES3} pages before cursor exhaustion`);
      }
      if (allFollowers.length === 0) {
        if (looksLikePrivateTwitterTimeline(lastRawResponse)) {
          throw new EmptyResultError("twitter followers", `No follower data returned for @${targetUser} (the target account may have set their followers list to private)`);
        }
        throw new EmptyResultError("twitter followers", `No followers found for @${targetUser}`);
      }
      return allFollowers.slice(0, limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/following.js
  var FOLLOWING_QUERY_ID = "F42cDX8PDFxkbjjq6JrM2w";
  var USER_BY_SCREEN_NAME_QUERY_ID3 = "IGgvgiOx4QZndDHuD3x9TQ";
  var MAX_PAGINATION_PAGES4 = 100;
  var FEATURES4 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  function buildFollowingUrl(queryId, userId, count, cursor) {
    const vars = {
      userId,
      count,
      includePromotedContent: false,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true
    };
    if (cursor)
      vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/Following?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES4))}`;
  }
  function extractUser(result) {
    if (!result || result.__typename !== "User")
      return null;
    const core = result.core || {};
    const legacy = result.legacy || {};
    const screenName = core.screen_name || legacy.screen_name || "";
    if (!screenName) {
      throw new CommandExecutionError("Malformed Twitter following user: missing screen_name");
    }
    return {
      screen_name: screenName,
      name: core.name || legacy.name || "",
      bio: legacy.description || result.profile_bio?.description || "",
      followers: result.relationship_counts?.followers ?? legacy.followers_count ?? legacy.normal_followers_count ?? 0
    };
  }
  function parseFollowing(data) {
    const users = [];
    let nextCursor = null;
    const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || data?.data?.user?.result?.timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const content = entry.content;
        if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
          if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
            nextCursor = content.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = content?.value || content?.itemContent?.value || nextCursor;
          continue;
        }
        if (entry.entryId?.startsWith("user-")) {
          const user = extractUser(content?.itemContent?.user_results?.result);
          if (user)
            users.push(user);
        }
      }
    }
    return { users, nextCursor };
  }
  function normalizeScreenName2(value) {
    return normalizeTwitterScreenName(value);
  }
  cli({
    site: "twitter",
    name: "following",
    access: "read",
    description: "Get accounts a Twitter/X user is following (defaults to the logged-in user when no user is given)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      {
        name: "user",
        positional: true,
        type: "string",
        required: false,
        help: "Twitter/X handle (with or without @). Omit to fetch the accounts the currently logged-in user follows."
      },
      { name: "limit", type: "int", default: 50, help: "Maximum number of following rows to return (default 50). Must be a positive integer." }
    ],
    columns: ["screen_name", "name", "bio", "followers"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit === void 0 || kwargs.limit === null ? 50 : Number(kwargs.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new ArgumentError("twitter following --limit must be a positive integer", "Example: opencli twitter following @elonmusk --limit 200");
      }
      const rawUser = String(kwargs.user ?? "").trim();
      let targetUser = normalizeScreenName2(rawUser);
      if (rawUser && !targetUser) {
        throw new ArgumentError("twitter following user must be a valid Twitter/X handle", "Example: opencli twitter following @elonmusk --limit 200");
      }
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      if (!targetUser) {
        await page.goto("https://x.com/home");
        await page.wait({ selector: '[data-testid="primaryColumn"]' });
        const href = unwrapBrowserResult(await page.evaluate(`() => {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href') : null;
      }`));
        if (!href || typeof href !== "string")
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
        targetUser = normalizeScreenName2(href);
        if (!targetUser)
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
      if (!targetUser) {
        throw new ArgumentError("twitter following user cannot be empty", "Example: opencli twitter following @elonmusk --limit 200");
      }
      const followingQueryId = await resolveTwitterQueryId(page, "Following", FOLLOWING_QUERY_ID);
      const userByScreenNameQueryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID3);
      const headers = {
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      };
      const userLookup = unwrapBrowserResult(await page.evaluate(async (url, headers2) => {
        const resp = await fetch(url, { headers: headers2, credentials: "include" });
        if (!resp.ok) return { error: resp.status };
        const d = await resp.json();
        return { userId: d.data?.user?.result?.rest_id || null };
      }, buildUserByScreenNameQueryUrl(userByScreenNameQueryId, targetUser), headers));
      if (userLookup?.error === 401 || userLookup?.error === 403) {
        throw new AuthRequiredError("x.com", `Twitter user lookup failed (HTTP ${userLookup.error})`);
      }
      if (userLookup?.error) {
        throw new CommandExecutionError(`HTTP ${userLookup.error}: Failed to resolve Twitter user @${targetUser}`);
      }
      const userId = userLookup?.userId || null;
      if (!userId)
        throw new CommandExecutionError(`Could not find user @${targetUser}`);
      const allUsers = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      let lastRawResponse = null;
      for (let i = 0; i < MAX_PAGINATION_PAGES4 && allUsers.length < limit; i++) {
        const fetchCount = Math.min(50, limit - allUsers.length + 10);
        const apiUrl = buildFollowingUrl(followingQueryId, userId, fetchCount, cursor);
        const data = unwrapBrowserResult(await page.evaluate(async (url, headers2) => {
          const r = await fetch(url, { headers: headers2, credentials: "include" });
          return r.ok ? await r.json() : { error: r.status };
        }, apiUrl, headers));
        if (data?.error) {
          if (data.error === 401 || data.error === 403)
            throw new AuthRequiredError("x.com", `Twitter following request failed (HTTP ${data.error})`);
          throw new CommandExecutionError(describeTwitterApiError("Following", data.error));
        }
        lastRawResponse = data;
        const { users, nextCursor } = parseFollowing(data);
        for (const u of users) {
          if (!seen.has(u.screen_name)) {
            seen.add(u.screen_name);
            allUsers.push(u);
          }
        }
        if (!nextCursor || nextCursor === cursor)
          break;
        cursor = nextCursor;
      }
      if (allUsers.length === 0) {
        if (looksLikePrivateTwitterTimeline(lastRawResponse)) {
          throw new EmptyResultError("twitter following", `No following data returned for @${targetUser} (the target account may have set their following list to private)`);
        }
        throw new EmptyResultError("twitter following", `No following accounts found for @${targetUser}`);
      }
      return allUsers.slice(0, limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/hide-reply.js
  cli({
    site: "twitter",
    name: "hide-reply",
    access: "write",
    description: "Hide a reply on your tweet (useful for hiding bot/spam replies)",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the reply tweet to hide" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter hide-reply");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const runHideAttempt = (allowParentDiscovery) => page.evaluate(`(async () => {
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const moreLabels = new Set(['More', '\u66F4\u591A']);
            const findParentConversationUrl = (targetArticle) => {
                const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
                const articles = Array.from(primary.querySelectorAll('article'));
                const targetIndex = articles.indexOf(targetArticle);
                if (targetIndex <= 0) return null;
                for (let index = targetIndex - 1; index >= 0; index -= 1) {
                    const links = Array.from(articles[index].querySelectorAll('a[href*="/status/"]'))
                        .filter((link) => link.querySelector('time'));
                    for (const link of links) {
                        const statusId = __twGetStatusIdFromHref(link.href);
                        if (statusId && statusId !== tweetId) {
                            const parsed = new URL(link.href, window.location.origin);
                            if (parsed.origin === window.location.origin) {
                                return parsed.toString();
                            }
                        }
                    }
                }
                return null;
            };
            // Locate the article matching the requested status id, then find
            // its More menu. Without article scoping we'd grab whatever the
            // first "More" button on the page is \u2014 usually the parent tweet
            // (silent: hide the wrong reply, or fail silently if the parent
            // is not a reply you authored).
            let attempts = 0;
            let targetArticle = null;
            let moreMenu = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                if (targetArticle) {
                    const buttons = Array.from(targetArticle.querySelectorAll('button,[role="button"]'));
                    moreMenu = buttons.find((el) => visible(el) && moreLabels.has((el.getAttribute('aria-label') || '').trim()));
                    if (moreMenu) break;
                }
                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!targetArticle) {
                return { ok: false, message: 'Could not find the requested reply article on this page.' };
            }
            if (!moreMenu) {
                return { ok: false, message: 'Could not find the "More" menu on the requested reply. Are you logged in?' };
            }

            moreMenu.click();
            await new Promise(r => setTimeout(r, 1000));

            // Look for the "Hide reply" menu item. Menu items render at the
            // document root, not inside the article \u2014 scope is the open menu.
            const items = document.querySelectorAll('[role="menuitem"]');
            let hideItem = null;
            for (const item of items) {
                const text = String(item.textContent || '');
                const testId = item.getAttribute('data-testid');
                if (
                    testId === 'hideReply'
                    || text.includes('Hide reply')
                    || text.includes('\u9690\u85CF\u56DE\u590D')
                    || (text.includes('\u9690\u85CF') && text.includes('\u56DE\u590D') && !text.includes('\u53D6\u6D88'))
                ) {
                    hideItem = item;
                    break;
                }
            }

            if (!hideItem) {
                if (${allowParentDiscovery ? "true" : "false"}) {
                    const parentUrl = findParentConversationUrl(targetArticle);
                    if (parentUrl) {
                        return { ok: false, retryOnParent: true, parentUrl, message: 'Hide reply option is not present on standalone reply page; retrying in parent conversation.' };
                    }
                }
                return { ok: false, message: 'Could not find "Hide reply" option. This may not be a reply on your tweet.' };
            }

            hideItem.click();
            await new Promise(r => setTimeout(r, 1500));

            return { ok: true, message: 'Reply successfully hidden.' };
        } catch (e) {
            return { ok: false, message: e.toString() };
        }
    })()`);
      let result = await runHideAttempt(true);
      if (result?.retryOnParent && result.parentUrl) {
        await page.goto(result.parentUrl);
        await page.wait({ selector: '[data-testid="primaryColumn"]' });
        result = await runHideAttempt(false);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/like.js
  cli({
    site: "twitter",
    name: "like",
    access: "write",
    description: "Like a specific tweet",
    domain: "x.com",
    strategy: Strategy.UI,
    // Utilizes internal DOM flows for interaction
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to like" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter like");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            // Poll for the tweet to render. We scope state probes to the
            // article matching the requested status id \u2014 on conversation
            // pages multiple articles render and a bare querySelector would
            // grab the first one (silent: like the wrong tweet).
            let attempts = 0;
            let likeBtn = null;
            let unlikeBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                likeBtn = targetArticle?.querySelector('[data-testid="like"]') || null;
                unlikeBtn = targetArticle?.querySelector('[data-testid="unlike"]') || null;

                if (likeBtn || unlikeBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            // Check if it's already liked
            if (unlikeBtn) {
                return { ok: true, message: 'Tweet is already liked.' };
            }

            if (!likeBtn) {
                return { ok: false, message: 'Could not find the Like button on this tweet after waiting 10 seconds. Are you logged in?' };
            }

            // Click Like
            writeStarted = true;
            likeBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify success by checking if the 'unlike' button reappeared
            const verifyArticle = findTargetArticle() || targetArticle;
            const verifyBtn = verifyArticle?.querySelector('[data-testid="unlike"]');
            if (verifyBtn) {
                return { ok: true, message: 'Tweet successfully liked.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Like action was initiated but UI did not update as expected.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter like confirmation", 1, `${result.message} Check the tweet before retrying; the like may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/likes.js
  var LIKES_QUERY_ID = "CDWHmpZeSdIJ3HGeRbNm0w";
  var USER_BY_SCREEN_NAME_QUERY_ID4 = "IGgvgiOx4QZndDHuD3x9TQ";
  var FEATURES5 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  function buildLikesUrl(queryId, userId, count, cursor) {
    const vars = {
      userId,
      count,
      includePromotedContent: false,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      withVoice: true
    };
    if (cursor)
      vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/Likes?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES5))}`;
  }
  function extractLikedTweet(result, seen) {
    if (!result)
      return null;
    const tw = result.tweet || result;
    const legacy = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id))
      return null;
    seen.add(tw.rest_id);
    const user = tw.core?.user_results?.result;
    const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "";
    const displayName = user?.legacy?.name || user?.core?.name || "";
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    return {
      id: tw.rest_id,
      author: screenName,
      name: displayName,
      text: noteText || legacy.full_text || "",
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      created_at: legacy.created_at || "",
      url: `https://x.com/${screenName}/status/${tw.rest_id}`,
      ...extractMedia(legacy)
    };
  }
  function parseLikes(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || data?.data?.user?.result?.timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const content = entry.content;
        if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
          if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
            nextCursor = content.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = content?.value || content?.itemContent?.value || nextCursor;
          continue;
        }
        const direct = extractLikedTweet(content?.itemContent?.tweet_results?.result, seen);
        if (direct) {
          tweets.push(direct);
          continue;
        }
        for (const item of content?.items || []) {
          const nested = extractLikedTweet(item.item?.itemContent?.tweet_results?.result, seen);
          if (nested)
            tweets.push(nested);
        }
      }
    }
    return { tweets, nextCursor };
  }
  function readResumeFile2(filePath, expected = null) {
    if (!filePath || !node_fs_default.existsSync(filePath))
      return null;
    let parsed;
    try {
      parsed = JSON.parse(node_fs_default.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new CommandExecutionError(`Could not parse Twitter likes resume file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const count = parsed?.count;
    const cursor = parsed?.cursor == null ? null : String(parsed.cursor);
    const outputFile = parsed?.outputFile ? node_path_default.resolve(String(parsed.outputFile)) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Number.isInteger(count) || count < 0 || parsed.cursor != null && typeof parsed.cursor !== "string" || cursor !== null && !cursor.trim()) {
      throw new CommandExecutionError(`Twitter likes resume file ${filePath} has an invalid shape`);
    }
    if (expected) {
      if (parsed.source !== expected.source)
        throw new ArgumentError(`Resume file source mismatch: expected ${expected.source}, found ${parsed.source || "unknown"}`);
      if (String(parsed.username || "").toLowerCase() !== String(expected.username).toLowerCase())
        throw new ArgumentError(`Resume file username mismatch: expected @${expected.username}, found @${parsed.username || "unknown"}`);
      if (outputFile !== expected.outputFile)
        throw new ArgumentError(`Resume file output mismatch: expected ${expected.outputFile || "in-memory mode"}, found ${outputFile || "in-memory mode"}`);
      if (!expected.outputFile && !Array.isArray(parsed.tweets))
        throw new CommandExecutionError(`Twitter likes resume file ${filePath} is missing in-memory tweets`);
      if (!expected.outputFile && parsed.tweets.length !== count)
        throw new CommandExecutionError(`Twitter likes resume file ${filePath} count does not match its in-memory tweets`);
      if (parsed.complete)
        throw new CommandExecutionError(`Twitter likes resume file ${filePath} is already marked complete`);
    }
    return {
      cursor,
      count,
      tweets: Array.isArray(parsed.tweets) ? parsed.tweets : [],
      username: parsed.username || null,
      complete: Boolean(parsed.complete),
      source: parsed.source || null,
      outputFile,
      updatedAt: parsed.updatedAt || null
    };
  }
  function writeResumeFile2(filePath, payload) {
    if (!filePath)
      return;
    ensureParentDir(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    try {
      node_fs_default.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2) + "\n");
      node_fs_default.renameSync(temporaryPath, filePath);
    } catch (error) {
      try {
        node_fs_default.rmSync(temporaryPath, { force: true });
      } catch {
      }
      throw new CommandExecutionError(`Could not persist Twitter likes resume state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cli({
    site: "twitter",
    name: "likes",
    access: "read",
    description: "Fetch liked tweets of a Twitter user (defaults to the logged-in user when no username is given)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, help: "Twitter screen name (with or without @). Defaults to the logged-in user when omitted." },
      { name: "limit", type: "int", default: 20, help: "Maximum number of liked tweets to return (default 20). Ignored when --all is set." },
      { name: "all", type: "bool", default: false, help: "Fetch all liked-tweet pages until exhausted (in-memory; no file resume)." },
      { name: "max-pages", type: "int", help: `Optional pagination safety cap (default ${DEFAULT_MAX_PAGINATION_PAGES}; raised automatically with --all).` },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the liked tweets by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps the API's native (recency) ordering." }
    ],
    columns: ["id", "author", "name", "text", "likes", "retweets", "created_at", "url", "has_media", "media_urls", "media_posters"],
    func: async (page, kwargs) => {
      const fetchAll = Boolean(kwargs.all);
      const limit = fetchAll ? Number.POSITIVE_INFINITY : kwargs.limit || 20;
      const resumeFile = resolveOptionalFilePath(kwargs["resume-file"], "--resume-file");
      const outputFile = resolveOptionalFilePath(kwargs["output-file"], "--output-file");
      const useOutputFile = Boolean(fetchAll && outputFile);
      const maxPages = resolveMaxPages(kwargs, fetchAll);
      const topByEngagement = Number(kwargs["top-by-engagement"] || 0);
      if (useOutputFile && topByEngagement > 0) {
        throw new ArgumentError("--top-by-engagement cannot be combined with --output-file");
      }
      if (outputFile && !fetchAll) {
        throw new ArgumentError("--output-file requires --all");
      }
      if (resumeFile && !fetchAll) {
        throw new ArgumentError("--resume-file requires --all");
      }
      if (outputFile && !resumeFile) {
        throw new ArgumentError("--output-file requires --resume-file so partial archives remain resumable");
      }
      const rawUsername = String(kwargs.username ?? "").trim();
      let username = normalizeTwitterScreenName(rawUsername);
      if (rawUsername && !username) {
        throw new ArgumentError("twitter likes username must be a valid Twitter/X handle", "Example: opencli twitter likes @jack --limit 20");
      }
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      if (!username) {
        await page.goto("https://x.com/home");
        await page.wait({ selector: '[data-testid="primaryColumn"]' });
        const href = unwrapBrowserResult(await page.evaluate(`() => {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href') : null;
      }`));
        if (!href || typeof href !== "string")
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
        username = normalizeTwitterScreenName(href);
        if (!username)
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
      const likesQueryId = await resolveTwitterQueryId(page, "Likes", LIKES_QUERY_ID);
      const userByScreenNameQueryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID4);
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const userId = unwrapBrowserResult(await page.evaluate(`async () => {
      const screenName = ${JSON.stringify(username)};
      const url = ${JSON.stringify(buildUserByScreenNameQueryUrl(userByScreenNameQueryId, username))};
      const resp = await fetch(url, { headers: ${headers}, credentials: 'include' });
      if (!resp.ok) return null;
      const d = await resp.json();
      return d.data?.user?.result?.rest_id || null;
    }`));
      if (!userId) {
        throw new CommandExecutionError(`Could not find user @${username}`);
      }
      const resumed = fetchAll ? readResumeFile2(resumeFile, {
        source: "likes",
        username,
        outputFile: useOutputFile ? outputFile : null
      }) : null;
      if (useOutputFile && resumed && resumed.count > 0 && !node_fs_default.existsSync(outputFile)) {
        throw new CommandExecutionError(`Twitter likes output file is missing for resume state: ${outputFile}`);
      }
      if (useOutputFile && !resumed && node_fs_default.existsSync(outputFile)) {
        throw new ArgumentError(`Refusing to overwrite existing Twitter likes output file: ${outputFile}`);
      }
      const allTweets = useOutputFile ? [] : resumed?.tweets ? [...resumed.tweets] : [];
      const jsonlState = useOutputFile ? loadJsonlArchiveState(outputFile) : null;
      const seen = useOutputFile ? jsonlState.seen : new Set(allTweets.map((tweet) => tweet?.id).filter(Boolean));
      if (useOutputFile && resumed && jsonlState.count !== resumed.count) {
        throw new CommandExecutionError(`Twitter likes output file has ${jsonlState.count} record(s), expected resume count ${resumed.count}`);
      }
      let outputCount = useOutputFile ? jsonlState.count : 0;
      let cursor = resumed?.cursor || null;
      let lastRawResponse = null;
      let pages = 0;
      let exhausted = false;
      while (pages < maxPages && (fetchAll || allTweets.length < limit)) {
        pages += 1;
        const currentCount = useOutputFile ? outputCount : allTweets.length;
        const remaining = fetchAll ? 100 : limit - currentCount + 10;
        const fetchCount = Math.min(100, remaining);
        const apiUrl = buildLikesUrl(likesQueryId, userId, fetchCount, cursor);
        const data = unwrapBrowserResult(await page.evaluate(`async () => {
        const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
        return r.ok ? await r.json() : { error: r.status };
      }`));
        if (data?.error) {
          if ((useOutputFile ? outputCount : allTweets.length) === 0)
            throw new CommandExecutionError(describeTwitterApiError("Likes", data.error));
          break;
        }
        lastRawResponse = data;
        const hasInstructions = Array.isArray(data?.data?.user?.result?.timeline_v2?.timeline?.instructions) || Array.isArray(data?.data?.user?.result?.timeline?.timeline?.instructions);
        if (!hasInstructions) {
          if (looksLikePrivateTwitterTimeline(data) && (useOutputFile ? outputCount : allTweets.length) === 0) {
            throw new EmptyResultError("twitter likes", `No likes returned for @${username} (Likes are private by default on X; only the account owner can view their own likes)`);
          }
          throw new CommandExecutionError("twitter_likes_protocol_error: missing Likes timeline instructions");
        }
        const { tweets, nextCursor } = parseLikes(data, seen);
        if (useOutputFile) {
          appendJsonlRows(outputFile, tweets);
          outputCount += tweets.length;
        } else {
          allTweets.push(...tweets);
        }
        const pageComplete = !nextCursor;
        writeResumeFile2(resumeFile, {
          cursor: pageComplete ? null : nextCursor,
          count: useOutputFile ? outputCount : allTweets.length,
          tweets: useOutputFile ? void 0 : allTweets,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          complete: pageComplete,
          source: "likes",
          username,
          outputFile: useOutputFile ? outputFile : null
        });
        if (pageComplete) {
          exhausted = true;
          break;
        }
        if (nextCursor === cursor) {
          throw new CommandExecutionError("twitter_likes_repeated_cursor: archive completion cannot be proven; resume state was retained");
        }
        cursor = nextCursor;
      }
      const finalCount = useOutputFile ? outputCount : allTweets.length;
      if (finalCount === 0) {
        if (looksLikePrivateTwitterTimeline(lastRawResponse)) {
          throw new EmptyResultError("twitter likes", `No likes returned for @${username} (Likes are private by default on X; only the account owner can view their own likes)`);
        }
        throw new EmptyResultError("twitter likes", `No likes found for @${username}`);
      }
      if (exhausted)
        removeResumeFile(resumeFile);
      if (useOutputFile) {
        return {
          outputFile,
          count: outputCount,
          source: "likes",
          username,
          complete: exhausted,
          pages,
          ...exhausted ? {} : { cursor, resumeFile: resumeFile || null }
        };
      }
      if (fetchAll && !exhausted) {
        throw new CommandExecutionError(
          `twitter_likes_archive_incomplete: stopped after ${pages} page(s); completion cannot be proven`,
          resumeFile ? `Resume with --resume-file ${resumeFile}` : "Rerun with --resume-file to preserve continuation state."
        );
      }
      const trimmed = fetchAll ? allTweets : allTweets.slice(0, limit);
      return applyTopByEngagement(trimmed, topByEngagement);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/lists.js
  var LISTS_QUERY_ID = "78UbkyXwXBD98IgUWXOy9g";
  var OPERATION_NAME3 = "ListsManagementPageTimeline";
  var FEATURES6 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  function buildUrl2(queryId) {
    return `/i/api/graphql/${queryId}/${OPERATION_NAME3}?features=${encodeURIComponent(JSON.stringify(FEATURES6))}`;
  }
  function extractListEntry(entry, seen) {
    const list = entry?.content?.itemContent?.list || entry?.content?.list || entry?.item?.itemContent?.list;
    if (!list) return null;
    const id = list.id_str || list.id || "";
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const mode = typeof list.mode === "string" && /private/i.test(list.mode) ? "private" : "public";
    return {
      id: String(id),
      name: list.name || "",
      members: String(list.member_count ?? 0),
      followers: String(list.subscriber_count ?? 0),
      mode
    };
  }
  var OWNED_SUBSCRIBED_ENTRY_PREFIX = "owned-subscribed-list-module-";
  function isOwnedSubscribedEntry(entry) {
    return typeof entry?.entryId === "string" && entry.entryId.startsWith(OWNED_SUBSCRIBED_ENTRY_PREFIX);
  }
  function getListsManagementInstructions(data) {
    const instructions = data?.data?.viewer?.list_management_timeline?.timeline?.instructions || data?.data?.viewer_v2?.user_results?.result?.list_management_timeline?.timeline?.instructions || data?.data?.list_management_timeline?.timeline?.instructions || data?.data?.data?.viewer?.list_management_timeline?.timeline?.instructions || data?.data?.data?.viewer_v2?.user_results?.result?.list_management_timeline?.timeline?.instructions || data?.data?.data?.list_management_timeline?.timeline?.instructions;
    return Array.isArray(instructions) ? instructions : null;
  }
  function parseListsManagement(data, seen) {
    const lists = [];
    const instructions = getListsManagementInstructions(data) || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        if (!isOwnedSubscribedEntry(entry)) continue;
        const direct = extractListEntry(entry, seen);
        if (direct) {
          lists.push(direct);
          continue;
        }
        for (const item of entry?.content?.items || []) {
          const nested = extractListEntry(item, seen);
          if (nested) lists.push(nested);
        }
      }
    }
    return lists;
  }
  var command = cli({
    site: "twitter",
    name: "lists",
    access: "read",
    description: "Get Twitter/X lists for the logged-in user (owned + subscribed)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 50, help: "Maximum number of lists to return (default 50)." }
    ],
    columns: ["id", "name", "members", "followers", "mode"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit || 50;
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const unwrap = (v) => v && typeof v === "object" && "session" in v && "data" in v ? v.data : v;
      const queryIdRaw = await page.evaluate(`async () => {
            try {
                const ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json');
                if (ghResp.ok) {
                    const data = await ghResp.json();
                    const entry = data['${OPERATION_NAME3}'];
                    if (entry && entry.queryId) return entry.queryId;
                }
            } catch {}
            try {
                const scripts = performance.getEntriesByType('resource')
                    .filter(r => r.name.includes('client-web') && r.name.endsWith('.js'))
                    .map(r => r.name);
                for (const scriptUrl of scripts.slice(0, 15)) {
                    try {
                        const text = await (await fetch(scriptUrl)).text();
                        const re = /queryId:"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:"${OPERATION_NAME3}"/;
                        const m = text.match(re);
                        if (m) return m[1];
                    } catch {}
                }
            } catch {}
            return null;
        }`);
      const queryId = unwrap(queryIdRaw) || LISTS_QUERY_ID;
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const apiUrl = buildUrl2(queryId);
      const data = await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
            return r.ok ? await r.json() : { error: r.status };
        }`);
      if (data?.error) {
        throw new CommandExecutionError(describeTwitterApiError("ListsManagementPageTimeline", data.error));
      }
      const seen = /* @__PURE__ */ new Set();
      if (!getListsManagementInstructions(data)) {
        throw new CommandExecutionError("Twitter lists returned an unexpected payload shape");
      }
      const lists = parseListsManagement(data, seen);
      if (lists.length === 0) {
        throw new EmptyResultError("twitter lists", "No owned or subscribed lists found");
      }
      return lists.slice(0, limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/list-add-core.js
  var USER_BY_SCREEN_NAME_QUERY_ID5 = "IGgvgiOx4QZndDHuD3x9TQ";
  var LISTS_MANAGEMENT_QUERY_ID = "78UbkyXwXBD98IgUWXOy9g";
  var LIST_ADD_MEMBER_QUERY_ID = "vWPi0CTMoPFsjsL6W4IynQ";
  var LISTS_MANAGEMENT_FEATURES = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  function fatalGraphqlErrors(errors) {
    const list = Array.isArray(errors) ? errors : [];
    return list.filter(
      (e) => !(e?.path || []).join(".").includes("default_banner_media_results") && !/decode/i.test(e?.message || "")
    );
  }
  function buildListAddMemberRow({ addResult, memberCountBefore, listId, username, userId }) {
    if (!addResult?.httpOk) {
      throw new CommandExecutionError(
        `Failed to add @${username} to list ${listId}: HTTP ${addResult?.status ?? 0}${addResult?.fetchError ? " (" + addResult.fetchError + ")" : ""}${addResult?.raw ? " \u2014 " + addResult.raw : ""}`
      );
    }
    const hasMemberCount = addResult.mc !== null && addResult.mc !== void 0;
    const fatalErrors = fatalGraphqlErrors(addResult.errors);
    if (!hasMemberCount && fatalErrors.length) {
      const msg = fatalErrors.map((e) => e.message || JSON.stringify(e)).join("; ");
      throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: ${msg.slice(0, 300)}`);
    }
    if (!hasMemberCount) {
      throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: no member_count in response`);
    }
    const memberCountAfter = Number(addResult.mc);
    if (!Number.isFinite(memberCountAfter)) {
      throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: invalid member_count in response`);
    }
    if (memberCountAfter < memberCountBefore) {
      throw new CommandExecutionError(
        `Failed to add @${username} to list ${listId}: member_count decreased unexpectedly (${memberCountBefore} \u2192 ${memberCountAfter})`
      );
    }
    const countIncreased = memberCountAfter > memberCountBefore;
    const noop = !countIncreased;
    if (noop && addResult.isMember !== true) {
      throw new CommandExecutionError(
        `Failed to add @${username} to list ${listId}: member_count unchanged and membership was not confirmed`
      );
    }
    const verifiedBy = `member_count ${memberCountBefore} \u2192 ${memberCountAfter}`;
    return {
      listId,
      username,
      userId: String(userId),
      status: noop ? "noop" : "success",
      message: noop ? `@${username} is already a member of list ${listId}` : `Added @${username} to list ${listId} (verified via ${verifiedBy})`
    };
  }
  async function listAddUser(page, kwargs) {
    const listId = String(kwargs.listId || "").trim();
    const username = String(kwargs.username || "").replace(/^@/, "").trim();
    if (!listId || !/^\d+$/.test(listId)) {
      throw new ArgumentError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected numeric ID.`, "Example: opencli twitter list-add 123456789 alice");
    }
    if (!username) {
      throw new ArgumentError("twitter list-add username is required", "Example: opencli twitter list-add 123456789 alice");
    }
    await page.goto("https://x.com");
    await page.wait(3);
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const userByScreenNameQueryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID5);
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const userLookupUrl = buildUserByScreenNameQueryUrl(userByScreenNameQueryId, username);
    const userIdRaw = await page.evaluate(`async () => {
            const resp = await fetch(${JSON.stringify(userLookupUrl)}, { headers: ${headers}, credentials: 'include' });
            if (!resp.ok) return null;
            const d = await resp.json();
            return d.data?.user?.result?.rest_id || null;
        }`);
    const userId = unwrapBrowserResult(userIdRaw);
    if (!userId) {
      throw new CommandExecutionError(`Could not resolve user @${username}`);
    }
    const listsQueryId = await resolveTwitterQueryId(page, "ListsManagementPageTimeline", LISTS_MANAGEMENT_QUERY_ID);
    const listsUrl = `/i/api/graphql/${listsQueryId}/ListsManagementPageTimeline?features=${encodeURIComponent(JSON.stringify(LISTS_MANAGEMENT_FEATURES))}`;
    const listsDataRaw = await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(listsUrl)}, { headers: ${headers}, credentials: 'include' });
            if (!r.ok) return { __error: 'HTTP ' + r.status };
            return await r.json();
        }`);
    const listsData = listsDataRaw;
    const parsedLists = listsData && !listsData.__error ? parseListsManagement(listsData, /* @__PURE__ */ new Set()) : [];
    if (listsData && listsData.__error) {
      throw new CommandExecutionError(`Could not fetch lists: ${listsData.__error}`);
    }
    const targetList = parsedLists.find((l) => l.id === listId);
    if (!targetList) {
      throw new CommandExecutionError(`List ${listId} not found among your lists (${parsedLists.length} lists fetched).`);
    }
    const memberCountBefore = Number(targetList.members) || 0;
    const listAddMemberQueryId = await resolveTwitterQueryId(page, "ListAddMember", LIST_ADD_MEMBER_QUERY_ID);
    const addUrl = `/i/api/graphql/${listAddMemberQueryId}/ListAddMember`;
    const addBody = JSON.stringify({
      variables: { listId, userId: String(userId) },
      queryId: listAddMemberQueryId
    });
    const addResultJsonRaw = await page.evaluate(`async () => {
            try {
                const r = await fetch(${JSON.stringify(addUrl)}, {
                    method: 'POST',
                    headers: Object.assign({}, ${headers}, { 'Content-Type': 'application/json' }),
                    credentials: 'include',
                    body: ${JSON.stringify(addBody)},
                });
                const text = await r.text();
                let body;
                let raw = null;
                try { body = JSON.parse(text); } catch { body = null; raw = text.slice(0, 300); }
                const list = body && body.data && body.data.list ? body.data.list : null;
                return JSON.stringify([
                    r.ok,
                    r.status,
                    list ? list.member_count : null,
                    list ? list.is_member : null,
                    body && body.errors ? body.errors : null,
                    raw,
                    null,
                ]);
            } catch (e) {
                return JSON.stringify([false, 0, null, null, null, null, String(e)]);
            }
        }`);
    const addResultJson = unwrapBrowserResult(addResultJsonRaw);
    let addResultTuple;
    try {
      addResultTuple = JSON.parse(addResultJson);
    } catch {
      throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: malformed mutation response envelope`);
    }
    const addResult = /* @__PURE__ */ Object.create(null);
    addResult.httpOk = Boolean(addResultTuple?.[0]);
    addResult.status = Number(addResultTuple?.[1]) || 0;
    addResult.mc = addResultTuple?.[2];
    addResult.isMember = addResultTuple?.[3];
    addResult.errors = addResultTuple?.[4];
    addResult.raw = addResultTuple?.[5];
    addResult.fetchError = addResultTuple?.[6];
    return [buildListAddMemberRow({ addResult, memberCountBefore, listId, username, userId })];
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/list-add.js
  cli({
    site: "twitter",
    name: "list-add",
    access: "write",
    description: "Add a user to a Twitter/X list you own (no-op if already a member)",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of the list you own (e.g. from `opencli twitter lists`)" },
      { name: "username", positional: true, type: "string", required: true, help: "Twitter/X handle to add (with or without @)" }
    ],
    columns: ["listId", "username", "userId", "status", "message"],
    func: listAddUser
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/list-batch-utils.js
  var USERNAME_RE2 = /^[A-Za-z0-9_]{1,15}$/;
  var DEFAULT_INTERVAL_SECONDS = 5;
  var MAX_INTERVAL_SECONDS = 600;
  function parseCommaSeparatedUsernames(rawValue, example) {
    const raw = String(rawValue || "").trim();
    if (!raw) {
      throw new ArgumentError("At least one username is required", example);
    }
    const values = raw.split(",").map((part) => part.trim().replace(/^@/, "")).filter(Boolean);
    if (values.length === 0) {
      throw new ArgumentError("At least one username is required", example);
    }
    const seen = /* @__PURE__ */ new Set();
    const usernames = [];
    for (const username of values) {
      if (!USERNAME_RE2.test(username)) {
        throw new ArgumentError(`Invalid Twitter/X username: ${JSON.stringify(username)}`, example);
      }
      const key = username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      usernames.push(username);
    }
    return usernames;
  }
  function parseBatchIntervalSeconds(rawValue) {
    const value = rawValue === void 0 || rawValue === null || rawValue === "" ? DEFAULT_INTERVAL_SECONDS : Number(rawValue);
    if (!Number.isInteger(value) || value < 0 || value > MAX_INTERVAL_SECONDS) {
      throw new ArgumentError(`Invalid interval: ${JSON.stringify(rawValue)}. Expected an integer from 0 to ${MAX_INTERVAL_SECONDS}.`);
    }
    return value;
  }
  function toBatchFailureRow({ listId, username, error }) {
    return {
      listId,
      username,
      userId: "",
      status: "failed",
      message: error?.message || String(error)
    };
  }
  function isGlobalBatchFailure(error) {
    if (error instanceof ArgumentError || error instanceof AuthRequiredError) {
      return true;
    }
    const message = error?.message || String(error);
    return /Invalid listId|Could not fetch lists|List \d+ not found among your lists|Not logged into x\.com/i.test(message);
  }
  async function waitBetweenBatchItems(page, seconds) {
    if (seconds <= 0) return;
    if (page && typeof page.wait === "function") {
      await page.wait(seconds);
      return;
    }
    await new Promise((resolve2) => setTimeout(resolve2, seconds * 1e3));
  }
  async function runListBatch({ page, listId, usernames, interval, operation }) {
    const rows = [];
    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      try {
        const result = await operation(page, { listId, username });
        rows.push(...result);
      } catch (error) {
        if (isGlobalBatchFailure(error)) {
          throw error;
        }
        rows.push(toBatchFailureRow({ listId, username, error }));
      }
      if (i < usernames.length - 1) {
        await waitBetweenBatchItems(page, interval);
      }
    }
    return rows;
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/list-add-batch.js
  var EXAMPLE = 'Example: opencli twitter list-add-batch 123456789 "@alice,@bob" --interval 5';
  cli({
    site: "twitter",
    name: "list-add-batch",
    access: "write",
    description: "Add multiple users to a Twitter/X list you own from a comma-separated username list",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of the list you own (e.g. from `opencli twitter lists`)" },
      { name: "usernames", positional: true, type: "string", required: true, help: "Comma-separated Twitter/X handles to add (with or without @)" },
      { name: "interval", type: "int", default: 5, help: "Seconds to wait between account additions (default: 5)" },
      { name: "timeout", type: "int", default: 600, help: "Max seconds for the overall batch command (default: 600)" }
    ],
    columns: ["listId", "username", "userId", "status", "message"],
    func: async (page, kwargs) => {
      const listId = String(kwargs.listId || "").trim();
      const usernames = parseCommaSeparatedUsernames(kwargs.usernames, EXAMPLE);
      const interval = parseBatchIntervalSeconds(kwargs.interval);
      return runListBatch({ page, listId, usernames, interval, operation: listAddUser });
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/list-create.js
  var CREATE_LIST_QUERY_ID = "UQRa0jJ9doxGEIQRea1Y0w";
  var NAME_MAX = 25;
  var DESCRIPTION_MAX = 100;
  var FEATURES7 = {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };
  function parseListCreateArgs(kwargs) {
    const name = String(kwargs.name || "").trim();
    const description = String(kwargs.description || "").trim();
    const modeRaw = String(kwargs.mode || "public").trim().toLowerCase();
    if (!name) {
      throw new ArgumentError("List name is required", 'Example: opencli twitter list-create "My List"');
    }
    if (name.length > NAME_MAX) {
      throw new ArgumentError(`List name too long: ${name.length} chars (max ${NAME_MAX})`);
    }
    if (description.length > DESCRIPTION_MAX) {
      throw new ArgumentError(`Description too long: ${description.length} chars (max ${DESCRIPTION_MAX})`);
    }
    if (modeRaw !== "public" && modeRaw !== "private") {
      throw new ArgumentError(`Invalid mode: ${JSON.stringify(kwargs.mode)}. Expected "public" or "private".`);
    }
    return { listName: name, listDescription: description, listMode: modeRaw, privateFlag: modeRaw === "private" };
  }
  function requireCreateListResult(result, expectedName, expectedMode) {
    if (!result || typeof result !== "object") {
      throw new CommandExecutionError(`Unexpected result from twitter list-create: ${JSON.stringify(result)}`);
    }
    if (result.httpStatus === 401 || result.httpStatus === 403) {
      throw new AuthRequiredError("x.com", `Twitter CreateList returned HTTP ${result.httpStatus}`);
    }
    if (!result.ok) {
      const snippet = String(result.bodyText || "").slice(0, 300);
      throw new CommandExecutionError(`HTTP ${result.httpStatus} from CreateList: ${snippet}`);
    }
    if (!result.bodyJson || typeof result.bodyJson !== "object") {
      throw new CommandExecutionError(`CreateList returned malformed JSON payload. Body: ${String(result.bodyText || "").slice(0, 300)}`);
    }
    const list = result.bodyJson?.data?.list;
    if (!list || typeof list !== "object") {
      const errors = result.bodyJson?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        throw new CommandExecutionError(`CreateList failed: ${errors[0].message || JSON.stringify(errors[0])}`);
      }
      throw new CommandExecutionError(`CreateList returned no list payload. Body: ${String(result.bodyText || "").slice(0, 300)}`);
    }
    const id = String(list.id_str || list.id || "");
    if (!/^\d+$/.test(id)) {
      throw new CommandExecutionError("CreateList returned a list payload without a numeric list id.");
    }
    if (typeof list.name !== "string" || !list.name.trim()) {
      throw new CommandExecutionError("CreateList returned a list payload without a list name.");
    }
    if (list.name.trim() !== expectedName) {
      throw new CommandExecutionError(`CreateList returned name ${JSON.stringify(list.name)}, expected ${JSON.stringify(expectedName)}.`);
    }
    const modeValue = typeof list.mode === "string" ? list.mode : "";
    if (!modeValue) {
      throw new CommandExecutionError("CreateList returned a list payload without list mode.");
    }
    const mode = /private/i.test(modeValue) ? "private" : "public";
    if (mode !== expectedMode) {
      throw new CommandExecutionError(`CreateList returned mode ${mode}, expected ${expectedMode}.`);
    }
    return { createdList: list, listId: id, listMode: mode };
  }
  function buildListCreateRow({ result, name, description, mode }) {
    const { createdList, listId, listMode } = requireCreateListResult(result, name, mode);
    return {
      id: listId,
      name: createdList.name,
      description: typeof createdList.description === "string" ? createdList.description : description,
      mode: listMode,
      status: "success"
    };
  }
  cli({
    site: "twitter",
    name: "list-create",
    description: "Create a new Twitter/X list (returns the new list id)",
    access: "write",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "name", positional: true, type: "string", required: true, help: `List name (max ${NAME_MAX} chars)` },
      { name: "description", type: "string", default: "", help: `Optional list description (max ${DESCRIPTION_MAX} chars)` },
      { name: "mode", type: "string", default: "public", help: "public | private" }
    ],
    columns: ["id", "name", "description", "mode", "status"],
    func: async (page, kwargs) => {
      const { listName: name, listDescription: description, listMode: mode, privateFlag: isPrivate } = parseListCreateArgs(kwargs);
      await page.goto("https://x.com");
      await page.wait(3);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const queryId = CREATE_LIST_QUERY_ID;
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "Content-Type": "application/json"
      });
      const body = JSON.stringify({
        variables: { isPrivate, name, description },
        features: FEATURES7,
        queryId
      });
      const apiUrl = `/i/api/graphql/${queryId}/CreateList`;
      const result = unwrapBrowserResult(await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(apiUrl)}, {
                method: 'POST',
                headers: ${headers},
                credentials: 'include',
                body: ${JSON.stringify(body)},
            });
            const bodyText = await r.text();
            let bodyJson = null;
            try { bodyJson = JSON.parse(bodyText); } catch {}
            return { ok: r.ok, httpStatus: r.status, bodyJson, bodyText };
        }`));
      return [buildListCreateRow({ result, name, description, mode })];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/list-delete.js
  var LISTS_MANAGEMENT_QUERY_ID2 = "78UbkyXwXBD98IgUWXOy9g";
  var LISTS_MANAGEMENT_FEATURES2 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  function normalizeConfirm(value) {
    return value === true || value === "true";
  }
  async function getManagedLists(page, headers) {
    const listsQueryId = await resolveTwitterQueryId(page, "ListsManagementPageTimeline", LISTS_MANAGEMENT_QUERY_ID2);
    const listsUrl = `/i/api/graphql/${listsQueryId}/ListsManagementPageTimeline?features=${encodeURIComponent(JSON.stringify(LISTS_MANAGEMENT_FEATURES2))}`;
    const listsData = unwrapBrowserResult(await page.evaluate(`async () => {
        const r = await fetch(${JSON.stringify(listsUrl)}, { headers: ${headers}, credentials: 'include' });
        if (!r.ok) return { __error: 'HTTP ' + r.status };
        return await r.json();
    }`));
    if (listsData && listsData.__error) {
      throw new CommandExecutionError(`Could not fetch lists: ${listsData.__error}`);
    }
    return parseListsManagement(listsData, /* @__PURE__ */ new Set());
  }
  function buildListDeleteRow({ listId, targetList }) {
    return {
      listId,
      name: targetList.name,
      members: String(targetList.members ?? "0"),
      status: "success",
      message: `Deleted list ${targetList.name} (${targetList.members ?? "0"} members)`
    };
  }
  cli({
    site: "twitter",
    name: "list-delete",
    access: "write",
    description: "Delete a Twitter/X list you own after explicit confirmation",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of the list you own (e.g. from `opencli twitter lists`)" },
      { name: "confirm", type: "boolean", default: false, help: "Required. Set --confirm true to delete the list." },
      { name: "timeout", type: "int", default: 300, help: "Max seconds for the overall delete command (default: 300)" }
    ],
    columns: ["listId", "name", "members", "status", "message"],
    func: async (page, kwargs) => {
      const listId = String(kwargs.listId || "").trim();
      if (!listId || !/^\d+$/.test(listId)) {
        throw new ArgumentError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected numeric ID.`, "Example: opencli twitter list-delete 123456789 --confirm true");
      }
      if (!normalizeConfirm(kwargs.confirm)) {
        throw new ArgumentError("Refusing to delete list without --confirm true", "Example: opencli twitter list-delete 123456789 --confirm true");
      }
      await page.goto("https://x.com");
      await page.wait(3);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const listsBefore = await getManagedLists(page, headers);
      const targetList = listsBefore.find((list) => list.id === listId);
      if (!targetList) {
        throw new CommandExecutionError(`List ${listId} not found among your lists (${listsBefore.length} lists fetched).`);
      }
      await page.goto(`https://x.com/i/lists/${listId}`);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const deleteResult = unwrapBrowserResult(await page.evaluate(`(async () => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const visible = (el) => !!el && el.offsetParent !== null;
            const buttonText = (el) => (el.innerText || el.textContent || '').trim();
            const waitFor = async (fn, { timeoutMs = 10000, intervalMs = 200 } = {}) => {
                const started = Date.now();
                while (Date.now() - started < timeoutMs) {
                    const value = fn();
                    if (value) return value;
                    await sleep(intervalMs);
                }
                return null;
            };
            const findButton = (text) => Array.from(document.querySelectorAll('button, [role="button"]'))
                .find((el) => visible(el) && buttonText(el).toLowerCase() === text.toLowerCase());
            const editLink = Array.from(document.querySelectorAll('a[href$="/info"]'))
                .find((el) => visible(el) && /edit list/i.test(el.innerText || el.textContent || ''));
            if (!editLink) return { ok: false, message: 'Edit List link not found' };
            editLink.click();
            const editDialog = await waitFor(() => document.querySelector('[role="dialog"]'));
            if (!editDialog) return { ok: false, message: 'Edit List dialog did not open' };
            const deleteButton = findButton('Delete List');
            if (!deleteButton) return { ok: false, message: 'Delete List button not found' };
            deleteButton.click();
            await sleep(800);
            const confirmButton = document.querySelector('[data-testid="confirmationSheetConfirm"]')
                || findButton('Delete');
            if (!confirmButton) return { ok: false, message: 'Delete confirmation button not found' };
            confirmButton.click();
            await sleep(2500);
            return { ok: true, url: location.href };
        })()`));
      if (!deleteResult?.ok) {
        throw new CommandExecutionError(`Failed to delete list ${listId}: ${deleteResult?.message || "unknown UI failure"}`);
      }
      const listsAfter = await getManagedLists(page, headers);
      if (listsAfter.some((list) => list.id === listId)) {
        throw new CommandExecutionError(`Failed to delete list ${listId}: list still appears in managed lists.`);
      }
      return [buildListDeleteRow({ listId, targetList })];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/list-remove-core.js
  var USER_BY_SCREEN_NAME_QUERY_ID6 = "IGgvgiOx4QZndDHuD3x9TQ";
  var LISTS_MANAGEMENT_QUERY_ID3 = "78UbkyXwXBD98IgUWXOy9g";
  var LISTS_MANAGEMENT_FEATURES3 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  async function listRemoveUser(page, kwargs) {
    const listId = String(kwargs.listId || "").trim();
    const username = String(kwargs.username || "").replace(/^@/, "").trim();
    if (!listId || !/^\d+$/.test(listId)) {
      throw new ArgumentError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected numeric ID.`);
    }
    if (!username) throw new ArgumentError("twitter list-remove username is required");
    await page.goto("https://x.com");
    await page.wait(3);
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const userByScreenNameQueryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID6);
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const userLookupUrl = buildUserByScreenNameQueryUrl(userByScreenNameQueryId, username);
    const userId = unwrapBrowserResult(await page.evaluate(`async () => {
            const resp = await fetch(${JSON.stringify(userLookupUrl)}, { headers: ${headers}, credentials: 'include' });
            if (!resp.ok) return null;
            const d = await resp.json();
            return d.data?.user?.result?.rest_id || null;
        }`));
    if (!userId) throw new CommandExecutionError(`Could not resolve user @${username}`);
    const listsQueryId = await resolveTwitterQueryId(page, "ListsManagementPageTimeline", LISTS_MANAGEMENT_QUERY_ID3);
    const listsUrl = `/i/api/graphql/${listsQueryId}/ListsManagementPageTimeline?features=${encodeURIComponent(JSON.stringify(LISTS_MANAGEMENT_FEATURES3))}`;
    const listsData = unwrapBrowserResult(await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(listsUrl)}, { headers: ${headers}, credentials: 'include' });
            if (!r.ok) return { __error: 'HTTP ' + r.status };
            return await r.json();
        }`));
    if (listsData && listsData.__error) {
      throw new CommandExecutionError(`Could not fetch lists: ${listsData.__error}`);
    }
    const parsedLists = parseListsManagement(listsData, /* @__PURE__ */ new Set());
    const targetList = parsedLists.find((l) => l.id === listId);
    if (!targetList) {
      throw new CommandExecutionError(`List ${listId} not found among your lists.`);
    }
    const targetName = targetList.name;
    await page.goto(`https://x.com/${username}`);
    await page.wait({ selector: '[data-testid="primaryColumn"]' });
    const uiResult = unwrapBrowserResult(await page.evaluate(`(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const findOne = (sel, root = document) => root.querySelector(sel);
            const waitFor = async (fn, { timeoutMs = 8000, intervalMs = 200 } = {}) => {
                const t0 = Date.now();
                while (Date.now() - t0 < timeoutMs) { const v = fn(); if (v) return v; await sleep(intervalMs); }
                return null;
            };
            try {
                if (!window.__opencliListMutations) {
                    window.__opencliListMutations = [];
                    const origFetch = window.fetch.bind(window);
                    window.fetch = async function(...args) {
                        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
                        const method = (args[1] && args[1].method) || 'GET';
                        let resp;
                        try { resp = await origFetch(...args); } catch (err) {
                            if (/ListAddMember|ListRemoveMember|lists\\/members\\/(create|destroy)/.test(url)) {
                                window.__opencliListMutations.push({ url, method, status: 0, error: String(err), ts: Date.now() });
                            }
                            throw err;
                        }
                        if (/ListAddMember|ListRemoveMember|lists\\/members\\/(create|destroy)/.test(url)) {
                            window.__opencliListMutations.push({ url, method, status: resp.status, ts: Date.now() });
                        }
                        return resp;
                    };
                }
                window.__opencliListMutations.length = 0;

                const caret = await waitFor(() => findOne('[data-testid="userActions"]'));
                if (!caret) return { ok: false, message: 'Could not find user actions (\u2026) button' };
                caret.click();
                await sleep(600);
                const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
                const addToListItem = menuItems.find(el => /add\\/remove|\u4ECE\u5217\u8868|\u5217\u8868|add to list|add or remove/i.test(el.innerText));
                if (!addToListItem) return { ok: false, message: 'Could not find "Add/remove from Lists" menu item' };
                addToListItem.click();
                await sleep(1200);
                const dialog = await waitFor(() => findOne('[role="dialog"]'));
                if (!dialog) return { ok: false, message: 'List selection dialog did not open' };

                const targetName = ${JSON.stringify(targetName)};
                const scrollCandidates = [
                    dialog.querySelector('[data-viewportview="true"]'),
                    ...Array.from(dialog.querySelectorAll('div')).filter(d => d.scrollHeight > d.clientHeight + 10),
                ].filter(Boolean);
                let scrollEl = scrollCandidates[0] || dialog;
                for (const se of scrollCandidates) {
                    if (se.scrollHeight > se.clientHeight + 10) { scrollEl = se; break; }
                }
                let row = null;
                let lastScrollTop = -1;
                for (let i = 0; i < 12; i++) {
                    const cells = Array.from(dialog.querySelectorAll('[data-testid="cellInnerDiv"]'));
                    row = cells.find(c => (c.innerText || '').split('\\n')[0].trim() === targetName);
                    if (row) break;
                    const prev = scrollEl.scrollTop;
                    scrollEl.scrollTop = prev + Math.max(200, scrollEl.clientHeight - 100);
                    if (scrollEl.scrollTop === prev && scrollEl.scrollTop === lastScrollTop) break;
                    lastScrollTop = scrollEl.scrollTop;
                    await sleep(500);
                }
                if (!row) {
                    const names = Array.from(dialog.querySelectorAll('[data-testid="cellInnerDiv"]'))
                        .map(c => (c.innerText || '').split('\\n')[0].trim()).filter(Boolean);
                    return { ok: false, message: 'List "' + targetName + '" not found in dialog. Saw: ' + names.join(' | ') };
                }

                // Determine current membership: row has a filled checkmark (svg inside a specific container) when member.
                // Heuristic: look for an aria-checked attribute, or an svg with specific fill on the row's right side.
                // The listCell itself carries aria-checked. Require a stable reading
                // (same value twice ~500ms apart) to avoid the X dialog's occasional
                // flash of stale state when re-opened shortly after a toggle.
                const listCell = row.querySelector('[data-testid="listCell"]') || row.querySelector('[role="checkbox"]') || row;
                const readChecked = () => {
                    const v = listCell.getAttribute('aria-checked');
                    return v === 'true' || v === 'false' ? v : null;
                };
                await sleep(600);
                let ariaChecked = readChecked();
                for (let i = 0; i < 8; i++) {
                    await sleep(500);
                    const next = readChecked();
                    if (next && next === ariaChecked) break;
                    ariaChecked = next || ariaChecked;
                }
                const isMember = ariaChecked === 'true';
                if (!isMember) {
                    const closeBtn = findOne('[data-testid="app-bar-close"]') || findOne('[aria-label="Close"]');
                    if (closeBtn) closeBtn.click();
                    return { ok: true, noop: true };
                }
                try { listCell.scrollIntoView({ block: 'center' }); } catch {}
                await sleep(400);
                const rowRect = listCell.getBoundingClientRect();
                const saveButton = Array.from(dialog.querySelectorAll('[role="button"], button')).find(b => {
                    const txt = (b.innerText || '').trim();
                    return /^(Save|Done|\u4FDD\u5B58|\u5B8C\u6210|\u5132\u5B58)$/i.test(txt);
                });
                const saveRect = saveButton ? saveButton.getBoundingClientRect() : null;
                return {
                    ok: true,
                    needsNativeInteraction: true,
                    rowClickX: Math.round(rowRect.left + rowRect.width / 2),
                    rowClickY: Math.round(rowRect.top + rowRect.height / 2),
                    saveClickX: saveRect ? Math.round(saveRect.left + saveRect.width / 2) : null,
                    saveClickY: saveRect ? Math.round(saveRect.top + saveRect.height / 2) : null,
                    mutationsBefore: window.__opencliListMutations.length,
                };
            } catch (e) {
                return { ok: false, message: 'UI error: ' + (e?.message || String(e)) };
            }
        })()`));
    if (!uiResult.ok) {
      throw new CommandExecutionError(`Failed to remove @${username} from list ${listId}: ${uiResult.message}`);
    }
    let verifiedBy = null;
    if (uiResult.needsNativeInteraction) {
      if (typeof page.nativeClick !== "function") {
        throw new CommandExecutionError("Requires up-to-date Chrome extension (nativeClick).");
      }
      if (!uiResult.saveClickX) {
        throw new CommandExecutionError("Save button not found in dialog.");
      }
      const memberCountBefore = Number(targetList.members) || 0;
      await page.nativeClick(uiResult.rowClickX, uiResult.rowClickY);
      await new Promise((r) => setTimeout(r, 800));
      await page.nativeClick(uiResult.saveClickX, uiResult.saveClickY);
      await new Promise((r) => setTimeout(r, 3500));
      const listsAfter = unwrapBrowserResult(await page.evaluate(`async () => {
                const r = await fetch(${JSON.stringify(listsUrl)}, { headers: ${headers}, credentials: 'include' });
                if (!r.ok) return { __error: 'HTTP ' + r.status };
                return await r.json();
            }`));
      if (listsAfter && listsAfter.__error) {
        throw new CommandExecutionError(`Could not verify list removal: ${listsAfter.__error}`);
      }
      if (!getListsManagementInstructions(listsAfter)) {
        throw new CommandExecutionError("Could not verify list removal: unexpected lists payload shape");
      }
      const parsedAfter = parseListsManagement(listsAfter, /* @__PURE__ */ new Set());
      const afterList = parsedAfter.find((l) => l.id === listId);
      if (!afterList) {
        throw new CommandExecutionError(`Could not verify list removal: list ${listId} missing from post-delete payload`);
      }
      const memberCountAfter = Number(afterList.members) || 0;
      if (memberCountAfter < memberCountBefore) {
        verifiedBy = `member_count ${memberCountBefore} \u2192 ${memberCountAfter}`;
      } else {
        throw new CommandExecutionError(`Failed to remove @${username} from list ${listId}: member_count unchanged (${memberCountBefore} \u2192 ${memberCountAfter}).`);
      }
    }
    return [{
      listId,
      username,
      userId: String(userId),
      status: uiResult.noop ? "noop" : "success",
      message: uiResult.noop ? `@${username} was not a member of list ${listId}` : `Removed @${username} from list ${listId} (verified via ${verifiedBy})`
    }];
  }

  // webcli/scripts/opencli-wave5/upstream/twitter/list-remove.js
  cli({
    site: "twitter",
    name: "list-remove",
    access: "write",
    description: "Remove a user from a Twitter/X list you own (toggles via UI; no-op if not currently a member)",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of the list you own (e.g. from `opencli twitter lists`)" },
      { name: "username", positional: true, type: "string", required: true, help: "Twitter/X handle to remove (with or without @)" }
    ],
    columns: ["listId", "username", "userId", "status", "message"],
    func: listRemoveUser
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/list-remove-batch.js
  var EXAMPLE2 = 'Example: opencli twitter list-remove-batch 123456789 "@alice,@bob" --interval 5';
  cli({
    site: "twitter",
    name: "list-remove-batch",
    access: "write",
    description: "Remove multiple users from a Twitter/X list you own from a comma-separated username list",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of the list you own (e.g. from `opencli twitter lists`)" },
      { name: "usernames", positional: true, type: "string", required: true, help: "Comma-separated Twitter/X handles to remove (with or without @)" },
      { name: "interval", type: "int", default: 5, help: "Seconds to wait between account removals (default: 5)" },
      { name: "timeout", type: "int", default: 600, help: "Max seconds for the overall batch command (default: 600)" }
    ],
    columns: ["listId", "username", "userId", "status", "message"],
    func: async (page, kwargs) => {
      const listId = String(kwargs.listId || "").trim();
      const usernames = parseCommaSeparatedUsernames(kwargs.usernames, EXAMPLE2);
      const interval = parseBatchIntervalSeconds(kwargs.interval);
      return runListBatch({ page, listId, usernames, interval, operation: listRemoveUser });
    }
  });

  // webcli/scripts/opencli-wave5/utils.js
  function throwIfLoginWall(value, opts = {}) {
    const isWall = value && typeof value === "object" && value.__loginWall === true && typeof value.status === "number";
    if (isWall) {
      throw new LoginWallError(
        `Server returned HTML instead of JSON (status=${value.status}). Likely a login wall, rate limit, or WAF challenge.`,
        value.status,
        opts.url || value.url || "",
        value.bodyPreview
      );
    }
    return value;
  }
  var BROWSER_JSON_SNIFF_FN = `
async function fetchJsonOrLoginWall(input, init) {
  const r = await fetch(input, init);
  const contentType = r.headers.get('content-type') || '';
  const text = await r.text();
  const trimmed = text.replace(/^\\s+/, '');
  const looksLikeHtml =
    contentType.toLowerCase().includes('text/html')
    || /^<(?:!doctype|html|head|body|title)(?:[\\s>/]|$)/i.test(trimmed);
  if (looksLikeHtml) {
    return {
      __loginWall: true,
      status: r.status,
      url: r.url || (typeof input === 'string' ? input : ''),
      contentType,
      bodyPreview: trimmed.slice(0, 100),
    };
  }
  if (!r.ok) {
    return { error: r.status };
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      'JSON parse failed (status=' + r.status + ', body[0..50]=' + JSON.stringify(trimmed.slice(0, 50)) + '): '
      + (err && err.message ? err.message : String(err))
    );
  }
}
`;

  // webcli/scripts/opencli-wave5/upstream/twitter/list-tweets.js
  var LIST_TWEETS_QUERY_ID = "RlZzktZY_9wJynoepm8ZsA";
  var OPERATION_NAME4 = "ListLatestTweetsTimeline";
  var MAX_PAGINATION_PAGES5 = 100;
  var FEATURES8 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  function buildUrl3(queryId, listId, count, cursor) {
    const vars = { listId: String(listId), count };
    if (cursor)
      vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/${OPERATION_NAME4}?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES8))}`;
  }
  function extractTimelineTweet(result, seen) {
    if (!result)
      return null;
    const tw = result.tweet || result;
    const legacy = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id))
      return null;
    seen.add(tw.rest_id);
    const user = tw.core?.user_results?.result;
    const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "";
    const displayName = user?.legacy?.name || user?.core?.name || "";
    const bio = user?.legacy?.description || "";
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    return {
      id: tw.rest_id,
      author: screenName,
      name: displayName,
      bio,
      text: noteText || legacy.full_text || "",
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      created_at: legacy.created_at || "",
      url: `https://x.com/${screenName}/status/${tw.rest_id}`,
      ...extractMedia(legacy),
      card: extractCard(tw),
      quoted_tweet: extractQuotedTweet(tw)
    };
  }
  function parseListTimeline(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.list?.tweets_timeline?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const content = entry.content;
        if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
          if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
            nextCursor = content.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = content?.value || content?.itemContent?.value || nextCursor;
          continue;
        }
        const direct = extractTimelineTweet(content?.itemContent?.tweet_results?.result, seen);
        if (direct) {
          tweets.push(direct);
          continue;
        }
        for (const item of content?.items || []) {
          const nested = extractTimelineTweet(item.item?.itemContent?.tweet_results?.result, seen);
          if (nested)
            tweets.push(nested);
        }
      }
    }
    return { tweets, nextCursor };
  }
  cli({
    site: "twitter",
    name: "list-tweets",
    access: "read",
    description: "Fetch tweets from a Twitter/X list timeline",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of a Twitter/X list (e.g. from `opencli twitter lists`)" },
      { name: "limit", type: "int", default: 50 },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the list timeline by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps the list's native (recency) ordering." }
    ],
    columns: ["id", "author", "bio", "text", "likes", "retweets", "replies", "created_at", "url", "has_media", "media_urls", "media_posters", "card", "quoted_tweet"],
    func: async (page, kwargs) => {
      const listId = String(kwargs.listId || "").trim();
      if (!listId || !/^\d+$/.test(listId)) {
        throw new CommandExecutionError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected a numeric ID (see \`opencli twitter lists\`).`);
      }
      const limit = kwargs.limit || 50;
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const unwrap = (v) => v && typeof v === "object" && "session" in v && "data" in v ? v.data : v;
      const queryIdRaw = await page.evaluate(`async () => {
            try {
                const ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json');
                if (ghResp.ok) {
                    const data = await ghResp.json();
                    const entry = data['${OPERATION_NAME4}'];
                    if (entry && entry.queryId) return entry.queryId;
                }
            } catch {}
            try {
                const scripts = performance.getEntriesByType('resource')
                    .filter(r => r.name.includes('client-web') && r.name.endsWith('.js'))
                    .map(r => r.name);
                for (const scriptUrl of scripts.slice(0, 15)) {
                    try {
                        const text = await (await fetch(scriptUrl)).text();
                        const re = /queryId:"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:"${OPERATION_NAME4}"/;
                        const m = text.match(re);
                        if (m) return m[1];
                    } catch {}
                }
            } catch {}
            return null;
        }`);
      const queryId = unwrap(queryIdRaw) || LIST_TWEETS_QUERY_ID;
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const allTweets = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      for (let i = 0; i < MAX_PAGINATION_PAGES5 && allTweets.length < limit; i++) {
        const fetchCount = Math.min(100, limit - allTweets.length + 10);
        const apiUrl = buildUrl3(queryId, listId, fetchCount, cursor);
        const data = throwIfLoginWall(await page.evaluate(`async () => {
                ${BROWSER_JSON_SNIFF_FN}
                return await fetchJsonOrLoginWall(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
            }`), { url: apiUrl });
        if (data?.error) {
          if (allTweets.length === 0)
            throw new CommandExecutionError(describeTwitterApiError("ListLatestTweetsTimeline", data.error, "list may be private"));
          break;
        }
        const { tweets, nextCursor } = parseListTimeline(data, seen);
        allTweets.push(...tweets);
        if (!nextCursor || nextCursor === cursor || tweets.length === 0)
          break;
        cursor = nextCursor;
      }
      const trimmed = allTweets.slice(0, limit);
      return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/mute-word.js
  function parseKeyword(value) {
    const keyword = String(value ?? "").trim();
    if (!keyword) {
      throw new ArgumentError("twitter mute-word keyword cannot be empty");
    }
    return keyword;
  }
  cli({
    site: "twitter",
    name: "mute-word",
    access: "write",
    description: "Add a muted word or phrase on Twitter/X",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "keyword", type: "string", positional: true, required: true, help: "Word or phrase to mute" }
    ],
    columns: ["keyword", "status", "message"],
    func: async (page, kwargs) => {
      if (!page) {
        throw new CommandExecutionError("Browser session required for twitter mute-word");
      }
      const keyword = parseKeyword(kwargs.keyword);
      await page.goto("https://x.com/settings/add_muted_keyword");
      await page.wait({ selector: '[data-testid="primaryColumn"]' }).catch(() => {
      });
      const result = await page.evaluate(`(async () => {
            const keyword = ${JSON.stringify(keyword)};
            let writeStarted = false;
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const visible = (node) => {
                if (!node) return false;
                const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
                return !style || (style.visibility !== 'hidden' && style.display !== 'none');
            };
            const textOf = (node) => String(node?.innerText || node?.textContent || '').trim();
            const lowerTextOf = (node) => textOf(node).toLowerCase();
            const exactTextOf = (node) => lowerTextOf(node).replace(/\\s+/g, ' ');
            const setNativeValue = (node, value) => {
                if ('value' in node) {
                    const prototype = Object.getPrototypeOf(node);
                    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                    if (setter) setter.call(node, value);
                    else node.value = value;
                } else {
                    node.textContent = value;
                }
                let inputEvent;
                try {
                    inputEvent = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value });
                } catch {
                    inputEvent = new Event('input', { bubbles: true });
                }
                node.dispatchEvent(inputEvent);
                node.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const settingsSurface = () => document.querySelector('[data-testid="primaryColumn"]')
                || document.querySelector('main');
            const scopeFor = (node) => node?.closest('form, [data-testid="primaryColumn"], main') || settingsSurface();
            const keywordRows = () => {
                const surface = settingsSurface();
                if (!surface) return [];
                return Array.from(surface.querySelectorAll('[data-testid*="muted"], [data-testid*="keyword"], [role="listitem"], li'))
                    .filter((node) => visible(node) && !node.querySelector('input, textarea, [role="textbox"]'));
            };
            const rowSnapshot = () => keywordRows().map(textOf).filter(Boolean);
            const exactKeywordRows = () => keywordRows().filter((node) => textOf(node) === keyword);
            const hasNewExactKeywordRow = (beforeRows) => {
                const beforeExactCount = beforeRows.filter((text) => text === keyword).length;
                return exactKeywordRows().length > beforeExactCount;
            };
            const matchingToastTexts = () => Array.from(document.querySelectorAll('[role="status"], [data-testid="toast"], [data-testid*="toast"], [aria-live]'))
                .filter((node) => {
                    if (!visible(node)) return false;
                    const text = lowerTextOf(node);
                    return (text.includes('muted') || text.includes('added') || text.includes('saved') || text.includes('\u5DF2') || text.includes('\u4FDD\u5B58') || text.includes('\u6DFB\u52A0'))
                        && text.includes(keyword.toLowerCase());
                })
                .map(exactTextOf);
            const hasNewSuccessToast = (beforeToasts) => {
                const beforeCounts = new Map();
                for (const text of beforeToasts) {
                    beforeCounts.set(text, (beforeCounts.get(text) || 0) + 1);
                }
                for (const text of matchingToastTexts()) {
                    const count = beforeCounts.get(text) || 0;
                    if (count > 0) {
                        beforeCounts.set(text, count - 1);
                    } else {
                        return true;
                    }
                }
                return false;
            };
            const findKeywordField = () => {
                const surface = settingsSurface();
                if (!surface) return null;
                const exact = Array.from(surface.querySelectorAll('input[name="keyword"], textarea[name="keyword"]'))
                    .filter(visible);
                if (exact.length > 0) return exact[0];
                const candidates = Array.from(surface.querySelectorAll('input[aria-label], textarea[aria-label], [role="textbox"]'))
                    .filter(visible);
                const semantic = candidates.find((node) => {
                    if (!visible(node)) return false;
                    const aria = String(node.getAttribute('aria-label') || '').trim().toLowerCase();
                    const placeholder = String(node.getAttribute('placeholder') || '').trim().toLowerCase();
                    return ['word or phrase', 'word', 'phrase', '\u5173\u952E\u8BCD', '\u5C4F\u853D\u8BCD'].includes(aria)
                        || ['word or phrase', 'word', 'phrase', '\u5173\u952E\u8BCD', '\u5C4F\u853D\u8BCD'].includes(placeholder);
                });
                return semantic || null;
            };
            const findSaveButton = (field) => {
                const labels = new Set(['save', 'add', 'done', '\u4FDD\u5B58', '\u6DFB\u52A0', '\u5B8C\u6210']);
                const scope = scopeFor(field);
                if (!scope) return null;
                return Array.from(scope.querySelectorAll('button, [role="button"]')).find((node) => {
                    if (!visible(node)) return false;
                    if (node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
                    const text = exactTextOf(node);
                    const aria = String(node.getAttribute('aria-label') || '').trim().toLowerCase();
                    return labels.has(text) || labels.has(aria);
                }) || null;
            };

            try {
                const field = findKeywordField();
                if (!field) {
                    return { ok: false, message: 'Could not find muted word input. Are you logged in?' };
                }
                field.focus?.();
                setNativeValue(field, keyword);
                await sleep(100);

                const beforePath = location.pathname;
                const beforeRows = rowSnapshot();
                const beforeToasts = matchingToastTexts();
                const saveButton = findSaveButton(field);
                if (!saveButton) {
                    return { ok: false, message: 'Could not find muted word Save button.' };
                }
                writeStarted = true;
                saveButton.click();

                for (let attempt = 0; attempt < 20; attempt += 1) {
                    await sleep(250);
                    if (beforePath !== '/settings/muted_keywords' && location.pathname === '/settings/muted_keywords') {
                        return { ok: true, message: 'Muted word added.' };
                    }
                    if (hasNewSuccessToast(beforeToasts)) {
                        return { ok: true, message: 'Muted word added.' };
                    }
                    if (hasNewExactKeywordRow(beforeRows)) {
                        return { ok: true, message: 'Muted word added.' };
                    }
                }
                return { ok: false, unconfirmed: true, message: 'Muted word submission did not show confirmation.' };
            } catch (error) {
                return { ok: false, unconfirmed: writeStarted, message: String(error?.message || error) };
            }
        })()`);
      if (result?.unconfirmed) {
        throw new TimeoutError(
          "twitter mute-word confirmation",
          5,
          `${result.message} Check muted words before retrying; the word may already have been added.`
        );
      }
      if (!result?.ok) {
        throw new CommandExecutionError(
          result?.message || "Could not add muted word.",
          "Nothing changed. Open Twitter/X muted word settings in the browser and retry."
        );
      }
      return [{
        keyword,
        status: "success",
        message: result.message || "Muted word added."
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/notifications.js
  cli({
    site: "twitter",
    name: "notifications",
    access: "read",
    description: "Get your Twitter/X notifications (the logged-in user's likes/replies/follows feed, newest first)",
    domain: "x.com",
    strategy: Strategy.INTERCEPT,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "Maximum number of notifications to return (default 20)." }
    ],
    columns: ["id", "action", "author", "text", "url"],
    func: async (page, kwargs) => {
      await page.goto("https://x.com/home");
      await page.wait(3);
      await page.installInterceptor("NotificationsTimeline");
      await page.evaluate(`() => {
        window.history.pushState({}, '', '/notifications');
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    }`);
      await page.waitForCapture(5);
      const currentUrl = await page.evaluate("() => window.location.pathname");
      if (currentUrl !== "/notifications") {
        throw new CommandExecutionError("SPA navigation to notifications failed. Twitter may have changed its routing.");
      }
      await page.autoScroll({ times: 2, delayMs: 2e3 });
      const requests = await page.getInterceptedRequests();
      if (!requests || requests.length === 0)
        return [];
      let results = [];
      const seen = /* @__PURE__ */ new Set();
      for (const req of requests) {
        if (Array.isArray(req.data?.errors) && req.data.errors.length) throw new CommandExecutionError('Twitter notifications returned GraphQL errors');
        const data = req.data?.data || req.data;
        try {
          let processNotificationItem = function(itemContent, entryId) {
            if (!itemContent)
              return;
            let item = itemContent?.notification_results?.result || itemContent?.tweet_results?.result || itemContent;
            let actionText = "Notification";
            let author = "";
            let text = "";
            let urlStr = "";
            if (item.__typename === "TimelineNotification") {
              text = item.rich_message?.text || item.message?.text || "";
              const fromUser = item.template?.from_users?.[0]?.user_results?.result;
              author = fromUser?.core?.screen_name || fromUser?.legacy?.screen_name || "";
              urlStr = item.notification_url?.url || "";
              actionText = item.notification_icon || "Activity";
              const targetTweet = item.template?.target_objects?.[0]?.tweet_results?.result;
              if (targetTweet) {
                const targetText = targetTweet.note_tweet?.note_tweet_results?.result?.text || targetTweet.legacy?.full_text || "";
                text += text && targetText ? " | " + targetText : targetText;
                if (!urlStr) {
                  urlStr = `https://x.com/i/status/${targetTweet.rest_id}`;
                }
              }
            } else if (item.__typename === "TweetNotification") {
              const tweet = item.tweet_result?.result;
              const tweetUser = tweet?.core?.user_results?.result;
              author = tweetUser?.core?.screen_name || tweetUser?.legacy?.screen_name || "";
              text = tweet?.note_tweet?.note_tweet_results?.result?.text || tweet?.legacy?.full_text || item.message?.text || "";
              actionText = "Mention/Reply";
              urlStr = `https://x.com/i/status/${tweet?.rest_id}`;
            } else if (item.__typename === "Tweet") {
              const tweetUser = item.core?.user_results?.result;
              author = tweetUser?.core?.screen_name || tweetUser?.legacy?.screen_name || "";
              text = item.note_tweet?.note_tweet_results?.result?.text || item.legacy?.full_text || "";
              actionText = "Mention";
              urlStr = `https://x.com/i/status/${item.rest_id}`;
            }
            const id = item.id || item.rest_id || entryId;
            if (seen.has(id))
              return;
            seen.add(id);
            results.push({
              id,
              action: actionText,
              author,
              text,
              url: urlStr || `https://x.com/notifications`
            });
          };
          let instructions = [];
          if (data?.viewer?.timeline_response?.timeline?.instructions) {
            instructions = data.viewer.timeline_response.timeline.instructions;
          } else if (data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline?.instructions) {
            instructions = data.viewer_v2.user_results.result.notification_timeline.timeline.instructions;
          } else if (data?.timeline?.instructions) {
            instructions = data.timeline.instructions;
          }
          let addEntries = instructions.find((i) => i.type === "TimelineAddEntries");
          if (!addEntries) {
            addEntries = instructions.find((i) => i.entries && Array.isArray(i.entries));
          }
          if (!addEntries)
            continue;
          for (const entry of addEntries.entries) {
            if (!entry.entryId.startsWith("notification-")) {
              if (entry.content?.items) {
                for (const subItem of entry.content.items) {
                  processNotificationItem(subItem.item?.itemContent, subItem.entryId);
                }
              }
              continue;
            }
            processNotificationItem(entry.content?.itemContent, entry.entryId);
          }
        } catch (e) {
        }
      }
      return results.slice(0, kwargs.limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/post.js
  var COMPOSER_POLL_MS = 250;
  var COMPOSER_TIMEOUT_MS = 1e4;
  var SUBMIT_POLL_MS = 500;
  var SUBMIT_TIMEOUT_MS = 15e3;
  var COMPOSE_URL = "https://x.com/compose/post";
  function isUnsupportedInsertTextError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    return lower.includes("unknown action") || lower.includes("not supported") || lower.includes("inserttext returned no inserted flag");
  }
  function requirePostActionResult(value, context) {
    const result = unwrapBrowserResult(value);
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") {
      throw new CommandExecutionError(`${context} returned a malformed result.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, "message") && result.message != null && typeof result.message !== "string") {
      throw new CommandExecutionError(`${context} returned a malformed message.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, "error") && result.error != null && typeof result.error !== "string") {
      throw new CommandExecutionError(`${context} returned a malformed error.`);
    }
    return result;
  }
  function validateSubmitStatusPair(result) {
    if (result.id && !result.url || !result.id && result.url) {
      throw new CommandExecutionError("Twitter post completion returned only one of id/url.");
    }
    if (!result.id && !result.url) return;
    if (typeof result.id !== "string" || !/^\d+$/.test(result.id)) {
      throw new CommandExecutionError("Twitter post completion returned a malformed status id.");
    }
    if (typeof result.url !== "string") {
      throw new CommandExecutionError("Twitter post completion returned a malformed status url.");
    }
    let url;
    try {
      url = new URL(result.url);
    } catch {
      throw new CommandExecutionError("Twitter post completion returned a malformed status url.");
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(hostname) || !match || match[2] !== result.id) {
      throw new CommandExecutionError("Twitter post completion returned a malformed status url.");
    }
  }
  async function focusComposer(page) {
    return requirePostActionResult(await page.evaluate(`(() => {
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
        const box = boxes.find(visible) || boxes[0];
        if (!box) return { ok: false, message: 'Could not find the tweet composer text area. Are you logged in?' };
        box.focus();
        return { ok: true };
    })()`), "Twitter composer focus");
  }
  async function verifyComposerText(page, text) {
    const iterations = Math.ceil(COMPOSER_TIMEOUT_MS / COMPOSER_POLL_MS);
    return requirePostActionResult(await page.evaluate(`(async () => {
        const expected = ${JSON.stringify(text)};
        const normalize = s => String(s || '').replace(/\xA0/g, ' ').replace(/s+/g, ' ').trim();
        const normalizedExpected = normalize(expected);
        for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
            const box = document.querySelector('[data-testid="tweetTextarea_0"]');
            const actual = box ? (box.innerText || box.textContent || '') : '';
            if (box && normalize(actual).includes(normalizedExpected)) return { ok: true };
            await new Promise(r => setTimeout(r, ${JSON.stringify(COMPOSER_POLL_MS)}));
        }
        const box = document.querySelector('[data-testid="tweetTextarea_0"]');
        return {
            ok: false,
            message: 'Could not verify tweet text in the composer after typing.',
            actualText: box ? (box.innerText || box.textContent || '') : ''
        };
    })()`), "Twitter composer text verification");
  }
  async function insertComposerText(page, text) {
    const focusResult = await focusComposer(page);
    if (!focusResult?.ok) return focusResult;
    const nativeInserters = [
      page.nativeType?.bind(page),
      page.insertText?.bind(page)
    ].filter(Boolean);
    for (const insert of nativeInserters) {
      try {
        await insert(text);
        const verified = await verifyComposerText(page, text);
        if (verified?.ok) return verified;
      } catch (err) {
        if (!isUnsupportedInsertTextError(err)) throw err;
      }
    }
    return requirePostActionResult(await page.evaluate(`(async () => {
        try {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
            const box = boxes.find(visible) || boxes[0];
            if (!box) return { ok: false, message: 'Could not find the tweet composer text area. Are you logged in?' };
            const textToInsert = ${JSON.stringify(text)};
            const normalize = s => String(s || '').replace(/\xA0/g, ' ').replace(/s+/g, ' ').trim();
            box.focus();
            if (!document.execCommand('insertText', false, textToInsert)) {
                const dt = new DataTransfer();
                dt.setData('text/plain', textToInsert);
                box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            }
            await new Promise(r => setTimeout(r, 500));
            const actual = box.innerText || box.textContent || '';
            if (normalize(actual).includes(normalize(textToInsert))) return { ok: true };
            return { ok: false, message: 'Could not verify tweet text in the composer after typing.', actualText: actual };
        } catch (e) { return { ok: false, message: String(e) }; }
    })()`), "Twitter composer DOM insertion");
  }
  async function submitTweet(page, text) {
    const clickResult = requirePostActionResult(await page.evaluate(`(async () => {
        try {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            for (const toast of Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))) {
                if (visible(toast)) toast.setAttribute('data-opencli-before-submit-toast', 'true');
            }
            const buttons = Array.from(document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]'));
            const btn = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
            if (!btn) return { ok: false, message: 'Tweet button is disabled or not found.' };
            btn.click();
            return { ok: true };
        } catch (e) { return { ok: false, message: String(e) }; }
    })()`), "Twitter post click");
    if (!clickResult?.ok) return clickResult;
    const iterations = Math.ceil(SUBMIT_TIMEOUT_MS / SUBMIT_POLL_MS);
    const result = requirePostActionResult(await page.evaluate(`(async () => {
        const expected = ${JSON.stringify(text)};
        const normalize = s => String(s || '').replace(/\xA0/g, ' ').replace(/s+/g, ' ').trim();
        const expectedText = normalize(expected);
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        const statusUrl = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return {};
            const links = Array.from(root.querySelectorAll('a[href*="/status/"]'));
            for (const link of links) {
                const href = link.href || link.getAttribute('href') || '';
                if (!href) continue;
                try {
                    const url = new URL(href, window.location.origin);
                    const hostname = url.hostname.toLowerCase().replace(/^www\\./, '');
                    if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)) continue;
                    const match = url.pathname.match(/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/);
                    if (match) return { url: url.href, id: match[2] };
                } catch {}
            }
            return {};
        };
        for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
            await new Promise(r => setTimeout(r, ${JSON.stringify(SUBMIT_POLL_MS)}));
            const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
                .filter((el) => visible(el) && !el.hasAttribute('data-opencli-before-submit-toast'));
            const successToast = toasts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
            if (successToast) return { ok: true, message: 'Tweet posted successfully.', ...statusUrl(successToast) };
            const alert = toasts.find((el) => /failed|error|try again|not sent|could not/i.test(el.textContent || ''));
            if (alert) return { ok: false, message: (alert.textContent || 'Tweet failed to post.').trim() };

            // Composer disappearance or text clearing alone is not a reliable
            // postcondition: X may close/rewrite the modal after failed submits.
            // Require a fresh success toast so the evidence is tied to this click.
        }
        return { ok: false, unconfirmed: true, message: 'Tweet submission did not complete before timeout.' };
    })()`), "Twitter post completion");
    validateSubmitStatusPair(result);
    return result;
  }
  cli({
    site: "twitter",
    name: "post",
    access: "write",
    description: "Post a new tweet (text only)",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "text", type: "string", required: true, positional: true, help: "The text content of the tweet" }
    ],
    columns: ["status", "message", "text", "id", "url"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter post");
      const text = String(kwargs.text ?? "");
      await page.goto(COMPOSE_URL, { waitUntil: "load", settleMs: 2500 });
      await page.wait({ selector: '[data-testid="tweetTextarea_0"]', timeout: 15 });
      const typeResult = await insertComposerText(page, text);
      if (!typeResult?.ok) {
        throw new CommandExecutionError(typeResult?.message ?? "Could not type tweet text.", "Open the composer in the browser and check whether X is asking you to log in.");
      }
      await page.wait(1);
      const result = await submitTweet(page, text);
      if (result?.unconfirmed) {
        throw new TimeoutError("twitter post", SUBMIT_TIMEOUT_MS / 1e3, `${result.message} Check \`opencli twitter tweets --limit 1\` before retrying; the post may already be live.`);
      }
      if (!result?.ok) {
        throw new CommandExecutionError(result?.message ?? "Tweet failed to post.", "Nothing was posted. Open the composer in the browser and retry.");
      }
      return [{
        status: "success",
        message: result.message,
        text,
        ...result.id ? { id: result.id } : {},
        ...result.url ? { url: result.url } : {}
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/profile.js
  var USER_BY_SCREEN_NAME_QUERY_ID7 = "IGgvgiOx4QZndDHuD3x9TQ";
  var USER_BY_SCREEN_NAME_FEATURES4 = {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
  };
  var USER_BY_SCREEN_NAME_OPERATION3 = {
    queryId: USER_BY_SCREEN_NAME_QUERY_ID7,
    features: USER_BY_SCREEN_NAME_FEATURES4
  };
  function isPlainObject2(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }
  function stringField(value) {
    return typeof value === "string" ? value : "";
  }
  function countField(...values) {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value))
        return value;
    }
    return 0;
  }
  function mapTwitterProfileResult(result, screenName) {
    if (!isPlainObject2(result)) {
      throw new CommandExecutionError(`Twitter profile response for @${screenName} is malformed`);
    }
    const hasLegacy = isPlainObject2(result.legacy);
    const hasCore = isPlainObject2(result.core);
    if (!hasLegacy && !hasCore) {
      throw new CommandExecutionError(`Twitter profile response for @${screenName} is missing profile fields`);
    }
    const legacy = hasLegacy ? result.legacy : {};
    const core = hasCore ? result.core : {};
    if (!stringField(core.screen_name) && !stringField(legacy.screen_name) && !stringField(core.name) && !stringField(legacy.name) && !stringField(core.created_at) && !stringField(legacy.created_at)) {
      throw new CommandExecutionError(`Twitter profile response for @${screenName} is missing profile identity fields`);
    }
    const location2 = isPlainObject2(result.location) ? result.location : {};
    const expandedUrl = stringField(result.website?.url) || stringField(legacy.entities?.url?.urls?.[0]?.expanded_url);
    return [{
      screen_name: stringField(core.screen_name) || stringField(legacy.screen_name) || screenName,
      name: stringField(core.name) || stringField(legacy.name),
      bio: stringField(result.profile_bio?.description) || stringField(legacy.description),
      location: stringField(location2.location) || stringField(legacy.location),
      url: stringField(expandedUrl),
      followers: countField(result.relationship_counts?.followers, legacy.followers_count, legacy.normal_followers_count),
      following: countField(result.relationship_counts?.following, legacy.friends_count),
      tweets: countField(result.tweet_counts?.tweets, legacy.statuses_count),
      likes: countField(result.action_counts?.favorites_count, legacy.favourites_count),
      verified: Boolean(result.is_blue_verified || result.verification?.verified || legacy.verified),
      created_at: stringField(core.created_at) || stringField(legacy.created_at)
    }];
  }
  async function parseTwitterProfileDom(page, screenName) {
    const primary = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    const pickText = (selector) => {
      const node = primary?.querySelector(selector);
      return node ? (node.textContent || "").trim() : "";
    };
    const nameBox = primary?.querySelector('[data-testid="UserName"]');
    const nameSpans = nameBox ? Array.from(nameBox.querySelectorAll("span")).map((node) => (node.textContent || "").trim()).filter(Boolean) : [];
    const profileLinks = Array.from(primary?.querySelectorAll("a[href]") || []).map((node) => {
      try {
        return { url: new URL(node.getAttribute("href"), location.origin), text: node.textContent || "" };
      } catch {
        return null;
      }
    }).filter(Boolean);
    const countFor = (suffix) => {
      const item = profileLinks.find((entry) => entry.url.pathname.toLowerCase().endsWith("/" + suffix));
      const match = String(item?.text || "").replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)([KkMm万亿]?)/);
      if (!match) return 0;
      const base = Number(match[1]);
      const unit = match[2];
      if (!Number.isFinite(base)) return 0;
      if (unit === "K" || unit === "k") return Math.round(base * 1000);
      if (unit === "M" || unit === "m") return Math.round(base * 1e6);
      if (unit === "万") return Math.round(base * 1e4);
      if (unit === "亿") return Math.round(base * 1e8);
      return Math.round(base);
    };
    const screen = nameSpans.find((text) => text.startsWith("@")) || "@" + screenName;
    const result = {
      screen_name: screen.replace(/^@/, ""),
      name: nameSpans.find((text) => !text.startsWith("@")) || "",
      bio: pickText('[data-testid="UserDescription"]'),
      location: pickText('[data-testid="UserLocation"]'),
      url: pickText('[data-testid="UserUrl"]'),
      followers: countFor("verified_followers") || countFor("followers"),
      following: countFor("following"),
      tweets: 0,
      likes: 0,
      verified: Boolean(primary?.querySelector('[aria-label*="Verified"], [data-testid="icon-verified"]')),
      created_at: pickText('[data-testid="UserJoinDate"]')
    };
    if (!result || typeof result !== "object" || !result.screen_name) {
      throw new CommandExecutionError(`Twitter profile response for @${screenName} is unavailable from API and page DOM`);
    }
    return [result];
  }
  cli({
    site: "twitter",
    name: "profile",
    access: "read",
    description: "Fetch a Twitter user profile \u2014 bio, stats, etc. (defaults to the logged-in user when no username is given)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, help: "Twitter screen name (with or without @). Defaults to the logged-in user when omitted." }
    ],
    columns: ["screen_name", "name", "bio", "location", "url", "followers", "following", "tweets", "likes", "verified", "created_at"],
    func: async (page, kwargs) => {
      const rawUsername = String(kwargs.username ?? "").trim();
      let username = normalizeTwitterScreenName(rawUsername);
      if (rawUsername && !username) {
        throw new ArgumentError("twitter profile username must be a valid Twitter/X handle", "Example: opencli twitter profile @jack");
      }
      if (!username) {
        await page.goto("https://x.com/home");
        await page.wait({ selector: '[data-testid="primaryColumn"]' });
        const href = unwrapBrowserResult(await page.evaluate(`() => {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href') : null;
      }`));
        if (!href || typeof href !== "string")
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
        username = normalizeTwitterScreenName(href);
        if (!username)
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
      await page.goto(`https://x.com/${username}`);
      await page.wait(3);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const resolvedOperation = await resolveTwitterOperationMetadata(page, "UserByScreenName", USER_BY_SCREEN_NAME_OPERATION3);
      const operation = { queryId: resolvedOperation.queryId, features: resolvedOperation.features };
      const rawResult = unwrapBrowserResult(await page.evaluate(`
      async () => {
        const screenName = ${JSON.stringify(username)};
        const ct0 = ${JSON.stringify(ct0)};
        const operation = ${JSON.stringify(operation)};

        const bearer = ${JSON.stringify(TWITTER_BEARER_TOKEN)};
        const headers = {
          'Authorization': 'Bearer ' + decodeURIComponent(bearer),
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes'
        };

        const variables = JSON.stringify({
          screen_name: screenName,
          withSafetyModeUserFields: true,
        });
        const features = JSON.stringify(operation.features || {});

        const url = '/i/api/graphql/' + operation.queryId + '/UserByScreenName?variables='
          + encodeURIComponent(variables)
          + '&features=' + encodeURIComponent(features);

        let resp;
        try {
          resp = await fetch(url, {headers, credentials: 'include'});
        } catch (error) {
          return {ok: false, error: 'Twitter profile request failed: ' + String(error && error.message || error)};
        }
        if (!resp.ok) {
          return {
            ok: false,
            auth: resp.status === 401 || resp.status === 403,
            httpStatus: resp.status,
            error: 'HTTP ' + resp.status,
            hint: 'User may not exist, auth may be required, or queryId expired'
          };
        }
        let d;
        try {
          d = await resp.json();
        } catch (error) {
          return {ok: false, error: 'Twitter profile response was not JSON: ' + String(error && error.message || error)};
        }

        const result = d.data?.user?.result;
        if (!result) return {ok: false, notFound: true, error: 'User @' + screenName + ' not found'};
        return {ok: true, result};
      }
    `));
      if (!isPlainObject2(rawResult)) {
        return parseTwitterProfileDom(page, username);
      }
      if (!rawResult.ok) {
        const message = typeof rawResult.httpStatus === "number" ? describeTwitterApiError("UserByScreenName", rawResult.httpStatus, rawResult.hint) : rawResult.error + (rawResult.hint ? ` (${rawResult.hint})` : "");
        if (rawResult.auth) {
          throw new AuthRequiredError("x.com", message);
        }
        if (rawResult.notFound) {
          throw new EmptyResultError("twitter profile", message);
        }
        return parseTwitterProfileDom(page, username);
      }
      return mapTwitterProfileResult(rawResult.result, username);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/quote.js
  var SUBMIT_POLL_MS2 = 500;
  var SUBMIT_TIMEOUT_MS2 = 15e3;
  async function submitQuote(page, text, tweetId) {
    const iterations = Math.ceil(SUBMIT_TIMEOUT_MS2 / SUBMIT_POLL_MS2);
    return page.evaluate(`(async () => {
        try {
            ${buildTwitterArticleScopeSource(tweetId)}
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
            const box = boxes.find(visible) || boxes[0];
            if (!box) {
                return { ok: false, message: 'Could not find the quote composer text area. Are you logged in?' };
            }

            box.focus();
            const textToInsert = ${JSON.stringify(text)};
            // execCommand('insertText') is more reliable with Twitter's Draft.js editor.
            if (!document.execCommand('insertText', false, textToInsert)) {
                // Fallback to paste event if execCommand fails.
                const dataTransfer = new DataTransfer();
                dataTransfer.setData('text/plain', textToInsert);
                box.dispatchEvent(new ClipboardEvent('paste', {
                    clipboardData: dataTransfer,
                    bubbles: true,
                    cancelable: true,
                }));
            }

            await new Promise(r => setTimeout(r, 1000));

            // Confirm the quoted card is rendered before submitting; otherwise
            // we may accidentally post a plain tweet without the quote
            // attachment. The compose page does not wrap the card in an
            // <article>, so we probe the document for any link whose path
            // exactly matches the requested status id (uses __twHasLinkToTarget
            // from buildTwitterArticleScopeSource).
            let cardAttempts = 0;
            let hasQuoteCard = false;
            while (cardAttempts < 20) {
                hasQuoteCard = __twHasLinkToTarget(document);
                if (hasQuoteCard) break;
                await new Promise(r => setTimeout(r, 250));
                cardAttempts++;
            }
            if (!hasQuoteCard) {
                return { ok: false, message: 'Quote target did not render in the composer. The source tweet may be deleted or restricted.' };
            }

            let btn = null;
            for (let i = 0; i < 30; i++) {
                const buttons = Array.from(
                    document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')
                );
                btn = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
                if (btn) break;
                await new Promise(r => setTimeout(r, 500));
            }
            if (!btn) {
                return { ok: false, message: 'Tweet button is disabled or not found.' };
            }

            btn.click();

            const normalize = s => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
            const expectedText = normalize(textToInsert);
            for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
                await new Promise(r => setTimeout(r, ${JSON.stringify(SUBMIT_POLL_MS2)}));
                const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
                    .filter((el) => visible(el));
                const successToast = toasts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
                if (successToast) return { ok: true, message: 'Quote tweet posted successfully.' };
                const alert = toasts.find((el) => /failed|error|try again|not sent|could not/i.test(el.textContent || ''));
                if (alert) return { ok: false, message: (alert.textContent || 'Quote tweet failed to post.').trim() };

                const visibleBoxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]')).filter(visible);
                const composerStillHasText = visibleBoxes.some((box) =>
                    normalize(box.innerText || box.textContent || '').includes(expectedText)
                );
                if (!composerStillHasText) return { ok: true, message: 'Quote tweet posted successfully.' };
            }
            return { ok: false, unconfirmed: true, message: 'Quote tweet submission did not complete before timeout.' };
        } catch (e) {
            return { ok: false, message: e.toString() };
        }
    })()`);
  }
  cli({
    site: "twitter",
    name: "quote",
    access: "write",
    description: "Quote-tweet a specific tweet with your own text (text only)",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to quote" },
      { name: "text", type: "string", required: true, positional: true, help: "The text content of your quote" }
    ],
    columns: ["status", "message", "text"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter quote");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(`https://x.com/compose/post?url=${encodeURIComponent(target.url)}`, { waitUntil: "load", settleMs: 2500 });
      await page.wait({ selector: '[data-testid="tweetTextarea_0"]', timeout: 15 });
      const result = await submitQuote(page, kwargs.text, target.id);
      if (result.ok) {
        await page.wait(3);
      }
      if (result.unconfirmed) {
        throw new TimeoutError("twitter quote", SUBMIT_TIMEOUT_MS2 / 1e3, `${result.message} Check your profile before retrying; the quote may already be live.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing was posted. Open the tweet in the browser and retry.");
      }
      return [{
        status: "success",
        message: result.message,
        text: kwargs.text
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/reply.js
  var COMPOSER_SELECTOR = '[data-testid="tweetTextarea_0"]';
  var SUBMIT_POLL_MS3 = 500;
  var SUBMIT_TIMEOUT_MS3 = 15e3;
  function buildReplyComposerUrl(rawUrl) {
    const target = parseTweetUrl(rawUrl);
    return `https://x.com/compose/post?in_reply_to=${target.id}`;
  }
  function isPromiseCollectedError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("Promise was collected");
  }
  function requireReplyActionResult(value, context) {
    const result = unwrapBrowserResult(value);
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") {
      throw new CommandExecutionError(`${context} returned a malformed result.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, "message") && result.message != null && typeof result.message !== "string") {
      throw new CommandExecutionError(`${context} returned a malformed message.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, "url") && result.url != null && typeof result.url !== "string") {
      throw new CommandExecutionError(`${context} returned a malformed status url.`);
    }
    return result;
  }
  function validateReplyStatusUrl(result) {
    if (!result.url) return;
    let url;
    try {
      url = new URL(result.url);
    } catch {
      throw new CommandExecutionError("Twitter reply completion returned a malformed status url.");
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/);
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(hostname) || !match) {
      throw new CommandExecutionError("Twitter reply completion returned a malformed status url.");
    }
  }
  async function openReplyComposer(page, rawUrl) {
    await page.goto(buildReplyComposerUrl(rawUrl), { waitUntil: "load", settleMs: 2500 });
    try {
      await page.wait({ selector: COMPOSER_SELECTOR, timeout: 15 });
      return { ok: true };
    } catch {
      await page.goto(rawUrl, { waitUntil: "load", settleMs: 2500 });
      const clicked = requireReplyActionResult(await page.evaluate(`(() => {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const buttons = Array.from(document.querySelectorAll('[data-testid="reply"]'));
            const btn = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
            if (!btn) return { ok: false, message: 'Could not find the reply button on the target tweet.' };
            btn.click();
            return { ok: true };
        })()`), "Twitter target reply click");
      if (!clicked?.ok) return clicked;
      await page.wait({ selector: COMPOSER_SELECTOR, timeout: 15 });
      return { ok: true };
    }
  }
  async function insertReplyText(page, text) {
    return requireReplyActionResult(await page.evaluate(`(async () => {
      try {
          const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
          const boxes = Array.from(document.querySelectorAll('[data-testid="tweetTextarea_0"]'));
          const box = boxes.find(visible) || boxes[0];
          if (!box) {
              return { ok: false, message: 'Could not find the reply text area. Are you logged in?' };
          }

          box.focus();
          const textToInsert = ${JSON.stringify(text)};
          // execCommand('insertText') is more reliable with Twitter's Draft.js editor
          if (!document.execCommand('insertText', false, textToInsert)) {
              // Fallback to paste event if execCommand fails
              const dataTransfer = new DataTransfer();
              dataTransfer.setData('text/plain', textToInsert);
              box.dispatchEvent(new ClipboardEvent('paste', {
                  clipboardData: dataTransfer,
                  bubbles: true,
                  cancelable: true
              }));
          }

          await new Promise(r => setTimeout(r, 1000));
          const normalize = s => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
          const actual = box.innerText || box.textContent || '';
          if (!normalize(actual).includes(normalize(textToInsert))) {
              return { ok: false, message: 'Could not verify reply text in the composer after typing.', actualText: actual };
          }
          return { ok: true };
      } catch (e) {
          return { ok: false, message: e.toString() };
      }
  })()`), "Twitter reply text insertion");
  }
  async function clickReplyButton(page) {
    const iterations = Math.ceil(SUBMIT_TIMEOUT_MS3 / SUBMIT_POLL_MS3);
    return requireReplyActionResult(await page.evaluate(`(async () => {
      try {
          const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
          for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
              const buttons = Array.from(
                  document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')
              );
              const btn = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
              if (btn) {
                  for (const toast of Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))) {
                      if (visible(toast)) toast.setAttribute('data-opencli-before-reply-toast', 'true');
                  }
                  btn.click();
                  return { ok: true };
              }
              await new Promise(r => setTimeout(r, ${JSON.stringify(SUBMIT_POLL_MS3)}));
          }
          return { ok: false, message: 'Reply button is disabled or not found.' };
      } catch (e) {
          return { ok: false, message: e.toString() };
      }
  })()`), "Twitter reply click");
  }
  async function detectReplySent(page) {
    const result = requireReplyActionResult(await page.evaluate(`(() => {
        const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
        const statusUrl = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return undefined;
            const links = Array.from(root.querySelectorAll('a[href*="/status/"]'));
            for (const link of links) {
                const href = link.href || link.getAttribute('href') || '';
                if (!href) continue;
                try {
                    const url = new URL(href, window.location.origin);
                    const hostname = url.hostname.toLowerCase().replace(/^www\\./, '');
                    if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)) continue;
                    if (/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/.test(url.pathname)) return url.href;
                } catch {}
            }
            return undefined;
        };
        const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
            .filter((el) => visible(el) && !el.hasAttribute('data-opencli-before-reply-toast'));
        const successToast = toasts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
        if (!successToast) return { ok: false };
        return {
            ok: true,
            message: 'Reply posted successfully.',
            url: statusUrl(successToast)
        };
    })()`), "Twitter reply success recovery");
    validateReplyStatusUrl(result);
    return result;
  }
  async function waitForReplySent(page, text) {
    const iterations = Math.ceil(SUBMIT_TIMEOUT_MS3 / SUBMIT_POLL_MS3);
    try {
      const result = requireReplyActionResult(await page.evaluate(`(async () => {
            const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
            const statusUrl = (root) => {
                if (!root || typeof root.querySelectorAll !== 'function') return undefined;
                const links = Array.from(root.querySelectorAll('a[href*="/status/"]'));
                for (const link of links) {
                    const href = link.href || link.getAttribute('href') || '';
                    if (!href) continue;
                    try {
                        const url = new URL(href, window.location.origin);
                        const hostname = url.hostname.toLowerCase().replace(/^www\\./, '');
                        if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)) continue;
                        if (/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/.test(url.pathname)) return url.href;
                    } catch {}
                }
                return undefined;
            };
            for (let i = 0; i < ${JSON.stringify(iterations)}; i++) {
                await new Promise(r => setTimeout(r, ${JSON.stringify(SUBMIT_POLL_MS3)}));
                const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
                    .filter((el) => visible(el) && !el.hasAttribute('data-opencli-before-reply-toast'));
                const successToast = toasts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
                if (successToast) {
                    return {
                        ok: true,
                        message: 'Reply posted successfully.',
                        url: statusUrl(successToast)
                    };
                }
                const alert = toasts.find((el) => /failed|error|try again|not sent|could not/i.test(el.textContent || ''));
                if (alert) return { ok: false, message: (alert.textContent || 'Reply failed to post.').trim() };

                // Composer disappearance or text clearing alone can happen after
                // modal rewrites or failed submits. Require a fresh success toast.
            }
            return { ok: false, unconfirmed: true, message: 'Reply submission did not complete before timeout.' };
        })()`), "Twitter reply completion");
      validateReplyStatusUrl(result);
      return result;
    } catch (err) {
      if (!isPromiseCollectedError(err)) throw err;
      await page.wait(2);
      const recovered = await detectReplySent(page);
      if (recovered?.ok) return recovered;
      throw err;
    }
  }
  async function submitReply(page, text) {
    const typed = await insertReplyText(page, text);
    if (!typed?.ok) return typed;
    let clicked;
    try {
      clicked = await clickReplyButton(page);
    } catch (err) {
      if (!isPromiseCollectedError(err)) throw err;
    }
    if (clicked && !clicked.ok) return clicked;
    return waitForReplySent(page, text);
  }
  cli({
    site: "twitter",
    name: "reply",
    access: "write",
    description: "Reply to a specific tweet (text only)",
    domain: "x.com",
    strategy: Strategy.UI,
    // Uses the UI directly to input and click post
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to reply to" },
      { name: "text", type: "string", required: true, positional: true, help: "The text content of your reply" }
    ],
    columns: ["status", "message", "text", "url"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter reply");
      const composer = await openReplyComposer(page, kwargs.url);
      if (!composer?.ok) {
        throw new CommandExecutionError(composer?.message ?? "Could not open the reply composer.", "Open the tweet in the browser and check whether the reply box is available.");
      }
      const result = await submitReply(page, kwargs.text);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter reply", SUBMIT_TIMEOUT_MS3 / 1e3, `${result.message} Check the tweet before retrying; the reply may already be live.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing was posted. Open the tweet in the browser and retry.");
      }
      return [{
        status: "success",
        message: result.message,
        text: kwargs.text,
        ...result.url ? { url: result.url } : {}
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/reply-dm.js
  cli({
    site: "twitter",
    name: "reply-dm",
    access: "write",
    description: "Send a message to recent DM conversations",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "text", type: "string", required: true, positional: true, help: 'Message text to send (e.g. "\u6211\u7684\u5FAE\u4FE1 wxkabi")' },
      { name: "max", type: "int", required: false, default: 20, help: "Maximum number of conversations to reply to (default: 20)" },
      { name: "skip-replied", type: "boolean", required: false, default: true, help: "Skip conversations where you already sent the same text (default: true)" },
      { name: "timeout", type: "int", required: false, default: 600, help: "Max seconds for the overall command (default: 600 \u2014 batch op)" }
    ],
    columns: ["index", "status", "user", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter reply-dm");
      const messageText = kwargs.text;
      const maxSend = kwargs.max ?? 20;
      const skipReplied = kwargs["skip-replied"] !== false;
      const results = [];
      let sentCount = 0;
      await page.goto("https://x.com/messages");
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const needed = maxSend + 10;
      const convList = await page.evaluate(`(async () => {
      try {
        // Wait for initial items
        let attempts = 0;
        while (attempts < 10) {
          const items = document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]');
          if (items.length > 0) break;
          await new Promise(r => setTimeout(r, 1000));
          attempts++;
        }

        // Scroll to load more conversations
        const needed = ${needed};
        const seenIds = new Set();
        let noNewCount = 0;

        for (let scroll = 0; scroll < 30; scroll++) {
          const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
          items.forEach(el => seenIds.add(el.getAttribute('data-testid')));

          if (seenIds.size >= needed) break;

          // Find the scrollable container and scroll it
          const scrollContainer = document.querySelector('[data-testid="dm-inbox-panel"]') ||
                                  items[items.length - 1]?.closest('[class*="scroll"]') ||
                                  items[items.length - 1]?.parentElement;
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
          // Also try scrolling the last item into view
          if (items.length > 0) {
            items[items.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
          }

          await new Promise(r => setTimeout(r, 1500));

          // Check if new items appeared
          const newItems = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
          const newIds = new Set(newItems.map(el => el.getAttribute('data-testid')));
          if (newIds.size <= seenIds.size) {
            noNewCount++;
            if (noNewCount >= 3) break; // No more loading after 3 tries
          } else {
            noNewCount = 0;
          }
        }

        // Collect all visible conversations
        const finalItems = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
        const conversations = finalItems.map((item, idx) => {
          const testId = item.getAttribute('data-testid') || '';
          const text = item.innerText || '';
          const lines = text.split('\\n').filter(l => l.trim());
          const user = lines[0] || 'Unknown';
          const match = testId.match(/dm-conversation-item-(.+)/);
          const convId = match ? match[1].replace(':', '-') : '';
          const link = item.querySelector('a[href*="/messages/"]');
          const href = link ? link.href : '';
          return { idx, user, convId, href, preview: text.substring(0, 100) };
        });

        return { ok: true, conversations, total: conversations.length };
      } catch(e) {
        return { ok: false, error: String(e), conversations: [], total: 0 };
      }
    })()`);
      if (!convList?.ok || !convList.conversations?.length) {
        return [{ index: 1, status: "info", user: "System", message: "No conversations found" }];
      }
      const conversations = convList.conversations;
      for (const conv of conversations) {
        if (sentCount >= maxSend)
          break;
        const convUrl = conv.convId ? `https://x.com/messages/${conv.convId}` : conv.href;
        if (!convUrl)
          continue;
        await page.goto(convUrl);
        await page.wait(3);
        const sendResult = await page.evaluate(`(async () => {
        try {
          const messageText = ${JSON.stringify(messageText)};
          const skipReplied = ${skipReplied};

          // Get username from conversation
          const dmHeader = document.querySelector('[data-testid="DmActivityContainer"] [dir="ltr"] span') ||
                           document.querySelector('[data-testid="conversation-header"]') ||
                           document.querySelector('[data-testid="DmActivityContainer"] h2');
          const username = dmHeader ? dmHeader.innerText.trim().split('\\\\n')[0] : '${conv.user}';

          // Check if we already sent this message
          if (skipReplied) {
            const chatArea = document.querySelector('[data-testid="DmScrollerContainer"]') ||
                             document.querySelector('main');
            const chatText = chatArea ? chatArea.innerText : '';
            if (chatText.includes(messageText)) {
              return { status: 'skipped', user: username, message: 'Already sent this message' };
            }
          }

          // Find the text input
          const input = document.querySelector('[data-testid="dmComposerTextInput"]');
          if (!input) {
            return { status: 'error', user: username, message: 'No message input found' };
          }

          // Focus and type into the DraftEditor
          input.focus();
          await new Promise(r => setTimeout(r, 300));
          document.execCommand('insertText', false, messageText);
          await new Promise(r => setTimeout(r, 500));

          // Click send button
          const sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]');
          if (!sendBtn) {
            return { status: 'error', user: username, message: 'No send button found' };
          }

          sendBtn.click();
          await new Promise(r => setTimeout(r, 1500));

          return { status: 'sent', user: username, message: 'Message sent: ' + messageText };
        } catch(e) {
          return { status: 'error', user: 'system', message: String(e) };
        }
      })()`);
        if (sendResult?.status === "sent") {
          sentCount++;
          results.push({
            index: sentCount,
            status: "sent",
            user: sendResult.user || conv.user,
            message: sendResult.message
          });
        } else if (sendResult?.status === "skipped") {
          results.push({
            index: results.length + 1,
            status: "skipped",
            user: sendResult.user || conv.user,
            message: sendResult.message
          });
        }
        await page.wait(1);
      }
      if (results.length === 0) {
        results.push({ index: 0, status: "info", user: "System", message: "No conversations processed" });
      }
      return results;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/retweet.js
  cli({
    site: "twitter",
    name: "retweet",
    access: "write",
    description: "Retweet a specific tweet",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to retweet" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter retweet");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            // Poll for the tweet to render. State probes scoped to the article
            // matching the requested status id \u2014 bare querySelector on a
            // conversation page would silently grab the first article (e.g.
            // the parent tweet) and retweet the wrong one.
            let attempts = 0;
            let retweetBtn = null;
            let unretweetBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                unretweetBtn = targetArticle?.querySelector('[data-testid="unretweet"]') || null;
                retweetBtn = targetArticle?.querySelector('[data-testid="retweet"]') || null;

                if (unretweetBtn || retweetBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            // Already retweeted: idempotent success
            if (unretweetBtn) {
                return { ok: true, message: 'Tweet is already retweeted.' };
            }

            if (!retweetBtn) {
                return { ok: false, message: 'Could not find the Retweet button on this tweet after waiting 10 seconds. Are you logged in?' };
            }

            // Step 1: click Retweet button \u2192 opens menu
            retweetBtn.click();

            // Step 2: wait for and click the confirm menu item. The confirm
            // popover renders at the document root, not inside the article,
            // so this lookup is intentionally document-scoped.
            let confirmBtn = null;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 250));
                confirmBtn = document.querySelector('[data-testid="retweetConfirm"]');
                if (confirmBtn) break;
            }
            if (!confirmBtn) {
                return { ok: false, message: 'Retweet menu opened but the confirm option did not appear.' };
            }
            writeStarted = true;
            confirmBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify success by checking if the 'unretweet' button appeared
            const verifyArticle = findTargetArticle() || targetArticle;
            const verifyBtn = verifyArticle?.querySelector('[data-testid="unretweet"]');
            if (verifyBtn) {
                return { ok: true, message: 'Tweet successfully retweeted.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Retweet action was initiated but UI did not update as expected.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter retweet confirmation", 1, `${result.message} Check the tweet before retrying; the retweet may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/search.js
  var HAS_CHOICES = Object.freeze(["media", "images", "videos", "links", "replies"]);
  var EXCLUDE_CHOICES = Object.freeze(["replies", "retweets", "media", "links"]);
  var PRODUCT_CHOICES = Object.freeze(["top", "live", "photos", "videos"]);
  var PRODUCT_TO_F_PARAM = Object.freeze({
    top: "top",
    live: "live",
    photos: "image",
    videos: "video"
  });
  var PRODUCT_TO_GRAPHQL_PRODUCT = Object.freeze({
    top: "Top",
    live: "Latest",
    photos: "Photos",
    videos: "Videos"
  });
  var MAX_PAGINATION_PAGES6 = 100;
  var SEARCH_TIMELINE_OPERATION = {
    queryId: "Yw6L66Pw54NHKuq4Dp7b4Q",
    features: {
      rweb_video_screen_enabled: true,
      rweb_cashtags_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: true,
      rweb_cashtags_composer_attachment_enabled: true,
      responsive_web_jetfuel_frame: true,
      responsive_web_grok_share_attachment_enabled: true,
      responsive_web_grok_annotations_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      content_disclosure_indicator_enabled: true,
      content_disclosure_ai_generated_indicator_enabled: true,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_grok_analysis_button_from_backend: true,
      post_ctas_fetch_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_grok_image_annotation_enabled: true,
      responsive_web_grok_imagine_annotation_enabled: true,
      responsive_web_grok_community_note_auto_translation_is_enabled: false,
      responsive_web_enhance_cards_enabled: false
    },
    fieldToggles: {
      withPayments: true,
      withAuxiliaryUserLabels: true,
      withArticleRichContentState: true,
      withArticlePlainText: true,
      withArticleSummaryText: true,
      withArticleVoiceOver: true,
      withGrokAnalyze: true,
      withDisallowedReplyControls: true
    }
  };
  var FROM_USER_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
  var EXCLUDE_TO_OPERATOR = Object.freeze({
    replies: "-filter:replies",
    // `retweets` is a CLI-friendly alias for X's actual `-filter:nativeretweets`.
    retweets: "-filter:nativeretweets",
    media: "-filter:media",
    links: "-filter:links"
  });
  function buildSearchQuery(rawQuery, kwargs) {
    const parts = [String(rawQuery ?? "").trim()];
    if (kwargs.from) {
      const fromUser = String(kwargs.from).trim().replace(/^@+/, "");
      if (fromUser && !FROM_USER_PATTERN.test(fromUser)) {
        throw new ArgumentError(
          `Invalid --from username: ${JSON.stringify(kwargs.from)}`,
          "Use a Twitter/X handle with 1-15 letters, numbers, or underscores; omit @ or pass @handle."
        );
      }
      if (fromUser) parts.push(`from:${fromUser}`);
    }
    if (kwargs.has) {
      parts.push(`filter:${kwargs.has}`);
    }
    if (kwargs.exclude) {
      const op = EXCLUDE_TO_OPERATOR[kwargs.exclude];
      if (op) parts.push(op);
    }
    return parts.filter(Boolean).join(" ");
  }
  function resolveSearchProduct(kwargs) {
    const product = kwargs.product || (kwargs.filter === "live" ? "live" : "top");
    return PRODUCT_TO_GRAPHQL_PRODUCT[product] || "Top";
  }
  function normalizeOperation(operation) {
    if (typeof operation === "string") {
      return {
        queryId: operation,
        features: SEARCH_TIMELINE_OPERATION.features,
        fieldToggles: SEARCH_TIMELINE_OPERATION.fieldToggles
      };
    }
    return {
      queryId: operation?.queryId || SEARCH_TIMELINE_OPERATION.queryId,
      features: operation?.features || SEARCH_TIMELINE_OPERATION.features,
      fieldToggles: operation?.fieldToggles || SEARCH_TIMELINE_OPERATION.fieldToggles
    };
  }
  function buildSearchTimelineRequest(operation, rawQuery, product, count, cursor) {
    const normalized = normalizeOperation(operation);
    const vars = {
      rawQuery,
      count,
      querySource: "typed_query",
      product
    };
    if (cursor) vars.cursor = cursor;
    return [
      `/i/api/graphql/${normalized.queryId}/SearchTimeline`,
      {
        variables: vars,
        features: normalized.features,
        fieldToggles: normalized.fieldToggles
      }
    ];
  }
  function unwrapTweetResult2(result) {
    if (!result) return null;
    if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
    if (result.tweet) return result.tweet;
    return result;
  }
  function tweetToRow(result, seen) {
    const tweet = unwrapTweetResult2(result);
    if (!tweet?.rest_id || seen.has(tweet.rest_id)) return null;
    seen.add(tweet.rest_id);
    const tweetUser = tweet.core?.user_results?.result;
    const bio = tweetUser?.legacy?.description || "";
    return {
      id: tweet.rest_id,
      author: tweetUser?.core?.screen_name || tweetUser?.legacy?.screen_name || "",
      bio,
      text: tweet.note_tweet?.note_tweet_results?.result?.text || tweet.legacy?.full_text || "",
      created_at: tweet.legacy?.created_at || "",
      likes: tweet.legacy?.favorite_count || 0,
      views: tweet.views?.count || "0",
      url: `https://x.com/i/status/${tweet.rest_id}`,
      ...extractMedia(tweet.legacy),
      card: extractCard(tweet),
      quoted_tweet: extractQuotedTweet(tweet)
    };
  }
  function parseSearchTimeline(data, seen) {
    const rows = [];
    let nextCursor = null;
    const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.tweet_results?.result) {
        const row = tweetToRow(value.tweet_results.result, seen);
        if (row) rows.push(row);
      }
      if ((value.entryType === "TimelineTimelineCursor" || value.__typename === "TimelineTimelineCursor") && (value.cursorType === "Bottom" || value.cursorType === "ShowMore") && value.value) {
        nextCursor = value.value;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") visit(child);
      }
    };
    visit(instructions);
    return { rows, nextCursor };
  }
  async function parseVisibleTweetRows(page, seen, limit) {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const parseMetric = (value) => {
      const text = clean(value).replace(/,/g, "");
      const match = text.match(/([0-9]+(?:\.[0-9]+)?)([KkMm万亿]?)/);
      if (!match) return 0;
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return 0;
      const unit = match[2];
      if (unit === "K" || unit === "k") return Math.round(base * 1e3);
      if (unit === "M" || unit === "m") return Math.round(base * 1e6);
      if (unit === "万") return Math.round(base * 1e4);
      if (unit === "亿") return Math.round(base * 1e8);
      return Math.round(base);
    };
    const rows = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map((article) => {
      const statusLink = Array.from(article.querySelectorAll('a[href*="/status/"]')).map((link) => {
        try {
          return new URL(link.getAttribute("href"), location.origin);
        } catch {
          return null;
        }
      }).filter(Boolean).find((url) => /\/status\/\d+/.test(url.pathname));
      const id = statusLink ? (statusLink.pathname.match(/\/status\/(\d+)/) || [])[1] : "";
      const authorLink = Array.from(article.querySelectorAll('a[href^="/"]')).map((link) => {
        const href = link.getAttribute("href") || "";
        const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/);
        return match ? match[1] : "";
      }).find(Boolean) || "";
      const text = clean(Array.from(article.querySelectorAll('[data-testid="tweetText"]')).map((node) => node.textContent || "").join("\n"));
      const time = article.querySelector("time");
      const metric = (name) => parseMetric(article.querySelector('[data-testid="' + name + '"]')?.getAttribute("aria-label") || article.querySelector('[data-testid="' + name + '"]')?.textContent || "");
      const imgs = Array.from(article.querySelectorAll("img[src]")).map((img) => img.src).filter((src) => /twimg\.com/.test(src));
      return {
        id,
        author: authorLink,
        bio: "",
        text,
        created_at: time ? time.getAttribute("datetime") || time.textContent || "" : "",
        likes: metric("like"),
        views: clean(article.querySelector('a[href$="/analytics"]')?.textContent || "0"),
        url: statusLink ? statusLink.href.replace(/^https:\/\/twitter\.com\//, "https://x.com/") : "",
        has_media: imgs.length > 0,
        media_urls: imgs,
        media_posters: [],
        card: null,
        quoted_tweet: null
      };
    }).filter((row) => row.id && (row.text || row.has_media));
    const out = [];
    for (const row of rows) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }
  cli({
    site: "twitter",
    name: "search",
    access: "read",
    description: "Search Twitter/X for tweets, with optional --from / --has / --exclude / --product filters mapped to X's search operators",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "query", type: "string", required: true, positional: true, help: 'Search query. Raw X operators (e.g. "exact phrase", #tag, OR, lang:en, since:YYYY-MM-DD, from:, since:) are passed through unchanged.' },
      { name: "filter", type: "string", default: "top", choices: ["top", "live"], help: "Legacy alias for --product. Kept for backwards compatibility; if --product is set it wins." },
      { name: "product", type: "string", choices: PRODUCT_CHOICES, help: "Which X search tab to read: top (default), live (Latest), photos, videos. Maps to the f= URL param." },
      { name: "from", type: "string", help: "Restrict to tweets authored by <user>. Leading @ is stripped. Equivalent to appending `from:<user>` to the query." },
      { name: "has", type: "string", choices: HAS_CHOICES, help: "Restrict to tweets that have media|images|videos|links|replies. Maps to X's `filter:<has>` operator." },
      { name: "exclude", type: "string", choices: EXCLUDE_CHOICES, help: "Exclude tweets matching <type>: replies|retweets|media|links. Maps to X's `-filter:<x>` operator (retweets \u2192 -filter:nativeretweets)." },
      { name: "limit", type: "int", default: 15, help: "Maximum number of tweets to return (default 15). Result count after server-side filtering." },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the results by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps X's native ordering." }
    ],
    columns: ["id", "author", "bio", "text", "created_at", "likes", "views", "url", "has_media", "media_urls", "media_posters", "card", "quoted_tweet"],
    func: async (page, kwargs) => {
      const finalQuery = buildSearchQuery(kwargs.query, kwargs);
      if (!finalQuery) {
        throw new ArgumentError("twitter search query is empty", "Provide a non-empty <query>, or use at least one of --from / --has / --exclude.");
      }
      if (!Number.isInteger(Number(kwargs.limit)) || Number(kwargs.limit) <= 0) {
        throw new ArgumentError("twitter search --limit must be a positive integer", "Example: opencli twitter search opencli --limit 15");
      }
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const searchUrl = `https://x.com/search?q=${encodeURIComponent(finalQuery)}&src=typed_query&f=${encodeURIComponent(PRODUCT_TO_F_PARAM[kwargs.product || kwargs.filter || "top"] || "top")}`;
      await page.goto(searchUrl, { waitUntil: "load", settleMs: 2e3 });
      const operation = await resolveTwitterOperationMetadata(page, "SearchTimeline", SEARCH_TIMELINE_OPERATION);
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "Content-Type": "application/json"
      });
      const product = resolveSearchProduct(kwargs);
      const results = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      for (let i = 0; i < MAX_PAGINATION_PAGES6 && results.length < kwargs.limit; i++) {
        const fetchCount = Number(kwargs.limit) - results.length + 10;
        const [requestUrl, requestPayload] = buildSearchTimelineRequest(operation, finalQuery, product, fetchCount, cursor);
        const requestBody = JSON.stringify(requestPayload);
        const data = normalizeTwitterGraphqlPayload(await page.evaluate(`async () => {
        const options = {
          method: 'POST',
          headers: ${headers},
          credentials: 'include',
        };
        options['body'] = ${JSON.stringify(requestBody)};
        const r = await fetch(${JSON.stringify(requestUrl)}, {
          ...options,
        });
        return r.ok ? await r.json() : { error: r.status };
      }`));
        if (data?.error) {
          if (results.length === 0) throw new CommandExecutionError(describeTwitterApiError("SearchTimeline", data.error));
          break;
        }
        const { rows, nextCursor } = parseSearchTimeline(data, seen);
        results.push(...rows);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      const trimmed = results.slice(0, kwargs.limit);
      if (trimmed.length > 0) {
        return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
      }
      await page.wait(3);
      const fallbackRows = await parseVisibleTweetRows(page, seen, Number(kwargs.limit));
      if (fallbackRows.length === 0) {
        throw new EmptyResultError(`twitter search ${finalQuery}`, "No tweets were returned by X GraphQL or the visible search page. The session may need login/verification or the page structure may have changed.");
      }
      return applyTopByEngagement(fallbackRows.slice(0, kwargs.limit), kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/thread.js
  var TWEET_DETAIL_QUERY_ID = "nBS-WpgA6ZG0CyNHD517JQ";
  var FEATURES9 = {
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true
  };
  var FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false };
  function buildTweetDetailUrl(tweetId, cursor) {
    const vars = {
      focalTweetId: tweetId,
      referrer: "tweet",
      with_rux_injections: false,
      includePromotedContent: false,
      rankingMode: "Recency",
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true
    };
    if (cursor)
      vars.cursor = cursor;
    return `/i/api/graphql/${TWEET_DETAIL_QUERY_ID}/TweetDetail?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES9))}&fieldToggles=${encodeURIComponent(JSON.stringify(FIELD_TOGGLES))}`;
  }
  function extractTweet(r, seen) {
    if (!r)
      return null;
    const tw = r.tweet || r;
    const l = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id))
      return null;
    seen.add(tw.rest_id);
    const u = tw.core?.user_results?.result;
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    const screenName = u?.legacy?.screen_name || u?.core?.screen_name || "";
    const bio = u?.legacy?.description || "";
    return {
      id: tw.rest_id,
      author: screenName,
      bio,
      text: noteText || l.full_text || "",
      likes: l.favorite_count || 0,
      retweets: l.retweet_count || 0,
      in_reply_to: l.in_reply_to_status_id_str || void 0,
      created_at: l.created_at,
      url: `https://x.com/${screenName}/status/${tw.rest_id}`,
      ...extractMedia(l),
      card: extractCard(tw),
      quoted_tweet: extractQuotedTweet(tw)
    };
  }
  function parseTweetDetail(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || data?.data?.tweetResult?.result?.timeline?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const c = entry.content;
        if (c?.entryType === "TimelineTimelineCursor" || c?.__typename === "TimelineTimelineCursor") {
          if (c.cursorType === "Bottom" || c.cursorType === "ShowMore")
            nextCursor = c.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
          nextCursor = c?.itemContent?.value || c?.value || nextCursor;
          continue;
        }
        const tw = extractTweet(c?.itemContent?.tweet_results?.result, seen);
        if (tw)
          tweets.push(tw);
        for (const item of c?.items || []) {
          const nested = extractTweet(item.item?.itemContent?.tweet_results?.result, seen);
          if (nested)
            tweets.push(nested);
        }
      }
    }
    return { tweets, nextCursor };
  }
  cli({
    site: "twitter",
    name: "thread",
    access: "read",
    description: "Get a tweet thread (original + all replies)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "tweet-id", positional: true, type: "string", required: true, help: "Tweet numeric ID (e.g. 1234567890) or full status URL" },
      { name: "limit", type: "int", default: 50 },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the thread by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps the conversation's structural ordering." }
    ],
    columns: ["id", "author", "bio", "text", "likes", "retweets", "url", "has_media", "media_urls", "media_posters", "card", "quoted_tweet"],
    func: async (page, kwargs) => {
      let tweetId = kwargs["tweet-id"];
      const urlMatch = tweetId.match(/\/status\/(\d+)/);
      if (urlMatch)
        tweetId = urlMatch[1];
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const headers = JSON.stringify({
        "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const allTweets = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      for (let i = 0; i < 5; i++) {
        const apiUrl = buildTweetDetailUrl(tweetId, cursor);
        const data = throwIfLoginWall(await page.evaluate(`async () => {
        ${BROWSER_JSON_SNIFF_FN}
        return await fetchJsonOrLoginWall("${apiUrl}", { headers: ${headers}, credentials: 'include' });
      }`), { url: apiUrl });
        if (data?.error) {
          if (allTweets.length === 0)
            throw new CommandExecutionError(describeTwitterApiError("TweetDetail", data.error));
          break;
        }
        const { tweets, nextCursor } = parseTweetDetail(data, seen);
        allTweets.push(...tweets);
        if (!nextCursor || nextCursor === cursor)
          break;
        cursor = nextCursor;
      }
      const trimmed = allTweets.slice(0, kwargs.limit);
      return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/timeline.js
  var HOME_TIMELINE_QUERY_ID = "c-CzHF1LboFilMpsx4ZCrQ";
  var HOME_LATEST_TIMELINE_QUERY_ID = "BKB7oi212Fi7kQtCBGE4zA";
  var MAX_PAGINATION_PAGES7 = 100;
  var TIMELINE_ENDPOINTS = {
    "for-you": { endpoint: "HomeTimeline", method: "GET", fallbackQueryId: HOME_TIMELINE_QUERY_ID },
    following: { endpoint: "HomeLatestTimeline", method: "POST", fallbackQueryId: HOME_LATEST_TIMELINE_QUERY_ID }
  };
  var FEATURES10 = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  function buildTimelineVariables(type, count, cursor) {
    const vars = {
      count,
      includePromotedContent: false,
      latestControlAvailable: true,
      requestContext: "launch"
    };
    if (type === "for-you")
      vars.withCommunity = true;
    if (type === "following")
      vars.seenTweetIds = [];
    if (cursor)
      vars.cursor = cursor;
    return vars;
  }
  function buildHomeTimelineUrl(queryId, endpoint, vars) {
    return `/i/api/graphql/${queryId}/${endpoint}?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES10))}`;
  }
  function extractTweet2(result, seen) {
    if (!result)
      return null;
    const tw = result.tweet || result;
    const l = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id))
      return null;
    seen.add(tw.rest_id);
    const u = tw.core?.user_results?.result;
    const screenName = u?.legacy?.screen_name || u?.core?.screen_name || "";
    const bio = u?.legacy?.description || "";
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    const views = tw.views?.count ? parseInt(tw.views.count, 10) : 0;
    return {
      id: tw.rest_id,
      author: screenName,
      bio,
      text: noteText || l.full_text || "",
      likes: l.favorite_count || 0,
      retweets: l.retweet_count || 0,
      replies: l.reply_count || 0,
      views,
      created_at: l.created_at || "",
      url: `https://x.com/${screenName}/status/${tw.rest_id}`,
      ...extractMedia(l),
      card: extractCard(tw),
      quoted_tweet: extractQuotedTweet(tw)
    };
  }
  function parseHomeTimeline(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.home?.home_timeline_urt?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const c = entry.content;
        if (c?.entryType === "TimelineTimelineCursor" || c?.__typename === "TimelineTimelineCursor") {
          if (c.cursorType === "Bottom")
            nextCursor = c.value;
          continue;
        }
        if (entry.entryId?.startsWith("cursor-bottom-")) {
          nextCursor = c?.value || nextCursor;
          continue;
        }
        const tweetResult = c?.itemContent?.tweet_results?.result;
        if (tweetResult) {
          if (c?.itemContent?.promotedMetadata)
            continue;
          const tw = extractTweet2(tweetResult, seen);
          if (tw)
            tweets.push(tw);
          continue;
        }
        for (const item of c?.items || []) {
          const nested = item.item?.itemContent?.tweet_results?.result;
          if (nested) {
            if (item.item?.itemContent?.promotedMetadata)
              continue;
            const tw = extractTweet2(nested, seen);
            if (tw)
              tweets.push(tw);
          }
        }
      }
    }
    return { tweets, nextCursor };
  }
  cli({
    site: "twitter",
    name: "timeline",
    access: "read",
    description: "Fetch the logged-in user's home timeline (for-you algorithmic feed by default; pass --type following for the chronological feed of accounts you follow)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      {
        name: "type",
        default: "for-you",
        choices: ["for-you", "following"],
        help: "Which home-timeline feed to read. Default for-you (algorithmic). Use following for the chronological feed of accounts you follow."
      },
      { name: "limit", type: "int", default: 20, help: "Maximum number of tweets to return (default 20)." },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the timeline by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps X's native ordering." }
    ],
    columns: ["id", "author", "bio", "text", "likes", "retweets", "replies", "views", "created_at", "url", "has_media", "media_urls", "media_posters", "card", "quoted_tweet"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit || 20;
      const timelineType = kwargs.type === "following" ? "following" : "for-you";
      const { endpoint, method, fallbackQueryId } = TIMELINE_ENDPOINTS[timelineType];
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      const queryId = await resolveTwitterQueryId(page, endpoint, fallbackQueryId);
      const headers = JSON.stringify({
        Authorization: `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      });
      const allTweets = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = null;
      for (let i = 0; i < MAX_PAGINATION_PAGES7 && allTweets.length < limit; i++) {
        const fetchCount = Math.min(40, limit - allTweets.length + 5);
        const variables = buildTimelineVariables(timelineType, fetchCount, cursor);
        const apiUrl = buildHomeTimelineUrl(queryId, endpoint, variables);
        const data = await page.evaluate(`async () => {
        const r = await fetch("${apiUrl}", { method: "${method}", headers: ${headers}, credentials: 'include' });
        return r.ok ? await r.json() : { error: r.status };
      }`);
        if (data?.error) {
          if (allTweets.length === 0)
            throw new CommandExecutionError(describeTwitterApiError(endpoint, data.error));
          break;
        }
        const { tweets, nextCursor } = parseHomeTimeline(data, seen);
        allTweets.push(...tweets);
        if (!nextCursor || nextCursor === cursor)
          break;
        cursor = nextCursor;
      }
      const trimmed = allTweets.slice(0, limit);
      return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/trending.js
  cli({
    site: "twitter",
    name: "trending",
    access: "read",
    description: "Twitter/X trending topics",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of trends to show" }
    ],
    columns: ["rank", "topic", "category"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit || 20;
      await page.goto("https://x.com/explore/tabs/trending");
      await page.wait(3);
      const cookies = await page.getCookies({ url: "https://x.com" });
      const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
      if (!ct0)
        throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
      await page.wait(2);
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const trends = [];
      const pushTopic = (topic, category) => {
        topic = clean(topic);
        category = clean(category);
        if (!topic || trends.some((item) => item.topic === topic)) return;
        trends.push({ rank: trends.length + 1, topic, category });
      };
      const cells = document.querySelectorAll('[data-testid="trend"]');
      cells.forEach((cell) => {
        const text = cell.textContent || "";
        if (text.includes("Promoted")) return;
        const container = cell.querySelector(":scope > div");
        const divs = container ? Array.from(container.children) : [];
        const topic = clean(divs[1]?.textContent || cell.querySelector('[dir="ltr"]')?.textContent || "");
        const catText = clean(divs[0]?.textContent || "");
        const category = catText.replace(/^\d+\s*/, "").replace(/^·\s*/, "").trim();
        pushTopic(topic, category);
      });
      if (trends.length === 0) {
        const links = Array.from(document.querySelectorAll('a[href*="/search?q="]'));
        links.forEach((link) => {
          try {
            const url = new URL(link.getAttribute("href"), location.origin);
            const topic = url.searchParams.get("q") || "";
            const text = clean(link.textContent || "");
            const category = text.replace(topic, "").replace(/Trending|Posts|post[s]?|条帖子/gi, "").trim();
            pushTopic(topic, category);
          } catch {
          }
        });
      }
      if (!Array.isArray(trends) || trends.length === 0) {
        throw new EmptyResultError("twitter trending", "No trends found. The page structure may have changed.");
      }
      return trends.slice(0, limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/tweets.js
  var MAX_TWEETS_LIMIT = MAX_USER_TWEETS_LIMIT;
  var DEFAULT_PAGE_DELAY_SECONDS = DEFAULT_USER_TWEETS_PAGE_DELAY_SECONDS;
  function extractTweet3(result, seen) {
    if (!result) return null;
    const tw = result.__typename === "TweetWithVisibilityResults" && result.tweet ? result.tweet : result.tweet || result;
    const legacy = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id)) return null;
    seen.add(tw.rest_id);
    const user = tw.core?.user_results?.result;
    const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "";
    const displayName = user?.legacy?.name || user?.core?.name || "";
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    const isRetweet = Boolean(legacy.retweeted_status_result || legacy.full_text?.startsWith("RT @"));
    return {
      id: tw.rest_id,
      author: screenName,
      name: displayName,
      text: noteText || legacy.full_text || "",
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      views: Number(tw.views?.count) || 0,
      is_retweet: isRetweet,
      created_at: legacy.created_at || "",
      url: `https://x.com/${screenName}/status/${tw.rest_id}`,
      ...extractMedia(legacy),
      quoted_tweet: extractQuotedTweet(tw)
    };
  }
  function parseUserTweets(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const result = data?.data?.user?.result || {};
    const instructionSets = [
      result.timeline_v2?.timeline?.instructions,
      result.timeline?.timeline?.instructions
    ].filter(Array.isArray);
    const instructions = instructionSets.flat();
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "TimelinePinEntry") return;
      if (value.tweet_results?.result) {
        const tweet = extractTweet3(value.tweet_results.result, seen);
        if (tweet) tweets.push(tweet);
      }
      if ((value.entryType === "TimelineTimelineCursor" || value.__typename === "TimelineTimelineCursor") && (value.cursorType === "Bottom" || value.cursorType === "ShowMore") && value.value) {
        nextCursor = value.value;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === "object") visit(child);
      }
    };
    visit(instructions);
    return { tweets, nextCursor };
  }
  function normalizeLimit(rawLimit) {
    const limit = rawLimit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TWEETS_LIMIT) {
      throw new ArgumentError(
        `twitter tweets --limit must be an integer between 1 and ${MAX_TWEETS_LIMIT}`,
        "Example: opencli twitter tweets @jack --limit 250"
      );
    }
    return limit;
  }
  function normalizePageDelaySeconds(rawDelay) {
    const delay = rawDelay ?? DEFAULT_PAGE_DELAY_SECONDS;
    if (!Number.isInteger(delay) || delay < 0 || delay > 60) {
      throw new ArgumentError(
        "twitter tweets --page-delay must be an integer between 0 and 60 seconds",
        "Example: opencli twitter tweets @jack --limit 250 --page-delay 2"
      );
    }
    return delay;
  }
  cli({
    site: "twitter",
    name: "tweets",
    access: "read",
    description: "Fetch a Twitter user's most recent tweets (chronological, excludes pinned; defaults to the logged-in user when no username is given)",
    domain: "x.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, help: "Twitter screen name (with or without @). Defaults to the logged-in user when omitted." },
      { name: "limit", type: "int", default: 20, help: `Max tweets to return (1-${MAX_TWEETS_LIMIT}; fetched across cursor pages)` },
      { name: "page-delay", type: "int", default: DEFAULT_PAGE_DELAY_SECONDS, help: "Seconds to wait between paginated timeline requests to reduce rate-limit risk. Use 0 to disable." },
      { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the tweets by weighted engagement (likes\xD71 + retweets\xD73 + replies\xD72 + bookmarks\xD75 + log10(views+1)\xD70.5) and return the top N. Default 0 keeps the chronological ordering." }
    ],
    columns: ["id", "author", "created_at", "is_retweet", "text", "likes", "retweets", "replies", "views", "url", "has_media", "media_urls", "media_posters", "quoted_tweet"],
    func: async (page, kwargs) => {
      const limit = normalizeLimit(kwargs.limit);
      const pageDelaySeconds = normalizePageDelaySeconds(kwargs["page-delay"]);
      let context;
      try {
        context = await resolveUserTimelineContext(page, kwargs.username, { allowLoggedInDefault: true });
      } catch (error) {
        const raw = String(kwargs.username ?? "").trim();
        const fallbackUsername = normalizeTwitterScreenName(raw);
        if (!fallbackUsername) throw error;
        await page.goto(`https://x.com/${fallbackUsername}`, { waitUntil: "load", settleMs: 2e3 });
        await page.wait(3);
        const seen = /* @__PURE__ */ new Set();
        const fallbackRows = await parseVisibleTweetRows(page, seen, limit);
        if (fallbackRows.length === 0) throw error;
        return applyTopByEngagement(fallbackRows.slice(0, limit), kwargs["top-by-engagement"]);
      }
      const { username } = context;
      const seen = /* @__PURE__ */ new Set();
      const all = [];
      let cursor = null;
      for (let i = 0; i < MAX_USER_TWEETS_PAGES && all.length < limit; i++) {
        if (i > 0 && pageDelaySeconds > 0) {
          await page.wait(pageDelaySeconds);
        }
        const fetchCount = Math.min(USER_TWEETS_PAGE_SIZE, limit - all.length + 10);
        const data = await fetchUserTimelinePage(page, context, cursor, fetchCount);
        if (data?.error) {
          if (all.length === 0) throw new CommandExecutionError(describeTwitterApiError("UserTweets", data.error));
          break;
        }
        const { tweets, nextCursor } = parseUserTweets(data, seen);
        all.push(...tweets);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      if (all.length === 0) {
        await page.goto(`https://x.com/${username}`, { waitUntil: "load", settleMs: 2e3 });
        await page.wait(3);
        const fallbackRows = await parseVisibleTweetRows(page, seen, limit);
        if (fallbackRows.length > 0) {
          return applyTopByEngagement(fallbackRows.slice(0, limit), kwargs["top-by-engagement"]);
        }
        throw new EmptyResultError(`@${username} has no recent tweets`, "Account may be private, suspended, hidden by verification, or the page structure may have changed");
      }
      return applyTopByEngagement(all.slice(0, limit), kwargs["top-by-engagement"]);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/unblock.js
  cli({
    site: "twitter",
    name: "unblock",
    access: "write",
    description: "Unblock a Twitter user",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, required: true, help: "Twitter screen name (without @)" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter unblock");
      const username = kwargs.username.replace(/^@/, "");
      await page.goto(`https://x.com/${username}`);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            let attempts = 0;
            let unblockBtn = null;
            const getPrimary = () => document.querySelector('[data-testid="primaryColumn"]');
            if (!getPrimary()) {
                return { ok: false, message: 'Could not find profile surface. Are you logged in?' };
            }

            while (attempts < 20) {
                const primary = getPrimary();
                if (!primary) {
                    return { ok: false, message: 'Could not find profile surface. Are you logged in?' };
                }
                // Check if not blocked (follow button visible means not blocked)
                const followBtn = primary.querySelector('[data-testid$="-follow"]');
                if (followBtn) {
                    return { ok: true, message: 'Not blocking @${username} (already unblocked).' };
                }

                unblockBtn = primary.querySelector('[data-testid$="-unblock"]');
                if (unblockBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!unblockBtn) {
                return { ok: false, message: 'Could not find Unblock button. Are you logged in?' };
            }

            // Click the unblock button \u2014 this opens a confirmation dialog
            unblockBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Confirm the unblock in the dialog
            const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
            if (!confirmBtn) {
                return { ok: false, message: 'Unblock confirmation dialog did not appear.' };
            }
            writeStarted = true;
            confirmBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify
            const verify = getPrimary()?.querySelector('[data-testid$="-follow"]');
            if (verify) {
                return { ok: true, message: 'Successfully unblocked @${username}.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Unblock action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter unblock confirmation", 1, `${result.message} Check the profile before retrying; the unblock may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the profile in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/unbookmark.js
  cli({
    site: "twitter",
    name: "unbookmark",
    access: "write",
    description: "Remove a tweet from bookmarks",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", positional: true, required: true, help: "Tweet URL to unbookmark" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter unbookmark");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            let attempts = 0;
            let removeBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                // Check if not bookmarked (already removed)
                const bookmarkBtn = targetArticle?.querySelector('[data-testid="bookmark"]');
                if (bookmarkBtn) {
                    return { ok: true, message: 'Tweet is not bookmarked (already removed).' };
                }

                removeBtn = targetArticle?.querySelector('[data-testid="removeBookmark"]') || null;
                if (removeBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!removeBtn) {
                return { ok: false, message: 'Could not find Remove Bookmark button on the requested tweet. Are you logged in?' };
            }

            writeStarted = true;
            removeBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify
            const verifyArticle = findTargetArticle() || targetArticle;
            const verify = verifyArticle?.querySelector('[data-testid="bookmark"]');
            if (verify) {
                return { ok: true, message: 'Tweet successfully removed from bookmarks.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Unbookmark action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter unbookmark confirmation", 1, `${result.message} Check the tweet before retrying; the removal may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/unfollow.js
  cli({
    site: "twitter",
    name: "unfollow",
    access: "write",
    description: "Unfollow a Twitter user",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "username", type: "string", positional: true, required: true, help: "Twitter screen name (without @)" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter unfollow");
      const username = kwargs.username.replace(/^@/, "");
      await page.goto(`https://x.com/${username}`);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            let attempts = 0;
            let unfollowBtn = null;

            while (attempts < 20) {
                // Check if already not following
                const followBtn = document.querySelector('[data-testid$="-follow"]');
                if (followBtn) {
                    return { ok: true, message: 'Not following @${username} (already unfollowed).' };
                }

                unfollowBtn = document.querySelector('[data-testid$="-unfollow"]');
                if (unfollowBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!unfollowBtn) {
                return { ok: false, message: 'Could not find Unfollow button. Are you logged in?' };
            }

            // Click the unfollow button \u2014 this opens a confirmation dialog
            unfollowBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Confirm the unfollow in the dialog
            const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
            if (!confirmBtn) {
                return { ok: false, message: 'Unfollow confirmation dialog did not appear.' };
            }
            writeStarted = true;
            confirmBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify
            const verify = document.querySelector('[data-testid$="-follow"]');
            if (verify) {
                return { ok: true, message: 'Successfully unfollowed @${username}.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Unfollow action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter unfollow confirmation", 1, `${result.message} Check the profile before retrying; the unfollow may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the profile in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/unlike.js
  cli({
    site: "twitter",
    name: "unlike",
    access: "write",
    description: "Remove a like from a specific tweet",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to unlike" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter unlike");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            // Poll for the tweet to render. State probes scoped to the article
            // matching the requested status id \u2014 bare querySelector on a
            // conversation page would silently grab the first article (e.g.
            // the parent tweet) and unlike the wrong one.
            let attempts = 0;
            let likeBtn = null;
            let unlikeBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                likeBtn = targetArticle?.querySelector('[data-testid="like"]') || null;
                unlikeBtn = targetArticle?.querySelector('[data-testid="unlike"]') || null;

                if (likeBtn || unlikeBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            // Check if it's already not liked
            if (likeBtn) {
                return { ok: true, message: 'Tweet is not liked (already unliked).' };
            }

            if (!unlikeBtn) {
                return { ok: false, message: 'Could not find the Unlike button on this tweet after waiting 10 seconds. Are you logged in?' };
            }

            // Click Unlike
            writeStarted = true;
            unlikeBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify success by checking if the 'like' button reappeared
            const verifyArticle = findTargetArticle() || targetArticle;
            const verifyBtn = verifyArticle?.querySelector('[data-testid="like"]');
            if (verifyBtn) {
                return { ok: true, message: 'Tweet successfully unliked.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Unlike action was initiated but UI did not update as expected.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter unlike confirmation", 1, `${result.message} Check the tweet before retrying; the unlike may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/twitter/unretweet.js
  cli({
    site: "twitter",
    name: "unretweet",
    access: "write",
    description: "Undo a retweet on a specific tweet",
    domain: "x.com",
    strategy: Strategy.UI,
    browser: true,
    args: [
      { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to unretweet" }
    ],
    columns: ["status", "message"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser session required for twitter unretweet");
      const target = parseTweetUrl(kwargs.url);
      await page.goto(target.url);
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const result = await page.evaluate(`(async () => {
        let writeStarted = false;
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            // Poll for the tweet to render. State probes scoped to the article
            // matching the requested status id \u2014 bare querySelector on a
            // conversation page would silently grab the first article (e.g.
            // the parent tweet) and unretweet the wrong one.
            let attempts = 0;
            let retweetBtn = null;
            let unretweetBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                retweetBtn = targetArticle?.querySelector('[data-testid="retweet"]') || null;
                unretweetBtn = targetArticle?.querySelector('[data-testid="unretweet"]') || null;

                if (retweetBtn || unretweetBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            // Already not retweeted: idempotent success
            if (retweetBtn) {
                return { ok: true, message: 'Tweet is not retweeted (already removed).' };
            }

            if (!unretweetBtn) {
                return { ok: false, message: 'Could not find the Unretweet button on this tweet after waiting 10 seconds. Are you logged in?' };
            }

            // Step 1: click Unretweet button \u2192 opens menu
            unretweetBtn.click();

            // Step 2: wait for and click the confirm menu item. The confirm
            // popover renders at the document root, not inside the article,
            // so this lookup is intentionally document-scoped.
            let confirmBtn = null;
            for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 250));
                confirmBtn = document.querySelector('[data-testid="unretweetConfirm"]');
                if (confirmBtn) break;
            }
            if (!confirmBtn) {
                return { ok: false, message: 'Unretweet menu opened but the confirm option did not appear.' };
            }
            writeStarted = true;
            confirmBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify success by checking if the 'retweet' button reappeared
            const verifyArticle = findTargetArticle() || targetArticle;
            const verifyBtn = verifyArticle?.querySelector('[data-testid="retweet"]');
            if (verifyBtn) {
                return { ok: true, message: 'Tweet successfully unretweeted.' };
            } else {
                return { ok: false, unconfirmed: true, message: 'Unretweet action was initiated but UI did not update as expected.' };
            }
        } catch (e) {
            return { ok: false, unconfirmed: writeStarted, message: e.toString() };
        }
    })()`);
      if (result.unconfirmed) {
        throw new TimeoutError("twitter unretweet confirmation", 1, `${result.message} Check the tweet before retrying; the removal may already have succeeded.`);
      }
      if (!result.ok) {
        throw new CommandExecutionError(result.message, "Nothing changed. Open the tweet in the browser and retry.");
      }
      await page.wait(2);
      return [{
        status: "success",
        message: result.message
      }];
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
    twitter: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]
  };
  var domainSuffix = { "1688": ".1688.com" };
  var helper = (action, payload) => window.__webmcpWecliRuntime.requestPrivileged(action, payload);
  var Page = class {
    constructor(command2) {
      this.command = command2;
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
    async evaluate(source, ...args) {
      if (this.pending) throw new CommandExecutionError("Navigation required");
      this.pageEvaluated = true;
      const expression = `(async () => { const result = (${source}); return typeof result === 'function' ? await result(...${JSON.stringify(args)}) : await result; })()`;
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
      await new Promise((resolve2) => setTimeout(resolve2, Math.min(Math.max(Number(seconds) || 0, 0), 10) * 1e3));
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
            await new Promise((resolve2) => setTimeout(resolve2, 250));
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
        await new Promise((resolve2) => setTimeout(resolve2, delayMs));
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
        await new Promise((resolve2) => setTimeout(resolve2, 250));
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
  function normalize(command2, input) {
    const args = { ...input };
    for (const spec of command2.args || []) {
      let value = args[spec.name];
      if (value === void 0) value = spec.default;
      if (value === void 0) {
        if (spec.required) throw new ArgumentError(`${spec.name} is required`);
        continue;
      }
      if (spec.type === "int") {
        if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
        const zeroAllowed = value === 0 && (spec.default === 0 || command2.site === 'twitter' && ['tweets', 'collection'].includes(command2.name) && spec.name === 'page-delay');
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
    if (command2.site === "v2ex") {
      if (args.limit !== void 0 && args.limit > 100) throw new ArgumentError("limit must be at most 100");
      if ((command2.name === "topic" || command2.name === "replies") && !/^\d{1,12}$/.test(String(args.id))) throw new ArgumentError("id must be a numeric V2EX topic ID");
      if ((command2.name === "member" || command2.name === "user") && !/^[A-Za-z0-9_.-]{1,32}$/.test(String(args.username))) throw new ArgumentError("Invalid V2EX username");
      if (command2.name === "node" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(args.name))) throw new ArgumentError("Invalid V2EX node name");
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
  async function pipelineFetch(stageParams, args, command2) {
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
    const expect = PIPELINE_EXPECTS[command2.name];
    if (!expect) throw new CommandExecutionError("Command pipeline is not configured");
    if (payload.status === "error") {
      const detail = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim().slice(0, 200) : "The V2EX API reported no matching object";
      throw new EmptyResultError(command2.name, detail);
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
  async function runPipeline(command2, args) {
    const stages = Array.isArray(command2.pipeline) ? command2.pipeline : [];
    if (!stages.length) throw new CommandExecutionError(`Command ${command2.name} has no pipeline`);
    let data = null;
    let fetched = false;
    for (const stage of stages) {
      if (!isRecord(stage)) throw new CommandExecutionError("Invalid pipeline stage");
      for (const [op, params] of Object.entries(stage)) {
        if (op === "fetch") {
          if (fetched) throw new CommandExecutionError("Pipeline fetch must run exactly once");
          fetched = true;
          data = await pipelineFetch(params, args, command2);
        } else if (op === "map") data = pipelineMap(params, data, args);
        else if (op === "sort") data = pipelineSort(params, data);
        else if (op === "limit") data = pipelineLimit(params, data, args);
        else throw new CommandExecutionError(`Unsupported pipeline step: ${op}`);
      }
    }
    if (!fetched) throw new CommandExecutionError("Pipeline did not fetch any data");
    if (!Array.isArray(data)) throw new CommandExecutionError("V2EX API did not produce a row list");
    if (data.length === 0) throw new EmptyResultError(command2.name, "The V2EX API returned no matching entries");
    const expect = PIPELINE_EXPECTS[command2.name];
    if (expect?.requireField) {
      const value = data[0]?.[expect.requireField];
      if (value === null || value === void 0 || value === "") {
        throw new CommandExecutionError(`V2EX API document is missing the ${expect.requireField} field`);
      }
    }
    return data;
  }
  function contextTwitterRow(row, index, commandName) {
    let postId = null;
    const sourceId = commandName === 'download' ? row.tweet_id : commandName === 'notifications' ? null : row.id;
    if (typeof sourceId === 'string' && /^[0-9]+$/.test(sourceId)) postId = sourceId;
    if (!postId && typeof row.url === 'string') {
      try { const url = new URL(row.url); if (url.protocol === 'https:' && ['x.com', 'twitter.com'].includes(url.hostname) && !url.username && !url.password && !url.port) postId = url.pathname.match(/^\/(?:[A-Za-z0-9_]+|i)\/status\/([0-9]+)\/?$/)?.[1] || null; } catch {}
    }
    const author = typeof row.author === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(row.author) ? row.author : null;
    return { ...row, context_ref: index + 1,
      context_title: Array.from(String(row.title || row.text || row.name || row.topic || row.action || row.id || row.url || '').replace(/\s+/g, ' ').trim()).slice(0, 60).join(''),
      context_username: typeof row.screen_name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(row.screen_name) ? row.screen_name : null,
      context_post_id: postId, context_post_url: postId ? 'https://x.com/i/status/' + postId : null, context_author: author };
  }
  async function invoke(key, input = {}) {
    const command2 = commands.get(key);
    if (!command2) throw new ArgumentError("Unknown command");
    const args = normalize(command2, input);
    if (command2.pipeline) return runPipeline(command2, args);
    const page = new Page(command2);
    try {
      if (command2.browser !== false && typeof command2.navigateBefore === "string") await page.goto(command2.navigateBefore);
      const result = command2.browser === false ? await command2.func(args) : await command2.func(page, args);
      if (command2.site !== 'twitter' || command2.access !== 'read') return result;
      if (Array.isArray(result)) return result.map((row, index) => contextTwitterRow(row, index, command2.name));
      if (command2.name === 'collection' && Array.isArray(result?.posts)) return { ...result, posts: result.posts.map((row, index) => contextTwitterRow(row, index, command2.name)) };
      return result;
    } catch (error) {
      if (page.pending) return page.pending;
      throw error;
    }
  }
  return __toCommonJS(stdin_exports);
})();

window.__wave5 = __wave5;
