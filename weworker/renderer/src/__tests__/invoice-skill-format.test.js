import test from 'node:test'
import assert from 'node:assert/strict'
import { findTemplate, renderTemplateSkill } from '../components/dedicated-agents/quick-create/templates.js'

const markdown = renderTemplateSkill(findTemplate('invoice-self-check-helper'), {})
const lines = markdown.split('\n')

// 含 Tab 的行即表头行与数据行示例。
const tabLines = lines.filter((line) => line.includes('\t'))

test('example row has exactly as many columns as the header (31) and fills unknown cells', () => {
  assert.equal(tabLines.length, 2)
  const [header, example] = tabLines
  const headerColumns = header.split('\t')
  assert.equal(headerColumns.length, 31)
  // 第 11 列（K）是单价、第 12 列（L）是金额；数组下标各减一。
  assert.equal(headerColumns[10], '单价')
  assert.equal(headerColumns[11], '金额')
  const exampleColumns = example.split('\t')
  assert.equal(exampleColumns.length, headerColumns.length, '示例行必须与表头同列数，否则模型照抄会整体错位')
  assert.equal(exampleColumns[10], '待补充', '取不到值的列（单价/K）填「待补充」，不留空')
  assert.match(exampleColumns[11], /^\d+(\.\d+)?$/, '金额（第 12 列/L）应是数值，曾因少一列左移到 K 列')
  // 示例里每个空位都用「待补充」占位，不存在相邻 Tab（空列）。
  assert.ok(exampleColumns.every((column) => column !== ''), '示例行不应有空列')
})

test('example row demonstrates enum columns and the fixed purchaser code', () => {
  const exampleColumns = tabLines[1].split('\t')
  // 购买方为微众银行时识别号固定；类型/货物两列填同一枚举；未核验的风险等级填待补充。
  assert.equal(exampleColumns[3], '9144030031977063XH')
  assert.equal(exampleColumns[4], '深圳前海微众银行股份有限公司')
  assert.equal(exampleColumns[5], exampleColumns[6], '货物或应税劳务名称与类型保持一致')
  assert.match(exampleColumns[5], /^.{2}类$/, '类型列是枚举值（如 餐饮类）')
  assert.equal(exampleColumns[20], '待补充', '未做云核验的行发票风险等级填待补充')
  assert.equal(exampleColumns[22], '开票机构异常经营:包括非持续经营、存在行政处罚、税务问题、无商标注册信息、吊销及已注销等')
})

test('demo block shows header → blank → data row → blank layout', () => {
  const headerIndex = lines.findIndex((line) => line.includes('\t'))
  const exampleIndex = lines.findIndex((line) => line.includes('25462000000003977123'))
  assert.ok(headerIndex >= 0 && exampleIndex > headerIndex)
  assert.equal(lines[headerIndex + 1], '', '表头行之后必须紧跟空行')
  assert.equal(exampleIndex, headerIndex + 2, '数据行紧跟表头后的空行')
  assert.equal(lines[exampleIndex + 1], '', '数据行之后必须紧跟空行（没有数据行是代码块最后一行）')
  assert.match(markdown, /表头行之后、以及每行数据之后都紧跟一个空行（包括最后一行数据）/)
  assert.match(markdown, /取不到值的列一律填「待补充」/, '空列规则改为待补充占位')
})

