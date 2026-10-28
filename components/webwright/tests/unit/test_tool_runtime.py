from __future__ import annotations

import asyncio
import io
import json
import shutil
import zipfile
from pathlib import Path

import pytest

from webwright.server.debug_store import DebugRunStore
from webwright.server.publisher import ToolkitPublisher, artifact_hash, render_artifacts
from webwright.server.adapter_v2 import snapshot_package
from webwright.runtime_identity import RuntimeIdentity
from webwright.server.status import DebugRunStatus
from webwright.server.toolkit_store import ToolkitStore, code_hash
from webwright.tool_runtime.browser import ToolkitBrowserSession
from webwright.tool_runtime.context import ToolContext
from webwright.tool_runtime.runner import PublishedToolkitRunner, ToolRunner
from webwright.tool_runtime.state import FileRuntimeStore
from webwright.tool_runtime.toolkit_runtime import (
    RuntimeRecoveryError,
    default_user_data_dir,
    execute_tool,
    runtime_state_path,
)
from webwright.utils.local_cdp import find_page_by_target_id, target_id_for_page


class FakePage:
    def __init__(self, target_id: str, url: str, title: str):
        self.target_id = target_id
        self.url = url
        self._title = title
        self.goto_calls: list[str] = []

    async def title(self):
        return self._title

    async def goto(self, url, **kwargs):
        del kwargs
        self.goto_calls.append(url)
        self.url = url


class FakeCDPSession:
    def __init__(self, page: FakePage):
        self.page = page
        self.detached = False

    async def send(self, method: str):
        assert method == "Target.getTargetInfo"
        return {"targetInfo": {"targetId": self.page.target_id}}

    async def detach(self):
        self.detached = True


class FakeContext:
    def __init__(self, pages: list[FakePage]):
        self.pages = pages
        self.new_page_calls = 0

    async def new_cdp_session(self, page: FakePage):
        return FakeCDPSession(page)

    async def new_page(self):
        self.new_page_calls += 1
        page = FakePage("new-target", "about:blank", "")
        self.pages.append(page)
        return page


class FakeBrowser:
    def __init__(self, context: FakeContext):
        self.contexts = [context]


class FakeChromium:
    def __init__(self, browser: FakeBrowser):
        self.browser = browser

    async def connect_over_cdp(self, cdp_url: str):
        assert cdp_url == "http://127.0.0.1:9222"
        return self.browser


class FakePlaywright:
    def __init__(self, browser: FakeBrowser):
        self.chromium = FakeChromium(browser)
        self.stopped = False

    async def stop(self):
        self.stopped = True


class FakePlaywrightManager:
    def __init__(self, playwright: FakePlaywright):
        self.playwright = playwright

    async def start(self):
        return self.playwright


def test_managed_session_uses_host_endpoint_claims_page_and_releases(tmp_path, monkeypatch):
    from webwright.tool_runtime import toolkit_runtime as managed_browser
    calls = []

    class Control:
        descriptor = {"instanceId": "fixture-instance"}
        def acquire(self, **params):
            calls.append(("acquire", params))
            return "http://127.0.0.1:9222"

        def watch_current_task(self):
            pass

        def claim(self, target_id):
            calls.append(("claim", target_id))

        def close(self):
            calls.append(("close", None))

    monkeypatch.setenv("WEWORKER_BROWSER_MANAGED", "1")
    monkeypatch.setattr(managed_browser, "ManagedBrowser", Control)
    playwright = FakePlaywright(FakeBrowser(FakeContext([])))
    session = ToolkitBrowserSession(runtime_store=FileRuntimeStore(tmp_path / "runtime.json"),
        allowed_domains=["example.com"], cdp_url="http://127.0.0.1:1",
        playwright_factory=lambda: FakePlaywrightManager(playwright))

    async def scenario():
        try:
            await session.open({"start_url": "https://example.com/"})
            assert calls[0][0] == "acquire"
            assert calls[0][1]["resource"].startswith("toolkit:")
            assert calls[1] == ("claim", "new-target")
        finally:
            await session.close()

    asyncio.run(scenario())
    assert calls[-1][0] == "close"
    assert playwright.stopped


