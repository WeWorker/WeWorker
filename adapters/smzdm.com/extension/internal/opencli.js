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

  // webcli/scripts/opencli-wave4/registry.js
  var commands = /* @__PURE__ */ new Map();
  var Strategy = { PUBLIC: "public", COOKIE: "cookie" };
  function cli(command) {
    commands.set(`${command.site}/${command.name}`, command);
    return command;
  }

  // webcli/scripts/opencli-wave4/upstream/smzdm/search.js
  function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
      return payload.data;
    }
    return payload;
  }
  function requireSearchRows(payload) {
    const rows = unwrapEvaluateResult(payload);
    if (!Array.isArray(rows)) {
      throw new CommandExecutionError("Unexpected SMZDM search extraction payload shape; expected an array of rows.");
    }
    return rows;
  }
  function parseLimit(raw) {
    let parsed;
    if (raw == null) {
      parsed = 20;
    } else if (typeof raw === "number") {
      parsed = raw;
    } else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
      parsed = Number(raw);
    } else {
      parsed = NaN;
    }
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1 || parsed > 100) {
      throw new ArgumentError(`--limit must be between 1 and 100, got ${parsed}`);
    }
    return parsed;
  }
  function buildSmzdmSearchJs(limit) {
    return `
      (() => {
        const limit = ${limit};
        const bodyText = document.body?.innerText || '';
        if (/\u5B89\u5168\u9A8C\u8BC1|\u9A8C\u8BC1\u7801|\u8BBF\u95EE\u8FC7\u4E8E\u9891\u7E41|captcha|verification required/i.test(bodyText)) throw new Error('SMZDM security verification required');
        const items = document.querySelectorAll('li.feed-row-wide');
        const results = [];
        const normalizeCount = (text) => {
          const raw = (text || '').replace(/,/g, '').trim();
          const match = raw.match(/(\\d+(?:\\.\\d+)?)\\s*([\u4E07kK]?)/);
          if (!match) return null;
          const base = Number(match[1]);
          if (!Number.isFinite(base)) return 0;
          const unit = match[2];
          if (unit === '\u4E07') return Math.round(base * 10000);
          if (unit === 'k' || unit === 'K') return Math.round(base * 1000);
          return Math.round(base);
        };
        const intFrom = (el) => {
          if (!el) return null;
          return normalizeCount(el.textContent || '');
        };
        const trustedSmzdmUrl = (raw) => {
          const text = (raw || '').trim();
          if (!text) return '';
          let url;
          try {
            url = text.startsWith('/')
              ? new URL(text, 'https://www.smzdm.com')
              : new URL(text, location.href);
          } catch {
            return '';
          }
          const hostname = url.hostname.toLowerCase();
          if (url.protocol !== 'https:' || url.username || url.password || url.port || (hostname !== 'www.smzdm.com' && hostname !== 'post.smzdm.com')) {
            return '';
          }
          return url.toString();
        };
        items.forEach((li) => {
          if (results.length >= limit) return;
          const titleEl = li.querySelector('h5.feed-block-title > a')
                       || li.querySelector('h5 > a');
          if (!titleEl) return;
          const title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
          const url = trustedSmzdmUrl(titleEl.getAttribute('href') || titleEl.href || '');
          if (!title || !url) return;
          const priceEl = li.querySelector('.z-highlight');
          const price = priceEl ? priceEl.textContent.trim() : '';
          let mall = '';
          const mallEl = li.querySelector('.z-feed-foot-r .feed-block-extras span')
                      || li.querySelector('.z-feed-foot-r span');
          if (mallEl) mall = mallEl.textContent.trim();
          // Update time lives as the direct text node(s) of .feed-block-extras,
          // alongside the nested mall <span> which we exclude here.
          let updated_at = '';
          const extrasEl = li.querySelector('.z-feed-foot-r .feed-block-extras');
          if (extrasEl) {
            updated_at = Array.from(extrasEl.childNodes)
              .filter((node) => node.nodeType === 3)
              .map((node) => (node.textContent || '').trim())
              .filter(Boolean)
              .join(' ');
          }
          const zhi_count = intFrom(li.querySelector('.price-btn-up .unvoted-wrap span'));
          const buzhi_count = intFrom(li.querySelector('.price-btn-down .unvoted-wrap span'));
          const favorite_count = intFrom(li.querySelector('.feed-btn-fav span'));
          const comments = intFrom(li.querySelector('.feed-btn-comment'));
          results.push({ rank: results.length + 1, title, price, mall, updated_at, zhi_count, buzhi_count, favorite_count, comments, url });
        });
        if (!results.length) throw new Error('SMZDM results missing: page may be loading, blocked, empty or changed; empty result not verified');
        return results;
      })()
    `;
  }
  var smzdmSearchCommand = cli({
    site: "smzdm",
    name: "search",
    access: "read",
    description: "\u4EC0\u4E48\u503C\u5F97\u4E70\u641C\u7D22\u597D\u4EF7",
    domain: "www.smzdm.com",
    strategy: Strategy.COOKIE,
    args: [
      { name: "query", required: true, positional: true, help: "Search keyword" },
      { name: "limit", type: "int", default: 20, help: "Number of results" }
    ],
    columns: ["rank", "title", "price", "mall", "updated_at", "zhi_count", "buzhi_count", "favorite_count", "comments", "url"],
    func: async (page, kwargs) => {
      const q = encodeURIComponent(kwargs.query);
      const limit = parseLimit(kwargs.limit);
      await page.goto(`https://search.smzdm.com/?c=home&s=${q}&v=b`);
      await page.wait(2);
      return requireSearchRows(await page.evaluate(buildSmzdmSearchJs(limit)));
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
