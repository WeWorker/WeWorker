from types import SimpleNamespace

import pytest

from webwright.paths import WebwrightPaths
from webwright.server.app import create_app
from webwright.server.process_manager import ProcessManager
from webwright.server.records import TaskStore


def setup_records(tmp_path):
    paths = WebwrightPaths.resolve(home=tmp_path)
    store = TaskStore(paths.tasks)
    for name in ["exp_example", "exp_other"]:
        store.create_task_record(
            task_id=name, title="Example", instruction="Read the page",
            start_url="https://example.com", output_dir=store.task_dir(name),
            run_id="run_one", activity_type="exploration",
        )
    manager = ProcessManager(store=store, cdp_url="http://127.0.0.1:9222")
    client = create_app(paths=paths, store=store, process_manager=manager).test_client()
    return store, manager, client


def test_models_are_saved_per_exploration_without_changing_activity(tmp_path):
    store, manager, client = setup_records(tmp_path)
    original = store.read_exploration("exp_example")
    selection = {"provider": "example-config", "model": "example-model", "thinking_effort": "high"}
    assert client.get("/api/explorations/exp_example/model").get_json() == {"model_selection": None}
    response = client.post("/api/explorations/exp_example/model", json={"model_selection": selection})
    assert response.status_code == 200
    assert client.get("/api/explorations/exp_example/model").get_json() == {"model_selection": selection}
    saved = TaskStore(store.root).read_exploration("exp_example")
    assert saved["model_selection"] == selection
    assert saved["updated_at"] == original["updated_at"]
    assert "model_selection" not in store.read_exploration("exp_other")
    manager.active_task_id = "exp_example"
    manager.active_process = SimpleNamespace(poll=lambda: None)
    assert client.post("/api/explorations/exp_example/model", json={"model_selection": selection}).status_code == 409
    assert client.post("/api/explorations/exp_other/model", json={"model_selection": selection}).status_code == 200
    assert client.post("/api/explorations/exp_other/model", json={"model_selection": {**selection, "api_key": "placeholder-key"}}).status_code == 400
    assert client.post("/api/explorations/missing/model", json={"model_selection": selection}).status_code == 404


def test_rename_persists_without_new_activity_or_ai_overwrite(tmp_path):
    store, _, client = setup_records(tmp_path)
    previous = store.read_exploration("exp_example")
    response = client.patch("/api/explorations/exp_example", json={"title": "  My exploration  "})
    assert response.status_code == 200
    assert response.get_json()["title"] == "My exploration"
    store.save_exploration_title("exp_example", expected_title="Example", title="Late AI title")
    saved = TaskStore(store.root).read_exploration("exp_example")
    assert saved["title"] == "My exploration"
    assert saved["title_source"] == "user"
    assert saved["updated_at"] == previous["updated_at"]
    assert saved["instruction"] == previous["instruction"]
    assert store.read_exploration("exp_other")["title"] == "Example"


@pytest.mark.parametrize("title", [None, 123, "", "   ", "a\nb", "a" * 201])
def test_rename_rejects_invalid_titles(tmp_path, title):
    store, _, client = setup_records(tmp_path)
    assert client.patch("/api/explorations/exp_example", json={"title": title}).status_code == 400
    assert store.read_exploration("exp_example")["title"] == "Example"


def test_delete_is_idempotent_and_keeps_evidence_for_generated_adapters(tmp_path):
    store, _, client = setup_records(tmp_path)
    evidence = store.task_dir("exp_example") / "trajectory.json"
    evidence.write_text('{"steps":[]}', encoding="utf-8")
    for _ in range(2):
        assert client.delete("/api/explorations/exp_example").status_code == 200
    assert [task["task_id"] for task in TaskStore(store.root).list_explorations()] == ["exp_other"]
    assert evidence.read_text(encoding="utf-8") == '{"steps":[]}'
    for suffix in ["", "/timeline", "/events"]:
        assert client.get("/api/explorations/exp_example" + suffix).status_code == 404
    assert client.patch("/api/explorations/exp_example", json={"title": "Again"}).status_code == 404
    assert client.post("/api/explorations/exp_example/messages", json={"content": "Again"}).status_code == 404
    assert client.post("/api/explorations/exp_example/resume", json={"note": "Again"}).status_code == 404


@pytest.mark.parametrize("kind", ["task", "replay"])
def test_delete_rejects_active_exploration_or_replay(tmp_path, kind):
    store, manager, client = setup_records(tmp_path)
    manager.active_kind = kind
    manager.active_task_id = "exp_example"
    manager.active_process = SimpleNamespace(poll=lambda: None)
    assert client.delete("/api/explorations/exp_example").status_code == 409
    assert "deleted_at" not in store.read_exploration("exp_example")
    assert client.delete("/api/explorations/exp_other").status_code == 200
