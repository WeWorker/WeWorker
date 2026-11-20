/**
 * 模板快速创建流程的 Skill 落盘重试策略。
 *
 * 背景：创建链路是 createSkill → createAgent → 列表刷新，任一环网络瞬断都会把
 * 「其实已创建成功」误报成失败；用户重试时 createSkill 撞 409 又自动加后缀新建，
 * 反复重试会积累 invoice-self-check-helper、-2、-3… 一串孤儿 Skill。
 * 因此重名时先读回已有 Skill 比对正文：一致说明上次已创建成功，直接复用；
 * 不一致才是用户真的要再建一个，才继续加后缀。
 */

/** 剥掉 SKILL.md 的 frontmatter 只留正文：后端落盘时会改写 name 行并补 allowed-tools，比对内容必须忽略它。 */
export function stripSkillFrontmatter(markdown) {
  return String(markdown || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

/**
 * @param {object} input
 * @param {string} input.baseName 模板 Skill 基础名，重名时依次尝试 baseName、baseName-2、…-99。
 * @param {string} input.markdown 待写入的 SKILL.md 内容。
 * @param {(name: string, markdown: string) => Promise<{name: string}>} input.createSkill
 * @param {(name: string) => Promise<{name: string, markdown: string}>} input.fetchSkill
 * @param {number} [input.maxAttempts] 后缀重试上限，默认 99：测试反复建 Bot 或模板内容演进
 *   都会积累同名 Skill，上限只防死循环，应远大于实际存量，保证重名永不阻塞创建。
 * @returns {Promise<{name: string}>} 新建或复用成功的 Skill。
 */
export async function createTemplateSkill({ baseName, markdown, createSkill, fetchSkill, maxAttempts = 99 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = attempt === 1 ? baseName : `${baseName}-${attempt}`
    try {
      return await createSkill(candidate, markdown)
    } catch (error) {
      if (!/已存在/.test(String(error?.message || ''))) throw error
      const existing = await fetchSkill(candidate).catch(() => null)
      if (existing && stripSkillFrontmatter(existing.markdown) === stripSkillFrontmatter(markdown)) return existing
      if (attempt < maxAttempts) continue
      throw error
    }
  }
  throw new Error('Skill 名称冲突，请重试')
}
