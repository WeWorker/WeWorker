from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def resolve_trajectory_path(path: str | Path) -> Path:
    resolved = Path(path).expanduser().resolve()
    if resolved.is_dir():
        resolved = resolved / "trajectory.json"
    return resolved


def load_trajectory(path: str | Path) -> dict[str, Any]:
    resolved = resolve_trajectory_path(path)
    if not resolved.is_file():
        raise FileNotFoundError(f"Trajectory file not found: {resolved}")
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Could not parse trajectory JSON: {resolved}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"Trajectory payload must be a JSON object: {resolved}")
    return data


def build_resume_state(trajectory: dict[str, Any]) -> dict[str, Any]:
    messages = trajectory.get("messages")
    if not isinstance(messages, list):
        raise ValueError("Trajectory is missing a valid messages list.")

    info = trajectory.get("info")
    if not isinstance(info, dict):
        info = {}

    config = info.get("config")
    if not isinstance(config, dict):
        config = {}

    environment = trajectory.get("environment")
    if not isinstance(environment, dict):
        environment = {}
    environment_config = environment.get("config")
    if not isinstance(environment_config, dict):
        environment_config = {}
    runtime_state = environment.get("runtime_state")
    if not isinstance(runtime_state, dict):
        runtime_state = {}

    return {
        "messages": messages,
        "n_calls": int(info.get("api_calls", 0) or 0),
        "n_format_errors": int(info.get("format_errors", 0) or 0),
        "n_consecutive_format_errors": int(info.get("consecutive_format_errors", 0) or 0),
        "task": _infer_task_from_messages(messages),
        "agent_config": config.get("agent", {}) if isinstance(config.get("agent", {}), dict) else {},
        "environment_config": {
            "browser_mode": str(environment_config.get("browser_mode", "") or ""),
            "start_url": str(environment_config.get("start_url", "") or ""),
            "local_cdp_url": str(environment_config.get("local_cdp_url", "") or ""),
        },
        "environment_runtime_state": {
            "browser_instance_id": str(runtime_state.get("browser_instance_id", "") or ""),
            "target_id": str(runtime_state.get("target_id", "") or ""),
            "last_url": str(runtime_state.get("last_url", "") or ""),
            "last_title": str(runtime_state.get("last_title", "") or ""),
            "page_selection_source": str(runtime_state.get("page_selection_source", "") or ""),
        },
    }


def _infer_task_from_messages(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") != "user":
            continue
        content = message.get("content", "")
        if isinstance(content, str) and content.startswith("Task: "):
            return content.splitlines()[0].removeprefix("Task: ").strip()
    return ""
