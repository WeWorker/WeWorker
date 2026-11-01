"""Final-format package storage. JSON stores context and pointers, never source code."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from webwright.server.records import atomic_write_json


def package_container(store, toolkit_id, digest):
    path = store.toolkit_dir(toolkit_id) / "packages" / digest
    # A full digest plus a command name can exceed MAX_PATH on Windows.
    if os.name == "nt":
        value = str(path.resolve())
        if not value.startswith("\\\\?\\"):
            value = "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
        return Path(value)
    return path


def state_path(store, toolkit_id):
    return store.toolkit_dir(toolkit_id) / ".server" / "workspace.json"


def read_state(store, toolkit_id):
    path = state_path(store, toolkit_id)
    if not path.is_file():
        return {"storage_version": 1, "revision": 0, "contexts": {}, "drafts": [], "draft_revisions": {},
                "removed_tools": [], "applied_contexts": {}, "candidate_digest": None, "last_applied_digest": None}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(store, toolkit_id, state):
    state["revision"] += 1
    atomic_write_json(state_path(store, toolkit_id), state)


def read_package(store, toolkit_id, digest):
    from webwright.server.adapter_v2 import _DIGEST, package_digest
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise ValueError("Invalid Adapter package digest.")
    container = package_container(store, toolkit_id, digest)
    children = [path for path in container.iterdir() if path.is_dir()] if container.is_dir() else []
    if container.is_symlink() or len(children) != 1 or not children[0].is_dir():
        raise ValueError("Incomplete Adapter package snapshot.")
    root = children[0]
    paths = list(root.rglob("*"))
    if any(path.is_symlink() for path in paths) or root.is_symlink():
        raise ValueError("Adapter package contains a symbolic link.")
    files = {path.relative_to(root).as_posix(): path.read_bytes() for path in paths if path.is_file()}
    if package_digest(files) != digest:
        raise ValueError("Adapter package snapshot changed.")
    return files, root


def write_package(store, toolkit_id, files):
    from webwright.server.adapter_v2 import _safe_package_path, _check_package_identity, package_digest
    if any(not _safe_package_path(name) for name in files):
        raise ValueError("Adapter package contains an unsafe file path.")
    digest = package_digest(files)
    name = json.loads(files["manifest.json"])["name"]
    _check_package_identity(name, digest)
    container = package_container(store, toolkit_id, digest)
    container.parent.mkdir(parents=True, exist_ok=True)
    if container.exists():
        read_package(store, toolkit_id, digest)
        return digest
    # Publish only complete directories. An interrupted write must not poison an
    # immutable digest and prevent a later retry of the same development result.
    with tempfile.TemporaryDirectory(prefix=".package-", dir=container.parent) as temporary:
        staged = Path(temporary)
        for relative, content in files.items():
            target = staged / name / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        try:
            staged.rename(container)
        except OSError:
            if not container.exists():
                raise
            read_package(store, toolkit_id, digest)
    read_package(store, toolkit_id, digest)
    return digest


def slot_from_context(store, toolkit_id, digest, context):
    files, _ = read_package(store, toolkit_id, digest)
    raw = files[context["module"]][context["code_start"]:context["code_end"]]
    if "sha256:" + hashlib.sha256(raw).hexdigest() != context["code_hash"]:
        raise ValueError("Adapter command source changed.")
    return {key: value for key, value in context.items() if key not in {"module", "code_start", "code_end", "template_version"}} | {"code": raw.decode("utf-8")}


def read_slot(store, toolkit_id, tool_id, *, applied=False):
    state = read_state(store, toolkit_id)
    contexts = state["applied_contexts"] if applied else state["contexts"]
    if tool_id not in contexts or (not applied and tool_id not in state["drafts"]):
        return None
    return slot_from_context(store, toolkit_id, state["last_applied_digest"] if applied else state["candidate_digest"], contexts[tool_id])


def build_candidate(store, toolkit_id, state, slots):
    from webwright.server.adapter_v2 import _command_source, adapter_name
    toolkit = store.get_toolkit(toolkit_id)
    base = state.get("retained_base")
    files = read_package(store, toolkit_id, base["digest"])[0] if base else {}
    manifest = json.loads(files["manifest.json"]) if base else {
        "schema_version": 2, "name": adapter_name(store, toolkit_id), "version": "1.0.0",
        "description": toolkit.get("description") or toolkit["name"],
        "runtime_allowed_hosts": toolkit["allowed_domains"], "commands": [],
    }
    if state.get("last_applied_digest") or base:
        previous = read_package(store, toolkit_id, state.get("last_applied_digest") or base["digest"])[0]
        version = json.loads(previous["manifest.json"])["version"]
        major, minor, patch = (int(part) for part in version.split("-")[0].split("+")[0].split("."))
        manifest["version"] = f"{major}.{minor}.{patch + 1}"
    manifest["runtime_allowed_hosts"] = list(dict.fromkeys([*(manifest.get("runtime_allowed_hosts") or []), *toolkit["allowed_domains"]]))
    existing = {command["id"] for command in manifest["commands"]}
    contexts = {}
    for tool_id, slot in sorted(slots.items()):
        tool = store.get_tool(toolkit_id, tool_id)
        command_id = tool_id.replace("_", "-")
        if command_id in existing:
            raise ValueError(f"Adapter command already exists: {command_id}")
        module = f"wewright/commands/{command_id}.py"
        source = _command_source(toolkit_id=toolkit_id, tool_id=tool_id, toolkit=toolkit, tool=tool, slot=slot)
        compile(source, module, "exec")
        raw = slot["code"].encode("utf-8")
        # Obtain the prefix from the same template with an empty function body.
        # The model source itself is copied verbatim, never parsed and reprinted.
        marker = "__WEWORKER_SOURCE_BOUNDARY__"
        template = _command_source(toolkit_id=toolkit_id, tool_id=tool_id, toolkit=toolkit, tool=tool, slot={**slot, "code": marker})
        start = len(template.split(marker, 1)[0].encode("utf-8"))
        files[module] = source.encode("utf-8")
        contexts[tool_id] = {key: value for key, value in slot.items() if key != "code"} | {
            "module": module, "code_start": start, "code_end": start + len(raw), "template_version": 1}
        manifest["commands"].append({"id": command_id, "runtime": "wewright", "module": module,
            "description": slot.get("description") or tool.get("goal") or command_id,
            "schema": slot["parameters_schema"], "safety": "read"})
        existing.add(command_id)
    if not manifest["commands"]:
        state.update(candidate_digest=None, contexts={})
        return
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    state.update(candidate_digest=write_package(store, toolkit_id, files), contexts=contexts)


def candidate_slots(store, toolkit_id, state):
    if not state.get("candidate_digest"):
        return {}
    return {tool_id: slot_from_context(store, toolkit_id, state["candidate_digest"], context)
            for tool_id, context in state["contexts"].items()}


def write_slot(store, toolkit_id, tool_id, slot):
    state = read_state(store, toolkit_id)
    slots = candidate_slots(store, toolkit_id, state)
    slots[tool_id] = slot
    state["drafts"] = sorted(set(state["drafts"]) | {tool_id})
    state["draft_revisions"][tool_id] = state["revision"] + 1
    build_candidate(store, toolkit_id, state, slots)
    save_state(store, toolkit_id, state)


def discard_slot(store, toolkit_id, tool_id):
    state = read_state(store, toolkit_id)
    slots = candidate_slots(store, toolkit_id, state)
    formal = read_slot(store, toolkit_id, tool_id, applied=True)
    if formal:
        slots[tool_id] = formal
    else:
        slots.pop(tool_id, None)
    state["drafts"] = [item for item in state["drafts"] if item != tool_id]
    state["draft_revisions"].pop(tool_id, None)
    if not state["drafts"] and not state["removed_tools"] and state.get("last_applied_digest"):
        state.update(candidate_digest=state["last_applied_digest"], contexts=copy.deepcopy(state["applied_contexts"]))
    else:
        build_candidate(store, toolkit_id, state, slots)
    save_state(store, toolkit_id, state)


def prepare_apply(store, toolkit_id):
    with store._slot_lock:
        state = read_state(store, toolkit_id)
        digest = state["candidate_digest"]
        read_package(store, toolkit_id, digest)
        operation_id = digest + "-" + str(state["revision"])
        path = store.toolkit_dir(toolkit_id) / ".server" / "apply-operations" / f"{operation_id}.json"
        if not path.exists():
            atomic_write_json(path, {"digest": digest, "contexts": state["contexts"], "draft_revisions": state["draft_revisions"], "removed_tools": state["removed_tools"], "phase": "prepared"})
        return {**state, "operation_id": operation_id}


def acknowledge_apply(store, toolkit_id, *, digest, revision, profile, operation_id):
    with store._slot_lock:
        read_package(store, toolkit_id, digest)
        if not isinstance(operation_id, str) or not re.fullmatch(r"[a-f0-9]{64}-[0-9]+", operation_id):
            raise ValueError("Invalid installation operation.")
        path = store.toolkit_dir(toolkit_id) / ".server" / "apply-operations" / f"{operation_id}.json"
        operation = json.loads(path.read_text(encoding="utf-8"))
        if operation["digest"] != digest:
            raise ValueError("Installation operation digest changed.")
        state = read_state(store, toolkit_id)
        if state.get("profile") and state["profile"] != profile:
            raise ValueError("Adapter workspace belongs to another build profile.")
        if state.get("host_revision", -1) > revision:
            raise ValueError("Stale Adapter installation acknowledgement.")
        state.update(last_applied_digest=digest, applied_contexts=operation["contexts"],
                     install_baseline_digest=digest, host_revision=revision, profile=profile)
        state["removed_tools"] = [tool_id for tool_id in state["removed_tools"] if tool_id not in operation["removed_tools"]]
        state["drafts"] = [tool_id for tool_id in state["drafts"]
            if state["draft_revisions"].get(tool_id) != operation["draft_revisions"].get(tool_id)]
        state["draft_revisions"] = {key: value for key, value in state["draft_revisions"].items() if key in state["drafts"]}
        if state["candidate_digest"] != digest:
            build_candidate(store, toolkit_id, state, candidate_slots(store, toolkit_id, state))
        save_state(store, toolkit_id, state)
        atomic_write_json(path, {**operation, "phase": "installed", "host_revision": revision})
        return {"digest": digest, "revision": revision}


def remove_tool_context(store, toolkit_id, tool_id, *, host_uninstalled=False, host_package=None, host_revision=None):
    import base64
    from webwright.server.adapter_v2 import _safe_package_path
    state = read_state(store, toolkit_id)
    slots = candidate_slots(store, toolkit_id, state)
    slots.pop(tool_id, None)
    state["drafts"] = [item for item in state["drafts"] if item != tool_id]
    state["draft_revisions"].pop(tool_id, None)
    if host_uninstalled:
        state["removed_tools"] = [item for item in state["removed_tools"] if item != tool_id]
        state["applied_contexts"].pop(tool_id, None)
        state["last_applied_digest"] = None
        state["install_baseline_digest"] = state["retained_base"]["digest"] if state.get("retained_base") else None
        if isinstance(host_revision, int) and not isinstance(host_revision, bool) and host_revision >= 0:
            state["host_revision"] = host_revision
    elif host_package:
        raw_files = host_package.get("files")
        if not isinstance(raw_files, dict) or not 1 <= len(raw_files) <= 512 or any(not _safe_package_path(name) or not isinstance(value, str) for name, value in raw_files.items()):
            raise ValueError("Invalid host Adapter package.")
        decoded = {name: base64.b64decode(value, validate=True) for name, value in raw_files.items()}
        if sum(map(len, decoded.values())) > 32 * 1024 * 1024:
            raise ValueError("Adapter package exceeds the size limit.")
        digest = write_package(store, toolkit_id, decoded)
        if digest != host_package.get("digest"):
            raise ValueError("Host Adapter package digest mismatch.")
        state["removed_tools"] = [item for item in state["removed_tools"] if item != tool_id]
        state["applied_contexts"].pop(tool_id, None)
        state["last_applied_digest"] = digest
        state["install_baseline_digest"] = digest
        if isinstance(host_revision, int) and not isinstance(host_revision, bool) and host_revision >= 0:
            state["host_revision"] = host_revision
    else:
        if tool_id in state["applied_contexts"]:
            state["removed_tools"] = sorted(set(state["removed_tools"]) | {tool_id})
        state["applied_contexts"].pop(tool_id, None)
    if not state["drafts"] and not state["removed_tools"] and state.get("last_applied_digest"):
        state.update(candidate_digest=state["last_applied_digest"], contexts=copy.deepcopy(state["applied_contexts"]))
    else:
        build_candidate(store, toolkit_id, state, slots)
    save_state(store, toolkit_id, state)


def update_metadata(store, toolkit_id, path, payload, tool_id=None):
    """Regenerate the candidate when execution metadata changes, retaining applied bytes."""
    with store._slot_lock:
        original = json.loads(path.read_text(encoding="utf-8"))
        state = read_state(store, toolkit_id)
        slots = candidate_slots(store, toolkit_id, state)
        atomic_write_json(path, payload)
        try:
            if slots:
                changed = {tool_id} & slots.keys() if tool_id else set(slots)
                state["drafts"] = sorted(set(state["drafts"]) | changed)
                for changed_id in changed:
                    state["draft_revisions"][changed_id] = state["revision"] + 1
                build_candidate(store, toolkit_id, state, slots)
                save_state(store, toolkit_id, state)
        except Exception:
            atomic_write_json(path, original)
            raise


def reconcile_installation(store, toolkit_id, *, digest, revision, profile):
    """Recover a host commit whose acknowledgement was lost, including newer drafts."""
    from webwright.server.adapter_v2 import _DIGEST
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise ValueError("Invalid installed package digest.")
    with store._slot_lock:
        root = store.toolkit_dir(toolkit_id) / ".server" / "apply-operations"
        operations = [path for path in root.glob(digest + "-*.json")
                      if re.fullmatch(r"[a-f0-9]{64}-[0-9]+", path.stem)]
        if not operations:
            return {"reconciled": False}
        operation = max(operations, key=lambda path: int(path.stem.rsplit("-", 1)[1]))
        acknowledge_apply(store, toolkit_id, digest=digest, revision=revision,
                          profile=profile, operation_id=operation.stem)
        return {"reconciled": True}
