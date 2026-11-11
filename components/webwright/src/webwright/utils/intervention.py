from __future__ import annotations

from typing import Any


def validate_user_intervention(value: Any) -> dict[str, str] | None:
    """Validate the handoff shape, not the model's reason for requesting help."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"reason", "message", "mode"}:
        raise ValueError("user_intervention must contain reason, message and mode.")
    if any(not isinstance(item, str) or not item.strip() for item in value.values()):
        raise ValueError("user_intervention fields must be non-empty strings.")
    if value["mode"] not in {"browser", "input", "either"}:
        raise ValueError("user_intervention mode must be browser, input or either.")
    return {key: item.strip() for key, item in value.items()}
