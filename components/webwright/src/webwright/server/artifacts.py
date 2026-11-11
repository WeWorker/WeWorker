from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from webwright.server.status import AgentExitStatus, StepStatus
from webwright.utils.intervention import validate_user_intervention


class ArtifactReadError(RuntimeError):
    pass


def read_json_with_retries(path: Path, *, attempts: int = 3, delay_seconds: float = 0.05) -> Any:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(delay_seconds)
    raise ArtifactReadError(f"Could not read JSON artifact {path}: {last_error}") from last_error


def try_read_json(path: Path, *, attempts: int = 3, delay_seconds: float = 0.05) -> Any | None:
    try:
        return read_json_with_retries(path, attempts=attempts, delay_seconds=delay_seconds)
    except (ArtifactReadError, FileNotFoundError):
        return None


def environment_runtime_state(output_dir: Path) -> dict[str, Any]:
    trajectory = try_read_json(output_dir / "trajectory.json")
    if not isinstance(trajectory, dict):
        return {}
    environment = trajectory.get("environment")
    if not isinstance(environment, dict):
        return {}
    runtime_state = environment.get("runtime_state")
    return runtime_state if isinstance(runtime_state, dict) else {}


def _step_number(path: Path) -> int | None:
    stem = path.stem
    if not stem.startswith("step_"):
        return None
    try:
        return int(stem.removeprefix("step_"))
    except ValueError:
        return None


def _screenshot_url(task_id: str, output_dir: Path, step: int) -> str:
    screenshot = output_dir / "screenshots" / f"step_{step:04d}.png"
    if not screenshot.is_file():
        return ""
    return f"/api/tasks/{task_id}/files/screenshots/step_{step:04d}.png"


def _read_step_code(output_dir: Path, step: int) -> str:
    path = output_dir / "steps" / f"step_{step:04d}.py"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _step_from_debug(task_id: str, output_dir: Path, step: int, payload: dict[str, Any]) -> dict[str, Any]:
    outputs = payload.get("outputs")
    first_output = outputs[0] if isinstance(outputs, list) and outputs else {}
    observation = first_output.get("observation", {}) if isinstance(first_output, dict) else {}
    if not isinstance(observation, dict):
        observation = {}
    code = _read_step_code(output_dir, step) or str(payload.get("python_code") or "")
    returncode = first_output.get("returncode") if isinstance(first_output, dict) else None
    exception = ""
    if isinstance(first_output, dict):
        exception = str(first_output.get("exception_info") or "")
    exception = exception or str(observation.get("exception") or "")
    status = StepStatus.OK.value
    if returncode not in (None, 0):
        status = StepStatus.ERROR.value
    if payload.get("done"):
        status = StepStatus.DONE.value
    return {
        "step": step,
        "thought": payload.get("thought", ""),
        "code_type": "python_code",
        "code": code,
        "status": status,
        "done": bool(payload.get("done", False)),
        "final_response": payload.get("final_response", ""),
        "user_intervention": payload.get("user_intervention"),
        "url": observation.get("url", ""),
        "title": observation.get("title", ""),
        "output": first_output.get("output", "") if isinstance(first_output, dict) else "",
        "returncode": returncode,
        "exception": exception,
        "observation": observation,
        "screenshot_url": _screenshot_url(task_id, output_dir, step),
    }


def read_steps(task_id: str, output_dir: Path) -> list[dict[str, Any]]:
    debug_steps = output_dir / "debug" / "steps"
    step_numbers: set[int] = set()
    if debug_steps.is_dir():
        for path in debug_steps.glob("step_*.json"):
            step = _step_number(path)
            if step is not None:
                step_numbers.add(step)
    steps_dir = output_dir / "steps"
    if steps_dir.is_dir():
        for path in steps_dir.glob("step_*.py"):
            step = _step_number(path)
            if step is not None:
                step_numbers.add(step)

    steps: list[dict[str, Any]] = []
    for step in sorted(step_numbers):
        debug_path = debug_steps / f"step_{step:04d}.json"
        payload = try_read_json(debug_path) if debug_path.is_file() else None
        if isinstance(payload, dict):
            steps.append(_step_from_debug(task_id, output_dir, step, payload))
            continue
        steps.append(
            {
                "step": step,
                "thought": "",
                "code_type": "python_code",
                "code": _read_step_code(output_dir, step),
                "status": StepStatus.UNKNOWN.value,
                "done": False,
                "final_response": "",
                "url": "",
                "title": "",
                "output": "",
                "returncode": None,
                "exception": "",
                "observation": {},
                "screenshot_url": _screenshot_url(task_id, output_dir, step),
            }
        )
    return steps


