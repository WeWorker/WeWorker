import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from webwright.environments.api_evidence import MAX_REQUEST_BODY, MAX_RESPONSE_BODY, ApiEvidenceCapture, body_evidence, mutation_observed, read_api_evidence, structural_url
from webwright.server.development import build_exploration_development_input
from webwright.server.records import TaskStore


def test_capture_only_structure_from_owned_origin(tmp_path):
    async def run():
        session = SimpleNamespace(on=lambda *args: None, send=AsyncMock(return_value={"body": json.dumps({"items": [{"id": "private-value", "token": "placeholder-secret"}]})}), detach=AsyncMock())
        context = SimpleNamespace(new_cdp_session=AsyncMock(return_value=session))
        capture = ApiEvidenceCapture(tmp_path, "https://example.com/", lambda: 3)
        await capture.start(context, object())
        capture.request({"requestId": "outside", "type": "XHR", "request": {"url": "https://example.org/list"}})
        assert not capture.pending
        capture.request({"requestId": "one", "type": "Fetch", "request": {"url": "https://example.com/api/list?q=private-query&token=placeholder-secret", "method": "GET"}})
        capture.response({"requestId": "one", "response": {"status": 200, "mimeType": "application/json"}})
        capture.finished({"requestId": "one", "encodedDataLength": 200})
        await capture.close()
        data = read_api_evidence(tmp_path)
        assert data["status"] == "complete"
        assert len(data["entries"]) == 1
        entry = data["entries"][0]
        assert entry["step"] == 3
        assert entry["responseEvidence"]["bodyShape"]["properties"]["items"]["items"]["properties"] == {"id": {"type": "string"}}
        serialized = json.dumps(data)
        for secret in ("private-query", "private-value", "placeholder-secret", "token", "headers"):
            assert secret not in serialized
        session.detach.assert_awaited_once()
    asyncio.run(run())


def test_large_or_non_json_body_is_not_guessed():
    assert body_evidence('x' * 256001)["bodyTruncated"] is True
    assert body_evidence('<html>login</html>')["bodyOmitted"] is True
    assert structural_url('https://example.com/items/12345?session=placeholder&id=42') == 'https://example.com/items/:id?id=%3Cvalue%3E'
    assert mutation_observed('{"operation":"delete"}') is True
    assert mutation_observed('{"query":"mutation { removeItem { id } }"}') is True
    assert mutation_observed('operation=delete&item=placeholder') is True
    form = body_evidence('keyword=placeholder-query&token=placeholder-secret', 'application/x-www-form-urlencoded')
    assert form['bodyShape']['properties'] == {'keyword': {'type': 'string'}}
    assert 'placeholder' not in json.dumps(form)


def test_missing_capture_is_explicit(tmp_path):
    assert read_api_evidence(tmp_path)["status"] == "not_captured"


def test_resume_preserves_prior_structure_but_new_capture_does_not(tmp_path):
    capture = ApiEvidenceCapture(tmp_path, 'https://example.com/')
    entry = {'url': 'https://example.com/list', 'method': 'GET', 'step': 1}
    capture.entries[('GET', entry['url'])] = entry
    capture.persist()
    assert len(ApiEvidenceCapture(tmp_path, 'https://example.com/', resume=True).entries) == 1
    assert not ApiEvidenceCapture(tmp_path, 'https://example.com/').entries


def test_capture_failure_does_not_prevent_browser_exploration(tmp_path):
    async def run():
        capture = ApiEvidenceCapture(tmp_path, 'https://example.com/')
        await capture.start(SimpleNamespace(new_cdp_session=AsyncMock(side_effect=RuntimeError('unavailable'))), object())
        await capture.close()
        assert read_api_evidence(tmp_path)["status"] == 'unavailable'
    asyncio.run(run())


async def capture_response(tmp_path, response, mime_type="text/html", encoded_size=120):
    async def send(method, parameters):
        if method == "Network.getResponseBody":
            if isinstance(response, Exception):
                raise response
            return response
        return {}

    session = SimpleNamespace(on=lambda *args: None, send=AsyncMock(side_effect=send), detach=AsyncMock())
    capture = ApiEvidenceCapture(tmp_path, "https://example.com/", lambda: 4)
    await capture.start(SimpleNamespace(new_cdp_session=AsyncMock(return_value=session)), object())
    capture.request({"requestId": "example-request", "type": "XHR", "request": {
        "url": "https://example.com/api/search", "method": "POST", "postData": '{"keyword":"placeholder-query"}',
    }})
    capture.response({"requestId": "example-request", "response": {"status": 200, "mimeType": mime_type}})
    capture.finished({"requestId": "example-request", **({"encodedDataLength": encoded_size} if encoded_size is not None else {})})
    await capture.close()
    return read_api_evidence(tmp_path), session


