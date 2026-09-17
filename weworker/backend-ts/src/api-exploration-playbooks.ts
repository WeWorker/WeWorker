/**
 * Compatibility surface for callers that still use the pre-Skill Playbook API.
 * New exploration code must import api-exploration-skills.ts directly.
 */
import {
  API_EXPLORATION_SKILL_BUNDLE_VERSION,
  API_EXPLORATION_SKILL_IDS,
  getApiExplorationSkill,
  type ApiExplorationSkillId,
} from './api-exploration-skills.js'

export const API_EXPLORATION_PLAYBOOK_VERSION = API_EXPLORATION_SKILL_BUNDLE_VERSION
export const API_EXPLORATION_PLAYBOOK_NAMES = API_EXPLORATION_SKILL_IDS
export type ApiExplorationPlaybookName = ApiExplorationSkillId

export function getApiExplorationPlaybook(name: ApiExplorationPlaybookName): {
  name: ApiExplorationPlaybookName
  version: string
  content: string
} {
  const skill = getApiExplorationSkill(name)
  return { name, version: skill.version, content: skill.content }
}
