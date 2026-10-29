from __future__ import annotations

import importlib.util
import json
from importlib.metadata import PackageNotFoundError
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]


def _build_module():
    path = ROOT / "distribution" / "scripts" / "build.py"
    spec = importlib.util.spec_from_file_location("webwright_distribution_build", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_distribution_has_no_legacy_installer_dependency() -> None:
    project = (ROOT / "distribution" / "pyproject.toml").read_text(encoding="utf-8")
    assert "webwright-distribution" in project
    assert "pyinstaller==6.21.0" in project
    assert 'path = "../installer"' not in project
    assert not (ROOT / "installer").exists()


def test_build_is_onedir_and_collects_runtime_assets() -> None:
    source = (ROOT / "distribution" / "scripts" / "build.py").read_text(
        encoding="utf-8"
    )
    assert '"--onedir"' in source
    assert 'f"--paths={ROOT / \'src\'}"' in source
    assert '"--collect-data=webwright"' not in source
    assert "ROOT / 'src' / 'webwright' / 'config'" in source
    assert "ROOT / 'src' / 'webwright' / 'server' / 'web'" not in source
    assert '"--collect-all=playwright"' in source
    assert '"--hidden-import=webwright.models.openai_chat_model"' in source
    assert "tool_runtime' / 'toolkit_runtime.py'" in source
    assert 'f"Webwright-macos-{_macos_architecture()}.dmg"' in source
    assert '"hdiutil"' in source
    assert '"UDZO"' in source
    assert '"Webwright-windows-x64-Setup.exe"' in source
    assert 'shutil.which("ISCC.exe")' in source
    assert '"/DMyAppSource=' in source
    assert '"--version-file=' in source
    assert "StringStruct('ProductName', 'WeWorker')" in source
    assert "StringStruct('CompanyName', 'WeWorker')" in source
    assert "StringStruct('FileDescription', 'WeWorker 网站探索agent Runtime')" in source
    installer = (ROOT / "distribution" / "windows" / "Webwright.iss").read_text(
        encoding="utf-8"
    )
    assert "OutputBaseFilename=Webwright-windows-x64-Setup" in installer
    assert "ArchitecturesAllowed=x64compatible" in installer
    assert "webwright.run.bootstrap" not in source
    entry = (
        ROOT / "distribution" / "scripts" / "webwright_entry.py"
    ).read_text(encoding="utf-8")
    assert "webwright.run.bootstrap" in entry


def test_windows_version_file_contains_weworker_identity(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    build = _build_module()
    monkeypatch.setattr(build, "version", lambda _name: "0.1.0")
    version_file = build._windows_version_file(tmp_path / "spec")
    contents = version_file.read_text(encoding="utf-8")
    assert "StringStruct('ProductName', 'WeWorker')" in contents
    assert "StringStruct('CompanyName', 'WeWorker')" in contents
    assert "StringStruct('InternalName', 'WeWorker Runtime')" in contents
    assert "StringStruct('OriginalFilename', 'Webwright.exe')" in contents


def test_embedded_build_keeps_raw_onedir_and_writes_runtime_manifest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    build = _build_module()
    monkeypatch.setattr(build.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(build.sys, "platform", "darwin")
    collected = []
    monkeypatch.setattr(
        build,
        "_collect_third_party_licenses",
        lambda runtime_dir: collected.append(runtime_dir),
    )

    arguments = build._pyinstaller_arguments(
        mode="embedded",
        work=tmp_path / "work",
        dist=tmp_path / "dist",
        spec=tmp_path / "spec",
    )
    runtime_dir = tmp_path / "dist" / "Webwright"
    runtime_dir.mkdir(parents=True)
    build._finalize_embedded_runtime(runtime_dir)

    assert "--windowed" not in arguments
    assert all("osx-bundle-identifier" not in argument for argument in arguments)
    manifest = json.loads(
        (runtime_dir / "webwright-runtime.json").read_text(encoding="utf-8")
    )
    assert manifest == {
        "arch": "arm64",
        "entrypoint": "Webwright",
        "mode": "embedded",
        "platform": "darwin",
        "webwright_version": "0.1.0",
        "build_id": build._runtime_manifest()["build_id"],
    }
    assert (runtime_dir / "LICENSE.webwright").read_text(encoding="utf-8").startswith(
        "    MIT License"
    )
    assert collected == [runtime_dir]


def test_locked_build_environment_collects_complete_license_bundle(
    tmp_path: Path,
) -> None:
    build = _build_module()
    for name in ("pyinstaller", "setuptools"):
        try:
            build.package_distribution(name)
        except PackageNotFoundError:
            pytest.skip("requires the distribution build environment")

    runtime_dir = tmp_path / "Webwright"
    runtime_dir.mkdir()
    build._collect_third_party_licenses(runtime_dir)

    notices = (runtime_dir / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
    assert "modified software derived from Microsoft Webwright" in notices
    assert "WeWorker is not affiliated with or endorsed by Microsoft" in notices
    assert "CPython==3.14.6" in notices
    pyinstaller_version = build.package_distribution("pyinstaller").version
    certifi_version = build.package_distribution("certifi").version
    assert f"pyinstaller=={pyinstaller_version}" in notices
    assert "GPL-2.0-or-later WITH Bootloader-exception" in notices
    assert f"certifi=={certifi_version}" in notices
    assert "certifi Source Code Form" in notices
    assert f"https://pypi.org/project/certifi/{certifi_version}/#files" in notices
    versions = {
        name: build.package_distribution(name).version
        for name in ("webwright", "playwright", "certifi", "pyinstaller", "setuptools")
    }
    required_licenses = [
        "licenses/CPython-3.14.6/LICENSE.txt",
        f"licenses/webwright-{versions['webwright']}/webwright-{versions['webwright']}.dist-info/licenses/LICENSE",
        f"licenses/playwright-{versions['playwright']}/playwright/driver/package/LICENSE",
        f"licenses/playwright-{versions['playwright']}/playwright/driver/package/NOTICE",
        f"licenses/playwright-{versions['playwright']}/playwright/driver/package/ThirdPartyNotices.txt",
        f"licenses/certifi-{versions['certifi']}/certifi-{versions['certifi']}.dist-info/licenses/LICENSE",
        f"licenses/pyinstaller-{versions['pyinstaller']}/pyinstaller-{versions['pyinstaller']}.dist-info/licenses/COPYING.txt",
    ]
    setuptools_licenses = runtime_dir / "licenses" / f"setuptools-{versions['setuptools']}"
    assert list(setuptools_licenses.glob("setuptools/_vendor/**/licenses/LICENSE*"))
    for relative_path in required_licenses:
        assert (runtime_dir / relative_path).is_file(), relative_path


def test_license_collection_rejects_dependency_without_license_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    build = _build_module()

    class UnlicensedPackage:
        files = []

    monkeypatch.setattr(build, "package_distribution", lambda _name: UnlicensedPackage())
    with pytest.raises(RuntimeError, match="No license files found"):
        build._license_files("certifi", tmp_path)


def test_standalone_macos_build_keeps_application_bundle_arguments(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    build = _build_module()
    monkeypatch.setattr(build.sys, "platform", "darwin")

    arguments = build._pyinstaller_arguments(
        mode="standalone",
        work=tmp_path / "work",
        dist=tmp_path / "dist",
        spec=tmp_path / "spec",
    )

    assert "--windowed" in arguments
    assert "--osx-bundle-identifier=ai.webwright.app" in arguments


def test_installers_preserve_webwright_home() -> None:
    macos = (ROOT / "distribution" / "macos" / "install.sh").read_text(
        encoding="utf-8"
    )
    windows = (ROOT / "distribution" / "windows" / "Webwright.iss").read_text(
        encoding="utf-8"
    )
    assert ".webwright" not in macos
    assert ".webwright" not in windows
    assert "PrivilegesRequired=lowest" in windows


def test_windows_installer_builder_returns_fixed_final_artifact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    build = _build_module()
    onedir = tmp_path / "dist" / "Webwright"
    onedir.mkdir(parents=True)
    compiler = tmp_path / "ISCC.exe"
    compiler.touch()
    calls: list[list[str]] = []

    monkeypatch.setattr(build.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(build, "_find_inno_compiler", lambda: compiler)

    def fake_run(command, **kwargs):
        calls.append(command)
        (tmp_path / "dist" / "Webwright-windows-x64-Setup.exe").touch()

    monkeypatch.setattr(build.subprocess, "run", fake_run)

    result = build._create_windows_installer(
        onedir_path=onedir,
        dist=tmp_path / "dist",
    )

    assert result.name == "Webwright-windows-x64-Setup.exe"
    assert calls[0][0] == str(compiler)
    assert f"/DMyAppSource={onedir}" in calls[0]


def test_windows_installer_builder_rejects_non_x64_python(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    build = _build_module()
    monkeypatch.setattr(build.platform, "machine", lambda: "ARM64")

    with pytest.raises(RuntimeError, match="x64 Python"):
        build._create_windows_installer(
            onedir_path=tmp_path / "Webwright",
            dist=tmp_path,
        )