def read_script(output_dir: Path) -> str:
    try:
        return (output_dir / "script.py").read_text(encoding="utf-8")
    except OSError:
        return ""


def _truncate_text(value: str, *, limit: int = 8000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n...<truncated>"


def _safe_content(content: Any) -> Any:
    if isinstance(content, str):
        return _truncate_text(content)
    if not isinstance(content, list):
        return content
    safe_parts: list[Any] = []
    for part in content:
        if not isinstance(part, dict):
            safe_parts.append(part)
            continue
        if part.get("type") == "input_image":
            cloned = dict(part)
            cloned["image_url"] = "<omitted:data-url>"
            safe_parts.append(cloned)
            continue
        cloned = dict(part)
        if isinstance(cloned.get("text"), str):
            cloned["text"] = _truncate_text(cloned["text"])
        safe_parts.append(cloned)
    return safe_parts


def read_messages(output_dir: Path) -> list[dict[str, Any]]:
    trajectory = try_read_json(output_dir / "trajectory.json")
    if not isinstance(trajectory, dict):
        return []
    messages = trajectory.get("messages")
    if not isinstance(messages, list):
        return []
    safe_messages: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        extra = message.get("extra") if isinstance(message.get("extra"), dict) else {}
        safe_messages.append(
            {
                "role": message.get("role", ""),
                "content": _safe_content(message.get("content", "")),
                "kind": extra.get("interrupt_type", ""),
                "has_observation": "observation" in extra,
                "timestamp": extra.get("timestamp", ""),
                "user_input": extra.get("user_input", ""),
            }
        )
    return safe_messages


def task_artifact_summary(task_id: str, output_dir: Path) -> dict[str, Any]:
    steps = read_steps(task_id, output_dir)
    if not steps:
        return {
            "current_step": 0,
            "last_url": "",
            "last_title": "",
            "last_screenshot_url": "",
            "final_response": "",
        }
    last_step = steps[-1]
    final_response = ""
    for step in reversed(steps):
        if step.get("final_response"):
            final_response = str(step.get("final_response") or "")
            break
    return {
        "current_step": int(last_step.get("step") or 0),
        "last_url": last_step.get("url", ""),
        "last_title": last_step.get("title", ""),
        "last_screenshot_url": last_step.get("screenshot_url", ""),
        "final_response": final_response,
    }


def exit_status(output_dir: Path) -> tuple[str, str]:
    trajectory = try_read_json(output_dir / "trajectory.json")
    if not isinstance(trajectory, dict):
        return "", ""
    messages = trajectory.get("messages")
    if not isinstance(messages, list):
        return "", ""
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "exit":
            continue
        extra = message.get("extra")
        if not isinstance(extra, dict):
            return "", ""
        return str(extra.get("exit_status", "") or ""), str(
            extra.get("final_response") or extra.get("submission") or ""
        )
    return "", ""


def waiting_intervention(output_dir: Path) -> dict[str, str] | None:
    trajectory = try_read_json(output_dir / "trajectory.json")
    messages = trajectory.get("messages", []) if isinstance(trajectory, dict) else []
    if not isinstance(messages, list) or not messages or not isinstance(messages[-1], dict):
        return None
    last = messages[-1]
    extra = last.get("extra", {})
    if not isinstance(extra, dict) or last.get("role") != "exit" or extra.get("exit_status") != AgentExitStatus.PAUSED.value:
        return None
    try:
        return validate_user_intervention(extra.get("user_intervention"))
    except ValueError:
        return None


def resolve_task_file(output_dir: Path, relative_path: str) -> Path:
    requested = Path(relative_path)
    if requested.is_absolute() or ".." in requested.parts:
        raise ValueError("Invalid file path.")
    resolved = (output_dir / requested).resolve()
    output_root = output_dir.resolve()
    if resolved != output_root and output_root not in resolved.parents:
        raise ValueError("Invalid file path.")
    if not resolved.is_file():
        raise FileNotFoundError(relative_path)
    return resolved
