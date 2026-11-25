"""Bounded, structural Fetch/XHR evidence from the task-owned page only."""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from webwright.server.records import atomic_write_json

MAX_REQUEST_BODY = 256_000
# Response reads and persisted structure have independent budgets. A large
# list may have a small reusable schema; never clip JSON before extracting it.
MAX_RESPONSE_BODY = 4 * 1024 * 1024
MAX_SHAPE_DEPTH = 7
MAX_SHAPE_NODES = 300
MAX_SHAPE_PROPERTIES = 50
PRIVATE = re.compile(r"token|cookie|auth|password|secret|session|credential|api.?key|csrf|ticket", re.I)


def structural_url(value):
    url = urlsplit(value)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
        raise ValueError("Invalid evidence URL")
    segments = [":id" if re.search(r"@|%40", p, re.I) or re.fullmatch(r"\d{3,}|[a-fA-F0-9-]{24,}", p) else p for p in url.path.split("/")]
    return urlunsplit((url.scheme, url.netloc, "/".join(segments), urlencode([(k, "<value>") for k, _ in parse_qsl(url.query) if not PRIVATE.search(k)]), ""))


def shape(value, depth=0, budget=None):
    budget = budget if budget is not None else [MAX_SHAPE_NODES]
    budget[0] -= 1
    if depth >= MAX_SHAPE_DEPTH or budget[0] < 0:
        return {"type": "unknown"}
    if isinstance(value, dict):
        return {"type": "object", "properties": {k[:100]: shape(v, depth + 1, budget) for k, v in list(value.items())[:MAX_SHAPE_PROPERTIES] if not PRIVATE.search(k) and budget[0] > 0}}
    if isinstance(value, list):
        return {"type": "array", "items": shape(value[0], depth + 1, budget) if value else {"type": "unknown"}}
    return {"type": "null" if value is None else "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "string"}


def body_evidence(body=None, content_type="", *, max_bytes=MAX_REQUEST_BODY):
    result = {"version": 1, "bodyKind": "opaque", "bodyShape": None, "bodyKeys": [], "bodyOmitted": True, "bodyTruncated": False, "bodyFullSize": 0, "bodyReadLimit": max_bytes}
    if body is None:
        result["bodyOmissionReason"] = "not_captured"
        return result
    result["bodyFullSize"] = len(body.encode("utf-8"))
    if result["bodyFullSize"] > max_bytes:
        result["bodyTruncated"] = True
        result["bodyOmissionReason"] = "too_large"
        return result
    try:
        if "application/x-www-form-urlencoded" in content_type:
            properties = {key[:100]: {"type": "string"} for key, _ in parse_qsl(body, max_num_fields=100) if not PRIVATE.search(key)}
            result.update(bodyKind="form", bodyShape={"type": "object", "properties": properties}, bodyKeys=list(properties), bodyOmitted=False)
            return result
        result.update(bodyKind="json", bodyShape=shape(json.loads(body)), bodyOmitted=False)
        result["bodyKeys"] = list(result["bodyShape"].get("properties", {}))
    except (ValueError, TypeError):
        result["bodyOmissionReason"] = "non_json" if body.strip() else "empty"
    return result


def mutation_observed(body):
    try:
        if not isinstance(body, str) or len(body) > MAX_REQUEST_BODY:
            return False
        try:
            value = json.loads(body)
        except ValueError:
            value = dict(parse_qsl(body, max_num_fields=100))
        if not isinstance(value, dict):
            return False
        return any(isinstance(value.get(key), str) and re.search(r"delete|remove|update|create|submit|publish|save|cancel|approve|reject|mutation", value[key], re.I)
                   for key in ("action", "operation", "op", "query"))
    except (ValueError, TypeError):
        return False


class ApiEvidenceCapture:
    def __init__(self, output_dir: Path, start_url: str, step=lambda: 0, resume=False):
        self.file = output_dir / ".server" / "api-evidence.json"
        self.origin = urlsplit(start_url)
        self.step = step
        self.entries = {}
        if resume:
            for entry in read_api_evidence(output_dir)["entries"][:100]:
                self.entries[(entry["method"], entry["url"])] = entry
        self.pending = {}
        self.tasks = set()
        self.session = None
        self.closed = False
        self.accepting = True
        self.status = "not_started"
        self.dropped = 0

    def persist(self):
        if any(parent.is_symlink() for parent in (self.file, *self.file.parents)):
            raise ValueError("API evidence path must not use symbolic links")
        atomic_write_json(self.file, {"schema_version": 1, "structural_only": True, "status": self.status,
                                     "dropped": self.dropped, "entries": list(self.entries.values())})

    async def start(self, context, page):
        try:
            self.session = await context.new_cdp_session(page)
            self.session.on("Network.requestWillBeSent", self.request)
            self.session.on("Network.responseReceived", self.response)
            self.session.on("Network.loadingFinished", self.finished)
            self.session.on("Network.loadingFailed", lambda event: self.pending.pop(event.get("requestId"), None))
            await self.session.send("Network.enable", {"maxTotalBufferSize": MAX_RESPONSE_BODY * 4, "maxResourceBufferSize": MAX_RESPONSE_BODY, "maxPostDataSize": MAX_REQUEST_BODY})
            self.status = "capturing"
        except Exception:
            self.status = "unavailable"
        self.persist()

    def request(self, event):
        request_id = event.get("requestId")
        self.pending.pop(request_id, None)
        if not self.accepting or event.get("type") not in {"Fetch", "XHR"} or len(self.pending) >= 100:
            return
        request = event.get("request", {})
        try:
            url = urlsplit(request["url"])
            if (url.scheme, url.netloc) != (self.origin.scheme, self.origin.netloc):
                return
            self.pending[request_id] = {"url": structural_url(request["url"]), "method": request.get("method", "GET"),
                                        "step": self.step(), "mutationObserved": mutation_observed(request.get("postData")),
                                        "requestEvidence": body_evidence(request.get("postData"), next((str(value) for key, value in request.get("headers", {}).items() if key.lower() == "content-type"), ""))}
        except (KeyError, ValueError):
            return

    def response(self, event):
        entry = self.pending.get(event.get("requestId"))
        if entry is not None:
            response = event.get("response", {})
            entry.update(status=response.get("status"), responseContentType=str(response.get("mimeType", ""))[:80])

    def finished(self, event):
        entry = self.pending.pop(event.get("requestId"), None)
        if not self.accepting or entry is None or len(self.tasks) >= 8:
            return
        task = asyncio.create_task(self.finish_entry(event, entry))
        self.tasks.add(task)
        task.add_done_callback(self.completed)

    def completed(self, task):
        self.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self.status = "unavailable"

    async def finish_entry(self, event, entry):
        entry["responseEvidence"] = body_evidence(max_bytes=MAX_RESPONSE_BODY)
        transfer_size = event.get("encodedDataLength")
        if type(transfer_size) not in (int, float) or not 0 <= transfer_size <= 2**53 - 1:
            transfer_size = None
        try:
            # Some sites return JSON with text/html or missing MIME metadata.
            # Read only bounded, already-observed responses and parse their actual
            # contents; getResponseBody does not replay the website request.
            # Transfer size can differ from decoded size (compression), or be
            # absent. Check decoded UTF-8 bytes independently after reading.
            if transfer_size is None or transfer_size <= MAX_RESPONSE_BODY:
                result = await asyncio.wait_for(self.session.send("Network.getResponseBody", {"requestId": event["requestId"]}), 2)
                body = result["body"]
                if not isinstance(body, str):
                    raise TypeError("Invalid response body")
                if result.get("base64Encoded"):
                    if len(body) > 4 * ((MAX_RESPONSE_BODY + 2) // 3):
                        entry["responseEvidence"].update(bodyTruncated=True, bodyOmissionReason="too_large")
                    else:
                        body = base64.b64decode(body, validate=True).decode("utf-8")
                        entry["responseEvidence"] = body_evidence(body, max_bytes=MAX_RESPONSE_BODY)
                else:
                    entry["responseEvidence"] = body_evidence(body, max_bytes=MAX_RESPONSE_BODY)
            else:
                entry["responseEvidence"].update(bodyTruncated=True, bodyOmissionReason="too_large")
        except asyncio.TimeoutError:
            entry["responseEvidence"]["bodyOmissionReason"] = "read_timeout"
        except (UnicodeError, binascii.Error):
            entry["responseEvidence"]["bodyOmissionReason"] = "invalid_encoding"
        except Exception:
            entry["responseEvidence"]["bodyOmissionReason"] = "read_failed"
        if transfer_size is not None:
            entry["responseEvidence"]["bodyTransferSize"] = int(transfer_size)
        if not self.closed:
            key = (entry["method"], entry["url"])
            previous = self.entries.get(key)
            if key in self.entries or len(self.entries) < 100:
                self.entries[key] = entry
                if len(json.dumps(list(self.entries.values()), indent=2, ensure_ascii=False).encode("utf-8")) > 1_400_000:
                    if previous is None:
                        self.entries.pop(key)
                    else:
                        self.entries[key] = previous
                    self.dropped += 1
            else:
                self.dropped += 1
            self.persist()

    async def close(self):
        # Stop accepting network events before draining owned response reads.
        self.accepting = False
        while self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)
        self.closed = True
        self.dropped += len(self.pending)
        self.pending.clear()
        if self.session:
            try:
                await self.session.detach()
            except Exception:
                pass
        if self.status == "capturing":
            self.status = "complete"
        self.persist()


def read_api_evidence(output_dir):
    file = output_dir / ".server" / "api-evidence.json"
    if not file.exists():
        return {"schema_version": 1, "structural_only": True, "status": "not_captured", "entries": []}
    if any(parent.is_symlink() for parent in (file, *file.parents)) or file.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Invalid API evidence artifact")
    return json.loads(file.read_text(encoding="utf-8"))
