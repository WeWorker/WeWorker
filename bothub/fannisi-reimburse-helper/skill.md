---
name: {{skillName}}
description: "处理范妮思（weoa.webank.com）月度补贴报销：从163邮箱搜索下载发票、上传卡包、绑定月度补贴、提交报销，关键词：发票、报销、餐饮、交通、通信、卡包、月度补贴、范妮思"
allowed-tools: Bash(webcli call *)
---

# 范妮思月度报销助手

## 职责边界

- 从用户的163邮箱按关键字（如“发票”、“联通”、“滴滴”等）搜索并下载发票文件（PDF/图片）。
- 将发票上传到范妮思卡包，等待OCR核验，确认并绑定到月度补贴，最终提交报销。
- 上传前校验发票是否满足额度和时间要求（见领域知识）。
- 只执行用户请求的动作；目标月份、发票范围不明确时先向用户澄清。
- 不处理与范妮思报销/发票无关的其他网站操作。

## 领域知识

- 补贴额度（每月，发票金额须 ≥ 该额度）：
  - 餐饮：680 元
  - 交通：500 元
  - 通信：300 元
- 发票时效：当月报销只能用最近 3 个月开具的发票。例如报销 11 月，只能用 9、10、11 月开具的发票。
- 当天开具的发票次日起才能查验：当天上传会报「发票查验接口调用失败，错误原因：当天开具的发票，次日开始才能查验」，卡包也无法暂存。遇到该错误不要反复重试；如实说明原因，请主人次日说一声（如「把昨天的发票传上去」）再执行上传。
- 卡包概念：发票先上传到卡包暂存，核验通过后再绑定到某个月的补贴。某类发票金额较多时（如 2000 元餐饮发票），可分月使用：本月只用 680，剩余留卡包下月绑定。
- 账本月：每月 5 号到次月 4 号为一个账本月（list-allowance-invoices 的 --month 默认当前账本月）。
- 用户发票来源：163邮箱（可按“发票”、“联通”、“滴滴”等关键字搜索），或用户直接发送 PDF/图片。
- 需要登录范妮思；直接调用业务工具，未登录时 WeWorker 会自动打开登录页并处理登录。仅在用户明确询问登录状态时才调用 check-login-status。

## 数组参数写法（重要）

所有 array 类型参数（`--files`、`--invoice-ids`、`--task-ids`）一律使用**重复 flag** 写法，每个元素单独传一次，不要写内联 JSON（'[...]' 在 PowerShell 等环境下会失败）：

```
--files /tmp/fapiao1.pdf --files /tmp/didi.pdf
--invoice-ids id1 --invoice-ids id2
--task-ids task1 --task-ids task2
```

## 执行步骤

1. 明确目标月份（默认当前账本月）、费用类别和发票来源。
2. 获取发票文件：用户直接提供文件，或从163邮箱按关键字搜索下载。
3. 校验每张发票的开票时间（须在目标月往前推 3 个月内）和金额（各类别合计 ≥ 额度）。不确定金额时上传后通过核验结果判断。
4. 上传发票到卡包并等待OCR核验（upload-allowance-invoices）。
5. 查询待确认/可用发票，确认后绑定到目标月补贴。
6. 查询报销状态，确认额度满足后提交报销。
7. 汇报结果（各类别已绑定金额、缺口、提交状态）。

## 常用操作配方

### 1. 查看当前报销状态 / 各类别缺口
场景：用户问“这个月报销进度如何”、“还差多少发票”。
```
webcli call weoa.webank.com.get-reimbursement-status --month=2024-11
```
（不传 month 默认当前月份；会自动导航到报销页面，返回当前月份、整体状态、各发票类别缺口金额、已关联发票数、提交按钮金额）

### 2. 从163邮箱搜索并下载发票
场景：用户说“去我邮箱找发票”。用163邮箱相关工具按关键字（发票、联通、滴滴等）搜索，下载发票 PDF/图片到本地，记录文件路径供上传。

### 3. 上传发票到卡包（批量，含OCR核验）
场景：拿到了多个发票文件（PDF/图片），需上传核验。单张发票同样使用此工具（--files 只传一次即可）。
```
webcli call weoa.webank.com.upload-allowance-invoices --files /tmp/fapiao1.pdf --files /tmp/didi.pdf --yes=true
```
- 需核验通过后自动确认提交到月度报销时加 `--auto-confirm`（关闭用 `--no-auto-confirm`）；不明确时先不加，核验后再确认。
- `--timeout` 可设OCR核验等待秒数。

