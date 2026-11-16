from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from webwright.environments.local_browser import LocalBrowserEnvironment


def managed_environment(monkeypatch, tmp_path, *, live_target=True, **config):
    from webwright.environments import local_browser
    from webwright.tool_runtime import managed_browser

    def page(target, url):
        result = SimpleNamespace(
            target=target, url=url, on=Mock(), close=AsyncMock(), is_closed=lambda: False,
            locator=lambda selector: SimpleNamespace(
                text_content=AsyncMock(return_value="Example"),
                aria_snapshot=AsyncMock(return_value="- heading: Example"),
            ),
        )

        async def navigate(url, **kwargs):
            result.url = url

        result.goto = AsyncMock(side_effect=navigate)
        return result

    # The same URL in an unrelated user tab must never make it a recovery target.
    unrelated = page("user-page", "https://example.com/orders")
    bound = page("saved-page", "https://example.com/orders")
    fresh = page("fresh-page", "about:blank")
    context = SimpleNamespace(
        pages=[unrelated, bound] if live_target else [unrelated],
        new_page=AsyncMock(return_value=fresh),
        set_default_timeout=Mock(), set_default_navigation_timeout=Mock(), close=AsyncMock(),
    )
    browser = SimpleNamespace(contexts=[context], is_connected=lambda: True, close=AsyncMock())
    playwright = SimpleNamespace(
        chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)), stop=AsyncMock(),
    )
    control = SimpleNamespace(
        descriptor={"instanceId": "current-browser"}, http_url="http://127.0.0.1:12345",
        acquire=Mock(), watch_current_task=Mock(), claim=Mock(), close=Mock(),
    )
    monkeypatch.setattr(managed_browser, "managed_browser_enabled", lambda: True)
    monkeypatch.setattr(managed_browser, "ManagedBrowser", lambda: control)
    monkeypatch.setattr("playwright.async_api.async_playwright", lambda: SimpleNamespace(start=AsyncMock(return_value=playwright)))
    monkeypatch.setattr(local_browser, "_ensure_local_cdp_page_target", lambda *_: None)
    find_target = Mock(return_value={"id": "saved-page", "url": bound.url} if live_target else None)
    monkeypatch.setattr(local_browser, "_find_cdp_target_by_id", find_target)
    monkeypatch.setattr(local_browser, "_local_cdp_page_targets", lambda *_: [{"id": p.target} for p in context.pages])
    monkeypatch.setattr(local_browser, "_find_new_cdp_target", lambda *_: None)
    environment_config = dict(
        output_dir=tmp_path, browser_mode="local_cdp", start_url="https://example.com/",
        allowed_domains=["example.com"], resume_existing_page=True, resume_existing_output=True,
    )
    env = LocalBrowserEnvironment(**(environment_config | config))
    monkeypatch.setattr(env, "_target_id_for_page", AsyncMock(side_effect=lambda context, page: page.target))
    monkeypatch.setattr(env, "_ensure_local_cdp_browser", Mock(side_effect=AssertionError("host must acquire the browser")))
    return SimpleNamespace(env=env, control=control, context=context, browser=browser,
                           playwright=playwright, unrelated=unrelated, bound=bound, fresh=fresh,
                           find_target=find_target)


