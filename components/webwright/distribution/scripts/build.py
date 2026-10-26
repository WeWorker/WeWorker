from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from importlib.metadata import distribution as package_distribution
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST_ROOT = ROOT / "distribution"
ENTRY = DIST_ROOT / "scripts" / "webwright_entry.py"
CPYTHON_LICENSE = DIST_ROOT / "licenses" / "CPython-3.14.6-LICENSE.txt"

RUNTIME_DISTRIBUTIONS = {
    "annotated-doc": "MIT",
    "annotated-types": "MIT",
    "anyio": "MIT",
    "blinker": "MIT",
    "certifi": "MPL-2.0",
    "click": "BSD-3-Clause",
    "flask": "BSD-3-Clause",
    "greenlet": "MIT AND PSF-2.0",
    "h11": "MIT",
    "httpcore": "BSD-3-Clause",
    "httpx": "BSD-3-Clause",
    "idna": "BSD-3-Clause",
    "itsdangerous": "BSD-3-Clause",
    "jinja2": "BSD-3-Clause",
    "markdown-it-py": "MIT",
    "markupsafe": "BSD-3-Clause",
    "mdurl": "MIT",
    "packaging": "Apache-2.0 OR BSD-2-Clause",
    "playwright": "Apache-2.0",
    "pydantic": "MIT",
    "pydantic-core": "MIT",
    "pyee": "MIT",
    "pygments": "BSD-2-Clause",
    "python-dotenv": "BSD-3-Clause",
    "pyyaml": "MIT",
    "rich": "MIT",
    "setuptools": "MIT",
    "shellingham": "ISC",
    "typer": "MIT",
    "typing-extensions": "PSF-2.0",
    "typing-inspection": "MIT",
    "webwright": "MIT",
    "werkzeug": "BSD-3-Clause",
}

BUILD_RUNTIME_DISTRIBUTIONS = {
    "pyinstaller": "GPL-2.0-or-later WITH Bootloader-exception",
    "pyinstaller-hooks-contrib": "GPL-2.0-or-later AND Apache-2.0",
}


def _macos_architecture() -> str:
    machine = platform.machine().lower()
    return "arm64" if machine in {"arm64", "aarch64"} else machine


def _distribution_architecture() -> str:
    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    if machine in {"amd64", "x86_64"}:
        return "x64"
    return machine


def _runtime_manifest() -> dict[str, object]:
    from webwright.runtime_identity import source_build_id

    return {
        "webwright_version": version("webwright"),
        "platform": sys.platform,
        "arch": _distribution_architecture(),
        "mode": "embedded",
        "entrypoint": "Webwright.exe" if sys.platform == "win32" else "Webwright",
        "build_id": source_build_id(ROOT),
    }


def _license_files(distribution_name: str, target_root: Path) -> list[Path]:
    package = package_distribution(distribution_name)
    copied = []
    for item in package.files or ():
        relative = Path(str(item))
        filename = relative.name.lower()
        if not any(marker in filename for marker in ("license", "copying", "notice")):
            continue
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(
                f"Unsafe license path for {distribution_name}: {relative}"
            )
        source = Path(package.locate_file(item))
        if not source.is_file():
            continue
        target = target_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        copied.append(target.relative_to(target_root))
    if not copied:
        raise RuntimeError(f"No license files found for {distribution_name}.")
    return sorted(copied)


