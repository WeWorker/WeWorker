# 掘金文章发布指导

## 图文文章发布

新增 prepare-article、publish-article、article-status；原有命令保持不变。只有用户授权发布且明确文章内容后，才传 execute=true。prepare-article 只保存草稿，必须核对 draft_saved 回执；publish-article 返回 submission_started 只表示已点击一次提交，随后独立调用 article-status。导航准备 executed=false 时，确认编辑器加载后再次调用原参数，不把导航当作保存成功。

上传只接受本地绝对路径图片，最多 16 张不同图片，每张最多 8 MiB，总计 32 MiB，支持 PNG/JPEG/WebP/GIF；正文为不超过 1 MiB 的 UTF-8 文件。依赖已登录浏览器及站点编辑器自身上传、保存动作；遇到登录、验证码、站点结构变化时停止并保留 trace。

提交后超时、页面跳转断连或 OUTCOME_UNKNOWN 均先查询状态及创作中心，不得自动重发。会话提交标记阻止同一草稿重复点击，不自动清除。用户已发布的文章不作为新草稿覆盖。

prepare-article 的 file 为 Markdown，正文图片使用 ![说明](/absolute/path/image.png)。编辑已有草稿必须显式传 draft-id。保存后按服务器草稿读回核验正文；平台图片 URL 的查询参数变化不影响比较，域名、路径和正文仍需一致。

publish-article 必填 draft-id、title、category、tags、summary；tags 为英文逗号分隔的 1..3 个准确站点标签，summary 为 1..100 字。禁止绕过站点禁用的标签。发布时标题必须与草稿一致。article-status 使用 id 或 draft-id（二选一）；草稿 ID 可解析出发布后的文章 ID。submitted 表示文章身份已核验，原始 status/audit_status 不等于审核已通过。成功页跳转可能断开消息通道，查询状态后再决定后续操作。
