# Webwright Local CDP HTTP API

This document describes the HTTP server API for the Webwright UI integration.
The server supports only the `local_browser + local_cdp` runtime.

## Scope

- The server drives a real headed Chrome or Edge browser through CDP.
- The browser endpoint defaults to `http://127.0.0.1:9222`.
- The built-in UI opens or focuses the Agent browser before task creation so the
  user can prepare the target page and complete login.
- Authentication is not required because the server is intended for single-machine use.
- The server should bind to `127.0.0.1` by default.
- Recommended default port: `8765`.
- The public API uses `task` terminology. `run`, `output_dir`, and `trajectory.json` are implementation details.

The server must not expose or support Browserbase, `local_workspace`, `local_launch`,
`local_persistent`, `persistent_browser.yaml`, `bash_command`, or `final_script.py`
workflow concepts.

## Runtime Defaults

Every task is executed with:

```text
-c base.yaml
-c local_browser.yaml
-c model_zhipu.yaml
environment.environment_class=local_browser
environment.browser_mode=local_cdp
environment.local_cdp_new_page=true
environment.local_cdp_auto_start=true
model.action_field=python_code
```

The server may make `model_config` configurable later, but `browser_mode` should stay
fixed to `local_cdp`.
For built-in UI tasks, a validated `target_id` takes precedence over
`local_cdp_new_page=true`, so the prepared page is reused without navigation.

For every new task with a `start_url`, the harness prepends this deterministic
navigation to the first executed action and persists the combined code as
`steps/step_0001.py`:

```python
await page.goto("<start_url>", wait_until="domcontentloaded")
```

The same combined code is used by the live run, `script.py`, the task UI, and
replay. Resume continues from the existing step index and does not inject this
navigation again.

## Task Artifacts

Each task has one output directory managed by the server. The UI should access these
artifacts only through API endpoints, not direct filesystem paths.

Expected files:

- `trajectory.json`: saved agent conversation and environment runtime state.
- `debug/steps/step_0001.json`: per-step thought, code, result, and observation.
- `steps/step_0001.py`: raw generated Python step.
- `screenshots/step_0001.png`: screenshot captured after each executed step.
- `script.py`: accumulated Python steps appended by the local browser environment.
- `raw_responses.jsonl`: raw model responses for debugging.
- `runtime_errors.jsonl`: model/runtime errors, when present.

## Object Model

### Task

A user-visible browser automation task.

```json
{
  "task_id": "mail_apple_20260708_153000",
  "title": "搜一下 apple 给我发了哪些邮件",
  "instruction": "搜一下 apple 给我发了哪些邮件",
  "start_url": "https://mail.163.com",
  "status": "running",
  "created_at": "2026-07-08T15:30:00+08:00",
  "updated_at": "2026-07-08T15:31:12+08:00",
  "current_step": 4,
  "final_response": "",
  "last_url": "https://mail.163.com/",
  "last_title": "163网易免费邮-你的专业电子邮局",
  "last_screenshot_url": "/api/tasks/mail_apple_20260708_153000/files/screenshots/step_0004.png"
}
```

### Step

One agent-generated browser action. In this server, a step always contains
`python_code`, never `bash_command`.

```json
{
  "step": 4,
  "thought": "Search the inbox for apple.",
  "code_type": "python_code",
  "code": "await page.get_by_role(\"textbox\", name=\"支持邮件全文搜索\").fill(\"apple\")",
  "status": "ok",
  "done": false,
  "final_response": "",
  "url": "https://mail.163.com/",
  "title": "163网易免费邮-你的专业电子邮局",
  "returncode": 0,
  "exception": "",
  "screenshot_url": "/api/tasks/mail_apple_20260708_153000/files/screenshots/step_0004.png"
}
```

### Replay

A replay executes existing generated step files against the local CDP browser.

```json
{
  "replay_id": "replay_20260708_153220",
  "task_id": "mail_apple_20260708_153000",
  "status": "running",
  "from_step": 1,
  "to_step": 4,
  "current_step": 2
}
```

## Status Values

Task status:

```text
queued
starting_browser
running
waiting_for_user
cancel_requested
succeeded
failed
cancelled
```

Replay status:

```text
queued
running
succeeded
failed
cancelled
```

`cancel_requested` means cooperative cancellation has been requested and the child is
expected to exit after the current step.

## API Conventions

Base URL:

```text
http://127.0.0.1:8765
```

All JSON endpoints use:

```text
Content-Type: application/json
```

Error response:

