/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
"use strict";
(() => {
  // port:errors
  var { CliError, ArgumentError, CommandExecutionError, AuthRequiredError, EmptyResultError } = window.__zhihu;

  // port:logger
  var log = { info() {
  }, debug() {
  }, warn() {
  } };

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

  // OpenCLI/clis/zhihu/collection.js
  var fetch2 = window.__zhihu.safeFetch;
  function validatePositiveInt(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ArgumentError(`zhihu collection --${name} must be a positive integer`, "Example: opencli zhihu collection 83283292 --limit 20");
    }
    return n;
  }
  function validateNonNegativeInt(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new ArgumentError(`zhihu collection --${name} must be a non-negative integer`, "Example: opencli zhihu collection 83283292 --offset 0");
    }
    return n;
  }
  async function fetchCollectionPage(collectionId, offset, limit) {
    const url = `https://www.zhihu.com/api/v4/collections/${collectionId}/items?offset=${offset}&limit=${limit}`;
    const data = await ((__portValue0) => (async () => {
      const r = await fetch2(__portValue0, { credentials: "include" });
      if (!r.ok) return { __httpError: r.status };
      return await r.json();
    })())(url);
    if (!data || data.__httpError) {
      const status = data?.__httpError;
      if (status === 401 || status === 403) {
        throw new AuthRequiredError("www.zhihu.com", "Failed to fetch collection data from Zhihu. Please ensure you are logged in.");
      }
      throw new CommandExecutionError(
        status ? `Zhihu collection request failed (HTTP ${status})` : "Zhihu collection request failed",
        "Try again later or rerun with -v for more detail"
      );
    }
    return data;
  }
  function itemKey(item) {
    const content = item?.content || {};
    return `${content.type || ""}:${content.id || content.url || JSON.stringify(content).slice(0, 80)}`;
  }
  function mapCollectionItem(item, rank) {
    const content = item.content || {};
    const type = content.type || "";
    if (!["answer", "article", "pin"].includes(type)) {
      throw new CommandExecutionError(
        `Zhihu collection returned unsupported content type: ${type || "missing"}`,
        "Collection items require a supported content.type so the row identity, title, and URL are not silently blank."
      );
    }
    let title = "";
    let excerpt = "";
    let url = "";
    let author = "";
    let votes = 0;
    if (type === "answer") {
      const question = content.question || {};
      title = question.title || "";
      excerpt = stripHtml(content.content || "").substring(0, 150);
      url = question.id && content.id ? `https://www.zhihu.com/question/${question.id}/answer/${content.id}` : '';
      author = content.author?.name || "\u533F\u540D\u7528\u6237";
      votes = content.voteup_count || 0;
    } else if (type === "article") {
      title = content.title || "";
      excerpt = stripHtml(content.content || "").substring(0, 150);
      url = content.id ? `https://zhuanlan.zhihu.com/p/${content.id}` : '';
      author = content.author?.name || "\u533F\u540D\u7528\u6237";
      votes = content.voteup_count || 0;
    } else if (type === "pin") {
      title = "\u60F3\u6CD5";
      excerpt = stripHtml((content.content || []).map((c) => c.content || "").join(" ")).substring(0, 150);
      url = content.id ? `https://www.zhihu.com/pin/${content.id}` : '';
      author = content.author?.name || "\u533F\u540D\u7528\u6237";
      votes = content.reaction_count || 0;
    }
    if (!url && typeof content.url === 'string') {
      try {
        const candidate = new URL(content.url);
        const valid = type === 'answer' ? candidate.hostname === 'www.zhihu.com' && /^\/question\/\d+\/answer\/\d+\/?$/.test(candidate.pathname) :
          type === 'article' ? candidate.hostname === 'zhuanlan.zhihu.com' && /^\/p\/\d+\/?$/.test(candidate.pathname) :
          candidate.hostname === 'www.zhihu.com' && /^\/pin\/\d+\/?$/.test(candidate.pathname);
        if (valid && candidate.protocol === 'https:' && !candidate.username && !candidate.password && !candidate.port) url = candidate.origin + candidate.pathname;
      } catch {}
    }
    if (!String(title || "").trim() || !String(url || "").trim() || url.includes("undefined")) {
      throw new CommandExecutionError(
        "Zhihu collection returned a malformed item without title or URL identity",
        "Collection item rows require type, title, and URL so malformed payloads do not become blank listing rows."
      );
    }
    return {
      rank,
      type,
      title: stripHtml(title).substring(0, 100),
      context_title: window.__zhihu.contextTitle(stripHtml(title)),
      author,
      votes,
      excerpt,
      url
    };
  }
  __webcliRegisterCommand("collection", async (args = {}) => {
    args = { ...{ "offset": 0, "limit": 20 }, ...args };
    {
      const raw = args["offset"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["offset"] = Number(raw);
    }
    {
      const raw = args["limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["limit"] = Number(raw);
    }
    return (async (kwargs) => {
      const { id, offset = 0, limit = 20 } = kwargs;
      const collectionId = String(id);
      if (!/^\d+$/.test(collectionId)) {
        throw new ArgumentError("Collection ID must be numeric", "Example: opencli zhihu collection 83283292");
      }
      const pageOffset = validateNonNegativeInt(offset, "offset");
      const requestedLimit = validatePositiveInt(limit, "limit");
      const pageLimit = Math.min(requestedLimit, 20);
      if (!window.__zhihu.ready("https://www.zhihu.com")) return window.__zhihu.navigate("https://www.zhihu.com");
      window.__zhihu.guard();
      const collected = [];
      const seen = /* @__PURE__ */ new Set();
      let totals = 0;
      let nextOffset = pageOffset;
      const maxPages = Math.ceil(requestedLimit / pageLimit) + 2;
      for (let pageIndex = 0; pageIndex < maxPages && collected.length < requestedLimit; pageIndex += 1) {
        const currentFetchLimit = Math.min(pageLimit, requestedLimit - collected.length);
        const data = await fetchCollectionPage(collectionId, nextOffset, currentFetchLimit);
        const items = Array.isArray(data.data) ? data.data : [];
        const paging = data.paging || {};
        totals = Number(paging.totals || totals || 0);
        for (const item of items) {
          const key = itemKey(item);
          if (!seen.has(key)) {
            seen.add(key);
            collected.push(item);
          }
          if (collected.length >= requestedLimit) break;
        }
        if (items.length === 0 || paging.is_end || collected.length >= requestedLimit) break;
        if (typeof paging.next === "string") {
          try {
            const nextUrl = new URL(paging.next);
            const parsedOffset = Number(nextUrl.searchParams.get("offset"));
            if (Number.isInteger(parsedOffset) && parsedOffset > nextOffset) {
              nextOffset = parsedOffset;
              continue;
            }
          } catch {
          }
        }
        if (items.length < currentFetchLimit) break;
        const fallbackOffset = nextOffset + items.length;
        if (fallbackOffset <= nextOffset) break;
        nextOffset = fallbackOffset;
        if (totals && nextOffset >= totals) break;
      }
      const totalPages = Math.ceil(totals / pageLimit);
      const currentPage = Math.floor(pageOffset / pageLimit) + 1;
      if (totals > 0) {
        log.info(`\u6536\u85CF\u5939\u5171\u6709 ${totals} \u6761\u5185\u5BB9\uFF0C\u5171 ${totalPages} \u9875`);
        log.info(`\u5F53\u524D\u7B2C ${currentPage} \u9875\uFF0C\u663E\u793A\u7B2C ${pageOffset + 1} - ${Math.min(pageOffset + collected.length, totals)} \u6761`);
      }
      if (collected.length === 0) {
        throw new EmptyResultError("zhihu collection", `No items found for collection ${collectionId}. The collection may be empty, private, or the offset may be out of range.`);
      }
      return collected.slice(0, requestedLimit).map((item, i) => mapCollectionItem(item, pageOffset + i + 1));
    })(args);
  });
  var __test__ = {
    stripHtml,
    validatePositiveInt,
    validateNonNegativeInt,
    itemKey,
    mapCollectionItem
  };
})();
