from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from webwright.server.records import atomic_write_json
from webwright.server.toolkit_store import ToolkitStore
from webwright.server.adapter_v2 import package_digest
from webwright.runtime_launcher import RuntimeLauncher
from webwright.tool_runtime.runner import ToolRunner
from webwright.tool_runtime.state import FileRuntimeStore


def _load_spec(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Debug spec must be a JSON object.")
    return payload


async def run_debug(spec: dict[str, Any]) -> dict[str, Any]:
    toolkit_id = str(spec["toolkit_id"])
    toolkit_root = Path(spec["toolkit_root"])
    toolkit_dir = toolkit_root / toolkit_id
    if spec["channel"] == "formal":
        runtime_store = FileRuntimeStore(toolkit_dir / "runtime.json")
        before_runtime = runtime_store.read()
        adapter_root = Path(spec["adapter_root"])
        files = {path.relative_to(adapter_root).as_posix(): path.read_bytes()
                 for path in adapter_root.rglob("*") if path.is_file()}
        if package_digest(files) != spec["distribution_hash"]:
            raise ValueError("Adapter snapshot changed before validation.")
        output = await _run_formal_cli(spec, adapter_root, toolkit_dir / "runtime.json")
        files = {path.relative_to(adapter_root).as_posix(): path.read_bytes()
                 for path in adapter_root.rglob("*") if path.is_file()}
        if package_digest(files) != spec["distribution_hash"]:
            raise ValueError("Adapter snapshot changed during validation.")
    else:
        store = ToolkitStore(toolkit_root)
        before_runtime = store.read_runtime(toolkit_id)
        output = await ToolRunner(store=store, cdp_url=str(spec["cdp_url"])).run(
            toolkit_id=toolkit_id,
            tool_id=str(spec["tool_id"]),
            channel="development",
            parameters=spec.get("parameters") or {},
            screenshot_path=Path(spec["screenshot_path"]),
        )
    before_page = {
        "url": str(before_runtime.get("last_url") or ""),
        "title": str(before_runtime.get("last_title") or ""),
    }
    result = {
        "ok": bool(output.get("ok")),
        "result": output.get("data") if output.get("ok") else {},
        "error": "" if output.get("ok") else str(
            (output.get("error") or {}).get("message", "Tool failed.")
            if isinstance(output.get("error"), dict) else output.get("error") or "Tool failed."
        ),
        "before_page": before_page,
        "after_page": output.get("page") or {"url": "", "title": ""},
    }
    atomic_write_json(Path(spec["result_path"]), result)
    return result


async def _run_formal_cli(
    spec: dict[str, Any], adapter_root: Path, runtime_path: Path
) -> dict[str, Any]:
    parameters = spec.get("parameters") or {}
    launcher = RuntimeLauncher()
    node = os.environ.get("WEWORKER_WEBCLI_NODE")
    entry = os.environ.get("WEWORKER_WEBCLI_ENTRY")
    if not node or not entry or not Path(node).is_file() or not Path(entry).is_file():
        raise RuntimeError("宿主 WebCLI 不可用，请从 WeWorker 启动网站探索服务。")
    command = [
        node, entry, "call", f"{adapter_root.name}.{str(spec['tool_id']).replace('_', '-')}",
        "--args", json.dumps(parameters, ensure_ascii=False), "--output-format=json",
    ]
    isolated = Path(spec["result_path"]).parent
    env = launcher.external_process_environment({
        "ELECTRON_RUN_AS_NODE": "1",
        "WEWORKER_ADAPTERS_DIR": str(isolated / "empty-adapters"),
        "WEWORKER_BUILTIN_ADAPTERS_DIR": str(adapter_root.parent),
        "WEWORKER_USER_ADAPTERS_DIR": str(isolated / "empty-adapters"),
        "WEBCLI_ADAPTERS_DIR": str(isolated / "empty-adapters"),
        "WEWORKER_ADAPTER_DATA_DIR": str(isolated / "host-data"),
        "WEWORKER_BUILD_PROFILE": str(spec["profile"]),
        "WEWORKER_TOOLKIT_RUNTIME": launcher.executable,
        "WEWORKER_TOOLKIT_RUNTIME_MODE": "embedded" if launcher.frozen else "python",
        "PYTHONIOENCODING": "utf-8",
        "WEBWRIGHT_CDP_URL": str(spec["cdp_url"]),
        "WEBWRIGHT_PARAMETERS_STDIN": "1",
        "WEBWRIGHT_SCREENSHOT_PATH": str(spec["screenshot_path"]),
        "WEBWRIGHT_RUNTIME_PATH": str(runtime_path),
    })
    listing = await asyncio.create_subprocess_exec(
        node, entry, "adapter", "list", "--json",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env, cwd=str(adapter_root),
    )
    listing_output, listing_error = await listing.communicate()
    if listing.returncode != 0:
        raise RuntimeError("Isolated Adapter catalog failed: " + listing_error.decode("utf-8", errors="replace"))
    entries = json.loads(listing_output)
    if not any(item.get("id") == adapter_root.name and item.get("digest") == spec["distribution_hash"] for item in entries):
        raise ValueError("Isolated catalog did not select the exact Adapter snapshot.")
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(adapter_root),
    )
    stdout, stderr = await process.communicate()
    if stderr:
        print(stderr.decode("utf-8", errors="replace"), end="", file=sys.stderr)
    text = stdout.decode("utf-8").strip()
    if not text:
        raise RuntimeError(f"Published CLI exited with code {process.returncode} without JSON output.")
    output = json.loads(text)
    if not isinstance(output, dict):
        raise ValueError("Published CLI output must be a JSON object.")
    if process.returncode != 0:
        output["ok"] = False
        output.setdefault("error", {"message": f"WebCLI exited with code {process.returncode}."})
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one Toolkit Tool Debug Run.")
    parser.add_argument("--spec", required=True, type=Path)
    args = parser.parse_args(argv)
    spec = None
    try:
        spec = _load_spec(args.spec)
        result = asyncio.run(run_debug(spec))
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr)
        if spec and spec.get("result_path"):
            try:
                atomic_write_json(Path(spec["result_path"]), result)
            except OSError:
                pass  # The process log retains the original error if persistence fails.
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
