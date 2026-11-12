from __future__ import annotations

import copy
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import StrictUndefined, Template
from pydantic import BaseModel, Field

from webwright import Environment, Model, __version__
from webwright.exceptions import FormatError, InterruptAgentFlow, LimitsExceeded, RuntimeExecutionError
from webwright.server.records import atomic_write_json
from webwright.server.status import AgentExitStatus
from webwright.utils.serialize import recursive_merge
from webwright.agents.history_compaction import is_context_overflow, request_tokens, select_source, transcript
from webwright.utils.intervention import validate_user_intervention


DEFAULT_SUMMARY_USER_PROMPT = """You are about to have your working context compacted to save tokens.

Write a concise but COMPLETE summary of everything relevant from the conversation above so that a fresh
agent with only this summary (plus the original system prompt and task instructions) can continue the
task without losing progress. Include:

- The original task goal and all critical points / constraints.
- The workspace directory and key file paths (plan.md, self_reflect_config.json, final_script.py, final_runs/).
- Which critical points have been satisfied, which are still open, and any known blockers.
- Key findings from prior exploration (working selectors, URLs, ARIA labels, pitfalls to avoid).
- The latest final_runs/run_<id>/ state, most recent self_reflection verdict, and the next action to take.

Write the summary as plain prose and bullet lists. Do NOT issue a new bash_command. Do NOT set done=true.
Put the entire summary in the `thought` field (or equivalent text field) and leave action fields empty."""


class AgentConfig(BaseModel):
    system_template: str
    instance_template: str
    step_limit: int = 15
    max_consecutive_format_errors: int = 3
    debug_log: bool = True
    attach_instance_template_after_observation: bool = False
    attach_plan_md_after_observation: bool = False
    require_self_reflection_success: bool = False
    summary_every_n_steps: int = 0
    summary_user_prompt: str = DEFAULT_SUMMARY_USER_PROMPT
    context_limit: int = Field(default=1_000_000, ge=1000)
    compaction_ratio: int = Field(default=80, ge=1, le=99)
    # Strip the ARIA snapshot payload from observation messages older than the last N
    # to bound context growth in browser-driven modes. Any value <= 0 disables pruning
    # (default). Opt in per config (e.g. local_browser.yaml sets this to 1).
    keep_last_n_observations: int = -1
    output_path: Path | None = None
    control_path: Path | None = None
    control_run_id: str = ""
    checkpoint_path: Path | None = None
    checkpoint_run_id: str = ""
    hard_step_timeout_ms: int = 45000


def _sanitize_message_for_disk(message: dict[str, Any]) -> dict[str, Any]:
    cloned = copy.deepcopy(message)
    content = cloned.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "input_image":
                part["image_url"] = "<omitted:data-url>"
    return cloned


def _observation_for_markdown(observation: dict[str, Any], *, model_usage: dict[str, Any] | None = None) -> dict[str, Any]:
    cloned = copy.deepcopy(observation)
    cloned.pop("aria_snapshot", None)
    if model_usage:
        cloned["model_usage"] = copy.deepcopy(model_usage)
    return cloned


def _action_text(action: dict[str, Any]) -> str:
    return str(action.get("bash_command") or action.get("command") or action.get("python_code") or "").strip()


def _python_action_text(action: dict[str, Any]) -> str:
    return str(action.get("python_code") or "").strip()


def _markdown_code_fence_language(*, bash_command_text: str, python_code_text: str) -> str:
    if bash_command_text:
        return "bash"
    if python_code_text:
        return "python"
    return ""


