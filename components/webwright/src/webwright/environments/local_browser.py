from __future__ import annotations

import asyncio
import io
import json
import subprocess
import textwrap
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

from webwright.exceptions import RuntimeExecutionError
from webwright.utils.local_cdp import (
    DEFAULT_CDP_URL as _DEFAULT_LOCAL_CDP_URL,
    DEFAULT_USER_DATA_DIR as _DEFAULT_LOCAL_CDP_USER_DATA_DIR,
    activate_target as _activate_cdp_target,
    ensure_page_target as _ensure_local_cdp_page_target,
    find_new_target as _find_new_cdp_target,
    find_target_by_id as _find_cdp_target_by_id,
    is_cdp_available as _is_local_cdp_available,
    launch_browser as _launch_local_cdp_browser,
    normalize_page_url as _normalize_page_url,
    page_targets as _local_cdp_page_targets,
    resolve_cdp_url as _resolve_local_cdp_url,
    resolve_user_data_dir as _resolve_user_data_dir,
    target_id_for_page as _shared_target_id_for_page,
)

_BROWSER_MODES = {"local_cdp", "local_launch", "local_persistent"}


class LocalBrowserEnvironmentConfig(BaseModel):
    start_url: str | None = None
    browser_mode: str = "local_launch"
    headless: bool = False
    devtools: bool = False
    keep_open_on_exit: bool = False
    prompt_before_close: bool = False
    slow_mo_ms: int = 50
    browser_width: int = 1280
    browser_height: int = 1440
    browser_timeout_ms: int = 10000
    browser_navigation_timeout_ms: int = 30000
    step_execution_timeout_ms: int = 20000
    observation_timeout_ms: int = 5000
    output_dir: Path = Path("outputs/default")
    user_data_dir: Path = _DEFAULT_LOCAL_CDP_USER_DATA_DIR
    launch_args: list[str] = Field(default_factory=list)
    local_cdp_url: str = _DEFAULT_LOCAL_CDP_URL
    local_cdp_new_page: bool = True
    local_cdp_close_page_on_exit: bool = False
    local_cdp_auto_start: bool = True
    local_cdp_executable: str = ""
    local_cdp_startup_timeout_seconds: float = 10
    local_cdp_close_started_browser_on_exit: bool = False
    resume_existing_output: bool = False
    resume_existing_page: bool = False

    @field_validator("browser_mode")
    @classmethod
    def validate_browser_mode(cls, value: str) -> str:
        normalized = value.strip().lower().replace("-", "_")
        if normalized not in _BROWSER_MODES:
            raise ValueError(
                f"browser_mode must be one of: {', '.join(sorted(_BROWSER_MODES))}"
            )
        return normalized


