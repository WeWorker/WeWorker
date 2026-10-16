from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

from webwright.server.artifacts import (
    environment_runtime_state,
    exit_status,
    task_artifact_summary,
    try_read_json,
)
from webwright.server.browser import (
    DEFAULT_CDP_URL,
    browser_activate,
    browser_target,
)
from webwright.server.debug_store import DebugRunStore
from webwright.server.development import build_development_input
from webwright.server.development_store import DevelopmentRunStore
from webwright.server.weworker_model_config import ManagedModelConfig, load_managed_model_config
from webwright.server.publisher import (
    read_distribution,
    skill_name,
)
from webwright.server.records import TaskStore, atomic_write_json, make_run_id, now_iso, sanitize_id, timestamp_compact
from webwright.server.status import (
    AGENT_EXIT_ERROR_MESSAGES,
    AGENT_EXIT_TO_TASK_STATUS,
    AgentExitStatus,
    DebugRunStatus,
    DevelopmentRunStatus,
    ReplayStatus,
    RESUMABLE_TASK_STATUSES,
    TaskStatus,
)
from webwright.server.toolkit_store import DevelopmentSlotConflictError, ToolkitStore
from webwright.runtime_launcher import RuntimeLauncher
from webwright.utils.local_cdp import normalize_page_url
from webwright.utils.logging import append_process_log


class BusyError(RuntimeError):
    pass


class InvalidStateError(RuntimeError):
    pass


class NotFoundError(RuntimeError):
    pass


ActiveKind = Literal["task", "replay", "debug", "development"]
TASK_HARD_STEP_TIMEOUT_MS = 45_000


def _default_config_spec(
    control_path: Path,
    run_id: str,
    cdp_url: str,
    *,
    model_config_file: str,
    model_overrides: tuple[str, ...] | list[str] = (),
) -> list[str]:
    return [
        "base.yaml",
        "local_browser.yaml",
        model_config_file,
        "environment.environment_class=local_browser",
        "environment.browser_mode=local_cdp",
        "environment.local_cdp_new_page=true",
        "environment.local_cdp_auto_start=true",
        f"environment.local_cdp_url={cdp_url}",
        "model.action_field=python_code",
        *model_overrides,
        f"model.process_log_path={control_path.resolve().parent / 'process.log'}",
        f"agent.control_path={control_path.resolve()}",
        f"agent.control_run_id={run_id}",
        f"agent.checkpoint_path={control_path.resolve().parent / 'checkpoint.json'}",
        f"agent.checkpoint_run_id={run_id}",
        # 30s navigation budget plus the bounded title/ARIA/screenshot observations.
        f"agent.hard_step_timeout_ms={TASK_HARD_STEP_TIMEOUT_MS}",
    ]


