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

  // OpenCLI/clis/zhihu/answer-normalize.js
  var fetch2 = window.__zhihu.safeFetch;
  function stripHtml2(html) {
    return stripHtml(html, { preserveBlocks: true });
  }
  function normalizeCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  function normalizeUnixSeconds(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1e3).toISOString() : "";
  }

  // OpenCLI/clis/zhihu/answer-target.js
  var fetch3 = window.__zhihu.safeFetch;
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

  // OpenCLI/clis/zhihu/answer-detail.js
  var fetch4 = window.__zhihu.safeFetch;
  var QUESTION_PATH_RE = /^\/question\/(\d+)\/?$/;
  var QUESTION_API_PATH_RE = /^\/api\/v4\/questions\/(\d+)\/?$/;
  function extractQuestionIdFromAnswerUrl(input) {
    const value = String(input ?? "").trim();
    if (!value) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "www.zhihu.com" && url.hostname !== "zhihu.com") {
        return "";
      }
      return url.pathname.match(ANSWER_PATH_RE)?.[1] || url.pathname.match(QUESTION_PATH_RE)?.[1] || url.pathname.match(QUESTION_API_PATH_RE)?.[1] || "";
    } catch {
      return "";
    }
  }
  __webcliRegisterCommand("answer-detail", async (args = {}) => {
    args = { ...{ "max-content": 0 }, ...args };
    {
      const raw = args["max-content"];
      if (typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw))) throw new window.__zhihu.ArgumentError("Invalid numeric argument");
      args["max-content"] = Number(raw);
    }
    return (async (kwargs) => {
      const target = parseAnswerTarget(kwargs.id);
      if (!target) {
        throw new ArgumentError(
          "Answer ID must be a numeric id, a Zhihu answer URL, or answer:<qid>:<aid>",
          "Example: opencli zhihu answer-detail 1937205528846655537"
        );
      }
      const { answerId } = target;
      const rawMaxContent = kwargs["max-content"];
      const maxContent = rawMaxContent == null ? 0 : Number(rawMaxContent);
      if (!Number.isInteger(maxContent) || maxContent < 0) {
        throw new ArgumentError(
          "--max-content must be a non-negative integer (0 = no cap, full content)",
          "Example: --max-content 2000"
        );
      }
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
      const apiUrl = `https://www.zhihu.com/api/v4/answers/${answerId}?include=content,voteup_count,comment_count,author,created_time,updated_time,question`;
      const data = await ((__portValue0) => (async () => {
        const r = await fetch4(__portValue0, { credentials: "include" });
        if (!r.ok) return { __httpError: r.status };
        try {
          return await r.json();
        } catch (error) {
          return { __malformedJson: error instanceof Error ? error.message : String(error) };
        }
      })())(apiUrl).catch((err) => {
        throw new CommandExecutionError(
          `Zhihu answer detail request failed: ${err instanceof Error ? err.message : String(err)}`,
          "Try again later or rerun with -v for more detail."
        );
      });
      if (!data || data.__httpError) {
        const status = data?.__httpError;
        if (status === 401 || status === 403) {
          throw new AuthRequiredError("www.zhihu.com", "Failed to fetch Zhihu answer detail");
        }
        if (status === 404) {
          throw new EmptyResultError("zhihu answer-detail", `No Zhihu answer was found for ${answerId}.`);
        }
        throw new CommandExecutionError(
          status ? `Zhihu answer detail request failed (HTTP ${status})` : "Zhihu answer detail request failed",
          "Try again later or rerun with -v for more detail"
        );
      }
      if (data.__malformedJson) {
        throw new CommandExecutionError(
          `Zhihu answer detail returned malformed JSON: ${data.__malformedJson}`,
          "Try again later or rerun with -v for more detail"
        );
      }
      if (typeof data !== "object" || Array.isArray(data)) {
        throw new CommandExecutionError(
          "Zhihu answer detail returned a malformed payload",
          "Try again later or rerun with -v for more detail"
        );
      }
      if (data.error || data.error_msg || data.message) {
        throw new CommandExecutionError(
          `Zhihu answer detail returned an error payload: ${data.error?.message || data.error_msg || data.message}`,
          "Try again later or rerun with -v for more detail"
        );
      }
      if (!Object.prototype.hasOwnProperty.call(data, "content")) {
        throw new CommandExecutionError(
          "Zhihu answer detail payload did not include answer content",
          "Try again later or rerun with -v for more detail"
        );
      }
      const question = data.question || {};
      const questionId = target.questionId || currentQuestionId || extractQuestionIdFromAnswerUrl(question.url) || (question.id == null ? "" : String(question.id));
      const stripped = stripHtml2(data.content || "");
      const content = maxContent > 0 && stripped.length > maxContent ? stripped.substring(0, maxContent) : stripped;
      return [{
        id: answerId,
        author: data.author?.name || "anonymous",
        votes: normalizeCount(data.voteup_count),
        comments: normalizeCount(data.comment_count),
        question_id: questionId,
        question_title: question.title || "",
        context_title: window.__zhihu.contextTitle(question.title || content),
        author_token: data.author?.url_token || null,
        context_write_target: /^\d+$/.test(questionId) ? `https://www.zhihu.com/question/${questionId}/answer/${answerId}` : null,
        url: questionId ? `https://www.zhihu.com/question/${questionId}/answer/${answerId}` : `https://www.zhihu.com/answer/${answerId}`,
        created_at: normalizeUnixSeconds(data.created_time),
        updated_at: normalizeUnixSeconds(data.updated_time),
        content
      }];
    })(args);
  });
  var __test__ = { extractQuestionIdFromAnswerUrl };
})();
