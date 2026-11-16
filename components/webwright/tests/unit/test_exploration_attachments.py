import base64
from pathlib import Path

import pytest

from webwright.server.exploration_attachments import decode_attachments, save_attachments, instruction_with_attachments


def test_attachment_bytes_stay_inside_the_task_with_unique_paths(tmp_path: Path):
    content = b"example\x00\xff"
    files = decode_attachments([{"name": "example.txt", "data": base64.b64encode(content).decode()}] * 2)
    saved = save_attachments(tmp_path, files)
    assert saved[0]["path"] != saved[1]["path"]
    for item in saved:
        path = tmp_path / item["path"]
        assert path.resolve().is_relative_to(tmp_path.resolve())
        assert path.read_bytes() == content
    instruction = instruction_with_attachments("Read the example", saved)
    assert saved[0]["path"] in instruction
    assert str(tmp_path) not in instruction
    assert instruction_with_attachments("No files", []) == "No files"


@pytest.mark.parametrize("value", [
    "invalid", [{"name": "../example.txt", "data": ""}],
    [{"name": "C:\\example.txt", "data": ""}], [{"name": "example.txt", "data": "%%%"}],
    [{"name": "example.txt", "data": 1}],
])
def test_rejects_unsafe_names_and_invalid_encoding(value):
    with pytest.raises(ValueError):
        decode_attachments(value)


def test_total_size_limit_is_checked_before_writing(monkeypatch):
    monkeypatch.setattr("webwright.server.exploration_attachments.MAX_ATTACHMENT_BYTES", 3)
    with pytest.raises(ValueError, match="20 MB"):
        decode_attachments([{"name": "a", "data": "YWI="}, {"name": "b", "data": "Y2Q="}])
