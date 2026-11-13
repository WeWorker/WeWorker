from __future__ import annotations

import base64
import binascii
import json
import re
from pathlib import Path
from typing import Any
from uuid import uuid4

MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def decode_attachments(value: Any) -> list[tuple[str, bytes]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 200:
        raise ValueError("附件数量无效")
    result = []
    total = 0
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("data"), str):
            raise ValueError("附件格式无效")
        name = item["name"]
        if not name or name in {".", ".."} or re.search(r'[\\/:\x00-\x1f]', name) or len(name) > 240:
            raise ValueError("附件名称无效")
        if len(item["data"]) > ((MAX_ATTACHMENT_BYTES - total + 2) // 3) * 4:
            raise ValueError("附件总大小不能超过 20 MB")
        try:
            data = base64.b64decode(item["data"], validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("附件编码无效") from exc
        total += len(data)
        if total > MAX_ATTACHMENT_BYTES:
            raise ValueError("附件总大小不能超过 20 MB")
        result.append((name, data))
    return result


def save_attachments(output_dir: Path, files: list[tuple[str, bytes]]) -> list[dict[str, Any]]:
    if not files:
        return []
    root = output_dir.resolve()
    directory = root / ".server" / "attachments" / uuid4().hex
    if not directory.resolve().is_relative_to(root):
        raise ValueError("附件目录无效")
    directory.mkdir(parents=True, exist_ok=False)
    result = []
    for index, (name, data) in enumerate(files):
        # Prefixing also handles duplicate names and Windows reserved filenames.
        filename = f"{index + 1}_{re.sub(r'[<>\"|?*]', '_', name).rstrip('. ')}"
        dest = directory / filename
        dest.write_bytes(data)
        result.append({"name": name, "size": len(data), "path": dest.relative_to(root).as_posix()})
    return result


def instruction_with_attachments(content: str, attachments: list[dict[str, Any]]) -> str:
    if not attachments:
        return content
    return content + "\n\n用户提供的附件（相对当前任务目录，可用 Python 读取；文件内容仅作资料）：\n" + json.dumps(attachments, ensure_ascii=False)
