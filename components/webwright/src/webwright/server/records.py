from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from webwright.server.status import TaskStatus, TERMINAL_REPLAY_STATUSES, TERMINAL_TASK_STATUSES


_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def timestamp_compact() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def sanitize_id(value: str | None, *, default: str) -> str:
    sanitized = _SAFE_ID_RE.sub("_", (value or "").strip()).strip("._-")
    return sanitized or default


def make_run_id() -> str:
    return f"run_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"


def atomic_write_json(
    path: Path,
    payload: dict[str, Any],
    *,
    max_retries: int = 30,
    retry_delay: float = 0.02,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}_{time.time_ns()}.tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    last_error: Exception | None = None
    try:
        for attempt in range(max_retries):
            try:
                tmp_path.replace(path)
                return
            except OSError as exc:
                last_error = exc
                if attempt + 1 < max_retries:
                    time.sleep(retry_delay)
        if last_error:
            raise last_error
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


class TaskStore:
    def __init__(self, root: Path | str):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._user_turns_lock = threading.RLock()

    def task_dir(self, task_id: str) -> Path:
        task_dir = (self.root / task_id).resolve()
        if self.root not in task_dir.parents and task_dir != self.root:
            raise ValueError(f"Invalid task id: {task_id}")
        return task_dir

    def replay_dir(self, task_id: str, replay_id: str) -> Path:
        replay_dir = (self.server_dir(task_id) / "replays" / replay_id).resolve()
        server_replay_root = (self.server_dir(task_id) / "replays").resolve()
        if server_replay_root not in replay_dir.parents and replay_dir != server_replay_root:
            raise ValueError(f"Invalid replay id: {replay_id}")
        return replay_dir

    def server_dir(self, task_id: str) -> Path:
        return self.task_dir(task_id) / ".server"

    def task_path(self, task_id: str) -> Path:
        return self.server_dir(task_id) / "task.json"

    def spec_path(self, task_id: str) -> Path:
        return self.server_dir(task_id) / "spec.json"

    def control_path(self, task_id: str) -> Path:
        return self.server_dir(task_id) / "control.json"

    def checkpoint_path(self, task_id: str) -> Path:
        return self.server_dir(task_id) / "checkpoint.json"

    def user_turns_path(self, task_id: str) -> Path:
        return self.server_dir(task_id) / "user_turns.json"

    def process_log_path(self, task_id: str) -> Path:
        return self.server_dir(task_id) / "process.log"

    def new_task_id(self, requested: str | None, *, title: str | None = None) -> str:
        base = sanitize_id(requested or title, default="task")
        candidate = f"{base}_{timestamp_compact()}"
        task_dir = self.task_dir(candidate)
        suffix = 1
        while task_dir.exists():
            candidate = f"{base}_{timestamp_compact()}_{suffix}"
            task_dir = self.task_dir(candidate)
            suffix += 1
        return candidate

    def read_task(self, task_id: str) -> dict[str, Any]:
        path = self.task_path(task_id)
        if not path.is_file():
            raise FileNotFoundError(f"Task not found: {task_id}")
        return json.loads(path.read_text(encoding="utf-8"))

    def write_task(self, task: dict[str, Any]) -> dict[str, Any]:
        task_id = str(task["task_id"])
        payload = dict(task)
        payload["updated_at"] = now_iso()
        atomic_write_json(self.task_path(task_id), payload)
        return payload

    def update_task(self, task_id: str, **updates: Any) -> dict[str, Any]:
        task = self.read_task(task_id)
        task.update(updates)
        return self.write_task(task)

    def list_tasks(self, *, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        tasks: list[dict[str, Any]] = []
        for task_path in self.root.glob("*/.server/task.json"):
            try:
                task = json.loads(task_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if status and task.get("status") != status:
                continue
            tasks.append(task)
        tasks.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
        return tasks[:limit]

    def list_explorations(
        self,
        *,
        toolkit_id: str,
        tool_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return [
            task
            for task in self.list_tasks(limit=max(limit, 1_000))
            if task.get("activity_type") == "exploration"
            and task.get("toolkit_id") == toolkit_id
            and task.get("tool_id") == tool_id
        ][:limit]

    def read_exploration(self, exploration_id: str) -> dict[str, Any]:
        task = self.read_task(exploration_id)
        if task.get("activity_type") != "exploration":
            raise FileNotFoundError(f"Exploration not found: {exploration_id}")
        return task

    def create_task_record(
        self,
        *,
        task_id: str,
        title: str,
        instruction: str,
        start_url: str,
        output_dir: Path,
        run_id: str,
        active_target_id: str = "",
        activity_type: str = "task",
        toolkit_id: str = "",
        tool_id: str = "",
        initial_supplement: str = "",
    ) -> dict[str, Any]:
        created_at = now_iso()
        task = {
            "task_id": task_id,
            "title": title,
            "instruction": instruction,
            "start_url": start_url,
            "status": TaskStatus.QUEUED.value,
            "output_dir": str(output_dir.resolve()),
            "created_at": created_at,
            "updated_at": created_at,
            "current_step": 0,
            "final_response": "",
            "error": "",
            "error_code": "",
            "error_stage": "",
            "last_run_id": run_id,
            "last_child_pid": None,
            "active_target_id": active_target_id,
            "activity_type": activity_type,
            "toolkit_id": toolkit_id,
            "tool_id": tool_id,
            "initial_supplement": str(initial_supplement or "").strip(),
        }
        return self.write_task(task)

    def read_user_turns(self, task_id: str) -> list[dict[str, Any]]:
        path = self.user_turns_path(task_id)
        if not path.is_file():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        turns = payload.get("turns") if isinstance(payload, dict) else None
        return list(turns) if isinstance(turns, list) else []

    def append_user_turn(
        self,
        task_id: str,
        *,
        content: str,
        after_step: int,
    ) -> dict[str, Any]:
        normalized = str(content or "").strip()
        if not normalized:
            raise ValueError("User turn content is required.")
        with self._user_turns_lock:
            turns = self.read_user_turns(task_id)
            turn = {
                "turn_id": f"turn_{timestamp_compact()}_{len(turns) + 1}",
                "type": "followup",
                "content": normalized,
                "after_step": max(int(after_step), 0),
                "created_at": now_iso(),
            }
            turns.append(turn)
            atomic_write_json(self.user_turns_path(task_id), {"turns": turns})
            return turn

    def is_terminal(self, task: dict[str, Any]) -> bool:
        return str(task.get("status", "")) in TERMINAL_TASK_STATUSES

    def write_replay(self, replay: dict[str, Any]) -> dict[str, Any]:
        replay_id = str(replay["replay_id"])
        task_id = str(replay["task_id"])
        payload = dict(replay)
        payload["updated_at"] = now_iso()
        atomic_write_json(self.replay_dir(task_id, replay_id) / "replay.json", payload)
        return payload

    def read_replay(self, replay_id: str) -> dict[str, Any]:
        for path in self.root.glob(f"*/.server/replays/{replay_id}/replay.json"):
            return json.loads(path.read_text(encoding="utf-8"))
        raise FileNotFoundError(f"Replay not found: {replay_id}")

    def update_replay(self, replay_id: str, **updates: Any) -> dict[str, Any]:
        replay = self.read_replay(replay_id)
        replay.update(updates)
        return self.write_replay(replay)

    def is_replay_terminal(self, replay: dict[str, Any]) -> bool:
        return str(replay.get("status", "")) in TERMINAL_REPLAY_STATUSES
