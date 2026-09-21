from __future__ import annotations

import os
import sys
import threading
from collections.abc import Callable
from typing import BinaryIO, Protocol


class ManagedServer(Protocol):
    def shutdown(self) -> None: ...

    def server_close(self) -> None: ...


class ManagedProcessManager(Protocol):
    def shutdown(self) -> None: ...


def process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        return _windows_process_exists(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _windows_process_exists(pid: int) -> bool:
    # os.kill(pid, 0) is NOT a harmless probe on Windows: it can terminate pid.
    # A synchronization handle lets us query exit state without sending a signal.
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:  # ERROR_INVALID_PARAMETER: process no longer exists
            return False
        if error == 5:  # ERROR_ACCESS_DENIED: do not treat protected processes as dead
            return True
        raise ctypes.WinError(error)
    try:
        state = kernel32.WaitForSingleObject(handle, 0)
        if state == 0x00000102:  # WAIT_TIMEOUT: process has not exited
            return True
        if state == 0:  # WAIT_OBJECT_0: process exited
            return False
        raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel32.CloseHandle(handle)


class ParentProcessWatchdog:
    def __init__(
        self,
        *,
        parent_pid: int,
        on_parent_exit: Callable[[], None],
        process_exists: Callable[[int], bool] = process_exists,
        interval: float = 1.0,
    ) -> None:
        self.parent_pid = parent_pid
        self.on_parent_exit = on_parent_exit
        self.process_exists = process_exists
        self.interval = interval
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="webwright-parent-watchdog",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(1.0, self.interval * 2))

    def _run(self) -> None:
        while not self._stop_event.wait(self.interval):
            if not self.process_exists(self.parent_pid):
                self.on_parent_exit()
                return


class StdinCloseWatchdog:
    def __init__(
        self,
        *,
        on_stdin_close: Callable[[], None],
        stream: BinaryIO | None = None,
    ) -> None:
        self.on_stdin_close = on_stdin_close
        self.stream = stream or sys.stdin.buffer
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="webwright-stdin-watchdog",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()

    def _run(self) -> None:
        while not self._stopped.is_set():
            if self.stream.read(1) == b"":
                if not self._stopped.is_set():
                    self.on_stdin_close()
                return


class ServerLifecycle:
    def __init__(
        self,
        *,
        server: ManagedServer,
        process_manager: ManagedProcessManager,
    ) -> None:
        self.server = server
        self.process_manager = process_manager
        self._stop_lock = threading.Lock()
        self._stopped = False
        self._closed = False

    def stop(self) -> None:
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
        try:
            self.process_manager.shutdown()
        finally:
            self.server.shutdown()

    def close(self) -> None:
        with self._stop_lock:
            if self._closed:
                return
            self._closed = True
            already_stopped = self._stopped
            self._stopped = True
        try:
            if not already_stopped:
                self.process_manager.shutdown()
        finally:
            self.server.server_close()


__all__ = [
    "ParentProcessWatchdog",
    "ServerLifecycle",
    "StdinCloseWatchdog",
    "process_exists",
]
