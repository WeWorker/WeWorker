from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import queue
import threading
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import urlparse, urlsplit
from urllib.request import ProxyHandler, build_opener


DEFAULT_CDP_URL = "http://127.0.0.1:9222"
PLAYWRIGHT_REQUIREMENT = "playwright==1.60.0\n"
POSIX_CHROMIUM_EXECUTABLE_CANDIDATES = (
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
    "chrome",
)
EMPTY_RUNTIME_STATE = {
    "target_id": "",
    "last_url": "",
    "last_title": "",
    "updated_at": "",
}
_PYTHON_TYPES = {
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
    "object": dict,
    "array": list,
}
_LOCAL_CDP_HOSTS = {"127.0.0.1", "localhost"}
_CDP_OPENER = build_opener(ProxyHandler({}))


def managed_browser_enabled() -> bool:
    return os.environ.get("WEWORKER_BROWSER_MANAGED") == "1" or bool(
        os.environ.get("WEWORKER_WEBCLI_NODE") and os.environ.get("WEWORKER_WEBCLI_ENTRY")
    )


def resource_key(value: str) -> str:
    return "toolkit:" + hashlib.sha256(value.encode()).hexdigest()


class ManagedBrowser:
    def __init__(self):
        node = os.environ.get("WEWORKER_WEBCLI_NODE")
        entry = os.environ.get("WEWORKER_WEBCLI_ENTRY")
        if not node or not entry:
            raise RuntimeError("宿主未提供浏览器控制入口，请从 WeWorker 或 WebCLI 运行")
        env = _external_process_environment()
        env["ELECTRON_RUN_AS_NODE"] = "1"
        self.process = subprocess.Popen(
            [node, entry, "--internal-browser-control"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            encoding="utf-8", env=env,
        )
        self.responses = queue.Queue()
        self.descriptor = {}
        self.closed = False
        self.lost = False
        self._watched = None
        self._counter = 0
        self._lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for line in self.process.stdout:
                response = json.loads(line)
                if response.get("event") == "disconnected":
                    break
                self.responses.put(response)
        finally:
            self.lost = True
            self.responses.put(None)
            if not self.closed and self._watched:
                loop, task = self._watched
                if not loop.is_closed():
                    loop.call_soon_threadsafe(task.cancel)

    def watch_current_task(self):
        self.assert_connected()
        self._watched = (asyncio.get_running_loop(), asyncio.current_task())

    def assert_connected(self):
        if self.lost or self.closed:
            raise RuntimeError("共享浏览器控制连接已断开，请检查执行结果后重新发起任务；不会自动重放操作")

    def request(self, action, **params):
        with self._lock:
            self.assert_connected()
            self._counter += 1
            self.process.stdin.write(json.dumps({"id": self._counter, "action": action, "params": params}) + "\n")
            self.process.stdin.flush()
            response = self.responses.get(timeout=50)
            if response is None:
                raise RuntimeError("共享浏览器连接已断开")
            if not response.get("ok"):
                error = response.get("error") or {}
                raise RuntimeError(f"{error.get('code', 'BROWSER_FAILED')}: {error.get('message', '')}")
            return response["data"]

    def acquire(self, *, resource="", visible=False):
        self.descriptor = self.request("acquire", resource=resource, visible=visible)
        return self.descriptor["cdpUrl"]

    @property
    def http_url(self):
        parsed = urlsplit(self.descriptor["cdpUrl"])
        return f"http://{parsed.netloc}"

    def claim(self, target_id):
        return self.request("claim", leaseId=self.descriptor["leaseId"], targetId=target_id)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self._watched = None
        self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=3)
        self.process.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class RuntimeRecoveryError(RuntimeError):
    def __init__(self, *, code: str, message: str):
        super().__init__(message)
        self.code = code


def _cdp_origin(cdp_url: str) -> str:
    parsed = urlparse(cdp_url or DEFAULT_CDP_URL)
    scheme = parsed.scheme or "http"
    netloc = parsed.netloc or parsed.path
    if not netloc:
        netloc = urlparse(DEFAULT_CDP_URL).netloc
    return f"{scheme}://{netloc}".rstrip("/")


def _cdp_port(cdp_url: str) -> int:
    parsed = urlparse(cdp_url or DEFAULT_CDP_URL)
    if parsed.port is not None:
        return parsed.port
    return 443 if parsed.scheme == "https" else 80


