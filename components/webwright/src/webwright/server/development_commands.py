"""Model-independent commands for agent-authored Toolkit development."""
from __future__ import annotations

import json
from typing import Any

from webwright.server.adapter_v2 import current_package
from webwright.server.package_workspace import read_state
from webwright.server.toolkit_store import (
    _normalize_domains, _start_url_hostname, _validate_slug, validate_tool_slot,
)


class DevelopmentCommandError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


_FIELDS = {"code", "description", "parameters_schema", "result_schema", "risk_notice", "safety"}
_COMMON = {"toolkit_id", "tool_id"}
COMMAND_FIELDS = {
    "list": (set(), set()),
    "create": (_COMMON | {"allowed_domains", "goal", "start_url"}, {"expected_effect"}),
    "inspect": (_COMMON, set()),
    "validate": ({"tool_id"} | _FIELDS, set()),
    "save": (_COMMON | _FIELDS | {"expected_revision"}, set()),
    "build": ({"toolkit_id", "expected_revision"}, set()),
    "debug": (_COMMON | {"expected_revision", "expected_digest", "parameters", "confirmed"}, {"timeout_seconds"}),
    "debug-get": ({"debug_run_id"}, set()),
    "debug-cancel": ({"debug_run_id"}, set()),
}


def validate_submission(args: dict[str, Any]) -> dict[str, Any]:
    for key in ("code", "description", "risk_notice"):
        if not isinstance(args[key], str):
            raise ValueError(f"{key} must be a string.")
    if args["safety"] not in ("read", "write"):
        raise ValueError("safety must be read or write.")
    # Schemas are objects, not JSON strings. There is no legacy conversion path.
    for key in ("parameters_schema", "result_schema"):
        if not isinstance(args[key], dict) or args[key].get("type") != "object":
            raise ValueError(f"{key} must be an object schema.")
    return validate_tool_slot(args["tool_id"], {key: args[key] for key in _FIELDS})


