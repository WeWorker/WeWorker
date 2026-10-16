from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from webwright.server.process_manager import InvalidStateError, ProcessManager
from webwright.server.weworker_model_config import ManagedModelConfig
from webwright.server.records import TaskStore, atomic_write_json
from webwright.server.status import AgentExitStatus, TaskStatus
from webwright.server.toolkit_store import ToolkitStore


class FakeProcess:
    pid = 4321

    def __init__(self):
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9


class BlockingProcess(FakeProcess):
    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("worker", timeout)
        return self.returncode


def _managed_model(**overrides) -> ManagedModelConfig:
    values = {
        "provider_id": "glm",
        "protocol": "openai_chat_completions",
        "model_class": "zhipu",
        "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
        "model": "glm-5.2",
        "api_key": "test-model-key",
        "structured_output": "openai_json_object",
    }
    values.update(overrides)
    return ManagedModelConfig(**values)


def test_full_openai_url_is_preserved_for_both_model_flows(monkeypatch, tmp_path: Path) -> None:
    endpoint = "https://example.test/tenant/custom/?version=1&route=a%2Fb"
    manager, _store, _commands = _manager(
        tmp_path, monkeypatch,
        model_config_loader=lambda: _managed_model(provider_id="custom", model_class="openai_chat", base_url=endpoint, base_url_is_full=True),
    )
    config_file, overrides, _env = manager._resolve_model()
    assert config_file == "model_openai_chat.yaml"
    assert f"model.openai_chat_endpoint={endpoint}" in overrides
    model, _env = manager._resolve_developer_model()
    assert model["openai_chat_endpoint"] == endpoint


def _manager(
    tmp_path: Path, monkeypatch, *, toolkit_store=None, model_config_loader=None
) -> tuple[ProcessManager, TaskStore, list[list[str]]]:
    # A resolvable key is required before a task/follow-up is spawned; the default
    # provider (zhipu) reads ZHIPUAI_API_KEY, so provide one for the spawn-path tests.
    monkeypatch.setenv("ZHIPUAI_API_KEY", "test-zhipu-key")
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(
        store=store,
        python_executable="python-test",
        model_config_loader=model_config_loader or _managed_model,
        toolkit_store=toolkit_store,
    )
    commands: list[list[str]] = []

    def fake_spawn(command, log_path, *, env=None, process_group=False, cwd=None):
        commands.append(command)
        manager._captured_env = env
        manager._captured_cwd = cwd
        return FakeProcess()

    monkeypatch.setattr(manager, "_spawn", fake_spawn)
    monkeypatch.setattr(manager, "_start_watcher", lambda **kwargs: None)
    return manager, store, commands


def test_start_exploration_uses_tool_definition_and_persists_ownership(
    monkeypatch, tmp_path: Path
) -> None:
    toolkit_store = ToolkitStore(tmp_path / "toolkits")
    toolkit_store.create_toolkit(
        name="blog_admin", allowed_domains=["blog.example.com"]
    )
    toolkit_store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
        expected_effect="Results are visible",
    )
    manager, store, _commands = _manager(
        tmp_path, monkeypatch, toolkit_store=toolkit_store
    )
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_target",
        lambda cdp_url, target_id: {
            "target_id": target_id,
            "url": "https://blog.example.com/admin/posts",
        },
    )
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_activate",
        lambda cdp_url, target_id: None,
    )

    exploration = manager.start_exploration(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        supplement="Only published posts",
        target_id="prepared-target",
    )

    saved = store.read_task(exploration["task_id"])
    spec = json.loads(store.spec_path(exploration["task_id"]).read_text(encoding="utf-8"))
    assert saved["activity_type"] == "exploration"
    assert saved["toolkit_id"] == "blog_admin"
    assert saved["tool_id"] == "search_blog"
    assert saved["start_url"] == "https://blog.example.com/admin/posts"
    assert "Search posts" in saved["instruction"]
    assert "Only published posts" in saved["instruction"]
    assert saved["initial_supplement"] == "Only published posts"
    assert spec["activity_type"] == "exploration"
    assert spec["target_id"] == "prepared-target"


