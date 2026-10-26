from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
from types import SimpleNamespace
import sys
import zipfile
from pathlib import Path

import pytest

from webwright.paths import WebwrightPaths
from webwright.models.openai_chat_model import OpenAIChatModel
from webwright.run import tool_development
from webwright.server.debug_store import DebugRunStore
from webwright.server.app import create_app
from webwright.server.development import build_development_input, sanitize_evidence
from webwright.server.development_store import DevelopmentRunStore
from webwright.server.process_manager import (
    DEVELOPER_REQUEST_TIMEOUT_S,
    InvalidStateError,
    ProcessManager,
)
from webwright.server.weworker_model_config import ManagedModelConfig
from webwright.server import publisher as publisher_module
from webwright.server.publisher import ToolkitPublisher, artifact_hash, render_artifacts
from webwright.server.adapter_v2 import bind_base, current_package, package_digest, snapshot_package
from webwright.runtime_identity import RuntimeIdentity
from webwright.server.records import TaskStore, atomic_write_json
from webwright.server.status import DebugRunStatus, DevelopmentRunStatus
from webwright.server.toolkit_store import ToolkitStore


def _stores(tmp_path: Path):
    toolkits = ToolkitStore(tmp_path / "toolkits")
    toolkits.create_toolkit(
        name="blog_admin", description="Blog tools", allowed_domains=["blog.example.com"]
    )
    toolkits.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/posts",
    )
    return toolkits, DebugRunStore(toolkits), DevelopmentRunStore(toolkits)


def _verified_formal_run(toolkits: ToolkitStore, debug_runs: DebugRunStore, tool_id: str, build: dict):
    run = debug_runs.create(
        tool_id=tool_id,
        toolkit_id="blog_admin",
        channel="formal",
        code_hash="sha256:" + build["digest"],
        artifact_hash=build["digest"],
        distribution_hash=build["digest"],
        runtime_identity=RuntimeIdentity.resolve().as_health_fields(),
        parameters={"keyword": "x"},
    )
    debug_runs.update(run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)
    return run


def _managed_model() -> ManagedModelConfig:
    return ManagedModelConfig(
        provider_id="glm",
        protocol="openai_chat_completions",
        model_class="zhipu",
        base_url="http://model.local",
        model="developer-test",
        api_key="secret-key",
        structured_output="openai_json_object",
    )


def _slot(code_suffix: str = ""):
    return {
        "code": (
            "async def search_blog(ctx, *, keyword):\n"
            f"    return {{'keyword': keyword{code_suffix}}}"
        ),
        "description": "Search posts",
        "parameters_schema": {
            "type": "object",
            "properties": {"keyword": {"type": "string"}},
            "required": ["keyword"],
            "additionalProperties": False,
        },
        "result_schema": {
            "type": "object",
            "properties": {"keyword": {"type": "string"}},
            "required": ["keyword"],
        },
        "risk_notice": "",
    }


def _exploration(
    task_store: TaskStore,
    *,
    exploration_id: str = "exp_1",
    toolkit_id: str = "blog_admin",
    tool_id: str = "search_blog",
    status: str = "succeeded",
) -> dict:
    record = task_store.create_task_record(
        task_id=exploration_id,
        title="Explore",
        instruction="Search posts from the page",
        start_url="https://blog.example.com/posts",
        output_dir=task_store.task_dir(exploration_id),
        run_id="run-1",
        activity_type="exploration",
        toolkit_id=toolkit_id,
        tool_id=tool_id,
    )
    return task_store.update_task(record["task_id"], status=status)


def test_evidence_filter_removes_runtime_identity_recursively() -> None:
    sanitized = sanitize_evidence(
        {
            "target_id": "secret",
            "nested": [{"cdp_url": "http://localhost", "title": "Visible"}],
            "OPENAI_api_key": "secret",
        }
    )
    assert sanitized == {"nested": [{"title": "Visible"}]}


