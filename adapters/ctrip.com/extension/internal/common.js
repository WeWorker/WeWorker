(function () {
  function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    throw error;
  }

  function integer(name, value, fallback, minimum, maximum) {
    const raw = value === undefined ? fallback : value;
    // CLI scalar flags remain strings; normalize only this Adapter numeric field.
    const candidate = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
      fail("INVALID_ARGS", `${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return candidate;
  }

  function positiveInteger(name, value) {
    return integer(name, value, undefined, 1, Number.MAX_SAFE_INTEGER);
  }

  function date(name, value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail("INVALID_ARGS", `${name} must use YYYY-MM-DD`);
    }
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      fail("INVALID_ARGS", `${name} is not a real calendar date`);
    }
    return value;
  }

  function iata(name, value) {
    const result = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(result)) fail("INVALID_ARGS", `${name} must be a 3-letter IATA city or airport code (e.g. 北京=BJS, 上海=SHA); Chinese city names are not accepted`);
    return result;
  }

  function place(name, value) {
    const result = typeof value === "string" ? value.trim() : "";
    if (!result || result.length > 20 || /[\x00-\x1f]/.test(result)) fail("INVALID_ARGS", `${name} must be a valid place name`);
    return result;
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function text(element) {
    return element ? clean(element.textContent) : "";
  }

  function hasCaptcha() {
    return location.pathname.includes("captcha") || /验证码|verify the human|安全验证|访问验证/i.test(document.body?.innerText || "");
  }

  function sameUrl(targetUrl) {
    const current = new URL(location.href);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname.replace(/\/$/, "") === target.pathname.replace(/\/$/, "") && current.search === target.search;
  }

  function navigate(targetUrl, message, resume = true) {
    return { __webcli_navigation: { version: 1, url: targetUrl, resume,
      ...(resume ? {} : { result: { status: "login_required", message, url: targetUrl } }) } };
  }

  function waitFor(detect, timeoutMs) {
    const initial = detect();
    if (initial) return Promise.resolve(initial);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const result = detect();
        if (!result) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(result);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve("timeout");
      }, timeoutMs);
    });
  }

  async function scrollUntil(selector, target, maximumScrolls) {
    const visibleCount = () => Array.from(document.querySelectorAll(selector)).filter((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0;
    }).length;
    let previous = visibleCount();
    let plateaus = 0;
    for (let index = 0; index < maximumScrolls && previous < target; index += 1) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const next = visibleCount();
      plateaus = next === previous ? plateaus + 1 : 0;
      previous = next;
      if (plateaus >= 2) break;
    }
    return visibleCount();
  }

  window.__ctrip_com_common = { fail, integer, positiveInteger, date, iata, place, clean, text, hasCaptcha, sameUrl, navigate, waitFor, scrollUntil };
})();
