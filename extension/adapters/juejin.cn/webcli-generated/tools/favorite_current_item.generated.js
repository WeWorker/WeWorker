/**
 * Runtime DOM action for juejin.cn.favorite_current_item.
 *
 * This tool intentionally does not contain captured request URLs, tokens, user
 * identifiers, or item identifiers. It uses the current browser page and the
 * current signed-in session. The caller must obtain user confirmation before
 * invoking this side-effecting tool.
 */

(function registerGeneratedTool_juejin_cn_favorite_current_item() {
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

  function findFavoriteButton() {
    const suspendedButton = [...document.querySelectorAll('.article-suspended-panel .panel-btn')]
      .find((button) => button.querySelector?.('.icon-collect'));
    if (suspendedButton && isVisible(suspendedButton)) return suspendedButton;

    const candidates = [
      ...document.querySelectorAll('button, [role="button"], a, .action, .action-item, .panel-btn, .item, .collect'),
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
      return /收藏|\bcollect\b|favorite|star|icon-collect/i.test(haystack);
    }) || null;
  }

  function findVisibleCollectionModal() {
    return [...document.querySelectorAll('.collection-list-modal .byte-modal__content, .collection-list-modal .byte-modal__wrapper, .collection-list-modal .modal-wrap')]
      .find(isVisible) || null;
  }

  function findCollectionItem(collectionName) {
    const items = [...document.querySelectorAll('.collection-list-modal .list-item')].filter(isVisible);
    if (!items.length) return null;
    const expected = String(collectionName || '').trim();
    if (!expected) return items[0];
    return items.find((item) => visibleText(item).includes(expected)) || null;
  }

  function findConfirmButton() {
    return [...document.querySelectorAll('.collection-list-modal button, .collection-list-modal [role="button"], .collection-list-modal .confirm-btn, .collection-list-modal .byte-btn, .collection-list-modal div')]
      .filter(isVisible)
      .find((element) => visibleText(element) === '确定') || null;
  }

  function pageSubject() {
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    return {
      title: document.title || '',
      url: canonical || window.location.href,
    };
  }

  async function favoriteCurrentItem(args = {}) {
    const login = checkLoginStatus();
    if (!login.logged_in) {
      return {
        ok: false,
        code: 'LOGIN_REQUIRED',
        message: '请先在浏览器中登录 juejin.cn 后重试。',
        ...pageSubject(),
      };
    }

    const collectionName = String(args.collection_name || args.collectionName || '').trim();
    const button = findFavoriteButton();
    if (!button) {
      return {
        ok: false,
        code: 'ACTION_BUTTON_NOT_FOUND',
        message: '未找到当前页面的收藏按钮。',
        ...pageSubject(),
      };
    }

    const before = buttonState(button);
    if (before?.active) {
      return {
        ok: true,
        action: 'favorite',
        alreadyActive: true,
        message: '当前内容已经是收藏状态，未重复点击以避免取消收藏。',
        before,
        after: before,
        collectionName: collectionName || null,
        ...pageSubject(),
      };
    }

    button.click();
    await wait(1000);

    let selectedCollection = null;
    const modal = findVisibleCollectionModal();
    if (modal) {
      const collectionItem = findCollectionItem(collectionName);
      if (!collectionItem) {
        return {
          ok: false,
          code: 'COLLECTION_NOT_FOUND',
          message: collectionName ? `未找到收藏夹：${collectionName}` : '未找到可选择的收藏夹。',
          before,
          modalText: visibleText(modal),
          collectionName: collectionName || null,
          ...pageSubject(),
        };
      }
      selectedCollection = visibleText(collectionItem);
      collectionItem.click();
      await wait(300);

      const confirmButton = findConfirmButton();
      if (!confirmButton) {
        return {
          ok: false,
          code: 'COLLECTION_CONFIRM_NOT_FOUND',
          message: '已选择收藏夹，但未找到确认按钮。',
          before,
          selectedCollection,
          ...pageSubject(),
        };
      }
      confirmButton.click();
      await wait(1500);
    }

    const after = buttonState(button);
    const modalStillVisible = !!findVisibleCollectionModal();

    return {
      ok: !!after?.active && !modalStillVisible,
      action: 'favorite',
      message: after?.active ? '已收藏当前内容。' : '已尝试收藏当前内容，请核查页面状态。',
      before,
      after,
      selectedCollection,
      modalStillVisible,
      ...pageSubject(),
    };
  }

  registerTool(siteKey, {
    name: 'juejin.cn.favorite_current_item',
    description: '对当前打开的掘金内容执行收藏动作。需要用户已在浏览器登录，调用前必须获得用户确认。',
    parameters: {
      type: 'object',
      properties: {
        collection_name: {
          type: 'string',
          description: '可选。要收藏到的收藏夹名称；不传时选择弹窗中的第一个收藏夹。',
        },
      },
      required: [],
    },
    handler: (args) => favoriteCurrentItem(args),
  });
})();
