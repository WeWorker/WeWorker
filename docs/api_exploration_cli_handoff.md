# API 自动探索 CLI 改造跟进与交接

## 2026-10-29：U06 统一诊断交付

指定恢复 checkout 从干净 U01 `72b01a39a5df8bf935c98ef7ff223ba3a6c2da7e` 建立 `codex/opencli-u06-diagnostics`。重新 fetch 后目标 `dev-1.0.2` 为 `c15dfe5`；#181/#186/#187/#188 均 OPEN、mergeCommit=null，四级祖先关系成立，`git cherry` 未见等价 patch 已进入目标。以 merge `327613f` 纳入目标新增的登录立即返回修复，不 cherry-pick 前序、不改其他 checkout。依赖仍为本 PR → #188 → #187 → #186 → #181；未来 squash/rebase 合并必须再按 patch/祖先整理后续增量。

本轮增量为 `exploration.export` 及专属的 task-tab trace 读取：复用任务记录、browser events/state/screenshot 和 U01 静态/历史诊断，按 task/profile、UTC 窗口和预算生成 receipt/summary/时间线等统一产物。新目录独占写、默认结构脱敏、图片显式选择、部分结果退出 1；不自动启动服务、不调用 Adapter、不重放动作、不授予写权限。完整契约、上游和当前限制见 [U06 专项](opencli_u06_diagnostics.md)。

| 验证层 | 结果与本机记录 |
| --- | --- |
| 固定上游来源 | npm 1.8.8 tarball SHA256 与前序一致；四个执行/审计 JS 模块与 tarball 字节一致；固定 tag 的 cdp/journal Git blob 重取并核验。未使用新版 |
| 上游实际行为 | `opencli-u06-audit-cKINAp/report.json`：真实 direct CDP 的 page/SW-returned、独立 Worker 请求、未结束与完成正文、失败；journal/export 函数 harness 的结果续取/丢失/过大和导出零请求。不是 upstream CLI/daemon/扩展全链路 |
| WebCLI 完整 | 151 文件／1759 项，`.cache/u06-webcli-full.log`；两 worker。扩展/Bridge/任务来源、既有写保护回归均未放宽 |
| 扩展完整 | 365 项，`.cache/u06-extension-full.log`；含新增任务 trace 范围/身份/origin/预算拒绝测试 |
| 浏览器源码 | `webcli-browser-acceptance-HznUDk/report.json`，7 项：含两项基础连接，5 项 U06 网络/产物/截图/完成正文/截断失败 |
| CLI＋Bridge 双 bundle | `webcli-browser-acceptance-Dcu7ty/report.json`，8 项；在相同 U06 专项上另验第二个真实 profile 拒绝读取原任务。早期双 bundle `SouJX2` 7 项保留，不重复累加 |
| 实际普通调用关联 | 双 bundle `webcli-browser-acceptance-fHmDlU/report.json`，5 项；复用已有后台验收的生成/作者 cases/安装/普通调用/知识，导出真实 trace ID，来源摘要匹配，零新请求。普通 call 不认证独立效果，trace retention 未知保持 partial |
| HTTP 源码／双 bundle | `webcli-http-discovery-ONUPKc` / `webcli-http-discovery-vZFxff`，各 4 项；已有真实两组作者 cases、生成安装、普通调用和知识被关联到产物，零额外请求，浏览器来源明确不适用 |
| 实际临时 npm | `webcli-u06-npm-sAzyI3/report.json`，4 项；真实 npm-entry/Bridge 读取复制的已验 HTTP 任务/包/知识，未重新运行作者验证；无 Bridge 不启动，要求不可用来源时退出 1，源码/prepared/npm 必需文件字节匹配（worker 仅既有 3712 差异） |

上述报告均在系统临时根，日志位于当前 checkout `.cache`；不提交测试浏览器 profile、实际产物或运行时缓存。各层证据有重叠，不相加为独立案例总数。最后导出等待/断线提示补充“检查原目录、不覆盖部分产物”，随后重建最终 bundle/npm 并补聚焦与分发检查；最终补录见下方，先前成功不冒充最后未变更模块之外的重跑。

中间失败：`webcli-browser-acceptance-OwuGGz` 首次期待完成后的 SSE 原始正文，实际被现有非 JSON 正文省略规则拒绝。改验收为“SSE 完成事件但正文省略；JSON 长响应完成后正文可读”，没有放宽产品脱敏，最终源码和 bundle 通过。已有三个列映射资源缺失构建提示仍存在。没有通过删除断言、增加重发或扩大控件权限获得通过。

U06 本轮关闭契约内统一任务诊断导出及分发缺口，并补限定 Worker/流式/replay 行为证据；上游真实扩展/daemon 的网络与断线结果续取仍未验，HTTP/Toolkit 普通 trace 全局汇总不在此入口。没有新增完整 Worker 观察、未结束增量正文或流量重发。U04/U05 不展开；U03 未映射不等于缺失。W03 安装后单工具调用、W01/W02/B02 明确控件契约、W04 明确实际来源/512 字符 decimal、B02 browser 上传和 U01 历史证据边界全部保持。

E01–E04 继续开放，尤其 **E02 实际 Windows/macOS 客户端安装没有执行**。CI 打包、npm 安装和隔离 Chrome 均不能替代实机客户端安装。没有安装或替换用户客户端、真实账户写、接管未知进程/端口、改全局工具环境、CI/CD、发布、内部配置、持久记忆、新对话或子 Agent。不自动合并；以交付 PR 当前 HEAD 的 CI 为准。

最终分发补录：导出等待提示细化后，相关 4 文件／51 项通过（`.cache/u06-final-focused.log`）；最终 CLI/Bridge 重新构建，实际临时 npm pack **1094 文件**（含 diagnostic-export.js）。最终 HTTP 双 bundle `webcli-http-discovery-bwPGZ0` **4 项**，最终实际 npm `webcli-u06-npm-CMuRNr` **4 项**通过，六个宿主模块和三个扩展文件的源码/prepared/npm 对应检查包含最终 exploration-client。17 个改动 JS/MJS 语法与 diff whitespace 通过。没有重跑未变更的浏览器执行模块并冒称新客户端安装。提交前再次 fetch：目标仍为 c15dfe5，四个前序 PR 仍 OPEN。

## 2026-10-28：U01 通用验证与诊断交付

在指定恢复 checkout，从干净 B02 `db712f397b218dd654d6a77baa28e9a3b9f660a9` 建立 `codex/opencli-u01-verification`。开始和提交前复核：目标 `dev-1.0.2` 仍为 `9a01e40`，#181/#186/#187 均未合并。本 PR 依赖 #187 → #186 → #181，不重复摘取提交；合并方式尚未确定，若前序 squash/rebase 须重新整理后续增量。未切换或覆盖其他 checkout。

新增 `adapter verify` 复用静态校验与显式知识源的历史作者证据；`--runtime legacy|toolkit` 保留无效候选并诊断语法/完整性/运行时文件；`adapter source <local-repo> --ref <full-sha>` 发现固定提交中的 v2 子包，`install --git ... --package ... --digest ...` 通过原安装 store。没有新 Runner、隐式写验证或权限放宽。契约、具体错误、上游 1.8.8 真实行为、Git 生命周期未覆盖范围和 U06 排期见 [U01 专项](opencli_u01_verification.md)。

本机 Windows、Node 24.20.0；真实调用只用任务自有 Git/临时安装根/loopback，未安装客户端或操作真实账户。报告仅存本机临时目录，不提交业务响应或 profile。

| 验证层 | 结果及本机证据 |
| --- | --- |
| 固定上游实际函数 | `opencli-u01-audit-Dp0Eea/report.json`：普通 read/write verify 零执行、缺 smoke 明确失败、空目标零命令、禁用子包过滤；不是上游 daemon/安装生命周期 |
| WebCLI 完整 | 150 文件／1738 项通过，`.cache/u01-webcli-full.log`；两 worker。最后分类/权限摘要/读取预算细化另有下面聚焦及最终打包复验 |
| 最终相关聚焦 | 4 文件／42 项通过，`.cache/u01-final-focused.log`；含验证、Git、Toolkit、安装 store。Git 链接和脏 checkout 保留有实 Git 对象覆盖 |
| 最终源码管理与调用 | 5 项，`webcli-u01-acceptance-02ZrmN/report.json` |
| 最终打包管理与调用 | 5 项，`webcli-u01-acceptance-hbnhPM/report.json`；真实固定 commit 安装、普通 GET、六格式、legacy/Toolkit 失败及零写诊断 |
| 实际 npm 分发安装 | `npm pack` 1093 文件，安装到任务 `.cache/u01-npm/install`；实际 npm-entry 5 项，`webcli-u01-acceptance-t4CZAG/report.json`；没有全局安装或更换用户客户端 |
| 完整 HTTP 回归 | 源码 29 项 `webcli-http-discovery-V29DGX`，CLI＋Bridge 29 项 `webcli-http-discovery-wB9wEr`；生成/作者验证/安装/普通调用/知识、独立写效果/取消/重启/修复/不重放 |
| 最终生成和证据专项 | 源码 4 项 `webcli-http-discovery-73RNqs`，双 bundle 4 项 `webcli-http-discovery-FXFQ3V`；两个真实作者 cases 与已安装摘要匹配，verify 没有新请求 |
| 实际历史写证据补查 | 对上述完整 HTTP 留下的包和知识，源码与最终 bundle 均识别真实 HISTORICAL_WRITE_EFFECT；同时保留其他命令的 missing/digest mismatch，require-evidence 均退出 1；没有重放，未把部分证明认证为全包通过 |
| 资源和边界检查 | 8 个改动运行模块与实际 npm 安装副本字节一致；5 个前序扩展模块的源码/prepared/npm 一致，npm worker 按既有 3712 规则核对。公开 prepare 33 个包成功，JS/MJS 语法与 diff whitespace 通过；增量私网 IP/常见 Token/私钥模式零命中 |

各专项有重叠，不合并为独立案例总数。扩展执行代码未修改，B02 最终 363 项和控件/上传实机证据沿用原范围，没有冒称本轮重跑。最后 bundle 重新构建，仍有三个既有列映射资源缺失提示；没有改成静默成功。资源及历史写证据摘要为 `.cache/u01-delivery-summary.json`。

中间失败：Windows Git 逐文件子进程读取使一项测试超时，改为有界 cat-file batch 后通过，未放宽超时；上游缺依赖和合成注册缺 access 的失败保留在专项。历史写证据补查首次错误期待全部命令通过，真实记录存在旧摘要和缺失；修正验收预期，保留严格产品门禁。这是证据范围纠正，不是放宽校验。

下一阶段 U06：首先统一有界、脱敏、来源明确的诊断产物导出（任务/普通 trace、network、console、状态和可选截图）；Worker、未结束 SSE/长响应、结果续取和流量 replay 先核对固定上游 1.8.8 行为。U04/U05 不自动展开，U03 无映射不视为缺失。E01–E04 保留，尤其 E02 Windows/macOS 实际客户端安装未执行；已有 CI 安装包成功和本轮 npm 安装均不能替代。远程 Git clone/update、OpenCLI TS 插件生命周期和 embedded Toolkit 真运行未因此关闭。

没有发布或改 CI/CD、没有真实账户写、没有创建聊天/子 Agent、没有改持久记忆。PR 与当前提交 CI 状态以 GitHub 的最新记录为准，不自动合并。

交付 PR 为 #188。首轮 Linux CI 的 WebCLI 1737 项通过、1 项失败：Toolkit 链接文件更早拒绝后的错误文字遗漏原普通文件契约；恢复兼容说明并保持 UNSAFE_TOOLKIT_FILE 分类，增加父目录链接断言，原拒绝标准不放宽。配置和构建检查已通过；修复提交重新核验当前 CI，旧提交结果不代替最终提交。

## 2026-10-28：B02 控件与上传

在指定的恢复 checkout 核对后，从 #186 最新 af85115 建立独立 codex/opencli-b02-controls 分支。开始及开发复核时 #181、#186 均 OPEN，远程 dev-1.0.2 为 9a01e40；B02 依赖 #186（再依赖 #181），不重复 cherry-pick 前序提交，目标仍为 dev-1.0.2，不自动合并。原始公开 checkout 保持原分支；内部 checkout 的已有修改未触碰。

B02 新增明确 date/choice UI 契约、目录输入和原 frame 原生 chooser；已有 browser 操作、W02 的审阅/效果/安装链复用。生成、零写 mock、独立效果、安装和普通工具调用对日期/选项实测；上传是 browser 原语，验证动态 input、目录、真实字节与 multipart 接收，不把本地路径或验证任务安装到用户客户端。准确边界见 [B02 专项](opencli_b02_controls.md)。W03 仍是探索任务内序列，安装后单工具调用；W04 仍只使用明确实际来源与最多 512 字符 decimal ID。

固定 npm OpenCLI 1.8.8：实际 BasePage + CDP harness 验证 type 日期、原生 select/file、目录路径，确认 fill 日期/custom select/chooser 按钮 upload 的拒绝行为；未审计新版或冒称上游 daemon/扩展全链路。

WebCLI 完整 148 文件/1727 项通过（maxWorkers=2，原测试超时未放宽）；最终扩展 363 项通过。首轮 1718 通过/8 失败中两项能力元数据空值检查已修，其余六项在降低并发且构建目录稳定后复查通过，六文件专项共 91 项通过。失败原因和本机打包依赖问题保留在专项文档。

最终双打包控件 9 项（CdnxMZ）、上传 4 项（OO3WMp）、随包 Skill 4 项（mCxpE4）通过；npm 1091 文件与 5 个扩展模块资源核对通过。最后预检及 chooser 时序补强后扩展 363 项重跑通过；完整证据和失败记录见 B02 专项。

后续仍开放：B03 跨 frame/DataTransfer 拖拽，B04 AX/Shadow/子 frame 截图及设备恢复；A01 YAML/更广文档引用、A02 站点签名/OAuth；U01/U02 管理/格式等余项、U03 行为映射、U04 外部 CDP、U05 external、U06 网络诊断；E01–E04 跨浏览器/平台、实际安装包、新对话和真实认证站点。没有创建新对话/子 Agent、改持久记忆、发布或改 CI/CD。以下记录均按其当时阶段阅读。


## 2026-10-28：W01–W04 写工作流

用户继续授权开发 W01–W04。在 B01 提交 `e9db5f0` 上建立独立 `codex/opencli-write-workflows` 分支，未把新功能追加到 B01 PR #181。通用代码仅在公开仓库修改，原始公开/内部 checkout 未切换或覆盖。

本轮接通 UI v2 控件/事件/自动保存、页面 hidden 字段、DOM click/CDP Enter、精确导航、开放 Shadow/嵌套跨源 frame；CLI 任务多用例/有限序列/实际 ID 传值/部分恢复；多 ID、公开 Header/Location/响应 URL、唯一匹配 UI 网络响应和精确 signed/decimal ID。W03 序列只在探索任务内编排，安装后仍为单工具调用；uncertain 不自动重试或放行安装。

WebCLI 全量 147 文件/1722 项、扩展 360 项、双打包 UI 20 项、最终 frame/导航 6 项、网络结果 7 项、源码和双打包序列各 4 项、完整双打包 HTTP 28 项通过。最后审阅摘要/结果聚焦 2 文件/107 项通过。实现文件、最终补测、打包与保留失败见 [写工作流契约与证据](opencli_write_workflows.md)。范围内状态更新见 [完整台账](opencli_parity.md)。

未发布、未安装到用户客户端、未操作真实账户写，未修改 CI/CD 或内部差异仓库。B02–04、A/U 余项和 E 系列仍开放；下文暂停和 W 系列待办均为历史快照，不能覆盖本节。

## 2026-10-28：四项基线测试失败已处理

接续 B01 提交 `5e3c09b`，按用户要求处理两个 Windows symlink EPERM、上传大小 12/8192 和输出 ENOBUFS。最终修复测试与合成夹具，保留产品校验；上传诊断证明 Node/Chrome 对文本文件有不同视图，未采用会造成 Chrome 误报的句柄大小替代。详情见 [Windows 测试基线修复](webcli_windows_test_baseline.md)。

最新 WebCLI 全量 **147 文件/1708 项全部通过**；聚焦 37 项；源码上传 6u6czT 与 CLI＋Bridge 双打包 d5nsFK 各 4 项通过，包含真实字节和表单接收验证。构建通过，既有三个列映射资源提示保留。下方 B01 验收的“4 个基线失败”为历史结果，已由本节关闭；本机文件视图差异本身未改变。

## 2026-10-28：恢复并完成 B01 frame

用户基于内外 `dev-1.0.2` 恢复并明确要求完成 B01。公开基线 9a01e40，隔离分支 `codex/opencli-frame-resume`；原始公开/内部 checkout 未切换或覆盖。frame 声明、原生读取动作、跨源/hash 导航、有界循环、权限/capability、生成/安装/普通调用/知识/提取修复已接通。最终双打包 GOTyK7 16 项、源码 hash/中断 i2y5rz 10 项、基础 BRBCmv、扩展 353 项、主机聚焦 81 项通过；全量 WebCLI 1699 通过/4 个基线已复现失败。契约见 [frame 工作流](opencli_frame_workflows.md)，完整证据、失败与分发边界见 [上下文审计末节](opencli_workflow_context_audit.md)。

B01 已关闭，其他 W/B02–04/A/U/E 余项保持。未推送/PR/发布/安装，内部差异仓库无需复制通用运行时；内部独立 npm 重打包和实际安装包仍需单独验收。下方历史“暂停”“frame 未接入”记录按其当时快照阅读，不覆盖本节。

## 2026-10-26：探索可靠性与本地客户端验收

PR #170 的首轮 Linux CI：WebCLI 1666 项通过、1 项失败。失败来自 `wecli-shorthand.test.js` 对旧解析器内部字段 `argsJson` 的断言未同步；`call` 当前已将结构化参数合入 `flagArgs`，不再重复传入原始 JSON。修正该断言，并新增真实 Node 子进程覆盖两种 `--args` 写法、参数顺序、JSON 数字及前导零字符串 ID；相关 3 文件 36 项通过。此项在此前聚焦测试之外，完整回归状态以 PR 最新 CI 为准。

随后 Linux CI 的 WebCLI 全量 1668 项通过，Backend 1392 项通过、1 项失败、2 项跳过：失败为完整系统提示词内联快照未同步本次两处 browser.open 说明。逐段核对并更新快照，相关 3 项通过。Windows 本机全量仍有额外失败：WebCLI 两处符号链接 EPERM、一处上传夹具大小差异；Backend 两处 SDK spawn UNKNOWN、一处属性测试超时。上述用例在该轮 Linux CI 通过，不能将本机全量称为通过，也不通过放宽这些断言掩盖差异。

本轮基于公开 `origin/dev-1.0.1` 的 `4ca11071cbf535c6683754500bdc6367f6103e46`，工作分支 `codex/webcli-exploration-reliability`。按内部覆盖方式组装完整开发客户端；通用修改留在公开仓库，内部原工作区及其已有改动保留，内部测试使用独立分支。2026-10-26 已获授权提交 PR 到 `dev-1.0.1`；未发布、未验证正式安装包。目标分支已移除根目录 ROADMAP，本轮持续记录保留在本文。下文 2026-10-18 的交付授权、分支与暂停状态是历史记录，不作为本轮发布授权。

