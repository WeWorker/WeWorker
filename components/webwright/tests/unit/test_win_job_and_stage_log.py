from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from webwright.server.process_manager import ProcessManager
from webwright.server.win_job import WindowsJobObject
from webwright.tool_runtime.toolkit_runtime import _emit_stage


def _pid_alive_windows(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object test")
def test_windows_job_object_kills_orphaned_grandchild_after_parent_exits(tmp_path: Path) -> None:
    pid_file = tmp_path / "grandchild.pid"
    parent_script = (
        "import subprocess, sys, pathlib\n"
        f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(p.pid), encoding='utf-8')\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", parent_script],
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    job = WindowsJobObject.attach(parent)
    assert job is not None
    setattr(parent, "_win_job", job)

    # Wait for parent to spawn grandchild and exit on its own (simulating parent
    # exiting quickly on CTRL_BREAK while grandchild stays alive).
    parent.wait(timeout=10)
    deadline = time.monotonic() + 5
    while not pid_file.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    grandchild_pid = int(pid_file.read_text(encoding="utf-8").strip())
    assert _pid_alive_windows(grandchild_pid)

    # Force-terminating the process tree via ProcessManager must kill the orphaned grandchild.
    ProcessManager._terminate_process_tree(parent, force=True)
    assert getattr(parent, "_win_job") is None

    deadline = time.monotonic() + 5
    while _pid_alive_windows(grandchild_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _pid_alive_windows(grandchild_pid)


def test_emit_stage_respects_env_flag(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("WEBWRIGHT_STAGE_LOG", raising=False)
    _emit_stage("browser.acquiring")
    assert capsys.readouterr().err == ""

    monkeypatch.setenv("WEBWRIGHT_STAGE_LOG", "1")
    _emit_stage("tool.running", tool_id="list_api_keys")
    err = capsys.readouterr().err.strip()
    payload = json.loads(err)
    assert payload["source"] == "toolkit_runtime"
    assert payload["stage"] == "tool.running"
    assert payload["tool_id"] == "list_api_keys"
