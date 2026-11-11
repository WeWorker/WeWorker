from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from webwright.agents.default import DefaultAgent
from webwright.exceptions import FormatError
from webwright.server.status import AgentExitStatus


def test_agent_stops_and_persists_arbitrary_intervention_without_executing(tmp_path):
    from webwright.server.artifacts import waiting_intervention

    request = {"reason": "ambiguous_project", "message": "请选择目标项目。", "mode": "input"}
    model = ControlModel()
    model.query = Mock(return_value=model.format_message(
        role="assistant", content="Cannot choose for the user",
        extra={"actions": [], "done": False, "final_response": "", "user_intervention": request},
    ))
    env = ControlEnv()
    env.execute = Mock(side_effect=AssertionError("must not execute while requesting help"))
    agent = DefaultAgent(model, env, system_template="System", instance_template="Task: {{ task }}",
                         output_path=tmp_path / "trajectory.json", checkpoint_path=tmp_path / "checkpoint.json")
    result = agent.run("Select the project")
    assert result["exit_status"] == AgentExitStatus.PAUSED.value
    assert result["final_response"] == ""
    assert model.query.call_count == 1
    env.execute.assert_not_called()
    assert waiting_intervention(tmp_path) == request
    assert json.loads((tmp_path / "checkpoint.json").read_text())["phase"] == "waiting_for_user"
    # The requested question remains in the model context after removing the
    # exit record, so a short user reply can be interpreted correctly.
    prior = json.loads((tmp_path / "trajectory.json").read_text(encoding="utf-8"))
    from webwright.utils.trajectory import build_resume_state
    model.query.reset_mock()
    result = agent.resume(prior_state=build_resume_state(prior), followup="Project A")
    assert result["exit_status"] == AgentExitStatus.PAUSED.value
    assert model.query.call_count == 1
    messages = model.query.call_args.args[0]
    prior_request = next(message for message in messages if message["role"] == "assistant")
    assert json.loads(prior_request["content"])["user_intervention"] == request
    assert agent.n_calls == 2
    env.execute.assert_not_called()


@pytest.mark.parametrize("conflict", [{"actions": [{"python_code": "print('unsafe')"}]}, {"done": True}])
def test_agent_never_executes_conflicting_intervention(conflict):
    model = ControlModel()
    env = ControlEnv()
    env.execute = Mock(side_effect=AssertionError("must not execute"))
    agent = DefaultAgent(model, env, system_template="System", instance_template="Task")
    message = model.format_message(role="assistant", extra={
        "user_intervention": {"reason": "other", "message": "Help", "mode": "either"}, **conflict,
    })
    with pytest.raises(FormatError):
        agent.execute_actions(message)
    env.execute.assert_not_called()


class ControlModel:
    def __init__(self):
        self.queries = 0

    def format_message(self, **kwargs):
        return {
            "role": kwargs["role"],
            "content": kwargs.get("content", ""),
            "extra": kwargs.get("extra", {}),
        }

    def query(self, messages):
        self.queries += 1
        if self.queries == 1:
            return self.format_message(
                role="assistant",
                content="do one step",
                extra={
                    "actions": [{"python_code": "print('ok')", "command": "print('ok')"}],
                    "done": False,
                    "final_response": "",
                },
            )
        return self.format_message(
            role="assistant",
            content="done",
            extra={"actions": [], "done": True, "final_response": "finished"},
        )

    def format_observation_messages(self, message, outputs, template_vars):
        return [self.format_message(role="user", content="Observation: ok", extra={"observation": {}})]

    def get_template_vars(self, **kwargs):
        return {}

    def serialize(self):
        return {"model": {"config": {}, "usage": {}, "model_type": "control-fake"}}


class ControlEnv:
    def execute(self, action, cwd: str = ""):
        return {
            "output": "",
            "returncode": 0,
            "exception_info": "",
            "observation": {"success": True, "url": "https://example.com", "title": "Example"},
        }

    def get_template_vars(self, **kwargs):
        return {}

    def serialize(self):
        return {"environment": {"config": {}, "environment_type": "control-fake"}}


class CheckpointEnv(ControlEnv):
    def __init__(self, *, trajectory_path: Path, checkpoint_path: Path):
        self.trajectory_path = trajectory_path
        self.checkpoint_path = checkpoint_path

    def initial_observation(self):
        return {
            "url": "https://example.com/",
            "title": "Example",
            "aria_snapshot": "- heading Example",
            "target_id": "target-1",
            "browser_connected": True,
            "page_closed": False,
        }

    def execute(self, action, cwd: str = ""):
        trajectory = json.loads(self.trajectory_path.read_text(encoding="utf-8"))
        checkpoint = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        assert trajectory["messages"][-1]["role"] == "assistant"
        assert checkpoint["phase"] == "action_running"
        assert checkpoint["python_code"] == "print('ok')"
        assert checkpoint["deadline_at_ms"] > checkpoint["updated_at_ms"]
        return super().execute(action, cwd)


class HistoryModel(ControlModel):
    def __init__(self):
        super().__init__()
        self.requests: list[list[dict]] = []

    def query(self, messages):
        self.requests.append(copy.deepcopy(messages))
        self.queries += 1
        if self.queries <= 2:
            return self.format_message(
                role="assistant",
                content=f"thought {self.queries}",
                extra={
                    "actions": [
                        {
                            "python_code": f"print('step {self.queries}')",
                            "command": f"print('step {self.queries}')",
                        }
                    ],
                    "done": False,
                    "final_response": "",
                },
            )
        return self.format_message(
            role="assistant",
            content="done",
            extra={"actions": [], "done": True, "final_response": "finished"},
        )


