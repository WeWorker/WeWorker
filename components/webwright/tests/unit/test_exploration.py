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
