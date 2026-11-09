/* v2 compatibility implementation for nnfp.jss.com.cn; preserves the tracked legacy executable logic. */
(function () {
  var captured = [];
  var previousRegister = window.__webmcpRegister;
  window.__webmcpRegister = function (adapter) { captured.push(adapter || {}); };
  window.__webmcpGeneratedSupport = window.__webmcpGeneratedSupport || {};
  window.__webmcpGeneratedLegacyHandlers = window.__webmcpGeneratedLegacyHandlers || {};
  try {
/* embedded legacy source: index.js */
/**
 * 诺诺网发票平台适配器
 *
 * 支持：nnfp.jss.com.cn
 * 功能：自动识别发票页面并点击下载按钮
 *
 * 维护者：WeWorker 项目
 */

function assertInvoiceIdentity(expectedIdentity) {
  if (expectedIdentity === undefined) return;
  if (typeof expectedIdentity !== 'string' || !expectedIdentity || getInvoiceInfo().context_identity !== expectedIdentity) throw new Error('invoice_identity_changed');
}
function trustedDownloadUrl(raw) {
  try { const u = new URL(raw, window.location.href); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['nnfp.jss.com.cn', 'inv.jss.com.cn'].includes(u.hostname); } catch { return false; }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待元素出现
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
 * 检查当前页面是否是诺诺网发票页面
 */
function isNuonuoInvoicePage() {
  const url = window.location.href;
  return url.includes("nnfp.jss.com.cn") && (
    url.includes("/invoice/") ||
    url.includes("/einvoice/") ||
    url.match(/\/[a-zA-Z0-9=_-]{10,}/) || // 发票短链接格式
    url.match(/nnfp\.jss\.com\.cn\/[a-zA-Z0-9]/) // 匹配 nnfp.jss.com.cn/xxx 格式
  );
}

/**
 * 检查发票页面是否加载成功
 * 返回页面状态信息
 */
function checkPageStatus() {
  const url = window.location.href;
  const bodyText = document.body?.textContent || "";
  const bodyHtml = document.body?.innerHTML || "";

  // 检查是否是空白页或错误页
  if (bodyText.includes("该发票数据不存在") ||
      bodyText.includes("请仔细确认链接地址") ||
      bodyText.includes("错误") && bodyText.includes("发票")) {
    return {
      loaded: false,
      error: "invoice_not_found",
      message: "发票数据不存在或链接已过期"
    };
  }

  // 检查页面是否为空白
  if (!document.body || bodyText.trim().length < 50) {
    return {
      loaded: false,
      error: "blank_page",
      message: "页面尚未加载完成"
    };
  }

  // 检查是否是发票详情页（有发票信息）
  const hasInvoiceInfo =
    bodyText.includes("发票号码") ||
    bodyText.includes("发票代码") ||
    bodyText.includes("开票日期") ||
    bodyText.includes("合计金额") ||
    bodyText.includes("￥") ||
    bodyText.includes("电子发票");

  // 检查是否有下载按钮
  const hasDownloadBtn =
    bodyText.includes("下载") ||
    bodyText.includes("PDF") ||
    document.querySelector(".logo-btn-area, .download-area, .btn-area") !== null;

  return {
    loaded: hasInvoiceInfo || hasDownloadBtn,
    hasInvoiceInfo,
    hasDownloadBtn,
    message: hasInvoiceInfo ? "发票页面加载成功" : "页面加载中..."
  };
}

/**
 * 使用 Chrome 下载 API 下载文件到指定路径
 * @param {string} url - 下载链接
 * @param {string} filename - 文件名
 * @param {string} downloadPath - 下载路径（可选）
 */
async function downloadWithChromeApi(url, filename, downloadPath = null, expectedIdentity) {
  assertInvoiceIdentity(expectedIdentity);
  if (!trustedDownloadUrl(url)) throw new Error('Untrusted invoice download URL');
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.downloads || !chrome.downloads.download) {
      reject(new Error('Chrome downloads API not available'));
      return;
    }

    const options = {
      url: url,
      saveAs: false
    };

    // 如果指定了下载路径，设置 filename（相对于默认下载目录的子路径）
    if (downloadPath) {
      // 清理路径，移除开头的斜杠和非法字符
      const cleanPath = downloadPath
        .replace(/^[\/\\]+/, '')
        .replace(/[<>:"|?*]/g, '_')
        .replace(/\/+/g, '/');

      // 组合路径和文件名
      const fullPath = cleanPath.endsWith('/')
        ? cleanPath + filename
        : cleanPath + '/' + filename;

      options.filename = fullPath;
    }

    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve({ downloadId, filename });
      }
    });
  });
}