def _is_local_cdp_url(cdp_url: str) -> bool:
    parsed = urlparse(cdp_url or DEFAULT_CDP_URL)
    return parsed.scheme == "http" and parsed.hostname in _LOCAL_CDP_HOSTS


def is_cdp_available(cdp_url: str, *, timeout_seconds: float = 0.5) -> bool:
    try:
        with _CDP_OPENER.open(
            f"{_cdp_origin(cdp_url)}/json/version", timeout=timeout_seconds
        ) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def default_user_data_dir(
    *, platform_name: str | None = None, environ: dict[str, str] | None = None
) -> Path:
    platform_name = platform_name or os.name
    environ = environ if environ is not None else os.environ
    configured = environ.get("WEBWRIGHT_BROWSER_PROFILE")
    if configured:
        return Path(configured).expanduser()
    home = Path(
        environ.get("WEBWRIGHT_HOME") or Path.home() / ".weworker" / "webwright"
    ).expanduser()
    return home / "browser" / "profile"


def _windows_registry_app_paths() -> list[str]:
    try:
        import winreg
    except ImportError:
        return []
    paths: list[str] = []
    access_modes = [winreg.KEY_READ]
    for flag_name in ("KEY_WOW64_64KEY", "KEY_WOW64_32KEY"):
        flag = getattr(winreg, flag_name, 0)
        if flag:
            access_modes.append(winreg.KEY_READ | flag)
    for executable in ("msedge.exe", "chrome.exe", "chromium.exe"):
        key_path = (
            "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\"
            f"{executable}"
        )
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for access in access_modes:
                try:
                    with winreg.OpenKey(hive, key_path, 0, access) as key:
                        value, _ = winreg.QueryValueEx(key, None)
                except OSError:
                    continue
                if isinstance(value, str) and value:
                    paths.append(value)
    return list(dict.fromkeys(paths))


def chromium_executable_candidates() -> list[str]:
    if os.name != "nt":
        return list(POSIX_CHROMIUM_EXECUTABLE_CANDIDATES)
    candidates = ["msedge.exe", "chrome.exe", "chromium.exe"]
    candidates.extend(_windows_registry_app_paths())
    locations = (
        ("PROGRAMFILES", "Microsoft/Edge/Application/msedge.exe"),
        ("PROGRAMFILES(X86)", "Microsoft/Edge/Application/msedge.exe"),
        ("PROGRAMFILES", "Google/Chrome/Application/chrome.exe"),
        ("PROGRAMFILES(X86)", "Google/Chrome/Application/chrome.exe"),
        ("LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"),
        ("LOCALAPPDATA", "Chromium/Application/chrome.exe"),
    )
    candidates.extend(
        str(Path(root) / relative_path)
        for env_name, relative_path in locations
        if (root := os.environ.get(env_name))
    )
    return list(dict.fromkeys(candidates))


def find_chromium_executable(explicit_path: str = "") -> str:
    candidates = [explicit_path] if explicit_path else []
    candidates.extend(
        [
            value
            for value in (
                os.environ.get("WEBWRIGHT_BROWSER_EXECUTABLE"),
            )
            if value
        ]
    )
    candidates.extend(chromium_executable_candidates())
    attempted: list[str] = []
    for candidate in candidates:
        expanded = os.path.expanduser(candidate)
        attempted.append(expanded)
        if Path(expanded).exists():
            return expanded
        resolved = shutil.which(expanded)
        if resolved:
            return resolved
    raise FileNotFoundError(
        "Could not find Edge/Chrome/Chromium. Set WEBWRIGHT_BROWSER_EXECUTABLE. "
        f"Tried: {', '.join(attempted)}"
    )


def _detached_process_kwargs() -> dict[str, Any]:
    if os.name == "nt":
        return {
            "creationflags": (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            )
        }
    return {"start_new_session": True}


def _macos_open_app_name(executable: str) -> str:
    if sys.platform != "darwin":
        return ""
    if "/Microsoft Edge.app/" in executable:
        return "Microsoft Edge"
    if "/Google Chrome.app/" in executable:
        return "Google Chrome"
    return ""


def _external_process_environment() -> dict[str, str]:
    environment = dict(os.environ)
    for name in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        original_name = f"{name}_ORIG"
        if original_name in environment:
            original = environment.pop(original_name)
            if original:
                environment[name] = original
            else:
                environment.pop(name, None)
    bundle_root = str(getattr(sys, "_MEIPASS", "") or "")
    if bundle_root and environment.get("PATH"):
        resolved_bundle = Path(bundle_root).resolve()
        environment["PATH"] = os.pathsep.join(
            entry
            for entry in environment["PATH"].split(os.pathsep)
            if entry and not Path(entry).resolve().is_relative_to(resolved_bundle)
        )
    return environment


