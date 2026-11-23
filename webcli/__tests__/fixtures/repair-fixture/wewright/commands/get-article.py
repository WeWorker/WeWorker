from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from webwright.tool_runtime.toolkit_runtime import PublishedToolkitRunner

sys.dont_write_bytecode = True

# 合成故障 fixture(自进化回归用)。模块形态对齐 adapter_v2 生成命令
# (server/adapter_v2.py _command_source):`--internal-script` 以 __main__ 执行
# 本文件,必须自带 RUNNER 接线,stdin 收 JSON 参数、stdout 出结构化 JSON。
# 浏览器会话是 runner 合同的一部分(execute_tool 先 open session 再调函数)。

async def get_article(ctx, keyword=None):
    """故障版:keyword 缺失直接抛 TypeError(模拟上游校验缺失)。"""
    if keyword is None:
        raise TypeError("article title expected str, got None")
    return {"ok": True, "title": "article:" + str(keyword), "rows": [1, 2]}

SCHEMA = {
    "start_url": "https://example.com/",
    "parameters_schema": {"type": "object", "properties": {"keyword": {"type": "string"}}},
    "result_schema": {"type": "object"},
}
RUNNER = PublishedToolkitRunner(
    toolkit_id="demo-fixture",
    skill_dir=Path(__file__).resolve().parents[2],
    allowed_domains=["example.com"],
    tool_specs={"get-article": SCHEMA},
    tool_functions={"get-article": get_article},
    **({"cdp_url": os.environ["WEBWRIGHT_CDP_URL"]} if os.environ.get("WEBWRIGHT_CDP_URL") else {}),
)

def main():
    try:
        parameters = json.load(sys.stdin)
        if not isinstance(parameters, dict):
            raise ValueError("Tool parameters must be a JSON object.")
        parameters.pop("__confirmed", None)
        screenshot = os.environ.get("WEBWRIGHT_SCREENSHOT_PATH")
        output = asyncio.run(RUNNER.run(
            tool_id="get-article",
            parameters=parameters,
            screenshot_path=Path(screenshot) if screenshot else None,
        ))
        print(json.dumps(output, ensure_ascii=False))
        return 0 if output.get("ok") else 1
    except (TypeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": {"message": str(error)}}, ensure_ascii=False))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