def test_start_task_writes_absolute_spec_and_clears_stale_control(monkeypatch, tmp_path: Path) -> None:
    manager, store, commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("demo")
    stale_control_dir = store.server_dir(task_id)
    stale_control_dir.mkdir(parents=True)
    store.control_path(task_id).write_text('{"action": "pause"}', encoding="utf-8")
    monkeypatch.setattr(store, "new_task_id", lambda requested, title=None: task_id)

    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        requested_task_id="demo",
    )

    spec = json.loads(store.spec_path(task["task_id"]).read_text(encoding="utf-8"))
    assert Path(spec["resolved_output_dir"]).is_absolute()
    assert Path(spec["resolved_output_dir"]) == store.task_dir(task["task_id"])
    assert "model_zhipu.yaml" in spec["config_spec"]
    assert any(item.startswith("agent.control_path=") for item in spec["config_spec"])
    assert any(item.startswith("agent.control_run_id=") for item in spec["config_spec"])
    assert any(item.startswith("agent.checkpoint_path=") for item in spec["config_spec"])
    assert any(item.startswith("agent.checkpoint_run_id=") for item in spec["config_spec"])
    assert "agent.hard_step_timeout_ms=45000" in spec["config_spec"]
    assert "environment.local_cdp_url=http://127.0.0.1:9222" in spec["config_spec"]
    assert not store.control_path(task["task_id"]).exists()
    assert commands[0][:3] == ["python-test", "-m", "webwright.run.local_cdp_task"]
    assert manager._captured_cwd == store.task_dir(task["task_id"])


def test_start_task_validates_and_persists_prepared_target(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_target",
        lambda cdp_url, target_id: {
            "target_id": target_id,
            "url": "https://example.com/",
        },
    )
    activated: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_activate",
        lambda cdp_url, target_id: activated.append((cdp_url, target_id)),
    )

    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        target_id="target-1",
        requested_task_id="prepared",
    )

    spec = json.loads(store.spec_path(task["task_id"]).read_text(encoding="utf-8"))
    assert spec["target_id"] == "target-1"
    assert store.read_task(task["task_id"])["active_target_id"] == "target-1"
    assert activated == [("http://127.0.0.1:9222", "target-1")]


def test_start_task_rejects_missing_prepared_target(monkeypatch, tmp_path: Path) -> None:
    manager, store, commands = _manager(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_target",
        lambda cdp_url, target_id: None,
    )

    try:
        manager.start_task(
            instruction="Open example.com",
            start_url="https://example.com",
            target_id="closed-target",
        )
    except Exception as exc:
        assert str(exc) == "Prepared Agent browser page no longer exists."
    else:
        raise AssertionError("start_task should reject a missing prepared target")

    assert commands == []
    assert store.list_tasks() == []


def test_pause_task_writes_run_scoped_control_and_status(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        requested_task_id="demo",
    )

    paused = manager.pause_task(task["task_id"], reason="login")

    control = json.loads(store.control_path(task["task_id"]).read_text(encoding="utf-8"))
    assert paused["status"] == TaskStatus.PAUSE_REQUESTED.value
    assert control["action"] == "pause"
    assert control["run_id"] == task["last_run_id"]


def test_force_cancel_marks_request_before_terminating_and_finishes_cancelled(
    monkeypatch, tmp_path: Path
) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        requested_task_id="cancel",
    )
    process = manager.active_process
    statuses = []

    def terminate(active, force=False):
        statuses.append(store.read_task(task["task_id"])["status"])
        active.terminate()

    monkeypatch.setattr(manager, "_terminate_process_tree", terminate)

    cancelled = manager.cancel_task(task["task_id"], force=True, reason="cancelled")

    assert process is not None
    assert statuses == [TaskStatus.CANCEL_REQUESTED.value]
    assert cancelled["status"] == TaskStatus.CANCELLED.value


def test_task_watchdog_marks_expired_step_failed_and_terminates_worker(
    monkeypatch, tmp_path: Path
) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("timeout")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Timeout",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-timeout",
    )
    store.update_task(task_id, status=TaskStatus.PAUSE_REQUESTED.value)
    atomic_write_json(
        store.checkpoint_path(task_id),
        {
            "run_id": "run-timeout",
            "step": 1,
            "phase": "action_running",
            "deadline_at_ms": 1,
            "thought": "inspect",
            "python_code": "await page.goto('https://example.com')",
        },
    )
    process = BlockingProcess()
    manager.active_process = process
    manager.active_kind = "task"
    manager.active_id = task_id
    manager.active_task_id = task_id
    manager.active_run_id = "run-timeout"
    terminated = []

    def terminate(active, force=False):
        terminated.append(force)
        active.terminate()

    monkeypatch.setattr(manager, "_terminate_process_tree", terminate)

    returncode = manager._wait_for_task_process(task_id, process)

    failed = store.read_task(task_id)
    assert returncode == -15
    assert terminated == [False]
    assert failed["status"] == TaskStatus.FAILED.value
    assert failed["error_code"] == "step_timeout"
    assert failed["error_stage"] == "browser_action"
    debug = json.loads(
        (output_dir / "debug" / "steps" / "step_0001.json").read_text(encoding="utf-8")
    )
    assert debug["outputs"][0]["returncode"] == 1


