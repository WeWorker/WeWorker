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


def _base_path(store: ToolkitStore, toolkit_id: str) -> Path:
    return store.toolkit_dir(toolkit_id) / ".server" / "adapter-base.json"


def read_base(store: ToolkitStore, toolkit_id: str) -> dict[str, Any] | None:
    path = _base_path(store, toolkit_id)
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def bind_base(
    store: ToolkitStore, toolkit_id: str, *, profile: str, digest: str,
    files: dict[str, str],
) -> dict[str, Any]:
    if read_base(store, toolkit_id) is not None:
        raise ValueError("Adapter is already bound to this workspace.")
    if not isinstance(profile, str) or not _PROFILE.fullmatch(profile) or not isinstance(files, dict):
        raise ValueError("A complete Adapter package and profile are required.")
    if not 1 <= len(files) <= 512 or any(not _safe_package_path(name) or not isinstance(value, str)
                                         for name, value in files.items()):
        raise ValueError("Adapter package contains an unsafe file path.")
    decoded = {name: base64.b64decode(value, validate=True) for name, value in files.items()}
    if sum(len(content) for content in decoded.values()) > 32 * 1024 * 1024:
        raise ValueError("Adapter package exceeds the size limit.")
    manifest = json.loads(decoded["manifest.json"])
    _check_package_identity(manifest.get("name"), digest)
    if package_digest(decoded) != digest:
        raise ValueError("Adapter package changed during import.")
    if manifest.get("schema_version") != 2 or not manifest.get("name"):
        raise ValueError("Only v2 Adapter packages can be extended.")
    toolkit = store.get_toolkit(toolkit_id)
    metadata = {**toolkit, "name": manifest["name"], "adapter_name": manifest["name"]}
    atomic_write_json(store.metadata_path(toolkit_id), metadata)
    base = {"profile": profile, "digest": digest, "name": manifest["name"], "files": files}
    atomic_write_json(_base_path(store, toolkit_id), base)
    return {"name": manifest["name"], "digest": digest, "profile": profile}


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

{str(slot["code"]).rstrip()}

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
    toolkit = store.get_toolkit(toolkit_id)
    base = read_base(store, toolkit_id)
    files = ({name: base64.b64decode(content, validate=True)
              for name, content in base["files"].items()} if base else {})
    manifest = json.loads(files["manifest.json"]) if base else {
        "schema_version": 2, "name": adapter_name(store, toolkit_id),
        "version": "1.0.0", "description": toolkit.get("description") or toolkit["name"],
        "runtime_allowed_hosts": toolkit["allowed_domains"], "commands": [],
    }
    if base:
        major, minor, patch = (int(part) for part in manifest["version"].split("-")[0].split("+")[0].split("."))
        manifest["version"] = f"{major}.{minor}.{patch + 1}"
        manifest["runtime_allowed_hosts"] = list(dict.fromkeys([
            *(manifest.get("runtime_allowed_hosts") or []), *toolkit["allowed_domains"],
        ]))
    existing = {command["id"] for command in manifest["commands"]}
    for tool in store.list_tools(toolkit_id):
        tool_id = str(tool["tool_id"])
        slot = store.read_formal_slot(toolkit_id, tool_id)
        if not slot:
            continue
        command_id = tool_id.replace("_", "-")
        if command_id in existing:
            raise ValueError(f"Adapter command already exists: {command_id}")
        module = f"wewright/commands/{command_id}.py"
        compile(slot["code"], module, "exec")
        files[module] = _command_source(
            toolkit_id=toolkit_id, tool_id=tool_id, toolkit=toolkit, tool=tool, slot=slot,
        ).encode("utf-8")
        manifest["commands"].append({
            "id": command_id, "runtime": "wewright", "module": module,
            "description": slot.get("description") or tool.get("goal") or command_id,
            "schema": slot["parameters_schema"], "safety": "read",
        })
        existing.add(command_id)
    if not manifest["commands"]:
        raise ValueError("Adapter has no published commands.")
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    return files


def snapshot_package(store: ToolkitStore, toolkit_id: str) -> dict[str, Any]:
    files = render_package(store, toolkit_id)
    digest = package_digest(files)
    name = adapter_name(store, toolkit_id)
    _check_package_identity(name, digest)
    if any(not _safe_package_path(relative) for relative in files):
        raise ValueError("Adapter package contains an unsafe file path.")
    root = store.toolkit_dir(toolkit_id) / "v2-snapshots" / digest / name
    for relative, content in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() != content:
            raise ValueError("Published Adapter snapshot was modified.")
        if not target.exists():
            target.write_bytes(content)
    metadata = {"name": name, "digest": digest, "version": json.loads(files["manifest.json"])["version"]}
    atomic_write_json(store.toolkit_dir(toolkit_id) / ".server" / "v2-current.json", metadata)
    return metadata


def current_package(store: ToolkitStore, toolkit_id: str) -> tuple[dict[str, Any], dict[str, bytes], Path]:
    metadata = json.loads((store.toolkit_dir(toolkit_id) / ".server" / "v2-current.json").read_text())
    _check_package_identity(metadata["name"], metadata["digest"])
    root = store.toolkit_dir(toolkit_id) / "v2-snapshots" / metadata["digest"] / metadata["name"]
    files = {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}
    if package_digest(files) != metadata["digest"]:
        raise ValueError("Published Adapter snapshot changed.")
    return metadata, files, root
