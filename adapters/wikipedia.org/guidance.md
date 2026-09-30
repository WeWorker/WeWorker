# Wikipedia 使用指导

全部为公开只读后台API，仍需已连接的WeWorker扩展和Bridge，无需打开业务页。
- 使用 --key=value；lang 默认为 en，可用 zh/ja/de/zh-min-nan 等语言代码，不接受域名或URL。未知语言可能返回HTTP错误，不能默默改为英语。
- 先 search 获取实体标题；summary 是最多300字符的导语，random 是随机条目导语。extract_truncated/extract_length 描述截断；不是全文。
- page 默认 paragraphs=0 返回API提供的完整纯文本extract，含重定向后的真实标题；paragraphs=N 显式限制段落，total_paragraphs/extract_truncated说明范围。不包含图片、所有表格或页面渲染内容，不承诺等于完整网页。
- trending 请求昨日UTC的featured feed；feed_date是请求日期，mostread_date是上游公布的数据日期，两者不等同。views缺失为null，不填0；最多50条不等于全部访问量。
- summary description缺失为null；search snippet最多120字符，trending description最多80字符。不用摘要长度判断文章长度。
- 网络/HTTP/API错误、结构漂移、合法无结果分别报错；不绕过验证或通过其他语言降级假成功。
- 本轮证据优先于历史记忆；实际可用性见迁移记录，fixture不等于自然语言验收。
