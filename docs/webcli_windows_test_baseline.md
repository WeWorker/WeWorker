# Windows WebCLI 四项基线失败修复

2026-10-28，接续 B01 本地提交 `5e3c09b`。用户要求一并解决此前在未修改的 `dev-1.0.2` 也能复现的四项失败。最终修改测试与隔离验收夹具，产品运行时校验保持。

## 链接测试（两项）

`adapter-export.test.js` 和 `skills-cli.test.js` 在创建符号链接时遇到 Windows EPERM，尚未执行到产品拒绝逻辑。目录链接改为 Windows junction，其他平台仍创建目录 symlink；实际验证链接祖先不被跟随、链接 Skill 不进入列表，且导出不修改受保护目录。

文件链接单独保留测试：POSIX 使用任务临时目录内的真实文件 symlink，不再依赖 `/etc/hosts`；Windows 用文件链接的 lstat 元数据替身验证最终文件拒绝分支，并断言内容读取零调用。没有跳过用例、要求管理员权限或修改系统设置。Windows 真实文件 symlink 的创建依然需要相应系统权限，junction 实测不能替代这一平台机制。

## 上传大小测试（一项）

初始测试写入 12 字节 `.txt`，却从路径 stat 得到 8192。进一步本机实验表明，Node 的打开句柄 fstat/读取分别得到实际 12 字节；空文件和 JSON 文件不呈现相同差异。不能仅从这点推断产品 stat 实现错误。

真实 Chrome 对两个公开文本夹具的 `File.size` 和 `arrayBuffer().byteLength` 均为 8192，而 Node 句柄读取为 14/33 字节，且 Chrome 文本内容与原夹具不一致。这说明此环境存在跨进程文件视图差异；未确认具体系统过滤组件。尝试用 Node 句柄大小替换上传元数据导致真实 `UPLOAD_VERIFICATION_FAILED`，该尝试已撤下，没有进入最终实现。

单测使用明确 16 字节的公开 JSON 文件，继续严格验证实际元数据、目标转发和能力限制。新增测试确认不会用当前进程的内容长度替换路径元数据、不会为计算大小读取上传内容、元数据不可用时零上传派发。实际浏览器验收使用包含中文文件名/内容的公开 JSON 夹具，仍逐字检查 Chrome 读取内容和 loopback 表单接收内容；检查隐藏控件、语义定位、Shadow、AX、嵌套跨源 frame 及失效/替换/重置拒绝。

这修复了测试对文本文件存储方式的假设，不表示改变了本机文件处理策略，也不保证系统处理后的任意 `.txt` 会在 Chrome 中还原成 Node 看到的内容。没有复制或转换用户文件来绕过该差异。验收失败时只保存合成夹具的大小和内容相等与否，不记录文件正文。

## 输出格式测试（一项）

完整 prepared 目录的 `list`、`adapter list` JSON 实测各为 1,122,872 字节，超过 Node `execFileSync` 默认 1 MiB 输出缓冲，触发 ENOBUFS。JSON 可完整解析；不是 CLI 格式化失败。

测试将这两类目录及帮助子进程的缓冲设为有界 16 MiB、每次执行最长 15 秒，保留完整 JSON/YAML 内容比较与拒绝操作断言；不截断目录或跳过断言。

## 验证

WebCLI 全量 **147 文件/1708 项全部通过**（`.cache/four-failures-all-final.log`），聚焦 **4 文件/37 项通过**。Windows Chrome `156.0.8078.48` 源码上传专项 `webcli-browser-acceptance-6u6czT/report.json`、CLI＋Bridge 双打包专项 `webcli-browser-acceptance-d5nsFK/report.json` 均 **4 项通过**，包含真实表单提交和精确内容验证。

CLI/Bridge 从最终代码重新构建通过；保留既有三个列映射资源缺失提示，与这四项失败无关。语法与 diff whitespace 检查通过。此前句柄大小尝试的失败报告 `0gQDqq`、带尺寸/内容等值诊断的 `XCb7tH` 保留，不计成功。最终 `browser-service.js` 与 B01 提交一致；没有通过放宽校验、跳过用例或修改系统文件策略使测试通过。
