/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
"use strict";
(() => {
  // port:errors
  var { CliError, ArgumentError, CommandExecutionError, AuthRequiredError, EmptyResultError } = window.__zhihu;

  // OpenCLI/clis/zhihu/answer-target.js
  var fetch = window.__zhihu.safeFetch;
  var ANSWER_ID_RE = /^\d+$/;
  var ANSWER_TYPED_RE = /^answer:(\d+):(\d+)$/;
  var ANSWER_PATH_RE = /^\/question\/(\d+)\/answer\/(\d+)\/?$/;
  var BARE_ANSWER_PATH_RE = /^\/answer\/(\d+)\/?$/;
  function parseAnswerTarget(input) {
    const value = String(input ?? "").trim();
    if (!value) return null;
    if (ANSWER_ID_RE.test(value)) return { answerId: value, questionId: "" };
    const typed = value.match(ANSWER_TYPED_RE);
    if (typed) return { questionId: typed[1], answerId: typed[2] };
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com") {
        return null;
      }
      let m = url.pathname.match(ANSWER_PATH_RE);
      if (m) return { questionId: m[1], answerId: m[2] };
      m = url.pathname.match(BARE_ANSWER_PATH_RE);
      if (m) return { answerId: m[1], questionId: "" };
    } catch {
      return null;
    }
    return null;
  }

  // OpenCLI/clis/zhihu/text.js
  var fetch2 = window.__zhihu.safeFetch;
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

  // OpenCLI/clis/zhihu/answer-normalize.js
  var fetch3 = window.__zhihu.safeFetch;
  function stripHtml2(html) {
    return stripHtml(html, { preserveBlocks: true });
  }
  function normalizeCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  function normalizeUnixSeconds(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1e3).toISOString() : "";
  }

  // OpenCLI/clis/zhihu/paginate.js
  var fetch4 = window.__zhihu.safeFetch;
  function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
    return payload;
  }

  // OpenCLI/clis/zhihu/answer-comments-helpers.js
  var fetch5 = window.__zhihu.safeFetch;
  var COMMENT_ID_RE = /^\d+$/;
  var PAGE_SIZE = 20;
  var PAGE_OVERLAP_ALLOWANCE = 2;
  function memberName(author) {
    return String(author?.member?.name || author?.name || "").trim();
  }
  function commentId(value) {
    if (typeof value === "string") {
      const id = value.trim();
      return COMMENT_ID_RE.test(id) ? id : "";
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  }
  function normalizePageUrl(value, path, requiredParams) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "www.zhihu.com" || url.port || url.username || url.password || url.hash || url.pathname !== path) return "";
      for (const [name, expected] of Object.entries(requiredParams)) {
        const values = url.searchParams.getAll(name);
        if (values.length !== 1 || expected !== null && values[0] !== expected) return "";
      }
      return url.toString();
    } catch {
      return "";
    }
  }
  async function fetchCommentPage(url, label, notFoundDetail = "") {
    const evaluated = await (async (requestUrl) => {
      const response = await fetch5(requestUrl, { credentials: "include" });
      let body;
      try {
        body = await response.json();
      } catch (error2) {
        return { __httpStatus: response.status, __malformedJson: error2 instanceof Error ? error2.message : String(error2) };
      }
      const error = body?.error && typeof body.error === "object" ? body.error : null;
      const result = {
        __httpStatus: response.status,
        __errorCode: error?.code ?? body?.error_code ?? "",
        __errorMessage: error?.message || body?.error_msg || "",
        __needLogin: error?.need_login === true || body?.need_login === true
      };
      return !response.ok || result.__errorCode || result.__errorMessage || result.__needLogin ? result : body;
    })(url).catch((error) => {
      throw new CommandExecutionError(
        `Zhihu ${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
        "Try again later or rerun with -v for more detail."
      );
    });
    const payload = unwrapEvaluateResult(evaluated);
    if (payload?.__malformedJson) {
      throw new CommandExecutionError(`Zhihu ${label} returned malformed JSON: ${payload.__malformedJson}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CommandExecutionError(`Zhihu ${label} returned a malformed payload`);
    }
    const status = payload.__httpStatus;
    const code = String(payload.__errorCode || "");
    if (status >= 400 || code || payload.__errorMessage || payload.__needLogin) {
      if (code === "40362") {
        throw new CommandExecutionError(
          `Zhihu risk control blocked ${label} (40362): ${payload.__errorMessage || "abnormal request"}`,
          "Open the answer in the connected Chrome profile and retry later."
        );
      }
      if (status === 401 || status === 403 || code === "40353" || payload.__needLogin) {
        throw new AuthRequiredError("www.zhihu.com", `Failed to fetch Zhihu ${label}`);
      }
      if (status === 404 && notFoundDetail) throw new EmptyResultError("zhihu answer-comments", notFoundDetail);
      if (status >= 400) throw new CommandExecutionError(`Zhihu ${label} request failed (HTTP ${status})`);
      throw new CommandExecutionError(`Zhihu ${label} returned an error payload: ${payload.__errorMessage || code}`);
    }
    if (!Array.isArray(payload.data) || !payload.paging || typeof payload.paging !== "object") {
      throw new CommandExecutionError(`Zhihu ${label} returned a malformed payload`);
    }
    if (typeof payload.paging.is_end !== "boolean") {
      throw new CommandExecutionError(`Zhihu ${label} returned malformed paging state`);
    }
    return payload;
  }
  function describeComment(comment, role, expectedRootId = "") {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new CommandExecutionError(`Zhihu answer comments contained a malformed ${role} row`);
    }
    const id = commentId(comment.id);
    if (!id) throw new CommandExecutionError(`Zhihu answer comments contained a ${role} row without a stable id`);
    const rootId = role === "root" ? id : commentId(comment.reply_root_comment_id);
    const parentId = role === "root" ? "" : commentId(comment.reply_comment_id);
    if (role === "child" && rootId !== expectedRootId) {
      throw new CommandExecutionError(`Zhihu answer comment ${id} had conflicting root provenance`);
    }
    if (role === "child" && !parentId) {
      throw new CommandExecutionError(`Zhihu answer comment ${id} did not identify its immediate parent`);
    }
    const signature = JSON.stringify({
      role,
      rootId,
      parentId,
      author: memberName(comment.author),
      replyTo: role === "child" ? memberName(comment.reply_to_author) : "",
      content: stripHtml2(comment.content || "")
    });
    return { id, rootId, parentId, signature };
  }
  function addPageComments(byId, comments, role, expectedRootId) {
    for (const comment of comments) {
      const descriptor = describeComment(comment, role, expectedRootId);
      const previous = byId.get(descriptor.id);
      if (!previous) {
        byId.set(descriptor.id, { comment, descriptor });
        continue;
      }
      if (previous.descriptor.signature !== descriptor.signature) {
        throw new CommandExecutionError(`Zhihu answer comments returned conflicting data for comment ${descriptor.id}`);
      }
      const oldCount = previous.comment.child_comment_count;
      const newCount = comment.child_comment_count;
      if (Number.isInteger(newCount) && (!Number.isInteger(oldCount) || newCount > oldCount)) {
        previous.comment = { ...previous.comment, child_comment_count: newCount };
      }
    }
  }
  async function fetchPages(options) {
    const { firstUrl, limit, label, role, expectedRootId = "", normalizeNext, notFoundDetail = "" } = options;
    const byId = /* @__PURE__ */ new Map();
    const visited = /* @__PURE__ */ new Set();
    const maxPages = Math.ceil(limit / PAGE_SIZE) + PAGE_OVERLAP_ALLOWANCE;
    let pageCount = 0;
    let url = firstUrl;
    while (byId.size < limit) {
      if (visited.has(url)) throw new CommandExecutionError(`Zhihu ${label} pagination returned a repeated next URL`);
      if (pageCount >= maxPages) throw new CommandExecutionError(`Zhihu ${label} pagination exceeded its fetch budget`);
      visited.add(url);
      pageCount += 1;
      const payload = await fetchCommentPage(url, label, notFoundDetail);
      addPageComments(byId, payload.data, role, expectedRootId);
      if (payload.paging.is_end || byId.size >= limit) break;
      url = normalizeNext(payload.paging.next);
      if (!url) throw new CommandExecutionError(`Zhihu ${label} pagination returned a malformed next URL`);
    }
    return [...byId.values()].slice(0, limit).map(({ comment }) => comment);
  }
  function fetchRootComments(answerId, order, limit) {
    const apiOrder = order === "latest" ? "ts" : "score";
    const path = `/api/v4/comment_v5/answers/${answerId}/root_comment`;
    return fetchPages({
      firstUrl: `https://www.zhihu.com${path}?order_by=${apiOrder}&limit=${PAGE_SIZE}&offset=`,
      limit,
      label: "answer root comments",
      role: "root",
      normalizeNext: (next) => normalizePageUrl(next, path, {
        order_by: apiOrder,
        limit: String(PAGE_SIZE),
        offset: null
      }),
      notFoundDetail: `No Zhihu answer comments resource was found for ${answerId}.`
    });
  }
  async function fetchChildComments(rootId, limit) {
    const path = `/api/v4/comment_v5/comment/${rootId}/child_comment`;
    return fetchPages({
      firstUrl: `https://www.zhihu.com${path}?limit=${PAGE_SIZE}&offset=0`,
      limit,
      label: "answer child comments",
      role: "child",
      expectedRootId: rootId,
      normalizeNext: (next) => normalizePageUrl(next, path, { limit: String(PAGE_SIZE), offset: null })
    });
  }
  async function fetchRepliesByRoot(roots, repliesLimit) {
    const repliesByRoot = /* @__PURE__ */ new Map();
    if (repliesLimit === 0) return repliesByRoot;
    for (const root of roots) {
      const id = describeComment(root, "root").id;
      if (!Number.isInteger(root.child_comment_count) || root.child_comment_count < 0) {
        throw new CommandExecutionError(`Zhihu answer root comment ${id} had malformed child count`);
      }
      if (root.child_comment_count === 0) continue;
      const children = await fetchChildComments(id, repliesLimit);
      if (children.length === 0) {
        throw new CommandExecutionError(`Zhihu answer root comment ${id} advertised replies but returned none`);
      }
      repliesByRoot.set(id, children);
    }
    return repliesByRoot;
  }
  function resolveDepths(rootId, childrenById) {
    const depths = /* @__PURE__ */ new Map();
    for (const childId of childrenById.keys()) {
      if (depths.has(childId)) continue;
      const chain = [];
      const active = /* @__PURE__ */ new Set();
      let cursor = childId;
      let depth = 0;
      while (cursor !== rootId && !depths.has(cursor)) {
        if (active.has(cursor)) throw new CommandExecutionError(`Zhihu answer comments contained a reply cycle at ${cursor}`);
        active.add(cursor);
        chain.push(cursor);
        const node = childrenById.get(cursor);
        if (!node) throw new CommandExecutionError(`Zhihu answer comments referenced missing parent ${cursor}`);
        cursor = node.descriptor.parentId;
      }
      if (cursor !== rootId) depth = depths.get(cursor);
      for (let index = chain.length - 1; index >= 0; index -= 1) depths.set(chain[index], ++depth);
    }
    return depths;
  }
  function toRow(comment, descriptor, ranks, context) {
    return {
      rank: ranks.rank,
      comment_rank: ranks.commentRank,
      reply_rank: ranks.replyRank,
      depth: ranks.depth,
      id: descriptor.id,
      parent_id: descriptor.parentId,
      author: memberName(comment.author) || "anonymous",
      author_token: comment.author?.member?.url_token || comment.author?.url_token || null,
      answer_url: `https://www.zhihu.com/answer/${context.answerId}`,
      context_title: window.__zhihu.contextTitle(stripHtml2(comment.content || '')),
      reply_to: descriptor.parentId ? memberName(comment.reply_to_author) : "",
      likes: normalizeCount(comment.like_count ?? comment.vote_count),
      created_at: normalizeUnixSeconds(comment.created_time),
      url: context.questionId ? `https://www.zhihu.com/question/${context.questionId}/answer/${context.answerId}#comment-${descriptor.id}` : typeof comment.url === "string" ? comment.url : "",
      content: stripHtml2(comment.content || "")
    };
  }
  function buildCommentRows(roots, repliesByRoot, context) {
    const rows = [];
    const globalIds = /* @__PURE__ */ new Set();
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      const rootDescriptor = describeComment(root, "root");
      if (globalIds.has(rootDescriptor.id)) {
        throw new CommandExecutionError(`Zhihu answer comments reused id ${rootDescriptor.id} across graph roles`);
      }
      globalIds.add(rootDescriptor.id);
      rows.push(toRow(root, rootDescriptor, {
        rank: rows.length + 1,
        commentRank: rootIndex + 1,
        replyRank: 0,
        depth: 0
      }, context));
      const childrenById = /* @__PURE__ */ new Map();
      for (const child of repliesByRoot.get(rootDescriptor.id) || []) {
        const descriptor = describeComment(child, "child", rootDescriptor.id);
        if (globalIds.has(descriptor.id) || childrenById.has(descriptor.id)) {
          throw new CommandExecutionError(`Zhihu answer comments reused id ${descriptor.id} across graph roles`);
        }
        globalIds.add(descriptor.id);
        childrenById.set(descriptor.id, { comment: child, descriptor });
      }
      const depths = resolveDepths(rootDescriptor.id, childrenById);
      let replyRank = 0;
      for (const { comment, descriptor } of childrenById.values()) {
        replyRank += 1;
        rows.push(toRow(comment, descriptor, {
          rank: rows.length + 1,
          commentRank: rootIndex + 1,
          replyRank,
          depth: depths.get(descriptor.id)
        }, context));
      }
    }
    return rows;
  }

  // OpenCLI/clis/zhihu/answer-comments.js
  var fetch6 = window.__zhihu.safeFetch;
  function extractQuestionIdFromAnswerUrl(input) {
    const value = String(input ?? "").trim();
    if (!value) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com") return "";
      return url.pathname.match(ANSWER_PATH_RE)?.[1] || "";
    } catch {
      return "";
    }
  }
  var MAX_LIMIT = 1e3;
  var MAX_REPLIES_LIMIT = 100;
  __webcliRegisterCommand("answer-comments", async (args = {}) => {
    args = { ...{ "limit": 20, "replies-limit": 3, "order": "score" }, ...args };
    {
      const raw = args["limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["limit"] = Number(raw);
    }
    {
      const raw = args["replies-limit"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["replies-limit"] = Number(raw);
    }
    return (async (kwargs) => {
      const target = parseAnswerTarget(kwargs.id);
      if (!target) {
        throw new ArgumentError(
          "Answer ID must be a numeric id, a Zhihu answer URL, or answer:<qid>:<aid>",
          "Example: opencli zhihu answer-comments 1937205528846655537"
        );
      }
      const topLevelLimit = Number(kwargs.limit ?? 20);
      if (!Number.isInteger(topLevelLimit) || topLevelLimit <= 0 || topLevelLimit > MAX_LIMIT) {
        throw new ArgumentError(`--limit must be a positive integer no greater than ${MAX_LIMIT}`);
      }
      const repliesLimit = Number(kwargs["replies-limit"] ?? 3);
      if (!Number.isInteger(repliesLimit) || repliesLimit < 0 || repliesLimit > MAX_REPLIES_LIMIT) {
        throw new ArgumentError(`--replies-limit must be an integer between 0 and ${MAX_REPLIES_LIMIT}`);
      }
      const order = String(kwargs.order ?? "score");
      if (order !== "score" && order !== "latest") {
        throw new ArgumentError("--order must be score or latest");
      }
      const { answerId } = target;
      try {
        if (!window.__zhihu.ready(`https://www.zhihu.com/answer/${answerId}`)) return window.__zhihu.navigate(`https://www.zhihu.com/answer/${answerId}`);
        window.__zhihu.guard();
      } catch (err) {
        throw new CommandExecutionError(
          `Failed to open Zhihu answer ${answerId}: ${err instanceof Error ? err.message : String(err)}`,
          "Open the answer URL in Chrome and retry after the page is reachable."
        );
      }
      const currentQuestionId = extractQuestionIdFromAnswerUrl(location.href);
      const questionId = target.questionId || currentQuestionId;
      const roots = await fetchRootComments(answerId, order, topLevelLimit);
      if (roots.length === 0) {
        throw new EmptyResultError("zhihu answer-comments", `No comments found for answer ${answerId}.`);
      }
      const repliesByRoot = await fetchRepliesByRoot(roots, repliesLimit);
      return buildCommentRows(roots, repliesByRoot, { answerId, questionId });
    })(args);
  });
})();
