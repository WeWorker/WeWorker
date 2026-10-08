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

  // webcli/scripts/opencli-wave4/atom.js
  var fail = (message) => {
    throw new CommandExecutionError(`Invalid arXiv Atom feed: ${message}`);
  };
  var ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/;
  function decode(text) {
    return text.replace(/&([^;]+);/g, (_, entity) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (Object.hasOwn(named, entity)) return named[entity];
      if (!/^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) fail("unknown entity");
      const n = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(n) || n > 1114111 || n >= 55296 && n <= 57343 || n < 32 && ![9, 10, 13].includes(n)) fail("invalid character");
      return String.fromCodePoint(n);
    });
  }
  function parse(xml) {
    if (typeof xml !== "string" || xml.length > 4 * 1024 * 1024) fail("missing or oversized document");
    const roots = [], stack = [];
    let i = 0, count = 0;
    const text = (value, cdata = false) => {
      if (!stack.length) {
        if (value.trim()) fail("text outside root");
        return;
      }
      stack.at(-1).text += cdata ? value : decode(value);
    };
    while (i < xml.length) {
      if (xml[i] !== "<") {
        const next = xml.indexOf("<", i);
        const end2 = next < 0 ? xml.length : next;
        text(xml.slice(i, end2));
        i = end2;
        continue;
      }
      if (xml.startsWith("<!--", i) || xml.startsWith("<?", i) || xml.startsWith("<![CDATA[", i)) {
        const cdata = xml.startsWith("<![CDATA[", i), pi = xml.startsWith("<?", i);
        const prefix = cdata ? 9 : pi ? 2 : 4, close = cdata ? "]]>" : pi ? "?>" : "-->";
        const end2 = xml.indexOf(close, i + prefix);
        if (end2 < 0) fail("unterminated section");
        if (cdata) text(xml.slice(i + prefix, end2), true);
        i = end2 + close.length;
        continue;
      }
      if (xml.startsWith("<!", i)) fail("declarations are not accepted");
      let quote = "", end = i + 1;
      for (; end < xml.length; end++) {
        const c = xml[end];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (end >= xml.length) fail("unclosed tag");
      const raw = xml.slice(i + 1, end);
      i = end + 1;
      if (raw.startsWith("/")) {
        const node2 = stack.pop();
        if (!node2 || raw.slice(1).trim() !== node2.name) fail("mismatched closing tag");
        continue;
      }
      const self = /\/\s*$/.test(raw), body = self ? raw.replace(/\/\s*$/, "") : raw;
      const match = body.match(/^([A-Za-z_][\w.:-]*)([\s\S]*)$/);
      if (!match) fail("invalid tag");
      const attrs = {};
      let rest = match[2];
      while (rest.trim()) {
        const a = rest.match(/^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/);
        if (!a || Object.hasOwn(attrs, a[1])) fail("invalid or duplicate attribute");
        attrs[a[1]] = decode(a[3]);
        rest = rest.slice(a[0].length);
      }
      if (++count > 5e4 || stack.length > 40) fail("document complexity limit");
      const node = { name: match[1], attrs, children: [], text: "" };
      (stack.length ? stack.at(-1).children : roots).push(node);
      if (!self) stack.push(node);
    }
    if (stack.length || roots.length !== 1 || roots[0].name !== "feed" || roots[0].attrs.xmlns !== "http://www.w3.org/2005/Atom") fail("expected one complete Atom feed");
    return roots[0];
  }
  function parseEntries(xml) {
    const root = parse(xml);
    const children = (node, name) => node.children.filter((c) => c.name === name);
    const field = (node, name) => children(node, name)[0]?.text.trim().replace(/\s+/g, " ") || "";
    return children(root, "entry").map((entry) => {
      const rawId = field(entry, "id");
      const versioned = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "");
      if (rawId === versioned || !ID.test(versioned)) fail("error entry or invalid paper identity");
      const id = versioned.replace(/v\d+$/, ""), title = field(entry, "title");
      if (!title) fail("paper title is missing");
      const pdfLink = children(entry, "link").find((c) => c.attrs.type === "application/pdf" || c.attrs.title === "pdf");
      let pdf = `https://arxiv.org/pdf/${versioned}`;
      if (pdfLink) {
        let url;
        try {
          url = new URL(pdfLink.attrs.href);
        } catch {
          fail("invalid PDF URL");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "arxiv.org" || url.port || url.username || url.password || url.pathname !== `/pdf/${versioned}`) fail("untrusted PDF URL");
        url.protocol = "https:";
        pdf = url.href;
      }
      return {
        id,
        title,
        authors: children(entry, "author").map((a) => field(a, "name")).filter(Boolean).join(", "),
        abstract: field(entry, "summary"),
        published: field(entry, "published").slice(0, 10),
        updated: field(entry, "updated").slice(0, 10),
        primary_category: children(entry, "arxiv:primary_category")[0]?.attrs.term || "",
        categories: children(entry, "category").map((c) => c.attrs.term).filter(Boolean).join(", "),
        comment: field(entry, "arxiv:comment"),
        pdf,
        url: `https://arxiv.org/abs/${id}`
      };
    });
  }

  // webcli/scripts/opencli-wave4/upstream/arxiv/utils.js
  var ARXIV_BASE = "https://export.arxiv.org/api/query";
  var ARXIV_CATEGORY_PATTERN = /^[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?$/;
  async function arxivFetch(params) {
    const resp = await fetch(`${ARXIV_BASE}?${params}`);
    if (!resp.ok) {
      throw new CommandExecutionError(`arXiv API HTTP ${resp.status}`, "Check your search term or paper ID");
    }
    return resp.text();
  }
  function normalizeArxivLimit(value, defaultValue, maxValue, label = "limit") {
    const raw = value ?? defaultValue;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError(`arxiv ${label} must be a positive integer`);
    }
    if (limit > maxValue) {
      throw new ArgumentError(`arxiv ${label} must be <= ${maxValue}`);
    }
    return limit;
  }
  function normalizeArxivCategory(value) {
    const category = String(value || "").trim();
    if (!ARXIV_CATEGORY_PATTERN.test(category)) {
      throw new ArgumentError(`Invalid arXiv category "${value}". Examples: cs.CL, cs.LG, math.PR, q-bio.NC, physics.comp-ph`);
    }
    return category;
  }

  // webcli/scripts/opencli-wave4/upstream/arxiv/search.js
  cli({
    site: "arxiv",
    name: "search",
    access: "read",
    description: "Search arXiv papers",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "query", positional: true, required: true, help: 'Search keyword (e.g. "attention is all you need")' },
      { name: "limit", type: "int", default: 10, help: "Max results (max 25)" }
    ],
    columns: ["id", "title", "authors", "published", "primary_category", "url"],
    func: async (args) => {
      const queryText = String(args.query || "").trim();
      if (!queryText) {
        throw new ArgumentError("arxiv search query cannot be empty");
      }
      const limit = normalizeArxivLimit(args.limit, 10, 25);
      const query = encodeURIComponent(`all:${queryText}`);
      const xml = await arxivFetch(`search_query=${query}&max_results=${limit}&sortBy=relevance`);
      const entries = parseEntries(xml);
      if (!entries.length)
        throw new EmptyResultError("arxiv", "No papers found. Try a different keyword.");
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        authors: e.authors,
        published: e.published,
        primary_category: e.primary_category,
        url: e.url
      }));
    }
  });

  // webcli/scripts/opencli-wave4/upstream/arxiv/paper.js
  cli({
    site: "arxiv",
    name: "paper",
    access: "read",
    description: "Get arXiv paper details by ID",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "id", positional: true, required: true, help: "arXiv paper ID (e.g. 1706.03762)" }
    ],
    columns: ["id", "title", "authors", "published", "updated", "primary_category", "categories", "abstract", "comment", "pdf", "url"],
    func: async (args) => {
      const xml = await arxivFetch(`id_list=${encodeURIComponent(args.id)}`);
      const entries = parseEntries(xml);
      if (!entries.length)
        throw new EmptyResultError("arxiv paper", `Paper ${args.id} was not found. Check the arXiv ID format, e.g. 1706.03762`);
      return entries;
    }
  });

  // webcli/scripts/opencli-wave4/upstream/arxiv/author.js
  cli({
    site: "arxiv",
    name: "author",
    access: "read",
    description: "List arXiv papers by a given author (newest first)",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "author", positional: true, required: true, help: 'Author name (e.g. "Yoshua Bengio" or "Y Bengio")' },
      { name: "limit", type: "int", default: 20, help: "Max papers to return (max 50)" }
    ],
    columns: ["id", "title", "authors", "published", "primary_category", "url"],
    func: async (args) => {
      const authorText = String(args.author || "").trim();
      if (!authorText) {
        throw new ArgumentError("arxiv author cannot be empty", 'Example: opencli arxiv author "Yoshua Bengio"');
      }
      const limit = normalizeArxivLimit(args.limit, 20, 50);
      const query = encodeURIComponent(`au:"${authorText}"`);
      const xml = await arxivFetch(`search_query=${query}&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`);
      const entries = parseEntries(xml);
      if (!entries.length) {
        throw new EmptyResultError("arxiv author", `No papers found for author "${authorText}". Try alternate spellings (e.g. initials).`);
      }
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        authors: e.authors,
        published: e.published,
        primary_category: e.primary_category,
        url: e.url
      }));
    }
  });

  // webcli/scripts/opencli-wave4/upstream/arxiv/recent.js
  cli({
    site: "arxiv",
    name: "recent",
    access: "read",
    description: "List recent arXiv submissions in a category",
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
      { name: "category", positional: true, required: true, help: "arXiv category (e.g. cs.CL, cs.LG, math.PR, q-bio.NC)" },
      { name: "limit", type: "int", default: 10, help: "Max results (max 50)" }
    ],
    columns: ["id", "title", "authors", "published", "primary_category", "url"],
    func: async (args) => {
      const category = normalizeArxivCategory(args.category);
      const limit = normalizeArxivLimit(args.limit, 10, 50);
      const query = encodeURIComponent(`cat:${category}`);
      const xml = await arxivFetch(`search_query=${query}&max_results=${limit}&sortBy=submittedDate&sortOrder=descending`);
      const entries = parseEntries(xml);
      if (!entries.length)
        throw new EmptyResultError("arxiv", `No recent papers in ${category}. Check the category name.`);
      return entries.map((e) => ({
        id: e.id,
        title: e.title,
        authors: e.authors,
        published: e.published,
        primary_category: e.primary_category,
        url: e.url
      }));
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