class ProcessManager:
    def __init__(
        self,
        *,
        store: TaskStore,
        cdp_url: str = DEFAULT_CDP_URL,
        python_executable: str | None = None,
        launcher: RuntimeLauncher | None = None,
        model_config_loader: Callable[[], ManagedModelConfig] | None = None,
        toolkit_store: ToolkitStore | None = None,
        debug_store: DebugRunStore | None = None,
        development_store: DevelopmentRunStore | None = None,
        runtime_environment: Mapping[str, str] | None = None,
    ):
        self.store = store
        self.server_log_path = self.store.root.parent / "logs" / "server.log"
        self.cdp_url = cdp_url
        self.model_config_loader = model_config_loader or load_managed_model_config
        self.toolkit_store = toolkit_store
        self.debug_store = debug_store
        self.development_store = development_store
        self.launcher = launcher or RuntimeLauncher(executable=python_executable)
        self.runtime_environment = dict(runtime_environment or {})
        self.active_process: subprocess.Popen | None = None
        self.active_kind: ActiveKind | None = None
        self.active_id: str | None = None
        self.active_task_id: str | None = None
        self.active_run_id: str | None = None
        self.shutting_down = False
        self.lock = threading.Lock()

    def _worker_environment(
        self, extra: Mapping[str, str] | None = None
    ) -> dict[str, str]:
        combined = dict(self.runtime_environment)
        if extra:
            combined.update(extra)
        environment = self.launcher.internal_worker_environment(combined)
        environment.pop("WEWORKER_MODEL_CONFIG_URL", None)
        environment.pop("WEWORKER_MODEL_CONFIG_TOKEN", None)
        return environment

    def _resolve_model(self) -> tuple[str, list[str], dict[str, str] | None]:
        """Return (model_config_file, config_spec model overrides, subprocess env extra).

        The api_key is only returned as a subprocess env var, never as a
        config_spec override, so it never lands in spec.json or the config
        snapshot.

        Raises ``InvalidStateError`` when WeWorker does not provide a usable
        managed model config, so a doomed task/follow-up is rejected up-front
        with an actionable prompt instead of silently spawning a subprocess
        that crashes at model init.
        """
        overrides: list[str] = []
        try:
            active = self.model_config_loader()
        except Exception as exc:
            append_process_log(
                self.server_log_path,
                source="model_config",
                event="snapshot_failed",
                error_type=type(exc).__name__,
                cause_type=(
                    type(exc.__cause__).__name__ if exc.__cause__ is not None else ""
                ),
            )
            raise InvalidStateError("请先在 WeWorker 中配置可用于 Webwright 的模型。") from exc
        endpoint = active.request_endpoint
        if active.model_class == "anthropic":
            model_config_file = "model_claude.yaml"
            overrides.extend([
                f"model.model_name={active.model}",
                f"model.anthropic_endpoint={endpoint}",
            ])
            env_extra = {"ANTHROPIC_API_KEY": active.api_key}
        elif active.model_class == "zhipu":
            model_config_file = "model_zhipu.yaml"
            overrides.extend([
                f"model.model_name={active.model}",
                f"model.zhipu_endpoint={endpoint}",
            ])
            env_extra = {"ZHIPUAI_API_KEY": active.api_key}
        else:
            model_config_file = "model_openai_chat.yaml"
            overrides.extend([
                f"model.model_name={active.model}",
                f"model.openai_chat_endpoint={endpoint}",
            ])
            env_extra = {"OPENAI_CHAT_API_KEY": active.api_key}
        return model_config_file, overrides, env_extra

    def _resolve_developer_model(self) -> tuple[dict[str, Any], dict[str, str] | None]:
        try:
            active = self.model_config_loader()
        except Exception as exc:
            append_process_log(
                self.server_log_path,
                source="model_config",
                event="snapshot_failed",
                error_type=type(exc).__name__,
                cause_type=(
                    type(exc.__cause__).__name__ if exc.__cause__ is not None else ""
                ),
            )
            raise InvalidStateError("请先在 WeWorker 中配置可用于 Webwright 的模型。") from exc
        endpoint = active.request_endpoint
        if active.model_class == "anthropic":
            model = {"model_class": "anthropic", "model_name": active.model, "anthropic_endpoint": endpoint}
            env_extra = {"ANTHROPIC_API_KEY": active.api_key}
        elif active.model_class == "zhipu":
            model = {"model_class": "zhipu", "model_name": active.model, "zhipu_endpoint": endpoint}
            env_extra = {"ZHIPUAI_API_KEY": active.api_key}
        else:
            model = {
                "model_class": "openai_chat",
                "provider_id": active.provider_id,
                "model_name": active.model,
                "openai_chat_endpoint": endpoint,
            }
            env_extra = {"OPENAI_CHAT_API_KEY": active.api_key}
        return model, env_extra

    def _active_running_locked(self) -> bool:
        return self.active_process is not None and self.active_process.poll() is None

    def _clear_active_locked(self, *, process: subprocess.Popen) -> None:
        if self.active_process is process:
            self.active_process = None
            self.active_kind = None
            self.active_id = None
            self.active_task_id = None
            self.active_run_id = None

    def _ensure_not_busy_locked(self) -> None:
        if self.shutting_down:
            raise InvalidStateError("Webwright Server is shutting down.")
        if self._active_running_locked():
            raise BusyError("Another task or replay is already running.")
        if self.active_process is not None:
            self.active_process = None
            self.active_kind = None
            self.active_id = None
            self.active_task_id = None
            self.active_run_id = None

    def _spawn(
        self,
        command: list[str],
        log_path: Path,
        *,
        env: dict[str, str] | None = None,
        process_group: bool = False,
        cwd: Path | str | None = None,
    ) -> subprocess.Popen:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        append_process_log(log_path, source="lifecycle", event="worker_starting")
        log_handle = log_path.open("a", encoding="utf-8")
        try:
            process_options: dict[str, Any] = {}
            if process_group and os.name == "nt":
                process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            elif process_group:
                process_options["start_new_session"] = True
            process = subprocess.Popen(
                command,
                # 不继承父进程 stdin：服务器自身的 stdin 是启动方（Electron/node）给的管道，
                # 该句柄在子解释器启动引导阶段被 stat 时会挂在内核态（受控实验：同一条命令行、
                # 同一个父进程，只把 stdin 换成 DEVNULL 即 6/6 健康，原样 6/6 冻结）。
                # worker 全都不读自己的 stdin，故安全。
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                cwd=str(Path(cwd).expanduser().resolve()) if cwd is not None else None,
                text=True,
                env=env,
                **process_options,
            )
            append_process_log(
                log_path,
                source="lifecycle",
                event="worker_started",
                pid=process.pid,
            )
            return process
        except Exception as exc:
            append_process_log(
                log_path,
                source="lifecycle",
                event="worker_start_failed",
                error_type=type(exc).__name__,
            )
            raise
        finally:
            log_handle.close()

    @staticmethod
    def _terminate_process_tree(process: subprocess.Popen, *, force: bool = False) -> None:
        if os.name == "nt":
            if not force:
                ctrl_break = getattr(signal, "CTRL_BREAK_EVENT", None)
                if ctrl_break is not None:
                    try:
                        process.send_signal(ctrl_break)
                        return
                    except OSError:
                        pass
            else:
                completed = subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
                if completed.returncode == 0:
                    return
        else:
            try:
                os.killpg(
                    os.getpgid(process.pid),
                    signal.SIGKILL if force else signal.SIGTERM,
                )
                return
            except OSError:
                pass
        if force:
            process.kill()
        else:
            process.terminate()

    def _start_watcher(self, *, kind: ActiveKind, active_id: str, task_id: str | None, process: subprocess.Popen) -> None:
        thread = threading.Thread(
            target=self._watch_process,
            kwargs={"kind": kind, "active_id": active_id, "task_id": task_id, "process": process},
            daemon=True,
        )
        thread.start()

    def start_exploration(
        self,
        *,
        toolkit_id: str,
        tool_id: str,
        supplement: str = "",
        target_id: str = "",
    ) -> dict[str, Any]:
        if self.toolkit_store is None:
            raise InvalidStateError("Toolkit Store is not configured.")
        tool = self.toolkit_store.get_tool(toolkit_id, tool_id)
        instruction_parts = [str(tool["goal"])]
        expected_effect = str(tool.get("expected_effect") or "").strip()
        if expected_effect:
            instruction_parts.append(f"Expected page effect: {expected_effect}")
        supplement = str(supplement or "").strip()
        if supplement:
            instruction_parts.append(f"Additional instruction: {supplement}")
        return self.start_task(
            instruction="\n\n".join(instruction_parts),
            start_url=str(tool["start_url"]),
            requested_task_id=f"exp_{tool_id}",
            title=f"Explore {tool_id}",
            activity_type="exploration",
            toolkit_id=toolkit_id,
            tool_id=tool_id,
            target_id=str(target_id or ""),
            initial_supplement=supplement,
        )

    def start_debug_run(
        self,
        *,
        toolkit_id: str,
        tool_id: str,
        channel: str,
        parameters: dict[str, Any],
        timeout_seconds: int = 60,
        expected_distribution_hash: str | None = None,
    ) -> dict[str, Any]:
        if self.toolkit_store is None or self.debug_store is None:
            raise InvalidStateError("Toolkit Debug Store is not configured.")
        if channel not in {"formal", "development"}:
            raise ValueError("channel must be formal or development.")
        if not isinstance(parameters, dict):
            raise ValueError("parameters must be a JSON object.")
        if timeout_seconds < 1 or timeout_seconds > 600:
            raise ValueError("timeout_seconds must be between 1 and 600.")
        package = None
        artifact_hash = ""
        distribution_hash = ""
        if channel == "formal":
            skill_root = self.toolkit_store.toolkit_dir(toolkit_id) / skill_name(toolkit_id)
            try:
                package = read_distribution(skill_root)
            except (OSError, ValueError) as error:
                raise InvalidStateError("Published Adapter package is invalid.") from error
            if tool_id.replace("_", "-") not in {item["id"] for item in package["manifest"]["tools"]}:
                raise InvalidStateError("Tool is not present in the Adapter manifest.")
            artifact_hash = package["artifact_hash"]
            distribution_hash = package["distribution_hash"]
            if expected_distribution_hash is not None and expected_distribution_hash != distribution_hash:
                raise InvalidStateError("Adapter package changed. Refresh the validation form.")
            code_hash = artifact_hash
        else:
            slot = self.toolkit_store.read_development_slot(toolkit_id, tool_id)
            if slot is None:
                raise InvalidStateError("Tool has no development version.")
            code_hash = str(slot["code_hash"])

        with self.lock:
            self._ensure_not_busy_locked()
            run = self.debug_store.create(
                tool_id=tool_id,
                channel=channel,
                code_hash=code_hash,
                toolkit_id=toolkit_id,
                distribution_hash=distribution_hash,
                artifact_hash=artifact_hash,
                parameters=parameters,
            )
            debug_run_id = str(run["debug_run_id"])
            run_dir = self.debug_store.run_dir(tool_id, debug_run_id)
            adapter_root = run_dir / "artifacts" / skill_name(toolkit_id)
            if package:
                for name, content in package["artifacts"].items():
                    target = adapter_root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content.encode("utf-8"))
            spec_path = run_dir / "debug_spec.json"
            atomic_write_json(
                spec_path,
                {
                    "debug_run_id": debug_run_id,
                    "toolkit_id": toolkit_id,
                    "tool_id": tool_id,
                    "channel": channel,
                    "code_hash": code_hash,
                    "distribution_hash": distribution_hash,
                    "adapter_root": str(adapter_root) if package else "",
                    "artifact_hash": artifact_hash,
                    "parameters": parameters,
                    "timeout_seconds": timeout_seconds,
                    "toolkit_root": str(self.toolkit_store.root),
                    "cdp_url": self.cdp_url,
                    "result_path": str(run_dir / "result.json"),
                    "screenshot_path": str(run_dir / "screenshot.png"),
                },
            )
            process = self._spawn(
                self.launcher.worker_command("tool-debug", spec_path),
                run_dir / "process.log",
                env=self._worker_environment({"PYTHONIOENCODING": "utf-8"}),
                process_group=True,
                cwd=run_dir,
            )
            run = self.debug_store.update(
                debug_run_id,
                status=DebugRunStatus.RUNNING.value,
                started_at=now_iso(),
                last_child_pid=process.pid,
            )
            self.active_process = process
            self.active_kind = "debug"
            self.active_id = debug_run_id
            self.active_task_id = None
            self.active_run_id = None
            thread = threading.Thread(
                target=self._watch_debug,
                kwargs={
                    "debug_run_id": debug_run_id,
                    "process": process,
                    "timeout_seconds": timeout_seconds,
                },
                daemon=True,
            )
            thread.start()
            return run

    def update_development_code(
        self,
        *,
        toolkit_id: str,
        tool_id: str,
        code: str,
        expected_code_hash: str,
    ) -> dict[str, Any]:
        if self.toolkit_store is None:
            raise InvalidStateError("Toolkit Store is not configured.")
        with self.lock:
            self._ensure_not_busy_locked()
            try:
                return self.toolkit_store.update_development_code(
                    toolkit_id,
                    tool_id,
                    code=code,
                    expected_code_hash=expected_code_hash,
                )
            except DevelopmentSlotConflictError as exc:
                raise InvalidStateError(str(exc)) from exc

    def start_development(
        self,
        *,
        toolkit_id: str,
        tool_id: str,
        instruction: str,
        source_exploration_id: str = "",
        debug_run_evidence_id: str = "",
        exploration_only: bool = False,
        timeout_seconds: int = 300,
    ) -> dict[str, Any]:
        if (
            self.toolkit_store is None
            or self.debug_store is None
            or self.development_store is None
        ):
            raise InvalidStateError("Toolkit Development Store is not configured.")
        instruction = str(instruction or "").strip()
        if not instruction:
            raise ValueError("instruction is required.")
        if timeout_seconds < 1 or timeout_seconds > 900:
            raise ValueError("timeout_seconds must be between 1 and 900.")
        self.toolkit_store.get_tool(toolkit_id, tool_id)
        if exploration_only and not source_exploration_id:
            raise ValueError("Exploration-only development requires a source Exploration.")
        if exploration_only:
            source = self.store.read_exploration(source_exploration_id)
            if (
                source.get("toolkit_id") != toolkit_id
                or source.get("tool_id") != tool_id
            ):
                raise ValueError("Exploration does not belong to this Tool.")
            if source.get("status") != "succeeded":
                raise ValueError("Source Exploration must be succeeded.")
        current = self.toolkit_store.read_development_slot(toolkit_id, tool_id)
        formal = self.toolkit_store.read_formal_slot(toolkit_id, tool_id)
        if exploration_only:
            debug_run_evidence_id = ""
        elif current:
            current_source = str(current.get("source_exploration_id") or "")
            if source_exploration_id and source_exploration_id != current_source:
                raise ValueError("source_exploration_id cannot change during a development cycle.")
            source_exploration_id = current_source
        elif not formal and not source_exploration_id:
            raise ValueError("First development requires a succeeded source Exploration.")
        with self.lock:
            self._ensure_not_busy_locked()
            run = self.development_store.create(
                toolkit_id=toolkit_id,
                tool_id=tool_id,
                instruction=instruction,
                exploration_only=exploration_only,
            )
            development_run_id = str(run["development_run_id"])
            run_dir = self.development_store.run_dir(toolkit_id, development_run_id)
            process_log_path = run_dir / "process.log"
            append_process_log(
                process_log_path,
                source="lifecycle",
                event="development_run_created",
                timeout_seconds=timeout_seconds,
            )
            try:
                model, env_extra = self._resolve_developer_model()
                if exploration_only:
                    source = self.store.read_exploration(source_exploration_id)
                    if (
                        source.get("toolkit_id") != toolkit_id
                        or source.get("tool_id") != tool_id
                    ):
                        raise ValueError("Exploration does not belong to this Tool.")
                    if source.get("status") != "succeeded":
                        raise ValueError("Source Exploration must be succeeded.")
                    self.toolkit_store.clear_development_slot(toolkit_id, tool_id)
                development_input = build_development_input(
                    task_store=self.store,
                    toolkit_store=self.toolkit_store,
                    debug_store=self.debug_store,
                    toolkit_id=toolkit_id,
                    tool_id=tool_id,
                    instruction=instruction,
                    source_exploration_id=source_exploration_id,
                    debug_run_evidence_id=debug_run_evidence_id,
                    exploration_only=exploration_only,
                )
                input_path = run_dir / "input.json"
                result_path = run_dir / "result.json"
                spec_path = run_dir / "development_spec.json"
                atomic_write_json(input_path, development_input)
                atomic_write_json(
                    spec_path,
                    {
                        "development_run_id": development_run_id,
                        "toolkit_id": toolkit_id,
                        "tool_id": tool_id,
                        "exploration_only": exploration_only,
                        "input_path": str(input_path),
                        "result_path": str(result_path),
                        "model": {
                            **model,
                            "error_log_path": str(run_dir / "runtime_errors.jsonl"),
                            "process_log_path": str(process_log_path),
                        },
                    },
                )
                process = self._spawn(
                    self.launcher.worker_command("tool-development", spec_path),
                    process_log_path,
                    env=self._worker_environment(env_extra),
                    process_group=True,
                    cwd=run_dir,
                )
            except Exception as exc:
                error_code = (
                    "model_config_unavailable"
                    if isinstance(exc, InvalidStateError)
                    else "development_setup_failed"
                )
                error_stage = (
                    "model_config" if isinstance(exc, InvalidStateError) else "setup"
                )
                append_process_log(
                    process_log_path,
                    source="lifecycle",
                    event="development_run_setup_failed",
                    error_code=error_code,
                    stage=error_stage,
                    error_type=type(exc).__name__,
                )
                self.development_store.update(
                    development_run_id,
                    status=DevelopmentRunStatus.FAILED.value,
                    error=str(exc),
                    error_code=error_code,
                    error_stage=error_stage,
                    finished_at=now_iso(),
                )
                append_process_log(
                    process_log_path,
                    source="lifecycle",
                    event="development_run_finished",
                    status=DevelopmentRunStatus.FAILED.value,
                    reason="setup_failed",
                )
                raise
            run = self.development_store.update(
                development_run_id,
                status=DevelopmentRunStatus.RUNNING.value,
                started_at=now_iso(),
                last_child_pid=process.pid,
                source_exploration_id=source_exploration_id,
                debug_run_evidence_id=debug_run_evidence_id,
                based_on_formal_hash=(
                    ""
                    if exploration_only
                    else str((formal or {}).get("code_hash") or "")
                ),
            )
            append_process_log(
                process_log_path,
                source="lifecycle",
                event="development_run_started",
                pid=process.pid,
            )
            self.active_process = process
            self.active_kind = "development"
            self.active_id = development_run_id
            self.active_task_id = None
            self.active_run_id = None
            threading.Thread(
                target=self._watch_development,
                kwargs={
                    "development_run_id": development_run_id,
                    "process": process,
                    "timeout_seconds": timeout_seconds,
                },
                daemon=True,
            ).start()
            return run

    def cancel_development(self, development_run_id: str) -> dict[str, Any]:
        if self.development_store is None:
            raise InvalidStateError("Toolkit Development Store is not configured.")
        with self.lock:
            run = self.development_store.read(development_run_id)
            if (
                self._active_running_locked()
                and self.active_kind == "development"
                and self.active_id == development_run_id
            ):
                assert self.active_process is not None
                self._terminate_process_tree(self.active_process)
                try:
                    self.active_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._terminate_process_tree(self.active_process, force=True)
            if run.get("status") in {"succeeded", "failed", "cancelled"}:
                return run
            return self.development_store.update(
                development_run_id,
                status=DevelopmentRunStatus.CANCELLED.value,
                error="Development Run cancelled.",
                error_code="run_cancelled",
                error_stage="lifecycle",
                finished_at=now_iso(),
            )

    def cancel_debug_run(self, debug_run_id: str) -> dict[str, Any]:
        if self.debug_store is None:
            raise InvalidStateError("Toolkit Debug Store is not configured.")
        with self.lock:
            run = self.debug_store.read(debug_run_id)
            if (
                self._active_running_locked()
                and self.active_kind == "debug"
                and self.active_id == debug_run_id
            ):
                assert self.active_process is not None
                self._terminate_process_tree(self.active_process)
                try:
                    self.active_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._terminate_process_tree(self.active_process, force=True)
            if run.get("status") in {
                DebugRunStatus.SUCCEEDED.value,
                DebugRunStatus.FAILED.value,
                DebugRunStatus.CANCELLED.value,
            }:
                return run
            return self.debug_store.update(
                debug_run_id,
                status=DebugRunStatus.CANCELLED.value,
                error="Debug Run cancelled.",
                finished_at=now_iso(),
            )

    def start_task(
        self,
        *,
        instruction: str,
        start_url: str,
        target_id: str = "",
        requested_task_id: str | None = None,
        title: str | None = None,
        activity_type: str = "task",
        toolkit_id: str = "",
        tool_id: str = "",
        initial_supplement: str = "",
    ) -> dict[str, Any]:
        if not instruction.strip():
            raise ValueError("instruction is required.")
        if not start_url.strip():
            raise ValueError("start_url is required.")
        with self.lock:
            self._ensure_not_busy_locked()
            if target_id:
                target = browser_target(self.cdp_url, target_id)
                if target is None:
                    raise InvalidStateError("Prepared Agent browser page no longer exists.")
                if normalize_page_url(str(target.get("url") or "")) != normalize_page_url(
                    start_url
                ):
                    raise InvalidStateError(
                        "Prepared Agent browser page no longer matches start_url."
                    )
                browser_activate(self.cdp_url, target_id)
            model_config_file, model_overrides, env_extra = self._resolve_model()
            task_id = self.store.new_task_id(requested_task_id, title=title or instruction[:40])
            run_id = make_run_id()
            output_dir = self.store.task_dir(task_id).resolve()
            server_dir = self.store.server_dir(task_id)
            server_dir.mkdir(parents=True, exist_ok=True)
            self._clear_control(task_id)
            record = self.store.create_task_record(
                task_id=task_id,
                title=title or instruction,
                instruction=instruction,
                start_url=start_url,
                output_dir=output_dir,
                run_id=run_id,
                active_target_id=target_id,
                activity_type=activity_type,
                toolkit_id=toolkit_id,
                tool_id=tool_id,
                initial_supplement=initial_supplement,
            )
            spec = {
                "mode": "start",
                "task_id": task_id,
                "run_id": run_id,
                "instruction": instruction,
                "start_url": start_url,
                "target_id": target_id,
                "resolved_output_dir": str(output_dir),
                "config_spec": _default_config_spec(
                    self.store.control_path(task_id),
                    run_id,
                    self.cdp_url,
                    model_config_file=model_config_file,
                    model_overrides=model_overrides,
                ),
                "resume_from": None,
                "followup": None,
                "activity_type": activity_type,
                "toolkit_id": toolkit_id,
                "tool_id": tool_id,
            }
            atomic_write_json(self.store.spec_path(task_id), spec)
            process = self._spawn(
                self.launcher.worker_command(
                    "local-cdp-task", self.store.spec_path(task_id)
                ),
                self.store.process_log_path(task_id),
                env=self._worker_environment(env_extra),
                process_group=True,
                cwd=output_dir,
            )
            record = self.store.update_task(
                task_id,
                status=TaskStatus.RUNNING.value,
                last_run_id=run_id,
                last_child_pid=process.pid,
                error="",
                error_code="",
                error_stage="",
            )
            self.active_process = process
            self.active_kind = "task"
            self.active_id = task_id
            self.active_task_id = task_id
            self.active_run_id = run_id
            self._start_watcher(kind="task", active_id=task_id, task_id=task_id, process=process)
            return record

    def continue_task(self, *, task_id: str, followup: str, require_waiting: bool = False) -> dict[str, Any]:
        if not followup.strip():
            raise ValueError("followup content is required.")
        with self.lock:
            self._ensure_not_busy_locked()
            task = self._read_task_or_raise(task_id)
            status = str(task.get("status", ""))
            if require_waiting and status not in RESUMABLE_TASK_STATUSES:
                raise InvalidStateError(f"Task is not waiting for user: {status}")
            output_dir = Path(task["output_dir"]).resolve()
            trajectory_path = output_dir / "trajectory.json"
            if not trajectory_path.is_file():
                raise InvalidStateError("Task has no trajectory.json to resume from.")
            model_config_file, model_overrides, env_extra = self._resolve_model()
            run_id = make_run_id()
            self._clear_control(task_id)
            spec = {
                "mode": "resume",
                "task_id": task_id,
                "run_id": run_id,
                "instruction": task.get("instruction", ""),
                "start_url": task.get("start_url", ""),
                "resume_target_id": task.get("active_target_id", ""),
                "resolved_output_dir": str(output_dir),
                "config_spec": _default_config_spec(
                    self.store.control_path(task_id),
                    run_id,
                    self.cdp_url,
                    model_config_file=model_config_file,
                    model_overrides=model_overrides,
                ),
                "resume_from": str(trajectory_path),
                "followup": followup,
                "activity_type": task.get("activity_type", "task"),
                "toolkit_id": task.get("toolkit_id", ""),
                "tool_id": task.get("tool_id", ""),
            }
            atomic_write_json(self.store.spec_path(task_id), spec)
            process = self._spawn(
                self.launcher.worker_command(
                    "local-cdp-task", self.store.spec_path(task_id)
                ),
                self.store.process_log_path(task_id),
                env=self._worker_environment(env_extra),
                process_group=True,
                cwd=output_dir,
            )
            if task.get("activity_type") == "exploration":
                after_step = task_artifact_summary(task_id, output_dir)["current_step"]
                try:
                    self.store.append_user_turn(
                        task_id,
                        content=followup,
                        after_step=int(after_step or 0),
                    )
                except Exception:
                    self._terminate_process_tree(process, force=True)
                    raise
            record = self.store.update_task(
                task_id,
                status=TaskStatus.RUNNING.value,
                last_run_id=run_id,
                last_child_pid=process.pid,
                error="",
                error_code="",
                error_stage="",
            )
            self.active_process = process
            self.active_kind = "task"
            self.active_id = task_id
            self.active_task_id = task_id
            self.active_run_id = run_id
            self._start_watcher(kind="task", active_id=task_id, task_id=task_id, process=process)
            return record

    def pause_task(self, task_id: str, *, reason: str = "") -> dict[str, Any]:
        with self.lock:
            task = self._read_task_or_raise(task_id)
            if not self._active_running_locked() or self.active_kind != "task" or self.active_task_id != task_id:
                raise InvalidStateError("Task is not currently running.")
            payload = {
                "run_id": self.active_run_id,
                "action": "pause",
                "reason": reason,
                "created_at": now_iso(),
            }
            atomic_write_json(self.store.control_path(task_id), payload)
            return self.store.update_task(
                task_id,
                status=TaskStatus.PAUSE_REQUESTED.value,
                error="",
                error_code="",
                error_stage="",
            )

    def cancel_task(self, task_id: str, *, force: bool = False, reason: str = "") -> dict[str, Any]:
        with self.lock:
            task = self._read_task_or_raise(task_id)
            if not self._active_running_locked() or self.active_kind != "task" or self.active_task_id != task_id:
                if self.store.is_terminal(task):
                    return task
                return self.store.update_task(
                    task_id,
                    status=TaskStatus.CANCELLED.value,
                    error=reason or "Cancelled.",
                    error_code="",
                    error_stage="",
                )
            process = self.active_process
            if force:
                assert process is not None
                self.store.update_task(
                    task_id,
                    status=TaskStatus.CANCEL_REQUESTED.value,
                    error="",
                    error_code="",
                    error_stage="",
                )
                self._terminate_process_tree(process)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._terminate_process_tree(process, force=True)
                return self.store.update_task(
                    task_id,
                    status=TaskStatus.CANCELLED.value,
                    error=reason or "Forced cancel requested.",
                    error_code="",
                    error_stage="",
                )
            payload = {
                "run_id": self.active_run_id,
                "action": "cancel",
                "reason": reason,
                "created_at": now_iso(),
            }
            atomic_write_json(self.store.control_path(task_id), payload)
            return self.store.update_task(
                task_id,
                status=TaskStatus.CANCEL_REQUESTED.value,
                error="",
                error_code="",
                error_stage="",
            )

    def start_replay(
        self,
        *,
        task_id: str,
        from_step: int = 1,
        to_step: int | None = None,
        new_tab: bool = True,
        delay_ms: int = 0,
    ) -> dict[str, Any]:
        with self.lock:
            self._ensure_not_busy_locked()
            task = self._read_task_or_raise(task_id)
            task_output_dir = Path(task["output_dir"]).resolve()
            target_id = ""
            if not new_tab:
                runtime_state = environment_runtime_state(task_output_dir)
                candidates = (
                    str(task.get("active_target_id", "") or ""),
                    str(runtime_state.get("target_id", "") or ""),
                )
                for candidate in candidates:
                    if candidate and browser_target(self.cdp_url, candidate) is not None:
                        target_id = candidate
                        break
            replay_id = f"replay_{timestamp_compact()}_{sanitize_id(task_id, default='task')}"
            replay_dir = self.store.replay_dir(task_id, replay_id).resolve()
            replay_dir.mkdir(parents=True, exist_ok=True)
            self._clear_control(task_id)
            replay = {
                "replay_id": replay_id,
                "task_id": task_id,
                "status": ReplayStatus.QUEUED.value,
                "from_step": from_step,
                "to_step": to_step,
                "current_step": 0,
                "error": "",
                "created_at": now_iso(),
                "updated_at": now_iso(),
                "output_dir": str(replay_dir),
                "new_tab": new_tab,
            }
            self.store.write_replay(replay)
            spec_path = replay_dir / "replay_spec.json"
            spec = {
                "replay_id": replay_id,
                "task_id": task_id,
                "task_output_dir": str(task_output_dir),
                "replay_output_dir": str(replay_dir),
                "from_step": from_step,
                "to_step": to_step,
                "new_tab": new_tab,
                "target_id": target_id,
                "start_url": task.get("start_url", ""),
                "delay_ms": delay_ms,
                "cdp_url": self.cdp_url,
            }
            atomic_write_json(spec_path, spec)
            process = self._spawn(
                self.launcher.worker_command("local-cdp-replay", spec_path),
                replay_dir / "process.log",
                env=self._worker_environment(),
                process_group=True,
                cwd=replay_dir,
            )
            replay = self.store.update_replay(
                replay_id,
                status=ReplayStatus.RUNNING.value,
                last_child_pid=process.pid,
            )
            self.active_process = process
            self.active_kind = "replay"
            self.active_id = replay_id
            self.active_task_id = task_id
            self.active_run_id = None
            self._start_watcher(kind="replay", active_id=replay_id, task_id=task_id, process=process)
            return replay

    def cancel_replay(self, replay_id: str) -> dict[str, Any]:
        with self.lock:
            replay = self.store.read_replay(replay_id)
            if self._active_running_locked() and self.active_kind == "replay" and self.active_id == replay_id:
                assert self.active_process is not None
                self._terminate_process_tree(self.active_process)
                try:
                    self.active_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._terminate_process_tree(self.active_process, force=True)
            return self.store.update_replay(
                replay_id,
                status=ReplayStatus.CANCELLED.value,
                error="Replay cancelled.",
            )

    def active_snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "kind": self.active_kind,
                "id": self.active_id,
                "task_id": self.active_task_id,
                "run_id": self.active_run_id,
                "running": self._active_running_locked(),
            }

    def shutdown(self, *, timeout: float = 5.0) -> None:
        with self.lock:
            self.shutting_down = True
            process = self.active_process
            if process is None or process.poll() is not None:
                if process is not None:
                    self._clear_active_locked(process=process)
                return
            self._mark_shutdown_cancelled_locked()

        self._terminate_process_tree(process)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._terminate_process_tree(process, force=True)
            process.wait()

        with self.lock:
            self._clear_active_locked(process=process)

    def _mark_shutdown_cancelled_locked(self) -> None:
        reason = "Webwright Server is shutting down."
        if self.active_kind == "task" and self.active_task_id:
            self.store.update_task(
                self.active_task_id,
                status=TaskStatus.CANCELLED.value,
                error=reason,
            )
        elif self.active_kind == "replay" and self.active_id:
            self.store.update_replay(
                self.active_id,
                status=ReplayStatus.CANCELLED.value,
                error=reason,
            )
        elif (
            self.active_kind == "debug"
            and self.active_id
            and self.debug_store is not None
        ):
            self.debug_store.update(
                self.active_id,
                status=DebugRunStatus.CANCELLED.value,
                error=reason,
                finished_at=now_iso(),
            )
        elif (
            self.active_kind == "development"
            and self.active_id
            and self.development_store is not None
        ):
            self.development_store.update(
                self.active_id,
                status=DevelopmentRunStatus.CANCELLED.value,
                error=reason,
                error_code="server_shutdown",
                error_stage="lifecycle",
                finished_at=now_iso(),
            )

    def _read_task_or_raise(self, task_id: str) -> dict[str, Any]:
        try:
            return self.store.read_task(task_id)
        except FileNotFoundError as exc:
            raise NotFoundError(str(exc)) from exc

    def _clear_control(self, task_id: str) -> None:
        try:
            self.store.control_path(task_id).unlink()
        except FileNotFoundError:
            pass

    def _watch_process(self, *, kind: ActiveKind, active_id: str, task_id: str | None, process: subprocess.Popen) -> None:
        returncode = (
            self._wait_for_task_process(task_id, process)
            if kind == "task" and task_id is not None
            else process.wait()
        )
        if kind == "task" and task_id is not None:
            log_path = self.store.process_log_path(task_id)
        else:
            replay = self.store.read_replay(active_id)
            log_path = Path(replay["output_dir"]).resolve() / "process.log"
        append_process_log(
            log_path,
            source="lifecycle",
            event="worker_exited",
            returncode=returncode,
        )
        with self.lock:
            try:
                if kind == "task" and task_id is not None:
                    self._finish_task(task_id, returncode)
                    finished = self.store.read_task(task_id)
                    append_process_log(
                        log_path,
                        source="lifecycle",
                        event="task_finished",
                        status=finished.get("status"),
                    )
                elif kind == "replay":
                    self._finish_replay(active_id, returncode)
                    finished = self.store.read_replay(active_id)
                    append_process_log(
                        log_path,
                        source="lifecycle",
                        event="replay_finished",
                        status=finished.get("status"),
                    )
            finally:
                self._clear_active_locked(process=process)

    def _wait_for_task_process(self, task_id: str, process: subprocess.Popen) -> int:
        while True:
            try:
                return process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                checkpoint = try_read_json(self.store.checkpoint_path(task_id), attempts=1)
                if not isinstance(checkpoint, dict):
                    continue
                if str(checkpoint.get("run_id") or "") != str(self.active_run_id or ""):
                    continue
                try:
                    deadline_at_ms = int(checkpoint.get("deadline_at_ms") or 0)
                except (TypeError, ValueError):
                    continue
                if deadline_at_ms <= 0 or int(time.time() * 1000) < deadline_at_ms:
                    continue
                with self.lock:
                    task = self.store.read_task(task_id)
                    if str(task.get("status") or "") in {
                        TaskStatus.CANCEL_REQUESTED.value,
                        TaskStatus.CANCELLED.value,
                    }:
                        continue
                    self._mark_task_step_timeout(task_id, checkpoint)
                    self._terminate_process_tree(process)
                try:
                    return process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._terminate_process_tree(process, force=True)
                    return process.wait()

    def _mark_task_step_timeout(self, task_id: str, checkpoint: dict[str, Any]) -> None:
        step = int(checkpoint.get("step") or 0)
        phase = str(checkpoint.get("phase") or "browser_action")
        error_stage = "initial_observation" if phase == "initial_observation" else "browser_action"
        error = (
            "首次页面观察超时，本次探索已终止。"
            if error_stage == "initial_observation"
            else f"网站探索步骤 {step} 执行超时，本次探索已终止。"
        )
        task = self.store.read_task(task_id)
        output_dir = Path(task["output_dir"]).resolve()
        if step > 0:
            debug_path = output_dir / "debug" / "steps" / f"step_{step:04d}.json"
            if not debug_path.is_file():
                atomic_write_json(
                    debug_path,
                    {
                        "step": step,
                        "thought": checkpoint.get("thought", ""),
                        "python_code": checkpoint.get("python_code", ""),
                        "bash_command": "",
                        "command_text": checkpoint.get("python_code", ""),
                        "raw_response": {},
                        "done": False,
                        "final_response": "",
                        "outputs": [
                            {
                                "output": "",
                                "returncode": 1,
                                "exception_info": error,
                                "observation": {
                                    "success": False,
                                    "exception": error,
                                    "url": "",
                                    "title": "",
                                },
                            }
                        ],
                    },
                )
        atomic_write_json(
            self.store.checkpoint_path(task_id),
            {
                **checkpoint,
                "phase": "timed_out",
                "deadline_at_ms": 0,
                "updated_at_ms": int(time.time() * 1000),
                "error_code": "step_timeout",
                "error_stage": error_stage,
            },
        )
        self.store.update_task(
            task_id,
            status=TaskStatus.FAILED.value,
            current_step=max(int(task.get("current_step") or 0), step),
            error=error,
            error_code="step_timeout",
            error_stage=error_stage,
        )
        append_process_log(
            self.store.process_log_path(task_id),
            source="lifecycle",
            event="task_step_timeout",
            step=step,
            stage=error_stage,
        )

    def _watch_debug(
        self,
        *,
        debug_run_id: str,
        process: subprocess.Popen,
        timeout_seconds: int,
    ) -> None:
        assert self.debug_store is not None
        run = self.debug_store.read(debug_run_id)
        log_path = self.debug_store.run_dir(str(run["tool_id"]), debug_run_id) / "process.log"
        timed_out = False
        try:
            returncode = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            append_process_log(
                log_path,
                source="lifecycle",
                event="debug_run_timeout",
                timeout_seconds=timeout_seconds,
            )
            append_process_log(log_path, source="lifecycle", event="worker_terminating")
            self._terminate_process_tree(process)
            try:
                returncode = process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._terminate_process_tree(process, force=True)
                returncode = process.wait()
        append_process_log(
            log_path,
            source="lifecycle",
            event="worker_exited",
            returncode=returncode,
        )
        with self.lock:
            try:
                self._finish_debug(debug_run_id, returncode, timed_out=timed_out)
            finally:
                self._clear_active_locked(process=process)

    def _watch_development(
        self,
        *,
        development_run_id: str,
        process: subprocess.Popen,
        timeout_seconds: int,
    ) -> None:
        assert self.development_store is not None
        run = self.development_store.read(development_run_id)
        log_path = self.development_store.run_dir(
            str(run["toolkit_id"]), development_run_id
        ) / "process.log"
        timed_out = False
        try:
            returncode = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            append_process_log(
                log_path,
                source="lifecycle",
                event="development_run_timeout",
                timeout_seconds=timeout_seconds,
            )
            append_process_log(log_path, source="lifecycle", event="worker_terminating")
            self._terminate_process_tree(process)
            try:
                returncode = process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._terminate_process_tree(process, force=True)
                returncode = process.wait()
        append_process_log(
            log_path,
            source="lifecycle",
            event="worker_exited",
            returncode=returncode,
        )
        with self.lock:
            try:
                self._finish_development(
                    development_run_id, returncode, timed_out=timed_out
                )
                finished = self.development_store.read(development_run_id)
                append_process_log(
                    log_path,
                    source="lifecycle",
                    event="development_run_finished",
                    status=finished.get("status"),
                    reason="timeout" if timed_out else "process_exit",
                    error_code=finished.get("error_code"),
                    stage=finished.get("error_stage"),
                )
            finally:
                self._clear_active_locked(process=process)

    def _finish_development(
        self, development_run_id: str, returncode: int, *, timed_out: bool = False
    ) -> None:
        assert self.development_store is not None
        assert self.toolkit_store is not None
        run = self.development_store.read(development_run_id)
        if run.get("status") == DevelopmentRunStatus.CANCELLED.value:
            return
        run_dir = self.development_store.run_dir(
            str(run["toolkit_id"]), development_run_id
        )
        result = try_read_json(run_dir / "result.json")
        result = result if isinstance(result, dict) else {}
        error = ""
        error_code = ""
        error_stage = ""
        succeeded = returncode == 0 and result.get("ok") is True
        if timed_out:
            succeeded = False
            error = "Development Run timed out."
            error_code = "run_timeout"
            error_stage = "lifecycle"
        elif not succeeded:
            child_error = self._last_process_error(run_dir / "process.log")
            error = child_error.get("error") or f"Development process exited with code {returncode}."
            error_code = child_error.get("error_code") or "worker_crashed"
            error_stage = child_error.get("error_stage") or "worker"
        if succeeded:
            try:
                slot = dict(result["slot"])
                slot["source_exploration_id"] = str(
                    run.get("source_exploration_id") or ""
                )
                slot["based_on_formal_hash"] = str(
                    run.get("based_on_formal_hash") or ""
                )
                slot["debug_run_evidence_id"] = str(
                    run.get("debug_run_evidence_id") or ""
                )
                written = self.toolkit_store.write_development_slot(
                    str(run["toolkit_id"]), str(run["tool_id"]), slot
                )
            except Exception as exc:
                succeeded = False
                error = str(exc)
                error_code = "developer_slot_invalid"
                error_stage = "slot_write"
                written = None
        else:
            written = None
        self.development_store.update(
            development_run_id,
            status=(
                DevelopmentRunStatus.SUCCEEDED.value
                if succeeded
                else DevelopmentRunStatus.FAILED.value
            ),
            error=error,
            error_code=error_code,
            error_stage=error_stage,
            code_hash=str((written or {}).get("code_hash") or ""),
            finished_at=now_iso(),
        )

    def _finish_debug(
        self, debug_run_id: str, returncode: int, *, timed_out: bool = False
    ) -> None:
        assert self.debug_store is not None
        run = self.debug_store.read(debug_run_id)
        if run.get("status") == DebugRunStatus.CANCELLED.value:
            return
        run_dir = self.debug_store.run_dir(str(run["tool_id"]), debug_run_id)
        result = try_read_json(run_dir / "result.json")
        result = result if isinstance(result, dict) else {}
        succeeded = returncode == 0 and result.get("ok") is True
        error = ""
        if timed_out:
            error = "Debug Run timed out."
        elif not succeeded:
            error = str(result.get("error") or f"Debug process exited with code {returncode}.")
        screenshot_url = (
            f"/api/debug-runs/{debug_run_id}/files/screenshot.png"
            if (run_dir / "screenshot.png").is_file()
            else ""
        )
        self.debug_store.update(
            debug_run_id,
            status=(
                DebugRunStatus.SUCCEEDED.value
                if succeeded
                else DebugRunStatus.FAILED.value
            ),
            result=result.get("result") if succeeded else {},
            error=error,
            before_page=result.get("before_page") or run["before_page"],
            after_page=result.get("after_page") or run["after_page"],
            screenshot_url=screenshot_url,
            finished_at=now_iso(),
        )

    @staticmethod
    def _last_process_error(log_path: Path) -> dict[str, str]:
        try:
            lines = log_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return {}
        for line in reversed(lines):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            if isinstance(payload, dict) and payload.get("ok") is False:
                return {
                    "error": str(payload.get("error") or ""),
                    "error_code": str(payload.get("error_code") or ""),
                    "error_stage": str(payload.get("stage") or ""),
                }
        return {}

    def _last_child_error(self, task_id: str) -> str:
        """Best-effort: extract the last child error from a Task process log."""
        return self._last_process_error(self.store.process_log_path(task_id)).get(
            "error", ""
        )

    def _finish_task(self, task_id: str, returncode: int) -> None:
        task = self.store.read_task(task_id)
        task_status = str(task.get("status"))
        if task_status in {
            TaskStatus.CANCELLED.value,
            TaskStatus.FAILED.value,
        }:
            return
        if task_status == TaskStatus.CANCEL_REQUESTED.value:
            self.store.update_task(task_id, status=TaskStatus.CANCELLED.value)
            return
        output_dir = Path(task["output_dir"]).resolve()
        status, final_response = exit_status(output_dir)
        mapped_status = ""
        error = ""
        error_code = ""
        error_stage = ""
        try:
            agent_exit_status = AgentExitStatus(status)
        except ValueError:
            agent_exit_status = None

        if returncode != 0:
            # A non-zero exit means the child crashed (e.g. missing API key) before
            # run_one wrote a fresh exit record. The trajectory exit_status read above
            # may be stale from a previous successful run, so it must not win here.
            mapped_status = TaskStatus.FAILED.value
            child_error = self._last_process_error(self.store.process_log_path(task_id))
            error = child_error.get("error") or f"Child process exited with code {returncode}."
            error_code = child_error.get("error_code") or "worker_crashed"
            error_stage = child_error.get("error_stage") or "worker"
        elif agent_exit_status is not None:
            mapped_status = AGENT_EXIT_TO_TASK_STATUS[agent_exit_status]
            error = AGENT_EXIT_ERROR_MESSAGES.get(agent_exit_status, "")
        else:
            mapped_status = TaskStatus.SUCCEEDED.value if final_response else TaskStatus.FAILED.value
            if mapped_status == TaskStatus.FAILED.value:
                error = "Task exited without a final response."

        summary = task_artifact_summary(task_id, output_dir)
        runtime_state = environment_runtime_state(output_dir)
        active_target_id = str(runtime_state.get("target_id", "") or "") or str(
            task.get("active_target_id", "") or ""
        )
        self.store.update_task(
            task_id,
            status=mapped_status,
            current_step=summary["current_step"],
            final_response=final_response or summary["final_response"],
            error=error,
            error_code=error_code,
            error_stage=error_stage,
            active_target_id=active_target_id,
        )

    def _finish_replay(self, replay_id: str, returncode: int) -> None:
        replay = self.store.read_replay(replay_id)
        replay_dir = Path(replay["output_dir"]).resolve()
        runtime_state = try_read_json(replay_dir / "runtime.json")
        if isinstance(runtime_state, dict):
            target_id = str(runtime_state.get("target_id", "") or "")
            if target_id:
                self.store.update_task(
                    str(replay["task_id"]),
                    active_target_id=target_id,
                )
        if str(replay.get("status")) == ReplayStatus.CANCELLED.value:
            return
        current_step = 0
        for path in (replay_dir / "steps").glob("step_*.json"):
            try:
                current_step = max(current_step, int(path.stem.removeprefix("step_")))
            except ValueError:
                continue
        status = ReplayStatus.SUCCEEDED.value if returncode == 0 else ReplayStatus.FAILED.value
        error = "" if returncode == 0 else f"Replay process exited with code {returncode}."
        self.store.update_replay(replay_id, status=status, current_step=current_step, error=error)
