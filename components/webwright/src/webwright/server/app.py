from __future__ import annotations

import io
import base64
import json
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_file,
    stream_with_context,
)

from webwright.paths import WebwrightPaths
from webwright.resources import BundledResources
from webwright.runtime_identity import RuntimeIdentity
from webwright.runtime_launcher import RuntimeLauncher
from webwright.server.artifacts import (
    read_messages,
    read_script,
    read_steps,
    resolve_task_file,
    task_artifact_summary,
)
from webwright.server.browser import (
    DEFAULT_CDP_URL,
    browser_match,
    browser_open,
    browser_status,
    browser_tabs,
)
from webwright.server.debug_store import DebugRunStore
from webwright.server.adapter_v2 import bind_base, current_package, read_base
from webwright.server.development_store import DevelopmentRunStore
from webwright.server.publisher import ToolkitPublisher, skill_name
from webwright.server.process_manager import BusyError, InvalidStateError, NotFoundError, ProcessManager
from webwright.server.records import TaskStore
from webwright.server.toolkit_store import ToolkitStore
from webwright.server.status import (
    DEBUG_RUN_DOC_EVENTS,
    DEBUG_RUN_STATUS_EVENTS,
    DEVELOPMENT_RUN_DOC_EVENTS,
    DEVELOPMENT_RUN_STATUS_EVENTS,
    EXPLORATION_DOC_EVENTS,
    EXPLORATION_STATUS_EVENTS,
    REPLAY_DOC_EVENTS,
    REPLAY_STATUS_EVENTS,
    REPLAY_STATUS_VALUES,
    TASK_DOC_EVENTS,
    TASK_STATUS_EVENTS,
    TASK_STATUS_VALUES,
    TERMINAL_REPLAY_STATUSES,
    TERMINAL_DEBUG_RUN_STATUSES,
    TERMINAL_DEVELOPMENT_RUN_STATUSES,
    STOP_TASK_EVENT_STATUSES,
    TaskStatus,
)


def _inline_code_list(values: tuple[str, ...]) -> str:
    return ", ".join(f"`{value}`" for value in values)


