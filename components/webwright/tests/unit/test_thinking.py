import pytest

from webwright.models.openai_chat_model import OpenAIChatModel
from webwright.models.anthropic_model import AnthropicModel
from webwright.models.zhipu_model import ZhipuModel
from webwright.models.openai_model import OpenAIModel


@pytest.mark.parametrize("effort", ["", "off"])
def test_generic_default_does_not_break_existing_compatible_endpoints(effort):
    model = OpenAIChatModel(openai_chat_api_key="placeholder-key", model_name="example-model", thinking_effort=effort)
    assert "reasoning_effort" not in model._build_payload([])


def test_thinking_reaches_action_and_summary_requests():
    model = OpenAIChatModel(openai_chat_api_key="placeholder-key", model_name="example-model", thinking_effort="high")
    assert model._build_payload([])["reasoning_effort"] == "high"
    assert model._build_text_payload([])["reasoning_effort"] == "high"
    assert "response_format" not in model._build_text_payload([])


@pytest.mark.parametrize("effort,expected", [("off", {"type": "disabled"}), ("high", {"type": "enabled"})])
def test_glm_and_deepseek_use_their_native_thinking_control(effort, expected):
    glm = ZhipuModel(zhipu_api_key="placeholder-key", model_name="glm-5.2", thinking_effort=effort)
    deepseek = OpenAIChatModel(openai_chat_api_key="placeholder-key", model_name="deepseek-flash", thinking_effort=effort)
    assert glm._build_payload([])["thinking"] == expected
    assert deepseek._build_payload([])["thinking"] == expected
    if effort == "high":
        assert deepseek._build_payload([])["reasoning_effort"] == "high"


def test_glm_required_thinking_is_never_disabled():
    model = ZhipuModel(zhipu_api_key="placeholder-key", model_name="glm-5.3", thinking_effort="off")
    assert model._build_payload([])["thinking"] == {"type": "enabled"}


def test_anthropic_summary_keeps_effort_without_json_schema():
    model = AnthropicModel(anthropic_api_key="placeholder-key", model_name="claude-sonnet-4-6", thinking_effort="high")
    payload = model._build_text_payload([])
    assert payload["thinking"] == {"type": "adaptive"}
    assert payload["output_config"] == {"effort": "high"}


def test_responses_preserves_effort_and_uses_the_requested_schema():
    model = OpenAIModel(openai_api_key="placeholder-key", model_name="example-model", thinking_effort="high")
    schema = {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"], "additionalProperties": False}
    payload = model._build_structured_payload([], schema=schema, schema_name="summary")
    assert payload["text"]["format"] == {"type": "json_schema", "name": "summary", "schema": schema, "strict": True}
    assert payload["reasoning"] == {"effort": "high"}
    plain = model._build_text_payload([])
    assert plain["reasoning"] == {"effort": "high"}
    assert "text" not in plain
