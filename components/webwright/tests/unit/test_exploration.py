from __future__ import annotations

import json
from pathlib import Path

from webwright.paths import WebwrightPaths
from webwright.server.app import create_app
from webwright.server.records import TaskStore
from webwright.server.status import TaskStatus
from webwright.server.toolkit_store import ToolkitStore


class FakeExplorationManager:
    def __init__(self, task_store: TaskStore):
        self.task_store = task_store
        self.started: dict = {}
        self.continued: dict = {}
        self.title_requests: list[str] = []

    def ensure_exploration_title(self, task):
        self.title_requests.append(task["task_id"])

    def start_exploration(self, **kwargs):
        self.started = kwargs
        task_id = self.task_store.new_task_id("exp_search_blog")
        record = self.task_store.create_task_record(
            task_id=task_id,
            title="Explore search_blog",
            instruction="Search posts",
            start_url="https://blog.example.com/admin/posts",
            output_dir=self.task_store.task_dir(task_id),
            run_id="run-1",
            activity_type="exploration",
            toolkit_id=kwargs["toolkit_id"],
            tool_id=kwargs["tool_id"],
            initial_supplement=kwargs.get("supplement", ""),
        )
        return self.task_store.update_task(task_id, status=TaskStatus.RUNNING.value)

    def continue_task(self, **kwargs):
        self.continued = kwargs
        return self.task_store.update_task(
            kwargs["task_id"], status=TaskStatus.RUNNING.value
        )


def _stores(tmp_path: Path) -> tuple[TaskStore, ToolkitStore]:
    task_store = TaskStore(tmp_path / "tasks")
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
    return task_store, toolkit_store


def test_task_store_filters_tool_owned_explorations(tmp_path: Path) -> None:
    task_store, _toolkit_store = _stores(tmp_path)
    task_store.create_task_record(
        task_id="exp_1",
        title="Explore",
        instruction="Search",
        start_url="https://blog.example.com/admin/posts",
        output_dir=task_store.task_dir("exp_1"),
        run_id="run-1",
        activity_type="exploration",
        toolkit_id="blog_admin",
        tool_id="search_blog",
    )
    task_store.create_task_record(
        task_id="legacy_1",
        title="Legacy",
        instruction="Legacy",
        start_url="https://example.com",
        output_dir=task_store.task_dir("legacy_1"),
        run_id="run-2",
    )

    explorations = task_store.list_explorations(
        toolkit_id="blog_admin", tool_id="search_blog"
    )

    assert [item["task_id"] for item in explorations] == ["exp_1"]
    assert task_store.read_exploration("exp_1")["activity_type"] == "exploration"


def test_exploration_view_reads_small_usage_checkpoint_and_attachment_metadata(tmp_path: Path) -> None:
    from webwright.server.app import _exploration_view
    from webwright.server.records import atomic_write_json

    store, _ = _stores(tmp_path)
    record = store.create_task_record(task_id="example", title="Example", instruction="Read example",
        start_url="https://example.com", output_dir=store.task_dir("example"), run_id="example-run", activity_type="exploration")
    attachments = [{"name": "example.txt", "path": ".server/attachments/example.txt", "size": 7}]
    record = store.update_task("example", attachments=attachments)
    checkpoint = store.server_dir("example") / "checkpoint.json"
    atomic_write_json(checkpoint, {"context_usage": {"input_tokens": 1234, "context_limit": 200000}})
    view = _exploration_view(record)
    assert view["context_usage"] == {"input_tokens": 1234, "context_limit": 200000}
    assert view["attachments"] == attachments
    checkpoint.write_text("[]", encoding="utf-8")
    assert _exploration_view(record)["context_usage"] is None


