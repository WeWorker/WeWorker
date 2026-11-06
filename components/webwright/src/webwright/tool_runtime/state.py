from __future__ import annotations

from typing import Any

from webwright.tool_runtime.toolkit_runtime import (
    EMPTY_RUNTIME_STATE,
    FileRuntimeStore,
    RuntimeStore,
)


class ToolkitStoreRuntimeAdapter:
    def __init__(self, store: Any, toolkit_id: str):
        self.store = store
        self.toolkit_id = toolkit_id
        self.path = store.toolkit_dir(toolkit_id) / "runtime.json"

    def read(self) -> dict[str, Any]:
        return self.store.read_runtime(self.toolkit_id)

    def write(
        self, *, target_id: str, last_url: str, last_title: str, browser_instance_id: str = ""
    ) -> dict[str, Any]:
        return self.store.write_runtime(
            self.toolkit_id,
            target_id=target_id,
            last_url=last_url,
            last_title=last_title,
            **({"browser_instance_id": browser_instance_id} if browser_instance_id else {}),
        )