test('paste hint says right-click copy as plain text, mentions 待补充 and keeps the column-split remedy', () => {
  const hint = lines.find((line) => line.includes('右击后选择「复制纯文本」'))
  assert.ok(hint, '提示文案应引导右击复制纯文本')
  assert.match(hint, /纯文本/)
  assert.match(hint, /不要用 Ctrl\+C/, '明确劝阻 Ctrl+C（富文本会让列挤到一起）')
  assert.match(hint, /粘贴到公司表格 https:\/\//)
  assert.match(hint, /「待补充」表示该列暂未取到值/, '提醒用户关注待补充列')
  assert.match(hint, /粘贴后若某列被挤到一起/, '分列补救文案需保留')
  assert.match(hint, /只勾选「Tab 键」/)
})

test('abnormal-reason column is a closed enum and risk level depends on cloud verification', () => {
  // 枚举值逐字出现在文案里，映射规则明确。
  for (const value of [
    '虚假发票:不存在的商家出具的票据，非正规机器打印的票据',
    '虚开发票:让商家或注册空壳公司对不存在或与其经营资质不一致的业务开具的票据等',
    '账实不符:发票与消费小票、支付记录等凭证的商家、时间不符;报销事由与票据类型不符等',
    '非正常来源发票:非真实发生而违规购买的票据等',
    '开票机构异常经营:包括非持续经营、存在行政处罚、税务问题、无商标注册信息、吊销及已注销等',
    '将已经报销的发票作废/红冲，未上报',
  ]) {
    assert.ok(markdown.includes(value), `枚举值缺失：${value}`)
  }
  assert.match(markdown, /注销\/吊销等）→ 填「开票机构异常经营/, '销售方异常映射到开票机构异常经营')
  assert.match(markdown, /核验确认作废或红冲 → 填「将已经报销的发票作废\/红冲，未上报」/)
  // 发票风险等级：未核验填待补充。
  assert.match(markdown, /没有执行核验（未配置凭证、非 20 位传统发票被跳过、或核验失败记入待处理）的一律填「待补充」/)
  // 购方识别号固定值 + 类型枚举。
  assert.match(markdown, /深圳前海微众银行股份有限公司」时固定填 `9144030031977063XH`/)
  assert.match(markdown, /类型：费控接口暂无对应字段，按销售方名称等信息自行判断/)
  assert.match(markdown, /含 电信\/移动\/联通\/通信\/广电 等运营商特征 → 通讯类/)
  assert.match(markdown, /判断顺序先餐饮再交通/)
  assert.match(markdown, /货物或应税劳务名称：与「类型」列保持一致/)
})

test('涉及年份/月份 come from ledger description, never applyDate', () => {
  assert.match(markdown, /从台账 `description`（形如「2025年3月员工补贴」）解析补贴所属期/)
  assert.match(markdown, /不要退回用 `applyDate`/)
  // 过滤模式必须保留 description 字段行。
  assert.match(markdown, /"applyDate"\|"amount"\|"description"\|invoiceIds/)
})

test('internal library packs creditNo/statusDate into registrationStatus and tolerates legacy status-only rows', () => {
  // 打包格式：状态|统一社会信用代码|核准日期|查询日期，存进 registrationStatus 一个字段。
  assert.match(markdown, /状态\|统一社会信用代码\|核准日期\|查询日期/)
  assert.match(markdown, /取不到的段留空但不能省略竖线/)
  assert.match(markdown, /注销\|92420111MA4E85AD4B\|2025-08-01\|2026-11-20/, '领域知识里有打包示例')
  // upsert 配方使用打包值。
  assert.match(markdown, /"registrationStatus":"<登记状态>\|<统一社会信用代码>\|<核准日期YYYY-MM-DD>\|<查询日期YYYY-MM-DD>"/)
  // 存量兼容：不含竖线的整串就是状态。
  assert.match(markdown, /不含 `\|` 的整串就是状态/)
  assert.match(markdown, /判断注册状态是否异常用第一段/)
  // 企查查响应两步解析（SSE data: 行 → result.content[0].text 再解析）。
  assert.match(markdown, /result\.content\[0\]\.text/)
  // 销方识别号优先级：内部库打包串第二段/企查查 > 步骤 8 补查 > 待补充。
  assert.match(markdown, /优先取内部库打包串第二段或企查查的 `统一社会信用代码`/)
  // 企查查状态展示带日期；存量只有状态的数据不报错。
  assert.match(markdown, /打包串第三段有日期的写「内部库显示YYYY-MM-DD状态」/)
  assert.match(markdown, /「企查查显示核准日期登记状态」/)
  assert.match(markdown, /不要为补识别号再外呼企查查/)
})
