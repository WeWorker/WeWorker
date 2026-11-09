/* Adapted from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * Modified for WeWorker v2 registration, direct page extraction and bounded host navigation. */
"use strict";
(() => {
  // port:errors
  var { CliError, CommandExecutionError } = window.__zhihu;

  // OpenCLI/clis/zhihu/target.js
  var fetch = window.__zhihu.safeFetch;
  var USER_RE = /^user:([A-Za-z0-9_-]+)$/;
  var QUESTION_RE = /^question:(\d+)$/;
  var ANSWER_RE = /^answer:(\d+):(\d+)$/;
  var ARTICLE_RE = /^article:(\d+)$/;
  var USER_PATH_RE = /^\/people\/([A-Za-z0-9_-]+)\/?$/;
  var QUESTION_PATH_RE = /^\/question\/(\d+)\/?$/;
  var ANSWER_PATH_RE = /^\/question\/(\d+)\/answer\/(\d+)\/?$/;
  var ARTICLE_PATH_RE = /^\/p\/(\d+)\/?$/;
  var EMPTY_AUTHORITY_RE = /^https:\/\/(?::)?@/i;
  function isAllowedZhihuUrl(url) {
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "";
  }
  function parseTarget(input) {
    const value = String(input).trim();
    if (EMPTY_AUTHORITY_RE.test(value)) {
      throw new CliError("INVALID_INPUT", "Zhihu write commands require a normal HTTPS Zhihu URL without malformed authority", "Example: https://www.zhihu.com/question/123456");
    }
    if (value.startsWith("answer:") && !ANSWER_RE.test(value)) {
      throw new CliError("INVALID_INPUT", "Invalid answer target, expected answer:<questionId>:<answerId>", "Example: opencli zhihu like answer:123:456 --execute");
    }
    let match = value.match(USER_RE);
    if (match) {
      return { kind: "user", slug: match[1], url: `https://www.zhihu.com/people/${match[1]}` };
    }
    match = value.match(QUESTION_RE);
    if (match) {
      return { kind: "question", id: match[1], url: `https://www.zhihu.com/question/${match[1]}` };
    }
    match = value.match(ANSWER_RE);
    if (match) {
      return {
        kind: "answer",
        questionId: match[1],
        id: match[2],
        url: `https://www.zhihu.com/question/${match[1]}/answer/${match[2]}`
      };
    }
    match = value.match(ARTICLE_RE);
    if (match) {
      return { kind: "article", id: match[1], url: `https://zhuanlan.zhihu.com/p/${match[1]}` };
    }
    try {
      const url = new URL(value);
      if (!isAllowedZhihuUrl(url)) {
        throw new Error("unsupported zhihu url variant");
      }
      if (url.hostname === "www.zhihu.com") {
        const userMatch = url.pathname.match(USER_PATH_RE);
        if (userMatch) {
          const slug = userMatch[1];
          return { kind: "user", slug, url: `https://www.zhihu.com/people/${slug}` };
        }
        const questionMatch = url.pathname.match(QUESTION_PATH_RE);
        if (questionMatch) {
          return { kind: "question", id: questionMatch[1], url: `https://www.zhihu.com/question/${questionMatch[1]}` };
        }
        const answerMatch = url.pathname.match(ANSWER_PATH_RE);
        if (answerMatch) {
          return {
            kind: "answer",
            questionId: answerMatch[1],
            id: answerMatch[2],
            url: `https://www.zhihu.com/question/${answerMatch[1]}/answer/${answerMatch[2]}`
          };
        }
      }
      if (url.hostname === "zhuanlan.zhihu.com") {
        const articleMatch = url.pathname.match(ARTICLE_PATH_RE);
        if (articleMatch) {
          return { kind: "article", id: articleMatch[1], url: `https://zhuanlan.zhihu.com/p/${articleMatch[1]}` };
        }
      }
    } catch {
    }
    throw new CliError("INVALID_INPUT", "Zhihu write commands require a Zhihu URL or typed target like question:123 or answer:123:456", "Example: opencli zhihu like answer:123:456 --execute");
  }
  function assertAllowedKinds(command, target) {
    const allowed = {
      follow: ["user", "question"],
      like: ["answer", "article"],
      favorite: ["answer", "article"],
      comment: ["answer", "article"],
      answer: ["question"]
    };
    if (!allowed[command]?.includes(target.kind)) {
      throw new CliError("UNSUPPORTED_TARGET", `zhihu ${command} does not support ${target.kind} targets`);
    }
    return target;
  }

  // OpenCLI/clis/zhihu/write-shared.js
  function requireExecute(a) {
    if (a.execute !== true && a.execute !== "true") throw new CliError("INVALID_ARGS", "Use execute=true plus host confirmation");
  }
  function buildResultRow(message, targetType, target, outcome, extra = {}) {
    for (const k of ["status", "outcome", "message", "target_type", "target"]) if (k in extra) throw new CliError("INVALID_ARGS", "Reserved result field");
    return [{ status: "success", outcome, message, target_type: targetType, target, ...extra }];
  }

  // OpenCLI/clis/zhihu/like.js
  var fetch2 = window.__zhihu.safeFetch;
  __webcliRegisterCommand("like", async (args = {}) => {
    requireExecute(args);
    if (location.hostname !== "www.zhihu.com" || /signin|login/.test(location.pathname)) return { __webcli_navigation: { version: 1, url: "https://www.zhihu.com/", resume: false, phase: 'prepare', result: { status: "prepared", message: "\u9875\u9762\u5DF2\u51C6\u5907\uFF1B\u4EBA\u5DE5\u767B\u5F55\u5E76\u518D\u6B21\u786E\u8BA4\u540E\u8C03\u7528\uFF0C\u5C1A\u672A\u6267\u884C\u4E1A\u52A1\u5199\u5165\u3002" } } };
    return (async (kwargs) => {
      requireExecute(kwargs);
      const rawTarget = String(kwargs.target);
      const target = assertAllowedKinds("like", parseTarget(rawTarget));
      const apiResult = await ((__portValue0, __portValue1) => (async () => {
        var targetKind = __portValue0;
        var targetId = __portValue1;
        var resourceType = targetKind === "answer" ? "answers" : "articles";
        var url = "https://www.zhihu.com/api/v4/" + resourceType + "/" + targetId + "/voters";
        var resp = await fetch2(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "up" })
        });
        var data = await resp.json();
        if (!resp.ok) return { ok: false, message: data.error ? data.error.message : "unknown error" };
        if (data && data.success === false) return { ok: false, message: "Zhihu like API reported success=false" };
        return { ok: true, success: data.success };
      })())(target.kind, target.id);
      if (!apiResult?.ok) {
        throw new CliError("COMMAND_EXEC", apiResult?.message || "Failed to like");
      }
      return buildResultRow(`Liked ${target.kind} ${target.id}`, target.kind, rawTarget, "applied");
    })(args);
  });
})();