def test_managed_connection_failure_never_launches_a_second_browser(tmp_path, monkeypatch):
    from webwright.tool_runtime import toolkit_runtime as managed_browser
    launches = []
    closed = []

    class Control:
        def acquire(self, **_kwargs):
            return "http://127.0.0.1:9222"
        def watch_current_task(self):
            pass
        def close(self):
            closed.append(True)

    class BrokenChromium:
        async def connect_over_cdp(self, _url):
            raise RuntimeError("fixture disconnected")

    monkeypatch.setenv("WEWORKER_BROWSER_MANAGED", "1")
    monkeypatch.setattr(managed_browser, "ManagedBrowser", Control)
    playwright = FakePlaywright(FakeBrowser(FakeContext([])))
    playwright.chromium = BrokenChromium()
    session = ToolkitBrowserSession(runtime_store=FileRuntimeStore(tmp_path / "runtime.json"),
        allowed_domains=["example.com"], playwright_factory=lambda: FakePlaywrightManager(playwright),
        browser_launcher=lambda *_args: launches.append(True))

    async def scenario():
        try:
            with pytest.raises(RuntimeRecoveryError, match="不会启动另一个"):
                await session.open({"start_url": "https://example.com/"})
        finally:
            await session.close()

    asyncio.run(scenario())
    assert launches == []
    assert closed == [True]


def _store(tmp_path: Path) -> ToolkitStore:
    store = ToolkitStore(tmp_path / "toolkits")
    store.create_toolkit(name="blog_admin", allowed_domains=["blog.example.com"])
    store.create_tool(
        "blog_admin",
        name="search_blog",
        goal="Search posts",
        start_url="https://blog.example.com/admin/posts",
    )
    return store


def test_shared_page_identity_helper_uses_exact_target() -> None:
    first = FakePage("target-1", "https://same.example/", "Same")
    second = FakePage("target-2", "https://same.example/", "Same")
    context = FakeContext([first, second])

    assert asyncio.run(target_id_for_page(context, second)) == "target-2"
    assert asyncio.run(find_page_by_target_id(context, "target-2")) is second
    assert asyncio.run(find_page_by_target_id(context, "missing")) is None


