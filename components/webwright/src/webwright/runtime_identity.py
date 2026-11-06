from __future__ import annotations

import json
import hashlib
import platform
import sys
from dataclasses import dataclass
from pathlib import Path

from webwright import __version__


def _architecture() -> str:
    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    if machine in {"amd64", "x86_64"}:
        return "x64"
    return machine


def source_build_id(root: Path) -> str:
    digest = hashlib.sha256()
    sources = sorted((root / "src" / "webwright").rglob("*.py"))
    lockfile = root / "uv.lock"
    for path in [*sources, *([lockfile] if lockfile.is_file() else [])]:
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()


@dataclass(frozen=True)
class RuntimeIdentity:
    version: str
    platform: str
    arch: str
    mode: str
    build: str = ""

    @classmethod
    def resolve(
        cls,
        *,
        executable: Path | str | None = None,
        frozen: bool | None = None,
    ) -> "RuntimeIdentity":
        is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
        executable_path = Path(executable or sys.executable).expanduser().resolve()
        manifest_path = executable_path.parent / "webwright-runtime.json"
        if is_frozen and manifest_path.is_file():
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Webwright runtime manifest must be a JSON object.")
            return cls(
                version=str(payload.get("webwright_version") or ""),
                platform=str(payload.get("platform") or ""),
                arch=str(payload.get("arch") or ""),
                mode=str(payload.get("mode") or ""),
                build=str(payload.get("build_id") or ""),
            )
        return cls(
            version=__version__,
            platform=sys.platform,
            arch=_architecture(),
            mode="standalone" if is_frozen else "source",
            build="" if is_frozen else source_build_id(Path(__file__).resolve().parents[2]),
        )

    def as_health_fields(self) -> dict[str, str]:
        return {
            "version": self.version,
            "platform": self.platform,
            "arch": self.arch,
            "mode": self.mode,
            "build": self.build,
        }


__all__ = ["RuntimeIdentity"]
