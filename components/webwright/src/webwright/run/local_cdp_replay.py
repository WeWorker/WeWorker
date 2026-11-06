from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from webwright.environments.local_browser import LocalBrowserEnvironment
from webwright.server.records import atomic_write_json
from webwright.server.status import StepStatus
from webwright.tool_runtime.managed_browser import managed_browser_enabled


def _load_spec(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Replay spec must be a JSON object.")
    return payload


def _write_step(replay_output_dir: Path, step: int, payload: dict[str, Any]) -> None:
    steps_dir = replay_output_dir / "steps"
    steps_dir.mkdir(parents=True, exist_ok=True)
    (steps_dir / f"step_{step:04d}.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def _step_range(spec: dict[str, Any], task_output_dir: Path) -> list[int]:
    from_step = int(spec.get("from_step") or 1)
    to_step = spec.get("to_step")
    if to_step is None:
        latest = 0
        for path in (task_output_dir / "steps").glob("step_*.py"):
            try:
                latest = max(latest, int(path.stem.removeprefix("step_")))
            except ValueError:
                continue
        to_step = latest
    return list(range(from_step, int(to_step) + 1))


def run_replay(spec: dict[str, Any]) -> int:
    task_output_dir = Path(spec["task_output_dir"]).expanduser().resolve()
    replay_output_dir = Path(spec["replay_output_dir"]).expanduser().resolve()
    replay_output_dir.mkdir(parents=True, exist_ok=True)
    env = LocalBrowserEnvironment(
        output_dir=replay_output_dir,
        browser_mode="local_cdp",
        local_cdp_url=str(spec.get("cdp_url") or "http://127.0.0.1:9222"),
        local_cdp_new_page=True,
        local_cdp_auto_start=not managed_browser_enabled(),
    )
    failed = False
    try:
        env.prepare(
            task=f"Replay {spec.get('task_id', '')}",
            task_id=spec.get("task_id", ""),
            start_url=str(spec.get("start_url") or ""),
            replay_target_id=(
                "" if bool(spec.get("new_tab", True)) else str(spec.get("target_id") or "")
            ),
        )
        runtime_state = env.serialize().get("environment", {}).get("runtime_state", {})
        atomic_write_json(
            replay_output_dir / "runtime.json",
            runtime_state if isinstance(runtime_state, dict) else {},
        )
        delay_seconds = max(0, int(spec.get("delay_ms") or 0)) / 1000
        for step in _step_range(spec, task_output_dir):
            step_path = task_output_dir / "steps" / f"step_{step:04d}.py"
            if not step_path.is_file():
                payload = {"step": step, "status": "missing", "error": f"Step file not found: {step_path}"}
                _write_step(replay_output_dir, step, payload)
                failed = True
                break
            code = step_path.read_text(encoding="utf-8")
            output = env.execute({"python_code": code})
            status = (
                StepStatus.OK.value
                if output.get("returncode") == 0
                else StepStatus.ERROR.value
            )
            payload = {
                "step": step,
                "status": status,
                "returncode": output.get("returncode"),
                "output": output.get("output", ""),
                "exception": output.get("exception_info", ""),
                "observation": output.get("observation", {}),
            }
            _write_step(replay_output_dir, step, payload)
            if status != StepStatus.OK.value:
                failed = True
                break
            if delay_seconds:
                time.sleep(delay_seconds)
    finally:
        env.close()
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay local CDP Webwright step files.")
    parser.add_argument("--spec", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        return run_replay(_load_spec(args.spec))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
