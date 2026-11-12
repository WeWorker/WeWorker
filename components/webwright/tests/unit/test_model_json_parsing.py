import asyncio
import json

import pytest

from webwright.models import base as base_model_module
from webwright.models.base import parse_json_output
from webwright.models.openai_chat_model import OpenAIChatModel


@pytest.mark.parametrize("reason", ["login_required", "form_validation", "ambiguous_project", "unanticipated_reason"])
def test_browser_model_can_request_help_for_any_reason(reason):
    intervention = {"reason": reason, "message": "请选择目标项目。", "mode": "input"}
    payload = {"thought": "Need help", "python_code": "", "done": False,
               "final_response": "", "user_intervention": intervention}
    assert parse_json_output(json.dumps(payload), action_field="python_code")["user_intervention"] == intervention


@pytest.mark.parametrize("override", [
    {"python_code": "await page.click('button')"}, {"done": True}, {"final_response": "done"},
    {"user_intervention": {}}, {"user_intervention": {"reason": "other", "message": " ", "mode": "input"}},
    {"user_intervention": {"reason": "other", "message": "Help", "mode": "automatic"}},
])
def test_intervention_rejects_invalid_or_conflicting_actions(override):
    payload = {"thought": "Need help", "python_code": "", "done": False, "final_response": "",
               "user_intervention": {"reason": "other", "message": "Help", "mode": "either"}, **override}
    with pytest.raises(ValueError, match="user_intervention"):
        parse_json_output(json.dumps(payload), action_field="python_code")


def test_intervention_is_preserved_by_model_and_browser_schema(monkeypatch):
    intervention = {"reason": "ambiguous_project", "message": "Which project?", "mode": "input"}
    model = OpenAIChatModel(model_name="test-model", action_field="python_code",
                            openai_chat_api_key="placeholder-test-key",
                            openai_chat_endpoint="https://example.com/chat/completions")
    schema = model._response_schema()
    assert "user_intervention" in schema["required"]
    assert "enum" not in schema["properties"]["user_intervention"]["anyOf"][1]["properties"]["reason"]
    async def response(_payload):
        return {"choices": [{"message": {"content": json.dumps({
            "thought": "Need help", "python_code": "", "done": False,
            "final_response": "", "user_intervention": intervention,
        })}}]}
    monkeypatch.setattr(model, "_post_with_retries", response)
    message = asyncio.run(model._query_async([]))
    assert message["extra"]["user_intervention"] == intervention
    assert message["extra"]["actions"] == []
    model.config.action_field = "bash_command"
    assert "user_intervention" not in model._response_schema()["properties"]


def test_parse_json_output_accepts_strict_json() -> None:
    parsed = parse_json_output(
        '{"thought":"next","bash_command":"echo ok","done":false,"final_response":""}'
    )

    assert parsed["thought"] == "next"
    assert parsed["bash_command"] == "echo ok"
    assert parsed["done"] is False


def test_parse_json_output_rejects_think_prefix() -> None:
    raw = """
<think>
Need to inspect the page first.
</think>
{"thought":"inspect","bash_command":"echo ok","done":false,"final_response":""}
"""

    with pytest.raises(ValueError, match="Unable to parse JSON output"):
        parse_json_output(raw)


def test_parse_json_output_rejects_suffix_noise() -> None:
    raw = """
{"thought":"inspect","bash_command":"echo ok","done":false,"final_response":""}

Done. Waiting for the next step.
"""

    with pytest.raises(ValueError, match="Unable to parse JSON output"):
        parse_json_output(raw)


def test_parse_json_output_rejects_code_fence() -> None:
    raw = """
```json
{"thought":"inspect","bash_command":"echo ok","done":false,"final_response":""}
```
"""

    with pytest.raises(ValueError, match="Unable to parse JSON output"):
        parse_json_output(raw)


def test_parse_json_output_rejects_prefix_even_with_string_braces() -> None:
    raw = """
<think>Reasoning</think>
{"thought":"inspect {carefully}","bash_command":"printf '{\\\"ok\\\":true}'","done":false,"final_response":""}
"""

    with pytest.raises(ValueError, match="Unable to parse JSON output"):
        parse_json_output(raw)


