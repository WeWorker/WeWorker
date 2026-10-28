from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse, urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request, build_opener

from webwright.tool_runtime.toolkit_runtime import launch_browser as _launch_browser
from webwright.paths import WebwrightPaths
from webwright.runtime_launcher import RuntimeLauncher


DEFAULT_CDP_URL = "http://127.0.0.1:9222"
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
_OPENER = build_opener(ProxyHandler({}))


def default_user_data_dir(
    *, platform_name: str | None = None, environ: dict[str, str] | None = None
) -> Path:
    platform_name = platform_name or os.name
    environ = environ if environ is not None else os.environ
    configured = environ.get("WEBWRIGHT_BROWSER_PROFILE")
    if configured:
        return Path(configured).expanduser()
    return WebwrightPaths.resolve(environ=environ).browser_profile


DEFAULT_USER_DATA_DIR = default_user_data_dir()


def urlopen_local_cdp(url_or_request: str | Request, *, timeout: float):
    return _OPENER.open(url_or_request, timeout=timeout)


def cdp_origin(cdp_url: str) -> str:
    parsed = urlparse(cdp_url or DEFAULT_CDP_URL)
    scheme = parsed.scheme or "http"
    netloc = parsed.netloc or parsed.path
    if not netloc:
        netloc = urlparse(DEFAULT_CDP_URL).netloc
    return f"{scheme}://{netloc}".rstrip("/")


def cdp_port(cdp_url: str) -> int:
    parsed = urlparse(cdp_url or DEFAULT_CDP_URL)
    if parsed.port is not None:
        return parsed.port
    return 443 if parsed.scheme == "https" else 80


def cdp_json_url(cdp_url: str, path: str) -> str:
    return f"{cdp_origin(cdp_url)}{path}"


def get_json(cdp_url: str, path: str, *, timeout_seconds: float = 0.5) -> Any:
    with urlopen_local_cdp(cdp_json_url(cdp_url, path), timeout=timeout_seconds) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"CDP endpoint returned HTTP {response.status}")
        return json.loads(response.read().decode("utf-8"))


def is_cdp_available(cdp_url: str, *, timeout_seconds: float = 0.5) -> bool:
    try:
        get_json(cdp_url, "/json/version", timeout_seconds=timeout_seconds)
        return True
    except Exception:
        return False


def page_targets(cdp_url: str, *, timeout_seconds: float = 0.5) -> list[dict[str, Any]]:
    try:
        payload = get_json(cdp_url, "/json/list", timeout_seconds=timeout_seconds)
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    return [
        target
        for target in payload
        if isinstance(target, dict) and target.get("type") == "page"
    ]


def find_target_by_id(
    cdp_url: str, target_id: str, *, timeout_seconds: float = 0.5
) -> dict[str, Any] | None:
    if not target_id:
        return None
    for target in page_targets(cdp_url, timeout_seconds=timeout_seconds):
        if str(target.get("id", "")) == target_id:
            return target
    return None


def find_target_by_url(
    cdp_url: str, url: str, *, timeout_seconds: float = 0.5
) -> dict[str, Any] | None:
    if not url:
        return None
    for target in page_targets(cdp_url, timeout_seconds=timeout_seconds):
        if str(target.get("url", "")) == url:
            return target
    return None


def find_new_target(
    cdp_url: str, existing_ids: set[str], *, timeout_seconds: float = 0.5
) -> dict[str, Any] | None:
    for target in page_targets(cdp_url, timeout_seconds=timeout_seconds):
        target_id = str(target.get("id", "") or "")
        if target_id and target_id not in existing_ids:
            return target
    return None


def ensure_page_target(
    cdp_url: str, *, timeout_seconds: float = 1.0
) -> dict[str, Any] | None:
    if page_targets(cdp_url, timeout_seconds=timeout_seconds):
        return None
    return create_page_target(
        cdp_url, "about:blank", timeout_seconds=timeout_seconds
    )


def create_page_target(
    cdp_url: str, url: str, *, timeout_seconds: float = 1.0
) -> dict[str, Any] | None:
    target_url = f"{cdp_json_url(cdp_url, '/json/new')}?{quote(url, safe='')}"
    request = Request(target_url, method="PUT")
    with urlopen_local_cdp(request, timeout=timeout_seconds) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"Could not create a local CDP page target: {cdp_url}")
        payload = json.loads(response.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else None


def activate_target(cdp_url: str, target_id: str, *, timeout_seconds: float = 1.0) -> None:
    if not target_id:
        raise ValueError("target_id is required.")
    path = f"/json/activate/{quote(target_id, safe='')}"
    with urlopen_local_cdp(cdp_json_url(cdp_url, path), timeout=timeout_seconds) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"Could not activate local CDP target: {target_id}")


