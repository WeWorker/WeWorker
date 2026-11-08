/* v2 compatibility implementation for mail.google.com; preserves the tracked legacy executable logic. */
(function () {
  var captured = [];
  var previousRegister = window.__webmcpRegister;
  window.__webmcpRegister = function (adapter) { captured.push(adapter || {}); };
  window.__webmcpGeneratedSupport = window.__webmcpGeneratedSupport || {};
  window.__webmcpGeneratedLegacyHandlers = window.__webmcpGeneratedLegacyHandlers || {};
  try {
/* embedded legacy source: index.js */
/**
 * Gmail Adapter Script
 *
 * NOTE: Runs in isolated world — can only access DOM, not page JS variables.
 *
 * Verified: Gmail, February 2026
 * Maintainer: WeWorker project
 */

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Wait for a selector to appear in the DOM.
 * @param {string} selector
 * @param {number} timeout milliseconds
 */
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for element: ${selector}`));
    }, timeout);
  });
}

/**
 * Sleep for a number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── DOM Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse the email thread list from the current Gmail view.
 *
 * Gmail DOM structure (verified February 2026):
 * - Row container:    tr.zA
 * - Unread marker:    tr.zA.zE (read = tr.zA.yO)
 * - Thread ID:        data-legacy-thread-id on a <span> *inside* the row
 *                     (data-thread-id is the long "#thread-f:…" form on the same span)
 * - Sender:           .yP span — has name="…" and email="…" attributes
 * - Subject:          .bog
 * - Snippet:          .y2
 * - Date:             .xW span[title] — the outer span holds the full datetime in its
 *                     title attribute; the inner <span> only has the short display text
 * - Attachment icon:  .brd (paperclip cell)
 */
function parseEmailList() {
  const emails = [];
  // Use [gh="tl"] to get only the current view's thread list, avoiding stale rows from previous views
  const threadList = document.querySelector('[gh="tl"]');
  if (!threadList) {
    return emails; // No thread list found
  }
  const rows = threadList.querySelectorAll('tr.zA');

  for (const row of rows) {
    // Thread ID lives on a child span, not on the <tr> itself
    const threadEl = row.querySelector('[data-legacy-thread-id]');
    const id = threadEl?.getAttribute('data-legacy-thread-id') || '';

    // Sender: .yP has name= and email= attributes
    const senderEl = row.querySelector('.yP');
    const sender =
      senderEl?.getAttribute('name') || senderEl?.textContent?.trim() || '';

    // Subject line
    const subject = row.querySelector('.bog')?.textContent?.trim() || '';

    // Date — the span with title= has the full "Sun, Feb 22, 2026, 5:05 PM" string;
    // the inner plain <span> only shows the abbreviated display text ("Feb 22")
    const dateEl = row.querySelector('.xW span[title]');
    const date =
      dateEl?.getAttribute('title') || dateEl?.textContent?.trim() || '';

    const isUnread = row.classList.contains('zE');
    const hasAttachment = !!row.querySelector('.brd');

    // Preview snippet
    const snippet = row.querySelector('.y2')?.textContent?.trim() || '';

    if (id && subject) {
      emails.push({ id, sender, subject, date, isUnread, hasAttachment, snippet });
    }
  }

  return emails;
}

/**
 * Parse the currently open email's detail view.
 *
 * Gmail DOM structure (verified February 2026):
 * - Subject:      h2.hP
 * - Sender:       .gD  (has `email` attribute with address)
 * - Recipients:   .g2  (has `email` attribute; multiple possible)
 * - Date:         .g3 span (title attribute has full datetime)
 * - Body text:    .a3s.aiL
 * - Attachments:  span.aZo items inside div.aQH, filename in .aV3, size in .aYp span
 */
function parseEmailDetail() {
  try {
    // Subject — if empty the view hasn't loaded yet
    const subjectEl = document.querySelector('h2.hP');
    const subject = subjectEl?.textContent?.trim() || '';
    if (!subject) {
      return { error: 'Email detail not loaded yet' };
    }

    // Sender
    const fromEl = document.querySelector('.gD');
    const from =
      fromEl?.getAttribute('email') || fromEl?.textContent?.trim() || '';

    // Recipients (there can be multiple .g2 elements)
    const toEls = document.querySelectorAll('.g2');
    const to = Array.from(toEls)
      .map(el => el.getAttribute('email') || el.textContent?.trim())
      .filter(Boolean)
      .join(', ');

    // Date
    const dateEl = document.querySelector('.g3 span');
    const date =
      dateEl?.getAttribute('title') || dateEl?.textContent?.trim() || '';

    // Body — .a3s.aiL is Gmail's quoted/plain text container
    let body = '';
    const bodyEl = document.querySelector('.a3s.aiL');
    body = bodyEl?.textContent?.trim() || '';

    // Attachments
    // Gmail DOM (February 2026):
    // - Container:  div.aQH
    // - Each item:  span.aZo  (NOT [data-attid] — that attribute does not exist)
    // - Filename:   span.aV3
    // - Size:       .aYp span  (e.g. "25 KB")
    const attachments = [];
    const attItems = document.querySelectorAll('.aQH .aZo');
    for (const item of attItems) {
      const name = item.querySelector('.aV3')?.textContent?.trim() || '';
      if (!name) continue;
      const size = item.querySelector('.aYp span')?.textContent?.trim() || '';
      attachments.push({ name, size });
    }

    return {
      subject,
      from,
      to,
      date,
      body: body.substring(0, 5000), // cap to avoid oversized responses
      attachments,
      hasAttachment: attachments.length > 0,
    };
  } catch (error) {
    return { error: `Failed to parse email detail: ${error.message}` };
  }
}

// ─── Tool Handler Functions ──────────────────────────────────────────────────

/**
 * Search emails by keyword.
 * @param {string} keyword
 *
 * 测试示例：await searchEmails('invoice')
 *
 * 触发方式：直接修改 window.location.hash 导航到 Gmail 搜索 URL。
 * 避免使用模拟 Enter 键——合成 keydown Enter 会触发表单 submit，导致完整页面导航，
 * 销毁 content script 上下文，使 Promise 永远 pending。
 * 等待策略：使用 MutationObserver 检测结果行出现，不依赖固定 sleep。
 */
/**
 * Search emails by keyword.
 * @param {string} keyword
 *
 * 测试示例：await searchEmails('invoice')
 *
 * 触发方式：直接修改 window.location.hash 导航到 Gmail 搜索 URL。
 * 避免使用模拟 Enter 键——合成 keydown Enter 会触发表单 submit，导致完整页面导航，
 * 销毁 content script 上下文，使 Promise 永远 pending。
 * 等待策略：快照旧 thread ID，用 MutationObserver 检测新内容出现，不依赖固定 sleep。
 */
async function searchEmails(keyword) {
  const searchHash = '#search/' + encodeURIComponent(keyword);

  // Register observer BEFORE navigating to avoid missing any DOM mutations.
  const resultsLoaded = new Promise(resolve => {
    let timer;
    let checkInterval;

    const checkStability = () => {
      // Only check when we're on the search page
      if (!window.location.hash.startsWith('#search/')) return;

      // Check the current view's thread list only
      const threadList = document.querySelector('[gh="tl"]');
      if (!threadList) return;

      const rows = threadList.querySelectorAll('tr.zA');
      if (rows.length > 0) {
        clearTimeout(timer);
        clearInterval(checkInterval);
        resolve(true);
      }
    };

    const observer = new MutationObserver(checkStability);
    observer.observe(document.body, { childList: true, subtree: true });

    // Also poll every 200ms as a backup
    checkInterval = setInterval(checkStability, 200);

    // Timeout after 8 seconds
    timer = setTimeout(() => {
      observer.disconnect();
      clearInterval(checkInterval);
      resolve(false);
    }, 8000);
  });

  // Hash-only navigation keeps the document (and content-script context) alive.
  window.location.hash = searchHash;

  const loaded = await resultsLoaded;

  // If timeout occurred, wait a bit more and try anyway
  if (!loaded) {
    await sleep(1000);
  } else {
    await sleep(300);
  }

  const emails = parseEmailList();
  return { keyword, count: emails.length, emails };
}

/**
 * Get unread emails from the inbox.
 * @param {number} limit
 */
async function getUnreadEmails(limit = 20) {
  // Navigate to inbox if not already there
  if (!window.location.hash.includes('inbox')) {
    const match = window.location.pathname.match(/\/mail\/u\/(\d+)\//);
    const idx = match ? match[1] : '0';
    window.location.href = `https://mail.google.com/mail/u/${idx}/#inbox`;
    await sleep(2000);
  }

  const threadList = document.querySelector('[gh="tl"]');
  if (!threadList) {
    return { count: 0, emails: [] };
  }
  const rows = threadList.querySelectorAll('tr.zA');
  const unread = [];

  for (const row of rows) {
    if (!row.classList.contains('zE')) continue;

    const id = row.querySelector('[data-legacy-thread-id]')
                     ?.getAttribute('data-legacy-thread-id') || '';
    const senderEl = row.querySelector('.yP');
    const sender =
      senderEl?.getAttribute('name') || senderEl?.textContent?.trim() || '';
    const subject = row.querySelector('.bog')?.textContent?.trim() || '';
    const dateEl = row.querySelector('.xW span[title]');
    const date =
      dateEl?.getAttribute('title') || dateEl?.textContent?.trim() || '';

    if (id && subject) {
      unread.push({ id, sender, subject, date });
      if (unread.length >= limit) break;
    }
  }

  return { count: unread.length, emails: unread };
}

/**
 * Open a specific email thread.
 * @param {string} emailId  data-legacy-thread-id from parseEmailList
 */
async function openEmail(emailId) {
  try {
    // Thread ID lives on a child span inside the row, not on the <tr> itself
    const matches = [...new Set(Array.from(document.querySelectorAll('[data-legacy-thread-id]'))
      .filter(span => span.getAttribute('data-legacy-thread-id') === emailId)
      .map(span => span.closest('tr.zA')).filter(Boolean))];
    if (matches.length > 1) return { error: 'Ambiguous email ID', emailId };
    const row = matches[0];
    if (!row) {
      return {
        error: 'Email not found',
        emailId,
        message:
          'No email row with this thread ID found. It may not be visible in the current view.',
      };
    }

    row.click();

    // Poll for h2.hP to appear (email detail subject)
    let detail = null;
    let attempts = 0;
    const maxAttempts = 20; // up to 10 seconds

    while (attempts < maxAttempts) {
      await sleep(500);
      attempts++;
      const tempDetail = parseEmailDetail();
      if (!tempDetail.error && tempDetail.subject) {
        detail = tempDetail;
        break;
      }
    }

    if (!detail) {
      detail = parseEmailDetail();
    }

    if (detail.error) {
      return {
        status: 'clicked',
        emailId,
        warning: detail.error,
        message: 'Email was clicked but detail could not be parsed.',
      };
    }

    return { status: 'opened', emailId, detail, loadTime: `${attempts * 500}ms` };
  } catch (error) {
    return { error: 'Failed to open email', emailId, message: error.message };
  }
}

/**
 * Download an attachment from the currently open email.
 * @param {string} attachmentName  Exact filename, or "all"
 */
async function downloadAttachment(attachmentName) {
  try {
    // Verify an email is open
    const subjectEl = document.querySelector('h2.hP');
    if (!subjectEl) {
      return {
        error: 'No email opened',
        message: 'No open email found. Please call open_email first.',
      };
    }

    // Download all attachments
    if (attachmentName === 'all') {
      // aria-label is exactly "Download all attachments" (verified February 2026)
      const downloadAllBtn = document.querySelector(
        'button[aria-label="Download all attachments"]'
      );
      if (!downloadAllBtn) {
        return {
          error: 'Download all button not found',
          message:
            'Could not find a "Download all attachments" button. The email may have no attachments.',
        };
      }
      downloadAllBtn.click();
      return {
        status: 'downloading',
        attachmentName: 'all',
        message: 'Triggered download of all attachments.',
      };
    }

    // Download a single named attachment
    // Each attachment is a span.aZo inside div.aQH
    // Gmail shows download buttons only on hover, so we need to trigger mouseover first
    const attItems = document.querySelectorAll('.aQH .aZo');
    for (const item of attItems) {
      const name = item.querySelector('.aV3')?.textContent?.trim() || '';
      if (name !== attachmentName) continue;

      // Trigger mouseover to show the download button
      const mouseoverEvent = new MouseEvent('mouseover', {
        view: window,
        bubbles: true,
        cancelable: true
      });
      item.dispatchEvent(mouseoverEvent);

      // Wait a bit for the button to appear
      await sleep(200);

      // Find the download button by checking all buttons in this attachment item
      const buttons = item.querySelectorAll('button');
      let downloadBtn = null;
      for (const btn of buttons) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        if (ariaLabel.startsWith('Download attachment ')) {
          downloadBtn = btn;
          break;
        }
      }

      if (!downloadBtn) {
        return {
          error: 'Download button not found',
          attachmentName,
          message: `Found attachment "${attachmentName}" but could not locate its download button after hover.`,
        };
      }

      downloadBtn.click();
      return {
        status: 'downloading',
        attachmentName,
        message: `Triggered download of: ${attachmentName}`,
      };
    }

    // Not found — list what's available
    const available = Array.from(attItems)
      .map(item => item.querySelector('.aV3')?.textContent?.trim())
      .filter(Boolean);

    return {
      error: 'Attachment not found',
      attachmentName,
      availableAttachments: available,
      message: `No attachment named "${attachmentName}" found in the current email.`,
    };
  } catch (error) {
    return {
      error: 'Failed to download attachment',
      attachmentName,
      message: error.message,
    };
  }
}

