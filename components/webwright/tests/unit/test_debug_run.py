from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from types import SimpleNamespace
from pathlib import Path

import pytest

from webwright.paths import WebwrightPaths
from webwright.run import tool_debug
from webwright.server.app import create_app
from webwright.server.debug_store import DebugRunStore
from webwright.server import process_manager
from webwright.server.process_manager import ProcessManager
from webwright.server.adapter_v2 import current_package, package_digest, snapshot_package
from webwright.server.records import TaskStore, atomic_write_json
from webwright.server.status import DebugRunStatus
from webwright.server.toolkit_store import ToolkitStore


def _stores(tmp_path: Path) -> tuple[ToolkitStore, DebugRunStore]:
    toolkits = ToolkitStore(tmp_path / "toolkits")
    toolkits.create_toolkit(name="blog_admin", allowed_domains=["blog.example.com"])
    toolkits.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/",
    )
    slot = {
        "code": "async def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
        "parameters_schema": {
            "type": "object",
            "properties": {"keyword": {"type": "string"}},
            "required": ["keyword"],
        },
        "result_schema": {"type": "object"},
        "source_exploration_id": "exp_1",
    }
    toolkits.write_development_slot("blog_admin", "search_blog", slot)
    toolkits.write_formal_slot("blog_admin", "search_blog", slot)
    return toolkits, DebugRunStore(toolkits)


class PendingProcess:
    pid = 9876

    def poll(self):
        return None

    def send_signal(self, signal):
        pass

    def terminate(self):
        pass

    def kill(self):
        pass

    def wait(self, timeout=None):
        return -15


class NoStartThread:
    def __init__(self, *, target, kwargs, daemon):
        self.target = target
        self.kwargs = kwargs
        self.daemon = daemon

    def start(self):
        pass


def test_spawned_debug_parent_owns_a_process_group(monkeypatch, tmp_path: Path) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"), toolkit_store=toolkits, debug_store=debug_runs
    )
    captured = {}

    def popen(command, **kwargs):
        captured.update(kwargs)
        return PendingProcess()

    monkeypatch.setattr(process_manager.subprocess, "Popen", popen)
    log_path = tmp_path / "process.log"
    manager._spawn(["python-test"], log_path, process_group=True)

    if process_manager.os.name == "nt":
        assert captured["creationflags"] == subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        assert captured["start_new_session"] is True
    lifecycle = log_path.read_text(encoding="utf-8")
    assert "worker_starting" in lifecycle
    assert "worker_started" in lifecycle


def test_debug_process_tree_termination_targets_process_group(monkeypatch) -> None:
    if process_manager.os.name == "nt":
        return
    calls = []
    monkeypatch.setattr(process_manager.os, "getpgid", lambda pid: 4321)
    monkeypatch.setattr(
        process_manager.os, "killpg", lambda process_group, sig: calls.append((process_group, sig))
    )

    ProcessManager._terminate_process_tree(PendingProcess())

    assert calls == [(4321, process_manager.signal.SIGTERM)]


def test_process_manager_starts_debug_with_selected_slot_and_no_code_snapshot(
    monkeypatch, tmp_path: Path
) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        python_executable="python-test",
    )
    spawn_calls = []
    monkeypatch.setattr(
        manager,
        "_spawn",
        lambda command, log_path, env=None, process_group=False, cwd=None: spawn_calls.append(
            (command, env)
        )
        or PendingProcess(),
    )
    monkeypatch.setattr("webwright.server.process_manager.threading", SimpleNamespace(Thread=NoStartThread))

    run = manager.start_debug_run(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        channel="development",
        parameters={"keyword": "Webwright"},
        timeout_seconds=12,
    )

    spec = json.loads(
        (debug_runs.run_dir("search_blog", run["debug_run_id"]) / "debug_spec.json").read_text(
            encoding="utf-8"
        )
    )
    assert run["status"] == "running"
    assert run["code_hash"] == toolkits.read_development_slot("blog_admin", "search_blog")["code_hash"]
    assert "code" not in run and "target_id" not in spec
    assert spec["timeout_seconds"] == 12
    assert run["artifact_hash"] == ""
    command, env = spawn_calls[0]
    assert command[:3] == ["python-test", "-m", "webwright.run.tool_debug"]
    assert env["PYTHONIOENCODING"] == "utf-8"
    assert manager.cancel_debug_run(run["debug_run_id"])["status"] == "cancelled"


