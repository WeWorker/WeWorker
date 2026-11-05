/* v2 compatibility implementation for mail.qq.com; preserves the tracked legacy executable logic. */
(function () {
  var captured = [];
  var previousRegister = window.__webmcpRegister;
  window.__webmcpRegister = function (adapter) { captured.push(adapter || {}); };
  window.__webmcpGeneratedSupport = window.__webmcpGeneratedSupport || {};
  window.__webmcpGeneratedLegacyHandlers = window.__webmcpGeneratedLegacyHandlers || {};
  try {
/* embedded legacy source: index.js */
/**
 * QQ邮箱适配脚本
 *
 * 目标站点：https://wx.mail.qq.com/
 * 旧版经典页 https://mail.qq.com/cgi-bin/frame_html 仍保留兼容。
 *
 * 注意：运行在 isolated world，只能操作 DOM，不能访问页面 JS 变量。
 * 新版是 wx.mail.qq.com/home/index 单页；经典版主内容在 #mainFrame 内。
 *
 * 验证版本：QQ邮箱网页版 2026年11月（wx.mail.qq.com）
 * 维护者：WeWorker 项目
 */

// ─── 配置 ───────────────────────────────────────────────────────────────────

const HOME_URL = "https://wx.mail.qq.com/";
const CLASSIC_HOME_URL = "https://mail.qq.com/";

function isQqMailHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "wx.mail.qq.com" || host === "mail.qq.com" || host.endsWith(".mail.qq.com");
}

/** 新版网页邮箱（wx.mail.qq.com/home/index），与经典版 iframe 页面区分。 */
function isModernQqMail() {
  return !!document.querySelector(".xmail-page-root, .mail-list-page, .mail-list-page-reader");
}

function qqMailInboxUrl() {
  const url = new URL(HOME_URL);
  url.pathname = "/home/index";
  const sid = new URLSearchParams(window.location.search).get("sid") || "";
  if (sid) url.searchParams.set("sid", sid);
  url.hash = "/list/1";
  return url.toString();
}

function textOf(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

/** 新版列表常只显示「10:24」「今天」「Yesterday」，月份筛选需要落成时间戳。 */
function modernListTimestamp(dateText, groupText) {
  const now = new Date();
  const source = `${dateText || ""} ${groupText || ""}`;
  if (/今天|Today/i.test(source) || /^\d{1,2}:\d{2}$/.test(String(dateText || "").trim())) {
    return now.getTime();
  }
  if (/昨天|Yesterday/i.test(source)) {
    return now.getTime() - 24 * 60 * 60 * 1000;
  }
  return null;
}

function parseModernEmailList() {
  const emails = [];
  const seen = new Set();
  const items = document.querySelectorAll(".mail-list-page-item, .mail-list-search-item");
  for (const item of items) {
    let groupText = "";
    let prev = item.previousElementSibling;
    while (prev) {
      if (prev.classList?.contains("mail-list-page-group-title")) {
        groupText = textOf(prev);
        break;
      }
      prev = prev.previousElementSibling;
    }
    const subject = textOf(item.querySelector(".mail-text")) || textOf(item.querySelector(".mail-subject"));
    const sender = textOf(item.querySelector(".cmp-account-nick")) || textOf(item.querySelector(".mail-sender"));
    const date = textOf(item.querySelector(".mail-time"));
    const id = item.getAttribute("data-mailid") || subject.slice(0, 50);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (!subject && !id) continue;
    emails.push({
      id,
      sender,
      subject,
      date: groupText ? `${groupText} ${date}`.trim() : date,
      timestampMs: modernListTimestamp(date, groupText),
      previewText: textOf(item.querySelector(".mail-digest")),
      isUnread: !!item.querySelector(".mail-unread"),
      hasAttachment: !!item.querySelector(".mail-attach"),
      summary: textOf(item.querySelector(".mail-digest")),
    });
  }
  return emails;
}

function parseModernEmailDetail() {
  const subject = textOf(document.querySelector(".mail-detail-subject .mail-subject-text, .mail-subject-text"));
  if (!subject) return { error: "邮件详情区域未找到" };
  const fromName = textOf(document.querySelector(".mail-detail-basic .cmp-account-nick"));
  const fromEmail = textOf(document.querySelector(".mail-detail-basic .cmp-account-email"));
  const attachments = [];
  for (const card of document.querySelectorAll(".mail-detail-attach-card")) {
    const name = `${textOf(card.querySelector(".attach-name"))}${textOf(card.querySelector(".attach-suffix"))}`.trim();
    const size = textOf(card.querySelector(".attach-size-num"));
    if (name) attachments.push({ name, size });
  }
  return {
    subject,
    from: fromEmail ? `${fromName} ${fromEmail}`.trim() : fromName,
    to: "",
    date: textOf(document.querySelector(".mail-detail-basic .time-text")),
    body: textOf(document.querySelector(".mail-detail-content")).substring(0, 5000),
    attachments,
    hasAttachment: attachments.length > 0,
  };
}

function collectModernAttachmentCards() {
  return [...document.querySelectorAll(".mail-detail-attach-card")].map((card) => {
    const name = `${textOf(card.querySelector(".attach-name"))}${textOf(card.querySelector(".attach-suffix"))}`.trim();
    const lastDot = name.lastIndexOf(".");
    return {
      name,
      baseName: lastDot > 0 ? name.slice(0, lastDot) : name,
      ext: lastDot > 0 ? name.slice(lastDot).toLowerCase() : "",
      card,
    };
  }).filter((att) => att.name);
}

function clickModernDownload(card) {
  card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const buttons = [...card.querySelectorAll(".desc-btn")];
  const labeled = buttons.find((btn) => /下载|download/i.test(`${textOf(btn)} ${btn.getAttribute("title") || ""}`));
  (labeled || buttons[0] || card).click();
}

/**
 * 新版附件卡片下载。没有卡片时返回 null，交给经典版或正文链接逻辑。
 * @param {"all"|"smart"|string} attachmentName
 */
async function downloadModernAttachmentCards(attachmentName) {
  const attachments = collectModernAttachmentCards();
  if (!attachments.length) return null;

  const pickPreferred = (group) => {
    const pdf = group.find((att) => att.ext === ".pdf");
    if (pdf) return pdf;
    const archiveExts = [".zip", ".rar", ".7z", ".tar", ".gz"];
    return group.find((att) => archiveExts.includes(att.ext)) || group[0];
  };

  if (attachmentName !== "all" && attachmentName !== "smart") {
    const found = attachments.find((att) => att.name === attachmentName);
    if (!found) {
      return {
        error: "Attachment not found",
        attachmentName,
        availableAttachments: attachments.map((att) => att.name),
        message: `未找到名为"${attachmentName}"的附件`,
      };
    }
    clickModernDownload(found.card);
    return {
      status: "downloading",
      attachmentName,
      message: `已触发下载附件: ${attachmentName}`,
    };
  }

  const groups = new Map();
  for (const att of attachments) {
    if (!groups.has(att.baseName)) groups.set(att.baseName, []);
    groups.get(att.baseName).push(att);
  }
  const selected = [...groups.values()].map(pickPreferred);
  if (attachmentName === "smart") {
    const pdf = selected.find((att) => att.ext === ".pdf");
    const chosen = pdf || selected[0];
    clickModernDownload(chosen.card);
    return {
      status: "downloading",
      type: chosen.ext === ".pdf" ? "pdf" : ".zip.rar.7z".includes(chosen.ext) ? "archive" : "other",
      filename: chosen.name,
      message: `已触发下载: ${chosen.name}`,
    };
  }

  const downloaded = [];
  for (const att of selected) {
    clickModernDownload(att.card);
    downloaded.push(att.name);
    await sleep(1000);
  }
  const skippedCount = attachments.length - downloaded.length;
  return {
    status: "downloading",
    attachmentName: "all",
    message: `已触发下载 ${downloaded.length} 个附件${skippedCount > 0 ? `（跳过了 ${skippedCount} 个重复格式的文件，优先下载PDF）` : ""}。提示：如浏览器询问是否允许多个下载，请点击"允许"并勾选"记住选择"`,
    downloaded,
    totalAttachments: attachments.length,
    skipped: skippedCount,
  };
}

async function navigateModernInbox() {
  const currentUrl = window.location.href;
  const inbox = document.querySelector('[data-sidebar-dir-id="1"]');
  if (inbox) {
    inbox.click();
    await sleep(1500);
    return {
      status: "success",
      message: "已返回收件箱首页",
      previousUrl: currentUrl,
      currentUrl: window.location.href,
    };
  }
  if ((window.location.hash || "").startsWith("#/list/1") && document.querySelector(".mail-list-page")) {
    return {
      status: "success",
      message: "当前已在收件箱",
      previousUrl: currentUrl,
      currentUrl: window.location.href,
    };
  }
  return null;
}

async function searchModernEmails(keyword) {
  const q = keyword != null && String(keyword).trim() !== "" ? String(keyword).trim() : "发票";
  const wrap = document.querySelector(".mail-lazy-search-wrap");
  if (!wrap) {
    return { error: "search_input_not_found", message: "未找到搜索框，请确保在QQ邮箱页面", keyword: q };
  }
  wrap.click();
  let input = null;
  try {
    input = await waitForElement("input.filter-input, .mail-search-keyword-wrap input", 3000, document);
  } catch (e) {}
  if (!input) {
    return { error: "search_input_not_found", message: "未找到搜索框，请确保在QQ邮箱页面", keyword: q };
  }
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, q);
  else input.value = q;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(400);
  const suggestion = [...document.querySelectorAll(".mail-lazy-search-wrap li, [class*='suggest'] li, [class*='search'] [role='option']")]
    .find((option) => {
      const text = textOf(option);
      return text.includes(q) && /邮件|mail/i.test(text);
    });
  if (suggestion) {
    suggestion.click();
  } else {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
  await sleep(2500);
  const emails = parseModernEmailList();
  return { keyword: q, count: emails.length, emails };
}

async function openModernEmail(emailId) {
  const items = document.querySelectorAll(".mail-list-page-item, .mail-list-search-item");
  let target = null;
  let subjectInList = "";
  for (const item of items) {
    const id = item.getAttribute("data-mailid") || "";
    const subject = textOf(item.querySelector(".mail-text")) || textOf(item.querySelector(".mail-subject"));
    if (id === emailId || (subject && emailId && subject.includes(emailId))) {
      target = item;
      subjectInList = subject;
      break;
    }
  }
  if (!target) {
    return { error: "Email not found", emailId, message: "指定的邮件不存在，可能已被删除或 ID 不正确" };
  }
  (target.querySelector(".mail-subject") || target).click();
  let detail = null;
  let attempts = 0;
  while (attempts < 15) {
    await sleep(500);
    attempts++;
    const temp = parseModernEmailDetail();
    if (!temp.error && temp.subject && (!subjectInList || temp.subject.includes(subjectInList) || subjectInList.includes(temp.subject))) {
      detail = temp;
      break;
    }
  }
  if (!detail) detail = parseModernEmailDetail();
  if (detail.error) {
    return { status: "clicked", emailId, warning: detail.error, message: "邮件已点击，但无法解析详情内容" };
  }
  return { status: "opened", emailId, detail, loadTime: `${attempts * 500}ms` };
}

/** 登录后页面特征（顶栏 + 左侧文件夹 + mainFrame） */
const LOGIN_SELECTORS = [
  "#mainFrame",
  "#SysFolderList",
  "a#folder_1",
  "#smartSearch",
  "#subject",
  ".mainArea",
  ".toolbar",
];

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 等待某个选择器出现在 DOM 中
 * @param {string} selector
 * @param {number} timeout 毫秒
 * @param {Document} [doc=document] 查找的文档对象
 */
function waitForElement(selector, timeout = 5000, doc = document) {
  return new Promise((resolve, reject) => {
    const el = doc.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = doc.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for element: ${selector}`));
    }, timeout);
  });
}

/**
 * 等待一段时间
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 工具执行前的基础缓冲时间（毫秒），用于吸收注入/通信抖动 */
const TOOL_WARMUP_DELAY_MS = 1200;
/** 工具执行前等待主内容就绪的最长时间（毫秒） */
const TOOL_READY_TIMEOUT_MS = 5000;

/**
 * 等待页面可交互：document complete + 主文档 body 可用
 * @param {number} timeout
 * @returns {Promise<void>}
 */
async function waitForPageReady(timeout = TOOL_READY_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const pageReady =
      document.readyState === "interactive" || document.readyState === "complete";
    const { doc } = getMainDocument();
    if (pageReady && doc && doc.body) return;
    await sleep(200);
  }
}

/**
 * 为所有工具添加统一的执行前等待，减少页面未加载完成导致的瞬时失败
 * @param {Function} fn
 * @returns {Function}
 */
function withToolWarmup(fn) {
  return async (args = {}) => {
    await sleep(TOOL_WARMUP_DELAY_MS);
    await waitForPageReady();
    return fn(args);
  };
}

/**
 * 设置 input 的值并触发框架需要的事件
 */
function setInputValue(input, value) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  return el.getClientRects().length > 0;
}

function detectLoggedIn() {
  if (isModernQqMail()) {
    return { logged_in: true, matched_selector: ".xmail-page-root" };
  }
  if (isQqMailHost(window.location.hostname) && /登录|Log in/i.test(document.title || "")) {
    return { logged_in: false, matched_selector: null };
  }
  if (document.querySelector("#login, #qlogin")) {
    return { logged_in: false, matched_selector: null };
  }
  for (const selector of LOGIN_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && isElementVisible(el)) {
      return { logged_in: true, matched_selector: selector };
    }
  }
  const { doc } = getMainDocument();
  if (
    doc &&
    doc.querySelector('[id^="div_show"], table.i.M, table.i.F, .mail_list_container')
  ) {
    return { logged_in: true, matched_selector: "mainFrame_content" };
  }
  return { logged_in: false, matched_selector: null };
}

// ─── Tool Handler 函数 ────────────────────────────────────────────────────

/**
 * 获取主内容文档（QQ 邮箱经典版主内容在 mainFrame 内）
 * @returns {{ doc: Document, inFrame: boolean }} doc 为可用的 document
 */
function getMainDocument() {
  const frame = document.querySelector("#mainFrame");
  if (frame) {
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (doc && doc.body) {
        return { doc, inFrame: true };
      }
    } catch (e) {}
  }
  return { doc: document, inFrame: false };
}

/**
 * 解析当前邮件列表，返回结构化数据
 *
 * QQ 邮箱经典版 DOM 结构（2026年3月验证）：
 * - 列表按时间分块：#div_showSunday（星期分组）/ #div_showyesterday / #div_showlastweek / #div_showbefore 等，须合并解析；不能只列固定几项，否则会漏「星期日」等分组
 * - 每封邮件是外层 table.i.M 或 table.i.F（未读），勿用 table.i 以免命中内层嵌套表格
 * - 邮件ID：input[name="mailid"] 的 value；totime 为毫秒时间戳，可用于月份筛选
 * - 发件人：.tl.tf nobr span[n="发件人名称"] 或 .tl.tf nobr span 的 textContent
 * - 主题：.gt.sall .tt 的 textContent
 * - 日期：.dt div 的 textContent
 * - 未读：.unread 类或 b 标签
 * - 附件：.cij.Ju 类（有 Ju 表示有附件）
 */
function parseEmailList() {
  if (isModernQqMail()) return parseModernEmailList();
  const emails = [];
  const { doc } = getMainDocument();
  if (!doc || !doc.body) return emails;

  // QQ 邮箱列表按时间分组：id 形如 div_showSunday / div_showlastweek / div_showbefore / div_showtoday …
  // 若只写死少数几个 id，会漏掉「星期日」等分组（例如 4月5日邮件在 #div_showSunday）
  const seenIds = new Set();
  /** @type {Element[]} */
  let mailTables = [];
  const listSections = doc.querySelectorAll('[id^="div_show"]');
  for (const section of listSections) {
    mailTables.push(
      ...section.querySelectorAll("table.i.M, table.i.F")
    );
  }
  if (mailTables.length === 0) {
    const mailListContainer =
      doc.querySelector(".mail_list_container") ||
      doc.querySelector("#mail_list") ||
      doc.body;
    mailTables = Array.from(
      mailListContainer.querySelectorAll("table.i.M, table.i.F")
    );
  }

  for (const table of mailTables) {
    try {
      // 邮件ID：input[name="mailid"] 的 value
      const mailIdInput = table.querySelector('input[name="mailid"]');
      const id = mailIdInput?.value || "";
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);

      const totimeAttr = mailIdInput?.getAttribute("totime");
      const timestampMs =
        totimeAttr && /^\d+$/.test(totimeAttr)
          ? parseInt(totimeAttr, 10)
          : null;

      // 发件人：.tl.tf nobr span[n="xxx"] 或 .tl.tf nobr span
      const senderSpan = table.querySelector(".tl.tf nobr span[n]");
      const sender =
        senderSpan?.getAttribute("n") ||
        senderSpan?.textContent?.trim() ||
        table.querySelector(".tl.tf nobr")?.textContent?.trim() ||
        "";

      // 主题：.gt.sall .tt 或 .gt .tt
      const subjectU = table.querySelector(".gt.sall .tt, .gt .tt");
      const subject = subjectU?.textContent?.trim() || "";

      // 摘要行（第二行），含「于2026年3月29日」等，用于月份判断
      const previewU = table.querySelector(
        ".gt.tf.no.sall.ab, .gt.tf.sall.ab, tr .gt.tf.sall.ab"
      );
      const previewText = previewU?.textContent?.trim() || "";

      // 日期：.dt div
      const dateDiv = table.querySelector(".dt div");
      const date = dateDiv?.textContent?.trim() || "";

      // 未读状态：检查是否有 .unread 类或 b 标签
      const isUnread =
        table.classList?.contains("unread") ||
        !!table.querySelector("b, .unread, [class*='unread']");

      // 附件：.cij.Ju 类（有 Ju 表示有附件）
      const hasAttachment =
        !!table.querySelector(".cij.Ju, .ico_attach, [class*='attach']");

      if (subject || id) {
        emails.push({
          id: id || subject.slice(0, 50),
          sender,
          subject,
          date,
          timestampMs,
          previewText,
          isUnread,
          hasAttachment,
          summary: "",
        });
      }
    } catch (e) {
      // 忽略解析错误的邮件
      console.error("[QQMail] Error parsing email row:", e);
    }
  }

  // 如果没找到任何邮件，尝试备用选择器（兼容旧版本）
  if (emails.length === 0) {
    return parseEmailListLegacy(doc);
  }

  return emails;
}

/**
 * 备用解析函数（兼容旧版QQ邮箱DOM结构）
 */
function parseEmailListLegacy(doc) {
  const emails = [];
  const rowSelectors = [
    "#div_showbefore table tbody tr",
    ".maillist tbody tr",
    "table tbody tr",
  ];
  let rows = [];
  for (const sel of rowSelectors) {
    rows = Array.from(doc.querySelectorAll(sel));
    if (rows.length > 0) break;
  }
  if (rows.length === 0) {
    rows = Array.from(doc.querySelectorAll("table tr")).filter(
      (tr) => tr.querySelectorAll("td").length >= 3
    );
  }

  for (const row of rows) {
    const tds = row.querySelectorAll("td");
    if (tds.length < 3) continue;

    const id = row.id || row.getAttribute("data-id") || "";
    const sender = tds[1]?.textContent?.trim() ?? "";
    const subject = tds[2]?.textContent?.trim() ?? "";
    const date =
      tds[tds.length - 1]?.getAttribute("title") ??
      tds[tds.length - 1]?.textContent?.trim() ??
      "";
    const isUnread =
      row.classList?.contains?.("unread") ||
      !!row.querySelector("b, .unread, [class*='unread']");
    const hasAttachment = !!row.querySelector(
      ".ico_attach, [class*='attach'], .attach"
    );

    if (subject) {
      emails.push({
        id: id || subject.slice(0, 50),
        sender,
        subject,
        date,
        isUnread,
        hasAttachment,
        summary: "",
      });
    }
  }
  return emails;
}

/**
 * 搜索邮件
 *
 * 搜索框 DOM（QQ 邮箱经典版）：.search_subject > #smartSearch.smartsearch > input#subject.searchinput[aria-label="搜索"]
 * 输入关键词后出现下拉建议，优先点击「包含'关键词'的邮件」选项。
 *
 * @param {string} [keyword] - 搜索关键词，省略或空字符串时默认为「发票」
 * @returns {Promise<Object>} 搜索结果
 */
async function searchEmails(keyword) {
  if (isModernQqMail()) return searchModernEmails(keyword);
  const q = (keyword != null && String(keyword).trim() !== "")
    ? String(keyword).trim()
    : "发票";
  // 搜索框通常在顶层页面（导航栏），先在 document 找，再在 mainFrame 找
  const searchSelectors = [
    "#subject",
    "input.searchinput[aria-label='搜索']",
    "input[name='subject'].searchinput",
    "#smartSearch input.searchinput",
    ".smartsearch input[type='text']",
    "input[aria-label='搜索']",
    ".search_subject input.searchinput",
  ];
  let searchInput = null;
  for (const sel of searchSelectors) {
    try {
      searchInput = document.querySelector(sel);
      if (searchInput) break;
    } catch (e) {}
  }
  if (!searchInput) {
    const { doc } = getMainDocument();
    for (const sel of searchSelectors) {
      try {
        searchInput = doc.querySelector(sel);
        if (searchInput) break;
      } catch (e) {}
    }
  }
  if (!searchInput) {
    try {
      searchInput = await waitForElement(
        "#subject, input.searchinput[aria-label='搜索'], .smartsearch input",
        3000,
        document
      );
    } catch (e) {}
  }
  if (!searchInput) {
    return {
      error: "search_input_not_found",
      message: "未找到搜索框，请确保在QQ邮箱页面",
      keyword: q,
    };
  }

  searchInput.focus();
  searchInput.value = "";
  searchInput.style.color = "";
  await sleep(100);
  setInputValue(searchInput, q);
  await sleep(600);

  // 下拉建议：优先点击「包含'关键词'的邮件」
  const rootsToSearch = [document];
  const { doc } = getMainDocument();
  if (doc && doc !== document) rootsToSearch.push(doc);
  let clickedMailOption = false;
  for (const root of rootsToSearch) {
    const suggestOptions = root.querySelectorAll(
      ".smartsearch li, #smartSearch li, .search_suggest li, [class*='suggest'] li, .ssm li, .search_dropdown li, [class*='smartsearch'] li"
    );
    for (const option of suggestOptions) {
      const text = (option.textContent || "").trim();
      if (text.includes("邮件") && text.includes(q)) {
        option.click();
        clickedMailOption = true;
        break;
      }
    }
    if (clickedMailOption) break;
  }
  if (!clickedMailOption) {
    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true })
    );
    searchInput.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true })
    );
  }

  await sleep(3000);
  const emails = parseEmailList();
  return { keyword: q, count: emails.length, emails };
}

/**
 * 获取未读邮件列表
 * @param {number} limit - 最多返回的邮件数量，默认20
 * @returns {Promise<Object>} 未读邮件列表
 */
async function getUnreadEmails(limit = 20) {
  try {
    if (isModernQqMail()) {
      await navigateModernInbox();
      const unread = parseModernEmailList()
        .filter((email) => email.isUnread)
        .slice(0, limit)
        .map(({ id, sender, subject, date }) => ({ id, sender, subject, date }));
      return { count: unread.length, emails: unread };
    }
    const { doc } = getMainDocument();
    const inboxLink =
      doc.querySelector(
        '[title="收件箱"], [class*="inbox"], a[href*="inbox"]'
      ) ||
      document.querySelector(
        '[title="收件箱"], [class*="inbox"], a[href*="inbox"]'
      );
    if (inboxLink) {
      inboxLink.click();
      await sleep(1500);
    }

    const unread = parseEmailList()
      .filter((email) => email.isUnread)
      .slice(0, limit)
      .map(({ id, sender, subject, date }) => ({
        id,
        sender,
        subject,
        date,
      }));

    return { count: unread.length, emails: unread };
  } catch (err) {
    return {
      error: "get_unread_emails_failed",
      message: err?.message || String(err),
      count: 0,
      emails: [],
    };
  }
}

/**
 * 打开指定邮件
 * @param {string} emailId - 邮件的唯一ID 或主题片段
 * @returns {Promise<Object>} 邮件详情
 */
async function openEmail(emailId) {
  try {
    if (isModernQqMail()) return openModernEmail(emailId);
    const { doc } = getMainDocument();
    let mailElement = null;
    let subjectInList = "";

    // 首先尝试通过 input[name="mailid"] 的 value 查找（新版DOM结构）
    const mailTables = doc.querySelectorAll("table.i.M, table.i");
    for (const table of mailTables) {
      const mailIdInput = table.querySelector('input[name="mailid"]');
      const id = mailIdInput?.value || "";
      const subjectU = table.querySelector(".gt.sall .tt, .gt .tt");
      const subject = subjectU?.textContent?.trim() || "";

      if (id === emailId || (subject && subject.includes(emailId))) {
        mailElement = table;
        subjectInList = subject;
        break;
      }
    }

    // 如果没找到，尝试旧版DOM结构
    if (!mailElement) {
      mailElement =
        doc.getElementById(emailId) || doc.querySelector(`[data-id="${emailId}"]`);
    }

    if (!mailElement) {
      const rowSelectors = [
        "#div_showbefore table tbody tr",
        ".maillist tbody tr",
        "#mail_list_container tr",
        "table tbody tr",
      ];
      for (const sel of rowSelectors) {
        const rows = doc.querySelectorAll(sel);
        for (const row of rows) {
          const id = row.id || row.getAttribute("data-id");
          const tds = row.querySelectorAll("td");
          const subject = tds[2]?.textContent?.trim() ?? "";
          if (
            id === emailId ||
            (subject && subject.includes(emailId))
          ) {
            mailElement = row;
            subjectInList = subject;
            break;
          }
        }
        if (mailElement) break;
      }
    }

    if (!mailElement) {
      return {
        error: "Email not found",
        emailId,
        message: "指定的邮件不存在，可能已被删除或 ID 不正确",
      };
    }

    // 点击主题区域打开邮件
    // 优先点击 .gt.sall（主题区域）或带有 onclick 的 td.l
    const clickTarget =
      mailElement.querySelector(".gt.sall") ||
      mailElement.querySelector("td.l") ||
      mailElement.querySelector(".tt") ||
      mailElement;

    clickTarget.click();

    await sleep(1000);
    let detail = null;
    let attempts = 0;
    const maxAttempts = 15;

    while (attempts < maxAttempts) {
      await sleep(500);
      attempts++;
      const tempDetail = parseEmailDetail();
      if (!tempDetail.error && tempDetail.subject) {
        if (
          !subjectInList ||
          tempDetail.subject.includes(subjectInList) ||
          subjectInList.includes(tempDetail.subject)
        ) {
          detail = tempDetail;
          break;
        }
      }
    }

    if (!detail) detail = parseEmailDetail();

    if (detail.error) {
      return {
        status: "clicked",
        emailId,
        warning: detail.error,
        message: "邮件已点击，但无法解析详情内容",
      };
    }

    return {
      status: "opened",
      emailId,
      detail,
      loadTime: `${attempts * 500}ms`,
    };
  } catch (error) {
    return {
      error: "Failed to open email",
      emailId,
      message: error.message,
    };
  }
}

/**
 * 下载当前打开邮件的附件
 *
 * 附件 DOM（QQ 邮箱）：附件区域含 .att_bt.attachitem 每项含 .name_big > span（文件名）、.down_big > a[title*="请直接点击"]（下载按钮）；
 * 多附件时有 a.ico_down「全部下载」或 onclick 包含 packageNormal 的链接。
 *
 * 对于无附件但有下载链接的发票（如诺诺网、国家电网），会尝试点击邮件正文中的下载链接。
 *
 * @param {string} attachmentName - 附件名称或 'all' 表示打包下载所有附件
 * @returns {Promise<Object>} 下载结果
 */
async function downloadAttachment(attachmentName) {
  try {
    const modernResult = await downloadModernAttachmentCards(attachmentName);
    if (modernResult) return modernResult;
    const { doc } = getMainDocument();
    const readArea = doc.querySelector(
      '.mail-detail-content, [class*="readmail"], [class*="mail-detail"], #readmail, #mainContent, .readmail_content'
    );

    // 尝试多种方式查找附件区域
    let attArea =
      doc.querySelector("#attachment") ||
      doc.querySelector(".attbg") ||
      (readArea && readArea.querySelector("#attachment")) ||
      readArea;

    // 如果没找到附件区域，尝试查找包含附件项的容器
    if (!attArea || !attArea.querySelector(".att_bt.attachitem")) {
      const attItems = doc.querySelectorAll(".att_bt.attachitem");
      if (attItems.length > 0) {
        attArea = attItems[0].parentElement;
      }
    }

    // 再次检查附件项
    const attItems = attArea ? attArea.querySelectorAll(".att_bt.attachitem") : [];

    // ===== 处理传统附件 =====
    if (attItems.length > 0) {
      if (attachmentName === "all") {
        // 收集所有附件信息
        const attachments = [];
        for (const item of attItems) {
          const nameSpan = item.querySelector(".name_big > span");
          const name = nameSpan?.textContent?.trim() ?? "";
          const downloadLink = item.querySelector(
            '.down_big a[title*="请直接点击"]'
          );
          if (name && downloadLink) {
            // 提取文件名（不含扩展名）和扩展名
            const lastDotIndex = name.lastIndexOf('.');
            const baseName = lastDotIndex > 0 ? name.substring(0, lastDotIndex) : name;
            const ext = lastDotIndex > 0 ? name.substring(lastDotIndex).toLowerCase() : '';
            attachments.push({ name, baseName, ext, downloadLink });
          }
        }

        // 按基础文件名分组，优先选择PDF
        const baseNameGroups = new Map();
        for (const att of attachments) {
          if (!baseNameGroups.has(att.baseName)) {
            baseNameGroups.set(att.baseName, []);
          }
          baseNameGroups.get(att.baseName).push(att);
        }

        // 为每个基础文件名选择最佳附件（PDF优先）
        const toDownload = [];
        for (const [baseName, group] of baseNameGroups) {
          // 优先选择PDF
          const pdfAtt = group.find(att => att.ext === '.pdf');
          if (pdfAtt) {
            toDownload.push(pdfAtt);
          } else {
            // 如果没有PDF，选择第一个
            toDownload.push(group[0]);
          }
        }

        // 执行下载
        const downloaded = [];
        for (const att of toDownload) {
          att.downloadLink.click();
          downloaded.push(att.name);
          // 增加间隔时间，降低浏览器弹窗概率
          await sleep(1000);
        }

        const skippedCount = attachments.length - downloaded.length;
        return {
          status: "downloading",
          attachmentName: "all",
          message: `已触发下载 ${downloaded.length} 个附件${skippedCount > 0 ? `（跳过了 ${skippedCount} 个重复格式的文件，优先下载PDF）` : ''}。提示：如浏览器询问是否允许多个下载，请点击"允许"并勾选"记住选择"`,
          downloaded,
          totalAttachments: attachments.length,
          skipped: skippedCount,
        };
      }

      for (const item of attItems) {
        const nameSpan = item.querySelector(".name_big > span");
        const name = nameSpan?.textContent?.trim() ?? "";
        if (name === attachmentName) {
          const downloadLink = item.querySelector(
            '.down_big a[title*="请直接点击"]'
          );
          if (!downloadLink) {
            return {
              error: "Download link not found",
              attachmentName,
              message: "找到了附件但未找到下载链接",
            };
          }
          downloadLink.click();
          return {
            status: "downloading",
            attachmentName,
            message: `已触发下载附件: ${attachmentName}`,
          };
        }
      }

      const availableAttachments = Array.from(attItems)
        .map((item) =>
          item.querySelector(".name_big > span")?.textContent?.trim()
        )
        .filter(Boolean);
      return {
        error: "Attachment not found",
        attachmentName,
        availableAttachments,
        message: `未找到名为"${attachmentName}"的附件`,
      };
    }

    // ===== 没有传统附件，尝试查找邮件正文中的下载链接 =====
    // 获取邮件正文的 iframe
    let emailBody = null;
    const iframe = doc.querySelector(
      'iframe[id*="body"], iframe.content, iframe'
    );
    if (iframe) {
      try {
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        emailBody = iframeDoc?.body;
      } catch (e) {
        console.log("[QQMail] Cannot access iframe content:", e.message);
      }
    }

    // 如果没找到 iframe，使用 readArea
    if (!emailBody && readArea) {
      emailBody = readArea;
    }

    if (emailBody) {
      const allLinks = emailBody.querySelectorAll("a");
      const downloadLinks = [];

      for (const link of allLinks) {
        const text = link.textContent?.trim() ?? "";
        const href = link.href ?? "";
        const title = link.title ?? "";

        // 识别下载链接的关键词
        const isDownloadLink =
          text.includes("PDF文件下载") ||
          text.includes("pdf文件下载") ||
          text.includes("发票PDF") ||
          text.includes("下载发票") ||
          text.includes("查看发票") ||
          text === "下载" ||
          text.includes("下载附件") ||
          title.includes("下载") ||
          href.includes("download");

        if (isDownloadLink && href) {
          downloadLinks.push({
            text,
            href,
            isPdf: text.toLowerCase().includes("pdf"),
            element: link,
          });
        }
      }

      if (downloadLinks.length > 0) {
        // 优先选择 PDF 下载链接
        const pdfLink = downloadLinks.find((l) => l.isPdf);
        const linkToClick = pdfLink || downloadLinks[0];

        // 检查是否是诺诺网发票链接
        const isNuonuoLink = linkToClick.href.includes("nnfp.jss.com.cn");

        if (isNuonuoLink) {
          // 诺诺网链接：使用 window.open 打开，设置窗口名称以便返回
          try {
            const newWindow = window.open(linkToClick.href, "nuonuo_invoice_window");
            if (newWindow) {
              return {
                status: "opened_in_new_tab",
                type: "nuonuo_invoice",
                linkText: linkToClick.text,
                href: linkToClick.href,
                message: `已在新标签页打开诺诺网发票页面: ${linkToClick.text}。请在新页面下载后调用 nnfp.jss.com.cn.download_invoice`,
                nextStep: "请在诺诺网页面使用 nnfp.jss.com.cn.download_invoice 下载发票",
              };
            }
          } catch (e) {
            console.log("[QQMail] window.open failed:", e.message);
          }
        }

        // 普通链接：直接点击
        linkToClick.element.click();
        return {
          status: "downloading",
          type: "link",
          linkText: linkToClick.text,
          href: linkToClick.href,
          message: `已点击下载链接: ${linkToClick.text}`,
        };
      }
    }

    // 最后的备选：在整个文档中查找
    const allLinks = doc.querySelectorAll("a");
    for (const link of allLinks) {
      const text = link.textContent?.trim() ?? "";
      const href = link.href ?? "";
      const title = link.title ?? "";
      if (
        text === "下载" ||
        text.includes("下载附件") ||
        text.includes("下载发票") ||
        text.includes("查看发票") ||
        text.includes("PDF文件下载") ||
        title.includes("下载") ||
        href.includes("download")
      ) {
        link.click();
        return {
          status: "downloading",
          type: "link",
          linkText: text || title,
          message: `已点击下载链接: ${text || title}`,
        };
      }
    }

    return {
      error: "No attachments",
      message: "当前邮件没有附件或下载链接",
    };
  } catch (error) {
    return {
      error: "Failed to download attachment",
      attachmentName,
      message: error.message,
    };
  }
}

/**
 * 解析打开后的邮件详情
 *
 * QQ 邮箱经典版 DOM：邮件详情区含主题/发件人/正文；附件区 #attachment.attbg，每项 .att_bt.attachitem，文件名在 .name_big > span，大小在 .graytext（如 115.91K）。
 */
function parseEmailDetail() {
  try {
    if (document.querySelector(".mail-detail-subject, .mail-list-page-reader")) {
      return parseModernEmailDetail();
    }
    const { doc } = getMainDocument();
    const readArea = doc.querySelector(
      '.mail-detail-content, [class*="readmail"], [class*="mail-detail"], #readmail, #mainContent, .readmail_content'
    );
    const attArea =
      doc.querySelector("#attachment") ||
      (readArea && readArea.querySelector("#attachment")) ||
      readArea;
    if (!readArea) {
      return { error: "邮件详情区域未找到" };
    }

    const subjectSelectors = [
      "h1",
      ".subject",
      "[class*='subject']",
      ".title",
      "td font b",
      "b.subject",
    ];
    let subject = "";
    for (const sel of subjectSelectors) {
      const el = readArea.querySelector(sel);
      if (el?.textContent?.trim()) {
        subject = el.textContent.trim();
        break;
      }
    }
    if (!subject) {
      return { error: "邮件主题为空，内容可能还在加载中" };
    }

    const fullText = readArea.textContent;
    const fromMatch = fullText.match(/发件人[：:]\s*([^收]+?)(?=收件人|$)/s);
    let from = fromMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "";
    const toMatch = fullText.match(/收件人[：:]\s*([^时]+?)(?=时\s*间|$)/s);
    let to = toMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "";
    const dateMatch = fullText.match(/时\s*间[：:]\s*([^\n附]+?)(?=附\s*件|$)/s);
    const date = dateMatch?.[1]?.trim() ?? "";

    let body = "";
    try {
      const iframe = readArea.querySelector(
        'iframe[id*="body"], iframe.content, iframe'
      );
      if (iframe) {
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        const contentEl =
          iframeDoc?.getElementById("content") ||
          iframeDoc?.querySelector(".content") ||
          iframeDoc?.body;
        body = contentEl?.textContent?.trim() ?? "";
      } else {
        const bodyEl = readArea.querySelector(
          ".body, .content, [class*='mailbody']"
        );
        body = bodyEl?.textContent?.trim() ?? "";
      }
    } catch (e) {
      body = `[无法读取邮件正文: ${e.message}]`;
    }

    const attachments = [];
    // 尝试多种方式查找附件项
    let attList = [];
    if (attArea) {
      attList = attArea.querySelectorAll(".att_bt.attachitem");
    }
    // 如果没找到，在整个文档中查找
    if (!attList || attList.length === 0) {
      attList = doc.querySelectorAll(".att_bt.attachitem");
    }
    for (const attItem of attList) {
      const nameSpan = attItem.querySelector(".name_big > span");
      const name = nameSpan?.textContent?.trim() ?? "";
      const graySpan = attItem.querySelector(".name_big .graytext");
      const sizeText = graySpan?.textContent?.trim() ?? "";
      const sizeMatch = sizeText.match(/\(([^)]+)\)/);
      const size = sizeMatch ? sizeMatch[1].trim() : sizeText;
      if (name) {
        attachments.push({ name, size });
      }
    }
    if (attachments.length === 0 && readArea) {
      const headerText = readArea.textContent;
      const attMatch = headerText.match(
        /附\s*件[：:]\s*\d+\s*个\s*\(\s*([^)]+)\s*\)/
      );
      if (attMatch) {
        const attInfo = attMatch[1].trim();
        const fileName = attInfo
          .replace(/\s*(即将过期|已过期).*$/i, "")
          .trim();
        if (fileName) attachments.push({ name: fileName, size: "" });
      }
    }

    return {
      subject,
      from,
      to,
      date,
      body: body.substring(0, 5000),
      attachments,
      hasAttachment: attachments.length > 0,
    };
  } catch (error) {
    return { error: `解析邮件详情失败: ${error.message}` };
  }
}

// ─── 适配器注册（QQ 专用辅助，用于 download_invoices_by_month）────────────────

/**
 * 将「3月」「三月」「03」等规范为 1–12 的月份数字
 */
function normalizeMonthToNumber(month) {
  if (month == null || month === "") return NaN;
  const s = String(month).trim();
  const monthMap = {
    "1月": 1, "01": 1, "一月": 1, "Jan": 1, "January": 1,
    "2月": 2, "02": 2, "二月": 2, "Feb": 2, "February": 2,
    "3月": 3, "03": 3, "三月": 3, "Mar": 3, "March": 3,
    "4月": 4, "04": 4, "四月": 4, "Apr": 4, "April": 4,
    "5月": 5, "05": 5, "五月": 5, "May": 5,
    "6月": 6, "06": 6, "六月": 6, "Jun": 6, "June": 6,
    "7月": 7, "07": 7, "七月": 7, "Jul": 7, "July": 7,
    "8月": 8, "08": 8, "八月": 8, "Aug": 8, "August": 8,
    "9月": 9, "09": 9, "九月": 9, "Sep": 9, "September": 9,
    "10月": 10, "十月": 10, "Oct": 10, "October": 10,
    "11月": 11, "十一月": 11, "Nov": 11, "November": 11,
    "12月": 12, "十二月": 12, "Dec": 12, "December": 12,
  };
  if (monthMap[s] != null) return monthMap[s];
  const n = parseInt(s, 10);
  return n >= 1 && n <= 12 ? n : NaN;
}

/**
 * 判断日期字符串或主题是否表示目标月份（含 QQ 列表「3月5日」「2026年03月20日」、主题「03月24日」等）
 */
function isDateInMonth(dateStr, month) {
  if (!dateStr) return false;
  const monthNum = normalizeMonthToNumber(month);
  if (Number.isNaN(monthNum)) return false;
  const mm = String(monthNum).padStart(2, "0");
  const pattern1 = new RegExp(`\\d{4}年0?${monthNum}月`);
  const pattern2 = new RegExp(`\\d{4}[-/]${mm}[-/]`);
  // 中文「3月」「03月」：前一位不能是数字，避免「12月」误匹配为 2 月
  let patternCn;
  try {
    patternCn = new RegExp(`(?<![0-9])0?${monthNum}月`);
  } catch (e) {
    patternCn = new RegExp(
      `(?:^|[^0-9])0?${monthNum}月`
    );
  }
  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const monthIndex = monthNum - 1;
  const pattern4 = new RegExp(
    monthNames[monthIndex] + "\\s+\\d{1,2}",
    "i"
  );
  return (
    pattern1.test(dateStr) ||
    pattern2.test(dateStr) ||
    patternCn.test(dateStr) ||
    pattern4.test(dateStr)
  );
}

/**
 * 判断列表项是否在目标月份（优先 mailid 上 totime 毫秒时间戳，其次日期列与主题）
 * @param {{ date?: string, subject?: string, timestampMs?: number|null }} email
 * @param {string} month
 */
function isEmailInMonth(email, month) {
  const monthNum = normalizeMonthToNumber(month);
  if (Number.isNaN(monthNum)) return false;
  // 优先严格使用 timestampMs：只要有合法时间戳，就不再回退到文本匹配，
  // 避免 date 字段出现「7分钟前」等相对时间导致误判。
  const tsRaw = email.timestampMs;
  const ts =
    typeof tsRaw === "number"
      ? tsRaw
      : typeof tsRaw === "string" && /^\d+$/.test(tsRaw)
        ? parseInt(tsRaw, 10)
        : NaN;
  if (!Number.isNaN(ts)) {
    const d = new Date(ts);
    return !Number.isNaN(d.getTime()) && d.getMonth() + 1 === monthNum;
  }
  const previewRow = email.previewText;
  return (
    isDateInMonth(email.date, month) ||
    isDateInMonth(email.subject, month) ||
    (previewRow && isDateInMonth(previewRow, month))
  );
}

/**
 * 将「2026-04-26」「2026/04/26」「4月26日」「04-26」规范为可比对日期
 * @param {string} day
 * @returns {{ year: number|null, month: number, day: number }|null}
 */
function normalizeDayConstraint(day) {
  if (day == null || String(day).trim() === "") return null;
  const s = String(day).trim();

  let m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const date = parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && date >= 1 && date <= 31) {
      return { year, month, day: date };
    }
  }

  m = s.match(/^(\d{1,2})[-/月](\d{1,2})日?$/);
  if (m) {
    const month = parseInt(m[1], 10);
    const date = parseInt(m[2], 10);
    if (month >= 1 && month <= 12 && date >= 1 && date <= 31) {
      return { year: null, month, day: date };
    }
  }
  return null;
}

/**
 * 判断邮件是否命中指定某日（优先 timestampMs）
 * @param {{ date?: string, subject?: string, timestampMs?: number|string|null, previewText?: string }} email
 * @param {string} day
 */
function isEmailOnDay(email, day) {
  const target = normalizeDayConstraint(day);
  if (!target) return false;

  const tsRaw = email.timestampMs;
  const ts =
    typeof tsRaw === "number"
      ? tsRaw
      : typeof tsRaw === "string" && /^\d+$/.test(tsRaw)
        ? parseInt(tsRaw, 10)
        : NaN;
  if (!Number.isNaN(ts)) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return false;
    const sameYear = target.year == null ? true : d.getFullYear() === target.year;
    return sameYear && d.getMonth() + 1 === target.month && d.getDate() === target.day;
  }

  const mm = String(target.month).padStart(2, "0");
  const dd = String(target.day).padStart(2, "0");
  const yearPrefix = target.year != null ? `${target.year}` : "\\d{4}";
  const patterns = [
    new RegExp(`${yearPrefix}年0?${target.month}月0?${target.day}日`),
    new RegExp(`${yearPrefix}[-/]${mm}[-/]${dd}`),
    new RegExp(`(?<![0-9])0?${target.month}月0?${target.day}日`),
    new RegExp(`(?<![0-9])0?${target.month}[-/]0?${target.day}(?![0-9])`),
  ];
  const textPool = [email.date, email.subject, email.previewText].filter(Boolean).join(" ");
  return patterns.some((p) => p.test(textPool));
}

/**
 * 返回邮件列表（点击返回或 history.back）
 */
async function goBackToList() {
  try {
    if (isModernQqMail()) {
      const backBtn = [...document.querySelectorAll(".mail-list-page-toolbar .xmail-ui-btn")]
        .find((el) => /^(返回|Back)$/i.test(textOf(el)));
      if (backBtn) {
        backBtn.click();
        await sleep(1500);
        return { success: true };
      }
      if (document.querySelector(".mail-list-page-item, .mail-list-search-item")) {
        return { success: true };
      }
      const modern = await navigateModernInbox();
      if (modern) return { success: true };
    }
    const { doc } = getMainDocument();
    const backSelectors = [
      '[title="返回"]',
      ".back-btn",
      '[class*="back"]',
      ".goback",
      "#back",
    ];
    let backBtn = null;
    for (const sel of backSelectors) {
      backBtn = doc.querySelector(sel);
      if (backBtn) break;
    }
    if (backBtn) {
      backBtn.click();
    } else {
      window.history.back();
    }
    await sleep(1500);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 智能下载邮件附件（优先 PDF，其次压缩包，最后下载链接）
 * 支持两种模式：
 * 1. 传统附件：QQ邮箱附件区域 .att_bt.attachitem
 * 2. 链接下载：邮件正文中的下载链接（诺诺网、国家电网等）
 * @param {Object} _detail - 邮件详情（可由 parseEmailDetail 得到）
 */
async function smartDownloadAttachment(_detail) {
  try {
    const modernResult = await downloadModernAttachmentCards("smart");
    if (modernResult) return modernResult;
    const { doc } = getMainDocument();
    const readArea = doc.querySelector(
      '.mail-detail-content, [class*="readmail"], [class*="mail-detail"], #readmail, #mainContent, .readmail_content'
    );
    const attArea =
      doc.querySelector("#attachment") ||
      (readArea && readArea.querySelector("#attachment")) ||
      readArea;

    // ===== 第一步：尝试查找传统附件 =====
    if (attArea) {
      let attItems = attArea.querySelectorAll(".att_bt.attachitem");
      if (!attItems || attItems.length === 0) {
        attItems = doc.querySelectorAll(".att_bt.attachitem");
      }
      const attachments = [];
      for (const item of attItems) {
        const nameSpan = item.querySelector(".name_big > span");
        const name = nameSpan?.textContent?.trim() ?? "";
        const downloadLink = item.querySelector(
          '.down_big a[title*="请直接点击"]'
        );
        if (name && downloadLink) {
          // 提取文件名（不含扩展名）和扩展名
          const lastDotIndex = name.lastIndexOf('.');
          const baseName = lastDotIndex > 0 ? name.substring(0, lastDotIndex) : name;
          const ext = lastDotIndex > 0 ? name.substring(lastDotIndex).toLowerCase() : '';
          attachments.push({ name, baseName, ext, link: downloadLink, item });
        }
      }

      if (attachments.length > 0) {
        // 按基础文件名分组
        const baseNameGroups = new Map();
        for (const att of attachments) {
          if (!baseNameGroups.has(att.baseName)) {
            baseNameGroups.set(att.baseName, []);
          }
          baseNameGroups.get(att.baseName).push(att);
        }

        // 为每个基础文件名选择最佳附件（PDF优先）
        const selectedAttachments = [];
        for (const [baseName, group] of baseNameGroups) {
          // 优先选择PDF
          const pdfAtt = group.find(att => att.ext === '.pdf');
          if (pdfAtt) {
            selectedAttachments.push(pdfAtt);
          } else {
            // 其次选择压缩包
            const archiveExts = [".zip", ".rar", ".7z", ".tar", ".gz"];
            const archiveAtt = group.find(att =>
              archiveExts.some((ext) => att.ext === ext)
            );
            if (archiveAtt) {
              selectedAttachments.push(archiveAtt);
            } else {
              // 最后选择第一个
              selectedAttachments.push(group[0]);
            }
          }
        }

        // 如果有多个不同的基础文件名，优先下载PDF（第一个PDF附件）
        if (selectedAttachments.length > 0) {
          const pdfAtt = selectedAttachments.find((att) => att.ext === '.pdf');
          const attToDownload = pdfAtt || selectedAttachments[0];
          attToDownload.link?.click();

          const skippedCount = attachments.length - selectedAttachments.length;
          return {
            status: "downloading",
            type: attToDownload.ext === '.pdf' ? "pdf" : attToDownload.ext === '.zip' || attToDownload.ext === '.rar' ? "archive" : "other",
            filename: attToDownload.name,
            message: `已触发下载: ${attToDownload.name}${skippedCount > 0 ? `（同一名称的其他格式已跳过）` : ''}`,
          };
        }
      }
    }

    // ===== 第二步：查找邮件正文中的下载链接 =====
    // 获取邮件正文的 iframe
    let emailBody = null;
    const iframe = doc.querySelector(
      'iframe[id*="body"], iframe.content, iframe'
    );
    if (iframe) {
      try {
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        emailBody = iframeDoc?.body;
      } catch (e) {
        console.log("[QQMail] Cannot access iframe content:", e.message);
      }
    }

    // 如果没找到 iframe，使用 readArea
    if (!emailBody && readArea) {
      emailBody = readArea;
    }

    if (emailBody) {
      const allLinks = emailBody.querySelectorAll("a");
      const downloadLinks = [];

      for (const link of allLinks) {
        const text = link.textContent?.trim() ?? "";
        const href = link.href ?? "";
        const title = link.title ?? "";

        // 识别下载链接的关键词
        const isDownloadLink =
          text.includes("PDF文件下载") ||
          text.includes("pdf文件下载") ||
          text.includes("发票PDF") ||
          text.includes("下载发票") ||
          text.includes("查看发票") ||
          text === "下载" ||
          text.includes("下载附件") ||
          title.includes("下载") ||
          href.includes("download");

        if (isDownloadLink && href) {
          downloadLinks.push({
            text,
            href,
            isPdf: text.toLowerCase().includes("pdf"),
            element: link,
          });
        }
      }

      if (downloadLinks.length > 0) {
        // 优先选择 PDF 下载链接
        const pdfLink = downloadLinks.find((l) => l.isPdf);
        const linkToClick = pdfLink || downloadLinks[0];

        // 检查是否是诺诺网发票链接
        const isNuonuoLink = linkToClick.href.includes("nnfp.jss.com.cn");

        if (isNuonuoLink) {
          // 诺诺网链接：使用 window.open 打开，设置窗口名称以便返回
          try {
            const newWindow = window.open(linkToClick.href, "nuonuo_invoice_window");
            if (newWindow) {
              return {
                status: "opened_in_new_tab",
                type: "nuonuo_invoice",
                linkText: linkToClick.text,
                href: linkToClick.href,
                message: `已在新标签页打开诺诺网发票页面: ${linkToClick.text}。请在新页面下载后调用 nnfp.jss.com.cn.download_invoice`,
                nextStep: "请在诺诺网页面使用 nnfp.jss.com.cn.download_invoice 下载发票",
              };
            }
          } catch (e) {
            console.log("[QQMail] window.open failed:", e.message);
          }
        }

        // 普通链接：直接点击
        linkToClick.element.click();
        return {
          status: "downloading",
          type: "link",
          linkText: linkToClick.text,
          href: linkToClick.href,
          message: `已点击下载链接: ${linkToClick.text}`,
        };
      }
    }

    // 最后的备选：在整个文档中查找
    const allLinks = doc.querySelectorAll("a");
    for (const link of allLinks) {
      const text = link.textContent?.trim() ?? "";
      const href = link.href ?? "";
      const title = link.title ?? "";
      if (
        text === "下载" ||
        text.includes("下载附件") ||
        text.includes("下载发票") ||
        text.includes("查看发票") ||
        text.includes("PDF文件下载") ||
        title.includes("下载") ||
        href.includes("download")
      ) {
        link.click();
        return {
          status: "downloading",
          type: "link",
          linkText: text || title,
          message: `已点击下载链接: ${text || title}`,
        };
      }
    }

    return {
      error: "No downloadable content",
      message: "未找到可下载的附件或链接",
    };
  } catch (error) {
    return { error: "Download failed", message: error.message };
  }
}

/** QQ 邮箱搜发票邮件时固定使用的关键词（勿把月份拼进搜索词，如勿搜「3月发票」） */
const QQ_MAIL_INVOICE_SEARCH_KEYWORD = "发票";
/** 单实例锁：避免 download_invoices_by_invoice 并发执行 */
let isDownloadInvoicesByInvoiceRunning = false;
/** 取消信号：由 cancel_download_invoices_by_invoice 工具设置 */
let cancelDownloadInvoicesByInvoiceRequested = false;

function assertDownloadNotCancelled() {
  if (cancelDownloadInvoicesByInvoiceRequested) {
    throw new Error("task_cancelled");
  }
}

function cancelDownloadInvoicesByInvoice() {
  if (!isDownloadInvoicesByInvoiceRunning) {
    return {
      status: "idle",
      message: "当前没有正在执行的发票下载任务。",
    };
  }
  cancelDownloadInvoicesByInvoiceRequested = true;
  return {
    status: "cancelling",
    message: "已收到取消请求，当前下载任务将在下一检查点停止。",
  };
}

/**
 * 按发票关键词批量下载发票邮件附件
 * @param {string} [invoiceKeyword] - 发票关键词，如"发票"、"移动发票"；为空时默认"发票"
 * @param {string} [month] - 明确月份，如"4月"/"04"/"四月"；由 AI 解析后传入
 * @param {string} [day] - 明确日期，如"2026-04-26"/"4月26日"；优先级高于 month
 */
async function downloadInvoicesByInvoice(invoiceKeyword, month, day) {
  if (isDownloadInvoicesByInvoiceRunning) {
    return {
      status: "busy",
      error: "task_already_running",
      message: "已有发票下载任务正在执行，请等待当前任务完成后重试。",
    };
  }
  isDownloadInvoicesByInvoiceRunning = true;
  cancelDownloadInvoicesByInvoiceRequested = false;

  const results = [];
  const downloaded = [];      // 成功下载的邮件
  const noAttachment = [];    // 无附件，需要手动下载的邮件
  const failed = [];          // 打开或下载失败的邮件
  let processedCount = 0;
  let downloadedCount = 0;
  const keyword =
    invoiceKeyword != null && String(invoiceKeyword).trim() !== ""
      ? String(invoiceKeyword).trim()
      : QQ_MAIL_INVOICE_SEARCH_KEYWORD;
  const monthFilter =
    month != null && String(month).trim() !== ""
      ? String(month).trim()
      : null;
  const dayFilter =
    day != null && String(day).trim() !== ""
      ? String(day).trim()
      : null;

  try {
    assertDownloadNotCancelled();
    const searchResult = await searchEmails(keyword);
    if (searchResult.error) {
      return { error: searchResult.error, message: searchResult.message };
    }
    await sleep(2000);
    assertDownloadNotCancelled();

    // 只处理当前搜索结果页的邮件（不翻页）
    const allEmails = parseEmailList();

    const targetEmails = allEmails.filter((email) => {
      const subject = email.subject || "";
      if (!subject.includes(keyword)) return false;
      if (dayFilter) return isEmailOnDay(email, dayFilter);
      if (monthFilter) return isEmailInMonth(email, monthFilter);
      return true;
    });

    if (targetEmails.length === 0) {
      return {
        status: "completed",
        keyword,
        month: monthFilter,
        day: dayFilter,
        message: `未找到包含「${keyword}」的发票邮件`,
        totalFound: allEmails.length,
        targetCount: 0,
        downloadedCount: 0,
        results: [],
      };
    }

    // 处理所有目标邮件
    for (const email of targetEmails) {
      assertDownloadNotCancelled();
      processedCount++;
      try {
        const openResult = await openEmail(email.id);
        if (openResult.error) {
          const failInfo = {
            emailId: email.id,
            subject: email.subject,
            date: email.date,
            sender: email.sender,
            status: "not_downloaded",
            error: openResult.message,
            message: `未下载：无法打开邮件 - ${openResult.message}`,
          };
          results.push(failInfo);
          failed.push(failInfo);
          continue;
        }

        await sleep(2000);
        assertDownloadNotCancelled();
        const detail = parseEmailDetail();

        // 检查是否有附件
        if (!detail.hasAttachment || detail.attachments.length === 0) {
          // 无附件，需要手动处理
          const noAttInfo = {
            emailId: email.id,
            subject: email.subject,
            date: email.date,
            sender: email.sender,
            status: "not_downloaded",
            message: "未下载：该邮件没有附件，可能需要点击邮件中的链接下载发票",
          };
          results.push(noAttInfo);
          noAttachment.push(noAttInfo);
          await sleep(1000);
          await goBackToList();
          await sleep(1000);
          continue;
        }

        // 有附件，尝试下载
        const downloadResult = await smartDownloadAttachment(detail);

        if (downloadResult.error) {
          const failInfo = {
            emailId: email.id,
            subject: email.subject,
            date: email.date,
            sender: email.sender,
            status: "not_downloaded",
            error: downloadResult.message,
            message: `未下载：${downloadResult.message}`,
            attachments: detail.attachments.map(a => a.name),
          };
          results.push(failInfo);
          failed.push(failInfo);
        } else {
          downloadedCount++;
          const successInfo = {
            emailId: email.id,
            subject: email.subject,
            date: email.date,
            sender: email.sender,
            status: "success",
            downloadType: downloadResult.type,
            filename: downloadResult.filename,
            attachments: detail.attachments.map(a => a.name),
          };
          results.push(successInfo);
          downloaded.push(successInfo);
        }

        await sleep(1500);
        assertDownloadNotCancelled();
        await goBackToList();
        await sleep(1000);
      } catch (err) {
        if (err?.message === "task_cancelled") {
          return {
            status: "cancelled",
            keyword,
            month: monthFilter,
            day: dayFilter,
            message: "任务已取消：按请求停止后续下载。",
            processedCount,
            downloadedCount,
            downloaded,
            needManualDownload: { count: noAttachment.length, emails: noAttachment },
            failed: { count: failed.length, emails: failed },
            results,
          };
        }
        const errorInfo = {
          emailId: email.id,
          subject: email.subject,
          date: email.date,
          sender: email.sender,
          status: "not_downloaded",
          error: err.message,
          message: `未下载：处理异常 - ${err.message}`,
        };
        results.push(errorInfo);
        failed.push(errorInfo);
        await goBackToList();
        await sleep(1000);
      }
    }

    // 生成报告
    const report = {
      status: "completed",
      keyword,
      month: monthFilter,
      day: dayFilter,
      summary: {
        totalFound: allEmails.length,
        targetCount: targetEmails.length,
        processedCount,
        downloadedCount,
        noAttachmentCount: noAttachment.length,
        failedCount: failed.length,
      },
      // 分类展示
      downloaded: {
        count: downloaded.length,
        message: "已成功下载的发票",
        emails: downloaded,
      },
      needManualDownload: {
        count: noAttachment.length,
        message: "未下载：以下邮件没有附件，需要您手动打开邮件点击链接下载发票",
        emails: noAttachment,
      },
      failed: {
        count: failed.length,
        message: "未下载：以下邮件打开或下载失败",
        emails: failed,
      },
      // 原始完整结果
      results,
    };

    return report;
  } catch (error) {
    if (error?.message === "task_cancelled") {
      return {
        status: "cancelled",
        keyword,
        month: monthFilter,
        day: dayFilter,
        message: "任务已取消：按请求停止后续下载。",
        processedCount,
        downloadedCount,
        downloaded,
        needManualDownload: { count: noAttachment.length, emails: noAttachment },
        failed: { count: failed.length, emails: failed },
        results,
      };
    }
    return {
      status: "error",
      keyword,
      month: monthFilter,
      day: dayFilter,
      message: `下载任务失败: ${error.message}`,
      processedCount,
      downloadedCount,
      downloaded,
      needManualDownload: { count: noAttachment.length, emails: noAttachment },
      failed: { count: failed.length, emails: failed },
      results,
      error: error.message,
    };
  } finally {
    isDownloadInvoicesByInvoiceRunning = false;
    cancelDownloadInvoicesByInvoiceRequested = false;
  }
}

/**
 * 返回 QQ 邮箱收件箱首页
 * 根据DOM结构，左侧菜单在顶层document中，收件箱链接id为folder_1
 */
async function navigateToInbox() {
  try {
    if (isModernQqMail()) {
      const modern = await navigateModernInbox();
      if (modern) return modern;
      const previousUrl = window.location.href;
      window.location.href = qqMailInboxUrl();
      await sleep(2000);
      return {
        status: "success",
        message: "已打开QQ邮箱收件箱",
        previousUrl,
        currentUrl: window.location.href,
      };
    }
    const currentUrl = window.location.href;
    const { doc } = getMainDocument();

    // 首先尝试点击"返回"按钮（在邮件详情页面）
    const backBtnSelectors = [
      'input[value="返回"]',
      'input[name="back"]',
      '.btn_back',
      '#backBtn',
      '[title="返回"]',
      '.goBack',
    ];
    for (const sel of backBtnSelectors) {
      try {
        const backBtn = doc.querySelector(sel) || document.querySelector(sel);
        if (backBtn) {
          backBtn.click();
          await sleep(2000);
          return {
            status: "success",
            message: "已返回收件箱首页（通过返回按钮）",
            previousUrl: currentUrl,
            currentUrl: window.location.href,
          };
        }
      } catch (e) {}
    }

    // 尝试在顶层document中查找左侧导航栏的收件箱链接
    // 根据用户提供的DOM结构：#folder_1 是收件箱链接<a>标签
    const topLevelSelectors = [
      "a#folder_1",                   // 收件箱链接ID（a标签）
      "#folder_1",                    // 收件箱链接ID
      "#SysFolderList #folder_1",     // SysFolderList下的收件箱
      "#folder_1_td a#folder_1",      // li下的a标签
      "#folder_inbox",                // 备选收件箱ID
      "#folder_inbox a",
    ];

    let inboxLink = null;

    // 先在顶层document中查找
    for (const sel of topLevelSelectors) {
      try {
        inboxLink = document.querySelector(sel);
        if (inboxLink) {
          console.log("[QQMail] Found inbox link in top document:", sel, inboxLink);
          break;
        }
      } catch (e) {}
    }

    // 如果还没找到，尝试通过文本内容匹配
    if (!inboxLink) {
      const allLinks = document.querySelectorAll("a");
      for (const link of allLinks) {
        const text = link.textContent || "";
        // 匹配"收件箱"或"收件箱(数字)"
        if (text.includes("收件箱") && (/收件箱\s*\(\d+\)/.test(text) || text.trim() === "收件箱")) {
          inboxLink = link;
          console.log("[QQMail] Found inbox link by text content");
          break;
        }
      }
    }

    // 点击收件箱链接
    if (inboxLink) {
      // 获取实际的a标签
      const linkElement = inboxLink.tagName === 'A' ? inboxLink : inboxLink.querySelector('a');
      if (linkElement && linkElement.href) {
        // 直接设置mainFrame的src来导航
        const mainFrame = document.querySelector('#mainFrame');
        if (mainFrame) {
          mainFrame.src = linkElement.href;
          await sleep(2000);
          return {
            status: "success",
            message: "已返回收件箱首页",
            previousUrl: currentUrl,
            currentUrl: window.location.href,
          };
        }
      }
      // 如果无法直接导航，尝试点击
      inboxLink.click();
      await sleep(2000);
      return {
        status: "success",
        message: "已返回收件箱首页",
        previousUrl: currentUrl,
        currentUrl: window.location.href,
      };
    }

    // 如果在顶层没找到，尝试在mainFrame中查找
    const mainDocResult = getMainDocument();
    if (mainDocResult.doc && mainDocResult.doc !== document) {
      const frameSelectors = [
        "#folder_1",
        "#folder_1 a",
        "#folder_inbox",
        "#folder_inbox a",
        '[title="收件箱"]',
        ".folder_inbox a",
      ];
      for (const sel of frameSelectors) {
        try {
          inboxLink = mainDocResult.doc.querySelector(sel);
          if (inboxLink) {
            console.log("[QQMail] Found inbox link in mainFrame:", sel);
            inboxLink.click();
            await sleep(2000);
            return {
              status: "success",
              message: "已返回收件箱首页",
              previousUrl: currentUrl,
              currentUrl: window.location.href,
            };
          }
        } catch (e) {}
      }
    }

    // 最后的备选方案：刷新页面
    window.location.href = document.querySelector("#mainFrame")
      ? CLASSIC_HOME_URL + "cgi-bin/frame_html?sid=" +
        (new URLSearchParams(window.location.search).get("sid") || "") +
        "&r=undefined"
      : qqMailInboxUrl();
    await sleep(2000);
    return {
      status: "success",
      message: "已刷新页面返回收件箱首页",
      previousUrl: currentUrl,
      currentUrl: window.location.href,
    };
  } catch (error) {
    return {
      status: "error",
      message: `导航失败: ${error.message}`,
      error: error.message,
    };
  }
}

/**
 * 获取当前 QQ 邮箱页面的状态信息
 */
function getCurrentPageInfo() {
  try {
    const url = window.location.href;
    const title = document.title;
    const { doc, inFrame } = getMainDocument();

    const hash = window.location.hash || "";
    const isInbox =
      isQqMailHost(window.location.hostname) &&
      !url.includes("readmail") &&
      (hash.startsWith("#/list") || url.includes("inbox") || url.includes("frame") || !!document.querySelector(".mail-list-page"));
    const isEmailDetail = !!(
      textOf(doc.querySelector(".mail-subject-text")) ||
      doc.querySelector('[class*="readmail"], #readmail, #mainContent, .readmail_content') ||
      (!isModernQqMail() && doc.querySelector("[class*='mail-detail']"))
    );
    const isComposing = isModernQqMail()
      ? hash.includes("/compose")
      : !!doc.querySelector('[class*="compose"], [title="写信"]');

    let emailListInfo = null;
    if (!isEmailDetail && !isComposing) {
      const emails = parseEmailList();
      emailListInfo = {
        totalEmails: emails.length,
        unreadCount: emails.filter((email) => email.isUnread).length,
        hasEmails: emails.length > 0,
      };
    }

    let emailDetailInfo = null;
    if (isEmailDetail) {
      if (isModernQqMail()) {
        const detail = parseModernEmailDetail();
        emailDetailInfo = {
          subject: detail.subject || "",
          hasAttachments: !!detail.hasAttachment,
          attachmentCount: detail.attachments?.length || 0,
        };
      } else {
      const readArea = doc.querySelector(
        '.mail-detail-content, [class*="readmail"], [class*="mail-detail"], #readmail, #mainContent, .readmail_content'
      );
      const subjectEl = readArea?.querySelector(
        "h1, [class*='subject'], .title"
      );
      const subject = subjectEl?.textContent?.trim() ?? "";
      // 尝试多种方式查找附件
      let attachments = doc.querySelectorAll(".att_bt.attachitem");
      if (!attachments || attachments.length === 0) {
        attachments = readArea?.querySelectorAll(".att_bt.attachitem") || [];
      }
      emailDetailInfo = {
        subject,
        hasAttachments: attachments.length > 0,
        attachmentCount: attachments.length,
      };
      }
    }

    return {
      url,
      title,
      pageType: isEmailDetail ? "email_detail" : isComposing ? "composing" : "inbox",
      isInbox,
      isEmailDetail,
      isComposing,
      inFrame,
      logged_in: detectLoggedIn().logged_in,
      emailListInfo,
      emailDetailInfo,
      readyState: document.readyState,
    };
  } catch (error) {
    return {
      error: "Failed to get page info",
      message: error.message,
    };
  }
}

// ─── 适配器注册 ───────────────────────────────────────────────────────────────

window.__webmcpRegister({
  name: "qq-mail-adapter",
  match: ["wx.mail.qq.com", "mail.qq.com"],
  tools: [
    {
      name: "mail.qq.com.check_login_status",
      description:
        "检测QQ邮箱是否已登录并返回登录状态。仅在用户明确询问登录状态时调用；调用其他工具前无需先调用它，未登录时 WeWorker 会自动打开登录页并在登录后继续。",
      parameters: { type: "object", properties: {}, required: [] },
      handler: withToolWarmup(() => {
        const login = detectLoggedIn();
        return {
          logged_in: login.logged_in,
          url: window.location.href,
          matched_selector: login.matched_selector,
          hint: login.logged_in
            ? "QQ邮箱已登录"
            : "QQ邮箱可能未登录或页面未加载完成，请确认已打开 QQ邮箱并完成登录",
        };
      }),
    },
    {
      name: "mail.qq.com.navigate_to_inbox",
      description:
        "返回QQ邮箱收件箱首页。当需要执行多步骤操作（如批量下载附件）或当前页面状态不明确时，使用此工具返回初始状态。",
      parameters: { type: "object", properties: {}, required: [] },
      handler: withToolWarmup(() => navigateToInbox()),
    },
    {
      name: "mail.qq.com.search_emails",
      description:
        "在QQ邮箱中搜索邮件。未传关键词时默认搜索「发票」。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description:
              "搜索关键词，例如「合同」「会议」。不传或为空时默认为「发票」。",
          },
        },
        required: [],
      },
      handler: withToolWarmup(async ({ keyword }) => searchEmails(keyword)),
    },
    {
      name: "mail.qq.com.get_unread_emails",
      description: "获取QQ邮箱收件箱中的未读邮件列表",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "最多返回的邮件数量，默认20",
          },
        },
        required: [],
      },
      handler: withToolWarmup(async ({ limit = 20 }) => getUnreadEmails(limit)),
    },
    {
      name: "mail.qq.com.open_email",
      description:
        "打开QQ邮箱中的指定邮件，查看完整内容。邮件ID可以从search_emails或get_unread_emails的返回结果中获取",
      parameters: {
        type: "object",
        properties: {
          emailId: {
            type: "string",
            description: "邮件的唯一ID或主题片段",
          },
        },
        required: ["emailId"],
      },
      handler: withToolWarmup(async ({ emailId }) => openEmail(emailId)),
    },
    {
      name: "mail.qq.com.download_attachment",
      description:
        "下载QQ邮箱中当前打开邮件的附件。使用前需要先调用open_email打开邮件。",
      parameters: {
        type: "object",
        properties: {
          attachmentName: {
            type: "string",
            description:
              "要下载的附件名称（例如：'发票.pdf'），或使用'all'打包下载所有附件",
          },
        },
        required: ["attachmentName"],
      },
      handler: withToolWarmup(async ({ attachmentName }) => downloadAttachment(attachmentName)),
    },
    {
      name: "mail.qq.com.get_current_page_info",
      description:
        "获取当前QQ邮箱页面的状态信息，用于判断当前在哪个页面（收件箱、邮件详情等）",
      parameters: { type: "object", properties: {}, required: [] },
      handler: withToolWarmup(() => getCurrentPageInfo()),
    },
    {
      name: "mail.qq.com.cancel_download_invoices_by_invoice",
      description:
        "取消当前正在执行的发票批量下载任务。若任务在执行中，会在下一检查点尽快停止。",
      parameters: { type: "object", properties: {}, required: [] },
      handler: withToolWarmup(() => cancelDownloadInvoicesByInvoice()),
    },
    {
      name: "mail.qq.com.download_invoices_by_invoice",
      description:
        "按发票关键词批量下载 QQ 邮箱发票附件。时间条件由 AI 先解析后传入：可传 day（某日）或 month（某月），day 优先级高于 month。流程：按关键词搜索发票→按 day/month 过滤（可选）→逐封下载→返回结果。",
      parameters: {
        type: "object",
        properties: {
          invoiceKeyword: {
            type: "string",
            description:
              "发票关键词，如「发票」「移动发票」。为空时默认「发票」。",
          },
          month: {
            type: "string",
            description:
              "明确月份（由 AI 解析后传入），如「4月」「04」「四月」。不传则不按月份筛选。",
          },
          day: {
            type: "string",
            description:
              "明确日期（由 AI 解析后传入），如「2026-04-26」「4月26日」。传入后优先按该日筛选。",
          },
        },
        required: [],
      },
      handler: withToolWarmup(async ({ invoiceKeyword, month, day }) => downloadInvoicesByInvoice(invoiceKeyword, month, day)),
    },
  ],
});

  } finally {
    window.__webmcpRegister = previousRegister;
  }
  var tools = [];
  for (var i = 0; i < captured.length; i++) {
    var list = Array.isArray(captured[i].tools) ? captured[i].tools : [];
    for (var j = 0; j < list.length; j++) if (list[j] && typeof list[j].handler === 'function') tools.push(list[j]);
  }
  var support = window.__webmcpGeneratedSupport["mail.qq.com"];
  if (support && Array.isArray(support.tools)) {
    for (var k = 0; k < support.tools.length; k++) if (support.tools[k] && typeof support.tools[k].handler === 'function') tools.push(support.tools[k]);
  }
  var byName = Object.create(null);
  for (var n = 0; n < tools.length; n++) {
    var tool = tools[n];
    var names = [tool.publicName, tool.name, tool.handlerName];
    for (var z = 0; z < names.length; z++) if (typeof names[z] === 'string' && names[z] && !byName[names[z]]) byName[names[z]] = tool;
  }
  window["__mail_qq_com_internal"] = {
    invoke: async function (publicName, params) {
      var tool = byName[publicName];
      if (!tool || typeof tool.handler !== 'function') throw new Error('Legacy handler unavailable for ' + "mail.qq.com" + '.' + publicName);
      return tool.handler(params || {});
    },
    names: Object.keys(byName)
  };
})();