def resolve_cdp_url(configured_url: str, *, explicit: bool) -> str:
    if explicit and configured_url:
        return configured_url
    return (
        os.environ.get("WEBWRIGHT_CDP_URL")
        or configured_url
        or DEFAULT_CDP_URL
    )


def resolve_user_data_dir(configured_dir: Path, *, explicit: bool) -> Path:
    if explicit:
        return configured_dir
    env_dir = os.environ.get("WEBWRIGHT_BROWSER_PROFILE")
    return Path(env_dir).expanduser() if env_dir else DEFAULT_USER_DATA_DIR.expanduser()


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


def chromium_executable_candidates(
    *, platform_name: str | None = None, environ: dict[str, str] | None = None
) -> list[str]:
    platform_name = platform_name or os.name
    environ = environ if environ is not None else os.environ
    if platform_name != "nt":
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
        if (root := environ.get(env_name))
    )
    return list(dict.fromkeys(candidates))


def find_chromium_executable(explicit_path: str = "") -> str:
    candidates: list[str] = []
    if explicit_path:
        candidates.append(explicit_path)
    candidates.extend(
        value
        for value in (
            os.environ.get("WEBWRIGHT_BROWSER_EXECUTABLE"),
        )
        if value
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
        "Could not find Edge/Chrome/Chromium. Set local_cdp_executable or "
        f"WEBWRIGHT_BROWSER_EXECUTABLE. Tried: {', '.join(attempted)}"
    )


def detached_process_kwargs(*, platform_name: str | None = None) -> dict[str, Any]:
    platform_name = platform_name or os.name
    if platform_name == "nt":
        return {
            "creationflags": (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            )
        }
    return {"start_new_session": True}


def macos_open_app_name(executable: str) -> str:
    if sys.platform != "darwin":
        return ""
    if "/Microsoft Edge.app/" in executable:
        return "Microsoft Edge"
    if "/Google Chrome.app/" in executable:
        return "Google Chrome"
    return ""


def launch_browser(
    cdp_url: str,
    *,
    user_data_dir: Path | None = None,
    executable_path: str = "",
    launch_args: list[str] | None = None,
    startup_timeout_seconds: float = 10,
) -> subprocess.Popen | None:
    resolved_user_data_dir = resolve_user_data_dir(
        user_data_dir or DEFAULT_USER_DATA_DIR,
        explicit=user_data_dir is not None,
    )
    return _launch_browser(
        cdp_url,
        user_data_dir=resolved_user_data_dir,
        executable_path=executable_path,
        launch_args=launch_args,
        startup_timeout_seconds=startup_timeout_seconds,
        availability_checker=is_cdp_available,
        executable_finder=find_chromium_executable,
        process_kwargs_factory=detached_process_kwargs,
        app_name_resolver=macos_open_app_name,
        environment=RuntimeLauncher().external_process_environment(),
    )


def normalize_page_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("start_url must be an absolute http or https URL.")
    if parsed.username or parsed.password:
        raise ValueError("start_url must not contain credentials.")
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower()
    host = f"[{hostname}]" if ":" in hostname else hostname
    port = parsed.port
    default_port = 443 if scheme == "https" else 80
    netloc = host if port in {None, default_port} else f"{host}:{port}"
    return urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, parsed.fragment))


def page_origin(value: str) -> str:
    parsed = urlsplit(normalize_page_url(value))
    return f"{parsed.scheme}://{parsed.netloc}"


def page_in_allowed_domains(value: str, allowed_domains: list[str]) -> bool:
    try:
        return urlsplit(normalize_page_url(value)).hostname in allowed_domains
    except ValueError:
        return False


async def target_id_for_page(context: Any, page: Any) -> str:
    """Resolve the real CDP target identity for one Playwright Page."""
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
    """Find a Playwright Page by exact CDP identity without URL/title fallback."""
    if not target_id:
        return None
    for page in list(getattr(context, "pages", []) or []):
        try:
            if await target_id_for_page(context, page) == target_id:
                return page
        except Exception:
            continue
    return None