/**
 * 从下载按钮获取实际的下载链接
 */
function getDownloadUrlFromButton(button) {
  if (!button) return null;

  // 直接获取 href 属性
  const href = button.href || button.getAttribute('href');
  if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
    return href;
  }

  // 检查 onclick 属性
  const onclick = button.onclick || button.getAttribute('onclick');
  if (onclick) {
    // 尝试从 onclick 中提取 URL
    const urlMatch = onclick.toString().match(/['"](https?:\/\/[^'"]+)['"]/);
    if (urlMatch) {
      return urlMatch[1];
    }
    // 尝试匹配相对路径
    const pathMatch = onclick.toString().match(/['"](\/[^'"]+)['"]/);
    if (pathMatch) {
      return window.location.origin + pathMatch[1];
    }
  }

  // 检查 data-url 或其他自定义属性
  const dataAttributes = ['data-url', 'data-href', 'data-link', 'data-download', 'data-src'];
  for (const attr of dataAttributes) {
    const value = button.getAttribute(attr);
    if (value) {
      return value.startsWith('http') ? value : window.location.origin + value;
    }
  }

  // 检查父元素是否有链接
  let parent = button.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    if (parent.tagName === 'A' && parent.href) {
      return parent.href;
    }
    parent = parent.parentElement;
  }

  return null;
}

/**
 * 在页面中尽量不点击按钮，直接探测可下载直链（避免弹窗/重定向拦截）
 * @param {"pdf"|"ofd"|"xml"|"auto"} format
 * @returns {string|null}
 */
function findDirectDownloadUrl(format = "auto") {
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const candidates = [];

  for (const a of anchors) {
    const href = (a.href || "").trim();
    if (!href) continue;

    // 限制：优先同源或可信域，避免跳广告域
    const isTrusted = trustedDownloadUrl(href);
    if (!isTrusted) continue;

    const lower = href.toLowerCase();
    const isPdf = lower.includes(".pdf") || lower.includes("pdf");
    const isOfd = lower.includes(".ofd") || lower.includes("ofd");
    const isXml = lower.includes(".xml") || lower.includes("xml");
    const looksLikeDownload =
      lower.includes("download") || lower.includes("export") || lower.includes("file");

    if (isPdf || isOfd || isXml || looksLikeDownload) {
      candidates.push({ href, isPdf, isOfd, isXml });
    }
  }

  if (candidates.length === 0) return null;

  const want =
    format === "auto"
      ? "pdf"
      : format === "pdf"
        ? "pdf"
        : format === "ofd"
          ? "ofd"
          : "xml";

  // 按格式优先级挑选
  const byFormat =
    want === "pdf"
      ? candidates.find((c) => c.isPdf)
      : want === "ofd"
        ? candidates.find((c) => c.isOfd)
        : candidates.find((c) => c.isXml);

  return (byFormat || (format === 'auto' ? candidates[0] : null))?.href || null;
}

/**
 * 下载发票
 * @param {string} format - 'pdf' | 'ofd' | 'xml' | 'auto'
 * @param {string} downloadPath - 下载路径（可选），相对于浏览器默认下载目录的子路径
 */
