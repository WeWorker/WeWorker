// Preserve the project's existing write contract: the original Bridge caller
// supplies __confirmed when the selected command requires it. This is not a
// human confirmation token; an Adapter helper cannot alter the captured value.
export async function authorizeHostCliWrite({ requiresConfirmation, originalConfirmed }) {
  return requiresConfirmation ? originalConfirmed === true : true;
}