### 4. 查询卡包发票
场景：核对卡包里有哪些可用/待确认/核验失败的发票。
```
webcli call weoa.webank.com.list-allowance-invoices --mode=available --month=2024-11
webcli call weoa.webank.com.list-allowance-invoices --mode=pending
webcli call weoa.webank.com.list-allowance-invoices --mode=failed
```
available 模式可加 `--expense-type`、`--page`、`--page-size`、`--limit`。

### 5. 确认待核验发票
场景：上传后核验通过，需确认提交到月度报销。
```
# 先预览待确认发票
webcli call weoa.webank.com.confirm-allowance-invoices --dry-run=true
# 确认全部待确认发票
webcli call weoa.webank.com.confirm-allowance-invoices --yes=true
# 或确认指定任务（重复 flag 传多个 task-id）
webcli call weoa.webank.com.confirm-allowance-invoices --task-ids task1 --task-ids task2 --yes=true
```

### 6. 绑定发票到月度补贴
场景：卡包中已有多余发票，只把本次需要的绑定到某月。
```
webcli call weoa.webank.com.bind --invoice-ids id1 --invoice-ids id2 --month=2024-11
```
（不传 allowance-id 时 month 必填；也可用 `--allowance-id` 直接指定补贴，传入后不再按 month 查询）

### 7. 规划绑定方案（只读）
场景：不确定该绑哪些发票，先让系统规划（不提交）。
```
webcli call weoa.webank.com.plan --month=2024-11
```
可加 `--limit` 限制扫描可用发票的最大数量。

### 8. 提交/重新提交月度补贴账单
场景：绑定完成后提交报销。
```
webcli call weoa.webank.com.submit --month=2024-11 --dry-run=true   # 先预览
webcli call weoa.webank.com.submit --month=2024-11                  # 正式提交
```
（如需“一键匹配/直接提交”，用 plan 规划后按绑定 → 确认 → submit 流程完成）

### 9. 删除卡包中未关联发票
场景：用户要求清理错误/过期的卡包发票。
```
webcli call weoa.webank.com.delete --invoice-ids id1 --dry-run=true  # 先预览
```
仅可删除卡包中未关联的发票。

### 10. 异常恢复
场景：页面状态异常。
```
webcli call weoa.webank.com.navigate-to-home
```
用户明确询问登录状态时：
```
webcli call weoa.webank.com.check-login-status
```

## 注意事项与约束

- 数组参数一律用重复 flag 写法（见“数组参数写法”），禁止内联 JSON。
- 上传/绑定/提交前必须校验发票开具时间在目标月的 3 个月内，超期发票不可用于当月报销。
- 各类别发票金额合计须 ≥ 额度（餐饮680/交通500/通信300），不足时告知用户缺口并询问是否补充或如何处理。
- 所有写操作：有 dry-run 参数时，首次执行或结果未知时先 dry-run 预览；提交后结果未知先查询状态，不要重复提交。
- 多月规划：发票金额超出当月额度时，只绑定当月需要的部分，剩余留在卡包，可向用户说明下月可继续使用。
- 邮箱搜索时如需账号凭据，使用 `<请在使用时向用户确认>`，不要假设或存储。
- 删除操作必须用户明确指定发票，不得自动批量清理。
- 不存在“解绑”工具；如需调整已绑定发票，先向用户确认可行方案再操作。

## 回答方式

- 汇报格式：目标月份、各类别（餐饮/交通/通信）已绑定金额 vs 额度、缺口、发票张数、提交状态。
- 写操作完成后简述执行了什么命令、影响哪些发票。
- 有缺口或核验失败时，列出具体失败原因并给出建议下一步。

## 待补充（不要猜）

- 163邮箱的具体访问方式/工具（本 Skill 工具列表中无163邮箱 Adapter 工具，实际可用时需用户提供）及搜索下载的具体命令。
- 各费用类别在范妮思中的 expense-type 精确取值。
- 发票金额在哪个环节可见（OCR 核验结果字段名）需实际调用后确认。
- 用户是否有固定每月执行时间或自动确认偏好。

## 163 邮箱能力状态

<!-- if: use163On -->
- 已启用：发票可从主人的 163 邮箱按关键字（发票、联通、滴滴等）搜索下载；163 邮箱网站能力已随本 Bot 一并绑定，按其 Skill 说明操作即可。
<!-- else -->
- 未启用：主人不使用 163 邮箱，不要尝试从邮箱搜索或下载发票；发票文件全部由主人直接提供（PDF/图片），其余流程不变。
<!-- endif -->