def test_parse_json_output_rejects_missing_json_object() -> None:
    with pytest.raises(ValueError, match="Unable to parse JSON output"):
        parse_json_output("<think>only reasoning</think>")


def test_parse_json_output_rejects_wrong_action_field_for_mode() -> None:
    raw = '{"thought":"inspect","python_code":"print(1)","done":false,"final_response":""}'

    with pytest.raises(ValueError, match="fields must be exactly"):
        parse_json_output(raw, action_field="bash_command")


def test_parse_json_output_accepts_python_code_in_python_mode() -> None:
    raw = '{"thought":"inspect","python_code":"print(1)","done":false,"final_response":""}'

    parsed = parse_json_output(raw, action_field="python_code")

    assert parsed["thought"] == "inspect"
    assert parsed["python_code"] == "print(1)"


def test_model_request_lifecycle_is_written_to_process_log(monkeypatch, tmp_path) -> None:
    class FakeResponse:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "{}", "reasoning_content": "think"},
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "completion_tokens_details": {"reasoning_tokens": 2},
                },
            }

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(base_model_module.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    log_path = tmp_path / "process.log"
    model = OpenAIChatModel(
        model_name="test-model",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://example.test/chat/completions",
        process_log_path=log_path,
    )

    asyncio.run(model._post_with_retries({"messages": []}))

    lifecycle = log_path.read_text(encoding="utf-8")
    assert "request_started" in lifecycle
    assert "http_response_received" in lifecycle
    assert "response_decoded" in lifecycle
    assert 'finish_reason="stop"' in lifecycle
    assert "content_chars=2" in lifecycle
    assert "reasoning_chars=5" in lifecycle
    assert "prompt_tokens=10" in lifecycle
    assert "completion_tokens=4" in lifecycle
    assert "reasoning_tokens=2" in lifecycle
    assert "secret" not in lifecycle
    assert "example.test" not in lifecycle


def test_model_response_decode_failure_is_logged_without_raw_body(
    monkeypatch, tmp_path
) -> None:
    class InvalidJsonResponse:
        status_code = 200
        text = "sensitive raw response"

        def raise_for_status(self):
            return None

        def json(self):
            raise ValueError("decode failed")

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return InvalidJsonResponse()

    monkeypatch.setattr(base_model_module.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    process_log = tmp_path / "process.log"
    runtime_errors = tmp_path / "runtime_errors.jsonl"
    model = OpenAIChatModel(
        model_name="test-model",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://example.test/chat/completions",
        process_log_path=process_log,
        error_log_path=runtime_errors,
    )

    with pytest.raises(ValueError, match="decode failed"):
        asyncio.run(model._post_with_retries({"messages": []}))

    combined = process_log.read_text(encoding="utf-8") + runtime_errors.read_text(
        encoding="utf-8"
    )
    assert "http_response_received" in combined
    assert "response_decode_failed" in combined
    assert "model_response_invalid" in combined
    assert "sensitive raw response" not in combined
    assert "secret" not in combined
    assert "example.test" not in combined


def test_model_timeout_logs_error_type_when_message_is_empty(monkeypatch, tmp_path) -> None:
    class TimeoutClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            raise base_model_module.httpx.ReadTimeout("")

    monkeypatch.setattr(base_model_module.httpx, "AsyncClient", lambda **_kwargs: TimeoutClient())
    log_path = tmp_path / "process.log"
    model = OpenAIChatModel(
        model_name="test-model",
        openai_chat_api_key="secret",
        openai_chat_endpoint="https://example.test/chat/completions",
        process_log_path=log_path,
    )
    model._MAX_TRANSIENT_RETRIES = 0

    with pytest.raises(base_model_module.httpx.ReadTimeout):
        asyncio.run(model._post_with_retries({"messages": []}))

    lifecycle = log_path.read_text(encoding="utf-8")
    assert "request_failed" in lifecycle
    assert 'error_type="ReadTimeout"' in lifecycle
    assert "secret" not in lifecycle
    assert "example.test" not in lifecycle
