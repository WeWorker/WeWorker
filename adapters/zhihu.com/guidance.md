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

多轮结果按实际 type 选择命令：问题进入 question，回答进入 answer-detail。文章无独立只读详情命令，想法无详情/互动入口，不套用回答动作。收藏夹使用真实内容 ID 生成公开 URL，不把 API URL 当操作目标。评论作者使用 url_token；没有 token 时不能用昵称代替。收藏夹名称、评论/回答文本、导出目录由用户补充；download 会写文件，按写动作处理。

## 图文文章发布

新增 prepare-article、publish-article、article-status；原有命令保持不变。只有用户授权发布且明确文章内容后，才传 execute=true。prepare-article 只保存草稿，必须核对 draft_saved 回执；publish-article 只有服务器确认 published 才返回发布成功；submission_received 仅表示观察到发布接口 HTTP 成功响应，仍须独立查询 article-status。导航准备 executed=false 时，确认编辑器加载后再次调用原参数，不把导航当作保存成功。

上传只接受本地绝对路径图片，最多 16 张不同图片，每张最多 8 MiB，总计 32 MiB，支持 PNG/JPEG/WebP/GIF；正文为不超过 1 MiB 的 UTF-8 文件。依赖已登录浏览器及站点编辑器自身上传、保存动作；遇到登录、验证码、站点结构变化时停止并保留 trace。

提交后超时、页面跳转断连或 OUTCOME_UNKNOWN 均先查询状态及创作中心，不得自动重发。会话提交标记阻止同一草稿重复点击，不自动清除。用户已发布的文章不作为新草稿覆盖。

知乎 prepare-article 的 file 是 HTML（不是 Markdown），支持段落、标题、列表、链接及本地图片；图片 src 为绝对路径。仅接受允许的 HTML 标签和 HTTPS 链接，表格会转换为逐行列表以保留每个单元格文字。已有草稿须显式传 draft-id。保存使用站点自身动作，并读回服务器正文与图片数；发布命令会比较服务器草稿与编辑器标题、React 正文状态、图片数量及图片加载状态。保存后会先重新加载草稿并返回 prepared/executed=false；再次调用相同授权参数才提交，不需要调用者手动操作浏览器。

publish-article 传 draft-id、与草稿一致的 title；AI 辅助文章传 declaration=ai，保留平台创作声明。发布可能持续数分钟，不因按钮停留在“发布中”重复提交。article-status --id 查询服务器状态：draft 是草稿，published 是已发布，其他原始状态保留为 submitted。不要将 submission_received 当作发布完成。若点击后没有观察到发布响应或 published 状态，返回 OUTCOME_UNKNOWN，不宣称提交成功。提交记录跨标签页和重新加载保留，不自动清除；先查询状态及页面校验提示，再处理结果未知。不要并行运行操作同一站点编辑器的任务。
