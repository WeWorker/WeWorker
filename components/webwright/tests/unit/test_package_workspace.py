from __future__ import annotations

import base64
import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from webwright.paths import WebwrightPaths
from webwright.server.adapter_v2 import bind_base, current_package, package_digest
from webwright.server.app import create_app
from webwright.server.debug_store import DebugRunStore
from webwright.server.development import build_development_input
from webwright.server.package_workspace import prepare_apply, acknowledge_apply, read_state
from webwright.server.publisher import ToolkitPublisher
from webwright.server.records import TaskStore
from webwright.server.toolkit_store import ToolkitStore


def workspace(tmp_path):
    store = ToolkitStore(tmp_path / "toolkits")
    store.create_toolkit(name="example", allowed_domains=["example.com"])
    store.create_tool("example", name="read_page", goal="Read page", start_url="https://example.com/")
    return store


def slot(code=None):
    return {"code": code or "async def read_page(ctx):\n    return {}\n", "description": "Read page",
            "parameters_schema": {"type": "object", "properties": {}},
            "result_schema": {"type": "object"}, "risk_notice": ""}


def apply(store, revision=1):
    operation = prepare_apply(store, "example")
    acknowledge_apply(store, "example", digest=operation["candidate_digest"], revision=revision,
        profile="public", operation_id=operation["operation_id"])
    return operation


@pytest.mark.parametrize("source", [
    "# 注释\r\nasync def read_page(ctx):\r\n    return {}  # 原始空白\r\n\r\n",
    "async def read_page(ctx):\n    return {}",
    "\n# comment\nasync def read_page(ctx):\n    return {}\n\n",
])
def test_source_roundtrip_and_only_final_format_code(tmp_path, source):
    store = workspace(tmp_path)
    expected = store.write_development_slot("example", "read_page", slot(source))
    restarted = ToolkitStore(store.root)
    assert restarted.read_development_slot("example", "read_page") == expected
    metadata, files, _ = current_package(restarted, "example")
    assert source.encode() in files["wewright/commands/read-page.py"]
    assert metadata["digest"] == package_digest(files)
    for path in store.toolkit_dir("example").rglob("*.json"):
        assert '"code":' not in path.read_text(encoding="utf-8")
    assert not (store.toolkit_dir("example") / "development").exists()
    assert not (store.tool_dir("example", "read_page") / "formal.json").exists()


def test_model_input_matches_existing_dictionary_contract(tmp_path):
    store = workspace(tmp_path)
    expected = store.write_development_slot("example", "read_page", slot())
    tool = store.get_tool("example", "read_page")
    kwargs = dict(task_store=TaskStore(tmp_path / "tasks"), debug_store=DebugRunStore(store),
        toolkit_id="example", tool_id="read_page", instruction="Improve result", source_exploration_id="", debug_run_evidence_id="")
    reference = SimpleNamespace(get_toolkit=lambda _: store.get_toolkit("example"),
        get_tool=lambda *_: tool, read_development_slot=lambda *_: expected, read_formal_slot=lambda *_: None)
    assert build_development_input(toolkit_store=store, **kwargs) == build_development_input(toolkit_store=reference, **kwargs)


def test_generation_failure_keeps_previous_pointer_and_source(tmp_path, monkeypatch):
    store = workspace(tmp_path)
    original = store.write_development_slot("example", "read_page", slot())
    before = read_state(store, "example")
    def fail(*args):
        raise OSError("simulated full disk")
    monkeypatch.setattr("webwright.server.package_workspace.write_package", fail)
    with pytest.raises(OSError):
        store.update_development_code("example", "read_page", code="async def read_page(ctx):\n    return {'new': True}", expected_code_hash=original["code_hash"])
    assert read_state(store, "example") == before
    assert store.read_development_slot("example", "read_page") == original


def test_candidate_export_bytes_match_without_any_debug_run(tmp_path):
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    publisher = ToolkitPublisher(store, DebugRunStore(store))
    metadata, files, _ = current_package(store, "example")
    assert publisher.export_status("example")["export_eligible"]
    with zipfile.ZipFile(io.BytesIO(publisher.export_zip("example"))) as archive:
        assert {name.removeprefix(metadata["name"] + "/"): archive.read(name) for name in archive.namelist()} == files
    assert store.read_formal_slot("example", "read_page") is None