// ─── Tool Handler Functions (continued) ─────────────────────────────────────

/**
 * Navigate to the Gmail inbox.
 *
 * 测试示例：await navigateToInbox()
 */
async function navigateToInbox() {
  try {
    const currentUrl = window.location.href;
    // Preserve the account index (u/0, u/1, …)
    const match = window.location.pathname.match(/\/mail\/u\/(\d+)\//);
    const idx = match ? match[1] : '0';
    window.location.href = `https://mail.google.com/mail/u/${idx}/#inbox`;

    await sleep(1000);
    let waitTime = 0;
    while (document.readyState !== 'complete' && waitTime < 5000) {
      await sleep(100);
      waitTime += 100;
    }
    await sleep(1500);

    return {
      status: 'success',
      message: 'Navigated to Gmail inbox',
      previousUrl: currentUrl,
      currentUrl: window.location.href,
      pageLoaded: document.readyState === 'complete',
    };
  } catch (error) {
    return {
      status: 'error',
      message: `Navigation failed: ${error.message}`,
      error: error.message,
    };
  }
}

/**
 * Return current Gmail page state.
 *
 * 测试示例：getCurrentPageInfo()
 */
function getCurrentPageInfo() {
  try {
    const url = window.location.href;
    const title = document.title;
    const hash = window.location.hash;

    const isEmailDetail = !!document.querySelector('h2.hP');
    const isComposing = !!document.querySelector(
      '.AD [role="dialog"], [aria-label*="New Message"], [aria-label*="新邮件"]'
    );
    const isInbox = hash.startsWith('#inbox') || hash === '#' || hash === '';

    let emailListInfo = null;
    if (!isEmailDetail && !isComposing) {
      const rows = document.querySelectorAll('tr.zA');
      emailListInfo = {
        totalEmails: rows.length,
        hasEmails: rows.length > 0,
      };
    }

    let emailDetailInfo = null;
    if (isEmailDetail) {
      const subject =
        document.querySelector('h2.hP')?.textContent?.trim() || '';
      const attCount = document.querySelectorAll('.aQH .aZo').length;
      emailDetailInfo = {
        subject,
        hasAttachments: attCount > 0,
        attachmentCount: attCount,
      };
    }

    return {
      url,
      title,
      pageType: isEmailDetail
        ? 'email_detail'
        : isComposing
        ? 'composing'
        : 'inbox',
      isInbox,
      isEmailDetail,
      isComposing,
      emailListInfo,
      emailDetailInfo,
      readyState: document.readyState,
    };
  } catch (error) {
    return { error: 'Failed to get page info', message: error.message };
  }
}

// ─── Adapter Registration ────────────────────────────────────────────────────
// No ES module export — background injects this file via executeScript
// and window.__webmcpRegister is exposed by content/injector.js

/**
 * 检测 Gmail 是否已登录
 *
 * 检测策略：
 * 1. URL 特征：未登录时 Gmail 会跳转到 accounts.google.com，
 *    但此时 adapter 不会被注入（match 是 mail.google.com），
 *    所以如果此函数能执行，说明页面仍在 mail.google.com 域名下。
 * 2. DOM 特征：已登录的 Gmail 有 div[role="navigation"]、tr.zA（邮件行）等元素。
 * 3. 兜底：如果 URL 包含 accounts.google.com 相关特征，判定为未登录。
 */
function checkLoginStatus() {
  try {
    const url = window.location.href;

    // URL 判断：是否被重定向到登录页（理论上 adapter 不会在此域名注入，但做兜底）
    if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) {
      return {
        logged_in: false,
        hint: 'Gmail 未登录，请先在浏览器中登录 Google 账号',
      };
    }

    // DOM 判断：已登录的 Gmail 主界面特征
    const loggedInSelectors = [
      'div[role="navigation"]',   // 左侧导航栏
      'tr.zA',                     // 邮件列表行
      '.aim',                      // 左侧面板容器
      'div[data-tooltip="Inbox"]', // 收件箱按钮（英文）
      'div[data-tooltip="收件箱"]', // 收件箱按钮（中文）
      '.gb_Td',                    // 右上角用户头像
    ];
    const hasLoggedInElements = loggedInSelectors.some(s => document.querySelector(s) !== null);

    if (hasLoggedInElements) {
      return { logged_in: true };
    }

    // 页面可能还在加载中
    if (document.readyState !== 'complete') {
      return {
        logged_in: false,
        hint: 'Gmail 页面尚未加载完成，请稍后再试',
      };
    }

    // 在 mail.google.com 域名下但没有已登录特征
    return {
      logged_in: false,
      hint: 'Gmail 可能未登录或页面未完全加载，请确认已登录 Google 账号',
    };
  } catch (error) {
    return {
      logged_in: false,
      hint: `检测登录状态失败: ${error.message}`,
    };
  }
}

