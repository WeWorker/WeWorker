from __future__ import annotations

import copy

import pytest
import httpx
from types import SimpleNamespace

from webwright.agents.default import DefaultAgent
from webwright.agents.history_compaction import request_tokens, select_source, transcript
from test_agent_control import ControlEnv, ControlModel


class SummaryModel(ControlModel):
    def __init__(self, response="Earlier facts."):
        super().__init__()
        self.requests = []
        self.response = response

    def query(self, messages):
        self.requests.append(copy.deepcopy(messages))
        if isinstance(self.response, Exception):
            raise self.response
        return self.format_message(role="assistant", content=self.response)


def make_agent(model, **config):
    agent = DefaultAgent(model, ControlEnv(), system_template="System", instance_template="Task", **config)
    agent.messages = [
        model.format_message(role="system", content="System"),
        model.format_message(role="user", content="Previous fact. " * 200),
        model.format_message(role="assistant", content="Earlier answer. " * 200),
        model.format_message(role="user", content="Earlier observation. " * 200),
        model.format_message(role="assistant", content="CURRENT-ACTION", extra={"actions": [{"python_code": "print('current')"}]}),
        model.format_message(role="user", content="OVERFLOW-OBSERVATION" * 10000),
    ]
    return agent


def test_summary_excludes_current_action_and_overflowing_observation_and_keeps_tail():
    model = SummaryModel()
    agent = make_agent(model)
    original = copy.deepcopy(agent.messages)
    agent._compact_history()
    request = str(model.requests[0])
    assert "Previous fact." in request
    assert "CURRENT-ACTION" not in request
    assert "OVERFLOW-OBSERVATION" not in request
    assert agent.messages[-2:] == original[-2:]
    assert "Earlier observation." in str(agent.messages)


@pytest.mark.parametrize("response", ["", RuntimeError("synthetic summary failure")])
def test_summary_failure_preserves_every_original_message(response):
    agent = make_agent(SummaryModel(response))
    original = copy.deepcopy(agent.messages)
    with pytest.raises(Exception):
        agent._compact_history()
    assert agent.messages == original


def test_ratio_changes_only_safe_history_sent_for_summary():
    lengths = []
    for ratio in (50, 80):
        model = SummaryModel()
        agent = make_agent(model, compaction_ratio=ratio)
        agent._compact_history()
        lengths.append(len(str(model.requests[0])))
    assert lengths[0] < lengths[1]


def test_summary_request_reserves_system_instructions_and_output_tokens():
    model = SummaryModel()
    model.config = SimpleNamespace(max_output_tokens=40000)
    agent = make_agent(model, context_limit=4000)
    agent._compact_history()
    assert request_tokens(model.requests[0]) + 400 < 4000
    assert model.config.max_output_tokens == 40000


def test_small_window_summary_prompt_explains_the_output_budget():
    model = SummaryModel()
    agent = make_agent(model, context_limit=7000)
    agent._compact_history()
    prompt = model.requests[0][-1]["content"]
    assert "700 output tokens" in prompt
    assert "350 tokens" in prompt


def test_select_source_preserves_unsummarized_sentences_and_oversized_payload():
    for history in ["完整句子。" * 100, "x" * 10000, 'Example URL https://example.com/path. Next fact. ' * 100]:
        source, retained = select_source(history, ratio=80, context_limit=100, reserved_tokens=20)
        assert source + retained == history
        assert len(source.encode("utf-8")) / 3 <= 64
    assert select_source("x" * 10000, ratio=80, context_limit=100, reserved_tokens=20)[0] == ""


def test_provider_overflow_uses_last_successful_query_boundary_and_retries_once():
    class OverflowModel(SummaryModel):
        def query(self, messages):
            is_summary = messages[-1].get("extra", {}).get("interrupt_type") == "HistoryCompactionRequest"
            if is_summary:
                return super().query(messages)
            self.queries += 1
            if self.queries == 1:
                response = httpx.Response(400, request=httpx.Request("POST", "https://example.com/v1/chat/completions"),
                                          json={"error": {"code": "context_length_exceeded", "message": "input exceeds context window"}})
                response.raise_for_status()
            return self.format_message(role="assistant", content="Continue.")

    model = OverflowModel()
    agent = make_agent(model)
    agent._last_query_message_count = 4
    agent.query()
    assert model.queries == 2
    assert "OVERFLOW-OBSERVATION" not in transcript(model.requests[0])
    assert agent.messages[-2]["content"].startswith("OVERFLOW-OBSERVATION")


