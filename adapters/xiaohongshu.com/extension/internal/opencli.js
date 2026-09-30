/* Derived from jackwener/OpenCLI 24136945847afbfad266c6c46a8cd335377f9112, Apache-2.0.
 * WeWorker modifications: v2 registration, host navigation, bounded runtime helpers, native input and local file I/O.
 * Rebuild: node webcli/scripts/opencli-xiaohongshu/build.mjs. See docs/opencli_xiaohongshu_migration.md. */
var __xhsOpenCLI = (() => {
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
    Page: () => Page,
    commands: () => commands,
    helper: () => helper,
    invoke: () => invoke,
    normalizeArgs: () => normalizeArgs,
    runtime: () => runtime,
    trustedUrl: () => trustedUrl
  });

  // webcli/scripts/opencli-xiaohongshu/registry.js
  var commands = /* @__PURE__ */ new Map();
  var Strategy = { COOKIE: "cookie", INTERCEPT: "intercept" };
  function cli(command9) {
    commands.set(command9.name, command9);
    return command9;
  }

  // webcli/scripts/opencli-xiaohongshu/errors.js
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
    constructor(command9, message) {
      super("EMPTY_RESULT", message || command9);
    }
  };
  var TimeoutError = class extends CliError {
    constructor(command9, seconds, hint) {
      super("TIMEOUT", `${command9} exceeded ${seconds}s`, hint);
    }
  };

  // webcli/scripts/opencli-xiaohongshu/upstream/shared.js
  function unwrapEvaluateResult(payload) {
    if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
      return payload.data;
    }
    return payload;
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/ask.js
  var XHS_WEB_HOST = "www.xiaohongshu.com";
  var ASK_COLUMNS = [
    "query",
    "answer",
    "source_count",
    "source_total_text",
    "sources_summary",
    "sources",
    "warning",
    "message_id",
    "conversation_id"
  ];
  function parseBoundedInteger(raw, defaultValue, min, max, label) {
    const value = raw ?? defaultValue;
    let parsed;
    if (typeof value === "number") {
      parsed = value;
    } else if (typeof value === "string" && /^\d+$/.test(value)) {
      parsed = Number(value);
    } else {
      throw new ArgumentError(`${label} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
    }
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new ArgumentError(`${label} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
    }
    return parsed;
  }
  function parseAskTimeout(raw) {
    return parseBoundedInteger(raw, 90, 1, 180, "--timeout");
  }
  function parseAskLimit(raw) {
    return parseBoundedInteger(raw, 10, 1, 50, "--source-limit");
  }
  function cleanText(value) {
    return String(value ?? "").replace(/<[^>]+>/g, "").replace(/\u200b/g, "").replace(/\r\n/g, "\n").trim();
  }
  function compactSingleLine(value) {
    return cleanText(value).replace(/\s+/g, " ").trim();
  }
  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = compactSingleLine(value);
      if (text) return text;
    }
    return "";
  }
  function parseCount(value) {
    if (value === null || value === void 0 || value === "") return null;
    const toSafeCount = (number) => Number.isSafeInteger(number) && number >= 0 ? number : null;
    if (typeof value === "number") return toSafeCount(value);
    const text = String(value).trim();
    const compact = text.match(/^(\d+(?:\.\d+)?)\s*(万|[wW]|亿)\+?$/);
    if (compact) {
      const number = Number(compact[1]);
      const multiplier = compact[2] === "\u4EBF" ? 1e8 : 1e4;
      return Number.isFinite(number) ? toSafeCount(Math.round(number * multiplier)) : null;
    }
    const plain = text.replace(/,/g, "").replace(/\+$/, "");
    if (/^\d+$/.test(plain) && (text === plain || text === `${plain}+` || /^\d{1,3}(?:,\d{3})+\+?$/.test(text))) {
      return toSafeCount(Number(plain));
    }
    return null;
  }
  function parseUrlMaybe(value) {
    if (!value) return null;
    try {
      return new URL(String(value));
    } catch {
      return null;
    }
  }
  function parseTrustedSourceLink(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const xhsDiscoverMatch = raw.match(/^xhsdiscover:\/\/item\/([0-9a-f]{24})(?=[?#/]|$)/i);
    if (xhsDiscoverMatch) {
      const url2 = parseUrlMaybe(raw);
      return {
        noteId: xhsDiscoverMatch[1],
        xsecToken: url2?.searchParams.get("xsec_token") || url2?.searchParams.get("xsecToken") || "",
        href: raw
      };
    }
    let url = parseUrlMaybe(raw);
    if (!url && raw.startsWith("/")) {
      url = parseUrlMaybe(`https://${XHS_WEB_HOST}${raw}`);
    }
    const host = url?.hostname.toLowerCase();
    if (!url || url.protocol !== "https:" || host !== XHS_WEB_HOST && host !== "xiaohongshu.com") {
      return null;
    }
    const match = url.pathname.match(/^\/(?:explore|search_result|note)\/([0-9a-f]{24})\/?$/i);
    if (!match) return null;
    return {
      noteId: match[1],
      xsecToken: url.searchParams.get("xsec_token") || url.searchParams.get("xsecToken") || "",
      href: url.toString()
    };
  }
  function extractNoteId(source) {
    const directId = compactSingleLine(source?.id || source?.noteId || source?.note_id);
    if (/^[0-9a-f]{24}$/i.test(directId)) return directId;
    const candidates = [source?.textLink, source?.link, source?.url];
    for (const candidate of candidates) {
      const parsed = parseTrustedSourceLink(candidate);
      if (parsed?.noteId) return parsed.noteId;
    }
    return "";
  }
  function buildNoteUrl(noteId, xsecToken) {
    if (!/^[0-9a-f]{24}$/i.test(String(noteId || ""))) return "";
    const url = new URL(`https://${XHS_WEB_HOST}/explore/${noteId}`);
    if (xsecToken) {
      url.searchParams.set("xsec_token", xsecToken);
      url.searchParams.set("xsec_source", "");
    }
    return url.toString();
  }
  function extractQuote(source) {
    const content = cleanText(source?.content);
    if (!content) return "";
    const origin = Array.isArray(source?.originLocation) ? source.originLocation : [];
    const start = Number(origin[0]);
    const length = Number(origin[1]);
    if (Number.isInteger(start) && start >= 0 && Number.isInteger(length) && length > 0) {
      return compactSingleLine(content.slice(start, start + length)).slice(0, 300);
    }
    return compactSingleLine(content).slice(0, 300);
  }
  function normalizeAskSource(source, index) {
    const trustedLink = [source?.textLink, source?.link, source?.url].map(parseTrustedSourceLink).find(Boolean);
    const noteId = extractNoteId(source);
    const xsecToken = trustedLink?.xsecToken || "";
    const normalized = {
      rank: index + 1,
      type: "note",
      title: firstNonEmpty(source?.title, source?.displayTitle, source?.name),
      url: buildNoteUrl(noteId, xsecToken),
      note_id: noteId,
      xsec_token: xsecToken,
      author: firstNonEmpty(source?.nickName, source?.nickname, source?.author, source?.userName)
    };
    const noteType = firstNonEmpty(source?.noteType);
    if (noteType) normalized.note_type = noteType;
    const likeCount = parseCount(source?.like);
    if (likeCount !== null) normalized.like_count = likeCount;
    const userId = compactSingleLine(source?.userId);
    if (userId) normalized.user_id = userId;
    const publishedAt = compactSingleLine(source?.time);
    if (publishedAt) normalized.published_at = publishedAt;
    const quote = extractQuote(source);
    if (quote) normalized.quote = quote;
    if (trustedLink?.href) normalized.deeplink = trustedLink.href;
    return normalized;
  }
  function buildSourcesSummary(sources) {
    return sources.slice(0, 5).map((source) => `${source.rank}. ${source.title || source.note_id}${source.author ? ` - ${source.author}` : ""}`).join("\n");
  }
  function buildAskResult(raw) {
    const sourceItems = Array.isArray(raw?.sources) ? raw.sources : [];
    const sources = sourceItems.map((source, index) => normalizeAskSource(source, index)).filter((source) => source.note_id || source.title || source.url);
    const answer = cleanText(raw?.answer || raw?.base_info?.text || "");
    const sourceIssue = compactSingleLine(raw?.warning);
    const warning = sources.length === 0 && answer ? `Xiaohongshu \u70B9\u70B9 returned an answer but no citation sources.${sourceIssue ? ` ${sourceIssue}` : ""}` : sourceIssue;
    return {
      query: compactSingleLine(raw?.query),
      answer,
      source_count: sources.length,
      source_total_text: compactSingleLine(raw?.source_total_text),
      sources_summary: buildSourcesSummary(sources),
      sources,
      warning,
      message_id: compactSingleLine(raw?.message_id),
      conversation_id: compactSingleLine(raw?.conversation_id)
    };
  }
  function buildAskEvaluateJs(query, timeoutSeconds, sourceLimit) {
    const prompt = String(query);
    return `
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const timeoutMs = ${Number(timeoutSeconds)} * 1000;
        const sourceLimit = ${Number(sourceLimit)};
        const requestSourceSize = Math.max(sourceLimit, 10);
        const prompt = ${JSON.stringify(prompt)};
        const simplifyText = (value, max = 6000) => {
          const text = String(value || '');
          return text.length > max ? text.slice(0, max) : text;
        };
        const latestRound = (store, scenes, msgId) => {
          const rounds = typeof store.getSceneRounds === 'function'
            ? store.getSceneRounds(scenes.AiChat)
            : (Array.isArray(store.rounds) ? store.rounds : []);
          return [...rounds].reverse().find((round) => round?.aiMessage?.msgId === msgId) || null;
        };
        const slimSource = (item) => ({
          id: item?.id || item?.noteId || item?.note_id || '',
          title: item?.title || item?.displayTitle || '',
          type: item?.type || '',
          noteType: item?.noteType || '',
          userId: item?.userId || '',
          nickName: item?.nickName || item?.nickname || '',
          content: simplifyText(item?.content || '', 2000),
          originLocation: item?.originLocation || null,
          textLink: item?.textLink || '',
          link: item?.link || item?.imageList?.[0]?.link || '',
          url: item?.url || '',
          like: item?.like ?? null,
          time: item?.time || '',
        });
        try {
          if (!window.webpackChunkxhs_pc_web) {
            return { ok: false, error: 'webpack_runtime_missing', page_url: location.href };
          }
          let webpackRequire;
          window.webpackChunkxhs_pc_web.push([[Date.now()], {}, (req) => { webpackRequire = req; }]);
          if (!webpackRequire) return { ok: false, error: 'webpack_require_unavailable', page_url: location.href };
          // Locate the conversation store module.
          //
          // A hardcoded webpack module id has no contract with the site: Xiaohongshu
          // renumbers chunks on redeploys, and when it does, webpackRequire(<stale id>)
          // throws "Cannot read properties of undefined (reading 'call')" from webpack's
          // own runtime and every ask fails. That already happened once (6404 -> 32914).
          //
          // So: try known ids first (zero scan cost in the common case), then fall back
          // to locating the module by what it *is* rather than by its number. The scan
          // only calls .toString() on factory functions, which has no side effects; a
          // candidate is executed only after its source matches the fingerprint.
          const looksLikeConversationModule = (candidate) => (
            candidate
            && typeof candidate.t === 'function'
            && candidate.G
            && typeof candidate.G.AiChat === 'string'
          );
          let mod = null;
          for (const knownId of [32914, 6404]) {
            try {
              const candidate = webpackRequire(knownId);
              if (looksLikeConversationModule(candidate)) { mod = candidate; break; }
            } catch { /* id absent from this build */ }
          }
          if (!mod) {
            for (const id of Object.keys(webpackRequire.m || {})) {
              let source = '';
              try { source = webpackRequire.m[id].toString(); } catch { continue; }
              if (!source.includes('createConversation') || !source.includes('sendMessage')) continue;
              try {
                const candidate = webpackRequire(id);
                if (looksLikeConversationModule(candidate)) { mod = candidate; break; }
              } catch { /* not loadable, keep looking */ }
            }
          }
          const useConversationStore = mod?.t;
          const scenes = mod?.G || { AiChat: 'aiChat' };
          if (typeof useConversationStore !== 'function') {
            return { ok: false, error: 'conversation_store_missing', page_url: location.href };
          }
          const store = useConversationStore();
          if (typeof store.sendMessage !== 'function' || typeof store.createConversation !== 'function') {
            return { ok: false, error: 'conversation_api_missing', page_url: location.href };
          }
          if (typeof store.switchScene === 'function') store.switchScene(scenes.AiChat);
          if (typeof store.clearConversation === 'function') {
            await Promise.resolve(store.clearConversation(scenes.AiChat));
          }
          const conversationId = crypto.randomUUID();
          store.createConversation(conversationId, scenes.AiChat);
          const msgId = await store.sendMessage(conversationId, prompt, {
            skipImmediateUI: true,
            skipHistory: true,
            visible: false,
          });
          if (!msgId) {
            return { ok: false, error: 'send_message_failed', page_url: location.href };
          }

          const deadline = Date.now() + timeoutMs;
          let round = null;
          let finished = false;
          while (Date.now() < deadline) {
            await sleep(1000);
            round = latestRound(store, scenes, msgId);
            const answer = round?.aiMessage?.text || '';
            if (round?.aiMessage?.isFinished && answer) {
              finished = true;
              break;
            }
          }
          round = round || latestRound(store, scenes, msgId);
          const aiMessage = round?.aiMessage || {};
          const answer = aiMessage.text || (Array.isArray(aiMessage.dataFragments)
            ? aiMessage.dataFragments.map((fragment) => fragment?.text || '').join('')
            : '');
          if (!finished || !answer) {
            return { ok: false, error: 'answer_timeout', timeout_seconds: ${Number(timeoutSeconds)}, message_id: msgId, conversation_id: conversationId };
          }

          let detail = null;
          let sourceError = '';
          try {
            if (store.agent?.getResponseReferences) {
              for (let attempt = 0; attempt < 5; attempt++) {
              detail = await store.agent.getResponseReferences({
                query: prompt,
                message_id: msgId,
                page: 0,
                size: requestSourceSize,
                version: 0,
                result_version: 0,
                id: '',
              });
                if (Array.isArray(detail?.items) && detail.items.length > 0) break;
                await sleep(1000);
              }
            }
          } catch (err) {
            sourceError = String(err?.message || err || '');
          }

          const rawSources = Array.isArray(detail?.items) ? detail.items.slice(0, sourceLimit).map(slimSource) : [];
          return {
            ok: true,
            query: prompt,
            answer,
            source_total_text: detail?.baseInfo?.totalCnt || aiMessage?.querySource?.text || aiMessage?.querySource?.oneboxText || '',
            sources: rawSources,
            warning: sourceError,
            message_id: msgId,
            conversation_id: conversationId,
          };
        } catch (err) {
          return {
            ok: false,
            error: String(err?.message || err || 'unknown_error'),
            stack: String(err?.stack || '').slice(0, 1500),
            page_url: location.href,
          };
        }
      })()
    `;
  }
  function requirePrompt(query) {
    const prompt = String(query || "").trim();
    if (!prompt) throw new ArgumentError("query is required");
    return prompt;
  }
  function mapAskError(raw, timeoutSeconds) {
    const error = compactSingleLine(raw?.error);
    if (error === "answer_timeout") {
      throw new TimeoutError("xiaohongshu ask", timeoutSeconds, "\u70B9\u70B9\u6CA1\u6709\u5728\u8D85\u65F6\u65F6\u95F4\u5185\u8FD4\u56DE\u7B54\u6848\uFF1B\u53EF\u4EE5\u91CD\u8BD5\u6216\u63D0\u9AD8 --timeout\u3002");
    }
    if (error === "send_message_failed") {
      throw new AuthRequiredError(XHS_WEB_HOST, "Xiaohongshu \u70B9\u70B9 did not accept the query. Check login status for www.xiaohongshu.com.");
    }
    throw new CommandExecutionError(
      `xiaohongshu ask failed: ${error || "unknown error"}`,
      raw?.page_url ? `Page URL: ${raw.page_url}` : void 0
    );
  }
  function requireAskPayload(raw) {
    if (!raw || typeof raw !== "object") {
      throw new CommandExecutionError("xiaohongshu ask returned a malformed page payload");
    }
    const answer = cleanText(raw.answer || raw.base_info?.text || "");
    if (!answer) {
      throw new CommandExecutionError("xiaohongshu ask returned a malformed page payload: missing answer");
    }
    if (!compactSingleLine(raw.message_id) || !compactSingleLine(raw.conversation_id)) {
      throw new CommandExecutionError("xiaohongshu ask returned a malformed page payload: missing message identity");
    }
  }
  var command = cli({
    site: "xiaohongshu",
    name: "ask",
    access: "write",
    description: "Ask \u5C0F\u7EA2\u4E66\u70B9\u70B9 and return the answer with citation sources.",
    domain: XHS_WEB_HOST,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "query", positional: true, required: true, help: "Question for \u70B9\u70B9" },
      { name: "timeout", type: "int", default: 90, help: "Seconds to wait for the \u70B9\u70B9 answer" },
      { name: "source-limit", type: "int", default: 10, help: "Maximum citation sources to return" }
    ],
    columns: ASK_COLUMNS,
    func: async (page, kwargs) => {
      const query = requirePrompt(kwargs?.query);
      const timeout = parseAskTimeout(kwargs?.timeout);
      const sourceLimit = parseAskLimit(kwargs?.["source-limit"]);
      await page.goto(`https://${XHS_WEB_HOST}/ai_chat`);
      await page.wait?.(1);
      const raw = unwrapEvaluateResult(await page.evaluate(buildAskEvaluateJs(query, timeout, sourceLimit)));
      if (!raw || typeof raw !== "object") {
        throw new CommandExecutionError("xiaohongshu ask returned a malformed page payload");
      }
      if (raw.ok === false) mapAskError(raw, timeout);
      requireAskPayload(raw);
      return buildAskResult(raw);
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/user-helpers.js
  function toCleanString(value) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  }
  function normalizeXhsUserId(input) {
    const trimmed = toCleanString(input);
    const withoutQuery = trimmed.replace(/[?#].*$/, "");
    const matched = withoutQuery.match(/\/user\/profile\/([a-zA-Z0-9]+)/);
    if (matched?.[1])
      return matched[1];
    return withoutQuery.replace(/\/+$/, "").split("/").pop() ?? withoutQuery;
  }
  function flattenXhsNoteGroups(noteGroups) {
    if (!Array.isArray(noteGroups))
      return [];
    const notes = [];
    for (const group of noteGroups) {
      if (!group)
        continue;
      if (Array.isArray(group)) {
        for (const item of group) {
          if (item)
            notes.push(item);
        }
        continue;
      }
      notes.push(group);
    }
    return notes;
  }
  function buildXhsNoteUrl(userId, noteId, xsecToken, webHost = "www.xiaohongshu.com") {
    const cleanUserId = toCleanString(userId);
    const cleanNoteId = toCleanString(noteId);
    if (!cleanUserId || !cleanNoteId)
      return "";
    const url = new URL(`https://${webHost}/user/profile/${cleanUserId}/${cleanNoteId}`);
    const cleanToken = toCleanString(xsecToken);
    if (cleanToken) {
      url.searchParams.set("xsec_token", cleanToken);
      url.searchParams.set("xsec_source", "pc_user");
    }
    return url.toString();
  }
  function extractXhsUserNotes(snapshot, fallbackUserId, webHost = "www.xiaohongshu.com") {
    const notes = flattenXhsNoteGroups(snapshot.noteGroups);
    const rows = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of notes) {
      const noteCard = entry?.noteCard ?? entry?.note_card ?? entry;
      if (!noteCard || typeof noteCard !== "object")
        continue;
      const noteId = toCleanString(noteCard.noteId ?? noteCard.note_id ?? entry?.noteId ?? entry?.note_id ?? entry?.id);
      if (!noteId || seen.has(noteId))
        continue;
      seen.add(noteId);
      const userId = toCleanString(noteCard.user?.userId ?? noteCard.user?.user_id ?? fallbackUserId);
      const xsecToken = toCleanString(entry?.xsecToken ?? entry?.xsec_token ?? noteCard.xsecToken ?? noteCard.xsec_token);
      const likes = toCleanString(noteCard.interactInfo?.likedCount ?? noteCard.interact_info?.liked_count ?? 0) || "0";
      const cover = toCleanString(noteCard.cover?.urlDefault ?? noteCard.cover?.urlPre ?? noteCard.cover?.url ?? "");
      rows.push({
        id: noteId,
        title: toCleanString(noteCard.displayTitle ?? noteCard.display_title ?? noteCard.title),
        type: toCleanString(noteCard.type),
        likes,
        cover,
        url: buildXhsNoteUrl(userId || fallbackUserId, noteId, xsecToken, webHost)
      });
    }
    return rows;
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/collection-helpers.js
  var COLLECT_API_PATTERN = "note/collect/page";
  var LIKE_API_PATTERN = "note/like/page";
  var SAVED_PROFILE_TAB = "fav";
  var LIKED_PROFILE_TAB = "liked";
  function buildProfileCollectionUrl(userId, tab) {
    const cleanUserId = toCleanString2(userId);
    const cleanTab = toCleanString2(tab);
    const url = new URL(`https://www.xiaohongshu.com/user/profile/${cleanUserId}`);
    url.searchParams.set("tab", cleanTab);
    url.searchParams.set("subTab", "note");
    return url.toString();
  }
  function toCleanString2(value) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  }
  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }
  function unwrapBrowserResult(payload) {
    if (isObject(payload) && "session" in payload && "data" in payload) {
      return payload.data;
    }
    return payload;
  }
  function parseCollectionLimit(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1 || parsed > 100) {
      throw new ArgumentError(`--limit must be between 1 and 100, got ${parsed}`);
    }
    return parsed;
  }
  function mapCollectionNote(entry, options = {}) {
    if (!isObject(entry))
      return null;
    const noteCard = entry.note_card ?? entry.noteCard ?? entry;
    const noteId = toCleanString2(entry.note_id ?? entry.noteId ?? entry.id ?? noteCard.note_id ?? noteCard.noteId ?? noteCard.id);
    if (!noteId)
      return null;
    const user = noteCard.user ?? entry.user ?? {};
    const userId = toCleanString2(user.user_id ?? user.userId ?? "");
    const xsecToken = toCleanString2(entry.xsec_token ?? entry.xsecToken ?? noteCard.xsec_token ?? noteCard.xsecToken);
    if (!xsecToken)
      return null;
    const interact = noteCard.interact_info ?? noteCard.interactInfo ?? entry.interact_info ?? entry.interactInfo ?? {};
    const url = userId ? buildXhsNoteUrl(userId, noteId, xsecToken) : `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_user`;
    return {
      id: noteId,
      title: toCleanString2(noteCard.display_title ?? noteCard.displayTitle ?? noteCard.title ?? entry.title ?? entry.display_title),
      author: toCleanString2(user.nickname ?? user.nick_name ?? user.name),
      likes: toCleanString2(interact.liked_count ?? interact.likedCount ?? 0) || "0",
      type: toCleanString2(noteCard.type ?? entry.type),
      url
    };
  }
  function extractNotesFromResponses(requests, fallbackUserId) {
    const rows = [];
    const seen = /* @__PURE__ */ new Set();
    for (const req of requests ?? []) {
      const payload = unwrapBrowserResult(req);
      if (!isObject(payload)) {
        throw new CommandExecutionError("xiaohongshu collection API returned a malformed payload");
      }
      const data = payload.data;
      if (!isObject(data)) {
        throw new CommandExecutionError("xiaohongshu collection API returned malformed data");
      }
      const notes = data.notes ?? data.note_list;
      if (!Array.isArray(notes))
        throw new CommandExecutionError("xiaohongshu collection API returned malformed notes");
      for (const entry of notes) {
        const row = mapCollectionNote(entry, { fallbackUserId });
        if (!row?.id || !row.url.includes("xsec_token=")) {
          throw new CommandExecutionError("xiaohongshu collection API returned a note without stable id/xsec token");
        }
        if (seen.has(row.id))
          continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
    return rows;
  }
  var EXTRACT_COLLECTION_DOM_JS = `
  (() => {
    const normalizeUrl = (href) => {
      if (!href) return '';
      let url;
      try {
        url = new URL(href, 'https://www.xiaohongshu.com');
      } catch {
        return '';
      }
      if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com') return '';
      if (!url.searchParams.get('xsec_token')) return '';
      return url.toString();
    };
    const cleanText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const results = [];
    const seen = new Set();
    document.querySelectorAll('section.note-item').forEach((el) => {
      if (el.classList.contains('query-note-item')) return;
      const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
      const nameEl = el.querySelector('a.author .name, .author-name, .nick-name, .name');
      const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
      const detailLinkEl =
        el.querySelector('a.cover.mask') ||
        el.querySelector('a[href*="/search_result/"]') ||
        el.querySelector('a[href*="/explore/"]') ||
        el.querySelector('a[href*="/note/"]') ||
        el.querySelector('a[href*="/user/profile/"]');
      const url = normalizeUrl(detailLinkEl?.getAttribute('href') || '');
      if (!url) return;
      const noteIdMatch = url.match(/\\/(?:search_result|explore|note)\\/([0-9a-f]{24})|\\/user\\/profile\\/[^/]+\\/([0-9a-f]{24})/i);
      const id = noteIdMatch?.[1] || noteIdMatch?.[2] || '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      results.push({
        id,
        title: cleanText(titleEl?.textContent || ''),
        author: cleanText(nameEl?.textContent || ''),
        likes: cleanText(likesEl?.textContent || '0'),
        type: '',
        url,
      });
    });
    return results;
  })()
`;
  var LOGIN_WALL_JS = `
  (() => {
    const pathName = (typeof location !== 'undefined' && location.pathname) ? location.pathname : '';
    const userStore = window.__INITIAL_STATE__?.user;
    const loggedInVal = userStore ? (userStore.loggedIn?._value ?? userStore.loggedIn) : undefined;
    const bodyText = document.body?.innerText || '';
    return Boolean(pathName.indexOf('/login') === 0 || loggedInVal === false || /\u767B\u5F55\u540E|\u8BF7\u5148\u767B\u5F55|\u767B\u5F55\u540E\u67E5\u770B/.test(bodyText));
  })()
`;
  var CURRENT_LOCATION_JS = `
  (() => ({
    href: location.href,
    hostname: location.hostname,
    pathname: location.pathname,
  }))()
`;
  async function throwIfLoginWall(page) {
    const payload = unwrapBrowserResult(await page.evaluate(LOGIN_WALL_JS));
    if (payload === true) {
      throw new AuthRequiredError("www.xiaohongshu.com", "Xiaohongshu collection page requires login; re-login to xiaohongshu.com and retry.");
    }
  }
  async function assertOnCollectionProfile(page, userId) {
    await throwIfLoginWall(page);
    const payload = unwrapBrowserResult(await page.evaluate(CURRENT_LOCATION_JS));
    if (!isObject(payload)) {
      throw new CommandExecutionError("xiaohongshu collection page returned malformed location");
    }
    const hostname = toCleanString2(payload.hostname).toLowerCase();
    const pathname = toCleanString2(payload.pathname);
    if (hostname === "www.xiaohongshu.com" && pathname === "/login") {
      throw new AuthRequiredError("xiaohongshu collection page requires login");
    }
    const expectedPath = `/user/profile/${toCleanString2(userId)}`;
    if (hostname !== "www.xiaohongshu.com" || pathname !== expectedPath) {
      throw new CommandExecutionError(`xiaohongshu collection landed on unexpected page: ${toCleanString2(payload.href) || `${hostname}${pathname}`}`);
    }
  }
  async function accumulateInterceptedNotes(page, bucket, fallbackUserId) {
    const reqs = await page.getInterceptedRequests();
    if (!Array.isArray(reqs)) {
      throw new CommandExecutionError("xiaohongshu collection interceptor returned malformed captures");
    }
    if (Array.isArray(reqs) && reqs.length > 0)
      bucket.push(...reqs);
    return extractNotesFromResponses(bucket, fallbackUserId);
  }
  async function resolveXhsUserId(page, rawId) {
    if (rawId)
      return normalizeXhsUserId(String(rawId));
    await page.wait(2);
    await throwIfLoginWall(page);
    const userId = unwrapBrowserResult(await page.evaluate(`() => {
      const user = window.__INITIAL_STATE__?.user?.userInfo;
      const info = user?._value ?? user ?? {};
      return info.user_id || info.userId || info.userID || '';
    }`));
    const clean = toCleanString2(userId);
    if (!clean) {
      throw new AuthRequiredError("www.xiaohongshu.com", "Not logged into Xiaohongshu (could not resolve current user id)");
    }
    return clean;
  }
  async function extractNotesFromDom(page) {
    const payload = unwrapBrowserResult(await page.evaluate(EXTRACT_COLLECTION_DOM_JS));
    if (!Array.isArray(payload)) {
      throw new CommandExecutionError("xiaohongshu collection DOM extraction returned malformed rows");
    }
    return payload.filter((item) => item?.id);
  }
  async function fetchXhsCollectionNotes(page, {
    userId,
    profileTab,
    apiPattern,
    limit,
    emptyLabel
  }) {
    const capturedRequests = [];
    await page.installInterceptor(apiPattern);
    await page.goto(buildProfileCollectionUrl(userId, profileTab));
    await page.wait(2);
    await assertOnCollectionProfile(page, userId);
    let notes = [];
    for (let i = 0; i < 16; i++) {
      await page.wait(0.5);
      notes = await accumulateInterceptedNotes(page, capturedRequests, userId);
      if (notes.length > 0)
        break;
    }
    let previousCount = notes.length;
    for (let i = 0; notes.length < limit && i < 4; i += 1) {
      await page.autoScroll({ times: 1, delayMs: 1500 });
      await page.wait(1);
      await assertOnCollectionProfile(page, userId);
      const nextNotes = await accumulateInterceptedNotes(page, capturedRequests, userId);
      if (nextNotes.length > previousCount) {
        notes = nextNotes;
        previousCount = nextNotes.length;
        continue;
      }
      break;
    }
    if (notes.length === 0) {
      const domNotes = await extractNotesFromDom(page);
      if (domNotes.length > 0)
        notes = domNotes;
    }
    if (notes.length === 0) {
      throw new EmptyResultError("xiaohongshu collection", `No ${emptyLabel} notes found. Ensure you are logged in and this profile tab is visible.`);
    }
    return notes.slice(0, limit).map((item, index) => ({
      rank: index + 1,
      ...item
    }));
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/note-helpers.js
  function parseNoteId(input) {
    const trimmed = input.trim();
    const match = trimmed.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i);
    return match ? match[1] || match[2] : trimmed;
  }
  var XHS_SIGNED_URL_HINT = "Pass a full Xiaohongshu note URL with xsec_token from search results or user/profile context.";
  function isShortLink(input) {
    return /^https?:\/\/xhslink\.com\//i.test(input);
  }
  function isHostMatch(hostname, cookieRoot) {
    const normalized = hostname.toLowerCase();
    return normalized === cookieRoot || normalized.endsWith("." + cookieRoot);
  }
  function isSupportedNotePath(pathname) {
    return /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname) || /^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname);
  }
  function buildNoteUrl2(input, options = {}) {
    const {
      allowShortLink = false,
      commandName = "xiaohongshu note",
      cookieRoot = "xiaohongshu.com",
      signedUrlHint = XHS_SIGNED_URL_HINT
    } = options;
    const trimmed = input.trim();
    const message = `${commandName} now requires a full signed URL`;
    const hint = allowShortLink ? `${signedUrlHint} For downloads, xhslink short links are also supported.` : signedUrlHint;
    if (/^https?:\/\//.test(trimmed)) {
      if (isShortLink(trimmed)) {
        if (allowShortLink)
          return trimmed;
        throw new ArgumentError(message, hint);
      }
      try {
        const url = new URL(trimmed);
        const xsecToken = url.searchParams.get("xsec_token")?.trim();
        if (isHostMatch(url.hostname, cookieRoot) && isSupportedNotePath(url.pathname) && xsecToken) {
          return trimmed;
        }
      } catch {
      }
      throw new ArgumentError(message, hint);
    }
    throw new ArgumentError(message, hint);
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/risk-control.js
  function jitterSeconds(minS, maxS, rand = Math.random) {
    return minS + rand() * (maxS - minS);
  }
  function isSecurityBlock(data) {
    return Boolean(data && typeof data === "object" && !Array.isArray(data) && data.securityBlock);
  }
  async function readXhsDetailPage(page, {
    url,
    extractJs,
    securityHelp,
    settleMinS = 2,
    settleMaxS = 5,
    retryOnBlock = true,
    cooldownMinS = 8,
    cooldownMaxS = 18,
    rand = Math.random
  } = {}) {
    let readAttempt = 0;
    const readOnce = async () => {
      await page.goto(url, { reload: readAttempt++ > 0 });
      await page.wait({ time: jitterSeconds(settleMinS, settleMaxS, rand) });
      return page.evaluate(extractJs);
    };
    let data = await readOnce();
    if (retryOnBlock && isSecurityBlock(data)) {
      await page.wait({ time: jitterSeconds(cooldownMinS, cooldownMaxS, rand) });
      data = await readOnce();
    }
    if (isSecurityBlock(data)) {
      throw new CliError(
        "SECURITY_BLOCK",
        "Xiaohongshu security block: the note detail page was blocked by risk control.",
        securityHelp
      );
    }
    return data;
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/comments.js
  var XHS_PROFILE_HREF_SELECTOR = '.author-wrapper a[href*="/user/profile/"], a.name[href*="/user/profile/"], a.user-name[href*="/user/profile/"], a[href*="/user/profile/"]';
  function parseXhsProfileHref(href, webHost = "www.xiaohongshu.com") {
    const raw = typeof href === "string" ? href.trim() : "";
    if (!raw)
      return "";
    const expectedHost = String(webHost || "www.xiaohongshu.com").toLowerCase();
    let parsed;
    try {
      parsed = new URL(raw, `https://${expectedHost}`);
    } catch {
      return "";
    }
    if (parsed.protocol !== "https:")
      return "";
    const host = parsed.hostname.toLowerCase();
    if (host !== expectedHost)
      return "";
    const match = parsed.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]+)\/?$/);
    return match?.[1] ?? "";
  }
  function buildXhsProfileUrl(href, webHost = "www.xiaohongshu.com") {
    const userId = parseXhsProfileHref(href, webHost);
    if (!userId)
      return "";
    return `https://${webHost}/user/profile/${userId}`;
  }
  function parseCommentLimit(raw, fallback = 20) {
    const n = Number(raw);
    if (!Number.isFinite(n))
      return fallback;
    return Math.max(1, Math.min(Math.floor(n), 50));
  }
  function parseXhsLikeCountText(value) {
    const integerRe = /^(?:\d+|\d{1,3}(?:[,，]\d{3})+)\+?$/u;
    const shortformRe = /^((?:\d+|\d{1,3}(?:[,，]\d{3})+)(?:\.\d+)?)([wWkK万千])\+?$/u;
    const raw = String(value ?? "").replace(/\s+/g, "");
    if (!raw)
      return 0;
    if (integerRe.test(raw))
      return Number(raw.replace(/[,+，]/g, ""));
    const short = raw.match(shortformRe);
    if (!short)
      return 0;
    const numeric = Number(short[1].replace(/[,，]/g, ""));
    if (!Number.isFinite(numeric))
      return 0;
    const unit = short[2].toLowerCase();
    const multiplier = unit === "w" || unit === "\u4E07" ? 1e4 : 1e3;
    return Math.round(numeric * multiplier);
  }
  function normalizeOptionalString(value, field, commandName) {
    if (value == null)
      return "";
    if (typeof value !== "string") {
      throw new CommandExecutionError(`${commandName}: malformed comment row ${field}`);
    }
    return value;
  }
  function normalizeCommentImages(value, commandName) {
    if (value == null)
      return [];
    if (!Array.isArray(value)) {
      throw new CommandExecutionError(`${commandName}: malformed comment row images`);
    }
    const urls = [];
    for (const raw of value) {
      if (typeof raw !== "string") {
        throw new CommandExecutionError(`${commandName}: malformed comment row image URL`);
      }
      const trimmed = raw.trim();
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new CommandExecutionError(`${commandName}: malformed comment row image URL`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:" || parsed.username || parsed.password) {
        throw new CommandExecutionError(`${commandName}: malformed comment row image URL`);
      }
      const href = parsed.toString();
      if (!urls.includes(href))
        urls.push(href);
    }
    return urls;
  }
  function normalizeCommentRows(value, commandName = "xiaohongshu/comments") {
    if (value == null)
      return [];
    if (!Array.isArray(value)) {
      throw new CommandExecutionError(`${commandName}: malformed comments payload`);
    }
    return value.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new CommandExecutionError(`${commandName}: malformed comment row at index ${index}`);
      }
      const text = normalizeOptionalString(row.text, "text", commandName);
      if (!text) {
        throw new CommandExecutionError(`${commandName}: malformed comment row text`);
      }
      const likes = Number(row.likes);
      if (!Number.isInteger(likes) || likes < 0) {
        throw new CommandExecutionError(`${commandName}: malformed comment row likes`);
      }
      if (typeof row.is_reply !== "boolean") {
        throw new CommandExecutionError(`${commandName}: malformed comment row is_reply`);
      }
      return {
        author: normalizeOptionalString(row.author, "author", commandName),
        authorHrefRaw: normalizeOptionalString(row.authorHrefRaw, "authorHrefRaw", commandName),
        text,
        likes,
        time: normalizeOptionalString(row.time, "time", commandName),
        is_reply: row.is_reply,
        reply_to: normalizeOptionalString(row.reply_to, "reply_to", commandName),
        images: normalizeCommentImages(row.images, commandName)
      };
    });
  }
  function buildCommentsExtractJs(withReplies, limit = 20) {
    const parseLikeCountText = parseXhsLikeCountText.toString();
    return `
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms))
        const withReplies = ${withReplies}
        const targetCount = ${Number(limit) || 20}

        // Check login state
        const bodyText = document.body?.innerText || ''
        const loginWall = /\u767B\u5F55\u540E\u67E5\u770B|\u8BF7\u767B\u5F55/.test(bodyText)
        const securityBlock = /\u5B89\u5168\u9650\u5236|\u8BBF\u95EE\u94FE\u63A5\u5F02\u5E38/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)

        // Scroll to trigger comment loading. Xiaohongshu loads comments in
        // small async batches via IntersectionObserver, and depending on the
        // page layout / viewport the actual scrollable ancestor can be
        // .note-scroller, .container, or the document itself \u2014 so each round
        // drives all of them plus scrollIntoView on the last loaded comment,
        // which works regardless of which element actually owns the scrollbar.
        // A single stalled round doesn't mean the list is exhausted \u2014 keep
        // going until growth stalls for several consecutive rounds, we've
        // loaded enough top-level comments to satisfy --limit, or we hit the
        // hard round cap.
        const scroller = document.querySelector('.note-scroller') || document.querySelector('.container')
        const driveScroll = () => {
          if (scroller) scroller.scrollTo(0, scroller.scrollHeight)
          const comments = document.querySelectorAll('.parent-comment')
          const last = comments[comments.length - 1]
          if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'end' })
          if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            window.scrollTo(0, document.body.scrollHeight)
          }
        }
        {
          let stall = 0
          for (let i = 0; i < 60; i++) {
            const beforeCount = document.querySelectorAll('.parent-comment').length
            if (beforeCount >= targetCount) break
            driveScroll()
            await wait(1000 + Math.random() * 1200)
            const afterCount = document.querySelectorAll('.parent-comment').length
            if (afterCount <= beforeCount) {
              stall++
              if (stall >= 6) break
            } else {
              stall = 0
            }
          }
        }

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
        const parseLikeCountText = ${parseLikeCountText}
        const parseLikes = (el) => {
          return parseLikeCountText(clean(el))
        }
        const HREF_SELECTOR = ${JSON.stringify(XHS_PROFILE_HREF_SELECTOR)}
        const extractAuthorHref = (el) => {
          if (!el) return ''
          const anchor = el.querySelector(HREF_SELECTOR)
          return anchor ? (anchor.getAttribute('href') || '') : ''
        }
        // Attached comment photos, excluding avatars, inline emoji, badges, and
        // other UI images. Only images inside comment/reply media containers are
        // projected as media evidence.
        const extractImages = (el) => {
          if (!el) return []
          const urls = []
          el.querySelectorAll('img').forEach(img => {
            if (img.classList.contains('avatar-item')) return
            if (img.closest('.content, .note-text')) return
            if (!img.closest('.comment-pic, .reply-pic, .comment-image, .reply-image, .comment-img, .reply-img, [class*="comment-pic"], [class*="reply-pic"], [class*="comment-image"], [class*="reply-image"]')) return
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || ''
            if (src && !urls.includes(src)) urls.push(src)
          })
          return urls
        }
        const expandReplyThreads = async (root) => {
          if (!withReplies || !root) return
          const clickedTexts = new Set()
          for (let round = 0; round < 3; round++) {
            const expanders = Array.from(root.querySelectorAll('button, [role="button"], span, div')).filter(el => {
              if (!(el instanceof HTMLElement)) return false
              const text = clean(el)
              if (!text || text.length > 24) return false
              if (!/(\u5C55\u5F00|\u66F4\u591A\u56DE\u590D|\u5168\u90E8\u56DE\u590D|\u67E5\u770B.*\u56DE\u590D|\u5171\\d+\u6761\u56DE\u590D)/.test(text)) return false
              if (clickedTexts.has(text)) return false
              return true
            })
            if (!expanders.length) break
            for (const el of expanders) {
              const text = clean(el)
              el.click()
              clickedTexts.add(text)
              await wait(200 + Math.random() * 300)
            }
          }
        }

        const results = []
        const parents = document.querySelectorAll('.parent-comment')
        for (const p of parents) {
          const item = p.querySelector('.comment-item')
          if (!item) continue

          const author = clean(item.querySelector('.author-wrapper .name, .user-name'))
          const authorHrefRaw = extractAuthorHref(item)
          const text = clean(item.querySelector('.content, .note-text'))
          const likes = parseLikes(item.querySelector('.count'))
          const time = clean(item.querySelector('.date, .time'))
          const images = extractImages(item)

          if (!text) continue
          results.push({ author, authorHrefRaw, text, likes, time, is_reply: false, reply_to: '', images })

          // Extract nested replies (\u697C\u4E2D\u697C)
          if (withReplies) {
            await expandReplyThreads(p)
            p.querySelectorAll('.reply-container .comment-item-sub, .sub-comment-list .comment-item').forEach(sub => {
              const sAuthor = clean(sub.querySelector('.name, .user-name'))
              const sAuthorHrefRaw = extractAuthorHref(sub)
              const sContent = sub.querySelector('.content, .note-text')
              const sText = clean(sContent)
              // Xiaohongshu renders the direct target only for reply-to-reply
              // rows (\u56DE\u590D <span class="nickname">Bob</span> : ...). A nested
              // row without that marker is a direct reply to the thread root.
              const sReplyTo = clean(sContent?.querySelector(':scope > .nickname')) || author
              const sLikes = parseLikes(sub.querySelector('.count'))
              const sTime = clean(sub.querySelector('.date, .time'))
              const sImages = extractImages(sub)
              if (!sText) return
              results.push({ author: sAuthor, authorHrefRaw: sAuthorHrefRaw, text: sText, likes: sLikes, time: sTime, is_reply: true, reply_to: sReplyTo, images: sImages })
            })
          }
        }

        return { pageUrl: location.href, securityBlock, loginWall, results }
      })()
    `;
  }
  var command2 = cli({
    site: "xiaohongshu",
    name: "comments",
    access: "read",
    description: "\u83B7\u53D6\u5C0F\u7EA2\u4E66\u7B14\u8BB0\u8BC4\u8BBA\uFF08\u652F\u6301\u697C\u4E2D\u697C\u5B50\u56DE\u590D\uFF09",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      { name: "note-id", required: true, positional: true, help: "Full Xiaohongshu note URL with xsec_token" },
      { name: "limit", type: "int", default: 20, help: "Number of top-level comments (max 50)" },
      { name: "with-replies", type: "boolean", default: false, help: "Include nested replies; reply_to is the direct target shown by the page" }
    ],
    columns: ["rank", "author", "userId", "profileUrl", "text", "likes", "time", "is_reply", "reply_to", "images"],
    func: async (page, kwargs) => {
      const limit = parseCommentLimit(kwargs.limit);
      const withReplies = Boolean(kwargs["with-replies"]);
      const raw = String(kwargs["note-id"]);
      const noteId = parseNoteId(raw);
      const data = await readXhsDetailPage(page, {
        url: buildNoteUrl2(raw, { commandName: "xiaohongshu comments" }),
        extractJs: buildCommentsExtractJs(withReplies, limit),
        securityHelp: /^https?:\/\//.test(raw) ? "The page may be temporarily restricted. Try again later or from a different session." : "Try using a full URL from search results (with xsec_token) instead of a bare note ID."
      });
      if (!data || typeof data !== "object") {
        throw new EmptyResultError("xiaohongshu/comments", "Unexpected evaluate response");
      }
      if (data.loginWall) {
        throw new AuthRequiredError("www.xiaohongshu.com", "Note comments require login");
      }
      void noteId;
      if (!Array.isArray(data.results)) throw new CommandExecutionError("Missing comment results payload");
      const all = normalizeCommentRows(data.results, "xiaohongshu/comments");
      const enrich = (c, i) => ({
        rank: i + 1,
        author: c.author,
        userId: c.authorHrefRaw ? parseXhsProfileHref(c.authorHrefRaw) : "",
        profileUrl: c.authorHrefRaw ? buildXhsProfileUrl(c.authorHrefRaw) : "",
        text: c.text,
        likes: c.likes,
        time: c.time,
        is_reply: c.is_reply,
        reply_to: c.reply_to,
        images: c.images ?? []
      });
      if (withReplies) {
        const limited = [];
        let topCount = 0;
        for (const c of all) {
          if (!c.is_reply)
            topCount++;
          if (topCount > limit)
            break;
          limited.push(c);
        }
        return limited.map(enrich);
      }
      return all.slice(0, limit).map(enrich);
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/creator-note-detail.js
  var NOTE_DETAIL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  var NOTE_DETAIL_METRICS = [
    { label: "\u66DD\u5149\u6570", section: "\u57FA\u7840\u6570\u636E" },
    { label: "\u89C2\u770B\u6570", section: "\u57FA\u7840\u6570\u636E" },
    { label: "\u5C01\u9762\u70B9\u51FB\u7387", section: "\u57FA\u7840\u6570\u636E" },
    { label: "\u5E73\u5747\u89C2\u770B\u65F6\u957F", section: "\u57FA\u7840\u6570\u636E" },
    { label: "\u6DA8\u7C89\u6570", section: "\u57FA\u7840\u6570\u636E" },
    { label: "\u70B9\u8D5E\u6570", section: "\u4E92\u52A8\u6570\u636E" },
    { label: "\u8BC4\u8BBA\u6570", section: "\u4E92\u52A8\u6570\u636E" },
    { label: "\u6536\u85CF\u6570", section: "\u4E92\u52A8\u6570\u636E" },
    { label: "\u5206\u4EAB\u6570", section: "\u4E92\u52A8\u6570\u636E" }
  ];
  var NOTE_DETAIL_METRIC_LABELS = new Set(NOTE_DETAIL_METRICS.map((metric) => metric.label));
  var NOTE_DETAIL_SECTIONS = new Set(NOTE_DETAIL_METRICS.map((metric) => metric.section));
  var NOTE_DETAIL_NOISE_LINES = /* @__PURE__ */ new Set([
    "\u5207\u6362\u7B14\u8BB0",
    "\u7B14\u8BB0\u8BCA\u65AD",
    "\u6838\u5FC3\u6570\u636E",
    "\u89C2\u770B\u6765\u6E90",
    "\u89C2\u4F17\u753B\u50CF",
    "\u63D0\u5347\u5EFA\u8BAE",
    "\u57FA\u7840\u6570\u636E",
    "\u4E92\u52A8\u6570\u636E",
    "\u5BFC\u51FA\u6570\u636E",
    "\u5B9E\u65F6",
    "\u6309\u5C0F\u65F6",
    "\u6309\u5929"
  ]);
  function findNoteTitle(lines) {
    const detailIndex = lines.indexOf("\u7B14\u8BB0\u6570\u636E\u8BE6\u60C5");
    if (detailIndex < 0)
      return "";
    for (let i = detailIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("#") || NOTE_DETAIL_DATETIME_RE.test(line))
        continue;
      if (NOTE_DETAIL_NOISE_LINES.has(line))
        continue;
      return line;
    }
    return "";
  }
  function findMetricValue(lines, startIndex) {
    let value = "";
    let extra = "";
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line)
        continue;
      if (NOTE_DETAIL_METRIC_LABELS.has(line))
        break;
      if (NOTE_DETAIL_NOISE_LINES.has(line) || line.startsWith("\u6570\u636E\u66F4\u65B0\u81F3") || line.startsWith("\u90E8\u5206\u6570\u636E\u7EDF\u8BA1\u4E2D"))
        continue;
      if (!value) {
        value = line;
        continue;
      }
      if (!extra && line.startsWith("\u7C89\u4E1D")) {
        extra = line;
        break;
      }
      if (line === "0" || /^\d/.test(line) || line.endsWith("%") || line.endsWith("\u79D2")) {
        break;
      }
    }
    return { value, extra };
  }
  function findPublishedAt(text) {
    const match = text.match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/);
    return match?.[0] ?? "";
  }
  function parseCreatorNoteDetailText(bodyText, noteId) {
    const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
    const title = findNoteTitle(lines);
    const publishedAt = lines.find((line) => NOTE_DETAIL_DATETIME_RE.test(line)) ?? "";
    const rows = [
      { section: "\u7B14\u8BB0\u4FE1\u606F", metric: "note_id", value: noteId, extra: "" },
      { section: "\u7B14\u8BB0\u4FE1\u606F", metric: "title", value: title, extra: "" },
      { section: "\u7B14\u8BB0\u4FE1\u606F", metric: "published_at", value: publishedAt, extra: "" }
    ];
    for (const metric of NOTE_DETAIL_METRICS) {
      const index = lines.indexOf(metric.label);
      if (index < 0)
        continue;
      const { value, extra } = findMetricValue(lines, index);
      rows.push({
        section: metric.section,
        metric: metric.label,
        value,
        extra
      });
    }
    return rows;
  }
  function parseCreatorNoteDetailDomData(dom, noteId) {
    if (!dom)
      return [];
    const title = typeof dom.title === "string" ? dom.title.trim() : "";
    const infoText = typeof dom.infoText === "string" ? dom.infoText : "";
    const sections = Array.isArray(dom.sections) ? dom.sections : [];
    const rows = [
      { section: "\u7B14\u8BB0\u4FE1\u606F", metric: "note_id", value: noteId, extra: "" },
      { section: "\u7B14\u8BB0\u4FE1\u606F", metric: "title", value: title, extra: "" },
      { section: "\u7B14\u8BB0\u4FE1\u606F", metric: "published_at", value: findPublishedAt(infoText), extra: "" }
    ];
    for (const section of sections) {
      if (!NOTE_DETAIL_SECTIONS.has(section.title))
        continue;
      for (const metric of section.metrics) {
        if (!NOTE_DETAIL_METRIC_LABELS.has(metric.label))
          continue;
        rows.push({
          section: section.title,
          metric: metric.label,
          value: metric.value,
          extra: metric.extra
        });
      }
    }
    const hasMetric = rows.some((row) => row.section !== "\u7B14\u8BB0\u4FE1\u606F" && row.value);
    return hasMetric ? rows : [];
  }
  function toPercentString(value) {
    return value == null ? "" : `${value}%`;
  }
  function appendAudienceSourceRows(rows, payload) {
    const sourceItems = payload?.audienceSource?.source ?? [];
    for (const item of sourceItems) {
      if (!item.title)
        continue;
      const extras = [];
      if (item.info?.imp_count != null)
        extras.push(`\u66DD\u5149 ${item.info.imp_count}`);
      if (item.info?.view_count != null)
        extras.push(`\u89C2\u770B ${item.info.view_count}`);
      if (item.info?.interaction_count != null)
        extras.push(`\u4E92\u52A8 ${item.info.interaction_count}`);
      rows.push({
        section: "\u89C2\u770B\u6765\u6E90",
        metric: item.title,
        value: toPercentString(item.value_with_double),
        extra: extras.join(" \xB7 ")
      });
    }
    return rows;
  }
  function appendAudiencePortraitGroup(rows, groupLabel, items) {
    for (const item of items ?? []) {
      if (!item.title)
        continue;
      rows.push({
        section: "\u89C2\u4F17\u753B\u50CF",
        metric: `${groupLabel}/${item.title}`,
        value: toPercentString(item.value),
        extra: ""
      });
    }
    return rows;
  }
  function appendAudienceRows(rows, payload) {
    appendAudienceSourceRows(rows, payload);
    appendAudiencePortraitGroup(rows, "\u6027\u522B", payload?.audienceSourceDetail?.gender);
    appendAudiencePortraitGroup(rows, "\u5E74\u9F84", payload?.audienceSourceDetail?.age);
    appendAudiencePortraitGroup(rows, "\u57CE\u5E02", payload?.audienceSourceDetail?.city);
    appendAudiencePortraitGroup(rows, "\u5174\u8DA3", payload?.audienceSourceDetail?.interest);
    return rows;
  }
  function formatTrendTimestamp(ts, granularity) {
    if (!ts)
      return "";
    const CST_OFFSET_MS = 8 * 60 * 60 * 1e3;
    const cstDate = new Date(ts + CST_OFFSET_MS);
    const pad = (value) => String(value).padStart(2, "0");
    if (granularity === "hour") {
      return `${pad(cstDate.getUTCMonth() + 1)}-${pad(cstDate.getUTCDate())} ${pad(cstDate.getUTCHours())}:00`;
    }
    return `${cstDate.getUTCFullYear()}-${pad(cstDate.getUTCMonth() + 1)}-${pad(cstDate.getUTCDate())}`;
  }
  function formatTrendSeries(points, granularity) {
    if (!points?.length)
      return "";
    return points.map((point) => {
      const label = formatTrendTimestamp(point.date, granularity);
      const value = point.count_with_double ?? point.count;
      return label && value != null ? `${label}=${value}` : "";
    }).filter(Boolean).join(" | ");
  }
  var TREND_SERIES_CONFIG = [
    { key: "imp_list", label: "\u66DD\u5149\u6570" },
    { key: "view_list", label: "\u89C2\u770B\u6570" },
    { key: "view_time_list", label: "\u5E73\u5747\u89C2\u770B\u65F6\u957F" },
    { key: "like_list", label: "\u70B9\u8D5E\u6570" },
    { key: "comment_list", label: "\u8BC4\u8BBA\u6570" },
    { key: "collect_list", label: "\u6536\u85CF\u6570" },
    { key: "share_list", label: "\u5206\u4EAB\u6570" },
    { key: "rise_fans_list", label: "\u6DA8\u7C89\u6570" }
  ];
  function appendTrendRows(rows, payload) {
    if (payload?.audienceTrend?.no_data_tip_msg) {
      rows.push({
        section: "\u8D8B\u52BF\u8BF4\u660E",
        metric: "\u89C2\u4F17\u8D8B\u52BF",
        value: payload.audienceTrend.no_data ? "\u6682\u4E0D\u53EF\u7528" : "\u53EF\u7528",
        extra: payload.audienceTrend.no_data_tip_msg
      });
    }
    const buckets = [
      { label: "\u6309\u5C0F\u65F6", granularity: "hour", data: payload?.noteBase?.hour },
      { label: "\u6309\u5929", granularity: "day", data: payload?.noteBase?.day }
    ];
    for (const bucket of buckets) {
      for (const series of TREND_SERIES_CONFIG) {
        const points = bucket.data?.[series.key];
        const formatted = formatTrendSeries(points, bucket.granularity);
        if (!formatted)
          continue;
        rows.push({
          section: "\u8D8B\u52BF\u6570\u636E",
          metric: `${bucket.label}/${series.label}`,
          value: `${points.length} points`,
          extra: formatted
        });
      }
    }
    return rows;
  }
  var DETAIL_API_ENDPOINTS = [
    { suffix: "/api/galaxy/creator/datacenter/note/base", key: "noteBase" },
    { suffix: "/api/galaxy/creator/datacenter/note/analyze/audience/trend", key: "audienceTrend" },
    { suffix: "/api/galaxy/creator/datacenter/note/audience/source/detail", key: "audienceSourceDetail" },
    { suffix: "/api/galaxy/creator/datacenter/note/audience/source", key: "audienceSource" }
  ];
  var CAPTURE_POLL_ATTEMPTS = 20;
  var CAPTURE_POLL_INTERVAL_S = 0.5;
  function detailApiEndpointForUrl(url) {
    if (!url)
      return null;
    try {
      const parsed = new URL(String(url), "https://creator.xiaohongshu.com");
      return DETAIL_API_ENDPOINTS.find((endpoint) => parsed.pathname === endpoint.suffix) ?? null;
    } catch {
      return null;
    }
  }
  function findCapturedUrl(captureMap, suffix) {
    return Object.keys(captureMap).find((url) => detailApiEndpointForUrl(url)?.suffix === suffix);
  }
  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function assertOptionalArray(payload, key, suffix) {
    if (key in payload && !Array.isArray(payload[key])) {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned malformed ${key}`);
    }
  }
  function assertOptionalPlainObject(payload, key, suffix) {
    if (key in payload && !isPlainObject(payload[key])) {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned malformed ${key}`);
    }
  }
  function validateCapturedPayload(payload, endpoint) {
    const suffix = endpoint.suffix;
    if (!isPlainObject(payload)) {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned a malformed payload`);
    }
    if (endpoint.key === "noteBase") {
      assertOptionalPlainObject(payload, "hour", suffix);
      assertOptionalPlainObject(payload, "day", suffix);
    }
    if (endpoint.key === "audienceSource") {
      assertOptionalArray(payload, "source", suffix);
    }
    if (endpoint.key === "audienceSourceDetail") {
      for (const key of ["gender", "age", "city", "interest"]) {
        assertOptionalArray(payload, key, suffix);
      }
    }
    return payload;
  }
  function parseCapturedJson(capture, endpoint) {
    const suffix = endpoint.suffix;
    if (!capture || typeof capture !== "object") {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: malformed capture for ${suffix}`);
    }
    if (capture.ok !== true) {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned HTTP ${capture.status ?? "non-2xx"}`);
    }
    if (typeof capture.body !== "string") {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned a non-text body`);
    }
    try {
      const envelope = JSON.parse(capture.body);
      const payload = isPlainObject(envelope) && Object.hasOwn(envelope, "data") ? envelope.data : envelope;
      return validateCapturedPayload(payload, endpoint);
    } catch {
      throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned invalid JSON or payload shape`);
    }
  }
  async function installXhsFetchCaptureHook(page) {
    await page.evaluate(`(() => {
    const targetPaths = ${JSON.stringify(DETAIL_API_ENDPOINTS.map((endpoint) => endpoint.suffix))};
    const shouldCapture = (url) => {
      try {
        return targetPaths.includes(new URL(String(url), window.location.origin).pathname);
      } catch (_) {
        return false;
      }
    };
    // Reset the buffer every call so stale captures from a previous run on
    // the same tab cannot leak into the current navigation's harvest.
    window.__xhsCapture = {};
    if (window.__xhsCaptureInstalled) return;
    window.__xhsCaptureInstalled = true;
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (shouldCapture(url)) {
          resp.clone().text().then((body) => {
            try { window.__xhsCapture[url] = { status: resp.status, ok: resp.ok, body }; } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return resp;
    };
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      let capturedUrl = '';
      xhr.open = function(method, url, ...rest) {
        capturedUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      xhr.addEventListener('load', () => {
        try {
          if (shouldCapture(capturedUrl)) {
            window.__xhsCapture[capturedUrl] = { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText };
          }
        } catch (_) {}
      });
      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    // Preserve readyState constants (UNSENT / OPENED / HEADERS_RECEIVED / LOADING / DONE)
    // since dashboard code may read XMLHttpRequest.DONE etc against the constructor.
    for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
      if (key in OrigXHR) HookedXHR[key] = OrigXHR[key];
    }
    window.XMLHttpRequest = HookedXHR;
  })()`);
  }
  async function captureNoteDetailPayload(page, noteId) {
    await installXhsFetchCaptureHook(page);
    await page.evaluate(`(() => {
    const target = '/statistics/note-detail?noteId=' + ${JSON.stringify(noteId)};
    history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
    const wantedSuffixes = DETAIL_API_ENDPOINTS.map((endpoint) => endpoint.suffix);
    let captureMap = {};
    for (let i = 0; i < CAPTURE_POLL_ATTEMPTS; i++) {
      await page.wait(CAPTURE_POLL_INTERVAL_S);
      let raw;
      try {
        raw = await page.evaluate("JSON.stringify(window.__xhsCapture || {})");
        captureMap = typeof raw === "string" ? JSON.parse(raw) : {};
      } catch {
        throw new CommandExecutionError("xiaohongshu creator-note-detail: failed to read signed datacenter/note capture buffer");
      }
      if (!captureMap || typeof captureMap !== "object" || Array.isArray(captureMap)) {
        throw new CommandExecutionError("xiaohongshu creator-note-detail: malformed signed datacenter/note capture buffer");
      }
      const captured = wantedSuffixes.filter((suffix) => findCapturedUrl(captureMap, suffix));
      if (captured.length === wantedSuffixes.length)
        break;
    }
    const payload = {};
    for (const endpoint of DETAIL_API_ENDPOINTS) {
      const matchUrl = findCapturedUrl(captureMap, endpoint.suffix);
      if (!matchUrl)
        continue;
      payload[endpoint.key] = parseCapturedJson(captureMap[matchUrl], endpoint);
    }
    return Object.keys(payload).length > 0 ? payload : null;
  }
  async function captureNoteDetailDomData(page) {
    const result = await page.evaluate(`() => {
    const norm = (value) => (value || '').trim();
    const sections = Array.from(document.querySelectorAll('.shell-container')).map((container) => {
      const containerText = norm(container.innerText);
      const title = containerText.startsWith('\u4E92\u52A8\u6570\u636E')
        ? '\u4E92\u52A8\u6570\u636E'
        : containerText.includes('\u57FA\u7840\u6570\u636E')
          ? '\u57FA\u7840\u6570\u636E'
          : '';
      const metrics = Array.from(container.querySelectorAll('.block-container.block')).map((block) => ({
        label: norm(block.querySelector('.des')?.innerText),
        value: norm(block.querySelector('.content')?.innerText),
        extra: norm(block.querySelector('.text-with-fans')?.innerText),
      })).filter((metric) => metric.label && metric.value);
      return { title, metrics };
    }).filter((section) => section.title && section.metrics.length > 0);

    return {
      title: norm(document.querySelector('.note-title')?.innerText),
      infoText: norm(document.querySelector('.note-info-content')?.innerText),
      sections,
    };
  }`);
    if (!result || typeof result !== "object")
      return null;
    return result;
  }
  async function fetchCreatorNoteDetailRows(page, noteId) {
    await page.goto("https://creator.xiaohongshu.com/statistics");
    const apiPayload = await captureNoteDetailPayload(page, noteId);
    const domData = await captureNoteDetailDomData(page).catch(() => null);
    let rows = parseCreatorNoteDetailDomData(domData, noteId);
    if (rows.length === 0) {
      const bodyText = await page.evaluate("() => document.body.innerText");
      rows = parseCreatorNoteDetailText(typeof bodyText === "string" ? bodyText : "", noteId);
    }
    appendTrendRows(rows, apiPayload ?? void 0);
    appendAudienceRows(rows, apiPayload ?? void 0);
    return rows;
  }
  cli({
    site: "xiaohongshu",
    name: "creator-note-detail",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u5355\u7BC7\u7B14\u8BB0\u8BE6\u60C5\u9875\u6570\u636E (\u7B14\u8BB0\u4FE1\u606F + \u6838\u5FC3/\u4E92\u52A8\u6570\u636E + \u89C2\u770B\u6765\u6E90 + \u89C2\u4F17\u753B\u50CF + \u8D8B\u52BF\u6570\u636E)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "note-id", positional: true, type: "string", required: true, help: "Note ID (from creator-notes or note-detail page URL)" }
    ],
    columns: ["section", "metric", "value", "extra"],
    func: async (page, kwargs) => {
      const noteId = kwargs["note-id"];
      const rows = await fetchCreatorNoteDetailRows(page, noteId);
      const hasCoreMetric = rows.some((row) => row.section !== "\u7B14\u8BB0\u4FE1\u606F" && row.value);
      if (!hasCoreMetric) {
        throw new EmptyResultError("xiaohongshu creator-note-detail", "No note detail data found. Check note_id and login status for creator.xiaohongshu.com.");
      }
      return rows;
    }
  });

  // webcli/scripts/opencli-xiaohongshu/creator-capture.js
  function validateCreatorCaptures(captures) {
    for (const [url, capture] of Object.entries(captures || {})) {
      if (!url.includes("/note/analyze/list")) continue;
      if (!capture?.ok) throw new CommandExecutionError("Creator analytics list HTTP " + capture?.status);
      let body;
      try {
        body = JSON.parse(capture.body);
      } catch {
        throw new CommandExecutionError("Creator analytics list returned non-JSON");
      }
      if (body?.success === false || body?.data?.result?.success === false) throw new CommandExecutionError("Creator analytics list request was rejected");
      if (!Array.isArray(body?.data?.note_infos)) throw new CommandExecutionError("Creator analytics response missing note_infos; cannot determine whether the account has notes");
    }
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/creator-notes.js
  var DATE_LINE_RE = /^发布于 (\d{4}年\d{2}月\d{2}日 \d{2}:\d{2})$/;
  var METRIC_LINE_RE = /^\d+$/;
  var VISIBILITY_LINE_RE = /可见$/;
  var NOTE_ANALYZE_API_PATH = "/api/galaxy/creator/datacenter/note/analyze/list";
  var NOTE_ANALYZE_PAGE_SIZE = 10;
  var CAPTURE_POLL_ATTEMPTS2 = 20;
  var CAPTURE_POLL_INTERVAL_S2 = 0.5;
  var NOTE_DETAIL_PAGE_URL = "https://creator.xiaohongshu.com/statistics/note-detail";
  var NOTE_ID_HTML_RE = /&quot;noteId&quot;:&quot;([0-9a-f]{24})&quot;/g;
  function buildNoteDetailUrl(noteId) {
    return noteId ? `${NOTE_DETAIL_PAGE_URL}?noteId=${encodeURIComponent(noteId)}` : "";
  }
  function formatPostTime(ts) {
    if (!ts)
      return "";
    const date = new Date(ts + 8 * 36e5);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}\u5E74${pad(date.getUTCMonth() + 1)}\u6708${pad(date.getUTCDate())}\u65E5 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }
  function parseCreatorNotesText(bodyText) {
    const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < lines.length; i++) {
      const dateMatch = lines[i].match(DATE_LINE_RE);
      if (!dateMatch)
        continue;
      let titleIndex = i - 1;
      while (titleIndex >= 0 && VISIBILITY_LINE_RE.test(lines[titleIndex]))
        titleIndex--;
      if (titleIndex < 0)
        continue;
      const title = lines[titleIndex];
      const metrics = [];
      let cursor = i + 1;
      while (cursor < lines.length && METRIC_LINE_RE.test(lines[cursor]) && metrics.length < 5) {
        metrics.push(parseInt(lines[cursor], 10));
        cursor++;
      }
      if (metrics.length < 4)
        continue;
      const key = `${title}@@${dateMatch[1]}`;
      if (seen.has(key))
        continue;
      seen.add(key);
      results.push({
        id: "",
        title,
        date: dateMatch[1],
        views: metrics[0] ?? 0,
        likes: metrics[2] ?? 0,
        collects: metrics[3] ?? 0,
        comments: metrics[1] ?? 0,
        url: ""
      });
      i = cursor - 1;
    }
    return results;
  }
  function parseCreatorNoteIdsFromHtml(bodyHtml) {
    const ids = [];
    const seen = /* @__PURE__ */ new Set();
    for (const match of bodyHtml.matchAll(NOTE_ID_HTML_RE)) {
      const id = match[1];
      if (!id || seen.has(id))
        continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }
  function mapDomCards(cards) {
    return cards.map((card) => ({
      id: card.id,
      title: card.title,
      date: card.date,
      views: card.metrics[0] ?? 0,
      likes: card.metrics[2] ?? 0,
      collects: card.metrics[3] ?? 0,
      comments: card.metrics[1] ?? 0,
      url: buildNoteDetailUrl(card.id)
    }));
  }
  function mapAnalyzeItems(items) {
    return (items ?? []).map((item) => ({
      id: item.id ?? "",
      title: item.title ?? "",
      date: formatPostTime(item.post_time),
      views: item.read_count ?? 0,
      likes: item.like_count ?? 0,
      collects: item.fav_count ?? 0,
      comments: item.comment_count ?? 0,
      url: buildNoteDetailUrl(item.id)
    }));
  }
  async function installXhsFetchCaptureHook2(page) {
    await page.evaluate(`(() => {
    window.__xhsCapture = {};
    if (window.__xhsCaptureInstalled) return;
    window.__xhsCaptureInstalled = true;
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (url.includes('/api/galaxy/')) {
          resp.clone().text().then((body) => {
            try { window.__xhsCapture[url] = { status: resp.status, ok: resp.ok, body }; } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return resp;
    };
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      let capturedUrl = '';
      xhr.open = function(method, url, ...rest) {
        capturedUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      xhr.addEventListener('load', () => {
        try {
          if (capturedUrl.includes('/api/galaxy/')) {
            window.__xhsCapture[capturedUrl] = { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText };
          }
        } catch (_) {}
      });
      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
      if (key in OrigXHR) HookedXHR[key] = OrigXHR[key];
    }
    window.XMLHttpRequest = HookedXHR;
  })()`);
  }
  function parseCaptureMapPayload(raw) {
    const payload = unwrapEvaluateResult(raw);
    if (typeof payload === "string") {
      try {
        return JSON.parse(payload);
      } catch {
        return {};
      }
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload;
    }
    return {};
  }
  function getAnalyzeListPageNumber(url) {
    try {
      const parsed = new URL(url, "https://creator.xiaohongshu.com");
      const pageNum2 = Number.parseInt(parsed.searchParams.get("page_num") || "", 10);
      if (Number.isFinite(pageNum2) && pageNum2 > 0)
        return pageNum2;
    } catch {
    }
    const match = String(url || "").match(/[?&]page_num=(\d+)/);
    const pageNum = Number.parseInt(match?.[1] || "", 10);
    return Number.isFinite(pageNum) && pageNum > 0 ? pageNum : Number.MAX_SAFE_INTEGER;
  }
  function harvestAnalyzeListCaptures(captureMap) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    let total = 0;
    const entries = Object.entries(captureMap).filter(([url]) => url.includes("/note/analyze/list")).sort(([a], [b]) => getAnalyzeListPageNumber(a) - getAnalyzeListPageNumber(b));
    for (const [url, capture] of entries) {
      if (!capture?.ok) continue;
      try {
        const json = JSON.parse(capture.body);
        const data = json?.data ?? {};
        if (typeof data.total === "number" && data.total > total) total = data.total;
        for (const note of data.note_infos ?? []) {
          if (!note?.id || seen.has(note.id)) continue;
          seen.add(note.id);
          items.push(note);
        }
      } catch {
      }
    }
    return { items, total };
  }
  function isAnalyzeCaptureComplete(items, total, limit) {
    if (total <= 0)
      return true;
    return items.length >= Math.min(total, limit);
  }
  async function pollCaptureMap(page) {
    let captureMap = {};
    for (let i = 0; i < CAPTURE_POLL_ATTEMPTS2; i++) {
      await page.wait(CAPTURE_POLL_INTERVAL_S2);
      const raw = await page.evaluate("JSON.stringify(window.__xhsCapture || {})");
      captureMap = parseCaptureMapPayload(raw);
      validateCreatorCaptures(captureMap);
      if (Object.keys(captureMap).some((url) => url.includes("/note/analyze/list"))) break;
    }
    return captureMap;
  }
  async function fetchNoteManagerTitleMap(page, neededCount) {
    const map = /* @__PURE__ */ new Map();
    const scrapeCards = async () => {
      const cards = unwrapEvaluateResult(await page.evaluate(`() => {
      const noteIdRe = /"noteId":"([0-9a-f]{24})"/;
      return Array.from(document.querySelectorAll('div.note[data-impression], div.note')).map((card) => {
        const impression = card.getAttribute('data-impression') || '';
        const id = impression.match(noteIdRe)?.[1] || '';
        const title = (card.querySelector('.title, .raw')?.innerText || '').trim();
        return { id, title };
      }).filter((entry) => entry.id && entry.title);
    }`));
      for (const card of Array.isArray(cards) ? cards : []) {
        if (!map.has(card.id)) map.set(card.id, card.title);
      }
    };
    const scrollInnerListToBottom = async () => {
      return unwrapEvaluateResult(await page.evaluate(`(() => {
      const firstCard = document.querySelector('div.note[data-impression]');
      let el = firstCard && firstCard.parentElement;
      while (el) {
        const s = window.getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
          el.scrollTop = el.scrollHeight;
          return true;
        }
        el = el.parentElement;
      }
      return false;
    })()`));
    };
    try {
      await page.goto("https://creator.xiaohongshu.com/new/note-manager");
      for (let i = 0; i < 12; i++) {
        await page.wait(1);
        await scrapeCards();
        if (map.size >= neededCount) return map;
        await scrollInnerListToBottom();
      }
      return map;
    } catch {
      return map;
    }
  }
  async function fetchCreatorNotesByCapture(page, limit) {
    await page.goto("https://creator.xiaohongshu.com/statistics");
    await installXhsFetchCaptureHook2(page);
    await page.evaluate(`(() => {
    history.pushState({}, '', '/statistics/data-analysis?source=official');
    window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
    let captureMap = await pollCaptureMap(page);
    validateCreatorCaptures(captureMap);
    let { items, total } = harvestAnalyzeListCaptures(captureMap);
    if (items.length === 0) return [];
    const totalPages = total > 0 ? Math.ceil(total / NOTE_ANALYZE_PAGE_SIZE) : 1;
    const neededPages = Math.min(totalPages, Math.ceil(limit / NOTE_ANALYZE_PAGE_SIZE));
    for (let pageNum = 2; pageNum <= neededPages && items.length < limit; pageNum++) {
      const clicked = unwrapEvaluateResult(await page.evaluate(`(() => {
      const target = String(${pageNum});
      // .d-pagination-page renders the page number doubled (a visible span +
      // an accessibility span), so textContent for page 2 reads "22". Match
      // both the raw digit and the doubled form to tolerate either render.
      const btns = Array.from(document.querySelectorAll('.d-pagination-page'));
      const match = btns.find((btn) => {
        const text = (btn.textContent || '').trim();
        return text === target || text === target + target;
      });
      if (match) { match.click(); return true; }
      return false;
    })()`));
      if (!clicked) break;
      const before = items.length;
      let advanced = false;
      for (let attempt = 0; attempt < CAPTURE_POLL_ATTEMPTS2; attempt++) {
        await page.wait(CAPTURE_POLL_INTERVAL_S2);
        const raw = await page.evaluate("JSON.stringify(window.__xhsCapture || {})");
        captureMap = parseCaptureMapPayload(raw);
        const harvested = harvestAnalyzeListCaptures(captureMap);
        if (harvested.items.length > before) {
          items = harvested.items;
          total = Math.max(total, harvested.total);
          advanced = true;
          break;
        }
      }
      if (!advanced) break;
    }
    if (!isAnalyzeCaptureComplete(items, total, limit)) {
      throw new CommandExecutionError(`xiaohongshu creator-notes: captured ${items.length} of ${Math.min(total, limit)} expected analyze rows; refusing partial results`);
    }
    const notes = mapAnalyzeItems(items).slice(0, limit);
    const missingTitles = notes.filter((note) => !note.title).length;
    if (missingTitles > 0) {
      const titleMap = await fetchNoteManagerTitleMap(page, notes.length);
      for (const note of notes) {
        if (!note.title && note.id && titleMap.has(note.id)) {
          note.title = titleMap.get(note.id);
        }
      }
    }
    return notes;
  }
  async function fetchCreatorNotesByApi(page, limit) {
    const pageSize = Math.min(Math.max(limit, 10), 20);
    const maxPages = Math.max(1, Math.ceil(limit / pageSize));
    const notes = [];
    await page.goto(`https://creator.xiaohongshu.com/statistics/data-analysis?type=0&page_size=${pageSize}&page_num=1`);
    for (let pageNum = 1; pageNum <= maxPages && notes.length < limit; pageNum++) {
      const apiPath = `${NOTE_ANALYZE_API_PATH}?type=0&page_size=${pageSize}&page_num=${pageNum}`;
      const fetched = await page.evaluate(`
      async () => {
        try {
          const resp = await fetch(${JSON.stringify(apiPath)}, { credentials: 'include' });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          return await resp.json();
        } catch (e) {
          return { error: e?.message ?? String(e) };
        }
      }
    `);
      let items = fetched?.data?.note_infos ?? [];
      if (!items.length) {
        await page.installInterceptor(NOTE_ANALYZE_API_PATH);
        await page.evaluate(`
        async () => {
          try {
            await fetch(${JSON.stringify(apiPath)}, { credentials: 'include' });
          } catch {}
          return true;
        }
      `);
        await page.wait(1);
        const intercepted = await page.getInterceptedRequests();
        const data = intercepted.find((entry) => Array.isArray(entry?.data?.note_infos));
        items = data?.data?.note_infos ?? [];
      }
      if (!items.length)
        break;
      notes.push(...mapAnalyzeItems(items));
      if (items.length < pageSize)
        break;
    }
    return notes.slice(0, limit);
  }
  async function fetchCreatorNotes(page, limit) {
    let notes = [];
    try {
      notes = await fetchCreatorNotesByCapture(page, limit);
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error;
    }
    if (notes.length === 0) {
      notes = await fetchCreatorNotesByApi(page, limit);
    }
    if (notes.length === 0) {
      await page.goto("https://creator.xiaohongshu.com/new/note-manager");
      const maxPageDowns = Math.max(0, Math.ceil(limit / 10) + 1);
      for (let i = 0; i <= maxPageDowns; i++) {
        const domCards = await page.evaluate(`() => {
        const noteIdRe = /"noteId":"([0-9a-f]{24})"/;
        return Array.from(document.querySelectorAll('div.note[data-impression], div.note')).map((card) => {
          const impression = card.getAttribute('data-impression') || '';
          const id = impression.match(noteIdRe)?.[1] || '';
          const title = (card.querySelector('.title, .raw')?.innerText || '').trim();
          const dateText = (card.querySelector('.time_status, .time')?.innerText || '').trim();
          const date = dateText.replace(/^\u53D1\u5E03\u4E8E\\s*/, '');
          const metrics = Array.from(card.querySelectorAll('.icon_list .icon'))
            .map((el) => parseInt((el.innerText || '').trim(), 10))
            .filter((value) => Number.isFinite(value));
          return { id, title, date, metrics };
        });
      }`);
        const parsedDomNotes = mapDomCards(Array.isArray(domCards) ? domCards : []).filter((note) => note.title && note.date);
        if (parsedDomNotes.length > 0) {
          notes = parsedDomNotes;
        }
        if (notes.length >= limit || notes.length > 0 && i === 0)
          break;
        const body = await page.evaluate("() => ({ text: document.body.innerText, html: document.body.innerHTML })");
        const bodyText = typeof body?.text === "string" ? body.text : "";
        const bodyHtml = typeof body?.html === "string" ? body.html : "";
        const parsedNotes = parseCreatorNotesText(bodyText);
        const noteIds = parseCreatorNoteIdsFromHtml(bodyHtml);
        notes = parsedNotes.map((note, index) => {
          const id = noteIds[index] ?? "";
          return {
            ...note,
            id,
            url: buildNoteDetailUrl(id)
          };
        });
        if (notes.length >= limit || i === maxPageDowns)
          break;
        await page.pressKey("PageDown");
        await page.wait(1);
      }
    }
    return notes.slice(0, limit);
  }
  cli({
    site: "xiaohongshu",
    name: "creator-notes",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u521B\u4F5C\u8005\u7B14\u8BB0\u5217\u8868 + \u6BCF\u7BC7\u6570\u636E (\u6807\u9898/\u65E5\u671F/\u89C2\u770B/\u70B9\u8D5E/\u6536\u85CF/\u8BC4\u8BBA)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of notes to return" }
    ],
    columns: ["rank", "id", "title", "date", "views", "likes", "collects", "comments", "url"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit || 20;
      const notes = await fetchCreatorNotes(page, limit);
      if (!Array.isArray(notes) || notes.length === 0) {
        throw new EmptyResultError("xiaohongshu creator-notes", "No notes found. Ensure you are logged into creator.xiaohongshu.com and the account has published notes.");
      }
      return notes.slice(0, limit).map((n, i) => ({
        rank: i + 1,
        id: n.id,
        title: n.title,
        date: n.date,
        views: n.views,
        likes: n.likes,
        collects: n.collects,
        comments: n.comments,
        url: n.url
      }));
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/creator-notes-summary.js
  function findDetailValue(rows, metric) {
    return rows.find((row) => row.metric === metric)?.value ?? "";
  }
  function findTopBySectionPrefix(rows, section, prefix) {
    const matches = rows.filter((row) => row.section === section && row.metric.startsWith(prefix) && row.value);
    if (matches.length === 0)
      return { label: "", value: "" };
    const sorted = [...matches].sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
    const top = sorted[0];
    return {
      label: top.metric.slice(prefix.length),
      value: top.value
    };
  }
  function summarizeCreatorNote(note, rows, rank) {
    const topSource = findTopBySectionPrefix(rows, "\u89C2\u770B\u6765\u6E90", "");
    const topInterest = findTopBySectionPrefix(rows, "\u89C2\u4F17\u753B\u50CF", "\u5174\u8DA3/");
    return {
      rank,
      id: note.id,
      title: note.title,
      published_at: findDetailValue(rows, "published_at") || note.date,
      views: findDetailValue(rows, "\u89C2\u770B\u6570") || String(note.views),
      likes: findDetailValue(rows, "\u70B9\u8D5E\u6570") || String(note.likes),
      collects: findDetailValue(rows, "\u6536\u85CF\u6570") || String(note.collects),
      comments: findDetailValue(rows, "\u8BC4\u8BBA\u6570") || String(note.comments),
      shares: findDetailValue(rows, "\u5206\u4EAB\u6570"),
      avg_view_time: findDetailValue(rows, "\u5E73\u5747\u89C2\u770B\u65F6\u957F"),
      rise_fans: findDetailValue(rows, "\u6DA8\u7C89\u6570"),
      top_source: topSource.label,
      top_source_pct: topSource.value,
      top_interest: topInterest.label,
      top_interest_pct: topInterest.value,
      url: note.url
    };
  }
  cli({
    site: "xiaohongshu",
    name: "creator-notes-summary",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u6700\u8FD1\u7B14\u8BB0\u6279\u91CF\u6458\u8981 (\u5217\u8868 + \u5355\u7BC7\u5173\u952E\u6570\u636E\u6C47\u603B)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "limit", type: "int", default: 3, help: "Number of recent notes to summarize" },
      { name: "timeout", type: "int", required: false, default: 180, help: "Max seconds for the overall command (default: 180)" }
    ],
    columns: ["rank", "id", "title", "views", "likes", "collects", "comments", "shares", "avg_view_time", "rise_fans", "top_source", "top_interest", "url"],
    func: async (page, kwargs) => {
      const limit = kwargs.limit || 3;
      const notes = await fetchCreatorNotes(page, limit);
      if (!notes.length) {
        throw new EmptyResultError("xiaohongshu creator-notes-summary", "No notes found. Ensure you are logged into creator.xiaohongshu.com and the account has published notes.");
      }
      const results = [];
      for (const [index, note] of notes.entries()) {
        if (index > 0) {
          await page.wait({ time: 1 + Math.random() * 2 });
        }
        if (!note.id) {
          results.push({
            rank: index + 1,
            id: note.id,
            title: note.title,
            published_at: note.date,
            views: String(note.views),
            likes: String(note.likes),
            collects: String(note.collects),
            comments: String(note.comments),
            shares: "",
            avg_view_time: "",
            rise_fans: "",
            top_source: "",
            top_source_pct: "",
            top_interest: "",
            top_interest_pct: "",
            url: note.url
          });
          continue;
        }
        const detailRows = await fetchCreatorNoteDetailRows(page, note.id);
        results.push(summarizeCreatorNote(note, detailRows, index + 1));
      }
      return results;
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/creator-profile.js
  cli({
    site: "xiaohongshu",
    name: "creator-profile",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u521B\u4F5C\u8005\u8D26\u53F7\u4FE1\u606F (\u7C89\u4E1D/\u5173\u6CE8/\u83B7\u8D5E/\u6210\u957F\u7B49\u7EA7)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [],
    columns: ["field", "value"],
    func: async (page, _kwargs) => {
      await page.goto("https://creator.xiaohongshu.com/new/home");
      const data = await page.evaluate(`
      async () => {
        try {
          const resp = await fetch('/api/galaxy/creator/home/personal_info', {
            credentials: 'include',
          });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }
    `);
      if (data?.error) {
        throw new Error(data.error + ". Are you logged into creator.xiaohongshu.com?");
      }
      if (!data?.data) {
        throw new Error("Unexpected response structure");
      }
      const d = data.data;
      const grow = d.grow_info || {};
      return [
        { field: "Name", value: d.name ?? "" },
        { field: "Followers", value: d.fans_count ?? 0 },
        { field: "Following", value: d.follow_count ?? 0 },
        { field: "Likes & Collects", value: d.faved_count ?? 0 },
        { field: "Creator Level", value: grow.level ?? 0 },
        { field: "Level Progress", value: `${grow.fans_count ?? 0}/${grow.max_fans_count ?? 0} fans` },
        { field: "Bio", value: (d.personal_desc ?? "").replace(/\\n/g, " | ") }
      ];
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/creator-stats.js
  cli({
    site: "xiaohongshu",
    name: "creator-stats",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u521B\u4F5C\u8005\u6570\u636E\u603B\u89C8 (\u89C2\u770B/\u70B9\u8D5E/\u6536\u85CF/\u8BC4\u8BBA/\u5206\u4EAB/\u6DA8\u7C89\uFF0C\u542B\u6BCF\u65E5\u8D8B\u52BF)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      {
        name: "period",
        type: "string",
        default: "seven",
        help: "Stats period: seven or thirty",
        choices: ["seven", "thirty"]
      }
    ],
    columns: ["metric", "total", "trend"],
    func: async (page, kwargs) => {
      const period = kwargs.period || "seven";
      await page.goto("https://creator.xiaohongshu.com/new/home");
      const data = await page.evaluate(`
      async () => {
        try {
          const resp = await fetch('/api/galaxy/creator/data/note_detail_new', {
            credentials: 'include',
          });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }
    `);
      if (data?.error) {
        throw new Error(data.error + ". Are you logged into creator.xiaohongshu.com?");
      }
      if (!data?.data) {
        throw new Error("Unexpected response structure");
      }
      const stats = data.data[period];
      if (!stats) {
        throw new EmptyResultError("xiaohongshu creator-stats", `No data for period "${period}". Available: ${Object.keys(data.data).join(", ")}`);
      }
      const formatTrend = (list) => {
        if (!list || !list.length)
          return "-";
        return list.map((d) => d.count).join(" \u2192 ");
      };
      return [
        { metric: "\u89C2\u770B\u6570 (views)", total: stats.view_count ?? 0, trend: formatTrend(stats.view_list) },
        { metric: "\u5E73\u5747\u89C2\u770B\u65F6\u957F (avg view time ms)", total: stats.view_time_avg ?? 0, trend: formatTrend(stats.view_time_list) },
        { metric: "\u4E3B\u9875\u8BBF\u95EE (home views)", total: stats.home_view_count ?? 0, trend: formatTrend(stats.home_view_list) },
        { metric: "\u70B9\u8D5E\u6570 (likes)", total: stats.like_count ?? 0, trend: formatTrend(stats.like_list) },
        { metric: "\u6536\u85CF\u6570 (collects)", total: stats.collect_count ?? 0, trend: formatTrend(stats.collect_list) },
        { metric: "\u8BC4\u8BBA\u6570 (comments)", total: stats.comment_count ?? 0, trend: formatTrend(stats.comment_list) },
        { metric: "\u5F39\u5E55\u6570 (danmaku)", total: stats.danmaku_count ?? 0, trend: "-" },
        { metric: "\u5206\u4EAB\u6570 (shares)", total: stats.share_count ?? 0, trend: formatTrend(stats.share_list) },
        { metric: "\u6DA8\u7C89\u6570 (new followers)", total: stats.rise_fans_count ?? 0, trend: formatTrend(stats.rise_fans_list) }
      ];
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/delete-note.js
  var NOTE_MANAGER_URL = "https://creator.xiaohongshu.com/new/note-manager";
  var ROW_SETTLE_MS = 3e3;
  var MODAL_SETTLE_MS = 2e3;
  var VERIFY_TIMEOUT_MS = 1e4;
  var VERIFY_POLL_MS = 1e3;
  var NOTE_ID_RE = /^[0-9a-f]{24}$/i;
  function requireEvaluateString(payload, context) {
    if (typeof payload !== "string") {
      throw new CommandExecutionError(`xiaohongshu/delete-note: malformed ${context} payload`);
    }
    return payload;
  }
  function requireEvaluateBoolean(payload, context) {
    if (typeof payload !== "boolean") {
      throw new CommandExecutionError(`xiaohongshu/delete-note: malformed ${context} payload`);
    }
    return payload;
  }
  function requireEvaluateObject(payload, context) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CommandExecutionError(`xiaohongshu/delete-note: malformed ${context} payload`);
    }
    return payload;
  }
  function requireActionResult(payload, context) {
    const result = requireEvaluateObject(payload, context);
    if (typeof result.ok !== "boolean") {
      throw new CommandExecutionError(`xiaohongshu/delete-note: malformed ${context} payload`);
    }
    return result;
  }
  function isXiaohongshuHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  }
  function isSupportedQueryNoteUrl(url) {
    return url.hostname.toLowerCase() === "creator.xiaohongshu.com" && url.pathname.replace(/\/+$/, "") === "/statistics/note-detail";
  }
  function normalizeNoteId(input) {
    const raw = String(input ?? "").trim();
    if (!raw) {
      throw new ArgumentError("xiaohongshu/delete-note: note-id cannot be empty");
    }
    if (NOTE_ID_RE.test(raw))
      return raw.toLowerCase();
    if (!/^https:\/\//i.test(raw)) {
      throw new ArgumentError("xiaohongshu/delete-note: note-id must be a 24-character Xiaohongshu note ID or an exact Xiaohongshu note URL");
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new ArgumentError("xiaohongshu/delete-note: invalid note URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !isXiaohongshuHost(url.hostname)) {
      throw new ArgumentError("xiaohongshu/delete-note: note URL must be an exact https://*.xiaohongshu.com URL");
    }
    const queryId = url.searchParams.get("noteId") || url.searchParams.get("note_id");
    if (queryId && NOTE_ID_RE.test(queryId) && isSupportedQueryNoteUrl(url))
      return queryId.toLowerCase();
    const pathMatch = url.pathname.match(/^\/(?:explore|note|search_result|discovery\/item)\/([0-9a-f]{24})\/?$/i) || url.pathname.match(/^\/user\/profile\/[^/?#]+\/([0-9a-f]{24})\/?$/i);
    if (pathMatch)
      return pathMatch[1].toLowerCase();
    throw new ArgumentError("xiaohongshu/delete-note: note URL must contain a 24-character note ID");
  }
  function buildLocateAndMaybeDeleteScript(noteId, shouldClick) {
    return `
      (cfg => {
        const { targetId, shouldClick } = cfg;
        const isVisible = (el) => !!el && el.offsetParent !== null;
        const matchesNoteId = (impressionRaw) => {
          if (!impressionRaw) return false;
          try {
            const parsed = JSON.parse(impressionRaw);
            const id = parsed && parsed.noteTarget && parsed.noteTarget.value && parsed.noteTarget.value.noteId;
            return typeof id === 'string' && id === targetId;
          } catch {
            return false;
          }
        };
        const notes = Array.from(document.querySelectorAll('.note')).filter(isVisible);
        for (const note of notes) {
          if (matchesNoteId(note.getAttribute('data-impression'))) {
            const del = note.querySelector('span.control.data-del');
            if (!del || !isVisible(del)) {
              return { ok: false, kind: 'no_delete_action', visibleRows: notes.length };
            }
            if (!shouldClick) {
              return { ok: true, clicked: false };
            }
            del.click();
            return { ok: true, clicked: true };
          }
        }
        return { ok: false, kind: 'not_found', visibleRows: notes.length };
      })(${JSON.stringify({ targetId: noteId, shouldClick })})
    `;
  }
  function buildVerifyGoneScript(noteId) {
    return `
        (targetId => {
          const matchesNoteId = (impressionRaw) => {
            if (!impressionRaw) return false;
            try {
              const parsed = JSON.parse(impressionRaw);
              const id = parsed && parsed.noteTarget && parsed.noteTarget.value && parsed.noteTarget.value.noteId;
              return typeof id === 'string' && id === targetId;
            } catch {
              return false;
            }
          };
          const notes = Array.from(document.querySelectorAll('.note'));
          return notes.some((n) => matchesNoteId(n.getAttribute('data-impression')));
        })(${JSON.stringify(noteId)})
      `;
  }
  cli({
    site: "xiaohongshu",
    name: "delete-note",
    access: "write",
    description: "\u5220\u9664\u5C0F\u7EA2\u4E66\u5DF2\u53D1\u5E03\u7B14\u8BB0 (creator center UI automation)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      {
        name: "note-id",
        required: true,
        positional: true,
        help: "Note ID (e.g. 6a08ba0b000000000702a893 from xiaohongshu creator-notes / URL)"
      },
      {
        name: "execute",
        type: "boolean",
        default: false,
        help: "Actually click delete + confirm. Default is dry-run target verification only."
      }
    ],
    columns: ["status", "note_id", "message"],
    func: async (page, kwargs) => {
      try {
        const noteId = normalizeNoteId(kwargs["note-id"]);
        const execute = kwargs.execute === true;
        await page.goto(NOTE_MANAGER_URL);
        await page.wait({ time: ROW_SETTLE_MS / 1e3 });
        const currentUrl = requireEvaluateString(unwrapEvaluateResult(await page.evaluate("() => location.href")), "current-url");
        if (typeof currentUrl === "string" && /\/login(?:[/?#]|$)/i.test(new URL(currentUrl).pathname + new URL(currentUrl).search)) {
          throw new AuthRequiredError("creator.xiaohongshu.com");
        }
        const tabClicked = requireEvaluateBoolean(unwrapEvaluateResult(await page.evaluate(`
      () => {
        const isVisible = (el) => !!el && el.offsetParent !== null;
        for (const el of document.querySelectorAll('a, button, [role="tab"], div')) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text === '\u5DF2\u53D1\u5E03' && isVisible(el)) {
            el.click();
            return true;
          }
        }
        return false;
      }
    `)), "published-tab");
        if (!tabClicked) {
          throw new CommandExecutionError("xiaohongshu/delete-note: \u5DF2\u53D1\u5E03 tab not found on note-manager; xhs creator UI may have changed.");
        }
        await page.wait({ time: ROW_SETTLE_MS / 1e3 });
        const initResult = requireActionResult(unwrapEvaluateResult(await page.evaluate(buildLocateAndMaybeDeleteScript(noteId, execute))), "locate-note");
        if (!initResult?.ok) {
          if (initResult?.kind === "not_found") {
            throw new EmptyResultError("xiaohongshu/delete-note", `Note ${noteId} not visible in the \u5DF2\u53D1\u5E03 tab. Verify the note belongs to the logged-in account and has cleared review (\u5BA1\u6838\u4E2D / \u672A\u901A\u8FC7 rows have no web delete entry).`);
          }
          if (initResult?.kind === "no_delete_action") {
            throw new CommandExecutionError(`xiaohongshu/delete-note: note ${noteId} row found but no delete action visible; xhs creator UI may have changed.`);
          }
          throw new CommandExecutionError("xiaohongshu/delete-note: failed to locate note row");
        }
        if (!execute) {
          return [{ status: "dry-run", note_id: noteId, message: "Target note row and delete action verified. Re-run with --execute to delete." }];
        }
        await page.wait({ time: MODAL_SETTLE_MS / 1e3 });
        const confirmResult = requireActionResult(unwrapEvaluateResult(await page.evaluate(`
      () => {
        const isVisible = (el) => !!el && el.offsetParent !== null;
        const footer = Array.from(document.querySelectorAll('.d-modal-footer')).find(isVisible);
        if (!footer) return { ok: false, kind: 'no_modal' };
        const buttons = Array.from(footer.querySelectorAll('button, [role="button"]')).filter(isVisible);
        const confirmBtn = buttons.find((b) => (b.innerText || b.textContent || '').trim() === '\u786E\u5B9A');
        if (!confirmBtn) return { ok: false, kind: 'no_confirm', labels: buttons.map(b => (b.innerText || '').trim()) };
        confirmBtn.click();
        return { ok: true };
      }
    `)), "confirm-modal");
        if (!confirmResult?.ok) {
          throw new CommandExecutionError(`xiaohongshu/delete-note: confirmation modal step failed (${confirmResult?.kind ?? "unknown"})`);
        }
        const VERIFY_ITERATIONS = Math.ceil(VERIFY_TIMEOUT_MS / VERIFY_POLL_MS);
        let stillPresent = true;
        for (let i = 0; i < VERIFY_ITERATIONS; i++) {
          await page.wait({ time: VERIFY_POLL_MS / 1e3 });
          const probe = requireEvaluateBoolean(unwrapEvaluateResult(await page.evaluate(buildVerifyGoneScript(noteId))), "verify-gone");
          if (probe === false) {
            stillPresent = false;
            break;
          }
        }
        if (stillPresent) {
          throw new CommandExecutionError(`xiaohongshu/delete-note: note ${noteId} still visible after confirm click; deletion may not have committed.`);
        }
        return [{ status: "deleted", note_id: noteId, message: "Delete confirmed and note row disappeared." }];
      } catch (err) {
        if (err instanceof CliError)
          throw err;
        throw new CommandExecutionError(`xiaohongshu/delete-note failed: ${err?.message ?? String(err)}`);
      }
    }
  });

  // webcli/scripts/opencli-xiaohongshu/files.js
  var files = /* @__PURE__ */ new Map();
  function resolve(p) {
    return files.get(p)?.path || p;
  }
  function extname(p) {
    return /\.[^./\\]+$/.exec(p)?.[0] || "";
  }
  function basename(p) {
    return p.split(/[\\/]/).pop();
  }
  function existsSync(p) {
    return files.has(p);
  }
  function readFileSync(p) {
    const file = files.get(p);
    if (!file) throw new ArgumentError("Image was not preloaded");
    return { toString(encoding) {
      if (encoding !== "base64") throw new ArgumentError("Expected base64");
      return file.content;
    } };
  }

  // webcli/scripts/opencli-xiaohongshu/runtime.js
  var WEB = "www.xiaohongshu.com";
  var CREATOR = "creator.xiaohongshu.com";
  var runtime = () => window.__webmcpWecliRuntime;
  var helper = (action, payload) => runtime().requestPrivileged(action, payload);
  function trustedUrl(raw, media = false) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new ArgumentError("Expected an absolute URL");
    }
    const allowed = media ? url.hostname === "xhscdn.com" || url.hostname.endsWith(".xhscdn.com") : [WEB, CREATOR, "xiaohongshu.com"].includes(url.hostname);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed) throw new ArgumentError("URL outside Xiaohongshu allowed hosts");
    return url;
  }
  var Navigation = class extends CommandExecutionError {
    constructor(url, write) {
      super("Page navigation required");
      this.result = { __webcli_navigation: {
        version: 1,
        url,
        resume: !write,
        ...write ? { result: { status: "ready_to_retry", executed: false, message: "\u76EE\u6807\u9875\u9762\u5DF2\u6253\u5F00\uFF0C\u5C1A\u672A\u6267\u884C\u4E1A\u52A1\u64CD\u4F5C\u3002\u8BF7\u7528\u76F8\u540C\u53C2\u6570\u91CD\u65B0\u8C03\u7528\uFF1B\u5199\u64CD\u4F5C\u4E0D\u81EA\u52A8\u91CD\u653E\u3002" } } : {}
      } };
    }
  };
  var Page = class {
    constructor(command9, args) {
      this.command = command9;
      this.args = args;
      this.started = Date.now();
      this.deadline = this.started + Math.min(args.timeout || 95, 95) * 1e3;
      this.firstGoto = true;
      this.pending = null;
      this.capture = false;
    }
    check() {
      if (this.pending) throw this.pending;
      if (Date.now() >= this.deadline) throw new TimeoutError(this.command.name, 95, "Do not blindly retry writes; inspect the site first.");
    }
    async evaluate(source) {
      this.check();
      const code = typeof source === "function" ? source.toString() : String(source);
      const result = await helper("main_world_eval", { expression: `(async () => { try { const candidate = (${code}); const value = typeof candidate === 'function' ? await candidate() : await candidate; return { ok: true, value }; } catch (e) { return { ok: false, message: e?.message || String(e) }; } })()` });
      this.check();
      if (!result?.value?.ok) throw new CommandExecutionError(result?.value?.message || "Page evaluation returned no result");
      return result.value.value;
    }
    async goto(raw, options = {}) {
      this.check();
      const target = trustedUrl(raw), current = new URL(location.href);
      if (current.origin === target.origin && /\/(?:login|website-login)(?:\/|$)/.test(current.pathname)) {
        if (/error_code=3000(?:17|31)/.test(current.search)) throw new CliError("SECURITY_BLOCK", "Xiaohongshu redirected to its security restriction page");
        throw new AuthRequiredError(current.hostname);
      }
      const first = this.firstGoto;
      this.firstGoto = false;
      if (options.reload) {
        if (this.command.access === "write") throw new CommandExecutionError("Writes cannot request a replay");
        const key = "__ww_xhs_detail_retry";
        let retry;
        try {
          retry = JSON.parse(sessionStorage.getItem(key));
        } catch {
        }
        if (retry?.url === target.href && retry?.command === this.command.name && Date.now() - retry.at < 105e3) throw new CliError("SECURITY_BLOCK", "Xiaohongshu remains restricted after one cooldown/reload");
        sessionStorage.setItem(key, JSON.stringify({ url: target.href, command: this.command.name, at: Date.now() }));
        this.pending = new Navigation(target.href, false);
        throw this.pending;
      }
      const noteId = (url) => url.pathname.match(/^\/(?:explore|search_result|note|discovery\/item)\/([a-f0-9]+)\/?$/i)?.[1];
      const sameNote = ["note", "comments", "download"].includes(this.command.name) && noteId(target) && noteId(current) === noteId(target);
      const equal = current.origin === target.origin && (sameNote || current.pathname === target.pathname && [...target.searchParams].every(([k, v]) => current.searchParams.get(k) === v));
      if (equal) {
        sessionStorage.removeItem("__ww_xhs_navigation");
        return;
      }
      if (!first && this.command.access !== "write" && current.hostname === CREATOR && target.hostname === CREATOR) {
        await this.evaluate(`() => { history.pushState({}, '', ${JSON.stringify(target.href)}); window.dispatchEvent(new PopStateEvent('popstate')); }`);
        await this.wait(1);
        return;
      }
      let previous;
      try {
        previous = JSON.parse(sessionStorage.getItem("__ww_xhs_navigation"));
      } catch {
      }
      if (previous?.command === this.command.name && previous?.url === target.href && Date.now() - previous.at < 105e3) {
        throw new CliError("PAGE_REDIRECT", `The site redirected the requested page to ${current.origin}${current.pathname}. Check login and the current page before retrying.`);
      }
      sessionStorage.setItem("__ww_xhs_navigation", JSON.stringify({ command: this.command.name, url: target.href, at: Date.now() }));
      if (this.capture) {
        const marker = JSON.parse(sessionStorage.getItem("__ww_xhs_capture_pattern") || "null");
        if (marker) {
          marker.target = target.href;
          sessionStorage.setItem("__ww_xhs_capture_pattern", JSON.stringify(marker));
        }
      }
      this.pending = new Navigation(target.href, this.command.access === "write");
      throw this.pending;
    }
    async wait(arg) {
      this.check();
      const seconds = typeof arg === "number" ? arg : arg?.time ?? 0;
      if (!Number.isFinite(seconds) || seconds < 0 || Date.now() + seconds * 1e3 >= this.deadline) throw new TimeoutError(this.command.name, 95);
      await new Promise((resolve2) => setTimeout(resolve2, seconds * 1e3));
      this.check();
    }
    async autoScroll({ times = 1, delayMs = 1e3 } = {}) {
      for (let i = 0; i < Math.min(times, 10); i++) {
        await this.evaluate("() => window.scrollTo(0, document.body.scrollHeight)");
        await this.wait(delayMs / 1e3);
      }
    }
    async installInterceptor(pattern) {
      this.check();
      const key = "__ww_xhs_capture_pattern";
      let marker;
      try {
        marker = JSON.parse(sessionStorage.getItem(key));
      } catch {
      }
      const call = JSON.stringify([this.command.name, this.args]);
      const resume = marker?.pattern === pattern && marker?.call === call && marker?.target === location.href && Date.now() - marker.at < 105e3;
      const old = resume ? await helper("network_capture_read", { finish: false }).catch(() => null) : null;
      if (!old) await helper("network_capture_start", { pattern });
      sessionStorage.setItem(key, JSON.stringify({ pattern, call, at: Date.now() }));
      this.capture = true;
    }
    async getInterceptedRequests() {
      this.check();
      const data = await helper("network_capture_read", { finish: false });
      if (!Array.isArray(data?.entries)) throw new CommandExecutionError("Malformed network capture");
      return data.entries.map((entry) => {
        if (entry.responseBodyTruncated) throw new CommandExecutionError("Captured response was truncated");
        if (entry.responseStatus >= 400) throw new CliError("HTTP_ERROR", `Captured API HTTP ${entry.responseStatus}`);
        try {
          return JSON.parse(entry.responsePreview);
        } catch {
          throw new CommandExecutionError("Captured API returned non-JSON");
        }
      });
    }
    async getCookies(options) {
      const r = await helper("cookies_get", options);
      return Array.isArray(r) ? r : r.cookies || [];
    }
    async setFileInput(paths, selector) {
      this.check();
      return helper("set_file_input", { selector, files: paths });
    }
    async insertText(text) {
      this.check();
      return helper("native_input", { type: "text", text });
    }
    async pressKey(key) {
      this.check();
      return helper("native_input", { type: "key", key });
    }
    // Upstream screenshots are failure diagnostics, never a required step.
    async screenshot() {
      return { saved: false, reason: "Use the connected browser to inspect the failed page." };
    }
  };
  function normalizeArgs(command9, input = {}) {
    const args = { ...input };
    for (const field of command9.args || []) {
      let value = args[field.name];
      if (value === void 0) value = field.default;
      if (field.required && (value === void 0 || value === null || String(value).trim() === "")) throw new ArgumentError(`${field.name} is required`);
      if (value === void 0) continue;
      if (["bool", "boolean"].includes(field.type)) {
        if (value === "true") value = true;
        else if (value === "false") value = false;
        if (typeof value !== "boolean") throw new ArgumentError(`${field.name} must be true or false`);
      } else if (field.type === "int") {
        if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
        if (!Number.isSafeInteger(value) || value < 1 || value > (field.name === "timeout" ? 180 : 100)) throw new ArgumentError(`${field.name} must be a positive bounded integer`);
      } else if (typeof value !== "string") throw new ArgumentError(`${field.name} must be a string`);
      if (field.choices && !field.choices.includes(value)) throw new ArgumentError(`Invalid ${field.name}`);
      args[field.name] = value;
    }
    return args;
  }
  async function preloadImages(args) {
    files.clear();
    const paths = String(args.images || "").split(",").map((p) => p.trim()).filter(Boolean);
    if (paths.length > 9) throw new ArgumentError("At most 9 images");
    let total = 0;
    for (const path of paths) {
      if (!/\.(jpe?g|png|gif|webp)$/i.test(path)) throw new ArgumentError("Unsupported image extension");
      const file = await helper("backend_file_read", { path, encoding: "base64", maxBytes: 8 * 1024 * 1024 });
      if (typeof file?.content !== "string" || file.encoding !== "base64" || !Number.isFinite(file.size)) throw new CommandExecutionError("Invalid image file response");
      total += file.size;
      if (total > 32 * 1024 * 1024) throw new ArgumentError("Images exceed 32 MiB total");
      files.set(path, file);
      files.set(file.path, file);
    }
  }
  async function resolveDownloadLink(args) {
    const raw = args["note-id"];
    if (!/^https?:\/\/xhslink\.com\//i.test(raw)) return;
    let url = new URL(raw);
    for (let i = 0; i < 4; i++) {
      if (url.username || url.password || url.port || !["http:", "https:"].includes(url.protocol) || url.hostname !== "xhslink.com") throw new ArgumentError("Invalid short link");
      const r = await helper("backend_fetch", { url: url.href, suppressBodyTrace: true, options: { method: "HEAD", redirect: "manual" } });
      const next = r?.headers?.location;
      if (r?.status < 300 || r?.status >= 400 || !next) throw new CommandExecutionError("Short link did not return a resolvable redirect");
      url = new URL(next, url);
      if (url.hostname !== "xhslink.com") {
        trustedUrl(url.href);
        args["note-id"] = url.href;
        return;
      }
    }
    throw new CommandExecutionError("Short link redirect limit exceeded");
  }
  async function notifications(page, args) {
    if (!["mentions", "likes", "connections"].includes(args.type)) throw new ArgumentError("Unknown notification type");
    await page.goto(`https://${WEB}/notification`);
    await page.installInterceptor("/you/");
    const called = await page.evaluate(`async () => {
    const app = document.querySelector('#app');
    const globals = app?.__vue_app__?.config?.globalProperties;
    const store = globals?.$pinia?._s?.get('notification');
    if (typeof store?.getNotification === 'function') { await store.getNotification(${JSON.stringify(args.type)}); return true; }
    const vuex = globals?.$store || app?.__vue__?.$store;
    if (vuex) { await vuex.dispatch('notification/getNotification', ${JSON.stringify(args.type)}); return true; }
    return false;
  }`);
    if (!called) throw new CommandExecutionError("Notification store/action not found");
    let capturedCount = 0;
    let capturedKeys = [];
    for (let i = 0; i < 8; i++) {
      const captures = await page.getInterceptedRequests();
      capturedCount = captures.length;
      capturedKeys = captures.map((x) => Object.keys(x?.data || {}));
      const result = captures.find((x) => Array.isArray(x?.data?.message_list));
      if (result) return result.data.message_list.slice(0, args.limit).map((item, index) => ({ rank: index + 1, user: item.user_info?.nickname ?? "", action: item.title ?? "", content: item.comment_info?.content ?? "", note: item.item_info?.content ?? "", time: item.time ?? null }));
      await page.wait(1);
    }
    throw new CommandExecutionError(`No notification message_list captured (${capturedCount} responses; data fields: ${JSON.stringify(capturedKeys)})`);
  }
  async function invoke(name, input) {
    const command9 = commands.get(name);
    if (!command9) throw new ArgumentError("Unknown Xiaohongshu command");
    const args = normalizeArgs(command9, input);
    if (command9.access === "write" && args.__confirmed !== true) throw new CliError("CONFIRMATION_REQUIRED", "This command requires confirmation");
    const page = new Page(command9, args);
    try {
      if (name === "download") await resolveDownloadLink(args);
      if (name === "publish") await preloadImages(args);
      const result = name === "notifications" ? await notifications(page, args) : await command9.func(page, args);
      if (page.pending) return page.pending.result;
      return result;
    } catch (error) {
      if (page.pending) return page.pending.result;
      throw error;
    } finally {
      files.clear();
      if (!page.pending) sessionStorage.removeItem("__ww_xhs_detail_retry");
      if (!page.pending && page.capture) {
        await helper("network_capture_read", { finish: true }).catch(() => {
        });
        sessionStorage.removeItem("__ww_xhs_capture_pattern");
      }
    }
  }

  // webcli/scripts/opencli-xiaohongshu/download.js
  function formatCookieHeader() {
    return "";
  }
  async function downloadMedia(media, { output, subdir, filenamePrefix }) {
    if (!/^[a-f0-9]+$/i.test(subdir) || !/^[a-f0-9]+$/i.test(filenamePrefix)) throw new ArgumentError("Missing resolved note id");
    if (typeof output !== "string" || !output.trim()) throw new ArgumentError("Output directory required");
    const rows = [];
    for (const [index, item] of media.entries()) {
      const url = trustedUrl(item.url, true);
      if (!["image", "video"].includes(item.type)) throw new CommandExecutionError("Unknown media type");
      const response = await helper("backend_fetch", { url: url.href, suppressBodyTrace: true, options: { redirect: "manual", responseEncoding: "base64", maxResponseBytes: 50 * 1024 * 1024 } });
      if (!response?.ok || response.status >= 300 || response.bodyEncoding !== "base64") throw new CommandExecutionError("Media download failed or redirected");
      const mime = String(response.headers?.["content-type"] || "").split(";")[0].toLowerCase();
      const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
      if (!extensions[mime] || !mime.startsWith(item.type + "/")) throw new CommandExecutionError("Unexpected media content type");
      const path = `${output.replace(/[\\/]$/, "")}/${subdir}/${filenamePrefix}_${String(index + 1).padStart(3, "0")}.${extensions[mime]}`;
      const saved = await helper("backend_file_write", { path, encoding: "base64", content: response.body });
      rows.push({ index: index + 1, type: item.type, status: "saved", size: response.size, path: saved.path || path });
    }
    return rows;
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/download.js
  function buildDownloadExtractJs(noteId) {
    return `
      (() => {
        const bodyText = document.body?.innerText || '';
        const result = {
          noteId: '${noteId}',
          pageUrl: location.href,
          securityBlock: /\u5B89\u5168\u9650\u5236|\u8BBF\u95EE\u94FE\u63A5\u5F02\u5E38/.test(bodyText)
            || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href),
          title: '',
          author: '',
          media: []
        };
        const seenMedia = new Set();
        const pushMedia = (type, url) => {
          if (!url) return;
          const key = type + ':' + url;
          if (seenMedia.has(key)) return;
          seenMedia.add(key);
          result.media.push({ type, url });
        };
        const locationMatch = (location.pathname || '').match(/\\/(?:explore|note|search_result|discovery\\/item)\\/([a-f0-9]+)|\\/user\\/profile\\/[^/?#]+\\/([a-f0-9]+)/i);
        if (locationMatch) {
          result.noteId = locationMatch[1] || locationMatch[2];
        }

        // Get title
        const titleEl = document.querySelector('.title, #detail-title, .note-content .title');
        result.title = titleEl?.textContent?.trim() || 'untitled';

        // Get author
        const authorEl = document.querySelector('.username, .author-name, .name');
        result.author = authorEl?.textContent?.trim() || 'unknown';

        // Get images: prefer canonical carousel order from __INITIAL_STATE__
        // so the saved order matches what the user sees on the platform (#1514).
        // DOM extraction is used only as a fallback because multiple selectors,
        // hidden / duplicated / preloaded slides, and lazy rendering can reorder
        // the discovered nodes away from the platform's display order.

        const normalizeImageUrl = (raw) => {
          if (!raw || typeof raw !== 'string') return '';
          let src = raw.split('?')[0];
          src = src.replace(/\\/imageView\\d+\\/\\d+\\/w\\/\\d+/, '');
          return src;
        };
        const orderedImageUrls = [];
        const seenImageUrls = new Set();
        const pushImage = (url) => {
          if (!url || seenImageUrls.has(url)) return;
          seenImageUrls.add(url);
          orderedImageUrls.push(url);
        };

        const getStructuredNotes = () => {
          const state = window.__INITIAL_STATE__;
          const noteData = state?.note?.noteDetailMap || state?.note?.note || {};
          if (!noteData || typeof noteData !== 'object') return [];
          const currentIds = [...new Set([result.noteId, '${noteId}'].filter(Boolean))];
          const notes = [];
          for (const id of currentIds) {
            const entry = noteData[id];
            const note = entry?.note || entry;
            if (note && typeof note === 'object') notes.push(note);
          }
          // Compatibility fallback for legacy single-note stores. Do not use this
          // when keyed detail maps contain multiple notes, or carousel order can
          // be polluted by preloaded/previous note entries.
          const keys = Object.keys(noteData);
          if (notes.length === 0 && keys.length === 1) {
            const entry = noteData[keys[0]];
            const note = entry?.note || entry;
            if (note && typeof note === 'object') notes.push(note);
          }
          return notes;
        };

        // Method 1: walk __INITIAL_STATE__.note.noteDetailMap[id].note.imageList
        // in array order. Each entry exposes urlDefault as the canonical CDN URL.
        let imageInitialStateUsed = false;
        try {
          for (const note of getStructuredNotes()) {
            const list = Array.isArray(note?.imageList) ? note.imageList : [];
            for (const item of list) {
              const candidate = item?.urlDefault || item?.urlPre || item?.url
                || item?.infoList?.find(i => i?.imageScene === 'WB_DFT')?.url
                || item?.infoList?.[0]?.url
                || '';
              const src = normalizeImageUrl(candidate);
              if (src && (src.includes('xhscdn') || src.includes('xiaohongshu') || src.includes('rednote'))) {
                pushImage(src);
                imageInitialStateUsed = true;
              }
            }
          }
        } catch(e) {}

        // Method 2: fallback to DOM scraping when the structured state is missing
        // (e.g. preview pages without full SSR hydration). Order may differ from
        // the carousel; surface it anyway rather than returning zero images.
        if (!imageInitialStateUsed) {
          const imageSelectors = [
            '.swiper-slide img',
            '.carousel-image img',
            '.note-slider img',
            '.note-image img',
            '.image-wrapper img',
            '#noteContainer .media-container img[src*="xhscdn"]',
            'img[src*="ci.xiaohongshu.com"]'
          ];
          for (const selector of imageSelectors) {
            document.querySelectorAll(selector).forEach(img => {
              const raw = img.src || img.getAttribute('data-src') || '';
              const src = normalizeImageUrl(raw);
              if (src && (src.includes('xhscdn') || src.includes('xiaohongshu') || src.includes('rednote'))) {
                pushImage(src);
              }
            });
          }
        }

        // Get video \u2014 prefer real URL from page state over blob: URLs

        // Method 1: Extract from __INITIAL_STATE__ (SSR hydration data)
        try {
          for (const note of getStructuredNotes()) {
            const video = note?.video;
            if (video) {
              const vUrl = video.url || video.originVideoKey || video.consumer?.originVideoKey;
              if (vUrl) {
                const fullUrl = vUrl.startsWith('http') ? vUrl : 'https://sns-video-bd.xhscdn.com/' + vUrl;
                pushMedia('video', fullUrl);
              }
              const streams = video.media?.stream?.h264 || [];
              for (const stream of streams) {
                if (stream.masterUrl) pushMedia('video', stream.masterUrl);
              }
            }
          }
        } catch(e) {}

        // Method 2: Extract video URLs from inline script JSON
        if (result.media.filter(m => m.type === 'video').length === 0) {
          try {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const text = s.textContent || '';
              const videoMatches = text.match(/https?:\\/\\/sns-video[^"'\\s]+\\.mp4[^"'\\s]*/g)
                || text.match(/https?:\\/\\/[^"'\\s]*xhscdn[^"'\\s]*\\.mp4[^"'\\s]*/g);
              if (videoMatches) {
                videoMatches.forEach(url => {
                  pushMedia('video', url.replace(/\\\\u002F/g, '/'));
                });
              }
            }
          } catch(e) {}
        }

        // Method 3: Fallback to DOM video elements, skip blob: URLs
        if (result.media.filter(m => m.type === 'video').length === 0) {
          const videoSelectors = [
            'video source',
            'video[src]',
            '.player video',
            '.video-player video'
          ];
          for (const selector of videoSelectors) {
            document.querySelectorAll(selector).forEach(v => {
              const src = v.src || v.getAttribute('src') || '';
              if (src && !src.startsWith('blob:')) {
                pushMedia('video', src);
              }
            });
          }
        }

        // Preserve the pre-existing media type order (videos first, then images)
        // while keeping image carousel order stable within the image batch.
        orderedImageUrls.forEach(url => pushMedia('image', url));

        return result;
      })()
    `;
  }
  var command3 = cli({
    site: "xiaohongshu",
    name: "download",
    access: "read",
    description: "\u4E0B\u8F7D\u5C0F\u7EA2\u4E66\u7B14\u8BB0\u4E2D\u7684\u56FE\u7247\u548C\u89C6\u9891",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      { name: "note-id", positional: true, required: true, help: "Full Xiaohongshu note URL with xsec_token, or xhslink short link" },
      { name: "output", default: "./xiaohongshu-downloads", help: "Output directory" }
    ],
    columns: ["index", "type", "status", "size"],
    func: async (page, kwargs) => {
      const rawInput = String(kwargs["note-id"]);
      const output = kwargs.output;
      const noteId = parseNoteId(rawInput);
      const data = await readXhsDetailPage(page, {
        url: buildNoteUrl2(rawInput, { allowShortLink: true, commandName: "xiaohongshu download" }),
        extractJs: buildDownloadExtractJs(noteId),
        securityHelp: /^https?:\/\//.test(rawInput) ? "The page may be temporarily restricted. Try again later or from a different session." : "Try using a full URL from search results (with xsec_token) instead of a bare note ID.",
        settleMinS: 1,
        settleMaxS: 3
      });
      if (!data || typeof data !== "object" || !Array.isArray(data.media)) {
        throw new CommandExecutionError("Xiaohongshu media extraction returned malformed payload.");
      }
      if (data.media.length === 0) {
        throw new EmptyResultError("xiaohongshu download", "No downloadable media found on this note.");
      }
      const cookies = formatCookieHeader(await page.getCookies({ domain: "xiaohongshu.com" }));
      const resolvedNoteId = typeof data.noteId === "string" && data.noteId.trim() ? data.noteId.trim() : noteId;
      return downloadMedia(data.media, {
        output,
        subdir: resolvedNoteId,
        cookies,
        filenamePrefix: resolvedNoteId,
        timeout: 6e4
      });
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/draft-utils.js
  var PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image";
  var DRAFT_DB_NAME = "draft-database-v1";
  var STORE_NAME_MAP = {
    image: "image-draft",
    video: "video-draft",
    article: "article-draft",
    audio: "audio-draft"
  };
  function unwrapBrowserResult2(value) {
    if (value && typeof value === "object" && typeof value.session === "string" && Object.prototype.hasOwnProperty.call(value, "data")) {
      return value.data;
    }
    return value;
  }
  function normalizeDraftType(value, { allowAll = false } = {}) {
    const raw = String(value ?? "image").trim().toLowerCase();
    if (allowAll && raw === "all") return raw;
    if (!STORE_NAME_MAP[raw]) {
      const choices = allowAll ? "image, video, article, audio, all" : Object.keys(STORE_NAME_MAP).join(", ");
      throw new ArgumentError(`Unsupported draft type "${raw}". Expected one of: ${choices}`);
    }
    return raw;
  }
  function normalizeDraftId(value) {
    const id = String(value ?? "").trim();
    if (!id) throw new ArgumentError("Draft id is required");
    return id;
  }
  function encodeDraftKey(key) {
    const type = typeof key;
    if (type === "string") return `s:${key}`;
    if (type === "number") return `n:${String(key)}`;
    if (type === "boolean") return `b:${String(key)}`;
    try {
      return `j:${encodeURIComponent(JSON.stringify(key))}`;
    } catch {
      return `s:${String(key)}`;
    }
  }
  function findDraftEntry(entries, id) {
    return entries.find((entry) => encodeDraftKey(entry?.key) === id) || null;
  }
  function normalizeDraftRecord(row, key, type, rank, { contentLimit = 80 } = {}) {
    const content = row?.content ?? {};
    const liveContext = content?.contextStore?.liveContext ?? {};
    const draftStore = content?.draftStore ?? {};
    const title = draftStore?.title || liveContext?.title || row?.title || row?.noteTitle || "";
    const editorText = content?.editorContent?.text || content?.editorContent?.plainText || "";
    const updatedAt = row?.updatedAt || row?.updateTime || row?.mtime || content?.updateTime || "";
    const imageCount = draftStore?.imgList?.length || content?.noteImageConfig?.items?.length || content?.noteImageConfig?.imageList?.length || row?.images?.length || row?.imageList?.length || 0;
    return {
      rank,
      id: encodeDraftKey(key),
      type,
      title: title || "(untitled)",
      updated_at: updatedAt ? String(updatedAt) : "",
      images: imageCount,
      text_preview: String(editorText || "").replace(/\s+/g, " ").trim().slice(0, contentLimit)
    };
  }
  async function ensureDraftDbPage(page) {
    await page.goto(PUBLISH_URL);
    await page.wait({ time: 2 });
  }
  function draftReadScript(storeName) {
    return `
    (async () => {
      const openDb = () => new Promise((resolve, reject) => {
        const req = indexedDB.open(${JSON.stringify(DRAFT_DB_NAME)});
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('failed to open IndexedDB'));
      });
      try {
        const db = await openDb();
        if (!db.objectStoreNames.contains(${JSON.stringify(storeName)})) {
          db.close();
          return { ok: true, entries: [] };
        }
        const tx = db.transaction(${JSON.stringify(storeName)}, 'readonly');
        const store = tx.objectStore(${JSON.stringify(storeName)});
        const allRows = await new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error('failed to read drafts'));
        });
        const allKeys = await new Promise((resolve, reject) => {
          if (!store.getAllKeys) return resolve([]);
          const req = store.getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error('failed to read draft keys'));
        });
        db.close();
        return {
          ok: true,
          entries: allRows.map((row, index) => ({ key: allKeys[index] ?? index, row })),
        };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
      }
    })()
  `;
  }
  async function readDraftEntries(page, draftType) {
    const storeName = STORE_NAME_MAP[draftType];
    const payload = unwrapBrowserResult2(await page.evaluate(draftReadScript(storeName)));
    if (!payload?.ok) {
      throw new CommandExecutionError(payload?.error || `Failed to read ${draftType} drafts`);
    }
    if (!Array.isArray(payload.entries)) {
      throw new CommandExecutionError(`Malformed ${draftType} draft payload`);
    }
    return payload.entries;
  }
  function draftNotFound(id, draftType, command9) {
    return new EmptyResultError(
      command9,
      `Draft ${id} was not found in ${draftType} drafts. Run opencli xiaohongshu drafts --type ${draftType} to list current ids.`
    );
  }

  // webcli/scripts/opencli-xiaohongshu/upstream/draft-clear.js
  function clearDraftsScript(storeNames, execute) {
    return `
    (async () => {
      const openDb = () => new Promise((resolve, reject) => {
        const req = indexedDB.open(${JSON.stringify(DRAFT_DB_NAME)});
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('failed to open IndexedDB'));
      });
      const countStore = (db, storeName) => new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) return resolve(0);
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error || new Error('failed to count drafts'));
        tx.onerror = () => reject(tx.error || new Error('failed to count drafts'));
      });
      const clearStore = (db, storeName) => new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(storeName)) return resolve(true);
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error || new Error('failed to clear drafts'));
        tx.onerror = () => reject(tx.error || new Error('failed to clear drafts'));
      });
      try {
        const db = await openDb();
        const storeNames = ${JSON.stringify(storeNames)};
        let before = 0;
        for (const storeName of storeNames) before += await countStore(db, storeName);
        if (${JSON.stringify(execute)}) {
          for (const storeName of storeNames) await clearStore(db, storeName);
          let after = 0;
          for (const storeName of storeNames) after += await countStore(db, storeName);
          db.close();
          return { ok: true, before, after, cleared: before - after };
        }
        db.close();
        return { ok: true, before, after: before, cleared: 0 };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
      }
    })()
  `;
  }
  cli({
    site: "xiaohongshu",
    name: "draft-clear",
    access: "write",
    description: "\u6E05\u7A7A\u5C0F\u7EA2\u4E66\u672C\u5730\u8349\u7A3F",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "type", default: "image", help: "Draft type: image, video, article, audio, all" },
      { name: "execute", type: "bool", default: false, help: "Actually clear local drafts. Default is dry-run count only." }
    ],
    columns: ["status", "type", "count", "message"],
    func: async (page, kwargs) => {
      const draftType = normalizeDraftType(kwargs.type, { allowAll: true });
      const execute = kwargs.execute === true;
      const storeNames = draftType === "all" ? Object.values(STORE_NAME_MAP) : [STORE_NAME_MAP[draftType]];
      await ensureDraftDbPage(page);
      const result = unwrapBrowserResult2(await page.evaluate(clearDraftsScript(storeNames, execute)));
      if (!result?.ok) {
        throw new CommandExecutionError(result?.error || `Failed to ${execute ? "clear" : "count"} ${draftType} drafts`);
      }
      if (execute && Number(result.after) !== 0) {
        throw new CommandExecutionError(`${result.after} ${draftType} drafts still exist after clear`);
      }
      return [{
        status: execute ? "cleared" : "dry-run",
        type: draftType,
        count: execute ? Number(result.cleared || 0) : Number(result.before || 0),
        message: execute ? "Drafts cleared." : "Drafts counted. Re-run with --execute to clear."
      }];
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/draft-delete.js
  function deleteDraftScript(storeName, key) {
    return `
    (async () => {
      const openDb = () => new Promise((resolve, reject) => {
        const req = indexedDB.open(${JSON.stringify(DRAFT_DB_NAME)});
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('failed to open IndexedDB'));
      });
      try {
        const db = await openDb();
        if (!db.objectStoreNames.contains(${JSON.stringify(storeName)})) {
          db.close();
          return { ok: false, error: 'draft store not found' };
        }
        const key = ${JSON.stringify(key)};
        await new Promise((resolve, reject) => {
          const tx = db.transaction(${JSON.stringify(storeName)}, 'readwrite');
          const store = tx.objectStore(${JSON.stringify(storeName)});
          const req = store.delete(key);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error || new Error('failed to delete draft'));
          tx.onerror = () => reject(tx.error || new Error('failed to delete draft'));
        });
        const after = await new Promise((resolve, reject) => {
          const tx = db.transaction(${JSON.stringify(storeName)}, 'readonly');
          const store = tx.objectStore(${JSON.stringify(storeName)});
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error || new Error('failed to verify draft delete'));
          tx.onerror = () => reject(tx.error || new Error('failed to verify draft delete'));
        });
        db.close();
        return { ok: true, deleted: after === null };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
      }
    })()
  `;
  }
  cli({
    site: "xiaohongshu",
    name: "draft-delete",
    access: "write",
    description: "\u5220\u9664\u4E00\u6761\u5C0F\u7EA2\u4E66\u672C\u5730\u8349\u7A3F",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "id", positional: true, required: true, help: "Draft id returned by `opencli xiaohongshu drafts`" },
      { name: "type", default: "image", help: "Draft type: image, video, article, audio" },
      { name: "execute", type: "bool", default: false, help: "Actually delete the local draft. Default is dry-run verification only." }
    ],
    columns: ["status", "id", "type", "message"],
    func: async (page, kwargs) => {
      const id = normalizeDraftId(kwargs.id);
      const draftType = normalizeDraftType(kwargs.type);
      const execute = kwargs.execute === true;
      await ensureDraftDbPage(page);
      const entries = await readDraftEntries(page, draftType);
      const entry = findDraftEntry(entries, id);
      if (!entry) throw draftNotFound(id, draftType, "xiaohongshu/draft-delete");
      const row = normalizeDraftRecord(entry.row, entry.key, draftType, 1);
      if (!execute) {
        return [{
          status: "dry-run",
          id: row.id,
          type: draftType,
          message: "Draft exists. Re-run with --execute to delete."
        }];
      }
      const storeName = STORE_NAME_MAP[draftType];
      const result = unwrapBrowserResult2(await page.evaluate(deleteDraftScript(storeName, entry.key)));
      if (!result?.ok) {
        throw new CommandExecutionError(result?.error || `Failed to delete draft ${row.id}`);
      }
      if (!result.deleted) {
        throw new CommandExecutionError(`Draft ${row.id} still exists after delete`);
      }
      return [{
        status: "deleted",
        id: row.id,
        type: draftType,
        message: "Draft deleted."
      }];
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/draft-open.js
  cli({
    site: "xiaohongshu",
    name: "draft-open",
    access: "read",
    description: "\u8BFB\u53D6\u4E00\u6761\u5C0F\u7EA2\u4E66\u672C\u5730\u8349\u7A3F\u8BE6\u60C5",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "id", positional: true, required: true, help: "Draft id returned by `opencli xiaohongshu drafts`" },
      { name: "type", default: "image", help: "Draft type: image, video, article, audio" }
    ],
    columns: ["id", "type", "title", "updated_at", "images", "content"],
    func: async (page, kwargs) => {
      const id = normalizeDraftId(kwargs.id);
      const draftType = normalizeDraftType(kwargs.type);
      await ensureDraftDbPage(page);
      const entries = await readDraftEntries(page, draftType);
      const entry = findDraftEntry(entries, id);
      if (!entry) throw draftNotFound(id, draftType, "xiaohongshu/draft-open");
      const row = normalizeDraftRecord(entry.row, entry.key, draftType, 1, { contentLimit: 500 });
      return [{
        id: row.id,
        type: row.type,
        title: row.title,
        updated_at: row.updated_at,
        images: row.images,
        content: row.text_preview
      }];
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/drafts.js
  var draftsCommand = cli({
    site: "xiaohongshu",
    name: "drafts",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u672C\u5730\u8349\u7A3F\u7BB1\u5217\u8868",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "type", default: "image", help: "Draft type: image, video, article, audio" }
    ],
    columns: ["rank", "id", "type", "title", "updated_at", "images", "text_preview"],
    func: async (page, kwargs) => {
      const draftType = normalizeDraftType(kwargs.type);
      await ensureDraftDbPage(page);
      const entries = await readDraftEntries(page, draftType);
      return entries.map((entry, index) => normalizeDraftRecord(entry?.row, entry?.key, draftType, index + 1));
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/feed.js
  function parseLimit(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--limit must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1) {
      throw new ArgumentError(`--limit must be a positive integer, got ${parsed}`);
    }
    return parsed;
  }
  var FEEDS_READ_JS = `
  (() => {
    let pinia = null;
    const probe = (el) => el?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
    pinia = probe(document.querySelector('#app'));
    if (!pinia) {
      // Some builds mount under a different root id; fall back to a full scan
      // only when the standard mount node misses.
      for (const el of document.querySelectorAll('*')) {
        pinia = probe(el);
        if (pinia) break;
      }
    }
    if (!pinia || !pinia._s) return { error: 'no_pinia' };
    const store = pinia._s.get('feed');
    if (!store) return { error: 'no_feed_store' };
    const feeds = store.feeds;
    if (!Array.isArray(feeds)) return { error: 'feeds_not_array' };
    return {
      items: feeds.map(entry => {
        const card = entry?.noteCard ?? {};
        return {
          id: entry?.id ?? '',
          title: card.displayTitle ?? '',
          type: card.type ?? '',
          // Live store exposes both user.nickname and user.nickName; prefer
          // nickname (observed populated on xhs), fall back to nickName.
          author: card.user?.nickname ?? card.user?.nickName ?? '',
          likes: card.interactInfo?.likedCount ?? '',
          // The note's signing token lives on the top-level entry. Do NOT read
          // card.user.xsecToken \u2014 that is the author profile's token, not the
          // note's.
          xsecToken: entry?.xsecToken ?? '',
        };
      }),
    };
  })()
`;
  function toCleanString3(value) {
    return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  }
  function buildFeedNoteUrl(webHost, id, xsecToken) {
    const cleanId = toCleanString3(id);
    const url = new URL(`https://${webHost}/explore/${encodeURIComponent(cleanId)}`);
    const cleanToken = toCleanString3(xsecToken);
    if (!cleanToken)
      return url.toString();
    url.searchParams.set("xsec_token", cleanToken);
    url.searchParams.set("xsec_source", "");
    return url.toString();
  }
  async function runFeed(page, kwargs, webHost) {
    const limit = parseLimit(kwargs.limit);
    await page.goto(`https://${webHost}/explore`);
    await page.wait({ time: 2 });
    const data = unwrapEvaluateResult(await page.evaluate(FEEDS_READ_JS));
    if (!data || typeof data !== "object") {
      throw new CommandExecutionError(`${webHost} feed: unexpected evaluate response`);
    }
    if (data.error) {
      throw new CommandExecutionError(`${webHost} feed: ${data.error}`, `The SPA may still be hydrating; reload ${webHost}/explore and retry.`);
    }
    if (!Array.isArray(data.items)) {
      throw new CommandExecutionError(`${webHost} feed: unexpected items payload shape`);
    }
    const rows = [];
    for (const row of data.items) {
      if (rows.length >= limit)
        break;
      if (!row || typeof row !== "object") {
        throw new CommandExecutionError(`${webHost} feed: malformed feed item`);
      }
      const id = toCleanString3(row.id);
      if (!id) {
        throw new CommandExecutionError(`${webHost} feed: feed item is missing note id`);
      }
      const xsecToken = toCleanString3(row.xsecToken);
      if (!xsecToken) {
        throw new CommandExecutionError(`${webHost} feed: feed item ${id} is missing xsecToken; cannot build a signed drill-down URL`);
      }
      rows.push({
        id,
        title: toCleanString3(row.title),
        type: toCleanString3(row.type),
        author: toCleanString3(row.author),
        likes: toCleanString3(row.likes),
        url: buildFeedNoteUrl(webHost, id, xsecToken)
      });
    }
    if (rows.length === 0) {
      throw new EmptyResultError(`${webHost}/feed`, "No feed items in the hydrated store.");
    }
    return rows;
  }
  var command4 = cli({
    site: "xiaohongshu",
    name: "feed",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u9996\u9875\u63A8\u8350 Feed (reads hydrated Pinia store)",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "limit", type: "int", default: 20, help: "Number of items to return" }
    ],
    columns: ["id", "title", "author", "likes", "type", "url"],
    func: async (page, kwargs) => runFeed(page, kwargs, "www.xiaohongshu.com")
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/follow.js
  var PROFILE_SETTLE_MS = 2500;
  var STATE_FLIP_TIMEOUT_MS = 5e3;
  var USER_ID_RE = /^[a-zA-Z0-9]{8,32}$/;
  function isXiaohongshuHost2(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  }
  function requireActionResult2(payload, context) {
    const inner = unwrapEvaluateResult(payload);
    if (!inner || typeof inner !== "object" || Array.isArray(inner) || typeof inner.ok !== "boolean") {
      throw new CommandExecutionError(`xiaohongshu/follow: malformed ${context} payload`);
    }
    return inner;
  }
  function assertUserId(raw) {
    const input = String(raw ?? "").trim();
    if (/^https?:\/\//i.test(input)) {
      let parsed;
      try {
        parsed = new URL(input);
      } catch {
        throw new ArgumentError("xiaohongshu/follow: invalid profile URL");
      }
      if (parsed.protocol !== "https:" || !isXiaohongshuHost2(parsed.hostname)) {
        throw new ArgumentError("xiaohongshu/follow: profile URL must be an exact https://*.xiaohongshu.com URL");
      }
      const match = parsed.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]{8,32})\/?$/);
      if (!match) {
        throw new ArgumentError("xiaohongshu/follow: profile URL must be /user/profile/<userId>");
      }
      return match[1];
    }
    const userId = normalizeXhsUserId(raw);
    if (!userId || !USER_ID_RE.test(userId)) {
      throw new ArgumentError(
        "xiaohongshu/follow: user-id must be a Xiaohongshu user ID (e.g. 5d8f88dc0000000001005d3a) or full profile URL"
      );
    }
    return userId;
  }
  function buildFollowScript() {
    return `
(async () => {
  const FOLLOW_LABELS = ['\u5173\u6CE8', '+ \u5173\u6CE8', '+\u5173\u6CE8'];
  const FOLLOWING_LABELS = ['\u5DF2\u5173\u6CE8', '\u5DF2\u4E92\u5173', '\u4E92\u76F8\u5173\u6CE8'];
  const STATE_FLIP_TIMEOUT_MS = ${STATE_FLIP_TIMEOUT_MS};
  const STATE_POLL_MS = 250;

  const isVisible = (el) => !!el && el.offsetParent !== null;
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  // Restrict the search to plausible profile-header containers when any are
  // present. This stops the walker from picking up the "\u5173\u6CE8" tab label
  // (rendered as a div / span in the user-detail timeline tabs) which would
  // misclick into the tab nav instead of the follow CTA. If none of the
  // containers match the page layout we fall back to a global button sweep.
  const SCOPE_SELECTORS = [
    '.user-info', '.profile-info', '.user-detail', '.profile-page',
    '[class*="user-info"]', '[class*="profile"]',
  ];
  const scopes = SCOPE_SELECTORS.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
  const visibleScopes = scopes.filter(isVisible);
  const roots = visibleScopes.length > 0 ? visibleScopes : [document];

  // Collect candidate buttons within scopes. Only real buttons and ARIA
  // buttons are considered \u2014 text nodes inside divs (tab labels) are skipped.
  const collectButtons = () => {
    const out = new Set();
    for (const root of roots) {
      const els = root.querySelectorAll('button, [role="button"]');
      for (const el of els) {
        if (isVisible(el)) out.add(el);
      }
    }
    return Array.from(out);
  };
  const findButtonByLabels = (labels) => {
    for (const btn of collectButtons()) {
      const t = textOf(btn);
      if (labels.includes(t)) return btn;
    }
    return null;
  };

  // Idempotent fast path: viewer already follows the target.
  if (findButtonByLabels(FOLLOWING_LABELS)) {
    return { ok: true, state: 'already-following' };
  }

  const followBtn = findButtonByLabels(FOLLOW_LABELS);
  if (!followBtn) {
    return {
      ok: false,
      state: 'failed',
      reason: 'Follow button not found on profile (logged out, blocked, or selectors changed). Re-run after login or update follow.js label/scope list.',
    };
  }
  followBtn.click();

  // Verify the button text flipped to \u5DF2\u5173\u6CE8 / \u5DF2\u4E92\u5173 within the timeout.
  // Polling rather than mutation-observing keeps the script resilient to
  // xhs's React re-renders that swap the underlying DOM node.
  const deadline = Date.now() + STATE_FLIP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STATE_POLL_MS));
    if (findButtonByLabels(FOLLOWING_LABELS)) {
      return { ok: true, state: 'followed' };
    }
  }
  return {
    ok: false,
    state: 'failed',
    reason: 'Follow button click did not flip to \u5DF2\u5173\u6CE8 within ' + (STATE_FLIP_TIMEOUT_MS / 1000) + 's',
  };
})()
`;
  }
  cli({
    site: "xiaohongshu",
    name: "follow",
    access: "write",
    description: "\u5173\u6CE8\u5C0F\u7EA2\u4E66\u7528\u6237 (profile UI automation)",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      {
        name: "user-id",
        required: true,
        positional: true,
        help: "User ID (e.g. 5d8f88dc0000000001005d3a) or profile URL"
      }
    ],
    columns: ["status", "user_id", "url"],
    func: async (page, kwargs) => {
      if (!page) {
        throw new CommandExecutionError("Browser session required for xiaohongshu follow");
      }
      try {
        const userId = assertUserId(kwargs["user-id"]);
        const url = `https://www.xiaohongshu.com/user/profile/${userId}`;
        await page.goto(url);
        await page.wait({ time: PROFILE_SETTLE_MS / 1e3 });
        const hrefRaw = unwrapEvaluateResult(await page.evaluate("() => location.href"));
        if (typeof hrefRaw !== "string") {
          throw new CommandExecutionError("xiaohongshu/follow: malformed current-url payload");
        }
        const parsedHref = new URL(hrefRaw);
        if (parsedHref.protocol !== "https:" || !isXiaohongshuHost2(parsedHref.hostname)) {
          throw new CommandExecutionError(
            `xiaohongshu/follow: expected Xiaohongshu profile host, got ${parsedHref.hostname}`
          );
        }
        if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
          throw new AuthRequiredError("www.xiaohongshu.com");
        }
        const currentProfile = parsedHref.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]{8,32})\/?$/);
        if (currentProfile?.[1] !== userId) {
          throw new CommandExecutionError(
            `xiaohongshu/follow: expected profile ${userId}, got ${parsedHref.pathname}`
          );
        }
        const result = requireActionResult2(
          await page.evaluate(buildFollowScript()),
          "follow-action"
        );
        if (!result.ok) {
          throw new CommandExecutionError(
            `xiaohongshu/follow failed: ${result.reason ?? "unknown reason"}`
          );
        }
        return [{ status: result.state, user_id: userId, url }];
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CommandExecutionError(
          `xiaohongshu/follow failed: ${err?.message ?? String(err)}`
        );
      }
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/liked.js
  cli({
    site: "xiaohongshu",
    name: "liked",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u8D5E\u8FC7\u7B14\u8BB0\u5217\u8868",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "id", type: "string", help: "User id or profile URL (defaults to current logged-in user)" },
      { name: "limit", type: "int", default: 20, help: "Number of notes to return" }
    ],
    columns: ["rank", "id", "title", "author", "likes", "type", "url"],
    func: async (page, kwargs) => {
      const limit = parseCollectionLimit(kwargs.limit);
      const userId = await resolveXhsUserId(page, kwargs.id);
      return fetchXhsCollectionNotes(page, {
        userId,
        profileTab: LIKED_PROFILE_TAB,
        apiPattern: LIKE_API_PATTERN,
        limit,
        emptyLabel: "liked"
      });
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/note.js
  var NOTE_EXTRACT_JS = `
      (() => {
        const bodyText = document.body?.innerText || ''
        const loginWall = /\u767B\u5F55\u540E\u67E5\u770B|\u8BF7\u767B\u5F55/.test(bodyText)
        const notFound = /\u9875\u9762\u4E0D\u89C1\u4E86|\u7B14\u8BB0\u4E0D\u5B58\u5728|\u65E0\u6CD5\u6D4F\u89C8/.test(bodyText)
        const securityBlock = /\u5B89\u5168\u9650\u5236|\u8BBF\u95EE\u94FE\u63A5\u5F02\u5E38/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()

        // Scope the note's own fields to #noteContainer \u2014 the detail panel.
        // The page also renders a recommendation feed next to the note, and
        // every card in that feed carries a .title. querySelector returns the
        // FIRST match in document order, so for a note that has no title of
        // its own (#detail-title absent) the unscoped selector fell through to
        // .title and reported an unrelated recommendation card's title as this
        // note's title. Same class of bug as the .interact-container scoping
        // below.
        const scope = document.querySelector('#noteContainer')
        const title = scope
          ? clean(scope.querySelector('#detail-title, .title'))
          : clean(document.querySelector('#detail-title'))
        const desc = scope
          ? clean(scope.querySelector('#detail-desc, .desc, .note-text'))
          : clean(document.querySelector('#detail-desc, .note-text'))
        const author = scope
          ? clean(scope.querySelector('.username, .author-wrapper .name'))
          : clean(document.querySelector('.username, .author-wrapper .name'))
        // Scope to .interact-container \u2014 the post's main interaction bar.
        // Without scoping, .like-wrapper / .chat-wrapper also match each
        // comment's like/reply buttons in the comment section, and
        // querySelector returns the FIRST match (a comment's count, not the
        // post's). The post's true counts live inside .interact-container.
        const likes = clean(document.querySelector('.interact-container .like-wrapper .count'))
        const collects = clean(document.querySelector('.interact-container .collect-wrapper .count'))
        const comments = clean(document.querySelector('.interact-container .chat-wrapper .count'))

        // Try to extract tags/topics
        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })

        return { pageUrl: location.href, securityBlock, loginWall, notFound, title, desc, author, likes, collects, comments, tags }
      })()
    `;
  var command5 = cli({
    site: "xiaohongshu",
    name: "note",
    access: "read",
    description: "\u83B7\u53D6\u5C0F\u7EA2\u4E66\u7B14\u8BB0\u6B63\u6587\u548C\u4E92\u52A8\u6570\u636E",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      { name: "note-id", required: true, positional: true, help: "Full Xiaohongshu note URL with xsec_token" }
    ],
    columns: ["field", "value"],
    func: async (page, kwargs) => {
      const raw = String(kwargs["note-id"]);
      const noteId = parseNoteId(raw);
      const url = buildNoteUrl2(raw, { commandName: "xiaohongshu note" });
      const data = await readXhsDetailPage(page, {
        url,
        extractJs: NOTE_EXTRACT_JS,
        securityHelp: /^https?:\/\//.test(raw) ? "The page may be temporarily restricted. Try again later or from a different session." : "Try using a full URL from search results (with xsec_token) instead of a bare note ID."
      });
      if (!data || typeof data !== "object") {
        throw new EmptyResultError("xiaohongshu/note", "Unexpected evaluate response");
      }
      if (data.loginWall) {
        throw new AuthRequiredError("www.xiaohongshu.com", "Note content requires login");
      }
      if (data.notFound) {
        throw new EmptyResultError("xiaohongshu/note", `Note ${noteId} not found or unavailable \u2014 it may have been deleted or restricted`);
      }
      const d = data;
      const numOrZero = (v) => /^\d+/.test(v) ? v : "0";
      if (!d.title && !d.author) {
        throw new EmptyResultError("xiaohongshu/note", "The note page loaded without visible content. The note may be deleted or restricted.");
      }
      const rows = [
        { field: "title", value: d.title || "" },
        { field: "author", value: d.author || "" },
        { field: "content", value: d.desc || "" },
        { field: "likes", value: numOrZero(d.likes || "") },
        { field: "collects", value: numOrZero(d.collects || "") },
        { field: "comments", value: numOrZero(d.comments || "") }
      ];
      if (d.tags?.length) {
        rows.push({ field: "tags", value: d.tags.join(", ") });
      }
      return rows;
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/notifications.js
  function buildNotificationsPipeline(webHost) {
    return [
      { navigate: `https://${webHost}/notification` },
      { tap: {
        store: "notification",
        action: "getNotification",
        args: [`\${{ args.type | default('mentions') }}`],
        capture: "/you/",
        select: "data.message_list",
        timeout: 8
      } },
      { map: {
        rank: "${{ index + 1 }}",
        user: "${{ item.user_info.nickname }}",
        action: "${{ item.title }}",
        content: "${{ item.comment_info.content }}",
        note: "${{ item.item_info.content }}",
        time: "${{ item.time }}"
      } },
      { limit: "${{ args.limit | default(20) }}" }
    ];
  }
  var command6 = cli({
    site: "xiaohongshu",
    name: "notifications",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u901A\u77E5 (mentions/likes/connections)",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.INTERCEPT,
    browser: true,
    args: [
      {
        name: "type",
        default: "mentions",
        help: "Notification type: mentions, likes, or connections"
      },
      { name: "limit", type: "int", default: 20, help: "Number of notifications to return" }
    ],
    columns: ["rank", "user", "action", "content", "note", "time"],
    pipeline: buildNotificationsPipeline("www.xiaohongshu.com")
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/publish.js
  var PUBLISH_URL2 = "https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image";
  var MAX_IMAGES = 9;
  var MAX_TITLE_LEN = 20;
  var UPLOAD_SETTLE_MS = 3e3;
  var CARD_TEXT_DELIM = "|||";
  var DEFAULT_CARD_STYLE = "\u57FA\u7840";
  var CARD_STYLE_GUIDE = [
    ["\u57FA\u7840", "\u9ED8\u8BA4\u515C\u5E95\uFF0C\u4E07\u80FD"],
    ["\u8FB9\u6846", "\u91D1\u53E5/\u8981\u70B9\u5361"],
    ["\u5907\u5FD8", "\u63D0\u9192/\u968F\u624B\u8BB0"],
    ["\u6E05\u65B0", "\u65E5\u5E38/\u6E05\u5355\u8D34\u58EB"],
    ["\u6D82\u5199", "\u968F\u7B14/\u788E\u788E\u5FF5"],
    ["\u4FBF\u7B7E", "\u7B14\u8BB0/\u63D0\u9192"],
    ["\u5149\u5F71", "\u60C5\u7EEA/\u6587\u827A"],
    ["\u6D82\u9E26", "\u8DA3\u5473/\u7AE5\u8BDD"],
    ["\u7B80\u7EA6", "\u5E72\u8D27/\u89C2\u70B9"],
    ["\u624B\u5199", "\u65E5\u8BB0/\u60C5\u611F"],
    ["\u63D2\u56FE", "\u751F\u6D3B\u65B9\u5F0F/\u8F7B\u677E\u8BDD\u9898"],
    ["\u7F8E\u6F2B", "\u6D3B\u529B/\u8DA3\u5473/\u6545\u4E8B\u611F"],
    ["\u5F25\u6563", "\u5F25\u6563\u5149\u6C1B\u56F4"],
    ["\u67D4\u548C", "\u67D4\u548C/\u6E29\u67D4\u91D1\u53E5"],
    ["\u5370\u5237", "\u5370\u5237\u6D77\u62A5/\u6392\u7248"],
    ["\u79D1\u6280", "\u79D1\u6280/\u4EA7\u54C1"],
    ["\u8D3A\u5361", "\u8282\u65E5\u795D\u798F"],
    ["\u672D\u8BB0", "\u827A\u672F/\u6C34\u5F69\u6C1B\u56F4"],
    ["\u4E66\u6458", "\u4E66\u6458/\u5F15\u7528"],
    ["\u624B\u5E10", "\u624B\u5E10\u62FC\u8D34"],
    ["\u51E0\u4F55", "\u9192\u76EE/\u6709\u529B\u4E3B\u5F20"]
  ];
  var CARD_STYLES = CARD_STYLE_GUIDE.map(([name]) => name);
  var TEXT_IMAGE_ENTRY_LABEL = "\u6587\u5B57\u914D\u56FE";
  var ADD_CARD_LABEL = "\u518D\u5199\u4E00\u5F20";
  var GENERATE_LABEL = "\u751F\u6210\u56FE\u7247";
  var PREVIEW_NEXT_LABEL = "\u4E0B\u4E00\u6B65";
  var CARD_EDITOR_SELECTOR = ".tiptap.ProseMirror";
  var PUBLISH_METHOD_NAMES = ["_onPublish", "onPublish", "_onSubmit", "_handlePublish"];
  var DRAFT_METHOD_NAMES = ["_onSave", "_onSaveDraft", "_onDraft"];
  var TITLE_SELECTORS = [
    // Some creator-center variants expose the title as contenteditable,
    // others use a normal <input> with the same placeholder. Visible
    // user-facing variants always carry a Chinese placeholder; class-based
    // variants also match a pair of 4 px wide hidden scaffolding inputs
    // (same `class*="title"`, empty placeholder, no v-model commit on save)
    // so placeholder-based selectors take precedence to avoid filling those.
    '[contenteditable="true"][placeholder*="\u6807\u9898"]',
    '[contenteditable="true"][placeholder*="\u8D5E"]',
    'input[placeholder*="\u6807\u9898"]',
    'input[placeholder*="title" i]',
    '[contenteditable="true"][class*="title"]',
    'input[maxlength="20"]',
    'input[class*="title"]',
    ".title-input input",
    ".note-title input",
    "input[maxlength]"
  ];
  var BODY_SELECTORS = [
    '[contenteditable="true"][class*="content"]',
    '[contenteditable="true"][class*="editor"]',
    '[contenteditable="true"][placeholder*="\u63CF\u8FF0"]',
    '[contenteditable="true"][placeholder*="\u6B63\u6587"]',
    '[contenteditable="true"][placeholder*="\u5185\u5BB9"]',
    '.note-content [contenteditable="true"]',
    '.editor-content [contenteditable="true"]',
    // Broad fallback — last resort; filter out any title contenteditable
    '[contenteditable="true"]:not([placeholder*="\u6807\u9898"]):not([placeholder*="\u8D5E"]):not([placeholder*="title" i])'
  ];
  var SUPPORTED_EXTENSIONS = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp"
  };
  function unwrapBrowserResult3(value) {
    if (value && typeof value === "object" && typeof value.session === "string" && Object.prototype.hasOwnProperty.call(value, "data")) {
      return value.data;
    }
    return value;
  }
  function validateImagePaths(filePaths) {
    return filePaths.map((filePath) => {
      const absPath = resolve(filePath);
      if (!existsSync(absPath))
        throw new ArgumentError(`Image file not found: ${absPath}`);
      const ext = extname(absPath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS[ext]) {
        throw new ArgumentError(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
      }
      return absPath;
    });
  }
  var IMAGE_INPUT_SELECTOR = 'input[type="file"][accept*="image"],input[type="file"][accept*=".jpg"],input[type="file"][accept*=".jpeg"],input[type="file"][accept*=".png"],input[type="file"][accept*=".gif"],input[type="file"][accept*=".webp"]';
  async function uploadImages(page, absPaths) {
    if (page.setFileInput) {
      try {
        const selector = await page.evaluate(`
        (() => {
          const sels = ${JSON.stringify(IMAGE_INPUT_SELECTOR)};
          const el = document.querySelector(sels);
          return el ? sels : null;
        })()
      `);
        if (!selector) {
          return { ok: false, count: 0, error: "No file input found on page" };
        }
        await page.setFileInput(absPaths, selector);
        return { ok: true, count: absPaths.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Unknown action") || msg.includes("not supported") || msg.includes("Not allowed")) {
        } else {
          return { ok: false, count: 0, error: msg };
        }
      }
    }
    const images = absPaths.map((absPath) => {
      const base64 = readFileSync(absPath).toString("base64");
      const ext = extname(absPath).toLowerCase();
      return { name: basename(absPath), mimeType: SUPPORTED_EXTENSIONS[ext], base64 };
    });
    const totalBytes = images.reduce((sum, img) => sum + img.base64.length, 0);
    if (totalBytes > 5e5) {
      console.warn(`[warn] Total image payload is ${(totalBytes / 1024 / 1024).toFixed(1)}MB (base64). This may fail with the browser bridge. Update the extension to v1.6+ for CDP-based upload, or compress images before publishing.`);
    }
    const payload = JSON.stringify(images);
    return page.evaluate(`
    (async () => {
      const images = ${payload};

      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs.find(el => {
        const accept = el.getAttribute('accept') || '';
        return (
          accept.includes('image') ||
          accept.includes('.jpg') ||
          accept.includes('.jpeg') ||
          accept.includes('.png') ||
          accept.includes('.gif') ||
          accept.includes('.webp')
        );
      });

      if (!input) return { ok: false, count: 0, error: 'No image file input found on page' };

      const dt = new DataTransfer();
      for (const img of images) {
        try {
          const binary = atob(img.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: img.mimeType });
          dt.items.add(new File([blob], img.name, { type: img.mimeType }));
        } catch (e) {
          return { ok: false, count: 0, error: 'Failed to create File: ' + e.message };
        }
      }

      Object.defineProperty(input, 'files', { value: dt.files, writable: false });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));

      return { ok: true, count: dt.files.length };
    })()
  `);
  }
  async function waitForUploads(page, maxWaitMs = 3e4) {
    const pollMs = 2e3;
    const maxAttempts = Math.ceil(maxWaitMs / pollMs);
    for (let i = 0; i < maxAttempts; i++) {
      const uploading = await page.evaluate(`
      () => !!document.querySelector(
        '[class*="upload"][class*="progress"], [class*="uploading"], [class*="loading"][class*="image"]'
      )
    `);
      if (!uploading)
        return;
      await page.wait({ time: pollMs / 1e3 });
    }
  }
  async function fillField(page, selectors, text, fieldName) {
    const located = await page.evaluate(`
    (function(selectors) {
      const __opencli_xhs_fill_phase = "locate";
      for (const sel of selectors) {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (!el || el.offsetParent === null) continue;
          const kind = el.isContentEditable
            ? 'contenteditable'
            : (el.tagName === 'TEXTAREA' ? 'textarea' : 'input');
          return { ok: true, sel, kind };
        }
      }
      return { ok: false };
    })(${JSON.stringify(selectors)})
  `);
    if (!located.ok) {
      await page.screenshot({ path: `/tmp/xhs_publish_${fieldName}_debug.png` });
      throw new Error(`Could not find ${fieldName} input. Debug screenshot: /tmp/xhs_publish_${fieldName}_debug.png`);
    }
    const applyInPage = () => page.evaluate(`
      ((selector, expectedText) => {
        const __opencli_xhs_fill_phase = "apply";
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const fireBeforeInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('beforeinput', { bubbles: true }));
          }
        };
        const fireInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        const el = Array.from(document.querySelectorAll(selector)).find(node => node && node.offsetParent !== null);
        if (!el) return { ok: false, actual: '' };
        el.focus();
        fireBeforeInput(el, expectedText);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, expectedText);
          else el.value = expectedText;
          fireInput(el, expectedText);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return { ok: el.value === expectedText, actual: el.value || '' };
        }
        el.textContent = '';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const inserted = document.execCommand('insertText', false, expectedText);
        if (!inserted) el.textContent = expectedText;
        fireInput(el, expectedText);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        const actual = normalize(el.innerText || el.textContent || '');
        return { ok: actual === normalize(expectedText), actual };
      })(${JSON.stringify(located.sel)}, ${JSON.stringify(text)})
    `);
    let result;
    if (located.kind === "contenteditable" && page.insertText) {
      const prepared = await page.evaluate(`
      ((selector, nextText) => {
        const __opencli_xhs_fill_phase = "prepare";
        const fireBeforeInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('beforeinput', { bubbles: true }));
          }
        };
        const el = Array.from(document.querySelectorAll(selector)).find(node => node && node.offsetParent !== null);
        if (!el) return { ok: false };
        el.focus();
        el.textContent = '';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        fireBeforeInput(el, nextText);
        return { ok: true };
      })(${JSON.stringify(located.sel)}, ${JSON.stringify(text)})
    `);
      if (!prepared?.ok) {
        await page.screenshot({ path: `/tmp/xhs_publish_${fieldName}_debug.png` });
        throw new Error(`Could not prepare ${fieldName} input. Debug screenshot: /tmp/xhs_publish_${fieldName}_debug.png`);
      }
      try {
        await page.insertText(text);
        result = await page.evaluate(`
      ((selector, expectedText) => {
        const __opencli_xhs_fill_phase = "verify";
        const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const fireInput = (el, value) => {
          try {
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          } catch {
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        };
        const el = Array.from(document.querySelectorAll(selector)).find(node => node && node.offsetParent !== null);
        if (!el) return { ok: false, actual: '' };
        fireInput(el, expectedText);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        const actual = normalize(el.innerText || el.textContent || '');
        return { ok: actual === normalize(expectedText), actual };
      })(${JSON.stringify(located.sel)}, ${JSON.stringify(text)})
    `);
      } catch {
        result = await applyInPage();
      }
    } else {
      result = await applyInPage();
    }
    if (!result?.ok) {
      await page.screenshot({ path: `/tmp/xhs_publish_${fieldName}_debug.png` });
      const actual = typeof result?.actual === "string" ? result.actual : "";
      throw new Error(`Failed to set ${fieldName}. Expected "${text}", got "${actual}". Debug screenshot: /tmp/xhs_publish_${fieldName}_debug.png`);
    }
  }
  async function focusBodyEnd(page, bodySelectors) {
    return unwrapBrowserResult3(await page.evaluate(`
    (selectors => {
      const el = selectors
        .map(sel => Array.from(document.querySelectorAll(sel)))
        .flat()
        .find(node => node && node.offsetParent !== null && node.isContentEditable);
      if (!el) return false;
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    })(${JSON.stringify(bodySelectors)})
  `));
  }
  function topicMarkerCountScript(topic, bodySelectors) {
    return `
    ((topicName, selectors) => {
      const __opencli_xhs_topic_marker_count = true;
      const marker = '#' + topicName + '[\u8BDD\u9898]';
      const editor = selectors
        .map(sel => Array.from(document.querySelectorAll(sel)))
        .flat()
        .find(node => node && node.offsetParent !== null && node.isContentEditable);
      if (!editor || !marker) return 0;
      const text = editor.innerText || editor.textContent || '';
      let count = 0;
      let index = text.indexOf(marker);
      while (index !== -1) {
        count += 1;
        index = text.indexOf(marker, index + marker.length);
      }
      return count;
    })(${JSON.stringify(topic)}, ${JSON.stringify(bodySelectors)})
  `;
  }
  async function addTopics(page, bodySelectors, topics) {
    const added = [];
    for (const topic of topics) {
      const focused = await focusBodyEnd(page, bodySelectors);
      if (!focused) {
        throw new CommandExecutionError(`Could not attach topic "${topic}": body editor not found`);
      }
      const beforeMarkerCount = Number(unwrapBrowserResult3(await page.evaluate(topicMarkerCountScript(topic, bodySelectors)))) || 0;
      if (typeof page.pressKey === "function") {
        try {
          await page.pressKey("Enter");
        } catch {
        }
      }
      if (typeof page.insertText !== "function") {
        throw new CommandExecutionError(`Could not attach topic "${topic}": page.insertText is unavailable`);
      }
      try {
        await page.insertText(`#${topic}`);
      } catch {
        throw new CommandExecutionError(`Could not attach topic "${topic}": failed to type inline topic query`);
      }
      await page.wait({ time: 1.2 });
      if (typeof page.pressKey !== "function") {
        throw new CommandExecutionError(`Could not attach topic "${topic}": page.pressKey is unavailable`);
      }
      try {
        await page.pressKey("Enter");
      } catch (err) {
        throw new CommandExecutionError(`Could not attach topic "${topic}": failed to accept suggestion (${err && err.message || err})`);
      }
      await page.wait({ time: 0.8 });
      const afterMarkerCount = Number(unwrapBrowserResult3(await page.evaluate(topicMarkerCountScript(topic, bodySelectors)))) || 0;
      if (afterMarkerCount <= beforeMarkerCount) {
        throw new CommandExecutionError(`Could not attach topic "${topic}": no real topic entity appeared after selection`);
      }
      added.push(topic);
      await page.wait({ time: 0.4 });
    }
    return added;
  }
  async function selectImageTextTab(page) {
    const result = await page.evaluate(`
    () => {
      const isVisible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const selector = 'button, [role="tab"], [role="button"], a, label, div, span, li';
      const nodes = Array.from(document.querySelectorAll(selector));
      const targets = ['\u4E0A\u4F20\u56FE\u6587', '\u56FE\u6587', '\u56FE\u7247'];

      for (const target of targets) {
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.innerText || node.textContent || '');
          if (!text || text.includes('\u89C6\u9891')) continue;
          if (text === target) {
            const clickable = node.closest('button, [role="tab"], [role="button"], a, label') || node;
            clickable.click();
            return { ok: true, target, text };
          }
        }
      }

      for (const target of targets) {
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const text = normalize(node.innerText || node.textContent || '');
          if (!text || text.includes('\u89C6\u9891')) continue;
          if (text.startsWith(target) || text.includes(target)) {
            const clickable = node.closest('button, [role="tab"], [role="button"], a, label') || node;
            clickable.click();
            return { ok: true, target, text };
          }
        }
      }

      const visibleTexts = [];
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (!text || text.length > 20) continue;
        visibleTexts.push(text);
        if (visibleTexts.length >= 20) break;
      }
      return { ok: false, visibleTexts };
    }
  `);
    if (result?.ok) {
      await page.wait({ time: 1 });
    }
    return result;
  }
  async function clickByText(page, label, maxWaitMs = 7e3) {
    const pollMs = 500;
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
    let result = { ok: false };
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = unwrapBrowserResult3(await page.evaluate(`
    ((cfg) => {
      const __opencli_xhs_click_label = { wantLabel: ${JSON.stringify(label)} };
      const wantLabel = ${JSON.stringify(label)};
      const isVisible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const norm = (v) => (v || '').replace(/\\s+/g, ' ').trim();
      const clickable = (el) => el.closest('button, [role="button"], a, label') || el;
      const enabled = (el) =>
        !(el.getAttribute && el.getAttribute('aria-disabled') === 'true')
        && !el.disabled
        && !(el.className && String(el.className).split(/\\s+/).includes('disabled'));
      // Exact-text matches, innermost first. The real click handler usually lives on
      // an inner control (.edit-text-button \u751F\u6210\u56FE\u7247, .add-text-item-button-text \u518D\u5199\u4E00\u5F20);
      // an outer wrapper that merely *contains* the label is a no-op, so prefer the
      // deepest matching node and let the event bubble up to the handler.
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span, a, label, li'));
      const exact = nodes.filter((n) => isVisible(n) && norm(n.innerText || n.textContent) === wantLabel);
      const innermost = exact.filter((n) => !exact.some((o) => o !== n && n.contains(o)));
      const contains = nodes.filter((n) => {
        if (!isVisible(n)) return false;
        const t = norm(n.innerText || n.textContent);
        return t && t.length <= wantLabel.length + 4 && t.includes(wantLabel);
      });
      for (const node of [...(innermost.length ? innermost : exact), ...contains]) {
        const c = clickable(node);
        if (!enabled(c)) continue;
        c.click();
        return { ok: true, text: norm(node.innerText || node.textContent) || wantLabel };
      }
      return { ok: false };
    })()
  `));
      if (result?.ok)
        return result;
      await page.wait({ time: pollMs / 1e3 });
    }
    return result;
  }
  async function focusActiveCard(page) {
    const result = await page.evaluate(`
    (() => {
      const __opencli_xhs_focus_card = true;
      const sel = ${JSON.stringify(CARD_EDITOR_SELECTOR)};
      const editors = Array.from(document.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
      // Prefer the editor inside the active swiper slide if present.
      const active = editors.find((el) => el.closest('.swiper-slide-active')) || editors[editors.length - 1];
      if (!active) return { ok: false };
      active.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(active);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return { ok: true };
    })()
  `);
    return unwrapBrowserResult3(result);
  }
  async function activeCardText(page) {
    const result = await page.evaluate(`
    (() => {
      const __opencli_xhs_card_text = true;
      const sel = ${JSON.stringify(CARD_EDITOR_SELECTOR)};
      const editors = Array.from(document.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
      const active = editors.find((el) => el.closest('.swiper-slide-active')) || editors[editors.length - 1];
      const text = active ? (active.innerText || active.textContent || '').trim() : '';
      return { ok: !!text, text };
    })()
  `);
    return unwrapBrowserResult3(result);
  }
  async function cardEditorState(page) {
    const result = await page.evaluate(`
    (() => {
      const __opencli_xhs_card_count = true;
      const sel = ${JSON.stringify(CARD_EDITOR_SELECTOR)};
      const editors = Array.from(document.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
      const active = editors.find((el) => el.closest('.swiper-slide-active')) || editors[editors.length - 1];
      const activeText = active ? (active.innerText || active.textContent || '').trim() : '';
      return { ok: true, count: editors.length, activeEmpty: !activeText };
    })()
  `);
    return unwrapBrowserResult3(result);
  }
  async function waitForFirstCard(page, maxWaitMs = 8e3) {
    const pollMs = 300;
    const maxAttempts = Math.ceil(maxWaitMs / pollMs);
    for (let i = 0; i < maxAttempts; i++) {
      const state = await cardEditorState(page);
      if (state?.count >= 1)
        return true;
      await page.wait({ time: pollMs / 1e3 });
    }
    return false;
  }
  async function waitForNewCard(page, expectedCount, maxWaitMs = 6e3) {
    const pollMs = 300;
    const maxAttempts = Math.ceil(maxWaitMs / pollMs);
    for (let i = 0; i < maxAttempts; i++) {
      const state = await cardEditorState(page);
      if (state?.count >= expectedCount && state?.activeEmpty)
        return true;
      await page.wait({ time: pollMs / 1e3 });
    }
    return false;
  }
  async function addCard(page, expectedCount, maxAttempts = 4) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const clicked = await clickByText(page, ADD_CARD_LABEL);
      if (!clicked?.ok)
        return false;
      if (await waitForNewCard(page, expectedCount, 2500))
        return true;
    }
    return false;
  }
  async function previewStepReady(page) {
    const result = await page.evaluate(`
    (() => {
      const __opencli_xhs_preview_ready = true;
      const ready = Array.from(document.querySelectorAll('button'))
        .some((b) => b.offsetParent !== null && (b.innerText || '').replace(/\\s+/g, '') === '\u4E0B\u4E00\u6B65');
      return { ok: ready };
    })()
  `);
    return unwrapBrowserResult3(result);
  }
  async function clickGenerate(page, maxAttempts = 6) {
    const pollMs = 400;
    const polls = Math.ceil(3e3 / pollMs);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const clicked = await clickByText(page, GENERATE_LABEL);
      if (!clicked?.ok && attempt === 0)
        return false;
      for (let i = 0; i < polls; i++) {
        if ((await previewStepReady(page))?.ok)
          return true;
        await page.wait({ time: pollMs / 1e3 });
      }
    }
    return false;
  }
  async function fillCard(page, text, index) {
    text = String(text).replace(/\\n/g, "\n");
    const focused = await focusActiveCard(page);
    if (!focused?.ok)
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: could not focus card editor #${index + 1}`);
    if (typeof page.insertText === "function") {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && typeof page.pressKey === "function")
          await page.pressKey("Enter");
        if (lines[i])
          await page.insertText(lines[i]);
      }
    } else {
      await page.evaluate(`(t => document.execCommand('insertText', false, t))(${JSON.stringify(text)})`);
    }
    await page.wait({ time: 0.4 });
    const state = await activeCardText(page);
    if (!state?.ok)
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: card editor #${index + 1} is empty after typing`);
  }
  async function selectCardStyle(page, styleName) {
    if (!styleName || styleName === DEFAULT_CARD_STYLE)
      return DEFAULT_CARD_STYLE;
    const available = unwrapBrowserResult3(await page.evaluate(`
    (async () => {
      const __opencli_xhs_card_styles = true;
      const want = ${JSON.stringify(styleName)};
      const norm = (el) => ((el && (el.innerText || el.textContent)) || '').trim();
      const names = () => Array.from(document.querySelectorAll('.cover-list-container .cover-name'));
      const seen = [];
      const readAll = () => { for (const el of names()) { const t = norm(el); if (t && !seen.includes(t)) seen.push(t); } };
      const target = () => names().find((el) => norm(el) === want);
      const reveal = (el) => { el.scrollIntoView({ block: 'center' }); };
      readAll();
      let hit = target();
      if (hit) { reveal(hit); return { ok: true, styles: seen, found: true }; }
      const scroller = document.querySelector('.cover-list-container-wrapper')
        || document.querySelector('.cover-list-container');
      if (scroller) {
        const ch = scroller.clientHeight || 200;
        const sh = scroller.scrollHeight;
        for (let y = 0; y <= sh + ch; y += Math.max(60, Math.floor(ch / 2))) {
          scroller.scrollTop = y;
          await new Promise((r) => setTimeout(r, 180));
          readAll();
          hit = target();
          if (hit) { reveal(hit); await new Promise((r) => setTimeout(r, 150)); return { ok: true, styles: seen, found: true }; }
        }
        scroller.scrollTop = 0;
      }
      return { ok: seen.length > 0, styles: seen, found: false };
    })()
  `));
    if (!available?.found) {
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: requested style "${styleName}" is not available for this content (options: ${(available?.styles || []).join(" / ") || "none"}). Choose an available style or omit --card-style to use ${DEFAULT_CARD_STYLE}.`);
    }
    const clicked = await clickByText(page, styleName);
    if (!clicked?.ok) {
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: could not click requested style "${styleName}".`);
    }
    await page.wait({ time: 0.6 });
    return styleName;
  }
  async function currentComposerMediaCount(page) {
    const result = await page.evaluate(`
    (() => {
      const __opencli_xhs_composer_media_count = true;
      const visibleBox = (el) => {
        if (!el || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const visibleMedia = (el) => {
        if (!visibleBox(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 48 && r.height >= 48;
      };
      const titleSelectors = ${JSON.stringify(TITLE_SELECTORS)};
      const titleEl = titleSelectors
        .map((sel) => Array.from(document.querySelectorAll(sel)))
        .flat()
        .find((el) => visibleBox(el));
      const imageInputSelector = ${JSON.stringify(IMAGE_INPUT_SELECTOR)};
      const imageInput = Array.from(document.querySelectorAll(imageInputSelector))
        .find((el) => visibleBox(el) || el.type === 'file');
      const rootSelectors = [
        '[class*="publish"]',
        '[class*="editor"]',
        'form',
        '[class*="note"]',
      ];
      const roots = [];
      const addRoot = (root) => {
        if (root && !roots.includes(root)) roots.push(root);
      };
      const addAnchoredRoot = (anchor) => {
        if (!anchor) return;
        for (const sel of rootSelectors) {
          const root = anchor.closest(sel);
          if (root) { addRoot(root); return; }
        }
      };
      // The generated-card media and title can live in sibling subtrees, so
      // anchor from both the image input and title, but keep the scan inside
      // publish/editor/form roots rather than all of main.
      addAnchoredRoot(imageInput);
      addAnchoredRoot(titleEl);
      const seen = new Set();
      let count = 0;
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('img, video, canvas, [style*="background-image"]'))) {
          if (!visibleMedia(el)) continue;
          const rect = el.getBoundingClientRect();
          const src = el.currentSrc || el.src || el.getAttribute('src') || el.style?.backgroundImage || '';
          const key = src || String(Math.round(rect.left)) + ':' + String(Math.round(rect.top));
          if (seen.has(key)) continue;
          seen.add(key);
          count += 1;
        }
      }
      return { ok: true, count };
    })()
  `);
    return unwrapBrowserResult3(result);
  }
  async function assertComposerMediaCount(page, expectedCount, label) {
    const state = await currentComposerMediaCount(page);
    if (!state || typeof state.count !== "number") {
      throw new CommandExecutionError(`${label}: could not verify current composer media count`);
    }
    if (state.count < expectedCount) {
      await page.screenshot({ path: "/tmp/xhs_publish_media_debug.png" });
      throw new CommandExecutionError(`${label}: expected at least ${expectedCount} visible media item(s), got ${state.count}. Debug screenshot: /tmp/xhs_publish_media_debug.png`);
    }
  }
  async function runTextImageFlow(page, cards, cardStyle) {
    const entry = await clickByText(page, TEXT_IMAGE_ENTRY_LABEL);
    if (!entry?.ok) {
      await page.screenshot({ path: "/tmp/xhs_publish_textimage_debug.png" });
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: could not click "${TEXT_IMAGE_ENTRY_LABEL}" entry. Debug: /tmp/xhs_publish_textimage_debug.png`);
    }
    if (!await waitForFirstCard(page)) {
      await page.screenshot({ path: "/tmp/xhs_publish_textimage_debug.png" });
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: \u5199\u6587\u5B57 card editor did not appear after clicking "${TEXT_IMAGE_ENTRY_LABEL}". Debug: /tmp/xhs_publish_textimage_debug.png`);
    }
    for (let i = 0; i < cards.length; i++) {
      if (i > 0) {
        const added = await addCard(page, i + 1);
        if (!added) {
          await page.screenshot({ path: "/tmp/xhs_publish_addcard_debug.png" });
          throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: new card editor #${i + 1} did not render after "${ADD_CARD_LABEL}". Debug: /tmp/xhs_publish_addcard_debug.png`);
        }
      }
      await fillCard(page, cards[i], i);
    }
    const generated = await clickGenerate(page);
    if (!generated) {
      await page.screenshot({ path: "/tmp/xhs_publish_generate_debug.png" });
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: "${GENERATE_LABEL}" did not advance to the \u9884\u89C8\u56FE\u7247 step. Debug: /tmp/xhs_publish_generate_debug.png`);
    }
    const appliedStyle = await selectCardStyle(page, cardStyle);
    const next = await clickByText(page, PREVIEW_NEXT_LABEL);
    if (!next?.ok) {
      await page.screenshot({ path: "/tmp/xhs_publish_next_debug.png" });
      throw new CommandExecutionError(`\u6587\u5B57\u914D\u56FE: could not click "${PREVIEW_NEXT_LABEL}". Debug: /tmp/xhs_publish_next_debug.png`);
    }
    await page.wait({ time: 2 });
    return appliedStyle;
  }
  async function inspectPublishSurfaceState(page) {
    return page.evaluate(`
    () => {
      const text = (document.body?.innerText || '').replace(/s+/g, ' ').trim();
      const hasTitleInput = !!Array.from(document.querySelectorAll('input, textarea')).find((el) => {
        if (!el || el.offsetParent === null) return false;
        const placeholder = (el.getAttribute('placeholder') || '').trim();
        const cls = el.className ? String(el.className) : '';
        const maxLength = Number(el.getAttribute('maxlength') || 0);
        return (
          placeholder.includes('\u6807\u9898') ||
          /title/i.test(placeholder) ||
          /title/i.test(cls) ||
          maxLength === 20
        );
      });
      const hasImageInput = !!Array.from(document.querySelectorAll('input[type="file"]')).find((el) => {
        const accept = el.getAttribute('accept') || '';
        return (
          accept.includes('image') ||
          accept.includes('.jpg') ||
          accept.includes('.jpeg') ||
          accept.includes('.png') ||
          accept.includes('.gif') ||
          accept.includes('.webp')
        );
      });
      const hasVideoSurface = text.includes('\u62D6\u62FD\u89C6\u9891\u5230\u6B64\u5904\u70B9\u51FB\u4E0A\u4F20') || text.includes('\u4E0A\u4F20\u89C6\u9891');
      const state = hasTitleInput ? 'editor_ready' : hasImageInput || !hasVideoSurface ? 'image_surface' : 'video_surface';
      return { state, hasTitleInput, hasImageInput, hasVideoSurface };
    }
  `);
  }
  async function waitForPublishSurfaceState(page, maxWaitMs = 5e3) {
    const pollMs = 500;
    const maxAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
    let surface = await inspectPublishSurfaceState(page);
    for (let i = 0; i < maxAttempts; i++) {
      if (surface.state !== "video_surface") {
        return surface;
      }
      if (i < maxAttempts - 1) {
        await page.wait({ time: pollMs / 1e3 });
        surface = await inspectPublishSurfaceState(page);
      }
    }
    return surface;
  }
  async function waitForEditForm(page, maxWaitMs = 1e4) {
    const pollMs = 1e3;
    const maxAttempts = Math.ceil(maxWaitMs / pollMs);
    for (let i = 0; i < maxAttempts; i++) {
      const found = await page.evaluate(`
      (() => {
        const sels = ${JSON.stringify(TITLE_SELECTORS)};
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return true;
        }
        return false;
      })()`);
      if (found)
        return true;
      if (i < maxAttempts - 1)
        await page.wait({ time: pollMs / 1e3 });
    }
    return false;
  }
  cli({
    site: "xiaohongshu",
    name: "publish",
    access: "write",
    description: "\u5C0F\u7EA2\u4E66\u53D1\u5E03\u56FE\u6587\u7B14\u8BB0 (creator center UI automation)",
    domain: "creator.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "content", required: true, positional: true, help: "\u7B14\u8BB0\u6B63\u6587" },
      { name: "title", required: true, help: "\u7B14\u8BB0\u6807\u9898 (\u6700\u591A20\u5B57)" },
      { name: "images", required: false, help: "\u56FE\u7247\u8DEF\u5F84\uFF0C\u9017\u53F7\u5206\u9694\uFF0C\u6700\u591A9\u5F20 (jpg/png/gif/webp)" },
      { name: "card-text", required: false, help: `\u6587\u5B57\u914D\u56FE\u5361\u7247\u6587\u5B57\uFF0C\u591A\u5F20\u5361\u7247\u7528 ${CARD_TEXT_DELIM} \u5206\u9694\uFF0C\u5361\u5185\u6362\u884C\u7528 \\n` },
      { name: "card-style", required: false, help: `\u6587\u5B57\u914D\u56FE\u5361\u7247\u6837\u5F0F\uFF0C\u8FD0\u884C\u65F6\u6309\u9875\u9762\u5B9E\u9645\u9009\u9879\u5339\u914D\uFF1B\u627E\u4E0D\u5230\u4F1A\u5931\u8D25\u3002\u7701\u7565\u65F6\u4F7F\u7528${DEFAULT_CARD_STYLE}\u3002\u53EF\u9009: ${CARD_STYLE_GUIDE.map(([n, s]) => `${n}(${s})`).join(" ")}` },
      { name: "topics", required: false, help: "\u8BDD\u9898\u6807\u7B7E\uFF0C\u9017\u53F7\u5206\u9694\uFF0C\u4E0D\u542B # \u53F7" },
      { name: "draft", type: "bool", default: false, help: "\u4FDD\u5B58\u4E3A\u8349\u7A3F\uFF0C\u4E0D\u76F4\u63A5\u53D1\u5E03" }
    ],
    columns: ["status", "detail"],
    func: async (page, kwargs) => {
      if (!page)
        throw new Error("Browser page required");
      const title = String(kwargs.title ?? "").trim();
      const content = String(kwargs.content ?? "").trim();
      const imagePaths = kwargs.images ? String(kwargs.images).split(",").map((s) => s.trim()).filter(Boolean) : [];
      const topics = kwargs.topics ? String(kwargs.topics).split(",").map((s) => s.trim()).filter(Boolean) : [];
      const isDraft = Boolean(kwargs.draft);
      const cardText = kwargs["card-text"] ? String(kwargs["card-text"]) : "";
      const cards = cardText ? cardText.split(CARD_TEXT_DELIM).map((s) => s.trim()).filter(Boolean) : [];
      const cardStyle = kwargs["card-style"] ? String(kwargs["card-style"]).trim() : "";
      const isTextImage = cards.length > 0;
      if (!title)
        throw new ArgumentError("--title is required");
      if (title.length > MAX_TITLE_LEN)
        throw new ArgumentError(`Title is ${title.length} chars \u2014 must be \u2264 ${MAX_TITLE_LEN}`);
      if (!content)
        throw new ArgumentError("Positional argument <content> is required");
      if (!isTextImage && imagePaths.length === 0)
        throw new ArgumentError("Provide --card-text (text-image mode) or --images (upload mode); neither was given.");
      if (imagePaths.length > MAX_IMAGES)
        throw new ArgumentError(`Too many images: ${imagePaths.length} (max ${MAX_IMAGES})`);
      if (isTextImage && imagePaths.some((p) => extname(p).toLowerCase() === ".gif"))
        throw new ArgumentError("\u6587\u5B57\u914D\u56FE\u6A21\u5F0F\u8FFD\u52A0\u7684\u56FE\u7247\u4E0D\u652F\u6301 .gif\uFF08\u7F16\u8F91\u5668\u56FE\u7247\u5165\u53E3\u53EA\u63A5\u53D7 jpg/jpeg/png/webp\uFF09");
      const absImagePaths = validateImagePaths(imagePaths);
      await page.goto(PUBLISH_URL2);
      await page.wait({ time: 3 });
      const pageUrl = await page.evaluate("() => location.href");
      if (!pageUrl.includes("creator.xiaohongshu.com")) {
        throw new Error("Redirected away from creator center \u2014 session may have expired. Re-capture browser login via: opencli xiaohongshu creator-profile");
      }
      const tabResult = await selectImageTextTab(page);
      const surface = await waitForPublishSurfaceState(page, tabResult?.ok ? 5e3 : 2e3);
      if (surface.state === "video_surface") {
        await page.screenshot({ path: "/tmp/xhs_publish_tab_debug.png" });
        const detail = tabResult?.ok ? `clicked "${tabResult.text}"` : `visible candidates: ${(tabResult?.visibleTexts || []).join(" | ") || "none"}`;
        throw new Error(`Still on the video publish page after trying to select \u56FE\u6587. Details: ${detail}. Inspect the connected browser page`);
      }
      let appliedCardStyle = cardStyle;
      if (isTextImage) {
        appliedCardStyle = await runTextImageFlow(page, cards, cardStyle);
      } else {
        const upload = await uploadImages(page, absImagePaths);
        if (!upload.ok) {
          await page.screenshot({ path: "/tmp/xhs_publish_upload_debug.png" });
          throw new CommandExecutionError(`Image injection failed: ${upload.error ?? "unknown"}. Inspect the connected browser page`);
        }
        await page.wait({ time: UPLOAD_SETTLE_MS / 1e3 });
        await waitForUploads(page);
      }
      const formReady = await waitForEditForm(page);
      if (!formReady) {
        await page.screenshot({ path: "/tmp/xhs_publish_form_debug.png" });
        throw new CommandExecutionError("Editing form did not appear after image acquisition. The page layout may have changed. Inspect the connected browser page");
      }
      if (isTextImage) {
        await assertComposerMediaCount(page, cards.length, "\u6587\u5B57\u914D\u56FE generated images");
      }
      if (isTextImage && absImagePaths.length > 0) {
        const upload = await uploadImages(page, absImagePaths);
        if (!upload.ok) {
          await page.screenshot({ path: "/tmp/xhs_publish_append_debug.png" });
          throw new CommandExecutionError(`Appending images failed: ${upload.error ?? "unknown"}. Debug screenshot: /tmp/xhs_publish_append_debug.png`);
        }
        await page.wait({ time: UPLOAD_SETTLE_MS / 1e3 });
        await waitForUploads(page);
        await assertComposerMediaCount(page, cards.length + absImagePaths.length, "\u6587\u5B57\u914D\u56FE appended images");
      }
      await fillField(page, TITLE_SELECTORS, title, "title");
      await page.wait({ time: 0.5 });
      await fillField(page, BODY_SELECTORS, content, "content");
      await page.wait({ time: 0.5 });
      let addedTopics = [];
      if (topics.length) {
        addedTopics = await addTopics(page, BODY_SELECTORS, topics);
      }
      const actionLabels = isDraft ? ["\u6682\u5B58\u79BB\u5F00", "\u5B58\u8349\u7A3F"] : ["\u53D1\u5E03", "\u53D1\u5E03\u7B14\u8BB0"];
      const invokeResult = await page.evaluate(`
      (cfg => {
        const { isDraftMode, publishNames, draftNames, labels } = cfg;
        const isVisible = (el) => {
          if (!el || el.offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        // Path 1: web component method invoke on <xhs-publish-btn>.
        const hosts = Array.from(document.querySelectorAll('xhs-publish-btn')).filter(isVisible);
        const wanted = isDraftMode ? draftNames : publishNames;
        // Try every host + every candidate; do NOT bail on the first throw
        // (multiple hosts can exist, and a later name may succeed).
        let lastMethodError = null;
        for (const host of hosts) {
          for (const name of wanted) {
            if (typeof host[name] !== 'function') continue;
            try {
              host[name]();
              return { ok: true, via: 'method', name };
            } catch (err) {
              lastMethodError = String(err && err.message || err);
            }
          }
        }
        // Path 2: legacy <button>/[role=button] text-match click fallback.
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim();
          if (
            labels.some(l => text === l || text.includes(l)) &&
            isVisible(btn) &&
            !btn.disabled
          ) {
            btn.click();
            return { ok: true, via: 'click', text };
          }
        }
        return { ok: false, via: 'none', hosts: hosts.length, lastMethodError };
      })(${JSON.stringify({
        isDraftMode: isDraft,
        publishNames: PUBLISH_METHOD_NAMES,
        draftNames: DRAFT_METHOD_NAMES,
        labels: actionLabels
      })})
    `);
      if (!invokeResult?.ok) {
        if (isDraft) {
          const leaveTriggered = await page.evaluate(`
              (() => {
                const labels = ['\u8FD4\u56DE', '\u5173\u95ED', '\u53D6\u6D88', '\u79BB\u5F00'];
                const buttons = document.querySelectorAll('button, [role="button"], div, span');
                for (const btn of buttons) {
                  const text = (btn.innerText || btn.textContent || '').trim();
                  if (labels.some(l => text === l || text.includes(l)) && btn.offsetParent !== null) {
                    btn.click();
                    return true;
                  }
                }
                return false;
              })()
            `);
          if (leaveTriggered) {
            await page.wait({ time: 1 });
            const saveLabels = ["\u6682\u5B58\u79BB\u5F00", "\u5B58\u8349\u7A3F", "\u4FDD\u5B58\u8349\u7A3F"];
            const saved = await page.evaluate(`
                (labels => {
                  const buttons = document.querySelectorAll('button, [role="button"]');
                  for (const btn of buttons) {
                    const text = (btn.innerText || btn.textContent || '').trim();
                    if (
                      labels.some(l => text === l || text.includes(l)) &&
                      btn.offsetParent !== null &&
                      !btn.disabled
                    ) {
                      btn.click();
                      return true;
                    }
                  }
                  return false;
                })(${JSON.stringify(saveLabels)})
              `);
            if (saved) {
              invokeResult.ok = true;
              invokeResult.via = "leave-save-fallback";
            }
          }
          if (!invokeResult?.ok) {
            await page.wait({ time: 2 });
            const autoSaved = await page.evaluate(`
                () => {
                  const markers = ['\u8349\u7A3F\u7BB1(', '\u4FDD\u5B58\u4E8E', '\u7F16\u8F91\u4E8E'];
                  for (const el of document.querySelectorAll('*')) {
                    const text = (el.innerText || el.textContent || '').trim();
                    if (text && markers.some(marker => text.includes(marker))) return true;
                  }
                  return false;
                }
              `);
            if (autoSaved) {
              invokeResult.ok = true;
              invokeResult.via = "auto-save";
            }
          }
        }
      }
      if (!invokeResult?.ok) {
        await page.screenshot({ path: "/tmp/xhs_publish_submit_debug.png" });
        const viaClause = invokeResult?.via ? ` (via=${invokeResult.via})` : "";
        const errorClause = invokeResult?.error ? `, error=${invokeResult.error}` : "";
        const lastMethodClause = invokeResult?.lastMethodError ? `, lastMethodError=${invokeResult.lastMethodError}` : "";
        throw new Error(`Could not trigger "${actionLabels[0]}" action${viaClause}${errorClause}${lastMethodClause}. Debug screenshot: /tmp/xhs_publish_submit_debug.png`);
      }
      await page.wait({ time: 4 });
      const finalUrl = await page.evaluate("() => location.href");
      const successMarkers = isDraft ? ["\u8349\u7A3F\u5DF2\u4FDD\u5B58", "\u6682\u5B58\u6210\u529F", "\u4FDD\u5B58\u6210\u529F", "\u4FDD\u5B58\u4E8E", "\u56FE\u6587\u7B14\u8BB0("] : ["\u53D1\u5E03\u6210\u529F", "\u4E0A\u4F20\u6210\u529F"];
      const successMsg = await page.evaluate(`
      (markers => {
        for (const el of document.querySelectorAll('*')) {
          if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
          const text = (el.innerText || '').trim();
          if (text.length > 200) continue;
          if (el.children.length === 0 && markers.some(marker => text.includes(marker))) return text;
        }
        return '';
      })(${JSON.stringify(successMarkers)})
    `);
      const navigatedAway = /^https:\/\/creator\.xiaohongshu\.com\/new\/note-manager(?:[/?#]|$)/.test(finalUrl);
      const isSuccess = successMsg.length > 0 || navigatedAway;
      const verb = isDraft ? "\u6682\u5B58\u6210\u529F" : "\u53D1\u5E03\u6210\u529F";
      if (!isSuccess) {
        throw new CommandExecutionError(`${verb} could not be verified: no success marker or post-submit navigation was observed. ` + (finalUrl ? `Current URL: ${finalUrl}` : "Current URL was empty."));
      }
      return [
        {
          status: `\u2705 ${verb}`,
          detail: [
            `"${title}"`,
            isTextImage ? `${cards.length}\u5F20\u6587\u5B57\u914D\u56FE${absImagePaths.length ? ` + ${absImagePaths.length}\u5F20\u56FE\u7247` : ""}${appliedCardStyle && appliedCardStyle !== DEFAULT_CARD_STYLE ? ` (${appliedCardStyle})` : ""}` : `${absImagePaths.length}\u5F20\u56FE\u7247`,
            addedTopics.length ? `\u8BDD\u9898: ${addedTopics.join(" ")}` : "",
            successMsg || finalUrl || ""
          ].filter(Boolean).join(" \xB7 ")
        }
      ];
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/saved.js
  cli({
    site: "xiaohongshu",
    name: "saved",
    access: "read",
    description: "\u5C0F\u7EA2\u4E66\u6536\u85CF\u7B14\u8BB0\u5217\u8868",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      { name: "id", type: "string", help: "User id or profile URL (defaults to current logged-in user)" },
      { name: "limit", type: "int", default: 20, help: "Number of notes to return" }
    ],
    columns: ["rank", "id", "title", "author", "likes", "type", "url"],
    func: async (page, kwargs) => {
      const limit = parseCollectionLimit(kwargs.limit);
      const userId = await resolveXhsUserId(page, kwargs.id);
      return fetchXhsCollectionNotes(page, {
        userId,
        profileTab: SAVED_PROFILE_TAB,
        apiPattern: COLLECT_API_PATTERN,
        limit,
        emptyLabel: "saved"
      });
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/search.js
  var WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const findNoteCard = () => document.querySelector(
      'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])'
    );
    const detect = () => {
      if (findNoteCard()) return 'content';
      const bodyText = document.body?.innerText || '';
      if (/\u767B\u5F55\u540E\u67E5\u770B\u641C\u7D22\u7ED3\u679C/.test(bodyText) || document.querySelector('#login-btn')) return 'login_wall';
      if (/\u8BF7\u6C42\u592A\u9891\u7E41|\u8BBF\u95EE\u9891\u6B21\u5F02\u5E38|\u5B89\u5168\u9650\u5236/.test(bodyText)) return 'security_block';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })
`;
  var DEFAULT_HARVEST_STEP = 900;
  var CONTENT_WAIT_SECONDS = 5;
  var FILTER_SETTLE_SECONDS = 8;
  var SEARCH_FILTERS = [
    {
      arg: "sort",
      group: "\u6392\u5E8F\u4F9D\u636E",
      defaultValue: "comprehensive",
      options: { comprehensive: "\u7EFC\u5408", latest: "\u6700\u65B0", "most-liked": "\u6700\u591A\u70B9\u8D5E", "most-commented": "\u6700\u591A\u8BC4\u8BBA", "most-collected": "\u6700\u591A\u6536\u85CF" }
    },
    {
      arg: "note-type",
      group: "\u7B14\u8BB0\u7C7B\u578B",
      defaultValue: "all",
      options: { all: "\u4E0D\u9650", video: "\u89C6\u9891", image: "\u56FE\u6587" }
    },
    {
      arg: "publish-time",
      group: "\u53D1\u5E03\u65F6\u95F4",
      defaultValue: "anytime",
      options: { anytime: "\u4E0D\u9650", day: "\u4E00\u5929\u5185", week: "\u4E00\u5468\u5185", "half-year": "\u534A\u5E74\u5185" }
    },
    {
      arg: "scope",
      group: "\u641C\u7D22\u8303\u56F4",
      defaultValue: "all",
      options: { all: "\u4E0D\u9650", seen: "\u5DF2\u770B\u8FC7", unseen: "\u672A\u770B\u8FC7", following: "\u5DF2\u5173\u6CE8" }
    },
    {
      arg: "location",
      group: "\u4F4D\u7F6E\u8DDD\u79BB",
      defaultValue: "all",
      options: { all: "\u4E0D\u9650", "same-city": "\u540C\u57CE", nearby: "\u9644\u8FD1" }
    }
  ];
  function isCollapsedRender(diag) {
    return diag.cardCount > 1 && diag.feedClientHeight === 0 && diag.distinctCardTops === 1;
  }
  function harvestOptionsForLimit(limit) {
    return {
      maxRounds: 12 + Math.ceil((limit - 1) * 48 / 99),
      // Browser Bridge/CDP evaluates time out at 60s. Keep enough headroom
      // for serialization and transport even at --limit 100.
      budgetMs: 1e4 + Math.ceil((limit - 1) * 35e3 / 99),
      step: DEFAULT_HARVEST_STEP
    };
  }
  function noteUrlInfo(url, webHost = "") {
    if (typeof url !== "string" || !url)
      return { key: "", signed: false };
    try {
      const parsed = new URL(url);
      const expectedHost = String(webHost || "").toLowerCase();
      if (parsed.protocol !== "https:" || expectedHost && parsed.hostname.toLowerCase() !== expectedHost) {
        return { key: "", signed: false };
      }
      const match = parsed.pathname.match(/^\/(?:search_result|explore|note)\/([0-9a-f]{24})\/?$/i);
      return {
        key: match ? match[1].toLowerCase() : "",
        signed: Boolean(parsed.searchParams.get("xsec_token")?.trim())
      };
    } catch {
      return { key: "", signed: false };
    }
  }
  function mergeHarvestedRow(acc, row, webHost = "") {
    const url = typeof row?.url === "string" ? row.url : "";
    const info = noteUrlInfo(url, webHost);
    const key = info.key;
    if (!key)
      return false;
    const prev = acc.get(key);
    if (!prev) {
      acc.set(key, { ...row });
      return true;
    }
    let changed = false;
    for (const field of ["title", "author", "author_url"]) {
      if (!prev[field] && row?.[field]) {
        prev[field] = row[field];
        changed = true;
      }
    }
    if ((!prev.likes || prev.likes === "0") && row?.likes && row.likes !== "0") {
      prev.likes = row.likes;
      changed = true;
    }
    if (info.signed && !noteUrlInfo(prev.url, webHost).signed) {
      prev.url = url;
      changed = true;
    }
    return changed;
  }
  function usableRowCount(acc) {
    let count = 0;
    for (const row of acc.values()) {
      if (row?.title)
        count++;
    }
    return count;
  }
  function shouldStopScrolling(state) {
    if (state.collected >= state.target)
      return { stop: true, reason: "target" };
    if (state.elapsedMs >= state.budgetMs)
      return { stop: true, reason: "budget" };
    if (state.round >= state.maxRounds)
      return { stop: true, reason: "max-rounds" };
    if (state.idleRounds >= 3)
      return { stop: true, reason: state.atBottom ? "exhausted" : "wedged" };
    return { stop: false, reason: "" };
  }
  function noteIdToDate(url) {
    const match = url.match(/\/(?:search_result|explore|note)\/([0-9a-f]{24})(?=[?#/]|$)/i);
    if (!match)
      return "";
    const hex = match[1].substring(0, 8);
    const ts = parseInt(hex, 16);
    if (!ts || ts < 1e9 || ts > 4e9)
      return "";
    return new Date((ts + 8 * 3600) * 1e3).toISOString().slice(0, 10);
  }
  function stripXhsAuthorDateSuffix(value) {
    const text = (value || "").replace(/\s+/g, " ").trim();
    const stripped = text.replace(/\s*(?:\d{1,2}天前|\d+小时前|\d+分钟前|\d+秒前|刚刚|昨天|前天|\d+周前|\d+个月前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})$/u, "").trim();
    return stripped || text;
  }
  function extractSearchRows(webHost) {
    const normalizeUrl = (href) => {
      if (!href)
        return "";
      try {
        const parsed = new URL(href, `https://${webHost}/`);
        if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== webHost.toLowerCase())
          return "";
        return parsed.href;
      } catch {
        return "";
      }
    };
    const cleanText2 = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisibleNote = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0)
        return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    const collectNoteCards = () => {
      const classMatches = document.querySelectorAll("section.note-item");
      if (classMatches.length > 0)
        return classMatches;
      const sections = /* @__PURE__ */ new Set();
      for (const a of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
        const section = a.closest("section");
        if (section)
          sections.add(section);
      }
      return sections;
    };
    for (const el of collectNoteCards()) {
      if (el.classList?.contains("query-note-item"))
        continue;
      if (!isVisibleNote(el))
        continue;
      const titleEl = el.querySelector(".title, .note-title, a.title, .footer .title span");
      const nameEl = el.querySelector("a.author .name, .author-name, .nick-name, .name");
      const authorWrapEl = el.querySelector("a.author");
      let author = cleanText2(nameEl?.textContent || "");
      if (!author && authorWrapEl) {
        const nameChild = authorWrapEl.querySelector(".name");
        author = nameChild ? cleanText2(nameChild.textContent || "") : stripXhsAuthorDateSuffix(authorWrapEl.textContent || "");
      }
      const likesEl = el.querySelector(".count, .like-count, .like-wrapper .count");
      const detailLinkEl = el.querySelector("a.cover.mask") || el.querySelector('a[href*="/search_result/"]') || el.querySelector('a[href*="/explore/"]') || el.querySelector('a[href*="/note/"]');
      const authorLinkEl = el.querySelector('a.author, a[href*="/user/profile/"]');
      const url = normalizeUrl(detailLinkEl?.getAttribute("href") || "");
      if (!url)
        continue;
      const key = url;
      if (seen.has(key))
        continue;
      seen.add(key);
      let title = cleanText2(titleEl?.textContent || "");
      if (!title) {
        const captionSpan = detailLinkEl?.querySelector("span");
        title = cleanText2(captionSpan?.textContent || "");
      }
      results.push({
        title,
        author,
        likes: cleanText2(likesEl?.textContent || "0"),
        url,
        author_url: normalizeUrl(authorLinkEl?.getAttribute("href") || "")
      });
    }
    return results;
  }
  function isTrustedAuthorUrl(url, webHost) {
    if (url === "")
      return true;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === webHost.toLowerCase() && /^\/user\/profile\/[^/]+\/?$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  function requireTrustedHarvestRow(row, index, webHost) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new CommandExecutionError(`Unexpected Xiaohongshu search harvest row ${index + 1} shape; expected an object.`);
    }
    for (const field of ["title", "author", "likes", "url", "author_url"]) {
      if (typeof row[field] !== "string") {
        throw new CommandExecutionError(`Unexpected Xiaohongshu search harvest row ${index + 1} shape; expected string ${field}.`);
      }
    }
    if (!noteUrlInfo(row.url, webHost).key) {
      throw new CommandExecutionError(`Unexpected Xiaohongshu search harvest row ${index + 1} URL; expected a trusted note URL.`);
    }
    if (!isTrustedAuthorUrl(row.author_url, webHost)) {
      throw new CommandExecutionError(`Unexpected Xiaohongshu search harvest row ${index + 1} author URL; expected a trusted profile URL.`);
    }
    return row;
  }
  function requireHarvestPayload(payload, webHost) {
    const result = unwrapEvaluateResult(payload);
    const diag = result?.diag;
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.rows) || !diag || typeof diag !== "object" || Array.isArray(diag) || typeof diag.securityBlock !== "boolean" || typeof diag.stopReason !== "string" || !Number.isFinite(diag.scrollHeight) || diag.scrollHeight < 0 || !Number.isFinite(diag.clientHeight) || diag.clientHeight < 0 || !Number.isSafeInteger(diag.cardCount) || diag.cardCount < 0 || !(diag.feedClientHeight === null || Number.isFinite(diag.feedClientHeight) && diag.feedClientHeight >= 0) || !Number.isSafeInteger(diag.distinctCardTops) || diag.distinctCardTops < 0) {
      throw new CommandExecutionError("Unexpected Xiaohongshu search harvest payload shape; expected rows plus typed diagnostics.");
    }
    result.rows = result.rows.map((row, index) => requireTrustedHarvestRow(row, index, webHost));
    return result;
  }
  function parseLimit2(raw) {
    const parsed = Number(raw ?? 20);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ArgumentError(`--limit must be an integer between 1 and 100, got ${JSON.stringify(raw)}`);
    }
    if (parsed < 1 || parsed > 100) {
      throw new ArgumentError(`--limit must be between 1 and 100, got ${parsed}`);
    }
    return parsed;
  }
  function resolveSearchFilters(kwargs) {
    return SEARCH_FILTERS.map((definition) => {
      const value = kwargs[definition.arg] ?? definition.defaultValue;
      const option = typeof value === "string" ? definition.options[value] : void 0;
      if (!option) {
        throw new ArgumentError(
          `--${definition.arg} must be one of: ${Object.keys(definition.options).join(", ")}, got ${JSON.stringify(value)}`
        );
      }
      return {
        group: definition.group,
        option,
        capability: value === definition.defaultValue ? "" : definition.arg === "location" ? "location" : definition.arg === "scope" ? "account" : ""
      };
    });
  }
  function buildApplySearchFiltersJs(requestedFilters) {
    return `
      (async () => {
        const requestedFilters = ${JSON.stringify(requestedFilters)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const text = (element) => (element?.textContent || '').replace(/\\s+/g, '').trim();
        const visible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (element.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
          for (let node = element; node; node = node.parentElement) {
            const ancestorStyle = getComputedStyle(node);
            if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity || 1) <= 0.01) return false;
          }
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        };
        const visibleMatches = (root, selector) =>
          Array.from(root.querySelectorAll(selector)).filter(visible);
        const authBlocked = () => /\u767B\u5F55\u540E\u67E5\u770B\u641C\u7D22\u7ED3\u679C/.test(document.body?.innerText || '') ||
          visible(document.querySelector('#login-btn'));
        const locationBlocked = () => /\u8BF7\u5F00\u542F\u6D4F\u89C8\u5668\u5730\u7406\u4F4D\u7F6E\u6743\u9650/.test(document.body?.innerText || '');
        const panels = () => visibleMatches(document, '.search-layout__top > .filter > .filter-panel');
        const triggers = () => visibleMatches(document, '.search-layout__top > .filter');

        const openPanel = async () => {
          let clicked = false;
          for (let attempt = 0; attempt < 16; attempt++) {
            if (authBlocked()) return { status: 'auth', detail: 'login_wall' };
            const currentPanels = panels();
            if (currentPanels.length === 1) return { status: 'ok', panel: currentPanels[0] };
            if (currentPanels.length > 1) return { status: 'layout', detail: 'ambiguous_filter_panel' };
            const currentTriggers = triggers();
            if (currentTriggers.length > 1) return { status: 'layout', detail: 'ambiguous_filter_trigger' };
            if (!clicked && currentTriggers.length === 1) {
              currentTriggers[0].click();
              clicked = true;
            }
            await sleep(100);
          }
          return { status: 'layout', detail: 'filter_panel_not_found' };
        };

        const findOption = (panel, request) => {
          const groups = visibleMatches(panel, '.filters').filter((group) => {
            const label = Array.from(group.children).find((child) => child.tagName === 'SPAN');
            return text(label) === request.group;
          });
          if (groups.length !== 1) {
            return { status: 'layout', detail: groups.length ? 'ambiguous_group' : 'group_not_found' };
          }
          const options = visibleMatches(groups[0], '.tag-container > .tags')
            .filter((option) => text(option) === request.option);
          if (options.length !== 1) {
            return { status: 'layout', detail: options.length ? 'ambiguous_option' : 'option_not_found' };
          }
          return { status: 'ok', option: options[0] };
        };
        const isActive = (option) => option.classList.contains('active');
        const ready = () => visibleMatches(document, 'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"]), .search-empty-wrapper').length > 0;
        const busy = () => visibleMatches(
          document,
          '.search-layout__main [aria-busy="true"], .search-layout__main [class*="skeleton"], .search-layout__main [class*="loading"]',
        ).length > 0;
        const snapshot = () => {
          const rows = visibleMatches(document, 'section.note-item, section:has(a[href*="/search_result/"]), section:has(a[href*="/explore/"])')
            .map((row) => {
              const anchor = row.querySelector('a[href*="/search_result/"], a[href*="/explore/"]');
              return [anchor?.getAttribute('href') || '', text(row)];
            });
          const feed = document.querySelector('.feeds-container');
          return JSON.stringify([
            rows,
            visibleMatches(document, '.search-empty-wrapper').length,
            document.documentElement?.scrollHeight || 0,
            feed ? feed.clientHeight : null,
          ]);
        };

        for (const request of requestedFilters) {
          const opened = await openPanel();
          if (opened.status !== 'ok') return opened;
          let found = findOption(opened.panel, request);
          if (found.status !== 'ok') {
            if (request.capability === 'location') return { status: 'location', detail: found.detail };
            if (request.capability === 'account') return { status: 'capability', detail: found.detail };
            return found;
          }
          if (isActive(found.option)) {
            continue;
          }

          const clickedAt = Date.now();
          found.option.click();
          let becameActive = false;
          while (Date.now() - clickedAt < 2500) {
            if (authBlocked()) return { status: 'auth', detail: 'login_wall' };
            if (locationBlocked()) return { status: 'location', detail: 'geolocation_denied' };
            const currentPanels = panels();
            if (currentPanels.length === 1) {
              found = findOption(currentPanels[0], request);
              if (found.status === 'ok' && isActive(found.option)) {
                becameActive = true;
                break;
              }
            }
            await sleep(100);
          }
          if (!becameActive) {
            if (request.capability === 'location') return { status: 'location', detail: 'chip_not_active' };
            if (request.capability === 'account') return { status: 'capability', detail: 'chip_not_active' };
            return { status: 'inactive', detail: request.group + '/' + request.option };
          }

          let stableSamples = 0;
          let previousSnapshot = '';
          while (Date.now() - clickedAt < ${FILTER_SETTLE_SECONDS * 1e3}) {
            const currentSnapshot = snapshot();
            if (Date.now() - clickedAt >= 1500 && ready() && !busy()) {
              stableSamples = currentSnapshot === previousSnapshot ? stableSamples + 1 : 1;
              previousSnapshot = currentSnapshot;
              if (stableSamples >= 3) break;
            }
            else {
              stableSamples = 0;
              previousSnapshot = '';
            }
            await sleep(200);
          }
          if (stableSamples < 3) {
            return { status: 'timeout', detail: request.group + '/' + request.option };
          }
          const finalPanels = panels();
          const finalFound = finalPanels.length === 1 ? findOption(finalPanels[0], request) : null;
          if (!finalFound || finalFound.status !== 'ok' || !isActive(finalFound.option)) {
            return { status: 'inactive', detail: request.group + '/' + request.option };
          }
        }
        return { status: 'ok' };
      })()
    `;
  }
  function requireFilterApplication(payload) {
    const result = unwrapEvaluateResult(payload);
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.status !== "string") {
      throw new CommandExecutionError("Unexpected Xiaohongshu search filter result shape.");
    }
    if (result.status === "ok") {
      return;
    }
    const detail = typeof result.detail === "string" ? result.detail : "unknown";
    if (result.status === "auth") {
      throw new AuthRequiredError("www.xiaohongshu.com", "Xiaohongshu search filters require a logged-in browser session");
    }
    if (result.status === "timeout") {
      throw new TimeoutError(`xiaohongshu search filter ${detail}`, FILTER_SETTLE_SECONDS);
    }
    if (result.status === "location") {
      throw new CommandExecutionError(`Xiaohongshu location filter was not applied (${detail}); enable browser geolocation permission.`);
    }
    if (result.status === "capability") {
      throw new CommandExecutionError(`Xiaohongshu account-scoped filter was unavailable (${detail}); verify login and account access.`);
    }
    if (result.status === "inactive") {
      throw new CommandExecutionError(`Xiaohongshu search filter chip did not become active (${detail}).`);
    }
    throw new CommandExecutionError(`Xiaohongshu search filter layout did not match the expected visible panel (${detail}).`);
  }
  function buildScrollHarvestJs(webHost, targetCount, options = {}) {
    const maxRounds = options.maxRounds ?? 30;
    const budgetMs = options.budgetMs ?? 3e4;
    const step = options.step ?? DEFAULT_HARVEST_STEP;
    if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
      throw new ArgumentError(`targetCount must be a positive integer, got ${JSON.stringify(targetCount)}`);
    }
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
      throw new ArgumentError(`maxRounds must be a positive integer, got ${JSON.stringify(maxRounds)}`);
    }
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new ArgumentError(`budgetMs must be a positive number, got ${JSON.stringify(budgetMs)}`);
    }
    if (!Number.isFinite(step) || step < 0) {
      throw new ArgumentError(`step must be a non-negative number, got ${JSON.stringify(step)}`);
    }
    return `
      (async () => {
        const targetCount = ${targetCount};
        const maxRounds = ${maxRounds};
        const budgetMs = ${budgetMs};
        const configuredStep = ${step};
        const webHost = ${JSON.stringify(webHost)};
        const noteUrlInfo = ${noteUrlInfo.toString()};
        const mergeHarvestedRow = ${mergeHarvestedRow.toString()};
        const stripXhsAuthorDateSuffix = ${stripXhsAuthorDateSuffix.toString()};
        const extractSearchRows = ${extractSearchRows.toString()};
        const usableRowCount = ${usableRowCount.toString()};
        const shouldStopScrolling = ${shouldStopScrolling.toString()};
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rootScroller = document.scrollingElement || document.documentElement || document.body;
        const rootScrollHeight = () => Math.max(
          rootScroller?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
        const rootClientHeight = () => Math.max(
          window.innerHeight || 0,
          rootScroller?.clientHeight || 0,
          document.documentElement?.clientHeight || 0
        );
        const readScrollMetrics = () => {
          const rootTop = Math.max(
            window.scrollY || window.pageYOffset || 0,
            rootScroller?.scrollTop || 0,
            document.documentElement?.scrollTop || 0,
            document.body?.scrollTop || 0
          );
          return {
            rootTop,
            scrollTop: rootTop,
            scrollHeight: rootScrollHeight(),
            clientHeight: rootClientHeight(),
          };
        };
        const driveScroll = (metrics) => {
          // Never advance farther than one viewport. A larger step can skip a
          // complete virtualized frame before it is harvested.
          const viewport = metrics.clientHeight || configuredStep;
          const scrollStep = Math.max(1, Math.min(configuredStep, viewport));
          if (typeof window.scrollBy === 'function') {
            window.scrollBy(0, scrollStep);
          } else if (rootScroller) {
            rootScroller.scrollTop += scrollStep;
          }
        };
        const acc = new Map();
        const startedAt = Date.now();
        let previousMetrics = null;
        let idleRounds = 0;
        let cardCount = 0;
        let round = 0;
        let stopReason = '';
        let metrics = readScrollMetrics();
        let securityBlock = false;
        while (true) {
          round++;
          securityBlock = /\u8BF7\u6C42\u592A\u9891\u7E41|\u8BBF\u95EE\u9891\u6B21\u5F02\u5E38|\u5B89\u5168\u9650\u5236/.test(document.body?.innerText || '');
          if (securityBlock) {
            stopReason = 'security-block';
            metrics = readScrollMetrics();
            break;
          }
          const currentRows = extractSearchRows(webHost);
          cardCount = currentRows.length;
          let dataChanged = false;
          for (const row of currentRows) {
            if (mergeHarvestedRow(acc, row, webHost)) dataChanged = true;
          }
          metrics = readScrollMetrics();
          const geometryChanged = previousMetrics === null ||
            metrics.scrollTop !== previousMetrics.scrollTop ||
            metrics.scrollHeight !== previousMetrics.scrollHeight ||
            metrics.clientHeight !== previousMetrics.clientHeight;
          const usable = usableRowCount(acc);
          if (previousMetrics !== null && !dataChanged && !geometryChanged) {
            idleRounds++;
          } else {
            idleRounds = 0;
          }
          const atBottom = metrics.scrollHeight <= metrics.clientHeight + 2 ||
            metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 8;
          const elapsedMs = Date.now() - startedAt;
          const decision = shouldStopScrolling({
            // Untitled cards are dropped after the loop, so counting them
            // toward the target would silently shrink the result set.
            collected: usable,
            target: targetCount,
            round,
            maxRounds,
            elapsedMs,
            budgetMs,
            atBottom,
            idleRounds,
          });
          if (decision.stop) {
            stopReason = decision.reason;
            break;
          }
          previousMetrics = metrics;
          driveScroll(metrics);
          // At the bottom, give lazy loading a full second before counting an
          // idle round. Mid-page frames need only a short render settle.
          await wait(atBottom ? 1000 : 500);
        }
        const elapsedMs = Date.now() - startedAt;
        const classMatches = document.querySelectorAll('section.note-item');
        let diagnosticCards = classMatches;
        if (classMatches.length === 0) {
          const sections = new Set();
          for (const anchor of document.querySelectorAll('a[href*="/search_result/"], a[href*="/explore/"]')) {
            const section = anchor.closest('section');
            if (section) sections.add(section);
          }
          diagnosticCards = sections;
        }
        const distinctCardTops = new Set();
        for (const card of diagnosticCards) {
          if (card.classList?.contains('query-note-item')) continue;
          distinctCardTops.add(Math.round(card.getBoundingClientRect().top));
        }
        const feedContainer = document.querySelector('.feeds-container');
        return {
          rows: Array.from(acc.values()),
          collected: acc.size,
          diag: {
            usable: usableRowCount(acc),
            scrollTop: metrics.scrollTop,
            scrollHeight: metrics.scrollHeight,
            clientHeight: metrics.clientHeight,
            cardCount,
            feedClientHeight: feedContainer ? feedContainer.clientHeight : null,
            distinctCardTops: distinctCardTops.size,
            rounds: round,
            stopReason,
            elapsedMs,
            securityBlock,
          },
        };
      })()
    `;
  }
  async function collectSearchHarvest(page, limit, requestedFilters) {
    const waitResult = unwrapEvaluateResult(await page.evaluate(WAIT_FOR_CONTENT_JS));
    if (waitResult === "login_wall") {
      throw new AuthRequiredError("www.xiaohongshu.com", "Xiaohongshu search results are blocked behind a login wall");
    }
    if (waitResult === "security_block") {
      throw new CliError("SECURITY_BLOCK", "Xiaohongshu search was blocked by request-frequency or security controls.", "Wait before retrying or use a different logged-in browser session.");
    }
    if (waitResult === "timeout") {
      throw new TimeoutError("xiaohongshu search content", CONTENT_WAIT_SECONDS);
    }
    if (waitResult !== "content") {
      throw new CommandExecutionError("Unexpected Xiaohongshu search wait payload shape.");
    }
    requireFilterApplication(await page.evaluate(buildApplySearchFiltersJs(requestedFilters)));
    const harvestOptions = harvestOptionsForLimit(limit);
    const harvest = requireHarvestPayload(await page.evaluate(buildScrollHarvestJs("www.xiaohongshu.com", limit, harvestOptions)), "www.xiaohongshu.com");
    if (harvest.diag.securityBlock) {
      throw new CliError("SECURITY_BLOCK", "Xiaohongshu search was blocked by request-frequency or security controls.", "Wait before retrying or use a different logged-in browser session.");
    }
    return harvest;
  }
  async function replaceCollapsedTab(page, url) {
    if (typeof page.getActivePage !== "function" || typeof page.newTab !== "function" || typeof page.setActivePage !== "function" || typeof page.selectTab !== "function" || typeof page.closeTab !== "function") {
      throw new CommandExecutionError(
        "Xiaohongshu search rendered in a collapsed tab, but this browser session cannot replace the failed target.",
        "Retry the command in a Browser Bridge session that supports tab replacement."
      );
    }
    const previousPage = page.getActivePage();
    if (!previousPage) {
      throw new CommandExecutionError("Xiaohongshu search cannot identify the collapsed browser target for safe replacement.");
    }
    let freshPage;
    try {
      freshPage = await page.newTab(url);
      if (!freshPage) {
        throw new Error("newTab returned no page identity");
      }
      page.setActivePage(freshPage);
      await page.closeTab(previousPage);
    } catch (error) {
      const cleanupErrors = [];
      if (freshPage) {
        let restoredPrevious = false;
        try {
          await page.selectTab(previousPage);
          restoredPrevious = true;
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError?.message ?? String(cleanupError));
        }
        if (restoredPrevious) {
          try {
            await page.closeTab(freshPage);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError?.message ?? String(cleanupError));
          }
        } else {
          page.setActivePage(freshPage);
        }
      }
      const cleanupContext = cleanupErrors.length > 0 ? ` Cleanup also failed: ${cleanupErrors.join("; ")}.` : "";
      throw new CommandExecutionError(
        `Failed to replace collapsed Xiaohongshu search tab: ${error?.message ?? String(error)}.${cleanupContext}`
      );
    }
  }
  var command7 = cli({
    site: "xiaohongshu",
    name: "search",
    access: "read",
    description: "\u641C\u7D22\u5C0F\u7EA2\u4E66\u7B14\u8BB0",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
      { name: "query", required: true, positional: true, help: "Search keyword" },
      { name: "limit", type: "int", default: 20, help: "Number of results" },
      { name: "sort", type: "string", default: "comprehensive", choices: ["comprehensive", "latest", "most-liked", "most-commented", "most-collected"], help: "Sort order" },
      { name: "note-type", type: "string", default: "all", choices: ["all", "video", "image"], help: "Note type" },
      { name: "publish-time", type: "string", default: "anytime", choices: ["anytime", "day", "week", "half-year"], help: "Publish time range" },
      { name: "scope", type: "string", default: "all", choices: ["all", "seen", "unseen", "following"], help: "Search scope" },
      { name: "location", type: "string", default: "all", choices: ["all", "same-city", "nearby"], help: "Location distance" }
    ],
    columns: ["rank", "title", "author", "likes", "published_at", "url"],
    func: async (page, kwargs) => {
      try {
        const limit = parseLimit2(kwargs.limit);
        const requestedFilters = resolveSearchFilters(kwargs);
        const keyword = encodeURIComponent(kwargs.query);
        const url = `https://www.xiaohongshu.com/search_result?keyword=${keyword}&source=web_search_result_notes`;
        await page.goto(url);
        let harvest = await collectSearchHarvest(page, limit, requestedFilters);
        if (isCollapsedRender(harvest.diag)) {
          await replaceCollapsedTab(page, url);
          harvest = await collectSearchHarvest(page, limit, requestedFilters);
          if (isCollapsedRender(harvest.diag)) {
            throw new CommandExecutionError(
              "Xiaohongshu search masonry remained collapsed after one fresh-tab recovery.",
              "Retry later or use a different logged-in browser session."
            );
          }
        }
        const rows = harvest.rows.filter((item) => item.title).slice(0, limit);
        if (rows.length === 0) {
          throw new EmptyResultError("xiaohongshu search", "No usable notes were rendered for this query.");
        }
        return rows.map((item, i) => ({
          rank: i + 1,
          ...item,
          published_at: noteIdToDate(item.url)
        }));
      } catch (err) {
        if (err instanceof CliError)
          throw err;
        throw new CommandExecutionError(`Xiaohongshu search failed: ${err?.message ?? String(err)}`);
      }
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/unfollow.js
  var PROFILE_SETTLE_MS2 = 2500;
  var MODAL_SETTLE_MS2 = 1500;
  var STATE_FLIP_TIMEOUT_MS2 = 5e3;
  var USER_ID_RE2 = /^[a-zA-Z0-9]{8,32}$/;
  function isXiaohongshuHost3(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  }
  function requireActionResult3(payload, context) {
    const inner = unwrapEvaluateResult(payload);
    if (!inner || typeof inner !== "object" || Array.isArray(inner) || typeof inner.ok !== "boolean") {
      throw new CommandExecutionError(`xiaohongshu/unfollow: malformed ${context} payload`);
    }
    return inner;
  }
  function assertUserId2(raw) {
    const input = String(raw ?? "").trim();
    if (/^https?:\/\//i.test(input)) {
      let parsed;
      try {
        parsed = new URL(input);
      } catch {
        throw new ArgumentError("xiaohongshu/unfollow: invalid profile URL");
      }
      if (parsed.protocol !== "https:" || !isXiaohongshuHost3(parsed.hostname)) {
        throw new ArgumentError("xiaohongshu/unfollow: profile URL must be an exact https://*.xiaohongshu.com URL");
      }
      const match = parsed.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]{8,32})\/?$/);
      if (!match) {
        throw new ArgumentError("xiaohongshu/unfollow: profile URL must be /user/profile/<userId>");
      }
      return match[1];
    }
    const userId = normalizeXhsUserId(raw);
    if (!userId || !USER_ID_RE2.test(userId)) {
      throw new ArgumentError(
        "xiaohongshu/unfollow: user-id must be a Xiaohongshu user ID (e.g. 5d8f88dc0000000001005d3a) or full profile URL"
      );
    }
    return userId;
  }
  function buildClickUnfollowScript() {
    return `
(() => {
  const FOLLOW_LABELS = ['\u5173\u6CE8', '+ \u5173\u6CE8', '+\u5173\u6CE8'];
  const FOLLOWING_LABELS = ['\u5DF2\u5173\u6CE8', '\u5DF2\u4E92\u5173', '\u4E92\u76F8\u5173\u6CE8'];

  const isVisible = (el) => !!el && el.offsetParent !== null;
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  const SCOPE_SELECTORS = [
    '.user-info', '.profile-info', '.user-detail', '.profile-page',
    '[class*="user-info"]', '[class*="profile"]',
  ];
  const scopes = SCOPE_SELECTORS.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
  const visibleScopes = scopes.filter(isVisible);
  const roots = visibleScopes.length > 0 ? visibleScopes : [document];

  const collectButtons = () => {
    const out = new Set();
    for (const root of roots) {
      const els = root.querySelectorAll('button, [role="button"]');
      for (const el of els) {
        if (isVisible(el)) out.add(el);
      }
    }
    return Array.from(out);
  };
  const findButtonByLabels = (labels) => {
    for (const btn of collectButtons()) {
      const t = textOf(btn);
      if (labels.includes(t)) return btn;
    }
    return null;
  };

  if (findButtonByLabels(FOLLOW_LABELS)) {
    return { ok: true, state: 'not-following' };
  }
  const btn = findButtonByLabels(FOLLOWING_LABELS);
  if (!btn) {
    return {
      ok: false,
      state: 'failed',
      reason: 'Follow-state button not found on profile (logged out, blocked, or selectors changed).',
    };
  }
  btn.click();
  return { ok: true, state: 'unfollow-clicked' };
})()
`;
  }
  function buildConfirmModalScript() {
    return `
(() => {
  const isVisible = (el) => !!el && el.offsetParent !== null;
  const footer = Array.from(document.querySelectorAll('.d-modal-footer')).find(isVisible);
  if (!footer) return { ok: false, kind: 'no_modal' };
  const buttons = Array.from(footer.querySelectorAll('button, [role="button"]')).filter(isVisible);
  const confirmBtn = buttons.find((b) => {
    const t = (b.innerText || b.textContent || '').trim();
    return t === '\u786E\u5B9A' || t === '\u4E0D\u518D\u5173\u6CE8' || t === '\u53D6\u6D88\u5173\u6CE8';
  });
  if (!confirmBtn) {
    return { ok: false, kind: 'no_confirm', labels: buttons.map((b) => (b.innerText || '').trim()) };
  }
  confirmBtn.click();
  return { ok: true };
})()
`;
  }
  function buildVerifyFollowFlippedScript() {
    return `
(async () => {
  const FOLLOW_LABELS = ['\u5173\u6CE8', '+ \u5173\u6CE8', '+\u5173\u6CE8'];
  const STATE_FLIP_TIMEOUT_MS = ${STATE_FLIP_TIMEOUT_MS2};
  const STATE_POLL_MS = 250;

  const isVisible = (el) => !!el && el.offsetParent !== null;
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  const SCOPE_SELECTORS = [
    '.user-info', '.profile-info', '.user-detail', '.profile-page',
    '[class*="user-info"]', '[class*="profile"]',
  ];
  const findFollowButton = () => {
    const scopes = SCOPE_SELECTORS.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
    const visibleScopes = scopes.filter(isVisible);
    const roots = visibleScopes.length > 0 ? visibleScopes : [document];
    for (const root of roots) {
      for (const btn of root.querySelectorAll('button, [role="button"]')) {
        if (!isVisible(btn)) continue;
        if (FOLLOW_LABELS.includes(textOf(btn))) return btn;
      }
    }
    return null;
  };

  const deadline = Date.now() + STATE_FLIP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (findFollowButton()) return { ok: true };
    await new Promise((r) => setTimeout(r, STATE_POLL_MS));
  }
  return { ok: false, reason: 'Unfollow click did not flip button back to \u5173\u6CE8 within ' + (STATE_FLIP_TIMEOUT_MS / 1000) + 's' };
})()
`;
  }
  cli({
    site: "xiaohongshu",
    name: "unfollow",
    access: "write",
    description: "\u53D6\u6D88\u5173\u6CE8\u5C0F\u7EA2\u4E66\u7528\u6237 (profile UI automation)",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
      {
        name: "user-id",
        required: true,
        positional: true,
        help: "User ID (e.g. 5d8f88dc0000000001005d3a) or profile URL"
      }
    ],
    columns: ["status", "user_id", "url"],
    func: async (page, kwargs) => {
      if (!page) {
        throw new CommandExecutionError("Browser session required for xiaohongshu unfollow");
      }
      try {
        const userId = assertUserId2(kwargs["user-id"]);
        const url = `https://www.xiaohongshu.com/user/profile/${userId}`;
        await page.goto(url);
        await page.wait({ time: PROFILE_SETTLE_MS2 / 1e3 });
        const hrefRaw = unwrapEvaluateResult(await page.evaluate("() => location.href"));
        if (typeof hrefRaw !== "string") {
          throw new CommandExecutionError("xiaohongshu/unfollow: malformed current-url payload");
        }
        const parsedHref = new URL(hrefRaw);
        if (parsedHref.protocol !== "https:" || !isXiaohongshuHost3(parsedHref.hostname)) {
          throw new CommandExecutionError(
            `xiaohongshu/unfollow: expected Xiaohongshu profile host, got ${parsedHref.hostname}`
          );
        }
        if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
          throw new AuthRequiredError("www.xiaohongshu.com");
        }
        const currentProfile = parsedHref.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]{8,32})\/?$/);
        if (currentProfile?.[1] !== userId) {
          throw new CommandExecutionError(
            `xiaohongshu/unfollow: expected profile ${userId}, got ${parsedHref.pathname}`
          );
        }
        const clickResult = requireActionResult3(
          await page.evaluate(buildClickUnfollowScript()),
          "click-unfollow"
        );
        if (!clickResult.ok) {
          throw new CommandExecutionError(
            `xiaohongshu/unfollow failed: ${clickResult.reason ?? "unknown reason"}`
          );
        }
        if (clickResult.state === "not-following") {
          return [{ status: "not-following", user_id: userId, url }];
        }
        await page.wait({ time: MODAL_SETTLE_MS2 / 1e3 });
        const confirmResult = requireActionResult3(
          await page.evaluate(buildConfirmModalScript()),
          "confirm-modal"
        );
        if (!confirmResult.ok) {
          throw new CommandExecutionError(
            `xiaohongshu/unfollow: confirmation modal step failed (${confirmResult.kind ?? "no kind reported"})`
          );
        }
        const verifyRaw = unwrapEvaluateResult(await page.evaluate(buildVerifyFollowFlippedScript()));
        if (!verifyRaw || typeof verifyRaw !== "object" || verifyRaw.ok !== true) {
          throw new CommandExecutionError(
            `xiaohongshu/unfollow: ${verifyRaw?.reason ?? "state verification failed"}`
          );
        }
        return [{ status: "unfollowed", user_id: userId, url }];
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CommandExecutionError(
          `xiaohongshu/unfollow failed: ${err?.message ?? String(err)}`
        );
      }
    }
  });

  // webcli/scripts/opencli-xiaohongshu/upstream/user.js
  var USER_SNAPSHOT_JS = `
    (() => {
      const safeClone = (value) => {
        try {
          return JSON.parse(JSON.stringify(value ?? null));
        } catch {
          return null;
        }
      };

      const userStore = window.__INITIAL_STATE__?.user;
      const hasUserStore = Boolean(userStore && typeof userStore === 'object');
      const rawNotes = hasUserStore ? (userStore.notes?._value || userStore.notes) : undefined;
      const rawPageData = hasUserStore ? (userStore.userPageData?._value || userStore.userPageData) : undefined;
      // \u767B\u5F55\u5899\u68C0\u6D4B\uFF1A\u5C0F\u7EA2\u4E66 profile \u9875\u6BD4 search \u66F4\u5403\u767B\u5F55\u6001\uFF0C\u4F1A\u8BDD\u5931\u6548/\u88AB\u98CE\u63A7\u964D\u7EA7\u65F6\u8BBF\u95EE
      // /user/profile/<id> \u4F1A 302 \u5230 /login\uFF08loggedIn=false\uFF09\u3002\u7528 indexOf \u800C\u975E\u6B63\u5219\u2014\u2014
      // \u672C\u5757\u662F\u5D4C\u5728\u6A21\u677F\u5B57\u7B26\u4E32\u91CC\u7684 JS\uFF0C\u6B63\u5219 \\b \u4F1A\u88AB\u6A21\u677F\u89E3\u6790\u6210\u9000\u683C\u7B26\u3002
      const loggedInVal = hasUserStore ? (userStore.loggedIn?._value ?? userStore.loggedIn) : undefined;
      const pathName = (typeof location !== 'undefined' && location.pathname) ? location.pathname : '';
      const onLoginPage = pathName.indexOf('/login') === 0;
      return {
        noteGroups: safeClone(rawNotes || []),
        pageData: safeClone(rawPageData || {}),
        storePresent: hasUserStore,
        notesPresent: Array.isArray(rawNotes),
        pageDataPresent: Boolean(rawPageData && typeof rawPageData === 'object' && Object.keys(rawPageData).length > 0),
        loginWall: Boolean(onLoginPage || loggedInVal === false),
      };
    })()
  `;
  async function readUserSnapshot(page) {
    return await page.evaluate(USER_SNAPSHOT_JS);
  }
  function assertReadableUserSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new CommandExecutionError("Malformed Xiaohongshu user snapshot");
    }
    if (snapshot.storePresent !== true) {
      throw new CommandExecutionError("Malformed Xiaohongshu user snapshot: user store was not found");
    }
    if (snapshot.notesPresent !== true || !Array.isArray(snapshot.noteGroups)) {
      throw new CommandExecutionError("Malformed Xiaohongshu user snapshot: notes array was not found");
    }
  }
  function countFlatNotes(snapshot) {
    const groups = snapshot?.noteGroups;
    if (!Array.isArray(groups))
      return 0;
    let n = 0;
    for (const g of groups)
      n += Array.isArray(g) ? g.length : g ? 1 : 0;
    return n;
  }
  function isLoginWallSnapshot(snapshot) {
    return Boolean(snapshot && typeof snapshot === "object" && snapshot.loginWall === true);
  }
  function throwLoginWallAuthRequired() {
    throw new AuthRequiredError("xiaohongshu.com", "Xiaohongshu profile requires login (page redirected to /login or session expired); re-login to xiaohongshu.com and retry.");
  }
  async function readUserSnapshotHydrated(page, maxRetries = 8, waitSeconds = 2) {
    let snapshot = await readUserSnapshot(page);
    for (let i = 0; i < maxRetries && !isLoginWallSnapshot(snapshot) && countFlatNotes(snapshot) === 0; i += 1) {
      await page.wait({ time: waitSeconds });
      snapshot = await readUserSnapshot(page);
    }
    return snapshot;
  }
  var command8 = cli({
    site: "xiaohongshu",
    name: "user",
    access: "read",
    description: "Get public notes from a Xiaohongshu user profile",
    domain: "www.xiaohongshu.com",
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
      { name: "id", type: "string", required: true, positional: true, help: "User id or profile URL" },
      { name: "limit", type: "int", default: 15, help: "Number of notes to return" }
    ],
    columns: ["id", "title", "type", "likes", "url"],
    func: async (page, kwargs) => {
      const userId = normalizeXhsUserId(String(kwargs.id));
      const limit = Math.max(1, Number(kwargs.limit ?? 15));
      await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);
      let snapshot = await readUserSnapshotHydrated(page);
      if (isLoginWallSnapshot(snapshot)) {
        throwLoginWallAuthRequired();
      }
      assertReadableUserSnapshot(snapshot);
      let results = extractXhsUserNotes(snapshot ?? {}, userId);
      let previousCount = results.length;
      for (let i = 0; results.length < limit && i < 4; i += 1) {
        await page.autoScroll({ times: 1, delayMs: 1500 });
        await page.wait(1);
        snapshot = await readUserSnapshot(page);
        if (isLoginWallSnapshot(snapshot)) {
          throwLoginWallAuthRequired();
        }
        assertReadableUserSnapshot(snapshot);
        const nextResults = extractXhsUserNotes(snapshot ?? {}, userId);
        if (nextResults.length <= previousCount)
          break;
        results = nextResults;
        previousCount = nextResults.length;
      }
      if (results.length === 0) {
        throw new EmptyResultError("xiaohongshu user", "\u8BE5\u7528\u6237\u6CA1\u6709\u516C\u5F00\u7B14\u8BB0\uFF08\u53EF\u80FD\u9500\u53F7 / \u79C1\u5BC6 / \u5168\u90E8\u5220\u9664\uFF09\u3002");
      }
      return results.slice(0, limit);
    }
  });

  // webcli/scripts/opencli-xiaohongshu/auth.js
  var home = "https://creator.xiaohongshu.com/new/home";
  async function identity(page) {
    if (new URL(location.href).hostname !== "creator.xiaohongshu.com") await page.goto(home);
    const data = await page.evaluate(`async () => {
    const r = await fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' });
    if (r.status === 401 || r.status === 403) return { auth: true };
    if (!r.ok) return { error: 'HTTP ' + r.status };
    return r.json();
  }`);
    if (data?.auth || /login|登录/i.test(data?.msg || "")) throw new AuthRequiredError("creator.xiaohongshu.com");
    if (data?.success === false) throw new CommandExecutionError("Creator identity API rejected the request");
    if (!data?.data || typeof data.data !== "object") throw new CommandExecutionError("Creator identity response missing data");
    return { logged_in: true, site: "xiaohongshu", username: data.data.name ?? "", followers: data.data.fans_count ?? null };
  }
  cli({ name: "whoami", access: "read", domain: "creator.xiaohongshu.com", description: "\u901A\u8FC7\u521B\u4F5C\u8005\u4E2D\u5FC3\u63A5\u53E3\u9A8C\u8BC1\u5F53\u524D\u767B\u5F55\u8D26\u53F7", args: [], func: identity });
  cli({ name: "login", access: "write", domain: "creator.xiaohongshu.com", description: "\u6253\u5F00\u521B\u4F5C\u8005\u4E2D\u5FC3\u767B\u5F55\u9875\uFF1B\u5B8C\u6210\u767B\u5F55\u540E\u8C03\u7528 whoami", args: [], func: async () => ({ __webcli_navigation: { version: 1, url: home, resume: false, result: { status: "login_required", message: "\u8BF7\u5728\u6D4F\u89C8\u5668\u5B8C\u6210\u767B\u5F55\uFF0C\u7136\u540E\u8C03\u7528 whoami \u9A8C\u8BC1\u3002" } } }) });
  return __toCommonJS(stdin_exports);
})();

window.__xhsOpenCLI = __xhsOpenCLI;
