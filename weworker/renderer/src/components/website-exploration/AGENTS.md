# 网站探索原生工作区

- 本目录只负责 React 界面；服务请求放在现有 `api/website-exploration-api.js`，会话状态放在 `store/website-exploration.js`。
- 复用客户端主题，界面使用「网站探索agent」与「Adapter」；运行资格和版本校验以服务端为准。
- 弹窗不得通过遮罩或 Escape 关闭。切换对象或页面必须遵守代码草稿离开保护。
- 不引入新框架或依赖，聚焦单测与 Renderer 构建通过后才能标记完成。
