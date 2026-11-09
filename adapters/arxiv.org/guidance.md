# arXiv 论文

多轮入口：列表可按实际论文 ID 查看详情；详情的“查看作者”要求明确提供作者姓名，再调用作者检索。当前 authors 是合并的展示文本，不按逗号拆分或擅自取第一位作者，也不把论文 ID 当作作者身份。PDF 链接不代表已读取论文全文。

使用 `webcli call arxiv.org.search --query=transformer --limit=5`。
search 默认 10，最多 25；author 默认 20，最多 50，按提交日期倒序且姓名为模糊匹配；recent 按分类（如 cs.CL）列最新提交，默认 10、最多 50。paper 接收现代或旧式 arXiv ID，可带 v 版本号。

paper 返回论文元数据、摘要和 PDF 链接，不是 PDF 正文或下载。来源输出的 id/url 去掉版本号，PDF 链接保留版本。字段缺失保留空串，不补造作者、分类和日期。公开 Atom API 通过既有后台请求执行，无需账号；错误 Atom、HTML 或畸形响应不当作空论文列表。查询没有结果会显式报告 EMPTY_RESULT。
