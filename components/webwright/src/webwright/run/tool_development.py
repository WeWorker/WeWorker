from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

from webwright.models import get_model
from webwright.server.records import atomic_write_json
from webwright.server.toolkit_store import validate_tool_slot
from webwright.utils.logging import append_process_log, log_run_error


_SYSTEM_PROMPT = """You are the Webwright Tool Developer Agent. Produce one minimal stable browser Tool from the supplied evidence.
Return only one JSON object with exactly these fields: code, description, parameters_schema, result_schema, risk_notice.
parameters_schema and result_schema must each be a JSON-encoded object string; the runtime decodes and validates both strings before saving the Developer Slot.
The code must contain only one top-level async function named exactly as tool.tool_id; put any imports or helpers inside that function. Do not use decorators, positional-only parameters, *args, or **kwargs. Its first parameter is ctx; all other parameters are business parameters. parameters_schema.properties must match those business parameters exactly, and parameters_schema.required must match the parameters without defaults. Never expose target_id or cdp_url. Use ctx.page for Playwright operations. Do not include markdown fences."""

_SLOT_FIELDS = (
    "code",
    "description",
    "parameters_schema",
    "result_schema",
    "risk_notice",
)

_DEVELOPER_SLOT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "code": {"type": "string"},
        "description": {"type": "string"},
        "parameters_schema": {"type": "string"},
        "result_schema": {"type": "string"},
        "risk_notice": {"type": "string"},
    },
    "required": list(_SLOT_FIELDS),
}


def _developer_system_prompt(tool_id: str) -> str:
    parameters_schema = {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": False,
    }
    result_schema = {"type": "object", "properties": {}}
    example = {
        "code": f"async def {tool_id}(ctx):\n    return {{}}",
        "description": "Describe the Tool result.",
        "parameters_schema": json.dumps(parameters_schema, ensure_ascii=False),
        "result_schema": json.dumps(result_schema, ensure_ascii=False),
        "risk_notice": "",
    }
    return (
        f"{_SYSTEM_PROMPT}\n\nEXAMPLE JSON OUTPUT:\n"
        f"{json.dumps(example, ensure_ascii=False)}"
    )


class DeveloperRunError(RuntimeError):
    def __init__(self, error_code: str, stage: str, message: str):
        super().__init__(message)
        self.error_code = error_code
        self.stage = stage


class DeveloperOutputError(ValueError):
    def __init__(
        self,
        error_code: str,
        stage: str,
        event: str,
        message: str,
        *,
        error_type: str,
    ):
        super().__init__(message)
        self.error_code = error_code
        self.stage = stage
        self.event = event
        self.error_type = error_type


def _log_paths(spec: dict[str, Any]) -> tuple[Path | None, Path | None]:
    model = spec.get("model")
    model = model if isinstance(model, dict) else {}
    process_log = str(model.get("process_log_path") or "").strip()
    runtime_errors = str(model.get("error_log_path") or "").strip()
    return (
        Path(process_log) if process_log else None,
        Path(runtime_errors) if runtime_errors else None,
    )


def _json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, flags=re.DOTALL)
    if match:
        stripped = match.group(1)
    payload = json.loads(stripped)
    if not isinstance(payload, dict):
        raise ValueError("Developer Agent output must be a JSON object.")
    return payload


def _validate_developer_output(text: str, *, tool_id: str) -> dict[str, Any]:
    if not text.strip():
        raise DeveloperOutputError(
            "developer_output_empty",
            "output_parse",
            "output_empty",
            "模型返回了空内容。",
            error_type="EmptyContent",
        )
    try:
        slot = _json_object(text)
    except (json.JSONDecodeError, ValueError) as exc:
        raise DeveloperOutputError(
            "developer_output_invalid_json",
            "output_parse",
            "output_parse_failed",
            "模型未返回合法的 JSON 对象。",
            error_type=type(exc).__name__,
        ) from exc
    if set(slot) != set(_SLOT_FIELDS):
        raise DeveloperOutputError(
            "developer_output_invalid_slot",
            "output_validate",
            "output_validation_failed",
            "Developer Slot 必须且只能包含约定字段。",
            error_type="InvalidSlotFields",
        )
    for field in ("parameters_schema", "result_schema"):
        value = slot[field]
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError as exc:
                raise DeveloperOutputError(
                    "developer_output_invalid_slot",
                    "output_validate",
                    "output_validation_failed",
                    f"{field} 不是合法的 JSON 对象字符串。",
                    error_type=type(exc).__name__,
                ) from exc
            slot[field] = value
        if not isinstance(value, dict):
            raise DeveloperOutputError(
                "developer_output_invalid_slot",
                "output_validate",
                "output_validation_failed",
                f"{field} 必须编码一个 JSON 对象。",
                error_type="InvalidSlotFieldType",
            )
    scalar_types = {
        "code": str,
        "description": str,
        "risk_notice": str,
    }
    for field, expected_type in scalar_types.items():
        if not isinstance(slot[field], expected_type):
            raise DeveloperOutputError(
                "developer_output_invalid_slot",
                "output_validate",
                "output_validation_failed",
                f"{field} 类型不符合 Developer Slot 约束。",
                error_type="InvalidSlotFieldType",
            )
    try:
        return validate_tool_slot(tool_id, slot)
    except ValueError as exc:
        raise DeveloperOutputError(
            "developer_output_invalid_slot",
            "output_validate",
            "output_validation_failed",
            str(exc),
            error_type=type(exc).__name__,
        ) from exc