def _collect_third_party_licenses(runtime_dir: Path) -> None:
    licenses_root = runtime_dir / "licenses"
    licenses_root.mkdir(parents=True, exist_ok=True)
    if not CPYTHON_LICENSE.is_file():
        raise RuntimeError(f"Missing CPython license source: {CPYTHON_LICENSE}")
    cpython_target = licenses_root / "CPython-3.14.6" / "LICENSE.txt"
    cpython_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(CPYTHON_LICENSE, cpython_target)

    notices = [
        "WeWorker Embedded Webwright Third-Party Notices",
        "=================================================",
        "",
        "This product includes modified software derived from Microsoft Webwright.",
        "WeWorker is not affiliated with or endorsed by Microsoft.",
        "",
        "CPython==3.14.6",
        "License: PSF-2.0",
        "Source code: https://github.com/python/cpython/tree/v3.14.6",
        "License files:",
        "  licenses/CPython-3.14.6/LICENSE.txt",
        "",
    ]
    distributions = RUNTIME_DISTRIBUTIONS | BUILD_RUNTIME_DISTRIBUTIONS
    for name, license_expression in distributions.items():
        package_version = package_distribution(name).version
        directory = licenses_root / f"{name}-{package_version}"
        copied = _license_files(name, directory)
        source_url = f"https://pypi.org/project/{name}/{package_version}/#files"
        if name == "webwright":
            source_url = "https://github.com/microsoft/Webwright"
        notices.extend(
            (
                f"{name}=={package_version}",
                f"License: {license_expression}",
                f"Source code: {source_url}",
                "License files:",
                *(f"  licenses/{name}-{package_version}/{path.as_posix()}" for path in copied),
                "",
            )
        )
        if name == "certifi":
            notices.extend(
                (
                    "certifi Source Code Form:",
                    f"  {source_url}",
                    "The exact-version source distribution is available from the URL above",
                    "under the Mozilla Public License 2.0.",
                    "",
                )
            )

    (runtime_dir / "THIRD_PARTY_NOTICES.txt").write_text(
        "\n".join(notices),
        encoding="utf-8",
    )


