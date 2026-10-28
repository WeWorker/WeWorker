from __future__ import annotations

import hashlib
import ast
import base64
import json
import re
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from webwright.server.records import atomic_write_json, now_iso


_SLUG_RE = re.compile(r"^[a-z][a-z0-9_]*$")


class DevelopmentSlotConflictError(RuntimeError):
    pass


def _validate_slug(value: str, *, field: str) -> str:
    normalized = str(value or "").strip()
    if not _SLUG_RE.fullmatch(normalized):
        raise ValueError(
            f"{field} must start with a lowercase letter and contain only lowercase letters, digits, and underscores."
        )
    return normalized


def _normalize_domains(values: list[str] | tuple[str, ...] | str) -> list[str]:
    raw_values = re.split(r"[,，\s]+", values) if isinstance(values, str) else values
    domains: list[str] = []
    for value in raw_values:
        domain = str(value or "").strip().lower().rstrip(".")
        if not domain:
            continue
        parsed = urlsplit(f"//{domain}")
        if (
            parsed.hostname != domain
            or parsed.username
            or parsed.password
            or parsed.port is not None
            or any(char in domain for char in "/?#")
        ):
            raise ValueError(f"Invalid allowed domain: {value}")
        domains.append(domain)
    domains = list(dict.fromkeys(domains))
    if not domains:
        raise ValueError("allowed_domains must contain at least one domain.")
    return domains


