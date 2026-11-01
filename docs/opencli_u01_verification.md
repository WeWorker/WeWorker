# U01 通用验证、兼容运行时诊断与 Git 来源

本轮基于公开 B02 `db712f397b218dd654d6a77baa28e9a3b9f660a9`，独立分支 `codex/opencli-u01-verification`，目标 `dev-1.0.2`。开始时远程目标为 `9a01e40`，#181、#186、#187 均 OPEN，依赖链为本 PR → #187 → #186 → #181。没有重复 cherry-pick、切换其他 checkout 或修改内部差异。

仓库当时允许 merge commit、squash、rebase 三种合并方式；尚未发生前序合并，不能推断未来方式。merge commit 保留祖先时会自然缩小后续 PR；若前序 squash/rebase，后续交付前必须重新核对 patch/祖先关系并整理增量，不直接合入重复提交。不自动合并。

## 固定上游和实际差距

对照仍是官方 npm OpenCLI **1.8.8**；tarball SHA256 `68fb69d6dcfbcb1f76da88278b499abe322dcca712f3b79fe01729cb63ae6d7a`。读取 `verify.js`、`validate.js`、`plugin.js`、`plugin-manifest.js`，并直接执行未修改的 verify/registry/manifest 导出。复现：

```text
node webcli/scripts/audit-opencli-u01.mjs --upstream=<解包目录>
```

| 项目 | 上游实际行为 | 本项目增量 |
| --- | --- | --- |
| verify | validate 检查 registry；普通验证不执行注册的读/写函数。smoke 仅运行 tests/smoke，发布包缺目录时 executed:false、ok:false | 复用 v2 校验，统一静态结果和现有历史作者证据；不另造 smoke runner |
| 未找到目标 | 上游 verify 返回 commands:0、ok:true | 继续沿用本项目明确 ADAPTER_NOT_ACTIVE，避免将无目标计为通过 |
| Git/monorepo | clone、声明式子插件、禁用过滤、安装生产依赖（ignore-scripts）、TS 转译和来源锁；不等于 .adapt 安装 | 补本地 Git 固定提交的 v2 子包发现、校验和单包显式安装；远程 clone/update 与上游插件执行模型仍不同 |
| legacy/Toolkit | 上游 JS registry 规则不能直接认证这两种运行时 | 复用静态名称解析、Toolkit manifest/hash/runtime 定位；无效包不再在本诊断入口被静默略过 |

本轮不引入 OpenCLI 插件兼容层、系统 Python 或另一套运行器。source 支持的是已存在的本地 Git repository；远程 Git 获取可由用户按既有 Git 工作流完成，本命令不会连接 remote。上游远程安装/更新、TS 编译/依赖生命周期没有因此关闭。

## verify：静态结果与历史证据分开

```text
webcli adapter verify <package-directory>
webcli adapter verify --installed [name]
webcli adapter verify --installed <name> --knowledge-dir <existing-knowledge-directory> --require-evidence
webcli adapter verify <directory> --runtime legacy
webcli adapter verify --installed [name] --runtime toolkit
```

默认 runtime 为 managed。复用 `collectDiagnosticPackages` 和 `inspectPackage`，检查当前选择、内容摘要、权限和 JS 编译；不连接 Bridge、不启动浏览器、不调用任何读或写工具。现有 `adapter validate/status/convention-audit` 继续可用。

报告 `staticOk` 只表示静态检查，`evidenceComplete` 只表示所选本地知识包含对应包和全部命令的近期历史证明记录。`ok` 默认随静态结果；加 `--require-evidence` 时，两者必须满足，否则退出码 1。未知选项、非法 runtime/输出格式拒绝执行。六种既有输出格式复用。

历史证据必须显式选择一个已有 knowledge 目录，不搜索其他 profile，不创建目录或跨 profile 合并记录。HTTP 的知识位于相应 Adapter workspace 的 `http-exploration/knowledge`；浏览器任务位于明确 context 的 `browser-profiles/<contextId>/exploration/knowledge`。这两个上下文必须按实际任务来源选择，不能根据站点名猜测登录态。

每条命令绑定当前包摘要和命令记录摘要，检查 30 天时限及未来时间；只输出 case 数量、类型、时间及状态，不输出 args、断言、完整响应、写 fixture、实际 ID、账户或文件路径。错误包括：

| 状态 | 含义 |
| --- | --- |
| EVIDENCE_SOURCE_NOT_SELECTED / EVIDENCE_MISSING | 未选知识源／该命令无记录 |
| EVIDENCE_INVALID / EVIDENCE_DIGEST_MISMATCH / EVIDENCE_STALE | 数据不可读、摘要不符或已过期 |
| HISTORICAL_READ_CASES | 保存过当前包的作者读用例 |
| HISTORICAL_WRITE_EFFECT | 保存过当前包的独立写效果记录，含禁止重放标记 |
| READ_CASES_MISSING / WRITE_EFFECT_EVIDENCE_MISSING | 缺用例／缺独立效果；离线 mock 不能冒充写效果 |

知识是本地、可修改的历史数据，不是带签名的认证。即使全部匹配，报告仍为 `executed:false`、`currentEffectVerified:false`、`replayAllowed:false`，不改变安装权限、不授予真实写、不重放。当前真实验证继续走 `exploration.validate`；写工具继续走精确审阅、明确授权、独立效果和持久消费。普通调用 trace 不含作者业务断言，不能据调用成功自动认证；任务 trace、知识与普通 trace 的完整导出留给 U06。

## legacy / Toolkit 诊断

