from __future__ import annotations

from typing import Any

from webwright.server.artifacts import read_messages, read_steps
from webwright.server.debug_store import DebugRunStore
from webwright.server.records import TaskStore
from webwright.server.toolkit_store import ToolkitStore
from webwright.utils.local_cdp import page_in_allowed_domains


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


def validate_exploration_source(record: dict[str, Any], toolkit: dict[str, Any], tool_id: str) -> None:
    if record.get("toolkit_id") or record.get("tool_id"):
        if record.get("toolkit_id") != toolkit["toolkit_id"] or record.get("tool_id") != tool_id:
            raise ValueError("Exploration does not belong to this Tool.")
    elif not page_in_allowed_domains(str(record.get("start_url") or ""), toolkit["allowed_domains"]):
        raise ValueError("Exploration URL must be within Adapter allowed domains.")
    if record.get("status") != "succeeded":
        raise ValueError("Source Exploration must be succeeded.")


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
        validate_exploration_source(record, toolkit, tool_id)
        output_dir = task_store.task_dir(source_exploration_id)
        exploration = {
            "exploration_id": source_exploration_id,
            "instruction": record.get("instruction", ""),
            "steps": read_steps(source_exploration_id, output_dir),
            "messages": read_messages(output_dir),
        }
    debug_evidence: dict[str, Any] | None = None
    if debug_run_evidence_id and not exploration_only:
        run = debug_store.read(debug_run_evidence_id)
        if run.get("toolkit_id") != toolkit_id or run.get("tool_id") != tool_id:
            raise ValueError("Debug Run does not belong to this Tool.")
        debug_evidence = run
    return sanitize_evidence(
        {
            "toolkit": {
                "toolkit_id": toolkit_id,
                "allowed_domains": toolkit["allowed_domains"],
            },
            "tool": tool,
            "base_slot": None if exploration_only else development or formal,
            "source_exploration": exploration,
            "debug_run_evidence": debug_evidence,
            "instruction": instruction,
        }
    )
