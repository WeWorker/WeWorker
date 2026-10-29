from __future__ import annotations

from importlib.resources import files
from pathlib import Path


class BundledResources:
    def __init__(self) -> None:
        self._package = files("webwright")

    def builtin_config(self, name: str) -> Path:
        return Path(str(self._package.joinpath("config", name)))

    def canonical_toolkit_runtime(self) -> str:
        return self._package.joinpath(
            "tool_runtime", "toolkit_runtime.py"
        ).read_text(encoding="utf-8")


__all__ = ["BundledResources"]