class DefaultAgent:
    def __init__(self, model: Model, env: Environment, *, config_class: type = AgentConfig, **kwargs):
        self.config = config_class(**kwargs)
        self.messages: list[dict[str, Any]] = []
        self.model = model
        self.env = env
        self.extra_template_vars: dict[str, Any] = {}
        self.n_calls = 0
        self._run_start_calls = 0
        self.n_format_errors = 0
        self.n_consecutive_format_errors = 0

    def _write_checkpoint(
        self,
        *,
        phase: str,
        step: int = 0,
        message: dict[str, Any] | None = None,
        deadline_ms: int = 0,
        error_code: str = "",
        error_stage: str = "",
    ) -> None:
        path = self.config.checkpoint_path
        if path is None:
            return
        extra = message.get("extra", {}) if isinstance(message, dict) else {}
        actions = extra.get("actions", []) if isinstance(extra, dict) else []
        python_code = "\n\n".join(
            _python_action_text(action)
            for action in actions
            if isinstance(action, dict) and _python_action_text(action)
        )
        payload = {
            "run_id": self.config.checkpoint_run_id,
            "step": step,
            "phase": phase,
            "updated_at_ms": int(time.time() * 1000),
            "deadline_at_ms": int(time.time() * 1000) + deadline_ms if deadline_ms > 0 else 0,
            "thought": message.get("content", "") if isinstance(message, dict) else "",
            "python_code": python_code,
            "error_code": error_code,
            "error_stage": error_stage,
        }
        try:
            atomic_write_json(path, payload)
        except OSError:
            pass

    def _initial_browser_observation(self, *, resumed: bool = False) -> None:
        observer = getattr(self.env, "initial_observation", None)
        if not callable(observer):
            return
        self._write_checkpoint(
            phase="initial_observation",
            deadline_ms=self.config.hard_step_timeout_ms,
        )
        observation = observer()
        if not isinstance(observation, dict):
            self._write_checkpoint(phase="initial_observation_completed")
            return
        aria_snapshot = str(observation.get("aria_snapshot") or "")
        heading = "Resumed" if resumed else "Initial"
        resume_notice = (
            "The user may have changed the page. This fresh observation supersedes old page snapshots. "
            "Verify the blocker is resolved before continuing; do not repeat completed submissions.\n"
            if resumed else ""
        )
        content = (
            f"## {heading} Browser Observation\n{resume_notice}"
            "The prepared browser page is already connected. Inspect this state before acting. "
            "Do not navigate to the start URL again; preserve the current page, login and form state.\n\n"
            f"URL: {observation.get('url', '')}\n"
            f"Title: {observation.get('title', '')}\n"
            f"ARIA snapshot:\n{aria_snapshot}"
        )
        self.add_messages(
            self.model.format_message(
                role="user",
                content=content,
                extra={
                    "interrupt_type": "ResumeBrowserObservation" if resumed else "InitialBrowserObservation",
                    "observation": observation,
                },
            )
        )
        self._write_checkpoint(phase="initial_observation_completed")

    def _run_loop(self) -> dict[str, Any]:
        while True:
            try:
                self.step()
            except InterruptAgentFlow as exc:
                if isinstance(exc, FormatError):
                    self.n_format_errors += 1
                    self.n_consecutive_format_errors += 1
                self.add_messages(*exc.messages)
                if (
                    isinstance(exc, FormatError)
                    and self.config.max_consecutive_format_errors > 0
                    and self.n_consecutive_format_errors >= self.config.max_consecutive_format_errors
                ):
                    self.add_messages(
                        self.model.format_message(
                            role="exit",
                            content=(
                                "Task stopped after repeated invalid model responses. "
                                "Configure a structured-output model or correct the model endpoint."
                            ),
                            extra={
                                "exit_status": AgentExitStatus.FORMAT_ERROR.value,
                                "submission": "",
                                "final_response": "",
                                "consecutive_format_errors": self.n_consecutive_format_errors,
                            },
                        )
                    )
            finally:
                self.save(self.config.output_path)
            if self.messages[-1].get("role") == "exit":
                break
            control_exit = self._check_control_file()
            if control_exit is not None:
                self.add_messages(control_exit)
                self.save(self.config.output_path)
                break
            if (
                self.config.summary_every_n_steps > 0
                and self.n_calls > 0
                and self.n_calls % self.config.summary_every_n_steps == 0
            ):
                self._compact_history()
                self.save(self.config.output_path)
        return self.messages[-1].get("extra", {})

    def _check_control_file(self) -> dict[str, Any] | None:
        control_path = self.config.control_path
        if control_path is None:
            return None
        try:
            payload = json.loads(control_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None

        expected_run_id = self.config.control_run_id
        if expected_run_id and payload.get("run_id") != expected_run_id:
            return None

        action = str(payload.get("action", "")).strip().lower()
        if action == "cancel":
            return self.model.format_message(
                role="exit",
                content="Task cancelled by server.",
                extra={
                    "exit_status": AgentExitStatus.CANCELLED.value,
                    "submission": "",
                    "final_response": "",
                },
            )
        return None

    def _debug_dir(self) -> Path | None:
        if self.config.output_path is None:
            return None
        return self.config.output_path.parent / "debug"

    def _write_debug_step_artifact(
        self,
        *,
        step_index: int,
        assistant_message: dict[str, Any],
        outputs: list[dict[str, Any]] | None = None,
    ) -> None:
        if not self.config.debug_log:
            return
        debug_dir = self._debug_dir()
        if debug_dir is None:
            return
        steps_dir = debug_dir / "steps"
        steps_dir.mkdir(parents=True, exist_ok=True)

        extra = assistant_message.get("extra", {})
        actions = extra.get("actions", [])
        action_text = "\n\n".join(_action_text(action) for action in actions if _action_text(action))
        python_code_text = "\n\n".join(
            _python_action_text(action) for action in actions if _python_action_text(action)
        )
        bash_command_text = "\n\n".join(
            str(action.get("bash_command", "")).strip()
            for action in actions
            if str(action.get("bash_command", "")).strip()
        )
        code_fence_language = _markdown_code_fence_language(
            bash_command_text=bash_command_text,
            python_code_text=python_code_text,
        )
        payload = {
            "step": step_index,
            "thought": assistant_message.get("content", ""),
            "python_code": python_code_text,
            "bash_command": bash_command_text,
            "command_text": action_text,
            "raw_response": extra.get("raw_response", {}),
            "done": extra.get("done", False),
            "final_response": extra.get("final_response", ""),
            "user_intervention": extra.get("user_intervention"),
            "outputs": outputs or [],
        }
        (steps_dir / f"step_{step_index:04d}.json").write_text(json.dumps(payload, indent=2))

        summary_path = debug_dir / "steps.md"
        with summary_path.open("a", encoding="utf-8") as handle:
            handle.write(f"## Step {step_index}\n\n")
            # Attach the model input only for the first step
            if step_index == 1:
                user_input_text = ""
                for msg in reversed(self.messages):
                    if msg.get("role") == "user":
                        content = msg.get("content", "")
                        if isinstance(content, list):
                            # Multi-part message: join text parts
                            parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") in ("text", "input_text")]
                            user_input_text = "\n".join(p for p in parts if p)
                        else:
                            user_input_text = str(content)
                        break
                if user_input_text:
                    handle.write("### Model Input\n\n")
                    handle.write(f"{user_input_text}\n\n")
            handle.write("### Thought\n\n")
            handle.write(f"{payload['thought']}\n\n")
            handle.write("### Generated Code\n\n")
            handle.write(f"```{code_fence_language}\n")
            handle.write(f"{payload['command_text']}\n")
            handle.write("```\n\n")
            if outputs:
                observation = outputs[0].get("observation", {})
                markdown_observation = _observation_for_markdown(
                    observation,
                    model_usage=extra.get("usage"),
                )
                handle.write("### Observation\n\n")
                handle.write("```json\n")
                handle.write(f"{json.dumps(markdown_observation, indent=2)}\n")
                handle.write("```\n\n")

    def get_template_vars(self, **kwargs) -> dict[str, Any]:
        return recursive_merge(
            self.config.model_dump(),
            self.env.get_template_vars(),
            self.model.get_template_vars(),
            {"n_model_calls": self.n_calls},
            self.extra_template_vars,
            kwargs,
        )

    def _render_template(self, template: str) -> str:
        return Template(template, undefined=StrictUndefined).render(**self.get_template_vars())

    def _plan_md_message(self) -> dict[str, Any] | None:
        workspace_dir = self.get_template_vars().get("workspace_dir")
        if not workspace_dir:
            return None
        plan_path = Path(workspace_dir) / "plan.md"
        if not plan_path.exists() or not plan_path.is_file():
            return None
        plan_text = plan_path.read_text(encoding="utf-8").strip()
        if not plan_text:
            return None
        return self.model.format_message(role="user", content=f"Current plan.md:\n\n{plan_text}")

    def _self_reflection_gate_error(self) -> str | None:
        """Return an error string if done=true should be blocked pending judge success."""
        if not self.config.require_self_reflection_success:
            return None
        return self._tool_gate_error()

    def _tool_gate_error(self) -> str | None:
        """Require final_runs/run_<latest>/self_reflect_result.json with predicted_label == 1."""
        workspace_dir = self.get_template_vars().get("workspace_dir")
        if not workspace_dir:
            return (
                "Completion blocked: require_self_reflection_success is enabled but no workspace_dir is "
                "available. Cannot locate final_runs/run_<id>/self_reflect_result.json. Do not set done=true."
            )
        final_runs_dir = Path(workspace_dir) / "final_runs"
        if not final_runs_dir.is_dir():
            return (
                "Completion blocked: no final_runs/ directory exists yet. You must run final_script.py "
                "in a final_runs/run_<id>/ folder and then run "
                "`python -m webwright.tools.self_reflection --config self_reflect_config.json "
                "--workspace-dir \"{0}\" --output final_runs/run_<id>/self_reflect_result.json` with "
                "predicted_label == 1 before setting done=true."
            ).format(workspace_dir)
        run_dirs: list[tuple[int, Path]] = []
        for entry in final_runs_dir.iterdir():
            if not entry.is_dir() or not entry.name.startswith("run_"):
                continue
            suffix = entry.name[len("run_"):]
            try:
                run_id = int(suffix)
            except ValueError:
                continue
            run_dirs.append((run_id, entry))
        if not run_dirs:
            return (
                "Completion blocked: final_runs/ contains no run_<id>/ folders. Create "
                "final_runs/run_<id>/, execute final_script.py there, then run self_reflection and "
                "only set done=true after self_reflect_result.json reports predicted_label == 1."
            )
        run_dirs.sort(key=lambda item: item[0])
        latest_run_id, latest_run_dir = run_dirs[-1]
        judge_path = latest_run_dir / "self_reflect_result.json"
        if not judge_path.is_file():
            return (
                f"Completion blocked: {judge_path} does not exist. Run "
                f"`python -m webwright.tools.self_reflection --config self_reflect_config.json "
                f"--workspace-dir \"{workspace_dir}\" --output {judge_path}` against the latest run "
                f"(run_{latest_run_id}) and only set done=true after it exits 0 with "
                f"predicted_label == 1."
            )
        try:
            judge_data = json.loads(judge_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return (
                f"Completion blocked: could not parse {judge_path}: {exc}. Re-run self_reflection "
                f"against run_{latest_run_id} and only set done=true after predicted_label == 1."
            )
        predicted_label = judge_data.get("predicted_label")
        if predicted_label != 1:
            return (
                f"Completion blocked: {judge_path} has predicted_label={predicted_label!r} "
                f"(expected 1). Diagnose the failure from self_reflect_result.json, fix final_script.py, "
                f"re-run it in a new final_runs/run_{latest_run_id + 1}/ folder, and re-run "
                f"self_reflection. Only set done=true after self_reflection exits 0 with "
                f"predicted_label == 1."
            )
        return None

    def add_messages(self, *messages: dict[str, Any]) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for message in messages:
            extra = message.get("extra")
            if not isinstance(extra, dict):
                extra = {}
                message["extra"] = extra
            extra.setdefault("timestamp", now)
        self.messages.extend(messages)
        self._prune_old_observation_aria_snapshots()
        return list(messages)

    def _prune_old_observation_aria_snapshots(self) -> None:
        n = self.config.keep_last_n_observations
        if n <= 0:
            return
        obs_indices = [
            i for i, m in enumerate(self.messages)
            if m.get("extra", {}).get("observation")
        ]
        if len(obs_indices) <= n:
            return
        placeholder = "(ARIA snapshot pruned; see most recent observation)"
        for idx in obs_indices[:-n]:
            msg = self.messages[idx]
            obs = msg["extra"]["observation"]
            aria = obs.get("aria_snapshot", "")
            if not aria:
                continue
            content = msg.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") in ("text", "input_text"):
                        text = part.get("text", "")
                        if aria in text:
                            part["text"] = text.replace(aria, placeholder)
            elif isinstance(content, str) and aria in content:
                msg["content"] = content.replace(aria, placeholder)
            obs["aria_snapshot"] = ""

    def _messages_for_model(
        self, messages: list[dict[str, Any]] | None = None
    ) -> list[dict[str, Any]]:
        model_messages = copy.deepcopy(self.messages if messages is None else messages)
        for message in reversed(model_messages):
            if message.get("role") != "assistant":
                continue
            extra = message.get("extra")
            if not isinstance(extra, dict):
                continue
            if extra.get("user_intervention"):
                message["content"] = json.dumps({
                    "thought": str(message.get("content") or ""),
                    "python_code": "", "done": False, "final_response": "",
                    "user_intervention": extra["user_intervention"],
                }, ensure_ascii=False)
                return model_messages
            actions = extra.get("actions")
            if not isinstance(actions, list):
                continue
            for action in reversed(actions):
                if not isinstance(action, dict):
                    continue
                action_field = ""
                action_text = ""
                for candidate in ("python_code", "bash_command"):
                    candidate_text = str(action.get(candidate) or "")
                    if candidate_text.strip():
                        action_field = candidate
                        action_text = candidate_text
                        break
                if not action_field:
                    continue
                message["content"] = json.dumps(
                    {
                        "thought": str(message.get("content") or ""),
                        action_field: action_text,
                        "done": bool(extra.get("done", False)),
                        "final_response": str(extra.get("final_response") or ""),
                    },
                    ensure_ascii=False,
                )
                return model_messages
        return model_messages

    def _compact_history(self, *, required: bool = False) -> None:
        """Compact an older prefix, excluding the action and observations added since the last query."""
        if not self.messages:
            return
        system_message = next((m for m in self.messages if m.get("role") == "system"), None)
        if system_message is None:
            return
        current_start = getattr(self, "_last_query_message_count", None)
        if current_start is None:
            current_start = next((index for index in range(len(self.messages) - 1, 0, -1)
                                  if self.messages[index].get("role") == "assistant"), 1)
        history = [message for message in self.messages[:current_start] if message.get("role") != "system"]
        current_turn = self.messages[current_start:]
        output_tokens = min(4096, self.config.context_limit // 10)
        summary_request = self.model.format_message(
            role="user",
            content=(
                f"{self.config.summary_user_prompt}\n\n"
                f"The complete response must fit within {output_tokens} output tokens. "
                f"Keep the summary below {output_tokens // 2} tokens to leave room for the response format. "
                "Prioritize the task goal, essential identifiers, completed work, blockers and next step."
            ),
            extra={"interrupt_type": "HistoryCompactionRequest"},
        )
        reserved_tokens = request_tokens([system_message, summary_request]) + output_tokens + 256
        source, retained = select_source(
            transcript(self._messages_for_model(history)), ratio=self.config.compaction_ratio,
            context_limit=self.config.context_limit, reserved_tokens=reserved_tokens,
        )
        if not source.strip():
            if not required:
                return
            raise RuntimeExecutionError("历史内容没有可在窗口内压缩的完整句子。", error_code="compaction_input_too_large", stage="compaction")
        summary_messages = [system_message, self.model.format_message(role="user", content=source), summary_request]
        model_config = getattr(self.model, "config", None)
        original_output_tokens = getattr(model_config, "max_output_tokens", None)
        try:
            if original_output_tokens is not None:
                model_config.max_output_tokens = output_tokens
            response = self.model.query(summary_messages)
        except Exception as exc:
            raise RuntimeExecutionError("历史压缩失败，原始上下文已保留，请重试。", error_code="compaction_failed", stage="compaction") from exc
        finally:
            if original_output_tokens is not None:
                model_config.max_output_tokens = original_output_tokens
        summary_text = (response.get("content") or "").strip()
        if not summary_text:
            extra = response.get("extra", {})
            summary_text = (extra.get("final_response") or "").strip()
        if not summary_text:
            raise RuntimeExecutionError("历史压缩未返回摘要，原始上下文已保留。", error_code="compaction_failed", stage="compaction")
        summary_message = self.model.format_message(
            role="user",
            content=(
                "## Compacted History Summary\n"
                f"(context was compacted after step {self.n_calls}; earlier turns have been replaced "
                "by the summary below)\n\n"
                f"{summary_text}\n\n## End of Compacted Summary"
            ),
            extra={"interrupt_type": "HistoryCompactionSummary"},
        )
        compacted = [system_message, summary_message]
        if retained:
            compacted.append(self.model.format_message(role="user", content=retained))
        compacted.extend(current_turn)
        if request_tokens(compacted) >= request_tokens(self.messages):
            raise RuntimeExecutionError("摘要未缩减历史，原始上下文已保留。", error_code="compaction_failed", stage="compaction")
        self.messages = compacted
        self._last_query_message_count = len(compacted) - len(current_turn)

    def run(self, task: str = "", **kwargs) -> dict[str, Any]:
        self.extra_template_vars |= {"task": task, **kwargs}
        self.messages = []
        self._last_query_message_count = None
        self.n_calls = 0
        self._run_start_calls = 0
        self.n_format_errors = 0
        self.n_consecutive_format_errors = 0
        self.add_messages(
            self.model.format_message(role="system", content=self._render_template(self.config.system_template)),
            self.model.format_message(role="user", content=self._render_template(self.config.instance_template)),
        )
        self._initial_browser_observation()
        if self.extra_template_vars.get("explore_history"):
            self.add_messages(
                self.model.format_message(
                    role="user",
                    content="## Previous Explore History\n"
                    "Below is the message log from a prior live-browser exploration of this exact task.\n"
                    "Use it to understand the site layout, available controls, aria snapshots, and pitfalls.\n"
                    "Do NOT repeat failed approaches. Build on what was learned.\n\n"
                    + self.extra_template_vars["explore_history"]
                    + "\n\n## End of Explore History",
                ),
            )
        return self._run_loop()

    def resume(
        self,
        *,
        prior_state: dict[str, Any],
        followup: str | None = None,
        task: str = "",
        **kwargs,
    ) -> dict[str, Any]:
        messages = copy.deepcopy(prior_state.get("messages", []))
        if not messages:
            raise ValueError("Cannot resume without prior messages.")

        while messages and messages[-1].get("role") == "exit":
            messages.pop()
        if not messages:
            raise ValueError("Cannot resume from a trajectory that only contains exit messages.")

        inferred_task = task or str(prior_state.get("task", "") or "")
        self.extra_template_vars |= {"task": inferred_task, **kwargs}
        self.messages = messages
        self._last_query_message_count = None
        self.n_calls = int(prior_state.get("n_calls", 0) or 0)
        # Explicit human continuation receives a fresh bounded execution budget;
        # cumulative calls and artifact numbering are retained.
        self._run_start_calls = self.n_calls
        self.n_format_errors = int(prior_state.get("n_format_errors", 0) or 0)
        self.n_consecutive_format_errors = int(
            prior_state.get("n_consecutive_format_errors", 0) or 0
        )

        if followup:
            self.add_messages(
                self.model.format_message(
                    role="user",
                    content="## Follow-up Instruction\n"
                    "Continue the previous run using the saved history and artifacts.\n\n"
                    f"{followup}",
                    extra={"interrupt_type": "ResumeFollowup", "user_input": followup},
                )
            )

        self._initial_browser_observation(resumed=True)
        self.save(self.config.output_path)
        return self._run_loop()

    def step(self) -> list[dict[str, Any]]:
        message = self.query()
        self.save(self.config.output_path)
        if not message.get("extra", {}).get("done"):
            self._write_checkpoint(
                phase="action_pending",
                step=self.n_calls,
                message=message,
            )
        return self.execute_actions(message)

    def query(self) -> dict[str, Any]:
        if 0 < self.config.step_limit <= self.n_calls - self._run_start_calls:
            raise LimitsExceeded(
                self.model.format_message(
                    role="exit",
                    content="Step limit exceeded.",
                    extra={
                        "exit_status": AgentExitStatus.LIMITS_EXCEEDED.value,
                        "submission": "",
                    },
                )
            )
        if request_tokens(self._messages_for_model()) >= self.config.context_limit * 0.9:
            self._compact_history(required=True)
        try:
            message = self.model.query(self._messages_for_model())
        except Exception as exc:
            if not is_context_overflow(exc):
                raise
            self._compact_history(required=True)
            message = self.model.query(self._messages_for_model())
        self._last_query_message_count = len(self.messages)
        self.n_calls += 1
        self.n_consecutive_format_errors = 0
        self.add_messages(message)
        return message

    def execute_actions(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        extra = message.get("extra", {})
        try:
            intervention = validate_user_intervention(extra.get("user_intervention"))
            if intervention is not None and (
                extra.get("actions") or extra.get("done") or extra.get("final_response")
            ):
                raise ValueError("Request user intervention in a separate turn without actions or completion.")
        except ValueError as exc:
            raise FormatError(self.model.format_message(
                role="user", content=str(exc), extra={"interrupt_type": "FormatError"},
            )) from exc
        if intervention is not None:
            self._write_debug_step_artifact(step_index=self.n_calls, assistant_message=message, outputs=[])
            self._write_checkpoint(phase="waiting_for_user", step=self.n_calls, message=message)
            return self.add_messages(self.model.format_message(
                role="exit", content=intervention["message"],
                extra={
                    "exit_status": AgentExitStatus.PAUSED.value,
                    "submission": "", "final_response": "",
                    "user_intervention": intervention,
                },
            ))
        if extra.get("done"):
            gate_error = self._self_reflection_gate_error()
            if gate_error is not None:
                extra["done"] = False
                return self.add_messages(
                    self.model.format_message(
                        role="user",
                        content=gate_error,
                        extra={"interrupt_type": "SelfReflectionGate"},
                    )
                )
            self._write_debug_step_artifact(step_index=self.n_calls, assistant_message=message, outputs=[])
            return self.add_messages(
                self.model.format_message(
                    role="exit",
                    content=extra.get("final_response", "Task completed."),
                    extra={
                        "exit_status": AgentExitStatus.SUBMITTED.value,
                        "submission": extra.get("final_response", ""),
                        "final_response": extra.get("final_response", ""),
                    },
                )
            )
        self._write_checkpoint(
            phase="action_running",
            step=self.n_calls,
            message=message,
            deadline_ms=self.config.hard_step_timeout_ms,
        )
        outputs = [self.env.execute(action) for action in extra.get("actions", [])]
        self._write_debug_step_artifact(step_index=self.n_calls, assistant_message=message, outputs=outputs)
        fatal_output = next(
            (
                output
                for output in outputs
                if isinstance(output, dict) and output.get("fatal_error_code")
            ),
            None,
        )
        if fatal_output is not None:
            error_code = str(fatal_output.get("fatal_error_code") or "runtime_error")
            error_stage = str(fatal_output.get("fatal_error_stage") or "browser_action")
            error = str(
                fatal_output.get("fatal_error_message")
                or fatal_output.get("exception_info")
                or "Browser action failed."
            )
            self._write_checkpoint(
                phase="failed",
                step=self.n_calls,
                message=message,
                error_code=error_code,
                error_stage=error_stage,
            )
            raise RuntimeExecutionError(
                error,
                error_code=error_code,
                stage=error_stage,
            )
        self._write_checkpoint(
            phase="completed",
            step=self.n_calls,
            message=message,
        )
        observation_messages = self.model.format_observation_messages(message, outputs, self.get_template_vars())
        if self.config.attach_instance_template_after_observation:
            observation_messages.append(
                self.model.format_message(role="user", content=self._render_template(self.config.instance_template))
            )
        if self.config.attach_plan_md_after_observation:
            plan_message = self._plan_md_message()
            if plan_message is not None:
                observation_messages.append(plan_message)
        return self.add_messages(*observation_messages)

    def serialize(self, *extra_dicts) -> dict[str, Any]:
        last_message = self.messages[-1] if self.messages else {}
        last_extra = last_message.get("extra", {})
        return recursive_merge(
            {
                "info": {
                    "config": {
                        "agent": self.config.model_dump(mode="json"),
                        "agent_type": f"{self.__class__.__module__}.{self.__class__.__name__}",
                    },
                    "mini_version": __version__,
                    "exit_status": last_extra.get("exit_status", ""),
                    "submission": last_extra.get("submission", ""),
                    "api_calls": self.n_calls,
                    "format_errors": self.n_format_errors,
                    "consecutive_format_errors": self.n_consecutive_format_errors,
                },
                "messages": [_sanitize_message_for_disk(message) for message in self.messages],
                "trajectory_format": "webwright-0.1",
            },
            self.model.serialize(),
            self.env.serialize(),
            *extra_dicts,
        )

    def save(self, path: Path | None, *extra_dicts) -> dict[str, Any]:
        data = self.serialize(*extra_dicts)
        if path is not None:
            atomic_write_json(path, data)
        return data
