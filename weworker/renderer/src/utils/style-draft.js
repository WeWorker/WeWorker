// 「设置 - 配置」自定义风格编辑弹窗的纯逻辑：卡片可编辑判定、弹窗草稿构造、标题、名称校验、
// 草稿写回与删除（含删除后的选中项回落）。
// 这里只放纯函数（不引用 React / zustand / DOM），便于在裸 node --test 环境下直接单测。
//
// 数据契约（沿用现有实现，未改动）：
//   zcfCustomRoles: [{ id, label, prompt }]
//   落地持久化仍由 SettingsModal.handleSaveRoles 统一 trim，并过滤掉 label/prompt 为空的自定义风格。

/** 风格名称输入框 placeholder（沿用原有文案）。 */
export const STYLE_NAME_PLACEHOLDER = '风格名称'

/** 风格提示词输入框 placeholder（沿用原有文案）。 */
export const STYLE_PROMPT_PLACEHOLDER = '风格提示词（语气、表达习惯；建议禁止 emoji）'

/** 名称为空时的提示（沿用现有「名称为空不保存」的行为）。 */
export const STYLE_NAME_ERROR = '请填写风格名称'

/** 卡片上编辑入口的文案（图标 + 文字，不用裸图标）。 */
export const STYLE_EDIT_LABEL = '编辑'

/** 弹窗底部的删除入口文案。 */
export const STYLE_DELETE_LABEL = '删除'

/** 删除二次确认弹窗的标题（复用全局 showConfirm）。 */
export const STYLE_DELETE_CONFIRM_TITLE = '删除自定义风格'

/** 未命名自定义风格在删除确认文案中的占位名。 */
export const STYLE_UNNAMED_LABEL = '未命名风格'

/** 删除当前选中风格时回落到的内置默认风格 id（与既有 handleSaveRoles 的回落目标一致）。 */
export const DEFAULT_STYLE_ID = 'default'

/**
 * 卡片是否提供编辑入口：只有自定义风格可编辑。
 * 内置风格（默认 / 专业严谨简单明确 / 内置工作流）与 ZCF 扩展风格都不提供编辑入口，行为保持不变。
 */
export function isEditableStyleRole(role) {
  return role?.kind === 'custom'
}

/** 打开弹窗时的初始草稿：缺失字段回落空串，避免 undefined 进入受控输入。 */
export function buildStyleDraft(role) {
  return {
    label: String(role?.label ?? ''),
    prompt: String(role?.prompt ?? ''),
  }
}

/** 弹窗标题：还没有名称时按「新增」处理。 */
export function customStyleDialogTitle(draft) {
  return String(draft?.label ?? '').trim() ? '编辑自定义风格' : '新增自定义风格'
}

/** 名称校验：去空白后为空即不保存（沿用现有行为），合法时回传 trim 后的名称。 */
export function validateStyleName(label) {
  const text = String(label ?? '').trim()
  if (!text) return { ok: false, error: STYLE_NAME_ERROR }
  return { ok: true, label: text }
}

/**
 * 把弹窗草稿写回自定义风格列表：命中 id 就地更新，未命中则追加（「新增自定义」只在保存时才真正写入，
 * 因此取消不会留下空条目）。不修改入参；roleId 缺省时返回等价于入参的新数组。
 */
export function upsertStyleDraft(roles, roleId, draft) {
  const list = Array.isArray(roles) ? roles : []
  const label = String(draft?.label ?? '')
  const prompt = String(draft?.prompt ?? '')
  if (!roleId) return list
  if (!list.some((role) => role?.id === roleId)) return [...list, { id: roleId, label, prompt }]
  return list.map((role) => (role?.id === roleId ? { ...role, label, prompt } : role))
}

/**
 * 从自定义风格列表里移除一条（弹窗「删除」用）。删除仍是本地草稿：只改列表，
 * 由「保存配置」统一落盘（沿用旧常驻编辑区块的行为）。
 * 不修改入参；roleId 缺省或未命中时原样返回入参，避免产生无意义的脏标记。
 */
export function removeStyleDraft(roles, roleId) {
  const list = Array.isArray(roles) ? roles : []
  if (!roleId || !list.some((role) => role?.id === roleId)) return list
  return list.filter((role) => role?.id !== roleId)
}

/**
 * 删除后当前选中风格的回落：只有删掉的正是当前选中项时才回落到内置默认风格（default），
 * 与旧常驻编辑区块 removeCustomRole 及 handleSaveRoles 里「选中项不可用时回落 default」的处理保持一致。
 * 其它情况保持原选中项不变。
 */
export function resolveSelectedStyleAfterRemove(selectedStyleId, removedRoleId) {
  if (!removedRoleId || selectedStyleId !== removedRoleId) return selectedStyleId
  return DEFAULT_STYLE_ID
}

/** 删除二次确认文案：带上风格名，并说明删除只是本地草稿、需点「保存配置」才落盘。 */
export function styleDeleteConfirmMessage(label) {
  const name = String(label ?? '').trim() || STYLE_UNNAMED_LABEL
  return `确定删除自定义风格“${name}”吗？删除后点击「保存配置」才会生效。`
}
