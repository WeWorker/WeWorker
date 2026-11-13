from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Mapping


WORKER_MODULES = {
    "local-cdp-task": "webwright.run.local_cdp_task",
    "local-cdp-replay": "webwright.run.local_cdp_replay",
    "tool-development": "webwright.run.tool_development",
    "tool-debug": "webwright.run.tool_debug",
}

_PROXY_ENV_NAMES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
_LOOPBACK_NO_PROXY_HOSTS = ("127.0.0.1", "localhost", "::1")


def _with_loopback_no_proxy(environment: dict[str, str]) -> dict[str, str]:
    # Playwright's Node transport honors proxy env vars but not the Windows
    # per-machine proxy bypass list, so with HTTP_PROXY set the worker's
    # connect_over_cdp("http://127.0.0.1:9222") goes through the proxy and the
    # proxy answers 400. Outbound model traffic must keep using the proxy, so
    # only exempt the loopback hosts.
    if not any(environment.get(name) for name in _PROXY_ENV_NAMES):
        return environment
    for name in ("NO_PROXY", "no_proxy"):
        entries = [
            item.strip()
            for item in str(environment.get(name, "")).split(",")
            if item.strip()
        ]
        for host in _LOOPBACK_NO_PROXY_HOSTS:
            if host not in entries:
                entries.append(host)
        environment[name] = ",".join(entries)
    return environment


class RuntimeLauncher:
    def __init__(
        self,
        *,
        executable: str | None = None,
        frozen: bool | None = None,
    ) -> None:
        self.executable = executable or sys.executable
        self.frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen

    def worker_command(self, worker_kind: str, spec_path: Path | str) -> list[str]:
        try:
            module = WORKER_MODULES[worker_kind]
        except KeyError as exc:
            raise ValueError(f"Unsupported internal worker: {worker_kind}") from exc
        resolved_spec = Path(spec_path).expanduser().resolve()
        if self.frozen:
            return [
                self.executable,
                "--internal-worker",
                worker_kind,
                "--spec",
                str(resolved_spec),
            ]
        return [self.executable, "-m", module, "--spec", str(resolved_spec)]

    def script_command(
        self, script_path: Path | str, arguments: list[str] | tuple[str, ...] = ()
    ) -> list[str]:
        resolved_script = Path(script_path).expanduser().resolve()
        if self.frozen:
            return [
                self.executable,
                "--internal-script",
                str(resolved_script),
                *arguments,
            ]
        return [self.executable, str(resolved_script), *arguments]

    def internal_worker_environment(
        self,
        extra: Mapping[str, str] | None = None,
        *,
        environ: Mapping[str, str] | None = None,
    ) -> dict[str, str]:
        result = dict(os.environ if environ is None else environ)
        if extra:
            result.update(extra)
        if (
            not self.frozen
            and sys.platform == "win32"
            and result.get("WEWORKER_BROWSER_MANAGED") == "1"
            and result.get("WEWORKER_WEBCLI_NODE")
        ):
            # Managed source workers use the host's working Node runtime. The
            # frozen distribution selects its bundled Node in shared_node.py.
            result["PLAYWRIGHT_NODEJS_PATH"] = result["WEWORKER_WEBCLI_NODE"]
            result["ELECTRON_RUN_AS_NODE"] = "1"
        return _with_loopback_no_proxy(result)

    def external_process_environment(
        self,
        extra: Mapping[str, str] | None = None,
        *,
        environ: Mapping[str, str] | None = None,
    ) -> dict[str, str]:
        result = dict(os.environ if environ is None else environ)
        for name in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
            original_name = f"{name}_ORIG"
            if original_name in result:
                original = result.pop(original_name)
                if original:
                    result[name] = original
                else:
                    result.pop(name, None)
        bundle_root = str(getattr(sys, "_MEIPASS", "") or "")
        if bundle_root and result.get("PATH"):
            resolved_bundle = Path(bundle_root).resolve()
            result["PATH"] = os.pathsep.join(
                entry
                for entry in result["PATH"].split(os.pathsep)
                if entry and not Path(entry).resolve().is_relative_to(resolved_bundle)
            )
        if extra:
            result.update(extra)
        return result


__all__ = ["RuntimeLauncher", "WORKER_MODULES"]
