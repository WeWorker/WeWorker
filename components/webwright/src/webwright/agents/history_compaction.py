from __future__ import annotations

import json
import math
import re
from typing import Any


def transcript(messages: list[dict[str, Any]]) -> str:
    return "\n\n".join(f"{message['role']}: {message.get('content', '')}" for message in messages)


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text.encode("utf-8")) / 3)


def request_tokens(messages: list[dict[str, Any]]) -> int:
    return estimate_tokens(json.dumps([
        {"role": message["role"], "content": message.get("content", "")}
        for message in messages
    ], ensure_ascii=False))


def is_context_overflow(error: Exception) -> bool:
    # Summary errors keep a user-facing message and retain the provider failure as their cause.
    seen = set()
    cause: BaseException | None = error
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        response = getattr(cause, "response", None)
        detail = str(cause)
        if response is not None and getattr(response, "status_code", 0) in {400, 413, 422}:
            detail += " " + response.text
        if any(marker in detail.lower() for marker in (
            "context length", "context_length", "context window", "context_window",
            "prompt is too long", "prompt too long", "too many tokens", "maximum context",
            "input tokens exceed", "input is too long",
        )):
            return True
        cause = cause.__cause__
    return False


def select_source(history: str, *, ratio: int, context_limit: int, reserved_tokens: int) -> tuple[str, str]:
    budget = max(0, min(estimate_tokens(history), context_limit - reserved_tokens)) * ratio // 100
    boundaries = [0]
    # Punctuation, paragraphs and the end of the transcript are safe boundaries.
    for match in re.finditer(r'[。！？]+[”’」』]*\s*|[.!?]+(?:["\x27)]*\s+|$)|\n+|$', history):
        if match.end() > boundaries[-1]:
            boundaries.append(match.end())
    low, high = 0, len(boundaries) - 1
    while low < high:
        middle = (low + high + 1) // 2
        if estimate_tokens(history[:boundaries[middle]]) <= budget:
            low = middle
        else:
            high = middle - 1
    end = boundaries[low]
    return history[:end], history[end:]
