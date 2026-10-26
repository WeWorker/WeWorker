from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from webwright.server.records import atomic_write_json, make_run_id, now_iso
from webwright.server.status import DebugRunStatus
from webwright.server.toolkit_store import ToolkitStore


class DebugRunStore:
    def __init__(self, toolkit_store: ToolkitStore):
        self.toolkit_store = toolkit_store

    def debug_root(self, tool_id: str, toolkit_id: str | None = None) -> Path:
        if toolkit_id is not None:
            return self.toolkit_store.toolkit_dir(toolkit_id) / "debug_runs"
        tool = self.toolkit_store.find_tool(tool_id)
        return self.toolkit_store.toolkit_dir(str(tool["toolkit_id"])) / "debug_runs"

    def run_dir(self, tool_id: str, debug_run_id: str, toolkit_id: str | None = None) -> Path:
        self._validate_debug_run_id(debug_run_id)
        if toolkit_id is None:
            for path in self.toolkit_store.root.glob(f"*/debug_runs/{debug_run_id}/debug_run.json"):
                return path.parent
        root = self.debug_root(tool_id, toolkit_id).resolve()
        path = (root / debug_run_id).resolve()
        if root not in path.parents:
            raise ValueError(f"Invalid debug_run_id: {debug_run_id}")
        return path

    def create(
        self,
        *,
        tool_id: str,
        channel: str,
        code_hash: str,
        artifact_hash: str = "",
        distribution_hash: str = "",
        runtime_identity: dict[str, str] | None = None,
        toolkit_id: str | None = None,
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        if toolkit_id is None:
            toolkit_id = str(self.toolkit_store.find_tool(tool_id)["toolkit_id"])
        if channel not in {"formal", "development"}:
            raise ValueError("channel must be formal or development.")
        if not str(code_hash or "").startswith("sha256:"):
            raise ValueError("code_hash must use the sha256: prefix.")
        if not isinstance(parameters, dict):
            raise ValueError("parameters must be a JSON object.")
        debug_run_id = make_run_id().replace("run_", "debug_", 1)
        payload = {
            "debug_run_id": debug_run_id,
            "tool_id": tool_id,
            "toolkit_id": toolkit_id,
            "channel": channel,
            "code_hash": code_hash,
            "artifact_hash": str(artifact_hash or "") if channel == "formal" else "",
            "distribution_hash": distribution_hash if channel == "formal" else "",
            "runtime_identity": runtime_identity or {} if channel == "formal" else {},
            "parameters": parameters,
            "status": DebugRunStatus.QUEUED.value,
            "result": {},
            "error": "",
            "before_page": {"url": "", "title": ""},
            "after_page": {"url": "", "title": ""},
            "created_at": now_iso(),
            "started_at": "",
            "finished_at": "",
            "screenshot_url": "",
        }
        atomic_write_json(self.run_dir(tool_id, debug_run_id, toolkit_id) / "debug_run.json", payload)
        return payload

    def read(self, debug_run_id: str) -> dict[str, Any]:
        self._validate_debug_run_id(debug_run_id)
        for path in self.toolkit_store.root.glob(
            f"*/debug_runs/{debug_run_id}/debug_run.json"
        ):
            payload = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                return payload
        raise FileNotFoundError(f"Debug Run not found: {debug_run_id}")

    @staticmethod
    def _validate_debug_run_id(debug_run_id: str) -> None:
        if not debug_run_id.startswith("debug_") or any(
            char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"
            for char in debug_run_id
        ):
            raise ValueError(f"Invalid debug_run_id: {debug_run_id}")

    def list_for_tool(self, tool_id: str, toolkit_id: str | None = None) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for path in self.debug_root(tool_id, toolkit_id).glob("*/debug_run.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict) and payload.get("tool_id") == tool_id:
                items.append(payload)
        return sorted(items, key=lambda item: str(item.get("created_at", "")), reverse=True)

    def has_successful_run(
        self,
        *,
        tool_id: str,
        channel: str,
        code_hash: str | None = None,
        artifact_hash: str | None = None,
        distribution_hash: str | None = None,
        toolkit_id: str | None = None,
    ) -> bool:
        return any(
            item.get("status") == DebugRunStatus.SUCCEEDED.value
            and item.get("channel") == channel
            and (code_hash is None or item.get("code_hash") == code_hash)
            and (artifact_hash is None or item.get("artifact_hash") == artifact_hash)
            and (distribution_hash is None or item.get("distribution_hash") == distribution_hash)
            for item in self.list_for_tool(tool_id, toolkit_id)
        )

    def update(self, debug_run_id: str, **updates: Any) -> dict[str, Any]:
        payload = self.read(debug_run_id)
        if "status" in updates and updates["status"] not in {
            status.value for status in DebugRunStatus
        }:
            raise ValueError(f"Invalid Debug Run status: {updates['status']}")
        payload.update(updates)
        atomic_write_json(
            self.run_dir(str(payload["tool_id"]), debug_run_id) / "debug_run.json",
            payload,
        )
        return payload

    def recover_incomplete(self) -> int:
        recovered = 0
        for path in self.toolkit_store.root.glob("*/debug_runs/*/debug_run.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if payload.get("status") not in {
                DebugRunStatus.QUEUED.value,
                DebugRunStatus.RUNNING.value,
            }:
                continue
            self.update(
                str(payload["debug_run_id"]),
                status=DebugRunStatus.FAILED.value,
                error="Server restarted before Debug Run completed.",
                finished_at=now_iso(),
            )
            recovered += 1
        return recovered
