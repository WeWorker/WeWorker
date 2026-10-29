from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from webwright.paths import WebwrightPaths
from webwright.resources import BundledResources
from webwright.runtime_launcher import RuntimeLauncher


def test_webwright_paths_default_and_override(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "user")
    default = WebwrightPaths.resolve(environ={})
    overridden = WebwrightPaths.resolve(
        environ={"WEBWRIGHT_HOME": str(tmp_path / "custom")}
    )

    assert default.home == (tmp_path / "user" / ".weworker" / "webwright").resolve()
    assert overridden.tasks == (tmp_path / "custom" / "tasks").resolve()
    assert overridden.toolkits == overridden.home / "toolkits"
    assert overridden.browser_profile == overridden.home / "browser" / "profile"
    assert overridden.toolkit_state == overridden.home / "toolkit-state"


def test_webwright_paths_rejects_relative_override() -> None:
    with pytest.raises(ValueError, match="absolute"):
        WebwrightPaths.resolve(environ={"WEBWRIGHT_HOME": "relative/path"})


def test_webwright_paths_ensure_creates_private_directories(tmp_path: Path) -> None:
    paths = WebwrightPaths.resolve(home=tmp_path / "home").ensure()

    assert paths.tasks.is_dir()
    assert paths.toolkits.is_dir()
    assert paths.browser_profile.is_dir()
    if os.name != "nt":
        assert stat.S_IMODE(paths.home.stat().st_mode) == 0o700


def test_runtime_launcher_source_and_frozen_commands(tmp_path: Path) -> None:
    spec = tmp_path / "spec.json"
    script = tmp_path / "toolkit.py"
    source = RuntimeLauncher(executable="python-test", frozen=False)
    frozen = RuntimeLauncher(executable="webwright-test", frozen=True)

    assert source.worker_command("tool-debug", spec) == [
        "python-test",
        "-m",
        "webwright.run.tool_debug",
        "--spec",
        str(spec.resolve()),
    ]
    assert frozen.worker_command("local-cdp-task", spec) == [
        "webwright-test",
        "--internal-worker",
        "local-cdp-task",
        "--spec",
        str(spec.resolve()),
    ]
    assert frozen.script_command(script, ["--help"]) == [
        "webwright-test",
        "--internal-script",
        str(script.resolve()),
        "--help",
    ]
    with pytest.raises(ValueError, match="Unsupported"):
        source.worker_command("unknown", spec)


def test_runtime_launcher_separates_internal_and_external_environment(
    monkeypatch, tmp_path: Path
) -> None:
    bundle = tmp_path / "bundle"
    monkeypatch.setattr("webwright.runtime_launcher.sys._MEIPASS", str(bundle), raising=False)
    launcher = RuntimeLauncher(frozen=True)
    environment = {
        "PATH": os.pathsep.join((str(bundle), "/usr/bin")),
        "LD_LIBRARY_PATH": str(bundle),
        "LD_LIBRARY_PATH_ORIG": "/usr/lib",
        "TOKEN": "secret",
    }

    internal = launcher.internal_worker_environment(environ=environment)
    external = launcher.external_process_environment(environ=environment)

    assert internal["LD_LIBRARY_PATH"] == str(bundle)
    assert external["LD_LIBRARY_PATH"] == "/usr/lib"
    assert external["PATH"] == "/usr/bin"
    assert external["TOKEN"] == "secret"


def test_internal_worker_environment_exempts_loopback_from_proxy(
    monkeypatch,
) -> None:
    launcher = RuntimeLauncher()
    proxied = {
        "HTTP_PROXY": "http://127.0.0.1:7890",
        "HTTPS_PROXY": "http://127.0.0.1:7890",
    }
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("HTTPS_PROXY", raising=False)

    injected = launcher.internal_worker_environment(environ=proxied)

    assert injected["HTTP_PROXY"] == "http://127.0.0.1:7890"
    for host in ("127.0.0.1", "localhost", "::1"):
        assert host in injected["NO_PROXY"].split(",")
        assert host in injected["no_proxy"].split(",")

    preserved = launcher.internal_worker_environment(
        environ={**proxied, "NO_PROXY": "corp.example.com", "no_proxy": "corp.example.com"}
    )
    assert preserved["NO_PROXY"] == "corp.example.com,127.0.0.1,localhost,::1"

    untouched = launcher.internal_worker_environment(environ={"PATH": "/usr/bin"})
    assert "NO_PROXY" not in untouched
    assert "no_proxy" not in untouched


def test_bundled_resources_are_readable() -> None:
    resources = BundledResources()

    assert resources.builtin_config("base.yaml").is_file()
    runtime = resources.canonical_toolkit_runtime()
    assert "class PublishedToolkitRunner" in runtime
