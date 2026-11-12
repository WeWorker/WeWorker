import { parsePromptTemplate, buildPromptFromTemplate } from './prompt-template.js'
import { resolvePromptVar } from './prompt-var-display.js'

/** A card hint is advisory; only a real prompt template can produce one. */
export function scenarioHintForCard(site, scenario, text, template, values = {}) {
  if (!site?.id || !scenario?.id || !template ||
      !scenario.prompts?.some(prompt => prompt?.text === template)) return null
  const slots = {}
  for (const segment of parsePromptTemplate(template)) {
    if (segment.type !== 'var') continue
    const value = Object.prototype.hasOwnProperty.call(values, String(segment.varIndex))
      ? values[String(segment.varIndex)]
      : resolvePromptVar(segment.value, site.promptVarDisplay || {}).resolve
    if (typeof value !== 'string') return null
    if (Object.prototype.hasOwnProperty.call(slots, segment.value) && slots[segment.value] !== value) return null
    slots[segment.value] = value
  }
  if (buildPromptFromTemplate(template, values, site.promptVarDisplay || {}).trim() !== text?.trim()) return null
  // A displayed card may normalize whitespace for filling; that text cannot reconstruct the server template.
  if (template.replace(/\$\{([^}]+)\}/g, (_match, name) => slots[name]).trim() !== text?.trim()) return null
  return { adapterId: site.id, scenarioId: scenario.id, slots }
}

/** Prevent stale hints after draft edits, queue edits, text transformations or attachments. */
export function scenarioForSend(hint, actualText, files = [], modelText = actualText) {
  if (!hint || !actualText || actualText !== hint.text || modelText !== actualText || files.length) return undefined
  return hint.scenario
}
