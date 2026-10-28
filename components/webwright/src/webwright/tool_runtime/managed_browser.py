"""Shared host-control exports; canonical Runtime remains independently distributable."""
from webwright.tool_runtime.toolkit_runtime import ManagedBrowser, managed_browser_enabled, resource_key

__all__ = ["ManagedBrowser", "managed_browser_enabled", "resource_key"]
