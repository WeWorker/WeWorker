from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import re
import shutil
import sys
import tempfile
import threading
import types
import uuid
import zipfile
from pathlib import Path
from typing import Any

from webwright.server.debug_store import DebugRunStore
from webwright.server.adapter_v2 import current_package, snapshot_package
from webwright.server.records import atomic_write_json, now_iso
from webwright.server.toolkit_store import ToolkitStore
from webwright.resources import BundledResources
from webwright.runtime_launcher import RuntimeLauncher
from webwright.runtime_identity import RuntimeIdentity
from webwright.tool_runtime.toolkit_runtime import PLAYWRIGHT_REQUIREMENT


RUNTIME_REQUIREMENT = PLAYWRIGHT_REQUIREMENT
EXECUTABLE_ARTIFACT_NAMES = (
    "scripts/toolkit.py",
    "scripts/toolkit_runtime.py",
)
DISTRIBUTION_FILE_NAMES = (
    "manifest.json",
    "SKILL.md",
    *EXECUTABLE_ARTIFACT_NAMES,
    "scripts/requirements.txt",
)
DISTRIBUTION_CHECKSUM_NAMES = (
    "manifest.json",
    "SKILL.md",
    "scripts/requirements.txt",
)


def skill_name(toolkit_id: str) -> str:
    return toolkit_id.replace("_", "-")


def _load_generated_module(script_path: Path) -> types.ModuleType:
    """Import the freshly rendered toolkit.py in an isolated namespace.

    The generated module only touches the filesystem through path resolution
    at import time (RUNNER construction); nothing connects to a browser. The
    ``toolkit_runtime`` import resolves from the artifact's scripts directory,
    and both modules are removed from ``sys.modules`` afterwards so repeat
    publishes never reuse a stale template.
    """
    spec = importlib.util.spec_from_file_location(
        "webwright_publish_toolkit", script_path
    )
    module = importlib.util.module_from_spec(spec)
    scripts_dir = str(script_path.parent)
    previous_bytecode_flag = sys.dont_write_bytecode
    sys.path.insert(0, scripts_dir)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(scripts_dir)
        sys.dont_write_bytecode = previous_bytecode_flag
        sys.modules.pop("toolkit_runtime", None)
        sys.modules.pop("webwright_publish_toolkit", None)
    return module


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(content.encode("utf-8"))
    temporary.replace(path)


