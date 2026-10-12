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
    const helperAction = url.hostname === "www.v2ex.com" ? "browser_fetch" : "backend_fetch";
    try {
      response = await window.__webmcpWecliRuntime.requestPrivileged(helperAction, {
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

  // webcli/scripts/opencli-wave5/upstream/v2ex/hot.js
  cli({
    site: "v2ex",
    name: "hot",
    access: "read",
    description: "V2EX \u70ED\u95E8\u8BDD\u9898",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of topics" }
    ],
    columns: ["id", "rank", "title", "node", "replies", "url"],
    pipeline: [
      { fetch: { url: "https://www.v2ex.com/api/topics/hot.json" } },
      { map: {
        id: "${{ item.id }}",
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}"
      } },
      { limit: "${{ args.limit }}" }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/latest.js
  cli({
    site: "v2ex",
    name: "latest",
    access: "read",
    description: "V2EX \u6700\u65B0\u8BDD\u9898",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of topics" }
    ],
    columns: ["id", "rank", "title", "node", "replies", "url"],
    pipeline: [
      { fetch: { url: "https://www.v2ex.com/api/topics/latest.json" } },
      { map: {
        id: "${{ item.id }}",
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}"
      } },
      { limit: "${{ args.limit }}" }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/topic.js
  cli({
    site: "v2ex",
    name: "topic",
    access: "read",
    description: "V2EX \u4E3B\u9898\u8BE6\u60C5\u548C\u56DE\u590D",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "id", required: true, positional: true, help: "Topic ID" }
    ],
    columns: ["id", "title", "content", "member", "created", "node", "replies", "url"],
    pipeline: [
      { fetch: {
        url: "https://www.v2ex.com/api/topics/show.json",
        params: { id: "${{ args.id }}" }
      } },
      { map: {
        id: "${{ item.id }}",
        title: "${{ item.title }}",
        content: "${{ item.content }}",
        member: "${{ item.member.username }}",
        created: "${{ item.created }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}"
      } },
      { limit: 1 }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/member.js
  cli({
    site: "v2ex",
    name: "member",
    access: "read",
    description: "V2EX \u7528\u6237\u8D44\u6599",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "username", required: true, positional: true, help: "Username" }
    ],
    columns: ["username", "tagline", "website", "github", "twitter", "location"],
    pipeline: [
      { fetch: {
        url: "https://www.v2ex.com/api/members/show.json",
        params: { username: "${{ args.username }}" }
      } },
      { map: {
        username: "${{ item.username }}",
        tagline: "${{ item.tagline }}",
        website: "${{ item.website }}",
        github: "${{ item.github }}",
        twitter: "${{ item.twitter }}",
        location: "${{ item.location }}"
      } }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/node.js
  cli({
    site: "v2ex",
    name: "node",
    access: "read",
    description: "V2EX \u8282\u70B9\u8BDD\u9898\u5217\u8868",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      {
        name: "name",
        required: true,
        positional: true,
        help: "Node name (e.g. python, javascript, apple)"
      },
      {
        name: "limit",
        type: "int",
        default: 10,
        help: "Number of topics (API returns max 20)"
      }
    ],
    columns: ["rank", "title", "author", "replies", "url"],
    pipeline: [
      { fetch: {
        url: "https://www.v2ex.com/api/topics/show.json",
        params: { node_name: "${{ args.name }}" }
      } },
      { map: {
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        author: "${{ item.member.username }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}"
      } },
      { limit: "${{ args.limit }}" }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/nodes.js
  cli({
    site: "v2ex",
    name: "nodes",
    access: "read",
    description: "V2EX \u6240\u6709\u8282\u70B9\u5217\u8868",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "limit", type: "int", default: 30, help: "Number of nodes" }
    ],
    columns: ["rank", "name", "title", "topics", "stars"],
    pipeline: [
      { fetch: { url: "https://www.v2ex.com/api/nodes/all.json" } },
      { sort: { by: "topics", order: "desc" } },
      { map: {
        rank: "${{ index + 1 }}",
        name: "${{ item.name }}",
        title: "${{ item.title }}",
        topics: "${{ item.topics }}",
        stars: "${{ item.stars }}"
      } },
      { limit: "${{ args.limit }}" }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/replies.js
  cli({
    site: "v2ex",
    name: "replies",
    access: "read",
    description: "V2EX \u4E3B\u9898\u56DE\u590D\u5217\u8868",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "id", required: true, positional: true, help: "Topic ID" },
      { name: "limit", type: "int", default: 20, help: "Number of replies" }
    ],
    columns: ["floor", "author", "content"],
    pipeline: [
      { fetch: {
        url: "https://www.v2ex.com/api/replies/show.json",
        params: { topic_id: "${{ args.id }}" }
      } },
      { map: {
        floor: "${{ index + 1 }}",
        author: "${{ item.member.username }}",
        content: "${{ item.content }}"
      } },
      { limit: "${{ args.limit }}" }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/user.js
  cli({
    site: "v2ex",
    name: "user",
    access: "read",
    description: "V2EX \u7528\u6237\u53D1\u5E16\u5217\u8868",
    domain: "www.v2ex.com",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "username", required: true, positional: true, help: "Username" },
      {
        name: "limit",
        type: "int",
        default: 10,
        help: "Number of topics (API returns max 20)"
      }
    ],
    columns: ["rank", "title", "node", "replies", "url"],
    pipeline: [
      { fetch: {
        url: "https://www.v2ex.com/api/topics/show.json",
        params: { username: "${{ args.username }}" }
      } },
      { map: {
        rank: "${{ index + 1 }}",
        title: "${{ item.title }}",
        node: "${{ item.node.title }}",
        replies: "${{ item.replies }}",
        url: "${{ item.url }}"
      } },
      { limit: "${{ args.limit }}" }
    ]
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/me.js
  cli({
    site: "v2ex",
    name: "me",
    access: "read",
    description: "V2EX \u83B7\u53D6\u4E2A\u4EBA\u8D44\u6599 (\u4F59\u989D/\u672A\u8BFB\u63D0\u9192)",
    domain: "www.v2ex.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [],
    columns: ["username", "balance", "unread_notifications", "daily_reward_ready"],
    func: async (page) => {
      if (!page)
        throw new CommandExecutionError("Browser page required");
      if (void 0) {
        console.error("[opencli:v2ex] Navigating to /");
      }
      await page.goto("https://www.v2ex.com/");
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const title = await page.evaluate(`() => document.title`);
        if (!title?.includes("Just a moment"))
          break;
        if (void 0)
          console.error("[opencli:v2ex] Waiting for Cloudflare...");
      }
      const data = await page.evaluate(`
      async () => {
        if (document.title.includes('Just a moment')) {
          return { error: 'Cloudflare verification is still active on V2EX; retry after it completes' };
        }
        let username = 'Unknown';
        const navLinks = Array.from(document.querySelectorAll('a.top')).map(a => a.textContent?.trim());
        if (navLinks.length > 1 && navLinks[0] === '\u9996\u9875') {
          username = navLinks[1] || 'Unknown';
        }
        // wave5: removed the upstream fallback that read the first /member/ link \u2014
        // on the anonymous home page that link belongs to another author.

        let balance = '';
        const balanceLink = document.querySelector('a.balance_area');
        if (balanceLink) {
          balance = Array.from(balanceLink.childNodes)
                         .filter(n => n.nodeType === 3)
                         .map(n => n.textContent?.trim())
                         .join(' ')
                         .trim();
        }

        let unread_notifications = '';
        const notesEl = document.querySelector('a[href="/notifications"]');
        if (notesEl) {
          const text = notesEl.textContent?.trim() || '';
          const match = text.match(/(\\d+)\\s*\u672A\u8BFB\u63D0\u9192/);
          if (match) {
            unread_notifications = match[1];
          }
        }

        let daily_reward_ready = false;
        const dailyEl = document.querySelector('a[href^="/mission/daily"]');
        if (dailyEl && dailyEl.textContent?.includes('\u9886\u53D6\u4ECA\u65E5\u7684\u767B\u5F55\u5956\u52B1')) {
          daily_reward_ready = true;
        }

        if (username === 'Unknown') {
          return { 
            error: '\u8BF7\u5148\u767B\u5F55 V2EX\uFF08\u53EF\u80FD\u662F Cookie \u672A\u914D\u7F6E\u6216\u5DF2\u5931\u6548\uFF09',
            debug_title: document.title,
            debug_body: document.body.innerText.substring(0, 200).replace(/\\n/g, ' ')
          };
        }

        return {
          username,
          balance,
          unread_notifications,
          daily_reward_ready: daily_reward_ready ? '\u662F' : '\u5426'
        };
      }
    `);
      if (data.error) {
        if (void 0) {
          console.error(`[opencli:v2ex:debug] Page Title: ${data.debug_title}`);
          console.error(`[opencli:v2ex:debug] Page Body: ${data.debug_body}`);
        }
        throw new CommandExecutionError(data.error);
      }
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(String(data.username || ""))) {
        throw new CommandExecutionError("\u672A\u80FD\u8BC6\u522B V2EX \u767B\u5F55\u8EAB\u4EFD\uFF1B\u8BF7\u5148\u767B\u5F55\uFF08\u53EF\u8C03\u7528 login \u6253\u5F00\u767B\u5F55\u9875\uFF09\u6216\u7A0D\u540E\u91CD\u8BD5");
      }
      return [data];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/notifications.js
  cli({
    site: "v2ex",
    name: "notifications",
    access: "read",
    description: "V2EX \u83B7\u53D6\u63D0\u9192 (\u56DE\u590D/\u7531\u4E8E)",
    domain: "www.v2ex.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of notifications" }
    ],
    columns: ["type", "content", "time"],
    func: async (page, kwargs) => {
      if (!page)
        throw new CommandExecutionError("Browser page required");
      if (void 0) {
        console.error("[opencli:v2ex] Navigating to /notifications");
      }
      await page.goto("https://www.v2ex.com/notifications");
      await new Promise((r) => setTimeout(r, 1500));
      const data = await page.evaluate(`
      async () => {
        if (document.title.includes('Just a moment')) {
          return { error: 'Cloudflare verification is still active on V2EX; retry after it completes' };
        }
        // wave5: never report an empty list from a redirected or unrecognized page.
        if (!location.pathname.startsWith('/notifications')) {
          return { error: 'V2EX notifications page redirected to ' + location.pathname + '; login may be required' };
        }
        if (!document.querySelector('#Main .box')) {
          return { error: 'V2EX notifications structure not recognized; refusing to report an empty list' };
        }
        const items = Array.from(document.querySelectorAll('#Main .box .cell[id^="n_"]'));
        return items.map(item => {
          let type = '\u901A\u77E5';
          let time = '';
          
          // determine type based on text content
          const text = item.textContent || '';
          if (text.includes('\u56DE\u590D\u4E86\u4F60')) type = '\u56DE\u590D';
          else if (text.includes('\u611F\u8C22\u4E86\u4F60')) type = '\u611F\u8C22';
          else if (text.includes('\u6536\u85CF\u4E86\u4F60')) type = '\u6536\u85CF';
          else if (text.includes('\u63D0\u53CA\u4F60')) type = '\u63D0\u53CA';

          const timeEl = item.querySelector('.snow');
          if (timeEl) {
            time = timeEl.textContent?.trim() || '';
          }

          // payload contains the actual reply text if any
          let payload = '';
          const payloadEl = item.querySelector('.payload');
          if (payloadEl) {
            payload = payloadEl.textContent?.trim() || '';
          }

          // fallback to full text cleaning if no payload (e.g. for favorites/thanks)
          let content = payload;
          if (!content) {
            content = text.replace(/\\s+/g, ' ').trim();
            // strip out time from content if present
            if (time && content.includes(time)) {
              content = content.replace(time, '').trim();
            }
          }

          return { type, content, time };
        });
      }
    `);
      if (!Array.isArray(data)) {
        if (data && typeof data === "object" && data.error)
          throw new CommandExecutionError(String(data.error));
        throw new CommandExecutionError("Failed to parse notifications data");
      }
      const limit = kwargs.limit || 20;
      return data.slice(0, limit);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/v2ex/daily.js
  cli({
    site: "v2ex",
    name: "daily",
    access: "write",
    description: "V2EX \u6BCF\u65E5\u7B7E\u5230\u5E76\u9886\u53D6\u94DC\u5E01",
    domain: "www.v2ex.com",
    strategy: Strategy.COOKIE,
    browser: true,
    args: [],
    columns: ["status", "message"],
    func: async (page) => {
      if (!page)
        throw new CommandExecutionError("Browser page required");
      if (void 0) {
        console.error("[opencli:v2ex] Navigating to /mission/daily");
      }
      await page.goto("https://www.v2ex.com/mission/daily");
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const title = await page.evaluate(`() => document.title`);
        if (!title?.includes("Just a moment"))
          break;
        if (void 0)
          console.error("[opencli:v2ex] Waiting for Cloudflare...");
      }
      const checkResult = await page.evaluate(`
      async () => {
        if (location.pathname !== '/mission/daily') {
          return { error: 'V2EX daily mission page is not open (redirected to ' + location.pathname + '); login may be required' };
        }
        if (document.title.includes('Just a moment')) {
          return { error: 'Cloudflare verification is still active on V2EX; retry after it completes' };
        }
        const btn = document.querySelector('input.super.normal.button');
        if (!btn || !btn.value.includes('\u9886\u53D6')) {
          return { claimed: true, message: '\u4ECA\u65E5\u5956\u52B1\u5DF2\u53D1/\u65E0\u9700\u9886\u53D6' };
        }
        
        const onclick = btn.getAttribute('onclick');
        if (onclick) {
          const match = onclick.match(/once=(\\d+)/);
          if (match) {
            return { claimed: false, once: match[1], message: btn.value };
          }
        }
        
        return { 
          claimed: false, 
          error: '\u627E\u5230\u4E86\u6309\u94AE\uFF0C\u4F46\u672A\u80FD\u63D0\u53D6 once token',
          debug_title: document.title,
          debug_body: document.body.innerText.substring(0, 200).replace(/\\n/g, ' ')
        };
      }
    `);
      if (checkResult.error) {
        if (void 0) {
          console.error(`[opencli:v2ex:debug] Page Title: ${checkResult.debug_title}`);
          console.error(`[opencli:v2ex:debug] Page Body: ${checkResult.debug_body}`);
        }
        throw new CommandExecutionError(checkResult.error);
      }
      if (checkResult.claimed) {
        return [{ status: "\u2705 \u5DF2\u7B7E\u5230", message: checkResult.message }];
      }
      if (void 0) {
        console.error(`[opencli:v2ex] Found check-in token: once=${checkResult.once}. Checking in...`);
      }
      if (!/^\d+$/.test(String(checkResult.once || ""))) {
        throw new CommandExecutionError("V2EX daily once token was not numeric");
      }
      const verifyResult = await page.evaluate(`
      async () => {
        const response = await fetch('/mission/daily/redeem?once=${checkResult.once}', { credentials: 'same-origin' });
        if (!response.ok) return { success: false, httpStatus: response.status };
        const html = await response.text();
        if (html.includes('Just a moment')) return { success: false, challenge: true };
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const btn = doc.querySelector('input.super.normal.button');
        if (btn && btn.value.includes('\u9886\u53D6')) return { success: false };
        let balance = '';
        const balanceLink = doc.querySelector('a.balance_area');
        if (balanceLink) {
          balance = Array.from(balanceLink.childNodes)
                         .filter(n => n.nodeType === 3)
                         .map(n => n.textContent?.trim())
                         .join(' ')
                         .trim();
        }
        return { success: true, balance };
      }
    `);
      if (verifyResult.success) {
        return [{ status: "\u{1F389} \u7B7E\u5230\u6210\u529F", message: `\u5F53\u524D\u4F59\u989D: ${verifyResult.balance || "\u672A\u77E5"}` }];
      }
      if (verifyResult.challenge) {
        throw new CommandExecutionError("Cloudflare verification interrupted the V2EX daily claim; retry after it completes");
      }
      if (verifyResult.httpStatus) {
        throw new CommandExecutionError(`V2EX daily claim failed with HTTP ${verifyResult.httpStatus}`);
      }
      return [{ status: "\u274C \u7B7E\u5230\u5931\u8D25", message: "\u672A\u80FD\u786E\u8BA4\u7B7E\u5230\u7ED3\u679C\uFF0C\u8BF7\u624B\u52A8\u68C0\u67E5" }];
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

  // webcli/scripts/opencli-wave5/upstream/v2ex/auth.js
  async function hasV2exAuthCookie(page) {
    const cookies = await page.getCookies({ url: "https://www.v2ex.com" });
    return cookies.some((c) => c.name === "A2" && c.value);
  }
  async function verifyV2exIdentity(page) {
    if (!await hasV2exAuthCookie(page)) {
      throw new AuthRequiredError("v2ex.com", "V2EX A2 session cookie missing \u2014 anonymous");
    }
    await page.goto("https://www.v2ex.com/");
    await page.wait(1);
    const probe = await page.evaluate(`
    (() => {
      const link = document.querySelector('#Top a[href^="/member/"]');
      if (!link) return { kind: 'auth', detail: 'V2EX top bar has no member link \u2014 anonymous session' };
      const href = link.getAttribute('href') || '';
      const username = (link.innerText || href.replace('/member/', '')).trim();
      if (!username) return { kind: 'auth', detail: 'V2EX member link present but username empty' };
      return { ok: true, username };
    })()
  `);
    if (probe?.kind === "auth") throw new AuthRequiredError("v2ex.com", probe.detail);
    if (!probe?.ok) throw new CommandExecutionError(`Unexpected V2EX probe: ${JSON.stringify(probe)}`);
    return { username: probe.username };
  }
  registerSiteAuthCommands({
    site: "v2ex",
    domain: "v2ex.com",
    loginUrl: "https://www.v2ex.com/signin",
    columns: ["username"],
    quickCheck: hasV2exAuthCookie,
    verify: verifyV2exIdentity,
    poll: async (page) => {
      if (!await hasV2exAuthCookie(page)) {
        throw new AuthRequiredError("v2ex.com", "Waiting for V2EX A2 session cookie");
      }
      return verifyV2exIdentity(page);
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