def _start_url_hostname(start_url: str) -> str:
    parsed = urlsplit(str(start_url or "").strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("start_url must be an absolute http or https URL.")
    if parsed.username or parsed.password:
        raise ValueError("start_url must not contain credentials.")
    return parsed.hostname.lower().rstrip(".")


def code_hash(code: str) -> str:
    return f"sha256:{hashlib.sha256(code.encode('utf-8')).hexdigest()}"


def validate_tool_slot(tool_id: str, slot: dict[str, Any]) -> dict[str, Any]:
    tool_id = _validate_slug(tool_id, field="tool_id")
    if not isinstance(slot, dict):
        raise ValueError("Tool slot must be a JSON object.")
    code = str(slot.get("code") or "")
    if not code.strip():
        raise ValueError("Tool slot code is required.")
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise ValueError(f"Tool code has invalid Python syntax: {exc.msg}") from exc
    if (
        len(tree.body) != 1
        or not isinstance(tree.body[0], ast.AsyncFunctionDef)
        or tree.body[0].name != tool_id
    ):
        raise ValueError(
            f"Tool code must define a single top-level async function named {tool_id}."
        )
    function = tree.body[0]
    if function.decorator_list:
        raise ValueError("Tool function must not use decorators.")
    if function.args.posonlyargs or function.args.vararg or function.args.kwarg:
        raise ValueError(
            "Tool function must not use positional-only, *args, or **kwargs parameters."
        )
    positional = [*function.args.posonlyargs, *function.args.args]
    if not positional or positional[0].arg != "ctx":
        raise ValueError("Tool function first parameter must be ctx.")
    forbidden = {"target_id", "cdp_url"}
    exposed = {arg.arg for arg in positional[1:]} | {
        arg.arg for arg in function.args.kwonlyargs
    }
    if exposed & forbidden:
        raise ValueError("Tool business parameters must not expose target_id or cdp_url.")
    for field in ("parameters_schema", "result_schema"):
        if not isinstance(slot.get(field), dict):
            raise ValueError(f"{field} must be a JSON object.")
    parameters_schema = slot["parameters_schema"]
    if parameters_schema.get("type") != "object" or not isinstance(
        parameters_schema.get("properties"), dict
    ):
        raise ValueError("parameters_schema must define an object with properties.")
    required = parameters_schema.get("required", [])
    if not isinstance(required, list) or any(
        not isinstance(name, str) for name in required
    ):
        raise ValueError("parameters_schema.required must be a list of strings.")
    schema_properties = set(parameters_schema["properties"])
    business_parameters = {arg.arg for arg in positional[1:]} | {
        arg.arg for arg in function.args.kwonlyargs
    }
    if schema_properties != business_parameters:
        raise ValueError(
            "parameters_schema properties must match function business parameters."
        )
    positional_defaults = {
        arg.arg for arg in positional[len(positional) - len(function.args.defaults) :]
    }
    keyword_defaults = {
        arg.arg
        for arg, default in zip(function.args.kwonlyargs, function.args.kw_defaults)
        if default is not None
    }
    function_required = business_parameters - positional_defaults - keyword_defaults
    if set(required) != function_required:
        raise ValueError(
            "parameters_schema required fields must match parameters without defaults."
        )
    if schema_properties & forbidden:
        raise ValueError("Tool parameter schema must not expose target_id or cdp_url.")
    return {
        "code": code,
        "description": str(slot.get("description") or ""),
        "parameters_schema": slot["parameters_schema"],
        "result_schema": slot["result_schema"],
        "risk_notice": str(slot.get("risk_notice") or ""),
    }


class ToolkitStore:
    def __init__(self, root: Path | str):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._slot_lock = threading.RLock()

    def toolkit_dir(self, toolkit_id: str) -> Path:
        toolkit_id = _validate_slug(toolkit_id, field="toolkit_id")
        path = (self.root / toolkit_id).resolve()
        if self.root not in path.parents:
            raise ValueError(f"Invalid toolkit_id: {toolkit_id}")
        return path

    def metadata_path(self, toolkit_id: str) -> Path:
        return self.toolkit_dir(toolkit_id) / ".server" / "toolkit.json"

    def runtime_path(self, toolkit_id: str) -> Path:
        return self.toolkit_dir(toolkit_id) / "runtime.json"

    def tool_dir(self, toolkit_id: str, tool_id: str) -> Path:
        tool_id = _validate_slug(tool_id, field="tool_id")
        root = (self.toolkit_dir(toolkit_id) / "tools").resolve()
        path = (root / tool_id).resolve()
        if root not in path.parents:
            raise ValueError(f"Invalid tool_id: {tool_id}")
        return path

    def tool_path(self, toolkit_id: str, tool_id: str) -> Path:
        return self.tool_dir(toolkit_id, tool_id) / "tool.json"

    def formal_path(self, toolkit_id: str, tool_id: str) -> Path:
        return self.tool_dir(toolkit_id, tool_id) / "formal.json"

    def development_path(self, toolkit_id: str, tool_id: str) -> Path:
        return self.toolkit_dir(toolkit_id) / "development" / tool_id / "current.json"

    def list_toolkits(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for path in self.root.glob("*/.server/toolkit.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                items.append(payload)
        return sorted(items, key=lambda item: str(item.get("created_at", "")))

    def create_toolkit(
        self,
        *,
        name: str,
        description: str = "",
        allowed_domains: list[str] | tuple[str, ...] | str,
    ) -> dict[str, Any]:
        toolkit_id = _validate_slug(name, field="name")
        path = self.metadata_path(toolkit_id)
        if path.exists():
            raise ValueError(f"Toolkit already exists: {toolkit_id}")
        created_at = now_iso()
        payload = {
            "toolkit_id": toolkit_id,
            "name": toolkit_id,
            "description": str(description or "").strip(),
            "allowed_domains": _normalize_domains(allowed_domains),
            "created_at": created_at,
            "updated_at": created_at,
        }
        atomic_write_json(path, payload)
        self.write_runtime(toolkit_id, target_id="", last_url="", last_title="")
        return payload

    def get_toolkit(self, toolkit_id: str) -> dict[str, Any]:
        path = self.metadata_path(toolkit_id)
        if not path.is_file():
            raise FileNotFoundError(f"Toolkit not found: {toolkit_id}")
        return json.loads(path.read_text(encoding="utf-8"))

    def update_toolkit(
        self,
        toolkit_id: str,
        *,
        description: str | None = None,
        allowed_domains: list[str] | tuple[str, ...] | str | None = None,
    ) -> dict[str, Any]:
        payload = self.get_toolkit(toolkit_id)
        if description is not None:
            payload["description"] = str(description).strip()
        if allowed_domains is not None:
            domains = _normalize_domains(allowed_domains)
            for tool in self.list_tools(toolkit_id):
                if _start_url_hostname(str(tool.get("start_url") or "")) not in domains:
                    raise ValueError(
                        f"allowed_domains would exclude Tool start_url: {tool['tool_id']}"
                    )
            payload["allowed_domains"] = domains
        payload["updated_at"] = now_iso()
        atomic_write_json(self.metadata_path(toolkit_id), payload)
        return payload

    def delete_toolkit(self, toolkit_id: str) -> None:
        self.get_toolkit(toolkit_id)
        if self.list_tools(toolkit_id):
            raise ValueError("Toolkit must be empty before deletion.")
        shutil.rmtree(self.toolkit_dir(toolkit_id))

    def list_tools(self, toolkit_id: str) -> list[dict[str, Any]]:
        self.get_toolkit(toolkit_id)
        items: list[dict[str, Any]] = []
        for path in (self.toolkit_dir(toolkit_id) / "tools").glob("*/tool.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                items.append(self._with_slot_facts(payload))
        return sorted(items, key=lambda item: str(item.get("created_at", "")))

    def find_tool(self, tool_id: str) -> dict[str, Any]:
        tool_id = _validate_slug(tool_id, field="tool_id")
        for toolkit in self.list_toolkits():
            path = self.tool_path(str(toolkit["toolkit_id"]), tool_id)
            if path.is_file():
                return self.get_tool(str(toolkit["toolkit_id"]), tool_id)
        raise FileNotFoundError(f"Tool not found: {tool_id}")

    def create_tool(
        self,
        toolkit_id: str,
        *,
        name: str,
        goal: str,
        start_url: str,
        expected_effect: str = "",
    ) -> dict[str, Any]:
        toolkit = self.get_toolkit(toolkit_id)
        tool_id = _validate_slug(name, field="name")
        base_path = self.toolkit_dir(toolkit_id) / ".server" / "adapter-base.json"
        if base_path.is_file():
            base = json.loads(base_path.read_text(encoding="utf-8"))
            manifest = json.loads(base64.b64decode(base["files"]["manifest.json"]))
            if tool_id.replace("_", "-") in {
                name for command in manifest["commands"]
                for name in [command["id"], *(command.get("aliases") or [])]
            }:
                raise ValueError("Tool command ID conflicts with an existing Adapter command.")
        try:
            self.find_tool(tool_id)
        except FileNotFoundError:
            pass
        else:
            raise ValueError(f"Tool already exists: {tool_id}")
        goal = str(goal or "").strip()
        if not goal:
            raise ValueError("goal is required.")
        start_url = str(start_url or "").strip()
        if _start_url_hostname(start_url) not in toolkit["allowed_domains"]:
            raise ValueError("start_url hostname must be in Toolkit allowed_domains.")
        created_at = now_iso()
        payload = {
            "tool_id": tool_id,
            "toolkit_id": toolkit_id,
            "name": tool_id,
            "goal": goal,
            "start_url": start_url,
            "expected_effect": str(expected_effect or "").strip(),
            "created_at": created_at,
            "updated_at": created_at,
        }
        atomic_write_json(self.tool_path(toolkit_id, tool_id), payload)
        return self._with_slot_facts(payload)

    def get_tool(self, toolkit_id: str, tool_id: str) -> dict[str, Any]:
        path = self.tool_path(toolkit_id, tool_id)
        if not path.is_file():
            raise FileNotFoundError(f"Tool not found: {tool_id}")
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("toolkit_id") != toolkit_id:
            raise ValueError("Tool does not belong to Toolkit.")
        return self._with_slot_facts(payload)

    def update_tool(
        self,
        toolkit_id: str,
        tool_id: str,
        *,
        goal: str | None = None,
        start_url: str | None = None,
        expected_effect: str | None = None,
    ) -> dict[str, Any]:
        toolkit = self.get_toolkit(toolkit_id)
        payload = self.get_tool(toolkit_id, tool_id)
        payload.pop("has_formal", None)
        payload.pop("has_development", None)
        if goal is not None:
            normalized_goal = str(goal).strip()
            if not normalized_goal:
                raise ValueError("goal is required.")
            payload["goal"] = normalized_goal
        if start_url is not None:
            normalized_url = str(start_url).strip()
            if _start_url_hostname(normalized_url) not in toolkit["allowed_domains"]:
                raise ValueError("start_url hostname must be in Toolkit allowed_domains.")
            payload["start_url"] = normalized_url
        if expected_effect is not None:
            payload["expected_effect"] = str(expected_effect).strip()
        payload["updated_at"] = now_iso()
        atomic_write_json(self.tool_path(toolkit_id, tool_id), payload)
        return self._with_slot_facts(payload)

    def delete_tool(self, toolkit_id: str, tool_id: str) -> None:
        self.get_tool(toolkit_id, tool_id)
        dev_dir = self.development_path(toolkit_id, tool_id).parent
        if dev_dir.exists():
            shutil.rmtree(dev_dir)
        shutil.rmtree(self.tool_dir(toolkit_id, tool_id))

    def stage_tool_deletion(self, toolkit_id: str, tool_id: str) -> str:
        self.get_tool(toolkit_id, tool_id)
        transaction_id = uuid.uuid4().hex
        staged = self.toolkit_dir(toolkit_id) / ".server" / "tool-deletions" / transaction_id
        staged.mkdir(parents=True)
        tool_dir = self.tool_dir(toolkit_id, tool_id)
        development_dir = self.development_path(toolkit_id, tool_id).parent
        try:
            tool_dir.rename(staged / "tool")
            if development_dir.exists():
                development_dir.rename(staged / "development")
        except Exception:
            if (staged / "tool").exists():
                (staged / "tool").rename(tool_dir)
            shutil.rmtree(staged)
            raise
        return transaction_id

    def finish_tool_deletion(self, toolkit_id: str, tool_id: str, transaction_id: str, *, restore: bool) -> None:
        if not re.fullmatch(r"[a-f0-9]{32}", transaction_id):
            raise ValueError("Invalid Tool deletion transaction.")
        staged = self.toolkit_dir(toolkit_id) / ".server" / "tool-deletions" / transaction_id
        if not (staged / "tool" / "tool.json").is_file():
            raise FileNotFoundError("Tool deletion transaction not found.")
        payload = json.loads((staged / "tool" / "tool.json").read_text(encoding="utf-8"))
        if payload.get("toolkit_id") != toolkit_id or payload.get("tool_id") != tool_id:
            raise ValueError("Tool deletion transaction does not match the Tool.")
        if restore:
            tool_dir = self.tool_dir(toolkit_id, tool_id)
            development_dir = self.development_path(toolkit_id, tool_id).parent
            if tool_dir.exists() or development_dir.exists():
                raise ValueError("Tool changed while deletion was pending.")
            (staged / "tool").rename(tool_dir)
            if (staged / "development").exists():
                development_dir.parent.mkdir(parents=True, exist_ok=True)
                (staged / "development").rename(development_dir)
        shutil.rmtree(staged)

    def read_formal_slot(self, toolkit_id: str, tool_id: str) -> dict[str, Any] | None:
        self.get_tool(toolkit_id, tool_id)
        return self._read_optional_json(self.formal_path(toolkit_id, tool_id))

    def read_development_slot(self, toolkit_id: str, tool_id: str) -> dict[str, Any] | None:
        self.get_tool(toolkit_id, tool_id)
        return self._read_optional_json(self.development_path(toolkit_id, tool_id))

    def write_formal_slot(
        self, toolkit_id: str, tool_id: str, slot: dict[str, Any]
    ) -> dict[str, Any]:
        with self._slot_lock:
            payload = self._validate_slot(toolkit_id, tool_id, slot)
            atomic_write_json(self.formal_path(toolkit_id, tool_id), payload)
            return payload

    def write_development_slot(
        self, toolkit_id: str, tool_id: str, slot: dict[str, Any]
    ) -> dict[str, Any]:
        with self._slot_lock:
            current = self.read_development_slot(toolkit_id, tool_id)
            payload = self._validate_slot(toolkit_id, tool_id, slot)
            if current and current.get("source_exploration_id") != payload.get(
                "source_exploration_id"
            ):
                raise ValueError("source_exploration_id cannot change during a development cycle.")
            atomic_write_json(self.development_path(toolkit_id, tool_id), payload)
            return payload

    def update_development_code(
        self,
        toolkit_id: str,
        tool_id: str,
        *,
        code: str,
        expected_code_hash: str,
    ) -> dict[str, Any]:
        with self._slot_lock:
            current = self.read_development_slot(toolkit_id, tool_id)
            if current is None:
                raise DevelopmentSlotConflictError(
                    "Tool has no development version."
                )
            if current.get("code_hash") != expected_code_hash:
                raise DevelopmentSlotConflictError(
                    "Development version changed before manual save."
                )
            payload = self._validate_slot(
                toolkit_id,
                tool_id,
                {**current, "code": code},
            )
            atomic_write_json(self.development_path(toolkit_id, tool_id), payload)
            return payload

    def promote_development_slot(
        self, toolkit_id: str, tool_id: str, *, expected_code_hash: str
    ) -> dict[str, Any]:
        with self._slot_lock:
            current = self.read_development_slot(toolkit_id, tool_id)
            if current is None or current.get("code_hash") != expected_code_hash:
                raise ValueError("Development version changed during publish.")
            return self.write_formal_slot(toolkit_id, tool_id, current)

    def clear_development_slot(
        self,
        toolkit_id: str,
        tool_id: str,
        *,
        expected_code_hash: str | None = None,
    ) -> bool:
        with self._slot_lock:
            self.get_tool(toolkit_id, tool_id)
            path = self.development_path(toolkit_id, tool_id)
            if not path.is_file():
                return False
            if expected_code_hash is not None:
                current = self.read_development_slot(toolkit_id, tool_id)
                if current is None or current.get("code_hash") != expected_code_hash:
                    return False
            path.unlink()
            return True

    def reset_development_from_formal(
        self, toolkit_id: str, tool_id: str
    ) -> dict[str, Any]:
        with self._slot_lock:
            formal = self.read_formal_slot(toolkit_id, tool_id)
            if formal is None:
                raise ValueError("Tool has no formal version.")
            payload = dict(formal)
            payload["source_exploration_id"] = ""
            payload["based_on_formal_hash"] = str(formal["code_hash"])
            payload["debug_run_evidence_id"] = ""
            written = self._validate_slot(toolkit_id, tool_id, payload)
            atomic_write_json(self.development_path(toolkit_id, tool_id), written)
            return written

    def read_runtime(self, toolkit_id: str) -> dict[str, Any]:
        self.get_toolkit(toolkit_id)
        payload = self._read_optional_json(self.runtime_path(toolkit_id))
        return payload or {
            "target_id": "",
            "last_url": "",
            "last_title": "",
            "updated_at": "",
        }

    def write_runtime(
        self, toolkit_id: str, *, target_id: str, last_url: str, last_title: str, browser_instance_id: str = ""
    ) -> dict[str, Any]:
        if not self.metadata_path(toolkit_id).is_file():
            raise FileNotFoundError(f"Toolkit not found: {toolkit_id}")
        payload = {
            "target_id": str(target_id or ""),
            "last_url": str(last_url or ""),
            "last_title": str(last_title or ""),
            "updated_at": now_iso(),
        }
        if browser_instance_id:
            payload["browser_instance_id"] = browser_instance_id
        atomic_write_json(self.runtime_path(toolkit_id), payload)
        return payload

    def _with_slot_facts(self, payload: dict[str, Any]) -> dict[str, Any]:
        item = dict(payload)
        toolkit_id = str(item["toolkit_id"])
        tool_id = str(item["tool_id"])
        item["has_formal"] = self.formal_path(toolkit_id, tool_id).is_file()
        item["has_development"] = self.development_path(toolkit_id, tool_id).is_file()
        return item

    def _validate_slot(
        self, toolkit_id: str, tool_id: str, slot: dict[str, Any]
    ) -> dict[str, Any]:
        self.get_tool(toolkit_id, tool_id)
        validated = validate_tool_slot(tool_id, slot)
        code = validated["code"]
        payload = {
            "tool_id": tool_id,
            "code_hash": code_hash(code),
            **validated,
            "source_exploration_id": str(slot.get("source_exploration_id") or ""),
            "based_on_formal_hash": str(slot.get("based_on_formal_hash") or ""),
            "debug_run_evidence_id": str(slot.get("debug_run_evidence_id") or ""),
            "updated_at": now_iso(),
        }
        return payload

    @staticmethod
    def _read_optional_json(path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"Expected JSON object: {path}")
        return payload
