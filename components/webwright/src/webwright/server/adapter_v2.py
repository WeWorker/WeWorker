"""Build a v2 Adapter from published Toolkit slots and an optional retained package."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from webwright.server.records import atomic_write_json
from webwright.server.toolkit_store import ToolkitStore


_ADAPTER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_DIGEST = re.compile(r"^[a-f0-9]{64}$")


def _safe_package_path(name: str) -> bool:
    return (isinstance(name, str) and 0 < len(name) <= 512 and not name.startswith("/")
            and "\\" not in name and all(part not in {"", ".", ".."}
                                     and not re.search(r'[\x00-\x1f\x7f:*?"<>|]', part)
                                     and not part.endswith((".", " "))
                                     for part in name.split("/")))


def _check_package_identity(name: str, digest: str) -> None:
    if not isinstance(name, str) or not _ADAPTER_NAME.fullmatch(name) or name in {".", ".."}:
        raise ValueError("Invalid Adapter package name.")
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise ValueError("Invalid Adapter package digest.")


def package_digest(files: dict[str, bytes]) -> str:
    """The byte-level package digest used by the host's v2 package reader."""
    digest = hashlib.sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(str(len(content)).encode())
        digest.update(b"\0")
        digest.update(content)
    return digest.hexdigest()


def read_base(store: ToolkitStore, toolkit_id: str) -> dict[str, Any] | None:
    from webwright.server.package_workspace import read_state, read_package
    base = read_state(store, toolkit_id).get("retained_base")
    if not base:
        return None
    files, _ = read_package(store, toolkit_id, base["digest"])
    return {**base, "files": {name: base64.b64encode(value).decode("ascii") for name, value in files.items()}}


def bind_base(store: ToolkitStore, toolkit_id: str, *, profile: str, digest: str,
              files: dict[str, str]) -> dict[str, Any]:
    from webwright.server.package_workspace import read_state, save_state, write_package
    with store._slot_lock:
        state = read_state(store, toolkit_id)
        if state.get("retained_base") or state.get("candidate_digest"):
            raise ValueError("Adapter workspace already contains a package.")
        if not isinstance(profile, str) or not _PROFILE.fullmatch(profile) or not isinstance(files, dict):
            raise ValueError("A complete Adapter package and profile are required.")
        if not 1 <= len(files) <= 512 or any(not _safe_package_path(name) or not isinstance(value, str) for name, value in files.items()):
            raise ValueError("Adapter package contains an unsafe file path.")
        decoded = {name: base64.b64decode(value, validate=True) for name, value in files.items()}
        if sum(map(len, decoded.values())) > 32 * 1024 * 1024:
            raise ValueError("Adapter package exceeds the size limit.")
        manifest = json.loads(decoded["manifest.json"])
        _check_package_identity(manifest.get("name"), digest)
        if package_digest(decoded) != digest or manifest.get("schema_version") != 2:
            raise ValueError("Invalid v2 Adapter package.")
        write_package(store, toolkit_id, decoded)
        toolkit = store.get_toolkit(toolkit_id)
        atomic_write_json(store.metadata_path(toolkit_id), {**toolkit, "name": manifest["name"], "adapter_name": manifest["name"]})
        base = {"profile": profile, "digest": digest, "name": manifest["name"]}
        state.update(retained_base=base, install_baseline_digest=digest, profile=profile)
        save_state(store, toolkit_id, state)
        return base


def adapter_name(store: ToolkitStore, toolkit_id: str) -> str:
    return str(store.get_toolkit(toolkit_id).get("adapter_name") or toolkit_id.replace("_", "-"))


def _command_source(
    *, toolkit_id: str, tool_id: str, toolkit: dict[str, Any],
    tool: dict[str, Any], slot: dict[str, Any],
) -> str:
    specification = {
        "start_url": tool["start_url"],
        "parameters_schema": slot["parameters_schema"],
        "result_schema": slot["result_schema"],
    }
    # Each command is self-contained; the shared runtime stays in the host bundle.
    return f'''from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from webwright.tool_runtime.toolkit_runtime import PublishedToolkitRunner

sys.dont_write_bytecode = True

{str(slot["code"])}

SCHEMA = {specification!r}
RUNNER = PublishedToolkitRunner(
    toolkit_id={toolkit_id!r},
    skill_dir=Path(__file__).resolve().parents[2],
    allowed_domains={toolkit["allowed_domains"]!r},
    tool_specs={{{tool_id!r}: SCHEMA}},
    tool_functions={{{tool_id!r}: {tool_id}}},
    **({{"cdp_url": os.environ["WEBWRIGHT_CDP_URL"]}} if os.environ.get("WEBWRIGHT_CDP_URL") else {{}}),
)

def normalize(raw):
    if not isinstance(raw, dict):
        raise ValueError("Tool parameters must be a JSON object.")
    properties = SCHEMA["parameters_schema"].get("properties") or {{}}
    result = {{}}
    for external_name, value in raw.items():
        if external_name == "__confirmed":
            continue
        name = external_name if external_name in properties else str(external_name).replace("-", "_")
        definition = properties.get(name) or {{}}
        kind = definition.get("type")
        if kind == "integer" and isinstance(value, str):
            value = int(value)
        elif kind == "number" and isinstance(value, str):
            value = float(value)
        elif kind == "array" and not isinstance(value, list):
            value = [value]
        if kind == "array" and isinstance(value, list):
            item_kind = (definition.get("items") or {{}}).get("type")
            if item_kind == "integer":
                value = [int(item) if isinstance(item, str) else item for item in value]
            elif item_kind == "number":
                value = [float(item) if isinstance(item, str) else item for item in value]
        result[name] = value
    for name, definition in properties.items():
        if name not in result and "default" in definition:
            result[name] = definition["default"]
        if name in result and isinstance(definition.get("enum"), list) and result[name] not in definition["enum"]:
            raise ValueError(f"Invalid value for parameter {{name}}.")
    return result

def main():
    try:
        parameters = normalize(json.load(sys.stdin))
        screenshot = os.environ.get("WEBWRIGHT_SCREENSHOT_PATH")
        output = asyncio.run(RUNNER.run(
            tool_id={tool_id!r}, parameters=parameters,
            screenshot_path=Path(screenshot) if screenshot else None,
        ))
        print(json.dumps(output, ensure_ascii=False))
        return 0 if output.get("ok") else 1
    except (TypeError, ValueError) as error:
        print(json.dumps({{"ok": False, "error": {{"message": str(error)}}}}, ensure_ascii=False))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
'''


def render_package(store: ToolkitStore, toolkit_id: str) -> dict[str, bytes]:
    return current_package(store, toolkit_id)[1]


def snapshot_package(store: ToolkitStore, toolkit_id: str) -> dict[str, Any]:
    return current_package(store, toolkit_id)[0]


def current_package(store: ToolkitStore, toolkit_id: str) -> tuple[dict[str, Any], dict[str, bytes], Path]:
    from webwright.server.package_workspace import read_state, read_package
    state = read_state(store, toolkit_id)
    digest = state.get("candidate_digest")
    if not digest:
        raise ValueError("Adapter has no saved commands.")
    files, root = read_package(store, toolkit_id, digest)
    manifest = json.loads(files["manifest.json"])
    return {"name": manifest["name"], "digest": digest, "version": manifest["version"]}, files, root