def _set_windows_dll_directory(path: str | None) -> bool:
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return False
    import ctypes

    return bool(ctypes.windll.kernel32.SetDllDirectoryW(path))


def launch_browser(
    cdp_url: str,
    *,
    user_data_dir: Path | None = None,
    executable_path: str = "",
    launch_args: list[str] | None = None,
    startup_timeout_seconds: float = 10,
    availability_checker: Callable[[str], bool] | None = None,
    executable_finder: Callable[[str], str] | None = None,
    process_kwargs_factory: Callable[[], dict[str, Any]] | None = None,
    app_name_resolver: Callable[[str], str] | None = None,
    environment: Mapping[str, str] | None = None,
) -> Any:
    availability_checker = availability_checker or is_cdp_available
    executable_finder = executable_finder or find_chromium_executable
    process_kwargs_factory = process_kwargs_factory or _detached_process_kwargs
    app_name_resolver = app_name_resolver or _macos_open_app_name
    if availability_checker(cdp_url):
        return None
    if not _is_local_cdp_url(cdp_url):
        raise RuntimeError(f"Cannot auto-start a remote CDP endpoint: {cdp_url}")
    user_data_dir = user_data_dir or default_user_data_dir()
    user_data_dir.mkdir(parents=True, exist_ok=True)
    executable = executable_finder(executable_path)
    browser_flags = [
        "--remote-debugging-address=127.0.0.1",
        f"--remote-debugging-port={_cdp_port(cdp_url)}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        *(launch_args or []),
    ]
    app_name = app_name_resolver(executable)
    launched_with_open = bool(app_name)
    command = (
        ["open", "-na", app_name, "--args", *browser_flags]
        if launched_with_open
        else [executable, *browser_flags]
    )
    reset_windows_dlls = _set_windows_dll_directory(None)
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=(
                dict(environment)
                if environment is not None
                else _external_process_environment()
            ),
            **process_kwargs_factory(),
        )
    finally:
        if reset_windows_dlls:
            _set_windows_dll_directory(str(getattr(sys, "_MEIPASS", "") or ""))
    deadline = time.monotonic() + startup_timeout_seconds
    while time.monotonic() < deadline:
        if not launched_with_open and process.poll() is not None:
            raise RuntimeError(
                f"Chrome/Chromium exited before CDP became available: {cdp_url}"
            )
        if availability_checker(cdp_url):
            return process
        time.sleep(0.2)
    if not launched_with_open and process.poll() is None:
        process.terminate()
    raise TimeoutError(f"Timed out waiting for local CDP endpoint: {cdp_url}")


class RuntimeStore(Protocol):
    def read(self) -> dict[str, Any]: ...

    def write(
        self, *, target_id: str, last_url: str, last_title: str, browser_instance_id: str = ""
    ) -> dict[str, Any]: ...


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