def test_process_manager_formal_debug_fixes_current_artifact_hash(
    monkeypatch, tmp_path: Path
) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    build = snapshot_package(toolkits, "blog_admin")
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        python_executable="python-test",
    )
    monkeypatch.setattr(manager, "_spawn", lambda *args, **kwargs: PendingProcess())
    monkeypatch.setattr("webwright.server.process_manager.threading", SimpleNamespace(Thread=NoStartThread))

    run = manager.start_debug_run(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        channel="formal",
        parameters={"keyword": "Webwright"},
    )
    spec = json.loads(
        (
            debug_runs.run_dir("search_blog", run["debug_run_id"])
            / "debug_spec.json"
        ).read_text(encoding="utf-8")
    )

    assert run["artifact_hash"] == build["digest"]
    assert spec["artifact_hash"] == build["digest"]
    assert spec["code_hash"] == "sha256:" + build["digest"]
    assert spec["distribution_hash"] == build["digest"]
    assert package_digest({str(path.relative_to(spec["adapter_root"])): path.read_bytes()
                           for path in Path(spec["adapter_root"]).rglob("*") if path.is_file()}) == build["digest"]


def test_process_manager_formal_debug_rejects_changed_published_execution_file(
    monkeypatch, tmp_path: Path
) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    snapshot_package(toolkits, "blog_admin")
    published = current_package(toolkits, "blog_admin")[2] / "wewright/commands/search-blog.py"
    published.write_text(published.read_text(encoding="utf-8") + "\n# changed\n", encoding="utf-8")
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
    )

    with pytest.raises(process_manager.InvalidStateError, match="package is invalid"):
        manager.start_debug_run(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            channel="formal",
            parameters={"keyword": "Webwright"},
        )


class CompletedCliProcess:
    returncode = 0
    input = b""

    async def communicate(self, input=None):
        self.input = input or b""
        return (
            json.dumps(
                {
                    "ok": True,
                    "tool": "typed_tool",
                    "data": {"status": "成功"},
                    "page": {"url": "https://blog.example.com/done", "title": "完成"},
                },
                ensure_ascii=False,
            ).encode("utf-8"),
            "正式 CLI 日志\n".encode("utf-8"),
        )


