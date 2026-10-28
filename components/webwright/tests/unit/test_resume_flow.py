from __future__ import annotations

import json
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from webwright.agents.default import DefaultAgent
from webwright.environments.local_browser import LocalBrowserEnvironment
from webwright.environments.local_workspace import LocalWorkspaceEnvironment
from webwright.run.cli import run_one
from webwright.utils.trajectory import build_resume_state, load_trajectory, resolve_trajectory_path


@pytest.mark.parametrize("url,allowed", [
    ("https://example.com/orders?page=2#open", True),
    ("https://auth.example.com/signed-in", True),
    ("https://other.example.org/", False),
])
def test_prepared_exploration_page_keeps_current_state(monkeypatch, tmp_path, url, allowed):
    from webwright.environments import local_browser
    monkeypatch.delenv("WEWORKER_BROWSER_MANAGED", raising=False)
    page = SimpleNamespace(url=url, goto=AsyncMock(), on=Mock())
    context = SimpleNamespace(set_default_timeout=Mock(), set_default_navigation_timeout=Mock())
    browser = SimpleNamespace(contexts=[context])
    playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)))
    monkeypatch.setattr("playwright.async_api.async_playwright", lambda: SimpleNamespace(start=AsyncMock(return_value=playwright)))
    monkeypatch.setattr(local_browser, "_ensure_local_cdp_page_target", lambda *_: None)
    monkeypatch.setattr(local_browser, "_find_cdp_target_by_id", lambda *_: {"id": "selected", "url": url})
    monkeypatch.setattr(local_browser, "_activate_cdp_target", lambda *_: None)
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp",
                                  start_url="https://example.com/", allowed_domains=["example.com", "auth.example.com"])
    monkeypatch.setattr(env, "_ensure_local_cdp_browser", lambda: None)
    monkeypatch.setattr(env, "_match_page_in_context", AsyncMock(return_value=(page, "cdp_target_id")))
    monkeypatch.setattr(env, "_target_id_for_page", AsyncMock(return_value="selected"))
    # Exercise binding and navigation without the unrelated cleanup transport.
    monkeypatch.setattr(env, "_prepare_async", env._prepare_connected_async)
    if not allowed:
        with pytest.raises(RuntimeError, match="允许域名"):
            env.prepare(initial_target_id="selected")
        env._match_page_in_context.assert_not_awaited()
        return
    env.prepare(initial_target_id="selected")
    page.goto.assert_not_awaited()
    env._step_index = 1
    assert env._with_initial_navigation("print(page.url)") == "print(page.url)"
    assert env._page.url == url


class FakeModel:
    def __init__(self):
        self.queries: list[list[dict]] = []

    def format_message(self, **kwargs):
        return {
            "role": kwargs["role"],
            "content": kwargs.get("content", ""),
            "extra": kwargs.get("extra", {}),
        }

    def query(self, messages, **kwargs):
        self.queries.append(messages)
        return self.format_message(
            role="assistant",
            content="done",
            extra={"actions": [], "done": True, "final_response": "resumed ok"},
        )

    def get_template_vars(self, **kwargs):
        return {}

    def serialize(self):
        return {"model": {"config": {}, "usage": {}, "model_type": "fake"}}


class FakeEnv:
    def __init__(self):
        self.prepared: list[dict] = []

    def prepare(self, **kwargs):
        self.prepared.append(kwargs)

    def execute(self, action, cwd: str = ""):
        raise AssertionError("execute should not be called in this test")

    def get_template_vars(self, **kwargs):
        return {"workspace_dir": "/tmp/workspace"}

    def serialize(self):
        return {"environment": {"config": {}, "environment_type": "fake"}}

    def close(self):
        return None