def test_exploration_only_input_excludes_all_code_and_debug_evidence(
    tmp_path: Path,
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    task_store = TaskStore(tmp_path / "tasks")
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    toolkits.write_development_slot("blog_admin", "search_blog", _slot(", 'draft': True"))
    _exploration(task_store)
    debug_run = debug_runs.create(
        tool_id="search_blog",
        channel="formal",
        code_hash=formal["code_hash"],
        parameters={"keyword": "Webwright"},
    )

    payload = build_development_input(
        task_store=task_store,
        toolkit_store=toolkits,
        debug_store=debug_runs,
        toolkit_id="blog_admin",
        tool_id="search_blog",
        instruction="Rebuild only from this exploration",
        source_exploration_id="exp_1",
        debug_run_evidence_id=debug_run["debug_run_id"],
        exploration_only=True,
    )

    assert payload["base_slot"] is None
    assert payload["debug_run_evidence"] is None
    assert payload["source_exploration"]["exploration_id"] == "exp_1"
    assert formal["code"] not in json.dumps(payload)
    assert "draft" not in json.dumps(payload)


@pytest.mark.parametrize(
    ("tool_id", "status", "message"),
    [
        ("other_tool", "succeeded", "does not belong"),
        ("search_blog", "failed", "must be succeeded"),
    ],
)
def test_exploration_only_rejects_invalid_source_before_clearing_development(
    monkeypatch, tmp_path: Path, tool_id: str, status: str, message: str
) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    task_store = TaskStore(tmp_path / "tasks")
    if tool_id == "other_tool":
        toolkits.create_tool(
            "blog_admin",
            name="other_tool",
            goal="Other",
            start_url="https://blog.example.com/other",
        )
    _exploration(task_store, tool_id=tool_id, status=status)
    existing = toolkits.write_development_slot(
        "blog_admin", "search_blog", _slot(", 'draft': True")
    )
    manager = ProcessManager(
        store=task_store,
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
    )

    with pytest.raises(ValueError, match=message):
        manager.start_development(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            instruction="Rebuild",
            source_exploration_id="exp_1",
            exploration_only=True,
        )

    assert toolkits.read_development_slot("blog_admin", "search_blog")[
        "code_hash"
    ] == existing["code_hash"]


def test_exploration_only_start_clears_draft_and_preserves_formal_artifact(
    monkeypatch, tmp_path: Path
) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    task_store = TaskStore(tmp_path / "tasks")
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    toolkits.write_development_slot("blog_admin", "search_blog", _slot(", 'draft': True"))
    _exploration(task_store)
    publisher = ToolkitPublisher(toolkits, debug_runs)
    build = publisher.ensure_consistent("blog_admin")
    v2_build = snapshot_package(toolkits, "blog_admin")
    formal_debug = _verified_formal_run(toolkits, debug_runs, "search_blog", v2_build)
    skill_root = toolkits.toolkit_dir("blog_admin") / "blog-admin"
    artifact_before = {
        path.relative_to(skill_root).as_posix(): path.read_bytes()
        for path in skill_root.rglob("*")
        if path.is_file()
    }
    manager = ProcessManager(
        store=task_store,
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
        model_config_loader=_managed_model,
    )
    monkeypatch.setattr(manager, "_spawn", lambda *args, **kwargs: PendingProcess())
    monkeypatch.setattr("webwright.server.process_manager.threading", SimpleNamespace(Thread=NoStartThread))

    run = manager.start_development(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        instruction="Rebuild only from this exploration",
        source_exploration_id="exp_1",
        debug_run_evidence_id=formal_debug["debug_run_id"],
        exploration_only=True,
    )

    saved = development_runs.read(run["development_run_id"])
    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    evidence = json.loads((run_dir / "input.json").read_text(encoding="utf-8"))
    spec = json.loads((run_dir / "development_spec.json").read_text(encoding="utf-8"))
    assert toolkits.read_development_slot("blog_admin", "search_blog") is None
    assert toolkits.read_formal_slot("blog_admin", "search_blog")["code_hash"] == formal["code_hash"]
    assert saved["exploration_only"] is True
    assert saved["source_exploration_id"] == "exp_1"
    assert saved["based_on_formal_hash"] == ""
    assert saved["debug_run_evidence_id"] == ""
    assert spec["exploration_only"] is True
    assert evidence["base_slot"] is None
    assert evidence["debug_run_evidence"] is None
    assert build["artifact_hash"] == publisher.ensure_consistent("blog_admin")["artifact_hash"]
    assert publisher.export_status("blog_admin")["export_eligible"] is True
    assert current_package(toolkits, "blog_admin")[0] == v2_build
    assert artifact_before == {
        path.relative_to(skill_root).as_posix(): path.read_bytes()
        for path in skill_root.rglob("*")
        if path.is_file()
    }


def test_exploration_only_failure_leaves_formal_active_and_development_empty(
    monkeypatch, tmp_path: Path
) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    task_store = TaskStore(tmp_path / "tasks")
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    toolkits.write_development_slot("blog_admin", "search_blog", _slot(", 'draft': True"))
    _exploration(task_store)
    manager = ProcessManager(
        store=task_store,
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
        model_config_loader=_managed_model,
    )
    monkeypatch.setattr(manager, "_spawn", lambda *args, **kwargs: PendingProcess())
    monkeypatch.setattr("webwright.server.process_manager.threading", SimpleNamespace(Thread=NoStartThread))
    run = manager.start_development(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        instruction="Rebuild",
        source_exploration_id="exp_1",
        exploration_only=True,
    )

    manager._finish_development(run["development_run_id"], 1)

    assert development_runs.read(run["development_run_id"])["status"] == "failed"
    assert toolkits.read_development_slot("blog_admin", "search_blog") is None
    assert toolkits.read_formal_slot("blog_admin", "search_blog")["code_hash"] == formal["code_hash"]


def test_exploration_only_success_is_published_before_formal_artifact_changes(
    monkeypatch, tmp_path: Path
) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    task_store = TaskStore(tmp_path / "tasks")
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    toolkits.write_development_slot("blog_admin", "search_blog", _slot(", 'draft': True"))
    _exploration(task_store)
    publisher = ToolkitPublisher(toolkits, debug_runs)
    old_build = publisher.ensure_consistent("blog_admin")
    manager = ProcessManager(
        store=task_store,
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
        model_config_loader=_managed_model,
    )
    monkeypatch.setattr(manager, "_spawn", lambda *args, **kwargs: PendingProcess())
    monkeypatch.setattr("webwright.server.process_manager.threading", SimpleNamespace(Thread=NoStartThread))
    run = manager.start_development(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        instruction="Rebuild",
        source_exploration_id="exp_1",
        exploration_only=True,
    )
    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    atomic_write_json(
        run_dir / "result.json",
        {"ok": True, "slot": _slot(", 'rebuilt': True")},
    )

    manager._finish_development(run["development_run_id"], 0)

    development = toolkits.read_development_slot("blog_admin", "search_blog")
    assert development["source_exploration_id"] == "exp_1"
    assert development["based_on_formal_hash"] == ""
    assert development["debug_run_evidence_id"] == ""
    assert toolkits.read_formal_slot("blog_admin", "search_blog")["code_hash"] == formal["code_hash"]
    assert publisher.ensure_consistent("blog_admin")["artifact_hash"] == old_build["artifact_hash"]
    development_debug = debug_runs.create(
        tool_id="search_blog",
        channel="development",
        code_hash=development["code_hash"],
        parameters={"keyword": "Webwright"},
    )
    debug_runs.update(
        development_debug["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value
    )

    published = publisher.publish("blog_admin", "search_blog")

    assert published["formal"]["code_hash"] == development["code_hash"]
    assert published["build"]["digest"] == current_package(toolkits, "blog_admin")[0]["digest"]
    assert toolkits.read_development_slot("blog_admin", "search_blog") is None
    assert publisher.export_status("blog_admin")["export_eligible"] is False


def test_finish_development_validates_and_overwrites_single_slot(tmp_path: Path) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
    )
    run = development_runs.create(
        toolkit_id="blog_admin", tool_id="search_blog", instruction="Build it"
    )
    development_runs.update(
        run["development_run_id"],
        status=DevelopmentRunStatus.RUNNING.value,
        source_exploration_id="exp_1",
        based_on_formal_hash="",
        debug_run_evidence_id="",
    )
    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    atomic_write_json(run_dir / "result.json", {"ok": True, "slot": _slot()})

    manager._finish_development(run["development_run_id"], 0)

    saved = development_runs.read(run["development_run_id"])
    development = toolkits.read_development_slot("blog_admin", "search_blog")
    assert saved["status"] == "succeeded"
    assert development["source_exploration_id"] == "exp_1"
    assert saved["code_hash"] == development["code_hash"]


def test_tool_slot_rejects_runtime_internal_business_parameter(tmp_path: Path) -> None:
    toolkits, _debug_runs, _development_runs = _stores(tmp_path)
    invalid = _slot()
    invalid["code"] = "async def search_blog(ctx, *, target_id):\n    return {}"
    invalid["parameters_schema"]["properties"] = {"target_id": {"type": "string"}}
    with pytest.raises(ValueError, match="must not expose"):
        toolkits.write_development_slot("blog_admin", "search_blog", invalid)


class FakeDeveloperModel:
    def __init__(self, outputs: list[str] | None = None):
        self.outputs = iter(outputs or [json.dumps(_slot())])
        self.payloads: list[dict] = []

    def format_message(self, **kwargs):
        return kwargs

    def _build_structured_payload(self, messages, *, schema, schema_name):
        return {
            "mode": "structured",
            "messages": messages,
            "schema": schema,
            "schema_name": schema_name,
        }

    def _build_structured_repair_payload(
        self, messages, *, schema, schema_name, raw_text, error
    ):
        return {
            "mode": "repair",
            "messages": messages,
            "schema": schema,
            "schema_name": schema_name,
            "raw_text": raw_text,
            "error": error,
        }

    async def _post_with_retries(self, payload):
        self.payloads.append(payload)
        return {"text": next(self.outputs)}

    def _extract_text(self, response):
        return response["text"]


def test_developer_child_writes_structured_slot(monkeypatch, tmp_path: Path) -> None:
    input_path = tmp_path / "input.json"
    result_path = tmp_path / "result.json"
    input_path.write_text('{"tool":{"tool_id":"search_blog"}}', encoding="utf-8")
    model = FakeDeveloperModel()
    monkeypatch.setattr(tool_development, "get_model", lambda config: model)

    slot = asyncio.run(
        tool_development.run_development(
            {"input_path": str(input_path), "result_path": str(result_path), "model": {}}
        )
    )

    assert slot["description"] == "Search posts"
    assert json.loads(result_path.read_text(encoding="utf-8"))["ok"] is True
    assert len(model.payloads) == 1
    assert model.payloads[0]["mode"] == "structured"
    assert model.payloads[0]["schema_name"] == "developer_slot"
    assert model.payloads[0]["schema"]["additionalProperties"] is False
    assert model.payloads[0]["schema"]["required"] == [
        "code", "description", "parameters_schema", "result_schema", "risk_notice"
    ]
    assert "EXAMPLE JSON OUTPUT" in model.payloads[0]["messages"][0]["content"]


def test_developer_decodes_json_schema_strings_before_local_validation(
    monkeypatch, tmp_path: Path
) -> None:
    input_path = tmp_path / "input.json"
    input_path.write_text('{"tool":{"tool_id":"search_blog"}}', encoding="utf-8")
    output = _slot()
    output["parameters_schema"] = json.dumps(output["parameters_schema"])
    output["result_schema"] = json.dumps(output["result_schema"])
    model = FakeDeveloperModel([json.dumps(output)])
    monkeypatch.setattr(tool_development, "get_model", lambda _config: model)

    slot = asyncio.run(
        tool_development.run_development(
            {
                "input_path": str(input_path),
                "result_path": str(tmp_path / "result.json"),
                "model": {},
            }
        )
    )

    assert isinstance(slot["parameters_schema"], dict)
    assert isinstance(slot["result_schema"], dict)
    assert model.payloads[0]["schema"]["properties"]["parameters_schema"] == {
        "type": "string"
    }


@pytest.mark.parametrize(
    ("output", "error_code", "event"),
    [
        ("", "developer_output_empty", "output_empty"),
        ("not json", "developer_output_invalid_json", "output_parse_failed"),
    ],
)
def test_developer_output_failure_is_logged_without_raw_output(
    monkeypatch, tmp_path: Path, output: str, error_code: str, event: str
) -> None:
    input_path = tmp_path / "input.json"
    input_path.write_text('{"tool":{"tool_id":"search_blog"}}', encoding="utf-8")
    process_log = tmp_path / "process.log"
    runtime_errors = tmp_path / "runtime_errors.jsonl"
    model = FakeDeveloperModel([output, output])
    monkeypatch.setattr(tool_development, "get_model", lambda _config: model)

    with pytest.raises(tool_development.DeveloperRunError) as exc:
        asyncio.run(
            tool_development.run_development(
                {
                    "input_path": str(input_path),
                    "result_path": str(tmp_path / "result.json"),
                    "model": {
                        "process_log_path": str(process_log),
                        "error_log_path": str(runtime_errors),
                    },
                }
            )
        )

    assert exc.value.error_code == error_code
    combined = process_log.read_text(encoding="utf-8") + runtime_errors.read_text(
        encoding="utf-8"
    )
    assert event in combined
    assert error_code in combined
    assert "output_repair_started" in combined
    assert 'repair_attempted=true' in combined
    assert [payload["mode"] for payload in model.payloads] == ["structured", "repair"]
    if output:
        assert output not in combined


@pytest.mark.parametrize(
    "invalid_output",
    [
        "",
        "not json",
        json.dumps({**_slot(), "code": "async def wrong(ctx):\n    return {}"}),
    ],
)
def test_developer_output_repair_succeeds_once(
    monkeypatch, tmp_path: Path, invalid_output: str
) -> None:
    input_path = tmp_path / "input.json"
    result_path = tmp_path / "result.json"
    input_path.write_text('{"tool":{"tool_id":"search_blog"}}', encoding="utf-8")
    process_log = tmp_path / "process.log"
    model = FakeDeveloperModel([invalid_output, json.dumps(_slot())])
    monkeypatch.setattr(tool_development, "get_model", lambda _config: model)

    slot = asyncio.run(
        tool_development.run_development(
            {
                "input_path": str(input_path),
                "result_path": str(result_path),
                "model": {"process_log_path": str(process_log)},
            }
        )
    )

    assert slot["code"].startswith("async def search_blog")
    assert [payload["mode"] for payload in model.payloads] == ["structured", "repair"]
    lifecycle = process_log.read_text(encoding="utf-8")
    assert "output_repair_started" in lifecycle
    assert "output_parsed" in lifecycle
    assert "repair=true" in lifecycle


def test_deepseek_developer_empty_content_repairs_with_json_mode_and_thinking_disabled(
    monkeypatch, tmp_path: Path
) -> None:
    input_path = tmp_path / "input.json"
    input_path.write_text('{"tool":{"tool_id":"search_blog"}}', encoding="utf-8")
    process_log = tmp_path / "process.log"
    output = _slot()
    output["parameters_schema"] = json.dumps(output["parameters_schema"])
    output["result_schema"] = json.dumps(output["result_schema"])
    responses = iter(
        [
            {
                "choices": [
                    {
                        "finish_reason": "length",
                        "message": {"content": "", "reasoning_content": "thinking"},
                    }
                ]
            },
            {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": json.dumps(output)},
                    }
                ]
            },
        ]
    )
    payloads: list[dict] = []
    model = OpenAIChatModel(
        provider_id="deepseek",
        model_name="deepseek-v4-flash",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://api.deepseek.com/chat/completions",
        process_log_path=process_log,
    )

    async def fake_post(payload):
        payloads.append(payload)
        return next(responses)

    monkeypatch.setattr(model, "_post_with_retries", fake_post)
    monkeypatch.setattr(tool_development, "get_model", lambda _config: model)

    slot = asyncio.run(
        tool_development.run_development(
            {
                "input_path": str(input_path),
                "result_path": str(tmp_path / "result.json"),
                "model": {"process_log_path": str(process_log)},
            }
        )
    )

    assert slot["code"].startswith("async def search_blog")
    assert payloads[0]["response_format"] == {"type": "json_object"}
    assert "thinking" not in payloads[0]
    assert payloads[1]["response_format"] == {"type": "json_object"}
    assert payloads[1]["thinking"] == {"type": "disabled"}
    lifecycle = process_log.read_text(encoding="utf-8")
    assert "output_repair_started" in lifecycle
    assert "output_parsed" in lifecycle