def test_browser_session_reuses_saved_target_by_identity(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_runtime(
        "blog_admin",
        target_id="target-2",
        last_url="https://blog.example.com/admin/posts",
        last_title="Posts",
    )
    first = FakePage("target-1", "https://blog.example.com/admin/posts", "Posts")
    second = FakePage("target-2", "https://blog.example.com/admin/posts", "Posts")
    context = FakeContext([first, second])
    playwright = FakePlaywright(FakeBrowser(context))
    session = ToolkitBrowserSession(
        store=store,
        toolkit_id="blog_admin",
        playwright_factory=lambda: FakePlaywrightManager(playwright),
    )

    tool_context = asyncio.run(session.open(store.get_tool("blog_admin", "search_blog")))
    asyncio.run(session.close())

    assert tool_context.page is second
    assert context.new_page_calls == 0
    assert store.read_runtime("blog_admin")["target_id"] == "target-2"
    assert playwright.stopped is True


def test_browser_session_rebuilds_missing_saved_target(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_runtime(
        "blog_admin",
        target_id="closed-target",
        last_url="https://blog.example.com/admin/posts",
        last_title="Posts",
    )
    context = FakeContext([])
    playwright = FakePlaywright(FakeBrowser(context))
    session = ToolkitBrowserSession(
        store=store,
        toolkit_id="blog_admin",
        playwright_factory=lambda: FakePlaywrightManager(playwright),
    )

    tool_context = asyncio.run(session.open(store.get_tool("blog_admin", "search_blog")))
    asyncio.run(session.close())

    assert context.new_page_calls == 1
    assert tool_context.page.goto_calls == ["https://blog.example.com/admin/posts"]
    assert store.read_runtime("blog_admin")["target_id"] == "new-target"


class RecoveringChromium:
    def __init__(self, browser: FakeBrowser):
        self.browser = browser
        self.connect_calls = 0

    async def connect_over_cdp(self, cdp_url: str):
        assert cdp_url == "http://127.0.0.1:9222"
        self.connect_calls += 1
        if self.connect_calls == 1:
            raise OSError("connection refused")
        return self.browser


class RecoveringPlaywright(FakePlaywright):
    def __init__(self, browser: FakeBrowser):
        super().__init__(browser)
        self.chromium = RecoveringChromium(browser)


def test_browser_session_starts_local_cdp_and_retries_connection(tmp_path: Path) -> None:
    runtime = FileRuntimeStore(tmp_path / "runtime.json")
    context = FakeContext([])
    playwright = RecoveringPlaywright(FakeBrowser(context))
    launches = []
    session = ToolkitBrowserSession(
        runtime_store=runtime,
        allowed_domains=["blog.example.com"],
        playwright_factory=lambda: FakePlaywrightManager(playwright),
        browser_launcher=lambda cdp_url: launches.append(cdp_url),
    )

    tool_context = asyncio.run(
        session.open({"start_url": "https://blog.example.com/admin/posts"})
    )
    asyncio.run(session.close())

    assert launches == ["http://127.0.0.1:9222"]
    assert playwright.chromium.connect_calls == 2
    assert tool_context.page.goto_calls == ["https://blog.example.com/admin/posts"]
    assert runtime.read()["target_id"] == "new-target"


def test_browser_session_does_not_launch_for_remote_cdp(tmp_path: Path) -> None:
    class UnavailableChromium:
        async def connect_over_cdp(self, cdp_url: str):
            assert cdp_url == "http://browser.example.com:9222"
            raise OSError("connection refused")

    playwright = FakePlaywright(FakeBrowser(FakeContext([])))
    playwright.chromium = UnavailableChromium()
    launches = []
    session = ToolkitBrowserSession(
        runtime_store=FileRuntimeStore(tmp_path / "runtime.json"),
        allowed_domains=["blog.example.com"],
        cdp_url="http://browser.example.com:9222",
        playwright_factory=lambda: FakePlaywrightManager(playwright),
        browser_launcher=lambda cdp_url: launches.append(cdp_url),
    )

    with pytest.raises(RuntimeRecoveryError, match="remote CDP endpoint") as captured:
        asyncio.run(session.open({"start_url": "https://blog.example.com/admin/posts"}))
    asyncio.run(session.close())

    assert captured.value.code == "browser_unavailable"
    assert launches == []


def test_browser_session_retries_page_closed_during_rebuild(tmp_path: Path) -> None:
    class ClosingPage(FakePage):
        async def goto(self, url, **kwargs):
            del url, kwargs
            raise RuntimeError("Target page, context or browser has been closed")

    class RecoveringContext(FakeContext):
        async def new_page(self):
            self.new_page_calls += 1
            if self.new_page_calls == 1:
                return ClosingPage("closed-during-rebuild", "about:blank", "")
            page = FakePage("replacement-target", "about:blank", "")
            self.pages.append(page)
            return page

    runtime = FileRuntimeStore(tmp_path / "runtime.json")
    runtime.write(
        target_id="closed-target",
        last_url="https://blog.example.com/admin/posts",
        last_title="Posts",
    )
    context = RecoveringContext([])
    playwright = FakePlaywright(FakeBrowser(context))
    session = ToolkitBrowserSession(
        runtime_store=runtime,
        allowed_domains=["blog.example.com"],
        playwright_factory=lambda: FakePlaywrightManager(playwright),
    )

    tool_context = asyncio.run(
        session.open({"start_url": "https://blog.example.com/admin/posts"})
    )
    asyncio.run(session.close())

    assert context.new_page_calls == 2
    assert tool_context.page.target_id == "replacement-target"
    assert runtime.read()["target_id"] == "replacement-target"


def test_runtime_recovery_error_is_retryable_and_skips_tool_function() -> None:
    calls = []

    class UnavailableSession:
        page = None

        async def open(self, tool):
            del tool
            raise RuntimeRecoveryError(
                code="browser_start_failed",
                message="Could not start local CDP browser.",
            )

        async def page_view(self):
            return {"url": "", "title": ""}

        async def close(self):
            pass

    output = asyncio.run(
        execute_tool(
            tool_id="search_blog",
            tool={"start_url": "https://blog.example.com/admin/posts"},
            parameters_schema={"type": "object", "properties": {}},
            result_schema={"type": "object", "properties": {}},
            parameters={},
            load_function=lambda: calls.append("loaded"),
            session=UnavailableSession(),
            screenshot_path=None,
        )
    )

    assert calls == []
    assert output["error"] == {
        "code": "browser_start_failed",
        "message": "Could not start local CDP browser.",
        "retryable": True,
        "needs_user": False,
    }


class RunnerSession:
    def __init__(self, **kwargs):
        del kwargs
        self.page = FakePage("internal-target", "https://blog.example.com/admin/posts", "Posts")
        self.persist_calls = 0

    async def open(self, tool):
        del tool
        return ToolContext(page=self.page, browser_context=object(), browser=object())

    async def persist(self):
        self.persist_calls += 1

    async def page_view(self):
        return {"url": self.page.url, "title": await self.page.title()}

    async def close(self):
        pass


def test_file_runtime_store_round_trips_without_toolkit_store(tmp_path: Path) -> None:
    runtime_path = tmp_path / "published" / "runtime.json"
    runtime = FileRuntimeStore(runtime_path)

    assert runtime.read() == {
        "target_id": "",
        "last_url": "",
        "last_title": "",
        "updated_at": "",
    }

    written = runtime.write(
        target_id="published-target",
        last_url="https://blog.example.com/admin/posts",
        last_title="Posts",
    )

    assert json.loads(runtime_path.read_text(encoding="utf-8")) == written
    assert runtime.read()["target_id"] == "published-target"
    assert not list(runtime_path.parent.glob("*.tmp"))


def test_published_runner_executes_embedded_tool_spec_without_toolkit_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    toolkit_dir = tmp_path / "published"
    toolkit_dir.mkdir()
    tool_specs = {
        "search_blog": {
            "start_url": "https://blog.example.com/admin/posts",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
                "additionalProperties": False,
            },
            "result_schema": {"type": "object"},
        }
    }

    async def search_blog(ctx, *, keyword):
        return {"keyword": keyword, "url": ctx.page.url}

    state_root = tmp_path / "state"
    monkeypatch.setenv("WEBWRIGHT_STATE_DIR", str(state_root))
    runner = PublishedToolkitRunner(
        toolkit_id="blog_admin",
        skill_dir=toolkit_dir,
        allowed_domains=["blog.example.com"],
        tool_specs=tool_specs,
        tool_functions={"search_blog": search_blog},
        session_factory=RunnerSession,
    )
    output = asyncio.run(
        runner.run(tool_id="search_blog", parameters={"keyword": "Webwright"})
    )

    assert output["ok"] is True
    assert output["data"] == {
        "keyword": "Webwright",
        "url": "https://blog.example.com/admin/posts",
    }
    assert not (toolkit_dir / "runtime.json").exists()
    assert runner.runtime_store.path.is_file()
    assert state_root in runner.runtime_store.path.parents


def test_runtime_state_path_isolated_by_skill_and_supports_explicit_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_root = tmp_path / "state"
    monkeypatch.setenv("WEBWRIGHT_STATE_DIR", str(state_root))
    first = runtime_state_path(
        toolkit_id="blog_admin", skill_dir=tmp_path / "skills" / "first"
    )
    second = runtime_state_path(
        toolkit_id="blog_admin", skill_dir=tmp_path / "skills" / "second"
    )
    assert first != second
    assert state_root in first.parents
    assert first.name == "runtime.json"

    explicit = tmp_path / "explicit" / "runtime.json"
    monkeypatch.setenv("WEBWRIGHT_RUNTIME_PATH", str(explicit))
    assert runtime_state_path(
        toolkit_id="blog_admin", skill_dir=tmp_path / "skills" / "first"
    ) == explicit.resolve()


def test_published_runtime_defaults_to_weworker_webwright_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    user_home = tmp_path / "user"
    monkeypatch.setattr(Path, "home", lambda: user_home)
    for name in (
        "WEBWRIGHT_HOME",
        "WEBWRIGHT_BROWSER_PROFILE",
        "WEBWRIGHT_STATE_DIR",
        "WEBWRIGHT_RUNTIME_PATH",
    ):
        monkeypatch.delenv(name, raising=False)

    expected_home = user_home / ".weworker" / "webwright"
    assert default_user_data_dir(environ={}) == expected_home / "browser" / "profile"
    state_path = runtime_state_path(
        toolkit_id="blog_admin", skill_dir=tmp_path / "skills" / "first"
    )
    assert expected_home / "toolkit-state" in state_path.parents


def test_published_runner_does_not_require_manifest(tmp_path: Path) -> None:
    runner = PublishedToolkitRunner(
        toolkit_id="blog_admin",
        skill_dir=tmp_path,
        allowed_domains=["blog.example.com"],
        tool_specs={},
        tool_functions={},
    )

    assert runner.tool_specs == {}
    assert not (tmp_path / "toolkit.json").exists()


def test_published_runtime_modules_do_not_import_server_package() -> None:
    runtime_root = Path(__file__).parents[2] / "src" / "webwright" / "tool_runtime"

    for path in runtime_root.glob("*.py"):
        assert "webwright.server" not in path.read_text(encoding="utf-8"), path.name


def test_tool_runner_executes_business_parameters_without_exposing_target(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": (
                "async def search_blog(ctx, *, keyword):\n"
                "    return {'keyword': keyword, 'url': ctx.page.url}"
            ),
            "description": "Search",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "result_schema": {"type": "object"},
        },
    )
    runner = ToolRunner(store=store, session_factory=RunnerSession)

    output = asyncio.run(
        runner.run(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            channel="development",
            parameters={"keyword": "Webwright"},
        )
    )

    assert output["ok"] is True
    assert output["data"]["keyword"] == "Webwright"
    assert "target_id" not in json.dumps(output)


