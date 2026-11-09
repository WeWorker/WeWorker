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

  // OpenCLI/clis/zhihu/question.js
  var fetch2 = window.__zhihu.safeFetch;
  function answerIdFromUrl(url) {
    if (typeof url !== "string") return "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.zhihu.com" && parsed.hostname !== "zhihu.com") return "";
      return parsed.pathname.match(/^\/question\/\d+\/answer\/(\d+)\/?$/)?.[1] || parsed.pathname.match(/^\/api\/v4\/answers\/(\d+)\/?$/)?.[1] || parsed.pathname.match(/^\/answer\/(\d+)\/?$/)?.[1] || "";
    } catch {
      return "";
    }
  }
  function answerId(item) {
    const fromUrl = answerIdFromUrl(item.url);
    if (fromUrl) return fromUrl;
    if (typeof item.id === "string" && /^\d+$/.test(item.id)) return item.id;
    if (typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0) return String(item.id);
    return "";
  }
  function answerDedupeKey(item) {
    const id = answerId(item);
    if (id) return `id:${id}`;
    return `fallback:${item.author?.name || "anonymous"}:${item.content || ""}`;
  }
  var MAX_LIMIT = 1e3;
  __webcliRegisterCommand("question", async (args = {}) => {
    args = { ...{ "limit": 5, "sort": "default" }, ...args };
    {
      const raw = args["limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["limit"] = Number(raw);
    }
    return (async (kwargs) => {
      const { id, limit = 5 } = kwargs;
      const questionId = String(id);
      if (!/^\d+$/.test(questionId)) {
        throw new CliError("INVALID_INPUT", "Question ID must be numeric", "Example: opencli zhihu question 123456789");
      }
      const answerLimit = Number(limit);
      if (!Number.isInteger(answerLimit) || answerLimit <= 0 || answerLimit > MAX_LIMIT) {
        throw new CliError("INVALID_INPUT", `Limit must be a positive integer no greater than ${MAX_LIMIT}`, "Use a normal-sized limit to avoid slow requests or Zhihu risk controls");
      }
      const sort = String(kwargs.sort || "default");
      if (sort !== "default" && sort !== "created") {
        throw new CliError("INVALID_INPUT", "Sort must be one of: default, created", "Example: opencli zhihu question 123456789 --sort created");
      }
      if (!window.__zhihu.ready(sort === "created" ? `https://www.zhihu.com/question/${questionId}/answers/updated` : `https://www.zhihu.com/question/${questionId}`)) return window.__zhihu.navigate(sort === "created" ? `https://www.zhihu.com/question/${questionId}/answers/updated` : `https://www.zhihu.com/question/${questionId}`);
      window.__zhihu.guard();
      const ZHIHU_PAGE_SIZE = 20;
      let url = `https://www.zhihu.com/api/v4/questions/${questionId}/answers?limit=${ZHIHU_PAGE_SIZE}&offset=0&sort_by=${sort}&include=data[*].content,url,voteup_count,comment_count,author`;
      const answers = [];
      const seen = /* @__PURE__ */ new Set();
      const visited = /* @__PURE__ */ new Set();
      while (url && answers.length < answerLimit && !visited.has(url)) {
        visited.add(url);
        const data = await ((__portValue0) => (async () => {
          const r = await fetch2(__portValue0, { credentials: "include" });
          if (!r.ok) return { __httpError: r.status };
          return await r.json();
        })())(url);
        if (!data || data.__httpError) {
          const status = data?.__httpError;
          if (status === 401 || status === 403) {
            throw new AuthRequiredError("www.zhihu.com", "Failed to fetch question data from Zhihu");
          }
          throw new CliError("FETCH_ERROR", status ? `Zhihu question answers request failed (HTTP ${status})` : "Zhihu question answers request failed", "Try again later or rerun with -v for more detail");
        }
        for (const item of data.data || []) {
          const key = answerDedupeKey(item);
          if (seen.has(key)) continue;
          seen.add(key);
          answers.push(item);
          if (answers.length >= answerLimit) break;
        }
        if (data.paging?.is_end) break;
        url = typeof data.paging?.next === "string" ? data.paging.next : "";
      }
      return answers.map((item, i) => {
        const id2 = answerId(item);
        return {
          rank: i + 1,
          id: id2,
          author: item.author?.name || "anonymous",
          context_title: window.__zhihu.contextTitle(stripHtml(item.content || '')),
          votes: item.voteup_count || 0,
          url: id2 ? `https://www.zhihu.com/question/${questionId}/answer/${id2}` : "",
          content: stripHtml(item.content || "").substring(0, 200)
        };
      });
    })(args);
  });
})();
