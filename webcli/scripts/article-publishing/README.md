# 掘金 / 知乎文章发布源码

修改 common.js、juejin.js、zhihu.js 后执行：

```sh
node webcli/scripts/article-publishing/build.mjs
node --test webcli/__tests__/article-publishing.node.mjs
webcli adapter validate adapters/juejin.cn
webcli adapter validate adapters/zhihu.com
```

build.mjs 同步源码到 Adapter 包，并生成三个命令模块和 manifest。原有命令、runtime、权限、构建 profile 的站点清单均保留；两站已经在现有 profile 中打包，不新增宿主能力或依赖。站点 guidance.md 会进入安装后的技能书。

```sh
webcli call juejin.cn.prepare-article --title=示例 --file=/absolute/path/article.md --execute=true
webcli call juejin.cn.publish-article --draft-id=123 --title=示例 --category=人工智能 --tags=人工智能 --summary=示例摘要 --execute=true
webcli call juejin.cn.article-status --draft-id=123
webcli call zhihu.com.prepare-article --title=示例 --file=/absolute/path/article.html --execute=true
webcli call zhihu.com.publish-article --draft-id=123 --title=示例 --declaration=ai --execute=true
webcli call zhihu.com.article-status --id=123
```

以上 ID/路径为占位。导航准备阶段不执行写入；编辑器就绪后再次调用相同授权参数。已有草稿通过 draft-id 显式选择。完整边界和上传限制见各站 guidance.md。

## 实现与验证边界

掘金调用 Markdown 编辑器 Vue 实例的 uploadImages，CodeMirror 保存正文；知乎调用编辑器 React 实例的 uploadImage/updateDraft。读取状态经站点原生 API；不导出 Cookie、不复刻签名、不直接拼装发布请求。知乎 HTML 表格转换为列表，避免服务端静默剥离整张表。禁止用直接修改 contenteditable DOM 代替编辑器保存。

真实登录环境已完成两站各一篇带三张配图的文章发布，并核验服务器状态、公开正文和图片加载。掘金保留审核原始状态，不推测审核通过。掘金最终提交后立即返回，再独立查状态，避免成功跳转关闭消息通道而误报失败；知乎 0.2.1 的回执与同步检查见下节。知乎原生发布按钮可能等待数分钟；不自动重试。最终提交的额外回放不会用于测试。

站点内部 Vue/React 接口可能变化，缺少上传器、按钮、回执或服务器正文不匹配时显式失败，不降级为未经核验的成功。提交记录为会话级保护；服务器未发布校验补充跨会话防重复，但不保证跨多个并发客户端的全局幂等。聚焦测试覆盖授权、参数、导航、源文件、状态身份/长 ID、草稿映射和包生成一致性。

## 知乎 0.2.1 发布修复

准备草稿后设置页面级同步标记；发布前比较草稿 API 与 React 编辑器状态，并检查图片已加载。新保存或状态不一致时通过宿主写准备导航重新加载，返回 prepared/executed=false，禁止自动续跑写入。调用者再次调用同一授权参数后才会发布。

提交前后校验目标文章 ID，页面校验错误阻止提交。提交记录同时保存在会话和同源持久存储中，重载或其他标签页不会自动重试。围绕单次提交短时观察站点原生 fetch：只记录精确文章发布路径的 HTTP 状态，不读取请求/响应正文、Cookie 或头部，不构造发布请求。30 秒后恢复原函数。服务器 published 才视为发布成功；接口响应而尚未 published 返回未核验的 submission_received；无证据或被拒绝返回 OUTCOME_UNKNOWN。若站点改用其他传输方式，仍通过文章 API 验证最终状态，否则保守返回未知。

聚焦回归覆盖新保存/旧编辑器阻断并准备重载、视口外延迟图片主动加载、图片加载失败、单次点击、跨标签页提交记录、静默点击、HTTP 拒绝和 HTTP 成功但仍是草稿的情况。宿主仍使用既有页面占用锁；这不构成永久专用标签页，调用者不能并行导航同一个站点编辑器。