def test_tool_runner_rejects_missing_required_parameter(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": "async def search_blog(ctx, *, keyword):\n    return {}",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
            },
            "result_schema": {"type": "object"},
        },
    )
    runner = ToolRunner(store=store, session_factory=RunnerSession)

    output = asyncio.run(
        runner.run(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            channel="development",
            parameters={},
        )
    )

    assert output["ok"] is False
    assert output["error"]["code"] == "invalid_tool_contract"
    assert "Missing required parameter" in output["error"]["message"]


def test_tool_runner_rejects_unknown_parameter_and_invalid_result(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.write_development_slot(
        "blog_admin",
        "search_blog",
        {
            "code": "async def search_blog(ctx, *, keyword):\n    return 'not-an-object'",
            "parameters_schema": {
                "type": "object",
                "properties": {"keyword": {"type": "string"}},
                "required": ["keyword"],
                "additionalProperties": False,
            },
            "result_schema": {"type": "object"},
        },
    )
    runner = ToolRunner(store=store, session_factory=RunnerSession)

    unknown = asyncio.run(
        runner.run(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            channel="development",
            parameters={"keyword": "Webwright", "target_id": "forbidden"},
        )
    )
    invalid_result = asyncio.run(
        runner.run(
            toolkit_id="blog_admin",
            tool_id="search_blog",
            channel="development",
            parameters={"keyword": "Webwright"},
        )
    )

    assert unknown["ok"] is False
    assert unknown["error"]["message"] == "Unknown parameter: target_id"
    assert invalid_result["ok"] is False
    assert invalid_result["error"]["message"] == "Invalid Tool result type: object"


class RecordingLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    @property
    def first(self):
        return self

    def nth(self, index):
        return RecordingLocator(self.page, (*self.selector, "nth", index))

    def filter(self, **kwargs):
        return RecordingLocator(
            self.page, (*self.selector, "filter", tuple(sorted(kwargs.items())))
        )

    async def click(self, **kwargs):
        self.page.events.append(("click", self.selector, kwargs))

    async def wait_for(self, **kwargs):
        self.page.events.append(("wait_for", self.selector, kwargs))


class PropertyCertificatePage(FakePage):
    def __init__(self):
        super().__init__("property-target", "about:blank", "不动产登记一网通")
        self.events = []

    async def goto(self, url, **kwargs):
        await super().goto(url, **kwargs)
        self.events.append(("goto", url, kwargs))

    def get_by_text(self, text, **kwargs):
        return RecordingLocator(self, ("text", text, tuple(sorted(kwargs.items()))))

    def get_by_role(self, role, **kwargs):
        return RecordingLocator(self, ("role", role, tuple(sorted(kwargs.items()))))

    def locator(self, selector):
        return RecordingLocator(self, ("locator", selector))

    async def wait_for_timeout(self, timeout):
        self.events.append(("wait_for_timeout", timeout))


class PropertyCertificateSession(RunnerSession):
    last_events = []

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.page = PropertyCertificatePage()
        type(self).last_events = self.page.events


def test_reusable_property_certificate_tool_fixture_runs_through_runner(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parents[1] / "fixtures" / "toolkits"
    store_root = tmp_path / "toolkits"
    shutil.copytree(fixture_root, store_root)
    store = ToolkitStore(store_root)

    tool = store.get_tool("tianjin_property", "print_property_certificate")
    slot = store.read_development_slot(
        "tianjin_property", "print_property_certificate"
    )
    assert tool["has_development"] is True
    assert slot is not None
    assert slot["code_hash"] == code_hash(slot["code"])

    output = asyncio.run(
        ToolRunner(store=store, session_factory=PropertyCertificateSession).run(
            toolkit_id="tianjin_property",
            tool_id="print_property_certificate",
            channel="development",
            parameters={},
        )
    )

    assert output["ok"] is True
    assert output["data"]["status"] == "success"
    assert any(
        event[0] == "click" and event[1][:2] == ("role", "button")
        and ("name", "打印证明") in event[1][2]
        for event in PropertyCertificateSession.last_events
    )


def test_property_certificate_fixture_rebuilds_and_exports_independent_formal_artifact(
    tmp_path: Path,
) -> None:
    fixture_root = Path(__file__).parents[1] / "fixtures" / "toolkits"
    store_root = tmp_path / "toolkits"
    shutil.copytree(fixture_root, store_root)
    store = ToolkitStore(store_root)
    debug_store = DebugRunStore(store)
    publisher = ToolkitPublisher(store, debug_store)

    development = store.read_development_slot(
        "tianjin_property", "print_property_certificate"
    )
    formal = store.read_formal_slot(
        "tianjin_property", "print_property_certificate"
    )
    assert development is not None
    assert formal is not None
    assert formal["code_hash"] == code_hash(formal["code"])
    assert development["based_on_formal_hash"] == formal["code_hash"]

    build = publisher.ensure_consistent("tianjin_property")
    assert build is not None
    assert build["artifact_hash"] == artifact_hash(
        render_artifacts(store, "tianjin_property")
    )
    toolkit_dir = store.toolkit_dir("tianjin_property")
    scripts_dir = toolkit_dir / "tianjin-property" / "scripts"
    source = (scripts_dir / "toolkit.py").read_text(encoding="utf-8")
    assert "TOOL_SPECS = {'print_property_certificate':" in source
    assert "ALLOWED_DOMAINS = ['jxd.ghhzrzy.tj.gov.cn']" in source
    assert "PublishedToolkitRunner" in source
    assert "ToolkitStore" not in source
    assert "formal.json" not in source
    assert store.read_runtime("tianjin_property") == {
        "target_id": "",
        "last_url": "",
        "last_title": "",
        "updated_at": "",
    }

    formal_output = asyncio.run(
        ToolRunner(store=store, session_factory=PropertyCertificateSession).run(
            toolkit_id="tianjin_property",
            tool_id="print_property_certificate",
            channel="formal",
            parameters={},
        )
    )
    assert formal_output["ok"] is True
    assert formal_output["data"]["status"] == "success"

    namespace = {}
    exec(compile(formal["code"], "<print_property_certificate>", "exec"), namespace)
    published_output = asyncio.run(
        PublishedToolkitRunner(
            toolkit_id="tianjin_property",
            skill_dir=scripts_dir.parent,
            allowed_domains=store.get_toolkit("tianjin_property")["allowed_domains"],
            tool_specs={
                "print_property_certificate": {
                    "start_url": store.get_tool(
                        "tianjin_property", "print_property_certificate"
                    )["start_url"],
                    "parameters_schema": formal["parameters_schema"],
                    "result_schema": formal["result_schema"],
                }
            },
            runtime_path=store.runtime_path("tianjin_property"),
            tool_functions={
                "print_property_certificate": namespace["print_property_certificate"]
            },
            session_factory=PropertyCertificateSession,
        ).run(tool_id="print_property_certificate", parameters={})
    )
    assert published_output["ok"] is True
    v2_build = snapshot_package(store, "tianjin_property")
    assert publisher.export_status("tianjin_property")["export_eligible"] is False

    stale_run = debug_store.create(
        tool_id="print_property_certificate",
        channel="formal",
        code_hash=formal["code_hash"],
        artifact_hash="sha256:" + "0" * 64,
        parameters={},
    )
    debug_store.update(
        stale_run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value
    )
    assert publisher.export_status("tianjin_property")["export_eligible"] is False

    formal_run = debug_store.create(
        tool_id="print_property_certificate",
        channel="formal",
        code_hash="sha256:" + v2_build["digest"],
        artifact_hash=v2_build["digest"],
        distribution_hash=v2_build["digest"],
        runtime_identity=RuntimeIdentity.resolve().as_health_fields(),
        parameters={},
    )
    debug_store.update(
        formal_run["debug_run_id"], status=DebugRunStatus.SUCCEEDED.value
    )
    assert publisher.export_status("tianjin_property")["export_eligible"] is True

    archive = zipfile.ZipFile(io.BytesIO(publisher.export_zip("tianjin_property")))
    assert set(archive.namelist()) == {
        "tianjin-property/manifest.json",
        "tianjin-property/wewright/commands/print-property-certificate.py",
    }