legacy 读取 manifest、index 和声明 support_files，限制单文件 2 MiB，拒绝路径越界、链接和特殊文件；JS 只编译，名称使用现有 namesOnly 静态解析，不求值动态元数据。`LEGACY_STATIC_NAMES_ONLY` 明确辅助模块／动态注册并非完整运行发现，空名称返回 `LEGACY_COMMANDS_UNRESOLVED`，语法错误与重复静态名称分别报告。安装态使用既有 legacy builtin/user 根，managed 名称（包括禁用选择和失效候选）保持优先，不复活旧工具。

Toolkit 使用同一 manifest/固定入口/文件完整性/artifact_hash 校验；额外拒绝 scripts 父目录链接。运行时继续由既有 embedded 定位器选择，仅检查文件存在，缺失为 `TOOLKIT_RUNTIME_UNAVAILABLE`。始终返回 `TOOLKIT_PYTHON_NOT_EXECUTED`；既不回退系统 Python，也不执行 requirements 安装。合法包且运行文件缺失时 staticOk 仍可为 true，runtimeAvailable 为 false，不能解读为运行成功。未验证 embedded Toolkit 的实际执行，不把 Node 测试替身算成实机 Python。

## Git 固定提交和单包安装

```text
webcli adapter source <local-repository> --ref <full-commit-sha>
webcli adapter install --git <local-repository> --ref <full-commit-sha> --package packages/example --digest <reviewed-package-digest>
```

source 只接受完整 40/64 位 commit ID，不接受 HEAD、分支名或非 commit 对象。Git 读取禁用 replace objects、可选锁、提示和 lazy fetch；通过有界 ls-tree/cat-file 批量读取原始对象，不 checkout、不运行 hooks/filter/npm、不开子模块。最多 20000 条 tree 记录、200 个 manifest；单包沿用 512 文件/32 MiB，拒绝链接、submodule、路径越界、重复身份和非法包。根目录或任意层级 v2 包均按实际 manifest 发现；不读取 OpenCLI plugin manifest 作为可执行配置。

安装必须指定一个包路径和 source 报告中的摘要，再从同一固定 commit 读取并复验；不自动批量激活。复用 `installAdapter` 的权限变化、降级、来源切换和事务保护。安装记录保存 `origin:{kind:"git",commit,subpath}`，不记录 remote URL、凭据或本地仓库路径。更新 commit 被视为来源改变，需显式 `--change-source`，权限增加仍另需 `--allow-permission-change`；不自动更新。只支持本项目可验证的 v2 文件集合，不复制 repo 的 dependency/lifecycle 文件进入包。

## 交付证据与未覆盖范围

源码、prepared 扩展、CLI/Bridge bundle、CI 安装包和安装后运行必须分别判断。开始时 #187 Windows CI 产物 `test-build-windows-x64` 未过期，224451731 字节，artifact digest `sha256:823cc23c99de080404e49b2ac9ffcdeccf1541de8bf861a4af3ea6e1f3c786e2`；这只是前序 CI 产物身份，没有安装或验证客户端。本轮不替换用户客户端。

本轮最终测试和报告见交接的 U01 节。全部真实调用仅访问任务自有 loopback，Git 和安装目录为临时目录；未使用真实账户写。前序 B01/W01–W04/B02 的未改扩展能力沿用原证据，不重复声称已完成新的跨平台验收。

E01 的其他浏览器/系统、E02 实际 Windows/macOS 客户端安装、E03 新对话和 E04 真实认证站点继续开放。没有可授权的隔离客户端安装链路，本轮 E02 明确保留。W03 安装后仍为单工具调用，W04 仍只绑定明确实际来源且 decimal 最多 512 字符，B02 上传仍为 browser 原语，其余声明式控件/frame/Shadow 边界保持。

中间失败：Git 初稿逐对象多进程读取使 Windows 一项测试超时，改为有界 batch 后通过；没有放宽超时。首次上游直接导入缺 turndown，隔离目录安装 1.8.8 已声明生产依赖（ignore-scripts）后可运行；第一版合成 registry 缺 access 被上游拒绝，补明确 read/write 后记录实际行为。均不算首次成功。

PR #188 首轮 Linux CI：1737 项通过、1 项失败。Toolkit 必需文件的符号链接在新增父目录检查处更早拒绝，错误文案与既有断言不符；保留原“must be a regular file”契约并给出 UNSAFE_TOOLKIT_FILE 分类，同时加强 Windows junction/普通符号目录断言，不删除或放宽原测试。最终状态以修复提交 CI 为准。

## 下一阶段 U06

2026-10-29 接续已实施：[U06 任务诊断专项](opencli_u06_diagnostics.md)。下述排期保留为原决策记录，当前交付证据见新专项和交接；U01 的历史证据与写权限边界没有改变。

优先补已确认的统一诊断产物：明确任务/profile/时间或游标窗口，聚合现有任务 trace、普通调用 trace、network/console 事件、状态和可选截图，保留每项来源、时间、执行环境、截断/缺失原因、摘要和脱敏说明。导出到明确新目录，拒绝覆盖、越界和链接；有界读取，不隐式重放动作、启动未知进程、删除历史文件或混合账户上下文。

先用隔离 loopback 页面 fetch、Dedicated Worker、Service Worker、未结束 SSE/长响应和失败动作核查固定上游 1.8.8 与本项目实际事件/正文行为。区分父页经 SW 返回的请求和 Worker 自发请求、完成后正文和未结束增量正文、历史读取/同命令结果续取和流量重发。未证实的上游能力不作为必须实现项。U04 外部 CDP/Electron、U05 外部 CLI 和 U03 站点行为审计保持独立；本轮不展开。
