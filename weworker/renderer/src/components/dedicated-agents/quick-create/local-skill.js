/**
 * Create a private Skill through the temporary, narrowly scoped Electron IPC.
 * Other Skill creation and editing flows must keep using the Backend API.
 */
export async function createTemplateSkillLocal(templateId, name, markdown) {
  const createLocal = window.electronAPI?.createTemplateSkillLocal
  if (typeof createLocal !== 'function') throw new Error('当前桌面端不支持内置模板 Skill 本地创建')
  const result = await createLocal({ templateId, name, markdown })
  if (!result?.ok) throw new Error(result?.detail || '内置模板 Skill 本地创建失败')
  return { name: result.name, scope: result.scope }
}
