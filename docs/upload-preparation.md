# 上传前文件准备与 Windows 命令行入口

`browser.upload` 和 Extension Adapter 的 `set_file_input` 共用宿主文件准备流程。先验证绝对路径、普通文件和目录限额；Windows 客户端若在 `WEWORKER_RESOURCES_PATH/tools/sd_decrypt.exe` 提供解密工具，则逐个检测文件，仅对明确加密的文件调用解密，再复查为未加密。最后重新执行路径与打开句柄的文件身份、类型、大小检查，保留原上传保护。

大小不一致不能证明文件加密；工具失败、未知状态或解密后仍加密时停止，返回 `dispatched:false`。不复制明文、不绕过现有解密工具。没有工具或非 Windows 环境沿用普通文件校验。准备结果中的 `checked/decrypted/method` 只描述本机准备，不证明网站已接收附件。

Adapter 通过 Bridge 请求准备，再复用浏览器上传器与已有 CDP 连接，避免重复 attach/detach。若上传器返回 `dispatched:true` 且结果不确定，必须检查网站附件状态，不能自动换通道重传。

Windows 桌面包增加 `webcli.ps1`，PowerShell 直接启动原生运行时并转发参数，避免经 `.cmd` 二次解释已引用的 URL 中的 `&`。调用方仍需正常引用完整 URL；复杂参数可使用 `--args-file`。该入口保留退出码并等待 Electron 输出完成。

聚焦回归覆盖普通文件、解密及复查失败、Adapter 共用上传器、浏览器上传和 PowerShell 5.1/7 参数与退出码。源代码测试不代替完整安装包和真实站点验收。