window.__webmcpRegister({
  name: 'gmail-adapter',
  match: ['mail.google.com'],
  tools: [
    {
      name: 'mail.google.com.check_login_status',
      description: '检测 Gmail 是否已登录并返回登录状态。仅在用户明确询问登录状态时调用；调用其他工具前无需先调用它，未登录时 WeWorker 会自动打开登录页并在登录后继续。',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => checkLoginStatus(),
    },

    {
      name: 'mail.google.com.navigate_to_inbox',
      description:
        'Navigate to the Gmail inbox homepage. Use this before multi-step operations to ensure a clean starting state.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => navigateToInbox(),
    },

    {
      name: 'mail.google.com.search_emails',
      description: 'Search Gmail by keyword and return matching email threads',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: 'Search term, e.g. "invoice", "meeting", "receipt"',
          },
        },
        required: ['keyword'],
      },
      handler: async ({ keyword }) => searchEmails(keyword),
    },

    {
      name: 'mail.google.com.get_unread_emails',
      description: 'Get unread emails from the Gmail inbox',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of emails to return. Default: 20',
          },
        },
        required: [],
      },
      handler: async ({ limit = 20 }) => getUnreadEmails(limit),
    },

    {
      name: 'mail.google.com.open_email',
      description:
        'Open a Gmail email thread and return its full content including body and attachments. Use the email ID from search_emails or get_unread_emails.',
      parameters: {
        type: 'object',
        properties: {
          emailId: {
            type: 'string',
            description: 'Thread ID returned by search_emails or get_unread_emails',
          },
        },
        required: ['emailId'],
      },
      handler: async ({ emailId }) => openEmail(emailId),
    },

    {
      name: 'mail.google.com.download_attachment',
      description:
        'Download an attachment from the currently open Gmail email. You must call open_email first.',
      parameters: {
        type: 'object',
        properties: {
          attachmentName: {
            type: 'string',
            description:
              'Exact filename to download (e.g. "invoice.pdf"), or "all" to download all attachments as a zip',
          },
        },
        required: ['attachmentName'],
      },
      handler: async ({ attachmentName }) => downloadAttachment(attachmentName),
    },

    {
      name: 'mail.google.com.get_current_page_info',
      description:
        'Get the current Gmail page state — useful for checking whether you are in the inbox, reading an email, or composing.',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => getCurrentPageInfo(),
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
  var support = window.__webmcpGeneratedSupport["mail.google.com"];
  if (support && Array.isArray(support.tools)) {
    for (var k = 0; k < support.tools.length; k++) if (support.tools[k] && typeof support.tools[k].handler === 'function') tools.push(support.tools[k]);
  }
  var byName = Object.create(null);
  for (var n = 0; n < tools.length; n++) {
    var tool = tools[n];
    var names = [tool.publicName, tool.name, tool.handlerName];
    for (var z = 0; z < names.length; z++) if (typeof names[z] === 'string' && names[z] && !byName[names[z]]) byName[names[z]] = tool;
  }
  window["__mail_google_com_internal"] = {
    invoke: async function (publicName, params) {
      var tool = byName[publicName];
      if (!tool || typeof tool.handler !== 'function') throw new Error('Legacy handler unavailable for ' + "mail.google.com" + '.' + publicName);
      return tool.handler(params || {});
    },
    names: Object.keys(byName)
  };
})();
