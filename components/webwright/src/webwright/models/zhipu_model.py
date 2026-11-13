"""Zhipu AI Chat Completions backend with JSON-mode action responses."""

from __future__ import annotations

import os
from typing import Any

from webwright.models.base import BaseModel, BaseModelConfig, OptStr
from webwright.models.thinking import apply_thinking
from webwright.models.openrouter_model import (
    _chat_completions_response_diagnostics,
    _extract_chat_completions_text,
    _metrics_input_from_chat_messages,
    _serialize_chat_messages,
    _usage_metrics_from_chat_completions,
)


class ZhipuModelConfig(BaseModelConfig):
    model_name: OptStr = "glm-5"
    zhipu_api_key: OptStr = ""
    zhipu_endpoint: OptStr = "https://open.bigmodel.cn/api/paas/v4/chat/completions"


class ZhipuModel(BaseModel):
    _API_KEY_FIELD = "zhipu_api_key"
    _ENV_VAR = "ZHIPUAI_API_KEY"
    _LOG_SOURCE = "zhipu"
    _MAX_RATE_LIMIT_RETRIES = 5
    _MAX_TRANSIENT_RETRIES = 5
    _DEFAULT_CONFIG_CLASS = ZhipuModelConfig

    def __init__(self, *, config_class: type | None = None, **kwargs: Any):
        if not kwargs.get("zhipu_api_key"):
            kwargs["zhipu_api_key"] = os.environ.get("ZHIPUAI_API_KEY", "") or os.environ.get(
                "ANTHROPIC_API_KEY", ""
            )
        super().__init__(config_class=config_class, **kwargs)

    def _request_headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.config.zhipu_api_key}",
        }

    def _post_url(self) -> str:
        return self.config.zhipu_endpoint

    def _build_payload(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        return apply_thinking({
            "model": self.config.model_name,
            "messages": _serialize_chat_messages(messages),
            "stream": False,
            "max_tokens": self.config.max_output_tokens,
            "response_format": {"type": "json_object"},
        }, effort=self.config.thinking_effort, model=self.config.model_name, protocol="openai", provider="zhipu")

    def _build_text_payload(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        payload = self._build_payload(messages)
        payload.pop("response_format")
        return payload

    def _build_repair_payload(
        self,
        messages: list[dict[str, Any]],
        *,
        raw_text: str,
        error: str,
    ) -> dict[str, Any]:
        del error
        payload = self._build_payload(messages)
        if not raw_text.strip():
            payload["thinking"] = {"type": "disabled"}
        return payload

    def _build_structured_repair_payload(
        self,
        messages: list[dict[str, Any]],
        *,
        schema: dict[str, Any],
        schema_name: str,
        raw_text: str,
        error: str,
    ) -> dict[str, Any]:
        payload = super()._build_structured_repair_payload(
            messages,
            schema=schema,
            schema_name=schema_name,
            raw_text=raw_text,
            error=error,
        )
        if not raw_text.strip():
            payload["thinking"] = {"type": "disabled"}
        return payload

    def _request_metrics_input(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        return _metrics_input_from_chat_messages(payload.get("messages") or [])

    def _extract_text(self, payload: dict[str, Any]) -> str:
        return _extract_chat_completions_text(payload)

    def _usage_metrics_from_payload(self, payload: dict[str, Any]) -> dict[str, int]:
        return _usage_metrics_from_chat_completions(payload)

    def _response_diagnostics(self, payload: dict[str, Any]) -> dict[str, Any]:
        return _chat_completions_response_diagnostics(payload)
