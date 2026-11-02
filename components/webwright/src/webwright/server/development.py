from __future__ import annotations

from pathlib import Path
from typing import Any

from webwright.server.artifacts import read_steps, try_read_json
from webwright.server.debug_store import DebugRunStore
from webwright.server.records import TaskStore
from webwright.server.toolkit_store import ToolkitStore


_PRIVATE_KEYS = {"target_id", "active_target_id", "cdp_url", "api_key", "environment"}


def sanitize_evidence(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: sanitize_evidence(item)
            for key, item in value.items()
            if key not in _PRIVATE_KEYS and not key.lower().endswith("_api_key")
        }
    if isinstance(value, list):
        return [sanitize_evidence(item) for item in value]
    return value


def _followup_instructions(
    task_store: TaskStore, task_id: str, output_dir: Path, steps: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    turns = task_store.read_user_turns(task_id)
    if not turns:
        # Compatibility for older runs without the dedicated user-turn record.
        # Do not treat observations, system prompts or summaries as user input.
        trajectory = try_read_json(output_dir / "trajectory.json")
        trajectory = trajectory if isinstance(trajectory, dict) else {}
        messages = trajectory.get("messages", [])
        messages = messages if isinstance(messages, list) else []
        messages = [message for message in messages if isinstance(message, dict)]
        info = trajectory.get("info", {})
        info = info if isinstance(info, dict) else {}
        assistant_count = sum(message.get("role") == "assistant" for message in messages)
        positions_known = info.get("api_calls", assistant_count) == assistant_count
        model_turn = 0
        last_completed = 0
        for message in messages:
            extra = message.get("extra", {})
            extra = extra if isinstance(extra, dict) else {}
            if extra.get("interrupt_type") == "HistoryCompactionSummary":
                positions_known = False
            if message.get("role") == "assistant":
                model_turn += 1
            if "observation" in extra:
                last_completed = model_turn
            if message.get("role") == "user" and extra.get("interrupt_type") == "ResumeFollowup":
                content = extra.get("user_input")
                if not content:
                    # Older messages used the same wrapper, without user_input.
                    text = message.get("content", "")
                    if isinstance(text, str) and text.startswith("## Follow-up Instruction\n"):
                        content = text.partition("\n\n")[2]
                if isinstance(content, str) and content:
                    turns.append({
                        "content": content,
                        "after_step": last_completed if positions_known else None,
                    })
    indices = sorted(
        step["step"] for step in steps
        if step.get("model_turn", step["step"]) is not None
    )
    result = []
    for turn in turns:
        after = turn.get("after_step")
        after = after if type(after) is int and after >= 0 else None
        result.append({
            "content": turn.get("content", ""),
            "after_step": after,
            "before_step": next((index for index in indices if index > after), None)
            if after is not None else None,
        })
    return result


def _select_fields(value: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    # Project metadata only. Never recursively prune business values or schemas.
    return {key: value[key] for key in fields if key in value}


def _compact_debug_evidence(run: dict[str, Any]) -> dict[str, Any]:
    result = _select_fields(run, ("channel", "parameters", "status", "result"))
    for key in ("error", "error_code", "error_stage"):
        if run.get(key):
            result[key] = run[key]
    for key in ("before_page", "after_page"):
        page = run.get(key)
        if isinstance(page, dict):
            known = {name: page[name] for name in ("url", "title") if page.get(name)}
            if known:
                result[key] = known
    return result


def _compact_steps(steps: list[dict[str, Any]]) -> dict[str, Any]:
    """Project model evidence without truncating code, snapshots or output."""
    snapshots: dict[str, str] = {}
    console_logs: dict[str, str] = {}
    snapshot_ids: dict[str, str] = {}
    console_ids: dict[str, str] = {}
    last_page: dict[str, str] = {}
    compact = []
    conclusions = []
    for step in steps:
        item = {"step": step["step"], "status": step.get("status", "unknown")}
        for key in ("thought", "code", "exception"):
            if step.get(key):
                item[key] = step[key]
        if step.get("output"):
            item["execution_output"] = step["output"]
        if step.get("final_response"):
            conclusions.append({"after_step": step["step"], "text": step["final_response"]})
        observation = dict(step.get("observation") or {})
        # Drop only fields proven equal; preserve differing evidence under clear names.
        for source, target in (
            ("python_code", "code"), ("python_output", "output"), ("exception", "exception"),
        ):
            if source in observation and observation[source] == step.get(target):
                observation.pop(source)
        if "python_output" in observation:
            observation["execution_output"] = observation.pop("python_output")
        if "python_code" in observation:
            observation["executed_code"] = observation.pop("python_code")
        for key in ("execution_step", "model_turn", "screenshot_path"):
            observation.pop(key, None)

        expected_success = {"ok": True, "error": False}.get(item["status"])
        if type(observation.get("success")) is bool and expected_success is not None:
            success = observation.pop("success")
            if success != expected_success:
                item["status_conflict"] = {"observation_success": success}

        # Missing/empty reads do not erase the last known page state. Keep a
        # differing observation value if legacy evidence disagrees with the step.
        page_change = {}
        for key in ("url", "title"):
            value = step.get(key) or observation.get(key)
            if isinstance(value, str) and value:
                if observation.get(key) == value:
                    observation.pop(key)
                if last_page.get(key) != value:
                    page_change[key] = value
                    last_page[key] = value
        if page_change:
            item["page"] = page_change

        for field, pool, ids, prefix in (
            ("aria_snapshot", snapshots, snapshot_ids, "snapshot"),
            ("console_output", console_logs, console_ids, "console"),
            ("recent_console", console_logs, console_ids, "console"),
        ):
            text = observation.get(field)
            if not isinstance(text, str):
                continue
            observation.pop(field)
            if text:
                if text not in ids:
                    ref = f"{prefix}_{len(pool) + 1}"
                    ids[text] = ref
                    pool[ref] = text
                observation[f"{field}_ref"] = ids[text]
        # Only observation envelope fields are pruned, not nested data payloads.
        observation = {
            key: value for key, value in observation.items()
            if value is not None and value != "" and value != {} and value != []
        }
        if observation:
            item["observation"] = observation
        compact.append(item)
    return {
        key: value for key, value in {
            "steps": compact, "snapshots": snapshots,
            "console_logs": console_logs, "conclusions": conclusions,
        }.items() if value
    }


def build_development_input(
    *,
    task_store: TaskStore,
    toolkit_store: ToolkitStore,
    debug_store: DebugRunStore,
    toolkit_id: str,
    tool_id: str,
    instruction: str,
    source_exploration_id: str = "",
    debug_run_evidence_id: str = "",
    exploration_only: bool = False,
) -> dict[str, Any]:
    toolkit = toolkit_store.get_toolkit(toolkit_id)
    tool = toolkit_store.get_tool(toolkit_id, tool_id)
    if exploration_only and not source_exploration_id:
        raise ValueError("Exploration-only development requires a source Exploration.")
    development = (
        None
        if exploration_only
        else toolkit_store.read_development_slot(toolkit_id, tool_id)
    )
    formal = (
        None
        if exploration_only
        else toolkit_store.read_formal_slot(toolkit_id, tool_id)
    )
    exploration: dict[str, Any] | None = None
    if source_exploration_id:
        record = task_store.read_exploration(source_exploration_id)
        if record.get("toolkit_id") != toolkit_id or record.get("tool_id") != tool_id:
            raise ValueError("Exploration does not belong to this Tool.")
        if record.get("status") != "succeeded":
            raise ValueError("Source Exploration must be succeeded.")
        output_dir = task_store.task_dir(source_exploration_id)
        steps = read_steps(source_exploration_id, output_dir)
        exploration = {
            "instruction": record.get("instruction", ""),
            **_compact_steps(steps),
        }
        followups = _followup_instructions(task_store, source_exploration_id, output_dir, steps)
        if followups:
            exploration["followup_instructions"] = followups
    debug_evidence: dict[str, Any] | None = None
    if debug_run_evidence_id and not exploration_only:
        run = debug_store.read(debug_run_evidence_id)
        if run.get("tool_id") != tool_id:
            raise ValueError("Debug Run does not belong to this Tool.")
        debug_evidence = _compact_debug_evidence(run)
    base_slot = None if exploration_only else development or formal
    return sanitize_evidence(
        {
            "toolkit": _select_fields(toolkit, ("allowed_domains", "runtime", "execution", "auth_source")),
            "tool": {
                key: value for key, value in _select_fields(tool, (
                    "tool_id", "goal", "start_url", "expected_effect", "runtime", "execution", "auth_source",
                )).items() if value is not None and value != ""
            },
            "base_slot": _select_fields(base_slot, (
                "code", "description", "parameters_schema", "result_schema",
                "requires", "ensures", "side_effects", "risk_notice",
            )) if base_slot is not None else None,
            "source_exploration": exploration,
            "debug_run_evidence": debug_evidence,
            "instruction": instruction,
        }
    )
