from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Callable
from urllib.request import Request, urlopen
from urllib.parse import urlparse


class ManagedModelConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class ManagedModelConfig:
    provider_id: str
    protocol: str
    model_class: str
    base_url: str
    model: str
    api_key: str
    structured_output: str
    base_url_is_full: bool = False
    context_limit: int = 1_000_000
    compaction_ratio: int = 80
    compaction_max_attempts: int = 3

    @property
    def request_endpoint(self) -> str:
        if self.base_url_is_full:
            return self.base_url
        suffix = "/v1/messages" if self.protocol == "anthropic_messages" else "/chat/completions"
        return self.base_url.rstrip("/") + suffix

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ManagedModelConfig":
        values = {name: str(payload.get(name) or "").strip() for name in
                  ("provider_id", "protocol", "model_class", "base_url", "model", "api_key", "structured_output")}
        context_limit = payload.get("context_limit", 1_000_000)
        ratio = payload.get("compaction_ratio", 80)
        attempts = payload.get("compaction_max_attempts", 3)
        if type(context_limit) is not int or context_limit < 1000 or type(ratio) is not int or not 1 <= ratio <= 99:
            raise ManagedModelConfigError("WeWorker returned invalid compaction settings.")
        if type(attempts) is not int or not 1 <= attempts <= 10:
            raise ManagedModelConfigError("WeWorker returned invalid compaction settings.")
        full_url = payload.get("base_url_is_full", False)
        if not isinstance(full_url, bool):
            raise ManagedModelConfigError("WeWorker returned an invalid full URL option.")
        if values["protocol"] not in {"anthropic_messages", "openai_chat_completions"}:
            raise ManagedModelConfigError("WeWorker returned an unsupported model protocol.")
        if values["model_class"] not in {"anthropic", "zhipu", "openai_chat"}:
            raise ManagedModelConfigError("WeWorker returned an unsupported model class.")
        if not all(values.values()):
            raise ManagedModelConfigError("WeWorker returned an incomplete model configuration.")
        expected_classes = {
            "anthropic_messages": {"anthropic"},
            "openai_chat_completions": {"zhipu", "openai_chat"},
        }
        if values["model_class"] not in expected_classes[values["protocol"]]:
            raise ManagedModelConfigError("WeWorker returned an incompatible model class.")
        expected_output = "anthropic_json_schema" if values["protocol"] == "anthropic_messages" else "openai_json_object"
        if values["structured_output"] != expected_output:
            raise ManagedModelConfigError("WeWorker returned an incompatible structured-output mode.")
        parsed = urlparse(values["base_url"])
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or (parsed.query and not full_url) or parsed.fragment:
            raise ManagedModelConfigError("WeWorker returned an invalid model Base URL.")
        return cls(**values, base_url_is_full=full_url, context_limit=context_limit, compaction_ratio=ratio, compaction_max_attempts=attempts)


def load_managed_model_config(
    environment: dict[str, str] | None = None,
    *,
    opener: Callable[..., Any] = urlopen,
) -> ManagedModelConfig:
    env = environment or os.environ
    url = str(env.get("WEWORKER_MODEL_CONFIG_URL") or "").strip()
    token = str(env.get("WEWORKER_MODEL_CONFIG_TOKEN") or "").strip()
    parsed = urlparse(url)
    try:
        valid_port = parsed.port is not None and 1 <= parsed.port <= 65535
    except ValueError:
        valid_port = False
    if (not token or parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not valid_port
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path != "/internal/webwright/model-config"):
        raise ManagedModelConfigError("WeWorker model configuration is unavailable.")
    request = Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with opener(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise ManagedModelConfigError("Unable to read the current model from WeWorker.") from exc
    if not isinstance(payload, dict):
        raise ManagedModelConfigError("WeWorker returned an invalid model configuration.")
    return ManagedModelConfig.from_payload(payload)
