# 闲鱼

search/item/inbox/messages/chat 为浏览器读取（搜索、商品详情、消息收件箱与会话），访问 goofish.com；publish/reply/chat 为写操作需确认：publish 发布纯文本闲置商品（本运行时无文件系统，不支持图片上传，price 为正数、condition 为全新/几乎全新/轻微使用/明显使用/老旧之一），reply 回复会话消息，chat 发送聊天消息，均通过页面 UI 自动化完成且不自动重放。whoami 校验登录并读取身份；login 仅打开登录页（写操作需确认，打开后人工完成登录再用 whoami 验证，不轮询登录状态）。登录墙或页面结构变化时报错而非空结果；缺字段保留 null/空串，不补造 0 或空列表。

## 多轮结果与后续动作

search 的商品 ID 对应 item；item 的商品 ID 与 seller_id 对应 chat，消息文案由本轮明确补充。inbox/messages 后续只使用 item_id 与 peer_user_id，不把 rank 当作跨轮定位参数。rank 仅是本次结果中的展示引用；缺少完整会话 ID 时先重新查询并传 resolve-ids=true，不得按变化后的页面位置回复。messages 默认 rank=0 表示使用完整 ID。发送后先核验结果，不盲目重放。
