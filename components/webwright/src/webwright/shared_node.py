"""Select the desktop-owned Node for final Windows distributions."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from typing import MutableMapping


def configure_shared_node(
    *,
    executable: Path | str | None = None,
    frozen: bool | None = None,
    platform: str | None = None,
    environ: MutableMapping[str, str] | None = None,
) -> Path | None:
    if not (getattr(sys, "frozen", False) if frozen is None else frozen):
        return None
    if (sys.platform if platform is None else platform) != "win32":
        return None
    runtime_root = Path(executable or sys.executable).resolve().parent
    manifest_file = runtime_root / "webwright-runtime.json"
    if not manifest_file.is_file():
        return None  # Standalone distributions retain Playwright's own Node.
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise RuntimeError("Invalid embedded runtime manifest.")
    policy = manifest.get("node_runtime")
    if policy is None:
        return None  # Raw onedir build, before desktop resource assembly.
    if (
        policy != "shared"
        or manifest.get("mode") != "embedded"
        or manifest.get("platform") != "win32"
        or manifest.get("arch") != "x64"
    ):
        raise RuntimeError("Invalid shared Node runtime configuration.")
    node = runtime_root.parent / "node-runtime" / "node.exe"
    if not node.is_file() or node.is_symlink():
        raise RuntimeError("Bundled Node runtime is missing; reinstall the application.")
    # Do not let a caller's environment select a different packaged executable.
    (os.environ if environ is None else environ)["PLAYWRIGHT_NODEJS_PATH"] = str(node)
    return node
