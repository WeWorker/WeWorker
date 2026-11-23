from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from webwright.tool_runtime.toolkit_runtime import PublishedToolkitRunner

sys.dont_write_bytecode = True

# 修复版参考答案(修复草稿回放用):参数缺失返回结构化错误,正常路径返回文章。
# 模块形态与故障版一致(adapter_v2 生成命令合同),仅 get_article 逻辑不同。

async def get_article(ctx, keyword=None):
    """修复版:参数缺失返回结构化错误,正常路径返回文章。"""
    if not keyword:
        return {"ok": False, "error": "keyword is required", "needs_user": True}
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
