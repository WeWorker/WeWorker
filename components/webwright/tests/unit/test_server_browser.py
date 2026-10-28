from __future__ import annotations

from webwright.server import browser
from webwright.utils.local_cdp import normalize_page_url


def test_managed_status_and_tabs_do_not_start_browser(monkeypatch):
    calls = []
    class Control:
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            pass
        def request(self, action):
            calls.append(action)
            assert action == "status"
            return {"status": "stopped", "cdpReady": False}
    monkeypatch.setenv("WEWORKER_BROWSER_MANAGED", "1")
    monkeypatch.setattr(browser, "ManagedBrowser", Control)
    assert browser.browser_status()["available"] is False
    assert browser.browser_tabs() == {"tabs": []}
    assert calls == ["status", "status"]


def test_normalize_page_url_preserves_page_identity() -> None:
    assert normalize_page_url("HTTPS://Example.COM:443") == "https://example.com/"
    assert (
        normalize_page_url("https://Example.com/orders/?page=2#open")
        == "https://example.com/orders/?page=2#open"
    )


def test_browser_match_returns_first_exact_target(monkeypatch) -> None:
    monkeypatch.setattr(
        browser,
        "page_targets",
        lambda _cdp_url: [
            {"id": "first", "type": "page", "title": "First", "url": "https://example.com"},
            {"id": "second", "type": "page", "title": "Second", "url": "https://example.com/"},
        ],
    )

    result = browser.browser_match("http://127.0.0.1:9222", "https://example.com/")

    assert result["status"] == "exact"
    assert result["target"]["target_id"] == "first"


def test_browser_match_reports_same_origin_without_accepting_it(monkeypatch) -> None:
    monkeypatch.setattr(
        browser,
        "page_targets",
        lambda _cdp_url: [
            {
                "id": "home",
                "type": "page",
                "title": "Home",
                "url": "https://example.com/home",
            }
        ],
    )

    result = browser.browser_match("http://127.0.0.1:9222", "https://example.com/orders")

    assert result["status"] == "same_origin"
    assert result["target"]["target_id"] == "home"


def test_browser_open_launches_and_activates_first_target(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(browser, "launch_browser", lambda cdp_url: calls.append(("launch", cdp_url)))
    monkeypatch.setattr(
        browser,
        "page_targets",
        lambda _cdp_url: [
            {"id": "first", "type": "page", "title": "First", "url": "about:blank"}
        ],
    )
    monkeypatch.setattr(
        browser,
        "activate_target",
        lambda cdp_url, target_id: calls.append(("activate", f"{cdp_url}:{target_id}")),
    )

    result = browser.browser_open("http://127.0.0.1:9222")

    assert result["target"]["target_id"] == "first"
    assert calls == [
        ("launch", "http://127.0.0.1:9222"),
        ("activate", "http://127.0.0.1:9222:first"),
    ]


def test_browser_open_creates_and_activates_requested_url(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(browser, "launch_browser", lambda cdp_url: None)
    monkeypatch.setattr(browser, "page_targets", lambda _cdp_url: [])
    monkeypatch.setattr(
        browser,
        "create_page_target",
        lambda cdp_url, url: {
            "id": "created",
            "type": "page",
            "title": "",
            "url": url,
        },
    )
    monkeypatch.setattr(
        browser,
        "activate_target",
        lambda cdp_url, target_id: calls.append((cdp_url, target_id)),
    )

    result = browser.browser_open(
        "http://127.0.0.1:9222", "https://Example.com"
    )

    assert result["target"]["url"] == "https://example.com/"
    assert calls == [("http://127.0.0.1:9222", "created")]
