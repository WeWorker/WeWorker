# OpenCLI 管理与分发能力审计

2026-10-28 更新：本轮验证/诊断增量见 [U01 专项](opencli_u01_verification.md)。`adapter verify` 统一当前静态包检查与显式选定知识源的历史证据摘要，支持 legacy/Toolkit 无执行诊断；`adapter source` 从本地固定 Git commit 发现 v2 子包，显式 path/digest 安装复用原 store。源码/打包和 npm 实际结果见交接。下表为 10-18 审计起点，不能把其“缺入口”解释为当前仍无实现；远程 Git/TS 插件生命周期、Toolkit 真运行仍保留。

2026-10-18，对照官方 1.8.8 发布包实际 `cli.js`、`validate.js`、`verify.js`、`convention-audit.js`、`skills.js` 与本项目源码。接口存在不代表实际验收；下列差距保持开放，不以本表代替逐项实现/实机验证。上游文件仅作审计，未复制业务实现。

| 子项 | 本项目可复用能力 | 实际差距和当前工作 |
| --- | --- | --- |
| bundled skills list/read | `install --skills`、`adapter skill`、四个随包 Skill | 新增 `skills list/read`，支持含 BOM 原文/JSON/显式格式，拒绝 traversal/链接/特殊文件；源码实际四 Skill 字节比对与格式/失败边界通过，打包最终验证待记录。当前四 Skill 无额外参考文件，临时参考路径由聚焦测试覆盖 |
| validate | v2 包结构、命令模块、权限、来源、禁入文件/摘要校验；探索 validate 默认不写 | 上游检查内存 registry 的描述/domain/执行函数/重复参数/pipeline step；新增 `adapter validate --installed [name]`，复用有效 catalog 和摘要，JS 只编译不运行。目标/全目录诊断已实现，legacy/Toolkit 运行验证仍开放，不能复制规则名或声称运行通过 |
| verify | 探索真实作者 cases、写效果、API certification 和隔离验收脚本 | 上游 verify = validate 加可选 tests/smoke；发布包缺 smoke 目录时 executed:false/ok:false，不能算实机验证。项目缺统一已安装命令验证报告入口，须复用现有证据并默认不写 |
| convention-audit | schema、安全标记、写确认、输出断言、csv/table 字段并集 | 上游有七条静态启发式：丢列、camelCase 列、缺 access、静默 clamp/空值/sentinel、写操作缺逆操作；新增 adapter convention-audit，沿用包/摘要检查和七类静态提示；源码六格式/退出码/无执行已验，源码/最终打包各 3 项通过。项目不强制改字段名或新增删除能力；动态/helper/Toolkit/legacy 保留限制 |
| adapter status/eject/reset | catalog/info 有有效来源/摘要，develop/use 支持开发路径与 builtin/user/development/disabled 选择 | 新增 status 包括失效/禁用/被遮蔽候选；eject 已补有效 builtin 包完整复制到明确新目录并验证摘要，复用 develop/use 显式选择；源码/打包真实 HTTP 各 3 项通过。reset 可用切回 builtin 实现来源语义，上游 reset 会删除本地 override，不能在未授权时实际执行删除 |
| plugin create/install/update/uninstall | v2 scaffolder、统一 store、AdapterHub 本地/URL/版本/更新/权限变更和卸载 | 上游 git plugin/monorepo 与本项目 .adapt 包分发不同；缺 Git 来源/批量子包发现的相应流程，不能按 install 同名宣称对齐。发布、删除实际验证仍受用户单独授权边界 |
| service/daemon | start/stop/status/logs、自动拉起、独立 Bridge | 上游 restart/doctor 范围须和已有 browser.doctor、进程归属验证继续核对；不得接管未知进程 |
| 管理输出 | call、browser/exploration/profile、list/info/status/validate、全局/三级帮助已接显式六格式；原 --json 保持 | AdapterHub 复用既有 JSON 路径接入结果/help/错误，源码隔离 GET 目录、下载、校验、安装/dry-run/更新已验；打包待验。未实际发布/操作凭据/卸载，其他 Adapter 管理入口继续核对 |

`external register/install/list` 属 U05，外部 CDP/Electron 属 U04，站点覆盖属 U03；继续按完整台账处理。新 Skill 入口仅读本安装包，不访问用户 Skills 或网站探索agent 数据，不安装或执行 Skill 中的命令。