def _repair_messages(model: Any, *, raw_text: str, error: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    if raw_text.strip():
        messages.append(model.format_message(role="assistant", content=raw_text))
    messages.append(
        model.format_message(
            role="user",
            content=(
                "The preceding Developer Slot JSON was invalid: "
                f"{error}\nReturn only one corrected JSON object matching the original "
                "Developer Slot contract. Do not include markdown or explanations."
            ),
        )
    )
    return messages


async def run_development(spec: dict[str, Any]) -> dict[str, Any]:
    process_log_path, runtime_error_path = _log_paths(spec)
    input_payload = json.loads(Path(spec["input_path"]).read_text(encoding="utf-8"))
    tool = input_payload.get("tool")
    tool = tool if isinstance(tool, dict) else {}
    tool_id = str(tool.get("tool_id") or "").strip()
    if not tool_id:
        raise DeveloperRunError(
            "development_input_invalid",
            "input",
            "Developer 输入缺少 tool.tool_id。",
        )
    model = get_model(spec["model"])
    messages = [
        model.format_message(role="system", content=_developer_system_prompt(tool_id)),
        model.format_message(
            role="user", content=json.dumps(input_payload, ensure_ascii=False, indent=2)
        ),
    ]
    request_messages = list(messages)
    raw_text = ""
    last_output_error: DeveloperOutputError | None = None
    for round_index in range(2):
        is_repair = round_index == 1
        append_process_log(
            process_log_path,
            source="developer",
            event="structured_request_started",
            round=round_index + 1,
            repair=is_repair,
        )
        payload = (
            model._build_structured_payload(
                request_messages,
                schema=_DEVELOPER_SLOT_SCHEMA,
                schema_name="developer_slot",
            )
            if not is_repair
            else model._build_structured_repair_payload(
                request_messages,
                schema=_DEVELOPER_SLOT_SCHEMA,
                schema_name="developer_slot",
                raw_text=raw_text,
                error=str(last_output_error or "Invalid Developer Slot output."),
            )
        )
        try:
            response = await model._post_with_retries(payload)
        except json.JSONDecodeError as exc:
            raise DeveloperRunError(
                "model_response_invalid",
                "response_decode",
                "模型响应不是合法 JSON。",
            ) from exc
        except Exception as exc:
            raise DeveloperRunError(
                "model_request_failed",
                "model_request",
                f"模型请求失败：{type(exc).__name__}",
            ) from exc
        raw_text = model._extract_text(response)
        try:
            slot = _validate_developer_output(raw_text, tool_id=tool_id)
        except DeveloperOutputError as exc:
            last_output_error = exc
            if not is_repair:
                append_process_log(
                    process_log_path,
                    source="developer",
                    event="output_repair_started",
                    error_code=exc.error_code,
                    stage=exc.stage,
                    error_type=exc.error_type,
                    content_chars=len(raw_text),
                )
                request_messages.extend(
                    _repair_messages(model, raw_text=raw_text, error=str(exc))
                )
                continue
            log_run_error(
                process_log_path,
                runtime_error_path,
                source="developer",
                event=exc.event,
                error_code=exc.error_code,
                stage=exc.stage,
                error_type=exc.error_type,
                content_chars=len(raw_text),
                repair_attempted=True,
            )
            raise DeveloperRunError(exc.error_code, exc.stage, str(exc)) from exc
        append_process_log(
            process_log_path,
            source="developer",
            event="output_parsed",
            round=round_index + 1,
            repair=is_repair,
            field_count=len(slot),
        )
        atomic_write_json(Path(spec["result_path"]), {"ok": True, "slot": slot})
        return slot
    raise RuntimeError("Developer output retry loop ended unexpectedly.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Webwright Tool Developer Agent.")
    parser.add_argument("--spec", required=True, type=Path)
    args = parser.parse_args(argv)
    spec: dict[str, Any] = {}
    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
        slot = asyncio.run(run_development(spec))
    except DeveloperRunError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error_code": exc.error_code,
                    "stage": exc.stage,
                    "error": str(exc),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        process_log_path, runtime_error_path = _log_paths(spec)
        log_run_error(
            process_log_path,
            runtime_error_path,
            source="developer",
            event="worker_failed",
            error_code="worker_crashed",
            stage="worker",
            error_type=type(exc).__name__,
        )
        print(
            json.dumps(
                {
                    "ok": False,
                    "error_code": "worker_crashed",
                    "stage": "worker",
                    "error": f"Developer Worker 执行失败：{type(exc).__name__}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps({"ok": True, "slot": slot}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
