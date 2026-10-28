from __future__ import annotations

from typing import Any
from contextvars import ContextVar
from functools import wraps
from webwright.tool_runtime.managed_browser import ManagedBrowser, managed_browser_enabled

_browser_control = ContextVar("browser_control", default=None)


def _host_browser(*, start=False):
    def decorate(function):
        @wraps(function)
        def wrapped(cdp_url=DEFAULT_CDP_URL, *args, **kwargs):
            if not managed_browser_enabled():
                return function(cdp_url, *args, **kwargs)
            with ManagedBrowser() as control:
                if start:
                    control.acquire(visible=True)
                else:
                    control.descriptor = control.request("status")
                    if not control.descriptor.get("cdpUrl"):
                        if function.__name__ == "browser_status":
                            return {"available": False, "auto_start_enabled": True, "cdp_url": "", "browser": "", "web_socket_debugger_url": "", "error": "WeWorker 浏览器尚未启动"}
                        if function.__name__ == "browser_tabs":
                            return {"tabs": []}
                        if function.__name__ == "browser_match":
                            return {"status": "missing", "target": None}
                        return None
                token = _browser_control.set(control)
                try:
                    return function(control.http_url, *args, **kwargs)
                finally:
                    _browser_control.reset(token)
        return wrapped
    return decorate

from webwright.utils.local_cdp import (
    DEFAULT_CDP_URL,
    activate_target,
    create_page_target,
    ensure_page_target,
    find_target_by_id,
    get_json,
    launch_browser,
    normalize_page_url,
    page_origin,
    page_targets,
)


@_host_browser()
def browser_status(cdp_url: str = DEFAULT_CDP_URL) -> dict[str, Any]:
    try:
        payload = get_json(cdp_url, "/json/version")
    except Exception as exc:
        return {
            "available": False,
            "cdp_url": cdp_url,
            "auto_start_enabled": True,
            "browser": "",
            "web_socket_debugger_url": "",
            "error": str(exc),
        }
    if not isinstance(payload, dict):
        payload = {}
    return {
        "available": True,
        "cdp_url": cdp_url,
        "auto_start_enabled": True,
        "browser": payload.get("Browser", "Chrome/Edge"),
        "web_socket_debugger_url": payload.get("webSocketDebuggerUrl", ""),
    }


@_host_browser()
def browser_tabs(cdp_url: str = DEFAULT_CDP_URL) -> dict[str, list[dict[str, Any]]]:
    try:
        payload = page_targets(cdp_url)
    except Exception:
        return {"tabs": []}
    tabs: list[dict[str, Any]] = []
    for target in payload:
        if not isinstance(target, dict) or target.get("type") != "page":
            continue
        tabs.append(
            {
                "target_id": target.get("id", ""),
                "type": target.get("type", ""),
                "title": target.get("title", ""),
                "url": target.get("url", ""),
                "web_socket_debugger_url": target.get("webSocketDebuggerUrl", ""),
            }
        )
    return {"tabs": tabs}


@_host_browser(start=True)
def browser_open(cdp_url: str = DEFAULT_CDP_URL, url: str = "") -> dict[str, Any]:
    normalized = normalize_page_url(url) if url else ""
    if _browser_control.get() is None:
        launch_browser(cdp_url)
    targets = page_targets(cdp_url)
    target = None
    if normalized:
        for item in targets:
            try:
                if normalize_page_url(str(item.get("url") or "")) == normalized:
                    target = item
                    break
            except ValueError:
                continue
        if target is None:
            target = create_page_target(cdp_url, normalized)
    elif not targets:
        created = ensure_page_target(cdp_url)
        if created is not None:
            targets = [created]
    if target is None:
        target = targets[0] if targets else None
    if target is not None:
        if _browser_control.get():
            _browser_control.get().claim(str(target.get("id", "")))
        activate_target(cdp_url, str(target.get("id", "") or ""))
    return {
        "available": True,
        "cdp_url": cdp_url,
        "target": _target_view(target) if target is not None else None,
    }


@_host_browser()
def browser_match(cdp_url: str, url: str) -> dict[str, Any]:
    normalized = normalize_page_url(url)
    origin = page_origin(normalized)
    same_origin: list[dict[str, Any]] = []
    for target in page_targets(cdp_url):
        target_url = str(target.get("url", "") or "")
        try:
            normalized_target_url = normalize_page_url(target_url)
        except ValueError:
            continue
        view = _target_view(target)
        if normalized_target_url == normalized:
            return {"status": "exact", "target": view}
        if page_origin(normalized_target_url) == origin:
            same_origin.append(view)
    if same_origin:
        return {"status": "same_origin", "target": same_origin[0]}
    return {"status": "missing", "target": None}


@_host_browser()
def browser_target(cdp_url: str, target_id: str) -> dict[str, Any] | None:
    target = find_target_by_id(cdp_url, target_id)
    return _target_view(target) if target is not None else None


@_host_browser(start=True)
def browser_activate(cdp_url: str, target_id: str) -> None:
    if _browser_control.get():
        _browser_control.get().claim(target_id)
    activate_target(cdp_url, target_id)


def _target_view(target: dict[str, Any]) -> dict[str, Any]:
    return {
        "target_id": target.get("id", ""),
        "type": target.get("type", ""),
        "title": target.get("title", ""),
        "url": target.get("url", ""),
        "web_socket_debugger_url": target.get("webSocketDebuggerUrl", ""),
    }
