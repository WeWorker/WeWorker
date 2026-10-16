import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STYLE_ID,
  STYLE_DELETE_CONFIRM_TITLE,
  STYLE_DELETE_LABEL,
  STYLE_EDIT_LABEL,
  STYLE_NAME_ERROR,
  STYLE_NAME_PLACEHOLDER,
  STYLE_PROMPT_PLACEHOLDER,
  STYLE_UNNAMED_LABEL,
  buildStyleDraft,
  customStyleDialogTitle,
  isEditableStyleRole,
  removeStyleDraft,
  resolveSelectedStyleAfterRemove,
  styleDeleteConfirmMessage,
  upsertStyleDraft,
  validateStyleName,
} from '../utils/style-draft.js'

const CUSTOM_ROLES = [
  { id: 'custom-a', label: '简洁日报', prompt: '只输出要点，禁止 emoji' },
  { id: 'custom-b', label: '', prompt: '' },
]

test('只有自定义风格卡片可编辑，内置与扩展风格行为保持不变', () => {
  assert.equal(isEditableStyleRole({ id: 'custom-a', kind: 'custom' }), true)
  // selectableStyles 里内置风格是 default/core，ZCF 扩展风格是 zcf。
  assert.equal(isEditableStyleRole({ id: 'default', kind: 'default', badge: '内置' }), false)
  assert.equal(isEditableStyleRole({ id: 'engineer-professional', kind: 'core', badge: '内置' }), false)
  assert.equal(isEditableStyleRole({ id: 'auto-plan', kind: 'zcf', badge: '内置' }), false)
  assert.equal(isEditableStyleRole({ id: 'zcf-style', kind: 'zcf', badge: 'ZCF' }), false)
  assert.equal(isEditableStyleRole(undefined), false)
  assert.equal(isEditableStyleRole(null), false)
})

test('弹窗草稿从风格条目取值，缺失字段回落空串', () => {
  assert.deepEqual(buildStyleDraft({ label: '简洁日报', prompt: '禁止 emoji' }), {
    label: '简洁日报',
    prompt: '禁止 emoji',
  })
  assert.deepEqual(buildStyleDraft({ id: 'custom-b' }), { label: '', prompt: '' })
  assert.deepEqual(buildStyleDraft(null), { label: '', prompt: '' })
  // 未命名风格走「新增」标题，已有名称走「编辑」标题。
  assert.equal(customStyleDialogTitle(buildStyleDraft({ label: '', prompt: '' })), '新增自定义风格')
  assert.equal(customStyleDialogTitle(buildStyleDraft({ label: '   ', prompt: 'x' })), '新增自定义风格')
  assert.equal(customStyleDialogTitle(buildStyleDraft({ label: '简洁日报' })), '编辑自定义风格')
  assert.equal(customStyleDialogTitle(null), '新增自定义风格')
})

test('名称为空不保存，合法名称回传 trim 结果', () => {
  assert.deepEqual(validateStyleName(''), { ok: false, error: STYLE_NAME_ERROR })
  assert.deepEqual(validateStyleName('   '), { ok: false, error: STYLE_NAME_ERROR })
  assert.deepEqual(validateStyleName(null), { ok: false, error: STYLE_NAME_ERROR })
  assert.deepEqual(validateStyleName(undefined), { ok: false, error: STYLE_NAME_ERROR })
  assert.deepEqual(validateStyleName('  简洁日报  '), { ok: true, label: '简洁日报' })
})

test('保存草稿只写回目标风格，未命中则追加，且不修改入参', () => {
  const snapshot = JSON.parse(JSON.stringify(CUSTOM_ROLES))
  // 已有条目：就地更新，其余条目原样保留。
  const next = upsertStyleDraft(CUSTOM_ROLES, 'custom-b', { label: '周报', prompt: '三段式' })
  assert.deepEqual(next, [
    { id: 'custom-a', label: '简洁日报', prompt: '只输出要点，禁止 emoji' },
    { id: 'custom-b', label: '周报', prompt: '三段式' },
  ])
  // 纯函数：不得就地改写调用方持有的数组/对象。
  assert.deepEqual(CUSTOM_ROLES, snapshot)
  assert.notEqual(next, CUSTOM_ROLES)
  assert.notEqual(next[1], CUSTOM_ROLES[1])
  // 未命中（「新增自定义」保存时才写入）：追加到末尾，取消时不产生任何条目。
  assert.deepEqual(upsertStyleDraft(CUSTOM_ROLES, 'custom-new', { label: '周报', prompt: '三段式' }), [
    { id: 'custom-a', label: '简洁日报', prompt: '只输出要点，禁止 emoji' },
    { id: 'custom-b', label: '', prompt: '' },
    { id: 'custom-new', label: '周报', prompt: '三段式' },
  ])
  assert.deepEqual(CUSTOM_ROLES, snapshot)
  // 无 id 时不产生额外写入。
  assert.deepEqual(upsertStyleDraft(CUSTOM_ROLES, '', { label: 'x', prompt: 'y' }), CUSTOM_ROLES)
  assert.deepEqual(upsertStyleDraft(undefined, 'custom-a', { label: 'x', prompt: 'y' }), [
    { id: 'custom-a', label: 'x', prompt: 'y' },
  ])
  // 草稿字段缺失时按空串写入，保持受控输入可复用。
  assert.deepEqual(upsertStyleDraft(CUSTOM_ROLES, 'custom-a', undefined), [
    { id: 'custom-a', label: '', prompt: '' },
    { id: 'custom-b', label: '', prompt: '' },
  ])
})

