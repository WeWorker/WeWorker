from __future__ import annotations

import json
import io
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from webwright.runtime_identity import RuntimeIdentity
from webwright.run.server_lifecycle import (
    ParentProcessWatchdog,
    ServerLifecycle,
    StdinCloseWatchdog,
    process_exists,
)


class FakeManager:
    def __init__(self) -> None:
        self.shutdown_calls = 0

    def shutdown(self) -> None:
        self.shutdown_calls += 1


def test_process_probe_does_not_terminate_live_process() -> None:
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        for _ in range(3):
            assert process_exists(child.pid) is True
            time.sleep(0.05)
            assert child.poll() is None
    finally:
        child.terminate()
        child.wait(timeout=5)
    assert process_exists(child.pid) is False


def test_process_probe_rejects_nonpositive_pids() -> None:
    assert process_exists(0) is False
    assert process_exists(-1) is False


class FakeServer:
    def __init__(self) -> None:
        self.shutdown_calls = 0
        self.close_calls = 0

    def shutdown(self) -> None:
        self.shutdown_calls += 1

    def server_close(self) -> None:
        self.close_calls += 1


def test_runtime_identity_reads_embedded_manifest(tmp_path: Path) -> None:
    executable = tmp_path / "Webwright"
    executable.touch()
    (tmp_path / "webwright-runtime.json").write_text(
        json.dumps(
            {
                "webwright_version": "0.1.0",
                "platform": "darwin",
                "arch": "arm64",
                "mode": "embedded",
            }
        ),
        encoding="utf-8",
    )

    identity = RuntimeIdentity.resolve(executable=executable, frozen=True)

    assert identity.as_health_fields() == {
        "version": "0.1.0",
        "platform": "darwin",
        "arch": "arm64",
        "mode": "embedded",
    }


def test_server_lifecycle_stop_is_idempotent() -> None:
    manager = FakeManager()
    server = FakeServer()
    lifecycle = ServerLifecycle(server=server, process_manager=manager)

    lifecycle.stop()
    lifecycle.stop()
    lifecycle.close()

    assert manager.shutdown_calls == 1
    assert server.shutdown_calls == 1
    assert server.close_calls == 1


def test_parent_watchdog_stops_when_parent_disappears() -> None:
    parent_alive = iter((True, False))
    stopped = threading.Event()
    watchdog = ParentProcessWatchdog(
        parent_pid=4321,
        on_parent_exit=stopped.set,
        process_exists=lambda _pid: next(parent_alive),
        interval=0.001,
    )

    watchdog.start()

    assert stopped.wait(timeout=1)
    watchdog.stop()


def test_stdin_watchdog_stops_on_eof() -> None:
    stopped = threading.Event()
    watchdog = StdinCloseWatchdog(
        on_stdin_close=stopped.set,
        stream=io.BytesIO(b""),
    )

    watchdog.start()

    assert stopped.wait(timeout=1)
    watchdog.stop()


def test_server_process_serves_health_and_releases_port_on_stdin_close(
    tmp_path: Path,
) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = int(listener.getsockname()[1])
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "webwright.run.server",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--parent-pid",
            str(os.getpid()),
            "--exit-on-stdin-close",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "WEBWRIGHT_HOME": str(tmp_path / "home")},
    )
    try:
        health = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/health", timeout=1
                ) as response:
                    health = json.load(response)
                break
            except OSError:
                time.sleep(0.1)
        assert health is not None
        assert health["ok"] is True
        assert health["mode"] == "source"
    finally:
        assert process.stdin is not None
        process.stdin.close()
        process.wait(timeout=10)

    with socket.socket() as probe:
        assert probe.connect_ex(("127.0.0.1", port)) != 0