def test_formal_debug_runs_webcli_with_json_parameters(
    monkeypatch, tmp_path: Path, capsys
) -> None:
    toolkits, runs = _stores(tmp_path)
    build = snapshot_package(toolkits, "blog_admin")
    toolkit_dir = toolkits.toolkit_dir("blog_admin")
    adapter_root = current_package(toolkits, "blog_admin")[2]
    monkeypatch.setenv("WEWORKER_WEBCLI_NODE", tool_debug.sys.executable)
    monkeypatch.setenv("WEWORKER_WEBCLI_ENTRY", __file__)
    (toolkit_dir / "runtime.json").write_text(
        '{"target_id":"","last_url":"https://blog.example.com/before","last_title":"Before","updated_at":""}',
        encoding="utf-8",
    )
    calls = []
    processes = []

    async def create_process(*command, **kwargs):
        calls.append((command, kwargs))
        if len(command) > 2 and command[2] == "adapter":
            process = CompletedCliProcess()
            async def listing(input=None):
                return (json.dumps([{"id": "blog-admin", "digest": build["digest"]}]).encode(), b"")
            process.communicate = listing
        else:
            process = CompletedCliProcess()
        processes.append(process)
        return process

    monkeypatch.setattr(tool_debug.asyncio, "create_subprocess_exec", create_process)
    monkeypatch.setattr(
        tool_debug,
        "ToolkitStore",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("formal.json read")),
    )
    result_path = tmp_path / "result.json"
    result = asyncio.run(
        tool_debug.run_debug(
            {
                "toolkit_root": str(tmp_path / "toolkits"),
                "toolkit_id": "blog_admin",
                "tool_id": "search_blog",
                "adapter_root": str(adapter_root),
                "distribution_hash": build["digest"],
                "channel": "formal",
                "profile": "public",
                "cdp_url": "http://127.0.0.1:9222",
                "parameters": {
                    "text": "hello",
                    "count": 2,
                    "ratio": 1.5,
                    "enabled": True,
                    "options": {"mode": "fast"},
                    "items": [1, 2],
                },
                "result_path": str(result_path),
                "screenshot_path": str(tmp_path / "screenshot.png"),
            }
        )
    )

    assert calls[0][0][2:5] == ("adapter", "list", "--json")
    command, process_options = calls[1]
    assert command[:4] == (tool_debug.sys.executable, __file__, "call", "blog-admin.search-blog")
    assert command[-1] == "--output-format=json"
    assert json.loads(command[5]) == {
        "text": "hello",
        "count": 2,
        "ratio": 1.5,
        "enabled": True,
        "options": {"mode": "fast"},
        "items": [1, 2],
    }
    assert process_options["stdin"] is asyncio.subprocess.PIPE
    assert process_options["env"]["WEBWRIGHT_CDP_URL"] == "http://127.0.0.1:9222"
    assert process_options["env"]["WEBWRIGHT_PARAMETERS_STDIN"] == "1"
    assert process_options["env"]["PYTHONIOENCODING"] == "utf-8"
    assert process_options["env"]["WEBWRIGHT_RUNTIME_PATH"] == str(
        toolkit_dir / "runtime.json"
    )
    assert result["ok"] is True
    assert result["result"]["status"] == "成功"
    assert result["before_page"]["title"] == "Before"
    assert result["after_page"]["title"] == "完成"
    assert "正式 CLI 日志" in capsys.readouterr().err


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for WebCLI")
def test_formal_debug_executes_isolated_uninstalled_v2_package(monkeypatch, tmp_path: Path) -> None:
    name = "demo.example.com"
    catalog = tmp_path / "debug-run" / "catalog"
    adapter_root = catalog / name
    command = adapter_root / "wewright" / "commands" / "read-page.py"
    command.parent.mkdir(parents=True)
    manifest = {
        "schema_version": 2, "name": name, "version": "1.0.0", "description": "Example read command",
        "runtime_allowed_hosts": ["example.com"],
        "commands": [{"id": "read-page", "runtime": "wewright", "module": "wewright/commands/read-page.py",
                      "description": "Read a page", "safety": "read", "schema": {"type": "object", "properties": {"keyword": {"type": "string"}}}}],
    }
    (adapter_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    command.write_text(
        "import json, sys\nargs=json.load(sys.stdin)\nprint(json.dumps({'ok': True, 'data': args, 'page': {'url': 'https://example.com/', 'title': 'Example'}}))\n",
        encoding="utf-8",
    )
    digest = package_digest({str(path.relative_to(adapter_root)): path.read_bytes()
                             for path in adapter_root.rglob("*") if path.is_file()})
    (catalog / ".profile.json").write_text(json.dumps({"schema_version": 1, "profile": "public",
        "adapters": [{"name": name, "version": "1.0.0", "digest": digest}]}), encoding="utf-8")
    (tmp_path / "debug-run" / "empty-adapters").mkdir()
    monkeypatch.setenv("WEWORKER_WEBCLI_NODE", str(shutil.which("node")))
    monkeypatch.setenv("WEWORKER_WEBCLI_ENTRY", str(Path(__file__).parents[4] / "webcli" / "index.js"))
    result = asyncio.run(tool_debug.run_debug({
        "toolkit_root": str(tmp_path / "toolkits"), "toolkit_id": "demo", "tool_id": "read_page",
        "adapter_root": str(adapter_root), "distribution_hash": digest, "channel": "formal",
        "profile": "public", "cdp_url": "http://127.0.0.1:9222", "parameters": {"keyword": "fixture"},
        "result_path": str(tmp_path / "debug-run" / "result.json"),
        "screenshot_path": str(tmp_path / "debug-run" / "screenshot.png"),
    }))
    assert result["ok"] is True
    assert result["result"] == {"keyword": "fixture"}
    assert result["after_page"]["title"] == "Example"


def test_finish_debug_persists_result_pages_screenshot_and_publish_eligibility(
    tmp_path: Path,
) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"), toolkit_store=toolkits, debug_store=debug_runs
    )
    slot = toolkits.read_development_slot("blog_admin", "search_blog")
    run = debug_runs.create(
        tool_id="search_blog", channel="development", code_hash=slot["code_hash"], parameters={}
    )
    run_dir = debug_runs.run_dir("search_blog", run["debug_run_id"])
    atomic_write_json(
        run_dir / "result.json",
        {
            "ok": True,
            "result": {"total": 1},
            "error": "",
            "before_page": {"url": "https://blog.example.com/", "title": "Before"},
            "after_page": {"url": "https://blog.example.com/posts", "title": "After"},
        },
    )
    (run_dir / "screenshot.png").write_bytes(b"png")

    manager._finish_debug(run["debug_run_id"], 0)

    saved = debug_runs.read(run["debug_run_id"])
    assert saved["status"] == "succeeded"
    assert saved["result"] == {"total": 1}
    assert saved["after_page"]["title"] == "After"
    assert saved["screenshot_url"].endswith("/files/screenshot.png")
    assert debug_runs.has_successful_run(
        tool_id="search_blog", channel="development", code_hash=slot["code_hash"]
    )


class TimeoutProcess(PendingProcess):
    def wait(self, timeout=None):
        if timeout == 1:
            raise subprocess.TimeoutExpired("debug", timeout)
        return -15


def test_debug_timeout_and_restart_recovery(tmp_path: Path) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"), toolkit_store=toolkits, debug_store=debug_runs
    )
    slot = toolkits.read_development_slot("blog_admin", "search_blog")
    timed_out = debug_runs.create(
        tool_id="search_blog", channel="development", code_hash=slot["code_hash"], parameters={}
    )
    debug_runs.update(timed_out["debug_run_id"], status=DebugRunStatus.RUNNING.value)
    manager.active_process = TimeoutProcess()
    manager.active_kind = "debug"
    manager.active_id = timed_out["debug_run_id"]

    manager._watch_debug(
        debug_run_id=timed_out["debug_run_id"], process=manager.active_process, timeout_seconds=1
    )
    assert debug_runs.read(timed_out["debug_run_id"])["error"] == "Debug Run timed out."

    stale = debug_runs.create(
        tool_id="search_blog", channel="formal", code_hash=slot["code_hash"], parameters={}
    )
    assert debug_runs.recover_incomplete() == 1
    assert debug_runs.read(stale["debug_run_id"])["status"] == "failed"