@pytest.mark.parametrize("mime_type", ["text/html", "text/plain", "application/octet-stream", "", "Application/JSON", "application/json"])
def test_json_response_is_captured_despite_inaccurate_mime_type(tmp_path, mime_type):
    body = json.dumps({"items": [{"id": "placeholder-id", "title": "placeholder-title", "token": "placeholder-secret"}]})
    data, session = asyncio.run(capture_response(tmp_path, {"body": body}, mime_type))
    entry = data["entries"][0]
    assert entry["responseContentType"] == mime_type
    assert entry["responseEvidence"]["bodyKind"] == "json"
    assert entry["responseEvidence"]["bodyOmitted"] is False
    assert entry["responseEvidence"]["bodyFullSize"] == len(body.encode("utf-8"))
    assert entry["responseEvidence"]["bodyShape"]["properties"]["items"]["items"]["properties"] == {
        "id": {"type": "string"}, "title": {"type": "string"},
    }
    assert [call.args[0] for call in session.send.await_args_list] == ["Network.enable", "Network.getResponseBody"]
    assert "placeholder" not in json.dumps(data)
    assert "bodyOmissionReason" not in entry["responseEvidence"]


def test_base64_json_preserves_structure_without_response_values(tmp_path):
    body = json.dumps({"title": "示例内容"}, ensure_ascii=False).encode("utf-8")
    data, _ = asyncio.run(capture_response(tmp_path, {"body": base64.b64encode(body).decode("ascii"), "base64Encoded": True}))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyShape"] == {"type": "object", "properties": {"title": {"type": "string"}}}
    assert evidence["bodyFullSize"] == len(body)
    assert "示例内容" not in json.dumps(data, ensure_ascii=False)


@pytest.mark.parametrize("response,reason", [
    ({"body": "<html>placeholder-private-value</html>"}, "non_json"),
    ({"body": ""}, "empty"),
    ({"body": "not_base64", "base64Encoded": True}, "invalid_encoding"),
    ({"body": "/w==", "base64Encoded": True}, "invalid_encoding"),
    ({}, "read_failed"),
    (RuntimeError("placeholder-private-error"), "read_failed"),
    (asyncio.TimeoutError("placeholder-private-error"), "read_timeout"),
])
def test_omission_reasons_distinguish_missing_empty_and_non_json_bodies(tmp_path, response, reason):
    data, session = asyncio.run(capture_response(tmp_path, response))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyOmissionReason"] == reason
    assert evidence["bodyOmitted"] is True
    assert evidence["bodyShape"] is None
    assert "placeholder" not in json.dumps(data)
    assert data["status"] == "complete"
    session.detach.assert_awaited_once()


def test_oversized_transfer_is_not_read(tmp_path):
    data, session = asyncio.run(capture_response(tmp_path, {"body": "{}"}, encoded_size=MAX_RESPONSE_BODY + 1))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyOmissionReason"] == "too_large"
    assert evidence["bodyTruncated"] is True
    assert evidence["bodyReadLimit"] == MAX_RESPONSE_BODY
    assert evidence["bodyTransferSize"] == MAX_RESPONSE_BODY + 1
    assert evidence["bodyFullSize"] == 0  # Wire size is not decoded body size.
    assert [call.args[0] for call in session.send.await_args_list] == ["Network.enable"]


@pytest.mark.parametrize("size", [MAX_RESPONSE_BODY + 1, MAX_RESPONSE_BODY * 2 + 1])
def test_decoded_body_limit_still_applies_to_small_transfers(tmp_path, size):
    data, _ = asyncio.run(capture_response(tmp_path, {"body": '"' + "x" * size + '"'}, encoded_size=100))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyOmissionReason"] == "too_large"
    assert evidence["bodyTruncated"] is True
    assert evidence["bodyShape"] is None
    assert evidence["bodyFullSize"] == size + 2
    assert evidence["bodyTransferSize"] == 100