async function downloadInvoice(format = "auto", downloadPath = null, expectedIdentity) {
  try {
    // 等待页面加载完成，最多等待10秒
    let pageStatus = checkPageStatus();
    let waitTime = 0;
    const maxWaitTime = 10000;

    while (!pageStatus.loaded && waitTime < maxWaitTime) {
      await sleep(500);
      waitTime += 500;
      pageStatus = checkPageStatus();
    }

    // 如果页面加载失败，返回错误
    if (!pageStatus.loaded && pageStatus.error) {
      return {
        error: pageStatus.error,
        message: pageStatus.message,
      };
    }

    if (!pageStatus.loaded) throw new Error('Invoice page is not ready');
    assertInvoiceIdentity(expectedIdentity);

    // 方案A：优先找“直链”并用 chrome.downloads 触发下载（尽量不点击按钮，避免弹窗/重定向拦截）
    const directUrl = findDirectDownloadUrl(format);
    if (
      directUrl &&
      typeof chrome !== "undefined" &&
      chrome.downloads &&
      chrome.downloads.download
    ) {
      const actualFormat = format === 'auto' ? ['pdf', 'ofd', 'xml'].find(value => directUrl.toLowerCase().includes(value)) || 'unknown' : format;
      const ext = actualFormat === 'unknown' ? 'bin' : actualFormat;
      const filename = `发票_${new Date().toISOString().slice(0, 10)}.${ext}`;
      await downloadWithChromeApi(directUrl, filename, downloadPath, expectedIdentity);
      return {
        status: "downloading",
        format: actualFormat,
        directUrl,
        downloadPath: downloadPath || null,
        message: `已使用直链触发下载: ${filename}${downloadPath ? `，保存到: ${downloadPath}` : ""}`,
      };

    }

    // 查找下载按钮 - 使用更广泛的选择器
    const buttonSelectors = [
      ".logo-btn-area",
      ".download-area",
      ".btn-area",
      "[class*='download']",
      "[class*='btn-area']",
      ".invoice-actions",
      ".action-buttons",
      ".button-group",
      ".operate-area",
    ];

    let btnArea = null;
    for (const sel of buttonSelectors) {
      btnArea = document.querySelector(sel);
      if (btnArea) break;
    }

    // 如果没找到按钮区域，在整个文档中查找
    if (!btnArea) {
      btnArea = document.body;
    }

    // 查找所有下载链接 - 扩展匹配范围
    const allLinks = btnArea.querySelectorAll("a, button, .btn, [role='button']");
    const downloadLinks = [];

    for (const link of allLinks) {
      const text = link.textContent?.trim() ?? "";
      const title = link.title?.trim() ?? "";
      const className = link.className?.toLowerCase() ?? "";

      const isDownloadBtn =
        text.includes("下载PDF") ||
        text.includes("PDF文件") ||
        text.includes("下载OFD") ||
        text.includes("OFD文件") ||
        text.includes("下载XML") ||
        text.includes("XML文件") ||
        text.includes("下载发票") ||
        text === "下载" ||
        text === "PDF" ||
        text.includes("保存") ||
        title.includes("下载") ||
        className.includes("download") ||
        className.includes("save");

      if (isDownloadBtn) {
        downloadLinks.push({
          text,
          element: link,
          isPdf: text.toLowerCase().includes("pdf") || className.includes("pdf"),
          isOfd: text.toLowerCase().includes("ofd"),
          isXml: text.toLowerCase().includes("xml"),
        });
      }
    }

    if (downloadLinks.length === 0) {
      // 如果没找到明确的下载按钮，尝试查找任何包含下载链接的元素
      const allAnchors = document.querySelectorAll("a[href]");
      for (const anchor of allAnchors) {
        const href = anchor.href || "";
        if (href.includes("download") ||
            href.includes(".pdf") ||
            href.includes("export") ||
            anchor.textContent?.includes("下载")) {
          downloadLinks.push({
            text: anchor.textContent?.trim() || "下载链接",
            element: anchor,
            isPdf: href.includes(".pdf"),
            isOfd: href.includes(".ofd"),
            isXml: href.includes(".xml"),
          });
        }
      }
    }

    if (downloadLinks.length === 0) {
      return {
        error: "No download button found",
        message: "未找到下载按钮，请确认页面已完全加载",
        pageStatus: checkPageStatus(),
      };
    }

    // 根据格式选择要点击的按钮
    let linkToClick = null;

    if (format === "pdf" || format === "auto") {
      const pdfLink = downloadLinks.find((l) => l.isPdf);
      linkToClick = pdfLink || (format === 'auto' ? downloadLinks[0] : null);
    } else if (format === "ofd") {
      const ofdLink = downloadLinks.find((l) => l.isOfd);
      linkToClick = ofdLink;
    } else if (format === "xml") {
      const xmlLink = downloadLinks.find((l) => l.isXml);
      linkToClick = xmlLink;
    } else {
      linkToClick = downloadLinks[0];
    }

    if (!linkToClick) throw new Error('Requested invoice format is unavailable');
    assertInvoiceIdentity(expectedIdentity);
    // 获取下载链接
    const downloadUrl = getDownloadUrlFromButton(linkToClick.element);
    if (downloadUrl && !trustedDownloadUrl(downloadUrl)) throw new Error('Untrusted invoice download URL');
    const suggestedFilename = `发票_${new Date().toISOString().slice(0, 10)}.${linkToClick.isPdf ? 'pdf' : linkToClick.isOfd ? 'ofd' : linkToClick.isXml ? 'xml' : 'pdf'}`;

    // 方案B：只要能拿到 URL，就优先用 Chrome API（不依赖 downloadPath 是否提供）
    if (typeof chrome !== 'undefined' && chrome.downloads && downloadUrl) {
      await downloadWithChromeApi(downloadUrl, suggestedFilename, downloadPath, expectedIdentity);
      return {
        status: "downloading",
        format: format === "auto" ? (linkToClick.isPdf ? "pdf" : "unknown") : format,
        buttonText: linkToClick.text,
        downloadPath: downloadPath || null,
        message: `已触发下载: ${suggestedFilename}${downloadPath ? `，保存到: ${downloadPath}` : ""}`,
      };

    } else {
      // 点击下载按钮
      assertInvoiceIdentity(expectedIdentity);
      linkToClick.element.click();
    }

    // 等待下载开始
    await sleep(2000);

    return {
      status: "downloading",
      format: format === "auto" ? (linkToClick.isPdf ? "pdf" : "unknown") : format,
      buttonText: linkToClick.text,
      downloadPath: downloadPath || null,
      message: `已点击下载按钮: ${linkToClick.text}${downloadPath ? `，尝试保存到: ${downloadPath}` : ''}`,
    };

  } catch (error) {
    return {
      error: "Download failed",
      message: error.message,
    };
  }
}

