/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
"use strict";
(() => {
  // port:errors
  var { CliError, ArgumentError, CommandExecutionError, AuthRequiredError, EmptyResultError } = window.__zhihu;

  // OpenCLI/clis/zhihu/text.js
  var fetch = window.__zhihu.safeFetch;
  function decodeEntity(codePoint) {
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : null;
  }
  function stripHtml(html, { preserveBlocks = false } = {}) {
    if (!html) return "";
    let text = String(html);
    if (preserveBlocks) {
      text = text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, "\n\n");
    }
    return text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (entity, value) => decodeEntity(Number(value)) ?? entity).replace(/&#x([0-9a-f]+);/gi, (entity, value) => decodeEntity(Number.parseInt(value, 16)) ?? entity).replace(/\n{3,}/g, "\n\n").trim();
  }

  // OpenCLI/clis/zhihu/search.js
  var fetch2 = window.__zhihu.safeFetch;
  function itemKey(item) {
    const obj = item.object || {};
    if (obj.id != null) return `${obj.type || ""}:${obj.id}`;
    return null;
  }
  function itemUrl(obj) {
    const id = obj.id == null ? "" : String(obj.id);
    if (obj.type === "answer") {
      const questionId = obj.question?.id == null ? "" : String(obj.question.id);
      return questionId && id ? `https://www.zhihu.com/question/${questionId}/answer/${id}` : "";
    }
    if (obj.type === "article") {
      return id ? `https://zhuanlan.zhihu.com/p/${id}` : "";
    }
    if (obj.type === "question") {
      return id ? `https://www.zhihu.com/question/${id}` : "";
    }
    return "";
  }
  function normalizeSearchUrl(url) {
    if (typeof url !== "string" || !url) return "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "api.zhihu.com" && parsed.pathname === "/search_v3") {
        return `https://www.zhihu.com/api/v4/search_v3${parsed.search}`;
      }
      if (parsed.hostname === "www.zhihu.com" && parsed.pathname === "/api/v4/search_v3") {
        return parsed.toString();
      }
    } catch {
      return "";
    }
    return "";
  }
  var MAX_LIMIT = 1e3;
  var PAGE_SIZE = 20;
  var TYPES = ["all", "answer", "article", "question"];
  function parseLimit(value) {
    const limit = Number(value ?? 10);
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new ArgumentError(`zhihu search --limit must be a positive integer no greater than ${MAX_LIMIT}`, "Use a normal-sized limit to avoid slow requests or Zhihu risk controls");
    }
    return limit;
  }
  function requireQuery(value) {
    const query = String(value || "").trim();
    if (!query) {
      throw new ArgumentError("zhihu search query must not be empty", "Example: opencli zhihu search codex");
    }
    return query;
  }
  function requireType(value) {
    const type = String(value || "all");
    if (!TYPES.includes(type)) {
      throw new ArgumentError(`zhihu search --type must be one of: ${TYPES.join(", ")}`, "Example: opencli zhihu search codex --type answer");
    }
    return type;
  }
  function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
    return payload;
  }
  function requireSearchPayload(data, url) {
    const payload = unwrapEvaluateResult(data);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CommandExecutionError("Zhihu search returned malformed payload");
    }
    if (payload.__httpError) {
      const status = payload.__httpError;
      if (status === 401 || status === 403) {
        throw new AuthRequiredError("www.zhihu.com", "Failed to fetch search results from Zhihu");
      }
      throw new CommandExecutionError(`Zhihu search request failed${status ? ` (HTTP ${status})` : ""}`, "Try again later or rerun with -v for more detail");
    }
    if (payload.__fetchError) {
      throw new CommandExecutionError("Zhihu search request failed", String(payload.__fetchError));
    }
    if (!Array.isArray(payload.data)) {
      throw new CommandExecutionError("Zhihu search returned malformed data list", `URL: ${url}`);
    }
    if (!payload.paging || typeof payload.paging !== "object") {
      throw new CommandExecutionError("Zhihu search returned malformed paging data", `URL: ${url}`);
    }
    return payload;
  }
  function normalizeResultItem(item) {
    if (!item || typeof item !== "object" || item.type !== "search_result" || !item.object || typeof item.object !== "object") {
      return null;
    }
    const obj = item.object;
    if (obj.type !== "answer" && obj.type !== "article" && obj.type !== "question") return null;
    const key = itemKey(item);
    const url = itemUrl(obj);
    const question = obj.question || {};
    const title = stripHtml(obj.title || question.name || question.title || "");
    if (!key || !url || !title) {
      throw new CommandExecutionError("Zhihu search returned malformed result row identity");
    }
    return {
      item,
      key,
      row: {
        title,
        context_title: window.__zhihu.contextTitle(title),
        question_id: obj.type === 'question' ? (obj.id == null ? null : String(obj.id)) : question.id == null ? null : String(question.id),
        type: obj.type,
        author: obj.author?.name || "",
        votes: obj.voteup_count || 0,
        url
      }
    };
  }
  __webcliRegisterCommand("search", async (args = {}) => {
    args = { ...{ "limit": 10, "type": "all" }, ...args };
    {
      const raw = args["limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["limit"] = Number(raw);
    }
    return (async (kwargs) => {
      const query = requireQuery(kwargs.query);
      const resultLimit = parseLimit(kwargs.limit);
      const type = requireType(kwargs.type);
      if (!window.__zhihu.ready("https://www.zhihu.com")) return window.__zhihu.navigate("https://www.zhihu.com");
      window.__zhihu.guard();
      let url = `https://www.zhihu.com/api/v4/search_v3?q=${encodeURIComponent(query)}&t=general&offset=0&limit=${PAGE_SIZE}`;
      const results = [];
      const seen = /* @__PURE__ */ new Set();
      const visited = /* @__PURE__ */ new Set();
      while (url && results.length < resultLimit && !visited.has(url)) {
        visited.add(url);
        const data = requireSearchPayload(await ((__portValue0) => (async () => {
          try {
            const r = await fetch2(__portValue0, { credentials: "include" });
            if (!r.ok) return { __httpError: r.status };
            return await r.json();
          } catch (err) {
            return { __fetchError: err?.message || String(err) };
          }
        })())(url), url);
        for (const item of data.data) {
          const rawType = item?.object?.type;
          if (type !== "all" && rawType && rawType !== type) continue;
          const normalized = normalizeResultItem(item);
          if (!normalized) continue;
          if (type !== "all" && normalized.row.type !== type) continue;
          if (seen.has(normalized.key)) continue;
          seen.add(normalized.key);
          results.push(normalized.row);
          if (results.length >= resultLimit) break;
        }
        if (results.length >= resultLimit) break;
        if (data.paging?.is_end) break;
        const next = normalizeSearchUrl(data.paging?.next);
        if (!next) {
          throw new CommandExecutionError("Zhihu search pagination returned malformed next URL");
        }
        if (visited.has(next)) {
          throw new CommandExecutionError("Zhihu search pagination returned a repeated next URL");
        }
        url = next;
      }
      if (results.length === 0) {
        throw new EmptyResultError("zhihu search", `No ${type === "all" ? "" : `${type} `}results found for "${query}"`);
      }
      return results.map((row, i) => {
        return {
          rank: i + 1,
          ...row
        };
      });
    })(args);
  });
  var __test__ = {
    stripHtml,
    itemKey,
    itemUrl,
    normalizeSearchUrl,
    parseLimit,
    requireQuery,
    requireType,
    unwrapEvaluateResult,
    requireSearchPayload,
    normalizeResultItem
  };
})();