def test_shutdown_cancels_active_task_and_terminates_its_process_group(
    monkeypatch, tmp_path: Path
) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        requested_task_id="shutdown",
    )
    process = manager.active_process
    terminated = []
    monkeypatch.setattr(
        manager,
        "_terminate_process_tree",
        lambda active, force=False: terminated.append((active, force))
        or active.terminate(),
    )

    manager.shutdown(timeout=1)

    assert store.read_task(task["task_id"])["status"] == TaskStatus.CANCELLED.value
    assert terminated == [(process, False)]
    assert manager.active_snapshot()["running"] is False
    with pytest.raises(InvalidStateError, match="shutting down"):
        manager.start_task(
            instruction="Run again",
            start_url="https://example.com",
        )


def test_finish_task_maps_paused_exit_to_waiting_for_user(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(store=store)
    task_id = store.new_task_id("demo")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Demo",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
    )
    atomic_write_json(
        output_dir / "trajectory.json",
        {
            "environment": {"runtime_state": {"target_id": "target-paused"}},
            "messages": [
                {
                    "role": "exit",
                    "content": "paused",
                    "extra": {"exit_status": AgentExitStatus.PAUSED.value, "final_response": ""},
                }
            ]
        },
    )

    manager._finish_task(task_id, 0)

    assert store.read_task(task_id)["status"] == TaskStatus.WAITING_FOR_USER.value
    assert store.read_task(task_id)["active_target_id"] == "target-paused"


def test_finish_task_maps_format_error_to_failed(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(store=store)
    task_id = store.new_task_id("demo")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Demo",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
    )
    atomic_write_json(
        output_dir / "trajectory.json",
        {
            "messages": [
                {
                    "role": "exit",
                    "content": "format failure",
                    "extra": {
                        "exit_status": AgentExitStatus.FORMAT_ERROR.value,
                        "final_response": "",
                    },
                }
            ]
        },
    )

    manager._finish_task(task_id, 0)

    task = store.read_task(task_id)
    assert task["status"] == TaskStatus.FAILED.value
    assert task["error"] == "Model repeatedly failed to produce the required action JSON."


