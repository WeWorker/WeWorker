from __future__ import annotations

import multiprocessing
import runpy
import sys
from pathlib import Path

from webwright.runtime_launcher import WORKER_MODULES
from webwright.shared_node import configure_shared_node


def _run_internal_worker(arguments: list[str]) -> int:
    if len(arguments) < 2:
        raise SystemExit("--internal-worker requires a worker kind.")
    worker_kind = arguments[1]
    try:
        module_name = WORKER_MODULES[worker_kind]
    except KeyError as exc:
        raise SystemExit(f"Unsupported internal worker: {worker_kind}") from exc
    module = __import__(module_name, fromlist=["main"])
    return int(module.main(arguments[2:]))


def _run_internal_script(arguments: list[str]) -> int:
    if len(arguments) < 2:
        raise SystemExit("--internal-script requires a script path.")
    script_path = Path(arguments[1]).expanduser().resolve()
    if not script_path.is_file():
        raise SystemExit(f"Internal script not found: {script_path}")
    original_argv = sys.argv
    original_path = list(sys.path)
    try:
        sys.argv = [str(script_path), *arguments[2:]]
        sys.path.insert(0, str(script_path.parent))
        try:
            runpy.run_path(str(script_path), run_name="__main__")
        except SystemExit as exc:
            if exc.code is None:
                return 0
            if isinstance(exc.code, int):
                return exc.code
            print(exc.code, file=sys.stderr)
            return 1
        return 0
    finally:
        sys.argv = original_argv
        sys.path[:] = original_path


def main() -> None:
    multiprocessing.freeze_support()
    configure_shared_node()
    arguments = sys.argv[1:]
    if arguments[:1] == ["--internal-worker"]:
        raise SystemExit(_run_internal_worker(arguments))
    if arguments[:1] == ["--internal-script"]:
        raise SystemExit(_run_internal_script(arguments))

    from webwright.run.server import app

    app()


if __name__ == "__main__":
    main()
