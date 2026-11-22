// BotHub 模板入口：从仓库根 bothub/ 加载蓝图包（blueprint.json + skill.md + intro.md），
// 渲染与校验逻辑统一在 blueprint-engine.js（纯函数，node --test 直接可测）。
// 新增/修改内置 Bot：见 bothub/README.md（一个 Bot 一个文件夹，无需改代码）。
import {
  buildDailyCron,
  buildMonitoringCron,
  buildTemplateDescription,
  buildTemplateExamples,
  buildTemplateSiteIds,
  buildTemplateTasks,
  compileSkillMarkdown,
  describeCron,
  findTemplateIn,
  isQuestionEmpty,
  loadBlueprints,
  normalizeAliyunCredential,
  normalizeQccKey,
  normalizeTencentCredential,
  parseMembers,
  questionAnswerText as engineQuestionAnswerText,
  renderTemplateSkill,
  templateQuestions,
  validateTemplateAnswers,
  validateTemplateQuestion,
  visibleTemplateQuestions,
} from './blueprint-engine.js'

export {
  buildDailyCron,
  buildMonitoringCron,
  buildTemplateDescription,
  buildTemplateExamples,
  buildTemplateSiteIds,
  buildTemplateTasks,
  compileSkillMarkdown,
  describeCron,
  isQuestionEmpty,
  normalizeAliyunCredential,
  normalizeQccKey,
  normalizeTencentCredential,
  parseMembers,
  renderTemplateSkill,
  templateQuestions,
  validateTemplateAnswers,
  validateTemplateQuestion,
  visibleTemplateQuestions,
}

/**
 * 把一个蓝图包的三个文件组装成蓝图对象：skill.md 编译为行数组、intro.md 作为介绍页。
 * 文件内容按「目录名 → 内容」映射传入（Vite 走 import.meta.glob，node 测试走 fs）。
 */
export function assembleBlueprintPackage({ blueprint, skill, intro }) {
  if (!blueprint) throw new Error('缺少 blueprint.json')
  if (typeof skill !== 'string' || !skill.trim()) throw new Error('缺少 skill.md（技能正文文件是必需的）')
  return {
    ...blueprint,
    skill: compileSkillMarkdown(skill),
    ...(typeof intro === 'string' && intro.trim() ? { introMarkdown: intro } : {}),
  }
}

// Vite 在编译期把 import.meta.glob(...) 调用展开为静态 import（构建产物即包含蓝图）；
// node 环境该 API 不存在，调用抛错被捕获后得到空清单（测试直接从
// blueprint-engine.js + bothub/ 磁盘加载，见 __tests__/quick-create-templates.test.js）。
function globBothub() {
  try {
    // 注意：import.meta.glob 的模式必须是字符串字面量（Vite 编译期静态分析）。
    const blueprints = import.meta.glob('../../../../../../bothub/*/blueprint.json', { eager: true, import: 'default' })
    const skills = import.meta.glob('../../../../../../bothub/*/skill.md', { eager: true, query: '?raw', import: 'default' })
    const intros = import.meta.glob('../../../../../../bothub/*/intro.md', { eager: true, query: '?raw', import: 'default' })
    const index = import.meta.glob('../../../../../../bothub/index.json', { eager: true, import: 'default' })
    return { blueprints, skills, intros, index }
  } catch {
    return null
  }
}

function dirOf(globKey) {
  // '…/bothub/<bot-id>/blueprint.json' → '<bot-id>'
  const match = /bothub\/([^/]+)\/[^/]+$/.exec(String(globKey))
  return match ? match[1] : ''
}

const globbed = globBothub()
const rawBlueprints = (() => {
  if (!globbed) return []
  const byDir = new Map()
  for (const [key, value] of Object.entries(globbed.blueprints)) byDir.set(dirOf(key), { blueprint: value })
  for (const [key, value] of Object.entries(globbed.skills)) {
    const entry = byDir.get(dirOf(key))
    if (entry) entry.skill = value
  }
  for (const [key, value] of Object.entries(globbed.intros)) {
    const entry = byDir.get(dirOf(key))
    if (entry) entry.intro = value
  }
  // 展示顺序以 index.json 的 order 为准（glob 返回按路径字母序）。
  const order = Object.values(globbed.index)[0]?.order
  const dirs = Array.isArray(order) ? order : [...byDir.keys()].sort()
  const assembled = []
  const errors = []
  for (const dir of dirs) {
    try {
      assembled.push(assembleBlueprintPackage(byDir.get(dir) || {}))
    } catch (error) {
      errors.push(`${dir}: ${error.message}`)
    }
  }
  if (errors.length) console.warn('[bothub] 蓝图包加载失败：', errors.join('；'))
  return assembled
})()

const { templates: loadedTemplates, errors: blueprintErrors } = loadBlueprints(rawBlueprints)
if (blueprintErrors.length) console.warn('[bothub] 蓝图加载失败：', blueprintErrors.join('；'))

/** 内置模板清单（展示顺序即 bothub/index.json 的 order）。 */
export const BUILT_IN_TEMPLATES = loadedTemplates

export function findTemplate(templateId) {
  return findTemplateIn(BUILT_IN_TEMPLATES, templateId)
}

/** 已回答问题的气泡文案（按问题 id 在内置清单里定位所属模板；id 冲突时取首个）。 */
export function questionAnswerText(questionId, answers) {
  for (const template of BUILT_IN_TEMPLATES) {
    const question = template.questions.find((entry) => entry.id === questionId && Array.isArray(entry.summary))
    if (question) return engineQuestionAnswerText(template, questionId, answers)
  }
  return ''
}
