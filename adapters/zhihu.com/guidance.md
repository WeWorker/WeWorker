# 知乎使用指导

hot 看热榜，recommend 看推荐，search 搜索，question 看问题回答摘要（摘要可能截断），answer-detail 读取单篇回答全文，answer-comments 读评论层级。搜索 type 为 all/answer/article/question。全文需求不能用问题摘要代替。收藏夹先 collections，再 collection 读取指定夹；favorite 不创建收藏夹，collection 名称有歧义时使用实际 collection-id。

目标格式保留 question:问题ID、answer:问题ID:回答ID、article:文章ID、user:用户标识及官方详情 URL。ID 作为字符串保留，不能用浮点数改写长 ID。回答与问题 ID 不混用。answer-comments 的 limit 计顶层唯一评论，replies-limit 计每个顶层回复；parent_id/depth 保留层级，replies-limit=0 不请求子回复。

follow/like/favorite/comment/answer 同时要求 execute=true 和宿主确认。comment 是顶层评论；answer 是新建非匿名纯文本回答。text 与 file 的选择按当前 Schema；多行文件使用本地 UTF-8 文件。当前固定源码写入经站点 API，旧文档“必须预先打开空白编辑器”的说法不应覆盖当前实现。

download 导出文章/回答全文 Markdown；output 指定本地目录，download-images=true 才尝试保存图片。图片失败时保留远程链接并返回 partial，不能宣称完整离线保存。正文导出成功以实际 saved 文件为准。二进制图片要求运行新版 Bridge；发现旧版时不会把文本当图片写入。登录页跳转时请用户在 www.zhihu.com 完成登录；不要循环导航。

## 调用与证据

普通参数使用 --key=value；复杂结构才使用 JSON。只调用本 Skill 当前 manifest 列出的命令。用户说“第二个”“刚才那条”时保留上一轮实际 ID 和链接，不重新取列表位置代替实体。相对日期按当前日期和用户时区换算并写出实际日期；关键缺参先追问，不能从站点默认值猜用户选择。

只读页面导航由宿主在一次调用中续执行。登录和验证码由用户在连接扩展的同一浏览器中完成；login 只打开官方页并结束，不会等待 timeout 秒或宣称已经登录。whoami 不等于完整登录验收。当前要求、当前 Skill 和本轮证据优先于历史失败记忆。临时失败不能变成永久跳过工具的规则。

接口失败、验证页、字段缺失、页面空状态与真正无结果须区分。字段为 null 或空串表示未知，不补猜。返回列表不等于全站完整结果；limit 是上限。失败保留 trace，不重复相同参数盲目重试，不用降级查询宣称原命令通过。

仅在用户要求执行且目标、内容明确时提交写操作；参数不清楚时先澄清。导航准备不等于业务操作完成，写操作不得自动重放。超时后先核查站点状态，不能直接重发。