def test_finish_task_keeps_browser_disconnect_failure_ahead_of_pause_request(
    tmp_path: Path,
) -> None:
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(store=store)
    task_id = store.new_task_id("browser-disconnected")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Browser disconnected",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
    )
    store.update_task(task_id, status=TaskStatus.PAUSE_REQUESTED.value)
    store.process_log_path(task_id).parent.mkdir(parents=True, exist_ok=True)
    store.process_log_path(task_id).write_text(
        json.dumps(
            {
                "ok": False,
                "error": "Agent 浏览器已关闭，本次探索无法继续，请新建探索。",
                "error_code": "browser_disconnected",
                "stage": "browser_action",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    manager._finish_task(task_id, 1)

    task = store.read_task(task_id)
    assert task["status"] == TaskStatus.FAILED.value
    assert task["error_code"] == "browser_disconnected"
    assert task["error_stage"] == "browser_action"


def test_continue_task_passes_active_target_override(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("followup")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Follow-up",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
        active_target_id="target-replay",
    )
    atomic_write_json(output_dir / "trajectory.json", {"messages": []})

    manager.continue_task(task_id=task_id, followup="Continue")

    spec = json.loads(store.spec_path(task_id).read_text(encoding="utf-8"))
    assert spec["resume_target_id"] == "target-replay"


def test_continue_exploration_persists_user_turn_after_latest_step(
    monkeypatch, tmp_path: Path
) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("exploration-followup")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Follow-up",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
        activity_type="exploration",
    )
    debug_steps = output_dir / "debug" / "steps"
    debug_steps.mkdir(parents=True)
    (debug_steps / "step_0002.json").write_text(
        json.dumps({"thought": "step two", "outputs": [], "done": False}),
        encoding="utf-8",
    )
    atomic_write_json(output_dir / "trajectory.json", {"messages": []})

    manager.continue_task(task_id=task_id, followup="Login is complete")

    turns = store.read_user_turns(task_id)
    assert len(turns) == 1
    assert turns[0]["content"] == "Login is complete"
    assert turns[0]["after_step"] == 2


def test_replay_reuses_active_target(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("replay")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Replay",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
        active_target_id="target-active",
    )
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_target",
        lambda cdp_url, target_id: {"target_id": target_id, "url": "https://example.com/"},
    )

    replay = manager.start_replay(task_id=task_id, new_tab=False)
    replay_dir = store.replay_dir(task_id, replay["replay_id"])
    spec = json.loads((replay_dir / "replay_spec.json").read_text(encoding="utf-8"))
    assert spec["target_id"] == "target-active"
    assert spec["start_url"] == "https://example.com"


def test_replay_new_tab_ignores_active_target(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("replay-new")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Replay",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
        active_target_id="target-active",
    )

    replay = manager.start_replay(task_id=task_id, new_tab=True)
    replay_dir = store.replay_dir(task_id, replay["replay_id"])
    spec = json.loads((replay_dir / "replay_spec.json").read_text(encoding="utf-8"))
    assert spec["target_id"] == ""


def test_replay_falls_back_to_trajectory_target(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)
    task_id = store.new_task_id("replay-fallback")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Replay",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
        active_target_id="target-closed",
    )
    atomic_write_json(
        output_dir / "trajectory.json",
        {"environment": {"runtime_state": {"target_id": "target-trajectory"}}},
    )
    monkeypatch.setattr(
        "webwright.server.process_manager.browser_target",
        lambda cdp_url, target_id: (
            {"target_id": target_id, "url": "https://example.com/"}
            if target_id == "target-trajectory"
            else None
        ),
    )

    replay = manager.start_replay(task_id=task_id, new_tab=False)
    replay_dir = store.replay_dir(task_id, replay["replay_id"])
    spec = json.loads((replay_dir / "replay_spec.json").read_text(encoding="utf-8"))

    assert spec["target_id"] == "target-trajectory"


def test_start_task_applies_active_model_config_without_leaking_key(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("WEWORKER_MODEL_CONFIG_URL", "http://127.0.0.1:8765/internal/webwright/model-config")
    monkeypatch.setenv("WEWORKER_MODEL_CONFIG_TOKEN", "server-only-token")
    manager, store, _commands = _manager(
        tmp_path,
        monkeypatch,
        model_config_loader=lambda: _managed_model(
            provider_id="custom", model_class="openai_chat", base_url="https://gw.local/v1", model="gpt-4o-mini", api_key="sk-secret"
        ),
    )

    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        requested_task_id="model",
    )

    raw_spec = store.spec_path(task["task_id"]).read_text(encoding="utf-8")
    spec = json.loads(raw_spec)
    assert "model_openai_chat.yaml" in spec["config_spec"]
    assert "model_zhipu.yaml" not in spec["config_spec"]
    assert "model.model_name=gpt-4o-mini" in spec["config_spec"]
    assert "model.openai_chat_endpoint=https://gw.local/v1/chat/completions" in spec["config_spec"]
    # The api_key must never land in the spec/config snapshot, only in the env.
    assert "sk-secret" not in raw_spec
    assert manager._captured_env is not None
    assert manager._captured_env["OPENAI_CHAT_API_KEY"] == "sk-secret"
    assert "WEWORKER_MODEL_CONFIG_URL" not in manager._captured_env
    assert "WEWORKER_MODEL_CONFIG_TOKEN" not in manager._captured_env