class ApiDebugManager:
    def __init__(self, debug_runs: DebugRunStore, toolkits: ToolkitStore):
        self.debug_runs = debug_runs
        self.toolkits = toolkits

    def start_debug_run(self, **kwargs):
        slot = self.toolkits.read_development_slot(kwargs["toolkit_id"], kwargs["tool_id"])
        run = self.debug_runs.create(
            tool_id=kwargs["tool_id"],
            channel=kwargs["channel"],
            code_hash=slot["code_hash"],
            parameters=kwargs["parameters"],
        )
        return self.debug_runs.update(
            run["debug_run_id"],
            status=DebugRunStatus.SUCCEEDED.value,
            result={"keyword": kwargs["parameters"]["keyword"]},
            finished_at="now",
        )

    def cancel_debug_run(self, debug_run_id):
        return self.debug_runs.update(debug_run_id, status=DebugRunStatus.CANCELLED.value)


def test_debug_run_http_api_and_publish_eligibility(tmp_path: Path) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        process_manager=ApiDebugManager(debug_runs, toolkits),
    )
    client = app.test_client()

    created = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/debug-runs",
        json={"channel": "development", "parameters": {"keyword": "Webwright"}},
    )
    run_id = created.get_json()["debug_run_id"]

    assert created.status_code == 200
    assert client.get(f"/api/debug-runs/{run_id}").get_json()["result"] == {
        "keyword": "Webwright"
    }
    assert "event: debug_run_succeeded" in client.get(
        f"/api/debug-runs/{run_id}/events"
    ).get_data(as_text=True)
    assert client.get(
        "/api/toolkits/blog_admin/tools/search_blog/development"
    ).get_json()["publish_eligible"] is True
    assert "/api/debug-runs/{debug_run_id}" in client.get("/api/openapi.json").get_json()["paths"]


@pytest.mark.parametrize("writable_result", [True, False])
def test_debug_worker_persists_unexpected_error(monkeypatch, tmp_path: Path, capsys, writable_result: bool) -> None:
    spec_path = tmp_path / "debug_spec.json"
    result_path = tmp_path / "result.json"
    atomic_write_json(spec_path, {"result_path": str(result_path)})

    async def fail(spec):
        json.loads('{"data": "unfinished')

    monkeypatch.setattr(tool_debug, "run_debug", fail)
    if not writable_result:
        def fail_write(*args):
            raise OSError("Fixture write failure")
        monkeypatch.setattr(tool_debug, "atomic_write_json", fail_write)
    assert tool_debug.main(["--spec", str(spec_path)]) == 1
    logged = json.loads(capsys.readouterr().err)
    assert "Unterminated string" in logged["error"]
    if not writable_result:
        assert not result_path.exists()
        return
    saved = json.loads(result_path.read_text(encoding="utf-8"))
    assert saved["ok"] is False
    assert "Unterminated string" in saved["error"]
    assert logged["error"] == saved["error"]


@pytest.mark.parametrize("result_error,log_error,timed_out,expected", [
    (None, "Invalid CLI JSON", False, "Invalid CLI JSON"),
    ("Result error", "Log error", False, "Result error"),
    (None, None, False, "Debug process exited with code 1."),
    (None, "Log error", True, "Debug Run timed out."),
])
def test_finish_debug_recovers_worker_error_from_log(tmp_path: Path, result_error, log_error, timed_out, expected) -> None:
    toolkits, debug_runs = _stores(tmp_path)
    manager = ProcessManager(store=TaskStore(tmp_path / "tasks"), toolkit_store=toolkits, debug_store=debug_runs)
    run = debug_runs.create(tool_id="search_blog", channel="development", code_hash="sha256:fixture", parameters={})
    run_dir = debug_runs.run_dir("search_blog", run["debug_run_id"])
    if log_error:
        (run_dir / "process.log").write_text(
            'worker_started\n' + json.dumps({"ok": False, "error": log_error}) + '\nworker_exited\n', encoding="utf-8"
        )
    if result_error:
        atomic_write_json(run_dir / "result.json", {"ok": False, "error": result_error})
    manager._finish_debug(run["debug_run_id"], 1, timed_out=timed_out)
    saved = debug_runs.read(run["debug_run_id"])
    assert saved["status"] == "failed"
    assert saved["error"] == expected