```json
{
  "error": {
    "code": "task_not_found",
    "message": "Task not found: mail_apple_20260708_153000"
  }
}
```

Recommended HTTP status codes:

- `400`: invalid request.
- `404`: task, step, replay, or file not found.
- `409`: invalid state transition, such as resuming a task that is already running.
- `500`: unexpected server error.

## Browser Endpoints

### GET /api/docs

Returns a concise Markdown API document suitable for opening in a browser or
fetching from the local UI.

Response:

```text
# Webwright Local CDP HTTP API
...
```

### GET /api/openapi.json

Returns an OpenAPI-style endpoint index for tooling and client generation.

Response:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Webwright Local CDP HTTP API",
    "version": "0.1.0"
  },
  "paths": {
    "/api/tasks": {
      "post": {
        "summary": "Create and start a Webwright task"
      }
    }
  }
}
```

### GET /api/health

Returns server health.

Response:

```json
{
  "ok": true,
  "version": "0.1.0",
  "runtime": "local_browser.local_cdp",
  "bind": "127.0.0.1",
  "port": 8765
}
```

### GET /api/browser/status

Checks whether the configured local CDP endpoint is reachable.
This endpoint is non-invasive and does not have to launch the browser; `available=false`
can still be recoverable because task execution may auto-start Chrome/Edge.

Response:

```json
{
  "available": true,
  "cdp_url": "http://127.0.0.1:9222",
  "auto_start_enabled": true,
  "browser": "Chrome/Edge",
  "web_socket_debugger_url": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

### POST /api/browser/open

Starts the Agent browser when CDP is unavailable. If it is already running, the
first page target is activated. The browser uses the same persistent local CDP
profile as task execution.

### GET /api/browser/match

Finds the first open page whose normalized URL exactly matches the required
`url` query parameter. A same-origin page is reported as `same_origin` but is
not accepted as ready.

```json
{
  "status": "exact",
  "target": {
    "target_id": "ABC123",
    "title": "Inbox",
    "url": "https://mail.163.com/"
  }
}
```

### GET /api/browser/tabs

Lists CDP page targets.

Response:

```json
{
  "tabs": [
    {
      "target_id": "ABC123",
      "type": "page",
      "title": "Inbox",
      "url": "https://mail.163.com/",
      "web_socket_debugger_url": "ws://127.0.0.1:9222/devtools/page/ABC123"
    }
  ]
}
```

## Task Endpoints

### POST /api/tasks

Creates a task and starts the agent in the background.

Request:

```json
{
  "start_url": "https://mail.163.com",
  "instruction": "搜一下 apple 给我发了哪些邮件",
  "target_id": "ABC123",
  "task_id": "mail_apple",
  "title": "163 邮箱 Apple 邮件搜索"
}
```

Fields:

- `start_url` is required.
- `instruction` is required.
- `target_id` is optional for API compatibility. The built-in UI requires it and
  binds the task to the prepared Agent browser page.
- `task_id` is optional. If provided, the server should sanitize it and append a timestamp when needed to avoid collisions.
- `title` is optional. If omitted, the server may derive it from `instruction`.

Response:

```json
{
  "task_id": "mail_apple_20260708_153000",
  "status": "queued",
  "events_url": "/api/tasks/mail_apple_20260708_153000/events",
  "steps_url": "/api/tasks/mail_apple_20260708_153000/steps"
}
```

### GET /api/tasks

Lists tasks.

Query parameters:

- `status`: optional status filter.
- `limit`: optional item limit, default `50`.

Response:

```json
{
  "tasks": [
    {
      "task_id": "mail_apple_20260708_153000",
      "title": "163 邮箱 Apple 邮件搜索",
      "instruction": "搜一下 apple 给我发了哪些邮件",
      "start_url": "https://mail.163.com",
      "status": "running",
      "current_step": 4,
      "created_at": "2026-07-08T15:30:00+08:00",
      "updated_at": "2026-07-08T15:31:12+08:00",
      "final_response": ""
    }
  ]
}
```

### GET /api/tasks/{task_id}

Returns task details.

Response:

```json
{
  "task_id": "mail_apple_20260708_153000",
  "title": "163 邮箱 Apple 邮件搜索",
  "instruction": "搜一下 apple 给我发了哪些邮件",
  "start_url": "https://mail.163.com",
  "status": "running",
  "current_step": 4,
  "last_url": "https://mail.163.com/",
  "last_title": "163网易免费邮-你的专业电子邮局",
  "last_screenshot_url": "/api/tasks/mail_apple_20260708_153000/files/screenshots/step_0004.png",
  "final_response": "",
  "error": "",
  "created_at": "2026-07-08T15:30:00+08:00",
  "updated_at": "2026-07-08T15:31:12+08:00"
}
```

### GET /api/tasks/{task_id}/events

Streams task events with Server-Sent Events.

Headers:

```text
Content-Type: text/event-stream
Cache-Control: no-cache
```

Example event:

```text
event: step_finished
data: {"task_id":"mail_apple_20260708_153000","step":4,"status":"ok","screenshot_url":"/api/tasks/mail_apple_20260708_153000/files/screenshots/step_0004.png"}
```

Event names:

```text
task_created
task_started
cancel_requested
step_finished
waiting_for_user
task_resumed
task_succeeded
task_failed
task_cancelled
```

The first implementation uses subprocess execution plus artifact polling. It should
emit `step_finished` after a step artifact is stable and readable; it should not
promise precise `step_started`, `browser_connected`, or standalone
`screenshot_created` events.

### GET /api/tasks/{task_id}/steps

Lists generated steps.

Response:

```json
{
  "steps": [
    {
      "step": 1,
      "thought": "Navigate to the start URL.",
      "code_type": "python_code",
      "code": "await page.goto(\"https://mail.163.com\", wait_until=\"domcontentloaded\")",
      "status": "ok",
      "done": false,
      "url": "https://mail.163.com/",
      "title": "163网易免费邮-你的专业电子邮局",
      "screenshot_url": "/api/tasks/mail_apple_20260708_153000/files/screenshots/step_0001.png"
    }
  ]
}
```

### GET /api/tasks/{task_id}/steps/{step}

Returns full step details.

Response:

```json
{
  "step": 4,
  "thought": "Search the inbox for apple.",
  "code_type": "python_code",
  "code": "await page.get_by_role(\"textbox\", name=\"支持邮件全文搜索\").fill(\"apple\")",
  "status": "ok",
  "done": false,
  "final_response": "",
  "output": "URL: https://mail.163.com/...",
  "returncode": 0,
  "exception": "",
  "observation": {
    "url": "https://mail.163.com/",
    "title": "163网易免费邮-你的专业电子邮局",
    "aria_snapshot": "...",
    "python_output": "...",
    "console_output": "...",
    "recent_console": "..."
  },
  "screenshot_url": "/api/tasks/mail_apple_20260708_153000/files/screenshots/step_0004.png"
}
```

### GET /api/tasks/{task_id}/script

Returns the accumulated generated script.

Response:

```json
{
  "task_id": "mail_apple_20260708_153000",
  "script_name": "script.py",
  "language": "python",
  "content": "# Step 1\nawait page.goto(...)\n\n# Step 2\n..."
}
```

### GET /api/tasks/{task_id}/messages

Returns a UI-safe view of the saved trajectory messages.

Response:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Task: 搜一下 apple 给我发了哪些邮件...",
      "kind": "instruction"
    },
    {
      "role": "assistant",
      "content": "Search the inbox for apple.",
      "kind": "thought"
    }
  ]
}
```

The server should omit or truncate large image data and oversized ARIA snapshots unless
the client explicitly asks for the full step detail endpoint.

### POST /api/tasks/{task_id}/messages

Adds a follow-up instruction and continues the task from `trajectory.json`.

Request:

```json
{
  "content": "我已经手动登录好了，继续搜索 apple 邮件。"
}
```

Response:

```json
{
  "task_id": "mail_apple_20260708_153000",
  "status": "queued",
  "message": "Follow-up queued."
}
```

Implementation note: this maps to the existing resume flow with
`resume_from=<absolute task output dir>/trajectory.json` and `followup=<content>`.
The server passes the task's current `active_target_id` as a resume target override,
so a follow-up continues in the same tab used by the latest task or replay. After the
child exits, the actual trajectory target replaces `active_target_id`.

### POST /api/tasks/{task_id}/resume

Resumes an existing task in `waiting_for_user`.

Request:

```json
{
  "note": "用户已完成扫码登录"
}
```

Response:

```json
{
  "task_id": "mail_apple_20260708_153000",
  "status": "queued"
}
```

If `note` is present, the server should append it as a follow-up instruction.

### POST /api/tasks/{task_id}/cancel

Cancels a task.

Query parameters:

- `force`: optional boolean, default `false`. When `false`, cancellation is
  cooperative and completes after the current step. When `true`, the server may
  terminate/kill the child process and artifacts may be incomplete.

Response:

```json
{
  "task_id": "mail_apple_20260708_153000",
  "status": "cancel_requested"
}
```

The task becomes `cancelled` after the child exits or after a forced cancel completes.

## Replay Endpoints

### POST /api/tasks/{task_id}/replay

Starts replaying generated step files through the local CDP browser.

Request:

```json
{
  "from_step": 1,
  "to_step": 4,
  "new_tab": false,
  "delay_ms": 500
}
```

Fields:

- `from_step` is optional, default `1`.
- `to_step` is optional, default latest generated step.
- `new_tab` is optional, default `true` at the API layer.
  - `true`: always create a new tab and promote its target to the task's
    `active_target_id`.
  - `false`: reuse the task's `active_target_id`, then the latest trajectory target;
    if neither is available, create a new tab. The actual target is persisted for
    later replay and follow-up requests.
- The built-in UI sends `new_tab=false` and does not currently expose a mode switch.
- `delay_ms` is optional, default `0`.

Response:

```json
{
  "replay_id": "replay_20260708_153220",
  "task_id": "mail_apple_20260708_153000",
  "status": "queued",
  "events_url": "/api/replays/replay_20260708_153220/events"
}
```

### GET /api/replays/{replay_id}

Returns replay status.

Response:

```json
{
  "replay_id": "replay_20260708_153220",
  "task_id": "mail_apple_20260708_153000",
  "status": "running",
  "from_step": 1,
  "to_step": 4,
  "current_step": 2,
  "error": ""
}
```

### GET /api/replays/{replay_id}/events

Streams replay progress with Server-Sent Events.

Event names:

```text
replay_started
replay_step_started
replay_step_finished
replay_succeeded
replay_failed
replay_cancelled
```

### POST /api/replays/{replay_id}/cancel

Cancels a replay.

Response:

```json
{
  "replay_id": "replay_20260708_153220",
  "status": "cancelled"
}
```

## File Endpoint

### GET /api/tasks/{task_id}/files/{path}

Returns a file under the task output directory.

Examples:

```text
GET /api/tasks/mail_apple_20260708_153000/files/screenshots/step_0004.png
GET /api/tasks/mail_apple_20260708_153000/files/debug/steps/step_0004.json
GET /api/tasks/mail_apple_20260708_153000/files/script.py
```

Security rules:

- Resolve the requested path against the task output directory.
- Reject absolute paths.
- Reject `..` path traversal.
- Reject symlinks that resolve outside the task output directory.
- Return `404` for missing files.

## Lifecycle

1. UI calls `GET /api/browser/status`.
2. If needed, the user calls `POST /api/browser/open`, prepares the target page,
   and completes login in the Agent browser.
3. UI calls `GET /api/browser/match?url=...` and keeps the first exact target.
4. UI calls `POST /api/tasks` with `start_url`, `instruction`, and `target_id`.
5. Server revalidates the target, creates an output directory, and starts a background task.
6. The child process attaches to the prepared page without opening a new tab or
   navigating to `start_url` again.
7. UI subscribes to `GET /api/tasks/{task_id}/events`.
8. Server emits `step_finished` events as completed step artifacts become stable
   and readable.
9. UI reads `GET /api/tasks/{task_id}/steps` and screenshot files to display progress.
10. Stop the running exploration, then send a follow-up when ready.
11. When done, UI displays `final_response`.
12. UI may call `POST /api/tasks/{task_id}/replay` to replay generated steps.

## Implementation Notes

- Prefer a `TaskManager` that owns task metadata, background execution, state transitions, and event subscribers.
- The first implementation executes tasks in a child process via `run_one()` and observes progress through artifacts. It does not manually step the agent inside the HTTP server.
- Keep `run_one()` behavior as the source of truth for config merging, resume handling, and artifact paths.
- Reuse existing resume semantics from `trajectory.json` for follow-up messages.
- Reuse existing local CDP tab restoration fields: target ID, last URL, and last title.
- Use absolute filesystem paths in child process specs and server metadata. Do not rely on child process cwd.
- Clear stale `.server/control.json` before every start/resume/replay, and include a current `run_id` in control files.
- Retry JSON artifact reads briefly to tolerate files that are being written while SSE polling runs.
- Do not expose `output_dir` as the primary UI identity. It can remain a debug field if needed.
- Do not ask the user for credentials in the API. Login happens directly in the real browser.
- Do not close the user's CDP browser when a task finishes unless the server itself launched it and explicit shutdown behavior is later added.
