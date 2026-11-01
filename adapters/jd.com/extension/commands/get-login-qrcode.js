/* v2 command jd.com.get-login-qrcode: precise QR extraction on the JD passport
 * login page for the host login flow (auth.qr.command). Never fills or submits
 * credentials; the only interactions are the page's own QR refresh and a unique
 * 扫码登录 switch. Selectors verified against passport.jd.com/new/login.aspx
 * (login.qrcode.2024.js renders the QR as a qr.m.jd.com/show img inside
 * #passport-main-qrcode-img, with an expired mask and a risk-control mask). */
(function () {
  var LOGIN_HOST_RE = /^(?:passport|aq)\.jd\.com$/;
  // The initial src is a static CDN placeholder; the real QR swaps in after the
  // page's login bundle runs.
  var PLACEHOLDER_RE = /360buyimg\.com\/imagetools/;

  function visible(element) {
    if (!element) return false;
    var style = getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  }

  function hintOf(element) {
    var cls = element.className;
    if (cls && cls.baseVal !== undefined) cls = cls.baseVal;
    return ((element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || '')
      + ' ' + (cls || '') + ' ' + (element.id || '')).replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // JD pins the QR to a dedicated img; the container-scoped and qr-labelled
  // fallbacks keep working if the page structure drifts.
  function currentQrElement() {
    var precise = document.querySelector('#passport-main-qrcode-img, .qrcode-img img');
    if (precise && visible(precise)) return precise;
    var scope = document.querySelector('.qrcode-login, .login-qrcode, .qrcode-main, #qrcode');
    if (scope) {
      var scoped = Array.prototype.filter.call(scope.querySelectorAll('img, canvas'), function (element) {
        return visible(element) && element.getBoundingClientRect().width >= 100;
      });
      if (scoped.length) return scoped[0];
    }
    return Array.prototype.find.call(document.querySelectorAll('img, canvas'), function (element) {
      if (!visible(element)) return false;
      var rect = element.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 100 && /(?:qr|qrcode|二维码|扫码)/i.test(hintOf(element));
    }) || null;
  }

  function maskOf(maskSelector) {
    var mask = document.querySelector(maskSelector);
    return mask && visible(mask) ? mask : null;
  }

  function waitUntilShown(img) {
    var source = function () { return img.currentSrc || img.src || ''; };
    return (async function () {
      for (var attempt = 0; attempt < 40; attempt += 1) {
        if (img.complete && img.naturalWidth > 0 && !PLACEHOLDER_RE.test(source())) return true;
        await sleep(200);
      }
      return false;
    })();
  }

  function readBlobAsDataUrl(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { resolve(''); };
      reader.readAsDataURL(blob);
    });
  }

  // qr.m.jd.com sends Access-Control-Allow-Origin: https://passport.jd.com with
  // credentials, and the page's 3s poll re-reads its wlfstk_smdl token cookie
  // every cycle, so a credentialed re-fetch of the displayed src stays in sync
  // with what the tab is polling.
  function remoteImageAsDataUrl(url) {
    return (async function () {
      if (!/^https?:/i.test(url)) return '';
      try {
        var response = await fetch(url, { credentials: 'include' });
        if (response && response.ok) {
          var blob = await response.blob();
          if (blob && /^image\//.test(blob.type) && blob.size > 0 && blob.size <= 2000000) {
            var fetched = await readBlobAsDataUrl(blob);
            if (fetched) return fetched;
          }
        }
      } catch (error) { /* fall through to the anonymous canvas copy */ }
      return new Promise(function (resolve) {
        var copy = new Image();
        copy.crossOrigin = 'anonymous';
        copy.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = copy.naturalWidth;
            canvas.height = copy.naturalHeight;
            canvas.getContext('2d').drawImage(copy, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          } catch (error) { resolve(''); }
        };
        copy.onerror = function () { resolve(''); };
        copy.src = url;
      });
    })();
  }

  async function qrImageOf(element) {
    try {
      if (element instanceof HTMLCanvasElement) return element.toDataURL('image/png');
      if (element instanceof HTMLImageElement) {
        var source = element.currentSrc || element.src || '';
        if (/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(source)) return source;
        return remoteImageAsDataUrl(source);
      }
    } catch (error) { /* Report found without an image; the host falls back to its screenshot. */ }
    return '';
  }

  // Only JD's own refresh control is used, and only when the expired mask is up.
  async function refreshExpiredQr() {
    var mask = maskOf('.qrcode-error-2016, #J-qrcoderror');
    if (!mask) return true;
    var button = document.querySelector('.qrcode-error-2016 .refresh-btn, #J-qrcoderror .refresh-btn');
    if (!button) return false;
    button.click();
    for (var attempt = 0; attempt < 30 && maskOf('.qrcode-error-2016, #J-qrcoderror'); attempt += 1) {
      await sleep(200);
    }
    return !maskOf('.qrcode-error-2016, #J-qrcoderror');
  }

  // Switch to the QR tab when the page opens on another login mode. Only a
  // unique, clearly-labelled 扫码登录 entry is clicked; nothing else is touched.
  function qrSwitchCandidate() {
    var nodes = document.querySelectorAll('.login-tab a, .login-tab, [role="tab"], a, button');
    var candidates = Array.prototype.filter.call(nodes, function (element) {
      if (!visible(element)) return false;
      var text = (element.textContent || '').replace(/\s+/g, '');
      return /(?:扫码|二维码)登录/.test(text) && !/(?:密码|短信|注册|找回|忘记|验证码)/.test(text);
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  __webcliRegisterCommand("get-login-qrcode", async function () {
    if (!LOGIN_HOST_RE.test(location.hostname)) return { found: false, reason: 'NOT_LOGIN_PAGE' };
    if (maskOf('.qrcode-error-fengkong')) return { found: false, reason: 'QR_RISK_CONTROL' };
    if (!(await refreshExpiredQr())) return { found: false, reason: 'QR_REFRESH_FAILED' };

    var element = currentQrElement();
    if (!element) {
      var entry = qrSwitchCandidate();
      if (!entry) return { found: false, reason: 'QR_ENTRY_NOT_FOUND' };
      entry.click();
      for (var attempt = 0; attempt < 25 && !element; attempt += 1) {
        await sleep(200);
        element = currentQrElement();
      }
      if (!element) return { found: false, reason: 'QR_NOT_SHOWN_AFTER_SWITCH' };
    }
    if (element instanceof HTMLImageElement && !(await waitUntilShown(element))) {
      return { found: false, reason: 'QR_NOT_SHOWN' };
    }
    var image = await qrImageOf(element);
    return image ? { found: true, image_data_url: image } : { found: true };
  });
})();
