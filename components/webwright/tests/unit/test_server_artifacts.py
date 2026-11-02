from __future__ import annotations

import json
from pathlib import Path

from webwright.server import artifacts
from webwright.server.status import AgentExitStatus, StepStatus


def test_read_json_with_retries_tolerates_transient_bad_json(monkeypatch, tmp_path: Path) -> None:
    path = tmp_path / "step.json"
    path.write_text("{bad", encoding="utf-8")
    sleeps = 0

    def fake_sleep(delay: float) -> None:
        nonlocal sleeps
        sleeps += 1
        path.write_text('{"ok": true}', encoding="utf-8")

    monkeypatch.setattr(artifacts.time, "sleep", fake_sleep)

    assert artifacts.read_json_with_retries(path) == {"ok": True}
    assert sleeps == 1


def test_environment_runtime_state_reads_trajectory_target(tmp_path: Path) -> None:
    output_dir = tmp_path / "task"
    output_dir.mkdir()
    (output_dir / "trajectory.json").write_text(
        json.dumps(
            {
                "environment": {
                    "runtime_state": {
                        "target_id": "target-1",
                        "last_url": "https://example.com/",
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    state = artifacts.environment_runtime_state(output_dir)

    assert state["target_id"] == "target-1"


def test_read_steps_falls_back_to_step_file_when_debug_json_is_bad(tmp_path: Path) -> None:
    output_dir = tmp_path / "task"
    (output_dir / "debug" / "steps").mkdir(parents=True)
    (output_dir / "steps").mkdir(parents=True)
    (output_dir / "debug" / "steps" / "step_0001.json").write_text("{bad", encoding="utf-8")
    (output_dir / "steps" / "step_0001.py").write_text("await page.goto('https://example.com')\n", encoding="utf-8")

    steps = artifacts.read_steps("task_1", output_dir)

    assert len(steps) == 1
    assert steps[0]["code"] == "await page.goto('https://example.com')\n"
    assert steps[0]["status"] == StepStatus.UNKNOWN.value


def test_read_steps_prefers_observed_executed_code_over_model_debug_code(tmp_path: Path) -> None:
    output_dir = tmp_path / "task"
    (output_dir / "debug" / "steps").mkdir(parents=True)
    (output_dir / "steps").mkdir(parents=True)
    executed = (
        'await page.goto("https://example.com/", wait_until="domcontentloaded")\n'
        "print(page.url)"
    )
    (output_dir / "steps" / "step_0001.py").write_text(executed, encoding="utf-8")
    (output_dir / "debug" / "steps" / "step_0001.json").write_text(
        json.dumps(
            {
                "python_code": "print(page.url)",
                "outputs": [{"returncode": 0, "observation": {"python_code": executed}}],
                "done": False,
            }
        ),
        encoding="utf-8",
    )

    steps = artifacts.read_steps("task_1", output_dir)

    assert steps[0]["code"] == executed


def test_read_steps_derives_enum_statuses_from_debug_artifacts(tmp_path: Path) -> None:
    output_dir = tmp_path / "task"
    debug_steps = output_dir / "debug" / "steps"
    debug_steps.mkdir(parents=True)
    payloads = {
        1: {"outputs": [{"returncode": 0, "observation": {}}], "done": False},
        2: {"outputs": [{"returncode": 1, "observation": {}}], "done": False},
        3: {"outputs": [], "done": True},
    }
    for step, payload in payloads.items():
        (debug_steps / f"step_{step:04d}.json").write_text(json.dumps(payload), encoding="utf-8")

    steps = artifacts.read_steps("task_1", output_dir)

    assert [step["status"] for step in steps] == [
        StepStatus.OK.value,
        StepStatus.ERROR.value,
        StepStatus.DONE.value,
    ]


def test_read_messages_flags_observation_and_interrupt_kind(tmp_path: Path) -> None:
    output_dir = tmp_path / "task"
    output_dir.mkdir()
    (output_dir / "trajectory.json").write_text(
        json.dumps(
            {
                "messages": [
                    {"role": "system", "content": "System prompt", "extra": {}},
                    {"role": "user", "content": "Initial instruction", "extra": {"timestamp": "2026-07-16T10:00:00+00:00"}},
                    {"role": "assistant", "content": "Thinking...", "extra": {"timestamp": "2026-07-16T10:00:05+00:00"}},
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "Observation text"},
                            {"type": "input_image", "image_url": "data:image/png;base64,AAA"},
                        ],
                        "extra": {
                            "observation": {"screenshot_path": "x.png"},
                            "timestamp": "2026-07-16T10:00:06+00:00",
                        },
                    },
                    {
                        "role": "user",
                        "content": "## Follow-up Instruction\n...\n\nplease continue",
                        "extra": {
                            "interrupt_type": "ResumeFollowup",
                            "user_input": "please continue",
                            "timestamp": "2026-07-16T10:01:00+00:00",
                        },
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    messages = artifacts.read_messages(output_dir)

    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user", "user"]
    assert [m["has_observation"] for m in messages] == [False, False, False, True, False]
    assert [m["kind"] for m in messages] == ["", "", "", "", "ResumeFollowup"]
    assert messages[0]["timestamp"] == ""
    assert messages[1]["timestamp"] == "2026-07-16T10:00:00+00:00"
    assert messages[4]["user_input"] == "please continue"
    assert messages[3]["user_input"] == ""
    observation = messages[3]
    assert isinstance(observation["content"], list)
    assert observation["content"][1]["image_url"] == "<omitted:data-url>"


def test_exit_status_reads_last_exit_message(tmp_path: Path) -> None:
    output_dir = tmp_path / "task"
    output_dir.mkdir()
    (output_dir / "trajectory.json").write_text(
        json.dumps(
            {
                "messages": [
                    {"role": "user", "content": "Task", "extra": {}},
                    {
                        "role": "exit",
                        "content": "paused",
                        "extra": {"exit_status": AgentExitStatus.PAUSED.value, "final_response": ""},
                    },
                ]
            }
        ),
        encoding="utf-8",
    )

    assert artifacts.exit_status(output_dir) == (AgentExitStatus.PAUSED.value, "")


def test_resumed_steps_keep_action_output_and_screenshot_together(tmp_path: Path) -> None:
    (tmp_path / "steps").mkdir()
    (tmp_path / "debug" / "steps").mkdir(parents=True)
    (tmp_path / "screenshots").mkdir()
    for index, code in ((1, "print('first')"), (2, "print('second')")):
        (tmp_path / "steps" / f"step_{index:04d}.py").write_text(code, encoding="utf-8")
        (tmp_path / "screenshots" / f"step_{index:04d}.png").write_bytes(b"placeholder")
        # An interrupted response consumed model turn 1 before execution began.
        payload = {
            "python_code": code,
            "outputs": [{"returncode": 0, "output": str(index), "observation": {
                "python_code": code,
                "python_output": str(index),
                "screenshot_path": str(tmp_path / "screenshots" / f"step_{index:04d}.png"),
            }}],
        }
        (tmp_path / "debug" / "steps" / f"step_{index + 1:04d}.json").write_text(
            json.dumps(payload), encoding="utf-8",
        )
    steps = artifacts.read_steps("task_1", tmp_path)
    assert [step["step"] for step in steps] == [2, 3]  # no phantom orphan step 1
    assert [step["execution_step"] for step in steps] == [1, 2]
    for index, step in enumerate(steps, 1):
        assert step["code"] == step["observation"]["python_code"]
        assert step["output"] == str(index)
        assert step["screenshot_url"].endswith(f"/screenshots/step_{index:04d}.png")


def test_no_same_number_file_fallback_without_execution_provenance(tmp_path: Path) -> None:
    (tmp_path / "steps").mkdir()
    (tmp_path / "debug" / "steps").mkdir(parents=True)
    (tmp_path / "steps" / "step_0001.py").write_text("print('unrelated')", encoding="utf-8")
    (tmp_path / "debug" / "steps" / "step_0001.json").write_text(json.dumps({
        "python_code": "print('model action')", "outputs": [],
    }), encoding="utf-8")
    step = artifacts.read_steps("task_1", tmp_path)[0]
    assert step["code"] == "print('model action')"
    assert step["execution_step"] is None
    assert step["status"] == StepStatus.UNKNOWN.value
    assert step["screenshot_url"] == ""


def test_explicit_execution_index_disambiguates_repeated_code(tmp_path: Path) -> None:
    (tmp_path / "steps").mkdir()
    (tmp_path / "debug" / "steps").mkdir(parents=True)
    for index in (1, 2):
        (tmp_path / "steps" / f"step_{index:04d}.py").write_text("print('repeat')", encoding="utf-8")
        (tmp_path / "debug" / "steps" / f"step_{index + 2:04d}.json").write_text(json.dumps({
            "python_code": "print('model')", "outputs": [{"returncode": 0, "observation": {
                "execution_step": index, "python_code": "print('repeat')", "screenshot_path": "",
            }}],
        }), encoding="utf-8")
    steps = artifacts.read_steps("task_1", tmp_path)
    assert [step["step"] for step in steps] == [3, 4]
    assert [step["execution_step"] for step in steps] == [1, 2]
    assert all(step["code"] == "print('repeat')" for step in steps)


def test_screenshot_outside_task_is_not_exposed(tmp_path: Path) -> None:
    root = tmp_path / "task"
    (root / "debug" / "steps").mkdir(parents=True)
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"placeholder")
    (root / "debug" / "steps" / "step_0001.json").write_text(json.dumps({
        "outputs": [{"observation": {"execution_step": 1, "screenshot_path": str(outside)}}],
    }), encoding="utf-8")
    assert artifacts.read_steps("task_1", root)[0]["screenshot_url"] == ""