@pytest.mark.parametrize("size", [300_000, 2 * 1024 * 1024, MAX_RESPONSE_BODY])
@pytest.mark.parametrize("base64_encoded", [False, True])
def test_large_json_keeps_bounded_structure_and_reaches_development_input(tmp_path, size, base64_encoded):
    store = TaskStore(tmp_path)
    output_dir = store.task_dir("exp_large")
    store.create_task_record(task_id="exp_large", title="Example", instruction="Read items",
                             start_url="https://example.com/", output_dir=output_dir,
                             run_id="run-example", activity_type="exploration")
    store.update_task("exp_large", status="succeeded")
    payload = {"padding": "", "items": [{"title": "placeholder-title", "dueDate": "2026-12-01", "token": "placeholder-secret"}]}
    payload["padding"] = "x" * (size - len(json.dumps(payload).encode("utf-8")))
    body = json.dumps(payload)
    assert len(body.encode("utf-8")) == size
    response = {"body": base64.b64encode(body.encode("utf-8")).decode("ascii") if base64_encoded else body,
                "base64Encoded": base64_encoded}
    data, session = asyncio.run(capture_response(output_dir, response, encoded_size=size))
    entry = data["entries"][0]
    evidence = entry["responseEvidence"]
    assert evidence["bodyFullSize"] == size
    assert evidence["bodyReadLimit"] == MAX_RESPONSE_BODY
    assert evidence["bodyKind"] == "json"
    assert evidence["bodyOmitted"] is False
    assert evidence["bodyTruncated"] is False
    assert evidence["bodyShape"]["properties"]["items"]["items"]["properties"] == {
        "title": {"type": "string"}, "dueDate": {"type": "string"},
    }
    assert entry["requestEvidence"]["bodyReadLimit"] == MAX_REQUEST_BODY
    assert session.send.await_args_list[0].args == ("Network.enable", {
        "maxTotalBufferSize": MAX_RESPONSE_BODY * 4, "maxResourceBufferSize": MAX_RESPONSE_BODY,
        "maxPostDataSize": MAX_REQUEST_BODY,
    })
    assert [call.args[0] for call in session.send.await_args_list] == ["Network.enable", "Network.getResponseBody"]
    handoff = build_exploration_development_input(task_store=store, exploration_id="exp_large")
    assert handoff["source_exploration"]["api_evidence"] == data
    serialized = json.dumps(handoff)
    assert len(serialized) < 4000
    for scalar in ("placeholder-title", "placeholder-secret", "placeholder-query", "2026-12-01", "x" * 100):
        assert scalar not in serialized


def test_large_list_persists_item_structure_without_rows(tmp_path):
    body = json.dumps({"items": [{"id": "placeholder-id", "title": "placeholder-title"}] * 20_000})
    assert MAX_REQUEST_BODY < len(body) < MAX_RESPONSE_BODY
    data, _ = asyncio.run(capture_response(tmp_path, {"body": body}, encoded_size=len(body)))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyShape"]["properties"]["items"]["items"]["properties"] == {
        "id": {"type": "string"}, "title": {"type": "string"},
    }
    assert len(json.dumps(data)) < 2000
    assert "placeholder" not in json.dumps(data)


@pytest.mark.parametrize("encoded_size", [None, 0, 100])
def test_unknown_or_compressed_transfer_size_does_not_drop_structure(tmp_path, encoded_size):
    body = json.dumps({"padding": "x" * 300_000, "items": [{"title": "placeholder-title"}]})
    data, _ = asyncio.run(capture_response(tmp_path, {"body": body}, encoded_size=encoded_size))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyKind"] == "json"
    assert evidence["bodyFullSize"] == len(body)
    assert evidence.get("bodyTransferSize") == encoded_size


def test_decoded_limit_counts_utf8_bytes_not_characters(tmp_path):
    body = json.dumps({"title": "例" * (MAX_RESPONSE_BODY // 3 + 1)}, ensure_ascii=False)
    assert len(body) < MAX_RESPONSE_BODY < len(body.encode("utf-8"))
    data, _ = asyncio.run(capture_response(tmp_path, {"body": body}, encoded_size=100))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyOmissionReason"] == "too_large"
    assert evidence["bodyFullSize"] == len(body.encode("utf-8"))
    assert evidence["bodyShape"] is None


def test_oversized_base64_body_is_not_parsed(tmp_path):
    data, _ = asyncio.run(capture_response(tmp_path, {
        "body": "A" * (4 * ((MAX_RESPONSE_BODY + 2) // 3) + 4), "base64Encoded": True,
    }, encoded_size=100))
    evidence = data["entries"][0]["responseEvidence"]
    assert evidence["bodyOmissionReason"] == "too_large"
    assert evidence["bodyShape"] is None
    assert evidence["bodyFullSize"] == 0