class FileRuntimeStore:
    def __init__(self, path: Path | str):
        self.path = Path(path).expanduser().resolve()

    def ensure(self) -> dict[str, Any]:
        if not self.path.is_file():
            _atomic_write_json(self.path, dict(EMPTY_RUNTIME_STATE))
        return self.read()

    def read(self) -> dict[str, Any]:
        if not self.path.is_file():
            return dict(EMPTY_RUNTIME_STATE)
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("runtime.json must contain a JSON object.")
        result = {key: str(payload.get(key) or "") for key in EMPTY_RUNTIME_STATE}
        if payload.get("browser_instance_id"):
            result["browser_instance_id"] = str(payload["browser_instance_id"])
        return result

    def write(
        self, *, target_id: str, last_url: str, last_title: str, browser_instance_id: str = ""
    ) -> dict[str, Any]:
        payload = {
            "target_id": str(target_id or ""),
            "last_url": str(last_url or ""),
            "last_title": str(last_title or ""),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if browser_instance_id:
            payload["browser_instance_id"] = browser_instance_id
        _atomic_write_json(self.path, payload)
        return payload


def runtime_state_path(*, toolkit_id: str, skill_dir: Path | str) -> Path:
    explicit = os.environ.get("WEBWRIGHT_RUNTIME_PATH")
    if explicit:
        return Path(explicit).expanduser().resolve()
    configured_root = os.environ.get("WEBWRIGHT_STATE_DIR")
    if configured_root:
        root = Path(configured_root).expanduser()
    else:
        home = Path(
            os.environ.get("WEBWRIGHT_HOME")
            or Path.home() / ".weworker" / "webwright"
        ).expanduser()
        root = home / "toolkit-state"
    resolved_skill = Path(skill_dir).expanduser().resolve()
    instance_hash = hashlib.sha256(str(resolved_skill).encode()).hexdigest()[:16]
    return (root / f"{toolkit_id}-{instance_hash}" / "runtime.json").resolve()


@dataclass(frozen=True)
class ToolContext:
    page: Any
    browser_context: Any
    browser: Any


def _hostname(url: str) -> str:
    return (urlsplit(str(url or "")).hostname or "").lower().rstrip(".")


async def target_id_for_page(context: Any, page: Any) -> str:
    session = await context.new_cdp_session(page)
    try:
        payload = await session.send("Target.getTargetInfo")
    finally:
        try:
            await session.detach()
        except Exception:
            pass
    target_info = payload.get("targetInfo") if isinstance(payload, dict) else None
    if not isinstance(target_info, dict):
        return ""
    return str(target_info.get("targetId", "") or "")


async def find_page_by_target_id(context: Any, target_id: str) -> Any | None:
    if not target_id:
        return None
    for page in list(getattr(context, "pages", []) or []):
        try:
            if await target_id_for_page(context, page) == target_id:
                return page
        except Exception:
            continue
    return None


class ToolkitBrowserSession:
    def __init__(
        self,
        *,
        runtime_store: RuntimeStore,
        allowed_domains: list[str] | set[str] | tuple[str, ...],
        cdp_url: str = DEFAULT_CDP_URL,
        playwright_factory: Callable[[], Any] | None = None,
        browser_launcher: Callable[[str], Any] | None = None,
    ):
        self.runtime_store = runtime_store
        self.cdp_url = cdp_url
        self.playwright_factory = playwright_factory
        self.browser_launcher = browser_launcher or launch_browser
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.allowed_domains = {str(domain) for domain in allowed_domains}
        self.managed_browser = None

    async def open(self, tool: dict[str, Any]) -> ToolContext:
        if managed_browser_enabled():
            self.managed_browser = ManagedBrowser()
            resource = resource_key(str(getattr(self.runtime_store, "path", "") or getattr(self.runtime_store, "toolkit_id", "")))
            self.cdp_url = await asyncio.to_thread(self.managed_browser.acquire, resource=resource)
            self.managed_browser.watch_current_task()
        if self.playwright_factory is None:
            from playwright.async_api import async_playwright

            manager = async_playwright()
        else:
            manager = self.playwright_factory()
        self.playwright = await manager.start()
        try:
            self.browser = await self.playwright.chromium.connect_over_cdp(self.cdp_url)
        except Exception as first_error:
            if self.managed_browser:
                raise RuntimeRecoveryError(code="browser_unavailable", message="共享浏览器连接失败；不会启动另一个浏览器或重放操作") from first_error
            if not _is_local_cdp_url(self.cdp_url):
                raise RuntimeRecoveryError(
                    code="browser_unavailable",
                    message=f"Could not connect to remote CDP endpoint: {self.cdp_url}",
                ) from first_error
            try:
                await asyncio.to_thread(self.browser_launcher, self.cdp_url)
            except Exception as launch_error:
                raise RuntimeRecoveryError(
                    code="browser_start_failed",
                    message=f"Could not start local CDP browser: {launch_error}",
                ) from launch_error
            try:
                self.browser = await self.playwright.chromium.connect_over_cdp(
                    self.cdp_url
                )
            except Exception as retry_error:
                raise RuntimeRecoveryError(
                    code="browser_unavailable",
                    message=f"Could not connect to local CDP endpoint after startup: {self.cdp_url}",
                ) from retry_error
        self.context = (
            self.browser.contexts[0]
            if self.browser.contexts
            else await self.browser.new_context(no_viewport=True)
        )

        runtime = self.runtime_store.read()
        saved_target_id = str(runtime.get("target_id") or "")
        if self.managed_browser and runtime.get("browser_instance_id") != self.managed_browser.descriptor["instanceId"]:
            saved_target_id = ""
        if saved_target_id:
            page = await find_page_by_target_id(self.context, saved_target_id)
            try:
                closed_check = getattr(page, "is_closed", None)
                is_closed = bool(closed_check()) if callable(closed_check) else False
            except Exception:
                is_closed = True
            if (
                page is not None
                and not is_closed
                and _hostname(str(page.url or "")) in self.allowed_domains
            ):
                self.page = page

        if self.page is None:
            await self._rebuild_page(tool)
        else:
            if self.managed_browser:
                await asyncio.to_thread(self.managed_browser.claim, saved_target_id)
            try:
                await self.persist()
            except Exception:
                self.page = None
                await self._rebuild_page(tool)
        return ToolContext(
            page=self.page,
            browser_context=self.context,
            browser=self.browser,
        )

    async def _rebuild_page(self, tool: dict[str, Any]) -> None:
        last_error: Exception | None = None
        for _attempt in range(1 if self.managed_browser else 2):
            try:
                self.page = await self.context.new_page()
                if self.managed_browser:
                    target_id = await target_id_for_page(self.context, self.page)
                    await asyncio.to_thread(self.managed_browser.claim, target_id)
                await self.page.goto(
                    str(tool["start_url"]), wait_until="domcontentloaded"
                )
                await self.persist()
                return
            except Exception as exc:
                last_error = exc
                failed_page = self.page
                self.page = None
                close_page = getattr(failed_page, "close", None)
                if callable(close_page):
                    try:
                        await close_page()
                    except Exception:
                        pass
        raise RuntimeRecoveryError(
            code="page_recovery_failed",
            message=f"Could not open a replacement Tool page: {last_error}",
        ) from last_error

    async def page_view(self) -> dict[str, str]:
        if self.page is None:
            return {"url": "", "title": ""}
        url = str(getattr(self.page, "url", "") or "")
        try:
            title = str(await self.page.title())
        except Exception:
            title = ""
        return {"url": url, "title": title}

    async def persist(self) -> dict[str, Any]:
        if self.page is None or self.context is None:
            return self.runtime_store.read()
        view = await self.page_view()
        if _hostname(view["url"]) not in self.allowed_domains:
            self.runtime_store.write(target_id="", last_url="", last_title="")
            raise RuntimeError("Tool page is outside Toolkit allowed_domains.")
        target_id = await target_id_for_page(self.context, self.page)
        if not target_id:
            raise RuntimeError("Could not resolve the selected browser page identity.")
        return self.runtime_store.write(
            target_id=target_id,
            last_url=view["url"],
            last_title=view["title"],
            **({"browser_instance_id": self.managed_browser.descriptor["instanceId"]} if self.managed_browser else {}),
        )

    async def close(self) -> None:
        try:
            if self.playwright is not None:
                await self.playwright.stop()
        finally:
            if self.managed_browser:
                await asyncio.to_thread(self.managed_browser.close)


def success_output(*, tool_id: str, data: Any, page: dict[str, str]) -> dict[str, Any]:
    return {"ok": True, "tool": tool_id, "data": data, "page": page}


def error_output(
    *,
    tool_id: str,
    code: str,
    message: str,
    page: dict[str, str],
    retryable: bool = False,
    needs_user: bool = False,
) -> dict[str, Any]:
    return {
        "ok": False,
        "tool": tool_id,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "needs_user": needs_user,
        },
        "page": page,
    }


