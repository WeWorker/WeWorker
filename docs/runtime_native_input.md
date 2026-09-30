# 页面原生文本与按键 helper

Extension 页面 Runner 的 `requestPrivileged('native_input', payload)` 支持两种固定操作：

- `{ type: 'text', text: '...' }`：CDP Input.insertText，最多 20000 字符。
- `{ type: 'key', key: 'Enter' }`：固定 Enter、PageDown、Escape、Backspace、Tab 的 keyDown/keyUp；Enter 包含回车字符。

仅使用消息 sender 的 tab，不接受调用者指定 tab 或任意 CDP 方法。参数校验先于 debugger 附加；复用已有附件时不释放，自己附加的连接在成功与异常时均释放。不记录输入内容。后台 direct Runner 不提供此 helper。业务确认、输入字段定位和提交后验证仍由 Adapter 与原有确认机制负责。

内外仓通用实现与 `extension/test/native-input.test.mjs` 同步。此次没有扩展全局网络权限。
