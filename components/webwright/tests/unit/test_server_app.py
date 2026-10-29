from __future__ import annotations

from pathlib import Path

import pytest

from webwright.paths import WebwrightPaths
from webwright.server.app import create_app
from webwright.server.records import TaskStore
from webwright.server.toolkit_store import ToolkitStore
from webwright.server.status import (
    DebugRunStatus,
    REPLAY_DOC_EVENTS,
    REPLAY_STATUS_VALUES,
    TASK_DOC_EVENTS,
    TASK_STATUS_VALUES,
    TaskStatus,
)
class FakeManager:
    def __init__(self):
        self.started = {}

    def start_task(self, **kwargs):
        self.started = kwargs
        return {"task_id": "demo_20260708_153000", "status": "running"}


class FakeDevelopmentManager:
    def __init__(self):
        self.started = {}

    def start_development(self, **kwargs):
        self.started = kwargs
        return {"development_run_id": "development_1", "status": "running"}


def _paths(tmp_path: Path) -> WebwrightPaths:
    return WebwrightPaths.resolve(home=tmp_path)


def test_exploration_match_reads_domains_and_start_url_from_store(tmp_path, monkeypatch):
    paths = _paths(tmp_path)
    store = ToolkitStore(paths.toolkits)
    store.create_toolkit(name="demo", allowed_domains=["example.com"])
    store.create_tool("demo", name="read_page", goal="Read", start_url="https://example.com/")
    calls = []
    def match(*args):
        calls.append(args)
        return {"status": "choose", "target": None, "targets": []}
    monkeypatch.setattr("webwright.server.app.browser_match", match)
    response = create_app(paths=paths).test_client().get(
        "/api/browser/match?toolkit_id=demo&tool_id=read_page&url=https://other.example.org/"
    )
    assert response.status_code == 200
    assert calls[0][1:] == ("https://example.com/", ["example.com"])


def test_health_endpoint(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("WEWORKER_EXPLORATION_INSTANCE_ID", "managed-instance")
    app = create_app(
        paths=_paths(tmp_path),
        runtime_identity={
            "version": "0.1.0",
            "platform": "darwin",
            "arch": "arm64",
            "mode": "embedded",
        },
    )
    client = app.test_client()

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.get_json()["runtime"] == "local_browser.local_cdp"
    assert "commit" not in response.get_json()
    assert response.get_json()["mode"] == "embedded"
    assert response.get_json()["instance_id"] == "managed-instance"
    assert "install_to_weworker" not in response.get_json()["capabilities"]


@pytest.mark.parametrize("instance_id", ["", "exploration-fixture"])
def test_health_reports_host_instance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, instance_id: str
) -> None:
    monkeypatch.setenv("WEWORKER_EXPLORATION_INSTANCE_ID", instance_id)
    app = create_app(paths=_paths(tmp_path))
    assert app.test_client().get("/api/health").get_json()["instance_id"] == instance_id


