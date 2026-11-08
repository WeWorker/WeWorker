/* v2 command jd.com.buy-now: clicks the product's own 「立即购买」 and opens JD's checkout page.
 * Clicking only opens checkout; nothing is ordered or paid until pay-now. */
(function () {
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function text(el) { return el ? String(el.textContent || "").replace(/\s+/g, "") : ""; }
  function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function matchesProduct(sku) { return /^\d+$/.test(sku) && /^item\.jd\.(com|hk)$/.test(location.hostname) && location.pathname === "/" + sku + ".html"; }

  // The page header also shows 「立即购买」 on recommendation cards for other products.
  var FOREIGN = "#shortcut, .shortcut, li.shortcut_btn, .cross_platform_entry, .recommend, #J_recommend";
  // Current item page (2026): .bottom-btns-root; older pages: #bottom-btns.
  var AREAS = [".bottom-btns-root", "#bottom-btns", ".page-right-btns", "#choose-btns"];

  function buyArea() {
    for (var i = 0; i < AREAS.length; i++) {
      var area = document.querySelector(AREAS[i]);
      if (area && !area.closest(FOREIGN)) return area;
    }
    return null;
  }

  function buttonIn(area, pattern) {
    var candidates = Array.prototype.slice.call(area.querySelectorAll("div, a, button, span"));
    return candidates.find(function (el) {
      return pattern.test(text(el)) && !el.closest(FOREIGN)
        && !Array.prototype.some.call(el.children, function (child) { return pattern.test(text(child)); });
    }) || null;
  }

  function checkoutFrame() {
    return document.querySelector('iframe[src*="pc-settlement"], iframe[src*="trade.jd."], iframe[src*="settlement"]');
  }

  __webcliRegisterCommand("buy-now", async function (params) {
    if (!/^item\.jd\.(com|hk)$/.test(location.hostname)) {
      return { error: "Not on product page", message: "请先用 jd.com.open-product 打开商品页。" };
    }
    if (params && params.sku !== undefined && !matchesProduct(params.sku)) {
      return { error: "Product changed", message: "当前商品与所选 SKU 不一致，请重新打开所选商品。" };
    }
    var area = null, button = null;
    for (var i = 0; i < 20 && !button; i++) {
      area = buyArea();
      button = area && buttonIn(area, /^(立即购买|立即抢购|领券购买|立即下单)$/);
      if (!button) await sleep(250);
    }
    if (!button) {
      var labels = area ? Array.prototype.slice.call(area.querySelectorAll("div, a, button")).filter(function (el) { return !el.children.length && text(el) && visible(el); }).map(text).slice(0, 6) : [];
      return {
        error: "Buy button not found",
        message: labels.length
          ? "这个商品当前不能直接购买，页面上的按钮是：" + labels.join("、") + "（可能需要预约、到货通知或先选择规格）。"
          : "页面上没有找到该商品的「立即购买」按钮。",
        buttons: labels,
      };
    }
    if (button.disabled || /disabled|disable/i.test(button.className || "") || !visible(button)) {
      return { error: "Buy button unavailable", message: "「立即购买」按钮当前不可点击（可能需要先选择规格或商品已无货）。" };
    }

    if (params && params.sku !== undefined && !matchesProduct(params.sku)) return { error: "Product changed", message: "等待期间商品页面已切换，未执行购买。" };
    button.click();
    for (var j = 0; j < 32; j++) {
      await sleep(250);
      var frame = checkoutFrame();
      var src = frame && frame.getAttribute("src");
      if (src) {
        var url = new URL(src, location.href).href;
        // The host opens checkout as the page itself, so jd.com.pay-now runs there next.
        return {
          __webcli_navigation: {
            version: 1, url: url, resume: false,
            result: { status: "success", message: "已打开京东结算页（尚未下单）。需要支付时调用 jd.com.pay-now 并让用户选择支付方式。", checkoutUrl: url.replace(/\?.*$/, "") },
          },
        };
      }
    }
    var dialog = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"], .ui-dialog, [class*="modal"], [class*="Modal"], [class*="popup"]')).find(visible);
    return {
      status: "clicked",
      message: dialog
        ? "已点击「立即购买」，页面弹出了提示框：" + text(dialog).slice(0, 60) + "。请让用户在 WeWorker 浏览器中查看。"
        : "已点击「立即购买」，但 8 秒内没有出现结算页。请让用户在 WeWorker 浏览器中查看页面。",
      currentUrl: location.origin + location.pathname,
    };
  });
})();