def _formal_tools(store: ToolkitStore, toolkit_id: str, *, override: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    items = []
    for tool in store.list_tools(toolkit_id):
        slot = override if override and override.get("tool_id") == tool["tool_id"] else store.read_formal_slot(toolkit_id, str(tool["tool_id"]))
        if slot:
            items.append({"tool": tool, "slot": slot})
    return items


def render_artifacts(
    store: ToolkitStore,
    toolkit_id: str,
    *,
    override: dict[str, Any] | None = None,
    resources: BundledResources | None = None,
) -> dict[str, str]:
    toolkit = store.get_toolkit(toolkit_id)
    tools = _formal_tools(store, toolkit_id, override=override)
    tool_specs = {
        item["tool"]["tool_id"]: {
            "start_url": item["tool"]["start_url"],
            "parameters_schema": item["slot"]["parameters_schema"],
            "result_schema": item["slot"]["result_schema"],
        }
        for item in tools
    }
    implementations = "\n\n".join(str(item["slot"]["code"]).rstrip() for item in tools)
    toolkit_py = f'''from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True

from toolkit_runtime import PublishedToolkitRunner

{implementations}

TOOLKIT_ID = {toolkit_id!r}
ALLOWED_DOMAINS = {toolkit["allowed_domains"]!r}
TOOL_SPECS = {tool_specs!r}
TOOL_FUNCTIONS = {{{", ".join(f"{item['tool']['tool_id']!r}: {item['tool']['tool_id']}" for item in tools)}}}
RUNNER = PublishedToolkitRunner(
    toolkit_id=TOOLKIT_ID,
    skill_dir=Path(__file__).resolve().parent.parent,
    allowed_domains=ALLOWED_DOMAINS,
    tool_specs=TOOL_SPECS,
    tool_functions=TOOL_FUNCTIONS,
    **({{"cdp_url": os.environ["WEBWRIGHT_CDP_URL"]}} if os.environ.get("WEBWRIGHT_CDP_URL") else {{}}),
)


def _normalize_webcli_parameters(schema: dict, raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Tool parameters must be a JSON object.")
    properties = schema.get("properties") or {{}}
    normalized = {{}}
    for external_name, value in raw.items():
        name = external_name
        underscored = str(external_name).replace("-", "_")
        if name not in properties and underscored in properties:
            name = underscored
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
        normalized[name] = value
    for name, definition in properties.items():
        if name not in normalized and "default" in definition:
            normalized[name] = definition["default"]
        if name in normalized and isinstance(definition.get("enum"), list):
            if normalized[name] not in definition["enum"]:
                raise ValueError(f"Invalid value for parameter {{name}}.")
    return normalized


def _parser(*, debug_parameters: bool = False) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description={str(toolkit.get("description") or toolkit_id)!r})
    commands = parser.add_subparsers(dest="tool", required=True)
    for tool_id, spec in TOOL_SPECS.items():
        schema = spec["parameters_schema"]
        command = commands.add_parser(tool_id.replace("_", "-"))
        command.set_defaults(tool_id=tool_id)
        required = set(schema.get("required") or [])
        for name, definition in (schema.get("properties") or {{}}).items():
            kind = definition.get("type", "string")
            options = {{"dest": name, "required": name in required and not debug_parameters}}
            if kind == "boolean":
                options = {{"dest": name, "action": "store_true"}}
            elif kind == "integer":
                options["type"] = int
            elif kind == "number":
                options["type"] = float
            elif kind in {{"object", "array"}}:
                options["type"] = json.loads
            command.add_argument("--" + name.replace("_", "-"), **options)
    return parser


def main() -> int:
    debug_parameters = os.environ.get("WEBWRIGHT_PARAMETERS_STDIN") == "1"
    args = vars(_parser(debug_parameters=debug_parameters).parse_args())
    tool_id = args.pop("tool_id")
    args.pop("tool", None)
    if debug_parameters:
        parameters = json.load(sys.stdin)
        try:
            parameters = _normalize_webcli_parameters(
                TOOL_SPECS[tool_id]["parameters_schema"], parameters
            )
        except (TypeError, ValueError) as error:
            print(json.dumps(
                {{"ok": False, "error": {{"message": str(error)}}}},
                ensure_ascii=False,
            ))
            return 1
    else:
        parameters = {{key: value for key, value in args.items() if value is not None}}
    screenshot = os.environ.get("WEBWRIGHT_SCREENSHOT_PATH")
    output = asyncio.run(
        RUNNER.run(
            tool_id=tool_id,
            parameters=parameters,
            screenshot_path=Path(screenshot) if screenshot else None,
        )
    )
    print(json.dumps(output, ensure_ascii=False))
    return 0 if output.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
'''
    skill_lines = [
        f"# {toolkit['name']}",
        "",
        str(toolkit.get("description") or ""),
        "",
        "## 运行环境",
        "",
        "使用 `webcli` 运行；网站自动化运行环境已内嵌，无需另行安装依赖。",
        "",
        "所有命令均在本 Skill 根目录执行。运行时页面状态保存在用户状态目录，不写入 Skill。",
        "",
    ]
    for item in tools:
        tool = item["tool"]
        slot = item["slot"]
        skill_lines.extend(
            [
                f"## {tool['tool_id']}",
                "",
                slot["description"],
                "",
                f"调用：`webcli call {skill_name(toolkit_id)}.{str(tool['tool_id']).replace('_', '-')} --参数名=参数值`",
                "",
                f"参数 Schema：`{json.dumps(slot['parameters_schema'], ensure_ascii=False, sort_keys=True)}`",
                "",
                f"返回 Schema：`{json.dumps(slot['result_schema'], ensure_ascii=False, sort_keys=True)}`",
                "",
                f"风险提示：{slot['risk_notice'] or '无'}",
                "",
            ]
        )
    allowed_domains = "、".join(str(domain) for domain in toolkit["allowed_domains"])
    skill_description = (
        f"{str(toolkit.get('description') or toolkit['name'])}。"
        f"当需要操作以下域名的网页时可使用：{allowed_domains}。"
    )
    skill = "\n".join(
        [
            "---",
            f"name: {skill_name(toolkit_id)}",
            f"description: {json.dumps(skill_description, ensure_ascii=False)}",
            "---",
            "",
            *skill_lines,
        ]
    ).rstrip() + "\n"
    executable_artifacts = {
        "scripts/toolkit.py": toolkit_py,
        "scripts/toolkit_runtime.py": (
            resources or BundledResources()
        ).canonical_toolkit_runtime(),
    }
    adapter_id = skill_name(toolkit_id)
    manifest = {
        "schema_version": 1,
        "id": adapter_id,
        "name": str(toolkit.get("name") or adapter_id),
        "description": str(toolkit.get("description") or ""),
        "adapter_type": "toolkit",
        "entry": "scripts/toolkit.py",
        "allowed_domains": list(toolkit["allowed_domains"]),
        "artifact_hash": artifact_hash(executable_artifacts),
        "tools": [
            {
                "id": str(item["tool"]["tool_id"]).replace("_", "-"),
                "name": f"{adapter_id}.{str(item['tool']['tool_id']).replace('_', '-')}",
                "description": str(item["slot"]["description"]),
                "parameters_schema": item["slot"]["parameters_schema"],
                "result_schema": item["slot"]["result_schema"],
            }
            for item in tools
        ],
    }
    return {
        "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        "SKILL.md": skill,
        **executable_artifacts,
        "scripts/requirements.txt": RUNTIME_REQUIREMENT,
    }


def artifact_hash(artifacts: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for name in EXECUTABLE_ARTIFACT_NAMES:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(artifacts[name].encode())
    return f"sha256:{digest.hexdigest()}"


def _content_checksum(content: str) -> str:
    return f"sha256:{hashlib.sha256(content.encode()).hexdigest()}"


def distribution_hash(artifacts: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for name in DISTRIBUTION_FILE_NAMES:
        digest.update(name.encode() + b"\0")
        digest.update(_content_checksum(artifacts[name]).encode() + b"\0")
    return f"sha256:{digest.hexdigest()}"


def read_distribution(root: Path) -> dict[str, Any]:
    """Read a standalone five-file package without consulting development state."""
    if root.is_symlink() or (root / "scripts").is_symlink():
        raise ValueError("Adapter directories must not be symbolic links.")
    artifacts = {}
    for name in DISTRIBUTION_FILE_NAMES:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Adapter is missing a regular file: {name}")
        artifacts[name] = path.read_bytes().decode("utf-8")
    manifest = json.loads(artifacts["manifest.json"])
    if not isinstance(manifest, dict) or (
        manifest.get("schema_version") != 1
        or manifest.get("adapter_type") != "toolkit"
        or manifest.get("id") != root.name
        or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", root.name)
        or manifest.get("entry") != "scripts/toolkit.py"
        or manifest.get("artifact_hash") != artifact_hash(artifacts)
    ):
        raise ValueError("Adapter manifest or executable hash is invalid.")
    tools = manifest.get("tools")
    if not isinstance(tools, list) or not tools:
        raise ValueError("Adapter manifest must contain tools.")
    names = set()
    for tool in tools:
        if not isinstance(tool, dict):
            raise ValueError("Adapter tool definition is invalid.")
        tool_id = tool.get("id", "")
        schema = tool.get("parameters_schema")
        if (
            not isinstance(tool_id, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", tool_id)
            or tool_id in names
            or tool.get("name") != f"{root.name}.{tool_id}"
            or not isinstance(schema, dict)
            or schema.get("type") != "object"
            or not isinstance(schema.get("properties"), dict)
            or not all(isinstance(field, dict) for field in schema["properties"].values())
            or not isinstance(schema.get("required", []), list)
            or any(not isinstance(key, str) or key not in schema["properties"] for key in schema.get("required", []))
        ):
            raise ValueError("Adapter tool registration or parameter schema is invalid.")
        names.add(tool_id)
    return {
        "manifest": manifest,
        "artifacts": artifacts,
        "artifact_hash": artifact_hash(artifacts),
        "distribution_hash": distribution_hash(artifacts),
    }


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


def _directory_matches_artifacts(root: Path, artifacts: dict[str, str]) -> bool:
    if not root.is_dir() or root.is_symlink():
        return False
    actual_files: set[str] = set()
    actual_dirs: set[str] = set()
    for item in root.rglob("*"):
        if item.is_symlink():
            return False
        relative = item.relative_to(root).as_posix()
        if item.is_dir():
            actual_dirs.add(relative)
        elif item.is_file():
            actual_files.add(relative)
        else:
            return False
    if actual_files != set(artifacts) or actual_dirs != {"scripts"}:
        return False
    try:
        return all(
            (root / name).read_bytes().decode("utf-8") == content
            for name, content in artifacts.items()
        )
    except OSError:
        return False


def _replace_skill_directory(target: Path, artifacts: dict[str, str]) -> str:
    target.parent.mkdir(parents=True, exist_ok=True)
    target_exists = target.exists() or target.is_symlink()
    if target_exists and _directory_matches_artifacts(target, artifacts):
        return "unchanged"

    staging_root = Path(
        tempfile.mkdtemp(prefix=".webwright-install-", dir=target.parent)
    )
    staged = staging_root / target.name
    backup = target.parent / f".{target.name}.webwright-backup-{uuid.uuid4().hex}"
    moved_old = False
    try:
        for name, content in artifacts.items():
            _atomic_write_text(staged / name, content)
    except Exception:
        _remove_path(staging_root)
        raise
    try:
        if target_exists:
            target.replace(backup)
            moved_old = True
        staged.replace(target)
    except Exception:
        if moved_old:
            _remove_path(target)
            backup.replace(target)
            moved_old = False
        elif not target_exists:
            _remove_path(target)
        raise
    finally:
        _remove_path(staging_root)
        if moved_old:
            _remove_path(backup)
    return "updated" if target_exists else "installed"


class ToolkitPublisher:
    def __init__(
        self,
        store: ToolkitStore,
        debug_store: DebugRunStore,
        *,
        launcher: RuntimeLauncher | None = None,
        resources: BundledResources | None = None,
    ):
        self.store = store
        self.debug_store = debug_store
        self.launcher = launcher or RuntimeLauncher()
        self.resources = resources or BundledResources()
        self._lock = threading.Lock()

    def journal_path(self, toolkit_id: str) -> Path:
        return self.store.toolkit_dir(toolkit_id) / ".server" / "publish.json"

    def build_path(self, toolkit_id: str) -> Path:
        return self.store.toolkit_dir(toolkit_id) / ".server" / "build.json"

    def _validate(self, artifacts: dict[str, str], *, tool_ids: list[str]) -> None:
        compile(artifacts["scripts/toolkit.py"], "toolkit.py", "exec")
        compile(artifacts["scripts/toolkit_runtime.py"], "toolkit_runtime.py", "exec")
        manifest = json.loads(artifacts["manifest.json"])
        if manifest.get("schema_version") != 1:
            raise ValueError("Generated Toolkit manifest has an invalid schema version.")
        if manifest.get("adapter_type") != "toolkit":
            raise ValueError("Generated Toolkit manifest has an invalid adapter type.")
        if manifest.get("entry") != "scripts/toolkit.py":
            raise ValueError("Generated Toolkit manifest has an invalid entry.")
        if manifest.get("artifact_hash") != artifact_hash(artifacts):
            raise ValueError("Generated Toolkit manifest artifact hash does not match.")
        manifest_tool_ids = {
            str(item.get("id") or "")
            for item in manifest.get("tools") or []
            if isinstance(item, dict)
        }
        if manifest_tool_ids != {tool_id.replace("_", "-") for tool_id in tool_ids}:
            raise ValueError("Generated Toolkit manifest tools do not match formal tools.")
        if "target_id" in artifacts["SKILL.md"] or "cdp_url" in artifacts["SKILL.md"]:
            raise ValueError("Generated Skill exposes runtime-internal parameters.")
        with tempfile.TemporaryDirectory(prefix="webwright-publish-") as temporary:
            root = Path(temporary)
            for name, content in artifacts.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            script_path = root / "scripts" / "toolkit.py"
            # Exercise the generated CLI in-process instead of spawning the
            # freshly written script: endpoint security holds "a process
            # executes the file it just wrote" children indefinitely, which
            # deadlocked publish (subprocess never returned, bridge timed out).
            module = _load_generated_module(script_path)
            build_parser = getattr(module, "_parser", None)
            if build_parser is None:
                raise ValueError("Generated CLI validation failed: no _parser().")
            for arguments in [
                ["--help"],
                *[[tool_id.replace("_", "-"), "--help"] for tool_id in tool_ids],
            ]:
                buffer = io.StringIO()
                try:
                    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(
                        buffer
                    ):
                        build_parser(debug_parameters=False).parse_args(arguments)
                except SystemExit as exc:
                    if exc.code != 0:
                        raise ValueError(
                            "Generated CLI validation failed: "
                            f"{buffer.getvalue().strip()}"
                        ) from exc
                except Exception as exc:
                    raise ValueError(
                        f"Generated CLI validation failed: {exc}"
                    ) from exc

    def _install(self, toolkit_id: str, artifacts: dict[str, str]) -> dict[str, Any]:
        root = self.store.toolkit_dir(toolkit_id) / skill_name(toolkit_id)
        for name, content in artifacts.items():
            _atomic_write_text(root / name, content)
        formal_hashes = {
            tool["tool_id"]: slot["code_hash"]
            for tool in self.store.list_tools(toolkit_id)
            if (slot := self.store.read_formal_slot(toolkit_id, str(tool["tool_id"])))
        }
        build = {
            "toolkit_id": toolkit_id,
            "formal_hashes": formal_hashes,
            "artifact_hash": artifact_hash(artifacts),
            "distribution_checksums": {
                name: _content_checksum(artifacts[name])
                for name in DISTRIBUTION_CHECKSUM_NAMES
            },
            "distribution_hash": distribution_hash(artifacts),
            "built_at": now_iso(),
        }
        atomic_write_json(self.build_path(toolkit_id), build)
        return build

    def publish(self, toolkit_id: str, tool_id: str) -> dict[str, Any]:
        with self._lock:
            development = self.store.read_development_slot(toolkit_id, tool_id)
            if development is None:
                raise ValueError("Tool has no development version.")
            if not self.debug_store.has_successful_run(
                tool_id=tool_id,
                channel="development",
                code_hash=str(development["code_hash"]),
            ):
                raise ValueError("Current development code has no succeeded Debug Run.")
            atomic_write_json(
                self.journal_path(toolkit_id),
                {
                    "toolkit_id": toolkit_id,
                    "tool_id": tool_id,
                    "code_hash": development["code_hash"],
                    "phase": "prepared",
                    "created_at": now_iso(),
                },
            )
            try:
                formal = self.store.promote_development_slot(
                    toolkit_id,
                    tool_id,
                    expected_code_hash=str(development["code_hash"]),
                )
            except Exception:
                self.journal_path(toolkit_id).unlink(missing_ok=True)
                raise
            atomic_write_json(
                self.journal_path(toolkit_id),
                {
                    "toolkit_id": toolkit_id,
                    "tool_id": tool_id,
                    "code_hash": development["code_hash"],
                    "phase": "formal_installed",
                    "created_at": now_iso(),
                },
            )
            build = snapshot_package(self.store, toolkit_id)
            self.store.clear_development_slot(
                toolkit_id,
                tool_id,
                expected_code_hash=str(development["code_hash"]),
            )
            self.journal_path(toolkit_id).unlink(missing_ok=True)
            return {"formal": formal, "build": build}

    def export_status(self, toolkit_id: str) -> dict[str, Any]:
        try:
            metadata, files, _ = current_package(self.store, toolkit_id)
        except (OSError, ValueError) as error:
            return {
                "toolkit_id": toolkit_id, "artifact_hash": "", "distribution_hash": "",
                "distribution_checksums": {}, "tools": [], "unverified_tools": [],
                "artifacts_consistent": False, "export_eligible": False,
                "error": str(error),
            }
        manifest = json.loads(files["manifest.json"])
        runtime = RuntimeIdentity.resolve().as_health_fields()
        tools = []
        for definition in manifest["commands"]:
            if definition["runtime"] != "wewright":
                continue
            tool_id = definition["id"].replace("-", "_")
            verified = any(
                run.get("status") == "succeeded"
                and run.get("channel") == "formal"
                and run.get("distribution_hash") == metadata["digest"]
                and run.get("runtime_identity") == runtime
                for run in self.debug_store.list_for_tool(tool_id, toolkit_id)
            )
            tools.append({
                **definition, "tool_id": tool_id, "name": definition["id"],
                "parameters_schema": definition["schema"],
                "code_hash": "sha256:" + metadata["digest"],
                "distribution_hash": metadata["digest"],
                "verified": verified,
            })
        unverified = [item["tool_id"] for item in tools if not item["verified"]]
        return {
            "toolkit_id": toolkit_id,
            "adapter_name": metadata["name"], "version": metadata["version"],
            "artifact_hash": metadata["digest"],
            "distribution_hash": metadata["digest"],
            "distribution_checksums": {},
            "tools": tools,
            "unverified_tools": unverified,
            "artifacts_consistent": True,
            "export_eligible": bool(tools) and not unverified,
        }

    def export_zip(self, toolkit_id: str) -> bytes:
        status = self.export_status(toolkit_id)
        if not status["export_eligible"]:
            if not status.get("artifacts_consistent"):
                raise ValueError("Published Toolkit distribution files changed during export.")
            raise ValueError("Toolkit is not eligible for export.")
        metadata, files, _ = current_package(self.store, toolkit_id)
        if metadata["digest"] != status["distribution_hash"]:
            raise ValueError("Published Toolkit distribution files changed during export.")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in files.items():
                archive.writestr(f"{metadata['name']}/{name}", content)
        return output.getvalue()


    def ensure_consistent(self, toolkit_id: str) -> dict[str, Any] | None:
        artifacts = render_artifacts(
            self.store, toolkit_id, resources=self.resources
        )
        if not _formal_tools(self.store, toolkit_id):
            return None
        expected = artifact_hash(artifacts)
        try:
            current = json.loads(self.build_path(toolkit_id).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            current = {}
        root = self.store.toolkit_dir(toolkit_id) / skill_name(toolkit_id)
        try:
            installed = {
                name: (root / name).read_text(encoding="utf-8") for name in artifacts
            }
            installed_hash = artifact_hash(installed)
        except OSError:
            installed = {}
            installed_hash = ""
        if (
            current.get("artifact_hash") != expected
            or installed_hash != expected
            or installed != artifacts
        ):
            self._validate(
                artifacts,
                tool_ids=[
                    str(item["tool"]["tool_id"])
                    for item in _formal_tools(self.store, toolkit_id)
                ],
            )
            return self._install(toolkit_id, artifacts)
        return current

    def recover(self, toolkit_id: str) -> None:
        path = self.journal_path(toolkit_id)
        if not path.is_file():
            return
        journal = json.loads(path.read_text(encoding="utf-8"))
        tool_id = str(journal["tool_id"])
        expected_code_hash = str(journal["code_hash"])
        formal = self.store.read_formal_slot(toolkit_id, tool_id)
        if formal and formal.get("code_hash") == expected_code_hash:
            snapshot_package(self.store, toolkit_id)
            self.store.clear_development_slot(
                toolkit_id,
                tool_id,
                expected_code_hash=expected_code_hash,
            )
        path.unlink(missing_ok=True)