def _validate_parameters(schema: dict[str, Any], parameters: dict[str, Any]) -> None:
    if not isinstance(parameters, dict):
        raise ValueError("Tool parameters must be a JSON object.")
    properties = schema.get("properties") or {}
    if schema.get("additionalProperties") is False:
        unknown = sorted(set(parameters) - set(properties))
        if unknown:
            raise ValueError(f"Unknown parameter: {unknown[0]}")
    for name in schema.get("required") or []:
        if name not in parameters:
            raise ValueError(f"Missing required parameter: {name}")
    for name, value in parameters.items():
        definition = properties.get(name)
        if not isinstance(definition, dict) or "type" not in definition:
            continue
        expected = _PYTHON_TYPES.get(str(definition["type"]))
        if expected is None:
            continue
        if definition["type"] in {"integer", "number"} and isinstance(value, bool):
            raise ValueError(f"Invalid parameter type for {name}: {definition['type']}")
        if not isinstance(value, expected):
            raise ValueError(f"Invalid parameter type for {name}: {definition['type']}")


def _validate_result(schema: dict[str, Any], result: Any) -> None:
    expected = _PYTHON_TYPES.get(str(schema.get("type") or ""))
    if expected is not None and not isinstance(result, expected):
        raise ValueError(f"Invalid Tool result type: {schema['type']}")
    if isinstance(result, dict):
        _validate_parameters(schema, result)


