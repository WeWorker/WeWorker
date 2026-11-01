from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

import pytest

from webwright.run.tool_debug import run_debug
from webwright.server.debug_store import DebugRunStore
from webwright.server.publisher import ToolkitPublisher
from webwright.server.adapter_v2 import current_package
from webwright.server.package_workspace import prepare_apply, acknowledge_apply
from webwright.server.records import atomic_write_json
from webwright.runtime_launcher import RuntimeLauncher
from webwright.server.status import DebugRunStatus
from webwright.server.toolkit_store import ToolkitStore
from webwright.utils.local_cdp import DEFAULT_CDP_URL, page_targets


pytestmark = pytest.mark.skipif(
    os.environ.get("WEBWRIGHT_RUN_CDP_E2E") != "1",
    reason="set WEBWRIGHT_RUN_CDP_E2E=1 to run the real local_cdp distribution test",
)


def _close_target(target_id: str) -> None:
    if not target_id:
        return
    try:
        urllib.request.urlopen(
            f"{DEFAULT_CDP_URL}/json/close/{target_id}", timeout=2
        ).read()
    except Exception:
        pass


def test_publish_formal_debug_export_and_external_cli_real_cdp(tmp_path: Path) -> None:
    start_url = "https://example.com/?webwright-distribution-e2e=1"
    prepared_target = next(
        (
            str(target.get("id") or "")
            for target in page_targets(DEFAULT_CDP_URL)
            if target.get("url") == start_url
        ),
        "",
    )
    assert prepared_target, "the isolated example.com Agent browser tab must be prepared"
    created_targets = set()
    try:
        store = ToolkitStore(tmp_path / "toolkits")
        store.create_toolkit(
            name="distribution_e2e", allowed_domains=["example.com"]
        )
        store.create_tool(
            "distribution_e2e",
            name="inspect_page",
            goal="Read the current page title",
            start_url=start_url,
        )
        store.write_runtime(
            "distribution_e2e",
            target_id=prepared_target,
            last_url=start_url,
            last_title="Example Domain",
        )
        development = store.write_development_slot(
            "distribution_e2e",
            "inspect_page",
            {
                "code": (
                    "async def inspect_page(ctx, *, label):\n"
                    "    return {'label': label, 'title': await ctx.page.title(), 'url': ctx.page.url}"
                ),
                "description": "Inspect the current page",
                "parameters_schema": {
                    "type": "object",
                    "properties": {"label": {"type": "string"}},
                    "required": ["label"],
                    "additionalProperties": False,
                },
                "result_schema": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "title": {"type": "string"},
                        "url": {"type": "string"},
                    },
                    "required": ["label", "title", "url"],
                    "additionalProperties": False,
                },
                "risk_notice": "",
            },
        )
        debug_store = DebugRunStore(store)
        development_result_path = tmp_path / "development-result.json"
        development_result = asyncio.run(
            run_debug(
                {
                    "toolkit_root": str(store.root),
                    "toolkit_id": "distribution_e2e",
                    "tool_id": "inspect_page",
                    "channel": "development",
                    "cdp_url": DEFAULT_CDP_URL,
                    "parameters": {"label": "development"},
                    "result_path": str(development_result_path),
                    "screenshot_path": str(tmp_path / "development.png"),
                }
            )
        )
        assert development_result["ok"] is True
        development_run = debug_store.create(
            tool_id="inspect_page",
            channel="development",
            code_hash=development["code_hash"],
            parameters={"label": "development"},
        )
        debug_store.update(
            development_run["debug_run_id"],
            status=DebugRunStatus.SUCCEEDED.value,
        )

        publisher = ToolkitPublisher(store, debug_store)
        operation = prepare_apply(store, "distribution_e2e")
        profile = os.environ.get("WEWORKER_BUILD_PROFILE", "public")
        acknowledge_apply(store, "distribution_e2e", digest=operation["candidate_digest"], revision=1,
            profile=profile, operation_id=operation["operation_id"])
        formal = store.read_formal_slot("distribution_e2e", "inspect_page")
        build, _, adapter_root = current_package(store, "distribution_e2e")
        atomic_write_json(adapter_root.parent / ".profile.json", {
            "schema_version": 1, "profile": profile,
            "adapters": [{"name": build["name"], "version": build["version"], "digest": build["digest"]}],
        })
        formal_result_path = tmp_path / "formal-result.json"
        formal_result = asyncio.run(
            run_debug(
                {
                    "toolkit_root": str(store.root),
                    "toolkit_id": "distribution_e2e",
                    "tool_id": "inspect_page",
                    "channel": "formal",
                    "v2": True, "adapter_root": str(adapter_root),
                    "distribution_hash": build["digest"], "profile": profile,
                    "code_hash": formal["code_hash"],
                    "artifact_hash": build["digest"],
                    "cdp_url": DEFAULT_CDP_URL,
                    "parameters": {"label": "formal"},
                    "result_path": str(formal_result_path),
                    "screenshot_path": str(tmp_path / "formal.png"),
                }
            )
        )
        assert formal_result["ok"] is True
        assert formal_result["result"]["title"] == "Example Domain"
        formal_run = debug_store.create(
            tool_id="inspect_page",
            channel="formal",
            code_hash=formal["code_hash"],
            artifact_hash=build["digest"],
            parameters={"label": "formal"},
        )
        debug_store.update(
            formal_run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value
        )
        assert publisher.export_status("distribution_e2e")["export_eligible"] is True

        archive = zipfile.ZipFile(io.BytesIO(publisher.export_zip("distribution_e2e")))
        external_root = tmp_path / "external"
        archive.extractall(external_root)
        external_toolkit = external_root / "distribution-e2e"
        external_state = tmp_path / "external-state"
        atomic_write_json(external_root / ".profile.json", {
            "schema_version": 1, "profile": profile,
            "adapters": [{"name": build["name"], "version": build["version"], "digest": build["digest"]}],
        })
        launcher = RuntimeLauncher()
        completed = subprocess.run(
            [os.environ["WEWORKER_WEBCLI_NODE"], os.environ["WEWORKER_WEBCLI_ENTRY"],
             "call", "distribution-e2e.inspect-page", "--args", '{"label":"external"}', "--output-format=json"],
            cwd=external_toolkit,
            env=launcher.external_process_environment({
                "ELECTRON_RUN_AS_NODE": "1", "WEBWRIGHT_CDP_URL": DEFAULT_CDP_URL,
                "WEBWRIGHT_STATE_DIR": str(external_state), "WEWORKER_BUILD_PROFILE": profile,
                "WEWORKER_BUILTIN_ADAPTERS_DIR": str(external_root),
                "WEWORKER_USER_ADAPTERS_DIR": str(tmp_path / "empty-adapters"),
                "WEBCLI_ADAPTERS_DIR": str(tmp_path / "empty-adapters"),
                "WEWORKER_ADAPTER_DATA_DIR": str(tmp_path / "host-data"),
                "WEWORKER_TOOLKIT_RUNTIME": launcher.executable,
                "WEWORKER_TOOLKIT_RUNTIME_MODE": "embedded" if launcher.frozen else "python",
            }),
            capture_output=True, text=True, check=False, timeout=30,
        )
        assert completed.returncode == 0, completed.stderr
        external_output = json.loads(completed.stdout.splitlines()[-1])
        assert external_output["ok"] is True
        assert external_output["data"]["title"] == "Example Domain"
        assert not (external_toolkit / "runtime.json").exists()
        runtime_paths = list(external_state.glob("*/runtime.json"))
        assert len(runtime_paths) == 1
        external_runtime = json.loads(runtime_paths[0].read_text(encoding="utf-8"))
        assert external_runtime["target_id"]
        created_targets.add(external_runtime["target_id"])
        assert not (external_toolkit / "tools").exists()
        assert not (external_toolkit / ".server").exists()
    finally:
        for target_id in created_targets:
            _close_target(target_id)
