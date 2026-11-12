/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
"use strict";
(() => {
  // port:errors
  var { CliError, ArgumentError, CommandExecutionError, AuthRequiredError, EmptyResultError } = window.__zhihu;

  // OpenCLI/clis/zhihu/user-arg.js
  var fetch = window.__zhihu.safeFetch;
  var SLUG_RE = /^[A-Za-z0-9_-]+$/;
  var USER_PREFIX_RE = /^user:([A-Za-z0-9_-]+)$/;
  var PEOPLE_PATH_RE = /^\/people\/([A-Za-z0-9_-]+)\/?$/;
  function parseZhihuUser(input) {
    const value = String(input ?? "").trim();
    if (!value) {
      throw new CliError("INVALID_INPUT", "A Zhihu user is required", "Example: opencli zhihu user wen-jie-16-47");
    }
    const prefixMatch = value.match(USER_PREFIX_RE);
    if (prefixMatch) return prefixMatch[1];
    if (SLUG_RE.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "www.zhihu.com") {
        const m = url.pathname.match(PEOPLE_PATH_RE);
        if (m) return m[1];
      }
    } catch {
    }
    throw new CliError(
      "INVALID_INPUT",
      `Invalid Zhihu user: ${value}`,
      "Use a url_token (wen-jie-16-47) or a people URL (https://www.zhihu.com/people/wen-jie-16-47)"
    );
  }

  // OpenCLI/clis/zhihu/paginate.js
  var fetch2 = window.__zhihu.safeFetch;
  var MAX_LIMIT = 1e3;
  function validateLimit(raw, fallback = 20) {
    const value = raw ?? fallback;
    let limit;
    if (typeof value === "number") {
      limit = value;
    } else {
      const text = String(value).trim();
      if (!/^\d+$/.test(text)) {
        throw new ArgumentError(`--limit must be a positive integer no greater than ${MAX_LIMIT}`, "Use a normal-sized decimal integer limit to avoid slow requests or Zhihu risk controls");
      }
      limit = Number(text);
    }
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new ArgumentError(`--limit must be a positive integer no greater than ${MAX_LIMIT}`, "Use a normal-sized decimal integer limit to avoid slow requests or Zhihu risk controls");
    }
    return limit;
  }
  function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
    return payload;
  }
  function requireZhihuListPayload(payload, label, url) {
    const data = unwrapEvaluateResult(payload);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new CommandExecutionError(`Zhihu ${label} returned malformed payload`, `URL: ${url}`);
    }
    if (data.__httpError) {
      const status = data.__httpError;
      if (status === 401 || status === 403) {
        throw new AuthRequiredError("www.zhihu.com", `Failed to fetch Zhihu ${label}`);
      }
      if (status === 404) {
        throw new EmptyResultError(`zhihu ${label}`, "Check the target identifier");
      }
      throw new CommandExecutionError(`Zhihu ${label} request failed${status ? ` (HTTP ${status})` : ""}`, "Try again later or rerun with -v");
    }
    if (data.__fetchError) {
      throw new CommandExecutionError(`Zhihu ${label} request failed`, String(data.__fetchError));
    }
    if (!Array.isArray(data.data)) {
      throw new CommandExecutionError(`Zhihu ${label} returned malformed data list`, `URL: ${url}`);
    }
    if (!data.paging || typeof data.paging !== "object") {
      throw new CommandExecutionError(`Zhihu ${label} returned malformed paging data`, `URL: ${url}`);
    }
    return data;
  }
  function normalizeZhihuApiUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      url.protocol = "https:";
      if (url.hostname === "api.zhihu.com" && url.pathname.startsWith("/members/")) {
        return `https://www.zhihu.com/api/v4${url.pathname}${url.search}`;
      }
      if (url.hostname === "www.zhihu.com" && url.pathname.startsWith("/api/v4/members/")) {
        return url.toString();
      }
    } catch {
      return "";
    }
    return "";
  }
  function sameZhihuApiPath(a, b) {
    try {
      return new URL(a).pathname === new URL(b).pathname;
    } catch {
      return false;
    }
  }
  async function fetchZhihuList(firstUrl, limit, label) {
    const items = [];
    const visited = /* @__PURE__ */ new Set();
    let url = firstUrl;
    while (url && items.length < limit && !visited.has(url)) {
      visited.add(url);
      const data = requireZhihuListPayload(await ((__portValue0) => (async () => {
        try {
          const r = await fetch2(__portValue0, { credentials: "include" });
          if (!r.ok) return { __httpError: r.status };
          return await r.json();
        } catch (err) {
          return { __fetchError: err?.message || String(err) };
        }
      })())(url), label, url);
      for (const item of data.data) {
        items.push(item);
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
      if (data.paging?.is_end) break;
      const next = normalizeZhihuApiUrl(data.paging?.next);
      if (!next || !sameZhihuApiPath(next, firstUrl)) {
        throw new CommandExecutionError(`Zhihu ${label} pagination returned malformed next URL`);
      }
      if (visited.has(next)) {
        throw new CommandExecutionError(`Zhihu ${label} pagination returned a repeated next URL`);
      }
      url = next;
    }
    if (items.length === 0) {
      throw new EmptyResultError(`zhihu ${label}`, "No rows were returned for the requested Zhihu user.");
    }
    return items;
  }

  // OpenCLI/clis/zhihu/user-articles.js
  var fetch3 = window.__zhihu.safeFetch;
  var INCLUDE = "data[*].voteup_count,comment_count";
  __webcliRegisterCommand("user-articles", async (args = {}) => {
    args = { ...{ "limit": 20 }, ...args };
    {
      const raw = args["limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["limit"] = Number(raw);
    }
    return (async (kwargs) => {
      const slug = parseZhihuUser(kwargs.user);
      const limit = validateLimit(kwargs.limit);
      if (!window.__zhihu.ready("https://www.zhihu.com")) return window.__zhihu.navigate("https://www.zhihu.com");
      window.__zhihu.guard();
      const first = `https://www.zhihu.com/api/v4/members/${encodeURIComponent(slug)}/articles?limit=20&offset=0&include=${encodeURIComponent(INCLUDE)}`;
      const items = await fetchZhihuList(first, limit, "user articles");
      return items.map((a, i) => {
        if (!a.id || !a.title) {
          throw new CommandExecutionError("Zhihu user articles returned malformed row identity");
        }
        return {
          rank: i + 1,
          title: String(a.title || ""),
          context_title: window.__zhihu.contextTitle(a.title),
          votes: a.voteup_count ?? null,
          comments: a.comment_count ?? null,
          created: a.created ?? a.updated ?? null,
          url: `https://zhuanlan.zhihu.com/p/${a.id}`
        };
      });
    })(args);
  });
})();