def test_finish_development_uses_structured_child_error(tmp_path: Path) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
    )
    run = development_runs.create(
        toolkit_id="blog_admin", tool_id="search_blog", instruction="Build it"
    )
    development_runs.update(
        run["development_run_id"], status=DevelopmentRunStatus.RUNNING.value
    )
    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    (run_dir / "process.log").write_text(
        json.dumps(
            {
                "ok": False,
                "error_code": "developer_output_empty",
                "stage": "output_parse",
                "error": "模型返回了空内容。",
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    manager._finish_development(run["development_run_id"], 1)

    saved = development_runs.read(run["development_run_id"])
    assert saved["status"] == DevelopmentRunStatus.FAILED.value
    assert saved["error"] == "模型返回了空内容。"
    assert saved["error_code"] == "developer_output_empty"
    assert saved["error_stage"] == "output_parse"


def test_publisher_is_deterministic_and_old_hash_does_not_qualify(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    development = toolkits.write_development_slot("blog_admin", "search_blog", _slot())
    run = debug_runs.create(
        tool_id="search_blog",
        channel="development",
        code_hash=development["code_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)
    changed = toolkits.write_development_slot("blog_admin", "search_blog", _slot(", 'changed': True"))
    publisher = ToolkitPublisher(toolkits, debug_runs)

    first = render_artifacts(toolkits, "blog_admin", override=changed)
    second = render_artifacts(toolkits, "blog_admin", override=changed)
    publisher._validate(first, tool_ids=["search_blog"])

    assert artifact_hash(first) == artifact_hash(second)
    changed_runtime = {
        **first,
        "scripts/toolkit_runtime.py": first["scripts/toolkit_runtime.py"] + "\n# changed\n",
    }
    assert artifact_hash(changed_runtime) != artifact_hash(first)
    changed_skill = {**first, "SKILL.md": first["SKILL.md"] + "\nChanged\n"}
    changed_requirements = {
        **first,
        "scripts/requirements.txt": "playwright==9.9.9\n",
    }
    assert artifact_hash(changed_skill) == artifact_hash(first)
    assert artifact_hash(changed_requirements) == artifact_hash(first)
    assert "async def search_blog" in first["scripts/toolkit.py"]
    assert "target_id" not in first["SKILL.md"]
    assert "调用：`webcli call blog-admin.search-blog --参数名=参数值`" in first["SKILL.md"]
    assert "网站自动化运行环境已内嵌" in first["SKILL.md"]
    assert "python scripts/toolkit.py" not in first["SKILL.md"]
    assert "pip install" not in first["SKILL.md"]
    assert first["SKILL.md"].startswith("---\nname: blog-admin\n")
    frontmatter = first["SKILL.md"].split("---", 2)[1]
    assert (
        'description: "Blog tools。当需要操作以下域名的网页时可使用：blog.example.com。"'
        in frontmatter
    )
    assert "可操作网页域名" not in frontmatter
    assert "当需要调用" not in frontmatter
    assert "search_blog" not in frontmatter
    assert set(
        line.split(":", 1)[0] for line in frontmatter.splitlines() if line
    ) == {"name", "description"}
    assert first["scripts/requirements.txt"] == "playwright==1.60.0\n"
    manifest = json.loads(first["manifest.json"])
    assert manifest["adapter_type"] == "toolkit"
    assert manifest["id"] == "blog-admin"
    assert manifest["artifact_hash"] == artifact_hash(first)
    assert manifest["tools"] == [
        {
            "id": "search-blog",
            "name": "blog-admin.search-blog",
            "description": "Search posts",
            "parameters_schema": _slot()["parameters_schema"],
            "result_schema": _slot()["result_schema"],
        }
    ]
    with pytest.raises(ValueError, match="no succeeded Debug Run"):
        publisher.publish("blog_admin", "search_blog")
    assert toolkits.read_development_slot("blog_admin", "search_blog")["code_hash"] == changed["code_hash"]


def test_consistency_generator_installs_formal_artifacts(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)

    build = publisher.ensure_consistent("blog_admin")

    root = toolkits.toolkit_dir("blog_admin") / "blog-admin"
    scripts = root / "scripts"
    toolkit_source = (scripts / "toolkit.py").read_text(encoding="utf-8")
    assert compile(toolkit_source, "toolkit.py", "exec")
    assert "TOOL_SPECS" in toolkit_source
    assert "https://blog.example.com/posts" in toolkit_source
    assert build["formal_hashes"] == {"search_blog": formal["code_hash"]}
    assert set(build["distribution_checksums"]) == {
        "manifest.json",
        "SKILL.md",
        "scripts/requirements.txt",
    }

    (root / "SKILL.md").write_text("corrupted", encoding="utf-8")
    repaired = publisher.ensure_consistent("blog_admin")
    assert (root / "SKILL.md").read_text(encoding="utf-8") != "corrupted"
    assert repaired["artifact_hash"] == build["artifact_hash"]


def test_generated_adapter_owns_webcli_parameter_normalization(tmp_path: Path) -> None:
    toolkits, _debug_runs, _development_runs = _stores(tmp_path)
    artifacts = render_artifacts(toolkits, "blog_admin", override=_slot())
    scripts = tmp_path / "adapter" / "scripts"
    scripts.mkdir(parents=True)
    for name in ("scripts/toolkit.py", "scripts/toolkit_runtime.py"):
        (tmp_path / "adapter" / name).write_text(artifacts[name], encoding="utf-8")

    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import json
import runpy
import sys
from pathlib import Path

script = Path(sys.argv[1])
sys.path.insert(0, str(script.parent))
namespace = runpy.run_path(str(script), run_name="adapter_test")
schema = {
    "type": "object",
    "properties": {
        "max_items": {"type": "integer"},
        "scores": {"type": "array", "items": {"type": "number"}},
        "dry_run": {"type": "boolean"},
        "mode": {"type": "string", "enum": ["safe", "fast"], "default": "safe"},
    },
}
print(json.dumps(namespace["_normalize_webcli_parameters"](schema, json.loads(sys.argv[2])), sort_keys=True))
""",
            str(scripts / "toolkit.py"),
            '{"max-items":"7","scores":["1.5","2.5"],"dry_run":true}',
        ],
        cwd=tmp_path / "adapter",
        capture_output=True,
        text=True,
        check=False,
    )

    assert probe.returncode == 0, probe.stderr
    assert json.loads(probe.stdout) == {
        "max_items": 7,
        "scores": [1.5, 2.5],
        "dry_run": True,
        "mode": "safe",
    }


def test_generated_artifacts_are_independent_and_runtime_specs_are_embedded(
    tmp_path: Path,
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)

    publisher.ensure_consistent("blog_admin")

    root = toolkits.toolkit_dir("blog_admin") / "blog-admin"
    scripts = root / "scripts"
    toolkit_source = (scripts / "toolkit.py").read_text(encoding="utf-8")
    runtime_source = (scripts / "toolkit_runtime.py").read_text(encoding="utf-8")
    canonical_runtime = (
        Path(__file__).parents[2]
        / "src"
        / "webwright"
        / "tool_runtime"
        / "toolkit_runtime.py"
    )
    assert "from toolkit_runtime import PublishedToolkitRunner" in toolkit_source
    assert "ALLOWED_DOMAINS = ['blog.example.com']" in toolkit_source
    assert "TOOL_SPECS = {'search_blog':" in toolkit_source
    assert "'start_url': 'https://blog.example.com/posts'" in toolkit_source
    assert "'parameters_schema':" in toolkit_source
    assert "'result_schema':" in toolkit_source
    assert "ToolkitStore" not in toolkit_source
    assert "formal.json" not in toolkit_source
    assert "webwright." not in toolkit_source
    assert "import webwright" not in runtime_source
    assert "from webwright" not in runtime_source
    assert (scripts / "toolkit_runtime.py").read_bytes() == canonical_runtime.read_bytes()
    assert not (scripts / "toolkit.json").exists()


def test_generated_cli_starts_from_isolated_artifact_directory(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    ToolkitPublisher(toolkits, debug_runs).ensure_consistent("blog_admin")
    skill = toolkits.toolkit_dir("blog_admin") / "blog-admin"
    isolated = tmp_path / "isolated" / "blog-admin"
    (isolated / "scripts").mkdir(parents=True)
    for name in (
        "manifest.json",
        "SKILL.md",
        "scripts/toolkit.py",
        "scripts/toolkit_runtime.py",
        "scripts/requirements.txt",
    ):
        target = isolated / name
        target.write_bytes((skill / name).read_bytes())

    root_help = subprocess.run(
        [sys.executable, str(isolated / "scripts" / "toolkit.py"), "--help"],
        cwd=isolated,
        capture_output=True,
        text=True,
        check=False,
    )
    tool_help = subprocess.run(
        [sys.executable, str(isolated / "scripts" / "toolkit.py"), "search-blog", "--help"],
        cwd=isolated,
        capture_output=True,
        text=True,
        check=False,
    )
    debug_runtime = tmp_path / "debug-runtime.json"
    debug_run = subprocess.run(
        [sys.executable, str(isolated / "scripts" / "toolkit.py"), "search-blog"],
        cwd=isolated,
        env={
            **os.environ,
            "WEBWRIGHT_PARAMETERS_STDIN": "1",
            "WEBWRIGHT_RUNTIME_PATH": str(debug_runtime),
        },
        input='{"keyword": 42}',
        capture_output=True,
        text=True,
        check=False,
    )

    assert root_help.returncode == 0, root_help.stderr
    assert "search-blog" in root_help.stdout
    assert tool_help.returncode == 0, tool_help.stderr
    assert "--keyword" in tool_help.stdout
    assert debug_run.returncode == 1
    debug_output = json.loads(debug_run.stdout.strip().splitlines()[-1])
    assert debug_output["error"]["message"] == "Invalid parameter type for keyword: string"
    assert not (isolated / "runtime.json").exists()
    assert not (isolated / "scripts" / "__pycache__").exists()
    assert not (isolated / "tools").exists()
    assert not (isolated / ".server").exists()


def test_export_requires_every_formal_tool_for_current_artifact(monkeypatch, tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    search_formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    toolkits.create_tool(
        "blog_admin",
        name="open_blog",
        goal="Open post",
        start_url="https://blog.example.com/posts",
    )
    open_slot = {
        **_slot(),
        "code": "async def open_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
    }
    open_formal = toolkits.write_formal_slot("blog_admin", "open_blog", open_slot)
    publisher = ToolkitPublisher(toolkits, debug_runs)
    build = snapshot_package(toolkits, "blog_admin")
    _verified_formal_run(toolkits, debug_runs, "search_blog", build)

    pending = publisher.export_status("blog_admin")
    assert pending["export_eligible"] is False
    assert pending["unverified_tools"] == ["open_blog"]
    with pytest.raises(ValueError, match="not eligible"):
        publisher.export_zip("blog_admin")

    _verified_formal_run(toolkits, debug_runs, "open_blog", build)

    ready = publisher.export_status("blog_admin")
    assert ready["export_eligible"] is True
    archive = zipfile.ZipFile(io.BytesIO(publisher.export_zip("blog_admin")))
    assert set(archive.namelist()) == {
        "blog-admin/manifest.json",
        "blog-admin/wewright/commands/open-blog.py",
        "blog-admin/wewright/commands/search-blog.py",
    }
    manifest = json.loads(archive.read("blog-admin/manifest.json"))
    assert manifest["schema_version"] == 2
    assert {command["id"] for command in manifest["commands"]} == {"open-blog", "search-blog"}
    changed_runtime = {**RuntimeIdentity.resolve().as_health_fields(), "build": "changed-build"}
    monkeypatch.setattr(publisher_module.RuntimeIdentity, "resolve", lambda: SimpleNamespace(as_health_fields=lambda: changed_runtime))
    assert publisher.export_status("blog_admin")["export_eligible"] is False


def test_mixed_v2_package_retains_extension_bytes_and_validates_with_host(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    extension_source = b"window.__webcliRegisterCommand('list', () => ({ok:true}));\n"
    base_manifest = {
        "schema_version": 2, "name": "mixed.example.com", "version": "1.2.3",
        "description": "Example site commands", "match": ["example.com"],
        "commands": [{"id": "list", "runtime": "extension", "module": "extension/commands/list.js",
                      "description": "List items", "schema": {"type": "object", "properties": {}}}],
    }
    base_files = {
        "manifest.json": (json.dumps(base_manifest) + "\n").encode(),
        "extension/commands/list.js": extension_source,
    }
    bind_base(toolkits, "blog_admin", profile="public", digest=package_digest(base_files),
              files={name: base64.b64encode(content).decode() for name, content in base_files.items()})
    toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    build = snapshot_package(toolkits, "blog_admin")
    metadata, files, _ = current_package(toolkits, "blog_admin")
    assert metadata == build
    assert files["extension/commands/list.js"] == extension_source
    manifest = json.loads(files["manifest.json"])
    assert manifest["commands"][0] == base_manifest["commands"][0]
    assert manifest["version"] == "1.2.4"
    command = manifest["commands"][1]
    assert (command["id"], command["runtime"]) == ("search-blog", "wewright")
    assert command["safety"] == "read"
    node_source = """import {validatePackageFiles} from './webcli/adapter-package-files.js';
const payload = JSON.parse(await new Promise(resolve => { let data=''; process.stdin.on('data', part => data+=part); process.stdin.on('end', () => resolve(data)); }));
const files = new Map(Object.entries(payload.files).map(([name, value]) => [name, Buffer.from(value, 'base64')]));
const result = validatePackageFiles(files);
if (result.digest !== payload.digest || result.commands.length !== 2) process.exit(2);
"""
    verified = subprocess.run(
        ["node", "--input-type=module", "-e", node_source],
        input=json.dumps({"files": {name: base64.b64encode(content).decode() for name, content in files.items()},
                          "digest": build["digest"]}),
        text=True, capture_output=True, cwd=Path(__file__).parents[4], check=False,
    )
    assert verified.returncode == 0, verified.stderr


def test_export_api_rechecks_eligibility_and_old_artifact_is_invalidated(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)
    build = snapshot_package(toolkits, "blog_admin")
    _verified_formal_run(toolkits, debug_runs, "search_blog", build)
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        publisher=publisher,
    )
    client = app.test_client()

    assert client.get("/api/toolkits/blog_admin/export-status").get_json()[
        "export_eligible"
    ] is True
    exported = client.get("/api/toolkits/blog_admin/export")
    assert exported.status_code == 200
    assert exported.mimetype == "application/zip"
    assert "blog-admin.zip" in exported.headers["Content-Disposition"]

    development = toolkits.write_development_slot(
        "blog_admin", "search_blog", _slot(", 'changed': True")
    )
    development_run = debug_runs.create(
        tool_id="search_blog",
        channel="development",
        code_hash=development["code_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(
        development_run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value
    )
    publisher.publish("blog_admin", "search_blog")

    stale = client.get("/api/toolkits/blog_admin/export-status").get_json()
    assert stale["export_eligible"] is False
    assert stale["unverified_tools"] == ["search_blog"]
    assert client.get("/api/toolkits/blog_admin/export").status_code == 400


def test_embedded_capability_directly_overwrites_project_skill(
    tmp_path: Path,
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)
    build = snapshot_package(toolkits, "blog_admin")
    _verified_formal_run(toolkits, debug_runs, "search_blog", build)

    user_files_dir = tmp_path / "user-files"
    target = user_files_dir / ".claude" / "skills" / "blog-admin"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("manual skill", encoding="utf-8")
    (target / "manual.txt").write_text("must be overwritten", encoding="utf-8")
    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        publisher=publisher,
        weworker_user_files_dir=user_files_dir,
    )
    client = app.test_client()

    health = client.get("/api/health").get_json()
    installed = client.post("/api/toolkits/blog_admin/install-to-weworker")
    package = client.get("/api/toolkits/blog_admin/v2-package")

    assert health["capabilities"]["install_to_weworker"] is False
    assert health["capabilities"]["adapter_v2_package"] is True
    assert installed.status_code == 409
    assert package.status_code == 200
    assert package.get_json()["digest"] == build["digest"]
    assert {
        path.relative_to(target).as_posix()
        for path in target.rglob("*")
        if path.is_file()
    } == {"SKILL.md", "manual.txt"}
    assert (target / "SKILL.md").read_text(encoding="utf-8") == "manual skill"


def test_direct_install_restores_existing_skill_when_directory_switch_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)
    build = publisher.ensure_consistent("blog_admin")
    run = debug_runs.create(
        tool_id="search_blog",
        channel="formal",
        code_hash=formal["code_hash"],
        artifact_hash=build["artifact_hash"],
        distribution_hash=build["distribution_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)

    user_files_dir = tmp_path / "user-files"
    target = user_files_dir / ".claude" / "skills" / "blog-admin"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("manual skill", encoding="utf-8")
    original_replace = Path.replace

    def fail_staged_switch(source: Path, destination: Path | str):
        if source.name == "blog-admin" and source.parent.name.startswith(
            ".webwright-install-"
        ):
            raise OSError("simulated directory switch failure")
        return original_replace(source, destination)

    monkeypatch.setattr(Path, "replace", fail_staged_switch)

    with pytest.raises(ValueError, match="host installer"):
        publisher.install_to_weworker(
            "blog_admin", user_files_dir=user_files_dir
        )

    assert (target / "SKILL.md").read_text(encoding="utf-8") == "manual skill"
    assert not list(target.parent.glob(".webwright-install-*"))
    assert not list(target.parent.glob(".blog-admin.webwright-backup-*"))


def test_direct_install_preserves_existing_skill_when_staging_write_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "user-files" / ".claude" / "skills" / "blog-admin"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("manual skill", encoding="utf-8")

    def fail_write(_path: Path, _content: str) -> None:
        raise OSError("simulated staging write failure")

    monkeypatch.setattr(publisher_module, "_atomic_write_text", fail_write)

    with pytest.raises(OSError, match="simulated"):
        publisher_module._replace_skill_directory(
            target,
            {
                "SKILL.md": "new skill",
                "scripts/toolkit.py": "",
                "scripts/toolkit_runtime.py": "",
                "scripts/requirements.txt": "",
            },
        )

    assert (target / "SKILL.md").read_text(encoding="utf-8") == "manual skill"
    assert not list(target.parent.glob(".webwright-install-*"))


def test_export_rejects_distribution_file_changes_without_repairing(
    tmp_path: Path,
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)
    build = snapshot_package(toolkits, "blog_admin")
    _verified_formal_run(toolkits, debug_runs, "search_blog", build)
    source_path = current_package(toolkits, "blog_admin")[2] / "wewright/commands/search-blog.py"
    source_path.write_text("corrupted", encoding="utf-8")

    with pytest.raises(ValueError, match="changed"):
        publisher.export_zip("blog_admin")

    assert source_path.read_text(encoding="utf-8") == "corrupted"


def test_startup_preserves_package_and_development_but_old_formal_run_is_unverified(
    tmp_path: Path,
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    development = toolkits.write_development_slot(
        "blog_admin", "search_blog", _slot(", 'draft': True")
    )
    toolkits.write_runtime(
        "blog_admin",
        target_id="existing-target",
        last_url="https://blog.example.com/posts",
        last_title="Posts",
    )
    root = toolkits.toolkit_dir("blog_admin")
    build = snapshot_package(toolkits, "blog_admin")
    source_file = current_package(toolkits, "blog_admin")[2] / "wewright/commands/search-blog.py"
    original_source = source_file.read_bytes()
    legacy_run = debug_runs.create(
        tool_id="search_blog",
        channel="formal",
        code_hash=formal["code_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(legacy_run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)

    app = create_app(
        paths=WebwrightPaths.resolve(home=tmp_path),
        toolkit_store=toolkits,
        debug_store=debug_runs,
    )

    assert source_file.read_bytes() == original_source
    assert toolkits.read_runtime("blog_admin")["target_id"] == "existing-target"
    assert toolkits.read_development_slot("blog_admin", "search_blog")[
        "code_hash"
    ] == development["code_hash"]
    assert debug_runs.read(legacy_run["debug_run_id"])["artifact_hash"] == ""
    status = app.test_client().get("/api/toolkits/blog_admin/export-status").get_json()
    assert status["export_eligible"] is False
    assert status["unverified_tools"] == ["search_blog"]
    assert status["distribution_hash"] == build["digest"]


def test_reset_from_formal_discards_source_binding(tmp_path: Path) -> None:
    toolkits, _debug_runs, _development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    development = _slot(", 'draft': True")
    development["source_exploration_id"] = "exp_1"
    toolkits.write_development_slot("blog_admin", "search_blog", development)

    reset = toolkits.reset_development_from_formal("blog_admin", "search_blog")

    assert reset["code_hash"] == formal["code_hash"]
    assert reset["based_on_formal_hash"] == formal["code_hash"]
    assert reset["source_exploration_id"] == ""


def test_publish_installs_all_artifacts_and_clears_development(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    toolkits.create_tool(
        "blog_admin",
        name="open_blog",
        goal="Open a post",
        start_url="https://blog.example.com/posts",
    )
    other_slot = {
        **_slot(),
        "code": "async def open_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
    }
    other_formal = toolkits.write_formal_slot("blog_admin", "open_blog", other_slot)
    development = toolkits.write_development_slot("blog_admin", "search_blog", _slot())
    run = debug_runs.create(
        tool_id="search_blog",
        channel="development",
        code_hash=development["code_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)
    publisher = ToolkitPublisher(toolkits, debug_runs)

    result = publisher.publish("blog_admin", "search_blog")

    root = toolkits.toolkit_dir("blog_admin")
    assert result["formal"]["code_hash"] == development["code_hash"]
    assert toolkits.read_development_slot("blog_admin", "search_blog") is None
    assert toolkits.read_formal_slot("blog_admin", "open_blog")["code_hash"] == other_formal["code_hash"]
    metadata, files, package_root = current_package(toolkits, "blog_admin")
    assert metadata == result["build"]
    assert {"manifest.json", "wewright/commands/search-blog.py", "wewright/commands/open-blog.py"} == set(files)
    assert "async def search_blog" in (package_root / "wewright/commands/search-blog.py").read_text(encoding="utf-8")
    assert "async def open_blog" in (package_root / "wewright/commands/open-blog.py").read_text(encoding="utf-8")
    assert not publisher.journal_path("blog_admin").exists()


def test_publish_preserves_newer_development_written_during_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    development = toolkits.write_development_slot("blog_admin", "search_blog", _slot())
    newer = _slot(", 'newer': True")
    run = debug_runs.create(
        tool_id="search_blog",
        channel="development",
        code_hash=development["code_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)
    publisher = ToolkitPublisher(toolkits, debug_runs)
    from webwright.server import publisher as publisher_module
    original_snapshot = publisher_module.snapshot_package

    def snapshot_after_new_development(store: ToolkitStore, toolkit_id: str):
        toolkits.write_development_slot(toolkit_id, "search_blog", newer)
        return original_snapshot(store, toolkit_id)

    monkeypatch.setattr(publisher_module, "snapshot_package", snapshot_after_new_development)

    publisher.publish("blog_admin", "search_blog")

    current = toolkits.read_development_slot("blog_admin", "search_blog")
    assert current is not None
    assert current["code_hash"] != development["code_hash"]
    assert "newer" in current["code"]


def test_publish_aborts_if_development_changes_before_promotion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    development = toolkits.write_development_slot("blog_admin", "search_blog", _slot())
    newer = _slot(", 'newer': True")
    run = debug_runs.create(
        tool_id="search_blog",
        channel="development",
        code_hash=development["code_hash"],
        parameters={"keyword": "x"},
    )
    debug_runs.update(run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value)
    publisher = ToolkitPublisher(toolkits, debug_runs)
    original_promote = toolkits.promote_development_slot

    def promote_after_new_development(
        toolkit_id: str, tool_id: str, *, expected_code_hash: str
    ):
        toolkits.write_development_slot(toolkit_id, tool_id, newer)
        return original_promote(
            toolkit_id, tool_id, expected_code_hash=expected_code_hash
        )

    monkeypatch.setattr(toolkits, "promote_development_slot", promote_after_new_development)

    with pytest.raises(ValueError, match="changed during publish"):
        publisher.publish("blog_admin", "search_blog")

    current = toolkits.read_development_slot("blog_admin", "search_blog")
    assert current is not None
    assert "newer" in current["code"]
    assert toolkits.read_formal_slot("blog_admin", "search_blog") is None
    assert not publisher.journal_path("blog_admin").exists()


def test_publish_journal_recovers_formal_installed_phase(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    development = toolkits.write_development_slot(
        "blog_admin", "search_blog", _slot(", 'draft': True")
    )
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", development)
    publisher = ToolkitPublisher(toolkits, debug_runs)
    atomic_write_json(
        publisher.journal_path("blog_admin"),
        {
            "toolkit_id": "blog_admin",
            "tool_id": "search_blog",
            "code_hash": formal["code_hash"],
            "phase": "formal_installed",
        },
    )

    publisher.recover("blog_admin")

    assert toolkits.read_development_slot("blog_admin", "search_blog") is None
    assert not publisher.journal_path("blog_admin").exists()
    assert current_package(toolkits, "blog_admin")[0]["digest"]


def test_publish_journal_recovers_prepared_phase_after_formal_write(tmp_path: Path) -> None:
    toolkits, debug_runs, _development_runs = _stores(tmp_path)
    toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    publisher = ToolkitPublisher(toolkits, debug_runs)
    snapshot_package(toolkits, "blog_admin")
    development = toolkits.write_development_slot(
        "blog_admin", "search_blog", _slot(", 'recovered': True")
    )
    atomic_write_json(
        publisher.journal_path("blog_admin"),
        {
            "toolkit_id": "blog_admin",
            "tool_id": "search_blog",
            "code_hash": development["code_hash"],
            "phase": "prepared",
        },
    )
    toolkits.write_formal_slot("blog_admin", "search_blog", development)

    publisher.recover("blog_admin")

    assert "recovered" in current_package(toolkits, "blog_admin")[1]["wewright/commands/search-blog.py"].decode("utf-8")
    assert toolkits.read_development_slot("blog_admin", "search_blog") is None
    assert not publisher.journal_path("blog_admin").exists()


class PendingProcess:
    pid = 1234

    def poll(self):
        return None

    def wait(self, timeout=None):
        return -15

    def send_signal(self, signal):
        pass

    def terminate(self):
        pass

    def kill(self):
        pass


class NoStartThread:
    def __init__(self, *, target, kwargs, daemon):
        self.target = target
        self.kwargs = kwargs

    def start(self):
        pass


def test_resolve_developer_openai_model_preserves_provider_identity(
    tmp_path: Path,
) -> None:
    active = ManagedModelConfig(
        provider_id="deepseek",
        protocol="openai_chat_completions",
        model_class="openai_chat",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        api_key="secret-key",
        structured_output="openai_json_object",
    )
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        model_config_loader=lambda: active,
    )

    model, environment = manager._resolve_developer_model()

    assert model == {
        "model_class": "openai_chat",
        "provider_id": "deepseek",
        "model_name": "deepseek-v4-flash",
        "openai_chat_endpoint": "https://api.deepseek.com/chat/completions",
        "request_timeout_seconds": DEVELOPER_REQUEST_TIMEOUT_S,
    }
    assert environment == {"OPENAI_CHAT_API_KEY": "secret-key"}


def test_start_development_from_formal_isolated_model_spec(monkeypatch, tmp_path: Path) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    formal = toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
        model_config_loader=_managed_model,
    )
    monkeypatch.setattr(manager, "_spawn", lambda *args, **kwargs: PendingProcess())
    monkeypatch.setattr("webwright.server.process_manager.threading", SimpleNamespace(Thread=NoStartThread))

    run = manager.start_development(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        instruction="Improve reliability",
    )

    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    spec = json.loads((run_dir / "development_spec.json").read_text(encoding="utf-8"))
    evidence = json.loads((run_dir / "input.json").read_text(encoding="utf-8"))
    assert evidence["base_slot"]["code_hash"] == formal["code_hash"]
    assert spec["model"]["model_class"] == "zhipu"
    assert spec["model"]["zhipu_endpoint"] == "http://model.local/chat/completions"
    assert spec["model"]["process_log_path"] == str(run_dir / "process.log")
    assert "api_key" not in json.dumps(spec)
    assert "target_id" not in json.dumps(evidence)
    lifecycle = (run_dir / "process.log").read_text(encoding="utf-8")
    assert "development_run_created" in lifecycle
    assert "development_run_started" in lifecycle

    cancelled = manager.cancel_development(run["development_run_id"])
    assert cancelled["status"] == "cancelled"


def test_development_model_setup_failure_is_logged(tmp_path: Path) -> None:
    toolkits, debug_runs, development_runs = _stores(tmp_path)
    toolkits.write_formal_slot("blog_admin", "search_blog", _slot())
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
        model_config_loader=lambda: (_ for _ in ()).throw(RuntimeError("missing")),
    )

    with pytest.raises(InvalidStateError, match="请先在 WeWorker 中配置"):
        manager.start_development(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            instruction="Improve reliability",
        )

    [run] = development_runs.list_for_tool("blog_admin", "search_blog")
    assert run["status"] == DevelopmentRunStatus.FAILED.value
    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    lifecycle = (run_dir / "process.log").read_text(encoding="utf-8")
    assert "development_run_created" in lifecycle
    assert "development_run_setup_failed" in lifecycle
    assert "development_run_finished" in lifecycle


def test_development_timeout_lifecycle_is_logged(monkeypatch, tmp_path: Path) -> None:
    class TimeoutProcess(PendingProcess):
        def wait(self, timeout=None):
            if timeout == 1:
                raise subprocess.TimeoutExpired("development", timeout)
            return -15

    toolkits, debug_runs, development_runs = _stores(tmp_path)
    manager = ProcessManager(
        store=TaskStore(tmp_path / "tasks"),
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
    )
    run = development_runs.create(
        toolkit_id="blog_admin",
        tool_id="search_blog",
        instruction="Improve reliability",
    )
    development_runs.update(
        run["development_run_id"],
        status=DevelopmentRunStatus.RUNNING.value,
    )
    process = TimeoutProcess()
    manager.active_process = process
    manager.active_kind = "development"
    manager.active_id = run["development_run_id"]
    monkeypatch.setattr(manager, "_terminate_process_tree", lambda *_args, **_kwargs: None)

    manager._watch_development(
        development_run_id=run["development_run_id"],
        process=process,
        timeout_seconds=1,
    )

    saved = development_runs.read(run["development_run_id"])
    assert saved["status"] == DevelopmentRunStatus.FAILED.value
    assert saved["error"] == "Development Run timed out."
    run_dir = development_runs.run_dir("blog_admin", run["development_run_id"])
    lifecycle = (run_dir / "process.log").read_text(encoding="utf-8")
    assert "development_run_timeout" in lifecycle
    assert "worker_terminating" in lifecycle
    assert "worker_exited" in lifecycle
    assert "development_run_finished" in lifecycle
