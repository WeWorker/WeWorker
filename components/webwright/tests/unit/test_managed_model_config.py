from __future__ import annotations

import json
import base64

import pytest

from webwright.models.anthropic_model import AnthropicModel
from webwright.models.openai_chat_model import OpenAIChatModel
from webwright.server.weworker_model_config import ManagedModelConfig, ManagedModelConfigError, load_managed_model_config


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_session_model_reference_uses_fixed_host_endpoint_without_credentials():
    selection = {"provider": "example-config", "model": "example-model", "thinking_effort": "high"}
    def opener(request, timeout):
        assert request.full_url == "http://127.0.0.1:8765/internal/webwright/model-config"
        value = request.get_header("X-weworker-model-selection")
        assert json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))) == selection
        return FakeResponse(payload())
    env = {"WEWORKER_MODEL_CONFIG_URL": "http://127.0.0.1:8765/internal/webwright/model-config", "WEWORKER_MODEL_CONFIG_TOKEN": "placeholder-token"}
    load_managed_model_config(env, opener=opener, selection=selection)
    with pytest.raises(ValueError):
        load_managed_model_config(env, opener=opener, selection={**selection, "api_key": "placeholder-key"})


def test_full_url_snapshot_preserves_custom_path_slash_and_query() -> None:
    data = {**payload(), "provider_id": "custom", "model_class": "openai_chat", "base_url": "https://example.test/custom/infer/?v=1&route=a%2Fb", "base_url_is_full": True}
    config = ManagedModelConfig.from_payload(data)
    assert config.request_endpoint == data["base_url"]
    model = OpenAIChatModel(model_name=config.model, openai_chat_api_key="test", openai_chat_endpoint=config.request_endpoint)
    assert model._post_url() == data["base_url"]
    with pytest.raises(ManagedModelConfigError):
        ManagedModelConfig.from_payload({**data, "base_url_is_full": False})
    with pytest.raises(ManagedModelConfigError):
        ManagedModelConfig.from_payload({**data, "base_url_is_full": "true"})


def test_old_snapshot_defaults_to_base_url_suffix() -> None:
    config = ManagedModelConfig.from_payload(payload())
    assert config.base_url_is_full is False
    assert config.request_endpoint == "https://example.test/v1/chat/completions"
    assert config.compaction_ratio == 80
    assert config.compaction_max_attempts == 3
    assert config.context_limit == 1_000_000


def test_managed_thinking_preference_defaults_off_and_validates_input() -> None:
    assert ManagedModelConfig.from_payload(payload()).thinking_effort == "off"
    assert ManagedModelConfig.from_payload({**payload(), "thinking_effort": "high"}).thinking_effort == "high"
    with pytest.raises(ManagedModelConfigError):
        ManagedModelConfig.from_payload({**payload(), "thinking_effort": "invalid"})


def test_snapshot_passes_context_limit_and_compaction_ratio() -> None:
    config = ManagedModelConfig.from_payload({**payload(), "compaction_ratio": 65, "context_limit": 128000})
    assert config.compaction_ratio == 65
    assert config.context_limit == 128000
    assert ManagedModelConfig.from_payload({**payload(), "compaction_max_attempts": 5}).compaction_max_attempts == 5
    for invalid in [0, 11, True, "3", 1.5]:
        with pytest.raises(ManagedModelConfigError):
            ManagedModelConfig.from_payload({**payload(), "compaction_max_attempts": invalid})
    for invalid in [0, 100, True, "80", 80.5]:
        with pytest.raises(ManagedModelConfigError):
            ManagedModelConfig.from_payload({**payload(), "compaction_ratio": invalid})


def payload(protocol: str = "openai_chat_completions") -> dict:
    return {
        "provider_id": "glm",
        "protocol": protocol,
        "model_class": "zhipu",
        "base_url": "https://example.test/v1",
        "model": "test-model",
        "api_key": "secret",
        "structured_output": "openai_json_object",
    }


def test_load_managed_model_config_uses_fixed_loopback_and_bearer() -> None:
    captured = {}

    def opener(request, timeout):
        captured["url"] = request.full_url
        captured["authorization"] = request.get_header("Authorization")
        captured["timeout"] = timeout
        return FakeResponse(payload())

    config = load_managed_model_config(
        {
            "WEWORKER_MODEL_CONFIG_URL": "http://127.0.0.1:8765/internal/webwright/model-config",
            "WEWORKER_MODEL_CONFIG_TOKEN": "launch-token",
        },
        opener=opener,
    )

    assert config.model == "test-model"
    assert captured == {
        "url": "http://127.0.0.1:8765/internal/webwright/model-config",
        "authorization": "Bearer launch-token",
        "timeout": 10,
    }