def test_start_task_rejects_when_no_model_key(monkeypatch, tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(store=store, model_config_loader=lambda: (_ for _ in ()).throw(RuntimeError("missing")))
    spawned: list[int] = []
    monkeypatch.setattr(manager, "_spawn", lambda *a, **k: spawned.append(1))

    with pytest.raises(InvalidStateError) as exc:
        manager.start_task(
            instruction="Open example.com",
            start_url="https://example.com",
            requested_task_id="nokey",
        )

    assert "请先在 WeWorker 中配置" in str(exc.value)
    assert spawned == []
    assert store.list_tasks() == []  # no dangling task record
    server_log = (tmp_path / "logs" / "server.log").read_text(encoding="utf-8")
    assert "snapshot_failed" in server_log
    assert 'error_type="RuntimeError"' in server_log


def test_finish_task_failed_child_overrides_stale_success(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(store=store)
    task_id = store.new_task_id("stale")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Stale",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
    )
    # A previous successful run left a Submitted exit record in the trajectory.
    atomic_write_json(
        output_dir / "trajectory.json",
        {
            "messages": [
                {
                    "role": "exit",
                    "content": "done",
                    "extra": {
                        "exit_status": AgentExitStatus.SUBMITTED.value,
                        "final_response": "421 未读邮件",
                    },
                }
            ]
        },
    )
    log_path = store.process_log_path(task_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        '{"ok": true, "result": {"exit_status": "Submitted"}}\n'
        '{"ok": false, "error": "Missing ZHIPUAI_API_KEY."}\n',
        encoding="utf-8",
    )

    # The follow-up subprocess crashed at model init (returncode 1) without writing
    # a new exit record; the stale Submitted must not be mapped to succeeded.
    manager._finish_task(task_id, 1)

    task = store.read_task(task_id)
    assert task["status"] == TaskStatus.FAILED.value
    assert "Missing ZHIPUAI_API_KEY." in task["error"]


def test_start_task_uses_managed_model_without_local_store(monkeypatch, tmp_path: Path) -> None:
    manager, store, _commands = _manager(tmp_path, monkeypatch)

    task = manager.start_task(
        instruction="Open example.com",
        start_url="https://example.com",
        requested_task_id="default",
    )

    spec = json.loads(store.spec_path(task["task_id"]).read_text(encoding="utf-8"))
    assert "model_zhipu.yaml" in spec["config_spec"]
    assert "model.zhipu_endpoint=https://open.bigmodel.cn/api/coding/paas/v4/chat/completions" in spec["config_spec"]
    assert manager._captured_env["ZHIPUAI_API_KEY"] == "test-model-key"


def test_finish_replay_persists_runtime_target_before_terminal_status(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    manager = ProcessManager(store=store)
    task_id = store.new_task_id("replay-runtime")
    output_dir = store.task_dir(task_id)
    store.create_task_record(
        task_id=task_id,
        title="Replay",
        instruction="Task",
        start_url="https://example.com",
        output_dir=output_dir,
        run_id="run-1",
        active_target_id="target-old",
    )
    replay_id = "replay-failed"
    replay_dir = store.replay_dir(task_id, replay_id)
    replay_dir.mkdir(parents=True)
    store.write_replay(
        {
            "replay_id": replay_id,
            "task_id": task_id,
            "status": "running",
            "output_dir": str(replay_dir),
        }
    )
    atomic_write_json(replay_dir / "runtime.json", {"target_id": "target-new"})

    manager._finish_replay(replay_id, 1)

    assert store.read_task(task_id)["active_target_id"] == "target-new"
    assert store.read_replay(replay_id)["status"] == "failed"

    cancelled_id = "replay-cancelled"
    cancelled_dir = store.replay_dir(task_id, cancelled_id)
    cancelled_dir.mkdir(parents=True)
    store.write_replay(
        {
            "replay_id": cancelled_id,
            "task_id": task_id,
            "status": "cancelled",
            "output_dir": str(cancelled_dir),
        }
    )
    atomic_write_json(cancelled_dir / "runtime.json", {"target_id": "target-cancelled"})

    manager._finish_replay(cancelled_id, -15)

    assert store.read_task(task_id)["active_target_id"] == "target-cancelled"
    assert store.read_replay(cancelled_id)["status"] == "cancelled"


def test_spawn_does_not_inherit_parent_stdin(monkeypatch, tmp_path: Path) -> None:
    """Worker 不得继承父进程 stdin。

    服务器自身的 stdin 是启动方（Electron/node）给的管道，子解释器在启动引导阶段 stat
    该句柄会挂在核态，表现为 worker 一直起不来。只把 stdin 换成 DEVNULL 即恢复健康，
    而 worker 全都不读自己的 stdin，所以这条是纯收益的隔离。
    """
    manager = ProcessManager(store=TaskStore(tmp_path / "tasks"))
    captured: dict = {}

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return FakeProcess()

    monkeypatch.setattr(subprocess, "Popen", fake_popen)

    log_path = tmp_path / "worker.log"
    manager._spawn(["python-test", "-m", "worker"], log_path)

    assert captured["stdin"] is subprocess.DEVNULL
    # stdout/stderr 仍按既有约定汇入同一个日志句柄。
    assert captured["stderr"] is subprocess.STDOUT
    assert getattr(captured["stdout"], "name", "") == str(log_path)
