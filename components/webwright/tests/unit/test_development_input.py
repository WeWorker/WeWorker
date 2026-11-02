from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace

from webwright.server.development import _compact_steps, _followup_instructions, build_development_input
from webwright.server.records import TaskStore, atomic_write_json


def test_compact_steps_preserves_full_snapshots_and_different_outputs() -> None:
    snapshot = "- text: " + "example page content " * 1200
    steps = [{
        "step": index, "code": "print('example')", "output": "example",
        "url": "https://example.com", "title": "Example", "exception": "",
        "screenshot_url": "/unused.png", "execution_step": index,
        "observation": {
            "python_code": "print('example')", "python_output": "example",
            "url": "https://example.com", "title": "Example", "exception": "",
            "screenshot_path": "unused.png", "execution_step": index,
            "aria_snapshot": snapshot, "console_output": "example log",
            "recent_console": "example log", "success": True,
        },
    } for index in (1, 2)]
    steps[1]["observation"]["python_output"] = "distinct evidence"
    original = copy.deepcopy(steps)
    compact = _compact_steps(steps)
    assert steps == original
    assert list(compact["snapshots"].values()) == [snapshot]
    assert list(compact["console_logs"].values()) == ["example log"]
    for item in compact["steps"]:
        observation = item["observation"]
        assert compact["snapshots"][observation["aria_snapshot_ref"]] == snapshot
        assert observation["console_output_ref"] == observation["recent_console_ref"]
        assert "python_code" not in observation
        assert "screenshot_path" not in observation
        assert "screenshot_url" not in item
    assert "python_output" not in compact["steps"][0]["observation"]
    assert compact["steps"][1]["observation"]["execution_output"] == "distinct evidence"
    assert len(json.dumps(compact)) < len(json.dumps(steps)) * 0.6


