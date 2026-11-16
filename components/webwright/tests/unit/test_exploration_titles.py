from __future__ import annotations

import io
import json
import threading
from dataclasses import replace

import pytest

from webwright.server import exploration_titles as titles
from webwright.server.process_manager import ProcessManager
from webwright.server.records import TaskStore
from webwright.server.weworker_model_config import ManagedModelConfig


def model(protocol="openai_chat_completions", **overrides):
    config = ManagedModelConfig(
        provider_id="example", protocol=protocol,
        model_class="anthropic" if protocol == "anthropic_messages" else "openai_chat",
        base_url="https://example.com/v1", model="example-model",
        api_key="placeholder-key", structured_output="openai_json_object",
    )
    return replace(config, **overrides)


def record(store, **updates):
    task = store.create_task_record(
        task_id="exp_example", title="探索 example.com", instruction="探索文档搜索功能",
        start_url="https://example.com/docs", output_dir=store.task_dir("exp_example"),
        run_id="example-run", activity_type="exploration",
    )
    return store.update_task(task["task_id"], **updates) if updates else task


@pytest.mark.parametrize("protocol", ["anthropic_messages", "openai_chat_completions", "openai_responses"])
@pytest.mark.parametrize("full_url", [True, False])
@pytest.mark.parametrize("auth_type", ["api_key", "auth_token"])
def test_title_request_uses_current_protocol_without_tools(monkeypatch, protocol, full_url, auth_type):
    config = model(protocol, base_url_is_full=full_url, auth_type=auth_type)
    calls = []

    def open_request(request, *, timeout):
        body = json.loads(request.data)
        calls.append(body)
        assert request.full_url == config.request_endpoint
        assert timeout == 20
        assert body["model"] == "example-model"
        assert body["max_output_tokens" if protocol == "openai_responses" else "max_tokens"] == 1024
        assert "tools" not in body and "tool_choice" not in body
        assert "探索文档搜索功能" in (body["input"] if protocol == "openai_responses" else body["messages"][-1]["content"])
        if protocol == "anthropic_messages":
            if auth_type == "api_key":
                assert request.get_header("X-api-key") == "placeholder-key"
                assert request.get_header("Authorization") is None
            else:
                assert request.get_header("Authorization") == "Bearer placeholder-key"
                assert request.get_header("X-api-key") is None
            assert body["system"]
            response = {"content": [{"type": "thinking", "thinking": "ignore"}, {"type": "text", "text": "“文档搜索与导航探索”。"}]}
        elif protocol == "openai_responses":
            assert request.get_header("Authorization") == "Bearer placeholder-key"
            assert body["instructions"]
            assert "messages" not in body
            response = {"output": [{"type": "message", "content": [{"type": "output_text", "text": "“文档搜索与导航探索”。"}]}]}
        else:
            assert request.get_header("Authorization") == "Bearer placeholder-key"
            assert body["messages"][0]["role"] == "system"
            response = {"choices": [{"message": {"content": "“文档搜索与导航探索”。", "reasoning_content": "ignore"}}]}
        return io.BytesIO(json.dumps(response, ensure_ascii=False).encode())

    monkeypatch.setattr(titles, "urlopen", open_request)
    assert titles.generate_exploration_title({"instruction": "探索文档搜索功能"}, config) == "文档搜索与导航探索"
    assert len(calls) == 1


