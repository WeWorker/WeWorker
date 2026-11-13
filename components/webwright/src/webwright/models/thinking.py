from __future__ import annotations

import re
from typing import Any


def apply_thinking(payload: dict[str, Any], *, effort: str, model: str, protocol: str, provider: str = "") -> dict[str, Any]:
    if not effort:
        return payload  # Non-managed callers retain their original defaults.
    if effort not in {"off", "low", "medium", "high"}:
        raise ValueError("Invalid thinking effort")
    if protocol == "responses":
        if effort != "off":
            payload["reasoning"] = {"effort": effort}
        elif re.match(r"gpt-5\.[1-9]", model, re.I):
            payload["reasoning"] = {"effort": "none"}
    elif protocol == "anthropic":
        if effort == "off":
            payload["thinking"] = {"type": "disabled"}
        elif re.search(r"claude-(?:opus|sonnet)-4[.-][6-9]", model, re.I):
            payload["thinking"] = {"type": "adaptive"}
            payload.setdefault("output_config", {})["effort"] = effort
        else:
            budget = {"low": 1024, "medium": 4096, "high": 8192}[effort]
            payload["thinking"] = {"type": "enabled", "budget_tokens": min(budget, payload["max_tokens"] - 1)}
    elif provider in {"zhipu", "glm"} or model.lower().startswith("glm-"):
        payload["thinking"] = {"type": "enabled" if effort != "off" or model.lower().startswith("glm-5.3") else "disabled"}
    elif provider == "deepseek" or "deepseek" in model.lower():
        payload["thinking"] = {"type": "disabled" if effort == "off" else "enabled"}
        if effort != "off":
            payload["reasoning_effort"] = "high" if effort == "medium" else effort
    elif effort != "off":
        payload["reasoning_effort"] = effort
    elif re.match(r"gpt-5\.[1-9]", model, re.I):
        payload["reasoning_effort"] = "none"
    # Generic compatible endpoints may not accept reasoning_effort at all.
    # With thinking off, preserve their original request instead of adding an
    # unsupported parameter to every existing exploration.
    return payload