def _openapi_spec() -> dict[str, Any]:
    def op(summary: str) -> dict[str, Any]:
        return {"summary": summary, "responses": {"200": {"description": "OK"}}}

    return {
        "openapi": "3.1.0",
        "info": {
            "title": "Webwright Local CDP HTTP API",
            "version": "0.1.0",
            "description": "Local-only HTTP API for running Webwright tasks against a headed Chrome/Edge browser over CDP.",
        },
        "servers": [{"url": "http://127.0.0.1:8765"}],
        "paths": {
            "/api/health": {"get": op("Server health")},
            "/api/docs": {"get": op("Markdown API documentation")},
            "/api/openapi.json": {"get": op("OpenAPI document")},
            "/api/browser/status": {"get": op("Check local CDP browser availability")},
            "/api/browser/open": {"post": op("Open or focus the Agent browser, optionally at a URL")},
            "/api/browser/match": {"get": op("Match an open Agent browser tab by URL")},
            "/api/browser/tabs": {"get": op("List local CDP page targets")},
            "/api/activity": {"get": op("Get the active globally exclusive run")},
            "/api/toolkits": {
                "get": op("List Toolkits"),
                "post": op("Create a Toolkit"),
            },
            "/api/toolkits/{toolkit_id}": {
                "get": op("Get a Toolkit"),
                "put": op("Update a Toolkit"),
                "delete": op("Delete an empty Toolkit"),
            },
            "/api/toolkits/{toolkit_id}/tools": {
                "get": op("List Tools in a Toolkit"),
                "post": op("Create a Tool"),
            },
            "/api/toolkits/{toolkit_id}/tools/{tool_id}": {
                "get": op("Get a Tool"),
                "put": op("Update a Tool"),
                "delete": op("Delete a Tool"),
            },
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/formal": {
                "get": op("Get the formal Tool slot")
            },
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development": {
                "get": op("Get the development Tool slot"),
                "put": op("Replace the development Tool code"),
                "delete": op("Discard the development Tool slot"),
            },
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/start": {"post": op("Start Tool development")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/messages": {"post": op("Continue Tool development")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/cancel": {"post": op("Cancel Tool development")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/reset-from-formal": {"post": op("Reset development from formal")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/restart-from-exploration": {"post": op("Restart development from a succeeded Exploration")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/development/events": {"get": op("Stream Tool development events")},
            "/api/development-runs/{development_run_id}": {"get": op("Get Development Run details")},
            "/api/development-runs/{development_run_id}/files/{path}": {"get": op("Read a Development Run artifact")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/publish": {"post": op("Publish the development Tool")},
            "/api/toolkits/{toolkit_id}/export-status": {"get": op("Get v2 Adapter package export eligibility")},
            "/api/toolkits/{toolkit_id}/export": {"get": op("Download the verified v2 Adapter ZIP")},
            "/api/toolkits/{toolkit_id}/bind-adapter": {"post": op("Bind a host-validated v2 Adapter baseline in embedded mode")},
            "/api/toolkits/{toolkit_id}/adapter-base": {"get": op("Read the bound Adapter identity in embedded mode")},
            "/api/toolkits/{toolkit_id}/v2-package": {"get": op("Read the verified complete v2 package in embedded mode")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/debug-runs": {
                "get": op("List Debug Runs"),
                "post": op("Create and start a Debug Run"),
            },
            "/api/debug-runs/{debug_run_id}": {"get": op("Get Debug Run details")},
            "/api/debug-runs/{debug_run_id}/cancel": {"post": op("Cancel a Debug Run")},
            "/api/debug-runs/{debug_run_id}/events": {"get": op("Stream Debug Run events")},
            "/api/debug-runs/{debug_run_id}/files/{path}": {"get": op("Read a Debug Run artifact")},
            "/api/toolkits/{toolkit_id}/tools/{tool_id}/explorations": {
                "get": op("List Tool-owned Explorations"),
                "post": op("Create and start a Tool-owned Exploration"),
            },
            "/api/explorations/{exploration_id}": {
                "get": op("Get Exploration details")
            },
            "/api/explorations/{exploration_id}/events": {
                "get": op("Stream Exploration events with SSE")
            },
            "/api/explorations/{exploration_id}/steps": {
                "get": op("List Exploration steps")
            },
            "/api/explorations/{exploration_id}/timeline": {
                "get": op("Get the user-facing Exploration timeline")
            },
            "/api/explorations/{exploration_id}/messages": {
                "get": op("Get Exploration messages"),
                "post": op("Add an Exploration follow-up"),
            },
            "/api/explorations/{exploration_id}/pause": {
                "post": op("Pause an Exploration")
            },
            "/api/explorations/{exploration_id}/resume": {
                "post": op("Resume an Exploration")
            },
            "/api/explorations/{exploration_id}/cancel": {
                "post": op("Cancel an Exploration")
            },
            "/api/explorations/{exploration_id}/replay": {
                "post": op("Replay Exploration steps")
            },
            "/api/explorations/{exploration_id}/files/{path}": {
                "get": op("Read an Exploration artifact file")
            },
            "/api/tasks": {
                "get": op("List tasks"),
                "post": op("Create and start a Webwright task"),
            },
            "/api/tasks/{task_id}": {"get": op("Get task details")},
            "/api/tasks/{task_id}/events": {"get": op("Stream task events with SSE")},
            "/api/tasks/{task_id}/steps": {"get": op("List generated steps")},
            "/api/tasks/{task_id}/steps/{step}": {"get": op("Get one generated step")},
            "/api/tasks/{task_id}/script": {"get": op("Get accumulated script.py")},
            "/api/tasks/{task_id}/messages": {
                "get": op("Get UI-safe trajectory messages"),
                "post": op("Add a follow-up instruction and continue"),
            },
            "/api/tasks/{task_id}/pause": {"post": op("Request cooperative pause")},
            "/api/tasks/{task_id}/resume": {"post": op("Resume a waiting task")},
            "/api/tasks/{task_id}/cancel": {"post": op("Cancel a task")},
            "/api/tasks/{task_id}/replay": {"post": op("Start replaying generated steps")},
            "/api/tasks/{task_id}/files/{path}": {"get": op("Read a task artifact file")},
            "/api/replays/{replay_id}": {"get": op("Get replay status")},
            "/api/replays/{replay_id}/events": {"get": op("Stream replay events with SSE")},
            "/api/replays/{replay_id}/cancel": {"post": op("Cancel a replay")},
        },
    }


def _markdown_docs(base_url: str) -> str:
    task_statuses = _inline_code_list(TASK_STATUS_VALUES)
    replay_statuses = _inline_code_list(REPLAY_STATUS_VALUES)
    task_events = _inline_code_list(TASK_DOC_EVENTS)
    exploration_events = _inline_code_list(EXPLORATION_DOC_EVENTS)
    replay_events = _inline_code_list(REPLAY_DOC_EVENTS)
    debug_run_events = _inline_code_list(DEBUG_RUN_DOC_EVENTS)
    development_events = _inline_code_list(DEVELOPMENT_RUN_DOC_EVENTS)
    return f"""# Webwright Local CDP HTTP API

Base URL: `{base_url}`

## Docs

- `GET /api/docs` - this Markdown document
- `GET /api/openapi.json` - OpenAPI-style endpoint index
- `GET /api/health` - server health

## Browser

- `GET /api/browser/status` - check whether `http://127.0.0.1:9222` is reachable; tasks may auto-start Chrome/Edge.
- `POST /api/browser/open` - open or focus the Agent browser. Optional body: `{{"url":"https://example.com/"}}` opens or reuses that exact page.
- `GET /api/browser/match?url=https://example.com` - find the first exact open tab for a URL.
- `GET /api/browser/tabs` - list CDP page targets.

## Model

Webwright receives the active model from WeWorker when each model Task starts.
It has no independent model configuration API or persistent model store.

## Toolkits and Tools

- `GET /api/toolkits` - list Toolkits.
- `POST /api/toolkits` - create a Toolkit.
  Body: `{{"name":"blog_admin","description":"...","allowed_domains":["blog.example.com"]}}`
- `GET /api/toolkits/{{toolkit_id}}` - get one Toolkit.
- `PUT /api/toolkits/{{toolkit_id}}` - update description or allowed domains.
- `DELETE /api/toolkits/{{toolkit_id}}` - delete an empty Toolkit.
- `GET /api/toolkits/{{toolkit_id}}/tools` - list Tools.
- `POST /api/toolkits/{{toolkit_id}}/tools` - create a Tool.
  Body: `{{"name":"search_blog","goal":"...","start_url":"https://blog.example.com/","expected_effect":"..."}}`
- `GET /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}` - get one Tool.
- `PUT /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}` - update Tool definition fields.
- `DELETE /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}` - delete a Tool.
- `GET /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/formal` - get the formal slot.
- `GET /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development` - get the development slot.
- `PUT /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development` - replace only the current development code after validating the expected code hash and existing Tool contract.
  Body: `{{"code":"async def search_blog(ctx): ...","expected_code_hash":"sha256:..."}}`
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development/start` - start the first development run.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development/messages` - continue development with an instruction and optional selected Debug Run.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development/cancel` - cancel active development.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development/reset-from-formal` - overwrite development from formal.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development/restart-from-exploration` - clear development and rebuild only from one succeeded Tool-owned Exploration.
- `DELETE /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development` - discard development.
- `GET /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/development/events` - latest Development Run SSE.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/publish` - publish after a matching succeeded Debug Run.
- `GET /api/toolkits/{{toolkit_id}}/export-status` - get current formal artifact hash, per-Tool verification, and export eligibility.
- `GET /api/toolkits/{{toolkit_id}}/export` - download the verified Toolkit ZIP after server-side revalidation.
- `GET /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/debug-runs` - list Debug Runs.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/debug-runs` - run the formal or development slot.
  Body: `{{"channel":"development","parameters":{{}},"timeout_seconds":60}}`
- `GET /api/debug-runs/{{debug_run_id}}` - get one Debug Run.
- `POST /api/debug-runs/{{debug_run_id}}/cancel` - cancel a running Debug Run.
- `GET /api/debug-runs/{{debug_run_id}}/events` - Debug Run SSE stream.
- `GET /api/debug-runs/{{debug_run_id}}/files/{{path}}` - read logs or screenshot artifacts.

## Explorations

- `GET /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/explorations` - list one Tool's Explorations.
- `POST /api/toolkits/{{toolkit_id}}/tools/{{tool_id}}/explorations` - create and start an Exploration.
  Body: `{{"instruction":"optional supplemental instruction"}}`
- `GET /api/explorations/{{exploration_id}}` - get Exploration details.
- `GET /api/explorations/{{exploration_id}}/events` - Exploration SSE stream.
- `GET /api/explorations/{{exploration_id}}/steps` - list Exploration steps.
- `GET /api/explorations/{{exploration_id}}/timeline` - get the user-facing Agent conversation timeline.
- `GET /api/explorations/{{exploration_id}}/messages` - get internal diagnostic trajectory messages.
- `POST /api/explorations/{{exploration_id}}/messages` - add a follow-up.
- `POST /api/explorations/{{exploration_id}}/pause` - request cooperative pause.
- `POST /api/explorations/{{exploration_id}}/resume` - resume after waiting for user.
- `POST /api/explorations/{{exploration_id}}/cancel` - cancel an Exploration.
- `POST /api/explorations/{{exploration_id}}/replay` - replay generated steps.
- `GET /api/explorations/{{exploration_id}}/files/{{path}}` - read an Exploration artifact.

## Tasks

- `POST /api/tasks` - create and start a task.
  Body: `{{"start_url":"https://example.com","instruction":"...","target_id":"optional","task_id":"optional","title":"optional"}}`
- `GET /api/tasks?status=running&limit=50` - list tasks.
- `GET /api/tasks/{{task_id}}` - get task details.
- `GET /api/tasks/{{task_id}}/events` - task SSE stream.
- `GET /api/tasks/{{task_id}}/steps` - list generated steps.
- `GET /api/tasks/{{task_id}}/steps/{{step}}` - get one step.
- `GET /api/tasks/{{task_id}}/script` - get accumulated `script.py`.
- `GET /api/tasks/{{task_id}}/messages` - get UI-safe trajectory messages.
- `POST /api/tasks/{{task_id}}/messages` - continue with follow-up.
  Body: `{{"content":"..."}}`
- `POST /api/tasks/{{task_id}}/pause` - request cooperative pause.
  Body: `{{"reason":"optional"}}`; response status is `{TaskStatus.PAUSE_REQUESTED.value}`.
- `POST /api/tasks/{{task_id}}/resume` - resume after status becomes `{TaskStatus.WAITING_FOR_USER.value}`.
  Body: `{{"note":"optional"}}`
- `POST /api/tasks/{{task_id}}/cancel?force=false` - cancel cooperatively; `force=true` terminates the child process.
- `GET /api/tasks/{{task_id}}/files/{{path}}` - read an artifact under the task output directory.

## Replay

- `POST /api/tasks/{{task_id}}/replay` - replay generated step files.
  Body: `{{"from_step":1,"to_step":4,"new_tab":false,"delay_ms":500}}`.
  `new_tab=true` always creates a new tab; `false` reuses the task's active target
  and creates a new tab only when reuse is unavailable.
- `GET /api/replays/{{replay_id}}` - get replay status.
- `GET /api/replays/{{replay_id}}/events` - replay SSE stream.
- `POST /api/replays/{{replay_id}}/cancel` - cancel replay.

## Task Statuses

{task_statuses}

## Replay Statuses

{replay_statuses}

## SSE Events

Task events: {task_events}

Exploration events: {exploration_events}

Replay events: {replay_events}

Debug Run events: {debug_run_events}

Development events: {development_events}
"""


def _error(code: str, message: str, status: int):
    response = jsonify({"error": {"code": code, "message": message}})
    response.status_code = status
    return response


def _request_json() -> dict[str, Any]:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


def _task_view(task: dict[str, Any]) -> dict[str, Any]:
    task_id = str(task.get("task_id", ""))
    output_dir = Path(str(task.get("output_dir", ""))).expanduser()
    summary = task_artifact_summary(task_id, output_dir) if output_dir else {}
    final_response = task.get("final_response") or summary.get("final_response", "")
    return {
        "task_id": task_id,
        "title": task.get("title", ""),
        "instruction": task.get("instruction", ""),
        "start_url": task.get("start_url", ""),
        "status": task.get("status", ""),
        "current_step": summary.get("current_step", task.get("current_step", 0)),
        "last_url": summary.get("last_url", ""),
        "last_title": summary.get("last_title", ""),
        "last_screenshot_url": summary.get("last_screenshot_url", ""),
        "final_response": final_response,
        "error": task.get("error", ""),
        "error_code": task.get("error_code", ""),
        "error_stage": task.get("error_stage", ""),
        "created_at": task.get("created_at", ""),
        "updated_at": task.get("updated_at", ""),
        "activity_type": task.get("activity_type", "task"),
        "toolkit_id": task.get("toolkit_id", ""),
        "tool_id": task.get("tool_id", ""),
    }


def _exploration_view(task: dict[str, Any]) -> dict[str, Any]:
    view = _task_view(task)
    exploration_id = view["task_id"]
    screenshot_url = str(view["last_screenshot_url"] or "").replace(
        f"/api/tasks/{exploration_id}/files/",
        f"/api/explorations/{exploration_id}/files/",
    )
    status = view["status"]
    active_issue = None
    if status == TaskStatus.PAUSE_REQUESTED.value:
        active_issue = {
            "type": "pause_requested",
            "message": "等待当前步骤完成后暂停；如步骤长时间无响应，可取消本次探索。",
        }
    elif status == TaskStatus.WAITING_FOR_USER.value:
        active_issue = {
            "type": "user_takeover_required",
            "message": "请在 Agent 浏览器中完成所需操作，然后输入指令继续探索。",
        }
    elif status == TaskStatus.FAILED.value:
        active_issue = {
            "type": "failed",
            "message": view["error"] or "探索无法继续，已终止。",
        }
    return {
        "exploration_id": exploration_id,
        "toolkit_id": view["toolkit_id"],
        "tool_id": view["tool_id"],
        "instruction": view["instruction"],
        "status": view["status"],
        "completed_goal": view["status"] == TaskStatus.SUCCEEDED.value,
        "step_count": view["current_step"],
        "final_url": view["last_url"],
        "final_title": view["last_title"],
        "last_screenshot_url": screenshot_url,
        "final_response": view["final_response"],
        "error": view["error"],
        "error_code": view["error_code"],
        "error_stage": view["error_stage"],
        "active_issue": active_issue,
        "created_at": view["created_at"],
        "updated_at": view["updated_at"],
    }


def _timeline_observation(step: dict[str, Any]) -> dict[str, Any]:
    observation = step.get("observation")
    observation = observation if isinstance(observation, dict) else {}
    return {
        "title": str(step.get("title") or observation.get("title") or ""),
        "url": str(step.get("url") or observation.get("url") or ""),
        "success": bool(observation.get("success", step.get("status") != "error")),
        "screenshot_url": str(step.get("screenshot_url") or ""),
    }


def _exploration_timeline(
    task: dict[str, Any],
    steps: list[dict[str, Any]],
    user_turns: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    supplement = str(task.get("initial_supplement") or "").strip()
    if supplement:
        items.append(
            {
                "id": "initial_supplement",
                "type": "user",
                "subtype": "initial_supplement",
                "content": supplement,
                "after_step": 0,
                "created_at": task.get("created_at", ""),
            }
        )

    turns_by_step: dict[int, list[dict[str, Any]]] = {}
    for turn in user_turns:
        if not isinstance(turn, dict):
            continue
        after_step = max(int(turn.get("after_step") or 0), 0)
        turns_by_step.setdefault(after_step, []).append(turn)

    def append_turns(after_step: int) -> None:
        for turn in turns_by_step.pop(after_step, []):
            content = str(turn.get("content") or "").strip()
            if not content:
                continue
            items.append(
                {
                    "id": str(turn.get("turn_id") or f"turn_{after_step}_{len(items)}"),
                    "type": "user",
                    "subtype": "followup",
                    "content": content,
                    "after_step": after_step,
                    "created_at": turn.get("created_at", ""),
                }
            )

    append_turns(0)
    for step in sorted(steps, key=lambda item: int(item.get("step") or 0)):
        step_number = int(step.get("step") or 0)
        items.append(
            {
                "id": f"step_{step_number}",
                "type": "agent_step",
                "step": step_number,
                "status": step.get("status", ""),
                "done": bool(step.get("done", False)),
                "thought": str(step.get("thought") or ""),
                "code": str(step.get("code") or ""),
                "observation": _timeline_observation(step),
            }
        )
        append_turns(step_number)

    for after_step in sorted(turns_by_step):
        append_turns(after_step)

    detail = _exploration_view(task)
    if detail["status"] == TaskStatus.SUCCEEDED.value and detail["final_response"]:
        items.append(
            {
                "id": "final",
                "type": "agent_final",
                "content": detail["final_response"],
            }
        )
    return items


def _step_list_view(step: dict[str, Any]) -> dict[str, Any]:
    return {
        "step": step.get("step"),
        "thought": step.get("thought", ""),
        "code_type": "python_code",
        "code": step.get("code", ""),
        "status": step.get("status", ""),
        "done": step.get("done", False),
        "final_response": step.get("final_response", ""),
        "url": step.get("url", ""),
        "title": step.get("title", ""),
        "screenshot_url": step.get("screenshot_url", ""),
    }


def _exploration_step_view(
    exploration_id: str, step: dict[str, Any]
) -> dict[str, Any]:
    view = _step_list_view(step)
    view["screenshot_url"] = str(view["screenshot_url"] or "").replace(
        f"/api/tasks/{exploration_id}/files/",
        f"/api/explorations/{exploration_id}/files/",
    )
    return view


def _bool_query(name: str, *, default: bool = False) -> bool:
    raw = request.args.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def create_app(
    *,
    paths: WebwrightPaths | None = None,
    cdp_url: str = DEFAULT_CDP_URL,
    store: TaskStore | None = None,
    process_manager: ProcessManager | None = None,
    toolkit_store: ToolkitStore | None = None,
    debug_store: DebugRunStore | None = None,
    development_store: DevelopmentRunStore | None = None,
    publisher: ToolkitPublisher | None = None,
    runtime_identity: dict[str, str] | None = None,
    bind_host: str = "127.0.0.1",
    bind_port: int | None = None,
    weworker_user_files_dir: Path | str | None = None,
) -> Flask:
    app = Flask(__name__)
    resources = BundledResources()
    paths = (paths or WebwrightPaths.resolve()).ensure()
    task_store = store or TaskStore(paths.tasks)
    toolkits = toolkit_store or ToolkitStore(paths.toolkits)
    debug_runs = debug_store or DebugRunStore(toolkits)
    development_runs = development_store or DevelopmentRunStore(toolkits)
    launcher = RuntimeLauncher()
    toolkit_publisher = publisher or ToolkitPublisher(
        toolkits, debug_runs, launcher=launcher, resources=resources
    )
    manager = process_manager or ProcessManager(
        store=task_store,
        cdp_url=cdp_url,
        toolkit_store=toolkits,
        debug_store=debug_runs,
        development_store=development_runs,
        launcher=launcher,
        runtime_environment={"WEBWRIGHT_HOME": str(paths.home)},
    )
    if isinstance(manager, ProcessManager) and manager.toolkit_store is None:
        manager.toolkit_store = toolkits
    if isinstance(manager, ProcessManager) and manager.debug_store is None:
        manager.debug_store = debug_runs
    if isinstance(manager, ProcessManager) and manager.development_store is None:
        manager.development_store = development_runs
    if isinstance(manager, ProcessManager):
        manager.runtime_environment["WEBWRIGHT_HOME"] = str(paths.home)
    debug_runs.recover_incomplete()
    development_runs.recover_incomplete()
    for toolkit in toolkits.list_toolkits():
        toolkit_publisher.recover(str(toolkit["toolkit_id"]))

    app.config["WEBWRIGHT_TASK_STORE"] = task_store
    app.config["WEBWRIGHT_PROCESS_MANAGER"] = manager
    app.config["WEBWRIGHT_TOOLKIT_STORE"] = toolkits
    app.config["WEBWRIGHT_DEBUG_STORE"] = debug_runs
    app.config["WEBWRIGHT_DEVELOPMENT_STORE"] = development_runs
    app.config["WEBWRIGHT_PUBLISHER"] = toolkit_publisher
    app.config["WEBWRIGHT_CDP_URL"] = cdp_url
    app.config["WEBWRIGHT_PATHS"] = paths
    app.config["WEBWRIGHT_RUNTIME_IDENTITY"] = (
        dict(runtime_identity)
        if runtime_identity is not None
        else RuntimeIdentity.resolve().as_health_fields()
    )
    app.config["WEBWRIGHT_BIND_HOST"] = bind_host
    app.config["WEWORKER_EXPLORATION_INSTANCE_ID"] = os.environ.get(
        "WEWORKER_EXPLORATION_INSTANCE_ID", ""
    )
    app.config["WEBWRIGHT_BIND_PORT"] = bind_port
    configured_user_files_dir = (
        weworker_user_files_dir
        if weworker_user_files_dir is not None
        else os.environ.get("WEWORKER_USER_FILES_DIR")
    )
    if configured_user_files_dir:
        candidate_user_files_dir = Path(configured_user_files_dir).expanduser()
        app.config["WEBWRIGHT_WEWORKER_USER_FILES_DIR"] = (
            candidate_user_files_dir.resolve()
            if candidate_user_files_dir.is_absolute()
            else None
        )
    else:
        app.config["WEBWRIGHT_WEWORKER_USER_FILES_DIR"] = None

    @app.before_request
    def enforce_local_http_boundary():
        allowed_hosts = {"127.0.0.1", "localhost"}
        request_host = urlsplit(f"//{request.host}")
        try:
            request_port = request_host.port
        except ValueError:
            return _error("forbidden", "Forbidden host.", 403)
        if (
            request_host.hostname not in allowed_hosts
            or (bind_port is not None and request_port != bind_port)
        ):
            return _error("forbidden", "Forbidden host.", 403)
        origin = request.headers.get("Origin", "").strip()
        if not origin:
            return None
        parsed_origin = urlsplit(origin)
        try:
            origin_port = parsed_origin.port
        except ValueError:
            return _error("forbidden", "Forbidden origin.", 403)
        if (
            parsed_origin.scheme != request.scheme
            or parsed_origin.hostname != request_host.hostname
            or origin_port != request_port
        ):
            return _error("forbidden", "Forbidden origin.", 403)
        return None

    @app.errorhandler(ValueError)
    def handle_value_error(exc: ValueError):
        return _error("invalid_request", str(exc), 400)

    @app.errorhandler(FileNotFoundError)
    def handle_file_not_found(exc: FileNotFoundError):
        return _error("not_found", str(exc), 404)

    @app.errorhandler(NotFoundError)
    def handle_not_found(exc: NotFoundError):
        return _error("not_found", str(exc), 404)

    @app.errorhandler(KeyError)
    def handle_key_error(exc: KeyError):
        return _error("not_found", str(exc.args[0]) if exc.args else "Not found.", 404)

    @app.errorhandler(BusyError)
    def handle_busy(exc: BusyError):
        return _error("busy", str(exc), 409)

    @app.errorhandler(InvalidStateError)
    def handle_invalid_state(exc: InvalidStateError):
        return _error("invalid_state", str(exc), 409)


    @app.get("/api/health")
    def health():
        identity = app.config["WEBWRIGHT_RUNTIME_IDENTITY"]
        configured_port = app.config["WEBWRIGHT_BIND_PORT"]
        request_port = urlsplit(f"//{request.host}").port
        return jsonify(
            {
                "ok": True,
                **identity,
                "instance_id": app.config["WEWORKER_EXPLORATION_INSTANCE_ID"],
                "runtime": "local_browser.local_cdp",
                "bind": app.config["WEBWRIGHT_BIND_HOST"],
                "port": str(configured_port if configured_port is not None else request_port or ""),
                "capabilities": {
                    "adapter_v2_package": app.config["WEBWRIGHT_WEWORKER_USER_FILES_DIR"] is not None,
                },
            }
        )

    @app.get("/api/docs")
    def docs():
        return Response(
            _markdown_docs(f"http://{request.host}"),
            mimetype="text/markdown; charset=utf-8",
        )

    @app.get("/api/openapi.json")
    def openapi_json():
        spec = _openapi_spec()
        spec["servers"] = [{"url": f"http://{request.host}"}]
        return jsonify(spec)

    @app.get("/api/browser/status")
    def get_browser_status():
        return jsonify(browser_status(app.config["WEBWRIGHT_CDP_URL"]))

    @app.post("/api/browser/open")
    def open_browser():
        try:
            payload = _request_json()
            return jsonify(
                browser_open(
                    app.config["WEBWRIGHT_CDP_URL"],
                    str(payload.get("url") or ""),
                )
            )
        except ValueError:
            raise
        except Exception as exc:
            return _error("browser_unavailable", str(exc), 503)

    @app.get("/api/browser/match")
    def match_browser_tab():
        toolkit_id = str(request.args.get("toolkit_id") or "")
        if toolkit_id:
            toolkit = toolkits.get_toolkit(toolkit_id)
            tool = toolkits.get_tool(toolkit_id, str(request.args.get("tool_id") or ""))
            return jsonify(browser_match(
                app.config["WEBWRIGHT_CDP_URL"], tool["start_url"], toolkit["allowed_domains"],
            ))
        return jsonify(
            browser_match(
                app.config["WEBWRIGHT_CDP_URL"],
                str(request.args.get("url") or ""),
            )
        )

    @app.get("/api/browser/tabs")
    def get_browser_tabs():
        return jsonify(browser_tabs(app.config["WEBWRIGHT_CDP_URL"]))

    @app.get("/api/activity")
    def get_activity():
        snapshot = (
            manager.active_snapshot()
            if hasattr(manager, "active_snapshot")
            else {"kind": None, "id": None, "task_id": None, "running": False}
        )
        kind = str(snapshot.get("kind") or "")
        active_id = str(snapshot.get("id") or "")
        toolkit_id = ""
        tool_id = ""
        product_kind = kind
        try:
            if kind in {"task", "replay"}:
                task_id = str(snapshot.get("task_id") or active_id)
                task = task_store.read_task(task_id)
                toolkit_id = str(task.get("toolkit_id") or "")
                tool_id = str(task.get("tool_id") or "")
                product_kind = "exploration_replay" if kind == "replay" else str(
                    task.get("activity_type") or "task"
                )
            elif kind == "debug":
                run = debug_runs.read(active_id)
                tool_id = str(run.get("tool_id") or "")
                toolkit_id = str(toolkits.find_tool(tool_id).get("toolkit_id") or "")
            elif kind == "development":
                run = development_runs.read(active_id)
                toolkit_id = str(run.get("toolkit_id") or "")
                tool_id = str(run.get("tool_id") or "")
        except (FileNotFoundError, ValueError):
            pass
        return jsonify(
            {
                "running": bool(snapshot.get("running")),
                "kind": product_kind,
                "id": active_id,
                "toolkit_id": toolkit_id,
                "tool_id": tool_id,
            }
        )

    @app.get("/api/toolkits")
    def list_toolkits():
        return jsonify({"toolkits": toolkits.list_toolkits()})

    @app.post("/api/toolkits")
    def create_toolkit():
        payload = _request_json()
        return jsonify(
            toolkits.create_toolkit(
                name=str(payload.get("name") or ""),
                description=str(payload.get("description") or ""),
                allowed_domains=payload.get("allowed_domains") or [],
            )
        )

    @app.get("/api/toolkits/<toolkit_id>")
    def get_toolkit(toolkit_id: str):
        return jsonify(toolkits.get_toolkit(toolkit_id))

    @app.put("/api/toolkits/<toolkit_id>")
    def update_toolkit(toolkit_id: str):
        payload = _request_json()
        if payload.get("name") not in {None, toolkit_id}:
            raise ValueError("Toolkit name cannot be changed.")
        return jsonify(
            toolkits.update_toolkit(
                toolkit_id,
                description=payload.get("description"),
                allowed_domains=payload.get("allowed_domains"),
            )
        )

    @app.delete("/api/toolkits/<toolkit_id>")
    def delete_toolkit(toolkit_id: str):
        toolkits.delete_toolkit(toolkit_id)
        return jsonify({"ok": True})

    @app.get("/api/toolkits/<toolkit_id>/tools")
    def list_tools(toolkit_id: str):
        return jsonify({"tools": toolkits.list_tools(toolkit_id)})

    @app.post("/api/toolkits/<toolkit_id>/tools")
    def create_tool(toolkit_id: str):
        payload = _request_json()
        return jsonify(
            toolkits.create_tool(
                toolkit_id,
                name=str(payload.get("name") or ""),
                goal=str(payload.get("goal") or ""),
                start_url=str(payload.get("start_url") or ""),
                expected_effect=str(payload.get("expected_effect") or ""),
            )
        )

    @app.get("/api/toolkits/<toolkit_id>/tools/<tool_id>")
    def get_tool(toolkit_id: str, tool_id: str):
        return jsonify(toolkits.get_tool(toolkit_id, tool_id))

    @app.put("/api/toolkits/<toolkit_id>/tools/<tool_id>")
    def update_tool(toolkit_id: str, tool_id: str):
        payload = _request_json()
        if payload.get("name") not in {None, tool_id}:
            raise ValueError("Tool name cannot be changed.")
        return jsonify(
            toolkits.update_tool(
                toolkit_id,
                tool_id,
                goal=payload.get("goal"),
                start_url=payload.get("start_url"),
                expected_effect=payload.get("expected_effect"),
            )
        )

    @app.delete("/api/toolkits/<toolkit_id>/tools/<tool_id>")
    def delete_tool(toolkit_id: str, tool_id: str):
        toolkits.delete_tool(toolkit_id, tool_id)
        return jsonify({"ok": True})

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/delete-prepare")
    def prepare_tool_deletion(toolkit_id: str, tool_id: str):
        return jsonify({"transaction_id": toolkits.stage_tool_deletion(toolkit_id, tool_id)})

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/delete-finish")
    def finish_tool_deletion(toolkit_id: str, tool_id: str):
        payload = _request_json()
        toolkits.finish_tool_deletion(
            toolkit_id, tool_id, str(payload.get("transaction_id") or ""),
            restore=payload.get("restore") is True,
        )
        return jsonify({"ok": True})

    @app.get("/api/toolkits/<toolkit_id>/tools/<tool_id>/formal")
    def get_formal_slot(toolkit_id: str, tool_id: str):
        return jsonify({"formal": toolkits.read_formal_slot(toolkit_id, tool_id)})

    def development_run_response(run: dict[str, Any]) -> dict[str, Any]:
        run_dir = development_runs.run_dir(
            str(run["toolkit_id"]), str(run["development_run_id"])
        )
        runtime_errors = run_dir / "runtime_errors.jsonl"
        return {
            **run,
            "has_runtime_errors": runtime_errors.is_file()
            and runtime_errors.stat().st_size > 0,
        }

    @app.get("/api/toolkits/<toolkit_id>/tools/<tool_id>/development")
    def get_development_slot(toolkit_id: str, tool_id: str):
        development = toolkits.read_development_slot(toolkit_id, tool_id)
        publish_eligible = bool(
            development
            and debug_runs.has_successful_run(
                tool_id=tool_id,
                channel="development",
                code_hash=str(development["code_hash"]),
            )
        )
        runs = development_runs.list_for_tool(toolkit_id, tool_id)
        return jsonify(
            {
                "development": development,
                "publish_eligible": publish_eligible,
                "latest_run": development_run_response(runs[0]) if runs else None,
            }
        )

    @app.put("/api/toolkits/<toolkit_id>/tools/<tool_id>/development")
    def update_development_code(toolkit_id: str, tool_id: str):
        payload = _request_json()
        code = payload.get("code")
        expected_code_hash = payload.get("expected_code_hash")
        if not isinstance(code, str):
            raise ValueError("code must be a string.")
        if not isinstance(expected_code_hash, str) or not expected_code_hash:
            raise ValueError("expected_code_hash is required.")
        development = manager.update_development_code(
            toolkit_id=toolkit_id,
            tool_id=tool_id,
            code=code,
            expected_code_hash=expected_code_hash,
        )
        return jsonify(
            {
                "development": development,
                "publish_eligible": debug_runs.has_successful_run(
                    tool_id=tool_id,
                    channel="development",
                    code_hash=str(development["code_hash"]),
                ),
            }
        )

    def _start_development(
        toolkit_id: str,
        tool_id: str,
        payload: dict[str, Any],
        *,
        exploration_only: bool = False,
    ):
        run = manager.start_development(
            toolkit_id=toolkit_id,
            tool_id=tool_id,
            instruction=str(payload.get("instruction") or ""),
            source_exploration_id=str(payload.get("source_exploration_id") or ""),
            debug_run_evidence_id=(
                ""
                if exploration_only
                else str(payload.get("debug_run_evidence_id") or "")
            ),
            exploration_only=exploration_only,
            timeout_seconds=int(payload.get("timeout_seconds") or 900),
        )
        return jsonify(
            {
                "development_run_id": run["development_run_id"],
                "status": run["status"],
                "events_url": f"/api/toolkits/{toolkit_id}/tools/{tool_id}/development/events",
            }
        )

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/development/start")
    def start_development(toolkit_id: str, tool_id: str):
        if toolkits.read_development_slot(toolkit_id, tool_id) is not None:
            raise InvalidStateError("Tool already has a development version.")
        return _start_development(toolkit_id, tool_id, _request_json())

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/development/messages")
    def continue_development(toolkit_id: str, tool_id: str):
        if toolkits.read_development_slot(toolkit_id, tool_id) is None:
            raise InvalidStateError("Tool has no development version.")
        return _start_development(toolkit_id, tool_id, _request_json())

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/development/cancel")
    def cancel_development(toolkit_id: str, tool_id: str):
        runs = development_runs.list_for_tool(toolkit_id, tool_id)
        if not runs:
            raise InvalidStateError("Tool has no Development Run.")
        run = manager.cancel_development(str(runs[0]["development_run_id"]))
        return jsonify(
            {"development_run_id": run["development_run_id"], "status": run["status"]}
        )

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/development/reset-from-formal")
    def reset_development(toolkit_id: str, tool_id: str):
        return jsonify(
            {"development": toolkits.reset_development_from_formal(toolkit_id, tool_id)}
        )

    @app.post(
        "/api/toolkits/<toolkit_id>/tools/<tool_id>/development/restart-from-exploration"
    )
    def restart_development_from_exploration(toolkit_id: str, tool_id: str):
        return _start_development(
            toolkit_id,
            tool_id,
            _request_json(),
            exploration_only=True,
        )

    @app.delete("/api/toolkits/<toolkit_id>/tools/<tool_id>/development")
    def delete_development(toolkit_id: str, tool_id: str):
        toolkits.clear_development_slot(toolkit_id, tool_id)
        return jsonify({"ok": True})

    @app.get("/api/toolkits/<toolkit_id>/tools/<tool_id>/development/events")
    def development_events(toolkit_id: str, tool_id: str):
        runs = development_runs.list_for_tool(toolkit_id, tool_id)
        if not runs:
            raise FileNotFoundError("Development Run not found.")
        development_run_id = str(runs[0]["development_run_id"])

        @stream_with_context
        def generate():
            last_status = ""
            while True:
                run = development_runs.read(development_run_id)
                status = str(run.get("status") or "")
                if status != last_status:
                    last_status = status
                    event = DEVELOPMENT_RUN_STATUS_EVENTS.get(status)
                    if event:
                        yield _sse(event, {"development_run_id": development_run_id, "status": status})
                if status in TERMINAL_DEVELOPMENT_RUN_STATUSES:
                    break
                time.sleep(0.25)

        return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/api/development-runs/<development_run_id>")
    def get_development_run(development_run_id: str):
        return jsonify(
            development_run_response(development_runs.read(development_run_id))
        )

    @app.get("/api/development-runs/<development_run_id>/files/<path:relative_path>")
    def get_development_run_file(development_run_id: str, relative_path: str):
        run = development_runs.read(development_run_id)
        run_dir = development_runs.run_dir(
            str(run["toolkit_id"]), development_run_id
        )
        return send_file(resolve_task_file(run_dir, relative_path))

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/publish")
    def publish_tool(toolkit_id: str, tool_id: str):
        result = toolkit_publisher.publish(toolkit_id, tool_id)
        return jsonify(
            {
                "toolkit_id": toolkit_id,
                "tool_id": tool_id,
                "code_hash": result["formal"]["code_hash"],
                "build": result["build"],
            }
        )

    @app.get("/api/toolkits/<toolkit_id>/export-status")
    def toolkit_export_status(toolkit_id: str):
        return jsonify(toolkit_publisher.export_status(toolkit_id))

    if app.config["WEBWRIGHT_WEWORKER_USER_FILES_DIR"] is not None:

        @app.post("/api/toolkits/<toolkit_id>/bind-adapter")
        def bind_existing_adapter(toolkit_id: str):
            payload = _request_json()
            return jsonify(bind_base(
                toolkits, toolkit_id,
                profile=payload.get("profile"), digest=payload.get("digest"),
                files=payload.get("files"),
            ))

        @app.get("/api/toolkits/<toolkit_id>/adapter-base")
        def get_adapter_base(toolkit_id: str):
            base = read_base(toolkits, toolkit_id)
            if base is None:
                return _error("not_found", "Adapter workspace has no baseline.", 404)
            return jsonify({"name": base["name"], "profile": base["profile"], "digest": base["digest"]})

        @app.get("/api/toolkits/<toolkit_id>/v2-package")
        def get_v2_package(toolkit_id: str):
            status = toolkit_publisher.export_status(toolkit_id)
            if not status["export_eligible"]:
                return _error("invalid_state", "Adapter requires successful formal Debug Runs.", 409)
            metadata, files, _ = current_package(toolkits, toolkit_id)
            return jsonify({
                "name": metadata["name"], "digest": metadata["digest"],
                "files": {name: base64.b64encode(content).decode("ascii")
                          for name, content in files.items()},
                "base": read_base(toolkits, toolkit_id),
            })

    @app.get("/api/toolkits/<toolkit_id>/export")
    def export_toolkit(toolkit_id: str):
        archive = io.BytesIO(toolkit_publisher.export_zip(toolkit_id))
        archive.seek(0)
        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{toolkit_publisher.export_status(toolkit_id)['adapter_name']}.zip",
        )


    @app.get("/api/toolkits/<toolkit_id>/tools/<tool_id>/debug-runs")
    def list_debug_runs(toolkit_id: str, tool_id: str):
        return jsonify({"debug_runs": debug_runs.list_for_tool(tool_id, toolkit_id)})

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/debug-runs")
    def create_debug_run(toolkit_id: str, tool_id: str):
        payload = _request_json()
        run = manager.start_debug_run(
            toolkit_id=toolkit_id,
            tool_id=tool_id,
            channel=str(payload.get("channel") or "development"),
            parameters=payload.get("parameters") or {},
            timeout_seconds=int(payload.get("timeout_seconds") or 60),
            expected_distribution_hash=payload.get("expected_distribution_hash"),
        )
        debug_run_id = str(run["debug_run_id"])
        return jsonify(
            {
                "debug_run_id": debug_run_id,
                "status": run["status"],
                "events_url": f"/api/debug-runs/{debug_run_id}/events",
            }
        )

    @app.get("/api/debug-runs/<debug_run_id>")
    def get_debug_run(debug_run_id: str):
        return jsonify(debug_runs.read(debug_run_id))

    @app.post("/api/debug-runs/<debug_run_id>/cancel")
    def cancel_debug_run(debug_run_id: str):
        run = manager.cancel_debug_run(debug_run_id)
        return jsonify({"debug_run_id": debug_run_id, "status": run["status"]})

    @app.get("/api/debug-runs/<debug_run_id>/events")
    def debug_run_events(debug_run_id: str):
        debug_runs.read(debug_run_id)

        @stream_with_context
        def generate():
            last_status = ""
            while True:
                run = debug_runs.read(debug_run_id)
                status = str(run.get("status") or "")
                if status != last_status:
                    last_status = status
                    event = DEBUG_RUN_STATUS_EVENTS.get(status)
                    if event:
                        yield _sse(
                            event,
                            {"debug_run_id": debug_run_id, "status": status},
                        )
                if status in TERMINAL_DEBUG_RUN_STATUSES:
                    break
                time.sleep(0.25)

        return Response(
            generate(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/api/debug-runs/<debug_run_id>/files/<path:relative_path>")
    def get_debug_run_file(debug_run_id: str, relative_path: str):
        run = debug_runs.read(debug_run_id)
        run_dir = debug_runs.run_dir(str(run["tool_id"]), debug_run_id)
        return send_file(resolve_task_file(run_dir, relative_path))

    @app.get("/api/toolkits/<toolkit_id>/tools/<tool_id>/explorations")
    def list_explorations(toolkit_id: str, tool_id: str):
        toolkits.get_tool(toolkit_id, tool_id)
        explorations = task_store.list_explorations(
            toolkit_id=toolkit_id, tool_id=tool_id
        )
        return jsonify(
            {"explorations": [_exploration_view(item) for item in explorations]}
        )

    @app.post("/api/toolkits/<toolkit_id>/tools/<tool_id>/explorations")
    def create_exploration(toolkit_id: str, tool_id: str):
        toolkits.get_tool(toolkit_id, tool_id)
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        exploration = manager.start_exploration(
            toolkit_id=toolkit_id,
            tool_id=tool_id,
            supplement=str(payload.get("instruction") or ""),
            target_id=str(payload.get("target_id") or ""),
        )
        exploration_id = str(exploration["task_id"])
        return jsonify(
            {
                "exploration_id": exploration_id,
                "status": exploration["status"],
                "events_url": f"/api/explorations/{exploration_id}/events",
                "steps_url": f"/api/explorations/{exploration_id}/steps",
            }
        )

    @app.get("/api/explorations/<exploration_id>")
    def get_exploration(exploration_id: str):
        return jsonify(
            _exploration_view(task_store.read_exploration(exploration_id))
        )

    @app.get("/api/explorations/<exploration_id>/timeline")
    def get_exploration_timeline(exploration_id: str):
        exploration = task_store.read_exploration(exploration_id)
        raw_steps = read_steps(
            exploration_id, Path(exploration["output_dir"]).resolve()
        )
        timeline_steps = []
        for raw_step in raw_steps:
            step = _exploration_step_view(exploration_id, raw_step)
            step["observation"] = raw_step.get("observation", {})
            step["exception"] = raw_step.get("exception", "")
            timeline_steps.append(step)
        return jsonify(
            {
                "items": _exploration_timeline(
                    exploration,
                    timeline_steps,
                    task_store.read_user_turns(exploration_id),
                )
            }
        )

    @app.get("/api/explorations/<exploration_id>/events")
    def exploration_events(exploration_id: str):
        task_store.read_exploration(exploration_id)

        @stream_with_context
        def generate():
            max_step = 0
            last_status = ""
            while True:
                try:
                    exploration = task_store.read_exploration(exploration_id)
                    output_dir = Path(exploration["output_dir"]).resolve()
                    for step in read_steps(exploration_id, output_dir):
                        step_number = int(step.get("step") or 0)
                        if step_number <= max_step:
                            continue
                        max_step = step_number
                        yield _sse(
                            "step_finished",
                            {
                                "exploration_id": exploration_id,
                                "step": step_number,
                                "status": step.get("status", ""),
                                "screenshot_url": _exploration_step_view(
                                    exploration_id, step
                                ).get("screenshot_url", ""),
                            },
                        )
                    status = str(exploration.get("status", ""))
                    if status != last_status:
                        last_status = status
                        event = EXPLORATION_STATUS_EVENTS.get(status)
                        if event:
                            yield _sse(
                                event,
                                {"exploration_id": exploration_id, "status": status},
                            )
                    if status in STOP_TASK_EVENT_STATUSES:
                        break
                    if status not in TASK_STATUS_VALUES:
                        yield _sse(
                            "exploration_failed",
                            {
                                "exploration_id": exploration_id,
                                "status": status,
                                "error": f"Unknown Exploration status: {status}",
                            },
                        )
                        break
                except Exception as exc:
                    yield _sse(
                        "exploration_failed",
                        {
                            "exploration_id": exploration_id,
                            "status": TaskStatus.FAILED.value,
                            "error": str(exc),
                        },
                    )
                    break
                time.sleep(0.75)

        return Response(
            generate(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/api/explorations/<exploration_id>/steps")
    def get_exploration_steps(exploration_id: str):
        exploration = task_store.read_exploration(exploration_id)
        steps = read_steps(
            exploration_id, Path(exploration["output_dir"]).resolve()
        )
        return jsonify(
            {
                "steps": [
                    _exploration_step_view(exploration_id, step) for step in steps
                ]
            }
        )

    @app.get("/api/explorations/<exploration_id>/messages")
    def get_exploration_messages(exploration_id: str):
        exploration = task_store.read_exploration(exploration_id)
        return jsonify(
            {"messages": read_messages(Path(exploration["output_dir"]).resolve())}
        )

    @app.post("/api/explorations/<exploration_id>/messages")
    def add_exploration_message(exploration_id: str):
        task_store.read_exploration(exploration_id)
        payload = _request_json()
        exploration = manager.continue_task(
            task_id=exploration_id,
            followup=str(payload.get("content") or ""),
        )
        return jsonify(
            {"exploration_id": exploration_id, "status": exploration["status"]}
        )

    @app.post("/api/explorations/<exploration_id>/pause")
    def pause_exploration(exploration_id: str):
        task_store.read_exploration(exploration_id)
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        exploration = manager.pause_task(
            exploration_id, reason=str(payload.get("reason") or "")
        )
        return jsonify(
            {"exploration_id": exploration_id, "status": exploration["status"]}
        )

    @app.post("/api/explorations/<exploration_id>/resume")
    def resume_exploration(exploration_id: str):
        task_store.read_exploration(exploration_id)
        payload = _request_json()
        note = str(payload.get("note") or "").strip() or "我已处理好，请继续"
        exploration = manager.continue_task(
            task_id=exploration_id,
            followup=note,
            require_waiting=True,
        )
        return jsonify(
            {"exploration_id": exploration_id, "status": exploration["status"]}
        )

    @app.post("/api/explorations/<exploration_id>/cancel")
    def cancel_exploration(exploration_id: str):
        task_store.read_exploration(exploration_id)
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        exploration = manager.cancel_task(
            exploration_id,
            force=_bool_query("force", default=False),
            reason=str(payload.get("reason") or ""),
        )
        return jsonify(
            {"exploration_id": exploration_id, "status": exploration["status"]}
        )

    @app.post("/api/explorations/<exploration_id>/replay")
    def replay_exploration(exploration_id: str):
        task_store.read_exploration(exploration_id)
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        replay = manager.start_replay(
            task_id=exploration_id,
            from_step=int(payload.get("from_step") or 1),
            to_step=(
                int(payload["to_step"])
                if payload.get("to_step") is not None
                else None
            ),
            new_tab=bool(payload.get("new_tab", False)),
            delay_ms=int(payload.get("delay_ms") or 0),
        )
        return jsonify(
            {
                "replay_id": replay["replay_id"],
                "exploration_id": exploration_id,
                "status": replay["status"],
                "events_url": f"/api/replays/{replay['replay_id']}/events",
            }
        )

    @app.get("/api/explorations/<exploration_id>/files/<path:relative_path>")
    def get_exploration_file(exploration_id: str, relative_path: str):
        exploration = task_store.read_exploration(exploration_id)
        path = resolve_task_file(
            Path(exploration["output_dir"]).resolve(), relative_path
        )
        return send_file(path)

    @app.post("/api/tasks")
    def create_task():
        payload = _request_json()
        task = manager.start_task(
            instruction=str(payload.get("instruction") or ""),
            start_url=str(payload.get("start_url") or ""),
            target_id=str(payload.get("target_id") or ""),
            requested_task_id=payload.get("task_id"),
            title=payload.get("title"),
        )
        task_id = task["task_id"]
        return jsonify(
            {
                "task_id": task_id,
                "status": task["status"],
                "events_url": f"/api/tasks/{task_id}/events",
                "steps_url": f"/api/tasks/{task_id}/steps",
            }
        )

    @app.get("/api/tasks")
    def list_tasks():
        status = request.args.get("status")
        try:
            limit = int(request.args.get("limit", "50"))
        except ValueError:
            raise ValueError("limit must be an integer.")
        tasks = [_task_view(task) for task in task_store.list_tasks(status=status, limit=limit)]
        return jsonify({"tasks": tasks})

    @app.get("/api/tasks/<task_id>")
    def get_task(task_id: str):
        return jsonify(_task_view(task_store.read_task(task_id)))

    @app.get("/api/tasks/<task_id>/events")
    def task_events(task_id: str):
        task_store.read_task(task_id)

        @stream_with_context
        def generate():
            max_step = 0
            last_status = ""
            while True:
                try:
                    task = task_store.read_task(task_id)
                    output_dir = Path(task["output_dir"]).resolve()
                    steps = read_steps(task_id, output_dir)
                    for step in steps:
                        step_number = int(step.get("step") or 0)
                        if step_number <= max_step:
                            continue
                        max_step = step_number
                        yield _sse(
                            "step_finished",
                            {
                                "task_id": task_id,
                                "step": step_number,
                                "status": step.get("status", ""),
                                "screenshot_url": step.get("screenshot_url", ""),
                            },
                        )
                    status = str(task.get("status", ""))
                    if status != last_status:
                        last_status = status
                        event = TASK_STATUS_EVENTS.get(status)
                        if event:
                            yield _sse(event, {"task_id": task_id, "status": status})
                    if status in STOP_TASK_EVENT_STATUSES:
                        break
                    if status not in TASK_STATUS_VALUES:
                        yield _sse(
                            "task_failed",
                            {
                                "task_id": task_id,
                                "status": status,
                                "error": f"Unknown task status: {status}",
                            },
                        )
                        break
                except Exception as exc:
                    yield _sse(
                        "task_failed",
                        {"task_id": task_id, "status": TaskStatus.FAILED.value, "error": str(exc)},
                    )
                    break
                time.sleep(0.75)

        return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/api/tasks/<task_id>/steps")
    def get_steps(task_id: str):
        task = task_store.read_task(task_id)
        steps = read_steps(task_id, Path(task["output_dir"]).resolve())
        return jsonify({"steps": [_step_list_view(step) for step in steps]})

    @app.get("/api/tasks/<task_id>/steps/<int:step_number>")
    def get_step(task_id: str, step_number: int):
        task = task_store.read_task(task_id)
        steps = read_steps(task_id, Path(task["output_dir"]).resolve())
        for step in steps:
            if int(step.get("step") or 0) == step_number:
                return jsonify(step)
        return _error("step_not_found", f"Step not found: {step_number}", 404)

    @app.get("/api/tasks/<task_id>/script")
    def get_script(task_id: str):
        task = task_store.read_task(task_id)
        return jsonify(
            {
                "task_id": task_id,
                "script_name": "script.py",
                "language": "python",
                "content": read_script(Path(task["output_dir"]).resolve()),
            }
        )

    @app.get("/api/tasks/<task_id>/messages")
    def get_messages(task_id: str):
        task = task_store.read_task(task_id)
        return jsonify({"messages": read_messages(Path(task["output_dir"]).resolve())})

    @app.post("/api/tasks/<task_id>/messages")
    def add_message(task_id: str):
        payload = _request_json()
        task = manager.continue_task(task_id=task_id, followup=str(payload.get("content") or ""))
        return jsonify({"task_id": task_id, "status": task["status"], "message": "Follow-up queued."})

    @app.post("/api/tasks/<task_id>/pause")
    def pause_task(task_id: str):
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        task = manager.pause_task(task_id, reason=str(payload.get("reason") or ""))
        return jsonify({"task_id": task_id, "status": task["status"]})

    @app.post("/api/tasks/<task_id>/resume")
    def resume_task(task_id: str):
        payload = _request_json()
        note = str(payload.get("note") or "User is ready to continue.")
        task = manager.continue_task(task_id=task_id, followup=note, require_waiting=True)
        return jsonify({"task_id": task_id, "status": task["status"]})

    @app.post("/api/tasks/<task_id>/cancel")
    def cancel_task(task_id: str):
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        task = manager.cancel_task(
            task_id,
            force=_bool_query("force", default=False),
            reason=str(payload.get("reason") or ""),
        )
        return jsonify({"task_id": task_id, "status": task["status"]})

    @app.post("/api/tasks/<task_id>/replay")
    def start_replay(task_id: str):
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        replay = manager.start_replay(
            task_id=task_id,
            from_step=int(payload.get("from_step") or 1),
            to_step=int(payload["to_step"]) if payload.get("to_step") is not None else None,
            new_tab=bool(payload.get("new_tab", True)),
            delay_ms=int(payload.get("delay_ms") or 0),
        )
        replay_id = replay["replay_id"]
        return jsonify(
            {
                "replay_id": replay_id,
                "task_id": task_id,
                "status": replay["status"],
                "events_url": f"/api/replays/{replay_id}/events",
            }
        )

    @app.get("/api/replays/<replay_id>")
    def get_replay(replay_id: str):
        return jsonify(task_store.read_replay(replay_id))

    @app.get("/api/replays/<replay_id>/events")
    def replay_events(replay_id: str):
        task_store.read_replay(replay_id)

        @stream_with_context
        def generate():
            last_status = ""
            max_step = 0
            while True:
                replay = task_store.read_replay(replay_id)
                replay_dir = Path(replay["output_dir"]).resolve()
                for path in sorted((replay_dir / "steps").glob("step_*.json")):
                    try:
                        step_number = int(path.stem.removeprefix("step_"))
                    except ValueError:
                        continue
                    if step_number <= max_step:
                        continue
                    max_step = step_number
                    yield _sse(
                        "replay_step_finished",
                        {"replay_id": replay_id, "step": step_number},
                    )
                status = str(replay.get("status", ""))
                if status != last_status:
                    last_status = status
                    event = REPLAY_STATUS_EVENTS.get(status)
                    if event:
                        yield _sse(event, {"replay_id": replay_id, "status": status})
                if status in TERMINAL_REPLAY_STATUSES:
                    break
                time.sleep(0.75)

        return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/api/replays/<replay_id>/cancel")
    def cancel_replay(replay_id: str):
        replay = manager.cancel_replay(replay_id)
        return jsonify({"replay_id": replay_id, "status": replay["status"]})

    @app.get("/api/tasks/<task_id>/files/<path:relative_path>")
    def get_task_file(task_id: str, relative_path: str):
        task = task_store.read_task(task_id)
        path = resolve_task_file(Path(task["output_dir"]).resolve(), relative_path)
        return send_file(path)

    return app
