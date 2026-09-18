/**
 * Runtime DOM action for juejin.cn.like_current_item.
 *
 * This tool intentionally does not contain captured request URLs, tokens, user
 * identifiers, or item identifiers. It uses the current browser page and the
 * current signed-in session. The caller must obtain user confirmation before
 * invoking this side-effecting tool.
 */

(function registerGeneratedTool_juejin_cn_like_current_item() {
  const runtime = window.__webmcpGeneratedRuntime;
  if (!runtime) {
    throw new Error('Generated runtime not initialized before tool module injection');
  }

  const siteKey = 'juejin.cn';
  const { checkLoginStatus, registerTool } = runtime;

  function visibleText(element) {
    return String(element?.innerText || element?.textContent || element?.getAttribute?.('aria-label') || element?.title || '').trim();
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buttonState(button) {
    if (!button) return null;
    const icon = button.querySelector?.('svg');
    const style = icon ? window.getComputedStyle(icon) : null;
    return {
      className: button.className || '',
      badge: button.getAttribute?.('badge') || '',
      text: visibleText(button),
      active: /\bactive\b/.test(button.className || ''),
      iconClass: icon?.getAttribute?.('class') || '',
      color: style?.color || '',
      fill: style?.fill || '',
    };
  }

  function findLikeButton() {
    const suspendedButton = [...document.querySelectorAll('.article-suspended-panel .panel-btn')]
      .find((button) => button.querySelector?.('.icon-zan'));
    if (suspendedButton && isVisible(suspendedButton)) return suspendedButton;

    const candidates = [
      ...document.querySelectorAll('button, [role="button"], a, .action, .action-item, .panel-btn, .item, .like'),
    ];
    return candidates.find((element) => {
      if (!isVisible(element)) return false;
      const haystack = [
        visibleText(element),
        element.getAttribute?.('class') || '',
        element.getAttribute?.('aria-label') || '',
        element.getAttribute?.('title') || '',
        element.outerHTML || '',
      ].join(' ');
      return /点赞|\blike\b|digg|icon-zan/i.test(haystack);
    }) || null;
  }

  function pageSubject() {
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    return {
      title: document.title || '',
      url: canonical || window.location.href,
    };
  }

  async function likeCurrentItem() {
    const login = checkLoginStatus();
    if (!login.logged_in) {
      return {
        ok: false,
        code: 'LOGIN_REQUIRED',
        message: '请先在浏览器中登录 juejin.cn 后重试。',
        ...pageSubject(),
      };
    }

    const button = findLikeButton();
    if (!button) {
      return {
        ok: false,
        code: 'ACTION_BUTTON_NOT_FOUND',
        message: '未找到当前页面的点赞按钮。',
        ...pageSubject(),
      };
    }

    const before = buttonState(button);
    if (before?.active) {
      return {
        ok: true,
        action: 'like',
        alreadyActive: true,
        message: '当前内容已经是点赞状态，未重复点击以避免取消点赞。',
        before,
        after: before,
        ...pageSubject(),
      };
    }

    button.click();
    await wait(1200);
    const after = buttonState(button);

    return {
      ok: !!after?.active || before?.badge !== after?.badge,
      action: 'like',
      message: after?.active ? '已点赞当前内容。' : '已尝试点击点赞按钮，请核查页面状态。',
      before,
      after,
      ...pageSubject(),
    };
  }

  registerTool(siteKey, {
    name: 'juejin.cn.like_current_item',
    description: '对当前打开的掘金内容执行点赞动作。需要用户已在浏览器登录，调用前必须获得用户确认。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: () => likeCurrentItem(),
  });
})();