@pytest.mark.parametrize("saved_instance,target,live_target,reason", [
    ("old-browser", "saved-page", True, "browser_instance_changed"),
    ("current-browser", "saved-page", False, "saved_page_closed"),
    ("", "saved-page", True, "saved_page_binding_unavailable"),
    ("current-browser", "", True, "saved_page_binding_unavailable"),
])
def test_managed_resume_recovers_on_owned_page_without_reusing_user_tabs(
    monkeypatch, tmp_path, saved_instance, target, live_target, reason,
):
    state = managed_environment(monkeypatch, tmp_path, live_target=live_target)
    steps = state.env._steps_dir()
    steps.mkdir(parents=True)
    prior_step = steps / "step_0003.py"
    prior_step.write_text("print('prior evidence')", encoding="utf-8")
    try:
        state.env.prepare(resume_target_id=target, resume_browser_instance_id=saved_instance,
                          resume_last_url="https://example.com/orders", resume_last_title="Example")
        assert state.env._page is state.fresh
        state.context.new_page.assert_awaited_once()
        state.fresh.goto.assert_awaited_once_with("https://example.com/orders", wait_until="domcontentloaded")
        state.bound.goto.assert_not_awaited()
        state.unrelated.goto.assert_not_awaited()
        state.control.claim.assert_called_once_with("fresh-page")
        state.playwright.chromium.connect_over_cdp.assert_awaited_once_with(state.control.http_url)
        if saved_instance != "current-browser" or not target:
            state.find_target.assert_not_called()
        runtime = state.env.serialize()["environment"]["runtime_state"]
        assert runtime["browser_instance_id"] == "current-browser"
        assert runtime["target_id"] == "fresh-page"
        assert state.env._step_index == 3
        assert prior_step.read_text(encoding="utf-8") == "print('prior evidence')"
        observation = state.env.initial_observation()
        assert observation["browser_recovery"] == reason
        assert observation["url"] == "https://example.com/orders"
        state.env._step_index = 1
        assert state.env._with_initial_navigation("print(page.url)") == "print(page.url)"
    finally:
        state.env.close()
    state.control.close.assert_called_once()
    state.playwright.stop.assert_awaited_once()
    state.unrelated.close.assert_not_awaited()
    state.bound.close.assert_not_awaited()
    state.browser.close.assert_not_awaited()
    state.context.close.assert_not_awaited()


def test_managed_resume_keeps_live_page_and_form_state(monkeypatch, tmp_path):
    state = managed_environment(monkeypatch, tmp_path)
    try:
        state.env.prepare(resume_target_id="saved-page", resume_browser_instance_id="current-browser",
                          resume_last_url="https://example.com/orders")
        assert state.env._page is state.bound
        state.context.new_page.assert_not_awaited()
        state.bound.goto.assert_not_awaited()
        state.control.claim.assert_called_once_with("saved-page")
        assert "browser_recovery" not in state.env.initial_observation()
    finally:
        state.env.close()


def test_resume_uses_the_confirmed_binding_after_recovery_was_blocked(monkeypatch, tmp_path):
    state = managed_environment(monkeypatch, tmp_path, expected_browser_instance_id="current-browser")
    try:
        # The trajectory still refers to the browser used before recovery.
        state.env.prepare(resume_target_id="saved-page", resume_browser_instance_id="old-browser")
        assert state.env._page is state.bound
        state.context.new_page.assert_not_awaited()
        state.bound.goto.assert_not_awaited()
        state.control.claim.assert_called_once_with("saved-page")
    finally:
        state.env.close()


@pytest.mark.parametrize("saved_url", [
    "about:blank", "chrome://settings/", "file:///example.txt", "javascript:alert(1)",
    "https://other.example.org/", "https://placeholder:placeholder@example.com/", "https://[invalid",
])
def test_recovery_navigation_preserves_allowed_domain_scope(monkeypatch, tmp_path, saved_url):
    state = managed_environment(monkeypatch, tmp_path)
    try:
        state.env.prepare(resume_target_id="saved-page", resume_browser_instance_id="old-browser",
                          resume_last_url=saved_url)
        state.fresh.goto.assert_awaited_once_with("https://example.com/", wait_until="domcontentloaded")
    finally:
        state.env.close()


@pytest.mark.parametrize("target_type", ["initial_target_id", "replay_target_id"])
def test_managed_binding_check_stays_strict_for_initial_and_replay_targets(monkeypatch, tmp_path, target_type):
    state = managed_environment(monkeypatch, tmp_path)
    try:
        with pytest.raises(RuntimeError, match="浏览器实例已变化"):
            state.env.prepare(**{target_type: "saved-page"}, resume_browser_instance_id="old-browser")
        state.context.new_page.assert_not_awaited()
        state.find_target.assert_not_called()
        state.control.close.assert_called_once()
    finally:
        state.env.close()


def test_resume_does_not_replace_a_busy_live_page(monkeypatch, tmp_path):
    state = managed_environment(monkeypatch, tmp_path)
    state.control.claim.side_effect = RuntimeError("Page is busy")
    try:
        with pytest.raises(RuntimeError, match="Page is busy"):
            state.env.prepare(resume_target_id="saved-page", resume_browser_instance_id="current-browser")
        state.context.new_page.assert_not_awaited()
        state.bound.goto.assert_not_awaited()
        state.control.close.assert_called_once()
    finally:
        state.env.close()