class LocalBrowserEnvironment:
    """Live local Playwright browser environment.

    The environment owns the browser/page and executes each model action as an async
    Python snippet with ``page``, ``context``, ``browser``, ``playwright``, and
    ``task`` already available.
    """

    def __init__(self, *, config_class: type = LocalBrowserEnvironmentConfig, **kwargs):
        self.config = config_class(**kwargs)
        fields_set = getattr(self.config, "model_fields_set", None)
        if fields_set is None:
            fields_set = getattr(self.config, "__fields_set__", set())
        self._config_fields_set = set(fields_set)
        self.config.local_cdp_url = _resolve_local_cdp_url(
            self.config.local_cdp_url,
            explicit="local_cdp_url" in self._config_fields_set,
        )
        self.config.output_dir = self.config.output_dir.expanduser()
        self.config.user_data_dir = _resolve_user_data_dir(
            self.config.user_data_dir,
            explicit="user_data_dir" in self._config_fields_set,
        )
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._local_cdp_page = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._local_cdp_process: subprocess.Popen | None = None
        self._managed_browser = None
        self._connected_over_cdp = False
        self._step_index = 0
        self._prepared_task: dict[str, Any] = {}
        self._console_history: list[str] = []
        self._step_console: list[str] = []
        self._step_python_code = ""
        self._step_python_output = ""
        self._page_target_id = ""
        self._page_selection_source = ""
        self._initial_target_id = ""
        self._replay_target_id = ""
        self._resume_target_id = ""
        self._resume_last_url = ""
        self._resume_last_title = ""
        self._resume_browser_instance_id = ""
        self._start_url_ready = False
        self._last_url = ""
        self._last_title = ""

    def _screenshots_dir(self) -> Path:
        return self.config.output_dir / "screenshots"

    def _steps_dir(self) -> Path:
        return self.config.output_dir / "steps"

    def _existing_step_index(self) -> int:
        steps_dir = self._steps_dir()
        if not steps_dir.exists():
            return 0
        max_index = 0
        for path in steps_dir.glob("step_*.*"):
            stem = path.stem
            if not stem.startswith("step_"):
                continue
            suffix = stem.removeprefix("step_")
            try:
                max_index = max(max_index, int(suffix))
            except ValueError:
                continue
        return max_index

    def prepare(self, **kwargs) -> None:
        self._prepared_task = dict(kwargs)
        self._console_history = []
        self._step_console = []
        self._initial_target_id = str(kwargs.get("initial_target_id", "") or "")
        self._replay_target_id = str(kwargs.get("replay_target_id", "") or "")
        self._resume_target_id = str(kwargs.get("resume_target_id", "") or "")
        self._resume_last_url = str(kwargs.get("resume_last_url", "") or "")
        self._resume_last_title = str(kwargs.get("resume_last_title", "") or "")
        self._resume_browser_instance_id = str(kwargs.get("resume_browser_instance_id", "") or "")
        self._page_target_id = ""
        self._page_selection_source = ""
        start_url = kwargs.get("start_url") or self.config.start_url
        if start_url:
            self.config.start_url = str(start_url)

        self.config.output_dir.mkdir(parents=True, exist_ok=True)
        self._steps_dir().mkdir(parents=True, exist_ok=True)
        self._screenshots_dir().mkdir(parents=True, exist_ok=True)
        self._step_index = (
            self._existing_step_index() if self.config.resume_existing_output else 0
        )
        (self.config.output_dir / "task.json").write_text(
            json.dumps(kwargs, indent=2),
            encoding="utf-8",
        )
        self._run(self._prepare_async())
        page_url = str(getattr(self._page, "url", "") or "") if self._page is not None else ""
        self._last_url = page_url
        self._start_url_ready = bool(
            self.config.start_url
            and page_url
            and _normalize_page_url(page_url) == _normalize_page_url(self.config.start_url)
        )

    def initial_observation(self) -> dict[str, Any]:
        return self._run(self._initial_observation_async())

    async def _initial_observation_async(self) -> dict[str, Any]:
        page = self._page
        if page is None:
            raise RuntimeError("Browser environment was not prepared.")
        if self._browser_disconnected():
            raise RuntimeExecutionError(
                "Agent 浏览器已关闭，本次探索无法继续，请新建探索。",
                error_code="browser_disconnected",
                stage="initial_observation",
            )
        url = str(getattr(page, "url", "") or self.config.start_url or "")
        title = ""
        aria_snapshot = ""
        try:
            title = str(
                await page.locator("title").text_content(
                    timeout=self.config.observation_timeout_ms
                )
                or ""
            )
        except Exception:
            title = ""
        try:
            aria_snapshot = await page.locator("body").aria_snapshot(
                timeout=self.config.observation_timeout_ms,
            )
        except Exception:
            aria_snapshot = ""
        if self._browser_disconnected():
            raise RuntimeExecutionError(
                "Agent 浏览器已关闭，本次探索无法继续，请新建探索。",
                error_code="browser_disconnected",
                stage="initial_observation",
            )
        self._last_url = url
        self._last_title = title
        return {
            "url": url,
            "title": title,
            "aria_snapshot": aria_snapshot[:3000],
            "target_id": self._page_target_id,
            "browser_connected": True,
            "page_closed": False,
        }

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
        return self._loop

    def _run(self, coro):
        loop = self._ensure_loop()
        return loop.run_until_complete(coro)

    async def _match_page_in_context(
        self,
        *,
        context: Any,
        target_info: dict[str, Any] | None,
        last_url: str,
        last_title: str,
        strict_target: bool = False,
    ) -> tuple[Any | None, str]:
        pages = list(getattr(context, "pages", []) or [])
        if not pages:
            return None, ""

        target_id = str((target_info or {}).get("id", "") or "")
        if target_id:
            for page in pages:
                try:
                    page_target_id = await self._target_id_for_page(context, page)
                except Exception:
                    continue
                if page_target_id == target_id:
                    self._page_target_id = target_id
                    return page, "cdp_target_id"
            return None, ""

        if strict_target:
            return None, ""

        if last_url:
            matches = [page for page in pages if str(getattr(page, "url", "") or "") == last_url]
            if len(matches) == 1:
                self._page_target_id = await self._target_id_for_page(context, matches[0])
                return matches[0], "last_url"
            if len(matches) > 1 and last_title:
                for page in matches:
                    try:
                        if await page.title() == last_title:
                            self._page_target_id = await self._target_id_for_page(context, page)
                            return page, "last_url"
                    except Exception:
                        continue

        if self.config.start_url:
            matches = [
                page for page in pages if str(getattr(page, "url", "") or "") == self.config.start_url
            ]
            if matches:
                return matches[0], "start_url"

        if pages:
            return pages[0], "first_existing_page"
        return None, ""

    async def _target_id_for_page(self, context: Any, page: Any) -> str:
        return await _shared_target_id_for_page(context, page)

    async def _refresh_page_runtime_state(self) -> None:
        page = self._page
        if page is None:
            return
        target_id = await self._target_id_for_page(self._context, page)
        if not target_id:
            raise RuntimeError("Could not resolve CDP target_id for the selected browser page.")
        self._page_target_id = target_id

    def _ensure_local_cdp_browser(self) -> None:
        if _is_local_cdp_available(self.config.local_cdp_url):
            return
        if not self.config.local_cdp_auto_start:
            raise RuntimeError(
                "Local CDP endpoint is not reachable. Start Chrome/Chromium with "
                f"remote debugging enabled for {self.config.local_cdp_url}."
            )
        self._local_cdp_process = _launch_local_cdp_browser(
            self.config.local_cdp_url,
            user_data_dir=self.config.user_data_dir,
            executable_path=self.config.local_cdp_executable,
            launch_args=list(self.config.launch_args),
            startup_timeout_seconds=self.config.local_cdp_startup_timeout_seconds,
        )

    async def _prepare_async(self) -> None:
        try:
            await self._prepare_connected_async()
        except BaseException:
            await self._close_async()
            raise

    async def _prepare_connected_async(self) -> None:
        from playwright.async_api import async_playwright
        from webwright.tool_runtime.managed_browser import ManagedBrowser, managed_browser_enabled

        if self._page is not None and self._context is not None:
            return

        self._playwright = await async_playwright().start()
        chromium = self._playwright.chromium
        launch_args = list(self.config.launch_args)
        if self.config.devtools:
            launch_args.append("--auto-open-devtools-for-tabs")
        launch_kwargs = {
            "headless": self.config.headless,
            "slow_mo": self.config.slow_mo_ms,
            "args": launch_args,
        }

        if self.config.browser_mode == "local_cdp":
            if managed_browser_enabled():
                self._managed_browser = ManagedBrowser()
                await asyncio.to_thread(self._managed_browser.acquire, visible=True)
                self._managed_browser.watch_current_task()
                self.config.local_cdp_url = self._managed_browser.http_url
                if self._resume_browser_instance_id and self._resume_browser_instance_id != self._managed_browser.descriptor["instanceId"]:
                    raise RuntimeError("浏览器实例已变化，旧探索页面绑定已失效，请重新选择页面")
            else:
                self._ensure_local_cdp_browser()
            created_target = _ensure_local_cdp_page_target(self.config.local_cdp_url)
            self._browser = await chromium.connect_over_cdp(self.config.local_cdp_url)
            self._connected_over_cdp = True
            self._context = (
                self._browser.contexts[0]
                if self._browser.contexts
                else await self._browser.new_context(no_viewport=True)
            )
            matched_page = None
            if self._initial_target_id:
                target_info = _find_cdp_target_by_id(
                    self.config.local_cdp_url, self._initial_target_id
                )
                if target_info is None:
                    raise RuntimeError(
                        f"Prepared browser target no longer exists: {self._initial_target_id}"
                    )
                if _normalize_page_url(str(target_info.get("url", "") or "")) != _normalize_page_url(
                    self.config.start_url or ""
                ):
                    raise RuntimeError("Prepared Agent browser page no longer matches start_url.")
                _activate_cdp_target(self.config.local_cdp_url, self._initial_target_id)
                matched_page, source = await self._match_page_in_context(
                    context=self._context,
                    target_info=target_info,
                    last_url="",
                    last_title="",
                    strict_target=True,
                )
                if matched_page is None:
                    raise RuntimeError(
                        f"Could not attach to prepared browser target: {self._initial_target_id}"
                    )
                self._page = matched_page
                self._page_selection_source = source
            elif self._replay_target_id:
                target_info = _find_cdp_target_by_id(
                    self.config.local_cdp_url, self._replay_target_id
                )
                if target_info is None:
                    raise RuntimeError(
                        f"Replay browser target no longer exists: {self._replay_target_id}"
                    )
                matched_page, _source = await self._match_page_in_context(
                    context=self._context,
                    target_info=target_info,
                    last_url="",
                    last_title="",
                    strict_target=True,
                )
                if matched_page is None:
                    raise RuntimeError(
                        f"Could not attach to replay browser target: {self._replay_target_id}"
                    )
                _activate_cdp_target(
                    self.config.local_cdp_url, self._replay_target_id
                )
                self._page = matched_page
                self._page_selection_source = "replay_target_id"
            elif self.config.resume_existing_page:
                target_info = None
                if self._resume_target_id:
                    target_info = _find_cdp_target_by_id(
                        self.config.local_cdp_url, self._resume_target_id
                    )
                    if target_info is None:
                        raise RuntimeError(
                            f"Saved browser target no longer exists: {self._resume_target_id}"
                        )
                matched_page, source = await self._match_page_in_context(
                    context=self._context,
                    target_info=target_info,
                    last_url=self._resume_last_url,
                    last_title=self._resume_last_title,
                    strict_target=bool(self._resume_target_id),
                )
                if self._resume_target_id and matched_page is None:
                    raise RuntimeError(
                        f"Could not attach to saved browser target: {self._resume_target_id}"
                    )
                if matched_page is not None:
                    self._page = matched_page
                    self._page_selection_source = source

            if self._page is None and (self._managed_browser or self.config.local_cdp_new_page or not self._context.pages):
                existing_ids = {
                    str(target.get("id", "") or "")
                    for target in _local_cdp_page_targets(self.config.local_cdp_url)
                }
                self._page = await self._context.new_page()
                self._local_cdp_page = self._page
                self._page_selection_source = "new_page"
                if created_target is not None:
                    self._page_target_id = str(created_target.get("id", "") or "")
                elif not self._page_target_id:
                    new_target = _find_new_cdp_target(self.config.local_cdp_url, existing_ids)
                    if new_target is not None:
                        self._page_target_id = str(new_target.get("id", "") or "")
                await self._refresh_page_runtime_state()
            else:
                if self._page is None:
                    self._page = self._context.pages[0]
                    self._page_selection_source = "first_existing_page"
                await self._refresh_page_runtime_state()
            if self._managed_browser:
                await asyncio.to_thread(self._managed_browser.claim, self._page_target_id)
        elif self.config.browser_mode == "local_persistent":
            self.config.user_data_dir.mkdir(parents=True, exist_ok=True)
            self._context = await chromium.launch_persistent_context(
                user_data_dir=str(self.config.user_data_dir),
                viewport={
                    "width": self.config.browser_width,
                    "height": self.config.browser_height,
                },
                **launch_kwargs,
            )
            self._browser = self._context.browser
            self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        else:
            self._browser = await chromium.launch(**launch_kwargs)
            self._context = await self._browser.new_context(
                viewport={
                    "width": self.config.browser_width,
                    "height": self.config.browser_height,
                }
            )
            self._page = await self._context.new_page()

        self._context.set_default_timeout(self.config.browser_timeout_ms)
        self._context.set_default_navigation_timeout(self.config.browser_navigation_timeout_ms)
        self._attach_page_listeners(self._page)
        should_skip_start_url = (
            self.config.browser_mode == "local_cdp"
            and (
                self._initial_target_id
                or self._replay_target_id
                or self.config.resume_existing_page
            )
            and self._page is not None
            and self._page_selection_source != "new_page"
        )
        if self.config.start_url and not should_skip_start_url:
            await self._page.goto(self.config.start_url, wait_until="domcontentloaded")

    def _attach_page_listeners(self, page: Any) -> None:
        page.on("console", self._on_console_message)
        page.on("pageerror", self._on_page_error)

    def _on_console_message(self, message: Any) -> None:
        text = getattr(message, "text", "")
        if callable(text):
            text = text()
        line = str(text)
        self._console_history.append(line)
        self._step_console.append(line)

    def _on_page_error(self, error: Any) -> None:
        line = f"Page error: {error}"
        self._console_history.append(line)
        self._step_console.append(line)

    def execute(self, action: dict[str, Any], cwd: str = "") -> dict[str, Any]:
        del cwd
        return self._run(self._execute_async(action))

    async def _execute_async(self, action: dict[str, Any]) -> dict[str, Any]:
        if self._managed_browser:
            self._managed_browser.watch_current_task()
        self._step_index += 1
        self._step_console = []
        self._step_python_output = ""
        self._step_python_code = self._with_initial_navigation(
            str(action.get("python_code", "") or "")
        )
        self._persist_step_code(self._step_python_code)

        success = True
        exception_text = ""
        fatal_error_code = ""
        fatal_error_stage = ""
        try:
            if self._step_python_code.strip():
                await asyncio.wait_for(
                    self._run_python_code(self._step_python_code),
                    timeout=self.config.step_execution_timeout_ms / 1000,
                )
            await self._wait_for_observation_ready()
        except Exception:
            success = False
            exception_text = traceback.format_exc()

        if self._browser_disconnected():
            success = False
            fatal_error_code = "browser_disconnected"
            fatal_error_stage = "browser_action"
            if not exception_text:
                exception_text = "Agent browser disconnected during browser action."

        if fatal_error_code:
            observation = {
                "success": False,
                "exception": exception_text,
                "url": self._last_url or self.config.start_url or "",
                "title": self._last_title,
                "screenshot_path": "",
                "aria_snapshot": "",
                "python_code": self._step_python_code,
                "python_output": self._step_python_output,
                "console_output": "\n".join(self._step_console[-20:]),
                "recent_console": "\n".join(self._console_history[-50:]),
            }
        else:
            observation = await self._capture_observation(
                success=success,
                exception_text=exception_text,
            )
            if self._browser_disconnected():
                success = False
                fatal_error_code = "browser_disconnected"
                fatal_error_stage = "browser_observation"
                exception_text = (
                    exception_text
                    or "Agent browser disconnected while capturing the page observation."
                )
                observation.update(
                    {
                        "success": False,
                        "exception": exception_text,
                        "screenshot_path": "",
                    }
                )
        return {
            "output": self._step_python_output,
            "returncode": 0 if success else 1,
            "exception_info": exception_text,
            "observation": observation,
            "fatal_error_code": fatal_error_code,
            "fatal_error_stage": fatal_error_stage,
            "fatal_error_message": (
                (
                    "Agent 浏览器已关闭，本次探索无法继续，请新建探索。"
                    if fatal_error_stage == "browser_observation"
                    else "Agent 浏览器已关闭，本次探索无法继续，请新建探索。"
                )
                if fatal_error_code
                else ""
            ),
        }

    def _browser_disconnected(self) -> bool:
        browser = self._browser
        if browser is not None:
            try:
                is_connected = getattr(browser, "is_connected", None)
                if callable(is_connected) and not is_connected():
                    return True
            except Exception:
                return True
        page = self._page
        if page is not None:
            try:
                is_closed = getattr(page, "is_closed", None)
                if callable(is_closed) and is_closed():
                    return True
            except Exception:
                return True
        return False

    def _with_initial_navigation(self, python_code: str) -> str:
        if self._step_index != 1 or not self.config.start_url or self._start_url_ready:
            return python_code
        navigation = (
            f"await page.goto({json.dumps(self.config.start_url, ensure_ascii=False)}, "
            'wait_until="domcontentloaded")'
        )
        lines = python_code.splitlines()
        first_line = lines[0].strip() if lines else ""
        if first_line == navigation:
            return python_code
        return f"{navigation}\n{python_code}" if python_code else navigation

    def _persist_step_code(self, python_code: str) -> None:
        step_path = self._steps_dir() / f"step_{self._step_index:04d}.py"
        step_path.write_text(python_code, encoding="utf-8")

        script_path = self.config.output_dir / "script.py"
        with script_path.open("a", encoding="utf-8") as handle:
            handle.write(f"\n\n# Step {self._step_index}\n")
            handle.write(python_code)
            handle.write("\n")

    async def _run_python_code(self, python_code: str) -> None:
        if self._page is None or self._context is None or self._playwright is None:
            raise RuntimeError("Browser environment was not prepared.")

        buffer = io.StringIO()
        globals_dict: dict[str, Any] = {"asyncio": asyncio}
        locals_dict: dict[str, Any] = {}
        wrapped = "async def __agent_step__(page, context, browser, playwright, task):\n"
        wrapped += textwrap.indent(python_code, "    ")
        with redirect_stdout(buffer), redirect_stderr(buffer):
            exec(wrapped, globals_dict, locals_dict)
            await locals_dict["__agent_step__"](
                self._page,
                self._context,
                self._browser,
                self._playwright,
                self._prepared_task,
            )
        self._step_python_output = buffer.getvalue()

    async def _wait_for_observation_ready(self) -> None:
        if self._page is None:
            return
        try:
            await self._page.wait_for_load_state(
                "domcontentloaded",
                timeout=self.config.observation_timeout_ms,
            )
        except Exception:
            pass

    async def _capture_observation(self, *, success: bool, exception_text: str) -> dict[str, Any]:
        page = self._page
        url = ""
        title = ""
        aria_snapshot = ""
        screenshot_path: Path | None = None

        if page is not None:
            try:
                url = page.url
            except Exception:
                url = self.config.start_url or ""
            try:
                title = str(
                    await page.locator("title").text_content(
                        timeout=self.config.observation_timeout_ms
                    )
                    or ""
                )
            except Exception:
                title = ""
            self._page_selection_source = self._page_selection_source or "current_page"
            try:
                aria_snapshot = await page.locator("body").aria_snapshot(
                    timeout=self.config.observation_timeout_ms,
                )
            except Exception:
                aria_snapshot = ""
            try:
                screenshot_path = self._screenshots_dir() / f"step_{self._step_index:04d}.png"
                await page.screenshot(
                    path=str(screenshot_path),
                    full_page=False,
                    timeout=self.config.observation_timeout_ms,
                )
            except Exception:
                screenshot_path = None

        self._last_url = url or self._last_url
        self._last_title = title or self._last_title
        return {
            "success": success,
            "exception": exception_text,
            "url": url or self.config.start_url or "",
            "title": title,
            "screenshot_path": str(screenshot_path) if screenshot_path is not None else "",
            "aria_snapshot": aria_snapshot,
            "python_code": self._step_python_code,
            "python_output": self._step_python_output,
            "console_output": "\n".join(self._step_console[-20:]),
            "recent_console": "\n".join(self._console_history[-50:]),
        }

    def get_template_vars(self, **kwargs) -> dict[str, Any]:
        return {
            "start_url": self.config.start_url or "",
            "output_dir": str(self.config.output_dir.resolve()),
            "browser_mode": self.config.browser_mode,
            "user_data_dir": str(self.config.user_data_dir),
            **kwargs,
        }

    def serialize(self) -> dict[str, Any]:
        runtime_state = {
            "target_id": self._page_target_id,
            "last_url": self._last_url,
            "last_title": self._last_title,
            "page_selection_source": self._page_selection_source,
        }
        if self._managed_browser:
            runtime_state["browser_instance_id"] = self._managed_browser.descriptor["instanceId"]
        if self._page is not None:
            try:
                runtime_state["last_url"] = str(getattr(self._page, "url", "") or "")
            except Exception:
                pass
        return {
            "environment": {
                "config": self.config.model_dump(mode="json"),
                "environment_type": f"{self.__class__.__module__}.{self.__class__.__name__}",
                "runtime_state": runtime_state,
            }
        }

    def close(self) -> None:
        if self.config.prompt_before_close:
            input("Press Enter to close the browser...")
        if self.config.keep_open_on_exit:
            return
        try:
            self._run(self._close_async())
        finally:
            if self._loop is not None and not self._loop.is_closed():
                self._loop.close()
            self._loop = None

    async def _close_async(self) -> None:

        context = self._context
        browser = self._browser
        page = self._local_cdp_page
        playwright = self._playwright
        connected_over_cdp = self._connected_over_cdp
        local_cdp_process = self._local_cdp_process
        self._page = None
        self._local_cdp_page = None
        self._context = None
        self._browser = None
        self._playwright = None
        self._connected_over_cdp = False
        self._local_cdp_process = None

        try:
            if connected_over_cdp:
                if page is not None and self.config.local_cdp_close_page_on_exit:
                    try:
                        await page.close()
                    except Exception:
                        pass
                if (
                    local_cdp_process is not None
                    and self.config.local_cdp_close_started_browser_on_exit
                ):
                    local_cdp_process.terminate()
            elif context is not None:
                await context.close()
            elif browser is not None:
                await browser.close()
        finally:
            try:
                if playwright is not None:
                    await playwright.stop()
            finally:
                if self._managed_browser:
                    await asyncio.to_thread(self._managed_browser.close)
                    self._managed_browser = None