async def _capture_screenshot(page: Any, path: Path | None) -> None:
    if page is None or path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    await page.screenshot(path=str(path), full_page=True)


async def execute_tool(
    *,
    tool_id: str,
    tool: dict[str, Any],
    parameters_schema: dict[str, Any],
    result_schema: dict[str, Any],
    parameters: dict[str, Any],
    load_function: Callable[[], Callable[..., Any]],
    session: ToolkitBrowserSession,
    screenshot_path: Path | None,
) -> dict[str, Any]:
    page = {"url": "", "title": ""}
    try:
        _validate_parameters(parameters_schema, parameters)
        context = await session.open(tool)
        function = load_function()
        if not callable(function):
            raise ValueError(f"Tool code must define callable {tool_id}.")
        result = function(context, **parameters)
        if inspect.isawaitable(result):
            result = await result
        json.dumps(result, ensure_ascii=False)
        _validate_result(result_schema, result)
        await _capture_screenshot(context.page, screenshot_path)
        await session.persist()
        page = await session.page_view()
        return success_output(tool_id=tool_id, data=result, page=page)
    except RuntimeRecoveryError as exc:
        page = await session.page_view()
        return error_output(
            tool_id=tool_id,
            code=exc.code,
            message=str(exc),
            page=page,
            retryable=True,
        )
    except ValueError as exc:
        try:
            await _capture_screenshot(getattr(session, "page", None), screenshot_path)
        except Exception:
            pass
        page = await session.page_view()
        return error_output(
            tool_id=tool_id,
            code="invalid_tool_contract",
            message=str(exc),
            page=page,
        )
    except Exception as exc:
        try:
            await _capture_screenshot(getattr(session, "page", None), screenshot_path)
        except Exception:
            pass
        try:
            await session.persist()
        except Exception:
            pass
        page = await session.page_view()
        return error_output(
            tool_id=tool_id,
            code="tool_execution_failed",
            message=str(exc),
            page=page,
        )
    finally:
        await session.close()


class PublishedToolkitRunner:
    def __init__(
        self,
        *,
        toolkit_id: str,
        skill_dir: Path | str,
        allowed_domains: list[str] | set[str] | tuple[str, ...],
        tool_specs: Mapping[str, Mapping[str, Any]],
        tool_functions: Mapping[str, Callable[..., Any]],
        cdp_url: str = DEFAULT_CDP_URL,
        runtime_path: Path | str | None = None,
        session_factory: Callable[..., ToolkitBrowserSession] = ToolkitBrowserSession,
    ):
        self.toolkit_id = str(toolkit_id or "toolkit")
        self.skill_dir = Path(skill_dir).expanduser().resolve()
        self.allowed_domains = list(allowed_domains)
        self.tool_specs = {
            str(tool_id): dict(spec) for tool_id, spec in tool_specs.items()
        }
        self.tool_functions = dict(tool_functions)
        self.cdp_url = cdp_url
        self.session_factory = session_factory
        self.runtime_store = FileRuntimeStore(
            runtime_path
            or runtime_state_path(
                toolkit_id=self.toolkit_id,
                skill_dir=self.skill_dir,
            )
        )

    async def run(
        self,
        *,
        tool_id: str,
        parameters: dict[str, Any],
        screenshot_path: Path | None = None,
    ) -> dict[str, Any]:
        # Managed calls initialize state only after obtaining the Toolkit lease.
        if not managed_browser_enabled():
            self.runtime_store.ensure()
        tool = self.tool_specs.get(tool_id)
        function = self.tool_functions.get(tool_id)
        if tool is None or function is None:
            return error_output(
                tool_id=tool_id,
                code="version_not_found",
                message="Tool has no published version.",
                page={"url": "", "title": ""},
            )
        session = self.session_factory(
            runtime_store=self.runtime_store,
            allowed_domains=self.allowed_domains,
            cdp_url=self.cdp_url,
        )
        return await execute_tool(
            tool_id=tool_id,
            tool=tool,
            parameters_schema=tool["parameters_schema"],
            result_schema=tool["result_schema"],
            parameters=parameters,
            load_function=lambda: function,
            session=session,
            screenshot_path=screenshot_path,
        )
