// Decide from original arguments before starting either execution path.
// Invalid explicitly supplied values select background and fail validation;
// they must never cause a page write as a fallback.
export function usesBackgroundExecution(command, args) {
  if (command?.execution?.type !== 'api' || command.execution.runtime !== 'background') return false;
  const field = command.execution.pageWhenAbsent;
  return field === undefined || (args && typeof args === 'object' && !Array.isArray(args) && Object.hasOwn(args, field));
}