def test_build_resume_state_infers_task() -> None:
    trajectory = {
        "info": {
            "api_calls": 3,
            "format_errors": 1,
            "consecutive_format_errors": 1,
            "config": {"agent": {"step_limit": 10}},
        },
        "environment": {
            "config": {
                "browser_mode": "local_cdp",
                "start_url": "https://mail.163.com",
                "local_cdp_url": "http://127.0.0.1:9222",
            },
            "runtime_state": {
                "target_id": "target-123",
                "last_url": "https://mail.163.com/inbox",
                "last_title": "Inbox",
            },
        },
        "messages": [
            {"role": "system", "content": "sys", "extra": {}},
            {"role": "user", "content": "Task: Search inbox\nTask ID: demo", "extra": {}},
        ],
    }

    state = build_resume_state(trajectory)

    assert state["task"] == "Search inbox"
    assert state["n_calls"] == 3
    assert state["n_format_errors"] == 1
    assert state["n_consecutive_format_errors"] == 1
    assert state["environment_config"]["browser_mode"] == "local_cdp"
    assert state["environment_runtime_state"]["target_id"] == "target-123"


def test_load_trajectory_rejects_bad_json(tmp_path: Path) -> None:
    path = tmp_path / "trajectory.json"
    path.write_text("{not-json}", encoding="utf-8")

    with pytest.raises(ValueError, match="Could not parse trajectory JSON"):
        load_trajectory(path)


