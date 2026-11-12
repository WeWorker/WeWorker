/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
"use strict";
(() => {
  // port:errors
  var { CliError, ArgumentError, CommandExecutionError, AuthRequiredError, EmptyResultError } = window.__zhihu;

  // OpenCLI/clis/zhihu/recommend.js
  var fetch = window.__zhihu.safeFetch;
  function normalizeUrl(item) {
    const target = item.target || {};
    const id = target.id == null ? "" : String(target.id);
    if (target.type === "answer") {
      const questionId = target.question?.id == null ? "" : String(target.question.id);
      return questionId && id ? `https://www.zhihu.com/question/${questionId}/answer/${id}` : "";
    }
    if (target.type === "article") {
      return id ? `https://zhuanlan.zhihu.com/p/${id}` : "";
    }
    if (target.type === "question") {
      return id ? `https://www.zhihu.com/question/${id}` : "";
    }
    return "";
  }
  function normalizeTitle(item) {
    const target = item.target || {};
    if (target.type === "answer") return target.question?.title || "";
    return target.title || target.question?.title || "";
  }
  var MAX_LIMIT = 1e3;
  __webcliRegisterCommand("recommend", async (args = {}) => {
    args = { ...{ "limit": 20 }, ...args };
    {
      const raw = args["limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["limit"] = Number(raw);
    }
    return (async (kwargs) => {
      const itemLimit = Number(kwargs.limit ?? 20);
      if (!Number.isInteger(itemLimit) || itemLimit <= 0 || itemLimit > MAX_LIMIT) {
        throw new CliError("INVALID_INPUT", `Limit must be a positive integer no greater than ${MAX_LIMIT}`, "Use a normal-sized limit to avoid slow requests or Zhihu risk controls");
      }
      if (!window.__zhihu.ready("https://www.zhihu.com")) return window.__zhihu.navigate("https://www.zhihu.com");
      window.__zhihu.guard();
      let url = "https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=10&desktop=true";
      const items = [];
      const seen = /* @__PURE__ */ new Set();
      const visited = /* @__PURE__ */ new Set();
      while (url && items.length < itemLimit && !visited.has(url)) {
        visited.add(url);
        const data = await ((__portValue0) => (async () => {
          const r = await fetch(__portValue0, { credentials: "include" });
          if (!r.ok) return { __httpError: r.status };
          return await r.json();
        })())(url);
        if (!data || data.__httpError) {
          const status = data?.__httpError;
          if (status === 401 || status === 403) {
            throw new AuthRequiredError("www.zhihu.com", "Failed to fetch Zhihu recommendations");
          }
          throw new CliError("FETCH_ERROR", status ? `Zhihu recommendations request failed (HTTP ${status})` : "Zhihu recommendations request failed", "Try again later or rerun with -v for more detail");
        }
        for (const item of data.data || []) {
          const target = item.target || {};
          const targetId = target.id;
          let key = null;
          if (targetId != null) {
            key = `${target.type ?? ""}:${targetId}`;
          } else if (item.id != null) {
            key = `__feed:${item.id}`;
          }
          if (key != null) {
            if (seen.has(key)) continue;
            seen.add(key);
          }
          items.push(item);
          if (items.length >= itemLimit) break;
        }
        if (data.paging?.is_end) break;
        url = typeof data.paging?.next === "string" ? data.paging.next : "";
      }
      return items.map((item, i) => {
        const target = item.target || {};
        return {
          rank: i + 1,
          type: target.type || item.type || "",
          title: normalizeTitle(item),
          context_title: window.__zhihu.contextTitle(normalizeTitle(item)),
          question_id: target.type === 'question' && target.id != null ? String(target.id) : target.question?.id == null ? null : String(target.question.id),
          author: target.author?.name || "",
          votes: target.voteup_count ?? target.reaction?.statistics?.like_count ?? null,
          url: normalizeUrl(item)
        };
      });
    })(args);
  });
})();