class DevelopmentCommands:
    def __init__(self, store, manager, debug_store):
        self.store = store
        self.manager = manager
        self.debug_store = debug_store

    def execute(self, command: str, args: dict[str, Any]) -> dict[str, Any]:
        if command not in COMMAND_FIELDS:
            raise DevelopmentCommandError("UNKNOWN_COMMAND", "Unknown development command.")
        required, optional = COMMAND_FIELDS[command]
        if not isinstance(args, dict) or required - args.keys() or args.keys() - required - optional:
            raise ValueError("Arguments must contain exactly the documented required and optional fields.")
        for key in _COMMON & args.keys():
            if not isinstance(args[key], str):
                raise ValueError(f"{key} must be a string.")
            _validate_slug(args[key], field=key)
        if "expected_revision" in args and (type(args["expected_revision"]) is not int or args["expected_revision"] < 0):
            raise ValueError("expected_revision must be a non-negative integer.")
        if "debug_run_id" in args and not isinstance(args["debug_run_id"], str):
            raise ValueError("debug_run_id must be a string.")
        if command == "validate":
            return {"valid": True, "slot": validate_submission(args)}
        if command == "debug-get":
            return self.debug_store.read(args["debug_run_id"])
        if command == "debug-cancel":
            return self.manager.cancel_debug_run(args["debug_run_id"])
        if command == "debug":
            return self._debug(args)
        if command == "list":
            with self.store._slot_lock:
                return self._list()
        # Follow the manager -> store lock ordering used by the existing UI.
        with self.manager.lock, self.store._slot_lock:
            if command in {"save", "create"}:
                self.manager._ensure_not_busy_locked()
            if command == "create":
                return self._create(args)
            toolkit_id = args["toolkit_id"]
            self.store.get_toolkit(toolkit_id)
            state = read_state(self.store, toolkit_id)
            if "expected_revision" in args:
                self._check_revision(state, args)
            if command == "build":
                return self._package(toolkit_id, state)
            tool_id = args["tool_id"]
            self.store.get_tool(toolkit_id, tool_id)
            if command == "save":
                slot = validate_submission(args)
                current = self.store.read_development_slot(toolkit_id, tool_id)
                formal = self.store.read_formal_slot(toolkit_id, tool_id)
                # Preserve server-owned evidence context; do not trust agent-supplied run IDs.
                if current:
                    slot.update({key: current.get(key, "") for key in (
                        "source_exploration_id", "based_on_formal_hash", "debug_run_evidence_id")})
                elif formal:
                    slot["based_on_formal_hash"] = formal["code_hash"]
                self.store.write_development_slot(toolkit_id, tool_id, slot)
            return self._inspect(toolkit_id, tool_id)

    def _list(self):
        from webwright.server.adapter_v2 import adapter_name
        from webwright.server.package_workspace import read_package
        workspaces = []
        for toolkit in self.store.list_toolkits():
            toolkit_id = toolkit["toolkit_id"]
            state = read_state(self.store, toolkit_id)
            base = state.get("retained_base")
            retained = []
            if base:
                files, _ = read_package(self.store, toolkit_id, base["digest"])
                retained = [{"id": command["id"], "runtime": command["runtime"]}
                            for command in json.loads(files["manifest.json"])["commands"]]
            tools = [{**{key: tool.get(key) for key in ("tool_id", "name", "goal", "start_url", "expected_effect", "has_formal", "has_development")},
                      "command_id": tool["tool_id"].replace("_", "-"), "runtime": "wewright"}
                     for tool in self.store.list_tools(toolkit_id)]
            workspaces.append({
                "toolkit_id": toolkit_id, "adapter_id": adapter_name(self.store, toolkit_id),
                "allowed_domains": toolkit["allowed_domains"], "revision": state["revision"],
                "profile": state.get("profile"), "candidate_digest": state.get("candidate_digest"),
                "install_baseline_digest": state.get("install_baseline_digest") or state.get("last_applied_digest"),
                "retained_commands": retained, "tools": tools,
            })
        return {"workspaces": workspaces}

    @staticmethod
    def _check_revision(state, args):
        if state["revision"] != args["expected_revision"]:
            raise DevelopmentCommandError("STALE_REVISION", "Workspace changed; inspect it before submitting again.")

    def _create(self, args):
        toolkit_id, tool_id = args["toolkit_id"], args["tool_id"]
        if not isinstance(args["allowed_domains"], list) or any(not isinstance(v, str) for v in args["allowed_domains"]):
            raise ValueError("allowed_domains must be a string array.")
        domains = _normalize_domains(args["allowed_domains"])
        if not isinstance(args["goal"], str) or not args["goal"].strip():
            raise ValueError("goal is required.")
        if not isinstance(args.get("expected_effect", ""), str):
            raise ValueError("expected_effect must be a string.")
        if not isinstance(args["start_url"], str) or _start_url_hostname(args["start_url"]) not in domains:
            raise ValueError("start_url must belong to allowed_domains.")
        # Never overwrite an existing Tool or broaden an existing Toolkit's grants.
        try:
            self.store.find_tool(tool_id)
        except FileNotFoundError:
            pass
        else:
            raise DevelopmentCommandError("TOOL_EXISTS", "Tool already exists; inspect it instead.")
        try:
            toolkit = self.store.get_toolkit(toolkit_id)
        except FileNotFoundError:
            toolkit = self.store.create_toolkit(name=toolkit_id, allowed_domains=domains)
        if set(toolkit["allowed_domains"]) != set(domains):
            raise ValueError("Existing Toolkit allowed_domains differ; no permissions were changed.")
        # Imported commands are retained, not editable Toolkit slots. Reject the
        # collision before creating metadata, not only during package generation.
        state = read_state(self.store, toolkit_id)
        base = state.get("retained_base")
        if base:
            from webwright.server.package_workspace import read_package
            files, _ = read_package(self.store, toolkit_id, base["digest"])
            retained_ids = {item["id"] for item in json.loads(files["manifest.json"])["commands"]}
            if tool_id.replace("_", "-") in retained_ids:
                raise DevelopmentCommandError("RETAINED_COMMAND", "This command belongs to the retained Adapter package and cannot be recreated as a Toolkit Tool.")
        self.store.create_tool(toolkit_id, name=tool_id, goal=args["goal"], start_url=args["start_url"],
                               expected_effect=args.get("expected_effect", ""))
        return self._inspect(toolkit_id, tool_id)

    def _inspect(self, toolkit_id, tool_id):
        state = read_state(self.store, toolkit_id)
        return {"toolkit": self.store.get_toolkit(toolkit_id), "tool": self.store.get_tool(toolkit_id, tool_id),
                "revision": state["revision"], "candidate_digest": state["candidate_digest"],
                "development": self.store.read_development_slot(toolkit_id, tool_id),
                "formal": self.store.read_formal_slot(toolkit_id, tool_id),
                "recent_debug_runs": [{key: run.get(key) for key in (
                    "debug_run_id", "status", "distribution_hash", "created_at", "finished_at")}
                    for run in self.debug_store.list_for_tool(tool_id, toolkit_id)[:5]]}

    def _package(self, toolkit_id, state):
        metadata, files, root = current_package(self.store, toolkit_id)
        manifest = json.loads(files["manifest.json"])
        # save already creates the final-format content-addressed package. build
        # verifies and returns that exact snapshot, never installs or applies it.
        return {**metadata, "revision": state["revision"], "package_path": str(root),
                "manifest": manifest, "files": sorted(files), "installed": False,
                "runtime_verified": False}

    def _debug(self, args):
        if args["confirmed"] is not True:
            raise DevelopmentCommandError("CONFIRMATION_REQUIRED", "Debug executes authored code; explicit authorization is required.")
        if not isinstance(args["parameters"], dict):
            raise ValueError("parameters must be an object.")
        timeout = args.get("timeout_seconds", 60)
        if type(timeout) is not int or not 1 <= timeout <= 600:
            raise ValueError("timeout_seconds must be an integer between 1 and 600.")
        with self.store._slot_lock:
            self.store.get_tool(args["toolkit_id"], args["tool_id"])
            state = read_state(self.store, args["toolkit_id"])
            self._check_revision(state, args)
            if not isinstance(args["expected_digest"], str) or args["expected_digest"] != state["candidate_digest"]:
                raise DevelopmentCommandError("STALE_PACKAGE", "Candidate package changed; build it again.")
            if args["tool_id"] not in state["drafts"]:
                raise ValueError("Tool has no development version.")
        # The existing formal channel runs a snapshot of current_package through
        # an isolated WebCLI catalog (it does NOT publish). Its hash check closes
        # the interval between this inspection and snapshot creation.
        parameters = {**args["parameters"], "__confirmed": True}
        return self.manager.start_debug_run(
            toolkit_id=args["toolkit_id"], tool_id=args["tool_id"], channel="formal",
            parameters=parameters, timeout_seconds=timeout,
            expected_distribution_hash=args["expected_digest"],
        )
