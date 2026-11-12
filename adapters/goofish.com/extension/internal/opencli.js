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
  function selectorError(selector, hint) {
    return new CliError("SELECTOR", `Could not find element: ${selector}`, hint || "The page UI may have changed. Please report this issue.");
  }

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

  // webcli/scripts/opencli-wave5/upstream/xianyu/auth.js
  async function hasXianyuIdentityCookie(page) {
    const cookies = await page.getCookies({ url: "https://www.goofish.com" });
    return cookies.some((c) => (c.name === "unb" || c.name === "tracknick") && c.value);
  }
  async function verifyXianyuIdentity(page) {
    if (!await hasXianyuIdentityCookie(page)) {
      throw new AuthRequiredError("goofish.com", "Xianyu unb/tracknick cookie missing \u2014 anonymous");
    }
    await page.goto("https://www.goofish.com/personal");
    await page.wait(2);
    const finalUrl = await page.evaluate(`location.href`);
    if (/passport\.(taobao|goofish)\.com\/(member\/login|login)/.test(String(finalUrl || ""))) {
      throw new AuthRequiredError("goofish.com", `Xianyu /personal redirected to login: ${finalUrl}`);
    }
    const cookies = await page.getCookies({ url: "https://www.goofish.com" });
    const tracknick = cookies.find((c) => c.name === "tracknick")?.value || "";
    const unb = cookies.find((c) => c.name === "unb")?.value || "";
    const probe = await page.evaluate(`
    (() => {
      const bodyText = document.body?.innerText || '';
      const requiresAuth = /\u8BF7\u5148\u767B\u5F55|\u767B\u5F55\u540E/.test(bodyText);
      const blocked = /\u9A8C\u8BC1\u7801|\u5B89\u5168\u9A8C\u8BC1|\u5F02\u5E38\u8BBF\u95EE/.test(bodyText);
      const nick = document.querySelector('.user-name, .user-nick, .nick, [class*="nickname"]')?.innerText?.trim() || '';
      const html = document.body?.innerHTML || '';
      const userIdMatch = html.match(/['"]?userId['"]?\\s*[:=]\\s*['"]?(\\d+)/i);
      return { requiresAuth, blocked, domNick: nick, domUserId: userIdMatch?.[1] || '' };
    })()
  `);
    if (probe.blocked) {
      throw new AuthRequiredError("goofish.com", "Xianyu blocked by verification / risk control");
    }
    if (probe.requiresAuth) {
      throw new AuthRequiredError("goofish.com", "Xianyu /personal shows login prompt \u2014 anonymous");
    }
    const userId = probe.domUserId || unb;
    let decodedTracknick = "";
    if (tracknick) {
      try {
        decodedTracknick = JSON.parse('"' + tracknick.replace(/\\/g, "\\\\") + '"');
      } catch {
        decodedTracknick = tracknick;
      }
    }
    const nickname = probe.domNick || decodedTracknick;
    if (!userId && !nickname) {
      throw new CommandExecutionError("Xianyu /personal rendered but no user identity extractable \u2014 stale unb or layout drift");
    }
    return { user_id: String(userId), nickname: String(nickname) };
  }
  registerSiteAuthCommands({
    site: "xianyu",
    domain: "goofish.com",
    loginUrl: "https://www.goofish.com/login",
    columns: ["user_id", "nickname"],
    quickCheck: hasXianyuIdentityCookie,
    verify: verifyXianyuIdentity,
    poll: async (page) => {
      if (!await hasXianyuIdentityCookie(page)) {
        throw new AuthRequiredError("goofish.com", "Waiting for Xianyu unb/tracknick cookie");
      }
      return verifyXianyuIdentity(page);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/im.js
  var DEFAULT_INBOX_LIMIT = 20;
  var MAX_INBOX_LIMIT = 100;
  var DEFAULT_MESSAGE_LIMIT = 50;
  var MAX_MESSAGE_LIMIT = 200;
  function normalizeLimit(value, defaultValue = DEFAULT_INBOX_LIMIT, maxValue = MAX_INBOX_LIMIT, label = "limit") {
    const raw = String(value ?? "").trim();
    if (!raw) return defaultValue;
    if (!/^\d+$/.test(raw)) {
      throw new ArgumentError(`xianyu ${label} must be an integer between 1 and ${maxValue}`);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > maxValue) {
      throw new ArgumentError(`xianyu ${label} must be an integer between 1 and ${maxValue}`);
    }
    return n;
  }
  function normalizeRank(value) {
    const raw = String(value ?? "").trim();
    if (!raw || raw === "0") return 0;
    if (!/^\d+$/.test(raw)) {
      throw new ArgumentError("xianyu rank must be a positive integer from xianyu inbox");
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new ArgumentError("xianyu rank must be a positive integer from xianyu inbox");
    }
    return n;
  }
  function requireText(value, label) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) {
      throw new ArgumentError(`${label} cannot be empty`);
    }
    return text;
  }
  function requireEvaluateObject(payload, label) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CommandExecutionError(`Xianyu ${label} returned malformed browser payload`);
    }
    return payload;
  }
  function requireClickResult(payload, label) {
    const result = requireEvaluateObject(payload, label);
    if (result.ok !== true) {
      throw new CommandExecutionError(`Xianyu ${label} failed: ${result.reason || "unknown-reason"}`);
    }
    return result;
  }
  function buildChatUrl(itemId, peerUserId) {
    return `https://www.goofish.com/im?itemId=${encodeURIComponent(itemId)}&peerUserId=${encodeURIComponent(peerUserId)}`;
  }
  function buildInboxUrl() {
    return "https://www.goofish.com/im";
  }
  function buildClickInboxConversationEvaluate(index) {
    return `
    (() => {
      const rows = Array.from(document.querySelectorAll('#conv-list-scrollable [class*="conversation-item"], a[href*="/im"], a[href*="itemId="][href*="peerUserId="]'));
      const row = rows[${index}];
      if (!row) return { ok: false, reason: 'row-not-found' };
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      row.click();
      row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      return { ok: true };
    })()
  `;
  }
  function buildReadCurrentConversationUrlEvaluate() {
    return `
    (() => {
      const url = location.href || '';
      const params = new URL(url).searchParams;
      return {
        url,
        item_id: params.get('itemId') || '',
        peer_user_id: params.get('peerUserId') || '',
      };
    })()
  `;
  }
  function buildExtractInboxEvaluate(limit) {
    return `
    (() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const bodyText = document.body?.innerText || '';
      const requiresAuth = /\u8BF7\u5148\u767B\u5F55|\u767B\u5F55\u540E|\u7487\u5CF0\u539B\u9427\u8BF2\u7D8D|\u9427\u8BF2\u7D8D\u935A?/.test(bodyText);
      const blocked = /\u9A8C\u8BC1\u7801|\u5B89\u5168\u9A8C\u8BC1|\u5F02\u5E38\u8BBF\u95EE|\u6960\u5C83\u7609\u942E\u4E85\u7039\u590A\u53CF\u6960\u5C83\u7609|\u5BEE\u509A\u7236\u7481\u5757\u68F6/.test(bodyText);

      const absoluteUrl = (url) => {
        try {
          return new URL(url, location.href).href;
        } catch {
          return '';
        }
      };

      const readId = (url, key) => {
        try {
          return new URL(url, location.href).searchParams.get(key) || '';
        } catch {
          const match = String(url || '').match(new RegExp('[?&]' + key + '=(\\\\d+)'));
          return match ? match[1] : '';
        }
      };

      const pick = (root, selectors) => {
        for (const selector of selectors) {
          const node = root.querySelector(selector);
          const text = clean(node?.getAttribute?.('title') || node?.textContent || '');
          if (text) return text;
        }
        return '';
      };

      const leafTexts = (root) => Array.from(root.querySelectorAll('div, span'))
        .filter((node) => !Array.from(node.children || []).some((child) => ['DIV', 'SPAN'].includes(child.tagName)))
        .map((node) => clean(node.textContent || ''))
        .filter(Boolean);

      const looksLikeTime = (text) => /^(\u521A\u521A|\\d+\u5206\u949F\u524D|\\d+\u5C0F\u65F6\u524D|\\d+\u5929\u524D|\u6628\u5929|\u524D\u5929|\\d{1,2}:\\d{2}|\\d{4}-\\d{1,2}-\\d{1,2})$/.test(text);

      const links = Array.from(document.querySelectorAll('a[href*="/im"], a[href*="itemId="][href*="peerUserId="]'));
      const seen = new Set();
      const items = [];
      for (const link of links) {
        const href = link.href || link.getAttribute('href') || '';
        const itemId = readId(href, 'itemId');
        const peerUserId = readId(href, 'peerUserId');
        if (!itemId || !peerUserId) continue;
        const key = itemId + ':' + peerUserId;
        if (seen.has(key)) continue;
        seen.add(key);

        const root = link.closest('[class*="conversation"], [class*="session"], [class*="contact"], [class*="chat"], li, [role="listitem"]') || link;
        const peerName = pick(root, ['[class*="name"]', '[class*="nick"]', '[class*="user"]', '[class*="text1"]']);
        const itemTitle = pick(root, ['[class*="title"]', '[class*="item"] [class*="desc"]', '[class*="desc"]']);
        const price = pick(root, ['[class*="money"]', '[class*="price"]']);
        const lastMessage = pick(root, ['[class*="message"]', '[class*="msg"]', '[class*="content"]', '[class*="summary"]']);
        const rootText = clean(root.textContent || '');
        const unreadText = pick(root, ['[class*="badge"]', '[class*="unread"]', '[class*="red"]']);
        const unreadCount = Number.parseInt(unreadText.replace(/\\D/g, ''), 10) || (unreadText ? 1 : 0);

        items.push({
          row_index: items.length,
          peer_name: peerName,
          peer_user_id: peerUserId,
          item_id: itemId,
          item_title: itemTitle,
          price,
          last_message: lastMessage || rootText,
          unread: unreadCount > 0 || /unread|\u672A\u8BFB/.test(String(root.className || '') + ' ' + rootText),
          unread_count: unreadCount,
          url: absoluteUrl(href),
        });
        if (items.length >= ${limit}) break;
      }

      if (!items.length) {
        const rows = Array.from(document.querySelectorAll('#conv-list-scrollable [class*="conversation-item"]')).slice(0, ${limit});
        for (const row of rows) {
          const texts = leafTexts(row)
            .filter((text) => !/^\\d+$/.test(text) || row.querySelector('sup[title="' + text.replace(/"/g, '\\"') + '"]') == null);
          const time = [...texts].reverse().find(looksLikeTime) || '';
          const unreadTitle = clean(row.querySelector('sup')?.getAttribute('title') || row.querySelector('[class*="badge"], [class*="unread"]')?.textContent || '');
          const unreadCount = Number.parseInt(unreadTitle.replace(/\\D/g, ''), 10) || (unreadTitle ? 1 : 0);
          const peerName = texts.find((text) => text !== time && text !== unreadTitle && !/^\\[.*\\]$/.test(text)) || '';
          const lastMessage = texts.find((text) => text !== peerName && text !== time && text !== unreadTitle) || '';
          if (!peerName && !lastMessage) continue;
          items.push({
            row_index: items.length,
            peer_name: peerName,
            peer_user_id: '',
            item_id: '',
            item_title: '',
            price: '',
            last_message: lastMessage,
            unread: unreadCount > 0,
            unread_count: unreadCount,
            url: '',
            time,
          });
          if (items.length >= ${limit}) break;
        }
      }

      return { requiresAuth, blocked, empty: !items.length, items };
    })()
  `;
  }
  function buildExtractChatStateEvaluate(limit = DEFAULT_MESSAGE_LIMIT) {
    return `
    (() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const bodyText = document.body?.innerText || '';
      const requiresAuth = /\u8BF7\u5148\u767B\u5F55|\u767B\u5F55\u540E|\u7487\u5CF0\u539B\u9427\u8BF2\u7D8D|\u9427\u8BF2\u7D8D\u935A?/.test(bodyText);

      const textarea = document.querySelector('textarea');
      const normalizeBtn = (s) => String(s || '').replace(/\\s+/g, '').trim();
      const sendButton = Array.from(document.querySelectorAll('button'))
        .find((btn) => /^(\u53D1\u9001|\u9359\u6226\u20AC?)$/.test(normalizeBtn(btn.textContent || '')));
      const topbar = document.querySelector('[class*="message-topbar"]');
      const itemCard = Array.from(document.querySelectorAll('a[href*="/item?id="]'))
        .find((el) => el.closest('main')) || document.querySelector('a[href*="/item?id="]');
      const itemTitleNode =
        document.querySelector('[class*="container"] [class*="title"]')
        || document.querySelector('[class*="item-main-info"] [class*="desc"]')
        || document.querySelector('[class*="headSkuInfo"]')
        || itemCard?.querySelector('[class*="title"]')
        || itemCard?.previousElementSibling?.querySelector?.('[class*="title"]');

      const messageRoot = document.querySelector('#message-list-scrollable') || document.querySelector('[class*="message-list"]');
      let visibleMessages = Array.from((messageRoot || document).querySelectorAll('[class*="message-row"]'))
        .map((row) => {
          const textNode = row.querySelector('[class*="message-text"]');
          return clean(textNode?.textContent || '');
        })
        .filter(Boolean);

      if (!visibleMessages.length) {
        visibleMessages = Array.from(
          (messageRoot || document).querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"]')
        ).map((el) => clean(el.textContent || ''));
      }

      visibleMessages = visibleMessages
        .filter(Boolean)
        .filter((text) => !['\u53D1\u9001', '\u95F2\u9C7C\u53F7', '\u7ACB\u5373\u8D2D\u4E70', '\u9359\u6226\u20AC?', '\u95C2\u67E5\u5954\u9359?', '\u7ED4\u5B2A\u5D46\u7490\uE15D\u62F1'].includes(text))
        .filter((text) => !/^\u6D88\u606F\\d*\\+?$/.test(text) && !/^\u5A11\u581F\u4F05\\d*\\+?$/.test(text))
        .slice(-${limit});

      return {
        requiresAuth,
        title: clean(document.title || ''),
        peer_name: clean(topbar?.querySelector('[class*="text1"]')?.textContent || ''),
        peer_masked_id: clean(topbar?.querySelector('[class*="text2"]')?.textContent || '').replace(/^\\(|\\)$/g, ''),
        item_title: clean(itemTitleNode?.textContent || ''),
        item_url: itemCard?.href || '',
        price: clean(itemCard?.querySelector('[class*="money"], [class*="price"]')?.textContent || ''),
        location: clean(itemCard?.querySelector('[class*="delivery"] + [class*="delivery"], [class*="delivery"]:last-child')?.textContent || ''),
        can_input: Boolean(textarea && !textarea.disabled),
        can_send: Boolean(sendButton),
        visible_messages: visibleMessages,
        messages: visibleMessages.map((text, index) => ({ index: index + 1, text })),
      };
    })()
  `;
  }
  function buildSendMessageEvaluate(text) {
    return `
    (async () => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const readMessages = () => {
        const messageRoot = document.querySelector('#message-list-scrollable') || document.querySelector('[class*="message-list"]');
        let messages = Array.from((messageRoot || document).querySelectorAll('[class*="message-row"]'))
          .map((row) => clean(row.querySelector('[class*="message-text"]')?.textContent || ''))
          .filter(Boolean);
        if (!messages.length) {
          messages = Array.from(
            (messageRoot || document).querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"]')
          ).map((el) => clean(el.textContent || '')).filter(Boolean);
        }
        return messages
          .filter((item) => !['\u53D1\u9001', '\u95F2\u9C7C\u53F7', '\u7ACB\u5373\u8D2D\u4E70', '\u9359\u6226\u20AC?', '\u95C2\u67E5\u5954\u9359?', '\u7ED4\u5B2A\u5D46\u7490\uE15D\u62F1'].includes(item))
          .filter((item) => !/^\u6D88\u606F\\d*\\+?$/.test(item) && !/^\u5A11\u581F\u4F05\\d*\\+?$/.test(item));
      };

      const textarea = document.querySelector('textarea');
      if (!textarea || textarea.disabled) {
        return { ok: false, reason: 'input-not-found' };
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) {
        return { ok: false, reason: 'textarea-setter-not-found' };
      }

      const beforeMessages = readMessages();
      textarea.click();
      textarea.focus();
      setter.call(textarea, ${JSON.stringify(text)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));

      const normalizeBtn = (s) => String(s || '').replace(/\\s+/g, '').trim();
      let sendButton = null;
      for (let i = 0; i < 30; i++) {
        sendButton = Array.from(document.querySelectorAll('button'))
          .find((btn) => /^(\u53D1\u9001|\u9359\u6226\u20AC?)$/.test(normalizeBtn(btn.textContent || '')));
        if (sendButton) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (!sendButton) {
        return { ok: false, reason: 'send-button-not-found' };
      }

      sendButton.click();
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        const afterMessages = readMessages();
        if (afterMessages.length > beforeMessages.length && afterMessages.at(-1) === ${JSON.stringify(text)}) {
          return { ok: true };
        }
      }
      return { ok: false, reason: 'send-postcondition-timeout' };
    })()
  `;
  }

  // webcli/scripts/opencli-wave5/upstream/xianyu/utils.js
  function normalizeNumericId(value, label, example) {
    const normalized = String(value || "").trim();
    if (!/^\d+$/.test(normalized)) {
      throw new ArgumentError(`${label} must be a numeric ID`, `Pass a numeric ${label}, for example: ${example}`);
    }
    return normalized;
  }

  // webcli/scripts/opencli-wave5/upstream/xianyu/chat.js
  cli({
    site: "xianyu",
    name: "chat",
    access: "write",
    description: "\u6253\u5F00\u95F2\u9C7C\u804A\u4E00\u804A\u4F1A\u8BDD\uFF0C\u5E76\u53EF\u9009\u53D1\u9001\u6D88\u606F",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "item_id", required: true, positional: true, help: "\u95F2\u9C7C\u5546\u54C1 item_id" },
      { name: "user_id", required: true, positional: true, help: "\u804A\u4E00\u804A\u5BF9\u65B9\u7684 user_id / peerUserId" },
      { name: "text", help: "Message to send after opening the chat" }
    ],
    columns: ["status", "peer_name", "item_title", "price", "location", "message"],
    func: async (page, kwargs) => {
      const itemId = normalizeNumericId(kwargs.item_id, "item_id", "1038951278192");
      const userId = normalizeNumericId(kwargs.user_id, "user_id", "3650092411");
      const url = buildChatUrl(itemId, userId);
      const text = String(kwargs.text || "").trim();
      await page.goto(url);
      await page.wait(2);
      const state = requireEvaluateObject(await page.evaluate(buildExtractChatStateEvaluate()), "chat");
      if (state?.requiresAuth) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu chat requires a logged-in browser session");
      }
      if (!state?.can_input) {
        throw selectorError("\u95F2\u9C7C\u804A\u5929\u8F93\u5165\u6846", "\u672A\u627E\u5230\u53EF\u7528\u7684\u804A\u5929\u8F93\u5165\u6846\uFF0C\u8BF7\u786E\u8BA4\u8BE5\u4F1A\u8BDD\u9875\u5DF2\u6B63\u786E\u52A0\u8F7D");
      }
      if (!text) {
        return [{
          status: "ready",
          peer_name: state.peer_name || "",
          item_title: state.item_title || "",
          price: state.price || "",
          location: state.location || "",
          message: (state.visible_messages || []).slice(-1)[0] || "",
          peer_user_id: userId,
          item_id: itemId,
          url,
          item_url: state.item_url || ""
        }];
      }
      const sent = requireEvaluateObject(await page.evaluate(buildSendMessageEvaluate(text)), "chat send");
      if (!sent?.ok) {
        throw new CommandExecutionError(`Xianyu chat did not observe the sent message: ${sent?.reason || "unknown-reason"}`);
      }
      await page.wait(1);
      return [{
        status: "sent",
        peer_name: state.peer_name || "",
        item_title: state.item_title || "",
        price: state.price || "",
        location: state.location || "",
        message: text,
        peer_user_id: userId,
        item_id: itemId,
        url,
        item_url: state.item_url || ""
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/inbox.js
  cli({
    site: "xianyu",
    name: "inbox",
    access: "read",
    description: "\u5217\u51FA\u95F2\u9C7C\u6700\u8FD1\u79C1\u4FE1\u4F1A\u8BDD",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "limit", type: "int", default: DEFAULT_INBOX_LIMIT, help: "Number of conversations to return" },
      { name: "unread-only", type: "bool", default: false, help: "Return only conversations with unread messages" },
      { name: "resolve-ids", type: "bool", default: false, help: "Click each visible conversation to resolve item_id and peer_user_id from the chat URL" }
    ],
    columns: ["rank", "peer_name", "peer_user_id", "item_id", "item_title", "price", "last_message", "unread", "unread_count", "url"],
    func: async (page, kwargs) => {
      const limit = normalizeLimit(kwargs.limit, DEFAULT_INBOX_LIMIT, MAX_INBOX_LIMIT, "inbox --limit");
      const unreadOnly = Boolean(kwargs["unread-only"]);
      const resolveIds = Boolean(kwargs["resolve-ids"]);
      let currentUrl = "";
      if (page.getCurrentUrl) {
        try {
          currentUrl = await page.getCurrentUrl();
        } catch {
          currentUrl = "";
        }
      }
      if (!/https:\/\/www\.goofish\.com\/im\b/.test(currentUrl)) {
        await page.goto(buildInboxUrl());
      }
      await page.wait(4);
      const payload = requireEvaluateObject(await page.evaluate(buildExtractInboxEvaluate(limit)), "inbox");
      if (payload?.requiresAuth) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu inbox requires a logged-in browser session");
      }
      if (payload?.blocked) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu inbox is blocked by verification or risk control");
      }
      if (!Array.isArray(payload.items)) {
        throw new CommandExecutionError("Xianyu inbox returned malformed conversation list");
      }
      const items = payload.items;
      if (!items.length) {
        throw new EmptyResultError("xianyu inbox", "No Xianyu inbox conversations were found");
      }
      let conversations = items.slice(0, limit);
      if (unreadOnly) {
        conversations = conversations.filter((item) => Boolean(item.unread));
      }
      if (resolveIds) {
        for (const item of conversations) {
          if (item.item_id && item.peer_user_id) continue;
          const rowIndex = Number(item.row_index);
          if (!Number.isInteger(rowIndex) || rowIndex < 0) continue;
          requireClickResult(await page.evaluate(buildClickInboxConversationEvaluate(rowIndex)), "inbox resolve-ids click");
          await page.wait(1);
          const current = requireEvaluateObject(await page.evaluate(buildReadCurrentConversationUrlEvaluate()), "inbox current-url");
          item.item_id = current?.item_id || item.item_id || "";
          item.peer_user_id = current?.peer_user_id || item.peer_user_id || "";
          item.url = current?.url || item.url || "";
        }
      }
      return conversations.map((item, index) => ({
        rank: index + 1,
        peer_name: item.peer_name || "",
        peer_user_id: item.peer_user_id || "",
        item_id: item.item_id || "",
        item_title: item.item_title || "",
        price: item.price || "",
        last_message: item.last_message || "",
        unread: Boolean(item.unread),
        unread_count: Number(item.unread_count || 0),
        url: item.url || ""
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/item.js
  function buildItemUrl(itemId) {
    return `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`;
  }
  function buildFetchItemEvaluate(itemId) {
    return `
    (async () => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const extractRetCode = (ret) => {
        const first = Array.isArray(ret) ? ret[0] : '';
        return clean(first).split('::')[0] || '';
      };

      const waitFor = async (predicate, timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      };

      const bodyText = document.body?.innerText || '';
      if (/\u8BF7\u5148\u767B\u5F55|\u767B\u5F55\u540E/.test(bodyText)) {
        return { error: 'auth-required' };
      }

      if (/\u9A8C\u8BC1\u7801|\u5B89\u5168\u9A8C\u8BC1|\u5F02\u5E38\u8BBF\u95EE/.test(bodyText)) {
        return { error: 'blocked' };
      }

      await waitFor(() => window.lib?.mtop?.request);
      if (!window.lib || !window.lib.mtop || typeof window.lib.mtop.request !== 'function') {
        return { error: 'mtop-not-ready' };
      }

      let response;
      try {
        response = await window.lib.mtop.request({
          api: 'mtop.taobao.idle.pc.detail',
          data: { itemId: ${JSON.stringify(itemId)} },
          type: 'POST',
          v: '1.0',
          dataType: 'json',
          needLogin: false,
          needLoginPC: false,
          sessionOption: 'AutoLoginOnly',
          ecode: 0,
        });
      } catch (error) {
        const ret = error?.ret || [];
        return {
          error: 'mtop-request-failed',
          error_code: extractRetCode(ret),
          error_message: clean(Array.isArray(ret) ? ret.join(' | ') : error?.message || error),
        };
      }

      const retCode = extractRetCode(response?.ret || []);
      if (retCode && retCode !== 'SUCCESS') {
        return {
          error: 'mtop-response-error',
          error_code: retCode,
          error_message: clean((response?.ret || []).join(' | ')),
        };
      }

      const data = response?.data || {};
      const item = data.itemDO || {};
      const seller = data.sellerDO || {};
      const labels = Array.isArray(item.itemLabelExtList) ? item.itemLabelExtList : [];
      const findLabel = (name) => labels.find((label) => clean(label.propertyText) === name)?.text || '';
      const images = Array.isArray(item.imageInfos)
        ? item.imageInfos.map((entry) => entry?.url).filter(Boolean)
        : [];

      return {
        item_id: clean(item.itemId || ${JSON.stringify(itemId)}),
        title: clean(item.title || ''),
        description: clean(item.desc || ''),
        price: clean('\xA5' + (item.soldPrice || item.defaultPrice || '')).replace(/^\xA5\\s*$/, ''),
        original_price: clean(item.originalPrice || ''),
        want_count: String(item.wantCnt ?? ''),
        collect_count: String(item.collectCnt ?? ''),
        browse_count: String(item.browseCnt ?? ''),
        status: clean(item.itemStatusStr || ''),
        condition: clean(findLabel('\u6210\u8272')),
        brand: clean(findLabel('\u54C1\u724C')),
        category: clean(findLabel('\u5206\u7C7B')),
        location: clean(seller.publishCity || seller.city || ''),
        seller_name: clean(seller.nick || seller.uniqueName || ''),
        seller_id: String(seller.sellerId || ''),
        seller_score: clean(seller.xianyuSummary || ''),
        reply_ratio_24h: clean(seller.replyRatio24h || ''),
        reply_interval: clean(seller.replyInterval || ''),
        item_url: ${JSON.stringify(buildItemUrl(itemId))},
        seller_url: seller.sellerId ? 'https://www.goofish.com/personal?userId=' + seller.sellerId : '',
        image_count: String(images.length),
        image_urls: images,
      };
    })()
  `;
  }
  cli({
    site: "xianyu",
    name: "item",
    access: "read",
    description: "\u67E5\u770B\u95F2\u9C7C\u5546\u54C1\u8BE6\u60C5",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "item_id", required: true, positional: true, help: "\u95F2\u9C7C\u5546\u54C1 item_id" }
    ],
    columns: ["item_id", "title", "price", "condition", "brand", "location", "seller_name", "want_count"],
    func: async (page, kwargs) => {
      const itemId = normalizeNumericId(kwargs.item_id, "item_id", "1040754408976");
      await page.goto(buildItemUrl(itemId));
      await page.wait(2);
      const result = await page.evaluate(buildFetchItemEvaluate(itemId));
      if (result?.error === "auth-required") {
        throw new AuthRequiredError("www.goofish.com", "Xianyu item detail requires a logged-in browser session");
      }
      if (result?.error === "blocked") {
        throw new EmptyResultError("xianyu item", "Xianyu item detail is blocked by verification or risk control");
      }
      if (result?.error === "mtop-not-ready") {
        throw selectorError("window.lib.mtop", "\u95F2\u9C7C\u9875\u9762\u672A\u5B8C\u6210\u521D\u59CB\u5316\uFF0C\u65E0\u6CD5\u8C03\u7528\u5546\u54C1\u8BE6\u60C5\u63A5\u53E3");
      }
      if (!result || typeof result !== "object") {
        throw new EmptyResultError("xianyu item", "\u95F2\u9C7C\u5546\u54C1\u8BE6\u60C5\u63A5\u53E3\u672A\u8FD4\u56DE\u6709\u6548\u6570\u636E");
      }
      const errorCode = String(result.error_code || "");
      const errorMessage = String(result.error_message || "");
      if (/FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED|FAIL_SYS/.test(errorCode) || /FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED/.test(errorMessage)) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu item detail requires a logged-in browser session");
      }
      if (result.error) {
        throw new EmptyResultError("xianyu item", errorMessage || `Xianyu item detail request failed: ${result.error}`);
      }
      if (!String(result.title || "").trim()) {
        throw new EmptyResultError("xianyu item", "No item detail was returned for the specified item_id");
      }
      return [result];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/messages.js
  cli({
    site: "xianyu",
    name: "messages",
    access: "read",
    description: "\u8BFB\u53D6\u6307\u5B9A\u95F2\u9C7C\u79C1\u4FE1\u4F1A\u8BDD\u7684\u6700\u8FD1\u804A\u5929\u5185\u5BB9",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "item_id", positional: true, help: "\u95F2\u9C7C\u5546\u54C1 item_id" },
      { name: "user_id", positional: true, help: "\u804A\u4E00\u804A\u5BF9\u65B9\u7684 user_id / peerUserId" },
      { name: "limit", type: "int", default: DEFAULT_MESSAGE_LIMIT, help: "Number of visible messages to return" },
      { name: "rank", type: "int", default: 0, help: "Conversation rank from xianyu inbox; clicks the visible row instead of requiring IDs" }
    ],
    columns: ["index", "peer_name", "item_title", "message", "item_id", "peer_user_id", "url"],
    func: async (page, kwargs) => {
      const hasItemId = kwargs.item_id != null && kwargs.item_id !== "";
      const hasUserId = kwargs.user_id != null && kwargs.user_id !== "";
      const rank = normalizeRank(kwargs.rank);
      if (rank > 0 && (hasItemId || hasUserId)) {
        throw new ArgumentError("xianyu messages accepts either item_id/user_id or --rank, not both");
      }
      if (rank === 0 && hasItemId !== hasUserId) {
        throw new ArgumentError("xianyu messages requires both item_id and user_id, or --rank from xianyu inbox");
      }
      if (rank === 0 && !hasItemId && !hasUserId) {
        throw new ArgumentError("xianyu messages requires item_id/user_id or --rank from xianyu inbox");
      }
      const hasIds = hasItemId && hasUserId;
      const itemId = hasIds ? normalizeNumericId(kwargs.item_id, "item_id", "1038951278192") : "";
      const userId = hasIds ? normalizeNumericId(kwargs.user_id, "user_id", "3650092411") : "";
      const limit = normalizeLimit(kwargs.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, "messages --limit");
      let url = "";
      if (hasIds) {
        url = buildChatUrl(itemId, userId);
        await page.goto(url);
      } else {
        if (!page.getCurrentUrl || !/https:\/\/www\.goofish\.com\/im\b/.test(await page.getCurrentUrl())) {
          await page.goto("https://www.goofish.com/im");
        }
      }
      await page.wait(2);
      if (rank > 0) {
        requireClickResult(await page.evaluate(buildClickInboxConversationEvaluate(rank - 1)), "messages rank click");
        await page.wait(2);
      }
      const state = requireEvaluateObject(await page.evaluate(buildExtractChatStateEvaluate(limit)), "messages");
      if (state?.requiresAuth) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu messages requires a logged-in browser session");
      }
      if (!Array.isArray(state.messages)) {
        throw new CommandExecutionError("Xianyu messages returned malformed message list");
      }
      const messages = state.messages;
      if (!messages.length) {
        throw new EmptyResultError("xianyu messages", "No visible messages were found in this Xianyu conversation");
      }
      return messages.slice(-limit).map((message, index) => ({
        index: index + 1,
        peer_name: state.peer_name || "",
        item_title: state.item_title || "",
        message: message.text || "",
        item_id: itemId,
        peer_user_id: userId,
        url: url || ""
      }));
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/publish.js
  var CONDITION_CHOICES = ["\u5168\u65B0", "\u51E0\u4E4E\u5168\u65B0", "\u8F7B\u5FAE\u4F7F\u7528", "\u660E\u663E\u4F7F\u7528", "\u8001\u65E7"];
  function buildPublishUrl() {
    return "https://www.goofish.com/publish";
  }
  async function getCurrentPageUrl(page) {
    if (page.getCurrentUrl) {
      try {
        const currentUrl = await page.getCurrentUrl();
        if (currentUrl) return currentUrl;
      } catch {
      }
    }
    return buildPublishUrl();
  }
  function requireText2(value, label) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) {
      throw new ArgumentError(`xianyu publish ${label} cannot be empty`);
    }
    return text;
  }
  function parsePositivePrice(value, label) {
    if (value == null || String(value).trim() === "") {
      return null;
    }
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
      throw new ArgumentError(`xianyu publish ${label} must be a positive price with at most 2 decimals`);
    }
    const price = Number(text);
    if (!Number.isFinite(price) || price <= 0) {
      throw new ArgumentError(`xianyu publish ${label} must be a positive price`);
    }
    return text;
  }
  function validateCondition(value) {
    const condition = requireText2(value, "condition");
    if (!CONDITION_CHOICES.includes(condition)) {
      throw new ArgumentError(`xianyu publish condition must be one of: ${CONDITION_CHOICES.join(", ")}`);
    }
    return condition;
  }
  function normalizePublishArgs(kwargs) {
    const price = parsePositivePrice(kwargs.price, "price");
    if (price == null) {
      throw new ArgumentError("xianyu publish price cannot be empty");
    }
    const normalized = {};
    normalized.title = requireText2(kwargs.title, "title");
    normalized.description = requireText2(kwargs.description, "description");
    normalized.price = price;
    normalized.condition = validateCondition(kwargs.condition);
    normalized.category = requireText2(kwargs.category, "category");
    normalized.original_price = parsePositivePrice(kwargs.original_price, "original_price");
    normalized.location = kwargs.location ? requireText2(kwargs.location, "location") : "";
    normalized.images = [];
    return normalized;
  }
  function buildFillFormEvaluate(data) {
    return `
    (() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();

      const filled = [];
      const missing = [];

      // 1. \u586B\u6807\u9898
      const titleInput = document.querySelector('input[id*="title"], input[placeholder*="\u6807\u9898"], textarea[id*="title"], [class*="titleInput"]');
      if (titleInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) {
          titleInput.focus();
          setter.call(titleInput, ${JSON.stringify(data.title)});
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('title');
        }
      }
      if (!filled.includes('title')) missing.push('title');

      // 2. \u586B\u63CF\u8FF0
      const descInput = document.querySelector('textarea[id*="desc"], textarea[id*="description"], [class*="descInput"], [class*="description"]');
      if (descInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) {
          descInput.focus();
          setter.call(descInput, ${JSON.stringify(data.description)});
          descInput.dispatchEvent(new Event('input', { bubbles: true }));
          descInput.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('description');
        }
      }
      if (!filled.includes('description')) missing.push('description');

      // 3. \u586B\u4EF7\u683C
      const priceInput = document.querySelector('input[id*="price"], input[placeholder*="\u4EF7"], input[class*="price"]');
      if (priceInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          priceInput.focus();
          setter.call(priceInput, ${JSON.stringify(String(data.price))});
          priceInput.dispatchEvent(new Event('input', { bubbles: true }));
          priceInput.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('price');
        }
      }
      if (!filled.includes('price')) missing.push('price');

      // 4. \u586B\u539F\u4EF7\uFF08\u53EF\u9009\uFF09
      ${data.original_price ? `
      const originalPriceInput = document.querySelector('input[id*="original"], input[placeholder*="\u539F\u4EF7"], input[class*="original"]');
      if (originalPriceInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          originalPriceInput.focus();
          setter.call(originalPriceInput, ${JSON.stringify(String(data.original_price))});
          originalPriceInput.dispatchEvent(new Event('input', { bubbles: true }));
          originalPriceInput.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('original_price');
        }
      }
      ` : ""}

      // 5. \u586B\u5730\u5740\uFF08\u53EF\u9009\uFF09
      ${data.location ? `
      const locationInput = document.querySelector('input[id*="location"], input[placeholder*="\u5730"], input[class*="location"]');
      if (locationInput) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          locationInput.focus();
          setter.call(locationInput, ${JSON.stringify(data.location)});
          locationInput.dispatchEvent(new Event('input', { bubbles: true }));
          locationInput.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('location');
        }
      }
      ` : ""}

      // 6. \u9009\u62E9\u6210\u8272\uFF08\u70B9\u51FB\u5BF9\u5E94\u6309\u94AE\uFF09
      if (${JSON.stringify(data.condition)}) {
        const condition = ${JSON.stringify(data.condition)};
        const conditionMap = {
          '\u5168\u65B0': ['\u5168\u65B0', '\u5168\u65B0\u672A\u4F7F\u7528', 'new'],
          '\u51E0\u4E4E\u5168\u65B0': ['\u51E0\u4E4E\u5168\u65B0', '\u51E0\u4E4E\u5168\u65B0\u65E0\u7455\u75B5', 'like-new'],
          '\u8F7B\u5FAE\u4F7F\u7528': ['\u8F7B\u5FAE\u4F7F\u7528', '\u8F7B\u5FAE\u4F7F\u7528\u75D5\u8FF9'],
          '\u660E\u663E\u4F7F\u7528': ['\u660E\u663E\u4F7F\u7528', '\u6709\u660E\u663E\u4F7F\u7528\u75D5\u8FF9'],
          '\u8001\u65E7': ['\u8001\u65E7', '\u5E74\u4EE3\u4E45\u8FDC', '\u4E8C\u624B'],
        };
        const keywords = conditionMap[condition] || [condition];
        const allButtons = Array.from(document.querySelectorAll('button, [class*="tag"], [class*="condition"], [class*="level"], [role="button"]'));
        const matchBtn = allButtons.find((el) => {
          const text = clean(el.textContent || '');
          return keywords.some((kw) => text === kw || text.includes(kw));
        });
        if (matchBtn) {
          matchBtn.click();
          filled.push('condition');
        }
      }
      if (!filled.includes('condition')) missing.push('condition');

      return { ok: missing.length === 0, filled, missing };
    })()
  `;
  }
  function buildSelectCategoryEvaluate(categoryName) {
    return `
    (async () => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();

      // \u70B9\u51FB\u5206\u7C7B\u9009\u62E9\u5668
      const categoryTrigger = Array.from(document.querySelectorAll('button, [class*="trigger"], [class*="selector"], [role="button"]'))
        .find((el) => /\u5206\u7C7B|category|\u7C7B\u76EE/.test(el.textContent || ''))
        || document.querySelector('[class*="category"], [class*="categorySelector"]');

      if (categoryTrigger) {
        categoryTrigger.click();
      } else {
        return { ok: false, reason: 'category-trigger-not-found' };
      }

      // \u7B49\u5F85\u5206\u7C7B\u5F39\u7A97/\u9762\u677F\u51FA\u73B0
      const waitFor = async (predicate, timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };

      // \u5728\u5206\u7C7B\u5F39\u7A97\u4E2D\u641C\u7D22\u5E76\u70B9\u51FB
      const searchKeyword = ${JSON.stringify(categoryName)};
      const hasMatch = await waitFor(() => {
        const allNodes = Array.from(document.querySelectorAll('button, [class*="item"], [class*="node"], [role="option"]'));
        return allNodes.some((el) => clean(el.textContent || '').includes(searchKeyword));
      }, 5000);

      if (!hasMatch) {
        return { ok: false, reason: 'category-not-found' };
      }

      const allNodes = Array.from(document.querySelectorAll('button, [class*="item"], [class*="node"], [role="option"]'));
      const matchNode = allNodes.find((el) => clean(el.textContent || '').includes(searchKeyword));
      if (matchNode) {
        matchNode.click();
        return { ok: true };
      }
      return { ok: false, reason: 'category-match-failed' };
    })()
  `;
  }
  function buildSubmitEvaluate() {
    return `
    (() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();

      // \u627E\u53D1\u5E03\u6309\u94AE
      const submitBtn = Array.from(document.querySelectorAll('button'))
        .find((btn) => {
          const text = clean(btn.textContent || '');
          return /\u53D1\u5E03|\u63D0\u4EA4|\u4E0A\u67B6|\u786E\u8BA4/.test(text) && !/\u53D6\u6D88/.test(text);
        })
        || document.querySelector('[class*="publish"], [class*="submit"], [class*="confirm"]');

      if (!submitBtn || submitBtn.disabled) {
        return { ok: false, reason: 'submit-button-not-found-or-disabled' };
      }

      submitBtn.click();
      return { ok: true };
    })()
  `;
  }
  function buildDetectSuccessEvaluate() {
    return `
    (() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const bodyText = document.body?.innerText || '';
      const url = window.location.href || '';

      // \u6210\u529F\u6807\u5FD7\uFF1AURL \u53D8\u4E3A\u5546\u54C1\u8BE6\u60C5\u9875
      if (/item\\?id=\\d+/.test(url)) {
        const match = url.match(/item\\?id=(\\d+)/);
        return { status: 'published', item_id: match ? match[1] : '', url, message: '\u53D1\u5E03\u6210\u529F' };
      }

      // \u6210\u529F\u6807\u5FD7\uFF1A\u9875\u9762\u51FA\u73B0"\u53D1\u5E03\u6210\u529F"
      if (/\u53D1\u5E03\u6210\u529F|\u4E0A\u67B6\u6210\u529F|\u53D1\u5E03\u5B8C\u6210/.test(bodyText)) {
        const idMatch = url.match(/item\\?id=(\\d+)/) || bodyText.match(/id[\uFF1A:]?\\s*(\\d{10,})/);
        return { status: 'published', item_id: idMatch ? (idMatch[1] || idMatch[0]) : '', url, message: '\u53D1\u5E03\u6210\u529F' };
      }

      // \u5931\u8D25\u6807\u5FD7
      const errMatch = Array.from(document.querySelectorAll('[class*="error"], [class*="fail"]'))
        .map((el) => clean(el.textContent || ''))
        .filter(Boolean);
      if (errMatch.length || /\u53D1\u5E03\u5931\u8D25|\u4E0A\u67B6\u5931\u8D25|\u5F02\u5E38|\u9519\u8BEF|\u8FDD\u89C4/.test(bodyText)) {
        return { status: 'failed', message: errMatch.join(' | ') || 'publish-failed' };
      }

      return { ok: false, reason: 'unknown-state' };
    })()
  `;
  }
  function buildExtractPageStateEvaluate() {
    return `
    (() => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const bodyText = document.body?.innerText || '';
      const url = window.location.href || '';

      const requiresAuth = /\u8BF7\u5148\u767B\u5F55|\u767B\u5F55\u540E/.test(bodyText);
      const hasPublishForm = /\u53D1\u5E03\u95F2\u7F6E|\u53D1\u5E03\u5B9D\u8D1D|\u95F2\u7F6E\u63CF\u8FF0|\u6807\u9898|\u4EF7\u683C|\u6210\u8272|\u5206\u7C7B/.test(bodyText);
      const hasCategorySelect = /\u9009\u62E9\u5206\u7C7B|\u9009\u62E9\u7C7B\u76EE|\u5206\u7C7B\u9009\u62E9/.test(bodyText);
      const hasImageUpload = /\u4E0A\u4F20\u56FE\u7247|\u6DFB\u52A0\u56FE\u7247|photo|\u56FE\u7247/.test(bodyText);

      // \u627E\u5404\u5B57\u6BB5
      const titleInput = !!document.querySelector('input[id*="title"], input[placeholder*="\u6807\u9898"], textarea[id*="title"]');
      const descInput = !!document.querySelector('textarea[id*="desc"], textarea[id*="description"]');
      const priceInput = !!document.querySelector('input[id*="price"], input[placeholder*="\u4EF7"]');
      const conditionSelect = !!document.querySelector('[class*="condition"], [class*="level"], button[class*="tag"]');
      const submitBtn = Array.from(document.querySelectorAll('button'))
        .find((btn) => /\u53D1\u5E03|\u63D0\u4EA4|\u4E0A\u67B6/.test(clean(btn.textContent || '')));

      return {
        requiresAuth,
        hasPublishForm,
        hasCategorySelect,
        hasImageUpload,
        titleInput,
        descInput,
        priceInput,
        conditionSelect,
        submitBtn: !!submitBtn,
        pageUrl: url,
        bodySnippet: bodyText.slice(0, 500),
      };
    })()
    `;
  }
  var publishCommand = cli({
    site: "xianyu",
    name: "publish",
    access: "write",
    description: "\u53D1\u5E03\u95F2\u9C7C\u5B9D\u8D1D\uFF08\u9700\u5148\u5728\u6D4F\u89C8\u5668\u4E2D\u767B\u5F55\u95F2\u9C7C\uFF09",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "title", required: true, positional: true, help: "\u5546\u54C1\u6807\u9898" },
      { name: "description", required: true, positional: true, help: "\u5546\u54C1\u63CF\u8FF0/\u8BE6\u60C5" },
      { name: "price", required: true, positional: true, type: "float", help: "\u51FA\u552E\u4EF7\u683C\uFF08\u5143\uFF09" },
      { name: "condition", required: true, positional: true, help: "\u6210\u8272\uFF1A\u5168\u65B0 / \u51E0\u4E4E\u5168\u65B0 / \u8F7B\u5FAE\u4F7F\u7528 / \u660E\u663E\u4F7F\u7528 / \u8001\u65E7" },
      { name: "category", required: true, positional: true, help: "\u5546\u54C1\u5206\u7C7B\u5173\u952E\u8BCD\uFF08\u5982\uFF1A\u624B\u673A\u3001\u8863\u670D\u3001\u56FE\u4E66\uFF09" },
      { name: "original_price", type: "float", help: "\u539F\u4EF7\uFF08\u9009\u586B\uFF0C\u7528\u4E8E\u663E\u793A\u6298\u6263\uFF09" },
      { name: "location", help: "\u6240\u5728\u5730\u533A\uFF08\u9009\u586B\uFF0C\u5982\uFF1A\u676D\u5DDE\uFF09" }
    ],
    columns: ["status", "item_id", "title", "price", "condition", "url", "message"],
    func: async (page, kwargs) => {
      const data = normalizePublishArgs(kwargs);
      await page.goto(buildPublishUrl());
      await page.wait(3);
      const initState = await page.evaluate(buildExtractPageStateEvaluate());
      if (initState?.requiresAuth) {
        throw new AuthRequiredError("www.goofish.com", "\u53D1\u5E03\u95F2\u9C7C\u9700\u8981\u5148\u767B\u5F55\uFF0C\u8BF7\u5728 Chrome \u4E2D\u6253\u5F00 goofish.com \u5E76\u5B8C\u6210\u767B\u5F55");
      }
      if (!initState?.hasPublishForm) {
        throw new CommandExecutionError("Xianyu publish form was not detected", "Confirm goofish.com is logged in and the publish page finished loading.");
      }
      const categoryResult = await page.evaluate(buildSelectCategoryEvaluate(data.category));
      if (!categoryResult?.ok) {
        throw new CommandExecutionError(`Xianyu category selection failed: ${categoryResult?.reason || "unknown-reason"}`);
      }
      await page.wait(1.5);
      const fillResult = await page.evaluate(buildFillFormEvaluate(data));
      if (!fillResult?.ok) {
        const missing = Array.isArray(fillResult?.missing) ? fillResult.missing.join(", ") : "unknown";
        throw new CommandExecutionError(`Xianyu publish form fill failed; missing fields: ${missing}`);
      }
      await page.wait(1);
      const submitResult = await page.evaluate(buildSubmitEvaluate());
      if (!submitResult?.ok) {
        throw new CommandExecutionError(`Xianyu publish submit failed: ${submitResult?.reason || "unknown-reason"}`);
      }
      await page.wait(2);
      let itemId = "";
      let finalUrl = await getCurrentPageUrl(page);
      let failReason = "";
      for (let i = 0; i < 10; i++) {
        await page.wait(1.5);
        const result = await page.evaluate(buildDetectSuccessEvaluate());
        finalUrl = await getCurrentPageUrl(page);
        if (result?.status === "published") {
          itemId = String(result.item_id || "").replace(/\D/g, "");
          return [{
            status: "published",
            item_id: itemId,
            title: data.title.slice(0, 50),
            price: `\xA5${data.price}`,
            condition: data.condition,
            url: result.url || finalUrl,
            message: "\u53D1\u5E03\u6210\u529F"
          }];
        }
        if (result?.status === "failed") {
          failReason = result.message || "\u53D1\u5E03\u5931\u8D25";
          break;
        }
      }
      throw new CommandExecutionError(failReason || "Xianyu publish result was not confirmed before timeout", `Open ${finalUrl} and verify whether the listing was published.`);
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/reply.js
  cli({
    site: "xianyu",
    name: "reply",
    access: "write",
    description: "\u56DE\u590D\u6307\u5B9A\u95F2\u9C7C\u79C1\u4FE1\u4F1A\u8BDD",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "item_id", positional: true, help: "\u95F2\u9C7C\u5546\u54C1 item_id" },
      { name: "user_id", positional: true, help: "\u804A\u4E00\u804A\u5BF9\u65B9\u7684 user_id / peerUserId" },
      { name: "text", required: true, help: "Message text to send" },
      { name: "rank", type: "int", default: 0, help: "Conversation rank from xianyu inbox; clicks the visible row instead of requiring IDs" }
    ],
    columns: ["status", "peer_name", "item_title", "price", "location", "message"],
    func: async (page, kwargs) => {
      const hasItemId = kwargs.item_id != null && kwargs.item_id !== "";
      const hasUserId = kwargs.user_id != null && kwargs.user_id !== "";
      const rank = normalizeRank(kwargs.rank);
      if (rank > 0 && (hasItemId || hasUserId)) {
        throw new ArgumentError("xianyu reply accepts either item_id/user_id or --rank, not both");
      }
      if (rank === 0 && hasItemId !== hasUserId) {
        throw new ArgumentError("xianyu reply requires both item_id and user_id, or --rank from xianyu inbox");
      }
      if (rank === 0 && !hasItemId && !hasUserId) {
        throw new ArgumentError("xianyu reply requires item_id/user_id or --rank from xianyu inbox");
      }
      const hasIds = hasItemId && hasUserId;
      const itemId = hasIds ? normalizeNumericId(kwargs.item_id, "item_id", "1038951278192") : "";
      const userId = hasIds ? normalizeNumericId(kwargs.user_id, "user_id", "3650092411") : "";
      const text = requireText(kwargs.text, "xianyu reply --text");
      const url = hasIds ? buildChatUrl(itemId, userId) : "";
      if (hasIds) {
        await page.goto(url);
      } else {
        if (!page.getCurrentUrl || !/https:\/\/www\.goofish\.com\/im\b/.test(await page.getCurrentUrl())) {
          await page.goto("https://www.goofish.com/im");
        }
      }
      await page.wait(2);
      if (rank > 0) {
        requireClickResult(await page.evaluate(buildClickInboxConversationEvaluate(rank - 1)), "reply rank click");
        await page.wait(2);
      }
      const state = requireEvaluateObject(await page.evaluate(buildExtractChatStateEvaluate()), "reply");
      if (state?.requiresAuth) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu reply requires a logged-in browser session");
      }
      if (!state?.can_input) {
        throw selectorError("\u95F2\u9C7C\u804A\u5929\u8F93\u5165\u6846", "\u672A\u627E\u5230\u53EF\u7528\u7684\u804A\u5929\u8F93\u5165\u6846\uFF0C\u8BF7\u786E\u8BA4\u8BE5\u4F1A\u8BDD\u9875\u5DF2\u6B63\u786E\u52A0\u8F7D");
      }
      const sent = requireEvaluateObject(await page.evaluate(buildSendMessageEvaluate(text)), "reply send");
      if (!sent?.ok) {
        throw new CommandExecutionError(`Xianyu reply did not observe the sent message: ${sent?.reason || "unknown-reason"}`);
      }
      await page.wait(1);
      return [{
        status: "sent",
        peer_name: state.peer_name || "",
        item_title: state.item_title || "",
        price: state.price || "",
        location: state.location || "",
        message: text,
        peer_user_id: userId,
        item_id: itemId,
        url: url || "",
        item_url: state.item_url || ""
      }];
    }
  });

  // webcli/scripts/opencli-wave5/upstream/xianyu/search.js
  var ROWS_PER_PAGE = 30;
  var MAX_LIMIT = 60;
  function normalizeLimit2(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
      return 20;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
  }
  function buildSearchUrl(query) {
    return `https://www.goofish.com/search?q=${encodeURIComponent(query)}`;
  }
  function parsePriceArg(value, label) {
    if (value === void 0 || value === null || value === "")
      return null;
    const n = Number(String(value).trim());
    if (!Number.isFinite(n) || n < 0) {
      throw new ArgumentError(`xianyu search ${label} must be a non-negative number`, `For example: --${label} 100000`);
    }
    return n;
  }
  function buildSearchFilter(minPrice, maxPrice) {
    if (minPrice == null && maxPrice == null)
      return "";
    const lo = minPrice != null ? minPrice : 0;
    const hi = maxPrice != null ? maxPrice : 99999999;
    return `priceRange:${lo},${hi};`;
  }
  function buildExtraFilterValue(province, city) {
    if (!province && !city)
      return "{}";
    return JSON.stringify({
      divisionList: [{ province: province || "", city: city || "" }],
      excludeMultiPlacesSellers: "0",
      extraDivision: ""
    });
  }
  function buildSearchEvaluate({ keyword, searchFilter, extraFilterValue, fromFilter, maxItems }) {
    return `
    (async () => {
      const clean = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const cleanFirst = (...values) => values.map(clean).find(Boolean) || '';
      const cleanTagList = (value) => {
        const nodes = Array.isArray(value) ? value : [];
        return nodes
          .map((entry) => cleanFirst(entry?.text, entry?.title, entry?.name, entry?.label, entry?.content, entry?.data?.content))
          .filter(Boolean)
          .join(' | ');
      };
      const extractRetCode = (ret) => {
        const first = Array.isArray(ret) ? ret[0] : '';
        return clean(first).split('::')[0] || '';
      };
      const waitFor = async (predicate, timeoutMs = 6000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (predicate()) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      };

      const bodyText = document.body?.innerText || '';
      if (/\u8BF7\u5148\u767B\u5F55|\u626B\u7801\u767B\u5F55|\u767B\u5F55\u540E/.test(bodyText)) return { error: 'auth-required' };
      if (/\u9A8C\u8BC1\u7801|\u5B89\u5168\u9A8C\u8BC1|\u5F02\u5E38\u8BBF\u95EE/.test(bodyText)) return { error: 'blocked' };

      await waitFor(() => window.lib?.mtop?.request);
      if (!window.lib || !window.lib.mtop || typeof window.lib.mtop.request !== 'function') {
        return { error: 'mtop-not-ready' };
      }

      const searchFilter = ${JSON.stringify(searchFilter)};
      const propValueStr = searchFilter ? { searchFilter } : {};
      const rows = ${ROWS_PER_PAGE};
      const maxItems = ${maxItems};
      const maxPages = Math.ceil(maxItems / rows);
      const collected = [];

      for (let page = 1; page <= maxPages && collected.length < maxItems; page++) {
        let response;
        try {
          response = await window.lib.mtop.request({
            api: 'mtop.taobao.idlemtopsearch.pc.search',
            data: {
              pageNumber: page,
              keyword: ${JSON.stringify(keyword)},
              fromFilter: ${fromFilter ? "true" : "false"},
              rowsPerPage: rows,
              sortValue: '',
              sortField: '',
              customDistance: '',
              gps: '',
              propValueStr,
              customGps: '',
              searchReqFromPage: 'pcSearch',
              extraFilterValue: ${JSON.stringify(extraFilterValue)},
              userPositionJson: '{}',
            },
            type: 'POST',
            v: '1.0',
            dataType: 'json',
            needLogin: false,
            needLoginPC: false,
            sessionOption: 'AutoLoginOnly',
            ecode: 0,
          });
        } catch (error) {
          const ret = error?.ret || [];
          return {
            error: 'mtop-request-failed',
            error_code: extractRetCode(ret),
            error_message: clean(Array.isArray(ret) ? ret.join(' | ') : error?.message || error),
          };
        }

        const retCode = extractRetCode(response?.ret || []);
        if (retCode && retCode !== 'SUCCESS') {
          return {
            error: 'mtop-response-error',
            error_code: retCode,
            error_message: clean((response?.ret || []).join(' | ')),
          };
        }

        if (!response?.data || !Array.isArray(response.data.resultList)) {
          return {
            error: 'malformed-response',
            error_message: 'Xianyu search response did not include a resultList array',
          };
        }

        const list = response.data.resultList;
        if (!list.length) break;

        let pageValidRows = 0;
        let pageMalformedRows = 0;
        for (const entry of list) {
          const itemNode = entry?.data?.item || {};
          const main = itemNode.main || {};
          const args = main.clickParam?.args || {};
          const ex = main.exContent || itemNode.exContent || {};
          const itemId = clean(args.item_id || args.id || '');
          const title = clean(ex.title || ex.detailParams?.title || '');
          if (!itemId || !title) {
            pageMalformedRows += 1;
            continue;
          }
          const priceYuan = clean(args.price || args.displayPrice || '');
          const city = clean(args.p_city || '');
          const area = clean(ex.area || '');
          const tagText = cleanTagList(ex.fishTags || ex.labels || ex.tags || ex.tagList || []);
          collected.push({
            item_id: itemId,
            title,
            price: priceYuan ? ('\xA5' + priceYuan) : '',
            condition: cleanFirst(ex.condition, ex.stuffStatus, ex.detailParams?.condition),
            brand: cleanFirst(ex.brand, ex.brandName, ex.detailParams?.brand),
            location: city || area,
            badge: cleanFirst(ex.badge, ex.creditText, ex.creditLevel, tagText),
            want: clean(args.wantNum || ex.want || ''),
            url: 'https://www.goofish.com/item?id=' + itemId,
          });
          pageValidRows += 1;
          if (collected.length >= maxItems) break;
        }

        if (!pageValidRows && pageMalformedRows) {
          return {
            error: 'malformed-row',
            error_message: 'Xianyu search result rows were missing item_id or title',
          };
        }

        if (list.length < rows) break;
      }

      return { items: collected };
    })()
  `;
  }
  cli({
    site: "xianyu",
    name: "search",
    access: "read",
    description: "\u641C\u7D22\u95F2\u9C7C\u5546\u54C1\uFF08\u652F\u6301\u670D\u52A1\u7AEF\u4EF7\u683C\u533A\u95F4 / \u5730\u533A\u7B5B\u9009\uFF09",
    domain: "www.goofish.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "query", required: true, positional: true, help: "\u641C\u7D22\u5173\u952E\u8BCD" },
      { name: "limit", type: "int", default: 20, help: `\u8FD4\u56DE\u7ED3\u679C\u6570\uFF08\u6700\u591A ${MAX_LIMIT}\uFF0C\u81EA\u52A8\u7FFB\u9875\uFF09` },
      { name: "min-price", type: "float", help: "\u6700\u4F4E\u4EF7\u683C\uFF08\u5143\uFF09\uFF0C\u670D\u52A1\u7AEF\u7B5B\u9009" },
      { name: "max-price", type: "float", help: "\u6700\u9AD8\u4EF7\u683C\uFF08\u5143\uFF09\uFF0C\u670D\u52A1\u7AEF\u7B5B\u9009" },
      { name: "province", type: "string", help: "\u7701\u4EFD\u540D\uFF08\u5982 \u5E7F\u4E1C\uFF09\uFF0C\u670D\u52A1\u7AEF\u6309\u5730\u533A\u7B5B\u9009" },
      { name: "city", type: "string", help: "\u57CE\u5E02\u540D\uFF08\u5982 \u6DF1\u5733 / \u6E5B\u6C5F\uFF09\uFF0C\u53EF\u5355\u72EC\u4F7F\u7528\uFF0C\u670D\u52A1\u7AEF\u6309\u5730\u533A\u7B5B\u9009" }
    ],
    columns: ["item_id", "rank", "title", "price", "condition", "brand", "location", "badge", "want", "url"],
    func: async (page, kwargs) => {
      const query = String(kwargs.query || "").trim();
      const limit = normalizeLimit2(kwargs.limit);
      const minPrice = parsePriceArg(kwargs["min-price"], "min-price");
      const maxPrice = parsePriceArg(kwargs["max-price"], "max-price");
      if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
        throw new ArgumentError("xianyu search min-price cannot be greater than max-price", `Received --min-price ${minPrice} and --max-price ${maxPrice}`);
      }
      const province = String(kwargs.province || "").trim();
      const city = String(kwargs.city || "").trim();
      const searchFilter = buildSearchFilter(minPrice, maxPrice);
      const extraFilterValue = buildExtraFilterValue(province, city);
      const fromFilter = Boolean(searchFilter) || extraFilterValue !== "{}";
      await page.goto(buildSearchUrl(query));
      await page.wait(2);
      const result = await page.evaluate(buildSearchEvaluate({ keyword: query, searchFilter, extraFilterValue, fromFilter, maxItems: limit }));
      if (result?.error === "auth-required") {
        throw new AuthRequiredError("www.goofish.com", "Xianyu search requires a logged-in browser session");
      }
      if (result?.error === "blocked") {
        throw new CommandExecutionError("Xianyu returned a verification page or blocked the current browser session");
      }
      if (result?.error === "mtop-not-ready") {
        throw selectorError("window.lib.mtop", "\u95F2\u9C7C\u9875\u9762\u672A\u5B8C\u6210\u521D\u59CB\u5316\uFF0C\u65E0\u6CD5\u8C03\u7528\u641C\u7D22\u63A5\u53E3");
      }
      if (!result || typeof result !== "object") {
        throw new CommandExecutionError("Xianyu search returned a malformed response");
      }
      const errorCode = String(result?.error_code || "");
      const errorMessage = String(result?.error_message || "");
      if (/FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED|FAIL_SYS_TOKEN/.test(errorCode) || /FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED/.test(errorMessage)) {
        throw new AuthRequiredError("www.goofish.com", "Xianyu search requires a logged-in browser session");
      }
      if (result?.error) {
        throw new CommandExecutionError(errorMessage || `Xianyu search request failed: ${result.error}`);
      }
      if (!Array.isArray(result.items)) {
        throw new CommandExecutionError("Xianyu search response did not include an items array");
      }
      const items = result.items;
      if (!items.length) {
        throw new EmptyResultError("xianyu search", "\u6CA1\u6709\u5339\u914D\u7684\u5546\u54C1\uFF08\u7B5B\u9009\u6761\u4EF6\u53EF\u80FD\u8FC7\u7A84\uFF0C\u6216\u5F53\u524D\u5173\u952E\u8BCD\u65E0\u7ED3\u679C\uFF09");
      }
      return items.map((item, index) => ({ rank: index + 1, ...item }));
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
      return command.browser === false ? await command.func(args) : await command.func(page, args);
    } catch (error) {
      if (page.pending) return page.pending;
      throw error;
    }
  }
  return __toCommonJS(stdin_exports);
})();

window.__wave5 = __wave5;