def test_recovery_without_a_safe_url_releases_ownership_without_navigation(monkeypatch, tmp_path):
    from webwright.exceptions import RuntimeExecutionError

    state = managed_environment(monkeypatch, tmp_path, start_url="file:///example.txt")
    try:
        with pytest.raises(RuntimeExecutionError) as caught:
            state.env.prepare(resume_target_id="saved-page", resume_browser_instance_id="old-browser",
                              resume_last_url="https://other.example.org/")
        assert caught.value.error_code == "browser_resume_url_unavailable"
        state.fresh.goto.assert_not_awaited()
        state.control.close.assert_called_once()
    finally:
        state.env.close()


def test_recovery_navigation_failure_releases_the_host_claim(monkeypatch, tmp_path):
    from playwright.async_api import Error as PlaywrightError

    state = managed_environment(monkeypatch, tmp_path)
    state.fresh.goto.side_effect = PlaywrightError("net::ERR_NAME_NOT_RESOLVED")
    try:
        with pytest.raises(PlaywrightError, match="ERR_NAME_NOT_RESOLVED"):
            state.env.prepare(resume_target_id="saved-page", resume_browser_instance_id="old-browser")
        state.fresh.goto.assert_awaited_once()
        state.control.close.assert_called_once()
        state.unrelated.close.assert_not_awaited()
        state.browser.close.assert_not_awaited()
    finally:
        state.env.close()


def test_run_one_recovers_saved_history_and_persists_the_new_binding(monkeypatch, tmp_path):
    from webwright.run.cli import run_one

    state = managed_environment(monkeypatch, tmp_path)
    trajectory_path = tmp_path / "trajectory.json"
    trajectory_path.write_text(json.dumps({
        "info": {"api_calls": 4},
        "environment": {
            "config": {"browser_mode": "local_cdp", "start_url": "https://example.com/",
                       "allowed_domains": ["example.com"]},
            "runtime_state": {"browser_instance_id": "old-browser", "target_id": "saved-page",
                              "last_url": "https://example.com/orders"},
        },
        "messages": [
            {"role": "system", "content": "Inspect the example site"},
            {"role": "user", "content": "Task: Inspect orders"},
            {"role": "assistant", "content": "Previously submitted the form", "extra": {
                "actions": [{"python_code": "await page.get_by_text('Submit').click()"}], "done": False,
            }},
            {"role": "exit", "content": "Browser closed"},
        ],
    }), encoding="utf-8")
    model = SimpleNamespace(
        format_message=lambda **kwargs: {"role": kwargs["role"], "content": kwargs.get("content", ""), "extra": kwargs.get("extra", {})},
        get_template_vars=lambda **kwargs: {},
        serialize=lambda: {"model": {"config": {}, "usage": {}, "model_type": "fake"}},
        query=Mock(return_value={"role": "assistant", "content": "Recovered", "extra": {
            "actions": [], "done": True, "final_response": "Recovered exploration",
        }}),
    )
    monkeypatch.setattr("webwright.run.cli.get_model", lambda config: model)
    monkeypatch.setattr("webwright.run.cli.get_environment", lambda config: state.env)
    monkeypatch.setattr(state.env, "execute", Mock(side_effect=AssertionError("saved actions must not replay")))
    result = run_one(resume_from=tmp_path, followup="Continue inspecting orders", snapshot_config=False,
                     config_spec=["base.yaml", "local_browser.yaml", "model_openai.yaml"])
    assert result["final_response"] == "Recovered exploration"
    state.env.execute.assert_not_called()
    state.control.close.assert_called_once()
    saved = json.loads(trajectory_path.read_text(encoding="utf-8"))
    assert saved["info"]["api_calls"] == 5
    assert saved["environment"]["runtime_state"]["browser_instance_id"] == "current-browser"
    assert saved["environment"]["runtime_state"]["target_id"] == "fresh-page"
    assert any(message.get("content") == "Task: Inspect orders" for message in saved["messages"])
    observed = next(message for message in saved["messages"] if message.get("extra", {}).get("interrupt_type") == "ResumeBrowserObservation")
    assert "new task-owned page" in observed["content"]
    assert observed["extra"]["observation"]["url"] == "https://example.com/orders"