已实现六组改进：参数文件/多行源码传入；显式 WebCLI 路由及 HTTP 页面快照；generate 计划冲突/replan；helper 契约和固定错误诊断；验证覆盖/断言变更提示；运行来源与客户端完整链路验收。具体契约见 [开发设计](api_exploration_cli_design.md#2026-10-26-可靠性增量)。额外修复 HTTP Runner 的普通 flag 数字与 JSON 验证参数差异；CLI 层仍不按业务 schema 转型。

### 真实开发客户端结果

使用本地公开排行榜夹具（`127.0.0.1`，三类榜单和分页，嵌套响应），从单句请求开始，通过普通聊天完成观察、生成、编写 cases、验证、审阅、安装和查询，中途没有人工提供修复命令。Tier4 开启，显式 WebCLI 请求日志为 `explicit-webcli`；未知页面走 `browser.open`。

- 首次流程耗时 601.84 秒，47 次工具调用，其中 7 次标记失败；模型及等待 391.02 秒，执行 210.82 秒。成功不代表全程无错，也不能与其他站点的历史耗时直接作性能比较。
- 首包验证使用 JSON 数字通过，普通 `--page=1` 调用失败，Agent 自行 repair 后安装 1.0.1。此缺陷随后在 HTTP Runner 修正，并分别通过源码和打包 CLI 的真实子进程回归；没有把初次流程重写成修正后的零失败证明。
- 最终只读 HTTP 工具覆盖 rating 第 1 页、votes 第 2 页、hot 默认参数，包含精确 ID/分值断言。安装来源为 user；实际查询前核对版本和包摘要。本例不依赖 Cookie 或业务页面。
- 关闭仅由该测试创建的页面后，新会话自然语言查询 votes 第 2 页：直接一次标准 `webcli call 127.0.0.1.query-rankings --kind=votes --page=2 --size=2`，22.075 秒返回 B/9、D/3；前后浏览器业务标签列表均为空。此为重复使用验收，不是新一轮冷生成。

### 自动化及边界

- WebCLI 探索、生成器、CLI 参数与调用聚焦：22 文件、333 项通过；HTTP Runner 19 项通过（另用打包 CLI 重跑 19 项）。
- Tier4 31 项、Backend 类型检查、HTTP 快照/compound/shadow 13 项通过；内部 31 个包 prepare-build、CLI/Bridge/Backend 打包通过。测试构建使用现有 metrics 测试豁免，无正式指标凭据。
- Windows 验收脚本使用 junction；固定隔离 Bridge 端口与 system 浏览器模式，避免源码入口仍尝试 3711 或普通调用切到另一个 profile。Chrome 137+ 使用显式 `--cdp-extension`，与旧 `--load-extension`/允许列表启动参数互斥。早期扩展连接失败和错误 profile 的失败记录保留，不计为通过。
- 完整 OpenCLI 对齐、macOS、真实业务站点重新生成、正式安装包与正式指标上报不在此次通过范围。断言审阅提示只是启发式检查，不能自动证明业务字段、排序和筛选全部正确。当前运行状态与实际构建内容以本地 `.internal-dev.json` 和本轮报告为准。

最终双打包验收：HTTP 24 项通过（系统临时目录 `webcli-http-discovery-VDTu9g/report.json`）；Chrome 156 后台浏览器 9 项通过（`webcli-browser-acceptance-0yDDBo/report.json`），含无业务页普通 GET/POST、混合页面/后台包、修复不退化、Bridge 重启、缺失 Cookie 与服务端登录过期。复跑入口分别为 `verify-exploration-http.mjs --bundled` 和 `verify-exploration-browser.mjs --background-only --bundled-cli --bundled-bridge --cdp-extension --playwright=<path> --chromium=<path>`。报告可能被系统清理；本轮没有重跑浏览器完整 77 项历史验收。

最终源码已同步并重启本次开发客户端。重启后核对同一 user 包及摘要，普通 CLI 热度榜返回 A/40、B/30，业务标签列表仍为空。开发客户端与本地夹具保留运行供继续检查；更详细的本机路径、包摘要和进程证据在仓库外的验收记录中，不写入公开源码。

2026-10-18 PR 交付授权：用户已明确选择“推送源分支与原始基线，创建 PR 到目标分支”，解除本次交付的历史不推送/不建 PR 限制。仓库为 `WeWorker/WeWorker`，源分支 `codex/api-exploration-cli`，目标 `codex/api-exploration-base`；原始基线保持 `baf9f98`，覆盖截至 `ea61385` 的全部 59 个提交，并附交付记录和一处验收脚本行尾空白清理。交付前工作区干净、基线是源分支祖先，远端尚无这两个分支或对应 PR；不先合并基线、不同步新的 develop/dev-1.1.0、不改变最终发布目标。推送及 PR 的最终状态以 GitHub 为准。下文“未推送/未建 PR”均为当时快照；客户端目标已完成、全面对齐暂停及全部欠账保持。

本次交付检查：完整差异 `git diff --check` 与验收脚本 `node --check` 通过；`node webcli/scripts/verify-output-formats.mjs --python=<已有隔离 Python>` 的真实 CLI/HTTP 与独立 YAML/CSV 解析 **5 组检查通过**，未操作用户浏览器或 Bridge。新增差异和全部功能提交历史已在本地完成常见敏感信息模式检查。没有重跑全仓测试或实站生成，下述各阶段功能证据保持其原验证范围。

2026-10-18 最终状态：**客户端简单查询演示独立目标完成，全面 OpenCLI 对齐仍暂停**。空目录单句由客户端实际生成、验证和安装 GLM 两命令；初包耗时 8 分 14 秒，后续客户端补 ISO 时间并通过四组真实后台 cases。关闭任务页后的聊天重复查询、新聊天发现及最终 Bridge 重启后新聊天查询通过，零 GLM 页、无页面回退。生成包 13 项公开占位审查、持久目录真实调用、静态校验及最终 Skill 4 项（PG3qcw）通过。任务客户端/Vite/隔离 Bridge 已停止、8766 占位释放、默认 source Bridge 与原包/Skill 恢复。见 [目标与证据](client_webcli_demo_goal.md) 及 [演示步骤](client_webcli_demo_runbook.md)；早期失败、时间修复和跨环境欠账保留，不承诺每次零修正。当前分支接入 a620191、诊断修复 4aac662、准备守卫 9ab8bea，最终文档检查点以 Git 为准；未 push/PR。

2026-10-18 准备命令校验续进：客户端空安装目录的生成仍错误声明后台准备，已停止且未安装。后台预览现拒绝显式 storage 刷新，不再静默改成缓存读取后假通过；共享 Skill 前置正确顺序。聚焦 49 项、Chromium 1217 CLI＋Bridge 双打包后台 9 项（4NkByV）通过。客户端最终生成、无页/后续聊天/重连验收及环境恢复尚未完成，以 client_webcli_demo_goal.md 为当前目标；全面对齐保持暂停。

2026-10-18 客户端实测续进：网络 all 列表→detail 的误过期已修复，扩展 11 项和双打包浏览器专项 3 项通过，用户重载后真实客户端可读额度详情。随后客户端错误使用 helper 返回结构，补共享 Skill 准确契约；后台预览新增固定公开错误分类，任意异常 code/message/details 仍脱敏。聚焦 45 项、helper 11 项、最终双打包后台 8 项（rKCQlS）通过，随包 Skill 4 项（WirM2W）通过。真实客户端仍未安装成功，不能标为完成；等待新扩展重载后继续验证，最终还须恢复隔离验收环境。全面对齐继续暂停。

2026-10-18 客户端目标正在实施：普通聊天已接入共享 WebCLI Skill/命令，旧聊天探索工具移除，独立旧探索页面保留；真实客户端从空 Adapter 目录开始生成中，尚未验收完成。实测暴露模型凭据误用与桌面开发包 HTTP 校验资源路径问题，已分别前置通用凭据/服务规则、修正 CLI/Bridge 对 prepared extension 的定位并回归。以 [客户端目标](client_webcli_demo_goal.md) 的最新记录为准；下面“待新对话启动”为历史检查点。全面对齐仍暂停，欠账不变。

2026-10-18 最新优先级：用户将另开对话启动 [客户端聊天复用 WebCLI 的活动演示目标](client_webcli_demo_goal.md)。本对话原全面对齐目标继续 paused，不覆盖、不标为完成。bf3b22d 是已验证功能检查点；当前暂停点适合先做简单查询演示接入。客户端默认探索路由与共享 Skill/版本衔接尚需实现和实测，不能把下述 CLI 成功称为客户端已通过。已知 frame 实验超时、1194 兼容及其他欠账见新目标和完整台账，本轮未展开实现。

2026-10-18 最新专项已完成：按用户要求删除旧 GLM 页面版生成物，重新通过 WebCLI 探索、准备上下文、生成并安装后台版 1.0.2。用户授权重启已核实的 Bridge、重载扩展及关闭两个用量页；全部 GLM 标签关闭时 4 组真实验证、4 次普通调用与 Bridge 重启后 4 次查询通过，零新页。纯用户包卸载后重新探索及 legacy 回退防护已修复，WebCLI 1465 项通过。详细证据、失败与限制见本文末尾及 [GLM 验证](glm_quota_adapter_validation.md)。全面对齐目标继续 paused，未推送/PR，不展开下一阶段。

> 更新日期：2026-10-18。本阶段已完成，按用户最新要求暂停整体目标，未全部对齐。hash/有界控制 d0e8ea9、跨源 841a412、导航竞态修复 f2f54d8；夹具隔离 a4052b3/c26226a。最终 Chromium 1217 CLI＋Bridge 完整双打包 **109 项** 9ccf6Q、**6291 文件/28 私有绑定**隐私、连续 **102 次**跨源调用、组合 **12 项**通过。frame 基础 1c4d8a9 未接入，替换后解析探针超时仍待修；完整剩余范围及最终检查点说明见末尾。
> 下文第 2～3 节保留初始历史快照；以最新状态和追加日志为准。

## 新会话从这里接手

- 用户最新明确要求本阶段收尾后暂停，覆盖此前“阶段通过后继续”的执行安排。跨源回归、证据、文档和本地检查点已收尾，在此暂停；恢复依据后续明确指令，不得把保存的 frame 基础当作已完成。

- 范围澄清：用户明确不需要 OpenCLI 桌面客户端。只对齐 CLI、浏览器扩展与相关工具能力；WeWorker API 探索 UI/内置聊天/profile 选择界面单列产品集成，不作为 CLI 对齐完成条件。多步 UI 指目标网站操作，CDP/Electron 指 CLI 控制外部目标，不是开发桌面客户端。
- 继续当前分支 `codex/api-exploration-cli`，本次持续目标起点 `6420583`；检查点 SHA 见 Git 最新提交。先核对工作区/日志，不重建分支或重复实现 profile/HTTP Runner/宿主探索/参数化详情导航/声明式只读 workflow/单请求 HTTP 写验证/声明式 Extension 幂等写。根 AGENTS.md、ROADMAP.md、本文末尾、[开发设计](api_exploration_cli_design.md)、[HTTP 契约](http_adapter_runtime.md)、[写命令契约](api_exploration_write.md) 和 [能力台账](opencli_parity.md) 为接手入口。
- 已完成多浏览器 profile，使用 `webcli call profile.list` 和 `--profile=<contextId|alias>`；唯一在线可自动选择，显式/default 离线不回退。旧 browser/exploration 根通过 `--profile=legacy` 只读访问，新 profile 不继承旧 tabId。桌面尚无 profile 选择 UI，多连接时需 CLI 保存默认或由调用方显式传路由。
- 已完成并验证：profile、独立 HTTP Runner/环境鉴权/分区 Cookie、无浏览器 JSON OpenAPI 发现、路径导航/只读 workflow、HTTP/PAGE_FETCH/原生 UI 单写、实际字符串/整数 ID、UI 新回执 ID、有界效果 GET、三类写 repair、共享文件全包修复和有证据知识修订。默认 validate 不写，历史授权/执行/实际 ID 不继承，派发前持久消费、取消/重启/丢响应不重放、uncertain 只读恢复不能安装均保持。queryParameters、独立 hash、有界循环/分支及显式跨源主文档实现已接通，各阶段最终证据见末尾。尚余 frame 工作流、更广 UI 写、多步写/多组 fixture、更多结果 ID、API 文档/认证及生态与验收差距，逐项以 opencli_parity.md 的 W/B/A/U/E 表为准，不把阶段验收当作完整对齐。
- WebCLI + 插件继续面向任意能执行 CLI 的 Agent，调用方处理自然语言，不依赖桌面或第二模型 Key。Python 网站探索agent源码、环境、测试、生命周期和数据全程不动。
- 集成基线 `baf9f98`，已纳入 develop `4c3d5bd` / dev-1.1.0 `dae8932`；本轮没有 fetch/merge/push/PR。后续同步按第 4 节“上游 → 集成基线 → 功能分支”，这些 SHA 仅是已纳入快照。
- 当前用户已重载最新工作区 extension-dist，GLM 专项已确认 background_preview_v1；已授权重启的工作区 Bridge 由本任务启动，具体 PID 必须现场核对，不沿用历史值。以下为旧阶段记录：HTTP 与鉴权阶段仅重建资源，在隔离浏览器实测，没有重载日常 Chrome 或重启用户 Bridge；使用新 Cookie scope 能力前需核对 `http_credentials_v2` 并重载已安装扩展/本工作区 Bridge。AUTH 普通调用读 CLI 环境；预览/COOKIE/桌面调用读相应 HTTP 宿主环境，不自动转发 CLI 环境、不加载 .env。真实外部目标仍为 B 站 Excel 搜索页，重新 doctor/tabs/bind；不要照抄历史身份/PID。历史 source Bridge 快照 PID 47386、日志 `/tmp/weworker-profile-live-bridge.log`，本阶段未重新核实，重启前必须检查完整命令和归属。
- 前序响应 ID 阶段报告：源码 HTTP `webcli-http-discovery-4keDzj/report.json`（15 项）、源码页面写 `webcli-browser-acceptance-eD9wSZ/report.json`（10 项）、最终打包 CLI＋Bridge HTTP `webcli-http-discovery-SbvPth/report.json`（15 项）、最终打包页面写 `webcli-browser-acceptance-QAwCGG/report.json`（10 项）；均位于系统临时根。完整 Chromium 与版本覆盖边界见末尾，1194 旧兼容问题仍保留。报告可能被清理，缺失时按脚本复跑；日常 Chrome/Bridge/B 站和外部真实账户写请求未操作。

## 最新状态

- #106、#91 已合入 develop，merge SHA 分别为 `14846149bfcb94829af767743fedcf577e595322`、`4c3d5bd784c3a4f178c45b027bc37bf672d75aca`，无需再单独合入。
- `codex/api-exploration-base` 从 develop `4c3d5bd` 建立；初始文档已保存为 `2d177bc`，本轮整合 dev-1.1.0 `dae8932`。
- 本次使用原工作目录，无新 worktree。切换时 ROADMAP.md 阻止 checkout，具名 stash 保存两份文档后切换并 apply，保留双方路线图。stash 仍保留作备份。
- 功能分支在集成提交后创建为 `codex/api-exploration-cli`，最终操作结果见文末。未推送或创建 PR，最终发布目标仍待明确。
- [开发设计](api_exploration_cli_design.md) 为本次审阅入口。
- [OpenCLI 能力对齐台账](opencli_parity.md) 为最新范围与缺口清单；用户要求尽力对齐完整能力，不能把当前 36 个 browser 命令或单站点验收视为目标完成。
- 首版功能实现提交为 `821a7df`，最新功能为 HTTP 单请求写命令定向修复，复用已有类型/账本/GET 轮询（本轮起点 `35cd7f8`），检查点 SHA 见 Git 日志。集成基线仍为 `baf9f98`，已纳入 develop `4c3d5bd` / dev-1.1.0 `dae8932`。这些是已纳入快照，后续同步前应重新 fetch，不能据此推断远端未变化。
> 后续每次建分支、同步上游、解决冲突、实现功能或验证后，都应更新本文和 ROADMAP.md。未验证事项不得标为完成。

## 1. 目标与范围

将现有界面入口的 API 自动探索能力开放为 WebCLI 命令，支持自然语言驱动调用，后续让界面复用同一套能力。

- 独立探索使用 `webcli call exploration.<command>`；安装后的业务工具使用 `webcli call <adapter-id>.<tool-id>`。
- 调用方 Agent 理解自然语言、选取证据并编写代码；WebCLI Bridge 负责确定性任务、验证与安装，不要求桌面 Backend 或额外模型 Key。
- 已实现启动、状态、事件、证据、补采、安全探测、取消、恢复、草稿读写、生成、验证、审阅和安装。
- 自然语言层负责理解目标、补齐必要参数及编排命令；CLI 提供稳定、可验证的结构化结果和错误。
- 后续 WeWorker API 探索界面通过薄适配层复用同一 Bridge 契约，单列产品集成，不作为 CLI 对齐完成条件；不开发 OpenCLI 桌面客户端。Python 网站探索agent完全排除在本任务外。
- 用户不负责 `dev-1.1.0` 上其他特性；同步时保留其行为，不顺手重构或改写他人的功能。

现有参考：[API 探索可靠性计划](api_exploration_reliability_plan.md)、[本地验收](api_exploration_local_acceptance.md)。这些文档是历史设计与验证记录，不代表本次 CLI 已实现或验收。

## 2. 已核实的起点

2026-10-17 已执行 `git fetch origin` 并检查远端分支和开放 PR。以下为当时快照；接手时必须重新查询。

| 来源 | 当时 HEAD | 用途与状态 |
| --- | --- | --- |
| `origin/develop` | `05e34e9a7cc1b78b1b62c8e7aa0725ca4042f419` | 用户指定的主发布分支；已有 API 探索优化 #85 |
| `origin/dev-1.1.0` | `dae89328a9f36f4fa0014701a602101da7c4ad34` | 新版本特性，包括聊天、模型设置、记忆等 |
| `origin/fix/webcli-ci-debts` | `0bf6a0390c990bc8e168e4400f99511497de20c6` | [PR #106](https://github.com/WeWorker/WeWorker/pull/106)，目标 develop，未合入 |
| `origin/chore/remove-legacy-extension-adapters` | `f688d5f2a8cb21c43ab8fb22738f1392eb8d8ded` | [PR #91](https://github.com/WeWorker/WeWorker/pull/91)，目标 develop，未合入；是否纳入待明确 |

- 起始工作分支为 `fix/webcli-ci-debts`；写本文之前工作区干净。
- `develop...dev-1.1.0` 按提交历史统计为左侧 42、右侧 67 个独有提交；这不是独有功能数量，也不排除等价补丁。
- 两者共同祖先为 `dd0d4ad3ab6c3cdb780a8eb18489e70bb5e39547`。
- #106 不包含 #91，不能只合入 #106 就认为已纳入旧管线清理。
- 尚未试合并，冲突范围、集成测试结果均未知。

## 3. 分支与 PR 策略

拟采用以下结构，分支名均为计划值，不能当作已存在分支：

```text
origin/develop
  └─ codex/api-exploration-base       只放依赖整合、冲突修复和基线记录
       ← origin/dev-1.1.0
       ← PR #106（若届时尚未合入 develop）
       ← PR #91（仅在明确纳入后）
       └─ codex/api-exploration-cli   CLI 探索功能与测试
```

功能 PR 初期以集成基线为目标，避免将全部新版本特性混入功能审查。最终发布目标尚未确定；不能直接改目标到 develop 并默认发布全部 dev-1.1.0 特性。

仓库的 [Git 工作流](GIT_WORKFLOW.md) 描述 main/GitHub Flow；本文记录用户本次明确指定的 develop/dev-1.1.0 集成场景，不修改全仓工作流。集成分支保留 merge 历史便于追踪来源，正式 PR 的合并方式仍按维护者规则执行。

### 建分支步骤（尚未执行）

1. 阅读根 AGENTS.md、ROADMAP.md 和改动目录的 AGENTS.md；重新确认工作区、已有 worktree、分支及 PR 状态。
2. 保存本文：目前它在起始工作区中，未提交文件不会自动进入新 worktree。建分支后将本文及对应路线图条目迁入集成基线，只提交本任务文档，不夹带到 #106。
3. 使用独立 worktree 从最新 develop 建集成分支；已有同名分支时先检查，不覆盖。

```bash
git status --short --branch
git worktree list
git fetch origin
gh pr list --state open --json number,title,headRefName,baseRefName,url
git worktree add ../WeWorker-api-exploration -b codex/api-exploration-base origin/develop
cd ../WeWorker-api-exploration
git merge --no-ff origin/dev-1.1.0
```

4. 完成当前合并和核验后，再合入仍未被 develop 包含的 #106。若 PR 已 squash 合入，检查 PR 状态与实际补丁，不因原分支不是祖先而重复合入。

```bash
git merge --no-ff origin/fix/webcli-ci-debts
```

5. #91 是否纳入需先明确。它涉及删除旧管线；执行前遵循 AGENTS.md 对删除文件的单独确认要求。CI/CD、发布、数据库 schema 等受保护范围也不能因“整合”而视为已授权修改。
6. 每次合并都记录来源 SHA、合并前后 SHA、冲突处理及验证。完成集成基线验证后，从基线建立功能分支：

```bash
git switch -c codex/api-exploration-cli
```

推送、PR 创建、最终目标分支以及分支保护情况，执行后填写日志；本文不表示这些动作已完成。

## 4. 后续如何同步 dev-1.1.0

统一路径为：**上游 → 集成基线 → 功能分支**。不要有时把上游直接合入功能分支、有时只更新基线，造成基线审查范围失真。

1. 确认工作区干净，记录当前 HEAD，执行 fetch；从日志取出“上次成功纳入的 dev-1.1.0 SHA”。不能用本文件最初快照代替后续记录。
2. 检查上次 SHA 是否仍为新上游祖先；若不是，说明可能发生历史改写，先检查原因，不能直接批量 cherry-pick 或强制同步。
3. 读取新增提交与文件差异，识别和探索、CLI、任务路由、配置、构建相关的交叉影响。纯属其他负责人的功能也需确认能与当前代码共存。

以下命令的 `LAST_DEV_SHA` 需替换为日志中的实际提交，不可原样运行：

```bash
git merge-base --is-ancestor LAST_DEV_SHA origin/dev-1.1.0
git log --oneline LAST_DEV_SHA..origin/dev-1.1.0
git diff --stat LAST_DEV_SHA origin/dev-1.1.0
git diff --name-only LAST_DEV_SHA origin/dev-1.1.0
```

4. 在基线所在 worktree 切换至 `codex/api-exploration-base`，合入 `origin/dev-1.1.0`。若 develop 也有更新，单独整合并记录，不将两个来源当作一次无法区分的修改。
5. 基线验证通过后，在功能分支所在 worktree 执行 `git merge --no-ff codex/api-exploration-base`，解决 CLI 改造与新基线的冲突，并重跑受影响测试。分支已被另一个 worktree 使用时，去该 worktree 操作，不强制重复检出。
6. 将上游 SHA、两层合并 SHA、验证结果填入日志。失败时标为“已合并、验证未通过”，不要推进“最后成功验证基线”。

### 冲突处理规则

- 不整文件套用 ours/theirs；按业务含义保留双方必要行为。特别检查聊天路由、模型配置、探索入口、Adapter 清单、构建 profile 和版本信息。
- 他人特性的语义不清楚时，记录具体文件和冲突点，请对应负责人澄清；不自行降级或移除功能。
- ROADMAP.md 保留双方有效记录；lockfile 由对应包管理器按最终依赖生成并验证。
- 不为合并通过而跳过测试、放宽权限或关闭校验。涉及项目要求单独确认的文件删除、CI/CD、发布、schema、凭据与回滚操作，先取得单独确认。
- 不强推共享基线，不擅自 reset/rebase 已共享历史。每次同步保留来源信息以便追查。

### 依赖 PR 合入或目标分支变化

- 普通 merge 合入：核对祖先关系和 diff 后同步目标分支。
- squash/rebase 合入：原提交 SHA 不一定在目标历史中；同时核对 PR merged 状态、补丁和最终文件，避免再次引入同一改动。
- 最终准备向 develop 或 dev-1.1.0 提交时，先检查 `git diff <目标>...<功能分支>`。若仍包含他人的整批特性，不直接改 PR base。
- 必要时从最终目标建立新的交付分支，仅迁入本任务功能提交并重新验证；依赖冲突修复也要审查。保留原集成分支作为追踪依据，不擅自回滚或删除。

## 5. 实施与验证清单

- [x] 核对当前远端分支及开放 PR。
- [x] 建立跟进文档与路线图入口。
- [x] #91 已随 develop 纳入；最终发布目标仍待明确。
- [x] 建集成基线，迁入跟进文档，整合依赖并记录冲突。
- [ ] 完成基线测试，区分既有失败与新引入失败。
- [ ] 建功能分支，梳理现有界面探索调用链与服务边界。
- [ ] 确定命令契约、任务状态、结构化输出、错误与取消/恢复语义。
- [ ] 实现 CLI 与自然语言入口，补齐聚焦自动化测试。
- [ ] 验证 CLI 与现有界面共享能力；界面迁移范围单独记录。
- [ ] 按项目规范完成受影响模块测试、构建、类型/语法检查及本地敏感信息检查。
- [ ] 真实探索验收与最终 PR；未运行的平台和场景明确列出。

脚本、Electron、Backend 逻辑必须有聚焦自动化测试；Renderer 改动需对应单测、构建和语法检查。若涉及 Adapter 注册/权限、profile 或调用路径，还需验证配置生成、打包入口与实际调用一致。自然语言成功一次不代替状态、失败、取消及权限边界验证。

## 6. 操作日志与当前交接点

| 日期 | 操作 | 结果与验证 | 下一步 |
| --- | --- | --- | --- |
| 2026-10-17 | fetch，读取规范/路线图，核对分支历史和开放 PR | 已确认第 2 节快照；未合并、未跑代码测试 | 明确集成范围 |
| 2026-10-17 | 创建本文并更新路线图 | 仅文档变更；分支仍为 fix/webcli-ci-debts，文档尚未提交 | 建基线时迁入文档，避免提交到 #106 |

以上为初始记录。最新整合来源为 dev-1.1.0 `dae8932`；聚焦验证通过，完整基线仍有下列缺口，不能标记全量验证成功。

后续每次操作追加以下字段，不覆盖旧日志：

```text
日期与执行者：
目的 / 当前分支：
操作前 HEAD：
来源分支与 SHA / 关联 PR：
执行动作 / 操作后 HEAD：
冲突文件、处理理由、他人特性保留情况：
验证命令与结果 / 既有失败 / 未验证范围：
文档及路线图提交 SHA（提交后补记）：
最后成功验证基线 / 最后成功纳入上游 SHA：
待办、阻塞、下一步：
```

新会话或其他 agent 接手时，先读本文、AGENTS.md 和 ROADMAP.md，再核对实际 git status、worktree、远端分支与 PR。日志中的“计划”不能作为执行证据；如实际状态与日志不符，先补齐事实，再继续开发。

### 2026-10-17：建立分支与设计

- 7 文件冲突：CHANGELOG.md/ROADMAP.md 保留双方记录；Python 进程管理最初手工整合，用户随后明确排除该模块；最终该冲突文件保留 dev-1.1.0 原文件，不保留本次手工修改；官网 lockfile 的名称/版本对齐 package.json；WebCLI 保留独立 1.0.4；探索页保留 auto 入口，去除依赖已不存在 agentMode 状态的旧开关；状态栏保留告警浮层和专属 Agent 汇总，去除旧入口的失效变量。
- 自动合并保留 dev 聊天、记忆、模型、专属 Agent 能力及 develop 的 #91/#106。未另行修改 workflow、发布脚本或 schema。
- renderer/backend 按 lockfile 执行 npm ci --ignore-scripts，未新增依赖、未改变 lockfile。
- 通过：公开配置检查；Renderer 探索/告警 11 项、专属 Agent 9 项；Extension 路由 23 项、导航守卫 17 项；Electron 生命周期/关闭守卫 11 项；Backend 探索/聊天 23 项，共 94 项。Renderer 构建通过，有 chunk/动态导入提示；Bridge/扩展 JS 与 Python AST 语法通过。
- 未通过：Backend typecheck 缺 yauzl 声明及相关隐式 any；相关源码、package.json/lockfile 与 dev 无差异，未顺手修改他人模块。Python 测试因缺 uv 未运行。未跑全量、真实浏览器/模型或安装包。合并差异检查有 dev 原有 settings-theme.css 末尾空行提示。
- 首轮 Renderer 缺 vite、Backend 依赖不齐，安装后重跑；初次 Backend 测试命令重复 --run，修正后 23 项通过。
- OpenCLI 参考为本机 1.8.6 help 与本地 usage/adapter-author 技能；未操作真实浏览器或执行站点命令，不表示核实远端最新源码。
- 下一步：审阅设计，明确类型检查缺口的处理归属。Python 模块由其他负责人维护，本任务不改造、不补测；该模块整合验收交由负责人。

- 用户追加边界：Python 网站探索agent全程不属于本任务。仅保留来源分支内容，禁止为 CLI 工作调整其模型、生命周期、存储、HTTP 接口或测试。进程管理冲突选择 dev 原文件，因此不宣称保留 develop 在该文件的超时改动；后续由对应负责人判断。

### 本轮最终交接点

- 集成提交：`baf9f98`（父提交为文档提交 `2d177bc` 与 dev-1.1.0 `dae8932`），基线分支 `codex/api-exploration-base`。
- 已从该提交建立并切换到 `codex/api-exploration-cli`；功能代码尚未开始，开发设计待用户审阅。
- develop `4c3d5bd` 与 dev-1.1.0 `dae8932` 均已纳入历史；后续同步用这两个 SHA 起算，不再合入 #106/#91 分支。
- 最后成功完成聚焦验证的集成提交为 `baf9f98`；全量验证仍未完成，限制见上。最终 Python 冲突文件与 dev 原文件一致，先前手工合并版本的 AST 检查不视为最终 Python 验证。
- 未推送、未创建 PR。后续同步继续采用“上游 → api-exploration-base → api-exploration-cli”，Python 模块若再次冲突，交对应负责人处理，不在本功能开发中改造。


### 2026-10-17：独立 Agent 模式首版

- 用户明确纠正：WebCLI + 插件必须独立运行，Codex/Claude 等外部 Agent 负责推理。旧设计的桌面宿主前置条件已撤销，开发设计全文更新。
- 新增 exploration 命令服务、JSON 客户端、结构证据模块和命令帮助；集成现有 Bridge，新增 API 探索 Skill 并纳入 npm files/skills 包。无新依赖、无 lockfile 变更。
- 已实现 start/list/get/events/evidence/collect/actions/probe/cancel/generate/draft-read/draft-write/validate/review/install；独立任务保存在 profile workspace 中。默认不调用模型、不读 Backend 配置。
- 复用 v2 草稿、验证、增量包与安装器；补充 prepareGenerationRun 的可选 paths 注入和 runtime validator 两阶段间的取消检查。
- 当前只生成同源成功只读 GET，最多两个命令；POST/写操作/跨源/动态 ID 路径不自动生成。API 探索 UI 与旧聊天工具迁移属于后续，不触及 Python 网站探索agent。
- 本轮 Python 目录差异必须为零（相对本轮起点 af8e082），不执行该模块测试或环境安装。
- 上下文管理：用户授权必要时创建新会话接手；优先在当前会话持续工作并及时记录。若新建，传递本文件、设计文档、当前分支/HEAD、验证结果、未完成项；不能把新建成功当作后续开发完成。


### 首版验证与接手步骤

- 最终 WebCLI 全量：97 文件、1055 项通过（npm test --prefix webcli）。新增独立服务/协议 2 文件 14 项，覆盖真实 WebSocket 交互、独立 CLI 帮助进程和生成 JavaScript 在模拟浏览器中的执行及安装。没有调用真实模型。
- 构建：WebCLI 与 Bridge bundle 通过，打包 CLI 显示全部 18 个命令，Skill 已复制。主目录缺 esbuild 的首次构建失败，随后用已有 backend-ts/node_modules 经 NODE_PATH 提供该依赖构建成功，未改 package/lockfile 依赖。
- npm pack --dry-run（执行 prepack）通过，569 个文件；确认四个新增模块及 webcli-api-exploration Skill 在清单中。未发布 npm 包。打包仍提示已有可选列映射资源缺失。
- 公开配置、JS 语法与 git diff --check 通过。相对 af8e082，Python 目录差异为零。
- 测试波动：与构建同时运行时旧 generation-output-recovery 用例未及时进入预期状态；单文件复跑通过，再完整顺序运行全量 1055 项通过。不据此认定其根因已经解决。
- 没有验收真实 Chrome、登录站点、Codex/Claude 实际对话、各平台安装包。本轮未改 Renderer/Backend 业务源码，也未处理先前 Backend yauzl 类型问题。
- 下一位 Agent：先查看当前 HEAD 和工作区；运行 `node webcli/index.js call exploration.help`，阅读产品内 Skill。下一步优先准备独立 WebCLI + 插件的真实验收，不能重启/占用未知 Bridge 或改动用户登录数据。之后再设计 API 探索 UI 适配；不把 Python 网站探索agent纳入任务。
- 最后测试日志位于本机临时目录，不作为需提交的材料；以上验证摘要为可交接记录。代码提交 SHA 可从下一条 feat(exploration) 提交查得，未推送、未开 PR。

### 2026-10-17：自主真实浏览器全流程验收

- 操作前 HEAD：`821a7df`，功能分支 `codex/api-exploration-cli`。用户明确要求开发后自主验证全流程。本轮未合入新上游提交。
- 修复与可复跑验收脚本提交：`c56f951`。该提交为本轮最后成功验证的代码基线，后续提交仅同步本文、设计和 ROADMAP。
- 发现本机 3711 已由全局安装的 WebCLI 服务占用，保留其运行。测试临时复制本分支 WebCLI 和已准备的 public 扩展，将副本内的 Bridge/CLI/插件连接端口替换为独立端口，CLI PID/log 目录也指向临时根；生产默认端口、配置和扩展协议未改。
- 独立启动 headless Chrome for Testing 147.0.7727.15（本机 Playwright 缓存 revision 1217）、unpacked 插件、Node Bridge、loopback HTTP 示例站点。使用独立 user Adapter、data、builtin、浏览器 profile；不加载用户登录信息，不需要桌面 Backend 或模型配置，不操作 Python 网站探索agent。
- 第一轮真实验证发现：脚手架 `check-login-status` 工具被共享策略标记为跳过，导致目标查询已执行成功（attempted=1/passed=1）仍因 skipped=1 被独立流程阻止安装。此前模拟扩展的测试没有复现真实跳过计数。
- 修复：独立服务调用共享 preview validator 时启用 `restrictToExpectedTools`，只把明确的生成目标送入执行策略；保留每个目标必须实际执行、零跳过的要求。共享验证器默认关闭该选项，旧 UI/Backend 行为不变。测试同步按真实 testCases 计算 skipped，并覆盖开关两种行为。
- 新增 `webcli/scripts/verify-exploration-browser.mjs` 和仓库命令 `npm run test:exploration:browser --prefix webcli`。全部 15 个验收检查通过，命令均为实际 CLI 子进程：
  - 连接、标签选择、幂等 start、安全搜索 probe、collect、结构证据与值省略。
  - draft-read/write，陈旧 hash 拒绝；故意写入语法错误并用 CLI 修复，补充分页默认参数。
  - 真实 API 返回 503 时运行验证失败且无法 review；恢复后真实预览 attempted=1/passed=1/skipped=0/failed=0。
  - 无确认/陈旧 reviewId 拒绝；当前 review 安装到隔离根；普通 webcli call 搜索和分页返回示例数据，空结果及 HTTP 错误正确返回。
  - 同站点再次生成保留第一次 Agent 修改的代码，新增工具独立验证并升级安装，新旧普通命令都能调用。
  - cancel 后真实浏览器迟到采集结果被丢弃；重启自建 Bridge 后 installed/cancelled 状态保留，在途任务变 interrupted，相同 requestId 不重复创建，显式 collect 后恢复并能再次调用安装工具。
- Playwright 只负责启动隔离浏览器、加载插件和打开示例页面；没有模拟浏览器网络、扩展协议、预览验证或安装器。临时产物包含报告、证据、草稿、验证摘要与 Bridge 日志，均未提交；脚本退出会关闭自己创建的进程，临时目录保留供诊断。
- 全量回归：`npm test --prefix webcli -- --testTimeout=20000`，97 文件、1056 项通过。WebCLI/Bridge bundle、打包 CLI 18 命令帮助、npm pack dry-run（四个探索模块与 Skill 均在包内）、公开配置、语法和差异检查通过。两项构建继续使用现有 Backend 的 esbuild（`NODE_PATH`），没有新增依赖或变更 lockfile；仍有已有可选列映射资源缺失提示。
- 验收脚本首次启动时，外部 Playwright 默认查找的 revision 1234 不在本机；通过 `--chromium` 选用已安装的 Chromium 后成功。此环境差异不作为产品问题。没有下载浏览器或替换用户全局 WebCLI。
- Python 源码目录相对本功能起点 `af8e082` 差异为零，未运行该模块测试。未验证真实登录业务站点、各平台安装包，也没有另开 Claude/Codex 会话做生成质量验收；本次不宣称通用 Agent 的任意任务成功率。

复跑前先完成仓库 public profile prepare，确保 `weworker/build/extension-dist` 存在，并准备 Playwright 与支持 unpacked 扩展的 Chromium。依赖可由外部工具环境提供，不必加到生产依赖。示例路径是占位值：

```bash
npm run test:exploration:browser --prefix webcli -- \
  --playwright=/absolute/path/to/playwright/index.mjs \
  --chromium=/absolute/path/to/chromium
```

若本地已有可导入的 Playwright 和匹配的浏览器，上述两个参数可以省略。脚本输出临时产物路径，`report.json` 中 `passed: true` 才代表完整通过。

下一位 Agent 先核对分支和最新提交，再阅读当前设计与产品 Skill。上游同步仍按“上游 → codex/api-exploration-base → codex/api-exploration-cli”；新 dev 改动不要直接覆盖功能分支，Python 冲突交对应负责人。本轮真实浏览器缺口已补上，下一步可选真实登录站点/独立 Agent 验收或 API 探索 UI 接入。未推送、未创建 PR。

### 2026-10-17：OpenCLI 对齐第一轮与真实站点验收

- 操作前 HEAD `a5e04d2`，分支仍为 `codex/api-exploration-cli`，没有新增上游合并。完整目标记录在 `docs/opencli_parity.md`；当前结果只是已完成的一批能力，目标保持进行中。
- 本轮代码与首版台账提交：`6eff37f`。提交时工作区干净；未推送。后续改动从该提交起算，不重复创建分支或重新合并已纳入上游。
- 用户已安装当前工作区 public 扩展并指定公共视频搜索页验收。本轮核实原全局 Bridge 的 PID/启动命令后切换为本分支 source Bridge；后续只重启本轮自己启动的已确认进程。扩展从 `weworker/build/extension-dist` 构建并通过既有协议重载。未访问/终止未知 8766 进程，未修改 Python 模块。
- 34 个 browser.* 命令与独立 Skill：持久命名会话、owned/bound 标签管理、doctor；CSS/role/name/text/ref 定位和陈旧/歧义错误；表单与键盘；主 frame 原生指针/拖拽、文件输入；网络摘要/过滤/有界 JSON 详情；frames、eval、完整截图、console、dialog、wait。Bridge 日志只记浏览器命令元数据，不记脚本、参数或输入值。
- 会话用 Chrome storage.session 身份防止 tabId 回收误操作；浏览器重启或扩展重载后身份可能过期，需要重新选择并绑定。用户绑定页 close 不关闭标签，open/back 不导航该页。browser 与探索采集/验证共享 tab 锁；取消不提前释放尚未完成的浏览器请求，dialog 可解除正在执行命令等待的弹窗。
- start 增加 allowedOrigins 精确授权，额外域不从流量自动取得。大响应在截断预览前生成类型结构，修复真实站点超过 4KB 响应丢失列表形状问题。
- Agent 计划支持 1–50 读取工具（默认自动计划仍最多两个 GET）；支持 JSON/form POST 和显式 GraphQL query，POST 必须有 readReason。mutation、subscription、未解析持久查询及已识别业务写信号不进入读取生成。GraphQL 文档/变量值不写入证据。
- 新增 draft-add 创作 helper/command/guidance 文件和 trace 结构诊断；现有文件仍走 expectedHash 修改。草稿改变使验证和审阅失效，同站点保留命令不重写、不执行。
- 真实站点：捕获搜索分页接口并确定 PAGE_FETCH 策略，最小 keyword/page 请求返回成功，不复制 Cookie 或捕获签名。通过 draft-write 编写参数与结果映射，新命令以 explored 前缀避开内置搜索命令；静态检查及真实预览均通过，再按用户全流程验收授权本地增量安装。两页相同关键词和一页不同关键词三次普通 CLI 调用各返回 20 条，页码正确、ID 集合变化，标题/作者/链接/播放量/时长类型检查通过；后续 source Bridge/扩展更新后普通调用复验仍通过。真实页面内容、响应样本、会话 ID 和捕获值未提交。
- 实际运行本地安装位于既有用户 profile；无内置源码改动，无业务写操作。下一次可通过 exploration.list/get/trace 找到任务，不把本地安装视为公开内置 Adapter 交付。
- 隔离真实 Chromium 147 + 插件 + CLI/Bridge 验收从 15 项扩展为 17 项：浏览器命令组、三工具 JSON/form/GraphQL 生成及真实验证/安装/调用、helper 新增/trace，以及原有错误修复、增量保留、取消/重启恢复均通过。临时完整报告保持本机，不提交。
- 验收发现并修复弹窗期间再次 Page.enable 会阻塞的问题；测试禁用 Playwright 自动关闭弹窗，由产品 CLI 处理。最终测试没有模拟 CDP、网络或验证器。
- 验证：WebCLI 全量 98 文件/1069 项通过；Extension 聚焦 5 文件/42 项通过；WebCLI/Bridge bundle、公开配置、git diff --check 通过；npm pack dry-run 577 文件，新浏览器模块、tab 锁、extension 实现和 browser Skill 均在包中。无新增依赖/lockfile 变化。已有可选列映射资源缺失提示未处理。
- 剩余工作：完整策略生成（DOM/UI/INTERCEPT 等）、动态路径、写工具语义与验证、fixtures/站点知识/安装后修复、复杂 frame/Shadow DOM/多连接、下载/持续网络流、外部 CLI/Electron/CDP、UI 统一和独立 Codex/Claude 新会话验收。不能宣称全面对齐或任意站点可靠性。
- 接手先核对 git status/HEAD、本文及能力台账。source Bridge 可用 browser.doctor 读状态，未知进程不可直接复用/终止。同步上游仍走“上游 → api-exploration-base → api-exploration-cli”，本轮没有改变同步基线。Python 相对 `af8e082` 差异为零；未推送、未创建 PR。

### 2026-10-17：精确验证与站点知识

- 操作前 HEAD `3bdc4a5`；分支及上游同步基线未变。
- 新增 verification-read/write：每工具 1–10 组显式参数和精确输出路径、类型、非空、格式、值、行数断言；旧插件缺 strict_output_contract_v1 时拒绝，避免静默忽略。参数禁止凭据字段，错误只返回 caseId/path/code，不含响应值。草稿或 cases 改动后重新验证。
- 修复扩展单次只运行前五组的限制，共享 validator 分批发送并聚合全部结果。真实六组验证中第六组故意失败能阻止安装，修正后六组全部通过。
- 新增 knowledge-read/save，保存已验证命令的 cases、选中端点的结构证据、字段含义和备注；私有文件、hash 防覆盖，按 30 天及当前安装包摘要标记过期，每条记录保留独立验证时间。字段冲突拒绝而不覆盖，修订机制待做。旧记录是历史数据，不是 Agent 指令。
- 真实验收发现 Adapter 目录刷新重载页面会打断刚安装后的普通调用（Frame removed）。刷新与 managed page 调用改为同一 per-tab 队列，不重放业务 handler；增加顺序、失败释放、跨页独立回归。
- 验证：WebCLI 全量 100 文件/1077 项通过；后续能力守卫与日志修改聚焦 3 文件/20 项通过；扩展两组共 60 项通过；隔离真实 Chromium 全流程 19 项通过。CLI/Bridge 构建、公开配置、差异检查通过。npm pack dry-run 580 文件，含两个新增模块和探索 Skill；无新依赖或 lockfile 变化。
- Python 相对 `af8e082` 差异为零。真实用户 Chrome 仍运行上一阶段 source Bridge/插件，当前新 cases/knowledge 能力已在隔离真实浏览器验证；使用用户页前需核实自建服务身份并更新扩展。不可把隔离验收写成用户 Chrome 新能力已验证。
- 下一步：已安装命令的定向修复，确保未选中的命令与共享文件保持原样，再补其他策略。完整 OpenCLI 对齐仍进行中；未推送、未开 PR。

### 2026-10-17：已安装命令修复与真实站点精确验收

- 上一阶段提交 `6ebf7f9`，包含精确验证、站点知识及刷新队列；本轮从该提交继续。上游整合 SHA 与同步流程未变。
- 新增 repair-info/repair，先读取当前包摘要，再用当前采集的成功只读证据绑定已有命令 ID，复制到隔离草稿。服务保存修复 scope，任务证据不能自行扩大范围；静态、运行、发布检查都核对当前基线。
- 允许修改所选命令的独占模块、schema/description；其他文件、共享代码、命令元数据、路由、权限、命令次序保持原样。不能新增 helper，不能删除命令；写命令与混合 Toolkit 包暂不支持。默认增量生成仍保留全部原文件，无修复 scope 时不会放宽。
- 从站点知识带入作者 cases，显示过期原因。每个目标至少一组，重新实际执行；草稿/用例变化后重新验证和审阅。Agent 根据 Skill 最多修复三轮，仍由调用 Agent 理解和编辑，没有额外模型调用。
- 自动化：WebCLI 全量 100 文件/1080 项通过；后续 nextActions/状态赋值调整及 Skill 更新聚焦 2 文件/20 项通过。CLI/Bridge 构建、公开配置、JS 语法和差异检查通过；npm pack dry-run 581 文件，含 exploration-repair.js 和新版 Skill。首次 pack 在仓库根运行未找到 package.json，切到 webcli 后成功；无依赖/lockfile 变化。
- 隔离真实 Chromium 全流程 20 项通过：实际将示例接口 name 字段改成 title，导入的六组旧 cases 全部失败并阻止安装；通过 draft-write 修复映射后六组全部通过，审阅安装后普通命令及四个已有查询均通过；其他模块字节一致。还包含原有取消/Bridge 重启、POST/GraphQL、页面操作、知识与精确断言验收。
- 用户 Chrome：确认先前自建 source Bridge 身份后重启为当前源码，通过既有协议重载工作区扩展，strict_output_contract_v1 已就绪；仅重新绑定本任务的公共搜索页。新建维护任务，采集当前搜索请求并建立 repair 草稿。
- 真实站点精确验证发现：第一页接口混入课程类型，bvid 为空，旧“只检查 string 类型”验收没有识别。三组 cases 中第一页 BV 格式失败，其他两组通过。局部修复本地生成命令为只返回 type=video，课程等类型计入 excludedTypes；视频缺有效 BV 时明确报错，total/pages 的接口总量语义写入命令说明。
- 修复后静态和真实三组 cases 全通过；按已有全流程授权审阅本地安装，无新增权限，其他内置命令和共享文件未改。普通调用第一页 17 个视频/排除 3 个课程，第二页和另一关键词各 20 个视频；ID 有效、分页/关键词结果不同。站点知识保存三组 cases、字段含义和混排说明，读取 stale=false。仅保存于本地用户 profile，未将生成包、响应、账号或会话信息加入仓库。
- 本轮 source Bridge 和工作区扩展已更新；下次先用 browser.doctor / exploration.list 查询当前状态，不在文档固定 PID、taskId 或 tabId。维护页面绑定会话为本任务所有；重载扩展后仍应验证身份并重新选择页面。不要关闭用户标签页。
- Python 相对 `af8e082` 差异为零；没有触及 Python 环境、测试、生命周期或用户持久目录。未推送、未开 PR。
- 接手下一步：纯 DOM/UI/INTERCEPT 策略、动态路径与请求签名、知识冲突修订，之后完善 UI 共用服务及跨 Agent 独立对话验收。完整 OpenCLI 对齐目标仍 active；本轮只完成安装后只读命令维护这一项，不代表全部对齐。
- 本轮功能及验收提交 `411fe85`，工作区提交时干净；该提交是当前最近成功验证的代码基线。打包 CLI 帮助确认 26 个探索命令，包含两个修复入口；后续 checkpoint 提交仅更新此记录。未推送、未创建 PR。

### 2026-10-17：页面来源策略、准确路由与定向修复

- 操作前 HEAD `a722880`，分支仍为 `codex/api-exploration-cli`。develop/dev-1.1.0 集成基线未变；本轮没有同步上游，不要重复合并历史 PR。
- 新增 exploration.observe，支持 UI_SELECTOR 的行/字段/属性/空态与 DOM_STATE 的 window 自有属性或 JSON script。固定 MAIN world 读取函数，观察只返回结构，生成普通命令通过 page_read helper 读取；不把页面来源伪装成 API。页面来源使用独立指纹绑定计划，每个工具必须写作者 cases。纯页面/混合 API 计划、增量保留、修复与知识都接入同一服务。
- helper 检查 origin/pathname、必需字段的唯一性/可见性；输入/脚本/样式不能当普通文本字段，文本优先使用渲染结果。DOM 缺行时要求可见空态标记，截断显式返回；状态 getter/原型/存储/凭据字段拒绝，超限报错。没有新依赖或 manifest 权限。
- 真实测试首次发现网络记录器也记录 HTML document，“零网络候选”假设不成立，验收调整为“无 JSON API 候选”。随后预览 3/3 通过但普通命令失败，捕获错误 PAGE_SOURCE_ROUTE_CHANGED，确认旧路由只按 host 选中了首页。新增可选 pageRoute，包校验、生成与实际调度统一检查准确 origin/pathname；唯一匹配页优先，多页时只选唯一活动页，缺失/歧义不自动新开或导航。Bridge 增加 page_sources_v1 协商守卫，避免旧扩展忽略新路由。
- 隔离真实 Chromium 全流程现 22 项通过：无 JSON API 示例页的 DOM、页面状态、JSON script 观察→生成→严格验证→安装→普通调用；缺字段失败、明确空态成功；服务器实际更换 DOM 类名后，历史 case 失败，定向修复选择器再验证/安装成功，其他页面命令仍可执行；关闭本任务页面后普通调用返回路由缺失。还覆盖既有 API/POST/GraphQL、六组断言、字段漂移修复、取消和 Bridge 重启恢复。
- 此轮新增保存页面知识后，原测试“重启应标记安装包已变”断言过时；按最后已验证并保存的新摘要修正为 stale=false，同时检查四条页面来源跨重启保留。测试未绕过实际 CLI、插件、网络或验证器。
- 用户 Chrome：核实自建 source Bridge 身份后更新进程、重载已安装的工作区扩展，page_sources_v1 可用。重选指定公共搜索页并重新绑定，不关闭用户页。观察可见普通视频卡片，生成本地 `bilibili.com.explored-visible-videos`，写标题/链接/数量/未截断断言；真实预览通过、审阅无新增权限后本地增量安装。普通调用返回 27 张已渲染卡片，标题/原始链接与当前 DOM 逐项一致。它读取当前页面，不能解释为完整搜索结果或唯一视频数；查询串与页码不由此命令控制。
- 已有 `bilibili.com.explored-search-videos` 回归三组：excel 第一页 17 个视频并排除 3 个课程，第二页及 spreadsheet 第一页各 20 个视频，BV 格式和结果变化检查通过。新页面来源/case/语义说明保存于本地知识，stale=false。生成包、标题、响应与会话标识没有写入仓库。
- 最终自动化：WebCLI 101 文件/1086 项通过；Extension page-source/tool-route/output-validator/refresh-queue 共 40 项通过。构建 prepare 与全量测试曾同时执行导致既有 generation-orchestrator 两例失败；停止并行修改构建资产，构建完成后顺序重跑全部通过。后续必须将 prepare/build/pack 与依赖其资产的测试串行执行。
- CLI/Bridge bundle、打包 CLI 的 observe 帮助、公开配置、21 个修改/新增 JS 文件语法、git diff --check 通过。npm pack dry-run 583 文件，含 exploration-page.js、扩展 page-source.js 和新 Skill；预打包日志写在 JSON 前，解析报告时需跳过 prepare 日志。公开配置脚本位于仓库根 scripts/check-public-config.mjs，不在 weworker/scripts。已有可选列映射资源缺失提示未改。
- source Bridge/用户扩展已具备本轮页面能力；后续仍先用 doctor、tabs、list 查询当前状态，不假定旧 PID/tabId。Chrome 重载后身份可能失效，应重新选择绑定；不要终止未知进程。Python 相对功能起点 `af8e082` 差异为零，未碰其环境、测试、生命周期或持久数据。未推送、未开 PR。
- 下一步仍是完整 OpenCLI 对齐：INTERCEPT/策略回退、动态路径/CSRF/签名、写命令语义与验证、多步 UI/复杂 frame/Shadow DOM、多连接、下载/网络流、知识修订、UI 共用服务及独立 Codex/Claude 新对话验收。当前页面策略是阶段成果，目标保持 active；不要把这一批测试通过当作全部目标完成。

### 2026-10-17：API 动态路径参数

- 上一阶段代码与记录已提交为 `7e1e899`，本轮从该干净检查点继续。上轮属于有效进展；本轮目标保留完整 OpenCLI 对齐，优先补 API 详情地址中的动态路径。分支和上游整合基线未变。
- 新增 generation-harness/path-parameters.js，plan.pathParameters 使用 segmentIndex/name/description，索引按 pathname 去掉开头 `/` 后分段计数。每个脱敏 :id 必须绑定，也允许显式参数化已观察的 slug；名称与 query/body 键不能冲突，须填写 readReason。只有动态端点又未提供 plan 时返回 PATH_PLAN_REQUIRED，默认自动计划不猜路径参数。
- shared plan binding 将元数据附在所选 candidate 副本上，生成命令内联解析函数，不修改共享 runtime 文件。schema 将路径参数声明为必填字符串，无捕获值默认参数；保留前导零、按单段编码，拒绝斜杠、百分号、控制字符和 dot traversal。路径参数不会进入 query/body；已观察 query 键回到 URL，其余参数继续作为查询或请求体。静态路径、已有包及其他命令保留机制不变。
- 每个动态命令至少两组不同路径参数组合；不要求每个参数都变化，避免只有一个授权父对象时无法测试两个子对象。作者应通过返回 ID/字段精确 equals 确认效果，不能只检查非空。知识中的命令新增 pathParameters，trace 也提供映射。repair 计划和验证使用相同约束；不把历史用例当当前成功证据。
- 自动化：新增完整/重复/冲突路径绑定、编码/前导零、路径与 query/body 分离、非法值拦截回归；服务验证生成 schema、无捕获 ID、缺失/重复验证组合拒绝及知识保存。全量 102 文件/1090 项通过；8 个修改/新增 JS 文件语法与 git diff --check 通过。
- 隔离真实 Chromium 全流程 23 项通过。在既有实例上用实际 browser.eval 触发 GET 和 JSON POST 详情请求，collect 得到两个动态结构端点，显式计划生成两个命令；四组不同 ID、前导零、中文及 ?/# 的精确输出断言通过。安装后四次普通 CLI 调用返回对应 ID/query/body；检查实际服务器请求，路径参数没有被重复发送。`../delete` 返回 INVALID_PATH_PARAMETER，服务器请求计数不变。
- 首次新增验收复用了已由生命周期测试释放的 browser session，按实际状态重新 bind 后继续。随后非法参数虽然阻止了请求，但抛错经旧调用链缺少统一 ok 字段；生成命令改为返回 `{ok:false,error:{code,message}}`，完整重跑通过。没有把错误改成空结果或忽略断言。
- CLI/Bridge 构建、公开配置通过；npm pack dry-run 584 文件，包含新的 generation-harness/path-parameters.js 和更新 Skill。构建/pack 与依赖生成资产的测试顺序执行；已有可选列映射资源警告不变，无依赖/lockfile 变化。
- 真实用户 Chrome 的 B 站 API/DOM 验收仍以上一阶段为证据；本轮动态路径使用隔离 loopback 公开占位站点，没有在 B 站虚构不存在的动态详情接口。用户 source Bridge 仍运行上一阶段已确认进程，新能力在隔离实例和构建产物验证；下一次需要新功能时先核实进程身份再更新。扩展代码本轮无变化，不需用户重装。
- Python 相对 `af8e082` 差异为零，未碰其环境/生命周期/测试/数据；未推送、未创建 PR。下一步仍包括 INTERCEPT、CSRF/签名、写命令、动态页面路由/多步 UI、知识修订、多连接/复杂浏览器能力、UI 共用服务及独立 Agent 验收；完整目标继续 active。


### 2026-10-17：INTERCEPT 与真实 Chrome 原生输入修复

- 从 `a75fec3` 接续未提交实现；分支仍 `codex/api-exploration-cli`，develop `4c3d5bd` / dev-1.1.0 `dae8932` 集成基线未变。本轮没有同步上游，不重复合并 #106/#91。完整 OpenCLI 对齐目标保持 active。
- 新增 exploration.intercept：选取实际观察到的成功只读 JSON GET/POST，声明搜索、原生 select 筛选或下一页 CSS 控件；搜索/筛选声明一个字符串参数，通过已观察 query/body 字段关联。后台监听在操作前注册，只接受本次开始的新 Fetch/XHR，准确 origin/pathname/method/参数；旧请求、不相关响应不能充当成功。单次最多两个匹配请求后报歧义，响应 JSON 有大小/复杂度上限，凭据字段脱敏，业务行不静默截断。借用 CDP 后只清理自己的 listener，支持超时/HTTP/非 JSON/路由/文档变化等明确错误。
- 观察不保存 values；页面证据、计划、草稿、知识共用已有流程。生成命令 pageStrategy=INTERCEPT，pageRoute 精确匹配现有页面；有参数时至少两组不同参数的作者 cases。插件能力不满足时拒绝调用，避免旧版本忽略 helper。
- 解决草稿跨域权限：预览 scoped chrome.runtime.sendMessage 添加临时 token，SW 只为 intercept_read 解析此 token 的草稿 manifest 授权；绑定 tab、主 frame、origin/pathname、5 分钟有效期，finally 清理。预览仅在明确 INTERCEPT manifest 下容许同一 document 更新查询串，完整文档替换不受支持。普通调用按声明的 match 找唯一已安装包，支持包名与页面子域名不同，多个包不合并权限。
- 自动化新增源归一化/禁止写候选与凭据关联、参数不落观察记录、不同 cases 必填、旧插件拒绝、临时授权隔离与过期、旧响应忽略/多响应/错误/清理测试。共享 Extension 测试 loader 缺少早前 browser observation/body evidence 导入，本次补齐真实函数后原网络捕获测试恢复通过；未屏蔽断言。
- WebCLI 全量 103 文件/1094 项通过；Extension 聚焦共 63 项通过。CLI/Bridge 构建、公开配置、npm pack dry-run 586 文件通过，包含两个 intercept 模块。首次测试命令错误重复 --run，修正后执行成功；服务单测 mock 原仅报告 1 项，新增 2 组 cases 后按真实期望改为 2 项。无新增依赖，构建与依赖资产的测试顺序执行。
- 隔离真实 Chromium 24 项：页面闭包生成一次性示例请求头，直接重放 403；跨源（127.0.0.1 页面→localhost API）GET/JSON POST 四组不同参数预览成功，增量安装后两命令普通调用成功；超时/重复/503/非法空参数明确失败。既有 API、路径参数、DOM、修复、知识、取消和 Bridge 重启流程保持通过。真实请求、插件、CLI 和验证器均参与，未替换为 mock。整页导航守卫追加验证结果见本节最后记录。
- 用户 Chrome：先核实既有自建 source Bridge 命令后重启为本分支，重载用户已安装的工作区 extension-dist，能力 intercept_read_v1 就绪。重选并重新绑定 B 站搜索页，没有关闭用户标签。浏览器技能按工作区开发目标使用源码，未安装 npm 替代源码。
- 真实问题：后台标签页 `Input.dispatchMouseEvent` 返回成功但事件未到按钮；增加 Page.bringToFront 到原生 click/dblclick/hover/drag/keys 与 INTERCEPT，真实页确认事件开始执行。聚焦测试断言先激活再发原生输入，激活失败不继续；隔离完整验收重新通过。
- B 站现场确认首页综合查询用 search/all/v2、翻页用 search/type。第一次错误选择首页端点导致 INTERCEPT_TIMEOUT，未复用旧响应；重新选择实际翻页端点后成功。关键词搜索会整页导航，所以本轮只生成当前页面“下一页”命令，未宣称已支持整页导航搜索。
- 新本地命令 `bilibili.com.explored-next-videos`：结构观察→Agent 编写普通视频过滤/BV格式/业务错误判断→作者 case→真实预览页 3→4→审阅无新增权限→本地增量安装→普通调用页 4→5。最后返回 35 视频、排除 7 非视频，返回页码与 URL 一致。该命令不接受任意页码，语义依赖当前关键词和页码；历史验证 case 重跑前需恢复约定页码。页面恢复为 excel 第一页。
- 已有 API 三组回归通过：excel 第 1 页 17 视频，第 2 页 20，spreadsheet 第 1 页 20；已有 DOM 命令读取当时 25 张已渲染卡片。新来源/作者 cases/字段说明/导航限制写入本地站点知识，stale=false。首次 knowledge-save 的 notes 误传数组被正常拒绝，改为文档规定字符串后成功。真实响应、生成包与用户会话标识均未加入仓库。
- 当前 source Bridge/用户插件具备 INTERCEPT；下次仍先 doctor/tabs/list 检查，不使用历史 PID/tabId。完整导航错误守卫最终已重载到用户插件。Python 相对 `af8e082` 差异为零，未运行其测试或触及环境/生命周期/数据；未推送或开 PR。
- 下一步：策略选择/回退与支持整页导航的 UI 查询，多步 UI、动态页面路径、写命令、知识冲突修订、复杂 frame/Shadow、多连接/下载、UI 共用服务、独立 Agent 对话和 OpenCLI 最新版本对照。当前只完成单步 INTERCEPT，不应将这批测试通过标为完整目标完成。

- 最终验证：新增整页导航（pathname 相同）真实 fixture，任务必须返回 INTERCEPT_DOCUMENT_CHANGED；最终隔离 Chromium 24 项全部通过，报告位于系统临时目录 `webcli-browser-acceptance-mDwIZ7/report.json`（不提交）。最终 Extension 核心 13 项再次通过；完整聚焦集合此前 63 项通过。用户插件重载最新代码后，普通下一页调用再次验证第 1→2 页，返回 38 视频/排除 4 非视频，随后恢复 excel 第一页。WebCLI 全量 1094 项结果仍对应当前 WebCLI 逻辑；最终变更仅扩展导航守卫及文档/测试，相关测试已覆盖。19 个修改/新增 JS 文件语法、git diff --check 通过；最终 npm pack dry-run 586 文件。此阶段将提交为一个本地检查点，未推送、未开 PR。

### 2026-10-17：跨文档页面查询与探索刷新竞争修复

- 从已提交检查点 `123cd43` 接续，仍在 `codex/api-exploration-cli`。develop `4c3d5bd`、dev-1.1.0 `dae8932` 和集成基线 `baf9f98` 未变，本轮没有同步上游；后续仍按本文“上游→集成基线→功能分支”处理，不重复合并已纳入 #106/#91。完整 OpenCLI 对齐目标继续 active。
- 新增 exploration.query，独立模块 exploration-query.js / extension/background/page-query.js，能力 page_query_v1。来源为 UI_SELECTOR mode=query，复用搜索/原生筛选/下一页触发语义，声明 result UI_SELECTOR/DOM_STATE、同源固定 resultPathname 和公开 URL 参数关联；观察只保存结构，不保存输入值。参数命令必须有两组不同值作者 cases。
- 后台监听主 frame 导航，单次触发后等待 URL、加载完成、数据稳定。整页导航允许同样结果；SPA 必须有数据变化，不能把旧列表当新证据。子 frame history 不算主页面变化；输入/select 同步导航导致上下文消失时仅在已观察到导航后继续，不重放动作。超时/跨源/缺字段明确失败。
- 生成 handler 首次返回声明式 __webcli_page_query，后台执行后重新注入，再经独立第二参数续接 page_query_result；不把续接放进业务参数。普通调用和预览都限定读命令及一次续接，写命令/重复标记拒绝。manifest pageWorkflow=true、pageRoute.additionalPaths 允许起始页和固定结果页；临时预览 registry/grant 在导航后重建并更新路由，finally 清理。
- 整体真实回归最初在原 INTERCEPT 首次观察失败，单独抽取却通过。初始 loaderId 假设不足以解释，保留失败记录继续定位。为隔离副本临时记录 chrome.tabs.reload 调用栈与导航时间，确认 refreshAdapterTabs 在查询响应返回后、静默完成前重载该页；源自异步 Adapter 目录刷新。最终修复将探索观察/INTERCEPT/query/采集/探测/回放、预览验证、已有页 browser 操作纳入 managed runtime 页面队列；dialog 绕过等待以解除弹窗。没有降低文档变化守卫、重试业务动作或增加固定延时掩盖问题。临时 reload 插桩已从验收脚本移除，只保留失败时的隔离 fixture 导航诊断。
- 自动化：WebCLI 全量 104 文件/1100 项；Extension page-query/intercept/page-source/refresh/preview/route/helper/browser 聚焦 58 项通过。涵盖路由拒绝、续接不重放、两个不同 cases、参数不落持久记录、旧插件拒绝、SPA 旧数据/子 frame 导航拒绝，以及探索/刷新队列与弹窗解锁。
- 隔离真实 Chromium 25 项通过。新增无 JSON API 的 GET 表单从 /query-start 跳转 /query-results：观察、两组精确标题 cases、安装与两次普通调用通过；fixture 的 sessionStorage 提交记录精确等于五个作者关键词，证明没有重复执行查询。其余 API/路径参数/DOM/INTERCEPT/修复/知识/取消/重启恢复继续通过。第一轮成功报告为系统临时目录 webcli-browser-acceptance-hGKtGS/report.json；去掉诊断插桩后的复验结果追加于本节末尾。
- 用户 Chrome：核实本任务 source Bridge 进程完整命令后更新为当前源码；重载已经安装的工作区 extension-dist，doctor 确认 page_query_v1。重新选择并绑定用户指定搜索页；没有关闭用户标签页。当前 source Bridge/插件已包含本轮功能，下次先 doctor/tabs/list 查询，不能假定历史 PID/tabId。
- B 站生成本地 bilibili.com.explored-ui-search-videos：观察实际 input.search-input-el、button.search-button 和普通视频卡片来源；新增实际 URL/输入框关键词校验与规范化链接。excel/spreadsheet 两组真实预览通过，审阅无新增权限后增量安装。普通调用分别返回 24/27 张卡片，标题/链接与当前页面逐项完全一致，结果随关键词变化。它仅返回当前已渲染普通视频卡片，不代表站点总量。
- 真实回归：原 API 三组返回 17/20/20 个视频，DOM 24 张，下一页从 1→2 返回 38 视频；新旧命令均能使用。发现 B 站点击相同关键词搜索不会发起新导航，第 2 页同词调用返回 PAGE_QUERY_TIMEOUT，未误报成功；这是本次查询对新导航/数据的明确要求，不能把同词调用解释为重置页码。随后切换 spreadsheet 再 excel，核实已恢复 excel 第 1 页。新来源、cases、字段与该限制存入本地知识，stale=false；未提交真实返回内容或本地生成包。
- CLI/Bridge 构建、公开配置和 npm pack dry-run 588 文件通过，含两个 query 模块和更新 Skill；无依赖/lockfile 变化。构建/prepare/pack 与依赖资产的测试顺序执行。已有可选列映射资源缺失警告未改。Python 相对 af8e082 无差异，未触碰其环境、测试、生命周期或持久数据；未推送、未开 PR。
- 接手下一步：策略选择/失败后明确回退；通用 CSRF/签名、动态页面路由和多步 UI；写命令语义与验证；知识冲突修订和共享文件修复；复杂 frame/Shadow/profile/连接/下载；UI 和内部聊天共享服务；独立 Codex/Claude 对话及平台分发验收；OpenCLI 1.8.8 实际差异审计。不要把当前单次查询闭环当成全部 OpenCLI 能力完成。

- 最终复验：去掉 reload 诊断插桩后，隔离 Chromium 25 项再次全部通过，报告在系统临时目录 webcli-browser-acceptance-fQAFMd/report.json。最终 WebCLI 104 文件/1100 项、Extension 聚焦 58 项通过；23 个修改/新增 JS 文件语法与 git diff --check 通过。当前代码和交接记录将作为本地检查点提交，完整对齐目标仍进行中。

### 2026-10-17：来源分析、显式重做计划与 OpenCLI 1.8.8 核查

- 从 `b2b7a32` 继续，分支仍为 `codex/api-exploration-cli`。本轮未 fetch/合并上游，已纳入的 develop/dev-1.1.0/集成基线 SHA 不变；后续仍按“上游→集成基线→功能分支”同步。完整 OpenCLI 对齐目标保持 active。
- 新增 exploration.analyze：根据已存响应字段结构、HTTP 状态、读取语义和路径提示分类，给出选中策略、来源契约、理由缺失与失败后建议。仅分析不请求、不自动切换，不从浏览器流量推断公开 API。API 生成明确 PAGE_FETCH；PUBLIC_API/COOKIE_API 标签拒绝，独立 host HTTP runner 未实现。成功但无 JSON 结构的候选不生成 JSON 工具；仅模糊 JSON/已有页面替代来源时要求显式 plan。
- strategyNote 包含 reason/alternatives/limitations，PAGE_FETCH/INTERCEPT 若提供 note 必须解释替代来源；旧计划可省略以兼容，但 analyze 标记 needsRationale，Skill 要求 Agent 提供判断。策略理由进入 trace 与站点知识。鉴权错误先恢复访问；字段/HTTP 错误先诊断。活动、终结和 scoped repair 任务不会被建议执行不可用的 replan。
- 新增 replan/revisions/revision-read。按当前 draftHash 保留原目录、计划、结构证据、作者 cases 和验证失败，再清空当前草稿/验证/review/cases。摘要包含原始文件字节、计划和 cases，支持损坏 manifest 留档、拒绝并发旧 hash；外部改写旧文件返回 REVISION_CHANGED。每任务最多 20 份，达到上限不破坏当前草稿；Agent 最多三轮尝试规则不变。禁止活动、已安装、取消及 scoped repair 任务重做计划。原安装包不被修改，重新生成/验证/审阅后才可安装。
- 独立 passive capture/collect 增加 includeTelemetry 显式选项，将非静态 JSON 噪声交给 analyze 分类；默认业务过滤及 UI 行为不变。增加 source analysis、历史文件/20 次边界、cases hash、旧 review 撤销、错误策略标签、模糊/非 JSON 数据、终结/活动建议等测试。旧协议测试的文本断言同步此前页面队列实现，没有更改协议以适配测试。
- 最终 WebCLI 全量 105 文件/1116 项、Extension 聚焦 53 项通过；CLI/Bridge 构建、公开配置、10 个修改/新增 JS 文件语法、git diff --check 通过。npm pack dry-run 590 文件，含 analysis/revisions 模块与 Skill；打包后的 CLI 帮助含四个新命令。无新增依赖/lockfile 变化，已有可选列映射资源警告未改。构建/pack 与依赖生成资源的测试顺序执行。
- 隔离真实 Chromium 26 项通过，报告在系统临时目录 `webcli-browser-acceptance-O0TETr/report.json`。新流程：采集业务 JSON/telemetry→analyze→API 草稿→实际服务器 503→验证失败→分析且请求计数不变→replan 留档→观察 DOM→新草稿与作者精确断言→验证/安装/普通调用→知识保存。Bridge 重启后旧 manifest 字节、失败结果仍可读；既有流程全部继续通过。
- 首次完整验收失败于缺少新 API 证据。独立诊断确认示例页未消费 no-store fetch 响应体，没有完成的 CDP 正文记录；fixture 改为消费 JSON 后捕获成功。随后发现旧采集过滤器提前排除 telemetry，增加上述显式开关才可验收分类。没有把失败当成功、删除断言或对生产请求增加自动重放。
- 用户 Chrome：先核实本任务自建 source Bridge 完整命令，再更新源码进程并重载用户已装的工作区 extension-dist；doctor 就绪，重选并绑定 B 站搜索页。首次捕获是导航/推荐/广告等八个请求，没有搜索列表；调用既有 API 搜索 excel 后 collect 补采第九个搜索端点。分析的 likely_data 仅说明字段结构，不能据此把广告等来源当目标。
- 真实站点策略切换是目标选择，不是虚构 API 失效：API 普通调用正常返回 17 视频，先生成比较草稿留档，再为“当前已渲染普通视频卡片”观察 DOM。生成新本地 `bilibili.com.explored-current-video-links`，作者补齐规范化 URL/关键词、精确字段和格式断言；预览通过，审阅无新增权限后增量安装。原工具/共享代码通过保留机制继续存在；未执行任何业务写操作。
- 普通调用返回 24 张可见卡片，标题/链接逐项等于当前页面。首次核对脚本读到另外 12 张隐藏卡片，现场检查它们 getClientRects 为零；按命令既定的可见范围修正核对脚本后通过，生产读取未修改。旧 DOM 命令同样返回 24 张；页面保持 excel 第一页。新来源、cases、选择理由和限制已保存本地知识，stale=false。真实响应和生成包只在本地，不提交仓库。
- 最终 source Bridge 已重启加载最后的分析建议修正，doctor 就绪；已安装任务 analyze 返回只读 trace 建议，API 旧 revision/源码与 DOM 当前策略均可读取，普通新命令再调用仍返回 24 张卡片。下次先 doctor/tabs/sessions 重新确认，不能复用历史 PID/tabId；只管理明确属于本任务的进程。扩展无需用户重新安装。
- 新增 `docs/opencli_1_8_8_audit.md`，读取官方 npm tarball 的 manifest/help/技能/分析代码，没有全局升级用户 OpenCLI，也没有复制上游业务代码。发布包有 1366 个命令、179 个 site 分组（包含桌面应用），这些静态数量不代表本项目覆盖或上游实机验证。详细差距已更新能力台账。
- Python 网站探索agent相对功能起点 `af8e082` 差异为零，未触碰其环境、测试、生命周期和数据。未推送、未开 PR；本阶段作为本地检查点提交，提交 SHA 以 Git 日志为准。
- 接手下一步：优先补浏览器 frame eval/观测、下载与流式输出/profile 等差距；设计符合 Extension/Toolkit 边界的 PUBLIC_API/COOKIE_API 执行及凭据契约。仍需动态页面路由/多步 UI/写命令、知识冲突修订和共享文件修复、UI/内置聊天复用、独立 Codex/Claude 新对话与各平台分发验收。当前明确 replan 不等于自动运行时回退，不应关闭完整对齐目标。

### 2026-10-17：跨 frame 执行、文档身份与超时

- 上轮 `9d5a5f0` 是有效进展，本轮从干净工作区继续；分支仍 `codex/api-exploration-cli`，未 fetch/合并/推送，上游已纳入快照与集成基线不变。完整 OpenCLI 对齐目标继续 active。
- 核对 OpenCLI 1.8.8 的 browser.frames / eval --frame 契约后补齐相应能力，但保留 WebCLI 的 Chrome frameId，不改为数组索引。新增 browser_frames_v1；frames 返回 documentId，eval 支持 frameId/documentId，state/find/get/输入/等待支持文档校验。旧插件拒绝新参数，不允许静默落到主页面。
- 新模块 browser-frames.js 维护按 tab+调试子会话区分的执行上下文，递归启用 iframe 子目标，不暂停新页面；主页面既有网络/预览缓存忽略子会话事件，防止数值 context/request ID 冲突。子目标 detach 清理其后代，根 detach 清理全表；不修改扩展 manifest/权限或引入依赖。
- 选择 frame/document 先执行无副作用身份探测，配对不符时用户脚本/页面操作不会派发。临时标记放在扩展隔离环境，用 Chrome 提供的 frame 身份选择唯一 MAIN 上下文，执行前清除，finally 按原 documentId 清理；用户代码绑定 uniqueContextId，只执行一次，不按 URL 猜测、不使用可能复用的数值 contextId。相同 URL 的多个 frame 能分别返回各自 window.name。收尾审查将初版 MAIN 探测改为隔离探测，最终测试页故意重写 Object.getOwnPropertyDescriptor，确认不会调用该页面钩子来选择目标。
- 显式错误包括 FRAME_UNAVAILABLE、FRAME_DOCUMENT_CHANGED、FRAME_CONTEXT_UNAVAILABLE、EVALUATION_FAILED、FRAME_EVALUATION_INTERRUPTED 和不可序列化结果。30 秒截止既约束 CDP 同步执行，也覆盖 awaitPromise 永不结束；不终止共享页面，超时表示结果不确定，不能自动重放。旧的不带 frame 参数主页面 eval 保持原路径。页面读取结果附 frameId/documentId，原生输入仅传坐标，避免将身份元数据误送 CDP 指针方法。
- 自动化：WebCLI 全量 105 文件/1117 项通过，Extension 最终聚焦 52 项通过；额外新增 null/数组等非法 frame 参数断言后，相关 8 项再次通过。覆盖主/子 session 相同 context ID、错误文档配对零用户代码执行、导航中断一次派发、递归子会话清理、超时释放、旧插件拒绝及原生输入。共享 SW 测试 loader 注册新增模块，未降低既有断言。
- 隔离真实 Chromium 完整 27 项通过，报告为系统临时目录 `webcli-browser-acceptance-3xI6nH/report.json`。新增两个同 URL 的跨源 frame，各有返回另一 origin 的嵌套 frame；严格 CSP 下执行 Promise、分别读取/填写/点击、主页面未误执行、错误配对和导航后旧文档拒绝。原 API/POST/路径参数/DOM/INTERCEPT/页面导航/修复安装/历史/重启流程全通过。
- 完整通过后补了页面结果身份字段和 Promise 截止分支；最终 `--browser-only` 聚焦复验通过，报告为 `webcli-browser-acceptance-8P8Ep4/report.json`，包含 Promise.reject、真实永不结束 Promise 等待 30 秒后明确错误且后续主页面调用可用。该参数只在通用浏览器验证后提前结束，默认仍执行全部流程。最初测试脚本因局部变量 stale 与后文重复声明未启动，改名后执行；未把语法失败当实测。
- 日常 Chrome：核实本任务 source Bridge 完整命令后更新并重载工作区 extension-dist；doctor 声明新能力，重新绑定 B 站搜索页。明确 frameId/documentId 的 Promise 执行返回 excel 第一页；已有 current-video-links 普通调用仍返回 24 张卡片。只对用户目标的主文档执行，没有检查无关嵌入页面的数据。
- 日常 Chrome 另开本任务拥有的 loopback 公开示例页，五个 frame（主页面、两个同 URL 跨源子页面、两个嵌套跨源页面）逐一 eval 返回正确名字，均带当前 documentId，严格 CSP 生效。完成后通过 browser.close 关闭自建标签。临时服务器已停止监听但一个 Chrome 预连接使进程未退出，检查本任务会话与连接后用原 exec 句柄 Ctrl-C 清理；未停止其他服务，用户 B 站标签保留。
- 当前源码 Bridge/用户插件已加载本轮能力；最后非法参数加固只需扩展重载，已执行。下次仍先 doctor/tabs/sessions 选择页面，不复用历史 PID、tabId 或 documentId。真实运行结果仅在本机临时文件，不进入仓库。
- 子 frame click/hover 仍使用 DOM 事件；原生子 frame 指针、Shadow DOM、AX/state 比较、截图标注/尺寸、download 等待与流式输出、多 profile/连接仍待补。exploration 的生成页面来源仍只支持主 frame，不能由通用 eval 可用推断已支持 frame 内生成。后续还包括 PUBLIC_API/COOKIE_API runner、动态页面/多步 UI/写命令、UI 共享与独立 Agent 验收。
- Python 网站探索agent相对 `af8e082` 差异为零，未触碰其源码、环境、测试、生命周期或数据。未推送、未创建 PR，本轮保存本地检查点；最终构建/pack 记录追加如下。

- 最终复验：隔离标记加固后，8 项相关单测、52 项扩展聚焦及 WebCLI 105 文件/1117 项通过；浏览器聚焦通过后再次跑完整 27 项，报告 `webcli-browser-acceptance-pVDWcQ/report.json`，包括全部旧流程、30 秒不结束 Promise、页面重写内置函数和 frame 导航拒绝。日常 Chrome 同样重载最终代码，以五 frame CSP 示例再次确认页面 hook 未被调用，随后 B 站恢复绑定，主文档检查为 excel 第一页，原命令返回 24 卡片。最终临时服务器用 closeAllConnections 正常退出，无遗留测试服务或标签。
- CLI/Bridge 构建与公开配置通过；最终 npm pack dry-run 591 文件，包含 extension/background/browser-frames.js 和更新 Skill。10 个修改/新增 JS 文件语法、差异格式、增量凭据/私网地址检查通过；打包帮助中 eval 声明 frameId/documentId。原有可选列映射资源警告保留，无新依赖。检查点 SHA 以 Git 日志为准；下一步优先补 download 生命周期等待及浏览器流式观测，同时保留全部能力台账的未完成范围。


### 2026-10-17：下载生命周期、可续等观察与真实验收

- 从干净的跨 frame 检查点 `51e7906` 继续。分支仍为 `codex/api-exploration-cli`，未 fetch/合并/推送；develop/dev-1.1.0 已纳入快照和集成基线不变，后续仍按本文“上游→集成基线→功能分支”流程同步。完整对齐目标保持 active。
- 新增 browser.downloads 与 wait kind=download，插件能力 browser_downloads_v1。主/子页面 Page 下载事件限定 tab 归属，GUID 只用于观察，不混同 Chrome downloads 数字 ID。下载记录不来自全局历史搜索；可选落盘元数据只查询准确 URL 与 ±2 秒开始时间范围，唯一匹配才返回文件路径，并声明 fileResolution，歧义不猜测。
- 内存每标签最多 100 条；cursor 记录下载开始序号，after 用于下一动作，downloadId 用于已有传输。默认最近 browser 动作边界在等待开始时冻结，防止另一 CLI 的触发动作推进游标。Bridge busy/tab 锁与扩展 managed 队列均为被动下载观察放行；等待可先于点击，不重试/取消/再次发起下载。单次最多 30 秒；DOWNLOAD_TIMEOUT 区分 not_seen/in_progress，后者保留续等 ID；中断、重复匹配、失效/淘汰游标均明确报错。
- Chrome/扩展/调试断开、标签关闭清理内存；Bridge 重启不清观察状态。bind 时启用递归 frame 观察，子目标增加 Page.enable，根网络缓存仍忽略子会话，GUID 去重防重复事件。无 manifest 权限、新依赖或下载目录/浏览器安全设置变更。URL 常见凭据参数脱敏，data URL 正文不返回；CLI 不读取下载正文，验收脚本只对自己创建的公开示例文件核对字节。
- 验收先发现慢速 fixture 发送 7 字节 text/plain 时，服务端已有请求，但 Chrome 下载历史与 Page 事件均未创建记录。改为明确 application/octet-stream + nosniff 后同样分段响应能观察到 in_progress，没有延长生产等待掩盖问题。随后跨源 frame 验收暴露子目标未订阅 Page 事件，已修复递归订阅；单测覆盖该命令序列。
- 自动化最终：WebCLI 105 文件/1118 项通过；扩展下载、frame、原生输入、网络、路由、消息安全和探索协议聚焦 64 项通过。新增覆盖旧游标/其他标签隔离、并行点击、默认边界、进度/中断/歧义、回收失效、限定路径匹配及旧插件拒绝。
- 隔离真实 Chromium 完整 28 项通过，报告 `webcli-browser-acceptance-Jz491B/report.json`（系统临时目录）。包含等待先于点击、准确文件字节、历史排除、其他 tab 隔离、慢速超时→重启 Bridge→同 ID 继续且请求恰好一次、外部取消、跨源 frame、重复同名歧义。原有 frame 30 秒 Promise、探索、生成、修复、安装、普通调用、历史与重启恢复均通过。新增 --downloads-only 聚焦入口；默认仍跑全部。
- 日常 Chrome 155：核实旧 PID 的完整 source Bridge 命令属于本任务后重启，重载已安装的工作区 extension-dist，doctor 确认 browser_downloads_v1；未动无关服务。主页面下载/进度/续等/准确文件字节通过。首次子 frame DOM click 虽到达服务端，却没有形成下载记录或文件，CLI 如实超时，未将点击成功误报下载成功；未确定 Chrome 阻止的具体策略。改用现有 focus(frameId/documentId) + 原生 keys Enter 后跨源下载完成且字节准确。最终报告 `weworker-download-live-qBiIBH/report.json`；测试仅创建公开示例 .txt，保留在本机下载目录；自建标签与临时服务正常关闭。
- 用户 B 站重新明确绑定，页面仍为 excel 第一页，已安装 current-video-links 返回 24 卡片；标题/规范化绝对链接逐项匹配，下载观察没有混入另一个 tab 的示例文件。人工期望初次误用原始 // href，与命令规范化 https 链接不一致；改为 DOM anchor.href 后精确对比通过，未改生产命令。验证摘要 `/tmp/weworker-download-bili-regression.json`，真实页面数据未进入仓库。
- 当前本任务 source Bridge PID 为 16371，日志 `/tmp/weworker-download-live-bridge.log`；这只是当时快照，下次重启前必须核实身份。插件已载本轮代码，B 站绑定保留；下次从 doctor/tabs/sessions 重新检查。
- Python 网站探索agent相对功能起点 `af8e082` 差异为零，源码/环境/测试/生命周期/数据未触碰。未推送或创建 PR，本阶段保存本地检查点；最终构建/打包见下条。
- 接手下一步：优先原生子 frame 指针（本次日常 Chrome 暴露实际限制）、console/network 持续观察、AX/截图扩展；随后 profile/多连接、PUBLIC_API/COOKIE_API runner 与显式凭据契约。多步 UI/动态页面/写命令、知识修订/共享修复、UI/内置聊天复用、独立 Codex/Claude 对话、平台分发与业务覆盖仍在能力台账内，不关闭全目标。

- 最终分发检查：CLI/Bridge 构建、公开配置、12 个 JS 文件语法、Git 差异格式和新增内容凭据/私网地址检查通过；npm pack dry-run 592 文件，包含 browser-downloads.js 与最新 browser Skill，构建 CLI 帮助声明 downloads/downloadId。原有可选列映射资源缺失警告仍在，无新增依赖。完整 28 项后再为跨源链接补原生 focus + Enter 自动验收，--downloads-only 最终通过，报告 `webcli-browser-acceptance-TN43t5/report.json`；生产代码未再变更。检查点提交 SHA 以 Git 日志为准，完整目标保持进行中。


### 2026-10-17：子 frame 原生指针与跨源下载修复

- 从下载检查点 `948795b` 的干净工作区继续；上一轮是已提交并实测的进展。分支、已纳入上游快照、集成基线不变；本轮未 fetch/合并/推送，完整目标保持 active。
- 新增 browser-pointer.js 与 browser_frame_pointer_v1。子 frame click/dblclick/hover 不再合成 DOM 事件，drag 支持同一指定 frame 的 selector/toSelector；旧插件拒绝新行为。主 frame 既有原生路径保持，普通输入和页面生成策略未扩范围。
- 抽取 withBrowserFrameContext 供 eval/指针共用隔离文档身份匹配。指针将选中节点暂存扩展隔离环境，绑定远程对象与 unique context，在最终派发前核对文档；不依据 URL 或数组索引找目标。临时标记与远程对象在 finally 清理，导航后的新文档不会收到旧清理或自动重试。
- 独立 Chrome 调试探针确认直接对子 target 发送本地原生输入能产生 isTrusted，但可能绕开父层命中检查，因此正式实现统一派发主视口坐标。DOM 内容四边形属于该调试目标根视口；同进程子 frame 需先逆变换到本地视口，沿每层 iframe owner 内容四边形投影到父视口。使用投影变换处理边框、缩放、旋转和透视；滚动保留的节点后，在每个文档的隔离世界 elementFromPoint 检查目标/owner。
- 首次多 frame 测试中，直接用 DOM.getNodeForLocation 检查同进程子 frame 返回父 iframe owner，导致明确 ELEMENT_OBSCURED（未点击）。据真实几何与 frame 记录改为逐文档逆变换和命中检查后通过，没有放宽遮挡条件。frame tree 缓存也按调试 session 区分。
- 悬停后重新测量，超过半个 CSS 像素的布局移动拒绝点击；父层/目标遮挡、离屏、文档变化均明确失败。30 秒准备截止阻止迟到指针派发，拖拽出错尝试在最后已发送坐标释放按钮（按下出错也执行释放）；不会自动重试。悬停、双击第一下或部分拖拽可能已产生业务副作用，错误不证明“未操作”，Skill 已说明。
- 单测：WebCLI 105 文件/1119 项通过；扩展最终聚焦 69 项通过，含投影/逆变换与退化坐标、准备截止后零 Input 事件和标记清理、旧插件能力守卫。既有 frame 8 项先通过，最终总集包含这些回归。
- 隔离真实 Chromium 完整 29 项通过，报告 `webcli-browser-acceptance-MBAZLR/report.json`。新增六个子 frame（两个同 URL 跨源、各自同源和跨源嵌套），检查缩放/旋转/边框下原生 click/hover/dblclick/drag 的 isTrusted；根/中间父层遮挡拒绝，悬停移位拒绝且点击计数不变，hover 导航拒绝，错配文档拒绝。原有 30 秒 Promise、下载、API/DOM/INTERCEPT/跨文档查询、修复、安装、知识历史和重启全部通过。
- 完整通过后收尾加入准备截止和拖拽异常释放位置加固；新增截止单测通过，最终 --browser-only 5 项通过，报告 `webcli-browser-acceptance-PYOvFP/report.json`。最终版包含原生输入和下载等全部浏览器场景，未把该聚焦报告当作又一次完整探索流程。
- 日常 Chrome：核实本任务 source Bridge 后更新并重载工作区插件，doctor 声明新能力。自建公开 loopback fixture 的六个同/跨源子 frame 在缩放/旋转/透视/边框下 click/hover/dblclick/drag 均 isTrusted=true，点击计数准确，父层遮挡拒绝。跨源下载链接直接原生 click 即成功，下载内容逐字节一致，修复上一轮须用 focus+Enter 的限制。报告 `weworker-pointer-live-ubq99z/report.json`；临时服务与自建标签已关闭，示例 txt 留在本机下载目录。
- B 站重新明确绑定，excel 第一页、原 current-video-links 命令 24 张可见卡片标题/规范化链接逐项一致，下载记录未混入本轮其他标签。只将摘要记入本文，真实响应、页面和包内容未提交。
- 当前 source Bridge 为 PID 19049、日志 `/tmp/weworker-pointer-live-bridge.log`，仅是快照，下次操作前核对完整命令归属。用户安装位置仍为工作区 extension-dist，B 站会话 bilibili-maintenance 保留；重载后重新选择 tab/document，不复用旧身份。
- Python 网站探索agent相对 `af8e082` 差异为零，源码/环境/测试/生命周期/数据全程排除；无新权限、依赖、CI/发布改动。未推送、未建 PR，本阶段保存本地检查点。最终分发/代码复验补充如下。
- 接手下一步：console/network 持续观察、AX 与截图标注/尺寸、Shadow DOM/复杂控件，以及 profile/多连接、PUBLIC_API/COOKIE_API 执行和显式凭据契约；多步 UI/动态页面/写命令、知识修订/共享修复、UI/内置聊天复用、独立 Codex/Claude 对话、平台分发与 Adapter 业务覆盖仍在台账。拖拽当前限同 frame 的指针流程，不构造 DataTransfer 或跨 frame 拖拽；exploration 页面来源仍限主 frame。不能将本轮浏览器进展视作完整 OpenCLI 对齐。

- 最终检查：CLI/Bridge 构建、公开配置、10 个 JS 文件语法、Git 差异格式与新增内容凭据/私网地址检查通过；npm pack dry-run 593 文件，包含 browser-pointer.js 和最新 Skill，构建 CLI 的 drag 帮助包含 frameId/documentId。原有可选列映射资源警告保留，无新依赖。最终插件重载后再次跑日常 Chrome 六 frame/遮挡/直接点击下载，报告 `weworker-pointer-live-1bOX7q/report.json` 通过；B 站重新绑定并再次核对 24 卡片成功。所有自建服务/标签已清理，用户页面保留。检查点 SHA 以 Git 日志为准，全能力目标保持进行中。

### 2026-10-17：console/network 持续观察、游标与真实验收

- 从干净检查点 `3ea604c` 继续；分支 `codex/api-exploration-cli`，集成基线与已纳入上游快照未变，本轮未 fetch/合并/推送。完整 OpenCLI 对齐目标保持 active。更新已有跟进文档，不新建用户会话或子 Agent。
- 新增 extension/background/browser-events.js、webcli/browser-follow.js 与能力 browser_events_v1。console/network 的 CLI --follow 输出 JSONL，browser.events 供任意 Agent 和未来 UI 非锁定轮询；绕过 Bridge session/tab 锁和扩展 managed 页面队列，观察可与触发操作并行。命令帮助为 36 个 browser 命令，包文件清单已包含新模块。
- 每 tab/channel 保留 200 条内存事件，epoch/channel/sequence 游标区分同毫秒日志、标签、通道与新一轮观察。ready/entry/checkpoint/end/error 保存可续接位置；筛选时推进 checkpoint，until 以内的年轻事件延后消费，maxEvents 精确终止，stdout 写回调提供背压。SIGINT/SIGTERM 为 130/143，EPIPE 安静退出；断线停止，不重试或自动换游标。
- console/网络覆盖根与已订阅的递归子 target；子 target 新增 Network.enable，requestId 按 source session 区分。网络仅输出完成/失败/重定向元数据，pending 超过 1000 条输出 gap；按 key 读取详情才返回有界脱敏 JSON。redirect、重用 ID、详情读取期间变化及 pending 淘汰不能让旧 key 读取后继请求正文。source 描述调试 target，同进程子 frame 可能标为 main-target。一次性 console/network 保持旧主 target 缓存，不把 Worker 或绑定前流量纳入承诺。
- since/until 支持 ms/s/m/h、0–24h，裸数字沿用秒，与 OpenCLI 毫秒不同，Skill 建议显式单位；旧插件遇到新时间单位/参数明确拒绝。JSONL 专用于 follow；直接 Bridge 客户端不得传 follow 等 CLI 标志，应调用 events。follow=false 保持一次性结果。没有新增依赖或 manifest 权限，Extension/Toolkit Runner 边界未变。
- 首次真实验收发现主 CLI call 分支没有使用已单测的参数解析辅助函数，导致裸 --follow 不生效；已统一入口并真实子进程回归。第二个实际失败是扩展直接 chrome.debugger.detach 不保证触发 onDetach，旧内存仍可读；已用无页面执行的 Runtime.getIsolateId 在观察前核对所属连接，失败清理状态且不自动重附，已有自有临时调试连接也统一清理。重连新观察拒绝旧 cursor。测试 loader 同步导入事件/frame/download 清理，Adapter helper 15 项回归通过。
- 自动化最终：WebCLI 全量 106 文件/1128 项；扩展事件、原生指针、下载、frame、输入、网络、路由、消息安全和探索协议聚焦 76 项通过；Adapter 注册/常见失败/写确认/helper 额外 15 项通过。单测含同时间戳、分页/过滤/丢失、root/child 重名 requestId、详情读取竞态、pending 容量、输出背压、信号与 WebSocket 取消。
- 隔离真实 Chromium 完整 32 项通过，系统临时报告 `webcli-browser-acceptance-1MctRg/report.json`。新增双 console 订阅和 network 订阅同时运行，主/子 frame 原生点击、redirect/失败、详情脱敏、精确条数、信号/管道关闭、Bridge 断线→显式原 cursor 续接、until 延后、200 条淘汰以及调试 detach 失效；旧 frame 30 秒 Promise、下载、API/DOM/INTERCEPT/跨文档查询、修复、安装、知识与历史全通过。新增 --events-only 和共享 browser-events-acceptance.mjs，默认仍跑完整流程。
- 完整通过后收尾加固重用 ID 在 pending 淘汰后的正文阻断，新增单测并重跑全量；最终隔离 events 聚焦通过 `webcli-browser-acceptance-3rtvaa/report.json`，另覆盖一次性 follow=false 和新时间单位。其后核对初次启动输出，发现自动启动 Bridge 的诊断会污染 stdout，已移至 stderr，服务显式 start 输出不变；增加真实无 Bridge 起始的 CLI 验收，最终结果追加于后。
- 日常 Chrome：核实本任务 source Bridge 完整命令后重启、重载已安装工作区 extension-dist，无需用户再次安装。首轮 `weworker-events-live-a8cWfY/report.json` 中最后一条标签误带“debug detach”，实际 detachTested=false；最终复测标签已修正，报告 `weworker-events-live-JwMgxZ/report.json`。该环境验证双订阅、主/子 target console/network、脱敏详情、信号/关闭管道、Bridge 重启续接、时间窗口与淘汰；主动 detach 在隔离 Chromium 验收，不把日常报告误记为也覆盖它。所有自建页面/临时服务器正常关闭。
- B 站重新从 tabs 选择并绑定 bilibili-maintenance，excel 第一页、原 current-video-links 24 张可见视频卡片标题/规范化绝对 URL 逐项一致，下载观察未混入其他标签。此次不持续观察真实站点的无关账号流量；压力/断线/溢出使用自建公开 loopback fixture。真实页面结果只留本机，没有提交到仓库。
- 当前 source Bridge 快照 PID 23777，日志 `/tmp/weworker-events-live-bridge.log`；下次操作前必须重新核对完整命令，不复用历史 PID/tab/document。用户安装目录仍为工作区 extension-dist，B 站页面保留。最终 npm pack dry-run 595 文件含 events/follow/最新 Skill；CLI/Bridge 构建与公开配置通过，原有可选列映射资源警告保留。
- Python 网站探索agent相对功能起点 `af8e082` 差异为零，源码/环境/测试/生命周期/数据全程排除。无发布、CI、数据库或 .env 改动；未推送、未开 PR。保存本地检查点，SHA 以 Git 日志为准。
- 下一步：AX/state 对比、截图标注/尺寸、Shadow DOM/复杂控件、profile/多连接；随后按 Runner 边界实现 PUBLIC_API/COOKIE_API 与显式鉴权契约。多步 UI/动态页面/写命令、知识修订/共享修复、UI/内置聊天共用、独立 Codex/Claude 新对话、平台分发和业务覆盖继续保留在能力台账，不能将本阶段完成当作全目标完成。

- 最终分发复验：首用自动启动 Bridge 的真实 CLI 子进程只输出一行 JSONL error，启动诊断均在 stderr；隔离浏览器最终 5 项聚焦通过，报告 `webcli-browser-acceptance-TRWQmK/report.json`，包含一次性 follow=false、时间单位、双订阅、重启、溢出与主动 detach。WebCLI 106 文件/1128 项在该启动修正后再次通过；CLI/Bridge 构建、595 文件 npm pack dry-run、20 个 JS/MJS 语法、公开配置、Git 差异格式与增量凭据/私网地址检查通过。构建后的 browser.help 正确包含 36 个命令及 follow 参数。完整 32 项报告在启动诊断修正之前，最终聚焦不冒充又一次完整探索验收。用户插件生产源码与最后日常 Chrome 验收版本一致，后来仅 CLI 启动诊断和测试/文档更新；源 Bridge 与用户页保留，本轮检查点 SHA 见 Git 日志。

### 2026-10-17：AX 快照、来源比较与 Shadow DOM 引用

- 上轮 `ae8640c` 已形成有效提交和完整验证，本轮从干净工作区继续。功能分支仍 `codex/api-exploration-cli`，集成基线/已纳入 develop/dev-1.1.0 快照不变；本轮未 fetch/合并/推送，继续使用本文上游→集成基线→功能分支流程。完整 OpenCLI 对齐目标保持 active。
- 核对 OpenCLI 1.8.8 的 state --source ax / --compare-sources：后者是 DOM/AX 来源指标比较，不是历史页面差异。本项目新增 browser-ax.js / browser_accessibility_v1，state 接受 source 与 compareSources；浏览器命令总数仍为 36，旧默认 DOM 输出保持。没有复制上游 AX/引用业务代码。
- AX 获取浏览器计算后的角色、名称与状态属性，返回语义 tree/text/elements；不返回输入 value，密码字段 get 仍拒绝。默认逐文档汇总可访问 frame，显式 frameId/documentId 限定一个文档；两个同 URL frame 不合并。引用总数默认 100、最多 200；语义树最多 1000 节点、文本 12000 字符、最多 50 frame，准备截止 30 秒；限额、未映射节点和子 frame 失败给 truncated/partial 和明细，不宣称完整覆盖。
- 引用保存于扩展隔离世界当前文档 Map，携带随机快照 ID、Chrome frameId/documentId；CDP backendNodeId 只在所属调试 target 解析，并核对 ownerDocument。使用时核对实际 Map、URL、节点连接和新的 AX role/name，不按名称选替代节点。节点替换、名称改变、文档错配、导航和新 state/find 明确失效；没有自动重试。引用属于其文档的最近一次快照，其他 frame 的新快照不替换它。
- compareSources 按同文档顺序获取控件数、命名覆盖、角色分布和耗时，来源错误保留，不静默回退。比较不生成或替换操作引用；多文档采集不冻结网页，结果含各帧身份和部分覆盖说明，不能把两种计数差异等同于质量优劣。
- AX ref 可直接用于 get/fill/click 等，自动采用 ref 的 frame/document，不需用户重复猜索引。开放、关闭和嵌套 Shadow DOM 的真实节点可解析，原生指针逐层检查 ShadowRoot/iframe owner 的命中；祖先 overlay 拒绝。指针在悬停后/按下前重新核对 AX 名称与禁用，悬停改名测试拒绝且点击副作用为零。原生输入后的错误仍可能包含先前悬停/第一次点击副作用，不能重放。
- AX 获取和引用验证均有截止；阻塞 CDP 返回明确 AX_SNAPSHOT_TIMEOUT / AX_REFERENCE_TIMEOUT，后者不派发动作。远程对象按 objectGroup 释放，快照安装前核对文档、URL 和截止，过迟安装拒绝。旧插件对新来源/比较参数和 AX ref 明确要求升级。无新增依赖、manifest 权限或新的 Runner。
- 单测最终：WebCLI 106 文件/1129 项通过；扩展 AX、持续观察、指针、下载、frame、原生输入、网络、路由、安全、协议与 Adapter helper/注册/写确认等共 98 项通过。AX 七项聚焦覆盖重复控制、ignored/值省略、限额、引用身份、来源错误、节点解析途中上下文丢失、快照和动作前验证截止；Bridge 测试验证旧插件拒绝与原样传递引用。
- 隔离 Chromium 初版 AX 通过 `webcli-browser-acceptance-gsY9oi/report.json`；补全默认跨 frame 汇总后完整 34 项通过，最终完整报告 `webcli-browser-acceptance-McYwgR/report.json`。新增 browser-ax-acceptance.mjs / --ax-only，可复跑计算名称、重复名称、开放/关闭/嵌套 Shadow DOM 填写和原生点击、密码值省略、disabled/overlay、来源比较不失效引用、同名替换和两同 URL 跨源 frame 自动引用身份；原持续观察、下载、frame Promise、API/DOM/INTERCEPT/跨文档查询、修复、安装、知识与重启全部通过。
- 完整通过后补引用验证超时、ownerDocument 检查及悬停后 AX 名称复核；相应单测纳入上述 98 项，最后隔离 AX 3 项聚焦通过 `webcli-browser-acceptance-k5IZSv/report.json`（首用启动、连接、AX 场景），没有将该聚焦写成又一次完整 34 项。生产最终改动均经该 AX 浏览器用例覆盖。
- 日常 Chrome：核实本任务 source Bridge 完整命令后重启并重载已安装 extension-dist，新能力就绪；最终报告 `weworker-ax-live-KWaOLF/report.json`，全部 AX fixture 场景包含悬停改名拒绝通过。自建三 frame 页面与临时服务器均正常关闭。B 站重新 tabs 选择 excel 页并绑定，只对明确主文档做 AX 读取，确有搜索框控件；原 current-video-links 24 张可见卡片标题/规范化链接逐项匹配，页面保持 excel 第一页。真实页面与 AX 树未写进仓库，报告仅保存摘要。
- 当前 source Bridge 快照 PID 28690、日志 `/tmp/weworker-ax-live-bridge.log`；下次先 doctor/tabs/sessions，再核实完整命令归属，不能复用历史 PID/tab/document。插件目录仍是工作区 extension-dist，用户不需重新安装；源 Bridge 和用户页面保留。
- 深层 selector/role 查询、复杂自定义控件、跨 frame/DataTransfer 拖拽仍未完成，不能由 AX ref 操作推断全部 Shadow DOM 命令覆盖；exploration 的生成页面来源也未扩为 frame/shadow。下一步优先截图标注/临时尺寸，再推进 profile/多连接、PUBLIC_API/COOKIE_API 与显式凭据契约；动态页面/多步 UI/写命令、知识修订/共享修复、UI/内置聊天复用、独立 Codex/Claude 新对话与平台分发继续保留。
- Python 网站探索agent相对功能起点 `af8e082` 差异为零，源码/环境/测试/生命周期/数据未触碰。未改 CI/发布/schema/.env，未推送或创建 PR。构建/打包与最终差异检查追加于后，本轮保存本地检查点，SHA 以 Git 日志为准。

- 最终分发检查：CLI/Bridge 构建与公开配置通过；npm pack dry-run 596 文件，包含 browser-ax.js 和最新 browser Skill；构建帮助正确声明 state source/compareSources。11 个 JS/MJS 语法、Git 差异格式与新增内容凭据/私网地址检查通过，无新增依赖，原有可选列映射资源警告保留。工作区只含本阶段源码、测试和上述文档；下一位接手从最新本地提交继续完整目标。

### 截图编号、临时尺寸与本地文件（2026-10-17）

- 从 AX 检查点 `b89654e` 继续，分支仍为 `codex/api-exploration-cli`，没有同步/推送上游。新增 browser-screenshot.js / browser_screenshot_v1；统一 `browser.screenshot` 支持 annotate、width、height、path，fullPage 忽略 height。尺寸为实际 CSS 视口，按 zoom/DPR 计算；完整图与视口均限制 4000 万像素。
- 编号使用新主文档 DOM 快照，返回 label/ref/role/name/frame/document/bounds，图像侧合成，不插入页面覆盖层。最大 200 refs，尚未为 AX、Shadow DOM 或子 frame 编号。path 只在 Bridge 处理：绝对新文件、已有目录、PNG 签名校验、wx/0600，不覆盖已有文件，不把本地路径发给扩展。
- 真实测试发现两个生产问题并修复：executeScript 不接受 undefined 参数；Chrome 截图可能重置其他 CDP 客户端的尺寸模拟，曾产生 1280×581 图片配 1280×720 几何，红框因此偏离按钮。现在核对 PNG 尺寸和截图前后视口/元素几何，异常首图丢弃，明确固定测量尺寸后只重拍一次；持续错配返回错误，不拉伸图片掩盖偏差。
- finally 校验恢复：清除临时 override，若原观测视口仍未恢复则显式设置 measured desktop override，结果声明 restoration.mode；恢复失败不得返回成功。截图期间导航恢复当前文档视口，但不把旧滚动应用到新文档，返回 SCREENSHOT_DOCUMENT_CHANGED。不能读取另一客户端完整设备模拟配置，所以只保证桌面观测尺寸/DPR/scale 与原文档滚动，不承诺任意手机/方向模拟配置或 resize 业务副作用的回滚。
- WebCLI 106 文件/1130 项与扩展相关 105 项通过；截图单测 7 项涵盖恢复失败、像素上限、已有 override、捕获尺寸漂移后的重拍、持续错配和导航。Bridge 单测覆盖旧插件拒绝、本地路径不外发、保存与禁止覆盖。完整隔离 Chromium 35 项通过 `webcli-browser-acceptance-gkzqCm/report.json`，探索/生成/验证/安装/修复/知识/重启均回归。新增 browser-screenshot-acceptance.mjs / --screenshots-only 可复跑。
- 图片检查促成更严格的真实像素断言，早期 `webcli-browser-acceptance-NR7IYQ` 虽绿但有标注偏移，不作为有效视觉证据。修复后 `OpAnvV` 聚焦和上述完整流程通过；最后增加 125% zoom 的按钮像素断言，截图聚焦 `webcli-browser-acceptance-A7CHZ9/report.json` 再次通过。未把最后聚焦写为再次完整运行。
- 日常 Chrome 首轮 fixture 发现原生页面颜色与测试 Chromium 相差 1–2 个色阶，按钮颜色改为每通道最多 3/255 容差，红色标注仍精确断言，未降低位置检查。最终 `weworker-screenshot-live-iqPaQK/report.json` 通过：DPR 2 默认图 3024×1430，500×360 CSS 输出 1000×720，完整页 1000×4306，编号点击、无 DOM overlay、保存/拒绝覆盖、超限恢复与导航恢复通过。人工查看编号图/完整图，隔离图另查看 125% zoom。临时示例页面与自建服务器已关闭。
- 新扩展已由本任务重载，无需用户重新安装。重新 tabs 选择并绑定 B 站 excel 页，主文档 AX 和 current-video-links 24 张可见卡片标题/规范化链接逐项回归通过，页面仍在第一页。真实页面/结果未保存到仓库。当前 source Bridge 快照 PID 31129，日志 `/tmp/weworker-screenshot-live-bridge.log`；下次先核实完整命令归属与 doctor，再操作，不能照抄历史 tab/document/PID。
- CLI/Bridge 构建、公开配置、Git 差异格式、10 个 JS/MJS 语法与新增内容凭据/私网地址检查通过。npm pack dry-run 597 文件，包含 screenshot 模块及更新 browser Skill；无新增依赖，既有可选列映射资源警告保留。Python 网站探索agent相对 `af8e082` 差异为零，源码/环境/测试/数据未动；CI/发布/schema/.env 未改。
- 下一步优先深层 selector/复杂控件，再处理 profile/多连接、独立 PUBLIC_API/COOKIE_API 执行与鉴权契约；完整台账中的动态页面/多步 UI/写命令、知识修订/共享修复、UI/内置聊天复用、独立 Agent 新对话、平台分发等仍未完成。整体 goal 保持 active，本地检查点 SHA 以 Git 日志为准。

### 开放 Shadow DOM 查询（2026-10-17）

- 从截图提交 `1b33eb2` 继续，未改集成基线或同步远端。新增能力 browser_shadow_query_v1，通用 target/state/drag/wait-selector 可显式传 shadow=true；普通 CSS 查询保持原范围。逐个开放根执行 selector/role/name/text，组合器不跨树，默认不进入关闭根和其他 frame；显式 frame/document 可用于跨源文档。
- 结果附 shadowHosts（从外到内的 tag/id）、不透明 shadow ref、根数/范围/截断；树内 aria-labelledby 不再错误引用主文档同 ID。名称/角色/URL/节点变化拒绝旧引用，find(ref) 后仍保留 shadow 标记；后续调用无需再传 shadow，但子 frame DOM refs 仍需带 frame/document，不混同自带身份的 AX refs。
- 原生 shadow 指针走已有 frame pointer 路径，保留实际节点、检查祖先遮挡和悬停后几何，再复核引用；同文档不同开放根之间的 drag 是同 frame 原生鼠标动作。fill/type/select 的 input/change 设为 composed，实际宿主监听器收到值变化。禁用 fieldset 与 aria-disabled 均拒绝操作，状态元数据也使用同一判断，避免“显示可用却无法操作”。
- 查询最多 20000 元素、100 开放根、32 层；超限失败，不在部分候选中执行。state 文本仍为 light_dom，深层文本通过明确元素 get/extract。DOM 角色/标签只是本地解析，不替代 Chrome AX 名称算法；关闭根继续用 AX，shadow 与 AX/compareSources 不能混用。upload 和截图编号未扩展，复杂表单、跨 frame/DataTransfer 拖拽、生成流程的 frame/shadow 来源仍未完成。
- WebCLI 106 文件/1131 项通过，扩展相关最终 109 项通过；新增 4 项单测检查 tree-scoped 标签、角色/节点失效、遍历限额、不合法参数及禁用状态一致性，Bridge 验证选项/ref 的能力守卫和非 selector 等待拒绝。没有新增依赖。
- 新增 browser-shadow-acceptance.mjs / --shadow-only。最初测试页内联事件的引号错误导致没有建立 shadow roots，修正 fixture 后 `webcli-browser-acceptance-YC9l92` 通过。最终生产主体完整 Chromium 36 项通过 `webcli-browser-acceptance-HlI3DQ/report.json`，包括新增 shadow、旧截图/AX/持续观察/frame/下载，以及探索、生成、安装、修复、知识与重启。其后补禁用状态输出一致性，最终 shadow 聚焦 `webcli-browser-acceptance-Uf6vlx/report.json` 通过；没有将聚焦报告称为再次完整运行。
- 日常 Chrome 首次比 fixture 多一个开放根，属于浏览器环境额外注入；验收改为要求至少三个 fixture 根，并精确核对目标 host 路径、名字和实际动作，不假设用户 profile 无其他扩展。最终 `weworker-shadow-live-YkBglq/report.json` 通过嵌套原生点击/同 frame drag、局部标签、composed 表单事件、歧义/关闭根排除/替换/悬停改名/禁用/遮挡、selector 等待、跨源 frame 和遍历上限；自建页与服务器已正常关闭。
- 每次重载后重新选择 B 站 excel 用户页并绑定，最终主文档 AX 与 current-video-links 24 张可见卡片标题/规范化链接逐项一致，保持第一页；真实页面数据未进入仓库。source Bridge 当前快照 PID 33631，日志 `/tmp/weworker-shadow-live-bridge.log`；插件仍加载工作区 extension-dist，已经重载新代码，无需用户重装。下一次操作前核实进程完整命令、doctor/tabs，历史身份不可照抄。
- CLI/Bridge 构建、构建版 browser.help 的 shadow 参数、公开配置、Git 差异格式、10 个 JS/MJS 语法与新增内容凭据/私网检查通过；npm pack dry-run 597 文件包含新能力和 Skill，测试脚本不分发。Python 网站探索agent相对 `af8e082` 零差异，源码/环境/测试/生命周期/数据未触碰。CI/发布/schema/.env 未改，未推送或创建 PR。
- 下一步优先补 date/select/file 等复合字段元数据与对应结构读取，再推进多 profile/连接及 PUBLIC_API/COOKIE_API 独立 runner；UI/聊天共用入口、写命令/多步 UI、知识修订/共享修复、独立 Agent 对话和平台分发继续保留在完整目标。goal 保持 active；本阶段本地提交 SHA 见 Git 日志。

### 复合控件与结构化 HTML（2026-10-17）

- 从 `b01392e` 继续，分支/集成快照不变，未 fetch/merge/push。新增 browser_compound_v1；DOM state/find 与元素描述默认提供 date/time/datetime-local/month/week、select、file 的 compound，compound=false 可省略。get property=compound 单独读取，允许明确选择隐藏文件输入；AX state 仍省略值，但 AX ref、开放 Shadow 查询、明确 frame/document 均能读取字段信息。
- 日期返回 ISO 格式/原生 current、min/max/step、required/readOnly 与 validity，time/local 可选秒/毫秒；这不是本地化显示格式。fill 只验证值是否保留，不把范围/步长有效性等同操作成功。文件仅返回名称与 accept/multiple/数量，不读本地路径/正文。
- select options 限 50，选中标签/currentValues 独立读取，覆盖第 50 项之后的当前选择。支持 option.label 与禁用 optgroup；by=auto/value/label 明确匹配，重复/碰撞返回 AMBIGUOUS_OPTION，缺失/禁用在修改前拒绝。多选允许空数组清空；事件后核对实际节点/选择状态，页面撤回或替换返回 SELECTION_REJECTED，不重放。此处保留比 OpenCLI 标签优先更明确的歧义约束，不宣称参数行为逐字相同。
- 最多扫描 20000 选项，选择请求最多 1000 项；返回选中项最多 1000、文件名 100，字段长度和全次复合信息 100000 字符预算均明确标记截断/omitted，不能当作空字段。极大选项列表的 metadata 明示 option_scan_limit，动作返回 SELECTION_LIMIT。
- get property=html as=json 新增结构树，未指定目标读 html 根，支持 depth=0；默认 depth/childrenMax/textMax/maxNodes 为 3/50/200/500，上限 20/200/2000/2000。输出 tag/语义与 aria/data 属性/直接文本/children/compound，密码 value 和 script/style/noscript/template 正文省略，事件属性不返回；普通标签/属性/文本 100000 字符预算，长属性名跳过并标记，tag 限长。各类截断明确报告；原 raw HTML 保留，不能套用 JSON 省略规则。树不自动穿 shadow 根，需选内部元素再读。
- WebCLI 106 文件/1132 项通过；扩展最终 117 项通过。新增 8 项单测覆盖五类日期约束、选中项超列表 cap、隐藏文件元数据、标签/值碰撞与控制器撤回、HTML 深度/节点/文本/脚本/密码、扫描/预算和长标签/属性名限额；Bridge 另测旧插件拒绝、参数保持与构建帮助。无新增依赖。
- 新增 browser-compound-acceptance.mjs / --compounds-only。初版隔离真实 Chromium `webcli-browser-acceptance-1CWQO0/report.json` 与日常 `weworker-compound-live-aMnCMi/report.json` 均通过；生产主体完整 37 项 `webcli-browser-acceptance-ikdChv/report.json` 通过，包含原截图/Shadow/AX/流观察/下载/frame 与探索、生成、安装、修复、知识和重启。其后补 HTML 根/depth=0 与长名称预算，最终聚焦 `webcli-browser-acceptance-oCloAm/report.json` 通过；未把最终聚焦称为再次完整运行。
- 最终日常 Chrome 报告 `weworker-compound-live-8aY5zt/report.json`：五类日期读取/原生 validity、65 选项中第 61/63 项当前选择、列表外选择/清空、重复/禁用/页面撤回拒绝、隐藏 input 真实上传测试文件、HTML 省略/预算、开放 Shadow/关闭 AX/跨源 frame 字段读取全部通过。临时页与自建服务器关闭；只上传公开占位文本到本轮本地测试页面，未触及真实业务上传。
- 重载插件后重新 tabs 选择 B 站 excel 用户页并绑定，主文档 AX 与 current-video-links 24 张可见视频卡片标题/规范化链接逐项一致，保持第一页；真实页面数据未提交。当前 source Bridge 快照 PID 35677、日志 `/tmp/weworker-compound-live-bridge.log`，仍加载工作区 extension-dist；下次先核实完整进程命令和 doctor/tabs，不能复用历史身份。
- CLI/Bridge 构建、公开配置、打包入口/帮助、Git 差异格式与 JS/MJS 语法通过；npm pack dry-run 597 文件。Python 网站探索agent相对 `af8e082` 零差异，源码/环境/测试/生命周期/数据未碰；CI/发布/schema/.env 未改。最终新增内容检查与提交见后，SHA 以 Git 日志为准。
- 下一步继续实际控件操作缺口：Shadow/子 frame/AX ref 文件输入、通用自定义组件；然后推进 profile/多连接、独立 PUBLIC_API/COOKIE_API runner。UI/聊天共用服务、写命令/多步 UI、知识修订与共享修复、独立 Agent 对话、平台分发和其余台账目标均未完成，goal 保持 active。

- 最终分发/受控检查：597 文件 dry-pack、构建帮助、公开配置、9 个 JS/MJS 语法、Git 差异格式与新增内容凭据/私网地址检查通过；最新 Skill 随包，既有可选列映射资源警告保留。最终工作区仅含本阶段源码、测试与文档，保存本地检查点，整体目标未标完成。

### 文件输入目标扩展（2026-10-17）

- 从 `21f193c` 继续，集成快照与分支不变，没有 fetch/merge/push。新增 browser-upload.js / browser_upload_target_v1，upload 改为通用 selector/role/name/text/ref + paths，可显式 frame/document/shadow；AX ref 自动携带文档身份，普通子 frame DOM ref 仍需继续传身份。
- Bridge 本地验证 1–20 个绝对普通文件路径，生成名称/大小元数据，调用方不能传内部验证字段。扩展解析一次并在隔离世界保留节点、URL、名称/角色/multiple 与校验闭包，再以准确 target session 的 objectId 调用 DOM.setFileInputFiles；无 DOM 标记属性，路径不进入页面脚本参数。隐藏文件输入允许，原生 file 的 DOM role 补为 button。关闭根使用 AX；未把普通自定义 button 当成文件输入。
- 派发前复核节点/文档/类型/名称/角色/multiple/disabled，拒绝继承 disabled、aria-disabled、重复目标、单文件输入传多个、目录 input 与非文件节点。30 秒准备/派发/验证期限，页面侧也检查截止，避免延迟注入后继续保留目标；已发送的 Chrome 命令不能保证撤销。finally 只清理原文档隔离标记和远程对象。
- 派发后核对同一 input 的实际文件名、顺序和大小，不只对数量；页面清空、替换或导航明确失败。错误在进入本次操作后附 dispatched，true 时页面事件/自动上传可能发生，不能自动重放。verified 只证明文件输入状态，不证明内容 hash 或服务器收到；目录输入、目录/文件选择弹窗和通用自定义上传业务流程尚未覆盖，accept 不用于 CLI MIME 猜测。
- WebCLI 106 文件/1133 项通过，扩展最终 122 项通过。新增 5 项单测：target session/objectId 保留与路径不注入、失效/禁用/上下文消失阻止派发、迟到验证不能发送文件、名称/顺序/大小精确校验、页面准备过期与合同变化；Bridge 验证内部字段不能伪造且旧插件拒绝。没有新增依赖。
- 新增 browser-upload-acceptance.mjs / --uploads-only。初版隔离 `webcli-browser-acceptance-jghQCA/report.json` 通过；文件名追加空格/中文后，生产主体完整 38 项 `webcli-browser-acceptance-W5Q8Pm/report.json` 通过，包含原复合字段、Shadow/AX、截图、持续观察、下载/frame，以及探索/生成/安装/修复/知识/重启全流程。其后补页面侧过期检查，最终聚焦 `webcli-browser-acceptance-nlsrAp/report.json` 通过；没有将最终聚焦称为再次完整运行。
- 日常 Chrome 最终 `weworker-upload-live-Giy5xv/report.json`：隐藏 input、语义选择、开放/嵌套 Shadow、关闭 AX、同 URL 两跨源 frame 与递归嵌套跨源目标全部正确；实际 File 内容逐项等于两份公开占位文本，测试页 multipart 提交到本轮 loopback 服务后内容仍一致。重复/禁用/目录/非文件/多文件限制、同名替换旧引用、页面清空、旧文档与选择后导航均拒绝，没有重放。测试页面与自建服务器正常关闭，测试文件只位于临时目录，没有真实业务上传。
- 重载后重新选择 B 站 excel 用户页并绑定，主文档 AX 与 current-video-links 的 24 张可见视频卡片标题/规范化链接逐项一致，页面保持第一页；真实结果未入仓库。当前 source Bridge 快照 PID 38679、日志 `/tmp/weworker-upload-live-bridge.log`，插件加载工作区 extension-dist 且已重载；下次先核实完整进程命令、doctor/tabs，不照抄旧身份。
- CLI/Bridge 构建、构建帮助的 ref/semantic/frame/shadow upload 参数、公开配置通过；npm pack dry-run 598 文件，包含 browser-upload.js 与最新 Skill。10 个 JS/MJS 语法、Git 差异格式和新增内容凭据/私网地址检查通过；原有可选列映射资源警告保留。Python 网站探索agent相对 `af8e082` 零差异，源码/环境/测试/生命周期/数据未触碰；CI/发布/schema/.env 未改，未推送或创建 PR。
- 下一步优先多 profile/连接的明确选择与路由，再推进独立 PUBLIC_API/COOKIE_API runner；自定义组件/多步 UI/写命令、知识修订/共享修复、UI/聊天共用服务、独立 Agent 对话和平台分发仍属完整目标，goal 保持 active。保存本阶段本地检查点，SHA 见 Git 日志。

### 2026-10-17：多浏览器路由核查与用户要求的会话暂停

- 操作前 HEAD `3e9a7ff`，工作区干净；本阶段只读核查 Bridge/CLI/Extension 的多连接边界和 OpenCLI 1.8.8 profile 辅助实现，没有开始代码改造。
- 用户表示上下文过多，准备新开对话，要求完成当前小工作后先结束目标。在当前无半完成代码的设计检查点收尾，目标按用户要求暂停，不标 complete，也不自动创建新会话。
- 已记录当前单连接覆盖、响应来源未绑定、广播、服务持久根/锁单例、follow 与普通 Adapter 路由等问题；开发设计包含拟定契约、旧数据兼容待定项及双真实浏览器验证要求。不得将这份设计当作 profile 已实现或上游全行为已验证。
- 更新本文顶部接手入口、开发设计、能力台账、OpenCLI 核查和 ROADMAP，共 5 份文档。没有新功能代码、测试进程、依赖、构建、fetch/merge/push/PR；功能验证数字沿用上传阶段，文档检查不冒充重跑测试。
- 本次只读核实 source Bridge PID 38679 的完整命令仍指向本工作区 `webcli/index.js --service`。没有停止或重载服务，没有操作浏览器；上一阶段上传验收的用户插件和页面保留。新会话使用前重新核对进程和标签身份。
- 收尾验证：检查 5 份文档差异和本地链接、Git 差异格式、修改范围；Python 网站探索agent相对 `af8e082` 保持零差异。提交 SHA 以本次文档提交的 Git 日志为准，提交后工作区应为干净状态。

### 2026-10-17：多浏览器 profile 实现与验收

- 从 `0f085ce` 继续当前分支，工作区初始干净；未同步上游、未新建分支/worktree。实现文件为 browser-profiles.js、扩展 browser-profile.js、Bridge 路由与 CLI/follow，沿用已有 Runner 边界，无新依赖。
- Chrome local storage 保存 UUID contextId，socket 单独身份；同 ID 同时在线拒绝后连接。profile.list/rename/use、--profile/WEBCLI_PROFILE、原子配置和离线历史就绪；flag > env > default > 唯一在线，不回退。浏览器命名会话/任务/知识/草稿/锁按 contextId 隔离，宿主安装包共享。
- 操作/后台任务用固定 route，Worker IPC 显式 AsyncResource；请求随机 UUID 跨 Bridge 重启不复用，绑定响应 socket，断线清 timer/失败，不接受迟到或异源回复。普通结果/Worker 进度只回请求者；目录通知仍广播，扩展资源回复原 socket。trace/follow 固定选择，选定 open_browser 不走系统回退。
- 新探索任务同时保留并复核标签 identity，阻止浏览器重启后的同 tabId 复用。旧根不移动/改写，通过 legacy 只读恢复任务/草稿/知识/旧生成历史，不自动继承或迁移。旧插件单连接临时可用，持久 alias/default 明确升级。
- 自动化：WebCLI 全量 108 文件/1145 项通过；扩展 browser-*、消息安全和导航守卫 85 项通过；最后 CLI/路由聚焦 16 项通过。双真实 Chromium 完整 44 项通过，包含旧单连接探索/修复/安装回归和多 profile；最后 profile/verbose trace 聚焦 8 项通过。
- 双浏览器覆盖同站点/同名 session、异 profile ref/cursor 拒绝、flag/env/default、两侧独立探索/作者 cases/真实验证/增量安装、普通调用、trace、follow/default 切换、Bridge 重启、扩展重载、浏览器退出/重启与离线默认不回退。协议单测另覆盖相同 tabId 的锁、异 socket 冒用请求 ID、断线/迟到回复、Worker 回调归属、动作模型上下文隔离与零/多浏览器 Toolkit。
- 首次新验收计划遗漏 readReason 被正常拒绝，补齐测试输入。Chrome for Testing 未开 developer mode 时 runtime.reload 会将命令行扩展标记 unsupportedDeveloperExtension，使用隔离测试 profile 的扩展管理 API 开启开发者模式后重载通过，未调整日常浏览器设置。关闭浏览器可能先返回 CDP 取消(BROWSER_OPERATION_FAILED)，随后 socket 才关闭；两种路径都无重放，断线立即失败由 WebSocket 单测另精确验证。
- 代码复核发现 verbose trace 的函数参数漏传，修正并新增双 profile CLI --verbose 实机检查；最终聚焦通过。同一个业务命令在不同 profile 读取不同页面，trace 仍取选定浏览器。
- 日常 Chrome：核实旧 source Bridge PID 38679 完整命令归属后更新至本轮源码，已重载工作区 extension-dist，稳定身份/doctor 就绪。重新选择并绑定用户指定 Excel 第一页，主文档 AX 有搜索控件；已安装 explored-current-video-links 的 24 张可见视频标题/规范化 URL 与 DOM 逐项一致；legacy 旧任务可读。首次人工期望包含隐藏卡片且未规范化空白，按原命令“可见卡片/规范化文本”契约修正验收后通过，未改业务 Adapter 或页面。
- 真实结果未提交，系统临时报告见顶部；所有临时 Chromium/fixture/Bridge 已按验收清理，日常浏览器及本任务 source Bridge 保留。Python 网站探索agent相对本轮起点与 `af8e082` 源码零差异，未执行其环境/测试/生命周期操作；CI/发布/schema/.env 未改。
- 下一阶段仍是 PUBLIC_API/COOKIE_API 与显式鉴权契约，以及能力台账的其余项；不将本阶段完成标为完整目标完成。最终构建/打包检查结果见本节后续记录。

- 最终收尾：补齐离线 cancel 与 legacy 活跃任务草稿读取，聚焦 41 项及完整 WebCLI 1145 项再次通过；禁止 alias 使用 UUID 形状，避免别名与当前/未来 contextId 冲突。CLI/Bridge bundle、打包 CLI profile.help 和普通 profile 调用/verbose trace、公开配置均通过；npm pack dry-run 600 文件，含 browser-profiles.js、扩展 browser-profile.js 和两份 Skill。22 个 JS/MJS 语法、Git 差异格式、改动内容凭据/私网地址检查通过；已有可选列映射资源警告保留。最终 source Bridge 重启后旧绑定恢复且打包 CLI B 站仍返回 24 卡片。没有新依赖、未推送或创建 PR；本地功能检查点见 Git 日志。

## 2026-10-17：独立 HTTP Runner 阶段检查点

- 从 `81b4fd0` 继续，未 fetch/merge/push/PR。新增 v2 `http` + `http.version=1`，PUBLIC_API 直接 CLI/宿主 HTTP，无需浏览器或 Bridge；COOKIE_API 经选定连接临时读取精确 URL/声明名称的 Cookie 与可选 CSRF。Extension/Toolkit Runner 和 Python 网站探索agent均未修改。
- 实现文件：`http-contract.js`、`http-runner.js`、`http-worker.js`、`http-preview.js`、`exploration-http.js`，扩展 `http-credentials.js`；接入包校验/权限/目录/Skill/普通调用、探索计划/草稿/作者断言/安装与局部 repair。新权限包括精确 HTTP origin、Cookie 名称和 CSRF 映射，更新不能静默扩权。
- Worker 无 Node 模块/环境/文件能力暴露，API/参数/URL 均使用 realm 内对象；无限循环与挂起请求可终止。Node VM 不被宣称为运行任意恶意软件的系统级安全沙箱。每命令 30 秒/50 请求，单体 4 MiB；标准重定向限已声明 origin、五跳，每跳重新匹配 Cookie。没有失败重试或 profile 回退。
- 验证：WebCLI 109 文件 / 1161 项；扩展聚焦 6 项；完整真实 Chromium 47 项；最终 HTTP 聚焦 6 项；打包 CLI HTTP 16 项；CLI/Bridge 构建、26 个 JS/MJS 语法、公开配置及差异格式通过。`npm pack --dry-run` 606 文件含全部新增模块、扩展 helper 与 Skill。构建继续用 `NODE_PATH="$PWD/weworker/backend-ts/node_modules"`，没有新增依赖或修改 lockfile。
- 浏览器验收脚本新增 `--http-only`：PUBLIC 真实捕获→生成→两组独立 HTTP 断言→安装→关闭目标页后直接调用，双 Chromium 的不同 HttpOnly Cookie + CSRF 分别到达正确请求，缺失凭据零请求，原始占位凭据不进入 Bridge 日志、任务、安装目录。完整报告 `webcli-browser-acceptance-z6kGtC/report.json`；最终聚焦 `webcli-browser-acceptance-fzTCZ1/report.json`，均位于系统临时根。本轮未重载日常 Chrome、未重启日常 Bridge、未重跑 B 站；不把 loopback 鉴权验收当作所有外部站点通过。
- 安装权限测试首次把 `paths` 误放入 input，创建了本轮的 `example-http` 占位安装；发现后核对唯一 digest，已通过安装器仅移除该测试安装，测试修正为第二个 options 参数并再次通过。用户其他安装未修改，后续测试继续用隔离根。
- 重新核对本机 `opencli --version` 为 1.8.6，`opencli list -f json` 1275 条；官方 1.8.8 的 1366 条/179 分组仍为上一阶段审计基线，两个版本数量不能混用。本轮未安装/更新 OpenCLI。
- 剩余：环境/Bearer/HMAC/站点签名、分区 Cookie、无页面 API 发现；复杂控件、多步 UI/写命令生成验证、知识冲突和共享/写命令修复；CDP/Electron、external/plugin/补全等工具生态、业务命令覆盖、跨 Agent/跨平台/实际安装包验收及产品复用。HTTP 的完整 source-level trace/跨源重定向实机验收也未覆盖。整体目标保持进行中。

### 2026-10-17：HTTP version 2、环境鉴权和 Cookie 分区

- 阶段起点 `953d9e2`，继续当前功能分支；本轮没有 fetch/merge/push/PR。本地检查点以最新 Git 日志为准。Python 网站探索agent的源码、环境、测试、生命周期和数据全程未动。
- 新增 `webcli/http-auth.js` 与聚焦测试；version 2 兼容 version 1，旧宿主拒绝新版本。AUTH_API 使用执行宿主的明确环境变量名，支持 Bearer、自定义认证头、Basic、声明式 HMAC-SHA256/SHA512（hex/base64）；密钥按 UTF-8，不开放 Node crypto/环境给命令。HMAC 可按 method/origin/pathQuery/bodySha256/timestamp/nonce/header/literal 顺序拼接，重定向逐跳按实际字节重新签名；不声称任意站点签名或 OAuth 流程已完成。
- 普通 PUBLIC/AUTH 命令不选择浏览器，桌面 Bridge 路由也已覆盖零/多连接测试；COOKIE 可叠加 auth。预览用执行宿主环境，CLI 不向现有 Bridge 传送环境值，不读写 .env。缺失/空/非法凭据在命令启动前失败，零请求；Basic 编码、规范化头、HMAC 签名和原始值回显在进入 Worker 前脱敏。
- Cookie version 2 可选 storeId 和 partitionKey；分区必须包含浏览器实际 topLevelSite 和明确 hasCrossSiteAncestor。Bridge 固定连接并检查 http_credentials_v2，扩展再次过滤返回 store/分区身份；旧插件/不支持字段/缺失/歧义不回退。所有 auth 及 cookie scope 变化纳入安装权限，局部 repair 不放宽这些字段。
- 生成计划支持 AUTH_API/auth 和 Cookie scopes，自动选择版本；每个 HTTP 命令仍须作者 cases。实际运行测试包括 AUTH 生成→7 组验证末组故意失败→修正→安装→局部 repair→普通调用，以及真实 Chromium 的 AUTH 生成/宿主预览/安装/关闭页后独立调用。
- 验证：WebCLI 全量 **110 文件/1183 项**；最终聚焦 **5 文件/84 项**；扩展 Cookie **4 项**；打包 CLI HTTP **2 文件/36 项**；完整真实 Chromium **50 项**，最终 HTTP 聚焦 **8 项**。CLI/Bridge bundle、公开配置、22 个 JS/MJS 语法、diff 格式与新增内容常见凭据/私网模式扫描通过。npm pack dry-run **607 文件**，包含 auth/contract、扩展 helper、更新 Skill；无新增依赖。
- 完整报告：系统临时根 `webcli-browser-acceptance-qHQYwP/report.json`；最终 HTTP：`webcli-browser-acceptance-agzerk/report.json`。日志 `/tmp/weworker-http-auth-all-tests.log`、`/tmp/weworker-http-auth-final-focused.log`、`/tmp/weworker-http-auth-bundled-final.log`、`/tmp/weworker-http-auth-browser-final.log`。最后聚焦已覆盖完整回归之后的 canonical content-type 支持与 malformed scope 版本守卫，最终 bundle/HTTP 实机也已重跑。
- 实机包含默认/其他 top-level site/不同 ancestor flag 的同名 Cookie，与显式 store/分区正确隔离；双 profile HttpOnly/CSRF 和缺失零请求回归通过。Chrome 初次拒绝跨站 topLevelSite + ancestor=false 的不合法 fixture，改用自身 schemeful site 的合法双 ancestor 分区后通过。单测初次发现 NUL 经 process.env 赋值被 Node 截断、占位包重新安装需显式 downgrade 参数，已修正测试夹具；没有修改真实环境/安装数据。所有测试安装都使用隔离 options.paths。
- 未重载日常 Chrome、未重启日常 Bridge、未重跑 B 站；未验证其他浏览器/平台/隐身 store。HTTP 请求级测试另实测四种 auth 的跨 origin 重定向不携带凭据、SHA256/SHA512 与两种编码签名重算、缺失环境零请求、认证头覆盖拒绝、权限升级。
- 剩余优先级：① 无页面 API 发现/探索；② 动态页面、多步 UI、写命令生成与副作用验证；③ 知识冲突、共享/跨命令/写命令修复；④ 自定义控件、目录上传、跨 frame 拖拽、AX/子 frame 标注、Worker 网络；⑤ CDP/Electron、外部 CLI/插件/补全/输出等逐项矩阵与业务覆盖；⑥ 独立 Agent、跨平台/实际安装包验收。HTTP source-level trace、站点专有签名/OAuth 和 WeWorker UI/聊天复用单独保留，整体目标未完成。

### 2026-10-17：无浏览器 HTTP 探索与 OpenAPI 发现

- 阶段起点 `e5e6e44`，继续当前分支，没有 fetch/merge/push/PR。明确排除 OpenCLI 桌面客户端，WeWorker 探索/聊天/profile UI 单列产品待办。Python 网站探索agent源码相对 `af8e082` 零差异，未运行其测试、修改环境或操作数据/生命周期。
- 新增 exploration-host.js、exploration-openapi.js、http-client.js；共享受限 HTTP 传输供 Runner 和宿主观察使用。Bridge 在浏览器选择前路由 mode=http/http- taskId，存储独立 http-exploration；PUBLIC/AUTH task-free 入口需 mode=http。HTTP start 幂等且零请求，未知/离线/多浏览器 profile 不影响宿主任务。
- discover 仅访问指定 OpenAPI 3.0/3.1 或 Swagger 2 JSON，按 server/basePath 前缀提取参数段位、方法与响应结构；只展开本地引用，输出未解析/循环/截断 warnings，不保留描述/示例/default，不执行发现端点。文档不是生成证据，必须 request 获取真实成功 JSON；只读 GET/JSON/form POST/GraphQL query 使用逐跳 origin/语义校验。每任务 100 次、每次 30 秒/4 MiB，不重试。
- 宿主证据标记 host_http，生成/repair 必须显式 PUBLIC_API/AUTH_API 计划和作者 cases；复用严格验证、安装权限、知识与保留文件守卫。401/403 保留阻塞结构而不保存正文；无效 JSON 不成为成功证据。取消中止并丢弃迟到结果；计数派发前落盘，运行中重启为 interrupted，无自动重放。仅保留结构化 URL 与字段；作者公开的 goal/reason/cases/notes 仍会保存。
- 验证：WebCLI **111 文件/1193 项**；完整真实 Chromium **50 项**；零浏览器的源码 CLI/Bridge **8 项**、打包 CLI/Bridge **8 项**；打包 CLI HTTP **36 项**。新验收脚本 verify-exploration-http.mjs（可选 --bundled）使用隔离 loopback、配置/安装/数据根和临时端口，从未连接浏览器，完成真实发现→请求→生成→两组断言→安装调用→知识、重启、实际字段漂移失败与修复、取消和运行中重启；检查持久内容不含占位鉴权、查询/响应值。
- 报告位于系统临时根：webcli-browser-acceptance-pTMyvl/report.json，webcli-http-discovery-HPGl9M/report.json（源码），webcli-http-discovery-whk1T0/report.json（打包）。日志 /tmp/weworker-discovery-full.log、/tmp/weworker-discovery-browser.log、/tmp/weworker-discovery-acceptance.log、/tmp/weworker-discovery-bundled-acceptance.log、/tmp/weworker-discovery-bundled-tests.log。临时服务/浏览器均由脚本关闭；日常 Chrome/Bridge/B 站没有重新操作。
- 首次验收脚本的临时路径替换损坏语法、误用业务 --format 参数、错误假定 profile.list 无 legacy 条目，均修正测试夹具后通过。源码复核补齐请求预算的重启持久化，新增 Swagger operation schemes/无效 server 与文档条数上限测试。未放宽生产断言或安装审阅。
- CLI/Bridge 构建、公开配置、12 个 JS/MJS 语法、diff 格式和新增内容常见凭据/私网模式检查通过。npm pack dry-run **610 文件**含三个新模块及更新 Skill；无依赖/lockfile/CI/发布/schema/.env 变更。已有可选列映射资源构建警告保留，不代表完整安装包或所有输出映射已验收。
- 下一步：动态页面路由、多步网站 UI、写命令生成/副作用验证；之后知识冲突与共享/写修复、复杂浏览器控件、CDP/外部 CLI/插件生态与站点覆盖、独立 Agent/跨平台/安装包。YAML/任意 API 文档爬取、任意站点签名/OAuth、完整 HTTP trace 仍未覆盖；整体 OpenCLI 对齐继续，不能标 complete。

### 2026-10-18：同源参数化详情页导航

- 阶段起点 `8c87339`，继续当前分支，无 fetch/merge/push/PR。新增 `extension/background/page-navigation.js`、聚焦单测及 `webcli/scripts/page-navigation-acceptance.mjs`。Python 网站探索agent源码、环境、测试、进程与数据未动；没有依赖/lockfile/CI/发布/schema/.env 变更。
- `exploration.query` 新增 `source.mode=navigate`，每个 `:id` 用明确 `pathParameters` 绑定，values 保留字符串前导零与 Unicode。目标为固定同源主文档，无 query/hash 模板；非法路径、缺失绑定、明显写路径在派发前拒绝。沿用 `__webcli_page_query` version 1 续接，首次 handler 只派发一次导航，结果在重新注入后独立映射。`page_navigation_v1` 在观察、验证与普通调用前检查，不回退 profile。
- 扩展等待新的 main loader、准确目标 URL 和 300ms 稳定结果；文档版本变化重置稳定计时，读取结束再次复核。`Page.navigate` 无响应也有计时器并清理监听器；跨 origin/错误 ID 重定向、下载、超时或文档变化明确失败，不重放。同 URL 重复调用仍需新文档。取消丢弃迟到结果，已派发导航可能继续完成。
- manifest 的 `pageRoute.navigation` 包含模板与所有绑定，整体纳入 `page-navigation:` 权限。入口可为准确 path 或同一目标模板，支持从已脱敏的数字详情路径开始探索/修复。普通调用选入口或目标族的唯一页面/唯一活动页，缺失和歧义报错。每命令至少两组不同路径组合的作者 cases；preview 和普通调用共用 manifest 续接检查；scoped repair 保留既有路由/绑定/权限。
- 验证：WebCLI **111 文件/1197 项**、扩展聚焦 **40 项**、完整真实 Chromium **52 项**、最终打包 CLI 导航专项 **4 项**通过。CLI/Bridge 构建、公开配置、**20 文件** JS/MJS 语法、diff 格式及新增内容常见凭据/私网模式检查通过；npm pack dry-run **611 文件**，包含新扩展 helper 与更新 Skill。打包导航专项运行打包 CLI + 源码 Bridge，不当作完整分发包实测。
- 完整报告 `webcli-browser-acceptance-amRAoV/report.json`，最终打包专项 `webcli-browser-acceptance-RFY6iV/report.json`，均位于系统临时根。日志 `/tmp/weworker-navigation-full.log`、`/tmp/weworker-navigation-extension-final.log`、`/tmp/weworker-navigation-browser-full.log`、`/tmp/weworker-navigation-bundled.log`、`/tmp/weworker-navigation-build.log` 和 `/tmp/weworker-navigation-pack.json`。脚本关闭自己的隔离浏览器与服务；未重载日常 Chrome、重启日常 Bridge 或重跑 B 站。
- 实机完成观察→生成→单组 case 被拒→两组精确断言→审阅安装→普通调用→知识，准确保留 `007` 与中文 ID；同 URL 两次各一次请求，非法路径零请求，错误 ID 重定向明确失败。实际改变标记后旧 cases 失败，局部改模块、重验证、安装和调用通过；从数字详情路径启动修复也通过。
- 完整回归初次因新增知识页后旧计数仍为 8 失败，更新为 9 并断言存在 navigate 来源。另一次旧 INTERCEPT 用例把安装目录刷新后的延迟页面初始化 GET/POST 计为非法参数调用的请求；根据失败报告的导航事件和准确初始参数，验收改为仅允许该 fixture 的有效初始化 GET/POST，其他新增请求仍拒绝，记录 `invalid-intercept-query-background-requests.json`。该用例不宣称所有背景流量为零，生产刷新/参数验证逻辑未放宽。中文夹具补 UTF-8、失败调用期望值修正后通过。
- 下一阶段：多步网站工作流与写命令生成/副作用验证；当前只实现单次同源详情导航，未开始多步工作流实现。后续仍含动态 query/hash/跨源页面、知识冲突与共享/写修复、自定义控件/目录上传/跨 frame 拖拽、CDP/外部 CLI/插件生态、独立 Agent 和跨平台/分发验收。保持完整目标进行中；OpenCLI 桌面客户端明确排除。

### 2026-10-18：有序只读网站 workflow

- 起点 `7cc63ea`，继续当前分支；无 fetch/merge/push/PR。新增 `webcli/exploration-workflow.js`、`extension/background/page-workflow.js`、对应测试与真实浏览器验收。package.json 仅增加 files 中的宿主模块，无新增依赖/lockfile/CI/发布/schema/.env 变更。Python 网站探索agent源码、环境、测试、进程和数据全程未动。
- query 的 mode=workflow 声明 2–8 个 `{pathname, query}`，后一步入口等于前一步目标，统一同源主文档。可组合静态/动态 navigate、跨文档 query，以及保留当前 URL/document 的 filter（search/native-select/pagination）。filter 的参数必须与公开结果标量关联，无参数翻页必须看到数据变化；稳定 300ms 后继续。首步导航时可从中间/最终路径从头调用，其他首步限入口。静态导航无需虚构路径参数。
- 所有参数在首步前检查；每个参数至少两种不同值的作者 cases，返回最后一步的数据。每步至多一次，失败带 stepIndex/completedSteps，不执行后续动作、不撤销已完成动作。总预算最多 30 秒，剩余不足时不再派发；子步骤在动作/读取前检查总期限。各步末尾保留完整 URL/main frame/loader 的内部身份，后一步验证相同文档，避免路由模板放过不同 ID/同 URL 新文档；内部身份不进入最终输出或持久证据。
- `page_workflow_v1` 守卫观察、验证与普通调用。manifest.pageRoute.workflow 保存规范化动作/选择器/参数/关联/路由/时限，整体成为 `page-workflow:` 安装权限，拒绝跳步/替换/重排。仅结果提取声明不参与动作权限，允许 scoped repair 修改结果选择器；动作或顺序变化需重新生成审阅。输出仍走既有一次 continuation，原 handler 不重放。
- 观察/作者验证使用临时 operationId，取消通知绑定 profile 的扩展，后续步骤停止；取消可先于排队任务到达。验证按单 case 请求扩展，当前 case 取消后不启动下一组。Bridge 断线使当前流程失效，重启仍 interrupted，不重放；已经派发的浏览器动作可能完成。普通调用暂无独立任务取消入口，循环/分支/自定义控件/跨源/跨 frame 流程和写操作仍未覆盖。
- 实际隔离 Chromium 四步：入口导航→分类筛选→跨文档搜索→下一页，观察/生成/单组断言拒绝/两组精确结果/审阅安装/重复调用/知识通过。无效后续参数首步零动作；分类结果未更新时停止搜索/翻页；观察取消、验证取消、Bridge 中途关闭/重启均无后续动作，页面锁释放。改结果标记后保存 cases 失败，局部改提取选择器、重验/安装/普通调用通过。
- 验证：WebCLI **112 文件/1203 项**；最后 runtime-validator 聚焦 **4 项**（含新增取消断言）；最终扩展相关 **64 项**；完整真实 Chromium **57 项**；源码专项 **7 项**及最后打包 CLI 工作流专项 **7 项**。完整回归之后增加步骤间 URL/文档身份加固，已由最终扩展 64 项和最后打包专项覆盖，未再跑完整 57 项。CLI/Bridge 构建、公开配置、**23 文件**语法、diff 格式及新增内容常见凭据/私网模式扫描通过；npm pack dry-run **613 文件**，包含新宿主模块、扩展 helper 与更新 Skill。
- 报告：完整 `webcli-browser-acceptance-KlTLYt/report.json`；源码专项 `webcli-browser-acceptance-xPCRhY/report.json`；最后打包专项 `webcli-browser-acceptance-WxdKzg/report.json`，均在系统临时根。打包专项是打包 CLI + 源码 Bridge，不等于真实平台安装包。日志 `/tmp/weworker-workflow-full.log`、`/tmp/weworker-workflow-focused-final.log`、`/tmp/weworker-workflow-extension-final.log`、`/tmp/weworker-workflow-browser-full.log`、`/tmp/weworker-workflow-bundled-final.log`、`/tmp/weworker-workflow-build-final.log`、`/tmp/weworker-workflow-pack.json`。日常 Chrome/Bridge/B 站未操作。
- 首次实机把安装目录刷新导致的页面重载算成重复 search；改夹具分别记录文档 loads 和实际 form submit/category/next 事件，严查每轮动作各一次，保留 loads 供诊断，未修改生产刷新或放宽动作断言。取消测试首次立即读取遇到合法 TAB_BUSY，改为最多 5 秒只读等待释放（小于慢步骤 10 秒超时）；观察/验证取消均实测通过。单测初次漏 schema、模拟 runtime count 仍为 1、VM 夹具漏新导入，以及重复 --run 参数，均修正夹具后通过。
- 下一步写命令已核查：`generation-harness/write-tool-verifier.js` 现有的是模拟 fetch 的确认/请求/响应验证；`exploration-service.js` 的 generate/assertReadDraft/validate 仍严格只读。不能直接去掉这些守卫并把模拟当成实际副作用。后续需设计明确写计划、绑定草稿摘要/具体参数的执行确认、派发前持久状态、真实只读回查和失败/取消/重启后的不确定结果；公开隔离夹具先完成整条链路，再考虑授权外站。此处仅记录下一阶段入口，未实现写命令或副作用验证。

### 2026-10-18 HTTP 写命令生成与真实效果验证

- 起点 `49bb94c`，继续当前分支，提交 SHA 见 Git 日志；没有 fetch/merge/push/PR。Python 网站探索agent源码、环境、测试、进程和数据未动；未修改 CI/CD、发布、schema、.env 或依赖，没有删除仓库文件。
- 新增 `exploration-write.js` 与 `declare-write`、`write-verification-read/write`、`write-review/verify/readback`。写来源来自已成功观察的明确 mutation，或显式 HTTP 方法/URL/bodyKeys 声明；声明零请求、status=null，不假装成功证据。generate 只支持显式 HTTP action 计划，生成待作者实现的语义骨架，保留 safety/确认；Extension/UI 写生成未开放。
- 每写工具一个独立 fixture，包含公开代表参数、精确 method/URL/body/content-type、成功/失败 mock 与独立 GET 的 before/after 严格断言；同一非通配标量路径必须有不同 equals 值。普通 validate 仅跑 mock 与真实读用例。HTTP mock 在 Worker 内替换全部请求，不读取宿主鉴权，无网络回退；检查省略/false 确认零请求，真实参数和成功/失败解释。混合读/写计划保持计数与执行隔离。
- write-review 绑定完整 package、读 cases、写 fixtures 摘要，返回真实请求/参数/回查/鉴权声明。write-verify 必须带精确 reviewId 与 confirmed；同任务 reviewId 在派发前持久化消耗，先 GET before，再一次写，再 GET after，总预算 30 秒。存储失败不能发写请求，额外/不匹配请求、未声明 header、HTTP 错误、作者吞异常、未等待请求返回等不能通过。
- 成功响应但实际无效果、响应丢失、超时、取消和 Bridge 重启均保留不确定结果，已经写入的操作不回滚/不重发。重复或并发调用同 reviewId 只读原记录；即使 cancelled 状态是在派发中保存的，重启也恢复 uncertain。write-readback 可在取消/中断后独立 GET，证明当前 after 是否满足，但不会把失败 handler 变为通过。全部当前读/写成功后才允许安装，安装只重跑 mock。知识可保存明确的 writeVerification 历史，标记 replayAllowed=false；replan 保留副作用账本与旧 fixture。
- 普通 HTTP write 始终需要 __confirmed=true，即使 manifest 的 requires_confirmation=false；最多一个请求，拒绝任何重定向。普通调用没有任务 reviewId 去重；调用方不能盲目重试。缺确认的独立 CLI 返回结构化 HTTP_CONFIRMATION_REQUIRED。HTTP 读命令原有 50 请求/五跳不变；返回前尚有请求未完成会明确失败。
- 验证：WebCLI **113 文件/1218 项**，最后写相关 **4 文件/46 项**，完整真实 Chromium **57 项**；源码 HTTP **12 项**，最终打包 CLI + 打包 Bridge HTTP **12 项**。完整浏览器回归早于最后未完成请求/取消 mock/请求头规范化加固；最终 WebCLI 全量覆盖前两项，最后 46 项和打包 12 项覆盖全部最终加固，未再次跑完整 Chromium。构建、公开配置、**18 文件**语法、diff 格式与新增内容常见凭据/私网模式扫描通过，npm pack dry-run **614 文件**包含新模块和 Skill。
- 报告在系统临时根：完整 `webcli-browser-acceptance-yMFD6t/report.json`；源码 HTTP `webcli-http-discovery-rhUn5O/report.json`；最终打包 HTTP `webcli-http-discovery-Mq4oeq/report.json`。日志 `/tmp/weworker-write-all-final2.log`、`/tmp/weworker-write-final-check.log`、`/tmp/weworker-write-browser.log`、`/tmp/weworker-write-http-source-complete.log`、`/tmp/weworker-write-http-bundled-complete.log`、`/tmp/weworker-write-build-complete.log`、`/tmp/weworker-write-pack-complete.json`。脚本已停止自己创建的服务和浏览器；日常 Chrome/Bridge/B 站未操作。
- 初次 CLI 验收暴露缺确认仅 stderr 的旧行为，修正为 HTTP 结构错误后通过；取消 fixture 将资源 slug 命名为 cancel 被保守 GET 语义守卫拒绝，改为无操作语义的 stopped，没有放宽守卫。最终审查将 mock/实际请求 header 都按 JSON Content-Type 和字符串 body 的宿主默认值规范化，拒绝额外头；新增相应测试。
- 当前实际副作用仅验 PUBLIC/AUTH loopback，Cookie 写通道复用已验证的 profile/凭据通道但未单独实机写验收。尚缺页面写、批量/多步写、写响应动态 ID 回查、幂等键协商、自动回滚与写修复；同时保留知识冲突/共享修复、复杂读流程、外部 CDP/CLI、插件/补全/输出覆盖、站点/独立 Agent/平台分发等完整目标。OpenCLI 桌面客户端排除，WeWorker UI 单列；不能把本阶段当作整体对齐完成。


### 2026-10-18：Extension 页面上下文写与幂等效果验证

- 起点/核对结果：当前分支 `codex/api-exploration-cli`，HEAD `5cabcb8`，起始工作区干净；沿用已有 profile、HTTP、workflow 和写账本，没有 fetch/merge/push/PR。Python 网站探索agent源码、环境、测试、进程、生命周期与数据全程未动；未修改 CI/CD、发布、数据库 schema、.env、依赖或 lockfile，没有删除仓库文件。
- 新增 `webcli/exploration-extension-write.js` 和 `extension/background/page-write.js`。写计划 `strategy=PAGE_FETCH` 绑定单个 mutation，加固定 `pagePathname`、`bodyParameters` 和 `idempotency:{header,serverDeduplicates:true}`；固定同源主文档，POST/PUT/PATCH/DELETE JSON 字符串字段。包校验要求固定注册模块，实际命令由扩展固定函数执行，不支持任意作者页面 JS。完整契约成为 `page-write:` 权限；缺 capability/确认、错误参数/路由/文档、旧 review 都拒绝，不回退其他 runtime/profile。
- 复用独立写 fixture、mock、reviewId、派发前持久化、before/write/after、取消/重启不重放、安装与 knowledge。mock/普通 validate 零实际写；页面请求使用隔离 world 与 same-origin Cookie/HttpOnly，不把 Cookie 提取到宿主。复核 main frame/loader/完整 URL，隔离 world 随机文档标记阻止同 URL 新文档/context ID 复用；15 秒请求/30 秒验证、4 MiB JSON、禁止重定向/缓存，过期不能迟发。回查也占用现有页面锁，不把 uncertain 变为已验证。
- 关键实测：初版一次 fetch 在响应连接被服务端断开后收到 3 次写请求；POST 与 PUT 均可发生，临时验证的 CDP Fetch 拦截未阻止底层重发，因此没有提交该拦截或放宽次数断言。最终契约强制作者确认服务端支持幂等，header 仅 idempotency-key/x-idempotency-key，key 按 taskId/reviewId 派生并在派发前落盘，审阅可见；普通 call 每次显式调用生成新 key。不能宣称网络只发一次，不能凭空填写 serverDeduplicates。最终四种方法丢响应各记录 3 次网络请求、1 次实际修改，同 review 重入没有新增请求；响应丢失仍 uncertain，回查可证当前效果但不能放行安装。未实现自动幂等协商或对任意服务端保证正确性。
- 实机正常链：声明→生成→mock→缺确认拒绝→GET before/一次逻辑写/GET after→重复 review 无重放→权限审阅→安装→普通 CLI 确认/准确字符串→知识。另覆盖无效果、重定向不抵达其他资源、before 失败零写、取消与真实 Bridge 重启后的不确定状态和只读回查。普通 Extension 缺确认从 stderr-only 修为结构化 CONFIRMATION_REQUIRED。公开 loopback 服务为唯一写目标，没有外部账号副作用。
- 最终验证：WebCLI **114 文件/1224 项**；扩展相关 **59 项**；源码早期页面专项 **7 项**（仅 POST/PATCH，早于最后加固）；最终打包 CLI＋打包 Bridge 页面专项 **7 项**（四方法丢响应、文档标记/完整守卫）；打包 CLI＋Bridge HTTP 探索/写回归 **12 项**；Chromium revision 1217 **完整 62 项**（最终生产代码，全部原 57 项＋5 项新增页面写）。CLI/Bridge 构建、公开配置、**17 个 JS/MJS** 语法、diff 格式通过；npm pack dry-run **616 文件**含新宿主模块、扩展 helper 与 Skill。常见敏感模式检查和占位浏览器 Cookie 在日志/任务/安装目录的遗漏检查通过。已有可选列映射资产构建提示保留；未测试实际平台安装包。
- 完整 Chromium 回归：本轮先用本机 revision 1194，第一次在上传场景 frame 查询后清理 close 超时，第二次通过上传/复合字段后在 Shadow 点击返回 FRAME_CONTEXT_UNAVAILABLE。隔离 `git archive 5cabcb8` 的旧源码在同一 1194 也复现相同 Shadow 错误，报告 `webcli-browser-acceptance-WQiSc2/report.json`；没有据此修改旧 frame 逻辑。发现本机另有 revision 1217 后重跑完整套件，**62 项全部通过**（`webcli-browser-acceptance-vLwE3H/report.json`）；覆盖本阶段最后生产代码，最后只另增加了一项文档标记/过期执行单测。旧版本兼容问题仍应单列，不把当前专项通过当作全平台完成。
- 临时报告：完整 1217 `webcli-browser-acceptance-vLwE3H/report.json`；最终页面打包 `webcli-browser-acceptance-KGCPFh/report.json`；HTTP 回归 `webcli-http-discovery-sOtzcn/report.json`；早期源码页面 `webcli-browser-acceptance-l6I1tL/report.json`；1194 失败 `webcli-browser-acceptance-xNJgHM/report.json`、`webcli-browser-acceptance-wR3eGG/report.json`；均在系统临时根。日志 `/tmp/weworker-page-write-all-complete.log`、`/tmp/weworker-page-write-extension-complete.log`、`/tmp/weworker-page-write-bundled-final.log`、`/tmp/weworker-page-write-http-regression.log`、`/tmp/weworker-page-write-browser-chromium1217.log`、`/tmp/weworker-page-write-build-complete.log`、`/tmp/weworker-page-write-pack.json`。脚本关闭自己创建的浏览器和服务；隔离报告与基线快照保留供诊断。
- 验收夹具修正：丢响应案例最初触发底层重发，升级为显式服务端幂等夹具并分别断言网络/效果次数；DELETE 案例 slug 含 delete，被保守只读 GET 回查守卫拒绝，改为无动作语义的公开 slug，没有放宽读取守卫。首次 npm pack 从根目录调用失败，改为 webcli 工作目录后 616 文件成功。所有安装/任务使用临时隔离根。
- 下一阶段仍优先：① UI 控件写/无幂等保证页面写的安全方案；② 写响应动态 ID 的只读回查、明确多步写；③ 知识冲突/共享与写修复；④ 复杂读流程、动态 query/hash/跨源/跨 frame、目录上传/跨 frame 拖拽/AX 标注/Worker 网络；⑤ CDP/Electron 外部目标、外部 CLI/插件/补全/输出和站点覆盖；⑥ 独立 Agent、跨平台与真实安装包验收。WeWorker 探索/聊天/profile UI 单列产品待办，不开发 OpenCLI 桌面客户端。整体目标未完成；在这个独立阶段核验完毕后按用户要求暂停并建议新开对话继续。


本阶段交付后按用户授权暂停整体目标（不是 complete），本地检查点 SHA 见 Git 最新提交；不推送/PR。建议新开对话，继续提示词：

> 请设置并执行目标：继续 `codex/api-exploration-cli`，核对 Git 最新检查点，先读 AGENTS.md、ROADMAP.md、docs/api_exploration_cli_handoff.md 顶部及末尾，再读相关设计与 docs/opencli_parity.md。沿用已完成的 profile、HTTP 探索/写、只读 workflow 和强制服务端幂等契约的 Extension PAGE_FETCH 写，优先推进 UI 控件写或明确多步写的下一个独立阶段。Chromium 1217 完整 62 项通过；1194 Shadow/frame 兼容问题独立保留。不要重复开发，不把局部通过当完整对齐；Python 网站探索agent全程不动，不开发 OpenCLI 桌面客户端，WeWorker UI 不计入本轮必要范围。自主实现、聚焦测试、真实/打包验收并更新三份进度文档；允许本地检查点，不推送/PR，单独授权事项保持待办。跨长上下文时在已验证阶段后更新交接并暂停、提醒新开对话；全部差距完成并验证才可 complete。


### 2026-10-18：实际写响应 ID 的只读资源回查

- 起点 `2bb411c`，当前 `codex/api-exploration-cli`，初始工作区干净；沿用既有 HTTP/PAGE_FETCH 写、profile、fixture、安装与账本实现。没有 fetch/merge/push/PR，没有新 Agent/用户对话；允许保存本地检查点，SHA 以 Git 日志为准。Python 网站探索agent源码、环境、测试、进程和数据全程不动；未改 CI/CD、发布、数据库 schema、.env、密钥、依赖/lockfile，也没有删除仓库文件。
- 选择交接允许的动态返回 ID 阶段，新增 `exploration-write-result.js`。effect.resultReadback 明确固定 URL 的单个 :id、publicId:true、responsePath、identityPath 和 expect；保留原固定 GET before/after 变化断言，通过后再 GET 资源并严格匹配实际 ID 与非 ID 内容。HTTP 从宿主已脱敏传输响应取 ID，不信作者 Worker 映射；Extension 从原固定 fetch 结果取 ID，继续原 profile/tab/文档/幂等契约。
- 声明只接受同写接口 origin、无 query/hash 的规范 URL；最多八段自有属性路径，不许通配符/敏感名/原型属性。ID 是 1–512 字符公开字符串，允许 Unicode 字母/数字及 `_.-`，拒绝点遍历、百分号、分隔符和数字类型，保留前导零。内容 equals 将 `$`/点路径别名规范化，不能用 `$.id` 冒充额外业务断言；模板和最终地址经过只读语义检查。
- write-review 摘要绑定全部声明并展示 ID 存储政策。实际只把 `{id}` 原子写入当前任务私有账本，先落盘再等待 handler/执行读取；摘要/get/list/trace/review、知识和安装包不带真实 ID，其余响应不落盘。fixture 仅用于探索验证，普通安装命令仍按既有单写/确认执行，不自动附加回查或保存返回 ID。
- 缺失/非法 ID、响应丢失、落盘失败、详情重定向、资源身份/内容错误、页面文档变化均不能通过安装。无持久 ID 的 write-readback 返回 WRITE_RESULT_ID_UNAVAILABLE，发送零 GET，不用 mock 或猜值，不重写找 ID；独立已授权只读检查仍由调用方决定。有 ID 后取消/Bridge 重启/handler 失败可两个 GET 回查，但保持 uncertain，不能自动变 verified 或放行安装。所有新步骤沿用原 30 秒预算，无写重试或自动回滚。
- 自动化：最终 WebCLI **115 文件/1275 项**，最终写相关 **4 文件/76 项**，扩展既有页面写/导航/workflow **14 项**通过。覆盖错误/缺失/非字符串/越界/原型/凭据路径、宿主凭据回显脱敏、作者伪造 ID、Unicode/前导零、精确身份/内容、ID 存储失败、页面回查间导航、摘要/知识遗漏、旧 fixture 兼容及重启只读恢复。
- 真实 CLI/Bridge：共享 `scripts/write-result-acceptance.mjs` 创建隔离 loopback 资源，来源声明→生成→mock 零请求→精确确认→固定 before/单次逻辑写/固定 after/实际 ID 资源 GET→重启回查→安装→知识成功。缺失/非法/丢响应不请求猜测详情，错误身份/内容/307 不认证；GET 详情进行中取消或真实终止 Bridge，恢复后只读成功、原写仅一实际效果、审阅不放行。HTTP 使用公开占位 AUTH，页面使用 HttpOnly 占位 Cookie 与服务端幂等；没有真实外站账户副作用。
- 源码 HTTP **15 项**、源码页面写 **10 项**；最终打包 CLI＋Bridge HTTP **15 项**、页面写 **10 项**通过。最终打包包含最后 ID 断言路径别名加固。报告：`webcli-http-discovery-4keDzj`、`webcli-browser-acceptance-eD9wSZ`、`webcli-http-discovery-SbvPth`、`webcli-browser-acceptance-QAwCGG` 下的 report.json，均在系统临时根。页面写原网络重发/实际效果分离的规则保持，不声称浏览器网络只发一次。
- 构建/分发：CLI＋Bridge bundle、公开配置、10 个变动/新增 JS/MJS 语法、diff 格式、npm pack dry-run **617 文件**通过，新模块和最新 Skill 包含在包内。沿用现有 Backend 的 esbuild（NODE_PATH），没有新增依赖；可选列映射资源缺失提示为既有提示。新增内容常见密钥/私网地址模式扫描零命中；最终 HTTP 156 文件、页面 141 文件的日志/任务/安装目录扫描未发现原始响应占位标记。未构建实际平台安装包。
- 验收过程修正：取消终态 review 的预期应为 INVALID_STATE，重启 interrupted 才是 VALIDATION_REQUIRED；修正测试而未放松终态。页面自动 favicon 请求最初计入业务请求数组，夹具改为只记录明确业务路径，同时保留未授权目的地零请求断言。首个构建缺主目录 esbuild，按既有交接 NODE_PATH 重跑通过。一次从仓库根误启 Vitest 扫描及时中断，不计入结果；上面的全量来自正确 webcli 目录。源码/早期打包报告早于最后别名守卫；最终 1275 项/76 项和最终双打包专项覆盖最终代码。
- 下一阶段：优先 UI 控件写与无幂等保证页面写的明确安全方案，或明确多步写；保留数字/多 ID/header/响应 URL/异步轮询回查、知识冲突/共享与写 repair、自定义控件/复杂只读流程/跨 frame、CDP/外部 CLI/插件/补全/输出和站点覆盖、独立 Agent 与跨平台安装包。WeWorker 自有 UI 为产品待办，OpenCLI 桌面客户端排除。全部对齐未完成，独立阶段验证后按用户要求暂停，不能 complete。
- 完整 Chromium revision 1217 **65 项全部通过**，报告 `webcli-browser-acceptance-8RIbK3/report.json`，包含原 62 项与新增三个响应 ID 实机检查。完整套件启动时快照早于最后 `$.id` 内容别名加固；最终 1275 项、76 项与两组打包专项覆盖该加固，未重复跑整套。1194 的既有 Shadow/frame 兼容问题仍待办，本轮未重测旧 revision；日常 Chrome/Bridge/B 站未操作。脚本停止了自己创建的临时服务和浏览器，诊断目录保留。
- 本阶段日志：`/tmp/weworker-result-all-complete.log`、`/tmp/weworker-result-focused-complete.log`、`/tmp/weworker-result-extension.log`、`/tmp/weworker-result-http-source-final.log`、`/tmp/weworker-result-page-source-final.log`、`/tmp/weworker-result-http-bundled-complete.log`、`/tmp/weworker-result-page-bundled-complete.log`、`/tmp/weworker-result-browser-full.log`、`/tmp/weworker-result-build-cli-complete.log`、`/tmp/weworker-result-build-bridge-complete.log`、`/tmp/weworker-result-pack-complete.json`。按本次明确要求在本地检查点后暂停整体目标，提醒新开对话续接。

下一对话建议：

> 请设置并执行目标：从 Git 最新本地检查点继续 `codex/api-exploration-cli`。先读 AGENTS.md、ROADMAP.md、交接文档顶部与末尾及 docs/opencli_parity.md。沿用已完成的 HTTP/PAGE_FETCH 单写、实际响应公开字符串 ID 回查、profile 与只读 workflow，推进 UI 控件写安全方案或明确多步写的下一个独立阶段。完整 Chromium 1217 为 65 项；最后断言别名加固另由全量 1275 项和最终打包专项覆盖。不得把局部验证视作完整对齐；Python 网站探索agent全程不动，OpenCLI 桌面客户端排除，WeWorker UI 单列。遵守既有范围和单独授权约束；只用隔离公开夹具验证真实副作用，允许本地检查点，不推送/PR。完成已验证阶段后更新文档并暂停，完整对齐前不得 complete。

### 2026-10-18：UI 原生表单单次提交与真实效果关联

- 起点核对：`codex/api-exploration-cli` / `0a97cfb300509e25acea21b7aae22a0d8621b187`，工作区干净。沿用 profile、HTTP/PAGE_FETCH、公开字符串响应 ID 与原写账本，无重复实现。没有 fetch/merge/push/PR；没有新 Agent 或新聊天。Python 网站探索agent代码、环境、测试、进程、生命周期、数据全程未动；CI/CD、发布、数据库 schema、.env、密钥、依赖/lockfile 未改，没有删除仓库文件。允许本地检查点，最终 SHA 以 Git 最新提交为准。
- 新增 `exploration-ui-write.js`、扩展 `background/ui-write.js`、`ui_write_v1` 和 `UI_SELECTOR + uiWrite` 契约。固定同源主文档/POST form action；1–10 个原生 text/search/textarea 公开字段、唯一 submit button 及精确文本、同节点 `data-*` 新回执关联。填写用隔离 world 原生 setter，无 input/change/click；核对唯一性、真实 name/归属、enabled/readonly、额外成功字段、override、validity、精确值、同一节点/文档，再一次 requestSubmit。固定注册模块，完整 route/controls/confirmation 进入 `ui-write:` 权限与摘要。声明不是执行证据。
- UI fixture 独立使用 expectedSubmission，不伪造 HTTP 请求/响应；离线模型零浏览器/零写。effect.argumentPaths 绑定每个输入至不同精确公开属性，after 严格等于参数；identityPath 必须在 before/after 保持同一非空公开字符串，确认关联字段必须改变。先 GET before、持久消费 reviewId、提交和页面新回执、再 GET after。页面确认和实际效果分别记录 confirmationVerified/effectVerified；错误身份/内容/无效果不能认证。禁止 UI response-ID 回查，未用 mock 或猜 ID 补齐。
- 复用任务持久账本、完整 digest/review、取消/重启不重放、只读恢复、安装与知识（ui_single_submit_v1，replayAllowed=false）。旧同值回执拒绝不是持久幂等机制。普通 call 强制确认，只返回页面匹配与 effectVerified:false；没有自动 GET、review 去重或业务成功保证，调用方须独立读取。输入填写失败不自动还原表单；扩展派发后即保守 uncertain，不能因后续零提交诊断而自动重用 review。
- 真实关键证据：没有服务端幂等支持的隔离夹具，响应连接断开后**1 次 submit 事件、3 次网络 POST、3 次服务端 mutation 执行**。实现不注入幂等键，不把一次应用派发等同网络一次或实际副作用一次；结果仍 uncertain，重复同 review 没有新增提交，独立 GET 可检查当前效果但不能放行安装。PAGE_FETCH 原有 serverDeduplicates 契约未放宽。成功提示无效果、错误资源身份、业务错误、挂起/丢响应、取消与真实 Bridge 重启均验证了不自动重放。
- 自动化：WebCLI **116 文件/1284 项**、写相关 **4 文件/80 项**、扩展 page-write/UI/query/workflow **18 项**通过；后两项包含字段/别名/确认/权限/固定模块/账本存储失败/旧能力拒绝/页面文档/节点变化/取消/超时等回归。最终全量日志 `/tmp/weworker-ui-all-final.log`，聚焦 `/tmp/weworker-ui-focused-final.log`，扩展 `/tmp/weworker-ui-extension-final.log`。
- 完整真实 Chromium revision 1217 **70 项全部通过**，报告系统临时根 `webcli-browser-acceptance-tUf5y3/report.json`，日志 `/tmp/weworker-ui-browser-full.log`。包含原有 65 项与新增五组 UI 检查，覆盖最终生产代码；之后只在验收增加同 URL 提交后重载场景并修正计数记录，没有改生产实现。1194 的既有 Shadow/frame 兼容问题未重测，仍待办；日常 Chrome/用户 Bridge/B 站未操作。脚本只停止自身创建的服务和浏览器。
- 最终打包 CLI＋Bridge HTTP **15 项**（`webcli-http-discovery-p0DRPD/report.json`，`/tmp/weworker-ui-http-bundled.log`）和 PAGE_FETCH **10 项**（`webcli-browser-acceptance-vQklUw/report.json`，`/tmp/weworker-ui-page-bundled.log`）通过。UI 源码早期 **7 项**（`webcli-browser-acceptance-F3sAIV`）早于最后身份路径/输出明确化；后续 UI 双打包 **7 项**（`webcli-browser-acceptance-z2wmxd`、`webcli-browser-acceptance-Vv1LTH`）覆盖最终生产代码。最后同 URL 重载专项最终结果见后续追加条目。所有目录位于系统临时根，不提交原始报告。
- 构建、公开配置、**19 个 JS/MJS** 语法、diff 格式检查通过；npm pack dry-run **619 文件**包含新宿主模块、扩展 helper 和更新 Skill。沿用 Backend esbuild 的 NODE_PATH，无新增依赖。既有可选列映射资源提示保留；未做实际平台安装包。最终 UI 临时根 94 个任务/安装数据文件与 Bridge 日志未出现原始占位 Cookie；新增内容常见凭据/私网模式扫描零命中。日志 `/tmp/weworker-ui-build-cli-final.log`、`/tmp/weworker-ui-build-bridge-final.log`、`/tmp/weworker-ui-public-config.log`、`/tmp/weworker-ui-pack-final.json`。
- 验收过程：第一次从根目录运行 npm test 因无 package.json 失败，随后用 webcli 目录/--prefix 正确执行，结果以上述正确运行计；npm pack stdout 包含 prepack 日志，按实际 JSON 起点解析确认清单。最后新增的同 URL 重载场景最初错误地要求新文档 window 计数仍为 1；修正为新文档计数 0、服务端请求仍为 1，并持续检查 uncertain/只读回查/无重放，未放宽生产守卫。无效果夹具的 mutation 计数改为只在实际赋值分支递增。
- 明确保留：受控组件/input/change/autosave、自定义控件/Shadow/frame、click/Enter 真实手势、hidden CSRF、原生整页提交导航、UI 响应 ID、异步效果轮询、多步写/写修复、数字/多 ID/header/响应 URL 回查；知识冲突/共享修复、复杂只读流程、外部 CDP/Electron/CLI、插件/补全/输出覆盖、站点/独立 Agent/跨平台安装包等台账差距。外部真实账户写操作未经授权，保持待办。OpenCLI 桌面客户端不开发，WeWorker 探索/聊天/profile UI 单列产品事项。
- 整体目标未完成；在本阶段最后验证和本地检查点后按用户明确要求暂停（paused，不是 complete），提醒新开对话续接。

下一对话建议：

> 请设置并执行目标：从 Git 最新本地检查点继续 `codex/api-exploration-cli`，先核对分支、HEAD 和工作区，阅读 AGENTS.md、ROADMAP.md、docs/api_exploration_cli_handoff.md 顶部及末尾，以及 docs/opencli_parity.md、设计和写契约。沿用 profile、HTTP/PAGE_FETCH 单写、公开字符串响应 ID 回查和 UI_SELECTOR 原生同文档表单单次提交，不重复开发。UI 实测一次 submit 可有 3 次网络请求和服务端 mutation，不能假设幂等；uncertain 永不自动重放，恢复先独立 GET。完整 Chromium 1217 为 70 项，WebCLI 1284 项；最新打包与重载分支见交接末尾，1194 兼容问题继续保留。按台账选择复杂控件/整页提交安全方案或明确多步写等下一独立阶段。Python 网站探索agent全程不动，OpenCLI 桌面客户端排除，WeWorker UI 单列。只用隔离公开夹具验证真实副作用；外部账号写和需单独授权事项保留。自主实现、聚焦/真实/打包验收、同步文档/Skill，允许本地检查点但不推送/PR。独立阶段验证后更新交接并暂停、提醒新开对话；全部约定差距完成验证前不得 complete。

最后验收完成：UI 双打包 **7 项全部通过**（包含同 URL 提交后重载、真正断开响应连接、挂起超时、业务错误、取消与 Bridge 重启），报告系统临时根 `webcli-browser-acceptance-ladEpX/report.json`，日志 `/tmp/weworker-ui-bundled-verified.log`。navigation 服务端只接收 1 次 POST，换文档后原执行仍 uncertain，独立只读回查通过且不重放；lost 为 1 次原页面 submit / 3 次 POST / 3 次 mutation。完整 70 项已覆盖最终生产代码，最后仅扩展上述测试与计数/文档说明；最后扩展 18 项仍通过；最终 UI 临时根 100 个任务/安装数据文件与 Bridge 日志未发现原始占位 Cookie。检查点后按用户要求暂停整体目标。

### 2026-10-18：数字响应 ID 与异步效果有界轮询

- 起点 `codex/api-exploration-cli` / `1b123da`，初始工作区干净。复用原 write fixture、审阅摘要、实际传输取 ID、私有执行账本、HTTP/页面 GET 和普通调用；未重新实现 browser 底层操作，没有新分支、Agent 或用户聊天。无 fetch/merge/push/PR，允许保存本地检查点。Python 网站探索agent的源码、环境、测试、进程、生命周期和数据未操作；CI/CD、发布、数据库 schema、.env、密钥和项目依赖/lockfile 未改，没有删除仓库文件。
- `exploration-write-result.js` 的 resultReadback 新增可选 idType=integer；mock/实际响应均限非负安全整数，含 0/最大安全整数，拒绝负数/负零/小数/越界/非有限数/数字字符串。未声明或显式 string 仍保持原 Unicode/前导零字符串限制。实际 ID 与读取资源用原类型严格比较，持久恢复不转换；只有拼接固定单段 URL 时编码文本。真实 ID 仍不进入 get/trace/review/知识/安装包。
- 新增宿主 `exploration-write-poll.js`，HTTP/PAGE_FETCH/原生 UI 共用。effect.poll 指定 intervalMs=250–5000、maxAttempts=2–20，以及固定 GET 的 pending / 资源 GET 的 resultPending 精确公开 equals；至少一个条件，至少一项与相应最终 equals 不同。每轮固定 after 通过才读实际 ID；仅完整匹配 pending 时等待，未声明状态/错误最终内容/身份错配/HTTP/网络错误立即停止。before 一次、写一次、UI 回执不重触发，默认无 poll 的旧 fixture 仍单次。总验证 30 秒、独立恢复 15 秒；不扩展写预算或服务端幂等假设。
- 所有页面轮次固定文档，恢复首轮绑定当前合法文档；同 URL 换文档不能继续读取。原生 UI 稳定资源身份在 pending 阶段也必须正确；字段/关联值最终精确校验不变。完成的 effectAttempts/readback.attempts 是观察轮次，不是网络/副作用次数，不记录响应正文。取消/重启/耗尽仍 uncertain；原 review 不重放，恢复匹配不升级/不放行安装。新 readbacks 锁阻止同任务并发回查/修改；cancel 可单独中断终态任务的回查，保留原写状态。
- 自动化：WebCLI **117 文件/1330 项**；新增结果/轮询与原 HTTP/页面/UI 写聚焦 **5 文件/126 项**；Extension 原 page-write/UI/query/workflow **18 项**通过。覆盖数字边界/类型、严格 pending/最终断言、共享期限、迟到成功、取消等待、旧 fixture、文档/身份错误、读取失败不重试、恢复不认证、安装与知识。全量覆盖最终运行逻辑，之后仅更新 help/Skill/文档和验收夹具，无运行逻辑变更；最终追加探索服务回归共 **6 文件/159 项**通过（`/tmp/weworker-async-write-focused-final.log`）。
- 源码 HTTP 与最终打包 CLI＋Bridge HTTP 均 **18 项通过**，报告系统临时根 `webcli-http-discovery-s2Z9BY/report.json`、`webcli-http-discovery-W0g6nK/report.json`。真实 loopback 请求包含数字 0、延迟可见固定/资源状态、资源数字/字符串错配、越界 ID、次数耗尽、轮询等待取消、终态独立回查取消、实际停止/重启 Bridge，以及重新只读匹配后仍 uncertain。每个新场景原写均 1 次，未用猜测 ID 或 mock 替代实际传输。PUBLIC/AUTH 与页面 Cookie 隔离夹具不代表所有认证组合/真实账户写验收。
- 最终 Chromium revision 1217 **双打包完整回归 74 项全部通过**，报告系统临时根 `webcli-browser-acceptance-M3Jig2/report.json`，bundledCli/bundledBridge 均 true，覆盖最终运行逻辑、帮助/Skill 与验收夹具；之后仅更新文档。包含原 70 项与新增三个页面数字/轮询组及一个 UI 轮询组。同 URL 轮询间换文档记录 PAGE_WRITE_DOCUMENT_CHANGED，零后续 GET；成功页面场景 4 轮，失败/取消/重启后的恢复匹配仍 uncertain。UI 延迟效果正确通过，pending 阶段错误身份仅读一轮即失败，两种情况各一次 submit、零 input/change。源码页面专项的首次运行使用旧夹具路径，见下方失败原因，不能计为完整成功。1194、其他品牌/系统和实际平台安装包未重验；日常 Chrome、用户 Bridge 和 B 站未操作。
- CLI/Bridge 构建、公开配置、**10 个 JS/MJS** 语法、diff 格式、npm pack dry-run **620 文件**通过，包含新 polling 模块和更新的探索 Skill。包清单仅加文件，无新运行依赖；现有缺失可选列映射资源提示保留。Skill 按 skill-creator 同步并 quick_validate 通过；系统及捆绑 Python 缺 PyYAML，使用独立 `/tmp/weworker-skill-validation.*` venv 安装校验依赖，未触碰项目或网站探索agent环境。新增内容常见凭据/私网模式扫描零命中。
- 验收修正：初版轮询缺 strict-output-contract 的 version 标记，聚焦测试发现并修正后 126/1330 通过。HTTP/页面早期脚本使用 pollcancel 作为 GET 路径，被既有 READ_ONLY_REQUIRED 拒绝；改为 pollstopped，未放宽读取语义守卫。HTTP 源码/打包最终成功；页面最终双打包完整 74 项覆盖该修正。没有把首次失败或旧快照的部分结果算为通过。
- 日志：`/tmp/weworker-async-write-all.log`、`/tmp/weworker-async-write-focused.log`、`/tmp/weworker-async-write-extension.log`、`/tmp/weworker-async-write-http-source-final.log`、`/tmp/weworker-async-write-http-bundled.log`、`/tmp/weworker-async-write-browser-bundled-full.log`、`/tmp/weworker-async-write-build-cli.log`、`/tmp/weworker-async-write-build-bridge.log`、`/tmp/weworker-async-write-config.log`、`/tmp/weworker-async-write-pack.json`、`/tmp/weworker-async-write-skill-validation.log`。临时证据可能清理，缺失时按脚本复跑；不提交原始请求/任务报告。
- 最终隐私检查：源码与打包 HTTP 各 249 个文件、双打包完整浏览器 2676 个 Bridge 日志/任务/安装数据文件，均未发现原始占位凭据或未保留响应标记。Git 变更未触及排除目录/受保护配置，项目依赖声明与 lockfile 一致。脚本只停止自身创建的临时 Bridge/浏览器/服务，报告保留供诊断。
- 本阶段保存本地检查点（SHA 见 Git 最新提交及最终回复），不推送/PR；按用户在上下文不足时的交接约定暂停整体目标，状态为 paused，**不是 complete**，建议新开对话继续。
- 剩余：多 ID/header/响应 URL/UI 响应 ID；复杂受控 UI/hidden CSRF/click/Enter/完整导航/Shadow-frame 生成；多步/批量写/结果传递/部分成功恢复/多写用例；写与共享文件 repair/知识冲突；复杂读流程/浏览器控件/截图与设备状态/API 文档认证扩展。插件管理/补全/输出全覆盖、站点和应用命令映射、外部 CDP/Electron/CLI、Worker 网络/流式正文/回放仍先审计。1194、跨平台/安装包、独立 Agent、代表站点/认证组合与未授权外部账户写明确保留。最新分类见 opencli_parity 当前范围表；不开发 OpenCLI 桌面客户端，WeWorker 自有 UI 单列产品待办。

下一轮提示词：

> 继续 `codex/api-exploration-cli` 的完整 OpenCLI 对齐目标，核对最新本地检查点和干净工作区。先依次读 AGENTS.md、ROADMAP.md、交接顶部与末尾，再读对齐台账、设计与写契约。沿用已完成的 profile、HTTP/PAGE_FETCH/原生 UI 单写、公开字符串/显式非负安全整数 ID 回查与有界 pending GET 轮询；不重复开发，uncertain 不自动重放、不因恢复匹配放行安装。按当前范围表推进下一个独立阶段，未知项先审计，复杂 UI/多步写/写修复等仍未完成。Python 网站探索agent全程不动；不开发 OpenCLI 桌面客户端，WeWorker UI 单列。只用隔离公开夹具实际写，不操作未授权外部账户或单独授权事项；自主实现、相关聚焦/真实/打包验收并同步文档/Skill。允许本地检查点，不推送/PR；上下文不足时在已验证阶段后更新交接、暂停并提醒新开对话，整体范围全部实现验证前不得 complete。


### 2026-10-18：UI 公开新回执 ID 与资源效果回查（起点 05b4b44）

- 当前分支仍为 codex/api-exploration-cli，接手 HEAD 05b4b44 且工作区干净；按顶部/末尾/台账/设计/契约顺序阅读。本轮只推进已列明的 UI 新资源 ID 缺口，无上游同步、推送或 PR。
- uiWrite.result 增加同 confirmation 节点的明确公开 data-* ID 属性、publicId:true 和显式 string/integer；完整契约计入 ui-write 权限/包摘要，ui_write_result_v1 在普通调用、validate 和实际验证派发前拒绝旧扩展，不回退 profile。
- 同一新关联回执同步读取相对提交前变化的 ID；不接受其他节点、原值、缺失/非法 ID 或换文档。字符串保留前导零/Unicode；DOM integer 文本只收规范非负十进制安全整数，解析后保持数值类型，拒绝前导零、符号、指数、小数/越界。输入仍不触发 input/change，一次 requestSubmit 不保证一次网络/实际修改。
- UI fixture 配套 effect.resultReadback，responsePath 固定 resultId、类型与契约一致。固定 before/after 的稳定身份、全部输入、改变关联值保持；动态资源 expect 也必须按同一 argumentPaths 逐项等于全部输入。离线模型的公开占位 ID 仅用于契约验证，实际回查只用新回执 ID。
- 新回执 ID 先以最小 {id} 保存到任务执行账本，再通过原同源模板/严格类型身份/内容校验/有界 pending GET 轮询；总验证 30 秒、独立恢复 15 秒保持。存储失败不继续效果 GET；缺持久 ID 恢复零 GET。取消/重启已保存 ID 可只读回查，uncertain 不升级、不放行安装；普通 call 返回 resultId/effectVerified:false，不携带验证 fixture 或增加 GET。
- 已通过：WebCLI 全量 **117 文件/1341 项**、最终聚焦 **8 文件/152 项**、扩展 **16 项**；源码 UI 实机 **11 项**；双打包 HTTP **18 项**。CLI/Bridge 构建、公开配置及其 **3 项**测试、**11 个 JS/MJS**语法和 diff 格式检查通过；npm prepack/dry-run **620 文件**含最新模块/扩展/Skill，生成扩展和打包 Skill 与源码逐字节相同。沿用 Backend esbuild NODE_PATH，无新依赖/lockfile 改动，既有可选列映射资源提示保留。
- 源码 UI 实机覆盖 string/0/integer、新 ID 实际资源、pending、缺失/陈旧/非规范 ID、资源类型/内容错误、安装普通调用以及 ID 落盘后取消/真实 Bridge 重启。所有 uncertain 场景不重放、不因独立回查匹配放行安装。源码 UI 报告为系统临时根 webcli-browser-acceptance-Yf8BwE/report.json；HTTP 双打包为 webcli-http-discovery-ObwTmR/report.json；Chromium 1217 双打包完整 **77 项全部通过**，报告为 webcli-browser-acceptance-pKjtIB/report.json，bundledCli/bundledBridge 均 true；覆盖最终代码、Skill 和夹具，之后仅文档更新。
- 首轮源码 UI 在安装后页面计数断言失败：现有安装目录刷新会重载页面、重置窗口计数，不能期待累计两次提交。改为安装前验证一次 submit/零 input-change，普通调用以独立服务端记录检查新增一次 POST；服务器按实际 ID 保存独立资源。随后完整源码 UI 11 项通过；不将首次失败计入通过。
- 源码 UI 最终 **227 个**日志/任务/安装文件检查未发现原始占位 Cookie/未保留响应标记；真实字符串 ID 仅在 resultBinding 私有账本中，移除该字段后不在任务摘要/包/知识/日志出现。新增内容常见凭据/私网模式检查通过，排除目录和受保护配置未动；最终双打包完整 **3238 个**日志/任务/安装文件隐私检查通过，公开 ID 只在最小私有 resultBinding 保存；相关账本权限 0600。失效 ID 零资源 GET、取消/重启各一次 POST 的记录核对通过。脚本已停止自身创建的临时服务/Bridge/浏览器，保留诊断报告，未操作日常 Chrome/用户 Bridge/B 站。
- 保留欠账：任意 UI 网络响应拦截、多 ID/header/响应 URL；复杂受控 UI、hidden CSRF、click/Enter、整页导航/Shadow-frame 生成；多步/批量写、部分成功恢复、多写用例、写/共享文件 repair 与知识冲突；其他复杂读取、外部 CDP/Electron/CLI、插件/补全/输出/站点映射未知项先审计。1194、其他品牌/系统、实际安装包、独立 Agent、认证组合和未授权外部账户写仍未验收。Python 网站探索agent全程未动；OpenCLI 桌面客户端排除，WeWorker UI 单列产品事项。全部约定差距完成验证前不得标记整体完成。
- 日志：/tmp/weworker-ui-id-all-final.log、/tmp/weworker-ui-id-focused-final.log、/tmp/weworker-ui-id-extension-final.log、/tmp/weworker-ui-id-browser-source-final.log、/tmp/weworker-ui-id-browser-bundled-full.log、/tmp/weworker-ui-id-http-bundled.log、/tmp/weworker-ui-id-build-cli-final.log、/tmp/weworker-ui-id-build-bridge-final.log、/tmp/weworker-ui-id-config.log、/tmp/weworker-ui-id-prepack.log、/tmp/weworker-ui-id-pack.json。报告可能被系统清理，缺失按隔离验收脚本复跑。


下一轮接手：从 Git 最新本地检查点继续完整 OpenCLI 对齐目标，依次读根 AGENTS.md、ROADMAP、本文顶部和末尾，再读台账、设计及写契约。复用 profile、HTTP/PAGE_FETCH/原生 UI 单写、字符串/数字响应 ID、UI 同节点公开新回执 ID 与有界 GET 轮询，不重新开发。按最新范围表推进复杂 UI/多步写/写 repair 等下一个实际缺口，未知项目先审计。精确审阅、派发前持久消费、uncertain 不自动重放、只读恢复不放行安装和隔离公开副作用验收保持；单独授权事项仍需单独确认。允许本地检查点，不推送/PR；Python 网站探索agent和 OpenCLI 桌面客户端排除，WeWorker UI 单列。77 项双打包回归不代表 1194/跨平台/安装包/真实账户等欠账已完成，全部范围实现验证前不得标记整体完成。

### 2026-10-18：已安装 HTTP 单请求写命令定向修复

- 起点 `35cd7f8`（承接 `05b4b44` 的数字 ID/轮询与 UI 新回执阶段），分支 `codex/api-exploration-cli`。复用当前工作区；未 fetch/merge/push/PR，无子 Agent/新聊天。Python 网站探索agent源码/环境/生命周期/数据未动；没有修改 CI/CD、发布、数据库 schema、.env、密钥、依赖或 lockfile，没有删除仓库文件。允许本地检查点，最终 SHA 见 Git 最新提交。
- `repair-info/repair` 现支持原 HTTP 单请求 write 命令：明确声明/观察来源、已有 canonical ID、原 risk/runtime、完整 origins/auth/cookies/version/strategy；仅选定模块/schema/description 可改。其他命令、共享文件、路由、权限保持。服务 scope 保存 writeCommandIds，作者 source.json 不能自授权。PAGE_FETCH/UI 固定写契约与共享文件修复仍不支持。
- 知识导入只取命令 packageDigest 与当前安装包一致、kind=http_single_write_v1 且可按新来源重新规范化的 fixture；缺失/旧摘要/非法/超限按工具列出跳过原因。fixture 是待复验数据，不复制执行、真实 ID、reviewId 或授权。普通 validate 只跑 mock 与选中读 cases；新 write-review 绑定修复任务、范围和当前摘要，返回 authorizationInherited:false。真实 before/write/after 复用数字 ID、有界 pending GET、严格资源身份和持久消费；审阅、before GET 后、HTTP 派发前及安装均复核基线。取消/重启/丢响应不重放，uncertain 的独立回查不认证、不安装。修复不是失败业务写的自动重试。
- 自动化最终 WebCLI **117 文件/1355 项**，聚焦 **7 文件/139 项**，扩展 page-write/UI/query/workflow **20 项**通过。新增场景覆盖字段漂移 mock 失败后修复、混合读写、缺失/旧摘要/非法/新来源不匹配的历史 fixture、原权限和共享/其他读写命令保护、跨任务授权拒绝、审阅/派发/before GET/安装时基线变化、数字 ID/轮询与取消/重启恢复。最终全量 `/tmp/weworker-write-repair-all-final.log`，聚焦 `/tmp/weworker-write-repair-focused-final.log`，扩展 `/tmp/weworker-write-repair-extension.log`。
- 真实源码和双打包 CLI＋Bridge HTTP 均 **21 项**通过：系统临时根 `webcli-http-discovery-GivtMF/report.json`、`webcli-http-discovery-CSA8WW/report.json`。新增 `write-repair-acceptance.mjs` 在独立 AUTH loopback 改响应 title→label；旧实现 mock 失败且零请求，修复后新确认、一次 PUT、固定状态 pending→ready GET 和实际数字 ID 资源 GET 通过，再安装、普通调用、保留读/写命令调用和知识保存。取消、真实 Bridge 重启、丢响应始终 uncertain，不补造缺失 ID、不重写。每组最终 349 个日志/任务/安装文件占位凭据及非持久响应扫描通过；未接入浏览器/真实账户。
- CLI/Bridge 构建、公开配置与 3 项配置测试、**10 个 JS/MJS** 语法、diff 检查通过；npm prepack/pack dry-run **620 文件**含更新模块及项目 Skill，无新增依赖，沿用 Backend esbuild NODE_PATH。既有可选列映射资源提示保持，未做实际平台安装包。日志 `/tmp/weworker-write-repair-build-cli.log`、`/tmp/weworker-write-repair-build-bridge.log`、`/tmp/weworker-write-repair-prepack.log`、`/tmp/weworker-write-repair-pack.json`。
- 验收过程已修正的脚本问题：HTTP request 的 auth 应在 start 声明，生成摘要 Adapter 名从 manifest 取；终态 write-review 仍按原契约拒绝，历史结果使用 get/trace，不开放终态写入口。第一次完整 Chromium 在 29 项后遇动态详情响应捕获竞态：状态 200，但 bodyKind=none。脚本原先只等 fetch 响应头即 collect；现等待正文并最多 20 次重新读取结构证据，不重发请求、不放宽生产校验。失败报告 `webcli-browser-acceptance-cfEOZF/report.json` 保留；最终完整复跑结果另见下条。
- 保留范围：PAGE_FETCH/UI 契约修复、共享文件/知识冲突修订、复杂 UI 与多步写、多 ID/header/响应 URL、任意精度/负数 ID、循环/分支、YAML/更广 API 发现、任意签名/OAuth、外部 CDP/Electron/CLI 和分发/站点映射审计。1194 兼容、其他系统/浏览器/安装包、独立 Agent、Cookie 写修复全部认证组合与真实账户验收仍欠账。OpenCLI 桌面客户端排除，WeWorker UI 单列，完整目标未完成。

- 完整 Chromium 第二轮通过 65 项后在既有 pollsuccess 夹具失败：固定 700/1600 毫秒窗口在慢机器首次资源 GET 前已结束，断言未观察到多次资源 GET。改为每个端点前两次实际读取返回 pending，随后 ready，保留必须重复 GET 的断言；生产轮询规则/预算完全不变。失败报告 `webcli-browser-acceptance-umaO9Z/report.json` 保留，随后重跑完整 Chromium 和源码/双打包 HTTP。

- pending 夹具修正后的最终 HTTP 复跑：源码 `webcli-http-discovery-ARxi8n/report.json`、双打包 `webcli-http-discovery-raWefC/report.json` 各 **21 项**通过，每组最终 **349** 个日志/任务/安装文件隐私扫描通过。日志 `/tmp/weworker-write-repair-http-source-final.log`、`/tmp/weworker-write-repair-http-bundled-final.log`，替代同阶段前两份 HTTP 报告作为最终脚本证据。

- 最终 Chromium revision 1217 双打包完整 **77 项全部通过**，报告 `webcli-browser-acceptance-moN3yr/report.json`，日志 `/tmp/weworker-write-repair-browser-full-complete.log`。包含上述两处等待夹具修正、当前生产实现与全部原有 profile/HTTP/页面写/UI 回执 ID 回归。最终 **3238** 个 Bridge 日志/任务/安装文件凭据及非持久响应标记扫描零命中；改动内容常见密钥/私网模式扫描零命中。日常 Chrome、用户 Bridge、B 站与外部真实账户未操作；脚本仅停止自身临时服务/浏览器。1194 兼容及跨平台欠账没有因此关闭。

下一轮接手：从 Git 最新本地检查点继续当前分支和完整 OpenCLI 对齐目标。按根 AGENTS.md、ROADMAP、本文顶部/末尾、台账、设计及写契约读取；复用 HTTP/PAGE_FETCH/原生 UI 单写、数字/字符串实际 ID、公开 UI 回执 ID、有界 GET 轮询和新增 HTTP 写命令定向修复。下一实际差距可从 PAGE_FETCH/UI 写契约修复、共享文件修复、复杂 UI/多步写中审计选择；未知生态/外部目标项目先核对现有实现。默认 validate 不写，精确授权、派发前持久消费、取消/重启不重放、uncertain 只读恢复不认证与隔离副作用验收保持。允许本地检查点，不推送/PR；Python 网站探索agent排除，OpenCLI 桌面客户端排除，WeWorker UI 单列。阶段完成不代表整体完成；全部约定范围实现并验证前不得标记完整目标完成。


### 2026-10-18：持续目标 R01 与 U02（6420583 接续，进行中）

- 已建立 active 目标，核对分支、干净起点和最新文档，新增 V/R/W/B/A/U/E 可追踪清单。禁止以阶段/检查点/交接作为停止条件；整体没有完成。无 push/PR/新聊天/子 Agent，Python 网站探索agent与受限范围未动。
- R01：PAGE_FETCH/UI 声明式写契约 repair 绑定新计划与服务端 scope，允许同源明确路径/字段/控件变化，保持 runtime/safety/策略/方法/幂等、包权限、共享文件和其他命令。历史 fixture 按摘要/kind/新契约重新规范化，不导入执行、实际 ID 或授权；派发前最后异步检查之后复核安装基线。
- R01 证据：源码 Chromium 专项 6 项 `webcli-browser-acceptance-cgt3nM/report.json`；双打包 HTTP 21 项 `webcli-http-discovery-Ov31on/report.json`；聚焦 193 项、扩展写/查询/workflow 20 项通过。初版全量 1361 项，增加输出后 1374 项，再加补全后 120 文件/1383 项。日志 `/tmp/weworker-page-repair-focused-complete.log`、`/tmp/weworker-page-repair-extension.log`、`/tmp/weworker-parity-all-final.log`。这些只覆盖各自快照。
- 完整浏览器第一次在 pollsuccess 出现 PAGE_WRITE_DOCUMENT_CHANGED，写已派发故正确 uncertain；报告 `webcli-browser-acceptance-xh1P1K`。根因之一是多页刷新先等待前页再占后页队列，现改为同步预留全部匹配页。复跑 `webcli-browser-acceptance-z5XAZA` 通过数字/轮询后，在 UI 成功场景服务端一次 POST、页面提交计数却为 0：第二层原因是全目录通知逐 Adapter 重新取页面，匹配同站点的包重复重载并纳入新开的页面。现改为整批一次页面快照、全队列预留、每页一次重载；没有放宽文档身份、效果或提交次数断言。扩展 tool-route 28 项通过 `/tmp/weworker-refresh-batch-final.log`，完整最终复跑日志 `/tmp/weworker-parity-browser-batch.log`，结果待补。
- U02 上游 1.8.8 output/completion 实现审计：已有 markdown/JSON/JSONL 和列映射复用，补 table/plain/CSV/YAML、md/yml；业务 --format 不被占用，管理默认 JSON、管道 JSON、终端 markdown 保持，非 JSON follow 调用前拒绝。YAML 同 JSON 模型、字符串引号；CSV 完整转义并保留后续行字段。最新还补 list、Adapter list/info、全局及三级 help 显式格式。源码/打包最新输出各 5 项：`webcli-output-acceptance-cNcAJZ` / `webcli-output-acceptance-NWutFI`，真实 HTTP 和独立 PyYAML/CSV 解析器核对，日志 `/tmp/weworker-output-source-complete.log` / `/tmp/weworker-output-bundled-complete.log`。
- U02 补全：首级命令/Adapter、二级 namespace/command/alias；catalog/帮助只读发现，旧版 parser 新 namesOnly 分支不求值元数据/getter/schema/动态名字，不运行 Python 或连接 Bridge。源码/打包各 4 项 `webcli-completion-acceptance-c95JEt` / `webcli-completion-acceptance-ojFRrT`。真实 macOS Bash 3.2/Zsh Tab、Fish 4.9.3 原生 complete -C；Fish 从官方 Homebrew bottle 临时解包，SHA-256 `c530bd62ac9277e7e1ae3de9ff5e0a83fdb5f49d39f456ce8f61dce6f56dd8c3` 核对，不安装、不改 shell 配置。日志 `/tmp/weworker-completion-source-final4.log` / `/tmp/weworker-completion-bundled-final.log`。Fish 交互 PTY 因终端能力协商未进入提示符，改用其真实 completion 引擎接口，不声称交互 Fish Tab 已验。
- 过程失败保留：R01 脚本多余 write-verify 参数、测试 import 路径和错误 config 脚本入口已修；输出验收先忽略 result/trace_id 包装后修正测试；补全初稿模板插值语法、夹具 legacy 名/module 路径、PTY 的旧 Bash bind 不支持/关闭顺序导致等待已修。Fish GitHub 下载失败，Homebrew info 触发 portable Ruby 下载时已停止自身进程，未完成安装，改为官方 bottle 显式临时下载，断点续传后核验摘要。未操作日常 Chrome/Bridge。
- 新 list/help 测试后全量 120 文件/1384 项，其中 1 项 `extension-v2-wiring` 仍期待旧 refreshAdapterTabs 字符串，已改为 batch 入口；实际队列行为另由 extension 运行测试验证。最终聚焦/完整回归、npm pack、Skill 与隐私检查待补，不以早期通过冒充最终快照。
- 探索 Skill quick_validate 已通过；通用 WebCLI Skill 原有顶层 version 1.0.4 不受 system quick_validate 接受，保留现有兼容字段，必须单独报告此限制，不能说该校验全部通过。
- 下一项已开始审计 R03：上游 site-memory.md 要求字段冲突先凭真实样本/页面复核，已有 key 不默默覆盖；本项目已有字段冲突拒绝、CAS/过期和验证后保存，缺显式修订历史。继续实现之前先绑定当前验证证据并保持旧映射可追溯。U01 管理生态/validate/verify/convention-audit 审计也发现上游 verify --smoke 在发布包缺测试时明确失败，不能仅凭命令名当作已实机能力；其余完整清单继续。


### 2026-10-18：R01/R03 验证与 U01/U02/U03 持续推进（仍 active）

- 当前仍为 codex/api-exploration-cli，起点 6420583；后续本地检查点见 Git。没有 push/PR/新聊天/子 Agent；没有修改 Python 网站探索agent、CI/CD、发布配置、数据库 schema、.env、密钥或依赖，没有删除仓库文件。构建仅 CLI/Bridge/扩展资源。
- R03：`knowledge-revise` 以当前小于 30 天的真实 cases 或独立 effect 断言为证据，CAS、旧映射、任务/包摘要和完整历史；写回执/mock 不够，uncertain 拒绝。HTTP 实际漂移→旧用例失败→修复→安装→修订→旧 hash/包拒绝→重启通过；UI 独立效果修订和失败拒绝通过。不改存储版本，不执行请求，不保存实际 ID 或新授权。
- 刷新修复经历多次真实失败：单页排队、多包重复快照、延迟/重连通知仍可重载 UI，造成计数清零或 PAGE_WRITE_DOCUMENT_CHANGED。失败报告 xh1P1K、z5XAZA、ifmLlm、0Fg0SC、2Gp3Dl、doTHJQ、OtrNkI 均保留，不计通过。最终 managed v2 复用原 Runtime clear/reinject、不重载页面；legacy 保留其声明重载需求。通知串行、整批页面快照、全队列预留、按目录指纹和已刷包集合去重，已导航页面不清除/重载，最新 snapshot 页面跳过。没有减弱文档身份、效果断言或重放写。
- 双打包 Chromium 1217 完整 **82 项**通过：系统临时根 `webcli-browser-acceptance-GU5stL/report.json`，日志 `/tmp/weworker-parity-browser-reinject-full.log`。此完整快照早于最后“同指纹不同包通知集合/已导航页面跳过”小加固；最终代码另通过扩展 **59 项** `/tmp/weworker-parity-extension-final.log` 和双打包 PAGE_FETCH/UI 修复专项 **6 项** `webcli-browser-acceptance-2D6jSb/report.json`（`/tmp/weworker-page-repair-scope-final.log`），不得称 82 项全量覆盖最后小改。最终 UI 专项 **12 项** `webcli-browser-acceptance-458iua`；源码修复专项 **6 项** cgt3nM 保留。
- HTTP 源码/双打包知识修订各 **22 项**：jSIZAj/jo5Dpr；最新双打包复跑 `webcli-http-discovery-5HLDYb/report.json` 仍 **22 项**，日志 `/tmp/weworker-http-bundled-current.log`。此前只属于阶段快照的 21 项未覆盖新修订，不混用。
- U01 随包 `skills list/read` 仅读本包，原文/JSON/六格式，拒绝 traversal/链接/特殊文件，512 KB UTF-8 限制。实际四个 Skill 中 complex-task-planner 带 BOM，首轮解码错误去掉 BOM；已修为保留 BOM 且元数据兼容，失败报告 kE7X4L 保留。源码/打包各 **4 项**：`webcli-skills-acceptance-PXZlQS` / `webcli-skills-acceptance-Ndhex6`，包括四 Skill 原文逐字节比对、格式和失败。当前包没有参考文件；参考路径由临时聚焦用例覆盖，不冒称实际参考文件已验。
- U01 新增 `adapter status [id]` 包括 active/disabled/被遮蔽/无效候选；`adapter validate <dir> | --installed [id]` 复用包/来源/权限/摘要校验及 JS 只编译不执行。未知/非 active/篡改/全局损坏不以空结果通过；报告不含路径，executed:false。冻结 legacy 和 Toolkit Python 语法明确未检查；统一 verify/evidence、convention-audit、eject、Git/monorepo 等仍开放，见管理审计与诊断文档。
- U02 AdapterHub 复用既有 JSON 输出路径统一六格式/help/错误；未知格式在请求前失败，参数退出 2/运行退出 1，源/权限/确认策略保持。源码/打包真实 loopback 目录、包下载/字节校验、安装/dry-run/实际更新和 v2 诊断各 **5 项**：`webcli-management-acceptance-AHP0om` / `webcli-management-acceptance-kzCfd2`，日志 `/tmp/weworker-management-source-final.log` / `/tmp/weworker-management-bundled-final.log`。没有真实发布、凭据变更或卸载。初版单测期待英文错误而实现已有中文文案，修正断言后通过，未改变错误策略。
- 输出源码此前 cNcAJZ/打包最新 Wf2RFB 各 **5 项**；补全源码 c95JEt/打包最新 LX6nwI 各 **4 项**，Bash/Zsh 实际 Tab、Fish 原生 complete -C（不声称交互 Fish Tab）。日志 `/tmp/weworker-output-bundled-current.log` / `/tmp/weworker-completion-bundled-current.log`。其他 Adapter/服务管理格式与受限路径实际验收仍开放。
- U03 审计读取实际 1.8.8 cli-manifest、历史固定提交映射与当前 33 个包，生成 `docs/opencli_command_map_1_8_8.json` 的 **1366 命令/179 分组**逐项台账，附上游/本地源码摘要、参数声明和候选路径。150 名称候选、36 同包未匹配、1180 历史无映射，verifiedByThisAudit=0。无映射不证明别名/其他包没有等价能力；历史记录不当作当前验证。脚本 `audit-opencli-command-map.mjs` 有临时目录测试，不执行上游/本项目命令。已实际核对 juejin hot/recommend 上游与本项目四命令，当前无对应读取实现；属于可推进的真实差距。未复制上游业务代码。
- 最终 WebCLI **124 文件/1398 项**通过 `/tmp/weworker-parity-all-final-checkpoint.log`；扩展 **59 项**；CLI/Bridge 构建、公开配置/3 项配置测试、npm prepack/pack dry-run **623 文件**含新模块通过。探索 Skill quick_validate 通过；通用 Skill 既有顶层 version 不受系统 quick_validate 接受，兼容字段保留，不能声称该校验通过。
- 完整 Chromium 最终 **3822** 文件、UI **227** 文件、HTTP **349** 文件隐私检查通过：原始占位凭据/未保留响应标记零命中；真实字符串 ID 只在最小 resultBinding 私有账本，28/7/14 个绑定文件均 0600。日志 `/tmp/weworker-parity-privacy-final.log`。不扫描/操作日常浏览器和用户 Bridge 数据。最新修复专项另补最终扫描。
- 下一步继续完整台账，不能把本检查点作为停止条件：R02 共享文件、W01–04、B01–04、A01–02、U01 剩余管理、U02 入口、U03 全命令行为/验收、U04 外部 CDP/Electron、U05 external CLI、U06 Worker/流式/持久回放及 E01–04 欠账均保留。已开始读上游 external.js 和 observation/CDP 实现，尚不足关闭审计；静态 trace 导出不等于网络重放。1194/跨平台/实际安装包/独立 Agent/外部真实账户未因此通过；仅隔离公开 loopback 副作用、不操作未授权外部账户。

- 最终检查补录：双打包写修复专项 2D6jSb 6 项及隐私扫描通过；36 个 JS/MJS 语法检查、改动内容常见凭据/私网模式扫描、diff 格式通过。源码扩展与 extension-dist/npm 资源、全部打包 Skill 字节一致，受保护目录未改。此处之后保存本地检查点并继续 U01 剩余管理差距，整体不暂停、不 complete。


### 2026-10-18：b49b38c 后继续 U01 Adapter 导出

- 已保存前阶段本地检查点 `b49b38c`（包含 R01/R03/U01/U02/U03 台账），随后继续推进，没有暂停/完成目标。
- `adapter eject <id> --directory <new-directory>` 从有效 builtin 候选导出完整包，即使 user/development 当前有效仍取 builtin。拒绝已有/符号链接/名字不匹配/managed 目录，父目录必须存在；文件与摘要一致，不执行、不自动激活，不覆盖/删除。失败目录保留供检查。`develop/use` 复用既有权限和来源选择，新增显式六格式与帮助；切回 builtin 保留编辑副本。没有执行删除式 reset。
- 聚焦 3 文件 **26 项** `/tmp/weworker-eject-focused.log`；源码/打包独立真实 HTTP 各 **3 项** `webcli-export-acceptance-5eEGqe` / `webcli-export-acceptance-RQVmQq`，日志 `/tmp/weworker-eject-source-final.log` / `/tmp/weworker-eject-bundled.log`。实际三次 GET 分别返回 builtin→edited→builtin，复制阶段零请求，原文件及编辑副本保留。首轮 le55gu 误以为对象 call 在 result 字段，修正脚本读取既有顶层对象后通过；未改变生产返回。
- WebCLI **125 文件/1401 项**通过 `/tmp/weworker-eject-all.log`；CLI 构建、npm prepack/pack dry-run **624 文件**通过（`/tmp/weworker-eject-build.log`、`/tmp/weworker-eject-pack.json`）。这轮没有改 Extension/HTTP 执行或写契约，不重复完整浏览器；沿用上一阶段的对应证据。Python 网站探索agent和受限文件未动，无 push/PR/新聊天/子 Agent。
- 下一项 R02 已核对现有 writeRepairDraft/verifyRepairRetention：共享文件确实完全冻结，不能靠已有 draft-write 声称可修。拟以显式 sharedFiles 绑定服务 scope，并保守要求该包全部命令进入修复计划/重验，不信任作者声称的依赖子集；默认 validate 仍不实际写，含写命令仍需全部独立效果/新确认，未验证不得安装。实现和实机验证未开始，不标完成。


### 2026-10-18：5941067 后继续 R02 共享修复与管理审计（active）

- R02 `repair.sharedFiles` 绑定已有 internal 文本（最多 50 文件/每个 250000 字节、UTF-8 无 NUL），服务要求全包命令进入计划，不信任作者依赖子集；未选文件/权限保护，禁止增删。默认 validate 零写，所有读 cases 和所有写的新精确审阅/真实独立效果必须通过。编辑共享 helper 使旧审阅失效，历史执行/ID/授权不继承；原持久消费/uncertain 限制保持。
- 真实浏览器发现生成包自带登录辅助命令被旧策略固定跳过，导致全包重验不能完成，安装门禁正确拒绝。已仅为服务修复 scope 中的明确 read 计划、匹配新证据且有作者 cases 的辅助命令启用验证；普通生成仍跳过，缺证据/错 fingerprint/write 计划不能启用。源码 Chromium 1217 专项 **3 项** Q5Xhx9 通过，早于最后 read/fingerprint 显式条件加固；最终加固由全量及双打包覆盖。
- 源码/双打包 HTTP **各 24 项** A0l4bO/A94uMb 通过（日志 `/tmp/weworker-shared-http-source-final.log`、`/tmp/weworker-shared-http-bundled.log`）：两个真实读命令和一个真实写共享 mapper，部分计划拒绝，漂移失败，修复/三命令重验，helper 后改使旧审阅失效，新一次 PUT 效果、安装/重启无重放。前一源码 nUw2JN 24 项未覆盖后改审阅断言，不代替最终报告。
- R02 WebCLI **126 文件/1406 项** `/tmp/weworker-shared-all-final.log`；源码及打包 CLI/Bridge 构建、配置/3 测试、11 JS/MJS 语法、探索 Skill、npm pack 624 文件通过。HTTP 最终 **390 文件/14 私有绑定**、源码页面专项 **50 文件**隐私扫描通过。完整双打包 Chromium 在运行，报告 8pxFNg、日志 `/tmp/weworker-shared-browser-bundled-full.log`，未完成前不算通过。
- 失败保留：T1g5GO 验收脚本误读 bodyKind 层级；tAuNfc 初始计划误用 repair 的 kebab 名，生成期应 snake_case；Dvftsc 未计入生成登录辅助命令；Mmziq9 暴露上述实际跳过缺口。修正时未弱化真实效果或全包计数。辅助策略单测发现 read 计划条件不足后补强，最终全量通过；误重复 --run/根目录 npm 仅是调用错误，没有据此计通过。
- U05 完成 1.8.8 external.js/YAML/CLI 静态审计，13 内置元数据与注册/安装/原样 stdio 透传是本项目实际差距；Toolkit 不等价。见 opencli_external_audit.md，尚无实现或实机通过，不执行上游全局安装命令。
- U01 新增 `adapter convention-audit`，复用包来源/摘要与静态语法，不执行作者代码。七类声明/启发式提示附相对位置；混合大小写、反向写操作不是强制规则，不自动改名或增加删除。动态/helper/Toolkit/legacy 分析不在该范围，提示不是行为正确性证据。源码/打包各 **3 项** 6hyorY/QIgjeh（日志 `/tmp/weworker-conventions-source-final.log`、`/tmp/weworker-conventions-bundled.log`），聚焦 **7 项**、全量 **127 文件/1409 项** `/tmp/weworker-conventions-all.log` 通过。初版 fybebU 发现 results 被表格自动选择导致隐藏 findings，改报告 packages 结构保留所有格式提示，未削弱断言。最后增加结构化帮助行，需打包和聚焦复核。
- 全部工作使用当前分支，未 push/PR/创建新聊天/子 Agent；Python 网站探索agent、CI/CD、发布、数据库 schema、.env、密钥与依赖未动，没有删除仓库文件。整体目标 active；R02 最终浏览器、管理入口与完整台账均继续推进。

- U01 最终帮助/打包补录：最终双打包 CLI 静态审计 **3 项** `webcli-conventions-acceptance-dAtyu9`，聚焦 **7 项** `/tmp/weworker-conventions-focused-complete.log`，CLI build/prepack/pack **625 文件**（新 adapter-conventions.js）通过。源码 6hyorY、早期打包 QIgjeh 保留；最终包未改 Bridge/Extension 路径，不重复运行浏览器。探索 Skill 校验与公开配置通过；通用 Skill 既有 version 字段兼容限制保持，不声称其 system quick_validate 通过。

- R02 最终完整验收：Chromium revision 1217 双打包 **83 项全部通过**，报告 `webcli-browser-acceptance-8pxFNg/report.json`，日志 `/tmp/weworker-shared-browser-bundled-full.log`。此快照包含最终 R02 辅助命令 read/fingerprint 守卫及此前 managed 刷新加固，未包含并行开发的纯 CLI convention-audit。最新静态管理改动另由全量 1409/最终打包 dAtyu9 覆盖。最终 **3867 文件/28 私有 resultBinding** 隐私扫描通过 `/tmp/weworker-shared-browser-privacy.log`。无需日常 Chrome/用户 Bridge，1194/平台/独立 Agent/真实账户欠账保持。
- 本检查点之后继续 B01：已核对宿主 normalizePageQuery 与扩展 resolvePageDestination，navigate 确实只接受路径段，不支持声明式 query/hash；现有 search 的 matchQuery 仅校验搜索控件结果，不等价。下一步复用精确路径/文档身份/不重放/两组参数断言与安装权限，处理动态 URL 查询/片段，尚未实现，不标完成。整体目标继续 active。

### 2026-10-18：96c9fd1 后继续 B01 查询导航与 U06 审计（active）

- 重新核对 Git/目标/最新台账，保留已有未提交查询实现，未重建分支或重复已完成能力。上游 1.8.8 `clis/google-scholar/search.js:21`、`51job/search.js:61` 实际构造动态 query 后导航；本项目旧 search.matchQuery 仅校验控件结果、navigate 只接受路径参数，因此确认为声明式生成的实际缺口。未运行真实站点/账户。
- navigate 新增 queryParameters（name/queryKey/description，1–16 个），可查询串单独或与路径组合，workflow 同样接入。保留字符串/前导零/Unicode 与字面分隔符，完整 href/新主文档/稳定结果校验；禁止凭据、动作、redirect 键。旧选定 profile 缺 page_navigation_query_v1 时观察/验证/普通调用零派发、不回退。每个 query 参数需两个不同作者值，观察值不保存为默认/cases；manifest 权限与 scoped repair 固定完整映射。
- 初步全量 127 文件/1415 项 `/tmp/weworker-query-all.log`；最终聚焦 4 文件/57 项 `/tmp/weworker-query-focused-complete.log`，扩展 13 项 `/tmp/weworker-query-extension-final.log`。源码 Chromium 1217 导航专项 **8 项** `webcli-browser-acceptance-ma1h9k/report.json`，日志 `/tmp/weworker-query-browser-source-final4.log`，包含旧路径两项及新 query/修复/mixed/workflow 四项和启动两项；87 文件隐私扫描、额外 query/category 未保留标记扫描通过。最终全量和双打包完整回归仍运行，不提前计入。
- 失败与修复：sWks6T 使用旧 extension-dist，缺新 capability，正确拒绝；构建后复跑。4hJ1r4 验收误用参数错误的 ok 字段；jJ8cH2 workflow 夹具缺 DOM fields；IpMcoW 再暴露 workflow 的错误是结构对象而普通导航参数错误是字符串。最终按既有返回明确断言 error.code/message 和零请求，不修改生产协议、不弱化结果。提前启动的双打包 1DKJnP 加载旧验收脚本，也停在该断言；完整复跑日志 `/tmp/weworker-query-browser-bundled-final.log`，旧失败不算通过。
- CLI/Bridge build、公开配置/3 项配置测试、20 文件语法、探索 Skill quick_validate、npm prepack/pack dry-run **627 文件**含两端新 helper 通过；源码/build/npm 扩展模块字节一致。通用 Skill 既有 version 校验限制保持。
- U06 审计详见 opencli_network_audit.md：npm 中没有扩展源码，额外取得 v1.8.8 固定 tag 8271afc67e8504bda94c147f446ee29775d08274，核对 cdp/journal Git blob 摘要。上游完成后 getResponseBody 不等于未结束流，iframe 目标处理不等于 Worker 自发请求；命令 journal 的结果续取不等于流量重发。统一 trace/receipt/summary/network/console/state/screenshots 导出是本项目实际待补差距，其余保留隔离行为核对，没有静默缩减范围。
- hash 的实际上游例子是 `clis/gmail/utils.js:588–589`，可切换片段并等待站点响应；本项目不能直接放宽新文档守卫，否则可能读取旧数据。下一步独立设计明确 hash 目标与业务结果关联，不照搬其临时切回其他页面的行为。hash/循环/分支/跨源/frame、W/A/U 余项和 E01–04 全部保持；未 push/PR/创建新聊天/子 Agent，受限目录与 Python 网站探索agent未动。

- 后续证据：最终 WebCLI **127 文件/1416 项** `/tmp/weworker-query-all-final.log`、双打包 HTTP **24 项** `webcli-http-discovery-heIeNv` 及 390 文件/14 私有绑定扫描通过。完整 Baik7x 已通过新增 query/workflow，但重启知识断言仍预期旧 10 页，实际新增三来源后为 13；改为精确 13 并分别核对两个 query navigate 和一个 query workflow，继续完整复跑 `/tmp/weworker-query-browser-bundled-final2.log`。生产实现未改，不把此失败称为通过。
- U04 已补实际源码审计 `opencli_cdp_audit.md`，明确上游独立 CDPBridge/Electron registry/launcher 与本项目扩展内部 CDP 的差别；实现与实机仍待办。继续 B01 hash 参数/业务结果关联，现有 query 最终完整验收尚在运行，检查点只保留可追踪进度，不停止整体目标。

### 2026-10-18：本阶段最终验收与用户请求暂停

- 用户在本阶段执行中明确要求“完成本阶段任务后，在一个合适的时间点暂停目标，我新开对话继续”。此次暂停仅来自该最新授权；此前阶段后自动继续要求不作为阻止暂停的理由。整体目标未 complete，未缩减任何能力或验收范围。
- 代码已保存在本地 `53acae7`，随后仅修订本次最终证据与暂停交接。最终双打包 Chromium revision 1217 **87 项全部通过**：`webcli-browser-acceptance-RENsHF/report.json`，日志 `/tmp/weworker-query-browser-bundled-final2.log`。该快照包含最终 13 条知识来源及两个 navigate/一个 workflow 查询映射重启断言；前序 1DKJnP/Baik7x 为失败报告，不替代最终通过。
- WebCLI **127 文件/1416 项** `/tmp/weworker-query-all-final.log`；聚焦 **57 项**、扩展 **13 项**、源码导航专项 **8 项** ma1h9k、双打包 HTTP **24 项** heIeNv 均通过。CLI/Bridge 构建、公开配置/3 测试、20 文件语法与最后验收脚本语法、探索 Skill、npm pack **627 文件**、源码/打包/npm 扩展和 Skill 一致性通过。通用 Skill 既有顶层 version 与系统 quick_validate 不兼容仍保留，不冒称通过。
- 隐私检查：完整浏览器 **4450 文件/28 私有 resultBinding** 全部通过，实际 ID 仅最小私有绑定且权限 0600；另检查 query/category 观察标记零持久化。源码专项 87 文件、HTTP 390 文件/14 私有绑定也通过。最终日志 `/tmp/weworker-query-privacy-bundled-final.log`、`/tmp/weworker-query-privacy-source.log`、`/tmp/weworker-query-http-privacy.log`。报告均在系统临时根，可能由系统清理；复验命令仍在 scripts 中，不把临时证据丢失解释为已通过新的环境。
- 全部自建服务、隔离 Chromium 与本次 Bridge 随验收正常退出，核对没有残留本次验收进程。工作区只保留跟进文档更新，随后提交。未 push、未 PR、未新建对话/子 Agent；未操作日常 Chrome/用户 Bridge、真实账户、Python 网站探索agent、CI/CD/发布/数据库 schema/.env/密钥，也未删除仓库文件。
- 恢复时先核对分支 `codex/api-exploration-cli` 的最新日志及工作区，再按 AGENTS → ROADMAP → 本文顶部/末尾 → opencli_parity → design/http/write → exploration Skill 顺序读取。最新台账 W01–04、B01 hash/循环/分支/跨源/frame、B02–04、A01–02、U01/U02 余项、U03 全命令行为、U04/U05 实现、U06 行为与诊断导出、E01–04 验收欠账全部仍开放。代码没有半成品 hash 改动。
- 建议下一项仍为 B01 hash：已核对上游 Gmail 通过明确 fragment 跳转读取，需在本项目绑定固定主路径、显式片段参数和返回业务字段关联，并核对 loader/完整 URL/300ms 稳定数据。同一片段重复读取的新鲜度需独立方案，不直接放宽 query 的“新文档”守卫、不临时跳去任意页面、不用当前旧数据充当效果。实现、聚焦测试、隔离实机、文档/Skill 后继续台账；该设计方向尚未实现或验收。


### 2026-10-18：498ba61 后恢复持续目标，B01 hash（active）

- 已核对当前分支与干净起点，按指定顺序读规范/最新台账/契约/Skill；用户本次明确恢复，历史暂停不再生效。完整 W01–04、B01–04、A01–02、U01–06 和 E01–04 保持，不推送/PR/新聊天/子 Agent。
- 上游实际读取 1.8.8 `clis/gmail/utils.js:571–609`：明确片段读取存在，重复片段临时切 inbox 的做法不迁入。本项目现有 query 的新文档守卫不放宽；新增独立 hash 执行器与显式 hashNavigation，含片段 path/query、所有内外参数业务关联、独立 freshnessPath 和 sameTarget=reload。不同片段需基线刷新标记改变，同目标只重载准确当前 URL 一次并取新文档；不 detour、不合成 hashchange、不重放。
- 规范化 helper 两端字节一致，manifest/安装权限绑定完整 hash/关联/刷新/重载，workflow 复用总预算和步骤间身份，旧选定 profile 在观察/验证/普通调用前拒绝。每参数至少两种作者值；来源观察只存结构。修复只能改结果提取，历史 cases 全部重跑。
- 源码 Chromium 1217 hash 专项 **8 项通过**，报告 `webcli-browser-acceptance-Xjf552/report.json`，日志 `/tmp/weworker-hash-browser-source-final.log`；包含 single、混合 path+外层 query+fragment path/query、workflow、精确重载/新鲜度、错误/陈旧/重定向拒绝、生成→作者验证→安装→普通调用→知识→提取修复，以及取消和真实 Bridge 重启。**57 文件**隐私扫描通过，观察 hash/category 标记未持久化，无真实响应 ID 绑定。
- 检查取消链路发现单步 hash 未分配 operationId，已补观察与作者预览；单步 hash 按一组 case 分批，取消可停止剩余 case。最后 WebCLI **127 文件/1424 项** `/tmp/weworker-hash-all-final.log`、聚焦 **5 文件/69 项** `/tmp/weworker-hash-focused-cancel.log`，扩展导航/query/workflow **16 项** `/tmp/weworker-hash-extension-final.log` 通过。完整双打包 Chromium 运行中 `webcli-browser-acceptance-SpVEmj`，日志 `/tmp/weworker-hash-browser-bundled-full.log`；尚不提前计通过。
- CLI/Bridge 构建、公开配置及 **3 项**配置测试、**21 JS/MJS** 语法、探索 Skill quick_validate、npm prepack/pack **628 文件**（新增扩展 helper）通过。源码/build/npm 扩展与 bundled Skill 字节一致。双打包 HTTP 回归运行中，最终结果另补。通用 Skill 既有 version 校验限制不变。
- 失败记录：首次 dYUT8c 把普通参数错误的旧字符串输出误断言为 ok:false，改验 error 文案与零请求，未改生产返回。OId3hq 为前一脚本快照 5 项通过，未含 mixed/取消/重启，不能替代 Xjf552。初版 profile 测试有对象括号和能力/错误文案配置问题，修正后 69 项通过；单测跨源事件诊断补明确 ORIGIN_CHANGED。根目录 npm/配置脚本路径以及 pack 前导构建日志解析的调用错误已修正，不计验证通过。未削弱新鲜度/文档身份或动作计数断言。
- 本阶段未改 Python 网站探索agent、CI/CD、发布、数据库 schema、.env、密钥或依赖；无仓库文件删除。所有实机动作在任务拥有的隔离 Chromium/Bridge/临时 loopback 中运行。hash 需要站点可公开读取刷新标记，重载不证明后端无缓存；跨 origin/frame、循环/分支和完整台账均继续开放。

- 追加自审：同片段重复读取除新 loader 外，也要求 freshnessPath 不同于重载前；否则站点从缓存恢复相同旧状态仍可能误认新鲜。已收紧为“新文档＋刷新标记变化”，新增单测和实机冻结标记反例；不放宽其他守卫。SpVEmj/TWa1K8 属于收紧前快照，最终实机另跑，未混称最终代码全通过。

- 下一余项审计已读取 1.8.8 Gmail `queryThreads`（utils.js:479–543）：按 limit 算有界页数，首轮搜索/后续 next 分支、缺 next 或短页结束、重复页零新增明确报错；这是实际页面循环与分支，不把仅解析数组的 for 当浏览器能力。本项目 normalizePageWorkflow 只接收线性 2–8 步、executePageWorkflow 仅顺序执行并返回末步，未提供生成包内数据驱动循环/分支，调用 Agent 自行发多次 CLI 不等价。待 hash 最终验收后继续该 B01 缺口；尚无新循环实现。

### 2026-10-18：hash 完整回归诊断与有界读取控制（active）

- 最后 hash 新文档＋刷新标记变化契约双打包专项 **9 项** c4GzcD 通过（包含 frozen-result 和作者验证取消下一 case 零派发）；双打包 HTTP **24 项** C0k8DN 通过，390 文件/14 私有绑定检查通过。前一全量 1424 项早于循环/分支改动，不混称覆盖当前代码。
- SpVEmj 完整回归 hash 重启 48≠43，补请求/文档诊断后 I4bcQi 再现 51≠46：五个 owned hash 页面均在断线后、重连前重载，当前 slow-result/restart 也再次请求，是真实重放缺口而非可放宽的计数。refreshAdapterTabBatch 在断线期间拿不到 manifest 时，旧条件把 null 当作非 managed legacy 而 reload；现只对明确非 v2 且无 _hostSnapshot 的 manifest 重载。null/未解析 v2 仍 clear/reinject，绝不借目录不可用授权导航。聚焦 tool-route 33 项、相关扩展全套 53 项通过；完整双打包 XoGPDg 正在复跑。
- 有界读取控制已实现：when 对上一执行结果的公开标量精确比较，repeat 2–8 次、每轮 until、collect 初始页/新页公开 ID 去重；相同 ID 不同字段、零新增、数量/全部集合 1000000 UTF-8 字节/轮数上限均失败，不返回部分结果。每轮精确文档和全局 30 秒预算，无隐式重试；取消/断线不派发下一轮。完整控制纳入权限/知识/repair，page_workflow_control_v1 在旧选定 profile 观察/验证/普通调用派发前拒绝。
- 源码 Chromium 1217 控制专项 **7 项** dZJaoz 通过，日志 /tmp/weworker-control-source-final.log：执行/跳过分支、多页/单页集合、逐页精确请求、生成→cases→验证→安装→调用→知识→提取修复，四类失败边界，取消与实际 Bridge 重启零后续动作/重载。28 个产品文件隐私及控制观察标记检查通过。最终双打包控制专项 4FVrEL 运行中；不计完成前结果。
- 当前 WebCLI **127 文件/1427 项** /tmp/weworker-control-all.log、聚焦 **4 文件/69 项**、扩展 **53 项**通过。CLI/Bridge build、公开配置与 3 项配置测试、28 JS/MJS 语法、探索 Skill quick_validate、npm pack **630 文件**与源码/build/npm 扩展及 Skill 一致性通过。双打包 HTTP **24 项** uL2N25 通过，390 文件/14 私有绑定检查通过。无依赖新增。
- 新验收首次 hIwt5W 把 favicon 响应计为 document（12≠11）；夹具收紧为仅 /control 计文档，其他 404，完整断言保持。单测首版 manifest guard fixture 缺 version:1 已修；一次 npm 重复 --run 调用无效，修正后通过，不算生产失败或通过证据。
- Skill 与 design/http/write 边界已同步。源码控制专项与早期完整诊断的顶层测试请求报告可能含公开观察占位串（不在产品 data/user/builtin/日志）；随后脚本在诊断输出中省略这些观察串，产品隐私断言始终未放宽。XoGPDg 早于最后诊断脱敏/知识计数断言更新，但生产代码相同；最终专项覆盖最后脚本。
- 下一 B01 跨源/frame 正在对照上游 page.goto、frames/evaluateInFrame 和本项目 browser-frames 的真实代码：已有单条 browser frame 能力不能当作生成 workflow 已具备，先审计再设计。所有 W/B/A/U/E 余项保持，整体 active，无 push/PR/新聊天/子 Agent，Python 网站探索agent与受限配置未动。

- 补充：最终双打包控制专项 **7 项** 4FVrEL 已通过，28 文件隐私检查通过。随后给验收脚本增加“作者验证在重复步骤取消，下一轮和下一 case 均零派发”实机断言，最终专项再次运行；生产实现未变。B01 跨源/frame 已完成固定源码摘要核对与差距/实现边界审计，见 opencli_workflow_context_audit.md；该部分尚无半成品实现。

- 追加最终控制专项：Y3nbGm **8 项通过**，日志 /tmp/weworker-control-bundled-cancel-final.log；新增作者预览取消覆盖正在执行的重复步骤和下一条作者 case，均零后续派发。33 产品文件/0 私有绑定隐私检查通过，产品与诊断观察串均未持久化。完整 XoGPDg 已越过此前 hash 重启失败点并通过线性/受控 workflow，后续回归仍在运行。

### 2026-10-18：d0e8ea9 hash/有界控制最终证据，继续跨源（active）

- 本地代码检查点 **d0e8ea9**，未 push/PR。Chromium 1217 最终完整 CLI＋Bridge 双打包 **99 项全部通过**，XoGPDg/report.json，日志 /tmp/weworker-control-bundled-full.log；包括此前失败的 hash 重启、线性/控制 workflow、profile/HTTP、PAGE_FETCH/UI 单写、实际 ID/异步效果、三类修复与共享修复。执行快照早于最后的诊断文本脱敏、额外知识字段断言和作者取消专项，生产代码相同；最终专项 Y3nbGm **8 项**补齐最后作者取消断言。
- 完整产品目录与日志 **5370 文件/28 私有 resultBinding** 权限及敏感占位扫描通过，hash/fragment/control 观察标记零持久化，日志 /tmp/weworker-control-privacy-full.log。最终控制专项 **33 文件/0 绑定**通过。此前失败 SpVEmj/I4bcQi 保留；没有通过删除页面或弱化请求计数绕过断线重放。
- 阶段验证汇总：WebCLI **127 文件/1427 项**、聚焦 **69 项**、扩展 **53 项**；源码控制 **7 项** dZJaoz、最终打包控制 **8 项** Y3nbGm、hash 专项 **9 项** c4GzcD、双打包 HTTP **24 项** uL2N25；构建/配置/3 配置测试/28 文件语法/探索 Skill/npm pack **630 文件**与字节一致性通过。只证明 d0e8ea9 阶段，不覆盖下列未提交跨源代码。
- 已继续下一 B01：跨源 origin 规范化 helper、navigate.resultOrigin、workflow step.origin、任务 allowedOrigins 限制、manifest match/权限、route 选择与 preview 固定任务 tab 开始实现。普通 observe/collect/write 的 checkTab 默认仍要求原 origin，仅声明读路由允许有限目的地；旧 profile 在派发前拒绝。**新 capability 尚未在扩展公告，当前没有跨源实机或完整回归通过，不得算完成。** frame 暂无实现。
- 下一实现当前单元：origin helper 最初 4 项、主机聚焦 55 项、profile/服务聚焦 63 项、扩展 navigation/tool-route 39 项通过，均不足以验收跨源。service-worker 测试 loader 缺新增 import 导致旧 route 用例失败，补同步注入后 39 项通过。跨源支持后续仍需预览恢复/重复调用/修复/取消重启与双打包真实两个 loopback origin 验证；当前半成品不要误并为 d0e8ea9 的已验结果。

### 2026-10-18：跨源主文档首轮源码实机（active）

- 新 capability page_navigation_origin_v1 已在扩展公告，取代上一条“尚未公告”的进度状态。源码 Chromium 1217 5GCrtt/report.json **8 项通过**，日志 /tmp/weworker-origins-source.log：未声明 origin 零派发，single/workflow 的生成、双作者值、安装、重复普通调用、知识、重定向拒绝，single 提取 repair，取消和 Bridge 重启不重放。该首轮尚未覆盖跨源 hash/往返/作者取消，扩展脚本 BcTHOC 运行中。
- 新增精确端口与 origin/path 组合单测；全量 WebCLI、扩展聚焦正在运行。实现/文档/Skill 未提交，不把此前 d0e8ea9 的 99 项全量冒称为跨源验证。完整范围继续执行，frame 暂无实现。

- 扩展跨源验收源码 **11 项** 2zWcqF，通过 hash、A→B→A、到目的源后 Bridge 重启再验证、作者取消；双打包专项 **11 项** r9KzgD，通过连续 12 次 workflow 普通调用及相同完整 hash 只 reload 一次。各 **85 产品文件/0 私有绑定** 隐私检查通过，额外检查观察标记未保存。HTTP 双打包 **24 项** 4UrDmJ、390 文件/14 私有绑定通过。
- 当前 WebCLI **128 文件/1436 项** /tmp/weworker-origins-all.log；最终主机聚焦 **64 项**、runtime-validator **5 项**，扩展导航/workflow/tool-route/preview **60 项**通过。CLI/Bridge 构建、公共配置/3 测试、25 文件语法、探索 Skill、npm pack **632 文件**（包含 origins helper）及 70 项源码/扩展产物/Skill 字节一致性通过。最后改动是帮助文本与额外测试；完整双打包正在 /tmp/weworker-origins-bundled-full.log 运行，不提前计通过。
- 失败保留：BcTHOC 在 workflow 第二次普通调用返回无 data，夹具直接取 data.item 而未保留具体 error 导致 TypeError。未改生产逻辑或放宽断言；补完整 ok/error 断言后，2zWcqF 与连续 12 调用的 r9KzgD 均未复现。**该一次异常原因仍未知，不写成已修复**，完整回归继续观察。新 preview 单测首轮 fixture ID 未使用 generation_preview_ 前缀，改为实际合法 ID 后 60 项通过；没有改生产前缀校验。

- B01 frame 已做独立方案探针 DAKfnA：复用实际 ensureCdpAttached/withBrowserFrameContext，DOM owner 对应 5 个主/子/嵌套跨源文档并区分两个相同 URL；仅证明身份解析可行，生成工作流暂无实现。首次 SW 动态 import 与直接 attach 两种探针失败均记录于上下文审计；生产代码未因探针变更。完整跨源回归继续，保存实现检查点后继续 frame，不暂停目标。

### 2026-10-18：用户要求本阶段后暂停，跨源竞态修复与 frame 调查保存

- 用户最新指令“完成本阶段任务后，找一个合适的时间点，先暂停当前目标，告诉我还差哪些”覆盖上面的持续执行安排。本阶段完成跨源最终回归、证据、文档与本地检查点后暂停；没有继续 frame 集成、external CLI 或其他新功能。整体目标未完成，不能 complete。
- 跨源代码检查点 **841a412**；导航竞态修复 **f2f54d8**；未接入 frame 调查 **1c4d8a9**；验收夹具隔离检查点 **a4052b3/c26226a**。后续纯文档检查点以 `git log` 最新记录为准。保持当前分支 `codex/api-exploration-cli`，不推送、不建 PR、不新建对话或子 Agent。
- 完整双打包 **cmPIYq 失败**：第 6 次 workflow 普通调用首步 `PAGE_QUERY_ORIGIN_CHANGED`，具体错误已保留，不是此前 BcTHOC 的夹具 TypeError。只在隔离副本加入诊断的旧代码 **Zl8HbX** 于第 38 次调用明确捕获 `navigated:true/oldSnapshot:true`，当前完整 URL 仍等于初始 URL。日志 `/tmp/weworker-origins-race-proof-fixed.log` 证实 CDP 提交早于 tabs 快照更新。最早 BcTHOC 没有原始 error，仍无法追溯确认同因。诊断初版 7sgZpm 错改了临时 Bridge import，启动失败后修正脚本，未修改生产路径绕过问题。
- f2f54d8 的普通/hash 导航只在原预算内等待精确初始 href，期间零结果读取；完整目的 href、新文档/loader、稳定结果、hash 刷新/业务关联和错误 CDP 来源拒绝保持。永久旧快照超时，取消/重启不重放。最终扩展导航/workflow/tool-route/preview **64 项通过** `/tmp/weworker-origins-race-extension-final.log`，涵盖旧快照延迟、始终不更新及旧快照期间真实重定向事件。
- 修复后 CLI＋Bridge 双打包 **bt4fok 7 组检查通过**，其中 workflow 普通调用连续 **102 次**，每次断言公开业务字段和严格 `/items`、`/next` 请求序列，另验重定向/作者取消/观察取消/Bridge 重启不重放；日志 `/tmp/weworker-origins-race-stress-final.log`，**24 产品文件/0 私有绑定**隐私检查通过。临时 driver 只将现有 workflow 调用列表扩到 102 次，并移除旧代码覆盖；没有改被测生产代码。完整与连续调用快照的两个导航模块都与当前源码逐字节一致。
- 修复后的完整 **tBXyDE 最终仍失败**：前 **108 项**（含跨源、21 页知识分类、HTTP/PAGE_FETCH/UI 写与定向修复）通过，最后共享修复夹具期待独立 3 命令包，实际因跨源主包已加入 localhost match 而继承了该包所有命令。不能将此报告记为完整通过。**6296 产品文件/28 私有绑定**隐私检查通过。根因见实际 `generation-harness/existing-site.js` 的 hostname/父子域重叠规则，端口不构成独立包身份。先试 shared-repair.localhost 的独立专项 aDAk4s 虽过 3 项，但代码核对表明子域仍会与 localhost 重叠，不能用该孤立结果证明修复。
- 最终仅修改验收夹具：本任务 Chromium 用精确 host-resolver-rule 把公开占位 `shared-repair.example.org` 映射到 127.0.0.1，本地服务器绑定 loopback 并核对全部请求 Host/GET；不修改机器 DNS、生产包匹配规则或“三命令/三项全部重验”断言。新增 `--origins-shared-only` 在同一目录顺序跑跨源与共享修复，复现原有包状态。组合 **TUBvyL** 在该占位页面加载失败；独立 Chromium 探针确认默认代理下 ERR_HTTP_RESPONSE_CODE_FAILURE，而仅在本任务 Chromium 加 `--no-proxy-server` 后本地服务返回 200。完整 **jB8mJw** 使用旧夹具环境，已核实本任务 PID/PPID/profile 后中止自身 Chromium，保留中断报告，不计通过。最终隔离专项 **ZSR0qj 3 项通过**；组合与完整回归再次运行，结果另补。日常浏览器与系统代理设置均未修改。
- 夹具最终组合 **YiVdjI 12 项全部通过**，日志 `/tmp/weworker-origins-shared-local-combined-final.log`；在同一安装目录先完成全部跨源生成/安装/调用，再生成独立三命令包、修复共享映射并全部重验和重启调用，未弱化原断言。独立共享专项 ZSR0qj **50 文件/0 私有绑定**隐私通过；组合扫描见 `/tmp/weworker-origins-shared-combined-privacy.log`。完整双打包最后复跑 **9ccf6Q**，日志 `/tmp/weworker-origins-pause-full-verified.log`，结果待完成后补录。
- WebCLI 最终全量 **129 文件/1439 项通过** `/tmp/weworker-origins-all-race-final.log`（含 frame 声明的 3 项单测，不代表 frame 实机通过）。CLI/Bridge 最终构建 `/tmp/weworker-origins-pause-build-{cli,bridge}.log`、公共配置与 **3 项**配置测试、**41 个**本阶段 JS/MJS 语法、探索 Skill 校验通过；npm pack **634 文件**，**42 个**源码扩展 JS 与 build/npm 资源一致，全部 prepared 扩展/内置 Adapter 资源与全部 bundled Skill 字节一致，摘要 `/tmp/weworker-origins-pause-package-check.json`。最后改动为断言、注释与 Skill 文案，不改变已运行快照的导航逻辑。
- Skill 收尾校验的系统 Python 与 bundled Python 均缺 PyYAML，此次未新增依赖；复用既有隔离 `/tmp/weworker-skill-validation.dG7fDg/bin/python3` 后 quick_validate 通过。通用 Skill 既有 version 字段限制保持，不冒称其系统校验通过。改动新增文本常见凭据/私网模式检查通过，受保护目录、CI/CD、schema、.env 和依赖未改；最终文件数见 `/tmp/weworker-origins-pause-source-scan.json`。Python 网站探索agent源码、环境、生命周期和数据均未操作。
- frame 的五个基础文件均已随 1c4d8a9 保存，没有生产引用或生成 schema/capability/权限集成；扩展文件仅随目录复制，不能算可用能力。初期 0L9shG 基础探针通过部分身份检查，但报告只保存 rows，checks 未序列化。扩展探针 1jewHF 挂起后仅关闭核实归属的本任务 Chromium；加 45 秒截止和阶段报告后 **LufBqx 失败**于 `resolve after selected replacement`，finally 正常关闭浏览器/服务。父文档替换与取消新增断言未执行到，不计通过；resolver 自身等待缺少完整超时仍待修。详情与复跑入口见 [上下文审计](opencli_workflow_context_audit.md)。

暂停后的完整剩余范围：

| ID | 下一阶段仍需完成 |
| --- | --- |
| W01–W02 | 受控 input/change、自动保存、自定义 UI 写；hidden CSRF、click/Enter、整页提交、Shadow/frame 写生成 |
| W03–W04 | 多步/批量写、结果传递、部分成功恢复、多组写 cases；多 ID、Header/响应 URL、任意 UI 网络响应 ID、任意精度/负数 ID |
| B01 | 先解决 frame 替换后身份解析挂起，再完整接入声明、读取、动作、导航、循环、权限、修复与隔离实机；现有基础不计完成 |
| B02–B04 | 自定义日期/选项、目录/file chooser/自定义上传；跨 frame/DataTransfer 拖拽；AX/Shadow/子 frame 截图与任意设备模拟恢复 |
| A01–A02 | YAML/API 文档发现、更广 refs；站点签名/OAuth 按实际源码和契约继续审计验证 |
| U01–U02 | 统一 verify/evidence、Git/monorepo、legacy/Toolkit 诊断；其他 Adapter/服务管理格式、发布及凭据路径实际验收 |
| U03 | 1366 命令/179 分组完整行为映射与实机，150 名称候选不能视为对齐 |
| U04–U05 | 外部 CDP/Electron、external CLI 注册/安装/stdio 与退出码透传；已有源码审计，没有本项目实现完成证据 |
| U06 | Worker/流式正文/结果 replay 的隔离行为核对，统一诊断导出实现；不能仅凭静态阅读关闭 |
| E01–E04 | Chromium 1194 与其他浏览器/系统、各平台真实安装包、全新 Codex/Claude 独立对话、代表站点/认证组合验收；新对话、发布受限动作和真实账户写的授权限制保持 |

WeWorker 自有 UI 仍为 P01 独立产品事项，不计 CLI 对齐。恢复时先核对工作区/日志，读取本顶部、末尾与能力台账；不得继承历史写授权、实际结果 ID 或执行记录。默认 validate 不写、精确审阅/持久消费、不重放、uncertain 只读恢复和隔离副作用边界保持。

### 最终验收与暂停记录（2026-10-18）

- **9ccf6Q/report.json：passed=true，CLI＋Bridge 双打包，109 项全部通过**；日志 `/tmp/weworker-origins-pause-full-verified.log`。本轮完整覆盖浏览器/profile、query/hash、线性与有界 workflow、跨源、21 页知识分类与重启、HTTP/PAGE_FETCH/UI 写、实际结果 ID、有界效果、定向与共享修复。最后共享修复严格三命令、三项全重验通过；tBXyDE 的 108 项后失败、TUBvyL 网络失败与 jB8mJw 人工中止均保留，未改写为通过。
- 完整产品日志/data/user/builtin **6291 文件**敏感占位扫描通过，**28 私有 resultBinding 文件**权限检查通过；全部 6291 文件中观察标记 `example-unretained` / `example-unpersisted` 零持久化。摘要 `/tmp/weworker-origins-pause-final-evidence.json`，明细 `/tmp/weworker-origins-pause-full-privacy.log`。普通/hash 导航源码与本轮实际扩展副本逐字节一致。
- 最终组合 **YiVdjI 12 项**、**130 文件/0 私有绑定**通过；独立共享专项 **ZSR0qj 3 项**、**50 文件/0 绑定**通过；连续 workflow **bt4fok 102 次/7 组断言**、**24 文件/0 绑定**通过。双打包 HTTP **24 项** 4UrDmJ 为本阶段先前独立回归，最终完整回归也再次覆盖 HTTP/profile。
- 最终自动化与打包：WebCLI **129 文件/1439 项**、扩展 **64 项**、frame 声明单测 **3 项**（仅声明，不计 frame 实机）、公共配置 **3 项**、**41 个**本阶段脚本语法、探索 Skill、CLI/Bridge 构建、npm pack **634 文件**及源码/build/npm/Skill 字节一致通过。最终源码扫描 **50 个改动文件**，受保护目录/配置/依赖未变；没有删除仓库文件或执行 Git 回滚。
- 核对本轮 8 个相关报告目录，任务所属浏览器/Bridge 进程均已退出；失败和成功的隔离目录保留，不清理用户数据。源码与验收修改已分别保存为 f2f54d8、1c4d8a9、a4052b3、c26226a；最后纯文档提交以 `git log -1` 为准，检查点没有未提交的功能改动。
- **按用户要求暂停，整体目标未完成。** 下一阶段建议先修 frame 替换后身份解析/清理的有界等待，再推进全部声明与工作流接入；不能跳过上表 W/B/A/U/E 任何项。未推送、未创建 PR、未新建对话或子 Agent，Python 网站探索agent与日常浏览器/用户 Bridge 未动。


## 2026-10-18 后台 API 通用流程专项

用户指出既有 Adapter 可无需业务页查询，要求修正整个探索流程并保持开源/内部仓库共架构。先核对内部固定源码：旧后台路径确实存在；旧测试不等于最新 v2 包已验收，内部当前包元数据差异须在同步时逐包复核。本轮公开实现/用例不包含内部域名、业务源码或数据。

实际修改见 `docs/background_api_exploration.md`：EXTENSION_API 计划、生成 execution 保留、对应 offscreen 真实验证、后台/页面混合分流、后台 repair 禁止页面策略、预览鉴权失败不开页不重放、缓存限定读取。基础 Skill 去掉“一律打开网站”，探索 Skill 要求先核对鉴权和现有执行方式；AGENTS 明确两仓共架构。保持已有普通调用、HTTP/Toolkit 分离、页面/写验证边界。没有重启用户 Bridge/Chrome，没有改 Python 网站探索agent。

已完成证据（最终完整浏览器结果见下面收尾记录）：

- WebCLI 全量 **130 文件/1464 项**：`/tmp/weworker-background-tests-complete.log`。聚焦 **76 项**：`/tmp/weworker-background-focus.log`；扩展相关 **53 项**：`/tmp/weworker-background-extension-complete.log`。覆盖 source 元数据、旧 capability 拒绝、无 tabId、完整 cases 回执、只读传输/重定向/低风险守卫、普通后台生命周期、预览超时后恢复安装源码、缓存命中与缺失不借页。
- Chromium 1217 源码后台专项 **7 项**：系统临时根 `webcli-browser-acceptance-RgLVTq/report.json`。双打包后台 **8 项**：`webcli-browser-acceptance-0yl2o1/report.json`，包括缺 Cookie 和实际服务端 401 两种失败；每 case 一次请求、无隐式页面。最终增强断言同时排除网站 origin/API origin 标签，结果见下面收尾记录。
- 独立 HTTP 源码 **24 项**：`webcli-http-discovery-awmDlM/report.json`；最终双打包 **24 项**：`webcli-http-discovery-7Q3zMI/report.json`。前次误用了浏览器脚本的 --bundled-cli/--bundled-bridge，报告 bundledCliAndBridge=false，因此仅计源码；用该脚本正确的 --bundled 重跑通过。
- CLI/Bridge 构建与公开 profile/生成配置通过；overlay 五项通过。最终随包 Skill **4 项** `webcli-skills-acceptance-NxyjJW/report.json`；npm pack **636 文件**含新模块，Extension 源码/构建/npm 副本逐字节一致。所有构建产物不提交。
- 后台专项产品日志/任务/安装文件 **68 文件**中公开 Cookie 占位值零泄漏；浏览器 profile 属于任务临时环境，未纳入产品日志扫描。最终完整回归检查见下面收尾记录。

失败与修正：首轮实机作者夹具缺少一个右花括号，被静态验证拒绝；第二轮对普通结果断言忘记去除 CLI trace_id，产品执行已成功；混合计划使用旧 PAGE_FETCH 生成器不接受的连字符名称，改用 snake_case 计划和生成后的 kebab-case ID。缓存单测旧 stub 不保存 storage，补正确持久 stub 后通过。全量旧隐私测试在随机摘要中遇到子串 007 误报，改为递归检查完整 JSON 值和 representativeArgs/effect/fixture/resultBinding 禁止字段，保持结果隐私边界；最终全量通过。失败报告 m1h0YL/T6t0sJ/zYCA1O 不计成功。

仍需完成/验证：GLM 当前安装的页面版不会因本通用改进自动转成后台版；需要实站确认 Authorization 的获取与生命周期、选定 profile 登录态来源、迁移并重新真实验证 5h/week 和关闭任务自有业务页后的普通调用。用户现有 Bridge/插件没有新 background_preview_v1，本轮未擅自重启升级。活动演示需准备本分支 CLI/Bridge/扩展的匹配分发入口，npm 1.0.4 版本号不能证明支持探索。内部同步尚未执行；逐包核对 v2 execution 及普通调用，不能仅引用 legacy 测试。storage 冷启动、浏览器重启、外部复杂签名/OAuth、其他系统和独立 Agent 新对话仍未证明。

原 OpenCLI 整体目标继续暂停；本次专项不关闭 W/B/A/U/E 余项，不展开下一阶段，不推送、不创建 PR。最新检查点以 Git 日志为准。


### 本专项最终收尾与暂停

- 最终 Chromium 1217 CLI＋Bridge 完整双打包 **114 项全部通过**：系统临时根 `webcli-browser-acceptance-76lB8i/report.json`，日志 `/tmp/weworker-background-bundled-full.log`。覆盖本次最终生产运行代码，以及原有页面查询/导航/profile/HTTP/写操作/共享修复与后台混合包调用。该完整快照早于最后基础 Skill 文案和两条验收断言增强；运行代码一致，不能称其覆盖最后新增断言。
- 最后基础 Skill 已重新打包并通过 **4 项**字节一致性/读取/格式检查 NxyjJW；增强的后台专项 **8 项**通过 `webcli-browser-acceptance-agzD9n/report.json`，日志 `/tmp/weworker-background-bundled-final.log`。同时排除网站/API origin 标签；实际服务端 401 每 case 一次请求，无页面/传输回退；缺 Cookie 零 API 请求。此最终专项产品 **68 文件**中公开占位凭据值零命中。
- 完整回归产品日志/任务/安装文件 **6354 文件**扫描本次后台 Cookie 占位值零命中（不是浏览器 profile 清理，也不替代其他隐私项验收）。全部测试只用自有隔离浏览器、Bridge、loopback 与公开数据，正常退出；用户会话未改。Git 工作区仅包含本次通用修改、相应文档与前轮已授权的 GLM 页面版报告。
- 本阶段完成，按用户要求保持整体目标 paused；不继续展开 GLM 迁移或 OpenCLI 下一阶段。当前 GLM 页面版、匹配版本演示部署、内部同步后的逐包回归，以及完整台账 W/B/A/U/E 未完成项均明确保留；不缩减范围。仅保存本地检查点，不推送、不建 PR。

## 2026-10-18 GLM 删除重建、全部业务页关闭后的最终验收

本轮用户明确要求删除刚才的 GLM Adapter，重新使用 WebCLI 探索并验证流程；另明确授权重启已确认归属的工作区 Bridge、由用户重载最新扩展，以及关闭原有和任务自建的两个 GLM 用量页。上述授权只覆盖本轮具体动作，不转化为任意浏览器、进程或文件删除授权。全面对齐目标保持 paused，未恢复 W/B/A/U/E 开发。

### 清理与重新探索

- 正式 `adapter remove bigmodel.cn` 后，精确删除此前页面版安装快照、旧探索任务/目录、该站点旧知识与旧作者临时目录。没有删除登录态、其他 Adapter、历史报告或 Python 网站探索agent数据。后续失败与新版本记录均保留。
- 从实际用量页重新 start/evidence，观察成功额度 GET，检查网站公开 JS、页面调用及 LimitBoard。发现命名 Cookie 直接作为 Authorization（无 Bearer），且需要组织/项目上下文。仅有 Authorization 的业务成功响应并不包含目标窗口，不能据此通过。
- 新流程先生成并验证显式 `prepare-context`，通过现有 storage_get 缓存准确组织/项目键，仅返回状态；再增量生成 `EXTENSION_API get-quota`。后台查询只用 cookies_get、cacheOnly storage_get 和禁止页面 fallback 的 backend_fetch；一个调用一个 GET，无页面注入/读取，无失败重放。缺准备明确报错，切换账号/组织/项目须重新准备，缓存不自动跟随页面变化。
- 5h/week 映射按实际 type/unit/number 唯一匹配。已用百分比取服务端值，剩余计算；可选重置时间缺失为 null。口径为已准备组织/项目下当前成员。曾与页面响应在内存逐字段核对一致，没有把额度或账号值写入源码、fixture、知识或公开文档。

### 最终实站结果

- 准备工具真实预览 1 case 通过；增量后台四组 cases（默认 all、5h、week、显式 all）通过。按准确文件、schema、执行方式、权限审阅并本地安装，未增加根 adapters 或公开 profile 范围。
- 任务自建页由 WebCLI 关闭；原用户页的 browser.close 仅解绑，window.close 被 Chrome 拒绝，因此用浏览器工具关闭已获授权的准确原页。工具仅承担关闭动作，探索/生成/验证/安装/查询均通过 WebCLI。WebCLI tabs 确认 GLM 标签数为 0。
- 在关闭全部 GLM 页后，用新 scoped repair 保留原后台代码、鉴权、准备命令与权限，四组真实后台 cases **4/4 通过、0 跳过**。审阅安装为 **bigmodel.cn@1.0.2**，摘要 **4d066a979d9223e1260c1a9c9381ade5d2d4c0fe66ecb48b7400328b079de525**；知识已保存，摘要匹配且未过期。
- 零页面时，源码 5h、全局 week、打包 all、全局重复 5h **4 次普通调用通过**；重启本任务 Bridge 后，全局 5h、打包 week、源码 all、全局重复 5h 又 **4 次通过**。前后 GLM 标签为 0、新标签为 0。后四次 trace 仅有预期的 cookies_get/storage_get/backend_fetch，无 main_world_eval/browser_fetch/导航。原浏览器登录态保持，未重启 Chrome。
- 非法 period=month 实测在凭据 helper/HTTP 前拒绝。最终静态包校验 **6 文件、4 JS、3 命令、0 错误、0 警告**。本次离线公开占位 fixture **11 项通过**，不替代真实无页验收。
- 本机汇总目录 `/tmp/weworker-glm-rebuild-VIcRcz/`：`no-page-summary.json`、`no-page-restart-summary.json`、`ordinary-summary.json`、`restart-summary.json`、`get-quota.test.mjs`。本报告和汇总不保存真实额度。浏览器探索 session 已解绑；工作区 Bridge 保持可供普通查询使用，未来停止/重启前须核对现场归属。

### 通用修复与回归

- 纯用户包卸载后，旧逻辑错误选择不存在的 builtin，生成被目录诊断阻塞。现在只有实际 builtin 才恢复，否则保存 disabled 标记；无候选的 disabled 不视为目录错误，但 host 调用/目录继续将其视为 managed，阻止旧 legacy 命令/别名复活。新增卸载→重新 generate 与重新安装测试。
- 生成 Adapter Skill 去掉笼统自动开页表述，要求按命令 execution/guidance 判断；探索 Skill 补齐组织项目口径、先准备后增量后台、task-local 页面 helper、普通查询 cacheOnly 与上下文切换重新准备。开源/内部共享同一通用架构，尚未对内部仓库执行同步。
- 聚焦 **6 文件/61 项**通过；最终 WebCLI **130 文件/1465 项**通过，日志为该临时目录 `webcli-tests.log`。源码/打包 CLI 的隔离 loopback 导出、安装、卸载、零请求拒绝旧命令、重新安装各 **4 项**通过，系统临时根 `webcli-export-acceptance-D5HY1J/report.json`、`webcli-export-acceptance-MPGNYN/report.json`。
- 最终 CLI/Bridge 构建成功；公开 profile 校验及 33 个 host-managed 包生成通过。存在既有 wecli-columns、wecli-migrated-commands.json、wecli-column-aliases.json 缺失提示，不冒称无 warning。随包 Skill 真实读取/字节一致/六格式/非法输入 **4 项**通过 `webcli-skills-acceptance-v0athl/report.json`；npm pack dry-run **636 文件**，本次所需资源包含。比较 **47 个**源码/扩展构建/随包 Skill 对应文件字节一致；**7 个**改动脚本语法和 git diff --check 通过。构建与摘要见该临时目录 `build-*.log`、`package-summary.json`。
- 最终包与 13 个改动仓库文件共 **19 文件**凭据/JWT/私网字面量模式检查零命中；**31 个**本轮任务/草稿/该站知识文件结构检查未见真实额度数值、Authorization 或组织项目值。作者 cases 不把真实百分比/重置值写成 equals。仅为明确范围检查，不代表整机审计；浏览器实际 Cookie/缓存不在扫描或清理范围。摘要 `privacy-summary.json`、`artifact-privacy-summary.json`。
- 本轮没有修改扩展执行代码，因此不重复此前 Chromium 114 项全量；沿用其边界证据，本轮用真实 GLM 与必要核心/打包回归验证变更。Python 网站探索agent、CI/CD、发布、schema、.env、依赖和密钥均未改，没有 Git 回滚。

### 保留失败与纠正

- 卸载修复初稿直接删 selection，导致 legacy suppression 回归；改为 disabled 后仍有别名路径失败，补 host 识别 disabled 后 1465 项全部通过。两个中间失败不能记为已通过。
- 初次准备草稿使用安装态 runtime，页面 task-local 预览返回 RUNTIME_EXCEPTION；改用现有 chrome.runtime helper 消息通道。用户重载扩展后原任务 SESSION_EXPIRED，重新 start，不绕过身份守卫。
- 初次 service stop 读取陈旧 PID，随后 start 端口冲突；重新确认原工作区进程路径后，按授权停止并重启。之后两次 restart 只操作本任务启动的 Bridge，未终止未知进程。
- cases 时间 regex 缺末尾锚定被拒绝，改完整锚定；scoped repair 的 snake_case 名称被拒绝，改既有 kebab-case。收尾 draft-read 错传 path、adapter validate 错把名称当目录，分别用 file 和实际包目录纠正后成功。隐私检查首次按错误知识目录定位而未运行，按实际 exploration/knowledge 路径后完成 31 文件检查。输入/路径错误不算产品通过或缺陷修复。

### 暂停与剩余事项

本次 GLM 删除重建闭环完成，可演示本机自然语言调用及使用匹配开发版从零生成。当前全局 npm 1.0.4 普通 call 已验，但不支持新探索/profile 入口；活动前仍需准备匹配的本分支 CLI/Bridge/扩展/Skill 分发方式。尚未验证新机器、浏览器冷启动、其他账号/套餐、真实登录过期恢复、全新独立 Agent 会话及长期稳定性。未主动破坏用户登录态来验失效；离线/loopback 401 不能冒充真实账号恢复。

内部仓库同步及其 Adapter 元数据/后台普通调用逐包验收仍待做，不能由共架构单测代替。全面对齐剩余范围仍为前述完整清单：W01–04、B01 frame、B02–04、A01–02、U01/U02 余项、U03 完整行为映射、U04/U05 实现、U06 行为核对/统一诊断导出、E01–04；不缩减、不静默关闭。整体目标继续 **paused，未完成**。仅保存本地检查点，以最新 Git 日志为准；未推送、未建 PR、未创建新对话或子 Agent。

## 2026-10-18：下周活动优先，定义客户端接入目标

用户要求在新对话开展客户端聊天接入，全面对齐继续暂停，之后再恢复。本轮仅核对源码、Git 与已有报告并制定目标，未启动客户端、调用模型或更改运行代码。

- **暂停点判断**：bf3b22d 工作区干净，GLM 4 组无页验证及 8 次无页普通调用（含 Bridge 重启）、1465 项 WebCLI 回归证据仍可读取。没有发现已验证 GLM 链路的未解决已知失败，但这不是全仓零缺陷声明。
- **必须处理的演示缺口**：旧聊天探索工具尚未统一到新 WebCLI 流程；后端提示词与 managed Skill 的后台执行标记表述不一致，实际影响待验；开发/打包路径与随包 Skill 需核对；安装后同一和后续客户端聊天的发现、自然语言生成、无页查询须实际验证。完整目标与完成标准见 [client_webcli_demo_goal.md](client_webcli_demo_goal.md)。
- **已知欠账保留**：未接入的 frame owner 替换解析超时、1194 Shadow/frame 兼容、早期无完整错误的跨源异常、三个列映射构建资源提示及跨环境/登录恢复欠账。不能宣称全部已修复；它们不构成已知的 GLM 后台 GET 前置依赖。若新客户端链路暴露直接阻塞问题，针对修复，不扩展为继续全部对齐。
- 新目标以本机简单只读封装和 GLM 5h/week 为验收范围，不大改独立探索 UI、不另造 Runner、不要求先完成复杂功能。现有包不能被直接复用后冒称新生成；保留其为回归参考与明确标注的备用演示，先设计隔离方式，未经授权不删除。
- 本轮只更新文档并进行差异/链接检查，没有重新运行功能测试；前述测试数量均为已有对应阶段证据。仅本地文档检查点，以最新 Git 日志为准；未推送、未建 PR、未创建新对话。新对话为客户端目标建立独立目标记录，当前全面对齐记录保持 paused。

## 2026-10-18：客户端共享 WebCLI 演示收尾

本次独立目标实际完成，完整记录转至 [client_webcli_demo_goal.md](client_webcli_demo_goal.md)，演示环境、从零请求、保存包查询与失败恢复见 [client_webcli_demo_runbook.md](client_webcli_demo_runbook.md)。外部 Agent 未代写或修改实站 Adapter；客户端使用共享 CLI、Bridge、Skill 和既有后台 Runner，没有另造探索链路。

最终本地包 `bigmodel.cn@1.0.2`（query-quota/prepare-context）摘要 `f72b0799ab7d2487723cf742ba4b19e3fb5f0a13742383bec8a8930472f9faeb`，保存在独立持久演示根；默认旧 1.0.2（get-quota）摘要保持 `4d066a979d9223e1260c1a9c9381ade5d2d4c0fe66ecb48b7400328b079de525`。两个版本号相同但内容不同，必须看当前目录与 digest。全部候选保留。

本轮补 49 项后台聚焦、9 项双打包后台浏览器专项（4NkByV）、最终 4 项 Skill（PG3qcw），以及客户端实际全过程、无页/新聊天/重连与最终包 13 项占位审查。既有 Backend 96 项、WebCLI 路径/HTTP 81 项、Electron 环境 7 项及对应构建证据仍有效；未将历史 1465/114 全量冒称本轮重跑。环境恢复后的 3711 为默认工作区 source Bridge，PID 需现场重新核实；8765/8766/5173 已释放。

只完成本机简单只读查询封装演示，不恢复全面对齐。W01–04、B01 frame、B02–04、A01–02、U01/U02 余项、U03 行为映射、U04/U05、U06、E01–04、Chromium 1194 兼容及新机器/冷启动/真实登录恢复等范围全部保留。没有修改 Python 网站探索agent、CI/CD、发布、数据库 schema、.env 或密钥；没有推送或创建 PR。