def test_all_saved_commands_are_applied_and_versions_advance(tmp_path):
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    store.create_tool("example", name="list_items", goal="List", start_url="https://example.com/")
    store.write_development_slot("example", "list_items", slot("async def list_items(ctx):\n    return {}"))
    first = apply(store)
    assert not read_state(store, "example")["drafts"]
    assert store.read_formal_slot("example", "list_items")
    store.write_development_slot("example", "read_page", slot("async def read_page(ctx):\n    return {'v': 2}"))
    assert current_package(store, "example")[0]["version"] == "1.0.1"
    assert read_state(store, "example")["install_baseline_digest"] == first["candidate_digest"]
    apply(store, 2)
    store.write_development_slot("example", "read_page", slot("async def read_page(ctx):\n    return {'v': 3}"))
    assert current_package(store, "example")[0]["version"] == "1.0.2"


def test_discard_does_not_resurrect_deleted_command(tmp_path):
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    store.create_tool("example", name="list_items", goal="List", start_url="https://example.com/")
    store.write_development_slot("example", "list_items", slot("async def list_items(ctx):\n    return {}"))
    apply(store)
    store.delete_tool("example", "list_items")
    store.reset_development_from_formal("example", "read_page")
    store.clear_development_slot("example", "read_page")
    manifest = json.loads(current_package(store, "example")[1]["manifest.json"])
    assert [item["id"] for item in manifest["commands"]] == ["read-page"]


def test_import_resources_preserved_across_repeated_apply(tmp_path):
    store = workspace(tmp_path)
    files = {"manifest.json": json.dumps({"schema_version": 2, "name": "existing.example.com", "version": "2.0.0",
        "match": ["example.com"], "description": "Example", "commands": [
        {"id": "original", "runtime": "extension", "module": "extension/commands/original.js", "description": "Original", "schema": {"type": "object", "properties": {}}}]}).encode(),
        "extension/commands/original.js": b"export default () => ({ok:true});", "extension/resource.txt": b"original resource"}
    bind_base(store, "example", profile="public", digest=package_digest(files), files={name: base64.b64encode(value).decode() for name, value in files.items()})
    for revision in (1, 2):
        store.write_development_slot("example", "read_page", slot(f"async def read_page(ctx):\n    return {{'v': {revision}}}"))
        candidate = current_package(store, "example")[1]
        assert candidate["extension/resource.txt"] == files["extension/resource.txt"]
        assert candidate["extension/commands/original.js"] == files["extension/commands/original.js"]
        assert len(json.loads(candidate["manifest.json"])["commands"]) == 2
        apply(store, revision)
    assert current_package(store, "example")[0]["version"] == "2.0.2"


def test_embedded_api_prepares_package_and_confirms_only_matching_operation(tmp_path):
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    app = create_app(paths=WebwrightPaths.resolve(home=tmp_path), toolkit_store=store,
        weworker_user_files_dir=tmp_path / "user-files")
    client = app.test_client()
    response = client.get("/api/toolkits/example/v2-package")
    assert response.status_code == 200
    package = response.get_json()
    assert package["changed_tools"] == ["read_page"]
    assert store.read_formal_slot("example", "read_page") is None
    ack = client.post("/api/toolkits/example/installation-ack", json={"digest": package["digest"],
        "operation_id": package["operation_id"], "revision": 1, "profile": "public"})
    assert ack.status_code == 200
    assert store.read_development_slot("example", "read_page") is None
    assert store.read_formal_slot("example", "read_page")
    assert client.post("/api/toolkits/example/tools/read_page/publish").status_code == 404


def test_metadata_changes_regenerate_candidate_but_preserve_installed_package(tmp_path):
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    installed = apply(store)
    store.update_tool("example", "read_page", start_url="https://example.com/updated")
    candidate, files, _ = current_package(store, "example")
    assert candidate["digest"] != installed["candidate_digest"]
    assert b"https://example.com/updated" in files["wewright/commands/read-page.py"]
    assert read_state(store, "example")["last_applied_digest"] == installed["candidate_digest"]
    assert read_state(store, "example")["drafts"] == ["read_page"]