def test_resolve_trajectory_path_accepts_run_directory(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    trajectory_path = run_dir / "trajectory.json"
    trajectory_path.write_text("{}", encoding="utf-8")

    assert resolve_trajectory_path(run_dir) == trajectory_path.resolve()


def test_agent_resume_drops_exit_and_appends_followup(tmp_path: Path) -> None:
    model = FakeModel()
    env = FakeEnv()
    output_path = tmp_path / "trajectory.json"
    agent = DefaultAgent(
        model,
        env,
        system_template="System: {{ task }}",
        instance_template="Task: {{ task }}",
        output_path=output_path,
    )

    prior_state = {
        "messages": [
            {"role": "system", "content": "System: Search inbox", "extra": {}},
            {"role": "user", "content": "Task: Search inbox", "extra": {}},
            {
                "role": "assistant",
                "content": "inspect prior page",
                "extra": {
                    "done": False,
                    "actions": [{"python_code": "print('prior page')"}],
                    "final_response": "",
                },
            },
            {"role": "exit", "content": "completed", "extra": {"final_response": "completed"}},
        ],
        "n_calls": 4,
        "n_format_errors": 2,
        "n_consecutive_format_errors": 1,
        "task": "Search inbox",
    }

    result = agent.resume(prior_state=prior_state, followup="Only unread emails.", task="Search inbox")

    assert result["final_response"] == "resumed ok"
    assert agent.n_calls == 5
    assert agent.n_format_errors == 2
    assert agent.n_consecutive_format_errors == 0
    assert agent.messages[-2]["role"] == "assistant"
    followup_msg = agent.messages[-3]
    assert "Only unread emails." in followup_msg["content"]
    assert followup_msg["extra"]["interrupt_type"] == "ResumeFollowup"
    assert followup_msg["extra"]["user_input"] == "Only unread emails."
    assert followup_msg["extra"]["timestamp"]
    assert all(message["role"] != "exit" for message in prior_state["messages"][:-1])
    saved = json.loads(output_path.read_text(encoding="utf-8"))
    assert saved["info"]["submission"] == "resumed ok"
    saved_followup = next(
        m for m in saved["messages"]
        if m.get("extra", {}).get("interrupt_type") == "ResumeFollowup"
    )
    assert saved_followup["extra"]["user_input"] == "Only unread emails."
    assert saved_followup["extra"]["timestamp"]
    resumed_action = json.loads(model.queries[0][2]["content"])
    assert resumed_action["thought"] == "inspect prior page"
    assert resumed_action["python_code"] == "print('prior page')"


def test_run_one_resume_uses_agent_resume(monkeypatch, tmp_path: Path) -> None:
    prior_dir = tmp_path / "prior"
    prior_dir.mkdir()
    trajectory_path = prior_dir / "trajectory.json"
    trajectory_path.write_text(
        json.dumps(
            {
                "info": {"api_calls": 2, "format_errors": 0, "config": {"agent": {}}},
                "messages": [
                    {"role": "system", "content": "sys", "extra": {}},
                    {"role": "user", "content": "Task: Search inbox", "extra": {}},
                    {"role": "exit", "content": "done", "extra": {"final_response": "done"}},
                ],
            }
        ),
        encoding="utf-8",
    )

    class StubEnv:
        def prepare(self, **kwargs):
            self.prepared = kwargs

        def close(self):
            return None

    class StubAgent:
        messages = []

        def resume(self, **kwargs):
            self.resume_kwargs = kwargs
            return {"final_response": "resumed"}

        def run(self, *args, **kwargs):
            raise AssertionError("run() should not be used for resumed flows")

    stub_env = StubEnv()
    stub_agent = StubAgent()

    monkeypatch.setattr("webwright.run.cli.get_model", lambda config: object())
    monkeypatch.setattr("webwright.run.cli.get_environment", lambda config: stub_env)
    monkeypatch.setattr("webwright.run.cli.get_agent", lambda model, env, config, default_type="default": stub_agent)
    monkeypatch.setattr("webwright.run.cli.snapshot_config_specs", lambda *args, **kwargs: None)

    result = run_one(
        resume_from=prior_dir,
        followup="Continue with unread emails.",
        config_spec=["base.yaml", "model_openai.yaml"],
        snapshot_config=False,
    )

    assert result["final_response"] == "resumed"
    assert stub_env.prepared["task"] == "Search inbox"
    assert stub_agent.resume_kwargs["followup"] == "Continue with unread emails."
    assert stub_agent.resume_kwargs["prior_state"]["task"] == "Search inbox"


def test_run_one_resume_reuses_prior_output_dir(monkeypatch, tmp_path: Path) -> None:
    prior_dir = tmp_path / "prior"
    prior_dir.mkdir()
    trajectory_path = prior_dir / "trajectory.json"
    trajectory_path.write_text(
        json.dumps(
            {
                "info": {"api_calls": 1, "format_errors": 0, "config": {"agent": {}}},
                "messages": [
                    {"role": "system", "content": "sys", "extra": {}},
                    {"role": "user", "content": "Task: Search inbox", "extra": {}},
                    {"role": "exit", "content": "done", "extra": {"final_response": "done"}},
                ],
            }
        ),
        encoding="utf-8",
    )

    class StubEnv:
        def prepare(self, **kwargs):
            self.prepared = kwargs

        def close(self):
            return None

    class StubAgent:
        messages = []

        def resume(self, **kwargs):
            return {"final_response": "resumed"}

    captured_env_config: dict = {}
    stub_env = StubEnv()

    def fake_get_environment(config):
        captured_env_config["value"] = config
        return stub_env

    monkeypatch.setattr("webwright.run.cli.get_model", lambda config: object())
    monkeypatch.setattr("webwright.run.cli.get_environment", fake_get_environment)
    monkeypatch.setattr("webwright.run.cli.get_agent", lambda model, env, config, default_type="default": StubAgent())
    monkeypatch.setattr("webwright.run.cli.snapshot_config_specs", lambda *args, **kwargs: None)

    result = run_one(
        resume_from=prior_dir,
        followup="Continue.",
        config_spec=["base.yaml", "model_openai.yaml"],
        snapshot_config=False,
    )

    assert result["_output_dir"] == str(prior_dir.resolve())
    assert captured_env_config["value"]["output_dir"] == str(prior_dir.resolve())
    assert captured_env_config["value"]["resume_existing_output"] is True
    assert captured_env_config["value"].get("resume_existing_page") is not True


def test_local_workspace_resume_existing_output_continues_step_index(tmp_path: Path) -> None:
    steps_dir = tmp_path / "steps"
    steps_dir.mkdir(parents=True)
    (steps_dir / "step_0003.sh").write_text("echo old\n", encoding="utf-8")

    env = LocalWorkspaceEnvironment(output_dir=tmp_path, resume_existing_output=True)
    env.prepare(task="Task", task_id="demo", start_url="")

    assert env._step_index == 3


def test_run_one_resume_enables_existing_page_for_local_cdp(monkeypatch, tmp_path: Path) -> None:
    prior_dir = tmp_path / "prior"
    prior_dir.mkdir()
    (prior_dir / "trajectory.json").write_text(
        json.dumps(
            {
                "info": {"api_calls": 1, "format_errors": 0, "config": {"agent": {}}},
                "environment": {
                    "config": {
                        "browser_mode": "local_cdp",
                        "start_url": "https://mail.163.com",
                        "local_cdp_url": "http://127.0.0.1:9222",
                    },
                    "runtime_state": {
                        "target_id": "target-123",
                        "last_url": "https://mail.163.com/inbox",
                        "last_title": "Inbox",
                    },
                },
                "messages": [
                    {"role": "system", "content": "sys", "extra": {}},
                    {"role": "user", "content": "Task: Search inbox", "extra": {}},
                    {"role": "exit", "content": "done", "extra": {"final_response": "done"}},
                ],
            }
        ),
        encoding="utf-8",
    )

    class StubEnv:
        def prepare(self, **kwargs):
            self.prepared = kwargs

        def close(self):
            return None

    class StubAgent:
        messages = []

        def resume(self, **kwargs):
            return {"final_response": "resumed"}

    captured_env_config: dict = {}
    stub_env = StubEnv()

    def fake_get_environment(config):
        captured_env_config["value"] = config
        return stub_env

    monkeypatch.setattr("webwright.run.cli.get_model", lambda config: object())
    monkeypatch.setattr("webwright.run.cli.get_environment", fake_get_environment)
    monkeypatch.setattr("webwright.run.cli.get_agent", lambda model, env, config, default_type="default": StubAgent())
    monkeypatch.setattr("webwright.run.cli.snapshot_config_specs", lambda *args, **kwargs: None)

    run_one(
        resume_from=prior_dir,
        followup="Continue.",
        config_spec=["base.yaml", "local_browser.yaml", "model_openai.yaml"],
        snapshot_config=False,
    )

    assert captured_env_config["value"]["resume_existing_page"] is True
    assert stub_env.prepared["resume_target_id"] == "target-123"
    assert stub_env.prepared["resume_last_url"] == "https://mail.163.com/inbox"
    assert stub_env.prepared["resume_last_title"] == "Inbox"

    run_one(
        resume_from=prior_dir,
        followup="Continue on replay target.",
        resume_target_id_override="target-replay",
        config_spec=["base.yaml", "local_browser.yaml", "model_openai.yaml"],
        snapshot_config=False,
    )

    assert stub_env.prepared["resume_target_id"] == "target-replay"


def test_run_one_initial_task_passes_prepared_target(monkeypatch, tmp_path: Path) -> None:
    class StubEnv:
        def prepare(self, **kwargs):
            self.prepared = kwargs

        def close(self):
            return None

    class StubAgent:
        messages = []

        def run(self, *args, **kwargs):
            return {"final_response": "done"}

    stub_env = StubEnv()
    monkeypatch.setattr("webwright.run.cli.get_model", lambda config: object())
    monkeypatch.setattr("webwright.run.cli.get_environment", lambda config: stub_env)
    monkeypatch.setattr(
        "webwright.run.cli.get_agent",
        lambda model, env, config, default_type="default": StubAgent(),
    )

    run_one(
        task="Open prepared page",
        task_id="prepared",
        start_url="https://example.com",
        target_id="target-1",
        config_spec=["base.yaml", "local_browser.yaml", "model_openai.yaml"],
        resolved_output_dir=tmp_path / "output",
        snapshot_config=False,
    )

    assert stub_env.prepared["initial_target_id"] == "target-1"


def test_local_browser_strict_target_distinguishes_pages_with_same_url_and_title(
    tmp_path: Path,
) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    pages = [
        _FakePage("https://example.com/", "Same title"),
        _FakePage("https://example.com/", "Same title"),
    ]
    context = _FakeContext(pages, target_ids=["target-2", "target-1"])

    page, source = asyncio.run(
        env._match_page_in_context(
            context=context,
            target_info={"id": "target-1", "url": "https://example.com/"},
            last_url="",
            last_title="",
            strict_target=True,
        )
    )

    assert page is pages[1]
    assert source == "cdp_target_id"
    assert env._page_target_id == "target-1"
    assert context.sessions_created == pages
    assert all(session.detached for session in context.sessions)


def test_local_browser_first_step_executes_and_persists_start_navigation(
    monkeypatch, tmp_path: Path
) -> None:
    env = LocalBrowserEnvironment(
        output_dir=tmp_path,
        browser_mode="local_cdp",
        start_url="https://example.com/path?x=1",
    )
    env._steps_dir().mkdir(parents=True)
    executed: list[str] = []

    async def fake_run_python_code(code: str) -> None:
        executed.append(code)

    async def fake_wait_for_observation_ready() -> None:
        return None

    async def fake_capture_observation(*, success: bool, exception_text: str) -> dict:
        return {
            "success": success,
            "exception": exception_text,
            "python_code": env._step_python_code,
        }

    monkeypatch.setattr(env, "_run_python_code", fake_run_python_code)
    monkeypatch.setattr(env, "_wait_for_observation_ready", fake_wait_for_observation_ready)
    monkeypatch.setattr(env, "_capture_observation", fake_capture_observation)

    asyncio.run(env._execute_async({"python_code": "print(await page.title())"}))
    asyncio.run(env._execute_async({"python_code": "print(page.url)"}))

    navigation = (
        'await page.goto("https://example.com/path?x=1", '
        'wait_until="domcontentloaded")'
    )
    first_step = f"{navigation}\nprint(await page.title())"
    assert executed == [first_step, "print(page.url)"]
    assert (tmp_path / "steps" / "step_0001.py").read_text(encoding="utf-8") == first_step
    assert (tmp_path / "steps" / "step_0002.py").read_text(encoding="utf-8") == "print(page.url)"
    assert first_step in (tmp_path / "script.py").read_text(encoding="utf-8")


def test_local_browser_marks_browser_disconnect_as_fatal(monkeypatch, tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    env._steps_dir().mkdir(parents=True)
    env._browser = type("DisconnectedBrowser", (), {"is_connected": lambda self: False})()

    async def fake_run_python_code(code: str) -> None:
        return None

    monkeypatch.setattr(env, "_run_python_code", fake_run_python_code)

    result = asyncio.run(env._execute_async({"python_code": "print(page.url)"}))

    assert result["returncode"] == 1
    assert result["fatal_error_code"] == "browser_disconnected"
    assert result["fatal_error_stage"] == "browser_action"
    assert result["observation"]["success"] is False


def test_local_browser_does_not_duplicate_exact_first_navigation(tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(
        output_dir=tmp_path,
        browser_mode="local_cdp",
        start_url="https://example.com/",
    )
    env._step_index = 1
    code = (
        'await page.goto("https://example.com/", wait_until="domcontentloaded")\n'
        'print(page.url)'
    )

    assert env._with_initial_navigation(code) == code


def test_local_browser_does_not_inject_navigation_when_prepared_page_matches_start_url(
    tmp_path: Path,
) -> None:
    env = LocalBrowserEnvironment(
        output_dir=tmp_path,
        browser_mode="local_cdp",
        start_url="https://example.com/",
    )
    env._step_index = 1
    env._start_url_ready = True

    assert env._with_initial_navigation("print(page.url)") == "print(page.url)"


class _FakePage:
    def __init__(self, url: str, title: str):
        self.url = url
        self._title = title

    async def title(self):
        return self._title


class _FakeObservationLocator:
    def __init__(self, value: str):
        self.value = value

    async def text_content(self, timeout=None):
        assert timeout == 5000
        return self.value

    async def aria_snapshot(self, timeout=None):
        assert timeout == 5000
        return self.value


class _FakeObservationPage(_FakePage):
    def locator(self, selector: str):
        return _FakeObservationLocator(
            "Example" if selector == "title" else "- heading Example"
        )

    def is_closed(self):
        return False


def test_local_browser_initial_observation_reads_prepared_page_without_navigation(
    tmp_path: Path,
) -> None:
    env = LocalBrowserEnvironment(
        output_dir=tmp_path,
        browser_mode="local_cdp",
        start_url="https://example.com/",
    )
    env._browser = type("ConnectedBrowser", (), {"is_connected": lambda self: True})()
    env._page = _FakeObservationPage("https://example.com/", "Example")
    env._page_target_id = "target-1"

    observation = asyncio.run(env._initial_observation_async())

    assert observation == {
        "url": "https://example.com/",
        "title": "Example",
        "aria_snapshot": "- heading Example",
        "target_id": "target-1",
        "browser_connected": True,
        "page_closed": False,
    }


class _FakeContext:
    def __init__(self, pages, target_ids=None):
        self.pages = pages
        self._target_ids = dict(zip(pages, target_ids or []))
        self.sessions = []
        self.sessions_created = []

    async def new_cdp_session(self, page):
        self.sessions_created.append(page)
        session = _FakeCDPSession(self._target_ids.get(page, ""))
        self.sessions.append(session)
        return session


class _FakeCDPSession:
    def __init__(self, target_id: str):
        self.target_id = target_id
        self.detached = False

    async def send(self, method: str):
        assert method == "Target.getTargetInfo"
        return {"targetInfo": {"targetId": self.target_id}}

    async def detach(self):
        self.detached = True


def test_local_browser_match_page_prefers_exact_target_id(tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    pages = [
        _FakePage("https://mail.163.com/inbox", "Inbox"),
        _FakePage("https://mail.163.com/search?q=apple", "Search"),
    ]
    target_info = {"id": "target-2", "url": "https://mail.163.com/search?q=apple"}

    page, source = asyncio.run(
        env._match_page_in_context(
            context=_FakeContext(pages, target_ids=["target-1", "target-2"]),
            target_info=target_info,
            last_url="https://mail.163.com/inbox",
            last_title="Inbox",
        )
    )

    assert page is pages[1]
    assert source == "cdp_target_id"
    assert env._page_target_id == "target-2"


def test_local_browser_match_page_falls_back_to_last_url(tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    pages = [_FakePage("https://mail.163.com/inbox", "Inbox")]

    page, source = asyncio.run(
        env._match_page_in_context(
            context=_FakeContext(pages, target_ids=["target-last"]),
            target_info=None,
            last_url="https://mail.163.com/inbox",
            last_title="Inbox",
        )
    )

    assert page is pages[0]
    assert source == "last_url"
    assert env._page_target_id == "target-last"


def test_local_browser_strict_target_does_not_fall_back_to_same_url(tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    page = _FakePage("https://example.com/", "Same title")

    matched, source = asyncio.run(
        env._match_page_in_context(
            context=_FakeContext([page], target_ids=["target-2"]),
            target_info={"id": "target-1", "url": "https://example.com/"},
            last_url="https://example.com/",
            last_title="Same title",
            strict_target=True,
        )
    )

    assert matched is None
    assert source == ""
    assert env._page_target_id == ""


def test_local_browser_refreshes_runtime_target_id_from_selected_page(tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    pages = [
        _FakePage("https://example.com/", "Same title"),
        _FakePage("https://example.com/", "Same title"),
    ]
    env._context = _FakeContext(pages, target_ids=["target-1", "target-2"])
    env._page = pages[1]
    env._page_target_id = "stale-target"

    asyncio.run(env._refresh_page_runtime_state())

    assert env._page_target_id == "target-2"


def test_local_browser_serialize_includes_runtime_state(tmp_path: Path) -> None:
    env = LocalBrowserEnvironment(output_dir=tmp_path, browser_mode="local_cdp")
    env._page_target_id = "target-1"
    env._page_selection_source = "cdp_target_id"
    env._page = _FakePage("https://mail.163.com/inbox", "Inbox")
    env._last_title = "Inbox"

    serialized = env.serialize()

    assert serialized["environment"]["runtime_state"]["target_id"] == "target-1"
    assert serialized["environment"]["runtime_state"]["last_url"] == "https://mail.163.com/inbox"
    assert serialized["environment"]["runtime_state"]["last_title"] == "Inbox"
