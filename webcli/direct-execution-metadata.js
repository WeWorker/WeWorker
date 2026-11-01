export const API_BACKGROUND_EXECUTION = Object.freeze({
  type: 'api',
  runtime: 'background',
})

export function isApiBackgroundExecution(execution) {
  return execution?.type === 'api' && execution?.runtime === 'background'
}

export function isCatalogApiBackgroundCommand(command = {}) {
  if (command?.status && command.status !== 'registered') return false
  if (command?.execution?.pageWhenAbsent !== undefined) return false
  const executionMode = typeof command?.executionMode === 'string'
    ? command.executionMode.trim().toLowerCase()
    : ''
  if (executionMode === 'page' || executionMode === 'tab') return false
  if (isApiBackgroundExecution(command?.execution)) return true
  if (command?.directCapable === true || command?.preferDirect === true || executionMode === 'direct') return true
  return command?.strategy === 'cookie'
    && command?.browser === true
    && command?.navigateBefore === false
}

export function withCatalogDirectExecution(command = {}) {
  if (!isCatalogApiBackgroundCommand(command)) return { ...command }
  return {
    ...command,
    execution: { ...API_BACKGROUND_EXECUTION },
    directCapable: true,
    executionMode: 'direct',
  }
}

export function buildToolExecutionMap(commands = [], existing = {}) {
  const result = { ...(existing || {}) }
  for (const command of commands) {
    if (!isCatalogApiBackgroundCommand(command)) continue
    const publicName = typeof command?.publicName === 'string' ? command.publicName.trim() : ''
    if (!publicName || result[publicName]) continue
    result[publicName] = { ...API_BACKGROUND_EXECUTION }
  }
  return result
}

export function mergeManifestToolExecution(manifest = {}, commands = []) {
  const toolExecution = buildToolExecutionMap(commands, manifest.tool_execution)
  if (Object.keys(toolExecution).length === 0) return { ...manifest }
  return {
    ...manifest,
    tool_execution: toolExecution,
  }
}
