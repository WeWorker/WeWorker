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

  // webcli/scripts/opencli-wave5/upstream/gitee/search.js
  var GITEE_SEARCH_URL = "https://gitee.com/search";
  var GITEE_SEARCH_WIDGET = "wong1slagnlmzwvsu5ya";
  var GITEE_SEARCH_API = `https://so.gitee.com/v1/search/widget/${GITEE_SEARCH_WIDGET}`;
  var MAX_LIMIT = 50;
  function clampLimit(value) {
    const parsed = Number(value);
    if (Number.isNaN(parsed))
      return 10;
    return Math.max(1, Math.min(parsed, MAX_LIMIT));
  }
  function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function normalizeStars(value) {
    let raw = "";
    if (typeof value === "number")
      raw = String(value);
    else if (typeof value === "string")
      raw = value;
    else if (Array.isArray(value) && value.length > 0)
      raw = String(value[0] ?? "");
    const compact = normalizeText(raw).replace(/\s+/g, "");
    if (!compact)
      return "-";
    const match = compact.match(/\d+(?:[.,]\d+)?(?:[kKmMwW]|\u4E07)?/);
    return match ? match[0] : "-";
  }
  function getFirstText(value) {
    if (typeof value === "string")
      return value;
    if (typeof value === "number")
      return String(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number") {
          return String(item);
        }
      }
    }
    return "";
  }
  function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return value;
  }
  function normalizeUrl(value) {
    try {
      const parsed = new URL(value, "https://gitee.com");
      const host = parsed.hostname.toLowerCase();
      if (host !== "gitee.com" && host !== "www.gitee.com")
        return null;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length !== 2)
        return null;
      return `https://gitee.com/${parts[0]}/${parts[1]}`;
    } catch {
      return null;
    }
  }
  cli({
    site: "gitee",
    name: "search",
    access: "read",
    description: "Search repositories on Gitee",
    domain: "gitee.com",
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
      { name: "keyword", positional: true, required: true, help: "Search keyword" },
      { name: "limit", type: "int", default: 10, help: "Number of results (max 50)" }
    ],
    columns: ["rank", "name", "language", "stars", "description", "url"],
    func: async (page, args) => {
      const keyword = String(args.keyword ?? "").trim();
      if (!keyword) {
        throw new CliError("ARGUMENT", "Keyword is required", "Provide a search keyword");
      }
      const limit = clampLimit(args.limit);
      const encodedKeyword = encodeURIComponent(keyword);
      const searchUrl = `${GITEE_SEARCH_URL}?q=${encodedKeyword}&type=repository`;
      const fetchSize = Math.max(10, limit);
      const apiUrl = new URL(GITEE_SEARCH_API);
      apiUrl.searchParams.set("q", keyword);
      apiUrl.searchParams.set("from", "0");
      apiUrl.searchParams.set("size", String(fetchSize));
      const response = await fetch(apiUrl.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
          Referer: searchUrl
        }
      });
      if (!response.ok) {
        throw new CliError("COMMAND_EXEC", `Failed to request Gitee search API: ${response.status}`, "Try again later or verify network access to so.gitee.com");
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new CliError("COMMAND_EXEC", "Gitee search API did not return JSON", "Check whether so.gitee.com returned an interstitial page");
      }
      const payloadRecord = asRecord(payload);
      const hitsRecord = asRecord(payloadRecord?.hits);
      if (!hitsRecord || !Array.isArray(hitsRecord.hits)) {
        throw new CliError("COMMAND_EXEC", "Gitee search response structure not recognized", "Check whether the Gitee search API changed");
      }
      const rawRows = hitsRecord.hits;
      if (rawRows.length === 0) {
        throw new CliError("EMPTY_RESULT", "No Gitee repository search results found", "Try a different keyword");
      }
      const seen = /* @__PURE__ */ new Set();
      const rows = [];
      for (let i = 0; i < rawRows.length && rows.length < limit; i++) {
        const row = asRecord(rawRows[i]);
        const fields = asRecord(row?.fields);
        if (!fields)
          continue;
        const name = normalizeText(getFirstText(fields.title));
        const repoUrl = normalizeUrl(getFirstText(fields.url));
        if (!name || !repoUrl)
          continue;
        if (seen.has(repoUrl))
          continue;
        seen.add(repoUrl);
        rows.push({
          rank: rows.length + 1,
          name,
          language: normalizeText(getFirstText(fields.langs)) || "",
          description: normalizeText(getFirstText(fields.description)) || "",
          stars: normalizeStars(fields["count.star"]),
          url: repoUrl
        });
      }
      if (rows.length === 0) {
        throw new CliError("COMMAND_EXEC", "No valid Gitee repository results parsed", "Try a different keyword or check whether Gitee search API changed");
      }
      return rows;
    }
  });

  // webcli/scripts/opencli-wave5/utils.js
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // webcli/scripts/opencli-wave5/upstream/gitee/trending.js
  var GITEE_EXPLORE_URL = "https://gitee.com/explore";
  var MAX_LIMIT2 = 50;
  var MAX_DESCRIPTION_LENGTH = 48;
  var GITEE_HOSTS = /* @__PURE__ */ new Set(["gitee.com", "www.gitee.com"]);
  var RESERVED_SEGMENTS = /* @__PURE__ */ new Set([
    "about",
    "account",
    "ai",
    "all",
    "api",
    "apps",
    "blog",
    "contact",
    "dashboard",
    "docs",
    "enterprise",
    "enterprises",
    "explore",
    "features",
    "help",
    "issues",
    "login",
    "marketplace",
    "organizations",
    "pricing",
    "pulls",
    "security",
    "settings",
    "signup",
    "sitemap",
    "stars",
    "support",
    "terms",
    "users"
  ]);
  var STAR_KEYS = [
    "stars",
    "star",
    "stars_count",
    "star_count",
    "stargazers_count",
    "stargazer_count",
    "watch_count",
    "watchers_count"
  ];
  function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function normalizeStars2(value) {
    const compact = normalizeWhitespace(value).replace(/\s+/g, "");
    if (!compact)
      return "-";
    const match = compact.match(/\d+(?:[.,]\d+)?(?:[kKmMwW]|\u4E07)?/);
    return match ? match[0] : compact;
  }
  function compactDescription(value) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || normalized === "-")
      return "-";
    if (normalized.length <= MAX_DESCRIPTION_LENGTH)
      return normalized;
    return `${normalized.slice(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
  }
  function clampLimit2(value) {
    const parsed = Number(value);
    if (Number.isNaN(parsed))
      return 20;
    return Math.max(1, Math.min(parsed, MAX_LIMIT2));
  }
  function normalizeRepoUrl(value) {
    try {
      const parsed = new URL(value, "https://gitee.com");
      if (!GITEE_HOSTS.has(parsed.hostname.toLowerCase()))
        return null;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length !== 2)
        return null;
      const owner = parts[0];
      const repo = parts[1];
      if (RESERVED_SEGMENTS.has(owner.toLowerCase()) || RESERVED_SEGMENTS.has(repo.toLowerCase()))
        return null;
      return `https://gitee.com/${owner}/${repo}`;
    } catch {
      return null;
    }
  }
  function repoUrlFromPath(value) {
    const compact = value.trim().replace(/^\/+|\/+$/g, "");
    if (!compact.includes("/"))
      return null;
    return normalizeRepoUrl(`https://gitee.com/${compact}`);
  }
  function toCaptureProject(record) {
    const urlCandidates = [];
    const pushUrlCandidate = (raw) => {
      if (typeof raw !== "string")
        return;
      const normalized = normalizeRepoUrl(raw) ?? repoUrlFromPath(raw);
      if (normalized)
        urlCandidates.push(normalized);
    };
    pushUrlCandidate(record.url);
    pushUrlCandidate(record.html_url);
    pushUrlCandidate(record.project_url);
    pushUrlCandidate(record.web_url);
    pushUrlCandidate(record.path_with_namespace);
    pushUrlCandidate(record.name_with_namespace);
    pushUrlCandidate(record.full_name);
    pushUrlCandidate(record.fullName);
    pushUrlCandidate(record.path);
    const url = urlCandidates[0];
    if (!url)
      return null;
    let name = "";
    const nameCandidate = [
      record.name_with_namespace,
      record.full_name,
      record.fullName,
      record.path_with_namespace,
      record.name
    ].find((value) => typeof value === "string" && value.trim());
    if (typeof nameCandidate === "string") {
      name = normalizeWhitespace(nameCandidate.replace(/\s*\/\s*/g, "/"));
    }
    let description = "";
    const descCandidate = [
      record.description,
      record.desc,
      record.summary,
      record.project_description,
      record.intro,
      record.tagline
    ].find((value) => typeof value === "string" && value.trim());
    if (typeof descCandidate === "string") {
      description = normalizeWhitespace(descCandidate);
    }
    let stars = "";
    for (const key of STAR_KEYS) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        stars = String(value);
        break;
      }
      if (typeof value === "string" && value.trim()) {
        stars = value;
        break;
      }
    }
    return {
      url,
      name: name || void 0,
      description: description || void 0,
      stars: stars ? normalizeStars2(stars) : void 0
    };
  }
  function tryParseJson(raw) {
    const text = raw.trim();
    if (!text || !text.startsWith("{") && !text.startsWith("["))
      return null;
    try {
      return JSON.parse(text);
    } catch {
      const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (lastBrace <= 0)
        return null;
      const clipped = text.slice(0, lastBrace + 1);
      try {
        return JSON.parse(clipped);
      } catch {
        return null;
      }
    }
  }
  function parseCaptureBody(entry) {
    if (!isRecord(entry))
      return null;
    const preview = typeof entry.responsePreview === "string" ? entry.responsePreview : "";
    if (!preview || preview.startsWith("base64:"))
      return null;
    const contentType = typeof entry.responseContentType === "string" ? entry.responseContentType.toLowerCase() : "";
    if (contentType && !contentType.includes("json") && !contentType.includes("javascript") && !contentType.includes("text")) {
      return null;
    }
    return tryParseJson(preview);
  }
  function choosePreferredText(current, incoming) {
    if (!incoming || incoming === "-")
      return current;
    if (!current || current === "-")
      return incoming;
    return incoming.length > current.length ? incoming : current;
  }
  function collectProjectsFromUnknown(value, out, seen, depth) {
    if (depth > 8 || value === null || value === void 0 || typeof value !== "object")
      return;
    if (seen.has(value))
      return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        collectProjectsFromUnknown(item, out, seen, depth + 1);
      }
      return;
    }
    const record = value;
    const candidate = toCaptureProject(record);
    if (candidate) {
      const previous = out.get(candidate.url);
      if (!previous) {
        out.set(candidate.url, candidate);
      } else {
        out.set(candidate.url, {
          url: candidate.url,
          name: choosePreferredText(previous.name, candidate.name),
          description: choosePreferredText(previous.description, candidate.description),
          stars: previous.stars && previous.stars !== "-" ? previous.stars : candidate.stars
        });
      }
    }
    for (const child of Object.values(record)) {
      collectProjectsFromUnknown(child, out, seen, depth + 1);
    }
  }
  function collectProjectsFromCapture(entries) {
    const collected = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const body = parseCaptureBody(entry);
      if (body !== null) {
        collectProjectsFromUnknown(body, collected, seen, 0);
      }
    }
    return collected;
  }
  function toProject(value) {
    if (!value || typeof value !== "object")
      return null;
    const row = value;
    const name = typeof row.name === "string" ? normalizeWhitespace(row.name) : "";
    const urlRaw = typeof row.url === "string" ? row.url.trim() : "";
    const url = normalizeRepoUrl(urlRaw);
    if (!name || !url)
      return null;
    const description = typeof row.description === "string" ? normalizeWhitespace(row.description) : "";
    const stars = typeof row.stars === "string" ? normalizeStars2(row.stars) : "-";
    return {
      name,
      description: description || "-",
      stars,
      url
    };
  }
  function mergeCapturedProject(project, captured) {
    if (!captured)
      return project;
    const mergedName = captured.name ? normalizeWhitespace(captured.name) : "";
    const mergedDescription = captured.description ? normalizeWhitespace(captured.description) : "";
    const mergedStars = captured.stars ? normalizeStars2(captured.stars) : "-";
    return {
      name: mergedName && mergedName.length <= 120 ? mergedName : project.name,
      description: project.description !== "-" ? project.description : mergedDescription || "-",
      stars: project.stars !== "-" ? project.stars : mergedStars,
      url: project.url
    };
  }
  cli({
    site: "gitee",
    name: "trending",
    access: "read",
    description: "Recommended open-source projects on Gitee Explore",
    domain: "gitee.com",
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of projects (max 50)" }
    ],
    columns: ["name", "description", "stars", "url"],
    func: async (page, args) => {
      const limit = clampLimit2(args.limit);
      let projectsFromCapture = /* @__PURE__ */ new Map();
      if (page.startNetworkCapture) {
        try {
          await page.startNetworkCapture("gitee.com");
        } catch {
        }
      }
      await page.goto(GITEE_EXPLORE_URL);
      await page.wait(3);
      if (page.readNetworkCapture) {
        try {
          const captureEntries = await page.readNetworkCapture();
          projectsFromCapture = collectProjectsFromCapture(captureEntries);
        } catch {
        }
      }
      const rawProjects = await page.evaluate(`
      (() => {
        const RESERVED = new Set([
          'about',
          'account',
          'ai',
          'all',
          'api',
          'apps',
          'blog',
          'contact',
          'dashboard',
          'docs',
          'enterprise',
          'enterprises',
          'explore',
          'features',
          'help',
          'issues',
          'login',
          'marketplace',
          'organizations',
          'pricing',
          'pulls',
          'security',
          'settings',
          'signup',
          'sitemap',
          'stars',
          'support',
          'terms',
          'users',
        ]);

        const KEYWORDS = [
          '\\u63A8\\u8350\\u5F00\\u6E90\\u9879\\u76EE',
          '\\u63A8\\u8350\\u9879\\u76EE',
          '\\u63A8\\u8350\\u4ED3\\u5E93',
          'Recommended Projects',
        ];
        const STAR_TOKEN = /(\\d+(?:[.,]\\d+)?(?:\\s*[kKmMwW\\u4E07])?)/;

        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();

        const toRepoUrl = (href) => {
          if (!href) return '';
          try {
            const url = new URL(href, location.origin);
            if (url.origin !== location.origin) return '';

            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length !== 2) return '';

            const owner = parts[0].toLowerCase();
            const repo = parts[1].toLowerCase();
            if (RESERVED.has(owner) || RESERVED.has(repo)) return '';

            return url.origin + '/' + parts[0] + '/' + parts[1];
          } catch {
            return '';
          }
        };

        const scoreCard = (node) => {
          const text = normalize(node.textContent || '');
          const linkCount = node.querySelectorAll('a[href]').length;
          if (!text || linkCount > 45) return -Infinity;

          const hasDesc = !!node.querySelector('.project-desc, .project-description, .description, .desc, [class*="desc"], [class*="intro"], [class*="summary"], p');
          const hasMetric = !!node.querySelector('a[href*="stargazers"], a[href*="stars"], [class*="star"], [class*="collect"], [class*="watch"], [aria-label*="star" i], [title*="star" i]');
          let score = Math.min(text.length, 1200) - linkCount * 6;
          if (hasDesc) score += 260;
          if (hasMetric) score += 360;
          if (/(?:stars?|star|stargazers?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E|\u2605|\u2B50)/i.test(text)) score += 220;
          return score;
        };

        const pickCard = (link) => {
          let best = link;
          let bestScore = scoreCard(link);
          let node = link;
          for (let i = 0; i < 7 && node.parentElement; i++) {
            node = node.parentElement;
            const score = scoreCard(node);
            if (score > bestScore) {
              best = node;
              bestScore = score;
            }
          }
          return best;
        };

        const extractStars = (card) => {
          const classToken = /(star|stargazer|collect|watch)/i;
          const metricNodes = card.querySelectorAll(
            'a[href*="stargazers"], a[href*="stars"], [class*="star"], [class*="collect"], [class*="watch"], [aria-label*="star" i], [title*="star" i], span, strong, small, em, div'
          );
          for (const node of metricNodes) {
            const className = String(node.className || '');
            const raw = normalize([
              node.textContent || '',
              node.getAttribute?.('title') || '',
              node.getAttribute?.('aria-label') || '',
              node.nextElementSibling?.textContent || '',
            ].join(' '));
            if (!raw) continue;
            if (!/(?:stars?|star|stargazers?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E|\u2605|\u2B50)/i.test(raw) && !classToken.test(className)) continue;
            const match = raw.match(STAR_TOKEN);
            if (match) return match[1].replace(/\\s+/g, '');
          }

          const directStar = card.querySelector(
            '.project-stars-count-box .stars-count, .stars-count, [class*="stars-count"], [class*="starsCount"]'
          );
          const directStarText = normalize(directStar?.textContent || '');
          const directMatch = directStarText.match(STAR_TOKEN);
          if (directMatch) return directMatch[1].replace(/\\s+/g, '');

          const text = normalize(card.textContent || '');
          const patterns = [
            /(?:stars?|star|stargazers?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E)\\s*[:\uFF1A]?\\s*(\\d+(?:[.,]\\d+)?(?:\\s*[kKmMwW\\u4E07])?)/i,
            /(\\d+(?:[.,]\\d+)?(?:\\s*[kKmMwW\\u4E07])?)\\s*(?:stars?|star|stargazers?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E)/i,
            /[\u2605\u2B50]\\s*(\\d+(?:[.,]\\d+)?(?:\\s*[kKmMwW\\u4E07])?)/,
          ];

          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) return match[1].replace(/\\s+/g, '');
          }

          return '';
        };

        const pickDescription = (card, name) => {
          const directNodes = Array.from(
            card.querySelectorAll('.project-desc, .project-description, .description, .desc, [class*="description"], [class*="desc"], [class*="intro"], [class*="summary"], p')
          );

          const seen = new Set();
          const candidates = [];
          for (const node of directNodes) {
            const textCandidates = [
              node.textContent || '',
              node.getAttribute?.('title') || '',
              node.getAttribute?.('aria-label') || '',
            ].map((value) => normalize(value || '')).filter(Boolean);

            for (const text of textCandidates) {
              if (!text || text === name || seen.has(text)) continue;
              if (text.length < 6 || text.length > 320) continue;
              if (/^(?:stars?|star|fork|issues?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E|\\d+(?:[.,]\\d+)?)$/i.test(text)) continue;
              seen.add(text);
              candidates.push(text);
            }
          }
          if (candidates.length > 0) {
            candidates.sort((left, right) => right.length - left.length);
            return candidates[0];
          }

          const text = normalize(card.textContent || '')
            .replace(/window\\.gon\\._errorText\\s*=\\s*"[^"]*"/g, '');
          if (!text) return '-';
          const cleaned = text
            .replace(name, '')
            .replace(/(?:stars?|star|stargazers?|fork|issues?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E)\\s*[:\uFF1A]?\\s*\\d+(?:[.,]\\d+)?(?:\\s*[kKmMwW\\u4E07])?/ig, '')
            .replace(/\\d+(?:[.,]\\d+)?(?:\\s*[kKmMwW\\u4E07])?\\s*(?:stars?|star|stargazers?|\\u6536\\u85CF|\\u5173\\u6CE8|\\u70B9\\u8D5E)/ig, '')
            .replace(/\\|\\s*\\d+\\s*(?:\\u79D2\\u524D|\\u5206\\u949F\\u524D|\\u5C0F\\u65F6\\u524D|\\u5929\\u524D)/g, '')
            .replace(/\\s+/g, ' ')
            .trim();
          return cleaned ? cleaned.slice(0, 300) : '-';
        };

        const countRepoLinks = (root) => {
          const links = root.querySelectorAll('a[href]');
          let count = 0;
          for (const link of links) {
            if (toRepoUrl(link.getAttribute('href') || '')) count++;
          }
          return count;
        };

        let root = document;
        const headingNodes = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, div, span'))
          .filter((node) => {
            const text = normalize(node.textContent || '');
            if (!text || text.length > 20) return false;
            return KEYWORDS.some((keyword) => text.includes(keyword));
          });

        let bestCount = 0;
        for (const heading of headingNodes) {
          let candidate = heading;
          for (let i = 0; i < 4 && candidate.parentElement; i++) {
            candidate = candidate.parentElement;
            const count = countRepoLinks(candidate);
            if (count > bestCount) {
              bestCount = count;
              root = candidate;
            }
          }
        }

        const seen = new Set();
        const projects = [];
        const collect = (scope) => {
          const links = scope.querySelectorAll('a[href]');
          for (const link of links) {
            const url = toRepoUrl(link.getAttribute('href') || '');
            if (!url || seen.has(url)) continue;

            const card = pickCard(link);
            const titleAttr = normalize(link.getAttribute('title') || '');
            const nameText = normalize(link.textContent || '');
            const pathParts = new URL(url).pathname.split('/').filter(Boolean);
            const fallbackName = pathParts.join('/');
            const nameCandidate = titleAttr || nameText;
            const name = (nameCandidate && nameCandidate.length <= 120
              ? nameCandidate.replace(/\\s*\\/\\s*/g, '/')
              : fallbackName) || fallbackName;
            if (!name) continue;

            projects.push({
              name,
              description: pickDescription(card, name),
              stars: extractStars(card),
              url,
            });
            seen.add(url);
          }
        };

        collect(root);
        if (projects.length < 8 && root !== document) {
          collect(document);
        }

        return projects;
      })()
    `);
      if (!Array.isArray(rawProjects)) {
        throw new CliError("COMMAND_EXEC", "Failed to parse Gitee Explore page", "Gitee may have changed its page structure");
      }
      const projects = rawProjects.map(toProject).filter((project) => project !== null).map((project) => mergeCapturedProject(project, projectsFromCapture.get(project.url))).map((project) => ({
        ...project,
        description: compactDescription(project.description)
      })).slice(0, limit);
      if (projects.length === 0) {
        throw new CliError("COMMAND_EXEC", "No recommended projects found on Gitee Explore", "Gitee may be blocking this request or the page structure changed");
      }
      return projects;
    }
  });

  // webcli/scripts/opencli-wave5/upstream/gitee/user.js
  var GITEE_BASE_URL = "https://gitee.com";
  var GITEE_USER_API = "https://gitee.com/api/v5/users";
  function normalizeText2(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function sanitizeUsername(value) {
    return value.trim().replace(/^@+/, "").replace(/^\/+|\/+$/g, "");
  }
  function asRecord2(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return value;
  }
  function firstText(value) {
    if (typeof value === "string")
      return normalizeText2(value);
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = firstText(item);
        if (text)
          return text;
      }
    }
    return "";
  }
  function normalizeCount(value) {
    const raw = firstText(value);
    if (!raw)
      return "";
    const compact = raw.replace(/,/g, "");
    const match = compact.match(/\d+(?:[.]\d+)?(?:[kKmMwW]|\u4E07)?/);
    if (match)
      return match[0];
    return "";
  }
  function pickFirst(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim())
        return value.trim();
    }
    return "";
  }
  function apiGiteeIndex(user) {
    if (!user)
      return "";
    const keys = [
      "gitee_index",
      "giteeIndex",
      "index",
      "score",
      "contribution_score",
      "contributionScore",
      "contribution_index",
      "contributionIndex"
    ];
    for (const key of keys) {
      const value = normalizeCount(user[key]);
      if (value)
        return value;
    }
    return "";
  }
  cli({
    site: "gitee",
    name: "user",
    access: "read",
    description: "Show a Gitee user profile panel",
    domain: "gitee.com",
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
      { name: "username", positional: true, required: true, help: "Gitee username" }
    ],
    columns: ["field", "value"],
    func: async (page, args) => {
      const username = sanitizeUsername(String(args.username ?? ""));
      if (!username) {
        throw new CliError("ARGUMENT", "Username is required", "Use: webcli call gitee.com.user --username=<name>");
      }
      const profileUrl = `${GITEE_BASE_URL}/${encodeURIComponent(username)}`;
      await page.goto(profileUrl);
      await page.wait(2);
      const rawDomSnapshot = await page.evaluate(`
      (() => {
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const extractCount = (value) => {
          const text = normalize(value).replace(/,/g, '');
          if (!text) return '';
          const match = text.match(/\\d+(?:[.]\\d+)?(?:\\s*[kKmMwW\\u4E07])?/);
          return match ? match[0].replace(/\\s+/g, '') : '';
        };

        const title = normalize(document.title || '');
        const bodyText = normalize(document.body?.innerText || '');
        const notFound = /404|\u9875\u9762\u4E0D\u5B58\u5728|\u8D44\u6E90\u4E0D\u5B58\u5728|page not found/i.test(title + ' ' + bodyText);
        const blocked = /\u8BBF\u95EE\u53D7\u9650|\u6CA1\u6709\u8BBF\u95EE\u6743\u9650|forbidden|denied/i.test(bodyText);

        const nicknameCandidates = Array.from(
          document.querySelectorAll('.users__personal-name h2 span[title], .users__personal-name h2 [title], .users__personal-name h2 span, .users__personal-name h2, h1'),
        );
        const nicknameNode = nicknameCandidates.find((node) => {
          const titleAttr = node && node.getAttribute ? node.getAttribute('title') : '';
          const text = normalize((titleAttr || node.textContent || '').replace(/\\(\\s*\u5907\u6CE8\u540D\\s*\\)/g, ''));
          return !!text && !/\u5907\u6CE8\u540D/.test(text);
        }) || null;
        const nicknameFromAttr = nicknameNode && nicknameNode.getAttribute ? nicknameNode.getAttribute('title') : '';
        const nickname = normalize((nicknameFromAttr || nicknameNode?.textContent || '').replace(/\\(\\s*\u5907\u6CE8\u540D\\s*\\)/g, ''));

        let followers = extractCount(document.querySelector('#followers-number .social-count, #followers-number .follow-num')?.textContent || '');
        if (!followers) {
          const card = Array.from(document.querySelectorAll('.users__personal-socials .four.wide.column, .users__personal-socials [class*="column"]'))
            .find((el) => /followers/i.test(normalize(el.textContent || '')));
          if (card) followers = extractCount(card.textContent || '');
        }

        let publicRepos = '';
        const projectLink = Array.from(document.querySelectorAll('a[href]'))
          .find((el) => /\\/[^/?#]+\\/projects(?:$|[/?#])/i.test(el.getAttribute('href') || ''));
        if (projectLink) publicRepos = extractCount(projectLink.textContent || '');

        let giteeIndex = '';
        const indexNodes = Array.from(
          document.querySelectorAll('.users__personal-info *, .users__personal-container *, [class*="index" i], [id*="index" i], [class*="score" i], [id*="score" i]'),
        );
        for (const node of indexNodes) {
          const text = normalize(node.textContent || '');
          if (!/(\u7801\u4E91\u6307\u6570|gitee\\s*index|gitee\\s*\u6307\u6570)/i.test(text)) continue;

          const direct = text.match(/(?:\u7801\u4E91\u6307\u6570|gitee\\s*index|gitee\\s*\u6307\u6570)[:\uFF1A]?\\s*(\\d+(?:[.]\\d+)?(?:\\s*[kKmMwW\\u4E07])?)/i);
          if (direct?.[1]) {
            giteeIndex = direct[1].replace(/\\s+/g, '');
            break;
          }

          const siblingText = normalize(node.nextElementSibling?.textContent || '');
          const parentText = normalize(node.parentElement?.textContent || '');
          const around = extractCount(siblingText + ' ' + parentText);
          if (around) {
            giteeIndex = around;
            break;
          }
        }

        return {
          notFound,
          blocked,
          nickname,
          followers,
          publicRepos,
          giteeIndex,
        };
      })()
    `);
      const domSnapshotRecord = asRecord2(rawDomSnapshot);
      const domSnapshot = {
        notFound: domSnapshotRecord?.notFound === true,
        blocked: domSnapshotRecord?.blocked === true,
        nickname: firstText(domSnapshotRecord?.nickname),
        followers: normalizeCount(domSnapshotRecord?.followers),
        publicRepos: normalizeCount(domSnapshotRecord?.publicRepos),
        giteeIndex: normalizeCount(domSnapshotRecord?.giteeIndex)
      };
      if (domSnapshot.notFound) {
        throw new CliError("EMPTY_RESULT", `Gitee user "${username}" does not exist`, "Check the username and retry: webcli call gitee.com.user --username=<name>");
      }
      if (domSnapshot.blocked) {
        throw new CliError("COMMAND_EXEC", `Gitee user page "${username}" is not accessible`, "The profile may be private/restricted, or the account may be unavailable");
      }
      const apiUrl = `${GITEE_USER_API}/${encodeURIComponent(username)}`;
      const apiResponse = await fetch(apiUrl, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
          Referer: profileUrl
        }
      });
      if (apiResponse.status === 404) {
        throw new CliError("EMPTY_RESULT", `Gitee user "${username}" does not exist`, "Check the username and retry: webcli call gitee.com.user --username=<name>");
      }
      if (!apiResponse.ok) {
        throw new CliError("COMMAND_EXEC", `Failed to read Gitee user profile API: ${apiResponse.status}`, "Try again later or verify network access to gitee.com");
      }
      let apiUser;
      try {
        apiUser = asRecord2(await apiResponse.json());
      } catch {
        throw new CliError("COMMAND_EXEC", "Gitee user profile API did not return JSON", "Try again later or verify network access to gitee.com");
      }
      const nickname = pickFirst(domSnapshot.nickname, firstText(apiUser?.name), firstText(apiUser?.login), username);
      const followers = pickFirst(domSnapshot.followers, normalizeCount(apiUser?.followers), "-");
      const publicRepos = pickFirst(domSnapshot.publicRepos, normalizeCount(apiUser?.public_repos), "-");
      const giteeIndex = pickFirst(domSnapshot.giteeIndex, apiGiteeIndex(apiUser), "-");
      return [
        { field: "Nickname", value: nickname },
        { field: "Followers", value: followers },
        { field: "Public Repositories", value: publicRepos },
        { field: "Gitee Index", value: giteeIndex },
        { field: "URL", value: profileUrl }
      ];
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

  // webcli/scripts/opencli-wave5/upstream/gitee/auth.js
  var WHOAMI_PROBE = `(async () => {
  try {
    const r = await fetch('/api/v5/user', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return { kind: 'auth', detail: 'Gitee /api/v5/user HTTP ' + r.status };
    if (!r.ok) return { kind: 'http', httpStatus: r.status };
    const d = await r.json();
    if (!d || !d.id || !d.login) return { kind: 'auth', detail: 'Gitee /api/v5/user has no id/login \u2014 anonymous' };
    return { ok: true, user_id: String(d.id), username: String(d.login), name: String(d.name || '') };
  } catch (e) {
    return { kind: 'exception', detail: String(e && e.message || e) };
  }
})()`;
  async function verifyGiteeIdentity(page) {
    await page.goto("https://gitee.com/");
    await page.wait(1);
    const probe = await page.evaluate(WHOAMI_PROBE);
    if (probe?.kind === "auth") throw new AuthRequiredError("gitee.com", probe.detail);
    if (probe?.kind === "http") throw new CommandExecutionError(`HTTP ${probe.httpStatus} from Gitee /api/v5/user`);
    if (probe?.kind === "exception") throw new CommandExecutionError(`Gitee whoami failed: ${probe.detail}`);
    if (!probe?.ok) throw new CommandExecutionError(`Unexpected Gitee probe: ${JSON.stringify(probe)}`);
    return { user_id: probe.user_id, username: probe.username, name: probe.name };
  }
  registerSiteAuthCommands({
    site: "gitee",
    domain: "gitee.com",
    loginUrl: "https://gitee.com/login",
    columns: ["user_id", "username", "name"],
    verify: verifyGiteeIdentity,
    poll: async (page) => {
      const probe = await page.evaluate(WHOAMI_PROBE);
      if (!probe?.ok) throw new AuthRequiredError("gitee.com", "Waiting for Gitee login");
      return { user_id: probe.user_id, username: probe.username, name: probe.name };
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
