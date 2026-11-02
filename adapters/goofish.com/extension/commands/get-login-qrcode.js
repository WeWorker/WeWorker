/* v2 command goofish.com.get-login-qrcode: the login QR lives inside the
 * cross-origin login.taobao.com iframe that Alibaba's havana login embeds into
 * the goofish.com top frame, so the image itself is unreachable (docs §5.1
 * rect protocol). This command reports the iframe's page rect instead, and the
 * host crops its login-tab screenshot to that panel. Never clicks or fills
 * anything. The login panel mounts late on a cold SPA load — wait it out
 * (the Bridge allows auth_prepare_qr 30s for exactly this). */
(function () {
  var LOGIN_HOST_RE = /^(?:www\.)?goofish\.com$/;
  // The havana embedder points the iframe at login.taobao.com's member login;
  // the looser login-host fallback covers URL drift without matching ads.
  var IFRAME_SRC_RE = /^https:\/\/login(?:\.m)?\.taobao\.com\//;
  var LOGINISH_SRC_RE = /(?:login|passport|account|member)/i;

  function visible(element) {
    if (!element) return false;
    var style = getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  }

  // Alibaba components sometimes mount inside shadow roots, which a plain
  // document.querySelectorAll('iframe') cannot see.
  function deepIframes(root, found) {
    found = found || [];
    Array.prototype.forEach.call(root.querySelectorAll('iframe'), function (frame) { found.push(frame); });
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (element) {
      if (element.shadowRoot) deepIframes(element.shadowRoot, found);
    });
    return found;
  }

  function loginIframe() {
    var all = deepIframes(document);
    var exact = Array.prototype.find.call(all, function (frame) {
      return visible(frame) && IFRAME_SRC_RE.test(frame.src || '');
    });
    if (exact) return exact;
    return Array.prototype.find.call(all, function (frame) {
      if (!visible(frame)) return false;
      var rect = frame.getBoundingClientRect();
      return rect.width >= 200 && rect.height >= 200 && LOGINISH_SRC_RE.test(frame.src || '');
    }) || null;
  }

  // Havana's panel is a stable two-column layout — QR + caption left, account
  // form right (measured on the live panel: QR spans x 0.20-0.39, y 0.29-0.51).
  // Crop the left column; an unexpected aspect ratio (layout variant) keeps the
  // whole panel instead of risking a form-only or cut-off crop.
  function qrColumnRect(rect) {
    var aspect = rect.width / rect.height;
    if (!(aspect >= 0.9 && aspect <= 1.4)) return rect;
    return {
      x: Math.round(rect.x + rect.width * 0.02),
      y: Math.round(rect.y + rect.height * 0.05),
      width: Math.round(rect.width * 0.58),
      height: Math.round(rect.height * 0.9),
    };
  }

  __webcliRegisterCommand("get-login-qrcode", async function () {
    if (!LOGIN_HOST_RE.test(location.hostname)) return { found: false, reason: 'NOT_LOGIN_PAGE' };
    // The SPA mounts the login box seconds after the tab settles; on a cold
    // load with slow CDN chains this regularly exceeds 10s.
    var frame = loginIframe();
    for (var attempt = 0; attempt < 80 && (!frame || frame.getBoundingClientRect().width < 200); attempt += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      frame = loginIframe();
    }
    if (!frame) return { found: false, reason: 'LOGIN_IFRAME_NOT_FOUND' };
    var rect = frame.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 200) return { found: false, reason: 'LOGIN_IFRAME_NOT_SHOWN' };
    // Page coordinates: getBoundingClientRect is viewport-relative, the host
    // crops with captureBeyondViewport in document space.
    return {
      found: true,
      rect: qrColumnRect({
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }),
    };
  });
})();