test('弹窗文案沿用现有 placeholder 与入口文案', () => {
  assert.equal(STYLE_NAME_PLACEHOLDER, '风格名称')
  assert.equal(STYLE_PROMPT_PLACEHOLDER, '风格提示词（语气、表达习惯；建议禁止 emoji）')
  assert.equal(STYLE_EDIT_LABEL, '编辑')
})

test('删除自定义风格只移除命中项，未命中不动，且不修改入参', () => {
  const snapshot = JSON.parse(JSON.stringify(CUSTOM_ROLES))
  const next = removeStyleDraft(CUSTOM_ROLES, 'custom-a')
  assert.deepEqual(next, [{ id: 'custom-b', label: '', prompt: '' }])
  // 纯函数：不得就地改写调用方持有的数组/对象。
  assert.deepEqual(CUSTOM_ROLES, snapshot)
  assert.notEqual(next, CUSTOM_ROLES)
  // 未命中：内容不变（且直接复用入参，避免产生无意义的脏标记）。
  assert.deepEqual(removeStyleDraft(CUSTOM_ROLES, 'custom-missing'), CUSTOM_ROLES)
  assert.equal(removeStyleDraft(CUSTOM_ROLES, 'custom-missing'), CUSTOM_ROLES)
  assert.deepEqual(CUSTOM_ROLES, snapshot)
  // 无 id / 非法入参不产生删除。
  assert.equal(removeStyleDraft(CUSTOM_ROLES, ''), CUSTOM_ROLES)
  assert.deepEqual(removeStyleDraft(undefined, 'custom-a'), [])
  assert.deepEqual(removeStyleDraft(CUSTOM_ROLES, 'custom-b'), [CUSTOM_ROLES[0]])
  assert.deepEqual(CUSTOM_ROLES, snapshot)
})

test('删除当前选中风格后回落到内置默认风格，其它情况保持选中项', () => {
  assert.equal(resolveSelectedStyleAfterRemove('custom-a', 'custom-a'), DEFAULT_STYLE_ID)
  assert.equal(resolveSelectedStyleAfterRemove('custom-a', 'custom-a'), 'default')
  // 删掉的不是当前选中项：选中项不变。
  assert.equal(resolveSelectedStyleAfterRemove('custom-a', 'custom-b'), 'custom-a')
  assert.equal(resolveSelectedStyleAfterRemove('default', 'custom-a'), 'default')
  // 没有删除目标时不做回落。
  assert.equal(resolveSelectedStyleAfterRemove('custom-a', ''), 'custom-a')
  assert.equal(resolveSelectedStyleAfterRemove('custom-a', undefined), 'custom-a')
})

test('删除二次确认文案带风格名，未命名风格有占位名', () => {
  assert.equal(styleDeleteConfirmMessage('简洁日报'), '确定删除自定义风格“简洁日报”吗？删除后点击「保存配置」才会生效。')
  // 名称两侧空白先 trim，纯空名走占位名。
  assert.equal(styleDeleteConfirmMessage('  简洁日报  '), styleDeleteConfirmMessage('简洁日报'))
  assert.equal(styleDeleteConfirmMessage(''), `确定删除自定义风格“${STYLE_UNNAMED_LABEL}”吗？删除后点击「保存配置」才会生效。`)
  assert.equal(styleDeleteConfirmMessage(null), `确定删除自定义风格“${STYLE_UNNAMED_LABEL}”吗？删除后点击「保存配置」才会生效。`)
  assert.equal(STYLE_DELETE_LABEL, '删除')
  assert.equal(STYLE_DELETE_CONFIRM_TITLE, '删除自定义风格')
})