def test_development_input_uses_user_turns_and_corrected_execution_evidence(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    root = store.task_dir("exp_example")
    record = store.create_task_record(
        task_id="exp_example", title="Explore", instruction="Read the example page",
        start_url="https://example.com", output_dir=root, run_id="run_example",
        activity_type="exploration", toolkit_id="example", tool_id="read_page",
    )
    store.update_task(record["task_id"], status="succeeded")
    store.append_user_turn("exp_example", content="Open the drawer first", after_step=2)
    store.append_user_turn("exp_example", content="Keep the current filter", after_step=2)
    for index, model_turn in ((1, 1), (2, 2), (3, 4)):
        code = f"print({index})"
        path = root / "steps" / f"step_{index:04d}.py"
        path.parent.mkdir(exist_ok=True)
        path.write_text(code, encoding="utf-8")
        atomic_write_json(root / "debug" / "steps" / f"step_{model_turn:04d}.json", {
            "python_code": code,
            "outputs": [{"returncode": 0, "output": str(index), "observation": {
                "python_code": code, "python_output": str(index),
                "aria_snapshot": "- button: Open drawer", "api_key": "placeholder-key",
            }}],
        })
    atomic_write_json(root / "trajectory.json", {"messages": [
        {"role": "system", "content": "old exploration prompt"},
        {"role": "user", "content": "wrapped task with environment boilerplate"},
        {"role": "user", "content": "unrelated observation", "extra": {"observation": {}}},
    ]})
    base_slot = {"code": "async def read_page(ctx):\n    return {}"}
    toolkit_store = SimpleNamespace(
        get_toolkit=lambda _: {"allowed_domains": ["example.com"]},
        get_tool=lambda *_: {"tool_id": "read_page"},
        read_development_slot=lambda *_: base_slot,
        read_formal_slot=lambda *_: None,
    )
    payload = build_development_input(
        task_store=store, toolkit_store=toolkit_store, debug_store=None,
        toolkit_id="example", tool_id="read_page", instruction="Fix drawer handling",
        source_exploration_id="exp_example",
    )
    source = payload["source_exploration"]
    assert "messages" not in source
    assert source["instruction"] == "Read the example page"
    assert source["followup_instructions"] == [
        {"content": "Open the drawer first", "after_step": 2, "before_step": 4},
        {"content": "Keep the current filter", "after_step": 2, "before_step": 4},
    ]
    assert [step["step"] for step in source["steps"]] == [1, 2, 4]
    assert source["steps"][-1]["code"] == "print(3)"
    assert payload["base_slot"] == base_slot
    assert "old exploration prompt" not in json.dumps(payload)
    assert "placeholder-key" not in json.dumps(payload)


def test_legacy_followups_exclude_observations_and_pending_action(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    root = store.task_dir("exp_example")
    atomic_write_json(root / "trajectory.json", {"messages": [
        {"role": "user", "content": "wrapped initial request"},
        {"role": "assistant", "content": "first action"},
        {"role": "user", "content": "page text", "extra": {"observation": {}}},
        {"role": "assistant", "content": "interrupted action"},
        {"role": "user", "content": "wrapper", "extra": {
            "interrupt_type": "ResumeFollowup", "user_input": "Continue with the drawer",
        }},
        {"role": "assistant", "content": "resumed action"},
        {"role": "user", "extra": {"observation": {}}},
        {"role": "user", "content": "## Follow-up Instruction\nwrapper\n\nKeep filter", "extra": {
            "interrupt_type": "ResumeFollowup",
        }},
    ]})
    turns = _followup_instructions(store, "exp_example", root, [{"step": 1}, {"step": 3}])
    assert turns == [
        {"content": "Continue with the drawer", "after_step": 1, "before_step": 3},
        {"content": "Keep filter", "after_step": 3, "before_step": None},
    ]


def test_compacted_legacy_history_does_not_invent_step_positions(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    root = store.task_dir("exp_example")
    atomic_write_json(root / "trajectory.json", {"info": {"api_calls": 9}, "messages": [
        {"role": "user", "content": "summary", "extra": {"interrupt_type": "HistoryCompactionSummary"}},
        {"role": "user", "extra": {"interrupt_type": "ResumeFollowup", "user_input": "Continue"}},
    ]})
    assert _followup_instructions(store, "exp_example", root, [{"step": 9}]) == [
        {"content": "Continue", "after_step": None, "before_step": None},
    ]


def test_followup_anchor_skips_unmapped_execution_files(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks")
    store.append_user_turn("exp_example", content="Continue", after_step=2)
    steps = [{"step": 3, "model_turn": None}, {"step": 4, "model_turn": 4}]
    assert _followup_instructions(store, "exp_example", store.task_dir("exp_example"), steps) == [
        {"content": "Continue", "after_step": 2, "before_step": 4},
    ]


def test_different_snapshot_text_is_not_summarized_or_trimmed() -> None:
    snapshots = ["- button: Open", "- button: Open\n- text: Drawer", "- button: Open\n"]
    compact = _compact_steps([
        {"step": index, "observation": {"aria_snapshot": text}}
        for index, text in enumerate(snapshots, 1)
    ])
    assert list(compact["snapshots"].values()) == snapshots
    for item, text in zip(compact["steps"], snapshots):
        assert compact["snapshots"][item["observation"]["aria_snapshot_ref"]] == text


def test_step_projection_removes_internal_fields_and_keeps_conflicts() -> None:
    raw = [{
        "step": 4, "model_turn": 4, "execution_step": 3, "code_type": "python_code",
        "thought": "", "code": "print('example')", "output": "example\n",
        "status": "ok", "returncode": 0, "done": False, "final_response": "", "exception": "",
        "observation": {"success": True, "python_code": "print('example')",
                        "python_output": "example\n", "execution_step": 3, "model_turn": 4},
    }, {
        "step": 5, "status": "error", "returncode": 1,
        "exception": "Example failure", "observation": {"success": False, "exception": "Example failure"},
    }, {
        "step": 6, "status": "ok", "observation": {"success": False},
    }, {
        "step": 7, "status": "unknown", "observation": {"success": False},
    }]
    projected = _compact_steps(raw)
    assert projected["steps"][0] == {
        "step": 4, "status": "ok", "code": "print('example')", "execution_output": "example\n",
    }
    assert projected["steps"][1] == {"step": 5, "status": "error", "exception": "Example failure"}
    assert projected["steps"][2] == {
        "step": 6, "status": "ok", "status_conflict": {"observation_success": False},
    }
    assert projected["steps"][3]["observation"]["success"] is False
    assert set(projected) == {"steps"}
    assert _compact_steps([]) == {}


def test_page_changes_roundtrip_known_state_without_dropping_query_parameters() -> None:
    pages = [
        {"url": "https://example.com/tasks?filter=a%2Fb&count=0", "title": "Tasks"},
        {"url": "https://example.com/tasks?filter=a%2Fb&count=0", "title": "Tasks"},
        {"url": "", "title": ""},  # a failed read must not clear known values
        {"url": "https://example.com/tasks?filter=a%2Fb&count=0", "title": "Drawer"},
        {"url": "https://example.com/result?id=example", "title": "Drawer"},
    ]
    compact = _compact_steps([
        {"step": i, "status": "ok", **page, "observation": dict(page)}
        for i, page in enumerate(pages, 1)
    ])
    actual, expected = {}, {}
    for original, step in zip(pages, compact["steps"]):
        expected.update({key: value for key, value in original.items() if value})
        actual.update(step.get("page", {}))
        assert actual == expected
        assert "url" not in step and "title" not in step
        assert "observation" not in step
    assert "page" not in compact["steps"][1]
    assert "page" not in compact["steps"][2]
    assert compact["steps"][3]["page"] == {"title": "Drawer"}
    assert compact["steps"][4]["page"] == {"url": "https://example.com/result?id=example"}


def test_differing_page_evidence_is_not_silently_discarded() -> None:
    compact = _compact_steps([{
        "step": 1, "url": "https://example.com/recorded",
        "observation": {"url": "https://example.com/observed"},
    }])
    assert compact["steps"][0]["page"]["url"] == "https://example.com/recorded"
    assert compact["steps"][0]["observation"]["url"] == "https://example.com/observed"


def test_conclusions_preserve_each_position_across_resumes() -> None:
    raw = [
        {"step": 2, "status": "ok", "final_response": ""},
        {"step": 3, "status": "done", "done": True, "final_response": "First conclusion"},
        {"step": 5, "status": "done", "done": True, "final_response": "Updated conclusion"},
        {"step": 7, "status": "done", "done": True, "final_response": "Updated conclusion"},
    ]
    compact = _compact_steps(raw)
    assert compact["conclusions"] == [
        {"after_step": 3, "text": "First conclusion"},
        {"after_step": 5, "text": "Updated conclusion"},
        {"after_step": 7, "text": "Updated conclusion"},
    ]
    assert all(set(step) == {"step", "status"} for step in compact["steps"])


def test_metadata_projection_preserves_business_values_and_execution_constraints(tmp_path: Path) -> None:
    parameters = {"enabled": False, "limit": 0, "text": "", "optional": None, "items": [], "options": {}}
    schema = {"type": "object", "properties": {
        "enabled": {"type": "boolean", "default": False},
        "text": {"type": "string", "default": ""},
    }}
    base = {"code": "async def read_page(ctx):\n    return {}", "description": "Read page",
            "parameters_schema": schema, "result_schema": {}, "risk_notice": "",
            "requires": ["Signed in"], "ensures": ["Result available"], "side_effects": [],
            "code_hash": "placeholder-hash", "updated_at": "2026-01-01", "source_exploration_id": "example"}
    debug = {"tool_id": "read_page", "channel": "development", "status": "succeeded",
             "parameters": parameters, "result": {"ok": False, "payload": parameters},
             "error": "", "error_code": "example_failure", "debug_run_id": "example_run",
             "runtime_identity": {"version": "example"}, "screenshot_url": "/unused.png",
             "before_page": {"url": "https://example.com", "title": "", "screenshot_path": "unused"},
             "after_page": {"url": "", "title": ""}}
    toolkits = SimpleNamespace(
        get_toolkit=lambda _: {"toolkit_id": "example", "allowed_domains": ["example.com"],
                              "runtime": "example-runtime", "execution": {"requires_page": False}},
        get_tool=lambda *_: {"tool_id": "read_page", "toolkit_id": "example", "name": "read_page",
                            "goal": "Read", "start_url": "https://example.com", "expected_effect": "",
                            "created_at": "2026-01-01", "has_development": True, "auth_source": "browser-session"},
        read_development_slot=lambda *_: base, read_formal_slot=lambda *_: None,
    )
    original = copy.deepcopy((base, debug))
    result = build_development_input(
        task_store=TaskStore(tmp_path / "tasks"), toolkit_store=toolkits,
        debug_store=SimpleNamespace(read=lambda _: debug), toolkit_id="example", tool_id="read_page",
        instruction="Improve", debug_run_evidence_id="example_run",
    )
    assert (base, debug) == original
    assert set(result["base_slot"]) == {"code", "description", "parameters_schema", "result_schema", "risk_notice", "requires", "ensures", "side_effects"}
    assert result["base_slot"]["requires"] == ["Signed in"]
    assert result["base_slot"]["ensures"] == ["Result available"]
    assert result["base_slot"]["side_effects"] == []
    assert result["base_slot"]["parameters_schema"] == schema
    assert result["base_slot"]["result_schema"] == {}
    assert result["base_slot"]["risk_notice"] == ""
    assert result["toolkit"]["execution"] == {"requires_page": False}
    assert result["tool"]["auth_source"] == "browser-session"
    assert "toolkit_id" not in result["toolkit"]
    assert set(result["tool"]) == {"tool_id", "goal", "start_url", "auth_source"}
    evidence = result["debug_run_evidence"]
    assert evidence["parameters"] == parameters
    assert evidence["status"] == "succeeded"
    assert evidence["result"] == {"ok": False, "payload": parameters}
    assert evidence["before_page"] == {"url": "https://example.com"}
    assert "after_page" not in evidence
    assert set(evidence) == {"channel", "parameters", "status", "result", "error_code", "before_page"}
