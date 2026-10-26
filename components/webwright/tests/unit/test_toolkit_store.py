from __future__ import annotations

from pathlib import Path

import pytest

from webwright.server.debug_store import DebugRunStore
from webwright.server.status import DebugRunStatus
from webwright.server.toolkit_store import (
    DevelopmentSlotConflictError,
    ToolkitStore,
    code_hash,
)


def _store(tmp_path: Path) -> ToolkitStore:
    store = ToolkitStore(tmp_path / "toolkits")
    store.create_toolkit(
        name="blog_admin",
        description="Blog tools",
        allowed_domains=["blog.example.com", "auth.example.com"],
    )
    return store


def test_toolkit_and_tool_persist_with_exact_domain_rules(tmp_path: Path) -> None:
    store = _store(tmp_path)

    toolkit = store.get_toolkit("blog_admin")
    tool = store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
        expected_effect="Results are visible",
    )

    assert toolkit["name"] == toolkit["toolkit_id"] == "blog_admin"
    assert store.read_runtime("blog_admin")["target_id"] == ""
    assert tool["name"] == tool["tool_id"] == "search_blog"
    assert tool["has_formal"] is False
    assert tool["has_development"] is False

    with pytest.raises(ValueError, match="allowed_domains"):
        store.create_tool(
            "blog_admin",
            name="evil_tool",
            goal="Nope",
            start_url="https://sub.blog.example.com/",
        )


def test_tool_deletion_can_be_staged_restored_and_finished(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.create_tool("blog_admin", name="search_blog", goal="Search posts",
                      start_url="https://blog.example.com/admin/posts")
    development = store.development_path("blog_admin", "search_blog")
    development.parent.mkdir(parents=True)
    development.write_text("draft", encoding="utf-8")

    first = store.stage_tool_deletion("blog_admin", "search_blog")
    assert store.list_tools("blog_admin") == []
    assert not development.exists()
    store.finish_tool_deletion("blog_admin", "search_blog", first, restore=True)
    assert store.get_tool("blog_admin", "search_blog")["tool_id"] == "search_blog"
    assert development.read_text(encoding="utf-8") == "draft"

    second = store.stage_tool_deletion("blog_admin", "search_blog")
    store.finish_tool_deletion("blog_admin", "search_blog", second, restore=False)
    assert store.list_tools("blog_admin") == []
    assert not development.exists()


def test_tool_ids_are_global_and_paths_reject_unsafe_ids(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    store.create_toolkit(
        name="shop_admin",
        allowed_domains=["shop.example.com"],
    )

    with pytest.raises(ValueError, match="already exists"):
        store.create_tool(
            "shop_admin",
            name="search_blog",
            goal="Search products",
            start_url="https://shop.example.com/",
        )
    with pytest.raises(ValueError, match="toolkit_id"):
        store.get_toolkit("../escape")


def test_slots_compute_hash_and_lock_source_exploration(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    slot = {
        "code": "async def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
        "description": "Search posts",
        "parameters_schema": {
            "type": "object",
            "properties": {"keyword": {"type": "string"}},
            "required": ["keyword"],
        },
        "result_schema": {"type": "object"},
        "source_exploration_id": "exp_1",
    }

    written = store.write_development_slot("blog_admin", "search_blog", slot)

    assert written["code_hash"] == code_hash(slot["code"])
    assert store.get_tool("blog_admin", "search_blog")["has_development"] is True

    with pytest.raises(ValueError, match="cannot change"):
        store.write_development_slot(
            "blog_admin",
            "search_blog",
            {**slot, "source_exploration_id": "exp_2"},
        )


def test_manual_code_update_preserves_contract_and_rejects_stale_hash(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    original = store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": "async def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
            "description": "Search posts",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "result_schema": {"type": "object"},
            "source_exploration_id": "exp_1",
            "based_on_formal_hash": "sha256:formal",
            "debug_run_evidence_id": "debug_1",
        },
    )
    code = (
        "async def search_blog(ctx, *, keyword):\n"
        "    return {'keyword': keyword, 'manual': True}"
    )

    updated = store.update_development_code(
        "blog_admin",
        "search_blog",
        code=code,
        expected_code_hash=original["code_hash"],
    )

    assert updated["code"] == code
    assert updated["code_hash"] == code_hash(code)
    assert updated["description"] == original["description"]
    assert updated["parameters_schema"] == original["parameters_schema"]
    assert updated["source_exploration_id"] == "exp_1"
    assert updated["based_on_formal_hash"] == "sha256:formal"
    assert updated["debug_run_evidence_id"] == "debug_1"

    with pytest.raises(DevelopmentSlotConflictError, match="changed before manual save"):
        store.update_development_code(
            "blog_admin",
            "search_blog",
            code=original["code"],
            expected_code_hash=original["code_hash"],
        )


def test_manual_code_update_reuses_slot_contract_validation(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    original = store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": "async def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "result_schema": {"type": "object"},
        },
    )

    with pytest.raises(ValueError, match="must match function business parameters"):
        store.update_development_code(
            "blog_admin",
            "search_blog",
            code="async def search_blog(ctx, *, query):\n    return {'query': query}",
            expected_code_hash=original["code_hash"],
        )

    assert (
        store.read_development_slot("blog_admin", "search_blog")["code_hash"]
        == original["code_hash"]
    )


@pytest.mark.parametrize(
    ("code", "parameters_schema", "message"),
    [
        (
            "def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
            {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "single top-level async function",
        ),
        (
            "HELPER = 'prefix'\n\nasync def search_blog(ctx, *, keyword):\n"
            "    return {'keyword': f'{HELPER}{keyword}'}",
            {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "single top-level async function",
        ),
        (
            "async def search_blog(ctx, *, keyword):\n    return {'keyword': keyword}",
            {"type": "object", "properties": {}, "required": []},
            "must match function business parameters",
        ),
        (
            "async def search_blog(ctx, *, keyword='all'):\n"
            "    return {'keyword': keyword}",
            {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "required fields must match parameters without defaults",
        ),
    ],
)
def test_slot_rejects_code_outside_isolated_async_contract(
    tmp_path: Path,
    code: str,
    parameters_schema: dict,
    message: str,
) -> None:
    store = _store(tmp_path)
    store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )

    with pytest.raises(ValueError, match=message):
        store.write_development_slot(
            "blog_admin",
            "search_blog",
            {
                "code": code,
                "parameters_schema": parameters_schema,
                "result_schema": {"type": "object"},
            },
        )


def test_debug_run_store_records_hash_without_code_snapshot(tmp_path: Path) -> None:
    toolkit_store = _store(tmp_path)
    toolkit_store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    debug_store = DebugRunStore(toolkit_store)

    run = debug_store.create(
        tool_id="search_blog",
        channel="development",
        code_hash="sha256:abc",
        parameters={"keyword": "Webwright"},
    )
    completed = debug_store.update(
        run["debug_run_id"],
        status=DebugRunStatus.SUCCEEDED.value,
        result={"total": 1},
    )

    assert "code" not in completed
    assert completed["status"] == "succeeded"
    assert debug_store.list_for_tool("search_blog")[0]["code_hash"] == "sha256:abc"