def test_standalone_does_not_register_weworker_install_route(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    response = client.post("/api/toolkits/demo/install-to-weworker")

    assert response.status_code == 404


def test_tool_deletion_prepare_and_restore_routes(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    store = ToolkitStore(paths.toolkits)
    store.create_toolkit(name="demo", allowed_domains=["example.com"])
    store.create_tool("demo", name="read_page", goal="Read page",
                      start_url="https://example.com/")
    client = create_app(paths=paths).test_client()

    prepared = client.post("/api/toolkits/demo/tools/read_page/delete-prepare")
    assert prepared.status_code == 200
    assert client.get("/api/toolkits/demo/tools").get_json()["tools"] == []
    transaction_id = prepared.get_json()["transaction_id"]
    restored = client.post("/api/toolkits/demo/tools/read_page/delete-finish",
                           json={"transaction_id": transaction_id, "restore": True})
    assert restored.status_code == 200
    assert client.get("/api/toolkits/demo/tools").get_json()["tools"][0]["tool_id"] == "read_page"


def test_weworker_user_files_environment_enables_install_capability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    user_files_dir = tmp_path / "user-files"
    monkeypatch.setenv("WEWORKER_USER_FILES_DIR", str(user_files_dir))

    app = create_app(paths=_paths(tmp_path))
    health = app.test_client().get("/api/health").get_json()

    assert "install_to_weworker" not in health["capabilities"]
    assert health["capabilities"]["adapter_v2_package"] is True
    assert app.config["WEBWRIGHT_WEWORKER_USER_FILES_DIR"] == user_files_dir.resolve()


def test_relative_weworker_user_files_environment_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("WEWORKER_USER_FILES_DIR", "relative/user-files")

    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    assert "install_to_weworker" not in client.get("/api/health").get_json()["capabilities"]
    assert client.post("/api/toolkits/demo/install-to-weworker").status_code == 404


def test_http_security_rejects_untrusted_host_and_cross_origin(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path), bind_port=8766)
    client = app.test_client()

    untrusted_host = client.get("/api/health", headers={"Host": "evil.example:8766"})
    cross_origin = client.post(
        "/api/browser/open",
        headers={"Host": "127.0.0.1:8766", "Origin": "https://evil.example"},
        json={},
    )
    same_origin = client.get(
        "/api/health",
        headers={
            "Host": "127.0.0.1:8766",
            "Origin": "http://127.0.0.1:8766",
        },
    )
    wrong_port = client.get(
        "/api/health", headers={"Host": "127.0.0.1:9999"}
    )

    assert untrusted_host.status_code == 403
    assert cross_origin.status_code == 403
    assert same_origin.status_code == 200
    assert wrong_port.status_code == 403


def test_ui_endpoints_are_removed(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    assert client.get("/").status_code == 404
    assert client.get("/ui").status_code == 404
    assert client.get("/web/app.js").status_code == 404


def test_docs_endpoint(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    response = client.get("/api/docs")
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "POST /api/tasks" in body
    assert ", ".join(f"`{status}`" for status in TASK_STATUS_VALUES) in body
    assert ", ".join(f"`{status}`" for status in REPLAY_STATUS_VALUES) in body
    assert ", ".join(f"`{event}`" for event in TASK_DOC_EVENTS) in body
    assert ", ".join(f"`{event}`" for event in REPLAY_DOC_EVENTS) in body
    assert "`paused`" not in body


def test_openapi_endpoint(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    response = client.get("/api/openapi.json")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["openapi"] == "3.1.0"
    assert "/ui" not in payload["paths"]
    assert "/api/browser/open" in payload["paths"]
    assert "/api/browser/match" in payload["paths"]
    assert "/api/activity" in payload["paths"]
    assert "/api/development-runs/{development_run_id}/files/{path}" in payload["paths"]
    assert (
        "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/restart-from-exploration"
        in payload["paths"]
    )
    assert "/api/tasks" in payload["paths"]
    assert "responses" in payload["paths"]["/api/tasks"]["post"]


def test_browser_open_and_match_endpoints(monkeypatch, tmp_path: Path) -> None:
    opened: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "webwright.server.app.browser_open",
        lambda cdp_url, url="": opened.append((cdp_url, url))
        or {"available": True, "cdp_url": cdp_url, "target": None},
    )
    monkeypatch.setattr(
        "webwright.server.app.browser_match",
        lambda cdp_url, url: {
            "status": "exact",
            "target": {"target_id": "target-1", "url": url},
        },
    )
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    open_response = client.post(
        "/api/browser/open", json={"url": "https://example.com/"}
    )
    match_response = client.get("/api/browser/match?url=https://example.com")

    assert open_response.status_code == 200
    assert open_response.get_json()["available"] is True
    assert opened == [("http://127.0.0.1:9222", "https://example.com/")]
    assert match_response.get_json()["target"]["target_id"] == "target-1"


def test_browser_open_rejects_invalid_target_url(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))

    response = app.test_client().post(
        "/api/browser/open", json={"url": "javascript:alert(1)"}
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_request"


def test_activity_endpoint_exposes_running_product_context(tmp_path: Path) -> None:
    task_store = TaskStore(tmp_path / "tasks")
    toolkit_store = ToolkitStore(tmp_path / "toolkits")
    toolkit_store.create_toolkit(name="blog_admin", allowed_domains=["blog.example.com"])
    toolkit_store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    task_store.create_task_record(
        task_id="exp_running",
        title="Explore",
        instruction="Search",
        start_url="https://blog.example.com/admin/posts",
        output_dir=task_store.task_dir("exp_running"),
        run_id="run-1",
        activity_type="exploration",
        toolkit_id="blog_admin",
        tool_id="search_blog",
    )

    manager = FakeManager()
    manager.active_snapshot = lambda: {
        "kind": "task",
        "id": "exp_running",
        "task_id": "exp_running",
        "running": True,
    }
    app = create_app(
        paths=_paths(tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )

    payload = app.test_client().get("/api/activity").get_json()

    assert payload == {
        "running": True,
        "kind": "exploration",
        "id": "exp_running",
        "toolkit_id": "blog_admin",
        "tool_id": "search_blog",
    }


def test_development_run_detail_and_log_endpoints(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    toolkit_store = app.config["WEBWRIGHT_TOOLKIT_STORE"]
    toolkit_store.create_toolkit(name="blog_admin", allowed_domains=["blog.example.com"])
    toolkit_store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    development_store = app.config["WEBWRIGHT_DEVELOPMENT_STORE"]
    run = development_store.create(
        toolkit_id="blog_admin", tool_id="search_blog", instruction="Build it"
    )
    run_dir = development_store.run_dir("blog_admin", run["development_run_id"])
    (run_dir / "process.log").write_text("developer output\n", encoding="utf-8")
    (run_dir / "runtime_errors.jsonl").write_text('{"event":"failed"}\n', encoding="utf-8")
    client = app.test_client()

    detail = client.get(f"/api/development-runs/{run['development_run_id']}")
    log = client.get(
        f"/api/development-runs/{run['development_run_id']}/files/process.log"
    )

    assert detail.status_code == 200
    assert detail.get_json()["instruction"] == "Build it"
    assert detail.get_json()["has_runtime_errors"] is True
    assert log.status_code == 200
    assert log.get_data(as_text=True).replace("\r\n", "\n") == "developer output\n"


def test_restart_development_from_exploration_api_uses_explicit_mode(
    tmp_path: Path,
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
    )
    manager = FakeDevelopmentManager()
    app = create_app(
        paths=_paths(tmp_path),
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkit_store,
        process_manager=manager,
    )

    response = app.test_client().post(
        "/api/toolkits/blog_admin/tools/search_blog/development/restart-from-exploration",
        json={
            "source_exploration_id": "exp_1",
            "instruction": "完全基于所选 Exploration 重新开发此 Tool",
            "debug_run_evidence_id": "debug_must_be_ignored",
        },
    )

    assert response.status_code == 200
    assert response.get_json()["development_run_id"] == "development_1"
    assert manager.started["source_exploration_id"] == "exp_1"
    assert manager.started["exploration_only"] is True
    assert manager.started["debug_run_evidence_id"] == ""


def test_task_events_stop_when_waiting_for_user(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    task_id = store.new_task_id("waiting")
    store.create_task_record(
        task_id=task_id,
        title="Waiting",
        instruction="Task",
        start_url="https://example.com",
        output_dir=store.task_dir(task_id),
        run_id="run-1",
    )
    store.update_task(task_id, status=TaskStatus.WAITING_FOR_USER.value)
    app = create_app(paths=_paths(tmp_path), store=store)
    client = app.test_client()

    response = client.get(f"/api/tasks/{task_id}/events")

    assert response.status_code == 200
    assert f"event: {TaskStatus.WAITING_FOR_USER.value}" in response.get_data(as_text=True)


def test_task_events_fail_on_unknown_status(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    task_id = store.new_task_id("unknown")
    store.create_task_record(
        task_id=task_id,
        title="Unknown",
        instruction="Task",
        start_url="https://example.com",
        output_dir=store.task_dir(task_id),
        run_id="run-1",
    )
    store.update_task(task_id, status="paused")
    app = create_app(paths=_paths(tmp_path), store=store)
    client = app.test_client()

    response = client.get(f"/api/tasks/{task_id}/events")
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "event: task_failed" in body
    assert "Unknown task status: paused" in body


def test_resume_rejects_removed_paused_status(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    task_id = store.new_task_id("paused")
    store.create_task_record(
        task_id=task_id,
        title="Paused",
        instruction="Task",
        start_url="https://example.com",
        output_dir=store.task_dir(task_id),
        run_id="run-1",
    )
    store.update_task(task_id, status="paused")
    app = create_app(paths=_paths(tmp_path), store=store)
    client = app.test_client()

    response = client.post(f"/api/tasks/{task_id}/resume", json={"note": "Continue"})

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "invalid_state"


def test_create_task_endpoint_uses_process_manager(tmp_path: Path) -> None:
    manager = FakeManager()
    app = create_app(
        paths=_paths(tmp_path),
        store=TaskStore(tmp_path / "tasks"),
        process_manager=manager,
    )
    client = app.test_client()

    response = client.post(
        "/api/tasks",
        json={
            "start_url": "https://example.com",
            "instruction": "Open it",
            "target_id": "target-1",
        },
    )

    assert response.status_code == 200
    assert response.get_json()["task_id"] == "demo_20260708_153000"
    assert manager.started["start_url"] == "https://example.com"
    assert manager.started["instruction"] == "Open it"
    assert manager.started["target_id"] == "target-1"


def test_model_configuration_routes_are_removed(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    assert client.get("/api/models").status_code == 404
    assert client.post("/api/models", json={"provider": "openai"}).status_code == 404
    assert client.get("/api/docs").get_data(as_text=True).find("/api/models") == -1


def test_toolkit_and_tool_crud_endpoints_persist_domain_objects(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    created_toolkit = client.post(
        "/api/toolkits",
        json={
            "name": "blog_admin",
            "description": "Blog tools",
            "allowed_domains": "blog.example.com, auth.example.com",
        },
    )
    assert created_toolkit.status_code == 200
    assert created_toolkit.get_json()["toolkit_id"] == "blog_admin"

    created_tool = client.post(
        "/api/toolkits/blog_admin/tools",
        json={
            "name": "search_blog",
            "goal": "Search posts",
            "start_url": "https://blog.example.com/admin/posts",
            "expected_effect": "Results are visible",
        },
    )
    assert created_tool.status_code == 200
    assert created_tool.get_json()["has_formal"] is False

    listed = client.get("/api/toolkits/blog_admin/tools").get_json()
    assert [item["tool_id"] for item in listed["tools"]] == ["search_blog"]

    updated = client.put(
        "/api/toolkits/blog_admin/tools/search_blog",
        json={"goal": "Search published posts"},
    )
    assert updated.get_json()["goal"] == "Search published posts"

    invalid = client.post(
        "/api/toolkits/blog_admin/tools",
        json={
            "name": "evil_tool",
            "goal": "Escape",
            "start_url": "https://evil.example.com/",
        },
    )
    assert invalid.status_code == 400

    toolkit_store = app.config["WEBWRIGHT_TOOLKIT_STORE"]
    assert isinstance(toolkit_store, ToolkitStore)
    assert toolkit_store.get_tool("blog_admin", "search_blog")["goal"] == "Search published posts"


def test_toolkit_api_is_in_openapi_and_markdown_docs(tmp_path: Path) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()

    spec = client.get("/api/openapi.json").get_json()
    docs = client.get("/api/docs").get_data(as_text=True)

    assert "/api/toolkits" in spec["paths"]
    assert "/api/toolkits/{toolkit_id}/tools" in spec["paths"]
    assert "put" in spec["paths"][
        "/api/toolkits/{toolkit_id}/tools/{tool_id}/development"
    ]
    assert "POST /api/toolkits" in docs
    assert "PUT /api/toolkits/{toolkit_id}/tools/{tool_id}/development" in docs


def test_manual_development_code_update_api_rehashes_and_rejects_stale_save(
    tmp_path: Path,
) -> None:
    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()
    toolkit_store = app.config["WEBWRIGHT_TOOLKIT_STORE"]
    toolkit_store.create_toolkit(
        name="blog_admin", allowed_domains=["blog.example.com"]
    )
    toolkit_store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    original = toolkit_store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": "async def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
            "description": "Search posts",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "result_schema": {"type": "object"},
            "source_exploration_id": "exp_1",
        },
    )
    debug_store = app.config["WEBWRIGHT_DEBUG_STORE"]
    successful_run = debug_store.create(
        tool_id="search_blog",
        channel="development",
        code_hash=original["code_hash"],
        parameters={"keyword": "before"},
    )
    debug_store.update(
        successful_run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value
    )
    assert client.get(
        "/api/toolkits/blog_admin/tools/search_blog/development"
    ).get_json()["publish_eligible"] is True
    updated_code = (
        "async def search_blog(ctx, *, keyword):\n"
        "    return {'keyword': keyword, 'manual': True}"
    )

    response = client.put(
        "/api/toolkits/blog_admin/tools/search_blog/development",
        json={
            "code": updated_code,
            "expected_code_hash": original["code_hash"],
        },
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["development"]["code"] == updated_code
    assert payload["development"]["code_hash"] != original["code_hash"]
    assert payload["development"]["source_exploration_id"] == "exp_1"
    assert payload["publish_eligible"] is False

    invalid = client.put(
        "/api/toolkits/blog_admin/tools/search_blog/development",
        json={
            "code": "async def search_blog(ctx, *, query):\n    return {'query': query}",
            "expected_code_hash": payload["development"]["code_hash"],
        },
    )
    assert invalid.status_code == 400
    assert invalid.get_json()["error"]["code"] == "invalid_request"
    assert "must match function business parameters" in invalid.get_json()["error"]["message"]

    stale = client.put(
        "/api/toolkits/blog_admin/tools/search_blog/development",
        json={
            "code": original["code"],
            "expected_code_hash": original["code_hash"],
        },
    )
    assert stale.status_code == 409
    assert stale.get_json()["error"]["code"] == "invalid_state"
    assert "changed before manual save" in stale.get_json()["error"]["message"]


def test_manual_development_code_update_api_rejects_busy_activity(
    tmp_path: Path,
) -> None:
    class RunningProcess:
        def poll(self):
            return None

    app = create_app(paths=_paths(tmp_path))
    client = app.test_client()
    toolkit_store = app.config["WEBWRIGHT_TOOLKIT_STORE"]
    toolkit_store.create_toolkit(
        name="blog_admin", allowed_domains=["blog.example.com"]
    )
    toolkit_store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    original = toolkit_store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": "async def search_blog(ctx):\n    return {}",
            "parameters_schema": {
                "type": "object",
                "properties": {},
                "required": [],
            },
            "result_schema": {"type": "object"},
        },
    )
    manager = app.config["WEBWRIGHT_PROCESS_MANAGER"]
    manager.active_process = RunningProcess()
    manager.active_kind = "debug"

    response = client.put(
        "/api/toolkits/blog_admin/tools/search_blog/development",
        json={
            "code": original["code"],
            "expected_code_hash": original["code_hash"],
        },
    )

    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "busy"