def _finalize_embedded_runtime(runtime_dir: Path) -> Path:
    if not runtime_dir.is_dir():
        raise RuntimeError(f"PyInstaller did not create {runtime_dir}.")
    shutil.copyfile(ROOT / "LICENSE", runtime_dir / "LICENSE.webwright")
    _collect_third_party_licenses(runtime_dir)
    (runtime_dir / "webwright-runtime.json").write_text(
        json.dumps(_runtime_manifest(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return runtime_dir


def _create_macos_dmg(*, app_path: Path, dist: Path) -> Path:
    dmg_path = dist / f"Webwright-macos-{_macos_architecture()}.dmg"
    with tempfile.TemporaryDirectory(prefix="webwright-dmg-") as temporary:
        staging = Path(temporary)
        subprocess.run(
            ["ditto", str(app_path), str(staging / app_path.name)],
            check=True,
        )
        subprocess.run(
            [
                "hdiutil",
                "create",
                "-volname",
                "Webwright",
                "-srcfolder",
                str(staging),
                "-ov",
                "-format",
                "UDZO",
                str(dmg_path),
            ],
            check=True,
        )
    return dmg_path


def _find_inno_compiler() -> Path:
    if resolved := shutil.which("ISCC.exe") or shutil.which("ISCC"):
        return Path(resolved).resolve()
    candidates = []
    for variable in ("PROGRAMFILES(X86)", "PROGRAMFILES"):
        if root := os.environ.get(variable):
            candidates.append(Path(root) / "Inno Setup 6" / "ISCC.exe")
    if local_app_data := os.environ.get("LOCALAPPDATA"):
        candidates.append(
            Path(local_app_data) / "Programs" / "Inno Setup 6" / "ISCC.exe"
        )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        "Inno Setup 6 compiler ISCC.exe was not found in PATH or a standard "
        "installation directory."
    )


def _create_windows_installer(*, onedir_path: Path, dist: Path) -> Path:
    machine = platform.machine().lower()
    if machine not in {"amd64", "x86_64"}:
        raise RuntimeError(f"Windows x64 builds require an x64 Python; got {machine}.")
    installer_path = dist / "Webwright-windows-x64-Setup.exe"
    subprocess.run(
        [
            str(_find_inno_compiler()),
            f"/DMyAppSource={onedir_path}",
            f"/DMyOutputDir={dist}",
            str(DIST_ROOT / "windows" / "Webwright.iss"),
        ],
        check=True,
        cwd=DIST_ROOT / "windows",
    )
    if not installer_path.is_file():
        raise RuntimeError(f"Inno Setup did not create {installer_path}.")
    return installer_path


def _windows_version_file(spec: Path) -> Path:
    """Create the Windows VERSIONINFO resource used by the embedded runtime."""
    raw_version = version("webwright")
    parts = [int(part) for part in raw_version.split(".")[:3] if part.isdigit()]
    while len(parts) < 3:
        parts.append(0)
    version_tuple = (*parts[:3], 0)
    version_file = spec / "WeWorker-version.txt"
    version_file.parent.mkdir(parents=True, exist_ok=True)
    version_file.write_text(
        f'''# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers={version_tuple},
    prodvers={version_tuple},
    mask=0x3f,
    flags=0x0,
    OS=0x4,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable(
        '040904B0',
        [StringStruct('CompanyName', 'WeWorker'),
         StringStruct('FileDescription', 'WeWorker 网站探索agent Runtime'),
         StringStruct('FileVersion', '{raw_version}'),
         StringStruct('InternalName', 'WeWorker Runtime'),
         StringStruct('OriginalFilename', 'Webwright.exe'),
         StringStruct('ProductName', 'WeWorker'),
         StringStruct('ProductVersion', '{raw_version}'),
         StringStruct('Comments', 'WeWorker 网站探索agent')]
      )
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
''',
        encoding="utf-8",
    )
    return version_file


def _pyinstaller_arguments(
    *, mode: str, work: Path, dist: Path, spec: Path
) -> list[str]:
    arguments = [
        str(ENTRY),
        "--name=Webwright",
        "--onedir",
        "--noconfirm",
        "--clean",
        f"--paths={ROOT / 'src'}",
        f"--workpath={work}",
        f"--distpath={dist}",
        f"--specpath={spec}",
        "--collect-all=playwright",
        (
            "--add-data="
            f"{ROOT / 'src' / 'webwright' / 'config'}"
            f"{os.pathsep}webwright/config"
        ),
        (
            "--add-data="
            f"{ROOT / 'src' / 'webwright' / 'server' / 'web'}"
            f"{os.pathsep}webwright/server/web"
        ),
        (
            "--add-data="
            f"{ROOT / 'src' / 'webwright' / 'tool_runtime' / 'toolkit_runtime.py'}"
            f"{os.pathsep}webwright/tool_runtime"
        ),
        "--hidden-import=webwright.agents.default",
        "--hidden-import=webwright.environments.local_browser",
        "--hidden-import=webwright.models.anthropic_model",
        "--hidden-import=webwright.models.openai_chat_model",
        "--hidden-import=webwright.models.openai_model",
        "--hidden-import=webwright.models.openrouter_model",
        "--hidden-import=webwright.models.zhipu_model",
        "--hidden-import=webwright.run.local_cdp_task",
        "--hidden-import=webwright.run.local_cdp_replay",
        "--hidden-import=webwright.run.tool_development",
        "--hidden-import=webwright.run.tool_debug",
    ]
    if sys.platform == "win32":
        arguments.append(f"--version-file={_windows_version_file(spec)}")
    if mode == "standalone" and sys.platform == "darwin":
        arguments.extend(
            ("--windowed", "--osx-bundle-identifier=ai.webwright.app")
        )
    return arguments


def main(argv: list[str] | None = None) -> int:
    import PyInstaller.__main__

    parser = argparse.ArgumentParser(description="Build the Webwright onedir distribution.")
    parser.add_argument("--output-root", type=Path, default=DIST_ROOT / "build")
    parser.add_argument(
        "--mode",
        choices=("standalone", "embedded"),
        default="standalone",
    )
    args = parser.parse_args(argv)
    output_root = args.output_root.expanduser().resolve()
    if sys.version_info[:3] != (3, 14, 6):
        raise RuntimeError("Distribution builds require CPython 3.14.6.")
    work = output_root / "work"
    dist = output_root / "dist"
    spec = output_root / "spec"
    for path in (work, dist, spec):
        if path.exists():
            shutil.rmtree(path)
    arguments = _pyinstaller_arguments(
        mode=args.mode,
        work=work,
        dist=dist,
        spec=spec,
    )
    PyInstaller.__main__.run(arguments)
    onedir = dist / "Webwright"
    if args.mode == "embedded":
        final_artifact = _finalize_embedded_runtime(onedir)
    elif sys.platform == "darwin":
        final_artifact = _create_macos_dmg(
            app_path=dist / "Webwright.app",
            dist=dist,
        )
    elif sys.platform == "win32":
        final_artifact = _create_windows_installer(
            onedir_path=onedir,
            dist=dist,
        )
    else:
        final_artifact = onedir
    print(final_artifact)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
