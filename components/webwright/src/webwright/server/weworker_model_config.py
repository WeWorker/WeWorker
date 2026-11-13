from __future__ import annotations

import json
import base64
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
    thinking_effort: str = "off"
    auth_type: str = "api_key"

    @property
    def request_endpoint(self) -> str:
        if self.base_url_is_full:
            return self.base_url
        suffix = {"anthropic_messages": "/v1/messages", "openai_chat_completions": "/chat/completions", "openai_responses": "/responses"}[self.protocol]
        return self.base_url.rstrip("/") + suffix

    @property
    def request_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.protocol == "anthropic_messages":
            headers["anthropic-version"] = "2023-06-01"
        if self.protocol == "anthropic_messages" and self.auth_type == "api_key":
            headers["x-api-key"] = self.api_key
        else:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

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
        if values["protocol"] not in {"anthropic_messages", "openai_chat_completions", "openai_responses"}:
            raise ManagedModelConfigError("WeWorker returned an unsupported model protocol.")
        if values["model_class"] not in {"anthropic", "zhipu", "openai_chat", "openai"}:
            raise ManagedModelConfigError("WeWorker returned an unsupported model class.")
        if not all(values.values()):
            raise ManagedModelConfigError("WeWorker returned an incomplete model configuration.")
        expected_classes = {
            "anthropic_messages": {"anthropic"},
            "openai_chat_completions": {"zhipu", "openai_chat"},
            "openai_responses": {"openai"},
        }
        if values["model_class"] not in expected_classes[values["protocol"]]:
            raise ManagedModelConfigError("WeWorker returned an incompatible model class.")
        expected_output = {"anthropic_messages": "anthropic_json_schema", "openai_chat_completions": "openai_json_object", "openai_responses": "openai_json_schema"}[values["protocol"]]
        if values["structured_output"] != expected_output:
            raise ManagedModelConfigError("WeWorker returned an incompatible structured-output mode.")
        parsed = urlparse(values["base_url"])
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or (parsed.query and not full_url) or parsed.fragment:
            raise ManagedModelConfigError("WeWorker returned an invalid model Base URL.")
        effort = payload.get("thinking_effort", "off")
        if effort not in {"off", "low", "medium", "high"}:
            raise ManagedModelConfigError("WeWorker returned invalid thinking settings.")
        auth_type = payload.get("auth_type", "api_key")
        if auth_type not in {"api_key", "auth_token"}:
            raise ManagedModelConfigError("WeWorker returned invalid authentication settings.")
        return cls(**values, base_url_is_full=full_url, context_limit=context_limit, compaction_ratio=ratio, compaction_max_attempts=attempts, thinking_effort=effort, auth_type=auth_type)


def validate_model_selection(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - {"provider", "model", "thinking_effort"}:
        raise ValueError("会话模型配置无效")
    if any(not isinstance(value.get(key), str) or not value[key].strip() or len(value[key]) > 200 for key in ("provider", "model")):
        raise ValueError("会话模型配置无效")
    effort = value.get("thinking_effort", "off")
    if effort not in {"off", "low", "medium", "high"}:
        raise ValueError("会话思考配置无效")
    return {"provider": value["provider"].strip(), "model": value["model"].strip(), "thinking_effort": effort}


def load_managed_model_config(
    environment: dict[str, str] | None = None,
    *,
    opener: Callable[..., Any] = urlopen,
    selection: dict[str, str] | None = None,
) -> ManagedModelConfig:
    env = environment or os.environ
    url = str(env.get("WEWORKER_MODEL_CONFIG_URL") or "").strip()
    token = str(env.get("WEWORKER_MODEL_CONFIG_TOKEN") or "").strip()
    if url != "http://127.0.0.1:8765/internal/webwright/model-config" or not token:
        raise ManagedModelConfigError("WeWorker model configuration is unavailable.")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if selection is not None:
        headers["X-WeWorker-Model-Selection"] = base64.urlsafe_b64encode(
            json.dumps(validate_model_selection(selection)).encode("utf-8")
        ).decode("ascii").rstrip("=")
    request = Request(url, headers=headers)
    try:
        with opener(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise ManagedModelConfigError("Unable to read the current model from WeWorker.") from exc
    if not isinstance(payload, dict):
        raise ManagedModelConfigError("WeWorker returned an invalid model configuration.")
    return ManagedModelConfig.from_payload(payload)
