from __future__ import annotations

import threading
import time
from pathlib import Path

from webwright.server.records import atomic_write_json


def test_atomic_write_json_handles_concurrent_readers(tmp_path: Path) -> None:
    target = tmp_path / "concurrent.json"
    target.write_text('{"init": true}', encoding="utf-8")

    stop_reading = False
    read_count = 0

    def background_reader() -> None:
        nonlocal read_count
        while not stop_reading:
            try:
                _ = target.read_text(encoding="utf-8")
                read_count += 1
            except OSError:
                pass
            time.sleep(0.001)

    thread = threading.Thread(target=background_reader, daemon=True)
    thread.start()

    try:
        for i in range(50):
            atomic_write_json(target, {"step": i})
            time.sleep(0.002)
    finally:
        stop_reading = True
        thread.join(timeout=2)

    assert read_count > 0
    assert target.is_file()