class RepeatedOverflowModel(SummaryModel):
    def __init__(self, reject_turns=3, reject_summaries=False):
        super().__init__()
        self.reject_turns = reject_turns
        self.reject_summaries = reject_summaries
        self.turn_requests = []

    def query(self, messages):
        if messages[-1].get("extra", {}).get("interrupt_type") == "HistoryCompactionRequest":
            self.requests.append(copy.deepcopy(messages))
            if self.reject_summaries:
                raise RuntimeError("Prompt is too long")
            return self.format_message(role="assistant", content="Earlier facts.")
        self.turn_requests.append(copy.deepcopy(messages))
        if len(self.turn_requests) <= self.reject_turns:
            raise RuntimeError("Prompt is too long")
        return self.format_message(role="assistant", content="Continue.")


def test_repeated_compaction_succeeds_and_keeps_current_action_and_observation():
    model = RepeatedOverflowModel(reject_turns=3)
    agent = make_agent(model)
    agent._last_query_message_count = 4
    current = copy.deepcopy(agent.messages[-2:])
    agent.query()
    assert len(model.requests) == 3
    assert len(model.turn_requests) == 4
    for request in model.requests:
        assert "CURRENT-ACTION" not in transcript(request)
        assert "OVERFLOW-OBSERVATION" not in transcript(request)
    assert agent.messages[-3:-1] == current
    assert agent.n_calls == 1


@pytest.mark.parametrize("attempts", [1, 3])
def test_summary_cap_then_oldest_history_removal_until_accepted(attempts):
    model = RepeatedOverflowModel(reject_turns=attempts + 2)
    agent = make_agent(model, compaction_max_attempts=attempts)
    agent._last_query_message_count = 4
    current = copy.deepcopy(agent.messages[-2:])
    agent.query()
    assert len(model.requests) == attempts
    assert agent.messages[1:-1] == current
    sizes = [request_tokens(messages) for messages in model.turn_requests]
    assert all(after < before for before, after in zip(sizes, sizes[1:]))
    assert agent.n_calls == 1


def test_summary_request_overflow_is_bounded_then_uses_oldest_history_fallback():
    model = RepeatedOverflowModel(reject_turns=3, reject_summaries=True)
    agent = make_agent(model, compaction_max_attempts=3)
    agent._last_query_message_count = 4
    current = copy.deepcopy(agent.messages[-2:])
    agent.query()
    assert len(model.requests) == 3
    assert len(model.turn_requests) == 4
    assert agent.messages[1:-1] == current


def test_oversized_current_turn_stops_after_history_is_exhausted():
    model = RepeatedOverflowModel(reject_turns=100)
    agent = make_agent(model, compaction_max_attempts=1)
    agent._last_query_message_count = 4
    current = copy.deepcopy(agent.messages[-2:])
    with pytest.raises(Exception, match="无法继续缩减历史上下文"):
        agent.query()
    assert len(model.requests) == 1
    assert len(model.turn_requests) == 4
    assert agent.messages[1:] == current
    assert agent.n_calls == 0


def test_generic_provider_errors_never_drop_history():
    model = SummaryModel(RuntimeError("Network unavailable"))
    agent = make_agent(model)
    before = copy.deepcopy(agent.messages)
    with pytest.raises(RuntimeError, match="Network unavailable"):
        agent.query()
    assert agent.messages == before
    assert len(model.requests) == 1


@pytest.mark.parametrize("context_limit", [200_000, 1_000_000, 1_500_000])
def test_exploration_model_receives_configured_window_without_mutating_history(context_limit):
    model = SummaryModel()
    agent = make_agent(model, context_limit=context_limit)
    before = copy.deepcopy(agent.messages)
    first = agent._messages_for_model()
    second = agent._messages_for_model()
    notice = first[0]["content"]
    assert f"Client-configured context window: {context_limit} tokens" in notice
    assert "actual available limit is determined by the provider" in notice
    assert "model name, alias or SDK default" in notice
    assert "cumulative billed tokens" in notice
    assert notice.count("Client-configured context window:") == 1
    assert second == first
    assert agent.messages == before