@pytest.mark.parametrize("response", [{}, {"choices": []}, {"choices": [{"message": {"content": None}}]}])
def test_empty_model_output_keeps_fallback(monkeypatch, response):
    monkeypatch.setattr(titles, "urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(response).encode()))
    assert titles.generate_exploration_title({}, model()) is None


def test_title_input_is_bounded_and_output_is_one_short_line(monkeypatch):
    def open_request(request, **kwargs):
        body = json.loads(request.data)
        assert len(body["messages"][-1]["content"]) < 5000
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": "标题：" + "文" * 60 + "\n不要显示这一行"}}]}).encode())

    monkeypatch.setattr(titles, "urlopen", open_request)
    task = {name: "示例" * 10000 for name in ["instruction", "start_url", "final_response"]}
    assert titles.generate_exploration_title(task, model()) == "文" * 30


def test_title_uses_the_exploration_model_selection(monkeypatch, tmp_path):
    store = TaskStore(tmp_path)
    selection = {"provider": "example-config", "model": "session-model", "thinking_effort": "low"}
    task = record(store, model_selection=selection)
    calls = []
    def load(**kwargs):
        calls.append(kwargs)
        return model(model=kwargs["selection"]["model"])
    def generate(_task, config):
        assert config.model == "session-model"
        return "文档搜索探索"
    monkeypatch.setattr(titles, "generate_exploration_title", generate)
    service = titles.ExplorationTitles(store, load)
    service._generate(task)
    assert calls == [{"selection": selection}]
    assert store.read_task(task["task_id"])["title"] == "文档搜索探索"


def test_background_title_is_nonblocking_deduplicated_and_persisted(monkeypatch, tmp_path):
    store = TaskStore(tmp_path)
    task = record(store)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def generate(task, config):
        calls.append(task["task_id"])
        entered.set()
        assert release.wait(3)
        return "文档搜索与导航探索"

    monkeypatch.setattr(titles, "generate_exploration_title", generate)
    service = titles.ExplorationTitles(store, model)
    worker = service.ensure(task)
    try:
        assert entered.wait(2)
        assert worker.is_alive()
        assert service.ensure(task) is None
        store.update_task(task["task_id"], status="succeeded", final_response="已完成探索")
        updated_at = store.read_task(task["task_id"])["updated_at"]
    finally:
        release.set()
        worker.join(3)
    saved = store.read_task(task["task_id"])
    assert saved["title"] == "文档搜索与导航探索"
    assert saved["title_source"] == "ai"
    assert saved["status"] == "succeeded" and saved["final_response"] == "已完成探索"
    assert saved["updated_at"] == updated_at
    assert titles.ExplorationTitles(store, model).ensure(saved) is None
    assert calls == [task["task_id"]]


def test_failed_title_request_does_not_change_execution_or_retry_on_poll(monkeypatch, tmp_path):
    store = TaskStore(tmp_path)
    task = record(store, status="running")

    def fail(*args):
        raise TimeoutError("test timeout")

    monkeypatch.setattr(titles, "generate_exploration_title", fail)
    worker = titles.ExplorationTitles(store, model).ensure(task)
    worker.join(3)
    saved = store.read_task(task["task_id"])
    assert saved["title"] == task["title"] and saved["status"] == "running"
    assert saved["title_source"] == "fallback"
    assert titles.ExplorationTitles(store, model).ensure(saved) is None


@pytest.mark.parametrize("updates", [{"title": "自定义名称"}, {"title_source": "custom"}, {"activity_type": "task"}])
def test_custom_titles_and_regular_tasks_are_not_renamed(tmp_path, updates):
    store = TaskStore(tmp_path)
    assert titles.ExplorationTitles(store, model).ensure(record(store, **updates)) is None


def test_title_write_does_not_overwrite_a_rename(tmp_path):
    store = TaskStore(tmp_path)
    task = record(store)
    store.update_task(task["task_id"], title="用户改名")
    store.save_exploration_title(task["task_id"], expected_title=task["title"], title="AI 标题")
    assert store.read_task(task["task_id"])["title"] == "用户改名"


def test_lifecycle_and_title_updates_are_serialized(monkeypatch, tmp_path):
    store = TaskStore(tmp_path)
    task = record(store)
    read, release, renamed = threading.Event(), threading.Event(), threading.Event()
    original_read = store.read_task

    def delayed_read(task_id):
        result = original_read(task_id)
        if threading.current_thread().name == "lifecycle":
            read.set()
            assert release.wait(3)
        return result

    monkeypatch.setattr(store, "read_task", delayed_read)
    lifecycle = threading.Thread(name="lifecycle", target=lambda: store.update_task(task["task_id"], status="succeeded"))
    def rename():
        store.save_exploration_title(task["task_id"], expected_title=task["title"], title="文档搜索")
        renamed.set()
    title_worker = threading.Thread(target=rename)
    lifecycle.start()
    try:
        assert read.wait(2)
        title_worker.start()
        assert not renamed.wait(0.05)
    finally:
        release.set()
        lifecycle.join(3)
        title_worker.join(3)
    saved = store.read_task(task["task_id"])
    assert saved["title"] == "文档搜索" and saved["status"] == "succeeded"


def test_independent_creation_schedules_ai_title_after_start(monkeypatch, tmp_path):
    store = TaskStore(tmp_path)
    manager = ProcessManager(store=store, model_config_loader=model)
    events = []
    task = record(store)
    def start(**kwargs):
        events.append("start")
        assert kwargs["activity_type"] == "exploration"
        return task
    monkeypatch.setattr(manager, "start_task", start)
    monkeypatch.setattr(manager, "ensure_exploration_title", lambda task: events.append("title"))
    assert manager.start_url_exploration(start_url="https://example.com/docs") == task
    assert events == ["start", "title"]


def test_explicit_title_is_preserved_even_when_matching_default(monkeypatch, tmp_path):
    store = TaskStore(tmp_path)
    task = record(store)
    manager = ProcessManager(store=store, model_config_loader=model)
    monkeypatch.setattr(manager, "start_task", lambda **kwargs: task)
    saved = manager.start_url_exploration(start_url=task["start_url"], title=task["title"])
    assert saved["title_source"] == "custom"
    assert manager.exploration_titles.ensure(saved) is None


def test_tool_exploration_schedules_a_title_without_changing_its_execution(monkeypatch, tmp_path):
    from webwright.server.toolkit_store import ToolkitStore

    store = TaskStore(tmp_path / "tasks")
    toolkit = ToolkitStore(tmp_path / "toolkits")
    toolkit.create_toolkit(name="example", allowed_domains=["example.com"])
    toolkit.create_tool("example", name="search", goal="搜索文档", start_url="https://example.com/docs")
    task = record(store, title="Explore search", tool_id="search", toolkit_id="example")
    manager = ProcessManager(store=store, toolkit_store=toolkit, model_config_loader=model)
    calls = []
    def start(**kwargs):
        assert kwargs["target_id"] == "example-tab"
        assert kwargs["tool_id"] == "search" and kwargs["toolkit_id"] == "example"
        assert "搜索文档" in kwargs["instruction"]
        return task
    monkeypatch.setattr(manager, "start_task", start)
    monkeypatch.setattr(manager, "ensure_exploration_title", lambda item: calls.append(item))
    assert manager.start_exploration(toolkit_id="example", tool_id="search", target_id="example-tab") == task
    assert calls == [task]
