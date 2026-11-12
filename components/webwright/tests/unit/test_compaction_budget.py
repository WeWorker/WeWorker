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