def test_exploration_api_creates_owned_activity_and_followup(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()

    created = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations",
        json={"instruction": "Only published posts", "target_id": "prepared-target"},
    )
    assert created.status_code == 200
    exploration_id = created.get_json()["exploration_id"]
    assert manager.started == {
        "toolkit_id": "blog_admin",
        "tool_id": "search_blog",
        "supplement": "Only published posts",
        "target_id": "prepared-target",
    }

    listed = client.get(
        "/api/toolkits/blog_admin/tools/search_blog/explorations"
    ).get_json()
    assert listed["explorations"][0]["exploration_id"] == exploration_id
    assert listed["explorations"][0]["tool_id"] == "search_blog"

    detail = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert detail["toolkit_id"] == "blog_admin"
    assert detail["completed_goal"] is False
    assert detail["active_issue"] is None
    assert "active_target_id" not in detail

    followup = client.post(
        f"/api/explorations/{exploration_id}/messages",
        json={"content": "Continue"},
    )
    assert followup.status_code == 200
    assert manager.continued["task_id"] == exploration_id


def test_exploration_timeline_interleaves_user_turns_and_steps(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()
    created = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations",
        json={"instruction": "Only published posts"},
    ).get_json()
    exploration_id = created["exploration_id"]
    output_dir = Path(task_store.read_task(exploration_id)["output_dir"])
    debug_steps = output_dir / "debug" / "steps"
    debug_steps.mkdir(parents=True)
    (debug_steps / "step_0001.json").write_text(
        json.dumps(
            {
                "thought": "Inspect the search page",
                "python_code": "print(page.url)",
                "done": False,
                "outputs": [
                    {
                        "returncode": 0,
                        "observation": {
                            "success": True,
                            "title": "Posts",
                            "url": "https://blog.example.com/admin/posts",
                            "exception": "recovered browser error",
                            "aria_snapshot": "must not be exposed",
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (debug_steps / "step_0002.json").write_text(
        json.dumps(
            {
                "thought": "Read the filtered results",
                "python_code": "print('done')",
                "done": True,
                "final_response": "Found three posts",
                "outputs": [],
            }
        ),
        encoding="utf-8",
    )
    task_store.append_user_turn(
        exploration_id, content="Login is complete", after_step=1
    )
    task_store.update_task(
        exploration_id,
        status=TaskStatus.SUCCEEDED.value,
        final_response="Found three posts",
    )
    (output_dir / "trajectory.json").write_text(
        json.dumps(
            {
                "messages": [
                    {"role": "system", "content": "internal prompt", "extra": {}},
                    {
                        "role": "user",
                        "content": "format retry",
                        "extra": {"interrupt_type": "FormatError"},
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    payload = client.get(
        f"/api/explorations/{exploration_id}/timeline"
    ).get_json()

    assert [item["type"] for item in payload["items"]] == [
        "user",
        "agent_step",
        "user",
        "agent_step",
        "agent_final",
    ]
    assert payload["items"][0]["content"] == "Only published posts"
    assert payload["items"][2]["content"] == "Login is complete"
    assert payload["items"][2]["after_step"] == 1
    assert payload["items"][1]["observation"] == {
        "screenshot_url": "",
        "success": True,
        "title": "Posts",
        "url": "https://blog.example.com/admin/posts",
    }
    assert all("internal prompt" not in str(item) for item in payload["items"])
    assert all("format retry" not in str(item) for item in payload["items"])
    assert all("recovered browser error" not in str(item) for item in payload["items"])
    assert payload["items"][-1]["content"] == "Found three posts"


def test_exploration_detail_only_exposes_current_active_issue(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()
    exploration_id = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations", json={}
    ).get_json()["exploration_id"]

    task_store.update_task(exploration_id, status=TaskStatus.WAITING_FOR_USER.value)
    waiting = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert waiting["active_issue"]["type"] == "user_takeover_required"

    task_store.update_task(exploration_id, status=TaskStatus.RUNNING.value)
    running = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert running["active_issue"] is None


def test_exploration_messages_endpoint_exposes_kind_and_observation(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()

    created = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations",
        json={},
    ).get_json()
    exploration_id = created["exploration_id"]

    output_dir = Path(task_store.read_task(exploration_id)["output_dir"])
    (output_dir / "trajectory.json").write_text(
        json.dumps(
            {
                "messages": [
                    {"role": "system", "content": "sys", "extra": {}},
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "obs"},
                            {"type": "input_image", "image_url": "data:image/png;base64,AAA"},
                        ],
                        "extra": {"observation": {"screenshot_path": "x.png"}},
                    },
                    {
                        "role": "user",
                        "content": "## Follow-up Instruction\n\ncontinue please",
                        "extra": {
                            "interrupt_type": "ResumeFollowup",
                            "user_input": "continue please",
                            "timestamp": "2026-07-16T10:00:00+00:00",
                        },
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    payload = client.get(f"/api/explorations/{exploration_id}/messages").get_json()

    kinds = [(m["role"], m["kind"], m["has_observation"]) for m in payload["messages"]]
    assert kinds == [
        ("system", "", False),
        ("user", "", True),
        ("user", "ResumeFollowup", False),
    ]
    assert payload["messages"][2]["user_input"] == "continue please"
    assert payload["messages"][2]["timestamp"] == "2026-07-16T10:00:00+00:00"


def test_exploration_api_rejects_wrong_tool_ownership(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    toolkit_store.create_toolkit(
        name="shop_admin", allowed_domains=["shop.example.com"]
    )
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()

    response = client.post(
        "/api/toolkits/shop_admin/tools/search_blog/explorations",
        json={},
    )

    assert response.status_code == 404


def test_exploration_event_stream_uses_product_event_names(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()
    created = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations", json={}
    ).get_json()
    exploration_id = created["exploration_id"]
    task_store.update_task(exploration_id, status=TaskStatus.SUCCEEDED.value)

    response = client.get(f"/api/explorations/{exploration_id}/events")
    body = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "event: exploration_succeeded" in body
    assert "event: task_succeeded" not in body
    assert client.get(f"/api/explorations/{exploration_id}").get_json()[
        "completed_goal"
    ] is True


def test_exploration_routes_are_documented(tmp_path: Path) -> None:
    task_store, toolkit_store = _stores(tmp_path)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
    )
    client = app.test_client()

    spec = client.get("/api/openapi.json").get_json()
    docs = client.get("/api/docs").get_data(as_text=True)

    assert "/api/toolkits/{toolkit_id}/tools/{tool_id}/explorations" in spec["paths"]
    assert "/api/explorations/{exploration_id}" in spec["paths"]
    assert "POST /api/toolkits/{toolkit_id}/tools/{tool_id}/explorations" in docs


def test_independent_exploration_api_lists_without_tool(tmp_path):
    task_store, toolkit_store = _stores(tmp_path)

    class Manager:
        def start_url_exploration(self, **kwargs):
            assert kwargs == {"start_url": "https://example.com", "instruction": "Inspect search", "title": ""}
            return task_store.create_task_record(
                task_id="exp_site", title="Site", instruction=kwargs["instruction"],
                start_url=kwargs["start_url"], output_dir=task_store.task_dir("exp_site"),
                run_id="run-1", activity_type="exploration",
            )

    client = create_app(paths=WebwrightPaths.resolve(home=tmp_path), store=task_store,
                        toolkit_store=toolkit_store, process_manager=Manager()).test_client()
    response = client.post("/api/explorations", json={"start_url": "https://example.com", "instruction": "Inspect search"})
    assert response.status_code == 200
    record = response.get_json()
    assert record["toolkit_id"] == record["tool_id"] == ""
    assert record["start_url"] == "https://example.com"
    assert record["title"] == "Site"
    assert client.get("/api/explorations").get_json()["explorations"] == [record]
    assert client.get("/api/toolkits/blog_admin/tools/search_blog/explorations").get_json()["explorations"] == []


def test_exploration_summary_lists_skip_artifacts_but_detail_keeps_them(tmp_path, monkeypatch):
    task_store, toolkit_store = _stores(tmp_path)
    task = task_store.create_task_record(
        task_id="exp_summary", title="Example site", instruction="Read title",
        start_url="https://example.com", output_dir=task_store.task_dir("exp_summary"),
        run_id="run-1", activity_type="exploration",
        toolkit_id="blog_admin", tool_id="search_blog",
    )
    manager = FakeExplorationManager(task_store)
    client = create_app(paths=WebwrightPaths.resolve(home=tmp_path), store=task_store,
                        toolkit_store=toolkit_store, process_manager=manager).test_client()
    artifact_reads = []

    def read_artifacts(task_id, output_dir):
        artifact_reads.append(task_id)
        return {"current_step": 8, "final_response": "Detailed result"}

    monkeypatch.setattr("webwright.server.app.task_artifact_summary", read_artifacts)
    for route in ["/api/explorations", "/api/toolkits/blog_admin/tools/search_blog/explorations"]:
        response = client.get(route + "?view=summary")
        assert response.status_code == 200
        assert artifact_reads == [], "History lists must not scan each exploration's execution artifacts"
        assert response.get_json()["explorations"] == [{
            "exploration_id": "exp_summary", "title": "Example site", "instruction": "Read title",
            "start_url": "https://example.com", "status": task["status"],
            "toolkit_id": "blog_admin", "tool_id": "search_blog",
            "created_at": task["created_at"], "updated_at": task["updated_at"],
        }]
    assert manager.title_requests == [], "Lists must not batch-generate titles"
    detail = client.get("/api/explorations/exp_summary").get_json()
    assert manager.title_requests == ["exp_summary"]
    assert detail["step_count"] == 8
    assert detail["final_response"] == "Detailed result"
    full_list = client.get("/api/explorations").get_json()["explorations"]
    assert full_list[0]["final_response"] == "Detailed result"
    assert artifact_reads == ["exp_summary", "exp_summary"]


def test_independent_source_is_reusable_without_reparenting(tmp_path):
    import pytest
    from webwright.server.development import build_development_input
    from webwright.server.debug_store import DebugRunStore

    task_store, toolkit_store = _stores(tmp_path)
    toolkit_store.create_tool("blog_admin", name="read_blog", goal="Read posts", start_url="https://blog.example.com/posts")
    task_store.create_task_record(task_id="exp_site", title="Site", instruction="Inspect site",
        start_url="https://blog.example.com/posts", output_dir=task_store.task_dir("exp_site"),
        run_id="run-1", activity_type="exploration")
    task_store.update_task("exp_site", status="succeeded")
    def build(tool_id):
        return build_development_input(task_store=task_store, toolkit_store=toolkit_store,
            debug_store=DebugRunStore(tmp_path / "debug"), toolkit_id="blog_admin", tool_id=tool_id,
            instruction="Implement search", source_exploration_id="exp_site")
    for tool_id in ["search_blog", "read_blog"]:
        assert build(tool_id)["source_exploration"]["exploration_id"] == "exp_site"
    assert task_store.read_exploration("exp_site")["tool_id"] == ""
    task_store.update_task("exp_site", status="running")
    with pytest.raises(ValueError, match="succeeded"):
        build("search_blog")
    task_store.update_task("exp_site", status="succeeded", start_url="https://other.example.org")
    with pytest.raises(ValueError, match="allowed domains"):
        build("search_blog")
    task_store.update_task("exp_site", toolkit_id="blog_admin", tool_id="read_blog")
    with pytest.raises(ValueError, match="does not belong"):
        build("search_blog")


def test_exploration_live_activity_reports_phases_and_clears_when_finished(tmp_path: Path) -> None:
    from webwright.server.records import atomic_write_json

    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()
    exploration_id = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations", json={}
    ).get_json()["exploration_id"]
    checkpoint_path = task_store.server_dir(exploration_id) / "checkpoint.json"

    # Before first checkpoint, running exploration still reports starting live_activity.
    initial = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert initial["live_activity"]["phase"] == "starting"

    # Stale checkpoint from an older run_id must be ignored.
    atomic_write_json(checkpoint_path, {
        "run_id": "old-run",
        "phase": "thinking",
        "step": 9,
        "reason": "recovering_from_error",
        "updated_at_ms": 1_700_000_000_000,
    })
    stale = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert stale["live_activity"]["phase"] == "starting"

    # Current run_id thinking after error.
    atomic_write_json(checkpoint_path, {
        "run_id": "run-1",
        "phase": "thinking",
        "step": 2,
        "reason": "recovering_from_error",
        "updated_at_ms": 1_700_000_001_000,
        "deadline_at_ms": 0,
    })
    thinking = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert thinking["live_activity"] == {
        "phase": "thinking",
        "step": 2,
        "reason": "recovering_from_error",
        "updated_at_ms": 1_700_000_001_000,
        "deadline_at_ms": 0,
        "thought": "",
        "code": "",
    }

    # Action running exposes thought and code for the live step card.
    atomic_write_json(checkpoint_path, {
        "run_id": "run-1",
        "phase": "action_running",
        "step": 2,
        "reason": "",
        "updated_at_ms": 1_700_000_002_000,
        "deadline_at_ms": 1_700_000_047_000,
        "thought": "Retry clicking the search button",
        "python_code": "await page.click('#search')",
    })
    running = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert running["live_activity"]["phase"] == "action_running"
    assert running["live_activity"]["step"] == 2
    assert running["live_activity"]["thought"] == "Retry clicking the search button"
    assert running["live_activity"]["code"] == "await page.click('#search')"

    # Completed checkpoint during an active run transitions smoothly to thinking next step.
    atomic_write_json(checkpoint_path, {
        "run_id": "run-1",
        "phase": "completed",
        "step": 2,
        "reason": "recovering_from_error",
        "updated_at_ms": 1_700_000_003_000,
    })
    transition = client.get(f"/api/explorations/{exploration_id}").get_json()
    assert transition["live_activity"]["phase"] == "thinking"
    assert transition["live_activity"]["step"] == 3
    assert transition["live_activity"]["reason"] == "recovering_from_error"

    # Terminal and waiting statuses clear live_activity.
    for final_status in (
        TaskStatus.WAITING_FOR_USER.value,
        TaskStatus.SUCCEEDED.value,
        TaskStatus.FAILED.value,
        TaskStatus.CANCELLED.value,
    ):
        task_store.update_task(exploration_id, status=final_status)
        detail = client.get(f"/api/explorations/{exploration_id}").get_json()
        assert detail["live_activity"] is None


def test_exploration_timeline_marks_in_flight_step_running_only_while_active(tmp_path: Path) -> None:
    from webwright.server.records import atomic_write_json

    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()
    exploration_id = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations", json={}
    ).get_json()["exploration_id"]
    output_dir = Path(task_store.read_task(exploration_id)["output_dir"])
    steps_dir = output_dir / "steps"
    steps_dir.mkdir(parents=True)
    (steps_dir / "step_0001.py").write_text("await page.click('#go')\n", encoding="utf-8")
    atomic_write_json(task_store.server_dir(exploration_id) / "checkpoint.json", {
        "run_id": "run-1",
        "phase": "action_running",
        "step": 1,
        "thought": "Click the search button",
        "python_code": "await page.click('#go')",
        "updated_at_ms": 1_700_000_005_000,
    })

    active_items = client.get(f"/api/explorations/{exploration_id}/timeline").get_json()["items"]
    assert active_items[0]["type"] == "agent_step"
    assert active_items[0]["status"] == "running"
    assert active_items[0]["thought"] == "Click the search button"

    task_store.update_task(exploration_id, status=TaskStatus.CANCELLED.value)
    cancelled_items = client.get(f"/api/explorations/{exploration_id}/timeline").get_json()["items"]
    assert cancelled_items[0]["status"] == "unknown"


def test_exploration_events_emits_step_transition_and_activity_updates(tmp_path: Path, monkeypatch) -> None:
    from webwright.server.records import atomic_write_json

    task_store, toolkit_store = _stores(tmp_path)
    manager = FakeExplorationManager(task_store)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        store=task_store,
        toolkit_store=toolkit_store,
        process_manager=manager,
    )
    client = app.test_client()
    exploration_id = client.post(
        "/api/toolkits/blog_admin/tools/search_blog/explorations", json={}
    ).get_json()["exploration_id"]
    output_dir = Path(task_store.read_task(exploration_id)["output_dir"])
    (output_dir / "steps").mkdir(parents=True)
    (output_dir / "debug" / "steps").mkdir(parents=True)
    (output_dir / "steps" / "step_0001.py").write_text("await page.click('#missing')\n", encoding="utf-8")
    checkpoint_path = task_store.server_dir(exploration_id) / "checkpoint.json"
    atomic_write_json(checkpoint_path, {
        "run_id": "run-1",
        "phase": "action_running",
        "step": 1,
        "updated_at_ms": 1_700_000_010_000,
    })

    ticks = 0

    def advance_state(_seconds: float) -> None:
        nonlocal ticks
        ticks += 1
        if ticks == 1:
            (output_dir / "debug" / "steps" / "step_0001.json").write_text(
                json.dumps({
                    "thought": "Try missing button",
                    "python_code": "await page.click('#missing')",
                    "done": False,
                    "outputs": [{"returncode": 1, "exception_info": "Timeout", "observation": {"success": False}}],
                }),
                encoding="utf-8",
            )
            atomic_write_json(checkpoint_path, {
                "run_id": "run-1",
                "phase": "thinking",
                "step": 2,
                "reason": "recovering_from_error",
                "updated_at_ms": 1_700_000_012_000,
            })
        else:
            task_store.update_task(exploration_id, status=TaskStatus.SUCCEEDED.value)

    monkeypatch.setattr("webwright.server.app.time.sleep", advance_state)

    body = client.get(f"/api/explorations/{exploration_id}/events").get_data(as_text=True)

    assert '"step": 1, "status": "running"' in body
    assert '"step": 1, "status": "error"' in body
    assert "event: activity_updated" in body
    assert '"phase": "thinking"' in body
    assert '"reason": "recovering_from_error"' in body
    assert "event: exploration_succeeded" in body


def test_default_agent_records_thinking_and_error_recovery_checkpoints(tmp_path: Path) -> None:
    from webwright.agents.default import DefaultAgent

    checkpoint_path = tmp_path / "checkpoint.json"
    recorded_checkpoints: list[dict] = []

    class StubModel:
        def __init__(self) -> None:
            self.calls = 0

        def format_message(self, **kwargs):
            return {"role": kwargs.get("role", "user"), "content": kwargs.get("content", ""), "extra": kwargs.get("extra", {})}

        def format_observation_messages(self, message, outputs, template_vars):
            return [self.format_message(role="user", content="observation")]

        def get_template_vars(self):
            return {}

        def serialize(self):
            return {}

        def query(self, messages):
            self.calls += 1
            if checkpoint_path.is_file():
                recorded_checkpoints.append(json.loads(checkpoint_path.read_text(encoding="utf-8")))
            if self.calls == 1:
                return {
                    "role": "assistant",
                    "content": "Attempt click",
                    "extra": {"actions": [{"python_code": "await page.click('#missing')"}]},
                }
            return {
                "role": "assistant",
                "content": "Recovered and finished",
                "extra": {"done": True, "final_response": "All done"},
            }

    class StubEnv:
        def execute(self, action):
            return {"returncode": 1, "output": "", "exception_info": "Element not found", "observation": {"success": False}}

        def get_template_vars(self):
            return {}

        def serialize(self):
            return {}

    agent = DefaultAgent(
        StubModel(),
        StubEnv(),
        system_template="sys",
        instance_template="inst",
        checkpoint_path=checkpoint_path,
        checkpoint_run_id="run-test",
    )
    agent.run(task="example")

    assert len(recorded_checkpoints) == 2
    assert recorded_checkpoints[0]["phase"] == "thinking"
    assert recorded_checkpoints[0]["step"] == 1
    assert recorded_checkpoints[0]["reason"] == ""
    assert recorded_checkpoints[0]["deadline_at_ms"] == 0
    assert recorded_checkpoints[1]["phase"] == "thinking"
    assert recorded_checkpoints[1]["step"] == 2
    assert recorded_checkpoints[1]["reason"] == "recovering_from_error"
    assert recorded_checkpoints[1]["deadline_at_ms"] == 0