def test_default_agent_sends_only_latest_action_as_complete_json(tmp_path: Path) -> None:
    model = HistoryModel()
    agent = DefaultAgent(
        model,
        ControlEnv(),
        system_template="System",
        instance_template="Task: {{ task }}",
        output_path=tmp_path / "trajectory.json",
    )

    agent.run("demo")

    assistant_messages = [
        message for message in model.requests[2] if message["role"] == "assistant"
    ]
    assert assistant_messages[0]["content"] == "thought 1"
    assert json.loads(assistant_messages[1]["content"]) == {
        "thought": "thought 2",
        "python_code": "print('step 2')",
        "done": False,
        "final_response": "",
    }
    assert [
        message["content"] for message in agent.messages if message["role"] == "assistant"
    ] == ["thought 1", "thought 2", "done"]


class CompactionModel(ControlModel):
    def __init__(self):
        super().__init__()
        self.requests: list[list[dict]] = []

    def query(self, messages):
        self.requests.append(copy.deepcopy(messages))
        self.queries += 1
        if self.queries == 1:
            return self.format_message(
                role="assistant",
                content="inspect page",
                extra={
                    "actions": [{"python_code": "print('page')"}],
                    "done": False,
                    "final_response": "",
                },
            )
        if self.queries == 2:
            return self.format_message(
                role="assistant",
                content="compacted summary",
                extra={"actions": [], "done": False, "final_response": ""},
            )
        return self.format_message(
            role="assistant",
            content="done",
            extra={"actions": [], "done": True, "final_response": "finished"},
        )


def test_history_compaction_receives_latest_complete_action_json(tmp_path: Path) -> None:
    model = CompactionModel()
    agent = DefaultAgent(
        model,
        ControlEnv(),
        system_template="System",
        instance_template="Task: {{ task }}",
        output_path=tmp_path / "trajectory.json",
        summary_every_n_steps=1,
    )

    agent.run("demo")

    assistant_message = next(
        message for message in model.requests[1] if message["role"] == "assistant"
    )
    assert json.loads(assistant_message["content"])["python_code"] == "print('page')"


def test_default_agent_cancel_control_file_writes_cancelled_exit(tmp_path: Path) -> None:
    control_path = tmp_path / "control.json"
    control_path.write_text(
        json.dumps({"run_id": "run-1", "action": "cancel"}),
        encoding="utf-8",
    )
    output_path = tmp_path / "trajectory.json"
    agent = DefaultAgent(
        ControlModel(),
        ControlEnv(),
        system_template="System",
        instance_template="Task: {{ task }}",
        output_path=output_path,
        control_path=control_path,
        control_run_id="run-1",
    )

    result = agent.run("demo")

    assert result["exit_status"] == AgentExitStatus.CANCELLED.value
    saved = json.loads(output_path.read_text(encoding="utf-8"))
    assert saved["info"]["exit_status"] == AgentExitStatus.CANCELLED.value
    assert saved["messages"][-1]["content"] == "Task cancelled by server."


def test_default_agent_saves_initial_observation_and_action_checkpoint_before_execute(
    tmp_path: Path,
) -> None:
    trajectory_path = tmp_path / "trajectory.json"
    checkpoint_path = tmp_path / "checkpoint.json"
    env = CheckpointEnv(
        trajectory_path=trajectory_path,
        checkpoint_path=checkpoint_path,
    )
    agent = DefaultAgent(
        ControlModel(),
        env,
        system_template="System",
        instance_template="Task: {{ task }}",
        output_path=trajectory_path,
        checkpoint_path=checkpoint_path,
        checkpoint_run_id="run-1",
        hard_step_timeout_ms=1000,
    )

    result = agent.run("demo")

    assert result["exit_status"] == AgentExitStatus.SUBMITTED.value
    saved = json.loads(trajectory_path.read_text(encoding="utf-8"))
    initial = next(
        message
        for message in saved["messages"]
        if message.get("extra", {}).get("interrupt_type") == "InitialBrowserObservation"
    )
    assert "Do not navigate to the start URL again" in initial["content"]
    checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    assert checkpoint["phase"] == "completed"
    assert checkpoint["run_id"] == "run-1"


def test_default_agent_ignores_mismatched_control_run_id(tmp_path: Path) -> None:
    control_path = tmp_path / "control.json"
    control_path.write_text(
        json.dumps({"run_id": "old-run", "action": "cancel"}),
        encoding="utf-8",
    )
    agent = DefaultAgent(
        ControlModel(),
        ControlEnv(),
        system_template="System",
        instance_template="Task: {{ task }}",
        output_path=tmp_path / "trajectory.json",
        control_path=control_path,
        control_run_id="new-run",
    )

    result = agent.run("demo")

    assert result["exit_status"] == AgentExitStatus.SUBMITTED.value
    assert result["final_response"] == "finished"


class InvalidJsonModel(ControlModel):
    def query(self, messages):
        self.queries += 1
        raise FormatError(
            self.format_message(
                role="user",
                content="Format error",
                extra={"interrupt_type": "FormatError"},
            )
        )


def test_default_agent_stops_after_consecutive_format_errors(tmp_path: Path) -> None:
    model = InvalidJsonModel()
    output_path = tmp_path / "trajectory.json"
    agent = DefaultAgent(
        model,
        ControlEnv(),
        system_template="System",
        instance_template="Task: {{ task }}",
        output_path=output_path,
        max_consecutive_format_errors=3,
    )

    result = agent.run("demo")

    assert model.queries == 3
    assert result["exit_status"] == AgentExitStatus.FORMAT_ERROR.value
    saved = json.loads(output_path.read_text(encoding="utf-8"))
    assert saved["info"]["format_errors"] == 3
    assert saved["info"]["consecutive_format_errors"] == 3