/**
 * 获取发票信息
 */
function getInvoiceInfo() {
  try {
    const url = window.location.href;
    const title = document.title;

    // 获取页面状态
    const pageStatus = checkPageStatus();

    // 尝试提取发票信息
    const info = {
      url,
      title,
      isInvoicePage: isNuonuoInvoicePage(),
      pageStatus,
      context_identity: null,
      context_title: Array.from(String(title || 'Invoice page').replace(/\s+/g, ' ').trim()).slice(0, 60).join(''),
    };

    // 如果页面未加载成功，直接返回基本信息
    if (!pageStatus.loaded) {
      return info;
    }

    // 查找页面上可能的发票信息
    const bodyText = document.body?.textContent || "";

    // 尝试提取发票号码
    const invoiceNumberMatch = bodyText.match(/发票号码[：:]\s*(\d+)/);
    if (invoiceNumberMatch) {
      info.invoiceNumber = invoiceNumberMatch[1];
    }

    // 尝试提取数电号码（诺诺网数电发票）
    const digitalNumberMatch = bodyText.match(/数电号码[：:]\s*(\d+)/);
    if (digitalNumberMatch) {
      info.digitalNumber = digitalNumberMatch[1];
    }

    // 尝试提取发票代码
    const invoiceCodeMatch = bodyText.match(/发票代码[：:]\s*(\d+)/);
    if (invoiceCodeMatch) {
      info.invoiceCode = invoiceCodeMatch[1];
    }

    // 尝试提取发票金额（多种格式）
    const amountMatches = [
      bodyText.match(/合计金额[：:]\s*[￥¥]?(\d+\.?\d*)/),
      bodyText.match(/金额[：:]\s*[￥¥]?(\d+\.?\d*)/),
      bodyText.match(/[￥¥](\d+\.?\d*)/),
    ];
    for (const match of amountMatches) {
      if (match) {
        info.amount = match[1];
        break;
      }
    }

    // 尝试提取开票日期（多种格式）
    const dateMatches = [
      bodyText.match(/开票日期[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/),
      bodyText.match(/(\d{4}年\d{1,2}月\d{1,2}日)/),
      bodyText.match(/(\d{4}-\d{2}-\d{2})/),
    ];
    for (const match of dateMatches) {
      if (match) {
        info.date = match[1];
        break;
      }
    }

    // 尝试提取开票方
    const sellerMatch = bodyText.match(/开票方[：:]\s*([^\n]+)/) ||
                       bodyText.match(/销售方[：:]\s*([^\n]+)/);
    if (sellerMatch) {
      info.seller = sellerMatch[1].trim();
    }

    // 检查是否有下载按钮
    info.hasDownloadButton = pageStatus.hasDownloadBtn;
    if (info.isInvoicePage && (info.digitalNumber || info.invoiceNumber)) {
      info.context_identity = JSON.stringify([url, info.digitalNumber || '', info.invoiceCode || '', info.invoiceNumber || '']);
      info.context_title = Array.from('Invoice ' + (info.digitalNumber || info.invoiceNumber)).slice(0, 60).join('');
    }
    return info;
  } catch (error) {
    return {
      error: "Failed to get invoice info",
      message: error.message,
    };
  }
}

/**
 * 关闭当前标签页并返回QQ邮箱（如果是在新标签页打开）
 * 策略：优先返回之前的QQ邮箱标签页，不打开新标签
 */
async function closeAndReturnToQQMail() {
  try {
    // 策略1：如果有opener（从QQ邮箱打开的新窗口），关闭当前窗口回到原窗口
    if (window.opener && !window.opener.closed) {
      try {
        const openerUrl = window.opener.location.href;
        if (openerUrl.includes("mail.qq.com")) {
          window.close();
          return {
            status: "closed",
            message: "已关闭当前标签页并返回QQ邮箱",
          };
        }
      } catch (e) {
        // 跨域安全限制，无法访问opener
      }
    }

    // 策略2：通过history.back()返回（如果从QQ邮箱点击链接打开）
    if (document.referrer.includes("mail.qq.com")) {
      window.history.back();
      return {
        status: "navigating_back",
        message: "正在返回QQ邮箱（history.back）",
      };
    }

    // 策略3：查找并切换到QQ邮箱标签页（通过window.open找到原窗口）
    // 尝试多种可能的窗口名称
    const possibleWindowNames = ["qqmail_main", "mailqqcom", "", "QQMail"];
    for (const winName of possibleWindowNames) {
      try {
        const qqMailWindow = window.open("", winName);
        if (qqMailWindow && qqMailWindow !== window && !qqMailWindow.closed) {
          try {
            const winUrl = qqMailWindow.location.href;
            if (winUrl.includes("mail.qq.com")) {
              qqMailWindow.focus();
              window.close();
              return {
                status: "switched",
                message: "已切换到QQ邮箱标签页",
              };
            }
          } catch (e) {
            // 跨域限制
          }
        }
      } catch (e) {
        // window.open失败
      }
    }

    // 策略4：通过Broadcast Channel通知QQ邮箱页面（如果支持）
    try {
      const bc = new BroadcastChannel('nuonuo_invoice_channel');
      bc.postMessage({
        action: 'return_requested',
        url: window.location.href,
        timestamp: Date.now()
      });
      bc.close();
    } catch (e) {
      // Broadcast Channel 不支持
    }

    // 策略5：在noopener情况下，尝试通过window.name识别
    // 当QQ邮箱打开链接时，可以设置window.name = "nuonuo_invoice_window"
    if (window.name === "nuonuo_invoice_window") {
      // 尝试查找并聚焦到QQ邮箱窗口
      for (let i = 0; i < window.parent.frames.length; i++) {
        try {
          const frame = window.parent.frames[i];
          if (frame.location.href.includes("mail.qq.com")) {
            frame.focus();
            return {
              status: "switched_to_frame",
              message: "已切换到QQ邮箱框架",
            };
          }
        } catch (e) {}
      }
    }

    // 策略6：尝试通过 localStorage 设置标记，让QQ邮箱页面检测到
    try {
      localStorage.setItem('nuonuo_invoice_last_download', JSON.stringify({
        url: window.location.href,
        timestamp: Date.now(),
        completed: false
      }));
    } catch (e) {
      // localStorage 不可用
    }

    // 最后的备选：直接跳转（覆盖当前页面）
    window.location.replace("https://wx.mail.qq.com/");
    return {
      status: "navigating",
      message: "正在返回QQ邮箱（replace当前页面）",
    };
  } catch (error) {
    return {
      error: "Navigation failed",
      message: error.message,
    };
  }
}

/**
 * 自动下载并返回（完整流程）
 * @param {string} format - 'pdf' | 'ofd' | 'xml' | 'auto'
 * @param {string} downloadPath - 下载路径（可选），相对于浏览器默认下载目录的子路径
 */
async function autoDownloadAndReturn(format = "pdf", downloadPath = null, expectedIdentity) {
  // 首先检查页面状态
  const pageStatus = checkPageStatus();
  if (!pageStatus.loaded) {
    return {
      status: "page_not_ready",
      pageStatus,
      message: pageStatus.message || "页面尚未加载完成，请稍后再试",
    };
  }

  const downloadResult = await downloadInvoice(format, downloadPath, expectedIdentity);

  if (downloadResult.error) {
    return {
      status: "download_failed",
      error: downloadResult.error,
      message: downloadResult.message,
      pageStatus,
    };
  }

  await sleep(3000);
  let returnResult;
  try { assertInvoiceIdentity(expectedIdentity); returnResult = await closeAndReturnToQQMail(); }
  catch (error) { returnResult = { error: error.message }; }

  return {
    status: "download_requested",
    download: downloadResult,
    navigation: returnResult,
    message: `已请求下载发票；文件是否保存完成尚未核验。`,
  };
}

// 注册适配器
window.__webmcpRegister({
  name: "nuonuo-invoice-adapter",
  match: ["nnfp.jss.com.cn"],
  tools: [
    {
      name: "nnfp.jss.com.cn.get_invoice_info",
      description: "获取诺诺网发票页面的信息",
      parameters: { type: "object", properties: {}, required: [] },
      handler: () => getInvoiceInfo(),
    },
    {
      name: "nnfp.jss.com.cn.download_invoice",
      description: "点击下载按钮下载发票（PDF/OFD/XML）。支持指定下载路径。",
      parameters: {
        type: "object",
        properties: {
          expectedIdentity: { type: 'string', minLength: 1, description: 'Identity captured by get-invoice-info' },
          format: {
            type: "string",
            description: "下载格式：pdf、ofd、xml 或 auto（自动选择）",
            enum: ["pdf", "ofd", "xml", "auto"],
            default: "auto",
          },
          downloadPath: {
            type: "string",
            description: "下载路径（可选），相对于浏览器默认下载目录的子路径，例如：'invoices/2026-03' 或 '发票/三月'。如果不提供，则使用浏览器默认下载位置",
          },
        },
        required: [],
      },
      handler: async ({ format = "auto", downloadPath, expectedIdentity }) => downloadInvoice(format, downloadPath, expectedIdentity),
    },
    {
      name: "nnfp.jss.com.cn.auto_download_and_return",
      description: "自动下载发票并返回QQ邮箱（完整流程）。支持指定下载路径。",
      parameters: {
        type: "object",
        properties: {
          expectedIdentity: { type: 'string', minLength: 1, description: 'Identity captured by get-invoice-info' },
          format: {
            type: "string",
            description: "下载格式：pdf、ofd、xml 或 auto",
            enum: ["pdf", "ofd", "xml", "auto"],
            default: "pdf",
          },
          downloadPath: {
            type: "string",
            description: "下载路径（可选），相对于浏览器默认下载目录的子路径，例如：'invoices/2026-03' 或 '发票/三月'。如果不提供，则使用浏览器默认下载位置",
          },
        },
        required: [],
      },
      handler: async ({ format = "pdf", downloadPath, expectedIdentity }) => autoDownloadAndReturn(format, downloadPath, expectedIdentity),
    },
    {
      name: "nnfp.jss.com.cn.return_to_qqmail",
      description: "关闭当前页面并返回QQ邮箱",
      parameters: { type: "object", properties: {}, required: [] },
      handler: ({ expectedIdentity } = {}) => { assertInvoiceIdentity(expectedIdentity); return closeAndReturnToQQMail(); },
    },
  ],
});

// 注：避免在适配器中输出 console.log，减少噪音

  } finally {
    window.__webmcpRegister = previousRegister;
  }
  var tools = [];
  for (var i = 0; i < captured.length; i++) {
    var list = Array.isArray(captured[i].tools) ? captured[i].tools : [];
    for (var j = 0; j < list.length; j++) if (list[j] && typeof list[j].handler === 'function') tools.push(list[j]);
  }
  var support = window.__webmcpGeneratedSupport["nnfp.jss.com.cn"];
  if (support && Array.isArray(support.tools)) {
    for (var k = 0; k < support.tools.length; k++) if (support.tools[k] && typeof support.tools[k].handler === 'function') tools.push(support.tools[k]);
  }
  var byName = Object.create(null);
  for (var n = 0; n < tools.length; n++) {
    var tool = tools[n];
    var names = [tool.publicName, tool.name, tool.handlerName];
    for (var z = 0; z < names.length; z++) if (typeof names[z] === 'string' && names[z] && !byName[names[z]]) byName[names[z]] = tool;
  }
  window["__nnfp_jss_com_cn_internal"] = {
    invoke: async function (publicName, params) {
      var tool = byName[publicName];
      if (!tool || typeof tool.handler !== 'function') throw new Error('Legacy handler unavailable for ' + "nnfp.jss.com.cn" + '.' + publicName);
      return tool.handler(params || {});
    },
    names: Object.keys(byName)
  };
})();
