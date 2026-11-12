# Gmail

多轮附件动作同时携带来源 emailId 和附件名；执行前先打开该邮件，无法打开则停止下载。普通未传 emailId 的附件调用保留当前邮件语义。邮件 ID 按字面值匹配，不拼接进 CSS 选择器；重复 ID 时停止，不能任意选一封。

多轮会话：search-emails/get-unread-emails 按返回的 thread ID 进入 open-email；附件按原文件名生成下载计划，当前会话内不执行写操作。

登录检测、导航与页面状态显式声明无对象后续动作，不从页面标题或 URL 猜邮件 ID。