def test_load_managed_model_config_rejects_incompatible_model_class() -> None:
    bad_payload = payload("anthropic_messages")
    bad_payload["structured_output"] = "anthropic_json_schema"

    with pytest.raises(ManagedModelConfigError, match="incompatible model class"):
        load_managed_model_config(
            {
                "WEWORKER_MODEL_CONFIG_URL": "http://127.0.0.1:8765/internal/webwright/model-config",
                "WEWORKER_MODEL_CONFIG_TOKEN": "launch-token",
            },
            opener=lambda *_args, **_kwargs: FakeResponse(bad_payload),
        )


def test_load_managed_model_config_accepts_http_model_base_url() -> None:
    http_payload = payload()
    http_payload["base_url"] = "http://gateway.example/v1"

    config = load_managed_model_config(
        {
            "WEWORKER_MODEL_CONFIG_URL": "http://127.0.0.1:8765/internal/webwright/model-config",
            "WEWORKER_MODEL_CONFIG_TOKEN": "launch-token",
        },
        opener=lambda *_args, **_kwargs: FakeResponse(http_payload),
    )

    assert config.base_url == "http://gateway.example/v1"


def test_load_managed_model_config_rejects_non_fixed_url() -> None:
    with pytest.raises(ManagedModelConfigError, match="unavailable"):
        load_managed_model_config(
            {"WEWORKER_MODEL_CONFIG_URL": "http://localhost:8765/internal/webwright/model-config", "WEWORKER_MODEL_CONFIG_TOKEN": "x"}
        )


def test_openai_chat_payload_uses_json_object() -> None:
    model = OpenAIChatModel(
        model_name="test-model",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://example.test/chat/completions",
    )
    request = model._build_payload([{"role": "user", "content": "json please"}])
    assert request["response_format"] == {"type": "json_object"}
    assert model._build_text_payload([{"role": "user", "content": "hello"}]).get("response_format") is None


def test_deepseek_empty_structured_repair_disables_thinking() -> None:
    model = OpenAIChatModel(
        provider_id="deepseek",
        model_name="deepseek-v4-flash",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://api.deepseek.com/chat/completions",
    )

    request = model._build_structured_repair_payload(
        [{"role": "user", "content": "Return JSON."}],
        schema={"type": "object"},
        schema_name="developer_slot",
        raw_text="",
        error="Empty content",
    )

    assert request["response_format"] == {"type": "json_object"}
    assert request["thinking"] == {"type": "disabled"}


def test_deepseek_nonempty_structured_repair_keeps_default_thinking() -> None:
    model = OpenAIChatModel(
        provider_id="deepseek",
        model_name="deepseek-v4-flash",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://api.deepseek.com/chat/completions",
    )

    request = model._build_structured_repair_payload(
        [],
        schema={"type": "object"},
        schema_name="developer_slot",
        raw_text="not json",
        error="Invalid JSON",
    )

    assert "thinking" not in request


def test_custom_empty_structured_repair_does_not_send_provider_specific_thinking() -> None:
    model = OpenAIChatModel(
        provider_id="custom",
        model_name="custom-model",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://example.test/chat/completions",
    )

    request = model._build_structured_repair_payload(
        [],
        schema={"type": "object"},
        schema_name="developer_slot",
        raw_text="",
        error="Empty content",
    )

    assert "thinking" not in request


def test_anthropic_payload_uses_native_json_schema() -> None:
    model = AnthropicModel(anthropic_api_key="secret", model_name="claude-test")
    request = model._build_payload([{"role": "user", "content": "next"}])
    assert request["output_config"]["format"]["type"] == "json_schema"
    assert request["output_config"]["format"]["schema"]["additionalProperties"] is False
    assert "output_config" not in model._build_text_payload([{"role": "user", "content": "hello"}])


def test_anthropic_developer_payload_uses_supplied_json_schema() -> None:
    model = AnthropicModel(anthropic_api_key="secret", model_name="claude-test")
    schema = {
        "type": "object",
        "properties": {"code": {"type": "string"}},
        "required": ["code"],
    }

    request = model._build_structured_payload(
        [{"role": "user", "content": "Build it."}],
        schema=schema,
        schema_name="developer_slot",
    )

    assert request["output_config"]["format"] == {
        "type": "json_schema",
        "schema": schema,
    }