def test_install_ack_preserves_concurrent_metadata_edit(tmp_path):
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    reviewed = prepare_apply(store, "example")
    store.update_tool("example", "read_page", start_url="https://example.com/new")
    acknowledge_apply(store, "example", digest=reviewed["candidate_digest"], revision=1,
        profile="public", operation_id=reviewed["operation_id"])
    state = read_state(store, "example")
    assert state["drafts"] == ["read_page"]
    assert state["candidate_digest"] != state["last_applied_digest"]
    assert b"https://example.com/new" in current_package(store, "example")[1]["wewright/commands/read-page.py"]


def test_partial_package_write_can_retry_same_digest(tmp_path, monkeypatch):
    store = workspace(tmp_path)
    original_write = Path.write_bytes
    failed = False
    def interrupted_write(path, data):
        nonlocal failed
        if path.suffix == ".py" and not failed:
            failed = True
            original_write(path, data[:12])
            raise OSError("simulated interrupted write")
        return original_write(path, data)
    monkeypatch.setattr(Path, "write_bytes", interrupted_write)
    with pytest.raises(OSError, match="interrupted write"):
        store.write_development_slot("example", "read_page", slot())
    assert read_state(store, "example")["candidate_digest"] is None
    store.write_development_slot("example", "read_page", slot())
    assert current_package(store, "example")[0]["digest"]


def test_lost_ack_reconciles_previous_host_commit_before_next_apply(tmp_path):
    from webwright.server.package_workspace import reconcile_installation
    store = workspace(tmp_path)
    store.write_development_slot("example", "read_page", slot())
    committed = prepare_apply(store, "example")
    newer = store.write_development_slot("example", "read_page", slot("async def read_page(ctx):\n    return {'v': 2}"))
    restarted = ToolkitStore(store.root)
    assert reconcile_installation(restarted, "example", digest=committed["candidate_digest"], revision=1, profile="public") == {"reconciled": True}
    assert restarted.read_development_slot("example", "read_page") == newer
    assert current_package(restarted, "example")[0]["version"] == "1.0.1"
    assert reconcile_installation(restarted, "example", digest="0" * 64, revision=2, profile="public") == {"reconciled": False}


def test_host_tool_deletion_syncs_baseline_and_clears_removed_tools(tmp_path):
    store = workspace(tmp_path)
    store.create_tool("example", name="list_items", goal="List items", start_url="https://example.com/items")
    store.write_development_slot("example", "read_page", slot())
    store.write_development_slot("example", "list_items", slot("async def list_items(ctx):\n    return []\n"))
    apply(store, revision=1)
    _, full_files, _ = current_package(store, "example")
    manifest = json.loads(full_files["manifest.json"])
    manifest["commands"] = [cmd for cmd in manifest["commands"] if cmd["id"] != "list-items"]
    remaining_files = {k: v for k, v in full_files.items() if k != "wewright/commands/list-items.py"}
    remaining_files["manifest.json"] = (json.dumps(manifest) + "\n").encode("utf-8")
    remaining_digest = package_digest(remaining_files)

    tx1 = store.stage_tool_deletion("example", "list_items")
    store.finish_tool_deletion(
        "example", "list_items", tx1, restore=False, host_revision=2,
        host_package={"digest": remaining_digest, "files": {k: base64.b64encode(v).decode("ascii") for k, v in remaining_files.items()}},
    )
    state_after_partial = read_state(store, "example")
    assert state_after_partial["last_applied_digest"] == remaining_digest
    assert state_after_partial["install_baseline_digest"] == remaining_digest
    assert state_after_partial["candidate_digest"] == remaining_digest
    assert state_after_partial["removed_tools"] == []
    assert state_after_partial["drafts"] == []
    assert store.read_formal_slot("example", "read_page") is not None

    tx2 = store.stage_tool_deletion("example", "read_page")
    store.finish_tool_deletion("example", "read_page", tx2, restore=False, host_uninstalled=True, host_revision=3)
    state_after_uninstall = read_state(store, "example")
    assert state_after_uninstall["last_applied_digest"] is None
    assert state_after_uninstall["install_baseline_digest"] is None
    assert state_after_uninstall["candidate_digest"] is None
    assert state_after_uninstall["removed_tools"] == []
