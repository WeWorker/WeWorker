/* v2 command mail.163.com.get-login-qrcode: precise QR extraction on the 163 mail
 * login page for the host login flow (auth.qr.command). Never fills or submits
 * credentials; the only interactions are the page's own QR refresh link, its
 * noScan 重新扫码 view switch, and a unique QR login switch. Selectors verified
 * against https://mail.163.com/ (index shell renders #loginBlock with the
 * .new-loginFunc switch bar, and mailscanlogin-1.3.2.js draws the QR as a
 * same-origin canvas inside #appCodeMain/.w-mc-appCode-wrap, with #appCodeRefresh
 * as the expired mask and .s-noScan-active hiding the QR while a phone
 * app-confirm is pending — #scanReScanBtn switches that view back). */
(function () {
  var LOGIN_HOST_RE = /^mail\.163\.com$/;
  // The shell may still mount late on a cold load; the worst-case stage sum
  // (6+5+8+5+4 = 28s) stays inside the Bridge's 30s auth_prepare_qr budget.
  var NO_SCAN_WAIT_MS = 6000;
  var SWITCH_WAIT_MS = 8000;
  var REFRESH_WAIT_MS = 5000;
  var RESOLVE_WAIT_MS = 4000;
  var POLL_MS = 200;

  function visible(element) {
    if (!element) return false;
    var style = getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // mailscanlogin mounts its panel inside #appCodeMain; the QR itself is the
  // canvas it draws (160px by default). The container-scoped and qr-labelled
  // fallbacks keep working if the page structure drifts.
  function currentQrElement() {
    var precise = document.querySelector('#appCodeMain canvas, .w-mc-appCode-wrap canvas');
    if (precise && visible(precise) && precise.getBoundingClientRect().width >= 100) return precise;
    var scope = document.querySelector('.w-mc-codeWrap');
    if (scope) {
      var scoped = Array.prototype.filter.call(scope.querySelectorAll('img, canvas'), function (element) {
        return visible(element) && element.getBoundingClientRect().width >= 100;
      });
      if (scoped.length) return scoped[0];
    }
    return null;
  }

  // After the phone form has been used to request an app confirmation, the page
  // swaps the QR for the noScan panel (.s-noScan-active hides .w-mc-codeWrap).
  // That panel's own 重新扫码 switch (#scanReScanBtn) is the designed way back
  // to the QR view — this is the page's view switch, never a login action.
  function noScanActive() {
    if (document.querySelector('.s-noScan-active')) return true;
    var wrap = document.querySelector('.w-mc-codeWrap');
    var noScan = document.querySelector('#noScanWrap, .w-mc-appLogin-noScan');
    return !!wrap && !!noScan && !visible(wrap) && visible(noScan);
  }

  async function leaveNoScanState() {
    if (!noScanActive()) return true;
    var rescan = document.querySelector('#scanReScanBtn, .w-mc-appLogin-noScan-switchBtn');
    if (!rescan || !visible(rescan)) return false;
    rescan.click();
    for (var waited = 0; waited < NO_SCAN_WAIT_MS && noScanActive(); waited += POLL_MS) {
      await sleep(POLL_MS);
    }
    return !noScanActive();
  }

  // A confirmed scan redirects to the mailbox on its own; there is nothing
  // scannable left, so let the host keep waiting instead of showing a QR.
  function loginConfirmInProgress() {
    var suc = document.querySelector('.w-mc-appLogin-scanSuc, .w-mc-txt-suc');
    return suc ? visible(suc) : false;
  }

  function maskVisible() {
    var mask = document.querySelector('#appCodeRefresh');
    return mask ? visible(mask) : false;
  }

  // Only the page's own refresh control is used, and only while the expired
  // mask (#appCodeRefresh — “二维码已失效 / 点击刷新”) is up.
  async function refreshExpiredQr() {
    if (!maskVisible()) return true;
    var link = document.querySelector('#appCodeRefresh a, .w-mc-codeRefresh-main a');
    if (!link) return false;
    link.click();
    for (var waited = 0; waited < REFRESH_WAIT_MS && maskVisible(); waited += POLL_MS) {
      await sleep(POLL_MS);
    }
    return !maskVisible();
  }

  // Switch to the QR view when the page opens on the phone-confirm form. The
  // shell's .new-loginFunc bar pins this to .new-loginFuncApp.qrcode-163-icon;
  // a unique, clearly-labelled 扫码登录 entry is the fallback. Nothing else is
  // touched — never the 立即登录 app-confirm button, never the password switch.
  function qrSwitchCandidate() {
    var pinned = document.querySelectorAll('.new-loginFuncApp.qrcode-163-icon, .qrcode-163-icon');
    if (pinned.length === 1 && visible(pinned[0])) return pinned[0];
    var nodes = document.querySelectorAll('.new-loginFunc [role="tab"], .new-loginFunc a, .new-loginFunc div, [role="tab"], button, a');
    var candidates = Array.prototype.filter.call(nodes, function (element) {
      if (!visible(element)) return false;
      var text = (element.textContent || '').replace(/\s+/g, '');
      return /(?:扫码|二维码)登录|扫码/.test(text) && !/(?:密码|短信|注册|找回|忘记|验证码|立即登录)/.test(text);
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function waitFor(qrElement, timeoutMs) {
    for (var waited = 0; waited < timeoutMs; waited += POLL_MS) {
      var element = qrElement || currentQrElement();
      if (element) return element;
      await sleep(POLL_MS);
    }
    return qrElement || currentQrElement();
  }

  async function qrImageOf(element) {
    try {
      if (element instanceof HTMLCanvasElement) return element.toDataURL('image/png');
      if (element instanceof HTMLImageElement) {
        var source = element.currentSrc || element.src || '';
        if (/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(source)) return source;
      }
    } catch (error) { /* Report found without an image; the host falls back to its screenshot. */ }
    return '';
  }

  __webcliRegisterCommand("get-login-qrcode", async function () {
    if (!LOGIN_HOST_RE.test(location.hostname)) return { found: false, reason: 'NOT_LOGIN_PAGE' };
    // The logged-in mailbox lives on the same host; only the login shell has
    // the switch bar. No shell (or a mailbox UI) means this is not a login page.
    if (!document.querySelector('.new-loginFunc, #loginBlock')) return { found: false, reason: 'NOT_LOGIN_PAGE' };
    // noScan (phone app-confirm pending) hides the QR: switch back with the
    // page's own 重新扫码 button. Only if that is impossible do we give up.
    if (!(await leaveNoScanState())) return { found: false, reason: 'QR_ALREADY_SCANNED' };
    if (loginConfirmInProgress()) return { found: false, reason: 'LOGIN_IN_PROGRESS' };
    if (!(await refreshExpiredQr())) return { found: false, reason: 'QR_REFRESH_FAILED' };

    var element = currentQrElement();
    if (!element) {
      var entry = qrSwitchCandidate();
      if (!entry) return { found: false, reason: 'QR_ENTRY_NOT_FOUND' };
      entry.click();
      element = await waitFor(null, SWITCH_WAIT_MS);
      if (!element) return { found: false, reason: 'QR_NOT_SHOWN_AFTER_SWITCH' };
    }
    // The switch can land on a stale token: refresh the expired mask once more,
    // then re-resolve — mailscanlogin may replace the canvas node it redraws in.
    if (maskVisible()) {
      if (!(await refreshExpiredQr())) return { found: false, reason: 'QR_REFRESH_FAILED' };
      element = await waitFor(null, RESOLVE_WAIT_MS);
      if (!element) return { found: false, reason: 'QR_NOT_SHOWN_AFTER_REFRESH' };
    }
    if (!visible(element)) return { found: false, reason: 'QR_NOT_SHOWN' };
    var image = await qrImageOf(element);
    return image ? { found: true, image_data_url: image } : { found: true };
  });
})();