def test_exploration_compaction_also_receives_the_configured_window():
    model = SummaryModel()
    agent = make_agent(model, context_limit=200_000)
    agent._compact_history()
    assert "Client-configured context window: 200000 tokens" in model.requests[0][0]["content"]
    assert "actual available limit is determined by the provider" in model.requests[0][0]["content"]


def test_exploration_window_notice_follows_configuration_changes_and_preserves_multipart_system():
    agent = make_agent(SummaryModel(), context_limit=200_000)
    agent.messages[0]["content"] = [{"type": "text", "text": "System"}]
    original = copy.deepcopy(agent.messages)
    assert "Client-configured context window: 200000 tokens" in str(agent._messages_for_model()[0])
    agent.config.context_limit = 1_000_000
    notice = str(agent._messages_for_model()[0])
    assert "Client-configured context window: 1000000 tokens" in notice
    assert "Client-configured context window: 200000 tokens" not in notice
    assert agent.messages == original


def test_non_reducing_summary_uses_oldest_history_instead_of_looping():
    model = RepeatedOverflowModel(reject_turns=3)
    agent = make_agent(model)
    agent._last_query_message_count = 4
    from webwright.exceptions import RuntimeExecutionError
    def no_reduction(**kwargs):
        raise RuntimeExecutionError("No reduction", error_code="compaction_no_reduction", stage="compaction")
    agent._compact_history = no_reduction
    agent.query()
    assert len(model.turn_requests) == 4
    assert "CURRENT-ACTION" in str(agent.messages)


@pytest.mark.parametrize("input_tokens", [None, 0, 71_117, -1, "190000", True, float("nan"), float("inf")])
def test_local_payload_size_does_not_trigger_compaction_without_provider_usage(input_tokens):
    model = SummaryModel()
    model.get_template_vars = lambda **kwargs: {
        "last_request_input_tokens": input_tokens,
        "cumulative_input_tokens": 900_000,
    }
    agent = make_agent(model, context_limit=200_000)
    agent.messages[-1]["content"] = [
        {"type": "input_image", "image_url": "data:image/png;base64," + "A" * 900_000},
    ]
    assert request_tokens(agent._messages_for_model()) > 200_000
    agent.query()
    assert len(model.requests) == 1
    assert not any(m.get("extra", {}).get("interrupt_type") == "HistoryCompactionSummary" for m in agent.messages)


def test_provider_input_usage_triggers_compaction_despite_small_local_estimate():
    model = SummaryModel()
    model.get_template_vars = lambda **kwargs: {"last_request_input_tokens": 180_000}
    agent = make_agent(model, context_limit=200_000)
    assert request_tokens(agent._messages_for_model()) < 180_000
    agent.query()
    assert len(model.requests) == 2
    assert model.requests[0][-1]["extra"]["interrupt_type"] == "HistoryCompactionRequest"
    assert "OVERFLOW-OBSERVATION" not in transcript(model.requests[0])


def test_anthropic_provider_input_usage_includes_cache_reads_and_writes_once():
    from webwright.models.anthropic_model import _usage_from_anthropic_payload
    from webwright.models.openrouter_model import _usage_metrics_from_chat_completions

    usage = _usage_from_anthropic_payload({"usage": {
        "input_tokens": 1_000, "cache_read_input_tokens": 170_000,
        "cache_creation_input_tokens": 9_000, "output_tokens": 500,
    }})
    assert usage["input_tokens"] == 180_000
    assert usage["total_tokens"] == 180_500
    assert usage["cached_input_tokens"] == 170_000
    openai_usage = _usage_metrics_from_chat_completions({"usage": {
        "prompt_tokens": 180_000, "completion_tokens": 500, "total_tokens": 180_500,
        "prompt_tokens_details": {"cached_tokens": 170_000},
    }})
    assert openai_usage["input_tokens"] == 180_000
